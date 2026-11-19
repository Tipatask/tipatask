'use strict';

// (TPT9319) A new project's one-time first-open prompt marker: main/first-open-prompt.js for
// real against temp project folders, its IPC registration through a fake ipcMain, and the two
// main.js handlers that write project.json — project:create-from-wizard (marker only for a NEW
// API project) and project:open-existing (never) — run in a vm with their API calls stubbed,
// the same way project-creation-wizard-locked.test.js runs the create handler.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const {
  FIRST_OPEN_PROMPT_KEY,
  FIRST_OPEN_PROMPT_CHANNEL,
  FIRST_OPEN_PROMPT_CLEAR_CHANNEL,
  hasFirstOpenPrompt,
  clearFirstOpenPrompt,
  registerFirstOpenPromptIpc,
} = require('../../main/first-open-prompt');

const ROOT = path.join(__dirname, '..', '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

function tempProject(t, meta) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-first-open-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (meta !== undefined) {
    fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.tipatask', 'project.json'),
      typeof meta === 'string' ? meta : JSON.stringify(meta, null, 2) + '\n');
  }
  return dir;
}

const readMeta = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.tipatask', 'project.json'), 'utf8'));
const metaExists = (dir) => fs.existsSync(path.join(dir, '.tipatask', 'project.json'));

test('the marker key is firstOpenPrompt', () => {
  assert.equal(FIRST_OPEN_PROMPT_KEY, 'firstOpenPrompt');
});

test('a due marker is read, then cleared once; every other project.json field survives', (t) => {
  const dir = tempProject(t, { name: 'Fresh', apiProjectId: 41, updatedAt: '2026-11-14T00:00:00.000Z', firstOpenPrompt: true });
  assert.equal(hasFirstOpenPrompt(dir), true);
  assert.equal(clearFirstOpenPrompt(dir), true, 'the first clear removes it');
  assert.equal(hasFirstOpenPrompt(dir), false);
  assert.deepEqual(readMeta(dir), { name: 'Fresh', apiProjectId: 41, updatedAt: '2026-11-14T00:00:00.000Z' });
  assert.equal(clearFirstOpenPrompt(dir), false, 'a second clear finds nothing to remove');
});

test('no marker, no project.json, broken JSON or no folder: nothing is due and nothing is written', (t) => {
  const plain = tempProject(t, { name: 'Linked', apiProjectId: 7 });
  const before = fs.readFileSync(path.join(plain, '.tipatask', 'project.json'), 'utf8');
  assert.equal(hasFirstOpenPrompt(plain), false);
  assert.equal(clearFirstOpenPrompt(plain), false);
  assert.equal(fs.readFileSync(path.join(plain, '.tipatask', 'project.json'), 'utf8'), before, 'untouched');

  const bare = tempProject(t);
  assert.equal(hasFirstOpenPrompt(bare), false);
  assert.equal(clearFirstOpenPrompt(bare), false);
  assert.equal(metaExists(bare), false, 'clear never creates a project.json');

  const broken = tempProject(t, '{ not json');
  assert.equal(hasFirstOpenPrompt(broken), false);
  assert.equal(clearFirstOpenPrompt(broken), false);

  assert.equal(hasFirstOpenPrompt(null), false);
  assert.equal(clearFirstOpenPrompt(''), false);
});

test('only a literal true is due; a non-true marker is removed but reported as not due', (t) => {
  const dir = tempProject(t, { name: 'Odd', firstOpenPrompt: 'yes' });
  assert.equal(hasFirstOpenPrompt(dir), false);
  assert.equal(clearFirstOpenPrompt(dir), false);
  assert.deepEqual(readMeta(dir), { name: 'Odd' });
});

test('clear writes through the injected writer (main.js writeProjectMeta)', (t) => {
  const dir = tempProject(t, { name: 'Fresh', firstOpenPrompt: true });
  const writes = [];
  assert.equal(clearFirstOpenPrompt(dir, { writeMeta: (root, meta) => writes.push([root, meta]) }), true);
  assert.deepEqual(writes, [[dir, { name: 'Fresh' }]]);
});

function fakeIpc() {
  const handlers = new Map();
  return { handlers, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } };
}

