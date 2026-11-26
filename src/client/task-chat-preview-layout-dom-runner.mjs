// (TPT9408) Opening a file preview switches the chat window's layout — the standalone window fills
// the app window and the transcript becomes a slim column, so it reflows much taller — and closing
// the last tab switches it back. Runs the real task-chat.js and preview-drawer.js in a DOM process
// isolated from node:test globals. happy-dom does no layout, so the transcript's geometry is
// emulated: each message is taller while the panel carries task-chat-panel--with-drawer (the slim
// column), and the transcript's view moves and grows with the full window. The transcript keeps its
// place across both switches: the file link just clicked stays where it was in the view, a
// transcript at its end stays at its end, and on close the element at the top keeps the same share
// of it above the view's edge. With the preview open the composer still sends.
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

// ── Layout emulation ──
// The centred 880 px window vs the full window with a 360 px chat column (styles.css
// .task-chat-modal > .task-chat-panel--with-drawer; preview-drawer.js MIN_TRANSCRIPT_WIDTH).
const WIDE = { top: 108, height: 487 };
const SLIM = { top: 51, height: 601 };
const PAD_TOP = 20;
const PAD_BOTTOM = 12;
const SLIM_FACTOR = 2.5;            // a message wraps to 2.5× its height in the slim column
const LINK_AT = 0.4;               // a message's file link sits 40% of the way down it
const LINK_HEIGHT = 20;
const BASE_HEIGHTS = [120, 70, 260, 70, 340, 90, 300, 80];

const panel = () => document.querySelector('.task-chat-panel');
const scroller = () => document.querySelector('.task-chat-scroll');
const slim = () => !!panel()?.classList.contains('task-chat-panel--with-drawer');
const view = () => (slim() ? SLIM : WIDE);
const messageEls = () => [...document.querySelectorAll('.task-chat-messages > .task-chat-msg')];
const heightOf = i => Math.round(BASE_HEIGHTS[i % BASE_HEIGHTS.length] * (slim() ? SLIM_FACTOR : 1));
const contentHeight = () => messageEls().reduce((sum, _, i) => sum + heightOf(i), 0);
const scrollHeightNow = () => PAD_TOP + contentHeight() + PAD_BOTTOM;
const maxScroll = () => Math.max(0, scrollHeightNow() - view().height);
let scrollPos = 0;
// A layout change that shortens the content clamps the position at once, as a browser does.
const pos = () => Math.min(scrollPos, maxScroll());
let scrollQueued = false;

function rectAt(top, height) {
  return { top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top };
}
const ZERO = rectAt(0, 0);

function emulatedRect(el) {
  const s = scroller();
  if (!s || !el.isConnected || !s.contains(el)) return ZERO;
  if (el === s) return rectAt(view().top, view().height);
  const listTop = view().top + PAD_TOP - pos();
  if (el.classList.contains('task-chat-messages')) return rectAt(listTop, contentHeight());
  const msgs = messageEls();
  const msg = el.closest('.task-chat-msg');
  const i = msgs.indexOf(msg);
  if (i < 0) return ZERO;
  let top = listTop;
  for (let j = 0; j < i; j++) top += heightOf(j);
  const height = heightOf(i);
  if (el.tagName === 'A') return rectAt(top + Math.round(height * LINK_AT), LINK_HEIGHT);
  return rectAt(top, height);
}

window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() { return emulatedRect(this); };
window.HTMLElement.prototype.getClientRects = function getClientRects() {
  const r = emulatedRect(this);
  return r.height ? [r] : [];
};

// The browser clamps scrollTop to the content and fires `scroll` after it moves.
function installScroller(s) {
  Object.defineProperty(s, 'scrollHeight', { configurable: true, get: () => scrollHeightNow() });
  Object.defineProperty(s, 'clientHeight', { configurable: true, get: () => view().height });
  Object.defineProperty(s, 'scrollTop', {
    configurable: true,
    get: () => pos(),
    set(value) {
      const next = Math.min(Math.max(0, Math.round(Number(value) || 0)), maxScroll());
      if (next === pos()) return;
      scrollPos = next;
      if (scrollQueued) return;
      scrollQueued = true;
      setTimeout(() => { scrollQueued = false; s.dispatchEvent(new Event('scroll')); }, 0);
    },
  });
}

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
    sockets.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  frame(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}
Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });

globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.startsWith('/api/project/chat-history')) return { ok: true, status: 200, json: async () => ({ entries: [] }) };
  if (path.startsWith('/api/project/file-preview')) {
    return { ok: true, status: 200, json: async () => ({ kind: 'text', content: 'const x = 1;\n'.repeat(60) }) };
  }
  if (path.startsWith('/api/tasks/')) return { ok: true, status: 200, json: async () => ({ id: 'TPT1', title: 'Fix the thing' }) };
  return { ok: true, status: 200, json: async () => ({}) };
};
window.TipTask = { fetchActiveSessions: () => Promise.resolve(), taskBoard: { updateClaudeButtons() {} } };

