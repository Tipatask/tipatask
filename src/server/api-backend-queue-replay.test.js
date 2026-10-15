'use strict';

// TPT662 — the offline mutation queue keeps a Task App UI save's { autoRegisterTags } option,
// so the reconnect replay still registers unknown tags (TPT623) instead of walking into the
// API's TAGS_UNREGISTERED 400; and an entry the replay must give up on is REPORTED to the
// drain listeners (`dropped`) rather than only console.warn'd. Real api-backend transport
// against a fake API server (same harness as api-backend-tag-auto-register.test.js), LLM
// describer stubbed. Never touches port 4455 or production.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-queue-replay-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const tagAutoRegister = require('./tag-auto-register');
const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { writeAccountToken, clearAccountToken } = require('./account-store');

let describeResult;
beforeEach(() => {
  describeResult = new Map();
  tagAutoRegister.describeTagsWithLlm = async () => describeResult;
});

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
      // `dropWrites`: kill the socket on a task write → ECONNRESET → networkError → queued.
      if (isTaskWrite && state.dropWrites) { state.calls.push(`DROPPED ${req.method}`); req.socket.destroy(); return; }
      if (req.method === 'GET' && pathname === '/api/auth/me') return send(200, { user: { id: 7 } });
      if (req.method === 'GET' && pathname === '/api/projects/1') return send(200, { project: { id: 1, task_prefix: 'MNY' } });
      if (req.method === 'GET' && pathname === '/api/projects/1/tags') {
        return send(200, { tags: state.tags.map(t => ({ name: t.name, description: t.description })) });
      }
      if (req.method === 'POST' && pathname === '/api/projects/1/tags') {
        state.calls.push('POST /tags');
        state.tagPosts.push(parsed);
        for (const t of parsed.tags) state.tags.push(t);
        return send(200, { tags: parsed.tags });
      }
      if (req.method === 'POST' && pathname === '/api/projects/1/tasks') {
        state.calls.push('POST /tasks');
        state.taskPosts.push(parsed);
        return send(201, { task: { id: 2, project_id: 1, ...parsed, task_key: 'MNY9' } });
      }
      if (req.method === 'PATCH' && pathname.startsWith('/api/projects/1/tasks/')) {
        state.calls.push('PATCH /tasks');
        state.taskPatches.push(parsed);
        if (state.patchStatus && state.patchStatus !== 200) return send(state.patchStatus, { error: 'Unregistered tag(s)', code: 'TAGS_UNREGISTERED' });
        return send(200, { task: { id: 2, project_id: 1, task_key: 'MNY1', title: 'x', ...parsed } });
      }
      if (req.method === 'GET' && pathname === '/api/projects/1/tasks') return send(200, { tasks: [] });
      state.unexpected.push(`${req.method} ${req.url}`);
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-queue-replay-'));
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
    tags: [{ name: 'feature', description: 'New functionality.' }],
    calls: [], tagPosts: [], taskPosts: [], taskPatches: [], unexpected: [],
    dropWrites: false,
    ...overrides,
  };
}

function listen(backend) {
  const seen = [];
  backend.onMutationsDrained((replayed, remaining, dropped) => seen.push({ replayed, remaining, dropped }));
  return seen;
}

// ── 1. A real offline capture keeps the option on the queued entry ──

test('updateTask queued while offline replays WITH autoRegisterTags (registers, then PATCHes the whole edit)', async () => {
  const state = baseState({ dropWrites: true });
  describeResult = new Map([['logo-design', 'Logo work.']]);
  await withFakeApiServer(state, async (backend) => {
    const optimistic = await backend.updateTask('MNY1', { title: 'New title', tags: ['Feature', 'logo-design'] }, { autoRegisterTags: true });
    assert.strictEqual(optimistic._pendingSync, true, 'offline save resolves optimistically');
    assert.strictEqual(backend.getPendingMutationCount(), 1);
    assert.deepStrictEqual(backend.getPendingTaskIds(), ['MNY1']);
    // The gate ran before the PATCH and registered the tag even on the failed first attempt;
    // what matters is what the REPLAY sends once the API is back.
    state.dropWrites = false;
    state.calls.length = 0;
    state.tags = [{ name: 'feature', description: 'New functionality.' }];
    const seen = listen(backend);

    await backend._drainPendingMutationsForTest();

    assert.deepStrictEqual(state.calls, ['POST /tags', 'PATCH /tasks'], 'replay registers the unknown tag first');
    assert.deepStrictEqual(state.tagPosts.at(-1), { tags: [{ name: 'logo-design', description: 'Logo work.' }] });
    assert.deepStrictEqual(state.taskPatches.at(-1), { title: 'New title', tags: ['feature', 'logo-design'] }, 'title AND canonical tags land');
    assert.strictEqual(backend.getPendingMutationCount(), 0);
    assert.deepStrictEqual(backend.getPendingTaskIds(), []);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].replayed.length, 1);
    assert.deepStrictEqual(seen[0].dropped, []);
  });
});

