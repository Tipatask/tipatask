import assert from 'node:assert/strict';
import { test } from 'node:test';

const { attachOriginalSpecPayload, getOriginalSpec } = await import('./objective-spec-payload.js');

// C1376 regression guard: a reserved-key card must stay marked "new" (newTaskIds) even
// when there's no spec text to attach — losing newTaskIds skips assignIncomingNewTaskIds()'s
// reserveTaskKeys() call server-side, and the reservation placeholder ("New task" /
// "Reserved key — pending finalization.") never gets finalized with the real proposed
// content. See api-backend.js's overwriteRawWithRemap()/overwriteRaw() and
// api/src/routes/tasks.js's RESERVE_PLACEHOLDER_TITLE.

test('attachOriginalSpecPayload: sets newTaskIds even when the chat has no spec text', () => {
  const data = {};
  attachOriginalSpecPayload(data, ['C1070', 'C1083'], { messages: [] });
  assert.deepEqual(data.newTaskIds, ['C1070', 'C1083']);
  assert.equal('originalSpec' in data, false);
});

test('attachOriginalSpecPayload: sets both newTaskIds and originalSpec when a spec exists', () => {
  const data = {};
  const cs = { messages: [{ content: 'Build a widget catalog' }] };
  attachOriginalSpecPayload(data, ['C1070'], cs);
  assert.deepEqual(data.newTaskIds, ['C1070']);
  assert.equal(data.originalSpec, 'Build a widget catalog');
});

test('attachOriginalSpecPayload: omits both when there are no new task ids', () => {
  const data = { newTaskIds: ['stale'], originalSpec: 'stale spec' };
  const cs = { messages: [{ content: 'Build a widget catalog' }] };
  attachOriginalSpecPayload(data, [], cs);
  assert.equal('newTaskIds' in data, false);
  assert.equal('originalSpec' in data, false);
});

test('attachOriginalSpecPayload: dedupes and trims ids, drops blanks', () => {
  const data = {};
  attachOriginalSpecPayload(data, [' C1070 ', 'C1070', '', null, 'C1083'], null);
  assert.deepEqual(data.newTaskIds, ['C1070', 'C1083']);
});

test('getOriginalSpec: null for a missing/blank first message', () => {
  assert.equal(getOriginalSpec({ messages: [] }), null);
  assert.equal(getOriginalSpec({ messages: [{ content: '   ' }] }), null);
  assert.equal(getOriginalSpec({ messages: [{ content: 42 }] }), null);
});

test('getOriginalSpec: returns the first message content when present', () => {
  assert.equal(getOriginalSpec({ messages: [{ content: 'Build X' }] }), 'Build X');
});
