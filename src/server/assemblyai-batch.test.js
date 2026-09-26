'use strict';

// (C1186) Unit tests for the direct AssemblyAI batch client — every test injects a fake
// fetchImpl, no real network. Mirrors the fake-fixture idiom in voice-model-manager.test.js.

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const { transcribeWithAssemblyAI, AssemblyAiError, ASSEMBLYAI_ERRORS, MAX_AUDIO_BYTES, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } = require('./assemblyai-batch');

function jsonRes(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

test('transcribeWithAssemblyAI: cloud punctuation/casing passes through both completion paths unchanged', async () => {
  const text = 'iPhone works, right? Yes! "All done."';
  for (const immediately of [true, false]) {
    const completed = { id: 'tx', status: 'completed', text, language_code: 'en' };
    const fetchImpl = async (url) => {
      if (url.endsWith('/upload')) return jsonRes(200, { upload_url: 'audio' });
      if (url.endsWith('/transcript')) return jsonRes(200, immediately ? completed : { id: 'tx', status: 'queued' });
      return jsonRes(200, completed);
    };
    assert.deepEqual(await transcribeWithAssemblyAI(Buffer.from('audio'), { apiKey: 'test', fetchImpl }), {
      transcript: text, language_code: 'en',
    });
  }
});

test('transcribeWithAssemblyAI: happy path — upload, create, poll until completed, no Bearer prefix', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, auth: opts.headers.Authorization, contentType: opts.headers['Content-Type'] });
    if (url.endsWith('/upload')) return jsonRes(200, { upload_url: 'https://cdn.assemblyai.com/upload/abc' });
    if (url.endsWith('/transcript')) return jsonRes(200, { id: 'tx-1', status: 'queued' });
    if (url.endsWith('/transcript/tx-1')) return jsonRes(200, { id: 'tx-1', status: 'completed', text: 'hello world', language_code: 'en' });
    throw new Error(`unexpected url ${url}`);
  };

  const result = await transcribeWithAssemblyAI(Buffer.from('fake-audio-bytes'), { apiKey: 'proj-key-123', fetchImpl });

  assert.deepEqual(result, { transcript: 'hello world', language_code: 'en' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.assemblyai.com/v2/upload');
  assert.equal(calls[0].contentType, 'application/octet-stream');
  assert.equal(calls[1].url, 'https://api.assemblyai.com/v2/transcript');
  assert.equal(calls[2].method, 'GET');
  // no "Bearer " prefix anywhere — AssemblyAI takes the raw key
  for (const c of calls) assert.equal(c.auth, 'proj-key-123');
});

test('transcribeWithAssemblyAI: an immediately-completed transcript skips polling entirely', async () => {
  let pollCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/upload')) return jsonRes(200, { upload_url: 'https://cdn.assemblyai.com/upload/abc' });
    if (url.endsWith('/transcript')) return jsonRes(200, { id: 'tx-1', status: 'completed', text: 'fast', language_code: 'en' });
    pollCalls++;
    throw new Error('should never poll');
  };
  const result = await transcribeWithAssemblyAI(Buffer.from('x'), { apiKey: 'k', fetchImpl });
  assert.equal(result.transcript, 'fast');
  assert.equal(pollCalls, 0);
});

test('transcribeWithAssemblyAI: 401 maps to AssemblyAiError with UNAUTHORIZED code', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/upload')) return jsonRes(401, { error: 'invalid api key' });
    throw new Error('should not reach transcript step');
  };
  await assert.rejects(
    () => transcribeWithAssemblyAI(Buffer.from('x'), { apiKey: 'bad-key', fetchImpl }),
    (err) => {
      assert.ok(err instanceof AssemblyAiError);
      assert.equal(err.code, ASSEMBLYAI_ERRORS.UNAUTHORIZED);
      return true;
    },
  );
});

test('transcribeWithAssemblyAI: 403 also maps to UNAUTHORIZED (not a generic upstream error)', async () => {
  const fetchImpl = async () => jsonRes(403, { error: 'forbidden' });
  await assert.rejects(
    () => transcribeWithAssemblyAI(Buffer.from('x'), { apiKey: 'k', fetchImpl }),
    (err) => err.code === ASSEMBLYAI_ERRORS.UNAUTHORIZED,
  );
});

