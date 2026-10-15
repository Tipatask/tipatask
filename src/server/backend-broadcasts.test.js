'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { attachBackendBroadcasts, detachBackendBroadcasts } = require('./backend-broadcasts');

// Stub backend: captures the callbacks the two registrars receive.
function stubBackend({ pending = 0, pendingIds = [] } = {}) {
  const b = {
    stateCbs: [], drainCbs: [], registrations: 0,
    onConnectionStateChange(cb) { b.registrations++; b.stateCbs.push(cb); return () => {}; },
    onMutationsDrained(cb) { b.registrations++; b.drainCbs.push(cb); return () => {}; },
    getPendingMutationCount: () => pending,
    getPendingTaskIds: () => pendingIds,
    state(...a) { for (const cb of b.stateCbs) cb(...a); },
    drain(...a) { for (const cb of b.drainCbs) cb(...a); },
  };
  return b;
}

// Recording websocket stand-in with the same emit helper names index.js uses.
function recordingWs() {
  const calls = [];
  const rec = name => (...args) => calls.push([name, ...args]);
  return {
    calls,
    emitApiStatus: rec('emitApiStatus'),
    emitMutationsDropped: rec('emitMutationsDropped'),
    emitTaskUpdated: rec('emitTaskUpdated'),
    emitTaskCreated: rec('emitTaskCreated'),
    emitTaskDeleted: rec('emitTaskDeleted'),
  };
}

const quiet = fn => {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
};

const DROPPED = [{ op: 'update', taskId: 'C42', title: 'Lost edit', code: 'TAGS_UNREGISTERED', statusCode: null, message: 'Unregistered tag(s): x' }];

test('per-project drain with a dropped entry emits one scoped mutations-dropped and scoped replay frames', () => {
  const b = stubBackend({ pendingIds: [] });
  const ws = recordingWs();
  assert.equal(attachBackendBroadcasts(b, { websocket: ws, projectPath: '/proj/B' }), true);

  b.drain([
    { id: 'C1', title: 'updated' },
    { id: 'C2', _deleted: true },
    { id: 'C3', _replacedTmpId: 'tmp-1' },
  ], 0, DROPPED);

  const dropped = ws.calls.filter(c => c[0] === 'emitMutationsDropped');
  assert.deepEqual(dropped, [['emitMutationsDropped', DROPPED, '/proj/B']]);
  assert.deepEqual(ws.calls.find(c => c[0] === 'emitApiStatus'), ['emitApiStatus', 'connected', null, 0, [], '/proj/B']);
  assert.deepEqual(ws.calls.filter(c => c[0].startsWith('emitTask')), [
    ['emitTaskUpdated', { id: 'C1', title: 'updated' }, undefined, '/proj/B'],
    ['emitTaskDeleted', 'C2', '/proj/B'],
    ['emitTaskDeleted', 'tmp-1', '/proj/B'],
    ['emitTaskCreated', { id: 'C3', _replacedTmpId: 'tmp-1' }, '/proj/B'],
  ]);
});

test('drain with entries still queued reports reconnecting with the remaining count', () => {
  const b = stubBackend({ pendingIds: ['C9'] });
  const ws = recordingWs();
  attachBackendBroadcasts(b, { websocket: ws, projectPath: '/proj/B' });
  b.drain([], 2, []);
  assert.deepEqual(ws.calls, [['emitApiStatus', 'reconnecting', 'Reconnected — 2 updates still queued', 2, ['C9'], '/proj/B']]);
});

test('state change emits scoped api-status with that instance\'s pending queue', () => {
  const b = stubBackend({ pending: 3, pendingIds: ['C5'] });
  const ws = recordingWs();
  attachBackendBroadcasts(b, { websocket: ws, projectPath: '/proj/B' });
  quiet(() => b.state('disconnected', 'offline'));
  assert.deepEqual(ws.calls, [['emitApiStatus', 'disconnected', 'offline', 3, ['C5'], '/proj/B']]);
});

test('attaching twice registers listeners once — no duplicate frames', () => {
  const b = stubBackend();
  const ws = recordingWs();
  assert.equal(attachBackendBroadcasts(b, { websocket: ws, projectPath: '/proj/B' }), true);
  assert.equal(attachBackendBroadcasts(b, { websocket: ws, projectPath: '/proj/B' }), false);
  assert.equal(b.registrations, 2);
  b.drain([], 0, DROPPED);
  assert.equal(ws.calls.filter(c => c[0] === 'emitMutationsDropped').length, 1);
});

