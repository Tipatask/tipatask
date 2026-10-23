import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
function productionFunction(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'));
  assert.ok(match, `${name} exists`);
  return match[0];
}

function harness(tab = 'board') {
  const original = { id: 'TPT9070', status: 'in_progress', title: 'Existing task' };
  const cached = { tasks: [{ ...original }], storedAt: Date.now() };
  const calls = { renders: [], nav: [], removed: [] };
  const timers = new Map();
  let nextTimer = 0;
  const state = {
    activeTab: tab, activeSessions: new Set([original.id]), exitedSessions: new Set(),
    sessionMeta: new Map(), taskStatusById: new Map([[original.id, original.status]]),
    taskTitleById: new Map(), taskPermissionModeById: new Map(), pendingTaskIds: new Set(), selectedCardIds: new Set(),
    _lastVisibleTasks: [{ ...original }],
  };
  const context = vm.createContext({
    state, console, Map, Set, Date,
    _boardTaskCache: new Map([['root', cached]]), _boardTaskRefreshes: new Map(),
    _boardTaskCacheGeneration: 0, _loadAndRenderGeneration: 0,
    _syncNavStatusesInFlight: null, _syncNavStatusesPending: false, boardRefreshTimer: null,
    _cloneBoardJson: value => JSON.parse(JSON.stringify(value)),
    _boardSnapshotFingerprint: value => JSON.stringify(value.tasks),
    fetchObjectiveTaskState: async () => [{ ...original, status: 'completed' }],
    isCompleteName: value => value === 'completed', isClosedName: value => ['completed', 'canceled'].includes(value),
    isTasksSectionTab: () => ['board', 'backlog', 'todo', 'list'].includes(state.activeTab),
    isDropInProgress: () => false, isDragging: () => false,
    app: { querySelector: () => null }, CSS: { escape: value => value },
    syncObjectiveTabsState: () => false, repaintObjectiveNavTabs() {},
    applyNewlyAssigned() {}, applySearchFilter() {}, updateBulkActionBar() {},
    removeCardFromDom: id => calls.removed.push(id),
    applyTaskPatch: () => 'patched',
    loadAndRender: async options => calls.renders.push(options),
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    window: { TipTask: {
      completionNotifications: { observeTaskStatusForCompletion: (map, id, status) => {
        const previous = map.get(id);
        if (status !== undefined) map.set(id, status);
        return previous;
      } },
      taskBoard: { syncActiveSessionsNav: () => calls.nav.push(new Map(state.taskStatusById)) },
    } },
    TipTask: { attentionState: { clearAttention() {} } },
  });
  vm.runInContext([
    'invalidateLoadAndRender', 'patchCachedBoardTasks', 'staleBoardTaskCache',
    'applyObjectiveTaskState', 'applyObjectiveTaskUpdate', 'syncNavStatusesFromServer',
    'applyTaskDeletedEvent', 'handleObjectiveTaskStateEvent',
  ].map(productionFunction).join('\n'), context);
  return { context, state, cached, calls, timers,
    send: message => context.handleObjectiveTaskStateEvent(message),
    flush: async () => { for (const [id, fn] of timers) { timers.delete(id); await fn(); } },
  };
}

test('a completion on Create updates the rail and cached board before any tab render', () => {
  const h = harness('new_task');
  h.send({ type: 'task:updated', task: { id: 'TPT9070', status: 'completed' } });
  assert.equal(h.state.taskStatusById.get('TPT9070'), 'completed');
  assert.equal(h.cached.tasks[0].status, 'completed', 'returning to a cached board must not restore in_progress');
  assert.equal(h.calls.nav.at(-1).get('TPT9070'), 'completed');
  assert.equal(h.calls.renders.length, 0, 'keep the composer mounted');
  assert.ok(h.context._loadAndRenderGeneration > 0, 'cancel a board fetch that began before the completion');
});

test('status-only reconciliation keeps the completed status in board caches', async () => {
  const h = harness();
  await h.context.syncNavStatusesFromServer();
  assert.equal(h.state.taskStatusById.get('TPT9070'), 'completed');
  assert.equal(h.cached.tasks[0].status, 'completed');
  assert.equal(h.calls.nav.at(-1).get('TPT9070'), 'completed');
});

test('permission patches update nav state outside the board window and keep explicit inheritance', () => {
  for (const tab of ['board', 'objective', 'new_task']) {
    const h = harness(tab);
    h.cached.tasks = [];
    h.state._lastVisibleTasks = [];
    h.send({ type: 'task:updated', task: { id: 'TPT9070', agentPermissionMode: 'bypass' } });
    assert.equal(h.state.taskPermissionModeById.get('TPT9070'), 'bypass');
    h.send({ type: 'task:updated', task: { id: 'TPT9070', title: 'Rename' } });
    assert.equal(h.state.taskPermissionModeById.get('TPT9070'), 'bypass');
    h.send({ type: 'task:updated', task: { id: 'TPT9070', agentPermissionMode: null } });
    assert.equal(h.state.taskPermissionModeById.get('TPT9070'), null);
    h.send({ type: 'task:updated', task: { id: 'TPT9070', agent_permission_mode: 'plan' } });
    assert.equal(h.state.taskPermissionModeById.get('TPT9070'), 'plan');
  }
});

