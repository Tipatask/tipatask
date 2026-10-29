'use strict';

// (TPT9162) selectNextCowboyTasks(): the pure next-task rule of a cowboy chain — every qualifying
// direct dependent, else exactly one startable task of the same sprint — and (TPT9193) the skip
// reason of every candidate that does not qualify. See
// ai/architecture/tt-claude-session-terminal.md § Cowboy chains.

const test = require('node:test');
const assert = require('node:assert/strict');
const { rolesFromStatuses } = require('./status-roles');
const { selectNextCowboyTasks, chainKickoffPrompt, chainInheritance, chainPickFields, chainLaunchAgent, effectivePermissionMode, KICKOFF_DESC_MAX, SKIP_REASONS } = require('./cowboy-next');

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
    dependencies: [], assignee: 1, agentAssignee: 'claude', agentPermissionMode: null,
    isObjective: false, isReservation: false, ...fields,
  };
}

const FINISHED = task('T1', { status: 'Done', agentPermissionMode: 'bypass' });
const select = (tasks, opts = {}) => selectNextCowboyTasks(FINISHED, [FINISHED, ...tasks], { statusRoles: ROLES, currentUserId: 1, ...opts });
const keys = result => result.tasks.map(t => t.id);

test('every qualifying direct dependent starts, in board order, and the same-sprint fallback stays out', () => {
  const result = select([
    task('T4', { dependencies: ['T1'], priority: 9, order: 1 }),
    task('T2', { dependencies: ['T1'], priority: 8, order: 5 }),
    task('T3', { dependencies: ['T1', 'T9'], priority: 8, order: 2 }),
    task('T9', { status: 'Dropped' }), // canceled counts as closed
    task('T5', { status: 'Doing' }), // same sprint — only judged by the fallback
  ]);
  assert.equal(result.reason, 'dependents');
  assert.deepEqual(keys(result), ['T3', 'T2', 'T4']);
  assert.deepEqual(result.skipped, [], 'the sprint is not judged while a dependent qualifies');
});

test('a dependent with another unresolved dependency is skipped; nothing qualifying falls back to the sprint', () => {
  const blocker = task('T8', { status: 'Doing' });
  const dependent = task('T2', { dependencies: ['T1', 'T8'] });
  const ready = task('T3', { dependencies: ['T1', 'T7'] });
  const done = task('T7', { status: 'Done' });
  const first = select([blocker, dependent, ready, done]);
  assert.deepEqual(keys(first), ['T3']);
  assert.deepEqual(first.skipped, [{ key: 'T2', reason: 'deps_open' }]);
  // A dependency missing from the list is unresolved; a literal "completed" is not the complete role here.
  const missing = task('T2', { dependencies: ['T1', 'T404'] });
  const literal = task('T3', { dependencies: ['T1', 'T6'] });
  const result = select([missing, literal, task('T6', { status: 'completed' })]);
  assert.deepEqual(keys(result), [], 'neither dependent qualifies and the sprint has no other startable task');
  assert.equal(result.reason, 'none');
  assert.deepEqual(result.skipped, [
    { key: 'T2', reason: 'deps_open' },
    { key: 'T3', reason: 'deps_open' },
    { key: 'T6', reason: 'status' },
  ]);
  const fallback = select([blocker, dependent, task('T5', { order: 50 })]);
  assert.equal(fallback.reason, 'sprint');
  assert.deepEqual(keys(fallback), ['T5']);
  assert.deepEqual(fallback.skipped, [{ key: 'T2', reason: 'deps_open' }, { key: 'T8', reason: 'status' }]);
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
  assert.deepEqual(result.skipped, [{ key: 'T4', reason: 'deps_open' }],
    'other sprints and the backlog are no candidates; the startable tasks after the pick are not skips');
  // A finished backlog task has no sprint to fall back on.
  const backlog = selectNextCowboyTasks({ ...FINISHED, priority: 0 }, [task('T5', { priority: 0 })], { statusRoles: ROLES });
  assert.deepEqual(backlog, { tasks: [], reason: 'none', skipped: [] });
});

