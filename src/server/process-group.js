'use strict';

// (C1565) Process-group kill + descendant-count watchdog for PTY terminal sessions.
//
// Root cause this closes: node-pty's forkpty() calls setsid() under the hood, so every
// spawned pty child is already its own session + process-group leader (pgid === pid) —
// but node-pty's own UnixTerminal.prototype.kill() only ever does
// `process.kill(this.pid, sig)`, the direct child alone. A backgrounded build/npm chain
// the agent spawns inside the pty is never touched by session teardown and can outlive
// it indefinitely once orphaned (reparented to pid 1) — see the C65/C128 incident report
// (task comment on C1565) for the ~3,600-process runaway this produced in practice.
//
// killProcessGroup() fixes teardown (kill the whole group, not just the leader).
// listDescendants()/sumTreeRss()/evaluateRunaway() back a periodic watchdog (index.js) that
// judges each session tree by process count AND memory, warns first, and then applies the
// project's configured action (resolveAgentLimits().watchdogAction): 'warn' never acts,
// 'pause' (default) SIGSTOPs the tree — resumable, nothing is killed — and 'kill' terminates
// it (explicit opt-in: AGENT_LIMITS_WATCHDOG_ACTION=kill or TIPATASK_WATCHDOG_KILL=1).

const { execFile, spawnSync: nodeSpawnSync } = require('node:child_process');
const os = require('node:os');

const DESCENDANT_ALERT_THRESHOLD = 50;
// (TPT370) Warn-then-kill policy, revised after a healthy Codex session (steady ~54
// descendants — Codex keeps a pool of long-lived "unified exec" background terminals open)
// was killed by the old rule (kill on the 2nd consecutive sweep at/above the threshold,
// regardless of trend). A stable or shrinking count at/above the threshold now only ever
// warns. The count side of the policy acts (per watchdogAction — pause or kill) on either:
//   - DESCENDANT_KILL_CONSECUTIVE consecutive sweeps that are each at/above the threshold
//     AND rose by at least DESCENDANT_KILL_GROWTH over the sweep before, or
//   - any single sweep at/above the ceiling (DESCENDANT_CEILING_FACTOR x the warn threshold;
//     DESCENDANT_KILL_CEILING at the default threshold) — for a fork bomb that never gives
//     the growth rule two sweeps to observe it.
const DESCENDANT_KILL_CONSECUTIVE = 2;
const DESCENDANT_KILL_GROWTH = 10;
const DESCENDANT_CEILING_FACTOR = 3;
const DESCENDANT_KILL_CEILING = DESCENDANT_CEILING_FACTOR * DESCENDANT_ALERT_THRESHOLD;
// Memory enforcement needs sustained high RSS AND this tree's growth. Host pressure
// lowers the required growth, never selects a stable tree for punishment. These pilot
// defaults are configurable; RSS is an over-counting signal, not physical RAM ownership.
const RSS_WARN_FRACTION = 1;
const RSS_PAUSE_CONSECUTIVE = 3;
const RSS_PAUSE_FACTOR = 2;
const RESUME_RSS_GRACE_FRACTION = 0.25;
const WATCHDOG_INTERVAL_MS = 30000;
const PS_ARGS = ['-Ao', 'pgid=,pid=,ppid=,rss=,stat=,comm='];
const PS_TIMEOUT_MS = 5000;

// ── Agent resource limits (TPT440) ──
//
// One source of truth for the numbers the spawn-side caps and the watchdog both enforce.
// Per field: env var > `.tipatask/config.json` > default; an invalid value at one level
// falls through to the next instead of masking it. `watchdogAction` additionally maps the
// legacy TIPATASK_WATCHDOG_KILL=1 opt-in to 'kill'.
const WATCHDOG_ACTIONS = Object.freeze(['warn', 'pause', 'kill']);
// `maxConcurrentSessions` has no static default: it is derived from the device's hardware
// (computeDeviceSessionCap below) unless a config/env value sets a lower per-project cap.
const AGENT_LIMIT_DEFAULTS = Object.freeze({
  maxSubagents: 3,
  warnDescendants: DESCENDANT_ALERT_THRESHOLD,
  maxTreeRssMb: 6144,
  rssGrowthMb: 512,
  rssPressureGrowthMb: 128,
  rssSamples: RSS_PAUSE_CONSECUTIVE,
  soloMultiplier: 2,
  minScale: 0.25,
  watchdogAction: 'pause',
});
const AGENT_LIMIT_KEYS = Object.freeze({
  maxConcurrentSessions: 'AGENT_LIMITS_MAX_CONCURRENT_SESSIONS',
  maxSubagents: 'AGENT_LIMITS_MAX_SUBAGENTS',
  warnDescendants: 'AGENT_LIMITS_WARN_DESCENDANTS',
  maxTreeRssMb: 'AGENT_LIMITS_MAX_TREE_RSS_MB',
  descendantCeiling: 'AGENT_LIMITS_DESCENDANT_CEILING',
  rssActionMb: 'AGENT_LIMITS_RSS_ACTION_MB',
  rssGrowthMb: 'AGENT_LIMITS_RSS_GROWTH_MB',
  rssPressureGrowthMb: 'AGENT_LIMITS_RSS_PRESSURE_GROWTH_MB',
  rssSamples: 'AGENT_LIMITS_RSS_SAMPLES',
  soloMultiplier: 'AGENT_LIMITS_SOLO_MULTIPLIER',
  minScale: 'AGENT_LIMITS_MIN_SCALE',
  watchdogAction: 'AGENT_LIMITS_WATCHDOG_ACTION',
});

