import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Model-only tests, deliberately with NO `document` global at all — proves the module never
// throws when imported/used outside a browser (e.g. this test file itself, or a future
// server-side import), same guarantee notifications.js's own tests hold for localStorage.
const {
  pushNotification,
  dismissNotification,
  clearAllNotifications,
  getNotificationEntries,
} = await import('./notification-center.js');

beforeEach(() => {
  clearAllNotifications();
});

test('pushNotification adds an entry readable via getNotificationEntries', () => {
  pushNotification({ tag: 'C1', title: 'Title', body: 'Body', category: 'attention' });
  const entries = getNotificationEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tag, 'C1');
  assert.equal(entries[0].title, 'Title');
  assert.equal(entries[0].body, 'Body');
  assert.equal(entries[0].category, 'attention');
});

test('pushNotification is a no-op without a tag', () => {
  pushNotification({ title: 'No tag' });
  assert.equal(getNotificationEntries().length, 0);
});

test('pushNotification upserts by tag instead of duplicating', () => {
  pushNotification({ tag: 'C1', title: 'First' });
  pushNotification({ tag: 'C1', title: 'Second' });
  const entries = getNotificationEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'Second');
});

test('pushNotification moves an upserted entry back to the top', () => {
  pushNotification({ tag: 'C1', title: 'One' });
  pushNotification({ tag: 'C2', title: 'Two' });
  pushNotification({ tag: 'C1', title: 'One again' }); // re-push C1 — should jump back to index 0
  const entries = getNotificationEntries();
  assert.deepEqual(entries.map((e) => e.tag), ['C1', 'C2']);
});

test('pushNotification retains every entry beyond five', () => {
  for (let i = 1; i <= 6; i++) pushNotification({ tag: `C${i}`, title: `Task ${i}` });
  const entries = getNotificationEntries();
  assert.equal(entries.length, 6);
  assert.deepEqual(entries.map((e) => e.tag), ['C6', 'C5', 'C4', 'C3', 'C2', 'C1']);
});

test('dismissNotification removes only the matching tag', () => {
  pushNotification({ tag: 'C1', title: 'One' });
  pushNotification({ tag: 'C2', title: 'Two' });
  dismissNotification('C1');
  const entries = getNotificationEntries();
  assert.deepEqual(entries.map((e) => e.tag), ['C2']);
});

test('dismissNotification on an unknown/falsy tag is a harmless no-op', () => {
  pushNotification({ tag: 'C1', title: 'One' });
  dismissNotification('nonexistent');
  dismissNotification(null);
  dismissNotification(undefined);
  assert.equal(getNotificationEntries().length, 1);
});

test('clearAllNotifications empties the stack', () => {
  pushNotification({ tag: 'C1', title: 'One' });
  pushNotification({ tag: 'C2', title: 'Two' });
  clearAllNotifications();
  assert.equal(getNotificationEntries().length, 0);
});

test('getNotificationEntries returns a copy, not the live internal array', () => {
  pushNotification({ tag: 'C1', title: 'One' });
  const entries = getNotificationEntries();
  entries.push({ tag: 'fake', title: 'injected' });
  assert.equal(getNotificationEntries().length, 1); // internal state unaffected by the mutation above
});

// Exercise actual event propagation: closing must not activate the card underneath.
test('DOM click and close remove only their own cards, retaining sibling nodes', async () => {
  const { Window } = await import('happy-dom');
  const browser = new Window();
  globalThis.document = browser.document;
  globalThis.requestAnimationFrame = (cb) => cb();
  try {
    let clicked = 0;
    let closed = 0;
    pushNotification({ tag: 'a', title: '<b>plain text</b>', onClick: () => clicked++ });
    pushNotification({ tag: 'b', onClick: () => clicked++, onDismiss: () => closed++ });
    pushNotification({ tag: 'c', onClick: () => { clicked++; pushNotification({ tag: 'c', title: 'new event' }); } });
    const first = document.querySelector('[data-tag="a"]');
    document.querySelector('[data-tag="b"] .tt-notif-card-close').click();
    assert.equal(clicked, 0);
    assert.equal(closed, 1);
    assert.deepEqual(getNotificationEntries().map(e => e.tag), ['c', 'a']);
    document.querySelector('[data-tag="c"]').click();
    assert.equal(clicked, 1);
    assert.equal(getNotificationEntries()[0].title, 'new event');
    assert.equal(document.querySelector('[data-tag="a"]'), first);
    assert.equal(first.querySelector('b'), null);
    first.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(clicked, 2);
    assert.deepEqual(getNotificationEntries().map(e => e.tag), ['c']);
  } finally {
    clearAllNotifications();
    delete globalThis.document;
    delete globalThis.requestAnimationFrame;
    browser.happyDOM.abort();
  }
});
