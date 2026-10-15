'use strict';

// main/window-state.js bindWindowToProject() forwards the per-window backend's offline write
// queue to the renderer over IPC — the forked server never sees an Electron IPC write, so its
// `api-status` / `task:*` WS frames can't cover one. Lives under src/server/ (not main/) for the
// npm test glob; same Module._load fakes as window-state-kb-sync.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const sent = [];
const WC_ID = 4242;
const fakeWebContents = {
  id: WC_ID,
  isDestroyed: () => false,
  send: (channel, payload) => sent.push({ channel, payload }),
};
const fakeElectron = { BrowserWindow: { getAllWindows: () => [{ webContents: fakeWebContents }] } };

// One stub backend per bind; the test reaches it through `lastBackend`.
let lastBackend = null;
function makeStubBackend() {
  const stateListeners = new Set();
  const drainListeners = new Set();
  const b = {
    connectionState: 'connected',
    pendingIds: [],
    init: () => Promise.resolve(),
    onConnectionStateChange(cb) { stateListeners.add(cb); return () => stateListeners.delete(cb); },
    onMutationsDrained(cb) { drainListeners.add(cb); return () => drainListeners.delete(cb); },
    getConnectionState: () => b.connectionState,
    getPendingMutationCount: () => b.pendingIds.length,
    getPendingTaskIds: () => [...b.pendingIds],
    fireState(state, message) { for (const cb of stateListeners) cb(state, message); },
    fireDrain(replayed, remaining, dropped) { for (const cb of drainListeners) cb(replayed, remaining, dropped); },
    listenerCount: () => stateListeners.size + drainListeners.size,
  };
  lastBackend = b;
  return b;
}
const fakeTaskBackend = { createPerProjectBackend: () => makeStubBackend() };

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

const { bindWindowToProject, dropWindow, setKbSyncScheduler } = windowState;

function bindFresh(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-ws-queue-'));
  fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api', API_BASE_URL: 'http://127.0.0.1:1', API_PROJECT_ID: '9',
  }), 'utf8');
  setKbSyncScheduler(() => {});
  t.after(() => {
    dropWindow(WC_ID);
    setKbSyncScheduler(null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  bindWindowToProject(WC_ID, root);
  return { root, backend: lastBackend };
}

const flushImmediate = () => new Promise(resolve => setImmediate(resolve));
const of = (channel) => sent.filter(s => s.channel === channel).map(s => s.payload);

test('state change (and offline enqueue re-notify) pushes api-status with the queue', async (t) => {
  const { root, backend } = bindFresh(t);
  await flushImmediate(); // initial push
  const initial = of('api-status');
  assert.equal(initial.length, 1, 'bind pushes the current queue once');
  assert.deepEqual(initial[0], { state: 'connected', message: null, pendingCount: 0, pendingTaskIds: [], projectPath: root });

  sent.length = 0;
  backend.connectionState = 'reconnecting';
  backend.pendingIds = ['TPT1'];
  backend.fireState('reconnecting', null);
  assert.deepEqual(of('api:connection:changed'), [{ state: 'reconnecting', message: null, projectPath: root }]);
  assert.deepEqual(of('api-status'), [{ state: 'reconnecting', message: null, pendingCount: 1, pendingTaskIds: ['TPT1'], projectPath: root }]);
});

test('drain forwards remaining queue, replayed writes and dropped entries', async (t) => {
  const { root, backend } = bindFresh(t);
  await flushImmediate();
  sent.length = 0;

  const updated = { id: 'TPT1', title: 'edited' };
  const created = { id: 'TPT2', title: 'new', _replacedTmpId: 'tmp-1' };
  const deleted = { _deleted: true, id: 'TPT3' };
  const dropped = [{ op: 'update', taskId: 'TPT4', title: null, code: 'X', statusCode: 400, message: 'nope' }];
  backend.pendingIds = [];
  backend.fireDrain([updated, created, deleted], 0, dropped);

  assert.deepEqual(sent.map(s => s.channel), [
    'api:mutations-dropped', 'api-status', 'task:updated', 'task:deleted', 'task:created', 'task:deleted',
  ]);
  assert.deepEqual(of('api:mutations-dropped'), [{ entries: dropped, projectPath: root }]);
  assert.deepEqual(of('api-status'), [{ state: 'connected', message: null, pendingCount: 0, pendingTaskIds: [], projectPath: root }]);
  assert.deepEqual(of('task:updated'), [{ task: updated, projectPath: root }]);
  assert.deepEqual(of('task:deleted'), [{ id: 'tmp-1', projectPath: root }, { id: 'TPT3', projectPath: root }]);
  assert.deepEqual(of('task:created'), [{ task: created, projectPath: root }]);
});

test('partial drain reports the rest still queued; no dropped push when nothing dropped', async (t) => {
  const { root, backend } = bindFresh(t);
  await flushImmediate();
  sent.length = 0;

  backend.pendingIds = ['TPT5', 'TPT6'];
  backend.fireDrain([], 2, []);
  assert.equal(of('api:mutations-dropped').length, 0);
  assert.deepEqual(of('api-status'), [{
    state: 'reconnecting', message: 'Reconnected — 2 updates still queued', pendingCount: 2, pendingTaskIds: ['TPT5', 'TPT6'], projectPath: root,
  }]);
});

test('dropWindow unsubscribes every queue listener', async (t) => {
  const { backend } = bindFresh(t);
  await flushImmediate();
  assert.equal(backend.listenerCount(), 2);
  dropWindow(WC_ID);
  assert.equal(backend.listenerCount(), 0);
  sent.length = 0;
  backend.fireState('disconnected', 'down');
  backend.fireDrain([{ id: 'TPT1' }], 0, []);
  assert.equal(sent.length, 0);
});
