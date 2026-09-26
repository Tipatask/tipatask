'use strict';

// (C1185) Local on-device streaming provider — feeds PCM into local-asr.js's Silero VAD +
// offline recognizer. Parakeet exposes replaceable context hypotheses as voice:partial and
// committed sentences as voice:final; Whisper finalizes each VAD segment.
//
// require('../local-asr') is done lazily inside start(), not at module load, so a project on
// the AssemblyAI preset never touches sherpa-onnx-node at all.

function int16BufferToFloat32(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length % 2 !== 0) {
    throw new RangeError('Expected non-empty PCM16LE audio with an even byte count');
  }
  const sampleCount = buf.length / 2;
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return out;
}

// (C1202) local-asr.js hardcodes 16000 unconditionally — it never reads ctx.sampleRate at all,
// so a mismatched client would be silently mis-decoded (wrong-duration audio fed to VAD/the
// recognizer) with no error anywhere. Kept as its own constant, not imported from local-asr.js,
// so this file's tests never need to load that module (and therefore never touch sherpa) just
// to exercise the mismatch check.
const EXPECTED_SAMPLE_RATE = 16000;

// (C1202) Single-pass peak/RMS accumulator over a recording's PCM, folded into pushAudio()'s
// existing int16->float32 conversion (already O(n), so this is free). Exported for direct unit
// testing. `acc` is mutated in place and returned so callers can chain without allocating a new
// object per frame. This is THE signal that distinguishes "no audio ever reached the local ASR
// pipeline" (peak stays ~0 — mic entitlement/device/permission problem) from "audio arrived but
// VAD/the model found nothing" (peak is healthy, segments/emptySegments tell the rest) — a
// distinction nothing in this pipeline could make before this, see local-asr.js's `stats` and
// tt-audio-input.md § Voice Input False Negatives (C1202).
function accumulatePcmStats(acc, float32) {
  acc.frames += 1;
  acc.samples += float32.length;
  for (let i = 0; i < float32.length; i++) {
    const abs = Math.abs(float32[i]);
    if (abs > acc.peak) acc.peak = abs;
    acc.sumSquares += float32[i] * float32[i];
  }
  return acc;
}

// (C1200) `deps` is an optional test seam — same idiom as session.js's own 3rd-arg `deps`
// (handleVoiceConnection). Production callers (voice-stream/index.js) never pass it, so
// `require('../local-asr')` (and thus sherpa-onnx-node) stays untouched by default; tests can
// inject a fake { LocalAsrSession, LocalAsrUnavailableError } to exercise start()/pushAudio()/
// stop() without the real native addon.
// (C1202) How long init() may run before we tell the client "still loading" — see the
// `onLoading` wiring in start() below. Long enough that the common warm case (recognizer
// already cached from a prior recording, only the per-session ~150ms `new Vad(...)` left) never
// flashes it; short enough that a cold ~650MB parakeet-v3 build (which can take several
// seconds) is flagged well before a client's drain timeout would give up.
const LOADING_HINT_MS = 250;

