'use strict';

// (TPT668) Connection-state + offline-drain broadcasts for one api-backend instance.
// index.js attaches this to the module singleton (unscoped, behind the C1356
// isSingletonUnbound() guard) and to every per-project instance getBackendForPath()
// creates (scoped to that project via broadcastToProject). Without it, a write queued
// offline in a per-project instance replayed with no api-status, no task:* frames and
// no mutations-dropped frame reaching any client.
//
// Listener Sets live inside each createApiBackend() closure, so attaching here only adds
// two callbacks to that instance. The WeakMap makes a second attach a no-op — no duplicate
// frames, no listener growth — and keeps the unsubscribe functions the two registrars
// return, so detachBackendBroadcasts() can remove them when the instance is evicted (TPT673).

const _attached = new WeakMap(); // instance -> [unsubscribe, ...]

// opts: { websocket, projectPath?, skipState? }
//   projectPath — '' / undefined = unscoped broadcast() (the singleton)
//   skipState   — () => bool; true suppresses the state listener's api-status frame
// Returns true when listeners were attached, false when skipped.
function attachBackendBroadcasts(instance, { websocket, projectPath, skipState } = {}) {
  if (!instance || !websocket) return false;
  if (typeof instance.onConnectionStateChange !== 'function' || typeof instance.onMutationsDrained !== 'function') return false;
  if (_attached.has(instance)) return false;

  const scope = projectPath || undefined;
  const logPrefix = scope ? `[api-backend ${scope}]` : '[api-backend]';

  const unsubState = instance.onConnectionStateChange((state, message) => {
    console.log(`${logPrefix} state → ${state}${message ? ` (${message})` : ''}`);
    if (skipState && skipState()) return;
    websocket.emitApiStatus(state, message, instance.getPendingMutationCount(), instance.getPendingTaskIds(), scope);
  });

  const unsubDrain = instance.onMutationsDrained((replayedTasks, remaining, dropped) => {
    // (TPT662) Entries the drain gave up on — surfaced, never only console.warn'd.
    if (Array.isArray(dropped) && dropped.length) websocket.emitMutationsDropped(dropped, scope);
    websocket.emitApiStatus(
      remaining > 0 ? 'reconnecting' : 'connected',
      remaining > 0 ? `Reconnected — ${remaining} updates still queued` : null,
      remaining,
      instance.getPendingTaskIds(),
      scope,
    );
    for (const t of replayedTasks || []) {
      if (t._deleted) {
        websocket.emitTaskDeleted(t.id, scope);
      } else if (t._replacedTmpId) {
        websocket.emitTaskDeleted(t._replacedTmpId, scope);
        websocket.emitTaskCreated(t, scope);
      } else {
        websocket.emitTaskUpdated(t, undefined, scope);
      }
    }
  });

  _attached.set(instance, [unsubState, unsubDrain].filter(fn => typeof fn === 'function'));
  return true;
}

// Removes the listeners attachBackendBroadcasts() added to `instance`. Returns true when
// something was attached. A later attach on the same instance attaches afresh.
function detachBackendBroadcasts(instance) {
  if (!instance || !_attached.has(instance)) return false;
  const unsubs = _attached.get(instance);
  _attached.delete(instance);
  for (const fn of unsubs) {
    try { fn(); } catch (e) { console.warn('[backend-broadcasts] unsubscribe failed:', e.message); }
  }
  return true;
}

module.exports = { attachBackendBroadcasts, detachBackendBroadcasts };
