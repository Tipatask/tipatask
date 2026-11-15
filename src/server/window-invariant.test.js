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

// (TPT9318) Open Project… and Create Project… are two Project-menu items with their own
// project:menu actions — the renderer's openOrCreateProject(entry) takes the action as its entry.
test('the Project menu has separate Open Project… and Create Project… items, localized via mt(), sending distinct project:menu actions', () => {
  const item = (key) => {
    const at = mainSrc.indexOf(`label: mt('${key}')`);
    assert.notEqual(at, -1, `expected createMenu() to localize ${key} via mt()`);
    return mainSrc.slice(at, mainSrc.indexOf('\n        },', at));
  };
  const open = item('menu.openProject');
  assert.match(open, /accelerator: 'CmdOrCtrl\+Shift\+O'/);
  assert.match(open, /webContents\.send\('project:menu', 'open'\)/);
  const create = item('menu.createProject');
  assert.match(create, /accelerator: 'CmdOrCtrl\+Shift\+N'/);
  assert.match(create, /webContents\.send\('project:menu', 'create'\)/);
  assert.ok(mainSrc.indexOf("label: mt('menu.openProject')") < mainSrc.indexOf("label: mt('menu.createProject')"), 'Open Project… comes first');
  assert.ok(mainSrc.indexOf("label: mt('menu.createProject')") < mainSrc.indexOf("label: mt('menu.recentProjects')"), 'both precede Recent Projects');
  assert.doesNotMatch(mainSrc, /menu\.openOrCreateProject/, 'the combined Open / Create item is gone');
  const { LOCALES } = require('../../main/menu-i18n');
  assert.equal(LOCALES.en['menu.openProject'], 'Open Project…');
  assert.equal(LOCALES.en['menu.createProject'], 'Create Project…');
  for (const [locale, table] of Object.entries(LOCALES)) {
    for (const key of ['menu.openProject', 'menu.createProject']) {
      assert.ok(typeof table[key] === 'string' && table[key].endsWith('…'), `${locale} ${key} opens a dialog, so it ends with an ellipsis`);
    }
    assert.equal(table['menu.openOrCreateProject'], undefined, `${locale} drops the combined label`);
  }
  assert.notEqual(LOCALES.uk['menu.openProject'], LOCALES.en['menu.openProject']);
  assert.notEqual(LOCALES.uk['menu.createProject'], LOCALES.en['menu.createProject']);
  assert.doesNotMatch(menuI18nSrc, /menu\.openOrCreateProject/);
});

test("open-project titles its folder picker by entry: Create Project asks to select or create a folder", async () => {
  const vm = require('node:vm');
  const start = mainSrc.indexOf("  ipcMain.handle('open-project'");
  const end = mainSrc.indexOf('\n  });', start) + '\n  });'.length;
  assert.ok(start >= 0 && end > start);
  let handler;
  const titles = [];
  vm.runInNewContext(mainSrc.slice(start, end), {
    ipcMain: { handle: (_, fn) => { handler = fn; } },
    BrowserWindow: { fromWebContents: () => ({}) },
    dialog: { showOpenDialog: async (_w, opts) => { titles.push(opts.title); return { canceled: true, filePaths: [] }; } },
    mt: (key) => `<${key}>`,
  });
  assert.equal(await handler({ sender: {} }, 'open'), null);
  assert.equal(await handler({ sender: {} }, 'create'), null);
  assert.equal(await handler({ sender: {} }), null);
  assert.deepEqual(titles, ['<dialog.openProjectDirectory>', '<dialog.selectOrCreateProjectFolder>', '<dialog.openProjectDirectory>']);
  assert.match(preloadSrc, /pickAndOpenProject: \(entry\) => inv\('open-project', entry\)/, 'preload forwards the entry');
});

test("the dead 'project:select-requested' channel is gone from BOTH preload.js and template.html (removing only one side throws inside template.html's linear electronAPI block — the other button/reauth wiring after it would silently stop running)", () => {
  assert.doesNotMatch(preloadSrc, /onProjectSelectRequested\s*:/, 'preload.js must not expose onProjectSelectRequested any more');
  assert.doesNotMatch(templateSrc, /window\.electronAPI\.onProjectSelectRequested\(/, 'template.html must not call onProjectSelectRequested any more');
});
