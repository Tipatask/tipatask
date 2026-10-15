'use strict';

const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { listPackage, extractFile, statFile } = require('@electron/asar');
const { collectRelativeRequires } = require('../src/server/require-graph');

// @electron/asar splits the requested path on path.sep, so a forward-slash path is "not found"
// on Windows for anything below the archive root. Normalize before every lookup.
function extractPackaged(archive, file) {
  return extractFile(archive, path.normalize(file));
}

// All build paths use afterPack. A stale staging directory must not silently ship an
// old directive while package.json advertises a newer version.
function assertPackagedVcs(archive, sourceRoot) {
  const files = ['package.json', 'src/server/vcs-settings.js', 'src/server/vcs-context.js',
    'src/server/vcs-runtime.js', 'src/server/task-agent/base-agent.js',
    'src/server/task-agent/codex-agent.js', 'src/server/terminal-session.js',
    'src/server/ws-handlers.js', 'src/server/index.js', 'src/server/api-backend.js',
    'src/server/git-merge/completion-guard.js', 'src/mcp/server.js'];
  for (const file of files) {
    const packaged = extractPackaged(archive, file);
    const source = fs.readFileSync(path.join(sourceRoot, file));
    if (file === 'package.json') {
      if (JSON.parse(packaged).version !== JSON.parse(source).version) throw new Error('Packaged VCS version mismatch');
    } else if (!packaged.equals(source)) throw new Error(`Packaged VCS source mismatch: ${file}`);
  }
  const context = { module: { exports: {} } };
  vm.runInNewContext(extractPackaged(archive, 'src/server/vcs-settings.js').toString(), context);
  const { buildVcsDirective } = context.module.exports;
  const all = { type: 'git', worktree: true, commit: true, pr: true, merge: true };
  for (const compact of [false, true]) {
    const prompt = buildVcsDirective(all, { compact });
    if (!prompt.includes('git merge task/') || !/nested/i.test(prompt) || !/PR.*(?:merge|separate)/.test(prompt)) throw new Error('Packaged merge directive missing');
    if (buildVcsDirective({ ...all, merge: false }, { compact }).includes('git merge task/')) throw new Error('Packaged merge-off violation');
    if (buildVcsDirective({ ...all, commit: false }, { compact }).includes('`git merge task/')) throw new Error('Packaged commit-off violation');
  }
}

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
// Keep in sync with PLATFORM_PACKAGES in scripts/stage-sherpa-bundle.js and the asarUnpack list in
// package.json: every installer ships all six platform prebuilds.
const SHERPA_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win-ia32', 'win-x64'];

