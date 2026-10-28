#!/usr/bin/env node
'use strict';

// ── Codex kickoff delivery probe (TPT572) ──
// Regression guard for Codex prompt intake. Codex 0.160 stopped consuming a positional prompt and
// booted to an empty composer (TPT571); the kickoff is now pasted by terminal-session.js. This probe
// starts the INSTALLED codex through the real spawnTerminal() — production CodexAgent#getSpawnSpec()
// argv/env, node-pty, the bracketed-paste injector and its submit verification — with a
// `Work on task PROBE-1` kickoff, then checks two independent signals:
//   1. COMPOSER — once the PTY has been silent for 20 s, the empty composer (`› Ask Codex to do
//                 anything` or a rotation sibling from CODEX_COMPOSER_PLACEHOLDERS) must not be the
//                 last thing drawn. When it is, the probe also says whether production's own marker
//                 (CodexAgent#getEmptyComposerRe(), which drives the TPT571 re-paste) sees it.
//   2. ROLLOUT  — a rollout-*.jsonl under the spawn's CODEX_HOME must contain the kickoff line
//                 (final-message.js locateCodexRollout(), the exit-comment reader's own locator).
// Codex is stopped as soon as the rollout shows the kickoff, so a pass costs at most the start of one
// model turn. Re-run after every Codex CLI upgrade; the detected CLI version is printed. The scratch
// project home is new, so Codex first installs its app-server daemon package (a silent `Waiting for
// startup` with the paste queued); when that first start exits before the daemon is ready
// ("app server did not become ready") the task is started once more on the installed home, and the
// verdict comes from that second start. Expect a run to take a minute or more.
//
// Runs in a throwaway scratch project with its own user-data dir, a copy of this project's API
// target + account token and KB (so the pasted kickoff is production-sized), and its own Codex user
// home (a copy of the real config.toml plus a link to the real auth.json) — the real Codex home is
// never written. The MCP handshake and the attachment lookup reach the API the project points at,
// read-only. No server is started and port 4455 is never touched. Hence the explicit --yes.
// POSIX stops Codex and its shared-mode daemon by process group; Windows (TPT9048) by
// `taskkill /T /F` on the PTY leader and on the daemon records' pids.
//
// --file-kickoff exercises Windows' short file handoff (implied on Windows, where production
// takes that path anyway). A pass then also requires the rollout to contain the original task
// text read from that file, and exactly ONE user turn with the kickoff — a re-sent Enter that
// produced a second turn fails the run.
// --approve-handoff-read answers Codex's command-approval dialog for reading the handoff file
// once (`y`), the way a user does on a Windows host whose Codex sandbox is disabled: there every
// command, including `Get-Content` of the prompt file, asks for approval before it runs.
// --trace writes the PTY I/O trace (TIPATASK_PTY_TRACE, src/server/pty-trace.js) into the
// scratch dir and keeps it; --no-bracket / --boot-floor-ms <n> / --manual-enter-after <ms> are
// diagnosis knobs for the Windows input path (see TPT9048).
// --switch-mode verifies live policies and same-rollout context through the production adapter.
// --switch-phase planning,running,approval selects matrix legs for diagnosis. Bypass never has
// an approval prompt; Auto may review the harmless approval command automatically.
// Usage: npm run probe:codex-kickoff -- --yes [--switch-mode] [--keep] [--file-kickoff] [--trace] [--no-bracket]
//        [--boot-floor-ms N] [--manual-enter-after MS]
// Exit codes: 0 = kickoff delivered · 1 = a check failed, or cleanup left a process running ·
//             2 = refused to run (no --yes, no project/account) · 3 = Codex unavailable or never started.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SERVER_ROOT = path.resolve(__dirname, '..');
const TASK_KEY = 'PROBE-1';
const KICKOFF = `Work on task ${TASK_KEY}: Kickoff delivery probe. An automated check of how Codex receives a `
  + 'pasted task prompt, not a real task: do not read files, run commands or call tools. Reply with the single word READY.';