test('IPC: both channels act on the sender window\'s project and refuse an untrusted sender', (t) => {
  const dir = tempProject(t, { name: 'Fresh', firstOpenPrompt: true });
  const { handlers, ipcMain } = fakeIpc();
  const dirs = new Map([[1, dir], [2, null]]);
  registerFirstOpenPromptIpc({
    ipcMain,
    isTrusted: (event) => event.trusted === true,
    projectDirOf: (event) => dirs.get(event.sender.id) ?? null,
  });
  assert.deepEqual([...handlers.keys()], [FIRST_OPEN_PROMPT_CHANNEL, FIRST_OPEN_PROMPT_CLEAR_CHANNEL]);
  const get = handlers.get(FIRST_OPEN_PROMPT_CHANNEL);
  const clear = handlers.get(FIRST_OPEN_PROMPT_CLEAR_CHANNEL);

  const untrusted = { trusted: false, sender: { id: 1 } };
  assert.equal(get(untrusted), false);
  assert.equal(clear(untrusted), false);
  assert.equal(hasFirstOpenPrompt(dir), true, 'an untrusted sender cleared nothing');

  const unbound = { trusted: true, sender: { id: 2 } };
  assert.equal(get(unbound), false);
  assert.equal(clear(unbound), false);

  const owner = { trusted: true, sender: { id: 1 } };
  assert.equal(get(owner), true);
  assert.equal(clear(owner), true);
  assert.equal(get(owner), false);
  assert.equal(clear(owner), false);
});

test('IPC: a failing write answers false and logs, so the prompt cannot reappear on every load', (t) => {
  const dir = tempProject(t, { name: 'Fresh', firstOpenPrompt: true });
  const { handlers, ipcMain } = fakeIpc();
  const warnings = [];
  registerFirstOpenPromptIpc({
    ipcMain,
    isTrusted: () => true,
    projectDirOf: () => dir,
    writeMeta: () => { throw new Error('EACCES'); },
    warn: (...args) => warnings.push(args.join(' ')),
  });
  assert.equal(handlers.get(FIRST_OPEN_PROMPT_CLEAR_CHANNEL)({ sender: { id: 1 } }), false);
  assert.match(warnings.join('\n'), /\[first-open-prompt\] clear failed: EACCES/);
});

test('main.js registers the channels with the top-frame guard and the sender\'s project dir; preload exposes them', () => {
  assert.match(mainSrc, /const \{ registerFirstOpenPromptIpc \} = require\('\.\/main\/first-open-prompt'\);/);
  const at = mainSrc.indexOf('registerFirstOpenPromptIpc({');
  assert.notEqual(at, -1, 'registered inside registerIpcHandlers()');
  const call = mainSrc.slice(at, mainSrc.indexOf('});', at));
  assert.match(call, /isTrusted: \(event\) => isTrustedTopFrame\(event, \{ BrowserWindow, projectDirs, appOrigin: APP_ORIGIN \}\)/);
  assert.match(call, /projectDirOf: \(event\) => projectDirs\.get\(event\.sender\.id\) \|\| null/);
  assert.match(call, /writeMeta: writeProjectMeta/);
  assert.ok(preloadSrc.includes(`getFirstOpenPrompt: () => inv('${FIRST_OPEN_PROMPT_CHANNEL}')`));
  assert.ok(preloadSrc.includes(`clearFirstOpenPrompt: () => inv('${FIRST_OPEN_PROMPT_CLEAR_CHANNEL}')`));
});

// A main.js `ipcMain.handle(channel, …)` handler, run in a vm. `globals` supplies the free
// identifiers it uses; `modules` answers its require() calls.
function loadHandler(channel, { modules, globals }) {
  const start = mainSrc.indexOf(`  ipcMain.handle('${channel}'`);
  const end = mainSrc.indexOf('\n  });', start) + '\n  });'.length;
  assert.ok(start !== -1 && end > start, `${channel} handler found`);
  let handler = null;
  vm.runInNewContext(mainSrc.slice(start, end), {
    ipcMain: { handle: (_, fn) => { handler = fn; } },
    require: (id) => { assert.ok(id in modules, `unexpected require(${id})`); return modules[id]; },
    console: { warn: () => {}, error: () => {}, log: () => {} },
    ...globals,
  });
  return handler;
}

