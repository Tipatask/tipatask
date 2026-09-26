import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  DEFAULT_VOICE_SHORTCUT, VOICE_SHORTCUT_OPTIONS,
  normalizeVoiceShortcut, matchesVoiceShortcut, voiceShortcutLabel, voiceShortcutAccelerator,
} = await import('./voice-shortcut.js');

test('default combo matches a synthetic matching event', () => {
  const e = { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, code: 'KeyD' };
  assert.equal(matchesVoiceShortcut(e, DEFAULT_VOICE_SHORTCUT), true);
});

test('ctrlKey alone (non-mac) also matches', () => {
  const e = { metaKey: false, ctrlKey: true, shiftKey: true, altKey: false, code: 'KeyD' };
  assert.equal(matchesVoiceShortcut(e, DEFAULT_VOICE_SHORTCUT), true);
});

test('missing shift does not match', () => {
  const e = { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, code: 'KeyD' };
  assert.equal(matchesVoiceShortcut(e, DEFAULT_VOICE_SHORTCUT), false);
});

test('altKey set does not match (AltGr layouts must never misfire)', () => {
  const e = { metaKey: true, ctrlKey: false, shiftKey: true, altKey: true, code: 'KeyD' };
  assert.equal(matchesVoiceShortcut(e, DEFAULT_VOICE_SHORTCUT), false);
});

test('wrong code does not match even with correct modifiers', () => {
  const e = { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, code: 'Space' };
  assert.equal(matchesVoiceShortcut(e, DEFAULT_VOICE_SHORTCUT), false);
});

test('null/undefined event never matches', () => {
  assert.equal(matchesVoiceShortcut(null, DEFAULT_VOICE_SHORTCUT), false);
  assert.equal(matchesVoiceShortcut(undefined, DEFAULT_VOICE_SHORTCUT), false);
});

// (C1210) The root cause this module exists to fix: `e.key` differs across keyboard layouts for
// the SAME physical key (the test machine that surfaced C1210 has Ukrainian-PC, U.S., and
// RussianWin layouts installed) while `e.code` does not — matching must stay on `code`.
test('matching is layout-independent — e.key differing across layouts must not affect the result', () => {
  const usLayout = { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, code: 'KeyD', key: 'D' };
  const ukLayout = { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, code: 'KeyD', key: 'І' };
  assert.equal(matchesVoiceShortcut(usLayout, DEFAULT_VOICE_SHORTCUT), true);
  assert.equal(matchesVoiceShortcut(ukLayout, DEFAULT_VOICE_SHORTCUT), true);
});

test('a non-default configured combo only matches its own code', () => {
  const combo = VOICE_SHORTCUT_OPTIONS.find(o => o.code === 'KeyK');
  const matchesK = { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, code: 'KeyK' };
  const matchesD = { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, code: 'KeyD' };
  assert.equal(matchesVoiceShortcut(matchesK, combo), true);
  assert.equal(matchesVoiceShortcut(matchesD, combo), false);
});

test('label rendering: mac uses the symbol glyphs, non-mac spells out Ctrl+Shift', () => {
  assert.equal(voiceShortcutLabel(DEFAULT_VOICE_SHORTCUT, true), '⇧⌘D');
  assert.equal(voiceShortcutLabel(DEFAULT_VOICE_SHORTCUT, false), 'Ctrl+Shift+D');
});

test('accelerator string form for the Electron menu item', () => {
  assert.equal(voiceShortcutAccelerator(DEFAULT_VOICE_SHORTCUT), 'CmdOrCtrl+Shift+D');
  const combo = VOICE_SHORTCUT_OPTIONS.find(o => o.code === 'KeyK');
  assert.equal(voiceShortcutAccelerator(combo), 'CmdOrCtrl+Shift+K');
});

test('normalizeVoiceShortcut falls back to the default on missing/malformed input', () => {
  assert.deepEqual(normalizeVoiceShortcut(null), DEFAULT_VOICE_SHORTCUT);
  assert.deepEqual(normalizeVoiceShortcut(undefined), DEFAULT_VOICE_SHORTCUT);
  assert.deepEqual(normalizeVoiceShortcut({}), DEFAULT_VOICE_SHORTCUT);
  assert.deepEqual(normalizeVoiceShortcut({ code: '' }), DEFAULT_VOICE_SHORTCUT);
  assert.deepEqual(normalizeVoiceShortcut({ label: 'D' }), DEFAULT_VOICE_SHORTCUT); // code missing
});

test('normalizeVoiceShortcut passes through a valid stored combo untouched', () => {
  const combo = { code: 'KeyJ', label: 'J' };
  assert.deepEqual(normalizeVoiceShortcut(combo), combo);
});

// The offered set must never include Space (the whole reason this module exists — claimed by
// macOS input-source switching on any multi-layout machine) nor this app's own existing
// accelerators (Cmd+Q, Cmd+Shift+O/N/W, Cmd+,) nor Cmd+Shift+V (collides with "Paste as plain
// text" in the objective textarea, C1174).
test('curated options never re-offer Space or a known-conflicting combo', () => {
  const codes = VOICE_SHORTCUT_OPTIONS.map(o => o.code);
  assert.equal(codes.includes('Space'), false);
  for (const conflict of ['KeyQ', 'KeyO', 'KeyN', 'KeyW', 'Comma', 'KeyV']) {
    assert.equal(codes.includes(conflict), false, `${conflict} should not be offered`);
  }
});

test('every curated option round-trips through normalize/match/label/accelerator', () => {
  for (const combo of VOICE_SHORTCUT_OPTIONS) {
    assert.deepEqual(normalizeVoiceShortcut(combo), combo);
    const e = { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, code: combo.code };
    assert.equal(matchesVoiceShortcut(e, combo), true);
    assert.equal(voiceShortcutLabel(combo, false), `Ctrl+Shift+${combo.label}`);
    assert.equal(voiceShortcutAccelerator(combo), `CmdOrCtrl+Shift+${combo.label}`);
  }
});
