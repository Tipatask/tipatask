'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeDeviceSessionCap } = require('./process-group');
const MiB = 1024 ** 2, GiB = 1024 ** 3;
const DEVICE_DIRECTORY = path.join(os.homedir(), '.tipatask');
// These are pilot safety floors, not a statement of hardware capacity. Projects
// cannot override this device file; the existing project session cap still applies.
const FIELDS = {
  mode: ['MODE', 'static', ['static', 'pressure']],
  ceiling: ['CEILING', null, 1, 32],
  reserveMiB: ['RESERVE_MIB', 6144, 6144, 1048576],
  reserveFraction: ['RESERVE_FRACTION', 0.125, 0.125, 0.9],
  burstMiB: ['BURST_MIB', 1024, 1024, 1048576],
  ordinaryMiB: ['ORDINARY_MIB', 2048, 2048, 1048576],
  unknownMiB: ['UNKNOWN_MIB', 4096, 4096, 1048576],
  startIntervalMs: ['START_INTERVAL_MS', 10000, 10000, 3600000],
  recoveryMs: ['RECOVERY_MS', 30000, 30000, 3600000],
  recoveryExtraMiB: ['RECOVERY_EXTRA_MIB', 2048, 2048, 1048576],
  staleMs: ['STALE_MS', 15000, 1000, 15000],
  fallbackCap: ['FALLBACK_CAP', null, 1, 32],
  swapCloseMiB: ['SWAP_CLOSE_MIB', 512, 1, 512],
  swapReopenMiB: ['SWAP_REOPEN_MIB', 64, 1, 64],
};

function readDeviceConfig(directory = DEVICE_DIRECTORY) {
  const file = path.join(directory, 'admission.json');
  try {
    if (fs.statSync(file).size > 65536) throw Error('oversize');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config || Array.isArray(config) || typeof config !== 'object') throw Error('invalid');
    return { config, status: 'ok', file };
  } catch (err) { return { config: {}, status: err.code === 'ENOENT' ? 'absent' : 'invalid', file }; }
}

function resolveAdmissionPolicy({ env = process.env, directory, hardware, platform = process.platform, read = readDeviceConfig } = {}) {
  const hw = hardware || { totalMemBytes: os.totalmem(), cores: os.availableParallelism?.() || os.cpus().length };
  const staticCap = computeDeviceSessionCap(hw);
  const stored = read(directory);
  const out = { staticCap, sources: {}, rejected: [], configStatus: stored.status, configFile: stored.file };
  for (const [field, [suffix, defaultValue, min, max]] of Object.entries(FIELDS)) {
    const key = `AGENT_ADMISSION_${suffix}`;
    const parse = raw => {
      if (Array.isArray(min)) return typeof raw === 'string' && min.includes(raw.trim().toLowerCase()) ? raw.trim().toLowerCase() : null;
      if (typeof raw !== 'number' && !(typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim()))) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n >= min && n <= max && (field === 'reserveFraction' || Number.isInteger(n)) ? n : null;
    };
    let value = null;
    for (const [source, raw] of [['env', env?.[key]], ['device-config', stored.config?.[key]]]) {
      if (raw === undefined) continue;
      const parsed = parse(raw);
      if (parsed === null) { out.rejected.push({ key, source }); continue; }
      value = parsed; out.sources[field] = source; break;
    }
    out[field] = value ?? defaultValue;
    out.sources[field] ||= 'default';
  }
  const studied = platform === 'darwin' && hw.totalMemBytes === 48 * GiB && hw.cores === 18;
  // Opting in stages the studied machine at eight; elsewhere opt-in alone never
  // raises the static ceiling. Expansion beyond twelve is a separate explicit edit.
  const requested = out.ceiling ?? (studied ? 8 : staticCap);
  out.ceiling = out.mode === 'static' ? staticCap : Math.min(requested, Math.max(1, Math.min(16, hw.cores || 1)));
  out.fallbackCap = Math.min(out.fallbackCap ?? staticCap, staticCap, out.ceiling);
  out.unknownMiB = Math.max(out.unknownMiB, out.ordinaryMiB);
  out.swapReopenMiB = Math.min(out.swapReopenMiB, out.swapCloseMiB);
  out.fingerprint = JSON.stringify(Object.fromEntries(Object.keys(FIELDS).map(key => [key, out[key]])));
  return out;
}

// Classification is explicit local metadata, never a guess based on task prose.
// Old telemetry records have no admissionClass and cannot establish comparability.
function estimatePeak(policy, session, history = []) {
  const kind = session.admissionClass === 'ordinary' ? 'ordinary' : 'unknown';
  const floor = (kind === 'ordinary' ? policy.ordinaryMiB : policy.unknownMiB) * MiB;
  const peaks = history.filter(r => r.completeLifetime && r.reason === 'completed'
    && r.provider === session.taskAgent && r.workload === 'terminal' && r.admissionClass === kind
    && Number.isSafeInteger(r.peakRssBytes) && r.peakRssBytes >= 0).map(r => r.peakRssBytes).sort((a, b) => a - b);
  return { bytes: peaks.length < 20 ? floor : Math.max(floor, Math.ceil(1.25 * peaks[Math.ceil(peaks.length * 0.95) - 1])),
    floorBytes: floor, histories: peaks.length, admissionClass: kind,
    source: session.admissionClassSource || 'default' };
}

