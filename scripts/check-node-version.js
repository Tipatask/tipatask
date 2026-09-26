'use strict';

// (stale-node guard) required first thing in build.js, before any other require. Wrong
// Node on PATH (e.g. a stale ambient /usr/local/bin/node shadowing nvm) otherwise fails
// deep inside a dependency with a cryptic message like "Cannot find module 'node:fs'"
// instead of naming the real cause.
// This file itself must run under ANY Node the caller might have on PATH, so it stays
// plain ES5/ES2015 CommonJS with bare (non-"node:") requires — a stale interpreter that
// can't even parse this file would just crash silently past the point it could warn.

var fs = require('fs');
var path = require('path');

function parseMinVersion(range) {
  // engines.node is always a ">=X.Y.Z" floor in this repo (never a caret/tilde/complex
  // range) — pull the first dotted version number out of the string.
  var m = /(\d+)\.(\d+)\.(\d+)/.exec(range || '');
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function parseCurrentVersion(v) {
  var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v || '');
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function isBelow(current, min) {
  if (current.major !== min.major) return current.major < min.major;
  if (current.minor !== min.minor) return current.minor < min.minor;
  return current.patch < min.patch;
}

function main() {
  var pkgPath = path.join(__dirname, '..', 'package.json');
  var pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    return; // can't find/parse our own package.json — fail open, don't block the build
  }

  var required = pkg && pkg.engines && pkg.engines.node;
  var min = parseMinVersion(required);
  if (!min) return; // no usable floor declared — fail open

  var current = parseCurrentVersion(process.version);
  if (!current) return; // unrecognized process.version format — fail open

  if (!isBelow(current, min)) return; // OK, silent

  console.error('');
  console.error(
    'FATAL: this build needs Node >=' + min.major + '.' + min.minor + '.' + min.patch +
    ', but the Node on PATH is v' + process.version.replace(/^v/, '') + ', a DIFFERENT,'
  );
  console.error(
    '       older toolchain. Continuing under the wrong Node fails later with confusing'
  );
  console.error(
    '       errors (or, in the worst case, silently misbehaves).'
  );
  console.error('');
  console.error('       Fix (nvm, this repo\'s pin — .nvmrc says "22"):');
  console.error('         nvm use 22');
  console.error('');
  console.error('       (or, if you use mise/asdf instead, whatever activates its Node 22 shim)');
  console.error('');

  process.exit(1);
}

main();
