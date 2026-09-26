'use strict';

// Regression/coverage tests for C1112: resolveBin('pi') gained a "Strategy 0.5" branch that
// prefers a CLI bundled as an npm dependency of this server (currently just Pi,
// @earendil-works/pi-coding-agent) over a shell/PROBE_DIRS/PATH search — see spawn-utils.js
// resolveBundledBin()/resolvePiLaunch() and their call sites in pi-agent.js/pi-session.js.
//
// All of this is hermetic: none of these tests require Pi to actually be installed or spawn
// anything. resolveBundledBin() takes `serverRoot` as a parameter specifically so it can be
// pointed at a throwaway fixture tree instead of the real ai/todo/server checkout.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveBin, resolveBundledBin, isAsarPath } = require('./spawn-utils');

const IS_WIN = process.platform === 'win32';
const WRAPPER_NAME = IS_WIN ? 'pi.cmd' : 'pi';

// Builds <dir>/{node_modules/@earendil-works/pi-coding-agent/package.json, bin/pi} so
// resolveBundledBin's two existence checks (package installed, wrapper executable) both pass.
function makeFakeServerRoot(baseDir, { withPackage = true, withWrapper = true } = {}) {
  if (withPackage) {
    const pkgDir = path.join(baseDir, 'node_modules', '@earendil-works', 'pi-coding-agent');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.84.1' }));
  }
  if (withWrapper) {
    const binDir = path.join(baseDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const wrapperPath = path.join(binDir, WRAPPER_NAME);
    fs.writeFileSync(wrapperPath, IS_WIN ? '@echo off\r\n' : '#!/usr/bin/env bash\ntrue\n');
    if (!IS_WIN) fs.chmodSync(wrapperPath, 0o755);
  }
  return path.join(baseDir, 'bin', WRAPPER_NAME);
}

test('resolveBundledBin: package installed + wrapper present -> bin/pi', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1112-'));
  try {
    const expected = makeFakeServerRoot(dir);
    assert.strictEqual(resolveBundledBin('pi', dir), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBundledBin: package never installed (no npm install run) -> null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1112-nopkg-'));
  try {
    makeFakeServerRoot(dir, { withPackage: false, withWrapper: true });
    assert.strictEqual(resolveBundledBin('pi', dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBundledBin: package present but wrapper missing -> null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1112-nowrapper-'));
  try {
    makeFakeServerRoot(dir, { withPackage: true, withWrapper: false });
    assert.strictEqual(resolveBundledBin('pi', dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBundledBin: unknown name (not in BUNDLED_CLI_PACKAGES) -> null, no fs access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1112-unknown-'));
  try {
    // No fixture files created — a non-null result here would mean the function fell through
    // to a filesystem check it shouldn't have made for an unmapped name.
    assert.strictEqual(resolveBundledBin('claude', dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBundledBin: packaged Electron (serverRoot inside app.asar) -> null, no fs needed', () => {
  // Packaged builds never reach the bundled checkout branch — electron-builder drops
  // node_modules/.bin entirely and bin/** isn't in build.files. resolvePiLaunch()'s
  // extraResources branch is the packaged equivalent (not exercised here — see its own
  // process.resourcesPath-based check).
  assert.strictEqual(
    resolveBundledBin('pi', '/Applications/TipATask.app/Contents/Resources/app.asar'),
    null
  );
  assert.strictEqual(isAsarPath('/Applications/TipATask.app/Contents/Resources/app.asar'), true);
});

// resolveBin() memoizes per-name in a process-global _binCache, so PI_BIN-override precedence
// is verified in a fresh subprocess (same technique as spawn-server-root.test.js) rather than
// in-process, where an earlier test's resolveBin('pi') call could have already cached a result
// and made this test's env override silently a no-op.
test('resolveBin(pi): PI_BIN env override still outranks the bundled-dependency branch', { skip: IS_WIN && 'PI_BIN override uses a POSIX shell script fixture' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1112-override-'));
  try {
    const fakeBin = path.join(dir, 'fake-pi');
    fs.writeFileSync(fakeBin, '#!/usr/bin/env bash\necho fake-pi\n');
    fs.chmodSync(fakeBin, 0o755);

    const script = `
      process.env.PI_BIN = ${JSON.stringify(fakeBin)};
      const { resolveBin } = require(${JSON.stringify(path.join(__dirname, 'spawn-utils.js'))});
      process.stdout.write(resolveBin('pi') || '');
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();
    assert.strictEqual(out, fakeBin);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Integration guard: on a checkout that actually ran `npm install` (this dev machine, CI after
// install), resolveBin('pi') must resolve through the real bin/pi wrapper — not silently fall
// through to a system-wide search. Skipped when the dependency hasn't been installed yet, so a
// fresh clone / pre-install CI run doesn't fail here.
test('resolveBin(pi): resolves via the real bundled dependency when installed', () => {
  const realServerRoot = path.resolve(__dirname, '..', '..');
  const realPkgJson = path.join(realServerRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
  if (!fs.existsSync(realPkgJson)) {
    return; // node:test has no first-class "skip after start" for sync tests; just no-op.
  }
  const expected = path.join(realServerRoot, 'bin', IS_WIN ? 'pi.cmd' : 'pi');
  const script = `
    const { resolveBin } = require(${JSON.stringify(path.join(__dirname, 'spawn-utils.js'))});
    process.stdout.write(resolveBin('pi') || '');
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: realServerRoot }).trim();
  assert.strictEqual(out, expected);
});
