'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDesktopNotifications, pageHeight, PAGE_SIZE, CLICK_HOLD_MS, NATIVE_CONFIRM_MS } = require('../../main/desktop-notifications');

// Minimal project window: focus state + a webContents that records sent channels.
let wcSeq = 100;
function projectWindow() {
  const win = new EventEmitter();
  win.focused = false;
  win.isDestroyed = () => false;
  win.isFocused = () => win.focused;
  win.webContents = new EventEmitter();
  win.webContents.id = ++wcSeq;
  win.webContents.isDestroyed = () => false;
  win.webContents.sent = [];
  win.webContents.send = (channel, data) => win.webContents.sent.push({ channel, data });
  return win;
}

// Electron's native Notification: records options, show/close, and emits terminal events.
// `outcome` is what the OS answers a show() with: 'show' (delivered), 'failed' (macOS refusing
// an unregistered bundle), 'throw', or 'silent' (no answer — the test emits events itself).
function nativeClass({ supported = true, outcome = 'show' } = {}) {
  const natives = [];
  class Notification extends EventEmitter {
    static isSupported() { return supported; }
    constructor(options) { super(); this.options = options; this.shown = false; this.closed = false; natives.push(this); }
    show() {
      if (outcome === 'throw') throw new Error('native show failed');
      this.shown = true;
      if (outcome === 'show') this.emit('show');
      else if (outcome === 'failed') this.emit('failed', {}, 'The operation couldn’t be completed. (UNErrorDomain error 1.)');
    }
    close() { this.closed = true; this.emit('close'); }
  }
  return { Notification, natives };
}

function fixture({ fail = false, settingsFile = null, showMoreTarget = null, loadGate = null, projects = [],
  native = nativeClass(), platform = 'darwin', clickResult = null, nativeBlocked = undefined, confirmMs = undefined } = {}) {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter();
      this.webContents.mainFrame = {}; this.webContents.isDestroyed = () => false; this.webContents.send = (_name, data) => { this.data = data; };
      this.webContents.setWindowOpenHandler = () => {}; windows.push(this); }
    static fromId() { return null; }
    isDestroyed() { return !!this.destroyed; }
    setMenu() {} setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces(visible, options) { this.workspaces = { visible, options }; }
    setBounds(bounds) { this.bounds = bounds; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    async loadFile() { if (loadGate) await loadGate; if (fail) throw new Error('missing asset'); }
  }
  const ipcMain = new EventEmitter();
  const screen = new EventEmitter();
  const display = { id: 1, workArea: { x: 100, y: 20, width: 1024, height: 768 } };
  screen.getAllDisplays = () => [display]; screen.getPrimaryDisplay = () => display;
  const clicked = [], dismissed = [], shownMore = [], released = [], onTopSets = [];
  let focused = null;
  const surface = createDesktopNotifications({ BrowserWindow, screen, ipcMain, settingsFile, Notification: native.Notification,
    focusedProjectWindow: () => focused, projectWindows: () => projects,
    onClick: e => { clicked.push(e); return clickResult?.(e); },
    onDismiss: (e, { keepCard } = {}) => (keepCard ? released : dismissed).push(e),
    onShowMore: e => { shownMore.push(e); return showMoreTarget; },
    onSetOnTop: on => onTopSets.push(on), platform, nativeBlocked, confirmMs,
    isTrustedProjectSender: (event) => event.trustedProject === true });
  const action = (id, action, trusted = true) => {
    const w = windows.at(-1);
    ipcMain.emit('notify:desktop-action', { sender: trusted ? w.webContents : {}, senderFrame: w.webContents.mainFrame }, { id, action });
  };
  const listAction = (sender, action, id, trustedProject = true) =>
    ipcMain.emit('notify:desktop-list-action', { sender, trustedProject }, { action, id });
  // Focus a project window (or another app: null) and let the surface settle immediately.
  const focus = (w) => { focused = w; surface.syncNotificationSurface({ immediate: true }); };
  const surfaceAction = (sender, action, id, trustedProject = true) =>
    ipcMain.emit('notify:surface-action', { sender, trustedProject }, { action, id });
  const lastSurface = (w) => w.webContents.sent.filter((m) => m.channel === 'notify:surface').at(-1)?.data;
  return { surface, windows, natives: native.natives, clicked, dismissed, released, shownMore, onTopSets, action, listAction, screen,
    ipcMain, focus, surfaceAction, lastSurface, setFocused: (w) => { focused = w; } };
}

test('alerts upsert by project and tag, survive time and act per entry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  const origin = { windowId: 1, projectPath: '/a' };
  for (let i = 0; i < 8; i++) assert.equal((await f.surface.show({ title: `Title ${i}`, tag: 'same', notificationId: `n${i}` },
    i % 2 ? { ...origin, projectPath: '/b' } : origin)).ok, true);
  // One alert per (project, tag): equal tags in two projects stay separate, repeats update in place.
  assert.equal(f.surface.snapshot().length, 2);
  assert.deepEqual(f.surface.snapshot().map((e) => [e.projectPath, e.title, e.notificationId]),
    [['/b', 'Title 7', 'n7'], ['/a', 'Title 6', 'n6']]);
  assert.deepEqual(f.released.map((e) => e.notificationId), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'],
    'replaced callback identities are released, cards kept');
  for (let i = 0; i < 6; i++) await f.surface.show({ title: `T${i}`, tag: `t${i}`, notificationId: `m${i}` }, origin);
  t.mock.timers.tick(120000);
  assert.equal(f.surface.snapshot().length, 8);
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].visible, true);
  assert.ok(f.windows[0].bounds.height <= 768 * .75);
  const a = f.surface.snapshot().find((e) => e.tag === 'same' && e.projectPath === '/a');
  const b = f.surface.snapshot().find((e) => e.tag === 'same' && e.projectPath === '/b');
  f.action(a.id, 'click', false);
  assert.equal(f.surface.snapshot().length, 8);
  f.action(a.id, 'click');
  assert.equal(f.clicked[0].origin.projectPath, '/a');
  f.action(b.id, 'close');
  assert.equal(f.dismissed[0].origin.projectPath, '/b');
  assert.equal(f.surface.snapshot().length, 6);
  f.action(a.id, 'click');
  assert.equal(f.clicked.length, 1);
  for (const entry of f.surface.snapshot()) f.action(entry.id, 'close');
  assert.equal(f.windows[0].visible, false);
  f.surface.dispose();
  assert.equal(f.screen.listenerCount('display-removed'), 0);
});

test('fullscreen visibility never turns the macOS app into a Dock-less UIElement', async () => {
  const f = fixture();
  await f.surface.show({ title: 'Title', notificationId: 'n1' }, { windowId: 1, projectPath: '/a' });
  const { options } = f.windows[0].workspaces;
  if (options?.visibleOnFullScreen) assert.equal(options.skipTransformProcessType, true);
  f.surface.dispose();
});

