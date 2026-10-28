'use strict';

// (TPT9162) selectNextCowboyTasks(): the pure next-task rule of a cowboy chain — every qualifying
// direct dependent, else exactly one startable task of the same sprint. See
// ai/architecture/tt-claude-session-terminal.md § Cowboy chains.

const test = require('node:test');
const assert = require('node:assert/strict');
const { rolesFromStatuses } = require('./status-roles');
const { selectNextCowboyTasks, chainKickoffPrompt, chainLaunchAgent, effectivePermissionMode, KICKOFF_DESC_MAX } = require('./cowboy-next');

// Renamed statuses on purpose: closed and not-started come from the role flags, never the names.
const ROLES = rolesFromStatuses([
  { name: 'Todo', is_workflow_start: true },
  { name: 'Doing', is_in_progress: true },
  { name: 'Done', is_workflow_complete: true },
  { name: 'Dropped', is_workflow_canceled: true },
  { name: 'on_fire' },
  { name: 'completed' },
]);

let order = 0;
function task(id, fields = {}) {
  return {
    id, title: `Task ${id}`, description: '', status: 'Todo', category: 'CODING', priority: 7, order: order++,
    dependencies: [], assignee: 1, agentAssignee: 'claude', agentPermissionMode: 'bypass',
    isObjective: false, isReservation: false, ...fields,
  };
}

const FINISHED = task('T1', { status: 'Done' });
const select = (tasks, opts = {}) => selectNextCowboyTasks(FINISHED, [FINISHED, ...tasks], { statusRoles: ROLES, projectMode: 'auto', currentUserId: 1, ...opts });
const keys = result => result.tasks.map(t => t.id);

test('every qualifying direct dependent starts, in board order, and the same-sprint fallback stays out', () => {
  const result = select([
    task('T4', { dependencies: ['T1'], priority: 9, order: 1 }),
    task('T2', { dependencies: ['T1'], priority: 8, order: 5 }),
    task('T3', { dependencies: ['T1', 'T9'], priority: 8, order: 2 }),
    task('T9', { status: 'Dropped' }), // canceled counts as closed
    task('T5'), // same sprint, independent — only for the fallback
  ]);
  assert.equal(result.reason, 'dependents');
  assert.deepEqual(keys(result), ['T3', 'T2', 'T4']);
});

test('a dependent with another unresolved dependency is skipped; nothing qualifying falls back to the sprint', () => {
  const blocker = task('T8', { status: 'Doing' });
  const dependent = task('T2', { dependencies: ['T1', 'T8'] });
  const ready = task('T3', { dependencies: ['T1', 'T7'] });
  const done = task('T7', { status: 'Done' });
  assert.deepEqual(keys(select([blocker, dependent, ready, done])), ['T3']);
  // A dependency missing from the list is unresolved; a literal "completed" is not the complete role here.
  const missing = task('T2', { dependencies: ['T1', 'T404'] });
  const literal = task('T3', { dependencies: ['T1', 'T6'] });
  const result = select([missing, literal, task('T6', { status: 'completed' })]);
  assert.deepEqual(keys(result), [], 'neither dependent qualifies and the sprint has no other startable task');
  assert.equal(result.reason, 'none');
  const fallback = select([blocker, dependent, task('T5', { order: 50 })]);
  assert.equal(fallback.reason, 'sprint');
  assert.deepEqual(keys(fallback), ['T5']);
});

test('the same-sprint fallback returns exactly one task: lowest display order, then key', () => {
  const result = select([
    task('T12', { order: 30 }),
    task('T10', { order: 4 }),
    task('T11', { order: 4 }),
    task('T2', { order: 1, priority: 8 }), // another sprint
    task('T3', { order: 0, priority: 0 }), // backlog
    task('T4', { order: 2, dependencies: ['T8'] }), // blocked
    task('T8', { status: 'Doing', priority: 3 }),
  ]);
  assert.equal(result.reason, 'sprint');
  assert.deepEqual(keys(result), ['T10']);
  // A finished backlog task has no sprint to fall back on.
  const backlog = selectNextCowboyTasks({ ...FINISHED, priority: 0 }, [task('T5', { priority: 0 })],
    { statusRoles: ROLES, projectMode: 'bypass' });
  assert.deepEqual(backlog, { tasks: [], reason: 'none' });
});