const apiStubs = () => ({
  './src/cli/setup': {
    createApiProject: async ({ name }) => ({ id: 41, name }),
    registerDevice: async ({ name }) => ({ id: 9, name: name || 'host' }),
    associateDeviceProject: async () => ({}),
    initializeProjectSettings: async () => {},
  },
  './src/cli/auth': { exchangeProjectToken: async () => 'scoped-token' },
});

const fileStubs = {
  __dirname: ROOT,
  writeProjectMcpConfig: () => {},
  writeProjectSkillsConfig: () => {},
  writeProjectCodexConfig: () => {},
  getOrCreateMachineId: () => 'machine-1',
};

function createHandler(metaWrites) {
  return loadHandler('project:create-from-wizard', {
    modules: {
      ...apiStubs(),
      './src/server/project-config': { writeProjectConfig: () => {}, sanitizePiModels: () => [] },
      './src/server/project-seeder': {
        copyTemplates: () => {},
        callSeedPresetTasks: async () => ({ seeded: 0, failed: null }),
        presetConfigFields: () => ({}),
        presetSeedsTasks: () => false,
      },
      './src/cli/knowledge-sync': { pushAll: async () => {}, pushArchitectureDocs: async () => {} },
    },
    globals: { ...fileStubs, writeProjectMeta: (dir, meta) => metaWrites.push([dir, meta]) },
  });
}

const wizardDetail = (apiProject) => ({
  projectPath: '/projects/fresh',
  apiBaseUrl: 'https://api.example.test',
  userToken: 'user-token',
  apiProject,
  deviceName: 'Laptop',
  preset: { value: 'compose-as-you-go' },
  agentPreference: { taskAgent: 'claude', availableAgents: ['claude'] },
});

test('project:create-from-wizard writes firstOpenPrompt: true for a new API project', async () => {
  const metaWrites = [];
  const res = await createHandler(metaWrites)({}, wizardDetail({ isNew: true, name: 'Fresh', description: '' }));
  assert.equal(res.ok, true, res.error);
  assert.equal(metaWrites.length, 1);
  const [dir, meta] = metaWrites[0];
  assert.equal(dir, '/projects/fresh');
  assert.equal(meta.firstOpenPrompt, true);
  assert.equal(meta.name, 'Fresh');
  assert.equal(meta.apiProjectId, 41);
});

test('project:create-from-wizard writes no marker for an existing API project', async () => {
  const metaWrites = [];
  const res = await createHandler(metaWrites)({}, wizardDetail({ isNew: false, id: 12, name: 'Linked' }));
  assert.equal(res.ok, true, res.error);
  assert.equal(metaWrites.length, 1);
  assert.equal(Object.hasOwn(metaWrites[0][1], 'firstOpenPrompt'), false);
  assert.equal(metaWrites[0][1].apiProjectId, 12);
});

test('project:open-existing (the link path for an existing project) never writes the marker', async (t) => {
  const dir = tempProject(t); // a folder with no project.json yet: the handler writes a fresh one
  const metaWrites = [];
  const handler = loadHandler('project:open-existing', {
    modules: {
      ...apiStubs(),
      'node:os': os,
      './src/server/project-config': {
        readProjectConfig: () => null,
        writeProjectConfig: () => {},
        sanitizePiModels: () => [],
        readPiEntries: () => [],
      },
      './src/server/project-seeder': { copyTemplates: () => {} },
    },
    globals: { ...fileStubs, path, fs, writeProjectMeta: (root, meta) => metaWrites.push([root, meta]) },
  });
  const res = await handler({ sender: { id: 1 } }, {
    projectPath: dir,
    apiBaseUrl: 'https://api.example.test',
    userToken: 'user-token',
    apiProject: { id: 12, name: 'Linked' },
    deviceName: 'Laptop',
    taskAgent: 'claude',
    availableAgents: ['claude'],
    piModels: [],
    adopt: false,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(metaWrites.length, 1, 'project.json was written');
  assert.equal(Object.hasOwn(metaWrites[0][1], 'firstOpenPrompt'), false);
  assert.equal(hasFirstOpenPrompt(dir), false);
});
