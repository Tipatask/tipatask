// Settings ▸ Notifications "Show on top of other apps": the switch for the app-level flag that
// View ▸ Notifications and the banner's "Show" box also write. Driven end to end on the client —
// main's status shapes (main/notify-status.js) → notifications.js → the Settings rows and the
// switch wiring of task-board.js, run in a vm against the real template markup.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';
import { Window } from 'happy-dom';

const { offStatus } = createRequire(import.meta.url)('../../main/notify-status.js');

// Stand-in for main: the saved flag, what "off" leads to (native delivery, or the banner
// fallback when `blocker` names why the OS cannot deliver), the one writer and its broadcast.
const main = {
  enabled: true,
  blocker: null,
  registered: true,
  registration: { conflicts: 0, installerVolumes: [], repair: null },
  writes: [],
  answer: null,
  listeners: new Set(),
  reset(state = {}) {
    Object.assign(this, { enabled: true, blocker: null, registered: true, answer: null,
      registration: { conflicts: 0, installerVolumes: [], repair: null } }, state);
    this.writes.length = 0;
  },
  status() {
    if (this.enabled) return { delivery: 'desktop', available: true, onTop: true };
    return offStatus({ delivery: this.blocker ? 'desktop' : 'native', fallback: this.blocker,
      signature: { valid: true, reason: null, relaunchNeeded: false }, registered: this.registered,
      registration: this.registration });
  },
  set(on) {
    this.writes.push(on);
    if (this.answer) return this.answer(on);
    this.flip(on);
    return { ok: true, enabled: on };
  },
  // The menu checkbox and the banner's "Show" box end here too.
  flip(on) {
    this.enabled = on;
    for (const cb of [...this.listeners]) cb({ enabled: on });
  },
};
const blockedMac = { enabled: false, blocker: 'not-registered', registered: false,
  registration: { conflicts: 8, installerVolumes: ['/Volumes/TipATask 0.9.19-arm64/TipATask.app'], repair: null } };

const bridge = {
  notificationDelivery: 'desktop',
  sendResult: { ok: true, id: '1', delivery: 'desktop' },
  notify: async () => bridge.sendResult,
  notifyStatus: async () => main.status(),
  setNotificationsOnTop: async (on) => main.set(on),
  getProjectPath: () => '/a',
};
globalThis.window = { electronAPI: bridge };
const { getNotificationStatus, refreshNotificationStatus, registrationRepairMessage, setNotificationsOnTop,
  canSetNotificationsOnTop, sendTestNotification } = await import('./notifications.js?ontop');
const { LOCALES, setLocale, t, tc } = await import('./i18n.js');

const source = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const productionFunction = (name) => source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0];
const wiring = source.slice(source.indexOf("  const notifOnTopToggle = modal.querySelector('#settings-notifications-ontop');"),
  source.indexOf('  // (C1259) Debug ▸ click-to-render perf logging toggle'));
const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// The Settings dialog with the real populate function and the real switch wiring. `electron`
// false is browser mode: no bridge on the page at all.
async function openSettings({ electron = true, platform = 'darwin', open = true } = {}) {
  const page = new Window();
  if (electron) {
    page.electronAPI = { platform, setNotificationsOnTop: bridge.setNotificationsOnTop,
      onNotificationsOnTopChanged: (cb) => { main.listeners.add(cb); return () => main.listeners.delete(cb); } };
  }
  page.document.body.innerHTML = template.slice(template.indexOf('<div id="settings-modal"'), template.indexOf('<!-- (C1388)'));
  const toasts = [];
  const context = vm.createContext({ document: page.document, window: page, t, tc, registrationRepairMessage,
    getNotificationStatus, refreshNotificationStatus, setNotificationsOnTop,
    showToast: (message, kind) => toasts.push({ message, kind }) });
  assert.ok(wiring.includes('setNotificationsOnTop(') && wiring.includes('onNotificationsOnTopChanged'), 'switch wiring found');
  vm.runInContext(`${productionFunction('_notifStatusKey')}\n${productionFunction('_populateSettingsNotificationsRows')}\n`
    + `const modal = document.getElementById('settings-modal');\n${wiring}`, context);
  const el = (id) => page.document.getElementById(id);
  if (open) el('settings-modal').classList.add('open');
  const toggle = el('settings-notifications-ontop');
  const view = () => ({
    badge: el('settings-notifications-state').textContent,
    row: !el('settings-notifications-ontop-row').hidden,
    checked: toggle.checked,
    disabled: toggle.disabled,
    notice: el('settings-notifications-hint').hidden ? null : el('settings-notifications-hint-text').textContent,
    repair: !el('settings-notifications-repair').hidden,
    style: !el('settings-notifications-style-hint').hidden,
  });
  const setSwitch = async (on) => {
    toggle.checked = on;
    toggle.dispatchEvent(new page.Event('change', { bubbles: true }));
    await settle();
  };
  const populate = async () => { await context._populateSettingsNotificationsRows(); return view(); };
  const close = async () => { main.listeners.clear(); await page.happyDOM.close(); };
  return { el, toggle, view, setSwitch, populate, toasts, close };
}

