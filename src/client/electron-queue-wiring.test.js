import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-scan guards for the Electron renderer's half of the main-process offline queue
// (main/window-state.js pushes `api-status` / `task:*` over IPC). The seams live in the inline
// template.html script, so scanning the source is the only mechanical guard (no jsdom here).
const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(CLIENT_DIR, '../..');
const read = (rel) => fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');

test('preload exposes the push channels main/window-state.js sends on', () => {
  const preload = read('preload.js');
  for (const [name, channel] of [['taskCreated', 'task:created'], ['taskUpdated', 'task:updated'], ['taskDeleted', 'task:deleted'], ['apiStatus', 'api-status']]) {
    assert.match(preload, new RegExp(`${name}:\\s*\\(cb\\) => ipcRenderer\\.on\\('${channel}'`));
  }
  const ws = read('main/window-state.js');
  for (const channel of ['api-status', 'task:created', 'task:updated', 'task:deleted']) {
    assert.ok(ws.includes(`'${channel}'`), `window-state.js sends ${channel}`);
  }
});

test('template.html routes WS and IPC api-status / task:deleted through one handler each', () => {
  const html = read('src/client/template.html');
  assert.match(html, /if \(msg\.type === 'api-status'\) \{\s*applyApiStatusFrame\(msg\);/);
  assert.match(html, /if \(msg\.type === 'task:deleted'\) \{\s*applyTaskDeletedEvent\(msg\.id\);/);
  assert.match(html, /function applyApiStatusFrame\(msg, \{ banner = true \} = \{\}\)/);
  assert.match(html, /_ipcOn\.apiStatus\(\(p\) => \{[\s\S]*?applyApiStatusFrame\(p, \{ banner \}\)/);
  assert.match(html, /_ipcOn\.taskUpdated\(\(p\) => \{ if \(p\?\.task\?\.id\) handleObjectiveTaskStateEvent\(\{ type: 'task:updated', task: p\.task \}\)/);
  assert.match(html, /_ipcOn\.taskDeleted\(\(p\) => applyTaskDeletedEvent\(p\?\.id\)\)/);
  assert.match(html, /_ipcOn\.taskCreated\(\(\) => handleObjectiveTaskStateEvent\(\{ type: 'tasks-updated' \}\)\)/);
});

test('Electron keeps unauthorized off the corner banner', () => {
  const html = read('src/client/template.html');
  const block = html.slice(html.indexOf('_ipcOn.apiStatus('), html.indexOf('_ipcOn.apiStatus(') + 300);
  assert.match(block, /p\?\.state === 'connected' \|\| p\?\.state === 'disconnected' \|\| p\?\.state === 'reconnecting'/);
  assert.doesNotMatch(block, /unauthorized/);
});
