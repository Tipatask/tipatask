'use strict';

// (C1383) Fail-closed auth — end-to-end against a fake API server + scratch
// .tipatask/config.json, same throwaway-project harness as board-assignee-scope.test.js
// and reserve-task-keys.test.js. Covers the actual holes found during exploration:
//   1. a 401 response rejects with AuthCorruptedError instead of degrading to stale/empty data
//   2. a locally-known-expired token never reaches the wire at all (pre-flight check)
//   3. _probeConnection() no longer treats 401 as "reachable" and un-latching (was clearing
//      the unauthorized latch and draining the write queue straight into silent drops)
//   4. _drainPendingMutations() re-queues (not drops) a write that replays into a 401
//   5. task-backend.js's factory seals an instance built with an already-expired token

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The account store defaults to USER_DATA_ROOT; keep this file's tokens in a private dir.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-auth-fc-userdata-'));
const { clearAccountToken } = require('./account-store');
const { createApiBackend, AuthCorruptedError } = require('./api-backend');
const { createPerProjectBackend } = require('./task-backend');

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeExpiredJwt() {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ id: 1, exp: Math.floor(Date.now() / 1000) - 3600 });
  return `${header}.${payload}.sig-not-checked-client-side`;
}

async function withFakeApiServer(handler, token, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-auth-fail-closed-'));
  // Ephemeral ports get reused between tests: start each from a signed-out account so the
  // inline token written below is the only one in play.
  clearAccountToken(`http://127.0.0.1:${port}`);
  fs.mkdirSync(path.join(projectRoot, '.tipatask'));
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${port}`,
    API_TOKEN: token,
    API_PROJECT_ID: '1',
  }));
  const backend = createApiBackend(null, projectRoot);
  try {
    await run(backend, projectRoot);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// ── 1. A real 401 rejects with AuthCorruptedError ──

test('getTasks() rejects with AuthCorruptedError on a 401, not stale/empty data', async () => {
  await withFakeApiServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  }, 'opaque-test-token', async (backend) => {
    await assert.rejects(() => backend.getTasks(), (err) => {
      assert.ok(err instanceof AuthCorruptedError, `expected AuthCorruptedError, got ${err.constructor.name}`);
      assert.strictEqual(err.code, 'EAUTH');
      return true;
    });
    assert.strictEqual(backend.getConnectionState(), 'unauthorized');
  });
});

// ── 2. A locally-known-expired token never reaches the wire ──

test('getTasks() rejects on a known-expired JWT before sending any request', async () => {
  let requestCount = 0;
  await withFakeApiServer((req, res) => {
    requestCount++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks: [] }));
  }, makeExpiredJwt(), async (backend) => {
    await assert.rejects(() => backend.getTasks(), AuthCorruptedError);
    assert.strictEqual(requestCount, 0, 'pre-flight check must reject before any wire call');
    assert.strictEqual(backend.getConnectionState(), 'unauthorized');
  });
});

// ── 3. _probeConnection() fails closed on 401 (regression: it used to _markConnected()) ──

test('_probeConnection() latches unauthorized on a 401 instead of clearing to connected', async () => {
  let requestCount = 0;
  await withFakeApiServer((req, res) => {
    requestCount++;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  }, 'opaque-test-token', async (backend) => {
    await backend._probeConnectionForTest();
    assert.strictEqual(backend.getConnectionState(), 'unauthorized', 'probe must not clear to connected on a 401');
    assert.strictEqual(requestCount, 1);

    // A following call must still reject — the latch, not a one-shot flag.
    await assert.rejects(() => backend.getTasks(), AuthCorruptedError);
    assert.strictEqual(requestCount, 1, 'latched apiRequest() must self-reject without a second wire call');
  });
});

// ── 4. A queued write replayed into a 401 stays queued, is not silently dropped ──

test('_drainPendingMutations() re-queues (does not drop) a write that replays into a 401', async () => {
  await withFakeApiServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  }, 'opaque-test-token', async (backend) => {
    backend._enqueueMutationForTest('update', ['C1', { status: 'completed' }], 'C1');
    assert.strictEqual(backend.getPendingMutationCount(), 1);

    await backend._drainPendingMutationsForTest();

    assert.strictEqual(backend.getPendingMutationCount(), 1, 'auth failure must re-queue, not drop, the entry');
    assert.deepStrictEqual(backend.getPendingTaskIds(), ['C1']);
  });
});

// ── 5. task-backend.js's factory seals an instance built with an already-expired token ──

test('createPerProjectBackend() seals a backend whose token is already expired', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-auth-fail-closed-factory-'));
  fs.mkdirSync(path.join(projectRoot, '.tipatask'));
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_BASE_URL: 'http://127.0.0.1:1', // must never be reached — sealing is local-only
    API_TOKEN: makeExpiredJwt(),
    API_PROJECT_ID: '1',
  }));
  try {
    const backend = createPerProjectBackend({ TASK_BACKEND: 'api' }, projectRoot);
    assert.strictEqual(backend.getConnectionState(), 'unauthorized', 'factory must hand back a pre-sealed instance');
    await assert.rejects(() => backend.getTasks(), AuthCorruptedError);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('createPerProjectBackend() does NOT seal on a merely-missing token (must still reach setup wizard)', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-auth-fail-closed-factory-missing-'));
  try {
    // No .tipatask/config.json at all — same as a brand-new, unconfigured project.
    const backend = createPerProjectBackend({ TASK_BACKEND: 'api' }, projectRoot);
    assert.notStrictEqual(backend.getConnectionState(), 'unauthorized', 'missing config must not pre-seal — that is init()\'s job, not the factory\'s');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
