'use strict';

// C1017: remapCollidingIds() must not treat a live reserve_task_keys placeholder as an
// id collision. Before this fix, a planner-reserved key (e.g. "C214") always collided
// with its own placeholder row (title 'New task', sentinel description) because the
// idempotency check only skipped remap for an EXACT title/description match — which a
// real proposal never has. That silently remapped the reserved key away, forcing the
// server to burn a second reservation and orphaning the first (see api-backend.js
// assignIncomingNewTaskIds and reservation-placeholder.js).

const { test } = require('node:test');
const assert = require('node:assert');

const { remapCollidingIds } = require('./id-remap');

const RESERVED_DESCRIPTION = 'Reserved key — pending finalization.';

test('remapCollidingIds keeps a proposal id that matches a live reservation placeholder', () => {
  const incoming = [
    { id: 'C214', title: 'Write onboarding docs', description: 'Real content from the planner' },
  ];
  const live = [
    { id: 'C214', title: 'New task', description: RESERVED_DESCRIPTION, status: 'pending', isReservation: true },
  ];

  const { tasks, idRemap } = remapCollidingIds(incoming, live);

  assert.strictEqual(tasks[0].id, 'C214', 'reserved key must survive, not be remapped');
  assert.strictEqual(idRemap.size, 0);
});

test('remapCollidingIds keeps a proposal id via the legacy sentinel fallback (no isReservation flag)', () => {
  // Simulates a pre-C1017 API deployment/row: no is_reservation column mapped yet,
  // only the status+description sentinel to go on.
  const incoming = [
    { id: 'C500', title: 'Fix login redirect', description: 'Real content from the planner' },
  ];
  const live = [
    { id: 'C500', title: 'New task', description: RESERVED_DESCRIPTION, status: 'pending' },
  ];

  const { tasks, idRemap } = remapCollidingIds(incoming, live);

  assert.strictEqual(tasks[0].id, 'C500');
  assert.strictEqual(idRemap.size, 0);
});

test('remapCollidingIds still remaps a genuine same-id collision (another tab already saved real content)', () => {
  const incoming = [
    { id: 'C77', title: 'My new task', description: 'Something the planner proposed' },
  ];
  const live = [
    { id: 'C77', title: 'Someone else already saved this', description: 'Unrelated real content', status: 'pending' },
    { id: 'C78', title: 'Other existing task', description: 'x', status: 'pending' },
  ];

  const { tasks, idRemap } = remapCollidingIds(incoming, live);

  assert.notStrictEqual(tasks[0].id, 'C77', 'genuine collision must still be remapped');
  assert.strictEqual(idRemap.get('C77'), tasks[0].id);
  assert.match(tasks[0].id, /^C\d+$/);
});

// C1483: remap must stay inside the colliding key's OWN prefix, not fall back to a
// hardcoded global 'C'/'H' pair — a project with its own task_prefix (e.g. 'TPT') would
// otherwise get a remapped key that doesn't belong to it.

test('remapCollidingIds remaps a colliding per-project-prefix key to its own prefix, not C', () => {
  const incoming = [
    { id: 'TPT214', title: 'My new task', description: 'Something the planner proposed' },
  ];
  const live = [
    { id: 'TPT214', title: 'Someone else already saved this', description: 'Unrelated real content', status: 'pending' },
    { id: 'TPT215', title: 'Other existing task', description: 'x', status: 'pending' },
  ];

  const { tasks, idRemap } = remapCollidingIds(incoming, live);

  assert.notStrictEqual(tasks[0].id, 'TPT214');
  assert.strictEqual(idRemap.get('TPT214'), tasks[0].id);
  assert.match(tasks[0].id, /^TPT\d+$/);
  assert.strictEqual(tasks[0].id, 'TPT216', 'must skip past the highest existing TPT number, not just +1 from the colliding one');
});

test('remapCollidingIds remaps a colliding H key to H, independent of any C/TPT counters', () => {
  const incoming = [
    { id: 'H5', title: 'My new human task', description: 'Something the planner proposed' },
  ];
  const live = [
    { id: 'H5', title: 'Someone else already saved this', description: 'Unrelated real content', status: 'pending' },
    { id: 'TPT300', title: 'Unrelated coding task', description: 'x', status: 'pending' },
  ];

  const { tasks, idRemap } = remapCollidingIds(incoming, live);

  assert.match(tasks[0].id, /^H\d+$/);
  assert.strictEqual(idRemap.get('H5'), tasks[0].id);
});

test('remapCollidingIds rewrites the remapped id inside dependencies and parentId of other incoming tasks', () => {
  const incoming = [
    { id: 'TPT10', title: 'Collides', description: 'planner content' },
    { id: 'TPT99', title: 'Depends on the colliding task', description: 'x', dependencies: ['TPT10'], parentId: 'TPT10' },
  ];
  const live = [
    { id: 'TPT10', title: 'Already saved for real', description: 'unrelated', status: 'pending' },
  ];

  const { tasks, idRemap } = remapCollidingIds(incoming, live);

  const remapped = idRemap.get('TPT10');
  assert.ok(remapped && remapped !== 'TPT10' && remapped !== 'TPT99', `remapped id ${remapped} must not collide with the sibling task's own id`);
  const dependent = tasks.find(t => t.id === 'TPT99');
  assert.deepEqual(dependent.dependencies, [remapped]);
  assert.strictEqual(dependent.parentId, remapped);
});

test('remapCollidingIds treats an idempotent re-PUT (identical title+description) as a no-op', () => {
  const incoming = [
    { id: 'C90', title: 'Same task', description: 'Same description' },
  ];
  const live = [
    { id: 'C90', title: 'Same task', description: 'Same description', status: 'pending' },
  ];

  const { tasks, idRemap } = remapCollidingIds(incoming, live);

  assert.strictEqual(tasks[0].id, 'C90');
  assert.strictEqual(idRemap.size, 0);
});
