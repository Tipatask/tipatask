'use strict';

// C1408 — start-time assignee gate: assertTaskStartable() blocks starting a teammate's
// task, claimUnassignedTaskOnStart() claims an unassigned one for the starting user
// before spawn. See ai/architecture/tt-claude-session-terminal.md § Start-time assignee
// gate and ai/architecture/tt-task-board.md § Session Start Permissions.

process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertTaskStartable, claimUnassignedTaskOnStart } = require('./ws-handlers');

function makeBackend({ currentUserId = 1, updateTaskImpl = null } = {}) {
  const updateCalls = [];
  return {
    updateCalls,
    async getCurrentUserId() {
      return currentUserId;
    },
    async getTask() {
      return null; // callers under test always pass the task row explicitly
    },
    async updateTask(id, fields) {
      updateCalls.push([id, fields]);
      if (updateTaskImpl) return updateTaskImpl(id, fields);
      return { id, assignee: fields.assignee, _pendingSync: false };
    },
  };
}

// ── assertTaskStartable ──

test('assertTaskStartable throws EASSIGNEE on a confirmed mismatch', async () => {
  const backend = makeBackend({ currentUserId: 1 });
  const task = { id: 'C1', assignee: 2 };
  await assert.rejects(
    () => assertTaskStartable(backend, 'C1', task),
    (err) => err.code === 'EASSIGNEE'
  );
});

test('assertTaskStartable resolves when the task is assigned to the caller', async () => {
  const backend = makeBackend({ currentUserId: 1 });
  const task = { id: 'C1', assignee: 1 };
  const me = await assertTaskStartable(backend, 'C1', task);
  assert.equal(me, 1);
});

test('assertTaskStartable resolves for an unassigned task and returns the current user id', async () => {
  const backend = makeBackend({ currentUserId: 5 });
  const task = { id: 'C1', assignee: null };
  const me = await assertTaskStartable(backend, 'C1', task);
  assert.equal(me, 5);
});

test('assertTaskStartable fails OPEN when the current user id is unresolved, even against a different assignee', async () => {
  const backend = makeBackend({ currentUserId: null });
  const task = { id: 'C1', assignee: 2 };
  const me = await assertTaskStartable(backend, 'C1', task);
  assert.equal(me, null, 'must not throw — unknown user must never lock the owner out');
});

test('assertTaskStartable re-fetches the task when the caller passes null (upstream fetch failed)', async () => {
  const backend = makeBackend({ currentUserId: 1 });
  backend.getTask = async () => ({ id: 'C1', assignee: 2 });
  await assert.rejects(
    () => assertTaskStartable(backend, 'C1', null),
    (err) => err.code === 'EASSIGNEE'
  );
});

test('assertTaskStartable no-ops for chat session ids (obj-*/specChat:)', async () => {
  const backend = makeBackend({ currentUserId: 1 });
  const objMe = await assertTaskStartable(backend, 'obj-123', { assignee: 2 });
  const specMe = await assertTaskStartable(backend, 'specChat:C1', { assignee: 2 });
  assert.equal(objMe, null);
  assert.equal(specMe, null);
});

// ── claimUnassignedTaskOnStart ──

test('claimUnassignedTaskOnStart claims an unassigned task for the current user', async () => {
  const backend = makeBackend({ currentUserId: 7 });
  const task = { id: 'C1', assignee: null };
  const updated = await claimUnassignedTaskOnStart(backend, 'C1', task, 7, '/proj');
  assert.equal(updated.assignee, 7);
  assert.deepEqual(backend.updateCalls, [['C1', { assignee: 7 }]]);
});

test('claimUnassignedTaskOnStart is a no-op when the task already has an assignee', async () => {
  const backend = makeBackend({ currentUserId: 7 });
  const task = { id: 'C1', assignee: 7 };
  const result = await claimUnassignedTaskOnStart(backend, 'C1', task, 7, '/proj');
  assert.equal(result, task);
  assert.deepEqual(backend.updateCalls, []);
});

test('claimUnassignedTaskOnStart throws ECLAIM when the current user id is unknown', async () => {
  const backend = makeBackend({ currentUserId: null });
  const task = { id: 'C1', assignee: null };
  await assert.rejects(
    () => claimUnassignedTaskOnStart(backend, 'C1', task, null, '/proj'),
    (err) => err.code === 'ECLAIM'
  );
  assert.deepEqual(backend.updateCalls, []);
});

test('claimUnassignedTaskOnStart throws ECLAIM when updateTask throws', async () => {
  const backend = makeBackend({
    currentUserId: 7,
    updateTaskImpl: () => { throw new Error('network down'); },
  });
  const task = { id: 'C1', assignee: null };
  await assert.rejects(
    () => claimUnassignedTaskOnStart(backend, 'C1', task, 7, '/proj'),
    (err) => err.code === 'ECLAIM'
  );
});

test('claimUnassignedTaskOnStart throws ECLAIM when the claim only lands in the offline mutation queue', async () => {
  const backend = makeBackend({
    currentUserId: 7,
    updateTaskImpl: (id, fields) => ({ id, assignee: fields.assignee, _pendingSync: true }),
  });
  const task = { id: 'C1', assignee: null };
  await assert.rejects(
    () => claimUnassignedTaskOnStart(backend, 'C1', task, 7, '/proj'),
    (err) => err.code === 'ECLAIM'
  );
});

test('claimUnassignedTaskOnStart throws ECLAIM when the returned row does not carry the claimed assignee', async () => {
  const backend = makeBackend({
    currentUserId: 7,
    updateTaskImpl: (id) => ({ id, assignee: 999, _pendingSync: false }),
  });
  const task = { id: 'C1', assignee: null };
  await assert.rejects(
    () => claimUnassignedTaskOnStart(backend, 'C1', task, 7, '/proj'),
    (err) => err.code === 'ECLAIM'
  );
});

test('claimUnassignedTaskOnStart no-ops for chat session ids (obj-*/specChat:)', async () => {
  const backend = makeBackend({ currentUserId: 7 });
  const task = { id: 'obj-123', assignee: null };
  const result = await claimUnassignedTaskOnStart(backend, 'obj-123', task, 7, '/proj');
  assert.equal(result, task);
  assert.deepEqual(backend.updateCalls, []);
});
