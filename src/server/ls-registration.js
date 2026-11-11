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
    let child;
    let backstop;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      resolve(result);
    };
    try {
      child = exec(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        settle({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || err?.message || '' });
      });
    } catch (err) {
      settle({ code: 1, stdout: '', stderr: err.message || 'exec-failed' });
    }
    if (settled) return;
    // Belt-and-braces: execFile's own `timeout` option above should always fire first, but a
    // hung lsregister must never hang app startup. `-dump` is a large, slow call on a system
    // with many registered apps — give it more room than bundle-signature.js's codesign calls.
    backstop = setTimeout(() => {
      if (settled) return;
      try { child.kill(); } catch { /* best-effort */ }
      settle({ code: 1, stdout: '', stderr: 'timeout' });
    }, timeoutMs + 5000);
    if (typeof backstop.unref === 'function') backstop.unref();
  });
}

// Parses `lsregister -dump` — records are separated by `----...` divider lines; within a
// record, `mount state:`/`path:`/`identifier:`/`version:` lines (when present) describe that
// one claimant. Returns every claimant whose `identifier:` line matches `bundleId` exactly.
function _parseClaimants(dumpText, bundleId) {
  const claimants = new Map();
  let curPath = null;
  let curMountState = null;
  let curVersion = null;
  let curId = null;
  const flush = () => {
    if (curId !== bundleId || !curPath) return;
    const key = path.resolve(curPath);
    const prior = claimants.get(key);
    claimants.set(key, { path: curPath, version: curVersion, mounted: prior?.mounted || curMountState !== 'not mounted' });
  };
  const lines = dumpText.split('\n');
  for (const line of lines) {
    if (/^-{10,}/.test(line)) {
      flush();
      curPath = null;
      curMountState = null;
      curVersion = null;
      curId = null;
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
      curId = m[1].trim();
    }
  }
  flush();
  return [...claimants.values()];
}

async function _readClaimants(bundleId, { exec = execFile, lsregisterPath = LSREGISTER_PATH, timeoutMs = 15000 } = {}) {
  const { code, stdout, stderr } = await _run(exec, lsregisterPath, ['-dump'], timeoutMs);
  if (code !== 0 || !stdout.trim()) return { checked: false, reason: stderr.trim() || 'empty-dump', claimants: [] };
  return { checked: true, reason: null, claimants: _parseClaimants(stdout, bundleId) };
}

// Legacy array interface. Verification callers use inspectRegistration() to distinguish an
// unavailable dump from an empty, successfully checked set of claimants.
async function listBundleClaimants(bundleId, deps = {}) {
  return (await _readClaimants(bundleId, deps)).claimants;
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
  const canonical = async p => {
    try { return await fs.realpath(p); } catch { return path.resolve(p); }
  };
  const runningRealPath = runningPath ? await canonical(runningPath) : null;
  for (const c of claimants || []) {
    // LaunchServices canonicalizes /var and symlinked install locations. Never unregister
    // the running app because its dump path uses a different spelling of the same bundle.
    if (runningPath && await canonical(c.path) === runningRealPath) {
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

// Read-only snapshot shared by Settings Repair, startup and the diagnostic probe.
async function inspectRegistration({ bundlePath, bundleId, deps = {} } = {}) {
  const { checked, reason, claimants } = await _readClaimants(bundleId, deps);
  const { self, liveConflicts, staleRecords, mountedInstallerVolumes } = await classifyClaimants({ claimants, runningPath: bundlePath, fs: deps.fs });
  const installerVolumes = mountedInstallerVolumes.map(c => c.path);
  if (self && /^\/Volumes\//.test(bundlePath)) installerVolumes.unshift(bundlePath);
  return {
    checked, reason,
    registered: checked ? Boolean(self) : null,
    conflicts: checked ? liveConflicts.length : null,
    staleCount: checked ? staleRecords.length : null,
    conflictPaths: liveConflicts.map(c => c.path),
    stalePaths: staleRecords.map(c => c.path),
    installerVolumes,
  };
}

// Explicit user repair only. Never deletes bundles, ejects volumes, rebuilds the whole
// database or restarts the app. A successful command is insufficient: re-read and verify.
async function repairRegistrationWithVerification({ bundlePath, bundleId, deps = {} } = {}) {
  const result = (outcome, reason, registration) => ({
    ok: outcome === 'verified', outcome, reason, registration,
    relaunchNeeded: outcome === 'verified',
  });
  const before = await inspectRegistration({ bundlePath, bundleId, deps });
  if (!before.checked) return result('verification-failed', before.reason, before);
  if (before.installerVolumes.length) return result('blocked-installer', 'mounted-installer', before);

  const { exec = execFile, lsregisterPath = LSREGISTER_PATH, timeoutMs = 15000 } = deps;
  const errors = [];
  for (const claimantPath of [...before.conflictPaths, ...before.stalePaths]) {
    const { code, stderr } = await _run(exec, lsregisterPath, ['-u', claimantPath], timeoutMs);
    if (code !== 0) errors.push(`${claimantPath}: ${stderr.trim() || 'unregister-failed'}`);
  }
  const repair = await reregisterBundle(bundlePath, deps);
  if (!repair.ok) errors.push(repair.reason);
  const after = await inspectRegistration({ bundlePath, bundleId, deps });
  if (errors.length) return result('repair-error', errors.join('\n'), after);
  if (!after.checked) return result('verification-failed', after.reason, after);
  if (after.installerVolumes.length) return result('blocked-installer', 'mounted-installer', after);
  if (!after.registered || after.conflicts || after.staleCount) {
    return result('verification-failed', after.registered ? 'claims-remain' : 'bundle-not-registered', after);
  }
  return result('verified', null, after);
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
  const registration = await inspectRegistration({ bundlePath, bundleId, deps });
  let repaired = false;
  if (registration.conflicts > 0 && !(await _repairAttemptedThisVersion(markerDir, version, deps))) {
    const result = await reregisterBundle(bundlePath, deps);
    await _recordRepairAttempt(markerDir, version, result, deps);
    repaired = result.ok;
  }
  return {
    ...registration,
    repaired,
    relaunchNeeded: repaired,
  };
}

module.exports = {
  LSREGISTER_PATH,
  listBundleClaimants,
  classifyClaimants,
  reregisterBundle,
  inspectRegistration,
  repairRegistrationWithVerification,
  ensureLaunchServicesHealthy,
};
