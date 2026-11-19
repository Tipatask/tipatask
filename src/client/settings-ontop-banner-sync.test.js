// Settings ▸ General ▸ Notifications "Always-on-top notifications" end to end: the real Settings
// rows and switch wiring (task-board.js, vm-run against the real template), the real
// notifications.js, main.js's real notify:status / notify:get-on-top / notify:set-on-top handlers,
// applyNotificationsOnTop() and notificationsMenu(), and the real desktop-notification controller
// with its banner window. Flipping the switch takes the banner away or brings it back at once,
// the banner's "Show" box and View ▸ Notifications follow, and the switch follows them.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';
import { Window } from 'happy-dom';

const require = createRequire(import.meta.url);
const { offStatus } = require('../../main/notify-status.js');
const { createDesktopNotifications } = require('../../main/desktop-notifications.js');

const mainSource = readFileSync(new URL('../../main.js', import.meta.url), 'utf8');
const mainFunction = (name) => mainSource.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0];
const mainSlice = (from, to) => {
  const start = mainSource.indexOf(from);
  const end = mainSource.indexOf(to, start);
  assert.ok(start > 0 && end > start, `main.js still has ${from.trim()}`);
  return mainSource.slice(start, end);
};
// Main answers on a later task; what it sent while handling the call arrives first.
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// Electron stand-ins: the banner is a BrowserWindow the controller creates; project windows only
// need webContents.send. The Settings dialog lives in project window `a`.
const all = [];
let wcSeq = 900;
class BrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.visible = false;
    this.webContents = Object.assign(new EventEmitter(), { id: ++wcSeq, mainFrame: {}, states: [],
      isDestroyed: () => false, setWindowOpenHandler() {},
      send: (channel, data) => { if (channel === 'notify:desktop-state') this.webContents.states.push(data); } });
    all.push(this);
  }
  static getAllWindows() { return all.filter((w) => !w.isDestroyed()); }
  static fromId() { return null; }
  isDestroyed() { return !!this.destroyed; }
  setMenu() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setBounds() {}
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  async loadFile() {}
}
const rendererOnTopListeners = new Set();
const projectWindow = (projectPath, renderer = false) => {
  const w = { projectPath, isDestroyed: () => false, isFocused: () => false,
    webContents: { id: ++wcSeq, sent: [], isDestroyed: () => false,
      send(channel, data) {
        this.sent.push({ channel, data });
        // Delivered to the Settings window's renderer as an IPC message: copied, on a later task.
        if (renderer && channel === 'notify:on-top-changed') {
          const message = structuredClone(data);
          setImmediate(() => { for (const cb of [...rendererOnTopListeners]) cb(message); });
        }
      } } };
  all.push(w);
  return w;
};
const a = projectWindow('/a', true);
const b = projectWindow('/b');
const projectDirs = new Map([[a.webContents.id, '/a'], [b.webContents.id, '/b']]);
const display = { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display });

// main.js: the real handlers and writer, on a Mac whose native notifications macOS refuses
// (8 competing registrations, one on a mounted installer disk).
const handlers = new Map();
const ipcMain = Object.assign(new EventEmitter(), { handle: (channel, cb) => { handlers.set(channel, cb); } });
const menus = [];
const main = vm.createContext({
  console: { warn() {}, log() {} },
  BrowserWindow, projectDirs, ipcMain, PORT: 4455, APP_ORIGIN: 'http://127.0.0.1:4455', mt: (key) => key, desktopNotifications: null,
  isTrustedTopFrame: (event) => projectDirs.has(event?.sender?.id),
  notifyStatus: { offStatus }, Notification: { isSupported: () => true },
  refreshBundleSignatureState: async () => {},
  _bundleSignatureState: { valid: true, reason: null, relaunchNeeded: false },
  _ncRegistrationState: false,
  _lsRegistrationState: { conflicts: 8, installerVolumes: ['/Volumes/TipATask 0.9.21-arm64/TipATask.app'], repair: null },
});
main.createMenu = () => menus.push(main.notificationsMenu().submenu[0].checked);
vm.runInContext([mainFunction('applyNotificationsOnTop'), mainFunction('notificationsMenu'),
  mainSlice("  ipcMain.handle('notify:status'", '  // Settings Repair verifies'),
  mainSlice("  ipcMain.handle('notify:get-on-top'", "  ipcMain.handle('notify:dismiss-task'")].join('\n'), main);
