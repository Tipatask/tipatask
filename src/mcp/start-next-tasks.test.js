'use strict';

// (TPT9163) start_next_tasks over the real stdio transport: the tipatask-local server
// (TIPATASK_MCP_LOCAL_ONLY=1) lists the tool, refuses clearly without the run token, and relays a
// cowboy-next decision from a stub Task App route. Real src/mcp/server.js child, scratch project,
// no API and no backend — the tool reads only TIPATASK_COWBOY_TOKEN/URL.
// (TPT9195) complete_task starts the chain itself: against a stub Tipatask API (VCS off, so no Git
// reads) its result carries the route's answer as cowboyNext, with no start_next_tasks call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const SERVER = path.join(__dirname, 'server.js');
const COWBOY_ENV = ['TIPATASK_COWBOY_TOKEN', 'TIPATASK_COWBOY_URL'];

async function connectLocal(t, cowboyEnv = {}, projectConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-start-next-'));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask/config.json'), JSON.stringify(projectConfig));
  const env = { ...process.env, TIPATASK_PROJECT_ROOT: root, TIPATASK_USER_DATA: root,
    TIPATASK_MCP_LOCAL_ONLY: '1', OBJECTIVE_TIMING_ENABLED: 'false' };
  for (const key of COWBOY_ENV) delete env[key];
  Object.assign(env, cowboyEnv);
  const client = new Client({ name: 'start-next-tasks-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, cwd: root, stderr: 'ignore' }));
  t.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return client;
}

test('tipatask-local lists start_next_tasks and refuses clearly without the run token', async (t) => {
  const client = await connectLocal(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(),
    ['batch_grep_tags', 'complete_task', 'git_worktree_status', 'pull_knowledge', 'push_knowledge', 'start_next_tasks']);
  const tool = tools.find(item => item.name === 'start_next_tasks');
  assert.deepEqual(tool.inputSchema.required, ['task_key']);
  assert.match(tool.description, /complete_task already asks Task App to start the next tasks of this chain/);
  assert.match(tool.description, /with this run's agent and model, and reports the answer as cowboyNext/);
  assert.match(tool.description, /only as a retry, once, when that answer's reason is `unavailable`/);
  assert.match(tool.description, /never start them yourself/);
  const complete = tools.find(item => item.name === 'complete_task');
  assert.match(complete.description, /In a cowboy chain run it then starts the chain's next tasks itself and reports them as cowboyNext: \{ started, reason, skipped \}/);
  assert.match(tool.description, /`skipped`: each candidate task that did not start, with its reason code/);

  const reply = await client.callTool({ name: 'start_next_tasks', arguments: { task_key: 'TPT1' } });
  assert.equal(reply.isError, true);
  const body = JSON.parse(reply.content[0].text);
  assert.deepEqual([body.ok, body.reason, body.started, body.skipped], [false, 'no_token', [], []]);
  assert.match(body.error, /TIPATASK_COWBOY_TOKEN is not set: start_next_tasks works only inside a cowboy chain run/);
});

test('start_next_tasks sends the run token to the run\'s own route and returns the started keys and skips', async (t) => {
  const hits = [];
  const skipped = [{ key: 'TPT4', reason: 'deps_open' }];
  const stub = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, token: req.headers['x-tipatask-run-token'] });
    const ok = req.method === 'POST' && req.url === '/api/tasks/TPT1/cowboy-next' && req.headers['x-tipatask-run-token'] === 'tok-123';
    res.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { started: ['TPT2', 'TPT3'], reason: 'dependents', skipped } : { error: 'Forbidden' }));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => stub.close(resolve)));
  const client = await connectLocal(t, {
    TIPATASK_COWBOY_TOKEN: 'tok-123',
    TIPATASK_COWBOY_URL: `http://127.0.0.1:${stub.address().port}/api/tasks/TPT1/cowboy-next`,
  });

  // The key is normalized like every other tool's (" tpt1" → TPT1).
  const reply = await client.callTool({ name: 'start_next_tasks', arguments: { task_key: ' tpt1' } });
  assert.notEqual(reply.isError, true, reply.content[0].text);
  assert.deepEqual(JSON.parse(reply.content[0].text), { ok: true, status: 200, started: ['TPT2', 'TPT3'], reason: 'dependents', skipped });
  assert.deepEqual(hits, [{ method: 'POST', url: '/api/tasks/TPT1/cowboy-next', token: 'tok-123' }]);
  assert.ok(!reply.content[0].text.includes('tok-123'), 'the token never comes back to the agent');

  const other = await client.callTool({ name: 'start_next_tasks', arguments: { task_key: 'TPT2' } });
  assert.equal(other.isError, true);
  assert.equal(JSON.parse(other.content[0].text).reason, 'wrong_task');
  assert.equal(hits.length, 1, 'another task\'s key is refused before any request');
});

