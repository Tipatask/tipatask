'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { minStepForDeps } = require('../server/sprint-assign');
const { resolveDepAwareUpdate } = require('./dep-priority');

// Standalone contract check (task item 2 of C1053): minStepForDeps must work off a
// plain id->priority Map with no topo-sort/changes[] machinery involved.
test('minStepForDeps standalone: single dep returns depPriority + 1', () => {
  const priorityMap = new Map([['C1052', 228]]);
  assert.equal(minStepForDeps(['C1052'], priorityMap), 229);
});

test('bumps task priority up to dep priority + 1 when tied', () => {
  const tasks = [
    { id: 'A', priority: 228, status: 'pending', dependencies: [] },
    { id: 'DEP', priority: 228, status: 'pending', dependencies: [] },
  ];
  const result = resolveDepAwareUpdate({ taskId: 'A', dependencies: ['DEP'], currentPriority: 228, tasks });
  assert.equal(result.bumped, true);
  assert.equal(result.priority, 229);
  assert.deepEqual(result.cascade, []);
});

test('bumps task priority above a dep sitting in a much higher sprint', () => {
  const tasks = [
    { id: 'A', priority: 228, status: 'pending', dependencies: [] },
    { id: 'DEP', priority: 300, status: 'pending', dependencies: [] },
  ];
  const result = resolveDepAwareUpdate({ taskId: 'A', dependencies: ['DEP'], currentPriority: 228, tasks });
  assert.equal(result.bumped, true);
  assert.equal(result.priority, 301);
});

test('leaves priority unchanged when already above the dep', () => {
  const tasks = [
    { id: 'A', priority: 300, status: 'pending', dependencies: [] },
    { id: 'DEP', priority: 228, status: 'pending', dependencies: [] },
  ];
  const result = resolveDepAwareUpdate({ taskId: 'A', dependencies: ['DEP'], currentPriority: 300, tasks });
  assert.equal(result.bumped, false);
  assert.equal(result.priority, 300);
  assert.deepEqual(result.cascade, []);
});

test('backlog dep (priority 0) does not constrain the task', () => {
  const tasks = [
    { id: 'A', priority: 228, status: 'pending', dependencies: [] },
    { id: 'DEP', priority: 0, status: 'pending', dependencies: [] },
  ];
  const result = resolveDepAwareUpdate({ taskId: 'A', dependencies: ['DEP'], currentPriority: 228, tasks });
  assert.equal(result.bumped, false);
  assert.equal(result.priority, 228);
});

test('unknown dep id does not constrain the task', () => {
  const tasks = [{ id: 'A', priority: 228, status: 'pending', dependencies: [] }];
  const result = resolveDepAwareUpdate({ taskId: 'A', dependencies: ['GHOST'], currentPriority: 228, tasks });
  assert.equal(result.bumped, false);
  assert.equal(result.priority, 228);
});

test('backlog task (priority 0) is never bumped, even against a real dep', () => {
  const tasks = [
    { id: 'A', priority: 0, status: 'pending', dependencies: [] },
    { id: 'DEP', priority: 228, status: 'pending', dependencies: [] },
  ];
  const result = resolveDepAwareUpdate({ taskId: 'A', dependencies: ['DEP'], currentPriority: 0, tasks });
  assert.equal(result.bumped, false);
  assert.equal(result.priority, 0);
  assert.deepEqual(result.cascade, []);
});

test('cascades bump through a chain of active dependents', () => {
  // A(228) depended on by B(228) depended on by C(228). Bumping A to 229 must push
  // B to 230 and C to 231 so the whole chain stays strictly ordered.
  const tasks = [
    { id: 'A', priority: 228, status: 'pending', dependencies: [] },
    { id: 'DEP', priority: 228, status: 'pending', dependencies: [] },
    { id: 'B', priority: 228, status: 'pending', dependencies: ['A'] },
    { id: 'C', priority: 228, status: 'in_progress', dependencies: ['B'] },
    { id: 'DONE', priority: 228, status: 'completed', dependencies: ['A'] }, // inactive, untouched
  ];
  const result = resolveDepAwareUpdate({ taskId: 'A', dependencies: ['DEP'], currentPriority: 228, tasks });
  assert.equal(result.bumped, true);
  assert.equal(result.priority, 229);
  const byId = Object.fromEntries(result.cascade.map(c => [c.id, c]));
  assert.equal(byId.B.to, 230);
  assert.equal(byId.C.to, 231);
  assert.equal(byId.DONE, undefined, 'completed dependents must not be cascaded');
});

