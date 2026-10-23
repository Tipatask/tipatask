'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-permission-mode-'));
process.env.TIPATASK_USER_DATA = path.join(temp, 'data');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { writeAccountToken } = require('./account-store');

async function fixture(t) {
  const state = { writes: [], dropWrites: false, unexpected: [], rows: [{
    id: 1, project_id: 1, task_key: 'TST1', title: 'Task', description: 'Description',
    status: 'pending', category: 'CODING', priority: 1, assignee: 7,
    agent_permission_mode: 'accept_edits',
  }] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const route = req.url.split('?')[0];
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (route === '/api/auth/me') return send(200, { user: { id: 7 } });
    if (route === '/api/projects/1') return send(200, { project: { id: 1, task_prefix: 'TST' } });
    if (route === '/api/projects/1/settings') return send(200, { settings: { agent_permission_mode: 'bypass' }, source: 'global', is_creator: true });
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
        const row = { id: state.rows.length + 1, project_id: 1, agent_permission_mode: null, ...body, task_key: `TST${state.rows.length + 1}` };
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

test('task create/read/update/bulk mappings retain modes, null and omission', async t => {
  const { backend, state } = await fixture(t);
  const inherited = await backend.createTask({ title: 'Inherited' });
  assert.equal(inherited.agentPermissionMode, null);
  assert.equal(Object.hasOwn(state.writes.at(-1).body, 'agent_permission_mode'), false);
  for (const mode of ['plan', 'always_ask', 'accept_edits', 'auto', 'bypass', null]) {
    const created = await backend.createTask({ title: 'Configured', agentPermissionMode: mode });
    assert.equal(created.agentPermissionMode, mode);
    assert.equal((await backend.getTask(created.id)).agentPermissionMode, mode);
    assert.equal((await backend.updateTask('TST1', { agentPermissionMode: mode })).agentPermissionMode, mode);
    assert.equal((await backend.updateTask('TST1', { title: 'Renamed' })).agentPermissionMode, mode);
    assert.equal(Object.hasOwn(state.writes.at(-1).body, 'agent_permission_mode'), false);
    assert.equal((await backend.updateTask('TST1', { agent_permission_mode: mode })).agentPermissionMode, mode);
    await backend.saveTasks([{ id: 'TST1', title: 'Bulk', agentPermissionMode: mode }]);
    assert.equal(state.writes.at(-1).body.tasks[0].agent_permission_mode, mode);
  }
  await backend.saveTasks([{ id: 'TST1', title: 'Old editor' }]);
  assert.equal(Object.hasOwn(state.writes.at(-1).body.tasks[0], 'agent_permission_mode'), false);
  delete state.rows[0].agent_permission_mode;
  assert.equal((await backend.getTask('TST1')).agentPermissionMode, null, 'old API response keeps the legacy fallback');
});

test('proposal diff detects mode-only edits while missing fields preserve stored overrides', async t => {
  const { backend, state } = await fixture(t);
  const save = tasks => backend.overwriteRaw('```json\n' + JSON.stringify({ tasks }) + '\n```');
  let [task] = await backend.getTasksUnfiltered();
  delete task.agentPermissionMode;
  await save([task]);
  assert.equal(state.writes.length, 0, 'omitted mode alone must not make the task dirty');
  await save([{ ...task, title: 'Changed title' }]);
  assert.equal(state.rows[0].agent_permission_mode, 'accept_edits');
  assert.equal(Object.hasOwn(state.writes.at(-1).body, 'agent_permission_mode'), false);
  [task] = await backend.getTasksUnfiltered();
  for (const mode of ['auto', null, 'bypass']) {
    await save([{ ...task, agentPermissionMode: mode }]);
    assert.equal(state.writes.at(-1).body.agent_permission_mode, mode);
    assert.equal(state.rows[0].agent_permission_mode, mode);
  }
  [task] = await backend.getTasksUnfiltered();
  delete task.agentPermissionMode;
  await save([{ ...task, agent_permission_mode: 'plan' }]);
  assert.equal(state.rows[0].agent_permission_mode, 'plan');
});

test('offline optimistic updates and replay preserve explicit modes and resets', async t => {
  const { backend, state } = await fixture(t);
  await backend.getTasksUnfiltered();
  state.dropWrites = true;
  assert.equal((await backend.updateTask('TST1', { agent_permission_mode: 'auto' })).agentPermissionMode, 'auto');
  assert.equal((await backend.updateTask('TST1', { title: 'Offline' })).agentPermissionMode, 'auto');
  assert.equal((await backend.updateTask('TST1', { agentPermissionMode: null })).agentPermissionMode, null);
  state.dropWrites = false;
  await backend._drainPendingMutationsForTest();
  assert.equal(backend.getPendingMutationCount(), 0);
  assert.equal(state.rows[0].agent_permission_mode, null);
  assert.deepEqual(state.writes.map(w => w.body), [
    { agent_permission_mode: 'auto' }, { title: 'Offline' }, { agent_permission_mode: null },
  ]);
});
