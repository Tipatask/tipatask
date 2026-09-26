#!/usr/bin/env node
'use strict';

// (C1355) Read-only diagnostic for the "OS push notifications stopped firing" regression class.
// Runs the same checks main.js does at startup (bundle-signature.js's verifyBundleSignature,
// ls-registration.js's listBundleClaimants/classifyClaimants) directly against the real machine,
// without needing Electron or a running app — so it can be run any time to sanity-check delivery
// health. See ai/architecture/tt-notifications.md § C1355.
//
// NEVER mutates anything: no eject, no `lsregister -kill -r`, no relaunch, no re-register. When
// it finds a fixable problem it prints the exact user-run remediation block from that doc instead
// of attempting to fix it itself.
//
// Usage:
//   npm run probe:notif-registration
//   npm run probe:notif-registration -- --path "/Applications/TipATask.app" --bundle-id com.tipatask.app

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyBundleSignature } = require('../src/server/bundle-signature');
const { listBundleClaimants, classifyClaimants } = require('../src/server/ls-registration');

function parseArgs(argv) {
  const opts = { bundlePath: '/Applications/TipATask.app', bundleId: 'com.tipatask.app' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path') opts.bundlePath = argv[++i];
    else if (argv[i] === '--bundle-id') opts.bundleId = argv[++i];
  }
  return opts;
}

function execP(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function checkNcprefsRegistration(bundleId) {
  const { code, stdout } = await execP('defaults', ['read', 'com.apple.ncprefs']);
  if (code !== 0) return null; // unknown — e.g. no ncprefs plist at all yet
  return stdout.includes(bundleId);
}

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  const { bundlePath, bundleId } = parseArgs(process.argv.slice(2));
  console.log(`[probe:notif-registration] bundlePath=${bundlePath} bundleId=${bundleId}\n`);

  if (process.platform !== 'darwin') {
    console.log('Not on darwin — this probe only checks the macOS Notification Center / LaunchServices / codesign layer. Nothing to report.');
    return;
  }

  const problems = [];
  const bundleExists = await pathExists(bundlePath);
  if (!bundleExists) {
    console.log(`✗ ${bundlePath} does not exist — nothing further to check. Pass --path if the app is installed elsewhere.`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${bundlePath} exists`);

  // 1. Notification Center registration — the direct, ground-truth signal.
  const registered = await checkNcprefsRegistration(bundleId);
  if (registered === true) console.log(`✓ registered with Notification Center (com.apple.ncprefs has an entry for ${bundleId})`);
  else if (registered === false) { console.log(`✗ NOT registered with Notification Center — every notify:show will silently drop`); problems.push('not-registered'); }
  else console.log('? Notification Center registration: unknown (defaults read failed, or no ncprefs plist yet)');

  // 2. Code signature — signed + sealed (bundle-signature.js's own check, real codesign call).
  const sigResult = await verifyBundleSignature(bundlePath);
  const codeSigPresent = await pathExists(path.join(bundlePath, 'Contents', '_CodeSignature'));
  if (!codeSigPresent) { console.log('✗ Contents/_CodeSignature missing — bundle was never signed at all'); problems.push('unsigned'); }
  else console.log('✓ Contents/_CodeSignature present');
  if (sigResult.valid) console.log('✓ codesign --verify: seal intact');
  else { console.log(`✗ codesign --verify: FAILED (${sigResult.reason})`); problems.push('seal-broken'); }

  // 3. Bundle-root strays — anything besides Contents/ at the bundle root breaks the seal
  // even when `codesign --verify` on its own looked fine under old flags (see C1318).
  let rootEntries = [];
  try { rootEntries = await fs.readdir(bundlePath); } catch { /* already know it exists; ignore */ }
  const strays = rootEntries.filter((e) => !['Contents', '.DS_Store', '__MACOSX'].includes(e));
  if (strays.length) { console.log(`✗ bundle-root strays present: ${strays.join(', ')}`); problems.push('bundle-root-strays'); }
  else console.log('✓ bundle root clean (only Contents/)');

  // 4. Duplicate LaunchServices claimants — the C1355 cause.
  const claimants = await listBundleClaimants(bundleId);
  const { self, liveConflicts, staleRecords, mountedInstallerVolumes } = await classifyClaimants({ claimants, runningPath: bundlePath });
  console.log(`\nLaunchServices claimants of ${bundleId}: ${claimants.length} total`);
  console.log(`  self:              ${self ? self.path : '(not found among claimants — is bundlePath correct?)'}`);
  console.log(`  live conflicts:    ${liveConflicts.length}${liveConflicts.length ? '\n    - ' + liveConflicts.map((c) => c.path).join('\n    - ') : ''}`);
  console.log(`  stale records:     ${staleRecords.length} (harmless — paths that no longer exist on disk)`);
  if (mountedInstallerVolumes.length) {
    console.log(`  mounted installer volumes: ${mountedInstallerVolumes.map((c) => c.path).join(', ')}`);
    problems.push('mounted-installer-volume');
  }
  if (liveConflicts.length > 0) problems.push('duplicate-claimants');

  console.log('\n' + '─'.repeat(60));
  if (problems.length === 0) {
    console.log('Clean bill of health — no known cause of dropped notifications found.');
    return;
  }

  console.log(`Found ${problems.length} problem(s): ${problems.join(', ')}\n`);
  if (problems.includes('duplicate-claimants') || problems.includes('mounted-installer-volume') || problems.includes('not-registered')) {
    console.log('Remediation (see ai/architecture/tt-notifications.md § C1355) — run yourself, NOT automated by this probe:\n');
    console.log('  LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister');
    for (const c of mountedInstallerVolumes) {
      const volume = c.path.split('/').slice(0, 3).join('/'); // /Volumes/<name>
      console.log(`  hdiutil detach "${volume}"`);
    }
    console.log(`  "$LSR" -kill -r -domain local -domain system -domain user`);
    console.log(`  "$LSR" -f "${bundlePath}"`);
    console.log(`  # Quit ${path.basename(bundlePath, '.app')} COMPLETELY (Cmd-Q) and relaunch it — usernoted only decides`);
    console.log(`  # registration at process launch.`);
  }
  if (problems.includes('unsigned') || problems.includes('seal-broken') || problems.includes('bundle-root-strays')) {
    console.log('\nThe app self-heals unsigned/seal-broken/bundle-root-stray conditions at startup (bundle-signature.js) —');
    console.log('relaunch the app and re-run this probe; if the problem persists, see ai/architecture/tt-notifications.md § C1141/§ C1318.');
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('[probe:notif-registration] fatal:', err);
  process.exitCode = 1;
});
