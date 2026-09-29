'use strict';
// Stage every target sherpa native package for electron-builder's asarUnpack.
// npm normally installs only the host optional dependency. Fetch foreign os/cpu
// packages in isolated scratch directories, then copy just those packages into
// node_modules: `npm install --force --os/--cpu` in this project would re-resolve
// unrelated optional binaries, including esbuild, for the foreign platform.
// Matching pinned versions are reused; a failed foreign fetch warns and continues.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER_ROOT = path.join(__dirname, '..');
const PKG_JSON = path.join(SERVER_ROOT, 'package.json');

// os/cpu tags npm's --os/--cpu overrides understand, keyed to sherpa-onnx-node's own
// optionalDependencies names (see its package.json) — keep in sync with that list.
const PLATFORM_PACKAGES = [
  { name: 'sherpa-onnx-darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { name: 'sherpa-onnx-darwin-x64', os: 'darwin', cpu: 'x64' },
  { name: 'sherpa-onnx-linux-x64', os: 'linux', cpu: 'x64' },
  { name: 'sherpa-onnx-linux-arm64', os: 'linux', cpu: 'arm64' },
  { name: 'sherpa-onnx-win-x64', os: 'win32', cpu: 'x64' },
  { name: 'sherpa-onnx-win-ia32', os: 'win32', cpu: 'ia32' },
];

function pinnedVersion() {
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
  const spec = pkg.dependencies && pkg.dependencies['sherpa-onnx-node'];
  if (!spec) {
    console.error('[stage-sherpa-bundle] package.json has no sherpa-onnx-node dependency');
    process.exit(1);
  }
  return spec.replace(/^[\^~]/, '');
}

function installedVersion(pkgName) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'node_modules', pkgName, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

const wanted = pinnedVersion();
let failures = 0;
for (const { name, os: targetOs, cpu } of PLATFORM_PACKAGES) {
  if (installedVersion(name) === wanted) {
    console.log(`[stage-sherpa-bundle] ${name}@${wanted} already installed — skipping`);
    continue;
  }
  console.log(`[stage-sherpa-bundle] installing ${name}@${wanted} (os=${targetOs} cpu=${cpu}) ...`);

  // Isolated scratch dir: a fresh, empty package.json with no other dependency in scope, so
  // npm's --force whole-tree re-resolution below has nothing else to corrupt. Never touches
  // SERVER_ROOT's own package.json/node_modules.
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), `tipatask-sherpa-${name}-`));
  try {
    fs.writeFileSync(
      path.join(scratchDir, 'package.json'),
      JSON.stringify({ name: 'tipatask-sherpa-stage', version: '0.0.0', private: true }, null, 2)
    );

    // --os/--cpu alone do NOT suppress npm 10's EBADPLATFORM check for a package whose own
    // package.json declares os/cpu (verified empirically installing a foreign-arch sherpa
    // package on this machine) — only --force does. Safe here specifically because this scratch
    // dir has nothing else in it for --force to touch.
    const result = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', `${name}@${wanted}`, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--force', `--os=${targetOs}`, `--cpu=${cpu}`],
      // shell:true on Windows: Node >=20.12 refuses to spawn a .cmd shim without it (EINVAL).
      { cwd: scratchDir, stdio: 'inherit', shell: process.platform === 'win32' }
    );
    if (result.status !== 0) {
      console.warn(`[stage-sherpa-bundle] failed to install ${name}@${wanted} — local streaming transcription will be unavailable in builds for that platform`);
      failures += 1;
      continue;
    }

    const fetched = path.join(scratchDir, 'node_modules', name);
    if (!fs.existsSync(fetched)) {
      console.warn(`[stage-sherpa-bundle] npm reported success but ${name} is missing from the scratch install — skipping`);
      failures += 1;
      continue;
    }

    const dest = path.join(SERVER_ROOT, 'node_modules', name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(fetched, dest, { recursive: true });
    console.log(`[stage-sherpa-bundle] ${name}@${wanted} staged into node_modules/`);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}
if (failures) {
  console.warn(`[stage-sherpa-bundle] ${failures} platform package(s) failed to install — see warnings above`);
}
