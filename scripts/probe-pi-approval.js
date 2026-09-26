#!/usr/bin/env node
'use strict';

// Spawn real Pi and exercise production approval submission: bracketed paste,
// quiescence, then Enter. Check user-message rendering, output growth, and
// leaked chat-template tokens. --model selects a non-default model.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const config = require('../src/server/config');
const { getTaskAgent } = require('../src/server/task-agent');
const { stripAnsi, carveAttentionLines } = require('../src/server/terminal-session');
const { matchPromptLine, PI_PROMPT_PATTERNS } = require('../src/server/task-agent/prompt-detect');

const PLAN_READY_WAIT_MS = 60000;   // ceiling to reach "Plan ready." — real model call
const POST_APPROVAL_WAIT_MS = 20000; // >= PiAgent#getApprovalWatchdogMs(), so the probe sees what the watchdog would see
const POLL_MS = 250;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function parseModelArg(argv) {
  const idx = argv.indexOf('--model');
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : null;
}

function scratchProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-pi-approval-probe-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  return dir;
}

async function main() {
  const modelArg = parseModelArg(process.argv.slice(2));
  const agent = getTaskAgent('pi');
  const status = await agent.cachedDetect(config, true);
  if (!status.available) {
    console.error(`[probe-pi-approval] Pi unavailable: ${status.reason || 'unknown reason'}`);
    process.exitCode = 1;
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('[probe-pi-approval] WARNING: OPENROUTER_API_KEY not set in this shell — the '
      + 'spawn will still be attempted (a project .tipatask/config.json key or ~/.pi/agent/'
      + 'auth.json may supply it), but if neither is configured the turn will fail auth.');
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
    const clean = stripAnsi(data);
    const lines = carveAttentionLines(session, clean);
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
