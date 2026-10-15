'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SEPARATOR, countMentions, countAttachmentRefs, describePromptSections,
  measureStdin, formatPromptSizeLine, buildPromptDump,
} = require('./objective-prompt-dump');

test('countMentions counts @path tokens, not e-mail addresses', () => {
  assert.equal(countMentions('Read @src/a.js and (@docs/b.md) then @~/x\nmail me at a@b.com'), 3);
  assert.equal(countMentions(''), 0);
  assert.equal(countMentions(null), 0);
});

test('countAttachmentRefs counts markdown images and attachment-store links only', () => {
  const text = [
    '![shot](https://api.example/api/projects/2/images/9)',
    '[spec.pdf](https://api.example/api/projects/2/files/4)',
    '[docs](https://example.com/guide)',
    '![inline](data:image/png;base64,AAAA)',
  ].join('\n');
  assert.equal(countAttachmentRefs(text), 3);
});

test('describePromptSections splits on ### headings and <block> openers, preamble first', () => {
  const text = 'Priority baseline: 3\n\n### list_task_id_meta\n```json\n{}\n```\n\n<objective>\nDo it\n</objective>\n';
  const sections = describePromptSections(text);
  assert.deepEqual(sections.map(s => s.name), ['(preamble)', '### list_task_id_meta', '<objective>']);
  assert.equal(sections.reduce((n, s) => n + s.chars, 0), text.length);
  assert.equal(sections[1].startOffset, text.indexOf('### list_task_id_meta'));
  assert.deepEqual(describePromptSections('plain text').map(s => s.name), ['(preamble)']);
  assert.deepEqual(describePromptSections('### only\nbody').map(s => s.name), ['### only']);
});

test('buildPromptDump header states its own byte length and the body is the exact stdin', () => {
  const stdin = '### get_project_tags\n[{"name":"ünïcode"}]\n\n<objective>\nПлан @ai/x.md\n</objective>';
  const metrics = measureStdin(stdin);
  const dump = buildPromptDump({ taskId: 'T1', turnIdx: 1, mode: 'fresh', systemPromptChars: 12, stdin, metrics,
    profile: { staticChars: 5, cachedTagsCount: 0, cachedTagsChars: 0, serverHistMessages: 1, serverHistChars: 20 } });
  assert.equal(dump.body, stdin);
  assert.ok(dump.header.endsWith(SEPARATOR));
  assert.equal(Buffer.byteLength(dump.header, 'utf8'), dump.bodyStart);
  assert.match(dump.header, new RegExp(`body starts at byte ${dump.bodyStart}\\n`));
  const file = dump.header + dump.body;
  assert.equal(Buffer.byteLength(file, 'utf8') - dump.bodyStart, metrics.bytes);
  assert.equal(file.slice(dump.header.length), stdin);
  assert.match(dump.header, /- stdin\.chars: \d+/);
  assert.match(dump.header, /- mentions\(@path\): 1/);
  assert.match(dump.header, /\| ### get_project_tags \| \d+ \| \d+ \| 0 \|/);
  assert.match(dump.header, /- profile\.serverHistory: messages=1 chars=20/);
});

test('formatPromptSizeLine carries every field on one line', () => {
  const stdin = 'hello\n### a\nbody';
  const line = formatPromptSizeLine({ taskId: 'T2', turnIdx: 3, mode: 'resume', systemPromptChars: 0, stdin });
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /^\[objective:prompt-size\] task=T2 turn=3 mode=resume systemPrompt\.chars=0 stdin\.chars=16 stdin\.bytes=16 mentions=0 attachmentRefs=0 sections=\(preamble\):6,###_a:10$/);
});
