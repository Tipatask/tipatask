'use strict';

// TPT9063 — GET/PATCH /api/project(/settings) agent_permission_mode round-trip, the Electron IPC
// parity, and PATCH /api/tasks/:id forwarding the per-task override. Same createHttpHandler +
// stub-backend harness as project-vcs-settings-route.test.js. Offline only — no network, no real
// API (.tipatask/config.json here points at production; live-hitting it from a test is never OK).

process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { createHttpHandler } = require('./ws-handlers');
const websocket = require('./websocket');

const MODES = ['plan', 'always_ask', 'accept_edits', 'auto', 'bypass'];

function fakeReq(method, url, { body } = {}) {
  const req = { method, url, headers: {} };
  req[Symbol.asyncIterator] = async function* () {
    if (body != null) yield Buffer.from(body);
  };
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

function json(res) {
  return JSON.parse(res.body || '{}');
}

// getCredentials() must resolve truthy so PATCH /api/project's resolveProjectContext() doesn't
// short-circuit to { ok: true, skipped: true } before ever calling updateProject().
function makeBackend({ row = null, updateProject } = {}) {
  const calls = [];
  return {
    calls,
    getCredentials() { return { baseUrl: 'https://tt.example.test', projectId: '2', token: 'tok' }; },
    async getProjectSettings() { return row; },
    async updateProject(fields) {
      calls.push(fields);
      if (updateProject) return updateProject(fields);
      return { ...row, ...fields };
    },
  };
}

async function readSettings(backend) {
  const res = fakeRes();
  await createHttpHandler(new Map(), () => backend, null)(fakeReq('GET', '/api/project/settings'), res);
  assert.equal(res.statusCode, 200);
  return json(res);
}

test('unfiltered task list carries permission overrides and explicit inheritance for nav reconciliation', async () => {
  const rows = [
    { id: 'TPT1', title: 'Override', status: 'in_progress', agentPermissionMode: 'bypass' },
    { id: 'TPT2', title: 'Inherited', status: 'in_progress', agentPermissionMode: null },
    { id: 'TPT3', title: 'Older backend', status: 'in_progress' },
  ];
  const backend = { async getTasksUnfiltered() { return rows; } };
  const res = fakeRes();
  await createHttpHandler(new Map(), () => backend, null)(fakeReq('GET', '/api/project/tasks'), res);
  assert.equal(res.statusCode, 200);
  const { tasks } = json(res);
  assert.equal(tasks[0].agentPermissionMode, 'bypass');
  assert.equal(tasks[1].agentPermissionMode, null);
  assert.equal(Object.hasOwn(tasks[2], 'agentPermissionMode'), false);
});

test('GET /api/project/settings reports agentPermissionMode for each canonical mode and null for NULL, junk or a missing column', async () => {
  for (const mode of MODES) {
    assert.equal((await readSettings(makeBackend({ row: { agent_permission_mode: mode } }))).agentPermissionMode, mode);
  }
  for (const row of [{ agent_permission_mode: null }, { agent_permission_mode: 'yolo' }, { agent_permission_mode: '' }, {}, null]) {
    assert.equal((await readSettings(makeBackend({ row }))).agentPermissionMode, null, JSON.stringify(row));
  }
});

test('PATCH /api/project accepts each of the five and null and reaches backend.updateProject with exactly { agent_permission_mode }', async () => {
  const row = { agent_permission_mode: null };
  const backend = makeBackend({ row, updateProject: async (fields) => Object.assign(row, fields) });
  const handler = createHttpHandler(new Map(), () => backend, null);
  for (const mode of [...MODES, null]) {
    const res = fakeRes();
    await handler(fakeReq('PATCH', '/api/project', { body: JSON.stringify({ agent_permission_mode: mode }) }), res);
    assert.equal(res.statusCode, 200, `mode ${mode}`);
    assert.deepEqual(backend.calls.at(-1), { agent_permission_mode: mode });
    assert.equal((await readSettings(backend)).agentPermissionMode, mode);
  }
  assert.equal(backend.calls.length, 6);
});

test('PATCH /api/project rejects a non-canonical agent_permission_mode without calling updateProject', async () => {
  const backend = makeBackend({ row: {} });
  const handler = createHttpHandler(new Map(), () => backend, null);
  for (const bad of ['yolo', '', 1, true, 'Plan mode']) {
    const res = fakeRes();
    await handler(fakeReq('PATCH', '/api/project', { body: JSON.stringify({ agent_permission_mode: bad }) }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.match(json(res).error, /agent_permission_mode must be one of: plan, always_ask, accept_edits, auto, bypass, or null/);
  }
  assert.equal(backend.calls.length, 0);
});

test('PATCH /api/project forwards agent_permission_mode alongside another allowed field', async () => {
  const backend = makeBackend({ row: {} });
  const handler = createHttpHandler(new Map(), () => backend, null);
  const res = fakeRes();
  await handler(fakeReq('PATCH', '/api/project', { body: JSON.stringify({ language: 'uk', agent_permission_mode: 'plan' }) }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(backend.calls, [{ language: 'uk', agent_permission_mode: 'plan' }]);
});

test('Electron api:project.settings is shape-identical to the HTTP route and api:project.update passes agent_permission_mode through per window', async () => {
  const firstRow = { vcs_type: 'git', agent_permission_mode: 'accept_edits' };
  const first = makeBackend({ row: firstRow, updateProject: async (fields) => Object.assign(firstRow, fields) });
  first.getTasksUnfiltered = async () => [
    { id: 'TPT1', agentPermissionMode: 'bypass' }, { id: 'TPT2', agentPermissionMode: null }, { id: 'TPT3' },
  ];
  const second = makeBackend({ row: { agent_permission_mode: null } });
  const states = new Map([[1, { backend: first }], [2, { backend: second }]]);
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
  const event = id => ({ sender: { id } });
  const settings = id => handlers.get('api:project.settings')(event(id));
  assert.equal((await settings(1)).agentPermissionMode, 'accept_edits');
  assert.equal((await settings(2)).agentPermissionMode, null);
  assert.deepEqual(await settings(1), await readSettings(first), 'HTTP/IPC parity: whole settings object');
  const slimTasks = await handlers.get('api:tasks.listAll')(event(1));
  assert.equal(slimTasks[0].agentPermissionMode, 'bypass');
  assert.equal(slimTasks[1].agentPermissionMode, null);
  assert.equal(Object.hasOwn(slimTasks[2], 'agentPermissionMode'), false);
  await handlers.get('api:project.update')(event(1), { fields: { agent_permission_mode: 'bypass' } });
  assert.deepEqual(first.calls, [{ agent_permission_mode: 'bypass' }]);
  assert.equal(second.calls.length, 0);
  assert.equal((await settings(1)).agentPermissionMode, 'bypass');
});

test('PATCH /api/tasks/:id forwards agent_permission_mode as agentPermissionMode (mode or explicit null), echoes it, broadcasts it, and 400s a non-string', async (tc) => {
  const emitted = [];
  const originalEmit = websocket.emitTaskUpdated;
  websocket.emitTaskUpdated = (task) => { emitted.push(task); };
  tc.after(() => { websocket.emitTaskUpdated = originalEmit; });
  const calls = [];
  const backend = {
    getCredentials() { return { baseUrl: 'https://tt.example.test', projectId: '2', token: 'tok' }; },
    async getStatuses() { return null; }, // fetchStatusContext() fail-softs to the legacy 5
    async updateTask(id, fields) {
      calls.push({ id, fields });
      return {
        id, status: 'pending', title: 'T', description: '', priority: 1, tags: [], order: 0, dependencies: [],
        agentPermissionMode: fields.agentPermissionMode === undefined ? 'accept_edits' : fields.agentPermissionMode,
      };
    },
  };
  const handler = createHttpHandler(new Map(), () => backend, null);
  const patch = async (body) => {
    const res = fakeRes();
    await handler(fakeReq('PATCH', '/api/tasks/TPT1', { body: JSON.stringify(body) }), res);
    return res;
  };

  let res = await patch({ agent_permission_mode: 'plan' });
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].fields.agentPermissionMode, 'plan');
  assert.equal(json(res).agentPermissionMode, 'plan');
  assert.equal(emitted[0].agentPermissionMode, 'plan');

  res = await patch({ agent_permission_mode: null });
  assert.equal(res.statusCode, 200);
  assert.ok(Object.hasOwn(calls[1].fields, 'agentPermissionMode'), 'an explicit null is forwarded as its own key');
  assert.equal(calls[1].fields.agentPermissionMode, null);
  assert.equal(json(res).agentPermissionMode, null);

  res = await patch({ title: 'x' });
  assert.equal(res.statusCode, 200);
  assert.equal(calls[2].fields.agentPermissionMode, undefined, 'omission leaves the override alone');
  assert.equal(json(res).agentPermissionMode, 'accept_edits');

  res = await patch({ agent_permission_mode: 5 });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error, 'agent_permission_mode must be a string or null');
  assert.equal(calls.length, 3);

  res = await patch({});
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /Must provide/);
});
