'use strict';
// Patch-bump the app version through `npm version` so package.json, package-lock.json's
// top-level "version" and its packages[""] root entry always move together. Git tags are
// never created here — that is a release-time step (RELEASING.md).
require('./check-node-version');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

function nextPatchVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!m) throw new Error(`cannot parse version "${version}" as MAJOR.MINOR.PATCH`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function readVersions() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  return {
    pkg: pkg.version,
    lock: lock.version,
    lockRoot: lock.packages && lock.packages[''] && lock.packages[''].version,
  };
}

function fail(message, code) {
  console.error(`[bump-version] ERROR: ${message}`);
  process.exit(code || 1);
}

function main() {
  let next;
  try {
    next = nextPatchVersion(readVersions().pkg);
  } catch (e) {
    fail(e.message);
  }

  const args = ['version', next, '--no-git-tag-version', '--ignore-scripts'];
  // Under `npm run` reuse the exact npm driving the build; standalone, resolve from PATH.
  const npmExec = process.env.npm_execpath;
  const result = npmExec
    ? spawnSync(process.execPath, [npmExec, ...args], { cwd: root, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : `exit ${result.status}`;
    fail(`npm version ${next} failed (${why}); version files may be unchanged`, result.status || 1);
  }

  const v = readVersions();
  if (v.pkg !== next || v.lock !== next || v.lockRoot !== next) {
    fail(`version mismatch after bump: package.json=${v.pkg}, package-lock.json=${v.lock}, lock root=${v.lockRoot}, expected ${next}`);
  }
  console.log(`Bumped version to ${next}`);
}

if (require.main === module) main();

module.exports = { nextPatchVersion };
