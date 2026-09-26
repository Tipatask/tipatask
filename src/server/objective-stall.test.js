'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

// Run production modules with isolated throttle state, fake CLI processes and
// mocked time. No real process signals, file writes, or provider requests.
function harness(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const config = { ...require('./config'), SIMPLE_MODE: true,
    OBJECTIVE_TIMING_ENABLED: false, OBJECTIVE_PREWARM_ENABLED: false,
    OBJECTIVE_HEARTBEAT_ENABLED: false, OBJECTIVE_MAX_CONCURRENT: 1,
    OBJECTIVE_STREAM_IDLE_MS: 60000, OBJECTIVE_MAX_RETRIES: 2,
    OBJECTIVE_RETRY_BACKOFF_MS: 250, ...overrides };
  const processes = [], signals = [], frames = [];
  function load(file, mocks) {
    const filename = path.join(__dirname, file);
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports,
      require: id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
      console: { log() {}, warn() {}, error() {} },
      process: { env: {}, kill: (pid, signal) => signals.push({ pid, signal }) },
      setTimeout, clearTimeout, setImmediate, Date, Buffer, AbortController,
    }, { filename });
    return module.exports;
  }
  const throttle = load('objective-throttle.js', { './config': config });
  const claude = load('claude-session.js', {
    './config': config, './objective-throttle': throttle,
    './static-context': { getStaticBundleStats: () => ({ chars: 0, sha: '' }) },
    './spawn-utils': { augmentPathEnv: () => ({}), projectEnvExtras: () => ({}) },
    './task-agent/attachments': { localizeAttachments: async ({ prompt }) => ({ prompt }) },
    'node:fs/promises': { unlink: async () => {}, writeFile: async () => {} },
    'node:child_process': { spawn() {
      const proc = new EventEmitter();
      proc.pid = 90000 + processes.length;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write() {}, end() {} };
      processes.push(proc);
      return proc;
    } },
  });
  const session = { type: 'objective', tabId: 'test-tab', firstPrompt: 'Plan this',
    messages: [{ role: 'user', content: 'Plan this', timestamp: 0 }],
    timingMilestones: {}, totalTokens: { input: 0, output: 0 },
    _cachedTagsSerialized: new Set(), tagArchCache: new Map(),
    ws: { OPEN: 1, readyState: 1, send: text => frames.push(JSON.parse(text)) },
  };
  const start = () => throttle.requestTurn('A', () => claude.spawnObjectiveTurn(session, 'A'));
  const errors = () => frames.filter(f => f.type === 'objective-error');
  const out = event => session.proc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  return { throttle, claude, config, session, processes, signals, frames, start, errors, out };
}

test('silent Claude turn expires across automatic retries, emits one error and drains queue', t => {
  const h = harness(t);
  h.start();
  let nextRan = 0;
  h.throttle.requestTurn('B', () => nextRan++);
  t.mock.timers.tick(60000);
  t.mock.timers.tick(250);
  assert.equal(h.processes.length, 2, 'idle retry spawned without refreshing slot watchdog');
  t.mock.timers.tick(59749);
  assert.equal(h.errors().length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.errors().length, 1);
  assert.equal(h.errors()[0].reason, 'stream-stalled');
  assert.equal(h.errors()[0].tabId, 'test-tab');
  assert.equal(h.errors()[0].provider, 'claude');
  assert.equal(nextRan, 1);
  assert.equal(h.throttle.getStatus().pending, 0);
  assert.equal(h.throttle.getStatus().active, 1, 'only queued B retains a slot');
  assert.equal(h.session.proc, null);
  assert.equal(h.session.messages[0].content, 'Plan this', 'Retry retains original prompt');
  const stalledProc = h.processes[1];
  assert.ok(h.signals.some(s => s.pid === -stalledProc.pid && s.signal === 'SIGTERM'));
  t.mock.timers.tick(2000);
  assert.ok(h.signals.some(s => s.pid === -stalledProc.pid && s.signal === 'SIGKILL'));
  for (const proc of h.processes) proc.emit('close', 1);
  t.mock.timers.tick(120000);
  assert.equal(h.errors().length, 1, 'late close cannot emit another error or retry');
  assert.equal(h.processes.length, 2);
});

test('tool-only stream chunks keep a long turn alive; silence then expires it', t => {
  const h = harness(t);
  h.start();
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(45000);
    h.out({ type: 'stream_event', event: { type: 'content_block_start',
      content_block: { type: 'tool_use', name: 'Read', id: `tool-${i}` } } });
  }
  assert.equal(h.errors().length, 0);
  assert.equal(h.processes.length, 1);
  assert.ok(h.frames.some(f => f.type === 'objective-progress' && f.stage === 'tool'));
  t.mock.timers.tick(60000);
  t.mock.timers.tick(250);
  t.mock.timers.tick(60000);
  assert.equal(h.errors().length, 1);
});

test('late output, close, and kill escalation from stalled proc cannot damage Retry', t => {
  const h = harness(t, { OBJECTIVE_STREAM_IDLE_MS: 300000 });
  h.start();
  const old = h.session.proc;
  t.mock.timers.tick(120000);
  h.start();
  const replacement = h.session.proc;
  t.mock.timers.tick(2000);
  assert.ok(h.signals.some(s => s.pid === -old.pid && s.signal === 'SIGKILL'));
  assert.ok(!h.signals.some(s => s.pid === -replacement.pid));
  old.emit('close', 1);
  old.stdout.emit('data', Buffer.from('{}\n'));
  assert.equal(h.session.proc, replacement);
  assert.equal(h.session._aborted, false);
  t.mock.timers.tick(118000);
  assert.equal(h.errors().length, 2, 'fresh turn has its own watchdog');
});

for (const finish of ['recordSuccess', 'recordAbort', 'recordTimeout']) {
  test(`${finish} clears timer; stale activity cannot refresh a replacement slot`, t => {
    const { throttle } = harness(t);
    let expired = 0;
    throttle.requestTurn('A', () => {});
    const staleTouch = throttle.watchTurn('A', () => expired++);
    throttle[finish]('A', 'test');
    t.mock.timers.tick(120000);
    assert.equal(expired, 0);
    throttle.requestTurn('A', () => {});
    throttle.watchTurn('A', () => expired++);
    t.mock.timers.tick(119999);
    staleTouch();
    t.mock.timers.tick(1);
    assert.equal(expired, 1);
    assert.equal(throttle.getStatus().active, 0);
  });
}

test('throwing stall cleanup still frees slot without crashing timer callback', t => {
  const { throttle } = harness(t);
  throttle.requestTurn('A', () => {});
  throttle.watchTurn('A', () => { throw new Error('socket failed'); });
  t.mock.timers.tick(120000);
  assert.equal(throttle.getStatus().active, 0);
});
