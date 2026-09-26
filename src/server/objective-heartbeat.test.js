'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

// Heartbeat (prompt-cache keepalive) gates: wall-clock cache TTL, sleep drift, per-idle-period
// ping cap. Runs claude-session.js in a sandbox with fake CLI processes and mocked time
// (setTimeout + Date together, so Date.now() gates actually see the jump).
function harness(t, overrides = {}) {
  // Real-looking epoch: a mocked clock at 0 would read as "never touched" to the TTL gate.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_790_000_000_000 });
  const config = { ...require('./config'), SIMPLE_MODE: false,
    OBJECTIVE_HEARTBEAT_ENABLED: true, OBJECTIVE_HEARTBEAT_MS: 240000,
    OBJECTIVE_HEARTBEAT_MAX_PINGS: 3, OBJECTIVE_HEARTBEAT_TIMEOUT_MS: 30000, ...overrides };
  const processes = [], logs = [], kills = [];
  const filename = path.join(__dirname, 'claude-session.js');
  const realRequire = createRequire(filename);
  const mocks = {
    './config': config,
    './static-context': { getStaticBundleStats: () => ({ chars: 0, sha: '' }) },
    './spawn-utils': {
      augmentPathEnv: extras => ({ ...extras }),
      projectEnvExtras: projectRoot => projectRoot ? { TIPATASK_PROJECT_ROOT: projectRoot, PROJECT_ENV_MARKER: projectRoot } : {},
    },
    './task-agent/attachments': { localizeAttachments: async ({ prompt }) => ({ prompt }) },
    'node:fs/promises': { unlink: async () => {}, writeFile: async () => {} },
    'node:child_process': { spawn(command, args, options) {
      const proc = new EventEmitter();
      proc.pid = 91000 + processes.length;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write() {}, end() {} };
      proc.spawnCall = { command, args, options };
      processes.push(proc);
      return proc;
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
    console: { log: (...a) => logs.push(a.join(' ')), warn() {}, error() {} },
    process: { env: {}, kill: (pid, sig) => { kills.push([pid, sig]); } },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, Date, Buffer, AbortController,
  }, { filename });
  const claude = module.exports;
  const session = { type: 'objective', providerType: 'claude', claudeSessionId: 'sess-1',
    proc: null, _aborted: false, _heartbeatTimer: null,
    _heartbeatProc: null, _heartbeatKillTimer: null, _heartbeatSleepBlocked: false,
    _heartbeatDueAt: 0, _lastCacheTouchAt: Date.now(), _heartbeatPings: 0 };
  const skips = reason => logs.filter(l => l.includes(`[objective:heartbeat] skip reason=${reason}`));
  // Simulate a successful ping reply on the most recent heartbeat proc.
  const reply = () => {
    const proc = processes[processes.length - 1];
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ session_id: 'sess-1', result: 'ok' })));
    proc.emit('close', 0);
  };
  return { claude, config, session, processes, logs, kills, skips, reply };
}

test('armHeartbeat sets no timer when the cache TTL has already elapsed', t => {
  const h = harness(t);
  h.session._lastCacheTouchAt = Date.now() - 300000;
  h.claude.armHeartbeat(h.session, 'A');
  assert.equal(h.session._heartbeatTimer, null);
  assert.equal(h.skips('cache-expired').length, 1);
  t.mock.timers.tick(600000);
  assert.equal(h.processes.length, 0);
});

test('armHeartbeat sets no timer when there was never a cache touch', t => {
  const h = harness(t);
  h.session._lastCacheTouchAt = 0;
  h.claude.armHeartbeat(h.session, 'A');
  assert.equal(h.session._heartbeatTimer, null);
  assert.equal(h.processes.length, 0);
});

test('armHeartbeat records the wall-clock due time of a warm-cache timer', t => {
  const h = harness(t);
  const now = Date.now();
  h.claude.armHeartbeat(h.session, 'A');
  assert.notEqual(h.session._heartbeatTimer, null);
  assert.equal(h.session._heartbeatDueAt, now + 240000);
});

