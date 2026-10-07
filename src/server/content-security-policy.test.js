'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { contentSecurityPolicy, inlineScriptHashes } = require('./content-security-policy');
const config = require('./config');
const { createHttpHandler } = require('./ws-handlers');

const template = fs.readFileSync(path.join(__dirname, '../client/template.html'), 'utf8');

test('main HTML allows only its exact inline scripts and local script files', () => {
  const hashes = inlineScriptHashes(template);
  const csp = contentSecurityPolicy(template);
  assert.equal(hashes.length, 2, 'theme bootstrap and main UI wiring each need one hash');
  assert.ok(hashes.every(hash => csp.includes(hash)));
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.doesNotMatch(csp.split('; ').find(rule => rule.startsWith('script-src')), /unsafe-inline|unsafe-eval|\*/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.notDeepEqual(inlineScriptHashes(template.replace('var DEFAULT =', 'var DEFAULT_RENAMED =')), hashes);
});

test('inline script hashes ignore the line endings of the served HTML', () => {
  // The HTML parser normalizes CRLF and lone CR to LF before the browser hashes
  // an inline script, so every line-ending variant must yield the LF hashes.
  const lf = template.replace(/\r\n?/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  const cr = lf.replace(/\n/g, '\r');
  assert.doesNotMatch(lf, /\r/);
  assert.match(crlf, /<script>\r\n/, 'CRLF variant must put CRLF inside an inline script');
  assert.doesNotMatch(cr, /\n/);

  const hashes = inlineScriptHashes(lf);
  assert.equal(hashes.length, 2);
  assert.deepEqual(inlineScriptHashes(crlf), hashes);
  assert.deepEqual(inlineScriptHashes(cr), hashes);
  assert.equal(contentSecurityPolicy(crlf), contentSecurityPolicy(lf));
  assert.equal(contentSecurityPolicy(cr), contentSecurityPolicy(lf));
});

test('GET /todo.html sends the policy as an HTTP response header', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-markdown-csp-'));
  const previousRoot = config.SERVER_ROOT;
  const previousDist = config.DIST;
  fs.writeFileSync(path.join(dir, 'todo.html'), template);
  config.SERVER_ROOT = dir;
  config.DIST = dir;
  try {
    const response = {
      status: null, headers: null, body: null,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.body = body; },
    };
    await createHttpHandler(new Map(), () => ({}))(
      { method: 'GET', url: '/todo.html', headers: {} }, response
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Security-Policy'], contentSecurityPolicy(template));
    assert.match(String(response.body), /<script src="\/bundle.js"><\/script>/);
  } finally {
    config.SERVER_ROOT = previousRoot;
    config.DIST = previousDist;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
