'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { nativeDeliveryBlocker, offStatus } = require('../../main/notify-status');

test('a native notification is blocked by a broken seal or a missing Notification Center registration', () => {
  assert.equal(nativeDeliveryBlocker(), null);
  assert.equal(nativeDeliveryBlocker({ signature: null, registered: null }), null, 'health never read is not a blocker');
  assert.equal(nativeDeliveryBlocker({ signature: { valid: null, reason: 'check-failed' }, registered: null }), null);
  assert.equal(nativeDeliveryBlocker({ signature: { valid: true }, registered: true }), null);
  assert.equal(nativeDeliveryBlocker({ signature: { valid: true }, registered: false }), 'not-registered');
  assert.equal(nativeDeliveryBlocker({ signature: { valid: false }, registered: false }), 'seal-broken');
  assert.equal(nativeDeliveryBlocker({ signature: { signed: false, valid: false }, registered: false }), 'unsigned');
});

test('off status reports native delivery with the bundle health behind it', () => {
  let asked = 0;
  const status = offStatus({ delivery: 'native', fallback: null, supported: () => { asked += 1; return true; },
    signature: { valid: true, reason: null, relaunchNeeded: false }, registered: true,
    registration: { conflicts: 0, installerVolumes: [], repair: null } });
  assert.deepEqual(status, { delivery: 'native', onTop: false, available: true, valid: true, reason: null,
    relaunchNeeded: false, registered: true, conflicts: 0, installerVolumes: [], registrationRepair: null });
  assert.equal(asked, 1);
  assert.equal(offStatus({ delivery: 'native', supported: () => false }).available, false);
  assert.equal(offStatus({ delivery: 'native', supported: () => { throw new Error('no presenter'); } }).available, false);
  assert.deepEqual(offStatus({ delivery: 'native' }), { delivery: 'native', onTop: false, available: true, valid: null,
    reason: 'not-checked', relaunchNeeded: false, registered: null, conflicts: null, installerVolumes: [],
    registrationRepair: null });
});

test('off status reports the banner fallback as desktop delivery and names the reason', () => {
  const repair = { ok: false, outcome: 'blocked-installer' };
  const status = offStatus({ delivery: 'desktop', fallback: 'not-registered',
    supported: () => { throw new Error('must not create the native presenter'); },
    signature: { valid: true, reason: null, relaunchNeeded: false }, registered: false,
    registration: { conflicts: 8, installerVolumes: ['/Volumes/TipATask 0.9.19-arm64/TipATask.app'], repair } });
  assert.deepEqual(status, { delivery: 'desktop', fallback: 'not-registered', onTop: false, available: true, valid: true,
    reason: null, relaunchNeeded: false, registered: false, conflicts: 8,
    installerVolumes: ['/Volumes/TipATask 0.9.19-arm64/TipATask.app'], registrationRepair: repair });
  assert.equal('fallback' in offStatus({ delivery: 'native', fallback: 'failed' }), false, 'no fallback while native is used');
});

// main.js wiring: the handler answers with the delivery the controller uses right now.
test('notify:status reports the controller delivery, re-read after the bundle health refresh', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('notify:status'");
  const end = source.indexOf("  // Settings Repair verifies", start);
  assert.ok(start > 0 && end > start);
  let handler;
  const order = [];
  const state = { enabled: false, delivery: { delivery: 'native', fallback: null } };
  const context = {
    ipcMain: { handle: (_channel, cb) => { handler = cb; } },
    notifyStatus: { offStatus },
    Notification: { isSupported: () => { order.push('supported'); return true; } },
    refreshBundleSignatureState: async () => { order.push('refresh'); },
    desktopNotifications: {
      isEnabled: () => state.enabled,
      delivery: () => { order.push('delivery'); return state.delivery; },
    },
    _bundleSignatureState: { valid: true, reason: null, relaunchNeeded: false },
    _ncRegistrationState: false,
    _lsRegistrationState: { conflicts: 8, installerVolumes: ['/Volumes/X/TipATask.app'], repair: null },
  };
  vm.runInNewContext(source.slice(start, end), context);

  let status = await handler();
  assert.deepEqual(order, ['refresh', 'delivery', 'supported']);
  assert.equal(status.delivery, 'native');
  assert.equal(status.onTop, false, 'the saved choice travels with the delivery');
  assert.equal(status.registered, false);
  assert.equal(status.conflicts, 8);

  state.delivery = { delivery: 'desktop', fallback: 'not-registered' };
  order.length = 0;
  status = await handler();
  assert.deepEqual(order, ['refresh', 'delivery'], 'the banner fallback never asks the native presenter');
  assert.equal(status.delivery, 'desktop');
  assert.equal(status.fallback, 'not-registered');
  assert.equal(status.onTop, false, 'the banner stands in; the saved choice is still off');
  assert.equal(status.available, true);

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

// Settings ▸ Notifications switch: the same writer as the menu checkbox and the banner's box.
test('notify:set-on-top writes the flag for a trusted project window only', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
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
  const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  const writer = source.slice(source.indexOf('function applyNotificationsOnTop('), source.indexOf('function notificationsMenu('));
  assert.match(writer, /desktopNotifications\.setEnabled\(on\)/);
  assert.match(writer, /webContents\.send\('notify:on-top-changed', \{ enabled: result\.enabled \}\)/);
  assert.match(writer, /return result;/);
  assert.match(source, /onSetOnTop: \(on\) => applyNotificationsOnTop\(on\)/);
  assert.match(source, /click: \(mi\) => \{ applyNotificationsOnTop\(mi\.checked\); \}/);
  const preload = fs.readFileSync(path.join(__dirname, '../../preload.js'), 'utf8');
  assert.match(preload, /setNotificationsOnTop: \(enabled\) => inv\('notify:set-on-top', \{ enabled: enabled === true \}\)/);
  assert.match(preload, /ipcRenderer\.on\('notify:on-top-changed', handler\)/);
});

test('main.js feeds the bundle health to the controller and re-reads delivery after each check', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  assert.match(source, /nativeBlocked: \(\) => notifyStatus\.nativeDeliveryBlocker\(\{\s*signature: _bundleSignatureState, registered: _ncRegistrationState,\s*\}\)/);
  const refresh = source.slice(source.indexOf('async function refreshBundleSignatureState('), source.indexOf('let workspaceState = null;'));
  assert.match(refresh, /desktopNotifications\?\.refreshDelivery\(\);\s*return _bundleSignatureState;\s*\}\s*$/);
});
