'use strict';

// Exercises the __voice__ WS protocol state machine (session.js) against a fake ws socket and
// a fake provider — no real network, no sherpa-onnx-node, no AssemblyAI. session.js's
// resolveVoicePreset/createProvider are injected via the optional third `deps` argument (see
// its module comment) precisely so this file never has to touch either real implementation.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { handleVoiceConnection, MAX_CONTROL_BYTES, MAX_AUDIO_FRAME_BYTES, MAX_AUDIO_SESSION_BYTES } = require('./session');

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN, matches ws's WebSocket.OPEN
    this.sent = [];
    this.closeCount = 0;
  }
  send(data) { this.sent.push(data); }
  close() { this.closeCount += 1; this.readyState = 3; this.emit('close'); }
  jsonSent() { return this.sent.map((s) => JSON.parse(s)); }
}

function fakeProvider() {
  const calls = { pushAudio: [], stop: 0 };
  return {
    calls,
    start: async (callbacks) => { fakeProvider.lastCallbacks = callbacks; callbacks.onReady(); },
    pushAudio: (buf) => calls.pushAudio.push(buf),
    stop: () => { calls.stop += 1; },
  };
}

function startMsg(extra = {}) {
  return Buffer.from(JSON.stringify({ type: 'voice:start', sampleRate: 16000, encoding: 'pcm_s16le', ...extra }));
}
function stopMsg() {
  return Buffer.from(JSON.stringify({ type: 'voice:stop' }));
}
async function flush() {
  await new Promise((r) => setImmediate(r));
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('voice:start resolves the preset, creates a provider, and relays onReady as voice:ready', async () => {
  const ws = new FakeWs();
  const provider = fakeProvider();
  const deps = { resolveVoicePreset: async () => ({ preset: 'assemblyai', modelId: null }), createProvider: () => provider };
  handleVoiceConnection(ws, {}, deps);
  ws.emit('message', startMsg(), false);
  await flush();
  assert.deepEqual(ws.jsonSent(), [{ type: 'voice:ready', provider: 'assemblyai' }]);
});

test('binary frames after start are routed to provider.pushAudio', async () => {
  const ws = new FakeWs();
  const provider = fakeProvider();
  const deps = { resolveVoicePreset: async () => ({ preset: 'assemblyai' }), createProvider: () => provider };
  handleVoiceConnection(ws, {}, deps);
  ws.emit('message', startMsg(), false);
  await flush();
  const audioBuf = Buffer.from([1, 2, 3, 4]);
  ws.emit('message', audioBuf, true);
  assert.deepEqual(provider.calls.pushAudio, [audioBuf]);
});

test('binary frames sent BEFORE voice:start are dropped, not queued or crashed on', () => {
  const ws = new FakeWs();
  const provider = fakeProvider();
  const deps = { resolveVoicePreset: async () => ({ preset: 'assemblyai' }), createProvider: () => provider };
  handleVoiceConnection(ws, {}, deps);
  assert.doesNotThrow(() => ws.emit('message', Buffer.from([9, 9]), true));
  assert.equal(provider.calls.pushAudio.length, 0);
});

test('voice:stop calls provider.stop() exactly once', async () => {
  const ws = new FakeWs();
  const provider = fakeProvider();
  const deps = { resolveVoicePreset: async () => ({ preset: 'assemblyai' }), createProvider: () => provider };
  handleVoiceConnection(ws, {}, deps);
  ws.emit('message', startMsg(), false);
  await flush();
  ws.emit('message', stopMsg(), false);
  assert.equal(provider.calls.stop, 1);
});

test('ws close before voice:start never throws (no provider created yet)', () => {
  const ws = new FakeWs();
  const deps = { resolveVoicePreset: async () => ({ preset: 'assemblyai' }), createProvider: () => fakeProvider() };
  handleVoiceConnection(ws, {}, deps);
  assert.doesNotThrow(() => ws.emit('close'));
});

test('ws close after voice:stop already fired does not double-stop the provider', async () => {
  const ws = new FakeWs();
  const provider = fakeProvider();
  const deps = { resolveVoicePreset: async () => ({ preset: 'assemblyai' }), createProvider: () => provider };
  handleVoiceConnection(ws, {}, deps);
  ws.emit('message', startMsg(), false);
  await flush();
  ws.emit('message', stopMsg(), false);
  ws.emit('close');
  ws.emit('close'); // a real socket only fires this once, but cleanup() must be idempotent anyway
  assert.equal(provider.calls.stop, 1);
});

test('preset "unavailable" sends voice:unsupported and closes without ever creating a provider', async () => {
  const ws = new FakeWs();
  let created = false;
  let closed = false;
  ws.close = () => { closed = true; };
  const deps = {
    resolveVoicePreset: async () => ({ preset: 'unavailable', reason: 'no API token' }),
    createProvider: () => { created = true; return fakeProvider(); },
  };
  handleVoiceConnection(ws, {}, deps);
  ws.emit('message', startMsg(), false);
  await flush();
  assert.equal(created, false);
  assert.deepEqual(ws.jsonSent(), [{ type: 'voice:unsupported', reason: 'no API token' }]);
  assert.equal(closed, true);
});

test('non-error provider callbacks relay as their matching frame type, in order', async () => {
  const ws = new FakeWs();
  let cbs;
  const provider = {
    start: async (callbacks) => { cbs = callbacks; callbacks.onReady(); },
    pushAudio: () => {},
    stop: () => {},
  };
  const deps = { resolveVoicePreset: async () => ({ preset: 'local', modelId: 'whisper-base' }), createProvider: () => provider };
  handleVoiceConnection(ws, {}, deps);
  ws.emit('message', startMsg(), false);
  await flush();

  cbs.onPartial('hel');
  cbs.onFinal('hello');
  cbs.onUnsupported('model not ready');
  cbs.onDone();

  assert.deepEqual(ws.jsonSent(), [
    { type: 'voice:ready', provider: 'local' },
    { type: 'voice:partial', text: 'hel' },
    { type: 'voice:final', text: 'hello' },
    { type: 'voice:unsupported', reason: 'model not ready' },
    { type: 'voice:done' },
  ]);
});

test('raw partials cross the WS relay unchanged and a punctuated final replaces the live caption', async () => {
  const { createLiveInserter } = await import('../../client/utils.js');
  const field = { value: 'Note: ', selectionStart: 6, selectionEnd: 6, dispatchEvent() {} };
  const inserter = createLiveInserter(field);
  const ws = new FakeWs();
  const originalSend = ws.send.bind(ws);
  ws.send = (data) => {
    originalSend(data);
    const msg = JSON.parse(data);
    if (msg.type === 'voice:partial') inserter.setPartial(msg.text);
    if (msg.type === 'voice:final') inserter.commit(msg.text);
  };
  let callbacks;
  handleVoiceConnection(ws, {}, {
    resolveVoicePreset: async () => ({ preset: 'assemblyai' }),
    createProvider: () => ({
      start: async (cbs) => { callbacks = cbs; cbs.onReady(); },
      pushAudio() {}, stop() {},
    }),
  });
  ws.emit('message', startMsg(), false);
  await flush();
  callbacks.onPartial('hello');
  assert.equal(field.value, 'Note: hello');
  callbacks.onPartial('hello world this is next');
  assert.equal(field.value, 'Note: hello world this is next');
  callbacks.onFinal('Hello world. This is next.');
  assert.equal(field.value, 'Note: Hello world. This is next. ');
  assert.deepEqual(ws.jsonSent().slice(1), [
    { type: 'voice:partial', text: 'hello' },
    { type: 'voice:partial', text: 'hello world this is next' },
    { type: 'voice:final', text: 'Hello world. This is next.' },
  ]);
});

test('a second voice:start closes only that session — only one provider is ever created', async () => {
  const ws = new FakeWs();
  let createCount = 0;
  const provider = fakeProvider();
  const deps = {
    resolveVoicePreset: async () => ({ preset: 'assemblyai' }),
    createProvider: () => { createCount += 1; return provider; },
  };
  handleVoiceConnection(ws, {}, deps);
  ws.emit('message', startMsg(), false);
  await flush();
  ws.emit('message', startMsg(), false);
  assert.equal(createCount, 1);
  assert.equal(provider.calls.stop, 1);
  assert.equal(ws.closeCount, 1);
  assert.equal(ws.jsonSent().at(-1).type, 'voice:error');
});

// (C1202)
test('onLoading relays as voice:loading; onDone(stats)/onUnsupported(reason, extra) carry their extra payload', async () => {
  const ws = new FakeWs();
  let cbs;
  const provider = {
    start: async (callbacks) => { cbs = callbacks; callbacks.onReady(); },
    pushAudio: () => {},
    stop: () => {},
  };
  const deps = { resolveVoicePreset: async () => ({ preset: 'local', modelId: 'parakeet-v3' }), createProvider: () => provider };
  handleVoiceConnection(ws, {}, deps);
  ws.emit('message', startMsg(), false);
  await flush();

  cbs.onLoading({ modelId: 'parakeet-v3' });
  cbs.onUnsupported('sample rate mismatch', { reasonCode: 'SAMPLE_RATE_MISMATCH', detail: { rate: 44100 } });
  cbs.onDone({ segments: 2, emptySegments: 0, peak: 0.4 });

  assert.deepEqual(ws.jsonSent(), [
    { type: 'voice:ready', provider: 'local' },
    { type: 'voice:loading', modelId: 'parakeet-v3' },
    { type: 'voice:unsupported', reason: 'sample rate mismatch', reasonCode: 'SAMPLE_RATE_MISMATCH', detail: { rate: 44100 } },
    { type: 'voice:done', stats: { segments: 2, emptySegments: 0, peak: 0.4 } },
  ]);
});

test('resolveVoicePreset throwing sends voice:error and closes, never creates a provider', async () => {
  const ws = new FakeWs();
  let created = false;
  let closed = false;
  ws.close = () => { closed = true; };
  const deps = {
    resolveVoicePreset: async () => { throw new Error('network down'); },
    createProvider: () => { created = true; return fakeProvider(); },
  };
  handleVoiceConnection(ws, {}, deps);
  ws.emit('message', startMsg(), false);
  await flush();
  assert.equal(created, false);
  assert.equal(closed, true);
  const msgs = ws.jsonSent();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, 'voice:error');
  assert.match(msgs[0].message, /Voice stream failed/);
});

