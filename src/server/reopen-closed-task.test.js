'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { CLOSED_STATUSES, REOPEN_STATUS, isClosedStatus, reopenStatusFor, applyReopenToPatch } =
  require('./reopen-closed-task');

test('CLOSED_STATUSES / isClosedStatus', () => {
  assert.equal(isClosedStatus('completed'), true);
  assert.equal(isClosedStatus('canceled'), true);
  assert.equal(isClosedStatus('pending'), false);
  assert.equal(isClosedStatus('in_progress'), false);
  assert.equal(isClosedStatus('on_fire'), false);
  assert.equal(isClosedStatus(undefined), false);
  assert.equal(CLOSED_STATUSES.has('completed') && CLOSED_STATUSES.has('canceled'), true);
});

test('reopenStatusFor: closed live status with no incoming status -> in_progress', () => {
  assert.equal(reopenStatusFor('completed', undefined), REOPEN_STATUS);
  assert.equal(reopenStatusFor('canceled', undefined), REOPEN_STATUS);
});

test('reopenStatusFor: non-closed live status -> null regardless of incoming', () => {
  assert.equal(reopenStatusFor('pending', undefined), null);
  assert.equal(reopenStatusFor('in_progress', undefined), null);
  assert.equal(reopenStatusFor('on_fire', undefined), null);
  assert.equal(reopenStatusFor(undefined, undefined), null);
});

test('reopenStatusFor: an explicit incoming status always wins, even re-closing on purpose', () => {
  assert.equal(reopenStatusFor('completed', 'completed'), null);
  assert.equal(reopenStatusFor('completed', 'pending'), null);
  assert.equal(reopenStatusFor('canceled', 'canceled'), null);
});

test('applyReopenToPatch: closed live task -> patch.status set, returns true', async () => {
  const backend = { getTask: async () => ({ id: 'C1', status: 'completed' }) };
  const patch = { title: 'edited' };
  const changed = await applyReopenToPatch(backend, 'C1', patch, 'test');
  assert.equal(changed, true);
  assert.equal(patch.status, 'in_progress');
});

test('applyReopenToPatch: canceled live task -> patch.status set', async () => {
  const backend = { getTask: async () => ({ id: 'C1', status: 'canceled' }) };
  const patch = {};
  await applyReopenToPatch(backend, 'C1', patch, 'test');
  assert.equal(patch.status, 'in_progress');
});

test('applyReopenToPatch: open live task -> patch untouched, returns false', async () => {
  const backend = { getTask: async () => ({ id: 'C1', status: 'in_progress' }) };
  const patch = { title: 'edited' };
  const changed = await applyReopenToPatch(backend, 'C1', patch, 'test');
  assert.equal(changed, false);
  assert.equal('status' in patch, false);
});

test('applyReopenToPatch: patch already carrying a status is never overridden', async () => {
  const backend = { getTask: async () => ({ id: 'C1', status: 'completed' }) };
  const patch = { status: 'pending' };
  const changed = await applyReopenToPatch(backend, 'C1', patch, 'test');
  assert.equal(changed, false);
  assert.equal(patch.status, 'pending');
});

test('applyReopenToPatch: getTask rejecting is swallowed, patch untouched, does not throw', async () => {
  const backend = { getTask: async () => { throw new Error('network down'); } };
  const patch = { title: 'edited' };
  const changed = await applyReopenToPatch(backend, 'C1', patch, 'test');
  assert.equal(changed, false);
  assert.equal('status' in patch, false);
});

test('applyReopenToPatch: getTask returning null (task not found) -> no-op', async () => {
  const backend = { getTask: async () => null };
  const patch = {};
  const changed = await applyReopenToPatch(backend, 'C1', patch, 'test');
  assert.equal(changed, false);
});

test('applyReopenToPatch: backend with no getTask -> no-op, does not throw', async () => {
  const patch = { title: 'edited' };
  const changed = await applyReopenToPatch({}, 'C1', patch, 'test');
  assert.equal(changed, false);
});

test('applyReopenToPatch: falsy patch -> no-op, does not throw', async () => {
  const backend = { getTask: async () => ({ id: 'C1', status: 'completed' }) };
  assert.equal(await applyReopenToPatch(backend, 'C1', null, 'test'), false);
  assert.equal(await applyReopenToPatch(backend, 'C1', undefined, 'test'), false);
});

// ── C1187: renamed registry, resolved via backend.getStatuses() ──

test('applyReopenToPatch: renamed complete-role status reopens to this project\'s in-progress-role name', async () => {
  const rows = [
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'Doing', is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'Shipped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false },
    { name: 'Dropped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: true },
  ];
  const backend = {
    getTask: async () => ({ id: 'C1', status: 'Shipped' }),
    getStatuses: async () => rows,
  };
  const patch = { title: 'edited' };
  const changed = await applyReopenToPatch(backend, 'C1', patch, 'test');
  assert.equal(changed, true);
  assert.equal(patch.status, 'Doing');
});

test('applyReopenToPatch: renamed canceled-role status reopens too — the point of the 4th role flag', async () => {
  const rows = [
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'Doing', is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'Shipped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false },
    { name: 'Dropped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: true },
  ];
  const backend = {
    getTask: async () => ({ id: 'C1', status: 'Dropped' }),
    getStatuses: async () => rows,
  };
  const patch = {};
  const changed = await applyReopenToPatch(backend, 'C1', patch, 'test');
  assert.equal(changed, true);
  assert.equal(patch.status, 'Doing');
});

test('reopenStatusFor: with an explicit roles map, resolves by role not by the legacy literal names', () => {
  const roles = { start: 'Backlog', in_progress: 'Doing', complete: 'Shipped', canceled: 'Dropped' };
  assert.equal(reopenStatusFor('Shipped', undefined, roles), 'Doing');
  assert.equal(reopenStatusFor('Dropped', undefined, roles), 'Doing');
  assert.equal(reopenStatusFor('completed', undefined, roles), null); // not this project's complete name
  assert.equal(reopenStatusFor('canceled', undefined, roles), null); // not this project's canceled name
});
