'use strict';

// (TPT9195) `tt complete` starts the cowboy chain itself. The real CLI (src/cli/task-tools.js) runs
// as Pi's `tt` does: its completion guard talks to a stub Tipatask API (VCS off, so no Git reads),
// and with the run's TIPATASK_COWBOY_TOKEN/URL it reaches the real run-token guard, the real
// createHttpHandler() route and launchCowboyChain() served from this process. The decision comes
// back in the printed result as cowboyNext; a later `tt next` is the repeat Task App refuses.
// Offline: stub backends, nothing starts (the decision is 'none').

process.env.TASK_BACKEND = 'api';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createLocalAccess, LOCAL_HOST } = require('./local-access');
const { createHttpHandler } = require('./ws-handlers');
const { cowboyRunTokens, COWBOY_TOKEN_ENV, COWBOY_URL_ENV } = require('./terminal-session');

const CLI = path.join(__dirname, '../cli/task-tools.js');
const TOKEN = 'complete-chain-run-token';
const REPORT = 'Changed the fixture. Checks passed. Follow-ups: none.';
const STATUSES = [
  { name: 'pending', is_workflow_start: 1 },
  { name: 'in_progress', is_in_progress: 1 },
  { name: 'completed', is_workflow_complete: 1 },
  { name: 'canceled', is_workflow_canceled: 1 },
];

function row(id, fields = {}) {
  return { id, title: `Task ${id}`, description: `Do ${id}.`, status: 'pending', category: 'CODING', priority: 5, order: 0,
    dependencies: [], assignee: 1, agentAssignee: 'claude', agentPermissionMode: null, claudeDesignMode: false,
    isObjective: false, isReservation: false, tags: [], ...fields };
}

