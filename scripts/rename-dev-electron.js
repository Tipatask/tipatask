'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.platform !== 'darwin') process.exit(0);

const plistPath = path.join(
  __dirname, '..', 'node_modules', 'electron', 'dist',
  'Electron.app', 'Contents', 'Info.plist'
);

if (!fs.existsSync(plistPath)) {
  console.log('[rename-dev-electron] skip: no dev Electron.app found');
  process.exit(0);
}

let xml = fs.readFileSync(plistPath, 'utf8');

const patch = (key) => {
  xml = xml.replace(
    new RegExp(`(<key>${key}<\\/key>\\s*<string>)[^<]*(<\\/string>)`),
    '$1TipATask$2'
  );
};

patch('CFBundleName');
patch('CFBundleDisplayName');

fs.writeFileSync(plistPath, xml, 'utf8');

// Overwrite the dev bundle's icon with the Tipatask logo so macOS notifications
// show the correct icon on the left (the bundle icon, not contentImage).
const srcIcns = path.join(__dirname, '..', 'assets', 'icon.icns');
const destIcns = path.join(path.dirname(plistPath), 'Resources', 'electron.icns');
if (fs.existsSync(srcIcns)) {
  try {
    fs.copyFileSync(srcIcns, destIcns);
  } catch (e) {
    console.warn('[rename-dev-electron] icon copy failed:', e.message);
  }
}

// Touch the bundle dir to invalidate AppKit launch-services cache
const bundleDir = path.join(plistPath, '..', '..');
const now = new Date();
try { fs.utimesSync(bundleDir, now, now); } catch {}

// Force-flush Launch Services cache — utimesSync alone unreliable on macOS 14+
try {
  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister',
    ['-f', bundleDir],
    { stdio: 'ignore' }
  );
} catch {}

console.log('[rename-dev-electron] patched: CFBundleName=TipATask');