test('the transparent banner draws no OS window shadow around its cards', async () => {
  const f = fixture();
  await f.surface.show({ title: 'Title', notificationId: 'n1' }, { windowId: 1, projectPath: '/a' });
  assert.equal(f.windows[0].options.transparent, true);
  assert.equal(f.windows[0].options.hasShadow, false);
  f.surface.dispose();
});

test('a failed desktop load reports failure and removes the undelivered entry', async () => {
  const f = fixture({ fail: true });
  assert.deepEqual(await f.surface.show({}, {}), { ok: false, reason: 'desktop-unavailable' });
  assert.deepEqual(f.surface.snapshot(), []);
  f.surface.dispose();
});

const show = (f, n, origin = { windowId: 1, projectPath: '/a' }) => Promise.all(Array.from({ length: n }, (_, i) =>
  f.surface.show({ title: `T${i + 1}`, notificationId: `n${i + 1}` }, i % 2 ? { ...origin, projectPath: '/b' } : origin)));

test('twelve entries stay reachable while the banner window sizes to one five-card page', async () => {
  const f = fixture();
  await show(f, 12);
  assert.equal(PAGE_SIZE, 5);
  assert.equal(f.surface.snapshot().length, 12);
  assert.deepEqual(f.surface.snapshot().slice(0, 2).map((e) => e.title), ['T12', 'T11']);
  assert.equal(f.windows[0].bounds.height, pageHeight(12));
  assert.equal(pageHeight(12), pageHeight(6));
  assert.equal(pageHeight(5), pageHeight(6), 'the footer row (Show toggle) is always there');
  assert.ok(pageHeight(12) <= 768 * .75);
  f.surface.dispose();
});

// (TPT505) The banner offers Hide, never Clear All: hiding keeps every alert and touches no
// project window; the banner stays hidden until a new or changed alert arrives.
test('banner Hide keeps every alert, focuses nothing, and Clear All is unreachable from the banner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const a = projectWindow();
  const f = fixture({ projects: [a] });
  await show(f, 12);
  f.action(null, 'clear-all');
  assert.equal(f.surface.snapshot().length, 12, 'banner clear-all is ignored');
  assert.equal(f.dismissed.length, 0);
  f.action(null, 'hide', false);
  assert.equal(f.windows[0].visible, true, 'untrusted senders are ignored');
  f.action(null, 'hide');
  assert.equal(f.windows[0].visible, false);
  assert.equal(f.surface.snapshot().length, 12);
  assert.deepEqual([f.dismissed.length, f.released.length, f.clicked.length, f.shownMore.length], [0, 0, 0, 0]);
  assert.equal(a.focused, false, 'no project window focused');
  // Focus flips keep the banner hidden; the focused project window still hosts every alert.
  f.focus(null);
  assert.equal(f.windows[0].visible, false);
  f.focus(a);
  assert.equal(f.lastSurface(a).entries.length, 12);
  f.focus(null);
  assert.equal(f.windows[0].visible, false, 'still hidden after leaving Tipatask again');
  // A mirrored card that changed nothing does not bring it back; a changed one does.
  const origin = { windowId: 1, projectPath: '/a' };
  f.surface.upsertCard({ tag: 'TPT9', title: 'card', seq: 1 }, origin);
  assert.equal(f.windows[0].visible, true, 'a new mirrored card re-shows it');
  f.action(null, 'hide');
  f.surface.upsertCard({ tag: 'TPT9', title: 'card', seq: 2 }, origin);
  assert.equal(f.windows[0].visible, false, 'an identical re-mirror keeps it hidden');
  f.surface.upsertCard({ tag: 'TPT9', title: 'card changed', seq: 3 }, origin);
  assert.equal(f.windows[0].visible, true, 'an updated entry re-shows it');
  f.action(null, 'hide');
  await f.surface.show({ title: 'T1', notificationId: 'again' }, origin);
  assert.equal(f.windows[0].visible, true, 'any real send re-shows it');
  // The in-app host keeps Clear All; Hide with nothing to show is a no-op.
  f.focus(a);
  f.surfaceAction(a.webContents, 'clear-all');
  assert.equal(f.surface.snapshot().length, 0);
  f.focus(null);
  f.action(null, 'hide');
  assert.equal(f.windows[0].visible, false);
  f.surface.dispose();
});

test('the banner "Show" checkbox turns Show on Top off through main\'s single writer', async () => {
  const f = fixture();
  await show(f, 2);
  f.action(null, 'on-top-off', false);
  assert.deepEqual(f.onTopSets, []);
  f.action(null, 'on-top-off');
  assert.deepEqual(f.onTopSets, [false]);
  f.surface.dispose();
});

// (TPT645) roundedCorners: false — a frameless window with rounded corners keeps a hidden
// title-bar strip across its top, and a real click there (where Hide sits) activates the app.
test('the banner never activates the app when clicked: macOS borderless panel, Windows non-focusable', async () => {
  for (const [platform, expected] of [['darwin', { type: 'panel', roundedCorners: false, focusable: undefined }],
    ['win32', { type: undefined, roundedCorners: undefined, focusable: false }],
    ['linux', { type: undefined, roundedCorners: undefined, focusable: undefined }]]) {
    const f = fixture({ platform });
    await f.surface.show({ title: 'Title', notificationId: 'n1' }, { windowId: 1, projectPath: '/a' });
    const { type, roundedCorners, focusable } = f.windows[0].options;
    assert.deepEqual({ type, roundedCorners, focusable }, expected, platform);
    f.surface.dispose();
  }
});

