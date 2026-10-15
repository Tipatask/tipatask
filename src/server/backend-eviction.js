'use strict';

// (TPT673) Idle eviction for the per-project api-backend registries — the forked server's
// _backendInstances (index.js getBackendForPath()) and Electron main's _backendCache
// (main/window-state.js). Without it every project opened in an app session kept its
// backend (task caches, board-window cache, status/settings registries, listeners, and
// possibly a live reconnect timer) until the app quit.
//
// Rule: an entry is evicted only when, for a full idle window, the registry's isInUse()
// said no (no bound window / open socket / session / merge job — each registry supplies its
// own) AND its pending-mutation queue was empty. Queued offline writes are never dropped:
// a backend with pending writes counts as in use until its reconnect drains them.
//
// Pure: no Electron, no IO, no timers of its own — the owner calls sweep() on an interval.

const BACKEND_IDLE_EVICT_MS = 5 * 60_000;
const BACKEND_EVICT_SWEEP_MS = 60_000;

/**
 * @param {object} opts
 * @param {() => Iterable<[string, object]>} opts.entries  current [projectPath, backend] pairs
 * @param {(projectPath: string, backend: object) => boolean} opts.isInUse
 * @param {(projectPath: string, backend: object) => void} opts.evict  release + delete the entry
 * @param {number} [opts.idleMs]   how long an entry must stay unused before eviction
 * @param {() => number} [opts.now] TEST SEAM — clock
 * @param {(msg: string) => void} [opts.warn] TEST SEAM — defaults to console.warn
 * @returns {{ touch(projectPath: string): void, forget(projectPath: string): void, sweep(): string[] }}
 */
function createBackendEvictor({ entries, isInUse, evict, idleMs = BACKEND_IDLE_EVICT_MS, now = () => Date.now(), warn = console.warn }) {
  const _lastUsed = new Map(); // projectPath -> ms timestamp of the last access / in-use sweep

  function touch(projectPath) {
    _lastUsed.set(projectPath, now());
  }

  function forget(projectPath) {
    _lastUsed.delete(projectPath);
  }

  function _hasPendingWrites(backend) {
    try {
      return typeof backend?.getPendingMutationCount === 'function' && backend.getPendingMutationCount() > 0;
    } catch {
      return true; // unknown queue state — keep it
    }
  }

  function sweep() {
    const t = now();
    const evicted = [];
    for (const [projectPath, backend] of [...entries()]) {
      let inUse;
      try { inUse = !!isInUse(projectPath, backend); } catch { inUse = true; }
      if (inUse || _hasPendingWrites(backend)) {
        _lastUsed.set(projectPath, t);
        continue;
      }
      if (!_lastUsed.has(projectPath)) {
        // First sight of an entry nobody touched (created before the evictor existed): start its clock.
        _lastUsed.set(projectPath, t);
        continue;
      }
      if (t - _lastUsed.get(projectPath) < idleMs) continue;
      try {
        evict(projectPath, backend);
        evicted.push(projectPath);
      } catch (err) {
        warn(`[backend-eviction] evict failed for ${projectPath}: ${err && err.message}`);
      }
      _lastUsed.delete(projectPath);
    }
    // Clocks for entries some other path already removed.
    const live = new Set([...entries()].map(([p]) => p));
    for (const p of [..._lastUsed.keys()]) if (!live.has(p)) _lastUsed.delete(p);
    return evicted;
  }

  return { touch, forget, sweep };
}

module.exports = { createBackendEvictor, BACKEND_IDLE_EVICT_MS, BACKEND_EVICT_SWEEP_MS };
