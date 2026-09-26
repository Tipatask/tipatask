import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLocale } from './i18n.js';
import { seedStatuses, resetStatuses } from './status-registry.js';

const { buildSubtasksLabel, closedDelta, applyChildStatusDelta, countChildProgress } = await import('./subtask-count.js');

// ── buildSubtasksLabel ──

test('buildSubtasksLabel: bare label when childrenCount is null', () => {
  setLocale('en');
  assert.equal(buildSubtasksLabel({ childrenCount: null }), 'Subtasks');
});

test('buildSubtasksLabel: bare label when childrenCount is undefined', () => {
  setLocale('en');
  assert.equal(buildSubtasksLabel({}), 'Subtasks');
});

test('buildSubtasksLabel: 0/3 when completedChildrenCount is null but total is known', () => {
  setLocale('en');
  assert.equal(buildSubtasksLabel({ childrenCount: 3, completedChildrenCount: null }), 'Subtasks 0/3');
});

test('buildSubtasksLabel: 2/3 formatting', () => {
  setLocale('en');
  assert.equal(buildSubtasksLabel({ childrenCount: 3, completedChildrenCount: 2 }), 'Subtasks 2/3');
});

test('buildSubtasksLabel: 0/0 stays a real count, not the bare fallback, when total is genuinely 0', () => {
  setLocale('en');
  assert.equal(buildSubtasksLabel({ childrenCount: 0, completedChildrenCount: 0 }), 'Subtasks 0/0');
});

// ── closedDelta ── (role-derived: complete OR canceled = closed, C1187)

test('closedDelta: pending -> completed crosses into closed (+1)', () => {
  assert.equal(closedDelta('pending', 'completed'), 1);
});

test('closedDelta: completed -> pending crosses out of closed (-1)', () => {
  assert.equal(closedDelta('completed', 'pending'), -1);
});

test('closedDelta: completed -> canceled stays closed either way (0)', () => {
  assert.equal(closedDelta('completed', 'canceled'), 0);
});

test('closedDelta: canceled -> completed stays closed either way (0)', () => {
  assert.equal(closedDelta('canceled', 'completed'), 0);
});

test('closedDelta: pending -> canceled crosses into closed (+1)', () => {
  assert.equal(closedDelta('pending', 'canceled'), 1);
});

test('closedDelta: pending -> in_progress, both open (0)', () => {
  assert.equal(closedDelta('pending', 'in_progress'), 0);
});

// ── applyChildStatusDelta ──

test('applyChildStatusDelta: null when delta is 0', () => {
  assert.equal(applyChildStatusDelta({ childrenCount: 3, completedChildrenCount: 1 }, 0), null);
});

test('applyChildStatusDelta: null when childrenCount is null (drill-down board, no total to move)', () => {
  assert.equal(applyChildStatusDelta({ childrenCount: null, completedChildrenCount: null }, 1), null);
});

test('applyChildStatusDelta: +1 moves completedChildrenCount up, treats null as 0', () => {
  assert.deepEqual(
    applyChildStatusDelta({ childrenCount: 3, completedChildrenCount: null }, 1),
    { childrenCount: 3, completedChildrenCount: 1 }
  );
});

test('applyChildStatusDelta: -1 moves completedChildrenCount down', () => {
  assert.deepEqual(
    applyChildStatusDelta({ childrenCount: 3, completedChildrenCount: 2 }, -1),
    { childrenCount: 3, completedChildrenCount: 1 }
  );
});

test('applyChildStatusDelta: clamps completedChildrenCount to [0, childrenCount]', () => {
  assert.deepEqual(
    applyChildStatusDelta({ childrenCount: 2, completedChildrenCount: 0 }, -1),
    { childrenCount: 2, completedChildrenCount: 0 }
  );
  assert.deepEqual(
    applyChildStatusDelta({ childrenCount: 2, completedChildrenCount: 2 }, 1),
    { childrenCount: 2, completedChildrenCount: 2 }
  );
});

// ── countChildProgress (C1461) — parent detail pane's live N/M on a drill-down board,
// counted from the children actually on screen (role-derived, C1187: complete OR canceled). ──

test('countChildProgress: empty list', () => {
  assert.deepEqual(countChildProgress([]), { total: 0, done: 0 });
});

test('countChildProgress: undefined/non-array input treated as empty', () => {
  assert.deepEqual(countChildProgress(undefined), { total: 0, done: 0 });
});

test('countChildProgress: all open', () => {
  const children = [{ status: 'pending' }, { status: 'in_progress' }, { status: 'on_fire' }];
  assert.deepEqual(countChildProgress(children), { total: 3, done: 0 });
});

test('countChildProgress: mixed open/closed', () => {
  const children = [{ status: 'pending' }, { status: 'completed' }, { status: 'in_progress' }, { status: 'canceled' }];
  assert.deepEqual(countChildProgress(children), { total: 4, done: 2 });
});

test('countChildProgress: canceled counts as done, same as completed (role, not literal name)', () => {
  const children = [{ status: 'canceled' }, { status: 'canceled' }];
  assert.deepEqual(countChildProgress(children), { total: 2, done: 2 });
});

test('countChildProgress: a custom-named closed status counts as done, role-derived not hardcoded', () => {
  seedStatuses([
    { name: 'todo', display_order: 0, is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'shipped', display_order: 1, is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false },
    { name: 'dropped', display_order: 2, is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: true },
  ]);
  try {
    const children = [{ status: 'todo' }, { status: 'shipped' }, { status: 'dropped' }];
    assert.deepEqual(countChildProgress(children), { total: 3, done: 2 });
  } finally {
    resetStatuses();
  }
});
