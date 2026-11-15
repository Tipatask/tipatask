// "Show on Top" off while macOS cannot deliver native notifications: main sends through the
// desktop banner and reports that delivery (main/notify-status.js). The Settings row must show
// the delivery in use — "desktop banners" — say why the banner stands in for the system
// notifications the switch asks for, keep Repair within reach, and Test must pass.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';
import { Window } from 'happy-dom';

const { offStatus } = createRequire(import.meta.url)('../../main/notify-status.js');
const health = { signature: { valid: true, reason: null, relaunchNeeded: false }, registered: false,
  registration: { conflicts: 8, installerVolumes: ['/Volumes/TipATask 0.9.19-arm64/TipATask.app'], repair: null } };
let live = offStatus({ delivery: 'desktop', fallback: 'not-registered', ...health });
const sent = [];
globalThis.window = { electronAPI: {
  notificationDelivery: 'desktop',
  notify: async (payload) => { sent.push(payload); return { ok: true, id: String(sent.length), delivery: 'desktop', fallback: 'not-registered' }; },
  notifyStatus: async () => live,
  getProjectPath: () => '/a',
} };
const { getNotificationStatus, refreshNotificationStatus, sendTestNotification, notify, registrationRepairMessage } = await import('./notifications.js?fallback');
const { setLocale, t, tc } = await import('./i18n.js');

const source = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const productionFunction = (name) => source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0];

async function settingsRow() {
  const page = new Window();
  page.electronAPI = { platform: 'darwin' };
  page.document.body.innerHTML = template.slice(template.indexOf('<div id="settings-modal"'), template.indexOf('<!-- (C1388)'));
  const context = vm.createContext({ document: page.document, window: page, t, tc, registrationRepairMessage,
    getNotificationStatus, refreshNotificationStatus });
  vm.runInContext(`${productionFunction('_notifStatusKey')}\n${productionFunction('_populateSettingsNotificationsRows')}`, context);
  await context._populateSettingsNotificationsRows();
  const el = (id) => page.document.getElementById(id);
  const row = { badge: el('settings-notifications-state').textContent, hint: el('settings-notifications-hint').hidden,
    hintText: el('settings-notifications-hint-text').textContent, repair: el('settings-notifications-repair').hidden,
    style: el('settings-notifications-style-hint').hidden, test: el('settings-notifications-test').disabled };
  await page.happyDOM.close();
  return row;
}

test('the banner fallback reads as desktop delivery: badge "desktop banners", the cause with Repair, Test passes', async () => {
  setLocale('en');
  await refreshNotificationStatus();
  const status = getNotificationStatus();
  assert.equal(status.delivery, 'desktop');
  assert.equal(status.canDeliver, true);
  assert.equal(status.lastError, null, 'the unregistered bundle is not an error while banners deliver');
  assert.equal(status.onTop, false);
  assert.equal(status.fallback, 'not-registered');
  assert.equal(status.conflicts, 8);
  assert.deepEqual(status.installerVolumes, ['/Volumes/TipATask 0.9.19-arm64/TipATask.app']);

  // One notice: where alerts go, then the cause. No Alerts-vs-Banners advice — nothing native shows.
  const cause = tc('settings.notifHintDuplicateBundlesWithVolume', 8, { volume: 'TipATask 0.9.19-arm64' });
  assert.deepEqual(await settingsRow(), { badge: 'desktop banners', hint: false,
    hintText: t('settings.notifHintFallback', { cause }), repair: false, style: true, test: false });
  assert.match(cause, /^8 other copies of TipATask are registered/);

  assert.deepEqual(await sendTestNotification('Test', 'Body'), { ok: true });
  assert.equal(sent.at(-1).tag, 'tipatask-test');
  assert.equal(notify('Title', 'Body', 'TPT1'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getNotificationStatus().lastError, null);
  assert.equal((await settingsRow()).badge, 'desktop banners');
});

test('the same health without the fallback reads as blocked native delivery', async () => {
  setLocale('en');
  live = offStatus({ delivery: 'native', fallback: null, ...health });
  await refreshNotificationStatus();
  assert.equal(getNotificationStatus().fallback, undefined);
  const row = await settingsRow();
  assert.equal(row.badge, 'blocked');
  assert.equal(row.hint, false);
  assert.equal(row.hintText, tc('settings.notifHintDuplicateBundlesWithVolume', 8, { volume: 'TipATask 0.9.19-arm64' }),
    'the native path names the cause alone — the badge already says blocked');
  assert.equal(row.repair, false);
  assert.equal(row.style, false);
  live = offStatus({ delivery: 'desktop', fallback: 'not-registered', ...health });
  await refreshNotificationStatus();
  assert.equal((await settingsRow()).badge, 'desktop banners');
});

test('"Show on Top" on needs no notice, whatever the bundle health', async () => {
  setLocale('en');
  live = { delivery: 'desktop', available: true, onTop: true };
  await refreshNotificationStatus();
  const status = getNotificationStatus();
  assert.equal(status.onTop, true);
  assert.equal(status.fallback, undefined);
  assert.equal(status.conflicts, null);
  assert.deepEqual(await settingsRow(), { badge: 'desktop banners', hint: true, hintText: '', repair: true, style: true, test: false });
});
