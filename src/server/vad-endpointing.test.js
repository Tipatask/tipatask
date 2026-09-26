'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VAD_SPEECH_THRESHOLD, VAD_MIN_SPEECH_DURATION_S, VAD_MIN_SILENCE_DURATION_S, VAD_MAX_SPEECH_DURATION_S,
  DEFAULT_ENDPOINTING, ENDPOINTING_LIMITS, resolveEndpointing,
} = require('./vad-endpointing');

test('DEFAULT_ENDPOINTING is frozen and built from the named constants', () => {
  assert.ok(Object.isFrozen(DEFAULT_ENDPOINTING));
  assert.deepEqual(DEFAULT_ENDPOINTING, {
    threshold: VAD_SPEECH_THRESHOLD,
    minSpeechDuration: VAD_MIN_SPEECH_DURATION_S,
    minSilenceDuration: VAD_MIN_SILENCE_DURATION_S,
    maxSpeechDuration: VAD_MAX_SPEECH_DURATION_S,
  });
});

test('trailing-silence threshold sits above a normal mid-sentence pause (~0.6-1.2s)', () => {
  assert.ok(VAD_MIN_SILENCE_DURATION_S > 1.2);
});

test('max segment length stays under whisper-kind models\' 30s truncation limit', () => {
  assert.ok(VAD_MAX_SPEECH_DURATION_S < 30);
  assert.ok(ENDPOINTING_LIMITS.maxSpeechDuration[1] < 30);
});

test('resolveEndpointing: no/non-object overrides return a fresh copy of the defaults', () => {
  for (const input of [undefined, null, 'x', 42]) {
    const out = resolveEndpointing(input);
    assert.deepEqual(out, DEFAULT_ENDPOINTING);
    assert.notEqual(out, DEFAULT_ENDPOINTING);
  }
});

test('resolveEndpointing: merges valid overrides, drops unknown keys', () => {
  const out = resolveEndpointing({ minSilenceDuration: 2, bogus: 1 });
  assert.deepEqual(out, { ...DEFAULT_ENDPOINTING, minSilenceDuration: 2 });
});

test('resolveEndpointing: invalid values fall back to that knob\'s default', () => {
  const out = resolveEndpointing({ minSilenceDuration: NaN, minSpeechDuration: -1, threshold: '0.9', maxSpeechDuration: Infinity });
  assert.deepEqual(out, DEFAULT_ENDPOINTING);
});

test('resolveEndpointing: out-of-range values are clamped', () => {
  const out = resolveEndpointing({ minSilenceDuration: 60, maxSpeechDuration: 120, threshold: 0.001, minSpeechDuration: 0.001 });
  assert.equal(out.minSilenceDuration, ENDPOINTING_LIMITS.minSilenceDuration[1]);
  assert.equal(out.maxSpeechDuration, ENDPOINTING_LIMITS.maxSpeechDuration[1]);
  assert.equal(out.threshold, ENDPOINTING_LIMITS.threshold[0]);
  assert.equal(out.minSpeechDuration, ENDPOINTING_LIMITS.minSpeechDuration[0]);
});
