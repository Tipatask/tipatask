'use strict';

// (C1141/C1318/C1346) config.js used to compute a DATA_ROOT (TODO.md/recipes/chat-state
// location) for the retired file task backend — resolveDataRoot() and DATA_ROOT itself were
// deleted with that backend (C1353; see ai/architecture/tt-config.md § DATA_ROOT for the
// historical writeup). What survives and is still tested here is the shared guard machinery
// those incidents produced, which
// recipes-store.js now calls directly for its own per-project recipes dir: containsPath()
// (never write into or under the running app.asar) and assertWritableDataDir() (a named
// diagnostic instead of a bare ENOTDIR when a data dir resolves inside app.asar anyway). See
// git history for this file's pre-C1353 resolveDataRoot() coverage if that logic is ever needed
// again.

const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('./config');

test('(C1318/C1346) containsPath is exported and matches resolveDataRoot\'s original containment semantics', () => {
  assert.equal(typeof config.containsPath, 'function');
  assert.equal(config.containsPath('/Applications', '/Applications/TipATask.app/Contents/Resources/app.asar'), true);
  assert.equal(config.containsPath('/Applications/TipATask.app', '/Applications/TipATask.app'), true);
  assert.equal(config.containsPath('/Users/alice/Projects/SomeProject', '/Applications/TipATask.app/Contents/Resources/app.asar'), false);
});

test('(C1346) assertWritableDataDir throws a NAMED diagnostic for an in-asar dir, never a bare ENOTDIR', () => {
  assert.throws(
    () => config.assertWritableDataDir('/Applications/TipATask.app/Contents/Resources/app.asar/data/recipes', 'recipes dir'),
    (err) => err instanceof Error && /app\.asar/.test(err.message) && /TIPATASK_USER_DATA/.test(err.message)
  );
});

test('(C1346) assertWritableDataDir does not throw for an ordinary (non-asar) path', () => {
  assert.doesNotThrow(() => config.assertWritableDataDir(require('node:os').tmpdir(), 'test'));
});
