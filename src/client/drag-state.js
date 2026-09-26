// ── Pure card-drag / render-guard predicates (C1438) ──
// Extracted out of task-card.js so they're unit-testable without pulling in that module's
// full DOM-touching import graph (task-board.js, ws-client.js, console-modal.js, ...) — the
// repo has no jsdom, so anything that imports those at module scope can't run under
// `node --test`. See ai/architecture/tt-task-cards-drag-drop.md "Root cause: drag vs. board
// re-render (C1438)".

// True once a re-render — a WS echo, a poll tick, an agent-driven status change — has
// detached the dragged card, its tier container, or the activated drag clone out from under
// an in-progress gesture. A null clone is valid before the activation threshold; afterwards
// it means the fixed-position visual was orphaned and the gesture must self-heal.
// Takes plain `{ isConnected }` objects, not real DOM nodes, so task-card.js's _onDragMove
// can self-heal (tear the gesture down instead of committing a drop against a dead subtree
// and writing garbage `order` values) and this stays testable without a browser.
export function isDragStateStale({ sourceCard, tierCards, clone, activated }) {
  return !sourceCard?.isConnected
    || !tierCards?.isConnected
    || (activated && !clone?.isConnected);
}

// Resolve the live sprint container beneath the cursor from plain rectangle data. The
// direct elementFromPoint() hit is only a preference: overlays, gaps, and a stale node can
// make that hit absent or wrong, while the current geometry of every rendered .tier-cards
// remains authoritative. Zero-area rectangles are ignored (collapsed/display:none tiers);
// a revealed empty tier still has the sentinel-backed rectangle and remains eligible.
//
// candidates: [{ tier, rect: { left, right, top, bottom } }]
// `tier` is an opaque identity value, so this helper remains DOM-free and node-testable.
export function resolveDropTier({ cursorX, cursorY, directHitTier = null, candidates = [] }) {
  const containing = candidates.filter(({ tier, rect }) => {
    if (tier == null || !rect) return false;
    const { left, right, top, bottom } = rect;
    if (![cursorX, cursorY, left, right, top, bottom].every(Number.isFinite)) return false;
    if (right <= left || bottom <= top) return false;
    return cursorX >= left && cursorX <= right && cursorY >= top && cursorY <= bottom;
  });

  if (containing.length === 0) return null;
  const direct = containing.find(({ tier }) => tier === directHitTier);
  return (direct || containing[0]).tier;
}

// The render-suppression decision shared by every full-render call site, via
// template.html's loadAndRender(). A drag gesture holds direct references to DOM nodes
// that a full `#app.innerHTML` rebuild would detach mid-gesture, so any such render must be
// deferred until the gesture ends (`tiptask:drag-ended`) — except the drop's own post-commit
// render, which passes `afterDrop: true` to escape the very guard it would otherwise trip.
export function shouldDeferForDrag({ afterDrop, dragging, dropInProgress }) {
  return !afterDrop && (dragging || dropInProgress);
}
