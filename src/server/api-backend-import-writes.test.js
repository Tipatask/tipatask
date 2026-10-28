'use strict';

// TPT9168 — the api-backend writes project import (project-archive.js) relies on:
// createTask/updateTask with { queueOffline: false } throw a network failure instead of
// queueing it (a queued create has no API key to remap dependencies to, and would replay
// later as a duplicate), createStatus forwards the canceled role, and createSprint forwards
// goal and dates. Real api-backend transport against a fake API server (same harness as
// api-backend-queue-replay.test.js). Never touches port 4455 or production.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-import-writes-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { writeAccountToken, clearAccountToken } = require('./account-store');

async function withFakeApiServer(state, run) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const pathname = req.url.split('?')[0];
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const parsed = body ? JSON.parse(body) : null;
      const isTaskWrite = (req.method === 'PATCH' && pathname.startsWith('/api/projects/1/tasks/'))
        || (req.method === 'POST' && pathname === '/api/projects/1/tasks');
      // `dropWrites`: kill the socket on a task write → ECONNRESET → networkError.
      if (isTaskWrite && state.dropWrites) { state.calls.push(`DROPPED ${req.method}`); req.socket.destroy(); return; }
      if (req.method === 'GET' && pathname === '/api/auth/me') return send(200, { user: { id: 7 } });
      if (req.method === 'POST' && pathname === '/api/projects/1/tasks') {
        state.calls.push('POST /tasks');
        return send(201, { task: { id: 2, project_id: 1, ...parsed, task_key: 'MNY9' } });
      }
      if (req.method === 'POST' && pathname === '/api/projects/1/statuses') {
        state.statusPosts.push(parsed);
        return send(201, { status: { id: 6, display_order: 5, ...parsed } });
      }
      if (req.method === 'POST' && pathname === '/api/projects/1/sprints') {
        state.sprintPosts.push(parsed);
        if (state.sprintNumbers.has(parsed.number)) return send(409, { error: 'Sprint number already exists in this project' });
        state.sprintNumbers.add(parsed.number);
        return send(201, { sprint: { id: 3, project_id: 1, status: 'active', ...parsed } });
      }
      state.unexpected.push(`${req.method} ${req.url}`);
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-import-writes-'));
  writeProjectConfig(projectRoot, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_PROJECT_ID: '1' });
  writeAccountToken(baseUrl, 'test-token');
  const backend = createApiBackend(null, projectRoot);
  backend.resetUserContext('test');
  try {
    await run(backend);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    clearAccountToken(baseUrl);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function baseState(overrides = {}) {
  return {
    calls: [], statusPosts: [], sprintPosts: [], unexpected: [],
    sprintNumbers: new Set(), dropWrites: false,
    ...overrides,
  };
}

const TASK = { title: 'Imported', description: 'd', category: 'CODING', status: 'pending', priority: 1, dependencies: [], tags: [], assignee: 1 };

test('createTask and updateTask with queueOffline:false throw a network failure and queue nothing', async () => {
  const state = baseState({ dropWrites: true });
  await withFakeApiServer(state, async (backend) => {
    await assert.rejects(backend.createTask(TASK, { queueOffline: false }), (err) => err.networkError === true);
    await assert.rejects(backend.updateTask('MNY1', { dependencies: ['MNY2'] }, { queueOffline: false }), (err) => err.networkError === true);
    assert.strictEqual(backend.getPendingMutationCount(), 0, 'nothing waits for a replay');
    assert.deepStrictEqual(state.calls, ['DROPPED POST', 'DROPPED PATCH'], 'both writes were really sent');

    // Without the option the same failure still queues an optimistic create.
    const optimistic = await backend.createTask(TASK);
    assert.ok(optimistic._tmpId);
    assert.strictEqual(backend.getPendingMutationCount(), 1);
    assert.deepStrictEqual(state.unexpected, []);
  });
});

test('createTask with queueOffline:false returns the API-allocated key when the API answers', async () => {
  const state = baseState();
  await withFakeApiServer(state, async (backend) => {
    const created = await backend.createTask(TASK, { queueOffline: false });
    assert.strictEqual(created.id, 'MNY9');
    assert.strictEqual(created._tmpId, undefined);
    assert.deepStrictEqual(state.calls, ['POST /tasks']);
  });
});

test('createStatus forwards the canceled role; createSprint forwards goal and dates', async () => {
  const state = baseState();
  await withFakeApiServer(state, async (backend) => {
    await backend.createStatus({ name: 'dropped', color: 'overlay0', is_workflow_canceled: true });
    assert.deepStrictEqual(state.statusPosts.at(-1), { name: 'dropped', color: 'overlay0', is_workflow_canceled: true });

    const sprint = await backend.createSprint('Sprint 3', 3, { goal: 'ship', start_date: '2026-11-02', end_date: '2026-11-13' });
    assert.deepStrictEqual(state.sprintPosts.at(-1), { name: 'Sprint 3', number: 3, goal: 'ship', start_date: '2026-11-02', end_date: '2026-11-13' });
    assert.strictEqual(sprint.number, 3);

    assert.strictEqual(await backend.createSprint('Again', 3), null, 'an existing number (409) resolves to null');
    assert.deepStrictEqual(state.sprintPosts.at(-1), { name: 'Again', number: 3 }, 'no extra fields unless given');
    assert.deepStrictEqual(state.unexpected, []);
  });
});
