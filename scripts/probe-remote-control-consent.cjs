'use strict';

// Isolated Electron settings flow with production IPC handlers, store and renderer.
// Run: env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/probe-remote-control-consent.cjs
// No Task App startup, API calls, agent processes or existing user data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { app, BrowserWindow } = require('electron');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-consent-ui-'));
const root = path.resolve(__dirname, '..');
const data = path.join(scratch, 'data');
const project = path.join(scratch, 'project');
fs.mkdirSync(data); fs.mkdirSync(path.join(project, '.tipatask'), { recursive: true });
process.env.TIPATASK_USER_DATA = data; process.env.TIPATASK_PROJECT_ROOT = project;
app.setPath('userData', data); app.setName('Tipatask Consent Probe');
const windows = [];
const states = new Map();
const machineIdPath = path.join(scratch, 'machine'); fs.writeFileSync(machineIdPath, 'ui-probe-device');
const config = { API_BASE_URL: 'https://synthetic.invalid', API_PROJECT_ID: '2', REMOTE_CONTROL_ENABLED: true };
fs.writeFileSync(path.join(project, '.tipatask/config.json'), JSON.stringify(config));
const token = id => 'synthetic.' + Buffer.from(JSON.stringify({ id, exp: 4000000000 })).toString('base64url') + '.signature';
const accounts = require('../src/server/account-store');
accounts.saveAccountForServer(config.API_BASE_URL, { token: token(1) });
const consentModule = require('../src/server/remote-control-consent');
Object.assign(consentModule, consentModule.createRemoteControlConsent({ userDataRoot: data, machineIdPath }));
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../window-state' && parent?.filename.endsWith('api-router.js')) return {
    getWindowState: id => states.get(id),
    notifyProjectConfigChanged: () => windows.forEach(w => w.webContents.send('project:remote-control-changed')),
  };
  return load.call(this, request, parent, isMain);
};
require('../main/ipc/api-router').registerApiHandlers();
Module._load = load;
const template = fs.readFileSync(path.join(root, 'src/client/template.html'), 'utf8');
const start = template.lastIndexOf('<section', template.indexOf('id="settings-remote-control-title"'));
const row = template.slice(start, template.indexOf('</section>', start) + 10);
const entry = `import { initRemoteControlSettings, populateRemoteControlSettings } from ${JSON.stringify(path.join(root, 'src/client/remote-control-settings.js'))};
import { t, setLocale } from ${JSON.stringify(path.join(root, 'src/client/i18n.js'))};
import ${JSON.stringify(path.join(root, 'src/client/styles.css'))};
window.probe = { populate: populateRemoteControlSettings, locale: value => { setLocale(value); for (const name of ['title','label','scope','hint']) document.getElementById('settings-remote-control-' + name).textContent = t('settings.remoteControl.' + name); } };
window.probe.locale('en'); initRemoteControlSettings(); populateRemoteControlSettings();`;
require('esbuild').buildSync({ stdin: { contents: entry, resolveDir: root }, outfile: path.join(scratch, 'ui.js'), bundle: true, platform: 'browser' });
fs.writeFileSync(path.join(scratch, 'index.html'), `<!doctype html><html lang="en"><head><link rel="stylesheet" href="ui.css"></head><body style="padding:40px"><main style="max-width:680px;margin:auto"><h1>Project settings</h1><p>Isolated local consent verification</p>${row}</main><script src="ui.js"></script></body></html>`);
fs.writeFileSync(path.join(scratch, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', { api: { project: {
config: () => ipcRenderer.invoke('api:project.config'),
setRemoteControl: (enabled, context, expectedProjectPath) => ipcRenderer.invoke('api:project.setRemoteControl', { enabled, context, expectedProjectPath })
} }, onRemoteControlChanged: cb => ipcRenderer.on('project:remote-control-changed', () => cb()) });`);
const deadline = setTimeout(() => { console.error('FAIL consent UI timeout'); app.exit(1); }, 20000);
async function wait(win, expression) {
  for (let i = 0; i < 200; i++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('UI condition failed: ' + expression);
}
async function main() {
  for (let i = 0; i < 2; i++) {
    const win = new BrowserWindow({ title: 'Tipatask Consent Probe', width: 840, height: 540, show: true,
      webPreferences: { preload: path.join(scratch, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
    windows.push(win); states.set(win.webContents.id, { projectPath: project, config, backend: null });
    await win.loadFile(path.join(scratch, 'index.html'));
    await wait(win, '!document.querySelector("input").disabled');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("input").checked'), false);
    assert.match(await win.webContents.executeJavaScript('document.querySelector(".settings-notice").textContent'), /confirm/);
  }
  const [first, second] = windows;
  fs.writeFileSync(path.join(os.tmpdir(), 'TPT9261-ui-migration.png'), (await first.webContents.capturePage()).toPNG());
  // Real Chromium keyboard input, through the production renderer and IPC write.
  await first.webContents.executeJavaScript('document.querySelector("input").focus()');
  first.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  first.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await wait(second, 'document.querySelector("input").checked && !document.querySelector("input").disabled');
  assert.equal(consentModule.read(project).enabled, true);
  fs.writeFileSync(path.join(os.tmpdir(), 'TPT9261-ui-enabled.png'), (await second.webContents.capturePage()).toPNG());
  // A click in the other window disables the first, without reopening Settings.
  const box = await second.webContents.executeJavaScript('JSON.stringify(document.querySelector("input").getBoundingClientRect())');
  const rect = JSON.parse(box); const position = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), button: 'left', clickCount: 1 };
  second.webContents.sendInputEvent({ type: 'mouseDown', ...position }); second.webContents.sendInputEvent({ type: 'mouseUp', ...position });
  await wait(first, '!document.querySelector("input").checked && !document.querySelector("input").disabled');
  assert.equal(consentModule.read(project).enabled, false);
  accounts.saveAccountForServer(config.API_BASE_URL, { token: token(2) });
  await first.webContents.executeJavaScript("window.probe.locale('uk'); window.probe.populate()");
  assert.equal(await first.webContents.executeJavaScript('document.querySelector("input").checked'), false);
  assert.match(await first.webContents.executeJavaScript('document.querySelector(".settings-notice").textContent'), /підтверд/);
  fs.writeFileSync(path.join(os.tmpdir(), 'TPT9261-ui-uk.png'), (await first.webContents.capturePage()).toPNG());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, '.tipatask/config.json'))), config);
  console.log('PASS: migration off, keyboard enable, two-window refresh, click disable, account-change off, Ukrainian notice, no config write');
}
app.whenReady().then(main).then(() => { process.exitCode = 0; }, error => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(deadline); for (const win of windows) win.destroy();
  fs.rmSync(scratch, { recursive: true, force: true }); app.exit(process.exitCode || 0);
});
