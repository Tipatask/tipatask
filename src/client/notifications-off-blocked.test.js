// "Show on Top" off while macOS cannot deliver native notifications. Off means system
// notifications only: main never puts the desktop banner up in their place (TPT9327), so the
// alert stays the in-app card its window shows and the send reports the failure. The Settings
// row reads blocked system delivery — the cause, with Repair for duplicate registrations —
// beside the switch that turns the banner back on, and Test reports the failure too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';
import { Window } from 'happy-dom';

const { offStatus } = createRequire(import.meta.url)('../../main/notify-status.js');
const health = { signature: { valid: true, reason: null, relaunchNeeded: false }, registered: false,
  registration: { conflicts: 8, installerVolumes: ['/Volumes/TipATask 0.9.19-arm64/TipATask.app'], repair: null } };
let live = offStatus(health);
const sent = [];
// Main's answer for a native notification macOS refuses (UNErrorDomain error 1).
globalThis.window = { electronAPI: {
  notificationDelivery: 'desktop',
  notify: async (payload) => { sent.push(payload); return { ok: false, reason: 'failed' }; },
  notifyStatus: async () => live,
  getProjectPath: () => '/a',
} };
const { getNotificationStatus, refreshNotificationStatus, sendTestNotification, notify, onNotifyFailed,
  registrationRepairMessage, getNotificationsOnTop, readNotificationsOnTop } = await import('./notifications.js?off-blocked');
const { setLocale, t, tc } = await import('./i18n.js');

const source = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const productionFunction = (name) => source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0];
const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

async function settingsRow() {
  const page = new Window();
  page.electronAPI = { platform: 'darwin' };
  page.document.body.innerHTML = template.slice(template.indexOf('<div id="settings-modal"'), template.indexOf('<!-- (C1388)'));
  const context = vm.createContext({ document: page.document, window: page, t, tc, registrationRepairMessage,
    getNotificationStatus, refreshNotificationStatus, getNotificationsOnTop, readNotificationsOnTop });
  vm.runInContext(`${productionFunction('_notifStatusKey')}\n${productionFunction('_renderSettingsOnTopSwitch')}\n`
    + productionFunction('_populateSettingsNotificationsRows'), context);
  await context._populateSettingsNotificationsRows();
  const el = (id) => page.document.getElementById(id);
  const row = { badge: el('settings-notifications-state').textContent, hint: el('settings-notifications-hint').hidden,
    hintText: el('settings-notifications-hint-text').textContent, repair: el('settings-notifications-repair').hidden,
    style: el('settings-notifications-style-hint').hidden, test: el('settings-notifications-test').disabled };
  await page.happyDOM.close();
  return row;
}

test('off with native delivery blocked reads as blocked system notifications: the cause, with Repair', async () => {
  setLocale('en');
  await refreshNotificationStatus();
  const status = getNotificationStatus();
  assert.equal(status.delivery, 'native', 'the banner never stands in while the switch is off');
  assert.equal('fallback' in status, false);
  assert.equal(status.onTop, false);
  assert.equal(status.canDeliver, false);
  assert.equal(status.lastError, 'not-registered');
  assert.equal(status.conflicts, 8);
  assert.deepEqual(status.installerVolumes, ['/Volumes/TipATask 0.9.19-arm64/TipATask.app']);

  const cause = tc('settings.notifHintDuplicateBundlesWithVolume', 8, { volume: 'TipATask 0.9.19-arm64' });
  assert.match(cause, /^8 other copies of TipATask are registered/);
  assert.deepEqual(await settingsRow(), { badge: 'blocked', hint: false, hintText: cause, repair: false, style: false, test: false });
});

test('a system notification macOS refuses is reported as not delivered, so the alert can notify again', async () => {
  setLocale('en');
  const failed = [];
  const stop = onNotifyFailed((tag) => failed.push(tag));
  try {
    assert.equal(notify('Title', 'Body', 'TPT1'), true, 'handed to the transport');
    await settle();
    assert.deepEqual(failed, ['TPT1'], 'the attention ledger hears that nobody was told');
    assert.equal(notify('Title', 'Body', 'TPT1'), true, 'the 30 s debounce is re-armed for a retry');
    await settle();
    assert.deepEqual(failed, ['TPT1', 'TPT1']);
  } finally { stop(); }
  assert.deepEqual(await sendTestNotification('Test', 'Body'), { ok: false, reason: 'failed' });
  assert.equal(sent.at(-1).tag, 'tipatask-test');
  assert.equal((await settingsRow()).badge, 'blocked');
});

test('"Show on Top" on needs no notice, whatever the bundle health', async () => {
  setLocale('en');
  live = { delivery: 'desktop', available: true, onTop: true };
  window.electronAPI.notify = async (payload) => { sent.push(payload); return { ok: true, id: String(sent.length), delivery: 'desktop' }; };
  assert.deepEqual(await sendTestNotification('Test', 'Body'), { ok: true });
  const status = getNotificationStatus();
  assert.equal(status.onTop, true);
  assert.equal(status.delivery, 'desktop');
  assert.equal(status.conflicts, null);
  assert.deepEqual(await settingsRow(), { badge: 'desktop banners', hint: true, hintText: '', repair: true, style: true, test: false });
});
