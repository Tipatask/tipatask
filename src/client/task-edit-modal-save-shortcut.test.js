// (TPT9224) Cmd/Ctrl+S in the Task Edit modal: saves through the Save button's path, then closes.
// Runs the real client modules (bundled with esbuild) against a happy-dom document.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:4455/' });
const savedGlobals = new Map();
function setGlobal(key, value) {
  if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node',
]) setGlobal(key, window[key]);
for (const key of ['window', 'self']) setGlobal(key, window);
setGlobal('navigator', window.navigator);
setGlobal('requestAnimationFrame', callback => setTimeout(() => callback(Date.now()), 0));
setGlobal('cancelAnimationFrame', id => clearTimeout(id));
class NoopIntersectionObserver { observe() {} unobserve() {} disconnect() {} }
setGlobal('IntersectionObserver', NoopIntersectionObserver);
window.IntersectionObserver = NoopIntersectionObserver;
setGlobal('fetch', async url => ({
  ok: true,
  json: async () => url === '/api/config'
    ? { AVAILABLE_AGENTS: ['claude', 'codex'] }
    : url === '/api/sessions' ? { sessions: [] } : {},
}));

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9224-save-shortcut-'));
let board, state, api;
const tasks = new Map();
let writes = [];
let updateImpl = null;

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const modal = () => document.getElementById('task-edit-modal');
const task = (id, overrides = {}) => ({
  id, title: `Title ${id}`, description: `Description ${id}`, status: 'pending',
  category: 'CODING', priority: 1, tags: [], dependencies: [], assignee: 1,
  agentAssignee: null, ...overrides,
});
function pressSave(target, { ctrl = false } = {}) {
  const event = new window.KeyboardEvent('keydown', {
    key: 's', metaKey: !ctrl, ctrlKey: ctrl, bubbles: true, cancelable: true,
  });
  (target || document.activeElement || document.body).dispatchEvent(event);
  return event;
}
function editTitle(value) {
  const title = modal().querySelector('.modal-title-input');
  title.value = value;
  title.dispatchEvent(new Event('input', { bubbles: true }));
  return title;
}

