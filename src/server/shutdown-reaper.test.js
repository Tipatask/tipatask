'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tt-shutdown-reaper-'));
process.env.TIPATASK_USER_DATA = scratch;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const { installShutdownReaper, defaultSleepSync, SHUTDOWN_KILL_GRACE_MS } = require('./shutdown-reaper');

// TPT295 — the server shutdown reaper. Runs the real claude-session.js and headless-claude.js in
// sandboxes whose process.kill only records [pid, signal] (no real signal is ever sent), then fires
// the reaper through a fake process emitter, exactly as SIGTERM/SIGINT/IPC 'disconnect' would.

let nextFakePid = 94000;
function fakeProc(pid = nextFakePid++) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  return proc;
}

function objectiveSession(fields) {
  return { type: 'objective', providerType: 'claude', proc: null, _aborted: false,
    _heartbeatTimer: null, _heartbeatProc: null, _heartbeatKillTimer: null, ...fields };
}

function harness(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_790_000_000_000 });
  const kills = [], logs = [], processes = [], sleeps = [], exits = [];
  const config = { ...require('./config'), SIMPLE_MODE: false,
    OBJECTIVE_PREWARM_ENABLED: true, OBJECTIVE_PREWARM_TTL_MS: 3600000 };
  const common = {
    './config': config,
    './spawn-utils': { augmentPathEnv: () => ({}), projectEnvExtras: () => ({}) },
    'node:child_process': { spawn() {
      const proc = fakeProc(92000 + processes.length);
      processes.push(proc);
      return proc;
    } },
  };
  const sandboxed = (file, mocks) => {
    const filename = path.join(__dirname, file);
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports,
      require: id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
      console: { log: (...a) => logs.push(a.join(' ')), warn() {}, error() {} },
      process: { env: {}, kill: (pid, sig) => { kills.push([pid, sig]); } },
      setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, Date, Buffer, AbortController,
    }, { filename });
    return module.exports;
  };
  const claude = sandboxed('claude-session.js', { ...common,
    './static-context': { getStaticBundleStats: () => ({ chars: 0, sha: '' }) },
    './arch-cache-prewarm': { prewarmArchCache() {} },
    './task-agent/attachments': { localizeAttachments: async ({ prompt }) => ({ prompt }) },
    'node:fs/promises': { unlink: async () => {}, writeFile: async () => {} },
  });
  const headless = sandboxed('headless-claude.js', common);
  const sessions = new Map();
  const proc = new EventEmitter();
  installShutdownReaper({
    sessions, claude, headless, proc,
    exit: code => exits.push(code),
    sleepSync: (ms) => { sleeps.push(ms); kills.push(['grace', ms]); },
  });
  const signalled = (p, sig) => kills.findIndex(([pid, s]) => pid === -p.pid && s === sig);
  return { claude, headless, sessions, proc, kills, logs, processes, sleeps, exits, signalled };
}

test('SIGTERM: every LLM proc group gets SIGTERM, then SIGKILL after the grace, then exit 0', t => {
  const h = harness(t);
  const turnA = fakeProc();
  const A = objectiveSession({ tabId: 'obj-a', proc: turnA });
  const heartbeatB = fakeProc();
  const B = objectiveSession({ tabId: 'obj-b', _heartbeatProc: heartbeatB });
  const turnC = fakeProc();
  const helperC = fakeProc();
  const C = { type: 'specChat', tabId: 'specChat:TPT1', proc: turnC };
  h.claude.trackHelperProc(C, helperC);
  // No tabId: the prewarm key comes from the composite map key, as in the sleep watchdog.
  const D = objectiveSession({ tabId: null, claudeSessionId: 'sess-d' });
  h.claude.prewarmObjective(D, 'obj-d');
  // Warm prewarm whose session already left the map, plus the global cold spare.
  h.claude.prewarmObjective(objectiveSession({ tabId: 'obj-e', claudeSessionId: 'sess-e' }), 'obj-e');
  h.claude.prewarmObjectiveCold();
  // A KB re-index Opus run in flight.
  h.headless.runHeadlessClaude('describe these tags', { parseJson: true });
  const [prewarmD, prewarmE, cold, reindex] = h.processes;
  // Exited (Node saw it) but its close has not landed yet: SIGTERMed by teardown, never SIGKILLed.
  const exitedF = Object.assign(fakeProc(), { exitCode: 0 });
  const F = objectiveSession({ tabId: 'obj-f', proc: exitedF });
  const T = { type: 'terminal', tabId: 'TPT9', alive: true, ptyPid: 93000 };
  for (const [key, s] of [['obj-a', A], ['obj-b', B], ['specChat:TPT1\0/proj', C], ['obj-d\0/proj', D],
    ['obj-f', F], ['TPT9\0/proj', T]]) h.sessions.set(key, s);
  assert.equal(h.claude.objectiveCacheActivity(h.sessions).prewarmCount, 3);

  h.proc.emit('SIGTERM');

  const grace = h.kills.findIndex(([pid]) => pid === 'grace');
  assert.ok(grace > 0, 'grace sleep ran');
  for (const p of [turnA, heartbeatB, turnC, helperC, prewarmD, prewarmE, cold, reindex]) {
    const term = h.signalled(p, 'SIGTERM');
    assert.ok(term >= 0 && term < grace, `pid ${p.pid} SIGTERMed before the grace`);
    assert.ok(h.signalled(p, 'SIGKILL') > grace, `pid ${p.pid} SIGKILLed after the grace`);
  }
  assert.ok(h.signalled(exitedF, 'SIGTERM') >= 0);
  assert.equal(h.signalled(exitedF, 'SIGKILL'), -1, 'a proc Node already saw exit is not SIGKILLed');
  assert.deepEqual(h.sleeps, [SHUTDOWN_KILL_GRACE_MS]);
  assert.deepEqual(h.exits, [0]);
  for (const s of [A, B, C, D, F]) assert.equal(s._closed, true);
  assert.equal(A.proc, null);
  assert.equal(T._closed, undefined, 'terminal session untouched');
  assert.ok(!h.kills.some(([pid]) => Math.abs(pid) === 93000), 'terminal pty never signalled');
  assert.equal(h.claude.objectiveCacheActivity(h.sessions).prewarmCount, 0);
  assert.ok(h.logs.includes(`[objective:prewarm] Killed pid ${prewarmD.pid} for task obj-d reason=SIGTERM`),
    'prewarm keyed by the map key id part is killed by the session teardown');
});

