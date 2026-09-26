'use strict';

// Local ASR decodes VAD-ended utterances with offline Parakeet/Whisper models;
// it does not emit word-by-word streaming output. Load sherpa lazily so addon
// failures do not prevent server startup; the voice path reports unsupported.
// Under Electron's V8 sandbox, every sherpa call returning a typed array must
// pass enableExternalBuffer=false. The default external ArrayBuffer is rejected.

const path = require('node:path');
const {
  voiceModelDir, getVoiceModelStatus, VOICE_MODEL_REGISTRY,
  vadModelDir, ensureVadModel,
} = require('./voice-model-manager');
const { DEFAULT_ENDPOINTING, resolveEndpointing } = require('./vad-endpointing');

// Fixed by the Silero v5 model itself (see sherpa-onnx's nodejs-addon-examples) — every
// Vad.acceptWaveform() call must be handed exactly this many samples.
const VAD_WINDOW_SIZE = 512;
const VAD_BUFFER_SECONDS = 60;
const SAMPLE_RATE = 16000;
// (C1202) Max samples pushed into the CircularBuffer per acceptWaveform() call — see that
// method's header comment. 1s slices stay far under the 60s ring regardless of caller.
const PUSH_SLICE_SAMPLES = SAMPLE_RATE;

// Sentence pauses are independent of VAD chunking. Timings are seconds; token durations
// must be present to distinguish silence
// from a slowly spoken word. This is a punctuation heuristic, not a grammar model.
const SENTENCE_PAUSE_SECONDS = 4;
const PARAKEET_CONTEXT_SECONDS = 40;
const CONTEXT_GAP_SAMPLES = Math.round(0.08 * SAMPLE_RATE);
const CLOSING_MARKS = /["'”’»\)\]\}]+$/u;
const END_PUNCTUATION = /[.!?…。！？,;:，；：]$/u;

// Shorten only silence between independently detected speech regions in the recognition
// copy. Keep every speech sample, leading/trailing audio, and long sentence pauses. Original
// sample positions remain authoritative for finalization and the bounded rolling buffer.
function compactSpeechGaps(samples, regions) {
  const cuts = [];
  let previousEnd = null;
  for (const { start, end } of regions) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > samples.length) return samples;
    const gap = previousEnd === null ? 0 : start - previousEnd;
    if (gap >= 0.25 * SAMPLE_RATE && gap < SENTENCE_PAUSE_SECONDS * SAMPLE_RATE) {
      cuts.push([previousEnd + CONTEXT_GAP_SAMPLES, start]);
    }
    previousEnd = Math.max(previousEnd ?? 0, end);
  }
  if (!cuts.length) return samples;
  const out = new Float32Array(samples.length - cuts.reduce((sum, [start, end]) => sum + end - start, 0));
  let source = 0, target = 0;
  for (const [start, end] of cuts) {
    out.set(samples.subarray(source, start), target);
    target += start - source;
    source = end;
  }
  out.set(samples.subarray(source), target);
  return out;
}

function finishSentence(text, { final = true, continuation = false } = {}) {
  if (!/[\p{L}\p{N}]/u.test(text)) return text;
  // Capitalize only the first letter, preserving acronyms and names elsewhere in the text.
  if (!continuation) text = text.replace(/^([^\p{L}\p{N}]*)(\p{L})/u, (_, prefix, letter) => prefix + letter.toUpperCase());
  if (!final) return text;
  const closing = text.match(CLOSING_MARKS)?.[0] || '';
  const body = closing ? text.slice(0, -closing.length) : text;
  return END_PUNCTUATION.test(body) ? text : `${body}.${closing}`;
}