test('existing task reconciliation refreshes permission overrides without requiring a mounted card', async () => {
  const h = harness();
  h.cached.tasks = [];
  h.state._lastVisibleTasks = [];
  h.context.fetchObjectiveTaskState = async () => [{ id: 'TPT9070', agentPermissionMode: 'plan' }];
  await h.context.syncNavStatusesFromServer();
  assert.equal(h.state.taskPermissionModeById.get('TPT9070'), 'plan');
});

test('completion outside a scoped board updates the rail immediately without closing its live terminal', () => {
  const h = harness();
  h.cached.tasks = [];
  h.state._lastVisibleTasks = [];
  h.send({ type: 'task:updated', task: { id: 'TPT9070', status: 'completed' } });
  assert.equal(h.calls.nav.at(-1).get('TPT9070'), 'completed');
  assert.equal(h.state.activeSessions.has('TPT9070'), true);
});

test('create and finalized events force a fresh mounted board fetch; Create marks caches stale without remounting', async () => {
  for (const type of ['task:created', 'tasks:finalized']) {
    const h = harness();
    h.send({ type, task: { id: 'TPT9074', status: 'pending' } });
    await h.flush();
    assert.ok(h.calls.renders.some(options => options.forceFresh), `${type} must reveal the new task`);
    const create = harness('new_task');
    create.send({ type, task: { id: 'TPT9074', status: 'pending' } });
    await create.flush();
    assert.equal(create.cached.storedAt, 0, `${type} must invalidate the cached board while composing`);
    assert.equal(create.calls.renders.length, 0);
  }
});

test('aggregate updates invalidate board caches even while an Objective composer is mounted', () => {
  const h = harness('objective');
  h.send({ type: 'tasks-updated' });
  assert.equal(h.cached.storedAt, 0, 'the aggregate list may contain newly created tasks absent from every cache');
});

test('a delete removes the row from caches so switching tabs cannot resurrect it', () => {
  const h = harness();
  h.send({ type: 'task:deleted', id: 'TPT9070' });
  assert.deepEqual(h.calls.removed, ['TPT9070']);
  assert.equal(h.cached.tasks.length, 0);
});

test('a delete in the same burst cannot swallow the refresh needed for a newly created task', async () => {
  const h = harness();
  h.send({ type: 'task:created', task: { id: 'TPT9074', status: 'pending' } });
  h.send({ type: 'task:deleted', id: 'TPT9070' });
  await h.flush();
  assert.ok(h.calls.renders.some(options => options.forceFresh));
});

test('an older status read cannot overwrite a completion received while it was in flight', async () => {
  const h = harness('new_task');
  let finish;
  h.context.fetchObjectiveTaskState = () => new Promise(resolve => { finish = resolve; });
  const read = h.context.syncNavStatusesFromServer();
  h.send({ type: 'task:updated', task: { id: 'TPT9070', status: 'completed' } });
  finish([{ id: 'TPT9070', status: 'in_progress' }]);
  await read;
  assert.equal(h.state.taskStatusById.get('TPT9070'), 'completed');
  assert.equal(h.cached.tasks[0].status, 'completed');
});

test('overlapping aggregate signals retain a trailing read instead of losing the completion', async () => {
  const h = harness('new_task');
  const reads = [];
  h.context.fetchObjectiveTaskState = () => new Promise(resolve => reads.push(resolve));
  h.send({ type: 'tasks-updated' });
  const first = h.context._syncNavStatusesInFlight;
  h.send({ type: 'tasks-updated' });
  assert.equal(reads.length, 1);
  reads[0]([{ id: 'TPT9070', status: 'in_progress' }]);
  await first;
  assert.equal(reads.length, 2, 'the invalidated first read must be followed by a fresh one');
  const second = h.context._syncNavStatusesInFlight;
  reads[1]([{ id: 'TPT9070', status: 'completed' }]);
  await second;
  assert.equal(h.state.taskStatusById.get('TPT9070'), 'completed');
});

test('reopened tasks and naturally exited sessions are reconciled too', async () => {
  const h = harness();
  h.state.taskStatusById.set('TPT9070', 'completed');
  h.context.fetchObjectiveTaskState = async () => [{ id: 'TPT9070', status: 'in_progress' }];
  await h.context.syncNavStatusesFromServer();
  assert.equal(h.state.taskStatusById.get('TPT9070'), 'in_progress');
  h.state.activeSessions.clear();
  h.state.exitedSessions.add('TPT9070');
  h.context.fetchObjectiveTaskState = async () => [{ id: 'TPT9070', status: 'completed' }];
  await h.context.syncNavStatusesFromServer();
  assert.equal(h.state.taskStatusById.get('TPT9070'), 'completed');
});
