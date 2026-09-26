'use strict';

// C1323 — main/window-state.js's bindWindowToProject() is the ONLY automatic KB pull an
// Electron project window ever gets (Electron skips the board WS, so ws-handlers.js's
// connect-side fireSessionSync never runs for it — see tt-electron-app.md § Per-Window
// Backend Binding). It had zero coverage: main/ sits outside npm test's src/**/*.test.js
// glob, and _fireKbSync's setImmediate + lazy require made it unobservable without real
// HTTP. This file lives under src/server/ (not main/) so it's inside the test glob —
// same precedent as src/server/perf-log-ipc.test.js, which already tests
// main/ipc/api-router.js this way.
//
// Module._load interception fakes 'electron' and '../src/server/task-backend' — the two
// specifiers window-state.js requires that would otherwise need a real BrowserWindow or a
// real file/API backend. '../src/server/project-config' and '../src/codex-mcp-config' stay
// real (no electron dependency, side-effect free for what bindWindowToProject exercises).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');

const fakeElectron = { BrowserWindow: { getAllWindows: () => [] } };
const fakeTaskBackend = {
  // bindWindowToProject only needs backend.init() to exist and resolve — the real
  // onConnectionStateChange/getConnectionState branches are optional (typeof-guarded).
  createPerProjectBackend: () => ({ init: () => Promise.resolve() }),
};

const windowStatePath = require.resolve('../../main/window-state');
const previousWindowState = require.cache[windowStatePath];
const originalLoad = Module._load;

Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === '../src/server/task-backend') return fakeTaskBackend;
  return originalLoad.call(this, request, parent, isMain);
};

let windowState;
try {
  delete require.cache[windowStatePath];
  windowState = require(windowStatePath);
} finally {
  Module._load = originalLoad;
  if (previousWindowState) require.cache[windowStatePath] = previousWindowState;
  else delete require.cache[windowStatePath];
}

const { bindWindowToProject, dropWindow, setKbSyncScheduler, setServerMessenger } = windowState;

// Module._load was restored above, so this resolves the REAL knowledge-sync.js — the same
// singleton _fireKbSync's own lazy `require('../src/cli/knowledge-sync')` resolves to, since
// both specifiers point at the same absolute file and Node caches by resolved path.
const knowledgeSync = require('../cli/knowledge-sync');

function mkroot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeConfig(root, values) {
  fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify(values), 'utf8');
}

function withEnv(t, key, value) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; });
}

function patch(obj, key, fn) {
  const orig = obj[key];
  obj[key] = fn;
  return () => { obj[key] = orig; };
}

// Minimal loopback fake KB API — same shape as src/cli/knowledge-sync.test.js's startServer.
function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const { status, body } = handler(u.pathname, req.method);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body ?? {}));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
function serverUrl(srv) { return `http://127.0.0.1:${srv.address().port}`; }

let _wcId = 1;
function nextWcId() { return _wcId++; } // monotonic — avoids cross-test _windows collisions

function flush() { return new Promise((r) => setImmediate(r)); }

// syncProjectKb's real-network path (fetchRemoteVersions -> a real loopback socket) needs
// more than a couple setImmediate ticks — the response lands in libuv's poll phase, which
// runs before the check phase setImmediate callbacks fire in. Poll instead of guessing a
// fixed tick count.
async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return true;
}

// ── Fake-scheduler cases — observe scheduling decisions, no real HTTP ──

test('app restore: one bind per restored session path schedules one sync each, for the right root', (t) => {
  const roots = [mkroot('tipatask-wsks-restore-a-'), mkroot('tipatask-wsks-restore-b-'), mkroot('tipatask-wsks-restore-c-')];
  t.after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
  // (C1352) bindWindowToProject now short-circuits to the null-backend state (no scheduled
  // sync) for a root with no readable config — write a minimal one so this stays a pure
  // KB-sync-scheduling test, not a config-fallback test.
  roots.forEach((r) => writeConfig(r, { TASK_BACKEND: 'api' }));

  const scheduled = [];
  setKbSyncScheduler((projectPath) => scheduled.push(projectPath));
  t.after(() => setKbSyncScheduler(null));

  const wcIds = roots.map(() => nextWcId());
  wcIds.forEach((wcId, i) => bindWindowToProject(wcId, roots[i]));
  t.after(() => wcIds.forEach((wcId) => dropWindow(wcId)));

  assert.deepStrictEqual(scheduled, roots, 'one sync scheduled per root, in bind order, no cross-talk');
});

