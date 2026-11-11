'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const beforePack = require('../../scripts/before-pack');
const { prepareMacSigning } = beforePack;
const pkg = require('../../package.json');

function fixture({ identity = null, config = {}, force = false, link = null } = {}) {
  const calls = [];
  const options = { ...pkg.build.mac, ...config };
  const context = {
    arch: 'arm64', electronPlatformName: 'darwin',
    packager: {
      projectDir: '/fixture', info: { framework: { version: '43.7.6' } },
      platformSpecificBuildOptions: options, forceCodeSigning: force,
      getCscLink: () => link,
      codeSigningInfo: { value: Promise.resolve({ keychainFile: '/fixture/login.keychain' }) },
      helper: { findSigningIdentity: async (...args) => { calls.push(args); return identity; } },
    },
  };
  return { context, options, calls };
}

for (const name of ['Developer ID Application: Test (TEAM)', 'Apple Development: Test (TEAM)']) {
  test(`macOS packaging preserves electron-builder discovery of ${name}`, async () => {
    const f = fixture({ identity: { name, hash: 'certificate-hash' } });
    await prepareMacSigning(f.context, { env: {} });
    assert.equal(f.options.identity, undefined);
    assert.deepEqual(f.calls, [[false, false, undefined, '/fixture/login.keychain', f.options]]);
  });
}

test('certificate-free macOS packaging falls back to ad-hoc signing for both CPUs', async () => {
  assert.equal(Object.hasOwn(pkg.build.mac, 'identity'), false, 'package must allow keychain discovery');
  for (const arch of ['x64', 'arm64']) {
    const f = fixture();
    f.context.arch = arch;
    await prepareMacSigning(f.context, { env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
    assert.equal(f.options.identity, '-');
    assert.equal(f.options.hardenedRuntime, true);
    assert.equal(f.options.entitlements, 'build/entitlements.mac.plist');
    assert.equal(f.options.entitlementsInherit, 'build/entitlements.mac.plist');
  }
});

test('explicit signing choices and required-signing errors are left to electron-builder', async () => {
  for (const opts of [
    { config: { identity: null } }, { config: { identity: '-' } },
    { config: { identity: 'TEAM' } }, { config: { sign: 'custom-sign.js' } },
    { force: true }, { link: '/fixture/certificate.p12' },
  ]) {
    const f = fixture(opts);
    const before = { ...f.options };
    await prepareMacSigning(f.context, { env: {} });
    assert.deepEqual(f.options, before);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  await prepareMacSigning(f.context, { env: { CSC_NAME: 'TEAM', CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  assert.equal(f.options.identity, undefined);
  assert.deepEqual(f.calls, []);
});

test('signing discovery failures fail packaging instead of silently downgrading', async () => {
  const f = fixture();
  f.context.packager.helper.findSigningIdentity = async () => { throw new Error('keychain unavailable'); };
  await assert.rejects(prepareMacSigning(f.context, { env: {} }), /keychain unavailable/);
  assert.equal(f.options.identity, undefined);
});

test('beforePack prepares macOS signing and retains staging and native rebuild', async () => {
  const f = fixture();
  const steps = [];
  await beforePack(f.context, {
    desktop: async (root, arch) => { steps.push('desktop'); assert.equal(arch, 'arm64'); },
    signing: async context => {
      steps.push('signing');
      await prepareMacSigning(context, { env: {} });
    },
    stage: async () => steps.push('stage'),
    rebuild: async options => { steps.push('rebuild'); assert.equal(options.arch, 'arm64'); },
  });
  assert.deepEqual(steps, ['signing', 'desktop', 'stage', 'rebuild']);
  assert.equal(f.options.identity, '-');
});

test('non-macOS targets do not inspect macOS signing credentials', async () => {
  for (const platform of ['win32', 'linux', 'mas']) {
    await prepareMacSigning({ electronPlatformName: platform });
  }
});

test('native rebuild translates Python for both CPUs and restores env after success or failure', async t => {
  const original = { npm_config_python: process.env.npm_config_python, PYTHON: process.env.PYTHON };
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const arch of ['x64', 'arm64']) {
    for (const [legacy, python] of [
      ['/legacy/python3.10', undefined], ['/legacy/python3.10', '/explicit/python3.11'],
      [undefined, '/explicit/python3.11'], ['', '/explicit/python3.11'], [undefined, undefined],
    ]) {
      for (const [key, value] of Object.entries({ npm_config_python: legacy, PYTHON: python })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const parentEnv = { ...process.env };
      for (const fail of [false, true]) {
        const f = fixture({ identity: { name: 'Developer ID Application: Test (TEAM)' } });
        f.context.arch = arch;
        const signingConfig = { ...f.options };
        const run = beforePack(f.context, {
          desktop: async () => {}, stage: async () => {},
          signing: context => prepareMacSigning(context, { env: {} }),
          rebuild: async options => {
            assert.equal(options.arch, arch);
            const expected = { ...parentEnv };
            delete expected.npm_config_python;
            if (legacy) expected.PYTHON = legacy;
            assert.ok(isDeepStrictEqual({ ...process.env }, expected), 'only Python entries change during rebuild');
            if (fail) throw new Error('native rebuild failed');
          },
        });
        if (fail) await assert.rejects(run, /native rebuild failed/);
        else await run;
        assert.ok(isDeepStrictEqual({ ...process.env }, parentEnv), 'parent env is restored');
        assert.deepEqual(f.options, signingConfig);
      }
    }
  }
});
