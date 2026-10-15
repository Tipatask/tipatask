'use strict';

// (TPT673) main/window-state.js's _backendCache eviction: a backend stays while a window is
// bound to its project or it holds queued offline writes, and is disposed + dropped once it
// has been unbound and empty for BACKEND_IDLE_EVICT_MS. Same Module._load interception as
// window-state-kb-sync.test.js (fake 'electron' and '../src/server/task-backend').

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { BACKEND_IDLE_EVICT_MS } = require('./backend-eviction');

const created = [];
const fakeElectron = { BrowserWindow: { getAllWindows: () => [] } };
const fakeTaskBackend = {
  createPerProjectBackend: (cfg, projectPath) => {
    const b = {
      projectPath, pending: 0, disposed: 0,
      init: () => Promise.resolve(),
      getPendingMutationCount: () => b.pending,
      dispose() { b.disposed++; },
    };
    created.push(b);
    return b;
  },
};

const windowStatePath = require.resolve('../../main/window-state');
const previousWindowState = require.cache[windowStatePath];
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === '../src/server/task-backend') return fakeTaskBackend;
  return originalLoad.call(this, request, parent, isMain);
};
let windowState;
try {
  delete require.cache[windowStatePath];
  windowState = require(windowStatePath);
} finally {
  Module._load = originalLoad;
  if (previousWindowState) require.cache[windowStatePath] = previousWindowState;
  else delete require.cache[windowStatePath];
}
const { bindWindowToProject, dropWindow, getWindowState, setKbSyncScheduler, _sweepBackendsForTest, _cachedBackendPathsForTest } = windowState;
setKbSyncScheduler(() => {});

function projectRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-ws-evict-'));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api', API_BASE_URL: 'http://127.0.0.1:1', API_PROJECT_ID: '7',
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

let nextWc = 9000;

test('bound window keeps its backend; after unbind + idle window it is disposed and dropped', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  t.after(() => t.mock.timers.reset());
  const root = projectRoot(t);
  const wc = nextWc++;
  bindWindowToProject(wc, root);
  const backend = getWindowState(wc).backend;

  t.mock.timers.tick(BACKEND_IDLE_EVICT_MS * 2);
  assert.deepEqual(_sweepBackendsForTest(), [], 'bound window keeps it');

  dropWindow(wc);
  assert.ok(_cachedBackendPathsForTest().includes(root), 'dropWindow alone evicts nothing');
  assert.deepEqual(_sweepBackendsForTest(), [], 'idle clock starts at unbind');
  t.mock.timers.tick(BACKEND_IDLE_EVICT_MS);
  assert.deepEqual(_sweepBackendsForTest(), [root]);
  assert.equal(backend.disposed, 1);
  assert.equal(_cachedBackendPathsForTest().includes(root), false);

  // Reopening the project builds a fresh instance.
  const wc2 = nextWc++;
  bindWindowToProject(wc2, root);
  assert.notEqual(getWindowState(wc2).backend, backend);
  dropWindow(wc2);
});

test('drop + immediate rebind of the same project reuses the cached backend', (t) => {
  const root = projectRoot(t);
  const wc = nextWc++;
  bindWindowToProject(wc, root);
  const backend = getWindowState(wc).backend;
  dropWindow(wc);
  bindWindowToProject(wc, root);
  assert.equal(getWindowState(wc).backend, backend);
  dropWindow(wc);
});

test('an unbound backend with queued offline writes is kept until they drain', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  t.after(() => t.mock.timers.reset());
  const root = projectRoot(t);
  const wc = nextWc++;
  bindWindowToProject(wc, root);
  const backend = getWindowState(wc).backend;
  backend.pending = 1;
  dropWindow(wc);

  t.mock.timers.tick(BACKEND_IDLE_EVICT_MS * 3);
  assert.equal(_sweepBackendsForTest().includes(root), false);
  assert.equal(backend.disposed, 0);

  backend.pending = 0; // reconnect replayed the write
  assert.equal(_sweepBackendsForTest().includes(root), false, 'idle window restarts after the drain');
  t.mock.timers.tick(BACKEND_IDLE_EVICT_MS);
  assert.ok(_sweepBackendsForTest().includes(root));
  assert.equal(backend.disposed, 1);
});
