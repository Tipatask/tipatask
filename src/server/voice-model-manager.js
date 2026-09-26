'use strict';

// (C1176) Shared local voice-model downloader: parakeet-v2, parakeet-v3, whisper-base.
//
// Weights are stored once under a machine-wide, project-agnostic root
// (config.USER_DATA_ROOT/vendor/voice-models/<modelId>/) so every project reuses the same
// download instead of each one pulling its own copy. In dev, USER_DATA_ROOT === SERVER_ROOT,
// so the path is literally <checkout>/vendor/voice-models/<modelId>/. In a packaged build
// it resolves to Electron's userData dir (e.g. ~/Library/Application Support/TipATask/vendor/
// voice-models/) — never inside the signed app.asar. That is not a style choice: any unsealed
// file written under Contents/Resources breaks the code signature and silently kills macOS
// notification delivery (C1141) — see ai/architecture/tt-electron-app.md § Writable State.
//
// This module is a pure library: it never touches WebSocket/HTTP. ws-handlers.js is the only
// place that wires downloadVoiceModel()'s onProgress callback to websocket.js's broadcast.
//
// Local inference (actually loading these weights to transcribe) is explicitly OUT of scope
// here — this module only gets verified bytes onto disk.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const HF_BASE_URL = 'https://huggingface.co';

