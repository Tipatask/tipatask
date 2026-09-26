'use strict';

// status-roles.js is itself a pure module (no requires, no IO at load time), so pulling
// it in here for resolveAndAssign()'s C1187 active-status resolution doesn't compromise
// the "no module-scope require of its own" property priority-fallback.js's comment relies
// on for safe MCP cold start.
const { fetchStatusContext } = require('./status-roles');

const PERFORMANCE_SUGGESTION_TAG = 'tt-performance-suggestions';

/**
 * Dependency-graph-based sprint assignment for objective-created tasks.
 *
 * Key arch: tasks.priority = sprint number. priority 0 = backlog.
 * Groups tasks by dependency depth, assigns each group to a sprint, honoring
 * deps on both new siblings AND existing tasks.
 */

function isPerformanceSuggestionChange(change) {
  const task = change && change.task;
  if (!task) return false;
  const tags = Array.isArray(task.tags) ? task.tags : [];
  return !!change._efficiencyHint || !!task._efficiencyHint || tags.includes(PERFORMANCE_SUGGESTION_TAG);
}

function normalizePerformanceSuggestionChange(change) {
  if (!isPerformanceSuggestionChange(change)) return false;
  const task = change.task;
  if (!Array.isArray(task.tags)) task.tags = [];
  if (!task.tags.includes(PERFORMANCE_SUGGESTION_TAG)) task.tags.push(PERFORMANCE_SUGGESTION_TAG);
  if ((task.priority ?? 0) <= 0) task.priority = 0;
  return true;
}

/**
 * Kahn's algorithm topo-sort — returns groups ordered by dependency depth.
 *
 * @param {Array} changes - [{ type, task: { id, dependencies } }]
 * @returns {Array<Array<string>>} groups — group[0] has no inter-new deps, group[1] depends on group[0], etc.
 */
function topoSortGroups(changes) {
  const newTasks = changes.filter(c => c.type === 'new');
  if (newTasks.length === 0) return [];

  const newIds = new Set(newTasks.map(c => c.task.id));

  const inDegree = new Map();
  const dependents = new Map();

  for (const c of newTasks) {
    inDegree.set(c.task.id, 0);
    dependents.set(c.task.id, []);
  }

  for (const c of newTasks) {
    const deps = (c.task.dependencies || []).filter(dep => newIds.has(dep));
    for (const dep of deps) {
      inDegree.set(c.task.id, (inDegree.get(c.task.id) || 0) + 1);
      dependents.get(dep).push(c.task.id);
    }
  }

  const groups = [];
  const assigned = new Set();

  let queue = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([id]) => id);

  while (queue.length > 0) {
    groups.push(queue);
    for (const id of queue) assigned.add(id);

    const nextQueue = [];
    for (const id of queue) {
      for (const dependent of (dependents.get(id) || [])) {
        const newDeg = (inDegree.get(dependent) || 0) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) nextQueue.push(dependent);
      }
    }
    queue = nextQueue;
  }

  const unassigned = newTasks.map(c => c.task.id).filter(id => !assigned.has(id));
  if (unassigned.length > 0) {
    console.warn(`[sprint-assign] Circular dependencies detected in tasks: ${unassigned.join(', ')}. Assigning to last group.`);
    if (groups.length === 0) groups.push([]);
    groups[groups.length - 1].push(...unassigned);
  }

  return groups;
}

const LEGACY_ACTIVE_STATUSES = ['pending', 'in_progress', 'on_fire'];

/**
 * Highest priority among active CODING tasks. Null if none.
 *
 * Used as startingSprint so new tasks join the current (highest-numbered) active
 * sprint rather than the oldest one. Changed from Math.min (C899).
 *
 * `activeStatuses` (C1187) — this project's active status names (Set or array), resolved
 * via status-roles.js's fetchStatusContext().active by callers that have a backend.
 * Defaults to the legacy 3-name list so this module stays pure (no IO/require) and every
 * caller not yet threading it degrades to today's exact behavior.
 *
 * @param {Array} tasks
 * @param {Set<string>|Array<string>} [activeStatuses]
 * @returns {number|null}
 */
