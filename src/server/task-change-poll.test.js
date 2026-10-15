'use strict';

// C1356 — task-change-poll.js regression lock. See that file's own header comment for the
// root cause this replaces: the pre-C1356 poll hashed ONE global singleton backend, which
// in a packaged Electron build (forked server shared across every open project window,
// deliberately never given TIPATASK_PROJECT_ROOT) has permanently blank credentials —
// every tick threw, was swallowed, and tasks-updated was never broadcast at all.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTaskChangePoll, NOTIFICATIONS_EVERY_N_TICKS, FULL_RECONCILE_EVERY_N_TICKS } = require('./task-change-poll');

function fakeClient({ readyState = 1, boardWatcher = false, attentionSubscriber = false, projectPath } = {}) {
  return { readyState, _boardWatcher: boardWatcher, _attentionSubscriber: attentionSubscriber, _projectPath: projectPath };
}

function fakeWebsocket() {
  const calls = [];
  return { calls, broadcastToProject: (projectPath, type, payload) => calls.push({ projectPath, type, payload }) };
}

function backendWithTasks(tasks) {
  return { getTasksUnfiltered: async () => tasks };
}

test('task-change-poll: no watched clients — no fetch, no broadcast', async () => {
  const wss = { clients: new Set() };
  const websocket = fakeWebsocket();
  let calledFor = null;
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false,
    getBackendForPath: (p) => { calledFor = p; return backendWithTasks([]); },
  });
  await poll.tick();
  assert.equal(calledFor, null);
  assert.equal(websocket.calls.length, 0);
});

test('task-change-poll: first observation of a project never broadcasts (no prior hash to compare)', async () => {
  const wss = { clients: new Set([fakeClient({ boardWatcher: true, projectPath: '/proj/a' })]) };
  const websocket = fakeWebsocket();
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false,
    getBackendForPath: () => backendWithTasks([{ id: 'C1', status: 'pending' }]),
  });
  await poll.tick();
  assert.equal(websocket.calls.length, 0);
});

test('task-change-poll: a changed project broadcasts tasks-updated scoped to that project only', async () => {
  const wss = { clients: new Set([
    fakeClient({ boardWatcher: true, projectPath: '/proj/a' }),
    fakeClient({ attentionSubscriber: true, projectPath: '/proj/b' }),
  ]) };
  const websocket = fakeWebsocket();
  const backends = {
    '/proj/a': { tasks: [{ id: 'C1', status: 'pending' }] },
    '/proj/b': { tasks: [{ id: 'C2', status: 'pending' }] },
  };
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false,
    getBackendForPath: (p) => backendWithTasks(backends[p].tasks),
  });

  await poll.tick(); // seed both hashes — first-observation, no broadcast
  assert.equal(websocket.calls.length, 0);

  backends['/proj/a'].tasks = [{ id: 'C1', status: 'completed' }]; // only A changes
  await poll.tick();

  assert.equal(websocket.calls.length, 1);
  assert.equal(websocket.calls[0].projectPath, '/proj/a');
  assert.equal(websocket.calls[0].type, 'tasks-updated');
});

test('task-change-poll: unchanged project never broadcasts on a later tick', async () => {
  const wss = { clients: new Set([fakeClient({ boardWatcher: true, projectPath: '/proj/a' })]) };
  const websocket = fakeWebsocket();
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false,
    getBackendForPath: () => backendWithTasks([{ id: 'C1', status: 'pending' }]),
  });
  await poll.tick();
  await poll.tick();
  await poll.tick();
  assert.equal(websocket.calls.length, 0);
});

test('task-change-poll: a throwing project does not stop other projects from polling', async () => {
  const wss = { clients: new Set([
    fakeClient({ boardWatcher: true, projectPath: '/proj/bad' }),
    fakeClient({ boardWatcher: true, projectPath: '/proj/good' }),
  ]) };
  const websocket = fakeWebsocket();
  let goodTasks = [{ id: 'C1', status: 'pending' }];
  const warnings = [];
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false,
    warn: (msg) => warnings.push(msg),
    getBackendForPath: (p) => (p === '/proj/bad'
      ? { getTasksUnfiltered: async () => { throw new Error('api down'); } }
      : backendWithTasks(goodTasks)),
  });

  await poll.tick(); // seed good's hash; bad throws and is caught
  goodTasks = [{ id: 'C1', status: 'completed' }];
  await poll.tick();

  assert.equal(websocket.calls.length, 1);
  assert.equal(websocket.calls[0].projectPath, '/proj/good');
  assert.ok(warnings.some((w) => w.includes('/proj/bad') && w.includes('api down')));
});

