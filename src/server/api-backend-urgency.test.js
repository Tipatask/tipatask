'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-urgency-'));
process.env.TIPATASK_PROJECT_ROOT = path.join(temp, 'project');
process.env.TIPATASK_USER_DATA = path.join(temp, 'data');
const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { writeAccountToken } = require('./account-store');

test('Task App maps urgency through create, read, PATCH, bulk save and explicit clearing', async () => {
  let row;
  const writes = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const route = req.url.split('?')[0];
    const send = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (route === '/api/auth/me') return send({ user: { id: 7 } });
    if (route === '/api/projects/1/tags') return send({ tags: [] });
    if (req.method === 'GET') return send(route.endsWith('/tasks') ? { tasks: [row] } : { task: row });
    writes.push(body);
    if (req.method === 'PUT') return send({ tasks: body.tasks });
    row = { id: 1, task_key: 'URG1', project_id: 1, ...row, ...body };
    return send({ task: row });
  });
  let backend;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    fs.mkdirSync(process.env.TIPATASK_PROJECT_ROOT, { recursive: true });
    writeProjectConfig(process.env.TIPATASK_PROJECT_ROOT, { TASK_BACKEND: 'api', API_BASE_URL: url, API_PROJECT_ID: '1' });
    writeAccountToken(url, 'test-token');
    backend = createApiBackend(null, process.env.TIPATASK_PROJECT_ROOT);
    const created = await backend.createTask({ title: 'Task', urgency: 4, priority: 406 });
    assert.equal(created.urgency, 4);
    assert.equal(writes.at(-1).urgency, 4);
    assert.equal((await backend.getTask(created.id)).urgency, 4);
    await backend.updateTask(created.id, { title: 'Renamed' });
    assert.equal(Object.hasOwn(writes.at(-1), 'urgency'), false);
    await backend.saveTasks([{ ...created, urgency: 2 }]);
    assert.equal(writes.at(-1).tasks[0].urgency, 2);
    const cleared = await backend.updateTask(created.id, { urgency: 0 });
    assert.equal(cleared.urgency, 0);
    assert.equal(writes.at(-1).urgency, 0);
    assert.equal(cleared.priority, 406);
  } finally {
    backend?.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