// (TPT444) Parallel-session cap derived from the machine, so a 48GB Mac runs many sessions
// while a small/slow one still stays responsive. Uses a fixed 6144 MiB admission
// estimate, independent of watchdog defaults or settings. The optional
// budget argument supports arithmetic callers only; resolveAgentLimits never supplies it.
//   reserve  = max(6GB, 20% of RAM) kept for the OS, the Task App and the user's other apps
//   ramSlots = floor((RAM - reserve) / budget)
//   cpuSlots = cores — sessions mostly wait on the model, but build/test bursts are CPU-bound
// Clamped to [1, DEVICE_SESSION_CAP_MAX]; unreadable hardware numbers fall back to 1 slot.
const DEVICE_SESSION_CAP_MAX = 32;
const DEVICE_SESSION_BUDGET_MB = 6144;
const DEVICE_RESERVE_MIN_MB = 6144;
const DEVICE_RESERVE_FRACTION = 0.2;

function computeDeviceSessionCap({ totalMemBytes, cores, sessionBudgetMb } = {}) {
  const totalMb = Number(totalMemBytes) / (1024 * 1024);
  const budget = Number(sessionBudgetMb) > 0 ? Number(sessionBudgetMb) : DEVICE_SESSION_BUDGET_MB;
  const cpuSlots = Math.floor(Number(cores));
  if (!Number.isFinite(totalMb) || totalMb <= 0 || !Number.isFinite(cpuSlots) || cpuSlots < 1) return 1;
  const reserveMb = Math.max(DEVICE_RESERVE_MIN_MB, totalMb * DEVICE_RESERVE_FRACTION);
  const ramSlots = Math.floor((totalMb - reserveMb) / budget);
  return Math.max(1, Math.min(DEVICE_SESSION_CAP_MAX, ramSlots, cpuSlots));
}

function detectHardware() {
  let cores = 0;
  try { cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length; } catch { /* no-op */ }
  let totalMemBytes = 0;
  try { totalMemBytes = os.totalmem(); } catch { /* no-op */ }
  return { totalMemBytes, cores };
}

// Positive safe integer from a number or a plain digit string; anything else -> null.
function parseLimitInt(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    value = Number(trimmed);
  }
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// Scaling accepts positive finite decimals, including plain decimal strings.
function parseLimitScale(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return null;
    value = Number(trimmed);
  }
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseWatchdogAction(value) {
  if (typeof value !== 'string') return null;
  const action = value.trim().toLowerCase();
  return WATCHDOG_ACTIONS.includes(action) ? action : null;
}

// Never throws. `readConfig`/`env` are injectable for tests (same seam style as
// snapshotProcesses({ exec })). Lazy-required so this module stays loadable standalone.
function resolveAgentLimits(projectRoot, { env = process.env, readConfig, hardware } = {}) {
  let cfg = null;
  try {
    const read = readConfig || require('./project-config').readProjectConfig;
    if (projectRoot) cfg = read(projectRoot) || null;
  } catch { cfg = null; }
  const envVars = env || {};
  const out = {};
  for (const field of ['maxSubagents', 'warnDescendants', 'maxTreeRssMb']) {
    const key = AGENT_LIMIT_KEYS[field];
    out[field] = parseLimitInt(envVars[key])
      ?? parseLimitInt(cfg && cfg[key])
      ?? AGENT_LIMIT_DEFAULTS[field];
  }
  for (const field of ['soloMultiplier', 'minScale']) {
    const key = AGENT_LIMIT_KEYS[field];
    out[field] = parseLimitScale(envVars[key])
      ?? parseLimitScale(cfg && cfg[key])
      ?? AGENT_LIMIT_DEFAULTS[field];
  }
  Object.assign(out, enforcementLimits(out, envVars, cfg));
  // Hardware-derived static cap, independent of project watchdog RSS settings.
  // Pressure-mode admission can expand it only through the shared device policy. `sessionCapSource` tells the start queue whether the
  // project set its own (per-project) cap.
  const hw = hardware || detectHardware();
  const deviceSessionCap = computeDeviceSessionCap(hw);
  const capKey = AGENT_LIMIT_KEYS.maxConcurrentSessions;
  const envCap = parseLimitInt(envVars[capKey]);
  const cfgCap = envCap === null ? parseLimitInt(cfg && cfg[capKey]) : null;
  const explicitCap = envCap ?? cfgCap;
  out.maxConcurrentSessions = explicitCap === null ? deviceSessionCap : Math.min(explicitCap, deviceSessionCap);
  out.deviceSessionCap = deviceSessionCap;
  out.sessionCapSource = envCap !== null ? 'env' : (cfgCap !== null ? 'config' : 'device');
  if (explicitCap !== null) out.projectSessionCap = explicitCap;
  const actionKey = AGENT_LIMIT_KEYS.watchdogAction;
  out.watchdogAction = parseWatchdogAction(envVars[actionKey])
    ?? (envVars.TIPATASK_WATCHDOG_KILL === '1' ? 'kill' : null)
    ?? parseWatchdogAction(cfg && cfg[actionKey])
    ?? AGENT_LIMIT_DEFAULTS.watchdogAction;
  return out;
}

