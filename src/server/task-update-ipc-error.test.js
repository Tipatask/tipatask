'use strict';

// (TPT9001) api:tasks.update hands a failure back as a value when the renderer asks for it, so
// the edit modal can tell a save the API rejected from a request that got no answer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { unregisteredTagError } = require('./tag-registry-gate');
const { AuthCorruptedError } = require('./auth-guard');

const event = { sender: { id: 1 } };

// (TPT660) Every api:tasks.* write handler, registered against one stubbed backend.
function loadHandlers(backend) {
  const handlers = new Map();
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
  return handlers;
}

function loadUpdateHandler(backend) {
  return loadHandlers(backend).get('api:tasks.update');
}

function throwingBackend(err, calls = []) {
  return {
    async updateTask(id, patch, opts) {
      calls.push({ id, patch, opts });
      throw err;
    },
  };
}

test('a tag-gate rejection comes back as a value with its code and clean message', async () => {
  const gate = unregisteredTagError(['tt-new-probe'], {
    projectId: 2,
    registrySize: 3,
    note: 'Automatic registration could not describe these tags (tt-* tags always need create_system_tag).',
  });
  const calls = [];
  const update = loadUpdateHandler(throwingBackend(gate, calls));
  const result = await update(event, {
    id: 'TPT1',
    patch: { tags: ['tt-new-probe'], auto_register_tags: true },
    opts: { errorAsValue: true },
  });
  assert.deepEqual(result, {
    _ipcError: { message: gate.message, code: 'TAGS_UNREGISTERED', statusCode: null, networkError: false },
  });
  assert.match(result._ipcError.message, /^Unregistered tag\(s\) "tt-new-probe"/);
  // The handler body is unchanged: the client-only flag is still stripped and passed as an option.
  assert.deepEqual(calls, [{ id: 'TPT1', patch: { tags: ['tt-new-probe'] }, opts: { autoRegisterTags: true } }]);
});

test('a transport failure keeps networkError, a gateway answer keeps its status', async () => {
  const offline = Object.assign(new Error('API unreachable at http://127.0.0.1:4454: fetch failed'), {
    networkError: true,
    code: 'ECONNREFUSED',
  });
  let result = await loadUpdateHandler(throwingBackend(offline))(event, {
    id: 'TPT1', patch: { title: 'x' }, opts: { errorAsValue: true },
  });
  assert.deepEqual(result._ipcError, { message: offline.message, code: 'ECONNREFUSED', statusCode: null, networkError: true });

  const gateway = Object.assign(new Error('API 503: Service Unavailable'), { statusCode: 503 });
  result = await loadUpdateHandler(throwingBackend(gateway))(event, {
    id: 'TPT1', patch: { title: 'x' }, opts: { errorAsValue: true },
  });
  assert.deepEqual(result._ipcError, { message: 'API 503: Service Unavailable', code: null, statusCode: 503, networkError: false });

  // (TPT661) api-backend.js flags a reverse-proxy 502/503/504 as a network failure while
  // keeping its status; the envelope carries both unchanged.
  const gatewayOffline = Object.assign(new Error('API 503: Service Unavailable'), { statusCode: 503, networkError: true, retryable: true });
  result = await loadUpdateHandler(throwingBackend(gatewayOffline))(event, {
    id: 'TPT1', patch: { title: 'x' }, opts: { errorAsValue: true },
  });
  assert.deepEqual(result._ipcError, { message: 'API 503: Service Unavailable', code: null, statusCode: 503, networkError: true });
});

test('a window with no project bound answers with the same envelope', async () => {
  const result = await loadUpdateHandler(null)(event, { id: 'TPT1', patch: { title: 'x' }, opts: { errorAsValue: true } });
  assert.deepEqual(result, {
    _ipcError: { message: 'No project loaded', code: null, statusCode: null, networkError: false },
  });
});

test('callers that do not ask for the envelope still get a rejected promise', async () => {
  const gate = unregisteredTagError(['tt-new-probe'], { projectId: 2, registrySize: 3 });
  const update = loadUpdateHandler(throwingBackend(gate));
  await assert.rejects(update(event, { id: 'TPT1', patch: { status: 'completed' } }), /^Error: Unregistered tag\(s\)/);
});

test('a successful update still returns the re-read task with parentRescheduled', async () => {
  const update = loadUpdateHandler({
    async updateTask(id, patch) {
      return { id, title: patch.title, _parentRescheduled: [{ task_key: 'TPT2', from: 1, to: 2 }] };
    },
    async getTask(id) {
      return { id, title: 'Fresh title' };
    },
  });
  const result = await update(event, { id: 'TPT1', patch: { title: 'New title' }, opts: { errorAsValue: true } });
  assert.deepEqual(result, {
    id: 'TPT1',
    title: 'Fresh title',
    parentRescheduled: [{ task_key: 'TPT2', from: 1, to: 2 }],
  });
});

// (TPT660) The other write channels answer with the same envelope under opts.errorAsValue.

const WRITE_CHANNELS = [
  ['api:tasks.comments.create', 'createTaskComment', { taskKey: 'TPT1', content: 'hi', type: 'comment' }, ['TPT1', 'hi', 'comment']],
  ['api:tasks.comments.update', 'updateTaskComment', { taskKey: 'TPT1', commentId: 7, content: 'edited' }, ['TPT1', 7, 'edited']],
  ['api:tasks.events.setSubscription', 'setTaskSubscription', { taskKey: 'TPT1', subscribed: false }, ['TPT1', false]],
  ['api:tasks.delete', 'deleteTask', { id: 'TPT1' }, ['TPT1']],
];

