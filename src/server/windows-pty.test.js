'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createPackageWithOptions, uncache } = require('@electron/asar');
const { getFileMatchers, getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher');
const { doMergeConfigs } = require('app-builder-lib/out/util/config/config');
const { Arch } = require('builder-util');
const beforePack = require('../../scripts/before-pack');
const { assertPackagedWindowsPty } = require('../../scripts/check-packaged-tests');
const { MACHINES, WINDOWS_PTY_BINARIES, WINDOWS_PTY_SCRIPTS,
  assertWindowsPtyBinaries, assertWindowsPtySource } = require('../../scripts/windows-pty');
const pkg = require('../../package.json');

function fixture(t, arch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-pty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pty = path.join(root, 'node_modules', 'node-pty');
  const natives = path.join(pty, 'prebuilds', `win32-${arch}`);
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  };
  const pe = Buffer.alloc(512);
  pe.write('MZ');
  pe.writeUInt32LE(128, 0x3c);
  pe.write('PE\0\0', 128);
  pe.writeUInt16LE(MACHINES[arch], 132);
  pe.writeUInt16LE(0x20b, 152);
  for (const name of WINDOWS_PTY_BINARIES) write(path.join(natives, name), pe);
  for (const name of WINDOWS_PTY_SCRIPTS) write(path.join(pty, 'lib', name), '// runtime');
  write(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/node-pty': { version: '1.1.0' } } }));
  write(path.join(pty, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }));
  const host = path.join(pty, 'build', 'Release', 'pty.node');
  write(host, Buffer.from('cffaedfe', 'hex'));
  return { root, pty, natives, host, pe, write };
}