// (TPT645/TPT9056) A card click defers the banner's surface decision until onClick has raised
// the project window. On macOS the banner steps aside for the raise — the app must have no
// window on the user's current Space for activation to switch to the project window's Space —
// and comes back only when no project window took the alerts.
test('macOS: a card click hides the banner for the raise and brings it back only when nothing was raised', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const a = projectWindow();
  const settles = [];
  const f = fixture({ projects: [a], clickResult: () => new Promise((resolve) => settles.push(resolve)) });
  await show(f, 3);
  const banner = f.windows[0];
  assert.equal(banner.visible, true);
  const [newest, ...rest] = f.surface.snapshot();
  f.action(newest.id, 'click');
  assert.equal(f.clicked[0].id, newest.id);
  assert.deepEqual(f.surface.snapshot().map((e) => e.id), rest.map((e) => e.id), 'removed before onClick runs');
  assert.deepEqual(banner.data.entries.map((e) => e.id), rest.map((e) => e.id), 'the card leaves the banner at once');
  assert.equal(banner.visible, false, 'the banner steps aside while the window is raised');
  // The raise focused the project window, which hosts the alerts now: the banner stays down.
  f.focus(a);
  assert.equal(f.lastSurface(a).active, true);
  assert.equal(banner.visible, false);
  settles.shift()();
  await flush();
  assert.equal(banner.visible, false, 'nothing to bring back: a project window hosts the alerts');

  // Nothing was raised (another app still in front): the banner returns with the remaining
  // cards once the click settles.
  f.focus(null);
  assert.equal(banner.visible, true);
  f.action(rest[0].id, 'click');
  assert.equal(banner.visible, false, 'down for the raise');
  settles.shift()();
  await flush();
  assert.equal(banner.visible, true, 'back, since no project window took the alerts');
  assert.deepEqual(banner.data.entries.map((e) => e.id), [rest[1].id]);

  // The last card: nothing to show afterwards either way.
  f.action(rest[1].id, 'click');
  assert.equal(banner.visible, false);
  settles.shift()();
  await flush();
  assert.equal(banner.visible, false);
  assert.equal(f.surface.snapshot().length, 0);

  // A click that never settles is released by the cap, which brings the banner back then.
  await show(f, 2);
  assert.equal(banner.visible, true);
  f.action(f.surface.snapshot()[0].id, 'click');
  assert.equal(banner.visible, false);
  t.mock.timers.tick(CLICK_HOLD_MS - 1);
  assert.equal(banner.visible, false);
  t.mock.timers.tick(1);
  assert.equal(banner.visible, true, 'released by the cap');
  settles.shift()();
  await flush();
  assert.equal(banner.visible, true, 'a late settle changes nothing');

  // Hide still applies while a click is pending: the banner stays down after the settle.
  await show(f, 1);
  f.action(f.surface.snapshot()[0].id, 'click');
  assert.equal(f.surface.snapshot().length, 1);
  f.action(null, 'hide');
  settles.shift()();
  await flush();
  assert.equal(banner.visible, false, 'Hide wins over the deferred decision');
  f.surface.dispose();
});

// (TPT645) Windows and Linux have no Spaces to switch: the banner stays up, minus the clicked
// card, until the raise settled, so the desktop never flashes between banner and window.
test('elsewhere a card click keeps the banner up, minus the card, until onClick settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const a = projectWindow();
  const settles = [];
  const f = fixture({ platform: 'win32', projects: [a], clickResult: () => new Promise((resolve) => settles.push(resolve)) });
  await show(f, 3);
  const banner = f.windows[0];
  const [newest, ...rest] = f.surface.snapshot();
  f.action(newest.id, 'click');
  assert.deepEqual(banner.data.entries.map((e) => e.id), rest.map((e) => e.id), 'the card leaves the banner at once');
  assert.equal(banner.visible, true);
  f.focus(a);
  assert.equal(banner.visible, true, 'held while onClick is still raising the window');
  settles.shift()();
  await flush();
  assert.equal(banner.visible, false, 'hidden once the click settled');

  // The last card: the banner stays up, empty, until the click settles.
  f.focus(null);
  f.action(rest[0].id, 'close');
  assert.equal(banner.visible, true);
  f.action(rest[1].id, 'click');
  assert.equal(f.surface.snapshot().length, 0);
  assert.equal(banner.visible, true, 'no hide before the window is raised');
  settles.shift()();
  await flush();
  assert.equal(banner.visible, false);

  // A click that never settles holds the banner for CLICK_HOLD_MS at most.
  await show(f, 1);
  f.action(f.surface.snapshot()[0].id, 'click');
  t.mock.timers.tick(CLICK_HOLD_MS - 1);
  assert.equal(banner.visible, true);
  t.mock.timers.tick(1);
  assert.equal(banner.visible, false, 'released by the cap');
  settles.shift()();
  await flush();
  assert.equal(banner.visible, false, 'a late settle changes nothing');
  f.surface.dispose();
});

test('a synchronous onClick releases the hold at once', async () => {
  const f = fixture();
  await show(f, 2);
  f.action(f.surface.snapshot()[0].id, 'click');
  assert.equal(f.clicked.length, 1);
  assert.equal(f.windows[0].visible, true, 'nothing was raised: the remaining card is back at once');
  f.action(f.surface.snapshot()[0].id, 'click');
  assert.equal(f.windows[0].visible, false, 'the empty banner hides right away');
  f.surface.dispose();
});

test('Show More focuses the newest entry window and streams the full list there', async () => {
  const target = projectWindow();
  const f = fixture({ showMoreTarget: target, projects: [target] });
  await show(f, 7);
  f.action(null, 'show-more');
  assert.equal(f.shownMore[0].notificationId, 'n7');
  const opened = target.webContents.sent.find((m) => m.channel === 'notify:desktop-list-open');
  assert.equal(opened.data.length, 7);
  // Focused list window hosts the alerts in-app: the always-on-top banner steps aside, then
  // returns once another app takes focus.
  f.focus(target);
  assert.equal(f.windows[0].visible, false);
  f.focus(null);
  assert.equal(f.windows[0].visible, true);
  // Per-entry actions from the list share the banner path (cross-project click routing).
  const other = f.surface.snapshot().find((e) => e.title === 'T2');
  f.listAction({}, 'click', other.id);
  f.listAction(target.webContents, 'click', other.id, false);
  assert.equal(f.clicked.length, 0, 'untrusted or non-owner senders are ignored');
  f.listAction(target.webContents, 'click', other.id);
  assert.equal(f.clicked[0].origin.projectPath, '/b');
  assert.equal(target.webContents.sent.at(-1).data.length, 6);
  f.listAction(target.webContents, 'clear-all');
  assert.equal(f.surface.snapshot().length, 0);
  f.listAction(target.webContents, 'panel-closed');
  const before = target.webContents.sent.length;
  await show(f, 1);
  assert.equal(target.webContents.sent.length, before, 'a closed list receives no updates');
  f.surface.dispose();
});

