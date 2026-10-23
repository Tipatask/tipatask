'use strict';

// Real-click check for the always-on-top banner on macOS: Hide, × and the "Show" toggle must
// leave the frontmost app where it is, while a card click and Show More must bring Tipatask and
// the project window forward — key, on screen and the app active — also repeatedly, from
// another app's fullscreen Space, with the project window minimized, with two project windows
// and (--other-space) with the project window on another desktop. Synthetic clicks
// (element.click(), webContents.sendInputEvent()) never reach the window server, so the banner
// never takes key focus and they cannot show any of this — every click here must be a real one,
// from a person or a desktop-automation tool.
// Run with the repository's Electron binary (clear an inherited ELECTRON_RUN_AS_NODE first):
//   env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/probe-banner-real-clicks.js \
//     [--status <file>] [--only hide,card-click] [--app "Google Chrome"] [--repeat 3] \
//     [--fullscreen] [--other-space]
// Each step activates Finder or --app (--fullscreen adds a step over another app's fullscreen
// Space; --other-space adds one where you first drag the project window to another desktop)
// and shows a banner whose PROBE-… cards say what to click; the project window repeats it. It
// waits up to 300 s per click, repeats a step whose wrong control was clicked, and prints one
// result row per step (also written to --status as JSON). The raise mirrors main.js
// focusNotificationTarget(): focusWindow() with steal, then main/notify-target.js's verified
// raise with the macOS deps (LaunchServices and Space fallbacks); each row names the stage that
// confirmed it. Isolated windows only: no Task App server, API credentials or project data; the
// banner sits left of centre, clear of the running app's own banner.
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { promisify } = require('node:util');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-click-probe-')));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const option = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

