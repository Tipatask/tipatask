// Pure breadcrumb helper: walk parentDbId through the full dbId-keyed task
// index to recover the root-to-current chain after navigation resets the stack.

export const MAX_ANCESTOR_DEPTH = 32;

// Returns [{ taskKey, title }, …] ordered ROOT → nearest ancestor (i.e. everything above
// `startParentDbId`'s own task, that task included last). `tasks` is any array of rows
// carrying { dbId, parentDbId, id (task_key), title } — extra fields are ignored.
//
// Stops (returns whatever was collected so far) on: a null/undefined starting id, an id not
// present in the index (the row is outside the fetched list — e.g. filtered out, or an
// unfinalized reservation placeholder), a cycle (defensive — parent_id is DB-enforced acyclic,
// this is a client-side backstop against a corrupt/stale snapshot), or maxDepth. Never throws.
export function buildAncestorCrumbs(startParentDbId, tasks, { maxDepth = MAX_ANCESTOR_DEPTH } = {}) {
  if (startParentDbId == null || !Array.isArray(tasks)) return [];

  const byDbId = new Map();
  for (const row of tasks) {
    if (row && row.dbId != null) byDbId.set(row.dbId, row);
  }

  const nearestFirst = [];
  const seen = new Set();
  let currentId = startParentDbId;
  let depth = 0;

  while (currentId != null && depth < maxDepth) {
    if (seen.has(currentId)) break; // cycle guard
    const row = byDbId.get(currentId);
    if (!row || !row.id) break; // unknown/reservation-filtered ancestor — chain truncates here
    seen.add(currentId);
    nearestFirst.push({ taskKey: row.id, title: row.title });
    currentId = row.parentDbId ?? null;
    depth++;
  }

  return nearestFirst.reverse();
}
