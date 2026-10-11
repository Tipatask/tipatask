'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fx = require('./test-fixture');
const { checkCompletedTaskWorktrees, warnIfCompletedWorktreeDirty, verifyTaskCompletion, completeVerifiedTask, guardCompletionTransition } = require('./completion-guard');

fx.applyFixtureEnvToProcess();

// Strict live reads need all four flags (fx.fakeBackend omits merge); records task writes.
const COMMIT_ON = { id: 7, vcs_type: 'git', vcs_worktree_enabled: 1, vcs_commit_enabled: 1, vcs_pr_enabled: 0, vcs_merge_enabled: 0 };
function guardBackend(row = COMMIT_ON) {
  const calls = [];
  const task = { id: 'TPT1', status: 'in_progress' };
  return { calls,
    getCredentials: () => ({ projectId: 7 }),
    async getProjectSettings() { return { ...row }; },
    async getTask() { return { ...task }; },
    async getStatuses() { return [{ name: 'completed', is_workflow_complete: true }, { name: 'on_fire' }, { name: 'in_progress', is_in_progress: true }]; },
    async createTaskComment(id, content, type) { calls.push(['comment', id, content, type]); },
    async updateTask(id, fields) { calls.push(['update', id, fields]); Object.assign(task, fields); return { ...task }; },
  };
}
const codes = check => check.blockers.map(x => x.code);

test('checkCompletedTaskWorktrees: dirty worktree reported, clean → [], non-git → []', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  fs.writeFileSync(path.join(f.nested, '.worktrees', 'TPT1', 'wip.js'), 'wip');
  const r = await checkCompletedTaskWorktrees({ projectRoot: f.root, taskId: 'TPT1' });
  assert.deepEqual(r.dirty.map(d => [d.repoId, d.dirtyFileCount]), [['ai/todo/server', 1]]);
  assert.deepEqual((await checkCompletedTaskWorktrees({ projectRoot: f.root, taskId: 'TPT2' })).dirty, []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-guard-nongit-'));
  try { assert.deepEqual((await checkCompletedTaskWorktrees({ projectRoot: dir, taskId: 'TPT1' })).dirty, []); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual((await checkCompletedTaskWorktrees({})).dirty, []);
});

test('warnIfCompletedWorktreeDirty: emits once per session, only for git+worktree projects', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  fs.writeFileSync(path.join(f.root, '.worktrees', 'TPT1', 'wip.js'), 'wip');
  const emitted = [];
  const websocket = { emitWorktreeDirtyOnComplete: (p, payload) => emitted.push([p, payload]) };
  const gitBackend = fx.fakeBackend(f);
  const session = { taskId: 'TPT1' };
  const payload = await warnIfCompletedWorktreeDirty({ session, backend: gitBackend, projectRoot: f.root, task: { title: 'Feature one' }, websocket });
  assert.equal(payload.suggestedMessage, 'TPT1 Feature one');
  assert.equal(emitted.length, 1); assert.equal(emitted[0][0], f.root); assert.equal(emitted[0][1].taskId, 'TPT1');
  assert.equal(await warnIfCompletedWorktreeDirty({ session, backend: gitBackend, projectRoot: f.root, websocket }), null, 'second call is a no-op');
  const svnBackend = fx.fakeBackend(f, { vcs: { vcs_type: 'svn', vcs_worktree_enabled: 1 } });
  assert.equal(await warnIfCompletedWorktreeDirty({ session: { taskId: 'TPT1' }, backend: svnBackend, projectRoot: f.root, websocket }), null);
  assert.equal(emitted.length, 1);
  assert.equal(await warnIfCompletedWorktreeDirty({ session: { taskId: 'TPT2' }, backend: gitBackend, projectRoot: f.root, websocket }), null, 'clean worktree → nothing');
});

