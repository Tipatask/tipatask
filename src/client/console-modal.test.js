import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

test('both consoles confirm safe hyperlinks once and route them through the platform opener', async () => {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-console-links-'));
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
  install('WebSocket', class {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
  });
  install('fetch', async () => ({ ok: true, json: async () => ({}) }));
  window.confirm = () => assert.fail('native confirmation must never run');
  const opened = [];
  const browserOpened = [];
  window.electronAPI = { openExternal: async uri => { opened.push(uri); return { ok: true }; } };
  window.open = (...args) => { browserOpened.push(args); };
  let state, modal;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export { default as state } from './src/client/state.js';
        export * as modal from './src/client/console-modal.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(build) {
        build.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        build.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
          export class FitAddon { fit() {} }
          export class Terminal {
            constructor(options) { this.options = options; }
            cols = 80; rows = 24; buffer = { active: { viewportY: 0, baseY: 0 } };
            loadAddon() {} attachCustomKeyEventHandler() {} refresh() {}
            clear() {} scrollToBottom() {} dispose() {} write(data, done) { done?.(); }
            onData() {} focus() { this.textarea?.focus(); }
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
    ({ state, modal } = await import(pathToFileURL(bundle).href));
    const until = async predicate => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('console did not mount');
    };
    document.body.innerHTML = '<div id="app"></div><div id="active-sessions-list"></div>';
    modal.openTerminal('LINK-PROBE', 'Terminal links', '', 'in_progress');
    await until(() => state.activeTerminal?.term.element);
    const taskHandler = state.activeTerminal.term.options.linkHandler;
    state.activeTerminal.detach({ refreshBoard: false, persistCodex: false });
    state.chatState = { processExited: true };
    modal.openObjectiveConsole();
    await until(() => state.chatState.term);
    const objectiveHandler = state.chatState.term.options.linkHandler;
    const dialog = () => document.querySelector('.modal-overlay--over-terminal');
    const confirmLink = () => dialog().querySelector('.btn-confirm').click();
    const uri = 'https://photoassistant.net/dashboard/database?tab=all&next=%2Fdb#tables';

    for (const handler of [taskHandler, objectiveHandler]) {
      assert.equal(handler.allowNonHttpProtocols, true, 'mailto reaches the scheme allowlist');
      const before = opened.length;
      const pending = handler.activate({}, uri);
      assert.ok(dialog());
      assert.ok(dialog().textContent.includes(uri), 'confirmation shows the exact destination');
      assert.equal(opened.length, before, 'opening waits for confirmation');
      await handler.activate({}, uri);
      assert.equal(document.querySelectorAll('[role="alertdialog"]').length, 1, 'repeat click keeps one dialog');
      confirmLink();
      await pending;
      assert.equal(dialog(), null);
      assert.deepEqual(opened.slice(before), [uri], 'confirmed activation opens the exact URL once');
    }
    assert.deepEqual(browserOpened, [], 'Electron never falls back to a renderer popup');

    for (const uri of ['javascript:alert(1)', 'file:///tmp/data', 'data:text/html,test', 'ftp://example.com',
      'vscode://file/tmp/data', '/relative', 'not a URL', 'https://', ' https://example.com', 'https://example.com/\nfile', null]) {
      await taskHandler.activate({}, uri);
      assert.equal(dialog(), null, `rejected scheme or malformed URL: ${uri}`);
    }
    assert.equal(opened.length, 2);

    let pending = taskHandler.activate({}, 'http://localhost:4455/download?name=%22x%22');
    dialog().querySelector('.btn-cancel').click();
    await pending;
    assert.equal(opened.length, 2, 'cancel opens nothing');

    for (const uri of ['http://localhost:4455/download?name=%22x%22', 'mailto:hello@example.com?subject=Hello%20there']) {
      pending = taskHandler.activate({}, uri);
      confirmLink();
      await pending;
      assert.equal(opened.at(-1), uri);
    }

    const escapedUri = 'https://example.com/?q=<img src=x onerror=alert(1)>&value="quoted"';
    pending = taskHandler.activate({}, escapedUri);
    assert.ok(dialog().textContent.includes(escapedUri));
    assert.equal(dialog().querySelector('img'), null, 'destination is escaped before rendering');
    dialog().querySelector('.btn-cancel').click();
    await pending;

    delete window.electronAPI;
    pending = taskHandler.activate({}, uri);
    confirmLink();
    await pending;
    assert.deepEqual(browserOpened, [[uri, '_blank', 'noopener,noreferrer']]);

    for (const openExternal of [async () => ({ ok: false, error: 'open_failed' }), async () => { throw new Error('IPC unavailable'); }]) {
      window.electronAPI = { openExternal };
      pending = taskHandler.activate({}, uri);
      confirmLink();
      await pending;
      const toast = document.querySelector('.tt-saving-indicator--toast[role="alert"]');
      assert.ok(toast?.textContent.includes('Could not open the link. Please try again.'));
      toast.remove();
    }
    assert.equal(browserOpened.length, 1, 'failed Electron opens do not launch a popup');
  } finally {
    modal?.closeConsoleIfOpen();
    state?.activeTerminal?.detach({ refreshBoard: false, persistCodex: false });
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
