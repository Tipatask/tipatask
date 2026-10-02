'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { installCrashGuard } = require('./crash-guard');

// Stand-ins the mocked modules export, so the sweep wiring can be asserted by identity.
const resolveAgentLimits = () => ({});
const killRunawaySession = () => null;
const pauseRunawaySession = () => null;

// Execute the real bootstrap and timer callbacks without opening sockets, reading
// credentials, running agents, or touching the user's process tree.
async function harness(killEnv) {
  const timers = new Map();
  const exits = [];
  const lines = [];
  const sweeps = [];
  const proc = Object.assign(new EventEmitter(), {
    env: { TIPATASK_WATCHDOG_KILL: killEnv }, platform: 'darwin', arch: 'arm64',
    exit: code => exits.push(code),
  });
  const log = { log() {}, warn() {}, error: line => lines.push(line) };
  const server = Object.assign(new EventEmitter(), { listen() {} });
  const backend = { init: async () => {} };
  const mocks = {
    'node:fs': { existsSync: () => false },
    'node:child_process': { execFileSync: () => 'caveman' },
    'node:http': { createServer: () => server },
    './config': { USER_NAME: 'test', USER_DATA_ROOT: '/scratch', SERVER_ROOT: '/scratch',
      PROJECT_ROOT: '/project-a', TASK_BACKEND: 'api' },
    './spawn-utils': { augmentPathEnv: () => ({}), isAsarPath: () => false },
    './task-backend': { createBackend: () => backend, coerceBackendType: () => 'api' },
    './ws-handlers': { createHttpHandler: () => () => {}, drainSessionQueue() {} },
    './ws-upgrade': { createWebSocketGate: () => ({ clients: new Set([{ _boardWatcher: true }]) }) },
    './websocket': { init() {} },
    './task-agent': { preloadAgentDetection: async () => {}, listAllAgentModels: async () => [] },
    './status-roles': {},
    './task-change-poll': { createTaskChangePoll: () => ({ tick: async () => { throw new TypeError('poll failed'); } }) },
    './terminal-session': { killRunawaySession, pauseRunawaySession },
    './process-group': { snapshotProcesses: async () => ({}), resolveAgentLimits,
      sweepDescendantWatchdog: (...args) => sweeps.push(args) },
    './shutdown-reaper': { installShutdownReaper() {} },
    './crash-guard': { installCrashGuard: opts => installCrashGuard({ ...opts,
      proc, exit: proc.exit, log, recordExit() {} }) },
    './project-config': {},
    './local-access': { createLocalAccess: () => ({}), LOCAL_HOST: '127.0.0.1' },
  };
  const module = { exports: {} };
  const filename = path.join(__dirname, 'index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process: proc, console: log,
    require: id => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected bootstrap dependency: ${id}`);
    },
    setInterval: (fn, ms) => { timers.set(ms, fn); return { unref() {} }; },
    setTimeout, clearTimeout,
  }, { filename });
  // Let the async boot chain install the actual 10-second polling callback.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [], lines.join('\n'));
  assert.ok(timers.has(10000));
  return { sessions: module.exports.sessions, timers, proc, exits, lines, sweeps };
}

test('bootstrap guard reads live sessions in any project on every exception', async () => {
  const h = await harness();
  h.sessions.set('a/project-a', { alive: false });
  h.sessions.set('b/project-b', { alive: true });
  h.proc.emit('uncaughtException', new TypeError('background callback'));
  assert.deepEqual(h.exits, []);
  assert.match(h.lines.at(-1), /kept alive to preserve live sessions/);
  h.sessions.get('b/project-b').alive = false;
  h.proc.emit('uncaughtException', new TypeError('after last exit'));
  assert.deepEqual(h.exits, [1]);
});

test('actual 10s poll callback rejects safely without changing live sessions', async () => {
  const h = await harness();
  const session = { alive: true, type: 'terminal' };
  h.sessions.set('b/project-b', session);
  let rejection;
  try { await h.timers.get(10000)(); } catch (err) { rejection = err; }
  assert.match(rejection?.message, /poll failed/);
  h.proc.emit('unhandledRejection', rejection);
  assert.deepEqual(h.exits, []);
  assert.equal(session.alive, true);
  assert.equal(h.sessions.get('b/project-b'), session);
  assert.match(h.lines.at(-1), /unhandled rejection.*poll failed/s);
});

// The watchdog's action is a per-project limit, not a boot-time switch: whatever the legacy
// env var says, the sweep is handed the shared limits resolver (which maps the exact value
// '1' to 'kill' — covered in process-group.test.js) plus both the pause and the kill handler.
test('bootstrap hands the watchdog sweep the limits resolver and both action handlers', async () => {
  for (const value of [undefined, '', '0', 'true', '1']) {
    const h = await harness(value);
    await h.timers.get(30000)();
    assert.equal(h.sweeps.length, 1);
    const deps = h.sweeps[0][2];
    assert.equal(deps.resolveLimits, resolveAgentLimits);
    assert.equal(deps.killRunawaySession, killRunawaySession);
    assert.equal(deps.pauseRunawaySession, pauseRunawaySession);
    assert.equal('killEnabled' in deps, false);
  }
});