// ── complete_task starts the chain (TPT9195) ──

const STATUSES = [
  { name: 'pending', is_workflow_start: 1 },
  { name: 'in_progress', is_in_progress: 1 },
  { name: 'completed', is_workflow_complete: 1 },
  { name: 'canceled', is_workflow_canceled: 1 },
];

// A stub Tipatask API for project 2 with one task, TPT1, and VCS off: just what complete_task's
// guard reads and writes (settings, task, statuses, comments, the status PATCH).
async function stubApi(t) {
  const state = { status: 'in_progress', comments: [], patches: [], hits: [] };
  const task = () => ({ id: 101, task_key: 'TPT1', project_id: 2, title: 'Chain head', description: '', category: 'CODING',
    status: state.status, priority: 5, display_order: 0, dependencies: [], tags: [] });
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = req.url.split('?')[0];
    state.hits.push(`${req.method} ${url}`);
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
    if (req.method === 'GET' && url === `${base}/tasks`) return send(200, { tasks: [task()] });
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
  return { state, config: { API_BASE_URL: `http://127.0.0.1:${server.address().port}`, API_PROJECT_ID: 2, API_TOKEN: 'account-token-1' } };
}

// A stub of the run's cowboy-next route that answers `reply` to the run token tok-123.
async function stubRoute(t, reply) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, token: req.headers['x-tipatask-run-token'] });
    const ok = req.method === 'POST' && req.url === '/api/tasks/TPT1/cowboy-next' && req.headers['x-tipatask-run-token'] === 'tok-123';
    res.writeHead(ok ? reply.status : 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? reply.body : { error: 'Forbidden' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { hits, env: { TIPATASK_COWBOY_TOKEN: 'tok-123', TIPATASK_COWBOY_URL: `http://127.0.0.1:${server.address().port}/api/tasks/TPT1/cowboy-next` } };
}

const REPORT = 'Changed the fixture. Checks passed. Follow-ups: none.';

test('complete_task in a cowboy run starts the chain itself and returns the started keys as cowboyNext', async (t) => {
  const api = await stubApi(t);
  const skipped = [{ key: 'TPT4', reason: 'deps_open' }];
  const route = await stubRoute(t, { status: 200, body: { started: ['TPT2', 'TPT3'], reason: 'dependents', skipped } });
  const client = await connectLocal(t, route.env, api.config);

  const reply = await client.callTool({ name: 'complete_task', arguments: { task_key: 'tpt1', resolution: REPORT } });
  assert.notEqual(reply.isError, true, reply.content[0].text);
  const body = JSON.parse(reply.content[0].text);
  assert.equal(body.completed, true);
  assert.equal(body.resolutionPosted, true);
  assert.deepEqual(body.cowboyNext, { started: ['TPT2', 'TPT3'], reason: 'dependents', skipped });
  assert.deepEqual(route.hits, [{ method: 'POST', url: '/api/tasks/TPT1/cowboy-next', token: 'tok-123' }],
    'one chain request with the run token, without any start_next_tasks call');
  assert.deepEqual(api.state.patches, [{ status: 'completed' }]);
  assert.deepEqual(api.state.comments.map(c => [c.content, c.type]), [[REPORT, 'resolution']]);
  assert.ok(!reply.content[0].text.includes('tok-123'), 'the run token never comes back to the agent');
});

test('a refused or failed chain request never fails a saved completion', async (t) => {
  const api = await stubApi(t);
  const route = await stubRoute(t, { status: 409, body: { started: [], reason: 'not_finished' } });
  const client = await connectLocal(t, route.env, api.config);

  const reply = await client.callTool({ name: 'complete_task', arguments: { task_key: 'TPT1', resolution: REPORT } });
  assert.notEqual(reply.isError, true, reply.content[0].text);
  const body = JSON.parse(reply.content[0].text);
  assert.equal(body.completed, true);
  assert.deepEqual(body.cowboyNext, { started: [], reason: 'not_finished', skipped: [],
    error: 'Task App does not see this task as complete. Nothing was started.' });
  assert.equal(route.hits.length, 1);
  assert.equal(api.state.status, 'completed');
});

test('complete_task outside a cowboy run makes no chain request and adds no cowboyNext', async (t) => {
  const api = await stubApi(t);
  const client = await connectLocal(t, {}, api.config);
  const reply = await client.callTool({ name: 'complete_task', arguments: { task_key: 'TPT1', resolution: REPORT } });
  assert.notEqual(reply.isError, true, reply.content[0].text);
  const body = JSON.parse(reply.content[0].text);
  assert.equal(body.completed, true);
  assert.ok(!Object.hasOwn(body, 'cowboyNext'), 'no cowboyNext without the run variables');
});