const dir = mkdtempSync(join(tmpdir(), 'tpt9328-switch-'));
const settingsFile = join(dir, 'desktop-notifications.json');
const surface = createDesktopNotifications({ BrowserWindow, screen, ipcMain, settingsFile, Notification: null,
  onClick() {}, onDismiss() {}, projectWindows: () => [a, b], onSetOnTop: (on) => main.applyNotificationsOnTop(on) });
main.desktopNotifications = surface;
const banner = () => all.find((w) => w instanceof BrowserWindow);
// What the banner page draws its "Show" box from (notification-page.js).
const bannerBox = () => banner()?.webContents.states.at(-1)?.onTop;
const saved = () => JSON.parse(readFileSync(settingsFile, 'utf8')).desktopNotificationsEnabled;

// The Settings window's preload bridge: ipcRenderer.invoke into those handlers. Each answer is
// recorded with the banner as main left it the moment the call was handled.
const answered = [];
const invoke = (channel, ...args) => new Promise((resolve, reject) => {
  Promise.resolve().then(() => {
    const value = handlers.get(channel)({ sender: a.webContents, senderFrame: {} }, ...args);
    answered.push({ channel, args: structuredClone(args), banner: { visible: banner()?.visible ?? false, box: bannerBox() ?? null,
      menu: menus.at(-1) ?? null } });
    return value;
  }).then((value) => setImmediate(() => resolve(structuredClone(value))), (error) => setImmediate(() => reject(error)));
});
globalThis.window = { electronAPI: {
  notificationDelivery: 'desktop',
  notify: async () => ({ ok: true, delivery: 'desktop' }),
  notifyStatus: () => invoke('notify:status'),
  getNotificationsOnTop: () => invoke('notify:get-on-top'),
  setNotificationsOnTop: (enabled) => invoke('notify:set-on-top', { enabled: enabled === true }),
  onNotificationsOnTopChanged: (cb) => { rendererOnTopListeners.add(cb); return () => rendererOnTopListeners.delete(cb); },
  getProjectPath: () => '/a',
} };
const { getNotificationStatus, refreshNotificationStatus, registrationRepairMessage, setNotificationsOnTop,
  getNotificationsOnTop, readNotificationsOnTop, onNotificationsOnTopChange } = await import('./notifications.js?banner-sync');
const { setLocale, t, tc } = await import('./i18n.js');

const source = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const productionFunction = (name) => source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0];
const wiring = source.slice(source.indexOf("  const notifOnTopToggle = modal.querySelector('#settings-notifications-ontop');"),
  source.indexOf('  // (C1259) Debug ▸ click-to-render perf logging toggle'));

async function openSettings() {
  const page = new Window();
  page.electronAPI = { platform: 'darwin', setNotificationsOnTop: window.electronAPI.setNotificationsOnTop };
  page.document.body.innerHTML = template.slice(template.indexOf('<div id="settings-modal"'), template.indexOf('<!-- (C1388)'));
  const unsubscribe = [];
  const toasts = [];
  const context = vm.createContext({ document: page.document, window: page, t, tc, registrationRepairMessage,
    getNotificationStatus, refreshNotificationStatus, setNotificationsOnTop, getNotificationsOnTop, readNotificationsOnTop,
    onNotificationsOnTopChange: (cb) => { const stop = onNotificationsOnTopChange(cb); unsubscribe.push(stop); return stop; },
    showToast: (message, kind) => toasts.push({ message, kind }) });
  vm.runInContext(`${productionFunction('_notifStatusKey')}\n${productionFunction('_renderSettingsOnTopSwitch')}\n`
    + `${productionFunction('_populateSettingsNotificationsRows')}\nconst modal = document.getElementById('settings-modal');\n${wiring}`, context);
  const el = (id) => page.document.getElementById(id);
  el('settings-modal').classList.add('open');
  const toggle = el('settings-notifications-ontop');
  return {
    toasts,
    view: () => ({ row: !el('settings-notifications-ontop-row').hidden, checked: toggle.checked, disabled: toggle.disabled,
      badge: el('settings-notifications-state').textContent }),
    populate: () => context._populateSettingsNotificationsRows(),
    async setSwitch(on) {
      toggle.checked = on;
      toggle.dispatchEvent(new page.Event('change', { bubbles: true }));
      await settle();
    },
    async close() { for (const stop of unsubscribe) stop(); await page.happyDOM.close(); },
  };
}

