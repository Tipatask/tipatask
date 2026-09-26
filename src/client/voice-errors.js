// (C1197) Pure mapping from a POST /api/transcribe error (thrown by api-client.js#transcribeAudio,
// carrying `.code`/`.reasonCode`/`.reasonDetail` off the JSON body) to a localized toast message.
// No DOM, only imports `t` from ./i18n.js — mirrors voice-model-state.js so this stays
// `node --test`-able. Extracted out of audio-recorder.js, where it was module-private and
// untested (was `transcribeErrorMessage`, lines 20-33 pre-C1197).

import { t } from './i18n.js';
import { voiceModelStateLabelKey } from './voice-model-state.js';

// POST /api/transcribe error `code` -> localized i18n key. Raw server-side messages are always
// English (assemblyai-batch.js, ws-handlers.js) — without this map they'd leak untranslated into
// a Ukrainian UI via voice.transcribeFailed's {msg} interpolation. Any code not listed here (or
// no code at all — e.g. a network-level fetch failure) falls back to that generic message.
// LOCAL_ASR_UNAVAILABLE/LOCAL_TRANSCRIBE_FAILED are handled separately below via `reasonCode`.
//
// (C1203) UPSTREAM/NETWORK used to collide on voice.errUpstream, and TIMEOUT/POLL_TIMEOUT on
// voice.errTimeout — every AssemblyAI failure read as the same one or two static strings no
// matter the actual cause, which is the "generic failure" this task fixed. Each AssemblyAI code
// now has its own key; voice.errUpstream additionally takes an interpolated {detail} (the real
// AssemblyAI message) instead of a static string — same convention voice.reasonAddonMissing
// ({cause}) and voice.errStreamFailed ({msg}) already use for raw-English detail.
export const ERROR_CODE_I18N_KEY = {
  ASSEMBLYAI_UNAUTHORIZED: 'voice.errKeyInvalid',
  AUDIO_TOO_LARGE: 'voice.errTooLarge',
  LOCAL_TIMEOUT: 'voice.errTimeout',
  ASSEMBLYAI_TIMEOUT: 'voice.errRequestTimeout',
  ASSEMBLYAI_POLL_TIMEOUT: 'voice.errPollTimeout',
  ASSEMBLYAI_UPSTREAM: 'voice.errUpstream',
  ASSEMBLYAI_NETWORK: 'voice.errNetwork',
};

// local-asr.js's LocalAsrUnavailableError.reasonCode -> the localized {reason} sub-message for
// voice.errEngineUnavailable. Keep in sync with LOCAL_ASR_REASONS in local-asr.js.
export const LOCAL_ASR_REASON_I18N_KEY = {
  ADDON_LOAD_FAILED: 'voice.reasonAddonMissing',
  MODEL_NOT_DOWNLOADED: 'voice.reasonModelNotDownloaded',
  VAD_DOWNLOAD_FAILED: 'voice.reasonVadFailed',
  UNKNOWN_MODEL: 'voice.reasonUnknownModel',
  UNSUPPORTED_KIND: 'voice.reasonUnsupportedKind',
};

// Builds the {reason} param for voice.errEngineUnavailable. A known reasonCode gets a fully
// localized sub-message (state further localized via voiceModelStateLabelKey, not passed raw);
// no reasonCode (LOCAL_TRANSCRIBE_FAILED's generic catch-all, or an old/unmapped code) falls back
// to the server's raw English err.message — still better than the static string it replaces.
function localAsrReason(err) {
  const key = err.reasonCode && LOCAL_ASR_REASON_I18N_KEY[err.reasonCode];
  if (!key) return err.message || '';
  const detail = err.reasonDetail || {};
  const params = key === 'voice.reasonModelNotDownloaded'
    ? { ...detail, state: t(voiceModelStateLabelKey(detail.state)) }
    : detail;
  return t(key, params);
}

export function transcribeErrorMessage(err) {
  if (!err) return t('voice.transcribeFailed', { msg: '' });
  if (err.code === 'LOCAL_ASR_UNAVAILABLE' || err.code === 'LOCAL_TRANSCRIBE_FAILED') {
    return t('voice.errEngineUnavailable', { reason: localAsrReason(err) });
  }
  const key = err.code && ERROR_CODE_I18N_KEY[err.code];
  // (C1203) {detail} only matters for voice.errUpstream — t()'s interpolate() no-ops an unused
  // {placeholder}, so passing it on every mapped key needs no per-key branching.
  return key ? t(key, { detail: err.message || '' }) : t('voice.transcribeFailed', { msg: err.message || '' });
}
