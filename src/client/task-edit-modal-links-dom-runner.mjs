// (TPT9411) Runs the real Task Edit modal in a DOM process isolated from node:test globals: the
// rendered description shows an image mid-sentence as a block of its own and a file link as an
// inline chip; a click on the chip downloads it through the system browser (file-attach.js) and
// never opens the editor, Enter on the focused chip is left to the link, a click on the image opens
// the lightbox, and a click on the text still opens the editor.
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

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = FakeWebSocket.OPEN; }
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() { this.readyState = FakeWebSocket.CLOSED; }
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
const temporary = mkdtempSync(join(tmpdir(), 'tpt9411-links-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: `export * as board from './src/client/task-board.js';
        export { default as state } from './src/client/state.js';
        export { api } from './src/client/api-client.js';
        export { ensureFileLinkHandler } from './src/client/file-attach.js';`,
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { board, state, api, ensureFileLinkHandler } = await import(pathToFileURL(bundlePath).href);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  // happy-dom's parser drops the first block's tag when the sanitizer reparses the markup (a real
  // browser keeps it), so the paragraph under test comes second.
  const description = '## Repro\n\n'
    + `Read [notes.txt](${API}/files/7) first. Look at this ![chart](${API}/images/4) and compare.\n`
    + 'See [docs](https://example.com/docs).';
  const task = {
    id: 'TPT1', title: 'Title', description, status: 'pending', category: 'CODING', priority: 1,
    tags: [], dependencies: [], assignee: 1, agentAssignee: null,
  };
  state.currentUserId = 1;
  state.projectMembers = [{ id: 1, user_id: 1, name: 'Alice' }];
  api.tasks.get = async () => structuredClone(task);
  api.tasks.listAll = async () => [structuredClone(task)];
  api.tasks.update = async () => ({});
  api.members.list = async () => state.projectMembers;
  api.tasks.comments.list = async () => [];
  api.tasks.events.list = async () => ({ events: [], subscribed: true });

  const modal = () => document.getElementById('task-edit-modal');
  const display = () => modal().querySelector('.modal-desc-display:not([data-diff-side="old"])');
  const editor = () => modal().querySelector('.modal-desc-textarea');
  const press = (el, type) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, detail: 1 });
    el.dispatchEvent(event);
    return event;
  };
  const click = el => { press(el, 'mousedown'); return press(el, 'click'); };

  await board.openTaskEditModal('TPT1');
  await settle();
  // The app binds the download handler at boot (index.js); the system browser is a recorder here.
  ensureFileLinkHandler();
  const opened = [];
  window.electronAPI = { openExternal: href => opened.push(href) };
  // Runs after every handler: records what they left, then stops happy-dom's own navigation.
  let followed = null;
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('a[href]')) return;
    followed = !e.defaultPrevented;
    e.preventDefault();
  });

  // 1. The image is a block between the two halves of its sentence, the file a chip in the line.
  const paragraph = display().querySelector('a.file-attachment-link').parentElement;
  assert.equal(paragraph.tagName, 'P');
  const flow = [...paragraph.childNodes].map((n) => {
    if (n.nodeType === 3) return n.textContent;
    if (n.classList.contains('md-image')) return `image ${n.querySelector('img').getAttribute('src')}`;
    if (n.classList.contains('file-attachment-link')) return `file ${n.getAttribute('href')} ${n.textContent}`;
    return `${n.tagName.toLowerCase()} ${n.getAttribute('href') || ''}`;
  });
  assert.deepEqual(flow, [
    'Read ',
    'file /api/files/2/7 notes.txt',
    ' first. Look at this',
    'image /api/images/2/4',
    'and compare.',
    'br ',
    'See ',
    'a https://example.com/docs',
    '.',
  ]);

  // 2. A click on the chip downloads the file and leaves the description rendered.
  const chip = display().querySelector('a.file-attachment-link');
  click(chip.querySelector('.file-attachment-name'));
  assert.equal(editor(), null, 'a chip click never opens the editor');
  assert.deepEqual(opened, ['http://localhost:4455/api/files/2/7'], 'downloaded through the system browser');
  assert.equal(followed, false, 'the download handler took the click');

  // 3. Enter on the focused chip is the link's: the description does not take it for the editor.
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  chip.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false);
  assert.equal(editor(), null);

  // 4. A web link is followed, without the editor.
  click(display().querySelector('a[href="https://example.com/docs"]'));
  assert.equal(followed, true, 'left to the link');
  assert.equal(editor(), null);

  // 5. The image opens the lightbox, not the editor.
  click(display().querySelector('.md-image img'));
  const lightbox = document.querySelector('.img-lightbox-overlay');
  assert.ok(lightbox, 'the image opens in the lightbox');
  assert.equal(editor(), null);
  click(lightbox);
  assert.equal(document.querySelector('.img-lightbox-overlay'), null);

  // 6. The text itself still opens the editor.
  click(paragraph);
  assert.ok(editor(), 'a click on the text opens the editor');
  assert.equal(editor().value, description);
  board.closeTaskEditModal(true);
  console.log('TPT9411_DESCRIPTION_LINKS_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
