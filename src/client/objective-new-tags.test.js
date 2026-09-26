import assert from 'node:assert/strict';
import { test } from 'node:test';

const { selectNewTagsForCards, attachNewTagsPayload } = await import('./objective-new-tags.js');

// C1439 — per-card ✓ Accept (chat-task-preview.js's saveTaskChange()) never attached
// new_tags at all; the bulk "Save Tasks" button did, filtering msg.newTags down to
// names on the accepted cards. This module is the shared, testable extraction of that
// filter, used by both save paths now.

test('selectNewTagsForCards: keeps only entries whose name appears on at least one card', () => {
  const newTags = [
    { name: 'tt-new-module', description: 'a' },
    { name: 'config', description: 'b' },
    { name: 'unrelated', description: 'c' },
  ];
  const cards = [{ task: { id: 'C1', tags: ['tt-new-module', 'bugfix'] } }, { task: { id: 'C2', tags: ['config'] } }];

  const result = selectNewTagsForCards(newTags, cards);
  assert.deepEqual(result.map(t => t.name).sort(), ['config', 'tt-new-module']);
});

test('selectNewTagsForCards: matches trimmed/case-folded, so a drifted case on either side still registers', () => {
  const newTags = [{ name: '  Config  ', description: 'x' }];
  const cards = [{ task: { id: 'C1', tags: ['config'] } }];
  assert.deepEqual(selectNewTagsForCards(newTags, cards).map(t => t.name), ['  Config  ']);
});

test('selectNewTagsForCards: dedupes by folded name, first occurrence wins', () => {
  const newTags = [{ name: 'config', description: 'first' }, { name: 'Config', description: 'second' }];
  const cards = [{ task: { id: 'C1', tags: ['config'] } }];
  const result = selectNewTagsForCards(newTags, cards);
  assert.equal(result.length, 1);
  assert.equal(result[0].description, 'first');
});

test('selectNewTagsForCards: empty/missing inputs return an empty array, never throw', () => {
  assert.deepEqual(selectNewTagsForCards(undefined, [{ task: { tags: ['x'] } }]), []);
  assert.deepEqual(selectNewTagsForCards([{ name: 'x', description: 'y' }], undefined), []);
  assert.deepEqual(selectNewTagsForCards([], []), []);
  assert.deepEqual(selectNewTagsForCards([{ name: 'x', description: 'y' }], [{ task: {} }]), []);
});

test('attachNewTagsPayload: sets data.new_tags only when something matched — never an empty array where the old shape sent nothing', () => {
  const dataWithMatch = {};
  attachNewTagsPayload(dataWithMatch, [{ name: 'config', description: 'x' }], [{ task: { tags: ['config'] } }]);
  assert.deepEqual(dataWithMatch.new_tags, [{ name: 'config', description: 'x' }]);

  const dataNoMatch = {};
  attachNewTagsPayload(dataNoMatch, [{ name: 'config', description: 'x' }], [{ task: { tags: ['bugfix'] } }]);
  assert.equal('new_tags' in dataNoMatch, false);

  const dataNoNewTags = {};
  attachNewTagsPayload(dataNoNewTags, [], [{ task: { tags: ['bugfix'] } }]);
  assert.equal('new_tags' in dataNoNewTags, false);
});

test('attachNewTagsPayload: appends to any pre-existing data.new_tags rather than replacing it', () => {
  const data = { new_tags: [{ name: 'legacy-tag', description: 'already there' }] };
  attachNewTagsPayload(data, [{ name: 'config', description: 'x' }], [{ task: { tags: ['config'] } }]);
  assert.deepEqual(data.new_tags, [
    { name: 'legacy-tag', description: 'already there' },
    { name: 'config', description: 'x' },
  ]);
});