function connected(provider = fakeProvider()) {
  const ws = new FakeWs();
  handleVoiceConnection(ws, {}, {
    resolveVoicePreset: async () => ({ preset: 'assemblyai' }),
    createProvider: () => provider,
  });
  return { ws, provider };
}

test('malformed control frames close their own socket with one bounded error', () => {
  const invalid = [
    'null', '[]', 'true', '3', '"voice:start"', '{',
    JSON.stringify({ type: 'voice:unknown' }),
    JSON.stringify({ type: 'voice:stop', extra: 1 }),
    JSON.stringify({ type: 'voice:start', sampleRate: 0, encoding: 'pcm_s16le' }),
    JSON.stringify({ type: 'voice:start', sampleRate: 96001, encoding: 'pcm_s16le' }),
    JSON.stringify({ type: 'voice:start', sampleRate: 16000.5, encoding: 'pcm_s16le' }),
    JSON.stringify({ type: 'voice:start', sampleRate: '16000', encoding: 'pcm_s16le' }),
    JSON.stringify({ type: 'voice:start', sampleRate: 16000, encoding: 'opus' }),
    JSON.stringify({ type: 'voice:start', sampleRate: 16000, encoding: 'pcm_s16le', language: {} }),
    JSON.stringify({ type: 'voice:start', sampleRate: 16000, encoding: 'pcm_s16le', unknown: true }),
    ' '.repeat(MAX_CONTROL_BYTES + 1),
  ];
  for (const frame of invalid) {
    const { ws } = connected();
    assert.doesNotThrow(() => ws.emit('message', Buffer.from(frame), false), frame.slice(0, 80));
    assert.equal(ws.closeCount, 1, frame.slice(0, 80));
    assert.equal(ws.jsonSent().length, 1);
    assert.equal(ws.jsonSent()[0].type, 'voice:error');
    assert.ok(ws.jsonSent()[0].message.length <= 240);
  }
});

