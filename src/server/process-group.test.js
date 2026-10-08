'use strict';

// (C1565) Unit tests for the process-group kill + descendant-count watchdog primitives.
// killProcessGroup()'s guard table never calls the real process.kill — it's exercised via
// a stubbed exec/process seam so this suite can run identically on CI and a dev machine
// without ever signaling anything real. See ai/architecture/tt-claude-session-terminal.md
// § Process-group teardown + descendant watchdog (C1565) for the incident this closes.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DESCENDANT_ALERT_THRESHOLD,
  DESCENDANT_KILL_CONSECUTIVE,
  DESCENDANT_KILL_GROWTH,
  DESCENDANT_KILL_CEILING,
  RSS_WARN_FRACTION,
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
  describeKillPolicy,
  buildRunawayWarning,
  sweepDescendantWatchdog,
  resolveTreeTargets,
  signalTargets,
  killProcessTree,
} = require('./process-group');
const { createSession } = require('./session-state');

// ── createSession() exposes the watchdog fields (task step 2's verification) ──

test('createSession() exposes ptyPid and descendantWatchdog, both initially null', () => {
  const session = createSession({}, false, 'C1', '');
  assert.equal(session.ptyPid, null);
  assert.equal(session.descendantWatchdog, null);
});

// ── killWindowsProcessTree() ──

test('killWindowsProcessTree is a no-op off win32', () => {
  let called = false;
  const spawnSync = () => { called = true; return { status: 0 }; };
  assert.equal(killWindowsProcessTree(4242, { spawnSync, platform: 'darwin' }), false);
  assert.equal(killWindowsProcessTree(4242, { spawnSync, platform: 'linux' }), false);
  assert.equal(called, false);
});

test('killWindowsProcessTree refuses bad pids and its own pid', () => {
  let called = false;
  const spawnSync = () => { called = true; return { status: 0 }; };
  for (const pid of [null, undefined, 0, 1, -5, 12.5, '4242', process.pid]) {
    assert.equal(killWindowsProcessTree(pid, { spawnSync, platform: 'win32' }), false);
  }
  assert.equal(called, false);
});

test('killWindowsProcessTree force-kills the whole tree via taskkill /T /F, synchronously', () => {
  const calls = [];
  const spawnSync = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; };
  assert.equal(killWindowsProcessTree(4242, { spawnSync, platform: 'win32' }), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].cmd, /System32\\taskkill\.exe$/);
  assert.deepEqual(calls[0].args, ['/T', '/F', '/PID', '4242']);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.ok(calls[0].opts.timeout > 0);
});

test('killWindowsProcessTree reports failure without throwing', () => {
  assert.equal(killWindowsProcessTree(4242, { spawnSync: () => ({ status: 128 }), platform: 'win32' }), false);
  assert.equal(killWindowsProcessTree(4242, { spawnSync: () => ({ status: null, error: new Error('ETIMEDOUT') }), platform: 'win32' }), false);
  assert.equal(killWindowsProcessTree(4242, { spawnSync: () => { throw new Error('ENOENT'); }, platform: 'win32' }), false);
});

// ── killProcessGroup() guard table ──

test('killProcessGroup refuses a falsy pid without calling process.kill', () => {
  let called = false;
  const origKill = process.kill;
  process.kill = () => { called = true; };
  try {
    assert.equal(killProcessGroup(null, 'SIGTERM'), false);
    assert.equal(killProcessGroup(undefined, 'SIGTERM'), false);
    assert.equal(killProcessGroup(0, 'SIGTERM'), false);
  } finally {
    process.kill = origKill;
  }
  assert.equal(called, false);
});

test('killProcessGroup refuses pid 1 (never signal init/launchd)', () => {
  let called = false;
  const origKill = process.kill;
  process.kill = () => { called = true; };
  try {
    assert.equal(killProcessGroup(1, 'SIGTERM'), false);
  } finally {
    process.kill = origKill;
  }
  assert.equal(called, false);
});

test('killProcessGroup refuses our own pid', () => {
  let called = false;
  const origKill = process.kill;
  process.kill = () => { called = true; };
  try {
    assert.equal(killProcessGroup(process.pid, 'SIGTERM'), false);
  } finally {
    process.kill = origKill;
  }
  assert.equal(called, false);
});

test('killProcessGroup refuses our own process group', () => {
  if (typeof process.getpgrp !== 'function') return; // win32 has no getpgrp
  let called = false;
  const origKill = process.kill;
  process.kill = () => { called = true; };
  try {
    assert.equal(killProcessGroup(process.getpgrp(), 'SIGTERM'), false);
  } finally {
    process.kill = origKill;
  }
  assert.equal(called, false);
});

test('killProcessGroup refuses on win32 regardless of pid', () => {
  const origPlatform = process.platform;
  let called = false;
  const origKill = process.kill;
  process.kill = () => { called = true; };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.equal(killProcessGroup(99999, 'SIGTERM'), false);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform });
    process.kill = origKill;
  }
  assert.equal(called, false);
});

test('killProcessGroup signals -pid on a plausible foreign pid and returns true', () => {
  let sawArgs = null;
  const origKill = process.kill;
  process.kill = (pid, sig) => { sawArgs = [pid, sig]; };
  try {
    const result = killProcessGroup(99999, 'SIGTERM');
    assert.equal(result, true);
    assert.deepEqual(sawArgs, [-99999, 'SIGTERM']);
  } finally {
    process.kill = origKill;
  }
});

test('killProcessGroup returns false (never throws) when process.kill throws ESRCH', () => {
  const origKill = process.kill;
  process.kill = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
  try {
    assert.equal(killProcessGroup(99999, 'SIGTERM'), false);
  } finally {
    process.kill = origKill;
  }
});

// ── parsePsOutput() ──

test('parsePsOutput parses headerless ragged-whitespace ps rows', () => {
  const text = '    1     1     0\n  337   337     1\n  337   339   337\n';
  const { byPgid, parents } = parsePsOutput(text);
  assert.deepEqual(byPgid.get(1), [1]);
  assert.deepEqual(byPgid.get(337), [337, 339]);
  assert.equal(parents.get(339), 337);
  assert.equal(parents.get(338), undefined); // 338 never appears as its own pid column
});

test('parsePsOutput maps each pid to its pgid', () => {
  const { pgidOf } = parsePsOutput('  337   337     1\n  337   339   337\n  500   501   339\n');
  assert.equal(pgidOf.get(337), 337);
  assert.equal(pgidOf.get(339), 337);
  assert.equal(pgidOf.get(501), 500); // escaped into its own group
  assert.equal(pgidOf.get(999), undefined);
});

test('parsePsOutput skips blank lines and malformed rows', () => {
  const text = '  1  1  0\n\n   garbage line\n  2  2  1\n';
  const { byPgid } = parsePsOutput(text);
  assert.equal(byPgid.get(1)?.length, 1);
  assert.equal(byPgid.get(2)?.length, 1);
});

// ── parsePsOutput() — stat/comm columns (TPT370) ──

test('parsePsOutput maps each pid to a comm basename, and joins a comm containing spaces', () => {
  const text = '  10  10  1  S  node\n  10  11  10  S  /usr/local/bin/node\n'
    + '  10  12  10  S  Google Chrome Helper\n';
  const { commOf } = parsePsOutput(text);
  assert.equal(commOf.get(10), 'node');
  assert.equal(commOf.get(11), 'node'); // basename of a full path
  assert.equal(commOf.get(12), 'Google Chrome Helper'); // no '/' — kept whole, not split on spaces
});

test('parsePsOutput drops zombie rows (stat starting with Z) but keeps their live siblings', () => {
  const text = '  10  10  1  S  bash\n  10  11  10  Z  defunct\n  10  12  10  S  node\n';
  const { byPgid, parents, commOf } = parsePsOutput(text);
  assert.deepEqual(byPgid.get(10), [10, 12]); // 11 excluded
  assert.equal(parents.has(11), false);
  assert.equal(commOf.has(11), false);
  assert.equal(commOf.get(12), 'node');
});

test('parsePsOutput still works on legacy 3-column rows (no stat/comm)', () => {
  const { byPgid, commOf, rssOf } = parsePsOutput('  10  10  1\n  10  11  10\n');
  assert.deepEqual(byPgid.get(10), [10, 11]);
  assert.equal(commOf.size, 0);
  assert.equal(rssOf.size, 0);
});

// ── parsePsOutput() — rss column / sumTreeRss() ──

test('parsePsOutput reads rss (KB) from the column before stat, keeping stat and comm aligned', () => {
  const text = '  10  10  1  204800  Ss  node\n  10  11  10  51200  S  /usr/local/bin/npm\n'
    + '  10  12  10  1024  S  Google Chrome Helper\n  10  13  10  0  Z  defunct\n';
  const { rssOf, commOf, parents } = parsePsOutput(text);
  assert.equal(rssOf.get(10), 204800);
  assert.equal(rssOf.get(11), 51200);
  assert.equal(commOf.get(11), 'npm');
  assert.equal(commOf.get(12), 'Google Chrome Helper');
  assert.equal(parents.has(13), false); // zombie still dropped with the rss column present
  assert.equal(rssOf.has(13), false);
});

