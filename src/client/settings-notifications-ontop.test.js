// Settings ▸ Notifications "Always-on-top notifications": the switch for the app-level Show on
// Top flag that View ▸ Notifications and the banner's "Show" box also write. Driven end to end on
// the client — main's status shapes (main/notify-status.js) → notifications.js → the Settings
// rows and the switch wiring of task-board.js, run in a vm against the real template markup.
// settings-ontop-banner-sync.test.js runs the same rows against main.js and the real banner.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';

const { offStatus } = createRequire(import.meta.url)('../../main/notify-status.js');

// Stand-in for main: the saved flag (on: desktop banners; off: native delivery, with the bundle
// health that decides whether macOS shows it), its quick read, the one writer and its broadcast.
// `listeners` is notifications.js's own subscription (notify:on-top-changed), made once at import.
const main = {
  enabled: true,
  registered: true,
  registration: { conflicts: 0, installerVolumes: [], repair: null },
  writes: [],
  answer: null,
  readAnswer: null,
  listeners: new Set(),
  reset(state = {}) {
    Object.assign(this, { enabled: true, registered: true, answer: null, readAnswer: null,
      registration: { conflicts: 0, installerVolumes: [], repair: null } }, state);
    this.writes.length = 0;
  },
  get() {
    if (this.readAnswer) return this.readAnswer();
    return { ok: true, enabled: this.enabled };
  },
  status() {
    if (this.enabled) return { delivery: 'desktop', available: true, onTop: true };
    return offStatus({ signature: { valid: true, reason: null, relaunchNeeded: false }, registered: this.registered,
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
const blockedMac = { enabled: false, registered: false,
  registration: { conflicts: 8, installerVolumes: ['/Volumes/TipATask 0.9.19-arm64/TipATask.app'], repair: null } };

const bridge = {
  notificationDelivery: 'desktop',
  sendResult: { ok: true, id: '1', delivery: 'desktop' },
  notify: async () => bridge.sendResult,
  notifyStatus: async () => main.status(),
  getNotificationsOnTop: async () => main.get(),
  // Main handles a write on a later task, as over IPC: its broadcast, then its answer.
  setNotificationsOnTop: (on) => new Promise((resolve, reject) => setImmediate(() => {
    try { resolve(main.set(on)); } catch (error) { reject(error); }
  })),
  onNotificationsOnTopChanged: (cb) => { main.listeners.add(cb); return () => main.listeners.delete(cb); },
  getProjectPath: () => '/a',
};
globalThis.window = { electronAPI: bridge };
const bridgeDefaults = { ...bridge };
const { getNotificationStatus, refreshNotificationStatus, registrationRepairMessage, setNotificationsOnTop,
  canSetNotificationsOnTop, sendTestNotification, getNotificationsOnTop, readNotificationsOnTop,
  onNotificationsOnTopChange } = await import('./notifications.js?ontop');
const { LOCALES, setLocale, t, tc } = await import('./i18n.js');

const source = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const productionFunction = (name) => source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0];
const settingsText = source.match(/^const _SETTINGS_TEXT = \[[\s\S]*?^\];/m)[0];
const wiring = source.slice(source.indexOf("  const notifOnTopToggle = modal.querySelector('#settings-notifications-ontop');"),
  source.indexOf('  // (C1259) Debug ▸ click-to-render perf logging toggle'));
const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// Every dialog a test opened is closed after it, and the bridge put back, even when it fails.
const openDialogs = new Set();
afterEach(async () => {
  for (const close of [...openDialogs]) await close();
  for (const key of Object.keys(bridge)) if (!(key in bridgeDefaults)) delete bridge[key];
  Object.assign(bridge, bridgeDefaults);
  main.answer = null;
  main.readAnswer = null;
});

// The Settings dialog with the real localizer, populate functions and switch wiring. `electron`
// false is browser mode: no bridge on the page at all.
async function openSettings({ electron = true, platform = 'darwin', open = true } = {}) {
  const page = new Window();
  if (electron) page.electronAPI = { platform, setNotificationsOnTop: bridge.setNotificationsOnTop };
  page.document.body.innerHTML = template.slice(template.indexOf('<div id="settings-modal"'), template.indexOf('<!-- (C1388)'));
  const toasts = [];
  const unsubscribe = [];
  const context = vm.createContext({ document: page.document, window: page, t, tc, registrationRepairMessage,
    getNotificationStatus, refreshNotificationStatus, setNotificationsOnTop, getNotificationsOnTop, readNotificationsOnTop,
    onNotificationsOnTopChange: (cb) => { const stop = onNotificationsOnTopChange(cb); unsubscribe.push(stop); return stop; },
    showToast: (message, kind) => toasts.push({ message, kind }) });
  assert.ok(wiring.includes('setNotificationsOnTop(') && wiring.includes('onNotificationsOnTopChange('), 'switch wiring found');
  vm.runInContext(`${settingsText}\n${productionFunction('_localizeSettingsModal')}\n${productionFunction('_notifStatusKey')}\n`
    + `${productionFunction('_renderSettingsOnTopSwitch')}\n${productionFunction('_populateSettingsNotificationsRows')}\n`
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
  // Starts a populate without waiting for it, the way openSettingsModal() does.
  const startPopulate = () => context._populateSettingsNotificationsRows();
  const localize = () => context._localizeSettingsModal();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    openDialogs.delete(close);
    for (const stop of unsubscribe) stop();
    await page.happyDOM.close();
  };
  openDialogs.add(close);
  return { el, toggle, view, setSwitch, populate, startPopulate, localize, toasts, close };
}

// Holds main's status answers, the way the bundle-health refresh does while Show on Top is off,
// until release() answers every held read with the status as it is then.
function holdStatus() {
  const held = [];
  const original = bridge.notifyStatus;
  bridge.notifyStatus = () => new Promise((resolve) => held.push(resolve));
  return {
    pending: () => held.length,
    async release() {
      if (bridge.notifyStatus !== original) bridge.notifyStatus = original;
      for (const resolve of held.splice(0)) resolve(main.status());
      await settle();
    },
  };
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

test('the switch shows the saved choice, and stays off the keyboard path only while main has none', async () => {
  setLocale('en');
  main.reset();
  const settings = await openSettings();
  assert.deepEqual(await settings.populate(), { badge: 'desktop banners', row: true, checked: true, disabled: false,
    notice: null, repair: false, style: false });
  main.enabled = false;
  assert.equal((await settings.populate()).checked, false);

  // Main without a desktop-notification controller: no choice to show, nothing to write.
  const status = bridge.notifyStatus;
  main.readAnswer = () => ({ ok: false, reason: 'unavailable' });
  bridge.notifyStatus = async () => ({ delivery: 'desktop', available: true });
  const unknown = await settings.populate();
  assert.equal(unknown.row, true, 'the row still shows');
  assert.equal(unknown.disabled, true);
  assert.equal(unknown.checked, true, 'the default while main has no choice');
  main.readAnswer = null;
  bridge.notifyStatus = status;
  assert.equal((await settings.populate()).disabled, false);
  await settings.close();
});

test('the switch shows at once, before the delivery status, and works while that read is still running', async () => {
  setLocale('en');
  // The reported Mac: Show on Top off and macOS refusing native notifications. Main answers the
  // status only after its bundle-health refresh (codesign, lsregister -dump: seconds).
  main.reset(blockedMac);
  const status = holdStatus();
  const settings = await openSettings();
  try {
    const first = settings.startPopulate();
    assert.equal(settings.view().row, true, 'drawn before any await');
    await settle();
    assert.equal(status.pending(), 1, 'the status read is still running');
    assert.deepEqual(settings.view(), { badge: '', row: true, checked: false, disabled: false, notice: null,
      repair: false, style: false }, 'main\'s quick read already set the switch');

    // Usable meanwhile: turning it on writes the flag at once.
    await settings.setSwitch(true);
    assert.deepEqual(main.writes, [true]);
    assert.equal(main.enabled, true);
    assert.equal(settings.view().checked, true);
    assert.deepEqual(settings.toasts, []);

    // The banner's "Show" box turns it off again while the reads are still running: the switch
    // follows at once.
    main.flip(false);
    assert.equal(settings.toggle.checked, false);

    await status.release();
    await first;
    assert.deepEqual(settings.view(), { badge: 'blocked', row: true, checked: false, disabled: false,
      notice: settings.view().notice, repair: true, style: true });
    assert.match(settings.view().notice, /^8 other copies of TipATask/);
    assert.deepEqual(main.writes, [true], 'following a flip writes nothing back');
  } finally {
    await status.release();
    await settings.close();
  }
});

test('a status read that never answers leaves the switch shown and usable', async () => {
  setLocale('en');
  main.reset({ enabled: false });
  const status = holdStatus();
  const settings = await openSettings();
  try {
    settings.startPopulate();
    await settle();
    assert.deepEqual(settings.view(), { badge: '', row: true, checked: false, disabled: false, notice: null,
      repair: false, style: false });
    await settings.setSwitch(true);
    assert.deepEqual(main.writes, [true]);
    assert.equal(settings.view().checked, true);
    await status.release();
    assert.equal(settings.view().badge, 'desktop banners');
  } finally {
    await status.release();
    await settings.close();
  }
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

test('on a Mac that cannot deliver native notifications the switch follows the saved flag; off reads as blocked system notifications', async () => {
  setLocale('en');
  main.reset(blockedMac);
  const settings = await openSettings();
  const cause = '8 other copies of TipATask are registered with macOS under the same identifier — including one on the '
    + 'mounted installer disk “TipATask 0.9.19-arm64”. Eject it, then use Repair and quit and reopen TipATask.';
  // Off is system notifications only — no desktop banners stand in — so the row says they are
  // blocked and why, with Repair.
  const off = { badge: 'blocked', row: true, checked: false, disabled: false, notice: cause, repair: true, style: true };
  assert.deepEqual(await settings.populate(), off);
  assert.doesNotMatch(settings.el('settings-notifications-hint-text').textContent, /desktop banners/);
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

test('with the switch off the notice names each cause and offers Repair only for duplicate registrations', async () => {
  setLocale('en');
  const settings = await openSettings();
  const delivered = bridge.sendResult;
  try {
    main.reset({ ...blockedMac, registration: { conflicts: 1, installerVolumes: ['/Volumes/Installer/TipATask.app'], repair: null } });
    let view = await settings.populate();
    assert.equal(view.notice, '1 other copy of TipATask is registered with macOS under the same identifier — on the '
      + 'mounted installer disk “Installer”. Eject it, then use Repair and quit and reopen TipATask.');
    assert.equal(view.repair, true);

    main.reset({ ...blockedMac, registration: { conflicts: 3, installerVolumes: [], repair: null } });
    view = await settings.populate();
    assert.equal(view.notice, tc('settings.notifHintDuplicateBundles', 3));
    assert.equal(view.repair, true);

    main.reset({ ...blockedMac, registration: { conflicts: 0, installerVolumes: [], repair: null } });
    view = await settings.populate();
    assert.equal(view.notice, t('settings.notifHintNotRegistered'));
    assert.equal(view.repair, false, 'nothing to repair without a competing copy');

    // A failed Repair keeps its blocker, and the button, on screen for the retry.
    const repair = { ok: false, outcome: 'blocked-installer', registration: { installerVolumes: ['/Volumes/Installer/TipATask.app'] } };
    main.reset({ ...blockedMac, registration: { conflicts: 1, installerVolumes: ['/Volumes/Installer/TipATask.app'], repair } });
    view = await settings.populate();
    assert.equal(view.notice, registrationRepairMessage(repair, t));
    assert.equal(view.repair, true);

    // A system notification macOS refused, with nothing wrong in the bundle health.
    main.reset({ enabled: false });
    bridge.sendResult = { ok: false, reason: 'failed' };
    assert.deepEqual(await sendTestNotification('Test', 'Body'), { ok: false, reason: 'failed' });
    view = await settings.populate();
    assert.equal(view.badge, 'blocked');
    assert.equal(view.notice, t('settings.notifHintBlocked'));
    assert.equal(view.repair, false);

    // The health explains a refused send once it is known.
    main.reset(blockedMac);
    view = await settings.populate();
    assert.equal(getNotificationStatus().lastError, 'not-registered');
    assert.match(view.notice, /^8 other copies of TipATask/);
    assert.equal(view.repair, true);
  } finally {
    // A later successful send clears the transport error for the tests that follow.
    bridge.sendResult = delivered;
    main.reset();
    await sendTestNotification('Test', 'Body');
    await settings.close();
  }
});

test('a desktop banner that could not be shown is what the row reports', async () => {
  setLocale('en');
  main.reset({ ...blockedMac, enabled: true });
  const settings = await openSettings();
  const delivered = bridge.sendResult;
  try {
    assert.deepEqual(await settings.populate(), { badge: 'desktop banners', row: true, checked: true, disabled: false,
      notice: null, repair: false, style: false }, 'banners do not depend on the native registration');

    // The banner itself failed: nothing reaches the user, so that is what the row reports.
    bridge.sendResult = { ok: false, reason: 'desktop-unavailable' };
    assert.deepEqual(await sendTestNotification('Test', 'Body'), { ok: false, reason: 'desktop-unavailable' });
    let view = await settings.populate();
    assert.equal(view.badge, 'blocked');
    assert.equal(view.notice, t('settings.notifHintDesktopFailed'));
    assert.equal(view.repair, false, 'Repair does not fix a banner that cannot be shown');
    assert.equal(settings.toggle.getAttribute('aria-describedby'), 'settings-notifications-ontop-hint');
    assert.equal(view.checked, true, 'the switch still shows the saved choice');

    bridge.sendResult = { ok: true, id: '2', delivery: 'desktop' };
    assert.deepEqual(await sendTestNotification('Test', 'Body'), { ok: true });
    view = await settings.populate();
    assert.equal(view.badge, 'desktop banners');
    assert.equal(view.notice, null);
  } finally {
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
  const status = bridge.notifyStatus;
  const settings = await openSettings();
  const closed = await openSettings({ open: false });
  try {
    await settings.populate();
    main.flip(false);
    assert.equal(settings.toggle.checked, false, 'the switch follows at once, before the status re-read');
    await settle();
    assert.deepEqual(settings.view(), { badge: 'system', row: true, checked: false, disabled: false,
      notice: null, repair: false, style: true });
    assert.deepEqual(main.writes, [], 'following a flip writes nothing back');
    main.flip(true);
    assert.equal(settings.toggle.checked, true);
    await settle();
    await settings.close();

    await closed.populate();
    let reads = 0;
    bridge.notifyStatus = async () => { reads += 1; return main.status(); };
    main.flip(false);
    await settle();
    assert.equal(reads, 0, 'a closed dialog re-reads on its next open instead');
    assert.equal(closed.toggle.checked, true);
    // Its next open shows the flip at once, before any read answers.
    closed.el('settings-modal').classList.add('open');
    const reopened = closed.startPopulate();
    assert.equal(closed.toggle.checked, false);
    await reopened;
  } finally {
    bridge.notifyStatus = status;
    await settings.close();
    await closed.close();
  }
});

test('notifications.js keeps the choice main last stated, from every channel', async () => {
  const originals = { ...bridge };
  try {
    main.reset();
    await refreshNotificationStatus();
    assert.equal(canSetNotificationsOnTop(), true);
    assert.equal(getNotificationsOnTop(), true);
    assert.equal(getNotificationStatus().onTop, true);

    // A write is the known choice at once; main's answer confirms it. The delivery it leads to
    // comes with the next status read.
    const write = setNotificationsOnTop(false);
    assert.equal(getNotificationsOnTop(), false, 'at once');
    assert.deepEqual(await write, { ok: true, enabled: false });
    assert.deepEqual(main.writes, [false]);
    await refreshNotificationStatus();
    assert.equal(getNotificationStatus().onTop, false);
    assert.equal(getNotificationStatus().delivery, 'native');
    await setNotificationsOnTop('yes');
    assert.deepEqual(main.writes, [false, false], 'only a real true switches it on');

    // A read asked before a write answers for the moment before it: it never undoes the write.
    let answer;
    const quick = bridge.getNotificationsOnTop;
    bridge.getNotificationsOnTop = () => new Promise((resolve) => { answer = resolve; });
    const read = readNotificationsOnTop();
    const turnOn = setNotificationsOnTop(true);
    answer({ ok: true, enabled: false });
    assert.equal(await read, true);
    await turnOn;
    assert.equal(getNotificationsOnTop(), true);
    // Nor a broadcast (the banner's box, the menu, another window's switch).
    const status = bridge.notifyStatus;
    bridge.notifyStatus = () => new Promise((resolve) => { answer = resolve; });
    const statusRead = refreshNotificationStatus();
    main.flip(false);
    answer({ delivery: 'desktop', available: true, onTop: true });
    await statusRead;
    assert.equal(getNotificationsOnTop(), false);
    bridge.notifyStatus = status;
    bridge.getNotificationsOnTop = quick;

    // A write that never reached the flag puts back the choice main kept.
    main.answer = () => ({ ok: false, reason: 'untrusted_sender' });
    assert.deepEqual(await setNotificationsOnTop(true), { ok: false, reason: 'untrusted_sender' });
    assert.equal(getNotificationsOnTop(), false);
    main.answer = null;

    // Main without a controller has no choice; an older preload without the quick read keeps the
    // one known before.
    main.readAnswer = () => ({ ok: false, reason: 'unavailable' });
    assert.equal(await readNotificationsOnTop(), null);
    main.readAnswer = null;
    assert.equal(await readNotificationsOnTop(), false);
    delete bridge.getNotificationsOnTop;
    main.enabled = true;
    assert.equal(await readNotificationsOnTop(), false);
    bridge.getNotificationsOnTop = quick;
    assert.equal(await readNotificationsOnTop(), true);

    // Every listener hears each change after the choice already holds it.
    const heard = [];
    const stop = onNotificationsOnTopChange((enabled) => heard.push([enabled, getNotificationsOnTop()]));
    main.flip(false);
    main.flip(true);
    stop();
    main.flip(false);
    assert.deepEqual(heard, [[false, false], [true, true]]);

    const { setNotificationsOnTop: writer } = bridge;
    delete bridge.setNotificationsOnTop;
    assert.equal(canSetNotificationsOnTop(), false);
    assert.deepEqual(await setNotificationsOnTop(true), { ok: false, reason: 'unsupported' });
    bridge.setNotificationsOnTop = writer;
  } finally {
    Object.assign(bridge, originals);
    main.answer = null;
    main.readAnswer = null;
  }
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
  for (const key of ['settings.notifOnTop', 'settings.notifOnTopHint', 'settings.notifOnTopFailed', 'settings.notifOnTopNotSaved']) {
    for (const [locale, table] of Object.entries(LOCALES)) {
      assert.ok(table[key]?.trim(), `${locale}.${key}`);
      if (locale !== 'en') assert.notEqual(table[key], LOCALES.en[key], `${locale}.${key} is translated`);
    }
  }
  // A short label and a one-line hint: one sentence, no line break.
  assert.equal(LOCALES.en['settings.notifOnTop'], 'Always-on-top notifications');
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.ok(table['settings.notifOnTop'].length <= 32, `${locale}: short label`);
    const hint = table['settings.notifOnTopHint'];
    assert.doesNotMatch(hint, /\n/, `${locale}: one line`);
    assert.equal((hint.match(/[.。]/g) || []).length, 1, `${locale}: one sentence`);
    assert.ok(hint.length <= 60, `${locale}: short hint`);
  }
  // No copy says alerts "still arrive as desktop banners" while the switch is off: they never do.
  for (const [locale, table] of Object.entries(LOCALES)) {
    for (const key of ['settings.notifHintFallback', 'settings.notifHintFallbackCheck']) {
      assert.equal(key in table, false, `${locale}.${key} is gone`);
    }
  }
  assert.match(source, /\['settings-notifications-ontop-label', 'settings\.notifOnTop'\]/);
  assert.match(source, /\['settings-notifications-ontop-hint', 'settings\.notifOnTopHint'\]/);
});

test('the localized dialog names the switch and its hint in every locale', async () => {
  main.reset();
  const settings = await openSettings();
  try {
    for (const locale of Object.keys(LOCALES)) {
      setLocale(locale);
      settings.localize();
      assert.equal(settings.el('settings-notifications-ontop-label').textContent, LOCALES[locale]['settings.notifOnTop'], locale);
      assert.equal(settings.el('settings-notifications-ontop-hint').textContent, LOCALES[locale]['settings.notifOnTopHint'], locale);
    }
    setLocale('en');
    settings.localize();
    const label = settings.el('settings-notifications-ontop-label');
    assert.equal(label.textContent, 'Always-on-top notifications');
    assert.equal(label.getAttribute('for'), 'settings-notifications-ontop', 'the label names the switch');
    assert.equal(settings.el('settings-notifications-ontop-hint').textContent, 'When off, alerts use system notifications.');
  } finally {
    setLocale('en');
    await settings.close();
  }
});
