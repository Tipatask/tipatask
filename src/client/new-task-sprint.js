// Manual New Task sprint selection (TPT624). Pure helpers — no DOM, no state import — so the
// rules are node-testable. The New Task form's sprint combo yields a raw value ('3', 'null' for
// Backlog, '__new__' for "+ New sprint"); the user's explicit pick is pinned so the save-time
// /api/resolve-sprints call keeps it instead of replacing it with the newest active sprint.
// Only a dependency floor may move it, and the move is reported for the Preview to show.

export const BACKLOG_VALUE = 'null';
export const NEW_SPRINT_VALUE = '__new__';

// Raw combo value -> { priority, pinned }, or null when nothing is selected (sprints on).
// Sprints off: the form has no sprint field, so the task joins the current active sprint
// unpinned and the save path keeps its default assignment.
export function resolveManualSprintSelection(raw, { sprintsEnabled = true, tierKeys = [], sprintMax = 0, activePriority = 1 } = {}) {
  if (!sprintsEnabled) return { priority: activePriority, pinned: false };
  const value = raw == null ? '' : String(raw);
  if (value === '') return null;
  if (value === BACKLOG_VALUE || value === '0') return { priority: 0, pinned: true };
  if (value === NEW_SPRINT_VALUE) {
    const keys = (tierKeys || []).map(Number).filter(k => Number.isFinite(k) && k > 0);
    return { priority: Math.max(0, sprintMax || 0, ...keys) + 1, pinned: true };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return { priority: n, pinned: true };
}

// Lowest sprint the task may sit in given its dependencies — same rule as the server's
// sprint-assign.js minStepForDeps(): backlog (<= 0) and unknown deps impose nothing.
// Returns { floor, depId, depPriority } naming the dependency that sets the floor.
export function manualDependencyFloor(dependencies, tasks) {
  const byId = new Map((tasks || []).map(t => [String(t.id), t]));
  let floor = 1;
  let depId = null;
  let depPriority = null;
  for (const dep of dependencies || []) {
    const task = byId.get(String(dep));
    if (!task) continue;
    const p = Number(task.priority ?? 0);
    if (!Number.isFinite(p) || p <= 0) continue;
    if (p + 1 > floor) { floor = p + 1; depId = String(dep); depPriority = p; }
  }
  return { floor, depId, depPriority };
}

// (TPT642) Dependency keys the board's own task list doesn't hold — the board fetch is
// assignee- and sprint-window-scoped, so a teammate's task or one in an older sprint is absent.
export function missingDependencyIds(dependencies, tasks) {
  const loaded = new Set((tasks || []).map(t => String(t.id)));
  return (dependencies || []).map(String).filter(dep => !loaded.has(dep));
}

// (TPT642) Rows manualDependencyFloor() should read: the board's tasks plus live rows (the
// unfiltered project task list) for the missing dependencies only. Loaded rows stay
// authoritative; nothing missing or no live rows -> `tasks` itself, unchanged.
export function dependencyFloorRows(dependencies, tasks, liveRows) {
  const missing = new Set(missingDependencyIds(dependencies, tasks));
  if (missing.size === 0 || !Array.isArray(liveRows)) return tasks;
  const extra = liveRows.filter(t => t && missing.has(String(t.id)));
  return extra.length ? [...(tasks || []), ...extra] : tasks;
}

// Moves a selected sprint up to the dependency floor. Backlog stays put (the server's
// healDependencyOrdering() exempts priority 0 too). `moved` is null when nothing changed.
export function applyManualDependencyFloor(priority, floorInfo) {
  const p = Number(priority ?? 0);
  if (!(p > 0) || !floorInfo || p >= floorInfo.floor) return { priority: p, moved: null };
  return {
    priority: floorInfo.floor,
    moved: { from: p, to: floorInfo.floor, depId: floorInfo.depId, depPriority: floorInfo.depPriority },
  };
}

// Value the sprint combo should show when the form re-renders from state or a draft:
// 0 / 'null' -> Backlog, '__new__' stays "+ New sprint", anything else as a string.
export function formSprintValue(priority) {
  if (priority === 0 || priority === '0' || priority === BACKLOG_VALUE) return BACKLOG_VALUE;
  if (priority == null) return '';
  return String(priority);
}