test('valid actual sample rate and supported fields reach the provider unchanged', async () => {
  let ctx;
  const { ws } = connected({
    start: async (callbacks) => callbacks.onReady(),
    pushAudio() {}, stop() {},
  });
  // A second independent connection captures the provider context.
  const other = new FakeWs();
  handleVoiceConnection(other, {}, {
    resolveVoicePreset: async () => ({ preset: 'assemblyai' }),
    createProvider: (value) => { ctx = value; return fakeProvider(); },
  });
  other.emit('message', startMsg({ sampleRate: 48000, declaredSampleRate: 16000, language: 'en-US' }), false);
  ws.emit('message', startMsg(), false);
  await flush();
  assert.equal(ctx.sampleRate, 48000);
  assert.equal(other.jsonSent()[0].type, 'voice:ready');
  assert.equal(ws.jsonSent()[0].type, 'voice:ready');
});

test('empty, odd, and oversized PCM frames fail before pushAudio and stop provider once', async () => {
  for (const frame of [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(MAX_AUDIO_FRAME_BYTES + 2)]) {
    const { ws, provider } = connected();
    ws.emit('message', startMsg(), false);
    await flush();
    assert.doesNotThrow(() => ws.emit('message', frame, true));
    assert.equal(ws.jsonSent().at(-1).type, 'voice:error');
    assert.equal(ws.closeCount, 1);
    assert.equal(provider.calls.pushAudio.length, 0);
    assert.equal(provider.calls.stop, 1);
  }
});

