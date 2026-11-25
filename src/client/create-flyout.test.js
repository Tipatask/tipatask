import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';

// (TPT9390) The Create flyout: the left menu's Create item opens a menu to its right with New
// Objective and New Task, and a pick opens the Create modal in that mode. The Objective / Task
// tabs that used to sit at the top of the modal are gone. Four layers are covered here —
//   1. create-flyout.js, the menu, for real in happy-dom (roles, the three ways it opens, the
//      keys, a pick, every way it closes, who owns an Escape next to the Create modal);
//   2. composer-header.js: the modal's header names the mode and holds no switch;
//   3. template.html's openCreateMode() / leaveTaskSurfacesForNav(), run from source in a vm:
//      each entry opens the right mode;
//   4. what cannot run under node (template.html's mounting, styles.css's placement and
//      palette use, the locale tables), as source scans and palette arithmetic.

const window = new Window({ url: 'http://127.0.0.1:4455/todo.html' });
for (const [key, value] of Object.entries({
  window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
  Node: window.Node, Event: window.Event, CustomEvent: window.CustomEvent,
  KeyboardEvent: window.KeyboardEvent, MouseEvent: window.MouseEvent,
  MutationObserver: window.MutationObserver, getComputedStyle: window.getComputedStyle.bind(window),
})) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });

const flyout = await import('./create-flyout.js');
const { CREATE_MODES, createMode } = await import('./create-modes.js');
const modal = await import('./objective-modal.js');
const i18n = await import('./i18n.js');
const dialogFocus = await import('./dialog-focus.js');
const { renderComposerHeader } = await import('./composer-header.js');
const state = (await import('./state.js')).default;

const read = name => readFileSync(new URL('./' + name, import.meta.url), 'utf8');
const templateSrc = read('template.html');
const css = read('styles.css');
const boardSrc = read('task-board.js');

// happy-dom lays nothing out: every element gets one client rect unless it is hidden, which is
// all objective-modal.js asks ("is it displayed").
window.HTMLElement.prototype.getClientRects = function getClientRects() {
  return this.closest('[hidden]') ? [] : [{ width: 10, height: 10 }];
};

const host = () => document.getElementById('create-flyout');
const menu = () => host().querySelector('.create-flyout-menu');
const entries = () => [...host().querySelectorAll('.create-flyout-item')];
const entry = mode => host().querySelector(`.create-flyout-item[data-mode="${mode}"]`);
const trigger = () => document.querySelector('#left-nav-panel [data-section="new"]');
const is = (a, b) => a === b; // node identity as a boolean (assert.equal on nodes inspects them)
const focused = () => document.activeElement?.dataset.mode || document.activeElement?.dataset.section
  || document.activeElement?.dataset.action || document.activeElement?.id || 'body';

function key(target, name, init = {}) {
  const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

// A pointer click carries detail 1; Enter and Space arrive as a click with detail 0, which is
// what element.click() dispatches too.
function mouseClick(target) {
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
  target.dispatchEvent(event);
  return event;
}

const pointer = (target, type, init = {}) => target.dispatchEvent(new window.MouseEvent(type, init));
const press = target => target.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));

function reset() {
  flyout.closeCreateFlyout();
  modal.closeObjectiveModal({ restoreFocus: false });
  i18n.setLocale('en');
  for (const el of [...document.body.children]) {
    if (el.id !== 'create-flyout' && el.id !== 'objective-modal') el.remove();
  }
  document.body.insertAdjacentHTML('afterbegin',
    '<div id="app"><button id="board-btn">board card</button></div>'
    + '<div id="left-nav-panel"><button data-section="tasks">Tasks</button>'
    + '<button data-section="new">Create</button><button data-action="start-chat">Start Chat</button></div>');
  const picks = [];
  flyout.mountCreateFlyout({ trigger: trigger(), onSelect: mode => picks.push(mode) });
  return picks;
}

// ── 1. The menu ─────────────────────────────────────────────────────────────────────────────

test('mounting builds one body-level menu and makes the Create item its button', () => {
  reset();
  assert.equal(is(host().parentElement, document.body), true, 'a child of <body>: the left menu clips its content');
  assert.equal(host().hidden, true);
  assert.equal(flyout.isCreateFlyoutOpen(), false);
  assert.equal(menu().getAttribute('role'), 'menu');
  assert.equal(menu().getAttribute('aria-label'), 'Create');
  assert.equal(menu().getAttribute('aria-orientation'), 'vertical');

  assert.deepEqual(entries().map(el => el.dataset.mode), ['objective', 'new_task']);
  const expected = { objective: ['New Objective', 'Describe a goal — AI plans the tasks'], new_task: ['New Task', 'Create a task yourself'] };
  for (const el of entries()) {
    assert.equal(el.tagName, 'BUTTON');
    assert.equal(el.getAttribute('type'), 'button');
    assert.equal(el.getAttribute('role'), 'menuitem');
    assert.equal(el.getAttribute('tabindex'), '-1', 'reached with the arrow keys, never with Tab');
    // named by its label alone, described by its hint
    const label = document.getElementById(el.getAttribute('aria-labelledby'));
    const hint = document.getElementById(el.getAttribute('aria-describedby'));
    assert.equal(el.contains(label) && el.contains(hint), true);
    assert.deepEqual([label.textContent, hint.textContent], expected[el.dataset.mode]);
    assert.equal(label.classList.contains('create-flyout-label') && hint.classList.contains('create-flyout-hint'), true);
    assert.equal(el.querySelector('.create-flyout-icon svg') !== null, true);
    assert.equal(el.querySelector('.create-flyout-status').hidden, true, 'no status while nothing is planned');
  }

  assert.equal(trigger().getAttribute('aria-haspopup'), 'menu');
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  assert.equal(trigger().getAttribute('aria-controls'), menu().id);

  flyout.mountCreateFlyout({ trigger: trigger(), onSelect: () => {} });
  assert.equal(document.querySelectorAll('#create-flyout').length, 1, 'never a second menu');
  assert.equal(flyout.mountCreateFlyout({}), null, 'nothing to mount on');
});

test('a mouse click opens and closes it; the keyboard goes in only when the keyboard opened it', () => {
  reset();
  trigger().focus();
  mouseClick(trigger());
  assert.equal(flyout.isCreateFlyoutOpen(), true);
  assert.equal(host().hidden, false);
  assert.equal(trigger().getAttribute('aria-expanded'), 'true');
  assert.equal(focused(), 'new', 'a pointer click leaves focus on the Create item');
  mouseClick(trigger());
  assert.equal(flyout.isCreateFlyoutOpen(), false);
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');

  trigger().click(); // Enter / Space
  assert.equal(flyout.isCreateFlyoutOpen(), true);
  assert.equal(focused(), 'objective', 'the keyboard lands on the first entry');
  trigger().click();
  assert.equal(flyout.isCreateFlyoutOpen(), false);
  assert.equal(focused(), 'new', 'and comes back to the Create item when the menu closes');
});

