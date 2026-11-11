'use strict';

// (TPT9220) GET /api/agent-config carries this machine's device id for the requesting project's
// account: the board compares card attribution with it, so this machine's own runs carry no
// device badge. It comes from the device identity index.js hands to ws-handlers.js (the relay's),
// never from a DEVICE_ID setting, and a slow lookup never holds the board's startup for long.
//
// config.js reads these once at require time; pin them before ws-handlers.js loads it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-agent-config-device-'));
process.env.TIPATASK_PROJECT_ROOT = SCRATCH;
process.env.TIPATASK_USER_DATA = SCRATCH;
process.env.TASK_BACKEND = 'api';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHttpHandler, setDeviceIdentity } = require('./ws-handlers');

test.after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));
test.afterEach(() => setDeviceIdentity(null));

function fakeReq(url, project) {
  const req = { method: 'GET', url, headers: project ? { 'x-tipatask-project': project } : {} };
  req[Symbol.asyncIterator] = async function* () {};
  return req;
}
function fakeRes() {
  const res = { statusCode: null, body: '', writeHead(s) { res.statusCode = s; }, end(c) { res.body = c || ''; } };
  return res;
}

const CREDENTIALS = { baseUrl: 'https://api.example.test', projectId: '2', token: 'h.e30.s' };
const apiBackend = { getCredentials: () => CREDENTIALS, getCurrentUserId: async () => 1 };
const signedOut = { getCredentials() { throw new Error('API_BASE_URL is not set'); }, getCurrentUserId: async () => null };
const backends = new Map([['/projects/api', apiBackend], ['/projects/none', signedOut]]);
const handler = createHttpHandler(new Map(), () => signedOut, { getBackendForPath: projectPath => backends.get(projectPath) });

async function agentConfig(project) {
  const res = fakeRes();
  await handler(fakeReq('/api/agent-config', project), res);
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body);
}

function identity(answer) {
  const calls = [];
  return { calls, deviceIdForAccount: credentials => { calls.push(credentials); return answer(credentials); } };
}

test("answers this machine's device for the requesting project's account", async () => {
  const found = identity(async () => 7);
  setDeviceIdentity(found);
  const body = await agentConfig('/projects/api');
  assert.equal(body.deviceId, 7);
  assert.equal(body.currentUserId, 1);
  assert.deepEqual(found.calls, [CREDENTIALS], "asked with that project's own credentials");
});

test('answers null with no identity, an unknown device, or a project with no API target', async () => {
  assert.equal((await agentConfig('/projects/api')).deviceId, null, 'no identity handed over');
  const unknown = identity(async () => null);
  setDeviceIdentity(unknown);
  assert.equal((await agentConfig('/projects/api')).deviceId, null);
  const before = unknown.calls.length;
  assert.equal((await agentConfig('/projects/none')).deviceId, null);
  assert.equal(unknown.calls.length, before, 'no lookup without credentials');
});

test('a lookup that has not answered after two seconds answers null instead of holding up the board', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setDeviceIdentity(identity(() => new Promise(() => {})));
  let body = null;
  const res = fakeRes();
  const done = handler(fakeReq('/api/agent-config', '/projects/api'), res).then(() => { body = JSON.parse(res.body); });
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(body, null, 'still waiting for the lookup');
  t.mock.timers.tick(2000);
  await done;
  assert.equal(body.deviceId, null);
  assert.equal(body.currentUserId, 1);
});

// (TPT9223) Opening a board also releases the claims runs on this machine left open in its
// project, through this machine's claim registry and the real HTTP client, once per process.
test('opening a board releases the claims runs on this machine left open in its project, once', async (t) => {
  const http = require('node:http');
  const { createDeviceClaimRegistry } = require('./device-claim-registry');
  const requests = [];
  const api = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tasks: [
        { task_key: 'TPT5', active_device: { id: 7, name: 'studio', state: 'disconnected' } },
        { task_key: 'TPT6', active_device: { id: 8, name: 'laptop', state: 'disconnected' } },
        { task_key: 'TPT7', active_device: null },
      ] }));
    }
    res.writeHead(204);
    res.end();
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => api.close(resolve)));
  const local = { getCredentials: () => ({ baseUrl: `http://127.0.0.1:${api.address().port}`, projectId: '2', token: 'h.e30.s' }), getCurrentUserId: async () => 1 };
  backends.set('/projects/local', local);
  t.after(() => backends.delete('/projects/local'));
  setDeviceIdentity(identity(async () => 7), createDeviceClaimRegistry({ directory: path.join(SCRATCH, 'claims'), log: { warn() {} } }));
  assert.equal((await agentConfig('/projects/local')).deviceId, 7);
  for (let i = 0; i < 300 && !requests.some(line => line.startsWith('DELETE')); i++) await new Promise(resolve => setTimeout(resolve, 10));
  await agentConfig('/projects/local');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(requests, [
    'GET /api/projects/2/tasks?fields=summary&include_children_count=false',
    'DELETE /api/projects/2/tasks/TPT5/device-sessions/7',
  ], "only this device's claim, and only once");
});
