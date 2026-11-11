'use strict';

// (TPT9217) The relay's device id comes from this machine's id, through the account's own device
// rows, and the device is linked to every opted-in project before the relay may use it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDeviceIdentity, readOrCreateMachineId } = require('./device-identity');

const BASE = 'https://api.example.test';
const token = (id, extra = {}) => `h.${Buffer.from(JSON.stringify({ id, exp: 9999999999, ...extra })).toString('base64url')}.s`;
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

function scratchMachineId(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.tipatask', 'device_id');
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return file;
}

// A stand-in API holding one user's device rows; it answers from what the requests carry.
function fakeApi(devices = []) {
  const calls = [];
  let nextId = 100;
  let failing = null;
  const request = async (url, opts) => {
    const { pathname } = new URL(url);
    const userId = JSON.parse(Buffer.from(opts.headers.Authorization.split('.')[1], 'base64url')).id;
    calls.push({ method: opts.method, pathname, body: opts.body, userId });
    if (failing) return { status: failing, data: { error: 'nope' } };
    if (opts.method === 'GET' && pathname === '/api/devices') {
      return { status: 200, data: { devices: devices.filter(d => d.user_id === userId).map(d => ({ ...d, project_ids: [...d.project_ids] })) } };
    }
    if (opts.method === 'POST' && pathname === '/api/devices') {
      const device = { id: nextId++, user_id: userId, name: opts.body.name, machine_id: opts.body.machine_id, project_ids: [] };
      devices.push(device);
      const { project_ids, ...row } = device; // the real route answers with the bare row
      return { status: 201, data: { device: row } };
    }
    const link = pathname.match(/^\/api\/devices\/(\d+)\/projects$/);
    if (opts.method === 'POST' && link) {
      const device = devices.find(d => d.id === Number(link[1]) && d.user_id === userId);
      if (!device) return { status: 404, data: { error: 'Device not found' } };
      if (!device.project_ids.includes(opts.body.project_id)) device.project_ids.push(opts.body.project_id);
      return { status: 201, data: { device_id: device.id, project_id: opts.body.project_id } };
    }
    return { status: 404, data: {} };
  };
  return { request, calls, devices, fail(status) { failing = status; } };
}

const backendFor = (credentials) => ({ getCredentials: () => credentials });

function setup(t, { devices, machineId = 'machine-a', ...options } = {}) {
  const api = fakeApi(devices);
  const warnings = [];
  let changes = 0;
  let clock = 1_000_000;
  const identity = createDeviceIdentity({
    request: api.request,
    machineIdPath: scratchMachineId(t, machineId),
    hostname: () => 'studio.local',
    now: () => clock,
    log: { warn: line => warnings.push(line) },
    onChange: () => { changes++; },
    ...options,
  });
  return { identity, api, warnings, changes: () => changes, advance(ms) { clock += ms; } };
}

test("finds this machine's linked device by machine id and writes nothing", async t => {
  const h = setup(t, { devices: [
    { id: 2, user_id: 1, machine_id: 'machine-b', project_ids: [5] },
    { id: 1, user_id: 1, machine_id: 'machine-a', project_ids: [5, 9] },
  ] });
  // config.json's DEVICE_ID plays no part: the backend is all the resolver reads.
  const backend = backendFor({ baseUrl: BASE, projectId: '5', token: token(1) });
  assert.equal(h.identity.deviceIdFor({ backend }), null, 'unknown until the API answers');
  await settle();
  assert.equal(h.changes(), 1);
  assert.equal(h.identity.deviceIdFor({ backend }), 1);
  assert.deepEqual(h.api.calls.map(c => `${c.method} ${c.pathname}`), ['GET /api/devices']);
});

test('links the device to an opted-in project it does not serve yet, once', async t => {
  const h = setup(t, { devices: [{ id: 1, user_id: 1, machine_id: 'machine-a', project_ids: [5] }] });
  const backend = backendFor({ baseUrl: BASE, projectId: '9', token: token(1) });
  h.identity.deviceIdFor({ backend });
  h.identity.deviceIdFor({ backend }); // a second read while the first is in flight starts nothing
  await settle();
  assert.equal(h.identity.deviceIdFor({ backend }), 1);
  assert.deepEqual(h.api.calls.map(c => `${c.method} ${c.pathname}`), ['GET /api/devices', 'POST /api/devices/1/projects']);
  assert.deepEqual(h.api.calls[1].body, { project_id: 9 });
  assert.deepEqual(h.api.devices[0].project_ids, [5, 9]);
});

test('registers this machine when the account has no device for it, then links it', async t => {
  const h = setup(t, { devices: [{ id: 1, user_id: 1, machine_id: 'machine-other', project_ids: [5] }] });
  const backend = backendFor({ baseUrl: BASE, projectId: '5', token: token(1) });
  h.identity.deviceIdFor({ backend });
  await settle();
  assert.equal(h.identity.deviceIdFor({ backend }), 100);
  assert.deepEqual(h.api.calls.map(c => `${c.method} ${c.pathname}`), ['GET /api/devices', 'POST /api/devices', 'POST /api/devices/100/projects']);
  assert.deepEqual(h.api.calls[1].body, { name: 'studio.local', machine_id: 'machine-a' });
});

