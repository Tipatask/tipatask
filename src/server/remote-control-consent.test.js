'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRemoteControlConsent } = require('./remote-control-consent');
const { saveAccountForServer, clearAccountToken } = require('./account-store');
const token = (id = 1, extra = {}) => 'synthetic.' + Buffer.from(JSON.stringify({ id, exp: 4000000000, ...extra })).toString('base64url') + '.signature';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-consent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = name => { const result = path.join(root, name); fs.mkdirSync(result); return result; };
  const project = dir('checkout');
  const configFile = path.join(project, '.tipatask', 'config.json');
  fs.mkdirSync(path.dirname(configFile));
  let config = { API_BASE_URL: 'https://consent.test', API_PROJECT_ID: '2', REMOTE_CONTROL_ENABLED: true };
  const writeConfig = patch => { config = { ...config, ...patch }; fs.writeFileSync(configFile, JSON.stringify(config)); };
  writeConfig({});
  const device = name => {
    const userDataRoot = dir(name);
    const machineIdPath = path.join(root, name + '-machine');
    fs.writeFileSync(machineIdPath, name);
    const options = { userDataRoot, machineIdPath };
    saveAccountForServer(config.API_BASE_URL, { token: token() }, options);
    const store = createRemoteControlConsent(options);
    return { options, store };
  };
  const a = device('device-a');
  const b = device('device-b');
  return { root, project, configFile, writeConfig, config, a, b, dir };
}

function enable(store, project) { return store.write(project, true, store.read(project).context); }

test('portable true reproduces the old predicate but never grants local consent on either device', t => {
  const f = fixture(t);
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).REMOTE_CONTROL_ENABLED, true, 'legacy predicate grants both copied checkouts');
  for (const { store } of [f.a, f.b]) {
    assert.equal(store.read(f.project).enabled, false);
    assert.equal(store.read(f.project).migrationRequired, true);
  }
  enable(f.a.store, f.project);
  assert.equal(f.a.store.read(f.project).enabled, true);
  assert.equal(f.b.store.read(f.project).enabled, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile)), f.config, 'consent never rewrites portable config');
  const file = fs.readdirSync(path.join(f.a.options.userDataRoot, 'remote-control'))[0];
  const content = fs.readFileSync(path.join(f.a.options.userDataRoot, 'remote-control', file), 'utf8');
  assert.equal(content.includes('synthetic'), false);
  assert.equal(fs.statSync(path.join(f.a.options.userDataRoot, 'remote-control', file)).mode & 0o777, 0o600);
});

test('copied checkout, checkout replacement, config sync, aliases and fresh/copied app data preserve only the intended scope', t => {
  const f = fixture(t);
  enable(f.a.store, f.project);
  const clone = path.join(f.root, 'clone');
  fs.cpSync(f.project, clone, { recursive: true });
  assert.equal(f.a.store.read(clone).enabled, false, 'clone with the same tracked config');
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.project, alias, 'dir');
  assert.equal(f.a.store.read(alias).enabled, true, 'alias resolves the same physical checkout');
  f.writeConfig({ unrelated: 'synced', REMOTE_CONTROL_ENABLED: true });
  assert.equal(f.a.store.read(f.project).enabled, true, 'same physical checkout retains explicit consent');
  fs.cpSync(f.project, clone, { recursive: true });
  assert.equal(f.a.store.read(clone).enabled, false, 'synced true cannot enable a copy');
  const copiedData = path.join(f.root, 'copied-data');
  fs.cpSync(f.a.options.userDataRoot, copiedData, { recursive: true });
  assert.equal(createRemoteControlConsent({ ...f.a.options, userDataRoot: copiedData }).read(f.project).enabled, false);
  const fresh = f.dir('fresh'); saveAccountForServer(f.config.API_BASE_URL, { token: token() }, { userDataRoot: fresh });
  assert.equal(createRemoteControlConsent({ ...f.a.options, userDataRoot: fresh }).read(f.project).enabled, false);
  fs.renameSync(f.project, f.project + '-old'); fs.cpSync(clone, f.project, { recursive: true });
  assert.equal(f.a.store.read(f.project).enabled, false, 'replacement at the same path requires consent');
});