// A stub Tipatask API for project 2 with one task, TPT1: what the CLI's completion guard reads and
// writes (effective settings with VCS off, task, statuses, comments, the status PATCH).
async function stubApi(t) {
  const state = { status: 'in_progress', comments: [], patches: [] };
  const task = () => ({ id: 101, task_key: 'TPT1', project_id: 2, title: 'Chain head', description: '', category: 'CODING',
    status: state.status, priority: 5, display_order: 0, dependencies: [], tags: [] });
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = req.url.split('?')[0];
    const send = (status, json) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    const base = '/api/projects/2';
    if (req.method === 'GET' && url === base) return send(200, { project: { id: 2, name: 'Scratch' } });
    if (req.method === 'GET' && url === `${base}/settings`) {
      return send(200, { settings: { vcs_type: null, vcs_worktree_enabled: 0, vcs_commit_enabled: 0, vcs_pr_enabled: 0, vcs_merge_enabled: 0 },
        source: 'global', is_creator: true });
    }
    if (req.method === 'GET' && url === `${base}/statuses`) return send(200, { statuses: STATUSES });
    if (url === `${base}/tasks/TPT1` && req.method === 'GET') return send(200, { task: task() });
    if (url === `${base}/tasks/TPT1` && req.method === 'PATCH') {
      const patch = JSON.parse(body);
      state.patches.push(patch);
      if (patch.status) state.status = patch.status;
      return send(200, { task: task() });
    }
    if (url === `${base}/tasks/TPT1/comments` && req.method === 'GET') return send(200, { comments: state.comments });
    if (url === `${base}/tasks/TPT1/comments` && req.method === 'POST') {
      const comment = { id: state.comments.length + 1, ...JSON.parse(body) };
      state.comments.push(comment);
      return send(201, { comment });
    }
    return send(404, { error: 'Not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

// The real cowboy-next route behind the real run-token guard, for a live cowboy run of TPT1 whose
// task the Task App backend already reads as complete.
async function realRoute(t) {
  const root = '/projects/cowboy-complete';
  const sessions = new Map([[`TPT1\0${root}`, { type: 'terminal', alive: true, tabId: 'TPT1', taskId: 'TPT1', projectPath: root,
    cowboyChain: true, _cowboyToken: TOKEN, _cowboyNext: null, permissionPolicy: { mode: 'bypass' }, _completionEmitted: true }]]);
  const tasks = [row('TPT1', { status: 'completed' }), row('TPT2', { status: 'in_progress' })];
  const backend = {
    async getTasksUnfiltered() { return tasks; },
    async getTask(id) { const found = tasks.find(task => task.id === id); return found ? { ...found } : null; },
    async getStatuses() { return STATUSES; },
    async getEffectiveProjectSettings() { return { settings: { agent_permission_mode: 'bypass' } }; },
    async getCurrentUserId() { return 1; },
  };
  const handler = createHttpHandler(sessions, () => backend, { getBackendForPath: () => backend });
  let access;
  const server = http.createServer((req, res) => access.guardHttp(req, res, handler));
  await new Promise(resolve => server.listen(0, LOCAL_HOST, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  access = createLocalAccess({ port, getActiveProjectPath: () => root, liveRunTokens: key => cowboyRunTokens(sessions, key) });
  return { sessions, url: `http://${LOCAL_HOST}:${port}/api/tasks/TPT1/cowboy-next` };
}

// Runs the CLI as Pi's `tt` does, in a scratch project pointed at the stub API.
function tt(t, args, { baseUrl, cowboyEnv = {}, input = '' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-complete-chain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask/config.json'),
    JSON.stringify({ API_BASE_URL: baseUrl, API_PROJECT_ID: 2, API_TOKEN: 'account-token-1' }));
  const env = { ...process.env, TIPATASK_PROJECT_ROOT: root, TIPATASK_USER_DATA: root };
  delete env[COWBOY_TOKEN_ENV];
  delete env[COWBOY_URL_ENV];
  Object.assign(env, cowboyEnv);
  return new Promise(resolve => {
    const child = execFile(process.execPath, [CLI, ...args], { env, cwd: root, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

test('tt complete in a cowboy run starts the chain and prints the decision; a repeat tt next answers already_launched', async (t) => {
  const api = await stubApi(t);
  const route = await realRoute(t);
  const cowboyEnv = { [COWBOY_TOKEN_ENV]: TOKEN, [COWBOY_URL_ENV]: route.url };

  const done = await tt(t, ['complete', 'TPT1'], { baseUrl: api.baseUrl, cowboyEnv, input: REPORT });
  assert.equal(done.code, 0, done.stderr);
  const result = JSON.parse(done.stdout);
  assert.equal(result.completed, true);
  const skipped = [{ key: 'TPT2', reason: 'status' }];
  assert.deepEqual(result.cowboyNext, { started: [], reason: 'none', skipped });
  assert.deepEqual(route.sessions.get('TPT1\0/projects/cowboy-complete')._cowboyNext, { started: [], reason: 'none', skipped },
    'Task App recorded the run\'s one decision');
  assert.deepEqual(api.state.patches, [{ status: 'completed' }]);
  assert.deepEqual(api.state.comments.map(c => [c.content, c.type]), [[REPORT, 'resolution']]);
  assert.ok(!done.stdout.includes(TOKEN) && !done.stderr.includes(TOKEN), 'the run token is never printed');

  const repeat = await tt(t, ['next', 'TPT1'], { baseUrl: api.baseUrl, cowboyEnv });
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.deepEqual(JSON.parse(repeat.stdout), { ok: true, status: 200, started: [], reason: 'already_launched', skipped: [],
    previous: { started: [], reason: 'none', skipped } });
});

test('tt complete keeps a saved completion and exits 0 when the chain request fails', async (t) => {
  const api = await stubApi(t);
  // A closed port: nothing answers the chain request.
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, LOCAL_HOST, resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const cowboyEnv = { [COWBOY_TOKEN_ENV]: TOKEN, [COWBOY_URL_ENV]: `http://${LOCAL_HOST}:${port}/api/tasks/TPT1/cowboy-next` };

  const done = await tt(t, ['complete', 'TPT1'], { baseUrl: api.baseUrl, cowboyEnv, input: REPORT });
  assert.equal(done.code, 0, done.stderr);
  const result = JSON.parse(done.stdout);
  assert.equal(result.completed, true);
  assert.deepEqual([result.cowboyNext.reason, result.cowboyNext.started, result.cowboyNext.skipped], ['unreachable', [], []]);
  assert.match(result.cowboyNext.error, /Could not reach Task App/);
  assert.equal(api.state.status, 'completed');
  assert.ok(!done.stdout.includes(TOKEN), 'the run token is never printed');
});

test('tt complete outside a cowboy run prints no cowboyNext', async (t) => {
  const api = await stubApi(t);
  const done = await tt(t, ['complete', 'TPT1'], { baseUrl: api.baseUrl, input: REPORT });
  assert.equal(done.code, 0, done.stderr);
  const result = JSON.parse(done.stdout);
  assert.equal(result.completed, true);
  assert.ok(!Object.hasOwn(result, 'cowboyNext'));
});