function highestActiveCodingPriority(tasks, activeStatuses = LEGACY_ACTIVE_STATUSES) {
  const activeSet = activeStatuses instanceof Set ? activeStatuses : new Set(activeStatuses);
  const active = tasks
    .filter(t => activeSet.has(t.status)
              && t.category === 'CODING'
              && typeof t.priority === 'number'
              && t.priority > 0)
    .map(t => t.priority);
  return active.length > 0 ? Math.max(...active) : null;
}

// Same baseline for prompt hints and actual assignment, including an empty project
// or one whose previous sprints contain only closed tasks.
function codingPriorityBaseline(tasks, activeStatuses = LEGACY_ACTIVE_STATUSES) {
  return highestActiveCodingPriority(tasks, activeStatuses)
    ?? (Math.max(0, ...tasks.map(t => t.priority ?? 0)) + 1);
}

/**
 * Min step a task must sit at to satisfy its deps.
 * Unknown deps / backlog deps are ignored. Returns 1 if no constraints.
 *
 * @param {Array<string>} deps
 * @param {Map<string, number>} priorityMap - id → priority
 * @returns {number}
 */
function minStepForDeps(deps, priorityMap) {
  let max = 0;
  for (const d of deps || []) {
    if (!priorityMap.has(d)) continue;
    const p = priorityMap.get(d);
    if (p == null || p === 0) continue; // backlog dep → no ordering
    if (p > max) max = p;
  }
  return max > 0 ? max + 1 : 1;
}

/**
 * Compute per-id sprint assignments, respecting existing-task deps.
 *
 * Walks topo groups; each new task's step = max(groupFloor, minStepForDeps).
 * Pinned tasks keep their user-chosen priority but participate in priorityMap
 * so downstream tasks see them.
 *
 * @param {Array<Array<string>>} groups
 * @param {Array} newChanges - full changes array (pinned + non-pinned)
 * @param {Set<string>} pinnedIds
 * @param {Array} existingSprints
 * @param {Array} existingTasks
 * @param {Set<string>|Array<string>} [activeStatuses] - C1187, see highestActiveCodingPriority()
 * @returns {{ assignments: Map<string, number>, newSprints: Array<{name,number}> }}
 */
function computeSprintAssignments(groups, newChanges, pinnedIds, existingSprints, existingTasks, activeStatuses = LEGACY_ACTIVE_STATUSES) {
  const existingSprintNumbers = new Set((existingSprints || []).map(s => s.number));
  const startingSprint = codingPriorityBaseline(existingTasks, activeStatuses);

  const priorityMap = new Map();
  for (const t of existingTasks) priorityMap.set(t.id, t.priority ?? 0);

  const changeById = new Map(newChanges.map(c => [c.task.id, c]));
  const assignments = new Map();
  const usedSprintNumbers = new Set();

  for (let i = 0; i < groups.length; i++) {
    const groupFloor = startingSprint + i;
    for (const id of groups[i]) {
      const c = changeById.get(id);
      if (!c) continue;
      const deps = c.task.dependencies || [];
      const depFloor = minStepForDeps(deps, priorityMap);
      let step;
      if (pinnedIds.has(id)) {
        step = c.task.priority ?? 0;
      } else {
        step = Math.max(groupFloor, depFloor);
      }
      assignments.set(id, step);
      priorityMap.set(id, step);
      if (step > 0) usedSprintNumbers.add(step);
    }
  }

  const newSprints = [];
  for (const n of usedSprintNumbers) {
    if (!existingSprintNumbers.has(n)) {
      newSprints.push({ name: `Sprint ${n}`, number: n });
      existingSprintNumbers.add(n);
    }
  }

  return { assignments, newSprints };
}

