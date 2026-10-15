'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const zlib = require('node:zlib');
const { request, MAX_RESPONSE_BYTES } = require('./http');

function fakeTransport(t, statusCode = 200, headers = {}) {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  req.write = () => {};
  req.end = () => {};
  req.destroy = () => { req.destroyed = true; };
  res.destroy = () => { res.destroyed = true; };
  let respond;
  t.mock.method(http, 'request', (_options, callback) => {
    respond = () => callback(res);
    return req;
  });
  return { req, res, respond: () => respond() };
}

function assertClean({ req, res }, signal) {
  // One listener stays on the request: the sink that absorbs Node's deferred post-destroy() error.
  assert.equal(req.listenerCount('error'), 1);
  for (const event of ['data', 'end', 'error', 'aborted', 'close']) {
    assert.equal(res.listenerCount(event), 0, `${event} listener removed`);
  }
  if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0);
}

test('partial JSON followed by response abort rejects and cleans up once', async (t) => {
  const fake = fakeTransport(t);
  const controller = new AbortController();
  const pending = request('http://example.test/tasks', { signal: controller.signal });
  fake.respond();
  fake.res.emit('data', Buffer.from('{"tasks":'));
  fake.res.emit('aborted');
  fake.res.emit('close');
  await assert.rejects(pending, { code: 'ECONNRESET' });
  assert.equal(fake.req.destroyed, true);
  assert.equal(fake.res.destroyed, true);
  assertClean(fake, controller.signal);
});

test('response errors retain their code and cause', async (t) => {
  const fake = fakeTransport(t);
  const pending = request('http://example.test/tasks');
  fake.respond();
  const original = Object.assign(new Error('stream failed'), { code: 'EPIPE' });
  fake.res.emit('error', original);
  await assert.rejects(pending, (err) => {
    assert.equal(err.code, 'EPIPE');
    assert.equal(err.cause, original);
    return true;
  });
  assertClean(fake);
});

test('response close without end rejects even after complete JSON bytes', async (t) => {
  const fake = fakeTransport(t);
  const pending = request('http://example.test/tasks');
  fake.respond();
  fake.res.emit('data', Buffer.from('{}'));
  fake.res.emit('close');
  await assert.rejects(pending, { code: 'ECONNRESET' });
  assertClean(fake);
});

test('end with an incomplete HTTP message rejects instead of parsing partial text', async (t) => {
  const fake = fakeTransport(t);
  const pending = request('http://example.test/tasks');
  fake.respond();
  fake.res.complete = false;
  fake.res.emit('data', Buffer.from('{"partial":'));
  fake.res.emit('end');
  await assert.rejects(pending, { code: 'ECONNRESET' });
  assertClean(fake);
});

test('normal end keeps JSON and HTTP status shapes', async (t) => {
  const fake = fakeTransport(t, 400);
  const pending = request('http://example.test/tasks');
  fake.respond();
  fake.res.emit('data', Buffer.from('{"error":'));
  fake.res.emit('data', Buffer.from('"bad request"}'));
  fake.res.emit('end');
  fake.res.emit('close');
  assert.deepEqual(await pending, { status: 400, data: { error: 'bad request' } });
  assertClean(fake);
});

test('non-JSON response keeps the existing plain-text fallback', async (t) => {
  const fake = fakeTransport(t, 503);
  const pending = request('http://example.test/tasks');
  fake.respond();
  fake.res.emit('data', 'temporarily unavailable');
  fake.res.emit('end');
  assert.deepEqual(await pending, { status: 503, data: 'temporarily unavailable' });
  assertClean(fake);
});

test('real socket disconnect after headers rejects without an unhandled response error', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': 100 });
    res.write('{"partial":');
    setImmediate(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(
    request(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 1000 }),
    { code: 'ECONNRESET' },
  );
});

