'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAssemblyAiProvider } = require('./assemblyai-provider');

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static sockets = [];
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.terminated = 0;
    FakeSocket.sockets.push(this);
  }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.terminated++; this.close(); }
  message(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

function callbacks(events) {
  return {
    onReady: () => events.push('ready'),
    onPartial: (text) => events.push(`partial:${text}`),
    onFinal: (text) => events.push(`final:${text}`),
    onDone: () => events.push('done'),
    onError: (text) => events.push(`error:${text}`),
  };
}

test('stop while token mint is pending aborts it and never opens an upstream socket', async () => {
  FakeSocket.sockets = [];
  const mint = deferred();
  let tokenSignal;
  const events = [];
  const provider = createAssemblyAiProvider({}, {
    WebSocket: FakeSocket,
    fetchStreamToken: (_ctx, signal) => { tokenSignal = signal; return mint.promise; },
  });
  const starting = provider.start(callbacks(events));
  provider.stop();
  provider.stop();
  assert.equal(tokenSignal.aborted, true);
  mint.resolve('late-token');
  await starting;
  assert.equal(FakeSocket.sockets.length, 0);
  assert.deepEqual(events, []);
});

test('stop before upstream Begin terminates connecting socket and drops late messages', async () => {
  FakeSocket.sockets = [];
  const events = [];
  const provider = createAssemblyAiProvider({}, { WebSocket: FakeSocket, fetchStreamToken: async () => 'token' });
  await provider.start(callbacks(events));
  const socket = FakeSocket.sockets[0];
  provider.stop();
  provider.stop();
  socket.message({ type: 'Begin' });
  socket.message({ type: 'Turn', transcript: 'late', end_of_turn: true });
  assert.equal(socket.terminated, 1);
  assert.deepEqual(events, []);
});

test('normal ready stream drains trailing final once after stop', async () => {
  FakeSocket.sockets = [];
  const events = [];
  const provider = createAssemblyAiProvider({}, { WebSocket: FakeSocket, fetchStreamToken: async () => 'token' });
  await provider.start(callbacks(events));
  const socket = FakeSocket.sockets[0];
  socket.readyState = FakeSocket.OPEN;
  socket.message({ type: 'Begin' });
  provider.pushAudio(Buffer.from([1, 2]));
  provider.stop();
  provider.stop();
  socket.message({ type: 'Turn', transcript: 'partial', end_of_turn: false });
  socket.message({ type: 'Turn', transcript: 'final words', end_of_turn: true });
  socket.message({ type: 'Termination' });
  socket.close();
  assert.deepEqual(socket.sent, [Buffer.from([1, 2]), JSON.stringify({ type: 'Terminate' })]);
  assert.deepEqual(events, ['ready', 'final:final words', 'done']);
});

test('direct token fetch is aborted by stop without reporting a startup error', async () => {
  const originalFetch = global.fetch;
  let aborted = false;
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  });
  try {
    const events = [];
    const provider = createAssemblyAiProvider({ assemblyaiApiKey: 'test-key' }, { WebSocket: FakeSocket });
    const starting = provider.start(callbacks(events));
    provider.stop();
    await starting;
    assert.equal(aborted, true);
    assert.deepEqual(events, []);
  } finally {
    global.fetch = originalFetch;
  }
});