/**
 * Resolve sprint assignments for changes. Mutates change.task.priority in-place
 * for non-pinned tasks. Pinned tasks keep their priority but feed into the
 * dep-aware resolution for downstream tasks.
 *
 * @param {Array} changes
 * @param {object} backend - must have getSprints, createSprint, getTasks
 * @param {object} config - unused since C1353 (the file task backend's branch here was removed
 *   with the retired backend, C1352) — kept as a positional parameter so existing call sites
 *   (ws-handlers.js, api-backend.js) don't need to shift pinnedIds/prefetchedTasks over
 * @param {Set<string>} [pinnedIds]
 * @param {Array|null} [prefetchedTasks] - already-fetched task list; skips backend.getTasks() when provided
 */
async function resolveAndAssign(changes, backend, config, pinnedIds = new Set(), prefetchedTasks = null) {
  const newChanges = changes.filter(c => c.type === 'new');
  if (newChanges.length === 0) return;

  const backlogOnlyIds = new Set();
  const effectivePinnedIds = new Set(pinnedIds);

  // Perf-suggestion changes proposed at priority <= 0 stay in backlog — both
  // _efficiencyHint cards (spawnEfficiencyAnalysis) and planner cards carrying only the
  // tt-performance-suggestions tag. The tag is the durable marker; _efficiencyHint is a
  // transient client flag stripped before the single-accept resolve call (see
  // chat-task-preview.js), so it cannot be relied on server-side. Nonzero perf suggestions
  // keep their explicit sprint priority.
  for (const c of newChanges) {
    if (normalizePerformanceSuggestionChange(c)) {
      if ((c.task.priority ?? 0) <= 0) {
        c.task.priority = 0; // make backlog intent explicit
        backlogOnlyIds.add(c.task.id);
      } else {
        effectivePinnedIds.add(c.task.id);
      }
      continue;
    }
    // A missing priority is never a user-selected Backlog value.
    if (c.task.priority == null) effectivePinnedIds.delete(c.task.id);
    if (effectivePinnedIds.has(c.task.id) && c.task.priority <= 0) {
      c.task.priority = 0;
      backlogOnlyIds.add(c.task.id);
    }
  }

  // Only explicit backlog tasks are excluded. AI-assigned p=0 regular tasks are
  // still resolvable and get a real sprint priority.
  const resolvable = newChanges.filter(c => !backlogOnlyIds.has(c.task.id));

  const groups = topoSortGroups(resolvable);
  if (groups.length === 0) return;

  // C1187 — this project's active status names, resolved once and threaded into both
  // branches below. fetchStatusContext is fail-open (never throws, degrades to the
  // legacy 3-name set), so this can't newly break a resolve call that worked before.
  const statusCtx = await fetchStatusContext(backend);

  const [existingSprints, existingTasks] = await Promise.all([
    backend.getSprints(),
    prefetchedTasks ? Promise.resolve(prefetchedTasks) : (backend.getTasksUnfiltered ? backend.getTasksUnfiltered() : backend.getTasks()),
  ]);

  const { assignments, newSprints } = computeSprintAssignments(
    groups, resolvable, effectivePinnedIds, existingSprints, existingTasks, statusCtx.active
  );

  for (const { name, number } of newSprints) {
    try {
      await backend.createSprint(name, number);
      console.log(`[sprint-assign] Created sprint "${name}" (number ${number})`);
    } catch (err) {
      console.warn(`[sprint-assign] Failed to create sprint ${number}: ${err.message}`);
    }
  }

  for (const c of newChanges) {
    if (effectivePinnedIds.has(c.task.id)) continue;
    if (assignments.has(c.task.id)) {
      const from = c.task.priority;
      c.task.priority = assignments.get(c.task.id);
      if ((from ?? 0) <= 0 && c.task.priority > 0) {
        console.log(`[sprint-assign] Coerced proposed priority for ${c.task.id}: ${from === undefined ? '<missing>' : from} -> ${c.task.priority}`);
      }
    }
  }
}

