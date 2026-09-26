'use strict';

// C1284 — exercise the Electron main-process IPC handlers with a small Electron
// surface mock. The server config's USER_DATA_ROOT is deliberately pointed at a
// bundle-like path so the test fails if either handler falls back to that value.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('C1284: perf-log IPC uses Electron userData in the main process', async (t) => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'tipatask-perf-ipc-'));
  const projectPath = path.join(userData, 'project');
  const bundleUserData = path.join(userData, 'app.asar');
  await fs.mkdir(projectPath, { recursive: true });
  t.after(() => fs.rm(userData, { recursive: true, force: true }));

  const handlers = new Map();
  const fakeElectron = {
    app: {
      getPath(name) {
        assert.strictEqual(name, 'userData');
        return userData;
      },
    },
    ipcMain: {
      handle(name, handler) {
        handlers.set(name, handler);
      },
    },
  };
  const fakeWindowState = {
    getWindowState() {
      return { projectPath, config: { debugPerfLog: true }, backend: null };
    },
    reconfigureWindowBackend() {},
  };
  const fakeServerConfig = {
    PORT: 4455,
    TASK_AGENT: 'claude',
    TASK_BACKEND: 'api',
    USER_DATA_ROOT: bundleUserData,
    USER_ID: 1,
    USER_NAME: 'test',
    USER_AVATAR_URL: '',
  };
  const fakeReopenClosedTask = { applyReopenToPatch() {} };
  const routerPath = require.resolve('../../main/ipc/api-router');
  const previousRouter = require.cache[routerPath];
  const originalLoad = Module._load;

  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request === '../window-state') return fakeWindowState;
    if (request === '../../src/server/config') return fakeServerConfig;
    if (request === '../../src/server/reopen-closed-task') return fakeReopenClosedTask;
    return originalLoad.call(this, request, parent, isMain);
  };

  let registerApiHandlers;
  try {
    delete require.cache[routerPath];
    ({ registerApiHandlers } = require(routerPath));
  } finally {
    Module._load = originalLoad;
    if (previousRouter) require.cache[routerPath] = previousRouter;
    else delete require.cache[routerPath];
  }

  registerApiHandlers();

  const event = { sender: { id: 1284 } };
  const today = new Date().toISOString().slice(0, 10);
  const expectedPath = path.join(userData, 'logs', `perf-${today}.log`);
  const bundlePath = path.join(bundleUserData, 'logs', `perf-${today}.log`);

  const info = await handlers.get('api:debug.perfLogInfo')(event);
  assert.deepStrictEqual(info, { enabled: true, path: expectedPath });

  const result = await handlers.get('api:debug.perfLog')(event, [{ label: 'load-and-render', durationMs: 12 }]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.written, 1);
  assert.strictEqual(result.path, expectedPath);
  assert.match(await fs.readFile(expectedPath, 'utf8'), /"label":"load-and-render"/);
  assert.strictEqual(await fs.access(bundlePath).then(() => true, () => false), false);
});
