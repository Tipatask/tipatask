'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  materializePiTaskTools, stagePiMcpBridge, piMcpBridgePath, resolvePiMcpBridge, ENTRY, BRIDGE_FILE, BRIDGE_SOURCE,
} = require('./pi-task-tools');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-tools-'));
}

test('the bridge source is the build output under dist/pi-ext/', () => {
  assert.equal(BRIDGE_SOURCE, path.resolve(__dirname, '..', '..', '..', 'dist', 'pi-ext', BRIDGE_FILE));
});

test('a missing bridge bundle never blocks task-tools staging', () => {
  const dir = scratch();
  const entry = materializePiTaskTools(dir, { bridgeSource: path.join(dir, 'absent.mjs') });
  assert.equal(entry, path.join(dir, 'pi-ext', ENTRY));
  assert.equal(fs.existsSync(entry), true);
  assert.equal(piMcpBridgePath(dir), null);
});

test('the bundled bridge is staged next to task-tools.mjs and refreshed when it changes', () => {
  const dir = scratch();
  const bundle = path.join(dir, 'bundle.mjs');
  fs.writeFileSync(bundle, 'export default function () {}\n');
  materializePiTaskTools(dir, { bridgeSource: bundle });
  const staged = piMcpBridgePath(dir);
  assert.equal(staged, path.join(dir, 'pi-ext', BRIDGE_FILE));
  assert.equal(fs.readFileSync(staged, 'utf8'), 'export default function () {}\n');

  fs.writeFileSync(bundle, 'export default function (pi) { void pi; }\n');
  materializePiTaskTools(dir, { bridgeSource: bundle });
  assert.equal(fs.readFileSync(staged, 'utf8'), 'export default function (pi) { void pi; }\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'pi-ext')).filter((n) => n.includes('.tmp.')), []);
});

test('piMcpBridgePath needs a user data root', () => {
  assert.equal(piMcpBridgePath(''), null);
  assert.equal(piMcpBridgePath(undefined), null);
});

test('stagePiMcpBridge stages only the bridge and returns its path', () => {
  const dir = scratch();
  const bundle = path.join(dir, 'bundle.mjs');
  fs.writeFileSync(bundle, 'export default function () {}\n');
  assert.equal(stagePiMcpBridge(dir, { bridgeSource: bundle }), path.join(dir, 'pi-ext', BRIDGE_FILE));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'pi-ext')), [BRIDGE_FILE]);
});

test('stagePiMcpBridge returns null without a bundle or a user data root', () => {
  const dir = scratch();
  assert.equal(stagePiMcpBridge(dir, { bridgeSource: path.join(dir, 'absent.mjs') }), null);
  assert.equal(stagePiMcpBridge('', {}), null);
});

test('resolvePiMcpBridge: null without a project .mcp.json, else the derived config and the staged bundle', () => {
  const userData = scratch();
  const project = scratch();
  const bundle = path.join(userData, 'bundle.mjs');
  fs.writeFileSync(bundle, 'export default function () {}\n');
  assert.equal(resolvePiMcpBridge({ projectRoot: project, userDataRoot: userData, bridgeSource: bundle }), null);
  assert.equal(resolvePiMcpBridge({ projectRoot: '', userDataRoot: userData }), null);

  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { 'tipatask-local': { command: 'node', args: ['server.js'] }, other: { command: 'x' } },
  }));
  const bridge = resolvePiMcpBridge({ projectRoot: project, userDataRoot: userData, bridgeSource: bundle });
  assert.equal(bridge.extensionPath, path.join(userData, 'pi-ext', BRIDGE_FILE));
  assert.ok(bridge.configPath.startsWith(path.join(userData, 'mcp-spawn')));
  const servers = JSON.parse(fs.readFileSync(bridge.configPath, 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(servers), ['tipatask-local'], 'only the Tipatask servers reach the bridge');

  assert.equal(resolvePiMcpBridge({ projectRoot: project, userDataRoot: scratch(), bridgeSource: path.join(userData, 'absent.mjs') }), null,
    'no bundle, no bridge');
});
