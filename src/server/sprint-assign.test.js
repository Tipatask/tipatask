'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveAndAssign, minStepForDeps } = require('./sprint-assign');

// C899: verify new tasks land in highest active sprint (Math.max), not lowest
test('new task joins highest active sprint when multiple active sprints exist', async () => {
  const backend = makeBackend({
    tasks: [
      { id: 'C160', status: 'pending', category: 'CODING', priority: 160 },
      { id: 'C194', status: 'in_progress', category: 'CODING', priority: 194 },
    ],
    sprints: [
      { id: 160, number: 160, name: 'Sprint 160' },
      { id: 194, number: 194, name: 'Sprint 194' },
    ],
  });
  const changes = [{
    type: 'new',
    task: {
      id: 'new-c',
      title: 'New task',
      description: 'Should land in sprint 194.',
      category: 'CODING',
      status: 'pending',
      priority: 0,
      dependencies: [],
      tags: ['feature', 'tt-task-board'],
    },
  }];

  await resolveAndAssign(changes, backend, { TASK_BACKEND: 'api' });

  assert.equal(changes[0].task.priority, 194, 'task must join the highest active sprint (194), not the lowest (160)');
  assert.deepEqual(backend.createdSprints, [], 'no new sprint created when target sprint already exists');
});

function makeBackend({ tasks = [], sprints = [] } = {}) {
  const createdSprints = [];
  return {
    createdSprints,
    async getTasks() {
      return tasks;
    },
    async getSprints() {
      return sprints;
    },
    async createSprint(name, number) {
      createdSprints.push({ name, number });
      return { name, number };
    },
  };
}

for (const priority of [0, null, undefined]) {
  test(`unset regular priority ${priority} respects dependency floor`, async () => {
    const backend = makeBackend({ tasks: [{ id: 'TPT1', category: 'CODING', status: 'in_progress', priority: 42 }] });
    const changes = [{ type: 'new', task: { id: 'TPT2', priority, dependencies: ['TPT1'] } }];
    await resolveAndAssign(changes, backend, {});
    assert.equal(changes[0].task.priority, 43);
  });
}

test('a pin without a priority is unset, not an explicit Backlog choice', async () => {
  const backend = makeBackend();
  const changes = [{ type: 'new', task: { id: 'TPT1', priority: null } }];
  await resolveAndAssign(changes, backend, {}, new Set(['TPT1']));
  assert.equal(changes[0].task.priority, 1);
});

test('performance suggestion tasks stay in backlog when proposed priority is zero', async () => {
  const backend = makeBackend({
    tasks: [{ id: 'C160', status: 'pending', category: 'CODING', priority: 160 }],
    sprints: [{ id: 160, number: 160, name: 'Sprint 160' }],
  });
  const changes = [{
    type: 'new',
    task: {
      id: 'new-perf',
      title: 'Reduce objective latency',
      description: 'Profile objective chat startup.',
      category: 'CODING',
      status: 'pending',
      priority: 0,
      dependencies: [],
      tags: ['bugfix', 'tt-performance-suggestions'],
    },
  }];

  await resolveAndAssign(changes, backend, { TASK_BACKEND: 'api' });

  assert.equal(changes[0].task.priority, 0);
  assert.deepEqual(backend.createdSprints, []);
});

test('_efficiencyHint cards without the tt-performance-suggestions tag stay in backlog too', async () => {
  const backend = makeBackend({
    tasks: [{ id: 'C160', status: 'pending', category: 'CODING', priority: 160 }],
    sprints: [{ id: 160, number: 160, name: 'Sprint 160' }],
  });
  const changes = [{
    type: 'new',
    _efficiencyHint: true,
    task: {
      id: 'new-hint',
      title: 'Batch redundant Glob calls',
      description: 'Dedupe repeated Glob calls within a turn.',
      category: 'CODING',
      status: 'pending',
      priority: 0,
      dependencies: [],
      tags: ['bugfix'],
    },
  }];

  await resolveAndAssign(changes, backend, { TASK_BACKEND: 'api' });

  assert.equal(changes[0].task.priority, 0);
  assert.deepEqual(changes[0].task.tags, ['bugfix', 'tt-performance-suggestions']);
  assert.deepEqual(backend.createdSprints, []);
});

test('performance suggestion tasks keep explicit nonzero sprint priority', async () => {
  const backend = makeBackend({
    tasks: [{ id: 'C160', status: 'pending', category: 'CODING', priority: 160 }],
    sprints: [{ id: 160, number: 160, name: 'Sprint 160' }],
  });
  const changes = [{
    type: 'new',
    task: {
      id: 'new-perf',
      title: 'Reduce objective latency',
      description: 'Profile objective chat startup.',
      category: 'CODING',
      status: 'pending',
      priority: 161,
      dependencies: [],
      tags: ['bugfix', 'tt-performance-suggestions'],
    },
  }];

  await resolveAndAssign(changes, backend, { TASK_BACKEND: 'api' });

  assert.equal(changes[0].task.priority, 161);
  assert.deepEqual(backend.createdSprints, [{ name: 'Sprint 161', number: 161 }]);
});

