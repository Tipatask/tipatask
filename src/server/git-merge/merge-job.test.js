'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('./test-fixture');
const { scanProject } = require('./repo-discovery');
const { applyPreflight } = require('./preflight');
const { buildPlan } = require('./merge-plan');
const { MergeJob, startJob, getJob, clearJob, STATES } = require('./merge-job');

fx.applyFixtureEnvToProcess();
const NO_CHECKS = { test: false, build: false, baseline: false };

async function prepare(f, sel, { checks = NO_CHECKS } = {}) {
  const scan = applyPreflight(await scanProject(f.root), { tasksByKey: f.tasksByKey, roles: f.roles });
  const plan = buildPlan({ repos: scan.repos, selections: sel, checks });
  return { scan, plan };
}
function untilEvent(job) { return new Promise(r => { job.once('conflict', r); job.once('done', r); }); }

test('conflict-free run: nested first in key order, gitlink bump, root merges, no gitlink conflict, --no-ff, no attribution', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const sel = [{ repoId: 'ai/todo/server', branch: 'task/TPT2' }, { repoId: 'ai/todo/server', branch: 'task/TPT1' }, { repoId: 'root', branch: 'task/TPT1' }, { repoId: 'root', branch: 'task/TPT2' }];
  const { scan, plan } = await prepare(f, sel);
  const job = new MergeJob({ projectRoot: f.root, repos: scan.repos, plan, tasksByKey: f.tasksByKey });
  const order = [];
  job.on('progress', p => { if (p.step && p.step.status === 'done') order.push(`${p.step.kind}:${p.step.repoId}:${p.step.branch || ''}`); });
  job.start();
  const done = await untilEvent(job);
  assert.equal(job.state, STATES.DONE);
  assert.equal(done.ok, true);
  assert.deepEqual(order, ['merge:ai/todo/server:task/TPT1', 'merge:ai/todo/server:task/TPT2', 'gitlink-bump:root:', 'merge:root:task/TPT1', 'merge:root:task/TPT2', 'verify-gitlinks:root:']);
  assert.deepEqual(job.merged, { 'ai/todo/server': ['TPT1', 'TPT2'], root: ['TPT1', 'TPT2'] });
  assert.deepEqual(job.caveats, []);
  const nestedHead = f.git(f.nested, ['rev-parse', 'HEAD']);
  assert.match(f.git(f.root, ['ls-files', '-s', '--', f.nestedRel]), new RegExp(`^160000 ${nestedHead}`));
  const log = f.git(f.root, ['log', '--format=%p|%s|%b']).split('\n');
  const merges = log.filter(l => l.includes('|Merge task/'));
  assert.equal(merges.length, 2);
  assert.ok(merges.every(l => l.split('|')[0].split(' ').length === 2), 'every merge commit has two parents (--no-ff)');
  assert.ok(!log.some(l => /Co-Authored-By|Generated with/i.test(l)));
  assert.match(log.find(l => l.includes('Bump ai/todo/server')), /merged TPT1, TPT2/);
  assert.equal(f.git(f.root, ['status', '--porcelain', '--ignore-submodules=dirty']), '', 'root clean after run');
});

