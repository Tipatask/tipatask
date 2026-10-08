'use strict';

process.env.TASK_BACKEND = 'api';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// writeProjectConfig() routes API_TOKEN into the account store under TIPATASK_USER_DATA.
// Own user-data root: the test runner's shared one is rewritten concurrently by other files.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-split-origin-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));
const { createHttpHandler } = require('./ws-handlers');
const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');

function todoBody(data) {
  return '# Tasks\n\n```json\n' + JSON.stringify(data, null, 2) + '\n```\n';
}

async function save(data, backend) {
  const body = todoBody(data);
  const req = {
    method: 'PUT', url: '/api/todo', headers: {},
    async *[Symbol.asyncIterator]() { yield body; },
  };
  const res = {
    statusCode: null, body: '',
    writeHead(code) { this.statusCode = code; },
    end(text) { this.body = text || ''; },
  };
  await createHttpHandler(new Map(), () => backend)(req, res);
  return res;
}

function backendFixture() {
  const rows = [{ id: 'TPT42', isObjective: false }];
  const events = [];
  const backend = {
    async getTask(key) { return rows.find(t => t.id === key) || null; },
    async updateTask(key, fields) {
      events.push('patch:' + key);
      const row = rows.find(t => t.id === key);
      if (row) Object.assign(row, fields);
      return row || null;
    },
    async overwriteRawWithRemap(content) {
      events.push('save-children');
      const data = JSON.parse(content.match(/```json\s*\n([\s\S]*?)```/)[1]);
      assert.equal(data.splitOrigin, undefined);
      assert.equal(data.tasks[0].isObjective, true);
      rows.push(...data.tasks.filter(t => t.id !== 'TPT42').map(t => ({ ...t, parentDbId: 42 })));
      return new Map();
    },
    async getTasks() { return rows; },
    async getSprints() { return [{ number: 1 }]; },
    async createSprint(name, number) { return { name, number }; },
  };
  return { backend, events };
}

test('PUT /api/todo promotes split origin before saving children', async () => {
  const { backend, events } = backendFixture();
  const response = await save({
    tasks: [
      { id: 'TPT42', isObjective: false },
      { id: 'TPT43', title: 'First', status: 'pending', parentId: 'TPT42' },
      { id: 'TPT44', title: 'Second', status: 'pending', parentId: 'TPT42' },
    ],
    newTaskIds: ['TPT43', 'TPT44'],
    splitOrigin: { originKey: 'TPT42', childIds: ['TPT43', 'TPT44'] },
  }, backend);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(events, ['patch:TPT42', 'save-children']);
  const tasks = await backend.getTasks();
  assert.equal(tasks[0].isObjective, true);
  assert.deepEqual(tasks.slice(1).map(t => t.parentId), ['TPT42', 'TPT42']);
});

test('PUT /api/todo rejects split metadata whose child does not point to origin', async () => {
  const { backend, events } = backendFixture();
  const response = await save({
    tasks: [{ id: 'TPT43', parentId: 'TPT99' }],
    newTaskIds: ['TPT43'],
    splitOrigin: { originKey: 'TPT42', childIds: ['TPT43'] },
  }, backend);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(events, []);
});

test('split save persists is_objective and child parent_id through the REST backend', async () => {
  const rows = new Map([
    ['TPT42', { id: 42, project_id: 1, task_key: 'TPT42', title: 'Origin', description: 'Split me', category: 'CODING', status: 'pending', priority: 1, is_objective: 0, is_reservation: 0 }],
    ['TPT43', { id: 43, project_id: 1, task_key: 'TPT43', title: 'New task', description: 'Reserved', category: 'CODING', status: 'pending', priority: 1, is_reservation: 1 }],
    ['TPT44', { id: 44, project_id: 1, task_key: 'TPT44', title: 'New task', description: 'Reserved', category: 'CODING', status: 'pending', priority: 1, is_reservation: 1 }],
  ]);
  const writes = [];
  const api = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const endpoint = req.url.split('?')[0];
      const send = (code, data) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && endpoint === '/api/auth/me') return send(200, { user: { id: 1 } });
      if (req.method === 'GET' && endpoint === '/api/projects/1/tags') return send(200, { tags: [] });
      if (req.method === 'GET' && endpoint === '/api/projects/1/statuses') return send(200, { statuses: [{ name: 'pending', is_workflow_start: true }] });
      if (req.method === 'GET' && endpoint === '/api/projects/1/tasks') return send(200, { tasks: [...rows.values()] });
      const match = endpoint.match(/^\/api\/projects\/1\/tasks\/(TPT\d+)$/);
      if (match && req.method === 'GET') return rows.has(match[1]) ? send(200, { task: rows.get(match[1]) }) : send(404, { error: 'not found' });
      if (match && req.method === 'PATCH') {
        writes.push(match[1]);
        const row = rows.get(match[1]);
        if (!row) return send(404, { error: 'not found' });
        Object.assign(row, JSON.parse(body), { is_reservation: 0 });
        return send(200, { task: row });
      }
      return send(404, { error: `Unexpected ${req.method} ${endpoint}` });
    });
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-split-origin-'));
  try {
    writeProjectConfig(root, {
      TASK_BACKEND: 'api', API_BASE_URL: `http://127.0.0.1:${api.address().port}`,
      API_TOKEN: 'test-token', API_PROJECT_ID: '1',
    });
    const backend = createApiBackend(null, root);
    const response = await save({
      tasks: [
        { id: 'TPT42', title: 'Origin', description: 'Split me', category: 'CODING', status: 'pending', priority: 1, isObjective: false },
        { id: 'TPT43', title: 'First', description: 'Do first', category: 'CODING', status: 'pending', priority: 1, parentId: 'TPT42', tags: [] },
        { id: 'TPT44', title: 'Second', description: 'Do second', category: 'CODING', status: 'pending', priority: 1, parentId: 'TPT42', tags: [] },
      ],
      newTaskIds: ['TPT43', 'TPT44'],
      splitOrigin: { originKey: 'TPT42', childIds: ['TPT43', 'TPT44'] },
    }, backend);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(writes[0], 'TPT42');
    const saved = await backend.getTasksUnfiltered(); // GET /tasks
    assert.equal(saved.find(t => t.id === 'TPT42').isObjective, true);
    assert.deepEqual(saved.filter(t => t.id !== 'TPT42').map(t => t.parentDbId), [42, 42]);
  } finally {
    await new Promise(resolve => api.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
