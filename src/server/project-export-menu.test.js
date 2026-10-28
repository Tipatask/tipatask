'use strict';

// (TPT9167) main/project-export.js — tested from here because npm test only globs
// src/**/*.test.js (same reason as menu-i18n.test.js). The module has no electron import:
// BrowserWindow, dialog and the archive builder are injected.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EXPORT_MENU_ITEM_ID, focusedProjectWindow, createProjectExporter, describeExportError, writeFileAtomic,
} = require('../../main/project-export');
const { buildProjectArchive, archiveFileName } = require('./project-archive');
const { setMenuLocale, LOCALES } = require('../../main/menu-i18n');

function fakeWindow(id, { destroyed = false } = {}) {
  const sent = [];
  return {
    sent,
    destroyed,
    isDestroyed() { return this.destroyed; },
    webContents: {
      id,
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

function scratchDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpt-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeBackend() {
  return {
    async getTasksUnfiltered() {
      return [
        { id: 'X1', dbId: 1, title: 'Open', status: 'pending', priority: 1, dependencies: ['X2'], tags: [] },
        { id: 'X2', dbId: 2, title: 'Done', status: 'completed', priority: 1, dependencies: [], tags: [] },
      ];
    },
    async getStatuses() {
      return [
        { name: 'pending', display_order: 0, is_workflow_start: true },
        { name: 'completed', display_order: 1, is_workflow_complete: true },
        { name: 'canceled', display_order: 2, is_workflow_canceled: true },
      ];
    },
    async getSprints() { return [{ number: 1, name: 'Sprint 1' }]; },
    async getTagsDetailed() { return []; },
    async getProjectSettings() { return { name: 'Export Me', language: 'en', task_prefix: 'X' }; },
  };
}

// ── focusedProjectWindow: the Export item's enabled state ──

test('focusedProjectWindow is null when no window is focused', () => {
  const BrowserWindow = { getFocusedWindow: () => null };
  assert.equal(focusedProjectWindow({ BrowserWindow, projectDirs: new Map(), hasBackend: () => true }), null);
});

test('focusedProjectWindow is null for a focused window that is not a project window', () => {
  const splash = fakeWindow(1);
  const unbound = fakeWindow(2);
  const projectDirs = new Map([[2, null]]); // Get Started window: registered, no project yet
  for (const w of [splash, unbound]) {
    const BrowserWindow = { getFocusedWindow: () => w };
    assert.equal(focusedProjectWindow({ BrowserWindow, projectDirs, hasBackend: () => true }), null);
  }
});

test('focusedProjectWindow is null for a project window that is not set up yet, or destroyed', () => {
  const w = fakeWindow(3);
  const projectDirs = new Map([[3, '/p']]);
  const BrowserWindow = { getFocusedWindow: () => w };
  assert.equal(focusedProjectWindow({ BrowserWindow, projectDirs, hasBackend: () => false }), null);
  w.destroyed = true;
  assert.equal(focusedProjectWindow({ BrowserWindow, projectDirs, hasBackend: () => true }), null);
});

test('focusedProjectWindow returns the focused, configured project window', () => {
  const w = fakeWindow(4);
  const BrowserWindow = { getFocusedWindow: () => w };
  assert.equal(focusedProjectWindow({ BrowserWindow, projectDirs: new Map([[4, '/p']]), hasBackend: () => true }), w);
});

// ── createProjectExporter ──

test('exporter: a cancelled save dialog builds and sends nothing', async () => {
  let built = false;
  const exportProject = createProjectExporter({
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    buildArchive: async () => { built = true; },
    fileNameFor: archiveFileName,
  });
  const win = fakeWindow(5);
  const res = await exportProject(win, { projectDir: '/p', projectName: 'P', backend: {} });
  assert.deepEqual(res, { ok: false, reason: 'canceled' });
  assert.equal(built, false);
  assert.deepEqual(win.sent, []);
});

test('exporter: saves the archive where the user chose, adding .zip, and reports started then done', async (t) => {
  const dir = scratchDir(t);
  setMenuLocale('uk');
  t.after(() => setMenuLocale('en'));
  let dialogOptions = null;
  const exportProject = createProjectExporter({
    dialog: { showSaveDialog: async (win, opts) => { dialogOptions = opts; return { canceled: false, filePath: path.join(dir, 'backup') }; } },
    buildArchive: (projectDir, backend) => buildProjectArchive(projectDir, backend),
    fileNameFor: archiveFileName,
  });
  const projectDir = scratchDir(t);
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Claude');
  const win = fakeWindow(6);

  const res = await exportProject(win, { projectDir, projectName: 'Export Me', backend: fakeBackend() });

  const target = path.join(dir, 'backup.zip');
  assert.equal(res.ok, true);
  assert.equal(res.filePath, target);
  assert.equal(dialogOptions.title, LOCALES.uk['dialog.exportProjectTitle']);
  assert.equal(dialogOptions.defaultPath, 'export-me-export.zip');
  assert.deepEqual(dialogOptions.filters, [{ name: LOCALES.uk['dialog.zipArchive'], extensions: ['zip'] }]);
  assert.deepEqual(win.sent.map((s) => s.channel), ['project:export', 'project:export']);
  assert.deepEqual(win.sent[0].payload, { state: 'started', fileName: 'backup.zip' });
  assert.deepEqual(win.sent[1].payload, {
    state: 'done', fileName: 'backup.zip', filePath: target,
    counts: { kbFiles: 1, tasks: 1, sprints: 1, tags: 0, statuses: 3 },
  });

  // The saved file is a zip whose first entry is manifest.json.
  const bytes = fs.readFileSync(target);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'local file header signature');
  const nameLength = bytes.readUInt16LE(26);
  assert.equal(bytes.toString('utf8', 30, 30 + nameLength), 'manifest.json');
  assert.deepEqual(fs.readdirSync(dir), ['backup.zip'], 'no temp file left behind');
});

test('exporter: a project without a backend reports setup and never opens the dialog', async () => {
  let asked = false;
  const exportProject = createProjectExporter({
    dialog: { showSaveDialog: async () => { asked = true; return { canceled: true }; } },
    buildArchive: async () => { throw new Error('unreachable'); },
    fileNameFor: archiveFileName,
  });
  const win = fakeWindow(7);
  const res = await exportProject(win, { projectDir: '/p', projectName: 'P', backend: null });
  assert.deepEqual(res, { ok: false, reason: 'setup' });
  assert.equal(asked, false);
  assert.deepEqual(win.sent.map((s) => s.payload), [{ state: 'failed', code: 'setup', error: '' }]);
});

test('exporter: a build failure reports failed with a code and writes no file', async (t) => {
  const dir = scratchDir(t);
  const cases = [
    [Object.assign(new Error('Authentication required for this project'), { authError: true, statusCode: 401 }), { code: 'auth', error: '' }],
    [Object.assign(new Error('fetch failed'), { networkError: true }), { code: 'network', error: '' }],
    [new Error('Project statuses unavailable\nstack noise'), { code: 'failed', error: 'Project statuses unavailable' }],
  ];
  for (const [err, expected] of cases) {
    const exportProject = createProjectExporter({
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(dir, 'out.zip') }) },
      buildArchive: async () => { throw err; },
      fileNameFor: archiveFileName,
      log: { warn() {} },
    });
    const win = fakeWindow(8);
    const res = await exportProject(win, { projectDir: '/p', projectName: 'P', backend: {} });
    assert.deepEqual(res, { ok: false, reason: 'failed' });
    assert.deepEqual(win.sent.map((s) => s.payload.state), ['started', 'failed']);
    assert.deepEqual(win.sent[1].payload, { state: 'failed', ...expected });
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('exporter: a second request for the same window while one runs is ignored', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const exportProject = createProjectExporter({
    dialog: { showSaveDialog: async () => { await gate; return { canceled: true }; } },
    buildArchive: async () => {},
    fileNameFor: archiveFileName,
  });
  const win = fakeWindow(9);
  const first = exportProject(win, { projectDir: '/p', projectName: 'P', backend: {} });
  assert.deepEqual(await exportProject(win, { projectDir: '/p', projectName: 'P', backend: {} }), { ok: false, reason: 'busy' });
  release();
  assert.deepEqual(await first, { ok: false, reason: 'canceled' });
});

test('describeExportError keeps API bodies out of auth and transport failures', () => {
  assert.deepEqual(describeExportError(Object.assign(new Error('API 403: {"error":"x"}'), { statusCode: 403 })), { code: 'auth', error: '' });
  assert.deepEqual(describeExportError(Object.assign(new Error('missing'), { missingCredentials: true })), { code: 'auth', error: '' });
  assert.equal(describeExportError(new Error('x'.repeat(400))).error.length, 300);
});

test('writeFileAtomic leaves no file when the write fails', async (t) => {
  const dir = scratchDir(t);
  await assert.rejects(writeFileAtomic(path.join(dir, 'missing-dir', 'a.zip'), Buffer.from('x')));
  assert.deepEqual(fs.readdirSync(dir), []);
});

// ── main.js wiring. main.js requires `electron`, so its functions are lifted out of the source
// and run in a vm context against fakes (same approach as window-close-lifecycle.test.js). ──

const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');

function mainFunction(name) {
  const start = MAIN_SRC.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `main.js has no function ${name}`);
  const open = MAIN_SRC.indexOf('{', MAIN_SRC.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < MAIN_SRC.length; i++) {
    if (MAIN_SRC[i] === '{') depth++;
    else if (MAIN_SRC[i] === '}' && --depth === 0) return MAIN_SRC.slice(start, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

function menuHarness() {
  const vm = require('node:vm');
  const item = { id: EXPORT_MENU_ITEM_ID, enabled: true };
  const state = { focused: null, exports: [] };
  const projectDirs = new Map();
  const backends = new Map();
  const ctx = {
    console: { warn() {} },
    EXPORT_MENU_ITEM_ID,
    focusedProjectWindow,
    projectDirs,
    BrowserWindow: { getFocusedWindow: () => state.focused },
    Menu: { getApplicationMenu: () => ({ getMenuItemById: (id) => (id === EXPORT_MENU_ITEM_ID ? item : null) }) },
    getWindowState: (id) => ({ backend: backends.get(id) || null }),
    getDisplayName: (dir) => `name of ${dir}`,
    exportProject: async (win, opts) => { state.exports.push({ win, opts }); return { ok: true }; },
  };
  vm.createContext(ctx);
  vm.runInContext(['exportTargetWindow', 'syncProjectMenuState', 'exportProjectFromMenu'].map(mainFunction).join('\n'), ctx);
  return { ctx, item, state, projectDirs, backends };
}

test('main.js keeps Export… disabled unless a configured project window is focused', () => {
  const { ctx, item, state, projectDirs, backends } = menuHarness();
  const project = fakeWindow(21);
  const getStarted = fakeWindow(22);
  const about = fakeWindow(23);
  const awaitingSetup = fakeWindow(24);
  projectDirs.set(21, '/projects/a');
  projectDirs.set(22, null);
  projectDirs.set(24, '/projects/b');
  backends.set(21, {});

  const enabledWith = (focused) => { state.focused = focused; ctx.syncProjectMenuState(); return item.enabled; };
  assert.equal(enabledWith(null), false, 'no focused window (app in the background)');
  assert.equal(enabledWith(getStarted), false, 'unbound Get Started window');
  assert.equal(enabledWith(project), true, 'configured project window');
  assert.equal(enabledWith(about), false, 'About / notices / banner window');
  assert.equal(enabledWith(awaitingSetup), false, 'project waiting for setup');
  project.destroyed = true;
  assert.equal(enabledWith(project), false, 'closed project window');
});

test('main.js createMenu() builds Project ▸ Export… disabled until a project window is focused', () => {
  const vm = require('node:vm');
  const { mt } = require('../../main/menu-i18n');
  const project = fakeWindow(41);
  const state = { focused: null, appMenu: null };
  const findItem = (items, id) => {
    for (const entry of items || []) {
      if (entry.id === id) return entry;
      const hit = findItem(entry.submenu, id);
      if (hit) return hit;
    }
    return null;
  };
  const noop = () => {};
  const ctx = {
    process: { platform: 'darwin' },
    console: { warn: noop },
    EXPORT_MENU_ITEM_ID,
    focusedProjectWindow,
    projectDirs: new Map([[41, '/projects/a']]),
    BrowserWindow: { getFocusedWindow: () => state.focused },
    Menu: {
      buildFromTemplate: (template) => ({ template, getMenuItemById: (id) => findItem(template, id) }),
      setApplicationMenu: (menu) => { state.appMenu = menu; },
      getApplicationMenu: () => state.appMenu,
    },
    getWindowState: () => ({ backend: {} }),
    app: { name: 'TipATask' },
    mt,
    shell: {},
    desktopNotifications: null,
    loadRecentProjects: () => [],
    getDisplayName: (dir) => dir,
    createProjectWindow: noop, openNoticesWindow: noop, openAboutWindow: noop, confirmAndQuit: noop,
    sendVoiceShortcut: noop, showVoiceShortcutDiagnostics: noop, applyNotificationsOnTop: noop,
    exportProject: async () => ({ ok: true }),
  };
  vm.createContext(ctx);
  vm.runInContext(['notificationsMenu', 'exportTargetWindow', 'syncProjectMenuState', 'exportProjectFromMenu', 'createMenu']
    .map(mainFunction).join('\n'), ctx);

  ctx.createMenu();
  const projectMenu = state.appMenu.template.find((m) => m.label === mt('menu.project'));
  const labels = projectMenu.submenu.map((entry) => entry.label || entry.type || entry.role);
  const exportIdx = labels.indexOf(mt('menu.exportProject'));
  assert.ok(exportIdx > labels.indexOf(mt('menu.mergeTaskBranches')) && exportIdx < labels.indexOf(mt('menu.knowledgeBase')),
    `Export… sits between Merge task branches… and Knowledge Base: ${labels.join(' | ')}`);
  const item = state.appMenu.getMenuItemById(EXPORT_MENU_ITEM_ID);
  assert.equal(item.enabled, false, 'built while no window is focused');

  state.focused = project;
  ctx.syncProjectMenuState();
  assert.equal(item.enabled, true, 'enabled once the project window takes focus');
  ctx.createMenu(); // a rebuild (locale change, rename) keeps the focus-derived state
  assert.equal(state.appMenu.getMenuItemById(EXPORT_MENU_ITEM_ID).enabled, true);
  state.focused = null;
  ctx.syncProjectMenuState();
  assert.equal(state.appMenu.getMenuItemById(EXPORT_MENU_ITEM_ID).enabled, false, 'disabled again after blur');
});

test('main.js exports the focused project window only', async () => {
  const { ctx, state, projectDirs, backends } = menuHarness();
  const project = fakeWindow(31);
  const other = fakeWindow(32);
  const backend = {};
  projectDirs.set(31, '/projects/a');
  backends.set(31, backend);

  state.focused = project;
  ctx.exportProjectFromMenu(project);
  assert.equal(state.exports.length, 1);
  assert.equal(state.exports[0].win, project);
  const { projectDir, projectName, backend: passed } = state.exports[0].opts; // vm-realm object
  assert.deepEqual([projectDir, projectName], ['/projects/a', 'name of /projects/a']);
  assert.equal(passed, backend);

  ctx.exportProjectFromMenu(other); // menu event from a window that is not the focused project window
  state.focused = null;
  ctx.exportProjectFromMenu(project);
  assert.equal(state.exports.length, 1);
});

test('main.js Project menu carries Export… with the shared id and a focus-derived enabled state', () => {
  const src = MAIN_SRC;
  assert.equal(EXPORT_MENU_ITEM_ID, 'project-export');
  const itemIdx = src.indexOf("label: mt('menu.exportProject')");
  assert.ok(itemIdx > 0 && itemIdx > src.indexOf("label: mt('menu.mergeTaskBranches')"), 'sits after Merge task branches…');
  const item = src.slice(src.lastIndexOf('{', itemIdx), src.indexOf('},', itemIdx));
  assert.match(item, /id: EXPORT_MENU_ITEM_ID/);
  assert.match(item, /enabled: !!exportTargetWindow\(\)/);
  assert.match(item, /click: \(mi, window\) => exportProjectFromMenu\(window\)/);
  assert.match(src, /app\.on\('browser-window-focus', \(\) => syncProjectMenuState\(\)\);/);
  assert.match(src, /app\.on\('browser-window-blur', \(\) => syncProjectMenuState\(\)\);/);
  assert.match(src, /getMenuItemById\(EXPORT_MENU_ITEM_ID\)/);
  // In-place rebinds keep focus, so they re-sync the item themselves.
  assert.equal((src.match(/bindWindowToProject\([^)]*\);\n\s*syncProjectMenuState\(\);/g) || []).length, 3);
});

test('every menu-i18n locale labels the Export item and its save dialog', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.ok(table['menu.exportProject']?.endsWith('…'), `${locale} menu.exportProject ends with an ellipsis`);
    assert.ok(table['dialog.exportProjectTitle'], `${locale} dialog.exportProjectTitle`);
    assert.ok(table['dialog.zipArchive'], `${locale} dialog.zipArchive`);
  }
});
