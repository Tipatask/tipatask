import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

// (TPT9381) The preview drawer shell (preview-drawer.js) in happy-dom: several items open at once
// as tabs, reopening an id focuses its tab, the width clamps to the host and is remembered,
// Escape inside the drawer closes the focused tab ahead of the chat's own Escape handler, and
// every control has an accessible name in every locale. happy-dom has no layout, so a host's
// width is stubbed on the element; a fake ResizeObserver stands in for the browser's.

const window = new Window({ url: 'http://localhost:4455/todo.html' });
const observers = [];
class FakeResizeObserver {
  constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
  observe(el) { this.targets.add(el); }
  unobserve(el) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
}
for (const [key, value] of Object.entries({
  window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement,
  Event: window.Event, CustomEvent: window.CustomEvent, KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent, PointerEvent: window.PointerEvent, localStorage: window.localStorage,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  ResizeObserver: FakeResizeObserver,
})) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });

const drawerModule = await import('./preview-drawer.js');
const i18n = await import('./i18n.js');
const {
  createPreviewDrawer, clampDrawerWidth, readStoredDrawerWidth,
  PREVIEW_DRAWER_WIDTH_KEY, PREVIEW_DRAWER_WIDTH_VAR,
  DEFAULT_DRAWER_WIDTH, MIN_DRAWER_WIDTH, MIN_TRANSCRIPT_WIDTH,
} = drawerModule;

const HOST_CLASS = 'task-chat-panel--with-drawer';
const frame = () => new Promise((resolve) => setTimeout(resolve, 30)); // one requestAnimationFrame

// A stand-in chat panel: transcript, composer, a Send button — and a width the test controls.
function makeHost(width = 1200) {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  host.className = 'task-chat-panel';
  host.innerHTML = '<div class="task-chat-scroll"><p>transcript</p></div>'
    + '<footer class="task-chat-footer"><textarea class="task-chat-input"></textarea><button class="send">Send</button></footer>';
  document.body.appendChild(host);
  const size = { width };
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => size.width });
  return { host, size, input: host.querySelector('.task-chat-input') };
}

function reset() {
  i18n.setLocale('en');
  try { localStorage.clear(); } catch { /* storage unavailable */ }
  observers.length = 0;
}

const tabs = (host) => [...host.querySelectorAll('.preview-drawer [role="tab"]')];
const panelsOf = (host) => [...host.querySelectorAll('.preview-drawer [role="tabpanel"]')];
const handleOf = (host) => host.querySelector('.preview-drawer-resize');
const shownWidth = (host) => host.style.getPropertyValue(PREVIEW_DRAWER_WIDTH_VAR);
// Nodes are compared as booleans: a failing assert.equal on happy-dom nodes never finishes
// formatting its message and the whole file times out instead of reporting the failure.
const same = (actual, expected, message) => assert.equal(actual === expected, true, message);
const none = (actual, message) => assert.equal(actual === null, true, message);

