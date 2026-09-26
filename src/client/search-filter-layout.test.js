import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// (TPT351) The board keyword filter is visibility-only: typing a search phrase must never change
// a card's layout (it used to drop the max-height cap via `.card.search-match`, rendering every
// match fully expanded). CSS/DOM aren't executable under node and there's no jsdom here, so the
// invariants are source-scanned — same house pattern as card-desc-scroll.test.js.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const boardJs = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
const cardJs = readFileSync(new URL('./task-card.js', import.meta.url), 'utf8');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Every `selector { body }` rule (comments stripped) whose selector list mentions a search-filter class.
function searchFilterRules() {
  const rules = [];
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (/\.search-(match|hidden)\b/.test(selector)) rules.push({ selector, body: m[2] });
  }
  return rules;
}

// Source of a top-level function, from its declaration to its closing brace at column 0.
function fnSource(src, name) {
  const start = src.search(new RegExp(`^(?:export )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `${name}() not found`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end);
}

test('search-filter CSS rules exist and only .search-hidden is styled', () => {
  const rules = searchFilterRules();
  assert.ok(rules.some(r => /\.search-hidden/.test(r.selector)), '.search-hidden rule missing');
  for (const r of rules) {
    assert.doesNotMatch(r.selector, /\.search-match/, `.search-match must stay style-free, found: ${r.selector}`);
  }
});

test('no search-filter rule touches card layout or the collapsed clamp', () => {
  const layoutProp = /(^|;|\s)(max-height|min-height|height|overflow(?:-[xy])?|line-clamp|-webkit-line-clamp|display\s*:\s*(?!none))/;
  for (const r of searchFilterRules()) {
    assert.doesNotMatch(r.selector, /::?(after|before)/, `pseudo-element override in ${r.selector}`);
    const body = r.body.replace(/display\s*:\s*none\s*(!important)?/g, '');
    assert.doesNotMatch(body, layoutProp, `layout property in ${r.selector} { ${r.body.trim()} }`);
  }
});

test('applySearchFilter() toggles visibility classes only — no inline styles or expanded state', () => {
  const body = stripComments(fnSource(boardJs, 'applySearchFilter'));
  assert.doesNotMatch(body, /\.style\b|style\.|setProperty|cssText/, 'writes an inline style');
  assert.doesNotMatch(body, /card-expanded|card-hover-expanded|card-peek|expandCard\(/, 'touches card expansion');
  // Receivers that are cards or sprint containers only — `resetBtn` is the Clear button's own
  // chrome. `collapsed` is the sprint container's fold state (.tier), restored from
  // state.collapsedTiers on the no-filter path: a tier-level show/hide, not a card layout class.
  for (const [, receiver, cls] of body.matchAll(/(\w+)\.classList\.(?:add|remove|toggle)\('([^']+)'/g)) {
    if (receiver === 'resetBtn') continue;
    assert.match(cls, /^(search-(hidden|match)|collapsed)$/, `unexpected class "${cls}" written on ${receiver} by the search pass`);
  }
});

test('renderCard output does not depend on the search term', () => {
  assert.doesNotMatch(stripComments(cardJs), /searchQuery/, 'task-card.js reads state.searchQuery');
});