for (const [event, reason] of [['SIGINT', 'SIGINT'], ['disconnect', 'ipc-disconnect']]) {
  test(`${event} runs the same reap (reason=${reason}) and exits 0`, t => {
    const h = harness(t);
    const turn = fakeProc();
    const s = objectiveSession({ tabId: 'obj-a', proc: turn });
    h.sessions.set('obj-a', s);
    h.claude.prewarmObjectiveCold();
    const [cold] = h.processes;
    h.proc.emit(event);
    assert.equal(s._closed, true);
    for (const p of [turn, cold]) {
      assert.ok(h.signalled(p, 'SIGTERM') >= 0, `pid ${p.pid} SIGTERMed`);
      assert.ok(h.signalled(p, 'SIGKILL') >= 0, `pid ${p.pid} SIGKILLed`);
    }
    assert.ok(h.logs.includes(`[objective] Teardown task=obj-a reason=${reason}`));
    assert.deepEqual(h.exits, [0]);
  });
}

test('quitting fires SIGTERM and then the IPC disconnect: one reap, one exit', t => {
  const h = harness(t);
  h.sessions.set('obj-a', objectiveSession({ tabId: 'obj-a', proc: fakeProc() }));
  h.proc.emit('SIGTERM');
  const killsAfterFirst = h.kills.length;
  h.proc.emit('disconnect');
  h.proc.emit('SIGINT');
  assert.equal(h.kills.length, killsAfterFirst);
  assert.deepEqual(h.sleeps, [SHUTDOWN_KILL_GRACE_MS]);
  assert.deepEqual(h.exits, [0]);
});

test('with no LLM child alive it exits at once, without the grace sleep', t => {
  const h = harness(t);
  h.sessions.set('obj-idle', objectiveSession({ tabId: 'obj-idle' }));
  h.proc.emit('SIGTERM');
  assert.deepEqual(h.kills, []);
  assert.deepEqual(h.sleeps, []);
  assert.deepEqual(h.exits, [0]);
});

test('a reap that throws still exits 0 — the SIGTERM listener must never leave the server running', t => {
  t.mock.method(console, 'error', () => {});
  const proc = new EventEmitter();
  const exits = [];
  installShutdownReaper({
    sessions: new Map([['obj-x', { type: 'objective' }]]),
    claude: { teardownObjectiveSession() { throw new Error('boom'); } },
    headless: { killAllHeadlessProcs: () => [] },
    proc,
    exit: code => exits.push(code),
    sleepSync: () => assert.fail('nothing was signalled — no grace sleep'),
  });
  proc.emit('SIGTERM');
  assert.deepEqual(exits, [0]);
  assert.equal(console.error.mock.callCount(), 1);
});

test('defaultSleepSync blocks the thread for the requested time', () => {
  const start = process.hrtime.bigint();
  defaultSleepSync(20);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms >= 19, `blocked only ${ms}ms`);
});
