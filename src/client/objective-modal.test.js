import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';

// (TPT9389) The Create modal: New Objective and New Task open in one dialog over the project
// board. Three layers are covered here —
//   1. objective-modal.js, the shell, for real in happy-dom (open/close, labels, the three close
//      gestures, who owns an Escape, the Tab cycle across the dialog and the left menu, focus);
//   2. template.html's closeCreateModal() / boardUnderlayCurrent(), run from source in a vm:
//      closing never renders the board unless it changed while the modal was open;
//   3. the wiring that cannot run under node (template.html's render root, chat-ui.js's repaint
//      path, task-card.js's backdrop host, styles.css's fixed size), as source scans.

const window = new Window({ url: 'http://127.0.0.1:4455/todo.html' });
for (const [key, value] of Object.entries({
  window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
  Node: window.Node, Event: window.Event, CustomEvent: window.CustomEvent,
  KeyboardEvent: window.KeyboardEvent, MouseEvent: window.MouseEvent,
  MutationObserver: window.MutationObserver, getComputedStyle: window.getComputedStyle.bind(window),
})) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });

const modal = await import('./objective-modal.js');
const i18n = await import('./i18n.js');
const dialogFocus = await import('./dialog-focus.js');

const read = name => readFileSync(new URL('./' + name, import.meta.url), 'utf8');
const templateSrc = read('template.html');
const chatUiSrc = read('chat-ui.js');
const css = read('styles.css');

// happy-dom lays nothing out: give every element one client rect so "is it displayed" holds, and
// let a test hide one by flagging it.
window.HTMLElement.prototype.getClientRects = function getClientRects() {
  return this.closest('[hidden]') || this.dataset.offscreen === '1' ? [] : [{ width: 10, height: 10 }];
};

const overlay = () => document.getElementById('objective-modal');
const panel = () => overlay().querySelector('.objective-modal-panel');
const is = (a, b) => a === b; // node identity as a boolean (assert.equal on nodes inspects them)

