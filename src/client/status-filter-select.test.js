// ── status-filter-select.js unit tests (C1547) ──
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStatusRowChecked, nextStatusSelection } from './status-filter-select.js';

const ALL_NAMES = ['pending', 'in_progress', 'on_fire', 'completed', 'canceled'];

test('isStatusRowChecked: empty selection checks every row including All statuses', () => {
  const selected = new Set();
  assert.equal(isStatusRowChecked(selected, ''), true);
  for (const name of ALL_NAMES) assert.equal(isStatusRowChecked(selected, name), true);
});

test('isStatusRowChecked: explicit subset only checks its members', () => {
  const selected = new Set(['pending', 'on_fire']);
  assert.equal(isStatusRowChecked(selected, ''), false);
  assert.equal(isStatusRowChecked(selected, 'pending'), true);
  assert.equal(isStatusRowChecked(selected, 'on_fire'), true);
  assert.equal(isStatusRowChecked(selected, 'completed'), false);
  assert.equal(isStatusRowChecked(selected, 'canceled'), false);
});

test('nextStatusSelection: checking All statuses clears to empty', () => {
  const selected = new Set(['pending', 'on_fire']);
  const next = nextStatusSelection(selected, '', true, ALL_NAMES);
  assert.equal(next.size, 0);
});

test('nextStatusSelection: unchecking a row from the empty "all" state expands to the explicit complement', () => {
  const selected = new Set();
  const next = nextStatusSelection(selected, 'pending', false, ALL_NAMES);
  assert.deepEqual([...next].sort(), ['canceled', 'completed', 'in_progress', 'on_fire']);
  // Original Set is untouched — caller must reassign, not rely on mutation.
  assert.equal(selected.size, 0);
});

test('nextStatusSelection: re-checking the missing name from a full complement normalizes back to empty', () => {
  const selected = new Set(['in_progress', 'on_fire', 'completed', 'canceled']);
  const next = nextStatusSelection(selected, 'pending', true, ALL_NAMES);
  assert.equal(next.size, 0);
});

test('nextStatusSelection: checking a row on an explicit subset adds it', () => {
  const selected = new Set(['pending']);
  const next = nextStatusSelection(selected, 'on_fire', true, ALL_NAMES);
  assert.deepEqual([...next].sort(), ['on_fire', 'pending']);
});

test('nextStatusSelection: unchecking a row from an explicit subset removes it', () => {
  const selected = new Set(['pending', 'on_fire']);
  const next = nextStatusSelection(selected, 'on_fire', false, ALL_NAMES);
  assert.deepEqual([...next], ['pending']);
});
