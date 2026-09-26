import assert from 'node:assert/strict';
import { test } from 'node:test';

const { voiceModelBadge, applyVoiceModelProgress, voiceModelAction, voiceModelNeedsDownload, voiceModelStateLabelKey, isVoiceInputReady } = await import('./voice-model-state.js');

// ── voiceModelBadge ──

test('voiceModelBadge maps each disk state to a badge key', () => {
  assert.deepEqual(voiceModelBadge({ state: 'ready' }), { key: 'ready', percent: 100 });
  assert.deepEqual(voiceModelBadge({ state: 'downloading' }), { key: 'downloading', percent: null });
  assert.deepEqual(voiceModelBadge({ state: 'partial' }), { key: 'partial', percent: null });
  assert.deepEqual(voiceModelBadge({ state: 'stale' }), { key: 'stale', percent: null });
  assert.deepEqual(voiceModelBadge({ state: 'missing' }), { key: 'missing', percent: null });
});

test('voiceModelBadge falls back to missing for an unknown/absent status', () => {
  assert.deepEqual(voiceModelBadge(null), { key: 'missing', percent: null });
  assert.deepEqual(voiceModelBadge({}), { key: 'missing', percent: null });
  assert.deepEqual(voiceModelBadge({ state: 'bogus' }), { key: 'missing', percent: null });
});

// ── applyVoiceModelProgress ──

test('applyVoiceModelProgress overlays a live percent as downloading', () => {
  const badge = voiceModelBadge({ state: 'partial' });
  assert.deepEqual(applyVoiceModelProgress(badge, { percent: 42 }), { key: 'downloading', percent: 42 });
});

test('applyVoiceModelProgress leaves the badge untouched without a numeric percent', () => {
  const badge = voiceModelBadge({ state: 'ready' });
  assert.deepEqual(applyVoiceModelProgress(badge, null), badge);
  assert.deepEqual(applyVoiceModelProgress(badge, {}), badge);
  assert.deepEqual(applyVoiceModelProgress(badge, { percent: '50' }), badge);
});

// ── voiceModelAction (C1198) ──

test('voiceModelAction: downloading always offers abort, selected or not', () => {
  assert.equal(voiceModelAction('downloading', false), 'abort');
  assert.equal(voiceModelAction('downloading', true), 'abort');
});

test('voiceModelAction: the active (selected) row never offers a button of its own besides abort', () => {
  assert.equal(voiceModelAction('ready', true), null);
  assert.equal(voiceModelAction('missing', true), null);
  assert.equal(voiceModelAction('partial', true), null);
  assert.equal(voiceModelAction('stale', true), null);
});

test('voiceModelAction: an inactive row offers delete once something is on disk, else nothing', () => {
  assert.equal(voiceModelAction('ready', false), 'delete');
  assert.equal(voiceModelAction('partial', false), 'delete');
  assert.equal(voiceModelAction('stale', false), 'delete');
  assert.equal(voiceModelAction('missing', false), null);
});

test('voiceModelAction defaults selected to false', () => {
  assert.equal(voiceModelAction('ready'), 'delete');
});

// ── voiceModelAction: engine-switch transition (C1205) ──
// _wireVoiceAssemblyaiRow() re-renders the merged list with preset:'assemblyai' right
// after writing config — no fetch, no cache mutation, just a re-render from the SAME
// cached model list against a flipped `selected` flag. These assert that transition is
// enough on its own: badge state is untouched by the switch, only `selected` flips.
test('voiceModelAction: engine switch local->assemblyai flips a with-disk-content row from none to delete', () => {
  for (const key of ['ready', 'partial', 'stale']) {
    assert.equal(voiceModelAction(key, true), null, `${key} while still active`);
    assert.equal(voiceModelAction(key, false), 'delete', `${key} after switch away`);
  }
});

test('voiceModelAction: engine switch does not touch a downloading row\'s abort offer', () => {
  assert.equal(voiceModelAction('downloading', true), 'abort');
  assert.equal(voiceModelAction('downloading', false), 'abort');
});

test('voiceModelAction: engine switch leaves a missing row with nothing to delete', () => {
  assert.equal(voiceModelAction('missing', true), null);
  assert.equal(voiceModelAction('missing', false), null);
});

// ── voiceModelNeedsDownload (C1198) ──

test('voiceModelNeedsDownload is true for missing/partial/stale, false for ready/downloading', () => {
  assert.equal(voiceModelNeedsDownload('missing'), true);
  assert.equal(voiceModelNeedsDownload('partial'), true);
  assert.equal(voiceModelNeedsDownload('stale'), true);
  assert.equal(voiceModelNeedsDownload('ready'), false);
  assert.equal(voiceModelNeedsDownload('downloading'), false);
});

// ── voiceModelStateLabelKey (C1197, previously untested) ──

test('voiceModelStateLabelKey maps every known state to its i18n key, unknown falls back to missing', () => {
  assert.equal(voiceModelStateLabelKey('ready'), 'settings.voiceModelStateReady');
  assert.equal(voiceModelStateLabelKey('downloading'), 'settings.voiceModelStateDownloading');
  assert.equal(voiceModelStateLabelKey('partial'), 'settings.voiceModelStatePartial');
  assert.equal(voiceModelStateLabelKey('stale'), 'settings.voiceModelStateStale');
  assert.equal(voiceModelStateLabelKey('missing'), 'settings.voiceModelStateMissing');
  assert.equal(voiceModelStateLabelKey('bogus'), 'settings.voiceModelStateMissing');
  assert.equal(voiceModelStateLabelKey(undefined), 'settings.voiceModelStateMissing');
});

// ── isVoiceInputReady (C1199) ──

test('isVoiceInputReady: assemblyai preset is always ready, even with no models fetched', () => {
  assert.equal(isVoiceInputReady('assemblyai', [], null), true);
  assert.equal(isVoiceInputReady('assemblyai', null, 'parakeet-v3'), true);
});

test('isVoiceInputReady: local preset is ready only when the selected model state is ready', () => {
  const models = [{ modelId: 'parakeet-v3', state: 'ready' }, { modelId: 'parakeet-v2', state: 'missing' }];
  assert.equal(isVoiceInputReady('local', models, 'parakeet-v3'), true);
  for (const state of ['missing', 'partial', 'downloading', 'stale']) {
    assert.equal(isVoiceInputReady('local', [{ modelId: 'parakeet-v2', state }], 'parakeet-v2'), false, state);
  }
});

test('isVoiceInputReady: local preset is not ready when the selected model is absent from the list, or the list is empty/unfetched', () => {
  assert.equal(isVoiceInputReady('local', [{ modelId: 'whisper-base', state: 'ready' }], 'parakeet-v3'), false);
  assert.equal(isVoiceInputReady('local', [], 'parakeet-v3'), false);
  assert.equal(isVoiceInputReady('local', null, 'parakeet-v3'), false);
  assert.equal(isVoiceInputReady('local', undefined, 'parakeet-v3'), false);
});
