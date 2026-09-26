'use strict';

// Circuit breaker + request queue for objective-chat backend calls.
// Singleton — one state machine per server process.

const config = require('./config');
const STALL_TIMEOUT_MS = 120000;
const _watchdogs = new Map();

function clearWatchdog(taskId) {
  const watch = _watchdogs.get(taskId);
  if (watch) clearTimeout(watch.timer);
  _watchdogs.delete(taskId);
}

// Opt-in per active slot. Internal provider retries reuse the same timer; only
// stream output refreshes it. The returned callback cannot touch a later turn.
function watchTurn(taskId, onStall) {
  if (!_state.active.has(taskId)) return () => {};
  let watch = _watchdogs.get(taskId);
  if (!watch) {
    watch = { timer: null, onStall };
    _watchdogs.set(taskId, watch);
  } else {
    watch.onStall = onStall;
  }
  const touch = () => {
    if (_watchdogs.get(taskId) !== watch) return;
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => {
      if (_watchdogs.get(taskId) !== watch) return;
      try { watch.onStall(); }
      catch (err) { console.error(`[throttle] Stall cleanup failed for task ${taskId}:`, err.message); }
      finally {
        // Provider normally releases through its error emitter. Still release
        // if cleanup or sending the frame throws; never release a replacement.
        if (_watchdogs.get(taskId) === watch) recordTimeout(taskId, 'stream-stalled');
      }
    }, STALL_TIMEOUT_MS);
    watch.timer.unref?.();
  };
  if (!watch.timer) touch();
  return touch;
}

const _state = {
  consecutiveTimeouts: 0,
  circuitState: 'closed', // 'closed' | 'open' | 'half-open'
  openedAt: null,
  active: new Set(),   // taskIds with in-flight turns
  pending: [],         // FIFO: { taskId, runFn, rejectFn }
};

const _listeners = [];

function subscribe(fn) {
  _listeners.push(fn);
}

function _notify() {
  const status = getStatus();
  for (const fn of _listeners) {
    try { fn(status); } catch {}
  }
}

function getStatus() {
  return {
    active: _state.active.size,
    pending: _state.pending.length,
    circuitState: _state.circuitState,
    consecutiveTimeouts: _state.consecutiveTimeouts,
    openedAt: _state.openedAt,
  };
}

function _drainNext() {
  if (_state.pending.length === 0) return;
  if (_state.active.size >= config.OBJECTIVE_MAX_CONCURRENT) return;
  const next = _state.pending.shift();
  _state.active.add(next.taskId);
  _notify();
  console.log(`[throttle] Draining queued task ${next.taskId} (active=${_state.active.size}, pending=${_state.pending.length})`);
  try { next.runFn(); } catch (err) {
    console.error(`[throttle] runFn error for task ${next.taskId}:`, err.message);
    clearWatchdog(next.taskId);
    _state.active.delete(next.taskId);
    _drainNext();
    _notify();
  }
}

function _removeActive(taskId) {
  clearWatchdog(taskId);
  _state.active.delete(taskId);
  _drainNext();
  _notify();
}

function _rejectAllPending(reason) {
  const drained = _state.pending.splice(0);
  for (const entry of drained) {
    if (entry.rejectFn) {
      try { entry.rejectFn(reason); } catch {}
    }
  }
  if (drained.length) {
    console.log(`[throttle] Rejected ${drained.length} queued entries — ${reason}`);
    _notify();
  }
}

/**
 * Gate a new objective turn. If the circuit is open or the queue is full,
 * returns { ok: false, status: 503, reason, queueDepth, circuitState }.
 * Otherwise runs immediately or enqueues. Returns { ok: true }.
 *
 * @param {string} taskId
 * @param {Function} runFn - called when the turn is allowed to start
 * @param {Function} [rejectFn] - called with (reason) if enqueued request is later
 *   rejected (e.g. circuit opens while queued). Must handle WS send + message cleanup.
 */