test('parsePsOutput leaves rss undefined on rows without the column (stat is never numeric)', () => {
  const { rssOf, commOf } = parsePsOutput('  10  10  1  S  bash\n  10  11  10  S  123\n');
  assert.equal(rssOf.size, 0);
  assert.equal(commOf.get(11), '123'); // a numeric comm is not mistaken for rss
});

test('sumTreeRss adds the root and every descendant, including an escaped subtree, in KB', () => {
  const snapshot = parsePsOutput([
    '  10  10  1  1000  Ss  claude',
    '  10  11  10  200  S  node',
    '  20  20  11  300  Ss  node', // setsid()'d child of 11
    '  20  21  20  50  S  sh',
    '  99  99  1  9999  S  unrelated',
  ].join('\n'));
  assert.equal(sumTreeRss(snapshot, 10), 1550);
  assert.equal(sumTreeRss(snapshot, 10, new Set([11])), 1200); // caller-supplied member set
});

test('sumTreeRss returns 0 without rss data, a snapshot, or a root', () => {
  assert.equal(sumTreeRss(parsePsOutput('  10  10  1\n  10  11  10\n'), 10), 0);
  assert.equal(sumTreeRss(null, 10), 0);
  assert.equal(sumTreeRss(parsePsOutput('  10  10  1  500  S  node\n'), 0), 0);
});

// ── snapshotProcesses() — injectable exec, never spawns a real ps in this suite ──

test('snapshotProcesses resolves parsed output from a stubbed exec', async () => {
  const exec = (cmd, args, opts, cb) => { cb(null, '  5  5  1\n  6  6  5\n'); return { kill() {} }; };
  const snapshot = await snapshotProcesses({ exec });
  assert.deepEqual(snapshot.byPgid.get(5), [5]);
});

test('snapshotProcesses resolves null when exec errors', async () => {
  const exec = (cmd, args, opts, cb) => { cb(new Error('ps not found')); return { kill() {} }; };
  const snapshot = await snapshotProcesses({ exec });
  assert.equal(snapshot, null);
});

test('snapshotProcesses resolves null when exec throws synchronously', async () => {
  const exec = () => { throw new Error('spawn failed'); };
  const snapshot = await snapshotProcesses({ exec });
  assert.equal(snapshot, null);
});

// ── countDescendants() ──

test('countDescendants counts a flat group sharing one pgid, excluding root', () => {
  const snapshot = parsePsOutput('  10  10  1\n  10  11  10\n  10  12  10\n  10  13  10\n');
  assert.equal(countDescendants(snapshot, 10), 3);
});

test('countDescendants counts a 5-deep parent-chain (the incident\'s actual shape)', () => {
  // Each level is its OWN pgid (npm's lifecycle re-exec spawns a fresh process, not
  // necessarily group-preserving) but shares the ppid chain rooted at 10.
  const rows = [
    '  10  10  1',
    '  11  11  10',
    '  12  12  11',
    '  13  13  12',
    '  14  14  13',
  ].join('\n');
  const snapshot = parsePsOutput(rows);
  assert.equal(countDescendants(snapshot, 10), 4);
});

test('countDescendants still counts a descendant that setsid()\'d out of the group, via the ppid tree', () => {
  // pid 11 shares root's pgid; pid 12's parent is 11 but pid 12 escaped into its own
  // group (pgid 12) — group-membership alone would miss it.
  const snapshot = parsePsOutput('  10  10  1\n  10  11  10\n  12  12  11\n');
  assert.equal(countDescendants(snapshot, 10), 2);
});

test('countDescendants returns 0 for an unknown root pid', () => {
  const snapshot = parsePsOutput('  10  10  1\n');
  assert.equal(countDescendants(snapshot, 999999), 0);
});

test('countDescendants excludes the root itself even when it is its own group member', () => {
  const snapshot = parsePsOutput('  10  10  1\n');
  assert.equal(countDescendants(snapshot, 10), 0);
});

test('countDescendants returns 0 for a null snapshot', () => {
  assert.equal(countDescendants(null, 10), 0);
});

// ── listDescendants() ──

test('listDescendants returns the same pids countDescendants counts (group + ppid union)', () => {
  const snapshot = parsePsOutput('  10  10  1\n  10  11  10\n  12  12  11\n  10  13  1\n');
  const listed = listDescendants(snapshot, 10);
  assert.deepEqual([...listed].sort((a, b) => a - b), [11, 12, 13]);
  assert.equal(listed.size, countDescendants(snapshot, 10));
});

test('listDescendants returns an empty set for a null snapshot or unknown root', () => {
  assert.equal(listDescendants(null, 10).size, 0);
  assert.equal(listDescendants(parsePsOutput('  10  10  1\n'), 999999).size, 0);
});

// ── evaluateRunaway() truth table ──

test('evaluateRunaway does not alert below threshold', () => {
  const state = { threshold: 50, lastCount: 0, lastAlertCount: 0, alerted: false };
  const { alert, count } = evaluateRunaway(state, 10);
  assert.equal(alert, false);
  assert.equal(count, 10);
  assert.equal(state.lastCount, 10);
});

test('evaluateRunaway alerts on first crossing the threshold', () => {
  const state = { threshold: 50, lastCount: 40, lastAlertCount: 0, alerted: false };
  const { alert } = evaluateRunaway(state, 51);
  assert.equal(alert, true);
  assert.equal(state.alerted, true);
  assert.equal(state.lastAlertCount, 51);
});

test('evaluateRunaway does not re-alert for a steady count above threshold', () => {
  const state = { threshold: 50, lastCount: 51, lastAlertCount: 51, alerted: true };
  const { alert } = evaluateRunaway(state, 52);
  assert.equal(alert, false);
});

test('evaluateRunaway re-alerts once growth since the last alert reaches another full threshold', () => {
  const state = { threshold: 50, lastCount: 51, lastAlertCount: 51, alerted: true };
  const first = evaluateRunaway(state, 100);
  assert.equal(first.alert, false); // +49, not yet another full threshold
  const second = evaluateRunaway(state, 101); // +1 over the prior sweep — growthStreak resets, no kill
  assert.equal(second.alert, true); // +50 since lastAlertCount
  assert.equal(second.kill, false);
  assert.equal(state.lastAlertCount, 101);
});

test('evaluateRunaway resets the alerted latch once count drops below half the threshold', () => {
  const state = { threshold: 50, lastCount: 60, lastAlertCount: 60, alerted: true };
  const dropped = evaluateRunaway(state, 20);
  assert.equal(dropped.alert, false);
  assert.equal(state.alerted, false);
  // A later re-crossing now alerts again instead of staying latched forever.
  const recrossed = evaluateRunaway(state, 50);
  assert.equal(recrossed.alert, true);
});

test('DESCENDANT_ALERT_THRESHOLD matches the task-specified default (~50)', () => {
  assert.equal(DESCENDANT_ALERT_THRESHOLD, 50);
});

test('DESCENDANT_KILL_* defaults match the warn-then-kill policy', () => {
  assert.equal(DESCENDANT_KILL_CONSECUTIVE, 2);
  assert.equal(DESCENDANT_KILL_GROWTH, 10);
  assert.equal(DESCENDANT_KILL_CEILING, 150);
  assert.equal(DESCENDANT_KILL_CEILING, 3 * DESCENDANT_ALERT_THRESHOLD);
});

// ── evaluateRunaway() warn-then-kill, growth-gated (TPT370) ──
//
// TPT370: a healthy Codex session held a STABLE ~54 descendants (it keeps a pool of
// long-lived "unified exec" background terminals open) and was killed by the old rule —
// kill on the 2nd consecutive sweep at/above the threshold, regardless of trend. The new
// rule only kills on sustained GROWTH (>=10 per sweep, 2 sweeps running) or the hard
// ceiling; a steady or shrinking count above the threshold now only ever warns.

function freshState() {
  return { threshold: 50, lastCount: 0, lastAlertCount: 0, alerted: false, growthStreak: 0, killed: false };
}

// Limits as resolveAgentLimits() returns them; the count-only cases leave the memory limit out.
const KILL = { watchdogAction: 'kill' };
const PAUSE = { watchdogAction: 'pause' };
const LIMIT_MB = 3072;
// Neutral scaling keeps the fixed-budget policy tests independent of concurrency defaults.
const withMemory = (action) => ({ warnDescendants: 50, maxTreeRssMb: LIMIT_MB, watchdogAction: action, soloMultiplier: 1 });

test('evaluateRunaway defaults to warnings through sustained growth and above the ceiling', () => {
  const state = freshState();
  const results = [52, 68, 86, 150, 300].map(count => evaluateRunaway(state, count));
  assert.ok(results.every(result => result.kill === false && result.pause === false));
  assert.deepEqual(results.map(result => result.alert), [true, false, false, true, true]);
  assert.equal(state.killed, false);
});

test('the explicit warn action never pauses or kills, on count or on memory', () => {
  const state = freshState();
  for (const sample of [{ count: 160, rssMb: 100 }, { count: 10, rssMb: 9000 }, { count: 300, rssMb: 9000 }]) {
    const result = evaluateRunaway(state, sample, withMemory('warn'));
    assert.equal(result.kill, false);
    assert.equal(result.pause, false);
  }
  assert.equal(state.paused, undefined);
  assert.equal(state.killed, false);
});

