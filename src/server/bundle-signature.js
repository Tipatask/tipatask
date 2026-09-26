'use strict';

// (C1141) The packaged macOS app used to write TODO.md/recipes/ straight into
// Contents/Resources — i.e. INSIDE its own signed .app bundle (see config.js's
// resolveDataRoot() for the actual fix to that). Every such write added a file the
// code signature's CodeResources manifest never sealed, so `codesign --verify`
// started failing at runtime and macOS's usernoted silently refused to register the
// bundle with Notification Center — no error anywhere, just dropped banners. This
// module makes "signed" (main.js's pre-C1141 `isCodeSigned()`, which only checked
// that Contents/_CodeSignature EXISTS) and "valid" (the seal is actually intact)
// two distinct, separately-checkable facts, and repairs an already-broken install.
//
// See ai/architecture/tt-notifications.md § macOS Code-Signing Requirement (C1141).

const path = require('node:path');
const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');

// Files this app itself is known to have written inside the bundle pre-C1141 —
// relative to Contents/Resources. Deleting these (not re-signing) is the actual
// fix for the common case: codesign --verify fails with "file added", so removing
// the addition restores the seal with no re-sign needed at all.
const STRAY_RESOURCE_PATHS = ['TODO.md', 'recipes'];

// (C1318) A second, structurally different instance of the same bug: config.js's pre-C1318
// PROJECT_ROOT fallback could resolve DATA_ROOT onto the BUNDLE ROOT itself (sibling of
// Contents/), not just into Contents/Resources — writing e.g. `<bundle>/ai/todo/TODO.md`.
// `Contents` is the bundle's real payload; anything else at this level is app-written (or,
// rarely, OS/Finder metadata) — never legitimate bundle content.
const BUNDLE_ROOT_IGNORE = new Set(['Contents', '.DS_Store', '__MACOSX']);

function _run(exec, cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const child = exec(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
    // Belt-and-braces: execFile's own `timeout` option above should always fire first,
    // but a hung codesign must never hang app startup.
    const backstop = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* best-effort */ }
      resolve({ code: 1, stdout: '', stderr: 'timeout' });
    }, timeoutMs + 2000);
    if (typeof backstop.unref === 'function') backstop.unref();
  });
}

// Removes only the known stray paths — never touches anything else in the bundle.
// Best-effort per-path: a path that never existed (already-clean install, or a build
// that no longer writes it) is not an error.
async function cleanStrayBundleFiles(bundlePath, { fs = fsp } = {}) {
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  const removed = [];
  for (const rel of STRAY_RESOURCE_PATHS) {
    const target = path.join(resourcesDir, rel);
    // Existence check first — `rm(..., {force:true})` never throws for a path that was
    // never there, so skipping this would report every path as "removed" on every launch
    // (including an already-healthy install), which would make ensureBundleSignatureHealthy's
    // relaunchNeeded fire every single time instead of only when something actually changed.
    try { await fs.access(target); } catch { continue; }
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed.push(rel);
    } catch { /* best-effort — a permission error here must not block startup */ }
  }
  return removed;
}

// (C1318) `--no-strict` used to be passed here and is exactly what hid the actual live
// regression: `codesign --verify --no-strict` returns 0 (valid) for a bundle with "unsealed
// contents present in the bundle root" — the precise shape of the C1318 bug (stray files
// written into `<bundle>/ai/todo/`, sibling of `Contents/`) — while a strict verify (no flag)
// correctly fails on it. Verified live against the installed app. Dropped so this check can
// never again report `valid: true` for a seal a strict verify would reject.
async function verifyBundleSignature(bundlePath, { exec = execFile, timeoutMs = 10000 } = {}) {
  const { code, stderr } = await _run(exec, 'codesign', ['--verify', bundlePath], timeoutMs);
  return { valid: code === 0, reason: code === 0 ? null : (stderr.trim().split('\n').pop() || 'verify-failed') };
}

// (C1318) Anything at the bundle root other than Contents/ (and harmless OS metadata) is a
// stray this app itself wrote — see BUNDLE_ROOT_IGNORE above.
async function findStrayBundleRootEntries(bundlePath, { fs = fsp } = {}) {
  let entries;
  try { entries = await fs.readdir(bundlePath); } catch { return []; }
  return entries.filter((name) => !BUNDLE_ROOT_IGNORE.has(name));
}

