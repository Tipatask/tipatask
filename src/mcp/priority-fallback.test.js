'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveCreatePriority, shouldDefaultPriorityOnFinalize, applyDependencyFloor } = require('./priority-fallback');

test('session task id wins over in_progress and max tiers', () => {
  const tasks = [
    { id: 'C100', status: 'in_progress', category: 'CODING', priority: 5 },
    { id: 'C200', status: 'pending', category: 'CODING', priority: 216 },
  ];
  const result = resolveCreatePriority({ tasks, sessionTaskId: 'C200' });
  assert.deepEqual(result, { priority: 216, reason: 'session', from: 'C200' });
});

test('no session context + empty task list returns 1', () => {
  const result = resolveCreatePriority({ tasks: [], sessionTaskId: '' });
  assert.deepEqual(result, { priority: 1, reason: 'max_plus_one', from: null });
});

test('no session context falls back to in_progress CODING task priority', () => {
  const tasks = [
    { id: 'C100', status: 'in_progress', category: 'CODING', priority: 42 },
    { id: 'C101', status: 'pending', category: 'CODING', priority: 7 },
  ];
  const result = resolveCreatePriority({ tasks, sessionTaskId: '' });
  assert.deepEqual(result, { priority: 42, reason: 'in_progress', from: 'C100' });
});

test('no session context + no in_progress CODING task falls back to max(active)+1', () => {
  const tasks = [
    // HUMAN, not CODING, so the in_progress-CODING tier skips it — but max_plus_one
    // considers all active statuses regardless of category (matches legacy C874 behavior).
    { id: 'C100', status: 'in_progress', category: 'HUMAN', priority: 42 },
    { id: 'C101', status: 'pending', category: 'CODING', priority: 7 },
    { id: 'C102', status: 'completed', category: 'CODING', priority: 999 }, // inactive, ignored
  ];
  const result = resolveCreatePriority({ tasks, sessionTaskId: '' });
  assert.deepEqual(result, { priority: 43, reason: 'max_plus_one', from: null });
});

test('session task id set but task not found in list falls through to heuristics', () => {
  const tasks = [
    { id: 'C100', status: 'in_progress', category: 'CODING', priority: 9 },
  ];
  const result = resolveCreatePriority({ tasks, sessionTaskId: 'C999' });
  assert.deepEqual(result, { priority: 9, reason: 'in_progress', from: 'C100' });
});

test('session task found but its priority is not a number falls through to heuristics', () => {
  const tasks = [
    { id: 'C100', status: 'in_progress', category: 'CODING', priority: 9 },
    { id: 'C200', status: 'pending', category: 'CODING', priority: null },
  ];
  const result = resolveCreatePriority({ tasks, sessionTaskId: 'C200' });
  assert.deepEqual(result, { priority: 9, reason: 'in_progress', from: 'C100' });
});

// ── resolveCreatePriority: C1187 renamed-registry params ──

test('resolveCreatePriority: renamed in_progress role name resolves the in_progress tier via inProgressName', () => {
  const tasks = [
    { id: 'C100', status: 'Doing', category: 'CODING', priority: 42 },
    { id: 'C101', status: 'Backlog', category: 'CODING', priority: 7 },
  ];
  const result = resolveCreatePriority({ tasks, sessionTaskId: '', inProgressName: 'Doing' });
  assert.deepEqual(result, { priority: 42, reason: 'in_progress', from: 'C100' });
});

test('resolveCreatePriority: omitting inProgressName degrades to the legacy literal "in_progress" — a renamed status is invisible to the tier', () => {
  const tasks = [
    { id: 'C100', status: 'Doing', category: 'CODING', priority: 42 },
  ];
  const result = resolveCreatePriority({ tasks, sessionTaskId: '' });
  assert.deepEqual(result, { priority: 1, reason: 'max_plus_one', from: null }); // 'Doing' isn't in the default ACTIVE set either
});

test('resolveCreatePriority: renamed activeStatuses set resolves max_plus_one correctly', () => {
  const tasks = [
    { id: 'C100', status: 'Backlog', category: 'CODING', priority: 5 },
    { id: 'C101', status: 'Doing', category: 'CODING', priority: 12 },
    { id: 'C102', status: 'Shipped', category: 'CODING', priority: 999 }, // closed, ignored
  ];
  const result = resolveCreatePriority({
    tasks, sessionTaskId: '',
    activeStatuses: new Set(['Backlog', 'Doing', 'on_fire']),
    inProgressName: 'Doing',
  });
  assert.deepEqual(result, { priority: 12, reason: 'in_progress', from: 'C101' });
});