function failingBackend(method, err, calls) {
  return { async [method](...args) { calls.push(args); throw err; } };
}

for (const [channel, method, args, expectedArgs] of WRITE_CHANNELS) {
  test(`${channel}: a server rejection comes back as a value with its status, a transport failure keeps networkError`, async () => {
    const forbidden = Object.assign(new Error('API 403: {"error":"Only the author can edit this comment"}'), { statusCode: 403 });
    const calls = [];
    let result = await loadHandlers(failingBackend(method, forbidden, calls)).get(channel)(event, { ...args, opts: { errorAsValue: true } });
    assert.deepEqual(result, { _ipcError: { message: forbidden.message, code: null, statusCode: 403, networkError: false } });
    assert.deepEqual(calls, [expectedArgs]);

    const offline = Object.assign(new Error('API unreachable at http://127.0.0.1:4454: fetch failed'), { networkError: true, code: 'ECONNREFUSED' });
    result = await loadHandlers(failingBackend(method, offline, [])).get(channel)(event, { ...args, opts: { errorAsValue: true } });
    assert.deepEqual(result._ipcError, { message: offline.message, code: 'ECONNREFUSED', statusCode: null, networkError: true });
  });

  test(`${channel}: no project bound answers with the envelope; no flag still rejects`, async () => {
    assert.deepEqual(await loadHandlers(null).get(channel)(event, { ...args, opts: { errorAsValue: true } }), {
      _ipcError: { message: 'No project loaded', code: null, statusCode: null, networkError: false },
    });
    const gate = new Error('API 403: nope');
    await assert.rejects(loadHandlers(failingBackend(method, gate, [])).get(channel)(event, args), /^Error: API 403: nope$/);
  });
}

test('api:tasks.delete still accepts a bare id from an older caller', async () => {
  const calls = [];
  const handlers = loadHandlers({ async deleteTask(id) { calls.push(id); return { ok: true }; } });
  assert.deepEqual(await handlers.get('api:tasks.delete')(event, 'TPT1'), { ok: true });
  assert.deepEqual(await handlers.get('api:tasks.delete')(event, { id: 'TPT2', opts: { errorAsValue: true } }), { ok: true });
  assert.deepEqual(calls, ['TPT1', 'TPT2']);
});

// (TPT665) The task-open read answers with the same envelope, so the edit modal can tell a
// failure the API answered (a 500, an auth failure) from a request that got no answer. The 403
// keeps its own { _taskAccessDenied } marker.

function failingGetBackend(err, calls = []) {
  return { async getTask(id) { calls.push(id); throw err; } };
}

const asValue = (id) => ({ id, opts: { errorAsValue: true } });

test('api:tasks.get: a server answer comes back as a value with its status, a transport failure keeps networkError', async () => {
  const calls = [];
  const serverError = Object.assign(new Error('API 500: {"error":"boom"}'), { statusCode: 500 });
  let result = await loadHandlers(failingGetBackend(serverError, calls)).get('api:tasks.get')(event, asValue('TPT1'));
  assert.deepEqual(result, { _ipcError: { message: serverError.message, code: null, statusCode: 500, networkError: false } });
  assert.deepEqual(calls, ['TPT1']);

  const auth = new AuthCorruptedError('Authentication required for this project', { reasonCode: 'unauthorized', statusCode: 401 });
  result = await loadHandlers(failingGetBackend(auth)).get('api:tasks.get')(event, asValue('TPT1'));
  assert.deepEqual(result, {
    _ipcError: { message: 'Authentication required for this project', code: 'EAUTH', statusCode: 401, networkError: false },
  });

  const offline = Object.assign(new Error('API unreachable at http://127.0.0.1:4454: fetch failed'), { networkError: true, code: 'ECONNREFUSED' });
  result = await loadHandlers(failingGetBackend(offline)).get('api:tasks.get')(event, asValue('TPT1'));
  assert.deepEqual(result._ipcError, { message: offline.message, code: 'ECONNREFUSED', statusCode: null, networkError: true });
});

test('api:tasks.get: a 403 keeps the access-denied marker; without the flag a failure still rejects', async () => {
  const denied = new AuthCorruptedError('Access denied — this project may not belong to your account', { reasonCode: 'unauthorized', statusCode: 403 });
  const get = loadHandlers(failingGetBackend(denied)).get('api:tasks.get');
  assert.deepEqual(await get(event, asValue('TPT1')), { _taskAccessDenied: true });
  assert.deepEqual(await get(event, 'TPT1'), { _taskAccessDenied: true });

  const serverError = Object.assign(new Error('API 500: boom'), { statusCode: 500 });
  const failing = loadHandlers(failingGetBackend(serverError)).get('api:tasks.get');
  await assert.rejects(failing(event, { id: 'TPT1' }), /^Error: API 500: boom$/);
  await assert.rejects(failing(event, 'TPT1'), /^Error: API 500: boom$/);
});

test('api:tasks.get: a bare id or { id, opts } returns the task; no project bound still returns null', async () => {
  const calls = [];
  const get = loadHandlers({ async getTask(id) { calls.push(id); return { id, title: `Title ${id}` }; } }).get('api:tasks.get');
  assert.deepEqual(await get(event, 'TPT1'), { id: 'TPT1', title: 'Title TPT1' });
  assert.deepEqual(await get(event, asValue('TPT2')), { id: 'TPT2', title: 'Title TPT2' });
  assert.deepEqual(calls, ['TPT1', 'TPT2']);
  assert.equal(await loadHandlers(null).get('api:tasks.get')(event, asValue('TPT1')), null);
});
