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

const { execFile } = require('node:child_process');
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
// Memory side of the same policy, measured against resolveAgentLimits().maxTreeRssMb (the
// summed RSS of the pty leader and every descendant — sumTreeRss()):
//   - warn at the limit;
//   - in pause mode, act after three consecutive sweeps above twice the limit;
//   - explicit kill mode retains its two sweeps at the limit or immediate 1.5x rule;
//   - after the user resumes a paused session, act again only on further growth of
//     RESUME_RSS_GRACE_FRACTION of the limit, so a resume is not undone by the next sweep.
const RSS_WARN_FRACTION = 1;
const RSS_ACT_CONSECUTIVE = 2;
const RSS_ACT_IMMEDIATE_FACTOR = 1.5;
const RSS_PAUSE_CONSECUTIVE = 3;
const RSS_PAUSE_FACTOR = 2;
const RESUME_RSS_GRACE_FRACTION = 0.25;
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
  watchdogAction: 'pause',
});
const AGENT_LIMIT_KEYS = Object.freeze({
  maxConcurrentSessions: 'AGENT_LIMITS_MAX_CONCURRENT_SESSIONS',
  maxSubagents: 'AGENT_LIMITS_MAX_SUBAGENTS',
  warnDescendants: 'AGENT_LIMITS_WARN_DESCENDANTS',
  maxTreeRssMb: 'AGENT_LIMITS_MAX_TREE_RSS_MB',
  watchdogAction: 'AGENT_LIMITS_WATCHDOG_ACTION',
});

// (TPT444) Parallel-session cap derived from the machine, so a 48GB Mac runs many sessions
// while a small/slow one still stays responsive. Pure; `sessionBudgetMb` is the same
// maxTreeRssMb the watchdog enforces per session tree, so N sessions x budget + reserve <= RAM.
//   reserve  = max(6GB, 20% of RAM) kept for the OS, the Task App and the user's other apps
//   ramSlots = floor((RAM - reserve) / budget)
//   cpuSlots = cores — sessions mostly wait on the model, but build/test bursts are CPU-bound
// Clamped to [1, DEVICE_SESSION_CAP_MAX]; unreadable hardware numbers fall back to 1 slot.
const DEVICE_SESSION_CAP_MAX = 32;
const DEVICE_RESERVE_MIN_MB = 6144;
const DEVICE_RESERVE_FRACTION = 0.2;

