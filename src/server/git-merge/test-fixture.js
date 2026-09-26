'use strict';

// TPT345 — test-only builder of temp git repositories shaped like this project: a root
// repo recording a nested repo as a gitlink (mode 160000, no .gitmodules), each with
// `task/<KEY>` branches + `.worktrees/<KEY>` worktrees, plus one planted conflict. Every
// git call is real (execFileSync) with an isolated config so the developer's global
// config, hooks and signing never leak in. Not shipped: required only from *.test.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const NESTED_REL = 'ai/todo/server';

function fixtureEnv(home) {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    LC_ALL: 'C',
  };
}

let _probe = null;
function gitProbe() {
  if (_probe) return _probe;
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) { _probe = { ok: false, version: null, mergeTree: false, reason: 'git not found' }; return _probe; }
  const m = /(\d+)\.(\d+)/.exec(r.stdout || '');
  const major = m ? Number(m[1]) : 0; const minor = m ? Number(m[2]) : 0;
  _probe = { ok: true, version: m ? `${major}.${minor}` : r.stdout.trim(), mergeTree: major > 2 || (major === 2 && minor >= 38), reason: null };
  return _probe;
}

// t.skip()s when the requirement is unmet; returns true when skipped.
function skipUnless(t, need = 'git') {
  const p = gitProbe();
  if (process.platform === 'win32') { t.skip('worktree fixtures are POSIX-only'); return true; }
  if (!p.ok) { t.skip(p.reason); return true; }
  if (need === 'merge-tree' && !p.mergeTree) { t.skip(`git ${p.version} lacks merge-tree --write-tree`); return true; }
  return false;
}

function makeGit(home) {
  const env = fixtureEnv(home);
  return (cwd, args, opts = {}) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).replace(/\n$/, '');
}

