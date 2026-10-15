'use strict';

// TPT632 — GET /api/project/settings and its Electron IPC twin (api:project.settings) report
// taskPrefix: the project row's task_prefix run through resolveCodingPrefix(). Same
// createHttpHandler + stub-backend + Module._load harness as project-vcs-settings-route.test.js.
// Offline only — no network, no real API (.tipatask/config.json here points at production).

process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { createHttpHandler } = require('./ws-handlers');
const { _resetCodingPrefixFallbackWarning } = require('./task-key-format');

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

function makeBackend(row) {
  return {
    getCredentials() { return { baseUrl: 'https://tt.example.test', projectId: '2', token: 'tok' }; },
    async getProjectSettings() { return row; },
  };
}

async function httpSettings(backend) {
  const res = fakeRes();
  await createHttpHandler(new Map(), () => backend, null)(fakeReq('GET', '/api/project/settings'), res);
  assert.equal(res.statusCode, 200);
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
  return id => handlers.get('api:project.settings')({ sender: { id } });
}

test('GET /api/project/settings reports the project task_prefix as taskPrefix', async () => {
  assert.equal((await httpSettings(makeBackend({ task_prefix: 'MNY' }))).taskPrefix, 'MNY');
  assert.equal((await httpSettings(makeBackend({ task_prefix: 'TPT', task_group_label: 'Sprints' }))).taskPrefix, 'TPT');
});

test('GET /api/project/settings falls back to the legacy C for a missing or non-derived prefix', async (t) => {
  t.mock.method(console, 'warn', () => {});
  _resetCodingPrefixFallbackWarning();
  for (const row of [null, {}, { task_prefix: null }, { task_prefix: '' }, { task_prefix: 'mny' }, { task_prefix: 'C' }, { task_prefix: 'TOOLONGPREFIX' }]) {
    assert.equal((await httpSettings(makeBackend(row))).taskPrefix, 'C', `row ${JSON.stringify(row)}`);
  }
  // A backend with no getProjectSettings at all (file backend shape) degrades the same way.
  assert.equal((await httpSettings({ getCredentials() { return null; } })).taskPrefix, 'C');
  _resetCodingPrefixFallbackWarning();
});

test('Electron api:project.settings reports each window its own taskPrefix, matching the HTTP route', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const mny = makeBackend({ task_prefix: 'MNY' });
  const tpt = makeBackend({ task_prefix: 'TPT' });
  const settings = registerIpcHandlers(new Map([[1, { backend: mny }], [2, { backend: tpt }], [3, { backend: null }]]));
  assert.equal((await settings(1)).taskPrefix, 'MNY');
  assert.equal((await settings(2)).taskPrefix, 'TPT');
  _resetCodingPrefixFallbackWarning();
  assert.equal((await settings(3)).taskPrefix, 'C', 'window with no project loaded');
  assert.equal((await settings(1)).taskPrefix, (await httpSettings(mny)).taskPrefix, 'HTTP/IPC parity');
  _resetCodingPrefixFallbackWarning();
});
