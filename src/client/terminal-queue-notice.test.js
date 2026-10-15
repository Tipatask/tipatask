import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

test('mounted terminal refreshes queue notices on the same socket in both locales', async () => {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-queue-notice-'));
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
    constructor() { this.readyState = 0; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    frame(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  install('WebSocket', Socket);
  install('fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }));
  window.queueWrites = [];
  let controller;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export * as modal from './src/client/console-modal.js';
        export { default as state } from './src/client/state.js';
        export { setLocale, t } from './src/client/i18n.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(b) {
        b.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        b.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
          export class FitAddon { fit() {} }
          export class Terminal {
            cols = 80; rows = 24; buffer = { active: { viewportY: 0, baseY: 0 } };
            loadAddon() {} onData() {} attachCustomKeyEventHandler() {} refresh() {}
            focus() {} blur() {} clear() {} reset() {} scrollToBottom() {} dispose() {}
            write(data, done) { window.queueWrites.push(data); done?.(); }
            open(parent) { this.element = document.createElement('textarea'); parent.appendChild(this.element); }
          }` }));
      } }],
    });
    const bundle = join(scratch, 'client.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const { modal, state, setLocale, t } = await import(pathToFileURL(bundle).href);
    state.taskAgent = 'claude'; state.taskAgentLabel = 'Claude Code';
    for (const locale of ['en', 'uk']) {
      setLocale(locale);
      const id = `QUEUE-${locale}`;
      const host = document.createElement('div'); document.body.appendChild(host);
      const before = sockets.length;
      controller = modal.mountTaskTerminal(host, id, id, '', 'in_progress', { agent: 'claude' });
      for (let i = 0; sockets.length === before && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(sockets.length, before + 1);
      const socket = sockets.at(-1); socket.open();
      window.queueWrites.length = 0;
      const row = { type: 'session-queued', position: 1, reason: 'device-cap', running: 6, cap: 6,
        rampCap: 6, rampCeiling: 8, rampNextStepAt: Date.now() + 300000,
        alarm: null, requiredBytes: 35, headroomBytes: 30 };
      const notice = () => window.queueWrites.at(-1).replace(/\x1b\[[0-9;]*m/g, '').trim();
      const base = (running = 6, cap = 6) => `${t('queue.badge', { position: 1 })}: ${t('queue.ramp.running', { running, cap })}`;
      socket.frame(row);
      const time = new Date(row.rampNextStepAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
      assert.equal(notice(), `${base()} ${t('queue.ramp.next', { next: 7, time })}`);
      let count = window.queueWrites.length;
      socket.frame(row);
      assert.equal(window.queueWrites.length, count, 'identical broadcasts do not add lines');
      for (const alarm of ['headroom', 'swap', 'pressure', 'coordination']) {
        socket.frame({ ...row, alarm, rampNextStepAt: null });
        assert.equal(notice(), `${base()} ${t('queue.ramp.held', { cap: 6, reason: t(`queue.ramp.reason.${alarm}`) })}`);
      }
      socket.frame({ ...row, running: 7 });
      assert.ok(notice().startsWith(base(7)), 'running-only update refreshes notice');
      socket.frame({ ...row, running: 8, cap: 8, rampCap: 8, rampNextStepAt: null });
      assert.equal(notice(), base(8, 8), 'ceiling has no extra sentence');
      count = window.queueWrites.length;
      socket.frame({ ...row, running: 8, cap: 8, rampCap: 8, rampNextStepAt: null, headroomBytes: 12 });
      assert.equal(window.queueWrites.length, count, 'byte-only updates retain diagnostics without repeated text');
      assert.equal(state.queueDiagnostics.get(id).headroomBytes, 12);
      assert.ok(!state.activeSessions.has(id));
      assert.equal(sockets.length, before + 1, 'all changes used one open terminal');
      controller.dispose(); controller = null; host.remove();
    }
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