// Restore missing punctuation on a FINAL Parakeet segment. Exact token/text alignment is
// required before using timing offsets: byte-fallback tokens or text normalization can make
// the strings disagree. In that case (or with missing/invalid timings), finish the segment
// without guessing internal boundaries. Never rewrite the transcript from token strings.
function punctuate(text, timing = {}, options = {}) {
  text = typeof text === 'string' ? text.trim() : '';
  if (!text) return '';
  const { tokens, timestamps, durations } = timing || {};
  if (!Array.isArray(tokens) || !tokens.length || !tokens.every((t) => typeof t === 'string') ||
      !Array.isArray(timestamps) || !Array.isArray(durations) ||
      timestamps.length !== tokens.length || durations.length !== tokens.length ||
      !timestamps.every((t, i) => Number.isFinite(t) && t >= 0 && (i === 0 || t >= timestamps[i - 1])) ||
      !durations.every((d, i) => Number.isFinite(d) && d >= 0 && Number.isFinite(timestamps[i] + d))) {
    return finishSentence(text, options);
  }

  const pieces = tokens.map((t) => t.replace(/▁/gu, ' '));
  const joined = pieces.join('');
  if (joined.trim() !== text) return finishSentence(text, options);
  let offset = -(joined.length - joined.trimStart().length);
  const spans = pieces.map((piece) => {
    const start = offset;
    offset += piece.length;
    return { start, end: offset };
  });
  const sentences = [];
  let sentenceStart = 0;
  let tokenIndex = 0;
  let previous = null;
  for (const word of text.matchAll(/\S+/gu)) {
    while (tokenIndex < spans.length && spans[tokenIndex].end <= word.index) tokenIndex++;
    const firstToken = tokenIndex;
    const end = word.index + word[0].length;
    while (tokenIndex + 1 < spans.length && spans[tokenIndex + 1].start < end) tokenIndex++;
    const startTime = timestamps[firstToken];
    if (previous && startTime - previous.endTime >= SENTENCE_PAUSE_SECONDS - 1e-6 &&
        // Respect punctuation the model already supplied, including commas/colons.
        !END_PUNCTUATION.test(previous.text.replace(CLOSING_MARKS, '')) &&
        /[\p{L}\p{N}]/u.test(word[0])) {
      sentences.push(finishSentence(text.slice(sentenceStart, word.index).trim(), { continuation: sentenceStart === 0 && options.continuation }));
      sentenceStart = word.index;
    }
    previous = { text: word[0], endTime: timestamps[tokenIndex] + durations[tokenIndex] };
  }
  sentences.push(finishSentence(text.slice(sentenceStart), { ...options, continuation: sentenceStart === 0 && options.continuation }));
  return sentences.join(' ');
}

// (C1197) Machine-readable sub-reason for LocalAsrUnavailableError. `.reason` stays free-form
// English (message === reason, unchanged — voice-stream/local-provider.js forwards it verbatim,
// transcribe-route.test.js asserts on it) but is not itself translatable. `reasonCode` +
// `detail` let audio-recorder.js/voice-errors.js show a LOCALIZED sub-message instead of either
// a single static string (today) or leaking this raw English into a Ukrainian UI.
const LOCAL_ASR_REASONS = Object.freeze({
  ADDON_LOAD_FAILED: 'ADDON_LOAD_FAILED',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  UNSUPPORTED_KIND: 'UNSUPPORTED_KIND',
  MODEL_NOT_DOWNLOADED: 'MODEL_NOT_DOWNLOADED',
  VAD_DOWNLOAD_FAILED: 'VAD_DOWNLOAD_FAILED',
});

class LocalAsrUnavailableError extends Error {
  constructor(reason, { reasonCode = null, detail = null } = {}) {
    super(reason);
    this.name = 'LocalAsrUnavailableError';
    this.code = 'LOCAL_ASR_UNAVAILABLE';
    this.reason = reason;
    this.reasonCode = reasonCode;
    this.detail = detail;
  }
}

let _sherpa = null;
function sherpa() {
  if (_sherpa) return _sherpa;
  try {
    _sherpa = require('sherpa-onnx-node');
  } catch (err) {
    throw new LocalAsrUnavailableError(`sherpa-onnx-node native addon failed to load: ${err.message}`, {
      reasonCode: LOCAL_ASR_REASONS.ADDON_LOAD_FAILED,
      detail: { cause: err.message },
    });
  }
  return _sherpa;
}

