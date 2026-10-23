import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9078) The agent's own dialogs (Claude's ExitPlanMode / permission menus, Codex and Pi
// approval prompts) are answered by typing into the xterm in every run mode, Plan included.
// A pending permission request or a plan-ready bar must neither lock the terminal's input nor
// move focus off its textarea; a panel button answer hands focus back to the terminal.
test('plan-mode terminal keeps forwarding keystrokes and keeps xterm focus across gate requests and panel answers', async () => {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-terminal-dialog-focus-'));
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
        export * as board from './src/client/task-board.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(build) {
        build.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        // The double owns a real focusable textarea, like xterm's .xterm-helper-textarea, and
        // exposes the onData() sink so a typed key can be replayed into the modal's forwarder.
        build.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
          export class FitAddon { fit() {} }
          export class Terminal {
            cols = 80; rows = 24; buffer = { active: { viewportY: 0, baseY: 0 } };
            loadAddon() {} attachCustomKeyEventHandler() {} refresh() {}
            clear() {} scrollToBottom() {} dispose() {} write(data, done) { done?.(); }
            onData(handler) { globalThis.__ttTermData = handler; }
            focus() { this.textarea?.focus(); }
            open(parent) {
              this.element = document.createElement('div');
              this.textarea = document.createElement('textarea');
              this.textarea.className = 'xterm-helper-textarea';
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
    state.taskTitleById.set('T9078', 'Plan task');
    state.taskStatusById.set('T9078', 'in_progress');
    document.body.innerHTML = '<div id="app"></div><div id="active-sessions-list"></div>';

    modal.openTerminal('T9078', 'Plan task', '', 'in_progress');
    await until(() => sockets.length === 1, 'terminal socket');
    const textarea = document.querySelector('.xterm-helper-textarea');
    assert.ok(textarea, 'the terminal double mounted its textarea');
    sockets[0].open();
    await until(() => document.activeElement === textarea, 'initial terminal focus');

    // A Plan run with a pending gate request: the panel appears, the textarea keeps focus,
    // the status line is the ordinary planning text (no read-only lock) and a typed "2" —
    // the "Yes, and don't ask again" row of Claude's own menu — still reaches the PTY.
    sockets[0].frame({ type: 'terminal-state', taskAgent: 'claude', phase: 'planning',
      permissionMode: 'plan', permissionSource: 'task', planApprovalCommand: '/approve-plan',
      permissionRequest: { id: 'req-1', tool: 'Bash', input: '{"command":"npm test"}' } });
    const panel = document.querySelector('.terminal-permission-request');
    assert.ok(panel, 'pending request renders the approval panel');
    assert.equal(document.activeElement, textarea, 'the panel does not take focus from the terminal');
    assert.equal(panel.querySelectorAll('button:disabled').length, 0, 'panel buttons start enabled');
    assert.match(document.querySelector('.terminal-permission-mode').textContent, /Plan mode/);
    assert.match(document.querySelector('.status-dot').title, /Planning/);
    assert.doesNotMatch(document.querySelector('.status-dot').title, /read-only/i);
    assert.equal(state.activeTerminal.permissionMode, 'plan');
    globalThis.__ttTermData('2');
    assert.deepEqual(sockets[0].sent.at(-1), { type: 'data', data: '2' }, 'keystrokes reach the PTY in plan mode');
    globalThis.__ttTermData('\x1b[B');
    assert.deepEqual(sockets[0].sent.at(-1), { type: 'data', data: '\x1b[B' }, 'arrow keys reach the PTY in plan mode');

    // Answering through the panel instead: the click lands focus on the button (as a real
    // pointer click does), the answer frame goes out, and focus returns to the terminal.
    const allow = [...panel.querySelectorAll('button')].at(-1);
    allow.focus();
    assert.equal(document.activeElement, allow);
    allow.click();
    assert.deepEqual(sockets[0].sent.at(-1), { type: 'permission-answer', id: 'req-1', allow: true });
    await until(() => document.activeElement === textarea, 'focus back on the terminal after a panel answer');
    globalThis.__ttTermData('\r');
    assert.deepEqual(sockets[0].sent.at(-1), { type: 'data', data: '\r' });

    // The request resolves: the panel goes, the terminal keeps focus.
    sockets[0].frame({ type: 'terminal-state', taskAgent: 'claude', phase: 'planning',
      permissionMode: 'plan', permissionSource: 'task', planApprovalCommand: '/approve-plan', permissionRequest: null });
    assert.equal(document.querySelector('.terminal-permission-request'), null);
    assert.equal(document.activeElement, textarea);

    // Plan ready in Plan mode: the bar offers the ordinary Proceed (a mirror of the agent's own
    // approval dialog), sends plan-approve, and hands focus back to the terminal.
    sockets[0].frame({ type: 'plan-ready', taskAgent: 'claude' });
    const bar = document.querySelector('.plan-ready-dialog');
    assert.ok(bar, 'plan-ready bar renders in plan mode');
    assert.match(bar.querySelector('.plan-ready-text').textContent, /plan ready/i);
    assert.doesNotMatch(bar.textContent, /read-only|execution mode/i);
    assert.equal(document.activeElement, textarea, 'the plan-ready bar does not take focus');
    const proceed = bar.querySelector('.btn-plan-proceed');
    proceed.focus();
    proceed.click();
    assert.deepEqual(sockets[0].sent.at(-1), { type: 'plan-approve' });
    await until(() => document.activeElement === textarea, 'focus back on the terminal after Proceed');
  } finally {
    state?.activeTerminal?.detach({ refreshBoard: false, persistCodex: false });
    delete globalThis.__ttTermData;
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
