'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-save-intent-'));
process.env.TIPATASK_USER_DATA = path.join(scratch, 'account');
const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

async function fixture(t) {
  const state = { rows: [{ id: 1, task_key: 'TST1', title: 'Original', description: 'Original description',
    category: 'CODING', status: 'pending', priority: 3, display_order: 1, tags: [], dependencies: [], assignee: 7 }], writes: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const route = req.url.split('?')[0];
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (route === '/api/auth/me') return send(200, { user: { id: 7 } });
    if (route === '/api/projects/1') return send(200, { project: { task_prefix: 'TST' } });
    if (route === '/api/projects/1/tags') return send(200, { tags: [] });
    if (req.method === 'GET' && route === '/api/projects/1/tasks') return send(200, { tasks: state.rows });
    if (req.method === 'POST' && route === '/api/projects/1/tasks/reserve') {
      const row = { id: state.rows.length + 1, task_key: `TST${state.rows.length + 1}`, title: 'New task',
        description: 'Reservation', status: 'pending', priority: 3, assignee: 7, is_reservation: true };
      state.rows.push(row);
      return send(201, { tasks: [row] });
    }
    const key = route.match(/^\/api\/projects\/1\/tasks\/([^/]+)$/)?.[1];
    const row = state.rows.find(r => r.task_key === key);
    if (req.method === 'GET' && key) return send(row ? 200 : 404, row ? { task: row } : { error: 'Missing task' });
    if (req.method === 'PATCH' && row) {
      state.writes.push({ key, body });
      Object.assign(row, body, { is_reservation: false });
      return send(200, { task: row });
    }
    if (req.method === 'POST' && route === '/api/projects/1/tasks') {
      const created = { id: state.rows.length + 1, task_key: `TST${state.rows.length + 1}`, ...body };
      state.rows.push(created);
      state.writes.push({ key: created.task_key, body });
      return send(201, { task: created });
    }
    send(500, { error: `Unexpected ${req.method} ${route}` });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = fs.mkdtempSync(path.join(scratch, 'project-'));
  writeProjectConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    API_PROJECT_ID: '1', API_TOKEN: 'test-token' });
  const backend = createApiBackend(null, root);
  t.after(async () => {
    backend.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const snapshot = JSON.parse(JSON.stringify(await backend.getTasksUnfiltered()));
  const save = data => backend.overwriteRawWithRemap('```json\n' + JSON.stringify(data) + '\n```');
  return { backend, state, snapshot, save };
}

test('new-task save never writes an untouched stale task, even from a warm list cache', async t => {
  const { state, snapshot, save } = await fixture(t);
  state.rows[0].status = 'completed';
  state.rows[0].title = 'Concurrent title';
  const task = { id: 'new-manual', title: 'New manual task', description: 'New description', status: 'pending', priority: 3 };
  await save({ tasks: [...snapshot, task], writeTaskIds: [task.id], taskBases: [] });
  assert.deepEqual(state.writes.map(w => w.key), ['TST2']);
  assert.equal(state.rows[0].status, 'completed');
  assert.equal(state.rows[0].title, 'Concurrent title');
});

test('modified card writes its own title without reverting concurrent status or description', async t => {
  const { state, snapshot, save } = await fixture(t);
  state.rows[0].status = 'completed';
  state.rows[0].description = 'Concurrent description';
  await save({ tasks: [{ ...snapshot[0], title: 'Accepted title' }], writeTaskIds: ['TST1'], taskBases: snapshot });
  assert.deepEqual(state.writes, [{ key: 'TST1', body: { title: 'Accepted title' } }]);
  assert.equal(state.rows[0].status, 'completed');
  assert.equal(state.rows[0].description, 'Concurrent description');
});

test('new tasks and existing reservations finalize without patching stale snapshot neighbors', async t => {
  const { backend, state, snapshot, save } = await fixture(t);
  const { keys } = await backend.reserveTaskKeys({ count: 1, category: 'CODING', priority: 3 });
  state.rows[0].status = 'completed';
  const reserved = { id: keys[0], title: 'Reserved content', description: 'Reserved description', status: 'pending', priority: 3 };
  const fresh = { ...reserved, id: 'new-objective', title: 'Fresh content' };
  const remap = await save({ tasks: [...snapshot, reserved, fresh], newTaskIds: [reserved.id, fresh.id],
    writeTaskIds: [reserved.id, fresh.id], taskBases: [] });
  assert.equal(remap.get(reserved.id), undefined, 'already-reserved key is retained');
  assert.equal(remap.get(fresh.id), 'TST3');
  assert.deepEqual(state.writes.map(w => w.key), ['TST2', 'TST3']);
  assert.equal(state.rows[0].status, 'completed');
  assert.equal(state.rows[1].title, reserved.title);
  assert.equal(state.rows[1].is_reservation, false);
});

test('unchanged fields, including deleted tags, are absent from an existing-task patch', async t => {
  const { state, snapshot, save } = await fixture(t);
  snapshot[0].tags = ['deleted-legacy-tag'];
  await save({ tasks: [{ ...snapshot[0], title: 'Title only', description: '' }], writeTaskIds: ['TST1'], taskBases: snapshot });
  assert.deepEqual(state.writes, [{ key: 'TST1', body: { title: 'Title only', description: '' } }]);
});

test('a reopen changed from a closed base and an explicit status choice remain writes', async t => {
  const { state, snapshot, save } = await fixture(t);
  snapshot[0].status = state.rows[0].status = 'completed';
  await save({ tasks: [{ ...snapshot[0], title: 'Revised', status: 'in_progress' }], writeTaskIds: ['TST1'], taskBases: snapshot });
  assert.deepEqual(state.writes[0].body, { title: 'Revised', status: 'in_progress' });
  await save({ tasks: [{ ...snapshot[0], status: 'canceled' }], writeTaskIds: ['TST1'], taskBases: snapshot });
  assert.deepEqual(state.writes[1].body, { status: 'canceled' });
});

test('metadata-free snapshots cannot overwrite existing rows; explicit edits require a base', async t => {
  const { state, snapshot, save } = await fixture(t);
  state.rows[0].status = 'completed';
  await save({ tasks: snapshot });
  assert.deepEqual(state.writes, []);
  await assert.rejects(save({ tasks: snapshot, writeTaskIds: ['TST1'] }), { code: 'TODO_PAYLOAD_INVALID' });
  assert.deepEqual(state.writes, []);
});

test('a deleted snapshot neighbor is ignored and an edited deleted target is never recreated', async t => {
  const { state, snapshot, save } = await fixture(t);
  state.rows = [];
  await save({ tasks: snapshot, writeTaskIds: [], taskBases: [] });
  await assert.rejects(save({ tasks: snapshot, writeTaskIds: ['TST1'], taskBases: snapshot }), { statusCode: 404 });
  assert.deepEqual(state.writes, []);
});
