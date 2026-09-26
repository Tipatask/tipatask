'use strict';

// (C1430) Unit coverage for window-session.js's pure startup-restore precedence, plus a
// source-position lock on main.js's wiring — main.js requires 'electron' at module scope
// and cannot be loaded in plain node (see main-user-data-env.test.js's header for the same
// reasoning), and the app must not be relaunched to verify this live (kills real agent/
// terminal sessions — see feedback_no_restart_tipatask_app). What CAN be proven purely is
// the resolver logic itself and that main.js's call sites actually use it.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { shouldRestoreFromDevice, resolveStartupProjectPaths } = require('./window-session');

test('shouldRestoreFromDevice: true only for non-array sessionPaths (missing/unreadable session.json)', () => {
  assert.equal(shouldRestoreFromDevice(null), true);
  assert.equal(shouldRestoreFromDevice(undefined), true);
  assert.equal(shouldRestoreFromDevice([]), false);
  assert.equal(shouldRestoreFromDevice(['/a']), false);
});

test('resolveStartupProjectPaths: non-empty session array returned verbatim, no restore consulted', () => {
  const restored = ['/should-be-ignored'];
  assert.deepEqual(resolveStartupProjectPaths(['/a', '/b'], restored), ['/a', '/b']);
});

test('resolveStartupProjectPaths: explicit empty session ([]) stays [] — one blank window, never falls back', () => {
  assert.deepEqual(resolveStartupProjectPaths([], ['/would-be-restored']), []);
  assert.deepEqual(resolveStartupProjectPaths([], []), []);
});

test('resolveStartupProjectPaths: no record (null) + successful device restore → restored paths', () => {
  assert.deepEqual(resolveStartupProjectPaths(null, ['/a', '/b']), ['/a', '/b']);
});

test('resolveStartupProjectPaths: no record (null) + empty/failed device restore → null (workspace.json fallback)', () => {
  assert.equal(resolveStartupProjectPaths(null, []), null);
  assert.equal(resolveStartupProjectPaths(undefined), null); // default restoredPaths = []
});

// ── Source-position lock on main.js ─────────────────────────────────────────
const MAIN_JS_PATH = path.join(__dirname, '..', '..', 'main.js');
const mainSrc = fs.readFileSync(MAIN_JS_PATH, 'utf8');

test('(C1430) main.js requires window-session.js', () => {
  assert.match(mainSrc, /require\(['"]\.\/src\/server\/window-session['"]\)/);
});

test('(C1430) app.whenReady calls resolveStartupProjectPaths (not the old !sessionPaths || length===0 collapse)', () => {
  assert.match(mainSrc, /createInitialWindows\(resolveStartupProjectPaths\(sessionPaths,\s*restoredPaths\)/);
});

test('(C1430) app.on(\'activate\') no longer calls createInitialWindows() with zero args (that was the mass-reopen-workspace-projects repro)', () => {
  const activateIdx = mainSrc.indexOf("app.on('activate'");
  assert.notEqual(activateIdx, -1, "expected an app.on('activate', ...) handler");
  const activateBlock = mainSrc.slice(activateIdx, activateIdx + 900);
  assert.ok(!/createInitialWindows\(\)/.test(activateBlock), 'activate handler must not call createInitialWindows() with no args');
  assert.match(activateBlock, /createInitialWindows\(\[\]\)/);
});

test('(C1430) loadWindowSession still returns null (not []) on unreadable file / non-array JSON — the null-vs-[] distinction this whole contract rests on', () => {
  const fnIdx = mainSrc.indexOf('function loadWindowSession()');
  assert.notEqual(fnIdx, -1);
  const fnSrc = mainSrc.slice(fnIdx, fnIdx + 1100);
  assert.match(fnSrc, /if \(!Array\.isArray\(parsed\)\) return null;/);
  assert.match(fnSrc, /catch \{\s*return null;\s*\}/);
});
