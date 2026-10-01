'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('Electron board IPC forwards fullWindow to the per-window backend', async () => {
  const handlers = new Map();
  const calls = [];
  const backend = {
    async getBoardTasks(opts) {
      calls.push(opts);
      return { tasks: [{ id: 'C4', priority: 350 }], window: null };
    },
  };
  const routerPath = require.resolve('../../main/ipc/api-router');
  const prior = require.cache[routerPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, app: {} };
    if (request === '../window-state') return { getWindowState: () => ({ backend }) };
    if (request === '../../src/server/config') return {};
    if (request === '../../src/server/reopen-closed-task') return { applyReopenToPatch() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[routerPath];
    require(routerPath).registerApiHandlers();
  } finally {
    Module._load = originalLoad;
    if (prior) require.cache[routerPath] = prior;
    else delete require.cache[routerPath];
  }
  const result = await handlers.get('api:tasks.board')({ sender: { id: 1 } }, {
    extendSprints: 10, unscoped: false, fullWindow: true,
  });
  assert.deepEqual(calls, [{ extendSprints: 10, unscoped: false, fullWindow: true }]);
  assert.equal(result.window, null);
  assert.deepEqual(result.tasks.map(t => t.priority), [350]);
});