test('regular priority-zero tasks still join active numeric sprint', async () => {
  const backend = makeBackend({
    tasks: [{ id: 'C160', status: 'pending', category: 'CODING', priority: 160 }],
    sprints: [{ id: 160, number: 160, name: 'Sprint 160' }],
  });
  const changes = [{
    type: 'new',
    task: {
      id: 'new-regular',
      title: 'Fix board rendering',
      description: 'Update board rendering flow.',
      category: 'CODING',
      status: 'pending',
      priority: 0,
      dependencies: [],
      tags: ['bugfix', 'tt-task-board'],
    },
  }];

  await resolveAndAssign(changes, backend, { TASK_BACKEND: 'api' });

  assert.equal(changes[0].task.priority, 160);
  assert.deepEqual(backend.createdSprints, []);
});

test('product caching feature without performance suggestion tag joins active sprint', async () => {
  const backend = makeBackend({
    tasks: [{ id: 'C161', status: 'pending', category: 'CODING', priority: 161 }],
    sprints: [{ id: 161, number: 161, name: 'Sprint 161' }],
  });
  const changes = [{
    type: 'new',
    task: {
      id: 'new-cache-feature',
      title: 'Add API cache',
      description: 'Add cache to product API endpoint.',
      category: 'CODING',
      status: 'pending',
      priority: 0,
      dependencies: [],
      tags: ['feature', 'caching', 'tt-api-backend'],
    },
  }];

  await resolveAndAssign(changes, backend, { TASK_BACKEND: 'api' });

  assert.equal(changes[0].task.priority, 161);
  assert.deepEqual(changes[0].task.tags, ['feature', 'caching', 'tt-api-backend']);
  assert.deepEqual(backend.createdSprints, []);
});

// C899: two chained new tasks start at current sprint and land in consecutive sprints
test('two chained new tasks land in consecutive sprints starting at the highest active sprint', async () => {
  const backend = makeBackend({
    tasks: [
      { id: 'C160', status: 'pending', category: 'CODING', priority: 160 },
      { id: 'C194', status: 'in_progress', category: 'CODING', priority: 194 },
    ],
    sprints: [
      { id: 160, number: 160, name: 'Sprint 160' },
      { id: 194, number: 194, name: 'Sprint 194' },
    ],
  });
  // A has no deps; B depends on A — must land one sprint after A.
  const changes = [
    {
      type: 'new',
      task: {
        id: 'new-a',
        title: 'Task A',
        description: 'Independent task.',
        category: 'CODING',
        status: 'pending',
        priority: 0,
        dependencies: [],
        tags: ['feature'],
      },
    },
    {
      type: 'new',
      task: {
        id: 'new-b',
        title: 'Task B',
        description: 'Depends on A.',
        category: 'CODING',
        status: 'pending',
        priority: 0,
        dependencies: ['new-a'],
        tags: ['feature'],
      },
    },
  ];

  await resolveAndAssign(changes, backend, { TASK_BACKEND: 'api' });

  const a = changes.find(c => c.task.id === 'new-a').task;
  const b = changes.find(c => c.task.id === 'new-b').task;

  assert.equal(a.priority, 194, 'Task A must join the highest active sprint (194)');
  assert.equal(b.priority, 195, 'Task B (depends on A) must land in the next consecutive sprint (195)');
  // Sprint 194 already exists — no creation. Sprint 195 is new — must be created.
  assert.deepEqual(backend.createdSprints, [{ name: 'Sprint 195', number: 195 }]);
});

// ── minStepForDeps (C1052) — direct standalone-Map calls, no topo-sort involved.
// mcp/priority-fallback.js's applyDependencyFloor calls this the same way: a plain
// id->priority Map, no changes[]/pinned-id shape required.

test('minStepForDeps: empty deps array returns 1 (no constraints)', () => {
  assert.equal(minStepForDeps([], new Map()), 1);
});

test('minStepForDeps: undefined deps returns 1 (the `deps || []` guard)', () => {
  assert.equal(minStepForDeps(undefined, new Map()), 1);
});

test('minStepForDeps: deps not present in the map are ignored, returns 1', () => {
  const map = new Map([['C1', 5]]);
  assert.equal(minStepForDeps(['C999'], map), 1);
});

test('minStepForDeps: a dep at priority 0 (backlog) is ignored, returns 1', () => {
  const map = new Map([['C1', 0]]);
  assert.equal(minStepForDeps(['C1'], map), 1);
});

test('minStepForDeps: a dep with value null is ignored, returns 1', () => {
  const map = new Map([['C1', null]]);
  assert.equal(minStepForDeps(['C1'], map), 1);
});

test('minStepForDeps: single dep at priority 5 returns 6', () => {
  const map = new Map([['C1', 5]]);
  assert.equal(minStepForDeps(['C1'], map), 6);
});

test('minStepForDeps: returns max(dep priorities) + 1 across multiple deps', () => {
  const map = new Map([['C1', 3], ['C2', 7], ['C3', 5]]);
  assert.equal(minStepForDeps(['C1', 'C2', 'C3'], map), 8);
});

test('minStepForDeps: mix of known and unknown deps uses only the known ones', () => {
  const map = new Map([['C1', 4]]);
  assert.equal(minStepForDeps(['C1', 'C999'], map), 5);
});
