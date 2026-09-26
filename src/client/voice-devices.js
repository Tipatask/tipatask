// (C1204) Pure, DOM-free helpers for the Settings > Voice input-device picker. No imports
// (unlike voice-report.js, which pulls in `t` — the caller does interpolation here since the
// unnamed-device label needs a positional index computed alongside the filtering, not just a
// static key) so this stays trivially unit-testable, same idiom as pcm.js/dep-graph.js.

// Chromium (macOS/Windows) injects synthetic `audioinput` entries for 'default' and, on
// Windows, 'communications' — these mean "whatever the OS picks", exactly what our own ''
// sentinel already means. Surfacing them as extra rows would show 2+ options that all mean
// "system default". A device with no id/label/groupId at all is Chromium's pre-permission
// placeholder (seen when enumerateDevices() is called before any getUserMedia() grant on this
// origin) — same reasoning as MODEL_NOT_DOWNLOADED-style filtering, drop it rather than render
// a blank, unselectable row.
const SYNTHETIC_IDS = new Set(['default', 'communications']);

export function filterAudioInputs(devices) {
  return (devices || []).filter(d => d && d.kind === 'audioinput' && d.deviceId && !SYNTHETIC_IDS.has(d.deviceId));
}

// True once every real input device has a label — enumerateDevices() blanks every label until
// the origin holds a mic grant. A zero-device list is NOT "unlocked": nothing to prove the
// permission state either way, and treating it as unlocked would skip the one-shot unlock in
// _populateVoiceInputDeviceSelect() the first time a user with no mic yet plugs one in.
export function labelsUnlocked(inputs) {
  return inputs.length > 0 && inputs.every(d => !!d.label);
}

// Builds the <option> data for the device select: '' (system default) first, then one row per
// real input, then — only if the saved id no longer resolves to any listed device — one
// trailing synthetic "missing" row so a vanished/foreign-machine id doesn't silently collapse
// to looking like "System default" was actually chosen.
export function buildInputDeviceOptions(inputs, savedId, labels) {
  const { defaultLabel, unnamedLabel, missingLabel } = labels;
  const options = [{ value: '', label: defaultLabel, selected: !savedId }];
  let matched = !savedId;
  inputs.forEach((d, i) => {
    const isSelected = !!savedId && d.deviceId === savedId;
    if (isSelected) matched = true;
    options.push({ value: d.deviceId, label: d.label || unnamedLabel(i + 1), selected: isSelected, title: d.label || '' });
  });
  if (savedId && !matched) {
    options.push({ value: savedId, label: missingLabel, selected: true });
  }
  return options;
}

// getUserMedia() constraints for a chosen device — 'exact', not 'ideal': an unsatisfiable
// 'ideal' is silently downgraded to the browser's own default pick with no error, which would
// make an explicit device choice a no-op exactly like the bug this feature fixes.
export function audioConstraintsFor(deviceId) {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

// Whether a getUserMedia() rejection against an exact-device constraint should retry against
// the system default rather than surface as a hard failure. Only a real "can't reach this
// device" error qualifies — device unplugged (NotFoundError/OverconstrainedError, the latter
// also seen as the older ConstraintNotSatisfiedError name) or present-but-unopenable
// (NotReadableError, AbortError). Permission errors (NotAllowedError/SecurityError) must NOT
// retry: the retry would fail identically (the denial isn't about which device) and could
// double-prompt the user.
const NO_RETRY_ERROR_NAMES = new Set(['NotAllowedError', 'SecurityError']);
export function shouldRetryWithDefault(err) {
  return !!err && !NO_RETRY_ERROR_NAMES.has(err.name);
}