test('gitlink-only conflict is auto-resolved to the merged nested HEAD; file conflict stops with hand-off; resume finishes', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const wt2 = path.join(f.root, '.worktrees', 'TPT2');
  f.git(wt2, ['update-index', '--cacheinfo', `160000,${f.nestedHeads.TPT3},${f.nestedRel}`]);
  f.git(wt2, ['commit', '-q', '-m', 'TPT2 point gitlink elsewhere']);
  const sel = [{ repoId: 'ai/todo/server', branch: 'task/TPT1' }, { repoId: 'root', branch: 'task/TPT2' }, { repoId: 'root', branch: 'task/TPT3' }];
  const { scan, plan } = await prepare(f, sel);
  const job = new MergeJob({ projectRoot: f.root, repos: scan.repos, plan, tasksByKey: f.tasksByKey, options: { commitEnabled: true } });
  job.start();
  const ev = await untilEvent(job);
  assert.equal(job.state, STATES.CONFLICT);
  const tpt2 = job.steps.find(s => s.kind === 'merge' && s.branch === 'task/TPT2');
  assert.equal(tpt2.status, 'done');
  assert.deepEqual(tpt2.gitlinkResolved.map(g => g.relPath), ['ai/todo/server']);
  assert.equal(tpt2.gitlinkResolved[0].sha, f.git(f.nested, ['rev-parse', 'HEAD']));
  assert.equal(job.caveats.length, 1);
  const c = ev.conflict;
  assert.equal(c.repoId, 'root'); assert.equal(c.branch, 'task/TPT3'); assert.equal(c.taskKey, 'TPT3');
  assert.deepEqual(c.conflictedPaths, ['ai/architecture/kb.md']);
  assert.equal(c.commitRange, 'master..task/TPT3');
  assert.deepEqual(c.priorTasks.map(p => p.key), ['TPT2'], 'TPT2 also touched kb.md');
  assert.match(c.handoffPrompt, /Feature three/); assert.match(c.handoffPrompt, /Feature two/);
  assert.match(c.handoffPrompt, /rewrites the kb\.md intro/);
  assert.ok(!c.handoffPrompt.split('\n').some(l => /\?\s*$/.test(l)), 'echo-safe: no line ends with ?');
  assert.ok(c.manualCommands.some(l => l.includes('git commit --no-edit')));
  // commit flag on: the hand-off tells the agent to stage and commit the prepared merge message.
  assert.match(c.handoffPrompt, /git add the resolved files, then run git commit --no-edit/);
  assert.doesNotMatch(c.handoffPrompt, /Commit permission is disabled/);
  assert.equal(f.git(f.root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).length, 40, 'repo left mid-merge');
  assert.equal(job.toJSON().steps[c.stepIndex].status, 'failed');
  // resume while still conflicted → STILL_CONFLICTED
  await assert.rejects(job.resume(), (e) => e.code === 'STILL_CONFLICTED' && e.details.conflictedPaths.includes('ai/architecture/kb.md'));
  // resolve by hand and resume
  fs.writeFileSync(path.join(f.root, 'ai/architecture/kb.md'), 'line one (both)\nline two\n');
  f.git(f.root, ['add', 'ai/architecture/kb.md']);
  const doneP = untilEvent(job);
  await job.resume();
  const done = await doneP;
  assert.equal(job.state, STATES.DONE); assert.equal(done.ok, true);
  assert.deepEqual(job.merged.root, ['TPT2', 'TPT3']);
  assert.match(f.git(f.root, ['log', '-1', '--format=%p %s']), /^\w+ \w+ Merge task\/TPT3: Feature three$/);
  assert.equal(job.conflict, null);
  assert.equal(job.toJSON().error, null);
});

test('conflict hand-off follows the commit flag: off (or unset) never tells the agent to git add/commit; manual commands for the user stay', async (t) => {
  if (fx.skipUnless(t)) return;
  for (const options of [{ commitEnabled: false }, {}]) {
    const f = fx.buildFixture(t);
    const sel = [{ repoId: 'root', branch: 'task/TPT2' }, { repoId: 'root', branch: 'task/TPT3' }];
    const { scan, plan } = await prepare(f, sel);
    const job = new MergeJob({ projectRoot: f.root, repos: scan.repos, plan, tasksByKey: f.tasksByKey, options });
    job.start(); const ev = await untilEvent(job);
    assert.equal(job.state, STATES.CONFLICT);
    const prompt = ev.conflict.handoffPrompt;
    assert.match(prompt, /Commit permission is disabled for this project: do not run git add or git commit/);
    assert.doesNotMatch(prompt, /git add the resolved files/);
    assert.doesNotMatch(prompt, /then run git commit --no-edit/);
    assert.match(prompt, /the user stages them/);
    assert.ok(!prompt.split('\n').some(l => /\?\s*$/.test(l)), 'echo-safe: no line ends with ?');
    assert.ok(ev.conflict.manualCommands.some(l => l.includes('git commit --no-edit')), 'the human command list is unchanged');
    await job.abort();
  }
});

test('resume accepts a merge the agent already committed (no MERGE_HEAD, HEAD^2 == branch)', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const sel = [{ repoId: 'root', branch: 'task/TPT2' }, { repoId: 'root', branch: 'task/TPT3' }];
  const { scan, plan } = await prepare(f, sel);
  const job = new MergeJob({ projectRoot: f.root, repos: scan.repos, plan, tasksByKey: f.tasksByKey });
  job.start(); await untilEvent(job);
  assert.equal(job.state, STATES.CONFLICT);
  fs.writeFileSync(path.join(f.root, 'ai/architecture/kb.md'), 'resolved\n');
  f.git(f.root, ['add', '-A']); f.git(f.root, ['commit', '-q', '--no-edit']);
  const doneP = untilEvent(job);
  await job.resume(); await doneP;
  assert.equal(job.state, STATES.DONE);
});

