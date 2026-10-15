import { test } from 'node:test';
import assert from 'node:assert/strict';

import { t, setLocale } from './i18n.js';

// api-client.js reads window.electronAPI once at load: install one stable bridge whose
// tasks.get delegates to the case's stub, then import.
let ipcGet = async () => null;
const calls = [];
globalThis.window = { electronAPI: { api: { tasks: { get: (...args) => { calls.push(args); return ipcGet(...args); } } } } };
const { loadTaskForAction, fetchTaskOrNull } = await import('./task-fetch.js');

async function withIpcGet(get, run) {
  ipcGet = get;
  calls.length = 0;
  await run();
}

test('loadTaskForAction: the IPC 403 marker reads as unavailable, not as a task', async () => {
  await withIpcGet(async () => ({ _taskAccessDenied: true }), async () => {
    const result = await loadTaskForAction('C1', 'card.errStartLoad');
    assert.equal(result.task, undefined);
    assert.equal(result.message, 'Task C1 is no longer available');
  });
});

test('loadTaskForAction: an { _ipcError } the server answered gets the action key with its text', async () => {
  await withIpcGet(async () => ({ _ipcError: { message: 'API 500: boom', statusCode: 500 } }), async () => {
    const result = await loadTaskForAction('C1', 'card.errStartLoad');
    assert.deepEqual(calls[0], ['C1', { errorAsValue: true }]);
    assert.equal(result.message, 'Could not load task C1 to start it: API 500: boom');
    assert.doesNotMatch(result.message, /Error invoking remote method/);
  });
});

test('loadTaskForAction: no answer from the API reads as a network error', async () => {
  await withIpcGet(async () => ({ _ipcError: { message: 'connect ECONNREFUSED', networkError: true } }),
    async () => {
      const result = await loadTaskForAction('C1', 'handoff.errLoad');
      assert.equal(result.message, 'Network error: connect ECONNREFUSED');
    });
});

test('loadTaskForAction: a rejected IPC call loses the Electron wrapper', async () => {
  await withIpcGet(async () => { throw new Error("Error invoking remote method 'api:tasks.get': Error: API 500: boom"); },
    async () => {
      const result = await loadTaskForAction('C1', 'handoff.errLoad');
      assert.equal(result.message, 'Could not load C1 for Objective chat: API 500: boom');
    });
});

test('loadTaskForAction: a missing task reads as not found; a real one comes back', async () => {
  await withIpcGet(async () => null, async () => {
    assert.match((await loadTaskForAction('C1', 'card.errStartLoad')).message, /C1.*not found/);
  });
  const task = { id: 'C1', title: 'Real' };
  await withIpcGet(async () => task, async () => {
    assert.deepEqual(await loadTaskForAction('C1', 'card.errStartLoad'), { task });
  });
});

test('fetchTaskOrNull: the 403 marker and any failure resolve to null', async () => {
  await withIpcGet(async () => ({ _taskAccessDenied: true }), async () => {
    assert.equal(await fetchTaskOrNull('C1'), null);
  });
  await withIpcGet(async () => ({ _ipcError: { message: 'boom', statusCode: 500 } }), async () => {
    assert.equal(await fetchTaskOrNull('C1'), null);
  });
  await withIpcGet(async () => ({ id: 'C1' }), async () => {
    assert.deepEqual(await fetchTaskOrNull('C1'), { id: 'C1' });
  });
});

test('start and hand-off load-failure keys exist in en and uk', () => {
  try {
    assert.equal(t('card.errStartLoad', { id: 'C1', msg: 'boom' }), 'Could not load task C1 to start it: boom');
    assert.equal(t('handoff.errLoad', { id: 'C1', msg: 'boom' }), 'Could not load C1 for Objective chat: boom');
    setLocale('uk');
    assert.match(t('card.errStartLoad', { id: 'C1', msg: 'boom' }), /^Не вдалося завантажити задачу C1 для запуску: boom$/);
    assert.match(t('handoff.errLoad', { id: 'C1', msg: 'boom' }), /^Не вдалося завантажити C1 для чату цілі: boom$/);
  } finally {
    setLocale('en');
  }
});
