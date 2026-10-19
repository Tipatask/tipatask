'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createPackage, createPackageWithOptions, uncache } = require('@electron/asar');
const { WINDOWS_PTY_BINARIES, WINDOWS_PTY_SCRIPTS } = require('../../scripts/windows-pty');
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
const afterPack = require('../../scripts/check-packaged-tests');
const { discoverTests } = require('../../scripts/run-tests');
const pkg = require('../../package.json');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-tooling-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runnerFixture(t) {
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'));
  for (const name of ['run-tests.js', 'check-node-version.js', 'test-guard.cjs']) {
    fs.copyFileSync(path.resolve(__dirname, '../../scripts', name), path.join(dir, 'scripts', name));
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engines: pkg.engines }));
  fs.symlinkSync(path.resolve(__dirname, '../../node_modules'), path.join(dir, 'node_modules'), 'junction');
  const stateFile = path.join(dir, 'worker-state.json');
  return {
    dir,
    write(code) {
      fs.writeFileSync(path.join(dir, 'src', 'nested', 'behavior.test.cjs'), `
        require('node:fs').writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({
          project: process.env.TIPATASK_PROJECT_ROOT,
          userData: process.env.TIPATASK_USER_DATA,
        }));
        ${code}
      `);
    },
    run(overrides = {}) {
      const env = { ...process.env, ...overrides, NODE_V8_COVERAGE: '' };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_OPTIONS;
      const result = spawnSync(process.execPath, [path.join(dir, 'scripts', 'run-tests.js')], {
        cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 20000,
      });
      assert.equal(result.error, undefined, result.stderr);
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        assert.equal(state.project, state.userData);
        assert.notEqual(state.project, dir);
        assert.equal(fs.existsSync(state.project), false, 'runner cleans worker state even on failure');
      }
      return result;
    },
  };
}

test('runner isolates inherited credentials and discovers nested tests from any working directory', t => {
  const fixture = runnerFixture(t);
  const inherited = {
    API_TOKEN: 'fixture-token', API_PROJECT_ID: 'fixture-project',
    TIPATASK_PROJECT_ROOT: fixture.dir, TIPATASK_USER_DATA: fixture.dir,
    TASK_AGENT: 'fixture-agent', CLAUDE_MODEL: 'fixture-model', CODEX_HOME: fixture.dir,
    PI_MODEL: 'fixture-model', GEMINI_API_KEY: 'fixture-key', ASSEMBLYAI_API_KEY: 'fixture-key',
    OPENAI_API_KEY: 'fixture-key', GITHUB_TOKEN: 'fixture-token', DB_PASSWORD: 'fixture-password',
  };
  fixture.write(`
    const assert = require('node:assert/strict');
    for (const key of ${JSON.stringify(Object.keys(inherited).filter(k => !k.startsWith('TIPATASK_')))}) {
      assert.equal(process.env[key], undefined, key);
    }
    assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, '1');
    const path = require('node:path');
    assert.equal(path.dirname(process.env.CLAUDE_CONFIG_DIR), process.env.TIPATASK_PROJECT_ROOT);
    assert.deepEqual(require('node:fs').readdirSync(process.env.TIPATASK_PROJECT_ROOT), [path.basename(process.env.CLAUDE_CONFIG_DIR)]);
  `);
  const result = fixture.run(inherited);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Discovered 1 test files/);
});

test('runner fails when discovery is empty', t => {
  const result = runnerFixture(t).run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No unit tests discovered/);
});

test('runner gives Claude config writers separate worker profiles inherited by their children', t => {
  const fixture = runnerFixture(t);
  const profiles = [path.join(fixture.dir, 'profile-one.json'), path.join(fixture.dir, 'profile-two.json')];
  const worker = output => `
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.CLAUDE_CONFIG_DIR)'], { encoding: 'utf8' });
    require('node:assert/strict').equal(result.stdout, process.env.CLAUDE_CONFIG_DIR);
    require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env.CLAUDE_CONFIG_DIR));
  `;
  fixture.write(worker(profiles[0]));
  fs.writeFileSync(path.join(fixture.dir, 'src', 'other.test.cjs'), worker(profiles[1]));
  const result = fixture.run({ CLAUDE_CONFIG_DIR: fixture.dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [one, two] = profiles.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.notEqual(one, two);
  for (const profile of [one, two]) {
    assert.notEqual(profile, fixture.dir);
    assert.equal(fs.existsSync(profile), false, 'runner cleans temporary Claude profiles');
  }
});

test('runner propagates assertion failures and cleans temporary state', t => {
  const fixture = runnerFixture(t);
  fixture.write("require('node:assert/strict').fail('runner assertion sentinel');");
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /runner assertion sentinel/);
});

test('runner fails for swallowed guard violations in inherited Node children', t => {
  const fixture = runnerFixture(t);
  fixture.write(`
    const result = require('node:child_process').spawnSync(process.execPath, ['-e',
      "try { fetch('https://example.invalid/'); } catch {}"
    ], { encoding: 'utf8' });
    require('node:assert/strict').equal(result.status, 0, result.stderr);
  `);
  const result = fixture.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Unit test attempted external fetch to example\.invalid/);
});

