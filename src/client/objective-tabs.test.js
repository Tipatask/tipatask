import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_OBJECTIVE_TABS,
  truncateTabTitle,
  objectiveTabLabel,
  upsertObjectiveTab,
  removeObjectiveTab,
  isObjectiveTabDone,
  activeObjectiveTabKey,
  resolveObjectiveParent,
} from './objective-tabs.js';

// ── truncateTabTitle ──

test('truncateTabTitle: short title unchanged', () => {
  assert.equal(truncateTabTitle('Fix bug', 24), 'Fix bug');
});

test('truncateTabTitle: collapses internal whitespace', () => {
  assert.equal(truncateTabTitle('Fix   the   bug', 24), 'Fix the bug');
});

test('truncateTabTitle: exact boundary length stays intact', () => {
  assert.equal(truncateTabTitle('123456789012345678901234', 24), '123456789012345678901234');
});

test('truncateTabTitle: over budget gets ellipsis-truncated', () => {
  const result = truncateTabTitle('This title is definitely way too long for a nav tab', 24);
  assert.equal(result.length, 24);
  assert.ok(result.endsWith('…'));
});

test('truncateTabTitle: empty/null/undefined all collapse to empty string', () => {
  assert.equal(truncateTabTitle(''), '');
  assert.equal(truncateTabTitle(null), '');
  assert.equal(truncateTabTitle(undefined), '');
  assert.equal(truncateTabTitle('   '), '');
});

// ── objectiveTabLabel ──

test('objectiveTabLabel: formats as "key · title"', () => {
  assert.equal(objectiveTabLabel({ parentKey: 'C1465', title: 'Objective boards' }), 'C1465 · Objective boards');
});

// ── upsertObjectiveTab ──

test('upsertObjectiveTab: adds a new entry, returns true', () => {
  const tabs = [];
  const changed = upsertObjectiveTab(tabs, { parentKey: 'C1', title: 'First' });
  assert.equal(changed, true);
  assert.deepEqual(tabs, [{ parentKey: 'C1', parentDbId: null, title: 'First', childrenCount: null, completedChildrenCount: null }]);
});

test('upsertObjectiveTab: stores parentDbId when given', () => {
  const tabs = [];
  upsertObjectiveTab(tabs, { parentKey: 'C1', parentDbId: 42, title: 'First' });
  assert.equal(tabs[0].parentDbId, 42);
});

test('upsertObjectiveTab: identical re-upsert is a no-op, returns false', () => {
  const tabs = [{ parentKey: 'C1', parentDbId: null, title: 'First' }];
  const changed = upsertObjectiveTab(tabs, { parentKey: 'C1', title: 'First' });
  assert.equal(changed, false);
  assert.equal(tabs.length, 1);
});

test('upsertObjectiveTab: refreshes title in place when it changed, returns true', () => {
  const tabs = [{ parentKey: 'C1', parentDbId: null, title: 'Old title' }];
  const changed = upsertObjectiveTab(tabs, { parentKey: 'C1', title: 'New title' });
  assert.equal(changed, true);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].title, 'New title');
});

test('upsertObjectiveTab: no-op array/entry guards', () => {
  assert.equal(upsertObjectiveTab(null, { parentKey: 'C1' }), false);
  assert.equal(upsertObjectiveTab([], null), false);
  assert.equal(upsertObjectiveTab([], {}), false);
});

test('upsertObjectiveTab: sets counts on a new entry', () => {
  const tabs = [];
  upsertObjectiveTab(tabs, { parentKey: 'C1', title: 'First', childrenCount: 3, completedChildrenCount: 1 });
  assert.equal(tabs[0].childrenCount, 3);
  assert.equal(tabs[0].completedChildrenCount, 1);
});

test('upsertObjectiveTab: refreshes counts in place when they changed, returns true', () => {
  const tabs = [{ parentKey: 'C1', parentDbId: null, title: 'T', childrenCount: 3, completedChildrenCount: 1 }];
  const changed = upsertObjectiveTab(tabs, { parentKey: 'C1', title: 'T', childrenCount: 3, completedChildrenCount: 2 });
  assert.equal(changed, true);
  assert.equal(tabs[0].completedChildrenCount, 2);
});