test('verifyTaskCompletion, commits + worktrees on: needs a task-branch commit and clean tracked worktree files', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const b = guardBackend();
  fs.appendFileSync(path.join(f.root, 'README.md'), 'unrelated root edit\n');
  fs.appendFileSync(path.join(f.nested, 'README.md'), 'unrelated nested edit\n');
  fs.writeFileSync(path.join(f.nested, '.worktrees', 'TPT1', 'scratch.txt'), 'untracked');
  const args1 = { backend: b, projectRoot: f.root, taskId: 'TPT1' };
  let check = await verifyTaskCompletion(args1);
  assert.equal(check.ready, true, JSON.stringify(check.blockers));
  assert.deepEqual(check.repositories.map(r => r.branches), [[{ branch: 'task/TPT1', ahead: 1 }], [{ branch: 'task/TPT1', ahead: 1 }]]);

  fs.appendFileSync(path.join(f.root, '.worktrees', 'TPT1', 'README.md'), 'uncommitted\n');
  check = await verifyTaskCompletion(args1);
  assert.deepEqual(codes(check), ['TASK_WORKTREE_DIRTY']);
  assert.equal(check.blockers[0].branch, 'task/TPT1');
  assert.ok(check.blockers[0].path.endsWith(path.join('.worktrees', 'TPT1')), check.blockers[0].path);
  assert.match(check.blockers[0].message, /commit .* starting with TPT1/);

  const args4 = { backend: b, projectRoot: f.root, taskId: 'TPT4' };
  check = await verifyTaskCompletion(args4);
  assert.deepEqual(codes(check), ['TASK_COMMIT_MISSING']);
  assert.match(check.blockers[0].message, /task\/TPT4/);
  const wt4 = path.join(f.root, '.worktrees', 'TPT4');
  f.git(f.root, ['worktree', 'add', '-q', wt4, '-b', 'task/TPT4', 'HEAD']);
  assert.deepEqual(codes(await verifyTaskCompletion(args4)), ['TASK_COMMIT_MISSING'], 'a task branch with nothing ahead is no commit');
  fx.commit(f.git, wt4, { 'src/feature4.js': 'four\n' }, 'TPT4 Feature four');
  assert.equal((await verifyTaskCompletion(args4)).ready, true);
  f.git(f.root, ['merge', '-q', '--ff-only', 'task/TPT4']);
  check = await verifyTaskCompletion(args4);
  assert.equal(check.ready, true, 'an already-merged task commit still counts');
  assert.deepEqual(check.repositories.at(-1).branches, [{ branch: 'task/TPT4', ahead: 0 }]);
});

test('verifyTaskCompletion, commits on + worktrees off: needs a key-prefixed commit reachable from a main checkout', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const b = guardBackend({ ...COMMIT_ON, vcs_worktree_enabled: 0 });
  const args = { backend: b, projectRoot: f.root, taskId: 'TPT1', resolution: 'Changed the nested server. Checks passed. Follow-ups: none.' };
  let check = await verifyTaskCompletion(args);
  assert.deepEqual(codes(check), ['TASK_COMMIT_MISSING'], 'unmerged task branches do not count with worktrees off');
  assert.match(check.blockers[0].message, /starting with TPT1/);
  const refused = await completeVerifiedTask(args);
  assert.equal(refused.completed, false);
  assert.deepEqual(codes(refused.verification), ['TASK_COMMIT_MISSING']);
  assert.deepEqual(b.calls, [], 'a refused completion writes nothing');

  fx.commit(f.git, f.root, { 'src/ten.js': 'ten\n' }, 'TPT10: Another task');
  fx.commit(f.git, f.root, { 'docs.md': 'notes\n' }, 'Docs refresh\n\nTPT1 follow-up notes');
  assert.deepEqual(codes(await verifyTaskCompletion(args)), ['TASK_COMMIT_MISSING'], 'neither TPT10 nor a body-only mention is a TPT1 commit');

  const sha = fx.commit(f.git, f.nested, { 'src/fix1.js': 'fix\n' }, 'TPT1: Fix the nested server');
  fs.appendFileSync(path.join(f.root, 'README.md'), 'unrelated root edit\n');
  fs.appendFileSync(path.join(f.nested, 'README.md'), 'unrelated nested edit\n');
  check = await verifyTaskCompletion(args);
  assert.equal(check.ready, true, JSON.stringify(check.blockers));
  assert.deepEqual(check.repositories.map(r => r.taskCommit), [sha, null]);
  const done = await completeVerifiedTask(args);
  assert.equal(done.completed, true);
  assert.deepEqual(b.calls.map(c => c[0]), ['comment', 'update']);
});

