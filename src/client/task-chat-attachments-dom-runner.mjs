// (TPT9279) Runs the real task-chat.js — with the real paste, Embed and drop helpers it shares
// with the objective chat (task-board.js, embed-menu.js, utils.js) — in a DOM process isolated
// from node:test globals. Each path inserts its image reference at the composer's caret; the
// board socket's blob-to-URL swap keeps the caret where it was, so the next image goes in after
// the last one instead of at the end of the text; a failed upload's placeholder goes and the caret
// stays. The sent turn shows each image where it was inserted, on lines of its own (TPT9411), linked
// to the chat's file viewer — live and restored.
// (TPT9361) The Embed pickers take several files at once, and Send waits for every upload.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { marked } from 'marked';

globalThis.marked = marked;

const window = new Window({ url: 'http://localhost:4455/?projectPath=%2Fproj%2Fa' });
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent', 'KeyboardEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame ??= callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame ??= handle => clearTimeout(handle);

// Node's (and so happy-dom's) blob URLs carry no origin (`blob:nodedata:…`); a browser's carry the
// page's, which the composer's attachment strip checks before showing an image as uploading.
let blobSeq = 0;
URL.createObjectURL = () => `blob:http://localhost:4455/${String(++blobSeq).padStart(8, '0')}-0000-4000-8000-000000000000`;
URL.revokeObjectURL = () => {};

// The upload helper reads the pasted file as a data URL; node has no FileReader.
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
    this.onmessage?.(event);
    for (const fn of this.listeners.get('message') || []) fn(event);
  }
}
Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });

globalThis.fetch = async (url) => {
  if (String(url).startsWith('/api/project/chat-history')) return { ok: true, status: 200, json: async () => ({ entries: [] }) };
  if (String(url).startsWith('/api/tasks/')) return { ok: true, status: 200, json: async () => ({ id: 'TPT1', title: 'Fix the thing' }) };
  return { ok: true, status: 200, json: async () => ({}) };
};
window.TipTask = { fetchActiveSessions: () => Promise.resolve(), taskBoard: { updateClaudeButtons() {} } };

