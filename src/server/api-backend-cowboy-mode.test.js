'use strict';

// (TPT9161) cowboy_mode ↔ cowboyMode through api-backend.js against a stub API. The stub stores
// what it is sent; the bypass-only rule itself is the API's (cowboy-mode.integration.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cowboy-mode-'));
process.env.TIPATASK_USER_DATA = path.join(temp, 'data');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { writeAccountToken } = require('./account-store');

async function fixture(t) {
  const state = { writes: [], dropWrites: false, unexpected: [], rows: [{
    id: 1, project_id: 1, task_key: 'TST1', title: 'Task', description: 'Description',
    status: 'pending', category: 'CODING', priority: 1, assignee: 7,
    agent_permission_mode: 'bypass', cowboy_mode: 1,
  }] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const route = req.url.split('?')[0];
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (route === '/api/auth/me') return send(200, { user: { id: 7 } });
    if (route === '/api/projects/1/tags') return send(200, { tags: [] });
    if (req.method === 'GET' && route === '/api/projects/1/tasks') return send(200, { tasks: state.rows });
    const key = route.match(/^\/api\/projects\/1\/tasks\/([^/]+)$/)?.[1];
    if (req.method === 'GET' && key) return send(200, { task: state.rows.find(r => r.task_key === key) });
    if (route.startsWith('/api/projects/1/tasks') && ['POST', 'PATCH', 'PUT'].includes(req.method)) {
      if (state.dropWrites) { req.socket.destroy(); return; }
      state.writes.push({ method: req.method, body });
      if (req.method === 'PATCH') {
        const row = state.rows.find(r => r.task_key === key);
        Object.assign(row, body);
        return send(200, { task: row });
      }
      if (req.method === 'POST') {
        const row = { id: state.rows.length + 1, project_id: 1, cowboy_mode: false, ...body, task_key: `TST${state.rows.length + 1}` };
        state.rows.push(row);
        return send(201, { task: row });
      }
      return send(200, { tasks: body.tasks });
    }
    state.unexpected.push(`${req.method} ${route}`);
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
    assert.deepEqual(state.unexpected, []);
  });
  return { backend, state };
}

test('reads expose cowboyMode as a real boolean, off when the API predates the column', async t => {
  const { backend, state } = await fixture(t);
  const [listed] = await backend.getTasksUnfiltered();
  assert.equal(listed.cowboyMode, 'project');
  for (const [stored, expected] of [[1, 'project'], [true, 'project'], [0, 'disabled'], [false, 'disabled'], [null, 'disabled'], ['related', 'related'], ['project', 'project'], ['disabled', 'disabled']]) {
    state.rows[0].cowboy_mode = stored;
    assert.equal((await backend.getTask('TST1')).cowboyMode, expected);
  }
  delete state.rows[0].cowboy_mode;
  assert.equal((await backend.getTask('TST1')).cowboyMode, 'disabled');
});

test('creates send cowboy_mode only when the task carries it', async t => {
  const { backend, state } = await fixture(t);
  const plain = await backend.createTask({ title: 'Plain' });
  assert.equal(Object.hasOwn(state.writes.at(-1).body, 'cowboy_mode'), false);
  assert.equal(plain.cowboyMode, 'disabled');
  const on = await backend.createTask({ title: 'Cowboy', agentPermissionMode: 'bypass', cowboyMode: true });
  assert.equal(state.writes.at(-1).body.cowboy_mode, 'project');
  assert.equal(on.cowboyMode, 'project');
  await backend.createTask({ title: 'Snake', cowboy_mode: 0 });
  assert.equal(state.writes.at(-1).body.cowboy_mode, 'disabled');
});

test('updates forward both casings, leave an omitted flag alone and round-trip', async t => {
  const { backend, state } = await fixture(t);
  assert.equal((await backend.getTask('TST1')).cowboyMode, 'project');
  const off = await backend.updateTask('TST1', { cowboy_mode: false });
  assert.deepEqual(state.writes.at(-1).body, { cowboy_mode: 'disabled' });
  assert.equal(off.cowboyMode, 'disabled');
  assert.equal((await backend.getTask('TST1')).cowboyMode, 'disabled', 'a fetched task reads the saved value back');
  const on = await backend.updateTask('TST1', { cowboyMode: true });
  assert.deepEqual(state.writes.at(-1).body, { cowboy_mode: 'project' });
  assert.equal(on.cowboyMode, 'project');
  const renamed = await backend.updateTask('TST1', { title: 'Renamed' });
  assert.deepEqual(state.writes.at(-1).body, { title: 'Renamed' });
  assert.equal(renamed.cowboyMode, 'project');
  assert.equal((await backend.getTask('TST1')).cowboyMode, 'project');
});

