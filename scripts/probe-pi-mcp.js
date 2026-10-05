#!/usr/bin/env node
'use strict';

// ── Pi MCP bridge live probe ──
// Spawns the REAL Pi CLI with the production PiAgent#getSpawnSpec() argv/env — the command from
// resolvePiLaunch(), `-e <staged mcp-bridge.mjs>` and TIPATASK_PI_MCP_CONFIG=<derived config> —
// and proves the bridge works end to end:
//   1. TOOL CALLED   — the --mode json stream has a `tool_execution_start` for
//                      `tipatask__get_task` with the requested task_key.
//   2. TASK RESOLVED — the matching `tool_execution_end` is not an error and its text is the
//                      task's JSON (task id, project id and a title equal to a direct REST GET).
//
// Pi's JSONL event schema is what pi-session.js parses, and the bridge registers its tools in
// `session_start`; a Pi or MCP SDK bump that breaks either shows up here first.
//
// One-shot: the trailing positional kickoff prompt is swapped for a direct instruction and
// `--mode json` is added — every other argument and the whole env are getSpawnSpec()'s own. Runs in
// a throwaway scratch project with its own user-data dir and a copy of this project's credentials.
// Read-only against the API. No server is started and port 4455 is never touched.
//
// It talks to whatever API .tipatask/config.json points at — usually production — and spends one
// real model turn. Hence the explicit --yes. Needs a built bridge bundle (`node build.js`).
//
// Usage: npm run probe:pi-mcp -- --yes [--task KEY] [--model ID] [--keep] [--verbose]
// Exit codes: 0 = both checks passed · 1 = a check failed · 2 = refused to run (no --yes, no
//             credentials, no Pi model row, no bridge) · 3 = Pi unavailable or the turn never ran.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_ROOT = path.resolve(__dirname, '..');
const TURN_TIMEOUT_MS = 4 * 60 * 1000;
const TOOL = 'tipatask__get_task';

function parseArgs(argv) {
  const opts = { yes: false, keep: false, verbose: false, task: null, model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') opts.yes = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--task') opts.task = String(argv[++i] || '').trim() || null;
    else if (a === '--model') opts.model = String(argv[++i] || '').trim() || null;
  }
  return opts;
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

