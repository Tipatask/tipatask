// (TPT9296) Runs the real task-chat.js in a DOM process isolated from node:test globals and presses
// its Copy buttons: a task chat restored by `chat-history-reset`, a streamed reply, and a project
// chat resumed from history. navigator.clipboard.writeText() first rejects the way an Electron
// session that denies 'clipboard-sanitized-write' does, then resolves, then both clipboard paths
// fail. In every locale: the exact text reaches the clipboard and the button reads "Copied"; the
// failure toast shows only when nothing was copied.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { marked } from 'marked';

const window = new Window({ url: 'http://localhost:4455/?projectPath=%2Fproj%2Fa' });
// renderMarkdown() reads the page's global `marked` (a <script> in the app); replies need it to
// get their code blocks, and so their code Copy buttons.
globalThis.marked = marked;
window.marked = marked;
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

// The Async Clipboard API: `deny` rejects as Electron does when its permission handler refuses
// 'clipboard-sanitized-write'; `ok` resolves.
const DENIED = "Failed to execute 'writeText' on 'Clipboard': Write permission denied.";
let clipboardMode = 'deny';
const apiWrites = [];
Object.defineProperty(window.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text) => {
      apiWrites.push(text);
      if (clipboardMode === 'deny') throw Object.assign(new Error(DENIED), { name: 'NotAllowedError' });
    },
  },
});
// The legacy path: execCommand('copy') copies the focused text control's selection.
let execWorks = true;
const execCopies = [];
document.execCommand = (command) => {
  const el = document.activeElement;
  const text = el && typeof el.value === 'string' ? el.value.slice(el.selectionStart, el.selectionEnd) : '';
  execCopies.push({ command, text, readOnly: !!(el && el.readOnly) });
  return execWorks;
};
const clipboardLogs = [];
for (const level of ['warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[clipboard]')) clipboardLogs.push({ level, line });
    else original(...args);
  };
}

const json = body => ({ ok: true, status: 200, json: async () => body });
const historyRow = {
  historyId: 'h-1', kind: 'project', taskKey: null, title: 'Codeword chat', provider: 'claude', model: 'sonnet',
  createdAt: 1, lastActivityAt: Date.now(), endedAt: null, available: true, unavailableReason: null,
  keywords: [], excerpts: { first: 'codeword', latest: '' },
};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u === '/api/tasks/TPT1') return json({ id: 'TPT1', title: 'Fix the copy button' });
  if (u === '/api/project-config') return json({ config: { API_PROJECT_ID: '2', projectName: 'Demo' } });
  if (u.startsWith('/api/project/chat-history')) return json({ entries: u.includes('kind=project') ? [historyRow] : [] });
  return json({});
};
window.TipTask = { fetchActiveSessions: () => Promise.resolve(), taskBoard: { updateClaudeButtons() {} } };

