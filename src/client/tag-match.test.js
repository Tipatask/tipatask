import assert from 'node:assert/strict';
import { test } from 'node:test';

const { tagName, tagDescription, filterTagOptions } = await import('./tag-match.js');

// ── tagName ──

test('tagName: string entry returns itself', () => {
  assert.equal(tagName('tt-task-board'), 'tt-task-board');
});

test('tagName: object entry returns .name', () => {
  assert.equal(tagName({ name: 'tt-task-board', description: 'x' }), 'tt-task-board');
});

test('tagName: nullish entry returns undefined', () => {
  assert.equal(tagName(null), undefined);
  assert.equal(tagName(undefined), undefined);
});

// ── tagDescription ──

test('tagDescription: object entry field wins over Map', () => {
  const descriptions = new Map([['dep-graph', 'from map']]);
  assert.equal(tagDescription({ name: 'dep-graph', description: 'from object' }, descriptions), 'from object');
});

test('tagDescription: null object field falls back to Map', () => {
  const descriptions = new Map([['dep-graph', 'from map']]);
  assert.equal(tagDescription({ name: 'dep-graph', description: null }, descriptions), 'from map');
});

test('tagDescription: string entry resolves from Map', () => {
  const descriptions = new Map([['dep-graph', 'cycle guard']]);
  assert.equal(tagDescription('dep-graph', descriptions), 'cycle guard');
});

test('tagDescription: missing descriptions arg does not throw', () => {
  assert.equal(tagDescription('dep-graph', null), null);
  assert.equal(tagDescription('dep-graph'), null);
});

test('tagDescription: undefined description field falls back to Map (not null)', () => {
  const descriptions = new Map([['dep-graph', 'cycle guard']]);
  assert.equal(tagDescription({ name: 'dep-graph' }, descriptions), 'cycle guard');
});

// ── filterTagOptions ──

const TAGS = [
  { name: 'tt-task-board', description: 'Task App kanban board UI' },
  { name: 'dep-graph', description: 'Pure dependency-cycle guard for the deps typeahead' },
  { name: 'tt-web-board', description: 'Board page (pages/board.js)' },
  { name: 'bugfix', description: null },
];

test('filterTagOptions: empty query returns nothing', () => {
  assert.deepEqual(filterTagOptions(TAGS, ''), []);
  assert.deepEqual(filterTagOptions(TAGS, '   '), []);
});

test('filterTagOptions: name substring hit', () => {
  const result = filterTagOptions(TAGS, 'graph');
  assert.deepEqual(result.map(e => e.name), ['dep-graph']);
});

test('filterTagOptions: description-only hit surfaces the tag', () => {
  // "cycle" appears only in dep-graph's description, not in any name.
  const result = filterTagOptions(TAGS, 'cycle');
  assert.deepEqual(result.map(e => e.name), ['dep-graph']);
});

test('filterTagOptions: name hits rank above description-only hits', () => {
  // "board" is a substring of tt-task-board / tt-web-board names AND of
  // tt-task-board's description ("kanban board UI") — must not duplicate, and
  // description-only hits must sort after every name hit.
  const result = filterTagOptions(TAGS, 'board');
  assert.deepEqual(result.map(e => e.name), ['tt-task-board', 'tt-web-board']);
});

test('filterTagOptions: limit applied after ranking, name hits never evicted', () => {
  const tags = [
    { name: 'aaa', description: 'no match here' },
    { name: 'bbb', description: 'zzz in description' },
    { name: 'ccc-zzz', description: 'irrelevant' },
  ];
  // "zzz" matches ccc-zzz by name and bbb by description only. With limit 1, the
  // name hit must win even though bbb sorts first in the input array.
  const result = filterTagOptions(tags, 'zzz', { limit: 1 });
  assert.deepEqual(result.map(e => e.name), ['ccc-zzz']);
});

test('filterTagOptions: selected excluded case-insensitively', () => {
  const result = filterTagOptions(TAGS, 'graph', { selected: ['DEP-GRAPH'] });
  assert.deepEqual(result, []);
});

test('filterTagOptions: nameMatch prefix rejects mid-word name hit, still allows its description hit', () => {
  // "task" is not a prefix of tt-task-board's name, so under prefix mode it must not
  // match by name — but it IS a substring of the description ("Task App kanban...").
  const result = filterTagOptions(TAGS, 'task', { nameMatch: 'prefix' });
  assert.deepEqual(result.map(e => e.name), ['tt-task-board']);
});

test('filterTagOptions: nameMatch prefix matches a true name prefix', () => {
  const result = filterTagOptions(TAGS, 'tt-task', { nameMatch: 'prefix' });
  assert.deepEqual(result.map(e => e.name), ['tt-task-board']);
});

test('filterTagOptions: string entries resolve description from the Map', () => {
  const tags = ['dep-graph', 'tt-task-board'];
  const descriptions = new Map([['dep-graph', 'cycle guard for deps typeahead']]);
  const result = filterTagOptions(tags, 'cycle', { descriptions });
  assert.deepEqual(result, ['dep-graph']);
});

test('filterTagOptions: null description on an entry does not throw and is simply not matched', () => {
  const result = filterTagOptions(TAGS, 'bugfix');
  assert.deepEqual(result.map(e => e.name), ['bugfix']);
});

test('filterTagOptions: case-insensitive on both name and description', () => {
  const result = filterTagOptions(TAGS, 'CYCLE');
  assert.deepEqual(result.map(e => e.name), ['dep-graph']);
});
