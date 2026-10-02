'use strict';

// End-to-end lock for the objective Save path as a second Electron project window drives it:
//   PUT /api/todo (createHttpHandler) -> registryOps.getBackendForPath (x-tipatask-project)
//   -> a per-project api-backend instance -> the Tipatask API.
// The backend is the genuine one, the API is a throwaway fake HTTP server (same harness shape
// as api-backend-create-assignee.test.js). Never touches port 4455 or a real API.
//
// Two things are pinned here: the first save through a backend whose init() is still running
// succeeds, and every failure answers with the status and `{ error, step, code }` body the
// client needs to show the real reason instead of a generic 500.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHttpHandler } = require('./ws-handlers');
const { createPerProjectBackend } = require('./task-backend');
const { readProjectConfig, writeProjectConfig } = require('./project-config');

const ME_ID = 7;

function jwt(expSecondsFromNow) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ id: ME_ID, exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

function reservationRow(taskKey, dbId) {
  return {
    id: dbId,
    project_id: 1,
    task_key: taskKey,
    title: 'New task',
    description: 'Reserved key — pending finalization.',
    category: 'CODING',
    status: 'pending',
    priority: 0,
    is_reservation: 1,
    assignee: ME_ID,
    tags: [],
  };
}

function baseState(overrides = {}) {
  return {
    rows: [],
    tags: [{ name: 'feature', description: 'New capability' }],
    patches: [],
    reserves: 0,
    tagPosts: [],
    unexpected: [],
    listDelayMs: 0,
    patchStatus: 200,
    nextKey: 500,
    ...overrides,
  };
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
      const base = '/api/projects/1';

      if (req.method === 'GET' && pathname === '/api/auth/me') return send(200, { user: { id: ME_ID } });
      if (req.method === 'GET' && pathname === `${base}/tasks`) {
        return setTimeout(() => send(200, { tasks: state.rows }), state.listDelayMs);
      }
      if (req.method === 'GET' && pathname === `${base}/tags`) return send(200, { tags: state.tags });
      if (req.method === 'POST' && pathname === `${base}/tags`) {
        const parsed = JSON.parse(body);
        state.tagPosts.push(parsed);
        state.tags.push(...parsed.tags);
        return send(200, { tags: state.tags });
      }
      if (req.method === 'GET' && pathname === `${base}/statuses`) return send(404, { error: 'not found' });
      if (req.method === 'GET' && pathname === `${base}/sprints`) return send(200, { sprints: [{ number: 3 }] });
      if (req.method === 'POST' && pathname === `${base}/sprints`) return send(201, { sprint: JSON.parse(body) });
      if (req.method === 'POST' && pathname === `${base}/tasks/reserve`) {
        state.reserves += 1;
        const row = reservationRow(`CMP${state.nextKey++}`, 1000 + state.reserves);
        state.rows.push(row);
        return send(201, { tasks: [row] });
      }
      const taskMatch = pathname.match(new RegExp(`^${base}/tasks/([^/]+)$`));
      if (taskMatch && req.method === 'GET') {
        const row = state.rows.find(r => r.task_key === taskMatch[1]);
        return row ? send(200, { task: row }) : send(404, { error: 'not found' });
      }
      if (taskMatch && req.method === 'PATCH') {
        if (state.patchStatus !== 200) return send(state.patchStatus, { error: 'Internal server error' });
        const parsed = JSON.parse(body);
        state.patches.push({ key: taskMatch[1], body: parsed });
        const row = state.rows.find(r => r.task_key === taskMatch[1]);
        if (!row) return send(404, { error: 'not found' });
        Object.assign(row, parsed, { is_reservation: 0 });
        return send(200, { task: row });
      }
      const commentsMatch = pathname.match(new RegExp(`^${base}/tasks/([^/]+)/comments$`));
      if (commentsMatch && req.method === 'GET') return send(200, { comments: [] });
      if (commentsMatch && req.method === 'POST') return send(201, { comment: { id: 1, ...JSON.parse(body) } });

      state.unexpected.push(`${req.method} ${req.url}`);
      return send(404, { error: 'not found' });
    });
  };
}

// Mirrors getBackendForPath() in index.js: the instance is handed back while its init()
// is still in flight, and cached per project path.
function makeRegistry() {
  const instances = new Map();
  return {
    getBackendForPath(projectPath) {
      if (instances.has(projectPath)) return instances.get(projectPath);
      const inst = createPerProjectBackend(readProjectConfig(projectPath), projectPath);
      inst.init().catch(() => {});
      instances.set(projectPath, inst);
      return inst;
    },
  };
}

async function withProject(state, run, { token = 'test-token' } = {}) {
  const server = http.createServer(makeServer(state));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-todo-save-'));
  const cfg = {
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    API_PROJECT_ID: '1',
  };
  if (token) cfg.API_TOKEN = token;
  writeProjectConfig(projectRoot, cfg);
  const handler = createHttpHandler(new Map(), () => { throw new Error('active-backend fallback must not be used'); }, makeRegistry());
  const put = async (data) => {
    const body = '# Tasks\n\n```json\n' + JSON.stringify(data, null, 2) + '\n```\n';
    const req = {
      method: 'PUT', url: '/api/todo', headers: { 'x-tipatask-project': projectRoot },
      async *[Symbol.asyncIterator]() { yield body; },
    };
    const res = {
      writeHead(status) { this.status = status; },
      end(text) { this.body = JSON.parse(text); },
    };
    await handler(req, res);
    return res;
  };
  try {
    await run({ put, projectRoot, cfg });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function newTask(id, overrides = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: 'Do the thing',
    category: 'CODING',
    status: 'pending',
    priority: 3,
    order: 1,
    dependencies: [],
    tags: ['feature'],
    ...overrides,
  };
}

function quiet(t) {
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, () => {});
}