test('createTask queued while offline replays WITH autoRegisterTags and remaps the tmp id', async () => {
  const state = baseState({ dropWrites: true });
  describeResult = new Map([['logo-design', 'Logo work.']]);
  await withFakeApiServer(state, async (backend) => {
    const task = { title: 'Logo', description: 'd', category: 'CODING', status: 'pending', priority: 1, dependencies: [], tags: ['logo-design'], assignee: 1 };
    const optimistic = await backend.createTask(task, { autoRegisterTags: true });
    assert.ok(optimistic._tmpId && /^tmp-/.test(optimistic.id));
    assert.strictEqual(backend.getPendingMutationCount(), 1);
    state.dropWrites = false;
    state.calls.length = 0;
    state.tags = [{ name: 'feature', description: 'New functionality.' }];
    const seen = listen(backend);

    await backend._drainPendingMutationsForTest();

    assert.deepStrictEqual(state.calls, ['POST /tags', 'POST /tasks']);
    assert.deepStrictEqual(state.taskPosts.at(-1).tags, ['logo-design']);
    assert.strictEqual(seen[0].replayed[0]._replacedTmpId, optimistic.id);
    assert.strictEqual(seen[0].replayed[0].id, 'MNY9');
    assert.deepStrictEqual(seen[0].dropped, []);
  });
});

// ── 2. The seam form the task brief names ──

test('_enqueueMutationForTest update entry carrying opts replays through the tag gate', async () => {
  const state = baseState();
  describeResult = new Map([['logo-design', 'Logo work.']]);
  await withFakeApiServer(state, async (backend) => {
    backend._enqueueMutationForTest('update', ['MNY1', { tags: ['logo-design'] }, { autoRegisterTags: true }], 'MNY1');
    const seen = listen(backend);
    await backend._drainPendingMutationsForTest();
    assert.deepStrictEqual(state.calls, ['POST /tags', 'PATCH /tasks']);
    assert.deepStrictEqual(seen[0].dropped, []);
  });
});

// ── 3. A replay the gate still rejects is reported, not swallowed ──

test('a tt-* tag on replay is dropped AND reported to drain listeners; later entries still replay', async () => {
  const state = baseState();
  describeResult = new Map([['tt-api-logo', 'Would be ignored — tt-* is never auto-registered.']]);
  await withFakeApiServer(state, async (backend) => {
    backend._enqueueMutationForTest('update', ['MNY1', { title: 'Edited', tags: ['tt-api-logo'] }, { autoRegisterTags: true }], 'MNY1');
    backend._enqueueMutationForTest('update', ['MNY2', { status: 'completed' }, {}], 'MNY2');
    const seen = listen(backend);
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      await backend._drainPendingMutationsForTest();
    } finally {
      console.warn = origWarn;
    }
    assert.deepStrictEqual(state.calls, ['PATCH /tasks'], 'only the second entry reaches the API');
    assert.deepStrictEqual(state.taskPatches.at(-1), { status: 'completed' });
    assert.strictEqual(backend.getPendingMutationCount(), 0, 'the rejected entry leaves the queue');
    assert.deepStrictEqual(backend.getPendingTaskIds(), []);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].dropped.length, 1, 'the drop is reported');
    const d = seen[0].dropped[0];
    assert.strictEqual(d.op, 'update');
    assert.strictEqual(d.taskId, 'MNY1');
    assert.strictEqual(d.title, 'Edited');
    assert.strictEqual(d.code, 'TAGS_UNREGISTERED');
    assert.match(d.message, /tt-api-logo/);
    assert.strictEqual(seen[0].replayed.length, 1);
    assert.ok(warnings.some(w => w.includes('Dropping update for MNY1')), 'the log line stays');
  });
});

test('an API-side 400 on replay is reported with its statusCode', async () => {
  const state = baseState({ patchStatus: 400 });
  await withFakeApiServer(state, async (backend) => {
    backend._enqueueMutationForTest('update', ['MNY1', { tags: ['brand-new'] }], 'MNY1');
    const seen = listen(backend);
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      await backend._drainPendingMutationsForTest();
    } finally {
      console.warn = origWarn;
    }
    assert.deepStrictEqual(state.calls, ['PATCH /tasks']);
    assert.strictEqual(seen[0].dropped.length, 1);
    assert.strictEqual(seen[0].dropped[0].statusCode, 400);
    assert.strictEqual(seen[0].dropped[0].taskId, 'MNY1');
    assert.strictEqual(backend.getPendingMutationCount(), 0);
  });
});