test('a heartbeat released 20 min late by system sleep never spawns and never re-arms', t => {
  const h = harness(t);
  h.claude.armHeartbeat(h.session, 'A');
  // Sleep: wall clock jumps 20 min without timers running, then the dark-wake releases the
  // expired timer all at once.
  t.mock.timers.setTime(Date.now() + 20 * 60000);
  t.mock.timers.tick(1);
  assert.equal(h.processes.length, 0);
  assert.equal(h.skips('drift').length, 1);
  assert.equal(h.session._heartbeatTimer, null);
  t.mock.timers.tick(60 * 60000);
  assert.equal(h.processes.length, 0);
});

test('sleep watchdog clears every heartbeat and kills warm/cold cache-only procs', t => {
  const h = harness(t, { OBJECTIVE_PREWARM_ENABLED: true, OBJECTIVE_PREWARM_TTL_MS: 3600000 });
  const sessionB = { ...h.session, tabId: 'B', claudeSessionId: 'sess-2',
    _heartbeatTimer: null, _heartbeatProc: null, _heartbeatKillTimer: null };
  h.session.tabId = 'A';
  const sessions = new Map([['A', h.session], ['B', sessionB]]);

  h.claude.prewarmObjective(h.session, 'A');
  h.claude.prewarmObjective(sessionB, 'B');
  h.claude.prewarmObjectiveCold();
  h.claude.armHeartbeat(h.session, 'A');
  t.mock.timers.tick(240000);
  assert.notEqual(h.session._heartbeatProc, null, 'first session has an in-flight heartbeat');
  h.claude.armHeartbeat(sessionB, 'B');
  assert.notEqual(sessionB._heartbeatTimer, null, 'second session has an armed heartbeat');
  let activity = h.claude.objectiveCacheActivity(sessions);
  assert.equal(activity.activeHeartbeats, 2);
  assert.equal(activity.prewarmCount, 3);

  const spawnCountBeforeWake = h.processes.length;
  h.claude.startSleepWatchdog(() => sessions);
  t.mock.timers.setTime(Date.now() + 46000);
  t.mock.timers.tick(1);

  assert.equal(h.session._heartbeatProc, null);
  assert.equal(sessionB._heartbeatTimer, null);
  assert.equal(h.session._heartbeatSleepBlocked, true);
  assert.equal(sessionB._heartbeatSleepBlocked, true);
  activity = h.claude.objectiveCacheActivity(sessions);
  assert.equal(activity.activeHeartbeats, 0);
  assert.equal(activity.prewarmCount, 0);
  assert.ok(h.logs.some(line => line === '[objective:sleep] wake gap=46s'));
  assert.ok(h.kills.some(([pid, sig]) => pid === -h.processes[3].pid && sig === 'SIGTERM'), 'in-flight heartbeat killed');

  t.mock.timers.tick(60 * 60000);
  assert.equal(h.processes.length, spawnCountBeforeWake, 'wake cleanup never releases a later heartbeat spawn');
});

test('spawnHeartbeat skips a cache-expired fire even when it is on time', t => {
  const h = harness(t);
  h.session._heartbeatDueAt = Date.now();
  h.session._lastCacheTouchAt = Date.now() - 300000;
  h.claude.spawnHeartbeat(h.session, 'A');
  assert.equal(h.processes.length, 0);
  assert.equal(h.skips('cache-expired').length, 1);
  assert.equal(h.session._heartbeatTimer, null);
});

test('a failed ping does not refresh the cache or re-arm', t => {
  const h = harness(t);
  const touch = h.session._lastCacheTouchAt;
  h.claude.armHeartbeat(h.session, 'A');
  t.mock.timers.tick(240000);
  assert.equal(h.processes.length, 1);
  h.processes[0].emit('close', 1);
  assert.equal(h.session._lastCacheTouchAt, touch);
  assert.equal(h.session._heartbeatTimer, null);
  t.mock.timers.tick(60 * 60000);
  assert.equal(h.processes.length, 1);
});

