'use strict';

// Retroactive dep-aware priority heal for the MCP update_task tool (C1053).
// Sibling of create_task's own dep-aware assignment (C1052) — both call
// sprint-assign.js's minStepForDeps() directly rather than the changes[]/pinned-id
// shaped healDependencyOrdering(), which belongs to the bulk POST /api/resolve-sprints
// flow. Kept dependency-free of server.js/priority-fallback.js (no env/IO here) so it
// stays trivially unit-testable — mirrors the priority-fallback.js pattern.

const { minStepForDeps } = require('../server/sprint-assign');

// C1187 — legacy default for the optional `activeStatuses` param below. Callers with a
// real backend should resolve the project's own active set via status-roles.js's
// fetchStatusContext() and pass it in; omitting it degrades to this literal set.
const ACTIVE_CASCADE_STATUSES = new Set(['pending', 'in_progress', 'on_fire']);

// Resolve the priority for a task whose `dependencies` are being patched via
// update_task. Bumps the task above every dep's sprint (priority) when it currently
// sits at or below one, then cascades the bump to any active task that depends on
// it (transitively), so a mid-graph bump doesn't leave downstream tasks stranded in
// the same or a lower sprint than their (now-moved) dependency.
//
// Backlog (priority <= 0) is exempt in both directions: a backlog task is never
// bumped, and a backlog dep never constrains anything (mirrors minStepForDeps and
// resolveAndAssign's existing backlog semantics).
//
// @param {object} params
// @param {string} params.taskId - id of the task being patched
// @param {Array<string>} params.dependencies - the new dependency list (already
//   normalized; self-references should be filtered by the caller)
// @param {number} params.currentPriority - the task's effective priority (patch's
//   own `priority` field if present, else its current stored priority)
// @param {Array} params.tasks - full task snapshot (id, priority, status, dependencies)
// @param {Set<string>|Array<string>} [params.activeStatuses] this project's active-status
//   set (C1187) — defaults to the legacy pending/in_progress/on_fire set. Only gates
//   which DEPENDENTS are eligible for the cascade step; the priorityMap itself is built
//   from ALL tasks regardless (deliberate asymmetry vs applyDependencyFloor — see
//   tt-task-board-sprint-groups.md § Consumers of minStepForDeps).
// @returns {{ priority: number, bumped: boolean, cascade: Array<{id, from, to}> }}
function resolveDepAwareUpdate({ taskId, dependencies, currentPriority, tasks, activeStatuses = ACTIVE_CASCADE_STATUSES }) {
  const list = Array.isArray(tasks) ? tasks : [];
  const activeSet = activeStatuses instanceof Set ? activeStatuses : new Set(activeStatuses);
  const deps = (Array.isArray(dependencies) ? dependencies : []).filter(d => d && d !== taskId);
  const startPriority = typeof currentPriority === 'number' ? currentPriority : 0;

  const priorityMap = new Map();
  for (const t of list) {
    if (t && t.id) priorityMap.set(t.id, typeof t.priority === 'number' ? t.priority : 0);
  }
  // Overlay with the effective priority being persisted — may differ from the
  // stale snapshot entry when priority and dependencies are patched together.
  priorityMap.set(taskId, startPriority);

  if (startPriority <= 0) {
    return { priority: startPriority, bumped: false, cascade: [] };
  }

  const floor = minStepForDeps(deps, priorityMap);
  if (startPriority >= floor) {
    return { priority: startPriority, bumped: false, cascade: [] };
  }

  const newPriority = floor;
  priorityMap.set(taskId, newPriority);

  // Cascade: iterate to a fixed point, bumping active dependents of any task that
  // just moved (including the patched task itself). Bounded like
  // healDependencyOrdering's own cycle guard so a dependency cycle terminates.
  const cascade = [];
  const cascadeById = new Map();
  const moved = new Set([taskId]);
  const maxIter = list.length + 2;

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const t of list) {
      if (!t || !t.id || t.id === taskId) continue;
      if (!activeSet.has(t.status)) continue;
      const tPriority = priorityMap.get(t.id) ?? (typeof t.priority === 'number' ? t.priority : 0);
      if (tPriority <= 0) continue; // backlog dependents exempt
      const tDeps = Array.isArray(t.dependencies) ? t.dependencies : [];
      if (!tDeps.some(d => moved.has(d))) continue;
      const depFloor = minStepForDeps(tDeps, priorityMap);
      if (tPriority < depFloor) {
        priorityMap.set(t.id, depFloor);
        moved.add(t.id);
        changed = true;
        const existing = cascadeById.get(t.id);
        if (existing) {
          existing.to = depFloor;
        } else {
          const entry = { id: t.id, from: tPriority, to: depFloor };
          cascadeById.set(t.id, entry);
          cascade.push(entry);
        }
      }
    }
    if (!changed) break;
  }

  return { priority: newPriority, bumped: true, cascade };
}

module.exports = { resolveDepAwareUpdate };