function key(target, keyName, init = {}) {
  const event = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function pointer(target, type, clientX, init = {}) {
  target.dispatchEvent(new PointerEvent(type, {
    clientX, pointerId: 7, isPrimary: true, button: 0, bubbles: true, cancelable: true, ...init,
  }));
}

function doc(text) {
  const el = document.createElement('article');
  el.className = 'doc';
  el.textContent = text;
  return el;
}

test('three items stay open together as tabs beside a chat that stays usable', () => {
  reset();
  const { host, input } = makeHost();
  let closed = 0;
  const drawer = createPreviewDrawer(host, { onClose: () => { closed++; }, hostClass: HOST_CLASS });
  none(drawer.element, 'nothing is built before the first open');

  input.focus();
  drawer.open({ id: 'ai/a.md', title: 'ai/a.md', body: doc('Alpha') });
  drawer.open({ id: 'ai/b.sql', title: 'ai/b.sql', body: '<b>not markup</b>' });
  const third = drawer.open({ id: 'ai/c.txt', title: 'ai/c.txt', body: doc('Gamma') });

  const root = host.querySelector('.preview-drawer');
  assert.ok(root, 'the drawer is built inside its host');
  same(root.parentElement, host);
  same(host.lastElementChild, root, 'docked after the chat content');
  assert.ok(host.classList.contains(HOST_CLASS), 'the host makes room under its own class');
  assert.equal(host.querySelectorAll('.preview-drawer').length, 1, 'one drawer for all items');

  assert.deepEqual(drawer.ids(), ['ai/a.md', 'ai/b.sql', 'ai/c.txt']);
  assert.deepEqual(tabs(host).map((t) => t.textContent), ['ai/a.md', 'ai/b.sql', 'ai/c.txt']);
  assert.deepEqual(tabs(host).map((t) => t.getAttribute('aria-selected')), ['false', 'false', 'true']);
  assert.deepEqual(tabs(host).map((t) => t.tabIndex), [-1, -1, 0], 'roving tabindex: one tab stop');
  assert.equal(host.querySelector('[role="tablist"]').querySelectorAll('[role="tab"]').length, 3);
  assert.equal(drawer.activeId(), 'ai/c.txt');

  const panels = panelsOf(host);
  assert.equal(panels.length, 3, 'each item keeps its own panel');
  assert.deepEqual(panels.map((p) => p.hidden), [true, true, false]);
  same(third.panel, panels[2]);
  for (const [i, tab] of tabs(host).entries()) {
    assert.equal(tab.getAttribute('aria-controls'), panels[i].id);
    assert.equal(panels[i].getAttribute('aria-labelledby'), tab.id);
  }
  assert.equal(panels[0].querySelector('.doc').textContent, 'Alpha');
  none(panels[1].querySelector('b'), 'a string body is text, never parsed as HTML');
  assert.equal(panels[1].textContent, '<b>not markup</b>');

  // Non-blocking: no backdrop, no modal semantics, nothing beside it made inert.
  none(host.querySelector('.preview-drawer [aria-modal], .preview-drawer [role="dialog"]'));
  assert.equal(root.getAttribute('role'), null);
  assert.equal([...document.body.querySelectorAll('*')].some((el) => el.inert), false);
  input.focus();
  same(document.activeElement, input, 'the composer still takes focus');
  input.value = 'still typing';
  assert.equal(drawer.isOpen(), true);
  assert.equal(closed, 0);

  // Clicking a tab selects it.
  tabs(host)[0].click();
  assert.equal(drawer.activeId(), 'ai/a.md');
  assert.deepEqual(panelsOf(host).map((p) => p.hidden), [false, true, true]);
  assert.equal(root.getAttribute('aria-labelledby'), tabs(host)[0].id);
  drawer.destroy();
});

test('reopening an id focuses its tab instead of adding another', () => {
  reset();
  const { host, input } = makeHost();
  const drawer = createPreviewDrawer(host, { hostClass: HOST_CLASS });
  drawer.open({ id: 'a', title: 'First', body: doc('one') });
  drawer.open({ id: 'b', title: 'Second', body: doc('two') });
  drawer.open({ id: 'c', title: 'Third', body: doc('three') });

  input.focus();
  const again = drawer.open({ id: 'a' });
  assert.equal(tabs(host).length, 3, 'no duplicate tab');
  assert.equal(drawer.activeId(), 'a');
  same(document.activeElement, tabs(host)[0], 'keyboard focus is on the reopened tab');
  same(again.panel, panelsOf(host)[0]);
  assert.equal(panelsOf(host)[0].hidden, false);
  assert.equal(panelsOf(host)[0].textContent, 'one', 'no body given: the content stays');

  // Reopening with fresh content and a title replaces them in place.
  drawer.open({ id: 'b', title: 'Second (v2)', body: doc('two, again') });
  assert.equal(tabs(host).length, 3);
  assert.equal(drawer.activeId(), 'b');
  same(document.activeElement, tabs(host)[1]);
  assert.equal(tabs(host)[1].textContent, 'Second (v2)');
  assert.equal(tabs(host)[1].title, 'Second (v2)');
  assert.equal(panelsOf(host)[1].textContent, 'two, again');
  assert.equal(host.querySelectorAll('.preview-drawer-tab-close')[1].getAttribute('aria-label'), 'Close “Second (v2)”');

  // { focus: false } selects without taking keyboard focus from the chat.
  input.focus();
  drawer.open({ id: 'c' }, { focus: false });
  assert.equal(drawer.activeId(), 'c');
  same(document.activeElement, input);

  // An id is required; a missing title falls back to the id.
  none(drawer.open({ title: 'no id' }), 'an id is required');
  drawer.open({ id: 42 });
  assert.equal(tabs(host)[3].textContent, '42');
  assert.equal(drawer.has(42), true);
  drawer.destroy();
});

test('the width clamps so the transcript keeps its minimum', () => {
  assert.equal(clampDrawerWidth(100, 1000), MIN_DRAWER_WIDTH, 'never under the drawer minimum');
  assert.equal(clampDrawerWidth(500, 1000), 500);
  assert.equal(clampDrawerWidth(900, 1000), 1000 - MIN_TRANSCRIPT_WIDTH, 'the transcript keeps its minimum');
  assert.equal(clampDrawerWidth(500, 500), MIN_DRAWER_WIDTH, 'too narrow for both: the drawer keeps its own minimum');
  assert.equal(clampDrawerWidth(700, 0), 700, 'an unmeasured host clamps only to the minimum');
  assert.equal(clampDrawerWidth(512.6, 2000), 513);
});

// (TPT9408) No picked width: the drawer fills its host, leaving the chat a slim column.
test('with no picked width the drawer fills the host but the transcript minimum', () => {
  assert.equal(clampDrawerWidth(null, 1280), 1280 - MIN_TRANSCRIPT_WIDTH);
  assert.equal(clampDrawerWidth(null, 2560), 2560 - MIN_TRANSCRIPT_WIDTH);
  assert.equal(clampDrawerWidth(undefined, 1000), 1000 - MIN_TRANSCRIPT_WIDTH);
  assert.equal(clampDrawerWidth(Number.NaN, 2000), 2000 - MIN_TRANSCRIPT_WIDTH, 'not a number counts as none');
  assert.equal(clampDrawerWidth(null, 500), MIN_DRAWER_WIDTH, 'too narrow for both: the drawer keeps its own minimum');
  assert.equal(clampDrawerWidth(null, 0), DEFAULT_DRAWER_WIDTH, 'an unmeasured host has no room to fill: the default');
});

test('the width follows the host, a window resize re-clamps it and the picked width is remembered', async () => {
  reset();
  assert.equal(readStoredDrawerWidth(), null, 'nothing stored: no picked width');
  localStorage.setItem(PREVIEW_DRAWER_WIDTH_KEY, '900');
  const { host, size } = makeHost(1000);
  const drawer = createPreviewDrawer(host, { hostClass: HOST_CLASS });
  drawer.open({ id: 'a', title: 'A', body: doc('a') });
  const handle = handleOf(host);

  assert.equal(shownWidth(host), '640px', 'the remembered 900px, clamped to a 1000px host');
  assert.equal(handle.getAttribute('role'), 'separator');
  assert.equal(handle.getAttribute('aria-orientation'), 'vertical');
  assert.equal(handle.getAttribute('aria-valuenow'), '640');
  assert.equal(handle.getAttribute('aria-valuemin'), String(MIN_DRAWER_WIDTH));
  assert.equal(handle.getAttribute('aria-valuemax'), '640');
  assert.equal(handle.tabIndex, 0, 'the handle is keyboard operable');

  // A wider window gives the remembered width back; a clamp never overwrites it.
  size.width = 1600;
  window.dispatchEvent(new Event('resize'));
  await frame();
  assert.equal(shownWidth(host), '900px');
  assert.equal(handle.getAttribute('aria-valuemax'), String(1600 - MIN_TRANSCRIPT_WIDTH));
  size.width = 700;
  window.dispatchEvent(new Event('resize'));
  await frame();
  assert.equal(shownWidth(host), '340px', 'a narrow window shrinks it for now');
  assert.equal(localStorage.getItem(PREVIEW_DRAWER_WIDTH_KEY), '900');

  // A host that resizes on its own (the left menu folding) re-clamps through ResizeObserver.
  size.width = 1100;
  assert.ok(observers.length > 0 && [...observers.at(-1).targets].includes(host), 'the host is observed');
  observers.at(-1).callback([]);
  await frame();
  assert.equal(shownWidth(host), '740px');

  // Dragging the handle left widens the drawer, live; letting go remembers the width.
  size.width = 1600;
  window.dispatchEvent(new Event('resize'));
  await frame();
  assert.equal(shownWidth(host), '900px');
  pointer(handle, 'pointerdown', 700);
  assert.ok(document.body.classList.contains('preview-drawer-resizing'));
  pointer(handle, 'pointermove', 650);
  assert.equal(shownWidth(host), '950px');
  pointer(handle, 'pointermove', 100);
  assert.equal(shownWidth(host), `${1600 - MIN_TRANSCRIPT_WIDTH}px`, 'dragging stops at the transcript minimum');
  pointer(handle, 'pointerup', 100);
  assert.equal(document.body.classList.contains('preview-drawer-resizing'), false);
  assert.equal(localStorage.getItem(PREVIEW_DRAWER_WIDTH_KEY), null, 'the widest width is remembered as "fill"');
  size.width = 2000;
  window.dispatchEvent(new Event('resize'));
  await frame();
  assert.equal(shownWidth(host), `${2000 - MIN_TRANSCRIPT_WIDTH}px`, 'so a wider window is filled too');
  size.width = 1600;
  window.dispatchEvent(new Event('resize'));
  await frame();
  pointer(handle, 'pointerdown', 500);
  pointer(handle, 'pointermove', 1500);
  assert.equal(shownWidth(host), `${MIN_DRAWER_WIDTH}px`, 'and at the drawer minimum the other way');
  pointer(handle, 'pointerup', 1500);
  assert.equal(localStorage.getItem(PREVIEW_DRAWER_WIDTH_KEY), String(MIN_DRAWER_WIDTH));

  // Escape during a drag puts the width back and is not passed on.
  pointer(handle, 'pointerdown', 500);
  pointer(handle, 'pointermove', 300);
  assert.equal(shownWidth(host), `${MIN_DRAWER_WIDTH + 200}px`);
  let chatSaw = 0;
  const chatEscape = () => { chatSaw++; };
  document.addEventListener('keydown', chatEscape, true);
  key(document.body, 'Escape');
  assert.equal(shownWidth(host), `${MIN_DRAWER_WIDTH}px`);
  assert.equal(chatSaw, 0);
  assert.equal(drawer.ids().length, 1, 'cancelling a drag closes nothing');
  document.removeEventListener('keydown', chatEscape, true);
  pointer(handle, 'pointermove', 100);
  assert.equal(shownWidth(host), `${MIN_DRAWER_WIDTH}px`, 'the cancelled drag no longer follows the pointer');

  // Keyboard: arrows move the handle (left = wider), Shift for big steps, Home / End to the ends.
  handle.focus();
  key(handle, 'ArrowLeft');
  assert.equal(shownWidth(host), `${MIN_DRAWER_WIDTH + 16}px`);
  key(handle, 'ArrowLeft', { shiftKey: true });
  assert.equal(shownWidth(host), `${MIN_DRAWER_WIDTH + 80}px`);
  key(handle, 'ArrowRight');
  assert.equal(shownWidth(host), `${MIN_DRAWER_WIDTH + 64}px`);
  assert.equal(localStorage.getItem(PREVIEW_DRAWER_WIDTH_KEY), String(MIN_DRAWER_WIDTH + 64));
  key(handle, 'End');
  assert.equal(shownWidth(host), `${1600 - MIN_TRANSCRIPT_WIDTH}px`);
  assert.equal(localStorage.getItem(PREVIEW_DRAWER_WIDTH_KEY), null, 'End is "fill" again');
  key(handle, 'Home');
  assert.equal(shownWidth(host), `${MIN_DRAWER_WIDTH}px`);
  assert.equal(localStorage.getItem(PREVIEW_DRAWER_WIDTH_KEY), String(MIN_DRAWER_WIDTH));
  key(handle, 'ArrowRight');
  assert.equal(shownWidth(host), `${MIN_DRAWER_WIDTH}px`, 'never under the minimum');
  key(handle, 'ArrowLeft', { shiftKey: true });
  assert.equal(localStorage.getItem(PREVIEW_DRAWER_WIDTH_KEY), String(MIN_DRAWER_WIDTH + 64));
  drawer.destroy();
  assert.equal(shownWidth(host), '', 'a closed drawer leaves no width on the host');

  // The next drawer starts at the remembered width; after End (fill) it fills its own host.
  const { host: next } = makeHost(1600);
  const again = createPreviewDrawer(next);
  again.open({ id: 'x', title: 'X', body: 'x' });
  assert.equal(shownWidth(next), `${MIN_DRAWER_WIDTH + 64}px`);
  key(handleOf(next), 'End');
  again.destroy();
  const { host: wide } = makeHost(2400);
  const filling = createPreviewDrawer(wide);
  filling.open({ id: 'x', title: 'X', body: 'x' });
  assert.equal(shownWidth(wide), `${2400 - MIN_TRANSCRIPT_WIDTH}px`);
  filling.destroy();

  // A host too narrow for both minimums has one width: it is stored as it is, not as "fill".
  const { host: narrow } = makeHost(500);
  const cramped = createPreviewDrawer(narrow);
  cramped.open({ id: 'n', title: 'N', body: 'n' });
  assert.equal(shownWidth(narrow), `${MIN_DRAWER_WIDTH}px`);
  key(handleOf(narrow), 'Home');
  assert.equal(localStorage.getItem(PREVIEW_DRAWER_WIDTH_KEY), String(MIN_DRAWER_WIDTH));
  cramped.destroy();

  // Blocked storage (a private window, cleared site data) still opens, filling its host.
  const storage = globalThis.localStorage;
  const blocked = () => { throw new Error('blocked'); };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true, value: { getItem: blocked, setItem: blocked, removeItem: blocked },
  });
  try {
    assert.equal(readStoredDrawerWidth(), null);
    const { host: blockedHost } = makeHost(1600);
    const quiet = createPreviewDrawer(blockedHost);
    quiet.open({ id: 'q', title: 'Q', body: 'q' });
    assert.equal(shownWidth(blockedHost), `${1600 - MIN_TRANSCRIPT_WIDTH}px`);
    key(handleOf(blockedHost), 'ArrowRight');
    assert.equal(shownWidth(blockedHost), `${1600 - MIN_TRANSCRIPT_WIDTH - 16}px`, 'resizing works without storage');
    key(handleOf(blockedHost), 'End');
    assert.equal(shownWidth(blockedHost), `${1600 - MIN_TRANSCRIPT_WIDTH}px`, 'and back to fill');
    quiet.destroy();
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  }
});

