import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9025) The board freezes while a card is dragged: card patches queue and return
// 'deferred', board-wide repaints wait, and everything replays in arrival order when the
// gesture ends. Real task-card.js + task-board.js bundle under happy-dom (same harness as
// headless-start-errors.test.js); only xterm, the socket and fetch are doubles. happy-dom has
// no layout, so these pin DOM effects and ordering; template.html's inline wiring is pinned
// by the source scans at the end of this file.

let window, scratch, api;
const globals = new Map();
const ended = [];
const requests = [];
let patchGate = null; // when set, PATCH responses wait for it

function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

before(async () => {
  window = new Window({ url: 'http://localhost:4455/' });
  scratch = mkdtempSync(join(tmpdir(), 'tt-drag-freeze-'));
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
    'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  // The page's timers as the globals, so happyDOM.abort() also clears the intervals
  // setupCardInteractions() starts (task-merge.js, task-finish.js).
  for (const key of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, window[key].bind(window));
  }
  install('WebSocket', class { constructor() { this.readyState = 0; } send() {} close() {} });
  install('fetch', async (url, opts = {}) => {
    requests.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'PATCH' && patchGate) await patchGate;
    return { ok: true, status: 200, json: async () => ({}) };
  });
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
  document.addEventListener('tiptask:drag-ended', e => ended.push(e.detail));
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
  ended.length = 0;
  requests.length = 0;
  patchGate = null;
  api.state.activeSessions.clear();
  api.state.exitedSessions.clear();
  api.state.queuedSessions.clear();
  api.state.taskStatusById.clear();
  api.state.collapsedTiers.clear();
  api.state.expandedTiers.clear();
  api.cards.registerCardCallbacks({ onLoadAndRender: null });
});

function task(id, priority, overrides = {}) {
  return { id, title: `Task ${id}`, description: 'Body', status: 'pending', category: 'CODING', agentAssignee: 'claude',
    assignee: null, dependencies: [], tags: [], priority, order: 0, ...overrides };
}

// Same markup shape as renderBoardContent(): .timeline > .tier[data-priority] > label + .tier-cards.
function mountBoard(tiers) {
  const html = Object.keys(tiers).map(Number).sort((a, b) => a - b).map(p => {
    const list = tiers[p];
    return `<div class="tier${list.length ? '' : ' tier--empty'}" data-priority="${p}">`
      + `<div class="tier-label" data-priority="${p}">Sprint ${p}</div>`
      + `<div class="tier-cards">${list.map(t => api.cards.renderCard(t)).join('')}`
      + '<div class="tier-drop-sentinel" aria-hidden="true"></div></div></div>';
  }).join('');
  document.body.innerHTML = `<div class="container" id="app"><div class="timeline">${html}</div></div>`;
  const app = document.getElementById('app');
  api.cards.setupCardInteractions(app);
  return app;
}

