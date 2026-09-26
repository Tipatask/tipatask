'use strict';

// (C1346) Regression tests for api-backend.js's per-project local recipe mirror — the actual
// crash site of the reauth ENOTDIR bug (api:auth.reauth-save -> reconfigureAndProbe -> init()
// -> the OLD process-global fileOps.ensureRecipesDir(), which resolved inside app.asar in the
// Electron main process). See recipes-store.test.js for the pure resolveRecipesDir()/
// writeRecipe() unit tests this backend now delegates to.
//
// Pin TIPATASK_PROJECT_ROOT to a scratch dir BEFORE requiring anything that pulls config.js
// (config.js reads it once at module-load time) — mirrors api-config-project-root.test.js's
// C1132 guard, so config.PROJECT_ROOT here is never the real Tipatask repo checkout.
const GLOBAL_ROOT_PLACEHOLDER = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'tt-c1346-global-')
);
process.env.TIPATASK_PROJECT_ROOT = GLOBAL_ROOT_PLACEHOLDER;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('./config');
const { createApiBackend } = require('./api-backend');

assert.strictEqual(config.PROJECT_ROOT, GLOBAL_ROOT_PLACEHOLDER, 'sanity: config.PROJECT_ROOT must be the pinned scratch dir, not the real repo');

// Same pattern as reserve-task-keys.test.js's withFakeApiServer: a throwaway local HTTP
// server plus a real .tipatask/config.json, so createApiBackend()'s live credential reads
// and apiRequest() calls hit a real (if fake) endpoint instead of needing a deeper mock.
async function withFakeApiServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1346-project-'));
  fs.mkdirSync(path.join(projectRoot, '.tipatask'));
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${port}`,
    API_TOKEN: 'test-token',
    API_PROJECT_ID: '1',
  }));
  try {
    await run(projectRoot, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function defaultHandler(req, res) {
  if (req.method === 'GET' && req.url.endsWith('/tasks')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks: [] }));
    return;
  }
  if (req.method === 'POST' && req.url.endsWith('/recipes')) {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ recipe: { filename: '0001_test.md' }, duplicate: false }));
    return;
  }
  // GET /api/auth/me and anything else: 404 — _fetchCurrentUserId() tolerates this (warns,
  // does not throw), so it must never fail init().
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

test('createApiBackend(cfg, projectRoot) resolves its local recipe copy to <projectRoot>/.tipatask/recipes — never config.DATA_ROOT/ai/todo/recipes', () => withFakeApiServer(
  defaultHandler,
  async (projectRoot) => {
    const backend = createApiBackend(null, projectRoot);
    assert.equal(backend._localRecipesDir(), path.join(projectRoot, '.tipatask', 'recipes'));
  }
));

test('(C1318) createApiBackend(null, projectRoot) where projectRoot IS/contains SERVER_ROOT (the module-singleton-in-a-packaged-build shape): _localRecipesDir() is null — refuses to mkdir into the bundle', () => {
  // Mirrors src/server/index.js:141's module singleton (`createApiBackend(null)`), which in a
  // packaged Electron build falls back to config.PROJECT_ROOT === the guessed app bundle path
  // (C1318). Exercise the same containment guard directly against the real config.SERVER_ROOT
  // this test process sees, standing in for "the bundle".
  const bundleLike = createApiBackend(null, config.SERVER_ROOT);
  assert.equal(bundleLike._localRecipesDir(), null);

  const ancestorOfBundle = createApiBackend(null, path.resolve(config.SERVER_ROOT, '..', '..'));
  assert.equal(ancestorOfBundle._localRecipesDir(), null);
});

test('(C1346) the module singleton (createApiBackend(null), no projectRoot argument at all) never targets config.DATA_ROOT for recipes', () => {
  // src/server/index.js:141's exact call shape for TASK_BACKEND=api with nothing bound.
  const singleton = createApiBackend(null);
  const dir = singleton._localRecipesDir();
  // Either null (guarded out) or a real per-project .tipatask/recipes path — never the old
  // global ai/todo/recipes shape this bug used to hit.
  if (dir !== null) {
    assert.ok(dir.endsWith(path.join('.tipatask', 'recipes')), `expected .tipatask/recipes, got: ${dir}`);
  }
});

test('(C1346) init(): a broken local recipes dir is non-fatal — connection still succeeds', () => withFakeApiServer(
  defaultHandler,
  async (projectRoot) => {
    // Block the exact target: a FILE where the recipes directory should be, so
    // fs.mkdir(dir, {recursive:true}) throws instead of succeeding.
    fs.mkdirSync(path.join(projectRoot, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.tipatask', 'recipes'), 'i am a file, not a dir');

    const backend = createApiBackend(null, projectRoot);
    await backend.init(); // must not throw
    assert.equal(backend.getConnectionState(), 'connected');
  }
));

test('(C1346) saveRecipe(): a broken local recipes dir is non-fatal — the API save still succeeds and returns its result', () => withFakeApiServer(
  defaultHandler,
  async (projectRoot) => {
    fs.mkdirSync(path.join(projectRoot, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.tipatask', 'recipes'), 'i am a file, not a dir');

    const backend = createApiBackend(null, projectRoot);
    const result = await backend.saveRecipe('some recipe content'); // must not throw
    assert.equal(result.filename, '0001_test.md');
    assert.equal(result.duplicate, false);
  }
));

test('(C1346) saveRecipe(): with a healthy project root, the local mirror is actually written to .tipatask/recipes', () => withFakeApiServer(
  defaultHandler,
  async (projectRoot) => {
    const backend = createApiBackend(null, projectRoot);
    await backend.saveRecipe('mirrored recipe content for real');
    const dir = path.join(projectRoot, '.tipatask', 'recipes');
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}_.*\.md$/);
  }
));
