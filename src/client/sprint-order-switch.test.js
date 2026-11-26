import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9407) The board header's Oldest first / Newest first switch: the real renderBoardContent() /
// renderListContent() / bindSprintOrderSwitch() and group-label.js saveSprintSortOrder() bundled
// under happy-dom (sprint-selection.test.js's harness), with api.project.update() stubbed — no
// server, no network.

let window, scratch, mod, app;
const globals = new Map();
let originalUpdate;

function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

before(async () => {
  window = new Window({ url: 'http://localhost:4455/' });
  scratch = mkdtempSync(join(tmpdir(), 'tt-sprint-order-'));
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
    'FocusEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  for (const key of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, window[key].bind(window));
  }
  install('WebSocket', class { constructor() { this.readyState = 0; } send() {} close() {} });
  install('fetch', async (url) => { throw new Error(`Unexpected fetch: ${url}`); });
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    stdin: { contents: `export { default as state } from './src/client/state.js';
      export * as board from './src/client/task-board.js';
      export * as groupLabel from './src/client/group-label.js';
      export { LOCALES, setLocale } from './src/client/i18n.js';
      export { api } from './src/client/api-client.js';`, resolveDir: root },
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
  mod = await import(pathToFileURL(bundle).href);
  originalUpdate = mod.api.project.update;
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
  mod.state.selectedCardIds.clear();
  mod.state.collapsedTiers.clear();
  mod.state.expandedTiers.clear();
  mod.state.statusFilter = new Set();
  mod.state.boardWindow = null;
  mod.state.allStepsLoaded = false;
  mod.state.extraStepsLoaded = 0;
  mod.groupLabel.resetGroupLabel();
  mod.groupLabel.setSprintsEnabled(true);
  mod.setLocale('en');
  document.body.innerHTML = '<div class="container" id="app"></div>';
  app = document.getElementById('app');
});

afterEach(() => {
  mod.api.project.update = originalUpdate;
  mod.groupLabel.resetGroupLabel();
  mod.setLocale('en');
});

function task(id, priority, overrides = {}) {
  return { id, title: `Task ${id}`, description: '', status: 'pending', category: 'CODING', agentAssignee: 'claude',
    assignee: null, dependencies: [], tags: [], priority, order: 0, ...overrides };
}

// Two sprints holding open work, one synthesized empty sprint (a sprint record with no tasks yet).
function twoSprints() {
  return { 1: [task('A', 1)], 2: [task('B', 2)], 3: [] };
}

const card = t => `<div class="card" data-id="${t.id}" data-status="${t.status}"><span class="card-title">${t.title}</span></div>`;

function mount(view, tiers = twoSprints()) {
  const keys = Object.keys(tiers).map(Number);
  mod.state.tiers = tiers;
  mod.state.tierKeys = keys;
  app.innerHTML = view === 'list'
    ? mod.board.renderListContent(keys, tiers, list => [...list], card)
    : mod.board.renderBoardContent(keys, tiers, list => [...list], card);
}

// Nodes are compared as booleans: a failing assert.equal() on a happy-dom node never finishes
// inspecting it, so the file would time out instead of naming the failure.
const header = () => app.querySelector('.board-header');
const button = order => app.querySelector(`.sprint-order-btn[data-sprint-order="${order}"]`);
const tierOrder = () => [...app.querySelectorAll('.tier:not(.tier--empty)')].map(el => Number(el.dataset.priority));
const flush = () => new Promise(resolve => setImmediate(resolve));
const errorToast = () => document.querySelector('.tt-toast--error .tt-saving-label')?.textContent || '';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('Board and List open with the Oldest first / Newest first switch, the order in force pressed', () => {
  for (const view of ['board', 'list']) {
    for (const order of ['asc', 'desc']) {
      mod.groupLabel.setSprintSortOrder(order);
      mount(view);
      assert.ok(header(), `${view} ${order}: header drawn`);
      assert.equal(app.firstElementChild === header(), true, `${view} ${order}: the header opens the view`);
      const group = header().querySelector('.sprint-order[role="group"]');
      assert.equal(group.getAttribute('aria-label'), 'Sort order');
      const buttons = [...group.querySelectorAll('button.sprint-order-btn')];
      assert.deepEqual(buttons.map(b => b.dataset.sprintOrder), ['asc', 'desc']);
      assert.deepEqual(buttons.map(b => b.textContent.trim()), ['Oldest first', 'Newest first']);
      assert.deepEqual(buttons.map(b => b.getAttribute('aria-pressed')), [String(order === 'asc'), String(order === 'desc')]);
      assert.deepEqual(buttons.map(b => b.getAttribute('type')), ['button', 'button']);
      assert.equal(buttons.every(b => b.querySelector('svg[aria-hidden="true"]')), true, 'decorative icons are hidden');
    }
  }
  mod.groupLabel.setSprintSortOrder('desc');
  mount('board');
  assert.deepEqual(tierOrder(), [2, 1], 'Newest first: the newest sprint on top');
  mod.groupLabel.resetSprintSortOrder();
  mount('board');
  assert.deepEqual(tierOrder(), [1, 2], 'no saved value: oldest first');
  assert.equal(button('asc').getAttribute('aria-pressed'), 'true');
});

