'use strict';

// Window close / app quit lifecycle in main.js: requestConfirmedWindowClose() gates a window's
// destruction behind its confirmation, and only a confirmed quit reaches will-quit's server tree
// kill. main.js requires `electron`, so the functions are lifted out of its source and run in a vm
// context against fake windows/dialog/app — same approach as project-access.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const main = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');

// Brace-balanced extraction of one top-level function declaration.
function mainFunction(name) {
  const start = main.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `main.js has no function ${name}`);
  const open = main.indexOf('{', main.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < main.length; i++) {
    if (main[i] === '{') depth++;
    else if (main[i] === '}' && --depth === 0) return main.slice(start, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

const FUNCTIONS = [
  'quitIfOnlyNotificationWindowRemains', 'confirmAndQuit', 'quitWithoutConfirmation',
  'confirmWindowClose', 'attachCloseGuard', 'closingWindowQuitsApp',
  'requestConfirmedWindowClose', 'onBeforeQuit', 'onWindowAllClosed', 'onWillQuit',
];

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness({ platform = 'win32', windows: count = 1, sessions = 0 } = {}) {
  const live = [];
  const dialogs = [];
  const events = [];

  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.webContents = { executeJavaScript: async () => ({ sessions }) };
      live.push(this);
    }
    isDestroyed() { return this.destroyed; }
    // Electron semantics: 'close' is preventable; otherwise the window is destroyed.
    close() {
      if (this.destroyed) return;
      const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', e);
      if (e.defaultPrevented) return;
      this.destroyed = true;
      live.splice(live.indexOf(this), 1);
      this.emit('closed');
    }
  }

  const dialog = {
    showMessageBox(owner, opts) {
      let settle;
      const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      dialogs.push({ owner, opts, answer: (response) => settle.resolve({ response }), fail: (err) => settle.reject(err) });
      return promise;
    },
  };

  const ctx = {
    process: { platform },
    console: { warn() {} },
    dialog,
    mt: (key) => key,
    BrowserWindow: { getAllWindows: () => [...live] },
    desktopNotifications: { owns: () => false, dispose: () => events.push('dispose') },
    openProjectWindows: () => live.filter((w) => !w.isDestroyed()),
    saveWindowSession: () => events.push('save-session'),
    _syncOpenProjectsNow: async () => { events.push('sync'); },
    setTimeout: () => {},
    killWindowsProcessTree: (pid) => events.push(`taskkill:${pid}`),
    serverChild: { pid: 4242, exitCode: null, signalCode: null },
    serverStopping: false,
    _confirmingQuit: false,
    _quitConfirmed: false,
    _quitting: false,
    _initialWindowsCreated: true,
    _closeConfirmed: new WeakSet(),
    _closePrompting: new WeakSet(),
  };
  // Electron's app.quit(): before-quit (preventable) → close every window (each preventable)
  // → will-quit → exit. window-all-closed is not emitted for an app.quit()-driven close, and a
  // re-entrant app.quit() while already quitting is ignored (Browser::Quit's is_quitting_).
  ctx.app = {
    quitting: false,
    quit() {
      events.push('app.quit');
      if (this.quitting) return;
      const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      ctx.onBeforeQuit(e);
      if (e.defaultPrevented) return;
      this.quitting = true;
      for (const w of [...live]) w.close();
      if (live.length) return;
      ctx.onWillQuit();
      events.push('exit');
    },
  };
  vm.createContext(ctx);
  vm.runInContext(FUNCTIONS.map(mainFunction).join('\n'), ctx);

  const windows = Array.from({ length: count }, () => {
    const w = new FakeWindow();
    ctx.attachCloseGuard(w);
    w.on('closed', () => ctx.quitIfOnlyNotificationWindowRemains());
    return w;
  });
  return { ctx, windows, live, dialogs, events };
}

test('win32 last window: confirmation shows before destruction; Cancel keeps it and the server', async () => {
  const h = harness();
  const [w] = h.windows;
  w.close();
  await flush();
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.dialogs[0].opts.title, 'confirm.quitTitle');
  assert.equal(h.dialogs[0].owner, w, 'quit dialog is modal to the window being closed');
  assert.equal(w.isDestroyed(), false, 'window is still alive while the dialog is open');

  h.dialogs[0].answer(h.dialogs[0].opts.cancelId);
  await flush();
  assert.equal(w.isDestroyed(), false);
  assert.deepEqual(h.events, [], 'no quit, no session write, no tree kill');
  assert.equal(h.ctx._quitConfirmed, false);
  assert.equal(h.ctx._confirmingQuit, false);
});

