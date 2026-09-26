'use strict';

// (C1186) Direct AssemblyAI batch transcription using a PER-PROJECT key from
// .tipatask/config.json (ASSEMBLYAI_API_KEY) — called by the POST /api/transcribe route in
// ws-handlers.js when a project has its own key configured, instead of proxying to the remote
// Tipatask API's own key/quota (api/src/routes/transcription.js). Pure library, WS-agnostic,
// same shape as voice-model-manager.js — no HTTP/req/res here, just fetch in, JSON out.
//
// Named "-batch" (not "-client") to read as a sibling of the C1185 realtime streaming provider
// (voice-stream/assemblyai-provider.js), not a competing implementation — this one uploads a
// whole recording and polls for one final result, that one opens a persistent websocket for
// partials. Ports api/src/routes/transcription.js's constants/flow verbatim so the two batch
// paths (this one, and the remote-API-proxy fallback) behave identically to callers.

const ASSEMBLYAI_BASE_URL = 'https://api.assemblyai.com/v2';
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 180_000;

const ASSEMBLYAI_ERRORS = Object.freeze({
  UNAUTHORIZED: 'ASSEMBLYAI_UNAUTHORIZED', // 401/403 from AssemblyAI — bad/revoked key
  TIMEOUT: 'ASSEMBLYAI_TIMEOUT',           // a single request exceeded REQUEST_TIMEOUT_MS
  POLL_TIMEOUT: 'ASSEMBLYAI_POLL_TIMEOUT', // polling exceeded POLL_TIMEOUT_MS overall
  UPSTREAM: 'ASSEMBLYAI_UPSTREAM',         // non-2xx response, or a malformed success body
  ABORTED: 'ASSEMBLYAI_ABORTED',           // caller's own signal fired (client disconnected)
  NETWORK: 'ASSEMBLYAI_NETWORK',           // fetch itself failed (DNS, connection refused, ...)
});

class AssemblyAiError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AssemblyAiError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonResponse(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// One AssemblyAI call, with its own REQUEST_TIMEOUT_MS deadline (AbortController) layered on
// top of the caller's own `signal` (client-disconnect abort) — either firing aborts the fetch.
async function assemblyFetch(fetchImpl, path, apiKey, options, callerSignal) {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort);
  }
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${ASSEMBLYAI_BASE_URL}${path}`, {
      ...options,
      headers: { Authorization: apiKey, ...(options.headers || {}) },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      const data = await readJsonResponse(res);
      throw new AssemblyAiError(ASSEMBLYAI_ERRORS.UNAUTHORIZED, 'AssemblyAI rejected the API key', { status: res.status, upstream: data });
    }
    const data = await readJsonResponse(res);
    if (!res.ok) {
      throw new AssemblyAiError(ASSEMBLYAI_ERRORS.UPSTREAM, 'AssemblyAI request failed', { status: res.status, upstream: data });
    }
    return data;
  } catch (err) {
    if (err instanceof AssemblyAiError) throw err;
    if (callerSignal && callerSignal.aborted) {
      throw new AssemblyAiError(ASSEMBLYAI_ERRORS.ABORTED, 'Client disconnected during AssemblyAI request');
    }
    if (err.name === 'AbortError') {
      throw new AssemblyAiError(ASSEMBLYAI_ERRORS.TIMEOUT, 'AssemblyAI request timed out');
    }
    throw new AssemblyAiError(ASSEMBLYAI_ERRORS.NETWORK, 'AssemblyAI request failed', { cause: err });
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }
}

async function uploadAudio(fetchImpl, audioBuffer, apiKey, signal) {
  const data = await assemblyFetch(fetchImpl, '/upload', apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: audioBuffer,
  }, signal);
  if (!data.upload_url) {
    throw new AssemblyAiError(ASSEMBLYAI_ERRORS.UPSTREAM, 'AssemblyAI upload did not return upload_url', { upstream: data });
  }
  return data.upload_url;
}

async function createTranscript(fetchImpl, audioUrl, apiKey, signal) {
  const data = await assemblyFetch(fetchImpl, '/transcript', apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl, speech_models: ['universal-2'], language_detection: true }),
  }, signal);
  if (!data.id) {
    throw new AssemblyAiError(ASSEMBLYAI_ERRORS.UPSTREAM, 'AssemblyAI transcript did not return id', { upstream: data });
  }
  return data;
}

async function waitForTranscript(fetchImpl, transcriptId, apiKey, signal) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) {
      throw new AssemblyAiError(ASSEMBLYAI_ERRORS.ABORTED, 'Client disconnected while polling AssemblyAI');
    }
    const transcript = await assemblyFetch(fetchImpl, `/transcript/${encodeURIComponent(transcriptId)}`, apiKey, { method: 'GET' }, signal);
    if (transcript.status === 'completed') return transcript;
    if (transcript.status === 'error') {
      throw new AssemblyAiError(ASSEMBLYAI_ERRORS.UPSTREAM, transcript.error || 'AssemblyAI transcription failed', { upstream: transcript });
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new AssemblyAiError(ASSEMBLYAI_ERRORS.POLL_TIMEOUT, 'AssemblyAI transcription timed out');
}

// audioBuffer: Buffer (raw audio bytes — any format AssemblyAI accepts, same as the remote API's
// multer upload). opts.signal: an AbortSignal the caller aborts on client disconnect.
// opts.fetchImpl: injectable for tests, defaults to global fetch.
async function transcribeWithAssemblyAI(audioBuffer, { apiKey, signal, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new AssemblyAiError(ASSEMBLYAI_ERRORS.UPSTREAM, 'ASSEMBLYAI_API_KEY is not configured');
  if (!audioBuffer || audioBuffer.length === 0) throw new AssemblyAiError(ASSEMBLYAI_ERRORS.UPSTREAM, 'audio is required');
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw new AssemblyAiError(ASSEMBLYAI_ERRORS.UPSTREAM, 'Audio upload exceeds 25 MB limit', { status: 413 });
  }
  const audioUrl = await uploadAudio(fetchImpl, audioBuffer, apiKey, signal);
  const queued = await createTranscript(fetchImpl, audioUrl, apiKey, signal);
  const transcript = queued.status === 'completed' ? queued : await waitForTranscript(fetchImpl, queued.id, apiKey, signal);
  // AssemblyAI owns punctuation/casing. The local Parakeet punctuate() pass must not run
  // here (or in the shared HTTP response path), including for immediately completed jobs.
  return { transcript: transcript.text || '', language_code: transcript.language_code || null };
}

module.exports = {
  transcribeWithAssemblyAI,
  AssemblyAiError,
  ASSEMBLYAI_ERRORS,
  MAX_AUDIO_BYTES,
  // exported for tests
  REQUEST_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
};
