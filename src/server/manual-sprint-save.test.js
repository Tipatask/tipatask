'use strict';

// (TPT624) Manual New Task save chain, end to end on the server side: the client's pinned
// POST /api/resolve-sprints, then PUT /api/todo, through the genuine api-backend.js into a
// throwaway fake Tipatask API. The explicit sprint pick must reach the POST /tasks body and
// come back on the board read. Never touches port 4455 or production.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-manual-sprint-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { writeAccountToken, clearAccountToken } = require('./account-store');
const { createHttpHandler } = require('./ws-handlers');

// Sprints 1-3 exist; the newest active work sits in sprint 3, older open work in sprint 1.
function apiRow(id, key, priority, status = 'pending') {
  return { id, project_id: 1, task_key: key, title: key, description: '', category: 'CODING', status, priority, display_order: 1, dependencies: [], assignee: 7 };
}

function makeServer(state) {
  return (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const pathname = req.url.split('?')[0];
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && pathname === '/api/auth/me') return send(200, { user: { id: 7 } });
      if (req.method === 'GET' && pathname === '/api/projects/1') return send(200, { project: { id: 1, task_prefix: 'TST' } });
      if (req.method === 'GET' && pathname === '/api/projects/1/tags') return send(200, { tags: [] });
      if (req.method === 'GET' && pathname === '/api/projects/1/tasks') return send(200, { tasks: state.rows });
      if (req.method === 'GET' && pathname === '/api/projects/1/sprints') return send(200, { sprints: state.sprints });
      if (req.method === 'POST' && pathname === '/api/projects/1/sprints') {
        const sprint = { id: state.sprints.length + 1, ...JSON.parse(body) };
        state.sprints.push(sprint);
        return send(201, { sprint });
      }
      if (req.method === 'POST' && pathname === '/api/projects/1/tasks') {
        const parsed = JSON.parse(body);
        state.posts.push(parsed);
        // TPT9004: creates arrive keyless — mirror the API and allocate the next TST key.
        const taskKey = parsed.task_key || `TST${100 + state.posts.length}`;
        const row = { ...apiRow(100 + state.posts.length, taskKey, parsed.priority), ...parsed, task_key: taskKey };
        state.rows.push(row);
        return send(201, { task: row });
      }
      return send(404, { error: 'not found' });
    });
  };
}

async function withChain(run) {
  const state = {
    rows: [apiRow(1, 'TST1', 1), apiRow(2, 'TST2', 3, 'in_progress')],
    sprints: [1, 2, 3].map(n => ({ id: n, name: `Sprint ${n}`, number: n })),
    posts: [],
  };
  const server = http.createServer(makeServer(state));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-manual-sprint-'));
  writeProjectConfig(projectRoot, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_PROJECT_ID: '1' });
  writeAccountToken(baseUrl, 'test-token');
  const backend = createApiBackend(null, projectRoot);
  backend.resetUserContext('test');
  const handler = createHttpHandler(new Map(), () => backend);
  const call = async (method, url, payload) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = { method, url, headers: {}, async *[Symbol.asyncIterator]() { yield body; } };
    const res = { writeHead(status) { this.status = status; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
    await handler(req, res);
    return res;
  };
  try {
    await run({ state, call, backend });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    clearAccountToken(baseUrl);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function manualTask(priority, extra = {}) {
  return { id: 'TST3', title: 'Manual', description: '', category: 'CODING', type: 'task', status: 'pending', priority, order: 1, dependencies: [], tags: [], assignee: 7, ...extra };
}

// Same two requests saveTaskChange() makes for a manual New Task (change._manual, pinned).
async function saveManual(call, task, pinned = [task.id]) {
  const resolve = await call('POST', '/api/resolve-sprints', { changes: [{ type: 'new', task }], pinned });
  if (resolve.status !== 200) return { resolve };
  const resolved = resolve.body.changes[0].task;
  const tasks = [resolved];
  const put = await call('PUT', '/api/todo', '# Tasks\n\n```json\n' + JSON.stringify({ tasks, newTaskPinnedIds: [] }, null, 2) + '\n```\n');
  return { resolve, resolved, put };
}

for (const [label, selected] of [['an older sprint while a newer one is active', 1], ['the middle sprint', 2], ['explicit Backlog', 0], ['+ New sprint', 4]]) {
  test(`manual save keeps ${label} through resolve, POST /tasks and the board read`, async () => {
    await withChain(async ({ state, call, backend }) => {
      const { resolved, put } = await saveManual(call, manualTask(selected));
      assert.equal(resolved.priority, selected, 'resolve-sprints keeps the pinned pick');
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.equal(state.posts.length, 1);
      assert.ok(!('task_key' in state.posts[0]), 'TPT9004: the manual create is keyless — the API allocates the key');
      assert.equal(state.posts[0].priority, selected, 'outgoing API row priority');
      if (selected === 4) assert.ok(state.sprints.some(s => s.number === 4), 'the new sprint record is created');
      const saved = (await backend.getTasksUnfiltered()).find(t => t.title === 'Manual');
      assert.equal(saved?.priority, selected, 'board read returns the saved sprint');
    });
  });
}

test('before the fix: an unpinned manual save was moved into the newest active sprint', async () => {
  await withChain(async ({ state, call }) => {
    const { resolved } = await saveManual(call, manualTask(1), []);
    assert.equal(resolved.priority, 3);
    assert.equal(state.posts[0].priority, 3);
  });
});

test('a pinned pick at or below a dependency sprint is refused with the conflict, not saved', async () => {
  await withChain(async ({ state, call }) => {
    const { resolve } = await saveManual(call, manualTask(2, { dependencies: ['TST2'] }));
    assert.equal(resolve.status, 422);
    assert.equal(resolve.body.error, 'step_dependency_conflict');
    assert.deepEqual(resolve.body.conflicts[0], { taskId: 'TST3', taskStep: 2, depId: 'TST2', depStep: 3 });
    assert.equal(state.posts.length, 0);
  });
});