function key(target, name, init = {}) {
  const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function reset({ covered = false } = {}) {
  modal.closeObjectiveModal({ restoreFocus: false });
  i18n.setLocale('en');
  for (const el of [...document.body.children]) if (el.id !== 'objective-modal') el.remove();
  document.body.insertAdjacentHTML('afterbegin',
    '<div id="app"><button id="board-btn">board card</button></div>'
    + '<div id="left-nav-panel"><button data-section="tasks">Tasks</button><button data-section="new">Create</button></div>');
  const calls = [];
  modal.configureObjectiveModal({ onRequestClose: reason => calls.push(reason), isCovered: () => covered });
  return calls;
}

function fill(html) {
  const { body } = modal.openObjectiveModal({ mode: 'objective' });
  body.innerHTML = html;
  return body;
}

const OBJECTIVE = '<div class="chat-container"><button id="mode-objective">Objective</button>'
  + '<button id="btn-archive">History</button><textarea id="chat-input"></textarea>'
  + '<button id="btn-chat-send">Send</button></div>';

// ── 1. The shell ────────────────────────────────────────────────────────────────────────────

test('opening builds one body-level dialog and returns where to render; closing empties it', () => {
  reset();
  assert.equal(modal.isObjectiveModalOpen(), false);
  assert.equal(modal.objectiveModalBody() === null || !modal.isObjectiveModalOpen(), true);

  const first = modal.openObjectiveModal({ mode: 'objective' });
  assert.equal(first.opened, true, 'this call opened it');
  assert.equal(is(overlay().parentElement, document.body), true, 'a child of <body>, outside #app');
  assert.equal(overlay().classList.contains('objective-modal'), true);
  assert.equal(overlay().hidden, false);
  assert.equal(is(first.body, modal.objectiveModalBody()), true);
  assert.equal(first.body.classList.contains('objective-modal-body'), true);
  assert.equal(modal.isObjectiveModalOpen(), true);
  assert.equal(document.documentElement.classList.contains('objective-modal-open'), true, 'page held still');

  first.body.innerHTML = OBJECTIVE;
  const again = modal.openObjectiveModal({ mode: 'new_task' });
  assert.equal(again.opened, false, 'a render of the open dialog does not reopen it');
  assert.equal(document.querySelectorAll('#objective-modal').length, 1, 'never a second host');
  assert.equal(is(again.body, first.body), true);
  assert.equal(again.body.querySelector('#chat-input') !== null, true, 'content is the caller\'s to replace');

  assert.equal(modal.closeObjectiveModal(), true);
  assert.equal(overlay().hidden, true);
  assert.equal(modal.objectiveModalBody().children.length, 0, 'no Create DOM is left behind while closed');
  assert.equal(document.documentElement.classList.contains('objective-modal-open'), false);
  assert.equal(modal.closeObjectiveModal(), false, 'already closed');
});

test('the dialog is labelled for its mode, in the project language', () => {
  reset();
  modal.openObjectiveModal({ mode: 'objective' });
  assert.equal(panel().getAttribute('role'), 'dialog');
  assert.equal(panel().getAttribute('aria-modal'), 'true');
  assert.equal(panel().getAttribute('aria-label'), 'New Objective', 'what its heading and the Create flyout call it');
  assert.equal(panel().dataset.mode, 'objective');
  const close = overlay().querySelector('.objective-modal-close');
  assert.equal(close.getAttribute('aria-label'), 'Close');
  assert.equal(close.title, 'Close (Esc)');

  modal.openObjectiveModal({ mode: 'new_task' });
  assert.equal(panel().getAttribute('aria-label'), 'New Task');
  assert.equal(panel().dataset.mode, 'new_task');

  i18n.setLocale('uk');
  modal.openObjectiveModal({ mode: 'objective' });
  assert.equal(panel().getAttribute('aria-label'), i18n.t('nav.newObjective'));
  assert.notEqual(panel().getAttribute('aria-label'), 'New Objective');
  assert.equal(close.getAttribute('aria-label'), i18n.t('btn.close'));
});

test('×, Escape and a backdrop click ask the page to close, each with its reason', () => {
  const calls = reset();
  fill(OBJECTIVE);
  overlay().querySelector('.objective-modal-close').click();
  key(document.getElementById('chat-input'), 'Escape');
  overlay().dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  overlay().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(calls, ['button', 'escape', 'backdrop']);
  assert.equal(modal.isObjectiveModalOpen(), true, 'the page decides; the shell does not close itself');
});

test('a press that starts inside the panel never closes on the backdrop', () => {
  const calls = reset();
  fill(OBJECTIVE);
  // a text selection dragged out of the composer: mousedown in the panel, click lands on the overlay
  document.getElementById('chat-input').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  overlay().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  // and a click inside the panel after a backdrop press
  overlay().dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  panel().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(calls, []);
});

test('with no page handler the shell closes itself', () => {
  reset();
  modal.configureObjectiveModal({});
  fill(OBJECTIVE);
  key(document.getElementById('chat-input'), 'Escape');
  assert.equal(modal.isObjectiveModalOpen(), false);
});

// ── Escape ownership ────────────────────────────────────────────────────────────────────────

test('Escape belongs to whatever is above the dialog', async () => {
  let calls = reset({ covered: true });
  fill(OBJECTIVE);
  key(document.getElementById('chat-input'), 'Escape');
  assert.deepEqual(calls, [], 'an unlayered overlay (History, the lightbox, a terminal) is up');

  calls = reset();
  fill(OBJECTIVE);
  document.body.insertAdjacentHTML('beforeend', '<div id="layer"><button id="layer-btn">ok</button></div>');
  const layer = dialogFocus.activateDialogFocus({ root: document.getElementById('layer') });
  key(document.getElementById('layer-btn'), 'Escape');
  assert.deepEqual(calls, [], 'a dialog-focus layer is up');
  layer.close();

  key(document.getElementById('chat-input'), 'Escape');
  assert.deepEqual(calls, ['escape'], 'and it is the dialog\'s again once that layer is gone');
});

test('Escape typed in another body-level surface is not the dialog\'s', () => {
  const calls = reset();
  fill(OBJECTIVE);
  document.body.insertAdjacentHTML('beforeend', '<div class="portaled-menu"><input id="menu-input"></div>');
  key(document.getElementById('menu-input'), 'Escape');
  assert.deepEqual(calls, []);
  key(document.querySelector('[data-section="tasks"]'), 'Escape');
  key(document.body, 'Escape');
  assert.deepEqual(calls, ['escape', 'escape'], 'from the left menu, or with nothing focused, it is');
});

test('an open menu or an in-place edit inside the dialog takes the first Escape', () => {
  const calls = reset();
  const body = fill(OBJECTIVE + '<div class="tag-dropdown" data-offscreen="1"></div>');
  key(document.getElementById('chat-input'), 'Escape');
  assert.deepEqual(calls, ['escape'], 'a closed list that merely stays in the DOM does not count');

  for (const owner of ['<div class="import-submenu"></div>', '<span class="preview-title editing">t</span>',
    '<div class="sprint-combo-dropdown"></div>', '<div class="dep-typeahead-dropdown"></div>']) {
    calls.length = 0;
    body.insertAdjacentHTML('beforeend', `<div id="owner">${owner}</div>`);
    key(document.getElementById('chat-input'), 'Escape');
    assert.deepEqual(calls, [], owner);
    document.getElementById('owner').remove();
  }
});

test('a menu that closes itself on the same Escape does not let the dialog close too', () => {
  const calls = reset();
  const body = fill(OBJECTIVE + '<div class="import-submenu" id="menu"></div>');
  // The menu's own listener runs first in the bubble phase and removes it — as embed-menu.js does.
  const closeMenu = (event) => { if (event.key === 'Escape') document.getElementById('menu')?.remove(); };
  body.addEventListener('keydown', closeMenu);
  key(document.getElementById('chat-input'), 'Escape');
  assert.equal(document.getElementById('menu'), null, 'the menu closed');
  assert.deepEqual(calls, [], 'the dialog did not');
  key(document.getElementById('chat-input'), 'Escape');
  assert.deepEqual(calls, ['escape'], 'the next Escape is the dialog\'s');
});

test('an Escape another handler already consumed is left alone', () => {
  const calls = reset();
  fill(OBJECTIVE);
  const input = document.getElementById('chat-input');
  input.addEventListener('keydown', event => event.preventDefault());
  key(input, 'Escape');
  assert.deepEqual(calls, []);
});

test('(TPT9405) the open guide popover takes the first Escape; the next one closes the dialog', async () => {
  const guide = await import('./objective-stage.js');
  const { renderComposerHeader } = await import('./composer-header.js');
  const { default: state } = await import('./state.js');
  const calls = reset();
  const previous = state.activeTab;
  state.activeTab = 'objective';
  try {
    fill(`<div class="chat-container">${renderComposerHeader('<button id="btn-archive">History</button>', '',
      { helpHtml: guide.renderObjectiveGuideHtml() })}<textarea id="chat-input"></textarea></div>`);
  } finally {
    state.activeTab = previous;
  }
  guide.bindObjectiveGuideDismiss(document);
  const help = document.getElementById('objective-help-btn');

  key(help, 'Escape');
  assert.deepEqual(calls, ['escape'], 'closed, the popover leaves Escape to the dialog');
  calls.length = 0;

  guide.setObjectiveGuideOpen(document, true);
  const example = document.querySelector('.objective-example');
  example.focus();
  key(example, 'Escape');
  assert.deepEqual(calls, [], 'the popover closed and the dialog stayed');
  assert.equal(guide.objectiveGuideOpen(document), false);
  assert.equal(is(document.activeElement, help), true, 'focus is back on the (?) button');
  key(help, 'Escape');
  assert.deepEqual(calls, ['escape'], 'the next Escape is the dialog\'s');
});

// ── Tab cycle and focus ─────────────────────────────────────────────────────────────────────

test('Tab walks the dialog, then the left menu, and wraps — never into the board', () => {
  reset();
  fill(OBJECTIVE);
  const order = ['mode-objective', 'btn-archive', 'chat-input', 'btn-chat-send'];
  const close = overlay().querySelector('.objective-modal-close');
  const [tasks, create] = document.querySelectorAll('#left-nav-panel button');
  close.focus();
  const visited = [];
  for (let i = 0; i < 8; i++) {
    const event = key(document.activeElement, 'Tab');
    assert.equal(event.defaultPrevented, true, 'the order is the dialog\'s, not the document\'s');
    visited.push(document.activeElement.id || document.activeElement.dataset.section || 'close');
  }
  assert.deepEqual(visited, [...order, 'tasks', 'new', 'close', 'mode-objective']);
  assert.equal(visited.includes('board-btn'), false);

  close.focus();
  key(close, 'Tab', { shiftKey: true });
  assert.equal(is(document.activeElement, create), true, 'Shift+Tab from the first control wraps to the last');
  key(create, 'Tab', { shiftKey: true });
  assert.equal(is(document.activeElement, tasks), true);

  document.getElementById('board-btn').focus();
  document.activeElement.blur?.();
  key(document.body, 'Tab');
  assert.equal(is(document.activeElement, close), true, 'with nothing focused, Tab enters the dialog');
});

test('disabled and hidden controls are skipped; a covered dialog leaves Tab alone', () => {
  reset();
  fill('<div class="chat-container"><button id="a">a</button><button id="b" disabled>b</button>'
    + '<button id="c" hidden>c</button><button id="d" tabindex="-1">d</button><button id="e">e</button></div>');
  document.getElementById('a').focus();
  key(document.activeElement, 'Tab');
  assert.equal(document.activeElement.id, 'e');

  reset({ covered: true });
  fill(OBJECTIVE);
  const input = document.getElementById('chat-input');
  input.focus();
  const event = key(input, 'Tab');
  assert.equal(event.defaultPrevented, false);
  assert.equal(is(document.activeElement, input), true);
});

test('focus goes to the composer or the New Task title, and comes back from the board', () => {
  reset();
  fill(OBJECTIVE);
  assert.equal(modal.focusObjectiveModal(), true);
  assert.equal(document.activeElement.id, 'chat-input');

  fill('<div class="objective-form"><button id="mode">Task</button><input id="new-task-title"></div>');
  modal.focusObjectiveModal();
  assert.equal(document.activeElement.id, 'new-task-title');

  fill('<div class="chat-container"><button id="mode">Objective</button><textarea id="chat-input" disabled></textarea></div>');
  modal.focusObjectiveModal();
  assert.equal(document.activeElement.id, 'mode', 'a locked composer (a turn is running) is skipped');

  // focus that lands on the board behind the backdrop returns to where it was in the dialog
  const board = document.getElementById('board-btn');
  board.focus();
  assert.equal(document.activeElement.id, 'mode');

  modal.closeObjectiveModal();
  assert.equal(modal.focusObjectiveModal(), false, 'nothing to focus while closed');
});

test('closing returns focus to what opened the dialog, else to the Create item', () => {
  reset();
  const opener = document.querySelector('[data-section="new"]');
  opener.focus();
  fill(OBJECTIVE);
  modal.focusObjectiveModal();
  modal.closeObjectiveModal();
  assert.equal(is(document.activeElement, opener), true);

  // opened from a control that is gone by the time it closes (an empty-board button)
  const temp = document.createElement('button');
  document.getElementById('app').appendChild(temp);
  temp.focus();
  fill(OBJECTIVE);
  modal.focusObjectiveModal();
  temp.remove();
  modal.closeObjectiveModal();
  assert.equal(is(document.activeElement, opener), true);

  // focus that had already moved elsewhere is not pulled back
  fill(OBJECTIVE);
  const tasks = document.querySelector('[data-section="tasks"]');
  tasks.focus();
  modal.closeObjectiveModal();
  assert.equal(is(document.activeElement, tasks), true);
});

// ── 2. template.html: closing the modal ─────────────────────────────────────────────────────

function templateFunction(name) {
  const match = templateSrc.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'));
  assert.ok(match, `${name} exists in template.html`);
  return match[0];
}

// closeCreateModal() and its helpers from source, over a fake page: one painted board, one cached
// snapshot, the modal open on `tab`.
function closeHarness({ tab = 'objective', boardTab = 'board', recording = false, pinned = false } = {}) {
  const calls = { renders: [], refreshes: [], closed: 0, nav: 0, bulk: 0, toasts: [], captured: 0, collapsed: 0, backdropClicks: 0 };
  const entry = { fingerprint: 'F1', storedAt: Date.now(), context: { project: 'p' } };
  const state = { activeTab: tab, boardTab, expandedCardMode: pinned ? 'pinned' : null };
  const context = vm.createContext({
    state, calls, Map,
    _paintedBoard: { tab: boardTab, key: 'K1' },
    _underlay: { fingerprint: 'F1', dirty: false },
    _boardTaskCache: new Map([['K1', entry]]),
    _currentKey: 'K1',
    _boardTaskFilterHash: () => context._currentKey,
    isNewSectionTab: (t = state.activeTab) => t === 'objective' || t === 'new_task',
    isTasksSectionTab: (t = state.activeTab) => ['board', 'list', 'todo', 'backlog'].includes(t),
    captureCardEdits: () => { calls.captured++; },
    collapseCard: () => { calls.collapsed++; },
    syncLeftNavFromState: () => { calls.nav++; },
    updateBulkActionBar: () => { calls.bulk++; },
    showToast: text => calls.toasts.push(text),
    t: key => key,
    loadAndRender: async options => { calls.renders.push(options); },
    refreshBoardSnapshotInBackground: (...args) => calls.refreshes.push(args),
    objectiveModal: { closeObjectiveModal: () => { calls.closed++; return true; }, isObjectiveModalOpen: () => true },
    window: { TipTask: { audioRecorder: { hasLiveFieldRecording: () => recording } } },
    document: { querySelector: selector => {
      if (selector === '.card-overlay-backdrop') return pinned ? { click: () => { calls.backdropClicks++; } } : null;
      if (selector === '#objective-modal .card-expanded') return pinned ? {} : null;
      return null;
    } },
  });
  vm.runInContext(['markBoardUnderlayDirty', 'boardUnderlayCurrent', 'closeCreateModal', 'dropCreateModalForBoardRender']
    .map(templateFunction).join('\n'), context);
  return { context, state, calls, entry };
}

test('closing with nothing changed goes back to the board without rendering or fetching it', () => {
  for (const tab of ['objective', 'new_task']) {
    const h = closeHarness({ tab, boardTab: 'backlog' });
    assert.equal(h.context.closeCreateModal('button'), true);
    assert.equal(h.state.activeTab, 'backlog', 'back on the Tasks view that was behind the modal');
    assert.equal(h.calls.closed, 1);
    assert.equal(h.calls.captured, 1, 'proposal card edits are read before the DOM goes');
    assert.equal(h.calls.nav, 1, 'left menu follows');
    assert.equal(h.calls.bulk, 1, 'the bulk bar comes back for the board');
    assert.deepEqual(h.calls.renders, [], `${tab}: no board render`);
    assert.deepEqual(h.calls.refreshes, [], `${tab}: no board fetch`);
    assert.equal(h.context._underlay, null);
  }
});

test('closing renders the board once when it changed behind the modal', () => {
  const cases = {
    'a task event patched the cached snapshot': h => { h.entry.fingerprint = 'F2'; },
    'a reload was asked for while it was open': h => { h.context.markBoardUnderlayDirty(); },
    'the fetch context moved (a drill-down was pushed)': h => { h.context._currentKey = 'K2'; },
    'the cached snapshot was dropped': h => { h.context._boardTaskCache.clear(); },
    'no board was ever painted': h => { h.context._paintedBoard = null; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const h = closeHarness();
    change(h);
    assert.equal(h.context.closeCreateModal('escape'), true, name);
    assert.equal(h.calls.renders.length, 1, name);
    assert.equal(h.calls.renders[0], undefined, `${name}: an in-place render, not a navigation`);
    assert.deepEqual(h.calls.refreshes, [], name);
  }
});

test('a snapshot only marked stale is re-read in the background, and rendered only if it differs', () => {
  const h = closeHarness();
  h.entry.storedAt = 0; // staleBoardTaskCache(): an aggregate event, no payload to merge
  h.context.closeCreateModal('backdrop');
  assert.deepEqual(h.calls.renders, []);
  assert.equal(h.calls.refreshes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.refreshes[0])), ['K1', 'F1', { project: 'p' }]);
});