test('ping cap: a 4th consecutive ping with no user turn is never spawned', t => {
  const h = harness(t);
  h.claude.armHeartbeat(h.session, 'A');
  for (let i = 1; i <= 3; i++) {
    t.mock.timers.tick(240000);
    assert.equal(h.processes.length, i);
    h.reply();
  }
  assert.equal(h.session._heartbeatPings, 3);
  assert.equal(h.session._heartbeatTimer, null);
  assert.equal(h.skips('cap').length, 1);
  t.mock.timers.tick(60 * 60000);
  assert.equal(h.processes.length, 3);

  // A real turn (finalizeCloseTurn) touches the cache and resets the counter — pings resume.
  h.session._lastCacheTouchAt = Date.now();
  h.session._heartbeatPings = 0;
  h.claude.armHeartbeat(h.session, 'A');
  t.mock.timers.tick(240000);
  assert.equal(h.processes.length, 4);
});

test('config: heartbeat is off by default and the ping cap defaults to 3', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-heartbeat-cfg-'));
  try {
    const env = { ...process.env, TIPATASK_USER_DATA: scratch, TIPATASK_PROJECT_ROOT: scratch,
      TIPATASK_SERVER_ROOT: path.resolve(__dirname, '../..') };
    delete env.OBJECTIVE_HEARTBEAT_ENABLED;
    delete env.OBJECTIVE_HEARTBEAT_MAX_PINGS;
    const out = execFileSync(process.execPath, ['-e',
      `const c = require(${JSON.stringify(path.join(__dirname, 'config.js'))});` +
      `process.stdout.write(JSON.stringify([c.OBJECTIVE_HEARTBEAT_ENABLED, c.OBJECTIVE_HEARTBEAT_MAX_PINGS]))`,
    ], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), [false, 3]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// TPT292 — closing/saving an objective chat must leave no LLM activity behind.
test('teardownObjectiveSession clears every timer, kills prewarm + turn proc, and later arms are no-ops', t => {
  const h = harness(t, { OBJECTIVE_PREWARM_ENABLED: true, OBJECTIVE_PREWARM_TTL_MS: 240000 });
  h.claude.prewarmObjective(h.session, 'A');
  assert.equal(h.processes.length, 1, 'prewarm proc spawned');
  const prewarmPid = h.processes[0].pid;
  h.claude.armHeartbeat(h.session, 'A');
  assert.notEqual(h.session._heartbeatTimer, null);
  h.session._idleTimer = setTimeout(() => assert.fail('idle timer fired'), 1000);
  h.session._retryTimer = setTimeout(() => assert.fail('retry timer fired'), 1000);
  h.session._turnDeadline = setTimeout(() => assert.fail('turn deadline fired'), 1000);
  const turnProc = new EventEmitter();
  turnProc.pid = 95000;
  h.session.proc = turnProc;

  h.claude.teardownObjectiveSession(h.session, 'A', 'finalize');

  for (const k of ['_heartbeatTimer', '_idleTimer', '_retryTimer', '_turnDeadline']) {
    assert.equal(h.session[k], null, `${k} cleared`);
  }
  assert.equal(h.session.proc, null);
  assert.equal(h.session._closed, true);
  assert.ok(h.kills.some(([pid, sig]) => pid === -prewarmPid && sig === 'SIGTERM'), 'prewarm group killed');
  assert.ok(h.kills.some(([pid, sig]) => pid === -95000 && sig === 'SIGTERM'), 'turn proc group killed');
  t.mock.timers.tick(2000);
  assert.ok(h.kills.some(([pid, sig]) => pid === -95000 && sig === 'SIGKILL'), 'turn proc escalated to SIGKILL');

  // Later arm/prewarm attempts are no-ops; nothing spawns for the next hour.
  h.claude.armHeartbeat(h.session, 'A');
  assert.equal(h.session._heartbeatTimer, null);
  h.claude.prewarmObjective(h.session, 'A');
  t.mock.timers.tick(60 * 60000);
  assert.equal(h.processes.length, 1);

  // Idempotent.
  h.claude.teardownObjectiveSession(h.session, 'A', 'kill');
  assert.equal(h.session._closed, true);
});

test('a heartbeat already in flight at teardown does not re-arm when its reply lands', t => {
  const h = harness(t);
  h.claude.armHeartbeat(h.session, 'A');
  t.mock.timers.tick(240000);
  assert.equal(h.processes.length, 1);
  h.claude.teardownObjectiveSession(h.session, 'A', 'kill');
  h.reply();
  assert.equal(h.session._heartbeatTimer, null);
  t.mock.timers.tick(60 * 60000);
  assert.equal(h.processes.length, 1);
});

test('clearContext tears down timers but re-opens the session for a fresh turn', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_790_000_000_000 });
  const { clearContext } = require('./context-manager');
  const session = { type: 'objective', providerType: 'claude', claudeSessionId: 'sess-1', proc: null,
    messages: [{ role: 'user', content: 'x' }], abortController: new AbortController(),
    _heartbeatTimer: setTimeout(() => assert.fail('heartbeat fired after clearContext'), 1000),
    _turnDeadline: setTimeout(() => assert.fail('deadline fired after clearContext'), 1000) };
  clearContext(session, 'obj-clear-context-test');
  assert.equal(session._heartbeatTimer, null);
  assert.equal(session._turnDeadline, null);
  assert.equal(session._closed, false);
  assert.equal(session._aborted, false);
  assert.deepEqual(session.messages, []);
  t.mock.timers.tick(5000);
});

