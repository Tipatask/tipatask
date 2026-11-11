'use strict';

// (C1355) Unit tests for the "duplicate LaunchServices claimant" self-heal — a signed, sealed
// bundle can still get zero macOS Notification Center registration when LaunchServices holds
// multiple bundles claiming the same CFBundleIdentifier (every ad-hoc-signed rebuild/DMG mount
// registers a new, differently-cdhashed claimant). `lsregister` itself is always mocked — must
// run identically on Linux CI and a dev Mac. See ai/architecture/tt-notifications.md § C1355 and
// bundle-signature.test.js, whose mockExec() harness this reuses verbatim.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  listBundleClaimants,
  classifyClaimants,
  reregisterBundle,
  ensureLaunchServicesHealthy,
  inspectRegistration,
  repairRegistrationWithVerification,
} = require('./ls-registration');

// Verbatim from bundle-signature.test.js — scriptedCalls: array of {code, stdout, stderr}
// consumed in call order, last one repeats.
function mockExec(scriptedCalls) {
  let i = 0;
  const calls = [];
  const exec = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    const result = scriptedCalls[Math.min(i, scriptedCalls.length - 1)];
    i++;
    process.nextTick(() => {
      if (result.code === 0) cb(null, result.stdout || '', result.stderr || '');
      else { const err = new Error('mock failure'); err.code = result.code; cb(err, result.stdout || '', result.stderr || ''); }
    });
    return { kill() {} };
  };
  exec.calls = calls;
  return exec;
}

// A recorded-shape slice of real `lsregister -dump` output: three records for the same
// bundle id, separated by the real divider format, matching what a live dev machine showed
// (one real /Applications install, one mounted installer DMG, one stale unmounted DMG record).
function dumpFixture({ bundleId = 'com.tipatask.app' } = {}) {
  return `
--------------------------------------------------------------------------------
bundle id:                  TipATask (0x15850)
container:                  / (0x4)
mount state:                mounted
path:                       /Applications/TipATask.app (0x15850)
identifier:                 ${bundleId}
version:                    0.8.32 ({length = 32})
--------------------------------------------------------------------------------
bundle id:                  TipATask (0xdac8)
container:                  /Volumes/TipATask 0.8.32-arm64 (0x108)
mount state:                mounted
path:                       /Volumes/TipATask 0.8.32-arm64/TipATask.app (0xdac8)
identifier:                 ${bundleId}
version:                    0.8.32 ({length = 32})
--------------------------------------------------------------------------------
bundle id:                  TipATask (0x14b38)
container:                  /Volumes/TipATask 0.8.15-arm64 (0x1d4)
mount state:                not mounted
path:                       /Volumes/TipATask 0.8.15-arm64/TipATask.app (0x14b38)
identifier:                 ${bundleId}
version:                    0.8.15 ({length = 32})
--------------------------------------------------------------------------------
bundle id:                  Slack (0xd54c)
path:                       /Applications/Slack.app (0xd54c)
identifier:                 com.tinyspeck.slackmacgap
version:                    4.0 ({length = 32})
`;
}

test('listBundleClaimants parses only records matching the bundle id, strips the trailing hex offset from path', async () => {
  const exec = mockExec([{ code: 0, stdout: dumpFixture() }]);
  const claimants = await listBundleClaimants('com.tipatask.app', { exec });
  assert.equal(claimants.length, 3);
  assert.deepEqual(claimants.map((c) => c.path), [
    '/Applications/TipATask.app',
    '/Volumes/TipATask 0.8.32-arm64/TipATask.app',
    '/Volumes/TipATask 0.8.15-arm64/TipATask.app',
  ]);
  assert.equal(claimants[0].mounted, true);
  assert.equal(claimants[2].mounted, false);
});

test('listBundleClaimants returns [] (never throws) when lsregister fails', async () => {
  const exec = mockExec([{ code: 1, stdout: '', stderr: 'boom' }]);
  const claimants = await listBundleClaimants('com.tipatask.app', { exec });
  assert.deepEqual(claimants, []);
});

