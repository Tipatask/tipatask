'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDeviceSessionLifecycle } = require('./device-session-lifecycle');
const { createDeviceIdentity } = require('./device-identity');

const BASE = 'https://api.test';
const token = id => `h.${Buffer.from(JSON.stringify({ id, exp: 9999999999 })).toString('base64url')}.s`;
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const route = call => `${call.method} ${call.pathname}`;

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-session-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A project checkout; `cfg` is what its .tipatask/config.json holds.
function project(t, cfg) {
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, '.tipatask'));
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg));
  return dir;
}

// One stand-in API for both the device lookup and the claims, so every request lands in one
// ordered list. `devices` are the signed-in account's rows; `holdLookup` parks GET /api/devices
// until release() is called.
function fakeApi({ devices = [], holdLookup = false, lookupStatus = 200 } = {}) {
  const calls = [];
  let release = () => {};
  let gate = holdLookup ? new Promise(resolve => { release = resolve; }) : null;
  const request = async (url, opts) => {
    const { pathname } = new URL(url);
    calls.push({ method: opts.method, pathname, body: opts.body });
    if (pathname === '/api/devices' && opts.method === 'GET') {
      if (gate) await gate;
      if (api.lookupStatus >= 400) return { status: api.lookupStatus, data: { error: 'nope' } };
      return { status: 200, data: { devices } };
    }
    if (/\/device-sessions$/.test(pathname) && opts.method === 'POST') return { status: 201, data: { id: 1 } };
    if (/\/device-sessions\/\d+$/.test(pathname) && opts.method === 'DELETE') return { status: 204, data: null };
    return { status: 404, data: {} };
  };
  const api = { request, calls, lookupStatus, release: () => { gate = null; release(); } };
  return api;
}

// The production pairing: the lifecycle names whatever device this machine's identity resolves.
function setup(t, apiOptions) {
  const api = fakeApi(apiOptions);
  const machineIdPath = path.join(scratch(t), 'device_id');
  fs.writeFileSync(machineIdPath, 'machine-a\n');
  const warnings = [];
  const log = { warn: line => warnings.push(line) };
  const identity = createDeviceIdentity({ request: api.request, machineIdPath, hostname: () => 'studio.local', log });
  const lifecycle = createDeviceSessionLifecycle({ httpRequest: api.request, resolveDeviceId: identity.deviceIdForAccount, log });
  return { api, lifecycle, warnings };
}

const THIS_MACHINE = { id: 7, machine_id: 'machine-a', project_ids: [] }; // linked to no project
const OTHER_MACHINE = { id: 99, machine_id: 'machine-b', project_ids: [2] };
const backendFor = (userId = 1) => ({ getCredentials: () => ({ baseUrl: BASE, projectId: '2', token: token(userId) }) });
const run = projectPath => ({ type: 'terminal', alive: true, pty: {}, projectPath });

test("a project without DEVICE_ID claims and releases with this machine's device, without linking it", async t => {
  const h = setup(t, { devices: [OTHER_MACHINE, THIS_MACHINE] });
  const session = run(project(t, { API_BASE_URL: BASE, API_PROJECT_ID: '2' }));
  await h.lifecycle.postDeviceSession(session, 'TPT1', backendFor());
  await h.lifecycle.deleteDeviceSession(session);
  assert.deepEqual(h.api.calls.map(route), [
    'GET /api/devices',
    'POST /api/projects/2/tasks/TPT1/device-sessions',
    'DELETE /api/projects/2/tasks/TPT1/device-sessions/7',
  ], 'the claim needs no link: the API only checks that the device is the account\'s own');
  assert.deepEqual(h.api.calls[1].body, { device_id: 7 });
  assert.equal(h.lifecycle.deleteDeviceSession(session), undefined, 'released once');
});

test("another machine's DEVICE_ID in config.json is not used", async t => {
  const h = setup(t, { devices: [OTHER_MACHINE, THIS_MACHINE] });
  // A config.json committed on machine-b travels with every clone.
  const session = run(project(t, { API_BASE_URL: BASE, API_PROJECT_ID: '2', DEVICE_ID: 99 }));
  await h.lifecycle.postDeviceSession(session, 'TPT1', backendFor());
  await h.lifecycle.deleteDeviceSession(session);
  const claims = h.api.calls.filter(call => call.pathname.includes('/device-sessions'));
  assert.deepEqual(claims.map(route), ['POST /api/projects/2/tasks/TPT1/device-sessions', 'DELETE /api/projects/2/tasks/TPT1/device-sessions/7']);
  assert.deepEqual(claims[0].body, { device_id: 7 });
});

