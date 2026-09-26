'use strict';

// (C1388) Source-position/text locks for the one-window-per-project fixes in main.js —
// same pattern as main-user-data-env.test.js: main.js requires 'electron' at module
// scope so it can't be required outside a real Electron process, but the ORDERING and
// PRESENCE of these specific fixes can still be locked textually. The actual runtime
// behavior these guard is covered by src/server/window-registry.test.js (the map logic
// itself, extracted into an electron-free module specifically so it COULD be tested for
// real) and src/client/project-open-flow.test.js (the renderer decision logic).

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS_PATH = path.join(__dirname, '..', '..', 'main.js');
const PRELOAD_JS_PATH = path.join(__dirname, '..', '..', 'preload.js');
const TEMPLATE_HTML_PATH = path.join(__dirname, '..', '..', 'src', 'client', 'template.html');
const MENU_I18N_PATH = path.join(__dirname, '..', '..', 'main', 'menu-i18n.js');

const mainSrc = fs.readFileSync(MAIN_JS_PATH, 'utf8');
const preloadSrc = fs.readFileSync(PRELOAD_JS_PATH, 'utf8');
const templateSrc = fs.readFileSync(TEMPLATE_HTML_PATH, 'utf8');
const menuI18nSrc = fs.readFileSync(MENU_I18N_PATH, 'utf8');

test('adoptProjectIntoWindow checks for an existing owner before claiming the project (the A1 fix — no more silent overwrite)', () => {
  const fnStart = mainSrc.indexOf('function adoptProjectIntoWindow(');
  const fnEnd = mainSrc.indexOf('\nfunction ', fnStart + 1);
  assert.notEqual(fnStart, -1, 'expected adoptProjectIntoWindow to exist');
  const body = mainSrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  const ownerCheckIdx = body.search(/ownerOf\(projectRoot\)/);
  const claimIdx = body.search(/claimProject\(projectRoot,\s*w\)/);
  assert.notEqual(ownerCheckIdx, -1, 'expected an ownerOf(projectRoot) check');
  assert.notEqual(claimIdx, -1, 'expected a claimProject(projectRoot, w) call');
  assert.ok(ownerCheckIdx < claimIdx, 'the owner check must run BEFORE claiming the slot — this IS the A1 fix');
});

test('createSetupWindow registers itself in the setup registry and carries the C1429 close guard (was completely invisible to windowsByProject before C1388)', () => {
  const fnStart = mainSrc.indexOf('function createSetupWindow(');
  const fnEnd = mainSrc.indexOf('\nfunction ', fnStart + 1);
  assert.notEqual(fnStart, -1, 'expected createSetupWindow to exist');
  const body = mainSrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.match(body, /claimSetup\(/, 'expected createSetupWindow to register in the setup registry');
  assert.match(body, /attachCloseGuard\(w\)/, 'expected the C1429 close guard — an adopted setup window becomes a real project window with live sessions');
  assert.match(body, /releaseSetup\(w\)/, 'expected the closed handler to release its own setup registration');
});

test("createProjectWindow's closed handler reads the window's CURRENT dir off projectDirs, not a captured closure variable", () => {
  const fnStart = mainSrc.indexOf('function createProjectWindow(');
  assert.notEqual(fnStart, -1, 'expected createProjectWindow to exist');
  const closedIdx = mainSrc.indexOf("w.on('closed'", fnStart);
  assert.notEqual(closedIdx, -1, 'expected a closed handler inside createProjectWindow');
  const closedBody = mainSrc.slice(closedIdx, closedIdx + 700);
  assert.match(closedBody, /projectDirs\.get\(wcId\)/, 'the closed handler must read the CURRENT dir off projectDirs — a closure value can be stale after an in-place adopt/heal');
  assert.match(closedBody, /releaseProject\(dir,\s*w\)/, 'the closed handler must release identity-checked, not unconditionally');
});

test('open-project folder picker allows creating a new directory (createDirectory) — required for the unified Open/Create flow to create a project in a new folder', () => {
  const idx = mainSrc.indexOf("ipcMain.handle('open-project'");
  assert.notEqual(idx, -1, "expected an 'open-project' IPC handler");
  const body = mainSrc.slice(idx, idx + 600);
  assert.match(body, /properties:\s*\['openDirectory',\s*'createDirectory'\]/);
});

test('the Project menu\'s open action is labelled via menu-i18n\'s "Open / Create Project…" key, not a hardcoded English string', () => {
  assert.match(mainSrc, /label:\s*mt\('menu\.openOrCreateProject'\)/, 'expected createMenu() to localize the renamed menu item via mt()');
  assert.match(menuI18nSrc, /'menu\.openOrCreateProject':\s*'Open \/ Create Project…'/, "expected the en table to define the renamed label");
});

test("the dead 'project:select-requested' channel is gone from BOTH preload.js and template.html (removing only one side throws inside template.html's linear electronAPI block — the other button/reauth wiring after it would silently stop running)", () => {
  assert.doesNotMatch(preloadSrc, /onProjectSelectRequested\s*:/, 'preload.js must not expose onProjectSelectRequested any more');
  assert.doesNotMatch(templateSrc, /window\.electronAPI\.onProjectSelectRequested\(/, 'template.html must not call onProjectSelectRequested any more');
});
