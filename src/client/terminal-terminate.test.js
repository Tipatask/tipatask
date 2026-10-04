import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

test('Terminate closes only its workspace after success; cancellation and failure allow retry', async () => {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-terminate-dom-'));
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
    static failNext = false;
    constructor(url) {
      if (Socket.failNext) { Socket.failNext = false; throw new Error('Socket unavailable'); }
      this.url = url; this.readyState = 0; this.sent = []; sockets.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  install('WebSocket', Socket);
  install('fetch', async url => ({ ok: true, json: async () => url === '/api/sessions' ? {
    sessions: sockets.filter(s => s.readyState === Socket.OPEN && !new URL(s.url).searchParams.has('terminate'))
      .map(s => new URL(s.url).searchParams.get('taskId')),
  } : {} }));
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const until = async predicate => {
    for (let i = 0; i < 150; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('DOM transition timed out');
  };
  let editor;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export * as terminal from './src/client/console-modal.js';
        export * as editor from './src/client/task-edit-modal.js';
        export { default as state } from './src/client/state.js';
        export { api } from './src/client/api-client.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(build) {
        build.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        build.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
          export class FitAddon { fit() {} }
          export class Terminal {
            cols = 80; rows = 24; buffer = { active: { viewportY: 0, baseY: 0 } };
            loadAddon() {} onData() {} attachCustomKeyEventHandler() {} refresh() {}
            focus() { this.element?.focus(); } blur() { this.element?.blur(); }
            clear() {} scrollToBottom() {} dispose() {} write(data, done) { done?.(); }
            open(parent) { this.element = document.createElement('textarea'); parent.appendChild(this.element); }
          }` }));
      } }],
    });
    const bundle = join(scratch, 'client.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const client = await import(pathToFileURL(bundle).href);
    ({ editor } = client);
    const { terminal, state, api } = client;
    state.taskAgent = 'claude'; state.taskAgentLabel = 'Claude Code';
    state.currentUserId = 1;
    state.projectMembers = [];
    const task = id => ({ id, title: id, description: '', status: 'pending', category: 'CODING',
      priority: 1, tags: [], dependencies: [], assignee: 1 });
    api.tasks.get = async id => task(id);
    api.tasks.listAll = async () => [];
    api.members.list = async () => [];
    api.tasks.comments.list = async () => [];
    api.tasks.events.list = async () => ({ events: [], subscribed: true });
    window.TipTask = { mountTaskTerminal: terminal.mountTaskTerminal };
    document.body.innerHTML = '<button id="opener">Edit</button><div id="task-edit-modal" hidden></div>';
    const opener = document.getElementById('opener');
    opener.getClientRects = () => [{ width: 40, height: 20 }];
    const modal = document.getElementById('task-edit-modal');
    const button = () => modal.querySelector('.btn-terminate-terminal');
    const controls = () => sockets.filter(s => new URL(s.url).searchParams.has('terminate'));
    async function open(id) {
      const before = sockets.length;
      await editor.openTaskEditModal(id, { trigger: opener, initialPane: 'terminal', terminalLaunch: {
        title: id, desc: '', status: 'pending', opts: { isResume: true, agent: 'claude' },
      } });
      await until(() => sockets.length > before);
      sockets.at(-1).open();
      await tick();
      return sockets.at(-1);
    }
    async function confirm() {
      button().click();
      await until(() => document.querySelector('.modal-overlay--over-terminal .btn-confirm'));
      document.querySelector('.modal-overlay--over-terminal .btn-confirm').click();
      await tick();
      return controls().at(-1);
    }

    const first = await open('TERM1');
    button().click(); button().click();
    assert.equal(document.querySelectorAll('.modal-overlay--over-terminal').length, 1);
    document.querySelector('.modal-overlay--over-terminal .btn-cancel').click();
    await tick();
    assert.equal(controls().length, 0, 'cancel sends no termination');
    assert.equal(modal.hidden, false);
    assert.equal(first.readyState, Socket.OPEN);

    const failed = await confirm();
    button().click();
    assert.equal(controls().length, 1, 'pending request cannot be duplicated');
    failed.message({ type: 'error', message: 'Cannot terminate' });
    await tick();
    assert.equal(modal.hidden, false);
    assert.ok(button(), 'failed request keeps terminal mounted');
    assert.equal(first.readyState, Socket.OPEN);

    const timedOut = await confirm();
    await new Promise(resolve => setTimeout(resolve, 5100));
    assert.equal(timedOut.readyState, 3);
    assert.equal(modal.hidden, false, 'timeout keeps workspace open');
    assert.equal(first.readyState, Socket.OPEN);
    Socket.failNext = true;
    await confirm();
    assert.equal(modal.hidden, false, 'thrown transport error keeps workspace open');
    assert.equal(first.readyState, Socket.OPEN);

    const retry = await confirm();
    assert.equal(new URL(retry.url).searchParams.get('taskId'), 'TERM1');
    assert.equal(modal.hidden, false, 'confirmation alone never closes the modal');
    first.message({ type: 'session-ended', taskId: 'TERM1' });
    assert.equal(modal.hidden, false, 'terminal stream cannot race the control acknowledgement');
    retry.message({ type: 'session-ended', taskId: 'TERM1' });
    await until(() => modal.hidden);
    assert.equal(first.readyState, 3);
    assert.equal(document.activeElement, opener, 'workspace close restores board focus');

    // A reply to the previous workspace must neither close nor blur the replacement.
    await open('TERM1');
    const delayed = await confirm();
    const other = await open('TERM2');
    const otherFocus = document.activeElement;
    delayed.message({ type: 'session-ended', taskId: 'TERM1' });
    await tick();
    assert.equal(modal.hidden, false);
    assert.equal(modal.dataset.taskId, 'TERM2');
    assert.equal(other.readyState, Socket.OPEN);
    assert.equal(state.activeTerminal.taskId, 'TERM2');
    assert.equal(document.activeElement, otherFocus);

    // Unsaved Edit fields survive a canceled discard after successful termination.
    modal.querySelector('[data-pane="edit"].task-modal-tab').click();
    const title = modal.querySelector('.modal-title-input');
    title.value = 'Unsaved draft';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    modal.querySelector('[data-pane="terminal"].task-modal-tab').click();
    const dirty = await confirm();
    dirty.message({ type: 'session-ended', taskId: 'TERM2' });
    await until(() => document.querySelector('.modal-overlay--over-modal .btn-cancel'));
    document.querySelector('.modal-overlay--over-modal .btn-cancel').click();
    await tick();
    assert.equal(modal.hidden, false);
    assert.equal(modal.querySelector('.modal-title-input').value, 'Unsaved draft');
    assert.equal(other.readyState, 3, 'only the selected terminal was stopped');

    // A workspace replaced while the discard dialog is pending cannot be closed by it.
    editor.closeTaskEditModal(true);
    await open('TERM1');
    modal.querySelector('[data-pane="edit"].task-modal-tab').click();
    const anotherTitle = modal.querySelector('.modal-title-input');
    anotherTitle.value = 'Another draft';
    anotherTitle.dispatchEvent(new Event('input', { bubbles: true }));
    modal.querySelector('[data-pane="terminal"].task-modal-tab').click();
    const pendingDiscard = await confirm();
    pendingDiscard.message({ type: 'session-ended', taskId: 'TERM1' });
    await until(() => document.querySelector('.modal-overlay--over-modal .btn-confirm'));
    const discard = document.querySelector('.modal-overlay--over-modal .btn-confirm');
    await open('TERM2');
    discard.click();
    await tick();
    assert.equal(modal.hidden, false);
    assert.equal(modal.dataset.taskId, 'TERM2');

    // Natural termination only empties the pane; automatic exit must not close Edit/Chat.
    sockets.at(-1).message({ type: 'session-ended', taskId: 'TERM2' });
    await tick();
    assert.equal(modal.hidden, false);
    assert.equal(button(), null);
  } finally {
    editor?.closeTaskEditModal(true);
    for (const socket of sockets) socket.close();
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