// modelId -> live OfflineRecognizer. Built once per model per process and reused across every
// session/stream — sherpa's own examples reuse one recognizer across many createStream() calls;
// each OfflineStream handle is independent, so concurrent sessions decoding through the same
// recognizer is the documented, safe usage.
const _recognizers = new Map();
let _vadReadyPromise = null;

function offlineModelConfig(entry, dir) {
  const files = Object.fromEntries(entry.files.map((f) => [f.role, path.join(dir, f.name)]));
  if (entry.kind === 'transducer') {
    return {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      // Required for NeMo TDT (parakeet) offline models — see sherpa-onnx's
      // test_asr_non_streaming_nemo_parakeet_tdt_v2.js example. Omitted entirely for the plain
      // transducer/whisper kinds below, matching those examples.
      modelType: 'nemo_transducer',
      numThreads: 1,
      provider: 'cpu',
    };
  }
  if (entry.kind === 'whisper') {
    return {
      whisper: { encoder: files.encoder, decoder: files.decoder },
      tokens: files.tokens,
      numThreads: 1,
      provider: 'cpu',
    };
  }
  throw new LocalAsrUnavailableError(`model kind "${entry.kind}" has no local-streaming decoder`, {
    reasonCode: LOCAL_ASR_REASONS.UNSUPPORTED_KIND,
    detail: { kind: entry.kind },
  });
}

// (C1186) Stores the in-flight PROMISE, not just the resolved recognizer — mirrors
// ensureVadModelReady() below. Without this, two concurrent first-uses of the same model (two
// mics recording at once, see the C1175 ref-counted toast) each pass the `.has()` check before
// either finishes `createAsync()`, building two ORT sessions for the same model (~660MB extra
// for parakeet). A failed build is evicted so the next call retries instead of staying poisoned.
async function ensureRecognizer(modelId) {
  if (_recognizers.has(modelId)) return _recognizers.get(modelId);
  const entry = VOICE_MODEL_REGISTRY[modelId];
  if (!entry) {
    throw new LocalAsrUnavailableError(`unknown local model "${modelId}"`, {
      reasonCode: LOCAL_ASR_REASONS.UNKNOWN_MODEL,
      detail: { model: modelId },
    });
  }
  const promise = (async () => {
    const status = await getVoiceModelStatus(modelId);
    if (status.state !== 'ready') {
      throw new LocalAsrUnavailableError(`model "${modelId}" not downloaded yet (state: ${status.state})`, {
        reasonCode: LOCAL_ASR_REASONS.MODEL_NOT_DOWNLOADED,
        detail: { model: entry.label, state: status.state },
      });
    }
    const dir = voiceModelDir(modelId);
    const config = {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: offlineModelConfig(entry, dir),
    };
    const { OfflineRecognizer } = sherpa();
    return OfflineRecognizer.createAsync(config);
  })();
  _recognizers.set(modelId, promise);
  try {
    return await promise;
  } catch (err) {
    _recognizers.delete(modelId);
    throw err;
  }
}

// Downloads the (small, ~2.2MB) Silero VAD weights on first use if missing — reuses the exact
// same downloadVoiceModel() machinery as the user-facing models (dedupe/resume/lock/checksum),
// just against the separate VAD_MODEL_REGISTRY (see voice-model-manager.js). Idempotent and
// safe to call from every session init — resolves instantly once already on disk.
async function ensureVadModelReady() {
  if (_vadReadyPromise) return _vadReadyPromise;
  _vadReadyPromise = (async () => {
    try {
      await ensureVadModel();
    } catch (err) {
      _vadReadyPromise = null; // allow a retry on the next session instead of poisoning forever
      throw new LocalAsrUnavailableError(`silero-vad download failed: ${err.message}`, {
        reasonCode: LOCAL_ASR_REASONS.VAD_DOWNLOAD_FAILED,
        detail: { cause: err.message },
      });
    }
    return vadModelDir();
  })();
  return _vadReadyPromise;
}