// (TPT9408) A fresh drawer fills its host — the chat keeps MIN_TRANSCRIPT_WIDTH — and keeps
// filling it through window and host resizes, down to the drawer's own minimum.
test('with nothing stored the drawer fills the host and follows its resizes', async () => {
  reset();
  const { host, size } = makeHost(1280);
  const drawer = createPreviewDrawer(host, { hostClass: HOST_CLASS });
  drawer.open({ id: 'a', title: 'A', body: doc('a') });
  const handle = handleOf(host);
  assert.equal(shownWidth(host), `${1280 - MIN_TRANSCRIPT_WIDTH}px`, 'a 1280 px window: 920 px document beside a 360 px chat');
  assert.equal(handle.getAttribute('aria-valuenow'), String(1280 - MIN_TRANSCRIPT_WIDTH));
  assert.equal(handle.getAttribute('aria-valuemax'), String(1280 - MIN_TRANSCRIPT_WIDTH));
  for (const [width, shown] of [[2560, 2560 - MIN_TRANSCRIPT_WIDTH], [1000, 1000 - MIN_TRANSCRIPT_WIDTH], [500, MIN_DRAWER_WIDTH]]) {
    size.width = width;
    window.dispatchEvent(new Event('resize'));
    await frame();
    assert.equal(shownWidth(host), `${shown}px`, `a ${width} px host`);
  }
  size.width = 1600;
  observers.at(-1).callback([]);
  await frame();
  assert.equal(shownWidth(host), `${1600 - MIN_TRANSCRIPT_WIDTH}px`, 'a host resize re-fills it too');
  assert.equal(localStorage.getItem(PREVIEW_DRAWER_WIDTH_KEY), null, 'filling stores nothing');

  // Closing and reopening fills again, at the host's size then.
  drawer.close('a');
  size.width = 1440;
  drawer.open({ id: 'b', title: 'B', body: doc('b') });
  assert.equal(shownWidth(host), `${1440 - MIN_TRANSCRIPT_WIDTH}px`);
  drawer.destroy();
});