test('upsertObjectiveTab: never clobbers a known count with an incoming null', () => {
  const tabs = [{ parentKey: 'C1', parentDbId: null, title: 'T', childrenCount: 3, completedChildrenCount: 1 }];
  const changed = upsertObjectiveTab(tabs, { parentKey: 'C1', title: 'T', childrenCount: null, completedChildrenCount: null });
  assert.equal(changed, false);
  assert.equal(tabs[0].childrenCount, 3);
  assert.equal(tabs[0].completedChildrenCount, 1);
});

// ── removeObjectiveTab ──

test('removeObjectiveTab: removes the matching entry, returns true', () => {
  const tabs = [{ parentKey: 'C1', title: 'A' }, { parentKey: 'C2', title: 'B' }];
  const changed = removeObjectiveTab(tabs, 'C1');
  assert.equal(changed, true);
  assert.deepEqual(tabs.map(t => t.parentKey), ['C2']);
});

test('removeObjectiveTab: no-op when parentKey is absent, returns false', () => {
  const tabs = [{ parentKey: 'C1', title: 'A' }];
  assert.equal(removeObjectiveTab(tabs, 'C9'), false);
  assert.equal(tabs.length, 1);
});

test('removeObjectiveTab: no-op array/key guards', () => {
  assert.equal(removeObjectiveTab(null, 'C1'), false);
  assert.equal(removeObjectiveTab([], null), false);
});

// ── isObjectiveTabDone ──

test('isObjectiveTabDone: true when completed count meets total', () => {
  assert.equal(isObjectiveTabDone({ childrenCount: 3, completedChildrenCount: 3 }), true);
});

test('isObjectiveTabDone: false when some children still open', () => {
  assert.equal(isObjectiveTabDone({ childrenCount: 3, completedChildrenCount: 2 }), false);
});

test('isObjectiveTabDone: false when counts are unknown (null)', () => {
  assert.equal(isObjectiveTabDone({ childrenCount: null, completedChildrenCount: null }), false);
});

test('isObjectiveTabDone: false for a childless entry (0/0 is not "done")', () => {
  assert.equal(isObjectiveTabDone({ childrenCount: 0, completedChildrenCount: 0 }), false);
});

test('upsertObjectiveTab: FIFO-evicts the oldest entry once max is exceeded', () => {
  const tabs = [];
  upsertObjectiveTab(tabs, { parentKey: 'C1', title: 'One' }, { max: 2 });
  upsertObjectiveTab(tabs, { parentKey: 'C2', title: 'Two' }, { max: 2 });
  upsertObjectiveTab(tabs, { parentKey: 'C3', title: 'Three' }, { max: 2 });
  assert.deepEqual(tabs.map(t => t.parentKey), ['C2', 'C3']);
});

test('upsertObjectiveTab: default max matches MAX_OBJECTIVE_TABS', () => {
  const tabs = [];
  for (let i = 0; i < MAX_OBJECTIVE_TABS + 2; i++) {
    upsertObjectiveTab(tabs, { parentKey: `C${i}`, title: `T${i}` });
  }
  assert.equal(tabs.length, MAX_OBJECTIVE_TABS);
});

// ── activeObjectiveTabKey ──

test('activeObjectiveTabKey: null when not on the board tab', () => {
  assert.equal(activeObjectiveTabKey({ activeTab: 'objective', subtaskStack: [{ taskKey: 'C1' }] }), null);
});

test('activeObjectiveTabKey: null when the stack is empty (root board)', () => {
  assert.equal(activeObjectiveTabKey({ activeTab: 'board', subtaskStack: [] }), null);
});

test('activeObjectiveTabKey: stack[0].taskKey on a 1-level drill-down', () => {
  assert.equal(activeObjectiveTabKey({ activeTab: 'board', subtaskStack: [{ taskKey: 'C1' }] }), 'C1');
});

test('activeObjectiveTabKey: keys off stack[0], not the top, on a nested drill-down (no objectiveTabs given)', () => {
  const stack = [{ taskKey: 'C1' }, { taskKey: 'C2' }];
  assert.equal(activeObjectiveTabKey({ activeTab: 'board', subtaskStack: stack }), 'C1');
});

