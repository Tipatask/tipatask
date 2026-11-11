'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launchCowboyChain, withCowboyEnv, cowboyRunTokens, COWBOY_TOKEN_ENV } = require('./terminal-session');
const { selectNextObjectiveTask } = require('./objective-chain');

const root = '/objective-test';
const roles = { start: 'queued', in_progress: 'working', complete: 'done', canceled: 'dropped' };
const parent = () => ({ id: 'P1', dbId: 1, isObjective: true, status: 'working', category: 'CODING' });
const child = (id, extra = {}) => ({ id, dbId: Number(id.slice(1)) + 10, parentDbId: 1, status: 'queued',
  category: 'CODING', dependencies: [], priority: 1, order: 0, ...extra });
function harness({ mode = 'auto', finishedKey = 'P1', children = [child('C1'), child('C2', { dependencies: ['C1'] })] } = {}) {
  const tasks = [parent(), ...children];
  const run = { type: 'terminal', alive: true, projectPath: root, taskId: finishedKey, parentPreparation: finishedKey === 'P1',
    terminalPhase: 'executing', objectiveChain: { rootTaskId: 'P1' }, permissionPolicy: { mode, planning: mode === 'plan' },
    taskAgent: 'codex', taskAgentModel: 'chosen-model', _cowboyToken: 'test-token' };
  const sessions = new Map([[finishedKey, run]]);
  const writes = [], launches = [];
  const backend = {
    getTasksUnfiltered: async () => tasks,
    getTask: async key => tasks.find(t => t.id === key),
    getEffectiveProjectSettings: async () => ({ settings: { agent_permission_mode: mode } }),
    getCurrentUserId: async () => 1,
    updateTask: async (key, fields, opts) => {
      writes.push({ key, fields, opts });
      return Object.assign(tasks.find(t => t.id === key), fields);
    },
  };
  const deps = { sessions, backend, fetchStatusRoles: async () => roles,
    websocket: { emitTaskUpdated() {}, emitCowboyChainStarted() {} },
    startTask: async launch => {
      launches.push(launch);
      sessions.set(launch.task.id, { type: 'terminal', projectPath: root, taskId: launch.task.id, _queued: true, objectiveChain: launch.objectiveChain });
      return true;
    } };
  return { tasks, run, sessions, writes, launches, deps, next: () => launchCowboyChain(root, finishedKey, deps) };
}

test('preparation starts only the first dependency-ready child, preserving each selected permission mode', async () => {
  for (const mode of ['plan', 'auto', 'bypass']) {
    const h = harness({ mode, children: [child('C2', { dependencies: ['C1'], priority: 1 }), child('C1', { priority: 2 })] });
    const result = await h.next();
    assert.deepEqual(result.started, ['C1']);
    assert.equal(h.tasks[0].status, 'working');
    assert.deepEqual(h.writes[0], { key: 'C1', fields: { agentAssignee: 'codex', codexModel: 'chosen-model', agentPermissionMode: mode, cowboyMode: 'disabled' }, opts: { queueOffline: false } });
    assert.deepEqual(h.launches[0].objectiveChain, { rootTaskId: 'P1' });
    assert.equal(h.launches[0].cowboyChain, undefined);
    assert.ok(h.launches[0].env[COWBOY_TOKEN_ENV]);
    assert.equal(h.launches[0].model, 'chosen-model');
    assert.equal((await h.next()).reason, 'already_launched');
    assert.equal(h.launches.length, 1);
  }
});

test('Plan preparation cannot write or start before same-session approval', async () => {
  const h = harness({ mode: 'plan' });
  h.run.terminalPhase = 'planning';
  assert.equal((await h.next()).reason, 'not_approved');
  assert.equal(h.writes.length, 0);
  h.run.terminalPhase = 'executing';
  assert.deepEqual((await h.next()).started, ['C1']);
});

test('guarded child completion continues its parent only, one child at a time', async () => {
  const h = harness({ finishedKey: 'C1', children: [child('C1', { status: 'done' }), child('C2', { dependencies: ['C1'] }), child('C3')] });
  h.tasks.push({ ...child('C0'), parentDbId: null, order: -99 });
  assert.deepEqual((await h.next()).started, ['C2']);
  assert.equal(h.launches.length, 1);
  assert.equal(h.tasks[0].status, 'working');
});

test('concurrent handoffs never admit duplicate or parallel child starts', async () => {
  const h = harness();
  const result = await Promise.all([h.next(), h.next(), h.next()]);
  assert.equal(result.flatMap(r => r.started).length, 1);
  assert.equal(h.launches.length, 1);
  const second = { ...h.run, taskId: 'C0', parentPreparation: false, _cowboyNext: null };
  h.tasks.push(child('C0', { status: 'done' }));
  h.sessions.set('C0', second);
  assert.equal((await launchCowboyChain(root, 'C0', h.deps)).reason, 'objective_busy');
});