test('two notices that follow the rows keep a gap, and only when the first one shows', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const gap = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, selector]) => selector.trim() === '.settings-section > .settings-notice:not([hidden]) ~ .settings-notice');
  assert.ok(gap, 'section-level notices have a stacking rule');
  assert.match(gap[2], /margin-top:\s*12px/);
});

test('the Show on Top row ships hidden, after the status row and above both notices', async () => {
  const page = new Window();
  page.document.body.innerHTML = template.slice(template.indexOf('<div id="settings-modal"'), template.indexOf('<!-- (C1388)'));
  const row = page.document.getElementById('settings-notifications-ontop-row');
  const toggle = page.document.getElementById('settings-notifications-ontop');
  assert.deepEqual([...row.parentElement.children].map((child) => child.id), ['settings-notifications-title',
    'settings-notifications-row', 'settings-notifications-ontop-row', 'settings-notifications-hint',
    'settings-notifications-style-hint']);
  assert.equal(row.hidden, true, 'hidden until Settings finds a bridge that can write the flag');
  assert.equal(toggle.type, 'checkbox');
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(row.querySelector('label').getAttribute('for'), 'settings-notifications-ontop');
  assert.equal(toggle.parentElement.className, 'settings-row-control', 'drawn as a switch like every Settings checkbox');
  await page.happyDOM.close();
});

test('the row renders in Electron only', async () => {
  setLocale('en');
  main.reset();
  const electron = await openSettings();
  assert.equal((await electron.populate()).row, true);
  await electron.close();

  const browser = await openSettings({ electron: false });
  assert.equal((await browser.populate()).row, false, 'browser mode has no always-on-top banner');
  await browser.close();

  // A bridge that cannot write the flag (an older preload) is browser mode for this row.
  const page = await openSettings();
  delete page.el('settings-modal').ownerDocument.defaultView.electronAPI.setNotificationsOnTop;
  assert.equal((await page.populate()).row, false);
  await page.close();
});

test('the switch shows the saved choice and stays off the keyboard path while it is unknown', async () => {
  setLocale('en');
  main.reset();
  const settings = await openSettings();
  assert.deepEqual(await settings.populate(), { badge: 'desktop banners', row: true, checked: true, disabled: false,
    notice: null, repair: false, style: false });
  main.enabled = false;
  assert.equal((await settings.populate()).checked, false);

  const status = bridge.notifyStatus;
  bridge.notifyStatus = async () => ({ delivery: 'desktop', available: true }); // main without a controller
  const unknown = await settings.populate();
  assert.equal(unknown.disabled, true);
  assert.equal(unknown.checked, true, 'the default while the choice cannot be read');
  bridge.notifyStatus = status;
  assert.equal((await settings.populate()).disabled, false);
  await settings.close();
});