before(async () => {
  document.body.innerHTML = '<div id="task-edit-modal" hidden></div>';
  const bundled = await build({
    stdin: {
      contents: `export * as board from './src/client/task-board.js';
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
  const bundlePath = join(temporary, 'client.mjs');
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  ({ board, state, api } = await import(pathToFileURL(bundlePath).href));
  state.currentUserId = 1;
  state.projectMembers = [{ id: 1, user_id: 1, name: 'Alice' }, { id: 2, user_id: 2, name: 'Bob' }];
  api.tasks.get = async id => structuredClone(tasks.get(id));
  api.tasks.listAll = async () => [...tasks.values()];
  api.tasks.update = async (id, patch) => {
    writes.push({ id, patch });
    return updateImpl ? updateImpl(id, patch) : {};
  };
  api.members.list = async () => state.projectMembers;
  api.tasks.comments.list = async () => [];
  api.tasks.events.list = async () => ({ events: [], subscribed: true });
});

beforeEach(() => {
  board.closeTaskEditModal(true);
  document.querySelectorAll('.modal-overlay--over-modal').forEach(el => el.remove());
  tasks.clear();
  for (const t of [task('TPT1'), task('TPT2'), task('OTHER', { assignee: 2 })]) tasks.set(t.id, t);
  writes = [];
  updateImpl = null;
});

after(() => {
  board?.closeTaskEditModal(true);
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  window.happyDOM?.abort?.();
  rmSync(temporary, { recursive: true, force: true });
});

test('Cmd+S on a dirty edit saves once and closes the modal', async () => {
  await board.openTaskEditModal('TPT1');
  const title = editTitle('Edited by Cmd+S');
  const event = pressSave(title);
  assert.equal(event.defaultPrevented, true, 'no native Save Page');
  await tick();
  assert.deepEqual(writes, [{ id: 'TPT1', patch: { title: 'Edited by Cmd+S' } }]);
  assert.equal(modal().hidden, true);
});

test('Ctrl+S does the same from a tag input', async () => {
  await board.openTaskEditModal('TPT1');
  editTitle('Edited by Ctrl+S');
  const event = pressSave(modal().querySelector('.modal-tag-input'), { ctrl: true });
  assert.equal(event.defaultPrevented, true);
  await tick();
  assert.deepEqual(writes, [{ id: 'TPT1', patch: { title: 'Edited by Ctrl+S' } }]);
  assert.equal(modal().hidden, true);
});

test('Cmd+S from the description textarea saves the typed text and closes', async () => {
  await board.openTaskEditModal('TPT1');
  modal().querySelector('.modal-desc-display').click();
  const textarea = modal().querySelector('#modal-desc-textarea');
  assert.ok(textarea, 'description editor is open');
  textarea.value = 'Typed description';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  pressSave(textarea);
  await tick();
  assert.deepEqual(writes, [{ id: 'TPT1', patch: { description: 'Typed description' } }]);
  assert.equal(modal().hidden, true);
});

test('Ctrl+S from the comment composer saves in the non-tabbed modal', async () => {
  await board.openTaskEditModal('TPT1', { hideActions: true });
  editTitle('Saved from the composer');
  modal().querySelector('.modal-tab-btn[data-tab="comments"]').click();
  pressSave(modal().querySelector('#modal-comment-input'), { ctrl: true });
  await tick();
  assert.deepEqual(writes, [{ id: 'TPT1', patch: { title: 'Saved from the composer' } }]);
  assert.equal(modal().hidden, true);
});

test('In the tabbed workspace, Cmd+S on the Comments pane is swallowed and saves nothing', async () => {
  await board.openTaskEditModal('TPT1');
  editTitle('Not saved from Comments');
  modal().querySelector('.modal-tab-btn[data-tab="comments"]').click();
  const event = pressSave(modal().querySelector('#modal-comment-input'));
  assert.equal(event.defaultPrevented, true, 'no native Save Page');
  await tick();
  assert.deepEqual(writes, []);
  assert.equal(modal().hidden, false);
});

test('Read-only mode makes no save call', async () => {
  await board.openTaskEditModal('OTHER');
  pressSave(modal().querySelector('.modal-task-id'));
  await tick();
  await board.openTaskEditModal('TPT2', { readOnly: true });
  pressSave(modal().querySelector('.modal-task-id'));
  await tick();
  assert.deepEqual(writes, []);
  assert.equal(modal().hidden, false);
});

test('A clean modal (Save disabled) neither saves nor closes', async () => {
  await board.openTaskEditModal('TPT1');
  const event = pressSave();
  assert.equal(event.defaultPrevented, true);
  await tick();
  assert.deepEqual(writes, []);
  assert.equal(modal().hidden, false);
});

test('A stacked discard confirm blocks the shortcut', async () => {
  await board.openTaskEditModal('TPT1');
  editTitle('Unsaved while confirming');
  const closing = board.requestCloseTaskEditModal();
  await tick();
  const confirm = document.querySelector('.modal-overlay--over-modal');
  assert.ok(confirm, 'discard confirm is open');
  const event = pressSave(confirm.querySelector('.btn-cancel'));
  assert.equal(event.defaultPrevented, false, 'the confirm layer owns the key');
  await tick();
  assert.deepEqual(writes, []);
  confirm.querySelector('.btn-cancel').click();
  assert.equal(await closing, false);
  assert.equal(modal().hidden, false);
});

test('A double press saves once', async () => {
  let release;
  updateImpl = () => new Promise(resolve => { release = resolve; });
  await board.openTaskEditModal('TPT1');
  const title = editTitle('Pressed twice');
  pressSave(title);
  await tick();
  pressSave(title);
  await tick();
  assert.equal(writes.length, 1);
  release({});
  await tick();
  assert.equal(writes.length, 1);
  assert.equal(modal().hidden, true);
});

test('A failed save leaves the modal open', async () => {
  updateImpl = async () => { const err = new Error('rejected'); err.statusCode = 400; throw err; };
  await board.openTaskEditModal('TPT1');
  pressSave(editTitle('Will fail'));
  await tick();
  await tick();
  assert.equal(writes.length, 1);
  assert.equal(modal().hidden, false);
  assert.equal(modal().querySelector('.btn-modal-save').disabled, false, 'draft stays dirty for a retry');
  assert.match(document.body.textContent, /Save failed: rejected/, 'the Save button\'s error toast');
});

test('A proposal card runs onSavePreview through the shortcut', async () => {
  const saved = [];
  await board.openTaskEditModal('new-1', {
    preloadedTask: task('new-1', { title: 'Proposal' }),
    onSavePreview: async draft => { saved.push(draft.title); },
  });
  pressSave(editTitle('Proposal edited'));
  await tick();
  assert.deepEqual(saved, ['Proposal edited']);
  assert.deepEqual(writes, []);
  assert.equal(modal().hidden, true);
});
