import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// (C1461) Regression guards for the parent detail pane's wiring — the parts that can't be
// unit-tested directly because they live in inline `<script>` code (template.html) with no
// jsdom in this repo, or are render-order/selector invariants that must hold to keep the
// pane invisible to the board's own card machinery. Source-scan style, same house pattern
// as objective-grouping-wiring.test.js/dialogs.test.js. The pane's own count math
// (countChildProgress) is pure and directly unit-tested in subtask-count.test.js.

function readSource(file) {
  return fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8');
}

test('template.html: renderParentTaskPane() is called between renderBreadcrumbs() and .content-area', () => {
  const html = readSource('template.html');
  const breadcrumbIdx = html.indexOf('renderBreadcrumbs(state.subtaskStack)');
  const paneIdx = html.indexOf('renderParentTaskPane(state.subtaskParentTask');
  const contentAreaIdx = html.indexOf('<div class="content-area"');
  assert.ok(breadcrumbIdx !== -1, 'renderBreadcrumbs(state.subtaskStack) call not found');
  assert.ok(paneIdx !== -1, 'renderParentTaskPane(state.subtaskParentTask, ...) call not found — ' +
    'the parent pane must still render somewhere between the breadcrumb bar and .content-area');
  assert.ok(contentAreaIdx !== -1, '.content-area container not found');
  assert.ok(
    breadcrumbIdx < paneIdx && paneIdx < contentAreaIdx,
    'renderParentTaskPane() must sit between the breadcrumb bar and .content-area in document order'
  );
});

// (TPT24) The pane is board-only now — .btn-create-subtasks still pushes the objective onto
// state.subtaskStack (so the board lands on the objective's own subtask board once the chat
// saves), but the tall preview slab must not render over the New Objective/New Task composer.
// The breadcrumb bar itself stays gated on the stack alone (renders on every tab).
test('template.html: renderParentTaskPane() call site is additionally gated on isTasksSection', () => {
  const html = readSource('template.html');
  const paneIdx = html.indexOf('renderParentTaskPane(state.subtaskParentTask');
  assert.ok(paneIdx !== -1, 'renderParentTaskPane(state.subtaskParentTask, ...) call not found');
  const window = html.slice(Math.max(0, paneIdx - 120), paneIdx);
  assert.match(
    window,
    /isTasksSection\s*&&\s*state\.subtaskStack\.length/,
    'renderParentTaskPane() call must be gated on `isTasksSection && state.subtaskStack.length` — ' +
      'a bare state.subtaskStack.length would render the pane over the composer tabs again'
  );
  const breadcrumbIdx = html.indexOf('renderBreadcrumbs(state.subtaskStack)');
  const breadcrumbWindow = html.slice(Math.max(0, breadcrumbIdx - 60), breadcrumbIdx);
  assert.doesNotMatch(
    breadcrumbWindow,
    /isTasksSection/,
    'renderBreadcrumbs() call must stay gated on the stack alone — it still renders on composer tabs'
  );
});

// (TPT59) No more .breadcrumb-home — the top-nav Project Board tab is the sole "exit to
// root" affordance now. Only .breadcrumb-item[data-idx] needs the composer-tab check below.
test('template.html: breadcrumb-item handler exits a composer tab to the board', () => {
  const html = readSource('template.html');
  const startIdx = html.indexOf("app.querySelectorAll('.breadcrumb-item[data-idx]')");
  assert.ok(startIdx !== -1, '.breadcrumb-item[data-idx] handler not found');
  const endIdx = html.indexOf("app.querySelectorAll('.breadcrumb-ellipsis')");
  assert.ok(endIdx !== -1, '.breadcrumb-ellipsis handler not found (used as end marker)');
  const body = html.slice(startIdx, endIdx);
  const matches = (body.match(/isNewSectionTab\(\)/g) || []).length;
  assert.ok(
    matches >= 1,
    'the .breadcrumb-item[data-idx] handler must check isNewSectionTab() and switch ' +
      'state.activeTab to \'board\' — otherwise clicking a crumb from the New Objective/New ' +
      'Task composer silently does nothing visible'
  );
});

test('template.html/task-board.js/styles.css: .breadcrumb-home is fully removed (TPT59)', () => {
  // (TPT59) The top-nav Project Board tab already exits any drill-down to root via
  // exitSubtaskContextForTab() — a separate "Project Board" crumb duplicated it and ate
  // space in the nowrap bar. Regression guard: no code path should reintroduce the button,
  // its handler, or its markup/CSS. (Matches actual usage, not prose — this file's own
  // explanatory comments are allowed to name ".breadcrumb-home" when discussing the removal.)
  assert.doesNotMatch(
    readSource('template.html'),
    /querySelectorAll\('\.breadcrumb-home'\)/,
    'template.html must not register a .breadcrumb-home click handler'
  );
  assert.doesNotMatch(
    readSource('task-board.js'),
    /class="breadcrumb-home"/,
    'task-board.js\'s renderBreadcrumbs() must not emit a .breadcrumb-home button'
  );
  assert.doesNotMatch(
    readSource('styles.css'),
    /\.breadcrumb-home\b/,
    'styles.css must not style .breadcrumb-home'
  );
});

