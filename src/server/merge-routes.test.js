'use strict';

// TPT345 — /api/project/merge/* through the real createHttpHandler + a stub backend, against
// a temp git fixture (root + nested repo). Same harness as project-vcs-settings-route.test.js.
// Offline: no network, no real API.

process.env.TASK_BACKEND = 'api';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./git-merge/test-fixture');
const { createHttpHandler } = require('./ws-handlers');
const { clearJob, getJob } = require('./git-merge/merge-job');
const { parseTargetsQuery, statusForError } = require('./merge-routes');
const { MergeError } = require('./git-merge');

fx.applyFixtureEnvToProcess();

function fakeReq(method, url, { body, project } = {}) {
  const req = { method, url, headers: project ? { 'x-tipatask-project': project } : {} };
  req[Symbol.asyncIterator] = async function* () { if (body != null) yield Buffer.from(body); };
  return req;
}
function fakeRes() {
  const res = { statusCode: null, headers: null, body: '', writeHead(s, h) { res.statusCode = s; res.headers = h; }, end(c) { res.body = c || ''; } };
  return res;
}
const json = (res) => JSON.parse(res.body || '{}');
async function call(handler, method, url, opts) { const res = fakeRes(); await handler(fakeReq(method, url, opts), res); return { res, body: json(res) }; }

async function settleJob(root) {
  const job = getJob(root);
  if (job.state === 'running') await new Promise(resolve => {
    const done = () => { job.off('done', done); job.off('conflict', done); resolve(); };
    job.once('done', done); job.once('conflict', done);
  });
  return job;
}

test('task route: 200 merges only the requested key, nested first, then clears its unmerged flag', async t => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  t.after(() => clearJob(f.root));
  fx.addTaskBranch(f.git, f.root, 'TPT10', { 'ten.js': 'ten' });
  fx.addTaskBranch(f.git, f.nested, 'TPT1', { 'extra.js': 'extra' }, { suffix: 'extra' });
  const handler = createHttpHandler(new Map(), () => fx.fakeBackend(f), null);
  const request = (method, path, body) => call(handler, method, '/api/project/merge/' + path, { project: f.root, body: JSON.stringify(body) });
  let r = await request('GET', 'status');
  assert.equal(r.body.tasks.TPT1.unmerged, true);
  r = await request('POST', 'task', { taskKey: 'TPT1', selections: [{ repoId: 'root', branch: 'task/TPT10' }] });
  assert.equal(r.res.statusCode, 200);
  assert.ok(r.body.jobId);
  assert.deepEqual(r.body.plan.filter(s => s.kind === 'merge').map(s => [s.repoId, s.branch]), [
    ['ai/todo/server', 'task/TPT1'], ['ai/todo/server', 'task/TPT1-extra'], ['root', 'task/TPT1'],
  ]);
  assert.equal((await settleJob(f.root)).state, 'done');
  r = await request('GET', 'status');
  assert.equal(r.body.tasks.TPT1.unmerged, false);
  for (const key of ['TPT2', 'TPT3', 'TPT10']) assert.equal(r.body.tasks[key].unmerged, true);
  r = await request('POST', 'task', { taskKey: 'TPT1' });
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.body.code, 'NOTHING_TO_MERGE');
});

test('task route validates key, settings and preflight; conflicts retain attention until resolved', async t => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  t.after(() => clearJob(f.root));
  const handler = createHttpHandler(new Map(), () => fx.fakeBackend(f), null);
  const request = (path, body, h = handler) => call(h, 'POST', '/api/project/merge/' + path, { project: f.root, body: JSON.stringify(body) });
  for (const body of [{}, null, { taskKey: '../TPT1' }]) {
    const r = await request('task', body);
    assert.equal(r.res.statusCode, 400); assert.equal(r.body.code, 'BAD_REQUEST');
  }
  let r = await request('task', { taskKey: 'TPT999' });
  assert.equal(r.res.statusCode, 404);
  const auto = createHttpHandler(new Map(), () => fx.fakeBackend(f, { vcs: { vcs_type: 'git', vcs_merge_enabled: true } }), null);
  r = await request('task', { taskKey: 'TPT1' }, auto);
  assert.equal(r.res.statusCode, 409); assert.equal(r.body.code, 'AUTO_MERGE_ENABLED');
  f.write(f.root, { 'src/feature1.js': 'local' });
  r = await request('task', { taskKey: 'TPT1' });
  assert.equal(r.res.statusCode, 409); assert.equal(r.body.code, 'PREFLIGHT_BLOCKED');
  assert.equal(getJob(f.root), null);
  r = await request('task', { taskKey: 'TPT2' });
  assert.equal(r.res.statusCode, 200);
  assert.equal((await settleJob(f.root)).state, 'done');
  r = await request('task', { taskKey: 'TPT3' });
  assert.equal(r.res.statusCode, 200);
  assert.equal((await settleJob(f.root)).state, 'conflict');
  const status = await call(handler, 'GET', '/api/project/merge/status', { project: f.root });
  assert.equal(status.body.tasks.TPT3.unmerged, true);
  r = await request('task', { taskKey: 'TPT1' });
  assert.equal(r.res.statusCode, 409); assert.equal(r.body.code, 'JOB_RUNNING');
  f.write(f.root, { 'ai/architecture/kb.md': 'resolved\n' });
  f.git(f.root, ['add', 'ai/architecture/kb.md']);
  r = await request('resume', {});
  assert.equal(r.res.statusCode, 200);
  assert.equal((await settleJob(f.root)).state, 'done');
  const after = await call(handler, 'GET', '/api/project/merge/status', { project: f.root });
  assert.equal(after.body.tasks.TPT3.unmerged, false);
});