function resolveWorkload(config, env = process.env) {
  const key = 'AGENT_ADMISSION_WORKLOAD_CLASS';
  for (const [source, raw] of [['env', env?.[key]], ['project-config', config?.[key]]]) {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (['ordinary', 'unknown', 'build-heavy'].includes(value)) return { admissionClass: value === 'ordinary' ? value : 'unknown', admissionClassSource: source };
  }
  return { admissionClass: 'unknown', admissionClassSource: 'default' };
}

function initialPressureState() { return { alarm: null, normalSince: null, samples: [], lastStartAt: null }; }

function observePressure(state, telemetry, policy, now) {
  const host = telemetry?.host;
  const fresh = host?.fresh && host.status === 'ok' && now >= host.sampledAt && now - host.sampledAt <= policy.staleMs;
  if (!fresh) { state.normalSince = null; return { fresh: false, swapBytes: null }; }
  const last = state.samples.at(-1);
  if (last && (host.sampledAt < last.at || (host.sampledAt === last.at && last.pressure !== 'normal' && host.pressure === 'normal'))) {
    return { fresh: false, swapBytes: null };
  }
  if (!last || host.sampledAt > last.at) {
    if (last && (host.sampledAt - last.at > policy.staleMs || host.swapOutBytes < last.swap || host.pageSizeBytes !== last.page)) {
      state.samples = []; state.normalSince = null;
    }
    state.samples.push({ at: host.sampledAt, swap: host.swapOutBytes, page: host.pageSizeBytes, pressure: host.pressure });
    // Keep the sample immediately BEFORE the minute boundary: conservative total,
    // never interpolate away a burst at either edge of the rolling minute.
    while (state.samples.length > 2 && state.samples[1].at <= host.sampledAt - 60000) state.samples.shift();
    state.samples = state.samples.slice(-128);
  }
  const first = state.samples[0];
  const growth = host.swapOutBytes - first.swap;
  const covered = host.sampledAt - first.at >= 60000;
  if (host.pressure !== 'normal') { state.alarm = 'pressure'; state.normalSince = null; }
  else if (state.normalSince === null) state.normalSince = host.sampledAt;
  if (growth >= policy.swapCloseMiB * MiB) { state.alarm = 'swap'; state.normalSince = null; }
  return { fresh: true, swapBytes: covered ? growth : null };
}

function decideAdmission({ policy, state, telemetry, now, running, reservedBytes = 0, peakGapBytes = 0,
  estimateBytes, coordinated = true, projectBlocked = false }) {
  const observation = policy.mode === 'pressure' || state.alarm
    ? observePressure(state, telemetry, policy, now) : { fresh: false, swapBytes: null };
  const processFresh = telemetry?.processes?.fresh && ['ok', 'partial'].includes(telemetry.processes.status)
    && !telemetry.processes.truncated && now >= telemetry.processes.sampledAt
    && now - telemetry.processes.sampledAt <= policy.staleMs;
  const dynamic = policy.mode === 'pressure' && observation.fresh && processFresh && coordinated;
  const cap = dynamic ? policy.ceiling : (policy.mode === 'static' ? policy.staticCap : policy.fallbackCap);
  const result = { allowed: false, reason: null, cap, mode: dynamic ? 'pressure' : 'static',
    fallback: policy.mode === 'pressure' && !dynamic, swapBytes: observation.swapBytes,
    headroomBytes: telemetry?.host?.reclaimableEstimateBytes ?? null };
  const reject = reason => ({ ...result, reason });
  if (projectBlocked) return reject('project-cap');
  if (running >= cap) return reject('device-cap');
  if (policy.mode === 'static' && !state.alarm) return { ...result, allowed: true };
  const host = telemetry?.host;
  const reserve = Math.max(policy.reserveMiB * MiB, (host?.physicalBytes || 0) * policy.reserveFraction);
  const required = reserve + policy.burstMiB * MiB + peakGapBytes + reservedBytes + estimateBytes;
  result.requiredBytes = required;
  if (observation.fresh && host.reclaimableEstimateBytes < required) {
    state.alarm = 'headroom'; state.normalSince = null;
  }
  if (state.alarm) {
    if (!observation.fresh || !coordinated || host.pressure !== 'normal'
      || state.normalSince === null || host.sampledAt - state.normalSince < policy.recoveryMs
      || observation.swapBytes === null || observation.swapBytes >= policy.swapReopenMiB * MiB
      || host.reclaimableEstimateBytes < required + policy.recoveryExtraMiB * MiB) return reject(state.alarm);
    state.alarm = null;
  }
  if (dynamic && observation.swapBytes === null) return reject('swap-history');
  if (policy.mode === 'pressure' && state.lastStartAt !== null && now - state.lastStartAt < policy.startIntervalMs) {
    result.retryAfterMs = policy.startIntervalMs - (now - state.lastStartAt); return reject('spacing');
  }
  return { ...result, allowed: true };
}

module.exports = { MiB, GiB, DEVICE_DIRECTORY, FIELDS, readDeviceConfig, resolveAdmissionPolicy,
  estimatePeak, resolveWorkload, initialPressureState, observePressure, decideAdmission };
