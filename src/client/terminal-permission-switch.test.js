import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9139) The real console-modal.js against a WebSocket double: the header's permission-mode
// control sits after the agent caption, a pick sends `session:permission-mode` and reads
// "Switching to …" until the server's session:permission-mode-changed confirms, a failure toasts
// and keeps the confirmed mode, a reattach seeds from sessionMeta and the replay settles it, and
// a run the server does not mark `supported` keeps the static chip.
const RUN = 1790780000000;
const modeState = (confirmed, extra = {}) => ({ requested: confirmed, confirmed, pending: false, error: null, supported: true, ...extra });
const terminalState = (permissionModeState, extra = {}) => ({
  type: 'terminal-state', taskAgent: 'claude', taskAgentLabel: 'Claude Code', taskAgentModel: 'opus', startedAt: RUN,
  phase: permissionModeState.confirmed === 'plan' ? 'planning' : 'executing', planApprovalCommand: '/approve-plan',
  permissionMode: permissionModeState.confirmed, permissionModeState, permissionSource: 'task', permissionRequest: null, ...extra,
});
const changed = (taskId, permissionModeState) => ({ type: 'session:permission-mode-changed', taskId, tabId: taskId, startedAt: RUN, ...permissionModeState });

test('terminal header permission-mode selector: pending, confirm, failure, reattach replay and unsupported runs', async () => {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-terminal-permission-switch-'));
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
  // GET /api/sessions answers with the server's view of the runs; everything else is empty.
  let serverSessions = { sessions: [], sessionMeta: {} };
  install('fetch', async url => ({ ok: true, json: async () => (String(url).startsWith('/api/sessions') ? serverSessions : {}) }));
  let state;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export { default as state } from './src/client/state.js';
        export * as modal from './src/client/console-modal.js';
        export * as board from './src/client/task-board.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(build) {
        build.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        build.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
          export class FitAddon { fit() {} }
          export class Terminal {
            cols = 80; rows = 24; buffer = { active: { viewportY: 0, baseY: 0 } };
            loadAddon() {} attachCustomKeyEventHandler() {} refresh() {}
            clear() {} reset() {} scrollToBottom() {} dispose() {} write(data, done) { done?.(); }
            onData() {}
            focus() { this.textarea?.focus(); }
            open(parent) {
              this.element = document.createElement('div');
              this.textarea = document.createElement('textarea');
              this.element.appendChild(this.textarea);
              parent.appendChild(this.element);
            }
          }` }));
      } }],
    });
    const bundle = join(scratch, 'client.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const api = await import(pathToFileURL(bundle).href);
    ({ state } = api);
    const { modal, board } = api;
    const until = async (predicate, label) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail(`${label || 'DOM transition'} timed out`);
    };
    window.TipTask = { taskBoard: board, openTerminal: modal.openTerminal, fetchActiveSessions: modal.fetchActiveSessions };
    state.taskAgent = 'claude'; state.taskAgentLabel = 'Claude Code';
    state.planApprovalCommand = '/approve-plan';
    for (const id of ['T9139', 'T9140']) {
      state.taskTitleById.set(id, `Task ${id}`);
      state.taskStatusById.set(id, 'in_progress');
    }
    document.body.innerHTML = '<div id="app"></div><div id="active-sessions-list"></div>';
    const control = () => document.querySelector('.terminal-header .task-label > .session-mode');
    const trigger = () => control()?.querySelector('.permission-mode-select-trigger');
    const shown = () => (control()?.querySelector('.permission-mode-select-trigger .permission-mode-select-label')
      || control()?.querySelector('.session-mode-label'))?.textContent;
    const pick = value => {
      trigger().click();
      const row = [...document.querySelectorAll('.session-mode-menu [role="option"]')].find(r => r.dataset.value === value);
      assert.ok(row, `${value} is offered`);
      row.click();
    };
    const toasts = () => [...document.querySelectorAll('.tt-saving-indicator--toast')].map(el => [el.getAttribute('role'), el.textContent]);

    // A Plan run whose agent switches live: the selector sits right after the agent caption.
    modal.openTerminal('T9139', 'Task T9139', '', 'in_progress');
    await until(() => sockets.length === 1, 'terminal socket');
    sockets[0].open();
    sockets[0].frame(changed('T9139', modeState('plan')));
    sockets[0].frame(terminalState(modeState('plan')));
    assert.equal(control().previousElementSibling.className, 'terminal-task-caption');
    assert.equal(shown(), 'Plan mode');
    assert.equal(document.querySelector('.terminal-header > .terminal-permission-mode'), null, 'no second mode label at the far end');
    assert.deepEqual(state.sessionMeta.get('T9139').permissionMode, modeState('plan'));

    // Plan → Bypass: one request on the terminal socket, "Switching to Bypass…" until the server confirms.
    pick('bypass');
    assert.deepEqual(sockets[0].sent.at(-1), { type: 'session:permission-mode', mode: 'bypass' });
    assert.equal(shown(), 'Switching to Bypass…');
    assert.ok(control().classList.contains('session-mode-pending'));
    assert.equal(state.sessionMeta.get('T9139').permissionMode.pending, true);
    assert.equal(state.activeTerminal.permissionMode, 'plan', 'the confirmed mirror is untouched by a request');
    sockets[0].frame(changed('T9139', modeState('plan', { requested: 'bypass', pending: true })));
    sockets[0].frame(terminalState(modeState('plan', { requested: 'bypass', pending: true })));
    assert.equal(shown(), 'Switching to Bypass…');
    assert.equal(sockets[0].sent.filter(m => m.type === 'session:permission-mode').length, 1);
    sockets[0].frame(changed('T9139', modeState('bypass')));
    sockets[0].frame(terminalState(modeState('bypass')));
    assert.equal(shown(), 'Bypass');
    assert.equal(state.activeTerminal.permissionMode, 'bypass');
    assert.deepEqual(state.sessionMeta.get('T9139').permissionMode, modeState('bypass'));
    assert.deepEqual(toasts(), [['status', '✓Bypass now applies to this run. An action already running is not cancelled.']]);
    trigger().click();
    assert.deepEqual([...document.querySelectorAll('.session-mode-menu [role="option"]')].map(r => r.dataset.value), ['bypass', 'auto'],
      'Plan is never offered once left');
    trigger().click();

    // A caption change rewrites the label; the control stays after the caption.
    sockets[0].frame(terminalState(modeState('bypass'), { taskAgentModel: 'sonnet' }));
    assert.match(document.querySelector('.terminal-task-caption').textContent, /sonnet/i);
    assert.equal(control().previousElementSibling.className, 'terminal-task-caption');
    assert.equal(shown(), 'Bypass');

    // Bypass → Auto fails: an alert toast with the reason, Bypass stays on screen.
    pick('auto');
    assert.deepEqual(sockets[0].sent.at(-1), { type: 'session:permission-mode', mode: 'auto' });
    const failure = modeState('bypass', { requested: 'auto', error: { code: 'EPERMISSION_MODE', reason: 'failed', message: 'The provider could not change permission mode.' } });
    sockets[0].frame(changed('T9139', failure));
    sockets[0].frame(terminalState(failure));
    assert.equal(shown(), 'Bypass');
    assert.deepEqual(toasts().at(-1), ['alert', "✕Couldn't switch to Auto mode: the agent couldn't apply it. This run stays in Bypass."]);
    assert.ok(control().classList.contains('session-mode-error'));
    assert.equal(toasts().length, 2);

    // Reattach: the sessionMeta snapshot seeds the header with the server's state before the
    // socket replays it — a pending request reads as pending, and the replay settles it.
    serverSessions = { sessions: ['T9139'], sessionMeta: { T9139: { agent: 'claude', label: 'Claude Code', type: 'terminal', alive: true,
      startedAt: RUN, permissionSource: 'session', permissionMode: modeState('bypass', { requested: 'auto', pending: true }) } } };
    state.activeTerminal.detach({ refreshBoard: false, persistCodex: false });
    assert.equal(control(), null);
    await modal.fetchActiveSessions();
    modal.openTerminal('T9139', 'Task T9139', '', 'in_progress');
    await until(() => sockets.length === 2, 'reattach socket');
    assert.equal(shown(), 'Switching to Auto mode…', 'the seed shows the request as pending, never as applied');
    sockets[1].open();
    sockets[1].frame({ type: 'config', taskAgent: 'claude', taskAgentLabel: 'Claude Code', planApprovalCommand: '/approve-plan' });
    sockets[1].frame(changed('T9139', modeState('auto')));
    sockets[1].frame(terminalState(modeState('auto'), { permissionSource: 'session' }));
    assert.equal(shown(), 'Auto mode');
    assert.deepEqual(toasts().at(-1), ['status', '✓Auto mode now applies to this run. An action already running is not cancelled.']);

    // A second reattach after a settled state shows the confirmed mode and stays quiet.
    serverSessions.sessionMeta.T9139.permissionMode = modeState('auto');
    state.activeTerminal.detach({ refreshBoard: false, persistCodex: false });
    await modal.fetchActiveSessions();
    modal.openTerminal('T9139', 'Task T9139', '', 'in_progress');
    await until(() => sockets.length === 3, 'second reattach socket');
    assert.equal(shown(), 'Auto mode');
    sockets[2].open();
    sockets[2].frame(changed('T9139', modeState('auto')));
    assert.equal(shown(), 'Auto mode');
    assert.equal(toasts().length, 3);

    // The process exits: the selector becomes the static chip with the confirmed mode.
    sockets[2].frame({ type: 'exit', code: 0 });
    assert.equal(trigger(), null);
    assert.equal(document.querySelector('.task-label .terminal-permission-mode').textContent, 'Auto mode');
    state.activeTerminal.detach({ refreshBoard: false, persistCodex: false });

    // A run whose agent cannot switch live keeps the static chip — no selector, no request.
    modal.openTerminal('T9140', 'Task T9140', '', 'in_progress');
    await until(() => sockets.length === 4, 'unsupported run socket');
    sockets[3].open();
    sockets[3].frame(changed('T9140', modeState('plan', { supported: false })));
    sockets[3].frame(terminalState(modeState('plan', { supported: false })));
    assert.equal(trigger(), null);
    assert.equal(document.querySelector('.task-label .terminal-permission-mode').textContent, 'Plan mode');
    assert.equal(sockets[3].sent.some(m => m.type === 'session:permission-mode'), false);
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