test('task-board.js: renderBreadcrumbs() opens the bar with no leading separator', () => {
  // (TPT59) _renderBreadcrumbSegment() used to prepend its own <span class="breadcrumb-sep">
  // to every segment — safe only because the (now-removed) .breadcrumb-home button always
  // came first. The bar markup must now be exactly the joined pieces, nothing prepended.
  const src = readSource('task-board.js');
  assert.match(
    src,
    /<div class="breadcrumb-bar">\$\{pieces\.join\(_BREADCRUMB_SEP\)\}<\/div>/,
    'renderBreadcrumbs() must return `pieces` joined by the separator with nothing else ' +
      'prepended inside .breadcrumb-bar — a leading sep would render a stray "›" at the start'
  );
});

test("chat-ui.js: objective view never references renderParentTaskPane", () => {
  const src = readSource('chat-ui.js');
  assert.doesNotMatch(
    src,
    /renderParentTaskPane/,
    'the objective/chat view must not grow its own parent-preview block (TPT24) — the only ' +
      'parent affordance there is the one-line .origin-context-banner already inside .chat-container'
  );
});

test('styles.css: .objective-chat--empty/--active height rules subtract --chat-chrome-above', () => {
  const css = readSource('styles.css');
  const matches = css.match(/height:\s*calc\([^)]*--chat-chrome-above[^)]*\)/g) || [];
  assert.ok(
    matches.length >= 4,
    '.objective-chat--empty/--active height rules (desktop 100vh/100dvh + mobile @media ' +
      'variants) must all subtract var(--chat-chrome-above, 0px) — without it, any board ' +
      'chrome (breadcrumb bar) left rendered above .chat-container on a composer tab pushes ' +
      '#chat-input below the fold'
  );
});

test('task-board.js: .parent-task-pane markup carries no data-id and no card class', () => {
  const src = readSource('task-board.js');
  const startIdx = src.indexOf('export function renderParentTaskPane');
  assert.ok(startIdx !== -1, 'renderParentTaskPane() not found in task-board.js');
  const nextDeclRe = /^(?:export )?(?:async )?function \w+\(/gm;
  nextDeclRe.lastIndex = startIdx + 'export function renderParentTaskPane('.length;
  const nextMatch = nextDeclRe.exec(src);
  const body = src.slice(startIdx, nextMatch ? nextMatch.index : src.length);
  assert.doesNotMatch(
    body,
    /data-id=/,
    '.parent-task-pane must never carry data-id — .tier .card[data-id] selectors drive ' +
      'search/tag filtering, drag hit-testing (task-card.js) and removeCardFromDom(); a pane ' +
      'that matched them would be silently dragged, filtered, or deleted alongside real cards'
  );
  // Whitespace-delimited token match — deliberately does NOT flag class="card-tags ..."
  // (task-board.js reuses that existing tag-chip wrapper class on purpose, see utils.js's
  // renderTagBadge()); only a literal standalone "card" token is the thing to guard against.
  assert.doesNotMatch(
    body,
    /class="(?:[^"]*\s)?card(?:\s[^"]*)?"/,
    '.parent-task-pane\'s root must never carry the bare "card" class for the same reason above'
  );
});

test('template.html: bindTabButton() calls exitSubtaskContextForTab() before its same-tab bail', () => {
  const html = readSource('template.html');
  const fnStart = html.indexOf('function bindTabButton(btn) {');
  assert.ok(fnStart !== -1, 'bindTabButton() not found');
  const fnEnd = html.indexOf('\n}', fnStart);
  const body = html.slice(fnStart, fnEnd);
  const exitIdx = body.indexOf('exitSubtaskContextForTab(');
  const bailIdx = body.indexOf('window.scrollTo(0, 0); return;');
  assert.ok(exitIdx !== -1, 'bindTabButton() must call exitSubtaskContextForTab(next) (C1461) — ' +
    'without it, clicking Project Board/Backlog while drilled into a subtask board keeps ' +
    'fetching ?parentKey=... under the new tab\'s label');
  assert.ok(bailIdx !== -1, 'same-tab bail (C1256) not found in bindTabButton()');
  assert.ok(
    exitIdx < bailIdx,
    'exitSubtaskContextForTab() must run BEFORE the same-tab bail — on a subtask board ' +
      'state.activeTab is already \'board\', so the bail would otherwise swallow the ' +
      'Project Board click outright'
  );
});

test('styles.css: .parent-task-pane is defined', () => {
  const css = readSource('styles.css');
  assert.match(css, /\.parent-task-pane\s*\{/, '.parent-task-pane rule not found in styles.css');
});
