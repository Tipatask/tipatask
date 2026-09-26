'use strict';

// TPT345 — post-merge cleanup: remove each merged task's worktree (nested repos first —
// a root worktree may contain a nested checkout, which `git worktree remove` refuses
// without --force), delete the task/* branch with `-d` only (an unmerged branch is
// reported, never force-deleted), then `git worktree prune` per repo.

const { runGit } = require('./git-runner');
const { executionOrder } = require('./repo-discovery');

async function removeWorktree(repoPath, wtPath, git) {
  let r = await git(['worktree', 'remove', wtPath], { cwd: repoPath, timeoutMs: 60_000 });
  if (r.status === 0) return { ok: true, forced: false };
  r = await git(['worktree', 'remove', '--force', wtPath], { cwd: repoPath, timeoutMs: 60_000 });
  if (r.status === 0) return { ok: true, forced: true };
  return { ok: false, error: (r.stderr || r.stdout || (r.error && r.error.message) || '').trim().slice(0, 500) };
}

// branches: [{ branch, worktreePath|null }]
async function cleanupRepo({ repo, branches, git = runGit }) {
  const out = { repoId: repo.id, relPath: repo.relPath, removedWorktrees: [], deletedBranches: [], failures: [] };
  for (const b of branches) {
    if (b.worktreePath) {
      const r = await removeWorktree(repo.path, b.worktreePath, git);
      if (r.ok) out.removedWorktrees.push({ path: b.worktreePath, forced: r.forced });
      else { out.failures.push({ path: b.worktreePath, branch: b.branch, message: r.error }); continue; }
    }
    const d = await git(['branch', '-d', b.branch], { cwd: repo.path });
    if (d.status === 0) out.deletedBranches.push(b.branch);
    else out.failures.push({ branch: b.branch, message: (d.stderr || d.stdout || '').trim().slice(0, 500), notMerged: /not fully merged/i.test(d.stderr || '') });
  }
  await git(['worktree', 'prune'], { cwd: repo.path });
  return out;
}

// repos: scanned repos; selections: [{repoId, branch}] — worktree paths come from the scan.
async function cleanupProject({ repos, selections, git = runGit }) {
  const byRepo = new Map();
  for (const s of selections) { if (!byRepo.has(s.repoId)) byRepo.set(s.repoId, []); byRepo.get(s.repoId).push(s.branch); }
  const results = [];
  for (const repo of executionOrder(repos)) {
    const names = byRepo.get(repo.id);
    if (!names || !names.length) continue;
    const branches = names.map(name => {
      const tb = (repo.taskBranches || []).find(b => b.branch === name);
      return { branch: name, worktreePath: tb && tb.worktree ? tb.worktree.path : null };
    });
    results.push(await cleanupRepo({ repo, branches, git }));
  }
  return { repos: results };
}

module.exports = { cleanupProject, cleanupRepo, removeWorktree };
