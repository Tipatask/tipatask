#!/usr/bin/env node
'use strict';

// Spawn real Pi and exercise production approval submission: bracketed paste,
// quiescence, then Enter. Check user-message rendering, output growth, and
// leaked chat-template tokens. --model selects a non-default model.
//
// --switch-mode --yes runs the live permission-mode switch instead (TPT9138): real Pi spawns
// launched with the production gate, switched through terminal-session.js
// requestPermissionMode(). Plan→Auto at the plan-ready pause, Auto→Bypass with a permission
// request outstanding, Bypass→Auto (prompting restored), and Plan→Bypass during the first turn.
// Each check prints a PASS or FAIL line. Bypass legs let the model run commands unattended in a
// scratch project, hence --yes. Exit 0 all passed, 1 a check failed, 2 refused, 3 Pi unavailable.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Staged extensions and prompt files go to a scratch user-data root, never a live app's, and
// the spawned model gets no task identity or credentials of the shell running the probe.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-pi-probe-data-'));
process.env.TIPATASK_USER_DATA = userData;
for (const key of Object.keys(process.env)) {
  if (/^(?:TIPATASK_(?:TASK_ID|API_TOKEN|TOOL_EXEC|TOOL_SCRIPT|TRACK_DIR|PERMISSION_URL|PERMISSION_TOKEN|PI_MCP_CONFIG)|API_(?:TOKEN|BASE_URL|PROJECT_ID))$/.test(key)) {
    delete process.env[key];
  }
}

const pty = require('node-pty');
const config = require('../src/server/config');
const { getTaskAgent } = require('../src/server/task-agent');
const { stripAnsi, stripOscChunk, carveAttentionLines, requestPermissionMode } = require('../src/server/terminal-session');
const { matchPromptLine, PI_PROMPT_PATTERNS } = require('../src/server/task-agent/prompt-detect');

const PLAN_READY_WAIT_MS = 60000;   // ceiling to reach "Plan ready." — real model call
const POST_APPROVAL_WAIT_MS = 20000; // >= PiAgent#getApprovalWatchdogMs(), so the probe sees what the watchdog would see
const POLL_MS = 250;
const GATE_READY_WAIT_MS = 30000;   // terminal-session.js kills a gated launch that never confirms in 30 s
const SWITCH_PLAN_WAIT_MS = 120000;
const TOOL_WAIT_MS = 120000;         // a model turn that runs the probe command
const PROBE_COMMAND = 'echo tipatask-probe';
const SWITCH_TASK = 'This is a Task App permission-mode probe, not a real task. Do not read, write or edit files, '
  + 'do not run Tipatask or tt commands, and do not change any task status. The whole job is one step: run the '
  + `shell command \`${PROBE_COMMAND}\` once with your bash tool. While planning, present that one-step plan. When `
  + 'implementation is authorized, run it. If the run is blocked and the reason says to retry, retry it. After it '
  + 'succeeds, reply with one short sentence and stop.';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(pred, ms) {
  for (const stop = Date.now() + ms; !pred();) {
    if (Date.now() > stop) return false;
    await sleep(POLL_MS);
  }
  return true;
}

function parseModelArg(argv) {
  const idx = argv.indexOf('--model');
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : null;
}

// The production attention pipeline: OSC strings (Pi paints OSC 133 / OSC 8 marks) first, then CSI.
function cleanChunk(session, data) {
  return stripAnsi(stripOscChunk(session, data));
}

function scratchProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-pi-approval-probe-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  return dir;
}