test('the on-top setting applies immediately and persists across a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpt480-'));
  const settingsFile = path.join(dir, 'desktop-notifications.json');
  try {
    const f = fixture({ settingsFile });
    assert.equal(f.surface.isEnabled(), true);
    await show(f, 3);
    assert.deepEqual(f.surface.setEnabled(false), { ok: true, enabled: false });
    assert.equal(f.surface.snapshot().length, 0);
    assert.equal(f.dismissed.length, 0, 'turning the setting off keeps every in-app card');
    assert.equal(f.released.length, 3);
    assert.equal(f.windows[0].visible, false);
    assert.equal((await f.surface.show({ title: 'x' }, { windowId: 1 })).delivery, 'native');
    assert.equal(f.surface.snapshot().length, 0);
    assert.equal(f.windows[0].visible, false, 'an off send never brings the stack back');
    f.surface.dispose();

    const restarted = fixture({ settingsFile });
    assert.equal(restarted.surface.isEnabled(), false);
    assert.equal((await restarted.surface.show({ title: 'x' }, { windowId: 1 })).delivery, 'native');
    assert.equal(restarted.windows.length, 0, 'no banner window is created while off');
    restarted.surface.setEnabled(true);
    assert.equal((await restarted.surface.show({ title: 'x' }, { windowId: 1 })).delivery, 'desktop');
    restarted.surface.dispose();
    assert.equal(fixture({ settingsFile }).surface.isEnabled(), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('task dismissal removes matching visible and overflow alerts atomically and fills the page', async () => {
  const target = projectWindow();
  const f = fixture({ showMoreTarget: target });
  const a = { windowId: 1, projectPath: '/a' }, b = { windowId: 2, projectPath: '/b' };
  const tags = ['TPT483', 'TPT484', 'activity-TPT483', 'objective-TPT483', 'completed-TPT483',
    'TPT4830', 'TPT485', 'tipatask-test', 'TPT486', 'TPT483'];
  for (let i = 0; i < tags.length; i++) {
    await f.surface.show({ tag: tags[i], notificationId: `n${i}` }, i === 9 ? b : a);
  }
  f.action(null, 'show-more');
  const before = target.webContents.sent.length;
  assert.equal(f.surface.dismissTask('TPT483', '/a'), 3);
  const remaining = ['n9', 'n8', 'n7', 'n6', 'n5', 'n3', 'n1'];
  assert.deepEqual(f.surface.snapshot().map(e => e.notificationId), remaining);
  assert.deepEqual(f.windows[0].data.entries.slice(0, PAGE_SIZE).map(e => e.notificationId), remaining.slice(0, 5));
  assert.equal(target.webContents.sent.length, before + 1, 'one complete snapshot, no intermediate refill');
  assert.deepEqual(target.webContents.sent.at(-1).data.map(e => e.notificationId), remaining);
  assert.deepEqual(f.dismissed.map(e => e.notificationId), ['n0', 'n2', 'n4']);
  assert.equal(f.clicked.length, 0);
  assert.equal(f.surface.dismissTask('TPT483', '/a'), 0);
  assert.equal(f.surface.dismissTask('TPT483', null), 0);
  f.action('1', 'click');
  assert.equal(f.clicked.length, 0, 'a stale click for a removed banner cannot activate');
  assert.equal(f.surface.dismissTask('TPT483', '/b'), 1);
  assert.equal(f.windows[0].bounds.height, pageHeight(6));
  f.surface.dispose();
});

test('dismissal during window load cannot resurrect alerts or remove a later completion', async () => {
  let resolveLoad;
  const f = fixture({ loadGate: new Promise(resolve => { resolveLoad = resolve; }) });
  const origin = { windowId: 1, projectPath: '/a' };
  const first = f.surface.show({ tag: 'TPT483', notificationId: 'old' }, origin);
  assert.equal(f.surface.dismissTask('TPT483', '/a'), 1);
  const fresh = f.surface.show({ tag: 'completed-TPT483', notificationId: 'fresh' }, origin);
  resolveLoad();
  await Promise.all([first, fresh]);
  assert.deepEqual(f.windows[0].data.entries.map(e => e.notificationId), ['fresh']);
  assert.deepEqual(f.dismissed.map(e => e.notificationId), ['old']);
  f.surface.dismissTask('TPT483', '/a');
  assert.equal(f.windows[0].visible, false);
  f.surface.dispose();
});

test('dismiss IPC derives project scope from the trusted sender, ignoring supplied paths', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('notify:dismiss-task'");
  const end = source.indexOf("  ipcMain.handle('project:remove'", start);
  let handler;
  const calls = [];
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_channel, cb) => { handler = cb; } },
    isTrustedTopFrame: event => event.trusted,
    BrowserWindow: {}, projectDirs: new Map([[1, '/a']]), PORT: 4455,
    desktopNotifications: { dismissTask: (...args) => { calls.push(args); return 2; } },
  });
  assert.equal(handler({ trusted: false, sender: { id: 1 } }, { taskId: 'TPT483' }).reason, 'untrusted_sender');
  assert.equal(handler({ trusted: true, sender: { id: 1 } }, null).reason, 'invalid_task');
  assert.equal(handler({ trusted: true, sender: { id: 1 } }, { taskId: 'TPT483', projectPath: '/b' }).dismissed, 2);
  assert.deepEqual(calls, [['TPT483', '/a']]);
});

// (TPT484) One surface by app focus.
test('focus picks exactly one surface and moves pending alerts without focusing anything', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const a = projectWindow(), b = projectWindow();
  const f = fixture({ projects: [a, b] });
  f.focus(a);
  await show(f, 3);
  assert.equal(f.windows[0].visible, false, 'Tipatask focused: no always-on-top banner');
  assert.deepEqual(f.lastSurface(a), { shared: true, active: true, entries: f.surface.snapshot() });
  assert.deepEqual(f.lastSurface(b), { shared: true, active: false, entries: [] });
  // Another app takes focus: the same alerts move to the banner and leave the in-app panel.
  f.focus(null);
  assert.equal(f.windows[0].visible, true);
  assert.deepEqual(f.windows[0].data.entries.map((e) => e.id), f.surface.snapshot().map((e) => e.id));
  assert.deepEqual(f.lastSurface(a), { shared: true, active: false, entries: [] });
  // Back to the other project window: it hosts every project's alerts.
  f.focus(b);
  assert.equal(f.windows[0].visible, false);
  assert.equal(f.lastSurface(b).entries.length, 3);
  assert.equal(f.windows[0].focused, undefined, 'the banner window is never focused');
  f.surface.dispose();
});

test('a window switch inside the settle period never flashes the banner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const a = projectWindow(), b = projectWindow();
  const f = fixture({ projects: [a, b] });
  f.focus(a);
  await show(f, 2);
  let shows = 0;
  const showInactive = f.windows[0].showInactive.bind(f.windows[0]);
  f.windows[0].showInactive = () => { shows++; showInactive(); };
  // blur(a) → focus(b): nothing focused for a moment.
  f.setFocused(null); f.surface.syncNotificationSurface();
  t.mock.timers.tick(50);
  f.setFocused(b); f.surface.syncNotificationSurface();
  t.mock.timers.tick(200);
  assert.equal(shows, 0);
  assert.equal(f.lastSurface(b).active, true);
  assert.equal(f.lastSurface(a).active, false);
  f.surface.dispose();
});

test('the banner window itself focused counts as another app; its alerts stay put', async () => {
  const a = projectWindow();
  const f = fixture({ projects: [a] });
  await show(f, 1);
  f.focus(f.windows[0]);
  assert.equal(f.windows[0].visible, true);
  assert.equal(f.lastSurface(a)?.active ?? false, false);
  f.surface.dispose();
});

