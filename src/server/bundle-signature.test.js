'use strict';

// (C1141) Unit tests for the self-heal path that fixes an already-installed packaged app whose
// code signature broke because it wrote TODO.md/recipes/ inside its own bundle (see
// config-data-root.test.js for the DATA_ROOT fix that stops this happening again, and
// ai/architecture/tt-notifications.md § C1141 for the full causal chain). `codesign`/`spctl`
// itself is always mocked — these must run identically on Linux CI and on a dev Mac, and must
// never depend on the tmp dir actually being a real signed bundle.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  STRAY_RESOURCE_PATHS,
  cleanStrayBundleFiles,
  findStrayBundleRootEntries,
  rescueAndCleanBundleRootEntries,
  verifyBundleSignature,
  repairBundleSignature,
  ensureBundleSignatureHealthy,
} = require('./bundle-signature');

async function makeBundle({ withStrayFiles = false } = {}) {
  const bundlePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1141-bundle-'));
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  await fs.mkdir(resourcesDir, { recursive: true });
  await fs.writeFile(path.join(resourcesDir, 'app.asar'), 'not a real asar, just a marker file', 'utf8');
  if (withStrayFiles) {
    await fs.writeFile(path.join(resourcesDir, 'TODO.md'), '# TODO\n', 'utf8');
    await fs.mkdir(path.join(resourcesDir, 'recipes'), { recursive: true });
    await fs.writeFile(path.join(resourcesDir, 'recipes', '0001_x.md'), 'x', 'utf8');
  }
  return bundlePath;
}

// (C1318) A bundle-ROOT stray — sibling of Contents/, not inside Contents/Resources. This is
// the shape config.js's pre-C1318 PROJECT_ROOT-guess bug actually produced live:
// /Applications/TipATask.app/ai/todo/{TODO.md,recipes/*.md}.
async function addBundleRootStray(bundlePath, { withRecipe = true } = {}) {
  const dataDir = path.join(bundlePath, 'ai', 'todo');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'TODO.md'), '# TODO\n', 'utf8');
  if (withRecipe) {
    const recipesDir = path.join(dataDir, 'recipes');
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(path.join(recipesDir, '0001_real_user_recipe.md'), 'actual user content', 'utf8');
  }
}

function mockExec(scriptedCalls) {
  // scriptedCalls: array of {code, stdout, stderr} consumed in call order, last one repeats.
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

test('cleanStrayBundleFiles removes only the known stray paths, leaves everything else untouched', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: true });
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');

  const removed = await cleanStrayBundleFiles(bundlePath);

  assert.deepEqual([...removed].sort(), [...STRAY_RESOURCE_PATHS].sort());
  await assert.rejects(fs.access(path.join(resourcesDir, 'TODO.md')));
  await assert.rejects(fs.access(path.join(resourcesDir, 'recipes')));
  await assert.doesNotReject(fs.access(path.join(resourcesDir, 'app.asar'))); // untouched
});

test('cleanStrayBundleFiles on an already-clean bundle removes nothing (no false "we changed something" signal)', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: false });
  const removed = await cleanStrayBundleFiles(bundlePath);
  assert.deepEqual(removed, []);
});

test('verifyBundleSignature: valid on exit code 0', async () => {
  const exec = mockExec([{ code: 0 }]);
  const result = await verifyBundleSignature('/some/bundle.app', { exec });
  assert.equal(result.valid, true);
  assert.equal(result.reason, null);
  assert.equal(exec.calls[0].args.includes('--verify'), true);
});

// (C1318) The actual regression: `codesign --verify --no-strict` reports valid:true for a
// bundle with unsealed contents at the bundle root — verified live against the installed
// app (`ai/architecture/tt-notifications.md` § C1318). --no-strict must never be passed.
test('(C1318) verifyBundleSignature runs a STRICT verify — never passes --no-strict', async () => {
  const exec = mockExec([{ code: 0 }]);
  await verifyBundleSignature('/some/bundle.app', { exec });
  assert.equal(exec.calls[0].args.includes('--no-strict'), false);
});

