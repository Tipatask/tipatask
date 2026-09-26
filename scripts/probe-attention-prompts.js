#!/usr/bin/env node
'use strict';

// Exercise real CLI output through the terminal's ANSI, row-reflow, prompt-pattern,
// and bell detectors. Re-run after CLI upgrades.
// --record captures PTY chunks; --replay checks them offline. --expect-none fails on
// false positives. --inject-gate replays dialog deferral against a virtual clock
// (--chunk-ms, default 500) and fails if the gate never releases.
// --cwd/--prompt target a scratch project or another dialog. For first-run capture,
// use --no-inject --interactive --config-dir with --run-ms; automatic injection would
// answer onboarding prompts and corrupt the fixture.
// Examples:
//   npm run probe:attention -- claude --record /tmp/normal.jsonl
//   npm run probe:attention -- --replay /tmp/normal.jsonl --expect-none
//   npm run probe:attention -- --replay fixtures/attention/claude-folder-trust-manual-dismiss.jsonl --inject-gate claude
//   npm run probe:attention -- claude --no-inject --interactive --config-dir /tmp/tt-claude-firstrun --cwd /tmp/tt-firstrun-project --run-ms 600000 --record fixtures/attention/claude-first-run-onboarding.jsonl

const fs = require('node:fs');
const pty = require('node-pty');
const config = require('../src/server/config');
const { getTaskAgent } = require('../src/server/task-agent');
const {
  stripAnsi, stripOscChunk, carveAttentionLines, getAttentionPromptMatch, feedAttentionChunk,
  ATTENTION_WINDOW_BYTES, MAX_MCP_TRUST_RETRIES, MAX_FIRST_RUN_RETRIES, isInjectGateKind, lineDialogLeftScreen, dialogGateCleared,
  shouldHoldAttention, ATTENTION_HOLD_MAX_MS, // (C1386)
} = require('../src/server/terminal-session');
const { reflowChunk, carveReflowLines } = require('../src/server/screen-reflow');

const RUN_MS = 20000; // ceiling per agent — enough for a real approval dialog to render
const POLL_MS = 100;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// A prompt engineered to force an interactive approval dialog: a shell command the agent
// must ask permission to run (both Claude's permission-mode plan and Codex's approval policy
// gate on this), and nothing else — no code changes, so nothing else happens after approval.
const PROBE_PROMPT = 'Run the shell command `echo tipatask-attention-probe` and report its exact output. Do not read or edit any files.';

function parseArgs(argv) {
  const out = {
    agents: [], record: null, replay: null, expectNone: false, prompt: null, cwd: null,
    injectGate: false, chunkMs: 500, // (C1120)
    noInject: false, runMs: null, configDir: null, interactive: false, // (C1219)
    postInject: false, // (C1386)
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--record') out.record = argv[++i];
    else if (a === '--replay') out.replay = argv[++i];
    else if (a === '--expect-none') out.expectNone = true;
    else if (a === '--prompt') out.prompt = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--inject-gate') out.injectGate = true;
    else if (a === '--chunk-ms') out.chunkMs = Number(argv[++i]);
    else if (a === '--post-inject') out.postInject = true;
    else if (a === '--no-inject') out.noInject = true;
    else if (a === '--run-ms') out.runMs = Number(argv[++i]);
    else if (a === '--config-dir') out.configDir = argv[++i];
    else if (a === '--interactive') out.interactive = true;
    else if (!a.startsWith('-')) out.agents.push(a);
  }
  return out;
}

