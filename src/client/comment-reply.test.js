// TPT9336 — parity tests for comment-reply.js, the client twin of api/src/lib/comment-reply.js
// (the TPT9334 reply-citation format).
//
// Two halves:
//   1. Behavioral coverage (always runs): the cases of api/src/lib/comment-reply.test.js, run
//      against this copy, so it is proven correct in a clone of this repository that has no
//      api/ directory next to it (the public repository and the packaged app are built from
//      one).
//   2. Source parity (skips when api/ is absent): the shared code, from the REPLY_QUOTE_MAX
//      line to the line before the exports, must stay byte-identical to the API's file. The
//      two files differ only in their header comment and their export syntax.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPLY_QUOTE_MAX,
  parseReplyCitation,
  stripReplyCitation,
  buildReplyCitation,
} from './comment-reply.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WELL_FORMED = [
  '<!-- tipatask:reply:42 -->',
  '> **Anton Matiienko:** Deploy is blocked on @Bob Stone.',
  '> Second line of the original.',
  '>',
  '> After an empty quoted line.',
  '',
  '@Anton Matiienko I will take it today.',
].join('\n');

// ── 1. Behavioral coverage — mirrors api/src/lib/comment-reply.test.js ──

test('parseReplyCitation: reads id, author, quote and body of a well-formed reply', () => {
  assert.deepEqual(parseReplyCitation(WELL_FORMED), {
    commentId: 42,
    author: 'Anton Matiienko',
    quote: 'Deploy is blocked on @Bob Stone.\nSecond line of the original.\n\nAfter an empty quoted line.',
    body: '@Anton Matiienko I will take it today.',
  });
});

test('parseReplyCitation: a multi-line body keeps its own line breaks and markdown', () => {
  const reply = parseReplyCitation(`${WELL_FORMED}\n\n- step one\n- step two`);
  assert.equal(reply.body, '@Anton Matiienko I will take it today.\n\n- step one\n- step two');
});

test('parseReplyCitation: a quote with no author label is an authorless reply', () => {
  const reply = parseReplyCitation('<!-- tipatask:reply:7 -->\n> Words of a deleted user\n\nThanks');
  assert.deepEqual(reply, { commentId: 7, author: null, quote: 'Words of a deleted user', body: 'Thanks' });
});

test('parseReplyCitation: the label may stand alone with the quote on the next lines', () => {
  const reply = parseReplyCitation('<!-- tipatask:reply:7 -->\n> **Ann:**\n> quoted\n\nok');
  assert.equal(reply.author, 'Ann');
  assert.equal(reply.quote, 'quoted');
});

test('parseReplyCitation: a nested blockquote inside the quote keeps one ">" level', () => {
  const reply = parseReplyCitation('<!-- tipatask:reply:9 -->\n> **Ann:** see below\n> > older text\n\nok');
  assert.equal(reply.quote, 'see below\n> older text');
});

test('parseReplyCitation: a reply with an empty body has body ""', () => {
  assert.equal(parseReplyCitation('<!-- tipatask:reply:9 -->\n> **Ann:** hi').body, '');
});

test('parseReplyCitation: no marker line → null, even with the quote shape present', () => {
  const content = '> **Anton Matiienko:** Deploy is blocked on @Bob Stone.\n\n@Anton Matiienko on it';
  assert.equal(parseReplyCitation(content), null);
  assert.equal(stripReplyCitation(content), content);
});

test('parseReplyCitation: the marker must be the first non-blank line', () => {
  assert.equal(parseReplyCitation(`Intro written above it\n${WELL_FORMED}`), null);
  assert.equal(parseReplyCitation(`\n\n${WELL_FORMED}`).commentId, 42);
});

test('parseReplyCitation: a marker that is not a positive integer id → null', () => {
  for (const marker of ['<!-- tipatask:reply: -->', '<!-- tipatask:reply:abc -->', '<!-- tipatask:reply:0 -->',
    '<!-- tipatask:reply:-3 -->', '<!-- tipatask:reply:1.5 -->', '<!-- tipatask:reply:99999999999999999999 -->',
    '<!-- tipatask:agent-exit -->', '<!-- tipatask:reply:42 --> trailing text']) {
    assert.equal(parseReplyCitation(`${marker}\n> **Ann:** hi\n\nbody`), null, marker);
  }
});

test('parseReplyCitation: a marker with no blockquote after it → null, content kept whole', () => {
  const content = '<!-- tipatask:reply:42 -->\nJust text, the quote was deleted';
  assert.equal(parseReplyCitation(content), null);
  assert.equal(stripReplyCitation(content), content);
  assert.equal(parseReplyCitation('<!-- tipatask:reply:42 -->'), null);
});

test('parseReplyCitation / stripReplyCitation: non-string input', () => {
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(parseReplyCitation(value), null);
    assert.equal(stripReplyCitation(value), '');
  }
});

test('edited reply: a rewritten body without the @mention still parses, body as edited', () => {
  const edited = WELL_FORMED.replace('@Anton Matiienko I will take it today.', 'Never mind, already fixed.');
  const reply = parseReplyCitation(edited);
  assert.equal(reply.author, 'Anton Matiienko');
  assert.equal(reply.body, 'Never mind, already fixed.');
});

