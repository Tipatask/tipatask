'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalAsrSession, punctuate, SAMPLE_RATE, PARAKEET_CONTEXT_SECONDS, compactSpeechGaps } = require('./local-asr');

function twoSentences() {
  return {
    text: 'hello world this is next',
    tokens: ['▁hello', '▁world', '▁this', '▁is', '▁next'],
    timestamps: [0, 0.4, 5.2, 5.6, 5.9],
    durations: [0.3, 0.3, 0.3, 0.2, 0.3],
    lang: 'en',
  };
}

test('punctuate: two sentences inside one final segment use word-end to word-start silence', () => {
  const result = twoSentences();
  assert.equal(punctuate(result.text, result), 'Hello world. This is next.');
});

test('punctuate: ordinary thinking pauses and slowly spoken words stay in one sentence', () => {
  for (const [timestamps, durations] of [
    [[0, 1.3], [0.3, 0.2]], // 1 second of silence
    [[0, 2.3], [0.3, 0.2]], // 2 seconds of silence
    [[0, 3.3], [0.3, 0.2]], // 3 seconds of silence
    [[0, 2], [1.5, 0.2]],   // long word, only 0.5 seconds of silence
  ]) {
    assert.equal(punctuate('keep going', { tokens: [' keep', ' going'], timestamps, durations }), 'Keep going.');
  }
});

test('punctuate: aligns subwords and standalone space markers without splitting a word', () => {
  assert.equal(punctuate('testing done next', {
    tokens: ['▁test', 'ing', '▁', 'done', '▁next'],
    timestamps: [0, 2, 2.2, 2.3, 7.1],
    durations: [0.2, 0.1, 0, 0.3, 0.2],
  }), 'Testing done. Next.');
});

test('punctuate: malformed/missing/misaligned timing data falls back without inventing boundaries', () => {
  const valid = twoSentences();
  for (const timing of [
    undefined, null, {},
    { ...valid, durations: undefined },
    { ...valid, durations: [] },
    { ...valid, tokens: [null, ...valid.tokens.slice(1)] },
    { ...valid, tokens: ['<0xFF>', ...valid.tokens.slice(1)] },
    { ...valid, timestamps: [0, NaN, 2.2, 2.6, 2.9] },
    { ...valid, timestamps: [0, -1, 2.2, 2.6, 2.9] },
    { ...valid, timestamps: [0, 1, 0.5, 2.6, 2.9] },
    { ...valid, timestamps: [0, '0.4', 2.2, 2.6, 2.9] },
    { ...valid, durations: [0.3, Infinity, 0.3, 0.2, 0.3] },
    { ...valid, durations: [-1, 0.3, 0.3, 0.2, 0.3] },
  ]) {
    assert.equal(punctuate(valid.text, timing), 'Hello world this is next.');
  }
});

test('punctuate: empty/silent results never acquire punctuation', () => {
  for (const text of ['', '  ', null, undefined]) assert.equal(punctuate(text), '');
  assert.equal(punctuate('...'), '...');
});

test('punctuate: preserves existing punctuation, acronyms, numbers, and Unicode text', () => {
  for (const [input, expected] of [
    ['hello NASA', 'Hello NASA.'],
    ['привіт світе', 'Привіт світе.'],
    ['«привіт»', '«Привіт.»'],
    ['"hello!"', '"Hello!"'],
    ['hello?', 'Hello?'],
    ['hello…', 'Hello…'],
    ['你好。', '你好。'],
    ['version 2.5 works', 'Version 2.5 works.'],
    ['  Hello world. This is next.  ', 'Hello world. This is next.'],
  ]) assert.equal(punctuate(input), expected);
});

test('punctuate: timing gaps never add a period after an existing comma or colon', () => {
  for (const mark of [',', ':', ';', '.', '?', '!']) {
    const text = `Hello${mark} next`;
    assert.equal(punctuate(text, {
      tokens: [` Hello${mark}`, ' next'], timestamps: [0, 3], durations: [0.3, 0.2],
    }), `${text}.`);
  }
});

test('punctuate: decoder and provider passes are idempotent, including with original timings', () => {
  const result = twoSentences();
  const once = punctuate(result.text, result);
  assert.equal(punctuate(once), once);
  assert.equal(punctuate(once, result), once);
});

function sessionWithResults(modelId, results) {
  const session = new LocalAsrSession({ modelId });
  session.recognizer = {
    createStream: () => ({ acceptWaveform() {} }),
    decodeAsync: async () => results.shift(),
  };
  return session;
}

