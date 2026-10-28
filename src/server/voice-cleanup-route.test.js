'use strict';

// TPT9157 — POST /api/voice/cleanup HTTP wiring through createHttpHandler, the same in-process
// fixture as transcribe-route.test.js: no real server, no port 4455, no network. The one-shot
// runner is mocked on providers/one-shot.js itself, which voice-cleanup.js reads at call time.
process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');

const oneShot = require('./providers/one-shot');
const { createHttpHandler } = require('./ws-handlers');

const RAW = 'um so fix the the login bug thank you';
const PROJECT = '/projects/voice-cleanup-route-test';

function fakeReq(body, headers = {}) {
  const chunks = body == null ? [] : [Buffer.from(body)];
  const req = new Readable({ read() { this.push(chunks.length ? chunks.shift() : null); } });
  req.method = 'POST';
  req.url = '/api/voice/cleanup';
  req.headers = { 'content-type': 'application/json', 'x-tipatask-project': PROJECT, ...headers };
  req.complete = false;
  req.on('end', () => { req.complete = true; });
  return req;
}

function fakeRes() {
  const emitter = new EventEmitter();
  const res = {
    statusCode: null,
    body: '',
    writableEnded: false,
    writeHead(status) { res.statusCode = status; },
    end(chunk) { res.body = chunk || ''; res.writableEnded = true; emitter.emit('finish'); },
    on: (...a) => emitter.on(...a),
    once: (...a) => emitter.once(...a),
    removeListener: (...a) => emitter.removeListener(...a),
    emitClose: () => emitter.emit('close'),
  };
  return res;
}

async function post(body, headers) {
  const res = fakeRes();
  const backend = { async getTasks() { return []; } };
  await createHttpHandler(new Map(), () => backend, null)(fakeReq(body, headers), res);
  return res;
}

test('POST /api/voice/cleanup answers 200 with the cleaned text from a tool-less one-shot run', async (t) => {
  const calls = [];
  t.mock.method(oneShot, 'runOneShotPrompt', async (prompt, opts) => { calls.push({ prompt, opts }); return 'Fix the login bug.'; });
  const res = await post(JSON.stringify({ text: RAW, language: 'uk' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { text: 'Fix the login bug.', cleaned: true });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes(RAW));
  assert.match(calls[0].prompt, /Ukrainian \(uk\)/);
  assert.equal(calls[0].opts.toolless, true);
  assert.equal(calls[0].opts.projectRoot, PROJECT);
  assert.equal(calls[0].opts.timeoutMs, 60_000);
});

test('POST /api/voice/cleanup answers 200 with the raw text when the runner fails', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const failure of [async () => { throw new Error('boom'); }, async () => null, async () => '  ']) {
    t.mock.method(oneShot, 'runOneShotPrompt', failure);
    const res = await post(JSON.stringify({ text: RAW }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { text: RAW, cleaned: false });
  }
});

test('POST /api/voice/cleanup rejects a body over 32 KB with 413 and never runs the model', async (t) => {
  const runner = t.mock.method(oneShot, 'runOneShotPrompt', async () => 'x');
  const res = await post(JSON.stringify({ text: 'a'.repeat(32 * 1024) }));
  assert.equal(res.statusCode, 413);
  assert.equal(JSON.parse(res.body).code, 'TRANSCRIPT_TOO_LARGE');
  assert.equal(runner.mock.callCount(), 0);
});

test('POST /api/voice/cleanup answers 400 for invalid JSON or a missing text field', async (t) => {
  const runner = t.mock.method(oneShot, 'runOneShotPrompt', async () => 'x');
  const invalid = await post('{not json');
  assert.equal(invalid.statusCode, 400);
  for (const body of [{}, { text: 42 }, null, ['text']]) {
    const res = await post(JSON.stringify(body));
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(JSON.parse(res.body).code, 'INVALID_TEXT');
  }
  assert.equal(runner.mock.callCount(), 0);
});

test('POST /api/voice/cleanup writes nothing once the client has gone', async (t) => {
  let release;
  t.mock.method(oneShot, 'runOneShotPrompt', () => new Promise((resolve) => { release = resolve; }));
  const res = fakeRes();
  const backend = { async getTasks() { return []; } };
  const done = createHttpHandler(new Map(), () => backend, null)(fakeReq(JSON.stringify({ text: RAW })), res);
  for (let i = 0; !release && i < 1000; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release, 'the cleanup reached the runner');
  res.emitClose();
  release('Fix the login bug.');
  await done;
  assert.equal(res.statusCode, null);
  assert.equal(res.writableEnded, false);
});
