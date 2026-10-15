'use strict';

// The API can already be down when the backend first connects: connection refused, or the
// reverse proxy answering 502/503/504 for it. init() still rejects, but the backend must go
// offline the same way it does after losing a live connection — 'disconnected' announced,
// writes queued, reconnect backoff armed — and the first successful probe must finish the
// connect init() never got to: resolve the current user, replay the queue, announce
// 'connected'.

process.env.TIPATASK_PROJECT_ROOT = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'tt-init-offline-global-')
);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tokens live only in the app-level account store under TIPATASK_USER_DATA. Give this file
// its own, so parallel test files never race on one shared store file.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-init-offline-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const { createApiBackend } = require('./api-backend');

// Fake API whose behaviour flips at runtime: 'ok' answers like the real API, 'gateway'
// answers every request the way a proxy does with the API down.
function fakeApi() {
  const state = { mode: 'ok', patches: [], requests: 0, meRequests: 0, taskLists: 0 };
  const handler = (req, res) => {
    state.requests += 1;
    if (state.mode === 'gateway') {
      res.writeHead(503, { 'Content-Type': 'text/html' });
      return res.end('<html><body><h1>Service Unavailable</h1></body></html>');
    }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      state.meRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ user: { id: 42 } }));
    }
    if (req.method === 'GET' && url.pathname.endsWith('/tasks')) {
      state.taskLists += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tasks: [{ id: 1, task_key: 'C1', title: 'before', status: 'pending', priority: 1 }] }));
    }
    if (req.method === 'PATCH' && url.pathname.endsWith('/tasks/C1')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        const patch = JSON.parse(body);
        state.patches.push(patch);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ task: { id: 1, task_key: 'C1', title: patch.title || 'before', status: 'pending', priority: 1 } }));
      });
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  };
  return { state, handler };
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
  });
}

