'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GiB, MiB, resolveAdmissionPolicy, estimatePeak, initialPressureState, decideAdmission } = require('./admission-policy');
const hw = { totalMemBytes: 48 * GiB, cores: 18 };
const policy = (config = {}, env = {}, hardware = hw) => resolveAdmissionPolicy({ env, hardware, platform: 'darwin',
  read: () => ({ config, status: 'ok', file: '/scratch/admission.json' }) });
const pressure = (config = {}) => policy({ AGENT_ADMISSION_MODE: 'pressure', ...config });
const stat = (config = {}) => policy({ AGENT_ADMISSION_MODE: 'static', ...config });
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
  assert.equal(stat().mode, 'static'); assert.equal(stat().ceiling, 6);
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

test('pressure alarm survives stale telemetry or coordination doubt and reopens only after continuous recovery plus hysteresis', () => {
  const h = harness(); h.warm();
  assert.equal(h.run(65000, { pressure: 'warning' }).reason, 'pressure');
  assert.equal(h.run(85000, { fresh: false, pressure: 'unknown' }).reason, 'pressure');
  for (let at = 90000; at <= 150000; at += 5000) h.run(at, { reclaimableEstimateBytes: 12 * GiB });
  assert.equal(h.state.alarm, 'pressure'); // threshold 11 + hysteresis 2
  assert.equal(h.run(155000, { reclaimableEstimateBytes: 13 * GiB }).allowed, true);
  assert.equal(h.state.alarm, null);
  // Stale process telemetry and coordination doubt hold the recovery window closed for as long as
  // they last, also on polls already refused at the fallback device cap: host telemetry is quiet
  // from 70 s, yet the alarm clears a full RECOVERY_MS after the gap (185 s), not at 155 s.
  const staleProcesses = at => ({ telemetry: { ...telemetry(at), processes: { fresh: false } } });
  for (const gap of [staleProcesses, () => ({ coordinated: false })]) {
    for (const running of [0, 6]) {
      const g = harness(); g.warm();
      assert.equal(g.run(65000, { pressure: 'warning' }).reason, 'pressure');
      for (let at = 70000; at <= 150000; at += 5000) assert.equal(g.run(at, {}, { ...gap(at), running }).allowed, false);
      assert.deepEqual([g.state.alarm, g.state.normalSince], ['pressure', null]);
      for (let at = 155000; at < 185000; at += 5000) assert.equal(g.run(at).reason, 'pressure', `running ${running} at ${at}`);
      assert.equal(g.run(185000).allowed, true);
      assert.equal(g.state.alarm, null);
    }
  }
});

test('pressure headroom dip at the device cap restarts a latched alarm recovery window', () => {
  const h = harness(); h.warm();
  assert.equal(h.run(65000, { pressure: 'warning' }).reason, 'pressure');
  for (let at = 70000; at <= 85000; at += 5000) {
    assert.equal(h.run(at, {}, { running: 8 }).reason, 'device-cap');
  }
  assert.equal(h.state.normalSince, 70000); // recovery would otherwise finish at 100 s
  assert.equal(h.run(90000, { reclaimableEstimateBytes: 11 * GiB - 1 }, { running: 8 }).reason, 'device-cap');
  assert.deepEqual([h.state.alarm, h.state.normalSince], ['headroom', null]);
  for (let at = 95000; at <= 120000; at += 5000) {
    assert.equal(h.run(at, {}, { running: 8 }).reason, 'device-cap');
    assert.equal(h.state.alarm, 'headroom');
  }
  assert.equal(h.state.normalSince, 95000);
  assert.equal(h.run(124999, {}, { running: 7 }).reason, 'headroom');
  assert.equal(h.run(125000, {}, { running: 7 }).allowed, true);
  assert.equal(h.state.alarm, null);
});

