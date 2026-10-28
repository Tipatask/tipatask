'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const websocket = require('./websocket');

function fakeClient(readyState, projectPath) {
  const sent = [];
  return { readyState, _projectPath: projectPath, send: (msg) => sent.push(JSON.parse(msg)), sent };
}

test('emitTaskUpdated forwards task and project to session reconciliation without needing clients', async () => {
  const seen = [];
  const task = { id: 'TPT1', status: 'Shipped' };
  websocket.init({ clients: new Set() }, { onTaskUpdated: (task, projectPath) => seen.push({ task, projectPath }) });
  websocket.emitTaskUpdated(task, null, '/projects/a');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, [{ task, projectPath: '/projects/a' }]);
  websocket.init({ clients: new Set() });
});

test('broadcastToProject: unstamped client receives every event regardless of scope', () => {
  const client = fakeClient(1, undefined);
  websocket.init({ clients: new Set([client]) });
  websocket.broadcastToProject('/projects/a', 'attention-needed', { taskId: 'C1' });
  websocket.broadcastToProject(undefined, 'attention-needed', { taskId: 'C2' });
  assert.equal(client.sent.length, 2);
});

test('broadcastToProject: a client stamped for project A receives A-scoped and unscoped events, not B', () => {
  const a = fakeClient(1, '/projects/a');
  const b = fakeClient(1, '/projects/b');
  websocket.init({ clients: new Set([a, b]) });

  websocket.broadcastToProject('/projects/a', 'attention-needed', { taskId: 'C1' });
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0);

  websocket.broadcastToProject(undefined, 'attention-needed', { taskId: 'C2' });
  assert.equal(a.sent.length, 2);
  assert.equal(b.sent.length, 1);
});

test('broadcastToProject: skips clients whose socket is not open', () => {
  const closed = fakeClient(3, '/projects/a'); // CLOSED
  websocket.init({ clients: new Set([closed]) });
  websocket.broadcastToProject('/projects/a', 'attention-needed', { taskId: 'C1' });
  assert.equal(closed.sent.length, 0);
});

test('broadcastToProject: no-op before init()/without a wss', () => {
  // Re-require in isolation would be needed to truly reset _wss; instead just confirm
  // calling with no clients set never throws.
  websocket.init({ clients: new Set() });
  assert.doesNotThrow(() => websocket.broadcastToProject('/projects/a', 'attention-needed', { taskId: 'C1' }));
});

test('broadcast (legacy, unscoped) still reaches every open client regardless of project stamp', () => {
  const a = fakeClient(1, '/projects/a');
  const b = fakeClient(1, '/projects/b');
  websocket.init({ clients: new Set([a, b]) });
  websocket.broadcast('tasks-updated', {});
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
});

// (C1230)
test('broadcastKbReindexResult: emits the EXISTING reindex-kb-result type (no new event name), project-scoped, auto:true stamped', () => {
  const a = fakeClient(1, '/projects/a');
  const b = fakeClient(1, '/projects/b');
  websocket.init({ clients: new Set([a, b]) });

  websocket.broadcastKbReindexResult('/projects/a', { success: true, tagsUpdated: 2, filesUpdated: 1, skipped: 0, errors: [] });

  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0);
  assert.deepEqual(a.sent[0], {
    type: 'reindex-kb-result', auto: true, success: true, tagsUpdated: 2, filesUpdated: 1, skipped: 0, errors: [],
  });
});

test('broadcastKbReindexResult: no projectPath falls through to every client, same as an unscoped event', () => {
  const a = fakeClient(1, '/projects/a');
  const b = fakeClient(1, '/projects/b');
  websocket.init({ clients: new Set([a, b]) });

  websocket.broadcastKbReindexResult(undefined, { success: false, tagsUpdated: 0, filesUpdated: 0, skipped: 0, errors: [], error: 'boom' });

  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
  assert.equal(a.sent[0].error, 'boom');
});

// (TPT443) The paused banner needs the pause/resume flags and the memory figures on the frame.
test('emitSessionRunaway: forwards paused, resumed and memory figures, project-scoped', () => {
  const a = fakeClient(1, '/projects/a');
  const b = fakeClient(1, '/projects/b');
  websocket.init({ clients: new Set([a, b]) });

  websocket.emitSessionRunaway('/projects/a', { taskId: 'T1', pid: 42, count: 12, threshold: 50, rssMb: 3300, limitMb: 3072, reason: 'memory', promptText: 'paused', paused: true });
  assert.equal(b.sent.length, 0);
  assert.deepEqual(a.sent[0], {
    type: 'session-runaway', taskId: 'T1', pid: 42, count: 12, threshold: 50, promptText: 'paused',
    killed: false, paused: true, resumed: false, rssMb: 3300, limitMb: 3072, reason: 'memory',
  });

  websocket.emitSessionRunaway('/projects/a', { taskId: 'T1', pid: 42, resumed: true, promptText: 'Session resumed.' });
  assert.equal(a.sent[1].resumed, true);
  assert.equal(a.sent[1].paused, false);
  assert.equal(a.sent[1].rssMb, 0);
  assert.equal(a.sent[1].reason, 'count');
});