test('runner fails when a test or its helper writes the shared account store, not a private one', t => {
  const fixture = runnerFixture(t);
  const seed = "require('node:fs').writeFileSync(require('node:path').join(process.env.TIPATASK_USER_DATA, '.tipatask-account.json'), '{}');";
  // The helper inherits the worker's env, so it writes whichever store TIPATASK_USER_DATA names.
  const accountStore = JSON.stringify(require.resolve('./account-store'));
  const helper = `
    const helper = require('node:child_process').spawnSync(process.execPath, ['-e',
      ${JSON.stringify(`require(${accountStore}).writeAccountToken('http://127.0.0.1:9', 'fixture-token')`)}], { encoding: 'utf8' });
    require('node:assert/strict').equal(helper.status, 0, helper.stderr);
  `;
  // A private project root alone leaves the user-data root shared.
  fixture.write(`process.env.TIPATASK_PROJECT_ROOT = require('node:os').tmpdir(); ${seed} ${helper}`);
  const shared = fixture.run();
  assert.equal(shared.status, 1, shared.stdout + shared.stderr);
  for (const op of ['writeFileSync', 'renameSync']) {
    assert.match(shared.stderr, new RegExp(`fs\\.${op} into the runner's shared account store from src/nested/behavior\\.test\\.cjs\\. .*tt-ci\\.md`));
  }

  // A private user-data root passes, even when it is also the project root.
  fixture.write(`
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tt-fixture-userdata-'));
    process.env.TIPATASK_USER_DATA = dir;
    process.env.TIPATASK_PROJECT_ROOT = dir;
    try { ${seed} ${helper} } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  `);
  const isolated = fixture.run();
  assert.equal(isolated.status, 0, isolated.stdout + isolated.stderr);
  assert.doesNotMatch(isolated.stderr, /shared account store/);
});

test('test discovery includes root and deeply nested tests, ignores helpers and symlinks', t => {
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  for (const name of ['root.test.js', 'a/nested.test.cjs', 'a/b/deep.test.mjs', 'a/helper.js']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  if (process.platform !== 'win32') fs.symlinkSync(path.join(dir, 'root.test.js'), path.join(dir, 'alias.test.js'));
  assert.deepEqual(discoverTests(dir).map(f => path.relative(dir, f).split(path.sep).join('/')),
    ['a/b/deep.test.mjs', 'a/nested.test.cjs', 'root.test.js']);
});

test('actual Electron file matcher keeps runtime files and excludes tests and helpers', () => {
  const root = path.resolve(__dirname, '../..');
  const filter = new FileMatcher(root, '/unused', x => x, pkg.build.files).createFilter();
  const stat = { isDirectory: () => false };
  for (const file of ['main.js', 'preload.js', 'src/server/config.js', 'src/mcp/auth-header-helper.js', 'src/server/git-merge/git-runner.js',
    'scripts/push-kb-on-write.js', 'scripts/tool-result-cache.js', 'scripts/track-file-access.js']) {
    assert.equal(filter(path.join(root, file), stat), true, file);
  }
  for (const file of ['src/server/config.test.js', 'src/server/task-agent/file-attach.test.js', 'main/window.test.cjs',
    'src/client/task-edit-modal-dom-runner.mjs', 'src/client/new-task-assignee-dom-runner.mjs',
    'src/server/git-merge/test-fixture.js', 'coverage/index.html', 'scripts/probe-kb-lock.js', 'bin/mcp-node']) {
    assert.equal(filter(path.join(root, file), stat), false, file);
  }
});

test('every script the Claude settings template hooks run exists and is packaged', () => {
  const root = path.resolve(__dirname, '../..');
  const filter = new FileMatcher(root, '/unused', x => x, pkg.build.files).createFilter();
  const stat = { isDirectory: () => false };
  const scripts = afterPack.hookScriptsFromSettings(fs.readFileSync(path.join(root, afterPack.HARNESS_SETTINGS), 'utf8'));
  assert.deepEqual(scripts, ['scripts/push-kb-on-write.js', 'scripts/tool-result-cache.js', 'scripts/track-file-access.js']);
  for (const script of scripts) {
    assert.ok(fs.existsSync(path.join(root, script)), script);
    assert.equal(filter(path.join(root, script), stat), true, script);
  }
  // Non-script hooks (the ExitPlanMode plan saver) and malformed groups contribute nothing.
  assert.deepEqual(afterPack.hookScriptsFromSettings(JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ command: "jq -r '.tool_input.plan' > plan.md" }] }, { hooks: [] }],
    PostToolUse: 'not-a-list',
  } })), []);
});