test('the switch takes the banner away and brings it back at once; the banner box and View menu follow it, and it follows them', async () => {
  setLocale('en');
  const origin = { windowId: 1, projectPath: '/a' };
  const settings = await openSettings();
  try {
    // Show on Top on; the two alerts from the report on the banner (another app is focused).
    await surface.show({ title: 'PHT300 Print 0.00 VAT and outside-EU lines', body: 'Task completed', tag: 'PHT300',
      notificationId: 'n300', category: 'completed' }, origin);
    await surface.show({ title: 'PHT299 Non-EU VAT treatment: 0.00 VAT', body: 'Task completed', tag: 'PHT299',
      notificationId: 'n299', category: 'completed' }, origin);
    assert.equal(banner().visible, true);
    assert.equal(bannerBox(), true, 'a banner on screen shows its "Show" box checked');
    await settings.populate();
    assert.deepEqual(settings.view(), { row: true, checked: true, disabled: false, badge: 'desktop banners' });

    // Off from Settings: by the time main answers, the banner is gone, its box and the menu are off.
    answered.length = 0;
    await settings.setSwitch(false);
    const write = answered.find((call) => call.channel === 'notify:set-on-top');
    assert.deepEqual(write, { channel: 'notify:set-on-top', args: [{ enabled: false }],
      banner: { visible: false, box: false, menu: false } });
    assert.equal(saved(), false, 'kept for the next launch');
    assert.deepEqual(settings.view(), { row: true, checked: false, disabled: false, badge: 'blocked' },
      'off is system notifications, which this Mac refuses');
    assert.deepEqual(settings.toasts, []);
    // TPT9327: while off, later alerts and the cards windows mirror never bring the banner back.
    assert.deepEqual({ ...(await surface.show({ title: 'PHT301 Later', tag: 'PHT301', notificationId: 'n301' }, origin)) },
      { ok: false, reason: 'unsupported' });
    assert.deepEqual({ ...surface.upsertCard({ tag: 'PHT300', title: 'PHT300 Print 0.00 VAT', seq: 1 }, origin) },
      { ok: true, delivery: 'disabled' });
    surface.syncNotificationSurface({ immediate: true });
    await settle();
    assert.equal(banner().visible, false);

    // On from Settings: the menu and the banner's box follow at once, every project window is told
    // to share its in-app cards again, and the first card it shares is on the banner, box checked.
    answered.length = 0;
    await settings.setSwitch(true);
    assert.deepEqual(answered.find((call) => call.channel === 'notify:set-on-top').banner,
      { visible: false, box: true, menu: true }, 'nothing to show until a card is shared');
    assert.equal(saved(), true);
    assert.equal(a.webContents.sent.filter((m) => m.channel === 'notify:surface').at(-1).data.shared, true);
    surface.upsertCard({ tag: 'PHT300', title: 'PHT300 Print 0.00 VAT and outside-EU lines', category: 'completed', seq: 1 }, origin);
    await settle();
    assert.equal(banner().visible, true);
    assert.equal(bannerBox(), true);
    assert.deepEqual(settings.view(), { row: true, checked: true, disabled: false, badge: 'desktop banners' });

    // Unchecking "Show" on the banner: the banner goes and the open switch follows.
    const writes = () => answered.filter((call) => call.channel === 'notify:set-on-top').length;
    const before = writes();
    ipcMain.emit('notify:desktop-action', { sender: banner().webContents, senderFrame: banner().webContents.mainFrame },
      { id: null, action: 'on-top-off' });
    assert.equal(banner().visible, false);
    assert.equal(menus.at(-1), false);
    await settle();
    assert.deepEqual(settings.view(), { row: true, checked: false, disabled: false, badge: 'blocked' });

    // View ▸ Notifications ▸ Show on Top of Other Apps turns it back on: the switch follows.
    main.notificationsMenu().submenu[0].click({ checked: true });
    assert.equal(bannerBox(), true);
    await settle();
    assert.deepEqual(settings.view(), { row: true, checked: true, disabled: false, badge: 'desktop banners' });
    assert.equal(writes(), before, 'following the banner and the menu writes nothing back');
    assert.equal(getNotificationsOnTop(), true);
  } finally {
    await settings.close();
    surface.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
