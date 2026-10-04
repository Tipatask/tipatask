import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dismissTaskNotifications, notify, clearDebounce, setNotifyEnabled } from './notifications.js';
import { pushNotification, getNotificationEntries, clearAllNotifications } from './notification-center.js';
import { maybeNotifyCompletion, forgetTaskCompletion } from './completion-notifications.js';
import { seedStatuses, resetStatuses } from './status-registry.js';
import state from './state.js';

test('completion closes every old surface, retains other projects/tasks and unread state, and obeys preferences', () => {
  let project = '/a';
  const browsers = [], ipc = [];
  const prefs = new Map();
  globalThis.localStorage = { getItem: k => prefs.get(k), setItem: (k, v) => prefs.set(k, v) };
  globalThis.window = { location: { search: '' }, focus() {}, electronAPI: {
    getProjectPath: () => project, dismissTaskNotifications: id => ipc.push([project, id]),
  } };
  globalThis.Notification = class {
    static permission = 'granted';
    constructor(title) { this.title = title; this.closed = 0; browsers.push(this); }
    close() { this.closed++; }
  };
  seedStatuses([{ name: 'working', is_in_progress: true }, { name: 'shipped', is_workflow_complete: true }]);
  state.taskActivity = new Map([['TPT483', { count: 3, ids: [1, 2, 3] }]]);
  const unread = structuredClone(state.taskActivity);
  let clicks = 0;
  function send(tag) {
    clearDebounce(tag);
    pushNotification({ tag, onClick: () => clicks++ });
    assert.equal(notify(tag, '', tag, { onClick: () => clicks++ }), true);
  }
  try {
    project = '/b'; send('TPT483');
    project = '/a';
    send('TPT483'); send('TPT483'); send('activity-TPT483'); send('completed-TPT483');
    send('TPT484'); send('objective-TPT483'); send('tipatask-test'); send('TPT4830');
    const staleClicks = browsers.slice(1, 5).map(n => n.onclick);
    // First observations and non-complete changes must leave every alert alone.
    maybeNotifyCompletion('TPT483', undefined, 'shipped');
    maybeNotifyCompletion('TPT483', 'working', 'working');
    assert.equal(ipc.length, 0);
    setNotifyEnabled('completed', false);
    assert.equal(maybeNotifyCompletion('TPT483', 'working', 'shipped'), false);
    assert.deepEqual(browsers.map(n => n.closed), [0, 1, 1, 1, 1, 0, 0, 0, 0]);
    for (const click of staleClicks) click();
    assert.equal(clicks, 0, 'closed browser callbacks are released');
    assert.equal(browsers[1].onclick, null);
    assert.deepEqual(getNotificationEntries().map(e => [e.projectPath, e.tag]), [
      ['/a', 'TPT4830'], ['/a', 'tipatask-test'], ['/a', 'objective-TPT483'], ['/a', 'TPT484'], ['/b', 'TPT483'],
    ]);
    assert.deepEqual(state.taskActivity, unread);
    assert.deepEqual(ipc, [['/a', 'TPT483']]);
    // Reopen/recomplete: cleanup happens before the new completion and duplicates retain it.
    maybeNotifyCompletion('TPT483', 'shipped', 'working');
    setNotifyEnabled('completed', true);
    clearDebounce('completed-TPT483');
    assert.equal(maybeNotifyCompletion('TPT483', 'working', 'shipped'), true);
    const fresh = browsers.at(-1);
    assert.equal(getNotificationEntries()[0].tag, 'completed-TPT483');
    maybeNotifyCompletion('TPT483', 'working', 'shipped');
    maybeNotifyCompletion('TPT483', 'shipped', 'shipped');
    assert.equal(fresh.closed, 0);
    assert.equal(ipc.length, 2);
    // Natural close also releases the action, even if an old handler was already queued.
    const callback = fresh.onclick;
    fresh.onclose(); callback();
    assert.equal(fresh.onclick, null);
    dismissTaskNotifications('');
    assert.equal(ipc.length, 2);
  } finally {
    project = '/a'; dismissTaskNotifications('TPT483');
    clearAllNotifications(); forgetTaskCompletion('TPT483'); resetStatuses();
    delete globalThis.window; delete globalThis.Notification; delete globalThis.localStorage;
  }
});

test('focused completion still clears existing alerts without a replacement', () => {
  globalThis.document = { hasFocus: () => true, visibilityState: 'visible', getElementById: () => null };
  globalThis.window = {};
  state.activeTerminal = { taskId: 'TPT483', visible: true };
  seedStatuses([{ name: 'working', is_in_progress: true }, { name: 'done', is_workflow_complete: true }]);
  pushNotification({ tag: 'TPT483' });
  try {
    assert.equal(maybeNotifyCompletion('TPT483', 'working', 'done'), false);
    assert.equal(getNotificationEntries().length, 0);
  } finally {
    state.activeTerminal = null; forgetTaskCompletion('TPT483'); resetStatuses();
    delete globalThis.document; delete globalThis.window;
  }
});
