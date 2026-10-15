// (TPT9014) The error toast for a queued task start the server refused when it left the start
// queue. Play All and the bulk bar's Start take a `session-queued` reply as success and close
// their socket, so a refusal on drain (EASSIGNEE, ECLAIM, EAUTH, ESTART) reaches the board only
// as a `session-ended` broadcast with `reason: 'start-failed'` and the `error` frame the terminal
// would have shown. Both session-ended handlers (attention-ws.js on `__attention__`, template.html
// on `__board__`) hand that frame here. Refusals arriving together — one drain refuses every
// queued start of a revoked token — share one toast, since every toast occupies the same corner;
// the text is startFailureText()'s, the same as toastStartFailures() (task-board.js) shows.

import { startFailureText } from './terminal-frame-text.js';
import { showToast } from './utils.js';
import { handleQueuedStartEnded } from './queued-start-rollback.js';

// Same hold as toastStartFailures(): a refusal names a cause the user has to act on.
const START_ERROR_TOAST_MS = 10000;
// How long the first refusal waits for others from the same drain before the toast goes up.
const COALESCE_MS = 300;

let pending = [];
let timer = null;

function flush() {
  const starts = pending;
  pending = [];
  timer = null;
  const text = startFailureText(starts);
  if (text) showToast(text, 'error', { durationMs: START_ERROR_TOAST_MS });
}

// Returns true when `msg` carried a refusal to report. Any other session-ended (a Terminate, a
// canceled queued start, an older server's frame without `error`) is left alone.
export function reportStartFailure(msg) {
  handleQueuedStartEnded(msg);
  if (!msg || msg.reason !== 'start-failed' || !msg.taskId) return false;
  if (!msg.error || msg.error.type !== 'error') return false;
  if (pending.some((start) => start.id === msg.taskId)) return true;
  pending.push({ id: msg.taskId, result: { ok: false, message: msg.error } });
  if (!timer) timer = setTimeout(flush, COALESCE_MS);
  return true;
}
