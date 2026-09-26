'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fx = require('./test-fixture');
const { checkCompletedTaskWorktrees, warnIfCompletedWorktreeDirty } = require('./completion-guard');

fx.applyFixtureEnvToProcess();

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
