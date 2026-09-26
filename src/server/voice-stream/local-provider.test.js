'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalProvider, int16BufferToFloat32, accumulatePcmStats } = require('./local-provider');

test('createLocalProvider: relays session-owned finals without adding punctuation at a context rollover', async () => {
  const { punctuate, LocalAsrUnavailableError } = require('../local-asr');
  const session = {
    stats: { segments: 2, emptySegments: 0 },
    async init() {},
    async acceptWaveform() { return [{ text: 'First words' }]; },
    async flush() { return [{ text: 'second sentence.' }]; },
  };
  const provider = createLocalProvider({ modelId: 'parakeet-v3' }, {
    LocalAsrSession: function () { return session; }, LocalAsrUnavailableError, punctuate,
  });
  const events = [];
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  await provider.start({
    onReady() {}, onUnsupported: assert.fail, onError: assert.fail,
    onPartial: (text) => events.push(['partial', text]),
    onFinal: (text) => events.push(['final', text]),
    onDone: done,
  });
  provider.pushAudio(Buffer.alloc(8));
  provider.stop();
  await finished;
  assert.deepEqual(events, [['final', 'First words'], ['final', 'second sentence.']]);
});

// (C1202)
test('accumulatePcmStats: peak/rms over full-scale, silent, and mixed input', () => {
  const fullScale = accumulatePcmStats({ frames: 0, samples: 0, peak: 0, sumSquares: 0 }, new Float32Array([1, -1, 0.5]));
  assert.equal(fullScale.frames, 1);
  assert.equal(fullScale.samples, 3);
  assert.equal(fullScale.peak, 1);

  const silence = accumulatePcmStats({ frames: 0, samples: 0, peak: 0, sumSquares: 0 }, new Float32Array([0, 0, 0]));
  assert.equal(silence.peak, 0);
  assert.equal(silence.sumSquares, 0);

  let acc = { frames: 0, samples: 0, peak: 0, sumSquares: 0 };
  acc = accumulatePcmStats(acc, new Float32Array([0.1, 0.2]));
  acc = accumulatePcmStats(acc, new Float32Array([-0.3]));
  assert.equal(acc.frames, 2, 'accumulates across multiple calls');
  assert.equal(acc.samples, 3);
  assert.ok(Math.abs(acc.peak - 0.3) < 1e-6); // Float32Array precision, not float64
});

test('int16BufferToFloat32: converts full-scale and mid-range samples correctly', () => {
  const buf = Buffer.alloc(8);
  buf.writeInt16LE(0, 0);
  buf.writeInt16LE(32767, 2);   // max positive
  buf.writeInt16LE(-32768, 4);  // max negative
  buf.writeInt16LE(16384, 6);   // ~0.5

  const out = int16BufferToFloat32(buf);
  assert.equal(out.length, 4);
  assert.equal(out[0], 0);
  assert.ok(Math.abs(out[1] - 32767 / 32768) < 1e-6);
  assert.equal(out[2], -1);
  assert.ok(Math.abs(out[3] - 0.5) < 1e-6);
});

test('int16BufferToFloat32 rejects odd PCM before any sample read', () => {
  assert.throws(() => int16BufferToFloat32(Buffer.alloc(1)), /even byte count/);
});

test('local provider reports malformed PCM through onError without throwing from pushAudio', async () => {
  const provider = createLocalProvider({ modelId: 'fake-model' }, {
    LocalAsrSession: function () { return makeFakeSession(); },
    LocalAsrUnavailableError: class extends Error {},
  });
  const errors = [];
  await provider.start({ onReady() {}, onUnsupported: assert.fail, onError: (message) => errors.push(message), onFinal() {}, onDone() {} });
  assert.doesNotThrow(() => provider.pushAudio(Buffer.alloc(1)));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /even byte count/);
  provider.stop();
});

