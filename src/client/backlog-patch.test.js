import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9034) applyTaskPatch() reads the sprint a card is drawn in off its container, never the
// card's own data-priority: a patch keeps a Backlog-tab or flat-board card in place, a sprint card
// still moves or leaves, and the status confirm never folds the flat board. Real task-card.js +
// task-board.js bundle under happy-dom (expansion-restore.test.js's harness), mounted through the
// views' real renderers so a markup change shows up here too.

let window, scratch, api, app;
const globals = new Map();
let patchReply = null; // the full row a PATCH answers with, as ws-handlers.js sends it

function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

before(async () => {
  window = new Window({ url: 'http://localhost:4455/' });
  scratch = mkdtempSync(join(tmpdir(), 'tt-backlog-patch-'));
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
      export * as board from './src/client/task-board.js';`, resolveDir: root },
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
  patchReply = null;
  api.state.collapsedTiers.clear();
  api.state.expandedTiers.clear();
  api.state.statusFilter.clear();
  document.body.innerHTML = '<div class="container" id="app"></div>';
  app = document.getElementById('app');
});

function task(id, overrides = {}) {
  return { id, title: `Task ${id}`, description: 'Body', status: 'pending', category: 'CODING', agentAssignee: 'claude',
    assignee: null, dependencies: [], tags: [], priority: 1, order: 0, ...overrides };
}
const backlogTask = (id, overrides = {}) => task(id, { priority: 0, ...overrides });

// Each view through its real renderer, called the way _loadAndRenderImpl() (template.html) calls it.
const backlogHtml = tasks => api.board.renderBacklogContent(tasks, api.board.sortTier, api.cards.renderCard);
const flatHtml = tasks => api.board.renderFlatBoardContent(tasks, api.board.sortTier, api.cards.renderCard);
const keysOf = tiers => Object.keys(tiers).map(Number).sort((a, b) => a - b);
const boardHtml = tiers => api.board.renderBoardContent(keysOf(tiers), tiers, api.board.sortTier, api.cards.renderCard);
const listHtml = tiers => api.board.renderListContent(keysOf(tiers), tiers, api.board.sortTier, api.cards.renderCard);
function mount(html) {
  app.innerHTML = html;
  api.cards.setupCardInteractions(app);
}

const card = id => app.querySelector(`.card[data-id="${id}"]`);
const idsIn = selector => [...app.querySelectorAll(`${selector} .card[data-id]`)].map(c => c.dataset.id).sort();
const tier = p => app.querySelector(`.tier[data-priority="${p}"]`);
const hidden = id => card(id).classList.contains('search-hidden');
const backlogCount = () => Number.parseInt(app.querySelector('.backlog-count').textContent, 10); // any locale

// The status confirm, confirmed: the modal's own click handler awaits the PATCH, so wait (bounded)
// until `done()` holds.
async function confirmStatus(taskId, prev, next, { onDone = async () => {}, done }) {
  api.board.showConfirmModal(taskId, prev, next, onDone);
  document.querySelector('.modal-overlay .btn-confirm').click();
  for (let i = 0; i < 50 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 0));
}

test('a status patch keeps a Backlog-tab card in place', () => {
  // B2's backlog signal is the null sprint rather than priority 0.
  mount(backlogHtml([backlogTask('B1'), task('B2', { priority: null, sprint_id: null })]));
  assert.deepEqual(idsIn('.backlog-card-list'), ['B1', 'B2']);
  const node = card('B1');
  assert.equal(api.cards.applyTaskPatch(backlogTask('B1', { status: 'in_progress' })), 'patched');
  assert.ok(card('B1') === node, 'same node, still mounted');
  assert.equal(node.dataset.status, 'in_progress');
  assert.equal(node.querySelector('.card-status-select').dataset.current, 'in_progress');
  assert.equal(api.cards.applyTaskPatch(task('B2', { priority: null, sprint_id: null, status: 'completed' })), 'patched');
  assert.equal(card('B2').dataset.status, 'completed');
  assert.deepEqual(idsIn('.backlog-section .backlog-card-list'), ['B1', 'B2']);
});

test('a flat-board card is patched in place whatever its sprint', () => {
  mount(flatHtml([backlogTask('F0'), task('F3', { priority: 3 }), task('F4', { priority: 4 })]));
  assert.equal(app.querySelector('.tier--flat').hasAttribute('data-priority'), false, 'the flat tier is no sprint');
  assert.equal(api.cards.applyTaskPatch(backlogTask('F0', { status: 'in_progress' })), 'patched');
  assert.equal(card('F0').dataset.status, 'in_progress');
  assert.equal(api.cards.applyTaskPatch(task('F3', { priority: 0 })), 'patched', 'to the backlog: still on the flat board');
  assert.equal(api.cards.applyTaskPatch(task('F4', { priority: 5 })), 'patched', 'another sprint: same');
  assert.equal(card('F3').dataset.priority, '0');
  assert.equal(card('F4').dataset.priority, '5');
  assert.deepEqual(idsIn('.tier--flat .tier-cards'), ['F0', 'F3', 'F4']);
});

test('a payload with no priority and no sprint reloads instead of patching', () => {
  const views = {
    flat: () => mount(flatHtml([task('T1', { priority: 3 })])),
    backlog: () => mount(backlogHtml([backlogTask('T1')])),
    board: () => mount(boardHtml({ 3: [task('T1', { priority: 3 })] })),
  };
  for (const [name, mountView] of Object.entries(views)) {
    mountView();
    // The offline _pendingSync stub of a status write (api-backend.js updateTask()).
    assert.equal(api.cards.applyTaskPatch({ id: 'T1', status: 'in_progress' }), 'reload', name);
    assert.equal(card('T1').dataset.status, 'pending', `${name}: nothing written`);
    assert.equal(card('T1').querySelector('.card-title-inner').textContent, 'Task T1', `${name}: title kept`);
  }
});

test('a Board card patched into the backlog leaves; one patched in place stays', () => {
  mount(boardHtml({ 1: [task('A1'), task('A2')], 2: [task('B1', { priority: 2 })] }));
  assert.equal(api.cards.applyTaskPatch(task('A2', { status: 'in_progress' })), 'patched');
  assert.equal(card('A2').dataset.status, 'in_progress');
  assert.equal(api.cards.applyTaskPatch(task('A1', { priority: 0 })), 'removed');
  assert.equal(card('A1'), null);
  assert.deepEqual(idsIn('.tier[data-priority="1"]'), ['A2']);
});

test('a backlog card that gains a sprint regroups', () => {
  // The app's Backlog tab mounts no sprint tier: the caller's full render takes the card away.
  mount(backlogHtml([backlogTask('B1'), backlogTask('B2')]));
  assert.equal(api.cards.applyTaskPatch(task('B1', { priority: 5 })), 'reload');
  assert.equal(card('B1').dataset.priority, '0', 'untouched until that render');

  // Synthetic: a backlog list next to a mounted sprint, so the kept .backlog-section branch moves it.
  mount(backlogHtml([backlogTask('B1'), backlogTask('B2')]) + boardHtml({ 2: [task('C1', { priority: 2 })] }));
  assert.equal(api.cards.applyTaskPatch(task('B1', { priority: 2 })), 'moved');
  assert.deepEqual(idsIn('.tier[data-priority="2"] .tier-cards'), ['B1', 'C1']);
  assert.equal(card('B1').dataset.priority, '2');
  assert.deepEqual(idsIn('.backlog-card-list'), ['B2']);
});

test('a List-tab card regroups by the list group it is drawn in', () => {
  mount(listHtml({ 1: [task('L1'), task('L2')], 2: [task('M1', { priority: 2 })] }));
  assert.ok(app.querySelector('.list-group[data-priority="1"]'), 'groups carry their sprint');
  assert.equal(api.cards.applyTaskPatch(task('L2', { status: 'in_progress' })), 'patched');
  assert.equal(api.cards.applyTaskPatch(task('L1', { priority: 2 })), 'reload', 'the List has no tier to move into');
  assert.equal(api.cards.applyTaskPatch(task('M1', { priority: 0 })), 'removed', 'the List draws no backlog');
  assert.equal(card('M1'), null);
});

test('the status confirm keeps a backlog card on the Backlog tab', async () => {
  mount(backlogHtml([backlogTask('B1'), backlogTask('B2')]));
  patchReply = backlogTask('B1', { status: 'in_progress' });
  let reloads = 0;
  await confirmStatus('B1', 'pending', 'in_progress', {
    onDone: async () => { reloads++; },
    done: () => card('B1')?.dataset.status === 'in_progress' || reloads > 0,
  });
  assert.equal(card('B1')?.dataset.status, 'in_progress');
  assert.ok(card('B1').closest('.backlog-card-list'));
  assert.deepEqual(idsIn('.backlog-card-list'), ['B1', 'B2']);
  assert.equal(reloads, 0, 'no full render needed');
  assert.equal(hidden('B1'), false, 'no filter: still shown');
  assert.equal(backlogCount(), 2);
});

test('closing the last open card leaves the flat board unfolded', async () => {
  mount(flatHtml([backlogTask('F1', { status: 'completed' }), task('F3', { priority: 3, status: 'in_progress' })]));
  patchReply = task('F3', { priority: 3, status: 'completed' });
  await confirmStatus('F3', 'in_progress', 'completed', { done: () => card('F3')?.dataset.status === 'completed' });
  assert.equal(card('F3').dataset.status, 'completed');
  assert.equal(app.querySelector('.tier--flat').classList.contains('collapsed'), false);
  assert.equal([...api.state.collapsedTiers].some(Number.isNaN), false);
});

test('closing the last open card in a sprint still folds that sprint', async () => {
  mount(boardHtml({ 1: [task('A1', { status: 'completed' }), task('A2')], 2: [task('B1', { priority: 2 })] }));
  assert.equal(tier(1).classList.contains('collapsed'), false);
  patchReply = task('A2', { status: 'completed' });
  await confirmStatus('A2', 'pending', 'completed', { done: () => tier(1).classList.contains('collapsed') });
  assert.equal(tier(1).classList.contains('collapsed'), true);
  assert.equal(api.state.collapsedTiers.has(1), true);
  assert.equal(tier(2).classList.contains('collapsed'), false);
  assert.equal(hidden('A2'), false, 'no filter: still shown');
});

// (TPT9035) The confirm applies the filters to its own patch: the desktop app gets no WS echo of its
// write, so nothing else hides a card that left the selected status until the next poll.
test('the status confirm hides a Board card the status filter no longer matches', async () => {
  api.state.statusFilter.add('pending');
  mount(boardHtml({ 1: [task('A1'), task('A2')], 2: [task('B1', { priority: 2 })] }));
  patchReply = task('A2', { status: 'in_progress' });
  let reloads = 0;
  await confirmStatus('A2', 'pending', 'in_progress', {
    onDone: async () => { reloads++; },
    done: () => card('A2')?.dataset.status === 'in_progress' || reloads > 0,
  });
  assert.equal(reloads, 0, 'no full render needed');
  assert.equal(hidden('A2'), true);
  assert.equal(hidden('A1'), false);
  assert.equal(tier(1).classList.contains('tier--empty'), false);

  // The sprint's last matching card: the sprint hides with it.
  patchReply = task('B1', { priority: 2, status: 'in_progress' });
  await confirmStatus('B1', 'pending', 'in_progress', { done: () => card('B1')?.dataset.status === 'in_progress' });
  assert.equal(hidden('B1'), true);
  assert.equal(tier(2).classList.contains('tier--empty'), true);
});

test('the status confirm hides a Backlog card the status filter no longer matches and recounts', async () => {
  api.state.statusFilter.add('pending');
  mount(backlogHtml([backlogTask('B1'), backlogTask('B2')]));
  assert.equal(backlogCount(), 2);
  patchReply = backlogTask('B1', { status: 'in_progress' });
  await confirmStatus('B1', 'pending', 'in_progress', { done: () => card('B1')?.dataset.status === 'in_progress' });
  assert.equal(hidden('B1'), true);
  assert.equal(hidden('B2'), false);
  assert.equal(backlogCount(), 1);

  patchReply = backlogTask('B2', { status: 'in_progress' });
  await confirmStatus('B2', 'pending', 'in_progress', { done: () => card('B2')?.dataset.status === 'in_progress' });
  assert.equal(backlogCount(), 0);
  assert.equal(app.querySelector('.backlog-card-list').hidden, true);
  assert.equal(app.querySelector('.backlog-empty').hidden, false);
});

test('with no filter the confirmed Board card stays visible', async () => {
  mount(boardHtml({ 1: [task('A1'), task('A2')] }));
  patchReply = task('A2', { status: 'in_progress' });
  await confirmStatus('A2', 'pending', 'in_progress', { done: () => card('A2')?.dataset.status === 'in_progress' });
  assert.equal(hidden('A2'), false);
  assert.equal(tier(1).classList.contains('tier--empty'), false);
});
