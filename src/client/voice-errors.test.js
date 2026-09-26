import assert from 'node:assert/strict';
import { test } from 'node:test';

const { transcribeErrorMessage } = await import('./voice-errors.js');
const { setLocale, getLocale } = await import('./i18n.js');

// setLocale is process-global module state (LOCALES map lookup) — reset after every test so
// order never matters, mirroring the pattern other i18n-dependent client tests use.
function withLocale(lang, fn) {
  const prev = getLocale();
  setLocale(lang);
  try { return fn(); } finally { setLocale(prev); }
}

// ── LOCAL_ASR_UNAVAILABLE / LOCAL_TRANSCRIBE_FAILED — the three-plus-one causes (C1197) ──

test('each LocalAsrUnavailableError reasonCode produces a distinct message', () => {
  const base = { code: 'LOCAL_ASR_UNAVAILABLE' };
  const messages = new Set([
    transcribeErrorMessage({ ...base, reasonCode: 'ADDON_LOAD_FAILED', reasonDetail: { cause: 'dlopen failed' } }),
    transcribeErrorMessage({ ...base, reasonCode: 'MODEL_NOT_DOWNLOADED', reasonDetail: { model: 'Whisper base (int8)', state: 'missing' } }),
    transcribeErrorMessage({ ...base, reasonCode: 'VAD_DOWNLOAD_FAILED', reasonDetail: { cause: 'network error' } }),
    transcribeErrorMessage({ ...base, reasonCode: 'UNKNOWN_MODEL', reasonDetail: { model: 'bogus-id' } }),
    transcribeErrorMessage({ ...base, reasonCode: 'UNSUPPORTED_KIND', reasonDetail: { kind: 'exotic' } }),
  ]);
  assert.equal(messages.size, 5);
  for (const msg of messages) assert.match(msg, /Local transcription is unavailable/);
});

test('ADDON_LOAD_FAILED interpolates the native cause', () => {
  const msg = transcribeErrorMessage({
    code: 'LOCAL_ASR_UNAVAILABLE', reasonCode: 'ADDON_LOAD_FAILED', reasonDetail: { cause: 'dlopen failed: bad magic' },
  });
  assert.match(msg, /dlopen failed: bad magic/);
});

test('MODEL_NOT_DOWNLOADED interpolates the model label and a LOCALIZED state, not the raw enum', () => {
  const msg = transcribeErrorMessage({
    code: 'LOCAL_ASR_UNAVAILABLE', reasonCode: 'MODEL_NOT_DOWNLOADED', reasonDetail: { model: 'Parakeet TDT 0.6B v3 (int8)', state: 'missing' },
  });
  assert.match(msg, /Parakeet TDT 0\.6B v3 \(int8\)/);
  assert.match(msg, /Not downloaded/); // settings.voiceModelStateMissing, not the bare word "missing"
  assert.doesNotMatch(msg, /\bmissing\b/);
});

test('an unmapped/absent reasonCode on LOCAL_ASR_UNAVAILABLE falls back to the raw server message', () => {
  const msg = transcribeErrorMessage({ code: 'LOCAL_ASR_UNAVAILABLE', message: 'some future reason — finish setup in Settings > Voice' });
  assert.match(msg, /some future reason/);
});

test('LOCAL_TRANSCRIBE_FAILED (the generic 500, no reasonCode) surfaces its raw message instead of being discarded', () => {
  const msg = transcribeErrorMessage({ code: 'LOCAL_TRANSCRIBE_FAILED', message: 'decodeAsync threw: bad tensor shape' });
  assert.match(msg, /decodeAsync threw: bad tensor shape/);
});

test('reasons differ in uk too', () => {
  withLocale('uk', () => {
    const a = transcribeErrorMessage({ code: 'LOCAL_ASR_UNAVAILABLE', reasonCode: 'ADDON_LOAD_FAILED', reasonDetail: { cause: 'x' } });
    const b = transcribeErrorMessage({ code: 'LOCAL_ASR_UNAVAILABLE', reasonCode: 'MODEL_NOT_DOWNLOADED', reasonDetail: { model: 'Whisper base (int8)', state: 'missing' } });
    assert.notEqual(a, b);
    assert.doesNotMatch(a, /^Local transcription/); // localized, not the English fallback string
  });
});

// ── Untouched codes still resolve to their existing keys ──

test('ASSEMBLYAI_UNAUTHORIZED, AUDIO_TOO_LARGE, LOCAL_TIMEOUT keep their pre-C1197 mapping', () => {
  assert.match(transcribeErrorMessage({ code: 'ASSEMBLYAI_UNAUTHORIZED' }), /Settings > Voice/);
  assert.match(transcribeErrorMessage({ code: 'AUDIO_TOO_LARGE' }), /25 MB/);
  assert.match(transcribeErrorMessage({ code: 'LOCAL_TIMEOUT' }), /timed out/);
});

// ── C1203: AssemblyAI codes used to collide on 1-2 shared keys (UPSTREAM+NETWORK both hit
// voice.errUpstream, TIMEOUT+POLL_TIMEOUT both hit voice.errTimeout) — every AssemblyAI failure
// read as one of two generic strings regardless of cause. Now each has its own key. ──

test('ASSEMBLYAI_UPSTREAM/NETWORK/TIMEOUT/POLL_TIMEOUT each produce a distinct message', () => {
  const messages = new Set([
    transcribeErrorMessage({ code: 'ASSEMBLYAI_UPSTREAM', message: 'transcription failed' }),
    transcribeErrorMessage({ code: 'ASSEMBLYAI_NETWORK', message: 'fetch failed' }),
    transcribeErrorMessage({ code: 'ASSEMBLYAI_TIMEOUT', message: 'request timed out' }),
    transcribeErrorMessage({ code: 'ASSEMBLYAI_POLL_TIMEOUT', message: 'poll timed out' }),
  ]);
  assert.equal(messages.size, 4);
});

test('ASSEMBLYAI_UPSTREAM interpolates the real AssemblyAI message instead of a static string', () => {
  const msg = transcribeErrorMessage({ code: 'ASSEMBLYAI_UPSTREAM', message: 'Audio duration is too short' });
  assert.match(msg, /Audio duration is too short/);
});

test('ASSEMBLYAI_NETWORK is localized in uk too, distinct from en', () => {
  const en = transcribeErrorMessage({ code: 'ASSEMBLYAI_NETWORK' });
  withLocale('uk', () => {
    const uk = transcribeErrorMessage({ code: 'ASSEMBLYAI_NETWORK' });
    assert.notEqual(en, uk);
  });
});

// ── Fallback path ──

test('a code-less error hits the generic voice.transcribeFailed with the raw message', () => {
  const msg = transcribeErrorMessage({ message: 'network request failed' });
  assert.match(msg, /Transcription failed: network request failed/);
});

test('a nullish error does not throw', () => {
  assert.doesNotThrow(() => transcribeErrorMessage(null));
  assert.doesNotThrow(() => transcribeErrorMessage(undefined));
});
