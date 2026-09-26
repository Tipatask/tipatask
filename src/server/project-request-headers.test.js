'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { installProjectRequestHeaders } = require('../../main/project-request-headers');
const { electronCapability } = require('./local-access');

const SECRET = 'test-only-secret';

function installedHandler(projectDirs, port = 4455) {
  let handler;
  const session = { webRequest: { onBeforeSendHeaders(fn) { handler = fn; } } };
  installProjectRequestHeaders(session, { projectDirs, port, secret: SECRET, log: () => {} });
  assert.equal(typeof handler, 'function');
  return (url, webContentsId, requestHeaders = {}) => {
    let result;
    handler({ url, webContentsId, requestHeaders }, (value) => { result = value.requestHeaders; });
    assert.ok(result, 'the Electron request callback must run');
    return result;
  };
}

function assertNoProjectHeaders(headers) {
  assert.equal(Object.keys(headers).some((name) =>
    ['x-tiptask-project-path', 'x-tipatask-project', 'x-tipatask-capability'].includes(name.toLowerCase())), false);
}

test('local HTTP and WebSocket requests receive only their own window project', () => {
  const request = installedHandler(new Map([[11, '/projects/alpha'], [22, '/projects/beta']]));
  for (const [url, id, expected] of [
    ['http://localhost:4455/todo.html', 11, '/projects/alpha'],
    ['http://localhost:4455/api/trello/cards', 22, '/projects/beta'],
    ['ws://localhost:4455/?taskId=TPT320', 11, '/projects/alpha'],
    ['ws://localhost:4455/?taskId=TPT320', 22, '/projects/beta'],
    ['http://127.0.0.1:4455/todo.html', 11, '/projects/alpha'],
    ['ws://127.0.0.1:4455/?taskId=TPT320', 22, '/projects/beta'],
  ]) {
    const headers = request(url, id, { Accept: '*/*' });
    assert.equal(headers['x-tipatask-capability'], electronCapability(SECRET, expected));
    assert.equal(headers['X-TipTask-Project-Path'], expected);
    assert.equal(headers['x-tipatask-project'], expected);
    assert.equal(headers.Accept, '*/*');
  }
});

test('only the configured localhost port can receive project headers', () => {
  const request = installedHandler(new Map([[11, '/projects/alpha']]), 8460);
  assert.equal(request('http://localhost:8460/api/agent-config', 11)['x-tipatask-project'], '/projects/alpha');
  assert.equal(request('ws://localhost:8460/?taskId=x', 11)['x-tipatask-project'], '/projects/alpha');
  assertNoProjectHeaders(request('http://localhost:4455/api/agent-config', 11));
});

test('a malformed configured port cannot change the allowed host', () => {
  const request = installedHandler(new Map([[11, '/projects/alpha']]), '4455@images.example.test');
  assertNoProjectHeaders(request('http://images.example.test/pixel.png', 11));
});

test('external images, lookalikes, alternate ports, and other schemes receive no project path', () => {
  const request = installedHandler(new Map([[11, '/projects/private-repo']]));
  for (const url of [
    'https://images.example.test/pixel.png',
    'http://images.example.test/pixel.png',
    'http://localhost.evil.example:4455/api/trello/cards',
    'http://localhost@images.example.test:4455/pixel.png',
    'http://localhost.:4455/todo.html',
    'http://localhost:4456/todo.html',
    'ws://localhost:4456/?taskId=x',
    'https://localhost:4455/todo.html',
    'wss://localhost:4455/?taskId=x',
    'file:///tmp/todo.html',
    'not a URL',
  ]) {
    const headers = request(url, 11, { Accept: '*/*' });
    assertNoProjectHeaders(headers);
    assert.equal(headers.Accept, '*/*');
  }
});

test('redirects strip inherited and case-variant headers before the external request', () => {
  const request = installedHandler(new Map([[11, '/projects/alpha'], [22, '/projects/beta']]));
  const inherited = request('http://localhost:4455/api/images/1', 11, { Accept: 'image/*' });
  inherited['X-TIPATASK-PROJECT'] = '/wrong/project';
  inherited['x-tiptask-project-path'] = '/wrong/project';
  const external = request('https://images.example.test/pixel.png', 11, inherited);
  assertNoProjectHeaders(external);
  assert.equal(external.Accept, 'image/*');

  const backToApp = request('http://localhost:4455/api/agent-config', 22, external);
  assert.equal(backToApp['X-TipTask-Project-Path'], '/projects/beta');
  assert.equal(backToApp['x-tipatask-project'], '/projects/beta');
});

test('unbound windows cannot supply routing headers to the local server', () => {
  const request = installedHandler(new Map([[11, '/projects/alpha']]));
  assertNoProjectHeaders(request('http://localhost:4455/api/agent-config', 99, {
    'X-TipTask-Project-Path': '/forged', 'x-tipatask-project': '/forged',
  }));
});