// `endpointing` is an already-resolved { threshold, minSpeechDuration, minSilenceDuration,
// maxSpeechDuration } — see vad-endpointing.js for what each knob does and its default.
function vadConfig(modelPath, endpointing = DEFAULT_ENDPOINTING) {
  return {
    sileroVad: {
      model: modelPath,
      threshold: endpointing.threshold,
      minSpeechDuration: endpointing.minSpeechDuration,
      minSilenceDuration: endpointing.minSilenceDuration,
      maxSpeechDuration: endpointing.maxSpeechDuration,
      windowSize: VAD_WINDOW_SIZE,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: false,
  };
}

// One instance per voice WS session — owns its own CircularBuffer + Vad state so concurrent
// sessions (two mics recording at once is a real case here, see the C1175 ref-counted toast)
// never cross-contaminate each other's speech/silence segments. The heavy shared pieces
// (recognizer, VAD weights on disk) are the process-wide singletons above; this class is cheap
// per-session state only.
class LocalAsrSession {
  // `endpointing` (optional) overrides individual VAD endpointing knobs; anything omitted or
  // invalid falls back to DEFAULT_ENDPOINTING (vad-endpointing.js). The streaming path passes it
  // down from the provider ctx (voice-stream/index.js); batch/probe callers omit it.
  constructor({ modelId, endpointing = null }) {
    this.modelId = modelId;
    this.endpointing = resolveEndpointing(endpointing);
    this.vad = null;
    this.contextVad = null;
    this.recognizer = null;
    this.buffer = null;
    this.parakeet = modelId === 'parakeet-v2' || modelId === 'parakeet-v3';
    this.processedSamples = 0;
    this.pending = null;
    this.partial = null;
    this.continuation = false;
    this.flushed = false;
    // (C1200) VAD-segments-seen vs decoded-to-blank counters — disambiguates "no speech detected"
    // from "model returns blank text", which look identical on the wire (zero voice:final either
    // way, see local-provider.js's pushAudio()). Read by scripts/probe-local-asr.js; not currently
    // surfaced over the WS protocol itself.
    this.stats = { segments: 0, emptySegments: 0 };
  }

  async init() {
    const [recognizer, vadDir] = await Promise.all([ensureRecognizer(this.modelId), ensureVadModelReady()]);
    this.recognizer = recognizer;
    const { Vad, CircularBuffer } = sherpa();
    this.vad = new Vad(vadConfig(path.join(vadDir, 'silero_vad_v5.onnx'), this.endpointing), VAD_BUFFER_SECONDS);
    if (this.parakeet) {
      this.contextVad = new Vad(vadConfig(path.join(vadDir, 'silero_vad_v5.onnx'), {
        ...this.endpointing, minSilenceDuration: 0.15, minSpeechDuration: 0.05,
      }), VAD_BUFFER_SECONDS);
    }
    this.buffer = new CircularBuffer(SAMPLE_RATE * VAD_BUFFER_SECONDS);
  }

  // Release per-recording native VAD objects after a canceled startup or completed drain.
  // The process-wide recognizer cache remains available for the next recording.
  dispose() {
    this.vad = null;
    this.contextVad = null;
    this.buffer = null;
    this.recognizer = null;
    this.pending = null;
    this.partial = null;
  }

  // samples: Float32Array in [-1, 1] at 16kHz. Returns { text, lang } for each
  // committed sentence/context during this call. `partial` holds the latest replaceable Parakeet
  // hypothesis, separate from these final-only results so batch callers cannot duplicate it.
  //
  // (C1186) async — decodeAsync() runs the actual ONNX inference off the main thread (N-API
  // AsyncWorker on libuv's threadpool), so a multi-second decode never blocks the event loop
  // this same process uses for every PTY terminal session and WebSocket. The old sync decode()
  // stalled all of those for the duration of each segment's inference.
  // (C1202) Pushed in <=1s slices, not the whole `samples` array at once. The streaming path
  // (local-provider.js) only ever calls this with ~800-sample (~50ms) chunks, so the ring
  // buffer (CircularBuffer(SAMPLE_RATE * VAD_BUFFER_SECONDS) = 60s of samples) never came close
  // to full. The BATCH path (ws-handlers.js#handleLocalTranscribe) calls this once with an
  // entire recording — anything over 60s would overflow `this.buffer.push()` in one call.
  // Slicing here fixes both entry points without either one knowing about the limit.
  async acceptWaveform(samples) {
    if (this.flushed) return [];
    const results = [];
    for (let offset = 0; offset < samples.length; offset += PUSH_SLICE_SAMPLES) {
      const slice = samples.subarray(offset, Math.min(offset + PUSH_SLICE_SAMPLES, samples.length));
      this.buffer.push(slice);
      while (this.buffer.size() >= VAD_WINDOW_SIZE) {
        // (C1196) 3rd arg `false` = enableExternalBuffer:false — the addon's default (`true`)
        // builds the returned Float32Array as a V8 *external* ArrayBuffer, which
        // napi_create_external_arraybuffer refuses under Electron's V8 sandbox (this server's
        // fork()'d child IS Electron-as-Node, sandbox stays compiled in) — throws "External
        // buffers are not allowed" on every window, killing local ASR entirely. `false` takes
        // the addon's allocate+copy branch instead (one ~2KB memcpy/window, no real cost). See
        // tt-audio-input.md § Electron V8 sandbox — no external buffers (C1196).
        const window = this.buffer.get(this.buffer.head(), VAD_WINDOW_SIZE, false);
        this.buffer.pop(VAD_WINDOW_SIZE);
        this.vad.acceptWaveform(window);
        this.processedSamples += VAD_WINDOW_SIZE;
        results.push(...await this._drainSegments());
        // Use audio time, never inference/wall time. An open VAD segment may already contain
        // resumed speech even though it has not produced its next decode yet.
        if (this.pending && !this.vad.isDetected() &&
            this.processedSamples - this.pending.end >= SENTENCE_PAUSE_SECONDS * SAMPLE_RATE) {
          results.push(...this._commitPending());
        }
      }
    }
    return results;
  }

  // Call once when the client stops recording, to flush any trailing in-progress segment that
  // hadn't yet hit endpointing.minSilenceDuration.
  async flush() {
    if (!this.vad || this.flushed) return [];
    this.flushed = true;
    // VAD accepts full windows only. Preserve the final sub-window before flushing it.
    if (this.buffer && this.buffer.size()) {
      const size = this.buffer.size();
      const window = new Float32Array(VAD_WINDOW_SIZE);
      window.set(this.buffer.get(this.buffer.head(), size, false));
      this.buffer.pop(size);
      this.vad.acceptWaveform(window);
      this.processedSamples += size;
    }
    this.vad.flush();
    return [...await this._drainSegments(), ...this._commitPending()];
  }

  _commitPending({ final = true } = {}) {
    const pending = this.pending;
    this.pending = null;
    this.partial = null;
    if (!pending) return [];
    const text = finishSentence(pending.text, { final, continuation: this.continuation });
    this.continuation = !final && Boolean(text);
    return text ? [{ text, lang: pending.lang }] : [];
  }

  async _drainSegments() {
    const results = [];
    while (!this.vad.isEmpty()) {
      // (C1196) same external-buffer trap as acceptWaveform() above — front() also defaults to
      // enableExternalBuffer:true, throws under Electron's V8 sandbox. `false` copies instead.
      const segment = this.vad.front(false);
      this.vad.pop();
      this.stats.segments++;
      if (!this.parakeet) {
        const decoded = await this._decodeSegment(segment.samples);
        if (decoded.text) results.push(decoded);
        else this.stats.emptySegments++;
        continue;
      }
      const start = segment.start ?? this.processedSamples;
      const end = start + segment.samples.length;
      if (this.pending && start - this.pending.end >= SENTENCE_PAUSE_SECONDS * SAMPLE_RATE) {
        results.push(...this._commitPending());
      }
      // Bound memory and repeat inference. A capacity rollover commits words without
      // inventing a sentence boundary; the next context continues the same sentence.
      if (this.pending && end - this.pending.start > PARAKEET_CONTEXT_SECONDS * SAMPLE_RATE) {
        results.push(...this._commitPending({ final: false }));
      }
      const contextStart = this.pending ? this.pending.start : start;
      const samples = new Float32Array(end - contextStart);
      if (this.pending) samples.set(this.pending.samples);
      samples.set(segment.samples, start - contextStart);
      const decoded = await this._decodeSegment(samples, { final: false, continuation: this.continuation });
      // Keep a previous nonempty hypothesis if a repeat decode returns blank, while retaining
      // the audio so a later decode can recover it.
      if (!decoded.text) this.stats.emptySegments++;
      this.pending = { start: contextStart, end, samples,
        text: decoded.text || this.pending?.text || '', lang: decoded.lang || this.pending?.lang || null };
      this.partial = { text: this.pending.text, lang: this.pending.lang };
    }
    return results;
  }

  _recognitionAudio(samples) {
    if (!this.contextVad) return samples;
    const vad = this.contextVad;
    vad.reset();
    const regions = [];
    const drain = () => {
      while (!vad.isEmpty()) {
        const segment = vad.front(false);
        regions.push({ start: Math.max(0, segment.start), end: Math.min(samples.length, segment.start + segment.samples.length) });
        vad.pop();
      }
    };
    for (let offset = 0; offset < samples.length; offset += VAD_WINDOW_SIZE) {
      let window = samples.subarray(offset, offset + VAD_WINDOW_SIZE);
      if (window.length < VAD_WINDOW_SIZE) {
        const padded = new Float32Array(VAD_WINDOW_SIZE);
        padded.set(window);
        window = padded;
      }
      vad.acceptWaveform(window);
      drain();
    }
    vad.flush();
    drain();
    return compactSpeechGaps(samples, regions);
  }

  async _decodeSegment(samples, options = {}) {
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ samples: this._recognitionAudio(samples), sampleRate: SAMPLE_RATE });
    const result = await this.recognizer.decodeAsync(stream);
    const text = (result.text || '').trim();
    return {
      text: this.parakeet ? punctuate(text, result, options) : text,
      lang: result.lang || null,
    };
  }
}

