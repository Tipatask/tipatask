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
// countDescendants()/evaluateRunaway() back a periodic watchdog (index.js) that first
// raises an attention-style alert. Automatic tree killing is opt-in only, enabled by
// index.js when TIPATASK_WATCHDOG_KILL=1; the default never terminates sessions.

const { execFile } = require('node:child_process');

const DESCENDANT_ALERT_THRESHOLD = 50;
// (TPT370) Warn-then-kill policy, revised after a healthy Codex session (steady ~54
// descendants — Codex keeps a pool of long-lived "unified exec" background terminals open)
// was killed by the old rule (kill on the 2nd consecutive sweep at/above the threshold,
// regardless of trend). A stable or shrinking count at/above the threshold now only ever
// warns. With killEnabled, kill fires on either:
//   - DESCENDANT_KILL_CONSECUTIVE consecutive sweeps that are each at/above the threshold
//     AND rose by at least DESCENDANT_KILL_GROWTH over the sweep before, or
//   - any single sweep at/above DESCENDANT_KILL_CEILING (3x the warn threshold) — unchanged,
//     for a fork bomb that never gives the growth rule two sweeps to observe it.
const DESCENDANT_KILL_CONSECUTIVE = 2;
const DESCENDANT_KILL_GROWTH = 10;
const DESCENDANT_KILL_CEILING = 150;
const PS_ARGS = ['-Ao', 'pgid=,pid=,ppid=,stat=,comm='];
const PS_TIMEOUT_MS = 5000;

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
// `text` is the raw stdout of `ps -Ao pgid=,pid=,ppid=,stat=,comm=` — no header (the
// trailing `=` on each field suppresses it), ragged leading whitespace exactly as real `ps`
// emits it. `comm` is last and may itself contain spaces (e.g. "Google Chrome Helper"), so
// everything from the 4th token on is rejoined as one field. A row is also accepted with
// only the first 3 numeric columns (legacy fixtures / a `ps` invocation without stat/comm) —
// `stat`/`comm` are then left undefined for that pid.
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
    const stat = parts[3];
    if (stat && stat[0] === 'Z') continue; // zombie — already exited, no resources, no children
    if (!byPgid.has(pgid)) byPgid.set(pgid, []);
    byPgid.get(pgid).push(pid);
    parents.set(pid, ppid);
    pgidOf.set(pid, pgid);
    if (parts.length > 4) {
      const comm = parts.slice(4).join(' ');
      const base = comm.slice(comm.lastIndexOf('/') + 1);
      commOf.set(pid, base || comm);
    }
  }
  return { byPgid, parents, pgidOf, commOf };
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

