'use strict';

// Regression tests for C1061: augmentPathEnv() used to unconditionally stamp
// TIPATASK_SERVER_ROOT from config.SERVER_ROOT into every agent/hook spawn env. In a
// packaged Electron build config.SERVER_ROOT resolves inside app.asar (a single regular
// file — Electron's patched fs/child_process read it transparently, but a plain-node child
// like a `.claude/settings.json` hook cannot posix_spawn through it: ENOTDIR "Not a
// directory"). isAsarPath()/resolveSpawnServerRoot() make augmentPathEnv() only ever hand a
// child a spawnable root — this checkout when it isn't an asar path, else the configured
// SERVER_ROOT when that isn't one, else omit the var entirely so the hook command's own
// baked-in fallback + self-guard takes over. The project path is never a candidate: the
// Task App is a standalone checkout with no fixed location inside the projects it manages.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isAsarPath, resolveSpawnServerRoot, augmentPathEnv } = require('./spawn-utils');

const IS_WIN = process.platform === 'win32';
const WRAPPER_NAME = IS_WIN ? 'mcp-node.cmd' : 'mcp-node';
const THIS_CHECKOUT = path.resolve(__dirname, '..', '..');

// Builds <dir>/ai/todo/server/bin/<wrapper> — the pre-standalone nested layout — as a real,
// executable file, to prove it is NOT picked up any more.
function makeNestedCheckout(baseDir) {
  const serverRoot = path.join(baseDir, 'ai', 'todo', 'server');
  fs.mkdirSync(path.join(serverRoot, 'bin'), { recursive: true });
  const wrapperPath = path.join(serverRoot, 'bin', WRAPPER_NAME);
  fs.writeFileSync(wrapperPath, '#!/usr/bin/env bash\ntrue\n');
  fs.chmodSync(wrapperPath, 0o755);
  return serverRoot;
}

test('isAsarPath: detects .asar path segment, rejects normal paths', () => {
  assert.strictEqual(isAsarPath('/Applications/TipATask.app/Contents/Resources/app.asar'), true);
  assert.strictEqual(isAsarPath('/Applications/TipATask.app/Contents/Resources/app.asar/bin/mcp-node'), true);
  assert.strictEqual(isAsarPath('C:\\Program Files\\TipATask\\resources\\app.asar\\bin\\mcp-node.cmd'), true);
  assert.strictEqual(isAsarPath('/Users/alice/Projects/tipatask'), false);
  assert.strictEqual(isAsarPath(''), false);
  assert.strictEqual(isAsarPath(undefined), false);
});

test('resolveSpawnServerRoot: returns this checkout, never a checkout nested under projectPath', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1061-'));
  try {
    const nested = makeNestedCheckout(dir);
    const resolved = resolveSpawnServerRoot(dir);
    assert.notStrictEqual(resolved, nested);
    assert.strictEqual(resolved, THIS_CHECKOUT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSpawnServerRoot: projectPath is irrelevant — same answer with and without one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1061-empty-'));
  try {
    assert.strictEqual(resolveSpawnServerRoot(dir), resolveSpawnServerRoot(undefined));
    assert.strictEqual(resolveSpawnServerRoot(dir), THIS_CHECKOUT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('augmentPathEnv: omits TIPATASK_SERVER_ROOT (rather than an asar path) when no spawnable root exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1061-subproc-'));
  try {
    const script = `
      process.env.TIPATASK_SERVER_ROOT = '/Applications/TipATask.app/Contents/Resources/app.asar';
      const { augmentPathEnv } = require(${JSON.stringify(path.join(__dirname, 'spawn-utils.js'))});
      const env = augmentPathEnv({ TIPATASK_PROJECT_ROOT: ${JSON.stringify(dir)} });
      process.stdout.write(JSON.stringify({ hasKey: 'TIPATASK_SERVER_ROOT' in env, value: env.TIPATASK_SERVER_ROOT || null }));
    `;
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const result = JSON.parse(out);
    // The forced-asar config.SERVER_ROOT is never spawnable, so the env must never carry
    // the asar path through to a hook child.
    assert.notStrictEqual(result.value, '/Applications/TipATask.app/Contents/Resources/app.asar');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('augmentPathEnv: stamps this checkout, ignoring a checkout nested in the bound project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1061-project-'));
  try {
    const nested = makeNestedCheckout(dir);
    const env = augmentPathEnv({ TIPATASK_PROJECT_ROOT: dir });
    assert.notStrictEqual(env.TIPATASK_SERVER_ROOT, nested);
    assert.strictEqual(env.TIPATASK_SERVER_ROOT, THIS_CHECKOUT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('augmentPathEnv: explicit extras.TIPATASK_SERVER_ROOT still overrides the resolved value (codex-env.js regression guard)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1061-override-'));
  try {
    const explicit = '/some/explicit/codex/server/root';
    const env = augmentPathEnv({ TIPATASK_PROJECT_ROOT: dir, TIPATASK_SERVER_ROOT: explicit });
    assert.strictEqual(env.TIPATASK_SERVER_ROOT, explicit);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
