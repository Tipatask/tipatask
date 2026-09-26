import { test } from 'node:test';
import assert from 'node:assert/strict';

import { t, setLocale } from './i18n.js';

test('Electron task fetch turns access denial into a status-bearing error for localized modal feedback', async () => {
  globalThis.window = {
    electronAPI: { api: { tasks: { get: async () => ({ _taskAccessDenied: true }) } } },
  };
  try {
    const { api } = await import('./api-client.js?completion-electron');
    await assert.rejects(api.tasks.get('C1'), (err) => err.statusCode === 403);
  } finally {
    delete globalThis.window;
  }
});

test('deleted task fetch returns null for the modal not-found path', async () => {
  globalThis.window = {
    electronAPI: { api: { tasks: { get: async () => null } } },
  };
  try {
    const { api } = await import('./api-client.js?completion-deleted');
    assert.equal(await api.tasks.get('C1'), null);
  } finally {
    delete globalThis.window;
  }
});

test('browser task fetch preserves HTTP status for unavailable-task handling', async () => {
  globalThis.window = {};
  globalThis.location = { search: '?projectPath=%2Fproject%2FA' };
  const oldFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
  };
  try {
    const { api } = await import('./api-client.js?completion-browser');
    await assert.rejects(api.tasks.get('C1'), (err) => err.statusCode === 404);
    assert.equal(request.url, '/api/tasks/C1');
    assert.equal(request.options.headers['x-tipatask-project'], '/project/A');
  } finally {
    globalThis.fetch = oldFetch;
    delete globalThis.location;
    delete globalThis.window;
  }
});

test('missing and inaccessible task messages are localized', () => {
  try {
    setLocale('en');
    assert.match(t('modal.errTaskNotFound', { id: 'C1' }), /C1.*not found/);
    assert.match(t('modal.errTaskUnavailable', { id: 'C1' }), /C1.*no longer available/);
    setLocale('uk');
    assert.match(t('modal.errTaskNotFound', { id: 'C1' }), /C1.*не знайдено/);
    assert.match(t('modal.errTaskUnavailable', { id: 'C1' }), /C1.*недоступна/);
  } finally {
    setLocale('en');
  }
});
