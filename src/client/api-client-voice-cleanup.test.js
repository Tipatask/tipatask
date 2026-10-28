import { test } from 'node:test';
import assert from 'node:assert/strict';

// (TPT9157) api.cleanupVoiceTranscript(): Thank You mode's cleanup call. It resolves to the
// cleaned text, and to the raw text on any HTTP error, a missing answer or an unusable body.

const RAW = 'um so fix the the login bug thank you';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// api-client.js picks its transport when it loads, so each window shape gets its own module
// instance (a distinct import specifier).
async function withFetch(fetchImpl, fn, win = {}, instance = 'browser') {
  const oldFetch = globalThis.fetch;
  globalThis.window = win;
  globalThis.location = { search: '?projectPath=%2Fprojects%2Fdemo' };
  globalThis.fetch = fetchImpl;
  try {
    const { api } = await import(`./api-client.js?tpt9157-voice-cleanup-${instance}`);
    return await fn(api);
  } finally {
    globalThis.fetch = oldFetch;
    delete globalThis.window;
    delete globalThis.location;
  }
}

test('cleanupVoiceTranscript posts the text and language and resolves to the cleaned text', async () => {
  const calls = [];
  const text = await withFetch(async (url, opts) => {
    calls.push({ url, opts });
    return jsonResponse(200, { text: 'Fix the login bug.', cleaned: true });
  }, (api) => api.cleanupVoiceTranscript(RAW, 'uk'));
  assert.equal(text, 'Fix the login bug.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/voice/cleanup');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].opts.headers['x-tipatask-project'], '/projects/demo');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { text: RAW, language: 'uk' });
});

test('cleanupVoiceTranscript resolves to the raw text on any HTTP error', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const status of [400, 401, 403, 404, 413, 500, 502, 503, 504]) {
    const text = await withFetch(async () => jsonResponse(status, { error: 'nope', code: 'X' }),
      (api) => api.cleanupVoiceTranscript(RAW, 'en'));
    assert.equal(text, RAW, `HTTP ${status}`);
  }
  const noJsonBody = await withFetch(async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError('Unexpected token'); } }),
    (api) => api.cleanupVoiceTranscript(RAW, 'en'));
  assert.equal(noJsonBody, RAW);
});

test('cleanupVoiceTranscript resolves to the raw text when no answer arrives or the body is unusable', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const failures = [
    async () => { throw new TypeError('Failed to fetch'); },
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } }),
    async () => jsonResponse(200, { text: '', cleaned: false }),
    async () => jsonResponse(200, { text: '   ', cleaned: true }),
    async () => jsonResponse(200, { text: 42 }),
    async () => jsonResponse(200, null),
  ];
  for (const fetchImpl of failures) {
    assert.equal(await withFetch(fetchImpl, (api) => api.cleanupVoiceTranscript(RAW, 'en')), RAW);
  }
});

test('cleanupVoiceTranscript uses a direct fetch in the Electron renderer too', async () => {
  let fetched = 0;
  const text = await withFetch(async () => { fetched++; return jsonResponse(200, { text: 'Fix it.', cleaned: true }); },
    (api) => api.cleanupVoiceTranscript(RAW, 'en'),
    { electronAPI: { api: { tasks: {} } } }, 'electron');
  assert.equal(text, 'Fix it.');
  assert.equal(fetched, 1);
});
