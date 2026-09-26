'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ensurePiInstalled, stagePiBundle, readExpectedState, validateTree, pruneForeignOptional } = require('../../scripts/stage-pi-bundle');

const PI = 'node_modules/@earendil-works/pi-coding-agent';
const DEP = 'node_modules/example-dependency';
const ARM = 'node_modules/arm-only';
const X64 = 'node_modules/x64-only';
const silent = { log() {} };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpt336-pi-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vendor = path.join(root, 'vendor', 'pi');
  fs.mkdirSync(vendor, { recursive: true });
  fs.writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({
    name: 'fixture', dependencies: { '@earendil-works/pi-coding-agent': '1.0.0' },
  }));
  const lock = { lockfileVersion: 3, packages: {
    '': { dependencies: { '@earendil-works/pi-coding-agent': '1.0.0' } },
    [PI]: { version: '1.0.0' },
    [DEP]: { version: '2.0.0' },
    [ARM]: { version: '3.0.0', optional: true, os: ['darwin'], cpu: ['arm64'] },
    [X64]: { version: '3.0.0', optional: true, os: ['darwin'], cpu: ['x64'] },
  } };
  const lockPath = path.join(vendor, 'package-lock.json');
  const writeLock = () => fs.writeFileSync(lockPath, JSON.stringify(lock));
  writeLock();
  const calls = [];
  let installerStatus = 0;
  let leaveOut = null;
  let allPlatforms = false; // real npm ci installs every optional binary in the shrinkwrap
  const spawn = (command, args, options) => {
    if (args[0] === 'ci') {
      calls.push({ command, args, options });
      if (installerStatus !== 0) return { status: installerStatus };
      fs.rmSync(path.join(vendor, 'node_modules'), { recursive: true, force: true });
      for (const [relative, pkg] of Object.entries(lock.packages)) {
        if (!relative || relative === leaveOut) continue;
        if (!allPlatforms && pkg.os && !pkg.os.includes('darwin')) continue;
        if (!allPlatforms && pkg.cpu && !pkg.cpu.includes(options.arch || 'arm64')) continue;
        const pkgDir = path.join(vendor, relative);
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version: pkg.version }));
      }
      fs.mkdirSync(path.join(vendor, PI, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(vendor, PI, 'dist', 'cli.js'), '');
      return { status: 0 };
    }
    calls.push({ command, args, options });
    fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), 'generated notices');
    return { status: 0 };
  };
  const run = (arch = 'arm64', log = silent) => ensurePiInstalled({ serverRoot: root, platform: 'darwin', arch, spawn: (command, args, options) => spawn(command, args, { ...options, arch }), log });
  return { root, vendor, lock, writeLock, calls, run, spawn,
    failInstall(status) { installerStatus = status; },
    installAllPlatforms() { allPlatforms = true; },
    omit(relative) { leaveOut = relative; },
  };
}

test('exact cache hit skips npm ci and still refreshes license and notices', (t) => {
  const f = fixture(t);
  const options = { serverRoot: f.root, platform: 'darwin', arch: 'arm64',
    spawn: (command, args, info) => f.spawn(command, args, { ...info, arch: 'arm64' }), log: silent };
  stagePiBundle(options);
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['ci', '--omit=dev', '--ignore-scripts']);
  assert.equal(f.calls.filter((call) => call.args[0] === 'ci').length, 1);
  fs.writeFileSync(path.join(f.vendor, PI, 'LICENSE'), 'stale');
  fs.writeFileSync(path.join(f.vendor, 'node_modules', 'THIRD-PARTY-NOTICES.md'), 'stale');
  stagePiBundle(options);
  assert.equal(f.calls.filter((call) => call.args[0] === 'ci').length, 1);
  assert.equal(f.calls.filter((call) => call.args[0] !== 'ci').length, 2);
  assert.match(fs.readFileSync(path.join(f.vendor, PI, 'LICENSE'), 'utf8'), /Mario Zechner/);
  assert.equal(fs.readFileSync(path.join(f.vendor, 'node_modules', 'THIRD-PARTY-NOTICES.md'), 'utf8'), 'generated notices');
});

test('prefix cache hit with changed transitive lock rebuilds matching dependency versions', (t) => {
  const f = fixture(t);
  f.run();
  f.lock.packages[DEP].version = '2.0.1';
  f.writeLock();
  assert.equal(f.run(), true);
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.vendor, DEP, 'package.json'))).version, '2.0.1');
  assert.equal(validateTree(f.vendor, f.lock, 'darwin', 'arm64'), null);
  const stamp = JSON.parse(fs.readFileSync(path.join(f.vendor, 'node_modules', '.tipatask-pi-stage.json')));
  assert.equal(stamp.fingerprint, readExpectedState(f.vendor, 'darwin', 'arm64').fingerprint);
});

