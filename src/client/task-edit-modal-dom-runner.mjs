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
    ['HUMAN', task('HUMAN', { agentAssignee: 'human' })],
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

  // (TPT466) Task workspace: Edit / Agent Terminal / Chat panes in one modal. The terminal and
  // chat come in through the window.TipTask bridges, mounted into their pane on first visit.
  const mounts = { terminal: [], chat: [] };
  window.TipTask = {
    mountTaskTerminal(host, id, title, desc, status, opts) {
      const ctrl = {
        id, host, title, opts, shown: 0, hidden: 0, detached: 0,
        show() { this.shown++; }, hide() { this.hidden++; }, detach() { this.detached++; },
      };
      host.insertAdjacentHTML('beforeend', '<div class="fake-xterm"></div>');
      mounts.terminal.push(ctrl);
      return ctrl;
    },
    taskChat: {
      mount(host, id, opts) {
        const handle = {
          id, host, opts, shown: 0, hidden: 0, disposed: 0, edited: [],
          show() { this.shown++; }, hide() { this.hidden++; }, dispose() { this.disposed++; },
          taskEdited(key) { this.edited.push(key); },
        };
        host.insertAdjacentHTML('beforeend', '<textarea class="fake-chat-input"></textarea>');
        mounts.chat.push(handle);
        return handle;
      },
    },
  };
  const tab = pane => modal().querySelector(`.task-modal-tab[data-pane="${pane}"]`);
  const paneEl = pane => modal().querySelector(`.task-modal-pane--${pane}`);
  await board.openTaskEditModal('TPT1');
  await tick();
  assert.equal(modal().querySelectorAll('.task-modal-tab').length, 3);
  assert.equal(modal().querySelector('.task-edit-panel').dataset.pane, 'edit');
  assert.equal(modal().querySelector('.btn-modal-chat'), null);
  // (TPT479) The rail is uncovered on every pane, and ✕ is the close control on Edit too.
  assert.ok(modal().querySelector('.task-edit-overlay--rail'), 'rail stays live beside the edit pane');
  assert.ok(document.body.classList.contains('task-modal-rail'));
  assert.ok(modal().querySelector('.btn-modal-close'));
  const draftTitle = modal().querySelector('.modal-title-input');
  draftTitle.value = 'Draft across tabs';
  draftTitle.dispatchEvent(new Event('input', { bubbles: true }));

  // Chat: mounted once into its pane; the unsaved title rides along, flagged on the Edit tab.
  tab('chat').click();
  assert.equal(modal().dataset.pane, 'chat');
  assert.equal(paneEl('edit').hidden, true);
  assert.equal(paneEl('chat').hidden, false);
  assert.equal(mounts.chat.length, 1);
  assert.equal(mounts.chat[0].host, paneEl('chat'));
  assert.equal(mounts.chat[0].id, 'TPT1');
  assert.equal(tab('edit').querySelector('.task-modal-tab-dot').hidden, false);
  assert.ok(modal().querySelector('.task-edit-overlay--rail'), 'rail stays live beside the chat pane');
  mounts.chat[0].host.querySelector('.fake-chat-input').value = 'typed in chat';

  // Terminal with no session: an empty state, nothing mounted.
  tab('terminal').click();
  assert.equal(mounts.terminal.length, 0);
  assert.ok(paneEl('terminal').querySelector('.task-modal-empty'));
  assert.ok(modal().querySelector('.task-edit-overlay--rail'), 'rail stays live beside the terminal pane');
  assert.ok(document.body.classList.contains('task-modal-rail'));
  assert.equal(mounts.chat[0].hidden, 1);

  // With a session it mounts into the pane; switching away hides it, back shows the same one.
  state.activeSessions.add('TPT1');
  tab('edit').click();
  assert.equal(modal().querySelector('.modal-title-input').value, 'Draft across tabs', 'draft kept');
  assert.equal(tab('edit').querySelector('.task-modal-tab-dot').hidden, true);
  assert.ok(document.body.classList.contains('task-modal-rail'), 'switching to Edit keeps the rail');
  assert.ok(modal().querySelector('.task-edit-overlay--rail'));
  const termDot = () => tab('terminal').querySelector('.task-modal-tab-dot');
  assert.equal(termDot().hidden, false, 'a live session lights the tab dot');
  tab('terminal').click();
  assert.equal(mounts.terminal.length, 1);
  assert.equal(mounts.terminal[0].host, paneEl('terminal'));
  assert.equal(typeof mounts.terminal[0].opts.onClosed, 'function');
  // (TPT479) The tab dot is the one status light: it follows what the xterm reports.
  mounts.terminal[0].opts.onStatus('paused', 'Paused');
  assert.ok(termDot().classList.contains('task-modal-tab-dot--paused'));
  assert.equal(termDot().title, 'Paused');
  mounts.terminal[0].opts.onStatus('exited', 'Exited (code 0)');
  assert.ok(termDot().classList.contains('task-modal-tab-dot--exited'));
  assert.equal(termDot().classList.contains('task-modal-tab-dot--paused'), false);
  mounts.terminal[0].opts.onStatus('', 'Connected');
  assert.equal(termDot().classList.contains('task-modal-tab-dot--exited'), false);
  assert.equal(termDot().hidden, false);
  tab('chat').click();
  assert.equal(mounts.terminal[0].hidden, 1);
  assert.equal(mounts.chat.length, 1, 'chat is not remounted');
  assert.equal(paneEl('chat').querySelector('.fake-chat-input').value, 'typed in chat');
  tab('terminal').click();
  assert.equal(mounts.terminal.length, 1, 'terminal is not remounted');
  assert.equal(mounts.terminal[0].shown, 1, 'the return visit shows (refits) the mounted xterm');

  // Reset rebuilds the form only — the mounted panes are carried over node for node.
  const xterm = modal().querySelector('.fake-xterm');
  const chatInput = modal().querySelector('.fake-chat-input');
  modal().querySelector('.btn-modal-reset').click();
  assert.equal(modal().querySelector('.fake-xterm'), xterm);
  assert.equal(modal().querySelector('.fake-chat-input'), chatInput);
  assert.equal(modal().dataset.pane, 'terminal');
  assert.equal(modal().querySelector('.modal-title-input').value, 'Title TPT1');

  // A save from the Edit pane is reported to the chat pane.
  tab('edit').click();
  const savedTitle = modal().querySelector('.modal-title-input');
  savedTitle.value = 'Saved from workspace';
  savedTitle.dispatchEvent(new Event('input', { bubbles: true }));
  modal().querySelector('.btn-modal-save').click();
  await tick();
  assert.deepEqual(mounts.chat[0].edited, ['TPT1']);

  // The xterm going away on its own leaves the empty state behind.
  mounts.terminal[0].opts.onClosed();
  state.activeSessions.delete('TPT1');
  tab('terminal').click();
  assert.ok(paneEl('terminal').querySelector('.task-modal-empty'));

  // Close detaches both: their server session and chat keep running.
  board.closeTaskEditModal(true);
  assert.equal(mounts.chat[0].disposed, 1);
  assert.equal(modal().dataset.pane, undefined);
  assert.equal(document.body.classList.contains('task-modal-rail'), false);

  // openTaskWorkspace() opens on the requested pane, and switches pane on an open workspace.
  await board.openTaskWorkspace('TPT2', { pane: 'chat' });
  await tick();
  assert.equal(modal().dataset.taskId, 'TPT2');
  assert.equal(modal().dataset.pane, 'chat');
  assert.equal(mounts.chat.at(-1).id, 'TPT2');
  await board.openTaskWorkspace('TPT2', { pane: 'edit' });
  assert.equal(modal().dataset.pane, 'edit');

  // (TPT479) Another task's workspace replaces this one in a single step: the open modal stays
  // up (rail and all) until the next task has loaded, and it opens straight onto its pane.
  const switching = board.openTaskWorkspace('TPT1', { pane: 'chat' });
  assert.equal(modal().hidden, false, 'no modal-less frame while the next task loads');
  assert.equal(modal().dataset.taskId, 'TPT2');
  assert.ok(document.body.classList.contains('task-modal-rail'));
  await switching;
  await tick();
  assert.equal(modal().dataset.taskId, 'TPT1');
  assert.equal(modal().dataset.pane, 'chat');
  assert.ok(modal().querySelector('.task-edit-overlay--rail'));

  // An unsaved draft still asks first, and a cancelled confirm keeps the workspace as it was.
  tab('edit').click();
  const dirtyTitle = modal().querySelector('.modal-title-input');
  dirtyTitle.value = 'Unsaved switch';
  dirtyTitle.dispatchEvent(new Event('input', { bubbles: true }));
  const guarded = board.openTaskWorkspace('TPT2', { pane: 'terminal' });
  await tick();
  const cancel = document.querySelector('.modal-overlay--over-modal .btn-cancel');
  assert.ok(cancel, 'discard confirm is shown');
  cancel.click();
  await guarded;
  await tick();
  assert.equal(modal().dataset.taskId, 'TPT1');
  assert.equal(modal().querySelector('.modal-title-input').value, 'Unsaved switch');
  board.closeTaskEditModal(true);

  // (TPT485) The rail stays clickable while the next task loads, so opens overlap: the latest
  // wins. The open workspace — not only a mounted xterm — owns the rail's active row, on every
  // pane, and the row lets go once the workspace closes.
  const navHost = document.createElement('div');
  navHost.id = 'active-sessions-list';
  document.body.appendChild(navHost);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => (url === '/api/sessions' ? { ok: false, json: async () => null } : realFetch(url));
  state.activeSessions.add('TPT1');
  state.activeSessions.add('TPT2');
  const realGet = api.tasks.get;
  let releaseSlow = null;
  api.tasks.get = async id => {
    if (id === 'TPT2') await new Promise(resolve => { releaseSlow = resolve; });
    return realGet(id);
  };
  const slowOpen = board.openTaskWorkspace('TPT2', { pane: 'edit' });
  await tick();
  await board.openTaskWorkspace('TPT1', { pane: 'edit' });
  await tick();
  releaseSlow();
  await slowOpen;
  await tick();
  api.tasks.get = realGet;
  assert.equal(modal().dataset.taskId, 'TPT1', 'an earlier, slower open never replaces the latest');
  const activeRow = () => navHost.querySelector('.active-session-item.active')?.dataset.taskId;
  assert.equal(activeRow(), 'TPT1');
  for (const pane of ['chat', 'edit']) {
    tab(pane).click();
    await tick();
    assert.equal(activeRow(), 'TPT1', `rail row stays active on ${pane}`);
    assert.ok(document.body.classList.contains('task-modal-rail'));
  }
  board.closeTaskEditModal(true);
  assert.equal(activeRow(), undefined, 'closing the workspace releases its row');
  state.activeSessions.delete('TPT1');
  state.activeSessions.delete('TPT2');
  globalThis.fetch = realFetch;
  navHost.remove();

  // Proposal, diff and stacked (hideActions) modals stay edit-only.
  await board.openTaskEditModal('new-2', { preloadedTask: task('new-2'), onSavePreview: async () => {} });
  assert.equal(modal().querySelector('.task-modal-tabs'), null);
  board.closeTaskEditModal(true);
  await board.openTaskEditModal('TPT1', { hideActions: true });
  assert.equal(modal().querySelector('.task-modal-tabs'), null);
  board.closeTaskEditModal(true);
  delete window.TipTask;
  console.log('TPT337_DOM_PASS');

  // (TPT568) Saving an agent assignee adds or removes Start without reopening the modal.
  const startBtn = () => modal().querySelector('.modal-actions-run [data-action="start"]');
  const pickAgent = value => modal()
    .querySelector(`.agent-picker[data-name="agentAssignee"] .agent-picker-option[data-value="${value}"]`)
    .click();
  await board.openTaskEditModal('HUMAN');
  await tick();
  assert.equal(startBtn(), null, 'human-assigned task has no Start');
  pickAgent('claude');
  assert.equal(startBtn(), null, 'unsaved agent change does not add Start');
  modal().querySelector('.btn-modal-save').click();
  await tick();
  assert.deepEqual(writes.at(-1), { id: 'HUMAN', patch: { agent_assignee: 'claude' } });
  assert.ok(startBtn(), 'Start appears after saving an agent assignee');
  assert.equal(startBtn().disabled, false);
  assert.equal(startBtn().dataset.sessionMode, 'start');
  assert.ok(startBtn().querySelector('.btn-label'));
  pickAgent('human');
  modal().querySelector('.btn-modal-save').click();
  await tick();
  assert.deepEqual(writes.at(-1), { id: 'HUMAN', patch: { agent_assignee: 'human' } });
  assert.equal(startBtn(), null, 'Start leaves after saving a human assignee');
  assert.equal(modal().querySelector('.modal-actions-run [data-action="stop"]'), null);
  board.closeTaskEditModal(true);
  console.log('TPT568_START_SYNC_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
