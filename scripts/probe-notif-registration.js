#!/usr/bin/env node
'use strict';

// (C1355) Read-only diagnostic for the "OS push notifications stopped firing" regression class.
// Runs the same checks main.js does at startup (bundle-signature.js's verifyBundleSignature,
// ls-registration.js's inspectRegistration) directly against the real machine,
// without needing Electron or a running app — so it can be run any time to sanity-check delivery
// health. See ai/architecture/tt-notifications.md § C1355.
//
// NEVER mutates anything: no eject, no `lsregister -kill -r`, no relaunch, no re-register. When
// it finds a problem it prints the Settings recovery steps instead of attempting repair.
//
// Usage:
//   npm run probe:notif-registration
//   npm run probe:notif-registration -- --path "/Applications/TipATask.app" --bundle-id com.tipatask.app
//   npm run probe:notif-registration -- --after-repair

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyBundleSignature } = require('../src/server/bundle-signature');
const { inspectRegistration } = require('../src/server/ls-registration');

function parseArgs(argv) {
  const opts = { bundlePath: '/Applications/TipATask.app', bundleId: 'com.tipatask.app', afterRepair: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path') opts.bundlePath = argv[++i];
    else if (argv[i] === '--bundle-id') opts.bundleId = argv[++i];
    else if (argv[i] === '--after-repair') opts.afterRepair = true;
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
  const { bundlePath, bundleId, afterRepair } = parseArgs(process.argv.slice(2));
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
  const registration = await inspectRegistration({ bundlePath, bundleId });
  const { checked, conflictPaths, stalePaths, installerVolumes } = registration;
  console.log(`\nLaunchServices claimants of ${bundleId} (unique paths):`);
  console.log(`  self:              ${registration.registered ? bundlePath : '(not found or unknown)'}`);
  console.log(`  live conflicts:    ${registration.conflicts ?? 'unknown'}${conflictPaths.length ? '\n    - ' + conflictPaths.join('\n    - ') : ''}`);
  console.log(`  stale records:     ${registration.staleCount ?? 'unknown'} (paths that no longer exist on disk)`);
  if (!checked) problems.push('registration-check-failed');
  else if (!registration.registered) problems.push('bundle-not-registered');
  if (installerVolumes.length) {
    console.log(`  mounted installer volumes: ${installerVolumes.join(', ')}`);
    problems.push('mounted-installer-volume');
  }
  if (conflictPaths.length > 0) problems.push('duplicate-claimants');
  if (afterRepair && stalePaths.length) problems.push('stale-claims-remain');
  console.log(`  Repair verification: ${registrationOutcome(registration)}`);
  if (afterRepair) console.log(`  Notification Center after reopening: ${registered === true ? 'registered' : registered === false ? 'not registered — native delivery not verified' : 'unknown — native delivery not verified'}`);

  console.log('\n' + '─'.repeat(60));
  if (problems.length === 0) {
    console.log('No known registration blocker found. Use Test in Settings to check delivery.');
    return;
  }

  console.log(`Found ${problems.length} problem(s): ${problems.join(', ')}\n`);
  if (problems.some(p => ['duplicate-claimants', 'mounted-installer-volume', 'not-registered', 'stale-claims-remain', 'bundle-not-registered'].includes(p))) {
    console.log('Recovery — perform yourself; this probe changes nothing:');
    for (const volume of [...new Set(installerVolumes.map(p => p.split('/').slice(0, 3).join('/')))]) console.log(`  Eject installer disk: ${volume}`);
    console.log('  In Settings, press Repair. Resolve any remaining blocker shown there.');
    console.log('  After verified success, quit and reopen TipATask when your running tasks have finished.');
    console.log('  Run this probe with --after-repair, then use Test in Settings to check native delivery.');
  }
  if (problems.includes('unsigned') || problems.includes('seal-broken') || problems.includes('bundle-root-strays')) {
    console.log('\nThe app self-heals unsigned/seal-broken/bundle-root-stray conditions at startup (bundle-signature.js) —');
    console.log('relaunch the app and re-run this probe; if the problem persists, see ai/architecture/tt-notifications.md § C1141/§ C1318.');
  }
  process.exitCode = 1;
}

function registrationOutcome(registration) {
  if (!registration.checked) return `UNKNOWN (${registration.reason})`;
  if (registration.installerVolumes.length) return 'BLOCKED — eject installer disks before Repair';
  if (!registration.registered || registration.conflicts || registration.staleCount) return 'INCOMPLETE — missing self or competing/stale claims remain';
  return 'VERIFIED — own bundle registered, no competing or stale claims';
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[probe:notif-registration] fatal:', err);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, registrationOutcome };