test('singleton (no projectPath) stays unscoped; skipState suppresses only the state listener', () => {
  const b = stubBackend();
  const ws = recordingWs();
  attachBackendBroadcasts(b, { websocket: ws, skipState: () => true });
  quiet(() => b.state('reconnecting', null));
  assert.equal(ws.calls.length, 0);
  b.drain([{ id: 'C1' }], 0, DROPPED);
  assert.deepEqual(ws.calls.find(c => c[0] === 'emitMutationsDropped'), ['emitMutationsDropped', DROPPED, undefined]);
  assert.deepEqual(ws.calls.find(c => c[0] === 'emitTaskUpdated'), ['emitTaskUpdated', { id: 'C1' }, undefined, undefined]);
});

test('instance without the registrars is skipped', () => {
  assert.equal(attachBackendBroadcasts({ init() {} }, { websocket: recordingWs(), projectPath: '/p' }), false);
});

test('real websocket.js: per-project drain frames reach only that project\'s clients', () => {
  const websocket = require('./websocket');
  const client = projectPath => ({ readyState: 1, _projectPath: projectPath, frames: [], send(m) { this.frames.push(JSON.parse(m)); } });
  const a = client('/proj/A');
  const bClient = client('/proj/B');
  websocket.init({ clients: new Set([a, bClient]) });

  const b = stubBackend();
  attachBackendBroadcasts(b, { websocket, projectPath: '/proj/B' });
  b.drain([], 0, DROPPED);

  assert.deepEqual(a.frames, []);
  assert.deepEqual(bClient.frames.filter(f => f.type === 'mutations-dropped'), [{ type: 'mutations-dropped', entries: DROPPED }]);
  assert.deepEqual(bClient.frames.find(f => f.type === 'api-status'),
    { type: 'api-status', state: 'connected', message: null, pendingCount: 0, pendingTaskIds: [] });
});

// (TPT673) Stub whose registrars hand back real unsubscribe functions, like api-backend's.
function setBackedStub() {
  const b = {
    stateCbs: new Set(), drainCbs: new Set(),
    onConnectionStateChange(cb) { b.stateCbs.add(cb); return () => b.stateCbs.delete(cb); },
    onMutationsDrained(cb) { b.drainCbs.add(cb); return () => b.drainCbs.delete(cb); },
    getPendingMutationCount: () => 0,
    getPendingTaskIds: () => [],
    drain(...a) { for (const cb of b.drainCbs) cb(...a); },
  };
  return b;
}

test('detach unsubscribes both listeners — an evicted instance sends no more frames', () => {
  const b = setBackedStub();
  const ws = recordingWs();
  attachBackendBroadcasts(b, { websocket: ws, projectPath: '/proj/B' });
  assert.equal(b.stateCbs.size, 1);
  assert.equal(b.drainCbs.size, 1);

  assert.equal(detachBackendBroadcasts(b), true);
  assert.equal(b.stateCbs.size, 0);
  assert.equal(b.drainCbs.size, 0);
  b.drain([{ id: 'C1' }], 0, DROPPED);
  assert.deepEqual(ws.calls, []);
  assert.equal(detachBackendBroadcasts(b), false, 'second detach is a no-op');
});

test('after detach the same instance can attach again, once; a fresh instance attaches cleanly', () => {
  const b = setBackedStub();
  const ws = recordingWs();
  attachBackendBroadcasts(b, { websocket: ws, projectPath: '/proj/B' });
  detachBackendBroadcasts(b);
  assert.equal(attachBackendBroadcasts(b, { websocket: ws, projectPath: '/proj/B' }), true);
  assert.equal(attachBackendBroadcasts(b, { websocket: ws, projectPath: '/proj/B' }), false);
  assert.equal(b.drainCbs.size, 1);

  const fresh = setBackedStub();
  assert.equal(attachBackendBroadcasts(fresh, { websocket: ws, projectPath: '/proj/B' }), true);
  assert.equal(fresh.drainCbs.size, 1);
});

test('detach of an instance never attached returns false', () => {
  assert.equal(detachBackendBroadcasts(setBackedStub()), false);
  assert.equal(detachBackendBroadcasts(null), false);
});