test('toggling the switch writes the flag, switches the badge and hides the native notices', async () => {
  setLocale('en');
  main.reset({ enabled: false });
  const settings = await openSettings();
  // Off with working native delivery: system notifications, with the macOS Alerts advice.
  assert.deepEqual(await settings.populate(), { badge: 'system', row: true, checked: false, disabled: false,
    notice: null, repair: false, style: true });
  assert.equal(settings.el('settings-notifications-style-text').textContent, t('settings.notifHintStyleMac'));

  await settings.setSwitch(true);
  assert.deepEqual(main.writes, [true]);
  assert.equal(main.enabled, true, 'the banner is back: main applies the flag at once');
  assert.deepEqual(settings.view(), { badge: 'desktop banners', row: true, checked: true, disabled: false,
    notice: null, repair: false, style: false });
  assert.deepEqual(settings.toasts, []);

  await settings.setSwitch(false);
  assert.deepEqual(main.writes, [true, false]);
  assert.deepEqual(settings.view(), { badge: 'system', row: true, checked: false, disabled: false,
    notice: null, repair: false, style: true });
  await settings.close();
});

test('on a Mac that cannot deliver native notifications the switch follows the saved flag and the notice explains the banner', async () => {
  setLocale('en');
  main.reset(blockedMac);
  const settings = await openSettings();
  const cause = '8 other copies of TipATask are registered with macOS under the same identifier — including one on the '
    + 'mounted installer disk “TipATask 0.9.19-arm64”. Eject it, then use Repair and quit and reopen TipATask.';
  const off = { badge: 'desktop banners', row: true, checked: false, disabled: false,
    notice: `TipATask’s system notifications are not being delivered, so alerts still arrive as desktop banners. ${cause}`,
    repair: true, style: false };
  assert.deepEqual(await settings.populate(), off);
  assert.equal(settings.toggle.getAttribute('aria-describedby'),
    'settings-notifications-ontop-hint settings-notifications-hint-text', 'the notice describes the unchecked switch');

  await settings.setSwitch(true);
  assert.deepEqual(settings.view(), { badge: 'desktop banners', row: true, checked: true, disabled: false,
    notice: null, repair: false, style: false }, 'banners by choice: the native path is nobody\'s business');
  assert.equal(settings.toggle.getAttribute('aria-describedby'), 'settings-notifications-ontop-hint');

  await settings.setSwitch(false);
  assert.deepEqual(settings.view(), off);
  assert.deepEqual(main.writes, [true, false]);
  await settings.close();
});

test('the fallback notice names each cause and offers Repair only for duplicate registrations', async () => {
  setLocale('en');
  const lead = (cause) => t('settings.notifHintFallback', { cause });
  const settings = await openSettings();

  main.reset({ ...blockedMac, registration: { conflicts: 1, installerVolumes: ['/Volumes/Installer/TipATask.app'], repair: null } });
  let view = await settings.populate();
  assert.equal(view.notice, lead('1 other copy of TipATask is registered with macOS under the same identifier — on the '
    + 'mounted installer disk “Installer”. Eject it, then use Repair and quit and reopen TipATask.'));
  assert.equal(view.repair, true);

  main.reset({ ...blockedMac, registration: { conflicts: 3, installerVolumes: [], repair: null } });
  view = await settings.populate();
  assert.equal(view.notice, lead(tc('settings.notifHintDuplicateBundles', 3)));
  assert.equal(view.repair, true);

  main.reset({ ...blockedMac, registration: { conflicts: 0, installerVolumes: [], repair: null } });
  view = await settings.populate();
  assert.equal(view.notice, lead(t('settings.notifHintNotRegistered')));
  assert.equal(view.repair, false, 'nothing to repair without a competing copy');

  // A failed Repair keeps its blocker, and the button, on screen for the retry.
  const repair = { ok: false, outcome: 'blocked-installer', registration: { installerVolumes: ['/Volumes/Installer/TipATask.app'] } };
  main.reset({ ...blockedMac, registration: { conflicts: 1, installerVolumes: ['/Volumes/Installer/TipATask.app'], repair } });
  view = await settings.populate();
  assert.equal(view.notice, lead(registrationRepairMessage(repair, t)));
  assert.equal(view.repair, true);

  // A native send the OS refused, with nothing wrong in the bundle health.
  main.reset({ enabled: false, blocker: 'failed' });
  view = await settings.populate();
  assert.equal(view.notice, lead(t('settings.notifHintFallbackCheck')));
  assert.equal(view.repair, false);
  assert.equal(view.style, false);

  // The health explains a runtime failure once it is known.
  main.reset({ ...blockedMac, blocker: 'no-response' });
  view = await settings.populate();
  assert.equal(getNotificationStatus().fallback, 'not-registered');
  assert.match(view.notice, /8 other copies of TipATask/);
  assert.equal(view.repair, true);
  await settings.close();
});