test('delayed chunks complete within the total deadline', async (t) => {
  const fake = fakeTransport(t);
  const pending = request('http://example.test/tasks', { timeoutMs: 1000 });
  fake.respond();
  fake.res.emit('data', '{"ok":');
  await new Promise((resolve) => setTimeout(resolve, 15));
  fake.res.emit('data', 'true}');
  fake.res.emit('end');
  assert.deepEqual(await pending, { status: 200, data: { ok: true } });
  assertClean(fake);
});

test('slow trickles cannot extend the total deadline', async (t) => {
  const fake = fakeTransport(t);
  const pending = request('http://example.test/tasks', { timeoutMs: 40 });
  fake.respond();
  const trickle = setInterval(() => fake.res.emit('data', Buffer.from('x')), 5);
  t.after(() => clearInterval(trickle));
  await assert.rejects(pending, { code: 'ETIMEDOUT' });
  clearInterval(trickle);
  assert.equal(fake.req.destroyed, true);
  assertClean(fake);
});

test('request-level failures retain their code and cause', async (t) => {
  const fake = fakeTransport(t);
  const pending = request('http://example.test/tasks');
  const original = Object.assign(new Error('host unavailable'), { code: 'EHOSTUNREACH' });
  fake.req.emit('error', original);
  await assert.rejects(pending, (err) => {
    assert.equal(err.code, 'EHOSTUNREACH');
    assert.equal(err.cause, original);
    return true;
  });
  assertClean(fake);
});

// Node emits a deferred "socket hang up" (ECONNRESET) on a request that was destroy()ed before any
// response arrived. It lands on a later tick, after the call already settled — with no 'error'
// listener left, EventEmitter throws it and the whole process dies.
const lateHangUp = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

test('late request error after a deadline settle is absorbed, not thrown', async (t) => {
  const fake = fakeTransport(t);
  await assert.rejects(request('http://example.test/tasks', { timeoutMs: 20 }), { code: 'ETIMEDOUT' });
  assert.doesNotThrow(() => fake.req.emit('error', lateHangUp()));
});

test('late request error after a caller abort is absorbed, not thrown', async (t) => {
  const fake = fakeTransport(t);
  const controller = new AbortController();
  const pending = request('http://example.test/tasks', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'EABORT' });
  assert.doesNotThrow(() => fake.req.emit('error', lateHangUp()));
});

test('real socket: deadline before any response rejects ETIMEDOUT and the late hang-up stays contained', async (t) => {
  const sockets = new Set();
  const server = http.createServer(() => { /* accept, never respond */ });
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(
    request(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 50 }),
    { code: 'ETIMEDOUT' },
  );
  // Let the client's destroy() propagate to the server side, then a few ticks for the deferred emit.
  await Promise.all([...sockets].map((s) => (s.destroyed ? null : new Promise((resolve) => s.once('close', resolve)))));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test('real socket: server resets the connection mid-request and the call rejects with ECONNRESET', async (t) => {
  const server = http.createServer((req) => req.socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(
    request(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 1000 }),
    (err) => {
      assert.equal(err.code, 'ECONNRESET');
      assert.ok(err.cause, 'original socket error kept as cause');
      return true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test('caller abort settles an active response and removes the signal listener', async (t) => {
  const fake = fakeTransport(t);
  const controller = new AbortController();
  const pending = request('http://example.test/tasks', { signal: controller.signal });
  fake.respond();
  controller.abort();
  await assert.rejects(pending, { code: 'EABORT' });
  assertClean(fake, controller.signal);
});

test('response body limit rejects without buffering more data', async (t) => {
  const fake = fakeTransport(t);
  const pending = request('http://example.test/tasks');
  fake.respond();
  fake.res.emit('data', Buffer.alloc(MAX_RESPONSE_BYTES + 1));
  await assert.rejects(pending, { code: 'ERR_RESPONSE_TOO_LARGE' });
  assert.equal(fake.req.destroyed, true);
  assertClean(fake);
});

test('requests ask for gzip or deflate unless the caller sets Accept-Encoding', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ acceptEncoding: req.headers['accept-encoding'] ?? null }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  assert.deepEqual(
    await request(url, { timeoutMs: 1000 }),
    { status: 200, data: { acceptEncoding: 'gzip, deflate' } },
  );
  // Header names are case-insensitive: a lower-case caller header replaces the default.
  assert.deepEqual(
    await request(url, { headers: { 'accept-encoding': 'identity' }, timeoutMs: 1000 }),
    { status: 200, data: { acceptEncoding: 'identity' } },
  );
});

test('real socket: a gzip-encoded JSON body is decoded before parsing', async (t) => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `TPT${i}`, title: `Task ${i}`, status: 'pending' }));
  const body = zlib.gzipSync(JSON.stringify({ tasks: rows }));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    const half = Math.floor(body.length / 2);
    res.write(body.subarray(0, half));
    setImmediate(() => res.end(body.subarray(half)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  // Node closes the response before the decoder flushes; that close must not read as a cut-off reply.
  assert.deepEqual(
    await request(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 2000 }),
    { status: 200, data: { tasks: rows } },
  );
});

