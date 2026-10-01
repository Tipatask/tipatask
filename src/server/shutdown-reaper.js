'use strict';

// (TPT295) Every objective LLM child — turn, warm/cold prewarm, heartbeat, Haiku helpers — and every
// KB re-index Opus run is spawned `detached: true`, i.e. into its own process group, so the signal
// that stops this server never reaches it. Without this, quitting the app mid-turn left the running
// `claude -p` to finish and bill with no owner. Extracted out of index.js so it is unit-testable
// (requiring index.js stands up a real HTTP server) — same reason boot-kb-sync.js exists.
//
// Handled: SIGTERM (Electron main.js's app 'quit' -> serverChild.kill()), SIGINT (Ctrl+C on
// `node todo-server.js`) and the IPC 'disconnect' (Electron main gone without killing us — main never
// calls serverChild.disconnect() itself). Deliberately NOT SIGHUP: a listener would override the
// ignore `nohup` hands down, so closing that terminal would stop a server meant to outlive it.

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'];
// Time a SIGTERM'd child gets to exit cleanly before its group is SIGKILLed.
const SHUTDOWN_KILL_GRACE_MS = 500;

// Blocks the thread on purpose: no event-loop turn may run between SIGTERM and exit — no queued WS
// turn or timer can spawn a new child, and nothing writes to the stderr pipe of a parent that is gone.
function defaultSleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Tears down every objective/spec chat and kills every warm prewarm, the cold spare and every live
// headless run. Terminal (PTY) sessions are left alone: they are not detached, and exiting closes
// their pty masters, which hangs each pty session up. Returns the procs signalled.
function reapLlmChildren(sessions, reason, { claude, headless }) {
  const killed = [];
  for (const [key, session] of sessions) {
    if (session?.type !== 'objective' && session?.type !== 'specChat') continue;
    // Warm prewarms are keyed by the unscoped tab/task id, not the composite Map key.
    killed.push(...claude.teardownObjectiveSession(session, session.tabId || String(key).split('\0')[0], reason));
  }
  killed.push(...claude.killAllPrewarms(reason));
  killed.push(...headless.killAllHeadlessProcs(reason));
  return killed;
}

/**
 * @param {object} opts
 * @param {Map} opts.sessions            index.js's sessions map
 * @param {Function} [opts.recordExit]  Synchronous best-effort exit recorder
 * @param {object} [opts.claude]         TEST SEAM — defaults to claude-session.js
 * @param {object} [opts.headless]       TEST SEAM — defaults to headless-claude.js
 * @param {EventEmitter} [opts.proc]     TEST SEAM — defaults to `process`
 * @param {Function} [opts.exit]         TEST SEAM — defaults to process.exit
 * @param {Function} [opts.sleepSync]    TEST SEAM — defaults to a blocking Atomics.wait
 * @param {number} [opts.graceMs]
 * @returns {Function} shutdown(reason)
 */
function installShutdownReaper({
  sessions,
  recordExit = require('./last-exit').writeLastExit,
  claude = require('./claude-session'),
  headless = require('./headless-claude'),
  proc = process,
  exit = (code) => process.exit(code),
  sleepSync = defaultSleepSync,
  graceMs = SHUTDOWN_KILL_GRACE_MS,
} = {}) {
  let started = false;
  const shutdown = (reason) => {
    if (started) return; // quitting delivers SIGTERM and then 'disconnect' — reap once
    started = true;
    try {
      recordExit({ reason: SHUTDOWN_SIGNALS.includes(reason) ? `signal:${reason}` : reason, sessions });
    } catch { /* exit and child cleanup must still run */ }
    try {
      const killed = reapLlmChildren(sessions, reason, { claude, headless });
      // A proc Node already saw exit is gone. The rest may be dead but unreaped (the blocked loop
      // never collects them), which still pins their pid/pgid, so SIGKILL can't hit a recycled group.
      const pending = killed.filter(p => p.exitCode == null && p.signalCode == null);
      if (pending.length) {
        sleepSync(graceMs);
        for (const p of pending) claude.killObjectiveProc({ proc: p }, 'SIGKILL');
      }
      console.log(`[shutdown] ${reason}: SIGTERM ${killed.length} LLM proc group(s)` +
        (pending.length ? `, SIGKILL after ${graceMs}ms` : ''));
    } catch (err) {
      console.error(`[shutdown] ${reason}: reap failed: ${err && err.stack || err}`);
    } finally {
      // Always exit: a SIGTERM listener replaces Node's default exit. 0, not 128+signo — main.js's
      // serverChild 'exit' listener shows a "server stopped" error dialog for any non-zero code.
      exit(0);
    }
  };
  for (const sig of SHUTDOWN_SIGNALS) proc.on(sig, () => shutdown(sig));
  proc.on('disconnect', () => shutdown('ipc-disconnect'));
  return shutdown;
}

module.exports = { installShutdownReaper, reapLlmChildren, defaultSleepSync, SHUTDOWN_SIGNALS, SHUTDOWN_KILL_GRACE_MS };
