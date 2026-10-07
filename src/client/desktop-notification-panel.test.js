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
  const chevron = () => toggle.querySelector('svg polyline')?.getAttribute('points');
  assert.equal(chevron(), '6 15 12 9 18 15', 'collapsed shows a chevron pointing up');
  assert.equal(toggle.textContent.trim(), '', 'no ⤒/⤓ text glyphs');
  toggle.click();
  assert.equal(panel.classList.contains('is-expanded'), true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Collapse');
  assert.equal(chevron(), '6 9 12 15 18 9', 'expanded shows a chevron pointing down');
  toggle.click();
  assert.equal(panel.classList.contains('is-expanded'), false);
  assert.equal(chevron(), '6 15 12 9 18 15');
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

test('an open while the list is mounted re-renders it in place without moving cards', () => {
  listener('open', entries(3));
  const panel = $('#tt-desktop-notif-panel');
  const first = $('.tt-notif-card[data-tag="3"]');
  const moved = [];
  const insertBefore = panel._list.insertBefore.bind(panel._list);
  panel._list.insertBefore = (el, ref) => { moved.push(el.dataset.tag); return insertBefore(el, ref); };
  listener('open', entries(3));
  listener('update', entries(3));
  assert.equal(document.querySelectorAll('#tt-desktop-notif-panel').length, 1);
  assert.equal($('#tt-desktop-notif-panel'), panel);
  assert.equal($('.tt-notif-card[data-tag="3"]'), first);
  assert.deepEqual(moved, [], 'a repeat snapshot never re-inserts a card (it would cancel a click in progress)');
  listener('open', entries(4));
  assert.deepEqual(moved, ['4']);
  assert.equal([...panel._list.children].map((el) => el.dataset.tag).join(','), '4,3,2,1');
  listener('close', []);
});

test('an open before the document has a body mounts once the body exists', () => {
  const realBody = document.body;
  Object.defineProperty(document, 'body', { configurable: true, get: () => null });
  try {
    listener('open', entries(2));
    listener('update', entries(3));
    listener('open', entries(4));
    assert.equal(realBody.querySelector('#tt-desktop-notif-panel'), null);
  } finally {
    delete document.body;
  }
  assert.equal(document.body, realBody);
  document.dispatchEvent(new win.Event('DOMContentLoaded'));
  assert.equal(document.querySelectorAll('#tt-desktop-notif-panel').length, 1);
  assert.equal(document.querySelectorAll('#tt-desktop-notif-panel .tt-notif-card').length, 4, 'the latest snapshot is shown');
  // A close that overtakes the mount cancels it.
  listener('close', []);
  Object.defineProperty(document, 'body', { configurable: true, get: () => null });
  try { listener('open', entries(2)); listener('close', []); } finally { delete document.body; }
  document.dispatchEvent(new win.Event('DOMContentLoaded'));
  assert.equal($('#tt-desktop-notif-panel'), null);
});

test('the in-app stack is hidden while the full list is mounted', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /body:has\(#tt-desktop-notif-panel\) #tt-notif-stack \{ display: none; \}/);
});
