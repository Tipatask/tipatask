'use strict';
// (TPT9417) The API's task edit rule (TPT9415) reaches the Task App: fromApi() maps every row's
// can_edit to canEdit (only when the API sent it), no write ever sends it back, a refused write
// carries the code task_role_rank, and the local HTTP task routes keep that refusal's 403 and code.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-can-edit-'));
process.env.TIPATASK_PROJECT_ROOT = path.join(temp, 'project');
process.env.TIPATASK_USER_DATA = path.join(temp, 'data');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { writeAccountToken } = require('./account-store');

const REFUSAL = { error: 'forbidden', reason: 'task_role_rank' };

// A stub API for project 1. Rows carry can_edit unless `legacy`; a PATCH or DELETE of a row in
// `refuse` answers the rule's 403.
async function fixture(t, { legacy = false } = {}) {
  const state = {
    rows: [
      { id: 1, task_key: 'OWN1', project_id: 1, title: 'Mine', status: 'pending', priority: 3, assignee: 7, created_by: 7, can_edit: true },
      { id: 2, task_key: 'PEER2', project_id: 1, title: 'Peer', status: 'pending', priority: 3, assignee: 9, created_by: 9, can_edit: false },
    ],
    writes: [],
    refuse: new Set(['PEER2']),
  };
  const shape = row => {
    if (!legacy) return row;
    const { can_edit, ...rest } = row;
    return rest;
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const route = req.url.split('?')[0];
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (route === '/api/auth/me') return send(200, { user: { id: 7 } });
    if (route === '/api/projects/1/tags') return send(200, { tags: [] });
    if (route === '/api/projects/1/sprints') return send(200, { sprints: [] });
    if (req.method === 'GET' && route === '/api/projects/1/tasks') return send(200, { tasks: state.rows.map(shape) });
    const key = route.match(/^\/api\/projects\/1\/tasks\/([^/]+)$/)?.[1];
    if (req.method === 'GET' && key) return send(200, { task: shape(state.rows.find(r => r.task_key === key)) });
    if (route.startsWith('/api/projects/1/tasks') && ['PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      state.writes.push({ method: req.method, key, body });
      if (key && state.refuse.has(key)) return send(403, req.method === 'DELETE' ? { ...REFUSAL, blocked_by: [key] } : REFUSAL);
      if (req.method === 'DELETE') return send(200, { ok: true });
      if (req.method === 'PATCH') {
        const row = state.rows.find(r => r.task_key === key);
        Object.assign(row, body);
        return send(200, { task: shape(row) });
      }
      return send(200, { tasks: body.tasks.map(shape) });
    }
    send(404, { error: 'Unexpected request' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = fs.mkdtempSync(path.join(temp, 'project-'));
  writeProjectConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_PROJECT_ID: '1' });
  writeAccountToken(baseUrl, 'test-token');
  const backend = createApiBackend(null, root);
  t.after(async () => {
    backend.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { backend, state };
}

test('every read maps can_edit to canEdit, and no write sends it back', async t => {
  const { backend, state } = await fixture(t);
  assert.equal((await backend.getTask('OWN1')).canEdit, true);
  assert.equal((await backend.getTask('PEER2')).canEdit, false);
  const list = await backend.getTasksUnfiltered();
  assert.deepEqual(list.map(row => [row.id, row.canEdit]), [['OWN1', true], ['PEER2', false]]);
  const board = await backend.getBoardTasks({});
  assert.deepEqual(board.tasks.map(row => [row.id, row.canEdit]), [['OWN1', true], ['PEER2', false]]);
  const updated = await backend.updateTask('OWN1', { title: 'Renamed' });
  assert.equal(updated.canEdit, true, 'a PATCH answer carries the fresh flag');
  for (const write of state.writes) {
    assert.equal(Object.hasOwn(write.body || {}, 'can_edit'), false, 'a PATCH never sends can_edit');
    assert.equal(Object.hasOwn(write.body || {}, 'canEdit'), false);
  }
  await backend.saveTasks(list);
  const put = state.writes.at(-1);
  assert.equal(put.method, 'PUT');
  for (const row of put.body.tasks) {
    assert.equal(Object.hasOwn(row, 'can_edit'), false, 'a bulk save never sends can_edit');
    assert.equal(Object.hasOwn(row, 'canEdit'), false);
  }
});

test('a row from an API without can_edit has no canEdit key', async t => {
  const { backend } = await fixture(t, { legacy: true });
  assert.equal(Object.hasOwn(await backend.getTask('PEER2'), 'canEdit'), false);
  for (const row of await backend.getTasksUnfiltered()) assert.equal(Object.hasOwn(row, 'canEdit'), false);
});

test('a write the rule refuses rejects with code task_role_rank and keeps the session connected', async t => {
  const { backend } = await fixture(t);
  await backend.init();
  assert.equal(backend.getConnectionState(), 'connected');
  await assert.rejects(backend.updateTask('PEER2', { status: 'completed' }), (err) => {
    assert.equal(err.statusCode, 403);
    assert.equal(err.code, 'task_role_rank');
    assert.deepEqual(err.body, REFUSAL);
    assert.equal(err.networkError, undefined);
    return true;
  });
  await assert.rejects(backend.deleteTask('PEER2'), (err) => err.code === 'task_role_rank' && err.statusCode === 403);
  assert.equal(backend.getConnectionState(), 'connected');
});

// The local HTTP routes the browser-mode board uses (api-client.js _http()).
async function callRoute(handler, method, url, body) {
  const req = { method, url, headers: {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
  const res = { writeHead(status) { this.status = status; }, end(text) { this.body = text; } };
  await handler(req, res);
  return { status: res.status, body: JSON.parse(res.body) };
}

test('the HTTP task routes return canEdit and keep the rule refusal as 403 with its code', async () => {
  const { createHttpHandler } = require('./ws-handlers');
  const refusal = () => Object.assign(new Error(`API 403: ${JSON.stringify(REFUSAL)}`), { statusCode: 403, code: 'task_role_rank', body: REFUSAL, forbidden: true });
  const backend = {
    getStatuses: async () => [],
    updateTask: async (id, fields) => {
      if (id === 'PEER2') throw refusal();
      if (id === 'BROKEN') throw new Error('boom');
      return { id, status: fields.status, priority: 3, canEdit: id !== 'GAVEAWAY' };
    },
    deleteTask: async (id) => {
      if (id === 'PEER2') throw refusal();
      return true;
    },
  };
  const handler = createHttpHandler(new Map(), () => backend);

  const own = await callRoute(handler, 'PATCH', '/api/tasks/OWN1', { status: 'completed' });
  assert.equal(own.status, 200);
  assert.equal(own.body.canEdit, true);
  // A write that leaves the task view only (a reassignment) answers the fresh flag.
  assert.equal((await callRoute(handler, 'PATCH', '/api/tasks/GAVEAWAY', { status: 'pending' })).body.canEdit, false);

  const refused = await callRoute(handler, 'PATCH', '/api/tasks/PEER2', { status: 'completed' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'task_role_rank');
  const removed = await callRoute(handler, 'DELETE', '/api/tasks/PEER2');
  assert.equal(removed.status, 403);
  assert.equal(removed.body.code, 'task_role_rank');

  // Any other failure keeps its 500 and carries no code.
  const broken = await callRoute(handler, 'PATCH', '/api/tasks/BROKEN', { status: 'completed' });
  assert.equal(broken.status, 500);
  assert.deepEqual(broken.body, { error: 'boom' });
});
