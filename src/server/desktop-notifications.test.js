'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDesktopNotifications } = require('../../main/desktop-notifications');

function fixture({ fail = false } = {}) {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter();
      this.webContents.mainFrame = {}; this.webContents.send = (_name, data) => { this.data = data; };
      this.webContents.setWindowOpenHandler = () => {}; windows.push(this); }
    static fromId() { return null; }
    isDestroyed() { return !!this.destroyed; }
    setMenu() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
    setBounds(bounds) { this.bounds = bounds; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    async loadFile() { if (fail) throw new Error('missing asset'); }
  }
  const ipcMain = new EventEmitter();
  const screen = new EventEmitter();
  const display = { id: 1, workArea: { x: 100, y: 20, width: 1024, height: 768 } };
  screen.getAllDisplays = () => [display]; screen.getPrimaryDisplay = () => display;
  const clicked = [], dismissed = [];
  const surface = createDesktopNotifications({ BrowserWindow, screen, ipcMain,
    onClick: e => clicked.push(e), onDismiss: e => dismissed.push(e) });
  const action = (id, action, trusted = true) => {
    const w = windows.at(-1);
    ipcMain.emit('notify:desktop-action', { sender: trusted ? w.webContents : {}, senderFrame: w.webContents.mainFrame }, { id, action });
  };
  return { surface, windows, clicked, dismissed, action, screen };
}

test('independent banners survive time, overflow, equal tags and per-entry actions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  const origin = { windowId: 1, projectPath: '/a' };
  for (let i = 0; i < 8; i++) assert.equal((await f.surface.show({ title: 'Title', tag: 'same', notificationId: `n${i}` },
    i % 2 ? { ...origin, projectPath: '/b' } : origin)).ok, true);
  t.mock.timers.tick(120000);
  assert.equal(f.surface.snapshot().length, 8);
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].visible, true);
  assert.ok(f.windows[0].bounds.height <= 768 * .75);
  f.action('1', 'click', false);
  assert.equal(f.surface.snapshot().length, 8);
  f.action('1', 'click');
  assert.equal(f.clicked[0].origin.projectPath, '/a');
  f.action('2', 'close');
  assert.equal(f.dismissed[0].origin.projectPath, '/b');
  assert.equal(f.surface.snapshot().length, 6);
  f.action('1', 'click');
  assert.equal(f.clicked.length, 1);
  for (const entry of f.surface.snapshot()) f.action(entry.id, 'close');
  assert.equal(f.windows[0].visible, false);
  f.surface.dispose();
  assert.equal(f.screen.listenerCount('display-removed'), 0);
});

test('a failed desktop load reports failure and removes the undelivered entry', async () => {
  const f = fixture({ fail: true });
  assert.deepEqual(await f.surface.show({}, {}), { ok: false, reason: 'desktop-unavailable' });
  assert.deepEqual(f.surface.snapshot(), []);
  f.surface.dispose();
});