test('emitTaskLeftUncommitted: project-scoped task-left-uncommitted frame with blockers and exit details (TPT613)', () => {
  const a = fakeClient(1, '/projects/a');
  const b = fakeClient(1, '/projects/b');
  const unstamped = fakeClient(1, undefined);
  websocket.init({ clients: new Set([a, b, unstamped]) });
  const blockers = [{ code: 'TASK_COMMIT_MISSING', message: 'no commit starting with TPT1' }];
  websocket.emitTaskLeftUncommitted('/projects/a', 'TPT1', blockers, { status: 'on_fire', nudgeCount: 2, agent: 'claude', exitId: 'TPT1@111' });
  const frame = { type: 'task-left-uncommitted', projectPath: '/projects/a', taskId: 'TPT1', blockers,
    status: 'on_fire', nudgeCount: 2, agent: 'claude', exitId: 'TPT1@111' };
  assert.deepEqual(a.sent, [frame]);
  assert.deepEqual(unstamped.sent, [frame], 'an unstamped (browser-mode) client still receives it');
  assert.equal(b.sent.length, 0, "another project's window never sees it");
  websocket.emitTaskLeftUncommitted(undefined, 'TPT2', null);
  assert.deepEqual(unstamped.sent[1], { type: 'task-left-uncommitted', projectPath: '', taskId: 'TPT2', blockers: [] });
});

// (TPT9116) Window watcher sockets — the __attention__ / __board__ branches stamp these flags.
function watcher(projectPath, flag = '_attentionSubscriber', readyState = 1) {
  return { ...fakeClient(readyState, projectPath), [flag]: true };
}

test('emitChatHistoryUpdated: only watcher sockets of exactly that project get it, never another project or an unstamped socket', () => {
  const attention = watcher('/projects/a');
  const board = watcher('/projects/a', '_boardWatcher');
  const otherProject = watcher('/projects/b');
  const closed = watcher('/projects/a', '_attentionSubscriber', 3);
  const chatSocket = fakeClient(1, undefined); // terminal / objective / task-chat sockets carry no stamp
  const stampedNonWatcher = fakeClient(1, '/projects/a');
  websocket.init({ clients: new Set([attention, board, otherProject, closed, chatSocket, stampedNonWatcher]) });
  websocket.emitChatHistoryUpdated('/projects/a', {
    historyId: 'h1', kind: 'task', taskKey: 'TPT1', projectId: '2',
    nativeSessionId: 'native-secret', cwd: '/projects/a', storage: { claudeConfigDir: '/x' }, keywords: ['kw'], title: 'T',
  });
  const frame = { type: 'chat-history-updated', historyId: 'h1', kind: 'task', taskKey: 'TPT1', projectId: '2' };
  assert.deepEqual(attention.sent, [frame], 'metadata only: no native id, path, storage or search data');
  assert.deepEqual(board.sent, [frame]);
  assert.equal(otherProject.sent.length, 0, "another project's window gets no frame");
  assert.equal(closed.sent.length, 0);
  assert.equal(chatSocket.sent.length, 0, 'unlike broadcastToProject(), an unstamped socket gets nothing');
  assert.equal(stampedNonWatcher.sent.length, 0);
});

test('emitChatHistoryUpdated: an empty project path reaches only unscoped watchers; a project chat sends taskKey null', () => {
  const unscoped = watcher('', '_boardWatcher');
  const scoped = watcher('/projects/a');
  websocket.init({ clients: new Set([unscoped, scoped]) });
  websocket.emitChatHistoryUpdated(undefined, { historyId: 'h2', kind: 'project', taskKey: null, projectId: '7' });
  assert.deepEqual(unscoped.sent, [{ type: 'chat-history-updated', historyId: 'h2', kind: 'project', taskKey: null, projectId: '7' }]);
  assert.equal(scoped.sent.length, 0);
  websocket.init(null);
  assert.doesNotThrow(() => websocket.emitChatHistoryUpdated('/projects/a', { historyId: 'h3' }), 'no-op without a wss');
});