test('cumulative PCM limit closes one session without dispatching the over-limit frame', async () => {
  let pushed = 0;
  let stopped = 0;
  const { ws } = connected({
    start: async (callbacks) => callbacks.onReady(),
    pushAudio() { pushed += 1; },
    stop() { stopped += 1; },
  });
  ws.emit('message', startMsg(), false);
  await flush();
  const frame = Buffer.alloc(MAX_AUDIO_FRAME_BYTES);
  for (let sent = 0; sent < MAX_AUDIO_SESSION_BYTES; sent += frame.length) {
    ws.emit('message', frame, true);
  }
  assert.equal(pushed, MAX_AUDIO_SESSION_BYTES / frame.length);
  ws.emit('message', frame, true);
  assert.equal(pushed, MAX_AUDIO_SESSION_BYTES / frame.length);
  assert.equal(stopped, 1);
  assert.equal(ws.closeCount, 1);
});

test('throwing createProvider and sync/async start failures close only their session', async () => {
  const cases = [
    { createProvider() { throw new Error('factory failure'); }, expectedStops: 0 },
    { createProvider() { return { start() { throw new Error('start failure'); }, pushAudio() {}, stop() { stops += 1; } }; }, expectedStops: 1 },
    { createProvider() { return { start: async () => { throw new Error('start rejection'); }, pushAudio() {}, stop() { stops += 1; } }; }, expectedStops: 1 },
  ];
  let stops = 0;
  for (const scenario of cases) {
    stops = 0;
    const ws = new FakeWs();
    handleVoiceConnection(ws, {}, {
      resolveVoicePreset: async () => ({ preset: 'assemblyai' }),
      createProvider: scenario.createProvider,
    });
    ws.emit('message', startMsg(), false);
    await flush();
    assert.equal(ws.jsonSent().at(-1).type, 'voice:error');
    assert.equal(ws.closeCount, 1);
    assert.equal(stops, scenario.expectedStops);
  }
});

test('sync and async pushAudio failures close their session and stop provider once', async () => {
  for (const pushAudio of [
    () => { throw new Error('decode failure'); },
    async () => { throw new Error('decode rejection'); },
  ]) {
    let stops = 0;
    const { ws } = connected({
      start: async (callbacks) => callbacks.onReady(),
      pushAudio,
      stop: () => { stops += 1; },
    });
    ws.emit('message', startMsg(), false);
    await flush();
    assert.doesNotThrow(() => ws.emit('message', Buffer.alloc(2), true));
    await flush();
    assert.equal(ws.jsonSent().at(-1).type, 'voice:error');
    assert.equal(ws.closeCount, 1);
    assert.equal(stops, 1);
  }
});

test('provider callback errors are bounded and stop the provider', async () => {
  let callbacks;
  const provider = {
    start: async (value) => { callbacks = value; value.onReady(); },
    pushAudio() {},
    stop: () => { provider.stops = (provider.stops || 0) + 1; },
  };
  const { ws } = connected(provider);
  ws.emit('message', startMsg(), false);
  await flush();
  callbacks.onError('x'.repeat(1000));
  callbacks.onDone();
  assert.equal(ws.jsonSent().at(-1).message.length, 240);
  assert.equal(ws.jsonSent().length, 2, 'late done must not reach the closed socket');
  assert.equal(provider.stops, 1);
  assert.equal(ws.closeCount, 1);
});