// (TPT9193) A Bypass cowboy task whose only dependent had no override under an Auto project default
// started nothing: the candidate's own mode is no start check any more.
test('a candidate\'s own permission mode is not checked: a dependent with no override under a non-bypass project default qualifies', () => {
  const inherited = task('T2', { dependencies: ['T1'], agentPermissionMode: null, agentAssignee: null });
  const auto = task('T3', { dependencies: ['T1'], agentPermissionMode: 'auto' });
  const plan = task('T4', { dependencies: ['T1'], agentPermissionMode: 'plan' });
  const legacy = task('T5', { dependencies: ['T1'], agentPermissionMode: 'accept_edits' });
  const unknown = task('T6', { dependencies: ['T1'], agentPermissionMode: 'yolo' });
  for (const projectMode of ['auto', 'plan', null]) {
    const result = select([inherited, auto, plan, legacy, unknown], { projectMode });
    assert.equal(result.reason, 'dependents', String(projectMode));
    assert.deepEqual(keys(result), ['T2', 'T3', 'T4', 'T5', 'T6'], String(projectMode));
    assert.deepEqual(result.skipped, []);
  }
  const fallback = select([task('T7', { agentPermissionMode: 'auto' })], { projectMode: 'auto' });
  assert.deepEqual([fallback.reason, keys(fallback)], ['sprint', ['T7']], 'the sprint fallback does not check it either');
  // The finished task's own gate (terminal-session.js launchCowboyChain()) still reads its mode.
  assert.equal(effectivePermissionMode({ agent_permission_mode: 'bypass' }, 'plan'), 'bypass');
  assert.equal(effectivePermissionMode({ agentPermissionMode: null }, 'bypass'), 'bypass');
  assert.equal(effectivePermissionMode({ agentPermissionMode: 'yolo' }, 'bypass'), null, 'an unknown override never inherits');
  assert.equal(effectivePermissionMode({ agentPermissionMode: null }, null), null);
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
  assert.deepEqual(result.skipped, [
    { key: 'T4', reason: 'status' },
    { key: 'T5', reason: 'status' },
    { key: 'T6', reason: 'category' },
    { key: 'T7', reason: 'objective' },
    { key: 'T8', reason: 'reservation' },
    { key: 'T9', reason: 'human' },
    { key: 'T10', reason: 'other_assignee' },
    { key: 'T12', reason: 'live_session' },
  ]);
  assert.deepEqual(keys(select([dep({ id: 'T10', assignee: 2 })], { currentUserId: null })), ['T10'],
    'an unknown current user leaves the assignee check to the start gate');
});

// (TPT9194) A chained run inherits the finished run's agent and model; a Pi image task would lose
// its image model to it, and an image operation never runs in bypass anyway.
test('a Pi image task is no chain pick: skipped as image_task, and the sprint fallback passes over it', () => {
  const isImageTask = t => t.agentAssignee === 'pi' && t.piModel === 'image-row';
  const image = task('T2', { dependencies: ['T1'], agentAssignee: 'pi', piModel: 'image-row', order: 1 });
  const text = task('T3', { dependencies: ['T1'], agentAssignee: 'pi', piModel: 'text-row', order: 2 });
  const result = select([image, text], { isImageTask });
  assert.deepEqual(keys(result), ['T3']);
  assert.deepEqual(result.skipped, [{ key: 'T2', reason: 'image_task' }]);
  const fallback = select([task('T4', { agentAssignee: 'pi', piModel: 'image-row', order: 1 }), task('T5', { order: 2 })], { isImageTask });
  assert.deepEqual([fallback.reason, keys(fallback), fallback.skipped], ['sprint', ['T5'], [{ key: 'T4', reason: 'image_task' }]]);
  assert.deepEqual(keys(select([image])), ['T2'], 'without the predicate no task is an image task');
});

test('one skip code per start check, and a task failing several names the first', () => {
  assert.deepEqual([...SKIP_REASONS], ['objective', 'reservation', 'category', 'human', 'image_task', 'other_assignee', 'live_session', 'status', 'deps_open']);
  // Each dependent fails exactly one check, created in SKIP_REASONS order (board order follows).
  const failing = {
    objective: { isObjective: true },
    reservation: { isReservation: true },
    category: { category: 'HUMAN' },
    human: { agentAssignee: 'human' },
    image_task: { agentAssignee: 'pi', piModel: 'image-row' },
    other_assignee: { assignee: 2 },
    live_session: {},
    status: { status: 'Doing' },
    deps_open: { dependencies: ['T1', 'T99'] },
  };
  const tasks = SKIP_REASONS.map((code, i) => task(`S${i + 1}`, { dependencies: ['T1'], ...failing[code] }));
  const live = `S${SKIP_REASONS.indexOf('live_session') + 1}`;
  const result = select(tasks, { liveTaskIds: [live], isImageTask: t => t.piModel === 'image-row' });
  assert.equal(result.reason, 'none');
  assert.deepEqual(result.skipped, SKIP_REASONS.map((reason, i) => ({ key: `S${i + 1}`, reason })),
    'every dependent is listed once, though it is also a same-sprint candidate');

  const several = select([
    task('T2', { dependencies: ['T1', 'T99'], isObjective: true, category: 'HUMAN', status: 'Done' }),
    task('T3', { dependencies: ['T1'], status: 'Doing' }), // running: its live session explains it
    task('T4', { dependencies: ['T1', 'T99'], status: 'Done' }),
  ], { liveTaskIds: ['T3'] });
  assert.deepEqual(several.skipped, [
    { key: 'T2', reason: 'objective' },
    { key: 'T3', reason: 'live_session' },
    { key: 'T4', reason: 'status' },
  ]);
});