test('disabling kills overrides a previous kill latch and restores warnings', () => {
  const state = freshState();
  assert.equal(evaluateRunaway(state, 160, KILL).kill, true);
  assert.deepEqual(evaluateRunaway(state, 220, { watchdogAction: 'warn' }),
    { alert: true, pause: false, kill: false, count: 220, rssMb: null, reason: 'count' });
  assert.equal(state.killed, false);
});

test('evaluateRunaway warns on the first sweep at/above threshold and does not kill', () => {
  const state = freshState();
  const first = evaluateRunaway(state, 60, KILL);
  assert.deepEqual(first, { alert: true, pause: false, kill: false, count: 60, rssMb: null, reason: 'count' });
  // The first sample of a session can never itself count as growth (lastCount starts at 0).
  assert.equal(state.growthStreak, 0);
});

test('evaluateRunaway: a stable count (54, 10 sweeps) warns exactly once and never kills', () => {
  const state = freshState();
  let alerts = 0;
  let kills = 0;
  for (let i = 0; i < 10; i++) {
    const { alert, kill } = evaluateRunaway(state, 54, KILL);
    if (alert) alerts++;
    if (kill) kills++;
  }
  assert.equal(alerts, 1);
  assert.equal(kills, 0);
});

test('evaluateRunaway: jitter around the threshold (54, 58, 53, 60) never kills', () => {
  const state = freshState();
  for (const count of [54, 58, 53, 60]) {
    assert.equal(evaluateRunaway(state, count, KILL).kill, false);
  }
});

test('evaluateRunaway: a burst that does not sustain (54 -> 79 -> 55) never kills', () => {
  const state = freshState();
  evaluateRunaway(state, 54, KILL);
  assert.equal(evaluateRunaway(state, 79, KILL).kill, false); // growthStreak 1
  assert.equal(evaluateRunaway(state, 55, KILL).kill, false); // shrank — streak resets
});

test('evaluateRunaway: a shrinking tree (127 -> 69) warns once but never kills', () => {
  const state = freshState();
  const first = evaluateRunaway(state, 127, KILL);
  assert.equal(first.alert, true);
  assert.equal(first.kill, false);
  const second = evaluateRunaway(state, 69, KILL);
  assert.equal(second.kill, false);
  assert.equal(second.alert, false); // still latched-alerted from the first sweep
  assert.equal(state.growthStreak, 0);
});

test('evaluateRunaway: sustained growth (52 -> 68 -> 86) warns at sweep 1, kills at sweep 3', () => {
  const state = freshState();
  const first = evaluateRunaway(state, 52, KILL);
  assert.equal(first.alert, true);
  assert.equal(first.kill, false);
  const second = evaluateRunaway(state, 68, KILL); // +16 — growthStreak 1
  assert.equal(second.kill, false);
  const third = evaluateRunaway(state, 86, KILL); // +18 — growthStreak 2 -> kill
  assert.equal(third.kill, true);
  assert.equal(third.alert, false); // the kill supersedes the warning
});

test('evaluateRunaway: a rise from below the threshold does not count as growth (34 -> 52 -> 68)', () => {
  const state = freshState();
  evaluateRunaway(state, 34, KILL); // below threshold — no alert, no streak
  const second = evaluateRunaway(state, 52, KILL); // crosses threshold, but prior sweep was below it
  assert.equal(second.kill, false);
  assert.equal(state.growthStreak, 0);
  const third = evaluateRunaway(state, 68, KILL); // first sweep that can count as growth
  assert.equal(third.kill, false);
  assert.equal(state.growthStreak, 1);
});

test('evaluateRunaway: a flat sweep breaks the growth streak (52, 68, 68, 86 never kills)', () => {
  const state = freshState();
  evaluateRunaway(state, 52, KILL);
  evaluateRunaway(state, 68, KILL); // growthStreak 1
  assert.equal(evaluateRunaway(state, 68, KILL).kill, false); // flat — streak resets to 0
  assert.equal(state.growthStreak, 0);
  assert.equal(evaluateRunaway(state, 86, KILL).kill, false); // growthStreak back to 1, not yet 2
});

test('evaluateRunaway: a slow climb under the growth threshold (+9/sweep) never kills below the ceiling', () => {
  const state = freshState();
  let count = 52;
  for (let i = 0; i < 10; i++) {
    count += 9;
    assert.equal(evaluateRunaway(state, count, KILL).kill, false);
  }
  assert.ok(count < 150);
});

test('evaluateRunaway kills at once at the ceiling, even on the first sweep', () => {
  const state = freshState();
  const result = evaluateRunaway(state, 150, KILL);
  assert.equal(result.kill, true);
  assert.equal(result.alert, false);
});

test('evaluateRunaway does not kill just under the ceiling on a first sweep', () => {
  const state = freshState();
  const result = evaluateRunaway(state, 149, KILL);
  assert.equal(result.kill, false);
  assert.equal(result.alert, true);
});

test('evaluateRunaway honors a per-state killCeiling override', () => {
  const state = { ...freshState(), killCeiling: 80 };
  assert.equal(evaluateRunaway(state, 79, KILL).kill, false);
  assert.equal(evaluateRunaway(state, 80, KILL).kill, true);
});

test('evaluateRunaway: a dip below threshold resets the growth streak (60 -> 40 -> 60 never kills)', () => {
  const state = freshState();
  const a = evaluateRunaway(state, 60, KILL);
  assert.equal(a.alert, true);
  assert.equal(a.kill, false);
  const b = evaluateRunaway(state, 40, KILL); // >= threshold/2 (25): alerted latch stays set
  assert.equal(b.alert, false);
  assert.equal(b.kill, false);
  assert.equal(state.growthStreak, 0);
  const c = evaluateRunaway(state, 60, KILL); // back up, but the sweep before it (40) was below threshold
  assert.equal(c.kill, false);
  assert.equal(state.growthStreak, 0);
});

test('evaluateRunaway latches a kill — a surviving tree reports kill again on later sweeps even if growth stops', () => {
  const state = freshState();
  evaluateRunaway(state, 52, KILL);
  assert.equal(evaluateRunaway(state, 68, KILL).kill, false);
  assert.equal(evaluateRunaway(state, 86, KILL).kill, true); // growthStreak reaches 2
  assert.equal(evaluateRunaway(state, 86, KILL).kill, true); // flat — still reports kill (latched)
  assert.equal(evaluateRunaway(state, 10, KILL).kill, true); // even a big drop still reports kill (latched)
});

test('evaluateRunaway tolerates a legacy state with no growthStreak/killed fields', () => {
  const state = { threshold: 50, lastCount: 0, lastAlertCount: 0, alerted: false };
  assert.equal(evaluateRunaway(state, 60, KILL).kill, false);
  assert.equal(state.growthStreak, 0);
  assert.equal(state.killed, false);
});

test('limits.warnDescendants overrides the state threshold and scales the ceiling', () => {
  const state = freshState();
  const limits = { warnDescendants: 20, watchdogAction: 'kill' };
  assert.deepEqual(evaluateRunaway(state, 25, limits), { alert: true, pause: false, kill: false, count: 25, rssMb: null, reason: 'count' });
  assert.equal(evaluateRunaway(state, 59, limits).kill, false);
  assert.equal(evaluateRunaway({ ...freshState(), threshold: 20 }, 60, limits).kill, true); // 3 x 20
});

// ── evaluateRunaway() — memory rules and the pause action ──

test('RSS_* constants match the documented memory policy', () => {
  assert.equal(RSS_WARN_FRACTION, 1);
  assert.equal(RSS_PAUSE_CONSECUTIVE, 3);
  assert.equal(RSS_PAUSE_FACTOR, 2);
  assert.equal(RESUME_RSS_GRACE_FRACTION, 0.25);
});

test('a steady 54-process low-memory tree is never paused or killed, in either acting mode', () => {
  for (const action of ['pause', 'kill']) {
    const state = freshState();
    let alerts = 0;
    for (let i = 0; i < 20; i++) {
      const result = evaluateRunaway(state, { count: 54, rssMb: 900 }, withMemory(action));
      assert.equal(result.pause, false, `${action} sweep ${i}`);
      assert.equal(result.kill, false, `${action} sweep ${i}`);
      if (result.alert) alerts++;
    }
    assert.equal(alerts, 1); // warned once about the count, nothing more
    assert.equal(state.paused, undefined);
    assert.equal(state.killed, false);
  }
});

test('memory warns at the budget, re-alerts after another budget of growth, and re-arms below half', () => {
  const state = freshState();
  const limits = withMemory('pause');
  assert.equal(evaluateRunaway(state, { count: 5, rssMb: 3071 }, limits).alert, false);
  const warned = evaluateRunaway(state, { count: 5, rssMb: 3072 }, limits);
  assert.deepEqual(warned, { alert: true, pause: false, kill: false, count: 5, rssMb: 3072, reason: 'memory' });
  assert.equal(evaluateRunaway(state, { count: 5, rssMb: 6000 }, limits).alert, false);
  assert.equal(evaluateRunaway(state, { count: 5, rssMb: 6144 }, limits).alert, true);
  assert.equal(evaluateRunaway(state, { count: 5, rssMb: 1500 }, limits).alert, false);
  assert.equal(evaluateRunaway(state, { count: 5, rssMb: 3072 }, limits).alert, true);
});