test('a deflate-encoded body is decoded even when the response closes before the decoder flushes', async (t) => {
  const fake = fakeTransport(t, 200, { 'content-encoding': 'deflate' });
  const body = zlib.deflateSync(JSON.stringify({ ok: true, items: [1, 2, 3] }));
  const pending = request('http://example.test/tasks');
  fake.respond();
  fake.res.emit('data', body.subarray(0, 5));
  fake.res.emit('data', body.subarray(5));
  fake.res.emit('end');
  fake.res.emit('close');
  assert.deepEqual(await pending, { status: 200, data: { ok: true, items: [1, 2, 3] } });
  assertClean(fake);
});

test('the response body limit counts decoded bytes, not compressed ones', async (t) => {
  const fake = fakeTransport(t, 200, { 'content-encoding': 'gzip' });
  const pending = request('http://example.test/tasks');
  fake.respond();
  // About 32 KB on the wire, one byte over the limit once inflated.
  fake.res.emit('data', zlib.gzipSync(Buffer.alloc(MAX_RESPONSE_BYTES + 1)));
  fake.res.emit('end');
  await assert.rejects(pending, { code: 'ERR_RESPONSE_TOO_LARGE' });
  assert.equal(fake.req.destroyed, true);
  assert.equal(fake.res.destroyed, true);
  assertClean(fake);
});

test('a corrupt gzip body rejects with the zlib error and leaves no uncaught error', async (t) => {
  const fake = fakeTransport(t, 200, { 'content-encoding': 'gzip' });
  const pending = request('http://example.test/tasks');
  fake.respond();
  fake.res.emit('data', Buffer.from('{"tasks":[]} is not gzip'));
  fake.res.emit('end');
  fake.res.emit('close');
  await assert.rejects(pending, (err) => {
    assert.equal(err.code, 'Z_DATA_ERROR');
    assert.equal(err.cause.code, 'Z_DATA_ERROR');
    return true;
  });
  assert.equal(fake.res.destroyed, true);
  assertClean(fake);
  // A decoder 'error' emitted after the call settled would surface here as an uncaught exception.
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test('a bodyless reply that names a content coding resolves like a plain empty body', async (t) => {
  const fake = fakeTransport(t, 204, { 'content-encoding': 'gzip' });
  const pending = request('http://example.test/tasks');
  fake.respond();
  fake.res.emit('end');
  fake.res.emit('close');
  assert.deepEqual(await pending, { status: 204, data: '' });
  assertClean(fake);
});

test('caller abort mid-decode settles once and leaves no late decoder error', async (t) => {
  const fake = fakeTransport(t, 200, { 'content-encoding': 'gzip' });
  const controller = new AbortController();
  const body = zlib.gzipSync(JSON.stringify({ tasks: Array.from({ length: 1000 }, (_, i) => i) }));
  const pending = request('http://example.test/tasks', { signal: controller.signal });
  fake.respond();
  fake.res.emit('data', body.subarray(0, Math.floor(body.length / 2)));
  controller.abort();
  await assert.rejects(pending, { code: 'EABORT' });
  assert.equal(fake.res.destroyed, true);
  assertClean(fake, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
});
