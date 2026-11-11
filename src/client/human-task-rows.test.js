import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { humanInProgressRows, humanTaskWritePatch, keepHumanTaskEntries, knownHumanTaskIds } from './human-task-rows.js';
import { resetStatuses, seedStatuses } from './status-registry.js';

// (TPT9201) The left nav's human section: which tasks get a row, and what a write means for them.
function boardState(tasks, overrides = {}) {
  return {
    taskStatusById: new Map(tasks.map(t => [t.id, t.status])),
    taskCategoryById: new Map(tasks.map(t => [t.id, t.category ?? 'HUMAN'])),
    taskTitleById: new Map(tasks.map(t => [t.id, t.title ?? `Title of ${t.id}`])),
    taskAssigneeById: new Map(tasks.map(t => [t.id, t.assignee ?? null])),
    activeSessions: new Set(),
    lostSessions: new Map(),
    currentUserId: 7,
    ...overrides,
  };
}
const ids = rows => rows.map(row => row.taskId);

afterEach(() => resetStatuses());

test('a row needs the HUMAN category and the in-progress status together', () => {
  seedStatuses([
    { name: 'pending', is_workflow_start: true },
    { name: 'in_progress', is_in_progress: true },
    { name: 'on_fire' },
    { name: 'completed', is_workflow_complete: true },
    { name: 'canceled', is_workflow_canceled: true },
  ]);
  const s = boardState([
    { id: 'TPT1', status: 'in_progress' },
    { id: 'TPT2', status: 'pending' },
    { id: 'TPT3', status: 'on_fire' },
    { id: 'TPT4', status: 'completed' },
    { id: 'TPT5', status: 'canceled' },
    { id: 'TPT6', status: 'in_progress', category: 'CODING' },
  ]);
  assert.deepEqual(ids(humanInProgressRows(s)), ['TPT1']);
});

test('a custom in-progress name counts; the literal default name does not', () => {
  seedStatuses([
    { name: 'Todo', is_workflow_start: true },
    { name: 'Doing', is_in_progress: true },
    { name: 'in_progress' }, // a plain status here, with no role
    { name: 'Shipped', is_workflow_complete: true },
  ]);
  const s = boardState([
    { id: 'TPT1', status: 'Doing' },
    { id: 'TPT2', status: 'in_progress' },
  ]);
  assert.deepEqual(ids(humanInProgressRows(s)), ['TPT1']);
});

test('closing a task takes its row away, and reopening it brings the row back', () => {
  seedStatuses([
    { name: 'Doing', is_in_progress: true },
    { name: 'Shipped', is_workflow_complete: true },
    { name: 'Dropped', is_workflow_canceled: true },
  ]);
  const s = boardState([{ id: 'TPT1', status: 'Doing' }]);
  assert.deepEqual(ids(humanInProgressRows(s)), ['TPT1']);
  for (const closed of ['Shipped', 'Dropped']) {
    s.taskStatusById.set('TPT1', closed);
    assert.deepEqual(humanInProgressRows(s), [], `${closed} leaves no row`);
  }
  s.taskStatusById.set('TPT1', 'Doing');
  assert.deepEqual(ids(humanInProgressRows(s)), ['TPT1']);
});

test('a project with no in-progress role has no rows', () => {
  seedStatuses([{ name: 'Open', is_workflow_start: true }]);
  const s = boardState([{ id: 'TPT1', status: 'Open' }, { id: 'TPT2', status: undefined }]);
  assert.deepEqual(humanInProgressRows(s), []);
});

test('a task with a live or lost session stays in the agent section only', () => {
  const s = boardState([
    { id: 'TPT1', status: 'in_progress' },
    { id: 'TPT2', status: 'in_progress' },
    { id: 'TPT3', status: 'in_progress' },
  ], { activeSessions: new Set(['TPT1']), lostSessions: new Map([['TPT2', { reason: 'x' }]]) });
  assert.deepEqual(ids(humanInProgressRows(s)), ['TPT3']);
});

test('rows sort by task key, numerically within a prefix', () => {
  const s = boardState(['TPT100', 'TPT9', 'C12', 'TPT10'].map(id => ({ id, status: 'in_progress' })));
  assert.deepEqual(ids(humanInProgressRows(s)), ['C12', 'TPT9', 'TPT10', 'TPT100']);
});

test('the All Tasks scope cannot put a teammate\'s task in my section', () => {
  const s = boardState([
    { id: 'TPT1', status: 'in_progress', assignee: 7 },
    { id: 'TPT2', status: 'in_progress', assignee: 8 },
    { id: 'TPT3', status: 'in_progress', assignee: null },
    { id: 'TPT4', status: 'in_progress', assignee: '7' },
  ]);
  assert.deepEqual(ids(humanInProgressRows(s)), ['TPT1', 'TPT3', 'TPT4'], 'mine and unassigned, as the scoped board');
  s.currentUserId = null;
  assert.deepEqual(ids(humanInProgressRows(s)), ['TPT1', 'TPT2', 'TPT3', 'TPT4'], 'unknown user fails open');
});

