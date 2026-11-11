'use strict';

// Isolated production account-switch renderer/IPC/store with a separate relay process.
// Only the sign-in service, device identity and terminal are synthetic. No live app/data/API.
// Run with the development Electron executable and --manual for desktop clicks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const token = id => `synthetic.${Buffer.from(JSON.stringify({ id, exp: 4000000000 })).toString('base64url')}.signature`;
const waitFor = async predicate => {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    assert.ok(Date.now() < end, 'account UI probe condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

if (process.argv.includes('--relay-child')) {
  const { connectDeviceRelay, captureSessionOwner } = require('../src/server/device-relay');
  const { getApiCredentials } = require('../src/server/api-credentials');
  const { createRemoteControlConsent } = require('../src/server/remote-control-consent');
  const projectPath = process.env.TIPATASK_PROJECT_ROOT;
  const consent = createRemoteControlConsent({ userDataRoot: process.env.TIPATASK_USER_DATA,
    machineIdPath: path.join(process.env.TIPATASK_USER_DATA, 'machine') });
  const backend = { getCredentials: () => getApiCredentials(projectPath) };
  const events = new EventEmitter(); const held = [];
  const session = { type: 'terminal', taskId: 'SYNTHETIC1', taskAgent: 'codex', projectPath,
    alive: true, pty: {}, buffer: 'private-account-a-history' };
  captureSessionOwner(session, backend); const owner = session._relayOwner;
  let hold = false;
  const relay = connectDeviceRelay({ getProjects: () => {
    const state = consent.read(projectPath);
    return [{ projectPath, backend, deviceId: 7, enabled: state.enabled, consentGrant: state.grant }];
  }, getSessions: () => new Map([['SYNTHETIC1', session]]), events, pollMs: 3600000,
  setTimer: (callback, ms) => {
    if (hold && ms === 10) { const timer = { callback, unref() {} }; held.push(timer); return timer; }
    return setTimeout(callback, ms);
  }, clearTimer: timer => { if (!timer?.callback) clearTimeout(timer); },
  handleCommand: async (_frame, context) => context.attach() });
  process.on('message', message => {
    if (message === 'buffer') {
      hold = true; events.emit('output', session, 'must-not-send-account-a'); process.send('buffered');
    }
    if (message === 'verify') {
      held.forEach(timer => timer.callback());
      events.emit('output', session, 'must-not-send-late-account-a');
      events.emit('state', session, 'running');
      process.send({ alive: session.alive, ownerUnchanged: session._relayOwner === owner,
        consentEnabled: consent.read(projectPath).enabled });
    }
    if (message === 'stop') { relay.close(); process.exit(0); }
  });
  process.on('disconnect', () => { relay.close(); process.exit(0); });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const http = require('node:http');
  const { fork } = require('node:child_process');
  const { WebSocketServer } = require('ws');
  const vm = require('node:vm');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-account-ui-'));
  const project = path.join(scratch, 'project');
  process.env.TIPATASK_USER_DATA = scratch; process.env.TIPATASK_PROJECT_ROOT = project;
  app.setPath('userData', scratch); app.setName('Tipatask Account Relay Probe');
  fs.mkdirSync(path.join(project, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'machine'), 'isolated-ui-device');
  const accounts = require('../src/server/account-store');
  const projectConfig = require('../src/server/project-config');
  const consent = require('../src/server/remote-control-consent').createRemoteControlConsent({
    userDataRoot: scratch, machineIdPath: path.join(scratch, 'machine') });
  let server; let wss; let child; let win;
  const deadline = setTimeout(() => { console.error('FAIL account UI probe timeout'); cleanup(1); }, 120000);
  let cleaning = false;
  process.once('SIGTERM', () => cleanup(1));
  async function cleanup(code) {
    if (cleaning) return;
    cleaning = true;
    clearTimeout(deadline);
    win?.destroy();
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit'); child.send('stop'); await exited;
    }
    if (wss) { for (const ws of wss.clients) ws.terminate(); wss.close(); }
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true }); app.exit(code);
  }
  async function main() {
    server = http.createServer((req, res) => {
      assert.equal(req.url, '/synthetic-signin');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ token: token(2), user: { id: 2, email: 'account-b@example.test' } }));
    });
    wss = new WebSocketServer({ server });
    const connections = [];
    wss.on('connection', ws => {
      const row = { ws, frames: [] }; connections.push(row);
      ws.on('message', data => row.frames.push(JSON.parse(data)));
      ws.send(JSON.stringify({ type: 'ready', protocol: 1, project_ids: [2], expiry_ms: 180000,
        limits: { max_device_frame_bytes: 262144, max_output_data_bytes: 32768, max_replay_bytes: 262144,
          max_sessions: 64, frames_per_second: 200, output_bytes_per_second: 1048576 } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    accounts.saveAccountForServer(baseUrl, { token: token(1) });
    projectConfig.writeProjectConfig(project, { API_BASE_URL: baseUrl, API_PROJECT_ID: '2' });
    consent.write(project, true, consent.read(project).context);
    child = fork(__filename, ['--relay-child'], { execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    await waitFor(() => connections[0]?.frames.some(f => f.type === 'hello'));
    const row = connections[0];
    const session = row.frames.find(f => f.type === 'hello').sessions[0];
    row.ws.send(JSON.stringify({ type: 'command', action: 'attach', command_id: 'ui-attach-a',
      local_id: session.local_id, attachment_id: 'att_ui', replay_bytes: 0 }));
    await waitFor(() => row.frames.some(f => f.command_id === 'ui-attach-a' && f.ok));
    // Execute the actual handler without booting main.js (which would touch live app state).
    const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const start = mainSource.indexOf("ipcMain.handle('setup:reauth-account'");
    const end = mainSource.indexOf("ipcMain.handle('project:rename'", start);
    assert.ok(start >= 0 && end > start);
    vm.runInNewContext(mainSource.slice(start, end), {
      ipcMain, _forceReauthInFlight: false, DEFAULT_API_BASE_URL: baseUrl,
      projectDirs: new Map(), app, BrowserWindow, console,
      createMenu() {}, reconcileRecentProjectsWithAccounts() {},
      require(request) {
        if (request === './src/server/account-store') return accounts;
        if (request === './src/cli/auth') return { authenticate: async () => {
          const buffered = once(child, 'message'); child.send('buffer');
          assert.equal((await buffered)[0], 'buffered');
          return await (await fetch(baseUrl + '/synthetic-signin')).json();
        } };
        throw new Error('Unexpected probe dependency: ' + request);
      },
    });
    const entry = `import { openReauth } from ${JSON.stringify(path.join(root, 'src/client/setup-modal.js'))};
import ${JSON.stringify(path.join(root, 'src/client/styles.css'))};
openReauth({ existingConfig: { API_BASE_URL: ${JSON.stringify(baseUrl)} }, accountOnly: true });`;
    require('esbuild').buildSync({ stdin: { contents: entry, resolveDir: root }, outfile: path.join(scratch, 'ui.js'), bundle: true, platform: 'browser' });
    fs.writeFileSync(path.join(scratch, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="ui.css"></head><body><script src="ui.js"></script></body></html>');
    fs.writeFileSync(path.join(scratch, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', { reauthAccount: base => ipcRenderer.invoke('setup:reauth-account', base) });`);
    win = new BrowserWindow({ title: 'TPT9256 isolated account switch', width: 880, height: 620,
      webPreferences: { preload: path.join(scratch, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(scratch, 'index.html'));
    await waitFor(() => win.webContents.executeJavaScript('!!document.getElementById("setup-signin-btn")'));
    fs.writeFileSync(path.join(os.tmpdir(), 'TPT9256-ui-before.png'), (await win.webContents.capturePage()).toPNG());
    console.log('UI_READY: isolated production Change Account dialog; click Sign in.');
    if (!process.argv.includes('--manual')) {
      win.focus(); win.webContents.focus();
      await new Promise(resolve => setTimeout(resolve, 200));
      await win.webContents.executeJavaScript('document.getElementById("setup-signin-btn").focus()');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    }
    await new Promise((resolve, reject) => {
      const end = Date.now() + (process.argv.includes('--manual') ? 110000 : 5000);
      const interval = setInterval(async () => {
        try {
          if (Date.now() > end) {
            fs.writeFileSync(path.join(os.tmpdir(), 'TPT9256-ui-failed.png'), (await win.webContents.capturePage()).toPNG());
            throw new Error('UI account-switch did not finish');
          }
          if (await win.webContents.executeJavaScript('!!document.getElementById("setup-done-btn")')) { clearInterval(interval); resolve(); }
        } catch (error) { clearInterval(interval); reject(error); }
      }, 50);
    });
    await waitFor(() => row.ws.readyState === 3); // Idle child closes via store watch, not a command or poll.
    const verified = once(child, 'message'); child.send('verify');
    assert.deepEqual((await verified)[0], { alive: true, ownerUnchanged: true, consentEnabled: false });
    assert.equal(accounts.readAccount(baseUrl).userId, 2);
    assert.equal(row.frames.some(f => f.data?.includes('must-not-send')), false);
    assert.equal(connections.length, 1, 'new account needs its own local consent');
    fs.writeFileSync(path.join(os.tmpdir(), 'TPT9256-ui-after.png'), (await win.webContents.capturePage()).toPNG());
    console.log('PASS: production UI/IPC switched account; forked idle relay closed before poll; buffered/late output dropped; local session and original owner retained; consent off.');
    if (process.argv.includes('--manual')) await new Promise(resolve => setTimeout(resolve, 12000));
  }
  app.whenReady().then(main).then(() => cleanup(0), error => { console.error(error); cleanup(1); });
}