test('task-change-poll: an unstamped client with an unbound singleton is skipped with one warning, never throws', async () => {
  const wss = { clients: new Set([fakeClient({ boardWatcher: true, projectPath: '' })]) };
  const websocket = fakeWebsocket();
  let fetchCalled = false;
  const warnings = [];
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => true,
    warn: (msg) => warnings.push(msg),
    getBackendForPath: () => { fetchCalled = true; return backendWithTasks([]); },
  });
  await poll.tick();
  await poll.tick();
  assert.equal(fetchCalled, false);
  assert.equal(websocket.calls.length, 0);
  assert.equal(warnings.filter((w) => w.includes('unbound') || w.includes('no project bound')).length, 1, 'warns once, not every tick');
});

test('task-change-poll: only board/attention watchers count — other clients are ignored', async () => {
  const wss = { clients: new Set([
    fakeClient({ boardWatcher: false, attentionSubscriber: false, projectPath: '/proj/a' }), // plain terminal/objective socket
    fakeClient({ readyState: 0, boardWatcher: true, projectPath: '/proj/b' }), // not open
  ]) };
  const websocket = fakeWebsocket();
  let fetchCount = 0;
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false,
    getBackendForPath: () => { fetchCount++; return backendWithTasks([]); },
  });
  await poll.tick();
  assert.equal(fetchCount, 0);
});

// ── TPT12 — task-activity (notifications) diffing ──

function backendWithActivity(tasks, notifications, extra = {}) {
  return {
    getTasksUnfiltered: async () => tasks,
    getNotifications: async () => ({ notifications, unread_count: notifications.length, total: notifications.length }),
    ...extra,
  };
}

test('task-activity: backend without getNotifications() never broadcasts it and never throws', async () => {
  const wss = { clients: new Set([fakeClient({ boardWatcher: true, projectPath: '/proj/a' })]) };
  const websocket = fakeWebsocket();
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false, notificationsEveryNTicks: 1,
    getBackendForPath: () => backendWithTasks([]), // no getNotifications at all
  });
  await poll.tick();
  assert.equal(websocket.calls.length, 0);
});

test('task-activity: broadcasts on the FIRST computation, unlike tasks-updated', async () => {
  const wss = { clients: new Set([fakeClient({ boardWatcher: true, projectPath: '/proj/a' })]) };
  const websocket = fakeWebsocket();
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false, notificationsEveryNTicks: 1,
    getBackendForPath: () => backendWithActivity([], [
      { id: 5, task_key: 'TPT12', title: 'New comment on TPT12', body: 'hi', event_type: 'comment', actor: { id: 2, name: 'B' }, created_at: '2026-01-01' },
    ]),
  });
  await poll.tick();
  const activityCalls = websocket.calls.filter((c) => c.type === 'task-activity');
  assert.equal(activityCalls.length, 1);
  assert.deepEqual(activityCalls[0].payload.activity, {
    TPT12: { count: 1, ids: [5], latest: { id: 5, title: 'New comment on TPT12', body: 'hi', event_type: 'comment', actor: { id: 2, name: 'B' }, created_at: '2026-01-01' } },
  });
});

test('task-activity: unchanged notifications never re-broadcast', async () => {
  const wss = { clients: new Set([fakeClient({ boardWatcher: true, projectPath: '/proj/a' })]) };
  const websocket = fakeWebsocket();
  const rows = [{ id: 1, task_key: 'TPT1', title: 't', body: '', event_type: 'comment', actor: null, created_at: 'x' }];
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false, notificationsEveryNTicks: 1,
    getBackendForPath: () => backendWithActivity([], rows),
  });
  await poll.tick();
  await poll.tick();
  await poll.tick();
  assert.equal(websocket.calls.filter((c) => c.type === 'task-activity').length, 1);
});

test('task-activity: runs only every Nth tick (default cadence), tasks-updated still runs every tick', async () => {
  const wss = { clients: new Set([fakeClient({ boardWatcher: true, projectPath: '/proj/a' })]) };
  const websocket = fakeWebsocket();
  let tasks = [{ id: 'C1', status: 'pending' }];
  let notifCallCount = 0;
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false, // default N=2
    getBackendForPath: () => ({
      getTasksUnfiltered: async () => tasks,
      getNotifications: async () => { notifCallCount++; return { notifications: [], unread_count: 0, total: 0 }; },
    }),
  });
  await poll.tick(); // tick 1 — no notifications fetch yet
  assert.equal(notifCallCount, 0);
  await poll.tick(); // tick 2 — fetch + first-computation broadcast (empty activity)
  assert.equal(notifCallCount, 1);
  assert.equal(websocket.calls.filter((c) => c.type === 'task-activity').length, 1);

  tasks = [{ id: 'C1', status: 'completed' }];
  await poll.tick(); // tick 3 — tasks-updated fires, notifications not due again
  assert.equal(notifCallCount, 1);
  assert.equal(websocket.calls.filter((c) => c.type === 'tasks-updated').length, 1);
});

