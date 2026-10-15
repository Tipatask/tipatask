'use strict';

// (C1353) Extracted from file-ops.js — pure, backend-agnostic, so it survived the file task
// backend's retirement (C1352) unchanged. Kept standalone rather than folded into
// reservation-placeholder.js: that module is a single narrow predicate deliberately kept
// dependency-free; this is a different concern (C-id/H-id collision arbitration with
// dependency/parentId rewriting) that merely consults the predicate.

const { isReservationPlaceholder } = require('./reservation-placeholder');
const { parseTaskKey, maxNumbersByPrefix, reconcileNextNumber, SUSPECT_KEY_GAP } = require('./task-key-format');

// ── ID collision remap ──
// Compares incomingTasks against liveTasks. If a task in incoming has an ID
// that already exists in live with DIFFERENT content (= another tab's new task
// landed first), it's a collision: reassign to the next available ID and remap
// all dependency / parentId references across the full incoming list.
// Tasks that are bit-identical to their live counterpart (idempotent re-PUT)
// are left untouched. Returns { tasks: [...], idRemap: Map<oldId, newId> }.
//
// C1483: next-number tracking is per-prefix (maxNumbersByPrefix), not a single global
// C/H pair — a colliding key is remapped to its OWN prefix (TPT214 -> TPT<next>, not a
// literal C<next>). A colliding id that isn't itself key-shaped (shouldn't happen — see
// below) falls back to the legacy 'C' prefix rather than throwing.
//
// TPT9004: a remapped id only labels the proposal — the save path (api-backend.js
// assignIncomingNewTaskIds()) reserves the real key through the API — but it must still be
// a number the allocator would recognize, not a local guess. `opts.peekByPrefix`
// (Map<prefix, number>, from GET /tasks/next-key via ws-handlers.js fetchNextKeyPeeks())
// seeds each prefix's counter with the API's own next number when known; the local
// max + 1 is the fallback. A local number more than SUSPECT_KEY_GAP above the peek is
// evidence of keys written around the allocator: it is reported through `opts.log` (default
// console.warn) and the peek-based number is used. Every candidate steps past live and
// incoming ids, so a remapped id never names an existing row. `liveTasks` must be the
// include_reservations=true list (getTasksUnfiltered()): reserved keys are taken too.
function remapCollidingIds(incomingTasks, liveTasks, { peekByPrefix = null, log = console.warn } = {}) {
  const liveMap = new Map(liveTasks.map(t => [t.id, t]));
  const taken = new Set(liveMap.keys());
  for (const t of incomingTasks) if (t && t.id) taken.add(t.id);

  const localMax = maxNumbersByPrefix(liveTasks);
  const nextByPrefix = new Map();
  const nextForPrefix = (prefix) => {
    if (!nextByPrefix.has(prefix)) {
      const localNext = (localMax.get(prefix) ?? 0) + 1;
      const peekNext = peekByPrefix && typeof peekByPrefix.get === 'function' ? peekByPrefix.get(prefix) : undefined;
      const r = reconcileNextNumber({ prefix, localNext, peekNext, taken });
      if (r.suspect && typeof log === 'function') {
        log(`[id-remap] local next key ${prefix}${localNext} is more than ${SUSPECT_KEY_GAP} above the API peek ${prefix}${peekNext} — keys were minted around the allocator; using ${prefix}${r.next}`);
      }
      nextByPrefix.set(prefix, r.next);
    }
    let n = nextByPrefix.get(prefix);
    while (taken.has(`${prefix}${n}`)) n += 1;
    nextByPrefix.set(prefix, n + 1);
    return n;
  };

  const idRemap = new Map();
  const tasks = incomingTasks.map(t => ({ ...t }));

  for (const t of tasks) {
    if (!liveMap.has(t.id)) continue;
    const live = liveMap.get(t.id);
    // A live reservation placeholder with this id is exactly the intended target —
    // the planner's reserve_task_keys row waiting to be finalized in place, not a
    // collision (C1017/C980). Same title/description would never match anyway since
    // the placeholder always carries the sentinel title/description.
    if (isReservationPlaceholder(live)) continue;
    // Same title + description = idempotent re-PUT, not a collision
    if (live.title === t.title && live.description === t.description) continue;
    // Colliding id is always key-shaped in practice — it just matched a live row's
    // exact id — but degrade to 'C' instead of throwing if parseTaskKey ever can't
    // split it (e.g. a dashed epic key some future caller lets through this path).
    const prefix = (parseTaskKey(t.id) || {}).prefix || 'C';
    const newId = `${prefix}${nextForPrefix(prefix)}`;
    taken.add(newId);
    idRemap.set(t.id, newId);
    t.id = newId;
  }

  if (idRemap.size > 0) {
    for (const t of tasks) {
      if (Array.isArray(t.dependencies)) {
        t.dependencies = t.dependencies.map(dep => idRemap.get(dep) || dep);
      }
      if (t.parentId && idRemap.has(t.parentId)) {
        t.parentId = idRemap.get(t.parentId);
      }
    }
  }

  return { tasks, idRemap };
}

module.exports = { remapCollidingIds };
