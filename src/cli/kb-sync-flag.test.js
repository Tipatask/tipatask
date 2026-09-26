'use strict';

// C1490 — unit tests for knowledge-sync.js's Sync-as-you-go gate: normalizeSyncAsYouGo()
// (pure) and isSyncAsYouGoEnabled() (fail-open fetcher). No network — the backend-shaped
// branch is exercised with a stub object; the creds-shaped branch (real HTTP GET) is
// covered live by the manual verification steps in the task, not here.

const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeSyncAsYouGo, isSyncAsYouGoEnabled, __resetSyncState } = require('./knowledge-sync');

test('normalizeSyncAsYouGo: null row -> true (offline/no creds default)', () => {
  assert.strictEqual(normalizeSyncAsYouGo(null), true);
});

test('normalizeSyncAsYouGo: missing column -> true (pre-C1488 API)', () => {
  assert.strictEqual(normalizeSyncAsYouGo({ id: 1, name: 'x' }), true);
});

test('normalizeSyncAsYouGo: 1/true -> true', () => {
  assert.strictEqual(normalizeSyncAsYouGo({ kb_sync_as_you_go: 1 }), true);
  assert.strictEqual(normalizeSyncAsYouGo({ kb_sync_as_you_go: true }), true);
});

test('normalizeSyncAsYouGo: 0/false -> false', () => {
  assert.strictEqual(normalizeSyncAsYouGo({ kb_sync_as_you_go: 0 }), false);
  assert.strictEqual(normalizeSyncAsYouGo({ kb_sync_as_you_go: false }), false);
});

test('isSyncAsYouGoEnabled: null/undefined/garbage source -> true, never throws', async () => {
  assert.strictEqual(await isSyncAsYouGoEnabled(null), true);
  assert.strictEqual(await isSyncAsYouGoEnabled(undefined), true);
  assert.strictEqual(await isSyncAsYouGoEnabled({}), true);
  assert.strictEqual(await isSyncAsYouGoEnabled('nonsense'), true);
});

test('isSyncAsYouGoEnabled: backend-shaped source reads getProjectSettings() and normalizes', async () => {
  const backend = { getProjectSettings: async () => ({ kb_sync_as_you_go: 0 }) };
  assert.strictEqual(await isSyncAsYouGoEnabled(backend), false);
});

test('isSyncAsYouGoEnabled: backend-shaped source with flag on -> true', async () => {
  const backend = { getProjectSettings: async () => ({ kb_sync_as_you_go: 1 }) };
  assert.strictEqual(await isSyncAsYouGoEnabled(backend), true);
});

test('isSyncAsYouGoEnabled: backend getProjectSettings throwing -> fail-open true', async () => {
  const backend = { getProjectSettings: async () => { throw new Error('offline'); } };
  assert.strictEqual(await isSyncAsYouGoEnabled(backend), true);
});

test('isSyncAsYouGoEnabled: backend getProjectSettings resolving null -> true', async () => {
  const backend = { getProjectSettings: async () => null };
  assert.strictEqual(await isSyncAsYouGoEnabled(backend), true);
});

test('__resetSyncState clears the creds-shaped memoization cache without throwing', () => {
  __resetSyncState();
  __resetSyncState('/some/root');
});