// Second process: another app sitting in its own fullscreen Space.
if (process.argv.includes('--fullscreen-helper')) {
  app.whenReady().then(() => {
    new BrowserWindow({ fullscreen: true }).loadURL('data:text/html,<title>Fullscreen app</title><p>Another app, fullscreen</p>');
    process.on('SIGTERM', () => app.exit(0));
    setTimeout(() => app.exit(0), 300000);
  });
} else {
  const { createDesktopNotifications } = require('../main/desktop-notifications');
  const notifyTarget = require('../main/notify-target');
  const exec = promisify(execFile);
  const statusFile = option('--status');
  const only = option('--only')?.split(',');
  const FRONT_APP = option('--app') || 'Finder';
  const REPEAT = Math.max(1, Number(option('--repeat')) || 3);
  const DIR = '/probe/banner-clicks';
  const DIR2 = '/probe/banner-clicks-2';
  const t0 = Date.now();
  const events = [];
  const note = (event, data = {}) => events.push({ t: Date.now() - t0, event, ...data });
  const status = (data) => { if (statusFile) fs.writeFileSync(statusFile, `${JSON.stringify({ at: Date.now() - t0, ...data }, null, 2)}\n`); };
  let surface = null;

  // Frontmost app per LaunchServices. Compare pids: a dev bundle can share the app's name.
  const front = async () => {
    try {
      const asn = (await exec('lsappinfo', ['front'])).stdout.trim();
      const [pid, name] = await Promise.all(['pid', 'name'].map((key) => exec('lsappinfo', ['info', '-only', key, asn])));
      return { pid: Number(/"pid"=(\d+)/.exec(pid.stdout)?.[1]) || null, name: /="(.*)"/.exec(name.stdout)?.[1] || '?' };
    } catch { return { pid: null, name: '?' }; }
  };

  // `stay`: the frontmost app keeps the front, Tipatask is not activated. `raise`: Tipatask and
  // the project window come to the front (key, on screen, app active), the banner hides, a
  // card's click reaches the window after it is focused.
  const scenarios = [
    // A plain-text press in the strip a titled window reserves for its title bar.
    { name: 'title-strip', alerts: 2, selector: '.tt-notif-page-count', hint: 'click the "2 notifications" text (top left)',
      press: 'tt-notif-page-count', expect: 'stay' },
    { name: 'hide', alerts: 3, selector: '.tt-notif-page-hide', hint: 'click Hide (top right of this banner)', action: 'hide', expect: 'stay' },
    { name: 'close-last-card', alerts: 1, selector: '.tt-notif-card-close', hint: 'click the × on this card', action: 'close', expect: 'stay' },
    { name: 'show-toggle-off', alerts: 2, selector: '.tt-notif-page-ontop', hint: 'uncheck Show (bottom left of this banner)', action: 'on-top-off', expect: 'stay' },
    // Repeated: the second and later clicks come after Tipatask was just in front and deactivated.
    { name: 'card-click', alerts: 3, selector: '.tt-notif-card', hint: 'click the TOP card', action: 'click', expect: 'raise', repeat: REPEAT },
    { name: 'card-click-last', alerts: 1, selector: '.tt-notif-card', hint: 'click this card', action: 'click', expect: 'raise' },
    { name: 'card-click-minimized', alerts: 2, selector: '.tt-notif-card', hint: 'click the TOP card (the project window is minimized)',
      action: 'click', expect: 'raise', minimize: true },
    // Two project windows, the FIRST one focused last: the card belongs to the second.
    { name: 'card-click-other-project', alerts: 2, selector: '.tt-notif-card', hint: 'click the TOP card (it belongs to the SECOND project window)',
      action: 'click', expect: 'raise', project: 2 },
    { name: 'show-more', alerts: 7, selector: '.tt-notif-page-more', hint: 'click Show more (bottom right)', action: 'show-more', expect: 'raise' },
  ];
  if (process.argv.includes('--fullscreen')) {
    scenarios.push({ name: 'card-click-over-fullscreen', alerts: 2, selector: '.tt-notif-card', hint: 'click the TOP card',
      action: 'click', expect: 'raise', fullscreen: true, offScreen: true });
  }
  if (process.argv.includes('--other-space')) {
    scenarios.push({ name: 'card-click-other-space', alerts: 2, selector: '.tt-notif-card',
      hint: 'FIRST drag the project window to ANOTHER desktop (Mission Control), come back to this desktop, THEN click the TOP card',
      action: 'click', expect: 'raise', offScreen: true });
  }

  app.whenReady().then(async () => {
    if (process.platform !== 'darwin') { console.log('SKIP: real-click banner probe is macOS only'); return true; }
    console.log(`Probe PID: ${process.pid}`);
    app.on('did-become-active', () => note('app-active'));
    app.on('did-resign-active', () => note('app-inactive'));
    ipcMain.on('notify:desktop-action', (_event, { action } = {}) => note('action', { action }));

    // The banner lays itself out in this area: left of centre, clear of the live app's banner.
    const { id, workArea: wa } = screen.getPrimaryDisplay();
    const area = { x: wa.x + Math.round(wa.width * 0.12), y: wa.y + 40, width: 420, height: wa.height - 120 };
    const display = { id, workArea: area, bounds: area };
    const probeScreen = { getAllDisplays: () => [display], getPrimaryDisplay: () => display,
      getDisplayMatching: () => display, on() {}, removeListener() {} };

    const projects = new Map(); // window → project path
    const openProject = async (dir, { x, y, label }) => {
      const w = new BrowserWindow({ x, y, width: 640, height: 420, title: `Banner click probe: ${label}` });
      projects.set(w, dir);
      notifyTarget.trackOnScreen(w);
      w.on('focus', () => note(`${label}-focus`));
      w.on('blur', () => note(`${label}-blur`));
      w.on('closed', () => projects.delete(w));
      const send = w.webContents.send.bind(w.webContents);
      w.webContents.send = (channel, data) => {
        if (['notify:clicked', 'notify:desktop-list-open'].includes(channel)) note(channel, { window: label, focused: w.isFocused() });
        send(channel, data);
      };
      await w.loadURL(`data:text/html,<title>Banner click probe</title><p>Banner click probe: ${label}</p>`);
      return w;
    };
    const project = await openProject(DIR, { x: wa.x + Math.round(wa.width * 0.5), y: wa.y + 60, label: 'project window' });
    let project2 = null;
    const live = () => [...projects.keys()].filter((w) => !w.isDestroyed());
    const ownerOf = (dir) => live().find((w) => projects.get(w) === dir) || null;
    const originWindow = (origin) => ownerOf(origin?.projectPath);
    const showStep = (text) => Promise.all(live().map((w) => w.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(
      `<h2 style="font: 600 22px system-ui; margin: 28px">${text}</h2>`
      + '<p style="font: 15px system-ui; margin: 0 28px">Click only the banner cards titled PROBE-…</p>')}`).catch(() => {})));

    // Mirrors main.js focusWindow(w, { steal: true }) and focusNotificationTarget().
    const focusWindow = (w) => {
      if (!w || w.isDestroyed()) return false;
      try { if (app.isHidden()) app.show(); } catch {}
      app.focus({ steal: true });
      if (w.isMinimized()) w.restore();
      w.show(); w.focus(); w.moveTop();
      return true;
    };
    const raiseDeps = notifyTarget.createRaiseDeps({ app, exec: execFile, execPath: process.execPath });
    let lastRaise = null;
    const raise = (w) => notifyTarget.raiseWindow(w, { focus: focusWindow, ...raiseDeps,
      trace: (t) => { lastRaise = t; note(`raise:${t.stage}:${t.ok ? 'ok' : 'failed'}`); } });
    surface = createDesktopNotifications({ BrowserWindow, screen: probeScreen, ipcMain,
      isTrustedProjectSender: () => true, onDismiss: () => {}, onSetOnTop: (on) => surface.setEnabled(on),
      focusedProjectWindow: () => { const w = BrowserWindow.getFocusedWindow(); return w && projects.has(w) ? w : null; },
      projectWindows: live,
      onShowMore: (entry) => notifyTarget.resolveShowMoreTarget(entry.origin,
        { originWindow, projectWindows: live, reopen: async () => null, raise }).catch(() => null),
      // Mirrors main.js onClick.
      onClick: async (entry) => {
        const w = await notifyTarget.resolveClickTarget(entry.origin,
          { originWindow, projectOf: (target) => projects.get(target) || null, reopen: async () => null, raise });
        if (!w) return;
        const deliver = () => { if (!w.isDestroyed()) w.webContents.send('notify:clicked', { tag: entry.tag }); };
        if (w.webContents.isLoading()) w.webContents.once('did-finish-load', deliver);
        else deliver();
      } });
    app.on('browser-window-focus', () => surface.syncNotificationSurface());
    app.on('browser-window-blur', () => surface.syncNotificationSurface());

    const banner = () => BrowserWindow.getAllWindows().find((w) => surface.owns(w)) || null;
    let watched = null;
    let seq = 0;
    const reset = async (s, instruction) => {
      if (!surface.isEnabled()) surface.setEnabled(true);
      for (const entry of surface.snapshot()) surface.dismissKey(entry.tag, projects.get(originWindow({ projectPath: entry.projectPath })) || DIR);
      const target = s.project === 2 ? project2 : project;
      for (let i = 1; i <= s.alerts; i++) {
        seq += 1;
        await surface.show({ title: `PROBE-${seq}: ${s.name} ${i}/${s.alerts}`, body: instruction, tag: `probe-${seq}`,
          notificationId: `probe-${seq}`, category: 'attention' }, { windowId: target.id, projectPath: projects.get(target) });
      }
      const b = banner();
      if (b && b !== watched) {
        watched = b;
        b.on('focus', () => note('banner-focus'));
        b.on('blur', () => note('banner-blur'));
        // Times the real press inside the banner page, so activation can be placed before or
        // after the mousedown that caused it.
        b.webContents.on('console-message', (event) => {
          const text = String(event.message ?? '');
          if (text.startsWith('probe:')) note(text.slice(6));
        });
      }
      await b?.webContents.executeJavaScript(`if (!window.probeInput) {
        window.probeInput = true;
        for (const type of ['mousedown', 'mouseup']) {
          document.addEventListener(type, (e) => console.log('probe:' + type + ':' + (e.target.className || e.target.tagName)), true);
        }
      }`).catch(() => {});
    };
    const locate = async (selector) => {
      const b = banner();
      const rect = await b.webContents.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!rect) return null;
      const bounds = b.getBounds();
      return { x: Math.round(bounds.x + rect.x), y: Math.round(bounds.y + rect.y) };
    };
    // The step's click: a banner action, or for a `press` step a mousedown in the page. Samples
    // the target window on the way, so the row can say what state it was clicked from.
    const nextHit = async (s, since, target, ms = 300000) => {
      const before = { offScreen: !notifyTarget.onScreen(target), minimized: target.isMinimized() };
      for (const end = Date.now() + ms; Date.now() < end; await delay(50)) {
        const hit = events.find((e) => e.t >= since && (e.event === 'action' || (s.press && e.event.startsWith('mousedown:'))));
        if (hit) return { hit, before };
        before.offScreen = !notifyTarget.onScreen(target);
        before.minimized = target.isMinimized();
      }
      return { hit: null, before };
    };

    const runScenario = async (s, instruction) => {
      if (s.project === 2 && !project2) {
        project2 = await openProject(DIR2, { x: wa.x + Math.round(wa.width * 0.55), y: wa.y + 160, label: 'second project window' });
        await delay(400);
        focusWindow(project); // the first window is the last Tipatask window the user had in front
        await delay(400);
      }
      const target = s.project === 2 ? project2 : project;
      await reset(s, instruction);
      await showStep(instruction);
      lastRaise = null;
      let helper = null;
      try {
        if (s.minimize) { target.minimize(); await delay(800); }
        if (s.fullscreen) {
          helper = spawn(process.execPath, [__filename, '--fullscreen-helper'], { stdio: 'ignore' });
          await delay(4500);
        } else {
          // A stray click on the probe window brings it forward: hand the front back first.
          for (let i = 0; i < 3 && (i === 0 || (await front()).pid === process.pid); i++) {
            execFileSync('open', ['-a', FRONT_APP]);
            await delay(1200);
          }
        }
        surface.syncNotificationSurface({ immediate: true });
        await delay(300);
        const before = await front();
        const point = banner()?.isVisible() ? await locate(s.selector) : null;
        if (!point) {
          return { scenario: s.name, pass: false, reason: 'banner or target not shown', bannerVisible: !!banner()?.isVisible(),
            front: before.name, projectFocused: target.isFocused(), entries: surface.snapshot().length, enabled: surface.isEnabled() };
        }
        if (before.pid === process.pid) return { scenario: s.name, pass: false, reason: 'the probe app is still frontmost' };
        const since = Date.now() - t0;
        console.log(`WAITING ${s.name}: ${instruction} — x=${point.x}, y=${point.y} (screen points; frontmost: ${before.name})`);
        status({ waiting: s.name, instruction, ...point, front: before.name });
        const { hit, before: state } = await nextHit(s, since, target);
        if (!hit) return { scenario: s.name, pass: false, reason: 'no click within 300 s' };
        if (s.press ? !hit.event.includes(s.press) : hit.action !== s.action) {
          await delay(2500);
          return { scenario: s.name, pass: false, reason: 'wrong target', got: hit.action || hit.event };
        }
        const samples = [];
        for (const ms of [300, 1000, 2500, 4000]) {
          await delay(ms - (samples.at(-1)?.ms ?? 0));
          samples.push({ ms, ...(await front()) });
        }
        const seen = events.filter((e) => e.t >= since);
        const row = { scenario: s.name, frontBefore: before.name, offScreenBefore: state.offScreen, minimizedBefore: state.minimized,
          front: samples.map((x) => `${x.ms}ms:${x.pid === process.pid ? 'PROBE' : x.name}`).join(' '),
          activated: seen.some((e) => e.event === 'app-active'), bannerTookKey: seen.some((e) => e.event === 'banner-focus'),
          active: app.isActive(), projectFocused: target.isFocused(), onScreen: notifyTarget.onScreen(target),
          minimized: target.isMinimized(), bannerVisible: !!banner()?.isVisible(),
          stage: lastRaise ? `${lastRaise.stages.join('>')}:${lastRaise.ok ? 'ok' : 'failed'}` : null };
        if (s.project === 2) row.otherProjectFocused = project.isFocused();
        if (s.action === 'click') {
          const clicked = seen.find((e) => e.event === 'notify:clicked');
          Object.assign(row, { clickedSent: !!clicked, clickedAfterFocus: !!clicked?.focused });
        }
        if (s.action === 'show-more') row.listOpened = seen.some((e) => e.event === 'notify:desktop-list-open');
        const ours = samples.at(-1).pid === process.pid;
        row.pass = s.expect === 'stay'
          ? !ours && !row.activated && !row.projectFocused
          : ours && row.active && row.projectFocused && row.onScreen && !row.minimized && !row.bannerVisible
            && (s.action !== 'click' || row.clickedAfterFocus) && (s.action !== 'show-more' || row.listOpened)
            && (!s.offScreen || row.offScreenBefore) && (!s.minimize || row.minimizedBefore) && (s.project !== 2 || !row.otherProjectFocused);
        row.events = seen.filter((e) => e.event !== 'action').map((e) => `${e.t - hit.t}:${e.event}`).join(' ');
        return row;
      } finally {
        if (helper) { helper.kill('SIGTERM'); await delay(1500); }
        if (s.project === 2 && project2 && !project2.isDestroyed()) { project2.destroy(); project2 = null; await delay(300); }
      }
    };

    const selected = scenarios.filter((s) => !only || only.includes(s.name));
    const rows = [];
    for (const [index, s] of selected.entries()) {
      for (let round = 1; round <= (s.repeat || 1); round++) {
        const label = s.repeat ? `${s.name} ${round}/${s.repeat}` : s.name;
        const step = `Step ${index + 1}/${selected.length}${s.repeat ? ` (round ${round}/${s.repeat})` : ''}: ${s.hint}`;
        let row;
        for (let attempt = 1; attempt <= 3; attempt++) {
          row = await runScenario(s, step);
          if (row.reason !== 'wrong target') break;
          console.log(`RETRY ${label}: got ${row.got}, expected ${s.press || s.action}`);
        }
        row.scenario = label;
        rows.push(row);
        console.log(JSON.stringify(row));
        status({ done: label, row });
      }
    }

    const failed = rows.filter((r) => !r.pass);
    status({ finished: true, rows, events });
    await showStep(`Done: ${rows.length - failed.length}/${rows.length} steps passed. You can go back to the terminal.`);
    console.log(failed.length ? `FAIL: ${failed.map((r) => r.scenario).join(', ')}` : `PASS: ${rows.length} real-click scenarios`);
    await delay(3000);
    return !failed.length;
  }).then((ok) => { surface?.dispose(); app.exit(ok ? 0 : 1); }, (error) => {
    console.error(error);
    surface?.dispose();
    app.exit(1);
  });
}