// TPT294 — everything teardown must also stop, beyond the heartbeat/prewarm/turn proc above.
function fakeProc(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  return proc;
}

test('teardown clears Codex/Gemini/Pi turn timers so they never fire a late recordTimeout', t => {
  const h = harness(t);
  h.session._turnDeadlineTimer = setTimeout(() => assert.fail('provider turn deadline fired'), 1000);
  h.session._idleWatchdogTimer = setTimeout(() => assert.fail('provider idle watchdog fired'), 1000);
  h.session._workingTicker = setInterval(() => assert.fail('codex working ticker fired'), 500);
  h.claude.teardownObjectiveSession(h.session, 'A', 'kill');
  assert.equal(h.session._turnDeadlineTimer, null);
  assert.equal(h.session._idleWatchdogTimer, null);
  assert.equal(h.session._workingTicker, null);
  t.mock.timers.tick(10 * 60000);
});

test('teardown kills tracked helper procs (SIGTERM, then SIGKILL) and forgets exited ones', t => {
  const h = harness(t);
  const running = fakeProc(95100);
  const exited = fakeProc(95101);
  h.claude.trackHelperProc(h.session, running);
  h.claude.trackHelperProc(h.session, exited);
  exited.emit('close', 0);
  assert.equal(h.session._helperProcs.size, 1, 'an exited helper leaves the set');
  h.claude.teardownObjectiveSession(h.session, 'A', 'kill');
  assert.equal(h.session._helperProcs, null);
  assert.ok(h.kills.some(([pid, sig]) => pid === -95100 && sig === 'SIGTERM'), 'running helper SIGTERMed');
  assert.ok(!h.kills.some(([pid]) => pid === -95101), 'exited helper left alone');
  t.mock.timers.tick(2000);
  assert.ok(h.kills.some(([pid, sig]) => pid === -95100 && sig === 'SIGKILL'), 'escalated to SIGKILL');
});

test('every teardown bumps the session epoch', t => {
  const h = harness(t);
  h.claude.teardownObjectiveSession(h.session, 'A', 'clear-context');
  assert.equal(h.session._epoch, 1);
  h.claude.teardownObjectiveSession(h.session, 'A', 'kill');
  assert.equal(h.session._epoch, 2);
});

