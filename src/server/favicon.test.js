'use strict';

// TPT289 — todo.html favicon: the solid Δ from scripts/gen-icon.js, generated into assets/,
// copied into dist/ by build.js, linked from template.html, served from DIST by ws-handlers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));

test('template.html links both favicon files', () => {
  const html = read('src/client/template.html').toString('utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(head, /<link rel="icon" href="\/favicon\.ico" sizes="any">/);
});

test('assets/favicon.svg is the gen-icon.js Δ outline in brand teal', () => {
  const svg = read('assets/favicon.svg').toString('utf8');
  const gen = read('scripts/gen-icon.js').toString('utf8');
  const outer = gen.match(/const DELTA_PATH = '([^']+)'/)[1];
  assert.ok(svg.includes(outer), 'favicon path must reuse DELTA_PATH');
  assert.ok(svg.includes('fill="#14b8a6"'));
  assert.match(svg, /viewBox="[\d.-]+ [\d.-]+ ([\d.]+) \1"/, 'viewBox must be square');
});

test('assets/favicon.ico holds 48/32/16 frames', () => {
  const ico = read('assets/favicon.ico');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type');
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i += 1) sizes.push(ico[6 + i * 16]);
  assert.deepEqual(sizes, [48, 32, 16]);
});

test('build.js copies both favicons into dist/', () => {
  const src = read('build.js').toString('utf8');
  assert.match(src, /function copyFavicons\(\)/);
  assert.match(src, /\['favicon\.ico', 'favicon\.svg'\]/);
  assert.match(src, /copyTemplate\(\);\s*copyMarked\(\);\s*copyFavicons\(\);/);
});

test('HTTP handler serves /favicon.svg and /favicon.ico from dist/', async (t) => {
  const config = require('./config');
  const missing = ['favicon.svg', 'favicon.ico'].filter((f) => !fs.existsSync(path.join(config.DIST, f)));
  if (missing.length) return t.skip(`dist/ not built (${missing.join(', ')}) — run node build.js`);
  const { createHttpHandler } = require('./ws-handlers');
  const handler = createHttpHandler(new Map(), () => ({}));
  for (const [url, type] of [['/favicon.svg', 'image/svg+xml'], ['/favicon.ico', 'image/x-icon']]) {
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.body = body; },
    };
    await handler({ method: 'GET', url, headers: {} }, res);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers['Content-Type'], type, url);
    assert.ok(Buffer.from(res.body).equals(fs.readFileSync(path.join(config.DIST, url.slice(1)))), url);
  }
});