// (TPT9408) The host's layout switches when the drawer docks or leaves: onLayoutChange() runs
// just before, the function it returns right after (new layout in place) — on the first open and
// the last close only, never on destroy(), and a failing callback never blocks the drawer.
test('onLayoutChange brackets the layout switch on the first open and the last close', () => {
  reset();
  const { host } = makeHost(1280);
  const calls = [];
  const drawer = createPreviewDrawer(host, {
    hostClass: HOST_CLASS,
    onLayoutChange() {
      calls.push(['before', host.classList.contains(HOST_CLASS), !!host.querySelector('.preview-drawer')]);
      return () => calls.push(['after', host.classList.contains(HOST_CLASS), !!host.querySelector('.preview-drawer'), shownWidth(host)]);
    },
  });
  drawer.open({ id: 'a', title: 'A', body: doc('a') });
  assert.deepEqual(calls, [['before', false, false], ['after', true, true, `${1280 - MIN_TRANSCRIPT_WIDTH}px`]],
    'before: the old layout; after: docked, with its width on the host');
  calls.length = 0;
  drawer.open({ id: 'b', title: 'B', body: doc('b') });
  drawer.open({ id: 'a' });
  drawer.close('b');
  assert.deepEqual(calls, [], 'tabs coming and going inside an open drawer switch no layout');
  drawer.close('a');
  assert.deepEqual(calls, [['before', true, true], ['after', false, false, '']], 'the last close switches back');
  calls.length = 0;
  drawer.open({ id: 'c', title: 'C', body: doc('c') });
  host.querySelector('.preview-drawer-close').click();
  assert.equal(calls.length, 4, 'the drawer Close switches back too');
  calls.length = 0;
  drawer.open({ id: 'd', title: 'D', body: doc('d') });
  calls.length = 0;
  drawer.destroy();
  assert.deepEqual(calls, [], 'destroy(): the host is going away, nothing to keep');

  // A callback that throws, or returns a restorer that throws, never stops the drawer.
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const { host: other } = makeHost(1280);
    let closed = 0;
    const throwing = createPreviewDrawer(other, { hostClass: HOST_CLASS, onClose: () => { closed++; }, onLayoutChange() { throw new Error('boom'); } });
    throwing.open({ id: 'x', title: 'X', body: doc('x') });
    assert.equal(throwing.isOpen(), true);
    assert.ok(other.classList.contains(HOST_CLASS));
    throwing.close('x');
    assert.equal(throwing.isOpen(), false);
    assert.equal(closed, 1);
    assert.equal(other.classList.contains(HOST_CLASS), false);
    const restorerThrows = createPreviewDrawer(other, { hostClass: HOST_CLASS, onLayoutChange: () => () => { throw new Error('late'); } });
    restorerThrows.open({ id: 'y', title: 'Y', body: doc('y') });
    assert.equal(restorerThrows.isOpen(), true);
    restorerThrows.closeAll();
    assert.equal(restorerThrows.isOpen(), false);
    throwing.destroy();
    restorerThrows.destroy();
  } finally {
    console.error = consoleError;
  }
  assert.equal(errors.length, 4, 'each failure is logged');
});