function resultText(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sourceRoot = findProjectRoot(process.env.TIPATASK_PROJECT_ROOT || process.cwd());
  if (!sourceRoot) {
    console.error('No .tipatask/config.json found above the current directory.');
    process.exit(2);
  }
  const sourceCfg = JSON.parse(fs.readFileSync(path.join(sourceRoot, '.tipatask', 'config.json'), 'utf8'));
  const { baseUrl: base, projectId, token } = require('../src/server/api-credentials').getApiCredentials(sourceRoot);
  delete sourceCfg.API_TOKEN;
  if (!base || !projectId || !token) {
    console.error('The selected project or signed-in account is unavailable.');
    process.exit(2);
  }
  if (require('../src/server/project-config').readPiEntries(sourceCfg).length === 0 && !opts.model) {
    console.error('No PI_MODELS row is configured for this project (or pass --model).');
    process.exit(2);
  }
  if (!opts.yes) {
    console.error([
      'This probe runs a real Pi turn against a real API:',
      `  API:     ${base} (project ${projectId}), read-only`,
      `  Task:    ${opts.task || 'first task the API lists'}`,
      '  Spends:  1 model turn',
      'Re-run with --yes to proceed.',
    ].join('\n'));
    process.exit(2);
  }

  const api = async (p) => {
    const res = await fetch(`${String(base).replace(/\/+$/, '')}/api/projects/${projectId}${p}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    return { status: res.status, json, text };
  };

  let taskKey = opts.task;
  if (!taskKey) {
    const list = await api('/tasks?fields=summary&limit=1');
    const first = list.json && Array.isArray(list.json.tasks) ? list.json.tasks[0] : null;
    taskKey = first && (first.task_key || first.id);
    if (!taskKey) {
      console.error(`Could not pick a task (HTTP ${list.status}); pass --task KEY.`);
      process.exit(2);
    }
  }
  const direct = await api(`/tasks/${encodeURIComponent(taskKey)}`);
  const expectedTitle = direct.json && direct.json.task && direct.json.task.title;
  if (direct.status !== 200 || typeof expectedTitle !== 'string') {
    console.error(`GET /tasks/${taskKey} -> HTTP ${direct.status}; pass an existing --task KEY.`);
    process.exit(2);
  }

  // ── Scratch project: own root, own user-data dir, a copy of the credentials ──
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pi-mcp-probe-')));
  const userData = path.join(scratch, '.userdata');
  fs.mkdirSync(path.join(scratch, '.tipatask'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(scratch, '.tipatask', 'config.json'), JSON.stringify(sourceCfg, null, 2));

  for (const key of Object.keys(process.env)) {
    if (key === 'CLAUDECODE' || /^CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH|SSE_PORT)$/.test(key)) delete process.env[key];
    // The scratch account store supplies credentials; the bridge must never see an inherited token.
    if (/^(API_BASE_URL|API_TOKEN|API_PROJECT_ID|TIPATASK_TASK_ID|TIPATASK_TRACK_DIR|TIPATASK_ELECTRON_HOST|TIPATASK_PI_MCP_CONFIG)$/.test(key)) delete process.env[key];
  }
  process.env.TIPATASK_PROJECT_ROOT = scratch;
  process.env.TIPATASK_USER_DATA = userData;
  process.env.TIPATASK_SERVER_ROOT = SERVER_ROOT;
  process.env.TIPATASK_NO_BANNER = '1';
  require('../src/server/account-store').writeAccountToken(base, token, { userDataRoot: userData });

  // Required only now, so config.js resolves against the scratch project.
  const config = require('../src/server/config');
  const { getTaskAgent } = require('../src/server/task-agent');
  const { writeProjectMcpConfig } = require('../src/server/project-config');
  writeProjectMcpConfig(scratch, SERVER_ROOT); // .mcp.json + .claude/settings.local.json, as for a real project

  let child = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
    }
    if (opts.keep) console.log(`Scratch dir kept: ${scratch}`);
    else fs.rmSync(scratch, { recursive: true, force: true });
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const checks = { toolCalled: false, taskResolved: false };
  const notes = [];
  let ran = false;
  try {
    const agent = getTaskAgent('pi');
    const status = await agent.cachedDetect(config, true);
    if (!status.available) {
      notes.push(`Pi unavailable: ${status.reason || 'unknown reason'}`);
      return finish(3);
    }
    const spec = await agent.getSpawnSpec(config, `Probe: call ${TOOL} for ${taskKey}.`, taskKey, {
      projectPath: scratch, model: opts.model || undefined,
    });
    const eAt = spec.args.indexOf('-e');
    if (!spec.env.TIPATASK_PI_MCP_CONFIG || eAt === -1) {
      console.error('getSpawnSpec() did not load the MCP bridge (mcp-bridge=off). Run `node build.js` so dist/pi-ext/mcp-bridge.mjs exists.');
      return finish(2);
    }
    console.log(`Scratch project: ${scratch}`);
    console.log(`Task:            ${taskKey} @ ${base} (project ${projectId})`);
    console.log(`Model:           ${spec.model}`);
    console.log(`Bridge:          ${spec.args[eAt + 1]}`);
    console.log(`MCP config:      ${spec.env.TIPATASK_PI_MCP_CONFIG}\n`);

    const instruction = `Call the tool ${TOOL} exactly once with task_key "${taskKey}". `
      + 'Do not call any other tool and do not read or edit files. After the tool returns, reply with the single word DONE.';
    const args = [...spec.args.slice(0, -1), '--mode', 'json', instruction];

    const events = [];
    const stderr = [];
    const outcome = await new Promise((resolve) => {
      child = spawn(spec.command, args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      console.log(`Pi pid ${child.pid} (process group killed on timeout / Ctrl+C)`);
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        resolve({ timedOut: true });
      }, TURN_TIMEOUT_MS);
      let carry = '';
      child.stdout.on('data', (chunk) => {
        carry += chunk.toString('utf8');
        const lines = carry.split('\n');
        carry = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          events.push(event);
          if (opts.verbose && /^tool_execution_(start|end)$/.test(event.type)) console.log(`  ${event.type} ${event.toolName}`);
        }
      });
      child.stderr.on('data', (chunk) => { stderr.push(chunk.toString('utf8')); });
      child.on('error', (err) => { clearTimeout(timer); resolve({ error: err }); });
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });

    if (outcome.error) { notes.push(`spawn failed: ${outcome.error.message}`); return finish(3); }
    ran = events.length > 0;
    if (outcome.timedOut) notes.push(`timed out after ${TURN_TIMEOUT_MS / 1000}s`);
    else if (outcome.code !== 0) notes.push(`pi exited ${outcome.code}${outcome.signal ? ` (${outcome.signal})` : ''}`);

    const bridgeLines = stderr.join('').split('\n').filter(l => l.includes('[mcp-bridge]'));
    for (const l of bridgeLines) notes.push(l.trim());

    const starts = events.filter(e => e.type === 'tool_execution_start');
    const start = starts.find(e => e.toolName === TOOL && e.args && e.args.task_key === taskKey);
    checks.toolCalled = !!start;
    console.log(`tool_execution_start events: ${starts.map(e => e.toolName).join(', ') || 'none'}`);
    if (start) {
      const end = events.find(e => e.type === 'tool_execution_end' && e.toolCallId === start.toolCallId);
      const text = end ? resultText(end.result) : '';
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      const task = parsed && parsed.task;
      checks.taskResolved = !!(end && end.isError !== true && task && task.id === taskKey
        && String(parsed.project_id) === String(projectId) && task.title === expectedTitle);
      console.log(`tool_execution_end: ${end ? (end.isError ? 'error' : 'ok') : 'missing'} — ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
      if (!checks.taskResolved) notes.push('tool result is not the expected task JSON');
    } else {
      const last = events.filter(e => e.type === 'message_end').pop();
      if (last) console.log(`last assistant message: ${JSON.stringify(last.message).slice(0, 400)}`);
      const tail = stderr.join('').trim().split('\n').slice(-10).join('\n');
      if (tail) console.log(`pi stderr (tail):\n${tail}`);
    }
    if (!ran) return finish(3);
    return finish(checks.toolCalled && checks.taskResolved ? 0 : 1);
  } catch (err) {
    notes.push(`aborted: ${err.message}`);
    return finish(ran ? 1 : 3);
  }

  function finish(code) {
    cleanup();
    console.log(`\ntool-called  task-resolved  notes`);
    console.log([String(checks.toolCalled).padEnd(11), String(checks.taskResolved).padEnd(13), notes.join('; ')].join('  '));
    console.log(code === 0 ? '\nPASS — Pi called the bridged tipatask__get_task tool and got the task back.' : `\nFAIL (exit ${code})`);
    process.exit(code);
  }
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
