'use strict';

// Exercise the real HTTP parser and socket lifecycle; no Task App port, API, or DB is used.
process.env.TASK_BACKEND = 'api';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-http-body-'));
process.env.TIPATASK_PROJECT_ROOT = scratch;
process.env.TIPATASK_USER_DATA = scratch;
const { createHttpHandler } = require('./ws-handlers');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function backendWithWrites() {
  const writes = { comments: 0, images: 0, files: 0 };
  return {
    writes,
    createTaskComment: async () => { writes.comments++; return { id: 1 }; },
    uploadImage: async () => { writes.images++; return { id: 1, url: '/image/1' }; },
    uploadFile: async () => { writes.files++; return { id: 1, url: '/file/1', filename: 'a.txt', size_bytes: 1 }; },
  };
}

async function startServer(backend) {
  const server = http.createServer(createHttpHandler(new Map(), () => backend));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function request(port, method, route, body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route,
      headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function openRaw(port, initial) {
  const socket = net.connect(port, '127.0.0.1');
  let output = '';
  const response = new Promise((resolve, reject) => {
    socket.setTimeout(5000, () => socket.destroy(new Error('raw request timed out')));
    socket.on('data', (chunk) => { output += chunk.toString('utf8'); });
    socket.on('end', () => resolve(output));
    socket.on('close', () => { if (output) resolve(output); });
    socket.on('error', (err) => { if (output) resolve(output); else reject(err); });
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(initial);
  return { socket, response };
}

test('declared oversized body gets an early 413 without sending bytes or creating a comment', async () => {
  const backend = backendWithWrites();
  const { server, port } = await startServer(backend);
  try {
    const { response } = await openRaw(port,
      'POST /api/tasks/TPT1/comments HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2097153\r\nConnection: close\r\n\r\n');
    const raw = await response;
    assert.match(raw, /^HTTP\/1\.1 413 /);
    assert.match(raw, /BODY_TOO_LARGE/);
    assert.equal(backend.writes.comments, 0);
    assert.equal((await request(port, 'GET', '/api/sessions')).status, 200);
  } finally { await closeServer(server); }
});

test('unfinished chunked upload is rejected while a second client stays responsive', async () => {
  const backend = backendWithWrites();
  const { server, port } = await startServer(backend);
  try {
    const { socket, response } = await openRaw(port,
      'POST /api/tasks/TPT1/comments HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n');
    const first = Buffer.alloc(1024 * 1024, 0x20);
    socket.write(`${first.length.toString(16)}\r\n`);
    socket.write(first);
    socket.write('\r\n');
    assert.equal((await request(port, 'GET', '/api/sessions')).status, 200);
    const second = Buffer.alloc(1024 * 1024 + 1, 0x20);
    socket.write(`${second.length.toString(16)}\r\n`);
    socket.write(second);
    socket.write('\r\n'); // no terminating zero chunk
    const raw = await response;
    assert.match(raw, /^HTTP\/1\.1 413 /);
    assert.match(raw, /BODY_TOO_LARGE/);
    assert.equal(backend.writes.comments, 0);
  } finally { await closeServer(server); }
});

test('streamed bytes override a dishonest small Content-Length', async () => {
  const backend = backendWithWrites();
  const req = Readable.from([Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)]);
  req.method = 'POST';
  req.url = '/api/tasks/TPT1/comments';
  req.headers = { 'content-length': '1' };
  const events = new EventEmitter();
  const res = {
    writableEnded: false,
    status: null,
    body: '',
    once: events.once.bind(events),
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; this.writableEnded = true; events.emit('finish'); },
  };
  await createHttpHandler(new Map(), () => backend)(req, res);
  assert.equal(res.status, 413);
  assert.equal(JSON.parse(res.body).code, 'BODY_TOO_LARGE');
  assert.equal(backend.writes.comments, 0);
});

test('aborted JSON request never reaches its mutation', async () => {
  const backend = backendWithWrites();
  const req = new Readable({ read() {} });
  req.method = 'POST';
  req.url = '/api/tasks/TPT1/comments';
  req.headers = {};
  req.complete = false;
  const res = { writableEnded: false, writeHead() { throw new Error('no response after disconnect'); }, end() { throw new Error('no response after disconnect'); } };
  const handling = createHttpHandler(new Map(), () => backend)(req, res);
  req.push('{"content":');
  req.destroy();
  await handling;
  assert.equal(backend.writes.comments, 0);
});

test('chat and image routes reject declared over-limit envelopes before mutation', async () => {
  const backend = backendWithWrites();
  const { server, port } = await startServer(backend);
  try {
    assert.equal((await request(port, 'POST', '/api/objective/chat-draft',
      JSON.stringify({ messages: [{ role: 'user', content: 'prior draft' }] }))).status, 200);
    assert.equal((await request(port, 'PUT', '/api/chat-state',
      JSON.stringify({ messages: ['prior state'] }))).status, 200);
    for (const [method, route, size] of [
      ['POST', '/api/images', 15 * 1024 * 1024 + 1],
      ['POST', '/api/objective/chat-draft', 32 * 1024 * 1024 + 1],
      ['PUT', '/api/chat-state', 32 * 1024 * 1024 + 1],
      ['POST', '/api/files', 1_600_001],
    ]) {
      const { response } = await openRaw(port,
        `${method} ${route} HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${size}\r\nConnection: close\r\n\r\n`);
      assert.match(await response, /^HTTP\/1\.1 413 /, route);
    }
    assert.equal(backend.writes.images, 0);
    assert.equal(backend.writes.files, 0);
    assert.equal(JSON.parse((await request(port, 'GET', '/api/objective/chat-draft')).body).messages[0].content, 'prior draft');
    assert.deepEqual(JSON.parse((await request(port, 'GET', '/api/chat-state')).body).messages, ['prior state']);
  } finally { await closeServer(server); }
});

test('multi-megabyte chat and supported attachment envelopes still succeed', async () => {
  const backend = backendWithWrites();
  const { server, port } = await startServer(backend);
  try {
    const text = 'x'.repeat(3 * 1024 * 1024);
    const draft = JSON.stringify({ messages: [{ role: 'user', content: text }], taskId: 'TPT1' });
    assert.equal((await request(port, 'POST', '/api/objective/chat-draft', draft)).status, 200);
    assert.equal((await request(port, 'PUT', '/api/chat-state', JSON.stringify({ messages: [text] }))).status, 200);

    const image = JSON.stringify({ filename: 'a.png', mimeType: 'image/png', data: 'A'.repeat(13_600_000) });
    assert.equal((await request(port, 'POST', '/api/images', image)).status, 201);
    const file = JSON.stringify({ filename: 'a.txt', mimeType: 'text/plain', data: 'A'.repeat(1_390_000) });
    assert.equal((await request(port, 'POST', '/api/files', file)).status, 201);
    assert.equal(backend.writes.images, 1);
    assert.equal(backend.writes.files, 1);
  } finally { await closeServer(server); }
});