test('classifyClaimants separates self / live conflicts / stale records / mounted installer volumes', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1355-ls-'));
  const runningPath = path.join(tmpDir, 'TipATask.app');
  await fs.mkdir(runningPath, { recursive: true });
  const liveVolumePath = path.join(tmpDir, 'Volumes-mounted', 'TipATask.app');
  await fs.mkdir(liveVolumePath, { recursive: true });
  const claimants = [
    { path: runningPath, version: '0.8.32', mounted: true },
    { path: liveVolumePath, version: '0.8.32', mounted: true },
    { path: '/Volumes/TipATask 0.8.15-arm64/TipATask.app', version: '0.8.15', mounted: false }, // never existed in this tmp tree
  ];

  const result = await classifyClaimants({ claimants, runningPath });
  assert.equal(result.self.path, runningPath);
  assert.equal(result.liveConflicts.length, 1);
  assert.equal(result.liveConflicts[0].path, liveVolumePath);
  assert.equal(result.staleRecords.length, 1);
  assert.equal(result.staleRecords[0].path, '/Volumes/TipATask 0.8.15-arm64/TipATask.app');
});

test('classifyClaimants flags a live conflict under /Volumes as a mounted installer volume', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1355-ls-'));
  const runningPath = path.join(tmpDir, 'TipATask.app');
  await fs.mkdir(runningPath, { recursive: true });
  // Simulate a real /Volumes mount by pointing classifyClaimants at a real, existing path that
  // LOOKS like one — real filesystem access is mocked via a stub fs so this stays CI-safe.
  const fakeFs = {
    access: async (p) => {
      if (p === '/Volumes/TipATask 0.8.32-arm64/TipATask.app') return; // exists
      throw new Error('ENOENT');
    },
  };
  const claimants = [
    { path: runningPath, version: '0.8.32', mounted: true },
    { path: '/Volumes/TipATask 0.8.32-arm64/TipATask.app', version: '0.8.32', mounted: true },
  ];
  const result = await classifyClaimants({ claimants, runningPath, fs: fakeFs });
  assert.equal(result.liveConflicts.length, 1);
  assert.deepEqual(result.mountedInstallerVolumes.map((c) => c.path), ['/Volumes/TipATask 0.8.32-arm64/TipATask.app']);
});

test('reregisterBundle calls lsregister -f <path> and reports failure reason on non-zero exit', async () => {
  const okExec = mockExec([{ code: 0, stdout: '' }]);
  const okResult = await reregisterBundle('/Applications/TipATask.app', { exec: okExec });
  assert.equal(okResult.ok, true);
  assert.deepEqual(okExec.calls[0].args, ['-f', '/Applications/TipATask.app']);

  const failExec = mockExec([{ code: 1, stdout: '', stderr: 'permission denied\n' }]);
  const failResult = await reregisterBundle('/Applications/TipATask.app', { exec: failExec });
  assert.equal(failResult.ok, false);
  assert.equal(failResult.reason, 'permission denied');
});

test('ensureLaunchServicesHealthy: no conflicts -> registered, no repair attempted', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1355-ls-'));
  const bundlePath = path.join(tmpDir, 'TipATask.app');
  await fs.mkdir(bundlePath, { recursive: true });
  const markerDir = path.join(tmpDir, 'userData');

  const exec = mockExec([{ code: 0, stdout: `
--------------------------------------------------------------------------------
path:                       ${bundlePath} (0x1)
identifier:                 com.tipatask.app
version:                    0.8.32 ({length = 32})
` }]);

  const result = await ensureLaunchServicesHealthy({
    bundlePath, bundleId: 'com.tipatask.app', markerDir, version: '0.8.32', deps: { exec },
  });
  assert.equal(result.registered, true);
  assert.equal(result.conflicts, 0);
  assert.equal(result.repaired, false);
  assert.equal(result.relaunchNeeded, false);
  // Only the -dump call — no -f re-register call, since there was nothing to fix.
  assert.equal(exec.calls.length, 1);
});

