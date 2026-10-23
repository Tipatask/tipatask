import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { buildTaskModeOptions, buildProjectModeOptions } from './permission-mode.js';
import { renderPermissionModeSelect, bindPermissionModeSelect } from './permission-mode-select.js';
import { t } from './i18n.js';

function harness(tc, { options = buildTaskModeOptions(null, 'auto', t), value = '', height = 700 } = {}) {
  const window = new Window({ width: 1280, height });
  tc.after(() => window.happyDOM.abort());
  window.document.body.innerHTML = `<form><label for="mode">Permission mode</label><div id="host">${renderPermissionModeSelect({ name: 'mode', options, value, t })}</div><button id="next">Next</button></form>`;
  const host = window.document.getElementById('host');
  const changes = [];
  const control = bindPermissionModeSelect(host, value => changes.push(value));
  tc.after(() => control.destroy());
  const trigger = host.querySelector('button');
  const menu = host.querySelector('[role="listbox"]');
  const row = value => Array.from(menu.children).find(row => row.dataset.value === value);
  const key = key => window.document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { window, host, trigger, menu, row, key, changes, control };
}

test('clicking a row updates icon, label, hint, form value and ARIA selection, then emits the value once', tc => {
  const { window, host, trigger, menu, row, changes, control } = harness(tc);
  const nativeChanges = [];
  host.addEventListener('change', event => nativeChanges.push(event.target.value));
  assert.equal(menu.hidden, true);
  assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(trigger.getAttribute('aria-controls'), menu.id);
  assert.equal(menu.getAttribute('aria-labelledby'), trigger.id);
  assert.ok(trigger.querySelector('svg.permission-mode-icon--inherited'));
  assert.equal(trigger.querySelector('svg').outerHTML, row('').querySelector('svg').outerHTML);
  trigger.click();
  assert.equal(menu.hidden, false);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  row('auto').querySelector('svg path').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(changes, ['auto']);
  assert.deepEqual(nativeChanges, ['auto']);
  assert.equal(control.value, 'auto');
  assert.equal(new window.FormData(host.closest('form')).get('mode'), 'auto');
  assert.match(trigger.textContent, /Auto mode/);
  assert.ok(trigger.querySelector('svg.permission-mode-icon--auto'));
  assert.equal(trigger.querySelector('svg').outerHTML, row('auto').querySelector('svg').outerHTML);
  assert.match(window.document.getElementById(trigger.getAttribute('aria-describedby')).textContent, /The agent judges each action/);
  assert.equal(row('auto').getAttribute('aria-selected'), 'true');
  assert.equal(row('').getAttribute('aria-selected'), 'false');
  assert.equal(menu.hidden, true);
  assert.equal(window.document.activeElement, trigger);
  trigger.click(); row('auto').click();
  assert.deepEqual(changes, ['auto'], 'reselecting is not a change');
  control.value = '';
  assert.equal(control.value, '');
  assert.deepEqual(changes, ['auto'], 'programmatic rollback is silent');
});

test('keyboard navigation skips disabled Not set, wraps, supports Home/End and commits only on Enter/Space', tc => {
  const { window, trigger, row, key, changes, control } = harness(tc, { options: buildProjectModeOptions(null, t) });
  trigger.focus(); key('ArrowDown');
  assert.equal(window.document.activeElement, row('plan'));
  key('ArrowUp'); assert.equal(window.document.activeElement, row('bypass'));
  key('Home'); assert.equal(window.document.activeElement, row('plan'));
  key('ArrowDown'); assert.equal(window.document.activeElement, row('auto'));
  assert.deepEqual(changes, []);
  key('Enter'); assert.equal(control.value, 'auto');
  assert.equal(window.document.activeElement, trigger);
  key(' '); key('End'); key(' ');
  assert.equal(control.value, 'bypass');
  assert.deepEqual(changes, ['auto', 'bypass']);
  trigger.click(); row('').click();
  assert.equal(control.value, 'bypass', 'placeholder cannot be selected');
});