test('edited reply: a hand-shortened quote still parses', () => {
  const reply = parseReplyCitation('<!-- tipatask:reply:42 -->\n> **Anton Matiienko:** Deploy is blocked\n\n@Anton Matiienko ok');
  assert.equal(reply.quote, 'Deploy is blocked');
  assert.equal(reply.body, '@Anton Matiienko ok');
});

test('edited reply: CRLF line endings parse like LF', () => {
  assert.deepEqual(parseReplyCitation(WELL_FORMED.replace(/\n/g, '\r\n')), parseReplyCitation(WELL_FORMED));
});

test('edited reply: no blank line between quote and body still splits at the last quoted line', () => {
  const reply = parseReplyCitation('<!-- tipatask:reply:42 -->\n> **Ann:** quoted\n@Ann reply');
  assert.equal(reply.quote, 'quoted');
  assert.equal(reply.body, '@Ann reply');
});

test('edited reply: blank lines added after the marker, extra blank lines around the body', () => {
  const reply = parseReplyCitation('<!-- tipatask:reply:42 -->\n\n> **Ann:** quoted\n\n\n\n@Ann reply\n\n');
  assert.deepEqual(reply, { commentId: 42, author: 'Ann', quote: 'quoted', body: '@Ann reply' });
});

test('edited reply: removing the marker turns it into a plain comment', () => {
  const edited = WELL_FORMED.split('\n').slice(1).join('\n');
  assert.equal(parseReplyCitation(edited), null);
  assert.equal(stripReplyCitation(edited), edited);
});

test('stripReplyCitation: returns only the reply body, dropping marker and quote', () => {
  assert.equal(stripReplyCitation(WELL_FORMED), '@Anton Matiienko I will take it today.');
});

test('stripReplyCitation: a plain comment comes back unchanged', () => {
  assert.equal(stripReplyCitation('Plain comment for @Bob Stone'), 'Plain comment for @Bob Stone');
});

test('buildReplyCitation: writes the documented format and parses back', () => {
  const text = 'Deploy is blocked on @Bob Stone.\nSecond line of the original.\n\nAfter an empty quoted line.';
  const prefill = buildReplyCitation({ commentId: 42, author: 'Anton Matiienko', text });
  assert.equal(prefill, [
    '<!-- tipatask:reply:42 -->',
    '> **Anton Matiienko:** Deploy is blocked on @Bob Stone.',
    '> Second line of the original.',
    '>',
    '> After an empty quoted line.',
    '',
    '@Anton Matiienko ',
  ].join('\n'));
  const reply = parseReplyCitation(`${prefill}I will take it today.`);
  assert.deepEqual(reply, {
    commentId: 42,
    author: 'Anton Matiienko',
    quote: text,
    body: '@Anton Matiienko I will take it today.',
  });
});

test('buildReplyCitation: a comment with no author gets the quote and no mention', () => {
  for (const author of [null, undefined, '', '   ']) {
    const prefill = buildReplyCitation({ commentId: 5, author, text: 'Words of a deleted user' });
    assert.equal(prefill, '<!-- tipatask:reply:5 -->\n> Words of a deleted user\n\n');
    assert.deepEqual(parseReplyCitation(`${prefill}Thanks`), { commentId: 5, author: null, quote: 'Words of a deleted user', body: 'Thanks' });
  }
});

test('buildReplyCitation: an authorless quote that opens with a bold label is not read as the author', () => {
  const prefill = buildReplyCitation({ commentId: 5, author: null, text: '**Note:** keep the cache' });
  const reply = parseReplyCitation(`${prefill}ok`);
  assert.equal(reply.author, null);
  assert.equal(reply.quote, '**Note:** keep the cache');
});

test('buildReplyCitation: an authored quote that opens with a bold label keeps it in the quote', () => {
  const reply = parseReplyCitation(buildReplyCitation({ commentId: 5, author: 'Ann', text: '**Note:** keep the cache' }));
  assert.equal(reply.author, 'Ann');
  assert.equal(reply.quote, '**Note:** keep the cache');
});

test('buildReplyCitation: the quote is capped at REPLY_QUOTE_MAX characters plus an ellipsis', () => {
  assert.equal(REPLY_QUOTE_MAX, 600);
  const exact = 'a'.repeat(REPLY_QUOTE_MAX);
  assert.equal(parseReplyCitation(buildReplyCitation({ commentId: 1, author: 'Ann', text: exact })).quote, exact);
  const long = 'b'.repeat(REPLY_QUOTE_MAX + 50);
  assert.equal(parseReplyCitation(buildReplyCitation({ commentId: 1, author: 'Ann', text: long })).quote, `${'b'.repeat(REPLY_QUOTE_MAX)}…`);
});

test('buildReplyCitation: the cap counts code points and never splits a surrogate pair', () => {
  const text = '😀'.repeat(REPLY_QUOTE_MAX + 1);
  const quote = parseReplyCitation(buildReplyCitation({ commentId: 1, author: 'Ann', text })).quote;
  assert.equal(quote, `${'😀'.repeat(REPLY_QUOTE_MAX)}…`);
  assert.equal(quote.isWellFormed(), true);
});

