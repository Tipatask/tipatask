import { test } from 'node:test';
import assert from 'node:assert/strict';

// (TPT9001) One error shape for a failed task update on both transports, and the rule the
// edit modal labels it by: "Network error" only when the request got no answer.

const GATE = 'Unregistered tag(s) "tt-x" in project 2 (registry has 3 tags) — register each with a real one-line description first, then retry.';

function electronWindow(update, extra = {}) {
  return { electronAPI: { api: { tasks: { update, delete: extra.delete, get: extra.get }, comments: extra.comments, events: extra.events } } };
}

test('Electron update asks for failures as a value and rethrows them with their fields', async () => {
  const calls = [];
  globalThis.window = electronWindow(async (id, patch, opts) => {
    calls.push({ id, patch, opts });
    return { _ipcError: { message: GATE, code: 'TAGS_UNREGISTERED', statusCode: null, networkError: false } };
  });
  try {
    const { api, isTransportError, errorDetail } = await import('./api-client.js?tpt9001-ipc-rejected');
    await assert.rejects(api.tasks.update('TPT1', { tags: ['tt-x'] }), (err) => {
      assert.equal(err.message, GATE);
      assert.equal(err.code, 'TAGS_UNREGISTERED');
      assert.equal(err.statusCode, undefined);
      assert.equal(err.networkError, undefined);
      assert.equal(isTransportError(err), false);
      assert.equal(errorDetail(err), GATE);
      return true;
    });
    assert.deepEqual(calls, [{ id: 'TPT1', patch: { tags: ['tt-x'] }, opts: { errorAsValue: true } }]);
  } finally {
    delete globalThis.window;
  }
});

test('Electron update keeps networkError and a gateway status from the main process', async () => {
  const answers = [
    { _ipcError: { message: 'API unreachable at http://127.0.0.1:4454: fetch failed', code: 'ECONNREFUSED', statusCode: null, networkError: true } },
    { _ipcError: { message: 'API 503: Service Unavailable', code: null, statusCode: 503, networkError: false } },
  ];
  globalThis.window = electronWindow(async () => answers.shift());
  try {
    const { api, isTransportError } = await import('./api-client.js?tpt9001-ipc-transport');
    await assert.rejects(api.tasks.update('TPT1', { title: 'x' }), (err) => {
      assert.equal(err.networkError, true);
      assert.equal(err.code, 'ECONNREFUSED');
      return isTransportError(err);
    });
    await assert.rejects(api.tasks.update('TPT1', { title: 'x' }), (err) => {
      assert.equal(err.statusCode, 503);
      return isTransportError(err);
    });
  } finally {
    delete globalThis.window;
  }
});

test('Electron update passes a successful result through unchanged', async () => {
  const fresh = { id: 'TPT1', title: 'Saved' };
  const answers = [fresh, null];
  globalThis.window = electronWindow(async () => answers.shift());
  try {
    const { api } = await import('./api-client.js?tpt9001-ipc-ok');
    assert.equal(await api.tasks.update('TPT1', { title: 'Saved' }), fresh);
    assert.equal(await api.tasks.update('GONE', { title: 'Saved' }), null);
  } finally {
    delete globalThis.window;
  }
});

test('browser update marks a fetch that got no response, not a server answer', async () => {
  globalThis.window = {};
  globalThis.location = { search: '' };
  const oldFetch = globalThis.fetch;
  try {
    const { api, isTransportError, errorDetail } = await import('./api-client.js?tpt9001-browser');
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(api.tasks.update('TPT1', { title: 'x' }), (err) => {
      assert.ok(err instanceof TypeError);
      assert.equal(err.networkError, true);
      assert.equal(errorDetail(err), 'Failed to fetch');
      return isTransportError(err);
    });
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: GATE }) });
    await assert.rejects(api.tasks.update('TPT1', { tags: ['tt-x'] }), (err) => {
      assert.equal(err.message, GATE);
      assert.equal(err.statusCode, 500);
      assert.equal(err.networkError, undefined);
      return !isTransportError(err);
    });
  } finally {
    globalThis.fetch = oldFetch;
    delete globalThis.location;
    delete globalThis.window;
  }
});

