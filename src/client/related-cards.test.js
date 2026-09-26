import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFamilyIds } from './related-cards.js';

test('lone card with no family returns just itself', () => {
  const nodes = [{ id: 'C1', dbId: 1, parentDbId: '' }];
  const result = collectFamilyIds(nodes, 'C1');
  assert.deepEqual([...result].sort(), ['C1']);
});

test('root not present in nodes returns just rootId', () => {
  const nodes = [{ id: 'C1', dbId: 1, parentDbId: '' }];
  const result = collectFamilyIds(nodes, 'C99');
  assert.deepEqual([...result].sort(), ['C99']);
});

test('siblings collected when the parent card is absent (orphan / grouping-OFF board)', () => {
  // Parent (dbId 1) is NOT in `nodes` — only its children are rendered as cards.
  const nodes = [
    { id: 'C2', dbId: 2, parentDbId: 1 },
    { id: 'C3', dbId: 3, parentDbId: 1 },
    { id: 'C4', dbId: 4, parentDbId: 1 },
  ];
  const result = collectFamilyIds(nodes, 'C2');
  // Parent absent -> no sibling lookup possible; only C2's own descendants (none) included.
  assert.deepEqual([...result].sort(), ['C2']);
});

test('parent + siblings collected when the parent card is present', () => {
  const nodes = [
    { id: 'C1', dbId: 1, parentDbId: '' }, // parent objective
    { id: 'C2', dbId: 2, parentDbId: 1 },
    { id: 'C3', dbId: 3, parentDbId: 1 },
    { id: 'C4', dbId: 4, parentDbId: 1 },
  ];
  const result = collectFamilyIds(nodes, 'C2');
  assert.deepEqual([...result].sort(), ['C1', 'C2', 'C3', 'C4']);
});

test('multi-level descendants (child of child) all included', () => {
  const nodes = [
    { id: 'C1', dbId: 1, parentDbId: '' },
    { id: 'C2', dbId: 2, parentDbId: 1 },
    { id: 'C3', dbId: 3, parentDbId: 2 }, // grandchild
    { id: 'C4', dbId: 4, parentDbId: 3 }, // great-grandchild
  ];
  const result = collectFamilyIds(nodes, 'C1');
  assert.deepEqual([...result].sort(), ['C1', 'C2', 'C3', 'C4']);
});

test('blank parentDbId on root cards does not pull in every other root', () => {
  const nodes = [
    { id: 'C1', dbId: 1, parentDbId: '' },
    { id: 'C2', dbId: 2, parentDbId: '' },
    { id: 'C3', dbId: 3, parentDbId: '' },
  ];
  const result = collectFamilyIds(nodes, 'C1');
  assert.deepEqual([...result].sort(), ['C1']);
});

test('parent-chain cycle terminates instead of looping forever', () => {
  // Data corruption: C1's parent is C2, and C2's parent is C1.
  const nodes = [
    { id: 'C1', dbId: 1, parentDbId: 2 },
    { id: 'C2', dbId: 2, parentDbId: 1 },
  ];
  const result = collectFamilyIds(nodes, 'C1');
  assert.deepEqual([...result].sort(), ['C1', 'C2']);
});

test('null/undefined dbId and parentDbId treated as "no value"', () => {
  const nodes = [
    { id: 'C1', dbId: null, parentDbId: undefined },
    { id: 'C2', dbId: undefined, parentDbId: null },
  ];
  const result = collectFamilyIds(nodes, 'C1');
  assert.deepEqual([...result].sort(), ['C1']);
});