test('Escape cancels without bubbling to the surrounding dialog; Tab, outside pointer and focus dismiss', tc => {
  const { window, host, trigger, menu, key, changes, control } = harness(tc, { value: 'auto' });
  let escapes = 0;
  window.document.addEventListener('keydown', event => { if (event.key === 'Escape') escapes++; });
  trigger.focus(); key('Enter'); key('Home'); key('Escape');
  assert.equal(menu.hidden, true);
  assert.equal(window.document.activeElement, trigger);
  assert.equal(control.value, 'auto');
  assert.equal(escapes, 0);
  key('Escape'); assert.equal(escapes, 1, 'closed popup leaves Escape to its dialog');
  trigger.click(); key('Tab'); assert.equal(menu.hidden, true);
  trigger.click(); window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(menu.hidden, true);
  trigger.click(); window.document.getElementById('next').focus(); assert.equal(menu.hidden, true);
  assert.deepEqual(changes, []);
  control.disabled = true; trigger.click(); assert.equal(menu.hidden, true);
  assert.equal(new window.FormData(host.closest('form')).has('mode'), false);
  control.disabled = false; trigger.click(); assert.equal(menu.hidden, false);
  control.destroy(); trigger.click(); assert.equal(menu.hidden, true);
});

test('render escapes field names, labels and hints; listbox ids are unique and empty options stay disabled', tc => {
  const window = new Window();
  tc.after(() => window.happyDOM.abort());
  const args = { name: 'mode"<', options: [{ value: 'x"<', label: '<img src=x onerror=alert(1)>', hint: '<script>bad</script>', selected: true }], t };
  window.document.body.innerHTML = renderPermissionModeSelect(args) + renderPermissionModeSelect(args);
  assert.equal(window.document.querySelector('img, script'), null);
  assert.equal(window.document.querySelector('input').name, args.name);
  assert.equal(window.document.querySelector('input').value, args.options[0].value);
  assert.equal(window.document.querySelector('.permission-mode-select-label').textContent, args.options[0].label);
  const menus = window.document.querySelectorAll('[role="listbox"]');
  assert.notEqual(menus[0].id, menus[1].id);
  window.document.body.innerHTML = renderPermissionModeSelect({ name: 'empty', options: [], t });
  assert.equal(window.document.querySelector('button').disabled, true);
  assert.match(window.document.querySelector('button').textContent, /Not set/);
});

// (TPT9084) Geometry: happy-dom lays nothing out, so the trigger rect and the menu's content
// height are stubbed; the viewport comes from the Window size.
function placed(tc, rect) {
  const h = harness(tc);
  h.root = h.host.querySelector('[data-permission-mode-select]');
  h.rect = rect;
  h.trigger.getBoundingClientRect = () => h.rect;
  Object.defineProperty(h.menu, 'scrollHeight', { configurable: true, get: () => 240 });
  h.scroll = () => h.window.document.body.dispatchEvent(new h.window.Event('scroll'));
  h.resize = () => h.window.dispatchEvent(new h.window.Event('resize'));
  h.box = () => [h.menu.style.left, h.menu.style.width, h.menu.style.top, h.menu.style.bottom, h.menu.style.maxHeight];
  return h;
}

