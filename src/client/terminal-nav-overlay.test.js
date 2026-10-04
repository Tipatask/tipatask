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
});

// (TPT485) The PTY's size is compared against what it was last TOLD, not against the xterm's
// size before this fit: a silent fit (open, replay, `refresh()` without send) landing first used
// to leave the agent drawing for the old width — the garbled right-edge wrap.
test('every fit syncs the PTY; dedup is against the last size sent', () => {
  const send = fnBody(modal, 'function sendResize(');
  assert.match(send, /!force && lastSentSize && lastSentSize\.cols === cols && lastSentSize\.rows === rows\) return;/);
  assert.match(send, /lastSentSize = \{ cols, rows \};/);
  const refresh = fnBody(modal, 'function refreshTerminalViewport(');
  assert.match(refresh, /sendResize\(\{ force: send \}\);/);
  assert.doesNotMatch(refresh, /if \(send\) sendResize/);
  assert.match(modal, /setStatus\('', 'Connected'\);\s*lastSentSize = null;[^\n]*\n\s*fitAndSendResize\(\);/);
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

// (TPT479) The task workspace is one stable frame: rail uncovered on every pane, one header
// grid, ✕ as the only close control, and the Agent Terminal tab as the only status dot.
test('workspace: rail on every pane, uniform header, ✕-only close, single status dot', () => {
  const editModal = readFileSync(new URL('./task-edit-modal.js', import.meta.url), 'utf8');
  assert.match(editModal, /<div class="task-edit-overlay\$\{tabs \? ' task-edit-overlay--rail' : ''\}">/);
  assert.doesNotMatch(editModal, /toggle\('task-edit-overlay--rail', pane === 'terminal'\)/);
  assert.match(ruleBody('.task-edit-panel--tabs .modal-top-bar'), /grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\) auto/);
  assert.match(ruleBody('.task-edit-panel--tabs .btn-modal-cancel'), /display:\s*none/);
  assert.doesNotMatch(css, /\.task-edit-panel--tabs\[data-pane="edit"\] \.btn-modal-close/);
  assert.match(css, /\.terminal-embed \.status-dot \{ display: none; \}/);
  // Every toolbar-dot write goes through setStatus(), which reports to the hosting workspace.
  const task = fnBody(modal, 'export function openTerminal(', '');
  assert.doesNotMatch(task.replace(/function setStatus\([\s\S]*?\n  \}\n/, ''), /statusDot\.(className|title)\s*=/);
  assert.match(task, /onStatus = typeof next\.onStatus === 'function'/);
});

// (TPT485) The rail stays live through a workspace swap: the loader starts at its edge, the
// open workspace (not only a mounted xterm) owns the highlighted row, the toolbar dot of an
// embedded terminal never shows, and the terminal toolbar shares the header's side padding.
test('workspace swap keeps the rail live and the toolbar aligned', () => {
  assert.match(ruleBody('body.task-modal-rail .board-modal-loader'), /left:\s*200px/);
  assert.match(ruleBody('body.task-modal-rail.left-nav-collapsed .board-modal-loader'), /left:\s*56px/);
  assert.match(css, /@media \(max-width: 768px\)\s*\{\s*body\.task-modal-rail \.board-modal-loader\s*\{\s*left:\s*56px/);
  assert.match(ruleBody('.task-modal-pane--terminal .terminal-header'), /padding:\s*8px 18px/);
  const sync = fnBody(board, 'export function syncActiveSessionsNav()', '');
  assert.match(sync, /const openId = getOpenWorkspaceTaskId\(\) \|\| state\.activeTerminal\?\.taskId \|\| null;/);
  const task = fnBody(modal, 'export function openTerminal(', '');
  assert.match(task, /statusDot\.hidden = !!hostEl;/);
  const editModal = readFileSync(new URL('./task-edit-modal.js', import.meta.url), 'utf8');
  assert.match(editModal, /if \(openSeq !== _openSeq\) return;/);
  assert.match(editModal, /closeTaskEditModal\(true, \{ keepRail: true \}\)/);
});
