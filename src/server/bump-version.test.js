'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { nextPatchVersion } = require('../../scripts/bump-version');

test('nextPatchVersion increments only the patch component', () => {
  assert.equal(nextPatchVersion('0.8.98'), '0.8.99');
  assert.equal(nextPatchVersion('1.2.9'), '1.2.10');
});

test('nextPatchVersion rejects unparsable versions', () => {
  assert.throws(() => nextPatchVersion('x'), /cannot parse/);
  assert.throws(() => nextPatchVersion('1.2'), /cannot parse/);
  assert.throws(() => nextPatchVersion('1.2.3-beta'), /cannot parse/);
});

test('bump-version delegates to npm version without creating a git tag', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../scripts/bump-version.js'), 'utf8');
  assert.match(src, /'version', next, '--no-git-tag-version'/);
});

test('versionsInSync', () => {
  const root = path.join(__dirname, '../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const fix = `run \`npm run bump-version\` or \`npm version ${pkg.version} --no-git-tag-version\``;
  assert.equal(lock.version, pkg.version,
    `package-lock.json version (${lock.version}) != package.json version (${pkg.version}); ${fix}`);
  assert.equal(lock.packages[''].version, pkg.version,
    `package-lock.json root package version (${lock.packages[''].version}) != package.json version (${pkg.version}); ${fix}`);
});
