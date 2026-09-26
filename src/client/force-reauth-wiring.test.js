import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(CLIENT_DIR, '..', '..');

// Regression guards for Project ▸ Re-authenticate / Change Account (TPT347). The chain is
// main.js menu click → 'force-reauth' IPC → preload onForceReauth → template.html
// _maybeOpenReauth → setup-modal.js openReauth → setupAuthWeb IPC → authenticate(). The
// renderer files aren't importable under node (no jsdom), so this is the same source-scan style
// as agent-recheck-wiring.test.js. The one break this pins: _maybeOpenReauth() used to reverify
// the connection first and bail on 'connected', so on a healthy window the menu item did nothing.

function readSource(...segments) {
  return fs.readFileSync(path.join(...segments), 'utf8');
}

// Indented `async function <name>(` inside template.html's init closure: from its header to the
// first line that is just the closing brace at 2-space indent.
function extractClosureFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name}() not found in template.html`);
  const end = source.indexOf('\n  }\n', start);
  assert.ok(end > start, `${name}() end not found`);
  return source.slice(start, end);
}

const template = readSource(CLIENT_DIR, 'template.html');
const setupModal = readSource(CLIENT_DIR, 'setup-modal.js');
const preload = readSource(SERVER_ROOT, 'preload.js');
const mainJs = readSource(SERVER_ROOT, 'main.js');

test('Project menu item sends force-reauth to the window that owns the menu click', () => {
  const idx = mainJs.indexOf("label: mt('menu.reauthenticate')");
  assert.ok(idx >= 0, 'menu.reauthenticate item not found in main.js');
  const item = mainJs.slice(idx, idx + 300);
  assert.match(item, /window\.webContents\.send\('force-reauth'\)/);
  assert.match(item, /!window\.isDestroyed\(\)/, 'must guard against a destroyed window');
});

test('preload exposes onForceReauth on the force-reauth channel', () => {
  assert.match(preload, /onForceReauth:\s*\(cb\)\s*=>\s*ipcRenderer\.on\('force-reauth'/);
});

test('onForceReauth handler resets the in-flight latch and forces the reauth flow', () => {
  const idx = template.indexOf('window.electronAPI.onForceReauth((');
  assert.ok(idx >= 0, 'onForceReauth subscription not found in template.html');
  const handler = template.slice(idx, template.indexOf('\n', idx));
  assert.match(handler, /_reauthInFlight = false/);
  assert.match(handler, /_maybeOpenReauth\(\{ force: true \}\)/);
});

test('_maybeOpenReauth: reverify only runs for non-forced (401-driven) calls', () => {
  const body = extractClosureFunction(template, '_maybeOpenReauth');
  assert.match(body, /if \(!force && window\.electronAPI\.api\?\.connection\?\.reverify\)/,
    'the reverify bail-out must be gated on !force or the menu item no-ops on a healthy connection');
  // The Agents-modal retry must carry the opts, or a deferred menu click silently downgrades to a 401-style call.
  assert.match(body, /setTimeout\(\(\) => _maybeOpenReauth\(opts\), 500\)/);
});

test('_maybeOpenReauth: forced flow opens the reauth wizard with the account chooser', () => {
  const body = extractClosureFunction(template, '_maybeOpenReauth');
  const open = body.slice(body.indexOf('setupModal.openReauth({'));
  assert.match(open, /chooseAccount: force/);
  assert.match(open, /projectPath: ctx\.projectPath/);
});

test('_maybeOpenReauth: unconfigured and blank windows do not silently no-op', () => {
  const body = extractClosureFunction(template, '_maybeOpenReauth');
  assert.match(body, /getCurrentProject\?\.\(\)/);
  assert.match(body, /if \(stale\) _openSetupWizardForPath\(stale, false\)/);
  assert.match(body, /else if \(force\) showToast\(t\('project\.noProjectLoaded'\), 'info'\)/);
});

test('setup-modal forwards chooseAccount into setupAuthWeb and resets it on a fresh setup open', () => {
  assert.match(setupModal, /export function openReauth\(\{[^}]*chooseAccount[^}]*\}\)/);
  assert.match(setupModal, /_chooseAccount = !!chooseAccount/);
  assert.match(setupModal, /setupAuthWeb\(_apiBaseUrl, \{ chooseAccount: _chooseAccount \}\)/);
  const openFn = setupModal.slice(setupModal.indexOf('export function open('), setupModal.indexOf('export function openReauth('));
  assert.match(openFn, /_chooseAccount = false/, 'a plain setup open() must not inherit a prior reauth session\'s flag');
  const switchIdx = setupModal.indexOf("'#setup-switch-btn'");
  assert.ok(switchIdx >= 0);
  assert.match(setupModal.slice(switchIdx, switchIdx + 300), /_chooseAccount = true/,
    '"Use a different account" must request the chooser');
});

test('setupAuthWeb carries chooseAccount preload → main → authenticate()', () => {
  assert.match(preload, /setupAuthWeb:\s*\(apiBaseUrl, opts\)\s*=>\s*inv\('setup:auth-web', \{ apiBaseUrl, chooseAccount: !!\(opts && opts\.chooseAccount\) \}\)/);
  const idx = mainJs.indexOf("ipcMain.handle('setup:auth-web'");
  assert.ok(idx >= 0, 'setup:auth-web handler not found');
  const handler = mainJs.slice(idx, idx + 400);
  assert.match(handler, /\{ apiBaseUrl, chooseAccount \}/);
  assert.match(handler, /authenticate\(apiBaseUrl, \{ chooseAccount: !!chooseAccount \}\)/);
});

test('setup:force-reauth (reauth banner path) still authenticates and rebinds the backend', () => {
  const idx = mainJs.indexOf("ipcMain.handle('setup:force-reauth'");
  assert.ok(idx >= 0, 'setup:force-reauth handler not found');
  const handler = mainJs.slice(idx, mainJs.indexOf("ipcMain.handle('project:rename'", idx));
  assert.match(handler, /await authenticate\(apiBaseUrl\)/);
  assert.match(handler, /exchangeProjectToken\(apiBaseUrl, userToken, cfg\.API_PROJECT_ID\)/);
  assert.match(handler, /reconfigureWindowBackend\(event\.sender\.id, newConfig\)/);
});
