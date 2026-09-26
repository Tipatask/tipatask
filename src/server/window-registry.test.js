'use strict';

// (C1388) Tests ../../main/window-registry.js from here, not next to it under main/ —
// npm test only globs 'src/**/*.test.js' (package.json), and main/ sits outside that.
// Same precedent as window-state-kb-sync.test.js, which tests main/window-state.js the
// same way. window-registry.js has zero electron dependency (no Module._load faking
// needed here, unlike that file) — it operates on any `{ isDestroyed(): bool }` shape.
//
// This module IS the fix for the one-window-per-project orphan bug: main.js's old
// inline `windowsByProject` Map let a window's `closed` handler delete a DIFFERENT
// live window's entry (identity was never checked). Every test here that matters is
// really "does the map end up pointing at the right window, or at nothing."

const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeWindow(destroyed = false) {
  let isDestroyed = destroyed;
  return {
    isDestroyed: () => isDestroyed,
    destroy: () => { isDestroyed = true; },
  };
}

function freshRegistry() {
  const p = require.resolve('../../main/window-registry');
  delete require.cache[p];
  return require(p);
}

test('claimProject + ownerOf round-trip', () => {
  const { claimProject, ownerOf } = freshRegistry();
  const w = fakeWindow();
  claimProject('/proj/a', w);
  assert.equal(ownerOf('/proj/a'), w);
  assert.equal(ownerOf('/proj/nonexistent'), null);
});

test('ownerOf purges a destroyed entry instead of returning it', () => {
  const { claimProject, ownerOf } = freshRegistry();
  const w = fakeWindow();
  claimProject('/proj/a', w);
  w.destroy();
  assert.equal(ownerOf('/proj/a'), null, 'a destroyed owner must never be handed back');
  // Second call proves it was actually deleted, not just skipped this once.
  const w2 = fakeWindow();
  claimProject('/proj/a', w2);
  assert.equal(ownerOf('/proj/a'), w2);
});

test('releaseProject is identity-checked — this IS the orphan-bug fix', () => {
  const { claimProject, releaseProject, ownerOf } = freshRegistry();
  const windowA = fakeWindow();
  const windowB = fakeWindow();
  // windowA owned '/proj/x', then got replaced by windowB (e.g. adoptProjectIntoWindow
  // healed the owner in place, or a later createProjectWindow call overwrote the slot).
  claimProject('/proj/x', windowA);
  claimProject('/proj/x', windowB);
  // windowA's closed handler fires with its OWN stale closure value of the dir. Before
  // the C1388 fix, main.js deleted unconditionally here, wiping out windowB's live
  // registration. releaseProject must refuse: windowA is no longer the owner of record.
  const deleted = releaseProject('/proj/x', windowA);
  assert.equal(deleted, false, 'a non-owner must not be able to release the slot');
  assert.equal(ownerOf('/proj/x'), windowB, 'the real owner must survive the stale release attempt');
});

test('releaseProject succeeds when the caller IS the current owner', () => {
  const { claimProject, releaseProject, ownerOf } = freshRegistry();
  const w = fakeWindow();
  claimProject('/proj/y', w);
  assert.equal(releaseProject('/proj/y', w), true);
  assert.equal(ownerOf('/proj/y'), null);
});

test('claimSetup / setupFor / releaseSetup — the setup-window dedupe path', () => {
  const { claimSetup, setupFor, releaseSetup } = freshRegistry();
  const w = fakeWindow();
  claimSetup('/proj/unconfigured', w);
  assert.equal(setupFor('/proj/unconfigured'), w);
  assert.equal(releaseSetup(w), true);
  assert.equal(setupFor('/proj/unconfigured'), null);
});

test('setupFor purges a destroyed setup window (second pick of an abandoned setup window creates fresh, not a dangling focus)', () => {
  const { claimSetup, setupFor } = freshRegistry();
  const w = fakeWindow();
  claimSetup('/proj/z', w);
  w.destroy();
  assert.equal(setupFor('/proj/z'), null);
});

test('releaseSetup scans by value — works even if the caller does not know the exact key', () => {
  const { claimSetup, releaseSetup, setupFor } = freshRegistry();
  const w = fakeWindow();
  claimSetup('/proj/whatever/path', w);
  assert.equal(releaseSetup(w), true);
  assert.equal(setupFor('/proj/whatever/path'), null);
  // Releasing a window that was never registered is a harmless no-op, not a throw.
  assert.equal(releaseSetup(fakeWindow()), false);
});

test('openProjectPaths lists each distinct live project path once, skipping destroyed windows', () => {
  const { claimProject, openProjectPaths } = freshRegistry();
  const w1 = fakeWindow();
  const w2 = fakeWindow(true); // already destroyed at claim time
  claimProject('/proj/one', w1);
  claimProject('/proj/two', w2);
  const paths = openProjectPaths();
  assert.deepEqual(paths, ['/proj/one']);
});

test('openProjectPaths purges destroyed entries as a side effect (feeds saveWindowSession + cross-device sync — see main.js getOpenProjectPaths)', () => {
  const { claimProject, ownerOf, openProjectPaths } = freshRegistry();
  const w = fakeWindow();
  claimProject('/proj/three', w);
  w.destroy();
  assert.deepEqual(openProjectPaths(), []);
  assert.equal(ownerOf('/proj/three'), null, 'the purge must be visible to a subsequent ownerOf() call too');
});

test('a project and a setup registration for the same path do not collide (separate maps)', () => {
  const { claimProject, claimSetup, ownerOf, setupFor } = freshRegistry();
  const projectWin = fakeWindow();
  const setupWin = fakeWindow();
  claimProject('/proj/shared', projectWin);
  claimSetup('/proj/shared', setupWin);
  assert.equal(ownerOf('/proj/shared'), projectWin);
  assert.equal(setupFor('/proj/shared'), setupWin);
});
