// (TPT9147) Renders the real New Task Preview (task-board.js renderNewTaskForm(), preview phase)
// in a DOM process isolated from node:test globals and asserts it is the board's renderCard()
// card: the NEW chip beside the key, one sprint label in the project's group noun (en and uk),
// the meta row and its badges, board-card parity, the Preview handler's key patch, and an agent
// badge a click cannot act on. Overlap and clipping need a real layout engine, which happy-dom
// lacks; they were checked in Chrome. No live API calls.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { marked } from 'marked';

const window = new Window({ url: 'http://localhost:4455/' });
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent', 'MouseEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
class TestIntersectionObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.IntersectionObserver = TestIntersectionObserver;
window.IntersectionObserver = TestIntersectionObserver;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
// renderMarkdown() reads the page's global `marked` (a <script> in the app).
globalThis.marked = marked;
window.marked = marked;

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9147-dom-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: `export * as board from './src/client/task-board.js';
        export * as sprint from './src/client/new-task-sprint.js';
        export * as group from './src/client/group-label.js';
        export { normalizeAgentAssignee } from './src/agent-assignee.mjs';
        export { renderCard, setupCardInteractions, registerCardCallbacks } from './src/client/task-card.js';
        export { setLocale } from './src/client/i18n.js';
        export { default as state } from './src/client/state.js';`,
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { board, sprint, group, normalizeAgentAssignee, renderCard, setupCardInteractions, registerCardCallbacks, setLocale, state }
    = await import(pathToFileURL(bundlePath).href);

  const unhandled = [];
  process.on('unhandledRejection', (err) => unhandled.push(err));
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  state.projectMembers = [{ id: 1, user_id: 7, name: 'Ada' }];
  state.currentUserId = 7;
  state.tagDescriptions = new Map([['bugfix', 'Fixes a defect']]);
  const task = (extra = {}) => ({
    id: 'TPT9148', title: 'We need to add another message to the website contents', description: 'First line.\n\n- one\n- two',
    category: 'CODING', type: 'task', status: 'pending', priority: 412, order: 3, dependencies: ['TPT9146'],
    tags: ['bugfix', 'css'], agentAssignee: 'claude', assignee: 7, claudeModel: null, codexModel: null, piModel: null,
    effort: 'max', claudeDesignMode: false, _stepPinned: true, ...extra,
  });
  const renderPreview = (previewTask) => {
    state.manualTaskState = { phase: 'preview', previewTask };
    document.body.innerHTML = board.renderNewTaskForm([], []);
    const card = document.querySelector('.preview-cards-inline > .card');
    assert.ok(card, 'the preview renders one card inside .preview-cards-inline');
    return card;
  };

  // ── One renderCard() card, proposal mode, no board lookup attribute ──
  setLocale('en');
  group.setGroupLabel('Sprints');
  group.setSprintsEnabled(true);
  let card = renderPreview(task());
  assert.equal(document.querySelectorAll('.preview-cards-inline > *').length, 1);
  for (const cls of ['card', 'card--preview', 'preview-card', 'new-task']) assert.ok(card.classList.contains(cls), `card has .${cls}`);
  assert.equal(card.dataset.taskId, 'TPT9148');
  for (const attr of ['data-id', 'data-db-id', 'data-deps', 'data-tags']) assert.ok(!card.hasAttribute(attr), `no ${attr}`);
  assert.equal(card.querySelector('.preview-meta'), null, 'the hand-built meta row is gone');
  assert.equal(card.querySelector('.preview-card-head'), null, 'no head line above the key');

  // ── NEW chip in .card-top flow, right after the key; title on its own wrapping line ──
  const top = card.querySelector(':scope > .card-top');
  assert.ok(top.classList.contains('card-top--proposal'));
  assert.deepEqual([...top.children].map(el => el.classList[0]), ['id-badge', 'change-label', 'card-title']);
  assert.equal(top.querySelector('.id-badge').textContent, 'TPT9148');
  assert.equal(top.querySelector('.change-label').textContent, 'NEW');
  assert.ok(top.querySelector('.card-title').classList.contains('preview-title'), 'Confirm reads .preview-title');
  assert.equal(card.querySelector('.preview-desc').dataset.raw, task().description, 'Confirm reads the raw description');

  // ── Meta row: status + sprint group, deps, then effort / member / agent badges ──
  const meta = card.querySelector(':scope > .card-preview-meta');
  assert.deepEqual([...meta.children].map(el => el.classList[0]), ['preview-meta-controls', 'preview-deps', 'preview-meta-badges']);
  assert.deepEqual([...meta.querySelector('.preview-meta-controls').children].map(el => el.classList[0]), ['status', 'step-label']);
  assert.equal(meta.querySelector('.status').textContent, 'Pending');
  assert.equal(meta.querySelector('.step-label').textContent, 'Sprint 412');
  assert.equal(meta.querySelector('.preview-deps').textContent, 'Deps: TPT9146');
  assert.deepEqual([...meta.querySelector('.preview-meta-badges').children].map(el => el.classList[0]), ['effort-badge', 'member-badge', 'agent-badge']);
  assert.equal(card.querySelector(':scope > .agent-badge, :scope > .member-badge, :scope > .effort-badge'), null, 'no corner badges');
  assert.doesNotMatch(card.textContent, /Sprint:\s*Sprint|Agent:|Member Assignee:/);

  // ── Same key, title, description, tags and badges as the board card for this task ──
  const host = document.createElement('div');
  host.innerHTML = renderCard(task());
  const boardCard = host.firstElementChild;
  for (const [sel, prop] of [['.id-badge', 'textContent'], ['.card-title', 'textContent'], ['.card-desc', 'innerHTML'],
    ['.card-tags', 'innerHTML'], ['.agent-badge', 'outerHTML'], ['.member-badge', 'outerHTML'], ['.effort-badge', 'outerHTML']]) {
    assert.equal(card.querySelector(sel)[prop], boardCard.querySelector(sel)[prop], `${sel} matches the board card`);
  }
  assert.match(card.querySelector('.card-desc').innerHTML, /<li>one<\/li>/, 'the description is the board markdown');

  // ── Sprint label: the project's group noun + number, or Backlog — en and uk ──
  const sprintLabel = (previewTask) => renderPreview(previewTask).querySelector('.step-label')?.textContent ?? null;
  const expected = {
    en: { Sprints: 'Sprint 412', Batches: 'Batch 412', backlog: 'Backlog', newLabel: 'NEW' },
    uk: { Sprints: 'Спринт 412', Batches: 'Партія 412', backlog: 'Беклог', newLabel: 'НОВА' },
  };
  for (const [locale, want] of Object.entries(expected)) {
    setLocale(locale);
    for (const label of ['Sprints', 'Batches']) {
      group.setGroupLabel(label);
      assert.equal(sprintLabel(task()), want[label], `${locale} ${label}`);
      assert.equal(sprintLabel(task({ priority: 0 })), want.backlog, `${locale} ${label} backlog`);
    }
    assert.equal(renderPreview(task()).querySelector('.change-label').textContent, want.newLabel, `${locale} NEW chip`);
  }
  setLocale('en');
  group.setGroupLabel('Sprints');
  group.setSprintsEnabled(false);
  assert.equal(sprintLabel(task()), null, 'no sprint label while sprints are off, like the board');
  group.setSprintsEnabled(true);

  // ── A dependency move note is the card's last row ──
  card = renderPreview(task({ priority: 413, _sprintMove: { from: 411, to: 413, depId: 'TPT9146', depPriority: 412 } }));
  assert.ok(card.lastElementChild.classList.contains('preview-sprint-move'));
  assert.equal(card.lastElementChild.textContent, 'Moved from Sprint 411 to Sprint 413: depends on TPT9146 in Sprint 412');

  // ── No description, no agent, no member: the meta row holds only status + sprint ──
  card = renderPreview(task({ description: '', agentAssignee: null, assignee: null, effort: null, dependencies: [], tags: [] }));
  assert.deepEqual([...card.querySelector('.card-preview-meta').children].map(el => el.classList[0]), ['preview-meta-controls']);
  assert.equal(card.querySelector('.card-desc').innerHTML, '', 'empty description renders empty (CSS hides it)');

  // ── A preview card's agent badge is display-only; a board card's still opens the assign modal ──
  const assignCalls = [];
  registerCardCallbacks({ onOpenAgentAssignModal: (taskId) => assignCalls.push(taskId) });
  card = renderPreview(task());
  const boardHost = document.createElement('div');
  boardHost.innerHTML = renderCard(task({ id: 'TPT9001' }));
  document.body.appendChild(boardHost);
  setupCardInteractions(document.body);
  card.querySelector('.agent-badge').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(assignCalls, [], 'a click on the preview badge must not open the assign modal');
  boardHost.querySelector('.agent-badge').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(assignCalls, ['TPT9001'], 'board card badges keep their click');

  // ── template.html's Preview handler: the real click builds this card, then the API's next key
  //    replaces the guessed one in place (TPT659) ──
  const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  const start = template.indexOf('  const newTaskForm =', template.indexOf('// ── Manual task creation handlers'));
  const handlers = template.slice(start, template.indexOf('  const newTaskConfirmBtn =', start));
  assert.ok(start > 0 && handlers.includes('fetchNextTaskKey(category).then'));
  let resolveKey;
  const renderManual = () => {
    document.body.innerHTML = board.renderNewTaskForm([], []);
    const scope = {
      app: document.body, state, tasks: [], tierKeys: [], _parentTaskKey: null,
      ...sprint, normalizeAgentAssignee, getSprintsEnabled: group.getSprintsEnabled,
      currentActiveSprintPriority: () => 1, sprintRecordMax: () => 0, startName: () => 'pending',
      nextTaskKeyGuess: () => 'TPT9148', fetchNextTaskKey: () => new Promise(resolve => { resolveKey = resolve; }),
      loadAndRender: renderManual,
    };
    new Function(...Object.keys(scope), handlers)(...Object.values(scope));
  };
  state.manualTaskState = null;
  group.setSprintsEnabled(false);
  renderManual();
  document.querySelector('#new-task-title').value = 'Fix typo';
  document.querySelector('#new-task-preview').click();
  await tick();
  card = document.querySelector('.preview-cards-inline > .card.preview-card.new-task');
  assert.ok(card, 'Preview renders the renderCard() card');
  assert.equal(card.querySelector('.id-badge').textContent, 'TPT9148');
  resolveKey('TPT9150');
  await tick();
  assert.equal(card.dataset.taskId, 'TPT9150');
  assert.equal(card.querySelector('.id-badge').textContent, 'TPT9150');
  assert.equal(card.querySelector('.id-badge').nextElementSibling.textContent, 'NEW', 'the chip stays beside the key');

  await tick();
  assert.deepEqual(unhandled, []);
  console.log('TPT9147_PREVIEW_DOM_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
