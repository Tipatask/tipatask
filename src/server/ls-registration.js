'use strict';

// (C1355) macOS keys OS push-notification delivery off LaunchServices' resolution of the app's
// CFBundleIdentifier, not just its code signature — bundle-signature.js (C1125/C1141/C1318)
// covers "is this bundle signed and sealed", this module covers a fourth, structurally
// different way notification delivery silently dies: LaunchServices holding MULTIPLE bundles
// that all claim the same identifier (ad-hoc signing means every rebuild/DMG mount registers a
// new, differently-cdhashed claimant — see ai/architecture/tt-notifications.md § C1355). With
// dozens of stale claimants, `usernoted` never creates a `com.apple.ncprefs` entry for the
// identifier at all, and every `Notification.show()` drops with no error anywhere.
//
// Same philosophy as bundle-signature.js: detect -> self-heal (best-effort, non-destructive) ->
// report `relaunchNeeded`. Every failure degrades to "unknown", never throws.

const path = require('node:path');
const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');

const LSREGISTER_PATH = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function _run(exec, cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const child = exec(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
    // Belt-and-braces: execFile's own `timeout` option above should always fire first, but a
    // hung lsregister must never hang app startup. `-dump` is a large, slow call on a system
    // with many registered apps — give it more room than bundle-signature.js's codesign calls.
    const backstop = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* best-effort */ }
      resolve({ code: 1, stdout: '', stderr: 'timeout' });
    }, timeoutMs + 5000);
    if (typeof backstop.unref === 'function') backstop.unref();
  });
}

// Parses `lsregister -dump` — records are separated by `----...` divider lines; within a
// record, `mount state:`/`path:`/`identifier:`/`version:` lines (when present) describe that
// one claimant. Returns every claimant whose `identifier:` line matches `bundleId` exactly.
function _parseClaimants(dumpText, bundleId) {
  const claimants = [];
  let curPath = null;
  let curMountState = null;
  let curVersion = null;
  const lines = dumpText.split('\n');
  for (const line of lines) {
    if (/^-{10,}/.test(line)) {
      curPath = null;
      curMountState = null;
      curVersion = null;
      continue;
    }
    let m;
    if ((m = /^path:\s+(.*)$/.exec(line))) {
      curPath = m[1].replace(/\s*\(0x[0-9a-f]+\)\s*$/i, '').trim();
      continue;
    }
    if ((m = /^mount state:\s+(.*)$/.exec(line))) {
      curMountState = m[1].trim();
      continue;
    }
    if ((m = /^version:\s+([^\s(]+)/.exec(line))) {
      curVersion = m[1].trim();
      continue;
    }
    if ((m = /^identifier:\s+(.*)$/.exec(line))) {
      const id = m[1].trim();
      if (id === bundleId && curPath) {
        claimants.push({ path: curPath, version: curVersion, mounted: curMountState !== 'not mounted' });
      }
    }
  }
  return claimants;
}

// Lists every LaunchServices-registered claimant of `bundleId`. Returns `[]` (never throws) on
// any failure — a probe that can't run is "unknown", not "zero conflicts".
async function listBundleClaimants(bundleId, { exec = execFile, lsregisterPath = LSREGISTER_PATH, timeoutMs = 15000 } = {}) {
  const { code, stdout } = await _run(exec, lsregisterPath, ['-dump'], timeoutMs);
  if (code !== 0 || !stdout) return [];
  return _parseClaimants(stdout, bundleId);
}

// Splits claimants into: `self` (the running app's own path), `liveConflicts` (other paths that
// still exist on disk — the ones actually capable of confusing LaunchServices right now),
// `staleRecords` (paths LaunchServices remembers but no longer exist — harmless noise, dropped
// for free by `-kill -r`, never touched automatically here), and `mountedInstallerVolumes` (a
// live conflict that is itself a mounted disk image under `/Volumes` — the single most
// actionable case, since ejecting it is safe and non-destructive).
async function classifyClaimants({ claimants, runningPath, fs = fsp } = {}) {
  const liveConflicts = [];
  const staleRecords = [];
  const mountedInstallerVolumes = [];
  let self = null;
  for (const c of claimants || []) {
    if (runningPath && path.resolve(c.path) === path.resolve(runningPath)) {
      self = c;
      continue;
    }
    let exists = false;
    try { await fs.access(c.path); exists = true; } catch { exists = false; }
    if (!exists) { staleRecords.push(c); continue; }
    liveConflicts.push(c);
    if (/^\/Volumes\//.test(c.path)) mountedInstallerVolumes.push(c);
  }
  return { self, liveConflicts, staleRecords, mountedInstallerVolumes };
}

// Non-destructive: re-registers ONE bundle so its record is freshest. Never rebuilds the whole
// LaunchServices database (`-kill -r`) — that is out of scope for automatic self-heal; it
// touches every app on the system and is left to the user-run remediation in
// ai/architecture/tt-notifications.md § C1355.
async function reregisterBundle(bundlePath, { exec = execFile, lsregisterPath = LSREGISTER_PATH, timeoutMs = 15000 } = {}) {
  const { code, stderr } = await _run(exec, lsregisterPath, ['-f', bundlePath], timeoutMs);
  return { ok: code === 0, reason: code === 0 ? null : (stderr.trim().split('\n').pop() || 'register-failed') };
}

function _markerPath(markerDir, version) {
  return path.join(markerDir, `.ls-repair-${version}.json`);
}
async function _repairAttemptedThisVersion(markerDir, version, { fs = fsp } = {}) {
  try { await fs.access(_markerPath(markerDir, version)); return true; }
  catch { return false; }
}
async function _recordRepairAttempt(markerDir, version, result, { fs = fsp } = {}) {
  try {
    await fs.mkdir(markerDir, { recursive: true });
    await fs.writeFile(_markerPath(markerDir, version), JSON.stringify({ version, ...result, at: 'startup' }), 'utf8');
  } catch { /* best-effort — losing the marker just means a retry next launch */ }
}

// Orchestrates the read-only detect + best-effort self-heal: list claimants, classify, and
// (once per app version, same one-shot-per-version guard as bundle-signature.js's repair step)
// re-register the running bundle so LaunchServices treats it as the freshest claimant. Never
// blocks or fails notify:show — this is purely informational plus a best-effort nudge.
async function ensureLaunchServicesHealthy({ bundlePath, bundleId, markerDir, version, deps = {} } = {}) {
  const claimants = await listBundleClaimants(bundleId, deps);
  const { self, liveConflicts, staleRecords, mountedInstallerVolumes } = await classifyClaimants({ claimants, runningPath: bundlePath, fs: deps.fs });
  let repaired = false;
  if (liveConflicts.length > 0 && !(await _repairAttemptedThisVersion(markerDir, version, deps))) {
    const result = await reregisterBundle(bundlePath, deps);
    await _recordRepairAttempt(markerDir, version, result, deps);
    repaired = result.ok;
  }
  return {
    registered: Boolean(self),
    conflicts: liveConflicts.length,
    staleCount: staleRecords.length,
    installerVolumes: mountedInstallerVolumes.map((c) => c.path),
    repaired,
    relaunchNeeded: repaired,
  };
}

module.exports = {
  LSREGISTER_PATH,
  listBundleClaimants,
  classifyClaimants,
  reregisterBundle,
  ensureLaunchServicesHealthy,
};
