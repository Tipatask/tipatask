'use strict';

// (TPT356) Last-resort process-level error guard for the Task App server.
//
// A transport failure (ECONNRESET "socket hang up", ETIMEDOUT, ...) that surfaces as an
// 'error' event nobody listens for is thrown by EventEmitter as an uncaught exception, and
// Node's default response is to exit — one dropped TLS socket to the API killed the whole app
// and every open terminal/agent session with it. src/cli/http.js and api-backend.js now turn
// those into rejected calls, so this is the backstop for the next one that slips through:
//   - network-class errors are logged and the server keeps running;
//   - any other uncaught exception is still fatal (logged, then exit 1 — main.js reports a
//     non-zero exit to the user), because process state after an unknown throw is not trusted;
//   - unhandled rejections never exit (see the note on onUnhandledRejection).
//
// Kept out of index.js so it is unit-testable: requiring index.js stands up a real HTTP server.

// Transport-level failures that say "the network dropped this", not "this code is broken".
// EPIPE is deliberately absent: a broken stderr/IPC pipe means the parent is gone, and
// swallowing it here would make this guard's own log line re-trigger it forever.
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNABORTED',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

const MAX_CAUSE_DEPTH = 3;

// The network code of `err` or of anything in its `.cause` chain (api-backend.js and http.js
// wrap the raw socket error and copy its code, but a wrapper without one is still classified
// by what it wraps). null when this is not a network error.
function networkErrorCode(err) {
  let e = err;
  for (let depth = 0; e && typeof e === 'object' && depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof e.code === 'string' && NETWORK_ERROR_CODES.has(e.code)) return e.code;
    e = e.cause;
  }
  return null;
}

function isNetworkError(err) {
  return networkErrorCode(err) !== null;
}

function describe(err) {
  return (err && err.stack) || String(err);
}

/**
 * @param {object} [opts]
 * @param {EventEmitter} [opts.proc]  TEST SEAM — defaults to `process`
 * @param {Function} [opts.exit]      TEST SEAM — defaults to process.exit
 * @param {{error: Function}} [opts.log] TEST SEAM — defaults to console
 * @returns {{ onUncaughtException: Function, onUnhandledRejection: Function }}
 */
function installCrashGuard({
  proc = process,
  exit = (code) => process.exit(code),
  log = console,
} = {}) {
  let fatal = false;
  // Never let a failing log write (stderr already gone) throw out of the handler and recurse.
  const report = (line) => { try { log.error(line); } catch { /* nowhere left to report */ } };

  const onUncaughtException = (err) => {
    if (fatal) return; // already going down — don't re-enter with a second report/exit
    const code = networkErrorCode(err);
    if (code) {
      report(`[server] uncaught network error ${code} (kept alive): ${describe(err)}`);
      return;
    }
    fatal = true;
    report(`[server] fatal uncaught exception: ${describe(err)}`);
    exit(1);
  };

  // Rejections from background work have no request to answer, and the server has always
  // survived them (an unknown rejection does not corrupt state the way a mid-flight throw can),
  // so this stays log-only for every reason. Network ones are tagged so they are easy to grep.
  const onUnhandledRejection = (reason) => {
    const code = networkErrorCode(reason);
    report(code
      ? `[server] unhandled network rejection ${code} (kept alive): ${describe(reason)}`
      : `[server] unhandled rejection (kept alive): ${describe(reason)}`);
  };

  proc.on('uncaughtException', onUncaughtException);
  proc.on('unhandledRejection', onUnhandledRejection);
  return { onUncaughtException, onUnhandledRejection };
}

module.exports = { installCrashGuard, isNetworkError, networkErrorCode, NETWORK_ERROR_CODES };
