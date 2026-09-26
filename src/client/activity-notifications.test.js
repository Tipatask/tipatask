import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// (TPT12) Same hand-mocked harness as completion-notifications.test.js — no jsdom, globals
// stubbed before the dynamic import()s below.

let mockPermission = 'granted';
let lastNotification = null;
let hasFocus = true;
let visibilityState = 'visible';
let activeElement = null;
let appNode = null;
let modalNode = null;

class MockDocument extends EventTarget {
  get visibilityState() { return visibilityState; }
  get activeElement() { return activeElement; }
  hasFocus() { return hasFocus; }
  getElementById(id) {
    if (id === 'app') return appNode;
    if (id === 'task-edit-modal') return modalNode;
    return null;
  }
}

globalThis.Notification = class MockNotification {
  constructor(title, options) { lastNotification = { title, options }; }
  set onclick(handler) { this._onclick = handler; lastNotification.onclick = handler; }
  static get permission() { return mockPermission; }
  static requestPermission() { return Promise.resolve('granted'); }
};

globalThis.CSS = { escape: (value) => String(value) };
globalThis.document = new MockDocument();
globalThis.window = {
  focus() {},
  electronAPI: { focusSelf() {} },
  TipTask: { openTerminal() {} },
};

const stateModule = await import('./state.js');
const state = stateModule.default;
const { clearDebounce } = await import('./notifications.js');
const { notifyTaskActivity, _resetActivityNotifications } = await import('./activity-notifications.js');
const { getNotificationEntries, clearAllNotifications } = await import('./notification-center.js');

function makeCard({ title = 'Task Title', containsActive = false, hover = false } = {}) {
  return {
    dataset: { status: 'in_progress' },
    querySelector(selector) {
      if (selector === '.card-title-inner') return { textContent: title };
      return null;
    },
    contains(node) { return containsActive && node === activeElement; },
    matches(selector) { return selector === ':hover' && hover; },
  };
}

function latestRow(id, over = {}) {
  return { id, title: 'New comment on TPT1', body: 'Looks good, ship it', event_type: 'comment', actor: { id: 2, name: 'Other User' }, created_at: '2026-01-01', ...over };
}

beforeEach(() => {
  mockPermission = 'granted';
  lastNotification = null;
  hasFocus = true;
  visibilityState = 'visible';
  activeElement = null;
  state.activeTerminal = null;
  state.selectedCardId = null;
  state.taskTitleById = new Map();
  state.projectName = '';
  appNode = { querySelector: () => makeCard() };
  modalNode = { hidden: true, dataset: {} };
  clearAllNotifications();
  // notifications.js's 30s per-tag debounce is module-singleton state, shared across tests in
  // this file — every test below completes tag 'activity-TPT1'.
  clearDebounce('activity-TPT1');
  _resetActivityNotifications();
});

test('notifyTaskActivity sends a notification when the task is outside focus', () => {
  hasFocus = false;
  const sent = notifyTaskActivity('TPT1', { latest: latestRow(5), taskTitle: 'Ship the thing' });
  assert.equal(sent, true);
  assert.equal(lastNotification.title, 'TPT1: Ship the thing');
  assert.equal(lastNotification.options.body, 'Looks good, ship it');
  assert.match(lastNotification.options.tag, /^activity-TPT1-\d+$/);
});

test('notifyTaskActivity is suppressed while the task is in user focus, and the ledger still records the id', () => {
  state.selectedCardId = 'TPT1';
  const sent = notifyTaskActivity('TPT1', { latest: latestRow(5), taskTitle: 'Ship the thing' });
  assert.equal(sent, false);
  assert.equal(lastNotification, null);
  // Recorded as "told" even though suppressed by focus — a later replay of the SAME row id
  // while unfocused stays silent.
  state.selectedCardId = null;
  hasFocus = false;
  assert.equal(notifyTaskActivity('TPT1', { latest: latestRow(5), taskTitle: 'Ship the thing' }), false);
  assert.equal(lastNotification, null);
});

test('notifyTaskActivity suppresses a repeat call for the same notification id (already-notified ledger)', () => {
  hasFocus = false;
  assert.equal(notifyTaskActivity('TPT1', { latest: latestRow(5) }), true);
  lastNotification = null;
  assert.equal(notifyTaskActivity('TPT1', { latest: latestRow(5) }), false);
  assert.equal(lastNotification, null);
});

test('a DIFFERENT notification id on the same task notifies again (ledger is id-keyed, not task-keyed)', () => {
  hasFocus = false;
  assert.equal(notifyTaskActivity('TPT1', { latest: latestRow(5) }), true);
  clearDebounce('activity-TPT1'); // re-arm notify()'s own per-tag debounce, same pattern as completion's test
  assert.equal(notifyTaskActivity('TPT1', { latest: latestRow(6) }), true);
});

test('double dispatch of the identical rose entry (browser mode\'s two simultaneous WS ladders, C1193) produces exactly one push', () => {
  hasFocus = false;
  const entry = { latest: latestRow(5) };
  assert.equal(notifyTaskActivity('TPT1', entry), true);
  assert.equal(notifyTaskActivity('TPT1', entry), false, 'second call for the same row id must be a no-op');
  assert.equal(getNotificationEntries().length, 1);
});

test('the in-app notification-center card is pushed under the "activity" category', () => {
  hasFocus = false;
  notifyTaskActivity('TPT1', { latest: latestRow(5), taskTitle: 'Ship the thing' });
  const entries = getNotificationEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tag, 'activity-TPT1');
  assert.equal(entries[0].category, 'activity');
});

test('no latest row — nothing to notify about, returns false without touching the ledger', () => {
  hasFocus = false;
  assert.equal(notifyTaskActivity('TPT1', {}), false);
  assert.equal(lastNotification, null);
});
