import assert from 'node:assert/strict';
import { test } from 'node:test';

const { DEFAULT_VOICE_MODE, VOICE_MODE_OPTIONS, normalizeVoiceMode, voiceModeOption } = await import('./voice-mode.js');
const { LOCALES } = await import('./i18n.js');

test('standard is the default and the first option', () => {
  assert.equal(DEFAULT_VOICE_MODE, 'standard');
  assert.deepEqual(VOICE_MODE_OPTIONS.map(opt => opt.value), ['standard', 'thankyou']);
});

test('the two real modes normalize to themselves', () => {
  assert.equal(normalizeVoiceMode('standard'), 'standard');
  assert.equal(normalizeVoiceMode('thankyou'), 'thankyou');
});

// A hand-edited or stale .tipatask/config.json must never leave the recorder in an unknown mode.
test('a missing or unknown value counts as standard', () => {
  for (const value of [undefined, null, '', 'ThankYou', 'thank-you', ' thankyou', 'live', 0, true, {}, ['thankyou']]) {
    assert.equal(normalizeVoiceMode(value), 'standard', JSON.stringify(value));
  }
});

test('voiceModeOption always returns a real option, falling back to standard', () => {
  assert.equal(voiceModeOption('thankyou').value, 'thankyou');
  assert.equal(voiceModeOption('bogus'), VOICE_MODE_OPTIONS[0]);
  assert.equal(voiceModeOption(undefined).hintKey, 'settings.voiceModeStandardHint');
});

test('every mode label and hint is translated in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    for (const key of ['settings.voiceMode', ...VOICE_MODE_OPTIONS.flatMap(opt => [opt.labelKey, opt.hintKey])]) {
      assert.ok(typeof table[key] === 'string' && table[key].trim(), `${locale}.${key}`);
    }
    assert.ok(table['settings.voiceModeSaveFailed']?.includes('{msg}'), `${locale}.settings.voiceModeSaveFailed keeps {msg}`);
  }
});