test('markBoardUnderlayDirty() is a no-op while no modal is open', () => {
  const h = closeHarness();
  h.context._underlay = null;
  h.context.markBoardUnderlayDirty();
  assert.equal(h.context._underlay, null);
});

test('a live field recording keeps the modal open; a pinned card takes the first Escape', () => {
  const recording = closeHarness({ recording: true });
  assert.equal(recording.context.closeCreateModal('button'), false);
  assert.equal(recording.state.activeTab, 'objective');
  assert.equal(recording.calls.closed, 0);
  assert.deepEqual(recording.calls.toasts, ['chat.closeWhileRecording']);

  const pinned = closeHarness({ pinned: true });
  assert.equal(pinned.context.closeCreateModal('escape'), false);
  assert.equal(pinned.calls.backdropClicks, 1, 'collapsed the way a click on its backdrop does');
  assert.equal(pinned.calls.closed, 0);
  // any other gesture closes, collapsing the card first so its backdrop does not outlive it
  assert.equal(pinned.context.closeCreateModal('button'), true);
  assert.equal(pinned.calls.collapsed, 1);
  assert.equal(pinned.calls.closed, 1);
});

test('closeCreateModal() does nothing on a Tasks view; a board render drops a modal still up', () => {
  const h = closeHarness({ tab: 'board' });
  assert.equal(h.context.closeCreateModal('escape'), false);
  assert.equal(h.calls.closed, 0);

  h.context.dropCreateModalForBoardRender();
  assert.equal(h.calls.closed, 1);
  assert.equal(h.calls.captured, 1);
  assert.equal(h.context._underlay, null);
  assert.deepEqual(h.calls.renders, [], 'the render in flight is the board\'s own');
});

