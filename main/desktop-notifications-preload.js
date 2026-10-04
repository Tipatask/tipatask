'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// This surface has no project API, file access or arbitrary IPC channel exposure.
// State: { entries, theme } — theme is the in-app host's card palette, or null.
contextBridge.exposeInMainWorld('desktopNotifications', {
  onState: (cb) => ipcRenderer.on('notify:desktop-state', (_event, state) => cb(state)),
  act: (id, action) => ipcRenderer.send('notify:desktop-action', { id, action }),
});