// package.json of a packaged module. asarUnpack'ed packages (sherpa, node-pty natives) live in
// app.asar.unpacked, so fall back to the plain directory when the archive read fails.
function packagedPackageJson(resources, name) {
  const rel = `node_modules/${name}/package.json`;
  try {
    return JSON.parse(extractPackaged(path.join(resources, 'app.asar'), rel).toString('utf8'));
  } catch {
    const unpacked = path.join(resources, 'app.asar.unpacked', rel);
    if (!fs.existsSync(unpacked)) return null;
    return JSON.parse(fs.readFileSync(unpacked, 'utf8'));
  }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// Fails the packaging step, before signing and installer creation, when what is inside the package
// is not what package.json / package-lock.json say it should be. All mismatches are reported at once.
function assertPackagedVersions({ resources, sourceRoot, electronVersion }) {
  const pkg = readJsonFile(path.join(sourceRoot, 'package.json'));
  const lock = readJsonFile(path.join(sourceRoot, 'package-lock.json'));
  if (!pkg || !lock) throw new Error(`Packaged versions: cannot read package.json / package-lock.json in ${sourceRoot}`);
  const problems = [];
  const expect = (what, actual, wanted) => {
    if (actual !== wanted) problems.push(`${what}: found ${actual ?? 'nothing'}, expected ${wanted}`);
  };
  const lockVersion = name => lock.packages?.[`node_modules/${name}`]?.version;

  expect('package-lock.json version', lock.version, pkg.version);
  expect('package-lock.json root package version', lock.packages?.[''].version, pkg.version);
  expect('app.asar package.json version',
    JSON.parse(extractPackaged(path.join(resources, 'app.asar'), 'package.json').toString('utf8')).version, pkg.version);

  // Everything electron-builder copies from node_modules must be the locked version; a stale
  // node_modules would otherwise ship silently. Pi is excluded from the asar on purpose and
  // shipped in resources/pi instead (checked below).
  for (const name of Object.keys(pkg.dependencies || {})) {
    if (name === PI_PACKAGE) continue;
    const wanted = lockVersion(name);
    if (!wanted) { problems.push(`${name}: not resolved in package-lock.json`); continue; }
    expect(`dependency ${name}`, packagedPackageJson(resources, name)?.version, wanted);
  }

  const sherpaWanted = lockVersion('sherpa-onnx-node');
  for (const platform of SHERPA_PLATFORMS) {
    expect(`sherpa-onnx-${platform}`, packagedPackageJson(resources, `sherpa-onnx-${platform}`)?.version, sherpaWanted);
  }

  const piDir = path.join(resources, 'pi', 'node_modules');
  expect(`Pi bundle ${PI_PACKAGE}`, readJsonFile(path.join(piDir, PI_PACKAGE, 'package.json'))?.version,
    String(pkg.dependencies?.[PI_PACKAGE]).replace(/^[\^~]/, ''));
  // stage-pi-bundle.js copies the audited root ws over Pi's own nested copy (PI_WS_REL there).
  expect('Pi bundle ws', readJsonFile(path.join(piDir, PI_PACKAGE, 'node_modules', 'ws', 'package.json'))?.version,
    lockVersion('ws'));

  if (electronVersion) {
    expect('Electron runtime', electronVersion,
      readJsonFile(path.join(sourceRoot, 'node_modules', 'electron', 'package.json'))?.version);
  }

  if (problems.length) throw new Error(`Packaged versions do not match the lockfile:\n  ${problems.join('\n  ')}`);
}

// The Claude Code settings template installed into every project. Its Node-script hook commands
// run their scripts from this archive through the Electron runtime in packaged builds.
const HARNESS_SETTINGS = 'templates/.claude/settings.json';

// `scripts/<name>.js` paths the hook commands of a Claude settings file run, unique and sorted.
function hookScriptsFromSettings(text) {
  const scripts = new Set();
  for (const groups of Object.values(JSON.parse(text).hooks || {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of group.hooks || []) {
        for (const [, name] of String(hook.command || '').matchAll(/\/scripts\/([\w.-]+\.js)\b/g)) {
          scripts.add(`scripts/${name}`);
        }
      }
    }
  }
  return [...scripts].sort();
}

function assertPackagedRequires(archive) {
  const files = new Set(listPackage(archive)
    .map(file => file.replace(/\\/g, '/').replace(/^\//, '')));
  const readFile = file => {
    // listPackage includes directories, including empty ones. Never let a
    // directory or checkout file satisfy an absent archive dependency.
    if (!files.has(file) || 'files' in statFile(archive, path.normalize(file))) return null;
    return extractPackaged(archive, file);
  };
  // Every script a hook command names must ship (package.json build.files) with all it requires.
  const missing = [];
  const settings = readFile(HARNESS_SETTINGS);
  let hookScripts = [];
  if (settings === null) missing.push({ from: HARNESS_SETTINGS, spec: HARNESS_SETTINGS });
  else {
    try { hookScripts = hookScriptsFromSettings(settings.toString('utf8')); }
    catch (error) { throw new Error(`Unreadable ${HARNESS_SETTINGS} in ${archive}: ${error.message}`); }
  }
  for (const script of hookScripts) {
    if (!files.has(script)) missing.push({ from: HARNESS_SETTINGS, spec: script });
  }
  const entries = ['main.js', 'preload.js', 'todo-server.js',
    ...[...files].filter(file => /^main\/.*\.js$/.test(file) && !file.endsWith('.test.js')).sort(),
    ...hookScripts.filter(script => files.has(script))];
  missing.push(...collectRelativeRequires(entries, { readFile }).missing);
  if (missing.length) {
    throw new Error(`Unresolved packaged requires in ${archive}:\n${missing.map(({ from, spec }) => `${from}: ${spec}`).join('\n')}`);
  }
}

function assertNoPackagedTests(archive) {
  const forbidden = listPackage(archive).filter(entry => {
    const file = entry.replace(/\\/g, '/').replace(/^\//, '');
    return /^(?:src|main)\/.*\.test\.(?:js|cjs|mjs)$/.test(file)
      || /^src\/client\/.*-dom-runner\.mjs$/.test(file)
      || file === 'src/server/git-merge/test-fixture.js'
      || file.startsWith('coverage/');
  });
  if (forbidden.length) {
    throw new Error(`Test-only files found in ${archive}:\n${forbidden.join('\n')}`);
  }
}

// afterPack runs before signing and installer creation on every packaging path.
module.exports = async function afterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const projectDir = context.packager?.projectDir || path.resolve(__dirname, '..');
  assertNoPackagedTests(path.join(resources, 'app.asar'));
  assertPackagedRequires(path.join(resources, 'app.asar'));
  assertPackagedVcs(path.join(resources, 'app.asar'), projectDir);
  assertPackagedVersions({
    resources,
    sourceRoot: projectDir,
    electronVersion: context.packager?.info?.framework?.version,
  });
};
module.exports.assertNoPackagedTests = assertNoPackagedTests;
module.exports.assertPackagedRequires = assertPackagedRequires;
module.exports.hookScriptsFromSettings = hookScriptsFromSettings;
module.exports.HARNESS_SETTINGS = HARNESS_SETTINGS;
module.exports.assertPackagedVcs = assertPackagedVcs;
module.exports.assertPackagedVersions = assertPackagedVersions;
module.exports.PI_PACKAGE = PI_PACKAGE;
module.exports.SHERPA_PLATFORMS = SHERPA_PLATFORMS;
