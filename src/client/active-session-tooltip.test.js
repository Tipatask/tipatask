import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// (TPT414) Left-nav session row tooltip: full title travels as data-tooltip and is rendered by a
// body-appended tooltip (a ::after inside the overflow-clipped rail would be cut off). CSS and the
// browser-only module aren't executable under node, so the invariants are source-scanned.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const boardJs = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');

const renderFn = boardJs.match(/export function renderActiveSessionsList[\s\S]*?\n\}\n/)?.[0] || '';

test('row emits data-tooltip + aria-label with the full (untruncated) tip text', () => {
  assert.ok(renderFn, 'renderActiveSessionsList not found');
  assert.match(renderFn, /data-tooltip="\$\{tip\}"/);
  assert.match(renderFn, /aria-label="\$\{tip\}"/);
  assert.doesNotMatch(renderFn, /<button[^`]*\stitle="/, 'row must not carry a native title');
  assert.match(renderFn, /t\('nav\.sessionTooltip', \{ key: s\.taskId, title: s\.title \}\)/);
  assert.match(renderFn, /s\.title \? .+ : String\(s\.taskId\)/, 'bare-key fallback kept');
  assert.doesNotMatch(renderFn, /slice|substring|…/, 'tip text must not be truncated');
});

test('close control has no native title that would win under the pointer', () => {
  const close = renderFn.match(/const closeBtn = [\s\S]*?;\n/)?.[0] || '';
  assert.ok(close, 'closeBtn not found');
  assert.doesNotMatch(close, /\stitle=/);
  assert.match(close, /aria-label=/);
});

test('tooltip controller is bound once on the list host and anchored to the rail edge', () => {
  assert.match(boardJs, /function ensureSessionTooltips\(host\)/);
  assert.match(boardJs, /ensureSessionTooltips\(host\);/);
  assert.match(boardJs, /getElementById\('left-nav-panel'\)/);
  assert.match(boardJs, /tip\.className = 'active-session-tooltip'/);
});

test('.active-session-tooltip is a fixed, wrapping, non-interactive, capped box', () => {
  const m = css.match(/\.active-session-tooltip\s*\{([^}]*)\}/);
  assert.ok(m, '.active-session-tooltip rule not found');
  assert.match(m[1], /position:\s*fixed/);
  assert.match(m[1], /pointer-events:\s*none/);
  assert.match(m[1], /white-space:\s*normal/);
  assert.match(m[1], /max-width:\s*320px/);
  assert.match(m[1], /var\(--c-bg-card/);
});