function computeDeviceSessionCap({ totalMemBytes, cores, sessionBudgetMb } = {}) {
  const totalMb = Number(totalMemBytes) / (1024 * 1024);
  const budget = Number(sessionBudgetMb) > 0 ? Number(sessionBudgetMb) : AGENT_LIMIT_DEFAULTS.maxTreeRssMb;
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
  // (TPT444) Hardware-derived device cap; an explicit value can only lower it, never raise it
  // above what the machine can carry. `sessionCapSource` tells the start queue whether the
  // project set its own (per-project) cap.
  const hw = hardware || detectHardware();
  const deviceSessionCap = computeDeviceSessionCap({ ...hw, sessionBudgetMb: out.maxTreeRssMb });
  const capKey = AGENT_LIMIT_KEYS.maxConcurrentSessions;
  const envCap = parseLimitInt(envVars[capKey]);
  const cfgCap = envCap === null ? parseLimitInt(cfg && cfg[capKey]) : null;
  const explicitCap = envCap ?? cfgCap;
  out.maxConcurrentSessions = explicitCap === null ? deviceSessionCap : Math.min(explicitCap, deviceSessionCap);
  out.deviceSessionCap = deviceSessionCap;
  out.sessionCapSource = envCap !== null ? 'env' : (cfgCap !== null ? 'config' : 'device');
  const actionKey = AGENT_LIMIT_KEYS.watchdogAction;
  out.watchdogAction = parseWatchdogAction(envVars[actionKey])
    ?? (envVars.TIPATASK_WATCHDOG_KILL === '1' ? 'kill' : null)
    ?? parseWatchdogAction(cfg && cfg[actionKey])
    ?? AGENT_LIMIT_DEFAULTS.watchdogAction;
  return out;
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

// Pure decision function over a session's watchdog state (session-state.js's
// `descendantWatchdog` shape: { pid, lastCount, lastAlertCount, threshold, alerted,
// growthStreak, rssStreak, rssAlerted, lastAlertRssMb, paused, killed, actReason,
// resumeBase }).
//   sample — { count, rssMb } for this sweep; a bare number is a count with no memory figure.
//   limits — resolveAgentLimits()'s { warnDescendants, maxTreeRssMb, watchdogAction }.
//            Omitted fields fall back to `state.threshold`, "no memory limit", and 'warn':
//            a caller that passes no limits can never pause or kill anything.
// Returns { alert, pause, kill, count, rssMb, reason }: `alert` = warn now, `pause` = stop
// the tree now, `kill` = terminate the tree now; `reason` ('memory' | 'count' | null) names
// what fired.
//
// Count side — warn-then-act, growth-gated: a sweep only counts toward `growthStreak` when
// it is at/above `threshold` AND rose by at least DESCENDANT_KILL_GROWTH over the PREVIOUS
// sweep (which must itself have been at/above threshold — `state.lastCount` going in). A
// steady or shrinking count above threshold — e.g. a healthy session that just keeps a lot
// of long-lived helper processes open — resets the streak to 0 and only ever warns. The
// count rule is violated once `growthStreak` reaches DESCENDANT_KILL_CONSECUTIVE, or at once
// at/above the ceiling (a fast fork bomb never gets two sweeps for the growth rule to see).
// The very first sample of a session (`lastCount` starts at 0) can never itself count as
// growth, so a session spawning already busy cannot be acted on at its first sweep.
//
// Memory side — warn at the budget. Pause only after three sweeps above twice it;
// explicit kill mode retains the earlier two-sweep/1.5x thresholds.
//
// Action on a violation follows `watchdogAction`: 'warn' reports nothing beyond the warnings,
// 'pause' latches `state.paused`, 'kill' latches `state.killed`. A latched state reports its
// action again on every later sweep whatever the numbers do next, so a tree member that
// escaped the signal is signaled again; `alert` is forced false on those sweeps. Only
// terminal-session.js's resumeRunawaySession() clears the pause latch. It also stamps
// `state.resumeBase = { count, rssMb }`, and while that is set the watchdog acts again only
// on FRESH growth past it (memory up by RESUME_RSS_GRACE_FRACTION of the limit, count up by
// another full threshold, or a new growth streak) — otherwise the tree the user just
// resumed, still over the limit, would be stopped again at the next sweep. The base is
// dropped once the tree is back under both the memory limit and the count ceiling.
//
// The warn side re-alerts on continued growth rather than latching once (same spirit as
// broadcastAttentionFor()'s _attentionLastBroadcast dedup in index.js), and resets its
// latches once the figure falls back under half the warn mark so a genuine build spike that
// resolves can trip the alert again later instead of going silent forever.
function evaluateRunaway(state, sample, limits = {}) {
  const isBare = typeof sample === 'number';
  const count = (isBare ? sample : Number(sample && sample.count)) || 0;
  const rssMb = (isBare ? 0 : Number(sample && sample.rssMb)) || 0;
  const opts = limits || {};
  const threshold = parseLimitInt(opts.warnDescendants) || state.threshold || DESCENDANT_ALERT_THRESHOLD;
  const limitMb = parseLimitInt(opts.maxTreeRssMb) || 0;
  const action = parseWatchdogAction(opts.watchdogAction) || 'warn';
  const base = state.resumeBase || null;

  // ── count ──
  const grew = count >= threshold && state.lastCount >= threshold
    && count - state.lastCount >= DESCENDANT_KILL_GROWTH;
  state.growthStreak = grew ? (state.growthStreak || 0) + 1 : 0;
  const ceiling = state.killCeiling || DESCENDANT_CEILING_FACTOR * threshold;
  const actCeiling = base ? Math.max(ceiling, (base.count || 0) + threshold) : ceiling;
  const countViolation = count >= actCeiling || state.growthStreak >= DESCENDANT_KILL_CONSECUTIVE;

  // ── memory ──
  const actMb = base && limitMb
    ? Math.max(limitMb, (base.rssMb || 0) + Math.ceil(limitMb * RESUME_RSS_GRACE_FRACTION))
    : limitMb;
  const pauseMb = Math.max(limitMb * RSS_PAUSE_FACTOR, actMb);
  const aboveActionThreshold = limitMb > 0 && (action === 'pause'
    ? rssMb > pauseMb : rssMb >= actMb);
  state.rssStreak = aboveActionThreshold ? (state.rssStreak || 0) + 1 : 0;
  const memoryViolation = limitMb > 0 && (action === 'pause'
    ? state.rssStreak >= RSS_PAUSE_CONSECUTIVE
    : state.rssStreak >= RSS_ACT_CONSECUTIVE
      || rssMb >= Math.max(limitMb * RSS_ACT_IMMEDIATE_FACTOR, actMb));

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
    } else if (rssMb < warnMb / 2) {
      state.rssAlerted = false;
    }
  }

  // ── action ──
  const violation = memoryViolation ? 'memory' : (countViolation ? 'count' : null);
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
  if (base && (limitMb === 0 || rssMb < limitMb) && count < ceiling) state.resumeBase = null;
  state.lastCount = count;
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
function describeActPolicy(threshold, { growth = DESCENDANT_KILL_GROWTH, ceiling = DESCENDANT_CEILING_FACTOR * threshold, limitMb = 0, action = 'kill' } = {}) {
  const countRule = `after ${DESCENDANT_KILL_CONSECUTIVE} consecutive checks ≥${threshold} each growing by `
    + `≥${growth}, or immediately at ≥${ceiling}`;
  if (!limitMb) return countRule;
  if (action === 'pause') return `${countRule} processes, or once memory stays >${limitMb * RSS_PAUSE_FACTOR} MB for ${RSS_PAUSE_CONSECUTIVE} checks`;
  return `${countRule} processes, or once memory stays ≥${limitMb} MB for ${RSS_ACT_CONSECUTIVE} checks `
    + `(immediately at ≥${Math.round(limitMb * RSS_ACT_IMMEDIATE_FACTOR)} MB)`;
}