function createLocalProvider(ctx, deps = null) {
  let session = null;
  let stopped = false;
  let onFinal = null;
  let onPartial = null;
  let lastPartial = null;
  let onDone = null;
  let onError = null;
  let errorReported = false;
  let loadingTimer = null;
  let initialized = false;
  let startupCanceled = false;
  // (C1202) Session-lifetime breadcrumbs, folded into the existing console.warn breadcrumbs and
  // also handed back on `onDone` so the CLIENT can see them — the server's own stdout is
  // frequently unreachable in a packaged, Finder-launched build (no terminal attached to the
  // fork), which is exactly why these numbers needed to travel over the wire, not just to
  // console.warn. See tt-audio-input.md § Voice Input False Negatives (C1202).
  const pcmStats = { frames: 0, samples: 0, bytes: 0, peak: 0, sumSquares: 0 };
  let initStartedAt = 0;
  let initMs = null;
  // (C1200) The promise from session.init() — NOT just awaited inline in start(). pushAudio()
  // below chains onto this so PCM frames that arrive while the recognizer is still loading WAIT
  // for init instead of racing it. Root cause this fixes: start() used to assign `session`
  // synchronously (before awaiting init()), and session.js routes every binary WS frame straight
  // to pushAudio() as soon as `provider` is non-null — the client starts streaming PCM on WS
  // `open`, without waiting for voice:ready. So a frame arriving mid-init used to pass this
  // function's `if (!session) return` guard (session was already non-null) and call
  // session.acceptWaveform(samples) -> `this.buffer.push(...)` while `this.buffer` was still null
  // (only set inside init()) -> TypeError, caught below, reported as a voice:error the client
  // silently discarded (audio-recorder.js's onError: () => {}). Cold process + parakeet-v3's
  // 652MB int8 encoder ORT session -> init can take seconds -> a short recording could be dropped
  // ENTIRELY. See tt-audio-input.md § Voice Input Silent Failures (C1200).
  let ready = null;
  // (C1186) local-asr.js's acceptWaveform()/flush() are now async (decodeAsync, so decode work
  // doesn't block the event loop that also owns every PTY/WS). pushAudio()/stop() must stay
  // synchronous, fire-and-forget void functions per the provider interface (session.js calls
  // both without awaiting) — this promise chain serializes the underlying async calls so two
  // WS 'data' frames arriving faster than one decode completes never call acceptWaveform()
  // concurrently on the same session (its VAD/buffer state is not reentrant), and so stop()'s
  // flush() only runs after every already-queued chunk has been decoded.
  let queue = Promise.resolve();

  // (C1200) Report at most once per session — without this, a `ready` rejection would fire
  // onError once per already-queued frame (every frame chained on `ready` re-rejects through the
  // same catch), which would look like a burst of spurious errors for a single real failure.
  function reportDecodeError(err) {
    console.warn('[voice-stream] local decode error:', err.message);
    if (errorReported || stopped) return;
    errorReported = true;
    if (onError) onError(`Local transcription decode failed: ${err.message}`);
  }

  async function start(callbacks) {
    if (stopped) return;
    onFinal = callbacks.onFinal;
    onPartial = callbacks.onPartial;
    onDone = callbacks.onDone;
    onError = callbacks.onError;
    if (!ctx.modelId) {
      callbacks.onUnsupported('No local model selected for this project');
      return;
    }
    // (C1202) Reject loudly instead of local-asr.js silently decoding at the wrong assumed
    // rate — see EXPECTED_SAMPLE_RATE's comment above. `ctx.sampleRate` is only present when
    // the client sent one (session.js passes it through from the voice:start frame); a missing
    // value is treated as "trust it", matching local-asr.js's own unconditional-16000 behavior
    // for callers (tests, old clients) that never declared a rate at all.
    if (ctx.sampleRate && ctx.sampleRate !== EXPECTED_SAMPLE_RATE) {
      callbacks.onUnsupported(
        `microphone sample rate ${ctx.sampleRate}Hz is not supported (expected ${EXPECTED_SAMPLE_RATE}Hz)`,
        { reasonCode: 'SAMPLE_RATE_MISMATCH', detail: { rate: ctx.sampleRate, expected: EXPECTED_SAMPLE_RATE } },
      );
      return;
    }
    const { LocalAsrSession, LocalAsrUnavailableError } = deps || require('../local-asr');
    // `ctx.endpointing` comes from the provider registry (index.js#resolveVoicePreset); a ctx
    // without one (tests, old callers) leaves LocalAsrSession on its own defaults.
    session = new LocalAsrSession({ modelId: ctx.modelId, endpointing: ctx.endpointing || null });
    initStartedAt = Date.now();
    ready = session.init();
    // (C1202) Only fires if init() is still running after LOADING_HINT_MS — cleared in the
    // `finally` below the instant init() settles either way, so a fast/warm init never emits it.
    if (callbacks.onLoading) {
      loadingTimer = setTimeout(() => callbacks.onLoading({ modelId: ctx.modelId }), LOADING_HINT_MS);
    }
    try {
      await ready;
    } catch (err) {
      session?.dispose?.();
      session = null;
      if (stopped) return;
      if (err instanceof LocalAsrUnavailableError) {
        callbacks.onUnsupported(err.reason, { reasonCode: err.reasonCode || null, detail: err.detail || null });
      } else {
        callbacks.onError(`Local transcription failed to start: ${err.message}`);
      }
      return;
    } finally {
      if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
      initMs = Date.now() - initStartedAt;
    }
    initialized = true;
    if (stopped) return;
    callbacks.onReady();
  }

  function pushAudio(buf) {
    if (!session || stopped) return;
    let samples;
    try { samples = int16BufferToFloat32(buf); }
    catch (err) { reportDecodeError(err); return; }
    pcmStats.bytes += buf.length;
    accumulatePcmStats(pcmStats, samples);
    // (C1200) wait for `ready` before decoding — see the comment on `ready` above. `session` may
    // have been reset to null by a since-failed init(); re-check inside the chain, not just at
    // entry, since this closure captures `samples`/the outer `session` var by reference.
    queue = queue
      .then(() => ready)
      .then(() => (session && !startupCanceled ? session.acceptWaveform(samples) : []))
      .then(emitFinalResults)
      .catch(reportDecodeError);
  }

  function emitFinalResults(results) {
    if (startupCanceled) return;
    // Formatting belongs to the session: never add a period to a context-cap commit.
    for (const { text } of results) { onFinal(text); lastPartial = null; }
    const partial = session?.partial?.text || null;
    if (partial && partial !== lastPartial && onPartial) onPartial(partial);
    lastPartial = partial;
  }

  // (C1202) Builds the payload handed to onDone — the wire-level counterpart of the
  // console.warn breadcrumbs below. `segments`/`emptySegments` default to 0 when `session` is
  // null (start() never got that far) or `session.stats` isn't set yet (init() still pending —
  // see local-asr.js's LocalAsrSession constructor vs init()).
  function buildStats() {
    const { segments, emptySegments } = (session && session.stats) || { segments: 0, emptySegments: 0 };
    return {
      modelId: ctx.modelId || null,
      frames: pcmStats.frames,
      bytes: pcmStats.bytes,
      samples: pcmStats.samples,
      peak: pcmStats.peak,
      rms: pcmStats.samples > 0 ? Math.sqrt(pcmStats.sumSquares / pcmStats.samples) : 0,
      segments,
      emptySegments,
      initMs,
      // What the session actually ran with (post-resolveEndpointing), not what ctx asked for.
      endpointing: (session && session.endpointing) || ctx.endpointing || null,
    };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    const canceledDuringInit = !initialized;
    startupCanceled = canceledDuringInit;
    if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
    if (!session) { if (onDone) onDone(buildStats()); return; }
    queue = queue
      .then(() => ready)
      .then(() => (session && !canceledDuringInit ? session.flush() : []))
      .then((results) => {
        if (canceledDuringInit) return;
        emitFinalResults(results);
        // (C1200/C1202) breadcrumb for the two failure modes that look identical on the wire
        // (zero voice:final either way) — see local-asr.js's `stats` and
        // tt-audio-input.md § Voice Input False Negatives (C1202). Also now on `onDone`'s
        // stats payload, which reaches the client even when the server's own stdout doesn't
        // (a packaged, Finder-launched build has no attached terminal for its forked server).
        const { segments, emptySegments } = session?.stats || { segments: 0, emptySegments: 0 };
        if (segments === 0) {
          console.warn(`[voice-stream] no speech segments detected (model=${ctx.modelId}, peak=${pcmStats.peak.toFixed(4)})`);
        } else if (emptySegments === segments) {
          console.warn(`[voice-stream] ${segments} speech segment(s) decoded, all empty (model=${ctx.modelId}) — model is producing blanks`);
        }
      })
      .catch(reportDecodeError)
      .finally(() => {
        const stats = buildStats();
        // The process-wide recognizer cache stays shared; this recording's VAD/buffer state
        // must become collectible after initialization or its last queued decode finishes.
        session?.dispose?.();
        session = null;
        if (onDone) onDone(stats);
      });
  }

  return { start, pushAudio, stop };
}

module.exports = { createLocalProvider, int16BufferToFloat32, accumulatePcmStats };