test('provider callback error with a throwing toString still closes its socket', async () => {
  let callbacks;
  const { ws } = connected({
    start: async (value) => { callbacks = value; value.onReady(); },
    pushAudio() {}, stop() {},
  });
  ws.emit('message', startMsg(), false);
  await flush();
  assert.doesNotThrow(() => callbacks.onError({ toString() { throw new Error('bad message'); } }));
  assert.equal(ws.jsonSent().at(-1).message, 'Voice stream failed');
  assert.equal(ws.closeCount, 1);
});

test('rejected provider.stop is handled without an unhandled rejection', async () => {
  const { ws } = connected({
    start: async (callbacks) => callbacks.onReady(),
    pushAudio() {},
    stop: async () => { throw new Error('stop rejection'); },
  });
  ws.emit('message', startMsg(), false);
  await flush();
  ws.emit('message', stopMsg(), false);
  await flush();
  assert.equal(ws.jsonSent().at(-1).type, 'voice:error');
  assert.equal(ws.closeCount, 1);
});

test('closing during preset resolution prevents late provider creation', async () => {
  let resolvePreset;
  let created = 0;
  const ws = new FakeWs();
  handleVoiceConnection(ws, {}, {
    resolveVoicePreset: () => new Promise((resolve) => { resolvePreset = resolve; }),
    createProvider: () => { created += 1; return fakeProvider(); },
  });
  ws.emit('message', startMsg(), false);
  ws.close();
  resolvePreset({ preset: 'assemblyai' });
  await flush();
  assert.equal(created, 0);
});

test('closing during provider startup stops it once and suppresses late callbacks', async () => {
  let finishStart;
  let callbacks;
  let stops = 0;
  const { ws } = connected({
    start: (value) => { callbacks = value; return new Promise((resolve) => { finishStart = resolve; }); },
    pushAudio() {},
    stop: () => { stops += 1; },
  });
  ws.emit('message', startMsg(), false);
  await flush();
  ws.close();
  finishStart();
  callbacks.onReady();
  await flush();
  assert.equal(stops, 1);
  assert.deepEqual(ws.jsonSent(), []);
});