test('Escape inside the drawer closes the focused tab before the chat sees the key', () => {
  reset();
  const { host, input } = makeHost();
  const seen = [];
  // The chat window's capture-phase handler and the workspace's bubble-phase one, both
  // registered before the drawer exists.
  const chatEscape = (e) => { if (e.key === 'Escape') seen.push(`chat:${e.defaultPrevented}`); };
  const workspaceEscape = (e) => { if (e.key === 'Escape') seen.push('workspace'); };
  document.addEventListener('keydown', chatEscape, true);
  document.addEventListener('keydown', workspaceEscape);
  let closed = 0;
  const drawer = createPreviewDrawer(host, { onClose: () => { closed++; }, hostClass: HOST_CLASS });
  try {
    const opener = host.querySelector('.send');
    opener.focus();
    drawer.open({ id: 'a', title: 'A', body: doc('a') });
    drawer.open({ id: 'b', title: 'B', body: doc('b') });
    drawer.open({ id: 'c', title: 'C', body: doc('c') });

    // Focus outside the drawer: Escape is the chat's.
    input.focus();
    key(input, 'Escape');
    assert.deepEqual(seen, ['chat:false', 'workspace']);
    assert.equal(drawer.ids().length, 3);
    seen.length = 0;

    // On the second tab: Escape closes that tab, and the next tab takes focus.
    tabs(host)[1].click();
    tabs(host)[1].focus();
    key(document.activeElement, 'Escape');
    assert.deepEqual(seen, [], 'neither the chat nor the workspace saw it');
    assert.deepEqual(drawer.ids(), ['a', 'c']);
    assert.equal(drawer.activeId(), 'c');
    same(document.activeElement, tabs(host)[1]);

    // Inside a tab's content: Escape closes that tab.
    const panel = panelsOf(host)[1];
    panel.focus();
    same(document.activeElement, panel);
    key(panel, 'Escape');
    assert.deepEqual(drawer.ids(), ['a']);
    same(document.activeElement, tabs(host)[0]);

    // An IME composition's Escape is left alone.
    key(document.activeElement, 'Escape', { isComposing: true });
    assert.deepEqual(drawer.ids(), ['a']);
    seen.length = 0;

    // The last Escape closes the drawer and hands focus back to what opened it.
    key(document.activeElement, 'Escape');
    assert.deepEqual(seen, []);
    assert.equal(drawer.isOpen(), false);
    assert.equal(closed, 1);
    none(host.querySelector('.preview-drawer'));
    assert.equal(host.classList.contains(HOST_CLASS), false);
    same(document.activeElement, host.querySelector('.send'), 'focus goes back to the opener');

    // Closed, the drawer no longer listens: Escape is the chat's again.
    key(document.activeElement, 'Escape');
    assert.deepEqual(seen, ['chat:false', 'workspace']);
  } finally {
    drawer.destroy();
    document.removeEventListener('keydown', chatEscape, true);
    document.removeEventListener('keydown', workspaceEscape);
  }
});

