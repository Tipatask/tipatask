// ── Board filter persistence helpers ──
// Pure serialize/sanitize pair for the Task App board's six filter dimensions
// (state.searchQuery/humanFilterActive/statusFilter/activeTagFilters/assigneeScope/
// assigneeFilter — the last two added C1407), persisted into .tipatask/config.json's
// `boardFilters` key — see applyProjectBoardFilters()/persistBoardFilters() in
// task-board.js for the read/write call sites, and tt-project-config.md § boardFilters
// for the on-disk shape. No DOM/network here, same idiom as dep-graph.js/
// status-registry.js, so this is unit-testable in isolation.

// state → the plain object written to config.json.
export function serializeBoardFilters(state) {
  return {
    search: state.searchQuery || '',
    human: !!state.humanFilterActive,
    statuses: [...(state.statusFilter || [])],
    tags: [...(state.activeTagFilters || [])],
    // (C1407) People filter.
    assigneeScope: state.assigneeScope === 'all' ? 'all' : 'me',
    assignees: [...(state.assigneeFilter || [])],
  };
}

// Saved config.json value → a shape safe to assign straight into state fields.
// Tolerates null/undefined (nothing saved yet) and a malformed/legacy blob — every
// field is coerced independently rather than trusting the input's shape wholesale.
//
// knownStatuses (current project's status registry, e.g. statusNames() from
// status-registry.js) filters out stale names: statuses are per-project and
// renameable/deletable (C1181/C1184), and the status-filter checkbox panel only
// ever renders the current registry, so a stale saved name would silently narrow
// the board to zero tasks with no checked box to explain why. Tags are NOT
// filtered against a known list — they render as removable chips regardless, so a
// stale tag is visible and dismissible rather than a silent empty board.
// (C1407) assignees entries are NOT filtered against a known-member list, same
// reasoning as tags above: they render as checkable rows regardless, so a stale id
// (a member later removed from the project) is simply an unchecked row with no
// matching member to show, not a silent empty board.
export function sanitizeBoardFilters(raw, knownStatuses) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const known = new Set(Array.isArray(knownStatuses) ? knownStatuses : []);
  const statuses = Array.isArray(r.statuses)
    ? r.statuses.filter(s => typeof s === 'string' && known.has(s))
    : [];
  const tags = Array.isArray(r.tags) ? r.tags.filter(t => typeof t === 'string' && t) : [];
  const assignees = Array.isArray(r.assignees)
    ? r.assignees.filter(a => a === 'none' || (typeof a === 'number' && Number.isFinite(a)))
    : [];
  return {
    search: typeof r.search === 'string' ? r.search : '',
    human: !!r.human,
    statuses,
    tags,
    assigneeScope: r.assigneeScope === 'all' ? 'all' : 'me',
    assignees,
  };
}
