// ── Status-filter panel checkbox math (C1547) ──
// Pure, DOM-free helpers for the status-filter dropdown's checked-state and toggle logic.
// state.statusFilter is a Set<string> where empty means "show all" (C1164). The filter
// predicates (statusFilterActive()/taskMatchesStatusFilter() in task-board.js) already honor
// that, but the panel's per-row checkbox used to render `checked` only on `selected.has(value)`
// — so the default all-statuses state drew every individual row unchecked while only the top
// "All statuses" row read as selected, even though the board really was showing every status.
// Same idiom as board-filter-prefs.js/dep-graph.js/tag-match.js: no DOM/network, unit-testable
// in isolation, shared by task-board.js (renderStatusFilter()/refreshFilterBarChrome(), ES
// import) and template.html's inline script (via window.TipTask.statusFilterSelect, C1547).

// Whether one panel row's checkbox should render checked. `value === ''` is the top
// "All statuses" row; every other value is a status name.
export function isStatusRowChecked(selected, value) {
  const size = selected instanceof Set ? selected.size : 0;
  if (value === '') return size === 0;
  return size === 0 || (selected instanceof Set && selected.has(value));
}

// Computes the next state.statusFilter Set after toggling one row. Always returns a NEW Set
// (callers reassign state.statusFilter = nextStatusSelection(...) rather than mutate in place).
//
// - value === '' (the All-statuses row): always clears to empty, regardless of `checked` —
//   matches the pre-C1547 behavior of that row.
// - checking a row: add it to a copy of the current selection.
// - unchecking a row while the current selection is empty (the "all" state, now that every row
//   renders checked): Set.delete() on an absent member is a silent no-op, so this must instead
//   EXPAND into the explicit complement — every known name except the one just unticked — so
//   the uncheck actually narrows the board.
// - unchecking a row from an explicit subset: remove it from a copy.
// - normalize: if the result ends up covering every known name, collapse back to the canonical
//   empty Set so persistence/label/All-row checkbox all agree "all" is represented as empty.
export function nextStatusSelection(selected, value, checked, allNames) {
  const names = Array.isArray(allNames) ? allNames : [];
  const current = selected instanceof Set ? selected : new Set();

  if (value === '') return new Set();

  let next;
  if (checked) {
    next = new Set(current);
    next.add(value);
  } else if (current.size === 0) {
    next = new Set(names.filter(n => n !== value));
  } else {
    next = new Set(current);
    next.delete(value);
  }

  if (names.length > 0 && next.size >= names.length && names.every(n => next.has(n))) {
    return new Set();
  }
  return next;
}