const card = id => document.querySelector(`.card[data-id="${id}"]`);
const tierOf = id => card(id)?.closest('.tier')?.dataset.priority;
const idsIn = p => [...document.querySelectorAll(`.tier[data-priority="${p}"] .card[data-id]`)].map(c => c.dataset.id);
const mouse = (target, type, x, y, buttons) => target.dispatchEvent(new MouseEvent(type, {
  bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: y,
}));
const grab = id => mouse(card(id).querySelector('.id-badge'), 'mousedown', 100, 100, 1);
const moveTo = (x, y) => mouse(document, 'mousemove', x, y, 1);
const release = (x = 120, y = 120) => mouse(document, 'mouseup', x, y, 0);
const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
function startDrag(id) {
  grab(id);
  moveTo(120, 120); // past the 5px activation threshold
  assert.equal(document.body.classList.contains('board-dragging'), true, 'drag activated');
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('a status patch mid-drag changes nothing until the drag ends, then lands once', () => {
  const b = task('B', 3);
  mountBoard({ 3: [task('A', 3), b], 5: [task('C', 5)] });
  startDrag('A');
  assert.equal(api.cards.applyTaskPatch({ ...b, status: 'completed' }), 'deferred');
  assert.equal(card('B').dataset.status, 'pending');
  assert.equal(card('B').querySelector('.card-status-select').value, 'pending');
  escape();
  assert.equal(card('B').dataset.status, 'completed');
  assert.equal(card('B').querySelector('.card-status-select').value, 'completed');
  assert.deepEqual(ended, [{ needsReload: false }]);
  assert.equal(document.body.classList.contains('board-dragging'), false);
});

test('sprint moves and removals wait for the drag; an emptied tier hides only afterwards', () => {
  const b = task('B', 3);
  mountBoard({ 3: [task('A', 3), b], 5: [task('C', 5)], 6: [task('D', 6)] });
  startDrag('A');
  assert.equal(api.cards.applyTaskPatch({ ...b, priority: 5 }), 'deferred');
  assert.equal(api.cards.removeCardFromDom('D'), 'deferred');
  assert.equal(tierOf('B'), '3');
  assert.ok(card('D'));
  assert.equal(document.querySelector('.tier[data-priority="6"]').classList.contains('tier--empty'), false);
  escape();
  assert.equal(tierOf('B'), '5');
  assert.equal(card('D'), null);
  assert.equal(document.querySelector('.tier[data-priority="6"]').classList.contains('tier--empty'), true);
  assert.deepEqual(ended, [{ needsReload: false }]);
});

test('a direct regroup replays with one reload request; one already in its tier is skipped', () => {
  mountBoard({ 3: [task('A', 3), task('B', 3)], 5: [task('C', 5)] });
  startDrag('C');
  assert.equal(api.cards.regroupCardToSprint('B', 3, false), 'deferred'); // already there
  escape();
  assert.deepEqual(idsIn(3), ['A', 'B'], 'not re-inserted at the top of its own tier');
  assert.deepEqual(ended, [{ needsReload: false }]);

  ended.length = 0;
  startDrag('C');
  assert.equal(api.cards.regroupCardToSprint('A', 5, false), 'deferred');
  assert.equal(tierOf('A'), '3');
  escape();
  assert.equal(tierOf('A'), '5');
  // The caller skipped its own follow-up (refreshCard / forced reload) when it saw 'deferred'.
  assert.deepEqual(ended, [{ needsReload: true }]);
});

test('several unmounted patches still end the gesture with exactly one reload request', () => {
  mountBoard({ 3: [task('A', 3)] });
  startDrag('A');
  assert.equal(api.cards.applyTaskPatch(task('GONE1', 3)), 'deferred');
  assert.equal(api.cards.applyTaskPatch(task('GONE2', 4)), 'deferred');
  escape();
  assert.deepEqual(ended, [{ needsReload: true }]);
});

test('queued patches replay in arrival order', () => {
  const b = task('B', 3);
  const c = task('C', 5);
  mountBoard({ 3: [task('A', 3), b], 5: [c, task('D', 5)] });
  startDrag('A');
  api.cards.applyTaskPatch({ ...b, status: 'in_progress' });
  api.cards.applyTaskPatch({ ...b, status: 'completed' });
  api.cards.applyTaskPatch({ ...c, title: 'Renamed' });
  api.cards.removeCardFromDom('C');
  escape();
  assert.equal(card('B').dataset.status, 'completed');
  assert.equal(card('C'), null);
});

test('a badge click without a drag (mousedown → mouseup) holds patches only until mouseup', async () => {
  const b = task('B', 3);
  mountBoard({ 3: [task('A', 3), b] });
  grab('A');
  assert.equal(api.cards.applyTaskPatch({ ...b, status: 'completed' }), 'deferred');
  assert.equal(card('B').dataset.status, 'pending');
  release(100, 100);
  await settle();
  assert.equal(card('B').dataset.status, 'completed');
  assert.deepEqual(ended, [{ needsReload: false }]);
});

test('session buttons, has-active-session and the C1306 status read-back wait for the drag', () => {
  mountBoard({ 3: [task('A', 3), task('B', 3)], 5: [task('C', 5)] });
  card('C').classList.add('has-active-session'); // stale: C has no session
  startDrag('A');
  const clone = document.querySelector('.card-dragging-clone');
  const cloneButton = clone.querySelector('.btn-claude').innerHTML;
  const button = card('B').querySelector('.btn-claude').innerHTML;
  api.state.activeSessions.add('A');
  api.state.activeSessions.add('B');
  api.state.taskStatusById.set('B', 'in_progress'); // what the task event just wrote
  api.board.updateClaudeButtons();
  assert.equal(card('B').classList.contains('has-active-session'), false);
  assert.equal(card('B').querySelector('.btn-claude').innerHTML, button);
  assert.equal(clone.querySelector('.btn-claude').innerHTML, cloneButton, 'the drag clone is never repainted');
  assert.equal(card('C').classList.contains('has-active-session'), true);
  assert.equal(api.state.taskStatusById.get('B'), 'in_progress', 'stale card status must not overwrite the nav map');
  escape();
  assert.equal(card('B').classList.contains('has-active-session'), true);
  assert.notEqual(card('B').querySelector('.btn-claude').innerHTML, button);
  assert.equal(card('C').classList.contains('has-active-session'), false, 'sweep drops it from a sessionless card');
});

test('applySearchFilter() leaves card and tier visibility alone mid-drag and runs once after', () => {
  mountBoard({ 3: [task('A', 3), task('B', 3)], 5: [task('C', 5)] });
  card('C').classList.add('search-hidden');
  startDrag('A');
  api.board.applySearchFilter();
  assert.equal(card('C').classList.contains('search-hidden'), true);
  escape();
  assert.equal(card('C').classList.contains('search-hidden'), false);
});

test('with no filter an empty sprint is never collapsed, so the drag can still reveal it as a drop target', () => {
  mountBoard({ 3: [task('A', 3, { status: 'completed' })], 5: [task('C', 5)], 6: [] });
  api.board.applySearchFilter();
  const empty = document.querySelector('.tier[data-priority="6"]');
  assert.equal(empty.classList.contains('collapsed'), false);
  assert.equal(empty.classList.contains('tier--empty'), true);
  assert.equal(document.querySelector('.tier[data-priority="3"]').classList.contains('collapsed'), true, 'all-done tiers still collapse');
  startDrag('C');
  assert.ok(document.querySelector('.card-drag-placeholder'), 'the gesture itself keeps running');
  escape();
});

test('committed drop: the drop render supersedes earlier patches, later ones replay, its tail runs inline', async () => {
  const b = task('B', 3);
  const c = task('C', 5);
  mountBoard({ 3: [task('A', 3), b], 5: [c] });
  let openPatches;
  patchGate = new Promise(resolve => { openPatches = resolve; });
  let openRender;
  const renderGate = new Promise(resolve => { openRender = resolve; });
  const renders = [];
  let tailRanInline = null;
  api.cards.registerCardCallbacks({
    onLoadAndRender: async (opts) => {
      renders.push(opts);
      await renderGate;
      // The server's view: B's in_progress write had not happened when this fetch was answered.
      mountBoard({ 3: [task('A', 3), task('B', 3)], 5: [task('C', 5)] });
      api.cards.markDropRenderCommitted(); // template.html, right after the #app commit
      card('C').classList.add('search-hidden');
      api.board.applySearchFilter();
      tailRanInline = !card('C').classList.contains('search-hidden');
    },
  });
  startDrag('A');
  release();
  assert.equal(api.cards.applyTaskPatch({ ...b, status: 'in_progress' }), 'deferred'); // before the render
  openPatches();
  for (let i = 0; i < 20 && renders.length === 0; i++) await settle();
  assert.deepEqual(renders, [{ forceFresh: true, afterDrop: true }]);
  assert.equal(api.cards.applyTaskPatch({ ...c, status: 'completed' }), 'deferred'); // during it
  openRender();
  for (let i = 0; i < 20 && ended.length === 0; i++) await settle();
  assert.equal(tailRanInline, true, 'the drop render tail is not deferred');
  assert.equal(card('B').dataset.status, 'pending', 'superseded by the render, not replayed over it');
  assert.equal(card('C').dataset.status, 'completed', 'queued during the render, replayed after it');
  assert.deepEqual(ended, [{ needsReload: false }]);
});

// happy-dom has no layout: give the two sprints real rectangles and route the hit test to the
// target, then drag `id` from the source into the target and release there. `onLoadAndRender`
// stands in for the drop's own render.
async function dropAcross(id, sourcePriority, targetPriority, onLoadAndRender) {
  const source = document.querySelector(`.tier[data-priority="${sourcePriority}"] .tier-cards`);
  const target = document.querySelector(`.tier[data-priority="${targetPriority}"] .tier-cards`);
  source.getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 100, width: 600, height: 100 });
  target.getBoundingClientRect = () => ({ left: 0, right: 600, top: 200, bottom: 300, width: 600, height: 100 });
  document.elementFromPoint = () => target;
  api.cards.registerCardCallbacks({ onLoadAndRender });
  try {
    grab(id);
    moveTo(300, 250);
    release(300, 250);
    for (let i = 0; i < 20 && ended.length === 0; i++) await settle();
  } finally {
    delete document.elementFromPoint;
  }
}

