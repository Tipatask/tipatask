// (TPT9346) Runs the real Task Edit modal with the real shared Embed control (embed-menu.js), image
// upload (task-board.js uploadImageFile / attachImagePaste over the board socket) and file upload
// (file-attach.js uploadAttachmentFile) in a DOM process isolated from node:test globals. The Embed
// row sits under the description; its menu opens on <body>; a picked, dropped or pasted file goes
// into the draft description at the caret — the open editor's, or the one the last edit left —
// linked to the task (a `new` proposal uploads with no key); Save waits for an upload still
// running and never saves a `blob:` placeholder; read-only and locked descriptions have no control.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { marked } from 'marked';

const window = new Window({ url: 'http://localhost:4455/' });
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'DOMParser',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
// The page loads `marked` globally; renderMarkdown() uses it.
Object.defineProperty(globalThis, 'marked', { value: marked, configurable: true, writable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame ??= callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame ??= handle => clearTimeout(handle);
class TestIntersectionObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.IntersectionObserver = TestIntersectionObserver;
window.IntersectionObserver = TestIntersectionObserver;

// Node's (and so happy-dom's) blob URLs carry no origin (`blob:nodedata:…`); a browser's carry the
// page's, which the description's pending-image preview checks.
let blobSeq = 0;
URL.createObjectURL = () => `blob:http://localhost:4455/${String(++blobSeq).padStart(8, '0')}-0000-4000-8000-000000000000`;
URL.revokeObjectURL = () => {};

// The upload helpers read a picked file as a data URL; node has no FileReader.
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      buffer => this.onload?.({ target: { result: `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}` } }),
      err => this.onerror?.(err),
    );
  }
};

const sockets = [];
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    this.listeners = new Map();
    sockets.push(this);
  }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  frame(msg) {
    const event = { data: JSON.stringify(msg) };
    for (const fn of this.listeners.get('message') || []) fn(event);
  }
}
Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });

document.body.innerHTML = '<div id="task-edit-modal" hidden></div>';
globalThis.fetch = async url => ({
  ok: true,
  json: async () => url === '/api/config'
    ? { AVAILABLE_AGENTS: ['claude', 'codex'] }
    : url === '/api/sessions' ? { sessions: [] } : {},
});

