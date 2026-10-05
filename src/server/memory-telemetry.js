'use strict';

const { parsePsOutput } = require('./process-group');
const { SAMPLE_INTERVAL_MS, STALE_AFTER_MS, createCommandRunner, readHostMemory, unknownHost, swapDelta } = require('./host-memory');
const { rootsOf, sessionDiagnostics, createSessionMemoryTracker } = require('./session-memory');

// Numeric process columns only: do not collect argv or executable paths.
const MEMORY_PS_ARGS = ['-Ao', 'pgid=,pid=,ppid=,rss=,stat='];
function parseMemoryProcesses(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const line of text.trim().split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5 || fields.slice(0, 4).some(v => !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)))
        || Number(fields[1]) < 1 || !/^[A-Za-z]/.test(fields[4])) return null;
  }
  return parsePsOutput(text);
}

function createMemoryTelemetry({ getSessions, isRunning, platform = process.platform, now = Date.now,
  onSample = null,
  runner = createCommandRunner(), tracker = createSessionMemoryTracker(),
  setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  let timer = null, stopped = false, inFlight = null, previousHost = null, latest = null;
  let lastAttemptAt = null, lastSuccessAt = null;
  async function collect() {
    lastAttemptAt = now();
    let host;
    try { host = await readHostMemory(runner.run, platform); } catch { host = unknownHost('failed'); }
    if (stopped) return;
    const hostAt = now();
    host = { ...host, sampledAt: hostAt };
    host.swapDelta = swapDelta(previousHost, host);
    previousHost = host;
    const sessions = new Map(getSessions());
    const signatures = new Map([...sessions].map(([key, s]) => [key, [...rootsOf(s)].join(',')]));
    let snapshot = null;
    const processStartedAt = now();
    try {
      if (platform === 'darwin' || platform === 'linux') snapshot = parseMemoryProcesses(await runner.run('/bin/ps', MEMORY_PS_ARGS));
    } catch { /* explicitly unknown */ }
    if (stopped) return;
    const live = getSessions();
    // Lifecycle changed during ps: discard the racy attribution, including PID reuse.
    for (const [key, s] of sessions) {
      if (live.get(key) !== s || signatures.get(key) !== [...rootsOf(s)].join(',')) { snapshot = null; break; }
    }
    const diagnostics = sessionDiagnostics(snapshot, sessions, isRunning);
    const rows = tracker.sample(diagnostics, processStartedAt, live);
    if (host.status === 'ok') lastSuccessAt = hostAt;
    latest = { sampledAt: now(), host, processes: { ...diagnostics, rows, sampledAt: processStartedAt,
      status: snapshot ? (diagnostics.unionRssBytes === null ? 'partial' : 'ok') : 'unknown' } };
    // Optional observation must never invalidate telemetry or interrupt admission.
    try { onSample?.(telemetrySnapshot()); } catch { /* diagnostic sink only */ }
  }
  function poll() {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = collect().catch(() => {
      previousHost = null;
      latest = null;
      tracker.invalidate();
    }).finally(() => { inFlight = null; });
    return inFlight;
  }
  function telemetrySnapshot() {
    const time = now();
    const hostAgeMs = latest ? time - latest.host.sampledAt : null;
    const processAgeMs = latest ? time - latest.processes.sampledAt : null;
    const fresh = age => !stopped && age !== null && age >= 0 && age <= STALE_AFTER_MS;
    const hostFresh = fresh(hostAgeMs), processesFresh = fresh(processAgeMs);
    const unavailable = stopped ? 'stopped' : (latest ? 'stale' : 'unavailable');
    const host = hostFresh ? latest.host : { ...unknownHost(unavailable), sampledAt: latest?.host.sampledAt ?? null,
      swapDelta: { inBytes: null, outBytes: null, intervalMs: null, status: 'unknown' } };
    const processes = processesFresh ? latest.processes : { status: unavailable,
      sampledAt: latest?.processes.sampledAt ?? null, unionRssBytes: null, pidCount: null,
      admissionSlots: null, memoryOwningSessions: null, truncated: false,
      rows: (latest?.processes.rows || []).map(row => ({ ...row, currentRssBytes: null, observableRssBytes: null, peakMinusCurrentBytes: null })) };
    // Clone only small, allowlisted measurement data. No session objects escape.
    return structuredClone({ version: 1, intervalMs: SAMPLE_INTERVAL_MS, staleAfterMs: STALE_AFTER_MS,
      lastAttemptAt, lastSuccessAt, inFlight: !!inFlight, stopped,
      host: { ...host, ageMs: hostAgeMs, fresh: hostFresh },
      processes: { ...processes, ageMs: processAgeMs, fresh: processesFresh },
      history: tracker.getHistory(), historyStorage: tracker.storageStatus() });
  }
  return { tracker, poll, snapshot: telemetrySnapshot,
    start() {
      if (stopped || timer !== null) return;
      timer = setIntervalFn(poll, SAMPLE_INTERVAL_MS);
      timer.unref?.();
      void poll();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearIntervalFn(timer);
      timer = null;
      runner.stop();
      tracker.stop();
    } };
}

module.exports = { MEMORY_PS_ARGS, parseMemoryProcesses, createMemoryTelemetry };