// (C1318) Unlike cleanStrayBundleFiles above (which only ever deleted known-empty scaffold
// files), bundle-root strays can hold real user data — a live install was found with an
// actual user-authored recipe written into `<bundle>/ai/todo/recipes/`. Move, don't delete:
// each stray is relocated into `rescueDir` (the caller passes a per-run timestamped
// directory under userData) before being removed from the bundle. If neither the fast
// rename() nor the copy+remove fallback succeeds (e.g. a permission error), the entry is
// left in place rather than silently losing data — the caller's re-verify will then
// correctly keep reporting the seal as broken instead of falsely claiming success.
async function rescueAndCleanBundleRootEntries(bundlePath, rescueDir, { fs = fsp } = {}) {
  const strays = await findStrayBundleRootEntries(bundlePath, { fs });
  const rescued = [];
  for (const name of strays) {
    const src = path.join(bundlePath, name);
    const dest = path.join(rescueDir, name);
    try {
      await fs.mkdir(rescueDir, { recursive: true });
      await fs.rename(src, dest);
      rescued.push({ name, to: dest });
      continue;
    } catch { /* fall through to copy+remove — e.g. rescueDir on a different volume */ }
    try {
      await fs.cp(src, dest, { recursive: true });
      await fs.rm(src, { recursive: true, force: true });
      rescued.push({ name, to: dest });
    } catch { /* could not rescue — leave the stray in place, see note above */ }
  }
  return rescued;
}

// Fallback only — cleanup above resolves the known cause without ever needing this.
// Re-signing a bundle whose own main executable is currently mapped/running can fail;
// that failure is non-fatal here, just surfaced via the returned {ok:false, reason}.
async function repairBundleSignature(bundlePath, { exec = execFile, timeoutMs = 30000 } = {}) {
  const { code, stderr } = await _run(exec, 'codesign', ['--force', '--deep', '--sign', '-', bundlePath], timeoutMs);
  return { ok: code === 0, reason: code === 0 ? null : (stderr.trim().split('\n').pop() || 'sign-failed') };
}

function _markerPath(markerDir, version) {
  return path.join(markerDir, `.bundle-repair-${version}.json`);
}

// One-time-per-version guard around the repair (re-sign) step only — cleanup and
// verify are cheap and idempotent, so they always run. Prevents a persistently-broken
// bundle (e.g. repair itself failing) from re-attempting codesign on every launch.
async function _repairAttemptedThisVersion(markerDir, version, { fs = fsp } = {}) {
  try { await fs.access(_markerPath(markerDir, version)); return true; }
  catch { return false; }
}
async function _recordRepairAttempt(markerDir, version, result, { fs = fsp } = {}) {
  try {
    await fs.mkdir(markerDir, { recursive: true });
    await fs.writeFile(_markerPath(markerDir, version), JSON.stringify({ version, ...result, at: 'startup' }), 'utf8');
  } catch { /* best-effort — losing the marker just means repair may retry next launch */ }
}

// Orchestrates the full self-heal: clean known stray files, verify, and — only if
// still invalid — repair once per app version. usernoted decides registration at
// process launch, so a successful clean/repair here still needs one relaunch before
// banners actually resume; callers surface that as a one-time notice, not a restart.
async function ensureBundleSignatureHealthy({ bundlePath, version, markerDir, rescueDir, deps = {} } = {}) {
  const removed = await cleanStrayBundleFiles(bundlePath, deps);
  // (C1318) Per-run timestamped subdir so repeated launches (each finding nothing to rescue,
  // the common case) never collide, and so a rescued file never silently overwrites an
  // earlier rescue of the same name.
  const _rescueTarget = rescueDir || path.join(markerDir, 'rescued-bundle-writes', new Date().toISOString().replace(/[:.]/g, '-'));
  const rescued = await rescueAndCleanBundleRootEntries(bundlePath, _rescueTarget, deps);
  let { valid, reason } = await verifyBundleSignature(bundlePath, deps);
  let repaired = false;
  if (!valid && !(await _repairAttemptedThisVersion(markerDir, version, deps))) {
    const repair = await repairBundleSignature(bundlePath, deps);
    await _recordRepairAttempt(markerDir, version, repair, deps);
    if (repair.ok) {
      const reverify = await verifyBundleSignature(bundlePath, deps);
      valid = reverify.valid;
      reason = reverify.reason;
      repaired = valid;
    } else {
      reason = repair.reason;
    }
  }
  return {
    valid, reason, cleaned: removed, rescued, repaired,
    relaunchNeeded: removed.length > 0 || rescued.length > 0 || repaired,
  };
}

module.exports = {
  STRAY_RESOURCE_PATHS,
  BUNDLE_ROOT_IGNORE,
  cleanStrayBundleFiles,
  findStrayBundleRootEntries,
  rescueAndCleanBundleRootEntries,
  verifyBundleSignature,
  repairBundleSignature,
  ensureBundleSignatureHealthy,
};