test('resolveCreatePriority: activeStatuses accepts a plain array, not just a Set', () => {
  const tasks = [{ id: 'C100', status: 'Backlog', category: 'HUMAN', priority: 8 }];
  const result = resolveCreatePriority({ tasks, sessionTaskId: '', activeStatuses: ['Backlog', 'Doing'] });
  assert.deepEqual(result, { priority: 9, reason: 'max_plus_one', from: null });
});

// ── shouldDefaultPriorityOnFinalize (C1049) ──

test('shouldDefaultPriorityOnFinalize is true only when priority omitted + title present + placeholder', () => {
  const result = shouldDefaultPriorityOnFinalize({ priority: undefined, title: 'Real title' }, true);
  assert.equal(result, true);
});

test('shouldDefaultPriorityOnFinalize is false when priority was explicitly provided', () => {
  const result = shouldDefaultPriorityOnFinalize({ priority: 5, title: 'Real title' }, true);
  assert.equal(result, false);
});

test('shouldDefaultPriorityOnFinalize is false when explicit priority is 0 (intentional backlog)', () => {
  const result = shouldDefaultPriorityOnFinalize({ priority: 0, title: 'Real title' }, true);
  assert.equal(result, false);
});

test('shouldDefaultPriorityOnFinalize is false when title is not being set (ordinary status-only update)', () => {
  const result = shouldDefaultPriorityOnFinalize({ priority: undefined, title: undefined }, true);
  assert.equal(result, false);
});

test('shouldDefaultPriorityOnFinalize is false when the task is not a reservation placeholder', () => {
  const result = shouldDefaultPriorityOnFinalize({ priority: undefined, title: 'Real title' }, false);
  assert.equal(result, false);
});

test('shouldDefaultPriorityOnFinalize is false when priority omitted, title present, but not a placeholder (ordinary update setting title)', () => {
  const result = shouldDefaultPriorityOnFinalize({ priority: undefined, title: 'Renamed task' }, false);
  assert.equal(result, false);
});

// ── applyDependencyFloor (C1052) ──

const norm = (k) => String(k ?? '').trim().toUpperCase();

test('dependency floor raises priority above an active dep at the same sprint (the reported bug)', () => {
  const tasks = [{ id: 'C1041', status: 'in_progress', priority: 228 }];
  const result = applyDependencyFloor({ priority: 228, dependencies: ['C1041'], tasks });
  assert.deepEqual(result, { priority: 229, bumped: true, floor: 229, from: 'C1041' });
});

test('composed with resolveCreatePriority: omitted priority inherits 228, then floor bumps to 229', () => {
  const tasks = [{ id: 'C1041', status: 'in_progress', category: 'CODING', priority: 228 }];
  const inherited = resolveCreatePriority({ tasks, sessionTaskId: '' });
  assert.equal(inherited.priority, 228);
  const result = applyDependencyFloor({ priority: inherited.priority, dependencies: ['C1041'], tasks });
  assert.equal(result.priority, 229);
  assert.equal(result.bumped, true);
});

test('floor is the max across multiple active deps, plus one', () => {
  const tasks = [
    { id: 'C1', status: 'pending', priority: 3 },
    { id: 'C2', status: 'pending', priority: 7 },
    { id: 'C3', status: 'pending', priority: 5 },
  ];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1', 'C2', 'C3'], tasks });
  assert.deepEqual(result, { priority: 8, bumped: true, floor: 8, from: 'C2' });
});