test('a none answer names every dependent and every open task of the sprint; closed sprint tasks are left out', () => {
  const result = select([
    task('T2', { dependencies: ['T1', 'T8'], order: 1 }),
    task('T3', { dependencies: ['T1'], priority: 0, category: 'HUMAN' }), // a backlog dependent
    task('T8', { status: 'Doing', order: 2 }),
    task('T5', { status: 'Done', order: 3 }),
    task('T6', { status: 'Dropped', order: 4 }),
    task('T7', { assignee: 2, order: 5 }),
    task('T9', { priority: 8 }), // another sprint
    task('T10', { priority: 0 }), // backlog
  ]);
  assert.deepEqual(result, {
    tasks: [],
    reason: 'none',
    skipped: [
      { key: 'T3', reason: 'category' },
      { key: 'T2', reason: 'deps_open' },
      { key: 'T8', reason: 'status' },
      { key: 'T7', reason: 'other_assignee' },
    ],
  });
});

test('an empty result when nothing can start, and on missing input', () => {
  assert.deepEqual(select([task('T2', { status: 'Doing' }), task('T3', { category: 'HUMAN' })]),
    { tasks: [], reason: 'none', skipped: [{ key: 'T2', reason: 'status' }, { key: 'T3', reason: 'category' }] });
  assert.deepEqual(select([]), { tasks: [], reason: 'none', skipped: [] });
  assert.deepEqual(selectNextCowboyTasks(null, [task('T2')], { statusRoles: ROLES }), { tasks: [], reason: 'none', skipped: [] });
  assert.deepEqual(selectNextCowboyTasks(FINISHED, null, { statusRoles: ROLES }), { tasks: [], reason: 'none', skipped: [] });
  assert.deepEqual(selectNextCowboyTasks(FINISHED, [task('T2', { dependencies: ['T1'] })], {}), { tasks: [], reason: 'none', skipped: [] });
});

test('a chained start sends the Start kickoff and asks for the inherited agent, else the task\'s own', () => {
  assert.equal(chainKickoffPrompt({ id: 'T2', title: 'Fix it', description: 'Steps.' }), 'Work on task T2: Fix it. Steps.');
  assert.equal(chainKickoffPrompt({ id: 'T2', title: '', description: '' }), 'Work on task T2: T2. ');
  const long = chainKickoffPrompt({ id: 'T2', title: 'Long', description: 'x'.repeat(KICKOFF_DESC_MAX + 10) });
  assert.ok(long.endsWith(`${'x'.repeat(10)}... (truncated)`));
  assert.equal(long.length, 'Work on task T2: Long. '.length + KICKOFF_DESC_MAX + '... (truncated)'.length);
  assert.deepEqual(['claude', 'codex', 'pi', 'human', null].map(agentAssignee => chainLaunchAgent({ agentAssignee })),
    ['claude', 'codex', 'pi', null, null]);
  // (TPT9194) The finished run's agent wins over the task's own; a non-launch agent is ignored.
  assert.equal(chainLaunchAgent({ agentAssignee: 'codex' }, 'claude'), 'claude');
  assert.equal(chainLaunchAgent({ agentAssignee: null }, 'pi'), 'pi');
  assert.equal(chainLaunchAgent({ agentAssignee: 'codex' }, 'gemini'), 'codex');
  assert.equal(chainLaunchAgent({ agentAssignee: null }, null), null);
});

// (TPT9194) What a pick inherits from the finished run, and the fields written to it before it starts.
test('a pick inherits the finished run\'s agent and model, Bypass and Cowboy-coding mode', () => {
  assert.deepEqual(chainInheritance({ taskAgent: 'claude', taskAgentModel: ' claude-opus-5-5 ' }), { agent: 'claude', model: 'claude-opus-5-5' });
  assert.deepEqual(chainInheritance({ taskAgent: 'codex', taskAgentModel: '' }), { agent: 'codex', model: '' });
  assert.deepEqual(chainInheritance({ taskAgent: 'gemini', taskAgentModel: 'gemini-x' }), { agent: null, model: '' });
  assert.deepEqual(chainInheritance(null), { agent: null, model: '' });

  assert.deepEqual(chainPickFields({ agent: 'claude', model: 'claude-opus-5-5' }),
    { agentPermissionMode: 'bypass', cowboyMode: true, agentAssignee: 'claude', claudeModel: 'claude-opus-5-5' });
  assert.deepEqual(chainPickFields({ agent: 'codex', model: 'gpt-5.5-codex' }),
    { agentPermissionMode: 'bypass', cowboyMode: true, agentAssignee: 'codex', codexModel: 'gpt-5.5-codex' });
  assert.deepEqual(chainPickFields({ agent: 'pi', model: 'deepseek/deepseek-v4' }),
    { agentPermissionMode: 'bypass', cowboyMode: true, agentAssignee: 'pi', piModel: 'deepseek/deepseek-v4' });
  assert.deepEqual(chainPickFields({ agent: 'codex', model: '' }),
    { agentPermissionMode: 'bypass', cowboyMode: true, agentAssignee: 'codex' }, 'no model reported: the model fields stay');
  assert.deepEqual(chainPickFields({ agent: null, model: '' }), { agentPermissionMode: 'bypass', cowboyMode: true });
  assert.deepEqual(chainPickFields(), { agentPermissionMode: 'bypass', cowboyMode: true });
});