test('transcribeWithAssemblyAI: transcript status "error" maps to UPSTREAM with the AssemblyAI message', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/upload')) return jsonRes(200, { upload_url: 'u' });
    if (url.endsWith('/transcript')) return jsonRes(200, { id: 'tx-1', status: 'queued' });
    return jsonRes(200, { id: 'tx-1', status: 'error', error: 'unsupported codec' });
  };
  await assert.rejects(
    () => transcribeWithAssemblyAI(Buffer.from('x'), { apiKey: 'k', fetchImpl }),
    (err) => {
      assert.equal(err.code, ASSEMBLYAI_ERRORS.UPSTREAM);
      assert.match(err.message, /unsupported codec/);
      return true;
    },
  );
});

test('transcribeWithAssemblyAI: missing upload_url in the /upload response is UPSTREAM, not a crash', async () => {
  const fetchImpl = async () => jsonRes(200, {});
  await assert.rejects(
    () => transcribeWithAssemblyAI(Buffer.from('x'), { apiKey: 'k', fetchImpl }),
    (err) => err.code === ASSEMBLYAI_ERRORS.UPSTREAM,
  );
});

test('transcribeWithAssemblyAI: empty audio buffer rejects without ever calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return jsonRes(200, {}); };
  await assert.rejects(() => transcribeWithAssemblyAI(Buffer.alloc(0), { apiKey: 'k', fetchImpl }));
  assert.equal(called, false);
});

test('transcribeWithAssemblyAI: oversize buffer rejects without ever calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return jsonRes(200, {}); };
  const big = Buffer.alloc(MAX_AUDIO_BYTES + 1);
  await assert.rejects(() => transcribeWithAssemblyAI(big, { apiKey: 'k', fetchImpl }));
  assert.equal(called, false);
});

test('transcribeWithAssemblyAI: missing apiKey rejects without ever calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return jsonRes(200, {}); };
  await assert.rejects(() => transcribeWithAssemblyAI(Buffer.from('x'), { apiKey: '', fetchImpl }));
  assert.equal(called, false);
});

test('transcribeWithAssemblyAI: caller signal aborting mid-poll rejects with ABORTED, stops polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const controller = new AbortController();
  let pollCount = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/upload')) return jsonRes(200, { upload_url: 'u' });
    if (url.endsWith('/transcript')) return jsonRes(200, { id: 'tx-1', status: 'queued' });
    pollCount++;
    if (pollCount === 1) controller.abort();
    return jsonRes(200, { id: 'tx-1', status: 'processing' });
  };
  const resultPromise = transcribeWithAssemblyAI(Buffer.from('x'), { apiKey: 'k', fetchImpl, signal: controller.signal });
  let settled = false;
  resultPromise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 50 && !settled; i++) await t.mock.timers.tick(POLL_INTERVAL_MS);

  await assert.rejects(() => resultPromise, (err) => err.code === ASSEMBLYAI_ERRORS.ABORTED);
  assert.ok(pollCount <= 2, `expected polling to stop quickly after abort, got ${pollCount} polls`);
});

test('transcribeWithAssemblyAI: network failure (fetch throws) maps to NETWORK, not a raw throw', async () => {
  const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  await assert.rejects(
    () => transcribeWithAssemblyAI(Buffer.from('x'), { apiKey: 'k', fetchImpl }),
    (err) => err.code === ASSEMBLYAI_ERRORS.NETWORK,
  );
});

test('transcribeWithAssemblyAI: poll timeout fires after POLL_TIMEOUT_MS of "processing" (mocked clock)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fetchImpl = async (url) => {
    if (url.endsWith('/upload')) return jsonRes(200, { upload_url: 'u' });
    if (url.endsWith('/transcript')) return jsonRes(200, { id: 'tx-1', status: 'queued' });
    return jsonRes(200, { id: 'tx-1', status: 'processing' });
  };
  const resultPromise = transcribeWithAssemblyAI(Buffer.from('x'), { apiKey: 'k', fetchImpl });
  let settled = false;
  resultPromise.then(() => { settled = true; }, () => { settled = true; });
  // Advance in POLL_INTERVAL_MS steps, one tick per outstanding sleep() timer, until the promise
  // settles — a fixed iteration count assumes a tick lands exactly when the timer is registered,
  // which races against microtask draining; polling `settled` after each `await tick()` instead
  // is robust to that. Safety cap well past POLL_TIMEOUT_MS/POLL_INTERVAL_MS (=90) in case of a bug.
  for (let i = 0; i < 200 && !settled; i++) await t.mock.timers.tick(POLL_INTERVAL_MS);

  await assert.rejects(() => resultPromise, (err) => err.code === ASSEMBLYAI_ERRORS.POLL_TIMEOUT);
});