test('tab close buttons, Delete, arrows and the drawer Close behave as tabs', () => {
  reset();
  const { host } = makeHost();
  let closed = 0;
  const drawer = createPreviewDrawer(host, { onClose: () => { closed++; }, hostClass: HOST_CLASS });
  for (const id of ['a', 'b', 'c', 'd']) drawer.open({ id, title: id.toUpperCase(), body: doc(id) });

  // Arrows move and select (wrapping), Home / End jump.
  tabs(host)[3].focus();
  key(document.activeElement, 'ArrowRight');
  assert.equal(drawer.activeId(), 'a');
  same(document.activeElement, tabs(host)[0]);
  key(document.activeElement, 'ArrowLeft');
  assert.equal(drawer.activeId(), 'd');
  key(document.activeElement, 'Home');
  assert.equal(drawer.activeId(), 'a');
  key(document.activeElement, 'End');
  assert.equal(drawer.activeId(), 'd');

  // A tab's own close button closes that tab only, selected or not.
  const closeOf = (i) => host.querySelectorAll('.preview-drawer-tab-close')[i];
  closeOf(1).click();
  assert.deepEqual(drawer.ids(), ['a', 'c', 'd']);
  assert.equal(drawer.activeId(), 'd', 'closing another tab keeps the selection');
  assert.equal(closeOf(2).tabIndex, 0, 'only the selected tab’s ✕ is a tab stop');
  assert.deepEqual([...host.querySelectorAll('.preview-drawer-tab-close')].map((b) => b.tabIndex), [-1, -1, 0]);

  // Delete on the focused tab closes it; the tab before it takes over when it was the last.
  tabs(host)[2].focus();
  key(document.activeElement, 'Delete');
  assert.deepEqual(drawer.ids(), ['a', 'c']);
  assert.equal(drawer.activeId(), 'c');
  same(document.activeElement, tabs(host)[1]);

  // close(id) from code; an unknown id is a no-op.
  assert.equal(drawer.close('nope'), false);
  assert.equal(drawer.close('a'), true);
  assert.deepEqual(drawer.ids(), ['c']);
  assert.equal(closed, 0);

  // Closing the last tab closes the drawer once.
  closeOf(0).click();
  assert.equal(drawer.isOpen(), false);
  assert.equal(closed, 1);
  none(host.querySelector('.preview-drawer'));

  // It opens again on demand; the drawer's Close closes every tab at once.
  drawer.open({ id: 'x', title: 'X', body: doc('x') });
  drawer.open({ id: 'y', title: 'Y', body: doc('y') });
  assert.ok(host.classList.contains(HOST_CLASS));
  host.querySelector('.preview-drawer-close').click();
  assert.equal(drawer.isOpen(), false);
  assert.equal(closed, 2);
  assert.equal(drawer.closeAll(), false, 'nothing left to close');
  assert.equal(closed, 2);

  // After destroy() nothing opens and the window listeners are gone.
  drawer.open({ id: 'z', title: 'Z', body: doc('z') });
  drawer.destroy();
  assert.equal(closed, 3);
  none(drawer.open({ id: 'w', title: 'W' }), 'a destroyed drawer opens nothing');
  none(host.querySelector('.preview-drawer'));
});