// Pass freshly resolved base limits, not a previously scaled copy. Session admission
// caps and watchdog action remain unchanged; only each session's resource budget scales.
function scaleAgentLimitsForConcurrency(limits, activeCount) {
  const count = parseLimitInt(activeCount) ?? 1;
  const soloMultiplier = parseLimitScale(limits.soloMultiplier) ?? AGENT_LIMIT_DEFAULTS.soloMultiplier;
  const minScale = parseLimitScale(limits.minScale) ?? AGENT_LIMIT_DEFAULTS.minScale;
  const scale = Math.max(minScale, soloMultiplier / count);
  const out = { ...limits };
  // Only advisory budgets and prompt fan-out scale. Enforcement never tightens
  // merely because another terminal starts, including with custom base limits.
  for (const [field, source] of [['advisoryDescendants', 'warnDescendants'],
    ['advisoryTreeRssMb', 'maxTreeRssMb'], ['maxSubagents', 'maxSubagents']]) {
    const value = parseLimitInt(limits[source]);
    if (value !== null) out[field] = Math.max(1, Math.round(value * scale));
  }
  return out;
}

function enforcementLimits(limits, env = {}, cfg = {}) {
  const defaults = {
    descendantCeiling: (parseLimitInt(limits.warnDescendants) || DESCENDANT_ALERT_THRESHOLD) * DESCENDANT_CEILING_FACTOR,
    rssActionMb: (parseLimitInt(limits.maxTreeRssMb) || 0) * RSS_PAUSE_FACTOR,
    rssGrowthMb: AGENT_LIMIT_DEFAULTS.rssGrowthMb,
    rssPressureGrowthMb: AGENT_LIMIT_DEFAULTS.rssPressureGrowthMb,
    rssSamples: AGENT_LIMIT_DEFAULTS.rssSamples,
  };
  for (const field of Object.keys(defaults)) {
    const key = AGENT_LIMIT_KEYS[field];
    const valid = value => {
      const n = parseLimitInt(value);
      return field === 'rssSamples' && n < 3 ? null : n;
    };
    defaults[field] = valid(env[key]) ?? valid(cfg && cfg[key]) ?? valid(limits[field]) ?? defaults[field];
  }
  return defaults;
}

// The shared registry contains every project's terminal and headless chat sessions.
// Paused terminals still hold resources and count; queued starts have no live PTY.
function countActiveAgentSessions(sessions) {
  let count = 0;
  for (const [, session] of sessions) {
    if (session && session.type === 'terminal' && session.alive && session.ptyPid) count++;
  }
  return count;
}

