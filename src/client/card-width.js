// ── Pure adaptive card-width helpers (C1580) ──
// No DOM, no imports — mirrors related-cards.js/drag-state.js/board-count-domain.js so it stays
// unit-testable under `node --test`. Consumed by renderCard()/refreshCard()/expandCard()/
// _startDrag() in task-card.js.

// Compact/medium/wide grid-column widths a card had before C1580 (2/3/4 tracks of
// `minmax(120px,1fr)` + 0.75rem gaps) — now the flex-basis floor each variant grows from.
export const CARD_BASIS = { base: 252, medium: 384, wide: 516 };

// Fallback per-character width estimators (px), used only when no live canvas measurement is
// available (e.g. under `node --test`, or before the first paint). Tuned for the card's actual
// fonts: title is 600/0.95rem (~15.2px), id badge is 700/0.75rem (~12px).
export const TITLE_CHAR_PX = 7.3;
export const ID_BADGE_CHAR_PX = 7.2;

// Card chrome a title must additionally clear: .card padding (24+24) + border (2+2) +
// .card-top gap before the title (~14) — rounded down slightly since the id badge's own
// padding is counted separately by idBadgeWidth().
export const CARD_CHROME_PX = 66;

// id badge horizontal padding (0.15rem*2 vertical is irrelevant here, 0.5rem*2 ≈ 16px
// horizontal) plus its own text.
const ID_BADGE_PADDING_PX = 16;

// Null-safe text-width estimator: charPx per character, 0 for empty/non-string input.
export function estimateTextWidth(text, charPx) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return text.length * charPx;
}

// Width the id badge occupies next to the title (drag handle + order badge, always present).
export function idBadgeWidth(taskKey) {
  return ID_BADGE_PADDING_PX + estimateTextWidth(taskKey, ID_BADGE_CHAR_PX);
}

// Same thresholds task-card.js used inline pre-C1580 — description length only, title never
// affects which variant (medium/wide) a card is, only how far it grows within that variant.
export function cardVariant(descriptionLength) {
  const len = descriptionLength || 0;
  if (len > 1500) return 'wide';
  if (len > 1000) return 'medium';
  return 'base';
}

// The width (px) a card would need for its title to render on one line, given its variant's
// basis as a floor — so a long-description/short-title card never gets a ceiling below the
// width it already had. `measureTitle` is injectable (task-card.js passes a canvas-based
// measurer); defaults to the char-count estimator above.
export function cardMaxWidthPx({ title, taskKey, variant, measureTitle } = {}) {
  const basis = CARD_BASIS[variant] ?? CARD_BASIS.base;
  const measure = typeof measureTitle === 'function' ? measureTitle : estimateTextWidth;
  const titleWidth = measure(title, TITLE_CHAR_PX) || 0;
  const needed = titleWidth + idBadgeWidth(taskKey) + CARD_CHROME_PX;
  return Math.round(Math.max(basis, needed));
}
