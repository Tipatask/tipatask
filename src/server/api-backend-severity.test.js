'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-severity-'));
process.env.TIPATASK_PROJECT_ROOT = path.join(temp, 'project');
process.env.TIPATASK_USER_DATA = path.join(temp, 'data');
const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { writeAccountToken } = require('./account-store');

// A stub API holding one row. `legacy` drops severity from every reply, like an API that
// predates the column.
function stubApi(state) {
  return http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const route = req.url.split('?')[0];
    const shape = row => {
      if (!state.legacy || !row) return row;
      const { severity, ...rest } = row;
      return rest;
    };
    const send = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (route === '/api/auth/me') return send({ user: { id: 7 } });
    if (route === '/api/projects/1/tags') return send({ tags: [] });
    if (req.method === 'GET') return send(route.endsWith('/tasks') ? { tasks: [shape(state.row)] } : { task: shape(state.row) });
    state.writes.push(body);
    if (req.method === 'PUT') return send({ tasks: body.tasks.map(shape) });
    state.row = { id: 1, task_key: 'SEV1', project_id: 1, severity: null, ...state.row, ...body };
    return send({ task: shape(state.row) });
  });
}

test('Task App maps severity through create, read, PATCH, bulk save and explicit clearing', async () => {
  const state = { row: null, writes: [], legacy: false };
  const server = stubApi(state);
  let backend;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    fs.mkdirSync(process.env.TIPATASK_PROJECT_ROOT, { recursive: true });
    writeProjectConfig(process.env.TIPATASK_PROJECT_ROOT, { TASK_BACKEND: 'api', API_BASE_URL: url, API_PROJECT_ID: '1' });
    writeAccountToken(url, 'test-token');
    backend = createApiBackend(null, process.env.TIPATASK_PROJECT_ROOT);

    const created = await backend.createTask({ title: 'Task', urgency: 2, severity: 4, priority: 406 });
    assert.equal(created.severity, 4);
    assert.equal(state.writes.at(-1).severity, 4);
    assert.equal((await backend.getTask(created.id)).severity, 4);
    for (const severity of [1, 2, 3, null]) {
      const updated = await backend.updateTask(created.id, { severity });
      assert.equal(state.writes.at(-1).severity, severity);
      assert.equal(updated.severity, severity);
      assert.equal(updated.urgency, 2, 'urgency stays');
    }
    await backend.updateTask(created.id, { severity: 3 });
    // A title-only edit never sends the field, so the API keeps the stored value.
    await backend.updateTask(created.id, { title: 'Renamed' });
    assert.equal(Object.hasOwn(state.writes.at(-1), 'severity'), false);
    assert.equal((await backend.getTask(created.id)).severity, 3);
    await backend.saveTasks([{ ...(await backend.getTask(created.id)), title: 'Bulk' }]);
    assert.equal(state.writes.at(-1).tasks[0].severity, 3, 'a bulk save carries the value it read');
    await backend.saveTasks([{ ...created, severity: null }]);
    assert.equal(state.writes.at(-1).tasks[0].severity, null, 'an explicit null clears it');
    assert.equal(created.priority, 406);
  } finally {
    backend?.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a row from an API without severity never sends one back', async () => {
  const state = { row: { id: 1, task_key: 'SEV1', project_id: 1, title: 'Old', status: 'pending', priority: 3, urgency: 1 }, writes: [], legacy: true };
  const server = stubApi(state);
  let backend;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    writeProjectConfig(process.env.TIPATASK_PROJECT_ROOT, { TASK_BACKEND: 'api', API_BASE_URL: url, API_PROJECT_ID: '1' });
    writeAccountToken(url, 'test-token');
    backend = createApiBackend(null, process.env.TIPATASK_PROJECT_ROOT);
    const task = await backend.getTask('SEV1');
    assert.equal(Object.hasOwn(task, 'severity'), false);
    await backend.saveTasks([{ ...task, title: 'Bulk' }]);
    assert.equal(Object.hasOwn(state.writes.at(-1).tasks[0], 'severity'), false,
      'omitted, so a newer API keeps whatever it stores');
  } finally {
    backend?.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
