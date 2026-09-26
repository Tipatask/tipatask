'use strict';

// TPT345 — read-only scan of a project's git repos for the merge panel: the root checkout
// plus every nested repo it records as a gitlink (mode 160000 with a real `.git` on
// disk — this project has no `.gitmodules`, so `git submodule` is unusable), their
// `task/<KEY>` branches, linked worktrees, dirty state, ahead/behind vs a target, and the
// files each branch touches. Pure git reads; never writes.

const fs = require('node:fs');
const path = require('node:path');
const { runGit, runCommand, gitVersion } = require('./git-runner');
const { parseWorktreePorcelain, parseGitlinks, parseAheadBehind, parseStatusPorcelainPaths } = require('../../mcp/git-worktree');
const { parseTaskBranch, taskKeyOrder } = require('./task-branch');

const ROOT_ID = 'root';
const MAX_DEPTH = 2;

function repoId(relPath) { return relPath ? relPath : ROOT_ID; }

async function listGitlinks(repoPath, git) {
  const r = await git(['ls-files', '-s'], { cwd: repoPath });
  if (r.error || r.status !== 0) return [];
  return parseGitlinks(r.stdout).filter(g => fs.existsSync(path.join(repoPath, g.path, '.git')));
}

// [{ id, relPath, path, kind:'root'|'nested', gitlinkSha, parentId, depth }], root first,
// then nested in discovery order. Depth-capped at MAX_DEPTH.
async function discoverRepos(projectRoot, { git = runGit } = {}) {
  const repos = [{ id: ROOT_ID, relPath: '', path: projectRoot, kind: 'root', gitlinkSha: null, parentId: null, depth: 0 }];
  const walk = async (parent) => {
    if (parent.depth >= MAX_DEPTH) return;
    for (const g of await listGitlinks(parent.path, git)) {
      const relPath = parent.relPath ? `${parent.relPath}/${g.path}` : g.path;
      const repo = { id: repoId(relPath), relPath, path: path.join(parent.path, g.path), kind: 'nested', gitlinkSha: g.sha, parentId: parent.id, depth: parent.depth + 1, relToParent: g.path };
      repos.push(repo);
      await walk(repo);
    }
  };
  await walk(repos[0]);
  return repos;
}

const _mainBranchCache = new Map();
// `origin/HEAD` when the clone recorded it; else the forge default via `gh repo view`
// (GitHub's default branch can differ from the local main branch — whitemaster vs master
// in this repo). Cached per repo path for the process lifetime.
async function detectMainBranch(repoPath, { git = runGit, exec, refresh = false } = {}) {
  if (!refresh && _mainBranchCache.has(repoPath)) return _mainBranchCache.get(repoPath);
  let result = { mainBranch: null, mainBranchSource: null };
  const sym = await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath, timeoutMs: 5000 });
  if (sym.status === 0 && sym.stdout.trim()) {
    result = { mainBranch: sym.stdout.trim().replace(/^origin\//, ''), mainBranchSource: 'origin-head' };
  } else {
    const gh = await runCommand('gh', ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], { cwd: repoPath, timeoutMs: 10_000, exec });
    if (!gh.error && gh.status === 0 && gh.stdout.trim()) {
      result = { mainBranch: gh.stdout.trim(), mainBranchSource: 'gh' };
    }
  }
  _mainBranchCache.set(repoPath, result);
  return result;
}

function detectChecks(repoPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
    const scripts = pkg && pkg.scripts ? pkg.scripts : {};
    return { test: scripts.test ? 'npm test' : null, build: scripts.build ? 'npm run build' : null };
  } catch {
    return { test: null, build: null };
  }
}

async function worktreeDirtyFiles(wtPath, git) {
  const r = await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'], { cwd: wtPath });
  if (r.error || r.status !== 0) return null;
  return parseStatusPorcelainPaths(r.stdout);
}

