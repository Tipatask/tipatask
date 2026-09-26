'use strict';

// (C1532) Dedicated preload for the About + Third-Party Licenses windows —
// deliberately NOT preload.js, which exposes the whole project/task API (see
// main.js's "No preload on purpose" comment on the splash window; these two
// windows get the smallest surface that does the job instead).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aboutAPI', {
  // Pushed once by main after did-finish-load — { appVersion?, strings, html?, text? }.
  onData: (cb) => ipcRenderer.on('about:data', (_event, payload) => cb(payload)),
  openLicenses: () => ipcRenderer.send('about:open-licenses'),
});
