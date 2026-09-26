// Runs the real client modules in a DOM process isolated from node:test globals.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:4455/' });
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });

const observers = [];
class TestIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observed = new Set();
    this.disconnected = false;
    observers.push(this);
  }
  observe(element) { this.observed.add(element); }
  unobserve(element) { this.observed.delete(element); }
  disconnect() { this.disconnected = true; this.observed.clear(); }
}
globalThis.IntersectionObserver = TestIntersectionObserver;
window.IntersectionObserver = TestIntersectionObserver;

document.body.innerHTML = '<div id="task-edit-modal" hidden></div>';
globalThis.fetch = async url => ({
  ok: true,
  json: async () => url === '/api/config'
    ? { AVAILABLE_AGENTS: ['claude', 'codex'] }
    : url === '/api/sessions' ? { sessions: [] } : {},
});

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt337-dom-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: `export * as board from './src/client/task-board.js';
        export * as editor from './src/client/task-edit-modal.js';
        export { default as state } from './src/client/state.js';
        export { api } from './src/client/api-client.js';`,
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { board, state, api } = await import(pathToFileURL(bundlePath).href);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const modal = () => document.getElementById('task-edit-modal');
  const task = (id, overrides = {}) => ({
    id, title: `Title ${id}`, description: `Description ${id}`, status: 'pending',
    category: 'CODING', priority: 1, tags: [], dependencies: [], assignee: 1,
    agentAssignee: null, ...overrides,
  });
  const tasks = new Map([
    ['TPT1', task('TPT1')],
    ['TPT2', task('TPT2')],
    ['LOCKED', task('LOCKED', { status: 'in_progress', agentAssignee: 'codex' })],
    ['OTHER', task('OTHER', { assignee: 2 })],
    ['BLOCKED', task('BLOCKED', { dependencies: ['TPT2'], agentAssignee: 'codex' })],
  ]);
  const writes = [];
  const subscriptions = [];
  let comments = [];
  let events = [];
  state.currentUserId = 1;
  state.projectMembers = [{ id: 1, user_id: 1, name: 'Alice' }, { id: 2, user_id: 2, name: 'Bob' }];
  api.tasks.get = async id => structuredClone(tasks.get(id));
  api.tasks.listAll = async () => [...tasks.values()];
  api.tasks.update = async (id, patch) => { writes.push({ id, patch }); return {}; };
  api.members.list = async () => state.projectMembers;
  api.tasks.comments.list = async () => comments;
  api.tasks.comments.create = async (id, content) => ({ id: 13, content, user: { id: 1, name: 'Alice' } });
  api.tasks.events.list = async () => ({ events, subscribed: true });
  api.tasks.events.setSubscription = async (id, subscribed) => { subscriptions.push({ id, subscribed }); };

  // Open, edit and save through rendered controls and the real PATCH path.
  await board.openTaskEditModal('TPT1');
  assert.equal(modal().hidden, false);
  assert.equal(modal().dataset.taskId, 'TPT1');
  const title = modal().querySelector('.modal-title-input');
  assert.equal(title.value, 'Title TPT1');
  title.value = 'Edited title';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(modal().querySelector('.btn-modal-save').disabled, false);
  modal().querySelector('.btn-modal-save').click();
  await tick();
  assert.deepEqual(writes.at(-1), { id: 'TPT1', patch: { title: 'Edited title' } });
  assert.equal(modal().querySelector('.btn-modal-save').disabled, true);

  // Interactive close offers one confirmation. Cancel keeps draft; confirm disposes it.
  title.value = 'Unsaved title';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  const canceledClose = board.requestCloseTaskEditModal();
  await tick();
  assert.equal(document.querySelectorAll('.modal-overlay--over-modal').length, 1);
  const duplicateClose = board.requestCloseTaskEditModal();
  assert.equal(await duplicateClose, false);
  document.querySelector('.modal-overlay--over-modal .btn-cancel').click();
  assert.equal(await canceledClose, false);
  assert.equal(modal().hidden, false);
  const confirmedClose = board.requestCloseTaskEditModal();
  await tick();
  document.querySelector('.modal-overlay--over-modal .btn-confirm').click();
  assert.equal(await confirmedClose, true);
  assert.equal(modal().hidden, true);

  // View-only and agent-session locks remain distinct, with comments still available.
  await board.openTaskEditModal('OTHER');
  assert.equal(modal().querySelector('.modal-title-input').readOnly, true);
  assert.equal(modal().querySelector('.btn-modal-save').disabled, true);
  assert.ok(modal().querySelector('.modal-readonly-banner'));
  assert.ok(modal().querySelector('.comment-input'));
  board.closeTaskEditModal(true);
  await board.openTaskEditModal('LOCKED');
  assert.equal(modal().querySelector('.modal-title-input').readOnly, true);
  assert.equal(modal().querySelector('.modal-agent-model-select')?.disabled, true);
  const statusSelect = modal().querySelector('.modal-status-select');
  statusSelect.value = 'pending';
  statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(modal().querySelector('.modal-title-input').readOnly, false);
  assert.equal(modal().querySelector('.modal-agent-model-select')?.disabled, false);
  board.closeTaskEditModal(true);

  // Preview and dependency paths retain their distinct controls after extraction.
  let previewSaved = null;
  await board.openTaskEditModal('new-1', {
    preloadedTask: task('new-1'),
    onSavePreview: async draft => { previewSaved = structuredClone(draft); },
  });
  assert.equal(modal().querySelector('.modal-tab-btn[data-tab="comments"]').hidden, true);
  assert.equal(modal().querySelector('.modal-context-btns').hidden, true);
  const previewTitle = modal().querySelector('.modal-title-input');
  previewTitle.value = 'Planned title';
  previewTitle.dispatchEvent(new Event('input', { bubbles: true }));
  modal().querySelector('.btn-modal-save').click();
  await tick();
  assert.equal(previewSaved.title, 'Planned title');
  board.closeTaskEditModal(true);
  await board.openTaskEditModal('TPT1', {
    preloadedTask: task('TPT1', { title: 'Proposed title' }),
    compareTask: task('TPT1'),
    onSavePreview: async () => {},
  });
  assert.ok(modal().querySelector('.task-edit-panel--diff'));
  assert.match(modal().querySelector('.diff-title-display[data-diff-side="new"]').textContent, /Proposed title/);
  board.closeTaskEditModal(true);
  await board.openTaskEditModal('BLOCKED');
  await tick();
  assert.equal(modal().querySelector('[data-action="start"]').disabled, true);
  board.closeTaskEditModal(true);

  // Comment and event tabs load live rows, attach visibility observers, and dispose them.
  comments = [{ id: 11, content: 'First comment', user: { id: 2, name: 'Bob' } }];
  events = [{ id: 21, title: 'Task updated', body: 'Status changed', actor: { id: 2, name: 'Bob' } }];
  let resizeListeners = 0;
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  window.addEventListener = (type, listener, options) => { if (type === 'resize') resizeListeners++; return add(type, listener, options); };
  window.removeEventListener = (type, listener, options) => { if (type === 'resize') resizeListeners--; return remove(type, listener, options); };
  await board.openTaskEditModal('TPT1');
  await tick();
  modal().querySelector('.modal-tab-btn[data-tab="comments"]').click();
  assert.match(modal().querySelector('.comments-list').textContent, /First comment/);
  assert.ok(observers.some(observer => observer.observed.size > 0));
  const commentInput = modal().querySelector('.comment-input');
  commentInput.value = 'New comment';
  modal().querySelector('.comment-submit').click();
  await tick();
  assert.match(modal().querySelector('.comments-list').textContent, /New comment/);
  modal().querySelector('.modal-tab-btn[data-tab="notifications"]').click();
  await tick();
  assert.match(modal().querySelector('.notif-events-list').textContent, /Task updated/);
  const checkbox = modal().querySelector('.modal-notif-subscribed-checkbox');
  checkbox.checked = false;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
  assert.deepEqual(subscriptions.at(-1), { id: 'TPT1', subscribed: false });
  board.closeTaskEditModal(true);
  assert.ok(observers.every(observer => observer.disconnected));
  assert.equal(resizeListeners, 0);
  assert.equal(document.querySelector('.tag-typeahead-dropdown, .dep-typeahead-dropdown, .member-typeahead-dropdown'), null);

  // Reopening another task does not retain the previous draft, comments or event rows.
  comments = [];
  events = [];
  await board.openTaskEditModal('TPT2');
  await tick();
  assert.equal(modal().dataset.taskId, 'TPT2');
  assert.equal(modal().querySelector('.modal-title-input').value, 'Title TPT2');
  assert.doesNotMatch(modal().textContent, /First comment|Task updated/);
  board.closeTaskEditModal(true);
  assert.equal(resizeListeners, 0);
  console.log('TPT337_DOM_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