const SILENCE_MS = 20_000;   // this long without PTY output = Codex sits idle (a running turn animates)
const TIMEOUT_MS = process.platform === 'win32' ? 240_000 : 180_000;  // ceiling when neither signal ever settles (Windows: cold MCP starts)
const POLL_MS = 500;
const KILL_GRACE_MS = 1500;
const TAIL_LINES = 40;
// Codex 0.160's exit when its shared app-server daemon never came up in time.
const COLD_START_RE = /app server did not become ready/i;
// Config keys a scratch copy never needs — the account token travels through the scratch account store.
const SECRET_KEY_RE = /(?:_API_KEY|TOKEN|SECRET|PASSWORD)$/;

function parseArgs(argv) {
  const value = (flag) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : null; };
  return {
    yes: argv.includes('--yes'),
    switchMode: argv.includes('--switch-mode'),
    switchPhase: argv.includes('--switch-phase') ? argv[argv.indexOf('--switch-phase') + 1] : null,
    keep: argv.includes('--keep'),
    fileKickoff: argv.includes('--file-kickoff') || process.platform === 'win32',
    trace: argv.includes('--trace'),
    noBracket: argv.includes('--no-bracket'),
    bootFloorMs: value('--boot-floor-ms'),
    manualEnterAfterMs: value('--manual-enter-after'),
    approveHandoffRead: argv.includes('--approve-handoff-read'),
  };
}

function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.tipatask', 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// getStaticBundle() builds the kickoff's static context from the project's own KB, so a copy makes
// the pasted kickoff as large as a real task's in the source project.
function copyKnowledgeBase(sourceRoot, projectRoot) {
  const aiDir = path.join(projectRoot, 'ai');
  fs.mkdirSync(aiDir, { recursive: true });
  const arch = path.join(sourceRoot, 'ai', 'architecture');
  if (fs.existsSync(arch)) {
    fs.cpSync(arch, path.join(aiDir, 'architecture'), {
      recursive: true,
      filter: (src) => {
        try { return fs.statSync(src).isDirectory() || /\.(?:md|json)$/.test(src); } catch { return false; }
      },
    });
  }
  const conventions = path.join(sourceRoot, 'ai', 'CONVENTIONS.md');
  if (fs.existsSync(conventions)) fs.copyFileSync(conventions, path.join(aiDir, 'CONVENTIONS.md'));
}

// buildCodexEnv() seeds a new project's Codex config from the user home and writes the project's
// trust key into it. With CODEX_HOME pointed at this scratch home the real one is never written; the
// real config.toml is copied (dismissed notices and migration prompts stay dismissed, user MCP
// servers stay inherited, as in production) and auth.json is linked the way a project home links it.
function seedCodexUserHome(dir, real) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, 'config.toml');
  if (fs.existsSync(real.globalConfigPath)) fs.copyFileSync(real.globalConfigPath, target);
  else fs.writeFileSync(target, '');
  try { fs.chmodSync(target, 0o600); } catch { /* NTFS has no mode bits */ }
  // Symlink where allowed, a managed copy where not (unprivileged Windows users) — the same
  // rule a project home follows (codex-mcp-config.js ensureCodexAuthLink()).
  if (fs.existsSync(real.globalAuthPath)) {
    require('../src/codex-mcp-config').ensureCodexAuthLink(real.globalAuthPath, path.join(dir, 'auth.json'));
  }
}

// A shared-mode launch starts a detached app-server daemon under the native home; codex-env.js
// reads the same record for its daemon compatibility check.
function readDaemonPid(codexHome) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(codexHome, 'app-server-daemon', 'daemon.pid'), 'utf8'));
    return Number.isInteger(record.pid) && record.pid > 1 ? record.pid : null;
  } catch {
    return null;
  }
}

// Processes whose command line names the (unique, random) scratch path — a backstop for anything
// the pid-based teardown missed. Reported, never signaled.
function scratchProcesses(scratch) {
  try {
    if (process.platform === 'win32') {
      const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }';
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
        .split(/\r?\n/).filter((line) => line.toLowerCase().includes(scratch.toLowerCase())).map((line) => line.trim());
    }
    return execFileSync('/bin/ps', ['-Aww', '-o', 'pid=,command='], { encoding: 'utf8' })
      .split('\n').filter((line) => line.includes(scratch)).map((line) => line.trim());
  } catch {
    return [];
  }
}

