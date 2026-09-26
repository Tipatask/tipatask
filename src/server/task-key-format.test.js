'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TASK_KEY_RE, isValidTaskKey, parseTaskKey, isTaskKeyLike, maxNumbersByPrefix, resolveCodingPrefix, HUMAN_TASK_PREFIX, EPIC_KEY_RE } = require('./task-key-format');

test('isValidTaskKey accepts prefix+number keys (legacy C/H and per-project prefixes)', () => {
  for (const key of ['C214', 'H3', 'TPT214', 'TSK1', 'A0']) {
    assert.equal(isValidTaskKey(key), true, `expected "${key}" to be valid`);
  }
});

test('isValidTaskKey rejects descriptive slugs and other malformed keys', () => {
  for (const key of ['C-kb-dev-scripts', 'C-foo-bar', 'foo', '123', '', 'c1', 'TOOLONGPREFIX1']) {
    assert.equal(isValidTaskKey(key), false, `expected "${key}" to be invalid`);
  }
});

test('isValidTaskKey rejects non-string input', () => {
  for (const val of [null, undefined, 42, {}, []]) {
    assert.equal(isValidTaskKey(val), false);
  }
});

test('TASK_KEY_RE is the exact contract regex named in ai/architecture/tt-cli-setup.md', () => {
  assert.equal(TASK_KEY_RE.source, '^(H|[A-Z]{1,6})[0-9]+$');
});

// ── C1483: parseTaskKey / isTaskKeyLike / maxNumbersByPrefix / resolveCodingPrefix ──

test('parseTaskKey splits a valid key into prefix + number', () => {
  assert.deepEqual(parseTaskKey('TPT214'), { prefix: 'TPT', number: '214' });
  assert.deepEqual(parseTaskKey('H97'), { prefix: 'H', number: '97' });
  assert.equal(parseTaskKey('C-kb-dev-scripts'), null);
  assert.equal(parseTaskKey(42), null);
});

test('isTaskKeyLike accepts prefix+number and dashed epic keys, rejects synthetic/session ids and slugs', () => {
  for (const key of ['TPT214', 'H3', 'C1482', 'TIPA-1']) {
    assert.equal(isTaskKeyLike(key), true, `expected "${key}" to be key-like`);
  }
  for (const key of ['new', 'new-abc123-1', 'new-obj-abc123', 'obj-1712345678', 'specChat:C123', 'C-kb-dev-scripts', '', null, undefined, 42]) {
    assert.equal(isTaskKeyLike(key), false, `expected "${key}" to NOT be key-like`);
  }
});

test('maxNumbersByPrefix returns per-prefix max suffix, ignoring non-key-shaped entries', () => {
  const result = maxNumbersByPrefix(['TPT214', 'H11', 'C1482', 'C-kb-dev-scripts', 'TPT9', 'not-a-key']);
  assert.deepEqual(Object.fromEntries(result), { TPT: 214, H: 11, C: 1482 });
});

test('maxNumbersByPrefix accepts task-row objects with an id field, not just bare strings', () => {
  const result = maxNumbersByPrefix([{ id: 'TPT5' }, { id: 'TPT12' }, { id: 'H2' }]);
  assert.deepEqual(Object.fromEntries(result), { TPT: 12, H: 2 });
});

test('resolveCodingPrefix returns the project prefix when valid, else degrades to legacy C', () => {
  assert.equal(resolveCodingPrefix('TPT'), 'TPT');
  for (const bad of [undefined, null, 'C', '', 'toolong123', 'a']) {
    assert.equal(resolveCodingPrefix(bad), 'C');
  }
});

test('HUMAN_TASK_PREFIX and EPIC_KEY_RE match the api/src/lib twin', () => {
  assert.equal(HUMAN_TASK_PREFIX, 'H');
  assert.equal(EPIC_KEY_RE.source, '^[A-Z]{1,8}-[0-9]+$');
});
