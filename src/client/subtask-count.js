// ── Subtasks N/M label + live-update delta math (C1436, C1453) ──
// Pure helpers, no DOM/network — same idiom as board-count-domain.js/group-label.js — so
// they're unit-testable in isolation and callable from anywhere without dragging in
// task-card.js (which pulls in console-modal.js/task-board.js and isn't importable under
// bare `node --test`).
//
// buildSubtasksLabel() is a verbatim extraction of the C1436 ternary that used to live
// inline in task-card.js's renderCard() — moved here so the WS/local-write live-update path
// (task-board.js's refreshParentSubtaskLabel(), C1453) can build the same label string
// in-place after patching a parent task's counts, instead of duplicating the ternary.
//
// closedDelta()/applyChildStatusDelta() drive that live update: a child's status write only
// ever needs to know whether it crossed the closed-role boundary (complete OR canceled,
// C1187 — never a hardcoded status name) and in which direction.

import { t as translate } from './i18n.js';
import { isClosedName } from './status-registry.js';

// (C1436) childrenCount/completedChildrenCount are list-route-only (C1435) — null on a
// drill-down board (getChildren() maps children through fromApi(), no count fields). Bare
// label there rather than a false "0/0" on a card that provably has children.
export function buildSubtasksLabel(task) {
  return task?.childrenCount == null
    ? translate('btn.subtasksBare')
    : translate('btn.subtasksCount', { done: task.completedChildrenCount ?? 0, total: task.childrenCount });
}

// -1 | 0 | +1 — how a child's completed/closed count should move when its status goes
// prevStatus -> nextStatus. Role-derived (C1187): closed = complete OR canceled, so
// completed<->canceled is 0 (still closed either way) and only crossing the closed
// boundary itself moves the needle.
export function closedDelta(prevStatus, nextStatus) {
  const wasClosed = isClosedName(prevStatus);
  const isClosed = isClosedName(nextStatus);
  if (wasClosed === isClosed) return 0;
  return isClosed ? 1 : -1;
}

// Returns a new { childrenCount, completedChildrenCount } pair for `parent` after a child
// crosses the closed boundary by `delta` (-1|0|+1), or null when there's nothing to apply —
// delta is 0, or parent.childrenCount is null (list-route-only field absent, C1435; the
// label already renders bare and has no total to move against). Clamps completedChildrenCount
// into [0, childrenCount] so an out-of-band caller can never produce a negative or over-total
// count.
export function applyChildStatusDelta(parent, delta) {
  if (!delta || parent?.childrenCount == null) return null;
  const total = parent.childrenCount;
  const done = parent.completedChildrenCount ?? 0;
  const nextDone = Math.max(0, Math.min(total, done + delta));
  return { childrenCount: total, completedChildrenCount: nextDone };
}

// (C1461) Live N/M for .parent-task-pane on the subtask drill-down board — that board's
// fetched children never carry the list-route-only childrenCount/completedChildrenCount
// fields (getChildren() maps through fromApi(), see buildSubtasksLabel() doc above), so the
// pane counts directly from the children already on screen instead. Role-derived (isClosedName,
// C1187) — complete OR canceled counts as done, never a hardcoded status name.
export function countChildProgress(children) {
  const list = Array.isArray(children) ? children : [];
  const total = list.length;
  const done = list.reduce((n, c) => n + (isClosedName(c?.status) ? 1 : 0), 0);
  return { total, done };
}