test('commit verification: commits off and the terminal monitor run no git; failed git reads cannot pass', async () => {
  const mustNotRun = () => { throw new Error('git must not run'); };
  const off = guardBackend({ ...COMMIT_ON, vcs_commit_enabled: 0 });
  const offCheck = await verifyTaskCompletion({ backend: off, projectRoot: '/missing', taskId: 'TPT1', git: mustNotRun });
  assert.equal(offCheck.ready, true, JSON.stringify(offCheck.blockers));
  assert.deepEqual(offCheck.blockers, []);
  const b = guardBackend();
  const gate = await guardCompletionTransition({ session: { taskId: 'TPT1' }, backend: b, projectRoot: '/missing', git: mustNotRun });
  assert.equal(gate.allowed, true, 'the completion monitor verifies automatic merge only');
  assert.deepEqual(b.calls, []);
  for (const projectRoot of [undefined, '/missing']) {
    const failed = await verifyTaskCompletion({ backend: b, projectRoot, taskId: 'TPT1', git: async () => ({ status: 128 }) });
    assert.equal(failed.ready, false);
    assert.deepEqual(failed.blockers, [{ code: 'git_verification_failed' }]);
  }
});

// TPT576 — completion must never drop the agent's report: an already-completed task (merge
// hand-off or re-run session) still gets it, an exact repeat is not posted twice, and an
// unreadable comment list errs toward posting.
test('completeVerifiedTask: the report survives an already-completed task and is never posted twice', async () => {
  const mustNotRun = () => { throw new Error('git must not run'); };
  const b = guardBackend({ ...COMMIT_ON, vcs_commit_enabled: 0 });
  const posted = [];
  b.getTaskComments = async () => posted.map(content => ({ content, type: 'resolution' }));
  const record = b.createTaskComment;
  b.createTaskComment = async (id, content, type) => { posted.push(content); return record(id, content, type); };
  const resolution = 'Resolved the merge conflict in the hand-off session. Checks passed. Follow-ups: none.';
  const args = { backend: b, projectRoot: '/missing', taskId: 'TPT1', git: mustNotRun };
  await b.updateTask('TPT1', { status: 'completed' });
  b.calls.length = 0;

  let done = await completeVerifiedTask({ ...args, resolution });
  assert.equal(done.completed, true);
  assert.equal(done.resolutionPosted, true);
  assert.deepEqual(b.calls.map(c => c.slice(0, 4)), [['comment', 'TPT1', resolution, 'resolution']], 'report posted, no second status write');

  done = await completeVerifiedTask({ ...args, resolution: `  ${resolution}\n` });
  assert.equal(done.completed, true);
  assert.equal(done.resolutionPosted, false, 'an exact repeat is not posted again');
  assert.equal(b.calls.length, 1);

  b.getTaskComments = async () => { throw new Error('comments offline'); };
  done = await completeVerifiedTask({ ...args, resolution });
  assert.equal(done.resolutionPosted, true, 'an unreadable comment list never drops the report');
  assert.deepEqual(b.calls.map(c => c[0]), ['comment', 'comment']);
});

test('completeVerifiedTask: a refused completion writes nothing and reports resolutionPosted:false', async () => {
  const b = guardBackend();
  b.getProjectSettings = async () => { throw new Error('settings offline'); };
  const refused = await completeVerifiedTask({ backend: b, projectRoot: '/missing', taskId: 'TPT1', resolution: 'Done. Checks passed. Follow-ups: none.' });
  assert.equal(refused.completed, false);
  assert.equal(refused.resolutionPosted, false);
  assert.equal(refused.verification.ready, false);
  assert.deepEqual(b.calls, []);
});