test('first save through a cold per-project backend finalizes the reserved keys', async (t) => {
  quiet(t);
  const state = baseState({ rows: [reservationRow('CMP33', 33), reservationRow('CMP34', 34)], listDelayMs: 40 });
  await withProject(state, async ({ put }) => {
    const res = await put({
      tasks: [newTask('CMP33'), newTask('CMP34', { dependencies: ['CMP33'] })],
      newTaskIds: ['CMP33', 'CMP34'],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true, idRemap: {} });
    assert.equal(state.reserves, 0, 'live reservations are finalized in place');
    assert.deepEqual(state.patches.map(p => p.key), ['CMP33', 'CMP34']);
    assert.equal(state.patches[0].body.assignee, ME_ID);
    assert.deepEqual(state.unexpected, []);
  });
});

test('a save after the project token was replaced still succeeds', async (t) => {
  quiet(t);
  const state = baseState({ rows: [reservationRow('CMP33', 33), reservationRow('CMP34', 34)] });
  await withProject(state, async ({ put, projectRoot, cfg }) => {
    const first = await put({ tasks: [newTask('CMP33')], newTaskIds: ['CMP33'] });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    writeProjectConfig(projectRoot, { ...cfg, API_TOKEN: 'renewed-token' });
    const second = await put({ tasks: [newTask('CMP34')], newTaskIds: ['CMP34'] });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(state.patches.map(p => p.key), ['CMP33', 'CMP34']);
  });
});

test('an expired token answers 401 with its reason, not 500', async (t) => {
  quiet(t);
  const state = baseState({ rows: [reservationRow('CMP33', 33)] });
  await withProject(state, async ({ put }) => {
    const res = await put({ tasks: [newTask('CMP33')], newTaskIds: ['CMP33'] });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.match(res.body.error, /Authentication required/);
    assert.equal(state.patches.length, 0);
  }, { token: jwt(-3600) });
});

test('a tag missing from the registry is rejected as 422 before any key is reserved', async (t) => {
  quiet(t);
  const state = baseState();
  await withProject(state, async ({ put }) => {
    const res = await put({
      tasks: [newTask('new-abc-1', { tags: ['feature', 'cleanup'] })],
      newTaskIds: ['new-abc-1'],
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.code, 'TAGS_UNREGISTERED');
    assert.match(res.body.error, /Unregistered tag\(s\) "cleanup"/);
    assert.equal(res.body.step, 'tag-registry');
    assert.equal(state.reserves, 0, 'a rejected save must not burn a task key');
    assert.equal(state.patches.length, 0);
  });
});

test('a new tag declared with a description is registered and the save goes through', async (t) => {
  quiet(t);
  const state = baseState();
  await withProject(state, async ({ put }) => {
    const res = await put({
      tasks: [newTask('new-abc-1', { tags: ['feature', 'cleanup'] })],
      newTaskIds: ['new-abc-1'],
      new_tags: [{ name: 'cleanup', description: 'Removing dead code and stale references' }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.idRemap, { 'new-abc-1': 'CMP500' });
    assert.equal(state.reserves, 1);
    assert.equal(state.tagPosts.length, 1);
    assert.deepEqual(state.patches.map(p => p.key), ['CMP500']);
  });
});

test('a new tag without a description is rejected as 422 before any key is reserved', async (t) => {
  quiet(t);
  const state = baseState();
  await withProject(state, async ({ put }) => {
    const res = await put({
      tasks: [newTask('new-abc-1', { tags: ['cleanup'] })],
      newTaskIds: ['new-abc-1'],
      new_tags: [{ name: 'cleanup', description: '  ' }],
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.code, 'NEW_TAG_DESCRIPTION_MISSING');
    assert.equal(state.reserves, 0);
    assert.equal(state.tagPosts.length, 0);
  });
});

test('an API 5xx while writing a task answers 502 and names the task being written', async (t) => {
  quiet(t);
  const state = baseState({ rows: [reservationRow('CMP33', 33)], patchStatus: 500 });
  await withProject(state, async ({ put }) => {
    const res = await put({ tasks: [newTask('CMP33')], newTaskIds: ['CMP33'] });
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(res.body.step, 'write-task:CMP33');
    assert.match(res.body.error, /API 500/);
  });
});

test('a project without an API token answers 401, not 500', async (t) => {
  quiet(t);
  const state = baseState();
  await withProject(state, async ({ put }) => {
    const res = await put({ tasks: [newTask('CMP33')], newTaskIds: ['CMP33'] });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.match(res.body.error, /Authentication required|missing API_TOKEN/);
    assert.equal(state.reserves, 0);
  }, { token: null });
});

test('a body without a task JSON block answers 400', async (t) => {
  quiet(t);
  const state = baseState();
  await withProject(state, async ({ projectRoot }) => {
    const handler = createHttpHandler(new Map(), () => { throw new Error('unused'); }, makeRegistry());
    const req = {
      method: 'PUT', url: '/api/todo', headers: { 'x-tipatask-project': projectRoot },
      async *[Symbol.asyncIterator]() { yield '# Tasks\n\nno json here\n'; },
    };
    const res = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    await handler(req, res);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'TODO_PAYLOAD_INVALID');
  });
});
