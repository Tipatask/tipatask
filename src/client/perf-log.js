// ── Click-to-render perf logging (C1259) ──
// Gated entirely on state.debugPerfLog (Settings ▸ Debug toggle, task-board.js
// applyProjectDebugPerfLog()/writeDebugPerfLog()) — off by default, silent no-op cost
// when off (perfStart() returns null immediately; perfEnd()/perfWrap() bail on a null
// handle). Timed spans are buffered and flushed to the server as NDJSON so they survive
// past a single console session — see POST/GET /api/debug/perf in ws-handlers.js and the
// Settings ▸ Debug row's "open log" affordance in template.html.
import state from './state.js';

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_MAX_ENTRIES = 20;
// Anything slower than this also gets a console.warn — matches the task's own
// "verify console timing logs show which click path exceeds 200ms" ask.
const WARN_THRESHOLD_MS = 200;

let _buffer = [];
let _flushTimer = null;

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(_flush, FLUSH_INTERVAL_MS);
}

async function _flush() {
  _flushTimer = null;
  if (_buffer.length === 0) return;
  const entries = _buffer;
  _buffer = [];
  try {
    if (window.electronAPI?.api?.debug?.perfLog) {
      await window.electronAPI.api.debug.perfLog(entries);
    } else {
      await fetch('/api/debug/perf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
    }
  } catch {
    // Best-effort — a logging failure must never surface to the user or affect the UI
    // it's trying to measure. Dropped entries are the acceptable cost.
  }
}

// Starts a timed span. Returns an opaque handle, or null when debug logging is off —
// every call site can unconditionally pass the handle straight to perfEnd(), which is
// itself a no-op on null. `label` should identify the click path, e.g. 'card-click',
// 'tag-filter-toggle', 'status-filter-toggle', 'sprint-collapse', 'chain-deps',
// 'edit-modal-open', 'load-and-render'. `meta` is optional free-form context (task id,
// tab name, phase) merged into the flushed entry.
export function perfStart(label, meta) {
  if (!state.debugPerfLog) return null;
  return { label, meta, t0: performance.now() };
}

// Ends a span started by perfStart(). No-op if handle is null (logging was off, or this
// call site never checked — always safe to call).
export function perfEnd(handle, extraMeta) {
  if (!handle) return;
  const ms = performance.now() - handle.t0;
  const meta = extraMeta ? { ...(handle.meta || {}), ...extraMeta } : handle.meta || null;
  _buffer.push({ label: handle.label, ms: Math.round(ms * 100) / 100, meta, at: Date.now() });
  if (ms > WARN_THRESHOLD_MS) {
    console.warn(`[perf] ${handle.label} took ${ms.toFixed(1)}ms`, meta || '');
  }
  if (_buffer.length >= FLUSH_MAX_ENTRIES) _flush();
  else _scheduleFlush();
}

// Wraps a function (sync or async) with a timed span sharing perfStart()/perfEnd()'s
// zero-cost-when-off contract — a one-line way to instrument an existing handler body
// without restructuring it. Awaits the result if it's a promise.
export function perfWrap(label, fn, meta) {
  const handle = perfStart(label, meta);
  if (!handle) return fn();
  let result;
  try {
    result = fn();
  } catch (err) {
    perfEnd(handle, { threw: true });
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(() => perfEnd(handle));
  }
  perfEnd(handle);
  return result;
}
