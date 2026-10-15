'use strict';

// A reverse proxy in front of the API (production: Apache) answers 502/503/504 when the API
// process behind it is down. api-backend.js treats those like a transport failure: the write
// is queued and resolved optimistically, the backend goes 'disconnected', and the reconnect
// probe replays the queue once the API answers again. A real 500 from the app stays a plain
// error — a bug, not an outage.

process.env.TIPATASK_PROJECT_ROOT = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'tt-gateway-global-')
);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tokens live only in the app-level account store under TIPATASK_USER_DATA. Give this file
// its own, so parallel test files never race on one shared store file.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-gateway-offline-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const { createApiBackend } = require('./api-backend');

const APACHE_503 = '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n'
  + '<title>503 Service Unavailable</title>\n</head><body>\n<h1>Service Unavailable</h1>\n'
  + '<p>The server is temporarily unable to service your request.</p>\n</body></html>\n';

// Fake API whose behaviour flips at runtime: 'ok' answers like the real API, 'gateway'
// answers every request the way a proxy does with the API down, 'crash' answers a real 500.
function fakeApi() {
  const state = { mode: 'ok', gatewayStatus: 503, patches: [], requests: 0 };
  const handler = (req, res) => {
    state.requests += 1;
    if (state.mode === 'gateway') {
      res.writeHead(state.gatewayStatus, { 'Content-Type': 'text/html; charset=iso-8859-1' });
      return res.end(APACHE_503);
    }
    if (state.mode === 'crash') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname.endsWith('/tasks')) {
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
    if (req.method === 'GET' && url.pathname.endsWith('/sprints')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ sprints: [] }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  };
  return { state, handler };
}

async function withFakeApi(run) {
  const api = fakeApi();
  const server = http.createServer(api.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-gateway-project-'));
  fs.mkdirSync(path.join(projectRoot, '.tipatask'));
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    API_TOKEN: 'opaque-token',
    API_PROJECT_ID: '1',
  }));
  try {
    await run(api.state, projectRoot);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// Every case below arms the reconnect backoff timer at some point; mock setTimeout so no
// live timer outlives the test and the probe runs only when the test fires it.
async function connectedBackend(t, projectRoot) {
  const backend = createApiBackend(null, projectRoot);
  const states = [];
  backend.onConnectionStateChange((s) => states.push(s));
  await backend.init();
  assert.equal(backend.getConnectionState(), 'connected');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  return { backend, states };
}

test('a 503 from the reverse proxy queues the write, resolves optimistically and disconnects', (t) => withFakeApi(async (api, projectRoot) => {
  const { backend, states } = await connectedBackend(t, projectRoot);
  api.mode = 'gateway';

  const result = await backend.updateTask('C1', { title: 'after' });
  assert.equal(result._pendingSync, true, 'write resolves as a pending-sync row, not an error');
  assert.equal(result.title, 'after');
  assert.equal(backend.getPendingMutationCount(), 1);
  assert.ok(['disconnected', 'reconnecting'].includes(backend.getConnectionState()), backend.getConnectionState());
  assert.ok(states.includes('disconnected'), `states: ${states.join(',')}`);
  assert.equal(api.patches.length, 0, 'nothing reached the API while the proxy answered 503');

  await assert.rejects(backend.getSprints(), (err) => {
    assert.equal(err.networkError, true);
    assert.equal(err.retryable, true);
    assert.equal(err.statusCode, 503);
    assert.equal(err.code, undefined, 'no transport code: the socket worked, the API did not');
    assert.equal(err.message, 'API 503: Service Unavailable', 'HTML error page replaced by the reason phrase');
    assert.equal(err.body, APACHE_503, 'raw body still available');
    return true;
  });
}));

// Fire the armed reconnect timer (production runs the probe from its callback, which is what
// clears the timer handle) and let the probe's real HTTP round trip settle. setTimeout is
// mocked, so the wait is a bounded setImmediate loop on an observable instead.
async function fireReconnect(t, ms, settled) {
  t.mock.timers.tick(ms);
  for (let i = 0; i < 2000 && !settled(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(settled(), 'probe did not settle');
}

test('the reconnect probe stays down on 503 and replays the queue once the API answers again', (t) => withFakeApi(async (api, projectRoot) => {
  const { backend } = await connectedBackend(t, projectRoot);
  const drained = [];
  backend.onMutationsDrained((rows, remaining) => drained.push({ rows, remaining }));
  api.mode = 'gateway';
  await backend.updateTask('C1', { title: 'after' });
  assert.equal(backend.getPendingMutationCount(), 1);
  assert.equal(backend.getConnectionState(), 'reconnecting', 'disconnect armed the backoff');

  // First backoff (2s) fires while the proxy still answers 503: the probe re-arms, nothing
  // replays, still not connected.
  const before = api.requests;
  await fireReconnect(t, 2000, () => api.requests > before);
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal(backend.getConnectionState(), 'reconnecting');
  assert.equal(backend.getPendingMutationCount(), 1);
  assert.equal(api.patches.length, 0);

  // API is back; the next backoff (4s) is the same probe path that recovers from
  // ECONNREFUSED: it drains the queue and announces 'connected'.
  api.mode = 'ok';
  await fireReconnect(t, 4000, () => backend.getConnectionState() === 'connected');
  assert.equal(backend.getPendingMutationCount(), 0);
  assert.deepEqual(api.patches, [{ title: 'after' }]);
  assert.equal(drained.length, 1);
  assert.equal(drained[0].remaining, 0);
  assert.equal(drained[0].rows[0].id, 'C1');
  assert.equal(drained[0].rows[0].title, 'after');
}));

test('502 and 504 are flagged the same way as 503', (t) => withFakeApi(async (api, projectRoot) => {
  const { backend } = await connectedBackend(t, projectRoot);
  api.mode = 'gateway';
  for (const status of [502, 504]) {
    api.gatewayStatus = status;
    await assert.rejects(backend.getSprints(), (err) => {
      assert.equal(err.networkError, true, String(status));
      assert.equal(err.retryable, true, String(status));
      assert.equal(err.statusCode, status);
      assert.equal(err.message, `API ${status}: ${http.STATUS_CODES[status]}`);
      return true;
    });
  }
}));

test('a real 500 from the API stays a plain error: nothing queued, still connected', (t) => withFakeApi(async (api, projectRoot) => {
  const { backend, states } = await connectedBackend(t, projectRoot);
  api.mode = 'crash';

  await assert.rejects(backend.updateTask('C1', { title: 'after' }), (err) => {
    assert.equal(err.statusCode, 500);
    assert.equal(err.networkError, undefined);
    assert.equal(err.retryable, undefined);
    assert.match(err.message, /^API 500: /);
    return true;
  });
  assert.equal(backend.getPendingMutationCount(), 0);
  assert.equal(backend.getConnectionState(), 'connected');
  assert.deepEqual(states, ['connected']);
}));
