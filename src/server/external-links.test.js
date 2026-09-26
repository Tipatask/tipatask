'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseAllowedExternalUrl, shouldOpenExternally } = require('../../main/external-links');

const APP_ORIGIN = 'http://localhost:4455';

test('allows HTTP and HTTPS URLs outside the app origin', () => {
  assert.equal(shouldOpenExternally('https://example.com/tasks/1', APP_ORIGIN), true);
  assert.equal(shouldOpenExternally('http://example.com', APP_ORIGIN), true);
  assert.equal(shouldOpenExternally('http://localhost:4456/todo.html', APP_ORIGIN), true);
  assert.equal(shouldOpenExternally('http://localhost.evil.example:4455/todo.html', APP_ORIGIN), true);
});

test('allows mailto URLs', () => {
  assert.equal(shouldOpenExternally('mailto:support@example.com?subject=TipATask', APP_ORIGIN), true);
});

test('rejects same-origin app URLs', () => {
  assert.equal(shouldOpenExternally('http://localhost:4455/todo.html', APP_ORIGIN), false);
  assert.equal(shouldOpenExternally('/todo.html?projectPath=%2Ftmp%2Fdemo', APP_ORIGIN), false);
  assert.equal(shouldOpenExternally('./todo.html#task-TPT159', APP_ORIGIN), false);
});

test('rejects unsafe, unsupported, and malformed URLs', () => {
  assert.equal(shouldOpenExternally('javascript:alert(1)', APP_ORIGIN), false);
  assert.equal(shouldOpenExternally('file:///tmp/report.txt', APP_ORIGIN), false);
  assert.equal(shouldOpenExternally('data:text/plain,hello', APP_ORIGIN), false);
  assert.equal(shouldOpenExternally('ftp://example.com/file.txt', APP_ORIGIN), false);
  assert.equal(shouldOpenExternally('http://[invalid', APP_ORIGIN), false);
  assert.equal(shouldOpenExternally(null, APP_ORIGIN), false);
  assert.equal(shouldOpenExternally('https://example.com', 'not an origin'), false);
});

test('shared URL allowlist requires absolute IPC destinations', () => {
  assert.equal(parseAllowedExternalUrl('https://example.com')?.href, 'https://example.com/');
  assert.equal(parseAllowedExternalUrl('mailto:support@example.com')?.href, 'mailto:support@example.com');
  for (const url of ['/api/files/2/3', 'file:///tmp/report.txt', 'javascript:alert(1)',
    'data:text/plain,hello', 'custom://handler', 'http://[invalid', ' https://example.com',
    'https://example.com\n', null, {}]) {
    assert.equal(parseAllowedExternalUrl(url), null, String(url));
  }
});
