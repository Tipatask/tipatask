import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { humanInProgressRows, humanTaskWritePatch, knownHumanTaskIds } from './human-task-rows.js';

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
    taskCategoryById: new Map(), taskAssigneeById: new Map(), lostSessions: new Map(), currentUserId: 7,
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
      humanTaskRows: { humanTaskWritePatch, knownHumanTaskIds },
    } },
    TipTask: { attentionState: { clearAttention() {} } },
  });
  vm.runInContext([
    'invalidateLoadAndRender', 'patchCachedBoardTasks', 'staleBoardTaskCache',
    'applyObjectiveTaskState', 'applyObjectiveTaskUpdate', 'applyHumanTaskWrite', 'syncNavStatusesFromServer',
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

// (TPT9201) The left nav's human rows read these maps: a board reload is never what moves them.
function humanHarness(tab = 'board') {
  const h = harness(tab);
  h.state.activeSessions.clear();
  h.state.taskCategoryById.set('TPT1', 'HUMAN');
  h.state.taskStatusById.set('TPT1', 'pending');
  h.state.taskTitleById.set('TPT1', 'Call the bank');
  h.cached.tasks = [{ id: 'TPT1', category: 'HUMAN', status: 'pending', title: 'Call the bank' }];
  h.state._lastVisibleTasks = [{ id: 'TPT1', category: 'HUMAN', status: 'pending', title: 'Call the bank' }];
  h.rowIds = () => humanInProgressRows(h.state).map(row => row.taskId);
  return h;
}

test('a task:updated frame moves a human row in and out on every tab, with the nav repainted after', () => {
  for (const tab of ['board', 'new_task']) {
    const h = humanHarness(tab);
    assert.deepEqual(h.rowIds(), []);
    h.send({ type: 'task:updated', task: { id: 'TPT1', status: 'in_progress', title: 'Call the bank' } });
    assert.deepEqual(h.rowIds(), ['TPT1']);
    assert.equal(h.calls.nav.at(-1).get('TPT1'), 'in_progress', 'repainted after the status was recorded');
    h.send({ type: 'task:updated', task: { id: 'TPT1', status: 'completed', title: 'Call the bank' } });
    assert.deepEqual(h.rowIds(), []);
    assert.equal(h.calls.nav.at(-1).get('TPT1'), 'completed');
    assert.equal(h.calls.renders.length, 0, 'no board reload');
  }
});

test('the Objective tab reaches a human row through its own reconcile', async () => {
  const h = humanHarness('objective');
  h.state.activeTab = 'board';
  h.context.applyObjectiveTaskUpdate({ id: 'TPT1', status: 'in_progress' });
  assert.deepEqual(h.rowIds(), ['TPT1']);
});

test('a frame carries a category or assignee change to a task that already has a row', () => {
  const h = humanHarness();
  h.state.taskStatusById.set('TPT1', 'in_progress');
  assert.deepEqual(h.rowIds(), ['TPT1']);
  h.send({ type: 'task:updated', task: { id: 'TPT1', status: 'in_progress', title: 'x', assignee: 8 } });
  assert.deepEqual(h.rowIds(), [], 'reassigned to a teammate');
  h.send({ type: 'task:updated', task: { id: 'TPT1', status: 'in_progress', title: 'x', assignee: 7 } });
  assert.deepEqual(h.rowIds(), ['TPT1'], 'assigned back to me');
  h.send({ type: 'task:updated', task: { id: 'TPT1', status: 'in_progress', title: 'x', category: 'CODING' } });
  assert.deepEqual(h.rowIds(), [], 'no longer a human task');
});

test('a teammate\'s human task in a project-wide list never becomes a row', () => {
  const h = humanHarness('objective');
  h.state.activeTab = 'board';
  h.context.applyObjectiveTaskState([
    { id: 'TPT2', category: 'HUMAN', status: 'in_progress', title: 'Theirs', assignee: 8 },
    { id: 'TPT3', category: 'HUMAN', status: 'in_progress', title: 'Mine', assignee: 7 },
  ]);
  assert.deepEqual(h.rowIds(), ['TPT3']);
});

test('the status poll covers human tasks with no session, off the board too', async () => {
  const h = humanHarness('new_task');
  h.context.fetchObjectiveTaskState = async () => [{ id: 'TPT1', status: 'in_progress', title: 'Renamed', category: 'HUMAN' }];
  await h.context.syncNavStatusesFromServer();
  assert.deepEqual(h.rowIds(), ['TPT1']);
  assert.equal(h.state.taskTitleById.get('TPT1'), 'Renamed');
  assert.equal(h.cached.tasks[0].status, 'in_progress', 'a cached render cannot bring the old status back');
  assert.equal(h.calls.nav.at(-1).get('TPT1'), 'in_progress');
  h.context.fetchObjectiveTaskState = async () => [{ id: 'TPT1', status: 'completed', title: 'Renamed' }];
  await h.context.syncNavStatusesFromServer();
  assert.deepEqual(h.rowIds(), []);
  assert.equal(h.calls.renders.length, 0, 'no board reload');
});

test('a human task completed elsewhere raises no completion notification: its click opens a session', async () => {
  const h = humanHarness('new_task');
  const observed = [];
  h.context.window.TipTask.completionNotifications.observeTaskStatusForCompletion = (map, id) => observed.push(id);
  h.context.fetchObjectiveTaskState = async () => [{ id: 'TPT1', status: 'completed' }];
  await h.context.syncNavStatusesFromServer();
  assert.equal(h.state.taskStatusById.get('TPT1'), 'completed');
  assert.deepEqual(observed, []);
});

test('the poll still skips its read with neither a session nor a human task', async () => {
  const h = harness();
  h.state.activeSessions.clear();
  let reads = 0;
  h.context.fetchObjectiveTaskState = async () => { reads++; return []; };
  await h.context.syncNavStatusesFromServer();
  assert.equal(reads, 0);
});

test('a local write of a human task updates rail, caches and visible rows with no event to carry it', () => {
  for (const tab of ['board', 'new_task']) {
    const h = humanHarness(tab);
    h.context.applyHumanTaskWrite({ id: 'TPT1', category: 'HUMAN', status: 'in_progress', title: 'Call the bank', _pendingSync: true });
    assert.deepEqual(h.rowIds(), ['TPT1']);
    assert.equal(h.cached.tasks[0].status, 'in_progress', 'a cache-hit render keeps the row');
    assert.equal(h.state._lastVisibleTasks[0].status, 'in_progress');
    assert.equal('_pendingSync' in h.cached.tasks[0], false, 'transport extras stay out of the snapshot');
    h.context.applyHumanTaskWrite({ id: 'TPT1', status: 'completed' });
    assert.deepEqual(h.rowIds(), []);
    assert.equal(h.cached.tasks[0].status, 'completed');
    assert.equal(h.calls.renders.length, 0, 'no board reload');
  }
});

test('a local write of a CODING task leaves the agent rail\'s timing alone', () => {
  const h = harness();
  h.state.taskCategoryById.set('TPT9070', 'CODING');
  h.context.applyHumanTaskWrite({ id: 'TPT9070', category: 'CODING', status: 'completed' });
  assert.equal(h.state.taskStatusById.get('TPT9070'), 'in_progress');
  assert.equal(h.cached.tasks[0].status, 'in_progress');
  assert.equal(h.calls.nav.length, 0);
});

test('a CODING task flipped to HUMAN while in progress gets its row from the save', () => {
  const h = humanHarness();
  h.state.taskCategoryById.set('TPT1', 'CODING');
  h.state.taskStatusById.set('TPT1', 'in_progress');
  assert.deepEqual(h.rowIds(), []);
  h.context.applyHumanTaskWrite({ id: 'TPT1', category: 'HUMAN', status: 'in_progress' });
  assert.deepEqual(h.rowIds(), ['TPT1']);
});

test('deleting a human task removes its row at once', () => {
  const h = humanHarness();
  h.state.taskStatusById.set('TPT1', 'in_progress');
  assert.deepEqual(h.rowIds(), ['TPT1']);
  const repaints = h.calls.nav.length;
  h.send({ type: 'task:deleted', id: 'TPT1' });
  assert.deepEqual(h.rowIds(), []);
  assert.ok(h.calls.nav.length > repaints, 'the rail repainted');
  assert.deepEqual(h.cached.tasks, []);
});

test('local task writes reach the rail through page-shell listeners', () => {
  assert.match(source, /addEventListener\('tiptask:task-saved', \(e\) => applyHumanTaskWrite\(e\.detail\?\.task\)\)/);
  assert.match(source, /addEventListener\('tiptask:task-removed'/);
  const writes = source.match(/state\.taskStatusById\.set\((?:id|task\.id), next\);\n\s*applyHumanTaskWrite\(/g) || [];
  assert.equal(writes.length, 2, 'the To-Do checkbox and drawer write over IPC directly');
});

test('every board render rebuilds the human maps beside the status map, and only a drill-down retains', () => {
  const render = source.slice(source.indexOf('async function _loadAndRenderImpl('));
  assert.match(render, /const taskCategoryById = new Map\(visibleTasks\.map\(t => \[t\.id, t\.category\]\)\);/);
  assert.match(render, /const taskAssigneeById = new Map\(visibleTasks\.map\(t => \[t\.id, t\.assignee \?\? null\]\)\);/);
  assert.match(render, /if \(cacheContext\.parentKey\) \{\s*window\.TipTask\.humanTaskRows\.keepHumanTaskEntries\(/);
  assert.ok(render.indexOf('keepHumanTaskEntries') < render.indexOf('state.taskCategoryById = taskCategoryById;'),
    'retention reads the outgoing maps');
});

// Exercise the production async board-read path through its status-map commit. Stop before
// unrelated card/toolbar DOM rendering; the rail uses the real row renderer below.
function boardReadHarness() {
  const h = harness();
  const checkpoint = new Error('board status maps committed');
  let finishRead;
  Object.assign(h.state, { statusFilter: new Set(), lostSessions: new Map() });
  Object.assign(h.context, {
    _loadAndRenderGeneration: 0, _lastRenderedTab: 'board',
    refreshStatusesIfStale() {}, captureCardEdits() {}, closeTodoDrawer() {},
    _canUseBoardTaskCache: () => true,
    _boardTaskCacheContext: () => ({}), _boardTaskFilterHash: () => 'network',
    _applyBoardSnapshotMetadata() {}, _applyBoardWindow() {},
    _rememberBoardSnapshot: (key, snapshot) => h.context._boardTaskCache.set(key, { tasks: snapshot.tasks.map(t => ({ ...t })) }),
    fetchBoardSnapshot: () => new Promise(resolve => { finishRead = resolve; }),
    perfStart() {}, perfEnd() {},
    _sessionAgentIcon: () => '<svg></svg>', SESSION_DONE_BADGE: '<span class="session-check">✓</span>',
    escapeAttr: value => String(value), t: key => key,
  });
  h.context.TipTask.attentionState.pruneClosedAttention = () => { throw checkpoint; };
  const boardSource = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
  const rowRenderer = boardSource.match(/export function renderActiveSessionsList[\s\S]*?\n\}\n/)[0].replace('export ', '');
  vm.runInContext([productionFunction('isCurrentLoadAndRender'), productionFunction('reconcileBoardTaskStatuses'), productionFunction('_loadAndRenderImpl'), rowRenderer].join('\n'), h.context);
  h.render = () => h.context._loadAndRenderImpl({ forceFresh: true });
  h.finish = tasks => finishRead({ tasks });
  h.checkpoint = checkpoint;
  h.rail = () => h.context.renderActiveSessionsList([{ taskId: 'TPT9070', status: h.state.taskStatusById.get('TPT9070') }], false);
  return h;
}

test('a board response started before status reconciliation cannot remove the completion check', async () => {
  const h = boardReadHarness();
  const rendering = h.render();
  await h.context.syncNavStatusesFromServer();
  assert.match(h.rail(), /session-check/);
  h.finish([{ id: 'TPT9070', status: 'in_progress' }]);
  await assert.rejects(rendering, h.checkpoint);
  assert.match(h.rail(), /session-check/, 'older board rows must not remove a confirmed check');
  assert.equal(h.state._lastVisibleTasks[0].status, 'completed');
  assert.equal(h.context._boardTaskCache.get('network').tasks[0].status, 'completed');
});

test('a board response cannot restore the check after a newer reopening', async () => {
  const h = boardReadHarness();
  h.state.taskStatusById.set('TPT9070', 'completed');
  h.context.fetchObjectiveTaskState = async () => [{ id: 'TPT9070', status: 'in_progress' }];
  const rendering = h.render();
  await h.context.syncNavStatusesFromServer();
  h.finish([{ id: 'TPT9070', status: 'completed' }]);
  await assert.rejects(rendering, h.checkpoint);
  assert.doesNotMatch(h.rail(), /session-check/);
  assert.equal(h.state._lastVisibleTasks[0].status, 'in_progress');
});

test('ordinary board reads can still discover a status change when no newer observation exists', async () => {
  const h = boardReadHarness();
  const rendering = h.render();
  h.finish([{ id: 'TPT9070', status: 'completed' }]);
  await assert.rejects(rendering, h.checkpoint);
  assert.match(h.rail(), /session-check/);
});

test('scoped renders retain completion statuses for exited and lost sessions too', async () => {
  for (const kind of ['exited', 'lost']) {
    const h = boardReadHarness();
    h.state.activeSessions.clear();
    if (kind === 'exited') h.state.exitedSessions.add('TPT9070');
    else h.state.lostSessions.set('TPT9070', { reason: 'server-restarted' });
    h.state.taskStatusById.set('TPT9070', 'completed');
    const rendering = h.render();
    h.finish([]);
    await assert.rejects(rendering, h.checkpoint);
    assert.match(h.rail(), /session-check/, kind);
  }
});

test('lost session statuses refresh even when there are no active or exited sessions', async () => {
  const h = harness('new_task');
  h.state.activeSessions.clear();
  h.state.lostSessions = new Map([['TPT9070', {}]]);
  await h.context.syncNavStatusesFromServer();
  assert.equal(h.state.taskStatusById.get('TPT9070'), 'completed');
});

test('completion on the Objective tab repaints the rail before its deferred render runs', () => {
  const h = harness('objective');
  h.send({ type: 'task:updated', task: { id: 'TPT9070', status: 'completed' } });
  assert.equal(h.state.taskStatusById.get('TPT9070'), 'completed');
  assert.equal(h.calls.nav.at(-1).get('TPT9070'), 'completed');
});

test('an older Objective aggregate read cannot remove a completion learned by status reconciliation', async () => {
  const h = boardReadHarness();
  h.state.activeTab = 'objective';
  let finishObjective;
  h.context.fetchObjectiveTaskState = () => new Promise(resolve => { finishObjective = resolve; });
  const rendering = h.context._loadAndRenderImpl({ objectiveTasksUpdated: true });
  h.context.fetchObjectiveTaskState = async () => [{ id: 'TPT9070', status: 'completed' }];
  await h.context.syncNavStatusesFromServer();
  finishObjective([{ id: 'TPT9070', status: 'in_progress' }]);
  await rendering;
  assert.match(h.rail(), /session-check/);
  assert.equal(h.cached.tasks[0].status, 'completed');
});
