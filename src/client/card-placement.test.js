import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandedCardMaxHeight, clampExpandedTop, resolveAnchorTop, OVERLAY_MARGIN } from './card-placement.js';

// (TPT456) The expanded card overlay must stay inside the viewport, wherever its card rests.
const vh = 900;
const bottomOf = (top, height) => top + Math.min(height, expandedCardMaxHeight({ viewportHeight: vh }));

test('a card that fits at its resting spot stays there', () => {
  assert.equal(clampExpandedTop({ anchorTop: 200, height: 300, viewportHeight: vh }), 200);
});

// (TPT472) A fitting card keeps its resting top exactly — no lift, not even at the boundary.
test('a fitting card whose bottom lands exactly on the bottom margin keeps its anchor', () => {
  const height = 400;
  const anchorTop = vh - height - OVERLAY_MARGIN;
  assert.equal(clampExpandedTop({ anchorTop, height, viewportHeight: vh }), anchorTop);
});

test('a fitting card that grows on a re-run but still fits keeps the same top', () => {
  const first = clampExpandedTop({ anchorTop: 120, height: 300, viewportHeight: vh });
  const after = clampExpandedTop({ anchorTop: 120, height: 356, viewportHeight: vh });
  assert.equal(first, 120);
  assert.equal(after, 120);
});

test('the anchor is the live slot top, not the expand-time top', () => {
  // A card above dropped its 56px peek controls after expand: the slot moved up, no scroll.
  assert.equal(resolveAnchorTop({ slotTop: 64, expandTop: 120, scrollDelta: 0 }), 64);
  // The live rect is already viewport-relative, so a scroll delta is never applied on top of it.
  assert.equal(resolveAnchorTop({ slotTop: 20, expandTop: 120, scrollDelta: 100 }), 20);
});

test('without a live slot the anchor falls back to the expand-time top minus the scroll delta', () => {
  assert.equal(resolveAnchorTop({ slotTop: undefined, expandTop: 120, scrollDelta: 40 }), 80);
  assert.equal(resolveAnchorTop({ expandTop: 120 }), 120);
});

test('a short card resting near the bottom lifts just enough to show its bottom edge', () => {
  const top = clampExpandedTop({ anchorTop: 800, height: 300, viewportHeight: vh });
  assert.equal(top, vh - 300 - OVERLAY_MARGIN);
});

test('a tall card at the bottom keeps both its top and its bottom on screen', () => {
  const height = expandedCardMaxHeight({ viewportHeight: vh });
  const top = clampExpandedTop({ anchorTop: 850, height, viewportHeight: vh });
  assert.ok(top >= OVERLAY_MARGIN);
  assert.ok(bottomOf(top, height) <= vh - OVERLAY_MARGIN);
});

test('a card taller than the viewport pins to the top margin instead of going above it', () => {
  assert.equal(clampExpandedTop({ anchorTop: 700, height: 5000, viewportHeight: vh }), OVERLAY_MARGIN);
});

test('a card scrolled above the viewport is pulled back to the top margin', () => {
  assert.equal(clampExpandedTop({ anchorTop: -120, height: 200, viewportHeight: vh }), OVERLAY_MARGIN);
});

test('board cards cap at 80vh, chat previews at the viewport minus margins', () => {
  assert.equal(expandedCardMaxHeight({ viewportHeight: 1000 }), 800);
  assert.equal(expandedCardMaxHeight({ viewportHeight: 1000, isPreview: true }), 980);
  // A tiny viewport never gets a cap taller than what fits between the margins.
  assert.equal(expandedCardMaxHeight({ viewportHeight: 60 }), 40);
});