test('hovering opens it after a pause, and leaving closes it after a grace period', (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pointer(trigger(), 'mouseenter');
  assert.equal(flyout.isCreateFlyoutOpen(), false, 'not at once');
  t.mock.timers.tick(flyout.HOVER_OPEN_MS - 1);
  assert.equal(flyout.isCreateFlyoutOpen(), false);
  t.mock.timers.tick(1);
  assert.equal(flyout.isCreateFlyoutOpen(), true);
  assert.equal(trigger().getAttribute('aria-expanded'), 'true');
  assert.equal(host().contains(document.activeElement), false, 'hover never moves the keyboard');

  // across to the menu: leaving the item starts the grace period, entering the menu ends it
  pointer(trigger(), 'mouseleave');
  t.mock.timers.tick(flyout.HOVER_CLOSE_MS - 1);
  assert.equal(flyout.isCreateFlyoutOpen(), true);
  pointer(host(), 'mouseenter');
  t.mock.timers.tick(flyout.HOVER_CLOSE_MS * 2);
  assert.equal(flyout.isCreateFlyoutOpen(), true, 'the pointer is in the menu');

  // and back to the item
  pointer(host(), 'mouseleave');
  pointer(trigger(), 'mouseenter');
  t.mock.timers.tick(flyout.HOVER_CLOSE_MS * 2);
  assert.equal(flyout.isCreateFlyoutOpen(), true);

  pointer(trigger(), 'mouseleave');
  t.mock.timers.tick(flyout.HOVER_CLOSE_MS - 1);
  assert.equal(flyout.isCreateFlyoutOpen(), true);
  t.mock.timers.tick(1);
  assert.equal(flyout.isCreateFlyoutOpen(), false, 'left for good');
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
});

test('a pointer that only crosses the item, or drags over it, opens nothing', (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pointer(trigger(), 'mouseenter');
  t.mock.timers.tick(flyout.HOVER_OPEN_MS - 10);
  pointer(trigger(), 'mouseleave');
  t.mock.timers.tick(flyout.HOVER_OPEN_MS * 3);
  assert.equal(flyout.isCreateFlyoutOpen(), false, 'gone before the pause ended');

  pointer(trigger(), 'mouseenter', { buttons: 1 }); // a card being dragged across the menu
  t.mock.timers.tick(flyout.HOVER_OPEN_MS * 3);
  assert.equal(flyout.isCreateFlyoutOpen(), false);
});

test('a click on a menu that hover opened keeps it open; the next click closes it', (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pointer(trigger(), 'mouseenter');
  t.mock.timers.tick(flyout.HOVER_OPEN_MS);
  assert.equal(flyout.isCreateFlyoutOpen(), true);
  mouseClick(trigger());
  assert.equal(flyout.isCreateFlyoutOpen(), true, 'the click does not undo what the hover did');
  pointer(trigger(), 'mouseleave');
  t.mock.timers.tick(flyout.HOVER_CLOSE_MS * 3);
  assert.equal(flyout.isCreateFlyoutOpen(), true, 'and it now stays without the pointer');
  mouseClick(trigger());
  assert.equal(flyout.isCreateFlyoutOpen(), false);

  // a click that lands before the hover pause ended opens it once, not twice
  pointer(trigger(), 'mouseenter');
  mouseClick(trigger());
  assert.equal(flyout.isCreateFlyoutOpen(), true);
  t.mock.timers.tick(flyout.HOVER_OPEN_MS * 3);
  assert.equal(flyout.isCreateFlyoutOpen(), true);
  pointer(trigger(), 'mouseleave');
  t.mock.timers.tick(flyout.HOVER_CLOSE_MS * 3);
  assert.equal(flyout.isCreateFlyoutOpen(), true, 'opened by the click, so it is not a hover menu');

  // Enter on a hover-opened menu takes the keyboard into it
  flyout.closeCreateFlyout();
  pointer(trigger(), 'mouseenter');
  t.mock.timers.tick(flyout.HOVER_OPEN_MS);
  trigger().click();
  assert.equal(flyout.isCreateFlyoutOpen(), true);
  assert.equal(focused(), 'objective');
});

test('arrow keys on the Create item open the menu: Right and Down on the first entry, Up on the last', () => {
  for (const [name, landsOn] of [['ArrowRight', 'objective'], ['ArrowDown', 'objective'], ['ArrowUp', 'new_task']]) {
    reset();
    trigger().focus();
    const event = key(trigger(), name);
    assert.equal(flyout.isCreateFlyoutOpen(), true, name);
    assert.equal(event.defaultPrevented, true, name);
    assert.equal(focused(), landsOn, name);
  }
  reset();
  trigger().focus();
  for (const init of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    key(trigger(), 'ArrowRight', init);
    assert.equal(flyout.isCreateFlyoutOpen(), false, 'a modified arrow is some other shortcut');
  }
  key(trigger(), 'ArrowLeft');
  key(trigger(), 'a');
  assert.equal(flyout.isCreateFlyoutOpen(), false);
});

test('arrow keys walk the entries and wrap; Home and End jump', () => {
  reset();
  trigger().focus();
  key(trigger(), 'ArrowRight');
  const walk = [];
  for (const name of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp']) {
    const event = key(document.activeElement, name);
    assert.equal(event.defaultPrevented, true, `${name} never scrolls the page`);
    walk.push(focused());
  }
  assert.deepEqual(walk, ['new_task', 'objective', 'new_task', 'objective', 'new_task', 'objective', 'new_task', 'objective']);
  assert.equal(flyout.isCreateFlyoutOpen(), true);
});

test('Left closes the menu back onto the Create item; Tab closes it and lets the browser move on', () => {
  reset();
  trigger().focus();
  key(trigger(), 'ArrowRight');
  const left = key(document.activeElement, 'ArrowLeft');
  assert.equal(flyout.isCreateFlyoutOpen(), false);
  assert.equal(left.defaultPrevented, true);
  assert.equal(focused(), 'new');

  key(trigger(), 'ArrowRight');
  const tab = key(document.activeElement, 'Tab');
  assert.equal(flyout.isCreateFlyoutOpen(), false);
  assert.equal(focused(), 'new', 'focus is on the Create item when the default Tab runs');
  assert.equal(tab.defaultPrevented, false, 'so Tab goes to what follows it in the left menu');
});

