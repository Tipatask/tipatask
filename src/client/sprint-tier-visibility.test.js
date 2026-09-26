import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeTierWindow, HIDE_CLASS } from './sprint-tier-visibility.js';

test('HIDE_CLASS is the shared empty-tier marker', () => {
  assert.equal(HIDE_CLASS, 'tier--empty');
});

test('empty tierKeys → empty result, no crash', () => {
  const r = computeTierWindow([], { hasActiveMatch: () => false, hasAnyMatch: () => false });
  assert.deepEqual(r, { visibleKeys: [], emptyKeys: [], hiddenCount: 0 });
});

test('allStepsLoaded short-circuits to every matching key, hiddenCount 0 — card-less tiers still surface as emptyKeys', () => {
  const r = computeTierWindow([1, 2, 3], {
    allStepsLoaded: true,
    hasActiveMatch: () => false,
    hasAnyMatch: k => k !== 3,
  });
  assert.deepEqual(r, { visibleKeys: [1, 2], emptyKeys: [3], hiddenCount: 0 });
});

test('only tiers with an active card are drawn by default', () => {
  const active = new Set([3, 5]);
  const r = computeTierWindow([1, 2, 3, 4, 5], {
    extraStepsLoaded: 0,
    hasActiveMatch: k => active.has(k),
    hasAnyMatch: k => active.has(k),
  });
  assert.deepEqual(r.visibleKeys, [3, 5]);
});

test('all-closed tiers land in the reveal pool (not drawn); card-less tiers surface separately as emptyKeys', () => {
  // 1,2 all-closed (hasAnyMatch true, hasActiveMatch false); 3 active; 4 card-less
  const r = computeTierWindow([1, 2, 3, 4], {
    extraStepsLoaded: 0,
    hasActiveMatch: k => k === 3,
    hasAnyMatch: k => k === 1 || k === 2 || k === 3,
  });
  assert.deepEqual(r.visibleKeys, [3]);
  assert.deepEqual(r.emptyKeys, [4]);
  assert.equal(r.hiddenCount, 2); // 1 and 2 sit in the pool; 4 is card-less, never counted here
});

test('extraStepsLoaded reveals newest-done-first from the pool', () => {
  const closed = [10, 20, 30]; // ascending, all-closed
  const r = computeTierWindow([10, 20, 30, 40], {
    extraStepsLoaded: 2,
    hasActiveMatch: k => k === 40,
    hasAnyMatch: k => closed.includes(k) || k === 40,
  });
  // pool = [10,20,30] ascending; slice(-2) = [20,30] (newest completed first off the pool tail)
  assert.deepEqual(r.visibleKeys, [20, 30, 40]);
  assert.deepEqual(r.emptyKeys, []);
  assert.equal(r.hiddenCount, 1); // only 10 left hidden
});

test('hiddenCount === pool.length - revealed — Show More never reveals nothing', () => {
  const closed = [1, 2, 3, 4, 5];
  const hasAnyMatch = k => closed.includes(k);
  const hasActiveMatch = () => false;
  let extraStepsLoaded = 0;
  let prevVisibleLen = 0;
  for (let clicks = 1; clicks <= closed.length + 1; clicks++) {
    const before = computeTierWindow(closed, { extraStepsLoaded, hasActiveMatch, hasAnyMatch });
    if (before.hiddenCount === 0) break;
    extraStepsLoaded += 10; // Show More bumps by 10 same as task-board.js
    const after = computeTierWindow(closed, { extraStepsLoaded, hasActiveMatch, hasAnyMatch });
    assert.ok(after.visibleKeys.length > before.visibleKeys.length, 'click must reveal something');
    prevVisibleLen = after.visibleKeys.length;
  }
  assert.ok(prevVisibleLen > 0);
});

test('no active tier anywhere → falls back to newest tier with ANY card, not newest key period', () => {
  // 5 is a synthesized empty future sprint (hasAnyMatch false); 4 is the newest tier with a
  // (closed) card. Must seed 4, never blank-render on 5.
  const r = computeTierWindow([1, 2, 3, 4, 5], {
    extraStepsLoaded: 0,
    hasActiveMatch: () => false,
    hasAnyMatch: k => k === 2 || k === 4,
  });
  assert.deepEqual(r.visibleKeys, [4]);
  assert.deepEqual(r.emptyKeys, [1, 3, 5]);
  assert.equal(r.hiddenCount, 1); // 2 left in the pool
});

test('all-empty input (no tier has any card) → visibleKeys empty, everything is emptyKeys, hiddenCount 0', () => {
  const r = computeTierWindow([1, 2, 3], {
    extraStepsLoaded: 5,
    hasActiveMatch: () => false,
    hasAnyMatch: () => false,
  });
  assert.deepEqual(r, { visibleKeys: [], emptyKeys: [1, 2, 3], hiddenCount: 0 });
});

test('visibleKeys stays ascending across active + revealed pool tiers', () => {
  const closed = [2, 4, 6];
  const r = computeTierWindow([1, 2, 3, 4, 5, 6, 7], {
    extraStepsLoaded: 10,
    hasActiveMatch: k => k === 1 || k === 7,
    hasAnyMatch: k => closed.includes(k) || k === 1 || k === 7,
  });
  const sorted = [...r.visibleKeys].sort((a, b) => a - b);
  assert.deepEqual(r.visibleKeys, sorted);
  assert.deepEqual(r.visibleKeys, [1, 2, 4, 6, 7]);
  assert.deepEqual(r.emptyKeys, [3, 5]);
  assert.equal(r.hiddenCount, 0);
});

test('emptyKeys and visibleKeys are always disjoint and, with the (unrevealed) pool, exhaustive over tierKeys', () => {
  const keys = [1, 2, 3, 4, 5, 6];
  const hasActiveMatch = k => k === 6;
  const hasAnyMatch = k => k === 2 || k === 4 || k === 6; // 1,3,5 card-less; 2,4 all-closed
  const r = computeTierWindow(keys, { extraStepsLoaded: 0, hasActiveMatch, hasAnyMatch });
  const overlap = r.visibleKeys.filter(k => r.emptyKeys.includes(k));
  assert.deepEqual(overlap, []);
  assert.deepEqual(r.emptyKeys, [1, 3, 5]);
  assert.deepEqual(r.visibleKeys, [6]);
  assert.equal(r.hiddenCount, 2); // 2 and 4 sit in the unrevealed pool
});