test('without a memory limit the rss figure is carried but never judged', () => {
  const state = freshState();
  const result = evaluateRunaway(state, { count: 5, rssMb: 99999 }, PAUSE);
  assert.deepEqual(result, { alert: false, pause: false, kill: false, count: 5, rssMb: 99999, reason: null });
});

test('6000 MB with 35 processes stays running at a 3072 MB budget', () => {
  const state = freshState();
  for (let i = 0; i < 8; i++) {
    const result = evaluateRunaway(state, { count: 35, rssMb: 6000 }, withMemory('pause'));
    assert.equal(result.pause, false);
    assert.equal(result.kill, false);
  }
});

test('a count runaway pauses in pause mode: sustained growth, and the ceiling', () => {
  const state = freshState();
  assert.equal(evaluateRunaway(state, { count: 52, rssMb: 300 }, withMemory('pause')).alert, true);
  assert.equal(evaluateRunaway(state, { count: 68, rssMb: 300 }, withMemory('pause')).pause, false);
  const grown = evaluateRunaway(state, { count: 86, rssMb: 300 }, withMemory('pause'));
  assert.deepEqual(grown, { alert: false, pause: true, kill: false, count: 86, rssMb: 300, reason: 'count-growth' });
  const atCeiling = evaluateRunaway(freshState(), { count: 150, rssMb: 300 }, withMemory('pause'));
  assert.equal(atCeiling.pause, true);
  assert.equal(atCeiling.reason, 'count-ceiling');
});

test('after resuming a count pause the ceiling moves a full threshold past the resume count', () => {
  const state = { ...freshState(), lastCount: 160, alerted: true, lastAlertCount: 160, resumeBase: { count: 160, rssMb: 300 } };
  const limits = withMemory('pause');
  assert.equal(evaluateRunaway(state, { count: 165, rssMb: 300 }, limits).pause, false);
  assert.equal(evaluateRunaway(state, { count: 172, rssMb: 300 }, limits).pause, false); // +7, no growth streak
  assert.equal(evaluateRunaway(state, { count: 210, rssMb: 300 }, limits).pause, true); // 160 + 50
});

// ── summarizeDescendants() / describeKillPolicy() / buildRunawayWarning() (TPT370) ──

test('summarizeDescendants names the most frequent commands, most-frequent first, collapsing the tail', () => {
  const snapshot = parsePsOutput([
    '  10  11  10  S  npm', '  10  12  10  S  npm', '  10  13  10  S  npm',
    '  10  14  10  S  node', '  10  15  10  S  node',
    '  10  16  10  S  rg',
    '  10  17  10  S  sh',
    '  10  18  10  S  grep',
  ].join('\n'));
  const pids = new Set([11, 12, 13, 14, 15, 16, 17, 18]);
  assert.equal(summarizeDescendants(snapshot, pids, 3), 'npm ×3, node ×2, rg ×1, 2 other');
});

test('summarizeDescendants returns empty string with no comm data or no pids', () => {
  const legacy = parsePsOutput('  10  11  10\n');
  assert.equal(summarizeDescendants(legacy, new Set([11])), '');
  assert.equal(summarizeDescendants(null, new Set([11])), '');
  assert.equal(summarizeDescendants(parsePsOutput('  10  11  10  S  npm\n'), new Set()), '');
});

test('describeKillPolicy names the threshold, growth step and ceiling', () => {
  const text = describeKillPolicy(50);
  assert.match(text, /≥50/);
  assert.match(text, /≥10/);
  assert.match(text, /≥150/);
  assert.doesNotMatch(text, /MB/); // no memory limit given — no memory clause
});

test('describeActPolicy scales the ceiling with the threshold and adds the memory clause when a limit is set', () => {
  assert.match(describeActPolicy(20), /≥20 each growing by ≥10, or immediately at ≥60$/);
  const withLimit = describeActPolicy(50, { limitMb: 3072 });
  assert.match(withLimit, /≥150 processes/);
  assert.match(withLimit, /RSS stays >6144 MiB for 3 30-second samples/);
  assert.match(withLimit, /grows by ≥512 MiB/);
  assert.equal(describeKillPolicy(50, undefined, undefined, 3072), `kill ${withLimit}`);
  assert.match(describeActPolicy(50, { limitMb: 3072, action: 'pause' }), /RSS stays >6144 MiB for 3 30-second samples/);
});

test('buildRunawayWarning states the session keeps running and appends a summary when given one', () => {
  const bare = buildRunawayWarning(54, 50, '');
  assert.match(bare, /^54 descendant processes/);
  assert.match(bare, /keeps running/);
  assert.match(bare, /only warns: automatic pause and termination are disabled/);
  assert.doesNotMatch(bare, /kill after|killed automatically/);
  assert.equal(bare.includes('Top processes'), false);
  const withSummary = buildRunawayWarning(54, 50, 'npm ×24');
  assert.match(withSummary, /Top processes: npm ×24\./);
  const enabled = buildRunawayWarning(54, 50, '', { action: 'kill' });
  assert.match(enabled, /Automatic termination enabled/);
  assert.ok(enabled.includes(describeKillPolicy(50)));
});

test('buildRunawayWarning names the memory figures and what the pause action will do', () => {
  const byMemory = buildRunawayWarning(12, 50, '', { rssMb: 2300, limitMb: 3072, action: 'pause', reason: 'memory' });
  assert.match(byMemory, /uses 2300 MiB; RSS warning threshold 3072 MiB \(12 descendant processes\)/);
  assert.match(byMemory, /keeps running/);
  assert.match(byMemory, /will pause it — nothing is killed and it can be resumed/);
  assert.doesNotMatch(byMemory, /Automatic termination enabled/);
  const byCount = buildRunawayWarning(54, 50, '', { rssMb: 900, limitMb: 3072, action: 'pause', reason: 'count' });
  assert.match(byCount, /^54 descendant processes using 900 MiB under this session/);
});

// ── sweepDescendantWatchdog() — the 30s watchdog tick, deps stubbed (TPT370) ──

function makeSweepSession(overrides = {}) {
  return {
    type: 'terminal', alive: true, ptyPid: 10, tabId: 'T1', projectPath: '/p',
    descendantWatchdog: freshState(),
    ...overrides,
  };
}

function makeSweepDeps() {
  let time = 0;
  const notices = [];
  const kills = [];
  const pauses = [];
  const emits = [];
  return {
    notices, kills, pauses, emits,
    deps: {
      get sampledAt() { time += 30000; return time; },
      emitTerminalNotice: (session, text) => notices.push({ session, text }),
      killRunawaySession: (session, opts) => { kills.push({ session, opts }); session.alive = false; return { text: 'killed', first: true }; },
      // Same contract as terminal-session.js's: first call reports first:true, repeats do not.
      pauseRunawaySession: (session, opts) => {
        pauses.push({ session, opts });
        const first = !session._pause;
        session._pause = session._pause || { text: 'paused' };
        return { text: 'paused', first };
      },
      emitSessionRunaway: (projectPath, detail) => emits.push({ projectPath, detail }),
      log: () => {},
    },
  };
}

// `n` descendants of pty leader 10, each with `rssKb` resident memory (leader: 0).
function treeSnapshot(n, rssKb = 0) {
  return parsePsOutput(['  10  10  1  0  S  bash',
    ...Array.from({ length: n }, (_, i) => `  10  ${1000 + i}  10  ${rssKb}  S  node`)].join('\n'));
}

test('sweepDescendantWatchdog defaults to warn-only even with sustained growth or 160 descendants', () => {
  const session = makeSweepSession();
  const sessions = new Map([['k1', session]]);
  const { notices, kills, emits, deps } = makeSweepDeps();
  for (const n of [52, 68, 86, 160]) {
    const snapshot = parsePsOutput(['  10  10  1  S  bash',
      ...Array.from({ length: n }, (_, i) => `  10  ${1000 + i}  10  S  npm`)].join('\n'));
    sweepDescendantWatchdog(sessions, snapshot, deps);
  }
  assert.equal(kills.length, 0);
  assert.equal(notices.length, 2);
  assert.equal(emits.length, 2);
  assert.ok(emits.every(frame => frame.detail.killed !== true));
  assert.equal(emits[1].detail.count, 160);
  assert.match(emits[1].detail.promptText, /only warns: automatic pause and termination are disabled/);
  assert.equal(session.alive, true);
  assert.equal(session.descendantWatchdog.killed, false);
});

test('sweepDescendantWatchdog: a stable count over several sweeps warns once, never kills, session stays alive', () => {
  const session = makeSweepSession();
  const sessions = new Map([['k1', session]]);
  const { notices, kills, emits, deps } = makeSweepDeps();
  const snapshotFor = (n) => parsePsOutput(['  10  10  1  S  bash', ...Array.from({ length: n }, (_, i) => `  10  ${100 + i}  10  S  npm`)].join('\n'));
  sweepDescendantWatchdog(sessions, snapshotFor(54), deps);
  sweepDescendantWatchdog(sessions, snapshotFor(54), deps);
  sweepDescendantWatchdog(sessions, snapshotFor(55), deps);
  assert.equal(notices.length, 1);
  assert.equal(kills.length, 0);
  assert.equal(emits.length, 1);
  assert.equal(emits[0].detail.killed, undefined);
  assert.equal(session.alive, true);
});

