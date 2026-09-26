'use strict';

// (C1202) Gate + dedupe wrapper around local-asr.js#warmLocalAsr(). Kept as its own module,
// separate from local-asr.js, so this file can be `require()`d — and unit-tested — WITHOUT
// dragging in sherpa-onnx-node: every real dependency is injected via `deps`, defaulting to
// lazy `require()`s that only resolve when this actually runs against the `local` preset. See
// tt-audio-input.md § Local Voice Models (C1202) for the three call sites (server boot,
// voice-settings save, voice-model download completion).

const realDeps = {
  get readVoiceSettings() { return require('./project-config').readVoiceSettings; },
  get getVoiceModelStatus() { return require('./voice-model-manager').getVoiceModelStatus; },
  get warmLocalAsr() { return require('./local-asr').warmLocalAsr; },
};

// modelId -> true while a warm is in flight, so a burst of triggers (boot + a stray
// voice-model:complete arriving in the same tick) only ever warms once concurrently. Cleared
// in `finally` regardless of outcome — a failed warm must be retriable by the NEXT trigger,
// matching ensureRecognizer()'s own evict-on-failure behavior (this is not a "never retry"
// cache, just an in-flight guard).
const _warming = new Set();

// `projectRoot`: project whose config decides preset/model. `opts.modelId`: if given, only
// warms when it matches the project's configured `voiceLocalModel` — lets a voice-model
// download-complete hook fire for every download without warming a model the project isn't
// even using. `opts.reason`: free-form string for the log line only.
async function prewarmVoice(projectRoot, opts = {}, deps = realDeps) {
  if (process.env.TIPATASK_VOICE_PREWARM === '0') return false;
  const { modelId: onlyIfModelId = null, reason = 'unspecified' } = opts;
  let settings;
  try {
    settings = deps.readVoiceSettings(projectRoot);
  } catch (err) {
    console.warn('[voice-prewarm] readVoiceSettings failed:', err.message);
    return false;
  }
  if (!settings || settings.voicePreset !== 'local' || !settings.voiceLocalModel) return false;
  const modelId = settings.voiceLocalModel;
  if (onlyIfModelId && onlyIfModelId !== modelId) return false;

  // (C1202) Claim the guard HERE, synchronously, before the first `await` below — not after
  // getVoiceModelStatus() resolves. `readVoiceSettings` is sync (mirrors every other caller in
  // this codebase, e.g. session.js), so everything up to this line runs in one microtask with
  // no yield point. Claiming any later would let two concurrent triggers (boot + a stray
  // voice-model:complete in the same tick) both pass the `has()` check before either reaches
  // `.add()`, each ends up warming independently — which a prior version of this file did.
  if (_warming.has(modelId)) return false;
  _warming.add(modelId);
  try {
    let status;
    try {
      status = await deps.getVoiceModelStatus(modelId);
    } catch (err) {
      console.warn(`[voice-prewarm] getVoiceModelStatus("${modelId}") failed:`, err.message);
      return false;
    }
    // Never triggers a download — only warms a model that's already fully on disk.
    if (!status || status.state !== 'ready') return false;
    try {
      return await deps.warmLocalAsr(modelId);
    } catch (err) {
      // Defense in depth — local-asr.js#warmLocalAsr already catches its own errors and
      // resolves false, but every call site here (.catch(() => {})) is written assuming this
      // function itself never rejects either; don't rely solely on the injected dep behaving.
      console.warn(`[voice-prewarm] warmLocalAsr("${modelId}") threw:`, err.message);
      return false;
    }
  } finally {
    // Cleared regardless of outcome — a failed warm must be retriable by the NEXT trigger,
    // matching ensureRecognizer()'s own evict-on-failure behavior (this is an in-flight guard,
    // not a "never retry" cache).
    _warming.delete(modelId);
  }
}

module.exports = { prewarmVoice };
