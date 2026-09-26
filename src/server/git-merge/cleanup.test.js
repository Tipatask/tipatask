'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('./test-fixture');
const { scanProject } = require('./repo-discovery');
const { applyPreflight } = require('./preflight');
const { buildPlan } = require('./merge-plan');
const { MergeJob } = require('./merge-job');
const { cleanupProject } = require('./cleanup');

fx.applyFixtureEnvToProcess();

test('cleanup after a merge: worktrees removed nested-first, merged branches deleted, unmerged branch kept and reported, prune leaves only main checkouts', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const sel = [{ repoId: 'ai/todo/server', branch: 'task/TPT1' }, { repoId: 'root', branch: 'task/TPT1' }, { repoId: 'root', branch: 'task/TPT2' }];
  const scan = applyPreflight(await scanProject(f.root), { tasksByKey: f.tasksByKey, roles: f.roles });
  const job = new MergeJob({ projectRoot: f.root, repos: scan.repos, plan: buildPlan({ repos: scan.repos, selections: sel, checks: {} }), tasksByKey: f.tasksByKey });
  job.start(); await new Promise(r => job.once('done', r));
  assert.equal(job.state, 'done');
  // root TPT3 is NOT merged but we ask to clean it too → branch -d must refuse
  const scan2 = applyPreflight(await scanProject(f.root), { tasksByKey: f.tasksByKey, roles: f.roles });
  const res = await cleanupProject({ repos: scan2.repos, selections: [...sel, { repoId: 'root', branch: 'task/TPT3' }] });
  assert.deepEqual(res.repos.map(r => r.repoId), ['ai/todo/server', 'root'], 'nested first');
  assert.deepEqual(res.repos[0].deletedBranches, ['task/TPT1']);
  assert.deepEqual(res.repos[1].deletedBranches, ['task/TPT1', 'task/TPT2']);
  assert.equal(res.repos[1].failures.length, 1);
  assert.equal(res.repos[1].failures[0].branch, 'task/TPT3');
  assert.equal(res.repos[1].failures[0].notMerged, true);
  assert.ok(!fs.existsSync(path.join(f.root, '.worktrees', 'TPT1')));
  assert.ok(!fs.existsSync(path.join(f.root, '.worktrees', 'TPT2')));
  assert.ok(!fs.existsSync(path.join(f.nested, '.worktrees', 'TPT1')));
  assert.ok(fs.existsSync(path.join(f.nested, '.worktrees', 'TPT2')), 'unselected nested worktree untouched');
  assert.equal(f.git(f.root, ['worktree', 'list', '--porcelain']).split('\n\n').length, 1, 'root: only the main checkout');
  assert.match(f.git(f.root, ['branch', '--list', 'task/*']), /task\/TPT3/);
  assert.doesNotMatch(f.git(f.root, ['branch', '--list', 'task/*']), /TPT1|TPT2/);
});

test('cleanup --force fallback: a root worktree holding an untracked nested checkout dir', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const wt = path.join(f.root, '.worktrees', 'TPT1');
  // simulate an agent that placed the nested worktree INSIDE the root worktree
  f.git(f.nested, ['worktree', 'add', '-q', path.join(wt, f.nestedRel), '-b', 'task/TPT1-inner', 'HEAD']);
  f.git(f.root, ['merge', '-q', '--no-ff', '--no-edit', 'task/TPT1']);
  // nested worktree must go first, else root refuses even with --force in some git versions
  f.git(f.nested, ['worktree', 'remove', '--force', path.join(wt, f.nestedRel)]);
  fs.mkdirSync(path.join(wt, 'stray'), { recursive: true }); fs.writeFileSync(path.join(wt, 'stray', 'x'), 'x');
  const scan = applyPreflight(await scanProject(f.root), { tasksByKey: f.tasksByKey, roles: f.roles });
  const res = await cleanupProject({ repos: scan.repos, selections: [{ repoId: 'root', branch: 'task/TPT1' }] });
  assert.equal(res.repos[0].removedWorktrees[0].forced, true);
  assert.deepEqual(res.repos[0].deletedBranches, ['task/TPT1']);
  assert.ok(!fs.existsSync(wt));
});