function writeConfig(port) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-init-offline-project-'));
  fs.mkdirSync(path.join(projectRoot, '.tipatask'));
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${port}`,
    API_TOKEN: 'opaque-token',
    API_PROJECT_ID: '1',
  }));
  return projectRoot;
}

// setTimeout is mocked BEFORE init(): the failed init arms the backoff, and the probe must
// run only when the test fires it.
function offlineBackend(t, projectRoot) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const backend = createApiBackend(null, projectRoot);
  const states = [];
  backend.onConnectionStateChange((s) => states.push(s));
  const drained = [];
  backend.onMutationsDrained((rows, remaining) => drained.push({ rows, remaining }));
  return { backend, states, drained };
}

// Fire the armed reconnect timer and let the probe's real HTTP round trips settle.
async function fireReconnect(t, ms, settled) {
  t.mock.timers.tick(ms);
  for (let i = 0; i < 2000 && !settled(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(settled(), 'probe did not settle');
}

async function assertOfflineAfterInit(backend, states) {
  assert.equal(backend.getConnectionState(), 'reconnecting', 'failed init armed the backoff');
  assert.deepEqual(states, ['disconnected', 'reconnecting']);

  const result = await backend.updateTask('C1', { title: 'after' });
  assert.equal(result._pendingSync, true, 'write resolves as a pending-sync row, not an error');
  assert.equal(result.title, 'after');
  assert.equal(backend.getPendingMutationCount(), 1);
}

test('a 503 at first contact goes offline, queues writes, and the probe finishes the connect', (t) => {
  const api = fakeApi();
  api.state.mode = 'gateway';
  const server = http.createServer(api.handler);
  return listen(server).then(async (port) => {
    const projectRoot = writeConfig(port);
    t.after(() => new Promise((r) => server.close(r)));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const { backend, states, drained } = offlineBackend(t, projectRoot);

    await assert.rejects(backend.init(), (err) => {
      assert.equal(err.networkError, true);
      assert.equal(err.statusCode, 503);
      return true;
    });
    await assertOfflineAfterInit(backend, states);
    assert.equal(api.state.patches.length, 0, 'offline write never reached the wire');

    // Still down at the first backoff: the probe re-arms and nothing replays.
    const before = api.state.requests;
    await fireReconnect(t, 2000, () => api.state.requests > before);
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    assert.equal(backend.getConnectionState(), 'reconnecting');
    assert.equal(backend.getPendingMutationCount(), 1);

    api.state.mode = 'ok';
    await fireReconnect(t, 4000, () => backend.getConnectionState() === 'connected');
    assert.deepEqual(api.state.patches, [{ title: 'after' }]);
    assert.equal(backend.getPendingMutationCount(), 0);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].remaining, 0);
    assert.equal(api.state.meRequests, 1, 'probe resolved the current user');
    assert.equal(await backend.getCurrentUserId(), 42);
    assert.equal(api.state.meRequests, 1, 'user id cached — no second /me');
    assert.equal(states[states.length - 1], 'connected');
  });
});

test('connection refused at first contact goes offline and recovers when the API starts', async (t) => {
  // Reserve a port, then close it so init() hits ECONNREFUSED.
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  const projectRoot = writeConfig(port);
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const { backend, states, drained } = offlineBackend(t, projectRoot);

  await assert.rejects(backend.init(), (err) => {
    assert.equal(err.networkError, true);
    assert.equal(err.code, 'ECONNREFUSED');
    return true;
  });
  await assertOfflineAfterInit(backend, states);

  const api = fakeApi();
  const server = http.createServer(api.handler);
  await listen(server, port);
  t.after(() => new Promise((r) => server.close(r)));

  await fireReconnect(t, 2000, () => backend.getConnectionState() === 'connected');
  assert.deepEqual(api.state.patches, [{ title: 'after' }]);
  assert.equal(backend.getPendingMutationCount(), 0);
  assert.equal(drained[0].remaining, 0);
  assert.equal(await backend.getCurrentUserId(), 42);
});

test('reconfigureAndProbe() clears the backoff a failed init armed', (t) => {
  const api = fakeApi();
  api.state.mode = 'gateway';
  const server = http.createServer(api.handler);
  return listen(server).then(async (port) => {
    const projectRoot = writeConfig(port);
    t.after(() => new Promise((r) => server.close(r)));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const { backend } = offlineBackend(t, projectRoot);

    await assert.rejects(backend.init());
    assert.equal(backend.getConnectionState(), 'reconnecting');

    api.state.mode = 'ok';
    assert.equal(await backend.reconfigureAndProbe(null, projectRoot), 'connected');
    assert.equal(api.state.meRequests, 1);

    const before = api.state.requests;
    t.mock.timers.tick(30000);
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    assert.equal(api.state.requests, before, 'no stale probe fired after the re-probe connected');
    assert.equal(backend.getConnectionState(), 'connected');
  });
});

test('a successful first init still emits only connected', (t) => {
  const api = fakeApi();
  const server = http.createServer(api.handler);
  return listen(server).then(async (port) => {
    const projectRoot = writeConfig(port);
    t.after(() => new Promise((r) => server.close(r)));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const { backend, states } = offlineBackend(t, projectRoot);
    await backend.init();
    assert.deepEqual(states, ['connected']);
    assert.equal(api.state.meRequests, 1);
  });
});

// (TPT673) A registry evicting an idle backend calls dispose(): the backoff a failed init
// armed must stop, a probe already in flight must not re-arm it, and listeners are dropped.
test('dispose() stops the reconnect backoff a failed init armed', (t) => {
  const api = fakeApi();
  api.state.mode = 'gateway';
  const server = http.createServer(api.handler);
  return listen(server).then(async (port) => {
    const projectRoot = writeConfig(port);
    t.after(() => new Promise((r) => server.close(r)));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const { backend, states } = offlineBackend(t, projectRoot);

    await assert.rejects(backend.init());
    assert.equal(backend.getConnectionState(), 'reconnecting');
    backend.dispose();
    assert.equal(backend.isDisposed(), true);

    const before = api.state.requests;
    t.mock.timers.tick(60000);
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    assert.equal(api.state.requests, before, 'no probe fired after dispose');

    // A probe that was already running when dispose() landed fails and must not re-arm.
    const statesBefore = states.length;
    await backend._probeConnectionForTest();
    t.mock.timers.tick(60000);
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    assert.equal(api.state.requests, before + 1, 'only the direct probe hit the API');
    assert.equal(states.length, statesBefore, 'listeners were dropped');
    backend.dispose(); // idempotent
  });
});

test('a write queued on a disposed backend still gets a reconnect and replays', (t) => {
  const api = fakeApi();
  api.state.mode = 'gateway';
  const server = http.createServer(api.handler);
  return listen(server).then(async (port) => {
    const projectRoot = writeConfig(port);
    t.after(() => new Promise((r) => server.close(r)));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const { backend } = offlineBackend(t, projectRoot);

    await assert.rejects(backend.init());
    backend.dispose();
    // A holder that grabbed the instance before eviction writes while offline.
    const queued = await backend.updateTask('C1', { title: 'late' });
    assert.equal(queued._pendingSync, true);
    await backend._probeConnectionForTest(); // still down → must re-arm despite dispose
    api.state.mode = 'ok';
    await fireReconnect(t, 30000, () => backend.getConnectionState() === 'connected');
    assert.deepEqual(api.state.patches, [{ title: 'late' }]);
    assert.equal(backend.getPendingMutationCount(), 0);
  });
});