test('the switch labels, tooltips and group name are translated in every locale', () => {
  const keys = ['board.sprintOrder', 'board.sprintOrderAsc', 'board.sprintOrderDesc', 'board.sprintOrderAscHint', 'board.sprintOrderDescHint', 'board.sprintOrderFailed'];
  for (const locale of ['en', 'uk', 'zh', 'es']) {
    for (const key of keys) assert.ok(mod.LOCALES[locale][key]?.trim(), `${locale}.${key} is defined`);
    assert.ok(mod.LOCALES[locale]['board.sprintOrderFailed'].includes('{msg}'), `${locale}.board.sprintOrderFailed keeps {msg}`);
    if (locale !== 'en') {
      for (const key of keys) assert.notEqual(mod.LOCALES[locale][key], mod.LOCALES.en[key], `${locale}.${key} is translated`);
    }
    mod.setLocale(locale);
    mount('board');
    const table = mod.LOCALES[locale];
    assert.equal(header().querySelector('.sprint-order').getAttribute('aria-label'), table['board.sprintOrder']);
    assert.equal(button('asc').textContent.trim(), table['board.sprintOrderAsc']);
    assert.equal(button('desc').textContent.trim(), table['board.sprintOrderDesc']);
    assert.equal(button('asc').getAttribute('title'), table['board.sprintOrderAscHint']);
    assert.equal(button('desc').getAttribute('title'), table['board.sprintOrderDescHint']);
    assert.doesNotMatch(header().outerHTML, /board\.sprintOrder/, `${locale}: no raw key on screen`);
  }
});

test('no switch with sprints off: neither the flat board nor the List draws one', () => {
  mod.groupLabel.setSprintsEnabled(false);
  mount('list');
  assert.equal(header() === null, true, 'List with sprints off');
  mount('board');
  assert.equal(header() === null, true, 'renderBoardContent() itself checks the setting');
  app.innerHTML = mod.board.renderFlatBoardContent([task('A', 1), task('B', 2)], list => [...list], card);
  assert.equal(header() === null, true, 'flat board');
  assert.ok(app.querySelector('.tier--flat'));
});

test('the switch is drawn only where the order can change the board, and filters never hide it', () => {
  mount('board', { 1: [task('A', 1)], 2: [] });
  assert.equal(header() === null, true, 'one sprint holding tasks: nothing to order');
  mod.state.boardWindow = { floor: 1, has_older: true, extended: 0 };
  mount('board', { 1: [task('A', 1)], 2: [] });
  assert.ok(header(), 'older sprints behind the window: Load Earlier follows the order');
  mod.state.allStepsLoaded = true;
  mount('board', { 1: [task('A', 1)], 2: [] });
  assert.equal(header() === null, true, 'every sprint loaded');
  mod.state.allStepsLoaded = false;
  mod.state.boardWindow = null;
  mod.state.statusFilter = new Set(['on_fire']);
  mount('board');
  assert.ok(header(), 'a filter that hides every card keeps the switch');
  assert.ok(app.querySelector('.board-no-sprint-tasks'));
  mount('list');
  assert.ok(header(), 'List with a filter keeps it too');
});

test('a pick shows the new order at once, saves sprint_sort_order and keeps focus on its button', async () => {
  const save = deferred();
  const calls = [];
  mod.api.project.update = fields => { calls.push(fields); return save.promise; };
  let renders = 0;
  const rerender = async () => { renders++; mount('board'); mod.board.bindSprintOrderSwitch(app, rerender); };
  mount('board');
  mod.board.bindSprintOrderSwitch(app, rerender);
  assert.deepEqual(tierOrder(), [1, 2]);

  button('desc').focus();
  button('desc').click();
  await flush();
  assert.equal(renders, 1, 'repainted once, before the save settles');
  assert.equal(mod.groupLabel.getSprintSortOrder(), 'desc');
  assert.deepEqual(tierOrder(), [2, 1]);
  assert.equal(button('desc').getAttribute('aria-pressed'), 'true');
  assert.equal(button('asc').getAttribute('aria-pressed'), 'false');
  assert.equal(document.activeElement === button('desc'), true, 'focus moved to the copy of the pressed button');
  assert.deepEqual(calls, [{ sprint_sort_order: 'desc' }]);

  save.resolve(null);
  await flush();
  assert.equal(renders, 1, 'a saved pick repaints nothing more');
  assert.equal(errorToast(), '');

  button('desc').click();
  await flush();
  assert.equal(renders, 1, 'the order in force does nothing');
  assert.equal(calls.length, 1);
});

test('a failed save puts the order back, repaints and shows an error toast', async () => {
  mod.api.project.update = async () => { throw new Error("Error invoking remote method 'api:project.update': Error: offline"); };
  let renders = 0;
  const rerender = async () => { renders++; mount('list'); mod.board.bindSprintOrderSwitch(app, rerender); };
  mount('list');
  mod.board.bindSprintOrderSwitch(app, rerender);
  const groups = () => [...app.querySelectorAll('.list-group')].map(el => Number(el.dataset.priority));
  assert.deepEqual(groups(), [1, 2]);

  button('desc').focus();
  button('desc').click();
  await flush();
  await flush();
  assert.equal(renders, 2, 'one repaint for the pick, one for the rollback');
  assert.equal(mod.groupLabel.getSprintSortOrder(), 'asc');
  assert.deepEqual(groups(), [1, 2]);
  assert.equal(button('asc').getAttribute('aria-pressed'), 'true');
  assert.equal(errorToast(), 'Could not save the order: offline');
  assert.equal(document.activeElement === button('desc'), true, 'focus stays on the failed pick: a retry is one key press');
});

test('template.html wires the switch after every render, from the cached snapshot', () => {
  const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  assert.match(template, /\n {2}bindSprintOrderSwitch,\n/, 'destructured from taskBoard');
  assert.match(template, /setupCardInteractions\(app\);\n(?:\s*\/\/.*\n)*\s*bindSprintOrderSwitch\(app, \(\) => loadAndRender\(\)\);/,
    'bound right after the card interactions, repainting through loadAndRender()');
});