test('verifyBundleSignature: invalid + reason on nonzero exit (the "file added" case)', async () => {
  const exec = mockExec([{ code: 1, stderr: 'a sealed resource is missing or invalid\nfile added: /Applications/TipATask.app/Contents/Resources/TODO.md' }]);
  const result = await verifyBundleSignature('/some/bundle.app', { exec });
  assert.equal(result.valid, false);
  assert.match(result.reason, /file added/);
});

test('repairBundleSignature: ok on exit code 0, propagates the codesign re-sign args', async () => {
  const exec = mockExec([{ code: 0 }]);
  const result = await repairBundleSignature('/some/bundle.app', { exec });
  assert.equal(result.ok, true);
  assert.deepEqual(exec.calls[0].args, ['--force', '--deep', '--sign', '-', '/some/bundle.app']);
});

test('repairBundleSignature: failure is reported, never throws', async () => {
  const exec = mockExec([{ code: 1, stderr: 'codesign: the main executable is currently in use' }]);
  const result = await repairBundleSignature('/some/bundle.app', { exec });
  assert.equal(result.ok, false);
  assert.match(result.reason, /in use/);
});

test('ensureBundleSignatureHealthy: cleanup alone fixes it — repair (re-sign) never invoked', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: true });
  const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1141-marker-'));
  // verify called twice max (initial only, since it passes after cleanup) — script "always valid"
  const exec = mockExec([{ code: 0 }]);

  const result = await ensureBundleSignatureHealthy({ bundlePath, version: '1.1.75', markerDir, deps: { exec } });

  assert.equal(result.valid, true);
  assert.equal(result.repaired, false); // cleanup fixed it, repair step never needed
  assert.deepEqual([...result.cleaned].sort(), [...STRAY_RESOURCE_PATHS].sort());
  assert.equal(result.relaunchNeeded, true); // files WERE removed — still needs a relaunch
  // Only one codesign invocation: the verify call. No `--sign` repair call.
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].args[0], '--verify');
});

test('ensureBundleSignatureHealthy: already-healthy bundle — no cleanup, no repair, no relaunch needed', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: false });
  const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1141-marker-'));
  const exec = mockExec([{ code: 0 }]);

  const result = await ensureBundleSignatureHealthy({ bundlePath, version: '1.1.75', markerDir, deps: { exec } });

  assert.equal(result.valid, true);
  assert.equal(result.repaired, false);
  assert.deepEqual(result.cleaned, []);
  assert.equal(result.relaunchNeeded, false);
});

test('ensureBundleSignatureHealthy: cleanup insufficient (different corruption) — falls through to repair, re-verifies', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: false }); // nothing to clean
  const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1141-marker-'));
  // 1st verify: fails. repair: succeeds. 2nd verify (post-repair): passes.
  const exec = mockExec([
    { code: 1, stderr: 'some other corruption' },
    { code: 0 }, // repair
    { code: 0 }, // re-verify
  ]);

  const result = await ensureBundleSignatureHealthy({ bundlePath, version: '1.1.75', markerDir, deps: { exec } });

  assert.equal(result.valid, true);
  assert.equal(result.repaired, true);
  assert.equal(result.relaunchNeeded, true);
  assert.equal(exec.calls.length, 3);
  assert.equal(exec.calls[1].args[0], '--force'); // the repair call
});

test('ensureBundleSignatureHealthy: repair runs at most once per app version (marker guard)', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: false });
  const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1141-marker-'));
  // Every verify fails, every repair fails — a persistently-broken bundle.
  const exec = mockExec([{ code: 1, stderr: 'persistent corruption' }]);

  const first = await ensureBundleSignatureHealthy({ bundlePath, version: '2.0.0', markerDir, deps: { exec } });
  assert.equal(first.valid, false);
  assert.equal(first.repaired, false);
  const callsAfterFirst = exec.calls.length;
  assert.equal(callsAfterFirst, 2); // 1 verify + 1 repair attempt

  const second = await ensureBundleSignatureHealthy({ bundlePath, version: '2.0.0', markerDir, deps: { exec } });
  assert.equal(second.valid, false);
  // Same version, marker already recorded a repair attempt — no second --sign call, only verify.
  assert.equal(exec.calls.length, callsAfterFirst + 1);
  assert.equal(exec.calls[exec.calls.length - 1].args[0], '--verify');
});

