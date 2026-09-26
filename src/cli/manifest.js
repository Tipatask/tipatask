'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST_RELATIVE_PATH = path.join('.tipatask', 'install-manifest.json');

/**
 * Absolute path to the manifest file inside a project root.
 */
function manifestPath(projectRoot) {
  return path.join(projectRoot, MANIFEST_RELATIVE_PATH);
}

/**
 * Compute the sha256 hash of a file on disk. Returns `"sha256:<hex>"` or null
 * if the file does not exist.
 */
function computeFileHash(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    const hex = crypto.createHash('sha256').update(buf).digest('hex');
    return `sha256:${hex}`;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Read the manifest for a project root. Returns null when missing or invalid.
 */
function readManifest(projectRoot) {
  const file = manifestPath(projectRoot);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/**
 * Write a manifest. Ensures `.tipatask/` exists.
 */
function writeManifest(projectRoot, manifest) {
  const file = manifestPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(file, json, 'utf8');
}

/**
 * Determine how a destination file compares to what the manifest records.
 *
 * - `missing`        — manifest knows the file but it is gone on disk
 * - `unchanged`      — manifest hash matches current disk hash
 * - `user-modified`  — exists on disk, manifest hash differs
 * - `not-tracked`    — exists on disk, not in the manifest (user-created)
 * - `fresh`          — not on disk, not in manifest (first install case)
 */
function fileStatus(projectRoot, relPath, manifest) {
  const absPath = path.join(projectRoot, relPath);
  const diskHash = computeFileHash(absPath);
  const entry = manifest && manifest.files ? manifest.files[relPath] : null;

  if (!entry) {
    return diskHash === null ? 'fresh' : 'not-tracked';
  }

  if (diskHash === null) return 'missing';
  // Older installers recorded the edited disk hash when skipping a file. Keep
  // that explicit ownership marker authoritative across every later upgrade.
  if (entry.userModified) return 'user-modified';
  return diskHash === entry.hash ? 'unchanged' : 'user-modified';
}

/**
 * Build a fresh empty manifest object with current timestamp.
 */
function emptyManifest(packageVersion) {
  return {
    version: packageVersion,
    installedAt: new Date().toISOString(),
    files: {},
  };
}

module.exports = {
  MANIFEST_RELATIVE_PATH,
  manifestPath,
  computeFileHash,
  readManifest,
  writeManifest,
  fileStatus,
  emptyManifest,
};
