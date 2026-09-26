import assert from 'node:assert/strict';
import { test } from 'node:test';

const { taskHasNullSprint, tasksForActiveTab, taskHiddenByGrouping, tasksVisibleUnderGrouping } = await import('./board-count-domain.js');

// ── taskHasNullSprint ──

test('taskHasNullSprint: priority 0 is backlog', () => {
  assert.equal(taskHasNullSprint({ priority: 0 }), true);
});

test('taskHasNullSprint: sprint_id/sprintId explicitly null is backlog, even with a priority', () => {
  assert.equal(taskHasNullSprint({ priority: 3, sprint_id: null }), true);
  assert.equal(taskHasNullSprint({ priority: 3, sprintId: null }), true);
});

test('taskHasNullSprint: a real sprint priority is not backlog', () => {
  assert.equal(taskHasNullSprint({ priority: 5 }), false);
});

test('taskHasNullSprint: missing/empty priority is not treated as backlog by itself', () => {
  assert.equal(taskHasNullSprint({}), false);
  assert.equal(taskHasNullSprint({ priority: '' }), false);
  assert.equal(taskHasNullSprint({ priority: undefined }), false);
});

test('taskHasNullSprint: string "0" priority counts as backlog (Number coercion)', () => {
  assert.equal(taskHasNullSprint({ priority: '0' }), true);
});

// ── tasksForActiveTab ──

const rows = [
  { id: 'C1', priority: 5 },   // sprinted
  { id: 'C2', priority: 0 },   // backlog
  { id: 'C3', priority: 0 },   // backlog
  { id: 'C4', priority: 3 },   // sprinted
];

test('tasksForActiveTab: board tab, sprints enabled — excludes backlog', () => {
  const out = tasksForActiveTab(rows, { tab: 'board', sprintsEnabled: true });
  assert.deepEqual(out.map(t => t.id), ['C1', 'C4']);
});

test('tasksForActiveTab: board tab, sprints DISABLED (flat board) — backlog stays merged in', () => {
  const out = tasksForActiveTab(rows, { tab: 'board', sprintsEnabled: false });
  assert.deepEqual(out.map(t => t.id), ['C1', 'C2', 'C3', 'C4']);
});

test('tasksForActiveTab: list tab — excludes backlog', () => {
  const out = tasksForActiveTab(rows, { tab: 'list', sprintsEnabled: true });
  assert.deepEqual(out.map(t => t.id), ['C1', 'C4']);
});

test('tasksForActiveTab: todo tab — excludes backlog', () => {
  const out = tasksForActiveTab(rows, { tab: 'todo', sprintsEnabled: true });
  assert.deepEqual(out.map(t => t.id), ['C1', 'C4']);
});

test('tasksForActiveTab: backlog tab — ONLY backlog', () => {
  const out = tasksForActiveTab(rows, { tab: 'backlog', sprintsEnabled: true });
  assert.deepEqual(out.map(t => t.id), ['C2', 'C3']);
});

test('tasksForActiveTab: backlog tab still applies even with sprints disabled', () => {
  const out = tasksForActiveTab(rows, { tab: 'backlog', sprintsEnabled: false });
  assert.deepEqual(out.map(t => t.id), ['C2', 'C3']);
});

test('tasksForActiveTab: other tabs (new_task/objective) pass every row through unchanged', () => {
  assert.deepEqual(tasksForActiveTab(rows, { tab: 'new_task', sprintsEnabled: true }).map(t => t.id), ['C1', 'C2', 'C3', 'C4']);
  assert.deepEqual(tasksForActiveTab(rows, { tab: 'objective', sprintsEnabled: true }).map(t => t.id), ['C1', 'C2', 'C3', 'C4']);
});

test('tasksForActiveTab: non-array input does not throw, returns []', () => {
  assert.deepEqual(tasksForActiveTab(null, { tab: 'board', sprintsEnabled: true }), []);
  assert.deepEqual(tasksForActiveTab(undefined, { tab: 'backlog' }), []);
});

// ── C1442 regression: the exact production scenario ──
// One unassigned task, backlog-only (priority 0). Board/List/To-Do must NOT count it;
// Backlog must.
test('tasksForActiveTab: C1442 regression — sole unassigned backlog task excluded from board/list/todo domains, included in backlog domain', () => {
  const liveRows = [
    { id: 'TIPA-1', priority: 0, assignee: null, status: 'pending' },
    { id: 'C10', priority: 226, assignee: 1, status: 'in_progress' },
  ];
  const boardDomain = tasksForActiveTab(liveRows, { tab: 'board', sprintsEnabled: true });
  assert.equal(boardDomain.some(t => t.id === 'TIPA-1'), false);
  const backlogDomain = tasksForActiveTab(liveRows, { tab: 'backlog', sprintsEnabled: true });
  assert.equal(backlogDomain.some(t => t.id === 'TIPA-1'), true);
});

// ── taskHiddenByGrouping / tasksVisibleUnderGrouping (C1460) ──