test('win32 last window: retry after Cancel prompts again, and Quit exits once with one tree kill', async () => {
  const h = harness();
  const [w] = h.windows;
  w.close();
  await flush();
  h.dialogs[0].answer(1);
  await flush();

  w.close();
  await flush();
  assert.equal(h.dialogs.length, 2, 'retry shows the dialog again');
  h.dialogs[1].answer(0);
  await flush();
  await flush();
  assert.equal(w.isDestroyed(), true);
  assert.deepEqual(h.events, ['app.quit', 'dispose', 'save-session', 'sync', 'app.quit', 'app.quit', 'taskkill:4242', 'exit']);
  assert.equal(h.ctx.serverStopping, true);
  h.ctx.onWillQuit();
  assert.equal(h.events.filter((e) => e.startsWith('taskkill')).length, 1, 'tree kill runs once');
});

test('repeated close clicks while the dialog is pending show exactly one dialog', async () => {
  const h = harness();
  const [w] = h.windows;
  w.close();
  w.close();
  await flush();
  w.close();
  await flush();
  assert.equal(h.dialogs.length, 1);
  assert.equal(w.isDestroyed(), false);
});

test('repeated clicks on a non-last window with sessions show one close dialog; retry works', async () => {
  const h = harness({ windows: 2, sessions: 1 });
  const [a] = h.windows;
  a.close();
  await flush();
  a.close();
  a.close();
  await flush();
  assert.equal(h.dialogs.length, 1);
  h.dialogs[0].answer(h.dialogs[0].opts.cancelId);
  await flush();
  assert.equal(a.isDestroyed(), false);
  a.close();
  await flush();
  assert.equal(h.dialogs.length, 2, 'a later click prompts again');
});

test('a dialog that throws fails open instead of trapping the last window', async () => {
  const h = harness();
  const [w] = h.windows;
  w.close();
  await flush();
  h.dialogs[0].fail(new Error('boom'));
  await flush();
  await flush();
  assert.equal(w.isDestroyed(), true);
  assert.ok(h.events.includes('exit'));
});

test('win32 with two projects: closing one never asks to quit and leaves the other running', async () => {
  const h = harness({ windows: 2, sessions: 2 });
  const [a, b] = h.windows;
  a.close();
  await flush();
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.dialogs[0].opts.title, 'confirm.closeProjectTitle');
  h.dialogs[0].answer(0);
  await flush();
  assert.equal(a.isDestroyed(), true);
  assert.equal(b.isDestroyed(), false);
  assert.deepEqual(h.events, [], 'no quit and no tree kill for a single-window close');
});

test('win32 with two projects and no sessions: a window closes without any dialog', async () => {
  const h = harness({ windows: 2 });
  h.windows[0].close();
  await flush();
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.windows[0].isDestroyed(), true);
  assert.deepEqual(h.events, []);
});

test('darwin last window: closes through the sessions guard, the app keeps running', async () => {
  const h = harness({ platform: 'darwin' });
  h.windows[0].close();
  await flush();
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.windows[0].isDestroyed(), true);
  assert.deepEqual(h.events, []);
});

test('a close while the Ctrl+Q dialog is open is held, not let through', async () => {
  const h = harness({ windows: 2 });
  h.ctx.confirmAndQuit();
  await flush();
  h.windows[0].close();
  await flush();
  assert.equal(h.dialogs.length, 1, 'no second dialog');
  assert.equal(h.windows[0].isDestroyed(), false);
  h.dialogs[0].answer(1);
  await flush();
  assert.equal(h.live.length, 2, 'Cancel keeps every window');
  assert.deepEqual(h.events, []);
});

test('an unconfirmed before-quit is cancelled and never reaches the tree kill', async () => {
  const h = harness();
  const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  h.ctx.onBeforeQuit(e);
  assert.equal(e.defaultPrevented, true);
  await flush();
  assert.equal(h.dialogs.length, 1);
  h.dialogs[0].answer(1);
  await flush();
  assert.deepEqual(h.events, []);
});

test('window-all-closed quits without a second dialog off macOS, and is inert during startup', () => {
  const h = harness();
  h.ctx._initialWindowsCreated = false;
  h.ctx.onWindowAllClosed();
  assert.deepEqual(h.events, []);
  h.ctx._initialWindowsCreated = true;
  h.ctx.onWindowAllClosed();
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.ctx._quitConfirmed, true);
  assert.equal(h.events[0], 'app.quit');

  const mac = harness({ platform: 'darwin' });
  mac.ctx.onWindowAllClosed();
  assert.deepEqual(mac.events, []);
});

test('an unguarded close of the last window (project:close) quits without a parentless dialog', async () => {
  const h = harness();
  const [w] = h.windows;
  h.ctx._closeConfirmed.add(w);
  w.close();
  await flush();
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.ctx._quitConfirmed, true);
  assert.equal(h.events[0], 'app.quit');
});

test('will-quit tree kill is win32-only and skips an exited server', () => {
  const mac = harness({ platform: 'darwin' });
  mac.ctx.onWillQuit();
  assert.deepEqual(mac.events, []);
  const h = harness();
  h.ctx.serverChild.exitCode = 0;
  h.ctx.onWillQuit();
  assert.deepEqual(h.events, []);
});
