'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMemoryTelemetry, parseMemoryProcesses, MEMORY_PS_ARGS } = require('./memory-telemetry');
const { createSessionMemoryTracker } = require('./session-memory');
const { installShutdownReaper } = require('./shutdown-reaper');
const sys = 'hw.memsize: 51539607552\nkern.memorystatus_vm_pressure_level: 1';
const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nFile-backed pages: 20.\nPages occupied by compressor: 30.\nPages stored in compressor: 90.\nSwapins: 0.\nSwapouts: 0.';
const ps = '10 10 1 100 S\n10 11 10 200 S';

function harness(extra = {}) {
  let time = 1000, stopped = 0, clears = 0, ticks = 0, callback;
  const sessions = new Map([['task', { type: 'terminal', alive: true, ptyPid: 10, taskAgent: 'codex' }]]);
  const tracker = createSessionMemoryTracker({ now: () => time });
  const calls = [];
  const runner = { async run(file, args) {
    calls.push([file, args]);
    return file.endsWith('sysctl') ? sys : file.endsWith('vm_stat') ? vm : ps;
  }, stop() { stopped++; } };
  const telemetry = createMemoryTelemetry({ getSessions: () => sessions, isRunning: () => true,
    now: () => time, tracker, platform: 'darwin', runner,
    setIntervalFn(fn, ms) { assert.equal(ms, 5000); callback = fn; ticks++; return { unref() {} }; },
    clearIntervalFn() { clears++; }, ...extra });
  return { telemetry, runner, calls, sessions, advance: ms => { time += ms; }, tick: () => callback(),
    counters: () => ({ stopped, clears, ticks }) };
}

