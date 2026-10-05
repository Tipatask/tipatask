'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GiB } = require('./admission-policy');
const { createSessionValidationRecorder, analyzeSessionValidation } = require('./session-validation');
const { createSessionMemoryTracker } = require('./session-memory');

function fixture(stage = 6) {
  const records = [{ type: 'header', version: 1, kind: 'live-observation', implementation: 'fixture', at: 1000, startedAt: 1000,
    hardware: { platform: 'darwin', cpuModel: 'Apple M5 Pro', totalMemBytes: 48 * GiB, cores: 18, hostId: 'test' } }];
  for (let at = 1000; at <= 1801000; at += 5000) records.push({ type: 'sample', at,
    host: { status: 'ok', fresh: true, pressure: 'normal', physicalBytes: 48 * GiB,
      reclaimableEstimateBytes: 30 * GiB, swapOutBytes: 0, pageSizeBytes: 16384, compressorBytes: GiB },
    processes: { status: 'ok', fresh: true, admissionSlots: stage, unionRssBytes: stage * GiB, rows: [] },
    admission: { mode: 'pressure', cap: stage, coordinated: true, reservedBytes: 0 }, cpuBusyPercent: 30 });
  const evidence = { otherApplications: ['editor', 'browser'], resourceAuthorization: true,
    billingLimitUsd: 10, workloadCleanupVerified: true, runs: [] };
  for (let n = 0; n < stage; n++) {
    const id = `run-${n}`;
    records.push({ type: 'run-start', at: 1000, id, startedAt: 1000, observedStart: true, queueMs: n * 10000, startupMs: 500 });
    records.push({ type: 'run-end', at: 1801001, id, completeLifetime: true, reason: 'completed',
      startedAt: 1000, endedAt: 1801001, workload: 'terminal', provider: n % 2 ? 'claude' : 'codex', peakRssBytes: GiB });
    evidence.runs.push({ id, phases: ['startup-mcp', 'model-wait', 'editing', 'build', 'test'].map((kind, i) =>
      ({ kind, startAt: 1000 + i * 10000, endAt: 1000 + (i + 1) * 10000 })) });
  }
  records.push({ type: 'stop', at: 1802000, reason: 'shutdown' });
  const ui = Array.from({ length: 20 }, (_, n) => ({ at: 2000 + n * 50000, label: 'card-click', ms: 50 }));
  const previous = stage > 6 ? { advanceAllowed: true, implementation: 'fixture', stage: stage === 8 ? 6 : 8,
    hardware: { hostId: 'test' }, endedAt: 999 } : null;
  return { records, options: { stage, evidence, ui, previous } };
}
for (const stage of [6, 8, 12]) test(`stage ${stage} needs full live coverage, never declares rollout or calibrated p95`, () => {
  const f = fixture(stage), result = analyzeSessionValidation(f.records, f.options);
  assert.deepEqual(result.problems, []);
  assert.equal(result.advanceAllowed, true);
  assert.equal(result.fullConcurrencyMs, 1800000);
  assert.equal(result.completeRuns, stage);
  assert.equal(result.lifetimePeakBytes.p95, null);
  assert.match(result.rollout, /NO-GO/);
});

test('short/idle traces and missing renderer/workload evidence never qualify', () => {
  const f = fixture(); f.records = f.records.filter(r => r.type !== 'sample' || r.at < 20000);
  const r = analyzeSessionValidation(f.records);
  for (const reason of ['insufficient-time-at-target', 'insufficient-renderer-ui-samples',
    'missing-workload-build', 'workload-cleanup-unverified']) assert.ok(r.problems.includes(reason));
});

test('pressure, swap, stale gaps, CPU, UI and watchdog interventions block advancement', () => {
  for (const mutate of [
    f => { f.records[2].host.pressure = 'warning'; },
    f => { f.records[2].host.swapOutBytes = 1024 ** 3; },
    f => { f.records[2].processes.fresh = false; },
    f => { f.records[2].at += 20000; },
    f => { for (const r of f.records) if (r.type === 'sample') r.cpuBusyPercent = 99; },
    f => { f.options.ui[0].ms = 2000; },
    f => { f.records.push({ type: 'watchdog', paused: true }); },
  ]) { const f = fixture(); mutate(f); assert.equal(analyzeSessionValidation(f.records, f.options).advanceAllowed, false); }
});

test('stage chain rejects wrong hardware, expired evidence and skipped baseline', () => {
  for (const previous of [null, { advanceAllowed: false }, { advanceAllowed: true, stage: 6 },
    { advanceAllowed: true, stage: 8, hardware: { hostId: 'other' }, endedAt: 0 },
    { advanceAllowed: true, stage: 8, hardware: { hostId: 'test' }, endedAt: -1e9 }]) {
    const f = fixture(12); f.options.previous = previous;
    assert.ok(analyzeSessionValidation(f.records, f.options).problems.includes('previous-stage-not-qualified'));
  }
});

test('complete records must belong to capture and operator phases must link to measured lifetimes', () => {
  const f = fixture();
  for (const r of f.records) if (r.type === 'run-end') r.completeLifetime = false;
  const result = analyzeSessionValidation(f.records, f.options);
  assert.equal(result.completeRuns, 0);
  assert.equal(result.partialRuns, 6);
  assert.ok(result.problems.includes('concurrent-heavy-workloads-unverified'));
});

test('recorder is opt-in, exclusive, private, bounded by deadline and strips session text', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-validation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(createSessionValidationRecorder({ env: {} }).status().enabled, false);
  let time = 1000, count = 0;
  const env = { TIPATASK_SESSION_PROBE: path.join(dir, 'capture'), TIPATASK_SESSION_PROBE_SECONDS: '30' };
  const recorder = createSessionValidationRecorder({ env, now: () => time,
    cpu: () => ({ idle: ++count, total: count * 2 }), log() {} });
  const collision = createSessionValidationRecorder({ env, log() {} });
  assert.equal(collision.status().enabled, false);
  recorder.sample({ host: { pressure: 'normal' }, processes: {} }, { secret: 'never-record' },
    new Map([['secret-task', { _queued: true, queuedAt: 0, taskAgent: 'secret-provider', description: 'never-record' }]]));
  recorder.watchdog({ paused: true, promptText: 'never-record' });
  time = 31000; recorder.sample({}, {});
  assert.equal(recorder.status().closed, true);
  const text = fs.readFileSync(recorder.status().file, 'utf8');
  assert.doesNotMatch(text, /never-record|secret-task|secret-provider/);
  assert.match(text, /deadline/);
  assert.equal(fs.statSync(recorder.status().file).mode & 0o777, 0o600);
  recorder.stop();
  assert.equal(fs.readFileSync(recorder.status().file, 'utf8'), text);
});

test('lifecycle capture records short unsampled runs as partial and preserves queue/startup timing', () => {
  const events = []; let time = 100;
  const tracker = createSessionMemoryTracker({ now: () => time, onLifecycle: e => events.push(e) });
  const session = { type: 'terminal', taskAgent: 'codex', ptyPid: 10, queuedAt: 10, _admittedAt: 60 };
  tracker.begin(session); time = 150; tracker.end(session, 'completed');
  assert.equal(events[0].queueMs, 50); assert.equal(events[0].startupMs, 40);
  assert.equal(events[1].completeLifetime, false);
  assert.equal(events[1].sampleCount, 0);
  const broken = createSessionMemoryTracker({ onLifecycle() { throw Error('sink failure'); } });
  assert.doesNotThrow(() => { broken.begin(session); broken.end(session, 'completed'); });
});
