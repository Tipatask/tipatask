'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { ensurePiInstalled, stagePiBundle, stageWindowsNode, stageTargetWindowsNode, beforePack,
  stageNotices, readExpectedState, validateTree, pruneForeignOptional } = require('../../scripts/stage-pi-bundle');

const PI = 'node_modules/@earendil-works/pi-coding-agent';
const DEP = 'node_modules/example-dependency';
const ARM = 'node_modules/arm-only';
const X64 = 'node_modules/x64-only';
const silent = { log() {} };

test('Windows Pi bundle stages pinned standalone Node and the complete distribution license', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pi-node-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'build-node');
  fs.mkdirSync(source);
  const execPath = path.join(source, 'node.exe');
  const license = 'Node.js license\nFull dependency notices\n';
  fs.writeFileSync(execPath, 'standalone Node executable');
  fs.writeFileSync(path.join(source, 'LICENSE'), license);
  fs.writeFileSync(path.join(root, '.nvmrc'), '22.22.1\n');
  const dest = path.join(root, 'vendor', 'pi', 'node_modules', 'tipatask-node');
  const spawn = (command, args, options) => {
    assert.equal(command, path.join(dest, 'node.exe'));
    assert.deepEqual(args, ['--version']);
    assert.equal(options.timeout, 10000);
    assert.equal(options.windowsHide, true);
    assert.equal(options.encoding, 'utf8');
    assert.equal(fs.readFileSync(command, 'utf8'), 'standalone Node executable');
    assert.equal(fs.readFileSync(path.join(dest, 'LICENSE'), 'utf8'), license);
    return { status: 0, stdout: 'v22.22.1\r\n' };
  };
  const opts = { serverRoot: root, platform: 'win32', execPath, version: 'v22.22.1', electron: false, spawn, log: silent };
  stageWindowsNode(opts);
  assert.equal(fs.readFileSync(path.join(dest, 'node.exe'), 'utf8'), 'standalone Node executable');
  assert.equal(fs.readFileSync(path.join(dest, 'LICENSE'), 'utf8'), license);
  assert.throws(() => stageWindowsNode({ ...opts, version: 'v20.0.0' }), /standalone Node 22.22.1/);
  assert.throws(() => stageWindowsNode({ ...opts, electron: '43' }), /standalone Node 22.22.1/);
  for (const result of [
    { status: 0, stdout: 'v22.22.0\n' },
    { status: 0, stdout: '' },
    { status: 1, stdout: 'v22.22.1\n' },
    { status: null, error: new Error('corrupt executable') },
    { status: null, signal: 'SIGTERM', error: new Error('spawnSync ETIMEDOUT') },
  ]) {
    assert.throws(() => stageWindowsNode({ ...opts, spawn: () => result }), error => {
      assert.match(error.message, /failed verification: expected v22\.22\.1/);
      assert.ok(error.message.includes(path.join(dest, 'node.exe')));
      assert.match(error.message, /rerun scripts\/stage-pi-bundle\.js/);
      return true;
    });
  }
  fs.rmSync(path.join(source, 'LICENSE'));
  assert.throws(() => stageWindowsNode(opts), /LICENSE missing/);
  assert.doesNotThrow(() => stageWindowsNode({ serverRoot: '/unused', platform: 'darwin' }));
});

test('staged runtime executes successfully and rejects a real wrong-version or corrupt copy', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pi-node-exec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'build node');
  fs.mkdirSync(source);
  const execPath = path.join(source, 'node.exe');
  fs.copyFileSync(process.execPath, execPath);
  fs.writeFileSync(path.join(source, 'LICENSE'), 'fixture license');
  fs.writeFileSync(path.join(root, '.nvmrc'), process.version.replace(/^v/, '') + '\n');
  const opts = { serverRoot: root, platform: 'win32', execPath, version: process.version, electron: false, log: silent };
  stageWindowsNode(opts);

  fs.writeFileSync(path.join(root, '.nvmrc'), '0.0.0\n');
  assert.throws(() => stageWindowsNode({ ...opts, version: 'v0.0.0' }), /failed verification: expected v0\.0\.0/);
  fs.writeFileSync(path.join(root, '.nvmrc'), process.version.replace(/^v/, '') + '\n');
  assert.throws(() => stageWindowsNode({ ...opts, spawn(command, args, options) {
    fs.writeFileSync(command, 'corrupt executable');
    return spawnSync(command, args, options);
  } }), /failed verification/);
});

