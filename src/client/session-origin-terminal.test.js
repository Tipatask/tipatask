import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9239) A run the web app started on this device, end to end through the real client modules:
// GET /api/sessions lists it with `origin: 'web'`, the left-nav row shows a globe on its agent icon,
// clicking the row reattaches (a promptless socket that names the run's startedAt, so no second
// agent starts), the terminal header shows the globe from the first paint and keeps it across a
// close and reopen, a run started in Task App gets none, and an exited web run's row goes away.
const RUN = 1790790000000;
const WEB = 'Started from the web app';

test('web-started runs: row globe, reattach without a start, header globe across close and reopen, exit clears', async () => {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-session-origin-'));
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
  const webMeta = { agent: 'claude', label: 'Claude Code', type: 'terminal', alive: true, startedAt: RUN, origin: 'web' };
  let serverSessions = { sessions: ['W1'], exited: [], sessionMeta: { W1: webMeta } };
  install('fetch', async url => ({ ok: true, json: async () => (String(url).startsWith('/api/sessions') ? serverSessions : {}) }));
  let state;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export { default as state } from './src/client/state.js';
        export * as modal from './src/client/console-modal.js';
        export * as board from './src/client/task-board.js';
        export * as attention from './src/client/attention-ws.js';`, resolveDir: root },
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
    const { modal, board, attention } = api;
    const until = async (predicate, label) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail(`${label || 'DOM transition'} timed out`);
    };
    window.TipTask = { taskBoard: board, openTerminal: modal.openTerminal, fetchActiveSessions: modal.fetchActiveSessions };
    state.taskAgent = 'claude'; state.taskAgentLabel = 'Claude Code';
    for (const id of ['W1', 'L1']) {
      state.taskTitleById.set(id, `Task ${id}`);
      state.taskStatusById.set(id, 'in_progress');
    }
    document.body.innerHTML = '<div id="app"></div><div id="active-sessions-list"></div>';
    const row = id => document.querySelector(`#active-sessions-list .active-session-item[data-task-id="${id}"]`);
    const headerBadge = () => document.querySelector('.terminal-header .terminal-task-caption .terminal-origin-badge');
    const configFrame = extra => ({ type: 'config', taskAgent: 'claude', taskAgentLabel: 'Claude Code', planApprovalCommand: '/approve-plan', ...extra });
    const stateFrame = extra => ({ type: 'terminal-state', taskAgent: 'claude', taskAgentLabel: 'Claude Code', taskAgentModel: 'opus',
      startedAt: RUN, phase: 'executing', permissionMode: 'auto', permissionModeState: null, permissionSource: 'project', permissionRequest: null, ...extra });

    // The project view opens mid-run: the snapshot lists the web run with its globe.
    await modal.fetchActiveSessions();
    board.updateClaudeButtons();
    assert.ok(row('W1'), 'the web run has an active-session button');
    assert.ok(row('W1').classList.contains('session-web-origin'));
    assert.ok(row('W1').querySelector('.active-session-icon > svg + .session-origin-badge'), 'globe beside the agent icon');
    assert.match(row('W1').getAttribute('data-tooltip'), new RegExp(`^W1 — Task W1\\n${WEB}`));
    assert.equal(row('W1').getAttribute('aria-label'), row('W1').getAttribute('data-tooltip'));

    // Clicking it reattaches to the run: no prompt, the run's own start time, the globe at once.
    row('W1').click();
    await until(() => sockets.length === 1, 'reattach socket');
    assert.doesNotMatch(sockets[0].url, /[?&]prompt=/, 'opening the button never starts an agent');
    assert.match(sockets[0].url, new RegExp(`[?&]startedAt=${RUN}`));
    assert.equal(headerBadge()?.getAttribute('aria-label'), WEB);
    assert.equal(headerBadge().previousElementSibling.classList.contains('terminal-agent-dot'), true);
    sockets[0].open();
    sockets[0].frame(configFrame({ origin: 'web' }));
    sockets[0].frame(stateFrame({ origin: 'web' }));
    assert.ok(headerBadge(), 'the session frames confirm the globe');
    assert.equal(state.sessionMeta.get('W1').origin, 'web');
    assert.ok(row('W1').querySelector('.session-origin-badge'));

    // Close the terminal (the run keeps going) and reopen it: same run, same globe.
    state.activeTerminal.detach({ refreshBoard: false, persistCodex: false });
    assert.equal(headerBadge(), null);
    assert.ok(row('W1')?.querySelector('.session-origin-badge'), 'the row keeps its globe while the run continues');
    row('W1').click();
    await until(() => sockets.length === 2, 'reopen socket');
    assert.doesNotMatch(sockets[1].url, /[?&]prompt=/);
    assert.ok(headerBadge(), 'the reopened header shows the globe from the first paint');
    sockets[1].open();
    sockets[1].frame(configFrame({ origin: 'web' }));
    sockets[1].frame(stateFrame({ origin: 'web' }));
    assert.ok(headerBadge());
    state.activeTerminal.detach({ refreshBoard: false, persistCodex: false });

    // A run started in Task App: a fresh launch with a prompt, frames without origin, no globe.
    modal.openTerminal('L1', 'Task L1', '', 'in_progress');
    await until(() => sockets.length === 3, 'local start socket');
    assert.match(sockets[2].url, /[?&]prompt=/);
    assert.equal(headerBadge(), null);
    sockets[2].open();
    sockets[2].frame(configFrame());
    sockets[2].frame(stateFrame());
    assert.equal(headerBadge(), null);
    assert.equal('origin' in state.sessionMeta.get('L1'), false);
    assert.ok(row('L1'));
    assert.equal(row('L1').querySelector('.session-origin-badge'), null);
    assert.doesNotMatch(row('L1').getAttribute('data-tooltip'), new RegExp(WEB));
    state.activeTerminal.detach({ refreshBoard: false, persistCodex: false });

    // The web run ends on the device: its button goes, the local one stays as it was.
    serverSessions = { sessions: ['L1'], exited: ['W1'], sessionMeta: { W1: { ...webMeta, alive: false },
      L1: { agent: 'claude', label: 'Claude Code', type: 'terminal', alive: true, startedAt: RUN + 1 } } };
    attention.handleAttentionMessage({ type: 'remote-session-state', projectPath: '', taskId: 'W1', tabId: 'W1', state: 'exited', origin: 'web', agent: 'claude', startedAt: RUN });
    await until(() => !row('W1'), 'web row cleared');
    assert.equal(state.activeSessions.has('W1'), false);
    assert.equal(state.exitedSessions.has('W1'), true);
    assert.equal(state.lostSessions.has('W1'), false, 'an exited web run is not a lost session');
    assert.ok(row('L1'));
    assert.equal(row('L1').querySelector('.session-origin-badge'), null);
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
