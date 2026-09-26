'use strict';

// (C1186) POST /api/transcribe route coverage — no real HTTP server, no port 4455, no network
// (global.fetch and VAD provisioning are mocked), no real sherpa model (unknown/undownloaded
// model ids only, so local-asr.js's fast-fail paths run against a temporary model store).
// Same in-process createHttpHandler fixture as voice-model-routes.test.js.
//
// The single most important test here is "regression: no per-project key -> proxy unchanged" —
// it proves the pre-C1186 fallback path (every existing project with no ASSEMBLYAI_API_KEY
// configured relies on it) still forwards a byte-identical body to the remote Tipatask API.
//
// config.js snapshots process.env.TASK_BACKEND once at require time, and a dev shell may have
// something else exported — pin it so this file is deterministic. Credential isolation itself
// comes from stubBackend()'s getCredentials() below, not from this value.
process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');

const voiceModelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-transcribe-route-models-'));
process.env.TIPATASK_VOICE_MODELS_DIR = voiceModelsDir;

// LocalAsrSession starts VAD provisioning concurrently with recognizer validation.
// An unavailable recognizer does not cancel that background work. Keep VAD local
// even after a route has already returned its expected MODEL_NOT_DOWNLOADED error.
test.mock.method(require('./voice-model-manager'), 'ensureVadModel', async () => {});
const { createHttpHandler } = require('./ws-handlers');

const projectRoots = [];
test.after(() => {
  for (const root of [...projectRoots, voiceModelsDir]) fs.rmSync(root, { recursive: true, force: true });
});

function tmpProjectRoot(voiceCfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-transcribe-route-proj-'));
  projectRoots.push(root);
  fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify(voiceCfg), 'utf8');
  return root;
}

// A real Readable so both `for await (const chunk of req)` (the untouched proxy branch) and
// `.on('data'/'end'/'close')` (readCappedBody, C1186) work exactly as they would on a real
// http.IncomingMessage. `req.complete` mirrors Node's real semantics: true only after 'end'.
function fakeReq(method, url, headers, bodyBuffer) {
  const chunkSize = 1024 * 1024; // stream in ~1MB pieces, not one giant chunk
  const chunks = [];
  if (bodyBuffer && bodyBuffer.length) {
    for (let i = 0; i < bodyBuffer.length; i += chunkSize) chunks.push(bodyBuffer.subarray(i, i + chunkSize));
  }
  const req = new Readable({
    read() { this.push(chunks.length ? chunks.shift() : null); },
  });
  req.method = method;
  req.url = url;
  req.headers = headers || {};
  req.complete = false;
  req.on('end', () => { req.complete = true; });
  return req;
}

function fakeRes() {
  const emitter = new EventEmitter();
  const res = {
    statusCode: null,
    resHeaders: null,
    body: '',
    writableEnded: false,
    writeHead(status, headers) { res.statusCode = status; res.resHeaders = headers; },
    end(chunk) { res.body = chunk || ''; res.writableEnded = true; emitter.emit('finish'); },
    on: (...a) => emitter.on(...a),
    once: (...a) => emitter.once(...a),
    removeListener: (...a) => emitter.removeListener(...a),
    emitClose: () => emitter.emit('close'),
  };
  return res;
}

function stubBackend(creds) {
  return {
    async getTasks() { return []; },
    async getChildren() { return []; },
    ...(creds ? { getCredentials: () => creds } : {}),
  };
}

async function run(req, res, backend) {
  const handler = createHttpHandler(new Map(), () => backend, null);
  await handler(req, res);
  return res;
}

test('regression: assemblyai preset with no per-project key forwards a byte-identical body to the remote API, unchanged from before C1186', async () => {
  const root = tmpProjectRoot({ voicePreset: 'assemblyai' }); // no ASSEMBLYAI_API_KEY
  const rawBody = Buffer.from('--boundary\r\nContent-Disposition: form-data; name="audio"\r\n\r\nFAKE-AUDIO-BYTES\r\n--boundary--');
  const backend = stubBackend({ baseUrl: 'https://api.example.com', projectId: '2', token: 'tok-abc' });

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { status: 200, text: async () => JSON.stringify({ transcript: 'from remote api' }) };
  };
  try {
    const req = fakeReq('POST', '/api/transcribe', { 'x-tipatask-project': root, 'content-type': 'multipart/form-data; boundary=boundary' }, rawBody);
    const res = await run(req, fakeRes(), backend);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.example.com/api/transcribe');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok-abc');
    assert.equal(calls[0].opts.headers['Content-Type'], 'multipart/form-data; boundary=boundary');
    assert.ok(Buffer.compare(Buffer.from(calls[0].opts.body), rawBody) === 0, 'body forwarded byte-identical');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, JSON.stringify({ transcript: 'from remote api' }));
  } finally {
    global.fetch = originalFetch;
  }
});

