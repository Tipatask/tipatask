'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createProjectAccessGate, projectAccessDialog } = require('../../main/project-access');

const main = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
function mainFunction(name) {
  const start = main.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0);
  const tail = main.slice(start);
  const next = tail.search(/\n(?:async )?function \w+\(/);
  // The last function precedes app.whenReady(), not another declaration.
  return tail.slice(0, name === 'createInitialWindows' ? tail.indexOf('\napp.whenReady()') : next);
}

function harness(overrides = {}) {
  const events = [];
  let token = 'wrong-account';
  const config = { API_BASE_URL: 'https://api.test', API_PROJECT_ID: 2, language: 'uk' };
  const gate = createProjectAccessGate({
    readConfig: () => config,
    getCredentials: () => ({ baseUrl: config.API_BASE_URL, projectId: config.API_PROJECT_ID, token }),
    request: async (url, options) => {
      events.push(['probe', url, options.headers.Authorization]);
      return { status: token === 'right-account' ? 200 : 403 };
    },
    prompt: async () => { events.push(['dialog']); return true; },
    reauthenticate: async () => { events.push(['signin']); token = 'right-account'; },
    showError: async (_, __, kind) => events.push(['error', kind]),
    onAccountChanged: () => events.push(['account-changed']),
    ...overrides,
  });
  const owners = new Map();
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.id = windows.length + 1;
      windows.push(this);
      events.push(['window']);
    }
    isDestroyed() { return false; }
    setTitle() {}
    loadURL(url) { events.push(['load', url]); }
  }
  const context = vm.createContext({
    ensureProjectAccess: gate, readProjectConfig: () => config,
    rememberRecentProject: () => events.push(['recent']),
    addToWorkspace: () => events.push(['workspace']),
    getDisplayName: (dir) => dir, getWindowTitle: (name) => name,
    ownerOf: (dir) => owners.get(dir), focusWindow: () => true,
    claimProject: (dir, win) => owners.set(dir, win),
    writeProjectMcpConfig() {}, writeProjectSkillsConfig() {}, writeProjectCodexConfig() {},
    BrowserWindow: FakeWindow, attachExternalLinkPolicy() {}, scheduleOpenProjectsSync() {},
    getWindowIcon() {}, projectDirs: new Map(), attachCloseGuard() {},
    bindWindowToProject: (_, dir) => events.push(['bind', dir]),
    __dirname, path, PORT: 12345, console,
  });
  vm.runInContext(mainFunction('createProjectWindow'), context);
  vm.runInContext(mainFunction('createInitialWindows'), context);
  return { gate, events, windows, context, open: context.createProjectWindow };
}

for (const status of [403, 404]) {
  test(`${status}: cancel leaves no window, backend, board request, or recent entry`, async () => {
    const h = harness({ request: async () => ({ status }), prompt: async () => false });
    assert.equal(await h.open('/foreign'), null);
    assert.deepEqual(h.events, []);
    assert.equal(h.windows.length, 0);
  });
}

test('denial → re-auth → fresh probe precedes backend and board; second project uses same account', async () => {
  const h = harness();
  await h.open('/project-a');
  assert.deepEqual(h.events.slice(0, 5).map(e => e[0]), ['probe', 'dialog', 'signin', 'account-changed', 'probe']);
  assert.ok(h.events.findIndex(e => e[0] === 'bind') > 4);
  assert.ok(h.events.findIndex(e => e[0] === 'load') > 4);
  await h.open('/project-b');
  assert.equal(h.windows.length, 2);
  assert.equal(h.events.filter(e => e[0] === 'signin').length, 1);
  assert.equal(h.events.filter(e => e[0] === 'probe').at(-1)[2], 'Bearer right-account');
});

test('concurrent duplicate opens share one sign-in and create one window', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.open('/project'), h.open('/project')]);
  assert.equal(a, b);
  assert.equal(h.windows.length, 1);
  assert.equal(h.events.filter(e => e[0] === 'dialog').length, 1);
  assert.equal(h.events.filter(e => e[0] === 'signin').length, 1);
});

test('different concurrent projects serialize recovery and re-read account credentials', async () => {
  const h = harness();
  await Promise.all([h.open('/a'), h.open('/b')]);
  assert.equal(h.windows.length, 2);
  assert.equal(h.events.filter(e => e[0] === 'signin').length, 1);
});

test('wrong account after sign-in stays blocked; Cancel stops retries', async () => {
  let prompts = 0;
  const h = harness({ request: async () => ({ status: 404 }), prompt: async () => ++prompts === 1 });
  assert.equal(await h.open('/foreign'), null);
  assert.equal(prompts, 2);
  assert.equal(h.windows.length, 0);
});

test('failed sign-in stops before binding and next open can retry', async () => {
  const h = harness({ reauthenticate: async () => { throw new Error('timeout'); } });
  assert.equal(await h.open('/project'), null);
  assert.deepEqual(h.events.at(-1), ['error', 'signinFailed']);
  assert.equal(await h.open('/project'), null);
  assert.equal(h.events.filter(e => e[0] === 'dialog').length, 2);
});