// Scans one repo. `targetSpec` = { branch } | { createBranch } | undefined (default: the
// checked-out branch). `childRelPaths` = this repo's own gitlink paths (so their rows in
// `git status` become gitlinkDrift, not dirtyFiles).
async function scanRepo(repo, { git = runGit, exec, targetSpec, childRelPaths = [] } = {}) {
  const cwd = repo.path;
  const out = {
    ...repo,
    currentBranch: null, detached: false, headSha: null,
    midMerge: false, midMergePaths: [],
    mainBranch: null, mainBranchSource: null,
    target: null, targetSpec: targetSpec || null, canCreateBranch: false,
    otherBranches: [], dirtyFiles: [], gitlinkDrift: [], targetSwitchFiles: [],
    checks: detectChecks(cwd),
    taskBranches: [],
  };
  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  out.currentBranch = head.status === 0 ? head.stdout.trim() : null;
  out.detached = out.currentBranch === 'HEAD';
  const headSha = await git(['rev-parse', 'HEAD'], { cwd });
  out.headSha = headSha.status === 0 ? headSha.stdout.trim() : null;

  const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd });
  out.midMerge = mergeHead.status === 0;
  if (out.midMerge) {
    const u = await git(['diff', '--name-only', '--diff-filter=U'], { cwd });
    out.midMergePaths = u.status === 0 ? u.stdout.split('\n').filter(Boolean) : [];
  }

  Object.assign(out, await detectMainBranch(cwd, { git, exec }));
  out.canCreateBranch = !!out.currentBranch && !out.detached && (!out.mainBranch || out.currentBranch === out.mainBranch);

  const refs = await git(['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(upstream:short)', 'refs/heads/'], { cwd });
  const branches = refs.status === 0
    ? refs.stdout.split('\n').filter(Boolean).map(l => { const [name, sha, upstream] = l.split('\0'); return { name, sha, upstream: upstream || null }; })
    : [];
  const taskBranches = [];
  for (const b of branches) {
    const parsed = parseTaskBranch(b.name);
    if (parsed) taskBranches.push({ ...parsed, headSha: b.sha, upstream: b.upstream });
    else out.otherBranches.push(b.name);
  }
  taskBranches.sort(taskKeyOrder);

  const wtRes = await git(['worktree', 'list', '--porcelain'], { cwd });
  const worktrees = wtRes.status === 0 ? parseWorktreePorcelain(wtRes.stdout) : [];
  const wtByBranch = new Map();
  for (const wt of worktrees) if (wt.branch) wtByBranch.set(wt.branch.replace(/^refs\/heads\//, ''), wt);

  const status = await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=dirty'], { cwd });
  if (status.status === 0) {
    for (const row of parseStatusPorcelainPaths(status.stdout)) {
      if (childRelPaths.includes(row.path)) out.gitlinkDrift.push({ relPath: row.path, status: row.status });
      else out.dirtyFiles.push(row);
    }
  }

  // Target: an explicit existing branch, or (createBranch) the current HEAD as the base.
  if (targetSpec && targetSpec.branch) out.target = targetSpec.branch;
  else out.target = out.detached ? null : out.currentBranch;
  const targetRef = (targetSpec && targetSpec.createBranch) ? 'HEAD' : (out.target || 'HEAD');
  if (out.target && out.currentBranch && out.target !== out.currentBranch) {
    const sw = await git(['diff', '--name-only', 'HEAD', out.target], { cwd });
    out.targetSwitchFiles = sw.status === 0 ? sw.stdout.split('\n').filter(Boolean) : [];
    if (sw.status !== 0) out.targetMissing = true;
  }

  for (const tb of taskBranches) {
    const entry = { ...tb, ahead: null, behind: null, mergeBase: null, touchedFiles: [], worktree: null };
    const ab = await git(['rev-list', '--left-right', '--count', `${targetRef}...${tb.branch}`], { cwd });
    if (ab.status === 0) Object.assign(entry, parseAheadBehind(ab.stdout));
    const mb = await git(['merge-base', targetRef, tb.branch], { cwd });
    if (mb.status === 0) {
      entry.mergeBase = mb.stdout.trim();
      const diff = await git(['diff', '--name-only', entry.mergeBase, tb.branch], { cwd });
      if (diff.status === 0) entry.touchedFiles = diff.stdout.split('\n').filter(Boolean);
    }
    const wt = wtByBranch.get(tb.branch);
    if (wt) {
      const dirtyFiles = await worktreeDirtyFiles(wt.path, git);
      entry.worktree = { path: wt.path, head: wt.head, dirty: !!(dirtyFiles && dirtyFiles.length), dirtyFiles: dirtyFiles || [], locked: wt.locked || false, prunable: wt.prunable || false };
    }
    out.taskBranches.push(entry);
  }
  return out;
}

// Whole-project scan: { git:{version, mergeTreeSupported}, repos:[scanRepo...] } with
// repos in discovery order (root first). `targets` = { <repoId>: targetSpec }.
async function scanProject(projectRoot, { git = runGit, exec, targets = {} } = {}) {
  const repos = await discoverRepos(projectRoot, { git });
  const version = await gitVersion({ exec });
  const scanned = [];
  for (const repo of repos) {
    const childRelPaths = repos.filter(r => r.parentId === repo.id).map(r => r.relToParent);
    scanned.push(await scanRepo(repo, { git, exec, targetSpec: targets[repo.id], childRelPaths }));
  }
  return { git: { version: version.raw, mergeTreeSupported: !!version.mergeTreeSupported }, repos: scanned };
}

// Every linked worktree (across root + nested repos) whose branch is task/<taskKey> or
// task/<taskKey>-<suffix>, with its dirty-file count. Used by the completion-time guard.
async function findTaskWorktrees(projectRoot, taskKey, { git = runGit } = {}) {
  const found = [];
  for (const repo of await discoverRepos(projectRoot, { git })) {
    const wtRes = await git(['worktree', 'list', '--porcelain'], { cwd: repo.path });
    if (wtRes.status !== 0) continue;
    for (const wt of parseWorktreePorcelain(wtRes.stdout)) {
      const parsed = parseTaskBranch(wt.branch || '');
      if (!parsed || parsed.taskKey !== taskKey) continue;
      const dirtyFiles = await worktreeDirtyFiles(wt.path, git);
      found.push({ repoId: repo.id, path: wt.path, branch: parsed.branch, dirtyFileCount: dirtyFiles ? dirtyFiles.length : null, dirtyFiles: dirtyFiles || [] });
    }
  }
  return found;
}

// Nested-first execution order: deeper repos first, then alphabetical, root last.
function executionOrder(repos) {
  return [...repos].sort((a, b) => {
    if (a.depth !== b.depth) return b.depth - a.depth;
    return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
  });
}

module.exports = { ROOT_ID, discoverRepos, scanRepo, scanProject, findTaskWorktrees, detectMainBranch, detectChecks, executionOrder, worktreeDirtyFiles };