test('account/server/project/device changes, sign-out and stale settings cannot inherit or restore consent', t => {
  const f = fixture(t);
  let grant = enable(f.a.store, f.project);
  saveAccountForServer(f.config.API_BASE_URL, { token: token(1, { renewed: true }) }, f.a.options);
  assert.equal(f.a.store.read(f.project).grant, grant.grant, 'same-account renewal preserves consent');
  saveAccountForServer(f.config.API_BASE_URL, { token: token(2) }, f.a.options);
  assert.equal(f.a.store.read(f.project).enabled, false);
  assert.throws(() => f.a.store.write(f.project, true, grant.context), /context changed/);
  saveAccountForServer(f.config.API_BASE_URL, { token: token() }, f.a.options);
  assert.equal(f.a.store.read(f.project).enabled, false, 'switching back cannot revive consent');
  grant = enable(f.a.store, f.project);
  clearAccountToken(f.config.API_BASE_URL, f.a.options);
  assert.equal(f.a.store.read(f.project).enabled, false);
  saveAccountForServer(f.config.API_BASE_URL, { token: token() }, f.a.options);
  assert.equal(f.a.store.read(f.project).enabled, false);
  enable(f.a.store, f.project);
  f.writeConfig({ API_PROJECT_ID: '3' }); assert.equal(f.a.store.read(f.project).enabled, false);
  f.writeConfig({ API_PROJECT_ID: '2', API_BASE_URL: 'https://other.test' });
  saveAccountForServer('https://other.test', { token: token() }, f.a.options);
  assert.equal(f.a.store.read(f.project).enabled, false);
  f.writeConfig({ API_BASE_URL: f.config.API_BASE_URL });
  fs.writeFileSync(f.a.options.machineIdPath, 'replacement-machine');
  assert.equal(f.a.store.read(f.project).enabled, false);
});

test('restart, multiple readers, explicit disable, malformed state and expired credentials fail closed', async t => {
  const f = fixture(t);
  const grant = enable(f.a.store, f.project);
  const modulePath = require.resolve('./remote-control-consent');
  const child = spawnSync(process.execPath, ['-e', `const c = require(${JSON.stringify(modulePath)}).createRemoteControlConsent(JSON.parse(process.argv[1])); console.log(JSON.stringify(c.read(process.argv[2])));`, JSON.stringify(f.a.options), f.project], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).grant, grant.grant);
  const otherWindow = createRemoteControlConsent(f.a.options);
  const changed = new Promise(resolve => { const stop = otherWindow.watch(() => { stop(); resolve(); }); t.after(stop); });
  f.a.store.write(f.project, false, grant.context);
  assert.equal(otherWindow.read(f.project).enabled, false, 'no notification needed for authority');
  let timer;
  try { await Promise.race([changed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('consent watch missed change')), 2000); })]); } finally { clearTimeout(timer); }
  assert.throws(() => otherWindow.write(f.project, true, grant.context), /context changed/);
  const next = enable(otherWindow, f.project);
  assert.notEqual(next.grant, grant.grant, 'old pending starts cannot survive disable/re-enable');
  const file = fs.readdirSync(path.join(f.a.options.userDataRoot, 'remote-control'))[0];
  fs.writeFileSync(path.join(f.a.options.userDataRoot, 'remote-control', file), '{broken');
  assert.equal(f.a.store.read(f.project).enabled, false);
  saveAccountForServer(f.config.API_BASE_URL, { token: token(1, { exp: 1 }) }, f.a.options);
  assert.equal(f.a.store.read(f.project).available, false);
});

test('app data inside a checkout cannot hold consent', t => {
  const f = fixture(t);
  const local = path.join(f.project, 'app-data'); fs.mkdirSync(local);
  const store = createRemoteControlConsent({ ...f.a.options, userDataRoot: local });
  assert.equal(store.read(f.project).available, false);
  assert.throws(() => store.write(f.project, true, 'forged'), /context changed/);
});
