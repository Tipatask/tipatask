import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// (TPT344) On a board card only the description (.card-desc) scrolls; the header, controls and
// tags stay pinned. CSS isn't executable under node, so the invariants are source-scanned, same
// as card-header-row.test.js.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const cardJs = readFileSync(new URL('./task-card.js', import.meta.url), 'utf8');
const utilsJs = readFileSync(new URL('./utils.js', import.meta.url), 'utf8');

// Body of the first rule whose selector text matches `selectorRe` (selector must end at `{`).
function ruleBody(selectorRe) {
  const m = css.match(new RegExp(selectorRe.source + String.raw`\s*\{([^}]*)\}`));
  assert.ok(m, `rule ${selectorRe} not found`);
  return m[1];
}

// Source of a top-level function, from its declaration to the next top-level closing brace.
function fnSource(name) {
  const start = cardJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() not found`);
  const end = cardJs.indexOf('\n}\n', start);
  return cardJs.slice(start, end);
}

test('renderCard keeps .card-desc a direct child between the controls and the tag chips', () => {
  const controls = cardJs.indexOf('<div class="task-card-hover-controls">');
  const desc = cardJs.indexOf('<div class="card-desc');
  const tags = cardJs.indexOf('<div class="card-tags">');
  assert.ok(controls > 0 && desc > controls && tags > desc, 'card-desc is not between controls and tags');
});

test('every non-description row of a board card is pinned at its own height', () => {
  assert.match(ruleBody(/\n\s*\.card:not\(\.card--preview\) > \*/), /flex:\s*none/);
});

test('the board .card-desc shrinks, clips at rest and reserves a bar gutter', () => {
  const body = ruleBody(/\n\s*\.card:not\(\.card--preview\) > \.card-desc/);
  assert.match(body, /flex:\s*0 1 auto/);
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /overflow:\s*hidden/);
  assert.match(body, /scrollbar-gutter:\s*stable/);
  // The box is widened by exactly the gutter (past the base rule's max-width: 100%) so the text
  // column — and every line wrap — matches a card that has no gutter.
  assert.match(body, /(?<!max-)width:\s*calc\(100% \+ 10px\)/);
  assert.match(body, /max-width:\s*calc\(100% \+ 10px\)/);
});

test('the expanded board .card-desc is the scroll container', () => {
  const body = ruleBody(/\n\s*\.card\.card-expanded:not\(\.card--preview\) > \.card-desc/);
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /overflow-x:\s*hidden/);
});

test('a resting truncated board card fades its description, not the card bottom', () => {
  const fade = ruleBody(/\n\s*\.card\.is-truncated:not\(\.card--preview\):not\(\.card-expanded\) > \.card-desc/);
  assert.match(fade, /mask-image:\s*linear-gradient/);
  assert.match(css, /\.card:not\(\.card--preview\)\.is-truncated::after \{ display: none; \}/);
});

test('the board card root is never a scroll container, and keeps a height cap', () => {
  const root = ruleBody(/\n\s*\.card\.card-expanded:not\(\.card--preview\)/);
  assert.match(root, /overflow:\s*clip/);
  assert.doesNotMatch(root, /overflow-y:\s*auto/);
  // The shared expanded rule no longer scrolls anything on its own.
  const shared = css.match(/\.card\.card-expanded,\s*\.preview-card\.card-expanded \{([^}]*)\}/);
  assert.ok(shared, 'shared expanded rule not found');
  assert.doesNotMatch(shared[1], /overflow/);
  assert.match(shared[1], /max-height:\s*min\(80vh, calc\(100vh - 20px\)\)/);
  // Resting cap stays: min-height: 0 on the description needs a bounded flex column.
  const base = css.match(/\n\s*\.card \{([^}]*display: flex[^}]*)\}/);
  assert.ok(base, 'base .card rule not found');
  assert.match(base[1], /max-height:\s*500px/);
});

test('preview overlays still scroll as a whole', () => {
  const body = ruleBody(/\n\s*\.preview-card\.card-expanded,\s*\.card--preview\.card-expanded/);
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /overflow-x:\s*clip/);
});

test('expandCard() only gives the card root an inline scroll when it is a preview', () => {
  const src = fnSource('expandCard');
  assert.match(src, /if \(isPreviewOverlay\) card\.style\.overflowY = 'auto'/);
  assert.doesNotMatch(src, /^\s*card\.style\.overflowY = 'auto';/m);
  // (TPT456) Position from the laid-out height once the expanded cap is applied — the card's
  // own scrollHeight would under-report a clipped description (TPT344).
  assert.match(src, /maxHeight = expandedCardMaxHeight\([\s\S]*height: card\.offsetHeight/);
});

test('collapseCard() rewinds the description so a resting card never shows a mid-text slice', () => {
  assert.match(fnSource('collapseCard'), /\.card-desc'\);\s*if \(expandedDesc\) expandedDesc\.scrollTop = 0/);
});

test('markTruncatedCards() flags a board card whose description is clipped', () => {
  const start = utilsJs.indexOf('export function markTruncatedCards()');
  assert.ok(start >= 0);
  const src = utilsJs.slice(start, utilsJs.indexOf('\n}\n', start));
  assert.match(src, /:scope > \.card-desc/);
  assert.match(src, /desc\.scrollHeight > desc\.clientHeight/);
  // Previews clamp on purpose and must not gain the class through the description path.
  assert.match(src, /matches\('\.card--preview, \.preview-card'\) \? null/);
});

// (TPT456) The expanded overlay is re-clamped to the viewport whenever its real height changes,
// and it snaps to its full layout instead of animating its controls open after placement.
test('expandCard re-places the overlay on size change and collapseCard tears it down', () => {
  const expand = fnSource('expandCard');
  assert.match(expand, /new ResizeObserver\(placeExpanded\)/);
  assert.match(expand, /clampExpandedTop\(/);
  assert.match(expand, /card\.offsetHeight/);
  assert.match(expand, /addEventListener\('resize', placeExpanded\)/);
  assert.match(fnSource('collapseCard'), /expandedPlacementTeardown\(\)/);
});

test('an expanded card does not animate its controls or description margin open', () => {
  const body = ruleBody(/\n\s*\.card\.card-expanded \.task-card-hover-controls,\s*\n\s*\.card\.card-expanded > \.card-desc/);
  assert.match(body, /transition:\s*none/);
});
