#!/usr/bin/env node
'use strict';

// Real claude task terminals switched live through terminal-session.js requestPermissionMode()
// (TPT9136). Each run is launched with the production ClaudeAgent#getSpawnSpec() in a scratch
// project, its PTY output goes through the production attention pipeline (feedAttentionChunk(),
// which keeps the footer tracker current), and every switch runs the production adapter
// (task-agent/claude-live-mode.js). Evidence per check: the footer, the session transcript (the
// mode Claude stamps on each new message and its `permission-mode` entries, and the directive it
// took — from its queue at a tool boundary, where no mode is stamped, or as a new message) and
// the TUI itself. Each check prints PASS or FAIL:
//
//   run 1  Plan, project default Bypass (bypass pre-enabled):
//          Plan→Auto while the planning turn runs · Auto→Bypass while a command runs (it finishes,
//          not cancelled) · Bypass→Auto: the next request runs under auto mode again
//   run 2  Plan, project default Bypass: Plan→Bypass, then a command runs under bypass
//   run 3  Auto launch: native auto mode; routine Bash runs without Claude's "switch to auto
//          mode" approval
//   run 4  Auto with the acceptEdits fallback forced (as for a CLI or account without auto mode):
//          a switch while Claude's permission prompt is open is refused and sends no key ·
//          Auto→Bypass after it is answered · Bypass→Auto brings the permission prompt back
//
// Real model calls, and Bypass lets the model run commands unattended in a scratch project, hence
// --yes. Like a production launch it records folder trust for each scratch project — and, for the
// pre-enabled runs, Claude's bypass acknowledgement — in the user's Claude configuration, and
// Claude's plan mode may save its short plan under the user's Claude plans directory. Never
// starts a server or touches port 4455; scratch projects are removed afterwards. Strips the
// CLAUDECODE / CLAUDE_CODE_* variables of a surrounding Claude session, which would otherwise stop
// the child from writing its transcript. Exit 0 all passed, 1 a check failed, 2 refused, 3 Claude
// unavailable.
//
// Usage:
//   npm run probe:claude-mode -- --yes
//   npm run probe:claude-mode -- --yes --model sonnet --only 1,4 --record /tmp/claude-mode-runs

require('./check-node-version');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-claude-mode-probe-data-'));
process.env.TIPATASK_USER_DATA = userData;
for (const key of Object.keys(process.env)) {
  if (key === 'CLAUDECODE' || /^CLAUDE_CODE_/.test(key)
    || /^(?:TIPATASK_(?:TASK_ID|API_TOKEN|TOOL_EXEC|TOOL_SCRIPT|TRACK_DIR|PERMISSION_URL|PERMISSION_TOKEN)|API_(?:TOKEN|BASE_URL|PROJECT_ID))$/.test(key)) {
    delete process.env[key];
  }
}

const pty = require('node-pty');
const config = require('../src/server/config');
const { getTaskAgent } = require('../src/server/task-agent');
const ClaudeAgent = require('../src/server/task-agent/claude-agent');
const live = require('../src/server/task-agent/claude-live-mode');
const { locateClaudeTranscript } = require('../src/server/task-agent/final-message');
const { createSession } = require('../src/server/session-state');
const { stripAnsi, stripOscChunk, feedAttentionChunk, requestPermissionMode } = require('../src/server/terminal-session');
const { reflowChunk } = require('../src/server/screen-reflow');

const READY_WAIT_MS = 45000;
const TURN_WAIT_MS = 180000;
const POLL_MS = 200;
const DIALOG_RE = /Do\s*you\s*want\s*to\s*proceed\?/i;
const SWITCH_TO_AUTO_RE = /switch\s*to\s*auto\s*mode/i;
const PROBE_PREFIX = 'This is a Task App permission-mode probe, not a real task. Do not read, write or edit files, do not run Tipatask or tt commands, and do not change any task status.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// --record <dir>: each run's raw PTY output, timestamped, for diagnosing a failed check.
let recordDir = null;
async function waitFor(pred, ms) {
  for (const stop = Date.now() + ms; !pred();) {
    if (Date.now() > stop) return false;
    await sleep(POLL_MS);
  }
  return true;
}