test('cross-sprint drop keeps the in-place board right if the drop render never lands', async () => {
  const a = task('A', 3);
  mountBoard({ 3: [a], 5: [task('C', 5), task('D', 5)] });
  let echoed = null;
  // A render that does not commit — superseded, failed or timed out — while the drop's own
  // PATCH echo arrives.
  await dropAcross('A', 3, 5, async () => { echoed = api.cards.applyTaskPatch({ ...a, priority: 5, order: 0 }); });
  assert.equal(echoed, 'deferred');
  assert.deepEqual(idsIn(5), ['C', 'D', 'A'], 'the echo replay keeps the drop position');
  assert.equal(card('A').dataset.priority, '5');
  assert.deepEqual(requests.find(r => r.method === 'PATCH' && r.url.endsWith('/A'))?.body, { priority: 5, order: 0 });
  assert.equal(document.querySelector('.tier[data-priority="3"]').classList.contains('tier--empty'), true, 'emptied source hides');
  assert.deepEqual(ended, [{ needsReload: false }]);
});

test('a drop into an empty sprint the user had collapsed opens it, render or not', async () => {
  mountBoard({ 3: [task('A', 3), task('B', 3)], 6: [] });
  const emptyTier = document.querySelector('.tier[data-priority="6"]');
  emptyTier.classList.add('collapsed');
  api.state.collapsedTiers.add(6);
  await dropAcross('A', 3, 6, async () => {});
  assert.deepEqual(idsIn(6), ['A']);
  assert.equal(emptyTier.classList.contains('collapsed'), false);
  assert.equal(emptyTier.classList.contains('tier--empty'), false);
  assert.equal(api.state.collapsedTiers.has(6), false);
  assert.equal(api.state.expandedTiers.has(6), true);
  assert.deepEqual(requests.find(r => r.method === 'PATCH' && r.url.endsWith('/A'))?.body, { priority: 6, order: 0 });
});