const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', available: true, models: [{ value: 'sonnet' }], defaultModel: 'sonnet' },
];
const API = 'http://127.0.0.1:4454/api/projects/2/images';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9279-chat-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: { contents: "export * as taskChat from './src/client/task-chat.js'; export { default as state } from './src/client/state.js'; export { api } from './src/client/api-client.js';", resolveDir: root },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { taskChat, state, api } = await import(pathToFileURL(bundlePath).href);
  const fileUploads = [];
  api.files.upload = async (filename, mimeType, data, taskKey) => {
    fileUploads.push({ filename, taskKey });
    return { id: fileUploads.length, url: `http://127.0.0.1:4454/api/projects/2/files/${fileUploads.length}`, filename };
  };
  state.objectiveProviders = PROVIDERS;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  const query = selector => document.querySelector(selector);
  const png = name => new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' });
  const txt = name => new File(['notes'], name, { type: 'text/plain' });
  const caret = el => [el.selectionStart, el.selectionEnd];
  const board = () => sockets.find(s => s.url.includes('__board__'));
  // The board socket answers the upload of the image whose `blob:` placeholder is `blobUrl`.
  const uploaded = (blobUrl, id) => board().frame({ type: 'image-uploaded', blobUrl, url: `${API}/${id}` });
  const lastUpload = () => board().sent.filter(m => m.type === 'upload-image').at(-1);
  const BLOB_REF_RE = /!\[img\]\((blob:[^)\s]+)\)/;

  await taskChat.open('TPT1');
  const chat = sockets.at(-1);
  chat.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  query('.task-chat-start-go').click();
  chat.frame({ type: 'objective-result', content: 'Ready.' });
  chat.frame({ type: 'chat-ready' });
  await settle();
  const input = query('.task-chat-input');
  const send = query('.task-chat-send');
  input.value = 'Look at this chart and tell me why it dips';
  input.dispatchEvent(new Event('input', { bubbles: true }));

  // 1. A clipboard image pasted mid-sentence goes in at the caret.
  const afterChart = 'Look at this chart '.length;
  input.focus();
  input.setSelectionRange(afterChart, afterChart);
  const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(pasteEvent, 'clipboardData', { value: { files: [png('a.png')], items: [] } });
  input.dispatchEvent(pasteEvent);
  assert.equal(pasteEvent.defaultPrevented, true, 'the image paste is taken over');
  const blobA = BLOB_REF_RE.exec(input.value)[1];
  assert.equal(input.value, `Look at this chart ![img](${blobA})and tell me why it dips`, 'pasted at the caret');
  assert.equal(send.disabled, true, 'Send waits for the upload');
  // (TPT9410) The composer's attachment strip, between the input and its actions, shows the image
  // still uploading.
  const strip = query('.task-chat-composer > .attachment-strip');
  assert.equal(strip.previousElementSibling === input && strip.nextElementSibling === query('.task-chat-actions'), true);
  const stripTiles = () => [...strip.querySelectorAll('.attachment-tile')];
  assert.equal(strip.hidden, false);
  const tileA = stripTiles()[0];
  assert.equal(tileA.classList.contains('attachment-tile--pending'), true);
  await settle();
  assert.equal(lastUpload().blobUrl, blobA);
  assert.equal(lastUpload().taskKey, 'TPT1', 'a task chat links the image to its task');
  // The upload lands: the placeholder becomes the URL in place, and the caret stays right after it.
  uploaded(blobA, 77);
  const refA = `![img](${API}/77)`;
  assert.equal(input.value, `Look at this chart ${refA}and tell me why it dips`);
  assert.deepEqual(caret(input), [afterChart + refA.length, afterChart + refA.length], 'the swap keeps the caret');
  assert.equal(send.disabled, false);
  assert.equal(stripTiles()[0] === tileA, true, 'the placeholder tile carries on as the image');
  assert.equal(tileA.classList.contains('attachment-tile--pending'), false);
  assert.equal(tileA.dataset.key, '/api/images/2/77');

  // 2. Embed ▸ Image goes in at that caret: right after the first image, not at the end.
  query('.task-chat-embed-slot .embed-menu-trigger').click();
  const rows = [...document.querySelectorAll('.task-chat-embed-slot .import-submenu-item')];
  assert.equal(rows.length, 3, 'Image / Other file / Project artifact');
  rows[0].click();
  const picker = query('.task-chat-embed-slot .embed-image-input');
  Object.defineProperty(picker, 'files', { value: [png('b.png')], configurable: true });
  picker.dispatchEvent(new Event('change'));
  const blobB = BLOB_REF_RE.exec(input.value)[1];
  assert.equal(input.value, `Look at this chart ${refA}![img](${blobB})and tell me why it dips`, 'embedded at the caret');
  await settle();
  uploaded(blobB, 78);
  const refB = `![img](${API}/78)`;
  assert.equal(input.value, `Look at this chart ${refA}${refB}and tell me why it dips`);
  assert.deepEqual(caret(input), Array(2).fill(afterChart + refA.length + refB.length));

  // 3. A file dropped on the panel goes in at the caret too — here, moved to before "why".
  const beforeWhy = input.value.indexOf('why');
  input.setSelectionRange(beforeWhy, beforeWhy);
  const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(dropEvent, 'dataTransfer', { value: { types: ['Files'], files: [png('c.png')] } });
  query('.task-chat-panel').dispatchEvent(dropEvent);
  assert.equal(dropEvent.defaultPrevented, true);
  const blobC = BLOB_REF_RE.exec(input.value)[1];
  assert.equal(input.value, `Look at this chart ${refA}${refB}and tell me ![img](${blobC})why it dips`, 'dropped at the caret');
  await settle();
  uploaded(blobC, 79);
  const refC = `![img](${API}/79)`;
  const content = `Look at this chart ${refA}${refB}and tell me ${refC}why it dips`;
  assert.equal(input.value, content);
  assert.deepEqual(caret(input), Array(2).fill(beforeWhy + refC.length));

  assert.deepEqual(stripTiles().map(tile => tile.dataset.key), ['/api/images/2/77', '/api/images/2/78', '/api/images/2/79']);

  // 4. Send: the turn carries the references, and shows every image where it was inserted: a block
  // of its own lines (TPT9411), its text around it without the blanks that touched it.
  send.click();
  assert.equal(strip.hidden, true, 'the sent text takes its tiles along');
  assert.equal(stripTiles().length, 0);
  console.log('TPT9410_TASK_CHAT_STRIP_PASS');
  assert.deepEqual(chat.sent.at(-1), { type: 'task-chat-message', content, model: 'claude:sonnet' });
  const nodes = bubble => [...bubble.querySelector('.task-chat-user-text').childNodes].map((n) => {
    if (n.nodeType === 3) return n.textContent;
    const link = n.querySelector(':scope > a.md-image-link');
    return `${n.tagName.toLowerCase()}.${[...n.classList].join('.')}>${link ? 'a.md-image-link>' : ''}${n.querySelector('img').getAttribute('src')}`;
  });
  const expected = [
    'Look at this chart',
    'span.md-image>a.md-image-link>/api/images/2/77',
    'span.md-image>a.md-image-link>/api/images/2/78',
    'and tell me',
    'span.md-image>a.md-image-link>/api/images/2/79',
    'why it dips',
  ];
  const live = [...document.querySelectorAll('.task-chat-msg--user')].at(-1);
  assert.deepEqual(nodes(live), expected, 'live: each image on lines of its own, in order');
  assert.equal(live.querySelector('img').getAttribute('alt'), 'Image');
  assert.equal(live.querySelector('img').getAttribute('loading'), 'lazy');
  chat.frame({ type: 'objective-result', content: 'It dips on Mondays.' });
  chat.frame({ type: 'chat-ready' });
  await settle();

  // 5. A failed upload drops its placeholder and leaves the caret on its text.
  input.value = 'abcd';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.setSelectionRange(2, 2);
  const failed = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(failed, 'clipboardData', { value: { files: [png('d.png')], items: [] } });
  input.dispatchEvent(failed);
  const blobD = BLOB_REF_RE.exec(input.value)[1];
  await settle();
  board().frame({ type: 'image-upload-error', blobUrl: blobD, error: 'Too large' });
  assert.equal(input.value, 'abcd');
  assert.deepEqual(caret(input), [2, 2], 'the caret stays between b and c');
  assert.equal(send.disabled, false);

  // 6. Restored from the server's history (reopen / reattach), the turn renders the same way.
  chat.frame({ type: 'chat-history-reset', messages: [
    { role: 'user', content: 'seed', seed: true },
    { role: 'assistant', content: 'Ready.' },
    { role: 'user', content },
    { role: 'assistant', content: 'It dips on Mondays.' },
  ] });
  await settle();
  const restored = [...document.querySelectorAll('.task-chat-msg--user')];
  assert.equal(restored.length, 1);
  assert.deepEqual(nodes(restored[0]), expected, 'restored: each image on lines of its own, in order');

  // 7. (TPT9361) Both pickers take several files at once: each one uploads on its own, every
  // reference lands, and Send waits for the last upload.
  const imagePicker = query('.task-chat-embed-slot .embed-image-input');
  const filePicker = query('.task-chat-embed-slot .embed-file-input');
  assert.equal(imagePicker.multiple, true);
  assert.equal(filePicker.multiple, true);
  input.value = 'Three shots: ';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.setSelectionRange(input.value.length, input.value.length);
  query('.task-chat-embed-slot .embed-menu-trigger').click();
  document.querySelectorAll('.task-chat-embed-slot .import-submenu-item')[0].click();
  Object.defineProperty(imagePicker, 'files', { value: [png('e.png'), png('f.png'), png('g.png')], configurable: true });
  imagePicker.dispatchEvent(new Event('change'));
  const picked = [...input.value.matchAll(/!\[img\]\((blob:[^)\s]+)\)/g)].map(m => m[1]);
  assert.equal(picked.length, 3, 'one placeholder per picked image');
  assert.equal(send.disabled, true);
  await settle();
  assert.deepEqual(board().sent.filter(m => m.type === 'upload-image').slice(-3).map(m => m.blobUrl), picked, 'one upload each, in order');
  uploaded(picked[0], 90);
  uploaded(picked[1], 91);
  assert.equal(send.disabled, true, 'Send waits for the last image');
  uploaded(picked[2], 92);
  assert.equal(send.disabled, false);
  assert.equal(input.value, `Three shots: ![img](${API}/90)![img](${API}/91)![img](${API}/92)`);
  query('.task-chat-embed-slot .embed-menu-trigger').click();
  document.querySelectorAll('.task-chat-embed-slot .import-submenu-item')[1].click();
  Object.defineProperty(filePicker, 'files', { value: [txt('a.txt'), txt('b.txt')], configurable: true });
  filePicker.dispatchEvent(new Event('change'));
  assert.equal(send.disabled, true, 'Send waits for the files');
  await settle();
  assert.deepEqual(fileUploads.map(f => f.filename), ['a.txt', 'b.txt']);
  assert.equal(send.disabled, false);
  assert.deepEqual(stripTiles().map(tile => tile.querySelector('.attachment-tile-name')?.textContent ?? tile.dataset.key),
    ['/api/images/2/90', '/api/images/2/91', '/api/images/2/92', 'a.txt', 'b.txt']);
  assert.match(input.value, /\[a\.txt\]\(http:\/\/127\.0\.0\.1:4454\/api\/projects\/2\/files\/1\)/);
  assert.match(input.value, /\[b\.txt\]\(http:\/\/127\.0\.0\.1:4454\/api\/projects\/2\/files\/2\)/);
  // Two links from one reply. A slow attachment must fill only its original tab, and
  // closing that tab mid-request must never reopen it or replace a newer chat's contents.
  let answerAttachment;
  let attachmentSignal;
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    requests.push(url);
    if (url === '/api/files/2/1') {
      attachmentSignal = opts.signal;
      return new Promise(resolve => { answerAttachment = () => resolve(new Response('Attached notes', { headers: { 'Content-Type': 'text/plain' } })); });
    }
    if (url === '/api/project/file-preview?path=reports%2Fcheck.sql') {
      return Promise.resolve(Response.json({ kind: 'text', content: 'select 1;\nselect 2;' }));
    }
    return originalFetch(url, opts);
  };
  chat.frame({ type: 'chat-history-reset', messages: [
    { role: 'user', content: '[a.txt](/api/files/2/1)' },
    { role: 'assistant', content: '[a.txt](/api/files/2/1) and [check.sql](reports/check.sql#L2)' },
  ] });
  const links = query('.task-chat-md').querySelectorAll('a');
  links[0].click();
  links[1].click();
  answerAttachment();
  await settle();
  const tabs = () => [...document.querySelectorAll('.preview-drawer [role="tab"]')];
  assert.deepEqual(tabs().map(tab => tab.title), ['a.txt', 'reports/check.sql']);
  assert.equal(tabs()[1].getAttribute('aria-selected'), 'true');
  assert.equal(query('.preview-drawer-panel:not([hidden]) code').textContent, 'select 1;\nselect 2;');
  // (TPT9411) The user turn's file chip, in its text, opens in the viewer too.
  query('.task-chat-msg--user .task-chat-user-text > a.file-attachment-link').click();
  assert.equal(query('.preview-drawer-panel:not([hidden]) code').textContent, 'Attached notes');
  assert.equal(requests.filter(url => url === '/api/files/2/1').length, 1);
  input.value = 'Keep going';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  send.click();
  assert.equal(chat.sent.at(-1).content, 'Keep going');
  chat.frame({ type: 'objective-result', content: 'Done.' });
  assert.equal(tabs().length, 2);
  query('.preview-drawer-tab--active .preview-drawer-tab-close').click();
  assert.equal(attachmentSignal.aborted, true);
  links[0].click();
  const pending = attachmentSignal;
  taskChat.close();
  answerAttachment();
  await settle();
  assert.equal(pending.aborted, true);
  assert.equal(document.querySelectorAll('.preview-drawer').length, 0);
  console.log('TPT9279_INLINE_IMAGES_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
