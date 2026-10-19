'use strict';
// Stage Pi's complete dependency tree outside app.asar for extraResources.
// Reuse only a tree matching the committed lockfile and platform fingerprint.
// Always refresh the Pi LICENSE and generated THIRD-PARTY-NOTICES.md, even when
// dependency installation is skipped. Pi's LICENSE must carry its real author
// notice; the generic MIT template is not sufficient attribution.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SERVER_ROOT = path.join(__dirname, '..');
const STAMP_NAME = '.tipatask-pi-stage.json';
// Pi's shrinkwrap pins its nested ws; stagePatchedWs() replaces it with the audited root copy.
const PI_WS_REL = 'node_modules/@earendil-works/pi-coding-agent/node_modules/ws';
const ROOT_WS_DIR = path.join(SERVER_ROOT, 'node_modules', 'ws');
const PI_WS_DIR = path.join(SERVER_ROOT, 'vendor', 'pi', PI_WS_REL);

// (TPT49) Pi's real, filled MIT notice — see comment above. Kept in sync by hand with
// the hand-written Pi Coding Agent section of THIRD-PARTY-NOTICES.md (both are static
// historical fact about Pi's actual copyright holder, not something that changes across
// ordinary Pi version bumps).
const PI_LICENSE_TEXT = `MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`;

function readExpectedState(vendorDir, platform, arch) {
  const manifestBytes = fs.readFileSync(path.join(vendorDir, 'package.json'));
  const lockBytes = fs.readFileSync(path.join(vendorDir, 'package-lock.json'));
  const manifest = JSON.parse(manifestBytes);
  const lock = JSON.parse(lockBytes);
  const wanted = manifest.dependencies && manifest.dependencies['@earendil-works/pi-coding-agent'];
  const root = lock.packages && lock.packages[''];
  const pi = lock.packages && lock.packages['node_modules/@earendil-works/pi-coding-agent'];
  if (!wanted || !root || !pi || root.dependencies?.['@earendil-works/pi-coding-agent'] !== wanted || pi.version !== wanted) {
    throw new Error('vendor/pi/package.json and package-lock.json must pin the same Pi version');
  }
  const fingerprint = crypto.createHash('sha256')
    .update(manifestBytes).update(lockBytes).update(JSON.stringify({ platform, arch })).digest('hex');
  return { wanted, lock, fingerprint };
}

function supportsPlatform(pkg, platform, arch) {
  function matches(values, value) {
    if (!values || !values.length) return true;
    if (values.includes(`!${value}`)) return false;
    const allowed = values.filter((item) => !item.startsWith('!'));
    return allowed.length === 0 || allowed.includes(value);
  }
  return matches(pkg.os, platform) && matches(pkg.cpu, arch);
}

