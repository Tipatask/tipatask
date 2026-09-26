import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const { isDragStateStale, resolveDropTier, shouldDeferForDrag } = await import('./drag-state.js');
const taskCardSource = fs.readFileSync(new URL('./task-card.js', import.meta.url), 'utf8');

test('isDragStateStale: both connected → not stale', () => {
  assert.equal(
    isDragStateStale({
      sourceCard: { isConnected: true },
      tierCards: { isConnected: true },
      clone: { isConnected: true },
      activated: true,
    }),
    false,
  );
});

test('isDragStateStale: missing activated clone → stale orphan', () => {
  assert.equal(
    isDragStateStale({
      sourceCard: { isConnected: true },
      tierCards: { isConnected: true },
      clone: null,
      activated: true,
    }),
    true,
  );
});

test('isDragStateStale: detached activated clone → stale', () => {
  assert.equal(
    isDragStateStale({
      sourceCard: { isConnected: true },
      tierCards: { isConnected: true },
      clone: { isConnected: false },
      activated: true,
    }),
    true,
  );
});

test('isDragStateStale: missing clone before activation is valid', () => {
  assert.equal(
    isDragStateStale({
      sourceCard: { isConnected: true },
      tierCards: { isConnected: true },
      clone: null,
      activated: false,
    }),
    false,
  );
});

test('isDragStateStale: source card detached → stale', () => {
  assert.equal(
    isDragStateStale({ sourceCard: { isConnected: false }, tierCards: { isConnected: true } }),
    true,
  );
});

test('isDragStateStale: tier container detached → stale', () => {
  assert.equal(
    isDragStateStale({ sourceCard: { isConnected: true }, tierCards: { isConnected: false } }),
    true,
  );
});

test('isDragStateStale: missing node → stale (defensive — real callers never pass this)', () => {
  assert.equal(isDragStateStale({ sourceCard: null, tierCards: { isConnected: true } }), true);
  assert.equal(isDragStateStale({ sourceCard: { isConnected: true }, tierCards: undefined }), true);
});

test('resolveDropTier: geometry resolves a different sprint when direct hit is stale source', () => {
  const source = { id: 'source' };
  const target = { id: 'target' };
  assert.equal(
    resolveDropTier({
      cursorX: 250,
      cursorY: 140,
      directHitTier: source,
      candidates: [
        { tier: source, rect: { left: 0, right: 200, top: 0, bottom: 100 } },
        { tier: target, rect: { left: 0, right: 500, top: 120, bottom: 220 } },
      ],
    }),
    target,
  );
});

test('resolveDropTier: sentinel-sized empty sprint is a valid target', () => {
  const emptyTier = { id: 'empty' };
  assert.equal(
    resolveDropTier({
      cursorX: 300,
      cursorY: 174,
      candidates: [
        { tier: emptyTier, rect: { left: 120, right: 720, top: 150, bottom: 198 } },
      ],
    }),
    emptyTier,
  );
});

test('resolveDropTier: valid direct hit wins when candidate rectangles overlap', () => {
  const outer = { id: 'outer' };
  const direct = { id: 'direct' };
  assert.equal(
    resolveDropTier({
      cursorX: 50,
      cursorY: 50,
      directHitTier: direct,
      candidates: [
        { tier: outer, rect: { left: 0, right: 100, top: 0, bottom: 100 } },
        { tier: direct, rect: { left: 25, right: 75, top: 25, bottom: 75 } },
      ],
    }),
    direct,
  );
});

test('resolveDropTier: ignores hidden or non-containing tiers and returns null', () => {
  assert.equal(
    resolveDropTier({
      cursorX: 50,
      cursorY: 50,
      candidates: [
        { tier: 'hidden', rect: { left: 0, right: 0, top: 0, bottom: 0 } },
        { tier: 'elsewhere', rect: { left: 100, right: 200, top: 100, bottom: 200 } },
      ],
    }),
    null,
  );
});

test('task-card resolves drop targets from every live tier on move and mouseup', () => {
  assert.match(taskCardSource, /function _resolveDropTierAtPoint\(cursorX, cursorY\)/);
  assert.match(taskCardSource, /querySelectorAll\('\.tier-cards'\)/);
  assert.match(taskCardSource, /resolveDropTier\(\{ cursorX, cursorY, directHitTier, candidates \}\)/);
  assert.match(taskCardSource, /const targetTier = _resolveDropTierAtPoint\(e\.clientX, e\.clientY\);/);
  assert.match(
    taskCardSource,
    /const targetTier = _resolveDropTierAtPoint\(e\.clientX, e\.clientY\) \|\| currentTier \|\| sourceTier;/,
  );
});

test('shouldDeferForDrag: no drag, no drop → render proceeds', () => {
  assert.equal(shouldDeferForDrag({ afterDrop: false, dragging: false, dropInProgress: false }), false);
});

test('shouldDeferForDrag: dragging → defer', () => {
  assert.equal(shouldDeferForDrag({ afterDrop: false, dragging: true, dropInProgress: false }), true);
});

test('shouldDeferForDrag: drop in progress → defer', () => {
  assert.equal(shouldDeferForDrag({ afterDrop: false, dragging: false, dropInProgress: true }), true);
});

test('shouldDeferForDrag: afterDrop escapes the guard even while dropInProgress is still true', () => {
  // (C1438) _onDragEnd's own post-commit render — _dropInProgress is only cleared in the
  // `finally` that runs AFTER this render, so without the afterDrop escape hatch the drop
  // would defer its own render and never repaint the order it just wrote.
  assert.equal(shouldDeferForDrag({ afterDrop: true, dragging: true, dropInProgress: true }), false);
});

test('window blur mid-drag routes through the unified teardown', () => {
  assert.match(
    taskCardSource,
    /function _onDragWindowBlur\(\)\s*\{\s*_cleanupDrag\(\);\s*\}/,
  );
  assert.match(taskCardSource, /window\.addEventListener\('blur', _onDragWindowBlur\)/);
  assert.match(taskCardSource, /window\.removeEventListener\('blur', _onDragWindowBlur\)/);
});

test('unified teardown sweeps orphaned drag artifacts and owns drop-final cleanup', () => {
  assert.match(
    taskCardSource,
    /querySelectorAll\('\.card-dragging-clone, \.card-drag-placeholder'\)/,
  );
  assert.match(taskCardSource, /document\.body\.classList\.remove\('board-dragging'\)/);
  assert.match(taskCardSource, /finally\s*\{\s*_cleanupDrag\(\);\s*\}/);
});