test('Windows Pi bundle notices identify the shipped standalone Node license', t => {
  const f = fixture(t);
  f.run();
  const runtime = path.join(f.vendor, 'node_modules', 'tipatask-node');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'node.exe'), '');
  stageNotices({ serverRoot: f.root, spawn: f.spawn, log: silent });
  const notices = fs.readFileSync(path.join(f.vendor, 'node_modules', 'THIRD-PARTY-NOTICES.md'), 'utf8');
  assert.match(notices, /Standalone Node.js runtime/);
  assert.match(notices, /tipatask-node\/LICENSE/);
});

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
        if (!allPlatforms && pkg.os && !pkg.os.includes(args.find(arg => arg.startsWith('--os='))?.slice(5) || 'darwin')) continue;
        if (!allPlatforms && pkg.cpu && !pkg.cpu.includes(args.find(arg => arg.startsWith('--cpu='))?.slice(6) || 'arm64')) continue;
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

function windowsDistribution(t, arch) {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, '.nvmrc'), '22.22.1\n');
  const dir = path.join(f.root, 'downloaded-node');
  fs.mkdirSync(dir);
  const bytes = Buffer.alloc(1024 * 1024 + 1);
  bytes.write('MZ');
  bytes.writeUInt32LE(128, 0x3c);
  bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE({ x64: 0x8664, arm64: 0xaa64, ia32: 0x014c }[arch], 132);
  const execPath = path.join(dir, 'node.exe');
  fs.writeFileSync(execPath, bytes);
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'Complete Node distribution license');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { ...f, execPath, sha256 };
}

test('cross-build stages the pinned Windows distribution for each target CPU and rejects corrupt or wrong-CPU files', async t => {
  for (const arch of ['x64', 'arm64', 'ia32']) {
    const f = windowsDistribution(t, arch);
    const opts = { serverRoot: f.root, platform: 'win32', arch, hostPlatform: 'darwin', hostArch: 'arm64', log: silent,
      download: async (pinned, cpu) => {
        assert.equal(pinned, '22.22.1');
        assert.equal(cpu, arch);
        return f;
      }, spawn() { assert.fail('Cross-build must not execute a Windows binary'); } };
    await stageTargetWindowsNode(opts);
    const runtime = path.join(f.vendor, 'node_modules', 'tipatask-node');
    assert.deepEqual(fs.readFileSync(path.join(runtime, 'node.exe')), fs.readFileSync(f.execPath));
    assert.equal(fs.readFileSync(path.join(runtime, 'LICENSE'), 'utf8'), 'Complete Node distribution license');
    await assert.rejects(stageTargetWindowsNode({ ...opts, download: async () => ({ ...f, sha256: '0'.repeat(64) }) }), /checksum mismatch/);
    const other = arch === 'arm64' ? 'x64' : 'arm64';
    await assert.rejects(stageTargetWindowsNode({ ...opts, arch: other, download: async () => f }), /not a valid/);
    fs.writeFileSync(f.execPath, 'corrupt');
    await assert.rejects(stageTargetWindowsNode(opts), /not a valid/);
  }
});

test('beforePack follows electron-builder target and uses the host npm, including after a cached Mac staging run', async t => {
  const f = windowsDistribution(t, 'arm64');
  f.run();
  const context = { electronPlatformName: 'win32', arch: 3, packager: { projectDir: f.root } };
  const opts = { hostPlatform: 'darwin', hostArch: 'arm64', spawn: f.spawn, download: async () => f, log: silent };
  await beforePack(context, opts);
  const install = f.calls.filter(call => call.args[0] === 'ci').at(-1);
  assert.equal(install.command, 'npm');
  assert.equal(install.options.shell, false);
  assert.ok(install.args.includes('--os=win32'));
  assert.ok(install.args.includes('--cpu=arm64'));
  assert.equal(validateTree(f.vendor, f.lock, 'win32', 'arm64'), null);
  assert.ok(fs.existsSync(path.join(f.vendor, 'node_modules/tipatask-node/node.exe')));
  const installs = f.calls.filter(call => call.args[0] === 'ci').length;
  await beforePack(context, opts);
  assert.equal(f.calls.filter(call => call.args[0] === 'ci').length, installs);

  await beforePack({ ...context, electronPlatformName: 'darwin' }, opts);
  assert.equal(validateTree(f.vendor, f.lock, 'darwin', 'arm64'), null);
  assert.equal(fs.existsSync(path.join(f.vendor, 'node_modules/tipatask-node')), false);
});