const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', available: true, models: [{ value: 'sonnet' }], defaultModel: 'sonnet' },
];
const TRANSCRIPT = [
  { role: 'assistant', content: 'Hello. What would you like to discuss?' },
  { role: 'user', content: 'Where are the accepted file types?' },
  { role: 'assistant', content: 'They are listed in [the files doc](ai/architecture/tt-api-files.md#L21).' },
  { role: 'user', content: 'And the drawer?' },
  { role: 'assistant', content: 'See [the drawer](src/client/preview-drawer.js#L38) for its width rules.' },
  { role: 'user', content: 'Thanks.' },
  { role: 'assistant', content: 'The window layout is in [the chat doc](ai/architecture/tt-task-chat.md).' },
  { role: 'user', content: 'One more question.' },
];

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9408-chat-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: "export * as taskChat from './src/client/task-chat.js'; export { default as state } from './src/client/state.js';",
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { taskChat, state } = await import(pathToFileURL(bundlePath).href);
  state.objectiveProviders = PROVIDERS;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
  const query = selector => document.querySelector(selector);
  const link = text => [...document.querySelectorAll('.task-chat-md a')].find(a => a.textContent === text);
  const offsetOf = el => el.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
  const fromBottom = () => maxScroll() - pos();
  // The user scrolls: the position moves, then the browser's scroll event.
  const userScroll = async (top) => { scroller().scrollTop = top; await settle(); };

  await taskChat.open('TPT1');
  installScroller(scroller());
  const chat = sockets.at(-1);
  chat.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  query('.task-chat-start-go').click();
  chat.frame({ type: 'objective-result', content: 'Ready.' });
  chat.frame({ type: 'chat-ready' });
  await settle();
  chat.frame({ type: 'chat-history-reset', messages: TRANSCRIPT });
  await settle();
  assert.equal(messageEls().length, TRANSCRIPT.length, 'the transcript is drawn');
  assert.equal(slim(), false);

  // 1. Scrolled up: the clicked (focused) link stays where it was in the transcript's view,
  //    though the slim column makes everything above it much taller.
  const files = link('the files doc');
  await userScroll(Math.round(offsetOf(files) + pos() - 300));
  assert.ok(fromBottom() > 64, 'not at the end');
  const before = offsetOf(files);
  assert.ok(before > 0 && before < WIDE.height, `the link is in view (${before})`);
  files.focus();
  files.click();
  await settle();
  assert.equal(slim(), true, 'the drawer opened and the panel switched to the slim column');
  assert.ok(query('.preview-drawer-panel:not([hidden]) .file-preview-source'), 'the file is shown');
  assert.equal(Math.abs(offsetOf(files) - before) <= 1, true, `the clicked link stays put: ${before} → ${offsetOf(files)}`);
  assert.ok(fromBottom() > 64, 'and the transcript is still not at its end');

  // 3. Closing the last tab: the element at the top keeps the same share of it above the edge.
  const msgs = messageEls();
  let mid = 0;
  for (let j = 0; j < 4; j++) mid += heightOf(j);
  await userScroll(PAD_TOP + mid + Math.round(heightOf(4) * 0.6));
  const topMsg = msgs[4];
  const shareBefore = -offsetOf(topMsg) / heightOf(4);
  assert.ok(shareBefore > 0.55 && shareBefore < 0.65, `the edge cuts message 5 (${shareBefore})`);
  query('.preview-drawer-close').click();
  await settle();
  assert.equal(slim(), false, 'closed: the centred window is back');
  const shareAfter = -offsetOf(topMsg) / heightOf(4);
  assert.equal(Math.abs(shareAfter - shareBefore) < 0.01, true, `same share above the edge: ${shareBefore} → ${shareAfter}`);
  assert.equal(document.activeElement === files, true, 'focus is back on the link that opened the file');

  // 2. At the end: the transcript stays at its end when the preview opens.
  await userScroll(maxScroll());
  assert.equal(fromBottom(), 0);
  const last = link('the chat doc');
  last.click();
  await settle();
  assert.equal(slim(), true);
  assert.equal(fromBottom(), 0, 'still at its end in the slim column');

  // 4. With the preview open the composer sends, and the reply follows at the end.
  const input = query('.task-chat-input');
  input.value = 'Show me line 40 too';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(query('.task-chat-send').disabled, false);
  query('.task-chat-send').click();
  await settle();
  assert.equal(chat.sent.at(-1).type, 'task-chat-message');
  assert.equal(chat.sent.at(-1).content, 'Show me line 40 too');
  assert.equal(input.value, '');
  assert.ok(query('.preview-drawer'), 'the preview stays open');
  chat.frame({ type: 'objective-result', content: 'Line 40 sets the width.' });
  chat.frame({ type: 'chat-ready' });
  await settle();
  assert.equal(fromBottom(), 0, 'the new turn is followed at the end');

  // Closing the window with the preview open leaves nothing behind.
  taskChat.close();
  assert.equal(document.querySelectorAll('.preview-drawer, .task-chat-modal').length, 0);
  console.log('TPT9408_PREVIEW_LAYOUT_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
