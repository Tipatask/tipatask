'use strict';

// (C1565) Unit tests for the process-group kill + descendant-count watchdog primitives.
// killProcessGroup()'s guard table never calls the real process.kill — it's exercised via
// a stubbed exec/process seam so this suite can run identically on CI and a dev machine
// without ever signaling anything real. See ai/architecture/tt-claude-session-terminal.md
// § Process-group teardown + descendant watchdog (C1565) for the incident this closes.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
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
} = require('./process-group');
const { createSession } = require('./session-state');

// ── createSession() exposes the watchdog fields (task step 2's verification) ──

test('createSession() exposes ptyPid and descendantWatchdog, both initially null', () => {
  const session = createSession({}, false, 'C1', '');
  assert.equal(session.ptyPid, null);
  assert.equal(session.descendantWatchdog, null);
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
  const { byPgid, commOf } = parsePsOutput('  10  10  1\n  10  11  10\n');
  assert.deepEqual(byPgid.get(10), [10, 11]);
  assert.equal(commOf.size, 0);
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

test('evaluateRunaway warns on the first sweep at/above threshold and does not kill', () => {
  const state = freshState();
  const first = evaluateRunaway(state, 60);
  assert.deepEqual(first, { alert: true, kill: false, count: 60 });
  // The first sample of a session can never itself count as growth (lastCount starts at 0).
  assert.equal(state.growthStreak, 0);
});

test('evaluateRunaway: a stable count (54, 10 sweeps) warns exactly once and never kills', () => {
  const state = freshState();
  let alerts = 0;
  let kills = 0;
  for (let i = 0; i < 10; i++) {
    const { alert, kill } = evaluateRunaway(state, 54);
    if (alert) alerts++;
    if (kill) kills++;
  }
  assert.equal(alerts, 1);
  assert.equal(kills, 0);
});

test('evaluateRunaway: jitter around the threshold (54, 58, 53, 60) never kills', () => {
  const state = freshState();
  for (const count of [54, 58, 53, 60]) {
    assert.equal(evaluateRunaway(state, count).kill, false);
  }
});

test('evaluateRunaway: a burst that does not sustain (54 -> 79 -> 55) never kills', () => {
  const state = freshState();
  evaluateRunaway(state, 54);
  assert.equal(evaluateRunaway(state, 79).kill, false); // growthStreak 1
  assert.equal(evaluateRunaway(state, 55).kill, false); // shrank — streak resets
});

test('evaluateRunaway: a shrinking tree (127 -> 69) warns once but never kills', () => {
  const state = freshState();
  const first = evaluateRunaway(state, 127);
  assert.equal(first.alert, true);
  assert.equal(first.kill, false);
  const second = evaluateRunaway(state, 69);
  assert.equal(second.kill, false);
  assert.equal(second.alert, false); // still latched-alerted from the first sweep
  assert.equal(state.growthStreak, 0);
});

test('evaluateRunaway: sustained growth (52 -> 68 -> 86) warns at sweep 1, kills at sweep 3', () => {
  const state = freshState();
  const first = evaluateRunaway(state, 52);
  assert.equal(first.alert, true);
  assert.equal(first.kill, false);
  const second = evaluateRunaway(state, 68); // +16 — growthStreak 1
  assert.equal(second.kill, false);
  const third = evaluateRunaway(state, 86); // +18 — growthStreak 2 -> kill
  assert.equal(third.kill, true);
  assert.equal(third.alert, false); // the kill supersedes the warning
});

test('evaluateRunaway: a rise from below the threshold does not count as growth (34 -> 52 -> 68)', () => {
  const state = freshState();
  evaluateRunaway(state, 34); // below threshold — no alert, no streak
  const second = evaluateRunaway(state, 52); // crosses threshold, but prior sweep was below it
  assert.equal(second.kill, false);
  assert.equal(state.growthStreak, 0);
  const third = evaluateRunaway(state, 68); // first sweep that can count as growth
  assert.equal(third.kill, false);
  assert.equal(state.growthStreak, 1);
});

test('evaluateRunaway: a flat sweep breaks the growth streak (52, 68, 68, 86 never kills)', () => {
  const state = freshState();
  evaluateRunaway(state, 52);
  evaluateRunaway(state, 68); // growthStreak 1
  assert.equal(evaluateRunaway(state, 68).kill, false); // flat — streak resets to 0
  assert.equal(state.growthStreak, 0);
  assert.equal(evaluateRunaway(state, 86).kill, false); // growthStreak back to 1, not yet 2
});

test('evaluateRunaway: a slow climb under the growth threshold (+9/sweep) never kills below the ceiling', () => {
  const state = freshState();
  let count = 52;
  for (let i = 0; i < 10; i++) {
    count += 9;
    assert.equal(evaluateRunaway(state, count).kill, false);
  }
  assert.ok(count < 150);
});

test('evaluateRunaway kills at once at the ceiling, even on the first sweep', () => {
  const state = freshState();
  const result = evaluateRunaway(state, 150);
  assert.equal(result.kill, true);
  assert.equal(result.alert, false);
});

test('evaluateRunaway does not kill just under the ceiling on a first sweep', () => {
  const state = freshState();
  const result = evaluateRunaway(state, 149);
  assert.equal(result.kill, false);
  assert.equal(result.alert, true);
});

test('evaluateRunaway honors a per-state killCeiling override', () => {
  const state = { ...freshState(), killCeiling: 80 };
  assert.equal(evaluateRunaway(state, 79).kill, false);
  assert.equal(evaluateRunaway(state, 80).kill, true);
});

test('evaluateRunaway: a dip below threshold resets the growth streak (60 -> 40 -> 60 never kills)', () => {
  const state = freshState();
  const a = evaluateRunaway(state, 60);
  assert.equal(a.alert, true);
  assert.equal(a.kill, false);
  const b = evaluateRunaway(state, 40); // >= threshold/2 (25): alerted latch stays set
  assert.equal(b.alert, false);
  assert.equal(b.kill, false);
  assert.equal(state.growthStreak, 0);
  const c = evaluateRunaway(state, 60); // back up, but the sweep before it (40) was below threshold
  assert.equal(c.kill, false);
  assert.equal(state.growthStreak, 0);
});

test('evaluateRunaway latches a kill — a surviving tree reports kill again on later sweeps even if growth stops', () => {
  const state = freshState();
  evaluateRunaway(state, 52);
  assert.equal(evaluateRunaway(state, 68).kill, false);
  assert.equal(evaluateRunaway(state, 86).kill, true); // growthStreak reaches 2
  assert.equal(evaluateRunaway(state, 86).kill, true); // flat — still reports kill (latched)
  assert.equal(evaluateRunaway(state, 10).kill, true); // even a big drop still reports kill (latched)
});

test('evaluateRunaway tolerates a legacy state with no growthStreak/killed fields', () => {
  const state = { threshold: 50, lastCount: 0, lastAlertCount: 0, alerted: false };
  assert.equal(evaluateRunaway(state, 60).kill, false);
  assert.equal(state.growthStreak, 0);
  assert.equal(state.killed, false);
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
});

test('buildRunawayWarning states the session keeps running and appends a summary when given one', () => {
  const bare = buildRunawayWarning(54, 50, '');
  assert.match(bare, /^54 descendant processes/);
  assert.match(bare, /keeps running/);
  assert.equal(bare.includes('Top processes'), false);
  const withSummary = buildRunawayWarning(54, 50, 'npm ×24');
  assert.match(withSummary, /Top processes: npm ×24\./);
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
  const notices = [];
  const kills = [];
  const emits = [];
  return {
    notices, kills, emits,
    deps: {
      emitTerminalNotice: (session, text) => notices.push({ session, text }),
      killRunawaySession: (session, opts) => { kills.push({ session, opts }); session.alive = false; return { text: 'killed', first: true }; },
      emitSessionRunaway: (projectPath, detail) => emits.push({ projectPath, detail }),
      log: () => {},
    },
  };
}

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