test('createLocalProvider: start() reports onUnsupported and never touches sherpa-onnx-node when no modelId is set', async () => {
  // If this test ever tries to require('../local-asr') (and thus sherpa-onnx-node), it would
  // throw on a machine without the native addon built — the assertion below is really an
  // assertion that that require() never happens for this path.
  const provider = createLocalProvider({ modelId: null });
  const events = [];
  await provider.start({
    onReady: () => events.push('ready'),
    onUnsupported: (reason) => events.push(`unsupported:${reason}`),
    onError: (msg) => events.push(`error:${msg}`),
    onFinal: () => events.push('final'),
    onDone: () => events.push('done'),
  });
  assert.deepEqual(events, ['unsupported:No local model selected for this project']);
});

test('createLocalProvider: pushAudio()/stop() before a successful start() are no-ops, not crashes', () => {
  const provider = createLocalProvider({ modelId: null });
  assert.doesNotThrow(() => provider.pushAudio(Buffer.from([1, 2])));
  assert.doesNotThrow(() => provider.stop());
});

// ── (C1200) fake LocalAsrSession — exercises start()/pushAudio()/stop() without the real addon ──
function makeFakeSession({ initDelayMs = 0, initError = null } = {}) {
  const calls = { acceptWaveform: [], flushed: false };
  return {
    calls,
    async init() {
      if (initDelayMs) await new Promise((r) => setTimeout(r, initDelayMs));
      if (initError) throw initError;
      this.stats = { segments: 0, emptySegments: 0 };
    },
    async acceptWaveform(samples) {
      calls.acceptWaveform.push(samples);
      return [];
    },
    async flush() {
      calls.flushed = true;
      return [];
    },
  };
}

test('stop during local initialization drops queued audio, suppresses ready, and disposes once', async () => {
  let finishInit;
  let disposed = 0;
  let decoded = 0;
  let flushed = 0;
  const session = {
    init: () => new Promise(resolve => { finishInit = resolve; }),
    async acceptWaveform() { decoded++; return [{ text: 'late' }]; },
    async flush() { flushed++; return [{ text: 'late' }]; },
    dispose() { disposed++; },
  };
  const provider = createLocalProvider({ modelId: 'fake-model' }, {
    LocalAsrSession: function () { return session; }, LocalAsrUnavailableError: class extends Error {},
  });
  const events = [];
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  const starting = provider.start({
    onReady: () => events.push('ready'), onLoading: () => events.push('loading'),
    onUnsupported: assert.fail, onError: assert.fail,
    onPartial: text => events.push(`partial:${text}`),
    onFinal: text => events.push(`final:${text}`),
    onDone: () => { events.push('done'); done(); },
  });
  provider.pushAudio(Buffer.alloc(8));
  provider.stop();
  provider.stop();
  finishInit();
  await Promise.all([starting, finished]);
  assert.equal(decoded, 0);
  assert.equal(flushed, 0);
  assert.equal(disposed, 1);
  assert.deepEqual(events, ['done']);
});

test('local initialization failure after stop disposes once without a late error', async () => {
  let failInit;
  let disposed = 0;
  const session = {
    init: () => new Promise((_resolve, reject) => { failInit = reject; }),
    dispose() { disposed++; },
  };
  const provider = createLocalProvider({ modelId: 'fake-model' }, {
    LocalAsrSession: function () { return session; }, LocalAsrUnavailableError: class extends Error {},
  });
  const events = [];
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  const starting = provider.start({
    onReady: () => events.push('ready'), onUnsupported: assert.fail,
    onError: message => events.push(`error:${message}`),
    onFinal: assert.fail, onDone: () => { events.push('done'); done(); },
  });
  provider.stop();
  failInit(new Error('late init failure'));
  await Promise.all([starting, finished]);
  assert.equal(disposed, 1);
  assert.deepEqual(events, ['done']);
});

test('createLocalProvider: onDone still fires from stop() when start() failed (not just when start() was never called)', async () => {
  class FakeUnavailable extends Error {}
  const fakeSession = makeFakeSession({ initError: new Error('boom') });
  const deps = {
    LocalAsrSession: function LocalAsrSession() { return fakeSession; },
    LocalAsrUnavailableError: FakeUnavailable,
  };
  const provider = createLocalProvider({ modelId: 'fake-model' }, deps);
  const events = [];
  await provider.start({
    onReady: () => events.push('ready'),
    onUnsupported: (r) => events.push(`unsupported:${r}`),
    onError: (m) => events.push(`error:${m}`),
    onFinal: () => events.push('final'),
    onDone: () => events.push('done'),
  });
  assert.deepEqual(events, ['error:Local transcription failed to start: boom']);
  assert.doesNotThrow(() => provider.stop());
  assert.deepEqual(events, ['error:Local transcription failed to start: boom', 'done']);
});

