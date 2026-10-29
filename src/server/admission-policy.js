'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeDeviceSessionCap, DEVICE_SESSION_CAP_MAX } = require('./process-group');
const MiB = 1024 ** 2, GiB = 1024 ** 3;
const DEVICE_DIRECTORY = path.join(os.homedir(), '.tipatask');
// These are pilot safety floors, not a statement of hardware capacity. Projects
// cannot override this device file; the existing project session cap still applies.
// The memory defaults are sized against the 1024 MiB per-session estimate of the static
// cap (computeDeviceSessionCap), so they block starts when memory runs short, not before.
const FIELDS = {
  mode: ['MODE', 'ramp', ['static', 'pressure', 'ramp']],
  ceiling: ['CEILING', null, 1, 32],
  rampStepMs: ['RAMP_STEP_MS', 60000, 60000, 3600000],
  rampCeiling: ['RAMP_CEILING', null, 1, 32],
  reserveMiB: ['RESERVE_MIB', 2048, 2048, 1048576],
  reserveFraction: ['RESERVE_FRACTION', 0.08, 0.08, 0.9],
  burstMiB: ['BURST_MIB', 512, 512, 1048576],
  ordinaryMiB: ['ORDINARY_MIB', 768, 768, 1048576],
  unknownMiB: ['UNKNOWN_MIB', 1024, 1024, 1048576],
  startIntervalMs: ['START_INTERVAL_MS', 3000, 3000, 3600000],
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

function resolveAdmissionPolicy({ env = process.env, directory, hardware, read = readDeviceConfig } = {}) {
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
  // Ramp steps from the static cap one slot at a time, by default up to eight slots above
  // it. Its ceiling is never below that cap (a lower value would make the ramp meaningless)
  // and never above the 32-slot device maximum; the static cap already carries the CPU
  // bound. CEILING itself stays a pressure-mode setting.
  out.rampCeiling = Math.max(staticCap, Math.min(out.rampCeiling ?? staticCap + 8, DEVICE_SESSION_CAP_MAX));
  // Opting into pressure alone keeps the static cap as its ceiling; only an explicit
  // CEILING moves it, in either direction. Every pressure start still has to fit memory.
  out.ceiling = out.mode === 'static' ? staticCap : out.mode === 'ramp' ? out.rampCeiling : out.ceiling ?? staticCap;
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

// rampCap null means "at the static cap"; it is shared state, so a reset never
// stores an instance-local clamped number that another owner could inherit.
function initialPressureState() { return { alarm: null, normalSince: null, samples: [], lastStartAt: null, rampCap: null }; }

// (TPT9190) An explicit project session cap (AGENT_LIMITS_MAX_CONCURRENT_SESSIONS) stands in
// for the hardware static cap on that project's own requests in static and ramp mode, up to
// the 32-slot device maximum. The opt-in pressure ceiling stays device-wide. 0 = none.
function projectCapFloor(policy, projectCap) {
  return policy?.mode !== 'pressure' && Number.isSafeInteger(projectCap) && projectCap > 0
    ? Math.min(projectCap, DEVICE_SESSION_CAP_MAX) : 0;
}

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
  estimateBytes, coordinated = true, projectBlocked = false, projectCap = null }) {
  const ramp = policy.mode === 'ramp';
  const observation = policy.mode !== 'static' || state.alarm
    ? observePressure(state, telemetry, policy, now) : { fresh: false, swapBytes: null };
  const processFresh = telemetry?.processes?.fresh && ['ok', 'partial'].includes(telemetry.processes.status)
    && !telemetry.processes.truncated && now >= telemetry.processes.sampledAt
    && now - telemetry.processes.sampledAt <= policy.staleMs;
  // The shared quiet window (ramp's step window, every mode's alarm recovery window) must
  // be coordinated with fresh process telemetry for its whole length, not just at the
  // moment it is checked: either one in doubt restarts it, as observePressure() already
  // does on stale host telemetry and non-normal pressure. This runs before the cap
  // checks, so a poll refused at the device or project cap restarts it too.
  if (!processFresh || !coordinated) state.normalSince = null;
  const dynamic = policy.mode === 'pressure' && observation.fresh && processFresh && coordinated;
  const host = telemetry?.host;
  // Whole bytes, rounded up: a RAM fraction such as 8% of a power-of-two size is fractional.
  const reserve = Math.max(policy.reserveMiB * MiB, Math.ceil((host?.physicalBytes || 0) * policy.reserveFraction));
  const required = reserve + policy.burstMiB * MiB + peakGapBytes + reservedBytes + estimateBytes;
  const margin = required + policy.recoveryExtraMiB * MiB;
  // A ramp step budgets one more session, not the unspent peaks of every live
  // session. Keep the full budget at the ceiling and in pressure mode.
  const rampStepRequiredBytes = reserve + policy.burstMiB * MiB + estimateBytes + policy.recoveryExtraMiB * MiB;
  const belowRampCeiling = ramp && (state.rampCap ?? policy.staticCap) < policy.rampCeiling;
  const headroomRequired = belowRampCeiling ? rampStepRequiredBytes : required;
  const recoveryRequired = belowRampCeiling ? rampStepRequiredBytes : margin;
  // Quiet means: fresh coordinated normal-pressure host and process telemetry, a fully
  // observed minute with swap-outs under the reopen threshold, and headroom above the
  // admission threshold plus the recovery margin, held since `since` for `windowMs`.
  const quietFor = (since, windowMs, requiredHeadroom = recoveryRequired) => observation.fresh && processFresh && coordinated && host.pressure === 'normal'
    && since !== null && host.sampledAt - since >= windowMs
    && observation.swapBytes !== null && observation.swapBytes < policy.swapReopenMiB * MiB
    && host.reclaimableEstimateBytes >= requiredHeadroom;
  const latchHeadroom = () => {
    if (observation.fresh && host.reclaimableEstimateBytes < headroomRequired) { state.alarm = 'headroom'; state.normalSince = null; }
  };
  const recover = () => { if (state.alarm && quietFor(state.normalSince, policy.recoveryMs)) state.alarm = null; };
  if (ramp) {
    // Ramp evaluates alarms, recovery and the step BEFORE the cap check so an alarm
    // still clears (and the cap still drops) while starts under the static floor
    // are being admitted. Any alarm, stale host/process telemetry or coordination
    // doubt drops straight back to the static cap; with the window restart above, a
    // raise needs one whole window coordinated with fresh process telemetry, not just
    // the step moment, and starts a fresh one.
    latchHeadroom(); recover();
    if (!observation.fresh || !processFresh || !coordinated || state.alarm) state.rampCap = null;
    else if (quietFor(state.normalSince, policy.rampStepMs, rampStepRequiredBytes)) {
      state.rampCap = Math.min((state.rampCap ?? policy.staticCap) + 1, policy.rampCeiling);
      state.normalSince = host.sampledAt;
    }
  }
  // Keep non-ramp alarm tracking current even while a cap refuses starts: a
  // headroom dip restarts recovery, and a recovered alarm clears in diagnostics.
  // Static mode without an inherited alarm has no fresh observation to consult.
  if (!ramp) { latchHeadroom(); recover(); }
  const rampCap = Math.min(Math.max(state.rampCap ?? policy.staticCap, policy.staticCap), policy.rampCeiling);
  // Earliest time the next one-slot step can land if telemetry stays quiet: the shared
  // window start (a step resets it) plus one step. Null when no step is pending (at the
  // ceiling, alarm, stale host/process telemetry, coordination doubt). It can already be
  // past while the rolling-minute swap or the headroom margin still holds the step.
  const rampNextStepAt = ramp && rampCap < policy.rampCeiling && observation.fresh && processFresh && coordinated
    && !state.alarm && state.normalSince !== null ? state.normalSince + policy.rampStepMs : null;
  const deviceCap = dynamic ? policy.ceiling : ramp ? rampCap : policy.mode === 'static' ? policy.staticCap : policy.fallbackCap;
  // A project cap standing in for the static cap raises only this request's cap. The shared
  // ramp state above keeps stepping from the hardware cap, so no other project inherits it,
  // and its next step is no promise for a request already above it.
  const floor = projectCapFloor(policy, projectCap);
  const cap = Math.max(deviceCap, floor);
  const result = { allowed: false, reason: null, cap, deviceCap, mode: dynamic ? 'pressure' : ramp ? 'ramp' : 'static',
    fallback: policy.mode === 'pressure' && !dynamic, swapBytes: observation.swapBytes,
    rampCap: ramp ? cap : null, rampCeiling: ramp ? Math.max(policy.rampCeiling, cap) : null,
    rampNextStepAt: cap > deviceCap ? null : rampNextStepAt,
    requiredBytes: required, headroomBytes: host?.reclaimableEstimateBytes ?? null };
  const reject = reason => ({ ...result, reason });
  if (projectBlocked) return reject('project-cap');
  if (running >= cap) return reject('device-cap');
  if (policy.mode === 'static' && !state.alarm) return { ...result, allowed: true };
  // The static floor (or a project cap standing in for it) never consults memory, exactly
  // as static mode: an alarm only closes the ramp slots above it.
  if (ramp && running < Math.max(policy.staticCap, floor)) return { ...result, allowed: true };
  if (state.alarm) return reject(state.alarm);
  if (dynamic && observation.swapBytes === null) return reject('swap-history');
  if ((policy.mode === 'pressure' || ramp) && state.lastStartAt !== null && now - state.lastStartAt < policy.startIntervalMs) {
    result.retryAfterMs = policy.startIntervalMs - (now - state.lastStartAt); return reject('spacing');
  }
  return { ...result, allowed: true };
}

module.exports = { MiB, GiB, DEVICE_DIRECTORY, FIELDS, readDeviceConfig, resolveAdmissionPolicy,
  estimatePeak, resolveWorkload, initialPressureState, observePressure, projectCapFloor, decideAdmission };
