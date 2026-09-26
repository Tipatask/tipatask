'use strict';
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const text = fs.readFileSync(pkgPath, 'utf8');

const match = text.match(/"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"/);
if (!match) {
  console.error('[bump-version] ERROR: could not parse version from package.json');
  process.exit(1);
}

const [, major, minor, patch] = match;
const newVersion = `${major}.${minor}.${Number(patch) + 1}`;
const updated = text.replace(
  /"version"\s*:\s*"\d+\.\d+\.\d+"/,
  `"version": "${newVersion}"`
);

fs.writeFileSync(pkgPath, updated, 'utf8');
console.log(`Bumped version to ${newVersion}`);