// Feeds one raw PTY chunk through the SAME pipeline terminal-session.js's onData handler uses
// in production (C1060: stripOscChunk() ahead of stripAnsi()/line-carving; C1066: reflowChunk()
// run in parallel for a second, row-aware line set), so a recorded sample exercises production
// behavior exactly. `session` carries `_attentionLineCarry`/`_attentionOscOpen` (legacy) and
// `_attentionRow`/`_attentionCol`/`_attentionRowCarry` (C1066 reflow) across calls, same fields
// spawnTerminal() maintains.
function scanChunk(session, agent, raw, matches, start) {
  const oscFree = stripOscChunk(session, raw);

  const clean = stripAnsi(oscFree);
  const legacyLines = carveAttentionLines(session, clean);
  for (const line of legacyLines) {
    const hit = agent.isPromptLine(line);
    if (hit) matches.push({ elapsedMs: Date.now() - start, kind: hit.kind, promptText: hit.promptText, rawLine: line.slice(0, 200), source: 'legacy' });
  }

  // (C1066) Row-aware stream — restores real screen-row boundaries for CLIs (claude 2.1.22x)
  // that paint via cursor-addressed escapes (`ESC[r;cH`) instead of '\n'-separated rows, which
  // the legacy stripAnsi() stream above glues into one unmatchable mega-line. Reported under a
  // distinct `source` so a probe run makes it obvious whether a match only became reachable
  // through reflow.
  const rowChunk = reflowChunk(session, oscFree);
  const rowLines = carveReflowLines(session, rowChunk);
  for (const line of rowLines) {
    const hit = agent.isPromptLine(line);
    if (hit) matches.push({ elapsedMs: Date.now() - start, kind: hit.kind, promptText: hit.promptText, rawLine: line.slice(0, 200), source: 'reflow' });
  }

  // (C1060) A raw BEL surviving the OSC strip is exactly what feedAttentionChunk() step 2 reads
  // as "needs input" (the opt-in terminal-bell channel) — this is the root-cause signal the
  // whole task exists to fix. Pre-C1060, an OSC title/progress sequence's BEL terminator leaked
  // through unstripped on every repaint; if this ever fires against a benign sample again,
  // stripOscChunk() has regressed.
  if (/\x07/.test(oscFree)) {
    matches.push({ elapsedMs: Date.now() - start, kind: 'bell', promptText: '', rawLine: '(raw BEL survived OSC strip)', source: 'bell' });
  }
}

function newProbeSession() {
  return { _attentionLineCarry: '', _attentionOscOpen: false, _attentionRow: 1, _attentionCol: 1, _attentionRowCarry: '' };
}

