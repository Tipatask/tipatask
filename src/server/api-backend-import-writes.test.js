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
        const reply = state.sprintReplies.shift();
        if (reply) return send(reply.status, reply.data);
        if (state.sprintNumbers.has(parsed.number)) return send(409, { error: 'Sprint number already exists in this project' });
        state.sprintNumbers.add(parsed.number);
        return send(201, { sprint: { id: 3, project_id: 1, status: 'active', ...parsed } });
      }
      if (req.method === 'GET' && pathname === '/api/projects/1/sprints') return send(200, { sprints: state.sprints || [] });
      if (req.method === 'PATCH' && pathname === '/api/projects/1/sprints/3') {
        state.sprintPatches.push(parsed);
        if (state.sprintConflict) return send(409, { error: 'sprint_dates_changed' });
        return send(200, { sprint: { id: 3, number: 3, ...parsed } });
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
    calls: [], statusPosts: [], sprintPosts: [], sprintPatches: [], unexpected: [],
    sprintNumbers: new Set(), sprintReplies: [], dropWrites: false,
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
    assert.deepStrictEqual(state.sprintPosts.at(-1), { name: 'Sprint 3', number: 3, goal: 'ship', start_date: '2026-11-02', end_date: '2026-11-13', date_source: 'auto' });
    assert.strictEqual(sprint.number, 3);
    assert.strictEqual(sprint.date_source, 'auto');

    assert.strictEqual(await backend.createSprint('Again', 3), null, 'an existing number (409) resolves to null');
    assert.deepStrictEqual(state.sprintPosts.at(-1), { name: 'Again', number: 3, auto_dates: true });
    assert.deepStrictEqual(state.unexpected, []);
  });
});

test('sprint forecasts re-read rows, patch automatic dates only, and tolerate a concurrent write', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const dates = { start_date: today, end_date: today, rationale: 'one day' };
  const state = baseState({ sprints: [{ id: 3, number: 3, status: 'active' }] });
  await withFakeApiServer(state, async backend => {
    assert.ok(backend.getProjectRoot().includes('tipatask-import-writes-'));
    assert.strictEqual((await backend.applySprintForecast(3, dates)).date_source, 'auto');
    assert.deepStrictEqual(state.sprintPatches, [{ start_date: today, end_date: today, date_source: 'auto', only_if_undated: true }]);
    for (const fields of [{ start_date: today, date_source: 'manual' }, { end_date: today, date_source: 'auto' },
      { status: 'closed' }, { date_source: 'manual' }]) {
      state.sprints = [{ id: 3, number: 3, status: 'active', ...fields }];
      assert.strictEqual(await backend.applySprintForecast(3, dates), null);
    }
    assert.strictEqual(state.sprintPatches.length, 1, 'dated/manual/closed sprints never PATCH');
    state.sprints = [{ id: 3, number: 3, status: 'active' }];
    state.sprintConflict = true;
    assert.strictEqual(await backend.applySprintForecast(3, dates), null);
    assert.strictEqual(state.sprintPatches.length, 2);
    assert.strictEqual(backend.getPendingMutationCount(), 0);
  });
});

test('createSprint requests automatic dates unless both dates are supplied', async () => {
  const state = baseState();
  await withFakeApiServer(state, async (backend) => {
    const extras = [undefined, {}, { start_date: '2026-11-02' }, { end_date: '2026-11-13' },
      { start_date: null, end_date: null }, { start_date: '', end_date: '2026-11-13' }];
    for (const [index, extra] of extras.entries()) {
      const number = index + 1;
      const sprint = await backend.createSprint('New sprint', number, extra);
      assert.strictEqual(sprint.number, number);
      assert.deepStrictEqual(state.sprintPosts.at(-1), { name: 'New sprint', number, auto_dates: true });
    }
    assert.strictEqual(state.sprintPosts.length, extras.length);
    assert.deepStrictEqual(state.unexpected, []);
  });
});

const REJECTED_DATES = { goal: 'ship', start_date: '2026-11-13', end_date: '2026-11-02' };
const INVALID_DATES = { status: 400, data: { error: 'invalid_sprint_dates' } };

test('createSprint retries rejected explicit dates once with automatic allocation and preserves the goal', async () => {
  const state = baseState({ sprintReplies: [INVALID_DATES] });
  await withFakeApiServer(state, async (backend) => {
    const sprint = await backend.createSprint('Sprint 3', 3, REJECTED_DATES);
    assert.strictEqual(sprint.number, 3);
    assert.deepStrictEqual(state.sprintPosts, [
      { name: 'Sprint 3', number: 3, ...REJECTED_DATES, date_source: 'auto' },
      { name: 'Sprint 3', number: 3, goal: 'ship', auto_dates: true },
    ]);
  });
});

test('createSprint still returns null if either explicit dates or the fallback receives 409', async () => {
  for (const sprintReplies of [[], [INVALID_DATES]]) {
    const state = baseState({ sprintNumbers: new Set([3]), sprintReplies });
    const expectedCalls = sprintReplies.length + 1;
    await withFakeApiServer(state, async (backend) => {
      assert.strictEqual(await backend.createSprint('Sprint 3', 3, REJECTED_DATES), null);
      assert.strictEqual(state.sprintPosts.length, expectedCalls);
    });
  }
});

test('createSprint never retries other errors, an automatic-date request, or a failed fallback', async () => {
  const cases = [
    { extra: REJECTED_DATES, replies: [INVALID_DATES, INVALID_DATES] },
    { extra: undefined, replies: [INVALID_DATES] },
    { extra: REJECTED_DATES, replies: [{ status: 400, data: { error: 'name is required' } }] },
    { extra: REJECTED_DATES, replies: [{ status: 500, data: { error: 'invalid_sprint_dates' } }] },
  ];
  for (const { extra, replies } of cases) {
    const expectedError = replies.at(-1);
    const state = baseState({ sprintReplies: [...replies] });
    await withFakeApiServer(state, async (backend) => {
      await assert.rejects(backend.createSprint('Sprint 3', 3, extra), (err) =>
        err.statusCode === expectedError.status && err.body.error === expectedError.data.error);
      assert.strictEqual(state.sprintPosts.length, replies.length);
    });
  }
});