test('spawnObjectiveTurn on a closed session spawns nothing and frees its throttle slot', t => {
  const h = harness(t);
  const throttle = require('./objective-throttle');
  h.session._closed = true;
  const res = throttle.requestTurn('obj-tpt294-closed', () => h.claude.spawnObjectiveTurn(h.session, 'obj-tpt294-closed'));
  try {
    assert.deepEqual(res, { ok: true });
    assert.equal(h.processes.length, 0);
    assert.equal(throttle.getStatus().active, 0, 'slot released by the early return');
    assert.ok(h.logs.some(l => l.includes('Spawn skipped for closed session task=obj-tpt294-closed')));
  } finally {
    throttle.recordAbort('obj-tpt294-closed');
  }
});

test('a heartbeat killed by teardown never writes its session id back (restart safety)', t => {
  const h = harness(t);
  h.claude.armHeartbeat(h.session, 'A');
  t.mock.timers.tick(240000);
  assert.equal(h.processes.length, 1);
  const hb = h.processes[0];
  const touch = h.session._lastCacheTouchAt;
  h.claude.teardownObjectiveSession(h.session, 'A', 'clear-context');
  assert.ok(h.kills.some(([pid, sig]) => pid === -hb.pid && sig === 'SIGTERM'), 'in-flight ping killed');
  // clearContext() re-opens the session and nulls the provider id for the restart's fresh turn.
  Object.assign(h.session, { _closed: false, _aborted: false, claudeSessionId: null });
  hb.stdout.emit('data', Buffer.from(JSON.stringify({ session_id: 'sess-pre-restart', result: 'ok' })));
  hb.emit('close', 0);
  assert.equal(h.session.claudeSessionId, null, 'pre-restart session id not resurrected');
  assert.equal(h.session._lastCacheTouchAt, touch);
  assert.equal(h.session._heartbeatTimer, null);
});

test('armIdleCacheWork warms only an attached objective chat', t => {
  const h = harness(t, { OBJECTIVE_PREWARM_ENABLED: true, OBJECTIVE_PREWARM_TTL_MS: 240000 });
  h.claude.armIdleCacheWork(h.session, 'A'); // no socket: turn finished inside the detach grace
  h.session.ws = { OPEN: 1, readyState: 3 }; // CLOSED
  h.claude.armIdleCacheWork(h.session, 'A');
  const spec = { ...h.session, type: 'specChat', ws: { OPEN: 1, readyState: 1 } };
  h.claude.armIdleCacheWork(spec, 'specChat:A');
  assert.equal(h.session._heartbeatTimer, null);
  assert.equal(spec._heartbeatTimer, null);
  assert.equal(h.processes.length, 0, 'no prewarm for a detached chat or a spec chat');

  h.session.ws = { OPEN: 1, readyState: 1 };
  h.claude.armIdleCacheWork(h.session, 'A');
  assert.notEqual(h.session._heartbeatTimer, null, 'heartbeat armed while attached');
  assert.equal(h.processes.length, 1, 'next-turn prewarm spawned while attached');
});

test('a same-project first turn adopts the cold prewarm with that project cwd and env', t => {
  const h = harness(t, { OBJECTIVE_PREWARM_ENABLED: true, OBJECTIVE_PREWARM_TTL_MS: 240000,
    OBJECTIVE_TIMING_ENABLED: false });
  const projectRoot = path.join(os.tmpdir(), 'tpt296-same-project');
  h.claude.prewarmObjectiveCold(projectRoot);
  assert.equal(h.processes.length, 1);
  const cold = h.processes[0];
  assert.equal(cold.spawnCall.options.cwd, projectRoot);
  assert.equal(cold.spawnCall.options.env.TIPATASK_PROJECT_ROOT, projectRoot);
  assert.equal(cold.spawnCall.options.env.PROJECT_ENV_MARKER, projectRoot);
  const session = Object.assign(require('./session-state').createSession(null, false, 'obj-tpt296-same', projectRoot), {
    type: 'objective', providerType: 'claude', claudeSessionId: null, projectPath: projectRoot,
    messages: [{ role: 'user', content: 'Plan it' }], firstPrompt: 'Plan it',
  });
  h.claude.spawnObjectiveTurn(session, 'obj-tpt296-same');
  assert.equal(h.processes.length, 1, 'same-root turn reuses the cold proc');
  assert.equal(session.proc, cold);
  assert.ok(h.logs.some(l => l.includes('cold prewarm adopted')));
  h.claude.teardownObjectiveSession(session, 'obj-tpt296-same', 'test-cleanup');
});