test('sweepDescendantWatchdog: sustained growth kills once, with killed:true on the emitted frame', () => {
  const session = makeSweepSession();
  const sessions = new Map([['k1', session]]);
  const { kills, emits, deps } = makeSweepDeps();
  deps.resolveLimits = () => KILL;
  const snapshotFor = (n) => parsePsOutput(['  10  10  1  S  bash', ...Array.from({ length: n }, (_, i) => `  10  ${100 + i}  10  S  npm`)].join('\n'));
  sweepDescendantWatchdog(sessions, snapshotFor(52), deps);
  sweepDescendantWatchdog(sessions, snapshotFor(68), deps);
  sweepDescendantWatchdog(sessions, snapshotFor(86), deps);
  assert.equal(kills.length, 1);
  // 1 warn emit (sweep 1, first crossing) + 1 kill emit (sweep 3) — sweep 2 re-alerts only
  // once growth since the last alert reaches another full threshold, which it hasn't yet.
  assert.equal(emits.length, 2);
  assert.equal(emits[0].detail.killed, undefined);
  assert.equal(emits[1].detail.killed, true);
});

test('sweepDescendantWatchdog kills immediately at the ceiling', () => {
  const session = makeSweepSession();
  const sessions = new Map([['k1', session]]);
  const { kills, deps } = makeSweepDeps();
  deps.resolveLimits = () => KILL;
  const snapshot = parsePsOutput(['  10  10  1  S  bash', ...Array.from({ length: 160 }, (_, i) => `  10  ${1000 + i}  10  S  npm`)].join('\n'));
  sweepDescendantWatchdog(sessions, snapshot, deps);
  assert.equal(kills.length, 1);
});

test('sweepDescendantWatchdog skips dead, non-terminal, and state-less sessions', () => {
  const sessions = new Map([
    ['dead', makeSweepSession({ alive: false })],
    ['objective', makeSweepSession({ type: 'objective' })],
    ['no-pid', makeSweepSession({ ptyPid: null })],
    ['no-state', makeSweepSession({ descendantWatchdog: null })],
  ]);
  const { notices, kills, deps } = makeSweepDeps();
  const snapshot = parsePsOutput(['  10  10  1  S  bash', ...Array.from({ length: 60 }, (_, i) => `  10  ${1000 + i}  10  S  npm`)].join('\n'));
  sweepDescendantWatchdog(sessions, snapshot, deps);
  assert.equal(notices.length, 0);
  assert.equal(kills.length, 0);
});

// ── sweepDescendantWatchdog() — memory + the pause action ──

test('sweepDescendantWatchdog: a steady 54-process low-memory tree is warned about once and never paused or killed', () => {
  const session = makeSweepSession();
  const sessions = new Map([['k1', session]]);
  const { notices, kills, pauses, emits, deps } = makeSweepDeps();
  deps.resolveLimits = () => withMemory('pause');
  for (let i = 0; i < 12; i++) sweepDescendantWatchdog(sessions, treeSnapshot(54, 16 * 1024), deps); // 864 MB
  assert.equal(pauses.length, 0);
  assert.equal(kills.length, 0);
  assert.equal(notices.length, 1);
  assert.equal(emits.length, 1);
  assert.equal(emits[0].detail.rssMb, 864);
  assert.equal(emits[0].detail.limitMb, LIMIT_MB);
  assert.equal(emits[0].detail.paused, undefined);
  assert.equal(session._pause, undefined);
  assert.equal(session.alive, true);
});

test('sweepDescendantWatchdog: sustained high and growing RSS pauses on third sweep and re-signals quietly', () => {
  const session = makeSweepSession();
  const sessions = new Map([['k1', session]]);
  const { notices, kills, pauses, emits, deps } = makeSweepDeps();
  deps.resolveLimits = () => withMemory('pause');
  const over = treeSnapshot(8, 800 * 1024); // 6400 MB in 8 processes
  sweepDescendantWatchdog(sessions, over, deps); // sweep 1: warn only (not yet sustained)
  assert.equal(pauses.length, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /uses 6400 MiB; RSS warning threshold 3072 MiB/);
  assert.equal(emits[0].detail.reason, 'memory');
  sweepDescendantWatchdog(sessions, treeSnapshot(8, 864 * 1024), deps); // sweep 2: still running
  assert.equal(pauses.length, 0);
  const grown = treeSnapshot(8, 928 * 1024);
  sweepDescendantWatchdog(sessions, grown, deps); // sweep 3: pause
  assert.equal(pauses.length, 1);
  assert.deepEqual(
    { count: pauses[0].opts.count, rssMb: pauses[0].opts.rssMb, limitMb: pauses[0].opts.limitMb, reason: pauses[0].opts.reason },
    { count: 8, rssMb: 7424, limitMb: LIMIT_MB, reason: 'memory-growth' },
  );
  assert.equal(pauses[0].opts.snapshot, grown);
  assert.equal(emits.length, 2);
  assert.equal(emits[1].detail.paused, true);
  assert.equal(emits[1].detail.killed, undefined);
  assert.equal(emits[1].detail.promptText, 'paused');
  sweepDescendantWatchdog(sessions, over, deps); // sweep 4: latched — re-signal
  assert.equal(pauses.length, 2);
  assert.equal(emits.length, 2);
  assert.equal(notices.length, 1);
  assert.equal(kills.length, 0);
  assert.equal(session.alive, true);
});

test('sweepDescendantWatchdog: a count runaway pauses in pause mode instead of killing', () => {
  const session = makeSweepSession();
  const sessions = new Map([['k1', session]]);
  const { kills, pauses, emits, deps } = makeSweepDeps();
  deps.resolveLimits = () => withMemory('pause');
  for (const n of [52, 68, 86]) sweepDescendantWatchdog(sessions, treeSnapshot(n, 1024), deps);
  assert.equal(kills.length, 0);
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].opts.reason, 'count-growth');
  assert.equal(emits.at(-1).detail.paused, true);
});

test('sweepDescendantWatchdog: kill mode kills on sustained memory and passes the memory figures', () => {
  const session = makeSweepSession();
  const sessions = new Map([['k1', session]]);
  const { kills, pauses, emits, deps } = makeSweepDeps();
  deps.resolveLimits = () => withMemory('kill');
  for (const mb of [800, 864, 928]) sweepDescendantWatchdog(sessions, treeSnapshot(8, mb * 1024), deps);
  assert.equal(pauses.length, 0);
  assert.equal(kills.length, 1);
  assert.equal(kills[0].opts.reason, 'memory-growth');
  assert.equal(kills[0].opts.rssMb, 7424);
  assert.equal(kills[0].opts.limitMb, LIMIT_MB);
  assert.equal(emits.at(-1).detail.killed, true);
});

test('sweepDescendantWatchdog resolves limits once per project per sweep and applies them per session', () => {
  const a1 = makeSweepSession({ tabId: 'A1', projectPath: '/a' });
  const a2 = makeSweepSession({ tabId: 'A2', ptyPid: 20, projectPath: '/a' });
  const b1 = makeSweepSession({ tabId: 'B1', ptyPid: 30, projectPath: '/b' });
  const sessions = new Map([['a1', a1], ['a2', a2], ['b1', b1]]);
  const { notices, deps } = makeSweepDeps();
  const asked = [];
  deps.resolveLimits = (projectPath) => {
    asked.push(projectPath);
    return { warnDescendants: projectPath === '/b' ? 5 : 50, maxTreeRssMb: LIMIT_MB, watchdogAction: 'pause' };
  };
  const rows = ['  10  10  1  0  S  bash', '  20  20  1  0  S  bash', '  30  30  1  0  S  bash'];
  for (const root of [10, 20, 30]) {
    for (let i = 0; i < 6; i++) rows.push(`  ${root}  ${root * 100 + i}  ${root}  1024  S  node`);
  }
  sweepDescendantWatchdog(sessions, parsePsOutput(rows.join('\n')), deps);
  assert.deepEqual(asked, ['/a', '/b']);
  assert.equal(b1.descendantWatchdog.threshold, 5); // live limits refresh the session threshold
  assert.equal(a1.descendantWatchdog.threshold, 50);
  assert.deepEqual(notices.map(n => n.session.tabId), ['B1']); // only project /b has an independent warning threshold below 6
});

test('sweepDescendantWatchdog: a throwing or missing limits resolver degrades to warn-only', () => {
  for (const resolveLimits of [undefined, () => { throw new Error('config unreadable'); }]) {
    const session = makeSweepSession();
    const { kills, pauses, notices, deps } = makeSweepDeps();
    deps.resolveLimits = resolveLimits;
    sweepDescendantWatchdog(new Map([['k1', session]]), treeSnapshot(200, 100 * 1024), deps);
    assert.equal(kills.length, 0);
    assert.equal(pauses.length, 0);
    assert.equal(notices.length, 1);
  }
});

