'use strict';

// Real-Electron check that the banner's Show More and card clicks always end with a focused
// project window holding the list / the click. Run with the repository's Electron binary
// (clear an inherited ELECTRON_RUN_AS_NODE first):
//   env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/probe-notification-raise.js
// Isolated windows only: no Task App server, API credentials or project data. macOS: it moves
// focus on purpose (activates Finder, raises its own windows, opens one short-lived fullscreen
// window in a second process), so do not type while it runs (~40 s).
const { app, BrowserWindow, screen, ipcMain, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-raise-probe-')));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PAGE = 'data:text/html,<title>Notification raise probe</title><p>Isolated notification test</p>';

// Second process: "another app" sitting in its own fullscreen Space.
if (process.argv.includes('--fullscreen-helper')) {
  app.whenReady().then(() => {
    new BrowserWindow({ fullscreen: true }).loadURL(PAGE);
    process.on('SIGTERM', () => app.exit(0));
    setTimeout(() => app.exit(0), 15000);
  });
} else {
  const { createDesktopNotifications } = require('../main/desktop-notifications');
  const notifyTarget = require('../main/notify-target');
  let surface;
  app.whenReady().then(async () => {
    console.log(`Probe PID: ${process.pid}`);
    const mac = process.platform === 'darwin';
    const projects = new Map(); // window → project path
    const sent = new Map();     // window → channels received
    // A page that takes a second to arrive, like a project window booting its board.
    protocol.handle('slowpage', async () => { await delay(1000); return new Response(decodeURIComponent(PAGE.split(',')[1]), { headers: { 'content-type': 'text/html' } }); });
    const openProject = (dir, { slow = false } = {}) => {
      const w = new BrowserWindow({ width: 640, height: 400 });
      projects.set(w, dir);
      sent.set(w, []);
      let pageLoaded = false;
      w.webContents.on('did-finish-load', () => { pageLoaded = true; });
      const send = w.webContents.send.bind(w.webContents);
      w.webContents.send = (channel, data) => { sent.get(w).push({ channel, loaded: pageLoaded }); send(channel, data); };
      w.on('closed', () => projects.delete(w));
      w.loadURL(slow ? 'slowpage://probe/' : PAGE); // returns before the page has loaded, like main.js createProjectWindow()
      return w;
    };
    const live = () => [...projects.keys()].filter((w) => !w.isDestroyed());
    const ownerOf = (dir) => live().find((w) => projects.get(w) === dir) || null;
    // Mirrors main.js focusWindow(w, { steal: true }).
    const focus = (w) => {
      if (w.isDestroyed()) return false;
      if (mac) app.focus({ steal: true });
      if (w.isMinimized()) w.restore();
      w.show(); w.focus(); w.moveTop();
      return true;
    };
    const raise = (w) => notifyTarget.raiseWindow(w, { focus });
    const originWindow = (origin) => ownerOf(origin.projectPath);
    const clicks = [];
    surface = createDesktopNotifications({ BrowserWindow, screen, ipcMain,
      isTrustedProjectSender: () => true, onDismiss: () => {}, onSetOnTop: () => {},
      focusedProjectWindow: () => { const w = BrowserWindow.getFocusedWindow(); return w && projects.has(w) ? w : null; },
      projectWindows: live,
      onShowMore: (entry) => notifyTarget.resolveShowMoreTarget(entry.origin,
        { originWindow, projectWindows: live, reopen: async (dir) => openProject(dir, { slow: true }), raise }),
      onClick: async (entry) => {
        const w = await notifyTarget.resolveClickTarget(entry.origin,
          { originWindow, projectOf: (target) => projects.get(target), reopen: async (dir) => openProject(dir, { slow: true }) });
        if (!w) return;
        const focused = raise(w);
        const deliver = async () => { w.webContents.send('notify:clicked', { tag: entry.tag }); clicks.push({ tag: entry.tag, w, focused: await focused }); };
        if (w.webContents.isLoading()) w.webContents.once('did-finish-load', deliver); else deliver();
      } });
    app.on('browser-window-focus', () => surface.syncNotificationSurface());
    app.on('browser-window-blur', () => surface.syncNotificationSurface());

    let seq = 0;
    const alert = (dir) => surface.show({ title: `TPT553: alert ${++seq}`, body: 'Raise probe', tag: `raise-${seq}`,
      notificationId: `raise-${seq}` }, { windowId: ownerOf(dir)?.id ?? null, projectPath: dir });
    // Another app in front, the banner showing: the state every case starts from.
    const awayFromApp = async () => {
      if (mac) { execFileSync('open', ['-a', 'Finder']); await delay(1000); }
      surface.syncNotificationSurface({ immediate: true });
      await delay(200);
    };
    const banner = () => BrowserWindow.getAllWindows().find((w) => surface.owns(w));
    const js = (code) => banner().webContents.executeJavaScript(code);
    const opened = (w) => sent.get(w).filter((m) => m.channel === 'notify:desktop-list-open');
    const until = async (check, ms = 4000) => {
      for (const end = Date.now() + ms; Date.now() < end; await delay(50)) { const value = check(); if (value) return value; }
      return null;
    };
    const rows = [];
    // Clicks Show More on the banner and waits for the list to reach a focused project window.
    const showMore = async (label, expectProject) => {
      for (const list of sent.values()) list.length = 0;
      await js("document.querySelector('.tt-notif-page-more').click()");
      const target = await until(() => live().find((w) => opened(w).length));
      assert.ok(target, `${label}: no project window received notify:desktop-list-open`);
      assert.equal(opened(target).every((m) => m.loaded), true, `${label}: list sent to a page that was still loading`);
      const focused = !!(await until(() => target.isFocused(), 3000));
      await delay(250);
      rows.push({ case: label, listIn: projects.get(target), focused, bannerHidden: !banner().isVisible() });
      console.log(JSON.stringify(rows.at(-1)));
      assert.equal(focused, true, `${label}: the list window did not take focus`);
      assert.equal(banner().isVisible(), false, `${label}: the banner stayed up over a focused list`);
      if (expectProject) assert.equal(projects.get(target), expectProject, label);
      return target;
    };

    let a = openProject('/probe/A');
    let b = openProject('/probe/B');
    await delay(800);
    for (let i = 0; i < 7; i++) await alert(i % 2 ? '/probe/B' : '/probe/A'); // newest: A
    await delay(400);

    await awayFromApp();
    await showMore('newest window open', '/probe/A');

    a.minimize(); await delay(700);
    await awayFromApp();
    await showMore('newest window minimized', '/probe/A');

    await alert('/probe/B'); // newest: B, while A was the last key window
    await awayFromApp();
    await showMore('newest from another project', '/probe/B');

    await alert('/probe/A'); // newest: A, then its window closes
    a.destroy(); await delay(300);
    await awayFromApp();
    await showMore('newest window closed → another open project window', '/probe/B');

    b.destroy(); await delay(300);
    surface.syncNotificationSurface({ immediate: true }); await delay(200);
    await showMore('no project window left → project reopened, list sent after load', '/probe/A');
    a = ownerOf('/probe/A');

    if (mac && process.env.PROBE_SKIP_FULLSCREEN !== '1') {
      const helper = spawn(process.execPath, [__filename, '--fullscreen-helper'], { stdio: 'ignore' });
      await delay(4500);
      surface.syncNotificationSurface({ immediate: true }); await delay(300);
      try { await showMore('another app fullscreen (banner key after activation)', '/probe/A'); }
      finally { helper.kill('SIGTERM'); await delay(1500); }
    }

    // A snapshot landing between mousedown and mouseup must not swallow the card click.
    b = openProject('/probe/B'); await delay(600);
    await alert('/probe/B');
    await awayFromApp();
    const point = JSON.parse(await js("(() => { const r = document.querySelector('.tt-notif-card').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()"));
    const wc = banner().webContents;
    wc.sendInputEvent({ type: 'mouseMove', ...point });
    wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    await delay(40);
    surface.syncNotificationSurface({ immediate: true }); // what the press's own focus event triggers
    await delay(60);
    wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    const pressed = await until(() => clicks[0]);
    assert.ok(pressed, 'a re-render during the press swallowed the card click');
    rows.push({ case: 'card click with a re-render mid-press', clickIn: projects.get(pressed.w), focused: pressed.focused });
    console.log(JSON.stringify(rows.at(-1)));
    assert.equal(pressed.focused, true);

    // Card click after its project window closed: the project comes back and gets the click.
    await alert('/probe/B');
    b.destroy(); await delay(300);
    await awayFromApp();
    clicks.length = 0;
    await js("document.querySelector('.tt-notif-card').click()");
    const late = await until(() => clicks[0]);
    assert.ok(late, 'a card whose window closed did nothing');
    assert.equal(projects.get(late.w), '/probe/B');
    assert.equal(sent.get(late.w).find((m) => m.channel === 'notify:clicked').loaded, true, 'click sent to a page that was still loading');
    rows.push({ case: 'card click after its window closed → project reopened', clickIn: '/probe/B', focused: late.focused });
    console.log(JSON.stringify(rows.at(-1)));
    assert.equal(late.focused, true);

    console.log(`PASS: ${rows.length} cases — Show More and card clicks always reach a focused project window.`);
  }).then(() => { surface?.dispose(); app.exit(0); }).catch((error) => {
    console.error(error);
    surface?.dispose();
    app.exit(1);
  });
}
