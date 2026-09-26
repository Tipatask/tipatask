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