// ── Source scans: template.html's inline wiring and the drop-phase guards ──
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

test('template.html: the drag guard runs before the generation bump and again at the commit', () => {
  const tpl = read('template.html');
  const load = extractFunctionBody(tpl, 'loadAndRender');
  assert.ok(load.indexOf('_deferRenderForDrag(options)') !== -1);
  assert.ok(load.indexOf('_deferRenderForDrag(options)') < load.indexOf('invalidateLoadAndRender()'));
  const impl = extractFunctionBody(tpl, '_loadAndRenderImpl');
  const commit = impl.indexOf('app.innerHTML = `\n    <nav class="top-nav');
  assert.ok(commit !== -1, 'board commit found');
  const recheck = impl.lastIndexOf('_deferRenderForDrag(options)', commit);
  assert.ok(recheck !== -1, 'commit-time re-check precedes the #app commit');
  assert.ok(impl.indexOf('markDropRenderCommitted()', commit) > commit, 'drop render hook right after the commit');
  assert.match(impl, /_deferredRenderOptions === deferredBeforeDropRender/);
});

test('template.html: drop-phase task events keep the drop render; one post-drag render listener', () => {
  const tpl = read('template.html');
  const handler = extractFunctionBody(tpl, 'handleObjectiveTaskStateEvent');
  assert.equal((handler.match(/invalidateLoadAndRender\(\)/g) || []).length, 2);
  assert.equal((handler.match(/if \(!isDropInProgress\(\)\) invalidateLoadAndRender\(\)/g) || []).length, 2);
  assert.equal((tpl.match(/addEventListener\('tiptask:drag-ended'/g) || []).length, 1);
  assert.match(tpl, /if \(needsReload\) staleBoardTaskCache\(\);/);
});

test('drop-phase requests are capped and has-active-session has one writer', () => {
  const cardSrc = read('task-card.js');
  assert.match(extractFunctionBody(cardSrc, '_patchTask'), /signal: AbortSignal\.timeout\(DROP_PHASE_TIMEOUT_MS\)/);
  assert.match(extractFunctionBody(cardSrc, '_onDragEnd'), /await Promise\.race\(\[/);
  for (const name of ['template.html', 'console-modal.js', 'task-card.js']) {
    assert.doesNotMatch(read(name), /classList\.remove\([^)]*'has-active-session'/, `${name} must leave has-active-session to updateClaudeButtons()`);
  }
});
