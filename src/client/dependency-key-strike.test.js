import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9216) A dependency key whose task holds the project's complete or canceled role is struck
// through wherever keys are listed: the board card's "Deps:" hover label and preview meta row, and
// the Task Edit modal's dependency chips. The role decides, not the name — a renamed closing status
// strikes, a status merely called "completed" without the role does not. Real task-card.js,
// task-board.js and task-edit-modal.js bundled under happy-dom (backlog-patch.test.js's harness).

let window, scratch, api, app;
const globals = new Map();
let listAllCalls = 0;
let listAllImpl = async () => [];
let tasksById = new Map();

function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

before(async () => {
  window = new Window({ url: 'http://localhost:4455/' });
  scratch = mkdtempSync(join(tmpdir(), 'tt-dependency-keys-'));
  for (const key of ['document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent', 'KeyboardEvent',
    'MouseEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) {
    install(key, window[key]);
  }
  install('window', window); install('self', window);
  // The page's timers as the globals, so happyDOM.abort() also clears the intervals
  // setupCardInteractions() starts (task-merge.js, task-finish.js).
  for (const key of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, window[key].bind(window));
  }
  install('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('WebSocket', class { constructor() { this.readyState = 0; } send() {} close() {} addEventListener() {} });
  install('fetch', async url => ({
    ok: true, status: 200,
    json: async () => (String(url).startsWith('/api/config') ? { AVAILABLE_AGENTS: ['claude'] }
      : String(url).startsWith('/api/sessions') ? { sessions: [] } : {}),
  }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    stdin: { contents: `export { default as state } from './src/client/state.js';
      export * as cards from './src/client/task-card.js';
      export * as board from './src/client/task-board.js';
      export * as editor from './src/client/task-edit-modal.js';
      export * as statuses from './src/client/status-registry.js';
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
  api = await import(pathToFileURL(bundle).href);
  api.api.tasks.listAll = async () => { listAllCalls++; return listAllImpl(); };
  api.api.tasks.get = async id => structuredClone(tasksById.get(id));
  api.api.members.list = async () => api.state.projectMembers;
  api.api.tasks.comments.list = async () => [];
  api.api.tasks.events.list = async () => ({ events: [], subscribed: true });
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
  api.statuses.resetStatuses();
  api.board.resetProjectTaskList();
  api.state.taskStatusById = new Map();
  api.state.currentUserId = 1;
  api.state.projectMembers = [{ id: 1, user_id: 1, name: 'Alice' }];
  listAllCalls = 0;
  listAllImpl = async () => [];
  tasksById = new Map();
  document.body.innerHTML = '<div class="container" id="app"></div><div id="task-edit-modal" hidden></div>';
  app = document.getElementById('app');
});

afterEach(() => {
  api.board.closeTaskEditModal(true);
});

function task(id, overrides = {}) {
  return { id, title: `Task ${id}`, description: 'Body', status: 'pending', category: 'CODING', agentAssignee: 'claude',
    assignee: null, dependencies: [], tags: [], priority: 1, order: 0, ...overrides };
}
const flatHtml = tasks => api.board.renderFlatBoardContent(tasks, api.board.sortTier, api.cards.renderCard);
function mount(html) {
  app.innerHTML = html;
  api.cards.setupCardInteractions(app);
}
const card = id => app.querySelector(`.card[data-id="${id}"]`);
const keysIn = root => [...root.querySelectorAll('.dependency-key')].map(el => el.dataset.dependencyKey);
const struckIn = root => [...root.querySelectorAll('.dependency-key.dependency-key-closed')].map(el => el.dataset.dependencyKey);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const modal = () => document.getElementById('task-edit-modal');

test('a board card strikes closed dependency keys in its Deps label and preview meta row', () => {
  api.state.taskStatusById = new Map([['DONE', 'completed'], ['DROP', 'canceled'], ['OPEN', 'in_progress'], ['FIRE', 'on_fire'], ['TODO', 'pending']]);
  const t = task('A', { dependencies: ['DONE', 'OPEN', 'DROP', 'FIRE', 'TODO', 'GONE'] });
  mount(flatHtml([t]));
  const label = card('A').querySelector('.card-deps-label');
  assert.deepEqual(keysIn(label), ['DONE', 'OPEN', 'DROP', 'FIRE', 'TODO', 'GONE']);
  assert.deepEqual(struckIn(label), ['DONE', 'DROP'], 'complete and canceled roles strike; open and unknown keys stay plain');
  assert.equal(label.textContent, 'Deps: DONE, OPEN, DROP, FIRE, TODO, GONE', 'the text reads as before');
  assert.equal(label.title, 'Deps: DONE, OPEN, DROP, FIRE, TODO, GONE');
  assert.equal(label.querySelectorAll('.dependency-key-closed .dependency-key, .dependency-key .dependency-key').length, 0);

  const preview = document.createElement('div');
  preview.innerHTML = api.cards.renderCard(t, { preview: true });
  const meta = preview.querySelector('.card-preview-deps');
  assert.deepEqual(struckIn(meta), ['DONE', 'DROP']);
  assert.equal(meta.textContent, 'Deps: DONE, OPEN, DROP, FIRE, TODO, GONE');
});

test('closed means the complete or canceled role, whatever the status is called', () => {
  const rows = roles => [
    { name: 'todo', color: 'overlay1', display_order: 0, is_workflow_start: true },
    { name: 'doing', color: 'blue', display_order: 1, is_in_progress: true },
    { name: 'completed', color: 'green', display_order: 2, is_workflow_complete: roles.completed === 'complete' },
    { name: 'shipped', color: 'green', display_order: 3, is_workflow_complete: roles.shipped === 'complete' },
    { name: 'dropped', color: 'overlay0', display_order: 4, is_workflow_canceled: true },
  ];
  api.statuses.seedStatuses(rows({ shipped: 'complete' }));
  api.state.taskStatusById = new Map([['S', 'shipped'], ['D', 'dropped'], ['C', 'completed'], ['W', 'doing']]);
  mount(flatHtml([task('A', { status: 'todo', dependencies: ['S', 'D', 'C', 'W'] })]));
  assert.deepEqual(struckIn(app), ['S', 'D'], 'the renamed complete status strikes; the role-less "completed" does not');

  // The complete role moves back to "completed": a status refresh restyles the mounted keys.
  api.statuses.seedStatuses(rows({ completed: 'complete' }));
  api.cards.syncDependencyKeys(app);
  assert.deepEqual(struckIn(app), ['D', 'C']);
});

test('an in-place status patch restyles every rendered key of that task, both ways', () => {
  api.state.taskStatusById = new Map([['A', 'pending'], ['B', 'pending'], ['C', 'pending']]);
  mount(flatHtml([task('A', { dependencies: ['B'] }), task('B'), task('C', { dependencies: ['B', 'A'] })]));
  assert.deepEqual(struckIn(app), []);
  // A local write: the PATCH reply patches B's card while no status map has heard of it yet.
  assert.equal(api.cards.applyTaskPatch(task('B', { status: 'completed' })), 'patched');
  assert.equal(api.state.taskStatusById.get('B'), 'completed', 'the saved status also updates dependency availability');
  assert.deepEqual(struckIn(card('A')), ['B']);
  assert.deepEqual(struckIn(card('C')), ['B'], 'A stays plain in C');
  // Reopened by a task event, which updates the snapshot first (template.html).
  api.state.taskStatusById.set('B', 'pending');
  assert.equal(api.cards.applyTaskPatch(task('B', { status: 'pending' })), 'patched');
  assert.deepEqual(struckIn(app), []);
  // A canceled dependency strikes too, and a deps-only save rebuilds the label the same way.
  api.state.taskStatusById.set('A', 'canceled');
  assert.equal(api.cards.applyTaskPatch(task('C', { dependencies: ['A', 'B'] })), 'patched');
  const label = card('C').querySelector('.card-deps-label');
  assert.equal(label.textContent, 'Deps: A, B');
  assert.deepEqual(struckIn(label), ['A']);
});

test('a key outside the board snapshot resolves from the project task list, loaded once and kept live', async () => {
  api.state.taskStatusById = new Map([['A', 'pending']]);
  const fetched = [
    { id: 'OLD', title: 'Old', status: 'completed', dependencies: [] },
    { id: 'MATE', title: 'Mate', status: 'in_progress', dependencies: [] },
  ];
  listAllImpl = async () => [...fetched];
  mount(flatHtml([task('A', { dependencies: ['OLD', 'MATE'] })]));
  assert.deepEqual(struckIn(app), [], 'unknown until the list lands');
  await settle();
  assert.equal(listAllCalls, 1, 'an unknown key warms the list');
  assert.deepEqual(struckIn(app), ['OLD'], 'the landing list restyles the mounted keys');

  // The next render reads the cached list: no second fetch, struck straight from the markup.
  mount(flatHtml([task('A', { dependencies: ['OLD', 'MATE'] })]));
  await settle();
  assert.equal(listAllCalls, 1);
  assert.deepEqual(struckIn(app), ['OLD']);

  // A task event for a task the board never loaded patches the cached list (template.html).
  api.board.patchProjectTaskList({ id: 'MATE', status: 'completed' });
  api.cards.syncDependencyKeys(app);
  assert.deepEqual(struckIn(app), ['OLD', 'MATE']);
  assert.equal(fetched[1].status, 'in_progress', 'the patch replaces the row, never the fetched object');
  assert.equal(api.board.projectTaskRow('MATE').title, 'Mate', 'fields the event does not carry are kept');
  // A key no source knows keeps its state: the list is dropped on every Task Edit open.
  api.board.resetProjectTaskList();
  api.cards.syncDependencyKeys(app);
  assert.deepEqual(struckIn(app), ['OLD', 'MATE']);

  // Project switch: a fetch the previous project started never lands in this project's cache.
  let release;
  listAllImpl = () => new Promise(resolve => { release = resolve; });
  const stale = api.board.ensureProjectTaskList();
  api.board.resetProjectTaskList();
  release([{ id: 'OLD', status: 'pending' }]);
  await stale;
  await settle();
  assert.equal(api.board.getProjectTaskList(), null);
  assert.deepEqual(struckIn(app), ['OLD', 'MATE'], 'the dropped list restyled nothing');
});

test('Task Edit dependency chips strike only the key; the remove button stays outside it and works', async () => {
  tasksById = new Map([
    ['EDIT', task('EDIT', { assignee: 1, dependencies: ['DONE', 'OPEN', 'DROP'] })],
    ['DONE', task('DONE', { status: 'completed' })],
    ['OPEN', task('OPEN', { status: 'in_progress' })],
    ['DROP', task('DROP', { status: 'canceled' })],
  ]);
  listAllImpl = async () => [...tasksById.values()].map(t => structuredClone(t));
  await api.board.openTaskEditModal('EDIT');
  await settle();
  assert.equal(modal().hidden, false);
  const field = () => modal().querySelector('.modal-deps');
  const chips = () => [...field().querySelectorAll('.modal-dep-chip')];
  assert.deepEqual(chips().map(chip => chip.dataset.dep), ['DONE', 'OPEN', 'DROP']);
  assert.deepEqual(struckIn(field()), ['DONE', 'DROP'], 'the modal\'s own task list resolves the keys');
  for (const chip of chips()) {
    const [key, remove] = chip.children;
    assert.ok(key.classList.contains('dependency-key'), 'the key text is the chip\'s first child');
    assert.equal(key.textContent, chip.dataset.dep);
    assert.ok(remove.classList.contains('chip-remove'));
    assert.equal(remove.closest('.dependency-key'), null, 'the remove button sits outside the struck key');
    assert.equal(chip.classList.contains('dependency-key-closed'), false, 'the chip itself is never struck');
  }

  // Removing the open chip rebuilds the chips (task-board.js refreshChips()); closed keys stay struck.
  chips()[1].querySelector('.chip-remove').click();
  assert.deepEqual(chips().map(chip => chip.dataset.dep), ['DONE', 'DROP']);
  assert.deepEqual(struckIn(field()), ['DONE', 'DROP']);
  // A struck chip's remove button works the same.
  chips()[0].querySelector('.chip-remove').click();
  assert.deepEqual(chips().map(chip => chip.dataset.dep), ['DROP']);

  // A status refresh behind the open modal (a board render after DROP reopened) restyles the chip.
  api.state.taskStatusById = new Map([['DROP', 'pending']]);
  api.cards.setupCardInteractions(app);
  assert.deepEqual(struckIn(field()), []);
  api.state.taskStatusById.set('DROP', 'canceled');
  api.cards.setupCardInteractions(app);
  assert.deepEqual(struckIn(field()), ['DROP']);
});

test('New Task form chips share the Task Edit chip markup', () => {
  api.state.taskStatusById = new Map([['DONE', 'completed'], ['OPEN', 'pending']]);
  const host = document.createElement('div');
  host.innerHTML = ['DONE', 'OPEN'].map(key => api.editor._renderDepChip(key)).join('');
  assert.deepEqual(struckIn(host), ['DONE']);
  assert.equal(host.querySelectorAll('.modal-dep-chip > .chip-remove').length, 2);
  assert.equal(host.querySelectorAll('.dependency-key .chip-remove').length, 0);
});

test('styles.css strikes .dependency-key-closed and decorates nothing around the key', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selectors: match[1].split(',').map(s => s.trim()), body: match[2] }));
  const strikes = rules.filter(rule => /text-decoration(?:-line)?\s*:[^;]*line-through/.test(rule.body));
  assert.ok(strikes.some(rule => rule.selectors.includes('.dependency-key-closed')), 'the closed-key rule draws a line-through');
  const around = /\.(?:chip-remove|modal-dep-chip|dep-chip|modal-deps|card-deps-label|card-preview-deps|preview-deps|drawer-deps)(?![\w-])[^\s>+~]*$/;
  for (const rule of strikes) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, around, `${selector} must not strike a chip, its remove button or a Deps label`);
    }
  }
  const closedRules = rules.filter(rule => rule.selectors.some(s => /dependency-key-closed/.test(s)));
  for (const rule of closedRules) {
    assert.deepEqual(rule.selectors, ['.dependency-key-closed'], 'one plain class rule, so no context can hide it');
    assert.doesNotMatch(rule.body, /(?:^|;)\s*(?:color|opacity|pointer-events|display|visibility)\s*:/, 'the strike changes nothing else');
  }
});