test('in-app cards and banner sends share one identity and one dismissal', async () => {
  const a = projectWindow();
  const f = fixture({ projects: [a] });
  f.focus(a);
  const origin = { windowId: 1, projectPath: '/a' };
  assert.equal(f.surface.upsertCard({ tag: 'TPT9', title: 'card', seq: 4 }, origin).delivery, 'shared');
  await f.surface.show({ tag: 'TPT9', title: 'banner', notificationId: 'n1' }, origin);
  assert.equal(f.surface.snapshot().length, 1);
  assert.deepEqual(f.surface.snapshot()[0].notificationId, 'n1');
  assert.equal(f.surface.snapshot()[0].cardSeq, 4);
  f.surface.upsertCard({ tag: 'TPT9', title: 'card again', seq: 7 }, origin);
  assert.equal(f.surface.snapshot()[0].title, 'card again');
  assert.equal(f.surface.snapshot()[0].notificationId, 'n1', 'a card update keeps the banner callback');
  // Programmatic dismissal from the project removes it everywhere; another project can't.
  assert.equal(f.surface.dismissKey('TPT9', '/b'), 0);
  assert.equal(f.surface.dismissKey('TPT9', '/a'), 1);
  assert.equal(f.dismissed[0].cardSeq, 7);
  // A dismissed alert never comes back on a focus flip.
  f.focus(null); f.focus(a);
  assert.equal(f.surface.snapshot().length, 0);
  assert.deepEqual(f.lastSurface(a).entries, []);
  assert.equal(f.windows[0].visible, false);
  assert.equal(f.surface.upsertCard({ title: 'no tag' }, origin).ok, false);
  f.surface.dispose();
});

test('the in-app host acts through main; Show More opens the full list in place', async () => {
  const a = projectWindow(), b = projectWindow();
  const f = fixture({ projects: [a, b] });
  f.focus(a);
  await show(f, 7);
  const [newest] = f.surface.snapshot();
  f.surfaceAction(b.webContents, 'close', newest.id);
  f.surfaceAction(a.webContents, 'close', newest.id, false);
  assert.equal(f.surface.snapshot().length, 7, 'only the trusted current host may act');
  f.surfaceAction(a.webContents, 'click', newest.id);
  assert.equal(f.clicked[0].id, newest.id);
  f.surfaceAction(a.webContents, 'show-more');
  assert.equal(f.shownMore.length, 0, 'no focus-stealing Show More routing from the in-app panel');
  assert.equal(a.webContents.sent.find((m) => m.channel === 'notify:desktop-list-open').data.length, 6);
  f.surfaceAction(a.webContents, 'clear-all');
  assert.equal(f.surface.snapshot().length, 0);
  assert.equal(f.dismissed.length, 6);
  f.surface.dispose();
});

test('the host palette is forwarded to the banner, sanitized', async () => {
  const a = projectWindow();
  const f = fixture({ projects: [a] });
  f.focus(a);
  await show(f, 1);
  f.ipcMain.emit('notify:theme', { sender: a.webContents, trustedProject: true },
    { bg: '#101010', text: 'rgb(1, 2, 3)', border: 'url(javascript:x)', bogus: '#fff' });
  assert.deepEqual(f.windows[0].data.theme, { bg: '#101010', text: 'rgb(1, 2, 3)' });
  f.ipcMain.emit('notify:theme', { sender: {}, trustedProject: true }, { bg: '#000' });
  assert.equal(f.windows[0].data.theme.bg, '#101010');
  f.surface.dispose();
});

test('setting off: no shared surface, cards fall back to each window; on re-shares', async () => {
  const a = projectWindow();
  const f = fixture({ projects: [a] });
  f.focus(a);
  await show(f, 2);
  f.surface.setEnabled(false);
  assert.deepEqual(f.lastSurface(a), { shared: false, active: false, entries: [] });
  assert.equal(f.released.length, 2);
  assert.equal(f.surface.upsertCard({ tag: 'x' }, { projectPath: '/a' }).delivery, 'disabled');
  assert.equal(f.surface.snapshot().length, 0);
  f.surface.setEnabled(true);
  assert.equal(f.lastSurface(a).shared, true);
  f.surface.dispose();
});

test('Show on Top off sends one transient native notification per alert, routed per project', async () => {
  const a = projectWindow();
  const f = fixture({ projects: [a] });
  f.surface.setEnabled(false);
  const originA = { windowId: 1, wcId: 7, projectPath: '/a' };
  const first = await f.surface.show({ title: 'T1', body: 'b', tag: 'TPT1', taskId: 'TPT1', notificationId: 'n1' }, originA);
  assert.equal(first.ok, true);
  assert.equal(first.delivery, 'native');
  assert.equal(f.windows.length, 0, 'no banner window');
  assert.equal(f.surface.snapshot().length, 0, 'no shared registry entry');
  assert.equal(f.natives.length, 1);
  assert.deepEqual(f.natives[0].options, { title: 'T1', body: 'b', silent: false }, 'OS decides placement and duration');
  assert.equal(f.natives[0].shown, true);

  // A repeat for the same (project, tag) replaces the earlier native: no duplicates.
  await f.surface.show({ title: 'T1 again', tag: 'TPT1', taskId: 'TPT1', notificationId: 'n2' }, originA);
  await f.surface.show({ title: 'other project', tag: 'TPT1', taskId: 'TPT1', notificationId: 'n3' }, { ...originA, projectPath: '/b' });
  assert.equal(f.natives[0].closed, true);
  assert.deepEqual(f.natives.filter((n) => !n.closed).map((n) => n.options.title), ['T1 again', 'other project']);
  assert.deepEqual(f.released.map((e) => e.notificationId), ['n1'], 'the replaced callback identity is released, card kept');

  // Click routes through onClick with the origin project and callback identity, once.
  f.natives[1].emit('click');
  f.natives[1].emit('click');
  assert.deepEqual(f.clicked.map((e) => [e.notificationId, e.origin.projectPath, e.taskId]), [['n2', '/a', 'TPT1']]);
  // A late close after the click is not a second dismissal.
  f.natives[1].emit('close');
  assert.equal(f.released.length, 1);

  // The OS closing one (user dismissed it) releases its callback; the card stays.
  f.natives[2].emit('close');
  assert.deepEqual(f.released.map((e) => e.notificationId), ['n1', 'n3']);
  assert.equal(f.dismissed.length, 0);
  f.surface.dispose();
});