test('Escape closes the menu from an entry and from the Create item, and nothing else hears it', () => {
  reset();
  const heard = [];
  const listener = event => { if (event.key === 'Escape') heard.push(event.target.dataset.mode || event.target.dataset.section); };
  document.addEventListener('keydown', listener, true);
  document.addEventListener('keydown', listener);
  try {
    trigger().focus();
    key(trigger(), 'ArrowRight');
    let event = key(document.activeElement, 'Escape');
    assert.equal(flyout.isCreateFlyoutOpen(), false);
    assert.equal(event.defaultPrevented, true);
    assert.equal(focused(), 'new');

    mouseClick(trigger()); // open, focus still on the Create item
    event = key(trigger(), 'Escape');
    assert.equal(flyout.isCreateFlyoutOpen(), false);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(heard, [], 'taken in the window\'s capture phase, ahead of every other listener');

    // with the menu closed, Escape is nobody's business here
    event = key(trigger(), 'Escape');
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(heard, ['new', 'new']);
  } finally {
    document.removeEventListener('keydown', listener, true);
    document.removeEventListener('keydown', listener);
  }
});

test('a pick closes the menu, returns focus to the Create item and reports the mode', () => {
  const picks = reset();
  trigger().focus();
  key(trigger(), 'ArrowRight');
  let seen = null;
  flyout.mountCreateFlyout({
    trigger: trigger(),
    onSelect: (mode) => { seen = { mode, open: flyout.isCreateFlyoutOpen(), focus: focused() }; picks.push(mode); },
  });
  document.activeElement.click(); // Enter on New Objective
  assert.deepEqual(seen, { mode: 'objective', open: false, focus: 'new' },
    'closed and refocused before the page acts, so the Create modal returns focus to the item');
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');

  mouseClick(trigger());
  mouseClick(entry('new_task').querySelector('.create-flyout-hint')); // a click on the text inside
  assert.deepEqual(picks, ['objective', 'new_task']);
  assert.equal(flyout.isCreateFlyoutOpen(), false);

  mouseClick(trigger());
  mouseClick(menu()); // the card's padding, between entries
  assert.deepEqual(picks, ['objective', 'new_task'], 'not a pick');
  assert.equal(flyout.isCreateFlyoutOpen(), true);
});

test('with the keyboard in the menu, the entry under the pointer takes focus too', () => {
  reset();
  mouseClick(trigger());
  entry('new_task').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(host().contains(document.activeElement), false, 'a pointer menu leaves focus where it is');

  flyout.closeCreateFlyout();
  trigger().focus();
  key(trigger(), 'ArrowRight');
  assert.equal(focused(), 'objective');
  entry('new_task').querySelector('.create-flyout-label').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(focused(), 'new_task', 'one highlighted entry, not two');
});

test('a press anywhere else closes it; a press on the menu or the Create item does not', () => {
  reset();
  mouseClick(trigger());
  press(entry('objective'));
  press(trigger());
  press(host());
  assert.equal(flyout.isCreateFlyoutOpen(), true);
  press(document.getElementById('board-btn'));
  assert.equal(flyout.isCreateFlyoutOpen(), false);

  mouseClick(trigger());
  press(document.querySelector('[data-section="tasks"]'));
  assert.equal(flyout.isCreateFlyoutOpen(), false, 'the rest of the left menu is "anywhere else"');

  // focus that was in the menu is not left on a hidden entry
  trigger().focus();
  key(trigger(), 'ArrowRight');
  press(document.body);
  assert.equal(flyout.isCreateFlyoutOpen(), false);
  assert.equal(focused(), 'new');
});

test('focus moving elsewhere closes a menu that was clicked or keyed open, not one under the pointer', (t) => {
  reset();
  trigger().focus();
  mouseClick(trigger());
  document.querySelector('[data-action="start-chat"]').focus(); // Tab from the Create item
  assert.equal(flyout.isCreateFlyoutOpen(), false);

  key(trigger(), 'ArrowRight');
  entry('new_task').focus();
  trigger().focus();
  assert.equal(flyout.isCreateFlyoutOpen(), true, 'between the menu and its button is not "elsewhere"');
  document.getElementById('board-btn').focus();
  assert.equal(flyout.isCreateFlyoutOpen(), false);

  // a hover menu follows the pointer: a chat repaint refocusing its composer does not take it away
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pointer(trigger(), 'mouseenter');
  t.mock.timers.tick(flyout.HOVER_OPEN_MS);
  document.getElementById('board-btn').focus();
  document.querySelector('[data-section="tasks"]').focus();
  assert.equal(flyout.isCreateFlyoutOpen(), true);
});

test('a resized or backgrounded window, and a dialog opening over the page, close it', (t) => {
  reset();
  for (const type of ['resize', 'blur']) {
    mouseClick(trigger());
    window.dispatchEvent(new window.Event(type));
    assert.equal(flyout.isCreateFlyoutOpen(), false, type);
  }

  // a dialog-focus layer makes the rest of the page inert: even a hover menu goes
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pointer(trigger(), 'mouseenter');
  t.mock.timers.tick(flyout.HOVER_OPEN_MS);
  assert.equal(flyout.isCreateFlyoutOpen(), true);
  document.body.insertAdjacentHTML('beforeend', '<div id="layer"><button id="layer-btn">ok</button></div>');
  const layer = dialogFocus.activateDialogFocus({ root: document.getElementById('layer') });
  try {
    assert.equal(focused(), 'layer-btn');
    assert.equal(flyout.isCreateFlyoutOpen(), false);
    assert.equal(flyout.openCreateFlyout({ via: 'click' }), false, 'and it does not open behind a dialog');
    assert.equal(flyout.isCreateFlyoutOpen(), false);
  } finally {
    layer.close();
  }
  assert.equal(flyout.openCreateFlyout({ via: 'click' }), true);
});

// ── Next to the Create modal ────────────────────────────────────────────────────────────────

test('with the Create modal open, Escape in the menu closes the menu and leaves the modal alone', (t) => {
  reset();
  const closes = [];
  modal.configureObjectiveModal({ onRequestClose: reason => closes.push(reason), isCovered: () => false });
  const { body } = modal.openObjectiveModal({ mode: 'objective' });
  body.innerHTML = '<div class="chat-container"><textarea id="chat-input"></textarea></div>';
  try {
    trigger().focus();
    key(trigger(), 'ArrowRight');
    key(document.activeElement, 'Escape');
    assert.equal(flyout.isCreateFlyoutOpen(), false);
    assert.deepEqual(closes, [], 'one Escape, one thing closed');
    assert.equal(modal.isObjectiveModalOpen(), true);

    mouseClick(trigger());
    key(trigger(), 'Escape');
    assert.equal(flyout.isCreateFlyoutOpen(), false);
    assert.deepEqual(closes, []);

    key(trigger(), 'Escape');
    assert.deepEqual(closes, ['escape'], 'with the menu closed, the next Escape is the modal\'s');

    // a hover menu does not take an Escape typed in the composer: that one is the modal's
    closes.length = 0;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    pointer(trigger(), 'mouseenter');
    t.mock.timers.tick(flyout.HOVER_OPEN_MS);
    const input = document.getElementById('chat-input');
    input.focus();
    assert.equal(flyout.isCreateFlyoutOpen(), true);
    key(input, 'Escape');
    assert.deepEqual(closes, ['escape']);

    // Tab in the menu is the menu's: the modal's Tab cycle stands down for that one press
    flyout.closeCreateFlyout();
    trigger().focus();
    key(trigger(), 'ArrowRight');
    const tab = key(document.activeElement, 'Tab');
    assert.equal(tab.defaultPrevented, false);
    assert.equal(focused(), 'new');
    // the entries are no part of the modal's own cycle
    const visited = new Set();
    for (let i = 0; i < 12; i++) { key(document.activeElement, 'Tab'); visited.add(focused()); }
    assert.equal(visited.has('objective') || visited.has('new_task'), false);
  } finally {
    modal.configureObjectiveModal({});
    modal.closeObjectiveModal({ restoreFocus: false });
  }
});

