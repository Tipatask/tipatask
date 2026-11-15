// (TPT9315) The task chat composer comes back as tall as its saved draft. Runs the real
// task-chat.js, with the real utils.js autoGrowTextarea(), in a DOM process isolated from
// node:test globals. happy-dom does no layout, so a textarea's scrollHeight is emulated the way a
// browser reports it: one line height per text line while the textarea is rendered, 0 while it is
// display: none — under an ancestor with `hidden`, or the composer footer of a panel that is
// task-chat-panel--connecting or task-chat-panel--gated (styles.css; the test file pins that rule).
// The card's Discuss button opens the chat as the board does (window.TipTask.taskChat.open()), into
// a workspace pane mounted and shown as task-edit-modal.js _showChatPane() does.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:4455/?projectPath=%2Fproj%2Fa' });
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent', 'KeyboardEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame ??= callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame ??= handle => clearTimeout(handle);

const LINE_PX = 21;
const HIDING_PANEL_CLASSES = ['task-chat-panel--connecting', 'task-chat-panel--gated'];
function rendered(el) {
  if (!el.isConnected) return false;
  for (let node = el; node; node = node.parentElement) {
    if (node.hidden) return false;
    if (node.classList.contains('task-chat-footer')) {
      const panel = node.closest('.task-chat-panel');
      if (panel && HIDING_PANEL_CLASSES.some(cls => panel.classList.contains(cls))) return false;
    }
  }
  return true;
}
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'scrollHeight', {
  configurable: true,
  get() { return rendered(this) ? Math.max(1, this.value.split('\n').length) * LINE_PX : 0; },
});

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
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  frame(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}
Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });

globalThis.fetch = async (url) => {
  if (String(url).startsWith('/api/project/chat-history')) return { ok: true, status: 200, json: async () => ({ entries: [] }) };
  return { ok: true, status: 200, json: async () => ({}) };
};
window.TipTask = { fetchActiveSessions: () => Promise.resolve(), taskBoard: { updateClaudeButtons() {} } };