test('no lookup happens for a project with no API target', async t => {
  const h = setup(t, { devices: [THIS_MACHINE] });
  const signedOut = { getCredentials() { throw Object.assign(new Error('API_BASE_URL is not set'), { code: 'missing_credential' }); } };
  for (const backend of [signedOut, {}]) {
    const session = run(project(t, { DEVICE_ID: 7 }));
    assert.equal(h.lifecycle.postDeviceSession(session, 'TPT1', backend), undefined);
    assert.equal(h.lifecycle.deleteDeviceSession(session), undefined);
  }
  await settle();
  assert.deepEqual(h.api.calls, []);
});

test('a run that starts before the lookup answers is claimed once it does; exit and restart stay ordered', async t => {
  const h = setup(t, { devices: [THIS_MACHINE], holdLookup: true });
  const session = run(project(t, {}));
  const claim = h.lifecycle.postDeviceSession(session, 'TPT1', backendFor());
  const release = h.lifecycle.deleteDeviceSession(session); // exits while the lookup is in flight
  const restart = h.lifecycle.postDeviceSession({ ...run(session.projectPath) }, 'TPT1', backendFor());
  await settle();
  assert.deepEqual(h.api.calls.map(route), ['GET /api/devices'], 'nothing is claimed or released before the device is known');
  h.api.release();
  await Promise.all([claim, release, restart]);
  assert.deepEqual(h.api.calls.map(route), [
    'GET /api/devices',
    'POST /api/projects/2/tasks/TPT1/device-sessions',
    'DELETE /api/projects/2/tasks/TPT1/device-sessions/7',
    'POST /api/projects/2/tasks/TPT1/device-sessions',
  ], 'one lookup serves both runs; the claim is sent, not dropped');
  assert.deepEqual(h.api.calls.filter(call => call.method === 'POST').map(call => call.body), [{ device_id: 7 }, { device_id: 7 }]);
});

