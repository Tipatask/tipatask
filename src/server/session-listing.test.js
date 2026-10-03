'use strict';

// (C1444) sessionListBucket() — GET /api/sessions bucketing. Regression coverage for the
// left-nav active-session row disappearing right after a board Start click: spawnTerminal()
// (terminal-session.js) awaits several remote round-trips before pty.spawn() flips `alive`,
// so a plain `alive ? active : (pending ? neither : exited)` misreported that whole window
// as exited — and the client's mergeSessionsSnapshot() wholesale-replaces
// state.activeSessions from this list, dropping the just-started row. See
// ai/architecture/tt-websocket.md and ai/architecture/tt-task-board.md § C1444.

process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sessionListBucket, replayExitedTerminal } = require('./ws-handlers');

test('exited terminal replay sends saved xterm output and the original exit code', () => {
  const frames = [];
  const ws = { send: (data) => frames.push(JSON.parse(data)) };
  replayExitedTerminal(ws, { tabId: 'TPT467', buffer: 'agent output\r\n', exitCode: 0 });
  assert.deepEqual(frames.map(frame => frame.type), ['data', 'exit']);
  assert.match(frames[0].data, /agent output\r\n$/);
  assert.equal(frames[0].tabId, 'TPT467');
  assert.equal(frames[1].code, 0);
});

test('sessionListBucket: alive session is active', () => {
  assert.equal(sessionListBucket({ alive: true, pending: false, _starting: false }), 'active');
});

test('sessionListBucket: _starting session (mid-spawn, not yet alive) is active — the regression', () => {
  assert.equal(sessionListBucket({ alive: false, pending: false, _starting: true }), 'active');
});

test('sessionListBucket: pending session (created, no start message yet) is neither', () => {
  assert.equal(sessionListBucket({ alive: false, pending: true, _starting: false }), null);
});

test('sessionListBucket: dead session (not alive, not pending, not starting) is exited', () => {
  assert.equal(sessionListBucket({ alive: false, pending: false, _starting: false }), 'exited');
});

test('sessionListBucket: no session is null', () => {
  assert.equal(sessionListBucket(null), null);
  assert.equal(sessionListBucket(undefined), null);
});

test('sessionListBucket: a queued session (TPT444) is its own bucket, never exited or active', () => {
  assert.equal(sessionListBucket({ alive: false, pending: false, _starting: false, _queued: true }), 'queued');
  assert.equal(sessionListBucket({ alive: false, pending: false, _starting: false, _launching: true }), 'active');
});
