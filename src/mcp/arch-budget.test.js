'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ARCH_REPLY_CHAR_BUDGET, architectureSections, buildArchitectureReply } = require('./arch-budget');

const decode = reply => JSON.parse(reply.content[0].text);
function bounded(reply, budget = ARCH_REPLY_CHAR_BUDGET) {
  assert.ok(JSON.stringify(reply).length <= budget, `Serialized reply exceeds ${budget} characters`);
  return reply;
}

test('small batches retain exact strings, nulls, and requested order', () => {
  const entries = [['tt-second', '# Doc\n## Files\nfile.js\n'], ['tt-missing', null], ['tt-first', '']];
  const reply = bounded(buildArchitectureReply(entries));
  assert.equal(reply.content[0].text, JSON.stringify(Object.fromEntries(entries), null, 2));
  assert.deepEqual(Object.keys(decode(reply)), entries.map(([tag]) => tag));
});

test('small single docs retain raw Markdown, including an empty doc', () => {
  for (const content of ['', '# Doc\n## Files\nfile.js\n']) {
    assert.deepEqual(buildArchitectureReply([['tt-doc', content]], { single: true }), { content: [{ type: 'text', text: content }] });
  }
});

test('over-budget batch keeps earlier full docs, outlines later docs, and admits a later small doc', () => {
  const first = 'a'.repeat(35000);
  const second = '## Files\n' + 'b'.repeat(35000);
  const reply = bounded(buildArchitectureReply([['tt-first', first], ['tt-second', second], ['tt-third', 'small'], ['tt-missing', null]]));
  const map = decode(reply);
  assert.equal(map['tt-first'], first);
  assert.equal(map['tt-third'], 'small');
  assert.equal(map['tt-missing'], null);
  assert.equal(map['tt-second'].truncated, true);
  assert.equal(map['tt-second'].chars, second.length);
  assert.deepEqual(map['tt-second'].sections, [{ heading: 'Files', chars: 35000 }]);
  assert.match(map['tt-second'].hint, /section.*get_tag_architecture.*get_tag_architectures.*Read.*\.md/);
});

test('one oversized doc becomes an outline in both single and batch modes', () => {
  const content = '# Doc\n## Files\n' + 'x'.repeat(ARCH_REPLY_CHAR_BUDGET) + '\n### Child\nchild\n## API\napi\n';
  for (const single of [false, true]) {
    const reply = bounded(buildArchitectureReply([['tt-doc', content]], { single }));
    const outline = single ? decode(reply) : decode(reply)['tt-doc'];
    assert.equal(outline.chars, content.length);
    assert.equal(outline.truncated, true);
    assert.deepEqual(outline.sections, architectureSections(content).map(({ heading, body }) => ({ heading, chars: body.length })));
  }
});

test('budget includes batch JSON escaping, MCP envelope, and exact-fit boundaries', () => {
  const content = '"\\\n'.repeat(12000);
  assert.ok(content.length < ARCH_REPLY_CHAR_BUDGET);
  assert.equal(decode(bounded(buildArchitectureReply([['tt-doc', content]])))['tt-doc'].truncated, true);
  const entries = [['tt-doc', 'x'.repeat(2000)]];
  for (const single of [false, true]) {
    const exact = buildArchitectureReply(entries, { single });
    const budget = JSON.stringify(exact).length;
    assert.deepEqual(bounded(buildArchitectureReply(entries, { single, budget }), budget), exact);
    const smaller = bounded(buildArchitectureReply(entries, { single, budget: budget - 1 }), budget - 1);
    assert.equal((single ? decode(smaller) : decode(smaller)['tt-doc']).truncated, true);
  }
});

test('section fetch is case-insensitive, returns only its body, preserves whitespace and nested subsections', () => {
  const content = '# Doc\r\n## Files ###\r\n\r\nparent\r\n### Child\r\nchild\r\n#### Detail\r\ndetail\r\n## API\r\napi\r\n';
  const entries = [['tt-doc', content], ['tt-missing', null]];
  assert.equal(decode(buildArchitectureReply(entries, { section: ' files ' }))['tt-doc'], '\r\nparent\r\n### Child\r\nchild\r\n#### Detail\r\ndetail\r\n');
  assert.equal(buildArchitectureReply([entries[0]], { single: true, section: 'CHILD' }).content[0].text, 'child\r\n#### Detail\r\ndetail\r\n');
  assert.equal(decode(buildArchitectureReply(entries, { section: 'API' }))['tt-doc'], 'api\r\n');
});

