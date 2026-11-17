'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { offStatus } = require('../../main/notify-status');
const { createDesktopNotifications } = require('../../main/desktop-notifications');

const mainSource = () => fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
const mainFunction = (source, name) => source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0];

test('off status reports native delivery with the bundle health behind it', () => {
  let asked = 0;
  const status = offStatus({ supported: () => { asked += 1; return true; },
    signature: { valid: true, reason: null, relaunchNeeded: false }, registered: true,
    registration: { conflicts: 0, installerVolumes: [], repair: null } });
  assert.deepEqual(status, { delivery: 'native', onTop: false, available: true, valid: true, reason: null,
    relaunchNeeded: false, registered: true, conflicts: 0, installerVolumes: [], registrationRepair: null });
  assert.equal(asked, 1);
  assert.equal(offStatus({ supported: () => false }).available, false);
  assert.equal(offStatus({ supported: () => { throw new Error('no presenter'); } }).available, false);
  assert.deepEqual(offStatus(), { delivery: 'native', onTop: false, available: true, valid: null,
    reason: 'not-checked', relaunchNeeded: false, registered: null, conflicts: null, installerVolumes: [],
    registrationRepair: null });
});

test('off status stays native delivery when macOS cannot deliver: the banner never stands in', () => {
  const repair = { ok: false, outcome: 'blocked-installer' };
  const status = offStatus({ supported: () => true,
    signature: { valid: true, reason: null, relaunchNeeded: false }, registered: false,
    registration: { conflicts: 8, installerVolumes: ['/Volumes/TipATask 0.9.19-arm64/TipATask.app'], repair } });
  assert.deepEqual(status, { delivery: 'native', onTop: false, available: true, valid: true,
    reason: null, relaunchNeeded: false, registered: false, conflicts: 8,
    installerVolumes: ['/Volumes/TipATask 0.9.19-arm64/TipATask.app'], registrationRepair: repair });
  assert.equal('fallback' in status, false);
});

// main.js wiring: the handler answers with the saved choice and, while it is off, the health.
test('notify:status reports native delivery while off, re-read after the bundle health refresh', async () => {
  const source = mainSource();
  const start = source.indexOf("  ipcMain.handle('notify:status'");
  const end = source.indexOf("  // Settings Repair verifies", start);
  assert.ok(start > 0 && end > start);
  let handler;
  const order = [];
  const state = { enabled: false };
  const context = {
    ipcMain: { handle: (_channel, cb) => { handler = cb; } },
    notifyStatus: { offStatus },
    Notification: { isSupported: () => { order.push('supported'); return true; } },
    refreshBundleSignatureState: async () => { order.push('refresh'); },
    desktopNotifications: { isEnabled: () => state.enabled },
    _bundleSignatureState: { valid: true, reason: null, relaunchNeeded: false },
    _ncRegistrationState: false,
    _lsRegistrationState: { conflicts: 8, installerVolumes: ['/Volumes/X/TipATask.app'], repair: null },
  };
  vm.runInNewContext(source.slice(start, end), context);

  let status = await handler();
  assert.deepEqual(order, ['refresh', 'supported']);
  assert.equal(status.delivery, 'native', 'off is native delivery, even with Notification Center refusing the bundle');
  assert.equal('fallback' in status, false);
  assert.equal(status.onTop, false, 'the saved choice travels with the delivery');
  assert.equal(status.registered, false);
  assert.equal(status.conflicts, 8);

  state.enabled = true;
  order.length = 0;
  assert.deepEqual({ ...(await handler()) }, { delivery: 'desktop', available: true, onTop: true });
  assert.deepEqual(order, [], 'Show on Top on needs no bundle health');

  // Switched on while the health refresh of an "off" read is still running: the answer reports
  // the choice as it is now, never the one the read started with.
  state.enabled = false;
  order.length = 0;
  context.refreshBundleSignatureState = async () => { order.push('refresh'); state.enabled = true; };
  assert.deepEqual({ ...(await handler()) }, { delivery: 'desktop', available: true, onTop: true });
  assert.deepEqual(order, ['refresh']);

  context.desktopNotifications = null;
  status = await handler();
  assert.equal(status.delivery, 'desktop');
  assert.equal('onTop' in status, false, 'no controller, no known choice');
});