test('task-activity: a throwing notifications fetch never suppresses tasks-updated and never rejects the tick', async () => {
  const wss = { clients: new Set([fakeClient({ boardWatcher: true, projectPath: '/proj/a' })]) };
  const websocket = fakeWebsocket();
  const warnings = [];
  let tasks = [{ id: 'C1', status: 'pending' }];
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false, notificationsEveryNTicks: 1,
    warn: (msg) => warnings.push(msg),
    getBackendForPath: () => ({
      getTasksUnfiltered: async () => tasks,
      getNotifications: async () => { throw new Error('api down'); },
    }),
  });
  await poll.tick(); // seed task hash
  tasks = [{ id: 'C1', status: 'completed' }];
  await poll.tick();
  assert.equal(websocket.calls.filter((c) => c.type === 'tasks-updated').length, 1);
  assert.equal(websocket.calls.filter((c) => c.type === 'task-activity').length, 0);
  assert.ok(warnings.some((w) => w.includes('notifications') && w.includes('api down')));
});

test('task-activity: skips the fetch when the backend reports a non-connected state', async () => {
  const wss = { clients: new Set([fakeClient({ boardWatcher: true, projectPath: '/proj/a' })]) };
  const websocket = fakeWebsocket();
  let fetchCalled = false;
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false, notificationsEveryNTicks: 1,
    getBackendForPath: () => ({
      getTasksUnfiltered: async () => [],
      getConnectionState: () => 'unauthorized',
      getNotifications: async () => { fetchCalled = true; return { notifications: [], unread_count: 0, total: 0 }; },
    }),
  });
  await poll.tick();
  assert.equal(fetchCalled, false);
});

test('task-activity: multiple rows for one task merge into count/ids, newest row wins latest; rows with no task_key are dropped', async () => {
  const wss = { clients: new Set([fakeClient({ boardWatcher: true, projectPath: '/proj/a' })]) };
  const websocket = fakeWebsocket();
  const rows = [
    { id: 9, task_key: 'TPT1', title: 'newest', body: '', event_type: 'status_changed', actor: null, created_at: '2' },
    { id: 3, task_key: 'TPT1', title: 'older', body: '', event_type: 'comment', actor: null, created_at: '1' },
    { id: 4, task_key: null, title: 'orphan', body: '', event_type: 'task_created', actor: null, created_at: '1' },
  ];
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false, notificationsEveryNTicks: 1,
    getBackendForPath: () => backendWithActivity([], rows),
  });
  await poll.tick();
  const { activity } = websocket.calls.find((c) => c.type === 'task-activity').payload;
  assert.deepEqual(Object.keys(activity), ['TPT1']);
  assert.equal(activity.TPT1.count, 2);
  assert.deepEqual(activity.TPT1.ids, [9, 3]);
  assert.equal(activity.TPT1.latest.title, 'newest');
});

test('task-activity: warns (does not throw) when unread_count exceeds the returned rows (200-cap truncation)', async () => {
  const wss = { clients: new Set([fakeClient({ boardWatcher: true, projectPath: '/proj/a' })]) };
  const websocket = fakeWebsocket();
  const warnings = [];
  const poll = createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false, notificationsEveryNTicks: 1,
    warn: (msg) => warnings.push(msg),
    getBackendForPath: () => ({
      getTasksUnfiltered: async () => [],
      getNotifications: async () => ({ notifications: [{ id: 1, task_key: 'TPT1', title: 't', body: '', event_type: 'comment', actor: null, created_at: 'x' }], unread_count: 250, total: 250 }),
    }),
  });
  await poll.tick();
  assert.ok(warnings.some((w) => w.includes('truncated')));
});

// ── TPT610 — change-stamp path ──

function stampBackend(state) {
  return {
    getTaskChangeStamp: async () => {
      state.stampCalls += 1;
      if (state.stampError) throw state.stampError;
      return state.stamp;
    },
    getTasksUnfiltered: async () => { state.listCalls += 1; return state.tasks; },
  };
}

function stampState(extra = {}) {
  return {
    stamp: { count: 1, max_id: 1, max_updated_at: '2026-10-12T10:00:00.000Z' },
    tasks: [{ id: 'C1', status: 'pending', tags: [] }],
    stampCalls: 0, listCalls: 0, stampError: null, ...extra,
  };
}