test('the open listbox moves to <body>, is placed from the trigger, follows scroll and resize, and comes back on close', tc => {
  const h = placed(tc, { left: 100, top: 300, right: 400, bottom: 340, width: 300, height: 40 });
  const { window, root, trigger, menu, row, key } = h;
  assert.equal(window.innerHeight, 700);
  trigger.click();
  assert.equal(menu.parentElement, window.document.body, 'open menu is a body child');
  assert.equal(menu.dataset.portaled, '1');
  assert.equal(menu.style.position, '', 'fixed positioning comes from the data-portaled rule, not inline');
  assert.deepEqual(h.box(), ['100px', '300px', '344px', 'auto', '348px'], 'below the trigger: 4px gap, room to the viewport edge minus 8px');
  assert.equal(window.document.activeElement, row(''), 'focus lands on the current row inside the portaled menu');
  // The host scrolls the trigger down to 600–640: 48px left below, 588px above → flipped above it.
  h.rect = { ...h.rect, top: 600, bottom: 640 };
  h.scroll();
  assert.deepEqual(h.box(), ['100px', '300px', 'auto', '104px', '588px']);
  // A taller window has room below again.
  window.innerHeight = 1000;
  h.resize();
  assert.deepEqual(h.box(), ['100px', '300px', '644px', 'auto', '348px']);
  // A cramped viewport keeps the 96px floor and lets the list scroll inside the menu.
  window.innerHeight = 140;
  h.rect = { ...h.rect, top: 20, bottom: 60 };
  h.resize();
  assert.deepEqual(h.box(), ['100px', '300px', '64px', 'auto', '96px']);
  key('Escape');
  assert.equal(menu.hidden, true);
  assert.equal(menu.parentElement, root, 'closed menu is back in its widget');
  assert.equal(root.lastElementChild, menu);
  assert.equal(menu.dataset.portaled, undefined);
  assert.equal(menu.getAttribute('style'), null, 'inline placement cleared');
  assert.equal(window.document.activeElement, trigger);
  h.rect = { ...h.rect, top: 300, bottom: 340 };
  h.scroll(); h.resize();
  assert.equal(menu.getAttribute('style'), null, 'closed menu no longer listens to scroll or resize');
});

test('a portaled listbox keeps keyboard, click and dismissal working, and closes when its trigger disappears', tc => {
  const h = placed(tc, { left: 100, top: 300, right: 400, bottom: 340, width: 300, height: 40 });
  const { window, host, root, trigger, menu, row, key, changes, control } = h;
  trigger.focus(); key('ArrowDown');
  assert.equal(menu.parentElement, window.document.body);
  key('ArrowDown'); assert.equal(window.document.activeElement, row('plan'), 'arrow focus moves between rows outside the widget');
  key('ArrowDown'); key('Enter');
  assert.equal(control.value, 'auto');
  assert.equal(window.document.activeElement, trigger);
  assert.equal(menu.parentElement, root);
  trigger.click();
  row('bypass').querySelector('svg').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(changes, ['auto', 'bypass'], 'row clicks reach the widget from <body>');
  trigger.click();
  window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(menu.hidden, true, 'pointer outside the trigger and the menu dismisses');
  trigger.click();
  row('plan').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(menu.hidden, false, 'pointer on a portaled row is not outside');
  window.document.getElementById('next').focus();
  assert.equal(menu.hidden, true, 'focus leaving both the widget and the menu dismisses');
  // The trigger's host got hidden (a closed Settings panel): the next reposition retires the menu.
  trigger.click();
  trigger.getClientRects = () => [];
  h.scroll();
  assert.equal(menu.hidden, true);
  assert.equal(menu.parentElement, root);
  trigger.getClientRects = () => [{}];
  // Destroy while open: the menu leaves <body>; with the widget already gone it is dropped.
  trigger.click();
  host.innerHTML = '';
  control.destroy();
  assert.equal(menu.isConnected, false);
  assert.equal(menu.dataset.portaled, undefined);
});

test('rebinding a root cleans up the prior handler', tc => {
  const { host, trigger, row, changes, control: previous } = harness(tc);
  const latest = [];
  const control = bindPermissionModeSelect(host.querySelector('[data-permission-mode-select]'), value => latest.push(value));
  tc.after(() => control.destroy());
  previous.destroy(); // Stale cleanup must not close or unbind the replacement.
  trigger.click(); row('plan').click();
  assert.deepEqual(changes, []);
  assert.deepEqual(latest, ['plan']);
});