// ── 3. Wiring ───────────────────────────────────────────────────────────────────────────────

function extractFunctionBody(source, name) {
  const start = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start, `function ${name}() not found`);
  const nextRe = /^(?:export )?(?:async )?function \w+\(/gm;
  nextRe.lastIndex = start.index + start[0].length;
  const next = nextRe.exec(source);
  return source.slice(start.index, next ? next.index : source.length);
}

test('template.html: a Create render commits to the modal and leaves #app alone', () => {
  const impl = extractFunctionBody(templateSrc, '_loadAndRenderImpl');
  const root = impl.indexOf('const createModal = isNewSection ? objectiveModal.openObjectiveModal({ mode: state.activeTab }) : null;');
  const app = impl.indexOf("const app = createModal ? createModal.body : document.getElementById('app');");
  const createCommit = impl.indexOf('app.innerHTML = tabContent;');
  const boardCommit = impl.indexOf('app.innerHTML = `\n    <nav class="top-nav');
  assert.ok(root !== -1 && app > root, 'the render root is chosen once, after the last await');
  assert.ok(impl.lastIndexOf('_deferRenderForDrag(options)', root) !== -1, 'after the commit-time drag check');
  assert.ok(createCommit > app && boardCommit > createCommit, 'Create branch first, the board commit in its else');
  assert.match(impl.slice(createCommit - 200, boardCommit + 20), /if \(isNewSection\) \{[\s\S]*app\.innerHTML = tabContent;\s*\} else \{\s*app\.innerHTML = `/);
  // the board commit records what #app holds; nothing before the root choice names `app`
  assert.match(impl.slice(boardCommit), /_paintedBoard = \{ tab: state\.activeTab, key: cacheKey \};\s*state\.boardTab = state\.activeTab;/);
  assert.equal(/(?<![\w.#'"`-])app(?![\w-])\s*[.(]/.test(impl.slice(0, root).replace(/\/\/.*$/gm, '')), false, 'no use of app above its declaration');
  // the board's own scroll, filter pass and chain highlight are not touched by a Create render
  assert.match(impl, /if \(isNewSection\) \{[^}]*if \(wantTop\) app\.scrollTop = 0;\s*\} else if \(state\.activeTerminal\) \{/);
  assert.match(impl, /if \(!isNewSection\) applySearchFilter\(\);/);
  assert.match(impl, /if \(state\.chainHighlightedTaskId && !isNewSection\) \{/);
  assert.match(impl, /if \(createModal\?\.opened\) objectiveModal\.focusObjectiveModal\(\);/);
  // the inline-edit delegates bind once per root, so the modal's body gets them too
  assert.match(impl, /if \(!_delegateRoots\.has\(app\)\) \{\s*_delegateRoots\.add\(app\);/);
});

test('template.html: loadAndRender() paints a board before the first Create render and drops a stale modal', () => {
  const load = extractFunctionBody(templateSrc, 'loadAndRender');
  assert.match(load, /if \(isNewSectionTab\(\)\) \{\s*if \(!_paintedBoard && !\(await paintBoardBehindCreate\(options\)\)\) return;\s*\} else \{\s*dropCreateModalForBoardRender\(\);\s*\}/);
  assert.ok(load.indexOf('_deferRenderForDrag(options)') < load.indexOf('paintBoardBehindCreate(options)'));
  assert.ok(load.indexOf('paintBoardBehindCreate(options)') < load.indexOf('invalidateLoadAndRender()'));
  const paint = extractFunctionBody(templateSrc, 'paintBoardBehindCreate');
  assert.match(paint, /state\.activeTab = isTasksSectionTab\(state\.boardTab\) \? state\.boardTab : 'board';/);
  assert.match(paint, /finally \{[\s\S]*if \(isTasksSectionTab\(\)\) state\.activeTab = createTab;/);
  // a project switch repaints the board under an open modal
  assert.match(templateSrc, /clearBoardTaskCache\(\);[\s\S]{0,260}_paintedBoard = null;/);
});

test('template.html: the left menu opens, refocuses and closes the modal; Create shows a background turn', () => {
  const nav = extractFunctionBody(templateSrc, 'syncLeftNavPanel');
  assert.match(nav, /if \(section === 'tasks'\) \{[\s\S]{0,400}if \(isNewSectionTab\(\)\) \{\s*closeCreateModal\(\);/);
  // (TPT9390) Create opens through its flyout: a pick of the mode already showing refocuses the
  // modal instead of rendering it again (create-flyout.test.js runs openCreateMode()).
  assert.match(nav, /createFlyout\.mountCreateFlyout\(\{\s*trigger: panel\.querySelector\('\[data-section="new"\]'\),\s*onSelect: openCreateMode,/);
  assert.match(extractFunctionBody(templateSrc, 'openCreateMode'),
    /if \(alreadyShown\) \{\s*syncLeftNavFromState\(\);\s*objectiveModal\.focusObjectiveModal\(\);/);
  assert.match(nav, /newBtn\.classList\.toggle\('running', isStreaming && inBackground\);/);
  assert.match(nav, /isStreaming \? t\('nav\.createRunning'\) : isReady \? t\('nav\.createReady'\) : ''/);
  assert.match(templateSrc, /objectiveModal\.configureObjectiveModal\(\{\s*onRequestClose: closeCreateModal,/);
  // the two strings exist in every locale (i18n.test.js checks parity with en)
  for (const key of ['nav.createRunning', 'nav.createReady', 'chat.closeWhileRecording']) {
    assert.equal(read('i18n.js').split(key).length - 1, 4, `${key} in en, uk, zh and es`);
  }
});

test('reload routing: chat repaints stay in the modal, everything else marks the board', () => {
  for (const [file, src] of [['chat-ui.js', chatUiSrc], ['chat-task-preview.js', read('chat-task-preview.js')]]) {
    assert.match(extractFunctionBody(src, 'reload'),
      /if \(typeof window !== 'undefined' && window\.TipTask\?\.repaintCreateModal\?\.\(\)\) return;\s*document\.dispatchEvent\(new Event\('tiptask:reload'\)\);/, file);
  }
  const repaint = templateSrc.slice(templateSrc.indexOf('window.TipTask.repaintCreateModal = '));
  assert.match(repaint.slice(0, 260), /if \(!isNewSectionTab\(\)\) return false;\s*staleBoardTaskCache\(\);\s*loadAndRender\(\{ forceFresh: true \}\)/);
  assert.equal(repaint.slice(0, 260).includes('markBoardUnderlayDirty'), false, 'a chat repaint is not a board change');
  const listener = templateSrc.slice(templateSrc.indexOf("document.addEventListener('tiptask:reload'"));
  assert.match(listener.slice(0, 1400), /staleBoardTaskCache\(\);\s*markBoardUnderlayDirty\(\);\s*loadAndRender\(\{ forceFresh: true \}\)/);
});

test('chat-ui.js: the Objective view is looked up in the modal, never in the page', () => {
  assert.match(extractFunctionBody(chatUiSrc, 'refreshObjectiveContent'),
    /const current = document\.querySelector\('\.objective-modal \.chat-container'\);/);
  assert.equal(/querySelector\('\.content-area/.test(chatUiSrc), false);
  assert.equal(chatUiSrc.includes("closest('.content-area')"), false);
  // proposals that land out of sight raise the ready tick again; a tab brought on screen is seen
  assert.match(extractFunctionBody(chatUiSrc, 'notifyObjectiveCardsReady'),
    /readyTab\.chatState\.tickSeen = state\.activeTab === 'objective' && state\.activeTabId === tabId;/);
  assert.match(extractFunctionBody(chatUiSrc, 'switchTab'), /if \(state\.chatState\) state\.chatState\.tickSeen = true;/);
});

test('task-card.js: a card pinned inside the modal puts its backdrop there and takes no scroll lock', () => {
  const src = read('task-card.js');
  assert.match(extractFunctionBody(src, 'overlayHost'), /return card\.closest\('\.objective-modal'\) \|\| document\.body;/);
  assert.equal((src.match(/overlayHost\(card\)\.appendChild\(backdrop\);/g) || []).length, 2, 'both pin paths');
  assert.equal(src.includes('document.body.appendChild(backdrop)'), false);
  assert.equal((src.match(/overlayHost\(card\) === document\.body\) lockBodyScroll\(\);/g) || []).length, 2);
});

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`^ *${escaped} \\{([^}]*)\\}`, 'm'));
  assert.ok(match, `${selector} { … } not found in styles.css`);
  return match[1];
}

test('styles.css: one fixed-size panel beside the left menu, in theme tokens only', () => {
  const overlayRule = rule('.objective-modal');
  const panelRule = rule('.objective-modal-panel');
  assert.match(overlayRule, /position: fixed;/);
  assert.match(overlayRule, /inset: 0 0 0 200px;/, 'starts at the left menu\'s edge');
  assert.match(css, /body\.left-nav-collapsed \.objective-modal \{ left: 56px; \}/);
  assert.match(overlayRule, /z-index: 1500;/, 'above the board, below the terminal overlay and the dialogs');
  assert.match(panelRule, /width: min\(1040px, 100%\);/);
  assert.match(panelRule, /height: min\(880px, 100%\);/, 'sized by the window, never by its content');
  assert.equal(/max-height|min-height|fit-content|auto;/.test(panelRule.replace(/\/\*[\s\S]*?\*\//g, '')), false);
  // an expanded proposal card is position:fixed inside: nothing here may become its containing block
  for (const [name, body] of [['overlay', overlayRule], ['panel', panelRule]]) {
    assert.equal(/(?:^|\s)(?:transform|filter|backdrop-filter|will-change|contain|perspective)\s*:/.test(body), false, name);
  }
  // colours come from the palette, so every theme gets them
  assert.match(panelRule, /background: var\(--c-bg\);/);
  assert.match(panelRule, /border: 1px solid var\(--objective-modal-edge\);/);
  assert.match(panelRule, /--objective-modal-edge: color-mix\(in srgb, var\(--c-text\) 14%, transparent\);/);
  const shell = css.slice(css.indexOf('/* ── Create modal (TPT9389) ──'), css.indexOf('/* ── Chat UI ── */'));
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(shell.replace(/\/\*[\s\S]*?\*\//g, '')), false, 'no hard-coded hex colours');
  // the page behind is held still, keeping its scrollbar track where that takes room
  assert.match(css, /html\.objective-modal-open \{\s*overflow-y: hidden;\s*\}/);
  assert.match(css, /html\.objective-modal-open--gutter \{\s*scrollbar-gutter: stable;\s*\}/);
  assert.match(rule('.objective-modal-body'), /overscroll-behavior: contain;/);
});

test('styles.css: narrow windows get the whole width; the Create views take their size from the modal', () => {
  const shell = css.slice(css.indexOf('/* ── Create modal (TPT9389) ──'), css.indexOf('/* ── Chat UI ── */'));
  assert.match(shell, /@media \(max-width: 768px\) \{\s*\.objective-modal \{\s*left: 56px;\s*padding: 8px;/);
  assert.match(shell, /@media \(max-width: 480px\) \{\s*\.objective-modal \{ padding: 0; \}\s*\.objective-modal-panel \{\s*border-radius: 0;/);
  assert.match(shell, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation: none;/);
  // no viewport math left in the views: the chat fills the modal's body, the form scrolls in it
  assert.match(css, /\.objective-chat--empty,\s*\.objective-chat--active \{\s*height: 100%;\s*min-height: 0;\s*\}/);
  const form = rule('.objective-form');
  assert.match(form, /min-height: 100%;/);
  for (const [name, body] of [['.objective-form', form], ['.chat-container', rule('.chat-container')]]) {
    assert.equal(/100d?vh|max-width|--chat-tab-count/.test(body.replace(/\/\*[\s\S]*?\*\//g, '')), false, name);
  }
  assert.equal(css.includes('--chat-chrome-above'), false);
  assert.equal(css.includes('.top-nav--bare'), false, 'the page-era bare top nav is gone with the Create page');
  assert.equal(templateSrc.includes('top-nav--bare'), false);
  // the left menu's running mark
  assert.match(css, /\.left-nav-btn--primary\.running \.left-nav-icon::before \{[^}]*background: var\(--c-primary-border\);/);
});
