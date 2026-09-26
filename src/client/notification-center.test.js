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

test('pushNotification evicts the oldest entry past the cap', () => {
  for (let i = 1; i <= 6; i++) pushNotification({ tag: `C${i}`, title: `Task ${i}` });
  const entries = getNotificationEntries();
  assert.equal(entries.length, 5); // MAX_ENTRIES
  assert.deepEqual(entries.map((e) => e.tag), ['C6', 'C5', 'C4', 'C3', 'C2']); // C1 evicted (oldest)
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
