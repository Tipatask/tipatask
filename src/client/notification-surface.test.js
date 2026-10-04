// (TPT484) Shared alert identity between the in-app panel and main's always-on-top banner:
// cards mirror into main, main's surface decision picks what this window renders, and clicks /
// dismissals from either surface resolve to the same local card exactly once.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let surfaceCb = null, click = null, dismiss = null;
globalThis.window = { electronAPI: {
  notificationDelivery: 'desktop',
  getProjectPath: () => '/a',
  notify: async () => ({ ok: true }),
  pushSharedNotification: (card) => { calls.push(['push', card]); return Promise.resolve({ ok: true }); },
  dismissSharedNotification: (tag) => { calls.push(['dismiss', tag]); return Promise.resolve({ ok: true }); },
  notificationSurfaceState: () => Promise.resolve({ shared: false, active: false, entries: [] }),
  onNotificationSurface: (cb) => { surfaceCb = cb; },
  notificationSurfaceAction: (action, id) => calls.push(['action', action, id]),
  setNotificationTheme: (tokens) => calls.push(['theme', tokens]),
  onNotificationClick: (cb) => { click = cb; },
  onNotificationDismiss: (cb) => { dismiss = cb; },
} };

const center = await import('./notification-center.js');
const notifications = await import('./notifications.js?surface');
center.installNotificationSurface();
notifications.ensureNotificationBridge();

beforeEach(() => {
  center.applyNotificationSurface({ shared: false });
  center.clearAllNotifications();
  calls.length = 0;
});

test('pushNotification and dismissNotification mirror the same identity to main', () => {
  center.pushNotification({ tag: 'TPT1', title: 'Title', body: 'Body', category: 'attention' });
  const [kind, card] = calls[0];
  assert.equal(kind, 'push');
  assert.equal(card.tag, 'TPT1');
  assert.equal(card.title, 'Title');
  assert.equal(card.category, 'attention');
  assert.ok(Number.isFinite(card.seq));
  center.dismissNotification('TPT1');
  assert.deepEqual(calls.at(-1), ['dismiss', 'TPT1']);
  assert.equal(center.getNotificationEntries().length, 0);
  // Another project's card (window rebound since) is not this sender's to dismiss in main.
  calls.length = 0;
  center.dismissNotification('TPT1', '/other');
  assert.equal(calls.length, 0);
});

test('sharing turning on re-mirrors local cards oldest first, and the host sends its palette', () => {
  center.pushNotification({ tag: 'A' });
  center.pushNotification({ tag: 'B' });
  calls.length = 0;
  surfaceCb({ shared: true, active: true, entries: [] });
  assert.deepEqual(calls.filter(([k]) => k === 'push').map(([, c]) => c.tag), ['A', 'B']);
  // No DOM in this file: theme collection is skipped safely.
  surfaceCb({ shared: true, active: false, entries: [] });
  assert.equal(calls.filter(([k]) => k === 'push').length, 2, 'already shared: no re-mirror');
  assert.deepEqual(center.getNotificationSurface(), { shared: true, active: false, entries: [] });
});

test('a click routed back without a notify() callback runs the card action exactly once', () => {
  let clicked = 0;
  center.pushNotification({ tag: 'TPT2', onClick: () => clicked++ });
  click({ tag: 'TPT2', projectPath: '/a' });
  click({ tag: 'TPT2', projectPath: '/a' });
  assert.equal(clicked, 1);
  assert.equal(center.getNotificationEntries().length, 0);
});

test('a click with a notify() callback runs that callback, not the card action too', () => {
  let viaNotify = 0, viaCard = 0;
  center.pushNotification({ tag: 'TPT3', onClick: () => viaCard++ });
  let sent;
  window.electronAPI.notify = async (payload) => { sent = payload; return { ok: true }; };
  notifications.notify('T', 'B', 'TPT3', { onClick: () => viaNotify++ });
  click({ tag: 'TPT3', notificationId: sent.notificationId, projectPath: '/a' });
  assert.equal(viaNotify, 1);
  assert.equal(viaCard, 0);
  assert.equal(center.getNotificationEntries().length, 0);
});

test('closing on the other surface removes the local card; keepCard only releases', () => {
  center.pushNotification({ tag: 'TPT4' });
  dismiss({ tag: 'TPT4', projectPath: '/a', keepCard: true });
  assert.equal(center.getNotificationEntries().length, 1);
  dismiss({ tag: 'TPT4', projectPath: '/b' });
  assert.equal(center.getNotificationEntries().length, 1, 'another project is untouched');
  dismiss({ tag: 'TPT4', projectPath: '/a' });
  assert.equal(center.getNotificationEntries().length, 0);
});

test('a late removal never takes a card pushed again after it', () => {
  center.pushNotification({ tag: 'completed-TPT5' });
  const seen = calls.at(-1)[1].seq;
  center.pushNotification({ tag: 'completed-TPT5', title: 'fresh' });
  dismiss({ tag: 'completed-TPT5', projectPath: '/a', cardSeq: seen });
  assert.equal(center.getNotificationEntries()[0].title, 'fresh');
  assert.equal(center.activateLocalNotification('completed-TPT5', '/a', { upTo: seen }), false);
  assert.equal(center.removeLocalNotification('completed-TPT5', '/a', { upTo: seen + 1 }), true);
});

test('in-app panel renders main\'s page while hosting, nothing while not, local list otherwise', async () => {
  const { Window } = await import('happy-dom');
  const browser = new Window();
  globalThis.document = browser.document;
  globalThis.requestAnimationFrame = (cb) => cb();
  try {
    center.pushNotification({ tag: 'local' });
    assert.equal(document.querySelectorAll('#tt-notif-stack .tt-notif-card').length, 1);
    assert.equal(document.querySelector('.tt-notif-page').classList.contains('is-paged'), false);
    const entries = Array.from({ length: 7 }, (_, i) => ({ id: String(7 - i), tag: `T${7 - i}`, title: `T${7 - i}`, projectPath: i % 2 ? '/b' : '/a' }));
    surfaceCb({ shared: true, active: true, entries });
    assert.deepEqual([...document.querySelectorAll('.tt-notif-card')].map((c) => c.dataset.id), ['7', '6', '5', '4', '3']);
    assert.equal(document.querySelector('.tt-notif-page-more').hidden, false);
    document.querySelector('[data-id="6"]').click();
    document.querySelector('[data-id="5"] .tt-notif-card-close').click();
    document.querySelector('.tt-notif-page-more').click();
    document.querySelector('.tt-notif-page-clear').click();
    assert.deepEqual(calls.filter(([k]) => k === 'action').map(([, a, id]) => [a, id]),
      [['click', '6'], ['close', '5'], ['show-more', null], ['clear-all', null]]);
    surfaceCb({ shared: true, active: false, entries: [] });
    assert.equal(document.getElementById('tt-notif-stack'), null, 'banner holds the alerts now');
    surfaceCb({ shared: false });
    assert.equal(document.querySelectorAll('#tt-notif-stack .tt-notif-card').length, 1);
  } finally {
    center.applyNotificationSurface({ shared: false });
    center.clearAllNotifications();
    delete globalThis.document;
    delete globalThis.requestAnimationFrame;
    browser.happyDOM.abort();
  }
});