test('parseTargetsQuery + statusForError', () => {
  const sp = new URLSearchParams('target[root]=develop&target[ai/todo/server]=x&create[a]=new/one&junk=1');
  assert.deepEqual(parseTargetsQuery(sp), { root: { branch: 'develop' }, 'ai/todo/server': { branch: 'x' }, a: { createBranch: 'new/one' } });
  assert.equal(statusForError(new MergeError('X', 409, 'm')), 409);
  assert.equal(statusForError(new Error('boom')), 500);
});

test('routes: svn project → 409 VCS_NOT_GIT; status lists both repos + branches; dry-run; run 202 then 409; abort; cleanup; bad JSON 400; unknown 404', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  t.after(() => clearJob(f.root));
  const svn = createHttpHandler(new Map(), () => fx.fakeBackend(f, { vcs: { vcs_type: 'svn' } }), null);
  let r = await call(svn, 'GET', '/api/project/merge/status', { project: f.root });
  assert.equal(r.res.statusCode, 409); assert.equal(r.body.code, 'VCS_NOT_GIT');

  const backend = fx.fakeBackend(f);
  const sessions = new Map([['s1', { type: 'terminal', taskId: 'TPT2', alive: true, projectPath: f.root }]]);
  const handler = createHttpHandler(sessions, () => backend, null);
  r = await call(handler, 'GET', '/api/project/merge/status?target%5Broot%5D=master', { project: f.root });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.body.vcs.type, 'git'); assert.equal(r.body.job, null);
  assert.deepEqual(r.body.repos.map(x => x.id), ['root', 'ai/todo/server']);
  const root = r.body.repos[0];
  assert.deepEqual(root.taskBranches.map(b => [b.branch, b.task && b.task.status, b.selectedByDefault]), [['task/TPT1', 'completed', true], ['task/TPT2', 'completed', true], ['task/TPT3', 'completed', true]]);
  assert.deepEqual(root.taskBranches[1].blockers.map(b => b.code), ['SESSION_ACTIVE'], 'live terminal session for TPT2 is a warning');
  assert.equal(root.taskBranches[1].sessionActive, true);

  r = await call(handler, 'POST', '/api/project/merge/dry-run', { project: f.root, body: JSON.stringify({ selections: [{ repoId: 'root', branch: 'task/TPT2' }, { repoId: 'root', branch: 'task/TPT3' }] }) });
  assert.equal(r.res.statusCode, 200);
  if (fx.gitProbe().mergeTree) assert.deepEqual(r.body.repos[0].pairwise[0].conflicts, ['ai/architecture/kb.md']);
  assert.deepEqual(r.body.runBlockers, []);
  assert.ok(Array.isArray(r.body.repos[0].branchBlockers['task/TPT2']));

  r = await call(handler, 'POST', '/api/project/merge/dry-run', { project: f.root, body: '{not json' });
  assert.equal(r.res.statusCode, 400); assert.equal(r.body.code, 'BAD_JSON');
  r = await call(handler, 'POST', '/api/project/merge/dry-run', { project: f.root, body: JSON.stringify({ selections: 'x' }) });
  assert.equal(r.res.statusCode, 400); assert.equal(r.body.code, 'BAD_REQUEST');
  r = await call(handler, 'POST', '/api/project/merge/nope', { project: f.root, body: '{}' });
  assert.equal(r.res.statusCode, 404);
  r = await call(handler, 'GET', '/api/project/merge/job', { project: f.root });
  assert.deepEqual(r.body, { ok: true, job: null });
  r = await call(handler, 'POST', '/api/project/merge/resume', { project: f.root, body: '{}' });
  assert.equal(r.res.statusCode, 409); assert.equal(r.body.code, 'NO_JOB');

  // run: TPT2 + TPT3 → stops on the planted conflict
  r = await call(handler, 'POST', '/api/project/merge/run', { project: f.root, body: JSON.stringify({ selections: [{ repoId: 'root', branch: 'task/TPT2' }, { repoId: 'root', branch: 'task/TPT3' }], checks: { test: false, build: false, baseline: false } }) });
  assert.equal(r.res.statusCode, 202);
  assert.ok(r.body.jobId); assert.equal(r.body.state, 'running');
  assert.deepEqual(r.body.plan.map(s => s.kind), ['merge', 'merge']);
  const job = getJob(f.root);
  await new Promise(res => { if (job.state !== 'running') res(); else { job.once('conflict', res); job.once('done', res); } });
  assert.equal(job.state, 'conflict');
  r = await call(handler, 'POST', '/api/project/merge/run', { project: f.root, body: JSON.stringify({ selections: [{ repoId: 'root', branch: 'task/TPT1' }] }) });
  assert.equal(r.res.statusCode, 409); assert.equal(r.body.code, 'JOB_RUNNING');
  r = await call(handler, 'GET', '/api/project/merge/job', { project: f.root });
  assert.equal(r.body.job.state, 'conflict'); assert.deepEqual(r.body.job.conflict.conflictedPaths, ['ai/architecture/kb.md']);
  assert.equal(typeof r.body.job.conflict.handoffPrompt, 'string');
  r = await call(handler, 'GET', '/api/project/merge/status', { project: f.root });
  assert.equal(r.body.job.state, 'conflict');
  assert.ok(r.body.repos[0].blockers.some(b => b.code === 'REPO_MID_MERGE'));
  r = await call(handler, 'POST', '/api/project/merge/resume', { project: f.root, body: '{}' });
  assert.equal(r.res.statusCode, 409); assert.equal(r.body.code, 'STILL_CONFLICTED');
  r = await call(handler, 'POST', '/api/project/merge/abort', { project: f.root, body: '{}' });
  assert.equal(r.res.statusCode, 200); assert.equal(r.body.state, 'aborted');

  // preflight block: dirty file overlapping TPT1 → 409 PREFLIGHT_BLOCKED
  require('node:fs').writeFileSync(require('node:path').join(f.root, 'src/feature1.js'), 'local');
  r = await call(handler, 'POST', '/api/project/merge/run', { project: f.root, body: JSON.stringify({ selections: [{ repoId: 'root', branch: 'task/TPT1' }] }) });
  assert.equal(r.res.statusCode, 409); assert.equal(r.body.code, 'PREFLIGHT_BLOCKED');
  assert.deepEqual(r.body.details.blockers.map(b => b.code), ['MAIN_DIRTY_OVERLAP']);
  require('node:fs').rmSync(require('node:path').join(f.root, 'src/feature1.js'));

  // publish refused when PR disabled but requested; cleanup of the merged TPT2 branch
  r = await call(handler, 'POST', '/api/project/merge/publish', { project: f.root, body: JSON.stringify({ pr: true }) });
  assert.equal(r.res.statusCode, 409); assert.equal(r.body.code, 'PR_DISABLED');
  r = await call(handler, 'POST', '/api/project/merge/cleanup', { project: f.root, body: JSON.stringify({ selections: [{ repoId: 'root', branch: 'task/TPT2' }] }) });
  assert.equal(r.res.statusCode, 200);
  assert.deepEqual(r.body.repos[0].deletedBranches, ['task/TPT2']);
});