function check(ok, text, detail = '') {
  console.log(`[probe-claude-mode] ${ok ? 'PASS' : 'FAIL'} ${text}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

// One task terminal: spawned from the production spawn spec, output fed through the production
// attention pipeline, the spec's refined policy and native modes adopted as _spawnTerminal() does.
async function startClaude(agent, { label, mode, projectDefault = null, capabilities = null, model }) {
  // The CLI keys folder trust by the real path (macOS tmpdir is a /var → /private/var symlink).
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-claude-mode-probe-')));
  fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
  const session = createSession(null, false, `probe-${label}`, projectRoot);
  Object.assign(session, {
    taskAgent: 'claude', taskId: 'PROBE', projectPath: projectRoot, lastOutputAt: Date.now(),
    permissionPolicy: agent.buildPermissionPolicy({ mode, source: 'task' }),
    permissionMode: { requested: mode, confirmed: mode, pending: false, error: null },
    terminalPhase: mode === 'plan' ? 'planning' : 'executing', _permissionEpoch: 1, _injectDone: false,
  });
  const realCapabilities = ClaudeAgent._cliPermissionCapabilities;
  if (capabilities) ClaudeAgent._cliPermissionCapabilities = async (c) => ({ ...(await realCapabilities(c)), ...capabilities });
  const agentSessionId = crypto.randomUUID();
  let spec;
  try {
    spec = await agent.getSpawnSpec({ ...config, SIMPLE_MODE: true }, 'Wait for instructions.', null, {
      taskTags: [], cachedTags: [], taskCommentsBlock: '', projectPath: projectRoot, model: model || undefined,
      permissionPolicy: session.permissionPolicy, agentSessionId,
      backend: { getEffectiveProjectSettings: async () => ({ settings: { agent_permission_mode: projectDefault } }) },
    });
  } finally { ClaudeAgent._cliPermissionCapabilities = realCapabilities; }
  session.permissionPolicy = spec.permissionPolicy;
  session._claudeNative = { ...spec.nativePermission, expected: spec.nativePermission.launch };
  session._claudeTui = null;
  console.log(`[probe-claude-mode] ${label}: claude ${spec.args.slice(0, 2).join(' ')} --permission-mode ${spec.nativePermission.launch}`
    + `${spec.nativePermission.preEnableBypass ? ' --allow-dangerously-skip-permissions' : ''} (Auto here = ${spec.nativePermission.auto})`);
  const proc = pty.spawn(spec.command, spec.args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: spec.cwd, env: spec.env });
  const writes = [];
  const rawWrite = proc.write.bind(proc);
  proc.write = (data) => { writes.push(data); return rawWrite(data); };
  Object.assign(session, { pty: proc, alive: true });
  const run = { label, session, spec, writes, buffer: '', sessions: new Map([['probe', session]]),
    hint: { cwd: spec.cwd, agentSessionId, env: spec.env } };
  run.chunks = [];
  proc.onData((data) => {
    const now = Date.now();
    session.lastOutputAt = now;
    run.buffer += data;
    run.chunks.push([now, data]);
    const oscFree = stripOscChunk(session, data);
    const clean = stripAnsi(oscFree);
    const rowChunk = reflowChunk(session, oscFree);
    if (/\x1b\[2J|\x1b\[\?1049[hl]/.test(data)) session._attentionTail = '';
    session._attentionTail = ((session._attentionTail || '') + clean).slice(-1024);
    feedAttentionChunk(session, agent, oscFree, clean, now, rowChunk, null);
  });
  proc.onExit(() => { session.alive = false; });
  run.stop = () => {
    if (recordDir) {
      fs.mkdirSync(recordDir, { recursive: true });
      fs.writeFileSync(path.join(recordDir, `${label.replace(/\s+/g, '-')}.jsonl`), run.chunks.map(([at, d]) => JSON.stringify({ at, d })).join('\n') + '\n');
    }
    session._terminated = true;
    session.alive = false;
    try { proc.kill(); } catch { /* already gone */ }
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return run;
}

// What a task kickoff does: bracketed paste, the typed words Claude requires, then Enter.
async function submit(run, text) {
  const { session } = run;
  await waitFor(() => Date.now() - session.lastOutputAt >= 800, 15000);
  session.pty.write(`\x1b[200~${text}\x1b[201~`);
  await sleep(700);
  session.pty.write(` ${ClaudeAgent.KICKOFF_TYPED_LINE}`);
  await sleep(500);
  session.pty.write('\r');
  session._injectDone = true;
  run.submittedAt = Date.now();
}

const plain = (run, from = 0) => stripAnsi(stripOscChunk(null, run.buffer.slice(from)));

// What the session transcript says, with line indexes: the modes Claude recorded (its
// `permission-mode` entries and the mode stamped on each user message) and the user messages
// it took — typed ones and those it delivered from its queue at a tool boundary (no mode is
// stamped on those).
function transcript(run) {
  const file = locateClaudeTranscript(run.hint);
  if (!file) return { modes: [], messages: [], lines: 0 };
  const text = fs.readFileSync(file, 'utf8');
  const modes = [];
  const messages = [];
  text.split('\n').forEach((line, i) => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (row.type === 'permission-mode' || (row.type === 'user' && row.permissionMode)) modes.push({ i, mode: row.permissionMode });
    const content = row.message?.content;
    const said = row.attachment?.type === 'queued_command' ? row.attachment.prompt
      : row.type === 'user' ? (typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.text || '').join(' ') : '') : '';
    if (said) messages.push({ i, text: String(said), queued: row.attachment?.type === 'queued_command' });
  });
  return { modes, messages, lines: text.split('\n').length };
}

// A tool call whose input, or a tool result whose output, carries `needle` — the transcript says
// what really ran; the screen can glue or repaint rows.
function toolRow(run, kind, needle) {
  const file = locateClaudeTranscript(run.hint);
  if (!file) return false;
  return fs.readFileSync(file, 'utf8').split('\n').some((line) => {
    let row;
    try { row = JSON.parse(line); } catch { return false; }
    const content = row.message?.content;
    return Array.isArray(content) && content.some((c) => {
      if (c.type !== kind) return false;
      const text = kind === 'tool_use' ? JSON.stringify(c.input || {})
        : typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join(' ');
      return text.includes(needle);
    });
  });
}
const ran = (run, output) => toolRow(run, 'tool_result', output);

// The mode directive reached Claude (taken from its queue or as a new message) after `sinceLine`.
async function directiveDelivered(run, mode, sinceLine, label) {
  const find = () => transcript(run).messages.find((m) => m.i >= sinceLine && m.text.includes(`The user selected ${mode} for this session`));
  const ok = await waitFor(() => !!find(), TURN_WAIT_MS);
  return check(ok, `${run.label}: ${label}`, ok ? (find().queued ? 'delivered from the queue at the next tool boundary' : 'taken as a new message') : 'not in the transcript');
}

async function switchTo(run, mode, label) {
  const startedAt = Date.now();
  const before = transcript(run).lines || 0;
  const state = await requestPermissionMode('probe', mode, run.sessions);
  const ok = state.confirmed === mode && !state.pending && !state.error && run.session.permissionPolicy.mode === mode;
  check(ok, `${run.label}: ${label}: confirmed in ${Date.now() - startedAt}ms (footer: ${live.footerMode(run.session) || 'held by the paste hint'}, last mode shown: ${run.session._claudeTui?.mode})`,
    ok ? '' : `state ${JSON.stringify(state)}`);
  return { ok, state, before };
}

// Claude records the mode before its next request; the switch is enforced once it says `native`.
async function recordedMode(run, native, sinceLine, label) {
  const ok = await waitFor(() => transcript(run).modes.some((m) => m.i >= sinceLine && m.mode === native), TURN_WAIT_MS);
  const modes = transcript(run).modes.filter((m) => m.i >= sinceLine).map((m) => m.mode);
  return check(ok, `${run.label}: ${label}`, ok ? `transcript permission-mode ${native}` : `recorded ${JSON.stringify(modes)}`);
}

function tail(run) {
  return plain(run).split('\n').slice(-25).join('\n');
}

async function ready(run) {
  const ok = await waitFor(() => live.footerMode(run.session), READY_WAIT_MS);
  check(ok, `${run.label}: footer shows ${live.footerMode(run.session) || 'nothing'} at startup`);
  if (!ok) console.log(tail(run));
  return ok;
}

async function run1(agent, model) {
  const run = await startClaude(agent, { label: 'run 1', mode: 'plan', projectDefault: 'bypass', model });
  try {
    if (!await ready(run)) return;
    check(run.spec.nativePermission.preEnableBypass, 'run 1: Plan launch pre-enables bypass for a Bypass-default project');
    await submit(run, `${PROBE_PREFIX} The job: run the shell command \`sleep 8 && echo tipatask-probe-one\` once with the Bash tool, then reply with one short sentence. Present that one-step plan first.`);
    await sleep(1500); // the planning turn is running
    const toAuto = await switchTo(run, 'auto', 'Plan→Auto while the planning turn runs');
    if (!toAuto.ok) return void console.log(tail(run));
    await directiveDelivered(run, 'auto', toAuto.before, 'the Auto directive reached Claude during planning');
    await recordedMode(run, 'auto', 0, 'Claude made its next request in auto mode');
    // Auto→Bypass while the command runs.
    const running = await waitFor(() => toolRow(run, 'tool_use', 'sleep 8') && !ran(run, 'tipatask-probe-one'), TURN_WAIT_MS);
    if (!check(running, 'run 1: the sleep command started')) return void console.log(tail(run));
    const toBypass = await switchTo(run, 'bypass', 'Auto→Bypass while a command runs');
    check(!ran(run, 'tipatask-probe-one'), 'run 1: the switch landed while the command was still running');
    check(await waitFor(() => ran(run, 'tipatask-probe-one'), TURN_WAIT_MS), 'run 1: the running command finished normally (not cancelled)');
    if (toBypass.ok) await directiveDelivered(run, 'bypass', toBypass.before, 'the Bypass directive reached Claude after the running command');
    await waitFor(() => Date.now() - run.session.lastOutputAt >= 3000, 120000);
    const toAuto2 = await switchTo(run, 'auto', 'Bypass→Auto');
    if (!toAuto2.ok) return void console.log(tail(run));
    await submit(run, 'Run `echo tipatask-probe-two` once with the Bash tool, then stop.');
    await recordedMode(run, 'auto', toAuto2.before, 'Bypass→Auto: the next request runs under auto mode (classifier), not bypass');
  } finally { run.stop(); }
}

async function run2(agent, model) {
  const run = await startClaude(agent, { label: 'run 2', mode: 'plan', projectDefault: 'bypass', model });
  try {
    if (!await ready(run)) return;
    await submit(run, `${PROBE_PREFIX} The job: run the shell command \`echo tipatask-probe-three\` once with the Bash tool. Present that one-step plan, end with a line reading Plan ready. and wait.`);
    const paused = await waitFor(() => /Plan\s*ready\./.test(plain(run, 0).split('Wait for user approval').pop()) && Date.now() - run.session.lastOutputAt >= 2000, 120000);
    const where = paused ? 'at the plan-ready pause' : 'during planning';
    const toBypass = await switchTo(run, 'bypass', `Plan→Bypass ${where}`);
    if (!toBypass.ok) return void console.log(tail(run));
    await recordedMode(run, 'bypassPermissions', toBypass.before, 'the next request runs under bypass');
    check(await waitFor(() => ran(run, 'tipatask-probe-three'), TURN_WAIT_MS), 'run 2: the command ran under bypass');
    check(!DIALOG_RE.test(plain(run)), 'run 2: no permission prompt');
  } finally { run.stop(); }
}

async function run3(agent, model) {
  const run = await startClaude(agent, { label: 'run 3', mode: 'auto', model });
  try {
    if (!await ready(run)) return;
    if (!check(run.spec.nativePermission.launch === 'auto' && live.footerMode(run.session) === 'auto', 'run 3: Auto launched native auto mode',
      `launch ${run.spec.nativePermission.launch} (${run.spec.nativePermission.autoReason || 'no fallback'}), footer ${live.footerMode(run.session)}`)) return;
    await submit(run, `${run.spec.permissionPolicy.prompt}\n\n${PROBE_PREFIX} Run \`python3 -c "print(6*7)"\` once with the Bash tool and reply with the number.`);
    check(await waitFor(() => ran(run, '42'), TURN_WAIT_MS), 'run 3: routine Bash ran in native auto mode');
    check(!SWITCH_TO_AUTO_RE.test(plain(run)) && !DIALOG_RE.test(plain(run)), 'run 3: no "switch to auto mode" approval or permission prompt');
  } finally { run.stop(); }
}

async function run4(agent, model) {
  const run = await startClaude(agent, { label: 'run 4', mode: 'auto', projectDefault: 'bypass', capabilities: { autoMode: false }, model });
  try {
    if (!await ready(run)) return;
    check(live.footerMode(run.session) === 'acceptEdits', 'run 4: Auto fell back to accept edits');
    await submit(run, `${PROBE_PREFIX} Run \`python3 -c "print(6*7)"\` once with the Bash tool and reply with the number.`);
    if (!check(await waitFor(() => live.dialogOpen(run.session) && DIALOG_RE.test(plain(run)), TURN_WAIT_MS), 'run 4: Claude asks before the command (permission prompt open)')) {
      return void console.log(tail(run));
    }
    const keysBefore = run.writes.length;
    const refused = await requestPermissionMode('probe', 'bypass', run.sessions);
    check(refused.error?.reason === 'prompt_open' && refused.confirmed === 'auto', 'run 4: a switch while the prompt is open is refused',
      JSON.stringify(refused.error));
    check(run.writes.length === keysBefore, 'run 4: the refused switch sent no key (the prompt was left for the user)');
    run.session.pty.write('1'); // the user answers: Yes
    check(await waitFor(() => ran(run, '42'), TURN_WAIT_MS), 'run 4: the approved command ran');
    await waitFor(() => Date.now() - run.session.lastOutputAt >= 3000, 120000);
    const toBypass = await switchTo(run, 'bypass', 'Auto→Bypass after the prompt was answered');
    if (!toBypass.ok) return void console.log(tail(run));
    // Straight back: the Bypass directive's paste hint still holds the footer row (8 s), so the
    // switch must wait for the footer before its first press.
    check(!live.footerMode(run.session), 'run 4: the next switch starts while the paste hint holds the footer row');
    const toAuto = await switchTo(run, 'auto', 'Bypass→Auto right after');
    if (!toAuto.ok) return void console.log(tail(run));
    await waitFor(() => Date.now() - run.session.lastOutputAt >= 3000, 120000);
    // The directive's paste hint holds the footer row for 8 s; read the footer once it is back.
    await waitFor(() => live.footerMode(run.session), 12000);
    check(live.footerMode(run.session) === 'acceptEdits', 'run 4: Bypass→Auto returned to accept edits (the fallback)',
      `footer ${live.footerMode(run.session) || 'still held by a hint'}`);
    const mark = run.buffer.length;
    await submit(run, 'Run `python3 -c "print(7*6+1)"` once with the Bash tool, then stop.');
    check(await waitFor(() => DIALOG_RE.test(plain(run, mark)), TURN_WAIT_MS), 'run 4: Bypass→Auto brought Claude\'s permission prompt back');
    run.session.pty.write('\x1b'); // reject
  } finally { run.stop(); }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--yes')) {
    console.error('[probe-claude-mode] makes real model calls and lets the model run commands unattended (Bypass) in '
      + 'scratch projects, and records folder trust / the bypass acknowledgement in your Claude configuration. '
      + 'Re-run with --yes to proceed.');
    process.exitCode = 2;
    return;
  }
  const agent = getTaskAgent('claude');
  const status = await agent.detect(config);
  if (!status.available) {
    console.error(`[probe-claude-mode] Claude unavailable: ${status.reason}`);
    process.exitCode = 3;
    return;
  }
  const model = argValue(argv, '--model') || 'sonnet';
  recordDir = argValue(argv, '--record');
  const only = (argValue(argv, '--only') || '1,2,3,4').split(',').map((s) => s.trim());
  const help = await ClaudeAgent._cliHelpText(config);
  console.log(`[probe-claude-mode] ${String(await agent.getPermissionVersion(status)).trim()}; --permission-mode choices: ${live.parsePermissionChoices(help).join(', ')}`);
  for (const [id, fn] of [['1', run1], ['2', run2], ['3', run3], ['4', run4]]) {
    if (only.includes(id)) await fn(agent, model);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
});
