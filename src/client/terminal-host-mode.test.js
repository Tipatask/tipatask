import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT466) A task terminal shown on its workspace's Agent Terminal pane: openTerminal() routes
// to the workspace, mountTaskTerminal() builds the same terminal inside a host element, and the
// pane's show()/hide() keep the session running while refitting only when the pane has a size.
test('task terminal: routes to the workspace, mounts into a host, refits only when shown', async () => {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-host-dom-'));
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
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
  }
  install('WebSocket', Socket);
  install('fetch', async () => ({ ok: true, json: async () => ({}) }));
  const fits = { count: 0 };
  globalThis.__terminalFits = fits;
  let state;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export { default as state } from './src/client/state.js';
        export * as modal from './src/client/console-modal.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(build) {
        build.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        build.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
          export class FitAddon { fit() { globalThis.__terminalFits.count++; } }
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
    const { modal } = api;
    state.taskAgent = 'claude'; state.taskAgentLabel = 'Claude Code';
    document.body.innerHTML = '<div id="pane"></div>';
    const until = async predicate => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('DOM transition timed out');
    };

    // Routing: with the workspace bridge present, a launch opens the workspace on its terminal
    // pane and carries the launch arguments — no overlay, no socket of its own.
    const routed = [];
    window.TipTask = { openTaskWorkspace: (id, opts) => { routed.push({ id, opts }); } };
    modal.openTerminal('T466', 'Workspace task', 'desc', 'pending', { agent: 'codex', planOnly: true });
    assert.deepEqual(routed, [{ id: 'T466', opts: { pane: 'terminal', terminal: {
      title: 'Workspace task', desc: 'desc', status: 'pending', opts: { agent: 'codex', planOnly: true },
    } } }]);
    assert.equal(document.querySelector('.terminal-overlay'), null);
    assert.equal(sockets.length, 0);

    // Host mode: the same terminal inside the pane, without the body scroll lock or overlay.
    const host = document.getElementById('pane');
    const events = { closed: 0, closeRequests: 0 };
    const ctrl = modal.mountTaskTerminal(host, 'T466', 'Workspace task', 'desc', 'pending', {
      agent: 'claude',
      onClosed: () => { events.closed++; },
      onRequestClose: () => { events.closeRequests++; },
    });
    assert.ok(ctrl, 'controller returned');
    assert.equal(routed.length, 1, 'a host-mode open never routes again');
    assert.ok(host.querySelector('.terminal-embed .terminal-container .terminal-body'));
    assert.equal(document.querySelector('.terminal-overlay'), null);
    assert.notEqual(document.body.style.overflow, 'hidden');
    assert.equal(state.activeTerminal, ctrl);
    await until(() => sockets.length === 1);
    const socket = sockets[0];
    socket.open();

    // A pane with no size (hidden behind another tab) is never fitted.
    const fitsBefore = fits.count;
    ctrl.show({ focus: false });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(fits.count, fitsBefore, 'zero-size pane: no fit');
    assert.equal(ctrl.visible, true);
    host.hidden = true;
    assert.equal(ctrl.visible, false, 'hidden pane: not visible for attention purposes');
    host.hidden = false;

    // Shown with a size: refit and tell the PTY.
    const body = host.querySelector('.terminal-body');
    Object.defineProperty(body, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(body, 'clientHeight', { value: 400, configurable: true });
    const resizesBefore = socket.sent.filter(m => m.type === 'resize').length;
    ctrl.show({ focus: false });
    await until(() => fits.count > fitsBefore);
    assert.ok(socket.sent.filter(m => m.type === 'resize').length > resizesBefore, 'resize sent');

    // Minimize asks the workspace to close; the terminal itself stays until it is detached.
    host.querySelector('.btn-close-terminal').click();
    assert.equal(events.closeRequests, 1);
    assert.ok(host.querySelector('.terminal-embed'));
    // Backdrop mousedown on the embed is not a minimize.
    host.querySelector('.terminal-embed').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    assert.ok(host.querySelector('.terminal-embed'));

    // Detach (the workspace's dispose): pane emptied, workspace told, session left running.
    ctrl.detach({ refreshBoard: false });
    assert.equal(host.querySelector('.terminal-embed'), null);
    assert.equal(events.closed, 1);
    assert.equal(state.activeTerminal, null);
    assert.equal(socket.sent.some(m => m.type === 'terminate'), false);
  } finally {
    delete globalThis.__terminalFits;
    if (state?.activeTerminal) state.activeTerminal.detach?.({ refreshBoard: false });
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
    await window.happyDOM.abort();
  }
});