async function probeAgent(agentId, opts = {}) {
  const agent = getTaskAgent(agentId);
  const status = await agent.cachedDetect(config, true);
  if (!status.available) {
    return { agentId, skipped: true, reason: status.reason || 'not available' };
  }

  const spec = await agent.getSpawnSpec(
    config,
    opts.prompt || PROBE_PROMPT,
    null,
    { taskTags: [], cachedTags: [], taskCommentsBlock: '', projectPath: config.PROJECT_ROOT },
  );

  // (C1066) --cwd: spawn the live CLI against a throwaway scratch directory instead of this
  // repo's PROJECT_ROOT — this script spawns a REAL agent with production argv/env, and a
  // --prompt steering it at a fresh dialog shape should never run loose against a repo with
  // uncommitted work. A never-before-seen directory triggers Claude's own workspace trust
  // dialog before it even looks at the prompt; the operator is expected to pre-approve it the
  // same way any new project is trusted (`hasTrustDialogAccepted` in `~/.claude.json`, or by
  // answering the dialog once interactively) before recording — this script deliberately does
  // NOT pass any permission-bypass flag, since that would be a standing capability left in a
  // committed script rather than a one-off operator action.
  if (opts.cwd) {
    fs.mkdirSync(opts.cwd, { recursive: true });
    spec.cwd = opts.cwd;
    console.log(`  spawning in throwaway cwd: ${opts.cwd}`);
  }

  // (C1219) --config-dir: fixture-capture operator tool ONLY — points a throwaway spawn at a
  // fresh CLAUDE_CONFIG_DIR so its onboarding/theme/security/terminal-setup/workspace-trust
  // state is genuinely unset, the same way a machine that has never run `claude` before would
  // be. Deliberately not wired into the production spawn path (terminal-session.js/
  // claude-agent.js) — see ai/architecture/tt-claude-session-terminal.md's rejected-alternative
  // note for why: ClaudeAgent.detect() never sets it, so spawn/detect would silently diverge,
  // and there's no single Claude file safe to pre-seed the way Codex's auth.json is linked.
  // Caveat: OAuth credentials live in the macOS Keychain, not under CLAUDE_CONFIG_DIR, so a
  // fresh config dir commonly still skips straight past the login-method screen.
  if (opts.configDir) {
    fs.mkdirSync(opts.configDir, { recursive: true });
    spec.env = { ...spec.env, CLAUDE_CONFIG_DIR: opts.configDir };
    console.log(`  spawning with fresh CLAUDE_CONFIG_DIR: ${opts.configDir}`);
  }

  const session = newProbeSession();
  const matches = [];
  const start = Date.now();
  const recordedChunks = opts.record ? [] : null;

  const ptyProc = pty.spawn(spec.command, spec.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: spec.cwd,
    env: spec.env,
  });

  ptyProc.onData((data) => {
    if (recordedChunks) recordedChunks.push(data);
    scanChunk(session, agent, data, matches, start);
    if (opts.interactive) process.stdout.write(data);
  });

  // (C1219) --interactive: pipes this process's own stdin into the spawned PTY (and its output
  // to our stdout above) so a human operator can actually see and answer a first-run onboarding
  // chain live, instead of the script's own automatic paste+Enter below. Raw mode is best-effort
  // — a non-TTY stdin (a pipe/fifo an operator or another script feeds) can't go raw, but bytes
  // still forward either way.
  let restoreStdin = null;
  if (opts.interactive) {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
      restoreStdin = () => { try { process.stdin.setRawMode(false); } catch { /* already restored */ } };
    }
    const onStdin = (chunk) => { try { ptyProc.write(chunk); } catch { /* pty already dead */ } };
    process.stdin.on('data', onStdin);
  }

  // Claude's initial prompt is PTY-injected after boot (spec.initialPrompt); Codex bakes it
  // into argv and starts immediately — see spawnTerminal()/claude-agent.js/codex-agent.js.
  // (C1219) --no-inject skips this entirely — the point of a first-run capture is to observe
  // (and, under --interactive, answer) the onboarding chain itself, not to have the script's own
  // paste+Enter confirm whatever onboarding option happens to be highlighted, which would
  // corrupt the capture the exact way the bug under test does.
  if (spec.initialPrompt && !opts.noInject) {
    await sleep(agent.getInteractiveReadyMs() + 1500);
    ptyProc.write(`\x1b[200~${spec.initialPrompt}\x1b[201~`);
    await sleep(agent.getPasteSilenceMs());
    ptyProc.write('\r');
  }

  const deadline = Date.now() + (opts.runMs || RUN_MS);
  while (Date.now() < deadline) await sleep(POLL_MS);

  if (restoreStdin) restoreStdin();
  try { ptyProc.kill(); } catch { /* already dead */ }

  if (recordedChunks) {
    // One JSON string per PTY onData event, newline-delimited — preserves the exact chunk
    // boundaries a live session saw, so replay() exercises the same cross-chunk carry/OSC-split
    // behavior as the original run instead of collapsing everything into one giant chunk.
    fs.writeFileSync(opts.record, recordedChunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
    console.log(`  recorded ${recordedChunks.length} chunk(s) -> ${opts.record}`);
  }

  return { agentId, matches };
}

// (C1116) agentIds param — defaults to every registered agent (unchanged pre-C1116 behavior)
// so old invocations keep scanning all three. A fixture built to prove one agent's tightened
// pattern doesn't chase an unrelated agent's DELIBERATELY untouched loose wording (e.g. a Pi
// false-positive fixture that legitimately still matches Codex's shared PLAN_READY_SHARED_
// PATTERNS) can now scope --expect-none to just the agent(s) it actually claims are prompt-free.
function replay(filePath, expectNone, agentIds = ['claude', 'codex', 'pi']) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const chunks = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let anyMatch = false;
  for (const agentId of agentIds) {
    const agent = getTaskAgent(agentId);
    const session = newProbeSession();
    const matches = [];
    const start = Date.now();
    for (const chunk of chunks) scanChunk(session, agent, chunk, matches, start);
    if (matches.length > 0) {
      anyMatch = true;
      console.log(`\n=== replay vs ${agentId} — ${matches.length} match(es) ===`);
      for (const m of matches) console.log(`  [${m.source}/${m.kind}] "${m.promptText}"  <- ${JSON.stringify(m.rawLine)}`);
    } else {
      console.log(`\n=== replay vs ${agentId} — no matches ===`);
    }
  }
  if (expectNone && anyMatch) {
    console.error('\n[probe-attention-prompts] --expect-none: matches found against a sample expected to be prompt-free.');
    process.exitCode = 1;
  }
}

