import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9268/TPT9271/TPT9283) The card Discuss button, an icon-only square just left of Start. Real
// task-card.js bundle under happy-dom (card-controls-focus.test.js's harness): the button is a
// plain action, not a model menu — a click (which a native button also fires for Enter and Space)
// opens that task's chat through window.TipTask.taskChat.open() with no model, so the chat's start
// gate picks it. Never a menu, a terminal, a card click, a provider read or a task write.

let window, scratch, api, app;
const globals = new Map();
let sockets = 0;
let fetches = [];
let chatOpens = [];
let terminalOpens = [];

function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', available: true, models: [{ value: 'sonnet' }, { value: 'opus' }], defaultModel: 'sonnet' },
  { id: 'codex', label: 'Codex', available: true, models: [{ value: 'gpt-5.1' }], defaultModel: 'gpt-5.1' },
  { id: 'pi', label: 'Pi', available: true, models: [{ value: 'qwen' }, { value: 'notools' }], toolLessModels: ['notools'] },
  { id: 'gemini', label: 'Gemini', available: true, models: [{ value: 'pro' }] },
];

before(async () => {
  window = new Window({ url: 'http://localhost:4455/' });
  scratch = mkdtempSync(join(tmpdir(), 'tt-card-discuss-'));
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  for (const key of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, window[key].bind(window));
  }
  install('WebSocket', class { constructor() { sockets++; this.readyState = 0; } send() {} close() {} });
  install('fetch', async (url, opts = {}) => {
    fetches.push({ url: String(url), method: opts.method || 'GET' });
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    stdin: { contents: `export { default as state } from './src/client/state.js';
      export * as cards from './src/client/task-card.js';
      export * as discuss from './src/client/card-discuss.js';
      export { setLocale } from './src/client/i18n.js';`, resolveDir: root },
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

const TASK = { id: 'A1', title: 'Task A1', description: 'Body', status: 'pending', category: 'CODING',
  agentAssignee: 'claude', assignee: null, dependencies: [], tags: [], priority: 1, order: 0 };

function renderBoard(tasks) {
  app.innerHTML = '<div class="timeline"><div class="tier" data-priority="1"><div class="tier-cards">'
    + tasks.map(task => api.cards.renderCard(task)).join('')
    + '</div></div></div>';
  api.cards.setupCardInteractions(app);
}

beforeEach(() => {
  api.cards.collapseCard();
  api.state.selectedCardIds.clear();
  api.state.discussingTaskKeys = new Set();
  api.state.objectiveProviders = PROVIDERS;
  api.state.objectiveModel = '';
  api.setLocale('en');
  localStorage.clear();
  sockets = 0;
  fetches = [];
  chatOpens = [];
  terminalOpens = [];
  window.TipTask = { taskChat: { open: (key, opts) => { chatOpens.push([key, opts]); } } };
  api.cards.registerCardCallbacks({
    onLoadAndRender: async () => {},
    onOpenTerminal: (...args) => { terminalOpens.push(args); },
  });
  document.body.innerHTML = '<div class="container" id="app"></div>';
  app = document.getElementById('app');
  renderBoard([TASK]);
});

const card = (id = 'A1') => app.querySelector(`.card[data-id="${id}"]`);
const discussBtn = (id = 'A1') => card(id).querySelector('.btn-task-discuss');
const menu = () => document.querySelector('.card-discuss-menu, [role="menu"]');
const key = (target, k, opts = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// The controls row, left to right, by each control's first class.
const order = (id = 'A1') => [...card(id).querySelector('.controls-row').children].map(el => el.classList[0]);

test('every saved board card has Discuss just left of its Start control; previews and proposals have none', () => {
  assert.deepEqual(order(), ['card-status-select', 'card-permission-btn', 'btn-task-discuss', 'card-start-btn'],
    'status select, permission shield, Discuss, Start');
  const btn = discussBtn();
  assert.equal(btn.textContent.trim(), '', 'icon only: no visible text');
  // (TPT9288) Every text node in the button, the glyph's included, is blank.
  const walker = document.createTreeWalker(btn, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    assert.equal(node.nodeValue.trim(), '', `no visible text node: ${JSON.stringify(node.nodeValue)}`);
  }
  assert.equal(btn.querySelector('.btn-task-discuss-label'), null, 'no label span');
  assert.equal(btn.children.length, 1, 'just the chat glyph');
  assert.equal(btn.firstElementChild.tagName.toLowerCase(), 'svg');
  assert.equal(btn.firstElementChild.getAttribute('aria-hidden'), 'true', 'the glyph is decorative');
  assert.equal(btn.getAttribute('aria-label'), 'Discuss', 'aria-label is its accessible name');
  assert.equal(btn.hasAttribute('title'), false, 'the card tooltip comes from data-tip, not a native title');
  assert.equal(btn.type, 'button');
  assert.equal(btn.hasAttribute('aria-haspopup'), false, 'a plain action, not a menu button');
  assert.equal(btn.hasAttribute('aria-expanded'), false);
  assert.equal(btn.querySelector('.btn-task-discuss-chevron'), null, 'no dropdown chevron');
  assert.equal(btn.dataset.taskId, 'A1');
  assert.equal(btn.dataset.tip, 'Open a chat about this task and pick its model there');

  // (TPT9288) The same order on a completed card (its Start restarts the task) and a pending one.
  renderBoard([{ ...TASK, id: 'D1', status: 'completed' }, { ...TASK, id: 'P1', status: 'pending' }]);
  for (const id of ['D1', 'P1']) {
    assert.deepEqual(order(id), ['card-status-select', 'card-permission-btn', 'btn-task-discuss', 'card-start-btn'],
      `${id}: status select, permission shield, Discuss, Start`);
    assert.ok(card(id).querySelector('.btn-task-discuss + .btn-claude'), `${id}: Start right after Discuss`);
  }
  assert.equal(card('D1').dataset.statusRole, 'complete');

  // A HUMAN task's discussion Start, a teammate's task without Start, an objective with its
  // Subtasks button after Start, a human-assigned task without Start.
  api.state.currentUserId = 7;
  renderBoard([
    { ...TASK, id: 'H1', category: 'HUMAN', status: 'pending', agentAssignee: null },
    { ...TASK, id: 'B2', assignee: 9 },
    { ...TASK, id: 'O3', isObjective: true, hasChildren: true },
    { ...TASK, id: 'M4', agentAssignee: 'human' },
  ]);
  assert.ok(card('H1').querySelector('.btn-start-discussion'), 'discussion Start rendered');
  assert.deepEqual(order('H1').slice(-2), ['btn-task-discuss', 'card-start-btn']);
  assert.equal(card('B2').querySelector('.btn-claude'), null, 'not startable by this user');
  assert.deepEqual(order('B2'), ['card-status-select', 'card-permission-btn', 'btn-task-discuss'], 'still discussable');
  assert.deepEqual(order('O3'), ['card-status-select', 'card-permission-btn', 'btn-task-discuss', 'card-start-btn', 'btn-open-subtask-board']);
  assert.deepEqual(order('M4'), ['card-status-select', 'card-permission-btn', 'btn-task-discuss'], 'Human-assigned: no Start, Discuss stays');
  api.state.currentUserId = null;

  const preview = document.createElement('div');
  preview.innerHTML = api.cards.renderCard(TASK, { preview: true }) + api.cards.renderCard(TASK, { proposal: { rootAttrs: '' } });
  assert.equal(preview.querySelector('.btn-task-discuss'), null);
});

test('a Start added by a saved assignment lands just right of Discuss', () => {
  renderBoard([{ ...TASK, agentAssignee: 'human' }]);
  assert.equal(card().querySelector('.btn-claude'), null);
  const discuss = discussBtn();
  api.cards.refreshCard({ ...TASK, agentAssignee: 'claude' });
  assert.deepEqual(order(), ['card-status-select', 'card-permission-btn', 'btn-task-discuss', 'card-start-btn']);
  assert.equal(discussBtn(), discuss, 'Discuss stays mounted, still bound');
  discussBtn().click();
  assert.deepEqual(chatOpens, [['A1', undefined]]);
});

test('a click opens this task\'s chat with no model and no card menu, and does nothing else', () => {
  localStorage.setItem('tipatask-task-chat-model', 'codex:gpt-5.1');
  api.cards.expandCard(card(), 'hover');
  discussBtn().click(); // Enter / Space on the focused button fire this same click
  assert.equal(menu(), null, 'no model menu on the card');
  assert.deepEqual(chatOpens, [['A1', undefined]], 'the chat opens on its start gate, which picks the model');
  assert.equal(terminalOpens.length, 0, 'no terminal');
  assert.equal(sockets, 0, 'no session socket from the card');
  assert.deepEqual(fetches, [], 'no provider read, no task write');
  assert.equal(api.state.selectedCardId, null, 'no card click');
  assert.equal(card().classList.contains('card-expanded'), false, 'the card collapses');
  assert.equal(localStorage.getItem('tipatask-task-chat-model'), 'codex:gpt-5.1', 'the saved choice is left to the chat');
});

test('keyboard on the button opens no menu: arrows do nothing, Enter/Space act as the click', () => {
  for (const k of ['ArrowDown', 'ArrowUp', 'Enter', ' ']) key(discussBtn(), k);
  assert.equal(menu(), null);
  assert.equal(chatOpens.length, 0, 'a keydown alone opens nothing; the button\'s native click does');
  discussBtn().focus();
  discussBtn().click();
  assert.equal(menu(), null);
  assert.deepEqual(chatOpens, [['A1', undefined]]);
});

test('a locked or not yet synced card opens no chat', async () => {
  api.state.discussingTaskKeys = new Set(['A1']);
  discussBtn().click();
  await tick();
  assert.match(document.body.textContent, /Being discussed in an objective chat/);
  api.state.discussingTaskKeys = new Set();
  card().classList.add('pending-sync');
  discussBtn().click();
  card().classList.remove('pending-sync');
  assert.equal(chatOpens.length, 0);
  assert.equal(menu(), null);
});

test('the card modules no longer carry a Discuss menu', () => {
  assert.deepEqual(Object.keys(api.discuss).sort(), ['bindDiscussButton', 'discussButtonHtml']);
});

test('labels follow the project language', () => {
  api.setLocale('uk');
  renderBoard([TASK]);
  assert.equal(discussBtn().getAttribute('aria-label'), 'Обговорити');
  assert.equal(discussBtn().dataset.tip, 'Відкрити чат про це завдання й вибрати модель у ньому');
});