// ── Group kill ──
//
// A negative pid signals the whole process group — getting the target wrong here kills
// the Task App server itself, so this refuses (returns false, never throws) rather than
// signal anything it isn't confident is a foreign, real process group:
//   - falsy/undefined pid, or pid <= 1 (never touch init/launchd)
//   - win32 (negative pids are POSIX-only; node-pty's WindowsPtyProcess has no pgid concept)
//   - our own pid or our own process group
// On any other failure (ESRCH — already dead, or a child that somehow isn't a group
// leader) it returns false so the caller can fall through to a leader-only kill, same
// shape as claude-session.js's killObjectiveProc().
function killProcessGroup(pid, signal) {
  if (!pid || pid <= 1) return false;
  if (process.platform === 'win32') return false;
  if (pid === process.pid) return false;
  if (typeof process.getpgrp === 'function') {
    try { if (pid === process.getpgrp()) return false; } catch { /* no-op — fall through */ }
  }
  try {
    process.kill(-pid, signal || 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

// ── Windows tree kill ──
//
// Windows has no process groups, so killProcessGroup() above refuses there and a plain
// child.kill() is a TerminateProcess of that one pid: its descendants (ConPTY agent CLIs,
// ELECTRON_RUN_AS_NODE MCP servers, the Pi CLI) are orphaned and keep running from the
// install directory, which then blocks the NSIS upgrade. `taskkill /T /F` walks the
// parent-pid chain from the root and force-kills the whole tree. Synchronous on purpose:
// the Electron main process calls it from 'will-quit' and must not exit before the tree is
// gone (once the root dies, its orphans are no longer reachable through /T). Same refusal
// rules as killProcessGroup(); never throws. `spawnSync`/`platform` are test seams.
function killWindowsProcessTree(pid, { spawnSync = nodeSpawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return false;
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    const result = spawnSync(`${systemRoot}\\System32\\taskkill.exe`, ['/T', '/F', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000,
    });
    return !!result && result.status === 0;
  } catch {
    return false;
  }
}

// ── ps snapshot + parsing ──
//
// `text` is the raw stdout of `ps -Ao pgid=,pid=,ppid=,rss=,stat=,comm=` — no header (the
// trailing `=` on each field suppresses it), ragged leading whitespace exactly as real `ps`
// emits it. `comm` is last and may itself contain spaces (e.g. "Google Chrome Helper"), so
// everything after `stat` is rejoined as one field. `rss` (resident memory, KB) sits before
// `stat` so it can be told apart without guessing: a numeric 4th token is rss, a non-numeric
// one is `stat` (never numeric) from a row without the rss column. A row is also accepted
// with only the first 3 numeric columns — `rss`/`stat`/`comm` are then left undefined for
// that pid.
//
// Zombie rows (`stat` starting with `Z`) are dropped: a zombie has already exited, holds no
// resources, and (having no children of its own — they're reparented on exit) never affects
// `listDescendants()`'s reachability, only its raw count. Excluding them keeps the descendant
// count reflecting live processes actually worth warning/killing over.
function parsePsOutput(text) {
  const byPgid = new Map(); // pgid -> pid[]
  const parents = new Map(); // pid -> ppid
  const pgidOf = new Map(); // pid -> pgid
  const commOf = new Map(); // pid -> comm (basename, e.g. "node" not "/usr/local/bin/node")
  const rssOf = new Map(); // pid -> resident memory in KB
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const pgid = Number(parts[0]);
    const pid = Number(parts[1]);
    const ppid = Number(parts[2]);
    if (!Number.isFinite(pgid) || !Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const hasRss = parts.length > 3 && /^\d+$/.test(parts[3]);
    const statAt = hasRss ? 4 : 3;
    const stat = parts[statAt];
    if (stat && stat[0] === 'Z') continue; // zombie — already exited, no resources, no children
    if (!byPgid.has(pgid)) byPgid.set(pgid, []);
    byPgid.get(pgid).push(pid);
    parents.set(pid, ppid);
    pgidOf.set(pid, pgid);
    if (hasRss) rssOf.set(pid, Number(parts[3]));
    if (parts.length > statAt + 1) {
      const comm = parts.slice(statAt + 1).join(' ');
      const base = comm.slice(comm.lastIndexOf('/') + 1);
      commOf.set(pid, base || comm);
    }
  }
  return { byPgid, parents, pgidOf, commOf, rssOf };
}

// Injectable `exec` (default execFile) mirrors bundle-signature.js's `_run()` — lets
// process-group.test.js stub the syscall instead of depending on real machine state.
// Returns null on any failure (never throws) — callers must treat null as "skip this
// tick", exactly like a fail-open KB/status fetch elsewhere in this codebase.
function snapshotProcesses({ exec = execFile } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = exec('/bin/ps', PS_ARGS, { timeout: PS_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
        if (settled) return;
        settled = true;
        if (err) { resolve(null); return; }
        resolve(parsePsOutput(stdout));
      });
    } catch {
      resolve(null);
      return;
    }
    // Belt-and-braces, same reasoning as bundle-signature.js's _run(): execFile's own
    // `timeout` should always fire first, but a hung ps must never hang the watchdog tick.
    const backstop = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* best-effort */ }
      resolve(null);
    }, PS_TIMEOUT_MS + 2000);
    if (typeof backstop.unref === 'function') backstop.unref();
  });
}

// Lists every process descended from rootPid, excluding rootPid itself, as the UNION of:
//   (a) the ppid tree rooted at rootPid — the normal case
//   (b) processes sharing rootPid's process group (pgid === rootPid) — catches the
//       incident's orphaned chain (reparented to pid 1, so no longer in the ppid tree,
//       but pgid still intact)
// Each admitted pid is itself expanded for further ppid-tree children — this is what
// makes a group member discovered only via (b) still contribute ITS OWN descendants
// (e.g. a member that itself forked further children) to the result, not just itself.
// A rootPid absent from the snapshot (already exited, or never existed) yields an empty set.
function listDescendants(snapshot, rootPid) {
  const found = new Set();
  if (!snapshot || !rootPid) return found;

  // Build children-by-parent once per call — snapshots are small (one ps per 30s tick)
  // and this keeps listDescendants() a pure function of (snapshot, rootPid) with no
  // shared mutable index to keep in sync across calls.
  const childrenByPpid = new Map();
  for (const [pid, ppid] of snapshot.parents) {
    if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, []);
    childrenByPpid.get(ppid).push(pid);
  }

  const toExpand = [];
  const admit = (pid) => {
    if (pid === rootPid || found.has(pid)) return;
    found.add(pid);
    toExpand.push(pid);
  };

  for (const pid of (childrenByPpid.get(rootPid) || [])) admit(pid);
  for (const pid of (snapshot.byPgid.get(rootPid) || [])) admit(pid);

  while (toExpand.length) {
    const pid = toExpand.pop();
    for (const child of (childrenByPpid.get(pid) || [])) admit(child);
  }

  return found;
}

function countDescendants(snapshot, rootPid) {
  return listDescendants(snapshot, rootPid).size;
}

// Resident memory of a session's whole tree in KB: rootPid itself (the agent CLI) plus every
// descendant. `pids` lets a caller that already holds listDescendants()'s result avoid a
// second walk. RSS counts pages shared between processes once per process, so the sum
// over-states real use — it is a budget signal, not an accounting figure. Returns 0 when the
// snapshot carries no rss column, which leaves every memory rule in evaluateRunaway() inert.
function sumTreeRss(snapshot, rootPid, pids) {
  if (!snapshot || !snapshot.rssOf || !rootPid) return 0;
  const members = pids || listDescendants(snapshot, rootPid);
  let total = snapshot.rssOf.get(rootPid) || 0;
  for (const pid of members) total += snapshot.rssOf.get(pid) || 0;
  return total;
}

