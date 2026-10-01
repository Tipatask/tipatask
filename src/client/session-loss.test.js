import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// Exercise real modal/card/nav wiring; only terminal rendering and network are replaced.
test('lost terminal stays in nav; one Restart click uses card launch path and clears loss', async () => {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-loss-dom-'));
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  install('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  install('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
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
  const requests = [];
  const task = { id: 'T417', title: 'Recovery task', description: 'Full task description',
    status: 'in_progress', agentAssignee: 'claude' };
  install('fetch', async (url) => {
    requests.push(url);
    return { ok: true, json: async () => url === '/api/tasks/T417' ? task : {} };
  });
  let state;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export { default as state } from './src/client/state.js';
        export * as modal from './src/client/console-modal.js';
        export * as board from './src/client/task-board.js';
        export * as cards from './src/client/task-card.js';
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
    const { modal, board, cards, attention } = api;
    window.TipTask = { taskCard: cards, taskBoard: board, openTerminal: modal.openTerminal };
    cards.registerCardCallbacks({ onOpenTerminal: modal.openTerminal });
    state.taskAgent = 'claude'; state.taskAgentLabel = 'Claude Code';
    state.taskTitleById.set(task.id, task.title);
    state.taskStatusById.set(task.id, task.status);
    document.body.innerHTML = '<div id="app"><div class="card" data-id="T417"></div></div><div id="active-sessions-list"></div>';
    const until = async predicate => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('DOM transition timed out');
    };
    const startedAt = Date.now() - 10000;
    attention.mergeSessionsSnapshot({ sessions: [task.id], sessionMeta: {
      [task.id]: { type: 'terminal', agent: 'claude', startedAt, alive: true },
    } });
    modal.openTerminal(task.id, task.title, '', task.status);
    await until(() => sockets.length === 1);
    const oldSocket = sockets[0];
    assert.equal(new URL(oldSocket.url).searchParams.get('prompt'), null);
    oldSocket.open();
    oldSocket.frame({ type: 'error', code: 'ESESSION_LOST', reason: 'signal:SIGTERM', at: new Date().toISOString() });
    oldSocket.close();
    assert.match(document.querySelector('.terminal-session-lost').textContent, /Session lost: signal:SIGTERM at/);
    assert.equal(state.activeSessions.size, 0);
    assert.equal(document.querySelector('.active-session-item').classList.contains('session-lost'), true);
    assert.equal(document.querySelector('.active-session-item').classList.contains('needs-attention'), false);
    attention.mergeSessionsSnapshot({ sessions: [] });
    board.syncActiveSessionsNav();
    assert.ok(document.querySelector('.active-session-item.session-lost'), 'row survives subsequent snapshots');
    // Minimize and reopen from the rail: show the notice without launching implicitly.
    state.activeTerminal.detach({ refreshBoard: false });
    document.querySelector('.active-session-item').click();
    await until(() => document.querySelector('.terminal-session-lost'));
    assert.equal(sockets.length, 1);
    document.querySelector('.btn-restart-session').click();
    await until(() => sockets.length === 2);
    assert.ok(requests.includes('/api/tasks/T417'), 'restart fetches current task through card path');
    const fresh = new URL(sockets[1].url);
    assert.match(fresh.searchParams.get('prompt'), /Full task description/);
    assert.equal(fresh.searchParams.get('startedAt'), null);
    assert.equal(fresh.searchParams.get('agent'), 'claude');
    sockets[1].open();
    sockets[1].frame({ type: 'terminal-state', startedAt: Date.now(), taskAgent: 'claude', phase: 'executing' });
    assert.equal(state.lostSessions.has(task.id), false);
    assert.equal(state.activeSessions.has(task.id), true);
    assert.equal(document.querySelector('.terminal-session-lost'), null);
    assert.equal(document.querySelector('.active-session-item').classList.contains('session-lost'), false);
    // A recovered modal must also respond to a later loss, and a failed restart stays retryable.
    attention.mergeSessionsSnapshot({ sessions: [] });
    state.activeTerminal.syncLostSession();
    assert.ok(document.querySelector('.terminal-session-lost'));
    document.querySelector('.btn-restart-session').click();
    await until(() => sockets.length === 3);
    sockets[2].open();
    sockets[2].frame({ type: 'error', message: 'Failed to start test agent' });
    sockets[2].close();
    assert.equal(state.activeSessions.has(task.id), false);
    assert.equal(state.lostSessions.has(task.id), true);
    assert.ok(document.querySelector('.terminal-session-lost .btn-restart-session'));
    document.querySelector('.btn-restart-session').click();
    await until(() => sockets.length === 4);
    assert.ok(new URL(sockets[3].url).searchParams.get('prompt'));
    sockets[3].open();
    sockets[3].frame({ type: 'terminal-state', startedAt: Date.now(), taskAgent: 'claude', phase: 'executing' });
    assert.equal(state.lostSessions.has(task.id), false);
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