test('abort during a conflict runs merge --abort; earlier merges stay', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const sel = [{ repoId: 'root', branch: 'task/TPT2' }, { repoId: 'root', branch: 'task/TPT3' }];
  const { scan, plan } = await prepare(f, sel);
  const job = new MergeJob({ projectRoot: f.root, repos: scan.repos, plan, tasksByKey: f.tasksByKey });
  job.start(); await untilEvent(job);
  const state = await job.abort();
  assert.equal(state, STATES.ABORTED);
  assert.throws(() => f.git(f.root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }), 'MERGE_HEAD gone');
  assert.deepEqual(job.merged.root, ['TPT2']);
  assert.match(f.git(f.root, ['log', '-1', '--format=%s']), /Merge task\/TPT2/);
  assert.equal(f.git(f.root, ['status', '--porcelain']), '');
});

test('refuses to start a merge step in a repo already mid-merge; dirty-overlap refusal is a failure, not a conflict', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  // put root mid-merge by hand
  try { f.git(f.root, ['merge', '--no-commit', '--no-ff', 'task/TPT2'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* fine */ }
  const sel = [{ repoId: 'root', branch: 'task/TPT3' }];
  const { scan, plan } = await prepare(f, sel);
  const job = new MergeJob({ projectRoot: f.root, repos: scan.repos, plan, tasksByKey: f.tasksByKey });
  job.start(); const ev = await untilEvent(job);
  assert.equal(job.state, STATES.FAILED);
  assert.equal(job.toJSON().errorCode, 'REPO_MID_MERGE');
  assert.equal(typeof ev.error, 'string');
  f.git(f.root, ['merge', '--abort']);
  // dirty overlap: uncommitted change to a file the branch touches
  fs.writeFileSync(path.join(f.root, 'src/feature3.js'), 'local\n');
  const again = await prepare(f, sel);
  const job2 = new MergeJob({ projectRoot: f.root, repos: again.scan.repos, plan: again.plan, tasksByKey: f.tasksByKey });
  job2.start(); await untilEvent(job2);
  assert.equal(job2.state, STATES.FAILED);
  assert.equal(job2.toJSON().errorCode, 'MERGE_REFUSED');
  assert.throws(() => f.git(f.root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }));
});

test('startJob is single-flight per project', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const sel = [{ repoId: 'root', branch: 'task/TPT2' }, { repoId: 'root', branch: 'task/TPT3' }];
  const { scan, plan } = await prepare(f, sel);
  const job = startJob(f.root, { repos: scan.repos, plan, tasksByKey: f.tasksByKey });
  t.after(() => clearJob(f.root));
  assert.equal(getJob(f.root), job);
  assert.throws(() => startJob(f.root, { repos: scan.repos, plan, tasksByKey: f.tasksByKey }), (e) => e.code === 'JOB_RUNNING');
  await untilEvent(job);
  assert.equal(job.state, STATES.CONFLICT);
  assert.throws(() => startJob(f.root, { repos: scan.repos, plan, tasksByKey: f.tasksByKey }), (e) => e.code === 'JOB_RUNNING', 'a conflict-paused job still counts as running');
  await job.abort();
  const next = startJob(f.root, { repos: scan.repos, plan: [], tasksByKey: f.tasksByKey });
  await untilEvent(next);
  assert.equal(next.state, STATES.DONE);
});

test('checks steps: baseline + post run through the injected runner; new failures block', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  fs.writeFileSync(path.join(f.nested, 'package.json'), JSON.stringify({ name: 'nested', scripts: { test: 'x' } }));
  f.git(f.nested, ['commit', '-q', '-am', 'scripts']);
  const sel = [{ repoId: 'ai/todo/server', branch: 'task/TPT1' }];
  const { scan, plan } = await prepare(f, sel, { checks: { test: true, build: false, baseline: true } });
  assert.deepEqual(plan.map(s => s.kind), ['baseline', 'merge', 'gitlink-bump', 'verify-gitlinks', 'checks']);
  let phase = 0;
  const checksRunner = async ({ repo, enabled }) => {
    assert.equal(repo.id, 'ai/todo/server'); assert.equal(enabled.test, true);
    phase++;
    return { test: { status: 1, timedOut: false, failures: phase === 1 ? ['flaky'] : ['flaky', 'fresh'], hasTap: true, output: '' }, build: null };
  };
  const job = new MergeJob({ projectRoot: f.root, repos: scan.repos, plan, tasksByKey: f.tasksByKey, checksRunner, nodeResolver: async () => ({ node: 'node', binDir: '', npmCli: null }) });
  job.start(); const done = await untilEvent(job);
  assert.equal(job.state, STATES.DONE);
  assert.equal(done.ok, false, 'new failure → not ok');
  const rep = job.checks['ai/todo/server'];
  assert.deepEqual(rep.test.newFailures, ['fresh']); assert.deepEqual(rep.test.preExisting, ['flaky']); assert.equal(rep.blocking, true);
  assert.deepEqual(job.baseline['ai/todo/server'].test.failures, ['flaky']);
});
