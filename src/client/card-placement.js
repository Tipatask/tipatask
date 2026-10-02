// (TPT456) Viewport placement for the expanded card overlay (expandCard() in task-card.js).
// Pure math, no DOM — kept out of task-card.js so node:test can exercise it directly.

export const OVERLAY_MARGIN = 10;

// Height cap for an expanded overlay. (TPT303) A chat proposal overlay may use the whole
// viewport height minus the margins; board cards keep 80vh, never more than the viewport allows.
export function expandedCardMaxHeight({ viewportHeight, isPreview = false, margin = OVERLAY_MARGIN }) {
  const full = Math.max(0, viewportHeight - 2 * margin);
  return isPreview ? full : Math.min(viewportHeight * 0.8, full);
}

// Top edge for an overlay of `height` that would rather sit at `anchorTop` (its resting spot).
// Stays at the anchor when it fits, lifts just enough to keep the bottom `margin` inside the
// viewport when it doesn't, and never goes above the top margin — a card taller than the
// viewport is capped by its max-height and scrolls inside instead.
export function clampExpandedTop({ anchorTop, height, viewportHeight, margin = OVERLAY_MARGIN }) {
  const visibleHeight = Math.min(height, Math.max(0, viewportHeight - 2 * margin));
  return Math.max(margin, Math.min(anchorTop, viewportHeight - visibleHeight - margin));
}
