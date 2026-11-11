import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9203) Focus left in .card-btn-group by a mouse click never holds the status/Start row open;
// keyboard focus there and focus on the status select still do. Real task-card.js bundle under
// happy-dom (expansion-restore.test.js's harness). happy-dom has no pointer: `:hover` never matches
// and every focused element matches `:focus-visible`, so a test stubs matches() for each input kind.

let window, scratch, api, app;
const globals = new Map();

function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

before(async () => {
  window = new Window({ url: 'http://localhost:4455/' });
  scratch = mkdtempSync(join(tmpdir(), 'tt-card-controls-focus-'));
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
    'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  // The page's timers as the globals, so happyDOM.abort() also clears the intervals
  // setupCardInteractions() starts (task-merge.js, task-finish.js).
  for (const key of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, window[key].bind(window));
  }
  install('WebSocket', class { constructor() { this.readyState = 0; } send() {} close() {} });
  install('fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    stdin: { contents: `export { default as state } from './src/client/state.js';
      export * as cards from './src/client/task-card.js';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    plugins: [{ name: 'terminal-double', setup(b) {
      b.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
      b.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
        export class FitAddon { fit() {} }
        export class Terminal { loadAddon() {} onData() {} open() {} write() {} dispose() {} }` }));
    } }],
  });
  const bundle = join(scratch, 'client.mjs');
  writeFileSync(bundle, result.outputFiles[0].contents);
  api = await import(pathToFileURL(bundle).href);
});

after(async () => {
  await window.happyDOM.abort();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  api.cards.collapseCard();
  api.state.selectedCardIds.clear();
  document.body.innerHTML = '<div class="container" id="app"></div>';
  app = document.getElementById('app');
  app.innerHTML = '<div class="timeline"><div class="tier" data-priority="1"><div class="tier-cards">'
    + api.cards.renderCard({ id: 'A1', title: 'Task A1', description: 'Body', status: 'pending', category: 'CODING',
      agentAssignee: 'claude', assignee: null, dependencies: [], tags: [], priority: 1, order: 0 })
    + '</div></div></div>';
  api.cards.setupCardInteractions(app);
});

const card = () => app.querySelector('.card[data-id="A1"]');
const rowOpen = () => ['card-peek', 'card-hover-expanded'].filter(name => card().classList.contains(name));

function stubMatches(el, selector, answer) {
  const own = el.matches.bind(el);
  el.matches = wanted => (wanted === selector ? answer : own(wanted));
}

// The button a mouse click leaves focused: active, but not :focus-visible.
function pointerFocus(control) {
  stubMatches(control, ':focus-visible', false);
  stubMatches(card(), ':hover', true); // a click lands under the cursor
  control.focus();
}

function cursorLeaves() {
  stubMatches(card(), ':hover', false);
  card().dispatchEvent(new MouseEvent('mouseleave'));
}

test('a clicked Select does not hold the controls row after the cursor leaves', () => {
  const select = card().querySelector('.btn-select-card');
  pointerFocus(select);
  select.click();
  assert.deepEqual(rowOpen(), ['card-peek', 'card-hover-expanded'], 'open while the cursor is on the card');
  assert.equal(document.activeElement, select, 'a clicked button keeps DOM focus');

  cursorLeaves();
  assert.deepEqual(rowOpen(), []);
  assert.equal(card().classList.contains('selected'), true, 'the selected pill stays');
  assert.equal(select.classList.contains('checked'), true);
});

test('no other button in the action group holds the row either', () => {
  const buttons = [...card().querySelectorAll('.card-action-menu button')];
  assert.ok(buttons.length, 'the rendered card has action buttons');
  for (const button of buttons) {
    pointerFocus(button);
    cursorLeaves();
    assert.deepEqual(rowOpen(), [], button.className);
    button.blur();
  }
});

test('keyboard focus in the action group keeps the row until it moves off the card', () => {
  const select = card().querySelector('.btn-select-card');
  select.focus();
  cursorLeaves();
  assert.deepEqual(rowOpen(), ['card-peek', 'card-hover-expanded']);
  select.blur();
  assert.deepEqual(rowOpen(), []);
});

test('the status select keeps its row while the cursor is off the card', () => {
  const status = card().querySelector('.card-status-select');
  pointerFocus(status);
  cursorLeaves();
  assert.deepEqual(rowOpen(), ['card-peek', 'card-hover-expanded'], 'an open dropdown must not lose its row');
  status.blur();
  assert.deepEqual(rowOpen(), []);
});

test('returning to the window does not reopen the row for a clicked button', () => {
  const select = card().querySelector('.btn-select-card');
  pointerFocus(select);
  cursorLeaves();
  select.blur(); // the window loses focus...
  select.focus(); // ...and hands it back to the same button, cursor elsewhere
  assert.deepEqual(rowOpen(), []);
});