test('commit-worktree: refuses a clean worktree, commits a dirty completed one with "<KEY> <title>", refuses non-completed without force', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t, { tasks: { TPT2: { status: 'in_progress' } } });
  const handler = createHttpHandler(new Map(), () => fx.fakeBackend(f), null);
  const fs = require('node:fs'); const path = require('node:path');
  let r = await call(handler, 'POST', '/api/project/merge/commit-worktree', { project: f.root, body: JSON.stringify({ repoId: 'root', branch: 'task/TPT1' }) });
  assert.equal(r.res.statusCode, 400); assert.equal(r.body.code, 'WORKTREE_CLEAN');
  fs.writeFileSync(path.join(f.root, '.worktrees', 'TPT1', 'late.js'), 'late');
  r = await call(handler, 'POST', '/api/project/merge/commit-worktree', { project: f.root, body: JSON.stringify({ repoId: 'root', branch: 'task/TPT1' }) });
  assert.equal(r.res.statusCode, 200); assert.equal(r.body.message, 'TPT1 Feature one');
  assert.equal(f.git(path.join(f.root, '.worktrees', 'TPT1'), ['log', '-1', '--format=%s']), 'TPT1 Feature one');
  fs.writeFileSync(path.join(f.root, '.worktrees', 'TPT2', 'late.js'), 'late');
  r = await call(handler, 'POST', '/api/project/merge/commit-worktree', { project: f.root, body: JSON.stringify({ repoId: 'root', branch: 'task/TPT2' }) });
  assert.equal(r.res.statusCode, 409); assert.equal(r.body.code, 'NOT_COMPLETED');
  r = await call(handler, 'POST', '/api/project/merge/commit-worktree', { project: f.root, body: JSON.stringify({ repoId: 'root', branch: 'task/TPT2', force: true }) });
  assert.equal(r.res.statusCode, 200);
  r = await call(handler, 'POST', '/api/project/merge/commit-worktree', { project: f.root, body: JSON.stringify({ repoId: 'ai/todo/server', branch: 'task/TPT3' }) });
  assert.equal(r.res.statusCode, 404); assert.equal(r.body.code, 'NO_WORKTREE');
});