test('a failed lookup claims and releases nothing, is logged once, and the next run looks up again', async t => {
  const h = setup(t, { devices: [THIS_MACHINE], lookupStatus: 503 });
  for (let i = 0; i < 2; i++) {
    const session = run(project(t, {}));
    await h.lifecycle.postDeviceSession(session, 'TPT1', backendFor());
    await h.lifecycle.deleteDeviceSession(session);
  }
  assert.deepEqual(h.api.calls.map(route), ['GET /api/devices', 'GET /api/devices']);
  assert.equal(h.warnings.length, 1, 'the same failure is not logged again');
  assert.match(h.warnings[0], /^\[device-session\] could not look up this machine's device \(HTTP 503\)/);
  h.api.lookupStatus = 200;
  const session = run(project(t, {}));
  await h.lifecycle.postDeviceSession(session, 'TPT1', backendFor());
  assert.deepEqual(h.api.calls.slice(2).map(route), ['GET /api/devices', 'POST /api/projects/2/tasks/TPT1/device-sessions']);
});

test('fast exit and restart serialize POST DELETE POST behind a slow claim', async () => {
  const calls = [];
  let finishClaim;
  const lifecycle = createDeviceSessionLifecycle({ resolveDeviceId: () => 42, httpRequest: async (url, opts) => {
    calls.push({ url, ...opts });
    if (calls.length === 1) await new Promise(resolve => { finishClaim = resolve; });
  } });
  const backend = { getCredentials: () => ({ baseUrl: BASE, projectId: 2, token: 'private' }) };
  const session = { type: 'terminal', alive: true, pty: {}, projectPath: '/project' };
  lifecycle.postDeviceSession(session, 'TPT1', backend);
  await settle();
  assert.equal(calls[0].body.device_id, 42);
  const release = lifecycle.deleteDeviceSession(session);
  const next = lifecycle.postDeviceSession({ ...session }, 'TPT1', backend);
  await settle();
  assert.deepEqual(calls.map(c => c.method), ['POST']);
  finishClaim(); await release; await next;
  assert.deepEqual(calls.map(c => c.method), ['POST', 'DELETE', 'POST']);
  assert.match(calls[1].url, /device-sessions\/42$/);
  assert.equal(lifecycle.deleteDeviceSession(session), undefined);
});

test('a failed claim still releases; viewers and non-process sessions never own a claim', async () => {
  const calls = [];
  const warnings = [];
  const lifecycle = createDeviceSessionLifecycle({ resolveDeviceId: async () => 1, log: { warn: line => warnings.push(line) },
    httpRequest: async (_url, opts) => { calls.push(opts.method); if (opts.method === 'POST') throw new Error('offline'); } });
  const backend = { getCredentials: () => ({ baseUrl: BASE, projectId: 2, token: 'private' }) };
  const session = { type: 'terminal', alive: true, pty: {}, ws: { readyState: 1 } };
  await lifecycle.postDeviceSession(session, 'TPT1', backend);
  session.ws = null;
  assert.deepEqual(calls, ['POST']);
  await lifecycle.deleteDeviceSession(session); assert.deepEqual(calls, ['POST', 'DELETE']);
  assert.deepEqual(warnings, ['[device-session] API attribution update failed'], 'logged without credentials');
  for (const shape of [{ type: 'objective', alive: true, pty: {} }, { type: 'terminal', alive: false }, { type: 'terminal', alive: true }]) {
    assert.equal(lifecycle.postDeviceSession(shape, 'TPT1', backend), undefined);
  }
});

test('a refused claim is logged with its status only', async () => {
  const warnings = [];
  const lifecycle = createDeviceSessionLifecycle({ resolveDeviceId: () => 5, log: { warn: line => warnings.push(line) },
    httpRequest: async (_url, opts) => (opts.method === 'POST' ? { status: 409, data: { code: 'task_claimed' } } : { status: 204 }) });
  const backend = { getCredentials: () => ({ baseUrl: BASE, projectId: 2, token: 'private' }) };
  const session = { type: 'terminal', alive: true, pty: {} };
  await lifecycle.postDeviceSession(session, 'TPT1', backend);
  await lifecycle.deleteDeviceSession(session);
  assert.deepEqual(warnings, ['[device-session] the API refused the claim for TPT1 (HTTP 409)']);
});

// ── (TPT9223) Claims runs on this machine left open when their server exited ──

const { createDeviceClaimRegistry } = require('./device-claim-registry');

// A stand-in API for one project's claims: `active` maps a task key to the device id holding it
// (or { id, state } for a claim the relay reports a session for). The task list reports them as
// active_device; a legacy POST is idempotent for the claim's own device and 409 for another; a
// legacy DELETE ends that device's claim. `gateDelete` parks the first DELETE until opened.
function claimsApi({ active = {}, gateDelete = false } = {}) {
  const calls = [];
  const claims = new Map(Object.entries(active).map(([key, value]) => [key, typeof value === 'number' ? { id: value } : value]));
  let open = () => {};
  const gate = gateDelete ? new Promise(resolve => { open = resolve; }) : null;
  let gated = false;
  const api = {
    calls, claims, listStatus: 200, deleteStatus: 204, open: () => open(),
    async request(url, opts) {
      const { pathname, search } = new URL(url);
      calls.push({ method: opts.method, pathname, search, body: opts.body });
      if (opts.method === 'GET' && pathname === '/api/projects/2/tasks') {
        if (api.listStatus >= 400) return { status: api.listStatus, data: { error: 'nope' } };
        const keys = new Set(['TPT1', 'TPT2', 'TPT3', 'TPT4', ...claims.keys()]);
        return { status: 200, data: { tasks: [...keys].sort().map(task_key => {
          const claim = claims.get(task_key);
          return { task_key, active_device: claim ? { id: claim.id, name: 'studio', state: claim.state || 'disconnected' } : null };
        }) } };
      }
      const claimed = pathname.match(/^\/api\/projects\/2\/tasks\/([^/]+)\/device-sessions$/);
      if (claimed && opts.method === 'POST') {
        const current = claims.get(claimed[1]);
        if (current && current.id !== opts.body.device_id) return { status: 409, data: { code: 'task_claimed' } };
        if (!current) claims.set(claimed[1], { id: opts.body.device_id });
        return { status: 201, data: { id: 1 } };
      }
      const released = pathname.match(/^\/api\/projects\/2\/tasks\/([^/]+)\/device-sessions\/(\d+)$/);
      if (released && opts.method === 'DELETE') {
        if (gate && !gated) { gated = true; await gate; }
        if (api.deleteStatus >= 400) return { status: api.deleteStatus, data: {} };
        if (claims.get(released[1])?.id === Number(released[2])) claims.delete(released[1]);
        return { status: 204, data: null };
      }
      return { status: 404, data: {} };
    },
  };
  return api;
}

// Task App servers of one OS user on one machine: they share the claim registry directory and,
// through ~/.tipatask/device_id, device 7. `running` holds the pids of those still running.
function claimsMachine(t, api) {
  const directory = scratch(t);
  const running = new Set();
  const lines = [];
  const log = { warn: line => lines.push(line), log: line => lines.push(line) };
  const server = (pid, { deviceId = 7, registry = true } = {}) => {
    running.add(pid);
    const claimRegistry = registry ? createDeviceClaimRegistry({ directory, pid, alive: candidate => running.has(candidate), log }) : null;
    const lookups = [];
    const lifecycle = createDeviceSessionLifecycle({
      httpRequest: api.request, log, getClaimRegistry: () => claimRegistry,
      resolveDeviceId: async (credentials) => { lookups.push(credentials); return deviceId; },
      sleep: () => new Promise(resolve => setImmediate(resolve)),
    });
    return { lifecycle, lookups, registry: claimRegistry, exit() { running.delete(pid); } };
  };
  return { server, running, lines, directory };
}

const sessionCalls = api => api.calls.filter(call => call.method !== 'GET').map(route);
const listCalls = api => api.calls.filter(call => call.method === 'GET').map(call => `${route(call)}${call.search}`);

test('a claim a run left open when its server exited is released once', async t => {
  const api = claimsApi({ active: { TPT1: 7 } });
  const m = claimsMachine(t, api);
  const { lifecycle } = m.server(101);
  const first = lifecycle.releaseStaleClaims(backendFor());
  assert.equal(lifecycle.releaseStaleClaims(backendFor()), first, 'calls during a pass share it');
  assert.equal(await first, true);
  assert.deepEqual(listCalls(api), ['GET /api/projects/2/tasks?fields=summary&include_children_count=false']);
  assert.deepEqual(sessionCalls(api), ['DELETE /api/projects/2/tasks/TPT1/device-sessions/7']);
  assert.equal(api.claims.has('TPT1'), false, 'active_device is null again');
  assert.equal(await lifecycle.releaseStaleClaims(backendFor()), true);
  assert.equal(api.calls.length, 2, 'once per project and account per process');
  assert.deepEqual(m.lines, ['[device-session] released the claim a run on this machine left open on TPT1']);
});

test("a claim a live run of this server holds is kept while another task's is released", async t => {
  const api = claimsApi({ active: { TPT1: 7, TPT2: 7 } });
  const m = claimsMachine(t, api);
  const { lifecycle } = m.server(101);
  const session = run('/project');
  await lifecycle.postDeviceSession(session, 'TPT1', backendFor()); // the run's start also starts the pass
  assert.equal(await lifecycle.releaseStaleClaims(backendFor()), true);
  assert.deepEqual(sessionCalls(api), [
    'POST /api/projects/2/tasks/TPT1/device-sessions',
    'DELETE /api/projects/2/tasks/TPT2/device-sessions/7',
  ]);
  assert.equal(listCalls(api).length, 1);
  assert.deepEqual(api.claims.get('TPT1'), { id: 7 }, "the live run's claim stays");
  await lifecycle.deleteDeviceSession(session);
  assert.equal(api.claims.has('TPT1'), false);
});

test("another Task App server's live run on this machine keeps its claim; once that server is gone it is released", async t => {
  const api = claimsApi();
  const m = claimsMachine(t, api);
  const a = m.server(101);
  const session = run('/project');
  await a.lifecycle.postDeviceSession(session, 'TPT1', backendFor());
  await a.lifecycle.releaseStaleClaims(backendFor());
  assert.deepEqual(api.claims.get('TPT1'), { id: 7 });

  const b = m.server(202); // e.g. a second instance opened on the same machine and account
  assert.equal(await b.lifecycle.releaseStaleClaims(backendFor()), true);
  assert.deepEqual(sessionCalls(api), ['POST /api/projects/2/tasks/TPT1/device-sessions'], 'nothing is released');
  assert.deepEqual(api.claims.get('TPT1'), { id: 7 });

  a.exit(); // quit while the run was going: no release was sent
  const c = m.server(303); // the relaunched server
  assert.equal(await c.lifecycle.releaseStaleClaims(backendFor()), true);
  assert.deepEqual(sessionCalls(api).slice(1), ['DELETE /api/projects/2/tasks/TPT1/device-sessions/7']);
  assert.equal(api.claims.has('TPT1'), false);
});

test("another device's claim, and one the relay sees running on this device, are left alone", async t => {
  const api = claimsApi({ active: { TPT1: 99, TPT2: { id: 7, state: 'running' }, TPT3: { id: 7, state: 'starting' }, TPT4: 7 } });
  const m = claimsMachine(t, api);
  const { lifecycle } = m.server(101);
  assert.equal(await lifecycle.releaseStaleClaims(backendFor()), true);
  assert.deepEqual(sessionCalls(api), ['DELETE /api/projects/2/tasks/TPT4/device-sessions/7']);
  assert.deepEqual([...api.claims.keys()].sort(), ['TPT1', 'TPT2', 'TPT3']);
});

test('a project with no API target, or a server with no claim registry, makes no request', async t => {
  const api = claimsApi({ active: { TPT1: 7 } });
  const m = claimsMachine(t, api);
  const withRegistry = m.server(101);
  const signedOut = { getCredentials() { throw Object.assign(new Error('API_BASE_URL is not set'), { code: 'missing_credential' }); } };
  assert.equal(await withRegistry.lifecycle.releaseStaleClaims(signedOut), false);
  assert.equal(await withRegistry.lifecycle.releaseStaleClaims({}), false);
  assert.deepEqual(withRegistry.lookups, [], 'no device lookup either');

  const without = m.server(202, { registry: false });
  assert.equal(await without.lifecycle.releaseStaleClaims(backendFor()), false);
  const session = run('/project');
  await without.lifecycle.postDeviceSession(session, 'TPT2', backendFor());
  await settle();
  assert.deepEqual(api.calls.map(route), ['POST /api/projects/2/tasks/TPT2/device-sessions'], 'the run still claims its task');
  assert.equal(api.claims.has('TPT1'), true);
});

test('a pass that could not finish runs again on the next call', async t => {
  const api = claimsApi({ active: { TPT1: 7 } });
  const m = claimsMachine(t, api);
  const unknown = m.server(101, { deviceId: null });
  assert.equal(await unknown.lifecycle.releaseStaleClaims(backendFor()), false);
  assert.deepEqual(api.calls, [], 'no list without a device id');

  const { lifecycle } = m.server(202);
  api.listStatus = 503;
  assert.equal(await lifecycle.releaseStaleClaims(backendFor()), false);
  assert.ok(m.lines.includes('[device-session] the API refused the task list for project 2 (HTTP 503)'));
  api.listStatus = 200;
  api.deleteStatus = 500;
  assert.equal(await lifecycle.releaseStaleClaims(backendFor()), false);
  assert.ok(m.lines.includes('[device-session] the API refused the stale claim release for TPT1 (HTTP 500)'));
  api.deleteStatus = 204;
  assert.equal(await lifecycle.releaseStaleClaims(backendFor()), true);
  assert.equal(api.claims.has('TPT1'), false);
  assert.deepEqual(api.calls.map(route), [
    'GET /api/projects/2/tasks', 'GET /api/projects/2/tasks', 'DELETE /api/projects/2/tasks/TPT1/device-sessions/7',
    'GET /api/projects/2/tasks', 'DELETE /api/projects/2/tasks/TPT1/device-sessions/7',
  ]);
  assert.equal(await lifecycle.releaseStaleClaims(backendFor()), true);
  assert.equal(api.calls.length, 5);
});

test("a run that starts while another server releases its task's abandoned claim claims after that release", async t => {
  const api = claimsApi({ active: { TPT1: 7 }, gateDelete: true });
  const m = claimsMachine(t, api);
  const releaser = m.server(101);
  const pass = releaser.lifecycle.releaseStaleClaims(backendFor());
  for (let i = 0; i < 50 && !api.calls.some(call => call.method === 'DELETE'); i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sessionCalls(api), ['DELETE /api/projects/2/tasks/TPT1/device-sessions/7'], 'the release is in flight');

  const starter = m.server(202);
  const session = run('/project');
  const claim = starter.lifecycle.postDeviceSession(session, 'TPT1', backendFor());
  await settle();
  assert.deepEqual(sessionCalls(api), ['DELETE /api/projects/2/tasks/TPT1/device-sessions/7'],
    'the API would attach this claim to the old one, which the release then ends');
  api.open();
  assert.equal(await pass, true);
  for (let i = 0; i < 50 && !api.calls.some(call => call.method === 'POST'); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(api.calls.some(call => call.method === 'POST'), 'claimed as soon as the release is done');
  await claim;
  assert.deepEqual(sessionCalls(api), [
    'DELETE /api/projects/2/tasks/TPT1/device-sessions/7',
    'POST /api/projects/2/tasks/TPT1/device-sessions',
  ]);
  assert.deepEqual(api.claims.get('TPT1'), { id: 7 }, "the new run's claim is open");
  await starter.lifecycle.releaseStaleClaims(backendFor());
  assert.deepEqual(api.claims.get('TPT1'), { id: 7 }, "the starter's own pass keeps it");
});

test('a release that did not land is retried by the next pass', async t => {
  const api = claimsApi();
  const m = claimsMachine(t, api);
  const { lifecycle } = m.server(101);
  assert.equal(await lifecycle.releaseStaleClaims(backendFor()), true);
  const session = run('/project');
  await lifecycle.postDeviceSession(session, 'TPT1', backendFor());
  api.deleteStatus = 503;
  await lifecycle.deleteDeviceSession(session);
  assert.deepEqual(api.claims.get('TPT1'), { id: 7 }, 'the claim is still open');
  api.deleteStatus = 204;
  assert.equal(await lifecycle.releaseStaleClaims(backendFor()), true);
  assert.equal(api.claims.has('TPT1'), false);
  assert.deepEqual(api.calls.map(route), [
    'GET /api/projects/2/tasks',
    'POST /api/projects/2/tasks/TPT1/device-sessions',
    'DELETE /api/projects/2/tasks/TPT1/device-sessions/7',
    'GET /api/projects/2/tasks',
    'DELETE /api/projects/2/tasks/TPT1/device-sessions/7',
  ]);
});

test('an unreadable claim registry keeps every open claim of this device', async t => {
  const api = claimsApi({ active: { TPT1: 7 } });
  const m = claimsMachine(t, api);
  fs.writeFileSync(path.join(m.directory, 'device-claims.json'), 'not json');
  const { lifecycle } = m.server(101);
  assert.equal(await lifecycle.releaseStaleClaims(backendFor()), false);
  assert.deepEqual(sessionCalls(api), [], 'another server might still be running it');
  assert.ok(m.lines.some(line => /claim registry is unavailable \(state-invalid\)/.test(line)));
  fs.rmSync(path.join(m.directory, 'device-claims.json'));
  assert.equal(await lifecycle.releaseStaleClaims(backendFor()), true, 'the next call tries again');
  assert.deepEqual(sessionCalls(api), ['DELETE /api/projects/2/tasks/TPT1/device-sessions/7']);
});

test("a live run's claim is recognized however its task key and API base are spelled", async t => {
  const api = claimsApi({ active: { TPT1: 7 } });
  const m = claimsMachine(t, api);
  const a = m.server(101);
  const spelled = { getCredentials: () => ({ baseUrl: `${BASE}/`, projectId: 2, token: token(1) }) };
  await a.lifecycle.postDeviceSession(run('/project'), 'tpt1', spelled);
  const b = m.server(202);
  assert.equal(await b.lifecycle.releaseStaleClaims(backendFor()), true);
  assert.equal(api.calls.some(call => call.method === 'DELETE'), false);
  assert.deepEqual(api.claims.get('TPT1'), { id: 7 });
});
