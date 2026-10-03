'use strict';

// Run with the repository's Electron binary. Uses isolated windows and no Task App server,
// API credentials or project data. Exits after checking real renderer/IPC behavior.
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDesktopNotifications } = require('../main/desktop-notifications');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-banner-probe-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let surface;
app.whenReady().then(async () => {
  console.log(`Probe PID: ${process.pid}`);
  const sources = [new BrowserWindow({ show: false }), new BrowserWindow({ show: false })];
  const clicks = [], dismissals = [];
  surface = createDesktopNotifications({ BrowserWindow, screen, ipcMain,
    onClick: entry => { clicks.push(entry); BrowserWindow.fromId(entry.origin.windowId)?.show(); },
    onDismiss: entry => dismissals.push(entry) });
  for (const w of sources) await w.loadURL('data:text/html,<title>Notification probe</title><p>Isolated notification test</p>');
  sources[0].show();
  sources[0].minimize();
  sources[1].show();
  await delay(250);
  const focused = BrowserWindow.getFocusedWindow()?.id;
  for (let i = 0; i < 20; i++) {
    assert.equal((await surface.show({ title: `Project ${i % 2 ? 'B' : 'A'} · TPT464: Banner ${i + 1}`,
      body: i === 0 ? '<img src=x onerror=alert(1)> stays plain text' : 'This banner stays until individually clicked or closed.',
      tag: 'same-task', notificationId: `probe-${i}`, category: i % 2 ? 'completed' : 'attention', locale: i % 2 ? 'uk' : 'en' },
    { windowId: sources[i % 2].id, projectPath: i % 2 ? '/probe/B' : '/probe/A' })).ok, true);
  }
  const stack = BrowserWindow.getAllWindows().find(w => surface.owns(w));
  await delay(400);
  assert.equal(BrowserWindow.getFocusedWindow()?.id, focused, 'delivery must not steal focus');
  const count = () => stack.webContents.executeJavaScript("document.querySelectorAll('.tt-notif-card').length");
  assert.equal(await count(), 20);
  assert.equal(await stack.webContents.executeJavaScript('typeof window.electronAPI'), 'undefined');
  assert.equal(await stack.webContents.executeJavaScript("document.querySelectorAll('img').length"), 0);
  assert.equal(await stack.webContents.executeJavaScript("document.querySelector('#tt-notif-stack').scrollHeight > document.querySelector('#tt-notif-stack').clientHeight"), true);
  console.log('Twenty banners visible; waiting 31 seconds beyond native banner lifetime.');
  await delay(31000);
  assert.equal(await count(), 20);
  assert.equal(stack.isVisible(), true);
  const screenshot = path.join(os.tmpdir(), 'tpt464-desktop-stack.png');
  fs.writeFileSync(screenshot, (await stack.webContents.capturePage()).toPNG());
  await stack.webContents.executeJavaScript("document.querySelector('[data-tag=\"2\"] .tt-notif-card-close').click()");
  await delay(100);
  assert.equal(await count(), 19);
  assert.equal(clicks.length, 0);
  assert.equal(dismissals[0].origin.projectPath, '/probe/B');
  await stack.webContents.executeJavaScript("document.querySelector('[data-tag=\"1\"]').click()");
  await delay(100);
  assert.equal(await count(), 18);
  assert.equal(clicks[0].origin.projectPath, '/probe/A');
  assert.equal(stack.isVisible(), true);
  await stack.webContents.executeJavaScript("document.querySelectorAll('.tt-notif-card-close').forEach(b => b.click())");
  await delay(100);
  assert.equal(surface.snapshot().length, 0);
  assert.equal(stack.isVisible(), false);
  console.log(`PASS: persistence, overflow, focus, project origins, isolated preload, per-banner click/close. Screenshot: ${screenshot}`);
}).then(() => { surface?.dispose(); app.exit(0); }).catch(error => {
  console.error(error);
  surface?.dispose();
  app.exit(1);
});