// ── C1318: bundle-root strays (sibling of Contents/) ──

test('(C1318) findStrayBundleRootEntries: ignores Contents/ and OS metadata, reports everything else', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: false });
  await addBundleRootStray(bundlePath);
  await fs.writeFile(path.join(bundlePath, '.DS_Store'), '', 'utf8');

  const strays = await findStrayBundleRootEntries(bundlePath);

  assert.deepEqual(strays, ['ai']);
});

test('(C1318) findStrayBundleRootEntries: clean bundle root reports nothing', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: false });
  assert.deepEqual(await findStrayBundleRootEntries(bundlePath), []);
});

test('(C1318) rescueAndCleanBundleRootEntries: moves the stray (preserving its real content) out, then removes it from the bundle', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: false });
  await addBundleRootStray(bundlePath);
  const rescueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1318-rescue-'));

  const rescued = await rescueAndCleanBundleRootEntries(bundlePath, rescueDir);

  assert.equal(rescued.length, 1);
  assert.equal(rescued[0].name, 'ai');
  // Gone from the bundle — this is what restores the seal.
  await assert.rejects(fs.access(path.join(bundlePath, 'ai')));
  // The real user recipe content survived the move, verbatim.
  const recipeContent = await fs.readFile(
    path.join(rescued[0].to, 'todo', 'recipes', '0001_real_user_recipe.md'), 'utf8',
  );
  assert.equal(recipeContent, 'actual user content');
});

test('(C1318) rescueAndCleanBundleRootEntries: clean bundle root rescues nothing', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: false });
  const rescueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1318-rescue-'));
  assert.deepEqual(await rescueAndCleanBundleRootEntries(bundlePath, rescueDir), []);
});

test('(C1318) ensureBundleSignatureHealthy: a bundle-root stray alone (Contents/Resources already clean) is rescued and fixes the seal, no re-sign needed', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: false });
  await addBundleRootStray(bundlePath);
  const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1318-marker-'));
  const rescueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1318-rescue-'));
  const exec = mockExec([{ code: 0 }]); // verify passes once the stray is gone

  const result = await ensureBundleSignatureHealthy({ bundlePath, version: '1.1.76', markerDir, rescueDir, deps: { exec } });

  assert.equal(result.valid, true);
  assert.equal(result.repaired, false); // rescue alone fixed it — no --sign call
  assert.deepEqual(result.cleaned, []); // nothing in Contents/Resources
  assert.equal(result.rescued.length, 1);
  assert.equal(result.rescued[0].name, 'ai');
  assert.equal(result.relaunchNeeded, true);
  await assert.rejects(fs.access(path.join(bundlePath, 'ai')));
});

test('(C1318) ensureBundleSignatureHealthy: strays in BOTH locations at once are both handled in one pass', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: true }); // Contents/Resources/{TODO.md,recipes}
  await addBundleRootStray(bundlePath); // + bundle-root ai/todo/{TODO.md,recipes}
  const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1318-marker-'));
  const rescueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1318-rescue-'));
  const exec = mockExec([{ code: 0 }]);

  const result = await ensureBundleSignatureHealthy({ bundlePath, version: '1.1.76', markerDir, rescueDir, deps: { exec } });

  assert.equal(result.valid, true);
  assert.deepEqual([...result.cleaned].sort(), [...STRAY_RESOURCE_PATHS].sort());
  assert.equal(result.rescued.length, 1);
  assert.equal(result.relaunchNeeded, true);
});

test('ensureBundleSignatureHealthy: a new app version gets its own repair attempt even if the last version\'s failed', async () => {
  const bundlePath = await makeBundle({ withStrayFiles: false });
  const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-c1141-marker-'));
  const exec = mockExec([{ code: 1, stderr: 'persistent corruption' }]);

  await ensureBundleSignatureHealthy({ bundlePath, version: '2.0.0', markerDir, deps: { exec } });
  const callsAfterV1 = exec.calls.length;

  await ensureBundleSignatureHealthy({ bundlePath, version: '2.0.1', markerDir, deps: { exec } });
  // New version → repair attempted again (verify + repair), not just a verify.
  assert.equal(exec.calls.length, callsAfterV1 + 2);
});
