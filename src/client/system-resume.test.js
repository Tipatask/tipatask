import test from 'node:test';
import assert from 'node:assert/strict';

const document = globalThis.document = new EventTarget();
let resumeFromIpc;
let sessionFetches = 0;
let paints = 0;
globalThis.window = {
  addEventListener() {},
  electronAPI: { api: {}, onSystemResume(cb) { resumeFromIpc = cb; } },
  TipTask: {
    fetchActiveSessions: async () => { sessionFetches++; },
    taskBoard: { updateClaudeButtons: () => { paints++; } },
  },
};
globalThis.location = { protocol: 'http:', host: 'localhost:4455', search: '?projectPath=%2Fproject' };
globalThis.CustomEvent = class extends Event {
  constructor(type, options) { super(type); this.detail = options.detail; }
};
const sockets = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  constructor(url) { this.url = url; sockets.push(this); }
  close() { this.readyState = 3; this.onclose?.(); }
};
const { onSystemResume } = await import('./ws-client.js');
const { connectAttentionWs, closeAttentionWs } = await import('./attention-ws.js');

test('IPC resume replaces apparently OPEN board transport, refreshes state, and ignores old handlers', async () => {
  const timers = new Map();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, delay) => { const id = {}; timers.set(id, { fn, delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  let taskRefreshes = 0;
  const onTasks = () => { taskRefreshes++; };
  document.addEventListener('tiptask:task-state-update', onTasks);
  try {
    connectAttentionWs();
    const first = sockets.at(-1);
    first.onopen();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sessionFetches, 1);
    assert.equal(taskRefreshes, 1);
    const oldClose = first.onclose;
    resumeFromIpc();
    const second = sockets.at(-1);
    assert.notEqual(second, first);
    assert.equal(first.readyState, 3);
    assert.match(second.url, /taskId=__attention__/);
    assert.match(second.url, /projectPath=%2Fproject/);
    oldClose();
    first.onopen();
    first.onmessage({ data: JSON.stringify({ type: 'tasks-updated' }) });
    assert.equal(timers.size, 0, 'retired socket must not schedule a competing reconnect');
    second.onopen();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sessionFetches, 2);
    assert.equal(taskRefreshes, 2);
    assert.equal(paints, 2);

    // Advance the normal retry backoff, then wake with a pending retry.
    second.close();
    const retry = [...timers.values()][0];
    assert.ok(retry.delay >= 1000 && retry.delay < 1300);
    timers.clear();
    retry.fn();
    sockets.at(-1).close();
    assert.ok([...timers.values()][0].delay >= 1700);
    resumeFromIpc();
    assert.equal(timers.size, 0, 'resume cancels pending retry and connects immediately');
    sockets.at(-1).close();
    assert.ok([...timers.values()][0].delay < 1300, 'future retry restarts at initial backoff');
    resumeFromIpc();
    const beforeUnlock = sockets.at(-1);
    resumeFromIpc();
    assert.notEqual(sockets.at(-1), beforeUnlock, 'unlock may repeat resume safely');
    assert.equal(timers.size, 0);

    let terminalCalls = 0;
    const unsubscribe = onSystemResume(() => { terminalCalls++; });
    resumeFromIpc();
    unsubscribe();
    resumeFromIpc();
    assert.equal(terminalCalls, 1, 'disposed terminal unsubscribes from resume');
    delete window.electronAPI.api;
    const beforeBrowser = sockets.at(-1);
    resumeFromIpc();
    assert.equal(sockets.at(-1), beforeBrowser, 'resume cannot open Electron board transport in browser mode');
  } finally {
    closeAttentionWs();
    document.removeEventListener('tiptask:task-state-update', onTasks);
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
