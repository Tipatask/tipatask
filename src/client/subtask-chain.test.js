import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAncestorCrumbs, MAX_ANCESTOR_DEPTH } from './subtask-chain.js';

test('buildAncestorCrumbs: null/undefined startParentDbId returns []', () => {
  assert.deepEqual(buildAncestorCrumbs(null, [{ dbId: 1, id: 'C1', title: 'Root' }]), []);
  assert.deepEqual(buildAncestorCrumbs(undefined, [{ dbId: 1, id: 'C1', title: 'Root' }]), []);
});

test('buildAncestorCrumbs: non-array tasks returns []', () => {
  assert.deepEqual(buildAncestorCrumbs(1, null), []);
  assert.deepEqual(buildAncestorCrumbs(1, undefined), []);
});

test('buildAncestorCrumbs: startParentDbId unresolvable (not in the list) returns []', () => {
  assert.deepEqual(buildAncestorCrumbs(999, [{ dbId: 1, id: 'C1', title: 'Root', parentDbId: null }]), []);
});

test('buildAncestorCrumbs: linear 3-deep chain returns root -> nearest ancestor order', () => {
  const tasks = [
    { dbId: 1, id: 'C1', title: 'Root objective', parentDbId: null },
    { dbId: 2, id: 'C2', title: 'Mid subtask', parentDbId: 1 },
    { dbId: 3, id: 'C3', title: 'Leaf subtask', parentDbId: 2 },
    { dbId: 4, id: 'C4', title: 'Current board', parentDbId: 3 },
  ];
  // Walking up from C4's own parentDbId (3, i.e. C3) should yield [C1, C2, C3].
  assert.deepEqual(buildAncestorCrumbs(3, tasks), [
    { taskKey: 'C1', title: 'Root objective' },
    { taskKey: 'C2', title: 'Mid subtask' },
    { taskKey: 'C3', title: 'Leaf subtask' },
  ]);
});

test('buildAncestorCrumbs: single-level parent returns one entry', () => {
  const tasks = [
    { dbId: 1, id: 'C1', title: 'Root objective', parentDbId: null },
    { dbId: 2, id: 'C2', title: 'Subtask', parentDbId: 1 },
  ];
  assert.deepEqual(buildAncestorCrumbs(1, tasks), [{ taskKey: 'C1', title: 'Root objective' }]);
});

test('buildAncestorCrumbs: a cycle terminates instead of looping forever', () => {
  const tasks = [
    { dbId: 1, id: 'C1', title: 'A', parentDbId: 2 },
    { dbId: 2, id: 'C2', title: 'B', parentDbId: 1 },
  ];
  const result = buildAncestorCrumbs(1, tasks);
  // Whatever order it collects in, it must stop instead of hanging, and must not contain
  // duplicate entries for the same task.
  const keys = result.map(r => r.taskKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.length <= 2);
});

test('buildAncestorCrumbs: an unknown/filtered-out ancestor dbId truncates the chain there', () => {
  // dbId 1 (the true root) is missing from the list entirely — e.g. filtered as a
  // reservation placeholder by the /api/project/tasks projection.
  const tasks = [
    { dbId: 2, id: 'C2', title: 'Mid subtask', parentDbId: 1 },
    { dbId: 3, id: 'C3', title: 'Leaf subtask', parentDbId: 2 },
  ];
  assert.deepEqual(buildAncestorCrumbs(2, tasks), [{ taskKey: 'C2', title: 'Mid subtask' }]);
});

test('buildAncestorCrumbs: respects a custom maxDepth', () => {
  const tasks = [];
  for (let i = 1; i <= 10; i++) {
    tasks.push({ dbId: i, id: `C${i}`, title: `Task ${i}`, parentDbId: i > 1 ? i - 1 : null });
  }
  const result = buildAncestorCrumbs(9, tasks, { maxDepth: 3 });
  assert.equal(result.length, 3);
});

test('buildAncestorCrumbs: default maxDepth caps a pathologically long chain', () => {
  const tasks = [];
  const depth = MAX_ANCESTOR_DEPTH + 10;
  for (let i = 1; i <= depth; i++) {
    tasks.push({ dbId: i, id: `C${i}`, title: `Task ${i}`, parentDbId: i > 1 ? i - 1 : null });
  }
  const result = buildAncestorCrumbs(depth, tasks);
  assert.ok(result.length <= MAX_ANCESTOR_DEPTH);
});

test('buildAncestorCrumbs: a row missing its task_key (id) truncates the chain there', () => {
  const tasks = [
    { dbId: 1, id: null, title: 'Broken row', parentDbId: null },
    { dbId: 2, id: 'C2', title: 'Subtask', parentDbId: 1 },
  ];
  assert.deepEqual(buildAncestorCrumbs(1, tasks), []);
});