test('ensureLaunchServicesHealthy: live conflict -> re-registers once, records a per-version marker, reports relaunchNeeded', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1355-ls-'));
  const bundlePath = path.join(tmpDir, 'TipATask.app');
  await fs.mkdir(bundlePath, { recursive: true });
  const conflictPath = path.join(tmpDir, 'Volumes-mounted', 'TipATask.app');
  await fs.mkdir(conflictPath, { recursive: true });
  const markerDir = path.join(tmpDir, 'userData');

  const dump = `
--------------------------------------------------------------------------------
path:                       ${bundlePath} (0x1)
identifier:                 com.tipatask.app
version:                    0.8.32 ({length = 32})
--------------------------------------------------------------------------------
path:                       ${conflictPath} (0x2)
identifier:                 com.tipatask.app
version:                    0.8.32 ({length = 32})
`;
  // Call 1: -dump. Call 2: -f <bundlePath> (the re-register).
  const exec = mockExec([{ code: 0, stdout: dump }, { code: 0, stdout: '' }]);

  const result = await ensureLaunchServicesHealthy({
    bundlePath, bundleId: 'com.tipatask.app', markerDir, version: '0.8.32', deps: { exec },
  });
  assert.equal(result.conflicts, 1);
  assert.equal(result.repaired, true);
  assert.equal(result.relaunchNeeded, true);
  assert.equal(exec.calls.length, 2);
  assert.deepEqual(exec.calls[1].args, ['-f', bundlePath]);

  const marker = JSON.parse(await fs.readFile(path.join(markerDir, '.ls-repair-0.8.32.json'), 'utf8'));
  assert.equal(marker.ok, true);

  // A second call for the SAME version must not re-register — one-shot-per-version guard,
  // same shape as bundle-signature.js's repair marker.
  const exec2 = mockExec([{ code: 0, stdout: dump }]);
  const result2 = await ensureLaunchServicesHealthy({
    bundlePath, bundleId: 'com.tipatask.app', markerDir, version: '0.8.32', deps: { exec: exec2 },
  });
  assert.equal(result2.repaired, false);
  assert.equal(exec2.calls.length, 1); // only -dump, no -f
});

const SELF = '/Applications/TipATask.app';
const COPY = '/tmp/build/TipATask.app';
const INSTALLER = '/Volumes/TipATask installer/TipATask.app';
const STALE = '/Volumes/Old installer/TipATask.app';
const records = (...paths) => paths.map(p => `\n--------------------------------------------------------------------------------\npath: ${p}\nidentifier: com.tipatask.app\nversion: 0.9.19\n`).join('');
const existing = { access: async p => { if (p === STALE) throw new Error('ENOENT'); } };
const options = exec => ({ bundlePath: SELF, bundleId: 'com.tipatask.app', deps: { exec, fs: existing } });

test('inspection deduplicates paths and reads version after identifier', async () => {
  const exec = mockExec([{ code: 0, stdout: records(SELF, COPY, COPY) }]);
  const snapshot = await inspectRegistration(options(exec));
  assert.equal(snapshot.conflicts, 1);
  assert.deepEqual(snapshot.conflictPaths, [COPY]);
  const claims = await listBundleClaimants('com.tipatask.app', { exec });
  assert.equal(claims[0].version, '0.9.19');
});

test('canonical paths identify self across symlinks and macOS /var aliases', async () => {
  const runningPath = '/var/tmp/TipATask.app';
  const registeredPath = '/private/var/tmp/TipATask.app';
  const result = await classifyClaimants({
    claimants: [{ path: registeredPath }], runningPath,
    fs: { realpath: async () => registeredPath, access: async () => {} },
  });
  assert.equal(result.self.path, registeredPath);
  assert.deepEqual(result.liveConflicts, []);
});

test('mounted installer blocks repair without unregistering, ejecting or re-registering anything', async () => {
  const exec = mockExec([{ code: 0, stdout: records(SELF, INSTALLER, COPY) }]);
  const result = await repairRegistrationWithVerification(options(exec));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked-installer');
  assert.equal(result.relaunchNeeded, false);
  assert.deepEqual(result.registration.installerVolumes, [INSTALLER]);
  assert.deepEqual(exec.calls.map(c => c.args), [['-dump']]);
});

test('running from the installer itself also blocks repair', async () => {
  const exec = mockExec([{ code: 0, stdout: records(INSTALLER) }]);
  const result = await repairRegistrationWithVerification({ ...options(exec), bundlePath: INSTALLER });
  assert.equal(result.outcome, 'blocked-installer');
  assert.deepEqual(exec.calls.map(c => c.args), [['-dump']]);
});

