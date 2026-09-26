// (C1178) Pure mapping from voice-model-manager.js status/progress payloads to Settings
// modal UI state. No DOM, no imports — mirrors dep-graph.js so this stays unit-testable
// under `node --test` without a browser.

// GET /api/voice-models model entries carry `state`: missing | partial | downloading |
// ready | stale (see voice-model-manager.js's computeDiskState/getVoiceModelStatus).
// This folds that straight into a badge key + a percent (only meaningful while
// downloading — null otherwise, since disk-state polling doesn't carry live progress).
export function voiceModelBadge(status) {
  const state = (status && status.state) || 'missing';
  if (state === 'ready') return { key: 'ready', percent: 100 };
  if (state === 'downloading') return { key: 'downloading', percent: null };
  if (state === 'partial') return { key: 'partial', percent: null };
  if (state === 'stale') return { key: 'stale', percent: null };
  return { key: 'missing', percent: null };
}

// Overlays a live `voice-model:progress` WS payload (`{percent, ...}`) on top of a
// previously-computed badge. A progress event always means "downloading now", regardless
// of what the last GET /api/voice-models poll said (it can only be stale by comparison).
export function applyVoiceModelProgress(badge, progress) {
  if (!progress || typeof progress.percent !== 'number') return badge;
  return { key: 'downloading', percent: progress.percent };
}

// (C1197) `state` string -> the settings.voiceModelState* i18n key. Shared by task-board.js's
// Settings-modal row label (its own `_VOICE_STATE_LABEL_KEY` copy) and voice-errors.js's
// MODEL_NOT_DOWNLOADED toast, which localizes `{state}` instead of interpolating the raw enum.
const _STATE_LABEL_KEY = {
  ready: 'settings.voiceModelStateReady',
  downloading: 'settings.voiceModelStateDownloading',
  partial: 'settings.voiceModelStatePartial',
  stale: 'settings.voiceModelStateStale',
  missing: 'settings.voiceModelStateMissing',
};
export function voiceModelStateLabelKey(state) {
  return _STATE_LABEL_KEY[state] || _STATE_LABEL_KEY.missing;
}

// Which action (if any) a model row's button should offer, given its badge key and whether
// the row is the currently-checked radio (the active engine). (C1198) The radio itself is
// what starts/resumes a download (see _maybeStartVoiceModelDownload in task-board.js) — a
// row's button never offers Download/Resume/Update any more:
//   - 'downloading' always offers abort, active row or not.
//   - the active (selected) row offers nothing else: missing/partial/stale auto-download on
//     selection, and a ready active row is the in-use engine, never deletable.
//   - an inactive row with anything on disk (ready/partial/stale) offers delete, to free
//     space; an inactive 'missing' row offers nothing (there's nothing to delete).
export function voiceModelAction(badgeKey, selected = false) {
  if (badgeKey === 'downloading') return 'abort';
  if (selected) return null;
  return badgeKey === 'missing' ? null : 'delete';
}

// Does *enabling* this row (selecting its radio, or re-opening the modal while it's already
// the active engine) need a download kicked off? Split out of voiceModelAction() because the
// button itself no longer offers Download — the radio (and modal-open auto-resume) do.
export function voiceModelNeedsDownload(badgeKey) {
  return badgeKey === 'missing' || badgeKey === 'partial' || badgeKey === 'stale';
}

// (C1199) Can voice input actually transcribe right now? Only the local engine can be
// "not ready" — AssemblyAI needs nothing on disk, so it's always ready. `models` is a
// GET /api/voice-models list (or the cached copy); an unfetched/empty list -> false, since
// this fn has no notion of "haven't checked yet" — callers fail-open by not calling it
// until they have a real list (see setVoiceInputAvailability, audio-recorder.js).
export function isVoiceInputReady(voicePreset, models, selectedModelId) {
  if (voicePreset !== 'local') return true;
  const status = (models || []).find(m => m && m.modelId === selectedModelId);
  return !!status && status.state === 'ready';
}
