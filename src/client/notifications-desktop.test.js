import { test } from 'node:test';
import assert from 'node:assert/strict';

test('desktop sends keep per-banner callbacks across debounce resets and ignore native registration', async () => {
  const sent = [];
  let click, dismiss;
  globalThis.window = { electronAPI: { notificationDelivery: 'desktop',
    notify: async (payload) => { sent.push(payload); return { ok: true }; },
    notifyStatus: async () => ({ signed: false, valid: false, registered: false }),
    getProjectPath: () => '/a',
    onNotificationClick: cb => { click = cb; },
    onNotificationDismiss: cb => { dismiss = cb; } } };
  const api = await import('./notifications.js');
  let first = 0, second = 0;
  api.notify('First', 'Body', 'task', { onClick: () => first++ });
  api.clearDebounce('task');
  api.notify('Second', 'Body', 'task', { onClick: () => second++ });
  await api.refreshNotificationStatus();
  assert.equal(api.getNotificationStatus().canDeliver, true);
  assert.equal(api.getNotificationStatus().delivery, 'desktop');
  assert.notEqual(sent[0].notificationId, sent[1].notificationId);
  click({ ...sent[0], projectPath: '/b' });
  assert.equal(first, 0);
  click({ ...sent[0], projectPath: '/a' });
  assert.equal(first, 1);
  assert.equal(second, 0);
  dismiss(sent[1]);
  click({ ...sent[1], projectPath: '/a' });
  assert.equal(second, 0);
  await api.sendTestNotification('Test', 'Body');
  await api.sendTestNotification('Test', 'Body');
  assert.notEqual(sent[2].notificationId, sent[3].notificationId);
  delete globalThis.window;
});

test('task cleanup releases all matching desktop callbacks without touching another project', async () => {
  const sent = [], dismissedTasks = [];
  let projectPath = '/a', click;
  globalThis.window = { electronAPI: { notificationDelivery: 'desktop',
    notify: async payload => { sent.push(payload); return { ok: true }; },
    getProjectPath: () => projectPath,
    dismissTaskNotifications: id => { dismissedTasks.push([projectPath, id]); return Promise.resolve({ ok: true }); },
    onNotificationClick: cb => { click = cb; }, onNotificationDismiss: () => {},
  } };
  const api = await import('./notifications.js?task-dismissal');
  let calls = [];
  function send(tag, id) {
    api.clearDebounce(tag);
    api.notify(tag, '', tag, { onClick: () => calls.push(id) });
  }
  send('TPT483', 'old1'); send('TPT483', 'old2'); send('activity-TPT483', 'activity');
  send('completed-TPT483', 'completion'); send('objective-TPT483', 'objective');
  projectPath = '/b'; send('TPT483', 'other-project');
  projectPath = '/a';
  api.dismissTaskNotifications('TPT483');
  for (const payload of sent.slice(0, 5)) click({ ...payload, projectPath: '/a' });
  assert.deepEqual(calls, ['objective']);
  projectPath = '/b'; click({ ...sent[5], projectPath: '/b' });
  assert.deepEqual(calls, ['objective', 'other-project']);
  assert.deepEqual(dismissedTasks, [['/a', 'TPT483']]);
  delete globalThis.window;
});