function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function initRepo(git, dir, { branch = 'master', files = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', branch]);
  git(dir, ['config', 'user.name', 'Fixture']);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.hooksPath', os.devNull]);
  write(dir, { '.gitignore': '/.worktrees/\n', 'README.md': `# ${path.basename(dir)}\n`, ...files });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function commit(git, dir, files, message) {
  write(dir, files);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

// Creates task/<key> (optionally in a .worktrees/<key> worktree) from the repo's HEAD
// and commits `files` on it as "<key> <title>". Returns the branch head sha.
function addTaskBranch(git, dir, key, files, { title = `Task ${key}`, worktree = true, suffix = '' } = {}) {
  const branch = `task/${key}${suffix ? `-${suffix}` : ''}`;
  if (worktree) {
    const wt = path.join(dir, '.worktrees', key + (suffix ? `-${suffix}` : ''));
    git(dir, ['worktree', 'add', '-q', wt, '-b', branch, 'HEAD']);
    return commit(git, wt, files, `${key} ${title}`);
  }
  git(dir, ['branch', branch, 'HEAD']);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-fixture-tmpwt-'));
  fs.rmSync(tmp, { recursive: true, force: true });
  git(dir, ['worktree', 'add', '-q', tmp, branch]);
  const sha = commit(git, tmp, files, `${key} ${title}`);
  git(dir, ['worktree', 'remove', '--force', tmp]);
  return sha;
}

function recordGitlink(git, root, rel, sha, message) {
  fs.mkdirSync(path.join(root, rel), { recursive: true });
  git(root, ['update-index', '--add', '--cacheinfo', `160000,${sha},${rel}`]);
  git(root, ['commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

// Root + nested (at <root>/ai/todo/server) with:
//   nested: task/TPT1 (worktree), task/TPT2 (worktree), task/TPT3 (branch only)
//   root:   task/TPT1 (worktree; also bumps the gitlink to nested task/TPT1's head),
//           task/TPT2 (worktree), task/TPT3 (worktree) — TPT2 and TPT3 both rewrite line
//           1 of ai/architecture/kb.md → planted conflict.
// tasks: TPT1..TPT3 rows (all completed unless overridden).
function buildFixture(t, { tasks: taskOverrides = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-merge-fixture-'));
  const root = path.join(home, 'project');
  const nested = path.join(root, NESTED_REL);
  const git = makeGit(home);
  if (t && typeof t.after === 'function') t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  initRepo(git, root, { files: { 'ai/architecture/kb.md': 'line one\nline two\n', 'src/app.js': 'module.exports = 1;\n' } });
  initRepo(git, nested, { files: { 'src/server.js': 'module.exports = "server";\n', 'package.json': '{"name":"nested","private":true}\n' } });
  const nestedInit = git(nested, ['rev-parse', 'HEAD']);
  recordGitlink(git, root, NESTED_REL, nestedInit, 'record nested gitlink');

  const nestedHeads = {
    TPT1: addTaskBranch(git, nested, 'TPT1', { 'src/feature1.js': 'one\n' }, { title: 'Nested feature one' }),
    TPT2: addTaskBranch(git, nested, 'TPT2', { 'src/feature2.js': 'two\n' }, { title: 'Nested feature two' }),
    TPT3: addTaskBranch(git, nested, 'TPT3', { 'src/feature3.js': 'three\n' }, { title: 'Nested feature three', worktree: false }),
  };
  // root task/TPT1: code + gitlink bump to nested TPT1 head (exercises gitlink auto-resolve)
  const wt1 = path.join(root, '.worktrees', 'TPT1');
  git(root, ['worktree', 'add', '-q', wt1, '-b', 'task/TPT1', 'HEAD']);
  write(wt1, { 'src/feature1.js': 'root one\n' });
  git(wt1, ['add', '-A']);
  git(wt1, ['update-index', '--cacheinfo', `160000,${nestedHeads.TPT1},${NESTED_REL}`]);
  git(wt1, ['commit', '-q', '-m', 'TPT1 Root feature one']);
  const rootHeads = {
    TPT1: git(wt1, ['rev-parse', 'HEAD']),
    TPT2: addTaskBranch(git, root, 'TPT2', { 'ai/architecture/kb.md': 'line one (TPT2)\nline two\n', 'src/feature2.js': 'root two\n' }, { title: 'Root feature two' }),
    TPT3: addTaskBranch(git, root, 'TPT3', { 'ai/architecture/kb.md': 'line one (TPT3)\nline two\n', 'src/feature3.js': 'root three\n' }, { title: 'Root feature three' }),
  };
  const tasks = [
    { id: 'TPT1', title: 'Feature one', status: 'completed', description: 'Adds feature one in both repos.' },
    { id: 'TPT2', title: 'Feature two', status: 'completed', description: 'Adds feature two and documents it in kb.md.' },
    { id: 'TPT3', title: 'Feature three', status: 'completed', description: 'Adds feature three and rewrites the kb.md intro.' },
  ].map(row => ({ ...row, ...(taskOverrides[row.id] || {}) }));
  const tasksByKey = new Map(tasks.map(t => [t.id, t]));
  const roles = { complete: 'completed', canceled: 'canceled' };
  return { home, root, nested, nestedRel: NESTED_REL, git, env: fixtureEnv(home), tasks, tasksByKey, roles, nestedHeads, rootHeads, write };
}

// Backend stub with the surface the facade uses (getProjectSettings/getTasksUnfiltered/getStatuses).
function fakeBackend(fixture, { vcs = { vcs_type: 'git', vcs_worktree_enabled: 1, vcs_commit_enabled: 1, vcs_pr_enabled: 0 } } = {}) {
  return {
    async getProjectSettings() { return { ...vcs }; },
    async getTasksUnfiltered() { return fixture.tasks; },
    async getStatuses() { return null; },
    getCredentials() { return { apiBaseUrl: 'http://x', apiProjectId: '1', apiToken: 't' }; },
  };
}

// Modules under test run git through process.env (git-runner.js buildGitEnv) — point that
// at the same isolated config the fixture uses so nothing global/system leaks in.
function applyFixtureEnvToProcess() {
  const env = fixtureEnv(process.env.HOME);
  for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) process.env[k] = env[k];
}

module.exports = { applyFixtureEnvToProcess, gitProbe, skipUnless, makeGit, initRepo, commit, addTaskBranch, recordGitlink, buildFixture, fakeBackend, fixtureEnv, NESTED_REL };
