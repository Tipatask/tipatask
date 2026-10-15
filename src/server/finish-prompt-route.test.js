'use strict';

// TPT614 — GET /api/tasks/:taskKey/finish-prompt through the real createHttpHandler + a stub
// backend, against the git-merge temp fixture (root + nested repo), so completion-guard.js's
// checkTaskCommit() runs real git reads. Same harness as merge-routes.test.js. Offline: no
// network, no real API.

process.env.TASK_BACKEND = 'api';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fx = require('./git-merge/test-fixture');
const { createHttpHandler, replayLeftUncommitted, validateRestoredLeftUncommitted } = require('./ws-handlers');

fx.applyFixtureEnvToProcess();

function fakeReq(method, url, { project } = {}) {
  const req = { method, url, headers: project ? { 'x-tipatask-project': project } : {} };
  req[Symbol.asyncIterator] = async function* () {};
  return req;
}
function fakeRes() {
  const res = { statusCode: null, headers: null, body: '', writeHead(s, h) { res.statusCode = s; res.headers = h; }, end(c) { res.body = c || ''; } };
  return res;
}
async function call(handler, url, project) {
  const res = fakeRes();
  await handler(fakeReq('GET', url, { project }), res);
  return { res, body: JSON.parse(res.body || '{}') };
}

// Worktrees off: task branches never count, only a `<KEY>:` commit reachable from a main checkout
// HEAD does — the fixture's task branches hold commits, its main checkouts do not. readVcsContext()
// needs all four flags present.
const COMMIT_ON = { vcs_type: 'git', vcs_worktree_enabled: 0, vcs_commit_enabled: 1, vcs_pr_enabled: 0, vcs_merge_enabled: 0 };
function backendFor(f, vcs = COMMIT_ON) {
  return { ...fx.fakeBackend(f, { vcs }), async getTask(key) { return f.tasksByKey.get(key) || null; } };
}

test('finish-prompt: 200 with the finalize prompt and the live commit blocker; 409 TASK_COMMITTED once a reachable key commit exists', async t => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t, { tasks: { TPT1: { status: 'in_progress' } } });
  const handler = createHttpHandler(new Map(), () => backendFor(f), null);
  let r = await call(handler, '/api/tasks/TPT1/finish-prompt', f.root);
  assert.equal(r.res.statusCode, 200, r.res.body);
  assert.equal(r.res.headers['Cache-Control'], 'no-cache, no-store');
  assert.equal(r.body.taskKey, 'TPT1');
  assert.equal(r.body.commitEnabled, true);
  assert.equal(r.body.status, 'in_progress');
  assert.deepEqual(r.body.vcs, { type: 'git', worktree: false, commit: true, pr: false, merge: false });
  assert.deepEqual(r.body.blockers.map(b => b.code), ['TASK_COMMIT_MISSING']);
  assert.match(r.body.prompt, /^You are finishing task TPT1\./);
  assert.match(r.body.prompt, /- TASK_COMMIT_MISSING: Commits are enabled for this project and no commit starting with TPT1 is reachable/);
  assert.match(r.body.prompt, /commit them with a message starting with TPT1:/);
  assert.match(r.body.prompt, /complete_task\(TPT1, resolution\)/);

  fx.commit(f.git, f.root, { 'src/finish.js': 'done\n' }, 'TPT1: finish feature one');
  r = await call(handler, '/api/tasks/TPT1/finish-prompt', f.root);
  assert.equal(r.res.statusCode, 409, r.res.body);
  assert.equal(r.body.code, 'TASK_COMMITTED');
  assert.match(r.body.error, /already has a reachable TPT1: commit/);
  assert.equal(r.body.prompt, undefined);
});

test('finish-prompt: 404 for an unknown key, 409 TASK_CLOSED for a closed task, 409 COMMITS_OFF when no commit is required', async t => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t, { tasks: { TPT1: { status: 'in_progress' } } }); // TPT2 stays completed
  const handler = createHttpHandler(new Map(), () => backendFor(f), null);
  let r = await call(handler, '/api/tasks/TPT9/finish-prompt', f.root);
  assert.equal(r.res.statusCode, 404);
  assert.equal(r.body.code, 'TASK_NOT_FOUND');
  // (TPT664) A stale-flag 409 retires the server-side flag too, so no other window keeps Finish.
  const registry = require('./left-uncommitted');
  registry.record(f.root, 'TPT2', { exitId: 'TPT2@1', blockers: [], status: 'on_fire', closedNames: ['completed'] });
  r = await call(handler, '/api/tasks/TPT2/finish-prompt', f.root);
  assert.equal(r.res.statusCode, 409);
  assert.equal(r.body.code, 'TASK_CLOSED');
  assert.equal(registry.get(f.root, 'TPT2'), null, 'TASK_CLOSED retired the flag');
  const off = createHttpHandler(new Map(), () => backendFor(f, { ...COMMIT_ON, vcs_commit_enabled: 0 }), null);
  registry.record(f.root, 'TPT1', { exitId: 'TPT1@1', blockers: [], status: 'on_fire', closedNames: ['completed'] });
  r = await call(off, '/api/tasks/TPT1/finish-prompt', f.root);
  assert.equal(r.res.statusCode, 409, r.res.body);
  assert.equal(r.body.code, 'COMMITS_OFF');
  assert.equal(r.body.vcs.commit, false);
  assert.equal(registry.get(f.root, 'TPT1'), null, 'COMMITS_OFF retired the flag');
});