test('the Create modal is named after the entry that opened it', () => {
  reset();
  const panel = () => document.querySelector('#objective-modal .objective-modal-panel');
  try {
    for (const { mode, labelKey } of CREATE_MODES) {
      modal.openObjectiveModal({ mode });
      assert.equal(panel().getAttribute('aria-label'), i18n.t(labelKey));
      assert.equal(panel().getAttribute('aria-label'), entry(mode).querySelector('.create-flyout-label').textContent);
      assert.equal(panel().dataset.mode, mode);
    }
  } finally {
    modal.closeObjectiveModal({ restoreFocus: false });
  }
});

// ── What the menu shows ─────────────────────────────────────────────────────────────────────

test('the entry for the mode the modal is showing is marked current', () => {
  reset();
  const current = () => entries().filter(el => el.getAttribute('aria-current') === 'true').map(el => el.dataset.mode);
  assert.deepEqual(current(), []);
  flyout.syncCreateFlyout({ current: 'objective' });
  assert.deepEqual(current(), ['objective']);
  assert.equal(entry('objective').classList.contains('is-current'), true);
  flyout.syncCreateFlyout({ current: 'new_task' });
  assert.deepEqual(current(), ['new_task']);
  assert.equal(entry('objective').classList.contains('is-current'), false);
  assert.equal(entry('objective').hasAttribute('aria-current'), false);
  flyout.syncCreateFlyout({ current: null });
  assert.deepEqual(current(), [], 'the modal is closed');
  flyout.syncCreateFlyout({ current: 'board' });
  assert.deepEqual(current(), [], 'a Tasks view is no Create mode');
});

test('New Objective says when a plan is running or waiting to be read', () => {
  reset();
  const status = mode => entry(mode).querySelector('.create-flyout-status');
  const describedBy = mode => entry(mode).getAttribute('aria-describedby').split(' ')
    .map(id => document.getElementById(id).textContent).join(' | ');

  flyout.syncCreateFlyout({ running: true });
  assert.equal(status('objective').hidden, false);
  assert.equal(status('objective').dataset.state, 'running');
  assert.equal(status('objective').querySelector('.create-flyout-status-text').textContent, 'Planning…');
  assert.equal(describedBy('objective'), 'Describe a goal — AI plans the tasks | Planning…');
  assert.equal(status('new_task').hidden, true, 'a plan is an objective\'s');
  assert.equal(describedBy('new_task'), 'Create a task yourself');

  flyout.syncCreateFlyout({ ready: true });
  assert.equal(status('objective').dataset.state, 'ready');
  assert.equal(describedBy('objective'), 'Describe a goal — AI plans the tasks | Ready to review');

  flyout.syncCreateFlyout({ running: true, ready: true });
  assert.equal(status('objective').dataset.state, 'running', 'a running turn comes first');

  flyout.syncCreateFlyout({});
  assert.equal(status('objective').hidden, true);
  assert.equal(status('objective').dataset.state, undefined);
  assert.equal(status('objective').querySelector('.create-flyout-status-text').textContent, '');
  assert.equal(describedBy('objective'), 'Describe a goal — AI plans the tasks');
});