test('the close buttons and the resize handle have an accessible name in every locale', () => {
  for (const locale of Object.keys(i18n.LOCALES)) {
    reset();
    i18n.setLocale(locale);
    const { host } = makeHost();
    const drawer = createPreviewDrawer(host);
    drawer.open({ id: 'f', title: 'ai/reports/check.sql', body: doc('select 1') });
    drawer.open({ id: 'g', title: 'notes.md', body: doc('# notes') });
    const closeBtn = host.querySelector('.preview-drawer-close');
    const handle = handleOf(host);
    const tabCloses = [...host.querySelectorAll('.preview-drawer-tab-close')];

    const close = i18n.t('previewDrawer.close');
    const resize = i18n.t('previewDrawer.resize');
    for (const [name, text] of [['close', close], ['resize', resize]]) {
      assert.ok(text && !text.startsWith('previewDrawer.'), `${locale}: previewDrawer.${name} is defined`);
      assert.ok(Object.hasOwn(i18n.LOCALES[locale], `previewDrawer.${name}`), `${locale}: previewDrawer.${name} is its own string`);
    }
    assert.ok(Object.hasOwn(i18n.LOCALES[locale], 'previewDrawer.closeTab'), `${locale}: previewDrawer.closeTab is its own string`);
    assert.match(i18n.LOCALES[locale]['previewDrawer.closeTab'], /\{title\}/, `${locale}: closeTab keeps {title}`);
    assert.equal(closeBtn.getAttribute('aria-label'), close);
    assert.equal(closeBtn.title, close);
    assert.equal(handle.getAttribute('aria-label'), resize);
    assert.deepEqual(tabCloses.map((b) => b.getAttribute('aria-label')), [
      i18n.t('previewDrawer.closeTab', { title: 'ai/reports/check.sql' }),
      i18n.t('previewDrawer.closeTab', { title: 'notes.md' }),
    ]);
    for (const b of tabCloses) {
      assert.ok(b.getAttribute('aria-label').includes(b.parentElement.querySelector('[role="tab"]').textContent),
        `${locale}: a tab's close button names its tab`);
    }
    // Every control that is a button or the separator has a non-empty name; the icons are hidden.
    for (const el of host.querySelectorAll('.preview-drawer button, .preview-drawer [role="separator"]')) {
      const name = el.getAttribute('aria-label') || el.textContent.trim();
      assert.ok(name, `${locale}: ${el.className} has an accessible name`);
    }
    for (const svg of host.querySelectorAll('.preview-drawer svg')) assert.equal(svg.getAttribute('aria-hidden'), 'true');
    if (locale !== 'en') {
      assert.notEqual(close, i18n.LOCALES.en['previewDrawer.close'], `${locale}: translated`);
      assert.notEqual(resize, i18n.LOCALES.en['previewDrawer.resize'], `${locale}: translated`);
    }
    drawer.destroy();
  }
  i18n.setLocale('en');
});

