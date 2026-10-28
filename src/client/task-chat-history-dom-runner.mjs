// (TPT9116) Runs the real task-chat.js in a DOM process isolated from node:test globals: a
// `chat-history-updated` frame refetches the left menu's session rows and quietly re-reads an open
// start gate's history picker, and a task chat started here lists its row on its first turn frame.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:4455/?projectPath=%2Fproj%2Fa' });
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame ??= callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame ??= handle => clearTimeout(handle);

// The chat's sockets; the test plays the server's frames into them.
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

const entry = (historyId, title) => ({
  historyId, kind: 'task', taskKey: 'TPT1', title, provider: 'claude', model: 'sonnet',
  createdAt: 1, lastActivityAt: Date.now(), endedAt: null, available: true, unavailableReason: null,
  keywords: [], excerpts: { first: `${title} excerpt`, latest: '' },
});
const fetches = [];
let historyEntries = [entry('h-old', 'Earlier chat')];
let historyOk = true;
let holdHistory = false;
let releaseHistory = null;
globalThis.fetch = async (url) => {
  fetches.push(String(url));
  if (String(url).startsWith('/api/project/chat-history')) {
    if (holdHistory) await new Promise(resolve => { releaseHistory = resolve; });
    return historyOk
      ? { ok: true, status: 200, json: async () => ({ entries: historyEntries }) }
      : { ok: false, status: 500, json: async () => ({ error: 'unreadable' }) };
  }
  if (url === '/api/tasks/TPT1') return { ok: true, status: 200, json: async () => ({ id: 'TPT1', title: 'Fix the thing' }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

// The left menu's two bridges (template.html / console-modal.js): GET /api/sessions, then repaint.
const calls = [];
let holdSessions = false;
let releaseSessions = null;
window.TipTask = {
  fetchActiveSessions: () => {
    calls.push('fetchActiveSessions');
    return holdSessions ? new Promise(resolve => { releaseSessions = resolve; }) : Promise.resolve();
  },
  taskBoard: { updateClaudeButtons: () => { calls.push('updateClaudeButtons'); } },
};

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9116-dom-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: { contents: "export * as taskChat from './src/client/task-chat.js';", resolveDir: root },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { taskChat } = await import(pathToFileURL(bundlePath).href);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  const count = name => calls.filter(c => c === name).length;
  const historyFetches = () => fetches.filter(u => u.startsWith('/api/project/chat-history'));
  const pickerRows = () => [...document.querySelectorAll('.task-chat-history-item')].map(el => el.dataset.historyId);
  const frame = (overrides = {}) => ({ type: 'chat-history-updated', historyId: 'h-new', kind: 'task', taskKey: 'TPT1', projectId: '2', ...overrides });

  // No chat window: the left menu refetches its session list, then repaints from it.
  holdSessions = true;
  taskChat.historyUpdated(frame());
  assert.deepEqual(calls, ['fetchActiveSessions'], 'GET /api/sessions first');
  releaseSessions();
  await settle();
  assert.deepEqual(calls, ['fetchActiveSessions', 'updateClaudeButtons'], 'then the rows repaint');
  assert.equal(historyFetches().length, 0, 'no start gate, no picker read');
  holdSessions = false;

  // A start gate for TPT1: its picker re-reads quietly on a write to one of TPT1's chats.
  await taskChat.open('TPT1'); // no workspace bridge: the standalone window
  const socket = sockets.at(-1);
  assert.match(socket.url, /taskId=taskChat%3ATPT1/);
  socket.frame({ type: 'config', objectiveProviders: [] });
  await settle();
  assert.deepEqual(historyFetches(), ['/api/project/chat-history?taskKey=TPT1&limit=50']);
  assert.deepEqual(pickerRows(), ['h-old']);
  historyEntries = [entry('h-new', 'Started elsewhere'), entry('h-old', 'Earlier chat')];
  holdHistory = true;
  taskChat.historyUpdated(frame());
  await tick();
  assert.equal(historyFetches().length, 2, 'the same query again');
  assert.equal(historyFetches()[1], '/api/project/chat-history?taskKey=TPT1&limit=50');
  assert.equal(document.querySelector('.task-chat-history').classList.contains('task-chat-history--loading'), false,
    'no loading state over rows already shown');
  assert.deepEqual(pickerRows(), ['h-old'], 'the rows stay while it loads');
  holdHistory = false;
  releaseHistory();
  await settle();
  assert.deepEqual(pickerRows(), ['h-new', 'h-old']);
  // Another task's chat, or a project chat: the left menu refreshes, the picker does not.
  const sessionsBefore = count('fetchActiveSessions');
  taskChat.historyUpdated(frame({ taskKey: 'TPT2' }));
  taskChat.historyUpdated(frame({ kind: 'project', taskKey: null }));
  await settle();
  assert.equal(historyFetches().length, 2);
  assert.equal(count('fetchActiveSessions'), sessionsBefore + 2);
  // Keys match case-insensitively; a failed live read keeps the rows and shows no error.
  historyOk = false;
  taskChat.historyUpdated(frame({ taskKey: 'tpt1' }));
  await settle();
  assert.equal(historyFetches().length, 3);
  assert.deepEqual(pickerRows(), ['h-new', 'h-old']);
  const status = document.querySelector('.task-chat-history-status');
  assert.equal(status.classList.contains('task-chat-history-status--error'), false);
  assert.equal(status.hidden, true);
  historyOk = true;

  // Start: the chat is listed on its first turn frame, before the CLI reports a session.
  document.querySelector('.task-chat-start-go').click();
  assert.deepEqual(socket.sent.map(f => f.type), ['start-task-chat']);
  await settle();
  const beforeTurn = count('fetchActiveSessions');
  socket.frame({ type: 'objective-progress', stage: 'spawned' });
  await settle();
  assert.equal(count('fetchActiveSessions'), beforeTurn + 1, 'the first turn frame refetches the left menu');
  assert.equal(calls.at(-1), 'updateClaudeButtons');
  socket.frame({ type: 'objective-progress', stage: 'cli-init' });
  socket.frame({ type: 'data', data: 'Hello' });
  await settle();
  assert.equal(count('fetchActiveSessions'), beforeTurn + 1, 'once per start');
  // The gate is gone: a later write refreshes the left menu only.
  taskChat.historyUpdated(frame());
  await settle();
  assert.equal(historyFetches().length, 3);
  assert.equal(count('fetchActiveSessions'), beforeTurn + 2);
  taskChat.close();

  // Capacity recovery: reopen takes busy state from the server, and an error/ready
  // pair leaves the existing conversation usable without a destructive fresh start.
  const history = [
    { role: 'user', content: 'seed', seed: true },
    { role: 'user', content: 'Keep this question' },
    { role: 'assistant', content: 'Keep this reply' },
  ];
  const query = selector => document.querySelector(selector);
  const busy = expected => {
    assert.equal(query('.task-chat-stop').hidden, !expected);
    assert.equal(query('.task-chat-send').hidden, expected);
    assert.equal(query('.task-chat-messages').getAttribute('aria-busy'), String(expected));
    assert.equal(query('.task-chat-panel').classList.contains('task-chat-panel--running'), expected);
  };
  const typeMessage = text => {
    query('.task-chat-input').value = text;
    query('.task-chat-input').dispatchEvent(new Event('input', { bubbles: true }));
  };
  await taskChat.open('TPT1');
  let recovery = sockets.at(-1);
  recovery.frame({ type: 'chat-history-reset', messages: history, running: true });
  busy(true); // even before config
  recovery.frame({ type: 'config', objectiveProviders: [] });
  recovery.frame({ type: 'objective-progress', stage: 'model-thinking' });
  typeMessage('Retry once capacity returns');
  query('.task-chat-send').click();
  assert.equal(recovery.sent.length, 0, 'a live turn cannot be submitted over');
  const staleSocket = recovery;
  taskChat.close();
  await taskChat.open('TPT1');
  recovery = sockets.at(-1);
  staleSocket.frame({ type: 'data', data: 'Stale reply' });
  recovery.frame({ type: 'chat-history-reset', messages: history, running: false });
  busy(false);
  recovery.frame({ type: 'chat-ready' });
  recovery.frame({ type: 'config', objectiveProviders: [] });
  assert.ok(query('.task-chat-messages').textContent.includes('Keep this reply'));
  assert.ok(!query('.task-chat-messages').textContent.includes('Stale reply'));
  assert.equal(query('.task-chat-input').value, 'Retry once capacity returns', 'draft survives close');
  query('.task-chat-send').click();
  assert.deepEqual(recovery.sent.map(f => f.type), ['task-chat-message']);
  busy(true);
  recovery.frame({ type: 'objective-error', reason: 'codex:Model is at capacity', provider: 'codex', chatContinues: true });
  busy(false);
  recovery.frame({ type: 'chat-ready' });
  busy(false);
  assert.equal(query('.task-chat-retry'), null, 'recoverable failure never asks to discard history');
  assert.equal(query('.task-chat-stop').disabled, false);
  assert.equal([...document.querySelectorAll('.task-chat-status')].some(el => !el.hidden && el.textContent), false);
  typeMessage('Try again');
  assert.equal(query('.task-chat-send').disabled, false);
  query('.task-chat-send').click();
  recovery.frame({ type: 'data', data: 'Recovered response' });
  recovery.frame({ type: 'objective-result', content: 'Recovered response' });
  recovery.frame({ type: 'chat-ready' });
  busy(false);
  assert.ok(query('.task-chat-messages').textContent.includes('Keep this reply'));
  assert.ok(query('.task-chat-messages').textContent.includes('Recovered response'));

  // A rejected concurrent message is not a failed live turn: stay locked until ready.
  recovery.frame({ type: 'error', reason: 'turn-in-progress', running: true, message: 'A turn is still in progress. Wait for chat-ready.' });
  busy(true);
  typeMessage('Blocked duplicate');
  query('.task-chat-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(recovery.sent.filter(f => f.type === 'task-chat-message').length, 2);
  query('.task-chat-stop').click();
  assert.equal(recovery.sent.at(-1).type, 'abort');
  recovery.frame({ type: 'generation-aborted' });
  busy(false);
  taskChat.close();

  // A first-turn capacity failure also retains its seed/native context for a follow-up.
  await taskChat.open('TPT1');
  recovery = sockets.at(-1);
  recovery.frame({ type: 'config', objectiveProviders: [] });
  query('.task-chat-start-go').click();
  recovery.frame({ type: 'objective-error', reason: 'codex:Model is at capacity', chatContinues: true });
  recovery.frame({ type: 'chat-ready' });
  busy(false);
  assert.equal(query('.task-chat-retry'), null);
  typeMessage('First reply retry');
  query('.task-chat-send').click();
  assert.deepEqual(recovery.sent.map(f => f.type), ['start-task-chat', 'task-chat-message']);
  taskChat.close();
  console.log('TPT9116_CHAT_HISTORY_LIVE_PASS');
  console.log('TPT9145_CHAT_RECOVERY_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
