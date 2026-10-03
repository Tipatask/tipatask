'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// This surface has no project API, file access or arbitrary IPC channel exposure.
contextBridge.exposeInMainWorld('desktopNotifications', {
  onState: (cb) => ipcRenderer.on('notify:desktop-state', (_event, entries) => cb(entries)),
  act: (id, action) => ipcRenderer.send('notify:desktop-action', { id, action }),
});