function requestTurn(taskId, runFn, rejectFn) {
  // ── Circuit breaker check ──
  if (_state.circuitState === 'open') {
    const elapsed = Date.now() - _state.openedAt;
    if (elapsed < config.OBJECTIVE_CB_OPEN_MS) {
      return {
        ok: false,
        status: 503,
        reason: 'circuit-open',
        queueDepth: _state.pending.length,
        circuitState: _state.circuitState,
      };
    }
    // Cool-down elapsed — allow one probe in half-open state
    console.log('[throttle] Circuit breaker → half-open (probe)');
    _state.circuitState = 'half-open';
    _notify();
  }

  // ── Queue depth guard ──
  if (_state.pending.length >= config.OBJECTIVE_QUEUE_MAX) {
    return {
      ok: false,
      status: 503,
      reason: 'queue-full',
      queueDepth: _state.pending.length,
      circuitState: _state.circuitState,
    };
  }

  // ── Run immediately or enqueue ──
  if (_state.active.size < config.OBJECTIVE_MAX_CONCURRENT) {
    _state.active.add(taskId);
    _notify();
    try { runFn(); } catch (err) {
      console.error(`[throttle] runFn error for task ${taskId}:`, err.message);
      clearWatchdog(taskId);
      _state.active.delete(taskId);
      _notify();
    }
  } else {
    _state.pending.push({ taskId, runFn, rejectFn });
    _notify();
    console.log(`[throttle] Queued task ${taskId} (active=${_state.active.size}, pending=${_state.pending.length})`);
  }

  return { ok: true };
}

/**
 * Called on successful turn delivery (finalizeCloseTurn success path).
 * Resets consecutive-timeout counter, closes circuit if half-open.
 */
function recordSuccess(taskId) {
  if (_state.circuitState === 'half-open') {
    console.log('[throttle] Circuit breaker → closed (probe succeeded)');
    _state.circuitState = 'closed';
    _state.openedAt = null;
  }
  _state.consecutiveTimeouts = 0;
  _removeActive(taskId);
}

/**
 * Called from emitObjectiveError (final failure after retries exhausted).
 * Increments timeout counter; opens circuit at threshold.
 */
function recordTimeout(taskId, reason) {
  _state.consecutiveTimeouts++;
  console.log(`[throttle] Timeout for task ${taskId} (reason=${reason}, consecutive=${_state.consecutiveTimeouts})`);

  if (_state.circuitState === 'half-open') {
    console.log('[throttle] Circuit breaker → open (probe failed)');
    _state.circuitState = 'open';
    _state.openedAt = Date.now();
    _rejectAllPending('circuit-open');
  } else if (_state.circuitState === 'closed' && _state.consecutiveTimeouts >= config.OBJECTIVE_CB_TIMEOUT_THRESHOLD) {
    console.log(`[throttle] Circuit breaker → open (${_state.consecutiveTimeouts} consecutive timeouts)`);
    _state.circuitState = 'open';
    _state.openedAt = Date.now();
    _rejectAllPending('circuit-open');
  }

  _removeActive(taskId);
}

/**
 * Called on user-initiated abort / restart / kill, chat teardown, and by a runFn that bails early.
 * Removes every queued (not yet started) entry for taskId, then its active slot.
 * Does not affect the timeout counter.
 */
function recordAbort(taskId) {
  // Purge this task's queued (not yet started) turns FIRST: releasing its active slot drains the
  // queue, which would otherwise start the very turn being aborted.
  const before = _state.pending.length;
  _state.pending = _state.pending.filter(e => e.taskId !== taskId);
  if (_state.pending.length !== before) _notify();
  if (_state.active.has(taskId)) {
    _removeActive(taskId);
  }
}

module.exports = { requestTurn, recordSuccess, recordTimeout, recordAbort, getStatus, subscribe, watchTurn, STALL_TIMEOUT_MS };
