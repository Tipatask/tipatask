#!/usr/bin/env node
'use strict';

// Spawn a bounded parent-child chain through node-pty, plus one detached subtree that
// escapes the chain's process group. Confirm evaluateRunaway() warns, then kills once
// sustained growth is observed (TPT370: 2 consecutive sweeps that each grew by >=10 while
// at/above the warn threshold), before 100 descendants, and that killRunawaySession() leaves
// no survivor, including the detached sleeper. Each level of the chain sleeps briefly before
// recursing so the tree climbs gradually across sample windows instead of forking as fast as
// possible and then sitting flat — a flat tree is exactly the "healthy session" case the new
// rule must NOT kill (see process-group.test.js's stable-count tests). MAX_DEPTH caps growth
// even if assertions fail. The single-sweep DESCENDANT_KILL_CEILING path is covered by
// process-group.test.js.
// Usage: npm run probe:watchdog

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const {
  DESCENDANT_ALERT_THRESHOLD,
  killProcessGroup,
  snapshotProcesses,
  countDescendants,
  evaluateRunaway,
} = require('../src/server/process-group');
const { killRunawaySession } = require('../src/server/terminal-session');

const MAX_DEPTH = 120; // comfortably above DESCENDANT_ALERT_THRESHOLD (50), below DESCENDANT_KILL_CEILING (150)
const LEVEL_DELAY_S = '0.1'; // per-level sleep before recursing — see the growth-cadence note above
const POLL_MS = 2000; // wide enough that ~20 new levels (~LEVEL_DELAY_S apart) appear between samples
const GROW_TIMEOUT_MS = 30000;
const SLEEPER_WAIT_MS = 5000;
const KILL_SETTLE_MS = 2500; // must outlast killRunawaySession()'s 1500ms SIGKILL follow-up
const HARD_CEILING_MS = 60000; // absolute wall-clock backstop — see the top-level guard below

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function fail(message) {
  console.error(`[probe:watchdog] FAIL — ${message}`);
  process.exitCode = 1;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// The guarded fork chain itself — the incident report's §7.3 guard.js pattern, translated
// to a plain recursive shell script so it needs nothing but /bin/bash: each level writes
// its depth to a shared counter file, then (below MAX_DEPTH) spawns itself as a FOREGROUND
// child and blocks on it — exactly the incident's "every level alive, blocked on its own
// child, none exit" shape — until the hard cap is hit, at which point it just sleeps
// instead of recursing further. No `exec` anywhere (exec would replace the process image
// in place and never grow the process count at all). Level 1 additionally launches the
// escaped-subtree holder in the background (same pgid as the chain, no job control).
const CHAIN_SCRIPT = `#!/bin/bash
SELF="$0"
COUNTER_FILE="$1"
MAX_DEPTH="$2"
HOLDER_NODE="$3"
HOLDER_JS="$4"
SLEEPER_FILE="$5"
LEVEL_DELAY="$6"
n=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "$COUNTER_FILE"
if [ "$n" -eq 1 ]; then
  "$HOLDER_NODE" "$HOLDER_JS" "$SLEEPER_FILE" &
fi
sleep "$LEVEL_DELAY"
if [ "$n" -lt "$MAX_DEPTH" ]; then
  bash "$SELF" "$COUNTER_FILE" "$MAX_DEPTH" "$HOLDER_NODE" "$HOLDER_JS" "$SLEEPER_FILE" "$LEVEL_DELAY"
else
  sleep 300
fi
`;

// The escaped subtree: stays alive itself (a child of the chain, in its pgid) and spawns a
// `detached: true` sleeper — setsid(), so the sleeper leads its OWN process group and a
// -rootPid group kill never reaches it. Self-capped (exits after 90s; the sleeper after 300s)
// so a failed probe can never leave either running indefinitely.
const HOLDER_SCRIPT = `'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const sleeper = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
sleeper.unref();
fs.writeFileSync(process.argv[2], String(sleeper.pid));
setTimeout(() => process.exit(0), 90000);
`;

async function main() {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-watchdog-probe-'));
  const scriptPath = path.join(scratchDir, 'fork-chain.sh');
  const holderPath = path.join(scratchDir, 'holder.js');
  const counterPath = path.join(scratchDir, 'counter.txt');
  const sleeperPath = path.join(scratchDir, 'sleeper.pid');
  fs.writeFileSync(scriptPath, CHAIN_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(holderPath, HOLDER_SCRIPT);
  fs.writeFileSync(counterPath, '0');

  console.log(`[probe:watchdog] Spawning guarded fork chain (MAX_DEPTH=${MAX_DEPTH}, warn threshold=${DESCENDANT_ALERT_THRESHOLD}) plus one detached-sleeper subtree...`);
  const ptyProcess = pty.spawn('/bin/bash', [scriptPath, counterPath, String(MAX_DEPTH), process.execPath, holderPath, sleeperPath, LEVEL_DELAY_S], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: scratchDir,
    env: process.env,
  });
  const rootPid = ptyProcess.pid;
  console.log(`[probe:watchdog] Root pid ${rootPid} (pgid should equal pid — forkpty implies setsid).`);

  let sleeperPid = null;
  const readSleeperPid = () => {
    try {
      const n = Number(fs.readFileSync(sleeperPath, 'utf8').trim());
      return Number.isFinite(n) && n > 1 ? n : null;
    } catch { return null; }
  };

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    killProcessGroup(rootPid, 'SIGKILL');
    try { ptyProcess.kill('SIGKILL'); } catch { /* already dead */ }
    // The escaped sleeper is in its own group — the -rootPid kill above never reaches it.
    const escaped = sleeperPid || readSleeperPid();
    if (escaped) {
      killProcessGroup(escaped, 'SIGKILL');
      try { process.kill(escaped, 'SIGKILL'); } catch { /* already dead */ }
    }
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  };

  // Absolute wall-clock backstop — if a bug anywhere below makes the probe hang, this
  // guarantees the fork chain and the probe process itself both still get torn down.
  const hardCeiling = setTimeout(async () => {
    console.error(`[probe:watchdog] FAIL — hard ceiling (${HARD_CEILING_MS}ms) reached, force-cleaning up.`);
    await cleanup();
    process.exit(1);
  }, HARD_CEILING_MS);
  hardCeiling.unref?.();

  try {
    // ── Step 1: warn first, then kill — both before ~100 processes ──
    const state = { threshold: DESCENDANT_ALERT_THRESHOLD, lastCount: 0, lastAlertCount: 0, alerted: false, growthStreak: 0, killed: false };
    const growStart = Date.now();
    let warnedAt = null;
    let killedAt = null;
    while (Date.now() - growStart < GROW_TIMEOUT_MS) {
      const snapshot = await snapshotProcesses();
      if (snapshot) {
        const count = countDescendants(snapshot, rootPid);
        const { alert, kill } = evaluateRunaway(state, count);
        if (alert && warnedAt == null) {
          warnedAt = count;
          console.log(`[probe:watchdog] warn at ${count} descendants (>= threshold ${DESCENDANT_ALERT_THRESHOLD}).`);
        }
        if (kill) { killedAt = count; break; }
        if (count >= 100) break; // safety valve — should never happen before the kill fires
      }
      await sleep(POLL_MS);
    }

    if (killedAt == null) {
      fail(`watchdog never reached a kill decision within ${GROW_TIMEOUT_MS}ms (last observed count: ${state.lastCount}).`);
    } else if (warnedAt == null) {
      fail(`watchdog decided to kill at ${killedAt} descendants WITHOUT warning first — expected warn-then-kill.`);
    } else if (killedAt >= 100) {
      fail(`watchdog killed at ${killedAt} descendants — expected well below 100.`);
    } else {
      console.log(`[probe:watchdog] PASS — warned at ${warnedAt}, then kill decision at ${killedAt} descendants (< 100, warn came first).`);
    }

    // ── Step 2: kill via the production path; zero survivors, escaped sleeper gone ──
    const waitStart = Date.now();
    while (!(sleeperPid = readSleeperPid()) && Date.now() - waitStart < SLEEPER_WAIT_MS) await sleep(50);
    if (!sleeperPid) {
      fail(`the escaped detached sleeper never appeared within ${SLEEPER_WAIT_MS}ms — cannot verify the escaped-subtree kill.`);
    } else {
      console.log(`[probe:watchdog] Escaped detached sleeper pid ${sleeperPid} (leads its own process group).`);
    }

    // Fresh snapshot so the escaped subtree is certainly in it (production kills with the same
    // sweep's snapshot the count came from; here the count came from an earlier poll).
    const killSnapshot = await snapshotProcesses();
    if (!killSnapshot) {
      fail('could not take a ps snapshot to drive the kill.');
    } else {
      const session = { tabId: 'PROBE', alive: true, ptyPid: rootPid, pty: ptyProcess, buffer: '', ws: null, _exitReason: null };
      console.log('[probe:watchdog] Killing the tree via killRunawaySession() (killProcessTree: SIGTERM, then SIGKILL follow-up)...');
      const result = killRunawaySession(session, { count: killedAt, threshold: state.threshold, snapshot: killSnapshot });
      if (!result || !result.first) fail('killRunawaySession() did not act on a live session.');
      else if (!session._exitReason || session._exitReason.kind !== 'runaway-killed') fail('killRunawaySession() did not record the runaway-killed exit reason.');
      else if (!session.buffer.includes('[Task App]')) fail('killRunawaySession() did not write its notice into the session buffer.');
      else console.log('[probe:watchdog] PASS — exit reason recorded (runaway-killed) and notice written to the session buffer.');
    }
    await sleep(KILL_SETTLE_MS);

    const postKillSnapshot = await snapshotProcesses();
    if (!postKillSnapshot) {
      fail('could not take a post-kill ps snapshot to verify the tree is gone.');
    } else {
      const survivors = countDescendants(postKillSnapshot, rootPid);
      if (survivors > 0) {
        fail(`${survivors} descendant process(es) survived the tree kill — orphaned chain, exactly the C65/C128 failure mode.`);
      } else {
        console.log('[probe:watchdog] PASS — zero surviving descendants after the tree kill (ps check).');
      }
    }

    if (sleeperPid) {
      if (pidAlive(sleeperPid)) {
        fail(`escaped detached sleeper pid ${sleeperPid} survived — a plain -rootPid group kill would leave exactly this behind.`);
      } else {
        console.log(`[probe:watchdog] PASS — escaped detached sleeper ${sleeperPid} is gone (ESRCH).`);
      }
    }
  } finally {
    clearTimeout(hardCeiling);
    await cleanup();
  }

  if (process.exitCode) {
    console.error('[probe:watchdog] One or more checks FAILED — see above.');
  } else {
    console.log('[probe:watchdog] All checks passed.');
  }
}

main().catch(async (err) => {
  console.error('[probe:watchdog] Uncaught error:', err);
  process.exitCode = 1;
});