test('fenced headings are ignored and duplicate headings select the first occurrence', () => {
  const content = '## Files\nfirst\n```md\n## Fake\n```\n~~~~\n### Fake too\n~~~\n~~~~\n## Files\nsecond\n# Other doc\nrest\n';
  assert.deepEqual(architectureSections(content).map(s => s.heading), ['Files', 'Files']);
  assert.equal(buildArchitectureReply([['tt-doc', content]], { single: true, section: 'files' }).content[0].text, 'first\n```md\n## Fake\n```\n~~~~\n### Fake too\n~~~\n~~~~\n');
  assert.equal(architectureSections(content)[1].body, 'second\n');
});

test('empty sections are present, missing tags/sections are null in batches and errors for singles', () => {
  const entries = [['tt-doc', '## Empty\n## Files\nx'], ['tt-missing', null]];
  assert.deepEqual(decode(buildArchitectureReply(entries, { section: 'Empty' })), { 'tt-doc': '', 'tt-missing': null });
  assert.deepEqual(decode(buildArchitectureReply(entries, { section: 'unknown' })), { 'tt-doc': null, 'tt-missing': null });
  assert.equal(buildArchitectureReply([entries[0]], { single: true, section: 'unknown' }).isError, true);
  assert.equal(buildArchitectureReply([entries[1]], { single: true }).isError, true);
});

test('oversized section fetches obey the same budget', () => {
  const content = '## Large\n' + 'x'.repeat(80000) + '\n### Child\nchild\n## Small\nsmall\n';
  for (const single of [false, true]) {
    const reply = bounded(buildArchitectureReply([['tt-doc', content]], { single, section: 'large' }));
    const outline = single ? decode(reply) : decode(reply)['tt-doc'];
    assert.equal(outline.truncated, true);
    assert.equal(outline.chars, architectureSections(content)[0].body.length);
    assert.deepEqual(outline.sections, [{ heading: 'Child', chars: 6 }]);
  }
});

test('outline metadata remains bounded as headings and document counts grow', () => {
  const content = Array.from({ length: 300 }, (_, i) => `## ${i} ${'heading'.repeat(100)}\nbody\n`).join('');
  const reply = bounded(buildArchitectureReply(Array.from({ length: 50 }, (_, i) => [`tt-doc-${i}`, content])));
  for (const outline of Object.values(decode(reply))) {
    assert.equal(outline.truncated, true);
    assert.ok(outline.sections.length > 0);
    assert.ok(outline.sections.length < 300);
  }
  const single = decode(bounded(buildArchitectureReply([['tt-doc', `## ${'long'.repeat(30000)}\nbody`]], { single: true })));
  assert.ok(single.sections[0].heading.length <= 201);
});

test('prototype-shaped tags retain their own map entries', () => {
  const reply = decode(buildArchitectureReply([['__proto__', 'doc'], ['constructor', null]]));
  assert.deepEqual(Object.keys(reply), ['__proto__', 'constructor']);
  assert.equal(reply.__proto__, 'doc');
});

test('metadata that alone exceeds a custom budget produces a bounded actionable error', () => {
  const reply = bounded(buildArchitectureReply(Array.from({ length: 50 }, (_, i) => [`tt-doc-${i}`, 'x'.repeat(5000)]), { budget: 1000 }), 1000);
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /Request fewer/);
});

// A standalone Task App clone has no enclosing api/ checkout. Behavioral tests
// above still run; cross-repository parity runs whenever both twins are present.
const fs = require('node:fs');
const path = require('node:path');
const twinPath = path.resolve(__dirname, '../../../../../api/src/lib/arch-budget.js');
const needsTwin = { skip: fs.existsSync(twinPath) ? false : 'API twin is absent in this standalone Task App checkout' };

test('helper twins have identical logic and answer the same fixtures identically', needsTwin, () => {
  const twin = require(twinPath);
  const marker = 'const ARCH_REPLY_CHAR_BUDGET';
  const body = file => {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes(marker));
    return source.slice(source.indexOf(marker));
  };
  assert.equal(body(path.join(__dirname, 'arch-budget.js')), body(twinPath));
  const fixtures = [
    [[['tt-small', '## Files\nfile\n'], ['tt-missing', null]], {}],
    [[['tt-big', '## Files\n' + 'x'.repeat(70000)], ['tt-small', 'small']], {}],
    [[['tt-big', '## Files\n' + '"\\\n'.repeat(25000)]], { single: true }],
    [[['tt-doc', '## Files\nbody\n## API\napi']], { section: 'files' }],
    [[['tt-doc', '## Files\nbody']], { single: true, section: 'missing' }],
  ];
  for (const [entries, options] of fixtures) assert.deepEqual(buildArchitectureReply(entries, options), twin.buildArchitectureReply(entries, options));
});
