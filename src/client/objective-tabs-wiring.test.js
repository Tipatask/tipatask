import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// (C1462) Regression guards for the objective nav tabs' wiring — the parts that can't be
// unit-tested directly because they live in inline <script> code (template.html) with no
// jsdom in this repo, or are ordering/selector invariants that must hold for the feature to
// work at all. Source-scan style, same house pattern as objective-grouping-wiring.test.js/
// parent-task-pane.test.js. The pure resolver/state logic (upsertObjectiveTab,
// resolveObjectiveParent, etc.) is directly unit-tested in objective-tabs.test.js.

function readSource(file) {
  return fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8');
}

// Extracts a top-level function body by name — same helper as objective-grouping-wiring.test.js.
function extractFunctionBody(source, name) {
  const startRe = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm');
  const startMatch = startRe.exec(source);
  assert.ok(startMatch, `function ${name}() not found in source`);
  const startIdx = startMatch.index;
  const nextDeclRe = /^(?:export )?(?:async )?function \w+\(/gm;
  nextDeclRe.lastIndex = startIdx + startMatch[0].length;
  const nextMatch = nextDeclRe.exec(source);
  const endIdx = nextMatch ? nextMatch.index : source.length;
  return source.slice(startIdx, endIdx);
}

test('template.html: syncObjectiveTabsState() runs before the app.innerHTML write', () => {
  const html = readSource('template.html');
  const syncCallIdx = html.indexOf('syncObjectiveTabsState();');
  // There are two `app.innerHTML = \`` writes in this file — an early "sign-in required"
  // error box (:1057) and the real board render (:2008). Anchor on the latter specifically,
  // via the <nav class="top-nav that immediately follows it.
  const innerHtmlIdx = html.indexOf('app.innerHTML = `\n    <nav class="top-nav');
  assert.ok(syncCallIdx !== -1, 'syncObjectiveTabsState() no-hint call site not found — the ' +
    'declarative nav-tab render needs state.objectiveTabs current BEFORE the innerHTML write');
  assert.ok(innerHtmlIdx !== -1, 'the board-render app.innerHTML = ` write not found');
  assert.ok(syncCallIdx < innerHtmlIdx, 'syncObjectiveTabsState() must run before app.innerHTML ' +
    'is written — otherwise the desktop/mobile nav tab markup renders from stale state');
});

test('template.html: objective-tab markup carries data-objective-key, never data-tab or data-mobile-tab', () => {
  const html = readSource('template.html');
  const fnBody = extractFunctionBody(html, 'renderObjectiveNavTabsHtml');
  assert.match(fnBody, /data-objective-key/, 'renderObjectiveNavTabsHtml() must stamp data-objective-key');
  assert.doesNotMatch(fnBody, /data-tab="/, 'objective-tab buttons must not carry data-tab — ' +
    'the generic .nav-tabs button[data-tab] delegation (bindTabButton) would otherwise bind them too');
  assert.doesNotMatch(fnBody, /data-mobile-tab="/, 'objective-tab buttons must not carry ' +
    'data-mobile-tab — the plain .mobile-menu-item click handler must not treat them as a real tab');
});

// (C1463) The close button's markup and click-routing invariants.
test('template.html: objective-tab markup carries data-objective-close-key, still never data-tab or data-mobile-tab', () => {
  const html = readSource('template.html');
  const fnBody = extractFunctionBody(html, 'renderObjectiveNavTabsHtml');
  assert.match(fnBody, /data-objective-close-key/, 'renderObjectiveNavTabsHtml() must stamp data-objective-close-key on the close button');
  assert.doesNotMatch(fnBody, /data-tab="/, 'the close button must not carry data-tab either');
  assert.doesNotMatch(fnBody, /data-mobile-tab="/, 'the close button must not carry data-mobile-tab either');
});

test('template.html: the close button is a SIBLING of the tab button, never nested', () => {
  const html = readSource('template.html');
  const fnBody = extractFunctionBody(html, 'renderObjectiveNavTabsHtml');
  const tabButtonClose = fnBody.indexOf('</button>');
  const closeButtonOpen = fnBody.indexOf('data-objective-close-key');
  assert.ok(tabButtonClose !== -1 && closeButtonOpen !== -1 && tabButtonClose < closeButtonOpen,
    'the tab label button must close (</button>) before the close button opens — nesting ' +
    'the close button inside the label button would create a nested interactive element and ' +
    'pull the × into the label\'s overflow:hidden/text-overflow:ellipsis truncation');
});

test('template.html: the close branch is checked before the navigation branch in the #app listener', () => {
  const html = readSource('template.html');
  const closeIdx = html.indexOf("closest('.nav-tab-objective-close[data-objective-close-key]')");
  const navIdx = html.indexOf("closest('.nav-tab-objective[data-objective-key]')");
  assert.ok(closeIdx !== -1, 'close-branch closest() call not found');
  assert.ok(navIdx !== -1, 'navigation-branch closest() call not found');
  assert.ok(closeIdx < navIdx, 'the delegated #app listener must check the close button before ' +
    'the navigation branch');
});

test('template.html: the objective-tab splice is anchored on the board entry, not backlog', () => {
  const html = readSource('template.html');
  assert.match(html, /isBoardTab\s*=\s*v\.tab\s*===\s*'board'/,
    "splice condition must check v.tab === 'board' — backlog can be hidden entirely " +
    "(sprints off, isHiddenViewTab()), which would silently drop the objective tabs too " +
    "if the splice were anchored there instead");
});

test("template.html: onProjectChanged clears state.objectiveTabs", () => {
  const html = readSource('template.html');
  const resetIdx = html.indexOf('state.sprints = [];');
  assert.ok(resetIdx !== -1, 'project-switch sprint reset line not found');
  const nearby = html.slice(resetIdx, resetIdx + 600);
  assert.match(nearby, /state\.objectiveTabs\s*=\s*\[\];/,
    "project switch must clear state.objectiveTabs alongside state.sprints — otherwise " +
    "project A's tabs render over project B's board and navigate to a nonexistent parentKey");
});

test('task-board.js: updateClaudeButtons() dispatches tiptask:objective-tabs-sync', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'updateClaudeButtons');
  assert.match(body, /tiptask:objective-tabs-sync/,
    "updateClaudeButtons()'s tail must dispatch tiptask:objective-tabs-sync — without it, " +
    "a local session start (openTerminal()'s ws.onopen, startTaskSession()) never repaints " +
    "the objective nav tabs since neither calls loadAndRender()");
});

test('template.html: both task:updated handlers call syncObjectiveTabsState(', () => {
  const html = readSource('template.html');
  const occurrences = html.split('syncObjectiveTabsState(').length - 1;
  // Declaration + no-hint render-time call + browser WS handler + Electron handler +
  // the tiptask:objective-tabs-sync listener + the tiptask:task-cache-patch listener (C1463,
  // so the tab's tick can flip live off a child status write) = 6 occurrences of the
  // identifier followed by '('.
  assert.ok(occurrences >= 6,
    `expected syncObjectiveTabsState( to appear at least 6 times (declaration + render call ` +
    `+ browser task:updated + Electron task:updated + objective-tabs-sync + task-cache-patch), found ${occurrences}`);
});

test('styles.css: .nav-objective-tabs and .nav-tab-objective rules exist', () => {
  const css = readSource('styles.css');
  assert.match(css, /\.nav-objective-tabs\s*\{/, '.nav-objective-tabs rule not found');
  assert.match(css, /\.nav-tab-objective-wrap\s*button\.nav-tab-objective\s*\{/, '.nav-tab-objective-wrap button.nav-tab-objective rule not found');
  assert.match(css, /\.mobile-objective-tabs\s*\{/, '.mobile-objective-tabs rule not found');
});

// (C1463) The close button + wrapper + tick's own CSS rules exist.
test('styles.css: .nav-tab-objective-wrap, .nav-tab-objective-close, and .nav-tab-objective-tick rules exist', () => {
  const css = readSource('styles.css');
  assert.match(css, /\.nav-tab-objective-wrap\s*\{/, '.nav-tab-objective-wrap rule not found');
  assert.match(css, /\.nav-tabs\s*button\.nav-tab-objective-close\s*\{/, '.nav-tabs button.nav-tab-objective-close rule not found');
  assert.match(css, /\.nav-tab-objective-tick\s*\{/, '.nav-tab-objective-tick rule not found');
});

test('i18n.js: nav.objectiveBoardTab key present in en and uk', () => {
  const src = readSource('i18n.js');
  const matches = src.match(/'nav\.objectiveBoardTab':/g) || [];
  assert.equal(matches.length, 2, 'nav.objectiveBoardTab must be defined in both en and uk tables');
});

// (C1463) New close/done i18n keys defined in both locale tables.
test('i18n.js: objective-tab close/done keys present in en and uk', () => {
  const src = readSource('i18n.js');
  for (const key of ['nav.objectiveTabDone', 'nav.objectiveTabClose', 'nav.confirmCloseObjectiveTab']) {
    const escaped = key.replace(/\./g, '\\.');
    const matches = src.match(new RegExp(`'${escaped}':`, 'g')) || [];
    assert.equal(matches.length, 2, `${key} must be defined in both en and uk tables`);
  }
});

test('ws-handlers.js: the terminateChildren connect branch is checked before the KB session-sync fireSessionSync call', () => {
  const src = readSource(path.join('..', 'server', 'ws-handlers.js'));
  const branchIdx = src.indexOf("searchParams.get('terminateChildren')");
  const kbSyncIdx = src.indexOf('fireSessionSync(');
  assert.ok(branchIdx !== -1, 'terminateChildren connect branch not found');
  assert.ok(kbSyncIdx !== -1, 'fireSessionSync( call not found');
  assert.ok(branchIdx < kbSyncIdx, 'closing an objective tab must never trigger a KB sync/' +
    're-index — the terminateChildren branch must be checked (and return) before the KB ' +
    'session-sync block runs, same reasoning the __attention__ branch\'s own placement gives');
});