const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', available: true, models: [{ value: 'sonnet' }], defaultModel: 'sonnet' },
];
const HISTORY = [
  { role: 'user', content: 'seed', seed: true },
  { role: 'user', content: 'Earlier question' },
  { role: 'assistant', content: 'Earlier answer' },
];
const FIVE_LINES = 'one\ntwo\nthree\nfour\nfive';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9315-chat-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: "export * as taskChat from './src/client/task-chat.js';"
        + " export * as discuss from './src/client/card-discuss.js';"
        + " export { default as state } from './src/client/state.js';",
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { taskChat, discuss, state } = await import(pathToFileURL(bundlePath).href);
  state.objectiveProviders = PROVIDERS;
  window.TipTask.taskChat = taskChat;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  const query = selector => document.querySelector(selector);
  const input = () => query('.task-chat-input');
  const height = () => input().style.height;
  const lines = n => `${n * LINE_PX}px`;
  const cap = `${Math.round(window.innerHeight * 0.3)}px`;
  const composerHidden = () => HIDING_PANEL_CLASSES.some(cls => query('.task-chat-panel').classList.contains(cls));
  const type = (text) => {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
  };

  // The board card's Discuss button (card-discuss.js; task-card.js openCardDiscuss() ends in
  // window.TipTask.taskChat.open(taskId)) and the workspace it opens: the Chat pane is shown,
  // then the chat is mounted there once and shown — task-edit-modal.js _switchPane('chat').
  const board = document.createElement('div');
  board.innerHTML = `<div class="card" data-id="TPT1">${discuss.discussButtonHtml('TPT1')}</div>`
    + `<div class="card" data-id="TPT2">${discuss.discussButtonHtml('TPT2')}</div>`;
  document.body.appendChild(board);
  for (const btn of board.querySelectorAll('.btn-task-discuss')) {
    discuss.bindDiscussButton(btn, { onActivate: b => window.TipTask.taskChat.open(b.dataset.taskId) });
  }
  const discussButton = key => board.querySelector(`.btn-task-discuss[data-task-id="${key}"]`);
  const pane = document.createElement('div');
  pane.className = 'task-modal-pane task-modal-pane--chat';
  pane.hidden = true;
  document.body.appendChild(pane);
  let workspace = null; // { key, handle }
  window.TipTask.openTaskWorkspace = (key) => {
    if (workspace && workspace.key !== key) closeWorkspace();
    pane.hidden = false;
    if (!workspace) workspace = { key, handle: taskChat.mount(pane, key, { onOpenTask() {}, onClosed() {} }) };
    workspace.handle.show({ focus: true });
  };
  function closeWorkspace() {
    workspace?.handle.dispose();
    workspace = null;
    pane.hidden = true;
  }
  const switchToEdit = () => { workspace.handle.hide(); pane.hidden = true; };
  const switchToChat = () => { pane.hidden = false; workspace.handle.show({ focus: true }); };

  // 1. An existing chat with nothing typed: the composer shows at the one-row height of an empty
  //    input, as before.
  discussButton('TPT1').click();
  let socket = sockets.at(-1);
  assert.match(socket.url, /taskId=taskChat%3ATPT1/);
  assert.equal(composerHidden(), true, 'no composer while the first connect decides');
  socket.frame({ type: 'chat-history-reset', running: false, messages: HISTORY });
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(composerHidden(), false);
  assert.equal(input().value, '');
  assert.equal(height(), lines(1), 'an empty draft keeps the default height');

  // 2. Type five lines, close the workspace, click Discuss again: the draft comes back with all
  //    five lines showing. Before the fix the input kept the zero height it measured while hidden.
  type(FIVE_LINES);
  assert.equal(height(), lines(5), 'the input grows as the user types');
  closeWorkspace();
  assert.equal(query('.task-chat-input'), null, 'the chat is detached');
  discussButton('TPT1').click();
  socket = sockets.at(-1);
  assert.equal(input().value, FIVE_LINES, 'the unsent draft is restored');
  assert.equal(composerHidden(), true);
  socket.frame({ type: 'chat-history-reset', running: false, messages: HISTORY });
  assert.equal(composerHidden(), false, 'the restored history shows the composer');
  assert.equal(height(), lines(5), 'shown at once at the draft\'s height');
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(height(), lines(5), 'all five lines show after reopening');

  // 3. A turn still running when the chat is reopened shows the composer the same way.
  closeWorkspace();
  discussButton('TPT1').click();
  socket = sockets.at(-1);
  socket.frame({ type: 'chat-history-reset', running: true, messages: HISTORY });
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(input().value, FIVE_LINES);
  assert.equal(height(), lines(5));
  socket.frame({ type: 'objective-result', content: 'Done.' });
  socket.frame({ type: 'chat-ready' });
  await settle();
  assert.equal(height(), lines(5), 'the end of the turn leaves the height alone');

  // 4. The history arrives while the user is on another pane, where nothing can be measured:
  //    show() (back on Chat) measures the draft again.
  closeWorkspace();
  discussButton('TPT1').click();
  socket = sockets.at(-1);
  switchToEdit();
  socket.frame({ type: 'chat-history-reset', running: false, messages: HISTORY });
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  switchToChat();
  assert.equal(height(), lines(5), 'show() sizes it to the draft');

  // 5. A long draft comes back at the 30%-of-window cap, scrollable, like a long one being typed.
  const long = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  type(long);
  assert.equal(height(), cap);
  closeWorkspace();
  discussButton('TPT1').click();
  socket = sockets.at(-1);
  socket.frame({ type: 'chat-history-reset', running: false, messages: HISTORY });
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(input().value, long);
  assert.equal(height(), cap);
  assert.equal(input().style.overflowY, 'auto');

  // 6. Sending clears the saved draft: the next open has the default height again.
  type(FIVE_LINES);
  query('.task-chat-send').click();
  assert.equal(socket.sent.at(-1).type, 'task-chat-message');
  assert.equal(height(), lines(1), 'Send empties the input back to one row');
  socket.frame({ type: 'objective-result', content: 'Noted.' });
  socket.frame({ type: 'chat-ready' });
  closeWorkspace();
  discussButton('TPT1').click();
  socket = sockets.at(-1);
  socket.frame({ type: 'chat-history-reset', running: false, messages: HISTORY });
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(input().value, '');
  assert.equal(height(), lines(1));
  closeWorkspace();

  // 7. No chat yet: the start gate hides the composer, so text that lands in the draft there (a
  //    file dropped on the gate inserts its reference) measures zero until Start shows the
  //    composer — then it is sized to the draft.
  discussButton('TPT2').click();
  socket = sockets.at(-1);
  assert.match(socket.url, /taskId=taskChat%3ATPT2/);
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(query('.task-chat-start').hidden, false, 'the start gate shows');
  assert.equal(composerHidden(), true);
  type(FIVE_LINES);
  query('.task-chat-start-go').click();
  assert.deepEqual(socket.sent, [{ type: 'start-task-chat', model: 'claude:sonnet' }]);
  assert.equal(composerHidden(), false);
  assert.equal(height(), lines(5), 'Start shows the composer at the draft\'s height');
  closeWorkspace();

  // 8. The standalone window (no workspace bridge, as the project chat opens) restores the same way.
  delete window.TipTask.openTaskWorkspace;
  await taskChat.open('TPT3');
  socket = sockets.at(-1);
  socket.frame({ type: 'chat-history-reset', running: false, messages: HISTORY });
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(height(), lines(1));
  type(FIVE_LINES);
  taskChat.close();
  await taskChat.open('TPT3');
  socket = sockets.at(-1);
  socket.frame({ type: 'chat-history-reset', running: false, messages: HISTORY });
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(input().value, FIVE_LINES);
  assert.equal(height(), lines(5));
  taskChat.close();
  console.log('TPT9315_COMPOSER_HEIGHT_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
