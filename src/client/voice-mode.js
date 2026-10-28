// (TPT9156) Pure voice-mode values — DOM-free like voice-shortcut.js, so they're unit-testable
// under `node --test` with no browser. Settings > Voice > Mode stores the choice as `voiceMode`
// in .tipatask/config.json (local-only, like voiceShortcut); task-board.js reads it back through
// normalizeVoiceMode() and fans it out to audio-recorder.js's setVoiceMode().
//   'standard' — text streams into the field while you speak (the original behavior).
//   'thankyou' — recording runs until the stop phrase, then the whole recording is transcribed
//                and cleaned up once.
export const DEFAULT_VOICE_MODE = 'standard';

// The Settings radios in display order, with their label and hint keys (i18n.js).
export const VOICE_MODE_OPTIONS = [
  { value: 'standard', labelKey: 'settings.voiceModeStandard', hintKey: 'settings.voiceModeStandardHint' },
  { value: 'thankyou', labelKey: 'settings.voiceModeThankYou', hintKey: 'settings.voiceModeThankYouHint' },
];

// A missing, stale or hand-edited value counts as 'standard' — the mode is never unknown.
export function normalizeVoiceMode(mode) {
  return VOICE_MODE_OPTIONS.some(opt => opt.value === mode) ? mode : DEFAULT_VOICE_MODE;
}

// The VOICE_MODE_OPTIONS entry for `mode` after normalization, so always a real option.
export function voiceModeOption(mode) {
  const value = normalizeVoiceMode(mode);
  return VOICE_MODE_OPTIONS.find(opt => opt.value === value);
}
