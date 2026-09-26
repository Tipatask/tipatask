'use strict';

// (C1430) Startup window-restore precedence — pure, testable, no fs/electron.
//
// sessionPaths contract (produced by main.js's loadWindowSession()):
//   array (incl. []) → authoritative record of this device's last window set.
//     [] means the user closed every project window before quitting — treat as
//     an explicit "nothing was open" signal, never as "no record".
//   non-array (null) → no record at all: session.json missing/unreadable, or a
//     genuine first-ever launch.
//
// createInitialWindows() (main.js) already branches on Array.isArray for exactly
// this reason: [] → one blank unbound window, non-array → workspace.json fallback.
// These two functions decide what to hand it so that branch fires correctly.

function shouldRestoreFromDevice(sessionPaths) {
  return !Array.isArray(sessionPaths);
}

function resolveStartupProjectPaths(sessionPaths, restoredPaths = []) {
  if (Array.isArray(sessionPaths)) return sessionPaths; // [] stays [] → blank window
  return restoredPaths.length ? restoredPaths : null; // null → workspace fallback
}

module.exports = { shouldRestoreFromDevice, resolveStartupProjectPaths };
