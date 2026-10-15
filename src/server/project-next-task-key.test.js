'use strict';

// TPT659 — GET /api/project/next-task-key and its Electron IPC twin (api:project.nextTaskKey)
// hand the renderer the key the API would allocate next ({ taskKey: string|null }) without the
// renderer ever holding API credentials. Same createHttpHandler + stub-backend + Module._load
// harness as project-settings-task-prefix.test.js. Offline only — no network, no real API.

process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { createHttpHandler } = require('./ws-handlers');

function fakeReq(method, url) {
  const req = { method, url, headers: {} };
  req[Symbol.asyncIterator] = async function* () {};
  return req;
}

function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(chunk) { res.body = chunk || ''; },
  };
  return res;
}

// keys: category -> answer (a string, null, or a thrown Error); records every category asked.
function makeBackend(keys, asked = []) {
  return {
    asked,
    getCredentials() { return { baseUrl: 'https://tt.example.test', projectId: '2', token: 'tok' }; },
    async getNextTaskKey(category) {
      asked.push(category);
      const answer = keys[category];
      if (answer instanceof Error) throw answer;
      return answer === undefined ? null : answer;
    },
  };
}

async function httpNextKey(backend, query = '?category=CODING') {
  const res = fakeRes();
  await createHttpHandler(new Map(), () => backend, null)(fakeReq('GET', `/api/project/next-task-key${query}`), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-cache, no-store');
  return JSON.parse(res.body || '{}');
}

// Registers main/ipc/api-router.js's handlers against stubbed electron/window-state modules,
// one backend per window id — the IPC route must read the calling window's own backend.
function registerIpcHandlers(states) {
  const handlers = new Map();
  const routerPath = require.resolve('../../main/ipc/api-router');
  const prior = require.cache[routerPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, app: {} };
    if (request === '../window-state') return { getWindowState: id => states.get(id) };
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
  return (id, args) => handlers.get('api:project.nextTaskKey')({ sender: { id } }, args);
}

test('GET /api/project/next-task-key returns the backend key for the requested category', async () => {
  const backend = makeBackend({ CODING: 'MNY42', HUMAN: 'H9' });
  assert.deepEqual(await httpNextKey(backend, '?category=CODING'), { taskKey: 'MNY42' });
  assert.deepEqual(await httpNextKey(backend, '?category=HUMAN'), { taskKey: 'H9' });
  assert.deepEqual(await httpNextKey(backend, ''), { taskKey: 'MNY42' }, 'no category -> CODING');
  assert.deepEqual(await httpNextKey(backend, '?category=epic'), { taskKey: 'MNY42' }, 'unknown category -> CODING, never forwarded raw');
  assert.deepEqual(backend.asked, ['CODING', 'HUMAN', 'CODING', 'CODING']);
});

test('GET /api/project/next-task-key fails open to null — the renderer keeps its own guess', async () => {
  assert.deepEqual(await httpNextKey(makeBackend({ CODING: null })), { taskKey: null }, 'backend could not tell');
  assert.deepEqual(await httpNextKey(makeBackend({ CODING: 42 })), { taskKey: null }, 'non-string answer');
  // A backend without the method at all (older backend shape) degrades the same way.
  assert.deepEqual(await httpNextKey({ getCredentials() { return null; } }), { taskKey: null });
});

test('Electron api:project.nextTaskKey reads each window its own backend, matching the HTTP route', async () => {
  const mny = makeBackend({ CODING: 'MNY42', HUMAN: 'H9' });
  const tpt = makeBackend({ CODING: 'TPT700' });
  const nextKey = registerIpcHandlers(new Map([
    [1, { backend: mny }],
    [2, { backend: tpt }],
    [3, { backend: null }],
    [4, { backend: { getCredentials() { return null; } } }],
  ]));
  assert.deepEqual(await nextKey(1, { category: 'CODING' }), { taskKey: 'MNY42' });
  assert.deepEqual(await nextKey(1, { category: 'HUMAN' }), { taskKey: 'H9' });
  assert.deepEqual(await nextKey(2, { category: 'CODING' }), { taskKey: 'TPT700' });
  assert.deepEqual(await nextKey(2, undefined), { taskKey: 'TPT700' }, 'missing args -> CODING');
  assert.deepEqual(await nextKey(3, { category: 'CODING' }), { taskKey: null }, 'window with no project loaded');
  assert.deepEqual(await nextKey(4, { category: 'CODING' }), { taskKey: null }, 'backend without the method');
  assert.deepEqual(await nextKey(1, { category: 'CODING' }), await httpNextKey(mny, '?category=CODING'), 'HTTP/IPC parity');
});