test('each row carries its title and whether its workspace is the open one', () => {
  const s = boardState([
    { id: 'TPT1', status: 'in_progress', title: 'Call the bank' },
    { id: 'TPT2', status: 'in_progress', title: '' },
  ]);
  assert.deepEqual(humanInProgressRows(s, 'TPT2'), [
    { taskId: 'TPT1', title: 'Call the bank', isOpen: false },
    { taskId: 'TPT2', title: '', isOpen: true },
  ]);
  assert.equal(humanInProgressRows(s).some(row => row.isOpen), false);
});

test('knownHumanTaskIds lists HUMAN tasks in every status', () => {
  const categories = new Map([['TPT1', 'HUMAN'], ['TPT2', 'CODING'], ['TPT3', 'HUMAN']]);
  assert.deepEqual(knownHumanTaskIds(categories), ['TPT1', 'TPT3']);
});

test('a drill-down keeps the human tasks its fetch omits, and nothing else', () => {
  const prev = boardState([
    { id: 'TPT1', status: 'in_progress', title: 'Sign the lease', assignee: 7 },
    { id: 'TPT2', status: 'in_progress', category: 'CODING' },
    { id: 'TPT3', status: 'pending' },
  ]);
  const next = boardState([{ id: 'TPT9', status: 'pending', category: 'CODING' }]);
  keepHumanTaskEntries(next, prev);
  assert.deepEqual([...next.taskCategoryById.keys()], ['TPT9', 'TPT1', 'TPT3']);
  assert.equal(next.taskStatusById.get('TPT1'), 'in_progress');
  assert.equal(next.taskTitleById.get('TPT1'), 'Sign the lease');
  assert.equal(next.taskAssigneeById.get('TPT1'), 7);
  assert.equal(next.taskStatusById.has('TPT2'), false, 'a CODING task stays out of the narrow map');
  assert.deepEqual(ids(humanInProgressRows(next)), ['TPT1']);
});

test('a drill-down row in the fetch wins over the outgoing entry', () => {
  const prev = boardState([{ id: 'TPT1', status: 'in_progress', title: 'Old title', assignee: 7 }]);
  const next = boardState([{ id: 'TPT1', status: 'completed', title: 'New title', assignee: 8, category: 'CODING' }]);
  keepHumanTaskEntries(next, prev);
  assert.equal(next.taskStatusById.get('TPT1'), 'completed');
  assert.equal(next.taskTitleById.get('TPT1'), 'New title');
  assert.equal(next.taskAssigneeById.get('TPT1'), 8);
  assert.equal(next.taskCategoryById.get('TPT1'), 'CODING');
});

test('a human task with a session keeps the status the session backfill gave it', () => {
  const prev = boardState([{ id: 'TPT1', status: 'in_progress' }]);
  const next = boardState([]);
  next.taskStatusById.set('TPT1', 'completed');
  keepHumanTaskEntries(next, prev);
  assert.equal(next.taskStatusById.get('TPT1'), 'completed');
});

test('a write patch carries the row fields of a HUMAN task and drops transport extras', () => {
  const saved = {
    id: 'TPT1', category: 'HUMAN', status: 'in_progress', title: 'Call', assignee: 7,
    description: 'long text', _pendingSync: true, parentRescheduled: { key: 'TPT0' },
  };
  assert.deepEqual(humanTaskWritePatch(saved, new Map()), {
    id: 'TPT1', category: 'HUMAN', status: 'in_progress', title: 'Call', assignee: 7,
  });
});

test('a partial write of a known HUMAN task patches what it has', () => {
  const categories = new Map([['TPT1', 'HUMAN']]);
  assert.deepEqual(humanTaskWritePatch({ id: 'TPT1', status: 'completed' }, categories), { id: 'TPT1', status: 'completed' });
  assert.deepEqual(humanTaskWritePatch({ id: 'TPT1', assignee: null }, categories), { id: 'TPT1', assignee: null });
});

test('a category flip in either direction reaches the rail', () => {
  assert.equal(humanTaskWritePatch({ id: 'TPT1', category: 'HUMAN' }, new Map([['TPT1', 'CODING']])).category, 'HUMAN');
  assert.equal(humanTaskWritePatch({ id: 'TPT1', category: 'CODING' }, new Map([['TPT1', 'HUMAN']])).category, 'CODING');
});

test('a CODING write and an empty result stay out of the rail path', () => {
  const categories = new Map([['TPT1', 'CODING']]);
  assert.equal(humanTaskWritePatch({ id: 'TPT1', status: 'completed' }, categories), null);
  assert.equal(humanTaskWritePatch({ id: 'TPT2', category: 'CODING', order: 3 }, categories), null);
  assert.equal(humanTaskWritePatch({ id: 'TPT3', order: 3 }, categories), null, 'unknown task, no category');
  assert.equal(humanTaskWritePatch(null, categories), null);
  assert.equal(humanTaskWritePatch({}, categories), null);
});
