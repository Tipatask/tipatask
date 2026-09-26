'use strict';

// C1159: spec comment reference-only header — build/strip round-trip, idempotency,
// language fallback. See ai/architecture/tt-objective-chat-prompt-builder.md
// § Original Objective Comment.

const { test } = require('node:test');
const assert = require('node:assert');

const { buildSpecCommentBody, stripSpecCommentHeader, specCommentHeader, buildAttachmentRefsBlock } = require('./spec-comment');

test('buildSpecCommentBody prepends en header by default', () => {
  const body = buildSpecCommentBody('Do the whole thing', 'en');
  assert.ok(body.startsWith('## Original Objective (reference only)'));
  assert.ok(body.includes('do NOT implement other parts'));
  assert.ok(body.endsWith('Do the whole thing'));
});

test('buildSpecCommentBody prepends uk header for language:uk', () => {
  const body = buildSpecCommentBody('Зроби все', 'uk');
  assert.ok(body.startsWith('## Початкова ціль (лише для довідки)'));
  assert.ok(body.endsWith('Зроби все'));
});

test('buildSpecCommentBody falls back to en for unknown language code', () => {
  const body = buildSpecCommentBody('Do the whole thing', 'fr');
  assert.ok(body.startsWith('## Original Objective (reference only)'));
});

test('buildSpecCommentBody is idempotent', () => {
  const once = buildSpecCommentBody('Do the whole thing', 'en');
  const twice = buildSpecCommentBody(once, 'en');
  assert.strictEqual(twice, once);
});

test('buildSpecCommentBody empty input yields empty output', () => {
  assert.strictEqual(buildSpecCommentBody('', 'en'), '');
  assert.strictEqual(buildSpecCommentBody('   ', 'en'), '');
  assert.strictEqual(buildSpecCommentBody(undefined, 'en'), '');
});

test('stripSpecCommentHeader round-trips buildSpecCommentBody for any known language', () => {
  const spec = 'Do the whole thing';
  assert.strictEqual(stripSpecCommentHeader(buildSpecCommentBody(spec, 'en')), spec);
  assert.strictEqual(stripSpecCommentHeader(buildSpecCommentBody(spec, 'uk')), spec);
});

test('stripSpecCommentHeader is a no-op on a pre-C1159 raw comment (dedup compat)', () => {
  const raw = 'Do the whole thing';
  assert.strictEqual(stripSpecCommentHeader(raw), raw);
});

test('specCommentHeader falls back to en for unknown language', () => {
  assert.strictEqual(specCommentHeader('fr'), specCommentHeader('en'));
});

// ── TPT29: buildAttachmentRefsBlock ──

test('buildAttachmentRefsBlock returns empty string for no attachments', () => {
  assert.strictEqual(buildAttachmentRefsBlock([], [], 'en'), '');
});

test('buildAttachmentRefsBlock: images only', () => {
  const block = buildAttachmentRefsBlock([{ id: 1, url: '/api/projects/1/images/1', filename: 'a.png' }], [], 'en');
  assert.ok(block.includes('### Attachments'));
  assert.ok(block.includes('![a.png](/api/projects/1/images/1)'));
  assert.ok(!block.includes('- ['));
});

test('buildAttachmentRefsBlock: files only', () => {
  const block = buildAttachmentRefsBlock([], [{ id: 1, url: '/api/projects/1/files/1', filename: 'spec.pdf' }], 'en');
  assert.ok(block.includes('### Attachments'));
  assert.ok(block.includes('- [spec.pdf](/api/projects/1/files/1)'));
  assert.ok(!block.includes('!['));
});

test('buildAttachmentRefsBlock: images strictly before files, one heading', () => {
  const block = buildAttachmentRefsBlock(
    [{ id: 1, url: '/api/projects/1/images/1', filename: 'a.png' }],
    [{ id: 1, url: '/api/projects/1/files/1', filename: 'spec.pdf' }],
    'en'
  );
  assert.strictEqual((block.match(/### Attachments/g) || []).length, 1);
  assert.ok(block.indexOf('a.png') < block.indexOf('spec.pdf'));
});

test('buildAttachmentRefsBlock: uk heading for lang:uk, en fallback for unknown code', () => {
  const rows = [{ id: 1, url: '/api/projects/1/images/1', filename: 'a.png' }];
  assert.ok(buildAttachmentRefsBlock(rows, [], 'uk').includes('### Вкладення'));
  assert.ok(buildAttachmentRefsBlock(rows, [], 'fr').includes('### Attachments'));
});

test('buildAttachmentRefsBlock: full dedup via excludeRefsIn yields empty string', () => {
  const url = '/api/projects/1/images/1';
  const block = buildAttachmentRefsBlock(
    [{ id: 1, url, filename: 'a.png' }], [],
    'en', { excludeRefsIn: `![a.png](${url})` }
  );
  assert.strictEqual(block, '');
});

test('buildAttachmentRefsBlock: dedup is exact-target, not substring (/images/1 vs /images/12)', () => {
  const block = buildAttachmentRefsBlock(
    [{ id: 1, url: '/api/projects/1/images/1', filename: 'a.png' }], [],
    'en', { excludeRefsIn: '![b.png](/api/projects/1/images/12)' }
  );
  assert.ok(block.includes('a.png'), 'a distinct url must not be suppressed by a superstring match');
});

test('buildAttachmentRefsBlock: partial dedup keeps only the orphan', () => {
  const inlined = '/api/projects/1/images/1';
  const orphan = '/api/projects/1/images/2';
  const block = buildAttachmentRefsBlock(
    [
      { id: 1, url: inlined, filename: 'inlined.png' },
      { id: 2, url: orphan, filename: 'orphan.png' },
    ], [],
    'en', { excludeRefsIn: `![inlined.png](${inlined})` }
  );
  assert.ok(block.includes('orphan.png'));
  assert.ok(!block.includes('inlined.png'));
});

test('buildAttachmentRefsBlock: falsy url skipped, blank filename falls back to a stable label', () => {
  const block = buildAttachmentRefsBlock(
    [
      { id: 1, url: '', filename: 'ghost.png' },
      { id: 2, url: '/api/projects/1/images/2', filename: '' },
    ], [],
    'en'
  );
  assert.ok(!block.includes('ghost.png'));
  assert.ok(block.includes('![image-2](/api/projects/1/images/2)'));
});

test('buildAttachmentRefsBlock: a bracket in a filename cannot break the ref', () => {
  const block = buildAttachmentRefsBlock(
    [{ id: 1, url: '/api/projects/1/images/1', filename: 'weird]name.png' }], [], 'en'
  );
  assert.ok(block.includes('![weirdname.png](/api/projects/1/images/1)'));
});

test('buildAttachmentRefsBlock: non-array/null inputs never throw', () => {
  assert.doesNotThrow(() => buildAttachmentRefsBlock(null, undefined, 'en'));
  assert.strictEqual(buildAttachmentRefsBlock(null, undefined, 'en'), '');
});

test('buildAttachmentRefsBlock: round-trips through stripSpecCommentHeader when empty', () => {
  const spec = 'Do the whole thing';
  const body = buildSpecCommentBody(spec, 'en') + buildAttachmentRefsBlock([], [], 'en');
  assert.strictEqual(stripSpecCommentHeader(body), spec);
});
