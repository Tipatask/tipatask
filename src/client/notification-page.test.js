// (TPT484) The always-on-top banner and the in-app panel render the same compact page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const browser = new Window();
globalThis.document = browser.document;
globalThis.requestAnimationFrame = (cb) => cb();
let onState;
const bannerActs = [];
globalThis.window = { desktopNotifications: { onState: (cb) => { onState = cb; }, act: (id, action) => bannerActs.push([action, id]) } };
const { renderNotificationPage, splitNotificationTitle } = await import('./notification-page.js');
const { setLocale } = await import('./i18n.js');
await import('./desktop-notifications.js');

const entries = Array.from({ length: 6 }, (_, i) => ({ id: String(6 - i), tag: `TPT${6 - i}`, title: `Title ${6 - i}`,
  body: '<b>plain</b>', category: i % 2 ? 'completed' : 'attention', locale: 'en', projectPath: '/a' }));

// Structure only: element tags, classes, text and the hidden flags.
const shape = (el) => [el.tagName, el.className, el.hidden, el.children.length ? '' : el.textContent,
  [...el.children].map(shape)];

test('banner and in-app host render identical pages for the same alerts', () => {
  const inApp = document.createElement('div');
  document.body.appendChild(inApp);
  const appActs = [];
  renderNotificationPage(inApp, entries, (id, action) => appActs.push([action, id]));
  onState({ entries, theme: { bg: '#123456' } });
  const banner = document.body.querySelector(':scope > .tt-notif-page');
  // Same cards; only the header action (Hide vs Clear All) and the footer toggle differ (TPT505).
  assert.deepEqual(shape(banner.querySelector('.tt-notif-page-cards')),
    shape(inApp.querySelector('.tt-notif-page-cards')));
  assert.equal(inApp.querySelector('.tt-notif-page-header button').className, 'tt-notif-page-clear');
  assert.equal(inApp.querySelector('.tt-notif-page-ontop').hidden, true, 'in-app stack has no on-top toggle');
  assert.equal(banner.querySelector('.tt-notif-page-header button').className, 'tt-notif-page-hide');
  assert.equal(banner.querySelector('.tt-notif-page-clear'), null, 'no Clear All on the banner');
  assert.equal(banner.querySelector('.tt-notif-page-ontop').hidden, false);
  assert.equal(banner.querySelectorAll('.tt-notif-card').length, 5);
  assert.equal(banner.querySelector('.tt-notif-page-more').hidden, false);
  assert.equal(banner.querySelector('b'), null, 'content stays plain text');
  assert.equal(document.documentElement.style.getPropertyValue('--tt-notif-bg'), '#123456');
  banner.querySelector('[data-id="5"]').click();
  inApp.querySelector('[data-id="5"] .tt-notif-card-close').click();
  assert.deepEqual(bannerActs, [['click', '5']]);
  assert.deepEqual(appActs, [['close', '5']]);
  // Keyed reuse: an arrival never re-creates a visible card.
  const kept = banner.querySelector('[data-id="4"]');
  onState({ entries: [{ id: '7', tag: 'TPT7', title: 'New', locale: 'en' }, ...entries], theme: null });
  assert.equal(banner.querySelector('[data-id="4"]'), kept);
  assert.equal(document.documentElement.style.getPropertyValue('--tt-notif-bg'), '');
  onState({ entries: [], theme: null });
  assert.equal(document.body.querySelector(':scope > .tt-notif-page'), null);
});

test('splitNotificationTitle separates the task-key prefix from the title text', () => {
  assert.deepEqual(splitNotificationTitle('CMP106: Give task sessions'), { key: 'CMP106', text: 'Give task sessions' });
  assert.deepEqual(splitNotificationTitle('Tipatask · TPT498: Redesign: cards'),
    { key: 'Tipatask · TPT498', text: 'Redesign: cards' });
  assert.deepEqual(splitNotificationTitle('Merge: 3 branches'), { key: '', text: 'Merge: 3 branches' });
  assert.deepEqual(splitNotificationTitle(undefined), { key: '', text: '' });
});

