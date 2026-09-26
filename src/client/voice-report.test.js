import assert from 'node:assert/strict';
import { test } from 'node:test';

const { chooseNothingProducedMessage, nothingProducedMessage, MIC_SILENCE_PEAK } = await import('./voice-report.js');

test('chooseNothingProducedMessage: mic access blocked wins over everything else', () => {
  assert.deepEqual(
    chooseNothingProducedMessage({ micAccess: 'denied', streamIssue: { kind: 'error', message: 'boom' }, micPeak: 1 }),
    { key: 'voice.micBlocked', params: {} },
  );
  assert.equal(chooseNothingProducedMessage({ micAccess: 'restricted' }).key, 'voice.micBlocked');
});

test('chooseNothingProducedMessage: silent/muted mic beats a stream issue', () => {
  assert.deepEqual(
    chooseNothingProducedMessage({ micPeak: 0, streamIssue: { kind: 'error', message: 'x' } }),
    { key: 'voice.micSilent', params: {} },
  );
  assert.equal(chooseNothingProducedMessage({ micMuted: true, micPeak: 1 }).key, 'voice.micSilent');
  assert.equal(chooseNothingProducedMessage({ micPeak: MIC_SILENCE_PEAK - 0.001 }).key, 'voice.micSilent');
  assert.equal(chooseNothingProducedMessage({ micPeak: MIC_SILENCE_PEAK + 0.001 }).key, 'voice.noSpeech');
});

test('chooseNothingProducedMessage: a real stream error reports voice.errStreamFailed with its message', () => {
  assert.deepEqual(
    chooseNothingProducedMessage({ micPeak: 0.5, streamIssue: { kind: 'error', message: 'decode failed' } }),
    { key: 'voice.errStreamFailed', params: { msg: 'decode failed' } },
  );
});

test('chooseNothingProducedMessage: still-loading beats an unsupported streamIssue', () => {
  assert.deepEqual(
    chooseNothingProducedMessage({ micPeak: 0.5, modelLoading: true, streamIssue: { kind: 'unsupported', message: 'model not ready' } }),
    { key: 'voice.modelLoading', params: {} },
  );
});

test('chooseNothingProducedMessage: unsupported streamIssue is reported, not swallowed into noSpeech', () => {
  assert.deepEqual(
    chooseNothingProducedMessage({ micPeak: 0.5, streamIssue: { kind: 'unsupported', message: 'no local model selected' } }),
    { key: 'voice.errStreamUnsupported', params: { reason: 'no local model selected' } },
  );
});

test('chooseNothingProducedMessage: falls through to voice.noSpeech when nothing else applies', () => {
  assert.deepEqual(chooseNothingProducedMessage({ micPeak: 0.5 }), { key: 'voice.noSpeech', params: {} });
  assert.deepEqual(chooseNothingProducedMessage(), { key: 'voice.noSpeech', params: {} });
});

test('nothingProducedMessage resolves to a real localized string', () => {
  const msg = nothingProducedMessage({ micAccess: 'denied' });
  assert.equal(typeof msg, 'string');
  assert.ok(msg.length > 0);
});