test('LocalAsrSession: Parakeet v2/v3 finals are punctuated before returning from the decoder', async () => {
  for (const modelId of ['parakeet-v2', 'parakeet-v3']) {
    const session = sessionWithResults(modelId, [twoSentences()]);
    assert.deepEqual(await session._decodeSegment(new Float32Array(512)), {
      text: 'Hello world. This is next.', lang: 'en',
    });
  }
});

test('LocalAsrSession: Whisper keeps its own punctuation/casing', async () => {
  const session = sessionWithResults('whisper-base', [{ text: ' iPhone works, right?', lang: 'en' }]);
  assert.deepEqual(await session._decodeSegment(new Float32Array(512)), { text: 'iPhone works, right?', lang: 'en' });
});

function fakeVadSession(results, modelId = 'parakeet-v3') {
  const session = sessionWithResults(modelId, results);
  const decodedAudio = [];
  session.recognizer.createStream = () => ({ acceptWaveform({ samples }) { decodedAudio.push(samples); } });
  const segments = [];
  let queued = new Float32Array(0);
  session.buffer = {
    push(samples) { const next = new Float32Array(queued.length + samples.length); next.set(queued); next.set(samples, queued.length); queued = next; },
    size: () => queued.length, head: () => 0,
    get: (_, size, external) => { assert.equal(external, false); return queued.slice(0, size); },
    pop(size) { queued = queued.slice(size); },
  };
  let detected = false;
  const windows = [];
  session.vad = {
    isEmpty: () => !segments.length,
    isDetected: () => detected,
    front: external => { assert.equal(external, false); return segments[0]; },
    pop: () => segments.shift(), flush() {},
    acceptWaveform(samples) { windows.push(samples); },
  };
  return {
    session, decodedAudio, windows,
    detected(value) { detected = value; },
    segment(start, seconds, amplitude = 0.25) {
      segments.push({ start: Math.round(start * SAMPLE_RATE), samples: new Float32Array(Math.round(seconds * SAMPLE_RATE)).fill(amplitude) });
      session.processedSamples = Math.round((start + seconds) * SAMPLE_RATE);
      return session._drainSegments();
    },
  };
}

test('Parakeet: 1–3 second gaps retain audio context, revise partial punctuation, and commit once on stop', async () => {
  for (const modelId of ['parakeet-v2', 'parakeet-v3']) {
    for (const gap of [1, 2, 3]) {
      const f = fakeVadSession([{ text: 'keep thinking.' }, { text: 'keep thinking about the next words' }], modelId);
      assert.deepEqual(await f.segment(0, 1), []);
      assert.equal(f.session.partial.text, 'Keep thinking.');
      assert.deepEqual(await f.segment(1 + gap, 1, 0.5), []);
      assert.equal(f.session.partial.text, 'Keep thinking about the next words');
      const audio = f.decodedAudio[1];
      assert.equal(audio.length, (2 + gap) * SAMPLE_RATE);
      assert.equal(audio[0], 0.25);
      assert.equal(audio[SAMPLE_RATE], 0, 'preserve intervening silence in context');
      assert.equal(audio.at(-1), 0.5);
      assert.deepEqual(await f.session.flush(), [{ text: 'Keep thinking about the next words.', lang: null }]);
      assert.deepEqual(await f.session.flush(), []);
      assert.equal(f.session.partial, null);
      assert.deepEqual(await f.session.acceptWaveform(new Float32Array(800)), []);
    }
  }
});

test('Parakeet: finalization uses four seconds of audio silence, not decode latency', async () => {
  const f = fakeVadSession([{ text: 'first sentence' }, { text: 'second sentence?' }]);
  await f.segment(0, 1);
  assert.deepEqual(await f.session.acceptWaveform(new Float32Array(3 * SAMPLE_RATE)), []);
  assert.deepEqual(await f.session.acceptWaveform(new Float32Array(SAMPLE_RATE)), [{ text: 'First sentence.', lang: null }]);
  await f.segment(5, 1);
  assert.deepEqual(await f.session.flush(), [{ text: 'Second sentence?', lang: null }]);
});

test('Parakeet: resumed but unfinished speech prevents finalizing the earlier partial', async () => {
  const f = fakeVadSession([{ text: 'please keep' }, { text: 'please keep listening' }]);
  await f.segment(0, 1);
  f.detected(true);
  assert.deepEqual(await f.session.acceptWaveform(new Float32Array(5 * SAMPLE_RATE)), []);
  assert.deepEqual(await f.segment(3, 3), []);
  assert.deepEqual(await f.session.flush(), [{ text: 'Please keep listening.', lang: null }]);
});