test('isTransportError: only no-answer failures count', async () => {
  const { isTransportError } = await import('./api-client.js?tpt9001-classify');
  const err = (fields) => Object.assign(new Error('x'), fields);
  const cases = [
    [err({ networkError: true }), true],
    [err({ statusCode: 502 }), true],
    [err({ statusCode: 503 }), true],
    [err({ statusCode: 504 }), true],
    [err({ statusCode: 500 }), false],
    [err({ statusCode: 422, code: 'TAGS_UNREGISTERED' }), false],
    [err({ code: 'TAGS_UNREGISTERED' }), false],
    [err({ statusCode: 401 }), false],
    // A main process older than this renderer sends message text only: labelled from fields,
    // never guessed from the text.
    [new Error("Error invoking remote method 'api:tasks.update': Error: API 503: down"), false],
    [null, false],
    [undefined, false],
  ];
  for (const [input, expected] of cases) {
    assert.equal(isTransportError(input), expected, String(input && (input.message + ' ' + JSON.stringify(input))));
  }
});

test('errorDetail strips the Electron IPC wrapper and keeps everything else', async () => {
  const { errorDetail } = await import('./api-client.js?tpt9001-detail');
  assert.equal(
    errorDetail(new Error(`Error invoking remote method 'api:tasks.update': Error: ${GATE}`)),
    GATE,
  );
  assert.equal(
    errorDetail(new Error("Error invoking remote method 'api:tasks.update': AuthCorruptedError: Authentication required for this project")),
    'Authentication required for this project',
  );
  assert.equal(errorDetail(new Error('API 400: {"error":"Invalid status"}')), 'API 400: {"error":"Invalid status"}');
  assert.equal(errorDetail('plain reason'), 'plain reason');
});

// (TPT660) The same envelope on the other task writes: comments, the subscription toggle, delete.

const FORBIDDEN = 'API 403: {"error":"Only the author can edit this comment"}';

test('Electron comment edit rethrows the author-only 403 as a server answer, not a network error', async () => {
  const calls = [];
  globalThis.window = electronWindow(null, {
    comments: {
      async update(taskKey, commentId, content, opts) {
        calls.push({ taskKey, commentId, content, opts });
        return { _ipcError: { message: FORBIDDEN, code: null, statusCode: 403, networkError: false } };
      },
    },
  });
  try {
    const { api, isTransportError, errorDetail } = await import('./api-client.js?tpt660-comment-403');
    await assert.rejects(api.tasks.comments.update('TPT1', 7, 'edited'), (err) => {
      assert.equal(err.message, FORBIDDEN);
      assert.equal(err.statusCode, 403);
      assert.equal(isTransportError(err), false);
      assert.equal(errorDetail(err), FORBIDDEN);
      return true;
    });
    assert.deepEqual(calls, [{ taskKey: 'TPT1', commentId: 7, content: 'edited', opts: { errorAsValue: true } }]);
  } finally {
    delete globalThis.window;
  }
});

