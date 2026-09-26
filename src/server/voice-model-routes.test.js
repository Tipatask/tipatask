'use strict';

// (C1176) GET/POST /api/voice-models[...] route coverage, using the same in-process
// createHttpHandler fixture as todo-md-route.test.js — no real HTTP server, no port 4455, no
// network. TIPATASK_VOICE_MODELS_DIR redirects voiceModelsRoot() to a throwaway temp dir so
// this never touches the real shared vendor/voice-models store. Deep download-algorithm
// behavior (resume, checksums, progress, concurrency) is covered by voice-model-manager.test.js
// against an injected fake registry — this file only proves the HTTP wiring around it.
//
// config.js snapshots process.env.TASK_BACKEND once at require time, and a dev shell may have
// something else exported — pin it so this file is deterministic. The /api/voice-models*
// routes touch no Tipatask API credentials at all; TIPATASK_VOICE_MODELS_DIR above is the
// isolation that actually matters.
process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const voiceModelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-voice-models-routes-'));
process.env.TIPATASK_VOICE_MODELS_DIR = voiceModelsDir;
test.after(() => fs.rmSync(voiceModelsDir, { recursive: true, force: true }));

const { createHttpHandler } = require('./ws-handlers');
const { VOICE_MODEL_IDS } = require('./voice-model-manager');

function fakeReq(method, url, body) {
  const req = { method, url, headers: {} };
  req[Symbol.asyncIterator] = async function* () { if (body) yield Buffer.from(body); };
  return req;
}
function fakeRes() {
  const res = {
    statusCode: null, headers: null, body: '',
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(chunk) { res.body = chunk || ''; },
  };
  return res;
}
function stubBackend() {
  return { async getTasks() { return []; }, async getChildren() { return []; } };
}
async function run(method, url, body) {
  const handler = createHttpHandler(new Map(), () => stubBackend(), null);
  const req = fakeReq(method, url, body);
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test('GET /api/voice-models: lists all three real models, all "missing" in a fresh dir', async () => {
  const res = await run('GET', '/api/voice-models');
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.deepEqual(data.models.map((m) => m.modelId).sort(), [...VOICE_MODEL_IDS].sort());
  assert.ok(data.models.every((m) => m.state === 'missing'));
  assert.equal(data.root, voiceModelsDir);
});

test('GET /api/voice-models/:id: single status for a known id', async () => {
  const res = await run('GET', '/api/voice-models/whisper-base');
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.modelId, 'whisper-base');
  assert.equal(data.state, 'missing');
});

test('GET /api/voice-models/:id: unknown id -> 404 with VOICE_MODEL_UNKNOWN', async () => {
  const res = await run('GET', '/api/voice-models/not-a-real-model');
  assert.equal(res.statusCode, 404);
  const data = JSON.parse(res.body);
  assert.equal(data.code, 'VOICE_MODEL_UNKNOWN');
});

test('POST /api/voice-models/:id/download: unknown id -> 404, no fetch attempted', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async (...args) => { fetchCalled = true; return originalFetch(...args); };
  try {
    const res = await run('POST', '/api/voice-models/not-a-real-model/download');
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).code, 'VOICE_MODEL_UNKNOWN');
    assert.equal(fetchCalled, false, 'a bad id must be rejected before any network call');
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/voice-models/:id/download: known id -> immediate 202, fire-and-forget does not throw unhandled', { timeout: 10000 }, async (t) => {
  const originalFetch = global.fetch;
  let reportError;
  const errorReported = new Promise(resolve => { reportError = resolve; });
  t.mock.method(require('./websocket'), 'emitVoiceModelError', reportError);
  // Network is mocked out entirely — this test proves the route responds correctly and the
  // background promise's rejection is swallowed by the route's own .catch(), not that a real
  // download completes (voice-model-manager.test.js already covers the real algorithm).
  global.fetch = async () => { throw new Error('mocked: no network in route tests'); };
  try {
    const res = await run('POST', '/api/voice-models/whisper-base/download', '{}');
    assert.equal(res.statusCode, 202);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.modelId, 'whisper-base');
    assert.equal(data.state, 'downloading');
    // Wait for the route's catch handler, including downloader cleanup. A fixed
    // delay can restore fetch before slow filesystem work reaches the download.
    const error = await errorReported;
    assert.equal(error.modelId, 'whisper-base');
    assert.match(error.message, /mocked: no network/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/voice-models/:id/download: malformed JSON body -> 400', async () => {
  const res = await run('POST', '/api/voice-models/whisper-base/download', '{not json');
  assert.equal(res.statusCode, 400);
});

test('POST /api/voice-models/:id/abort: nothing in flight -> aborted:false', async () => {
  const res = await run('POST', '/api/voice-models/whisper-base/abort');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, aborted: false });
});

test('DELETE /api/voice-models/:id: never-downloaded model -> 200, idempotent deleted:false', async () => {
  // parakeet-v3, not whisper-base: the POST .../download test above leaves an empty whisper-base
  // dir behind (mkdir happens before the mocked fetch throws), so whisper-base is no longer a
  // clean "never touched" fixture by the time this test runs.
  const res = await run('DELETE', '/api/voice-models/parakeet-v3');
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.equal(data.modelId, 'parakeet-v3');
  assert.equal(data.deleted, false);
  assert.equal(data.freedBytes, 0);
});

test('DELETE /api/voice-models/:id: unknown id -> 404 VOICE_MODEL_UNKNOWN', async () => {
  const res = await run('DELETE', '/api/voice-models/not-a-real-model');
  assert.equal(res.statusCode, 404);
  const data = JSON.parse(res.body);
  assert.equal(data.code, 'VOICE_MODEL_UNKNOWN');
});

test('DELETE /api/voice-models: collection (no id) -> 405', async () => {
  const res = await run('DELETE', '/api/voice-models');
  assert.equal(res.statusCode, 405);
});