test('missing dependency, wrong version, or missing CLI rebuilds incomplete trees', (t) => {
  const f = fixture(t);
  f.run();
  fs.rmSync(path.join(f.vendor, DEP), { recursive: true });
  assert.equal(f.run(), true);
  fs.writeFileSync(path.join(f.vendor, DEP, 'package.json'), JSON.stringify({ version: 'old' }));
  assert.equal(f.run(), true);
  fs.rmSync(path.join(f.vendor, PI, 'dist', 'cli.js'));
  assert.equal(f.run(), true);
  assert.equal(f.calls.length, 4);
});

test('failed or incomplete npm ci never records a valid stamp', (t) => {
  const f = fixture(t);
  f.run();
  f.lock.packages[DEP].version = '2.0.1';
  f.writeLock();
  f.failInstall(1);
  assert.throws(() => f.run(), /npm ci failed/);
  assert.equal(fs.existsSync(path.join(f.vendor, 'node_modules', '.tipatask-pi-stage.json')), false);
  f.failInstall(0);
  f.omit(DEP);
  assert.throws(() => f.run(), /incomplete Pi bundle: .* is missing/);
  assert.equal(fs.existsSync(path.join(f.vendor, 'node_modules', '.tipatask-pi-stage.json')), false);
});

test('platform change rejects old optional package set and restages current architecture', (t) => {
  const f = fixture(t);
  f.run('arm64');
  assert.equal(f.run('x64'), true);
  assert.equal(fs.existsSync(path.join(f.vendor, ARM, 'package.json')), false);
  assert.equal(fs.existsSync(path.join(f.vendor, X64, 'package.json')), true);
  assert.equal(f.run('x64'), false);
  assert.equal(f.calls.length, 2);
});

function seedPackage(vendor, relative, version = '3.0.0') {
  fs.mkdirSync(path.join(vendor, relative), { recursive: true });
  fs.writeFileSync(path.join(vendor, relative, 'package.json'), JSON.stringify({ version }));
}

test('pruneForeignOptional removes only installed foreign optional packages', (t) => {
  const f = fixture(t);
  f.run();
  seedPackage(f.vendor, X64);
  assert.deepEqual(pruneForeignOptional(f.vendor, f.lock, 'darwin', 'arm64', silent), [X64]);
  assert.equal(fs.existsSync(path.join(f.vendor, X64)), false);
  for (const kept of [ARM, DEP, PI]) assert.equal(fs.existsSync(path.join(f.vendor, kept, 'package.json')), true);
  assert.deepEqual(pruneForeignOptional(f.vendor, f.lock, 'darwin', 'arm64', silent), []);
});

test('npm ci that installs foreign optional binaries still stages, then skips on rerun', (t) => {
  const f = fixture(t);
  f.installAllPlatforms();
  assert.equal(f.run(), true);
  assert.equal(fs.existsSync(path.join(f.vendor, X64)), false);
  assert.equal(fs.existsSync(path.join(f.vendor, ARM, 'package.json')), true);
  assert.equal(fs.existsSync(path.join(f.vendor, 'node_modules', '.tipatask-pi-stage.json')), true);
  const lines = [];
  assert.equal(f.run('arm64', { log: (line) => lines.push(line) }), false);
  assert.equal(f.calls.filter((call) => call.args[0] === 'ci').length, 1);
  assert.ok(lines.some((line) => /skipping install/.test(line)));
});

test('a stray foreign binary on a current tree does not force a reinstall', (t) => {
  const f = fixture(t);
  f.run();
  seedPackage(f.vendor, X64);
  assert.equal(f.run(), false);
  assert.equal(fs.existsSync(path.join(f.vendor, X64)), false);
  assert.equal(f.calls.length, 1);
});

test('a staged patched ws over the shrinkwrapped copy does not force a reinstall', (t) => {
  const f = fixture(t);
  const piWs = `${PI}/node_modules/ws`;
  f.lock.packages[piWs] = { version: '8.21.0' };
  f.writeLock();
  f.run();
  fs.writeFileSync(path.join(f.vendor, piWs, 'package.json'), JSON.stringify({ version: '8.21.3' }));
  assert.match(validateTree(f.vendor, f.lock, 'darwin', 'arm64'), /8\.21\.3/);
  assert.equal(validateTree(f.vendor, f.lock, 'darwin', 'arm64', { [piWs]: '8.21.3' }), null);
  fs.mkdirSync(path.join(f.root, 'node_modules', 'ws'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'node_modules', 'ws', 'package.json'), JSON.stringify({ version: '8.21.3' }));
  assert.equal(f.run(), false);
});
