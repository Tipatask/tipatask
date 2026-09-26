'use strict';

// C1345 — coverage for git-worktree.js, missing since C1215 first shipped this file.
// Read-only throughout: no git init, no writes, no worktree creation. The
// getGitWorktreeStatus() checks below are the exact verification C1345's own task
// description names ("verify tool returns {available:false} on a non-git project").

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getGitWorktreeStatus, parseWorktreePorcelain, parseStatusPorcelain, parseGitlinks, parseAheadBehind, parseStatusPorcelainPaths } = require('./git-worktree');

// This checkout's root (has its own .git when cloned — absent in a tarball/CI export, so
// the live-checkout tests below self-skip).
const REPO_ROOT = path.resolve(__dirname, '../..');

test('parseWorktreePorcelain: main + linked worktree with branch', () => {
  const out = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.worktrees/C1345',
    'HEAD def456',
    'branch refs/heads/task/C1345',
    '',
  ].join('\n');
  const wts = parseWorktreePorcelain(out);
  assert.equal(wts.length, 2);
  assert.deepEqual(wts[0], { path: '/repo', head: 'abc123', branch: 'refs/heads/main' });
  assert.deepEqual(wts[1], { path: '/repo/.worktrees/C1345', head: 'def456', branch: 'refs/heads/task/C1345' });
});

test('parseWorktreePorcelain: detached and bare flags', () => {
  const out = [
    'worktree /repo/detached-wt',
    'HEAD abc123',
    'detached',
    '',
    'worktree /repo.git',
    'bare',
    '',
  ].join('\n');
  const wts = parseWorktreePorcelain(out);
  assert.equal(wts[0].detached, true);
  assert.equal(wts[0].branch, undefined);
  assert.equal(wts[1].bare, true);
});

test('parseWorktreePorcelain: bare-key locked/prunable (true) vs valued locked/prunable (string reason)', () => {
  const out = [
    'worktree /repo/wt1',
    'HEAD abc123',
    'locked',
    'prunable',
    '',
    'worktree /repo/wt2',
    'HEAD def456',
    'locked reason for lock',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');
  const wts = parseWorktreePorcelain(out);
  assert.equal(wts[0].locked, true);
  assert.equal(wts[0].prunable, true);
  assert.equal(wts[1].locked, 'reason for lock');
  assert.equal(wts[1].prunable, 'gitdir file points to non-existent location');
});

test('parseWorktreePorcelain: no trailing blank line still lands the final record', () => {
  const out = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main';
  const wts = parseWorktreePorcelain(out);
  assert.equal(wts.length, 1);
  assert.equal(wts[0].path, '/repo');
});

test('parseWorktreePorcelain: empty output -> empty array', () => {
  assert.deepEqual(parseWorktreePorcelain(''), []);
});

test('parseStatusPorcelain: branch header + N changed lines', () => {
  const out = [
    '## master...origin/master [ahead 1]',
    ' M src/foo.js',
    '?? src/bar.js',
    'A  src/baz.js',
  ].join('\n');
  const { branchLine, dirtyFileCount } = parseStatusPorcelain(out);
  assert.equal(branchLine, 'master...origin/master [ahead 1]');
  assert.equal(dirtyFileCount, 3);
});

test('parseStatusPorcelain: header only -> zero dirty files', () => {
  const { branchLine, dirtyFileCount } = parseStatusPorcelain('## main');
  assert.equal(branchLine, 'main');
  assert.equal(dirtyFileCount, 0);
});

test('parseStatusPorcelain: no header -> empty branchLine', () => {
  const { branchLine, dirtyFileCount } = parseStatusPorcelain(' M src/foo.js\n?? src/bar.js');
  assert.equal(branchLine, '');
  assert.equal(dirtyFileCount, 2);
});

test('getGitWorktreeStatus: empty/null/undefined project root -> unavailable, reason names missing root', () => {
  for (const root of ['', null, undefined]) {
    const result = getGitWorktreeStatus(root);
    assert.equal(result.available, false);
    assert.match(result.reason, /no project root/);
  }
});

test('getGitWorktreeStatus: non-git directory -> {available:false} (C1345 verification)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-git-worktree-test-'));
  try {
    const result = getGitWorktreeStatus(scratch);
    assert.equal(result.available, false);
    assert.match(result.reason, /Not a git checkout/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('getGitWorktreeStatus: real git checkout (repo root) -> available with parsed fields', { skip: !fs.existsSync(path.join(REPO_ROOT, '.git')) }, () => {
  const result = getGitWorktreeStatus(REPO_ROOT);
  assert.equal(result.available, true);
  assert.equal(typeof result.currentBranch === 'string' || result.currentBranch === null, true);
  assert.equal(typeof result.dirtyFileCount, 'number');
  assert.ok(Array.isArray(result.worktrees));
  assert.ok(result.worktrees.length >= 1);
});

// TPT345 — shared parsers added for the merge flow (src/server/git-merge/).
test('parseGitlinks: only mode-160000 rows, tab-separated path', () => {
  const out = ['100644 aaaa 0\tREADME.md', '160000 bbbb 0\tai/todo/server', '160000 cccc 0\tvendor/with space', ''].join('\n');
  assert.deepEqual(parseGitlinks(out), [{ sha: 'bbbb', path: 'ai/todo/server' }, { sha: 'cccc', path: 'vendor/with space' }]);
  assert.deepEqual(parseGitlinks(''), []);
});

test('parseAheadBehind: left = behind, right = ahead', () => {
  assert.deepEqual(parseAheadBehind('3\t5\n'), { behind: 3, ahead: 5 });
  assert.deepEqual(parseAheadBehind('garbage'), { behind: null, ahead: null });
});

test('parseStatusPorcelainPaths: rename keeps the new path, untracked included, header skipped', () => {
  const out = ['## master...origin/master', ' M src/a.js', 'R  old.js -> new.js', '?? untracked.txt', 'A  "quoted name.md"'].join('\n');
  assert.deepEqual(parseStatusPorcelainPaths(out), [
    { status: ' M', path: 'src/a.js' }, { status: 'R ', path: 'new.js' }, { status: '??', path: 'untracked.txt' }, { status: 'A ', path: 'quoted name.md' },
  ]);
});

test('getGitWorktreeStatus: nested repos + ahead/behind + taskKey on this checkout (read-only)', { skip: !fs.existsSync(path.join(REPO_ROOT, '.git')) }, () => {
  const result = getGitWorktreeStatus(REPO_ROOT);
  assert.equal(result.available, true);
  assert.ok(Array.isArray(result.nested));
  // A standalone clone has no gitlinks of its own; when a nested checkout does exist it is
  // reported one level deep only.
  for (const nested of result.nested) {
    assert.equal(typeof nested.relPath, 'string');
    assert.equal(nested.nested, undefined, 'one level only');
  }
  for (const wt of result.worktrees) {
    if (wt.branch && /^refs\/heads\/task\//.test(wt.branch)) { assert.match(wt.taskKey, /^[A-Z]+\d+$/); assert.equal(typeof wt.ahead, 'number'); }
  }
  const flat = getGitWorktreeStatus(REPO_ROOT, { nested: false, aheadBehind: false });
  assert.equal(flat.nested, undefined);
  assert.ok(flat.worktrees.every(wt => wt.ahead === undefined));
});
