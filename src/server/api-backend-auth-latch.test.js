'use strict';

// The 'unauthorized' latch must stay fail-closed for a locally dead token, but must not be
// permanent for a token that is locally valid: a server 401/403 is re-verified with one real
// request per interval, and every recovery path announces 'connected'.
//
// Pin TIPATASK_PROJECT_ROOT before anything pulls config.js (read once at module load) —
// same guard as api-backend-recipes-dir.test.js.
process.env.TIPATASK_PROJECT_ROOT = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'tt-auth-latch-global-')
);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApiBackend } = require('./api-backend');
const { MAX_RESPONSE_BYTES } = require('../cli/http');

function jwtWithExp(expSeconds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: expSeconds })}.sig`;
}

async function withFakeApi(token, handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-auth-latch-project-'));
  fs.mkdirSync(path.join(projectRoot, '.tipatask'));
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    API_TOKEN: token,
    API_PROJECT_ID: '1',
  }));
  try {
    await run(projectRoot);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('init() success emits "connected" through the state listeners', () => withFakeApi(
  'opaque-token',
  (req, res) => (req.url.endsWith('/tasks') ? json(res, 200, { tasks: [] }) : json(res, 404, {})),
  async (projectRoot) => {
    const backend = createApiBackend(null, projectRoot);
    const states = [];
    backend.onConnectionStateChange((s) => states.push(s));
    await backend.init();
    assert.deepEqual(states, ['connected']);
    assert.equal(backend.getConnectionState(), 'connected');
  }
));

test('oversized API responses do not become offline or retryable failures', () => withFakeApi(
  'opaque-token',
  (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(Buffer.alloc(MAX_RESPONSE_BYTES + 1, 32));
  },
  async (projectRoot) => {
    const backend = createApiBackend(null, projectRoot);
    const states = [];
    backend.onConnectionStateChange((s) => states.push(s));
    await assert.rejects(backend.getSprints(), (err) => {
      assert.equal(err.code, 'ERR_RESPONSE_TOO_LARGE');
      assert.equal(err.networkError, undefined);
      return true;
    });
    assert.deepEqual(states, []);
  }
));

test('a reset socket (ECONNRESET) rejects the call as a retryable network error instead of crashing', async (t) => {
  await withFakeApi(
    'opaque-token',
    (req, res) => {
      if (req.url.endsWith('/tasks')) return json(res, 200, { tasks: [] });
      req.socket.destroy(); // hang up mid-request: the client sees "socket hang up"
    },
    async (projectRoot) => {
      const backend = createApiBackend(null, projectRoot);
      const states = [];
      backend.onConnectionStateChange((s) => states.push(s));
      await backend.init();

      // A failure arms the reconnect backoff timer; mock it so no live timer outlives the test.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      t.after(() => t.mock.timers.reset());

      await assert.rejects(backend.getSprints(), (err) => {
        assert.equal(err.networkError, true);
        assert.equal(err.retryable, true);
        assert.equal(err.code, 'ECONNRESET');
        assert.ok(err.cause instanceof Error, 'underlying transport error kept as cause');
        return true;
      });
      assert.ok(states.includes('disconnected'), `states: ${states.join(',')}`);
    }
  );
});

test('server 401 on a locally valid token: fails fast inside the window, re-verifies once after it, un-latches on success', async (t) => {
  let rejectStatuses = true;
  let statusHits = 0;
  await withFakeApi(
    'opaque-token',
    (req, res) => {
      if (req.url.endsWith('/tasks')) return json(res, 200, { tasks: [] });
      if (req.url.endsWith('/sprints')) {
        statusHits += 1;
        return rejectStatuses ? json(res, 401, { error: 'nope' }) : json(res, 200, { sprints: [] });
      }
      return json(res, 404, {});
    },
    async (projectRoot) => {
      const backend = createApiBackend(null, projectRoot);
      const states = [];
      backend.onConnectionStateChange((s) => states.push(s));
      await backend.init();

      await assert.rejects(backend.getSprints(), /Authentication required/);
      assert.equal(backend.getConnectionState(), 'unauthorized');
      assert.equal(statusHits, 1);

      // Inside the window: local fast-fail, the API is not asked again.
      await assert.rejects(backend.getSprints(), /Authentication required/);
      assert.equal(statusHits, 1);

      // Past the window (Date mocked too — the deadline check reads Date.now()).
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      t.mock.timers.tick(61_000);
      rejectStatuses = false;
      await backend.getSprints();
      t.mock.timers.reset();

      assert.equal(statusHits, 2);
      assert.equal(backend.getConnectionState(), 'connected');
      assert.deepEqual(states, ['connected', 'unauthorized', 'connected']);
    }
  );
});

test('expired JWT stays hard-latched — never re-verified, no request reaches the API', async (t) => {
  let hits = 0;
  await withFakeApi(
    jwtWithExp(Math.floor(Date.now() / 1000) - 3600),
    (req, res) => { hits += 1; json(res, 200, { sprints: [] }); },
    async (projectRoot) => {
      const backend = createApiBackend(null, projectRoot);
      await assert.rejects(backend.getSprints(), /expired/i);
      assert.equal(backend.getConnectionState(), 'unauthorized');
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      t.mock.timers.tick(10 * 60_000);
      await assert.rejects(backend.getSprints());
      t.mock.timers.reset();
      assert.equal(hits, 0);
      assert.equal(backend.getConnectionState(), 'unauthorized');
    }
  );
});