test('pressure alarm recovers at the cap while cap reasons retain priority', () => {
  for (const [extra, reason] of [[{ running: 8 }, 'device-cap'], [{ running: 8, projectBlocked: true }, 'project-cap']]) {
    const h = harness(); h.warm();
    assert.equal(h.run(65000, { pressure: 'warning' }, extra).reason, reason);
    assert.equal(h.state.alarm, 'pressure');
    for (let at = 70000; at < 100000; at += 5000) {
      assert.equal(h.run(at, {}, extra).reason, reason);
      assert.equal(h.state.alarm, 'pressure');
    }
    const recovered = h.run(100000, {}, extra);
    assert.equal(recovered.allowed, false);
    assert.equal(recovered.reason, reason);
    assert.equal(recovered.cap, 8);
    assert.equal(h.state.alarm, null);
    assert.equal(h.run(100000, {}, { running: 7 }).allowed, true);
    assert.equal(h.run(105000, { reclaimableEstimateBytes: 11 * GiB - 1 }, extra).reason, reason);
    assert.deepEqual([h.state.alarm, h.state.normalSince], ['headroom', null]);
  }
});

test('static mode recovers an inherited alarm at its cap and then ignores memory', () => {
  const h = harness(); h.warm();
  h.run(65000, { pressure: 'warning' });
  for (let at = 70000; at < 100000; at += 5000) {
    assert.equal(h.run(at, {}, { policy: stat(), running: 6 }).reason, 'device-cap');
    assert.equal(h.state.alarm, 'pressure');
  }
  assert.equal(h.run(100000, {}, { policy: stat(), running: 6 }).reason, 'device-cap');
  assert.equal(h.state.alarm, null);
  assert.equal(h.run(105000, { pressure: 'critical', reclaimableEstimateBytes: 0 }, { policy: stat(), running: 6 }).reason, 'device-cap');
  assert.equal(h.state.alarm, null);
  assert.equal(h.run(105000, { pressure: 'critical', reclaimableEstimateBytes: 0 }, { policy: stat(), running: 5 }).allowed, true);
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
  const h = harness(stat());
  assert.equal(h.run(0, { pressure: 'critical', reclaimableEstimateBytes: 0 }, { running: 5 }).allowed, true);
  assert.equal(h.state.alarm, null);
});