// `accepted` maps a lockfile path to an extra version that counts as current: the patched
// ws copy stagePatchedWs() puts over Pi's shrinkwrapped one must not force a reinstall.
function validateTree(vendorDir, lock, platform, arch, accepted = {}) {
  for (const [relative, expected] of Object.entries(lock.packages)) {
    if (!relative || expected.dev) continue; // npm ci --omit=dev does not stage dev-only entries
    const manifestPath = path.join(vendorDir, relative, 'package.json');
    const exists = fs.existsSync(manifestPath);
    let installed;
    try { installed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch { installed = null; }
    if (!supportsPlatform(expected, platform, arch) && expected.optional) {
      if (exists) return `${relative} belongs to another platform`;
      continue;
    }
    if (!installed) return `${relative} is missing`;
    if (installed.version !== expected.version && installed.version !== accepted[relative]) {
      return `${relative} has ${installed.version}, lockfile requires ${expected.version}`;
    }
  }
  const cli = path.join(vendorDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
  if (!fs.existsSync(cli)) return 'Pi CLI entry point is missing';
  return null;
}

// npm installs every optional binary listed in Pi's shrinkwrap (e.g. all ten
// @mariozechner/clipboard-<os>-<arch> packages), not just the host's. Delete the installed
// optional lock entries that fail supportsPlatform() so validateTree() only ever sees a
// host-shaped tree and the foreign binaries never reach the packaged app. Non-optional
// foreign entries are left alone: validateTree() still treats those as a real error.
function pruneForeignOptional(vendorDir, lock, platform, arch, log = console) {
  const removed = [];
  for (const [relative, expected] of Object.entries(lock.packages)) {
    if (!relative || !expected.optional || supportsPlatform(expected, platform, arch)) continue;
    const dir = path.join(vendorDir, relative);
    if (!fs.existsSync(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(relative);
  }
  if (removed.length) log.log(`[stage-pi-bundle] pruned ${removed.length} foreign-platform optional package(s) for ${platform}/${arch}`);
  return removed;
}

function ensurePiInstalled({ serverRoot = SERVER_ROOT, platform = process.platform, arch = process.arch,
  hostPlatform = process.platform, spawn = spawnSync, log = console } = {}) {
  const vendorDir = path.join(serverRoot, 'vendor', 'pi');
  const modulesDir = path.join(vendorDir, 'node_modules');
  const stampPath = path.join(modulesDir, STAMP_NAME);
  const { wanted, lock, fingerprint } = readExpectedState(vendorDir, platform, arch);
  let stamp;
  try { stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')); }
  catch { stamp = null; }
  const accepted = {};
  try {
    accepted[PI_WS_REL] = JSON.parse(fs.readFileSync(path.join(serverRoot, 'node_modules', 'ws', 'package.json'), 'utf8')).version;
  } catch { /* no root ws: only the lockfile version counts */ }
  // Prune first so a stray foreign binary on an otherwise current tree is not read as stale.
  pruneForeignOptional(vendorDir, lock, platform, arch, log);
  const invalid = validateTree(vendorDir, lock, platform, arch, accepted);
  if (stamp?.fingerprint === fingerprint && !invalid) {
    log.log(`[stage-pi-bundle] vendor/pi matches lockfile on ${platform}/${arch} — skipping install`);
    return false;
  }

  log.log(`[stage-pi-bundle] staging @earendil-works/pi-coding-agent@${wanted} into vendor/pi/node_modules${invalid ? ` (${invalid})` : ''} ...`);
  fs.rmSync(stampPath, { force: true });
  // --ignore-scripts: pi has no install scripts of its own, and this tree is never rebuilt
  // against Electron's ABI (it ships plain JS/ESM, not native modules) — unlike the top-level
  // `npm install` in this package, whose postinstall (electron-rebuild for node-pty) IS wanted.
  const result = spawn(
    hostPlatform === 'win32' ? 'npm.cmd' : 'npm',
    // shell:true on Windows is required (Node >=20.12 refuses to spawn a .cmd shim without it,
    // spawnSync EINVAL), and it joins args unquoted, so quote the path that may hold spaces.
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${platform}`, `--cpu=${arch}`,
      '--prefix', hostPlatform === 'win32' ? `"${vendorDir}"` : vendorDir],
    { stdio: 'inherit', cwd: serverRoot, shell: hostPlatform === 'win32' }
  );
  if (result.error || result.status !== 0) throw new Error(`npm ci failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
  pruneForeignOptional(vendorDir, lock, platform, arch, log);
  const after = validateTree(vendorDir, lock, platform, arch);
  if (after) throw new Error(`npm ci produced an incomplete Pi bundle: ${after}`);
  fs.writeFileSync(stampPath, JSON.stringify({ fingerprint }) + '\n');
  log.log(`[stage-pi-bundle] @earendil-works/pi-coding-agent@${wanted} staged`);
  return true;
}

// Pi's published npm-shrinkwrap pins its nested ws copy independently of our lockfile.
// npm overrides cannot replace a dependency inside that shrinkwrap, so stage the audited
// direct runtime copy into the external Pi bundle after Pi's own install has finished.
function stagePatchedWs(sourceDir = ROOT_WS_DIR, targetDir = PI_WS_DIR) {
  const sourceVersion = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8')).version;
  const parts = sourceVersion.split('.').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isInteger(n))
      || parts[0] !== 8 || parts[1] < 21 || (parts[1] === 21 && parts[2] < 3)) {
    throw new Error(`Cannot stage unpatched ws@${sourceVersion}; require ws >=8.21.3 <9`);
  }
  const stagedVersion = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8')).version; }
    catch { return null; }
  })();
  if (stagedVersion === sourceVersion) return;
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
  const copiedVersion = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8')).version;
  if (copiedVersion !== sourceVersion) throw new Error(`Staged ws version mismatch: ${copiedVersion}`);
  console.log(`[stage-pi-bundle] staged ws@${sourceVersion} into Pi bundle`);
}

// Windows builds run under the repository's pinned standalone Node. Ship that exact
// executable as Pi's fallback when Electron cannot honor ELECTRON_RUN_AS_NODE. Keep the
// distribution's full LICENSE beside it (including Node's bundled dependency notices).
// No runtime download or developer-machine PATH lookup happens in the installed app.
function stageWindowsNode({ serverRoot = SERVER_ROOT, platform = process.platform,
  execPath = process.execPath, version = process.version, electron = process.versions.electron,
  spawn = spawnSync, log = console } = {}) {
  if (platform !== 'win32') return;
  const pinned = fs.readFileSync(path.join(serverRoot, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
  if (electron || path.basename(execPath).toLowerCase() !== 'node.exe' || version.replace(/^v/, '') !== pinned) {
    throw new Error(`Windows Pi bundle must be staged with standalone Node ${pinned}`);
  }
  const license = ['LICENSE', 'LICENSE.txt'].map(name => path.join(path.dirname(execPath), name))
    .find(file => fs.existsSync(file) && fs.statSync(file).size > 0);
  if (!license) throw new Error('Node distribution LICENSE missing beside node.exe');
  const dest = path.join(serverRoot, 'vendor', 'pi', 'node_modules', 'tipatask-node');
  fs.mkdirSync(dest, { recursive: true });
  const stagedNode = path.join(dest, 'node.exe');
  fs.copyFileSync(execPath, stagedNode);
  fs.copyFileSync(license, path.join(dest, 'LICENSE'));
  const result = spawn(stagedNode, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const actual = result.stdout?.trim();
  if (result.error || result.status !== 0 || actual !== `v${pinned}`) {
    throw new Error(`Staged Windows Pi runtime ${stagedNode} failed verification: expected v${pinned}, `
      + `received ${actual || 'no version'} (${result.error?.message || result.signal || `exit ${result.status}`}). `
      + `Reinstall standalone Node ${pinned} and rerun scripts/stage-pi-bundle.js.`);
  }
  log.log(`[stage-pi-bundle] staged standalone Node ${pinned} and its LICENSE for Windows`);
}

// Cross-builds cannot execute a Windows binary. Use the official pinned distribution,
// validate its release checksum and PE architecture, then verify the copied bytes too.
async function downloadWindowsNode(pinned, arch) {
  const { downloadNodeJsBinary, fetchNodeJsChecksum } = require('app-builder-lib/out/frameworks/LibUiFramework');
  const { Platform } = require('app-builder-lib/out/core');
  const execPath = await downloadNodeJsBinary(pinned, Platform.WINDOWS, arch);
  const sha256 = await fetchNodeJsChecksum(pinned, `win-${arch === 'ia32' ? 'x86' : arch}/node.exe`);
  return { execPath, sha256 };
}

function assertWindowsNode(file, arch, sha256) {
  const machines = { ia32: 0x014c, x64: 0x8664, arm64: 0xaa64 };
  const bytes = fs.readFileSync(file);
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1;
  if (bytes.length <= 1024 * 1024 || bytes.toString('ascii', 0, 2) !== 'MZ'
      || pe < 0 || pe + 6 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0'
      || bytes.readUInt16LE(pe + 4) !== machines[arch]) {
    throw new Error(`Windows Pi runtime ${file} is not a valid ${arch} Node executable`);
  }
  if (!/^[a-f0-9]{64}$/.test(sha256 || '') || crypto.createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error(`Windows Pi runtime checksum mismatch: ${file}`);
  }
}

async function stageTargetWindowsNode({ serverRoot = SERVER_ROOT, platform = process.platform,
  arch = process.arch, hostPlatform = process.platform, hostArch = process.arch,
  download = downloadWindowsNode, log = console, ...options } = {}) {
  if (platform !== 'win32') return;
  if (!['ia32', 'x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Windows Pi runtime architecture: ${arch}`);
  if (hostPlatform === 'win32' && hostArch === arch) {
    stageWindowsNode({ ...options, serverRoot, platform, log });
    return;
  }
  const pinned = fs.readFileSync(path.join(serverRoot, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(pinned)) throw new Error('Windows Pi runtime requires an exact Node version in .nvmrc');
  const { execPath, sha256 } = await download(pinned, arch);
  assertWindowsNode(execPath, arch, sha256);
  const license = path.join(path.dirname(execPath), 'LICENSE');
  if (!fs.statSync(license).isFile() || fs.statSync(license).size === 0) {
    throw new Error(`Node distribution LICENSE missing or empty: ${license}`);
  }
  const dest = path.join(serverRoot, 'vendor', 'pi', 'node_modules', 'tipatask-node');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(execPath, path.join(dest, 'node.exe'));
  fs.copyFileSync(license, path.join(dest, 'LICENSE'));
  assertWindowsNode(path.join(dest, 'node.exe'), arch, sha256);
  log.log(`[stage-pi-bundle] staged checksum-verified standalone Node ${pinned} for win32/${arch} and its LICENSE`);
}

// (C1531) Runs unconditionally, even when ensurePiInstalled() found nothing to do — order
// matters: install first (so the freshly-installed tree exists to regenerate notices from),
// license/notice writes second (so npm can never prune them on a subsequent install).
function stageNotices({ serverRoot = SERVER_ROOT, spawn = spawnSync, log = console } = {}) {
  const vendorDir = path.join(serverRoot, 'vendor', 'pi');
  const licenseDest = path.join(vendorDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'LICENSE');
  const noticesSrc = path.join(serverRoot, 'THIRD-PARTY-NOTICES.md');
  const noticesDest = path.join(vendorDir, 'node_modules', 'THIRD-PARTY-NOTICES.md');
  fs.writeFileSync(licenseDest, PI_LICENSE_TEXT);
  log.log(`[stage-pi-bundle] wrote ${path.relative(serverRoot, licenseDest)} (npm's package "files" list omits it upstream)`);

  const genResult = spawn(
    process.execPath,
    [path.join(__dirname, 'gen-third-party-notices.js')],
    { stdio: 'inherit', cwd: serverRoot }
  );
  if (genResult.error || genResult.status !== 0) throw new Error('gen-third-party-notices.js failed');
  fs.copyFileSync(noticesSrc, noticesDest);
  if (fs.existsSync(path.join(vendorDir, 'node_modules', 'tipatask-node', 'node.exe'))) {
    fs.appendFileSync(noticesDest, '\n## Standalone Node.js runtime\n\nThe Windows Pi bundle includes Node.js. Its complete license and dependency notices are in `tipatask-node/LICENSE` beside `tipatask-node/node.exe`.\n');
  }
  log.log(`[stage-pi-bundle] wrote ${path.relative(serverRoot, noticesDest)}`);
}

function stagePiBundle(options = {}) {
  const serverRoot = options.serverRoot || SERVER_ROOT;
  ensurePiInstalled(options);
  // Only a Pi tree that actually ships its own nested ws needs the patched copy.
  const piWsDir = path.join(serverRoot, 'vendor', 'pi', PI_WS_REL);
  if (fs.existsSync(piWsDir)) stagePatchedWs(path.join(serverRoot, 'node_modules', 'ws'), piWsDir);
  stageWindowsNode(options);
  stageNotices(options);
}

// electron-builder supplies the target here; process.platform describes only the build host.
// Its default sequential packaging keeps the shared vendor tree scoped to the current target.
async function beforePack(context, options = {}) {
  const arch = typeof context.arch === 'string' ? context.arch : require('builder-util').Arch[context.arch];
  const serverRoot = context.packager.projectDir;
  const target = { ...options, serverRoot, platform: context.electronPlatformName, arch };
  ensurePiInstalled(target);
  const piWsDir = path.join(serverRoot, 'vendor', 'pi', PI_WS_REL);
  if (fs.existsSync(piWsDir)) stagePatchedWs(path.join(serverRoot, 'node_modules', 'ws'), piWsDir);
  if (target.platform === 'win32') await stageTargetWindowsNode(target);
  else fs.rmSync(path.join(serverRoot, 'vendor', 'pi', 'node_modules', 'tipatask-node'), { recursive: true, force: true });
  stageNotices(target);
}

if (require.main === module) {
  try {
    stagePiBundle();
    console.log('[stage-pi-bundle] done');
  } catch (error) {
    console.error(`[stage-pi-bundle] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { readExpectedState, validateTree, pruneForeignOptional, ensurePiInstalled, stagePatchedWs,
  stageWindowsNode, stageTargetWindowsNode, stageNotices, stagePiBundle, beforePack };