test('syncing the same state again writes nothing to the DOM', async () => {
  reset();
  mouseClick(trigger());
  flyout.syncCreateFlyout({ current: 'objective', running: true });
  const records = [];
  const observer = new window.MutationObserver(list => records.push(...list));
  observer.observe(host(), { subtree: true, attributes: true, childList: true, characterData: true });
  try {
    // the page syncs on every render and on every objective status event while a turn streams
    for (let i = 0; i < 5; i++) flyout.syncCreateFlyout({ current: 'objective', running: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(records.map(r => `${r.type}:${r.attributeName || ''}`), []);
    flyout.syncCreateFlyout({ current: 'objective', ready: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(records.length > 0, true, 'a real change is written');
  } finally {
    observer.disconnect();
  }
});

test('the menu follows the project language', () => {
  reset();
  flyout.syncCreateFlyout({ ready: true });
  const texts = () => [menu().getAttribute('aria-label'), ...entries().flatMap(el => [
    el.querySelector('.create-flyout-label').textContent, el.querySelector('.create-flyout-hint').textContent,
  ]), entry('objective').querySelector('.create-flyout-status-text').textContent];
  const en = texts();
  for (const locale of ['uk', 'zh', 'es']) {
    i18n.setLocale(locale);
    flyout.syncCreateFlyout({ ready: true });
    const now = texts();
    assert.deepEqual(now, [i18n.t('nav.create'), i18n.t('nav.newObjective'), i18n.t('nav.objectiveSub'),
      i18n.t('nav.newTask'), i18n.t('nav.taskSub'), i18n.t('nav.createFlyoutReady')], locale);
    now.forEach((text, index) => assert.notEqual(text, en[index], `${locale}: "${text}" is translated`));
  }
  i18n.setLocale('en');
});

test('every string the flyout and the modal heading use exists in en, uk, zh and es', () => {
  const keys = ['nav.create', 'nav.createFlyoutPlanning', 'nav.createFlyoutReady',
    ...CREATE_MODES.flatMap(mode => [mode.labelKey, mode.hintKey])];
  assert.equal(new Set(keys).size, 7);
  for (const locale of ['en', 'uk', 'zh', 'es']) {
    for (const name of keys) {
      const text = i18n.LOCALES[locale][name];
      assert.equal(typeof text === 'string' && text.trim().length > 0, true, `${locale} lacks ${name}`);
      if (locale !== 'en') assert.notEqual(text, i18n.LOCALES.en[name], `${locale} ${name} is still English`);
    }
  }
});

// ── Where it sits ───────────────────────────────────────────────────────────────────────────

test('createFlyoutTop() keeps the menu level with the Create item and inside the window', () => {
  const top = flyout.createFlyoutTop;
  assert.equal(top({ anchorTop: 46, menuHeight: 132, viewportHeight: 900 }), 40, 'the first entry lines up with the item');
  assert.equal(top({ anchorTop: 700, menuHeight: 132, viewportHeight: 760 }), 620, 'pulled up: its foot stays 8px inside');
  assert.equal(top({ anchorTop: 46, menuHeight: 132, viewportHeight: 120 }), 8, 'a window shorter than the menu: from the top');
  assert.equal(top({ anchorTop: 2, menuHeight: 132, viewportHeight: 900 }), 8, 'never above the window');
  assert.equal(top({ anchorTop: 46.4, menuHeight: 131.6, viewportHeight: 900 }), 40, 'whole pixels');
  for (let anchorTop = 0; anchorTop <= 1200; anchorTop += 37) {
    for (const viewportHeight of [200, 480, 900]) {
      const value = top({ anchorTop, menuHeight: 132, viewportHeight });
      assert.equal(value >= 8, true);
      if (viewportHeight >= 132 + 16) assert.equal(value + 132 <= viewportHeight - 8, true, `${anchorTop}/${viewportHeight}`);
    }
  }
});

test('opening measures the Create item and the menu, and hands the top to the stylesheet', () => {
  reset();
  const rects = { anchorTop: 300, menuHeight: 150 };
  trigger().getBoundingClientRect = () => ({ top: rects.anchorTop, bottom: rects.anchorTop + 38, left: 7, right: 193, width: 186, height: 38 });
  host().getBoundingClientRect = () => ({ top: 0, bottom: rects.menuHeight, left: 200, right: 520, width: 320, height: rects.menuHeight });
  mouseClick(trigger());
  assert.equal(host().style.getPropertyValue('--create-flyout-top'), '294px');
  assert.equal(host().style.left, '', 'the horizontal offset is the stylesheet\'s');

  flyout.closeCreateFlyout();
  rects.anchorTop = 740; // a short window: 768 high in happy-dom
  mouseClick(trigger());
  assert.equal(host().style.getPropertyValue('--create-flyout-top'), `${window.innerHeight - 150 - 8}px`);

  // a longer string made the open menu taller: it is placed again
  rects.menuHeight = 260;
  flyout.syncCreateFlyout({ running: true });
  assert.equal(host().style.getPropertyValue('--create-flyout-top'), `${window.innerHeight - 260 - 8}px`);
  delete host().getBoundingClientRect;
});

// ── 2. composer-header.js ───────────────────────────────────────────────────────────────────

test('the modal header names the mode and holds no Objective / Task switch', () => {
  const previous = state.activeTab;
  const page = document.createElement('div');
  try {
    for (const { mode, labelKey, hintKey } of CREATE_MODES) {
      state.activeTab = mode;
      page.innerHTML = renderComposerHeader();
      assert.equal(page.querySelector('[data-tab], [role="tab"], [role="tablist"], .composer-header-btn, .composer-header-nav') === null, true, `${mode}: no tab strip`);
      assert.equal(page.querySelectorAll('button').length, 0, 'a heading, not a control');
      const title = page.querySelector('.composer-header > .composer-header-inner > .composer-header-title');
      assert.equal(title.dataset.mode, mode);
      const heading = title.querySelector('h2.composer-header-heading');
      assert.equal(heading.textContent, i18n.t(labelKey));
      assert.equal(title.querySelector('.composer-subheader').textContent, i18n.t(hintKey));
      assert.equal(title.querySelector('.composer-header-icon svg') !== null, true);
      // the same name and hint as the flyout entry that opens this mode
      reset();
      assert.equal(heading.textContent, entry(mode).querySelector('.create-flyout-label').textContent);
      assert.equal(title.querySelector('.composer-subheader').textContent, entry(mode).querySelector('.create-flyout-hint').textContent);
    }
    assert.equal(page.querySelector('.composer-header-actions') === null, true, 'New Task passes no actions');
  } finally {
    state.activeTab = previous;
  }
});

test('the modal header keeps History and the session tabs', () => {
  const previous = state.activeTab;
  const page = document.createElement('div');
  try {
    state.activeTab = 'objective';
    page.innerHTML = renderComposerHeader(
      '<button id="chat-console-toggle">console</button><button id="btn-archive">History</button>',
      '<div class="chat-tab-bar" id="chat-tab-bar"><button class="chat-tab" data-tab-id="t1">one</button><button class="chat-tab-add" id="chat-tab-add">+</button></div>',
    );
    const header = page.querySelector('.composer-header');
    assert.deepEqual([...header.children].map(el => el.className), ['composer-header-inner', 'chat-tab-bar']);
    assert.deepEqual([...header.querySelector('.composer-header-inner').children].map(el => el.className),
      ['composer-header-title', 'composer-header-actions']);
    assert.deepEqual([...header.querySelectorAll('.composer-header-actions > button')].map(el => el.id), ['chat-console-toggle', 'btn-archive']);
    assert.deepEqual([...header.querySelectorAll('.chat-tab-bar > button')].map(el => el.className), ['chat-tab', 'chat-tab-add']);

    // a page-level tab id that is no Create mode still renders the Objective heading
    state.activeTab = 'board';
    page.innerHTML = renderComposerHeader();
    assert.equal(page.querySelector('.composer-header-heading').textContent, 'New Objective');
  } finally {
    state.activeTab = previous;
  }
  assert.equal(createMode('new_task').mode, 'new_task');
  assert.equal(createMode('objective').mode, 'objective');
  assert.equal(createMode(undefined).mode, 'objective');
});

// ── 3. template.html: a pick opens the right mode ───────────────────────────────────────────

function templateFunction(name) {
  const match = templateSrc.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'));
  assert.ok(match, `${name} exists in template.html`);
  return match[0];
}

// openCreateMode() and leaveTaskSurfacesForNav() from source, over a fake page.
function pickHarness({ tab = 'board', workspaceOpen = false, workspaceCloses = true, terminal = false, chat = true } = {}) {
  const calls = { renders: [], focused: 0, navSyncs: 0, dismissed: [], stored: [], closeRequests: 0, detached: [], sessionSyncs: 0, events: [], perf: [] };
  let finishRender;
  const state = {
    activeTab: tab,
    activeTabId: chat ? 'tab-1' : null,
    chatState: chat ? { tickSeen: false } : null,
    activeTerminal: terminal ? { detach: options => calls.detached.push(options) } : null,
    pendingRestoreContext: { scrollY: 420 },
  };
  let closeWorkspace;
  const context = vm.createContext({
    state, calls, Event: class { constructor(type) { this.type = type; } },
    ACTIVE_NEW_TAB_KEY: 'todo-active-new-form',
    sessionStorage: { setItem: (name, value) => calls.stored.push([name, value]) },
    isNewSectionTab: (t = state.activeTab) => t === 'objective' || t === 'new_task',
    perfStart: (name, detail) => { calls.perf.push([name, detail]); return name; },
    perfEnd: () => {},
    dismissObjectiveNotification: id => calls.dismissed.push(id),
    syncLeftNavFromState: () => { calls.navSyncs++; },
    objectiveModal: { focusObjectiveModal: () => { calls.focused++; return true; } },
    loadAndRender: (options) => {
      calls.renders.push({ options, tab: state.activeTab });
      return new Promise((resolve) => { finishRender = resolve; });
    },
    taskBoard: { syncActiveSessionsNav: () => { calls.sessionSyncs++; } },
    requestCloseTaskEditModal: () => {
      calls.closeRequests++;
      return new Promise((resolve) => { closeWorkspace = () => { workspaceOpen = false; resolve(workspaceCloses); }; });
    },
    document: {
      getElementById: id => (id === 'task-edit-modal' ? { hidden: !workspaceOpen } : null),
      dispatchEvent: event => calls.events.push(event.type),
    },
  });
  vm.runInContext(['leaveTaskSurfacesForNav', 'openCreateMode'].map(templateFunction).join('\n'), context);
  return {
    context, state, calls,
    finishRender: async () => { finishRender(); await new Promise(resolve => setImmediate(resolve)); },
    closeWorkspace: async () => { closeWorkspace(); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('New Objective opens the Create modal on the objective and clears its ready tick', async () => {
  const h = pickHarness({ tab: 'backlog' });
  h.context.openCreateMode('objective');
  assert.equal(h.state.activeTab, 'objective');
  assert.deepEqual(h.calls.stored, [['todo-active-new-form', 'objective']]);
  assert.equal(h.state.chatState.tickSeen, true, 'opening the objective is what "seen" means');
  assert.deepEqual(h.calls.dismissed, ['tab-1'], 'its "Objective complete" card goes with it');
  assert.equal(h.calls.renders.length, 1);
  assert.deepEqual({ ...h.calls.renders[0].options }, { scrollToTop: true });
  assert.equal(h.calls.renders[0].tab, 'objective', 'the mode is set before the render reads it');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.perf)), [['nav-section-switch', { section: 'new', mode: 'objective', from: 'backlog' }]]);
  await h.finishRender();
  assert.equal(h.calls.focused, 0, 'a render that opens the modal moves focus in itself');
});

test('New Task opens the Create modal on the task form and leaves the objective\'s tick alone', async () => {
  const h = pickHarness({ tab: 'board' });
  h.context.openCreateMode('new_task');
  assert.equal(h.state.activeTab, 'new_task');
  assert.deepEqual(h.calls.stored, [['todo-active-new-form', 'new_task']]);
  assert.equal(h.state.chatState.tickSeen, false, 'the proposals have not been looked at');
  assert.deepEqual(h.calls.dismissed, []);
  assert.equal(h.calls.renders.length, 1);
  assert.equal(h.calls.renders[0].tab, 'new_task');
  await h.finishRender();
  assert.equal(h.calls.focused, 0);

  // with no chat at all there is nothing to mark, and nothing throws
  const bare = pickHarness({ tab: 'board', chat: false });
  bare.context.openCreateMode('objective');
  assert.equal(bare.state.activeTab, 'objective');
  assert.deepEqual(bare.calls.dismissed, []);
});

test('a pick of the other mode switches the open modal and moves focus into it', async () => {
  for (const [from, to] of [['objective', 'new_task'], ['new_task', 'objective']]) {
    const h = pickHarness({ tab: from });
    h.context.openCreateMode(to);
    assert.equal(h.state.activeTab, to);
    assert.equal(h.calls.renders.length, 1, `${from} → ${to}: one render of the modal`);
    assert.equal(h.calls.focused, 0, 'not before the new mode is rendered');
    await h.finishRender();
    assert.equal(h.calls.focused, 1, 'the render did not open the modal, so focus is moved here');
  }

  // something navigated away while the render was in flight: focus is left alone
  const h = pickHarness({ tab: 'objective' });
  h.context.openCreateMode('new_task');
  h.state.activeTab = 'board';
  await h.finishRender();
  assert.equal(h.calls.focused, 0);
});

test('a pick of the mode that is already showing renders nothing and refocuses the modal', () => {
  for (const mode of ['objective', 'new_task']) {
    const h = pickHarness({ tab: mode });
    h.context.openCreateMode(mode);
    assert.equal(h.state.activeTab, mode);
    assert.deepEqual(h.calls.renders, [], 'no render: it would wipe an in-progress composer');
    assert.equal(h.calls.navSyncs, 1, 'the ready tick can have changed');
    assert.equal(h.calls.focused, 1);
    assert.equal(h.state.chatState.tickSeen, mode === 'objective');
  }
});

test('anything that is not New Task opens the objective', () => {
  for (const mode of [undefined, null, '', 'board', 'task']) {
    const h = pickHarness();
    h.context.openCreateMode(mode);
    assert.equal(h.state.activeTab, 'objective', String(mode));
  }
});

test('an open task terminal is minimized, and an open task workspace closed, before Create opens', async () => {
  const terminal = pickHarness({ terminal: true });
  terminal.context.openCreateMode('new_task');
  assert.deepEqual(JSON.parse(JSON.stringify(terminal.calls.detached)), [{ refreshBoard: false }]);
  assert.equal(terminal.state.pendingRestoreContext, null, 'this is navigation: no scroll restore');
  assert.deepEqual(terminal.calls.events, ['tiptask:sync-nav-statuses']);
  assert.equal(terminal.calls.sessionSyncs, 1);
  assert.equal(terminal.calls.renders.length, 1);

  const workspace = pickHarness({ workspaceOpen: true });
  workspace.context.openCreateMode('new_task');
  assert.equal(workspace.calls.closeRequests, 1);
  assert.equal(workspace.state.activeTab, 'board', 'nothing navigates while the discard confirm is up');
  assert.deepEqual(workspace.calls.renders, []);
  assert.deepEqual(workspace.calls.perf, []);
  await workspace.closeWorkspace();
  assert.equal(workspace.state.activeTab, 'new_task', 'the pick is taken again once it has closed');
  assert.equal(workspace.calls.renders.length, 1);

  const kept = pickHarness({ workspaceOpen: true, workspaceCloses: false });
  kept.context.openCreateMode('objective');
  await kept.closeWorkspace();
  assert.equal(kept.state.activeTab, 'board', 'the user kept the workspace: the pick is dropped');
  assert.deepEqual(kept.calls.renders, []);
});

// ── 4. Wiring ───────────────────────────────────────────────────────────────────────────────

function extractFunctionBody(source, name) {
  const start = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start, `function ${name}() not found`);
  const nextRe = /^(?:export )?(?:async )?function \w+\(/gm;
  nextRe.lastIndex = start.index + start[0].length;
  const next = nextRe.exec(source);
  return source.slice(start.index, next ? next.index : source.length);
}

test('template.html: the Create item is the flyout\'s button, not a section link', () => {
  const nav = extractFunctionBody(templateSrc, 'syncLeftNavPanel');
  const item = /<button class="left-nav-btn left-nav-btn--primary" data-section="new" type="button">([\s\S]*?)<\/button>/.exec(nav);
  assert.ok(item, 'the Create item carries no tooltip: hovering it opens the menu');
  assert.match(item[1], /<span class="left-nav-chevron" aria-hidden="true">\$\{CHEVRON_NAV_SVG\}<\/span>/);
  // its click is the menu's; the section loop leaves it alone
  assert.match(nav, /panel\.querySelectorAll\('\.left-nav-btn\[data-section\]'\)\.forEach\(btn => \{[\s\S]{0,260}if \(btn\.dataset\.section === 'new'\) return;\s*btn\.addEventListener\('click'/);
  assert.match(nav, /createFlyout\.mountCreateFlyout\(\{\s*trigger: panel\.querySelector\('\[data-section="new"\]'\),\s*onSelect: openCreateMode,\s*\}\);/);
  assert.equal(/else if \(section === 'new'\)|ACTIVE_NEW_TAB_KEY/.test(nav), false, 'no "open the last mode" branch is left');
  // mounted once with the panel, synced on every pass
  assert.ok(nav.indexOf('createFlyout.mountCreateFlyout(') < nav.indexOf("document.body.classList.toggle(\n    'left-nav-collapsed'"));
  assert.match(nav, /createFlyout\.syncCreateFlyout\(\{\s*current: isNewSection \? state\.activeTab : null,\s*running: isStreaming,\s*ready: isReady,\s*\}\);/);
  // always named: the collapsed rail hides the label, and there is no tooltip to fall back on
  assert.match(nav, /applyNavLabel\(newBtn, 'nav\.create', \{ tooltip: false \}\);/);
  assert.match(nav, /newBtn\.setAttribute\('aria-label', stateLabel \|\| t\('nav\.create'\)\);/);
  assert.equal(/newBtn\.title\s*=/.test(nav), false);
  assert.match(templateSrc, /const createFlyout = window\.TipTask\.createFlyout;/);
  assert.match(read('index.js'), /import \* as createFlyout from '\.\/create-flyout\.js';[^\n]*\n[\s\S]*window\.TipTask\.createFlyout = createFlyout;/);
});

test('no Objective / Task tab strip is rendered, bound or styled anywhere', () => {
  for (const file of ['template.html', 'chat-ui.js', 'task-board.js', 'composer-header.js', 'chat-task-preview.js', 'objective-modal.js']) {
    const src = read(file);
    assert.equal(src.includes('composer-header-btn'), false, `${file} still names .composer-header-btn`);
    assert.equal(src.includes('composer-header-nav'), false, `${file} still names .composer-header-nav`);
  }
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/\.composer-header-(?:btn|nav)\b/.test(rules), false, 'styles.css still styles the mode switch');
  // the only data-tab buttons left are the Tasks views' own
  assert.match(templateSrc, /app\.querySelectorAll\('\.nav-tabs button\[data-tab\], \.backlog-hint-link\[data-tab\]'\)\.forEach\(bindTabButton\);/);
  assert.equal((templateSrc.match(/\.forEach\(bindTabButton\)/g) || []).length, 1);
  const bind = extractFunctionBody(templateSrc, 'bindTabButton');
  assert.equal(/objective|new_task|ACTIVE_NEW_TAB_KEY|isNewSectionTab/.test(bind.replace(/\/\/.*$/gm, '')), false,
    'bindTabButton() switches Tasks views only');
  assert.match(read('composer-header.js'), /import \{ createMode \} from '\.\/create-modes\.js';/);
});

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`^ *${escaped} \\{([^}]*)\\}`, 'm'));
  assert.ok(match, `${selector} { … } not found in styles.css`);
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '');
}

const zIndex = body => Number(/z-index:\s*(\d+)/.exec(body)?.[1]);

test('styles.css: the menu sits at the left menu\'s edge, expanded, collapsed and in a narrow window', () => {
  const box = rule('.create-flyout');
  assert.match(box, /position: fixed;/);
  assert.match(box, /--create-flyout-rail: 200px;/);
  assert.match(box, /left: var\(--create-flyout-rail\);/);
  assert.match(box, /top: var\(--create-flyout-top, 52px\);/, 'create-flyout.js supplies the top');
  assert.match(css, /body\.left-nav-collapsed \.create-flyout \{ --create-flyout-rail: 56px; \}/);
  assert.match(css, /@media \(max-width: 768px\) \{\s*\.create-flyout \{ --create-flyout-rail: 56px; \}/);
  // the same offsets as the surfaces that leave the left menu uncovered
  assert.match(rule('.objective-modal'), /inset: 0 0 0 200px;/);
  assert.match(css, /body\.left-nav-collapsed \.objective-modal \{ left: 56px; \}/);
  assert.match(css, /\.create-flyout\[hidden\] \{ display: none; \}/);
  // the gap to the card belongs to the box, so the pointer crosses no dead strip
  assert.match(box, /padding-left: 6px;/);
});

test('styles.css: the menu never leaves the window', () => {
  const box = rule('.create-flyout');
  const card = rule('.create-flyout-menu');
  assert.match(box, /max-height: calc\(100vh - 16px\);/, '8px clear of the top and the bottom');
  assert.match(box, /display: flex;\s*flex-direction: column;/);
  assert.match(card, /min-height: 0;\s*overflow-y: auto;/, 'the card scrolls inside when the window is shorter still');
  assert.match(card, /max-width: min\(22rem, calc\(100vw - var\(--create-flyout-rail\) - 14px\)\);/,
    'no wider than what is left beside the left menu: its 6px gap plus 8px to the window\'s edge');
  assert.match(card, /width: max-content;/);
  assert.equal(/white-space:\s*nowrap/.test(rule('.create-flyout-label') + rule('.create-flyout-hint') + rule('.create-flyout-item')), false,
    'entries wrap in a narrow window');
  assert.match(rule('.create-flyout-item'), /grid-template-columns: auto minmax\(0, 1fr\) auto;/);
});

test('styles.css: the menu shows above every surface that leaves the left menu uncovered', () => {
  const own = zIndex(rule('.create-flyout'));
  assert.equal(own, 3500);
  const railLive = {
    'the Create modal': zIndex(rule('.objective-modal')),
    'a task terminal': zIndex(rule('.terminal-overlay')),
    'the task workspace': zIndex(/^\.task-edit-overlay \{([^}]*)\}/m.exec(css)[1]),
    'the task workspace with its chat open': zIndex(/body\.task-chat-open \.task-edit-overlay \{([^}]*)\}/.exec(css)[1]),
  };
  for (const [name, value] of Object.entries(railLive)) {
    assert.equal(Number.isFinite(value) && value < own, true, `${name} (${value}) would cover the menu`);
  }
  assert.equal(own < zIndex(rule('.tt-saving-indicator')), true, 'toasts and tooltips stay above it');
});

test('styles.css: the menu is painted from the palette, with the accent tokens made for each job', () => {
  const start = css.indexOf('/* ── Create flyout (TPT9390) ──');
  const end = css.indexOf('.sidebar-toggle {');
  assert.ok(start > 0 && end > start);
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(block), false, 'no hard-coded hex colours');
  assert.equal(/var\(--c-primary(?:-hover)?\)/.test(block), false, 'raw --c-primary is a fill colour, not text or a ring');

  const card = rule('.create-flyout-menu');
  assert.match(card, /background: var\(--c-bg-card\);/);
  assert.match(card, /border: 1px solid var\(--create-flyout-edge\);/);
  assert.match(card, /--create-flyout-edge: color-mix\(in srgb, var\(--c-text\) 14%, transparent\);/);
  assert.match(rule('.create-flyout-hint'), /color: var\(--c-text-secondary\);/, '--c-text-muted misses AA on several light cards');
  assert.match(rule('.create-flyout-icon'), /background-color: var\(--left-nav-active-bg\);\s*color: var\(--left-nav-active-fg\);/);
  assert.match(block, /\.create-flyout-item:hover,\s*\.create-flyout-item:focus \{\s*background-color: var\(--left-nav-btn-state-bg\);/);
  assert.match(rule('.create-flyout-item:focus-visible'), /outline: 2px solid var\(--c-primary-border\);/);
  assert.match(block, /\.create-flyout-item\.is-current,\s*\.create-flyout-item\.is-current:hover,\s*\.create-flyout-item\.is-current:focus \{\s*background-color: var\(--left-nav-active-bg\);\s*box-shadow: inset 3px 0 0 var\(--left-nav-active-fg\);/);
  assert.match(rule('.create-flyout-item.is-current .create-flyout-label'), /color: var\(--left-nav-active-fg\);/);
  assert.match(rule('.create-flyout-status'), /color: var\(--c-primary-text\);/);
  assert.match(rule('.create-flyout-status[data-state="ready"]'), /color: var\(--c-success\);/);
  assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation: none;/);
  assert.match(block, /@media \(forced-colors: active\) \{\s*\.create-flyout-item\.is-current \{\s*outline: 1px solid Highlight;/);

  // the modal heading: same icon pair, AA text tokens on the modal's ground
  assert.match(rule('.composer-header-icon'), /background-color: var\(--left-nav-active-bg\);\s*color: var\(--left-nav-active-fg\);/);
  assert.match(rule('.composer-header-heading'), /color: var\(--c-text\);/);
  assert.match(rule('.composer-subheader'), /color: var\(--c-text-secondary\);/);
});

test('styles.css: the Create item shows it opens a menu, and only while its label shows', () => {
  assert.match(rule('.left-nav-chevron'), /margin-left: auto;/);
  assert.match(css, /body\.left-nav-collapsed \.left-nav-label,\s*body\.left-nav-collapsed \.left-nav-chevron \{\s*display: none;\s*\}/);
  assert.match(css, /@media \(max-width: 768px\) \{\s*\.create-flyout \{ --create-flyout-rail: 56px; \}\s*\.left-nav-chevron \{ display: none; \}\s*\}/);
  assert.match(rule('.left-nav-btn[aria-expanded="true"]:not(.active)'), /background-color: var\(--left-nav-btn-state-bg\);/);
});

// ── Palette arithmetic ──────────────────────────────────────────────────────────────────────
// The flyout's text sits on three grounds: the card, the card under the hover tint, and the
// current entry's --left-nav-active-bg. Every text colour it uses must clear 4.5:1 on each of
// the grounds it can meet, in every palette — computed from the palette blocks themselves.

function tokens(block) {
  const out = {};
  for (const m of block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function block(selectorPattern) {
  const m = new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `styles.css has no ${selectorPattern} block`);
  return m[1];
}

function rgb(hex) {
  assert.match(hex, /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, `expected a hex colour, got ${hex}`);
  const raw = hex.slice(1);
  return (raw.length === 3 ? [...raw].map(c => c + c).join('') : raw).match(/../g).map(pair => parseInt(pair, 16));
}

function luminance(colour) {
  const [r, g, b] = colour.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const mix = (a, b, percentOfA) => a.map((channel, i) => channel * (percentOfA / 100) + b[i] * (1 - percentOfA / 100));

function over(rgba, base) {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(rgba);
  assert.ok(m, `expected an rgba() colour, got ${rgba}`);
  const alpha = Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3])].map((channel, i) => channel * alpha + base[i] * (1 - alpha));
}

const mixPercent = (name, source) => {
  const m = new RegExp(`${name}:\\s*color-mix\\(in srgb, var\\(--c-primary\\) (\\d+)%`).exec(source);
  assert.ok(m, `${name} is not a --c-primary mix`);
  return Number(m[1]);
};

test('flyout and heading text clear AA on every ground they sit on, in every palette', () => {
  const root = tokens(block(':root'));
  const dark = tokens(block('\\.theme-dark'));
  const darkIds = new Set([.../_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(boardSrc)[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
  const palettes = [{ id: ':root', values: root }];
  for (const m of css.matchAll(/^\s*\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/gm)) palettes.push({ id: m[1], values: tokens(m[2]) });
  assert.equal(palettes.length >= 21, true, 'every palette is checked');
  const activeBgPercent = mixPercent('--left-nav-active-bg', block(':root'));
  const accentPercent = { light: mixPercent('--c-primary-text', block(':root')), dark: mixPercent('--c-primary-text', block('\\.theme-dark')) };

  for (const { id, values } of palettes) {
    const isDark = darkIds.has(id);
    const card = rgb(values['--c-bg-card']);
    const page = rgb(values['--c-bg']);
    const primary = rgb(values['--c-primary']);
    const text = rgb(values['--c-text']);
    const secondary = rgb(values['--c-text-secondary']);
    const success = rgb((isDark ? dark : root)['--c-success']);
    const accentText = mix(primary, text, isDark ? accentPercent.dark : accentPercent.light);
    const grounds = {
      card,
      'hover tint': over(values['--c-primary-light'], card),
      'current entry': mix(primary, card, activeBgPercent),
    };
    const need = (name, fg, bg, ground) => {
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= 4.5, `${id}: ${name} on ${ground} is ${ratio.toFixed(2)}:1; expected at least 4.5:1`);
    };
    for (const [ground, bg] of Object.entries(grounds)) {
      need('the hint (--c-text-secondary)', secondary, bg, ground);
      need('"Ready to review" (--c-success)', success, bg, ground);
      need('"Planning…" (--c-primary-text)', accentText, bg, ground);
    }
    need('the label (--c-text)', text, grounds.card, 'card');
    need('the label (--c-text)', text, grounds['hover tint'], 'hover tint');
    // the Create modal's heading row sits on the page colour
    need('the modal heading (--c-text)', text, page, 'the modal');
    need('the modal hint (--c-text-secondary)', secondary, page, 'the modal');
  }
});