test('after ejection, repair removes duplicate/stale claims by path and verifies own registration', async () => {
  const exec = mockExec([
    { code: 0, stdout: records(SELF, COPY, STALE) },
    { code: 0 }, { code: 0 }, { code: 0 },
    { code: 0, stdout: records(SELF) },
  ]);
  const result = await repairRegistrationWithVerification(options(exec));
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'verified');
  assert.equal(result.relaunchNeeded, true);
  assert.deepEqual(exec.calls.map(c => c.args), [['-dump'], ['-u', COPY], ['-u', STALE], ['-f', SELF], ['-dump']]);
  // A fresh process/open sees the same clean snapshot, independent of the startup marker.
  const reopened = await inspectRegistration(options(exec));
  assert.equal(reopened.registered, true);
  assert.equal(reopened.conflicts, 0);
  assert.equal(reopened.staleCount, 0);
});

test('command success cannot conceal remaining duplicates, stale claims or missing self', async () => {
  for (const after of [records(SELF, COPY), records(SELF, STALE), records(COPY)]) {
    const exec = mockExec([{ code: 0, stdout: records(SELF) }, { code: 0 }, { code: 0, stdout: after }]);
    const result = await repairRegistrationWithVerification(options(exec));
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'verification-failed');
    assert.equal(result.relaunchNeeded, false);
  }
});

test('clean registration is re-registered and verified without unregistering self', async () => {
  const exec = mockExec([{ code: 0, stdout: records(SELF) }, { code: 0 }, { code: 0, stdout: records(SELF) }]);
  assert.equal((await repairRegistrationWithVerification(options(exec))).ok, true);
  assert.deepEqual(exec.calls.map(c => c.args), [['-dump'], ['-f', SELF], ['-dump']]);
});

test('repair surfaces unregister/register errors even if the final dump looks clean', async () => {
  for (const unregisterFails of [false, true]) {
    const exec = mockExec([
      { code: 0, stdout: records(SELF, COPY) },
      { code: unregisterFails ? 1 : 0, stderr: 'unregister denied' },
      { code: unregisterFails ? 0 : 1, stderr: 'register denied' },
      { code: 0, stdout: records(SELF) },
    ]);
    const result = await repairRegistrationWithVerification(options(exec));
    assert.equal(result.outcome, 'repair-error');
    assert.equal(result.ok, false);
    assert.match(result.reason, /denied/);
    assert.equal(result.registration.conflicts, 0);
  }
});

test('unknown/empty registration checks never report clean or mutate before inspection succeeds', async () => {
  for (const failure of [{ code: 1, stderr: 'timed out' }, { code: 0, stdout: '' }]) {
    const exec = mockExec([failure]);
    const result = await repairRegistrationWithVerification(options(exec));
    assert.equal(result.outcome, 'verification-failed');
    assert.equal(result.registration.checked, false);
    assert.equal(result.registration.conflicts, null);
    assert.deepEqual(exec.calls.map(c => c.args), [['-dump']]);
  }
  const throwing = () => { throw new Error('spawn failed'); };
  const result = await repairRegistrationWithVerification(options(throwing));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'spawn failed');
});

test('failed post-repair dump cannot report verified success', async () => {
  const exec = mockExec([{ code: 0, stdout: records(SELF) }, { code: 0 }, { code: 1, stderr: 'dump failed' }]);
  const result = await repairRegistrationWithVerification(options(exec));
  assert.equal(result.outcome, 'verification-failed');
  assert.equal(result.ok, false);
});

test('read-only diagnostic validates mounted, duplicate, stale, clean and unknown outcomes', () => {
  const { parseArgs, registrationOutcome } = require('../../scripts/probe-notif-registration');
  assert.equal(parseArgs(['--after-repair']).afterRepair, true);
  const clean = { checked: true, registered: true, conflicts: 0, staleCount: 0, installerVolumes: [] };
  assert.match(registrationOutcome(clean), /^VERIFIED/);
  assert.match(registrationOutcome({ ...clean, conflicts: 1 }), /^INCOMPLETE/);
  assert.match(registrationOutcome({ ...clean, staleCount: 1 }), /^INCOMPLETE/);
  assert.match(registrationOutcome({ ...clean, registered: false }), /^INCOMPLETE/);
  assert.match(registrationOutcome({ ...clean, installerVolumes: [INSTALLER] }), /^BLOCKED/);
  assert.match(registrationOutcome({ ...clean, checked: false, reason: 'timeout' }), /^UNKNOWN/);
});
