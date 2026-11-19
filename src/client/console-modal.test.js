import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// Real @xterm/xterm, not a double: the links are found in rendered terminal output by xterm's
// own Linkifier, activated by mouse events on the terminal screen, and must reach the external
// opener (window.electronAPI.openExternal) exactly as printed.
const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
const COLS = 40;

test('terminal links in rendered xterm output open through the confirmed platform opener', async (t) => {
  const window = new Window({ url: 'http://127.0.0.1:4455/todo.html' });
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
  // happy-dom has no layout. xterm measures its cell from the char-measure element (32 'W's)
  // and maps a mouse event to a cell through the screen's rect and padding.
  for (const [name, size] of [['offsetWidth', CELL_WIDTH * 32], ['offsetHeight', CELL_HEIGHT]]) {
    Object.defineProperty(window.HTMLElement.prototype, name, {
      configurable: true,
      get() { return this.classList?.contains('xterm-char-measure-element') ? size : 0; },
    });
  }
  window.confirm = () => assert.fail('native confirmation must never run');
  const opened = [];
  const browserOpened = [];
  const electronAPI = { openExternal: async uri => { opened.push(uri); return { ok: true }; } };
  window.electronAPI = electronAPI;
  window.open = (...args) => { browserOpened.push(args); };
  let state, modal;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export { default as state } from './src/client/state.js';
        export * as modal from './src/client/console-modal.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    });
    const bundle = join(scratch, 'client.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    ({ state, modal } = await import(pathToFileURL(bundle).href));
    const until = async (predicate, what) => {
      for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail(`${what} did not happen`);
    };
    document.body.innerHTML = '<div id="app"></div><div id="active-sessions-list"></div>';
    // A browser computes 0px for the screen's unset padding; happy-dom leaves it empty.
    document.head.insertAdjacentHTML('beforeend', '<style>.xterm-screen { padding: 0px; }</style>');

    const dialog = () => document.querySelector('.modal-overlay--over-terminal');
    const confirmLink = () => dialog().querySelector('.btn-confirm').click();
    const cancelLink = () => dialog().querySelector('.btn-cancel').click();
    const print = async (term, output) => {
      term.reset();
      await new Promise(resolve => term.write(output, resolve));
    };
    const rowText = (term, row) => term.buffer.active.getLine(row - 1)?.translateToString(true) ?? '';
    const rowOf = (term, needle) => {
      for (let row = 1; row <= term.rows; row++) if (rowText(term, row).includes(needle)) return row;
      return assert.fail(`no row shows ${needle}`);
    };
    // A plain left click as xterm's Linkifier sees it: hover the cell, then mouse down and up on
    // it. Each click first hovers the empty bottom row, so the hovered link is looked up afresh.
    const click = (term, col, row) => {
      const screen = term.element.querySelector('.xterm-screen');
      const fire = (type, x, y) => screen.dispatchEvent(new window.MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, buttons: type === 'mousedown' ? 1 : 0,
        clientX: (x - 0.5) * CELL_WIDTH, clientY: (y - 0.5) * CELL_HEIGHT,
      }));
      fire('mousemove', term.cols, term.rows);
      fire('mousemove', col, row);
      fire('mousedown', col, row);
      fire('mouseup', col, row);
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    // Click, check the confirmation shows the exact destination, confirm, and wait for the opener.
    const openAt = async (term, col, row, uri) => {
      const before = opened.length;
      click(term, col, row);
      assert.ok(dialog(), `a confirmation opens for ${uri}`);
      assert.ok(dialog().textContent.includes(uri), 'confirmation shows the exact destination');
      assert.equal(opened.length, before, 'opening waits for confirmation');
      confirmLink();
      await until(() => opened.length > before, 'opening');
      await settle();
      assert.equal(dialog(), null);
      return opened.slice(before);
    };

    modal.openTerminal('LINK-PROBE', 'Terminal links', '', 'in_progress');
    await until(() => state.activeTerminal?.term.element, 'task terminal mount');
    const taskTerm = state.activeTerminal.term;
    taskTerm.resize(COLS, 12);
    assert.equal(taskTerm.options.linkHandler.allowNonHttpProtocols, true, 'mailto reaches the scheme allowlist');

    const url = 'https://photoassistant.net/dashboard/database?tab=all&next=%2Fdb#tables';

    await t.test('a plain URL wrapped across rows opens intact, once, from either row', async () => {
      await print(taskTerm, `Dashboard: ${url} (ok)\r\n`);
      const first = rowOf(taskTerm, 'Dashboard:');
      assert.equal(taskTerm.buffer.active.getLine(first).isWrapped, true, 'the URL soft-wraps');
      assert.deepEqual(await openAt(taskTerm, 20, first, url), [url]);
      assert.deepEqual(await openAt(taskTerm, 5, first + 1, url), [url]);
      assert.deepEqual(await openAt(taskTerm, 2, first + 2, url), [url]);
      click(taskTerm, 3, first);
      assert.equal(dialog(), null, 'text before the URL is not a link');
    });

    await t.test('an OSC 8 hyperlink wrapped across rows opens its exact target', async () => {
      const target = 'https://example.com/report?id=42&view=full#summary';
      await print(taskTerm, `\x1b]8;;${target}\x1b\\${'Open the full quarterly report. '.repeat(2)}\x1b]8;;\x1b\\\r\n`);
      const first = rowOf(taskTerm, 'Open the full');
      assert.equal(taskTerm.buffer.active.getLine(first).isWrapped, true, 'the link text soft-wraps');
      assert.deepEqual(await openAt(taskTerm, 2, first, target), [target]);
      assert.deepEqual(await openAt(taskTerm, 10, first + 1, target), [target]);
      const mail = 'mailto:hello@example.com?subject=Hello%20there';
      await print(taskTerm, `\x1b]8;;${mail}\x07write to us\x1b]8;;\x07\r\n`);
      assert.deepEqual(await openAt(taskTerm, 3, rowOf(taskTerm, 'write to us'), mail), [mail]);
    });

    await t.test('a repeated click while confirming keeps one dialog and opens once', async () => {
      await print(taskTerm, `${url}\r\n`);
      const row = rowOf(taskTerm, 'https://photo');
      const before = opened.length;
      click(taskTerm, 4, row);
      click(taskTerm, 6, row);
      click(taskTerm, 4, row + 1);
      assert.equal(document.querySelectorAll('[role="alertdialog"]').length, 1, 'repeat click keeps one dialog');
      confirmLink();
      await until(() => opened.length > before, 'opening');
      await settle();
      assert.deepEqual(opened.slice(before), [url]);
    });

    await t.test('Cancel opens nothing', async () => {
      await print(taskTerm, `${url}\r\n`);
      const before = opened.length;
      click(taskTerm, 4, rowOf(taskTerm, 'https://photo'));
      assert.ok(dialog());
      cancelLink();
      await settle();
      assert.equal(dialog(), null);
      assert.equal(opened.length, before, 'cancel opens nothing');
      assert.deepEqual(browserOpened, []);
    });

    await t.test('disallowed schemes and malformed targets never reach the opener', async () => {
      const before = opened.length;
      const targets = ['javascript:alert(1)', 'file:///tmp/data', 'data:text/html,test', 'ftp://example.com',
        'vscode://file/tmp/data', '/relative', 'not a URL', 'https://', ' https://example.com'];
      await print(taskTerm, targets.map((target, i) => `\x1b]8;;${target}\x07osc-link-${i}\x1b]8;;\x07\r\n`).join(''));
      for (let i = 0; i < targets.length; i++) {
        click(taskTerm, 3, rowOf(taskTerm, `osc-link-${i}`));
        await settle();
        assert.equal(dialog(), null, `rejected OSC 8 target: ${targets[i]}`);
      }
      await print(taskTerm, 'ftp://example.com/x javascript:alert(1)\r\nfile:///etc/passwd vscode://file/x\r\n');
      for (const [col, row] of [[3, 1], [25, 1], [3, 2], [22, 2]]) {
        click(taskTerm, col, row);
        await settle();
        assert.equal(dialog(), null, `plain text at ${col}:${row} is not a link`);
      }
      assert.equal(opened.length, before);
      assert.deepEqual(browserOpened, []);
    });

    await t.test('the destination is escaped before rendering', async () => {
      const escapedUri = 'https://example.com/?q=<img src=x onerror=alert(1)>&value="quoted"';
      await print(taskTerm, `\x1b]8;;${escapedUri}\x07tricky link\x1b]8;;\x07\r\n`);
      click(taskTerm, 3, rowOf(taskTerm, 'tricky link'));
      assert.ok(dialog().textContent.includes(escapedUri));
      assert.equal(dialog().querySelector('img'), null, 'destination is escaped before rendering');
      cancelLink();
      await settle();
    });

    await t.test('a failed or unavailable launcher shows an error toast', async () => {
      await print(taskTerm, `${url}\r\n`);
      const row = rowOf(taskTerm, 'https://photo');
      for (const openExternal of [async () => ({ ok: false, error: 'open_failed' }), async () => { throw new Error('IPC unavailable'); }]) {
        window.electronAPI = { openExternal };
        click(taskTerm, 4, row);
        confirmLink();
        await until(() => document.querySelector('.tt-saving-indicator--toast[role="alert"]'), 'error toast');
        const toast = document.querySelector('.tt-saving-indicator--toast[role="alert"]');
        assert.ok(toast.textContent.includes('Could not open the link. Please try again.'));
        toast.remove();
      }
      assert.deepEqual(browserOpened, [], 'failed Electron opens do not launch a popup');
      window.electronAPI = electronAPI;
    });

    await t.test('browser mode opens a new tab without an opener', async () => {
      delete window.electronAPI;
      await print(taskTerm, `${url}\r\n`);
      click(taskTerm, 4, rowOf(taskTerm, 'https://photo'));
      confirmLink();
      await until(() => browserOpened.length, 'browser open');
      assert.deepEqual(browserOpened, [[url, '_blank', 'noopener,noreferrer']]);
      window.electronAPI = electronAPI;
    });

    state.activeTerminal.detach({ refreshBoard: false, persistCodex: false });

    await t.test('the objective console routes both link forms through the same opener', async () => {
      state.chatState = { processExited: true };
      modal.openObjectiveConsole();
      await until(() => state.chatState.term?.element, 'objective console mount');
      const objectiveTerm = state.chatState.term;
      objectiveTerm.resize(COLS, 12);
      assert.equal(objectiveTerm.options.linkHandler.allowNonHttpProtocols, true);
      await print(objectiveTerm, `see ${url}\r\n\x1b]8;;https://example.com/osc?x=1#y\x07OSC LINK\x1b]8;;\x07\r\n`);
      const see = rowOf(objectiveTerm, 'see https');
      assert.deepEqual(await openAt(objectiveTerm, 6, see, url), [url]);
      assert.deepEqual(await openAt(objectiveTerm, 3, see + 1, url), [url]);
      const target = 'https://example.com/osc?x=1#y';
      assert.deepEqual(await openAt(objectiveTerm, 3, rowOf(objectiveTerm, 'OSC LINK'), target), [target]);
      assert.deepEqual(browserOpened, [[url, '_blank', 'noopener,noreferrer']], 'Electron never falls back to a renderer popup');
    });
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