test('native notifications close on task dismissal, dismissKey and turning Show on Top back on', async () => {
  const f = fixture();
  f.surface.setEnabled(false);
  const origin = { windowId: 1, projectPath: '/a' };
  await f.surface.show({ title: 'a', tag: 'TPT5', notificationId: 'n1' }, origin);
  await f.surface.show({ title: 'b', tag: 'completed-TPT5', notificationId: 'n2' }, origin);
  await f.surface.show({ title: 'c', tag: 'TPT5', notificationId: 'n3' }, { ...origin, projectPath: '/b' });
  await f.surface.show({ title: 'd', tag: 'objective', notificationId: 'n4' }, origin);
  await f.surface.show({ title: 'e', tag: 'TPT6', notificationId: 'n5' }, origin);
  assert.equal(f.surface.dismissTask('TPT5', '/a'), 2);
  assert.deepEqual(f.natives.map((n) => n.closed), [true, true, false, false, false], 'other projects untouched');
  assert.equal(f.dismissed.length, 0, 'the renderer already cleared its own cards');
  assert.equal(f.surface.dismissKey('objective', '/a'), 1);
  assert.equal(f.natives[3].closed, true);
  f.surface.setEnabled(true);
  assert.equal(f.natives.every((n) => n.closed), true);
  assert.equal((await f.surface.show({ title: 'f', tag: 'TPT7' }, origin)).delivery, 'desktop');
  assert.equal(f.natives.length, 5, 'on: no native notifications');
  f.surface.dispose();
});

// "Show on Top" off must never mean "no alert": when the OS cannot deliver a native
// notification, the alert goes to the shared registry and the banner after all.
const OFF = { windowId: 1, wcId: 7, projectPath: '/a' };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('off on a platform without native notifications sends through the banner', async () => {
  for (const native of [nativeClass({ supported: false }), { Notification: null, natives: [] }]) {
    const f = fixture({ native });
    f.surface.setEnabled(false);
    const result = await f.surface.show({ title: 'x', tag: 't', notificationId: 'n1' }, OFF);
    assert.deepEqual(result, { ok: true, id: result.id, delivery: 'desktop', fallback: 'unsupported' });
    assert.equal(f.natives.length, 0);
    assert.deepEqual(f.surface.snapshot().map((e) => e.notificationId), ['n1']);
    assert.equal(f.windows[0].visible, true);
    f.surface.dispose();
  }
});

test('off with native delivery known blocked: alerts stack on the banner from the first send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpt9294-'));
  const settingsFile = path.join(dir, 'desktop-notifications.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ desktopNotificationsEnabled: false }));
  try {
    const a = projectWindow();
    const f = fixture({ settingsFile, projects: [a], nativeBlocked: () => 'not-registered' });
    assert.equal(f.surface.isEnabled(), false, 'the saved setting is untouched');
    assert.deepEqual(f.surface.surfaceFor(a), { shared: true, active: false, entries: [] });
    assert.deepEqual(f.surface.delivery(), { delivery: 'desktop', fallback: 'not-registered' });
    for (let i = 1; i <= 3; i++) {
      const result = await f.surface.show({ title: `T${i}`, tag: `TPT${i}`, notificationId: `n${i}` }, OFF);
      assert.deepEqual(result, { ok: true, id: result.id, delivery: 'desktop', fallback: 'not-registered' });
    }
    assert.equal(f.natives.length, 0, 'no native notification is attempted');
    assert.equal(f.windows.length, 1);
    assert.equal(f.windows[0].visible, true, 'another app focused: the banner is up');
    assert.deepEqual(f.windows[0].data.entries.map((e) => e.title), ['T3', 'T2', 'T1']);
    assert.equal(f.windows[0].data.onTop, false, 'the banner checkbox shows the saved (off) setting');
    const { x, y, width, height } = f.windows[0].bounds;
    assert.deepEqual([x + width, y + height], [100 + 1024, 20 + 768], 'bottom-right corner of the work area');
    assert.equal(height, pageHeight(3));
    // In-app cards share the registry again, and a focused project window hosts the alerts.
    assert.equal(f.surface.upsertCard({ tag: 'TPT1', title: 'T1', seq: 1 }, OFF).delivery, 'shared');
    f.focus(a);
    assert.equal(f.windows[0].visible, false);
    assert.equal(f.lastSurface(a).entries.length, 3);
    f.focus(null);
    assert.equal(f.windows[0].visible, true);
    // A card click routes like any banner click.
    f.action(f.surface.snapshot().find((e) => e.notificationId === 'n3').id, 'click');
    assert.deepEqual(f.clicked.map((e) => [e.notificationId, e.origin.projectPath]), [['n3', '/a']]);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).desktopNotificationsEnabled, false);
    f.surface.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a native send the OS fails moves to the banner with its callback identity', async () => {
  const a = projectWindow();
  const f = fixture({ projects: [a], native: nativeClass({ outcome: 'failed' }) });
  f.surface.setEnabled(false);
  assert.deepEqual(f.surface.delivery(), { delivery: 'native', fallback: null }, 'nothing failed yet');
  assert.deepEqual(f.lastSurface(a), { shared: false, active: false, entries: [] });
  const first = await f.surface.show({ title: 'T1', body: 'b', tag: 'TPT1', taskId: 'TPT1', notificationId: 'n1' }, OFF);
  assert.deepEqual(first, { ok: true, id: first.id, delivery: 'desktop', fallback: 'failed' });
  assert.equal(f.natives.length, 1);
  assert.equal(f.natives[0].closed, true);
  assert.deepEqual(f.surface.snapshot().map((e) => [e.title, e.notificationId, e.taskId]), [['T1', 'n1', 'TPT1']]);
  assert.equal(f.windows[0].visible, true, 'the dropped alert is on the banner');
  assert.equal(f.lastSurface(a).shared, true, 'project windows mirror their cards again');
  assert.deepEqual(f.surface.delivery(), { delivery: 'desktop', fallback: 'failed' });
  assert.deepEqual([f.released.length, f.dismissed.length], [0, 0], 'its callback identity is kept, not released');
  // Later sends skip the native attempt.
  const second = await f.surface.show({ title: 'T2', tag: 'TPT2', notificationId: 'n2' }, OFF);
  assert.equal(second.delivery, 'desktop');
  assert.equal(f.natives.length, 1);
  f.action(first.id, 'click');
  assert.deepEqual(f.clicked.map((e) => [e.notificationId, e.origin.projectPath]), [['n1', '/a']]);
  // A native whose show() throws takes the same path.
  const g = fixture({ native: nativeClass({ outcome: 'throw' }) });
  g.surface.setEnabled(false);
  const thrown = await g.surface.show({ title: 'T', tag: 't', notificationId: 'n9' }, OFF);
  assert.deepEqual([thrown.ok, thrown.delivery, thrown.fallback], [true, 'desktop', 'failed']);
  assert.equal(g.windows[0].visible, true);
  f.surface.dispose();
  g.surface.dispose();
});

