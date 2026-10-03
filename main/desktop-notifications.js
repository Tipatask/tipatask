'use strict';

const path = require('node:path');

// Own the lifetime in main: project reloads, task events and elapsed time cannot dismiss
// desktop banners. Only this window's per-entry actions remove them (or app shutdown).
function createDesktopNotifications({ BrowserWindow, screen, ipcMain, onClick, onDismiss }) {
  const entries = new Map();
  let sequence = 0;
  let window = null;
  let loading = null;
  let disposed = false;
  let displayId = null;

  const snapshot = () => [...entries.values()].reverse().map(({ origin, ...entry }) => entry);
  const trusted = (event) => window && !window.isDestroyed()
    && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;

  function layout() {
    if (!window || window.isDestroyed()) return;
    const display = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
    const area = display.workArea;
    const width = Math.min(360, area.width);
    const height = Math.min(Math.max(1, entries.size) * 116 + 16, 600, Math.floor(area.height * 0.75));
    window.setBounds({ x: area.x + area.width - width, y: area.y + area.height - height, width, height });
  }

  function publish() {
    if (!window || window.isDestroyed() || loading) return;
    layout();
    window.webContents.send('notify:desktop-state', snapshot());
    if (entries.size) window.showInactive();
    else window.hide();
  }

  async function ensureWindow(origin) {
    if (disposed) throw new Error('closed');
    if (loading) return loading;
    if (window && !window.isDestroyed()) return;
    const source = BrowserWindow.fromId(origin.windowId);
    displayId = source && !source.isDestroyed() ? screen.getDisplayMatching(source.getBounds()).id : screen.getPrimaryDisplay().id;
    const w = window = new BrowserWindow({
      width: 360, height: 132, show: false, frame: false, transparent: true,
      alwaysOnTop: true, skipTaskbar: true, resizable: false, minimizable: false,
      maximizable: false, fullscreenable: false, title: 'TipATask',
      webPreferences: { preload: path.join(__dirname, 'desktop-notifications-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    w.setMenu(null);
    w.setAlwaysOnTop(true, 'floating');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (event) => event.preventDefault());
    w.webContents.on('did-finish-load', publish);
    w.on('close', (event) => { if (!disposed) event.preventDefault(); });
    w.on('closed', () => { if (window === w) { window = null; loading = null; } });
    loading = w.loadFile(path.join(__dirname, 'desktop-notifications.html'));
    try { await loading; } catch (error) { w.destroy(); throw error; }
    finally { loading = null; }
  }

  ipcMain.on('notify:desktop-action', (event, { id, action } = {}) => {
    if (!trusted(event) || !['click', 'close'].includes(action)) return;
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    publish();
    // Remove first: opening a task may itself produce another banner.
    if (action === 'click') onClick(entry);
    else onDismiss(entry);
  });
  screen.on('display-metrics-changed', layout);
  screen.on('display-removed', layout);

  return {
    async show(payload, origin) {
      const id = String(++sequence);
      entries.set(id, { id, origin, notificationId: payload.notificationId,
        tag: payload.tag, taskId: payload.taskId,
        title: String(payload.title || 'TipATask').slice(0, 500),
        body: String(payload.body || '').slice(0, 4000),
        category: ['attention', 'completed', 'objective', 'activity'].includes(payload.category) ? payload.category : null,
        locale: payload.locale === 'uk' ? 'uk' : 'en' });
      try { await ensureWindow(origin); publish(); return { ok: true, id, delivery: 'desktop' }; }
      catch (error) { entries.delete(id); return { ok: false, reason: 'desktop-unavailable' }; }
    },
    snapshot,
    owns: (w) => w === window,
    dispose() {
      disposed = true;
      entries.clear();
      screen.removeListener('display-metrics-changed', layout);
      screen.removeListener('display-removed', layout);
      if (window && !window.isDestroyed()) window.destroy();
    },
  };
}

module.exports = { createDesktopNotifications };