test('labels follow a language switch under an open drawer', () => {
  reset();
  const { host } = makeHost();
  const drawer = createPreviewDrawer(host);
  drawer.open({ id: 'a', title: 'A', body: doc('a') });
  assert.equal(host.querySelector('.preview-drawer-close').getAttribute('aria-label'), 'Close preview');
  i18n.setLocale('uk');
  document.dispatchEvent(new CustomEvent('tiptask:reload'));
  assert.equal(host.querySelector('.preview-drawer-close').getAttribute('aria-label'), i18n.LOCALES.uk['previewDrawer.close']);
  assert.equal(handleOf(host).getAttribute('aria-label'), i18n.LOCALES.uk['previewDrawer.resize']);
  assert.equal(host.querySelector('.preview-drawer-tab-close').getAttribute('aria-label'), 'Закрити вкладку «A»');
  drawer.destroy();
  i18n.setLocale('en');
});

test('styles.css lays the drawer out beside the chat, and over it at phone width', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `${selector} is styled`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(block('.preview-drawer'), /width:\s*var\(--preview-drawer-width/);
  assert.match(block('.preview-drawer-panel'), /overflow:\s*auto/, 'each tab body scrolls');
  assert.match(block('.preview-drawer-resize'), /cursor:\s*col-resize/);
  assert.match(block('.task-chat-panel.task-chat-panel--with-drawer'), /display:\s*grid/, 'the chat panel splits');
  // (TPT9408) The standalone window fills the whole app window while a document is open.
  const full = block('.task-chat-modal > .task-chat-panel--with-drawer');
  assert.match(full, /width:\s*100%/, 'the standalone window takes the full width');
  assert.match(full, /height:\s*100%/, 'and the full height');
  assert.match(full, /border-radius:\s*0/, 'edge to edge: no card corners');
  assert.doesNotMatch(css, /min\(1440px/, 'no fixed widened window any more');
  assert.match(block('.task-chat-panel--embedded.task-chat-panel--with-drawer'), /grid-template-rows/, 'the workspace pane splits');
  // The slim column gets the compact composer through a container query on its own width.
  assert.match(css, /\.task-chat-panel--with-drawer > \.task-chat-scroll,\s*\.task-chat-panel--with-drawer > \.task-chat-footer \{ container: task-chat-column \/ inline-size; \}/);
  const slim = css.match(/@container task-chat-column \(max-width: 36rem\) \{[^@]*?\n {2}\}/);
  assert.ok(slim, 'a slim-column block');
  for (const rule of ['.task-chat-hint { display: none; }', '.task-chat-embed-slot .embed-menu-label { display: none; }', '.task-chat-selector-slot { flex: 1; }']) {
    assert.ok(slim[0].includes(rule), `slim column: ${rule}`);
  }
  const phone = css.match(/@media \(max-width: 640px\) \{\s*\.preview-drawer,[^@]*/);
  assert.ok(phone, 'a phone-width block for the drawer');
  assert.match(phone[0], /inset:\s*0/, 'at ≤ 640 px the drawer covers the chat');
  assert.match(phone[0], /\.preview-drawer-resize \{ display: none; \}/, 'with nothing to resize');
  // A backdrop would block the chat: the drawer has none.
  assert.equal(/\.preview-drawer-backdrop/.test(css), false);
});