test('one failed native takes every unanswered native to the banner; a late show leaves no twin', async () => {
  const f = fixture({ native: nativeClass({ outcome: 'silent' }) });
  f.surface.setEnabled(false);
  const sends = [1, 2, 3].map((i) => f.surface.show({ title: `T${i}`, tag: `TPT${i}`, notificationId: `n${i}` }, OFF));
  await flush();
  assert.equal(f.natives.length, 3);
  assert.equal(f.surface.snapshot().length, 0, 'still waiting for the OS');
  f.natives[1].emit('failed', {}, 'UNErrorDomain error 1');
  const results = await Promise.all(sends);
  assert.deepEqual(results.map((r) => [r.ok, r.delivery, r.fallback]), Array(3).fill([true, 'desktop', 'failed']));
  assert.deepEqual(f.surface.snapshot().map((e) => e.notificationId).sort(), ['n1', 'n2', 'n3']);
  assert.deepEqual(f.natives.map((n) => n.closed), [true, true, true]);
  assert.deepEqual([f.released.length, f.dismissed.length], [0, 0]);
  // The OS showing one after all must not leave a second copy beside the banner card.
  f.natives[0].closed = false;
  f.natives[0].emit('show');
  assert.equal(f.natives[0].closed, true);
  f.natives[0].emit('click');
  assert.equal(f.clicked.length, 0, 'a native that left the registry cannot act');
  f.surface.dispose();
});

test('a native the OS never answers falls back after the confirm window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ native: nativeClass({ outcome: 'silent' }), confirmMs: 300 });
  f.surface.setEnabled(false);
  const pending = f.surface.show({ title: 'T1', tag: 'TPT1', notificationId: 'n1' }, OFF);
  t.mock.timers.tick(299);
  await flush();
  assert.equal(f.surface.snapshot().length, 0);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.deepEqual([result.ok, result.delivery, result.fallback], [true, 'desktop', 'no-response']);
  assert.equal(f.windows[0].visible, true);
  assert.equal(NATIVE_CONFIRM_MS, 5000);
  f.surface.dispose();
});

test('a native the OS shows resolves as native and never falls back afterwards', async () => {
  const a = projectWindow();
  const f = fixture({ projects: [a], native: nativeClass({ outcome: 'silent' }) });
  f.surface.setEnabled(false);
  let settled = null;
  const pending = f.surface.show({ title: 'T1', tag: 'TPT1', notificationId: 'n1' }, OFF).then((r) => { settled = r; return r; });
  await flush();
  assert.equal(settled, null, 'show() waits for the OS answer');
  f.natives[0].emit('show');
  assert.deepEqual(await pending, { ok: true, id: settled.id, delivery: 'native' });
  // A failure reported after the OS showed it only releases the callback identity.
  f.natives[0].emit('failed', {}, 'late');
  assert.deepEqual(f.released.map((e) => e.notificationId), ['n1']);
  assert.equal(f.surface.snapshot().length, 0);
  assert.equal(f.windows.length, 0, 'no banner window');
  assert.deepEqual(f.surface.delivery(), { delivery: 'native', fallback: null });
  // A pending native replaced by a repeat send, or dismissed, resolves without falling back.
  const replaced = f.surface.show({ title: 'T2', tag: 'TPT2', notificationId: 'n2' }, OFF);
  const repeat = f.surface.show({ title: 'T2 again', tag: 'TPT2', notificationId: 'n3' }, OFF);
  assert.equal((await replaced).delivery, 'native');
  assert.equal(f.surface.dismissKey('TPT2', '/a'), 1);
  assert.equal((await repeat).delivery, 'native');
  assert.deepEqual(f.surface.delivery(), { delivery: 'native', fallback: null });
  // Shutdown answers a send still waiting.
  const last = f.surface.show({ title: 'T3', tag: 'TPT3' }, OFF);
  f.surface.dispose();
  assert.deepEqual(await last, { ok: false, reason: 'closed' });
});

test('the fallback holds until Show on Top is written again; off while blocked only hides the banner', async () => {
  let blocker = 'seal-broken';
  const a = projectWindow();
  const f = fixture({ projects: [a], nativeBlocked: () => blocker });
  await show(f, 2);
  assert.equal(f.windows[0].visible, true);
  // Unchecking Show on Top while native delivery is blocked: the stack steps aside at once, but
  // the alerts stay in the registry and the next one brings it back.
  assert.deepEqual(f.surface.setEnabled(false), { ok: true, enabled: false });
  assert.equal(f.windows[0].visible, false);
  assert.equal(f.surface.snapshot().length, 2);
  assert.deepEqual([f.released.length, f.dismissed.length], [0, 0]);
  assert.equal(f.lastSurface(a).shared, true);
  assert.deepEqual(f.surface.delivery(), { delivery: 'desktop', fallback: 'seal-broken' });
  await f.surface.show({ title: 'new', tag: 'TPT9', notificationId: 'n9' }, OFF);
  assert.equal(f.windows[0].visible, true);
  assert.equal(f.windows[0].data.entries.length, 3);
  assert.equal(f.natives.length, 0);
  // Health that recovers mid-run does not flip pending alerts off the banner.
  blocker = null;
  f.surface.refreshDelivery();
  assert.deepEqual(f.surface.delivery(), { delivery: 'desktop', fallback: 'seal-broken' });
  assert.equal(f.surface.snapshot().length, 3);
  // Writing the setting decides afresh: off with healthy native delivery is the native path.
  f.surface.setEnabled(false);
  assert.deepEqual(f.surface.delivery(), { delivery: 'native', fallback: null });
  assert.equal(f.surface.snapshot().length, 0);
  assert.equal(f.released.length, 3, 'in-app cards are kept');
  assert.equal(f.lastSurface(a).shared, false);
  assert.equal((await f.surface.show({ title: 'x', tag: 'TPT10' }, OFF)).delivery, 'native');
  // On clears it too.
  blocker = 'not-registered';
  f.surface.refreshDelivery();
  assert.equal(f.natives[0].closed, true, 'the live native moved to the banner');
  assert.deepEqual(f.surface.snapshot().map((e) => e.tag), ['TPT10']);
  f.surface.setEnabled(true);
  assert.deepEqual(f.surface.delivery(), { delivery: 'desktop', fallback: null });
  assert.equal((await f.surface.show({ title: 'y', tag: 'TPT11' }, OFF)).fallback, undefined);
  assert.equal(f.windows[0].data.onTop, true);
  f.surface.dispose();
});

test('health that turns blocked after the first read switches project windows to the shared registry', async () => {
  let blocker = null;
  const a = projectWindow();
  const f = fixture({ projects: [a], nativeBlocked: () => blocker });
  f.surface.setEnabled(false);
  assert.deepEqual(f.surface.surfaceFor(a), { shared: false, active: false, entries: [] });
  assert.equal(f.surface.upsertCard({ tag: 'TPT1', title: 'card', seq: 1 }, OFF).delivery, 'disabled');
  blocker = 'not-registered';
  f.surface.refreshDelivery();
  assert.deepEqual(f.lastSurface(a), { shared: true, active: false, entries: [] });
  // The window re-mirrors its local card on `shared: true`; it lands on the banner.
  assert.equal(f.surface.upsertCard({ tag: 'TPT1', title: 'card', seq: 1 }, OFF).delivery, 'shared');
  await flush();
  assert.equal(f.windows[0].visible, true);
  assert.deepEqual(f.windows[0].data.entries.map((e) => e.title), ['card']);
  // A throwing probe never blocks or breaks delivery.
  const g = fixture({ nativeBlocked: () => { throw new Error('probe failed'); } });
  g.surface.setEnabled(false);
  assert.equal((await g.surface.show({ title: 'x', tag: 't' }, OFF)).delivery, 'native');
  f.surface.dispose();
  g.surface.dispose();
});