// A packaged tree whose versions all agree with package-lock.json: asar (source files plus one
// package.json per production dependency), app.asar.unpacked (sherpa platform prebuilds) and the
// resources/pi bundle. Tests then break one thing at a time.
const lock = require('../../package-lock.json');
const lockVersion = name => lock.packages[`node_modules/${name}`].version;
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};

function packagedFixture(t) {
  const dir = scratch(t);
  const source = path.join(dir, 'source');
  const resources = path.join(dir, 'resources');
  fs.mkdirSync(source);
  fs.mkdirSync(resources);
  fs.writeFileSync(path.join(source, 'main.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(source, 'preload.js'), '');
  fs.writeFileSync(path.join(source, 'todo-server.js'), '');
  // The real settings template names the hook scripts the archive must ship; stubs stand in for them.
  const template = fs.readFileSync(path.resolve(__dirname, '../..', afterPack.HARNESS_SETTINGS), 'utf8');
  fs.mkdirSync(path.join(source, path.dirname(afterPack.HARNESS_SETTINGS)), { recursive: true });
  fs.writeFileSync(path.join(source, afterPack.HARNESS_SETTINGS), template);
  fs.mkdirSync(path.join(source, 'scripts'));
  for (const script of afterPack.hookScriptsFromSettings(template)) fs.writeFileSync(path.join(source, script), '');
  for (const file of ['package.json', 'src/server/vcs-settings.js', 'src/server/vcs-context.js',
    'src/server/vcs-runtime.js', 'src/server/task-agent/base-agent.js', 'src/server/task-agent/codex-agent.js',
    'src/server/terminal-session.js', 'src/server/ws-handlers.js', 'src/server/index.js', 'src/server/api-backend.js',
    'src/server/git-merge/completion-guard.js', 'src/mcp/server.js']) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../..', file), path.join(source, file));
  }
  for (const name of Object.keys(pkg.dependencies)) {
    if (name === afterPack.PI_PACKAGE) continue;
    writeJson(path.join(source, 'node_modules', name, 'package.json'), { name, version: lockVersion(name) });
  }
  const ptyRoot = path.join(source, 'node_modules', 'node-pty');
  const pe = Buffer.alloc(512);
  pe.write('MZ');
  pe.writeUInt32LE(128, 0x3c);
  pe.write('PE\0\0', 128);
  pe.writeUInt16LE(0x8664, 132);
  pe.writeUInt16LE(0x20b, 152);
  for (const binary of WINDOWS_PTY_BINARIES) {
    const file = path.join(ptyRoot, 'build', 'Release', binary);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pe);
  }
  for (const script of WINDOWS_PTY_SCRIPTS) {
    const file = path.join(ptyRoot, 'lib', script);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// node-pty runtime fixture');
  }
  for (const platform of afterPack.SHERPA_PLATFORMS) {
    writeJson(path.join(resources, 'app.asar.unpacked', 'node_modules', `sherpa-onnx-${platform}`, 'package.json'),
      { name: `sherpa-onnx-${platform}`, version: lockVersion('sherpa-onnx-node') });
  }
  const piModules = path.join(resources, 'pi', 'node_modules');
  writeJson(path.join(piModules, afterPack.PI_PACKAGE, 'package.json'),
    { name: afterPack.PI_PACKAGE, version: pkg.dependencies[afterPack.PI_PACKAGE].replace(/^[\^~]/, '') });
  writeJson(path.join(piModules, afterPack.PI_PACKAGE, 'node_modules', 'ws', 'package.json'), { name: 'ws', version: lockVersion('ws') });
  // @electron/asar caches each archive's header by path, so a rebuilt archive must be dropped from it.
  const repack = async () => {
    const archive = path.join(resources, 'app.asar');
    await createPackageWithOptions(source, archive, { unpack: '**/node-pty/**' });
    uncache(archive);
  };
  const electronVersion = require('electron/package.json').version;
  const check = (overrides = {}) => afterPack.assertPackagedVersions({
    resources, sourceRoot: path.resolve(__dirname, '../..'), electronVersion, ...overrides });
  return { dir, source, resources, piModules, repack, check, electronVersion };
}