test('one lookup per account; another account on the same machine has its own device', async t => {
  const h = setup(t, { devices: [
    { id: 1, user_id: 1, machine_id: 'machine-a', project_ids: [5, 6] },
    { id: 7, user_id: 2, machine_id: 'machine-a', project_ids: [5] },
  ] });
  const mine = id => backendFor({ baseUrl: BASE, projectId: String(id), token: token(1) });
  h.identity.deviceIdFor({ backend: mine(5) });
  h.identity.deviceIdFor({ backend: mine(6) });
  await settle();
  assert.equal(h.identity.deviceIdFor({ backend: mine(5) }), 1);
  assert.equal(h.identity.deviceIdFor({ backend: mine(6) }), 1);
  assert.equal(h.api.calls.filter(c => c.method === 'GET').length, 1, 'both projects share one lookup');
  // Token renewal keeps the account: the same user id on a fresh token reuses the answer.
  assert.equal(h.identity.deviceIdFor({ backend: backendFor({ baseUrl: BASE, projectId: '5', token: token(1, { exp: 1 }) }) }), 1);
  const theirs = backendFor({ baseUrl: BASE, projectId: '5', token: token(2) });
  assert.equal(h.identity.deviceIdFor({ backend: theirs }), null);
  await settle();
  assert.equal(h.identity.deviceIdFor({ backend: theirs }), 7);
});