// Pure, bounded watchdog state. Count growth uses two consecutive +10 samples;
// the independent emergency ceiling acts immediately. Memory needs >=3 observations
// spanning real 30-second intervals, all above its action mark, plus two growth intervals.
// Missing RSS, clock jumps and sampling gaps break memory evidence. Pause and kill use
// the same evidence; the configured action changes only the signal, never sensitivity.
function evaluateRunaway(state, sample, limits = {}) {
  const isBare = typeof sample === 'number';
  const count = (isBare ? sample : Number(sample && sample.count)) || 0;
  const rawRss = isBare ? null : sample?.rssMb;
  const rssMb = typeof rawRss === 'number' && Number.isFinite(rawRss) && rawRss >= 0 ? rawRss : null;
  const opts = limits || {};
  const threshold = parseLimitInt(opts.warnDescendants) || state.threshold || DESCENDANT_ALERT_THRESHOLD;
  const limitMb = parseLimitInt(opts.maxTreeRssMb) || 0;
  const policy = enforcementLimits({ ...opts, warnDescendants: threshold });
  const ceiling = parseLimitInt(opts.descendantCeiling) || state.killCeiling || policy.descendantCeiling;
  const action = parseWatchdogAction(opts.watchdogAction) || 'warn';
  const base = state.resumeBase || null;
  const at = !isBare && Number.isFinite(sample?.sampledAt) ? sample.sampledAt : null;
  const elapsed = at !== null && state.lastSampleAt != null ? at - state.lastSampleAt : null;
  // Allow timer/ps jitter, but never turn rapid repeated calls into 30-second evidence.
  const continuous = elapsed !== null && elapsed >= 25000 && elapsed <= 45000;
  const policyKey = JSON.stringify([threshold, ceiling, limitMb, policy]);
  const changed = state.policyKey != null && state.policyKey !== policyKey;
  const tightened = threshold < state.threshold || changed;
  state.threshold = threshold;
  state.policyKey = policyKey;
  if (tightened) {
    state.growthStreak = 0;
    state.rssStreak = 0;
    state.rssGrowthStreak = 0;
    state.pressureGrowthStreak = 0;
    state.pressureStreak = 0;
    state.rssSince = null;
    state.alerted = false;
    state.rssAlerted = false;
  }

  // Bare count callers retain the original sweep API. Runtime callers always timestamp.
  const grew = !tightened && (at === null || continuous) && count >= threshold && state.lastCount >= threshold
    && count - state.lastCount >= DESCENDANT_KILL_GROWTH;
  state.growthStreak = grew ? (state.growthStreak || 0) + 1 : 0;
  const actCeiling = base ? Math.max(ceiling, (base.count || 0) + threshold) : ceiling;
  const countReason = count >= actCeiling ? 'count-ceiling'
    : state.growthStreak >= DESCENDANT_KILL_CONSECUTIVE ? 'count-growth' : null;

  const actMb = Math.max(policy.rssActionMb, base && limitMb
    ? (base.rssMb || 0) + Math.ceil(limitMb * RESUME_RSS_GRACE_FRACTION) : 0);
  const above = !tightened && at !== null && rssMb !== null && limitMb > 0 && rssMb > actMb;
  const continuing = above && continuous && state.rssStreak > 0;
  state.rssStreak = above ? (continuing ? state.rssStreak + 1 : 1) : 0;
  state.rssSince = above ? (continuing ? state.rssSince : at) : null;
  const delta = continuing && state.lastRssMb != null ? rssMb - state.lastRssMb : null;
  state.rssGrowthStreak = delta !== null && delta >= policy.rssGrowthMb ? (state.rssGrowthStreak || 0) + 1 : 0;
  state.pressureGrowthStreak = delta !== null && delta >= policy.rssPressureGrowthMb ? (state.pressureGrowthStreak || 0) + 1 : 0;
  const host = !isBare && sample?.host;
  const pressure = host?.fresh === true && host.status === 'ok'
    && Number.isFinite(host.sampledAt) && at !== null && at - host.sampledAt >= 0 && at - host.sampledAt <= 15000
    && (host.pressure === 'warning' || host.pressure === 'critical');
  state.pressureStreak = above && pressure ? (continuing ? (state.pressureStreak || 0) + 1 : 1) : 0;
  const sustained = state.rssStreak >= policy.rssSamples
    && at - state.rssSince >= (policy.rssSamples - 1) * WATCHDOG_INTERVAL_MS;
  const memoryReason = sustained && state.rssGrowthStreak >= 2 ? 'memory-growth'
    : sustained && state.pressureStreak >= policy.rssSamples && state.pressureGrowthStreak >= 2 ? 'memory-pressure' : null;

  // ── warnings ──
  let alert = false;
  let reason = null;
  if (count >= threshold && (!state.alerted || count - state.lastAlertCount >= threshold)) {
    alert = true;
    reason = 'count';
    state.alerted = true;
    state.lastAlertCount = count;
  } else if (count < threshold / 2) {
    state.alerted = false;
  }
  if (limitMb > 0) {
    const warnMb = limitMb * RSS_WARN_FRACTION;
    if (rssMb >= warnMb && (!state.rssAlerted || rssMb - (state.lastAlertRssMb || 0) >= limitMb)) {
      alert = true;
      reason = 'memory';
      state.rssAlerted = true;
      state.lastAlertRssMb = rssMb;
    } else if (rssMb !== null && rssMb < warnMb / 2) {
      state.rssAlerted = false;
    }
  }

  // ── action ──
  const violation = tightened ? null : (countReason || memoryReason);
  if (action !== 'kill') {
    state.killed = false;
  } else if (!state.killed) {
    state.killed = violation !== null;
    if (violation) state.actReason = violation;
  }
  if (action === 'pause' && violation && !state.paused) {
    state.paused = true;
    state.actReason = violation;
  }
  const kill = state.killed === true;
  const pause = !kill && action === 'pause' && state.paused === true;
  if (kill || pause) {
    alert = false;
    reason = state.actReason || violation || null;
  }
  if (base && (limitMb === 0 || (rssMb !== null && rssMb < limitMb)) && count < ceiling) state.resumeBase = null;
  state.lastCount = count;
  state.lastRssMb = rssMb;
  state.lastSampleAt = at;
  return { alert, pause, kill, count, rssMb, reason };
}

