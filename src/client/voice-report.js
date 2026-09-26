// (C1202) Pure decision table for "this recording produced zero text — what do we tell the
// user?" Extracted out of audio-recorder.js so it's `node --test`-able like voice-errors.js and
// voice-model-state.js (no DOM, only imports `t`). Before this, EVERY zero-text recording
// rendered as `voice.noSpeech` ("No speech detected") — a literal false negative for a blocked
// mic, a silently-muted capture, a still-loading local model, or an unsupported backend. See
// tt-audio-input.md § Voice Input False Negatives (C1202).

import { t } from './i18n.js';

// Below this peak amplitude (0..1, same scale as audio-recorder.js's SILENCE_RMS_THRESHOLD),
// treat the whole recording as having captured no real audio at all — the mic-entitlement/
// muted-track case, not "the user spoke quietly".
export const MIC_SILENCE_PEAK = 0.01;

// `input`:
//   micAccess    'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown' | null
//   micMuted     boolean — a MediaStreamTrack 'mute' event fired during this recording
//   micPeak      number 0..1 — peak amplitude seen by the client's own level tap
//   streamIssue  { kind: 'error'|'unsupported', message } | null — from voice-stream.js callbacks
//   modelLoading boolean — a voice:loading frame arrived and voice:ready never did
// Returns { key, params } for t(key, params).
export function chooseNothingProducedMessage({ micAccess, micMuted, micPeak, streamIssue, modelLoading } = {}) {
  if (micAccess === 'denied' || micAccess === 'restricted') {
    return { key: 'voice.micBlocked', params: {} };
  }
  if (micMuted || (typeof micPeak === 'number' && micPeak < MIC_SILENCE_PEAK)) {
    return { key: 'voice.micSilent', params: {} };
  }
  if (streamIssue && streamIssue.kind === 'error') {
    return { key: 'voice.errStreamFailed', params: { msg: streamIssue.message } };
  }
  if (modelLoading) {
    return { key: 'voice.modelLoading', params: {} };
  }
  if (streamIssue && streamIssue.kind === 'unsupported') {
    return { key: 'voice.errStreamUnsupported', params: { reason: streamIssue.message } };
  }
  return { key: 'voice.noSpeech', params: {} };
}

// Convenience wrapper matching transcribeErrorMessage()'s shape (voice-errors.js) — resolves
// straight to the localized string instead of the {key, params} pair, for callers that don't
// need to branch on which case fired.
export function nothingProducedMessage(input) {
  const { key, params } = chooseNothingProducedMessage(input);
  return t(key, params);
}