// (TPT9048) How many user turns in the rollout carry the kickoff line. Codex records a submitted
// prompt as an `event_msg`/`user_message` row (and mirrors it as a `response_item` user message);
// count the event rows, falling back to the mirrored items for a build that writes only those.
function countKickoffTurns(rollout) {
  let events = 0;
  let items = 0;
  let lines;
  try { lines = fs.readFileSync(rollout, 'utf8').split('\n'); } catch { return 0; }
  const marker = `Work on task ${TASK_KEY}`;
  for (const line of lines) {
    if (!line.includes(marker)) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const payload = row && row.payload ? row.payload : row;
    if (!payload || typeof payload !== 'object') continue;
    if (row.type === 'event_msg' && payload.type === 'user_message') events++;
    else if (row.type === 'response_item' && payload.role === 'user') items++;
  }
  return events || items;
}

// (TPT9048) Both daemon records a shared-mode start can leave under a Codex home.
function daemonPids(codexHome) {
  const pids = [];
  for (const name of ['daemon.pid', 'daemon-updater.pid']) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(codexHome, 'app-server-daemon', name), 'utf8'));
      if (Number.isInteger(record.pid) && record.pid > 1) pids.push(record.pid);
    } catch { /* no such record */ }
  }
  return pids;
}

// spawnTerminal() reports to the session's socket. Only its own `[Task App]` notices are printed —
// the PTY output itself is watched through the session state.
function noticeRecorder(onNotice) {
  return {
    OPEN: 1,
    readyState: 1,
    send(frame) {
      let msg;
      try { msg = JSON.parse(frame); } catch { return; }
      const m = msg && msg.type === 'data'
        && /^\r\n\x1b\[(?:90|33)m\[Task App\] ([\s\S]*?)\x1b\[0m\r\n$/.exec(msg.data || '');
      if (m) onNotice(m[1]);
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sourceRoot = findProjectRoot(process.env.TIPATASK_PROJECT_ROOT || process.cwd());
  if (!sourceRoot) {
    console.error('No .tipatask/config.json found above the current directory.');
    process.exit(2);
  }
  let creds;
  try {
    // migrate:false keeps this read-only: a legacy inline token is never lifted out of the source project.
    creds = require('../src/server/api-credentials').getApiCredentials(sourceRoot, { migrate: false });
  } catch (err) {
    console.error(`The selected project or signed-in account is unavailable: ${err.message}`);
    process.exit(2);
  }
  if (!opts.yes) {
    console.error([
      'This probe starts a real Codex session in a scratch copy of this project:',
      `  Project:  ${sourceRoot}`,
      `  API:      ${creds.baseUrl} (project ${creds.projectId}), read-only — MCP handshake, attachment lookup`,
      '  Spends:   the start of one model turn (Codex is stopped once the kickoff lands)',
      'Re-run with --yes to proceed.',
    ].join('\n'));
    process.exit(2);
  }

  // ── Scratch project: own root, user-data dir and Codex user home ──
  const realEnv = { ...process.env };
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-codex-kickoff-probe-')));
  const projectRoot = scratch;
  const userData = path.join(scratch, '.userdata');
  const codexUserHome = path.join(scratch, '.codex-user');
  fs.mkdirSync(path.join(projectRoot, '.tipatask'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  const sourceCfg = JSON.parse(fs.readFileSync(path.join(sourceRoot, '.tipatask', 'config.json'), 'utf8'));
  for (const key of Object.keys(sourceCfg)) if (SECRET_KEY_RE.test(key)) delete sourceCfg[key];
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify(sourceCfg, null, 2), { mode: 0o600 });
  copyKnowledgeBase(sourceRoot, projectRoot);

  for (const key of Object.keys(process.env)) {
    // Not nested in the calling agent's session; credentials and project wiring come from the scratch dirs.
    if (key === 'CLAUDECODE' || /^CLAUDE_CODE_/.test(key) || /^TIPATASK_/.test(key)
      || /^(API_BASE_URL|API_TOKEN|API_PROJECT_ID)$/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    TIPATASK_PROJECT_ROOT: projectRoot,
    TIPATASK_USER_DATA: userData,
    TIPATASK_SERVER_ROOT: SERVER_ROOT,
    TIPATASK_NO_BANNER: '1',
    CODEX_HOME: codexUserHome,
  });
  // (TPT9048) The PTY I/O trace lands beside the scratch project and survives --keep.
  if (opts.trace) process.env.TIPATASK_PTY_TRACE = path.join(scratch, 'pty-trace');
  else delete process.env.TIPATASK_PTY_TRACE;
  seedCodexUserHome(codexUserHome, require('../src/codex-mcp-config').getCodexPaths(sourceRoot, { env: realEnv }));
  require('../src/server/account-store').writeAccountToken(creds.baseUrl, creds.token, { userDataRoot: userData });

  // Required only now, so config.js resolves against the scratch project.
  const config = require('../src/server/config');
  const { getTaskAgent } = require('../src/server/task-agent');
  const { createSession } = require('../src/server/session-state');
  const { spawnTerminal, unsentPasteVisible, SUBMIT_MARKER_TRAILING_MAX } = require('../src/server/terminal-session');
  const { CODEX_COMPOSER_PLACEHOLDERS } = require('../src/server/task-agent/prompt-detect');
  const { locateCodexRollout } = require('../src/server/task-agent/final-message');
  const { snapshotProcesses, listDescendants, killProcessTree, killWindowsProcessTree } = require('../src/server/process-group');

  const ptyPids = [];
  let codexHome = null;
  let cleanup = null;
  // Idempotent: the normal path and Ctrl+C share one teardown.
  const runCleanup = () => (cleanup = cleanup || (async () => {
    const report = { daemonPid: codexHome ? readDaemonPid(codexHome) : null, survivors: [], leftover: [] };
    const roots = [...ptyPids, report.daemonPid, ...(codexHome ? daemonPids(codexHome) : [])]
      .filter((pid, i, all) => Number.isInteger(pid) && pid > 1 && all.indexOf(pid) === i);
    if (roots.length > 0 && process.platform === 'win32') {
      // (TPT9048) No process groups on Windows: `taskkill /T /F` each root's tree, then report
      // what is still alive. killWindowsProcessTree() never throws.
      for (const root of roots) killWindowsProcessTree(root);
      await sleep(KILL_GRACE_MS);
      report.survivors = roots.filter(isAlive);
    } else if (roots.length > 0) {
      const snapshot = await snapshotProcesses();
      const tracked = new Set(roots);
      for (const root of roots) for (const pid of listDescendants(snapshot, root)) tracked.add(pid);
      for (const root of roots) {
        killProcessTree(snapshot, root, 'SIGTERM');
        try { process.kill(root, 'SIGTERM'); } catch { /* already gone */ }
      }
      await sleep(KILL_GRACE_MS);
      for (const pid of tracked) {
        if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      }
      await sleep(300);
      report.survivors = [...tracked].filter(isAlive);
    }
    report.leftover = scratchProcesses(scratch);
    if (opts.keep) console.log(`Scratch dir kept: ${scratch}`);
    else {
      // (TPT9048) The trace is the evidence a failed run is for: move it out before the scratch goes.
      const traceDir = path.join(scratch, 'pty-trace');
      if (opts.trace && fs.existsSync(traceDir)) {
        const kept = path.join(os.tmpdir(), `tt-codex-kickoff-trace-${Date.now()}`);
        try { fs.cpSync(traceDir, kept, { recursive: true }); console.log(`PTY trace kept: ${kept}`); } catch { /* best effort */ }
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    return report;
  })());
  process.once('SIGINT', () => { runCleanup().finally(() => process.exit(130)); });

  const checks = { composer: false, rollout: false, singleTurn: true };
  const notes = [];
  let version = 'unknown';

  async function run() {
    const agent = getTaskAgent('codex');
    if (opts.fileKickoff) {
      const prepare = agent.prepareKickoff.bind(agent);
      agent.prepareKickoff = (cfg, prompt, taskId) => prepare(cfg, prompt, taskId, { isWin: true });
    }
    // (TPT9048) Diagnosis knobs for the Windows input path — production values unless set.
    if (opts.noBracket) agent.wrapsBracketedPaste = () => false;
    if (opts.bootFloorMs != null) agent.getInteractiveReadyMs = () => opts.bootFloorMs;
    const status = await agent.cachedDetect(config, true);
    version = (status.detail && status.detail.version) || 'unknown';
    console.log(`Scratch project: ${projectRoot}`);
    console.log(`Codex CLI:       ${version} (${(status.detail && status.detail.bin) || config.CODEX_BIN || 'not found'})`);
    if (!status.available) {
      console.log(`Detect detail:   ${JSON.stringify(status.detail || null)}`);
      notes.push(`Codex unavailable: ${status.reason || 'unknown reason'}`);
      return 3;
    }

    if (opts.switchMode) {
      const { requestPermissionMode, handleTerminalInput } = require('../src/server/terminal-session');
      const { rolloutState } = require('../src/server/task-agent/codex-live-mode');
      const wait = async (check, label, ms = 120000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (check()) return;
          await sleep(100);
        }
        throw new Error(`Timed out: ${label}`);
      };
      // Keep probe instructions separate from real task execution: no task mutations,
      // commits or completion calls, but production spawn policy and switching code.
      agent.buildPrompt = (prompt, options) => `${options.permissionPolicy.prompt}\n${prompt}`;
      const originalSpec = agent.getSpawnSpec.bind(agent);
      agent.getSpawnSpec = async (...args) => {
        const spec = await originalSpec(...args);
        if (!spec.args.includes('--no-daemon')) spec.args.unshift('--no-daemon');
        codexHome = spec.env.CODEX_HOME;
        return spec;
      };
      const transitions = [['plan', 'auto'], ['auto', 'bypass'], ['bypass', 'auto'], ['plan', 'bypass']];
      for (const phase of ['planning', 'running', 'approval']) {
        if (opts.switchPhase && !opts.switchPhase.split(',').includes(phase)) continue;
        for (const [from, to] of transitions) {
          // Bypass has no approval dialog: verify restored checks after this transition.
          const session = createSession(noticeRecorder(() => {}), false, TASK_KEY, projectRoot);
          session.taskAgent = 'codex';
          const token = `MEMORY_${phase}_${from}_${to}`;
          await spawnTerminal(session, `Work on task ${TASK_KEY}: This is an isolated permission-switch probe. `
            + `Remember ${token}. Never mutate tasks or use Tipatask tools. Reply READY and wait.`, TASK_KEY, [], {
            sessions: [], task: { id: TASK_KEY, agentPermissionMode: from, effort: 'low' },
            backend: { getEffectiveProjectSettings: async () => ({ settings: { agent_permission_mode: from } }) },
          });
          ptyPids.push(session.ptyPid);
          // Track every resumed child, including rollback, for PID-based teardown.
          const spawn = session.pty.spawn;
          session.pty.spawn = (...args) => { const child = spawn(...args); ptyPids.push(child.pid); return child; };
          let file;
          await wait(() => {
            file = locateCodexRollout(session._transcriptHint);
            return file && rolloutState(fs.readFileSync(file, 'utf8')).ended;
          }, 'initial turn');
          const originalId = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).payload.id;
          const submit = async text => {
            handleTerminalInput(session, `\x1b[200~${text}\x1b[201~`);
            await sleep(700);
            handleTerminalInput(session, '\r');
          };
          let approval = from === 'bypass' ? 'bypass has no prompt' : 'not requested';
          if (phase === 'running') {
            await submit('Run exactly one shell command: sleep 4. Then reply WAITED.');
            await wait(() => /"type":"(?:exec_command_begin|custom_tool_call|function_call)"/.test(fs.readFileSync(file, 'utf8')),
              'running command');
          } else if (phase === 'approval' && from !== 'bypass') {
            await submit('Request native command approval using sandbox_permissions=require_escalated before running '
              + '`printf PROBE_APPROVAL`. This is a permission-dialog probe; do not run a substitute command.');
            await wait(() => session.pty.nativeApprovalPending()
              || (rolloutState(fs.readFileSync(file, 'utf8')).ended
                && fs.readFileSync(file, 'utf8').includes('PROBE_APPROVAL')), 'approval request');
            approval = session.pty.nativeApprovalPending() ? 'native dialog' : 'native automatic review';
            if (from === 'plan' && approval !== 'native dialog') throw new Error('Plan approval did not reach a native dialog');
          }
          const before = session.ptyPid;
          const frames = [];
          const send = session.ws.send.bind(session.ws);
          session.ws.send = frame => { frames.push(JSON.parse(frame)); send(frame); };
          const state = await requestPermissionMode('probe', to, new Map([['probe', session]]));
          if (state.error || state.confirmed !== to || state.pending) throw new Error(JSON.stringify(state));
          if (session.ptyPid === before) throw new Error('TUI was not resumed');
          if (!frames.some(frame => frame.type === 'session:permission-mode-changed' && frame.pending && frame.confirmed === from)) {
            throw new Error('No pending frame preserving previous mode');
          }
          const afterId = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).payload.id;
          if (afterId !== originalId) throw new Error('Rollout changed');
          await wait(() => rolloutState(fs.readFileSync(file, 'utf8')).ended, 'directive turn');
          await submit('Reply with the MEMORY_ codeword I gave you at the start. Do not use tools.');
          await wait(() => {
            const text = fs.readFileSync(file, 'utf8');
            return rolloutState(text).ended && text.slice(text.lastIndexOf('Reply with the MEMORY_')).includes(token);
          }, 'context recall');
          console.log(`PASS — ${phase}: ${from} -> ${to}, native policy confirmed, same rollout, codeword recalled`
            + (phase === 'approval' ? ` (${approval}${to === 'auto' ? '; Auto checks restored' : ''})` : ''));
          // Stop each completed probe before launching the next; never concurrent tests.
          await session.pty.command('/quit');
          await wait(() => !session.alive, 'probe exit');
        }
      }
      checks.composer = checks.rollout = true;
      return 0;
    }

    // The idle composer as it lands in the ANSI-stripped stream: prompt glyph, then a placeholder —
    // often with the footer glued onto the same line, since ratatui places rows by cursor moves.
    // It is the last frame when only footer text (terminal-session.js's own trailing allowance) and
    // no paste chip follow its last occurrence.
    const placeholderRe = new RegExp(`[›❯>]\\s*(?:${CODEX_COMPOSER_PLACEHOLDERS
      .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
    const emptyComposerLast = (tail) => {
      let last = -1;
      for (const m of tail.matchAll(placeholderRe)) last = m.index;
      return last >= 0 && tail.length - last <= SUBMIT_MARKER_TRAILING_MAX && !agent.getUnsentPasteRe().test(tail.slice(last));
    };

    // Observe the exact production spec without changing it.
    let spec = null;
    const getSpawnSpec = agent.getSpawnSpec.bind(agent);
    agent.getSpawnSpec = async (...args) => (spec = await getSpawnSpec(...args));
    const receivedKickoff = rollout => {
      if (!rollout) return false;
      if (!opts.fileKickoff) return true;
      try { return fs.readFileSync(rollout, 'utf8').includes(KICKOFF); }
      catch { return false; }
    };

    // One task start through the production path, watched until it settles.
    async function launch() {
      const session = createSession(noticeRecorder((text) => console.log(`notice: ${text}`)), false, 'probe-codex-kickoff', projectRoot);
      session.taskAgent = 'codex';
      session.projectPath = projectRoot;
      try {
        await spawnTerminal(session, KICKOFF, TASK_KEY, [], { sessions: [], initialCols: 120, initialRows: 40,
          task: { id: TASK_KEY, agentPermissionMode: null },
          backend: { getEffectiveProjectSettings: async () => ({ settings: { agent_permission_mode: null } }) },
        });
      } finally {
        if (session.ptyPid) ptyPids.push(session.ptyPid);
        codexHome = (spec && spec.env && spec.env.CODEX_HOME) || codexHome;
      }
      const spawnedAt = session._transcriptHint.spawnedAt;
      // (TPT9048) The injector may hold the kickoff while Codex's provisional startup frame is on
      // screen (CodexAgent#getComposerReadyRe()); an empty, silent composer is expected until the
      // kickoff has actually been written. Watch the PTY input for it.
      let kickoffWrittenAt = 0;
      if (session.pty && typeof session.pty.write === 'function') {
        const rawWrite = session.pty.write.bind(session.pty);
        session.pty.write = (data) => {
          if (!kickoffWrittenAt && typeof data === 'string' && data.includes(`Work on task ${TASK_KEY}`)) {
            kickoffWrittenAt = Date.now();
            console.log(`kickoff written ${((kickoffWrittenAt - spawnedAt) / 1000).toFixed(1)}s after spawn`);
          }
          return rawWrite(data);
        };
      }
      if (ptyPids.length === 1) {
        console.log(`argv:            ${spec.command} ${spec.args.join(' ')}`);
        console.log(`CODEX_HOME:      ${codexHome}`);
        console.log(`Kickoff:         ${(spec.initialPrompt || '').length} chars, pasted once the TUI is ready\n`);
      }
      // Silence alone is no verdict: Codex can sit silent on `Waiting for startup` with the paste
      // queued. Only an empty composer that stays the last frame through SILENCE_MS ends the wait early.
      const emptyComposerSilent = () => kickoffWrittenAt > 0 && Date.now() - session.lastOutputAt >= SILENCE_MS
        && emptyComposerLast(session._attentionTail || '');
      let rollout = null;
      let rolloutAt = 0;
      let stop = '';
      let manualEnterSent = false;
      let handoffReadApproved = false;
      for (;;) {
        await sleep(POLL_MS);
        // (TPT9048) The handoff file read waits for command approval where Codex has no sandbox
        // (Windows, sandbox disabled): answer it once, as the user would, when the dialog names the file.
        if (opts.approveHandoffRead && !handoffReadApproved && session.pty && spec && spec.kickoffFile
            && Date.now() - session.lastOutputAt >= 1500) {
          const tail = session._attentionTail || '';
          const fileName = path.basename(spec.kickoffFile);
          if (/Would you like to run the following command\?/i.test(tail) && tail.includes(fileName) && /Yes, proceed/i.test(tail)) {
            handoffReadApproved = true;
            console.log(`approving the handoff file read ${((Date.now() - spawnedAt) / 1000).toFixed(1)}s after spawn (--approve-handoff-read)`);
            session.pty.write('y');
          }
        }
        // (TPT9048) Diagnosis: a second, hand-timed Enter to see whether the TUI accepts one at all.
        if (opts.manualEnterAfterMs != null && !manualEnterSent && session.pty && Date.now() - spawnedAt >= opts.manualEnterAfterMs) {
          manualEnterSent = true;
          console.log(`manual Enter written ${((Date.now() - spawnedAt) / 1000).toFixed(1)}s after spawn (--manual-enter-after)`);
          session.pty.write('\r');
        }
        rollout = locateCodexRollout(session._transcriptHint);
        if (receivedKickoff(rollout)) { rolloutAt = Date.now(); stop = opts.fileKickoff ? 'full kickoff read from file' : 'rollout found'; break; }
        if (!session.alive) { stop = `codex exited (code ${session.exitCode})`; break; }
        if (emptyComposerSilent()) { stop = `empty composer, PTY silent for ${SILENCE_MS / 1000}s`; break; }
        if (Date.now() - spawnedAt >= TIMEOUT_MS) { stop = `no verdict after ${TIMEOUT_MS / 1000}s`; break; }
      }
      if (!rollout) {
        rollout = locateCodexRollout(session._transcriptHint);
        if (receivedKickoff(rollout)) rolloutAt = Date.now();
      }
      console.log(`\nStopped: ${stop} — ${((Date.now() - spawnedAt) / 1000).toFixed(1)}s after spawn, `
        + `${session.buffer.length} bytes of PTY output`);
      return { session, spawnedAt, rollout, rolloutAt, emptyComposer: emptyComposerSilent(), handoffReadApproved };
    }

    let result;
    try {
      result = await launch();
    } catch (err) {
      notes.push(`spawnTerminal failed: ${err.message}`);
      return 3;
    }
    // A fresh project home's first start can die before its app-server daemon is ready: installing
    // the daemon package and the first exec of that new binary outlast the TUI's wait. The package
    // is in place by then, so start once more — what a user does by restarting the task.
    if (!result.rollout && !result.session.alive && COLD_START_RE.test(result.session._attentionTail || '')) {
      notes.push('the first start exited before the app-server daemon was ready (fresh project home); restarted once');
      console.log('Cold start: the app-server daemon was not ready in time — starting once more on the installed home.\n');
      result = await launch();
    }

    const { session, spawnedAt, rollout, rolloutAt, emptyComposer } = result;
    const tail = session._attentionTail || '';
    checks.composer = !emptyComposer;
    checks.rollout = receivedKickoff(rollout);
    if (result.handoffReadApproved) notes.push('the handoff file read was approved by the probe (--approve-handoff-read)');
    // (TPT9048) A re-sent Enter must never have produced a second kickoff turn.
    const turns = rollout ? countKickoffTurns(rollout) : 0;
    checks.singleTurn = !rollout || turns === 1;
    if (rollout) notes.push(`${turns} user turn(s) carry the kickoff line${turns === 1 ? '' : ' — expected exactly one'}`);
    if (checks.rollout) notes.push(`${path.basename(rollout)} has the ${opts.fileKickoff ? 'full file' : 'pasted'} kickoff ${((rolloutAt - spawnedAt) / 1000).toFixed(1)}s after spawn`);
    if (opts.fileKickoff && rollout && !checks.rollout) notes.push('the short handoff was submitted but the full task file was not read');
    if (emptyComposer) {
      notes.push('the empty composer is the last frame — the kickoff never reached it');
      // The same screen through production's marker: no match means checkSubmitted()'s lost-paste
      // re-paste (TPT571) cannot fire on this CLI build either.
      if (!unsentPasteVisible(agent.getEmptyComposerRe(), tail)) {
        notes.push("CodexAgent#getEmptyComposerRe() does not match this screen, so terminal-session.js's re-paste cannot fire");
      }
    }
    if (unsentPasteVisible(agent.getUnsentPasteRe(), tail)) notes.push('a [Pasted Content] chip is still in the composer — pasted, never submitted');
    if (!rollout) notes.push(`no rollout-*.jsonl under ${path.join(codexHome || 'CODEX_HOME', 'sessions')} contains "Work on task ${TASK_KEY}"`);
    if (!(checks.composer && checks.rollout)) {
      console.log(`--- last ${TAIL_LINES} lines of PTY output (ANSI-stripped) ---`);
      console.log(tail.split(/\r?\n/).slice(-TAIL_LINES).map((line) => `  ${line}`).join('\n'));
    }
    if (session._ptyTrace || process.env.TIPATASK_PTY_TRACE) notes.push(`PTY trace: ${process.env.TIPATASK_PTY_TRACE}`);
    return checks.composer && checks.rollout && checks.singleTurn ? 0 : 1;
  }

  let code;
  try {
    code = await run();
  } catch (err) {
    notes.push(`aborted: ${err.message}`);
    code = ptyPids.length > 0 ? 1 : 3;
  }
  const report = await runCleanup();
  const daemonState = report.survivors.includes(report.daemonPid) ? 'STILL RUNNING' : 'stopped';
  console.log(`Daemon:          ${report.daemonPid ? `pid ${report.daemonPid} ${daemonState}` : 'none started'}`);
  if (report.survivors.length > 0) {
    notes.push(`still running after SIGKILL: pid ${report.survivors.join(', ')}`);
    if (code === 0) code = 1;
  }
  if (report.leftover.length > 0) {
    notes.push(`left running (kill by pid): ${report.leftover.join(' | ')}`);
    if (code === 0) code = 1;
  }

  console.log('\ncomposer-ok  rollout-ok  notes');
  console.log([String(checks.composer).padEnd(11), String(checks.rollout).padEnd(10), String(checks.singleTurn).padEnd(11), notes.join('; ')].join('  '));
  console.log(code === 0
    ? `\nPASS — Codex ${version} took the pasted kickoff.`
    : `\nFAIL (exit ${code}) — Codex ${version}`);
  process.exit(code);
}

main().catch((err) => {
  console.error((err && err.stack) || err);
  process.exit(1);
});