test('priority already above every dep floor is left unchanged', () => {
  const tasks = [{ id: 'C1', status: 'pending', priority: 3 }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1'], tasks });
  assert.deepEqual(result, { priority: 6, bumped: false, floor: 4, from: null });
});

test('never demotes: all deps unknown to the snapshot leaves priority untouched (minStepForDeps-returns-1 trap)', () => {
  const tasks = [{ id: 'C999', status: 'pending', priority: 1 }];
  const result = applyDependencyFloor({ priority: 228, dependencies: ['C1041'], tasks });
  assert.deepEqual(result, { priority: 228, bumped: false, floor: 1, from: null });
});

test('completed dep does not defer the new task (active-only priorityMap)', () => {
  const tasks = [{ id: 'C1041', status: 'completed', priority: 228 }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1041'], tasks });
  assert.deepEqual(result, { priority: 6, bumped: false, floor: 1, from: null });
});

test('canceled dep does not defer the new task (active-only priorityMap)', () => {
  const tasks = [{ id: 'C1041', status: 'canceled', priority: 228 }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1041'], tasks });
  assert.deepEqual(result, { priority: 6, bumped: false, floor: 1, from: null });
});

test('mixed completed(12) + active(6) deps: floor comes from the active one, not the completed one', () => {
  const tasks = [
    { id: 'C_DONE', status: 'completed', priority: 12 },
    { id: 'C_ACTIVE', status: 'in_progress', priority: 6 },
  ];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C_DONE', 'C_ACTIVE'], tasks });
  assert.deepEqual(result, { priority: 7, bumped: true, floor: 7, from: 'C_ACTIVE' });
});

test('dep at backlog (priority 0) is ignored', () => {
  const tasks = [{ id: 'C1', status: 'pending', priority: 0 }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1'], tasks });
  assert.deepEqual(result, { priority: 6, bumped: false, floor: 1, from: null });
});

test('dep is a reservation placeholder at priority 0 — ignored, same as any other backlog dep', () => {
  const tasks = [{ id: 'C1', status: 'pending', priority: 0, isReservation: true }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1'], tasks });
  assert.deepEqual(result, { priority: 6, bumped: false, floor: 1, from: null });
});

test('explicit priority 0 (backlog) stays 0 even with an active dep', () => {
  const tasks = [{ id: 'C1', status: 'pending', priority: 6 }];
  const result = applyDependencyFloor({ priority: 0, dependencies: ['C1'], tasks });
  assert.deepEqual(result, { priority: 0, bumped: false, floor: null, from: null });
});

test('negative priority is exempt from the floor, same as backlog', () => {
  const tasks = [{ id: 'C1', status: 'pending', priority: 6 }];
  const result = applyDependencyFloor({ priority: -1, dependencies: ['C1'], tasks });
  assert.deepEqual(result, { priority: -1, bumped: false, floor: null, from: null });
});

test('normalizes dependency keys before lookup: whitespace/brackets/lowercase all match', () => {
  const tasks = [{ id: 'C1041', status: 'pending', priority: 6 }];
  const result = applyDependencyFloor({
    priority: 6,
    dependencies: ['c1041', ' C1041 ', '[C1041]'],
    tasks,
    normalizeKey: (k) => String(k).trim().replace(/^\[|\]$/g, '').toUpperCase(),
  });
  assert.deepEqual(result, { priority: 7, bumped: true, floor: 7, from: 'C1041' });
});

test('normalizes snapshot task ids too, not just the incoming deps', () => {
  const tasks = [{ id: 'c1041', status: 'pending', priority: 6 }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1041'], tasks, normalizeKey: norm });
  assert.deepEqual(result, { priority: 7, bumped: true, floor: 7, from: 'C1041' });
});

test('self-dependency is dropped even when the key is a pre-reserved active placeholder', () => {
  const tasks = [{ id: 'C1053', status: 'pending', priority: 5, isReservation: true }];
  const result = applyDependencyFloor({ priority: 5, dependencies: ['C1053'], tasks, taskId: 'C1053' });
  assert.deepEqual(result, { priority: 5, bumped: false, floor: null, from: null });
});

test('new task created with status completed is never bumped (bumping a historical task is meaningless)', () => {
  const tasks = [{ id: 'C1', status: 'pending', priority: 6 }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1'], tasks, status: 'completed' });
  assert.deepEqual(result, { priority: 6, bumped: false, floor: null, from: null });
});

test('new task created with status canceled is never bumped', () => {
  const tasks = [{ id: 'C1', status: 'pending', priority: 6 }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1'], tasks, status: 'canceled' });
  assert.deepEqual(result, { priority: 6, bumped: false, floor: null, from: null });
});

test('HUMAN dep is a real blocker — treated the same as a CODING dep', () => {
  const tasks = [{ id: 'H12', status: 'pending', category: 'HUMAN', priority: 6 }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['H12'], tasks });
  assert.deepEqual(result, { priority: 7, bumped: true, floor: 7, from: 'H12' });
});

test('on_fire dep is active and counts toward the floor', () => {
  const tasks = [{ id: 'C1', status: 'on_fire', priority: 6 }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1'], tasks });
  assert.deepEqual(result, { priority: 7, bumped: true, floor: 7, from: 'C1' });
});

test('dep at a much higher sprint jumps the new task forward to match (deliberate, not capped)', () => {
  const tasks = [{ id: 'C1', status: 'pending', priority: 12 }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1'], tasks });
  assert.deepEqual(result, { priority: 13, bumped: true, floor: 13, from: 'C1' });
});

test('empty dependencies array is a no-op', () => {
  const result = applyDependencyFloor({ priority: 6, dependencies: [], tasks: [{ id: 'C1', status: 'pending', priority: 6 }] });
  assert.deepEqual(result, { priority: 6, bumped: false, floor: null, from: null });
});

test('missing/undefined tasks snapshot does not throw', () => {
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1'], tasks: undefined });
  assert.deepEqual(result, { priority: 6, bumped: false, floor: 1, from: null });
});

test('duplicate dependency keys resolve the same as a single occurrence', () => {
  const tasks = [{ id: 'C1', status: 'pending', priority: 6 }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1', 'C1', 'C1'], tasks });
  assert.deepEqual(result, { priority: 7, bumped: true, floor: 7, from: 'C1' });
});

test('snapshot task with a non-numeric priority is ignored for floor purposes', () => {
  const tasks = [{ id: 'C1', status: 'pending', priority: null }];
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1'], tasks });
  assert.deepEqual(result, { priority: 6, bumped: false, floor: 1, from: null });
});

// ── applyDependencyFloor: C1187 renamed-registry activeStatuses param ──

test('applyDependencyFloor: renamed active dep still raises the floor via activeStatuses', () => {
  const tasks = [{ id: 'C1', status: 'Doing', priority: 6 }];
  const result = applyDependencyFloor({
    priority: 6, dependencies: ['C1'], tasks,
    status: 'Backlog',
    activeStatuses: new Set(['Backlog', 'Doing', 'on_fire']),
  });
  assert.deepEqual(result, { priority: 7, bumped: true, floor: 7, from: 'C1' });
});

test('applyDependencyFloor: renamed closed-role dep (complete or canceled) is satisfied, never defers', () => {
  const tasks = [{ id: 'C1', status: 'Shipped', priority: 999 }, { id: 'C2', status: 'Dropped', priority: 999 }];
  const activeStatuses = new Set(['Backlog', 'Doing', 'on_fire']); // Shipped/Dropped deliberately excluded
  const result = applyDependencyFloor({
    priority: 6, dependencies: ['C1', 'C2'], tasks,
    status: 'Backlog',
    activeStatuses,
  });
  // Both deps excluded from the priorityMap (active-only) -> unconstrained floor of 1,
  // which never exceeds the pinned priority of 6 -> no bump. Mirrors the legacy
  // 'completed dep does not defer'/'canceled dep does not defer' tests above.
  assert.deepEqual(result, { priority: 6, bumped: false, floor: 1, from: null });
});

test('applyDependencyFloor: new task\'s own status outside the renamed active set is exempt (mirrors the completed/canceled-being-created case)', () => {
  const tasks = [{ id: 'C1', status: 'Doing', priority: 6 }];
  const result = applyDependencyFloor({
    priority: 6, dependencies: ['C1'], tasks,
    status: 'Shipped', // being created already-closed
    activeStatuses: new Set(['Backlog', 'Doing', 'on_fire']),
  });
  assert.deepEqual(result, { priority: 6, bumped: false, floor: null, from: null });
});

test('applyDependencyFloor: omitting activeStatuses degrades to the legacy pending/in_progress/on_fire set', () => {
  const tasks = [{ id: 'C1', status: 'Doing', priority: 6 }]; // 'Doing' not in the legacy set
  const result = applyDependencyFloor({ priority: 6, dependencies: ['C1'], tasks, status: 'Backlog' });
  // status 'Backlog' also isn't in the legacy set -> new task's own status gate rejects first
  assert.deepEqual(result, { priority: 6, bumped: false, floor: null, from: null });
});