// ── Diagnostics (TPT370) ──
//
// The old warn/kill text named only a count, never what the processes actually were — the
// 54-descendant false-kill this closes could not be diagnosed after the fact from the log
// line alone. `summarizeDescendants()` turns a descendant pid set into a short, human
// breakdown by executable name (`snapshot.commOf`, from `parsePsOutput()`'s `comm=` column),
// most-frequent first, collapsing the long tail into a single "N other" bucket. Returns ''
// when there's no comm data (e.g. a snapshot from a `ps` invocation that didn't request it).
function summarizeDescendants(snapshot, pids, limit = 4) {
  if (!snapshot || !snapshot.commOf || !pids || !pids.size) return '';
  const counts = new Map();
  for (const pid of pids) {
    const name = snapshot.commOf.get(pid);
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if (!counts.size) return '';
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, limit).map(([name, n]) => `${name} ×${n}`);
  const restCount = sorted.slice(limit).reduce((sum, [, n]) => sum + n, 0);
  if (restCount > 0) top.push(`${restCount} other`);
  return top.join(', ');
}

// Single source of the "when does the watchdog act" wording, shared by the warn notice
// (buildRunawayWarning) and the pause/kill reasons (terminal-session.js's
// pauseRunawaySession/killRunawaySession) so the texts can never drift out of sync with the
// actual policy constants. The memory clause is left out when there is no memory limit.
function describeActPolicy(threshold, { growth = DESCENDANT_KILL_GROWTH, ceiling = DESCENDANT_CEILING_FACTOR * threshold, limitMb = 0, ...options } = {}) {
  const countRule = `after ${DESCENDANT_KILL_CONSECUTIVE} consecutive checks ≥${threshold} each growing by `
    + `≥${growth}, or immediately at ≥${ceiling}`;
  if (!limitMb) return countRule;
  const p = enforcementLimits({ maxTreeRssMb: limitMb, ...options });
  return `${countRule} processes, or once RSS stays >${p.rssActionMb} MiB for ${p.rssSamples} 30-second samples `
    + `and grows by ≥${p.rssGrowthMb} MiB in each of two intervals `
    + `(≥${p.rssPressureGrowthMb} MiB with sustained host memory pressure)`;
}

function describeRunawayReason(reason) {
  return ({
    'count-growth': 'sustained process-count growth',
    'count-ceiling': 'process emergency ceiling reached',
    'memory-growth': 'sustained high RSS and memory growth',
    'memory-pressure': 'sustained high RSS, host memory pressure, and growth in this tree',
    count: 'descendant warning threshold reached',
    memory: 'RSS warning threshold reached',
  })[reason] || 'resource watchdog intervention';
}

function describeKillPolicy(threshold, growth = DESCENDANT_KILL_GROWTH, ceiling = DESCENDANT_KILL_CEILING, limitMb = 0) {
  return `kill ${describeActPolicy(threshold, { growth, ceiling, limitMb })}`;
}

// "N descendant processes" / "N descendant processes using M MB" — the tree figures every
// watchdog text and log line names.
function describeTree(count, rssMb) {
  return `${count} descendant processes${rssMb > 0 ? ` using ${rssMb} MiB` : ''}`;
}

// The warn notice. `action` (resolveAgentLimits().watchdogAction) decides the closing
// sentence, so the user reads what will actually happen next rather than a fixed threat.
function buildRunawayWarning(count, threshold, summary, { rssMb = 0, limitMb = 0, action = 'warn', reason = 'count', activeCount, policy = {}, advisoryDescendants, advisoryTreeRssMb } = {}) {
  const head = reason === 'memory' && limitMb > 0
    ? `This session's process tree uses ${rssMb} MiB; RSS warning threshold ${limitMb} MiB (${count} descendant processes)`
    : `${describeTree(count, rssMb)} under this session`;
  const policyText = describeActPolicy(threshold, { limitMb, action, ...policy });
  let next;
  if (action === 'kill') next = `Automatic termination enabled (kill ${policyText}).`;
  else if (action === 'pause') next = `The watchdog will pause it — nothing is killed and it can be resumed — ${policyText}.`;
  else next = 'The watchdog only warns: automatic pause and termination are disabled.';
  const load = activeCount == null ? '' : ` ${activeCount} ${activeCount === 1 ? 'session' : 'sessions'} active.`;
  const advisory = advisoryDescendants == null ? '' : ` Advisory concurrency budgets: ${advisoryDescendants} descendants, ${advisoryTreeRssMb} MiB; these do not trigger intervention.`;
  const base = `${head} — ${describeRunawayReason(reason)}; the session keeps running.${load}${advisory} ${next}`;
  return summary ? `${base} Top processes: ${summary}.` : base;
}