function describeKillPolicy(threshold, growth = DESCENDANT_KILL_GROWTH, ceiling = DESCENDANT_KILL_CEILING, limitMb = 0) {
  return `kill ${describeActPolicy(threshold, { growth, ceiling, limitMb })}`;
}

// "N descendant processes" / "N descendant processes using M MB" — the tree figures every
// watchdog text and log line names.
function describeTree(count, rssMb) {
  return `${count} descendant processes${rssMb > 0 ? ` using ${rssMb} MB` : ''}`;
}

// The warn notice. `action` (resolveAgentLimits().watchdogAction) decides the closing
// sentence, so the user reads what will actually happen next rather than a fixed threat.
function buildRunawayWarning(count, threshold, summary, { rssMb = 0, limitMb = 0, action = 'warn', reason = 'count' } = {}) {
  const head = reason === 'memory' && limitMb > 0
    ? `This session's process tree uses ${rssMb} MB of its ${limitMb} MB memory limit (${count} descendant processes)`
    : `${describeTree(count, rssMb)} under this session`;
  const policy = describeActPolicy(threshold, { limitMb, action });
  let next;
  if (action === 'kill') next = `Automatic termination enabled (kill ${policy}).`;
  else if (action === 'pause') next = `The watchdog will pause it — nothing is killed and it can be resumed — ${policy}.`;
  else next = 'The watchdog only warns: automatic pause and termination are disabled.';
  const base = `${head} — ${reason === 'memory' ? 'memory budget reached' : 'possible runaway'}; the session keeps running. ${next}`;
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
function sweepDescendantWatchdog(sessions, snapshot, { resolveLimits, killRunawaySession, pauseRunawaySession, emitTerminalNotice, emitSessionRunaway, log = console.warn } = {}) {
  const limitsByProject = new Map();
  const limitsFor = (projectPath) => {
    const key = projectPath || '';
    if (!limitsByProject.has(key)) {
      let limits = null;
      try { limits = typeof resolveLimits === 'function' ? resolveLimits(projectPath) : null; } catch { limits = null; }
      limitsByProject.set(key, limits || {});
    }
    return limitsByProject.get(key);
  };
  for (const [, session] of sessions) {
    if (!session || session.type !== 'terminal' || !session.alive || !session.ptyPid) continue;
    const state = session.descendantWatchdog;
    if (!state) continue;
    const limits = limitsFor(session.projectPath);
    const warnDescendants = parseLimitInt(limits.warnDescendants);
    if (warnDescendants) state.threshold = warnDescendants;
    const limitMb = parseLimitInt(limits.maxTreeRssMb) || 0;
    const action = parseWatchdogAction(limits.watchdogAction) || 'warn';
    const descendants = listDescendants(snapshot, session.ptyPid);
    const summary = summarizeDescendants(snapshot, descendants);
    const treeRssMb = Math.round(sumTreeRss(snapshot, session.ptyPid, descendants) / 1024);
    const { alert, pause, kill, count, rssMb, reason } = evaluateRunaway(state, { count: descendants.size, rssMb: treeRssMb }, limits);
    const threshold = state.threshold;
    const label = session.taskId || session.tabId;
    const figures = `${describeTree(count, rssMb)} (warn ≥${threshold}${limitMb ? `, limit ${limitMb} MB` : ''})`;
    const top = summary ? ` Top processes: ${summary}.` : '';
    const detail = { taskId: session.tabId, pid: session.ptyPid, count, threshold, rssMb, limitMb, reason };
    if (kill) {
      log(`[watchdog] Task ${label}: ${figures} — killing process tree.${top}`);
      const killed = killRunawaySession(session, { count, threshold, rssMb, limitMb, reason, snapshot, summary });
      if (killed && killed.first) {
        emitSessionRunaway(session.projectPath, { ...detail, promptText: killed.text, killed: true });
      }
      continue;
    }
    let warn = alert;
    if (pause) {
      const paused = typeof pauseRunawaySession === 'function'
        ? pauseRunawaySession(session, { count, threshold, rssMb, limitMb, reason, snapshot, summary })
        : null;
      if (paused) {
        if (paused.first) {
          log(`[watchdog] Task ${label}: ${figures} — pausing process tree (SIGSTOP).${top}`);
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
    log(`[watchdog] Task ${label}: ${figures} — possible runaway.`);
    const noticeText = buildRunawayWarning(count, threshold, summary, { rssMb, limitMb, action, reason: reason || 'count' });
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
  RSS_ACT_CONSECUTIVE,
  RSS_ACT_IMMEDIATE_FACTOR,
  RSS_PAUSE_CONSECUTIVE,
  RSS_PAUSE_FACTOR,
  RESUME_RSS_GRACE_FRACTION,
  WATCHDOG_ACTIONS,
  AGENT_LIMIT_DEFAULTS,
  AGENT_LIMIT_KEYS,
  DEVICE_SESSION_CAP_MAX,
  computeDeviceSessionCap,
  resolveAgentLimits,
  killProcessGroup,
  parsePsOutput,
  snapshotProcesses,
  listDescendants,
  countDescendants,
  sumTreeRss,
  evaluateRunaway,
  summarizeDescendants,
  describeActPolicy,
  describeKillPolicy,
  describeTree,
  buildRunawayWarning,
  sweepDescendantWatchdog,
  resolveTreeTargets,
  signalTargets,
  killProcessTree,
};