// (C1120) Replays a fixture through the SAME production sequence onData()/onInjectSilence()
// drive for the paste-injection gate — stripOscChunk -> stripAnsi -> \x1b[2J/alt-screen tail
// clear -> append+slice(-ATTENTION_WINDOW_BYTES) -> getAttentionPromptMatch (tail-scoped) ->
// reflowChunk + feedAttentionChunk (line-scoped/reflow-aware) -> the C1120 dialog-kind-cleared
// transition check — instead of just printing pattern matches like replay() above. Drives a
// VIRTUAL clock (chunkMs per chunk) through feedAttentionChunk()'s `now` param, since
// ATTENTION_REDRAW_GRACE_MS (400ms) would never be reached by a real-time replay loop that
// finishes in microseconds. Simulates onInjectSilence()'s per-chunk injectRetries counter
// (incremented once per chunk while the tail-scoped gate blocks, reset on a fired transition) so
// the reported elapsed time and retry count are directly comparable to the real
// MAX_MCP_TRUST_RETRIES / INJECT_DIALOG_RETRY_MS budget.
// (C1386) `postInject` simulates a POST-injection session (session._injectDone = true), the only
// window shouldHoldAttention() may engage in — default false matches production's pre-injection
// state, same as every fixture this replay ran against before this task. `--post-inject` is what
// lets an operator replay claude-tool-approval-idle-repaint.jsonl and see the held line-scoped
// state directly, mirroring terminal-session.test.js's replayInjectGate() test helper.
function replayInjectGate(filePath, chunkMs, agentIds = ['claude'], postInject = false) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const chunks = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let anyStuck = false;

  for (const agentId of agentIds) {
    const agent = getTaskAgent(agentId);
    const session = newProbeSession();
    session._attentionState = null;
    session._attentionTail = '';
    session._lastAttentionKind = null;
    session._lastTailDialogKind = null;
    session._injectDone = postInject;

    console.log(`\n=== inject-gate replay vs ${agentId} (chunk-ms=${chunkMs}, injectDone=${postInject}) ===`);
    let now = 0;
    let injectRetries = 0;
    let resetCount = 0;
    let resetAtElapsed = null;
    let resetVia = null;
    let cappedOut = false;
    let sawFirstRunGate = false; // (C1219) which cap the closing summary line should quote

    chunks.forEach((rawChunk, idx) => {
      now += chunkMs;
      const oscFree = stripOscChunk(session, rawChunk);
      const clean = stripAnsi(oscFree);
      if (/\x1b\[2J|\x1b\[\?1049[hl]/.test(rawChunk)) session._attentionTail = '';
      session._attentionTail = ((session._attentionTail || '') + clean).slice(-ATTENTION_WINDOW_BYTES);
      const attentionMatch = getAttentionPromptMatch(session._attentionTail, agentId);
      const tailKind = attentionMatch ? attentionMatch.kind : null;
      const rowChunk = reflowChunk(session, oscFree);
      // (C1386) Evaluated against the PRE-chunk state, same inputs step 4 itself consults — purely
      // for the display note below, not fed back into feedAttentionChunk() (which computes its own).
      const stateBefore = session._attentionState;
      const wouldHold = stateBefore
        && shouldHoldAttention(stateBefore, tailKind, now - stateBefore.at, session._injectDone === true);
      feedAttentionChunk(session, agent, oscFree, clean, now, rowChunk, tailKind);
      const lineKind = session._attentionState ? session._attentionState.kind : null;
      const held = wouldHold && lineKind === stateBefore?.kind && session._attentionState !== null;
      const clearedA = lineDialogLeftScreen(session._lastAttentionKind, lineKind, tailKind);
      const clearedB = dialogGateCleared(session._lastTailDialogKind, tailKind);
      let note = '';
      if (clearedA || clearedB) {
        resetCount++;
        if (resetAtElapsed === null) { resetAtElapsed = now; resetVia = clearedA ? 'line' : 'tail'; }
        session._attentionTail = '';
        injectRetries = 0;
        note = `  <- gate RELEASED (${clearedA ? 'line' : 'tail'})`;
      } else if (isInjectGateKind(tailKind)) {
        injectRetries++;
        if (tailKind === 'firstRun') sawFirstRunGate = true;
        // (C1219) firstRun has its own, much larger cap AND never blind-pastes at it (see
        // MAX_FIRST_RUN_RETRIES's doc comment in terminal-session.js) — the mcpTrust/toolApproval
        // cap instead falls through to a paste. Report each accurately rather than always
        // assuming the mcpTrust cap.
        const cap = tailKind === 'firstRun' ? MAX_FIRST_RUN_RETRIES : MAX_MCP_TRUST_RETRIES;
        if (injectRetries >= cap && !cappedOut) {
          cappedOut = true;
          note = tailKind === 'firstRun'
            ? '  <- MAX_FIRST_RUN_RETRIES reached, gate gives up quietly (never pastes)'
            : '  <- MAX_MCP_TRUST_RETRIES reached, would blind-paste now';
        }
      }
      console.log(`  chunk ${idx} +${now}ms: lineKind=${lineKind || '-'} tailKind=${tailKind || '-'} retries=${injectRetries}${held ? '  [C1386 held]' : ''}${note}`);
      session._lastAttentionKind = lineKind;
      session._lastTailDialogKind = tailKind;
    });

    const capUsed = sawFirstRunGate ? MAX_FIRST_RUN_RETRIES : MAX_MCP_TRUST_RETRIES;
    if (resetCount === 0 || cappedOut) {
      anyStuck = true;
      console.error(`  RESULT: gate never released for ${agentId}${cappedOut ? ' (hit the retry cap)' : ''}.`);
    } else {
      console.log(`  RESULT: gate released at +${resetAtElapsed}ms via ${resetVia}, after ${injectRetries === 0 ? 'the releasing chunk' : `${injectRetries} pending retries`} (cap is ${capUsed}).`);
    }
  }

  if (anyStuck) {
    console.error('\n[probe-attention-prompts] --inject-gate: the paste-injection gate never released within this fixture.');
    process.exitCode = 1;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.replay && opts.injectGate) {
    replayInjectGate(opts.replay, opts.chunkMs, opts.agents.length ? opts.agents : ['claude'], opts.postInject);
    return;
  }

  if (opts.replay) {
    replay(opts.replay, opts.expectNone, opts.agents.length ? opts.agents : ['claude', 'codex', 'pi']);
    return;
  }

  const agentIds = opts.agents.length > 0 ? opts.agents : ['claude', 'codex'];
  if (opts.record && agentIds.length > 1) {
    console.error('[probe-attention-prompts] --record only supports a single agent — pass one agent id.');
    process.exitCode = 1;
    return;
  }

  for (const agentId of agentIds) {
    console.log(`\n=== ${agentId} ===`);
    let report;
    try {
      report = await probeAgent(agentId, opts);
    } catch (err) {
      console.log(`  ERROR: ${(err && err.stack) || err}`);
      continue;
    }
    if (report.skipped) {
      console.log(`  SKIPPED: ${report.reason}`);
      continue;
    }
    if (report.matches.length === 0) {
      console.log('  no attention match observed within the run window — CLI wording may have drifted, or the dialog never rendered');
      continue;
    }
    for (const m of report.matches) {
      console.log(`  +${m.elapsedMs}ms [${m.source}/${m.kind}] "${m.promptText}"  <- ${JSON.stringify(m.rawLine)}`);
    }
  }
}

if (!fs.existsSync(config.PROJECT_ROOT)) {
  console.error(`[probe-attention-prompts] PROJECT_ROOT missing: ${config.PROJECT_ROOT}`);
  process.exitCode = 1;
} else {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