test('live mode change never erases an alarm; no coordination means no dynamic expansion', () => {
  const h = harness(); h.warm(); h.run(65000, { pressure: 'critical' });
  assert.equal(h.run(65000, { fresh: false }, { policy: stat() }).allowed, false);
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

test('ramp is the default: ceiling two above static, bounded by CPUs and never below static, both keys fingerprinted', () => {
  const p = policy();
  assert.equal(p.mode, 'ramp'); assert.equal(p.rampStepMs, 300000); assert.equal(p.rampCeiling, 8); assert.equal(p.ceiling, 8);
  assert.equal(p.fallbackCap, 6);
  assert.equal(policy({}, {}, { totalMemBytes: 32 * GiB, cores: 10 }).rampCeiling, 6);
  assert.equal(policy({}, {}, { totalMemBytes: 256 * GiB, cores: 8 }).rampCeiling, 8);
  assert.equal(policy({}, { AGENT_ADMISSION_RAMP_CEILING: '32' }).rampCeiling, 16);
  assert.equal(policy({ AGENT_ADMISSION_RAMP_CEILING: 2 }).rampCeiling, 6);
  assert.equal(policy({ AGENT_ADMISSION_RAMP_CEILING: 7, AGENT_ADMISSION_RAMP_STEP_MS: 120000 }).fingerprint,
    policy({}, { AGENT_ADMISSION_RAMP_CEILING: '7', AGENT_ADMISSION_RAMP_STEP_MS: '120000' }).fingerprint);
  assert.notEqual(policy({ AGENT_ADMISSION_RAMP_STEP_MS: 120000 }).fingerprint, policy().fingerprint);
  const rejected = policy({ AGENT_ADMISSION_RAMP_STEP_MS: 1000 }, { AGENT_ADMISSION_RAMP_CEILING: '0', AGENT_ADMISSION_MODE: 'burst' });
  assert.equal(rejected.rampStepMs, 300000); assert.equal(rejected.rampCeiling, 8); assert.equal(rejected.mode, 'ramp');
  assert.deepEqual(rejected.rejected.map(r => r.key).sort(),
    ['AGENT_ADMISSION_MODE', 'AGENT_ADMISSION_RAMP_CEILING', 'AGENT_ADMISSION_RAMP_STEP_MS']);
  assert.equal(stat({ AGENT_ADMISSION_RAMP_CEILING: 12 }).ceiling, 6);
  assert.equal(pressure({ AGENT_ADMISSION_RAMP_CEILING: 12 }).ceiling, 8);
  for (const key of ['"rampStepMs":300000', '"rampCeiling":8', '"mode":"ramp"']) assert.ok(p.fingerprint.includes(key), key);
});

// Quiet sampling: host telemetry every five seconds from `from` up to and including `to`.
const quiet = (h, from, to, changes = {}) => { for (let at = from; at <= to; at += 5000) h.run(at, changes); };

test('ramp 6→7→8 needs two full quiet windows, stops at the ceiling and spaces starts above the floor', () => {
  const h = harness(policy()); h.warm();
  assert.equal(h.run(60000).mode, 'ramp');
  assert.equal(h.run(60000, {}, { running: 5 }).allowed, true);
  assert.equal(h.run(60000, {}, { running: 6 }).reason, 'device-cap');
  quiet(h, 65000, 295000);
  assert.equal(h.run(295000, {}, { running: 6 }).reason, 'device-cap'); // 295 s since normalSince=0
  const stepped = h.run(300000, {}, { running: 6 });
  assert.equal(stepped.allowed, true); assert.equal(stepped.cap, 7); assert.equal(stepped.rampCap, 7);
  assert.equal(h.state.rampCap, 7); assert.equal(h.state.normalSince, 300000);
  assert.equal(h.run(300000, {}, { running: 7 }).reason, 'device-cap');
  quiet(h, 305000, 595000);
  assert.equal(h.state.rampCap, 7);
  quiet(h, 600000, 600000);
  assert.equal(h.state.rampCap, 8);
  assert.equal(h.run(600000, {}, { running: 7 }).allowed, true);
  assert.equal(h.run(600000, {}, { running: 8 }).reason, 'device-cap');
  quiet(h, 605000, 1200000);
  assert.equal(h.state.rampCap, 8); assert.equal(h.run(1200000, {}, { running: 8 }).cap, 8);
  h.state.lastStartAt = 1200000;
  assert.equal(h.run(1205000, {}, { running: 7 }).reason, 'spacing');
  assert.equal(h.run(1205000, {}, { running: 5 }).allowed, true);
  assert.equal(h.run(1210000, {}, { running: 7 }).allowed, true);
});

test('ramp steps 6→7→8 with six unknown reservations and peak gaps, retaining the full device-cap budget', () => {
  const p = policy(), h = harness(p);
  const estimateBytes = estimatePeak(p, { taskAgent: 'codex' }).bytes;
  const extra = { running: 6, estimateBytes, reservedBytes: 6 * estimateBytes, peakGapBytes: 2 * GiB };
  const stages = [];
  for (let at = 0; at <= 2 * p.rampStepMs; at += 5000) {
    const result = h.run(at, { reclaimableEstimateBytes: 20 * GiB }, extra);
    assert.equal(h.state.alarm, null);
    assert.equal(result.requiredBytes, 37 * GiB);
    assert.equal(result.headroomBytes, 20 * GiB);
    if (stages.at(-1) !== result.cap) stages.push(result.cap);
    assert.equal(result.cap, at < p.rampStepMs ? 6 : at < 2 * p.rampStepMs ? 7 : 8);
    assert.equal(result.allowed, at >= p.rampStepMs);
  }
  assert.deepEqual(stages, [6, 7, 8]);
  // Once at the ceiling the full budget applies again.
  assert.equal(h.run(605000, { reclaimableEstimateBytes: 20 * GiB }, extra).reason, 'device-cap');
  assert.equal(h.state.alarm, 'headroom');
  assert.equal(h.state.rampCap, null);
});

test('ramp latches when the next session plus recovery margin does not fit and clears after recoveryMs', () => {
  for (const headroomBytes of [11 * GiB - 1, 13 * GiB - 1]) {
    const p = policy(), h = harness(p); h.warm();
    const extra = { running: 6, reservedBytes: 24 * GiB };
    assert.equal(h.run(65000, { reclaimableEstimateBytes: headroomBytes }, extra).reason, 'device-cap');
    assert.deepEqual([h.state.alarm, h.state.rampCap, h.state.normalSince], ['headroom', null, null]);
    // Recovery uses the one-session threshold too: full required remains 35 GiB.
    const recoveredHeadroom = { reclaimableEstimateBytes: 13 * GiB };
    for (let at = 70000; at < 70000 + p.recoveryMs; at += 5000) {
      h.run(at, recoveredHeadroom, extra);
      assert.equal(h.state.alarm, 'headroom');
    }
    const recovered = h.run(70000 + p.recoveryMs, recoveredHeadroom, extra);
    assert.equal(recovered.reason, 'device-cap');
    assert.equal(recovered.requiredBytes, 35 * GiB);
    assert.equal(h.state.alarm, null);
    assert.equal(recovered.rampNextStepAt, 70000 + p.rampStepMs);
  }
});

test('ramp swap burst drops straight back to the static cap and re-earns a slot only after a fresh window', () => {
  const h = harness(policy()); h.warm(); quiet(h, 65000, 300000);
  assert.equal(h.state.rampCap, 7);
  assert.equal(h.run(305000, { swapOutBytes: 512 * MiB }, { running: 6 }).reason, 'device-cap');
  assert.equal(h.state.alarm, 'swap'); assert.equal(h.state.rampCap, null);
  assert.equal(h.run(305000, { swapOutBytes: 512 * MiB }, { running: 5 }).allowed, true);
  // Swap counter stays flat afterwards: the burst leaves the rolling minute at 365 s,
  // recovery then needs thirty quiet seconds, and the ramp a full step window.
  quiet(h, 310000, 400000, { swapOutBytes: 512 * MiB });
  assert.equal(h.state.alarm, null); assert.equal(h.state.rampCap, null);
  assert.equal(h.run(400000, { swapOutBytes: 512 * MiB }, { running: 6 }).reason, 'device-cap');
  quiet(h, 405000, 700000, { swapOutBytes: 512 * MiB });
  assert.equal(h.state.rampCap, 7);
});

test('ramp never raises on stale host or process telemetry or without coordination, drops an earned slot and re-earns it only after a fresh window', () => {
  const stale = harness(policy());
  for (let at = 0; at <= 600000; at += 5000) stale.run(at, { fresh: false, status: 'stale' });
  assert.equal(stale.state.rampCap, null); assert.equal(stale.run(600000, {}, { running: 6 }).reason, 'device-cap');
  const proc = harness(policy());
  for (let at = 0; at <= 600000; at += 5000) {
    proc.run(at, {}, { telemetry: { ...telemetry(at), processes: { fresh: false } } });
  }
  assert.equal(proc.state.rampCap, null);
  // Stale process telemetry holds the window closed, not just the step: once it is fresh
  // again (605 s) the window reopens there and the slot returns at 905 s, not at once.
  assert.equal(proc.state.normalSince, null);
  const procBack = proc.run(605000, {}, { running: 6 });
  assert.equal(procBack.reason, 'device-cap'); assert.equal(procBack.rampNextStepAt, 905000);
  quiet(proc, 610000, 900000);
  assert.equal(proc.state.rampCap, null);
  assert.equal(proc.run(905000, {}, { running: 6 }).cap, 7);
  const h = harness(policy()); h.warm(); quiet(h, 65000, 300000);
  assert.equal(h.state.rampCap, 7);
  assert.equal(h.run(305000, {}, { running: 6, coordinated: false }).reason, 'device-cap');
  assert.equal(h.state.rampCap, null); assert.equal(h.state.normalSince, null);
  assert.equal(h.run(310000, { fresh: false, status: 'unavailable' }, { running: 5 }).allowed, true);
  assert.equal(h.run(310000, { fresh: false, status: 'unavailable' }, { running: 6 }).reason, 'device-cap');
  // Coordination doubt alone (host telemetry fresh throughout) restarts the window the same
  // way: the step the old window would have landed at 600 s waits until 610 s.
  const d = harness(policy()); d.warm(); quiet(d, 65000, 300000);
  assert.equal(d.state.rampCap, 7); assert.equal(d.state.normalSince, 300000);
  d.run(305000, {}, { coordinated: false });
  assert.deepEqual([d.state.rampCap, d.state.normalSince], [null, null]);
  const back = d.run(310000, {}, { running: 6 });
  assert.equal(back.reason, 'device-cap'); assert.equal(back.rampNextStepAt, 610000);
  quiet(d, 315000, 605000);
  assert.equal(d.state.rampCap, null);
  assert.equal(d.run(610000, {}, { running: 6 }).cap, 7);
});

test('ramp floor ignores alarms like static', () => {
  const h = harness(policy()); h.warm(); quiet(h, 65000, 300000);
  assert.equal(h.run(305000, { pressure: 'critical' }, { running: 6 }).reason, 'device-cap');
  assert.equal(h.state.alarm, 'pressure'); assert.equal(h.state.rampCap, null);
  assert.equal(h.run(310000, { pressure: 'critical' }, { running: 5 }).allowed, true);
  assert.equal(h.state.alarm, 'pressure');
});

test('ramp decisions report the ceiling and the next step time; null when no step is pending or outside ramp', () => {
  const h = harness(policy()); h.warm();
  const first = h.run(60000, {}, { running: 6 });
  assert.equal(first.rampCeiling, 8); assert.equal(first.rampNextStepAt, 300000); // window opened at normalSince=0
  quiet(h, 65000, 300000);
  const stepped = h.run(300000, {}, { running: 7 });
  assert.equal(stepped.rampCap, 7); assert.equal(stepped.rampNextStepAt, 600000); // the step restarted the window
  quiet(h, 305000, 600000);
  const top = h.run(600000, {}, { running: 8 });
  assert.equal(top.rampCap, 8); assert.equal(top.rampCeiling, 8); assert.equal(top.rampNextStepAt, null); // at the ceiling
  const blocked = (changes = {}, extra = {}) => { const b = harness(policy()); b.warm(); return b.run(65000, changes, { running: 6, ...extra }); };
  assert.equal(blocked().rampNextStepAt, 300000);
  assert.equal(blocked({ fresh: false, status: 'stale' }).rampNextStepAt, null);
  assert.equal(blocked({}, { telemetry: { ...telemetry(65000), processes: { fresh: false } } }).rampNextStepAt, null);
  assert.equal(blocked({}, { coordinated: false }).rampNextStepAt, null);
  assert.equal(blocked({ pressure: 'warning' }).rampNextStepAt, null);
  // Headroom short of the one-session threshold latches an alarm, hiding the next step.
  const tight = harness(policy()); tight.warm();
  quiet(tight, 65000, 400000, { reclaimableEstimateBytes: 13 * GiB - 1 });
  assert.equal(tight.state.alarm, 'headroom');
  assert.equal(tight.run(400000, { reclaimableEstimateBytes: 13 * GiB - 1 }, { running: 6 }).rampNextStepAt, null);
  for (const p of [stat(), pressure()]) {
    const other = harness(p); other.warm();
    const decision = other.run(65000);
    assert.deepEqual([decision.rampCap, decision.rampCeiling, decision.rampNextStepAt], [null, null, null]);
  }
});