for (const status of [500, 429, 302]) {
  test(`${status} is a connection/server error, not an access-denied prompt`, async () => {
    const h = harness({ request: async () => ({ status }) });
    assert.equal(await h.open('/project'), null);
    assert.deepEqual(h.events, [['error', 'unavailable']]);
  });
}

test('offline check does not load board or ask to change account', async () => {
  const h = harness({ request: async () => { throw new Error('offline'); } });
  assert.equal(await h.open('/project'), null);
  assert.deepEqual(h.events, [['error', 'unavailable']]);
});

test('missing token and 401 offer sign-in before opening', async () => {
  for (const missing of [false, true]) {
    let first = true;
    const h = harness({
      getCredentials: () => {
        if (missing && first) { first = false; throw Object.assign(new Error(), { missingCredentials: true }); }
        return { baseUrl: 'https://api.test', projectId: 2, token: 'token' };
      },
      request: async () => { const status = first ? 401 : 200; first = false; return { status }; },
      prompt: async (_, __, kind) => { assert.equal(kind, 'signin'); return true; },
    });
    assert.ok(await h.open('/project'));
  }
});

test('unconfigured folders continue to setup without an access probe', async () => {
  const h = harness({ readConfig: () => null });
  assert.equal(await h.gate('/new-folder'), true);
  assert.deepEqual(h.events, []);
});

test('canceling every restored project creates an unbound welcome window', async () => {
  const h = harness({ prompt: async () => false });
  await h.context.createInitialWindows(['/a', '/b'], { deferShow: true });
  assert.equal(h.windows.length, 1);
  assert.deepEqual(h.events.filter(e => e[0] === 'bind'), [['bind', null]]);
  assert.match(h.events.find(e => e[0] === 'load')[1], /todo\.html$/);
});

function ipcHandler(channel, context) {
  const start = main.indexOf(`  ipcMain.handle('${channel}'`);
  const end = main.indexOf('\n  });', start) + '\n  });'.length;
  assert.ok(start >= 0 && end > start);
  let handler;
  vm.runInNewContext(main.slice(start, end), {
    ...context, ipcMain: { handle: (_, fn) => { handler = fn; } },
  });
  return handler;
}

test('denied current-window opens and switches preserve the current binding and workspace', async () => {
  const h = harness({ prompt: async () => false });
  const workspaceState = { activeProjectPath: '/current', openProjects: [{ path: '/foreign' }] };
  // Any bookkeeping/window access before rejection would throw: these handlers
  // have only the access gate and read-only membership data available.
  const context = { ensureProjectAccess: h.gate, createProjectWindow: h.open, workspaceState };
  await ipcHandler('project:open', context)({}, { dir: '/foreign', target: 'current' });
  const result = await ipcHandler('project:switch', context)({}, '/foreign');
  assert.equal(result.canceled, true);
  assert.equal(workspaceState.activeProjectPath, '/current');
  assert.equal(h.windows.length, 0);
});

test('canceling access while focusing an existing project does not fall through to a second open', async () => {
  const template = fs.readFileSync(path.join(__dirname, '../client/template.html'), 'utf8');
  const start = template.indexOf('  async function openOrCreateProject()');
  const end = template.indexOf('\n  }', start) + '\n  }'.length;
  let opens = 0;
  let getStarted = 0;
  const context = vm.createContext({
    window: { electronAPI: {
      pickAndOpenProject: async () => ({ path: '/foreign' }),
      focusProjectWindow: async () => ({ ok: false, canceled: true }),
      openProject: () => { opens++; },
    } },
    // (TPT564) An unbound window gets Get Started back instead of the empty board.
    _isUnboundWindowSync: () => true,
    _showChooseModal: () => { getStarted++; },
  });
  vm.runInContext(template.slice(start, end), context);
  await context.openOrCreateProject();
  assert.equal(opens, 0);
  assert.equal(getStarted, 1);
});

test('native dialog renders English and Ukrainian from matching renderer strings', async () => {
  const { LOCALES } = await import('../client/i18n.js');
  for (const language of ['en', 'uk']) {
    for (const kind of ['denied', 'signin', 'unavailable', 'signinFailed']) {
      const options = projectAccessDialog({ language }, '/project', kind);
      const strings = LOCALES[language];
      assert.equal(options.title, strings['projectAccess.title']);
      assert.equal(options.message, strings[`projectAccess.${kind}`]);
      const prompt = kind === 'denied' || kind === 'signin';
      assert.equal(options.detail, `${strings[`projectAccess.${prompt ? 'detail' : 'retryDetail'}`]}\n\n/project`);
      assert.deepEqual(options.buttons, (prompt ? ['reauthenticate', 'cancel'] : ['close']).map(k => strings[`projectAccess.${k}`]));
      assert.equal(options.cancelId, prompt ? 1 : 0);
    }
  }
  assert.equal(projectAccessDialog({ language: 'unknown' }, '/p').message, LOCALES.en['projectAccess.denied']);
});
