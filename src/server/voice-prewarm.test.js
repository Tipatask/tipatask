'use strict';

// (C1202) Exercises the gate/dedupe logic in voice-prewarm.js with fully injected deps — never
// touches project-config.js, voice-model-manager.js, or local-asr.js (and therefore never
// sherpa-onnx-node), matching the deps-injection idiom used by session.js/local-provider.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { prewarmVoice } = require('./voice-prewarm');

function fakeDeps({ voicePreset = 'local', voiceLocalModel = 'parakeet-v3', modelState = 'ready', warmError = null } = {}) {
  const calls = { readVoiceSettings: 0, getVoiceModelStatus: [], warmLocalAsr: [] };
  return {
    calls,
    readVoiceSettings: (root) => { calls.readVoiceSettings += 1; return { voicePreset, voiceLocalModel }; },
    getVoiceModelStatus: async (id) => { calls.getVoiceModelStatus.push(id); return { state: modelState }; },
    warmLocalAsr: async (id) => {
      calls.warmLocalAsr.push(id);
      if (warmError) throw warmError;
      return true;
    },
  };
}

test('prewarmVoice: no-op on the assemblyai preset, never calls getVoiceModelStatus/warmLocalAsr', async () => {
  const deps = fakeDeps({ voicePreset: 'assemblyai' });
  const result = await prewarmVoice('/proj', {}, deps);
  assert.equal(result, false);
  assert.deepEqual(deps.calls.getVoiceModelStatus, []);
  assert.deepEqual(deps.calls.warmLocalAsr, []);
});

test('prewarmVoice: no-op when the configured model is not fully downloaded', async () => {
  const deps = fakeDeps({ modelState: 'partial' });
  const result = await prewarmVoice('/proj', {}, deps);
  assert.equal(result, false);
  assert.deepEqual(deps.calls.getVoiceModelStatus, ['parakeet-v3']);
  assert.deepEqual(deps.calls.warmLocalAsr, [], 'must never trigger a download via warm');
});

test('prewarmVoice: local + ready model warms exactly once', async () => {
  const deps = fakeDeps();
  const result = await prewarmVoice('/proj', {}, deps);
  assert.equal(result, true);
  assert.deepEqual(deps.calls.warmLocalAsr, ['parakeet-v3']);
});

test('prewarmVoice: opts.modelId gates against the project\'s actual configured model', async () => {
  const deps = fakeDeps({ voiceLocalModel: 'parakeet-v3' });
  const skipped = await prewarmVoice('/proj', { modelId: 'whisper-base' }, deps);
  assert.equal(skipped, false, 'a download-complete for a model the project is not using must not warm it');
  assert.deepEqual(deps.calls.warmLocalAsr, []);

  const matched = await prewarmVoice('/proj', { modelId: 'parakeet-v3' }, deps);
  assert.equal(matched, true);
});

test('prewarmVoice: a rejected warm clears the in-flight guard so a later call can retry', async () => {
  const failing = fakeDeps({ warmError: new Error('boom') });
  await assert.doesNotReject(prewarmVoice('/proj', {}, failing));
  const result1 = await prewarmVoice('/proj', {}, failing);
  assert.equal(result1, false, 'warmLocalAsr threw, so this call reports failure, not success');

  const succeeding = fakeDeps();
  const result2 = await prewarmVoice('/proj', {}, succeeding);
  assert.equal(result2, true, 'a fresh deps object (simulating the same modelId after the guard cleared) must be able to warm');
});

test('prewarmVoice: concurrent triggers for the same model only warm once', async () => {
  const deps = fakeDeps();
  const [a, b] = await Promise.all([prewarmVoice('/proj', {}, deps), prewarmVoice('/proj', {}, deps)]);
  // One of the two sees `_warming` already held and short-circuits to false; exactly one
  // actually calls warmLocalAsr.
  assert.equal(deps.calls.warmLocalAsr.length, 1);
  assert.ok([a, b].includes(true));
});

test('prewarmVoice: readVoiceSettings throwing is caught, never propagates', async () => {
  const deps = {
    readVoiceSettings: () => { throw new Error('bad config'); },
    getVoiceModelStatus: async () => ({ state: 'ready' }),
    warmLocalAsr: async () => true,
  };
  await assert.doesNotReject(async () => {
    const result = await prewarmVoice('/proj', {}, deps);
    assert.equal(result, false);
  });
});

test('prewarmVoice: TIPATASK_VOICE_PREWARM=0 disables entirely', async () => {
  const prev = process.env.TIPATASK_VOICE_PREWARM;
  process.env.TIPATASK_VOICE_PREWARM = '0';
  try {
    const deps = fakeDeps();
    const result = await prewarmVoice('/proj', {}, deps);
    assert.equal(result, false);
    assert.equal(deps.calls.readVoiceSettings, 0);
  } finally {
    if (prev === undefined) delete process.env.TIPATASK_VOICE_PREWARM;
    else process.env.TIPATASK_VOICE_PREWARM = prev;
  }
});