test('release hook accepts a runtime-only archive and rejects leaked test files', async t => {
  const f = packagedFixture(t);
  await f.repack();
  await afterPack({ appOutDir: f.dir, electronPlatformName: 'linux',
    packager: { info: { framework: { version: f.electronVersion } } } });
  fs.mkdirSync(path.join(f.source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(f.source, 'src', 'leak.test.js'), '');
  const badResources = path.join(f.dir, 'Bad.app', 'Contents', 'Resources');
  fs.mkdirSync(badResources, { recursive: true });
  await createPackage(f.source, path.join(badResources, 'app.asar'));
  await assert.rejects(afterPack({ appOutDir: f.dir, electronPlatformName: 'darwin',
    packager: { appInfo: { productFilename: 'Bad' } } }), /leak\.test\.js/);
});

test('Windows release hook requires a shipped Node executable larger than 1 MiB and its license', async t => {
  const f = packagedFixture(t);
  await f.repack();
  const context = { appOutDir: f.dir, electronPlatformName: 'win32', arch: 'x64',
    packager: { info: { framework: { version: f.electronVersion } } } };
  const runtime = path.join(f.piModules, 'tipatask-node');
  const node = path.join(runtime, 'node.exe');
  const license = path.join(runtime, 'LICENSE');
  const rejects = async (file, pattern) => assert.rejects(afterPack(context), error => {
    assert.match(error.message, /Windows Pi runtime is incomplete/);
    assert.ok(error.message.includes(file));
    assert.match(error.message, pattern);
    assert.match(error.message, /stage-pi-bundle\.js/);
    assert.match(error.message, /build\.extraResources/);
    return true;
  });
  await rejects(node, /ENOENT/);
  fs.mkdirSync(runtime);
  fs.writeFileSync(node, Buffer.alloc(1024 * 1024 + 1));
  fs.writeFileSync(license, 'Node.js license');
  await afterPack(context);

  fs.rmSync(node);
  await rejects(node, /ENOENT/);
  fs.mkdirSync(node);
  await rejects(node, /not a regular file/);
  fs.rmdirSync(node);
  for (const size of [0, 1024, 1024 * 1024]) {
    fs.writeFileSync(node, Buffer.alloc(size));
    await rejects(node, /must be larger than 1 MiB/);
  }
  fs.writeFileSync(node, Buffer.alloc(1024 * 1024 + 1));
  fs.rmSync(license);
  await rejects(license, /ENOENT/);
  fs.mkdirSync(license);
  await rejects(license, /not a regular file/);
  fs.rmdirSync(license);
  fs.writeFileSync(license, 'Node.js license');
  await afterPack(context);
});

test('Windows release hook rejects missing ConPTY and a substituted host module in actual output', async t => {
  const f = packagedFixture(t);
  await f.repack();
  const runtime = path.join(f.piModules, 'tipatask-node');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'node.exe'), Buffer.alloc(1024 * 1024 + 1));
  fs.writeFileSync(path.join(runtime, 'LICENSE'), 'Node.js license');
  const context = { appOutDir: f.dir, electronPlatformName: 'win32', arch: 'x64', packager: {} };
  const native = path.join(f.resources, 'app.asar.unpacked/node_modules/node-pty/build/Release/conpty.node');
  fs.writeFileSync(native, Buffer.from('cffaedfe', 'hex'));
  await assert.rejects(afterPack(context), /conpty\.node: expected PE32\+ x64/);
  fs.unlinkSync(native);
  await assert.rejects(afterPack(context), /conpty\.node: ENOENT/);
});