test('grouping ON: a child whose parent is present in the fetch is hidden', () => {
  const parent = { id: 'C1', dbId: 1, isObjective: true, hasChildren: true };
  const child = { id: 'C2', dbId: 2, parentDbId: 1 };
  const out = tasksVisibleUnderGrouping([parent, child], { objectiveGrouping: true, drilldown: false });
  assert.deepEqual(out.map(t => t.id), ['C1']);
});

test('a promoted split origin follows the project objective-grouping toggle', () => {
  const origin = { id: 'TPT42', dbId: 42, isObjective: true, hasChildren: true };
  const children = [
    { id: 'TPT43', dbId: 43, parentDbId: 42 },
    { id: 'TPT44', dbId: 44, parentDbId: 42 },
  ];
  const tasks = [origin, ...children];
  assert.deepEqual(tasksVisibleUnderGrouping(tasks, { objectiveGrouping: true, drilldown: false }).map(t => t.id), ['TPT42']);
  assert.deepEqual(tasksVisibleUnderGrouping(tasks, { objectiveGrouping: false, drilldown: false }).map(t => t.id), ['TPT43', 'TPT44']);
});

test('grouping ON: an orphan child (parent not in this fetch) stays visible', () => {
  // e.g. parent owned by a teammate and filtered out by assignee scoping, or fell out of the
  // sprint window — the child must not become unreachable.
  const child = { id: 'C2', dbId: 2, parentDbId: 999 };
  const root = { id: 'C3', dbId: 3 };
  const out = tasksVisibleUnderGrouping([child, root], { objectiveGrouping: true, drilldown: false });
  assert.deepEqual(out.map(t => t.id).sort(), ['C2', 'C3']);
});

test('grouping ON: objective parents and plain root tasks are kept', () => {
  const parent = { id: 'C1', dbId: 1, isObjective: true, hasChildren: true };
  const plain = { id: 'C2', dbId: 2 };
  const out = tasksVisibleUnderGrouping([parent, plain], { objectiveGrouping: true, drilldown: false });
  assert.deepEqual(out.map(t => t.id).sort(), ['C1', 'C2']);
});

test('grouping ON: a nested objective (child that is itself a parent) hides along with its own children', () => {
  const a = { id: 'A', dbId: 1, isObjective: true, hasChildren: true };
  const b = { id: 'B', dbId: 2, parentDbId: 1, isObjective: true, hasChildren: true }; // child of A, itself a parent
  const c = { id: 'C', dbId: 3, parentDbId: 2 }; // child of B
  const out = tasksVisibleUnderGrouping([a, b, c], { objectiveGrouping: true, drilldown: false });
  assert.deepEqual(out.map(t => t.id), ['A']);
});

test('grouping OFF: an objective parent WITH children is hidden, the children render as plain tasks', () => {
  const parent = { id: 'C1', dbId: 1, isObjective: true, hasChildren: true };
  const child = { id: 'C2', dbId: 2, parentDbId: 1 };
  const out = tasksVisibleUnderGrouping([parent, child], { objectiveGrouping: false, drilldown: false });
  assert.deepEqual(out.map(t => t.id), ['C2']);
});

test('grouping OFF: a CHILDLESS objective row stays visible (C1559 — web-created, subtasks not generated yet)', () => {
  const parent = { id: 'C1', dbId: 1, isObjective: true, hasChildren: false };
  const out = tasksVisibleUnderGrouping([parent], { objectiveGrouping: false, drilldown: false });
  assert.deepEqual(out.map(t => t.id), ['C1']);
});

test('grouping OFF: plain root tasks are unaffected', () => {
  const plain = { id: 'C2', dbId: 2 };
  const out = tasksVisibleUnderGrouping([plain], { objectiveGrouping: false, drilldown: false });
  assert.deepEqual(out.map(t => t.id), ['C2']);
});

test('drilldown: true returns every row untouched regardless of grouping flag', () => {
  // Mirrors a real getChildren() payload — rows carry parentDbId even though this IS the
  // board being rendered (the drill-down board), so grouping must never filter here.
  const rows = [
    { id: 'C2', dbId: 2, parentDbId: 1 },
    { id: 'C3', dbId: 3, parentDbId: 1, isObjective: true, hasChildren: true },
  ];
  assert.deepEqual(tasksVisibleUnderGrouping(rows, { objectiveGrouping: true, drilldown: true }).map(t => t.id), ['C2', 'C3']);
  assert.deepEqual(tasksVisibleUnderGrouping(rows, { objectiveGrouping: false, drilldown: true }).map(t => t.id), ['C2', 'C3']);
});

test('tasksVisibleUnderGrouping: non-array input does not throw, returns []', () => {
  assert.deepEqual(tasksVisibleUnderGrouping(null, { objectiveGrouping: true }), []);
  assert.deepEqual(tasksVisibleUnderGrouping(undefined, { objectiveGrouping: false }), []);
});

test('taskHiddenByGrouping: legacy string parentId still hides under grouping ON (defence-in-depth)', () => {
  assert.equal(taskHiddenByGrouping({ parentId: 'C1' }, { objectiveGrouping: true, presentDbIds: new Set() }), true);
  assert.equal(taskHiddenByGrouping({ parentId: 'C1' }, { objectiveGrouping: false, presentDbIds: new Set() }), false);
});