function stampPoll(state, websocket, opts = {}) {
  const wss = { clients: new Set([fakeClient({ boardWatcher: true, projectPath: '/proj/a' })]) };
  return createTaskChangePoll({
    wss, websocket, isSingletonUnbound: () => false, warn: () => {}, log: () => {},
    getBackendForPath: () => stampBackend(state), ...opts,
  });
}

const updates = (websocket) => websocket.calls.filter((c) => c.type === 'tasks-updated').length;

test('task-change-poll: defaults — notifications every 2nd tick, full reconcile every 10th', () => {
  assert.equal(NOTIFICATIONS_EVERY_N_TICKS, 2);
  assert.equal(FULL_RECONCILE_EVERY_N_TICKS, 10);
});

test('task-change-poll: a stamp change broadcasts tasks-updated once, without fetching the full list', async () => {
  const state = stampState();
  const websocket = fakeWebsocket();
  const poll = stampPoll(state, websocket);
  await poll.tick(); // baseline: stamp + list
  assert.equal(state.listCalls, 1, 'the first tick takes a list baseline');
  await poll.tick();
  assert.equal(updates(websocket), 0, 'unchanged stamp — no broadcast');

  state.stamp = { count: 1, max_id: 1, max_updated_at: '2026-10-12T10:00:05.000Z' };
  await poll.tick();
  assert.equal(updates(websocket), 1);
  await poll.tick();
  assert.equal(updates(websocket), 1, 'the same stamp never re-broadcasts');
  assert.equal(state.listCalls, 1, 'non-reconcile ticks never fetch the full list');
  assert.equal(state.stampCalls, 4);
});

test('task-change-poll: a null stamp (route missing) falls back to hashing the full list every tick', async () => {
  const state = stampState({ stamp: null });
  const websocket = fakeWebsocket();
  const poll = stampPoll(state, websocket);
  await poll.tick();
  await poll.tick();
  assert.equal(state.listCalls, 2);
  assert.equal(updates(websocket), 0);
  state.tasks = [{ id: 'C1', status: 'completed', tags: [] }];
  await poll.tick();
  assert.equal(updates(websocket), 1);
});

test('task-change-poll: a throwing stamp rejects the tick without falling back, and the next tick uses the stamp again', async () => {
  const state = stampState();
  const websocket = fakeWebsocket();
  const warnings = [];
  const poll = stampPoll(state, websocket, { warn: (m) => warnings.push(m) });
  await poll.tick(); // baseline
  const err = new Error('API unreachable: incorrect header check');
  err.code = 'Z_DATA_ERROR';
  err.networkError = true;
  state.stampError = err;
  state.tasks = [{ id: 'C1', status: 'completed', tags: [] }];
  await poll.tick();
  assert.equal(updates(websocket), 0);
  assert.equal(state.listCalls, 1, 'a transport failure must not trigger the full-list fallback');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Failed to poll tasks for project=\/proj\/a/);

  state.stampError = null;
  state.stamp = { count: 2, max_id: 2, max_updated_at: '2026-10-12T10:01:00.000Z' };
  await poll.tick();
  assert.equal(updates(websocket), 1);
  assert.equal(state.listCalls, 1);
});

test('task-change-poll: the periodic full reconcile catches a change the stamp misses (tag-only edit)', async () => {
  const state = stampState();
  const websocket = fakeWebsocket();
  const poll = stampPoll(state, websocket, { fullReconcileEveryNTicks: 3 });
  await poll.tick(); // tick 1 — baseline
  state.tasks = [{ id: 'C1', status: 'pending', tags: ['bugfix'] }]; // stamp unchanged
  await poll.tick(); // tick 2 — stamp only, change unseen
  assert.equal(updates(websocket), 0);
  await poll.tick(); // tick 3 — reconcile
  assert.equal(state.listCalls, 2);
  assert.equal(updates(websocket), 1);
});

test('task-change-poll: stamp and list both changed on a reconcile tick broadcast only once', async () => {
  const state = stampState();
  const websocket = fakeWebsocket();
  const poll = stampPoll(state, websocket, { fullReconcileEveryNTicks: 2 });
  await poll.tick(); // tick 1 — baseline
  state.stamp = { count: 2, max_id: 2, max_updated_at: '2026-10-12T10:02:00.000Z' };
  state.tasks = [...state.tasks, { id: 'C2', status: 'pending', tags: [] }];
  await poll.tick(); // tick 2 — both differ
  assert.equal(updates(websocket), 1);
  await poll.tick(); // tick 3 — stamp only, nothing new
  await poll.tick(); // tick 4 — reconcile against the tick-2 list baseline, nothing new
  assert.equal(updates(websocket), 1);
});
