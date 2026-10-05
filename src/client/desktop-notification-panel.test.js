import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
const sent = [];
let listener = null;
win.electronAPI = {
  onDesktopNotificationList: (cb) => { listener = cb; return () => {}; },
  desktopNotificationListAction: (action, id) => sent.push([action, id]),
};
await import('./desktop-notification-panel.js');
const { setLocale } = await import('./i18n.js');

const entries = (n) => Array.from({ length: n }, (_, i) => ({ id: String(n - i), title: `P${(n - i) % 2 ? 'A' : 'B'} · T${n - i}`, body: 'b', category: 'attention' }));
const $ = (sel) => document.querySelector(sel);

test('full list shows every entry and routes per-entry actions back to main', () => {
  setLocale('en');
  assert.equal(typeof listener, 'function');
  listener('update', entries(3));
  assert.equal($('#tt-desktop-notif-panel'), null, 'updates alone never open the list');
  listener('open', entries(12));
  assert.equal(document.querySelectorAll('#tt-desktop-notif-panel .tt-notif-card').length, 12);
  assert.equal($('.tt-dnp-count').textContent, '12 Notifications');
  assert.equal($('.tt-dnp-empty').hidden, true);
  $('.tt-notif-card[data-tag="7"]').click();
  $('.tt-notif-card[data-tag="6"] .tt-notif-card-close').click();
  $('.tt-dnp-clear').click();
  assert.deepEqual(sent.splice(0), [['click', '7'], ['close', '6'], ['clear-all', undefined]]);
});

test('expand/collapse toggles full window height and labels', () => {
  const panel = $('#tt-desktop-notif-panel');
  const toggle = $('.tt-dnp-toggle');
  assert.equal(panel.classList.contains('is-expanded'), false);
  assert.equal(toggle.getAttribute('aria-label'), 'Expand to full height');
  toggle.click();
  assert.equal(panel.classList.contains('is-expanded'), true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Collapse');
  toggle.click();
  assert.equal(panel.classList.contains('is-expanded'), false);
});

test('live updates, Ukrainian labels, empty state and closing', () => {
  setLocale('uk');
  listener('update', entries(5));
  assert.equal(document.querySelectorAll('.tt-dnp-list .tt-notif-card').length, 5);
  assert.equal($('.tt-dnp-count').textContent, '5 сповіщень');
  assert.equal($('.tt-dnp-toggle').getAttribute('aria-label'), 'Розгорнути на всю висоту');
  listener('update', []);
  assert.equal($('.tt-dnp-empty').hidden, false);
  assert.equal($('.tt-dnp-empty').textContent, 'Немає сповіщень');
  assert.equal($('.tt-dnp-clear').hidden, true);
  $('.tt-dnp-close').click();
  assert.equal($('#tt-desktop-notif-panel'), null);
  assert.deepEqual(sent.splice(0), [['panel-closed', undefined]]);
  listener('open', entries(2));
  listener('close', []);
  assert.equal($('#tt-desktop-notif-panel'), null, 'main can close a list superseded by another window');
  setLocale('en');
});
