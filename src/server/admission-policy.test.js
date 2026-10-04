'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GiB, MiB, resolveAdmissionPolicy, estimatePeak, initialPressureState, decideAdmission } = require('./admission-policy');
const hw = { totalMemBytes: 48 * GiB, cores: 18 };
const policy = (config = {}, env = {}, hardware = hw) => resolveAdmissionPolicy({ env, hardware, platform: 'darwin',
  read: () => ({ config, status: 'ok', file: '/scratch/admission.json' }) });
const pressure = (config = {}) => policy({ AGENT_ADMISSION_MODE: 'pressure', ...config });
function telemetry(at, changes = {}) {
  return { processes: { fresh: true, status: 'ok', sampledAt: at }, host: { status: 'ok', fresh: true, sampledAt: at, pressure: 'normal', physicalBytes: 48 * GiB,
    reclaimableEstimateBytes: 30 * GiB, swapOutBytes: 0, pageSizeBytes: 16384, ...changes } };
}
function harness(p = pressure()) {
  const state = initialPressureState();
  const run = (at, changes = {}, extra = {}) => decideAdmission({ policy: p, state, now: at,
    telemetry: telemetry(at, changes), running: 0, estimateBytes: 4 * GiB, ...extra });
  const warm = () => { for (let at = 0; at <= 60000; at += 5000) run(at); };
  return { state, run, warm };
}

test('static defaults stay hardware derived; pressure opt-in stages only studied machine at eight', () => {
  assert.equal(policy().mode, 'static'); assert.equal(policy().ceiling, 6);
  assert.equal(pressure().ceiling, 8);
  assert.equal(pressure({ AGENT_ADMISSION_CEILING: 12 }).ceiling, 12);
  assert.equal(pressure({ AGENT_ADMISSION_CEILING: 32 }).ceiling, 16);
  assert.equal(policy({ AGENT_ADMISSION_MODE: 'pressure' }, {}, { totalMemBytes: 32 * GiB, cores: 10 }).ceiling, 4);
  assert.equal(pressure({ AGENT_ADMISSION_FALLBACK_CAP: 32 }).fallbackCap, 6);
  assert.equal(pressure({ AGENT_ADMISSION_FALLBACK_CAP: 2 }).fallbackCap, 2);
});

test('env wins per field; invalid controls fall through with sources and never weaken pilot floors', () => {
  const p = policy({ AGENT_ADMISSION_MODE: 'pressure', AGENT_ADMISSION_CEILING: 12, AGENT_ADMISSION_RESERVE_MIB: 8192 },
    { AGENT_ADMISSION_MODE: 'garbage', AGENT_ADMISSION_CEILING: '8', AGENT_ADMISSION_RESERVE_MIB: '1',
      AGENT_ADMISSION_START_INTERVAL_MS: '1', AGENT_ADMISSION_STALE_MS: '60000' });
  assert.equal(p.mode, 'pressure'); assert.equal(p.ceiling, 8); assert.equal(p.reserveMiB, 8192);
  assert.equal(p.startIntervalMs, 10000); assert.equal(p.staleMs, 15000);
  assert.equal(p.sources.mode, 'device-config'); assert.equal(p.sources.ceiling, 'env');
  assert.equal(p.rejected.length, 4);
});

test('unknown/build-heavy floors and comparable complete lifetime p95 require twenty records', () => {
  const p = pressure();
  const session = { taskAgent: 'codex', admissionClass: 'ordinary' };
  const record = { provider: 'codex', workload: 'terminal', admissionClass: 'ordinary', completeLifetime: true,
    reason: 'completed', peakRssBytes: 3 * GiB };
  assert.equal(estimatePeak(p, session, Array(19).fill(record)).bytes, 2 * GiB);
  assert.equal(estimatePeak(p, session, Array(20).fill(record)).bytes, 3.75 * GiB);
  const short = Array(30).fill({ ...record, completeLifetime: false });
  assert.equal(estimatePeak(p, session, short).bytes, 2 * GiB);
  assert.equal(estimatePeak(p, { taskAgent: 'codex' }, Array(20).fill(record)).bytes, 4 * GiB);
  for (const changed of [{ provider: 'claude' }, { workload: 'objective' }, { admissionClass: undefined }, { reason: 'exited' }]) {
    assert.equal(estimatePeak(p, session, Array(20).fill({ ...record, ...changed })).histories, 0);
  }
  const outlier = [...Array(19).fill(record), { ...record, peakRssBytes: 40 * GiB }];
  assert.equal(estimatePeak(p, session, outlier).bytes, 3.75 * GiB);
});

test('fresh normal pressure needs a full swap window; allocated swap alone never blocks', () => {
  const h = harness();
  assert.equal(h.run(0, { swapOutBytes: 100 * GiB }).reason, 'swap-history');
  for (let at = 5000; at <= 60000; at += 5000) h.run(at, { swapOutBytes: 100 * GiB });
  assert.equal(h.run(60000, { swapOutBytes: 100 * GiB }).allowed, true);
});

