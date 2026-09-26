'use strict';

// Pure MCP priority helpers. Callers supply task/status snapshots; no IO at load time.
const { minStepForDeps } = require('../server/sprint-assign');

// C1187 — the legacy active-status set, used only as the default for the optional
// `activeStatuses` params below. Callers with a real backend should resolve the
// project's own active set via status-roles.js's fetchStatusContext() and pass it in;
// omitting it degrades to this literal set, i.e. today's exact pre-C1187 behavior.
const ACTIVE = new Set(['pending', 'in_progress', 'on_fire']);

// Default create priority: current session task, then an in-progress coding task,
// then one above the highest active task (or 1 if none). Returns priority, reason,
// and source task id when a task supplied the value.
function resolveCreatePriority({ tasks, sessionTaskId, activeStatuses = ACTIVE, inProgressName = 'in_progress' }) {
  const list = Array.isArray(tasks) ? tasks : [];
  const activeSet = activeStatuses instanceof Set ? activeStatuses : new Set(activeStatuses);

  if (sessionTaskId) {
    const sessionTask = list.find(t => t.id === sessionTaskId);
    if (sessionTask && typeof sessionTask.priority === 'number') {
      return { priority: sessionTask.priority, reason: 'session', from: sessionTask.id };
    }
  }

  const inProg = list.find(t => t.status === inProgressName && t.category === 'CODING');
  if (inProg && typeof inProg.priority === 'number') {
    return { priority: inProg.priority, reason: 'in_progress', from: inProg.id };
  }

  let maxP = 0;
  for (const t of list) {
    if (activeSet.has(t.status) && typeof t.priority === 'number' && t.priority > maxP) maxP = t.priority;
  }
  return { priority: maxP + 1, reason: 'max_plus_one', from: null };
}

// Decide whether update_task should apply the same priority default create_task uses,
// for the one case that needs it: finalizing a reserve_task_keys placeholder (C1049).
// reserve_task_keys books rows at priority 0 (backlog) since the real priority isn't known
// yet — the objective-chat planner supplies the real priority itself when finalizing via
// its own client-side resolution, but an agent driving reserve_task_keys + update_task
// directly has no equivalent, and update_task is otherwise a raw pass-through PATCH: a
// caller who forgets `priority` silently leaves a brand-new task stuck at 0/backlog,
// invisible on the active sprint board.
//
// Pure predicate — kept dependency-free (no import of reservation-placeholder.js, mirrors
// that module's own no-deps design) by taking `isPlaceholder` as a plain boolean the caller
// computes via isReservationPlaceholder(currentTask). Must NOT fire on an ordinary update
// (e.g. a bare status change on an already-real task) — only when a placeholder is being
// given real content for the first time.
function shouldDefaultPriorityOnFinalize({ priority, title }, isPlaceholder) {
  return priority === undefined && title !== undefined && isPlaceholder === true;
}

// Keep a new task strictly above active dependencies, with backlog exempt.
// Only active deps constrain it; never demote an inherited priority.
// @param {object} i
// @param {number} i.priority - resolved priority
// @param {string[]} i.dependencies - raw dependency keys
// @param {Array} i.tasks - full project task snapshot
// @param {string} [i.taskId] - own key, excluded from dependencies
// @param {string} [i.status] - own status; closed tasks are exempt
// @param {(k: string) => string} [i.normalizeKey] - normalizes deps and task ids
// @param {Set<string>|Array<string>} [i.activeStatuses] - active status names
// @returns {{ priority: number, bumped: boolean, floor: number|null, from: string|null }}
function applyDependencyFloor({ priority, dependencies, tasks, taskId = null, status = 'pending', normalizeKey = null, activeStatuses = ACTIVE }) {
  const noop = { priority, bumped: false, floor: null, from: null };
  const activeSet = activeStatuses instanceof Set ? activeStatuses : new Set(activeStatuses);

  if (typeof priority !== 'number' || priority <= 0) return noop; // backlog/negative exempt from ordering
  if (!Array.isArray(dependencies) || dependencies.length === 0) return noop;
  if (!activeSet.has(status)) return noop; // closed (complete/canceled role) task being created — bumping it is meaningless

  const norm = typeof normalizeKey === 'function' ? normalizeKey : (k) => k;
  const self = taskId ? norm(String(taskId)) : null;
  const deps = dependencies
    .map(d => norm(String(d ?? '')))
    .filter(d => d && d !== self);
  if (deps.length === 0) return noop;

  const priorityMap = new Map();
  if (Array.isArray(tasks)) {
    for (const t of tasks) {
      if (t && activeSet.has(t.status) && typeof t.priority === 'number') {
        priorityMap.set(norm(String(t.id)), t.priority);
      }
    }
  }

  const floor = minStepForDeps(deps, priorityMap);
  const final = Math.max(priority, floor);
  const bumped = final > priority;
  // Derive `from` off the floor itself so it can never diverge from what minStepForDeps computed.
  const from = bumped && floor > 1 ? (deps.find(d => priorityMap.get(d) === floor - 1) ?? null) : null;

  return { priority: final, bumped, floor, from };
}

module.exports = { resolveCreatePriority, shouldDefaultPriorityOnFinalize, applyDependencyFloor };