// Settings ▸ Notifications reads the choice on its own: at once, never behind the bundle-health
// refresh that notify:status runs while it is off.
test('notify:get-on-top answers the saved choice at once, for a trusted project window only', () => {
  const source = mainSource();
  const start = source.indexOf("  ipcMain.handle('notify:get-on-top'");
  const end = source.indexOf("  ipcMain.handle('notify:set-on-top'", start);
  assert.ok(start > 0 && end > start);
  let handler;
  let trusted = true;
  let refreshed = 0;
  const seen = [];
  const state = { enabled: false };
  const context = {
    ipcMain: { handle: (channel, cb) => { assert.equal(channel, 'notify:get-on-top'); handler = cb; } },
    isTrustedTopFrame: (event, deps) => { seen.push({ event, deps }); return trusted; },
    BrowserWindow: {}, projectDirs: new Map(), PORT: 4455,
    refreshBundleSignatureState: async () => { refreshed += 1; },
    desktopNotifications: { isEnabled: () => state.enabled },
  };
  vm.runInNewContext(source.slice(start, end), context);

  const event = { sender: { id: 7 } };
  // Spread: a promise would spread to {} — the answer is there at once.
  assert.deepEqual({ ...handler(event) }, { ok: true, enabled: false });
  state.enabled = true;
  assert.deepEqual({ ...handler(event) }, { ok: true, enabled: true });
  assert.equal(refreshed, 0, 'no bundle-health refresh, whatever the choice');
  assert.equal(seen[0].event, event);
  assert.equal(seen[0].deps.appOrigin, 'http://127.0.0.1:4455');
  trusted = false;
  assert.deepEqual({ ...handler(event) }, { ok: false, reason: 'untrusted_sender' });
  trusted = true;
  context.desktopNotifications = null;
  assert.deepEqual({ ...handler(event) }, { ok: false, reason: 'unavailable' }, 'no controller, no choice');
});

// Settings ▸ Notifications switch: the same writer as the menu checkbox and the banner's box.
test('notify:set-on-top writes the flag for a trusted project window only', () => {
  const source = mainSource();
  const start = source.indexOf("  ipcMain.handle('notify:set-on-top'");
  const end = source.indexOf("  ipcMain.handle('notify:dismiss-task'", start);
  assert.ok(start > 0 && end > start);
  let handler;
  let trusted = true;
  const writes = [];
  const seen = [];
  const context = {
    ipcMain: { handle: (channel, cb) => { assert.equal(channel, 'notify:set-on-top'); handler = cb; } },
    isTrustedTopFrame: (event, deps) => { seen.push({ event, deps }); return trusted; },
    BrowserWindow: {}, projectDirs: new Map(), PORT: 4455,
    applyNotificationsOnTop: (on) => { writes.push(on); return { ok: true, enabled: on }; },
  };
  vm.runInNewContext(source.slice(start, end), context);

  const event = { sender: { id: 7 } };
  assert.deepEqual({ ...handler(event, { enabled: false }) }, { ok: true, enabled: false });
  assert.deepEqual({ ...handler(event, { enabled: true }) }, { ok: true, enabled: true });
  assert.deepEqual(writes, [false, true]);
  assert.equal(seen[0].event, event);
  assert.equal(seen[0].deps.appOrigin, 'http://127.0.0.1:4455');

  for (const payload of [undefined, null, {}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }]) {
    assert.deepEqual({ ...handler(event, payload) }, { ok: false, reason: 'invalid_value' });
  }
  trusted = false;
  assert.deepEqual({ ...handler(event, { enabled: true }) }, { ok: false, reason: 'untrusted_sender' });
  assert.deepEqual(writes, [false, true], 'neither a bad value nor an untrusted sender reaches the writer');
});