const API = 'http://127.0.0.1:4454/api/projects/2';
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9346-embed-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: `export * as board from './src/client/task-board.js';
        export { ensureGlobalChatBindings } from './src/client/chat-ui.js';
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
  const { board, state, api, ensureGlobalChatBindings } = await import(pathToFileURL(bundlePath).href);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  const modal = () => document.getElementById('task-edit-modal');
  const task = (id, overrides = {}) => ({
    id, title: `Title ${id}`, description: `Description ${id}`, status: 'pending',
    category: 'CODING', priority: 1, tags: [], dependencies: [], assignee: 1,
    agentAssignee: null, ...overrides,
  });
  const tasks = new Map([
    ['TPT1', task('TPT1')],
    ['LOCKED', task('LOCKED', { status: 'in_progress', agentAssignee: 'codex' })],
    ['OTHER', task('OTHER', { assignee: 2 })],
  ]);
  const writes = [];
  const fileUploads = [];
  state.currentUserId = 1;
  state.projectMembers = [{ id: 1, user_id: 1, name: 'Alice' }, { id: 2, user_id: 2, name: 'Bob' }];
  api.tasks.get = async id => structuredClone(tasks.get(id));
  api.tasks.listAll = async () => [...tasks.values()];
  api.tasks.update = async (id, patch) => { writes.push({ id, patch }); return {}; };
  api.members.list = async () => state.projectMembers;
  api.tasks.comments.list = async () => [];
  api.tasks.events.list = async () => ({ events: [], subscribed: true });
  api.files.upload = async (filename, mimeType, data, taskKey) => {
    fileUploads.push({ filename, mimeType, taskKey });
    const id = 40 + fileUploads.length;
    return { id, url: `${API}/files/${id}`, filename, size_bytes: 5 };
  };

  const png = name => new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' });
  const txt = name => new File(['notes'], name, { type: 'text/plain' });
  const BLOB_REF_RE = /!\[img\]\((blob:[^)\s]+)\)/;
  const boardSocket = () => sockets.find(s => s.url.includes('__board__'));
  const lastImageUpload = () => boardSocket().sent.filter(m => m.type === 'upload-image').at(-1);
  const answerImage = (blobUrl, id) => boardSocket().frame({ type: 'image-uploaded', blobUrl, url: `${API}/images/${id}` });
  const press = (el, type) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, detail: 1 });
    el.dispatchEvent(event);
    return event;
  };
  const click = el => { press(el, 'mousedown'); press(el, 'click'); };
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const pick = (input, files) => {
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change'));
  };
  const drop = (zone, files) => {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files } });
    zone.dispatchEvent(event);
    return event;
  };
  const embedRow = () => modal().querySelector('.modal-desc-embed');
  const trigger = () => embedRow().querySelector('.embed-menu-trigger');
  const openMenu = () => { click(trigger()); return document.querySelector('.import-submenu'); };
  const menuRows = () => [...document.querySelectorAll('.import-submenu [role="menuitem"]')];
  const display = () => modal().querySelector('.modal-desc-display:not([data-diff-side="old"])');
  const editor = () => modal().querySelector('.modal-desc-textarea');
  const status = () => embedRow().querySelector('.modal-desc-embed-status');

  // 1. The Embed row sits under the description card (after its Show description toggle), above
  // the tab strip, with the composer's trigger: paperclip, "File", caret, a tooltip of its own.
  await board.openTaskEditModal('TPT1');
  const body = [...modal().querySelector('.modal-scroll-body').children].map(el => el.classList[0]);
  assert.equal(body.indexOf('modal-desc-embed'), body.indexOf('modal-desc-toggle') + 1);
  assert.equal(body.indexOf('modal-tabs'), body.indexOf('modal-desc-embed') + 1);
  assert.equal(embedRow().hidden, false);
  assert.equal(trigger().querySelector('.embed-menu-label').textContent, 'File');
  assert.equal(trigger().title, 'Attach a file, image, or project artifact to the description');
  assert.equal(status().hidden, true);

  // 2. The menu opens on <body> (the scroll body would clip it), as a portaled menu the modal's
  // focus layer owns; pressing the trigger never takes the focus.
  assert.equal(press(trigger(), 'mousedown').defaultPrevented, true);
  press(trigger(), 'click');
  const menu = document.querySelector('.import-submenu');
  assert.equal(menu.parentElement === document.body, true, 'the menu is a <body> child');
  assert.equal(modal().contains(menu), false);
  assert.ok(menu.classList.contains('import-submenu--portal'));
  assert.equal(menu.dataset.portaled, '1');
  assert.equal(menu.getAttribute('role'), 'menu');
  assert.equal(trigger().getAttribute('aria-expanded'), 'true');
  assert.equal(trigger().getAttribute('aria-controls'), menu.id);
  assert.deepEqual(menuRows().map(r => r.textContent), ['Image', 'Other file', 'Project artifact']);
  assert.equal(press(menuRows()[0], 'mousedown').defaultPrevented, true, 'a row keeps the focus too');

  // 3. Image with the editor closed: it goes at the end of the text, on a line of its own, and the
  // description stays rendered — the placeholder shows the picked image until the upload lands.
  press(menuRows()[0], 'click');
  assert.equal(document.querySelector('.import-submenu') === null, true);
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  pick(embedRow().querySelector('.embed-image-input'), [png('shot.png')]);
  await tick();
  assert.equal(editor() === null, true, 'the editor opened for the insert closed again');
  // The sanitizer takes http(s) images only: the picked image shows from this page's own blob URL.
  assert.match(display().querySelector('img.modal-desc-pending-image').getAttribute('src'), /^blob:http:\/\/localhost:4455\//);
  assert.equal(status().hidden, false);
  assert.equal(status().textContent, 'Uploading attachment…');
  assert.equal(modal().querySelector('.btn-modal-save').disabled, false, 'the draft is dirty');
  await settle();
  const first = lastImageUpload();
  assert.equal(first.taskKey, 'TPT1', 'linked to the task');
  answerImage(first.blobUrl, 77);
  assert.equal(display().querySelector('img').getAttribute('src'), '/api/images/2/77');
  assert.equal(display().querySelector('img.modal-desc-pending-image') === null, true);
  assert.equal(status().hidden, true);

  // 4. Other file: uploaded with the task key, its link on the line after the image (where the
  // insert left the caret), and the description still rendered.
  openMenu();
  click(menuRows()[1]);
  pick(embedRow().querySelector('.embed-file-input'), [txt('notes.txt')]);
  await settle();
  assert.deepEqual(fileUploads.at(-1), { filename: 'notes.txt', mimeType: 'text/plain', taskKey: 'TPT1' });
  assert.equal(editor() === null, true);
  assert.ok(display().querySelector('a.file-attachment-link'));
  const imageRef = `![img](${API}/images/77)`;
  const fileRef = `[notes.txt](${API}/files/41)`;
  click(modal().querySelector('.btn-modal-save'));
  await settle();
  assert.deepEqual(writes.at(-1), { id: 'TPT1', patch: { description: `Description TPT1\n${imageRef}\n${fileRef}` } });

  // 5. With the editor open the image goes in at its caret. The native file dialog may blur the
  // field; the editor stays open for the file it brings back, and the swap keeps the caret.
  click(display());
  let ta = editor();
  assert.equal(document.activeElement === ta, true);
  const afterWord = 'Description'.length;
  ta.setSelectionRange(afterWord, afterWord);
  openMenu();
  assert.equal(document.activeElement === ta, true, 'the editor kept the focus');
  click(menuRows()[0]);
  ta.blur();
  assert.equal(ta.isConnected, true, 'still open while the dialog is up');
  pick(embedRow().querySelector('.embed-image-input'), [png('second.png')]);
  const blobB = BLOB_REF_RE.exec(ta.value)[1];
  assert.equal(ta.value, `Description![img](${blobB}) TPT1\n${imageRef}\n${fileRef}`, 'exactly at the caret, as in a composer');
  await settle();
  answerImage(lastImageUpload().blobUrl, 78);
  const refB = `![img](${API}/images/78)`;
  assert.equal(ta.value, `Description${refB} TPT1\n${imageRef}\n${fileRef}`);
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], Array(2).fill(afterWord + refB.length));

  // 6. A pasted image counts as an upload: Save waits for it, says so, and saves the URL.
  const pasteAt = ta.value.length;
  ta.setSelectionRange(pasteAt, pasteAt);
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [png('c.png')], items: [] } });
  ta.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, true);
  const saveBtn = modal().querySelector('.btn-modal-save');
  const writesBefore = writes.length;
  click(saveBtn);
  await settle();
  assert.equal(writes.length, writesBefore, 'no save while the image uploads');
  assert.equal(saveBtn.disabled, true);
  assert.equal(saveBtn.textContent, 'Uploading attachment…');
  answerImage(lastImageUpload().blobUrl, 79);
  await settle();
  const refC = `![img](${API}/images/79)`;
  assert.deepEqual(writes.at(-1), { id: 'TPT1', patch: { description: `Description${refB} TPT1\n${imageRef}\n${fileRef}${refC}` } });
  assert.equal(saveBtn.textContent, 'Save');

  // 7. A failed image: its placeholder goes, the caret stays, the error toasts.
  ta.setSelectionRange(afterWord, afterWord);
  const failed = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(failed, 'clipboardData', { value: { files: [png('d.png')], items: [] } });
  ta.dispatchEvent(failed);
  await settle();
  boardSocket().frame({ type: 'image-upload-error', blobUrl: lastImageUpload().blobUrl, error: 'Too large' });
  assert.equal(ta.value, `Description${refB} TPT1\n${imageRef}\n${fileRef}${refC}`);
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [afterWord, afterWord]);
  assert.match(document.body.textContent, /Image upload failed: Too large/);
  assert.equal(status().hidden, true);

  // 8. A file dropped on the rendered description goes in where the editor left the caret, on a
  // line of its own.
  ta.focus();
  ta.blur();
  assert.equal(editor() === null, true, 'the editor closes on an ordinary blur');
  assert.equal(drop(display(), [txt('drop.txt')]).defaultPrevented, true);
  await settle();
  assert.deepEqual(fileUploads.at(-1), { filename: 'drop.txt', mimeType: 'text/plain', taskKey: 'TPT1' });
  click(display());
  ta = editor();
  assert.equal(ta.value, `Description\n[drop.txt](${API}/files/42)\n${refB} TPT1\n${imageRef}\n${fileRef}${refC}`);
  ta.blur();

  // 9. The keyboard: Enter on the trigger focuses the first row, arrows move, Enter picks; Escape
  // closes only the menu (no discard prompt, the modal stays) and gives the focus back.
  trigger().focus();
  trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  assert.equal(document.activeElement === menuRows()[0], true);
  key(menuRows()[0], 'ArrowDown');
  assert.equal(document.activeElement === menuRows()[1], true);
  key(menuRows()[1], 'ArrowDown');
  assert.equal(document.activeElement, menuRows()[2]);
  key(menuRows()[2], 'ArrowDown');
  assert.equal(document.activeElement === menuRows()[0], true, 'wraps');
  key(menuRows()[0], 'Escape');
  assert.equal(document.querySelector('.import-submenu') === null, true);
  assert.equal(document.activeElement === trigger(), true);
  assert.equal(modal().hidden, false);
  assert.equal(document.querySelector('.modal-overlay--over-modal') === null, true);
  trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  key(menuRows()[0], 'ArrowDown');
  key(menuRows()[1], 'Enter');
  assert.equal(document.querySelector('.import-submenu') === null, true);
  assert.equal(document.activeElement === trigger(), true, 'the picked row hands the focus back');
  embedRow().querySelector('.embed-file-input').dispatchEvent(new Event('cancel'));

  // 10. Comments hides the row (the compact description's toggle sits there); General shows it.
  click(modal().querySelector('.modal-tab-btn[data-tab="comments"]'));
  assert.equal(embedRow().hidden, true);
  click(modal().querySelector('.modal-tab-btn[data-tab="general"]'));
  assert.equal(embedRow().hidden, false);

  // 11. Closing the modal with the menu open takes the menu with it.
  openMenu();
  board.closeTaskEditModal(true);
  assert.equal(document.querySelector('.import-submenu') === null, true);

  // 12. A teammate's task (read-only) has no Embed control; an in-progress one hides it until the
  // status leaves in-progress.
  await board.openTaskEditModal('OTHER');
  assert.equal(modal().querySelector('.modal-desc-embed') === null, true);
  board.closeTaskEditModal(true);
  await board.openTaskEditModal('LOCKED');
  assert.equal(embedRow().hidden, true);
  const statusSelect = modal().querySelector('.modal-status-select');
  statusSelect.value = 'pending';
  statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(embedRow().hidden, false);
  board.closeTaskEditModal(true);

  // 13. A `new` proposal has no server task yet: its uploads carry no key, and Save hands the
  // description with the references to the proposal.
  let previewSaved = null;
  await board.openTaskEditModal('new-1', {
    preloadedTask: task('new-1', { description: '' }),
    onSavePreview: async draft => { previewSaved = structuredClone(draft); },
  });
  openMenu();
  click(menuRows()[0]);
  pick(embedRow().querySelector('.embed-image-input'), [png('plan.png')]);
  await settle();
  assert.equal(lastImageUpload().taskKey, null);
  answerImage(lastImageUpload().blobUrl, 80);
  openMenu();
  click(menuRows()[1]);
  pick(embedRow().querySelector('.embed-file-input'), [txt('spec.txt')]);
  await settle();
  assert.equal(fileUploads.at(-1).taskKey, null);
  click(modal().querySelector('.btn-modal-save'));
  await settle();
  assert.equal(previewSaved.description, `![img](${API}/images/80)\n[spec.txt](${API}/files/43)`, 'an empty description gets no leading line');
  board.closeTaskEditModal(true);

  // 14. Diff mode: the row sits under both columns (so right below the PROPOSED description, and the
  // two descriptions keep one height); the PROPOSED description receives the reference. A
  // `modified` card names the live task, so its uploads link to it.
  await board.openTaskEditModal('TPT1', {
    preloadedTask: task('TPT1', { description: 'Proposed text' }),
    compareTask: task('TPT1'),
    onSavePreview: async draft => { previewSaved = structuredClone(draft); },
  });
  assert.equal(modal().querySelector('.modal-scroll-body > .diff-header-row + .modal-desc-embed') !== null, true);
  assert.equal(modal().querySelectorAll('.modal-desc-embed').length, 1);
  openMenu();
  click(menuRows()[0]);
  pick(embedRow().querySelector('.embed-image-input'), [png('diff.png')]);
  await settle();
  assert.equal(lastImageUpload().taskKey, 'TPT1');
  answerImage(lastImageUpload().blobUrl, 81);
  assert.equal(display().dataset.diffSide, 'new');
  assert.ok(display().querySelector('img'));
  click(modal().querySelector('.btn-modal-save'));
  await settle();
  assert.equal(previewSaved.description, `Proposed text\n![img](${API}/images/81)`);
  board.closeTaskEditModal(true);
  console.log('TPT9346_DESCRIPTION_EMBED_PASS');

  // 15. (TPT9361) Several files in one pick, with the editor closed: every reference on a line of
  // its own, in the order picked (files as their uploads land), each upload linked to the task.
  await board.openTaskEditModal('TPT1');
  assert.equal(embedRow().querySelector('.embed-image-input').multiple, true);
  assert.equal(embedRow().querySelector('.embed-file-input').multiple, true);
  openMenu();
  click(menuRows()[0]);
  pick(embedRow().querySelector('.embed-image-input'), [png('a.png'), png('b.png'), png('c.png')]);
  await tick();
  assert.equal(editor() === null, true, 'the description stays rendered');
  assert.equal(display().querySelectorAll('img.modal-desc-pending-image').length, 3);
  await settle();
  const batch = boardSocket().sent.filter(m => m.type === 'upload-image').slice(-3);
  assert.deepEqual(batch.map(m => m.taskKey), ['TPT1', 'TPT1', 'TPT1']);
  batch.forEach((m, i) => answerImage(m.blobUrl, 100 + i));
  openMenu();
  click(menuRows()[1]);
  pick(embedRow().querySelector('.embed-file-input'), [txt('one.txt'), txt('two.txt')]);
  await settle();
  const fileId = name => 41 + fileUploads.findIndex(f => f.filename === name);
  assert.deepEqual(fileUploads.slice(-2).map(f => f.taskKey), ['TPT1', 'TPT1']);
  click(modal().querySelector('.btn-modal-save'));
  await settle();
  assert.deepEqual(writes.at(-1).patch.description.split('\n'), [
    'Description TPT1',
    `![img](${API}/images/100)`,
    `![img](${API}/images/101)`,
    `![img](${API}/images/102)`,
    `[one.txt](${API}/files/${fileId('one.txt')})`,
    `[two.txt](${API}/files/${fileId('two.txt')})`,
  ]);
  board.closeTaskEditModal(true);
  console.log('TPT9361_MULTI_PICK_PASS');

  // Choose an older revision from the second catalog page; identical filenames remain distinct.
  const revision = (id, rev, name) => ({ artifact_id: id, revision: rev, revision_name: name,
    filename: 'survey.csv', mime_type: 'text/csv', size_bytes: 18,
    url: `/api/projects/2/files/artifacts/${id}/revisions/${rev}/content` });
  const recent = revision(7, 2, 'Review');
  const earlier = revision(7, 1, 'Baseline');
  const another = revision(8, 1, 'Baseline');
  api.artifacts.list = async before => before
    ? { revisions: [earlier], next: null }
    : { revisions: [another, recent], next: 12 };
  await board.openTaskEditModal('TPT1');
  openMenu();
  await tick(); // outside-click listener is active
  click(menuRows()[2]);
  await tick();
  ensureGlobalChatBindings(); // a board refresh behind the still-open modal
  assert.match(menuRows()[0].textContent, /#8 · r1 Baseline/);
  assert.match(menuRows()[1].textContent, /#7 · r2 Review/);
  click(menuRows()[2]);
  await tick();
  assert.match(menuRows()[2].textContent, /#7 · r1 Baseline/);
  click(menuRows()[2]);
  await settle();
  assert.equal(display().querySelector('a').getAttribute('href'), earlier.url);
  click(modal().querySelector('.btn-modal-save'));
  await settle();
  assert.equal(writes.at(-1).patch.description, 'Description TPT1\n[survey.csv · r1](' + earlier.url + ')');
  board.closeTaskEditModal(true);
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
