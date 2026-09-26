// (C1210) Pure combo parse/match/label logic for the global voice-input shortcut — DOM-free,
// same pattern as voice-silence.js/voice-report.js/voice-model-state.js, so it's unit-testable
// under `node --test` with no browser. audio-recorder.js (DOM-heavy) and main.js (Electron
// accelerator string) both consume this.
//
// Root cause this module exists to fix: Cmd/Ctrl+Shift+SPACE — the shortcut since C1174/C1206 —
// is claimed by macOS itself on any machine with >1 keyboard input source (input-source
// switching defaults to Cmd+Space; this project's own test machine has it remapped to
// Cmd+Shift+Space specifically). The OS never delivers the key to ANY app in that case — proven
// by dispatching a synthetic matching KeyboardEvent straight at document, which fires the C1206
// handler fine, so the renderer-side code was never the bug. No in-app rebind can rescue a key
// the OS swallows before delivery; the combo itself has to move, and be user-configurable so a
// future OS remap is self-service instead of another multi-hour investigation.
//
// `code`/`key` fields below are DOM KeyboardEvent field names (e.code/e.key), not free-form —
// kept flat + JSON-serializable so a combo round-trips straight through .tipatask/config.json.
export const DEFAULT_VOICE_SHORTCUT = { code: 'KeyD', label: 'D' };

// Curated safe set offered by the Settings > Voice picker — deliberately excludes:
// - Space (the whole reason this module exists — claimed by macOS input-source switching)
// - Q/O/W/, (this app's own existing accelerators: Cmd+Q, Cmd+Shift+O/W, Cmd+,)
// - V (Cmd+Shift+V collides with "Paste as plain text" the objective textarea relies on, C1174)
export const VOICE_SHORTCUT_OPTIONS = [
  { code: 'KeyD', label: 'D' },
  { code: 'KeyK', label: 'K' },
  { code: 'KeyJ', label: 'J' },
  { code: 'KeyM', label: 'M' },
];

// Accepts a stored/candidate combo (e.g. from .tipatask/config.json, possibly missing, stale,
// or hand-edited) and returns a valid combo — falls back to the default rather than ever leaving
// voice input silently unreachable.
export function normalizeVoiceShortcut(combo) {
  return (combo && typeof combo.code === 'string' && combo.code) ? combo : DEFAULT_VOICE_SHORTCUT;
}

// Global keydown predicate for the voice-input shortcut. Alt excluded so OS-level alt-combos
// (e.g. AltGr layouts producing space) never misfire this. Matches `e.code` (physical key),
// never `e.key` — `e.key` differs across the Ukrainian-PC/U.S./RussianWin layouts a machine can
// have installed for the SAME physical key, `e.code` does not.
export function matchesVoiceShortcut(e, combo = DEFAULT_VOICE_SHORTCUT) {
  return !!e && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === combo.code;
}

// Cmd (mac) or Ctrl (everything else) + Shift + <configured key>.
export function voiceShortcutLabel(combo = DEFAULT_VOICE_SHORTCUT, isMac = false) {
  const key = combo.label || DEFAULT_VOICE_SHORTCUT.label;
  return isMac ? `⇧⌘${key}` : `Ctrl+Shift+${key}`;
}

// Electron `accelerator` string for the same combo (main.js menu item) — 'CmdOrCtrl' resolves to
// Cmd on mac / Ctrl elsewhere, matching matchesVoiceShortcut()'s metaKey-or-ctrlKey predicate.
// Only valid for the single-letter KeyX-style codes VOICE_SHORTCUT_OPTIONS offers.
export function voiceShortcutAccelerator(combo = DEFAULT_VOICE_SHORTCUT) {
  const key = combo.label || DEFAULT_VOICE_SHORTCUT.label;
  return `CmdOrCtrl+Shift+${key}`;
}
