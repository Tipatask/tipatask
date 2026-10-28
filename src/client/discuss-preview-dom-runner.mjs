// (TPT9155) Renders the real pinned Discuss card (chat-task-preview.js renderDiscussPreviewHtml(),
// the board's renderCard() in preview mode) and a board card inside #app, binds them the way an
// objective-tab render does (chat-ui.js bindDiscussPreview(), then setupCardInteractions() over
// #app), and clicks each agent badge. The Discuss card's badge is inert: its click reaches
// .chat-discuss-card, which opens the task read-only, and never the agent assign modal. The board
// card's badge still opens that modal. Runs in a DOM process isolated from node:test globals. No
// live API calls.
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
const temporary = mkdtempSync(join(tmpdir(), 'tpt9155-dom-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: `export { renderDiscussPreviewHtml } from './src/client/chat-task-preview.js';
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
  const { renderDiscussPreviewHtml, renderCard, setupCardInteractions, registerCardCallbacks, setLocale, state }
    = await import(pathToFileURL(bundlePath).href);

  // chat-ui.js keeps bindDiscussPreview() private, so its real source runs here with a recording
  // openTaskEditModal() — the vm-extraction pattern of discuss-preview.test.js.
  const chatUi = readFileSync(new URL('./chat-ui.js', import.meta.url), 'utf8');
  const start = chatUi.indexOf('function bindDiscussPreview(');
  assert.notEqual(start, -1, 'bindDiscussPreview() not found in chat-ui.js');
  const opened = [];
  const bindDiscussPreview = new Function('openTaskEditModal',
    `${chatUi.slice(start, chatUi.indexOf('\n}', start) + 2)}\nreturn bindDiscussPreview;`,
  )((key, opts) => opened.push([key, opts]));

  const unhandled = [];
  process.on('unhandledRejection', (err) => unhandled.push(err));
  const listenerErrors = [];
  window.addEventListener('error', (e) => listenerErrors.push(e.error || e.message));

  setLocale('en');
  state.projectMembers = [{ id: 1, user_id: 7, name: 'Ada' }];
  state.currentUserId = 7;
  state.tagDescriptions = new Map([['bugfix', 'Fixes a defect']]);
  const task = (extra = {}) => ({
    id: 'TPT9153', title: 'Put preview card badges at the end of the meta row', description: 'First line.',
    category: 'CODING', type: 'task', status: 'pending', priority: 411, order: 2, dependencies: [],
    tags: ['bugfix'], agentAssignee: 'claude', assignee: 7, claudeModel: null, codexModel: null, piModel: null,
    effort: 'max', claudeDesignMode: false, ...extra,
  });

  // ── The objective tab's pinned Discuss card beside a board card, in #app ──
  document.body.innerHTML = `<div id="app"><div class="chat-container">${renderDiscussPreviewHtml('TPT9153', { task: task() })}</div>`
    + `<div class="tier-cards">${renderCard(task({ id: 'TPT9001', title: 'Board card' }))}</div></div>`;
  const app = document.getElementById('app');
  const discussCard = app.querySelector('.chat-discuss-card');
  assert.ok(discussCard, 'the loaded Discuss preview renders .chat-discuss-card');
  const preview = discussCard.querySelector(':scope > .card');
  assert.ok(preview.classList.contains('card--preview'), 'the Discuss card is renderCard() in preview mode');
  assert.ok(!preview.classList.contains('preview-card'), 'and not a proposal card');
  const discussBadge = preview.querySelector('.preview-meta-badges > .agent-badge');
  assert.ok(discussBadge, 'the Discuss card shows the agent badge at the end of its meta row');
  assert.equal(discussBadge.dataset.taskId, 'TPT9153', 'the badge names the discussed task');
  const boardBadge = app.querySelector('.card[data-id="TPT9001"] > .agent-badge');
  assert.ok(boardBadge, 'the board card shows its corner agent badge');

  // ── Bind as a render does: attachChatHandlers() → bindDiscussPreview(), then setupCardInteractions(#app) ──
  const assignCalls = [];
  registerCardCallbacks({ onOpenAgentAssignModal: (...args) => assignCalls.push(args) });
  bindDiscussPreview(app.querySelector('.chat-discuss-preview'));
  setupCardInteractions(app);

  discussBadge.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(assignCalls, [], 'a click on the Discuss card badge must not open the agent assign modal');
  assert.deepEqual(opened, [['TPT9153', { readOnly: true }]], 'the click reaches .chat-discuss-card, which opens the task read-only');

  boardBadge.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(assignCalls, [['TPT9001', 'claude', 'pending']], 'a board card badge still opens the assign modal');
  assert.equal(opened.length, 1, 'the board badge click stops at the badge');

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(listenerErrors, [], 'no click listener threw');
  assert.deepEqual(unhandled, []);
  console.log('TPT9155_DISCUSS_DOM_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