test('in-place project open: rebinding a webContentsId schedules a sync for the NEW root, not the stale one', (t) => {
  const rootA = mkroot('tipatask-wsks-inplace-a-');
  const rootB = mkroot('tipatask-wsks-inplace-b-');
  t.after(() => { fs.rmSync(rootA, { recursive: true, force: true }); fs.rmSync(rootB, { recursive: true, force: true }); });
  // (C1352) see the "app restore" test above — a root needs a real config now.
  writeConfig(rootA, { TASK_BACKEND: 'api' });
  writeConfig(rootB, { TASK_BACKEND: 'api' });

  const scheduled = [];
  setKbSyncScheduler((projectPath) => scheduled.push(projectPath));
  t.after(() => setKbSyncScheduler(null));

  const wcId = nextWcId();
  bindWindowToProject(wcId, rootA);   // mirrors createProjectWindow's initial bind
  dropWindow(wcId);                    // mirrors project:open target:'current' — main.js:620
  bindWindowToProject(wcId, rootB);   // mirrors the rebind at main.js:624
  t.after(() => dropWindow(wcId));

  assert.deepStrictEqual(scheduled, [rootA, rootB]);
});

test('binding a null project (setup window, empty launch) schedules no sync', (t) => {
  const scheduled = [];
  setKbSyncScheduler((projectPath) => scheduled.push(projectPath));
  t.after(() => setKbSyncScheduler(null));

  const wcId = nextWcId();
  bindWindowToProject(wcId, null);
  t.after(() => dropWindow(wcId));

  assert.deepStrictEqual(scheduled, []);
});

test('two windows bound to the same project each schedule their own sync (window-state does not dedupe)', (t) => {
  const root = mkroot('tipatask-wsks-twowin-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // (C1352) see the "app restore" test above — a root needs a real config now.
  writeConfig(root, { TASK_BACKEND: 'api' });

  const scheduled = [];
  setKbSyncScheduler((projectPath) => scheduled.push(projectPath));
  t.after(() => setKbSyncScheduler(null));

  const wcId1 = nextWcId();
  const wcId2 = nextWcId();
  bindWindowToProject(wcId1, root);
  bindWindowToProject(wcId2, root);
  t.after(() => { dropWindow(wcId1); dropWindow(wcId2); });

  assert.deepStrictEqual(scheduled, [root, root], 'coalescing to one HTTP pull is fireSessionSync\'s job, not window-state\'s');
});

// ── Real _fireKbSync — non-blocking guarantee + the kb:auto-reindex fork delegation ──

test('bindWindowToProject returns before the KB sync fires (setImmediate keeps startup unblocked)', async (t) => {
  const root = mkroot('tipatask-wsks-nonblock-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // (C1352) see the "app restore" test above — a root needs a real config now.
  writeConfig(root, { TASK_BACKEND: 'api' });

  let called = false;
  let resolveSync;
  t.after(patch(knowledgeSync, 'syncProjectKb', () => {
    called = true;
    return new Promise((res) => { resolveSync = res; });
  }));

  const wcId = nextWcId();
  bindWindowToProject(wcId, root);
  assert.strictEqual(called, false, 'must not have fired yet — the real call is deferred via setImmediate');

  await flush();
  assert.strictEqual(called, true, 'fires on a later tick');
  resolveSync({ ok: true, status: 'skipped-no-backend' });
  await flush();
  dropWindow(wcId);
});

// (C1353) knowledge-sync.js's TASK_BACKEND gate now runs through coerceBackendType() — 'file'
// resolves to 'api' (C1352 retired the file backend), so this uses a genuinely unrecognized
// value to still exercise the backend gate specifically (as opposed to the credentials gate,
// which a coerced 'file' config with no API_TOKEN would now hit instead).
test('_fireKbSync: a project with an unrecognized backend never delegates to the kb:auto-reindex fork messenger', async (t) => {
  const root = mkroot('tipatask-wsks-filebackend-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeConfig(root, { TASK_BACKEND: 'legacy-unknown' });
  withEnv(t, 'TASK_BACKEND', undefined); // a stray exported TASK_BACKEND=api must not win over config.json

  const messages = [];
  setServerMessenger((msg) => messages.push(msg));
  t.after(() => setServerMessenger(null));

  const wcId = nextWcId();
  bindWindowToProject(wcId, root);
  t.after(() => dropWindow(wcId));
  await new Promise((r) => setTimeout(r, 50)); // no network hop here — a fixed settle window is enough

  assert.deepStrictEqual(messages, [], 'skipped-no-backend must short-circuit before the messenger dispatch');
});

test('_fireKbSync: a synced api-backend project delegates exactly one kb:auto-reindex message', async (t) => {
  const root = mkroot('tipatask-wsks-apisync-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const srv = await startServer((pathname) => {
    if (pathname === '/api/projects/p6/knowledge') return { status: 200, body: { files: [] } };
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: serverUrl(srv), API_TOKEN: 'tok', API_PROJECT_ID: 'p6' });
  withEnv(t, 'TASK_BACKEND', undefined);

  const messages = [];
  setServerMessenger((msg) => messages.push(msg));
  t.after(() => setServerMessenger(null));

  const wcId = nextWcId();
  bindWindowToProject(wcId, root);
  t.after(() => dropWindow(wcId));

  const ok = await waitUntil(() => messages.length > 0);
  assert.ok(ok, 'timed out waiting for the kb:auto-reindex delegate message');
  assert.deepStrictEqual(messages, [{ type: 'kb:auto-reindex', projectPath: root }]);
});
