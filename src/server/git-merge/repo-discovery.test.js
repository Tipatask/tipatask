'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fx = require('./test-fixture');
const { discoverRepos, scanProject, findTaskWorktrees, executionOrder, detectChecks } = require('./repo-discovery');

fx.applyFixtureEnvToProcess();

test('discoverRepos: root + nested via gitlink, no .gitmodules needed', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const repos = await discoverRepos(f.root);
  assert.deepEqual(repos.map(r => r.id), ['root', 'ai/todo/server']);
  assert.equal(repos[1].kind, 'nested');
  assert.equal(repos[1].parentId, 'root');
  assert.equal(repos[1].relToParent, 'ai/todo/server');
  assert.match(repos[1].gitlinkSha, /^[0-9a-f]{40}$/);
});

test('scanProject: task branches (incl. branch without worktree), ahead/behind, touched files, dirty worktree, gitlink drift', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  fs.writeFileSync(path.join(f.nested, '.worktrees', 'TPT2', 'src', 'extra.js'), 'dirty\n');
  f.git(f.nested, ['commit', '-q', '--allow-empty', '-m', 'move nested HEAD']);
  const scan = await scanProject(f.root);
  assert.equal(scan.git.mergeTreeSupported, fx.gitProbe().mergeTree);
  const root = scan.repos.find(r => r.id === 'root');
  const nested = scan.repos.find(r => r.id === 'ai/todo/server');
  assert.equal(root.currentBranch, 'master');
  assert.deepEqual(root.taskBranches.map(b => b.branch), ['task/TPT1', 'task/TPT2', 'task/TPT3']);
  assert.deepEqual(nested.taskBranches.map(b => b.branch), ['task/TPT1', 'task/TPT2', 'task/TPT3']);
  assert.equal(nested.taskBranches[2].worktree, null, 'branch-only task has no worktree');
  assert.ok(nested.taskBranches[0].worktree.path.endsWith('/.worktrees/TPT1'));
  assert.equal(nested.taskBranches[0].ahead, 1);
  assert.equal(nested.taskBranches[0].behind, 1, 'the empty commit moved master ahead of the branch');
  assert.deepEqual(root.taskBranches[1].touchedFiles.sort(), ['ai/architecture/kb.md', 'src/feature2.js']);
  assert.equal(nested.taskBranches[1].worktree.dirty, true);
  assert.deepEqual(nested.taskBranches[1].worktree.dirtyFiles.map(d => d.path), ['src/extra.js']);
  assert.deepEqual(root.dirtyFiles, [], 'a moved nested HEAD is drift, not a dirty file');
  assert.deepEqual(root.gitlinkDrift.map(d => d.relPath), ['ai/todo/server']);
  assert.deepEqual(root.checks, { test: null, build: null });
});

test('scanProject: explicit target branch changes ahead/behind + targetSwitchFiles; missing target flagged', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const scan = await scanProject(f.root, { targets: { root: { branch: 'task/TPT2' }, 'ai/todo/server': { branch: 'nope' } } });
  const root = scan.repos.find(r => r.id === 'root');
  assert.equal(root.target, 'task/TPT2');
  assert.equal(root.taskBranches.find(b => b.branch === 'task/TPT2').ahead, 0);
  assert.ok(root.targetSwitchFiles.includes('ai/architecture/kb.md'));
  assert.equal(scan.repos.find(r => r.id === 'ai/todo/server').targetMissing, true);
});

test('findTaskWorktrees: both repos, dirty count', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  fs.writeFileSync(path.join(f.root, '.worktrees', 'TPT1', 'x.txt'), 'x');
  const found = await findTaskWorktrees(f.root, 'TPT1');
  assert.deepEqual(found.map(w => [w.repoId, w.dirtyFileCount]), [['root', 1], ['ai/todo/server', 0]]);
});

test('findTaskWorktrees: root-only worktree for TPT3', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const found = await findTaskWorktrees(f.root, 'TPT3');
  assert.deepEqual(found.map(w => w.repoId), ['root']);
});

test('non-git directory: discoverRepos returns just the root entry, scan degrades', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-merge-nongit-'));
  try {
    const repos = await discoverRepos(dir);
    assert.equal(repos.length, 1);
    const scan = await scanProject(dir);
    assert.equal(scan.repos[0].currentBranch, null);
    assert.deepEqual(scan.repos[0].taskBranches, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('executionOrder: deepest first, root last; detectChecks reads package.json scripts', () => {
  const repos = [{ id: 'root', depth: 0, relPath: '' }, { id: 'a', depth: 1, relPath: 'a' }, { id: 'a/b', depth: 2, relPath: 'a/b' }, { id: 'c', depth: 1, relPath: 'c' }];
  assert.deepEqual(executionOrder(repos).map(r => r.id), ['a/b', 'a', 'c', 'root']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-merge-pkg-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'node build.js' } }));
    assert.deepEqual(detectChecks(dir), { test: 'npm test', build: 'npm run build' });
    assert.deepEqual(detectChecks(path.join(dir, 'missing')), { test: null, build: null });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