test('finish-prompt: 409 VCS_UNVERIFIED when the settings read fails — an unknown state never yields a commit instruction', async t => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t, { tasks: { TPT1: { status: 'in_progress' } } });
  const backend = { ...backendFor(f), async getProjectSettings() { throw new Error('api down'); } };
  const handler = createHttpHandler(new Map(), () => backend, null);
  const r = await call(handler, '/api/tasks/TPT1/finish-prompt', f.root);
  assert.equal(r.res.statusCode, 409, r.res.body);
  assert.equal(r.body.code, 'VCS_UNVERIFIED');
  assert.equal(r.body.prompt, undefined);
});

// (TPT670) Flags restored from left-uncommitted.json at boot are judged once, on the project's first
// __attention__ / __board__ connect, with the same rule as the route above.
function restoreFlags(t, projectRoot, keys) {
  const registry = require('./left-uncommitted');
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-left-uncommitted-'));
  t.after(() => { registry._reset(); fs.rmSync(store, { recursive: true, force: true }); });
  const at = Date.now();
  const flags = Object.fromEntries(keys.map(key => [key, { exitId: `${key}@1`, blockers: [{ code: 'TASK_COMMIT_MISSING', message: 'm' }],
    status: 'on_fire', agent: 'claude', nudgeCount: 0, at, closedNames: ['completed', 'canceled'] }]));
  fs.writeFileSync(path.join(store, registry.FILE_NAME), JSON.stringify({ version: 1, projects: { [projectRoot]: flags } }));
  registry._reset();
  assert.deepEqual(registry.load({ root: store }), { restored: keys.length, dropped: 0 });
  return { registry, saved: () => Object.keys(JSON.parse(fs.readFileSync(path.join(store, registry.FILE_NAME), 'utf8')).projects[projectRoot] || {}) };
}

test('restored flags: closed and hand-committed tasks retire with a cleared frame, a still-missing commit stays — each judged once', async t => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t, { tasks: { TPT1: { status: 'in_progress' }, TPT3: { status: 'in_progress' } } }); // TPT2 stays completed
  const { registry, saved } = restoreFlags(t, f.root, ['TPT1', 'TPT2', 'TPT3']);
  fx.commit(f.git, f.root, { 'src/finish3.js': 'done\n' }, 'TPT3: finish feature three');
  const frames = [];
  const websocket = { emitTaskLeftUncommitted: (projectPath, taskId, blockers, extra) => frames.push({ projectPath, taskId, blockers, ...extra }) };
  await validateRestoredLeftUncommitted(f.root, backendFor(f), { websocket });
  assert.ok(registry.get(f.root, 'TPT1'), 'commit still missing: Finish stays');
  assert.equal(registry.get(f.root, 'TPT2'), null, 'closed while the app was down');
  assert.equal(registry.get(f.root, 'TPT3'), null, 'committed by hand while the app was down');
  assert.deepEqual(frames, [
    { projectPath: f.root, taskId: 'TPT2', blockers: [], cleared: true, exitId: 'TPT2@1' },
    { projectPath: f.root, taskId: 'TPT3', blockers: [], cleared: true, exitId: 'TPT3@1' },
  ]);
  assert.deepEqual(saved(), ['TPT1']);
  // Judged once per boot: a later connect leaves the kept flag to the route and the live retire paths.
  fx.commit(f.git, f.root, { 'src/finish1.js': 'done\n' }, 'TPT1: finish feature one');
  frames.length = 0;
  await validateRestoredLeftUncommitted(f.root, backendFor(f), { websocket });
  assert.ok(registry.get(f.root, 'TPT1'));
  assert.deepEqual(frames, []);
});

test('restored flags: the connect replay starts the check; an unverifiable or failed read keeps the flag', async t => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t, { tasks: { TPT1: { status: 'in_progress' }, TPT2: { status: 'in_progress' } } });
  const { registry } = restoreFlags(t, f.root, ['TPT1', 'TPT2']);
  const warn = t.mock.method(console, 'warn', () => {});
  const backend = {
    ...backendFor(f),
    async getProjectSettings() { throw new Error('api down'); },
    async getTask(key) { if (key === 'TPT2') throw new Error('offline'); return f.tasksByKey.get(key) || null; },
  };
  const sent = [];
  await replayLeftUncommitted({ _projectPath: f.root, send: d => sent.push(JSON.parse(d)) }, { backend });
  assert.deepEqual(sent.map(m => [m.taskId, m.replay]), [['TPT1', true], ['TPT2', true]], 'replayed before the check');
  assert.ok(registry.get(f.root, 'TPT1'), 'VCS_UNVERIFIED keeps it');
  assert.ok(registry.get(f.root, 'TPT2'), 'a failed read keeps it');
  assert.ok(warn.mock.calls.some(c => /TPT2: restored flag check failed: offline/.test(c.arguments[0])));
  assert.deepEqual(registry.takeRestored(f.root), [], 'both were judged');
});
