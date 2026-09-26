'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerExternalIpcHandlers } = require('../../main/ipc/external');

function harness() {
  const handlers = new Map();
  const opened = [];
  const revealed = [];
  const sender = { id: 7, mainFrame: { url: 'http://localhost:4455/todo.html?projectPath=%2Ftmp' } };
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
    appOrigin: 'http://localhost:4455',
    platform: 'darwin',
  });
  return { handlers, event, sender, window, projectDirs, shell, opened, revealed };
}

test('open-external opens allowed web, mail, and same-origin attachment links', async () => {
  const h = harness();
  const invoke = h.handlers.get('open-external');
  for (const url of ['https://tipatask.com/', 'http://example.com/',
    'mailto:support@example.com', 'http://localhost:4455/api/files/2/3']) {
    assert.deepEqual(await invoke(h.event, url), { ok: true });
  }
  assert.deepEqual(h.opened, ['https://tipatask.com/', 'http://example.com/',
    'mailto:support@example.com', 'http://localhost:4455/api/files/2/3']);
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
  h.sender.mainFrame.url = 'http://localhost:4455/other.html';
  assert.deepEqual(await invoke(h.event, 'https://example.com'), { ok: false, error: 'untrusted_sender' });
  h.sender.mainFrame.url = 'https://example.com/todo.html';
  assert.deepEqual(await invoke(h.event, 'https://example.com'), { ok: false, error: 'untrusted_sender' });
  h.sender.mainFrame.url = 'http://localhost:4455/todo.html';
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
