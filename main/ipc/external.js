'use strict';

const path = require('node:path');
const { parseAllowedExternalUrl } = require('../external-links');

const NOTIFICATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';

function isTrustedTopFrame(event, { BrowserWindow, projectDirs, appOrigin }) {
  const sender = event?.sender;
  if (!sender || !projectDirs.has(sender.id) || !event.senderFrame || event.senderFrame !== sender.mainFrame) return false;
  const window = BrowserWindow.fromWebContents(sender);
  if (!window || window.isDestroyed() || window.webContents !== sender) return false;
  try {
    const frameUrl = new URL(event.senderFrame.url);
    return frameUrl.origin === appOrigin && frameUrl.pathname === '/todo.html';
  } catch {
    return false;
  }
}

function registerExternalIpcHandlers({ ipcMain, shell, BrowserWindow, projectDirs, app, appOrigin, platform = process.platform }) {
  const trusted = (event) => isTrustedTopFrame(event, { BrowserWindow, projectDirs, appOrigin });

  ipcMain.handle('open-external', async (event, url) => {
    if (!trusted(event)) return { ok: false, error: 'untrusted_sender' };
    const target = parseAllowedExternalUrl(url);
    if (!target) return { ok: false, error: 'invalid_url' };
    try {
      await shell.openExternal(target.href);
      return { ok: true };
    } catch {
      return { ok: false, error: 'open_failed' };
    }
  });

  // Native actions use main-process-owned destinations. The renderer cannot supply
  // a file path or a custom URL scheme through the general open-external channel.
  ipcMain.handle('debug:reveal-perf-log', (event) => {
    if (!trusted(event)) return { ok: false, error: 'untrusted_sender' };
    const logPath = path.join(app.getPath('userData'), 'logs', `perf-${new Date().toISOString().slice(0, 10)}.log`);
    try {
      shell.showItemInFolder(logPath);
      return { ok: true };
    } catch {
      return { ok: false, error: 'open_failed' };
    }
  });

  ipcMain.handle('settings:open-notifications', async (event) => {
    if (!trusted(event)) return { ok: false, error: 'untrusted_sender' };
    if (platform !== 'darwin') return { ok: false, error: 'unsupported_platform' };
    try {
      await shell.openExternal(NOTIFICATION_SETTINGS_URL);
      return { ok: true };
    } catch {
      return { ok: false, error: 'open_failed' };
    }
  });
}

module.exports = { isTrustedTopFrame, registerExternalIpcHandlers };
