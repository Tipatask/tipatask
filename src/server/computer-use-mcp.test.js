'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { createPermissionGate } = require('./permission-gate');
const { desktopEnv, detectDesktop } = require('./computer-use-runtime');

// Real MCP initialize/list/call roundtrips and the production live gate. Only the
// OS/consent UI is deterministic here; native desktop verification is a separate probe.
async function connect(t, env = {}) {
  const script = `require(${JSON.stringify(path.join(__dirname, 'computer-use-mcp.js'))}).serve({
    native: () => { const apps = new Set(); return {
      close() { apps.clear(); },
      async call(name, args) {
        if (name === 'request_access') {
          if (args.reason !== 'deny') args.apps.forEach(app => apps.add(app));
          return { granted: args.apps.filter(app => apps.has(app)), denied: args.apps.filter(app => !apps.has(app)) };
        }
        if (name === 'list_granted_applications') return { apps: [...apps] };
        if (!apps.has(args.app)) throw new Error('Access not granted');
        if (name === 'screenshot') return { image: 'aW1hZ2U=', app: args.app };
        return { performed: name };
      }
    }; }
  });`;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['-e', script],
    env: { ...process.env, TIPATASK_DESKTOP_URL: '', TIPATASK_DESKTOP_TOKEN: '', ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'computer-use-regression', version: '1' });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}
const value = result => JSON.parse(result.content[0].text);
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

test('MCP missing/wrong/stale binding never advertises or grants tools', async t => {
  const gate = await createPermissionGate({ permissionPolicy: { mode: 'bypass' } });
  t.after(() => gate.close());
  for (const env of [{}, { ...desktopEnv(gate), TIPATASK_DESKTOP_TOKEN: 'stale' }]) {
    const client = await connect(t, env);
    await assert.rejects(client.listTools(), /session unavailable or expired/);
    for (const name of ['request_access', 'list_granted_applications']) {
      const result = await call(client, name, { apps: ['test.app'], reason: 'test' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Start a fresh task/);
    }
  }
  const client = await connect(t, desktopEnv(gate));
  await client.listTools();
  await call(client, 'request_access', { apps: ['test.app'], reason: 'test' });
  gate.close();
  assert.equal((await call(client, 'screenshot', { app: 'test.app' })).isError, true);
  assert.equal((await call(client, 'list_granted_applications')).isError, true);
});

test('MCP consent denial, independent sessions, restart and images', async t => {
  const gate = await createPermissionGate({ permissionPolicy: { mode: 'bypass' } });
  t.after(() => gate.close());
  const first = await connect(t, desktopEnv(gate));
  assert.ok((await first.listTools()).tools.some(tool => tool.name === 'request_access'));
  assert.deepEqual(value(await call(first, 'list_granted_applications')), { apps: [] });
  assert.deepEqual(value(await call(first, 'request_access', { apps: ['test.app'], reason: 'deny' })), { granted: [], denied: ['test.app'] });
  assert.equal((await call(first, 'left_click', { app: 'test.app', coordinate: [1, 1] })).isError, true);
  await call(first, 'request_access', { apps: ['test.app'], reason: 'test' });
  const image = await call(first, 'screenshot', { app: 'test.app' });
  assert.equal(image.content[1].type, 'image');
  assert.equal(image.content[1].mimeType, 'image/png');
  assert.equal((await call(first, 'type', { app: 'test.app', text: 'benign' })).isError, undefined);
  const second = await connect(t, desktopEnv(gate));
  assert.deepEqual(value(await call(second, 'list_granted_applications')), { apps: [] });
  assert.equal((await call(second, 'screenshot', { app: 'test.app' })).isError, true);
  await first.close();
  const restarted = await connect(t, desktopEnv(gate));
  assert.deepEqual(value(await call(restarted, 'list_granted_applications')), { apps: [] });
});

test('MCP uses confirmed live Plan mode even if client exposes mutation tools', async t => {
  const session = { permissionMode: { confirmed: 'plan' }, terminalPhase: 'planning' };
  const gate = await createPermissionGate(session);
  t.after(() => gate.close());
  const client = await connect(t, desktopEnv(gate));
  await client.listTools();
  assert.deepEqual(value(await call(client, 'request_access', { apps: ['test.app'], reason: 'test' })).granted, ['test.app']);
  assert.equal((await call(client, 'screenshot', { app: 'test.app' })).isError, undefined);
  for (const name of ['open_application', 'left_click', 'type']) {
    const result = await call(client, name, { app: 'test.app', coordinate: [1, 1], text: 'test' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Plan mode/);
  }
  session.permissionMode.confirmed = 'auto';
  assert.equal((await call(client, 'type', { app: 'test.app', text: 'test' })).isError, undefined);
  session.permissionMode.confirmed = 'plan';
  assert.equal((await call(client, 'type', { app: 'test.app', text: 'test' })).isError, true);
});

test('unavailable native capability gives actionable diagnostic, without falling back to Claude', async () => {
  const result = await detectDesktop('codex', {}, { platform: 'darwin', build: async () => { throw new Error('missing helper'); } });
  assert.equal(result.available, false);
  assert.match(result.reason, /Update\/reinstall.*Xcode Command Line Tools/);
  assert.equal(result.server, undefined);
});

test('native MCP initialization and permission calls reject invalid apps and fresh/stale bindings',
  { skip: process.env.COMPUTER_USE_NATIVE_TEST !== '1' || process.platform !== 'darwin' }, async t => {
    const capability = await detectDesktop('codex', {});
    assert.equal(capability.available, true, capability.reason);
    const gate = await createPermissionGate({ permissionPolicy: { mode: 'bypass' } });
    t.after(() => gate.close());
    const open = async () => {
      const client = new Client({ name: 'native-permissions-regression', version: '1' });
      await client.connect(new StdioClientTransport({ command: capability.server.command, args: capability.server.args,
        env: { ...process.env, ...desktopEnv(gate) }, stderr: 'pipe' }));
      t.after(() => client.close());
      await client.listTools();
      return client;
    };
    const client = await open();
    assert.deepEqual(value(await call(client, 'list_granted_applications')).apps, []);
    const invalid = await call(client, 'request_access', { apps: ['invalid.nonexistent.tipatask.probe'], reason: 'Invalid app regression; no consent UI expected.' });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /Application unavailable/);
    assert.equal((await call(client, 'screenshot', { app: 'com.tipatask.app' })).isError, true);
    await client.close();
    const fresh = await open();
    assert.deepEqual(value(await call(fresh, 'list_granted_applications')).apps, []);
    gate.close();
    assert.equal((await call(fresh, 'request_access', { apps: ['invalid.nonexistent.tipatask.probe'], reason: 'Stale binding regression' })).isError, true);
  });