test('createLocalProvider: PCM frames pushed while the recognizer is still loading are queued, not dropped', async () => {
  const fakeSession = makeFakeSession({ initDelayMs: 30 });
  const deps = {
    LocalAsrSession: function LocalAsrSession() { return fakeSession; },
    LocalAsrUnavailableError: class extends Error {},
  };
  const provider = createLocalProvider({ modelId: 'fake-model' }, deps);
  const events = [];
  const startPromise = provider.start({
    onReady: () => events.push('ready'),
    onUnsupported: (r) => events.push(`unsupported:${r}`),
    onError: (m) => events.push(`error:${m}`),
    onFinal: (t) => events.push(`final:${t}`),
    onDone: () => events.push('done'),
  });
  // Push a frame before init() has resolved — pre-C1200 this hit `this.buffer.push` on a null
  // buffer and produced a decode error instead of decoding the frame once ready.
  provider.pushAudio(Buffer.from([1, 2, 3, 4]));
  await startPromise;
  assert.deepEqual(events, ['ready']);
  provider.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fakeSession.calls.acceptWaveform.length, 1, 'the frame pushed during init must still reach acceptWaveform()');
  assert.ok(fakeSession.calls.flushed);
  assert.ok(events.includes('done'));
});

// (C1202)
test('createLocalProvider: onLoading fires when init() exceeds the hint threshold, not when it is instant', async () => {
  const slowSession = makeFakeSession({ initDelayMs: 300 });
  const slowDeps = { LocalAsrSession: function () { return slowSession; }, LocalAsrUnavailableError: class extends Error {} };
  const slowProvider = createLocalProvider({ modelId: 'fake-model' }, slowDeps);
  let loadingFired = false;
  await slowProvider.start({
    onReady: () => {}, onUnsupported: () => {}, onError: () => {}, onFinal: () => {}, onDone: () => {},
    onLoading: () => { loadingFired = true; },
  });
  assert.equal(loadingFired, true);

  const fastSession = makeFakeSession({ initDelayMs: 0 });
  const fastDeps = { LocalAsrSession: function () { return fastSession; }, LocalAsrUnavailableError: class extends Error {} };
  const fastProvider = createLocalProvider({ modelId: 'fake-model' }, fastDeps);
  let fastLoadingFired = false;
  await fastProvider.start({
    onReady: () => {}, onUnsupported: () => {}, onError: () => {}, onFinal: () => {}, onDone: () => {},
    onLoading: () => { fastLoadingFired = true; },
  });
  assert.equal(fastLoadingFired, false, 'a fast/warm init must never flash the loading hint');
});

test('createLocalProvider: onDone receives a stats payload with frames/bytes/peak/rms/segments/initMs', async () => {
  const fakeSession = makeFakeSession({ initDelayMs: 0 });
  fakeSession.acceptWaveform = async (samples) => { fakeSession.calls.acceptWaveform.push(samples); return []; };
  const deps = { LocalAsrSession: function () { return fakeSession; }, LocalAsrUnavailableError: class extends Error {} };
  const provider = createLocalProvider({ modelId: 'fake-model' }, deps);
  let stats;
  await provider.start({ onReady: () => {}, onUnsupported: () => {}, onError: () => {}, onFinal: () => {}, onDone: (s) => { stats = s; } });
  provider.pushAudio(Buffer.from([0, 64, 0, 64])); // two int16 samples, 16384 -> 0.5
  provider.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stats.modelId, 'fake-model');
  assert.equal(stats.frames, 1);
  assert.equal(stats.bytes, 4);
  assert.equal(stats.samples, 2);
  assert.ok(Math.abs(stats.peak - 0.5) < 1e-6);
  assert.equal(typeof stats.initMs, 'number');
  assert.equal(stats.segments, 0);
  assert.equal(stats.emptySegments, 0);
});

