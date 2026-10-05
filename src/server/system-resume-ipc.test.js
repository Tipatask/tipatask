'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('power monitor forwards resume and unlock to every live window through removable preload API', () => {
  const ipc = new EventEmitter();
  let api;
  const preload = fs.readFileSync(path.join(__dirname, '../../preload.js'), 'utf8');
  vm.runInNewContext(preload, {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: ipc }),
    process: { platform: 'darwin' },
  });
  let delivered = 0;
  const unsubscribe = api.onSystemResume(() => { delivered++; });
  const live = () => ({ isDestroyed: () => false, webContents: {
    isDestroyed: () => false, send: channel => ipc.emit(channel, {}),
  } });
  const broken = live();
  broken.webContents.send = () => { throw new Error('window closing'); };
  const destroyedContents = live();
  destroyedContents.webContents.isDestroyed = () => true;
  const powerMonitor = new EventEmitter();
  const main = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  const start = main.indexOf('function registerSystemResumeHandlers()');
  const end = main.indexOf('app.whenReady()', start);
  assert.ok(start >= 0 && end > start);
  assert.match(main.slice(end), /\.then\(async \(\) => \{\s*registerSystemResumeHandlers\(\)/);
  vm.runInNewContext(main.slice(start, end) + '\nregisterSystemResumeHandlers();', {
    powerMonitor, console: { warn() {} },
    BrowserWindow: { getAllWindows: () => [live(), broken, { isDestroyed: () => true }, destroyedContents, live()] },
  });
  powerMonitor.emit('resume');
  assert.equal(delivered, 2);
  powerMonitor.emit('unlock-screen');
  assert.equal(delivered, 4);
  unsubscribe();
  powerMonitor.emit('resume');
  assert.equal(delivered, 4);
  assert.equal(ipc.listenerCount('tiptask:system-resume'), 0);
});
