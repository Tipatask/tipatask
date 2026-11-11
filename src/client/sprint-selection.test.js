import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9208) Sprint context actions: every nonempty sprint gets a round select-all pill, Start
// lives in the pill's tray, and the pill reads checked only while every shown card of the sprint
// is selected. Pure rules first, then the real renderBoardContent() + setupCardInteractions()
// bundle under happy-dom (expansion-restore.test.js's harness).

let window, scratch, api, app;
const globals = new Map();

function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

before(async () => {
  window = new Window({ url: 'http://localhost:4455/' });
  scratch = mkdtempSync(join(tmpdir(), 'tt-sprint-selection-'));
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
    'FocusEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  for (const key of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, window[key].bind(window));
  }
  install('WebSocket', class { constructor() { this.readyState = 0; } send() {} close() {} });
  install('fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    stdin: { contents: `export { default as state } from './src/client/state.js';
      export * as cards from './src/client/task-card.js';
      export * as board from './src/client/task-board.js';
      export * as selection from './src/client/sprint-selection.js';`, resolveDir: root },
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
  api.state.selectedCardIds.clear();
  api.state.collapsedTiers.clear();
  api.state.expandedTiers.clear();
  document.body.innerHTML = '<div class="container" id="app"></div>';
  app = document.getElementById('app');
});

function task(id, overrides = {}) {
  return { id, title: `Task ${id}`, description: 'Body', status: 'pending', category: 'CODING', agentAssignee: 'claude',
    assignee: null, dependencies: [], tags: [], priority: 1, order: 0, ...overrides };
}

function mount(tiers) {
  const keys = Object.keys(tiers).map(Number);
  api.state.tiers = tiers;
  app.innerHTML = api.board.renderBoardContent(keys, tiers, list => [...list], t => api.cards.renderCard(t));
  api.cards.setupCardInteractions(app);
}

const tier = p => app.querySelector(`.tier[data-priority="${p}"]`);
const pill = p => tier(p).querySelector('.btn-tier-select');
const cardSelect = id => app.querySelector(`.card[data-id="${id}"] .btn-select-card`);
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

test('tierSelectionState() and toggleTierSelection() — all / some / none', () => {
  const { tierSelectionState, toggleTierSelection } = api.selection;
  const sel = new Set(['A']);
  assert.equal(tierSelectionState([], sel), 'none');
  assert.equal(tierSelectionState(['B'], sel), 'none');
  assert.equal(tierSelectionState(['A', 'B'], sel), 'some');
  assert.equal(tierSelectionState(['A'], sel), 'all');
  assert.equal(toggleTierSelection(['A', 'B'], sel), true, 'partial selection completes');
  assert.deepEqual([...sel].sort(), ['A', 'B']);
  assert.equal(toggleTierSelection(['A', 'B'], sel), false, 'full selection clears');
  assert.equal(sel.size, 0);
  assert.equal(toggleTierSelection([], sel), false, 'empty sprint selects nothing');
});

test('every nonempty sprint renders a select-all pill; Start sits in its tray only when startable', () => {
  mount({
    1: [task('A'), task('B')],
    2: [task('C', { status: 'in_progress' }), task('D', { category: 'HUMAN' })],
    3: [],
  });
  assert.ok(pill(1), 'startable sprint has the pill');
  assert.ok(tier(1).querySelector('.tier-actions > .tier-action-menu > .btn-sprint-play'), 'Start lives in the tray');
  assert.ok(pill(2), 'sprint with nothing startable still offers selection');
  assert.equal(tier(2).querySelector('.tier-action-menu'), null, 'no tray without Start');
  assert.equal(tier(3).querySelector('.tier-actions'), null, 'hidden card-less tier draws no actions');
  assert.equal(pill(1).getAttribute('aria-pressed'), 'false');
  assert.match(pill(1).getAttribute('aria-label'), /1/);
});

test('select-all selects the sprint, a second click clears it, and nothing collapses', () => {
  mount({ 1: [task('A'), task('B')], 2: [task('C')] });
  click(pill(1));
  assert.deepEqual([...api.state.selectedCardIds].sort(), ['A', 'B']);
  assert.ok(cardSelect('A').classList.contains('checked'));
  assert.ok(app.querySelector('.card[data-id="B"]').classList.contains('selected'));
  assert.ok(pill(1).classList.contains('checked'));
  assert.equal(pill(1).getAttribute('aria-pressed'), 'true');
  assert.ok(!pill(2).classList.contains('checked'), 'other sprint untouched');
  assert.ok(!tier(1).classList.contains('collapsed'), 'pill click must not fold the sprint');

  click(pill(1));
  assert.equal(api.state.selectedCardIds.size, 0);
  assert.ok(!cardSelect('A').classList.contains('checked'));
  assert.ok(!pill(1).classList.contains('checked'));
  assert.ok(!tier(1).classList.contains('collapsed'));
});

test('unchecking one card unchecks the sprint pill; checking it again re-checks', () => {
  mount({ 1: [task('A'), task('B')] });
  click(pill(1));
  click(cardSelect('A'));
  assert.deepEqual([...api.state.selectedCardIds], ['B']);
  assert.ok(!pill(1).classList.contains('checked'));
  assert.ok(!tier(1).classList.contains('collapsed'));
  // A partial sprint completes on the next pill click rather than clearing.
  click(cardSelect('A'));
  assert.ok(pill(1).classList.contains('checked'), 'selecting every card individually checks the pill');
});

test('filtered-out cards are not selected and do not hold the pill unchecked', () => {
  mount({ 1: [task('A'), task('B')] });
  app.querySelector('.card[data-id="B"]').classList.add('search-hidden');
  click(pill(1));
  assert.deepEqual([...api.state.selectedCardIds], ['A']);
  assert.ok(pill(1).classList.contains('checked'));
  app.querySelector('.card[data-id="A"]').classList.add('search-hidden');
  api.selection.syncTierSelectAll(app);
  assert.ok(pill(1).disabled, 'a sprint with every card filtered out has nothing to select');
});

test('updateBulkActionBar() re-syncs the pill after an outside selection change', () => {
  mount({ 1: [task('A'), task('B')] });
  click(pill(1));
  api.board.clearBulkSelection();
  assert.ok(!pill(1).classList.contains('checked'));
  api.state.selectedCardIds.add('A'); api.state.selectedCardIds.add('B');
  api.board.updateBulkActionBar();
  assert.ok(pill(1).classList.contains('checked'));
});

test('Start still runs from the tray without folding the sprint; Escape dismisses the tray', async () => {
  mount({ 1: [task('A', { agentAssignee: 'human' })] });
  const start = tier(1).querySelector('.btn-sprint-play');
  click(start);
  assert.equal(start.disabled, true, 'Start handler ran (disables itself)');
  assert.ok(!tier(1).classList.contains('collapsed'));

  const group = tier(1).querySelector('.tier-actions');
  start.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(group.classList.contains('is-dismissed'));
  assert.equal(document.activeElement, pill(1), 'focus returns to the pill');
  group.dispatchEvent(new window.PointerEvent('pointerleave'));
  assert.ok(!group.classList.contains('is-dismissed'), 'leaving the group re-arms the tray');
});

test('styles: tray opens on hover/keyboard focus unless dismissed; keyboard-hidden when closed', () => {
  const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
  assert.match(css, /\.tier-actions:not\(\.is-dismissed\):hover \.tier-action-menu,\s*\.tier-actions:not\(\.is-dismissed\):has\(:focus-visible\) \.tier-action-menu \{/);
  const menu = css.slice(css.indexOf('  .tier-action-menu {'), css.indexOf('}', css.indexOf('  .tier-action-menu {')));
  assert.match(menu, /visibility: hidden;/, 'closed tray keeps Start out of the Tab order');
  assert.match(css, /\.btn-tier-select\.checked \.select-dot \{/);
});
