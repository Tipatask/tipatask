import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9023) A full board re-render keeps an expanded card open and the page still. (TPT9024) So
// does an in-place patch, sprint move or removal: the open card stays on its live slot or closes
// cleanly. Real task-card.js bundle under happy-dom (drag-freeze.test.js's harness). happy-dom has
// no layout: elementFromPoint() answers null and every rect is zero, so a test that needs the
// pointer over a card or a slot position stubs it, and template.html's inline wiring is pinned by
// the source scans at the end of this file.

let window, scratch, api, app;
const globals = new Map();

function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

before(async () => {
  window = new Window({ url: 'http://localhost:4455/' });
  scratch = mkdtempSync(join(tmpdir(), 'tt-expansion-restore-'));
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
      export * as cards from './src/client/task-card.js';
      export * as board from './src/client/task-board.js';
      export * as utils from './src/client/utils.js';`, resolveDir: root },
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
  api.state.selectedCardId = null;
  api.state.chainHighlightedTaskId = null;
  api.state.collapsedTiers.clear();
  api.state.expandedTiers.clear();
  delete document.elementFromPoint; // back to happy-dom's own (always null)
  document.body.innerHTML = '<div class="container" id="app"></div>';
  app = document.getElementById('app');
});

function task(id, overrides = {}) {
  return { id, title: `Task ${id}`, description: 'Body', status: 'pending', category: 'CODING', agentAssignee: 'claude',
    assignee: null, dependencies: [], tags: [], priority: 1, order: 0, ...overrides };
}

// Same markup shape as renderBoardContent(), written into the one #app node every render reuses —
// the body-level backdrop survives a rebuild exactly as it does in the app.
function render(tasks, { collapsed = false } = {}) {
  app.innerHTML = `<div class="timeline"><div class="tier${collapsed ? ' collapsed' : ''}" data-priority="1">`
    + '<div class="tier-label" data-priority="1">Sprint 1</div>'
    + `<div class="tier-cards">${tasks.map(t => api.cards.renderCard(t)).join('')}</div></div></div>`;
  api.cards.setupCardInteractions(app);
}

// _loadAndRenderImpl()'s order: snapshot + close right before the #app commit, re-open after the tail.
function rerender(tasks, opts) {
  const snapshot = api.cards.takeExpandedCard(app);
  render(tasks, opts);
  return snapshot ? api.cards.restoreExpandedCard(app, snapshot) : null;
}

const card = id => app.querySelector(`.card[data-id="${id}"]`);
const desc = id => card(id).querySelector(':scope > .card-desc');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const frames = n => new Promise(resolve => {
  const step = left => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
  step(n);
});

// The pointer rests on card `id`: a tracked mousemove records its position, and the hit test
// answers with whichever node currently carries that id.
function pointAt(id) {
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 40 }));
  document.elementFromPoint = () => app.querySelector(`.card[data-id="${id}"] > .card-desc`);
}

// Several sprints, same markup as renderBoardContent() (drag-freeze.test.js's mountBoard()).
function mountBoard(tiers, { collapsed = [] } = {}) {
  app.innerHTML = '<div class="timeline">' + Object.keys(tiers).map(Number).sort((a, b) => a - b).map(p => {
    const list = tiers[p];
    return `<div class="tier${list.length ? '' : ' tier--empty'}${collapsed.includes(p) ? ' collapsed' : ''}" data-priority="${p}">`
      + `<div class="tier-label" data-priority="${p}">Sprint ${p}</div>`
      + `<div class="tier-cards">${list.map(t => api.cards.renderCard(t)).join('')}`
      + '<div class="tier-drop-sentinel" aria-hidden="true"></div></div></div>';
  }).join('') + '</div>';
  api.cards.setupCardInteractions(app);
}

const tier = p => app.querySelector(`.tier[data-priority="${p}"]`);
const tierCards = p => tier(p).querySelector('.tier-cards');
const idsIn = p => [...tierCards(p).querySelectorAll('.card[data-id]')].map(c => c.dataset.id);
const slotsIn = p => [...tierCards(p).children]
  .filter(el => !el.classList.contains('tier-drop-sentinel'))
  .map(el => (el.classList.contains('card-placeholder') ? 'placeholder' : el.dataset.id));

// Where a placeholder's slot sits on screen — placeExpanded() reads it on every run.
function stubRect(el, { top, left }) {
  el.getBoundingClientRect = () => ({ top, left, width: 252, height: 90, right: left + 252, bottom: top + 90, x: left, y: top });
}

// The scroll/resize listeners `action` adds to the window — the overlay's placement listeners.
function windowListenersAddedBy(action) {
  const added = [];
  const own = Object.getOwnPropertyDescriptor(window, 'addEventListener');
  const original = window.addEventListener;
  Object.defineProperty(window, 'addEventListener', {
    configurable: true, writable: true,
    value(type, ...rest) { added.push(type); return original.call(this, type, ...rest); },
  });
  try {
    action();
  } finally {
    if (own) Object.defineProperty(window, 'addEventListener', own);
    else delete window.addEventListener;
  }
  return added.filter(type => type === 'scroll' || type === 'resize').length;
}

test('expandCard records the board card behind the overlay and collapseCard clears it', () => {
  render([task('A1')]);
  api.cards.expandCard(card('A1'), 'hover');
  assert.equal(api.state.expandedCardId, 'A1');
  assert.equal(api.state.expandedCardMode, 'hover');
  api.cards.collapseCard();
  assert.equal(api.state.expandedCardId, null);
  assert.equal(api.state.expandedCardMode, null);
});

test('a preview card sets the mode but never the id a re-render restores', () => {
  app.innerHTML = api.cards.renderCard(task('P1'), { preview: true });
  api.cards.expandCard(app.querySelector('.card--preview'), 'pinned');
  assert.equal(api.state.expandedCardMode, 'pinned');
  assert.equal(api.state.expandedCardId, null);
  assert.equal(api.cards.takeExpandedCard(app), null, 'no snapshot for a preview');
  assert.equal(app.querySelector('.card-expanded'), null, 'its overlay is still closed before the rebuild');
  assert.equal(document.querySelector('.card-overlay-backdrop'), null);
});

test('an instant expansion holds transitions off until a frame has painted', async () => {
  render([task('A1')]);
  api.cards.expandCard(card('A1'), 'hover', { instant: true });
  assert.equal(card('A1').classList.contains('no-transition'), true);
  await frames(3);
  assert.equal(card('A1').classList.contains('no-transition'), false);
  api.cards.collapseCard();
  api.cards.expandCard(card('A1'), 'hover');
  assert.equal(card('A1').classList.contains('no-transition'), false, 'a normal expansion still animates');
});

test('a second skip extends the no-transition window instead of being cut short by the first', async () => {
  const el = document.createElement('div');
  api.utils.skipTransitionsForFrame(el);
  await frames(1);
  api.utils.skipTransitionsForFrame(el);
  await frames(1); // the first call's second frame has run
  assert.equal(el.classList.contains('no-transition'), true);
  await frames(3);
  assert.equal(el.classList.contains('no-transition'), false);
});

test('expandCard ignores a card a render has since replaced', () => {
  render([task('A1'), task('A2')]);
  const stale = card('A2');
  api.cards.expandCard(card('A1'), 'hover');
  stale.remove();
  api.cards.expandCard(stale, 'hover');
  assert.equal(card('A1').classList.contains('card-expanded'), true, 'the open overlay stays');
  assert.equal(api.state.expandedCardId, 'A1');
});

test('takeExpandedCard snapshots the open board card and closes its overlay', () => {
  render([task('A1')]);
  api.cards.expandCard(card('A1'), 'pinned');
  api.state.selectedCardId = 'A1';
  desc('A1').scrollTop = 37;
  assert.ok(document.querySelector('.card-overlay-backdrop'));
  const snapshot = api.cards.takeExpandedCard(app);
  assert.deepEqual(snapshot, { id: 'A1', mode: 'pinned', selected: true, descScrollTop: 37 });
  assert.equal(app.querySelector('.card-expanded'), null);
  assert.equal(document.querySelector('.card-overlay-backdrop'), null, 'no backdrop outlives the node');
  assert.equal(api.state.expandedCardId, null);
  assert.equal(api.cards.takeExpandedCard(app), null, 'nothing open, nothing to take');
});

test('a pinned card comes back open, selected and ringed, with its description scrolled', () => {
  const tasks = [task('A1', { dependencies: ['A2'] }), task('A2')];
  render(tasks);
  api.cards.expandCard(card('A1'), 'pinned');
  api.state.selectedCardId = 'A1';
  desc('A1').scrollTop = 24;
  assert.equal(rerender(tasks), true);
  assert.equal(card('A1').classList.contains('card-expanded'), true);
  assert.equal(card('A1').classList.contains('no-transition'), true, 're-opened in its final state');
  assert.equal(document.querySelectorAll('.card-overlay-backdrop').length, 1);
  assert.equal(api.state.expandedCardMode, 'pinned');
  assert.equal(api.state.expandedCardId, 'A1');
  assert.equal(api.state.selectedCardId, 'A1');
  assert.equal(card('A1').classList.contains('chain-hl'), true);
  assert.equal(card('A2').classList.contains('chain-hl'), true, 'dependency ring re-applied');
  assert.equal(desc('A1').scrollTop, 24);
});

test('a pinned card under a chain highlight leaves the rings to the chain', () => {
  const tasks = [task('A1', { dependencies: ['A2'] }), task('A2')];
  render(tasks);
  api.cards.expandCard(card('A1'), 'pinned');
  api.state.selectedCardId = 'A1';
  api.state.chainHighlightedTaskId = 'A1'; // what the render's chain restore re-applied
  assert.equal(rerender(tasks), true);
  assert.equal(card('A1').classList.contains('card-expanded'), true);
  assert.equal(card('A2').classList.contains('chain-hl'), false);
});

test('a hover card is kept only while the pointer is over its re-opened overlay', () => {
  render([task('A1')]);
  api.cards.expandCard(card('A1'), 'hover');
  assert.equal(rerender([task('A1')]), false, 'the pointer is elsewhere');
  assert.equal(app.querySelector('.card-expanded'), null);
  assert.equal(api.state.expandedCardMode, null);

  pointAt('A1');
  api.cards.expandCard(card('A1'), 'hover');
  assert.equal(rerender([task('A1')]), true);
  assert.equal(card('A1').classList.contains('card-expanded'), true);
  assert.equal(api.state.expandedCardMode, 'hover');
  assert.equal(card('A1').classList.contains('chain-hl'), true, 'hover rings, as mouseenter put them');
  // A second rebuild before the browser's hover pass would have read :hover as false.
  assert.equal(rerender([task('A1')]), true);
  assert.equal(card('A1').classList.contains('card-expanded'), true);
});

test('a card in a collapsed tier or hidden by a filter is not re-opened', () => {
  render([task('A1')]);
  api.cards.expandCard(card('A1'), 'pinned');
  assert.equal(rerender([task('A1')], { collapsed: true }), false);
  assert.equal(app.querySelector('.card-expanded'), null);
  assert.equal(document.querySelector('.card-overlay-backdrop'), null, 'no orphaned backdrop or scroll lock');

  render([task('A1')]);
  api.cards.expandCard(card('A1'), 'pinned');
  const snapshot = api.cards.takeExpandedCard(app);
  render([task('A1')]);
  card('A1').classList.add('search-hidden');
  assert.equal(api.cards.restoreExpandedCard(app, snapshot), false);
  assert.equal(app.querySelector('.card-expanded'), null);
});

test('the hover timer never re-expands a card a rebuild re-opened under the pointer', async () => {
  render([task('A1')]);
  pointAt('A1');
  api.cards.expandCard(card('A1'), 'hover');
  rerender([task('A1')]);
  const placeholder = card('A1').previousElementSibling;
  assert.equal(placeholder?.classList.contains('card-placeholder'), true);
  card('A1').dispatchEvent(new MouseEvent('mouseenter')); // the browser's hover pass on the new node
  card('A1').dispatchEvent(new MouseEvent('mouseleave'));
  card('A1').dispatchEvent(new MouseEvent('mouseenter')); // back inside the 200 ms collapse delay
  await sleep(320);
  assert.equal(card('A1').classList.contains('card-expanded'), true);
  assert.equal(card('A1').previousElementSibling, placeholder, 'same overlay, never collapsed and re-opened');
});

test('a hover timer left on a replaced node cannot close the re-opened card', async () => {
  render([task('A1')]);
  pointAt('A1');
  api.cards.expandCard(card('A1'), 'hover');
  card('A1').dispatchEvent(new MouseEvent('mouseenter')); // arms the 250 ms timer on this node
  assert.equal(rerender([task('A1')]), true);
  await sleep(320);
  assert.equal(card('A1').classList.contains('card-expanded'), true);
  assert.equal(api.state.expandedCardId, 'A1');
});

// ── (TPT9024) In-place patches, sprint moves and removals ──

test('an in-place patch leaves an open card as it was: same node, placeholder and listeners', () => {
  for (const mode of ['pinned', 'hover']) {
    render([task('A1'), task('A2')]);
    assert.equal(windowListenersAddedBy(() => api.cards.expandCard(card('A1'), mode)), 2, 'scroll + resize, armed once');
    const node = card('A1');
    const placeholder = node.previousElementSibling;
    desc('A1').scrollTop = 30;
    const added = windowListenersAddedBy(() => {
      const patched = task('A1', { status: 'in_progress', title: 'Renamed', description: 'New body' });
      assert.equal(api.cards.applyTaskPatch(patched), 'patched');
    });
    assert.equal(added, 0, `${mode}: the patch re-arms nothing`);
    assert.ok(card('A1') === node, `${mode}: same node`);
    assert.equal(node.classList.contains('card-expanded'), true);
    assert.equal(node.querySelector('.card-title-inner').textContent, 'Renamed', 'the fields did patch');
    assert.ok(node.previousElementSibling === placeholder, 'same placeholder');
    assert.equal(app.querySelectorAll('.card-placeholder').length, 1);
    assert.equal(api.state.expandedCardId, 'A1');
    assert.equal(api.state.expandedCardMode, mode, 'a hover card needs no pointer check: nothing moved');
    assert.equal(document.querySelectorAll('.card-overlay-backdrop').length, mode === 'pinned' ? 1 : 0);
    assert.equal(desc('A1').scrollTop, 30);
    api.cards.collapseCard();
  }
});

test('a sprint move carries the open card\'s placeholder and re-anchors the overlay to it', () => {
  mountBoard({ 1: [task('A1'), task('A2')], 2: [task('B1', { priority: 2 })] });
  api.cards.expandCard(card('A1'), 'pinned');
  const placeholder = card('A1').previousElementSibling;
  const source = tierCards(1);
  assert.notEqual(source.style.minHeight, '', 'expandCard() froze the sprint it opened in');
  stubRect(placeholder, { top: 120, left: 300 });
  const added = windowListenersAddedBy(() => {
    assert.equal(api.cards.applyTaskPatch(task('A1', { priority: 2 })), 'moved');
  });
  assert.equal(added, 0);
  assert.equal(card('A1').classList.contains('card-expanded'), true);
  assert.deepEqual(slotsIn(2), ['placeholder', 'A1', 'B1'], 'carried, still right in front of its card');
  assert.ok(card('A1').previousElementSibling === placeholder, 'the same placeholder node');
  assert.deepEqual(slotsIn(1), ['A2'], 'no ghost slot left behind');
  assert.equal(source.style.minHeight, '', 'the old freeze is released');
  assert.equal(tierCards(2).style.minHeight, '', 'and none is set on the new sprint');
  assert.equal(card('A1').style.left, '300px', 'placed on the carried slot');
  assert.equal(card('A1').style.top, '120px');
  assert.equal(document.querySelectorAll('.card-overlay-backdrop').length, 1);
  api.cards.collapseCard();
  assert.equal(document.querySelectorAll('.card-placeholder').length, 0);
  assert.deepEqual(idsIn(2), ['A1', 'B1']);
});

test('a move that empties the sprint behind it still places the overlay from the carried slot', () => {
  mountBoard({ 1: [task('A1')], 2: [task('B1', { priority: 2 })] });
  api.cards.expandCard(card('A1'), 'pinned');
  stubRect(card('A1').previousElementSibling, { top: 140, left: 40 });
  assert.equal(api.cards.regroupCardToSprint('A1', 2, false), 'emptied');
  assert.equal(tier(1).classList.contains('tier--empty'), true);
  assert.deepEqual(slotsIn(2), ['placeholder', 'A1', 'B1']);
  assert.equal(card('A1').style.top, '140px', 'not the hidden sprint\'s zero rect');
  assert.equal(card('A1').style.left, '40px');
  assert.equal(card('A1').classList.contains('card-expanded'), true);
});

test('a hover card a move carries out from under the pointer closes; one still under it follows', () => {
  mountBoard({ 1: [task('A1'), task('A2')], 2: [task('B1', { priority: 2 })] });
  api.cards.expandCard(card('A1'), 'hover');
  assert.equal(api.cards.regroupCardToSprint('A1', 2, false), 'moved');
  assert.equal(card('A1').classList.contains('card-expanded'), false, 'the pointer is elsewhere');
  assert.equal(api.state.expandedCardMode, null);
  assert.equal(document.querySelectorAll('.card-placeholder').length, 0);

  pointAt('A1');
  api.cards.expandCard(card('A1'), 'hover');
  assert.equal(api.cards.regroupCardToSprint('A1', 1, false), 'moved');
  assert.equal(card('A1').classList.contains('card-expanded'), true);
  assert.deepEqual(slotsIn(1), ['placeholder', 'A1', 'A2']);
});

test('a card moved to the top of a sprint lands ahead of the open first card and its placeholder', () => {
  mountBoard({ 1: [task('A1')], 2: [task('B1', { priority: 2 }), task('B2', { priority: 2 })] });
  api.cards.expandCard(card('B1'), 'pinned');
  assert.equal(api.cards.regroupCardToSprint('A1', 2, false), 'emptied');
  assert.deepEqual(slotsIn(2), ['A1', 'placeholder', 'B1', 'B2']);
  assert.equal(card('B1').classList.contains('card-expanded'), true);
  api.cards.collapseCard();
  assert.equal(document.querySelectorAll('.card-placeholder').length, 0, 'collapse found it: no ghost slot');
  assert.deepEqual(idsIn(2), ['A1', 'B1', 'B2']);
});

test('an open card moved into a folded sprint unfolds it at once; a plain move still animates', async () => {
  const tiers = () => ({ 1: [task('A1'), task('A2')], 2: [task('B1', { priority: 2, status: 'completed' })] });
  mountBoard(tiers(), { collapsed: [2] });
  api.cards.expandCard(card('A1'), 'pinned');
  assert.equal(api.cards.regroupCardToSprint('A1', 2, false), 'moved');
  assert.equal(tier(2).classList.contains('collapsed'), false);
  assert.equal(tier(2).classList.contains('no-transition'), true, 'no fade under the backdrop');
  assert.equal(card('A1').classList.contains('card-expanded'), true);
  await frames(3);
  assert.equal(tier(2).classList.contains('no-transition'), false);

  api.cards.collapseCard();
  mountBoard(tiers(), { collapsed: [2] });
  assert.equal(api.cards.regroupCardToSprint('A2', 2, false), 'moved');
  assert.equal(tier(2).classList.contains('collapsed'), false);
  assert.equal(tier(2).classList.contains('no-transition'), false);
});

test('an open card patched off the board closes cleanly: no placeholder, backdrop or scroll lock', () => {
  const leaves = {
    'backlog move': () => assert.equal(api.cards.applyTaskPatch(task('A1', { priority: 0 })), 'removed'),
    'task:deleted': () => assert.equal(api.cards.removeCardFromDom('A1'), true),
  };
  for (const [name, leave] of Object.entries(leaves)) {
    mountBoard({ 1: [task('A1'), task('A2')] });
    api.cards.expandCard(card('A1'), 'pinned');
    api.state.selectedCardId = 'A1';
    assert.equal(document.documentElement.style.overflowY, 'hidden');
    leave();
    assert.ok(!card('A1'), `${name}: off the board`);
    assert.equal(document.querySelectorAll('.card-placeholder').length, 0, `${name}: placeholder`);
    assert.equal(document.querySelectorAll('.card-overlay-backdrop').length, 0, `${name}: backdrop`);
    assert.equal(document.documentElement.style.overflowY, '', `${name}: page scroll unlocked`);
    assert.equal(tierCards(1).style.minHeight, '', `${name}: freeze released`);
    assert.equal(api.state.expandedCardMode, null);
    assert.equal(api.state.expandedCardId, null);
    assert.equal(api.state.selectedCardId, null);
  }
});

test('removing another card re-anchors the open overlay to its shifted slot', () => {
  mountBoard({ 1: [task('A1'), task('A2')] });
  api.cards.expandCard(card('A2'), 'pinned');
  stubRect(card('A2').previousElementSibling, { top: 200, left: 20 }); // where the slot is once A1 goes
  assert.equal(api.cards.removeCardFromDom('A1'), true);
  assert.equal(card('A2').style.left, '20px');
  assert.equal(card('A2').style.top, '200px');
  assert.equal(card('A2').classList.contains('card-expanded'), true);
});

test('the filter pass closes an open card its sprint fold or a filter hides', () => {
  mountBoard({ 1: [task('A1', { status: 'completed' }), task('A2')], 2: [task('B1', { priority: 2 })] });
  api.cards.expandCard(card('A2'), 'pinned');
  api.state.selectedCardId = 'A2';
  assert.equal(api.cards.applyTaskPatch(task('A2', { status: 'completed' })), 'patched');
  assert.equal(card('A2').classList.contains('card-expanded'), true, 'the patch alone keeps it open');
  api.board.applySearchFilter(); // what the board WS and Electron task:updated handlers run next
  assert.equal(tier(1).classList.contains('collapsed'), true, 'every task in it done: the sprint folds');
  assert.equal(card('A2').classList.contains('card-expanded'), false);
  assert.equal(document.querySelectorAll('.card-placeholder').length, 0);
  assert.equal(document.querySelectorAll('.card-overlay-backdrop').length, 0);
  assert.equal(tierCards(1).style.minHeight, '', 'released, so the fold can close the sprint');
  assert.equal(api.state.selectedCardId, null);

  api.cards.expandCard(card('B1'), 'hover');
  card('B1').classList.add('search-hidden');
  api.cards.syncExpandedOverlay();
  assert.equal(card('B1').classList.contains('card-expanded'), false);
  assert.equal(document.querySelectorAll('.card-placeholder').length, 0);
});

test('a full render after an in-place move re-opens the card in its new sprint', () => {
  mountBoard({ 1: [task('A1'), task('A2')], 2: [task('B1', { priority: 2 })] });
  api.cards.expandCard(card('A1'), 'pinned');
  assert.equal(api.cards.applyTaskPatch(task('A1', { priority: 2 })), 'moved');
  const snapshot = api.cards.takeExpandedCard(app);
  assert.equal(snapshot?.id, 'A1');
  assert.equal(document.querySelectorAll('.card-placeholder').length, 0, 'closed with nothing left behind');
  mountBoard({ 1: [task('A2')], 2: [task('A1', { priority: 2 }), task('B1', { priority: 2 })] });
  assert.equal(api.cards.restoreExpandedCard(app, snapshot), true);
  assert.deepEqual(slotsIn(2), ['placeholder', 'A1', 'B1']);
  assert.equal(document.querySelectorAll('.card-placeholder').length, 1);
});

// ── Source scans: template.html's inline wiring and the stylesheet ──
const read = name => readFileSync(new URL('./' + name, import.meta.url), 'utf8');

function extractFunctionBody(source, name) {
  const startRe = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm');
  const start = startRe.exec(source);
  assert.ok(start, `function ${name}() not found`);
  const nextRe = /^(?:export )?(?:async )?function \w+\(/gm;
  nextRe.lastIndex = start.index + start[0].length;
  const next = nextRe.exec(source);
  return source.slice(start.index, next ? next.index : source.length);
}

test('template.html: the render reads scroll and the open card at the #app commit', () => {
  const impl = extractFunctionBody(read('template.html'), '_loadAndRenderImpl');
  const commit = impl.indexOf('app.innerHTML = `\n    <nav class="top-nav');
  assert.ok(commit !== -1, 'board commit found');
  const recheck = impl.lastIndexOf('_deferRenderForDrag(options)', commit);
  const scroll = impl.indexOf('const restoreScrollY = window.scrollY;');
  const take = impl.indexOf('const expandedBefore = takeExpandedCard(app);');
  assert.ok(recheck !== -1 && recheck < scroll && scroll < take && take < commit, 'after the last await, right before the commit');
  assert.equal(impl.includes('startScrollY'), false, 'no render-start scroll offset');
  assert.match(impl.slice(commit), /if \(isTasksSection && !wantTop\) skipTransitionsForFrame\(app\);/);
  assert.equal((impl.match(/window\.scrollTo\(0, restoreScrollY\)/g) || []).length, 3, 'terminal, terminal return, default');
});

test('template.html: the card re-opens after the chain-highlight restore; a newer pin beats the terminal one', () => {
  const impl = extractFunctionBody(read('template.html'), '_loadAndRenderImpl');
  const chain = impl.indexOf('// Restore chain highlights after re-render');
  const reopen = impl.indexOf('if (reopen) restoreExpandedCard(app, reopen);');
  assert.ok(chain !== -1 && reopen > chain);
  assert.match(impl, /expandedBefore\?\.mode !== 'pinned'/);
});

test('template.html: background refreshes leave the restore context to the terminal', () => {
  assert.doesNotMatch(read('template.html'), /state\.pendingRestoreContext = \{/);
});

test('styles.css: no-transition turns transitions off in the whole subtree', () => {
  assert.match(read('styles.css'), /\.no-transition,\s*\.no-transition \*,\s*\.no-transition \*::before,\s*\.no-transition \*::after \{\s*transition: none !important;\s*\}/);
});