test('a different-project first turn kills the cold prewarm instead of orphaning it', t => {
  const h = harness(t, { OBJECTIVE_PREWARM_ENABLED: true, OBJECTIVE_PREWARM_TTL_MS: 240000,
    OBJECTIVE_TIMING_ENABLED: false });
  const warmedRoot = path.join(os.tmpdir(), 'tpt296-warmed-project');
  h.claude.prewarmObjectiveCold(warmedRoot);
  assert.equal(h.processes.length, 1);
  const cold = h.processes[0];
  const otherRoot = path.join(os.tmpdir(), 'tpt294-other-project');
  const session = Object.assign(require('./session-state').createSession(null, false, 'obj-tpt294-cross', otherRoot), {
    type: 'objective', providerType: 'claude', claudeSessionId: null, projectPath: otherRoot,
    messages: [{ role: 'user', content: 'Plan it' }], firstPrompt: 'Plan it',
  });
  h.claude.spawnObjectiveTurn(session, 'obj-tpt294-cross');
  assert.ok(h.kills.some(([pid, sig]) => pid === -cold.pid && sig === 'SIGTERM'), 'cold proc SIGTERMed');
  assert.ok(h.logs.some(l => l.includes(`Killed pid ${cold.pid} reason=cross-project`)));
  assert.equal(h.claude.objectiveCacheActivity(new Map()).prewarmCount, 0, 'cold slot emptied');
  assert.notEqual(session.proc, cold, 'never adopted across project roots');
  assert.equal(session.proc.spawnCall.options.cwd, otherRoot);
  assert.equal(session.proc.spawnCall.options.env.TIPATASK_PROJECT_ROOT, otherRoot);
  h.claude.teardownObjectiveSession(session, 'obj-tpt294-cross', 'test-cleanup');
});

test('efficiency analysis never starts for a chat closed during its awaits', async t => {
  const h = harness(t);
  Object.assign(h.session, { timingMilestones: { toolCalls: [], turnStart: Date.now() },
    turnTokens: { input: 1, output: 1 } });
  const pending = h.claude.spawnEfficiencyAnalysis(h.session, 120000);
  h.claude.teardownObjectiveSession(h.session, 'A', 'kill'); // lands while it awaits
  assert.equal((await pending).length, 0); // (vm-realm array: compare by length)
  assert.equal(h.processes.length, 0);
});

test('a running efficiency analysis is registered and killed with the chat', async t => {
  const h = harness(t, { OBJECTIVE_EFFICIENCY_TIMEOUT_MS: 30000 });
  Object.assign(h.session, { timingMilestones: { toolCalls: [], turnStart: Date.now() },
    turnTokens: { input: 1, output: 1 } });
  const pending = h.claude.spawnEfficiencyAnalysis(h.session, 120000);
  await new Promise(resolve => setImmediate(resolve)); // let its two awaits settle
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.processes.length, 1, 'Haiku helper spawned');
  const helper = h.processes[0];
  assert.equal(h.session._helperProcs.size, 1);
  h.claude.teardownObjectiveSession(h.session, 'A', 'kill');
  assert.ok(h.kills.some(([pid, sig]) => pid === -helper.pid && sig === 'SIGTERM'), 'helper SIGTERMed');
  helper.emit('close', null);
  assert.equal((await pending).length, 0); // killed mid-flight: no hint cards
});
