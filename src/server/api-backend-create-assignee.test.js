'use strict';

// Real-transport lock for the assignee on the two Task App create routes:
//   1. createTask() -> _rawCreateTask -> POST /tasks   (direct create)
//   2. overwriteRawWithRemap -> overwriteRaw -> PATCH /tasks/:key   (finalizing a reserved key —
//      the path the New Task form and objective Save actually take)
// An explicit assignee must reach the API untouched; a missing one falls back to the token's
// user (GET /api/auth/me), and stays null only when /me is unreachable.
//
// Drives the genuine backend against a throwaway fake HTTP server (same harness shape as
// objective-agent-persist.test.js). Never touches port 4455 or production (web.tipatask.com).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');

const ME_ID = 7;

async function withFakeApiServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-create-assignee-'));
  writeProjectConfig(projectRoot, {
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${port}`,
    API_TOKEN: 'test-token',
    API_PROJECT_ID: '1',
  });
  const backend = createApiBackend(null, projectRoot);
  // The resolved user id is module-level in api-backend.js, shared by every backend in this
  // process — drop it so each test starts from "identity not yet known".
  backend.resetUserContext('test');
  try {
    await run(backend);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// `state.meStatus` 200 serves ME_ID, anything else simulates /me being unreachable.
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

      if (req.method === 'GET' && pathname === '/api/auth/me') {
        state.meRequests += 1;
        if (state.meStatus !== 200) return send(state.meStatus, { error: 'unavailable' });
        return send(200, { user: { id: ME_ID } });
      }
      if (req.method === 'GET' && pathname === '/api/projects/1/tags') {
        return send(200, { tags: [] });
      }
      if (req.method === 'GET' && pathname === '/api/projects/1/tasks') {
        return send(200, { tasks: state.liveRows });
      }
      const patchMatch = pathname.match(/^\/api\/projects\/1\/tasks\/([^/]+)$/);
      if (req.method === 'PATCH' && patchMatch) {
        const parsed = JSON.parse(body);
        state.patches.push({ key: patchMatch[1], body: parsed });
        return send(200, { task: { id: 1, project_id: 1, task_key: patchMatch[1], ...parsed } });
      }
      if (req.method === 'POST' && pathname === '/api/projects/1/tasks') {
        const parsed = JSON.parse(body);
        state.posts.push(parsed);
        return send(201, { task: { id: 2, project_id: 1, ...parsed } });
      }
      state.unexpected.push(`${req.method} ${req.url}`);
      return send(404, { error: 'not found' });
    });
  };
}

function baseState(overrides = {}) {
  return { liveRows: [], patches: [], posts: [], unexpected: [], meRequests: 0, meStatus: 200, ...overrides };
}

function newTask(overrides) {
  return {
    id: 'C900',
    title: 'New task',
    description: 'Do the thing',
    category: 'CODING',
    status: 'pending',
    priority: 1,
    order: 1,
    dependencies: [],
    tags: [],
    ...overrides,
  };
}

function reservationRow(taskKey) {
  return {
    id: 10,
    project_id: 1,
    task_key: taskKey,
    title: '',
    description: 'Reserved key — pending finalization.',
    category: 'CODING',
    status: 'pending',
    priority: 0,
    is_reservation: 1,
  };
}

// The `PUT /api/todo` body shape chat-task-preview.js builds.
function todoBody(tasks, newTaskIds) {
  return '# Tasks\n\n```json\n' + JSON.stringify({ tasks, newTaskIds }, null, 2) + '\n```\n';
}

test('createTask sends an explicit assignee in the POST body and never needs /me', async () => {
  const state = baseState();
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.createTask(newTask({ assignee: 9 }));

    assert.deepStrictEqual(state.unexpected, []);
    assert.strictEqual(state.posts.length, 1);
    assert.strictEqual(state.posts[0].assignee, 9, 'the caller\'s pick must not be overwritten with the token user');
    assert.strictEqual(state.meRequests, 0, 'no fallback needed, so no /me round trip');
  });
});

test('createTask without an assignee falls back to the token user from /api/auth/me', async () => {
  const state = baseState();
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.createTask(newTask({ assignee: null }));

    assert.deepStrictEqual(state.unexpected, []);
    assert.strictEqual(state.posts.length, 1);
    assert.strictEqual(state.posts[0].assignee, ME_ID);
  });
});

test('createTask without an assignee sends null only when /me is unreachable', async () => {
  const state = baseState({ meStatus: 500 });
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.createTask(newTask({}));

    assert.strictEqual(state.posts.length, 1);
    assert.strictEqual(state.posts[0].assignee, null);
  });
});

test('finalizing a reserved key for a new task without an assignee PATCHes assignee = token user', async () => {
  const state = baseState({ liveRows: [reservationRow('C900')] });
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.overwriteRawWithRemap(todoBody([newTask({ assignee: null })], ['C900']));

    assert.deepStrictEqual(state.unexpected, []);
    assert.strictEqual(state.posts.length, 0, 'a live reservation is finalized in place, never re-created');
    assert.strictEqual(state.patches.length, 1);
    assert.strictEqual(state.patches[0].key, 'C900');
    assert.strictEqual(state.patches[0].body.assignee, ME_ID,
      'a null assignee would clear the creator the reserve route stamped');
  });
});

test('finalizing a reserved key keeps an explicit assignee and skips /me', async () => {
  const state = baseState({ liveRows: [reservationRow('C900')] });
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.overwriteRawWithRemap(todoBody([newTask({ assignee: 9 })], ['C900']));

    assert.deepStrictEqual(state.unexpected, []);
    assert.strictEqual(state.patches.length, 1);
    assert.strictEqual(state.patches[0].body.assignee, 9);
    assert.strictEqual(state.meRequests, 0);
  });
});
