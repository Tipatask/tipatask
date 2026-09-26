'use strict';

// C1576 — unit tests for the hand-synced transliteration.js twin (source of truth:
// api/src/lib/transliteration.js — see that file's own C1571 header, and this module's
// header comment for why it's a copy, not a require).
//
// Two halves:
//   1. Behavioral coverage (always runs) — the same 11-language fixture table and edge
//      cases as api/src/lib/transliteration.test.js, so this copy is proven correct even
//      when api/ isn't checked out — ai/todo/server is a separate git submodule/repo with
//      its own remote, so a standalone clone of it (or the packaged app, built from that
//      clone) has no api/ directory at all.
//   2. Source-text parity (skips when api/ is absent) — the two files must stay
//      byte-identical from their first line of code onward. A table edited on one side
//      only is exactly the drift this catches; per-function extraction (the tag-stub.js
//      precedent) would miss a table-only edit, so this compares the whole body.
//
// Run under node 22 (`nvm use 22`); the default node on PATH here is v14.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { transliterate } = require('./transliteration');

const ASCII_RE = /^[a-z0-9 -]*$/;

// ── 1. Behavioral coverage — mirrors api/src/lib/transliteration.test.js's FIXTURES ──

const FIXTURES = [
  ['German', 'Grüße aus München, Straße', 'grusse aus munchen strasse'],
  ['French', 'Château à Noël, œuvre française', 'chateau a noel oeuvre francaise'],
  ['Chinese (Simplified)', '北京欢迎你', 'bei jing huan ying ni'],
  ['Chinese (Traditional)', '臺北歡迎你', 'tai bei huan ying ni'],
  ['Ukrainian', 'Йосип Їжак з Києва, щастя', 'yosyp yizhak z kyieva shchastia'],
  ['Spanish', 'El Niño y la mañana', 'el nino y la manana'],
  ['Brazilian Portuguese', 'São Paulo coração ação', 'sao paulo coracao acao'],
  ['Korean', '한국어 안녕하세요 김치', 'hangugeo annyeonghaseyo gimci'],
  ['Polish', 'Łódź żółć gęś', 'lodz zolc ges'],
  ['Japanese', 'がっこう しゃしん ラーメン', 'gatukou siyasin ramen'],
  ['Turkish', 'İstanbul ışık Şişli', 'istanbul isik sisli'],
];

for (const [lang, input, expected] of FIXTURES) {
  test(`${lang} fixture transliterates to expected ASCII`, () => {
    assert.equal(transliterate(input), expected);
  });
}

test('every fixture output matches the ASCII charset guarantee /^[a-z0-9 -]*$/', () => {
  for (const [lang, input] of FIXTURES) {
    const out = transliterate(input);
    assert.match(out, ASCII_RE, `${lang} output ${JSON.stringify(out)} broke the charset guarantee`);
  }
});

test('empty, null, and undefined input transliterate to empty string', () => {
  assert.equal(transliterate(''), '');
  assert.equal(transliterate(null), '');
  assert.equal(transliterate(undefined), '');
});

test('non-string input is coerced via String()', () => {
  assert.equal(transliterate(42), '42');
});

test('emoji-only input transliterates to empty string', () => {
  assert.equal(transliterate('😀 🚀'), '');
});

test('symbols expand then hyphen runs collapse', () => {
  assert.equal(transliterate('№ § € — –'), 'no ss eu');
});

test('capital ẞ is fixed to ss (package bug — it drops ẞ entirely)', () => {
  assert.equal(transliterate('ß ẞ Straße'), 'ss ss strasse');
});

test('apostrophe is deleted, not treated as a word boundary (Ukrainian м\'яч)', () => {
  assert.equal(transliterate("м'яч"), 'miach');
});

test('the зг -> zgh digraph exception does not collide with ж -> zh', () => {
  assert.equal(transliterate('Жозе зГрупи'), 'zhoze zghrupy');
});

test('KMU 55:2010 word-initial vs mid-word positional forms', () => {
  assert.equal(transliterate('Ялта Юрій Єва Їжак'), 'yalta yurii yeva yizhak');
});

test('ґ transliterates to g with no leaking apostrophe', () => {
  assert.equal(transliterate('ґудзик'), 'gudzyk');
});

test('the project\'s own name round-trips through the Ukrainian pass', () => {
  assert.equal(transliterate('Тіпатаск'), 'tipatask');
});

test('NFKC folds half-width katakana and composes dakuten', () => {
  assert.equal(transliterate('ﾊﾝｶｸ ｶﾞ'), 'hankaku ga');
});

test('hyphens survive; repeated hyphens collapse to one', () => {
  assert.equal(transliterate('Jean-Luc  --  Picard'), 'jean-luc - picard');
});

test('kanji romanize as Mandarin pinyin, not Japanese readings (documented limitation)', () => {
  assert.equal(transliterate('東京'), 'dong jing');
});

test('a hostile mixed string of every edge case still matches the charset guarantee', () => {
  const out = transliterate('ß ẞ № ・ 😀 ﾊﾝｶｸ ґ');
  assert.match(out, ASCII_RE, `output ${JSON.stringify(out)} broke the charset guarantee`);
});

// ── 2. Hand-sync parity with the API source of truth ──

// api/ belongs to the enclosing Tipatask monorepo, not to this (ai/todo/server) repo — a
// standalone clone of this repo on its own remote, or the packaged app built from one,
// never has an api/ directory alongside it. Absent is a normal state, not a failure, same
// skip-when-absent technique as api/src/lib/tag-stub.test.js's check against this repo's
// tag-doc-link.js (mirrored in the opposite direction here).
const SOURCE_OF_TRUTH_PATH = path.join(__dirname, '..', '..', '..', '..', '..', 'api', 'src', 'lib', 'transliteration.js');
const hasSourceOfTruth = fs.existsSync(SOURCE_OF_TRUTH_PATH);
const NEEDS_SOURCE = {
  skip: hasSourceOfTruth
    ? false
    : 'api/src/lib/transliteration.js is not checked out here (belongs to the enclosing Tipatask monorepo, not this repo) — hand-sync parity is only checkable when both are checked out together.',
};

// Both files declare the exact same require line; everything from there to EOF must be
// byte-identical. Headers legitimately differ (different "why does this copy exist"
// framing on each side) and are excluded.
const BODY_MARKER = "const { transliterate: unidecode } = require('transliteration');";

function bodyFrom(src) {
  const i = src.indexOf(BODY_MARKER);
  return i === -1 ? null : src.slice(i);
}

test('this file is byte-identical (from the require line to EOF) to its hand-synced original in api/src/lib/transliteration.js', NEEDS_SOURCE, () => {
  const sourceOfTruth = fs.readFileSync(SOURCE_OF_TRUTH_PATH, 'utf8');
  const mine = fs.readFileSync(path.join(__dirname, 'transliteration.js'), 'utf8');

  const sourceBody = bodyFrom(sourceOfTruth);
  const myBody = bodyFrom(mine);

  assert.ok(sourceBody, 'api/src/lib/transliteration.js no longer contains the expected require line — if it moved, update BODY_MARKER above.');
  assert.ok(myBody, 'transliteration.js no longer contains the expected require line.');
  assert.equal(myBody, sourceBody,
    'transliteration.js has drifted from its hand-synced original in api/src/lib/transliteration.js. ' +
    'ai/todo/server cannot require across the gitlink into api/, so the two copies are kept ' +
    'identical by hand: copy the changed logic across, in the same commit, in both directions ' +
    'of this diff. If you touched neither file, your api/ checkout is probably stale — it is a ' +
    'sibling repo and does not move with this one.');
});
