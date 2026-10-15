import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT672) startTaskById() — the /start-task dispatch — reads the task through
// api.tasks.get(): the Electron 403 marker and { _ipcError } failures toast and start nothing.
// Real task-card.js bundle under happy-dom; only the IPC bridge and xterm are replaced.

let window, scratch, cards, ipcGet;
const globals = new Map();
const opened = [];

function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

before(async () => {
  window = new Window({ url: 'http://localhost:4455/' });
  scratch = mkdtempSync(join(tmpdir(), 'tt-start-by-id-'));
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  install('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  install('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  install('WebSocket', class { send() {} close() {} });
  install('fetch', async () => ({ ok: true, json: async () => ({}) }));
  // api-client.js reads the bridge once at load; tasks.get delegates to the current case.
  window.electronAPI = { api: { tasks: { get: (...args) => ipcGet(...args) } } };
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    stdin: { contents: `export * as cards from './src/client/task-card.js';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    plugins: [{ name: 'terminal-double', setup(b) {
      b.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
      b.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
        export class FitAddon { fit() {} }
        export class Terminal { loadAddon() {} onData() {} open() {} write() {} dispose() {} }` }));
    } }],
  });
  const bundle = join(scratch, 'client.mjs');
  writeFileSync(bundle, result.outputFiles[0].contents);
  ({ cards } = await import(pathToFileURL(bundle).href));
  cards.registerCardCallbacks({ onOpenTerminal: (...args) => opened.push(args) });
});

after(async () => {
  await window.happyDOM.abort();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  rmSync(scratch, { recursive: true, force: true });
});

function lastToast() {
  const labels = document.querySelectorAll('.tt-toast--error .tt-saving-label');
  return labels.length ? labels[labels.length - 1].textContent : null;
}

test('403 marker: no session starts, localized unavailable toast', async () => {
  opened.length = 0;
  ipcGet = async () => ({ _taskAccessDenied: true });
  await cards.startTaskById('T1');
  assert.equal(opened.length, 0);
  assert.equal(lastToast(), 'Task T1 is no longer available');
});

test('{ _ipcError } the API answered: labelled toast with its text, no IPC wrapper, no session', async () => {
  opened.length = 0;
  ipcGet = async (id, opts) => {
    assert.deepEqual(opts, { errorAsValue: true });
    return { _ipcError: { message: 'API 500: boom', statusCode: 500 } };
  };
  await cards.startTaskById('T2');
  assert.equal(opened.length, 0);
  assert.equal(lastToast(), 'Could not load task T2 to start it: API 500: boom');
});

test('{ _ipcError } with no answer from the API: network-error toast, no session', async () => {
  opened.length = 0;
  ipcGet = async () => ({ _ipcError: { message: 'fetch failed', networkError: true } });
  await cards.startTaskById('T3');
  assert.equal(opened.length, 0);
  assert.equal(lastToast(), 'Network error: fetch failed');
});

test('a readable task starts its session with the fetched title and description', async () => {
  opened.length = 0;
  ipcGet = async () => ({ id: 'T4', title: 'Real task', description: 'Body', status: 'pending', agentAssignee: 'claude' });
  await cards.startTaskById('T4');
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].slice(0, 4), ['T4', 'Real task', 'Body', 'pending']);
  assert.equal(opened[0][4].agent, 'claude');
});
