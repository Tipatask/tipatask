import assert from 'node:assert/strict';
import { test } from 'node:test';

const { buildDepGraph, collectCycleBlocked } = await import('./dep-graph.js');

// C1093: buildDepGraph is a node-id -> lowercased-dep-keys[] Map, no DOM/import
// dependency, unit-testable the same way utils.js/dep-priority.js are.
test('buildDepGraph lowercases keys and reads dependencies off each entry', () => {
  const graph = buildDepGraph([
    { id: 'C1', dependencies: ['C2'] },
    { id: 'c2', dependencies: [] },
  ]);
  assert.deepEqual(graph.get('c1'), ['c2']);
  assert.deepEqual(graph.get('c2'), []);
});

test('buildDepGraph tolerates missing/null dependencies and a non-array entries arg', () => {
  const graph = buildDepGraph([{ id: 'C1' }, { id: 'C2', dependencies: null }, { id: '' }, null]);
  assert.deepEqual(graph.get('c1'), []);
  assert.deepEqual(graph.get('c2'), []);
  assert.equal(graph.size, 2);
  assert.deepEqual(buildDepGraph(undefined), new Map());
});

// ── collectCycleBlocked ──
// Graph edges read "node depends on dep" (node -> dep). Picking a candidate Y as
// a new dependency of root R adds edge R->Y; that closes a cycle iff Y already
// reaches R along EXISTING edges (Y -> ... -> R), i.e. Y is already an ancestor
// of R in the depends-on graph. collectCycleBlocked returns exactly that
// ancestor set (found by walking the reverse graph outward from the roots).

test('collectCycleBlocked blocks a task that already directly depends on the root', () => {
  // B -> A  (B depends on A). Root = A: B must not be offered as a new dep of A,
  // since A->B would close the 2-cycle A->B->A.
  const graph = buildDepGraph([{ id: 'A', dependencies: [] }, { id: 'B', dependencies: ['A'] }]);
  const blocked = collectCycleBlocked(graph, ['A']);
  assert.equal(blocked.has('b'), true);
});

test('collectCycleBlocked blocks a transitive ancestor: C -> B -> A, root A must not accept C either', () => {
  const graph = buildDepGraph([
    { id: 'A', dependencies: [] },
    { id: 'B', dependencies: ['A'] },
    { id: 'C', dependencies: ['B'] },
  ]);
  const blocked = collectCycleBlocked(graph, ['A']);
  assert.equal(blocked.has('b'), true);
  assert.equal(blocked.has('c'), true, 'C reaches root A transitively through B');
});

test('collectCycleBlocked leaves an unrelated candidate untouched', () => {
  const graph = buildDepGraph([
    { id: 'A', dependencies: [] },
    { id: 'B', dependencies: ['A'] },
    { id: 'D', dependencies: [] }, // no relation to A or B at all
  ]);
  const blocked = collectCycleBlocked(graph, ['A']);
  assert.equal(blocked.has('d'), false);
});

test('collectCycleBlocked does NOT block a task the root merely depends on (wrong direction)', () => {
  // A -> B (A depends on B). Root = A: B is a real dependency already, not a
  // cycle risk to re-surface here — that's filtered separately by the "already
  // selected" check in refreshDropdown, not by cycle detection.
  const graph = buildDepGraph([{ id: 'A', dependencies: ['B'] }, { id: 'B', dependencies: [] }]);
  const blocked = collectCycleBlocked(graph, ['A']);
  assert.equal(blocked.has('b'), false);
});

test('collectCycleBlocked includes the root itself (self-dependency guard)', () => {
  const graph = buildDepGraph([{ id: 'A', dependencies: [] }]);
  const blocked = collectCycleBlocked(graph, ['A']);
  assert.equal(blocked.has('a'), true);
});

test('collectCycleBlocked terminates on data that already contains a cycle', () => {
  // Pre-existing cycle: A -> B -> A. Must not infinite-loop; blocked set is finite.
  const graph = buildDepGraph([
    { id: 'A', dependencies: ['B'] },
    { id: 'B', dependencies: ['A'] },
    { id: 'C', dependencies: [] },
  ]);
  const blocked = collectCycleBlocked(graph, ['A']);
  assert.equal(blocked.has('a'), true);
  assert.equal(blocked.has('b'), true);
  assert.equal(blocked.has('c'), false);
});

test('collectCycleBlocked tolerates a dependency key with no matching node', () => {
  const graph = buildDepGraph([{ id: 'A', dependencies: ['GHOST'] }]);
  const blocked = collectCycleBlocked(graph, ['A']);
  // GHOST has no reverse edges of its own (nothing depends on it), so nothing
  // new gets blocked from it — this must not throw.
  assert.equal(blocked.has('a'), true);
});

test('collectCycleBlocked returns empty set for no roots', () => {
  const graph = buildDepGraph([{ id: 'A', dependencies: [] }]);
  assert.deepEqual(collectCycleBlocked(graph, []), new Set());
  assert.deepEqual(collectCycleBlocked(graph, undefined), new Set());
});

test('collectCycleBlocked unions ancestors across multiple simultaneous roots (bulk "Set Dependencies" case)', () => {
  // X depends on A; Y depends on B. Editing both A and B at once (bulk modal)
  // must block both X (for A) and Y (for B) from the single shared candidate list.
  const graph = buildDepGraph([
    { id: 'A', dependencies: [] },
    { id: 'B', dependencies: [] },
    { id: 'X', dependencies: ['A'] },
    { id: 'Y', dependencies: ['B'] },
    { id: 'Z', dependencies: [] },
  ]);
  const blocked = collectCycleBlocked(graph, ['A', 'B']);
  assert.equal(blocked.has('x'), true);
  assert.equal(blocked.has('y'), true);
  assert.equal(blocked.has('z'), false);
});
