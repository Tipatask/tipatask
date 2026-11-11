// (TPT9268/TPT9271) Runs the real task-chat.js in a DOM process isolated from node:test globals:
// every open lands on the start gate with the task chat's models and the saved choice — a model
// passed to open() ({ model }) is only preselected there — nothing runs until Start chat, which
// starts the selected model once; Cancel closes; an existing chat keeps its transcript and sends
// its next message with the passed model; a model the server does not offer is named on the gate.
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

const fetches = [];
globalThis.fetch = async (url) => {
  fetches.push(String(url));
  if (String(url).startsWith('/api/project/chat-history')) return { ok: true, status: 200, json: async () => ({ entries: [] }) };
  if (String(url).startsWith('/api/tasks/')) return { ok: true, status: 200, json: async () => ({ id: 'TPT1', title: 'Fix the thing' }) };
  return { ok: true, status: 200, json: async () => ({}) };
};
window.TipTask = { fetchActiveSessions: () => Promise.resolve(), taskBoard: { updateClaudeButtons() {} } };

// The `config` frame's list: gemini is never a task-chat provider, and Pi's tool-less row is dropped.
const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', available: true, models: [{ value: 'sonnet' }, { value: 'opus' }], defaultModel: 'sonnet' },
  { id: 'codex', label: 'Codex', available: true, models: [{ value: 'gpt-5.1' }], defaultModel: 'gpt-5.1' },
  { id: 'pi', label: 'Pi', available: true, models: [{ value: 'qwen' }, { value: 'notools' }], toolLessModels: ['notools'] },
  { id: 'gemini', label: 'Gemini', available: true, models: [{ value: 'pro' }] },
];

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9268-chat-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: { contents: "export * as taskChat from './src/client/task-chat.js'; export { default as state } from './src/client/state.js';", resolveDir: root },
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
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  const query = selector => document.querySelector(selector);
  const gateShown = () => query('.task-chat-start')?.hidden === false;
  const historyReads = () => fetches.filter(u => u.startsWith('/api/project/chat-history')).length;
  const stored = () => localStorage.getItem('tipatask-task-chat-model');

  // 1. No chat yet, opened with a model: the start gate shows with that model selected and nothing
  //    is sent — no agent until Start chat. Start sends one frame on that model, once, and only
  //    then saves it as the sticky choice.
  localStorage.setItem('tipatask-task-chat-model', 'claude:sonnet');
  await taskChat.open('TPT1', { model: 'codex:gpt-5.1' }); // no workspace bridge: the standalone window
  let socket = sockets.at(-1);
  assert.match(socket.url, /taskId=taskChat%3ATPT1/);
  assert.equal(socket.sent.length, 0, 'nothing is sent before the server says whether the chat exists');
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(socket.sent.length, 0, 'opening spawns no agent');
  assert.equal(gateShown(), true, 'the start gate shows');
  assert.ok(query('.task-chat-panel').classList.contains('task-chat-panel--gated'));
  assert.equal(query('#task-chat-start-model-select').value, 'codex:gpt-5.1', 'the gate selector holds the preselected model');
  const offered = [...query('#task-chat-start-model-select').options].map(o => o.value);
  assert.deepEqual(offered, ['claude:sonnet', 'claude:opus', 'codex:gpt-5.1', 'pi:qwen'], 'the task chat\'s own models only');
  assert.equal(query('.task-chat-start-note').hidden, true);
  assert.equal(stored(), 'claude:sonnet', 'a preselection is not saved until Start chat runs it');
  query('.task-chat-start-go').click();
  query('.task-chat-start-go').click();
  assert.deepEqual(socket.sent, [{ type: 'start-task-chat', model: 'codex:gpt-5.1' }], 'Start chat launches the selected model once');
  assert.equal(gateShown(), false);
  assert.equal(stored(), 'codex:gpt-5.1', 'the started model is the sticky choice now');
  assert.ok(query('.task-chat-panel').classList.contains('task-chat-panel--running'), 'the opening turn runs');
  // The opening turn lands; the next message keeps the chosen model.
  socket.frame({ type: 'objective-result', content: 'Here is what I see.' });
  socket.frame({ type: 'chat-ready' });
  await settle();
  query('.task-chat-input').value = 'Go on';
  query('.task-chat-input').dispatchEvent(new Event('input', { bubbles: true }));
  query('.task-chat-send').click();
  assert.deepEqual(socket.sent.at(-1), { type: 'task-chat-message', content: 'Go on', model: 'codex:gpt-5.1' });
  socket.frame({ type: 'chat-ready' });
  // The preselection is applied once: a dropped socket's Retry reconnects to the gate.
  socket.onclose?.();
  await settle();
  const retry = query('.task-chat-retry');
  assert.ok(retry, 'the disconnect notice offers a reconnect');
  retry.click();
  const again = sockets.at(-1);
  assert.notEqual(again, socket);
  again.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(again.sent.length, 0, 'no start frame');
  assert.equal(gateShown(), true);
  taskChat.close();

  // Cancel on the gate closes the window and sends nothing.
  await taskChat.open('TPT1', { model: 'pi:qwen' });
  socket = sockets.at(-1);
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(gateShown(), true);
  query('.task-chat-start-cancel').click();
  await settle();
  assert.equal(socket.sent.length, 0, 'Cancel starts nothing');
  assert.equal(query('.task-chat-start'), null, 'Cancel closes the chat');
  assert.equal(stored(), 'codex:gpt-5.1', 'a cancelled preselection is not saved');

  // 2. The chat exists: its transcript comes back, nothing is started, and the pick answers the
  //    next message even though the server's own selection was another model. (happy-dom drops
  //    <option selected> from innerHTML and leaves a rebuilt select on its second row,
  //    claude:opus, so neither the pick nor the server's selection here is that row.)
  await taskChat.open('TPT1', { model: 'pi:qwen' });
  socket = sockets.at(-1);
  socket.frame({
    type: 'chat-history-reset',
    running: false,
    objectiveSelection: 'codex:gpt-5.1',
    messages: [
      { role: 'user', content: 'seed', seed: true },
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ],
  });
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(socket.sent.length, 0, 'an existing chat is not started again');
  assert.equal(gateShown(), false);
  assert.ok(query('.task-chat-messages').textContent.includes('Earlier answer'), 'the transcript stays');
  assert.equal(query('#task-chat-model-select').value, 'pi:qwen');
  assert.equal(stored(), 'pi:qwen', 'the pick is the sticky choice now');
  query('.task-chat-input').value = 'Next question';
  query('.task-chat-input').dispatchEvent(new Event('input', { bubbles: true }));
  query('.task-chat-send').click();
  assert.deepEqual(socket.sent, [{ type: 'task-chat-message', content: 'Next question', model: 'pi:qwen' }]);
  taskChat.close();

  // 3. A model the server does not offer (here Pi's tool-less row) starts nothing: the gate shows,
  //    naming the missed model, with the chat's own default selected; Start then works as before.
  await taskChat.open('TPT1', { model: 'pi:notools' });
  socket = sockets.at(-1);
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(socket.sent.length, 0);
  assert.equal(gateShown(), true);
  const note = query('.task-chat-start-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /notools is not available for chat right now/);
  const gateModel = query('#task-chat-start-model-select').value;
  assert.notEqual(gateModel, 'pi:notools', 'never the refused pick');
  assert.ok(['claude:sonnet', 'claude:opus', 'codex:gpt-5.1', 'pi:qwen'].includes(gateModel), 'one of the offered models');
  assert.notEqual(stored(), 'pi:notools', 'the refused pick is not remembered');
  query('.task-chat-start-go').click();
  assert.deepEqual(socket.sent, [{ type: 'start-task-chat', model: gateModel }]);
  taskChat.close();

  // Picking another model on the gate clears the note.
  await taskChat.open('TPT1', { model: 'codex:retired' });
  socket = sockets.at(-1);
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(query('.task-chat-start-note').hidden, false);
  const gateSelect = query('#task-chat-start-model-select');
  gateSelect.value = 'pi:qwen';
  gateSelect.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(query('.task-chat-start-note').hidden, true);
  taskChat.close();

  // 4. Without a model (the card Discuss button, every other opener) the gate shows the saved choice.
  localStorage.setItem('tipatask-task-chat-model', 'pi:qwen');
  const readsBefore = historyReads();
  await taskChat.open('TPT1');
  socket = sockets.at(-1);
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(socket.sent.length, 0);
  assert.equal(gateShown(), true);
  assert.equal(query('#task-chat-start-model-select').value, 'pi:qwen', 'the saved choice is selected');
  query('.task-chat-start-go').click();
  assert.deepEqual(socket.sent, [{ type: 'start-task-chat', model: 'pi:qwen' }], 'the saved choice is the selection');
  assert.equal(historyReads(), readsBefore + 1, 'the gate reads its history picker');
  taskChat.close();

  // 5. A workspace pane: mounted with a model it shows the gate with that model selected; a
  //    model for the chat already mounted there only changes the gate's selection.
  const host = document.createElement('div');
  document.body.appendChild(host);
  let handle = taskChat.mount(host, 'TPT2', { onOpenTask() {}, onClosed() {}, launch: { model: 'claude:sonnet' } });
  socket = sockets.at(-1);
  assert.match(socket.url, /taskId=taskChat%3ATPT2/);
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(socket.sent.length, 0, 'mounting spawns no agent');
  assert.equal(gateShown(), true);
  assert.equal(query('#task-chat-start-model-select').value, 'claude:sonnet');
  handle.dispose();
  handle = taskChat.mount(host, 'TPT2', { onOpenTask() {}, onClosed() {} });
  socket = sockets.at(-1);
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(gateShown(), true, 'no model: the gate');
  handle.launch({ model: 'codex:gpt-5.1' });
  assert.equal(socket.sent.length, 0, 'a later model on the gate starts nothing');
  assert.equal(gateShown(), true);
  assert.equal(query('#task-chat-start-model-select').value, 'codex:gpt-5.1');
  query('.task-chat-start-go').click();
  assert.deepEqual(socket.sent, [{ type: 'start-task-chat', model: 'codex:gpt-5.1' }]);
  assert.equal(gateShown(), false);
  // A later pick for that running chat only changes the next message's model.
  handle.launch({ model: 'codex:gpt-5.1' });
  assert.equal(socket.sent.length, 1);
  assert.equal(query('#task-chat-model-select').value, 'codex:gpt-5.1');
  // A model that arrives before the server's first frame waits for it, and still starts nothing.
  handle.dispose();
  handle = taskChat.mount(host, 'TPT2', { onOpenTask() {}, onClosed() {} });
  socket = sockets.at(-1);
  handle.launch({ model: 'pi:qwen' });
  assert.equal(socket.sent.length, 0);
  socket.frame({ type: 'config', objectiveProviders: PROVIDERS });
  await settle();
  assert.equal(socket.sent.length, 0);
  assert.equal(gateShown(), true);
  assert.equal(query('#task-chat-start-model-select').value, 'pi:qwen');
  handle.dispose();

  // 6. With the workspace bridge loaded, open() routes there and the model travels as the Chat
  //    pane's launch; a value that is not "provider:model" is no model.
  const routes = [];
  window.TipTask.openTaskWorkspace = (key, opts) => { routes.push([key, opts]); };
  await taskChat.open('TPT3', { model: 'codex:gpt-5.1' });
  await taskChat.open('TPT3');
  await taskChat.open('TPT3', { model: 'codex' });
  assert.deepEqual(routes, [
    ['TPT3', { pane: 'chat', chat: { model: 'codex:gpt-5.1' } }],
    ['TPT3', { pane: 'chat' }],
    ['TPT3', { pane: 'chat' }],
  ]);
  console.log('TPT9271_CHAT_LAUNCH_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
