import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const REFUSED = { type: 'error', code: 'EASSIGNEE', message: 'Cannot start a task assigned to another member.' };
const STARTED = { status: 'in_progress' };
const RESTORED = { status: 'pending' };

// Exercise the real workspace terminal and its socket handlers; replace only xterm,
// transport and HTTP. PATCH order is the task's observable status history.
test('single-card terminal restores only a refused launch it advanced', async (t) => {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-terminal-start-'));
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  for (const key of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, window[key].bind(window));
  }
  const sockets = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    frame(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  install('WebSocket', Socket);
  let patches = [];
  let patchReply = async () => ({ ok: true });
  let reloads = 0;
  document.addEventListener('tiptask:reload', () => reloads++);
  install('fetch', async (url, opts = {}) => {
    if (/^\/api\/tasks\/[^/]+$/.test(String(url)) && opts.method === 'PATCH') {
      patches.push(JSON.parse(opts.body));
      return patchReply(patches.length);
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const until = async predicate => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('terminal transition timed out');
  };
  let controller;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export * as modal from './src/client/console-modal.js';
        export { default as state } from './src/client/state.js';
        export { api } from './src/client/api-client.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(b) {
        b.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        b.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
          export class FitAddon { fit() {} }
          export class Terminal {
            cols = 80; rows = 24; buffer = { active: { viewportY: 0, baseY: 0 } };
            loadAddon() {} onData() {} attachCustomKeyEventHandler() {} refresh() {}
            focus() {} blur() {} clear() {} reset() {} scrollToBottom() {} dispose() {}
            write(data, done) { done?.(); }
            open(parent) { this.element = document.createElement('textarea'); parent.appendChild(this.element); }
          }` }));
      } }],
    });
    const bundle = join(scratch, 'client.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const { modal, state, api } = await import(pathToFileURL(bundle).href);
    state.taskAgent = 'claude'; state.taskAgentLabel = 'Claude Code';
    api.statuses.list = async () => [];
    let nextId = 0;
    async function launch({ status = 'pending', opts = {}, reply } = {}, run) {
      patches = []; reloads = 0;
      patchReply = reply || (async () => ({ ok: true }));
      const id = `TERM${++nextId}`;
      const host = document.createElement('div');
      document.body.appendChild(host);
      const before = sockets.length;
      controller = modal.mountTaskTerminal(host, id, id, '', status, { agent: 'claude', ...opts });
      try {
        await until(() => sockets.length > before);
        const socket = sockets.at(-1);
        socket.open();
        await run(socket, id);
      } finally {
        controller.dispose(); controller = null;
        host.remove();
      }
    }

    for (const code of ['EASSIGNEE', 'ECLAIM', 'EAUTH', 'ESTART']) {
      await t.test(`${code} restores pending and reloads board`, () => launch({}, async (socket, id) => {
        await until(() => reloads === 1);
        socket.frame({ ...REFUSED, code });
        await until(() => reloads === 2);
        assert.deepEqual(patches, [STARTED, RESTORED]);
        assert.ok(!state.activeSessions.has(id), 'refused task has no running session');
      }));
    }

    await t.test('immediate repeated refusal waits for advance response and restores once', async () => {
      let finishAdvance;
      const pending = new Promise(resolve => { finishAdvance = resolve; });
      await launch({ reply: count => count === 1 ? pending : { ok: true } }, async socket => {
        socket.frame(REFUSED); // even before status-registry loading has settled
        socket.frame(REFUSED);
        await until(() => patches.length === 1);
        assert.deepEqual(patches, [STARTED]);
        assert.equal(reloads, 0);
        finishAdvance({ ok: true });
        await until(() => reloads === 2);
        assert.deepEqual(patches, [STARTED, RESTORED]);
      });
    });

    for (const type of ['config', 'terminal-state']) {
      await t.test(`${type} accepts start; later error cannot restore`, () => launch({}, async socket => {
        socket.frame({ type, taskAgent: 'claude', phase: 'executing' });
        await until(() => reloads === 1);
        assert.deepEqual(patches, [STARTED]);
        socket.frame(REFUSED);
        await settle();
        assert.deepEqual(patches, [STARTED]);
        assert.equal(reloads, 1);
      }));
    }

    for (const [name, act] of [
      ['dropped socket', socket => socket.close()],
      ['transport error', socket => socket.onerror?.()],
      ['session-ended', socket => socket.frame({ type: 'session-ended' })],
    ]) {
      await t.test(`${name} keeps advance`, () => launch({}, async socket => {
        await until(() => reloads === 1);
        act(socket);
        await settle();
        assert.deepEqual(patches, [STARTED]);
      }));
    }

    for (const opts of [{ reconnectOnly: true }, { planOnly: true }, { discussionMode: true }]) {
      await t.test(`${Object.keys(opts)[0]} never advances or restores`, () => launch({ opts }, async socket => {
        socket.frame(REFUSED);
        await settle();
        assert.deepEqual(patches, []);
        assert.equal(reloads, 0);
      }));
    }
    for (const status of ['in_progress', 'completed', 'canceled', '']) {
      await t.test(`${status || 'missing status'} never advances or restores`, () => launch({ status }, async socket => {
        socket.frame(REFUSED);
        await settle();
        assert.deepEqual(patches, []);
      }));
    }
    for (const [name, reply] of [
      ['HTTP failure', async () => ({ ok: false, status: 403 })],
      ['network failure', async () => { throw new Error('offline'); }],
    ]) {
      await t.test(`${name} advancing status cannot trigger restore`, () => launch({ reply }, async socket => {
        socket.frame(REFUSED);
        await until(() => patches.length === 1);
        await settle();
        assert.deepEqual(patches, [STARTED]);
        assert.equal(reloads, 0);
      }));
    }
    await t.test('restores exact custom status using project in-progress role', async () => {
      api.statuses.list = async () => [
        { name: 'ready', is_workflow_start: true },
        { name: 'working', is_in_progress: true },
      ];
      await launch({ status: 'ready' }, async socket => {
        socket.frame(REFUSED);
        await until(() => reloads === 2);
        assert.deepEqual(patches, [{ status: 'working' }, { status: 'ready' }]);
      });
    });
  } finally {
    controller?.dispose();
    for (const socket of sockets) socket.close();
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