// (C1202) Fire-and-forget pre-warm — builds the recognizer + VAD weights ahead of the first
// real recording instead of paying that cost lazily inside it. There was previously ZERO
// pre-warming: `ensureRecognizer(modelId)` (~660MB ORT session for parakeet) only ever ran
// inside an actual recording/transcribe call, and no recording is long enough to outlast a
// cold build — see local-provider.js's `ready` promise chain (C1200) and voice-prewarm.js,
// which is the only caller of this. Shares `_recognizers`'s in-flight-promise cache (this
// function IS just `ensureRecognizer` + `ensureVadModelReady`), so a warm call and a real
// recording racing each other build the session exactly once either way — and a failed warm
// leaves nothing poisoned, since `ensureRecognizer` already evicts its own cache on rejection.
// Never throws; callers don't need a try/catch.
async function warmLocalAsr(modelId) {
  const started = Date.now();
  try {
    await Promise.all([ensureRecognizer(modelId), ensureVadModelReady()]);
    console.log(`[local-asr] pre-warmed "${modelId}" in ${Date.now() - started}ms`);
    return true;
  } catch (err) {
    console.warn(`[local-asr] pre-warm "${modelId}" failed:`, err.message);
    return false;
  }
}

module.exports = {
  LocalAsrSession,
  LocalAsrUnavailableError,
  LOCAL_ASR_REASONS,
  SAMPLE_RATE,
  SENTENCE_PAUSE_SECONDS,
  PARAKEET_CONTEXT_SECONDS,
  compactSpeechGaps,
  DEFAULT_ENDPOINTING,
  warmLocalAsr,
  punctuate,
  // exported for tests
  ensureRecognizer,
  ensureVadModelReady,
  vadConfig,
};
