'use strict';

// Opt-in observation only. No workload launch, admission edits, signaling or timers.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { GiB, MiB } = require('./admission-policy');

const MAX_BYTES = 64 * MiB;
const LIMITS = Object.freeze({ stageMs: 30 * 60000, staleMs: 15000, swapCloseBytes: 512 * MiB,
  swapReopenBytes: 64 * MiB, reserveBytes: 6 * GiB, burstBytes: GiB,
  unknownBytes: 4 * GiB, recoveryExtraBytes: 2 * GiB, uiMs: 1000, cpuBusyPercent: 95 });
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const fields = (object, keys) => Object.fromEntries(keys.map(k => [k, object?.[k] ?? null]));

function hardware() {
  return { platform: process.platform, arch: process.arch, totalMemBytes: os.totalmem(),
    cores: os.cpus().length, cpuModel: os.cpus()[0]?.model || 'unknown',
    hostId: createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16) };
}
function cpuCounters() {
  return os.cpus().reduce((out, c) => {
    out.idle += c.times.idle; out.total += Object.values(c.times).reduce((a, b) => a + b, 0); return out;
  }, { idle: 0, total: 0 });
}
function implementationFingerprint() {
  const hash = createHash('sha256');
  for (const name of ['session-validation', 'host-memory', 'memory-telemetry', 'session-memory',
    'session-queue', 'admission-policy', 'admission-coordinator', 'session-admission', 'process-group']) {
    hash.update(name); hash.update(fs.readFileSync(path.join(__dirname, `${name}.js`)));
  }
  return hash.digest('hex');
}

function createSessionValidationRecorder({ env = process.env, now = Date.now, cpu = cpuCounters,
  hw = hardware, log = console.warn } = {}) {
  const noop = { sample() {}, lifecycle() {}, watchdog() {}, stop() {}, status: () => ({ enabled: false }) };
  const prefix = env.TIPATASK_SESSION_PROBE;
  if (!prefix) return noop;
  let fd, bytes = 0, closed = false, previousCpu, lastAt = null, fingerprint;
  const startedAt = now();
  const seconds = Number(env.TIPATASK_SESSION_PROBE_SECONDS || 3600);
  const file = `${prefix}.${process.pid}.ndjson`;
  try {
    if (!path.isAbsolute(prefix) || !Number.isInteger(seconds) || seconds < 30 || seconds > 7200) throw Error('invalid probe path or duration');
    // Existing files and symlinks are never followed or overwritten.
    fd = fs.openSync(file, 'wx', 0o600);
    previousCpu = cpu();
    fingerprint = implementationFingerprint();
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    log(`[session-probe] disabled: ${err.code || err.message}`); return noop;
  }
  function write(record) {
    if (closed) return;
    try {
      const line = JSON.stringify({ at: now(), ...record }) + '\n';
      if (bytes + Buffer.byteLength(line) > MAX_BYTES) { stop('size-limit'); return; }
      fs.writeSync(fd, line); bytes += Buffer.byteLength(line);
    } catch { closed = true; try { fs.closeSync(fd); } catch { /* already closed */ }
      log('[session-probe] recording failed; evidence is incomplete'); }
  }
  function stop(reason = 'shutdown') {
    if (closed) return;
    // A small reserved footer bypasses the sample bound, even at the size limit.
    try { fs.writeSync(fd, JSON.stringify({ type: 'stop', at: now(), reason, bytes }) + '\n'); }
    catch { /* missing footer invalidates the report */ }
    closed = true; try { fs.closeSync(fd); } catch { /* best effort */ }
  }
  function active() {
    if (!closed && now() - startedAt >= seconds * 1000) stop('deadline');
    return !closed;
  }
  write({ type: 'header', version: 1, kind: 'live-observation', startedAt, seconds, serverPid: process.pid,
    implementation: fingerprint, nodeVersion: process.version,
    hardware: hw(), limits: LIMITS, ownership: 'Only recorder file; sampler commands belong to the existing telemetry runner. No workloads owned or signaled.' });
  return {
    lifecycle(event) { if (active()) write({ ...event, type: `run-${event.type}` }); },
    watchdog(event) { if (active()) write({ type: 'watchdog', ...fields(event,
      ['pid', 'count', 'rssMb', 'reason', 'paused', 'killed', 'action', 'threshold', 'limitMb']) }); },
    sample(snapshot, admission, sessions = new Map()) {
      if (!active()) return;
      const at = now(), currentCpu = cpu();
      const total = currentCpu.total - previousCpu.total, idle = currentCpu.idle - previousCpu.idle;
      const cpuBusyPercent = total > 0 && idle >= 0 && idle <= total ? 100 * (1 - idle / total) : null;
      previousCpu = currentCpu;
      const intervalMs = lastAt === null ? null : at - lastAt; lastAt = at;
      const queue = [...sessions.values()].filter(s => s._queued).map(s => ({
        waitingMs: number(at - s.queuedAt), provider: ['codex', 'claude', 'pi', 'gemini'].includes(s.taskAgent) ? s.taskAgent : 'unknown' }));
      write({ type: 'sample', host: snapshot.host, processes: snapshot.processes,
        cpuBusyPercent, loadAverage: os.loadavg(), intervalMs, queue,
        admission: fields(admission, ['mode', 'cap', 'running', 'reason', 'coordinationReason', 'coordinated',
          'instances', 'censusPidCount', 'unregisteredCount', 'reservedBytes', 'requiredBytes', 'alarm', 'swapBytes']),
        policy: fields(admission?.policy, ['mode', 'ceiling', 'fallbackCap', 'reserveMiB', 'reserveFraction', 'burstMiB',
          'ordinaryMiB', 'unknownMiB', 'recoveryMs', 'recoveryExtraMiB', 'swapCloseMiB', 'swapReopenMiB', 'startIntervalMs']) });
      if (snapshot.host.pressure !== 'normal') log('[session-probe] STOP stage launches: host pressure is not normal; inspect before continuing');
    },
    stop, status: () => ({ enabled: true, closed, file, bytes }),
  };
}

