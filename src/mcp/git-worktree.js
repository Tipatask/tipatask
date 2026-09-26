'use strict';

// C1215 — read-only git worktree/status probe backing the git_worktree_status MCP tool.
// Lives in its own small lazily-required module (mirrors batch-grep.js's own-module
// pattern) rather than importing the task-agent tree into the MCP boot path.
//
// Mirrors BaseTaskAgent.runCliProbe (task-agent/base-agent.js) in shape — argv array
// (never a shell string), captured stdout/stderr, never throws — but adds an explicit
// timeout, which runCliProbe does not default.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GIT_TIMEOUT_MS = 5000;

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
  });
  return {
    error: result.error || null,
    status: result.status,
    stdout: result.stdout ? String(result.stdout) : '',
    stderr: result.stderr ? String(result.stderr) : '',
  };
}

// `git worktree list --porcelain` — blank-line-separated records, one `key value` (or
// bare `key`, for `bare`/`detached`/`locked`/`prunable`) per line.
function parseWorktreePorcelain(output) {
  const worktrees = [];
  let current = null;
  for (const line of output.split('\n')) {
    if (line === '') {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (!current) current = {};
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? true : line.slice(sp + 1);
    if (key === 'worktree') current.path = value;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = value === true ? true : value;
    else if (key === 'prunable') current.prunable = value === true ? true : value;
  }
  if (current) worktrees.push(current);
  return worktrees;
}

// `git status --porcelain=v1 -b` — first line is the `## branch...tracking` header,
// every other line is one changed/untracked path.
function parseStatusPorcelain(output) {
  const lines = output.split('\n').filter(Boolean);
  const branchLine = lines.find(l => l.startsWith('## ')) || '';
  const dirtyFileCount = lines.filter(l => !l.startsWith('## ')).length;
  return { branchLine: branchLine.replace(/^## /, ''), dirtyFileCount };
}

// Read-only: reports worktree list, current branch, and dirty-file count for
// `projectRoot`. Never throws, never creates/mutates a worktree or the working tree.
// Returns { available: false, reason } when projectRoot isn't a git checkout (or `git`
// itself can't be found/times out) instead of shelling out blindly — a packaged run with
// no bound project can leave PROJECT_ROOT pointing at an asar-relative path.
// TPT345 — additional pure parsers shared with src/server/git-merge/ (the user-triggered
// merge flow). Kept here, next to the two parsers above, so both the sync MCP probe and
// the async server runner read git's porcelain formats through one implementation.

// `git ls-files -s` — `<mode> <sha> <stage>\t<path>`; mode 160000 is a gitlink (nested
// repo recorded as a commit pointer). Returns only those.
function parseGitlinks(output) {
  const out = [];
  for (const line of String(output || '').split('\n')) {
    if (!line.startsWith('160000 ')) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const [, sha] = line.slice(0, tab).split(' ');
    out.push({ sha, path: line.slice(tab + 1) });
  }
  return out;
}

// `git rev-list --left-right --count <target>...<branch>` — `<left>\t<right>`: left =
// commits only in target (branch is BEHIND by that many), right = only in branch (AHEAD).
function parseAheadBehind(output) {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(String(output || ''));
  if (!m) return { behind: null, ahead: null };
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}

// `git status --porcelain=v1` (no -b) — one `XY path` (or `XY orig -> new` for renames)
// per line; returns [{ status, path }] with the NEW path for renames. Untracked (`??`)
// rows included.
function parseStatusPorcelainPaths(output) {
  const rows = [];
  for (const line of String(output || '').split('\n')) {
    if (!line || line.startsWith('## ')) continue;
    const status = line.slice(0, 2);
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1 && (status[0] === 'R' || status[0] === 'C')) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    rows.push({ status, path: p });
  }
  return rows;
}

// Sync nested-repo discovery: every gitlink of `projectRoot` whose path has a `.git` on
// disk (a real checkout, not an empty placeholder dir). No `.gitmodules` needed — this
// project may record a nested checkout as a bare gitlink without one.
function discoverNestedRepos(projectRoot) {
  const res = runGit(['ls-files', '-s'], projectRoot);
  if (res.error || res.status !== 0) return [];
  return parseGitlinks(res.stdout)
    .filter(g => fs.existsSync(path.join(projectRoot, g.path, '.git')))
    .map(g => ({ relPath: g.path, path: path.join(projectRoot, g.path), gitlinkSha: g.sha }));
}

function getGitWorktreeStatus(projectRoot, opts = {}) {
  const wantNested = opts.nested !== false;
  const wantAheadBehind = opts.aheadBehind !== false;
  if (!projectRoot || !fs.existsSync(path.join(projectRoot, '.git'))) {
    return { available: false, reason: `Not a git checkout: ${projectRoot || '(no project root)'}` };
  }

  const listRes = runGit(['worktree', 'list', '--porcelain'], projectRoot);
  if (listRes.error) {
    const reason = listRes.error.code === 'ENOENT'
      ? 'git binary not found on PATH'
      : `git worktree list failed: ${listRes.error.message}`;
    return { available: false, reason };
  }
  if (listRes.status !== 0) {
    return { available: false, reason: `git worktree list exited ${listRes.status}: ${listRes.stderr.trim().slice(0, 300)}` };
  }

  const branchRes = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot);
  const currentBranch = branchRes.status === 0 ? branchRes.stdout.trim() : null;

  const statusRes = runGit(['status', '--porcelain=v1', '-b'], projectRoot);
  const { branchLine, dirtyFileCount } = statusRes.status === 0
    ? parseStatusPorcelain(statusRes.stdout)
    : { branchLine: null, dirtyFileCount: null };

  const worktrees = parseWorktreePorcelain(listRes.stdout);
  if (wantAheadBehind) {
    // TPT345 — per linked worktree: task key from the branch name plus ahead/behind
    // counts against the main checkout's HEAD. Lazy require keeps the MCP boot path free
    // of the server tree (same reason this file exists separately from task-agent/).
    const { parseTaskBranch } = require('../server/git-merge/task-branch');
    for (const wt of worktrees) {
      if (!wt.branch) continue;
      const parsed = parseTaskBranch(wt.branch);
      if (parsed) { wt.taskKey = parsed.taskKey; if (parsed.suffix) wt.taskSuffix = parsed.suffix; }
      const ab = runGit(['rev-list', '--left-right', '--count', `HEAD...${wt.branch}`], projectRoot);
      if (ab.status === 0) Object.assign(wt, parseAheadBehind(ab.stdout));
    }
  }

  const result = {
    available: true,
    currentBranch,
    branchStatus: branchLine,
    dirtyFileCount,
    worktrees,
  };
  if (wantNested) {
    result.nested = discoverNestedRepos(projectRoot).map(n => ({
      ...n,
      ...getGitWorktreeStatus(n.path, { nested: false, aheadBehind: wantAheadBehind }),
    }));
  }
  return result;
}

module.exports = {
  getGitWorktreeStatus,
  parseWorktreePorcelain,
  parseStatusPorcelain,
  parseGitlinks,
  parseAheadBehind,
  parseStatusPorcelainPaths,
  discoverNestedRepos,
};