async function main() {
  const argv = process.argv.slice(2);
  const modelArg = parseModelArg(argv);
  if (argv.includes('--switch-mode') && !argv.includes('--yes')) {
    console.error('[probe-pi-approval] --switch-mode makes real model calls and lets the model run commands '
      + 'unattended (Bypass) in a scratch project. Re-run with --yes to proceed.');
    process.exitCode = 2;
    return;
  }
  const agent = getTaskAgent('pi');
  const status = await agent.cachedDetect(config, true);
  if (!status.available) {
    console.error(`[probe-pi-approval] Pi unavailable: ${status.reason || 'unknown reason'}`);
    process.exitCode = argv.includes('--switch-mode') ? 3 : 1;
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('[probe-pi-approval] WARNING: OPENROUTER_API_KEY not set in this shell — the '
      + 'spawn will still be attempted (a project .tipatask/config.json key or ~/.pi/agent/'
      + 'auth.json may supply it), but if neither is configured the turn will fail auth.');
  }
  if (argv.includes('--switch-mode')) {
    await switchModeProbe(agent, modelArg);
    return;
  }

  const projectRoot = scratchProjectDir();
  const spec = await agent.getSpawnSpec(
    config,
    'Say hello and propose a one-line trivial no-op plan (e.g. "rename a local variable for clarity"). Do not read or write any files.',
    null,
    { taskTags: [], cachedTags: [], taskCommentsBlock: '', projectPath: projectRoot, model: modelArg || undefined },
  );
  console.log(`[probe-pi-approval] spawning: ${spec.command} ${spec.args.slice(0, -1).join(' ')} <prompt>`);

  const ptyProc = pty.spawn(spec.command, spec.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: spec.cwd,
    env: spec.env,
  });

  const session = { pty: ptyProc, lastOutputAt: Date.now(), _attentionLineCarry: '' };
  let buffer = '';
  let planReadyAt = 0;
  ptyProc.onData((data) => {
    session.lastOutputAt = Date.now();
    buffer += data;
    if (planReadyAt) return;
    const lines = carveAttentionLines(session, cleanChunk(session, data));
    for (const line of lines) {
      if (matchPromptLine(line, PI_PROMPT_PATTERNS)) { planReadyAt = Date.now(); break; }
    }
  });

  try {
    console.log('[probe-pi-approval] waiting for "Plan ready."...');
    const startedAt = Date.now();
    while (!planReadyAt && Date.now() - startedAt < PLAN_READY_WAIT_MS) await sleep(POLL_MS);
    if (!planReadyAt) {
      console.log('[probe-pi-approval] FAIL: never saw "Plan ready." within ' + PLAN_READY_WAIT_MS + 'ms');
      console.log('--- last output ---');
      console.log(stripAnsi(buffer).split('\n').slice(-40).join('\n'));
      process.exitCode = 1;
      return;
    }
    console.log(`[probe-pi-approval] plan ready after ${Date.now() - startedAt}ms — submitting approval`);

    const bufferLenAtApproval = buffer.length;
    agent.approvePlan(session); // the exact production call terminal-session.js's approvePlan() makes

    await sleep(POST_APPROVAL_WAIT_MS);

    const growthBytes = buffer.length - bufferLenAtApproval;
    const tail = stripAnsi(buffer).slice(-2000);
    const ctx = { growthBytes, tail, idleMs: Date.now() - session.lastOutputAt };
    const stalled = agent.approvalStalled(session, ctx);

    console.log(`[probe-pi-approval] post-approval growth: ${growthBytes} bytes`);
    console.log(`[probe-pi-approval] approvalStalled() verdict: ${stalled ? 'STALLED' : 'ok'}`);
    if (stalled) {
      console.log('[probe-pi-approval] tail (last 2000 chars, ANSI-stripped):');
      console.log(tail);
      process.exitCode = 1;
    } else {
      console.log('[probe-pi-approval] PASS — approval submitted and the model produced a real reply.');
    }
  } finally {
    try { ptyProc.kill(); } catch { /* already dead */ }
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── --switch-mode ──

function check(ok, text, detail = '') {
  console.log(`[probe-pi-approval] ${ok ? 'PASS' : 'FAIL'} ${text}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

// A Plan run launched the way terminal-session.js launches every gated Pi run: production
// gate, getSpawnSpec() with it, kickoff pasted after the gate's startup handshake.
async function startGatedPi(agent, model, label) {
  const { createSession } = require('../src/server/session-state');
  const { createPermissionGate } = require('../src/server/permission-gate');
  const projectRoot = scratchProjectDir();
  const session = createSession(null, false, `probe-${label}`, projectRoot);
  Object.assign(session, {
    taskAgent: 'pi', projectPath: projectRoot, _attentionLineCarry: '', lastOutputAt: Date.now(),
    permissionPolicy: agent.buildPermissionPolicy({ mode: 'plan', source: 'task' }),
    permissionMode: { requested: 'plan', confirmed: 'plan', pending: false, error: null },
    terminalPhase: 'planning', _permissionEpoch: 1,
  });
  const decisions = [];
  session._permissionGate = await createPermissionGate(session, { root: projectRoot, timeoutMs: TOOL_WAIT_MS,
    onDecision: (d) => decisions.push({ ...d, at: Date.now() }) });
  const spec = await agent.getSpawnSpec(config, SWITCH_TASK, null, {
    taskTags: [], cachedTags: [], taskCommentsBlock: '', projectPath: projectRoot, model: model || undefined,
    permissionPolicy: session.permissionPolicy, permissionGate: session._permissionGate,
  });
  console.log(`[probe-pi-approval] ${label}: spawning ${spec.model} with the permission gate (kickoff pasted after its handshake)`);
  const proc = pty.spawn(spec.command, spec.args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: spec.cwd, env: spec.env });
  Object.assign(session, { pty: proc, alive: true });
  const run = { session, sessions: new Map([['probe', session]]), gate: session._permissionGate, decisions,
    buffer: '', planReadyAt: 0 };
  proc.onData((data) => {
    session.lastOutputAt = Date.now();
    run.buffer += data;
    for (const line of carveAttentionLines(session, cleanChunk(session, data))) {
      if (!run.planReadyAt && matchPromptLine(line, PI_PROMPT_PATTERNS)) run.planReadyAt = Date.now();
    }
  });
  proc.onExit(() => { session.alive = false; });
  run.stop = () => {
    session._terminated = true;
    session.alive = false;
    run.gate.close();
    try { proc.kill(); } catch { /* already dead */ }
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  if (!check(await waitFor(() => run.gate.ready, GATE_READY_WAIT_MS), `${label}: gate startup handshake`)) return run;
  await waitFor(() => Date.now() - session.lastOutputAt >= 800, 10000);
  await submit(session, spec.initialPrompt);
  run.kickoffAt = Date.now();
  return run;
}

async function submit(session, text) {
  session.pty.write('\x1b[200~' + text + '\x1b[201~');
  await sleep(800);
  session.pty.write('\r');
}

function tail(run) {
  return stripAnsi(stripOscChunk(null, run.buffer)).split('\n').slice(-30).join('\n');
}

const probeRequest = (run) => {
  const request = run.gate.snapshot();
  return request && request.input.includes('tipatask-probe') ? request : null;
};

// Waits for the probe command's approval request, denying any other request the model makes.
async function waitForProbeRequest(run, ms) {
  return waitFor(() => {
    const request = run.gate.snapshot();
    if (request && !request.input.includes('tipatask-probe')) run.gate.answer(request.id, false);
    return !!probeRequest(run);
  }, ms);
}

const ranProbe = (run, mode, since) => run.decisions.some((d) => d.at >= since && d.decision === 'allow'
  && d.mode === mode && JSON.stringify(d.input ?? {}).includes('tipatask-probe'));

async function switchTo(run, mode, label) {
  const startedAt = Date.now();
  const state = await requestPermissionMode('probe', mode, run.sessions);
  const ok = state.confirmed === mode && !state.pending && !state.error && run.session.permissionPolicy.mode === mode;
  check(ok, `${label}: confirmed in ${Date.now() - startedAt}ms`,
    ok ? '' : `state ${JSON.stringify(state)}`);
  return ok;
}

async function switchModeProbe(agent, model) {
  let run = await startGatedPi(agent, model, 'run 1');
  try {
    if (!run.gate.ready) return;
    if (!check(await waitFor(() => run.planReadyAt, SWITCH_PLAN_WAIT_MS), 'run 1: Plan ready. reached in Plan mode')) {
      console.log(tail(run));
      return;
    }
    check(!run.decisions.some((d) => d.mode === 'plan' && d.decision === 'allow' && !['read', 'grep', 'find', 'ls'].includes(d.tool)),
      'run 1: Plan allowed no write or shell tool');

    if (!await switchTo(run, 'auto', 'Plan→Auto at the plan-ready pause')) return;
    if (!check(await waitForProbeRequest(run, TOOL_WAIT_MS), 'Auto prompts before the shell command runs (request outstanding)')) {
      console.log(tail(run));
      return;
    }
    const outstanding = probeRequest(run);
    const beforeBypass = Date.now();
    if (!await switchTo(run, 'bypass', 'Auto→Bypass with a permission request outstanding')) return;
    check(run.decisions.some((d) => d.prompted && d.decision === 'deny' && d.at >= beforeBypass) && run.gate.snapshot()?.id !== outstanding.id,
      'the outstanding request was revoked, not approved by the switch');
    if (!check(await waitFor(() => ranProbe(run, 'bypass', beforeBypass), TOOL_WAIT_MS), 'the retry ran under Bypass without a prompt')) {
      console.log(tail(run));
      return;
    }

    await waitFor(() => Date.now() - run.session.lastOutputAt >= 3000, 60000);
    const beforeAuto = Date.now();
    if (!await switchTo(run, 'auto', 'Bypass→Auto')) return;
    await waitFor(() => Date.now() - run.session.lastOutputAt >= 1500, 30000);
    await submit(run.session, `Run \`${PROBE_COMMAND}\` once more with your bash tool, then stop.`);
    if (!check(await waitForProbeRequest(run, TOOL_WAIT_MS), 'Bypass→Auto restored the approval prompt')) {
      console.log(tail(run));
      return;
    }
    run.gate.answer(probeRequest(run).id, true);
    check(await waitFor(() => run.decisions.some((d) => d.prompted && d.decision === 'allow' && d.mode === 'auto' && d.at >= beforeAuto
      && JSON.stringify(d.input ?? {}).includes('tipatask-probe')), 10000), 'the approved command ran under Auto');
  } finally {
    run.stop();
  }

  run = await startGatedPi(agent, model, 'run 2');
  try {
    if (!run.gate.ready) return;
    // Switch as soon as the planning turn is running (Pi's "Working..." status line).
    const start = run.buffer.length;
    await waitFor(() => run.planReadyAt || run.buffer.slice(start).includes('Working'), 30000);
    const when = run.planReadyAt ? 'at the plan-ready pause' : 'while the planning turn was running';
    const beforeBypass = Date.now();
    if (!await switchTo(run, 'bypass', `Plan→Bypass ${when}`)) return;
    check(await waitFor(() => ranProbe(run, 'bypass', beforeBypass), TOOL_WAIT_MS), 'the shell command ran under Bypass without a prompt');
    check(!run.decisions.some((d) => d.prompted), 'Bypass raised no approval request');
  } finally {
    run.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
});