test('sweepDescendantWatchdog: a failed pause adds one fallback warning, never a paused frame', () => {
  const session = makeSweepSession();
  const sessions = new Map([['k1', session]]);
  const { notices, emits, deps } = makeSweepDeps();
  deps.resolveLimits = () => withMemory('pause');
  deps.pauseRunawaySession = () => null;
  const bomb = treeSnapshot(160, 1024);
  sweepDescendantWatchdog(sessions, bomb, deps);
  sweepDescendantWatchdog(sessions, bomb, deps);
  sweepDescendantWatchdog(sessions, bomb, deps);
  assert.equal(notices.length, 1); // one failed-pause warning
  assert.equal(emits.length, 1);
  assert.equal(emits[0].detail.paused, undefined);
  assert.equal(session.descendantWatchdog.paused, false);
});

// ── killProcessTree() / signalTargets() — process.kill is always stubbed ──

function withStubbedKill(fn) {
  const calls = [];
  const origKill = process.kill;
  process.kill = (pid, sig) => { calls.push([pid, sig]); };
  try {
    return { result: fn(), calls };
  } finally {
    process.kill = origKill;
  }
}

test('killProcessTree group-kills root, group-kills a descendant-led pgid, and pid-signals a lone foreign-group descendant', () => {
  // 10 = pty root; 11 in root's group; 20 setsid()'d (leads its own group 20) with member 21;
  // 30 is a descendant of 11 that joined a group (999) led by a process that is NOT a descendant.
  const snapshot = parsePsOutput([
    '  10  10  1',
    '  10  11  10',
    '  20  20  11',
    '  20  21  20',
    '  999  30  11',
  ].join('\n'));
  const { result, calls } = withStubbedKill(() => killProcessTree(snapshot, 10, 'SIGTERM'));
  assert.deepEqual(calls, [[-10, 'SIGTERM'], [-20, 'SIGTERM'], [30, 'SIGTERM']]);
  assert.deepEqual(result.pgids, [10, 20]);
  assert.deepEqual(result.pids, [30]);
  assert.equal(result.signaled, true);
});

test('killProcessTree does not pid-signal descendants already covered by a group kill', () => {
  const snapshot = parsePsOutput('  10  10  1\n  10  11  10\n  10  12  11\n');
  const { result, calls } = withStubbedKill(() => killProcessTree(snapshot, 10, 'SIGKILL'));
  assert.deepEqual(calls, [[-10, 'SIGKILL']]);
  assert.deepEqual(result.pids, []);
});

test('killProcessTree never signals pid <= 1, our own pid, or our own process group', () => {
  const own = process.pid;
  const ownGroup = typeof process.getpgrp === 'function' ? process.getpgrp() : null;
  // Descendants in a foreign group (777) so every one would otherwise be pid-signaled.
  const rows = ['  10  10  1', `  777  1  10`, `  777  ${own}  10`];
  if (ownGroup) rows.push(`  777  ${ownGroup}  10`);
  rows.push('  777  40  10');
  const snapshot = parsePsOutput(rows.join('\n'));
  const { calls } = withStubbedKill(() => killProcessTree(snapshot, 10, 'SIGTERM'));
  const signaledPids = calls.map(([pid]) => pid);
  assert.ok(signaledPids.includes(40), 'the safe descendant is signaled');
  assert.ok(!signaledPids.includes(1));
  assert.ok(!signaledPids.includes(own));
  if (ownGroup) assert.ok(!signaledPids.includes(ownGroup) && !signaledPids.includes(-ownGroup));
});

test('killProcessTree refuses to group-kill root when root is our own pid, without throwing', () => {
  const snapshot = parsePsOutput(`  ${process.pid}  ${process.pid}  1\n`);
  const { result, calls } = withStubbedKill(() => killProcessTree(snapshot, process.pid, 'SIGTERM'));
  assert.deepEqual(calls, []);
  assert.equal(result.signaled, false);
});

test('killProcessTree returns signaled:false (never throws) for a null snapshot or falsy root', () => {
  assert.equal(killProcessTree(null, 10, 'SIGTERM').signaled, false);
  assert.equal(killProcessTree(parsePsOutput('  10  10  1\n'), 0, 'SIGTERM').signaled, false);
});

test('killProcessTree still group-kills root when the snapshot lacks it (leader-only fallback shape)', () => {
  const snapshot = parsePsOutput('  5  5  1\n');
  const { result, calls } = withStubbedKill(() => killProcessTree(snapshot, 99999, 'SIGTERM'));
  assert.deepEqual(calls, [[-99999, 'SIGTERM']]);
  assert.equal(result.signaled, true);
});

test('killProcessTree reports signaled:false when every process.kill throws ESRCH', () => {
  const origKill = process.kill;
  process.kill = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
  try {
    const snapshot = parsePsOutput('  10  10  1\n  999  30  10\n');
    const result = killProcessTree(snapshot, 10, 'SIGTERM');
    assert.equal(result.signaled, false);
    assert.deepEqual(result.pgids, []);
    assert.deepEqual(result.pids, []);
  } finally {
    process.kill = origKill;
  }
});

test('signalTargets replays a resolved target set with a different signal (the SIGKILL follow-up)', () => {
  const targets = { pgids: [10, 20], pids: [30] };
  const { result, calls } = withStubbedKill(() => signalTargets(targets, 'SIGKILL'));
  assert.deepEqual(calls, [[-10, 'SIGKILL'], [-20, 'SIGKILL'], [30, 'SIGKILL']]);
  assert.equal(result.signaled, true);
});

test('signalTargets is a no-op on win32 and for a missing target set', () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const { result, calls } = withStubbedKill(() => signalTargets({ pgids: [10], pids: [30] }, 'SIGTERM'));
    assert.deepEqual(calls, []);
    assert.equal(result.signaled, false);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform });
  }
  assert.equal(signalTargets(null, 'SIGTERM').signaled, false);
});

test('resolveTreeTargets resolves the whole tree without signaling anything', () => {
  // Same shape as the killProcessTree case above: root group 10, escaped group 20, lone 30.
  const snapshot = parsePsOutput([
    '  10  10  1', '  10  11  10', '  20  20  11', '  20  21  20', '  999  30  11',
  ].join('\n'));
  const { result, calls } = withStubbedKill(() => resolveTreeTargets(snapshot, 10));
  assert.deepEqual(calls, []);
  assert.deepEqual(result.pgids.sort((a, b) => a - b), [10, 20]);
  assert.deepEqual(result.pids, [30]);
  assert.deepEqual(resolveTreeTargets(null, 10), { pgids: [10], pids: [] });
  assert.deepEqual(resolveTreeTargets(snapshot, 0), { pgids: [], pids: [] });
});

test('a resolved tree can be stopped and continued: SIGSTOP then SIGCONT reach the same set', () => {
  const snapshot = parsePsOutput(['  10  10  1', '  10  11  10', '  20  20  11', '  999  30  11'].join('\n'));
  const { result, calls } = withStubbedKill(() => {
    const stopped = signalTargets(resolveTreeTargets(snapshot, 10), 'SIGSTOP');
    signalTargets(stopped, 'SIGCONT');
    return stopped;
  });
  assert.equal(result.signaled, true);
  assert.deepEqual(calls.filter(([, sig]) => sig === 'SIGSTOP').map(([pid]) => pid), [-10, -20, 30]);
  assert.deepEqual(calls.filter(([, sig]) => sig === 'SIGCONT').map(([pid]) => pid), [-10, -20, 30]);
  assert.ok(calls.every(([, sig]) => sig === 'SIGSTOP' || sig === 'SIGCONT')); // nothing lethal
});

// ── resolveAgentLimits() (TPT440) — env/config stubbed, never touches the real environment ──

const K = AGENT_LIMIT_KEYS;
const GB = 1024 ** 3;
const HW_48 = { totalMemBytes: 48 * GB, cores: 12 }; // device cap 6 at the default 6144 MB budget
const limits = (cfg, env = {}, hardware = HW_48) => resolveAgentLimits('/p', { env, readConfig: () => cfg, hardware });

test('resolveAgentLimits returns the defaults with no config and no env', () => {
  assert.deepEqual(limits(null), {
    maxConcurrentSessions: 6, deviceSessionCap: 6, sessionCapSource: 'device',
    maxSubagents: 3, warnDescendants: 50, maxTreeRssMb: 6144, watchdogAction: 'pause',
    soloMultiplier: 2, minScale: 0.25,
    descendantCeiling: 150, rssActionMb: 12288, rssGrowthMb: 512, rssPressureGrowthMb: 128, rssSamples: 3,
  });
  assert.equal(AGENT_LIMIT_DEFAULTS.warnDescendants, DESCENDANT_ALERT_THRESHOLD);
  assert.deepEqual(WATCHDOG_ACTIONS, ['warn', 'pause', 'kill']);
});

test('evaluateRunaway warns at 6144 MB for both the default and a configured 6 GB budget', () => {
  for (const resolved of [limits(null), limits({ [K.maxTreeRssMb]: '6144' })]) {
    assert.equal(resolved.maxTreeRssMb, 6144);
    const state = freshState();
    for (const rssMb of [3072, 6143]) {
      assert.equal(evaluateRunaway(state, { count: 5, rssMb }, resolved).alert, false);
    }
    assert.deepEqual(evaluateRunaway(state, { count: 5, rssMb: 6144 }, resolved), {
      alert: true, pause: false, kill: false, count: 5, rssMb: 6144, reason: 'memory',
    });
  }
});