const REPLY = 'Use this:\n\n```js\nconst a = 1;\nconst b = a + 1;\n```\n\nThen reload.';
const CODE = 'const a = 1;\nconst b = a + 1;';
const USER = 'How do I fix it?\nKeep it short.';
const STREAMED = 'Streaming answer:\n\n```py\nprint(1)\n```\n\nDone streaming.';
const RESUMED_Q = 'What was the codeword?';
const RESUMED_A = 'The codeword is **TEAL**.\n\n```sh\necho TEAL\n```';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9296-dom-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: "export * as taskChat from './src/client/task-chat.js';\nexport * as i18n from './src/client/i18n.js';",
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { taskChat, i18n } = await import(pathToFileURL(bundlePath).href);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  const query = selector => document.querySelector(selector);
  const toasts = () => [...document.querySelectorAll('.tt-toast--error .tt-saving-label')].map(el => el.textContent);
  const label = btn => btn.querySelector('.task-chat-copy-label').textContent;
  const textareas = () => document.querySelectorAll('textarea').length;
  const wholeCopy = msg => msg.querySelector(':scope > .task-chat-msg-copy');
  const codeCopy = msg => msg.querySelector('.task-chat-body pre .task-chat-copy');
  // One press: a clean slate (no toast, no "Copied"), the click, the async copy settles.
  const press = async (btn) => {
    document.querySelectorAll('.tt-saving-indicator').forEach(el => el.remove());
    btn.removeAttribute('data-copied');
    const focused = document.activeElement;
    const before = textareas();
    btn.click();
    await settle();
    assert.equal(textareas(), before, 'no copy buffer left behind');
    assert.equal(document.activeElement === focused, true, 'keyboard focus is where it was');
  };
  const assertCopied = (btn, locale) => {
    assert.equal(btn.hasAttribute('data-copied'), true, `${locale}: shows Copied`);
    assert.equal(label(btn), i18n.LOCALES[locale]['taskChat.copy.copied']);
    assert.equal(btn.title, i18n.LOCALES[locale]['taskChat.copy.copied']);
    assert.deepEqual(toasts(), [], `${locale}: no failure toast after a successful copy`);
  };

  // ── Task chat restored by a reattach ──
  await taskChat.open('TPT1');
  const socket = sockets.at(-1);
  socket.frame({
    type: 'chat-history-reset', running: false, objectiveSelection: '',
    messages: [
      { role: 'user', content: 'task JSON and the opening ask', seed: true },
      { role: 'assistant', content: 'What should we change?' },
      { role: 'user', content: USER },
      { role: 'assistant', content: REPLY },
    ],
  });
  socket.frame({ type: 'config', objectiveProviders: [] });
  await settle();
  const replies = [...document.querySelectorAll('.task-chat-msg--assistant')];
  const reply = replies.at(-1);
  const user = query('.task-chat-msg--user');
  assert.equal(replies.length, 2);
  assert.ok(wholeCopy(reply) && !wholeCopy(reply).hidden, 'the reply has its Copy button');
  assert.ok(codeCopy(reply), 'its code block has one');
  assert.ok(wholeCopy(user) && !wholeCopy(user).hidden, 'the user turn has one');

  for (const locale of Object.keys(i18n.LOCALES)) {
    i18n.setLocale(locale);
    const strings = i18n.LOCALES[locale];
    for (const key of ['taskChat.copy.button', 'taskChat.copy.message', 'taskChat.copy.copied', 'taskChat.copy.failed']) {
      assert.ok(typeof strings[key] === 'string' && strings[key].trim(), `${locale}.${key}`);
    }

    // The Async Clipboard API rejects (Electron's denied permission): the fallback copies.
    clipboardMode = 'deny';
    execWorks = true;
    for (const [btn, text] of [[wholeCopy(reply), REPLY], [codeCopy(reply), CODE], [wholeCopy(user), USER]]) {
      const logged = clipboardLogs.length;
      await press(btn);
      assert.equal(apiWrites.at(-1), text, 'the clipboard API was tried first with the exact text');
      assert.deepEqual(execCopies.at(-1), { command: 'copy', text, readOnly: true }, 'the fallback copied the exact text');
      assertCopied(btn, locale);
      assert.equal(clipboardLogs.length, logged + 1);
      assert.equal(clipboardLogs.at(-1).level, 'warn');
      assert.ok(clipboardLogs.at(-1).line.includes(`NotAllowedError: ${DENIED}`), 'the real error is logged');
    }

    // The Async Clipboard API works: no fallback, nothing logged.
    clipboardMode = 'ok';
    const execs = execCopies.length;
    const logs = clipboardLogs.length;
    for (const [btn, text] of [[wholeCopy(reply), REPLY], [codeCopy(reply), CODE]]) {
      await press(btn);
      assert.equal(apiWrites.at(-1), text);
      assertCopied(btn, locale);
    }
    assert.equal(execCopies.length, execs, 'no fallback when the first path works');
    assert.equal(clipboardLogs.length, logs, 'nothing logged when the first path works');

    // Both paths fail: the one case for the failure toast, in this locale.
    clipboardMode = 'deny';
    execWorks = false;
    const btn = wholeCopy(user);
    await press(btn);
    assert.equal(btn.hasAttribute('data-copied'), false, `${locale}: no Copied after a failed copy`);
    assert.deepEqual(toasts(), [strings['taskChat.copy.failed']]);
    assert.equal(clipboardLogs.at(-1).level, 'error');
  }
  i18n.setLocale('en');
  clipboardMode = 'deny';
  execWorks = true;

  // ── A streamed reply ──
  socket.frame({ type: 'data', data: 'Streaming answer:\n\n```py\nprint(1)\n' });
  await settle();
  const streaming = [...document.querySelectorAll('.task-chat-msg--assistant')].at(-1);
  assert.equal(streaming.classList.contains('task-chat-msg--streaming'), true);
  assert.equal(wholeCopy(streaming).hidden, true, 'no whole-message Copy while it streams');
  await press(codeCopy(streaming));
  assert.equal(execCopies.at(-1).text, 'print(1)', 'a code block copies mid-stream');
  socket.frame({ type: 'data', data: '```\n\nDone streaming.' });
  socket.frame({ type: 'objective-result', content: STREAMED });
  socket.frame({ type: 'chat-ready' });
  await settle();
  assert.equal(streaming.classList.contains('task-chat-msg--streaming'), false);
  assert.equal(wholeCopy(streaming).hidden, false);
  await press(wholeCopy(streaming));
  assert.equal(execCopies.at(-1).text, STREAMED);
  assertCopied(wholeCopy(streaming), 'en');
  taskChat.close();

  // ── A project chat resumed from history ──
  await taskChat.openProjectChat();
  await settle();
  const project = sockets.at(-1);
  assert.match(project.url, /projectChat/);
  project.frame({ type: 'config', objectiveProviders: [] });
  await settle();
  const row = query('.task-chat-history-item');
  assert.ok(row, 'the start gate lists the earlier project chat');
  row.click();
  assert.deepEqual(project.sent.at(-1), { type: 'start-project-chat', historyId: 'h-1' });
  project.frame({
    type: 'chat-history-resumed', historyId: 'h-1', taskKey: null, projectId: '2', title: 'Codeword chat',
    provider: 'claude', model: 'sonnet', objectiveSelection: '', transcriptUnavailable: false,
    messages: [{ role: 'user', content: RESUMED_Q, restored: true }, { role: 'assistant', content: RESUMED_A, restored: true }],
  });
  project.frame({ type: 'chat-ready' });
  await settle();
  const restoredReply = query('.task-chat-msg--assistant.task-chat-msg--restored');
  const restoredUser = query('.task-chat-msg--user.task-chat-msg--restored');
  assert.ok(restoredReply && restoredUser, 'the read-back turns are the transcript');
  assert.equal(query('.task-chat-msg--resumed .task-chat-msg-copy'), null, 'the resumed-session line has no Copy');
  for (const [btn, text] of [[wholeCopy(restoredReply), RESUMED_A], [codeCopy(restoredReply), 'echo TEAL'], [wholeCopy(restoredUser), RESUMED_Q]]) {
    await press(btn);
    assert.equal(apiWrites.at(-1), text);
    assert.equal(execCopies.at(-1).text, text);
    assertCopied(btn, 'en');
  }
  taskChat.close();
  console.log('TPT9296_CHAT_COPY_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
