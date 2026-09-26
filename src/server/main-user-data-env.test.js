'use strict';

// (C1346) Source-position lock for main.js's TIPATASK_USER_DATA / PORT fix.
//
// Why a text-level test instead of actually requiring main.js: main.js requires 'electron' at
// module scope, which does not exist outside a real Electron process, and config.js's own
// C1061 guard (spawn-utils.js) rejects an asar-shaped TIPATASK_SERVER_ROOT unless
// process.versions.electron is set — so a plain-node child cannot fake the packaged shape
// either (see config-data-root.test.js and tt-config.md § DATA_ROOT for the pure-fn coverage
// of the actual path-resolution logic). What CAN be locked purely is the ordering itself,
// which is load-bearing: main.js:23-27's comment explains why (a config.js require ahead of
// this point would see the wrong USER_DATA_ROOT, and if it happened before startServer()'s
// fork, would also invert the forked child's documented config.json-over-.env precedence).

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS_PATH = path.join(__dirname, '..', '..', 'main.js');
const mainSrc = fs.readFileSync(MAIN_JS_PATH, 'utf8');

test('(C1346) main.js sets process.env.TIPATASK_USER_DATA before the first require of ./main/ipc/api-router (the first module in this process to load src/server/config.js)', () => {
  const setIdx = mainSrc.search(/process\.env\.TIPATASK_USER_DATA\s*=/);
  const requireIdx = mainSrc.indexOf("require('./main/ipc/api-router')");
  assert.notEqual(setIdx, -1, 'expected main.js to assign process.env.TIPATASK_USER_DATA');
  assert.notEqual(requireIdx, -1, "expected main.js to require('./main/ipc/api-router')");
  assert.ok(setIdx < requireIdx, `TIPATASK_USER_DATA assignment (index ${setIdx}) must precede the api-router require (index ${requireIdx})`);
});

test('(C1346) main.js gates the TIPATASK_USER_DATA assignment on app.isPackaged (dev must keep USER_DATA_ROOT === SERVER_ROOT)', () => {
  assert.match(mainSrc, /app\.isPackaged\)\s*process\.env\.TIPATASK_USER_DATA\s*=\s*app\.getPath\('userData'\)/);
});

test('(C1346) main.js pins process.env.PORT so main and the forked server child can never disagree (<userData>/.env ships PORT=4445; the fork is told 4455 explicitly)', () => {
  assert.match(mainSrc, /process\.env\.PORT\s*=\s*String\(process\.env\.PORT\s*\|\|\s*4455\)/);
});

test('(C1346) the PORT pin runs before the const PORT declaration it protects', () => {
  const pinIdx = mainSrc.search(/process\.env\.PORT\s*=\s*String\(/);
  const constIdx = mainSrc.search(/const PORT\s*=\s*process\.env\.PORT/);
  assert.notEqual(pinIdx, -1);
  assert.notEqual(constIdx, -1);
  assert.ok(pinIdx < constIdx, `PORT pin (index ${pinIdx}) must precede the const PORT declaration (index ${constIdx})`);
});