test('snapshot exposes timestamps, swap activity, session union and peaks without session objects', async () => {
  const h = harness();
  h.telemetry.tracker.begin(h.sessions.get('task'));
  await h.telemetry.poll();
  let s = h.telemetry.snapshot();
  assert.equal(s.host.pressure, 'normal');
  assert.equal(s.host.fresh, true);
  assert.equal(s.processes.unionRssBytes, 300 * 1024);
  assert.equal(s.processes.rows[0].peakRssBytes, 300 * 1024);
  assert.equal(s.host.swapDelta.outBytes, null);
  assert.equal(s.processes.rows[0].session, undefined);
  assert.deepEqual(h.calls.at(-1), ['/bin/ps', MEMORY_PS_ARGS]);
  s.processes.rows[0].peakRssBytes = 999;
  assert.equal(h.telemetry.snapshot().processes.rows[0].peakRssBytes, 300 * 1024);
  h.advance(5000);
  await h.telemetry.poll();
  s = h.telemetry.snapshot();
  assert.equal(s.host.swapDelta.outBytes, 0);
  assert.equal(s.lastSuccessAt, 6000);
  h.telemetry.stop();
});
test('stale, backward-clock and stopped readings never expose current capacity', async () => {
  const h = harness();
  assert.equal(h.telemetry.snapshot().host.pressure, 'unknown');
  await h.telemetry.poll();
  h.advance(15001);
  let s = h.telemetry.snapshot();
  assert.equal(s.host.pressure, 'unknown');
  assert.equal(s.host.physicalBytes, null);
  assert.equal(s.processes.unionRssBytes, null);
  assert.equal(s.processes.rows[0].peakMinusCurrentBytes, null);
  h.advance(-20000);
  assert.equal(h.telemetry.snapshot().host.fresh, false);
  h.telemetry.stop();
  assert.equal(h.telemetry.snapshot().host.status, 'stopped');
});
test('poll is single-flight and start/stop are idempotent', async () => {
  let release;
  const h = harness();
  h.runner.run = () => new Promise(resolve => { release = resolve; });
  h.runner.stop = () => release(null);
  h.telemetry.start();
  h.telemetry.start();
  const a = h.telemetry.poll(), b = h.tick();
  assert.equal(a, b);
  h.telemetry.stop();
  h.telemetry.stop();
  await a;
  assert.equal(h.counters().ticks, 1);
  assert.equal(h.counters().clears, 1);
  assert.equal(h.telemetry.snapshot().inFlight, false);
  assert.equal(h.telemetry.snapshot().host.pressure, 'unknown');
  await h.telemetry.poll();
});
test('failures invalidate old host values and reset swap baseline while ps can still succeed', async () => {
  const h = harness();
  await h.telemetry.poll();
  const original = h.runner.run;
  h.runner.run = async file => file.endsWith('sysctl') ? null : ps;
  h.advance(5000);
  await h.telemetry.poll();
  assert.equal(h.telemetry.snapshot().host.pressure, 'unknown');
  assert.equal(h.telemetry.snapshot().host.swapDelta.outBytes, null);
  assert.equal(h.telemetry.snapshot().processes.unionRssBytes, 300 * 1024);
  h.runner.run = original;
  h.advance(5000);
  await h.telemetry.poll();
  assert.equal(h.telemetry.snapshot().host.swapDelta.status, 'baseline');
  h.runner.run = async () => { throw Error('exec failed'); };
  await h.telemetry.poll();
  assert.equal(h.telemetry.snapshot().processes.unionRssBytes, null);
  h.telemetry.stop();
});
test('unsupported platform reports unknown instead of zero and does not execute host commands', async () => {
  const h = harness({ platform: 'win32' });
  await h.telemetry.poll();
  assert.equal(h.calls.length, 0);
  assert.equal(h.telemetry.snapshot().host.status, 'unsupported');
  assert.equal(h.telemetry.snapshot().processes.unionRssBytes, null);
  h.telemetry.stop();
});
test('PID replacement during ps invalidates attribution', async () => {
  const h = harness();
  const original = h.runner.run;
  h.runner.run = async (file, args) => {
    if (file.endsWith('/ps')) h.sessions.get('task').ptyPid = 11;
    return original(file, args);
  };
  await h.telemetry.poll();
  assert.equal(h.telemetry.snapshot().processes.unionRssBytes, null);
  h.telemetry.stop();
});
test('unexpected collection failure invalidates lifetime coverage and remains recoverable', async () => {
  const h = harness();
  const s = h.sessions.get('task');
  h.telemetry.tracker.begin(s);
  await h.telemetry.poll();
  // Inject a registry iterator failure after host collection, outside the command runner.
  const original = h.sessions[Symbol.iterator];
  h.sessions[Symbol.iterator] = () => { throw Error('registry failed'); };
  await h.telemetry.poll();
  assert.equal(h.telemetry.snapshot().host.pressure, 'unknown');
  h.sessions[Symbol.iterator] = original;
  await h.telemetry.poll();
  assert.equal(h.telemetry.snapshot().host.pressure, 'normal');
  h.telemetry.tracker.end(s, 'completed');
  assert.equal(h.telemetry.snapshot().history[0].completeLifetime, false);
  h.telemetry.stop();
});
test('malformed, empty or command-bearing ps output is rejected', () => {
  assert.equal(parseMemoryProcesses(''), null);
  assert.equal(parseMemoryProcesses(null), null);
  assert.equal(parseMemoryProcesses('10 10 1 -5 S'), null);
  assert.equal(parseMemoryProcesses('10 10 1 5 S /secret/argv'), null);
  assert.equal(parseMemoryProcesses('10 10 1 5 S\ntruncated'), null);
  assert.equal(parseMemoryProcesses('10 10 1 0 S').rssOf.get(10), 0);
});
for (const signal of ['SIGTERM', 'SIGINT', 'disconnect']) test(`${signal} cancels telemetry before reaper exits`, async () => {
  const h = harness();
  h.telemetry.start();
  await h.telemetry.poll();
  const proc = new EventEmitter();
  const order = [];
  installShutdownReaper({ sessions: new Map(), proc, recordExit() {},
    claude: { killAllPrewarms() { order.push('reap'); return []; } },
    headless: { killAllHeadlessProcs: () => [] },
    beforeShutdown() { h.telemetry.stop(); order.push('stop'); },
    exit() { assert.equal(h.telemetry.snapshot().stopped, true); order.push('exit'); } });
  proc.emit(signal);
  proc.emit(signal);
  assert.deepEqual(order, ['stop', 'reap', 'exit']);
  assert.deepEqual(h.counters(), { stopped: 1, clears: 1, ticks: 1 });
});