test('cards carry data-category and key/title/body spans that survive repeat pushes', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const one = { id: '1', tag: 'CMP106', title: 'CMP106: <i>Give</i> sessions', body: '<b>Plan</b> ready.', category: 'attention' };
  renderNotificationPage(host, [one], () => {});
  const card = host.querySelector('[data-id="1"]');
  assert.equal(card.dataset.category, 'attention');
  const key = card.querySelector('.tt-notif-card-title > .tt-notif-key');
  const title = card.querySelector('.tt-notif-card-title > .tt-notif-title');
  const body = card.querySelector('.tt-notif-card-body > .tt-notif-body');
  assert.equal(key.textContent, 'CMP106');
  assert.equal(key.hidden, false);
  assert.equal(title.textContent, '<i>Give</i> sessions', 'plain text');
  assert.equal(body.textContent, '<b>Plan</b> ready.', 'plain text');
  assert.equal(card.querySelector('i, b'), null);
  assert.equal(card.querySelector('.tt-notif-card-icon').textContent, '!');

  // Repeat push for the same id: same nodes, refreshed text and category.
  renderNotificationPage(host, [{ ...one, title: 'Done now', body: '', category: 'completed' }], () => {});
  assert.equal(host.querySelector('[data-id="1"]'), card);
  assert.equal(card.querySelector('.tt-notif-key'), key);
  assert.equal(card.querySelector('.tt-notif-title'), title);
  assert.equal(card.querySelector('.tt-notif-body'), body);
  assert.equal(card.dataset.category, 'completed');
  assert.equal(key.hidden, true);
  assert.equal(title.textContent, 'Done now');
  assert.equal(body.textContent, '');

  renderNotificationPage(host, [{ ...one, category: null }], () => {});
  assert.equal(card.dataset.category, 'info');
  host.remove();
});

test('(TPT505) header action: Clear All by default, Hide on request; footer "Show" toggle acts on-top-off', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const acts = [];
  const act = (id, action) => acts.push([action, id]);
  const two = entries.slice(0, 2);
  setLocale('en');
  const page = renderNotificationPage(host, two, act);
  assert.equal(page.querySelector('.tt-notif-page-clear').textContent, 'Clear all');
  assert.equal(page.querySelector('.tt-notif-page-footer').hidden, true, 'one page, no toggle: no footer');
  page.querySelector('.tt-notif-page-clear').click();

  renderNotificationPage(host, two, act, { headerAction: 'hide', onTopToggle: true });
  const hide = page.querySelector('.tt-notif-page-hide');
  assert.equal(hide.textContent, 'Hide');
  assert.equal(page.querySelector('.tt-notif-page-clear'), null);
  assert.equal(page.querySelector('.tt-notif-page-footer').hidden, false);
  const toggle = page.querySelector('.tt-notif-page-ontop');
  const input = toggle.querySelector('input[type="checkbox"]');
  assert.equal(toggle.hidden, false);
  assert.equal(input.checked, true);
  assert.equal(toggle.textContent, 'Show');
  assert.equal(toggle.title, 'Show notifications on top of other apps');
  assert.equal(page.querySelector('.tt-notif-page-more').hidden, true);
  hide.click();
  input.checked = false;
  input.dispatchEvent(new browser.Event('change'));
  assert.deepEqual(acts, [['clear-all', null], ['hide', null], ['on-top-off', null]]);

  setLocale('uk');
  renderNotificationPage(host, two, act, { headerAction: 'hide', onTopToggle: true });
  assert.equal(page.querySelector('.tt-notif-page-hide').textContent, 'Сховати');
  assert.equal(toggle.textContent, 'Показувати');
  assert.equal(input.checked, true, 'a re-render shows the live (on) state');
  renderNotificationPage(host, two, act);
  assert.equal(page.querySelector('.tt-notif-page-clear').textContent, 'Очистити всі');
  setLocale('en');
  host.remove();
});
