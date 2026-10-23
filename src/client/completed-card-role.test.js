import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9060) styles.css mutes a completed card's text through `.card[data-status-role="complete"]`.
// renderCard() stamps that role from the project's configured completion status — never the literal
// name — and a live complete or reopen restamps the same node, so the muted look follows at once.
// Real task-card.js + task-board.js bundle under happy-dom (backlog-patch.test.js's harness), with a
// custom status registry whose completion status is "Shipped".

let window, scratch, api, app;
const globals = new Map();
let patchReply = null; // the full row a PATCH answers with, as ws-handlers.js sends it

function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

// "completed" is an ordinary status here: it only shares the legacy completion name.
const STATUSES = [
  { name: 'Backlog', color: 'overlay1', display_order: 0, is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
  { name: 'Doing', color: 'blue', display_order: 1, is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false },
  { name: 'completed', color: 'teal', display_order: 2, is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
  { name: 'Shipped', color: 'green', display_order: 3, is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false },
  { name: 'Dropped', color: 'overlay0', display_order: 4, is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: true },
];

before(async () => {
  window = new Window({ url: 'http://localhost:4455/' });
  scratch = mkdtempSync(join(tmpdir(), 'tt-completed-card-role-'));
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
    'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  // The page's timers as the globals, so happyDOM.abort() also clears the intervals
  // setupCardInteractions() starts (task-merge.js, task-finish.js).
  for (const key of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, window[key].bind(window));
  }
  install('WebSocket', class { constructor() { this.readyState = 0; } send() {} close() {} });
  install('fetch', async (url, opts = {}) => ({
    ok: true, status: 200, json: async () => (opts.method === 'PATCH' && patchReply ? patchReply : {}),
  }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    stdin: { contents: `export { default as state } from './src/client/state.js';
      export * as cards from './src/client/task-card.js';
      export * as board from './src/client/task-board.js';
      export * as registry from './src/client/status-registry.js';`, resolveDir: root },
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
  api.registry.seedStatuses(STATUSES);
});

after(async () => {
  api?.registry.resetStatuses();
  await window.happyDOM.abort();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  api.cards.collapseCard();
  patchReply = null;
  api.state.collapsedTiers.clear();
  api.state.expandedTiers.clear();
  api.state.statusFilter.clear();
  document.body.innerHTML = '<div class="container" id="app"></div>';
  app = document.getElementById('app');
});

function task(id, overrides = {}) {
  return { id, title: `Task ${id}`, description: 'Body with `code` and a [link](https://example.com)', status: 'Backlog',
    category: 'CODING', agentAssignee: 'claude', assignee: null, dependencies: [], tags: ['css'], priority: 1, order: 0, ...overrides };
}

// One sprint tier through the real board renderer, called the way _loadAndRenderImpl() (template.html) calls it.
function mount(tasks) {
  app.innerHTML = api.board.renderBoardContent([1], { 1: tasks }, api.board.sortTier, api.cards.renderCard);
  api.cards.setupCardInteractions(app);
}

const card = id => app.querySelector(`.card[data-id="${id}"]`);
// The selector every completed-card rule in styles.css hangs off.
const muted = id => card(id).matches('.card[data-status-role="complete"]');

// The status confirm, confirmed: the modal's own click handler awaits the PATCH, so wait (bounded)
// until `done()` holds.
async function confirmStatus(taskId, prev, next, done) {
  api.board.showConfirmModal(taskId, prev, next, async () => {});
  document.querySelector('.modal-overlay .btn-confirm').click();
  for (let i = 0; i < 50 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 0));
}

test('the configured completion status, not the literal name, marks a card completed', () => {
  mount([task('A', { status: 'Shipped' }), task('B', { status: 'completed' }), task('C'), task('D', { status: 'Dropped' })]);
  assert.equal(card('A').dataset.statusRole, 'complete');
  assert.ok(muted('A'), 'the completion role gets the muted completed-card styling');
  assert.equal(card('B').dataset.statusRole, 'other', 'a status merely named "completed" is not the completion role');
  assert.equal(muted('B'), false);
  assert.equal(card('C').dataset.statusRole, 'start');
  assert.equal(card('D').dataset.statusRole, 'canceled');
  assert.equal(muted('D'), false, 'canceled cards keep their own treatment');
});

test('completing and reopening through the status confirm restyles the same card at once', async () => {
  // A second open card keeps the sprint from folding when A closes, so A stays in view.
  mount([task('A'), task('Z', { status: 'Doing' })]);
  const node = card('A');
  assert.equal(muted('A'), false);

  patchReply = task('A', { status: 'Shipped' });
  await confirmStatus('A', 'Backlog', 'Shipped', () => node.dataset.statusRole === 'complete');
  assert.equal(card('A'), node, 'patched in place, not re-rendered');
  assert.equal(node.dataset.status, 'Shipped');
  assert.ok(muted('A'));

  patchReply = task('A', { status: 'Backlog' });
  await confirmStatus('A', 'Shipped', 'Backlog', () => node.dataset.statusRole === 'start');
  assert.equal(card('A'), node);
  assert.equal(node.dataset.status, 'Backlog');
  assert.equal(muted('A'), false);
});

test('a task:updated patch completes and reopens the card in place', () => {
  mount([task('A'), task('Z', { status: 'Doing' })]);
  const node = card('A');
  assert.equal(api.cards.applyTaskPatch(task('A', { status: 'Shipped' })), 'patched');
  assert.equal(card('A'), node);
  assert.ok(muted('A'));
  assert.equal(api.cards.applyTaskPatch(task('A', { status: 'Doing' })), 'patched');
  assert.equal(node.dataset.statusRole, 'in-progress');
  assert.equal(muted('A'), false);
});