// ── Model registry ──
// URLs are pinned to a commit SHA (never `main`) so an upstream push can never silently
// change bytes under us. Sizes/sha256 verified live against the HuggingFace API for
// csukuangfj's sherpa-onnx model repos — the only Node-viable engine covering all three
// (transformers.js has no NeMo TDT decoding; whisper.cpp is whisper-only).
//
// LFS vs non-LFS asymmetry (probed live, see tt-audio-input.md): the big .onnx weights are
// Git LFS and support Range + report a real content-length. The small tokens.txt files are
// served brotli-encoded with NO content-length and NO accept-ranges. Consequence: every size
// check in this module compares against the REGISTRY size, never against a response header —
// content-length is absent for non-LFS files and would describe compressed bytes anyway for
// an encoded response (fetch decodes transparently, so bytes on disk are always the decoded
// size). Resume (see downloadOneFile) only ever applies to the LFS files.
const VOICE_MODEL_REGISTRY = Object.freeze({
  'parakeet-v2': Object.freeze({
    id: 'parakeet-v2',
    label: 'Parakeet TDT 0.6B v2 (int8)',
    kind: 'transducer',
    languages: 'en',
    repo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    revision: '1ab9323565ddb038682214b292f588070a538ce2',
    files: Object.freeze([
      Object.freeze({ role: 'encoder', name: 'encoder.int8.onnx', size: 652184296, sha256: 'a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab' }),
      Object.freeze({ role: 'decoder', name: 'decoder.int8.onnx', size: 7257753, sha256: 'b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e' }),
      Object.freeze({ role: 'joiner', name: 'joiner.int8.onnx', size: 1739080, sha256: '7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2' }),
      Object.freeze({ role: 'tokens', name: 'tokens.txt', size: 9384, sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d' }),
    ]),
  }),
  'parakeet-v3': Object.freeze({
    id: 'parakeet-v3',
    label: 'Parakeet TDT 0.6B v3 (int8)',
    kind: 'transducer',
    languages: 'multilingual',
    repo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    revision: '2bda32ec70b097a55adaa07d9a7173915b43cc78',
    files: Object.freeze([
      Object.freeze({ role: 'encoder', name: 'encoder.int8.onnx', size: 652184281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' }),
      Object.freeze({ role: 'decoder', name: 'decoder.int8.onnx', size: 11845275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' }),
      Object.freeze({ role: 'joiner', name: 'joiner.int8.onnx', size: 6355277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' }),
      Object.freeze({ role: 'tokens', name: 'tokens.txt', size: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' }),
    ]),
  }),
  'whisper-base': Object.freeze({
    id: 'whisper-base',
    label: 'Whisper base (int8)',
    kind: 'whisper',
    languages: 'multilingual',
    repo: 'csukuangfj/sherpa-onnx-whisper-base',
    revision: 'bb53ee204431c90d314c1cc08d28d23e5b7927cc',
    files: Object.freeze([
      Object.freeze({ role: 'encoder', name: 'base-encoder.int8.onnx', size: 29120534, sha256: '0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11' }),
      Object.freeze({ role: 'decoder', name: 'base-decoder.int8.onnx', size: 130672026, sha256: '9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d' }),
      Object.freeze({ role: 'tokens', name: 'base-tokens.txt', size: 816730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' }),
    ]),
  }),
});
const VOICE_MODEL_IDS = Object.freeze(Object.keys(VOICE_MODEL_REGISTRY));

// ── VAD (Silero, C1185) ──
// Deliberately a SEPARATE mini-registry, not folded into VOICE_MODEL_REGISTRY/VOICE_MODEL_IDS.
// It's an internal dependency of streaming local transcription (chunks live PCM into speech
// segments the offline ASR models can decode) — not a user-selectable transcription model, so
// it must stay out of the Voice-settings model list (C1178) and the /api/voice-models listing,
// both of which iterate VOICE_MODEL_IDS. Downloaded on first use by local-asr.js via the SAME
// downloadVoiceModel() machinery (dedupe, resume, lock, checksum) using an explicit `registry`
// override — see ensureVadModel()/vadModelDir() below.
//
// Source: csukuangfj/vad on HuggingFace, pinned to the repo's HEAD commit (not `main`) per the
// same never-move-under-us rule as every other entry — verified live: LFS-tracked, real
// content-length, accept-ranges: bytes.
const VAD_MODEL_REGISTRY = Object.freeze({
  'silero-vad': Object.freeze({
    id: 'silero-vad',
    label: 'Silero VAD v5',
    kind: 'vad',
    languages: 'n/a',
    repo: 'csukuangfj/vad',
    revision: 'fba88cd2e921609e7675c3aaf51e0b9b295da4bc',
    files: Object.freeze([
      Object.freeze({ role: 'model', name: 'silero_vad_v5.onnx', size: 2313101, sha256: '6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396' }),
    ]),
  }),
});

const VOICE_MODEL_ERRORS = Object.freeze({
  UNKNOWN: 'VOICE_MODEL_UNKNOWN',
  LOCKED: 'VOICE_MODEL_LOCKED',
  HTTP: 'VOICE_MODEL_HTTP',
  NETWORK: 'VOICE_MODEL_NETWORK',
  SIZE_MISMATCH: 'VOICE_MODEL_SIZE_MISMATCH',
  CHECKSUM_MISMATCH: 'VOICE_MODEL_CHECKSUM_MISMATCH',
  DISK_FULL: 'VOICE_MODEL_DISK_FULL',
  WRITE: 'VOICE_MODEL_WRITE',
  ABORTED: 'VOICE_MODEL_ABORTED',
});

const PROGRESS_THROTTLE_MS = 250;
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 min with no progress, not 10 min since start (see acquireLock)

function voiceModelError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function totalBytesFor(entry) {
  return entry.files.reduce((n, f) => n + f.size, 0);
}

// ── path resolution (pure, injectable — mirrors config.js#resolveDataRoot's style) ──

function voiceModelsRoot({ userDataRoot } = {}) {
  if (process.env.TIPATASK_VOICE_MODELS_DIR) return path.resolve(process.env.TIPATASK_VOICE_MODELS_DIR);
  const root = userDataRoot || require('./config').USER_DATA_ROOT;
  return path.join(root, 'vendor', 'voice-models');
}

function lookupEntry(modelId, registry) {
  // Object.hasOwn guards against '__proto__'/'constructor'/'toString' resolving through the
  // prototype chain instead of missing outright — modelId can come straight off an HTTP URL.
  if (typeof modelId !== 'string' || !Object.hasOwn(registry, modelId)) {
    throw voiceModelError(
      VOICE_MODEL_ERRORS.UNKNOWN,
      `Unknown voice model "${modelId}" — supported: ${Object.keys(registry).join(', ')}`
    );
  }
  return registry[modelId];
}

function voiceModelDir(modelId, { rootDir, registry = VOICE_MODEL_REGISTRY } = {}) {
  lookupEntry(modelId, registry); // throws VOICE_MODEL_UNKNOWN for a bad id
  return path.join(rootDir || voiceModelsRoot(), modelId);
}

function resolveVoiceModelUrl({ baseUrl = HF_BASE_URL, repo, revision, file }) {
  return `${baseUrl}/${repo}/resolve/${revision}/${file}`;
}

function markerPath(dir) {
  return path.join(dir, '.complete.json');
}
function lockPath(dir) {
  return path.join(dir, '.download.lock');
}
function partPath(dir, name) {
  return path.join(dir, `${name}.part`);
}
function sidecarPath(dir, name) {
  return path.join(dir, `${name}.part.json`);
}

// ── status ──

async function readMarker(dir) {
  try {
    return JSON.parse(await fsp.readFile(markerPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

// The on-disk half of status — deliberately does NOT know about _inFlight. Cheap: stat only,
// never hashes (hashing 650MB on every status poll would be pathological).
//
// Kept separate from getVoiceModelStatus() because downloadVoiceModel() needs exactly this
// (marker/files-on-disk truth) for its own "already cached?" pre-check, and must NOT go through
// the in-flight overlay to get it: _inFlight.set(dir, ...) for the CURRENT call lands
// synchronously right after the run() IIFE is invoked, before any awaited I/O in this function
// resolves — so a version of this check that also asked "am I in flight?" would always see
// itself as already downloading and never recognize a cache hit. Verified by reproduction.
async function computeDiskState(entry, dir) {
  const totalBytes = totalBytesFor(entry);
  const files = await Promise.all(entry.files.map(async (f) => {
    try {
      const st = await fsp.stat(path.join(dir, f.name));
      return { role: f.role, name: f.name, size: f.size, present: true, sizeOk: st.size === f.size };
    } catch {
      return { role: f.role, name: f.name, size: f.size, present: false, sizeOk: false };
    }
  }));
  const bytesOnDisk = files.reduce((n, f) => (f.present ? n + f.size : n), 0);
  const marker = await readMarker(dir);
  const allPresent = files.every((f) => f.present && f.sizeOk);
  const anyPresent = files.some((f) => f.present);

  let state;
  if (marker && (marker.schemaVersion !== 1 || marker.revision !== entry.revision)) state = 'stale';
  else if (marker && allPresent) state = 'ready';
  else if (anyPresent) state = 'partial';
  else state = 'missing';

  return { totalBytes, files, bytesOnDisk, marker, state };
}

async function getVoiceModelStatus(modelId, { rootDir, registry = VOICE_MODEL_REGISTRY } = {}) {
  const entry = lookupEntry(modelId, registry);
  const dir = voiceModelDir(modelId, { rootDir, registry });
  const disk = await computeDiskState(entry, dir);
  const state = isVoiceModelDownloading(modelId, { rootDir, registry }) ? 'downloading' : disk.state;

  return {
    modelId, label: entry.label, kind: entry.kind, repo: entry.repo, revision: entry.revision, dir,
    state, totalBytes: disk.totalBytes, bytesOnDisk: disk.bytesOnDisk, fileCount: entry.files.length,
    files: disk.files, completedAt: (disk.marker && disk.marker.completedAt) || null,
  };
}

async function listVoiceModels(opts = {}) {
  const registry = opts.registry || VOICE_MODEL_REGISTRY;
  const models = await Promise.all(Object.keys(registry).map((id) => getVoiceModelStatus(id, opts)));
  return { models, root: opts.rootDir || voiceModelsRoot() };
}

// ── in-flight tracking (in-process dedupe + cross-caller progress fanout) ──

const _inFlight = new Map(); // key `${dir}` -> { promise, controller, listeners: Set }

function isVoiceModelDownloading(modelId, { rootDir, registry = VOICE_MODEL_REGISTRY } = {}) {
  const dir = voiceModelDir(modelId, { rootDir, registry });
  return _inFlight.has(dir);
}

function abortVoiceModelDownload(modelId, { rootDir, registry = VOICE_MODEL_REGISTRY } = {}) {
  const dir = voiceModelDir(modelId, { rootDir, registry });
  const rec = _inFlight.get(dir);
  if (!rec) return false;
  rec.controller.abort();
  return true;
}

// ── streaming download of one file, with resume for Range-capable (LFS) sources ──
//
// Hashing is wired in via a Transform in the middle of the pipeline, NOT a `data` listener on
// the response body — attaching `data` flips a stream into flowing mode before pipeline() gets
// to control it, which defeats backpressure and can race with the destination write. A
// Transform preserves both backpressure and pipeline's error/cleanup semantics.
function hashingCounter(hash, onBytes) {
  return new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      if (onBytes) onBytes(chunk.length);
      cb(null, chunk);
    },
  });
}

// Plain async iteration, NOT pipeline(readStream, transform) — a pipeline whose last stage is
// a bare Transform never drains (nothing reads its output side once its internal buffer fills
// past the default 16KB highWaterMark) and hangs forever on any file bigger than that. Verified
// by reproduction during development. A local read has no destination to pipe into, so there's
// no pipeline to build in the first place.
async function hashExistingPrefix(filePath, hash) {
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
}

async function downloadOneFile({ url, destPath, size, sha256, signal, onBytes, sidecarFile, allowResume }) {
  let hash = crypto.createHash('sha256');
  let start = 0;
  const partFile = destPath + '.part';

  if (allowResume && process.env.TIPATASK_VOICE_MODEL_NO_RESUME !== '1') {
    try {
      const [partStat, sidecar] = await Promise.all([
        fsp.stat(partFile),
        fsp.readFile(sidecarFile, 'utf8').then(JSON.parse),
      ]);
      // Only resume if the sidecar proves this .part belongs to THIS exact file (same URL +
      // expected digest) and is a strict, sane prefix. Anything else — sidecar missing, a
      // revision bump changing the URL/sha256, or a bogus/over-long .part — restarts clean.
      // This is deliberately conservative: the final sha256 gate is a backstop for a resume
      // bug, but "always correct" beats "usually correct, silently wrong on the edge case".
      if (sidecar.url === url && sidecar.sha256 === sha256 && partStat.size > 0 && partStat.size < size) {
        await hashExistingPrefix(partFile, hash);
        start = partStat.size;
      }
    } catch {
      // no usable .part/sidecar — fall through to a clean start
    }
  }
  if (start === 0) {
    hash = crypto.createHash('sha256');
    await fsp.writeFile(sidecarFile, JSON.stringify({ url, sha256, size, startedAt: new Date().toISOString() }));
  }

  const res = await fetch(url, { signal, headers: start ? { Range: `bytes=${start}-` } : {} }).catch((err) => {
    throw voiceModelError(VOICE_MODEL_ERRORS.NETWORK, `fetch failed for ${url}: ${err.message}`, { cause: err });
  });

  let writeStart = start;
  if (start && res.status !== 206) {
    // Origin ignored our Range header (200) or rejected it — reset and start over rather than
    // risk appending onto a wrong offset.
    writeStart = 0;
    hash = crypto.createHash('sha256');
  } else if (!res.ok && res.status !== 206) {
    throw voiceModelError(VOICE_MODEL_ERRORS.HTTP, `HTTP ${res.status} fetching ${url}`, { status: res.status });
  }

  try {
    await pipeline(
      Readable.fromWeb(res.body),
      hashingCounter(hash, onBytes),
      fs.createWriteStream(partFile, { flags: writeStart ? 'a' : 'w' }),
      { signal }
    );
  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) {
      throw voiceModelError(VOICE_MODEL_ERRORS.ABORTED, `Download aborted: ${url}`);
    }
    if (err.code === 'ENOSPC') throw voiceModelError(VOICE_MODEL_ERRORS.DISK_FULL, `No space left writing ${destPath}`);
    throw voiceModelError(VOICE_MODEL_ERRORS.NETWORK, `Stream failed for ${url}: ${err.message}`, { cause: err });
  }

  const finalSize = (await fsp.stat(partFile)).size;
  if (finalSize !== size) {
    await fsp.unlink(partFile).catch(() => {});
    await fsp.unlink(sidecarFile).catch(() => {});
    throw voiceModelError(VOICE_MODEL_ERRORS.SIZE_MISMATCH, `${path.basename(destPath)}: expected ${size} bytes, got ${finalSize}`);
  }
  const digest = hash.digest('hex');
  if (digest !== sha256) {
    await fsp.unlink(partFile).catch(() => {});
    await fsp.unlink(sidecarFile).catch(() => {});
    throw voiceModelError(VOICE_MODEL_ERRORS.CHECKSUM_MISMATCH, `${path.basename(destPath)}: checksum mismatch`);
  }
  await fsp.rename(partFile, destPath);
  await fsp.unlink(sidecarFile).catch(() => {});
  return { bytes: finalSize, sha256: digest };
}

// ── disk space precheck ──

async function checkFreeSpace(dir, neededBytes) {
  try {
    const st = await fsp.statfs(dir);
    const availableBytes = st.bavail * st.bsize;
    if (availableBytes < neededBytes * 1.1) {
      throw voiceModelError(
        VOICE_MODEL_ERRORS.DISK_FULL,
        `Not enough free space: need ~${Math.ceil(neededBytes / 1048576)}MB, have ~${Math.floor(availableBytes / 1048576)}MB`
      );
    }
  } catch (err) {
    if (err.code === VOICE_MODEL_ERRORS.DISK_FULL) throw err;
    // statfs unsupported/failed on this filesystem — don't block the download over it.
    console.warn('[voice-model] disk space precheck skipped:', err.message);
  }
}

// ── cross-process lock (a probe run and the server sharing one root must not both write) ──

async function acquireLock(dir) {
  const lp = lockPath(dir);
  try {
    const fh = await fsp.open(lp, 'wx');
    await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await fh.close();
    return;
  } catch (err) {
    if (err.code !== 'EEXIST') throw voiceModelError(VOICE_MODEL_ERRORS.WRITE, `Cannot create lock: ${err.message}`);
  }
  // Lock file exists — stale only if untouched for LOCK_STALE_MS (touched on every progress
  // tick below, so a slow-but-live download's lock never looks stale mid-transfer).
  try {
    const st = await fsp.stat(lp);
    if (Date.now() - st.mtimeMs < LOCK_STALE_MS) {
      throw voiceModelError(VOICE_MODEL_ERRORS.LOCKED, 'Another process is already downloading this model');
    }
    await fsp.unlink(lp);
  } catch (err) {
    if (err.code === VOICE_MODEL_ERRORS.LOCKED) throw err;
    // stat/unlink race — treat as locked rather than risk a double-writer.
    throw voiceModelError(VOICE_MODEL_ERRORS.LOCKED, 'Another process is already downloading this model');
  }
  return acquireLock(dir); // retry once after clearing a stale lock
}

async function releaseLock(dir) {
  await fsp.unlink(lockPath(dir)).catch(() => {});
}

async function touchLock(dir) {
  const now = new Date();
  await fsp.utimes(lockPath(dir), now, now).catch(() => {});
}

// ── main entry point ──

async function downloadVoiceModel(modelId, opts = {}) {
  const registry = opts.registry || VOICE_MODEL_REGISTRY;
  const entry = lookupEntry(modelId, registry); // throws before any fs/network touch
  const rootDir = opts.rootDir || voiceModelsRoot();
  const dir = path.join(rootDir, modelId);
  const baseUrl = opts.baseUrl || HF_BASE_URL;
  const totalBytes = totalBytesFor(entry);

  if (_inFlight.has(dir)) {
    const rec = _inFlight.get(dir);
    if (opts.onProgress) rec.listeners.add(opts.onProgress);
    if (opts.signal) opts.signal.addEventListener('abort', () => rec.controller.abort(), { once: true });
    return rec.promise;
  }

  const started = Date.now();
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const listeners = new Set();
  if (opts.onProgress) listeners.add(opts.onProgress);

  let lastEmit = 0;
  function emitProgress(partial, force) {
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    const payload = { modelId, totalBytes, ...partial };
    for (const fn of listeners) {
      try { fn(payload); } catch (err) { console.warn('[voice-model] onProgress listener threw:', err.message); }
    }
  }

  const run = (async () => {
    if (!opts.force) {
      // computeDiskState(), NOT getVoiceModelStatus() — see that function's comment: this call
      // is itself what _inFlight is about to represent, so asking "am I in flight?" here would
      // always answer yes and this cache check could never fire.
      const disk = await computeDiskState(entry, dir);
      if (disk.state === 'ready') return { modelId, dir, revision: entry.revision, totalBytes, files: [], skipped: true, durationMs: Date.now() - started };
    }

    await fsp.mkdir(dir, { recursive: true });
    await acquireLock(dir);
    let lockTimer;
    try {
      await checkFreeSpace(dir, totalBytes);
      lockTimer = setInterval(() => touchLock(dir), Math.floor(LOCK_STALE_MS / 3));
      if (lockTimer.unref) lockTimer.unref();

      let receivedBytes = 0;
      const results = [];
      for (let i = 0; i < entry.files.length; i++) {
        const f = entry.files[i];
        const destPath = path.join(dir, f.name);
        const url = resolveVoiceModelUrl({ baseUrl, repo: entry.repo, revision: entry.revision, file: f.name });

        let fileBytes = 0;
        const existing = opts.force ? null : await fsp.stat(destPath).catch(() => null);
        if (existing && existing.size === f.size) {
          // Already correct size — trust it only if it also hashes correctly. Cheap to skip
          // on the common "already downloaded" path; still catches a corrupted prior write.
          // Gated on !opts.force: force means "get me fresh bytes from the network", not just
          // "re-verify what's already here" — that's what a plain (non-force) call already does
          // via the marker-based cache hit above.
          const hash = crypto.createHash('sha256');
          await hashExistingPrefix(destPath, hash);
          if (hash.digest('hex') === f.sha256) {
            receivedBytes += f.size;
            emitProgress({ file: f.name, fileIndex: i, fileCount: entry.files.length, receivedBytes, fileReceivedBytes: f.size, fileTotalBytes: f.size, percent: Math.round((receivedBytes / totalBytes) * 100) }, true);
            results.push({ name: f.name, path: destPath, bytes: f.size, sha256: f.sha256 });
            continue;
          }
        }

        const { bytes, sha256 } = await downloadOneFile({
          url, destPath, size: f.size, sha256: f.sha256, signal: controller.signal,
          sidecarFile: sidecarPath(dir, f.name),
          allowResume: true,
          onBytes: (n) => {
            fileBytes += n;
            receivedBytes += n;
            emitProgress({
              file: f.name, fileIndex: i, fileCount: entry.files.length,
              receivedBytes, fileReceivedBytes: fileBytes, fileTotalBytes: f.size,
              percent: Math.round((receivedBytes / totalBytes) * 100),
            });
          },
        });
        emitProgress({ file: f.name, fileIndex: i, fileCount: entry.files.length, receivedBytes, fileReceivedBytes: bytes, fileTotalBytes: f.size, percent: Math.round((receivedBytes / totalBytes) * 100) }, true);
        results.push({ name: f.name, path: destPath, bytes, sha256 });
      }

      const marker = {
        schemaVersion: 1, modelId, repo: entry.repo, revision: entry.revision, kind: entry.kind,
        totalBytes, files: entry.files.map((f) => ({ role: f.role, name: f.name, size: f.size, sha256: f.sha256 })),
        completedAt: new Date().toISOString(),
      };
      const tmpMarker = markerPath(dir) + '.tmp';
      await fsp.writeFile(tmpMarker, JSON.stringify(marker, null, 2));
      await fsp.rename(tmpMarker, markerPath(dir));

      return { modelId, dir, revision: entry.revision, totalBytes, files: results, skipped: false, durationMs: Date.now() - started };
    } finally {
      if (lockTimer) clearInterval(lockTimer);
      await releaseLock(dir);
    }
  })();

  _inFlight.set(dir, { promise: run, controller, listeners });
  try {
    return await run;
  } finally {
    _inFlight.delete(dir);
  }
}

// ── delete (C1197) ──

// Flat dir, no recursion needed — model dirs hold only registry files + marker + sidecars.
// Real on-disk bytes, NOT registry sizes (computeDiskState().bytesOnDisk under-reports a
// `partial` install since it counts registry size only for files present at full size).
async function dirSizeBytes(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  await Promise.all(entries.map(async (ent) => {
    if (!ent.isFile()) return; // no subdirs expected, but skip rather than throw if one appears
    try {
      const st = await fsp.stat(path.join(dir, ent.name));
      total += st.size;
    } catch {
      // raced with a concurrent unlink — fine, just don't count it
    }
  }));
  return total;
}

async function deleteVoiceModel(modelId, opts = {}) {
  const registry = opts.registry || VOICE_MODEL_REGISTRY;
  const dir = voiceModelDir(modelId, { rootDir: opts.rootDir, registry }); // throws UNKNOWN

  // Never rm a tree a live download is streaming into: the writer keeps appending to unlinked
  // fds, then renames a half-written file back into a directory we just reported gone.
  if (isVoiceModelDownloading(modelId, { rootDir: opts.rootDir, registry })) {
    throw voiceModelError(VOICE_MODEL_ERRORS.LOCKED, `Voice model "${modelId}" is downloading — abort it first`);
  }
  // Same hazard from another process (e.g. `npm run probe:voice-model` shares this root).
  const lockStat = await fsp.stat(lockPath(dir)).catch(() => null);
  if (lockStat && Date.now() - lockStat.mtimeMs < LOCK_STALE_MS) {
    throw voiceModelError(VOICE_MODEL_ERRORS.LOCKED, 'Another process is downloading this model');
  }

  const freedBytes = await dirSizeBytes(dir);
  const existed = (await fsp.stat(dir).catch(() => null)) !== null;
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (err) {
    throw voiceModelError(VOICE_MODEL_ERRORS.WRITE, `Cannot delete ${dir}: ${err.message}`, { cause: err });
  }
  return { modelId, dir, deleted: existed, freedBytes };
}

// (C1185) Same shape as voiceModelDir()/downloadVoiceModel(), pinned to VAD_MODEL_REGISTRY so
// callers never have to remember to pass `registry` themselves.
function vadModelDir(opts = {}) {
  return voiceModelDir('silero-vad', { ...opts, registry: VAD_MODEL_REGISTRY });
}

async function ensureVadModel(opts = {}) {
  return downloadVoiceModel('silero-vad', { ...opts, registry: VAD_MODEL_REGISTRY });
}

module.exports = {
  VOICE_MODEL_IDS,
  VOICE_MODEL_REGISTRY,
  VOICE_MODEL_ERRORS,
  voiceModelsRoot,
  voiceModelDir,
  resolveVoiceModelUrl,
  getVoiceModelStatus,
  listVoiceModels,
  downloadVoiceModel,
  abortVoiceModelDownload,
  isVoiceModelDownloading,
  deleteVoiceModel,
  // (C1185) VAD — see the VAD_MODEL_REGISTRY comment above for why this is separate
  VAD_MODEL_REGISTRY,
  vadModelDir,
  ensureVadModel,
  // exported for tests only
  downloadOneFile,
};