test('dependency cycle terminates instead of looping forever', () => {
  const tasks = [
    { id: 'A', priority: 228, status: 'pending', dependencies: ['B'] },
    { id: 'B', priority: 228, status: 'pending', dependencies: ['A'] },
    { id: 'DEP', priority: 228, status: 'pending', dependencies: [] },
  ];
  assert.doesNotThrow(() => {
    resolveDepAwareUpdate({ taskId: 'A', dependencies: ['DEP'], currentPriority: 228, tasks });
  });
});

test('self-reference in dependencies is ignored (caller-filtered, defensive here too)', () => {
  const tasks = [{ id: 'A', priority: 228, status: 'pending', dependencies: [] }];
  const result = resolveDepAwareUpdate({ taskId: 'A', dependencies: ['A'], currentPriority: 228, tasks });
  assert.equal(result.bumped, false);
  assert.equal(result.priority, 228);
});

// ── C1187: renamed-registry activeStatuses param ──

test('cascade with a renamed registry: activeStatuses gates which dependents cascade, by role not literal name', () => {
  // Same shape as the chain-cascade test above, but every status is a project-custom
  // name. Without activeStatuses threaded, C's 'Doing' status would never match the
  // legacy 'in_progress' literal and the cascade would stop at B.
  const tasks = [
    { id: 'A', priority: 228, status: 'Backlog', dependencies: [] },
    { id: 'DEP', priority: 228, status: 'Backlog', dependencies: [] },
    { id: 'B', priority: 228, status: 'Backlog', dependencies: ['A'] },
    { id: 'C', priority: 228, status: 'Doing', dependencies: ['B'] },
    { id: 'DONE', priority: 228, status: 'Shipped', dependencies: ['A'] }, // closed, untouched
  ];
  const activeStatuses = new Set(['Backlog', 'Doing', 'on_fire']);
  const result = resolveDepAwareUpdate({ taskId: 'A', dependencies: ['DEP'], currentPriority: 228, tasks, activeStatuses });
  assert.equal(result.bumped, true);
  assert.equal(result.priority, 229);
  const byId = Object.fromEntries(result.cascade.map(c => [c.id, c]));
  assert.equal(byId.B.to, 230);
  assert.equal(byId.C.to, 231);
  assert.equal(byId.DONE, undefined, 'Shipped (closed-role) dependents must not be cascaded');
});

test('omitting activeStatuses degrades to the legacy pending/in_progress/on_fire set — a renamed dependent is not cascaded', () => {
  const tasks = [
    { id: 'A', priority: 228, status: 'pending', dependencies: [] },
    { id: 'DEP', priority: 228, status: 'pending', dependencies: [] },
    { id: 'B', priority: 228, status: 'Doing', dependencies: ['A'] }, // 'Doing' not in the legacy set
  ];
  const result = resolveDepAwareUpdate({ taskId: 'A', dependencies: ['DEP'], currentPriority: 228, tasks });
  assert.equal(result.bumped, true);
  assert.equal(result.priority, 229);
  assert.deepEqual(result.cascade, []); // B never cascades — its status doesn't match the legacy set
});

test('activeStatuses accepts a plain array, not just a Set', () => {
  const tasks = [
    { id: 'A', priority: 228, status: 'Backlog', dependencies: [] },
    { id: 'DEP', priority: 228, status: 'Backlog', dependencies: [] },
    { id: 'B', priority: 228, status: 'Doing', dependencies: ['A'] },
  ];
  const result = resolveDepAwareUpdate({ taskId: 'A', dependencies: ['DEP'], currentPriority: 228, tasks, activeStatuses: ['Backlog', 'Doing'] });
  assert.equal(result.bumped, true);
  const byId = Object.fromEntries(result.cascade.map(c => [c.id, c]));
  assert.equal(byId.B.to, 230);
});