test('the banner "Show" checkbox writes the setting both ways', async () => {
  const f = fixture({ nativeBlocked: () => 'not-registered' });
  f.surface.setEnabled(false);
  await f.surface.show({ title: 'T1', tag: 'TPT1' }, OFF);
  assert.equal(f.windows[0].data.onTop, false);
  f.action(null, 'on-top-on', false);
  assert.deepEqual(f.onTopSets, [], 'untrusted senders are ignored');
  f.action(null, 'on-top-on');
  f.action(null, 'on-top-off');
  assert.deepEqual(f.onTopSets, [true, false]);
  f.surface.dispose();
});

test('a Show More whose target never answers holds the banner for CLICK_HOLD_MS at most', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ showMoreTarget: new Promise(() => {}) });
  await show(f, 7);
  f.action(null, 'show-more');
  assert.equal(f.windows[0].visible, false, 'down for the raise');
  await f.surface.show({ title: 'while raising', tag: 'TPT20', notificationId: 'late' }, OFF);
  assert.equal(f.windows[0].visible, false, 'still held');
  t.mock.timers.tick(CLICK_HOLD_MS);
  assert.equal(f.windows[0].visible, true, 'released by the cap: pending alerts are shown again');
  assert.equal(f.windows[0].data.entries.length, 8);
  f.action(null, 'show-more');
  assert.equal(f.shownMore.length, 1, 'still one target resolution at a time');
  f.surface.dispose();
});

test('pageHeight follows the compact page geometry', () => {
  assert.equal(pageHeight(1), 16 + 24 + 8 + 70 + 8 + 24);
  assert.equal(pageHeight(5), 16 + 24 + 8 + 5 * 70 + 4 * 8 + 8 + 24);
  assert.equal(pageHeight(6), pageHeight(5));
});

// Project window whose page is still loading until `loaded()` is called. As in Electron,
// isLoadingMainFrame() still reports true while did-finish-load is being emitted.
function loadingWindow() {
  const win = projectWindow();
  let loading = true;
  win.webContents.isLoadingMainFrame = () => loading;
  win.loaded = () => { win.webContents.emit('did-finish-load'); loading = false; };
  win.channels = () => win.webContents.sent.map((m) => m.channel).filter((c) => c.startsWith('notify:desktop-list'));
  return win;
}

test('Show More waits for a loading target and keeps ownership across its first navigation', async () => {
  const target = loadingWindow();
  const f = fixture({ showMoreTarget: target, projects: [target] });
  await show(f, 7);
  f.action(null, 'show-more');
  assert.deepEqual(target.channels(), [], 'nothing is sent to a page that has no listener yet');
  target.webContents.emit('did-navigate');
  await show(f, 1);
  assert.deepEqual(target.channels(), [], 'an update never precedes the open');
  target.loaded();
  assert.deepEqual(target.channels(), ['notify:desktop-list-open']);
  assert.equal(target.webContents.sent.at(-1).data.length, 8, 'the open carries the current snapshot');
  // The focus settle that follows the raise leaves ownership alone.
  f.focus(target);
  f.focus(null);
  const newest = f.surface.snapshot()[0];
  f.listAction(target.webContents, 'close', newest.id);
  assert.equal(target.channels().at(-1), 'notify:desktop-list');
  assert.equal(target.webContents.sent.at(-1).data.length, 7);
  // A reload after the open drops the panel DOM, so ownership ends there.
  target.webContents.emit('did-navigate');
  const before = target.channels().length;
  await show(f, 1);
  assert.equal(target.channels().length, before);
  f.surface.dispose();
});

test('a target whose page fails to load releases the list; a replaced load does not', async () => {
  const target = loadingWindow();
  const f = fixture({ showMoreTarget: target, projects: [target] });
  await show(f, 6);
  f.action(null, 'show-more');
  target.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://x', true);
  target.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x', false);
  target.loaded();
  assert.deepEqual(target.channels(), ['notify:desktop-list-open']);

  const dead = loadingWindow();
  const g = fixture({ showMoreTarget: dead, projects: [dead] });
  await show(g, 6);
  g.action(null, 'show-more');
  dead.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x', true);
  dead.loaded();
  assert.deepEqual(dead.channels(), [], 'a failed page is no longer the owner');
  assert.equal(g.surface.snapshot().length, 6);
  f.surface.dispose();
  g.surface.dispose();
});

test('Show More accepts an async target, coalesces repeat clicks and survives no target', async () => {
  const target = projectWindow();
  let resolve;
  const f = fixture({ showMoreTarget: new Promise((r) => { resolve = r; }), projects: [target] });
  await show(f, 7);
  f.action(null, 'show-more');
  f.action(null, 'show-more');
  assert.equal(f.shownMore.length, 1, 'one target resolution at a time');
  assert.equal(f.windows[0].visible, false, '(TPT9056) macOS: the banner steps aside while the target is raised');
  assert.equal(target.webContents.sent.some((m) => m.channel === 'notify:desktop-list-open'), false);
  resolve(target);
  await new Promise((r) => setImmediate(r));
  assert.equal(target.webContents.sent.find((m) => m.channel === 'notify:desktop-list-open').data.length, 7);
  assert.equal(f.windows[0].visible, true, 'the list window took no focus (no host): the banner is back');
  f.focus(target);
  assert.equal(f.windows[0].visible, false, 'hidden once the raised window hosts the alerts');
  f.action(null, 'show-more');
  assert.equal(f.shownMore.length, 2, 'a settled Show More can be repeated');
  f.surface.dispose();

  // No window could be found or reopened: nothing is lost and the banner ends up back up.
  for (const [none, async] of [[() => null, false], [() => Promise.resolve(null), true], [() => Promise.reject(new Error('no window')), true]]) {
    const g = fixture({ showMoreTarget: none() });
    await show(g, 7);
    g.action(null, 'show-more');
    assert.equal(g.windows[0].visible, !async, 'only an async raise takes the banner down meanwhile');
    await new Promise((r) => setImmediate(r));
    assert.equal(g.surface.snapshot().length, 7);
    assert.equal(g.windows[0].visible, true);
    g.action(null, 'show-more');
    assert.equal(g.shownMore.length, 2);
    g.surface.dispose();
  }
});
