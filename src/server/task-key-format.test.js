'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isLegacyTaskKey, TASK_KEY_RE, isValidTaskKey, parseTaskKey, isTaskKeyLike, maxNumbersByPrefix, resolveCodingPrefix, HUMAN_TASK_PREFIX, EPIC_KEY_RE, SUSPECT_KEY_GAP, reconcileNextNumber } = require('./task-key-format');

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

// ── TPT622: fallback warning + create-key namespace check ──

test('resolveCodingPrefix passes a derived prefix through without warning', (t) => {
  const { _resetCodingPrefixFallbackWarning } = require('./task-key-format');
  _resetCodingPrefixFallbackWarning();
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(resolveCodingPrefix('MNY'), 'MNY');
  assert.equal(resolveCodingPrefix('TPT'), 'TPT');
  assert.equal(warn.mock.callCount(), 0);
});

test('resolveCodingPrefix warns exactly once per process when it falls back to C', (t) => {
  const { _resetCodingPrefixFallbackWarning } = require('./task-key-format');
  _resetCodingPrefixFallbackWarning();
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(resolveCodingPrefix(null), 'C');
  assert.equal(resolveCodingPrefix('C'), 'C');
  assert.equal(resolveCodingPrefix('tpt'), 'C');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /falling back to legacy 'C'/);
});

test('HUMAN_TASK_PREFIX and EPIC_KEY_RE match the api/src/lib twin', () => {
  assert.equal(HUMAN_TASK_PREFIX, 'H');
  assert.equal(EPIC_KEY_RE.source, '^[A-Z]{1,8}-[0-9]+$');
});

test('isLegacyTaskKey accepts existing slug keys but create-time validation stays strict', () => {
  for (const key of ['C-kb-docs-site', 'C-kb-dev-scripts', 'C-foo_bar']) {
    assert.equal(isLegacyTaskKey(key), true, `expected "${key}" legacy`);
    assert.equal(isValidTaskKey(key), false, `expected "${key}" rejected at create time`);
  }
});

test('isLegacyTaskKey rejects strict keys, unsafe ref names and non-strings', () => {
  for (const key of ['TPT214', 'H3', 'TIPA-1', '', 'a/b', '../x', 'a..b', 'has space', '-lead', 'task/C1', null, undefined, 42, {}]) {
    assert.equal(isLegacyTaskKey(key), false, `expected ${JSON.stringify(key)} not legacy`);
  }
});

// ── TPT394: taskKeyFormatError ──

test('taskKeyFormatError returns null for a valid key', () => {
  const { taskKeyFormatError } = require('./task-key-format');
  for (const key of ['C214', 'H3', 'TPT394']) assert.equal(taskKeyFormatError(key), null);
});

test('taskKeyFormatError names the offending slug and the contract regex', () => {
  const { taskKeyFormatError } = require('./task-key-format');
  for (const key of ['C-kb-docs-site', '', undefined, 42]) {
    const msg = taskKeyFormatError(key);
    assert.equal(typeof msg, 'string');
    assert.ok(msg.includes(JSON.stringify(key)), `message should name ${JSON.stringify(key)}`);
    assert.ok(msg.includes('^(H|[A-Z]{1,6})[0-9]+$'));
  }
});

// ── TPT9004: single-allocator reconciliation ──

test('SUSPECT_KEY_GAP is the 500-key tolerance named in ai/architecture/tt-api-backend.md', () => {
  assert.equal(SUSPECT_KEY_GAP, 500);
});

test('reconcileNextNumber prefers the API peek over the local max+1 whenever the peek is known', () => {
  assert.deepEqual(reconcileNextNumber({ prefix: 'TPT', localNext: 701, peekNext: 9005 }), { next: 9005, suspect: false, source: 'peek' });
  assert.deepEqual(reconcileNextNumber({ prefix: 'TPT', localNext: 9005, peekNext: 9005 }), { next: 9005, suspect: false, source: 'peek' });
});

test('reconcileNextNumber falls back to the local number without a usable peek', () => {
  assert.deepEqual(reconcileNextNumber({ prefix: 'TPT', localNext: 701 }), { next: 701, suspect: false, source: 'local' });
  assert.deepEqual(reconcileNextNumber({ prefix: 'TPT', localNext: 701, peekNext: null }), { next: 701, suspect: false, source: 'local' });
  assert.deepEqual(reconcileNextNumber({ prefix: 'TPT', localNext: 701, peekNext: 0 }), { next: 701, suspect: false, source: 'local' });
  assert.deepEqual(reconcileNextNumber({ prefix: 'TPT', localNext: 701, peekNext: NaN }), { next: 701, suspect: false, source: 'local' });
  assert.deepEqual(reconcileNextNumber({ prefix: 'TPT' }), { next: 1, suspect: false, source: 'local' }, 'no numbers at all -> 1');
});

test('reconcileNextNumber flags a local number more than SUSPECT_KEY_GAP above the peek and still answers with the peek', () => {
  assert.deepEqual(reconcileNextNumber({ prefix: 'TPT', localNext: 1205, peekNext: 705 }), { next: 705, suspect: false, source: 'peek' }, 'exactly +500 is not suspect');
  assert.deepEqual(reconcileNextNumber({ prefix: 'TPT', localNext: 1206, peekNext: 705 }), { next: 705, suspect: true, source: 'peek' }, '+501 is');
  assert.equal(reconcileNextNumber({ prefix: 'TPT', localNext: 701, peekNext: 9005 }).suspect, false, 'a peek ahead of the local list is never suspect — deleted rows and the allocator itself do that');
});

test('reconcileNextNumber steps a candidate past keys that are already taken', () => {
  const taken = new Set(['TPT705', 'TPT706', 'H3']);
  assert.equal(reconcileNextNumber({ prefix: 'TPT', localNext: 1300, peekNext: 705, taken }).next, 707);
  assert.equal(reconcileNextNumber({ prefix: 'H', localNext: 4, peekNext: 3, taken }).next, 4, 'the H set is separate');
  assert.equal(reconcileNextNumber({ prefix: 'TPT', localNext: 10, taken: new Set(['TPT10']) }).next, 11, 'a taken local candidate moves on too');
});