// ── Watchdog sweep body (TPT370) ──
//
// One tick of the 30s watchdog, extracted from index.js so it can be exercised with fake
// sessions and stubbed side effects instead of the real WS/pty stack. `sessions` is any
// iterable of `[key, session]` pairs (the live `sessions` Map). Deps are injected:
// `resolveLimits(projectPath)` (resolveAgentLimits — read once per project per sweep, so a
// config change reaches running sessions at the next tick), `killRunawaySession`/
// `pauseRunawaySession`/`emitTerminalNotice` (terminal-session.js), `emitSessionRunaway`
// (websocket.js), `log` (default console.warn). Without `resolveLimits` the sweep is
// warn-only. Never throws — a bad session shape is skipped, same fail-soft spirit as the
// rest of this module.
function sweepDescendantWatchdog(sessions, snapshot, { resolveLimits, killRunawaySession, pauseRunawaySession, emitTerminalNotice, emitSessionRunaway, host = null, sampledAt = Date.now(), log = console.warn } = {}) {
  if (!snapshot) return;
  // Snapshot the iterable so a one-shot iterator works too. Count once, before any
  // action changes a session's alive flag, across every project in the registry.
  const entries = Array.from(sessions);
  const activeCount = countActiveAgentSessions(entries);
  const limitsByProject = new Map();
  const limitsFor = (projectPath) => {
    const key = projectPath || '';
    if (!limitsByProject.has(key)) {
      let limits = null;
      try { limits = typeof resolveLimits === 'function' ? resolveLimits(projectPath) : null; } catch { limits = null; }
      limitsByProject.set(key, limits ? scaleAgentLimitsForConcurrency(limits, activeCount) : {});
    }
    return limitsByProject.get(key);
  };
  for (const [, session] of entries) {
    if (!session || session.type !== 'terminal' || !session.alive || !session.ptyPid) continue;
    const state = session.descendantWatchdog;
    if (!state) continue;
    const limits = limitsFor(session.projectPath);
    const limitMb = parseLimitInt(limits.maxTreeRssMb) || 0;
    const action = parseWatchdogAction(limits.watchdogAction) || 'warn';
    const descendants = listDescendants(snapshot, session.ptyPid);
    const summary = summarizeDescendants(snapshot, descendants);
    // A missing root or any missing RSS makes memory unknown, not zero. Count still works.
    const completeRss = snapshot.parents.has(session.ptyPid) && [session.ptyPid, ...descendants].every(pid => Number.isFinite(snapshot.rssOf?.get(pid)));
    const treeRssMb = completeRss ? sumTreeRss(snapshot, session.ptyPid, descendants) / 1024 : null;
    const thresholdForNotice = parseLimitInt(limits.warnDescendants) || state.threshold || DESCENDANT_ALERT_THRESHOLD;
    const policy = enforcementLimits({ ...limits, warnDescendants: thresholdForNotice });
    policy.ceiling = parseLimitInt(limits.descendantCeiling) || state.killCeiling || policy.descendantCeiling;
    if (state.resumeBase) {
      policy.ceiling = Math.max(policy.ceiling, (state.resumeBase.count || 0) + thresholdForNotice);
      if (limitMb) policy.rssActionMb = Math.max(policy.rssActionMb,
        (state.resumeBase.rssMb || 0) + Math.ceil(limitMb * RESUME_RSS_GRACE_FRACTION));
    }
    const { alert, pause, kill, count, rssMb, reason } = evaluateRunaway(state, { count: descendants.size, rssMb: treeRssMb, sampledAt, host }, limits);
    const threshold = state.threshold;
    const label = session.taskId || session.tabId;
    const figures = `${describeTree(count, rssMb)} (warn ≥${threshold}${limitMb ? `, RSS warning ${limitMb} MiB` : ''}; ${activeCount} ${activeCount === 1 ? 'session' : 'sessions'} active)`;
    const top = summary ? ` Top processes: ${summary}.` : '';
    const detail = { taskId: session.tabId, pid: session.ptyPid, count, threshold, rssMb, limitMb, reason };
    if (kill) {
      log(`[watchdog] Task ${label}: ${figures} — ${describeRunawayReason(reason)}; killing process tree.${top}`);
      const killed = killRunawaySession(session, { count, threshold, rssMb, limitMb, reason, snapshot, summary, policy });
      if (killed && killed.first) {
        emitSessionRunaway(session.projectPath, { ...detail, promptText: killed.text, killed: true });
      }
      continue;
    }
    let warn = alert;
    if (pause) {
      const paused = typeof pauseRunawaySession === 'function'
        ? pauseRunawaySession(session, { count, threshold, rssMb, limitMb, reason, snapshot, summary, policy })
        : null;
      if (paused) {
        if (paused.first) {
          log(`[watchdog] Task ${label}: ${figures} — ${describeRunawayReason(reason)}; pausing process tree (SIGSTOP).${top}`);
          emitSessionRunaway(session.projectPath, { ...detail, promptText: paused.text, paused: true });
        }
        continue;
      }
      // Nothing could be signaled (the tree is already gone, or no POSIX process groups):
      // drop the latch so the next sweep judges afresh, and say so once instead of silently.
      state.paused = false;
      warn = !state.pauseFailed;
      state.pauseFailed = true;
    }
    if (!warn) continue;
    log(`[watchdog] Task ${label}: ${figures} — ${describeRunawayReason(reason)}.`);
    const noticeText = buildRunawayWarning(count, threshold, summary, { rssMb, limitMb, action, reason: reason || 'count', activeCount, policy, advisoryDescendants: limits.advisoryDescendants, advisoryTreeRssMb: limits.advisoryTreeRssMb });
    emitTerminalNotice(session, noticeText);
    emitSessionRunaway(session.projectPath, { ...detail, promptText: noticeText });
  }
}