test('a desktop banner that could not be shown outranks the fallback notice', async () => {
  setLocale('en');
  main.reset(blockedMac);
  const settings = await openSettings();
  const delivered = bridge.sendResult;
  try {
    assert.equal((await settings.populate()).repair, true);

    // The banner itself failed: nothing reaches the user, so that is what the row reports.
    bridge.sendResult = { ok: false, reason: 'desktop-unavailable' };
    assert.deepEqual(await sendTestNotification('Test', 'Body'), { ok: false, reason: 'desktop-unavailable' });
    let view = await settings.populate();
    assert.equal(view.badge, 'blocked');
    assert.equal(view.notice, t('settings.notifHintDesktopFailed'));
    assert.equal(view.repair, false, 'Repair does not fix a banner that cannot be shown');
    assert.equal(settings.toggle.getAttribute('aria-describedby'), 'settings-notifications-ontop-hint');
    assert.equal(view.checked, false, 'the switch still shows the saved choice');

    bridge.sendResult = { ok: true, id: '2', delivery: 'desktop', fallback: 'not-registered' };
    assert.deepEqual(await sendTestNotification('Test', 'Body'), { ok: true });
    view = await settings.populate();
    assert.equal(view.badge, 'desktop banners');
    assert.match(view.notice, /^TipATask’s system notifications are not being delivered/);
    assert.equal(view.repair, true);
  } finally {
    // A later successful send clears the transport error for the tests that follow.
    bridge.sendResult = delivered;
    await sendTestNotification('Test', 'Body');
    await settings.close();
  }
});

test('a write that never reached the flag puts the switch back; one that could not be saved keeps it and says so', async () => {
  setLocale('en');
  main.reset();
  const settings = await openSettings();
  await settings.populate();

  main.answer = () => ({ ok: false, reason: 'untrusted_sender' });
  await settings.setSwitch(false);
  assert.deepEqual(main.writes, [false]);
  assert.equal(settings.view().checked, true, 'the flag never changed');
  assert.deepEqual(settings.toasts, [{ message: t('settings.notifOnTopFailed'), kind: 'error' }]);

  main.answer = () => { throw new Error('ipc closed'); };
  await settings.setSwitch(false);
  assert.equal(settings.view().checked, true);
  assert.equal(settings.toasts.at(-1).message, t('settings.notifOnTopFailed'));

  // Applied live, but the settings file could not be written.
  main.answer = (on) => { main.flip(on); return { ok: false, enabled: on, reason: 'EACCES' }; };
  await settings.setSwitch(false);
  assert.equal(settings.view().checked, false, 'the live choice is what the switch shows');
  assert.equal(settings.view().badge, 'system');
  assert.deepEqual(settings.toasts.at(-1), { message: t('settings.notifOnTopNotSaved'), kind: 'error' });
  assert.equal(settings.toasts.length, 3);
  await settings.close();
});

test('a flip from the menu or the banner reaches an open Settings dialog, and only an open one', async () => {
  setLocale('en');
  main.reset();
  const settings = await openSettings();
  await settings.populate();
  main.flip(false);
  assert.equal(settings.toggle.checked, false, 'the switch follows at once, before the status re-read');
  await settle();
  assert.deepEqual(settings.view(), { badge: 'system', row: true, checked: false, disabled: false,
    notice: null, repair: false, style: true });
  assert.deepEqual(main.writes, [], 'following a flip writes nothing back');
  await settings.close();

  main.reset();
  const closed = await openSettings({ open: false });
  await closed.populate();
  let reads = 0;
  const status = bridge.notifyStatus;
  bridge.notifyStatus = async () => { reads += 1; return main.status(); };
  main.flip(false);
  await settle();
  assert.equal(reads, 0, 'a closed dialog re-reads on its next open instead');
  assert.equal(closed.toggle.checked, true);
  bridge.notifyStatus = status;
  await closed.close();
});

