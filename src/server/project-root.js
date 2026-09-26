'use strict';

// Resolves the PROJECT root (the codebase a Task App instance manages) without assuming
// anything about where this checkout lives. The Task App's own root is always
// `path.resolve(__dirname, '../..')` from src/server/ — that is the repo root — but the
// project root must come from the caller, the environment, or the working directory:
//
//   1. an explicit argument (`--project-root`, an Electron window's bound project)
//   2. TIPATASK_PROJECT_ROOT (stamped into every child the Task App spawns)
//   3. the nearest ancestor of `cwd` (inclusive) that contains .tipatask/config.json
//   4. `cwd` itself
//
// Never derive the project root by walking up from this checkout: a standalone clone can sit
// anywhere on disk (or inside an app bundle), so "N directories above the server" is
// meaningless.

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_MARKER = path.join('.tipatask', 'config.json');

function findProjectRootFrom(startDir, fsImpl = fs) {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      if (fsImpl.statSync(path.join(dir, CONFIG_MARKER)).isFile()) return dir;
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveProjectRoot({ explicit = null, env = process.env, cwd = process.cwd(), fsImpl = fs } = {}) {
  if (explicit) return path.resolve(explicit);
  if (env && env.TIPATASK_PROJECT_ROOT) return path.resolve(env.TIPATASK_PROJECT_ROOT);
  return findProjectRootFrom(cwd, fsImpl) || path.resolve(cwd);
}

// Resolved-path equality — "is this project the Task App checkout itself?" and similar.
function isSameRoot(a, b) {
  return Boolean(a) && Boolean(b) && path.resolve(a) === path.resolve(b);
}

// Forward-slash form of an absolute path, safe to interpolate into JSON/TOML templates on
// every platform (a raw Windows path would be an invalid JSON escape sequence).
function toPortablePath(p) {
  return path.resolve(p).split(path.sep).join('/');
}

module.exports = { resolveProjectRoot, findProjectRootFrom, isSameRoot, toPortablePath, CONFIG_MARKER };