test('sweepDescendantWatchdog displays the independent 6144 MiB warning threshold when it warns', () => {
  const session = makeSweepSession();
  const { notices, emits, deps } = makeSweepDeps();
  deps.resolveLimits = () => limits(null);
  const sessions = new Map([['k1', session]]);
  sweepDescendantWatchdog(sessions, treeSnapshot(8, 384 * 1024), deps); // 3072 MB
  assert.equal(notices.length, 0);
  sweepDescendantWatchdog(sessions, treeSnapshot(8, 1536 * 1024), deps); // 12288 MB
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /uses 12288 MiB; RSS warning threshold 6144 MiB/);
  assert.equal(emits[0].detail.limitMb, 6144);
  assert.equal(emits[0].detail.reason, 'memory');
});

test('resolveAgentLimits reads every config.json key (numbers and numeric strings)', () => {
  const result = limits({
    [K.maxConcurrentSessions]: 8, [K.maxSubagents]: '6', [K.warnDescendants]: 90,
    [K.maxTreeRssMb]: '2048', [K.watchdogAction]: 'warn',
    [K.soloMultiplier]: '2.5', [K.minScale]: 0.125,
  });
  assert.equal(result.sessionCapSource, 'config');
  assert.equal(result.deviceSessionCap, 6);
  assert.deepEqual({ ...result, deviceSessionCap: undefined, sessionCapSource: undefined }, {
    maxConcurrentSessions: 6, deviceSessionCap: undefined, sessionCapSource: undefined, projectSessionCap: 8,
    maxSubagents: 6, warnDescendants: 90, maxTreeRssMb: 2048, watchdogAction: 'warn',
    soloMultiplier: 2.5, minScale: 0.125,
    descendantCeiling: 270, rssActionMb: 4096, rssGrowthMb: 512, rssPressureGrowthMb: 128, rssSamples: 3,
  });
});

test('resolveAgentLimits: env beats config per key, other keys still come from config', () => {
  const result = limits(
    { [K.maxSubagents]: 6, [K.maxConcurrentSessions]: 8, [K.maxTreeRssMb]: 2048, [K.watchdogAction]: 'warn' },
    { [K.maxSubagents]: '2', [K.watchdogAction]: 'kill' },
  );
  assert.equal(result.maxSubagents, 2);
  assert.equal(result.maxConcurrentSessions, 6);
  assert.equal(result.watchdogAction, 'kill');
});

test('resolveAgentLimits: TIPATASK_WATCHDOG_KILL=1 maps to kill, above config, below the explicit env action', () => {
  assert.equal(limits({ [K.watchdogAction]: 'warn' }, { TIPATASK_WATCHDOG_KILL: '1' }).watchdogAction, 'kill');
  assert.equal(limits(null, { TIPATASK_WATCHDOG_KILL: '1' }).watchdogAction, 'kill');
  assert.equal(limits(null, { TIPATASK_WATCHDOG_KILL: '1', [K.watchdogAction]: 'warn' }).watchdogAction, 'warn');
  assert.equal(limits(null, { TIPATASK_WATCHDOG_KILL: '0' }).watchdogAction, 'pause');
  assert.equal(limits({ [K.watchdogAction]: 'warn' }, { TIPATASK_WATCHDOG_KILL: 'true' }).watchdogAction, 'warn');
});

test('resolveAgentLimits: invalid numeric values fall back to the default', () => {
  for (const bad of [0, -5, 1.5, 'abc', '', '  ', '1e3', '-2', '3.5', {}, [], null, true, NaN, Infinity]) {
    const result = limits({ [K.maxSubagents]: bad, [K.maxTreeRssMb]: bad });
    assert.equal(result.maxSubagents, AGENT_LIMIT_DEFAULTS.maxSubagents, `bad value ${String(bad)}`);
    assert.equal(result.maxTreeRssMb, 6144);
  }
});

test('resolveAgentLimits: a bad env value falls through to a good config value, a bad config to the default', () => {
  assert.equal(limits({ [K.maxSubagents]: 6 }, { [K.maxSubagents]: 'lots' }).maxSubagents, 6);
  assert.equal(limits({ [K.maxSubagents]: -1 }, { [K.maxSubagents]: '0' }).maxSubagents, 3);
});

test('resolveAgentLimits: invalid or non-string watchdog action falls back; valid action is case/space-insensitive', () => {
  assert.equal(limits({ [K.watchdogAction]: 'nuke' }).watchdogAction, 'pause');
  assert.equal(limits({ [K.watchdogAction]: 7 }).watchdogAction, 'pause');
  assert.equal(limits({ [K.watchdogAction]: 'warn' }, { [K.watchdogAction]: 'nuke' }).watchdogAction, 'warn');
  assert.equal(limits(null, { [K.watchdogAction]: ' KILL ' }).watchdogAction, 'kill');
});

test('resolveAgentLimits never throws: throwing reader, falsy root, non-object config, missing env', () => {
  const boom = () => { throw new Error('read failed'); };
  assert.equal(resolveAgentLimits('/p', { env: {}, readConfig: boom }).maxSubagents, 3);
  assert.equal(resolveAgentLimits('', { env: {}, readConfig: () => ({ [K.maxSubagents]: 9 }) }).maxSubagents, 3);
  assert.equal(limits('garbage').watchdogAction, 'pause');
  assert.equal(resolveAgentLimits('/p', { env: null, readConfig: () => null, hardware: HW_48 }).maxConcurrentSessions, 6);
  // real hardware detection path never throws and yields at least one slot
  assert.ok(resolveAgentLimits('/p', { env: {}, readConfig: () => null }).maxConcurrentSessions >= 1);
});

test('resolveAgentLimits returns a fresh object each call', () => {
  const a = limits(null);
  a.maxSubagents = 99;
  assert.equal(limits(null).maxSubagents, 3);
});