test('assemblyai preset with a per-project key calls AssemblyAI directly and never touches the remote Tipatask API', async () => {
  const root = tmpProjectRoot({ voicePreset: 'assemblyai', ASSEMBLYAI_API_KEY: 'proj-key-123' });
  const backend = stubBackend({ baseUrl: 'https://api.example.com', projectId: '2', token: 'tok-abc' });

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/upload')) return { status: 200, ok: true, text: async () => JSON.stringify({ upload_url: 'https://cdn.assemblyai.com/x' }) };
    if (url.endsWith('/transcript')) return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'tx-1', status: 'completed', text: 'hi there', language_code: 'en' }) };
    throw new Error(`unexpected fetch to ${url}`);
  };
  try {
    const req = fakeReq('POST', '/api/transcribe', { 'x-tipatask-project': root, 'content-type': 'application/octet-stream' }, Buffer.from('pcm-bytes'));
    const res = await run(req, fakeRes(), backend);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { transcript: 'hi there', language_code: 'en' });
    assert.ok(calls.every((u) => u.startsWith('https://api.assemblyai.com/')), `remote Tipatask API must never be called, got: ${calls.join(', ')}`);
  } finally {
    global.fetch = originalFetch;
  }
});

test('assemblyai preset with a per-project key rejects multipart bodies with 415 NEEDS_RAW_AUDIO', async () => {
  const root = tmpProjectRoot({ voicePreset: 'assemblyai', ASSEMBLYAI_API_KEY: 'proj-key-123' });
  const req = fakeReq('POST', '/api/transcribe', { 'x-tipatask-project': root, 'content-type': 'multipart/form-data; boundary=x' }, Buffer.from('x'));
  const res = await run(req, fakeRes(), stubBackend());
  assert.equal(res.statusCode, 415);
  assert.equal(JSON.parse(res.body).code, 'NEEDS_RAW_AUDIO');
});

test('assemblyai preset: a 401 from AssemblyAI maps to a distinct "check your key" message, not a generic 502', async () => {
  const root = tmpProjectRoot({ voicePreset: 'assemblyai', ASSEMBLYAI_API_KEY: 'bad-key' });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 401, ok: false, text: async () => JSON.stringify({ error: 'invalid key' }) });
  try {
    const req = fakeReq('POST', '/api/transcribe', { 'x-tipatask-project': root, 'content-type': 'application/octet-stream' }, Buffer.from('x'));
    const res = await run(req, fakeRes(), stubBackend());
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'ASSEMBLYAI_UNAUTHORIZED');
    assert.match(body.error, /check your key in Settings/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('assemblyai preset: a fetch-level network failure maps to a distinct ASSEMBLYAI_NETWORK code, not the UPSTREAM/401 mapping', async () => {
  const root = tmpProjectRoot({ voicePreset: 'assemblyai', ASSEMBLYAI_API_KEY: 'proj-key-123' });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND api.assemblyai.com'); };
  try {
    const req = fakeReq('POST', '/api/transcribe', { 'x-tipatask-project': root, 'content-type': 'application/octet-stream' }, Buffer.from('x'));
    const res = await run(req, fakeRes(), stubBackend());
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).code, 'ASSEMBLYAI_NETWORK');
  } finally {
    global.fetch = originalFetch;
  }
});

// (C1203) assemblyai-batch.js/assemblyFetch() attaches AssemblyAI's own upstream `status` to
// every non-2xx response, including a 413 the local readCappedBody 25MB cap would normally catch
// first — before the fix, that `status` won over the code->status table and answered 413 with
// `code: 'ASSEMBLYAI_UPSTREAM'`, so the client rendered the generic "Transcription service error"
// instead of voice.errTooLarge. Simulating AssemblyAI itself returning 413 (rather than relying
// on readCappedBody, which would never let a real oversize body reach this branch) is what
// isolates that mapping fix.
test('assemblyai preset: a 413 from AssemblyAI itself maps to AUDIO_TOO_LARGE, not ASSEMBLYAI_UPSTREAM', async () => {
  const root = tmpProjectRoot({ voicePreset: 'assemblyai', ASSEMBLYAI_API_KEY: 'proj-key-123' });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 413, ok: false, text: async () => JSON.stringify({ error: 'payload too large' }) });
  try {
    const req = fakeReq('POST', '/api/transcribe', { 'x-tipatask-project': root, 'content-type': 'application/octet-stream' }, Buffer.from('x'));
    const res = await run(req, fakeRes(), stubBackend());
    assert.equal(res.statusCode, 413);
    assert.equal(JSON.parse(res.body).code, 'AUDIO_TOO_LARGE');
  } finally {
    global.fetch = originalFetch;
  }
});

test('local preset rejects multipart bodies with 415 NEEDS_PCM16', async () => {
  const root = tmpProjectRoot({ voicePreset: 'local', voiceLocalModel: 'whisper-base' });
  const req = fakeReq('POST', '/api/transcribe', { 'x-tipatask-project': root, 'content-type': 'multipart/form-data; boundary=x' }, Buffer.from('x'));
  const res = await run(req, fakeRes(), stubBackend());
  assert.equal(res.statusCode, 415);
  assert.equal(JSON.parse(res.body).code, 'NEEDS_PCM16');
});