test('project cap and device cap are independent; start spacing never admits a burst', () => {
  const h = harness(); h.warm();
  assert.equal(h.run(60000, {}, { projectBlocked: true }).reason, 'project-cap');
  assert.equal(h.run(60000, {}, { running: 8 }).reason, 'device-cap');
  h.state.lastStartAt = 60000;
  assert.equal(h.run(69999).reason, 'spacing');
  assert.equal(h.run(70000).allowed, true);
});

test('reserve, burst, peak gaps, pending reservations and estimated peak all consume projected headroom', () => {
  const h = harness(); h.warm();
  const result = h.run(60000, { reclaimableEstimateBytes: 14 * GiB }, { reservedBytes: 2 * GiB, peakGapBytes: 2 * GiB });
  assert.equal(result.requiredBytes, 15 * GiB);
  assert.equal(result.reason, 'headroom');
  assert.equal(h.state.alarm, 'headroom');
});

test('pressure alarm survives stale telemetry and reopens only after continuous recovery plus hysteresis', () => {
  const h = harness(); h.warm();
  assert.equal(h.run(65000, { pressure: 'warning' }).reason, 'pressure');
  assert.equal(h.run(85000, { fresh: false, pressure: 'unknown' }).reason, 'pressure');
  for (let at = 90000; at <= 150000; at += 5000) h.run(at, { reclaimableEstimateBytes: 12 * GiB });
  assert.equal(h.state.alarm, 'pressure'); // threshold 11 + hysteresis 2
  assert.equal(h.run(155000, { reclaimableEstimateBytes: 13 * GiB }).allowed, true);
  assert.equal(h.state.alarm, null);
});

test('swap burst closes even before a minute; reset cannot invent a quiet minute', () => {
  const h = harness();
  h.run(0);
  assert.equal(h.run(5000, { swapOutBytes: 512 * MiB }).reason, 'swap');
  assert.equal(h.run(10000, { swapOutBytes: 0 }).reason, 'swap');
  for (let at = 15000; at < 70000; at += 5000) assert.equal(h.run(at).allowed, false);
  assert.equal(h.run(70000).allowed, true);
});

test('swap recovery is strict below 64 MiB, pressure recovery is at least thirty seconds', () => {
  const h = harness(); h.warm();
  h.run(65000, { pressure: 'critical' });
  for (let at = 70000; at <= 90000; at += 5000) assert.equal(h.run(at).allowed, false);
  assert.equal(h.run(95000, { swapOutBytes: 64 * MiB }).allowed, false);
  for (let at = 100000; at <= 155000; at += 5000) h.run(at, { swapOutBytes: 64 * MiB });
  assert.equal(h.run(155000, { swapOutBytes: 64 * MiB }).allowed, true);
});

test('stale/unavailable/unsupported telemetry uses static fallback; legacy static ignores memory', () => {
  for (const status of ['unavailable', 'unsupported', 'stale']) {
    const h = harness();
    assert.equal(h.run(0, { fresh: false, status }, { running: 5 }).allowed, true);
    assert.equal(h.run(0, { fresh: false, status }, { running: 6 }).allowed, false);
  }
  const h = harness(policy());
  assert.equal(h.run(0, { pressure: 'critical', reclaimableEstimateBytes: 0 }, { running: 5 }).allowed, true);
  assert.equal(h.state.alarm, null);
});

test('live mode change never erases an alarm; no coordination means no dynamic expansion', () => {
  const h = harness(); h.warm(); h.run(65000, { pressure: 'critical' });
  assert.equal(h.run(65000, { fresh: false }, { policy: policy() }).allowed, false);
  const other = harness(); other.warm();
  assert.equal(other.run(60000, {}, { running: 6, coordinated: false }).allowed, false);
  assert.equal(other.run(60000, {}, { running: 5, coordinated: false }).allowed, true);
});

test('older peer samples cannot clear or backdate a newer pressure alarm', () => {
  const h = harness(); h.warm();
  h.run(65000, { pressure: 'critical' });
  assert.equal(h.run(65000, { sampledAt: 60000 }).allowed, false);
  assert.equal(h.state.normalSince, null);
});

test('freshness of host alone cannot enable expansion when process telemetry is unavailable', () => {
  const h = harness(); h.warm();
  for (const processes of [{ fresh: false }, { fresh: true, sampledAt: 60000, status: 'unknown' },
    { fresh: true, sampledAt: 60000, status: 'ok', truncated: true }]) {
    assert.equal(h.run(60000, {}, { telemetry: { ...telemetry(60000), processes }, running: 6 }).allowed, false);
  }
});

test('workload classification validates env precedence and preserves unknown/build-heavy floor', () => {
  const { resolveWorkload } = require('./admission-policy');
  const config = { AGENT_ADMISSION_WORKLOAD_CLASS: 'ordinary' };
  assert.equal(resolveWorkload(config, { AGENT_ADMISSION_WORKLOAD_CLASS: 'wrong' }).admissionClass, 'ordinary');
  assert.equal(resolveWorkload(config, { AGENT_ADMISSION_WORKLOAD_CLASS: 'build-heavy' }).admissionClass, 'unknown');
  assert.equal(resolveWorkload({}, {}).admissionClassSource, 'default');
});
