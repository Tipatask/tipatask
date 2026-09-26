'use strict';

// (C1463) Objective tab close — resolveObjectiveDescendants()'s whole-descendant-tree BFS +
// role-derived "all closed" check, and terminateObjectiveSessions()'s session filtering.
// Pure over a fake backend/sessions Map — no real PTY, no network, no DB. See
// ai/architecture/tt-task-subtasks.md § Objective nav tabs and tt-websocket.md for the
// ?terminateChildren=1 connect branch this backs.

process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveObjectiveDescendants, terminateObjectiveSessions } = require('./ws-handlers');

// No getStatuses() on this stub -> fetchStatusContext() (status-roles.js) falls back to
// LEGACY_STATUSES, whose closed roles are exactly 'completed' (complete) and 'canceled'
// (canceled) — the two statuses these tests use.
function fakeBackend(rows) {
  return { getTasksUnfiltered: async () => rows };
}

// ── resolveObjectiveDescendants ──

test('resolveObjectiveDescendants: collects direct children, allClosed true when all closed', async () => {
  const backend = fakeBackend([
    { id: 'C1', dbId: 1, parentDbId: null, status: 'in_progress', isReservation: false },
    { id: 'C2', dbId: 2, parentDbId: 1, status: 'completed', isReservation: false },
    { id: 'C3', dbId: 3, parentDbId: 1, status: 'canceled', isReservation: false },
  ]);
  const { taskKeys, allClosed } = await resolveObjectiveDescendants('C1', backend);
  assert.deepEqual([...taskKeys].sort(), ['C2', 'C3']);
  assert.equal(allClosed, true);
});

test('resolveObjectiveDescendants: allClosed false when a direct child is still open', async () => {
  const backend = fakeBackend([
    { id: 'C1', dbId: 1, parentDbId: null, status: 'in_progress', isReservation: false },
    { id: 'C2', dbId: 2, parentDbId: 1, status: 'completed', isReservation: false },
    { id: 'C3', dbId: 3, parentDbId: 1, status: 'pending', isReservation: false },
  ]);
  const { allClosed } = await resolveObjectiveDescendants('C1', backend);
  assert.equal(allClosed, false);
});

test('resolveObjectiveDescendants: walks the WHOLE descendant tree, not just direct children', async () => {
  const backend = fakeBackend([
    { id: 'C1', dbId: 1, parentDbId: null, status: 'in_progress', isReservation: false },
    { id: 'C2', dbId: 2, parentDbId: 1, status: 'in_progress', isReservation: false }, // nested sub-objective
    { id: 'C3', dbId: 3, parentDbId: 2, status: 'completed', isReservation: false },   // grandchild
    { id: 'C4', dbId: 4, parentDbId: 2, status: 'pending', isReservation: false },     // grandchild, still open
  ]);
  const { taskKeys, allClosed } = await resolveObjectiveDescendants('C1', backend);
  assert.deepEqual([...taskKeys].sort(), ['C2', 'C3', 'C4']);
  assert.equal(allClosed, false); // C2 (in_progress) and C4 (pending) are both open
});

test('resolveObjectiveDescendants: reservation rows are excluded from taskKeys and from the closed check', async () => {
  const backend = fakeBackend([
    { id: 'C1', dbId: 1, parentDbId: null, status: 'in_progress', isReservation: false },
    { id: 'C2', dbId: 2, parentDbId: 1, status: 'completed', isReservation: false },
    { id: 'C3', dbId: 3, parentDbId: 1, status: 'pending', isReservation: true }, // unfinalized placeholder
  ]);
  const { taskKeys, allClosed } = await resolveObjectiveDescendants('C1', backend);
  assert.deepEqual([...taskKeys], ['C2']);
  assert.equal(allClosed, true); // the open reservation placeholder must not block the tick/gate
});

test('resolveObjectiveDescendants: zero descendants is vacuously all-closed', async () => {
  const backend = fakeBackend([
    { id: 'C1', dbId: 1, parentDbId: null, status: 'in_progress', isReservation: false },
  ]);
  const { taskKeys, allClosed } = await resolveObjectiveDescendants('C1', backend);
  assert.equal(taskKeys.size, 0);
  assert.equal(allClosed, true);
});

test('resolveObjectiveDescendants: unknown parentKey resolves to empty/vacuously-closed rather than throwing', async () => {
  const backend = fakeBackend([
    { id: 'C1', dbId: 1, parentDbId: null, status: 'in_progress', isReservation: false },
  ]);
  const { taskKeys, allClosed } = await resolveObjectiveDescendants('C999', backend);
  assert.equal(taskKeys.size, 0);
  assert.equal(allClosed, true);
});

// ── terminateObjectiveSessions ──

function fakeSession(overrides) {
  return { type: 'terminal', alive: false, pty: null, ws: null, buffer: '', ...overrides };
}

test('terminateObjectiveSessions: terminates only terminal sessions whose id is in taskKeys', () => {
  const sessions = new Map([
    ['C2', fakeSession({ tabId: 'C2' })],
    ['C3', fakeSession({ tabId: 'C3' })],
    ['C9', fakeSession({ tabId: 'C9' })], // not a descendant — must survive
  ]);
  const closedIds = terminateObjectiveSessions(new Set(['C2', 'C3']), sessions, null, '');
  assert.deepEqual(closedIds.sort(), ['C2', 'C3']);
  assert.equal(sessions.has('C2'), false);
  assert.equal(sessions.has('C3'), false);
  assert.equal(sessions.has('C9'), true);
});

test('terminateObjectiveSessions: skips non-terminal sessions (objective/specChat)', () => {
  const sessions = new Map([
    ['C2', fakeSession({ tabId: 'C2', type: 'objective' })],
  ]);
  const closedIds = terminateObjectiveSessions(new Set(['C2']), sessions, null, '');
  assert.deepEqual(closedIds, []);
  assert.equal(sessions.has('C2'), true); // untouched
});

test('terminateObjectiveSessions: skips a session on a different project (Electron multi-window)', () => {
  const sessions = new Map([
    ['C2', fakeSession({ tabId: 'C2', projectPath: '/other/project' })],
  ]);
  const closedIds = terminateObjectiveSessions(new Set(['C2']), sessions, null, '/this/project');
  assert.deepEqual(closedIds, []);
  assert.equal(sessions.has('C2'), true); // untouched
});

test('terminateObjectiveSessions: matches on session.tabId, falling back to session.taskId', () => {
  const sessions = new Map([
    ['C2\0/proj', fakeSession({ tabId: undefined, taskId: 'C2' })],
  ]);
  const closedIds = terminateObjectiveSessions(new Set(['C2']), sessions, null, '');
  assert.deepEqual(closedIds, ['C2']);
});

test('terminateObjectiveSessions: empty taskKeys terminates nothing', () => {
  const sessions = new Map([
    ['C2', fakeSession({ tabId: 'C2' })],
  ]);
  const closedIds = terminateObjectiveSessions(new Set(), sessions, null, '');
  assert.deepEqual(closedIds, []);
  assert.equal(sessions.has('C2'), true);
});