test('notifications.js reports the saved choice and writes it through the bridge', async () => {
  main.reset();
  await refreshNotificationStatus();
  assert.equal(canSetNotificationsOnTop(), true);
  assert.equal(getNotificationStatus().onTop, true);
  assert.deepEqual(await setNotificationsOnTop(false), { ok: true, enabled: false });
  assert.deepEqual(main.writes, [false]);
  assert.equal(getNotificationStatus().onTop, false, 'the status is re-read after the write');
  assert.equal(getNotificationStatus().delivery, 'native');
  await setNotificationsOnTop('yes');
  assert.deepEqual(main.writes, [false, false], 'only a real true switches it on');

  const { setNotificationsOnTop: write } = bridge;
  delete bridge.setNotificationsOnTop;
  assert.equal(canSetNotificationsOnTop(), false);
  assert.deepEqual(await setNotificationsOnTop(true), { ok: false, reason: 'unsupported' });
  bridge.setNotificationsOnTop = write;
});

test('the duplicate-copies hint counts copies in every locale and no longer points below', () => {
  const key = 'settings.notifHintDuplicateBundles';
  const volumeKey = 'settings.notifHintDuplicateBundlesWithVolume';
  const expected = {
    en: { 1: /^1 other copy of TipATask is registered /, 8: /^8 other copies of TipATask are registered / },
    uk: { 1: /зареєстровано 1 іншу копію TipATask/, 2: /зареєстровано 2 інші копії TipATask/, 8: /зареєстровано 8 інших копій TipATask/,
      21: /зареєстровано 21 іншу копію TipATask/, 22: /зареєстровано 22 інші копії TipATask/, 12: /зареєстровано 12 інших копій TipATask/ },
    zh: { 1: /还有 1 个 TipATask 副本/, 8: /还有 8 个 TipATask 副本/ },
    es: { 1: /^Hay 1 copia más de TipATask registrada /, 8: /^Hay otras 8 copias de TipATask registradas / },
  };
  try {
    for (const [locale, counts] of Object.entries(expected)) {
      setLocale(locale);
      for (const [count, pattern] of Object.entries(counts)) {
        const plain = tc(key, Number(count));
        const withVolume = tc(volumeKey, Number(count), { volume: 'TipATask 0.9.19-arm64' });
        assert.match(plain, pattern, `${locale} ${count}`);
        assert.match(withVolume, pattern, `${locale} ${count} with a disk`);
        assert.ok(withVolume.includes('TipATask 0.9.19-arm64'), `${locale}: the disk is named`);
        for (const text of [plain, withVolume]) {
          assert.doesNotMatch(text, /\{|\}/, `${locale} ${count}: no placeholder left`);
          assert.doesNotMatch(text, /\(ies\)|\(s\)|\(и\)/, `${locale} ${count}: no bracketed plural`);
          assert.doesNotMatch(text, /\bbelow\b|нижче|下方|\babajo\b|a continuación/, `${locale} ${count}: Repair sits beside the text`);
        }
      }
      // The unpluralized keys are gone, so no caller can render a raw key or a stale string.
      assert.equal(key in LOCALES[locale], false);
      assert.equal(volumeKey in LOCALES[locale], false);
    }
    assert.ok(`${key}.few` in LOCALES.uk && `${volumeKey}.few` in LOCALES.uk);
  } finally {
    setLocale('en');
  }
});

test('the switch label, its hint and both failure toasts are translated in every locale', () => {
  for (const key of ['settings.notifOnTop', 'settings.notifOnTopHint', 'settings.notifOnTopFailed', 'settings.notifOnTopNotSaved',
    'settings.notifHintFallback', 'settings.notifHintFallbackCheck']) {
    for (const [locale, table] of Object.entries(LOCALES)) {
      assert.ok(table[key]?.trim(), `${locale}.${key}`);
      if (locale !== 'en') assert.notEqual(table[key], LOCALES.en[key], `${locale}.${key} is translated`);
    }
  }
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.ok(table['settings.notifHintFallback'].includes('{cause}'), `${locale}: the fallback notice carries its cause`);
  }
  assert.match(source, /\['settings-notifications-ontop-label', 'settings\.notifOnTop'\]/);
  assert.match(source, /\['settings-notifications-ontop-hint', 'settings\.notifOnTopHint'\]/);
});
