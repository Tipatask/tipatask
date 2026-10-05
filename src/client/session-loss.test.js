import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// Exercise real modal/card/nav wiring; only terminal rendering and network are replaced.
// Each call bundles a fresh copy of the client, so module state never leaks between tests.
async function withClient(task, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-loss-dom-'));
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver',
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
  install('fetch', async (url) => {
    requests.push(url);
    return { ok: true, json: async () => url === `/api/tasks/${task.id}` ? task : {} };
  });
  let state;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export { default as state } from './src/client/state.js';
        export * as modal from './src/client/console-modal.js';
        export * as board from './src/client/task-board.js';
        export * as cards from './src/client/task-card.js';
        export * as attention from './src/client/attention-state.js';
        export * as dialogFocus from './src/client/dialog-focus.js';`, resolveDir: root },
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
    state.taskAgent = 'claude'; state.taskAgentLabel = 'Claude Code';
    state.taskTitleById.set(task.id, task.title);
    state.taskStatusById.set(task.id, task.status);
    const until = async predicate => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('DOM transition timed out');
    };
    await run({ ...api, window, sockets, requests, until });
  } finally {
    state?.activeTerminal?.detach({ refreshBoard: false, persistCodex: false });
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('lost terminal stays in nav; one Restart click uses card launch path and clears loss', async () => {
  const task = { id: 'T417', title: 'Recovery task', description: 'Full task description',
    status: 'in_progress', agentAssignee: 'claude' };
  await withClient(task, async ({ state, modal, board, cards, attention, window, sockets, requests, until }) => {
    window.TipTask = { taskCard: cards, taskBoard: board, openTerminal: modal.openTerminal };
    cards.registerCardCallbacks({ onOpenTerminal: modal.openTerminal });
    document.body.innerHTML = '<div id="app"><div class="card" data-id="T417"></div></div><div id="active-sessions-list"></div>';
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
    const notice = document.querySelector('.terminal-session-lost');
    assert.match(notice.getAttribute('aria-label'), /Session lost: signal:SIGTERM at/);
    assert.equal(notice.querySelector('.terminal-session-lost-title').textContent, 'Session lost');
    assert.equal(notice.querySelector('.terminal-session-lost-reason').textContent, 'signal:SIGTERM');
    assert.ok(notice.querySelector('time.terminal-session-lost-time').getAttribute('datetime'), 'machine-readable loss time');
    assert.equal(notice.querySelector('.btn-restart-session-label').textContent, 'Restart');
    assert.equal(document.querySelector('.btn-terminate-terminal').textContent, 'Close');
    assert.ok(document.querySelector('.btn-terminate-terminal').classList.contains('btn-terminate-terminal--dismiss'),
      'a lost session Close only dismisses, so it is not styled as a destructive action');
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
    // The restarted xterm keeps the strip up, busy, until the fresh session confirms.
    const busy = document.querySelector('.terminal-session-lost');
    assert.ok(busy.classList.contains('terminal-session-lost--restarting'));
    assert.equal(busy.querySelector('.btn-restart-session').disabled, true);
    assert.equal(busy.querySelector('.btn-restart-session-label').textContent, 'Restarting…');
    sockets[1].open();
    sockets[1].frame({ type: 'terminal-state', startedAt: Date.now(), taskAgent: 'claude', phase: 'executing' });
    assert.equal(state.lostSessions.has(task.id), false);
    assert.equal(state.activeSessions.has(task.id), true);
    assert.equal(document.querySelector('.terminal-session-lost'), null);
    assert.equal(document.querySelector('.active-session-item').classList.contains('session-lost'), false);
    assert.equal(document.querySelector('.btn-terminate-terminal').classList.contains('btn-terminate-terminal--dismiss'), false);
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
    const failed = document.querySelector('.terminal-session-lost');
    assert.equal(failed.dataset.state, 'failed');
    assert.match(failed.querySelector('.terminal-session-lost-reason').textContent, /Restart failed: Failed to start test agent/);
    assert.equal(failed.querySelector('.btn-restart-session').disabled, false, 'a failed restart is retryable');
    document.querySelector('.btn-restart-session').click();
    await until(() => sockets.length === 4);
    assert.ok(new URL(sockets[3].url).searchParams.get('prompt'));
    sockets[3].open();
    sockets[3].frame({ type: 'terminal-state', startedAt: Date.now(), taskAgent: 'claude', phase: 'executing' });
    assert.equal(state.lostSessions.has(task.id), false);
  });
});

// (TPT418) Restart on a lost COMPLETED task goes through the "already completed — start
// anyway?" confirm, opened over the task workspace. The workspace owns a dialog-focus.js layer
// that inerts every other body child, so the confirm must register its own layer: otherwise it
// renders but takes no clicks or focus.
test('completed-task Restart confirm stays interactive over the task workspace', async () => {
  const task = { id: 'T418', title: 'Done task', description: 'Completed task description',
    status: 'completed', agentAssignee: 'claude' };
  await withClient(task, async ({ state, modal, board, cards, attention, dialogFocus, window, sockets, until }) => {
    // happy-dom has no layout; dialog-focus.js only focuses elements that have client rects.
    window.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 10, height: 10 }] : []; };
    document.body.innerHTML = '<div id="active-sessions-list"></div>'
      + '<div id="task-edit-modal"><div class="task-edit-overlay"><div class="task-modal-pane--terminal"></div></div></div>';
    const workspace = document.getElementById('task-edit-modal');
    const pane = workspace.querySelector('.task-modal-pane--terminal');
    let mounts = 0;
    // Stand-in for task-edit-modal.js's workspace: every task terminal launch mounts into its
    // pane, and a restart of a lost session replaces the xterm that showed the loss.
    window.TipTask = {
      taskCard: cards, taskBoard: board, openTerminal: modal.openTerminal, mountTaskTerminal: modal.mountTaskTerminal,
      openTaskWorkspace(id, { terminal }) {
        mounts++;
        if (terminal.opts.restartLost) { state.activeTerminal?.detach({ refreshBoard: false }); pane.innerHTML = ''; }
        return modal.mountTaskTerminal(pane, id, terminal.title, terminal.desc, terminal.status, terminal.opts);
      },
    };
    cards.registerCardCallbacks({ onOpenTerminal: modal.openTerminal, onShowClaudeConfirmModal: modal.showClaudeConfirmModal });
    attention.mergeSessionsSnapshot({ sessions: [], lost: [task.id], lostDetails: { [task.id]: { reason: 'signal:SIGKILL', at: new Date().toISOString() } },
      sessionMeta: { [task.id]: { type: 'terminal', agent: 'claude', alive: false } } });
    const workspaceFocus = dialogFocus.activateDialogFocus({ root: workspace });
    modal.openTerminal(task.id, task.title, task.description, task.status);
    await until(() => document.querySelector('.terminal-session-lost'));
    assert.equal(sockets.length, 0, 'reopening a lost session shows recovery controls without launching');
    const flush = () => new Promise(resolve => setTimeout(resolve, 10)); // let MutationObserver inerting run

    const openConfirm = async () => {
      document.querySelector('.btn-restart-session').click();
      await until(() => document.querySelector('.modal-overlay'));
      await flush();
      return document.querySelector('.modal-overlay');
    };

    // Cancel: dismissed, no session, workspace interactive again.
    let overlay = await openConfirm();
    assert.ok(overlay.classList.contains('modal-overlay--over-modal'), 'stacks above .task-edit-overlay');
    assert.equal(overlay.querySelector('[role="alertdialog"]')?.getAttribute('aria-modal'), 'true');
    assert.match(overlay.textContent, /T418 is already completed/);
    assert.notEqual(overlay.inert, true, 'confirm must not be inerted by the workspace layer');
    assert.equal(workspace.inert, true, 'workspace takes no clicks while the confirm is open');
    assert.equal(document.activeElement, overlay.querySelector('.btn-cancel'), 'focus moves into the confirm');
    assert.equal(workspaceFocus.isTop(), false);
    overlay.querySelector('.btn-cancel').click();
    await flush();
    assert.equal(document.querySelector('.modal-overlay'), null);
    assert.equal(sockets.length, 0, 'Cancel starts nothing');
    assert.notEqual(workspace.inert, true);
    assert.equal(workspaceFocus.isTop(), true);
    assert.equal(document.querySelector('.btn-restart-session').disabled, false, 'Restart re-arms after a declined confirm');

    // A second Restart while a confirm is open never stacks another dialog.
    overlay = await openConfirm();
    document.querySelector('.btn-restart-session').disabled = false;
    document.querySelector('.btn-restart-session').click();
    await flush();
    assert.equal(document.querySelectorAll('.modal-overlay').length, 1);

    // Escape closes only the confirm — the capture-phase handler stops it reaching the workspace.
    let workspaceEscapes = 0;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') workspaceEscapes++; });
    document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    assert.equal(document.querySelector('.modal-overlay'), null);
    assert.equal(workspaceEscapes, 0);
    assert.ok(document.querySelector('.terminal-session-lost'), 'workspace terminal still shows recovery');
    assert.equal(sockets.length, 0);

    // Confirm, clicked twice: exactly one fresh session.
    overlay = await openConfirm();
    const confirmBtn = overlay.querySelector('.btn-confirm');
    const mountsBefore = mounts;
    confirmBtn.click();
    confirmBtn.click();
    await until(() => sockets.length === 1);
    await flush();
    assert.equal(sockets.length, 1, 'one Confirm, one session');
    assert.equal(mounts, mountsBefore + 1);
    assert.equal(document.querySelector('.modal-overlay'), null);
    assert.notEqual(workspace.inert, true);
    const fresh = new URL(sockets[0].url);
    assert.match(fresh.searchParams.get('prompt'), /Completed task description/);
    assert.equal(fresh.searchParams.get('agent'), 'claude');
    assert.ok(document.querySelector('.terminal-session-lost--restarting'));
    sockets[0].open();
    sockets[0].frame({ type: 'terminal-state', startedAt: Date.now(), taskAgent: 'claude', phase: 'executing' });
    assert.equal(state.lostSessions.has(task.id), false);
    assert.equal(document.querySelector('.terminal-session-lost'), null);
    board.syncActiveSessionsNav();
    assert.equal(document.querySelector('.active-session-item.session-lost'), null);
    workspaceFocus.close();
  });
});