function distribution(values) {
  const sorted = values.filter(v => number(v) !== null).sort((a, b) => a - b);
  return { n: sorted.length, min: sorted[0] ?? null, median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    max: sorted.at(-1) ?? null, values: sorted, p95: null,
    note: 'Descriptive samples only; no calibrated p95 claim, including at the estimator minimum of twenty runs.' };
}

function analyzeSessionValidation(records, { stage = 6, evidence = {}, ui = [], previous = null } = {}) {
  if (![6, 8, 12].includes(stage)) throw Error('stage must be 6, 8 or 12');
  const header = records.find(r => r.type === 'header');
  const samples = records.filter(r => r.type === 'sample');
  const ends = new Map(records.filter(r => r.type === 'run-end').map(r => [r.id, r]));
  const starts = records.filter(r => r.type === 'run-start');
  const complete = [...ends.values()].filter(r => r.completeLifetime && r.reason === 'completed'
    && r.startedAt >= header?.startedAt && r.workload === 'terminal');
  const problems = new Set();
  const fail = reason => problems.add(reason);
  if (header?.version !== 1 || header.kind !== 'live-observation') fail('missing-live-header');
  if (records.filter(r => r.type === 'header').length !== 1) fail('multiple-or-missing-captures');
  if (header?.hardware?.platform !== 'darwin' || !/Apple M5 Pro/i.test(header?.hardware?.cpuModel || '') || header?.hardware?.totalMemBytes !== 48 * GiB
    || header?.hardware?.cores !== 18) fail('hardware-outside-studied-envelope');
  if (!records.some(r => r.type === 'stop' && ['shutdown', 'deadline'].includes(r.reason))) fail('missing-clean-recorder-stop');
  if (!samples.length) fail('no-samples');
  const endedAt = records.at(-1)?.at ?? null;
  const durationMs = samples.length > 1 ? samples.at(-1).at - samples[0].at : 0;
  let fullConcurrencyMs = 0, maxConcurrency = 0, maxSwapMinuteBytes = 0, cpuHighMs = 0;
  const swap = [], margins = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], host = s.host || {}, proc = s.processes || {};
    const delta = i ? s.at - samples[i - 1].at : 0;
    if (i && (delta <= 0 || delta > LIMITS.staleMs)) fail('sample-gaps');
    if (!host.fresh || host.status !== 'ok' || !proc.fresh || proc.status !== 'ok' || proc.truncated) fail('unknown-or-stale-metrics');
    if (host.pressure !== 'normal') fail('host-pressure');
    if (!['static', 'pressure'].includes(s.admission?.mode) || number(s.admission?.cap) === null
      || number(s.admission?.reservedBytes) === null) fail('admission-diagnostics-unavailable');
    const count = proc.admissionSlots;
    maxConcurrency = Math.max(maxConcurrency, number(count) ?? 0);
    if (i && count >= stage && samples[i - 1].processes?.admissionSlots >= stage && delta <= LIMITS.staleMs) fullConcurrencyMs += delta;
    if (count > stage) fail('stage-ceiling-exceeded');
    const gap = (proc.rows || []).reduce((n, r) => n + (number(r.peakMinusCurrentBytes) ?? LIMITS.unknownBytes), 0);
    // Conservative stage gate for another unknown launch, including recovery margin.
    const needed = Math.max(LIMITS.reserveBytes, (host.physicalBytes || 0) * .125) + LIMITS.burstBytes
      + gap + (number(s.admission?.reservedBytes) ?? LIMITS.unknownBytes) + LIMITS.unknownBytes + LIMITS.recoveryExtraBytes;
    if (number(host.reclaimableEstimateBytes) === null) fail('unknown-headroom');
    else { margins.push(host.reclaimableEstimateBytes - needed); if (host.reclaimableEstimateBytes < needed) fail('headroom'); }
    if (number(host.swapOutBytes) === null) { fail('unknown-swap'); swap.length = 0; }
    else {
      if (swap.length && (host.swapOutBytes < swap.at(-1).bytes || host.pageSizeBytes !== swap.at(-1).page)) { fail('swap-counter-reset'); swap.length = 0; }
      swap.push({ at: s.at, bytes: host.swapOutBytes, page: host.pageSizeBytes });
      while (swap.length > 2 && swap[1].at <= s.at - 60000) swap.shift();
      const growth = host.swapOutBytes - swap[0].bytes;
      maxSwapMinuteBytes = Math.max(maxSwapMinuteBytes, growth);
      if (growth >= LIMITS.swapCloseBytes) fail('swap-close-threshold');
      if (s.at - swap[0].at >= 60000 && growth >= LIMITS.swapReopenBytes) fail('swap-not-quiet');
    }
    if (number(s.cpuBusyPercent) === null && i) fail('unknown-cpu');
    cpuHighMs = s.cpuBusyPercent >= LIMITS.cpuBusyPercent ? cpuHighMs + delta : 0;
    if (cpuHighMs >= 30000) fail('sustained-cpu-contention');
    if (stage > 6 && (s.admission?.mode !== 'pressure' || !s.admission?.coordinated)) fail('pressure-coordination-unverified');
    if (s.admission?.instances > 1) fail('independent-instance-live-evidence-requires-joint-review');
  }
  if (durationMs < LIMITS.stageMs || fullConcurrencyMs < LIMITS.stageMs) fail('insufficient-time-at-target');
  if (complete.length < stage) fail('insufficient-complete-lifetimes');
  if (complete.some(r => !starts.some(s => s.id === r.id && s.observedStart === true
    && number(s.queueMs) !== null && number(s.startupMs) !== null))) fail('queue-or-start-boundaries-unverified');
  const providers = [...new Set(complete.map(r => r.provider))].filter(p => p !== 'unknown');
  if (providers.length < 2) fail('mixed-providers-unverified');
  const actions = records.filter(r => r.type === 'watchdog');
  if (actions.some(r => r.paused || r.killed)) fail('watchdog-intervention-needs-review');
  const uiSamples = ui.filter(r => r.at >= samples[0]?.at && r.at <= samples.at(-1)?.at
    && ['card-click', 'edit-modal-open', 'load-and-render', 'tag-filter-toggle', 'sprint-collapse'].includes(r.label)
    && number(r.ms) !== null);
  if (uiSamples.length < 20) fail('insufficient-renderer-ui-samples');
  if (uiSamples.some(r => r.ms > LIMITS.uiMs)) fail('ui-latency');
  // Phases are operator evidence, linked to real run IDs, never inferred from RSS.
  const phases = (Array.isArray(evidence.runs) ? evidence.runs : []).flatMap(run => {
    const measured = complete.find(r => r.id === run.id);
    return measured && Array.isArray(run.phases) ? run.phases.filter(p => number(p.startAt) !== null && number(p.endAt) !== null
      && p.endAt > p.startAt && p.startAt >= measured.startedAt && p.endAt <= measured.endedAt).map(p => ({ ...p, id: run.id })) : [];
  });
  for (const kind of ['model-wait', 'editing', 'startup-mcp', 'build', 'test']) {
    if (!phases.some(p => p.kind === kind)) fail(`missing-workload-${kind}`);
  }
  const heavy = phases.filter(p => ['build', 'test'].includes(p.kind));
  const heavyOverlap = heavy.reduce((max, p) => Math.max(max, new Set(heavy.filter(q => q.startAt <= p.startAt && q.endAt > p.startAt).map(q => q.id)).size), 0);
  if (heavyOverlap < 2) fail('concurrent-heavy-workloads-unverified');
  if (!Array.isArray(evidence.otherApplications) || !evidence.otherApplications.length) fail('background-app-mix-unrecorded');
  if (evidence.resourceAuthorization !== true || number(evidence.billingLimitUsd) === null) fail('resource-and-billing-authorization-unrecorded');
  if (evidence.workloadCleanupVerified !== true) fail('workload-cleanup-unverified');
  if (stage > 6) {
    const expected = stage === 8 ? 6 : 8;
    if (!previous?.advanceAllowed || previous.stage !== expected || previous.hardware?.hostId !== header?.hardware?.hostId
      || !header?.implementation || previous.implementation !== header.implementation
      || previous.endedAt > header?.startedAt || header?.startedAt - previous.endedAt > 24 * 3600000) fail('previous-stage-not-qualified');
  }
  return { version: 1, kind: 'live-stage-report', stage, hardware: header?.hardware ?? null,
    implementation: header?.implementation ?? null,
    startedAt: header?.startedAt ?? null, endedAt, durationMs, sampleCount: samples.length,
    fullConcurrencyMs, maxConcurrency, completeRuns: complete.length, partialRuns: ends.size - complete.length,
    providers, maxConcurrentHeavyWorkloads: heavyOverlap, minHeadroomMarginBytes: margins.length ? Math.min(...margins) : null,
    maxSwapMinuteBytes, uniquePidRssBytes: distribution(samples.map(s => s.processes?.unionRssBytes)),
    compressorBytes: distribution(samples.map(s => s.host?.compressorBytes)),
    compressedLogicalBytes: distribution(samples.map(s => s.host?.compressedLogicalBytes)),
    uniquePidCount: distribution(samples.map(s => s.processes?.pidCount)),
    swapOutBytesPerSecond: distribution(samples.map(s => s.host?.swapDelta?.status === 'ok'
      && s.host.swapDelta.intervalMs > 0 ? s.host.swapDelta.outBytes * 1000 / s.host.swapDelta.intervalMs : null)),
    cpuBusyPercent: distribution(samples.map(s => s.cpuBusyPercent)),
    lifetimePeakBytes: distribution(complete.map(r => r.peakRssBytes)),
    lifetimesByProvider: Object.fromEntries(providers.map(provider => [provider, {
      peakBytes: distribution(complete.filter(r => r.provider === provider).map(r => r.peakRssBytes)),
      durationMs: distribution(complete.filter(r => r.provider === provider).map(r => r.endedAt - r.startedAt)),
    }])),
    queueMs: distribution(starts.map(r => r.queueMs)), startupMs: distribution(starts.map(r => r.startupMs)),
    uiMs: distribution(uiSamples.map(r => r.ms)), watchdog: { warnings: actions.length, interventions: actions.filter(r => r.paused || r.killed).length },
    problems: [...problems], advanceAllowed: problems.size === 0,
    rollout: 'NO-GO for automatic default rollout. Stage gates support further review only.',
    limitations: ['Sampled RSS is not physical ownership or an exact between-poll peak.',
      'Per-server PID unions must not be added across independent instances.',
      'Workload phases and external workload cleanup are operator evidence; recorder owns no workloads.',
      'UI spans measure instrumented interactions, not all frame stalls. No representative p95 claim.'] };
}

module.exports = { LIMITS, MAX_BYTES, hardware, distribution, createSessionValidationRecorder, analyzeSessionValidation };
