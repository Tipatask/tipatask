'use strict';

// Silero VAD endpointing knobs for local ASR (local-asr.js) — when a speech segment opens and,
// how long a pause must last before it closes. Whisper finalizes each segment; Parakeet uses
// segments to revise rolling context and has a separate sentence-finalization pause.
//
// Pure module on purpose (no sherpa-onnx-node, no voice-model-manager): voice-stream/index.js
// puts these on the local provider's ctx, and neither it nor local-provider.js may load
// local-asr.js at module load — see local-provider.js's header comment.
//
// sherpa-onnx-node's SileroVadModelConfig exposes exactly threshold / minSilenceDuration /
// minSpeechDuration / windowSize / maxSpeechDuration. There is NO speech-pad knob in the node
// addon, so none is defined here.

// Speech probability above which a 512-sample window counts as speech.
const VAD_SPEECH_THRESHOLD = 0.5;
// Shortest burst (seconds) that opens a segment — filters clicks/coughs.
const VAD_MIN_SPEECH_DURATION_S = 0.25;
// Trailing silence (seconds) that closes a segment. A mid-sentence pause runs ~0.6-1.2s, so this
// sits above that range; it delays Whisper finals and Parakeet provisional revisions.
const VAD_MIN_SILENCE_DURATION_S = 1.4;
// Hard cap (seconds) on one segment — keeps every segment under whisper-kind models' 30s
// truncation limit no matter how long the speaker goes without pausing.
const VAD_MAX_SPEECH_DURATION_S = 20;

const DEFAULT_ENDPOINTING = Object.freeze({
  threshold: VAD_SPEECH_THRESHOLD,
  minSpeechDuration: VAD_MIN_SPEECH_DURATION_S,
  minSilenceDuration: VAD_MIN_SILENCE_DURATION_S,
  maxSpeechDuration: VAD_MAX_SPEECH_DURATION_S,
});

// [min, max] per knob — an override outside its range is clamped, not rejected.
const ENDPOINTING_LIMITS = Object.freeze({
  threshold: [0.05, 0.95],
  minSpeechDuration: [0.05, 2],
  minSilenceDuration: [0.1, 5],
  maxSpeechDuration: [1, 28],
});

// Merges caller overrides over DEFAULT_ENDPOINTING. Never throws: a missing, non-object,
// non-finite or non-positive value falls back to that knob's default; unknown keys are dropped.
function resolveEndpointing(overrides) {
  const out = { ...DEFAULT_ENDPOINTING };
  if (!overrides || typeof overrides !== 'object') return out;
  for (const key of Object.keys(DEFAULT_ENDPOINTING)) {
    const value = overrides[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    const [min, max] = ENDPOINTING_LIMITS[key];
    out[key] = Math.min(max, Math.max(min, value));
  }
  return out;
}

module.exports = {
  VAD_SPEECH_THRESHOLD,
  VAD_MIN_SPEECH_DURATION_S,
  VAD_MIN_SILENCE_DURATION_S,
  VAD_MAX_SPEECH_DURATION_S,
  DEFAULT_ENDPOINTING,
  ENDPOINTING_LIMITS,
  resolveEndpointing,
};