test('Parakeet: a genuine long boundary commits the previous sentence before starting another', async () => {
  const f = fakeVadSession([{ text: 'first sentence' }, { text: 'next sentence' }]);
  await f.segment(0, 1);
  assert.deepEqual(await f.segment(5.5, 1), [{ text: 'First sentence.', lang: null }]);
  assert.equal(f.decodedAudio[1].length, SAMPLE_RATE, 'committed audio cannot be decoded twice');
  assert.deepEqual(await f.session.flush(), [{ text: 'Next sentence.', lang: null }]);
});

test('Parakeet: forced VAD split and bounded context rollover do not invent periods', async () => {
  const f = fakeVadSession([{ text: 'keep' }, { text: 'keep going' }, { text: 'until done' }]);
  await f.segment(0, 20);
  assert.deepEqual(await f.segment(20, 20), []);
  assert.equal(f.session.partial.text, 'Keep going');
  assert.deepEqual(await f.segment(40, 20), [{ text: 'Keep going', lang: null }]);
  assert.ok(f.decodedAudio.every(samples => samples.length <= PARAKEET_CONTEXT_SECONDS * SAMPLE_RATE));
  assert.deepEqual(await f.session.flush(), [{ text: 'until done.', lang: null }]);
});

test('Parakeet: a blank repeated decode preserves prior speech and blank sessions stay empty', async () => {
  const f = fakeVadSession([{ text: 'hello' }, { text: '' }]);
  await f.segment(0, 1);
  await f.segment(2, 1);
  assert.deepEqual(await f.session.flush(), [{ text: 'Hello.', lang: null }]);
  assert.deepEqual(f.session.stats, { segments: 2, emptySegments: 1 });
  const blank = fakeVadSession([{ text: '' }]);
  await blank.segment(0, 1);
  assert.deepEqual(await blank.session.flush(), []);
});

test('stop: flush feeds the final incomplete VAD window and returns trailing speech only once', async () => {
  const f = fakeVadSession([{ text: 'last words' }]);
  await f.session.acceptWaveform(new Float32Array(111).fill(0.5));
  let flushes = 0;
  f.session.vad.flush = () => {
    flushes++;
    const segment = { start: 0, samples: f.windows[0] };
    let pending = true;
    f.session.vad.isEmpty = () => !pending;
    f.session.vad.front = () => segment;
    f.session.vad.pop = () => { pending = false; };
  };
  assert.deepEqual(await f.session.flush(), [{ text: 'Last words.', lang: null }]);
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0][110], 0.5);
  assert.equal(f.windows[0][111], 0);
  assert.deepEqual(await f.session.flush(), []);
  assert.equal(flushes, 1);
});

test('Whisper: VAD segments remain immediate finals', async () => {
  const f = fakeVadSession([{ text: 'iPhone works, right?' }], 'whisper-base');
  assert.deepEqual(await f.segment(0, 1), [{ text: 'iPhone works, right?', lang: null }]);
  assert.equal(f.session.partial, null);
  assert.deepEqual(await f.session.flush(), []);
});


test('recognition copy: compress thinking silence without losing speech, leading/trailing audio, or long boundaries', () => {
  const samples = Float32Array.from({ length: 12 * SAMPLE_RATE }, (_, i) => i / (12 * SAMPLE_RATE));
  const region = (start, end) => ({ start: start * SAMPLE_RATE, end: end * SAMPLE_RATE });
  const compact = compactSpeechGaps(samples, [region(0.1, 1), region(3, 4), region(9, 10)]);
  const kept = Math.round(0.08 * SAMPLE_RATE);
  assert.equal(compact.length, samples.length - 2 * SAMPLE_RATE + kept);
  assert.deepEqual(compact.slice(0, SAMPLE_RATE + kept), samples.slice(0, SAMPLE_RATE + kept));
  assert.deepEqual(compact.slice(SAMPLE_RATE + kept), samples.slice(3 * SAMPLE_RATE));
  assert.equal(samples.length, 12 * SAMPLE_RATE, 'original audio timeline stays unchanged');
  assert.equal(compactSpeechGaps(samples, []), samples);
  assert.equal(compactSpeechGaps(samples, [region(0, 1), region(1.1, 2)]), samples, 'short phoneme gaps stay intact');
  assert.equal(compactSpeechGaps(samples, [region(0, 1), region(0.8, 2)]), samples, 'overlapping speech is never cut');
  assert.equal(compactSpeechGaps(samples, [{ start: NaN, end: 1 }]), samples, 'malformed spans fail open');
});

test('Parakeet: model-provided internal sentence punctuation survives rolling revisions', async () => {
  const f = fakeVadSession([{ text: 'We are ready.' }, { text: 'We are ready. Are you?' }]);
  await f.segment(0, 1);
  await f.segment(2, 1);
  assert.deepEqual(await f.session.flush(), [{ text: 'We are ready. Are you?', lang: null }]);
});
