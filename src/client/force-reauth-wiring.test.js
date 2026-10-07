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
  // Blank window: the menu item swaps the app-level account instead of a "no project" toast.
  assert.match(body, /else if \(force\) _openAccountReauth\(\)/);
  assert.doesNotMatch(body, /project\.noProjectLoaded/);
});

test('_runForceReauth: blank window opens the account-only wizard too', () => {
  const body = extractClosureFunction(template, '_runForceReauth');
  assert.match(body, /if \(stale\) _openSetupWizardForPath\(stale, false\);\s*else _openAccountReauth\(\);/);
});

test('_openAccountReauth: account-only wizard with the chooser, toast on success, Get Started restored', () => {
  const start = template.indexOf('function _openAccountReauth(');
  assert.ok(start >= 0, '_openAccountReauth() not found in template.html');
  const body = template.slice(start, template.indexOf('\n  }\n', start));
  assert.match(body, /accountOnly: true/);
  assert.match(body, /chooseAccount: true/);
  assert.match(body, /showToast\(t\('reauth\.accountSwitched', \{ email:/);
  assert.match(body, /_chooseModal\.style\.display = 'none'/);
  // (TPT556) Get Started comes back by the unbound-window invariant on EVERY close (Done, Cancel,
  // X, Escape) — not only when it was visible before the wizard opened.
  assert.doesNotMatch(body, /restoreGetStarted/);
  assert.match(body, /projectOpenFlow\.isUnboundWindow\(\{ projectPath: ctx\?\.projectPath, config: ctx\?\.config \}\)/);
  assert.match(body, /_showChooseModal\(\)/);
  assert.match(body, /onCancel: finish/);
  assert.match(body, /_reauthInFlight = false/);
});

// ── (TPT556) Unbound-window invariant: Get Started always, account-only re-auth, neutral title ──

test('openReauth forces the account-only mode for an unbound caller (isUnboundWindow)', () => {
  const openReauth = sliceFn(setupModal, 'export function openReauth(');
  assert.match(setupModal, /import \{ isUnboundWindow \} from '\.\/project-open-flow\.js'/);
  assert.match(openReauth, /const unbound = isUnboundWindow\(\{ projectPath, config: existingConfig \}\)/);
  assert.match(openReauth, /_mode = \(accountOnly \|\| unbound\) \? 'account' : 'reauth'/);
});

test('setup:reauth-account re-sends project:menu choose to an unbound sender after the swap', () => {
  const idx = mainJs.indexOf("ipcMain.handle('setup:reauth-account'");
  const handler = mainJs.slice(idx, mainJs.indexOf("ipcMain.handle('project:rename'", idx));
  assert.match(handler, /async \(event, requestedBaseUrl\)/);
  assert.match(handler, /if \(!projectDirs\.get\(event\.sender\.id\) && !event\.sender\.isDestroyed\(\)\) \{\s*event\.sender\.send\('project:menu', 'choose'\);/);
});

test('Get Started defers while a wizard overlay is up (would otherwise cover it)', () => {
  const start = template.indexOf('function _showChooseModal(');
  assert.ok(start >= 0);
  const body = template.slice(start, template.indexOf('\n  }\n', start));
  assert.match(body, /if \(document\.querySelector\('\.setup-modal'\)\) return;/);
});

test('api:auth.reauth-save fails closed for an unbound window (no config write, no rebind)', () => {
  const apiRouter = readSource(SERVER_ROOT, 'main', 'ipc', 'api-router.js');
  const idx = apiRouter.indexOf("ipcMain.handle('api:auth.reauth-save'");
  assert.ok(idx >= 0);
  const handler = apiRouter.slice(idx, apiRouter.indexOf("ipcMain.handle('api:project.config'", idx));
  const guard = handler.indexOf("if (!st.projectPath) return { ok: false, error: 'No project bound to this window' };");
  assert.ok(guard >= 0, 'reauth-save must refuse an unbound window');
  assert.ok(guard < handler.indexOf('readProjectConfig(st.projectPath)'), 'the guard must precede the config read');
  assert.ok(guard < handler.indexOf('reconfigureWindowBackend('), 'the guard must precede the rebind');
});

test('window title: BrowserWindow-level page-title-updated is blocked; unbound windows get the bare brand', () => {
  // Only the BrowserWindow event honours preventDefault(); the same-named webContents event is
  // informational, so the renderer's <title> used to leak into the native title of a blank window.
  assert.doesNotMatch(mainJs, /webContents\.on\('page-title-updated'/);
  assert.equal((mainJs.match(/\bw\.on\('page-title-updated', \(e\) => e\.preventDefault\(\)\)/g) || []).length, 2,
    'both createSetupWindow and createProjectWindow must block renderer titles');
  const cpw = mainJs.slice(mainJs.indexOf('async function createProjectWindow('));
  assert.match(cpw.slice(0, cpw.indexOf("w.loadURL(")), /\} else \{\s*\/\/[^\n]*\n\s*w\.setTitle\(getWindowTitle\(null\)\);/);
  assert.match(template, /<title>TipΔTask<\/title>/);
  assert.doesNotMatch(template, /TipΔTask — TODO/);
});

function sliceFn(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  return source.slice(start, source.indexOf('\n}\n', start));
}

test('setup-modal account mode: one browser trip through reauthAccount, no project writes', () => {
  assert.match(setupModal, /_mode = \(accountOnly \|\| unbound\) \? 'account' : 'reauth'/);
  const signIn = sliceFn(setupModal, 'function _renderAccountSignIn(');
  assert.match(signIn, /window\.electronAPI\.reauthAccount\(/);
  const confirm = sliceFn(setupModal, 'function _renderAccountConfirm(');
  for (const body of [signIn, confirm]) {
    assert.doesNotMatch(body, /setupAuthWeb|setupExchangeProjectToken|reauthSave|openExistingProject/);
  }
  // A successful swap is reported on whichever close follows (Done, X, Escape).
  const closeFn = sliceFn(setupModal, 'export function close(');
  assert.match(closeFn, /_mode === 'account'/);
  assert.match(closeFn, /completeCb\(\{ user: accountDone\.user/);
});

test('setup:stored-account returns a live account-wide sign-in or null', () => {
  const idx = mainJs.indexOf("ipcMain.handle('setup:stored-account'");
  assert.ok(idx >= 0, 'setup:stored-account handler not found');
  const handler = mainJs.slice(idx, mainJs.indexOf("ipcMain.handle('setup:list-projects'", idx));
  assert.match(handler, /readAccount\(apiBaseUrl\)/);
  assert.match(handler, /if \(!account\) return null/);
  assert.match(handler, /decodeTokenPayload\(account\.token\)\?\.project_id != null\) return null/);
  assert.match(handler, /\/api\/auth\/me/);
  assert.match(handler, /if \(status !== 200[^)]*\) return null/);
  assert.match(handler, /catch \(err\) \{[\s\S]*return null;/);
  assert.match(preload, /setupStoredAccount:\s*\(apiBaseUrl\)\s*=>\s*inv\('setup:stored-account', apiBaseUrl \|\| null\)/);
});

test('project wizards skip Sign-in for a stored account; reauth/account modes never do', () => {
  const creationWizard = readSource(CLIENT_DIR, 'project-creation-wizard.js');
  for (const [name, src] of [['setup-modal.js', setupModal], ['project-creation-wizard.js', creationWizard]]) {
    const openFn = sliceFn(src, 'export function open(');
    assert.match(openFn, /setupStoredAccount/, `${name} open() must check the stored account`);
    assert.match(openFn, /_adoptStoredAccount\(\)/, `${name} open() must adopt it`);
    assert.match(sliceFn(src, 'async function _adoptStoredAccount('), /gen !== _openId/, `${name}: stale-session guard`);
  }
  const openReauth = sliceFn(setupModal, 'export function openReauth(');
  assert.doesNotMatch(openReauth, /setupStoredAccount|_adoptStoredAccount/);
  assert.match(openReauth, /_storedAccountPending = false/);
  // "Use a different account" in the creation wizard must request the chooser.
  assert.match(creationWizard, /setupAuthWeb\(_apiBaseUrl, undefined, \{ chooseAccount: _chooseAccount \}\)/);
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

test('preload exposes reauthAccount on the setup:reauth-account channel (no project needed)', () => {
  assert.match(preload, /reauthAccount:\s*\(apiBaseUrl\)\s*=>\s*inv\('setup:reauth-account', apiBaseUrl \|\| null\)/);
});

test('setup:reauth-account swaps the app-level account without a project and returns no token', () => {
  const idx = mainJs.indexOf("ipcMain.handle('setup:reauth-account'");
  assert.ok(idx >= 0, 'setup:reauth-account handler not found');
  const handler = mainJs.slice(idx, mainJs.indexOf("ipcMain.handle('project:rename'", idx));
  assert.match(handler, /if \(_forceReauthInFlight\) return \{ ok: false/);
  assert.match(handler, /_forceReauthInFlight = false/);
  assert.match(handler, /defaultAccountServer\(\)\s*\|\| DEFAULT_API_BASE_URL/);
  assert.match(handler, /authenticate\(apiBaseUrl, \{ chooseAccount: true \}\)/);
  assert.match(handler, /saveAccountForServer\(apiBaseUrl, \{ token, userId: user\?\.id, email: user\?\.email \}\)/);
  assert.match(handler, /createMenu\(\)/);
  assert.doesNotMatch(handler, /readProjectConfig|projectPath|exchangeProjectToken/);
  const ret = handler.slice(handler.indexOf('return {\n'), handler.indexOf('} catch'));
  assert.match(ret, /ok: true/);
  assert.match(ret, /apiBaseUrl: saved\.apiBaseUrl/);
  assert.doesNotMatch(ret, /token/);
});
