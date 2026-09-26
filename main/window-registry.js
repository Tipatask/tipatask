'use strict';

// (C1388) One-window-per-project registry — extracted from main.js's inline
// `windowsByProject` Map so the invariant is unit-testable without `electron`
// (no import here — operates on any object shaped `{ isDestroyed(): bool }`).
//
// Two independent maps:
//   projectWindows: projectPath -> real project BrowserWindow (post-adopt/bind)
//   setupWindows:   projectPath -> dedicated setup-wizard BrowserWindow (pre-adopt)
// A path lives in at most one of these at a time in the happy path, but nothing
// here enforces that — callers (main.js) are responsible for releasing the
// setup entry at the moment of adoption (see adoptProjectIntoWindow).

const projectWindows = new Map();
const setupWindows = new Map();

/** Register `w` as the owner of `dir`. Overwrites any prior owner (caller's job to check first). */
function claimProject(dir, w) {
  if (!dir) return;
  projectWindows.set(dir, w);
}

/**
 * Live owner of `dir`, or null. A destroyed owner is purged from the map as a
 * side effect — callers never see a stale/destroyed entry survive a lookup.
 */
function ownerOf(dir) {
  if (!dir) return null;
  const w = projectWindows.get(dir);
  if (!w) return null;
  if (w.isDestroyed()) { projectWindows.delete(dir); return null; }
  return w;
}

/**
 * Identity-checked release: deletes `dir` only if it currently maps to `w`.
 * Returns true if a delete happened. This is the fix for the orphan bug — a
 * window's `closed` handler must never delete another live window's entry.
 */
function releaseProject(dir, w) {
  if (!dir) return false;
  if (projectWindows.get(dir) === w) { projectWindows.delete(dir); return true; }
  return false;
}

function claimSetup(dir, w) {
  if (!dir) return;
  setupWindows.set(dir, w);
}

/** Live in-flight setup window for `dir`, or null. Purges a destroyed entry. */
function setupFor(dir) {
  if (!dir) return null;
  const w = setupWindows.get(dir);
  if (!w) return null;
  if (w.isDestroyed()) { setupWindows.delete(dir); return null; }
  return w;
}

/** Release by value — scans for `w` regardless of which path key it's under. */
function releaseSetup(w) {
  for (const [dir, sw] of setupWindows.entries()) {
    if (sw === w) { setupWindows.delete(dir); return true; }
  }
  return false;
}

/** Distinct, live project paths currently owning a window. Purges destroyed entries. */
function openProjectPaths() {
  const seen = new Set();
  const paths = [];
  for (const [dir, w] of projectWindows.entries()) {
    if (!dir) continue;
    if (!w || w.isDestroyed()) { projectWindows.delete(dir); continue; }
    if (seen.has(dir)) continue;
    seen.add(dir);
    paths.push(dir);
  }
  return paths;
}

// Test-only: full reset between cases. Never called from main.js.
function _resetForTests() {
  projectWindows.clear();
  setupWindows.clear();
}

module.exports = {
  claimProject,
  ownerOf,
  releaseProject,
  claimSetup,
  setupFor,
  releaseSetup,
  openProjectPaths,
  _resetForTests,
};