test('buildReplyCitation: a cut that lands on whitespace drops it before the ellipsis', () => {
  const text = `${'c'.repeat(REPLY_QUOTE_MAX - 1)}\nmore`;
  assert.equal(parseReplyCitation(buildReplyCitation({ commentId: 1, author: 'Ann', text })).quote, `${'c'.repeat(REPLY_QUOTE_MAX - 1)}…`);
});

test('buildReplyCitation: quoting a reply quotes only its body, so citations never nest', () => {
  const prefill = buildReplyCitation({ commentId: 43, author: 'Carol', text: `${WELL_FORMED}\n` });
  assert.equal((prefill.match(/tipatask:reply:/g) || []).length, 1);
  const reply = parseReplyCitation(`${prefill}Agreed.`);
  assert.equal(reply.commentId, 43);
  assert.equal(reply.quote, '@Anton Matiienko I will take it today.');
});

test('buildReplyCitation: CRLF text and a multi-line author name are normalized', () => {
  const prefill = buildReplyCitation({ commentId: 2, author: ' Ann\nLee ', text: 'one\r\ntwo' });
  assert.equal(prefill, '<!-- tipatask:reply:2 -->\n> **Ann Lee:** one\n> two\n\n@Ann Lee ');
});

test('buildReplyCitation: rejects a missing or invalid comment id', () => {
  for (const commentId of [undefined, null, 0, -1, 1.5, 'abc']) {
    assert.throws(() => buildReplyCitation({ commentId, author: 'Ann', text: 'x' }), TypeError);
  }
  assert.equal(buildReplyCitation({ commentId: '17', author: 'Ann', text: 'x' }).startsWith('<!-- tipatask:reply:17 -->'), true);
});

// ── 2. Source parity (skips when api/ is not checked out) ──
//
// api/ belongs to the enclosing Tipatask monorepo, not to this repository: a standalone clone
// of this repository, or the packaged app built from one, has no api/ directory beside it.
// Absent is a normal state, not a failure — the same skip as mention-highlight.test.js and
// src/server/transliteration.test.js.

const SOURCE_OF_TRUTH_PATH = path.join(__dirname, '..', '..', '..', '..', '..', 'api', 'src', 'lib', 'comment-reply.js');
const hasSourceOfTruth = fs.existsSync(SOURCE_OF_TRUTH_PATH);
const NEEDS_SOURCE = {
  skip: hasSourceOfTruth
    ? false
    : 'api/src/lib/comment-reply.js is not checked out here (it belongs to the enclosing Tipatask monorepo, not this repository); hand-sync parity is only checkable when both are checked out together.',
};

// The shared code: from the REPLY_QUOTE_MAX line up to (not including) the exports line, which
// is `module.exports = …` in the API's CommonJS file and `export { … }` in this ES module.
function sharedCode(source, exportsLine, file) {
  const start = source.indexOf('const REPLY_QUOTE_MAX = ');
  const end = source.lastIndexOf(`\n${exportsLine}`);
  assert.ok(start >= 0, `${file} no longer declares REPLY_QUOTE_MAX; update sharedCode() in comment-reply.test.js if it moved.`);
  assert.ok(end > start, `${file} no longer ends with its "${exportsLine}" line; update sharedCode() in comment-reply.test.js if it changed.`);
  return source.slice(start, end + 1);
}

test('comment-reply.js shares its code byte for byte with api/src/lib/comment-reply.js', NEEDS_SOURCE, () => {
  const api = sharedCode(fs.readFileSync(SOURCE_OF_TRUTH_PATH, 'utf8'), 'module.exports = {', 'api/src/lib/comment-reply.js');
  const client = sharedCode(fs.readFileSync(path.join(__dirname, 'comment-reply.js'), 'utf8'), 'export {', 'src/client/comment-reply.js');
  assert.ok(
    client === api,
    'src/client/comment-reply.js has drifted from api/src/lib/comment-reply.js. This repository cannot ' +
      'import across the gitlink into api/, so the two copies are kept in sync by hand: copy the code ' +
      'between the REPLY_QUOTE_MAX line and the exports line across, in whichever direction the change ' +
      'was made. If you changed neither file, your api/ checkout is probably stale; it is a separate ' +
      'repository and does not move with this one.'
  );
});

test('comment-reply.js exports the same names as api/src/lib/comment-reply.js', NEEDS_SOURCE, () => {
  const apiExports = /module\.exports = \{([^}]*)\};/.exec(fs.readFileSync(SOURCE_OF_TRUTH_PATH, 'utf8'));
  const clientExports = /\nexport \{([^}]*)\};/.exec(fs.readFileSync(path.join(__dirname, 'comment-reply.js'), 'utf8'));
  const names = (match) => match[1].split(',').map(s => s.trim()).filter(Boolean).sort();
  assert.ok(apiExports && clientExports, 'an exports line is missing');
  assert.deepEqual(names(clientExports), names(apiExports));
});