test('resolveAgentLimits reads .tipatask/config.json from disk through the shared resolver', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpt440-'));
  try {
    fs.mkdirSync(path.join(root, '.tipatask'));
    fs.writeFileSync(path.join(root, '.tipatask', 'config.json'),
      JSON.stringify({ [K.maxSubagents]: 7, [K.watchdogAction]: 'warn', [K.maxTreeRssMb]: 'bogus' }));
    const result = resolveAgentLimits(root, { env: {} });
    assert.equal(result.maxSubagents, 7);
    assert.equal(result.watchdogAction, 'warn');
    assert.equal(result.maxTreeRssMb, 6144);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('config.js excludes every AGENT_LIMITS_* key from the config.json -> process.env seed', () => {
  const src = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
  for (const key of Object.values(K)) assert.ok(src.includes(`'${key}'`), `${key} missing from seed-skip list`);
});

test('resolveAgentLimits accepts positive decimal scales with per-key env precedence', () => {
  const cfg = { [K.soloMultiplier]: 3.5, [K.minScale]: '0.125' };
  const result = limits(cfg, { [K.soloMultiplier]: ' 2.5 ' });
  assert.equal(result.soloMultiplier, 2.5);
  assert.equal(result.minScale, 0.125);
  assert.equal(limits(cfg, { [K.minScale]: '.5' }).minScale, 0.5);
});

test('resolveAgentLimits rejects invalid scales and falls through env, config, default', () => {
  for (const field of ['soloMultiplier', 'minScale']) {
    const key = K[field];
    for (const bad of [0, -1, '', ' ', 'no', '1e3', '0x10', '2x', {}, [], true, null, undefined, NaN, Infinity, 'Infinity']) {
      assert.equal(limits({ [key]: bad })[field], AGENT_LIMIT_DEFAULTS[field], `${field}: ${String(bad)}`);
      assert.equal(limits({ [key]: 0.75 }, { [key]: bad })[field], 0.75);
      assert.equal(limits({ [key]: bad }, { [key]: bad })[field], AGENT_LIMIT_DEFAULTS[field]);
    }
  }
});

for (const [activeCount, warnDescendants, maxTreeRssMb, maxSubagents] of [
  [1, 100, 12288, 6],
  [2, 50, 6144, 3],
  [8, 13, 1536, 1],
  [32, 13, 1536, 1],
]) {
  test(`scaleAgentLimitsForConcurrency scales default limits for ${activeCount} sessions`, () => {
    const base = Object.freeze(limits(null));
    const scaled = scaleAgentLimitsForConcurrency(base, activeCount);
    assert.notEqual(scaled, base);
    assert.deepEqual(scaled, { ...base, advisoryDescendants: warnDescendants, advisoryTreeRssMb: maxTreeRssMb, maxSubagents });
  });
}

test('scaleAgentLimitsForConcurrency honors custom scales, rounds and clamps to one', () => {
  const base = Object.freeze({ ...limits(null), soloMultiplier: 1.5, minScale: 0.1,
    warnDescendants: 7, maxTreeRssMb: 13, maxSubagents: 1, watchdogAction: 'kill' });
  assert.deepEqual(scaleAgentLimitsForConcurrency(base, 2), {
    ...base, advisoryDescendants: 5, advisoryTreeRssMb: 10, maxSubagents: 1,
  });
  assert.deepEqual(scaleAgentLimitsForConcurrency(base, 100), {
    ...base, advisoryDescendants: 1, advisoryTreeRssMb: 1, maxSubagents: 1,
  });
});

test('scaleAgentLimitsForConcurrency normalizes zero or invalid counts to one', () => {
  const base = limits(null);
  const solo = scaleAgentLimitsForConcurrency(base, 1);
  for (const bad of [0, -1, 1.5, null, undefined, NaN, Infinity, '', 'no', {}, true]) {
    assert.deepEqual(scaleAgentLimitsForConcurrency(base, bad), solo);
  }
});

test('scaleAgentLimitsForConcurrency supplies default scales for legacy limits', () => {
  const base = { warnDescendants: 50, maxTreeRssMb: 6144, maxSubagents: 3, watchdogAction: 'warn' };
  assert.deepEqual(scaleAgentLimitsForConcurrency(base, 1), {
    ...base, advisoryDescendants: 100, advisoryTreeRssMb: 12288, maxSubagents: 6,
  });
});

test('countActiveAgentSessions counts live PTYs across projects, including paused sessions', () => {
  const live = { type: 'terminal', alive: true, ptyPid: 100, projectPath: '/one' };
  const sessions = new Map([
    ['one', live],
    ['two', { ...live, ptyPid: 200, projectPath: '/two', _pause: {} }],
    ['dead', { ...live, alive: false }],
    ['no-pid', { ...live, ptyPid: null }],
    ['zero-pid', { ...live, ptyPid: 0 }],
    ['queued', { type: 'terminal', _queued: true, alive: false }],
    ['starting', { type: 'terminal', _starting: true, _launching: true }],
    ['objective', { ...live, type: 'objective' }],
    ['taskChat', { ...live, type: 'taskChat' }],
    ['specChat', { ...live, type: 'specChat' }],
    ['missing', null],
  ]);
  assert.equal(countActiveAgentSessions(sessions), 2);
  assert.equal(countActiveAgentSessions(new Map()), 0);
  live.alive = false;
  assert.equal(countActiveAgentSessions(sessions), 1);
});

// ── computeDeviceSessionCap() / hardware-derived maxConcurrentSessions (TPT444) ──

test('computeDeviceSessionCap follows reserve + per-session budget across machine sizes', () => {
  const cap = (gb, cores, sessionBudgetMb = 3072) => computeDeviceSessionCap({ totalMemBytes: gb * GB, cores, sessionBudgetMb });
  assert.equal(cap(8, 4), 1);          // 8GB: reserve 6GB, 2GB left -> 0 slots -> floored to 1
  assert.equal(cap(16, 8), 3);         // reserve 6GB -> 10GB / 3GB
  assert.equal(cap(32, 10), 8);        // reserve 6.4GB -> 25.6GB / 3GB
  assert.equal(cap(48, 12), 12);       // reserve 9.6GB -> 38.4GB / 3GB = 12.8 -> 12
  assert.equal(cap(64, 16), 16);       // reserve 12.8GB -> 51.2GB / 3GB = 17 RAM slots, CPU-bound at 16
  assert.equal(cap(128, 64), DEVICE_SESSION_CAP_MAX);
});

test('computeDeviceSessionCap is CPU-bound on a slow multi-GB machine and floors at one slot', () => {
  assert.equal(computeDeviceSessionCap({ totalMemBytes: 64 * GB, cores: 4, sessionBudgetMb: 3072 }), 4);
  assert.equal(computeDeviceSessionCap({ totalMemBytes: 4 * GB, cores: 2, sessionBudgetMb: 3072 }), 1);
});

test('computeDeviceSessionCap uses the budget argument and survives bad hardware numbers', () => {
  const big = computeDeviceSessionCap({ totalMemBytes: 48 * GB, cores: 32, sessionBudgetMb: 6144 });
  const small = computeDeviceSessionCap({ totalMemBytes: 48 * GB, cores: 32, sessionBudgetMb: 1536 });
  assert.ok(small > big);
  for (const bad of [{}, undefined, { totalMemBytes: NaN, cores: 8 }, { totalMemBytes: 16 * GB, cores: 0 }, { totalMemBytes: -1, cores: 8 }]) {
    assert.equal(computeDeviceSessionCap(bad), 1);
  }
});

test('resolveAgentLimits derives maxConcurrentSessions independently of the watchdog RSS budget', () => {
  assert.equal(limits(null, {}, { totalMemBytes: 16 * GB, cores: 8 }).maxConcurrentSessions, 1);
  assert.equal(limits(null, {}, HW_48).maxConcurrentSessions, 6);
  // Changing the watchdog budget must not change device admission capacity.
  assert.equal(limits({ [K.maxTreeRssMb]: 3072 }, {}, HW_48).maxConcurrentSessions, 6);
});

test('resolveAgentLimits: an explicit session cap can lower but never raise the device cap', () => {
  const lowered = limits({ [K.maxConcurrentSessions]: 2 });
  assert.equal(lowered.maxConcurrentSessions, 2);
  assert.equal(lowered.deviceSessionCap, 6);
  assert.equal(lowered.sessionCapSource, 'config');
  const raised = limits({ [K.maxConcurrentSessions]: 100 });
  assert.equal(raised.maxConcurrentSessions, 6);
  assert.equal(limits({ [K.maxConcurrentSessions]: 5 }, { [K.maxConcurrentSessions]: '1' }).sessionCapSource, 'env');
  assert.equal(limits({ [K.maxConcurrentSessions]: 5 }, { [K.maxConcurrentSessions]: '1' }).maxConcurrentSessions, 1);
  assert.equal(limits({ [K.maxConcurrentSessions]: 'junk' }).sessionCapSource, 'device');
});


test('cross-project concurrency changes preserve independent enforcement and active-count notices', () => {
  const session = makeSweepSession();
  const sessions = new Map([['one', session]]);
  const { notices, pauses, kills, deps } = makeSweepDeps();
  deps.resolveLimits = () => limits(null);
  sweepDescendantWatchdog(sessions, treeSnapshot(54), deps);
  assert.equal(session.descendantWatchdog.threshold, 50);
  assert.match(notices.at(-1).text, /1 session active/);
  for (let i = 2; i <= 8; i++) sessions.set(`other${i}`, makeSweepSession({
    ptyPid: i * 10, projectPath: `/project${i}`,
  }));
  for (let i = 0; i < 5; i++) sweepDescendantWatchdog(sessions, treeSnapshot(54), deps);
  assert.equal(pauses.length, 0);
  assert.equal(kills.length, 0);
  assert.equal(session.descendantWatchdog.threshold, 50);
  sweepDescendantWatchdog(sessions, treeSnapshot(104), deps);
  assert.match(notices.at(-1).text, /8 sessions active/);
  assert.match(notices.at(-1).text, /13 descendants, 1536 MiB; these do not trigger intervention/);
  sweepDescendantWatchdog(sessions, treeSnapshot(114), deps);
  assert.equal(pauses.length, 1, 'sustained growth still acts');
  sessions.delete('other8');
  sweepDescendantWatchdog(sessions, treeSnapshot(114), deps);
  assert.equal(pauses.length, 2, 'load changes preserve existing pause');
});

test('tightening discards earlier growth and requires a fresh streak below the ceiling', () => {
  const state = { ...freshState(), threshold: 100, lastCount: 30, growthStreak: 1, rssStreak: 2 };
  const budget = { warnDescendants: 25, watchdogAction: 'pause' };
  assert.equal(evaluateRunaway(state, 40, budget).pause, false);
  assert.equal(state.growthStreak, 0);
  assert.equal(state.rssStreak, 0);
  assert.equal(evaluateRunaway(state, 50, budget).pause, false);
  assert.equal(evaluateRunaway(state, 60, budget).pause, true);
});

test('tightening cannot turn stable RSS into an immediate memory kill', () => {
  const state = { ...freshState(), threshold: 100, rssStreak: 1 };
  const budget = { warnDescendants: 25, maxTreeRssMb: 100, watchdogAction: 'kill' };
  const first = evaluateRunaway(state, { count: 5, rssMb: 200 }, budget);
  assert.equal(first.kill, false);
  assert.equal(first.alert, true);
  assert.equal(state.rssStreak, 0);
  assert.equal(evaluateRunaway(state, { count: 5, rssMb: 200, sampledAt: 30000 }, budget).kill, false);
});

test('watchdog uses one active count throughout a sweep even after killing another project session', () => {
  const sessions = new Map([
    ['a', makeSweepSession()],
    ['b', makeSweepSession({ ptyPid: 20, projectPath: '/other' })],
  ]);
  const rows = [];
  for (const pid of [10, 20]) {
    rows.push(`${pid} ${pid} 1 0 S bash`);
    for (let i = 1; i <= 160; i++) rows.push(`${pid} ${pid * 1000 + i} ${pid} 0 S node`);
  }
  const { kills, deps } = makeSweepDeps();
  deps.resolveLimits = () => ({ ...limits(null), watchdogAction: 'kill' });
  sweepDescendantWatchdog(sessions.entries(), parsePsOutput(rows.join('\n')), deps);
  assert.equal(kills.length, 2);
  assert.deepEqual(kills.map(k => k.opts.threshold), [50, 50]);
});
