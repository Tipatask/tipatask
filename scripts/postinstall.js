'use strict';

// Cross-platform postinstall. Rebuild and chmod node-pty, rename development
// Electron, then check esbuild platform. Earlier steps are best-effort; the
// final platform check determines exit status, matching the old script.

var path = require('path');
var fs = require('fs');
var spawnSync = require('child_process').spawnSync;

var ROOT = path.join(__dirname, '..');
var isWin = process.platform === 'win32';

function runNodeScript(scriptName) {
  return spawnSync(process.execPath, [path.join(__dirname, scriptName)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

// 1. Rebuild node-pty against the bundled Electron's ABI.
try {
  var bin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'electron-rebuild.cmd' : 'electron-rebuild');
  var rebuild = spawnSync(bin, ['-f', '-w', 'node-pty'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin, // Node >=20.12 refuses to spawn a .cmd/.bat shim without shell:true
  });
  if (rebuild.error || rebuild.status !== 0) {
    console.warn('[postinstall] electron-rebuild skipped/failed (expected when no Electron binary was downloaded, e.g. ELECTRON_SKIP_BINARY_DOWNLOAD=1)');
  }
} catch (err) {
  console.warn('[postinstall] electron-rebuild threw: ' + err.message);
}

// 2. chmod +x every spawn-helper under node-pty. POSIX only.
if (!isWin) {
  (function chmodSpawnHelpers(dir) {
    var entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return; // dir may not exist (rebuild failed/skipped) -- not fatal
    }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        chmodSpawnHelpers(full);
      } else if (entry.name === 'spawn-helper') {
        try { fs.chmodSync(full, 0o755); } catch (err) { /* best-effort */ }
      }
    }
  })(path.join(ROOT, 'node_modules', 'node-pty'));
}

// 3. Patch dev Electron's Info.plist / icon (macOS-only convenience; self-exits elsewhere).
try {
  runNodeScript('rename-dev-electron.js');
} catch (err) {
  console.warn('[postinstall] rename-dev-electron.js threw: ' + err.message);
}

// 4. Wrong-platform esbuild guard -- its exit code decides the install's exit code.
var check = runNodeScript('check-esbuild-platform.js');
process.exit(check.status === null || check.status === undefined ? 1 : check.status);
