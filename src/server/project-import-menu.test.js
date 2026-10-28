'use strict';

// (TPT9169) main/project-import.js — tested from here because npm test only globs
// src/**/*.test.js (same reason as project-export-menu.test.js). The module has no electron
// import: the dialog and every project step are injected. Archives are real ones, written by
// buildProjectArchive() and imported by the real importProjectArchive() into an in-memory
// backend, so a run here walks the same archive code the app does.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { createProjectImporter, inspectFolder, archiveErrorText, importReport } = require('../../main/project-import');
const { buildProjectArchive, validateProjectArchive, importProjectArchive, ARCHIVE_ERROR_CODES } = require('./project-archive');
const { setMenuLocale, LOCALES, mt } = require('../../main/menu-i18n');

function scratchDir(t, prefix = 'tpt-import-menu-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

function fakeWindow(id) {
  const sent = [];
  return {
    sent,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: { id, isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

// The renderer side of an ipcMain.handle call: event.sender is a WebContents.
function fakeSender(id = 1) {
  const sent = [];
  return { id, sent, isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
}

const KB = {
  'CLAUDE.md': '# Claude',
  'ai/architecture/GENERAL.md': '# General',
  'ai/architecture/tt-alpha.md': '# Alpha',
};

// A source project exported with the real buildProjectArchive(): two open tasks (one depends on
// the other), one sprint, three KB files.
async function exportedArchive(t) {
  const sourceRoot = scratchDir(t, 'tpt-import-menu-source-');
  writeTree(sourceRoot, KB);
  const { buffer } = await buildProjectArchive(sourceRoot, {
    async getTasksUnfiltered() {
      return [
        { id: 'S1', dbId: 1, title: 'First', description: 'one', status: 'pending', priority: 1, order: 0, dependencies: [], tags: [] },
        { id: 'S2', dbId: 2, title: 'Second', description: 'two', status: 'pending', priority: 1, order: 1, dependencies: ['S1'], tags: [] },
      ];
    },
    async getStatuses() {
      return [
        { id: 1, name: 'pending', display_order: 0, is_workflow_start: 1 },
        { id: 2, name: 'completed', display_order: 1, is_workflow_complete: 1 },
      ];
    },
    async getSprints() { return [{ id: 1, number: 1, name: 'Sprint 1', status: 'active' }]; },
    async getTagsDetailed() { return []; },
    async getProjectSettings() { return { name: 'Source Project', language: 'en', task_prefix: 'SRC' }; },
  }, { appVersion: '1.2.3' });
  const file = path.join(scratchDir(t, 'tpt-import-menu-zip-'), 'source-project-export.zip');
  fs.writeFileSync(file, buffer);
  return file;
}

// An in-memory api-backend stand-in: keyless creates get NEW<n> keys; failOnCreate makes the
// n-th createTask throw the way an unreachable API does.
function memoryBackend({ failOnCreate = 0 } = {}) {
  const statuses = [
    { id: 1, name: 'pending', color: null, display_order: 0, is_workflow_start: true },
    { id: 2, name: 'completed', color: null, display_order: 1, is_workflow_complete: true },
  ];
  const tags = new Map();
  const sprints = [];
  const tasks = new Map();
  return {
    sprints, tasks,
    async getStatuses() { return statuses.map((s) => ({ ...s })); },
    async createStatus(fields) { const row = { id: statuses.length + 1, display_order: statuses.length, ...fields }; statuses.push(row); return row; },
    async updateStatus(id, fields) { Object.assign(statuses.find((s) => s.id === id), fields); },
    async reorderStatuses() { return statuses.map((s) => ({ ...s })); },
    async ensureTag(name, description) { tags.set(name, description); },
    async getTags() { return [...tags.keys()]; },
    async createSprint(name, number, extra) { sprints.push({ name, number, ...extra }); return { name, number }; },
    async createTask(task) {
      if (failOnCreate === tasks.size + 1) {
        const err = new Error('API unreachable at http://127.0.0.1:9');
        err.networkError = true;
        throw err;
      }
      const row = { ...task, id: `NEW${tasks.size + 1}` };
      tasks.set(row.id, row);
      return { ...row };
    },
    async updateTask(id, fields) { Object.assign(tasks.get(id), fields); return { ...tasks.get(id) }; },
  };
}

// Every injected step records itself in `calls`; configureProject writes the files the real one
// writes (.tipatask/config.json and project.json), importArchive runs the real importer.
function harness(t, overrides = {}) {
  const calls = [];
  const backend = overrides.backend || memoryBackend();
  const dialogCalls = { open: [], message: [] };
  const deps = {
    dialog: {
      showOpenDialog: async (win, opts) => { dialogCalls.open.push(opts); return overrides.pick || { canceled: true, filePaths: [] }; },
      showMessageBox: async (win, opts) => { dialogCalls.message.push(opts); return { response: 0 }; },
    },
    validateArchive: (zipPath) => { calls.push(['validate']); return validateProjectArchive(zipPath); },
    isFolderOpen: overrides.isFolderOpen || (() => false),
    createProject: async ({ name }) => { calls.push(['create', name]); if (overrides.createFails) throw new Error('Failed to create project: {"error":"quota"}'); return { id: 77 }; },
    configureProject: async ({ projectPath, projectId, name, agentPreference }) => {
      calls.push(['configure', projectId, agentPreference.taskAgent]);
      writeTree(projectPath, {
        '.tipatask/config.json': JSON.stringify({ API_PROJECT_ID: String(projectId) }),
        '.tipatask/project.json': JSON.stringify({ name, apiProjectId: projectId }),
      });
      if (overrides.configureFails) throw new Error('Failed to register device');
      return { token: 'scoped-token' };
    },
    importArchive: async (zipPath, opts) => {
      calls.push(['import']);
      return importProjectArchive(zipPath, { ...opts, backend });
    },
    finishProject: async ({ token }) => { calls.push(['finish', token]); },
    removeProject: async ({ projectId }) => { calls.push(['remove', projectId]); if (overrides.removeFails) throw new Error('API returned 503'); },
    openProject: async (sender, projectPath) => { calls.push(['open', projectPath]); return 'new'; },
    log: { warn() {} },
  };
  return { importer: createProjectImporter(deps), calls, backend, dialogCalls };
}

async function chosenImport(t, h, zipPath) {
  const win = fakeWindow(5);
  const res = await h.importer.chooseArchive(win);
  assert.equal(res.ok, true, 'the archive was accepted');
  return { win, importId: res.importId, frame: win.sent[0].payload };
}

function detailFor(importId, projectPath, extra = {}) {
  return {
    importId,
    projectName: 'Imported Project',
    projectPath,
    apiBaseUrl: 'https://api.example.test/',
    userToken: 'user-token',
    agentPreference: { taskAgent: 'codex', availableAgents: ['codex'], piModels: [] },
    ...extra,
  };
}

// ── Choosing the archive ──

test('a cancelled open dialog sends nothing and keeps no pending import', async (t) => {
  const h = harness(t);
  const win = fakeWindow(1);
  assert.deepEqual(await h.importer.chooseArchive(win), { ok: false, reason: 'canceled' });
  assert.deepEqual(win.sent, []);
  assert.deepEqual(h.calls, [], 'not even validated');
  const [opts] = h.dialogCalls.open;
  assert.equal(opts.title, LOCALES.en['dialog.importProjectTitle']);
  assert.deepEqual(opts.filters, [{ name: LOCALES.en['dialog.zipArchive'], extensions: ['zip'] }]);
  assert.deepEqual(opts.properties, ['openFile']);
});

test('an invalid archive shows the error dialog with its localized reason and opens no wizard', async (t) => {
  const dir = scratchDir(t);
  const notZip = path.join(dir, 'notes.zip');
  fs.writeFileSync(notZip, 'plain text, not a zip');
  setMenuLocale('uk');
  t.after(() => setMenuLocale('en'));
  const h = harness(t, { pick: { canceled: false, filePaths: [notZip] } });
  const win = fakeWindow(2);
  const res = await h.importer.chooseArchive(win);
  assert.deepEqual(res, { ok: false, reason: 'invalid', code: 'not_zip' });
  assert.deepEqual(win.sent, [], 'no project:import-open frame');
  assert.equal(h.dialogCalls.message.length, 1);
  const box = h.dialogCalls.message[0];
  assert.equal(box.type, 'error');
  assert.equal(box.title, LOCALES.uk['dialog.importProjectTitle']);
  assert.equal(box.message, LOCALES.uk['dialog.importInvalidMessage']);
  assert.equal(box.detail, `notes.zip\n\n${LOCALES.uk['importError.not_zip']}`);
  assert.deepEqual(box.buttons, [LOCALES.uk['dialog.ok']]);
});

test('a valid archive opens the wizard with its summary under a fresh import id', async (t) => {
  const zip = await exportedArchive(t);
  const h = harness(t, { pick: { canceled: false, filePaths: [zip] } });
  const { win, importId, frame } = await chosenImport(t, h, zip);
  assert.match(importId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(win.sent.map((s) => s.channel), ['project:import-open']);
  assert.equal(frame.importId, importId);
  assert.equal(frame.archiveName, 'source-project-export.zip');
  assert.equal(frame.summary.projectName, 'Source Project');
  assert.equal(frame.summary.taskCount, 2);
  assert.equal(frame.summary.sprintCount, 1);
  assert.equal(frame.summary.kbFileCount, 3);
  assert.deepEqual(frame.summary.kbFiles.sort(), Object.keys(KB).sort());
  assert.ok(h.importer.isPending(importId));
  assert.deepEqual(h.dialogCalls.message, [], 'no error dialog');
});

test('a newer pick in the same window replaces the import that window had not started', async (t) => {
  const zip = await exportedArchive(t);
  const h = harness(t, { pick: { canceled: false, filePaths: [zip] } });
  const win = fakeWindow(9);
  const first = await h.importer.chooseArchive(win);
  const second = await h.importer.chooseArchive(win);
  assert.equal(h.importer.isPending(first.importId), false);
  assert.equal(h.importer.isPending(second.importId), true);
});

test('every validateProjectArchive() code has its own dialog reason in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    for (const code of ARCHIVE_ERROR_CODES) {
      assert.ok(table[`importError.${code}`]?.trim(), `${locale} importError.${code}`);
    }
    assert.ok(table['importError.unknown']?.trim(), `${locale} importError.unknown`);
    assert.ok(table['menu.importProject'].endsWith('…'), `${locale} menu.importProject ends with an ellipsis`);
    for (const key of ['dialog.importProjectTitle', 'dialog.importInvalidMessage', 'dialog.ok']) assert.ok(table[key]?.trim(), `${locale} ${key}`);
  }
  assert.notEqual(LOCALES.uk['importError.corrupt'], LOCALES.en['importError.corrupt']);
  setMenuLocale('en');
  assert.equal(archiveErrorText('not_zip'), LOCALES.en['importError.not_zip']);
  assert.equal(archiveErrorText('from_the_future'), LOCALES.en['importError.unknown']);
});

// ── The folder step ──

test('inspectFolder: a configured, open or missing folder is refused; KB files already there are listed', (t) => {
  const dir = scratchDir(t);
  const kbFiles = Object.keys(KB);
  assert.equal(inspectFolder(path.join(dir, 'missing'), kbFiles).blocked, 'invalid');
  assert.equal(inspectFolder('relative/path', kbFiles).blocked, 'invalid');

  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  assert.deepEqual(inspectFolder(empty, kbFiles), { folder: empty, blocked: null, architectureFiles: 0, existingKbFiles: [] });
  assert.equal(inspectFolder(empty, kbFiles, (d) => d === empty).blocked, 'open');

  const checkout = path.join(dir, 'checkout');
  writeTree(checkout, { 'ai/architecture/GENERAL.md': '# mine', 'ai/architecture/tt-other.md': '# other', 'CLAUDE.md': '# mine' });
  fs.mkdirSync(path.join(checkout, 'ai', 'architecture', 'nested'));
  const check = inspectFolder(checkout, kbFiles);
  assert.equal(check.blocked, null);
  assert.equal(check.architectureFiles, 2, 'files directly in ai/architecture, folders not counted');
  assert.deepEqual(check.existingKbFiles, ['CLAUDE.md', 'ai/architecture/GENERAL.md']);

  writeTree(checkout, { '.tipatask/config.json': '{}' });
  assert.equal(inspectFolder(checkout, kbFiles).blocked, 'configured');
});

test('checkFolder answers for a pending import only', async (t) => {
  const zip = await exportedArchive(t);
  const h = harness(t, { pick: { canceled: false, filePaths: [zip] } });
  const { importId } = await chosenImport(t, h, zip);
  const folder = scratchDir(t);
  writeTree(folder, { 'ai/architecture/GENERAL.md': '# mine' });
  assert.deepEqual(h.importer.checkFolder(importId, folder), {
    ok: true, folder, blocked: null, architectureFiles: 1, existingKbFiles: ['ai/architecture/GENERAL.md'],
  });
  assert.deepEqual(h.importer.checkFolder('not-an-import', folder), { ok: false, code: 'expired' });
});

// ── Cancel ──

test('cancel releases the pending import: nothing is created and a later run is refused', async (t) => {
  const zip = await exportedArchive(t);
  const h = harness(t, { pick: { canceled: false, filePaths: [zip] } });
  const { importId } = await chosenImport(t, h, zip);
  const folder = scratchDir(t);
  assert.equal(h.importer.cancel(importId), true);
  assert.equal(h.importer.cancel(importId), false, 'already released');
  assert.deepEqual(await h.importer.run(fakeSender(), detailFor(importId, folder)), { ok: false, code: 'expired' });
  assert.deepEqual(h.calls.filter(([step]) => step !== 'validate'), [], 'no project created, configured or opened');
  assert.deepEqual(fs.readdirSync(folder), [], 'the folder is untouched');
});

// ── The import ──

test('run: creates the project, imports the archive into the folder, finishes and opens it', async (t) => {
  const zip = await exportedArchive(t);
  const h = harness(t, { pick: { canceled: false, filePaths: [zip] } });
  const { importId } = await chosenImport(t, h, zip);
  const folder = scratchDir(t);
  const sender = fakeSender();

  const res = await h.importer.run(sender, detailFor(importId, folder));

  assert.deepEqual(res, {
    ok: true,
    projectPath: folder,
    projectId: 77,
    opened: 'new',
    report: { tasks: 2, sprints: 1, kbWritten: 3, kbSkipped: [], tagsSkipped: 0, dropped: { dependencies: 0, parents: 0, tags: 0 } },
  });
  assert.deepEqual(h.calls, [
    ['validate'], ['validate'], ['create', 'Imported Project'], ['configure', 77, 'codex'], ['import'],
    ['finish', 'scoped-token'], ['open', folder],
  ]);
  for (const [key, text] of Object.entries(KB)) {
    assert.equal(fs.readFileSync(path.join(folder, ...key.split('/')), 'utf8'), text, `${key} written`);
  }
  // The second task still depends on the first, under the keys the API gave them.
  const [first, second] = [...h.backend.tasks.values()];
  assert.equal(first.title, 'First');
  assert.deepEqual(second.dependencies, [first.id]);
  assert.deepEqual(h.backend.sprints.map((s) => s.number), [1]);

  const steps = sender.sent.map((s) => s.payload.step);
  assert.ok(sender.sent.every((s) => s.channel === 'project:import-progress' && s.payload.importId === importId));
  assert.deepEqual([...new Set(steps)], ['project', 'kb', 'statuses', 'tags', 'sprints', 'tasks', 'finish']);
  assert.deepEqual(sender.sent.filter((s) => s.payload.step === 'tasks').map((s) => s.payload.done), [0, 1, 2]);
  assert.equal(h.importer.isPending(importId), false, 'a finished import is done');
});

test('run: KB files already in the folder are kept and reported, never replaced', async (t) => {
  const zip = await exportedArchive(t);
  const h = harness(t, { pick: { canceled: false, filePaths: [zip] } });
  const { importId } = await chosenImport(t, h, zip);
  const folder = scratchDir(t);
  writeTree(folder, { 'ai/architecture/GENERAL.md': '# the checkout copy' });
  const res = await h.importer.run(fakeSender(), detailFor(importId, folder));
  assert.equal(res.ok, true);
  assert.deepEqual(res.report.kbSkipped, ['ai/architecture/GENERAL.md']);
  assert.equal(res.report.kbWritten, 2);
  assert.equal(fs.readFileSync(path.join(folder, 'ai', 'architecture', 'GENERAL.md'), 'utf8'), '# the checkout copy');
});

test('run: a failed task create removes the new project and its config, keeps the written KB files', async (t) => {
  const zip = await exportedArchive(t);
  const h = harness(t, { pick: { canceled: false, filePaths: [zip] }, backend: memoryBackend({ failOnCreate: 2 }) });
  const { importId } = await chosenImport(t, h, zip);
  const folder = scratchDir(t);

  const res = await h.importer.run(fakeSender(), detailFor(importId, folder));

  assert.deepEqual(res, {
    ok: false, code: 'import', step: 'tasks', error: 'API unreachable at http://127.0.0.1:9',
    removed: true, projectId: 77, projectName: 'Imported Project',
  });
  assert.deepEqual(h.calls.map(([step]) => step), ['validate', 'validate', 'create', 'configure', 'import', 'remove']);
  assert.equal(fs.existsSync(path.join(folder, '.tipatask')), false, 'config.json, project.json and the .tipatask folder are gone');
  assert.ok(fs.existsSync(path.join(folder, 'CLAUDE.md')), 'KB files already written stay');
  assert.equal(h.importer.isPending(importId), true, 'the archive can be imported again, into a new project');
});

test('run: a failed setup step still removes the project; a refused delete is reported', async (t) => {
  const zip = await exportedArchive(t);
  const h = harness(t, { pick: { canceled: false, filePaths: [zip] }, configureFails: true, removeFails: true });
  const { importId } = await chosenImport(t, h, zip);
  const folder = scratchDir(t);
  writeTree(folder, { '.tipatask/project.json': '{"name":"kept"}' });

  const res = await h.importer.run(fakeSender(), detailFor(importId, folder));

  assert.equal(res.code, 'import');
  assert.equal(res.step, 'configure');
  assert.equal(res.removed, false);
  assert.deepEqual(h.calls.map(([step]) => step), ['validate', 'validate', 'create', 'configure', 'remove']);
  assert.equal(fs.existsSync(path.join(folder, '.tipatask', 'config.json')), false);
  // project.json was there before the import, so the rollback keeps it (and its folder).
  assert.ok(fs.existsSync(path.join(folder, '.tipatask', 'project.json')));
});

test('run: refusals happen before anything is created', async (t) => {
  const zip = await exportedArchive(t);
  const h = harness(t, { pick: { canceled: false, filePaths: [zip] }, createFails: true });
  const { importId } = await chosenImport(t, h, zip);
  const folder = scratchDir(t);
  const configured = scratchDir(t);
  writeTree(configured, { '.tipatask/config.json': '{}' });
  const sender = fakeSender();

  assert.deepEqual(await h.importer.run(sender, detailFor(importId, folder, { projectName: '   ' })), { ok: false, code: 'name' });
  assert.deepEqual(await h.importer.run(sender, detailFor(importId, folder, { projectName: 'x'.repeat(256) })), { ok: false, code: 'name' });
  assert.deepEqual(await h.importer.run(sender, detailFor(importId, folder, { userToken: '' })), { ok: false, code: 'signin' });
  assert.deepEqual(await h.importer.run(sender, detailFor(importId, configured)), { ok: false, code: 'folder', blocked: 'configured' });
  assert.deepEqual(h.calls, [['validate']], 'only the menu-time validation ran');

  // The API refuses the create: reported, nothing to undo.
  const res = await h.importer.run(sender, detailFor(importId, folder));
  assert.deepEqual(res, { ok: false, code: 'create', error: 'Failed to create project: {"error":"quota"}' });
  assert.deepEqual(h.calls.map(([step]) => step), ['validate', 'validate', 'create']);
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('run: an archive that changed since it was chosen is refused before the create', async (t) => {
  const zip = await exportedArchive(t);
  const h = harness(t, { pick: { canceled: false, filePaths: [zip] } });
  const { importId } = await chosenImport(t, h, zip);
  fs.writeFileSync(zip, 'overwritten');
  const res = await h.importer.run(fakeSender(), detailFor(importId, scratchDir(t)));
  assert.deepEqual(res, { ok: false, code: 'archive', archiveCode: 'not_zip' });
  assert.equal(h.calls.some(([step]) => step === 'create'), false);
});

test('run: a second run of the same import while one runs is refused as busy', async (t) => {
  const zip = await exportedArchive(t);
  const h = harness(t, { pick: { canceled: false, filePaths: [zip] } });
  const { importId } = await chosenImport(t, h, zip);
  const folder = scratchDir(t);
  const first = h.importer.run(fakeSender(), detailFor(importId, folder));
  assert.deepEqual(await h.importer.run(fakeSender(), detailFor(importId, folder)), { ok: false, code: 'busy' });
  assert.equal(h.importer.cancel(importId), false, 'a running import is not released');
  assert.equal((await first).ok, true);
});

test('importReport tolerates a missing result', () => {
  assert.deepEqual(importReport(null), { tasks: 0, sprints: 0, kbWritten: 0, kbSkipped: [], tagsSkipped: 0, dropped: { dependencies: 0, parents: 0, tags: 0 } });
});

// ── main.js wiring ──

const ROOT = path.join(__dirname, '..', '..');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

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

test('main.js: Project ▸ Import… sits right after Export… and needs no project', () => {
  const projectMenuStart = MAIN_SRC.indexOf("label: mt('menu.project')");
  const exportIdx = MAIN_SRC.indexOf("label: mt('menu.exportProject')", projectMenuStart);
  const importIdx = MAIN_SRC.indexOf("label: mt('menu.importProject')", projectMenuStart);
  const kbIdx = MAIN_SRC.indexOf("label: mt('menu.knowledgeBase')", projectMenuStart);
  assert.ok(exportIdx > 0 && importIdx > exportIdx && importIdx < kbIdx, 'Import… follows Export…, before Knowledge Base');
  const item = MAIN_SRC.slice(MAIN_SRC.lastIndexOf('{', importIdx), MAIN_SRC.indexOf('}', importIdx) + 1);
  assert.match(item, /click: \(mi, window\) => importProjectFromMenu\(window\)/);
  assert.doesNotMatch(item, /enabled:/, 'always enabled — Get Started can import too');
});

test('main.js: the import runs in the focused app window only', async () => {
  const chosen = [];
  const projectDirs = new Map([[1, '/projects/a'], [2, null]]);
  const ctx = {
    console: { warn() {} },
    projectDirs,
    projectImporter: { chooseArchive: async (win) => { chosen.push(win.webContents.id); return { ok: true }; } },
  };
  vm.createContext(ctx);
  vm.runInContext(mainFunction('importProjectFromMenu'), ctx);
  ctx.importProjectFromMenu(fakeWindow(1)); // project window
  ctx.importProjectFromMenu(fakeWindow(2)); // unbound Get Started window
  ctx.importProjectFromMenu(fakeWindow(3)); // About / notices / banner: not an app window
  ctx.importProjectFromMenu(undefined);     // nothing focused
  const gone = fakeWindow(1);
  gone.destroyed = true;
  ctx.importProjectFromMenu(gone);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chosen, [1, 2]);
});

test('main.js: an unbound window adopts the imported project; a project window gets a new one', async () => {
  const projectDirs = new Map([[1, null], [2, '/projects/a']]);
  const adopted = [];
  const created = [];
  const ctx = {
    projectDirs,
    adoptProjectIntoWindow: async (sender, dir) => { adopted.push([sender.id, dir]); return { adopted: true }; },
    createProjectWindow: async (dir) => { created.push(dir); return {}; },
  };
  vm.createContext(ctx);
  vm.runInContext(mainFunction('openImportedProject'), ctx);
  assert.equal(await ctx.openImportedProject(fakeSender(1), '/imported'), 'current');
  assert.equal(await ctx.openImportedProject(fakeSender(2), '/imported'), 'new');
  const closed = fakeSender(1);
  closed.isDestroyed = () => true;
  assert.equal(await ctx.openImportedProject(closed, '/imported'), 'new', 'the wizard window closed meanwhile');
  assert.deepEqual(adopted, [[1, '/imported']]);
  assert.deepEqual(created, ['/imported', '/imported']);
});

test('main.js registers the import IPC channels and preload bridges them', () => {
  for (const channel of ['project:import-folder-check', 'project:import-from-wizard', 'project:import-cancel']) {
    assert.ok(MAIN_SRC.includes(`ipcMain.handle('${channel}'`), `main.js handles ${channel}`);
    assert.ok(PRELOAD_SRC.includes(`'${channel}'`), `preload.js reaches ${channel}`);
  }
  for (const method of ['onProjectImport', 'onProjectImportProgress', 'checkImportFolder', 'importProjectFromWizard', 'cancelProjectImport']) {
    assert.match(PRELOAD_SRC, new RegExp(`\\b${method}:`), `preload exposes ${method}`);
  }
  assert.ok(PRELOAD_SRC.includes("'project:import-open'") && PRELOAD_SRC.includes("'project:import-progress'"));
  assert.equal(mt('menu.importProject'), LOCALES.en['menu.importProject']);
});