test('Electron comment post, subscription toggle and delete ask for the envelope and keep transport fields', async () => {
  const offline = { _ipcError: { message: 'API unreachable at http://127.0.0.1:4454: fetch failed', code: 'ECONNREFUSED', statusCode: null, networkError: true } };
  const calls = [];
  globalThis.window = electronWindow(null, {
    delete: async (id, opts) => { calls.push(['delete', id, opts]); return offline; },
    comments: { async create(taskKey, content, type, opts) { calls.push(['create', taskKey, content, type, opts]); return offline; } },
    events: { async setSubscription(taskKey, subscribed, opts) { calls.push(['sub', taskKey, subscribed, opts]); return offline; } },
  });
  try {
    const { api, isTransportError } = await import('./api-client.js?tpt660-transport');
    const transport = (err) => {
      assert.equal(err.networkError, true);
      assert.equal(err.code, 'ECONNREFUSED');
      return isTransportError(err);
    };
    await assert.rejects(api.tasks.comments.create('TPT1', 'hello', 'comment'), transport);
    await assert.rejects(api.tasks.events.setSubscription('TPT1', false), transport);
    await assert.rejects(api.tasks.delete('TPT1'), transport);
    assert.deepEqual(calls, [
      ['create', 'TPT1', 'hello', 'comment', { errorAsValue: true }],
      ['sub', 'TPT1', false, { errorAsValue: true }],
      ['delete', 'TPT1', { errorAsValue: true }],
    ]);
  } finally {
    delete globalThis.window;
  }
});

test('Electron comment, subscription and delete successes pass through with their old shaping', async () => {
  const comment = { id: 7, content: 'hello' };
  globalThis.window = electronWindow(null, {
    delete: async () => ({ ok: true }),
    comments: {
      async create() { return { comment }; },
      async update() { return comment; },
    },
    events: { async setSubscription() { return null; } },
  });
  try {
    const { api } = await import('./api-client.js?tpt660-ok');
    assert.equal(await api.tasks.comments.create('TPT1', 'hello'), comment);
    assert.equal(await api.tasks.comments.update('TPT1', 7, 'hello'), comment);
    assert.deepEqual(await api.tasks.events.setSubscription('TPT1', true), { subscribed: true });
    assert.deepEqual(await api.tasks.delete('TPT1'), { ok: true });
  } finally {
    delete globalThis.window;
  }
});

// (TPT665) The task-open read asks for the same envelope; the 403 keeps its own marker.

const AUTH = 'Authentication required for this project';

test('Electron task open asks for failures as a value: an auth failure is a server answer, not a network error', async () => {
  const calls = [];
  const answers = [
    { _ipcError: { message: AUTH, code: 'EAUTH', statusCode: 401, networkError: false } },
    { _ipcError: { message: 'API unreachable at http://127.0.0.1:4454: fetch failed', code: 'ECONNREFUSED', statusCode: null, networkError: true } },
  ];
  globalThis.window = electronWindow(null, { get: async (id, opts) => { calls.push([id, opts]); return answers.shift(); } });
  try {
    const { api, isTransportError, errorDetail } = await import('./api-client.js?tpt665-open-errors');
    await assert.rejects(api.tasks.get('TPT1'), (err) => {
      assert.equal(err.message, AUTH);
      assert.equal(err.code, 'EAUTH');
      assert.equal(err.statusCode, 401);
      assert.equal(isTransportError(err), false);
      assert.equal(errorDetail(err), AUTH);
      return true;
    });
    await assert.rejects(api.tasks.get('TPT1'), (err) => {
      assert.equal(err.networkError, true);
      assert.equal(err.code, 'ECONNREFUSED');
      return isTransportError(err);
    });
    assert.deepEqual(calls, [['TPT1', { errorAsValue: true }], ['TPT1', { errorAsValue: true }]]);
  } finally {
    delete globalThis.window;
  }
});

test('Electron task open keeps the access-denied marker and passes a task or null through', async () => {
  const fresh = { id: 'TPT1', title: 'Fresh' };
  const answers = [{ _taskAccessDenied: true }, fresh, null];
  globalThis.window = electronWindow(null, { get: async () => answers.shift() });
  try {
    const { api, isTransportError } = await import('./api-client.js?tpt665-open-ok');
    await assert.rejects(api.tasks.get('TPT1'), (err) => err.statusCode === 403 && !isTransportError(err));
    assert.equal(await api.tasks.get('TPT1'), fresh);
    assert.equal(await api.tasks.get('GONE'), null);
  } finally {
    delete globalThis.window;
  }
});
