import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSingleItemList } from './description-list.js';

test('lone "1." item becomes prose', () => {
  assert.equal(normalizeSingleItemList('1. @a.js foo() — do X; verify Y.'), '@a.js foo() — do X; verify Y.');
  assert.equal(normalizeSingleItemList('1) Do X.'), 'Do X.');
});

test('context paragraph plus lone "1." keeps paragraphs, drops marker', () => {
  assert.equal(normalizeSingleItemList('Context.\n\n1. Do X.'), 'Context.\n\nDo X.');
});

test('two or more numbered items are left unchanged', () => {
  const text = '1. Do X.\n\n2. Do Y.';
  assert.equal(normalizeSingleItemList(text), text);
});

test('a lone item not numbered 1 is left unchanged', () => {
  assert.equal(normalizeSingleItemList('3. Do X.'), '3. Do X.');
});

test('numbered lines inside code fences are ignored', () => {
  assert.equal(normalizeSingleItemList('1. Run it.\n\n```\n2. not a step\n```'), 'Run it.\n\n```\n2. not a step\n```');
  const fenceOnly = 'Prose.\n\n```\n1. code\n```';
  assert.equal(normalizeSingleItemList(fenceOnly), fenceOnly);
});

test('idempotent and safe on non-strings', () => {
  const once = normalizeSingleItemList('1. Do X.');
  assert.equal(normalizeSingleItemList(once), once);
  assert.equal(normalizeSingleItemList(''), '');
  assert.equal(normalizeSingleItemList(null), null);
  assert.equal(normalizeSingleItemList(undefined), undefined);
});

test('chat-task-preview.js normalizes descriptions on render and both save paths', () => {
  const src = readFileSync(new URL('./chat-task-preview.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ normalizeSingleItemList \} from '\.\/description-list\.js'/);
  assert.match(src, /const t = c\.task;\n\s+normalizeCardDescription\(c\);/);
  assert.match(src, /normalizePerformanceSuggestionCard\(card\);\n\s+normalizeCardDescription\(card\);/);
  assert.match(src, /normalizePerformanceSuggestionCard\(change\);\n\s+normalizeCardDescription\(change\);/);
});