// (TPT59) With the full ancestor chain reconstructed, stack[0] is the absolute root ancestor
// and need not be an objective with a tab at all — activeObjectiveTabKey() must instead find
// the OUTERMOST stack entry that actually has a tab.

test('activeObjectiveTabKey: with objectiveTabs, matches the outermost tabbed ancestor, not stack[0]', () => {
  const stack = [{ taskKey: 'C1' }, { taskKey: 'C2' }, { taskKey: 'C3' }];
  const tabs = [{ parentKey: 'C2', title: 'Nested objective' }];
  assert.equal(
    activeObjectiveTabKey({ activeTab: 'board', subtaskStack: stack, objectiveTabs: tabs }),
    'C2',
    'C1 (root) has no tab; C2 does — the outer tabbed ancestor must light up, not none'
  );
});

test('activeObjectiveTabKey: with objectiveTabs, falls back to stack[0] when no stack entry has a tab', () => {
  const stack = [{ taskKey: 'C1' }, { taskKey: 'C2' }];
  const tabs = [{ parentKey: 'C9', title: 'Unrelated objective' }];
  assert.equal(activeObjectiveTabKey({ activeTab: 'board', subtaskStack: stack, objectiveTabs: tabs }), 'C1');
});

test('activeObjectiveTabKey: an empty objectiveTabs array falls back to stack[0] (pre-TPT59 behavior)', () => {
  const stack = [{ taskKey: 'C1' }, { taskKey: 'C2' }];
  assert.equal(activeObjectiveTabKey({ activeTab: 'board', subtaskStack: stack, objectiveTabs: [] }), 'C1');
});

// ── resolveObjectiveParent ──

test('resolveObjectiveParent: null when parentDbId is null/undefined', () => {
  assert.equal(resolveObjectiveParent(null, {}), null);
  assert.equal(resolveObjectiveParent(undefined, {}), null);
});

test('resolveObjectiveParent: resolves via tasksByDbId', () => {
  const tasksByDbId = new Map([['42', { id: 'C1465', title: 'Objective boards' }]]);
  const result = resolveObjectiveParent(42, { tasksByDbId });
  assert.deepEqual(result, { parentKey: 'C1465', parentDbId: 42, title: 'Objective boards', childrenCount: null, completedChildrenCount: null });
});

test('resolveObjectiveParent: carries childrenCount/completedChildrenCount off the resolved row', () => {
  const tasksByDbId = new Map([['42', { id: 'C1465', title: 'Objective boards', childrenCount: 3, completedChildrenCount: 1 }]]);
  const result = resolveObjectiveParent(42, { tasksByDbId });
  assert.equal(result.childrenCount, 3);
  assert.equal(result.completedChildrenCount, 1);
});

test('resolveObjectiveParent: resolves via a matching parentTask fallback', () => {
  const parentTask = { dbId: 42, id: 'C1465', title: 'Objective boards' };
  const result = resolveObjectiveParent(42, { tasksByDbId: new Map(), parentTask });
  assert.deepEqual(result, { parentKey: 'C1465', parentDbId: 42, title: 'Objective boards', childrenCount: null, completedChildrenCount: null });
});

test('resolveObjectiveParent: rejects a parentTask whose dbId does not match — never mislabels', () => {
  const parentTask = { dbId: 99, id: 'C9999', title: 'Wrong objective' };
  const result = resolveObjectiveParent(42, { tasksByDbId: new Map(), parentTask });
  assert.equal(result, null);
});

test('resolveObjectiveParent: prefers tasksByDbId over a non-matching parentTask', () => {
  const parentTask = { dbId: 99, id: 'C9999', title: 'Wrong objective' };
  const tasksByDbId = new Map([['42', { id: 'C1465', title: 'Objective boards' }]]);
  const result = resolveObjectiveParent(42, { tasksByDbId, parentTask });
  assert.equal(result.parentKey, 'C1465');
});

test('resolveObjectiveParent: null when unresolvable in either source', () => {
  assert.equal(resolveObjectiveParent(42, { tasksByDbId: new Map() }), null);
});
