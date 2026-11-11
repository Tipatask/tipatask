#!/usr/bin/env node
'use strict';

// Real native MCP roundtrips through CodexAgent's generated launch configuration.
// Own project, port, user data, app bundle and processes. Consent is always human;
// this probe never clicks permission dialogs or targets another app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const toml = require('toml');

async function main() {
  if (!process.argv.includes('--yes') || process.platform !== 'darwin') throw new Error('Run on macOS with --yes; this opens a disposable test app and requests app consent.');
  const root = path.resolve(__dirname, '..');
  const originalEnv = { ...process.env };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-desktop-probe-'));
  const project = path.join(scratch, 'project');
  const user = path.join(scratch, 'user-data');
  const globalHome = path.join(scratch, 'codex-user');
  for (const dir of [path.join(project, '.tipatask'), user, globalHome]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(project, '.tipatask/config.json'), JSON.stringify({ API_BASE_URL: 'http://127.0.0.1:1', API_PROJECT_ID: 1 }));
  fs.writeFileSync(path.join(globalHome, 'config.toml'), '');
  process.env.TIPATASK_PROJECT_ROOT = project;
  process.env.TIPATASK_USER_DATA = user;
  process.env.CODEX_HOME = globalHome;
  process.env.TIPATASK_SERVER_ROOT = root;
  const { createPermissionGate } = require('../src/server/permission-gate');
  const CodexAgent = require('../src/server/task-agent/codex-agent');
  const config = require('../src/server/config');
  const appId = 'com.tipatask.desktop-probe.' + Date.now();
  const bundle = path.join(scratch, 'Desktop Probe.app');
  fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${appId}</string><key>CFBundleExecutable</key><string>probe</string><key>CFBundleName</key><string>Tipatask Desktop Probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  execFileSync('/usr/bin/xcrun', ['swiftc', path.join(root, 'fixtures/computer-use/probe-app.swift'), '-o', path.join(bundle, 'Contents/MacOS/probe')], { timeout: 60000 });
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle]);
  const output = path.join(scratch, 'clicked.txt');
  const clients = [];
  let appChild;
  let dev;
  let gate;
  try {
    appChild = spawn(path.join(bundle, 'Contents/MacOS/probe'), [output], { stdio: 'ignore' });
    const session = { permissionMode: { confirmed: 'bypass' }, terminalPhase: 'executing' };
    gate = await createPermissionGate(session);
    // This is a separate development Task App server with no production credentials.
    const portServer = require('node:net').createServer();
    await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
    const port = portServer.address().port;
    await new Promise(resolve => portServer.close(resolve));
    let devError = '';
    dev = spawn(process.execPath, [path.join(root, 'todo-server.js')], {
      env: { ...process.env, PORT: String(port), TIPATASK_NO_BANNER: '1', TIPATASK_ELECTRON_HOST: '', TIPATASK_LOCAL_SECRET: '',
        USER_NAME: 'Desktop Probe', CLAUDE_BIN: '/usr/bin/false', PI_BIN: '/usr/bin/false', GEMINI_BIN: '/usr/bin/false' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    dev.stderr.on('data', data => { devError = (devError + data).slice(-4000); });
    console.log(`Isolated dev server PID ${dev.pid}, port ${port}; test app PID ${appChild.pid}, ${appId}`);
    const connect = async (entry, env) => {
      const client = new Client({ name: 'native-desktop-probe', version: '1' });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env, stderr: 'pipe' }));
      console.log('MCP initialized:', client.getServerVersion());
      return client;
    };
    const call = async (client, name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
      console.log(name, JSON.stringify({ isError: result.isError || false, content: result.content.filter(c => c.type !== 'image') }));
      return result;
    };
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(output + '.ready')) {
      if (appChild.exitCode !== null || Date.now() > deadline) throw new Error('Disposable app did not become ready.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    let listening = false;
    while (!listening && Date.now() < deadline) {
      if (dev.exitCode !== null) throw new Error(`Isolated development server exited: ${devError}`);
      listening = await new Promise(resolve => {
        const socket = require('node:net').createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
      });
      if (!listening) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!listening) throw new Error('Isolated development server did not listen before its deadline.');
    console.log('Isolated development listener verified:', port);
    if (process.argv.includes('--server-only')) return;
    const agent = new CodexAgent();
    const computerUse = await agent.detectComputerUse(config);
    if (!computerUse.available) throw new Error(computerUse.reason);
    const spec = await agent.getSpawnSpec(config, 'Isolated desktop MCP probe; never change project tasks.', '', {
      projectPath: project, permissionGate: gate, computerUse,
      permissionPolicy: agent.buildPermissionPolicy({ mode: 'bypass' }),
    });
    const entry = toml.parse(fs.readFileSync(path.join(spec.env.CODEX_HOME, 'config.toml'), 'utf8')).mcp_servers['computer-use'];
    console.log('Task App', require('../package.json').version, 'Codex', execFileSync(config.CODEX_BIN, ['--version'], { encoding: 'utf8' }).trim());
    console.log('Generated server:', JSON.stringify(entry), 'session wiring:', Object.keys(spec.env).filter(k => k.startsWith('TIPATASK_DESKTOP_')));
    if (process.argv.includes('--legacy')) {
      const old = await connect({ command: config.CLAUDE_BIN, args: ['--computer-use-mcp'] }, spec.env);
      await old.listTools();
      await call(old, 'list_granted_applications');
      await call(old, 'request_access', { apps: [appId], reason: 'Verify isolated computer-use session wiring.' });
      return;
    }
    if (process.argv.includes('--codex')) {
      const logPath = path.join(os.tmpdir(), 'TPT9269-codex-desktop.log');
      const log = fs.openSync(logPath, 'w', 0o600);
      const child = spawn(process.execPath, [path.join(root, 'scripts/probe-codex-kickoff.js'), '--yes', '--desktop-app', appId], {
        cwd: root, env: originalEnv, stdio: ['ignore', log, log],
      });
      console.log('Normal spawnTerminal Codex probe PID', child.pid, 'log:', logPath);
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      fs.closeSync(log);
      const observed = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '(no button receipt)';
      console.log('Disposable app receipt:', JSON.stringify(observed));
      if (code !== 0 || observed !== 'DESKTOP_OK') throw new Error('Real Codex desktop probe failed; inspect ' + logPath);
      const client = await connect(entry, spec.env);
      const empty = await call(client, 'list_granted_applications');
      if (JSON.parse(empty.content[0].text).apps.length) throw new Error('Independent run inherited Codex grants.');
      if (!(await call(client, 'screenshot', { app: appId })).isError) throw new Error('Independent capture was allowed.');
      session.permissionMode.confirmed = 'plan';
      session.terminalPhase = 'planning';
      for (const name of ['left_click', 'type', 'open_application']) {
        const blocked = await call(client, name, { app: appId, coordinate: [1, 1], text: 'BLOCKED' });
        if (!blocked.isError || !blocked.content[0].text.includes('Plan mode')) throw new Error('Native MCP Plan check failed.');
      }
      gate.close();
      if (!(await call(client, 'request_access', { apps: [appId], reason: 'Expired binding probe' })).isError) throw new Error('Stale binding accepted consent.');
      console.log('PASS: real Task App Codex task run completed native consent, screenshot and benign input; independent and Plan/stale checks passed.');
      return;
    }
    const client = await connect(entry, spec.env);
    await client.listTools();
    const grants = await call(client, 'request_access', { apps: [appId], reason: 'Verify screenshots, typing and clicks in the disposable Tipatask Desktop Probe app only.' });
    if (grants.isError || !JSON.parse(grants.content[0].text).granted.includes(appId)) throw new Error('App access was denied; no desktop action attempted.');
    await call(client, 'list_granted_applications');
    await call(client, 'open_application', { app: appId });
    const shot = await call(client, 'screenshot', { app: appId });
    if (shot.isError || !shot.content.some(c => c.type === 'image')) throw new Error('Native screenshot failed.');
    const png = path.join(os.tmpdir(), 'TPT9269-desktop-probe.png');
    fs.writeFileSync(png, Buffer.from(shot.content.find(c => c.type === 'image').data, 'base64'));
    console.log('Screenshot:', png);
    const independent = await connect(entry, spec.env);
    const empty = await call(independent, 'list_granted_applications');
    if (JSON.parse(empty.content[0].text).apps.length) throw new Error('Independent connection inherited grants.');
    if (!(await call(independent, 'screenshot', { app: appId })).isError) throw new Error('Independent screenshot was allowed.');
    session.permissionMode.confirmed = 'plan';
    session.terminalPhase = 'planning';
    for (const name of ['left_click', 'type', 'open_application']) {
      if (!(await call(client, name, { app: appId, coordinate: [50, 100], text: 'BLOCKED' })).isError) throw new Error('Plan mutation allowed.');
    }
    session.permissionMode.confirmed = 'bypass';
    // Coordinates are stable because the disposable fixture has fixed geometry.
    await call(client, 'left_click', { app: appId, coordinate: [160, 128] });
    await call(client, 'type', { app: appId, text: 'DESKTOP_OK' });
    await call(client, 'left_click', { app: appId, coordinate: [120, 200] });
    await new Promise(resolve => setTimeout(resolve, 500));
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== 'DESKTOP_OK') throw new Error('Target app did not record benign click/type. Inspect screenshot coordinates.');
    await client.close();
    const fresh = await connect(entry, spec.env);
    if (JSON.parse((await call(fresh, 'list_granted_applications')).content[0].text).apps.length) throw new Error('Restart restored grants.');
    gate.close();
    if (!(await call(fresh, 'request_access', { apps: [appId], reason: 'Expired run test' })).isError) throw new Error('Expired binding allowed consent.');
    console.log('PASS: native screenshot, click/type, Plan restrictions, independent/restarted grants and stale binding.');
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    gate?.close();
    for (const child of [appChild, dev].filter(Boolean)) {
      child.kill('SIGTERM');
      await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500).unref(); });
      console.log('Stopped test PID', child.pid);
    }
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', bundle]);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