test('local preset with an unknown model id fails fast with 409 LOCAL_ASR_UNAVAILABLE, no network call', async () => {
  const root = tmpProjectRoot({ voicePreset: 'local', voiceLocalModel: 'not-a-real-model' });
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('must not be called'); };
  try {
    const req = fakeReq('POST', '/api/transcribe', { 'x-tipatask-project': root, 'content-type': 'application/octet-stream' }, Buffer.alloc(4)); // valid PCM16LE: even byte count
    const res = await run(req, fakeRes(), stubBackend());
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'LOCAL_ASR_UNAVAILABLE');
    // (C1197) reasonCode/reasonDetail let the client show which cause applies instead of one
    // generic toast — see local-asr.js's LOCAL_ASR_REASONS.
    assert.equal(body.reasonCode, 'UNKNOWN_MODEL');
    assert.deepEqual(body.reasonDetail, { model: 'not-a-real-model' });
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('local preset with a known but not-downloaded model fails with 409, pointing back to Settings > Voice', async () => {
  const root = tmpProjectRoot({ voicePreset: 'local', voiceLocalModel: 'whisper-base' });
  // voiceModelsDir (TIPATASK_VOICE_MODELS_DIR) is a fresh empty tmpdir — whisper-base is a real
  // registry entry but reports state 'missing' here, without touching the real downloaded copy.
  const req = fakeReq('POST', '/api/transcribe', { 'x-tipatask-project': root, 'content-type': 'application/octet-stream' }, Buffer.alloc(4));
  const res = await run(req, fakeRes(), stubBackend());
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.equal(body.code, 'LOCAL_ASR_UNAVAILABLE');
  assert.match(body.error, /Settings > Voice/);
  // (C1197) reasonCode/reasonDetail — model-not-downloaded carries the human label + disk state.
  assert.equal(body.reasonCode, 'MODEL_NOT_DOWNLOADED');
  assert.deepEqual(body.reasonDetail, { model: 'Whisper base (int8)', state: 'missing' });
});

test('local preset: an odd-length body (invalid PCM16) is rejected with 400 INVALID_PCM16, not a raw RangeError as a 500', async () => {
  const root = tmpProjectRoot({ voicePreset: 'local', voiceLocalModel: 'not-a-real-model' });
  const req = fakeReq('POST', '/api/transcribe', { 'x-tipatask-project': root, 'content-type': 'application/octet-stream' }, Buffer.from('pcm')); // 3 bytes, odd
  const res = await run(req, fakeRes(), stubBackend());
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, 'INVALID_PCM16');
});

test('local preset: a body over the 25MB cap is rejected with 413 before the local model is ever touched', async () => {
  const root = tmpProjectRoot({ voicePreset: 'local', voiceLocalModel: 'not-a-real-model' }); // would 409 if reached — proves 413 wins first
  const big = Buffer.alloc(25 * 1024 * 1024 + 1, 1);
  const req = fakeReq('POST', '/api/transcribe', { 'x-tipatask-project': root, 'content-type': 'application/octet-stream' }, big);
  const res = await run(req, fakeRes(), stubBackend());
  assert.equal(res.statusCode, 413);
  assert.equal(JSON.parse(res.body).code, 'AUDIO_TOO_LARGE');
});

test('multipart proxy rejects a body beyond its 25 MiB file plus framing envelope before fetch', async () => {
  const root = tmpProjectRoot({ voicePreset: 'assemblyai' });
  const backend = stubBackend({ baseUrl: 'https://api.example.com', projectId: '2', token: 'tok-abc' });
  const originalFetch = global.fetch;
  let fetched = false;
  global.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  try {
    const body = Buffer.alloc(26 * 1024 * 1024 + 1, 1);
    const req = fakeReq('POST', '/api/transcribe', {
      'x-tipatask-project': root, 'content-type': 'multipart/form-data; boundary=x',
    }, body);
    const res = await run(req, fakeRes(), backend);
    assert.equal(res.statusCode, 413);
    assert.equal(JSON.parse(res.body).code, 'AUDIO_TOO_LARGE');
    assert.equal(fetched, false);
  } finally { global.fetch = originalFetch; }
});

test('a client disconnect mid-body (req closes before end) never crashes and never writes a response', async () => {
  const root = tmpProjectRoot({ voicePreset: 'local', voiceLocalModel: 'whisper-base' });
  const req = new Readable({ read() { /* never pushes — simulates a stalled/disconnected upload */ } });
  req.method = 'POST';
  req.url = '/api/transcribe';
  req.headers = { 'x-tipatask-project': root, 'content-type': 'application/octet-stream' };
  req.complete = false;

  const res = fakeRes();
  const handlerPromise = run(req, res, stubBackend());
  // give the handler a tick to attach its listeners, then simulate the disconnect
  await new Promise((resolve) => setImmediate(resolve));
  req.destroy();
  req.emit('close');

  await handlerPromise;
  assert.equal(res.statusCode, null, 'no response should have been written for a client that already left');
});
