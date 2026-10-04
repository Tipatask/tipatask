import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

test('paused controls survive session snapshot and terminal reconnect; sidebar Resume leaves terminal socket attached', async () => {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-watchdog-actions-'));
  const globals = new Map();
  const install = (key, value) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  install('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  install('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  const sockets = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    frame(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  install('WebSocket', Socket);
  install('fetch', async () => ({ ok: true, json: async () => ({}) }));
  let state;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export { default as state } from './src/client/state.js';
        export * as modal from './src/client/console-modal.js';
        export * as board from './src/client/task-board.js';
        export * as attention from './src/client/attention-state.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(build) {
        build.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        build.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
          export class FitAddon { fit() {} }
          export class Terminal {
            cols = 80; rows = 24; buffer = { active: { viewportY: 0, baseY: 0 } };
            loadAddon() {} onData() {} attachCustomKeyEventHandler() {} refresh() {} focus() {}
            clear() {} scrollToBottom() {} dispose() {} write(data, done) { done?.(); }
            open(parent) { this.element = document.createElement('div'); parent.appendChild(this.element); }
          }` }));
      } }],
    });
    const bundle = join(scratch, 'client.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const api = await import(pathToFileURL(bundle).href);
    ({ state } = api);
    const { modal, board, attention } = api;
    const until = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('DOM transition timed out');
    };
    window.TipTask = { taskBoard: board, openTerminal: modal.openTerminal, fetchActiveSessions: modal.fetchActiveSessions };
    state.taskAgent = 'claude'; state.taskAgentLabel = 'Claude Code';
    state.taskTitleById.set('T417', 'Paused task');
    state.taskStatusById.set('T417', 'in_progress');
    document.body.innerHTML = '<div id="app"></div><div id="active-sessions-list"></div>';
    const paused = { reason: 'memory-pressure', count: 35, rssMb: 6400, limitMb: 3072 };
    const snapshot = () => attention.mergeSessionsSnapshot({ sessions: ['T417'], sessionMeta: {
      T417: { type: 'terminal', agent: 'claude', alive: true, startedAt: Date.now(), paused },
    } });
    snapshot();
    board.syncActiveSessionsNav();
    assert.ok(document.querySelector('.active-session-item.session-paused'));
    assert.ok(document.querySelector('.active-session-resume'));
    assert.ok(document.querySelector('.active-session-terminate'));

    document.querySelector('.active-session-resume').click();
    assert.equal(new URL(sockets[0].url).searchParams.get('resumePaused'), '1');
    sockets[0].open();
    sockets[0].frame({ type: 'resume-paused-result', ok: true, paused: null });
    await Promise.resolve();
    assert.equal(document.querySelector('.active-session-resume'), null);

    snapshot(); // A later authoritative snapshot restores paused state after reconnect.
    board.syncActiveSessionsNav();
    modal.openTerminal('T417', 'Paused task', '', 'in_progress');
    await until(() => sockets.length === 2);
    assert.ok(document.querySelector('.terminal-watchdog-actions'));
    assert.equal(sockets.length, 2);
    sockets[1].open();
    sockets[1].frame({ type: 'terminal-state', taskAgent: 'claude', phase: 'executing', paused });
    assert.ok(document.querySelector('.terminal-watchdog-actions .btn-resume-paused'));
    assert.match(document.querySelector('.terminal-watchdog-actions').title, /Sustained high RSS, host pressure, and growth in this tree/);
    assert.match(document.querySelector('.terminal-watchdog-actions').title, /RSS warning 3072 MiB/);
    document.querySelector('.terminal-watchdog-actions .btn-resume-paused').click();
    assert.deepEqual(sockets[1].sent.at(-1), { type: 'resume-paused' });
    sockets[1].frame({ type: 'terminal-state', taskAgent: 'claude', phase: 'executing', paused: null });
    assert.equal(document.querySelector('.terminal-watchdog-actions'), null);
    assert.equal(document.querySelector('.active-session-resume'), null);

    snapshot();
    board.syncActiveSessionsNav();
    window.TipTask.requestSessionClose = async () => true;
    document.querySelector('.active-session-terminate').click();
    await until(() => sockets.length === 3);
    assert.equal(new URL(sockets[2].url).searchParams.get('terminate'), '1');
    sockets[2].open();
    sockets[2].frame({ type: 'session-ended', taskId: 'T417' });
  } finally {
    state?.activeTerminal?.detach({ refreshBoard: false, persistCodex: false });
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