test('malformed voice traffic cannot crash a process serving another voice session', () => {
  const program = `
    const { EventEmitter } = require('node:events');
    const { handleVoiceConnection } = require('./src/server/voice-stream/session');
    class Socket extends EventEmitter {
      constructor() { super(); this.readyState = 1; this.sent = []; }
      send(value) { this.sent.push(JSON.parse(value)); }
      close() { this.readyState = 3; this.emit('close'); }
    }
    const deps = {
      resolveVoicePreset: async () => ({ preset: 'assemblyai' }),
      createProvider: () => ({
        start: async (callbacks) => callbacks.onReady(),
        pushAudio() {},
        stop() {},
      }),
    };
    const bad = new Socket();
    handleVoiceConnection(bad, {}, deps);
    bad.emit('message', Buffer.from('null'), false);
    if (bad.sent[0]?.type !== 'voice:error' || bad.readyState !== 3) process.exit(2);
    const boom = new Socket();
    handleVoiceConnection(boom, {}, {
      ...deps,
      createProvider: () => ({
        start: async (callbacks) => callbacks.onReady(),
        pushAudio() { throw new Error('sync decode failure'); },
        stop() {},
      }),
    });
    boom.emit('message', Buffer.from(JSON.stringify({type:'voice:start',sampleRate:16000,encoding:'pcm_s16le'})), false);
    setImmediate(() => {
      boom.emit('message', Buffer.alloc(2), true);
      if (boom.sent.at(-1)?.type !== 'voice:error' || boom.readyState !== 3) process.exit(3);
      const good = new Socket();
      handleVoiceConnection(good, {}, deps);
      good.emit('message', Buffer.from(JSON.stringify({type:'voice:start',sampleRate:16000,encoding:'pcm_s16le'})), false);
      setImmediate(() => {
      good.emit('message', Buffer.alloc(2), true);
      if (good.sent[0]?.type !== 'voice:ready' || good.readyState !== 1) process.exit(4);
      process.stdout.write('survived');
      });
    });
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', program], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'survived');
});

for (const ending of ['voice:stop', 'close', 'error']) {
  test(`${ending} while settings resolve prevents provider creation and late frames`, async () => {
    const ws = new FakeWs();
    const settings = deferred();
    let creates = 0;
    handleVoiceConnection(ws, {}, {
      resolveVoicePreset: () => settings.promise,
      createProvider: () => { creates++; return fakeProvider(); },
    });
    ws.emit('message', startMsg(), false);
    if (ending === 'voice:stop') ws.emit('message', stopMsg(), false);
    else ws.emit(ending, new Error('socket ended'));
    ws.emit('message', stopMsg(), false);
    settings.resolve({ preset: 'local', modelId: 'parakeet-v3' });
    await flush();
    assert.equal(creates, 0);
    assert.deepEqual(ws.jsonSent(), ending === 'voice:stop' ? [{ type: 'voice:done' }] : []);
  });
}

test('settings rejection after close sends no late error', async () => {
  const ws = new FakeWs();
  const settings = deferred();
  handleVoiceConnection(ws, {}, { resolveVoicePreset: () => settings.promise, createProvider: assert.fail });
  ws.emit('message', startMsg(), false);
  ws.emit('close');
  settings.reject(new Error('late settings failure'));
  await flush();
  assert.deepEqual(ws.jsonSent(), []);
});

for (const ending of ['voice:stop', 'close', 'error']) {
test(`${ending} during provider startup calls stop once and ignores late callbacks`, async () => {
  const ws = new FakeWs();
  const startup = deferred();
  let callbacks;
  let stops = 0;
  handleVoiceConnection(ws, {}, {
    resolveVoicePreset: async () => ({ preset: 'local' }),
    createProvider: () => ({
      start(cbs) { callbacks = cbs; return startup.promise; },
      pushAudio: assert.fail,
      stop() { stops++; },
    }),
  });
  ws.emit('message', startMsg(), false);
  await flush();
  if (ending === 'voice:stop') ws.emit('message', stopMsg(), false);
  else ws.emit(ending, new Error('socket ended'));
  ws.emit('message', stopMsg(), false);
  ws.emit('close');
  callbacks.onLoading({ modelId: 'parakeet-v3' });
  callbacks.onReady();
  callbacks.onPartial('late');
  callbacks.onFinal('late');
  callbacks.onError('late');
  callbacks.onDone();
  startup.reject(new Error('late startup failure'));
  await flush();
  assert.equal(stops, 1);
  assert.deepEqual(ws.jsonSent(), ending === 'voice:stop' ? [{ type: 'voice:done' }] : []);
});
}

test('normal stop keeps trailing final and done but drops later ready and partial', async () => {
  const ws = new FakeWs();
  let callbacks;
  let stops = 0;
  handleVoiceConnection(ws, {}, {
    resolveVoicePreset: async () => ({ preset: 'assemblyai' }),
    createProvider: () => ({
      async start(cbs) { callbacks = cbs; cbs.onReady(); },
      pushAudio() {}, stop() { stops++; },
    }),
  });
  ws.emit('message', startMsg(), false);
  await flush();
  ws.emit('message', stopMsg(), false);
  ws.emit('message', stopMsg(), false);
  callbacks.onReady();
  callbacks.onPartial('late');
  callbacks.onFinal('trailing final');
  callbacks.onDone();
  callbacks.onFinal('too late');
  assert.equal(stops, 1);
  assert.deepEqual(ws.jsonSent(), [
    { type: 'voice:ready', provider: 'assemblyai' },
    { type: 'voice:final', text: 'trailing final' },
    { type: 'voice:done' },
  ]);
});

test('provider startup rejection reports error and cleans up exactly once', async () => {
  const ws = new FakeWs();
  let stops = 0;
  let closes = 0;
  ws.close = () => { closes++; ws.emit('close'); };
  handleVoiceConnection(ws, {}, {
    resolveVoicePreset: async () => ({ preset: 'local' }),
    createProvider: () => ({
      async start() { throw new Error('recognizer failed'); },
      pushAudio: assert.fail,
      stop() { stops++; },
    }),
  });
  ws.emit('message', startMsg(), false);
  await flush();
  ws.emit('error', new Error('socket closed'));
  assert.equal(stops, 1);
  assert.equal(closes, 1);
  assert.deepEqual(ws.jsonSent(), [{ type: 'voice:error', message: 'recognizer failed' }]);
});
