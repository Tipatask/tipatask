'use strict';

// (TPT444) FIFO start queue: slot accounting, ordering, per-project caps, drain triggers.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSessionQueue } = require('./session-queue');

function harness({ cap = 2, projectCaps = {}, defaultProject = '/p' } = {}) {
  const sessions = new Map();
  const started = [];
  const changes = [];
  const queue = createSessionQueue({
    getSessions: () => sessions,
    defaultProject,
    resolveLimits: (project) => {
      const own = projectCaps[project];
      return own
        ? { deviceSessionCap: cap, maxConcurrentSessions: Math.min(own, cap), sessionCapSource: 'config' }
        : { deviceSessionCap: cap, maxConcurrentSessions: cap, sessionCapSource: 'device' };
    },
    onChange: (projectPath, snap) => changes.push({ projectPath, snap }),
    log: () => {},
  });
  // Mimics ws-handlers: create + register a session, submit a launcher that goes live.
  function request(taskId, projectPath = '/p') {
    const key = `${taskId}\0${projectPath}`;
    const session = { type: 'terminal', alive: false, pending: false, taskId, tabId: taskId, projectPath };
    sessions.set(key, session);
    const result = queue.submit({
      key, session, taskId,
      start: async () => { started.push(taskId); session._launching = false; session.alive = true; },
    });
    return { key, session, result };
  }
  return { queue, sessions, started, changes, request };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('starts immediately while under the cap, queues the overflow in FIFO order', async () => {
  const h = harness({ cap: 2 });
  const a = h.request('A'); const b = h.request('B'); const c = h.request('C'); const d = h.request('D');
  assert.equal(a.result.queued, false);
  assert.equal(b.result.queued, false);
  assert.deepEqual([c.result.queued, c.result.position], [true, 1]);
  assert.deepEqual([d.result.queued, d.result.position], [true, 2]);
  await tick();
  assert.deepEqual(h.started, ['A', 'B']);
  assert.equal(c.session._queued, true);
});

test('a freed slot starts the oldest queued session; positions shift', async () => {
  const h = harness({ cap: 1 });
  const a = h.request('A'); const b = h.request('B'); const c = h.request('C');
  await tick();
  assert.deepEqual(h.started, ['A']);
  a.session._completionEmitted = true; // task completed -> slot released even though pty is alive
  h.queue.drain();
  await tick();
  assert.deepEqual(h.started, ['A', 'B']);
  assert.equal(b.session._queued, false);
  assert.equal(h.queue.position(c.key), 1);
});

test('exited and terminated sessions free their slot; chat and pending sessions never take one', async () => {
  const h = harness({ cap: 1 });
  h.sessions.set('chat', { type: 'terminal', alive: true, taskId: 'obj-1', tabId: 'obj-1', projectPath: '/p' });
  h.sessions.set('objective', { type: 'objective', alive: true, taskId: 'T9', projectPath: '/p' });
  h.sessions.set('pending', { type: 'terminal', pending: true, alive: false, taskId: 'T8', projectPath: '/p' });
  assert.equal(h.queue.countRunning(), 0);
  const a = h.request('A'); const b = h.request('B');
  await tick();
  assert.equal(b.result.queued, true);
  a.session.alive = false; // pty exited
  h.queue.drain();
  await tick();
  assert.deepEqual(h.started, ['A', 'B']);
});

test('a session that is still launching counts as running, so concurrent requests cannot oversubscribe', () => {
  const h = harness({ cap: 1 });
  const a = h.request('A');
  assert.equal(a.session._launching, true); // set synchronously at admission
  const b = h.request('B');
  assert.equal(b.result.queued, true);
  assert.equal(h.queue.countRunning(), 1);
});

test('remove() cancels a queued session and renumbers the rest; unknown key is a no-op', async () => {
  const h = harness({ cap: 1 });
  h.request('A'); const b = h.request('B'); const c = h.request('C');
  assert.equal(h.queue.remove(b.key), true);
  assert.equal(b.session._queued, false);
  assert.equal(h.queue.position(c.key), 1);
  assert.equal(h.queue.remove('nope'), false);
  await tick();
  assert.deepEqual(h.started, ['A']);
});

test('stale entries (session deleted, terminated or replaced) are dropped, not started', async () => {
  const h = harness({ cap: 1 });
  const a = h.request('A'); const b = h.request('B'); const c = h.request('C');
  await tick();
  h.sessions.delete(b.key); // user terminated the queued session
  a.session.alive = false;
  h.queue.drain();
  await tick();
  assert.deepEqual(h.started, ['A', 'C']);
  assert.equal(h.queue.size(), 0);
  assert.equal(c.session._queued, false);
});

test('a project at its own cap does not block another project behind it', async () => {
  const h = harness({ cap: 4, projectCaps: { '/a': 1 } });
  h.request('A1', '/a'); const a2 = h.request('A2', '/a'); const b1 = h.request('B1', '/b');
  await tick();
  assert.equal(a2.result.queued, true);
  assert.equal(b1.result.queued, false); // /b has room even though A2 waits ahead of it
  assert.deepEqual(h.started, ['A1', 'B1']);
});

test('the device cap is shared across projects', async () => {
  const h = harness({ cap: 2 });
  h.request('A', '/a'); h.request('B', '/b'); const c = h.request('C', '/c');
  assert.equal(c.result.queued, true);
});

test('a failing start never throws out of drain, releases the launch stamp, and later entries still run', async () => {
  const h = harness({ cap: 1 });
  const key = 'X\0/p';
  const session = { type: 'terminal', alive: false, taskId: 'X', projectPath: '/p' };
  h.sessions.set(key, session);
  h.queue.submit({ key, session, taskId: 'X', start: async () => { throw new Error('boom'); } });
  await tick();
  assert.equal(session._launching, false);
  const b = h.request('B');
  assert.equal(b.result.queued, false);
});

test('onChange reports positions per project after enqueue and drain', async () => {
  const h = harness({ cap: 1 });
  h.request('A'); h.request('B');
  const last = h.changes.at(-1);
  assert.equal(last.projectPath, '/p');
  assert.deepEqual(last.snap.queued, [{ taskId: 'B', position: 1 }]);
  assert.equal(last.snap.cap, 1);
});

test('a throwing limits resolver degrades to a single slot instead of unlimited', () => {
  const sessions = new Map();
  const queue = createSessionQueue({ getSessions: () => sessions, resolveLimits: () => { throw new Error('x'); }, log: () => {} });
  const mk = (id) => ({ key: id, session: { type: 'terminal', taskId: id, projectPath: '/p' }, taskId: id, start: async () => {} });
  const one = mk('A'); sessions.set('A', one.session);
  const two = mk('B'); sessions.set('B', two.session);
  assert.equal(queue.submit(one).queued, false);
  assert.equal(queue.submit(two).queued, true);
});

// ── Wiring guards: the queue is only useful if every slot-freeing path drains it ──

const fs = require('node:fs');
const path = require('node:path');
const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');

test('ws-handlers routes new terminal task starts through the queue and cancels/drains on terminate', () => {
  const src = read('ws-handlers.js');
  assert.match(src, /sessionQueue\.submit\(\{ key: sessionKey, session, taskId, start: \(\) => launchNewTerminalSession\(launchCtx\) \}\)/);
  assert.match(src, /if \(!prompt \|\| isAgentChatId\(taskId\)\)/); // chat / promptless starts never hold a slot
  assert.match(src, /sessionQueue\.remove\(sessionKey\); \/\/ \(TPT444\)/);
  assert.match(src, /session-queued/);
  assert.match(src, /existing && existing\._queued/); // reconnect re-attaches to the wait instead of respawning
  assert.match(src, /session\.onSlotFreed = drainSessionQueue/);
  assert.match(src, /queued, lost, lostDetails/); // GET /api/sessions exposes the queue
});

test('every slot-freeing path drains the queue: pty exit, task completion, watchdog tick', () => {
  assert.match(read('terminal-session.js'), /session\.onSlotFreed\?\.\(\)/);
  const index = read('index.js');
  assert.match(index, /drainSessionQueue\(\); \/\/ \(TPT444\) a completed task releases/);
  assert.match(index, /drainSessionQueue\(\); \/\/ \(TPT444\) safety net/);
  assert.match(read('websocket.js'), /emitSessionQueueState\(projectPath, snapshot\)/);
});

test('per-entry diagnostics refresh broadcasts without changing position or main reason', () => {
  const h = harness();
  let detail = 'lock-busy';
  const decision = session => ({ allowed: false, reason: 'coordination', coordinationReason: null,
    detail: session.taskId === 'A' ? detail : 'state-invalid', instances: null, unregisteredCount: null });
  h.queue.setAdmission({ tryReserve: decision, snapshot: () => ({ detail: 'global-only' }) });
  h.request('A'); h.request('B');
  assert.deepEqual(h.queue.snapshot('/p').queued.map(row => row.detail), ['lock-busy', 'state-invalid']);
  h.changes.length = 0;
  h.queue.drain(); assert.equal(h.changes.length, 0, 'unchanged details do not spam');
  detail = 'state-invalid'; h.queue.drain();
  assert.equal(h.changes.length, 1);
  assert.equal(h.changes[0].snap.queued[0].position, 1);
  assert.equal(h.changes[0].snap.queued[0].reason, 'coordination');
  assert.equal(h.changes[0].snap.queued[0].detail, 'state-invalid');
  assert.equal(h.changes[0].snap.queued[0].instances, null);
});
