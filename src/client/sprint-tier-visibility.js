// ── Sprint tier visibility math (C1578) ──
// Pure helpers deciding which sprint tiers the board draws now, which sit in the "Show
// More" reveal pool, and which are truly card-less (rendered but hidden). Extracted so it's
// unit-testable without pulling in task-board.js's full DOM-touching import graph — this
// repo has no jsdom, so anything importing that module at module scope can't run under
// `node --test`. Same idiom as drag-state.js / board-count-domain.js.
//
// Rule (see tt-task-board-sprint-groups.md § Behavior, C1578):
//   - a tier with >=1 active (non-closed-role) matching card is drawn
//   - a tier with >=1 matching card, all closed, sits in the reveal pool (Show More)
//   - a tier with zero matching cards is card-less — caller renders it with HIDE_CLASS
//   - if NO tier has an active card, fall back to the newest tier holding any card at all,
//     rather than the newest tier period (which may be a synthesized empty future sprint —
//     see C1464's per-number sprint row cascade) — a completed-only project must still open
//     on its most recent batch (C1324), never look blank.

export const HIDE_CLASS = 'tier--empty';

// tierKeys: ascending sprint priority numbers (state.tierKeys).
// hasActiveMatch(key): >=1 non-closed card in that tier matching current filters.
// hasAnyMatch(key): >=1 card in that tier matching current filters, any status.
// Returns (all ascending, ready for callers' own asc/desc flip, C1577):
//   visibleKeys — tiers to draw with content: active tiers + any all-closed tiers the
//                 caller has already revealed via extraStepsLoaded.
//   emptyKeys   — card-less tiers (zero matching cards). NOT drawn with content, but the
//                 caller must still emit them (hidden) — they're the drag-drop targets that
//                 reappear while body.board-dragging is set. Disjoint from visibleKeys and
//                 never counted toward hiddenCount.
//   hiddenCount — exactly the size of what's left in the reveal pool (all-closed tiers, NOT
//                 emptyKeys) after extraStepsLoaded — so a "Show More" click never reveals
//                 nothing.
// revealAll bypasses the local reveal pool for narrowing filters; empty tiers stay separate.
export function computeTierWindow(tierKeys, { allStepsLoaded, revealAll = false, extraStepsLoaded, hasActiveMatch, hasAnyMatch } = {}) {
  const keys = Array.isArray(tierKeys) ? tierKeys : [];
  if (keys.length === 0) return { visibleKeys: [], emptyKeys: [], hiddenCount: 0 };

  const emptyKeys = keys.filter(k => !hasAnyMatch(k));

  if (allStepsLoaded || revealAll) return { visibleKeys: keys.filter(hasAnyMatch), emptyKeys, hiddenCount: 0 };

  let visibleKeys = keys.filter(hasActiveMatch);
  let pool = keys.filter(k => !hasActiveMatch(k) && hasAnyMatch(k));

  if (visibleKeys.length === 0) {
    // No tier has active work — seed with the newest tier that has ANY card, so the board
    // never renders blank. Pull it out of the pool so it isn't double-counted as hidden.
    const anyMatch = keys.filter(hasAnyMatch);
    if (anyMatch.length > 0) {
      const seed = anyMatch[anyMatch.length - 1];
      visibleKeys = [seed];
      pool = pool.filter(k => k !== seed);
    }
  }

  const extraToShow = Math.min(extraStepsLoaded || 0, pool.length);
  const extraKeys = extraToShow > 0 ? pool.slice(-extraToShow) : [];
  const hiddenCount = pool.length - extraToShow;

  const visibleSet = new Set([...visibleKeys, ...extraKeys]);
  const orderedVisible = keys.filter(k => visibleSet.has(k));

  return { visibleKeys: orderedVisible, emptyKeys, hiddenCount };
}
