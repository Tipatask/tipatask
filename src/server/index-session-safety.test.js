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
async function harness(killEnv, failStartup = false, validationEnabled = false) {
  const timers = new Map();
  const exits = [];
  const lines = [];
  const sweeps = [];
  const memory = { starts: 0, stops: 0, ended: [], options: null };
  const validation = { samples: [], lifecycle: [], watchdog: [], stops: 0, trackerOptions: null };
  let shutdownOptions, listenCallback;
  const proc = Object.assign(new EventEmitter(), {
    env: { TIPATASK_WATCHDOG_KILL: killEnv }, platform: 'darwin', arch: 'arm64',
    exit: code => exits.push(code),
  });
  const log = { log() {}, warn() {}, error: line => lines.push(line) };
  const server = Object.assign(new EventEmitter(), { listen(port, host, callback) { listenCallback = callback; } });
  const backend = { init: async () => { if (failStartup) throw Error('startup failed'); }, getTask: async () => ({ status: 'completed' }) };
  const mocks = {
    'node:fs': { existsSync: () => false },
    'node:child_process': { execFileSync: () => 'caveman' },
    'node:http': { createServer: () => server },
    './config': { USER_NAME: 'test', USER_DATA_ROOT: '/scratch', SERVER_ROOT: '/scratch',
      PROJECT_ROOT: '/project-a', TASK_BACKEND: 'api' },
    './spawn-utils': { augmentPathEnv: () => ({}), isAsarPath: () => false },
    './task-backend': { createBackend: () => backend, coerceBackendType: () => 'api' },
    './ws-handlers': { createHttpHandler: () => () => {}, drainSessionQueue() {}, sessionQueue: { setAdmission() {}, isRunning: () => false } },
    './session-admission': { createSessionAdmission: () => ({ start() {}, stop() {}, snapshot: () => ({ cap: 6 }) }) },
    './session-validation': { createSessionValidationRecorder: () => ({
      status: () => ({ enabled: validationEnabled }),
      sample: (...args) => validation.samples.push(args), lifecycle: e => validation.lifecycle.push(e),
      watchdog: e => validation.watchdog.push(e), stop() { validation.stops++; },
    }) },
    './ws-upgrade': { createWebSocketGate: () => ({ clients: new Set([{ _boardWatcher: true }]) }) },
    './websocket': { init() {}, emitTaskUpdated() {}, emitSessionRunaway() {} },
    './task-agent': { preloadAgentDetection: async () => {}, listAllAgentModels: async () => [] },
    './status-roles': { fetchStatusRoles: async () => ({ complete: 'completed' }) },
    './git-merge/completion-guard': { guardCompletionTransition: async () => ({ allowed: true }), warnIfCompletedWorktreeDirty: async () => {} },
    './task-change-poll': { createTaskChangePoll: () => ({ tick: async () => { throw new TypeError('poll failed'); } }) },
    './terminal-session': { killRunawaySession, pauseRunawaySession },
    './process-group': { snapshotProcesses: async () => ({}), resolveAgentLimits,
      sweepDescendantWatchdog: (...args) => sweeps.push(args) },
    './shutdown-reaper': { installShutdownReaper(opts) { shutdownOptions = opts; } },
    './memory-telemetry': { createMemoryTelemetry: opts => {
      memory.options = opts;
      return { tracker: {}, start() { memory.starts++; }, stop() { memory.stops++; }, snapshot: () => ({ diagnostic: true }) };
    } },
    './session-memory': { createSessionMemoryTracker: opts => { validation.trackerOptions = opts; return {}; }, setSessionMemoryTracker() {},
      endSessionMemory(...args) { memory.ended.push(args); } },
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
    setTimeout, clearTimeout, setImmediate() {},
  }, { filename });
  // Let the async boot chain install the actual 10-second polling callback.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, failStartup ? [1] : [], lines.join('\n'));
  if (!failStartup) assert.ok(timers.has(10000));
  return { sessions: module.exports.sessions, timers, proc, exits, lines, sweeps, memory, validation,
    server, shutdownOptions, ready: () => listenCallback(), getMemoryTelemetry: module.exports.getMemoryTelemetry };
}

test('optional session validation records lifecycle, measurements and watchdog before shutdown without disabled sampling cost', async () => {
  const disabled = await harness();
  assert.equal(disabled.memory.options.onSample, null);
  assert.equal(disabled.validation.trackerOptions.onLifecycle, null);
  const h = await harness(undefined, false, true);
  const snapshot = { host: { pressure: 'normal' } };
  h.memory.options.onSample(snapshot);
  assert.equal(h.validation.samples[0][0], snapshot);
  assert.equal(h.validation.samples[0][1].cap, 6);
  assert.equal(h.validation.samples[0][2], h.sessions);
  h.validation.trackerOptions.onLifecycle({ type: 'end' });
  assert.equal(h.validation.lifecycle[0].type, 'end');
  await h.timers.get(30000)();
  const event = { paused: true };
  h.sweeps[0][2].emitSessionRunaway('/project', event);
  assert.equal(h.validation.watchdog[0], event);
  h.server.emit('close');
  assert.equal(h.validation.stops, 1);
});

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

test('bootstrap starts telemetry on listen and wires close, exit, reaper and startup-failure cleanup', async () => {
  const h = await harness();
  assert.equal(h.memory.starts, 0);
  h.ready();
  assert.equal(h.memory.starts, 1);
  assert.equal(h.memory.options.getSessions(), h.sessions);
  assert.equal(h.getMemoryTelemetry().diagnostic, true);
  h.server.emit('close');
  h.proc.emit('exit');
  h.shutdownOptions.beforeShutdown();
  assert.equal(h.memory.stops, 3);
  const failed = await harness(undefined, true);
  assert.equal(failed.memory.starts, 0);
  assert.equal(failed.memory.stops, 1);
});

test('completion sweep freezes task memory history even while terminal remains alive', async () => {
  const h = await harness();
  const s = { type: 'terminal', alive: true, taskId: 'TPT1', _terminalOutputSeen: true, onSessionExit() {} };
  h.sessions.set('TPT1', s);
  await assert.rejects(h.timers.get(10000)(), /poll failed/);
  assert.equal(s.alive, true);
  assert.equal(h.memory.ended.length, 1);
  assert.equal(h.memory.ended[0][0], s);
  assert.equal(h.memory.ended[0][1], 'completed');
});