// Pure decision function over a session's watchdog state (session-state.js's
// `descendantWatchdog` shape: { pid, lastCount, lastAlertCount, threshold, alerted,
// growthStreak, killed }). Returns { alert, kill, count }: `alert` = warn now, `kill` =
// terminate the tree now. killEnabled defaults to false; warning state still advances.
// (TPT370) Warn-then-kill, growth-gated: a sweep only counts toward `growthStreak` when it
// is at/above `threshold` AND rose by at least DESCENDANT_KILL_GROWTH over the PREVIOUS
// sweep (which must itself have been at/above threshold — `state.lastCount` going in). A
// steady or shrinking count above threshold — e.g. a healthy session that just keeps a lot
// of long-lived helper processes open — resets the streak to 0 and only ever warns. `kill`
// fires once `growthStreak` reaches DESCENDANT_KILL_CONSECUTIVE, or at once at/above the
// ceiling (a fast fork bomb never gets two sweeps for the growth rule to see). The very
// first sample of a session (`lastCount` starts at 0) can never itself count as growth, so
// a session spawning already busy cannot trigger a kill on its first sweep. Once `kill`
// fires, `state.killed` latches true — every later sweep of a still-alive session reports
// `kill` again regardless of what the count does next, so a tree that survives the signal
// keeps getting re-signaled.
// The warn side re-alerts on continued growth rather than latching once (same spirit as
// broadcastAttentionFor()'s _attentionLastBroadcast dedup in index.js), and resets the
// alerted latch once the count falls back under half the threshold so a genuine build
// spike that resolves can trip the alert again later instead of going silent forever.
function evaluateRunaway(state, count, { killEnabled = false } = {}) {
  const threshold = state.threshold || DESCENDANT_ALERT_THRESHOLD;
  const grew = count >= threshold && state.lastCount >= threshold
    && count - state.lastCount >= DESCENDANT_KILL_GROWTH;
  state.growthStreak = grew ? (state.growthStreak || 0) + 1 : 0;
  let alert = false;
  if (count >= threshold && (!state.alerted || count - state.lastAlertCount >= threshold)) {
    alert = true;
    state.alerted = true;
    state.lastAlertCount = count;
  } else if (count < threshold / 2) {
    state.alerted = false;
  }
  if (!killEnabled) {
    state.killed = false;
  } else if (!state.killed) {
    state.killed = count >= (state.killCeiling || DESCENDANT_KILL_CEILING)
      || state.growthStreak >= DESCENDANT_KILL_CONSECUTIVE;
  }
  const kill = state.killed === true;
  if (kill) alert = false;
  state.lastCount = count;
  return { alert, kill, count };
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

// Single source of the warn-then-kill wording, shared by the warn notice
// (buildRunawayWarning) and the kill reason (terminal-session.js's killRunawaySession) so
// the two texts can never drift out of sync with the actual policy constants.
function describeKillPolicy(threshold, growth = DESCENDANT_KILL_GROWTH, ceiling = DESCENDANT_KILL_CEILING) {
  return `kill after ${DESCENDANT_KILL_CONSECUTIVE} consecutive checks ≥${threshold} each growing by `
    + `≥${growth}, or immediately at ≥${ceiling}`;
}

function buildRunawayWarning(count, threshold, summary, { killEnabled = false } = {}) {
  const base = `${count} descendant processes under this session — possible runaway; the `
    + `session keeps running. `
    + (killEnabled
      ? `Automatic termination enabled (${describeKillPolicy(threshold)}).`
      : `Automatic termination is disabled.`);
  return summary ? `${base} Top processes: ${summary}.` : base;
}

// ── Watchdog sweep body (TPT370) ──
//
// One tick of the 30s descendant-count watchdog, extracted from index.js so it can be
// exercised with fake sessions and stubbed side effects instead of the real WS/pty stack.
// `sessions` is any iterable of `[key, session]` pairs (the live `sessions` Map). Deps are
// injected: `killRunawaySession`/`emitTerminalNotice` (terminal-session.js),
// `emitSessionRunaway` (websocket.js), `log` (default console.warn). Never throws — a bad
// session shape is skipped, same fail-soft spirit as the rest of this module.
function sweepDescendantWatchdog(sessions, snapshot, { killEnabled = false, killRunawaySession, emitTerminalNotice, emitSessionRunaway, log = console.warn } = {}) {
  for (const [, session] of sessions) {
    if (!session || session.type !== 'terminal' || !session.alive || !session.ptyPid) continue;
    const state = session.descendantWatchdog;
    if (!state) continue;
    const descendants = listDescendants(snapshot, session.ptyPid);
    const summary = summarizeDescendants(snapshot, descendants);
    const { alert, kill, count } = evaluateRunaway(state, descendants.size, { killEnabled });
    const label = session.taskId || session.tabId;
    if (kill) {
      log(`[watchdog] Task ${label}: ${count} descendant processes (threshold ${state.threshold}) `
        + `— killing process tree.${summary ? ` Top processes: ${summary}.` : ''}`);
      const killed = killRunawaySession(session, { count, threshold: state.threshold, snapshot, summary });
      if (killed && killed.first) {
        emitSessionRunaway(session.projectPath, { taskId: session.tabId, pid: session.ptyPid, count, threshold: state.threshold, promptText: killed.text, killed: true });
      }
      continue;
    }
    if (!alert) continue;
    log(`[watchdog] Task ${label}: ${count} descendant processes (threshold ${state.threshold}) — possible runaway.`);
    const noticeText = buildRunawayWarning(count, state.threshold, summary, { killEnabled });
    emitTerminalNotice(session, noticeText);
    emitSessionRunaway(session.projectPath, { taskId: session.tabId, pid: session.ptyPid, count, threshold: state.threshold, promptText: noticeText });
  }
}

// ── Tree kill ──
//
// killProcessGroup(rootPid) alone misses a subtree that called setsid()/spawned
// `detached` — it leads its own group, so a -rootPid signal never reaches it. The plan is:
//   - group-kill rootPid (the pty leader's group),
//   - group-kill every distinct pgid LED BY a descendant (pgid is itself a descendant pid),
//   - signal any remaining descendant, sitting in a group nobody above owns, by pid alone.
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

function killProcessTree(snapshot, rootPid, signal) {
  const sig = signal || 'SIGTERM';
  try {
    if (!rootPid) return { pgids: [], pids: [], signaled: false };
    const descendants = listDescendants(snapshot, rootPid);
    const pgids = new Set([rootPid]);
    for (const pid of descendants) {
      const pgid = snapshot.pgidOf && snapshot.pgidOf.get(pid);
      if (pgid !== undefined && descendants.has(pgid)) pgids.add(pgid);
    }
    // Descendants already covered by one of the group kills above need no pid-only signal.
    const pids = [];
    for (const pid of descendants) {
      const pgid = snapshot.pgidOf && snapshot.pgidOf.get(pid);
      if (pgids.has(pgid)) continue;
      pids.push(pid);
    }
    return signalTargets({ pgids: [...pgids], pids }, sig);
  } catch {
    return { pgids: [], pids: [], signaled: false };
  }
}

module.exports = {
  DESCENDANT_ALERT_THRESHOLD,
  DESCENDANT_KILL_CONSECUTIVE,
  DESCENDANT_KILL_GROWTH,
  DESCENDANT_KILL_CEILING,
  killProcessGroup,
  parsePsOutput,
  snapshotProcesses,
  listDescendants,
  countDescendants,
  evaluateRunaway,
  summarizeDescendants,
  describeKillPolicy,
  buildRunawayWarning,
  sweepDescendantWatchdog,
  signalTargets,
  killProcessTree,
};