for (const arch of ['x64', 'arm64']) {
  test(`Windows ${arch} validates lockfile prebuilds and leaves host development module untouched`, async t => {
    const f = fixture(t, arch);
    const host = fs.readFileSync(f.host);
    let stages = 0;
    await beforePack({ arch: Arch[arch], electronPlatformName: 'win32', packager: { projectDir: f.root } }, {
      stage: async () => { stages++; }, rebuild: () => assert.fail('Windows must not rebuild host natives'),
    });
    assert.equal(stages, 1);
    assert.deepEqual(fs.readFileSync(f.host), host);
    f.write(path.join(f.pty, 'package.json'), JSON.stringify({ version: '0.0.1' }));
    assert.throws(() => assertWindowsPtySource(f.root, arch), /does not match lockfile/);
  });

  test(`Windows ${arch} rejects every missing companion, host format, wrong CPU and corrupt PE`, t => {
    const f = fixture(t, arch);
    assertWindowsPtyBinaries(f.natives, arch);
    for (const name of WINDOWS_PTY_BINARIES) {
      const file = path.join(f.natives, name);
      fs.unlinkSync(file);
      assert.throws(() => assertWindowsPtyBinaries(f.natives, arch), error => error.message.includes(file) && /ENOENT/.test(error.message));
      fs.mkdirSync(file);
      assert.throws(() => assertWindowsPtyBinaries(f.natives, arch), /not a regular file/);
      fs.rmdirSync(file);
      const wrongCpu = Buffer.from(f.pe);
      wrongCpu.writeUInt16LE(MACHINES[arch === 'x64' ? 'arm64' : 'x64'], 132);
      const corrupt = Buffer.from(f.pe);
      corrupt.writeUInt32LE(0xffffffff, 0x3c);
      for (const bytes of [Buffer.alloc(0), Buffer.from('cffaedfe', 'hex'), Buffer.from('\x7fELF'), wrongCpu, corrupt]) {
        fs.writeFileSync(file, bytes);
        assert.throws(() => assertWindowsPtyBinaries(f.natives, arch), /expected PE32\+/);
      }
      fs.writeFileSync(file, f.pe);
    }
  });

  test(`Windows ${arch} file mapping and ASAR assertion reject missing/host natives and missing workers`, async t => {
    const f = fixture(t, arch);
    const resources = path.join(f.root, 'resources');
    const staged = path.join(f.root, 'app-stage');
    fs.mkdirSync(resources);
    fs.cpSync(path.join(f.pty, 'lib'), path.join(staged, 'node_modules/node-pty/lib'), { recursive: true });
    const expand = value => value.replaceAll('${arch}', arch);
    const config = doMergeConfigs([structuredClone(pkg.build)]);
    const matchers = getFileMatchers(config, 'files', staged, {
      defaultSrc: f.root, macroExpander: expand, globalOutDir: path.join(f.root, 'out'), customBuildOptions: config.win,
    });
    // Normalization turns build.files into a root FileSet. A second root matcher
    // containing only platform exclusions would default to **/* and leak tests.
    const rootMatchers = matchers.filter(m => m.from === f.root);
    assert.equal(rootMatchers.length, 1);
    const testFile = path.join(f.root, 'src/server/leak.test.js');
    f.write(testFile, '// test');
    assert.equal(rootMatchers[0].createFilter()(testFile, fs.statSync(testFile)), false);
    const mapping = matchers.find(m => m.from === f.natives);
    assert.ok(mapping, 'Windows prebuilds must have their own file mapping');
    assert.equal(mapping.to, path.join(staged, 'node_modules/node-pty/build/Release'));
    fs.cpSync(mapping.from, mapping.to, { recursive: true, filter: (file, dest) => {
      const stat = fs.statSync(file);
      return stat.isDirectory() || mapping.createFilter()(file, stat);
    } });
    const moduleMatcher = getNodeModuleFileMatcher(f.root, staged, expand, config.win, {
      config, debugLogger: { isEnabled: false },
    });
    assert.equal(moduleMatcher.createFilter()(f.host, fs.statSync(f.host)), false);
    assert.equal(moduleMatcher.createFilter()(path.join(f.natives, 'conpty.node'), fs.statSync(path.join(f.natives, 'conpty.node'))), false);
    const archive = path.join(resources, 'app.asar');
    const repack = async (unpack = '**/node-pty/**') => {
      await createPackageWithOptions(staged, archive, { unpack });
      uncache(archive);
    };
    await repack();
    assertPackagedWindowsPty(resources, arch);
    const conpty = path.join(resources, 'app.asar.unpacked/node_modules/node-pty/build/Release/conpty.node');
    fs.writeFileSync(conpty, fs.readFileSync(f.host));
    assert.throws(() => assertPackagedWindowsPty(resources, arch), /expected PE32\+/);
    fs.unlinkSync(conpty);
    assert.throws(() => assertPackagedWindowsPty(resources, arch), /conpty\.node: ENOENT/);
    await repack();
    fs.unlinkSync(path.join(resources, 'app.asar.unpacked/node_modules/node-pty/lib/worker/conoutSocketWorker.js'));
    assert.throws(() => assertPackagedWindowsPty(resources, arch), /ENOENT/);
    await repack('**/*.node');
    // Companions deliberately packed inside ASAR must fail even if stale unpacked files exist.
    assert.throws(() => assertPackagedWindowsPty(resources, arch), /must be unpacked/);
  });
}

test('POSIX packaging keeps sequential Electron rebuild with target CPU', async () => {
  for (const platform of ['darwin', 'linux']) {
    const calls = [];
    await beforePack({ arch: Arch.x64, electronPlatformName: platform,
      packager: { projectDir: '/fixture', info: { framework: { version: '43.7.6' } } } }, {
      stage: async () => calls.push('stage'), rebuild: async opts => calls.push(opts),
    });
    assert.equal(calls[0], 'stage');
    assert.deepEqual(calls[1], { buildPath: '/fixture', projectRootPath: '/fixture', electronVersion: '43.7.6',
      platform, arch: 'x64', mode: 'sequential', disablePreGypCopy: true });
  }
  assert.equal(pkg.build.npmRebuild, false);
  assert.equal(pkg.build.beforePack, 'scripts/before-pack.js');
  assert.throws(() => assertWindowsPtyBinaries('/unused', 'ia32'), /Unsupported Windows/);
});
