'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { registerExternalIpcHandlers } = require('../../main/ipc/external');

// The origin main.js loads every window from (APP_ORIGIN): the server listens on loopback only.
const APP_ORIGIN = 'http://127.0.0.1:4455';

function harness() {
  const handlers = new Map();
  const opened = [];
  const revealed = [];
  const sender = { id: 7, mainFrame: { url: `${APP_ORIGIN}/todo.html?projectPath=%2Ftmp` } };
  const window = { webContents: sender, isDestroyed: () => false };
  const event = { sender, senderFrame: sender.mainFrame };
  const projectDirs = new Map([[sender.id, null]]); // setup windows are bound to null
  const shell = {
    async openExternal(url) { opened.push(url); },
    showItemInFolder(file) { revealed.push(file); },
  };
  registerExternalIpcHandlers({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    shell,
    BrowserWindow: { fromWebContents: (contents) => contents === sender ? window : null },
    projectDirs,
    app: { getPath: () => '/tmp/tipatask-user-data' },
    appOrigin: APP_ORIGIN,
    platform: 'darwin',
  });
  return { handlers, event, sender, window, projectDirs, shell, opened, revealed };
}

test('open-external opens allowed web, mail, and same-origin attachment links', async () => {
  const h = harness();
  const invoke = h.handlers.get('open-external');
  for (const url of ['https://tipatask.com/', 'http://example.com/',
    'mailto:support@example.com', `${APP_ORIGIN}/api/files/2/3`]) {
    assert.deepEqual(await invoke(h.event, url), { ok: true });
  }
  assert.deepEqual(h.opened, ['https://tipatask.com/', 'http://example.com/',
    'mailto:support@example.com', `${APP_ORIGIN}/api/files/2/3`]);
});

test('open-external rejects unsupported, relative, and malformed URLs without OS calls', async () => {
  const h = harness();
  const invoke = h.handlers.get('open-external');
  for (const url of ['file:///tmp/report', 'javascript:alert(1)', 'data:text/plain,hello',
    'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
    'custom://handler', '/api/files/2/3', 'http://[invalid', null, {}]) {
    assert.deepEqual(await invoke(h.event, url), { ok: false, error: 'invalid_url' });
  }
  assert.deepEqual(h.opened, []);
});

test('open-external rejects subframes, other windows, and navigated top frames', async () => {
  const h = harness();
  const invoke = h.handlers.get('open-external');
  const badEvents = [
    { sender: h.sender, senderFrame: { url: h.sender.mainFrame.url } },
    { sender: { id: 8, mainFrame: { url: h.sender.mainFrame.url } }, senderFrame: h.sender.mainFrame },
    { sender: h.sender, senderFrame: { url: 'https://example.com/' } },
  ];
  for (const event of badEvents) {
    assert.deepEqual(await invoke(event, 'https://example.com'), { ok: false, error: 'untrusted_sender' });
  }
  h.sender.mainFrame.url = `${APP_ORIGIN}/other.html`;
  assert.deepEqual(await invoke(h.event, 'https://example.com'), { ok: false, error: 'untrusted_sender' });
  h.sender.mainFrame.url = 'https://example.com/todo.html';
  assert.deepEqual(await invoke(h.event, 'https://example.com'), { ok: false, error: 'untrusted_sender' });
  // Same port on another loopback host name is another origin.
  h.sender.mainFrame.url = 'http://localhost:4455/todo.html';
  assert.deepEqual(await invoke(h.event, 'https://example.com'), { ok: false, error: 'untrusted_sender' });
  h.sender.mainFrame.url = `${APP_ORIGIN}/todo.html`;
  h.projectDirs.delete(h.sender.id);
  assert.deepEqual(await invoke(h.event, 'https://example.com'), { ok: false, error: 'untrusted_sender' });
  assert.deepEqual(h.opened, []);
});

test('open-external returns a bounded failure when OS launcher fails', async () => {
  const h = harness();
  h.shell.openExternal = async () => { throw new Error('private OS failure'); };
  assert.deepEqual(await h.handlers.get('open-external')(h.event, 'https://example.com'),
    { ok: false, error: 'open_failed' });
});

test('fixed native actions own their destinations', async () => {
  const h = harness();
  assert.deepEqual(h.handlers.get('debug:reveal-perf-log')(h.event, 'file:///tmp/attacker'), { ok: true });
  assert.match(h.revealed[0], /^\/tmp\/tipatask-user-data\/logs\/perf-\d{4}-\d{2}-\d{2}\.log$/);
  assert.deepEqual(await h.handlers.get('settings:open-notifications')(h.event, 'custom://attacker'), { ok: true });
  assert.deepEqual(h.opened, ['x-apple.systempreferences:com.apple.Notifications-Settings.extension']);
  h.projectDirs.delete(h.sender.id);
  assert.deepEqual(h.handlers.get('debug:reveal-perf-log')(h.event), { ok: false, error: 'untrusted_sender' });
  assert.deepEqual(await h.handlers.get('settings:open-notifications')(h.event),
    { ok: false, error: 'untrusted_sender' });
  assert.equal(h.revealed.length, 1);
  assert.equal(h.opened.length, 1);
});

test('open-external opens an exact terminal link with its query and fragment', async () => {
  const h = harness();
  const url = 'https://photoassistant.net/dashboard/database?tab=all&next=%2Fdb#tables';
  assert.deepEqual(await h.handlers.get('open-external')(h.event, url), { ok: true });
  assert.deepEqual(h.opened, [url]);
});

test('main.js trusts the same origin it loads every window from', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  // One spelled-out origin: the APP_ORIGIN definition. A second copy that drifts (a
  // `http://localhost:${PORT}` one once reached the open-external registration while windows
  // loaded 127.0.0.1) fails every trusted-sender check, and with it every confirmed link open.
  assert.deepEqual(source.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\$\{PORT\}/g),
    ['http://127.0.0.1:${PORT}']);
  assert.match(source, /^const APP_ORIGIN = `http:\/\/127\.0\.0\.1:\$\{PORT\}`;$/m);
  const origins = [...source.matchAll(/appOrigin: ([^,}\s]+)/g)].map(match => match[1]);
  assert.ok(origins.length >= 2, 'IPC handlers receive an origin');
  assert.deepEqual([...new Set(origins)], ['APP_ORIGIN']);
  assert.match(source, /registerExternalIpcHandlers\(\{[^}]*appOrigin: APP_ORIGIN/);
  assert.match(source, /shouldOpenExternally\(url, APP_ORIGIN\)/);
  const pages = [...source.matchAll(/loadURL\(`([^`]*todo\.html[^`]*)`/g)].map(match => match[1]);
  assert.ok(pages.length >= 2, 'project and setup windows load todo.html');
  for (const page of pages) assert.ok(page.startsWith('${APP_ORIGIN}/todo.html'), page);
});
