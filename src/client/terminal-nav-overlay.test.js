import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// (TPT360) A task terminal must leave the left-nav rail uncovered and interactive, and the
// terminal must refit when its area changes width. There is no DOM harness for console-modal.js
// and CSS isn't executable under node, so — like terminal-header.test.js — the invariants are
// source-scanned.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const modal = readFileSync(new URL('./console-modal.js', import.meta.url), 'utf8');
const board = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');

// Body of the first rule whose full selector text is `selector` (must end at `{`).
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|[\\n}])\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `rule ${selector} not found`);
  return m[1];
}

// Function body from its declaration to the next same-indent closing brace.
function fnBody(source, header, indent = '  ') {
  const start = source.indexOf(header);
  assert.ok(start > -1, `${header} not found`);
  const end = source.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > start, `end of ${header} not found`);
  return source.slice(start, end);
}

test('task overlay is offset by the rail width: 200px, 56px collapsed, 56px at <=768px', () => {
  assert.match(ruleBody('.terminal-overlay--task'), /left:\s*200px/);
  assert.match(ruleBody('body.left-nav-collapsed .terminal-overlay--task'), /left:\s*56px/);
  assert.match(css, /@media \(max-width: 768px\)\s*\{\s*\.terminal-overlay--task\s*\{\s*left:\s*56px/);
});

test('offsets mirror the #left-nav-panel widths they sit beside', () => {
  assert.match(ruleBody('#left-nav-panel'), /width:\s*200px/);
  assert.match(ruleBody('body.left-nav-collapsed #left-nav-panel'), /width:\s*56px/);
  assert.match(css, /@media \(max-width: 768px\)\s*\{\s*\.container\s*\{[^}]*\}\s*#left-nav-panel\s*\{\s*width:\s*56px/);
});

test('overlay stays in the terminal z-index tier — the rail is outside the box, not stacked over', () => {
  assert.match(ruleBody('.terminal-overlay'), /z-index:\s*2000/);
  assert.doesNotMatch(ruleBody('.terminal-overlay--task'), /z-index|pointer-events/);
});

test('openTerminal() marks its overlay --task; the Debug Console keeps the full-cover overlay', () => {
  const task = fnBody(modal, 'export function openTerminal(', '');
  assert.match(task, /overlay\.className = 'terminal-overlay terminal-overlay--task'/);
  const objective = fnBody(modal, 'export function openObjectiveConsole()', '');
  assert.match(objective, /overlay\.className = 'terminal-overlay';/);
  assert.doesNotMatch(objective, /terminal-overlay--task/);
});

test('body ResizeObserver is attached and torn down with the viewport listeners', () => {
  const attach = fnBody(modal, 'function attachViewportListeners()');
  assert.match(attach, /new ResizeObserver\(scheduleBodyRefit\)/);
  assert.match(attach, /\.observe\(termBody\)/);
  const detach = fnBody(modal, 'function detachViewportListeners()');
  assert.match(detach, /bodyResizeObserver\.disconnect\(\)/);
  assert.match(detach, /clearTimeout\(bodyResizeTimer\)/);
});

test('refit is debounced and only messages the PTY when cols/rows changed', () => {
  assert.match(fnBody(modal, 'function scheduleBodyRefit()'), /clearTimeout\(bodyResizeTimer\);[\s\S]*setTimeout\([\s\S]*,\s*\d+\);/);
  const fit = fnBody(modal, 'function fitIfSizeChanged()');
  assert.match(fit, /!terminalOpened \|\| terminalClosing \|\| terminalDisposed/);
  assert.match(fit, /refreshTerminalViewport\(\)/);
  assert.match(fit, /term\.cols !== cols \|\| term\.rows !== rows/);
  assert.match(fit, /sendResize\(\)/);
});

test('backdrop mousedown still minimizes only when the overlay itself is the target', () => {
  assert.match(modal, /overlay\.addEventListener\('mousedown', \(e\) => \{\s*if \(e\.target !== overlay\) return;[\s\S]*?detachTerminal\(\);/);
});

test('rail rows are not rewritten when their markup is unchanged', () => {
  const sync = fnBody(board, 'export function syncActiveSessionsNav()', '');
  assert.match(sync, /host\._sessionsHtml === html && host\.children\.length === rows\.length\) return;/);
  assert.ok(
    sync.indexOf('host._sessionsHtml === html') < sync.indexOf('host.innerHTML = html'),
    'skip must run before the innerHTML rewrite',
  );
});

test('Project Board / Create rail buttons minimize an open task terminal before navigating', () => {
  const handler = template.slice(template.indexOf("panel.querySelectorAll('.left-nav-btn[data-section]').forEach"));
  const minimize = handler.indexOf('state.activeTerminal.detach?.({ refreshBoard: false })');
  assert.ok(minimize > -1, 'section nav handler must detach state.activeTerminal');
  assert.ok(minimize < handler.indexOf("perfStart('nav-section-switch'"), 'detach must precede navigation');
  assert.match(handler.slice(0, handler.indexOf("perfStart('nav-section-switch'")), /state\.pendingRestoreContext = null/);
});