test('packaged require guard checks archive entry points and all main modules recursively', async t => {
  const f = packagedFixture(t);
  fs.mkdirSync(path.join(f.source, 'main', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(f.source, 'lib'));
  fs.writeFileSync(path.join(f.source, 'main.js'), "require('./lib');");
  fs.writeFileSync(path.join(f.source, 'lib', 'index.js'), "require('../main.js'); require('../package.json');");
  fs.writeFileSync(path.join(f.source, 'main', 'nested', 'entry.js'), "require('../../lib');");
  await f.repack();
  afterPack.assertPackagedRequires(path.join(f.resources, 'app.asar'));

  // This source exists in the checkout but must never satisfy an archive import.
  fs.writeFileSync(path.join(f.source, 'main.js'), "require('./src/server/app-version');");
  fs.mkdirSync(path.join(f.source, 'empty'));
  fs.writeFileSync(path.join(f.source, 'main', 'nested', 'entry.js'), "require('../../missing'); require('../../empty');");
  fs.unlinkSync(path.join(f.source, 'preload.js'));
  await f.repack();
  assert.throws(() => afterPack.assertPackagedRequires(path.join(f.resources, 'app.asar')), error => {
    assert.match(error.message, /main\.js: \.\/src\/server\/app-version/);
    assert.match(error.message, /main\/nested\/entry\.js: \.\.\/\.\.\/missing/);
    assert.match(error.message, /main\/nested\/entry\.js: \.\.\/\.\.\/empty/);
    assert.match(error.message, /preload\.js: preload\.js/);
    return true;
  });
  await assert.rejects(afterPack({ appOutDir: f.dir, electronPlatformName: 'linux', packager: {} }),
    /Unresolved packaged requires/);
});

test('packaged require guard checks every script the settings template hooks run', async t => {
  const f = packagedFixture(t);
  const archive = path.join(f.resources, 'app.asar');
  fs.mkdirSync(path.join(f.source, 'lib'));
  fs.writeFileSync(path.join(f.source, 'lib', 'index.js'), '');
  fs.writeFileSync(path.join(f.source, 'scripts', 'track-file-access.js'), "require('../lib');");
  await f.repack();
  afterPack.assertPackagedRequires(archive);

  // A hook script missing from the archive, or one of its own requires, fails packaging.
  fs.unlinkSync(path.join(f.source, 'scripts', 'push-kb-on-write.js'));
  fs.writeFileSync(path.join(f.source, 'scripts', 'tool-result-cache.js'), "require('../src/mcp/missing-budget');");
  await f.repack();
  assert.throws(() => afterPack.assertPackagedRequires(archive), error => {
    assert.match(error.message, /templates\/\.claude\/settings\.json: scripts\/push-kb-on-write\.js/);
    assert.match(error.message, /scripts\/tool-result-cache\.js: \.\.\/src\/mcp\/missing-budget/);
    return true;
  });

  // So does an archive without the template, or with one that is not JSON.
  fs.rmSync(path.join(f.source, 'templates'), { recursive: true });
  await f.repack();
  assert.throws(() => afterPack.assertPackagedRequires(archive),
    /templates\/\.claude\/settings\.json: templates\/\.claude\/settings\.json/);
  fs.mkdirSync(path.join(f.source, path.dirname(afterPack.HARNESS_SETTINGS)), { recursive: true });
  fs.writeFileSync(path.join(f.source, afterPack.HARNESS_SETTINGS), '{ broken');
  await f.repack();
  assert.throws(() => afterPack.assertPackagedRequires(archive), /Unreadable templates\/\.claude\/settings\.json/);
});

test('packaged versions pass when consistent and each mismatch is reported by name', async t => {
  const f = packagedFixture(t);
  await f.repack();
  f.check();

  const rejects = (fn, pattern) => assert.throws(fn, err => pattern.test(err.message));

  writeJson(path.join(f.source, 'node_modules', 'zod', 'package.json'), { name: 'zod', version: '0.0.1' });
  await f.repack();
  rejects(() => f.check(), /dependency zod: found 0\.0\.1, expected /);
  writeJson(path.join(f.source, 'node_modules', 'zod', 'package.json'), { name: 'zod', version: lockVersion('zod') });

  const asarPkg = JSON.parse(fs.readFileSync(path.join(f.source, 'package.json'), 'utf8'));
  writeJson(path.join(f.source, 'package.json'), { ...asarPkg, version: '9.9.9' });
  await f.repack();
  rejects(() => f.check(), /app\.asar package\.json version: found 9\.9\.9/);
  writeJson(path.join(f.source, 'package.json'), asarPkg);
  await f.repack();
  f.check();

  const sherpa = platform => path.join(f.resources, 'app.asar.unpacked', 'node_modules', `sherpa-onnx-${platform}`);
  writeJson(path.join(sherpa('win-x64'), 'package.json'), { version: '0.0.1' });
  rejects(() => f.check(), /sherpa-onnx-win-x64: found 0\.0\.1, expected /);
  fs.rmSync(sherpa('linux-arm64'), { recursive: true });
  rejects(() => f.check(), /sherpa-onnx-linux-arm64: found nothing, expected /);

  const piPkg = path.join(f.piModules, afterPack.PI_PACKAGE, 'package.json');
  writeJson(piPkg, { version: '9.9.9' });
  rejects(() => f.check(), /Pi bundle @earendil-works\/pi-coding-agent: found 9\.9\.9, expected /);
  writeJson(path.join(f.piModules, afterPack.PI_PACKAGE, 'node_modules', 'ws', 'package.json'), { version: '0.0.1' });
  rejects(() => f.check(), /Pi bundle ws: found 0\.0\.1, expected /);

  rejects(() => f.check({ electronVersion: '1.0.0' }), /Electron runtime: found 1\.0\.0, expected /);
});

test('coverage includes never-imported source and fails on assertions or each coverage floor', t => {
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, 'src'));
  const config = { ...pkg.c8, reporter: ['json-summary'], lines: 0, branches: 0, functions: 0 };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ c8: config }));
  fs.writeFileSync(path.join(dir, 'src', 'used.js'), 'module.exports = value => value ? 1 : 0;\n');
  fs.writeFileSync(path.join(dir, 'src', 'unused.js'), 'module.exports = () => 42;\n');
  const testFile = path.join(dir, 'src', 'used.test.js');
  fs.writeFileSync(testFile, "const assert = require('node:assert/strict'); assert.equal(require('./used')(true), 1);\n");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // Child must run its tests, not inherit the worker IPC context.
  // Node implicitly forwards the parent's coverage path if the key is absent.
  // An explicit empty value prevents nested c8 from cleaning the outer report.
  env.NODE_V8_COVERAGE = '';
  const outerSentinel = process.env.NODE_V8_COVERAGE && path.join(process.env.NODE_V8_COVERAGE, `gate-${process.pid}.sentinel`);
  if (outerSentinel) {
    fs.writeFileSync(outerSentinel, 'preserve outer coverage');
    t.after(() => fs.rmSync(outerSentinel, { force: true }));
  }
  const run = extra => spawnSync(process.execPath, [require.resolve('c8/bin/c8.js'),
    '--temp-directory', path.join(dir, 'coverage', 'tmp'), ...extra,
    process.execPath, '--test', testFile], { cwd: dir, env, encoding: 'utf8', timeout: 20000 });
  const pass = run([]);
  assert.equal(pass.status, 0, pass.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'coverage', 'coverage-summary.json'), 'utf8'));
  const unused = Object.entries(report).find(([file]) => file.endsWith('/src/unused.js'))?.[1];
  assert.ok(unused, 'never-imported production source must remain in denominator');
  assert.equal(unused.lines.covered, 0);
  for (const metric of ['lines', 'branches', 'functions']) {
    const fail = run([`--${metric}=100`]);
    assert.equal(fail.error, undefined);
    assert.equal(fail.status, 1, `${metric}: ${fail.stdout}\n${fail.stderr}`);
    assert.match(fail.stderr, new RegExp(`Coverage for ${metric}`));
  }
  fs.writeFileSync(testFile, "require('node:assert/strict').fail('intentional assertion failure');\n");
  const failedTest = run([]);
  assert.equal(failedTest.status, 1, failedTest.stderr);
  assert.match(failedTest.stdout, /intentional assertion failure/);
  if (outerSentinel) assert.ok(fs.existsSync(outerSentinel), 'nested coverage must preserve outer coverage');
});

test('test guard records swallowed outbound calls and real PTY attempts', t => {
  const dir = scratch(t);
  const log = path.join(dir, 'violations.log');
  const code = `
    try { fetch('https://example.invalid/'); } catch {}
    try { require('node:net').connect({ host: '203.0.113.1', port: 443 }); } catch {}
    try { require('node-pty').spawn('sh', []); } catch {}
  `;
  const result = spawnSync(process.execPath, ['--require', path.resolve(__dirname, '../../scripts/test-guard.cjs'), '-e', code], {
    cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, TIPATASK_TEST_VIOLATIONS: log },
  });
  assert.equal(result.status, 0, result.stderr);
  const violations = fs.readFileSync(log, 'utf8');
  assert.match(violations, /external fetch to example\.invalid/);
  assert.match(violations, /external network access to 203\.0\.113\.1/);
  assert.match(violations, /a real PTY spawn/);
});