// ── Tree signaling ──
//
// killProcessGroup(rootPid) alone misses a subtree that called setsid()/spawned
// `detached` — it leads its own group, so a -rootPid signal never reaches it. The plan is:
//   - group-signal rootPid (the pty leader's group),
//   - group-signal every distinct pgid LED BY a descendant (pgid is itself a descendant pid),
//   - signal any remaining descendant, sitting in a group nobody above owns, by pid alone.
// resolveTreeTargets() resolves that plan to a `{ pgids, pids }` set and signalTargets()
// delivers a signal to it — SIGTERM/SIGKILL for a kill, SIGSTOP/SIGCONT for pause/resume.
// Every signal goes through the same never-refuse-to-be-wrong guards as killProcessGroup():
// never a pid <= 1, our own pid, or our own process group. Never throws.
function ownPgrp() {
  if (typeof process.getpgrp !== 'function') return null;
  try { return process.getpgrp(); } catch { return null; }
}

function signalPid(pid, signal) {
  if (!pid || pid <= 1) return false;
  if (pid === process.pid || pid === ownPgrp()) return false;
  try {
    process.kill(pid, signal || 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

// Signals a `{ pgids, pids }` target set and returns the subset that was actually
// signaled. Split out of killProcessTree() so the SIGKILL follow-up can hit the exact
// same set the SIGTERM pass resolved, without a second ps snapshot.
function signalTargets(targets, signal) {
  const signaled = { pgids: [], pids: [], signaled: false };
  if (process.platform === 'win32' || !targets) return signaled;
  for (const pgid of (targets.pgids || [])) {
    if (killProcessGroup(pgid, signal)) signaled.pgids.push(pgid);
  }
  for (const pid of (targets.pids || [])) {
    if (signalPid(pid, signal)) signaled.pids.push(pid);
  }
  signaled.signaled = signaled.pgids.length > 0 || signaled.pids.length > 0;
  return signaled;
}

// The `{ pgids, pids }` a whole-tree signal must reach (see the plan above). A null snapshot
// still yields rootPid's own group — the leader-only fallback shape. Never throws.
function resolveTreeTargets(snapshot, rootPid) {
  try {
    if (!rootPid) return { pgids: [], pids: [] };
    const descendants = listDescendants(snapshot, rootPid);
    const pgids = new Set([rootPid]);
    for (const pid of descendants) {
      const pgid = snapshot.pgidOf && snapshot.pgidOf.get(pid);
      if (pgid !== undefined && descendants.has(pgid)) pgids.add(pgid);
    }
    // Descendants already covered by one of the group signals above need no pid-only signal.
    const pids = [];
    for (const pid of descendants) {
      const pgid = snapshot.pgidOf && snapshot.pgidOf.get(pid);
      if (pgids.has(pgid)) continue;
      pids.push(pid);
    }
    return { pgids: [...pgids], pids };
  } catch {
    return { pgids: [], pids: [] };
  }
}

function killProcessTree(snapshot, rootPid, signal) {
  return signalTargets(resolveTreeTargets(snapshot, rootPid), signal || 'SIGTERM');
}

module.exports = {
  DESCENDANT_ALERT_THRESHOLD,
  DESCENDANT_KILL_CONSECUTIVE,
  DESCENDANT_KILL_GROWTH,
  DESCENDANT_KILL_CEILING,
  RSS_WARN_FRACTION,
  WATCHDOG_INTERVAL_MS,
  enforcementLimits,
  RSS_PAUSE_CONSECUTIVE,
  RSS_PAUSE_FACTOR,
  RESUME_RSS_GRACE_FRACTION,
  WATCHDOG_ACTIONS,
  AGENT_LIMIT_DEFAULTS,
  AGENT_LIMIT_KEYS,
  DEVICE_SESSION_CAP_MAX,
  computeDeviceSessionCap,
  resolveAgentLimits,
  scaleAgentLimitsForConcurrency,
  countActiveAgentSessions,
  killProcessGroup,
  killWindowsProcessTree,
  parsePsOutput,
  snapshotProcesses,
  listDescendants,
  countDescendants,
  sumTreeRss,
  evaluateRunaway,
  summarizeDescendants,
  describeActPolicy,
  describeRunawayReason,
  describeKillPolicy,
  describeTree,
  buildRunawayWarning,
  sweepDescendantWatchdog,
  resolveTreeTargets,
  signalTargets,
  killProcessTree,
};