test('the Settings switch, the menu checkbox and the banner box share one writer and one broadcast', () => {
  const source = mainSource();
  assert.match(source, /onSetOnTop: \(on\) => applyNotificationsOnTop\(on\)/);
  assert.match(mainFunction(source, 'notificationsMenu'), /click: \(mi\) => \{ applyNotificationsOnTop\(mi\.checked\); \}/);
  const preload = fs.readFileSync(path.join(__dirname, '../../preload.js'), 'utf8');
  assert.match(preload, /setNotificationsOnTop: \(enabled\) => inv\('notify:set-on-top', \{ enabled: enabled === true \}\)/);
  assert.match(preload, /getNotificationsOnTop: \(\) => inv\('notify:get-on-top'\)/);
  assert.match(preload, /ipcRenderer\.on\('notify:on-top-changed', handler\)/);
  // No banner stand-in for blocked native delivery is wired up any more.
  assert.doesNotMatch(source, /nativeBlocked|refreshDelivery|desktopNotifications\.delivery\(/);
});

// main.js's real applyNotificationsOnTop() and notificationsMenu() against the real controller:
// a click on the banner's "Show" box (or the menu item, or the Settings switch) must re-send the
// banner its state, rebuild the menu checkbox and reach every project window — in both directions.
test('every Show on Top toggle re-sends the banner state, rebuilds the menu and tells each project window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpt9327-writer-'));
  const settingsFile = path.join(dir, 'desktop-notifications.json');
  const all = [];
  let wcSeq = 500;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.webContents = Object.assign(new EventEmitter(), { id: ++wcSeq, mainFrame: {}, states: [], channels: [],
        isDestroyed: () => false, setWindowOpenHandler() {},
        send: (channel, data) => {
          this.webContents.channels.push(channel);
          if (channel === 'notify:desktop-state') this.webContents.states.push(data);
        } });
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
  const projectWindow = (projectPath) => {
    const w = { projectPath, isDestroyed: () => false, isFocused: () => false,
      webContents: { id: ++wcSeq, sent: [], isDestroyed: () => false, send(channel, data) { this.sent.push({ channel, data }); } } };
    all.push(w);
    return w;
  };
  const a = projectWindow('/a');
  const b = projectWindow('/b');
  const ipcMain = new EventEmitter();
  const display = { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display });

  const menus = [];
  const source = mainSource();
  const context = vm.createContext({
    console: { warn() {} },
    BrowserWindow,
    projectDirs: new Map([[a.webContents.id, '/a'], [b.webContents.id, '/b']]),
    mt: (key) => key,
    desktopNotifications: null,
  });
  context.createMenu = () => menus.push(context.notificationsMenu().submenu[0].checked);
  vm.runInContext(`${mainFunction(source, 'applyNotificationsOnTop')}\n${mainFunction(source, 'notificationsMenu')}`, context);
  const surface = createDesktopNotifications({ BrowserWindow, screen, ipcMain, settingsFile, Notification: null,
    onClick() {}, onDismiss() {}, projectWindows: () => [a, b],
    onSetOnTop: (on) => context.applyNotificationsOnTop(on) });
  context.desktopNotifications = surface;
  // Spread: the writer builds its payload in the vm's realm.
  const onTopChanged = (w) => w.webContents.sent.filter((m) => m.channel === 'notify:on-top-changed').map((m) => ({ ...m.data }));
  try {
    await surface.show({ title: 'T1', tag: 'TPT1', notificationId: 'n1' }, { windowId: 1, projectPath: '/a' });
    await surface.show({ title: 'T2', tag: 'TPT2', notificationId: 'n2' }, { windowId: 1, projectPath: '/b' });
    const banner = all.find((w) => w instanceof BrowserWindow);
    assert.equal(banner.visible, true);
    assert.equal(banner.webContents.states.at(-1).onTop, true, 'the banner box shows checked');
    const bannerAct = (action) => ipcMain.emit('notify:desktop-action',
      { sender: banner.webContents, senderFrame: banner.webContents.mainFrame }, { id: null, action });

    // Unchecking "Show" on the banner itself.
    let states = banner.webContents.states.length;
    bannerAct('on-top-off');
    assert.equal(banner.webContents.states.length, states + 1, 'the banner is re-sent its state');
    assert.deepEqual(banner.webContents.states.at(-1), { entries: [], theme: null, onTop: false });
    assert.equal(banner.visible, false);
    assert.deepEqual(menus, [false], 'View ▸ Notifications is rebuilt unchecked');
    assert.deepEqual([onTopChanged(a), onTopChanged(b)], [[{ enabled: false }], [{ enabled: false }]],
      'every project window hears it (an open Settings dialog follows)');
    assert.equal(banner.webContents.channels.includes('notify:on-top-changed'), false, 'the banner is not a project window');
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).desktopNotificationsEnabled, false);
    // Off sticks: a later alert (no native notifications on this platform) leaves the banner down.
    assert.deepEqual(await surface.show({ title: 'T3', tag: 'TPT3', notificationId: 'n3' }, { windowId: 1, projectPath: '/a' }),
      { ok: false, reason: 'unsupported' });
    assert.equal(banner.visible, false);

    // The menu item (or the Settings switch — both call the same writer) turns it back on.
    states = banner.webContents.states.length;
    context.notificationsMenu().submenu[0].click({ checked: true });
    assert.equal(banner.webContents.states.length, states + 1);
    assert.equal(banner.webContents.states.at(-1).onTop, true);
    assert.deepEqual(menus, [false, true]);
    assert.deepEqual(onTopChanged(a).at(-1), { enabled: true });
    assert.deepEqual(onTopChanged(b).at(-1), { enabled: true });

    // A stale check on the banner (on-top-on) and the same value written again still re-send.
    for (const step of [() => bannerAct('on-top-on'), () => context.applyNotificationsOnTop(true)]) {
      states = banner.webContents.states.length;
      step();
      assert.equal(banner.webContents.states.length, states + 1);
      assert.equal(banner.webContents.states.at(-1).onTop, true);
    }
    assert.deepEqual(menus, [false, true, true, true]);
    assert.equal(onTopChanged(a).length, 4);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).desktopNotificationsEnabled, true);
  } finally {
    surface.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
