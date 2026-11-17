'use strict';

// Run with the repository's Electron binary. Uses isolated windows and no Task App server,
// API credentials or project data. Exits after checking real renderer/IPC behavior.
const { app, BrowserWindow, screen, ipcMain, Notification } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createDesktopNotifications } = require('../main/desktop-notifications');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-banner-probe-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let surface;
app.whenReady().then(async () => {
  console.log(`Probe PID: ${process.pid}`);
  const sources = [new BrowserWindow({ show: false }), new BrowserWindow({ show: false })];
  const clicks = [], dismissals = [], shownMore = [], onTopSets = [];
  // (TPT484) Until the focus phase below, behave as if another app is focused.
  let projectFocus = false;
  const surfaceSent = new Map();
  for (const w of sources) {
    const send = w.webContents.send.bind(w.webContents);
    w.webContents.send = (channel, data) => { if (channel === 'notify:surface') surfaceSent.set(w.id, data); send(channel, data); };
  }
  // (TPT487) Real native Notification, so the Show-on-Top-off path is exercised too.
  const natives = [];
  class ProbeNotification extends Notification {
    constructor(options) { super(options); natives.push(this); this.once('show', () => { this.probeShown = true; }); }
  }
  ProbeNotification.isSupported = () => Notification.isSupported();
  // Set for the last phase: from there on the banner's "Show" box writes the setting the way
  // main.js's applyNotificationsOnTop() does; before it, toggles are only recorded.
  let applyOnTop = false;
  surface = createDesktopNotifications({ BrowserWindow, screen, ipcMain, Notification: ProbeNotification,
    focusedProjectWindow: () => (projectFocus ? sources.find((w) => w.isFocused()) || null : null),
    projectWindows: () => sources,
    onClick: entry => { clicks.push(entry); BrowserWindow.fromId(entry.origin.windowId)?.show(); },
    onDismiss: (entry, { keepCard } = {}) => { if (!keepCard) dismissals.push(entry); },
    onShowMore: entry => { shownMore.push(entry); return null; },
    onSetOnTop: on => { onTopSets.push(on); if (applyOnTop) surface.setEnabled(on); } });
  for (const w of sources) await w.loadURL('data:text/html,<title>Notification probe</title><p>Isolated notification test</p>');
  sources[0].show();
  sources[0].minimize();
  sources[1].show();
  await delay(250);
  const focused = BrowserWindow.getFocusedWindow()?.id;
  for (let i = 0; i < 20; i++) {
    assert.equal((await surface.show({ title: `Project ${i % 2 ? 'B' : 'A'} · TPT464: Banner ${i + 1}`,
      body: i === 0 ? '<img src=x onerror=alert(1)> stays plain text' : 'This banner stays until individually clicked or closed.',
      tag: `probe-task-${i}`, notificationId: `probe-${i}`, category: i % 2 ? 'completed' : 'attention', locale: i % 2 ? 'uk' : 'en' },
    { windowId: sources[i % 2].id, projectPath: i % 2 ? '/probe/B' : '/probe/A' })).ok, true);
  }
  const stack = BrowserWindow.getAllWindows().find(w => surface.owns(w));
  await delay(400);
  assert.equal(BrowserWindow.getFocusedWindow()?.id, focused, 'delivery must not steal focus');
  const js = (code) => stack.webContents.executeJavaScript(code);
  const count = () => js("document.querySelectorAll('.tt-notif-card').length");
  // (TPT480) One fixed page: five newest cards, header count, centered Show More, no scroll.
  assert.equal(surface.snapshot().length, 20);
  assert.equal(await count(), 5);
  assert.equal(await js("document.querySelector('.tt-notif-page-count').textContent"), '20 сповіщень'); // newest banner is uk
  assert.equal(await js("document.querySelector('.tt-notif-page-more').hidden"), false);
  assert.equal(await js("[...document.querySelectorAll('.tt-notif-card')].map(c => c.dataset.id).join(',')"), '20,19,18,17,16');
  assert.equal(await js("document.documentElement.scrollHeight <= document.documentElement.clientHeight"), true, 'banner page must not scroll');
  assert.equal(await js("[...document.querySelectorAll('.tt-notif-card')].every(c => { const r = c.getBoundingClientRect(); return r.bottom <= innerHeight; })"), true, 'all five cards fit');
  assert.equal(await js('typeof window.electronAPI'), 'undefined');
  assert.equal(await js("document.querySelectorAll('img').length"), 0);
  console.log('Five-card page visible; waiting 31 seconds beyond native banner lifetime.');
  await delay(Number(process.env.PROBE_WAIT_MS ?? 31000));
  assert.equal(await count(), 5);
  assert.equal(stack.isVisible(), true);
  const screenshot = path.join(os.tmpdir(), 'tpt480-desktop-page.png');
  fs.writeFileSync(screenshot, (await stack.webContents.capturePage()).toPNG());
  await js("document.querySelector('[data-id=\"19\"] .tt-notif-card-close').click()");
  await delay(100);
  assert.equal(surface.snapshot().length, 19);
  assert.equal(await count(), 5, 'the next older entry fills the page');
  assert.equal(clicks.length, 0);
  assert.equal(dismissals[0].origin.projectPath, '/probe/A');
  await js("document.querySelector('[data-id=\"20\"]').click()");
  await delay(100);
  assert.equal(surface.snapshot().length, 18);
  assert.equal(clicks[0].origin.projectPath, '/probe/B');
  assert.equal(stack.isVisible(), true);
  await js("document.querySelector('.tt-notif-page-more').click()");
  await delay(100);
  assert.equal(shownMore[0].notificationId, 'probe-17', 'Show More targets the newest remaining entry');
  assert.equal(surface.snapshot().length, 18);
  // (TPT505) The banner offers Hide and a checked "Show" toggle, never Clear All. Hide keeps
  // every alert and raises or focuses no window; a new send brings the banner back.
  assert.equal(await js("document.querySelector('.tt-notif-page-clear')"), null);
  assert.equal(await js("document.querySelector('.tt-notif-page-ontop input').checked"), true);
  const focusedBeforeHide = BrowserWindow.getFocusedWindow()?.id;
  await js("document.querySelector('.tt-notif-page-hide').click()");
  await delay(150);
  assert.equal(stack.isVisible(), false, 'Hide hides the banner');
  assert.equal(surface.snapshot().length, 18, 'Hide keeps every alert');
  assert.equal(BrowserWindow.getFocusedWindow()?.id, focusedBeforeHide, 'Hide focuses no window');
  assert.equal(clicks.length, 1);
  await surface.show({ title: 'TPT505: after Hide', tag: 'probe-after-hide', notificationId: 'probe-after-hide' },
    { windowId: sources[0].id, projectPath: '/probe/A' });
  await delay(100);
  assert.equal(stack.isVisible(), true, 'a new alert re-shows the banner');
  await js("const i = document.querySelector('.tt-notif-page-ontop input'); i.click()");
  await delay(100);
  assert.deepEqual(onTopSets, [false], 'unchecking Show asks main to turn Show on Top off');
  for (const { id } of surface.snapshot()) {
    ipcMain.emit('notify:desktop-action', { sender: stack.webContents, senderFrame: stack.webContents.mainFrame }, { id, action: 'close' });
  }
  await delay(100);
  assert.equal(surface.snapshot().length, 0);
  assert.equal(dismissals.length, 20);
  assert.equal(stack.isVisible(), false);
  // Task completion removes both visible and overflow cards, preserving other projects.
  for (let i = 0; i < 9; i++) {
    await surface.show({ title: `Dismissal ${i}`, tag: i % 3 === 0 ? 'TPT483' : `TPT${500 + i}`,
      notificationId: `cleanup-${i}` },
    { windowId: sources[i === 6 ? 1 : 0].id, projectPath: i === 6 ? '/probe/B' : '/probe/A' });
  }
  assert.equal(surface.dismissTask('TPT483', '/probe/A'), 1); // two sends, one alert (TPT484 upsert)
  await delay(100);
  assert.equal(await count(), 5);
  const expected = surface.snapshot().slice(0, 5).map(e => e.id).join(',');
  assert.equal(await js("[...document.querySelectorAll('.tt-notif-card')].map(c => c.dataset.id).join(',')"), expected);
  assert.equal(surface.snapshot().filter(e => e.tag === 'TPT483').length, 1, 'other project survives');
  assert.equal(new Set(surface.snapshot().map(e => e.id)).size, 7);
  // (TPT484) Focus flip: a focused project window hosts the alerts in-app and the banner steps
  // aside; another app focused brings the same alerts back to the banner. Nothing is focused.
  const before = surface.snapshot().map(e => e.id).join(',');
  projectFocus = true;
  sources[1].focus();
  await delay(300);
  surface.syncNotificationSurface({ immediate: true });
  await delay(100);
  const hostId = sources.find(w => w.isFocused())?.id;
  if (hostId) {
    assert.equal(stack.isVisible(), false, 'Tipatask focused: banner hidden');
    assert.equal(surfaceSent.get(hostId).active, true);
    assert.equal(surfaceSent.get(hostId).entries.map(e => e.id).join(','), before);
  } else console.log('NOTE: window manager refused programmatic focus; in-app half of the flip skipped.');
  projectFocus = false;
  surface.syncNotificationSurface({ immediate: true });
  await delay(100);
  assert.equal(stack.isVisible(), true, 'another app focused: banner back');
  assert.equal(await js("[...document.querySelectorAll('.tt-notif-card')].map(c => c.dataset.id).join(',')"), before.split(',').slice(0, 5).join(','));
  if (hostId) assert.equal(surfaceSent.get(hostId).active, false);
  assert.equal(stack.isFocused(), false, 'the banner never takes focus');
  // (TPT505) The banner is a non-activating panel on macOS; it must stay up while another app
  // is frontmost (no hide-on-deactivate).
  if (process.platform === 'darwin' && process.env.PROBE_SKIP_DEACTIVATE !== '1') {
    execFileSync('osascript', ['-e', 'tell application "Finder" to activate']);
    await delay(600);
    surface.syncNotificationSurface({ immediate: true });
    await delay(100);
    assert.equal(stack.isVisible(), true, 'banner stays visible while another app is frontmost');
  }
  await js("document.querySelector('.tt-notif-page-hide').click()");
  await delay(100);
  assert.equal(stack.isVisible(), false);
  for (const { id } of surface.snapshot()) {
    ipcMain.emit('notify:desktop-action', { sender: stack.webContents, senderFrame: stack.webContents.mainFrame }, { id, action: 'close' });
  }
  // Show on Top off: native OS notifications only, never the stack. The real OS decides how a
  // native ends — shown, or refused (macOS refuses an unregistered or unsigned bundle, as a dev
  // Electron is) — and either way the stack stays hidden.
  const stackedBottomRight = () => {
    const area = screen.getDisplayMatching(stack.getBounds()).workArea;
    const b = stack.getBounds();
    assert.deepEqual([b.x + b.width, b.y + b.height], [area.x + area.width, area.y + area.height], 'stack sits in the bottom-right corner');
  };
  const boxChecked = () => js("document.querySelector('.tt-notif-page-ontop input').checked");
  surface.setEnabled(false);
  const off = { windowId: sources[0].id, projectPath: '/probe/A' };
  const first = await surface.show({ title: 'Project A · TPT9327: Native probe', body: 'Show on Top off', tag: 'probe-native', notificationId: 'probe-native-1' }, off);
  const repeat = await surface.show({ title: 'Project A · TPT9327: Native probe', body: 'repeat replaces', tag: 'probe-native', notificationId: 'probe-native-2' }, off);
  await delay(300);
  assert.equal(stack.isVisible(), false, 'Show on Top off never shows the stack');
  assert.equal(surface.snapshot().length, 0, 'and shares nothing');
  assert.equal(natives.length, 2, 'each alert is tried as a native');
  let nativeOutcome;
  if (first.delivery === 'native') {
    assert.equal(repeat.delivery, 'native');
    nativeOutcome = `the OS showed native notifications (${natives.filter((n) => n.probeShown).length}/2 'show' events)`;
  } else {
    assert.deepEqual([first.ok, repeat.ok], [false, false], 'a refused native is reported as not delivered');
    assert.ok(first.reason, 'and names why');
    nativeOutcome = `the OS refused the native notification (${first.reason}) and the stack stayed hidden`;
  }
  // The reported flow (TPT9327): the stack is up with "Show" checked; unchecking it turns Show on
  // Top off, takes the stack away, and later alerts, card mirrors and focus re-syncs never bring
  // it back until the setting is turned on again.
  surface.setEnabled(true);
  applyOnTop = true;
  for (let i = 1; i <= 2; i++) {
    await surface.show({ title: `Project A · TPT9327: On top ${i}`, body: 'Shown on the stack with Show checked.',
      tag: `probe-ontop-${i}`, notificationId: `probe-ontop-${i}`, category: i === 2 ? 'completed' : 'attention' }, off);
  }
  await delay(300);
  assert.equal(stack.isVisible(), true);
  assert.equal(await count(), 2);
  assert.equal(await boxChecked(), true, 'a stack on screen shows "Show" checked');
  stackedBottomRight();
  const onTopShot = path.join(os.tmpdir(), 'tpt9327-stack-show-checked.png');
  fs.writeFileSync(onTopShot, (await stack.webContents.capturePage()).toPNG());
  await js("document.querySelector('.tt-notif-page-ontop input').click()");
  await delay(200);
  assert.equal(onTopSets.at(-1), false, 'unchecking Show asks main to turn Show on Top off');
  assert.equal(surface.isEnabled(), false);
  assert.equal(stack.isVisible(), false, 'unchecking Show takes the stack away at once');
  assert.equal(await js("document.querySelector('.tt-notif-page')"), null, 'and leaves no unchecked box behind');
  const attempted = natives.length;
  for (let i = 1; i <= 3; i++) {
    await surface.show({ title: `Project A · TPT9327: Off ${i}`, body: 'Show on Top is off.', tag: `probe-off-${i}`,
      notificationId: `probe-off-${i}` }, off);
    surface.upsertCard({ tag: `probe-off-${i}`, title: `Project A · TPT9327: Off ${i}`, seq: i }, off);
    surface.syncNotificationSurface({ immediate: true });
    await delay(150);
    assert.equal(stack.isVisible(), false, `alert ${i} while off stays off the stack`);
  }
  assert.equal(natives.length, attempted + 3, 'alerts while off go to native notifications');
  assert.equal(surface.snapshot().length, 0);
  assert.equal(stack.isFocused(), false, 'the banner never takes focus');
  // Turning it on again (View menu or Settings, the same writer) brings the next alert back to
  // the stack, with the box checked.
  surface.setEnabled(true);
  await surface.show({ title: 'Project A · TPT9327: Back on top', body: 'Show on Top is on again.', tag: 'probe-back',
    notificationId: 'probe-back' }, off);
  await delay(300);
  assert.equal(stack.isVisible(), true);
  assert.equal(await boxChecked(), true);
  stackedBottomRight();
  console.log(`PASS: five-card page, uk count, no scroll, persistence, focus, origins, isolated preload, click/close, Show More, Hide (no focus) and Show toggle, task dismissal and refill, focus flip between in-app and banner, banner kept over another app; Show on Top off: ${nativeOutcome}; unchecking a checked Show box takes the stack away and three later alerts keep it away until Show on Top is on again. Screenshots: ${screenshot}, ${onTopShot}`);
}).then(() => { surface?.dispose(); app.exit(0); }).catch(error => {
  console.error(error);
  surface?.dispose();
  app.exit(1);
});