test('bulk saves send the flag a row carries and omit it for a row without the field', async t => {
  const { backend, state } = await fixture(t);
  await backend.saveTasks([
    { id: 'TST1', title: 'On', cowboyMode: true },
    { id: 'TST2', title: 'Off', cowboyMode: false },
    { id: 'TST3', title: 'Old editor' },
    { id: 'TST4', title: 'Snake', cowboy_mode: 1 },
  ]);
  const [on, off, old, snake] = state.writes.at(-1).body.tasks;
  assert.equal(on.cowboy_mode, 'project');
  assert.equal(off.cowboy_mode, 'disabled');
  assert.equal(Object.hasOwn(old, 'cowboy_mode'), false, 'the API keeps the stored flag for an omitted field');
  assert.equal(snake.cowboy_mode, 'project');
  // A fetched row saved back unchanged keeps its value.
  const [fetched] = await backend.getTasksUnfiltered();
  await backend.saveTasks([fetched]);
  assert.equal(state.writes.at(-1).body.tasks[0].cowboy_mode, 'project');
});

test('snapshot saves detect a flag-only edit and never clear an untouched flag', async t => {
  const { backend, state } = await fixture(t);
  const save = async (tasks, taskBases) => {
    taskBases = taskBases || JSON.parse(JSON.stringify(await backend.getTasksUnfiltered()));
    await backend.overwriteRaw('```json\n' + JSON.stringify({ tasks, writeTaskIds: tasks.map(t => t.id), taskBases }) + '\n```');
  };
  let [task] = await backend.getTasksUnfiltered();
  await save([{ ...task }]);
  assert.equal(state.writes.length, 0, 'an unchanged flag alone is not an edit');
  await save([{ ...task, cowboyMode: false }]);
  assert.deepEqual(state.writes.at(-1).body, { cowboy_mode: 'disabled' });
  assert.equal(state.rows[0].cowboy_mode, 'disabled');
  [task] = await backend.getTasksUnfiltered();
  const { cowboyMode: _off, ...snake } = task;
  await save([{ ...snake, cowboy_mode: true }]);
  assert.deepEqual(state.writes.at(-1).body, { cowboy_mode: 'project' }, 'snake_case edits are detected too');
  const count = state.writes.length;
  [task] = await backend.getTasksUnfiltered();
  const { cowboyMode: _on, ...bare } = task;
  await save([{ ...bare, title: 'Retitled' }], [bare]);
  assert.deepEqual(state.writes.at(-1).body, { title: 'Retitled' }, 'an omitted flag is not an edit');
  await save([{ ...bare, title: 'Again', cowboyMode: false }], [bare]);
  assert.deepEqual(state.writes.at(-1).body, { title: 'Again' }, 'a base without the field counts as off');
  assert.equal(state.writes.length, count + 2);
  assert.equal(state.rows[0].cowboy_mode, 'project');
});

test('offline optimistic updates mirror the flag and replay it', async t => {
  const { backend, state } = await fixture(t);
  await backend.getTasksUnfiltered();
  state.dropWrites = true;
  assert.equal((await backend.updateTask('TST1', { cowboy_mode: false })).cowboyMode, 'disabled');
  assert.equal((await backend.updateTask('TST1', { title: 'Offline' })).cowboyMode, 'disabled');
  assert.equal((await backend.updateTask('TST9', { cowboyMode: 1 })).cowboyMode, 'project', 'an uncached row returns the camelCase boolean');
  state.dropWrites = false;
  state.rows.push({ id: 9, project_id: 1, task_key: 'TST9', title: 'Nine', status: 'pending', cowboy_mode: false });
  await backend._drainPendingMutationsForTest();
  assert.equal(backend.getPendingMutationCount(), 0);
  assert.equal(state.rows[0].cowboy_mode, 'disabled');
  assert.equal(state.rows[1].cowboy_mode, 'project');
  assert.deepEqual(state.writes.map(w => w.body), [{ cowboy_mode: 'disabled' }, { title: 'Offline' }, { cowboy_mode: 'project' }]);
});


test('fresh chain reads bypass cached rows and scope-only related edits survive snapshots', async t => {
  const { backend, state } = await fixture(t);
  await backend.getTasksUnfiltered();
  state.rows[0].cowboy_mode = 'related';
  assert.equal((await backend.getTasksUnfiltered({ refresh: true }))[0].cowboyMode, 'related');
  const saved = await backend.updateTask('TST1', { cowboyMode: 'related' });
  assert.equal(saved.cowboyMode, 'related');
  assert.equal((await backend.getTask('TST1')).cowboyMode, 'related');
});