test('a failure stays null, logs once per streak without secrets, and retries only after the delay', async t => {
  const h = setup(t, { devices: [{ id: 1, user_id: 1, machine_id: 'machine-a', project_ids: [5] }], retryMs: 60_000 });
  const credentials = { baseUrl: BASE, projectId: '5', token: token(1) };
  const backend = backendFor(credentials);
  h.api.fail(503);
  h.identity.deviceIdFor({ backend });
  await settle();
  assert.equal(h.identity.deviceIdFor({ backend }), null);
  assert.equal(h.api.calls.length, 1, 'no retry inside the delay');
  h.advance(60_000);
  h.identity.deviceIdFor({ backend });
  await settle();
  assert.equal(h.api.calls.length, 2);
  assert.equal(h.warnings.length, 1, 'the same failure is not logged again');
  assert.match(h.warnings[0], /could not look up this machine's device for project 5 \(HTTP 503\)/);
  assert.ok(!h.warnings[0].includes(credentials.token));
  assert.equal(h.changes(), 0);
  h.api.fail(null);
  h.advance(60_000);
  h.identity.deviceIdFor({ backend });
  await settle();
  assert.equal(h.identity.deviceIdFor({ backend }), 1);
  assert.equal(h.changes(), 1);
});

test('unusable credentials resolve nothing and never throw', async t => {
  const h = setup(t);
  assert.equal(h.identity.deviceIdFor({ backend: { getCredentials() { throw new Error('signed out'); } } }), null);
  assert.equal(h.identity.deviceIdFor({ backend: backendFor({ baseUrl: BASE, projectId: '', token: token(1) }) }), null);
  assert.equal(h.identity.deviceIdFor({ backend: backendFor({ baseUrl: BASE, projectId: '5', token: 'not-a-jwt' }) }), null);
  assert.equal(h.identity.deviceIdFor({ backend: backendFor({ baseUrl: 'not a url', projectId: '5', token: token(1) }) }), null);
  await settle();
  assert.equal(h.api.calls.length, 0);
});

test('registration and linking recover from failures without borrowing another account device', async t => {
  for (const failedStep of ['register', 'link']) {
    const api = fakeApi([{ id: 7, user_id: 2, machine_id: 'machine-a', project_ids: [5] }]);
    let failing = true;
    const h = setup(t, { request: (url, opts) => {
      const step = opts.method === 'GET' ? 'lookup' : new URL(url).pathname === '/api/devices' ? 'register' : 'link';
      return failing && step === failedStep ? { status: 503, data: {} } : api.request(url, opts);
    } });
    const backend = backendFor({ baseUrl: BASE, projectId: '5', token: token(1) });
    h.identity.deviceIdFor({ backend });
    await settle();
    assert.equal(h.identity.deviceIdFor({ backend }), null, failedStep);
    assert.equal(h.changes(), 0);
    failing = false;
    h.advance(60_000);
    h.identity.deviceIdFor({ backend });
    await settle();
    assert.equal(h.identity.deviceIdFor({ backend }), 100);
    assert.equal(h.changes(), 1);
    assert.deepEqual(api.devices.find(d => d.id === 7).project_ids, [5]);
    assert.equal(api.devices.filter(d => d.user_id === 1).length, 1, 'successful registration is reused after link failure');
  }
});

test('a proxy redirect or HTML success cannot certify registration or a project link', async t => {
  for (const step of ['lookup', 'register', 'link']) {
    for (const bad of [{ status: 302, data: {} }, { status: 200, data: '<html>Sign in</html>' }]) {
      const api = fakeApi();
      let failing = true;
      const h = setup(t, { request: (url, opts) => {
        const called = opts.method === 'GET' ? 'lookup' : new URL(url).pathname === '/api/devices' ? 'register' : 'link';
        return failing && called === step ? bad : api.request(url, opts);
      } });
      const backend = backendFor({ baseUrl: BASE, projectId: '5', token: token(1) });
      h.identity.deviceIdFor({ backend });
      await settle();
      assert.equal(h.identity.deviceIdFor({ backend }), null, `${step}: ${bad.status}`);
      assert.equal(h.changes(), 0);
      failing = false;
      h.advance(60_000);
      h.identity.deviceIdFor({ backend });
      await settle();
      assert.equal(h.identity.deviceIdFor({ backend }), 100);
    }
  }
});

// (TPT9220) Run attribution asks for the same device, for any API project, without a link.
test("deviceIdForAccount finds this machine's device without linking it, once per account", async t => {
  const h = setup(t, { devices: [
    { id: 2, user_id: 1, machine_id: 'machine-b', project_ids: [5] },
    { id: 1, user_id: 1, machine_id: 'machine-a', project_ids: [] },
  ] });
  const credentials = { baseUrl: BASE, projectId: '5', token: token(1) };
  const [first, second] = await Promise.all([h.identity.deviceIdForAccount(credentials), h.identity.deviceIdForAccount(credentials)]);
  assert.deepEqual([first, second], [1, 1]);
  assert.equal(await h.identity.deviceIdForAccount({ ...credentials, projectId: '9', token: token(1, { exp: 1 }) }), 1, 'another project, a renewed token');
  assert.deepEqual(h.api.calls.map(c => `${c.method} ${c.pathname}`), ['GET /api/devices'], 'one lookup, no link');
  assert.deepEqual(h.api.devices[1].project_ids, []);
  assert.equal(h.changes(), 0, 'the relay is not told: nothing it serves changed');
});

test('deviceIdForAccount shares the relay lookup and registers this machine when the account has none', async t => {
  const h = setup(t, { devices: [] });
  const credentials = { baseUrl: BASE, projectId: '5', token: token(1) };
  assert.equal(h.identity.deviceIdFor({ backend: backendFor(credentials) }), null);
  assert.equal(await h.identity.deviceIdForAccount(credentials), 100);
  await settle();
  assert.deepEqual(h.api.calls.map(c => `${c.method} ${c.pathname}`), ['GET /api/devices', 'POST /api/devices', 'POST /api/devices/100/projects'],
    'the relay links its project; attribution adds no request of its own');
  assert.deepEqual(h.api.calls[1].body, { name: 'studio.local', machine_id: 'machine-a' });
});

test('deviceIdForAccount resolves null on a failure, logs it once without secrets, and the next call retries', async t => {
  const h = setup(t, { devices: [{ id: 1, user_id: 1, machine_id: 'machine-a', project_ids: [] }] });
  const credentials = { baseUrl: BASE, projectId: '5', token: token(1) };
  h.api.fail(503);
  assert.equal(await h.identity.deviceIdForAccount(credentials), null);
  assert.equal(await h.identity.deviceIdForAccount(credentials), null);
  assert.equal(h.api.calls.length, 2, 'each call looks up again');
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /^\[device-session\] could not look up this machine's device \(HTTP 503\)/);
  assert.ok(!h.warnings[0].includes(credentials.token));
  h.api.fail(null);
  assert.equal(await h.identity.deviceIdForAccount(credentials), 1);
  h.api.fail(503);
  assert.equal(await h.identity.deviceIdForAccount(credentials), 1, 'a found device is kept: no further request');
  assert.equal(h.api.calls.length, 3);
});

test('deviceIdForAccount resolves null for unusable credentials without a request', async t => {
  const h = setup(t);
  for (const credentials of [undefined, {}, { baseUrl: BASE, token: 'not-a-jwt' }, { baseUrl: 'not a url', token: token(1) }]) {
    assert.equal(await h.identity.deviceIdForAccount(credentials), null);
  }
  assert.equal(h.api.calls.length, 0);
});

test('the machine id file is reused, created when missing, and never overwritten', t => {
  const existing = scratchMachineId(t, 'kept-id\n');
  assert.equal(readOrCreateMachineId(existing), 'kept-id');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'kept-id\n');
  const missing = scratchMachineId(t);
  const created = readOrCreateMachineId(missing);
  assert.match(created, /^[0-9a-f-]{36}$/);
  assert.equal(readOrCreateMachineId(missing), created);
  const empty = scratchMachineId(t, '');
  assert.throws(() => readOrCreateMachineId(empty), { code: 'machine_id_unavailable' });
});
