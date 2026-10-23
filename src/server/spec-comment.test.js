'use strict';

// C1159: spec comment reference-only header — build/strip round-trip, idempotency,
// language fallback. See ai/architecture/tt-objective-chat-prompt-builder.md
// § Original Objective Comment.

const { test } = require('node:test');
const assert = require('node:assert');

const { buildSpecCommentBody, stripSpecCommentHeader, specCommentHeader, buildAttachmentRefsBlock, extractSourceRefs, missingSourceRefsBlock } = require('./spec-comment');

const FIGMA_URL = 'https://www.figma.com/design/RcOVAPflBtbKMQZZw1ikSG/Seminar-Pages?node-id=1353-7890&p=f&m=dev';
const IMAGE_REF = '![img](https://tt.apppixies.com/api/projects/3/images/259)';

test('extractSourceRefs preserves Figma queries and image Markdown in source order', () => {
  assert.deepStrictEqual(extractSourceRefs(`Updated in Figma ${FIGMA_URL} (open in my Chrome tab)\n${IMAGE_REF}\nhttp://example.com/spec.`),
    [FIGMA_URL, IMAGE_REF, 'http://example.com/spec']);
});

test('extractSourceRefs keeps relative images and balanced URL parentheses', () => {
  assert.deepStrictEqual(extractSourceRefs('See [spec](https://example.com/hero_(desktop)), ![hero](/api/images/1) and <https://example.com/other>.'),
    ['https://example.com/hero_(desktop)', '![hero](/api/images/1)', 'https://example.com/other']);
  assert.deepStrictEqual(extractSourceRefs('![hero](https://example.com/hero_(desktop))'), ['![hero](https://example.com/hero_(desktop))']);
});

test('missingSourceRefsBlock restores screenshot sources with localized heading', () => {
  const objective = `Updated in Figma ${FIGMA_URL}\n${IMAGE_REF}`;
  assert.strictEqual(missingSourceRefsBlock(objective, ['Refresh Master Planning hero'], 'en'),
    `\n\n### Source material\n\n- ${FIGMA_URL}\n- ${IMAGE_REF}`);
  assert.ok(missingSourceRefsBlock(objective, [], 'uk').startsWith('\n\n### Джерельні матеріали\n\n'));
  assert.ok(missingSourceRefsBlock(objective, [], 'fr').includes('### Source material'));
});

test('missingSourceRefsBlock recognizes sources in any description and any image label', () => {
  assert.strictEqual(missingSourceRefsBlock(`${FIGMA_URL}\n${IMAGE_REF}`, [
    `[Figma design](${FIGMA_URL})`, '![different label](https://tt.apppixies.com/api/projects/3/images/259)',
  ], 'en'), '');
  assert.strictEqual(missingSourceRefsBlock(IMAGE_REF, ['https://tt.apppixies.com/api/projects/3/images/259'], 'en'), '');
  assert.strictEqual(missingSourceRefsBlock('![img](/api/images/1)', ['[attachment](/api/images/1)'], 'en'), '');
});

test('missingSourceRefsBlock checks exact targets rather than URL prefixes', () => {
  assert.ok(missingSourceRefsBlock('![img](/api/images/1)', ['![other](/api/images/12)'], 'en').includes('![img](/api/images/1)'));
  assert.ok(missingSourceRefsBlock(FIGMA_URL, [FIGMA_URL + '2'], 'en').includes(FIGMA_URL));
  assert.ok(missingSourceRefsBlock('https://example.com/design', ['[other](https://example.com/design-extra)'], 'en').includes('https://example.com/design'));
});

test('missingSourceRefsBlock is idempotent and handles partial, repeated or missing sources', () => {
  const objective = `${FIGMA_URL}\n${IMAGE_REF}\n${IMAGE_REF}`;
  const block = missingSourceRefsBlock(objective, [FIGMA_URL], 'en');
  assert.strictEqual(block, `\n\n### Source material\n\n- ${IMAGE_REF}`);
  assert.strictEqual(missingSourceRefsBlock(objective, [FIGMA_URL, 'Implement hero' + block], 'en'), '');
  assert.strictEqual(missingSourceRefsBlock('No sources here', [], 'en'), '');
  assert.strictEqual(missingSourceRefsBlock(null, null, 'en'), '');
  assert.deepStrictEqual(extractSourceRefs(undefined), []);
});

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

for (const lang of ['en', 'uk']) {
  test(`sole-task spec header makes the full objective binding (${lang})`, () => {
    const spec = `  ${FIGMA_URL}\n${IMAGE_REF}\nCopy: Count every item\nJoin on project_id  `;
    const body = buildSpecCommentBody(spec, lang, { soleTask: true });
    if (lang === 'en') {
      assert.ok(body.startsWith('## Original Objective (full specification)'));
      assert.ok(body.includes('This task covers the whole objective below.'));
      assert.ok(body.includes('every link, image, copy line and data hint'));
      assert.ok(body.includes('binding requirements'));
      assert.ok(body.includes('including details omitted from this task\'s description'));
    } else {
      assert.ok(body.startsWith('## Початкова ціль (повна специфікація)'));
      assert.ok(body.includes('Це завдання охоплює всю ціль нижче.'));
      assert.ok(body.includes('кожне посилання, зображення, рядок тексту та підказку щодо даних'));
      assert.ok(body.includes('обов\'язковими вимогами'));
      assert.ok(body.includes('пропущеними в описі цього завдання'));
    }
    assert.strictEqual(stripSpecCommentHeader(body), spec.trim());
    assert.ok(body.endsWith(spec.trim()));
    for (const nextLang of ['en', 'uk']) {
      for (const soleTask of [false, true]) {
        assert.strictEqual(buildSpecCommentBody(body, nextLang, { soleTask }), body);
      }
    }
    const reference = buildSpecCommentBody(spec, lang, { soleTask: false });
    assert.strictEqual(reference, buildSpecCommentBody(spec, lang));
    assert.strictEqual(buildSpecCommentBody(reference, lang, { soleTask: true }), reference);
  });
}

test('sole-task header falls back to English and keeps empty input empty', () => {
  assert.strictEqual(buildSpecCommentBody('Spec', 'fr', { soleTask: true }),
    buildSpecCommentBody('Spec', 'en', { soleTask: true }));
  for (const spec of ['', '   ', undefined]) {
    assert.strictEqual(buildSpecCommentBody(spec, 'en', { soleTask: true }), '');
  }
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