test('failed, canceled, interrupted and live siblings stop the chain', async () => {
  for (const status of ['on_fire', 'dropped', 'working']) {
    const h = harness({ children: [child('C1', { status }), child('C2')] });
    assert.equal((await h.next()).reason, 'objective_stopped');
    assert.equal(h.writes.length, 0);
  }
  const h = harness();
  h.sessions.set('C2', { type: 'terminal', alive: true, taskId: 'C2', projectPath: root });
  assert.equal((await h.next()).reason, 'objective_busy');
});

test('incomplete child, canceled parent and prematurely completed parent cannot launch work', async () => {
  const h = harness({ finishedKey: 'C1' });
  assert.equal((await h.next()).reason, 'not_finished');
  for (const status of ['dropped', 'done']) {
    const p = harness(); p.tasks[0].status = status;
    assert.equal((await p.next()).started.length, 0);
    assert.equal(p.writes.length, 0);
  }
});

test('all completed children leave parent completion to the API cascade', async () => {
  const h = harness({ children: [child('C1', { status: 'done' })] });
  h.tasks[0].status = 'done';
  assert.equal((await h.next()).reason, 'objective_complete');
  assert.equal(h.writes.length, 0);
});

test('a failed save or launch never skips ahead to a second child', async () => {
  for (const failure of ['save', 'start']) {
    const h = harness();
    if (failure === 'save') h.deps.backend.updateTask = async () => null;
    else h.deps.startTask = async () => { throw new Error('not available'); };
    assert.equal((await h.next()).reason, 'start_failed');
    assert.equal(h.launches.length, 0);
    assert.equal((await h.next()).reason, 'already_launched');
  }
});

test('termination while a save is pending cannot launch a successor', async () => {
  const h = harness();
  const save = h.deps.backend.updateTask;
  h.deps.backend.updateTask = async (...args) => { const saved = await save(...args); h.run._terminated = true; return saved; };
  assert.equal((await h.next()).reason, 'objective_stopped');
  assert.equal(h.launches.length, 0);
});

test('blocked dependencies, foreign assignees, reservations, humans and image tasks stay unstarted', () => {
  const rows = [parent(), child('C1', { dependencies: ['missing'] }), child('C2', { assignee: 2 }),
    child('C3', { isReservation: true }), child('C4', { agentAssignee: 'human' }), child('C5', { image: true })];
  const result = selectNextObjectiveTask(rows[0], rows, { statusRoles: roles, currentUserId: 1, isImageTask: t => t.image });
  assert.equal(result.reason, 'objective_blocked');
  assert.deepEqual(result.skipped.map(s => s.reason), ['deps_open', 'other_assignee', 'reservation', 'human', 'image_task']);
});

test('nested descendants execute leaves before parent containers', () => {
  const p = parent();
  const nested = child('C1', { dbId: 11, isObjective: true });
  const rows = [p, nested, child('C2', { parentDbId: 11 }), child('C3', { dependencies: ['C1'] })];
  assert.deepEqual(selectNextObjectiveTask(p, rows, { statusRoles: roles }).tasks.map(t => t.id), ['C2']);
});

test('objective runs expose only their own live continuation token', () => {
  const h = harness();
  assert.equal(withCowboyEnv({}, h.run, 'P1')[COWBOY_TOKEN_ENV], 'test-token');
  assert.deepEqual(cowboyRunTokens(h.sessions, 'P1'), [{ token: 'test-token', projectPath: root }]);
  assert.deepEqual(cowboyRunTokens(h.sessions, 'other'), []);
  h.run.alive = false;
  assert.deepEqual(cowboyRunTokens(h.sessions, 'P1'), []);
});


test('a nested objective preparation hands off its children and its live container does not block later leaves', async () => {
  const h = harness({ finishedKey: 'C1', children: [child('C1', { dbId: 11, isObjective: true, status: 'working' }),
    child('C2', { parentDbId: 11 }), child('C3', { dependencies: ['C2'], parentDbId: 11 })] });
  h.run.parentPreparation = true;
  assert.deepEqual((await h.next()).started, ['C2']);
  h.tasks.find(t => t.id === 'C2').status = 'done';
  const nextRun = { ...h.run, taskId: 'C2', parentPreparation: false, _cowboyNext: null };
  h.sessions.set('C2', nextRun);
  assert.deepEqual((await launchCowboyChain(root, 'C2', h.deps)).started, ['C3']);
});
