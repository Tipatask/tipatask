// ── Board filter-count domain (C1442) ──
// Pure helpers deciding which fetched rows the ACTIVE tab can actually render, so faceted
// filter counts (computeStatusCounts/computeAssigneeCounts in task-board.js) never promise a
// match the board can't draw. No DOM/network here, same idiom as board-filter-prefs.js/
// dep-graph.js/status-registry.js, so this is unit-testable in isolation.
//
// Bug this fixes: the sprint-grouped Board/List/To-Do tabs drop backlog (no-sprint,
// priority===0) tasks entirely — they only ever appear on the Backlog tab (or inline, sorted
// last, on the flat board when sprints_enabled is off). Before C1442 the People/Status filter
// counts were computed over every fetched row regardless of tab, so a backlog-only task (e.g.
// the sole Unassigned task in a project) could show "Unassigned (1)" on the Board tab while
// the board itself had nowhere to put it — ticking the filter then rendered an empty board
// with no explanation. See tt-task-board.md § Filter Count Domain (C1442).

// ── Null sprint / backlog task predicate ──
// Moved here (was task-board.js) so it's shared, without a DOM-heavy import, by both the
// tier-building code in template.html and the count-domain helper below.
export function taskHasNullSprint(t) {
  const p = t?.priority;
  return t?.sprint_id === null || t?.sprintId === null || (p !== undefined && p !== '' && Number(p) === 0);
}

// tasks: fetched rows (already assignee/window-scoped upstream).
// opts.tab: state.activeTab. opts.sprintsEnabled: getSprintsEnabled().
// Returns the subset of `tasks` the given tab's render actually draws — the domain faceted
// filter counts must be computed over.
export function tasksForActiveTab(tasks, { tab, sprintsEnabled } = {}) {
  const src = Array.isArray(tasks) ? tasks : [];
  if (tab === 'backlog') return src.filter(taskHasNullSprint);
  if (tab === 'board' && !sprintsEnabled) return src; // flat board merges backlog in, sorted last
  if (tab === 'board' || tab === 'list' || tab === 'todo') return src.filter(t => !taskHasNullSprint(t));
  return src; // new_task/objective/etc — no board render, no domain narrowing to apply
}

// ── Objective grouping filter (C1460) ──
// project.use_objective_grouping (C1556) decides whether an objective's subtasks or its
// is_objective parent container is what the root board draws — never both. Invariant: a row
// is hidden only when a row present in this SAME fetch leads to it (the visible row is the
// door to it via the drill-in / Subtasks button). That one rule buys two things for free:
//   - Orphan children stay visible. A child whose parent didn't make it into this fetch —
//     assignee-scoped fetch with a teammate-owned parent (api-backend.js
//     filterToOwnOrUnassigned), or the sprint window's floor rising past the parent's
//     priority while a child sits higher — would otherwise be unreachable: the parent card
//     is the only route to the drill-down board.
//   - Nested objectives still collapse correctly. Objective B under objective A: B is hidden
//     (A is present), and B's own children are hidden too, because presence is computed over
//     every row in the fetch, not just the rows that survive filtering.
export function taskHiddenByGrouping(t, { objectiveGrouping, drilldown, presentDbIds } = {}) {
  if (drilldown) return false; // getChildren() rows carry parentDbId too (fromApi()) — never filter here
  if (objectiveGrouping) {
    // `t.parentId` (string task_key) is never populated by api-backend.js's fromApi() on the
    // read path today — kept as defence-in-depth in case that ever changes.
    return (t?.parentDbId != null && !!presentDbIds?.has(t.parentDbId)) || !!t?.parentId;
  }
  // Grouping off: hide the parent container once it actually has subtasks; a childless
  // is_objective row (e.g. a web-created objective, C1559, before its subtasks are
  // generated) stays visible — hiding it would strand its only "Create Subtasks" entry point.
  return t?.isObjective === true && t?.hasChildren === true;
}

// tasks: fetched rows (root-board fetch OR a drill-down's getChildren() rows).
// opts.objectiveGrouping: getObjectiveGroupingEnabled(). opts.drilldown: state.subtaskStack.length > 0.
export function tasksVisibleUnderGrouping(tasks, { objectiveGrouping, drilldown } = {}) {
  const src = Array.isArray(tasks) ? tasks : [];
  if (drilldown) return src;
  const presentDbIds = new Set(src.map(t => t?.dbId).filter(v => v != null));
  return src.filter(t => !taskHiddenByGrouping(t, { objectiveGrouping, drilldown, presentDbIds }));
}