test('a task whose effective mode is not bypass is skipped — its own override first, else the project default', () => {
  const inherited = task('T2', { dependencies: ['T1'], agentPermissionMode: null });
  const auto = task('T3', { dependencies: ['T1'], agentPermissionMode: 'auto' });
  const legacy = task('T4', { dependencies: ['T1'], agentPermissionMode: 'accept_edits' });
  const unknown = task('T5', { dependencies: ['T1'], agentPermissionMode: 'yolo' });
  const bypass = task('T6', { dependencies: ['T1'] });
  assert.deepEqual(keys(select([inherited, auto, legacy, unknown, bypass], { projectMode: 'auto' })), ['T6']);
  assert.deepEqual(keys(select([inherited, auto, legacy, unknown, bypass], { projectMode: 'bypass' })), ['T2', 'T6'],
    'an unknown override never inherits the project bypass');
  assert.deepEqual(keys(select([inherited], { projectMode: null })), [], 'an unknown project default never qualifies');
  assert.equal(effectivePermissionMode({ agent_permission_mode: 'bypass' }, 'plan'), 'bypass');
  assert.equal(effectivePermissionMode({ agentPermissionMode: null }, 'bypass'), 'bypass');
});

test('the start checks: not-started or urgent status, CODING, no objective or placeholder, agent work, own task, no live session', () => {
  const dep = fields => task(fields.id, { dependencies: ['T1'], ...fields });
  const result = select([
    dep({ id: 'T2' }),
    dep({ id: 'T3', status: 'on_fire' }),
    dep({ id: 'T4', status: 'Doing' }),
    dep({ id: 'T5', status: 'Done' }),
    dep({ id: 'T6', category: 'HUMAN' }),
    dep({ id: 'T7', isObjective: true }),
    dep({ id: 'T8', isReservation: true }),
    dep({ id: 'T9', agentAssignee: 'human' }),
    dep({ id: 'T10', assignee: 2 }),
    dep({ id: 'T11', assignee: null, agentAssignee: null }),
    dep({ id: 'T12' }),
  ], { liveTaskIds: new Set(['T12']) });
  assert.deepEqual(keys(result), ['T2', 'T3', 'T11']);
  assert.deepEqual(keys(select([dep({ id: 'T10', assignee: 2 })], { currentUserId: null })), ['T10'],
    'an unknown current user leaves the assignee check to the start gate');
});

test('an empty result when nothing can start, and on missing input', () => {
  assert.deepEqual(select([task('T2', { status: 'Doing' }), task('T3', { category: 'HUMAN' })]), { tasks: [], reason: 'none' });
  assert.deepEqual(select([]), { tasks: [], reason: 'none' });
  assert.deepEqual(selectNextCowboyTasks(null, [task('T2')], { statusRoles: ROLES }), { tasks: [], reason: 'none' });
  assert.deepEqual(selectNextCowboyTasks(FINISHED, null, { statusRoles: ROLES }), { tasks: [], reason: 'none' });
  assert.deepEqual(selectNextCowboyTasks(FINISHED, [task('T2', { dependencies: ['T1'] })], {}), { tasks: [], reason: 'none' });
});

test('a chained start sends the Start kickoff and asks for the task\'s own agent', () => {
  assert.equal(chainKickoffPrompt({ id: 'T2', title: 'Fix it', description: 'Steps.' }), 'Work on task T2: Fix it. Steps.');
  assert.equal(chainKickoffPrompt({ id: 'T2', title: '', description: '' }), 'Work on task T2: T2. ');
  const long = chainKickoffPrompt({ id: 'T2', title: 'Long', description: 'x'.repeat(KICKOFF_DESC_MAX + 10) });
  assert.ok(long.endsWith(`${'x'.repeat(10)}... (truncated)`));
  assert.equal(long.length, 'Work on task T2: Long. '.length + KICKOFF_DESC_MAX + '... (truncated)'.length);
  assert.deepEqual(['claude', 'codex', 'pi', 'human', null].map(agentAssignee => chainLaunchAgent({ agentAssignee })),
    ['claude', 'codex', 'pi', null, null]);
});