// Last save-time guard: the preview's resolve request may have failed. Only
// objective-created rows are eligible; existing rows and manual saves are untouched.
// Positive priorities have already been resolved or selected and stay pinned.
async function normalizeObjectiveTodoPriorities(content, backend, config) {
  const match = typeof content === 'string' && content.match(/^([\s\S]*?```json\s*\n)([\s\S]*)(```[\s\S]*)$/);
  if (!match) return content;
  let data;
  try { data = JSON.parse(match[2]); } catch { return content; }
  if (!data || !Array.isArray(data.tasks) || !Array.isArray(data.newTaskIds)) return content;
  const newIds = new Set(data.newTaskIds);
  const changes = data.tasks.filter(t => t && newIds.has(t.id)).map(task => ({ type: 'new', task }));
  const pinnedIds = new Set(Array.isArray(data.newTaskPinnedIds) ? data.newTaskPinnedIds : []);
  delete data.newTaskPinnedIds;
  const needsAssignment = changes.some(c => (c.task.priority ?? 0) <= 0
    && !(pinnedIds.has(c.task.id) && c.task.priority === 0) && !isPerformanceSuggestionChange(c));
  if (needsAssignment) {
    for (const c of changes) {
      if (c.task.priority > 0) pinnedIds.add(c.task.id);
    }
    // Do not swallow failures here: persisting the original zero would silently
    // undo the guard. The HTTP handler reports the error and the user can retry.
    await resolveAndAssign(changes, backend, config, pinnedIds);
  }
  return match[1] + JSON.stringify(data, null, 2) + '\n' + match[3];
}

/**
 * Auto-heal dependency ordering. Bumps non-pinned tasks to satisfy deps;
 * records pinned-vs-dep violations as hard conflicts (returned to caller for
 * user resolution).
 *
 * Iterates to fixed point. Tracks every mutation so client can toast the user.
 *
 * @param {Array} changes
 * @param {Array} existingTasks
 * @param {Set<string>} pinnedIds
 * @returns {{ conflicts: Array, autoBumped: Array<{id, from, to}> }}
 */
function healDependencyOrdering(changes, existingTasks, pinnedIds = new Set()) {
  const priorityMap = new Map();
  for (const t of existingTasks) priorityMap.set(t.id, t.priority ?? 0);
  for (const c of changes) priorityMap.set(c.task.id, c.task.priority ?? 0);

  const maxIter = changes.length + 2;
  const originals = new Map();
  const hardConflicts = [];

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    hardConflicts.length = 0;
    for (const c of changes) {
      const id = c.task.id;
      const step = c.task.priority ?? 0;
      if (step === 0) continue;
      for (const depId of (c.task.dependencies || [])) {
        if (!priorityMap.has(depId)) continue;
        const depStep = priorityMap.get(depId);
        if (depStep === 0) continue;
        if (step <= depStep) {
          if (pinnedIds.has(id)) {
            hardConflicts.push({ taskId: id, taskStep: step, depId, depStep });
          } else {
            if (!originals.has(id)) originals.set(id, step);
            const newStep = depStep + 1;
            c.task.priority = newStep;
            priorityMap.set(id, newStep);
            changed = true;
            break;
          }
        }
      }
    }
    if (!changed) break;
  }

  const autoBumped = [];
  for (const [id, from] of originals) {
    const c = changes.find(x => x.task.id === id);
    if (c && c.task.priority !== from) {
      autoBumped.push({ id, from, to: c.task.priority });
    }
  }

  return { conflicts: hardConflicts, autoBumped };
}

// Back-compat shim — old name kept for any external callers.
function validateDependencyOrdering(changes, existingTasks) {
  return healDependencyOrdering(changes, existingTasks, new Set()).conflicts;
}

module.exports = {
  topoSortGroups,
  computeSprintAssignments,
  resolveAndAssign,
  highestActiveCodingPriority,
  codingPriorityBaseline,
  normalizeObjectiveTodoPriorities,
  healDependencyOrdering,
  validateDependencyOrdering,
  minStepForDeps,
  isPerformanceSuggestionChange,
  normalizePerformanceSuggestionChange,
};