test('createLocalProvider: ctx.sampleRate mismatch rejects via onUnsupported before touching the recognizer', async () => {
  let recognizerTouched = false;
  const deps = {
    LocalAsrSession: function () { recognizerTouched = true; return makeFakeSession(); },
    LocalAsrUnavailableError: class extends Error {},
  };
  const provider = createLocalProvider({ modelId: 'fake-model', sampleRate: 44100 }, deps);
  const events = [];
  await provider.start({
    onReady: () => events.push('ready'),
    onUnsupported: (reason, extra) => events.push({ reason, extra }),
    onError: (m) => events.push(`error:${m}`),
    onFinal: () => {},
    onDone: () => {},
  });
  assert.equal(recognizerTouched, false);
  assert.equal(events.length, 1);
  assert.match(events[0].reason, /44100/);
  assert.equal(events[0].extra.reasonCode, 'SAMPLE_RATE_MISMATCH');
});

// ── VAD endpointing is threaded from the provider ctx into the session factory ──
test('createLocalProvider: ctx.endpointing reaches LocalAsrSession and is reported on onDone stats', async () => {
  const endpointing = { threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 2, maxSpeechDuration: 20 };
  let ctorArgs = null;
  const fakeSession = makeFakeSession();
  fakeSession.endpointing = endpointing;
  const deps = {
    LocalAsrSession: function (args) { ctorArgs = args; return fakeSession; },
    LocalAsrUnavailableError: class extends Error {},
  };
  const provider = createLocalProvider({ modelId: 'fake-model', endpointing }, deps);
  let doneStats = null;
  await provider.start({ onReady() {}, onUnsupported() {}, onError() {}, onFinal() {}, onDone: (s) => { doneStats = s; } });
  assert.deepEqual(ctorArgs, { modelId: 'fake-model', endpointing });
  provider.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(doneStats.endpointing, endpointing);
});

test('createLocalProvider: a ctx with no endpointing leaves the session on its own defaults', async () => {
  let ctorArgs = null;
  const deps = {
    LocalAsrSession: function (args) { ctorArgs = args; return makeFakeSession(); },
    LocalAsrUnavailableError: class extends Error {},
  };
  const provider = createLocalProvider({ modelId: 'fake-model' }, deps);
  await provider.start({ onReady() {}, onUnsupported() {}, onError() {}, onFinal() {}, onDone() {} });
  assert.deepEqual(ctorArgs, { modelId: 'fake-model', endpointing: null });
  provider.stop();
});


test('local provider: revisions precede final once, later partial follows prior final, done is last', async () => {
  const events = [];
  let call = 0;
  const session = {
    stats: { segments: 4, emptySegments: 0 }, partial: null,
    async init() {},
    async acceptWaveform() {
      call++;
      this.partial = { text: call === 1 ? 'Keep thinking.' : call < 4 ? 'Keep thinking about it' : 'Next sentence' };
      return call === 4 ? [{ text: 'Keep thinking about it.' }] : [];
    },
    async flush() { this.partial = null; return [{ text: 'Next sentence.' }]; },
  };
  const provider = createLocalProvider({ modelId: 'parakeet-v3' }, {
    LocalAsrSession: function () { return session; }, LocalAsrUnavailableError: class extends Error {},
  });
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  await provider.start({ onReady() {}, onUnsupported: assert.fail, onError: assert.fail,
    onPartial: text => events.push(['partial', text]), onFinal: text => events.push(['final', text]),
    onDone: () => { events.push(['done']); done(); },
  });
  for (let i = 0; i < 4; i++) provider.pushAudio(Buffer.alloc(8));
  provider.stop();
  provider.stop();
  provider.pushAudio(Buffer.alloc(8));
  await finished;
  assert.equal(call, 4);
  assert.deepEqual(events, [
    ['partial', 'Keep thinking.'], ['partial', 'Keep thinking about it'],
    ['final', 'Keep thinking about it.'], ['partial', 'Next sentence'],
    ['final', 'Next sentence.'], ['done'],
  ]);
});
