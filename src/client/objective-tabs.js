// ── Objective nav tabs — resolver/state helpers (C1462) ──
// Pure, no DOM/network — same idiom as subtask-count.js/board-count-domain.js — so it's
// unit-testable in isolation and callable from template.html via the window.TipTask bridge
// (there is no dedicated session-started WS broadcast; template.html's syncObjectiveTabsState()
// drives these from state.activeSessions and the occasional task:updated in-progress
// transition — see ai/architecture/tt-task-subtasks.md § objectiveTabs for the full contract).

export const MAX_OBJECTIVE_TABS = 3; // .top-nav is flex-wrap:nowrap by design (C1155) and
  // .nav-tabs never squishes — .search-group is the sole shrink victim, so the tab list
  // can't grow indefinitely. FIFO-evict the oldest once this cap is exceeded.

// Collapse whitespace + ellipsis-truncate, same idiom as objective-parent-task.js's
// (module-private) truncateTitle() — shorter budget here since a nav tab is far narrower
// than a full objective title.
export function truncateTabTitle(title, max = 24) {
  const collapsed = String(title || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trim() + '…';
}

// `parentKey · truncated title` — reuses renderBreadcrumbs()'s own `·` separator
// (task-board.js) so the label reads consistently with the breadcrumb bar.
export function objectiveTabLabel(entry) {
  return `${entry?.parentKey ?? ''} · ${truncateTabTitle(entry?.title)}`;
}

// Mutates `tabs` in place — same idiom as pushSubtaskCrumb() (utils.js). Adds a new
// { parentKey, parentDbId, title, childrenCount, completedChildrenCount } entry when
// parentKey is new (counts default null — unknown until a sync pass resolves them);
// refreshes title/counts in place when they changed; FIFO-evicts the oldest entry once
// `max` is exceeded. Returns whether anything actually changed, so callers can skip a
// repaint when nothing did. Counts are refreshed ONLY when the incoming value is non-null
// (C1463) — childrenCount/completedChildrenCount are list-route-only fields (C1435) and a
// task-route/drill-down resolution legitimately carries null for them; a null must never
// clobber a count already known from an earlier, richer resolution. Never removes an entry
// otherwise — additive-until-closed until C1463's removeObjectiveTab() is called.
export function upsertObjectiveTab(tabs, entry, { max = MAX_OBJECTIVE_TABS } = {}) {
  if (!Array.isArray(tabs) || !entry?.parentKey) return false;
  const existing = tabs.find(x => x.parentKey === entry.parentKey);
  if (existing) {
    let changed = false;
    if (existing.title !== entry.title && entry.title !== undefined) { existing.title = entry.title; changed = true; }
    if (entry.childrenCount != null && existing.childrenCount !== entry.childrenCount) { existing.childrenCount = entry.childrenCount; changed = true; }
    if (entry.completedChildrenCount != null && existing.completedChildrenCount !== entry.completedChildrenCount) { existing.completedChildrenCount = entry.completedChildrenCount; changed = true; }
    return changed;
  }
  tabs.push({
    parentKey: entry.parentKey,
    parentDbId: entry.parentDbId ?? null,
    title: entry.title || '',
    childrenCount: entry.childrenCount ?? null,
    completedChildrenCount: entry.completedChildrenCount ?? null,
  });
  while (tabs.length > max) tabs.shift();
  return true;
}

// (C1463) Removes the entry for parentKey, if present. Returns whether anything was
// removed, so callers can skip a repaint when nothing changed. The only place an
// objective-tabs entry is ever taken out of the additive-until-closed list.
export function removeObjectiveTab(tabs, parentKey) {
  if (!Array.isArray(tabs) || !parentKey) return false;
  const idx = tabs.findIndex(x => x.parentKey === parentKey);
  if (idx === -1) return false;
  tabs.splice(idx, 1);
  return true;
}

// (C1463) Display-only "every child closed" flag for the tab's green-tick icon. Unknown
// counts (null — unresolved parent, or a drill-down board whose rows carry no list-route
// count fields) render no tick, same documented no-op class as resolveObjectiveParent()'s
// unresolvable-parent gap above. NEVER used to decide whether the close button needs to
// confirm — that decision is made from a fresh, authoritative, unscoped server-side check
// (see ws-handlers.js's terminateChildren connect branch) precisely because this entry's
// counts can be short of the real total under a narrowed People/assignee filter.
export function isObjectiveTabDone(entry) {
  return entry?.childrenCount > 0 && entry.completedChildrenCount >= entry.childrenCount;
}

// state.activeTab === 'board' AND drilled into an objective that has its own nav tab -> its
// parentKey, else null.
//
// (TPT59) `subtaskStack` is now the FULL reconstructed ancestor chain (see
// template.html's _applyAncestorCrumbs()), not just what a single drill-in flow pushed — so
// stack[0] is the absolute root ancestor and need not be an objective with a tab at all (a
// plain top-level task with a tabbed sub-objective further down the chain, for instance).
// `objectiveTabs` (optional — state.objectiveTabs) lets this find the OUTERMOST stack entry
// that actually has a tab, preserving the original intent: drilling further into a nested
// sub-objective still shows the OUTER objective's tab as active, not none. Without
// `objectiveTabs` (or when none of its keys are in the stack), falls back to the original
// stack[0] behavior — this is also what every pre-TPT59 caller/test still exercises.
export function activeObjectiveTabKey({ activeTab, subtaskStack, objectiveTabs } = {}) {
  if (activeTab !== 'board') return null;
  if (Array.isArray(objectiveTabs) && objectiveTabs.length && Array.isArray(subtaskStack)) {
    const tabKeys = new Set(objectiveTabs.map(tab => tab.parentKey));
    const outermost = subtaskStack.find(entry => tabKeys.has(entry.taskKey));
    if (outermost) return outermost.taskKey;
  }
  return subtaskStack?.[0]?.taskKey ?? null;
}

// Resolves a bare numeric parentDbId (from a task:updated frame or an active session's
// task row — neither carries the parent's own task-key) to { parentKey, parentDbId, title }.
// tasksByDbId: Map<String(dbId), task> built from state._lastVisibleTasks (unfiltered by
// the C1460 grouping filter, so a hidden child's parent row is present there even when
// only the parent renders). parentTask: state.subtaskParentTask | null — the ONLY source
// of the parent while drilled into ITS OWN board (getChildren() never returns the parent
// row), but only trusted when its dbId actually matches parentDbId — otherwise a session
// started elsewhere (e.g. the left-nav session list) while drilled into an unrelated
// objective would mislabel the new tab with the wrong parent. Returns null when
// unresolvable — documented no-op, same class of gap as C1460/C1461's orphan-child cases
// (e.g. a parent outside the fetched sprint window/assignee scope).
export function resolveObjectiveParent(parentDbId, { tasksByDbId, parentTask } = {}) {
  if (parentDbId == null) return null;
  const key = String(parentDbId);
  if (parentTask && String(parentTask.dbId) === key) {
    // (C1463) parentTask is a task-route object (state.subtaskParentTask) — it never
    // carries the list-route-only childrenCount/completedChildrenCount fields (C1435).
    return { parentKey: parentTask.id, parentDbId, title: parentTask.title, childrenCount: null, completedChildrenCount: null };
  }
  const found = tasksByDbId?.get(key);
  return found ? { parentKey: found.id, parentDbId, title: found.title, childrenCount: found.childrenCount ?? null, completedChildrenCount: found.completedChildrenCount ?? null } : null;
}
