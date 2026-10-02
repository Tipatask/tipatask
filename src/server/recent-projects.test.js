'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const m = require('./recent-projects');

const S = 'https://api.example.test';
const entries = [
  { path: '/a1', userId: 1, apiBaseUrl: S },
  { path: '/b1', userId: 2, apiBaseUrl: S },
  { path: '/a2', userId: 1, apiBaseUrl: S },
  { path: '/legacy', userId: null, apiBaseUrl: '' },
];

test('switching accounts changes the visible list', () => {
  assert.deepStrictEqual(m.visibleRecentPaths(entries, () => 1), ['/a1', '/a2']);
  assert.deepStrictEqual(m.visibleRecentPaths(entries, () => 2), ['/b1']);
  assert.deepStrictEqual(m.visibleRecentPaths(entries, () => '2'), ['/b1']);
});

test('signed out -> empty list', () => {
  assert.deepStrictEqual(m.visibleRecentPaths(entries, () => null), []);
});

test('legacy string entries are hidden', () => {
  const legacy = m.normalizeRecentEntries(['/x', '/y']);
  assert.deepStrictEqual(legacy.map((e) => e.userId), [null, null]);
  assert.deepStrictEqual(m.visibleRecentPaths(legacy, () => 1), []);
});

test('store keeps 50, menu shows 10, upsert moves to front and restamps', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ path: `/p${i}`, userId: 1, apiBaseUrl: S }));
  assert.strictEqual(m.normalizeRecentEntries(many).length, 50);
  assert.strictEqual(m.visibleRecentPaths(m.normalizeRecentEntries(many), () => 1).length, 10);
  const next = m.upsertRecentEntry(entries, { path: '/a2', userId: 2, apiBaseUrl: S });
  assert.deepStrictEqual(next[0], { path: '/a2', userId: 2, apiBaseUrl: S });
  assert.strictEqual(next.filter((e) => e.path === '/a2').length, 1);
});

test('reconcile stamps owned, drops foreign/unconfigured, leaves other servers', () => {
  const legacy = m.normalizeRecentEntries(['/own', '/foreign', '/noconf', '/other']);
  const infos = {
    '/own': { apiBaseUrl: S, projectId: 5 },
    '/foreign': { apiBaseUrl: S, projectId: 9 },
    '/other': { apiBaseUrl: 'https://else.test', projectId: 5 },
  };
  const out = m.reconcileLegacyEntries(legacy, {
    apiBaseUrl: S, userId: 7, projectIds: [5, 6], projectInfoFor: (p) => infos[p] || null,
  });
  assert.deepStrictEqual(out, [
    { path: '/own', userId: 7, apiBaseUrl: S },
    { path: '/other', userId: null, apiBaseUrl: '' },
  ]);
});
