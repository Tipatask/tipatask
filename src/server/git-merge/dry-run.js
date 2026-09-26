'use strict';

// TPT345 — conflict prediction with `git merge-tree --write-tree --name-only` (git >= 2.38):
// each selected branch against the target, plus every pair of selected branches. A
// sequential fold (merge A, then simulate B on the result) is not possible here —
// merge-tree needs commits, and --write-tree yields only a tree — so pairwise + vs-target
// is what this reports; the real run stops on the first actual conflict regardless.

const { runGit, gitVersion } = require('./git-runner');

const MAX_PAIRS = 120;

// stdout of `merge-tree --write-tree --name-only --no-messages`: line 1 = tree oid; with
// exit status 1 the following lines (up to a blank line) are the conflicted paths.
function parseMergeTreeOutput(stdout, status) {
  const lines = String(stdout || '').split('\n');
  const treeSha = (lines[0] || '').trim() || null;
  const conflicts = [];
  if (status === 1) {
    for (const line of lines.slice(1)) {
      if (line === '') break;
      conflicts.push(line);
    }
  }
  return { treeSha, conflicts, clean: status === 0 };
}

async function mergeTreePair(repoPath, a, b, { git = runGit } = {}) {
  const r = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { cwd: repoPath, timeoutMs: 60_000 });
  if (r.error) return { a, b, clean: false, conflicts: [], error: r.timedOut ? 'merge-tree timed out' : r.error.message };
  if (r.status !== 0 && r.status !== 1) return { a, b, clean: false, conflicts: [], error: `merge-tree exited ${r.status}: ${(r.stderr || '').trim().slice(0, 300)}` };
  const parsed = parseMergeTreeOutput(r.stdout, r.status);
  return { a, b, clean: parsed.clean, conflicts: parsed.conflicts, treeSha: parsed.treeSha, error: null };
}

// repo = scanned repo; branches = selected branch names. targetRef = 'HEAD' for
// createBranch targets, else the target branch name.
async function dryRunRepo(repo, branches, { git = runGit } = {}) {
  const targetRef = (repo.targetSpec && repo.targetSpec.createBranch) ? 'HEAD' : (repo.target || 'HEAD');
  const versusTarget = [];
  for (const b of branches) {
    const r = await mergeTreePair(repo.path, targetRef, b, { git });
    versusTarget.push({ branch: b, clean: r.clean, conflicts: r.conflicts, error: r.error });
  }
  const pairwise = [];
  let pairs = 0; let capped = false;
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      if (pairs++ >= MAX_PAIRS) { capped = true; break; }
      const r = await mergeTreePair(repo.path, branches[i], branches[j], { git });
      pairwise.push({ a: branches[i], b: branches[j], clean: r.clean, conflicts: r.conflicts, error: r.error });
    }
    if (capped) break;
  }
  const conflictingBranches = new Set();
  for (const v of versusTarget) if (!v.clean) conflictingBranches.add(v.branch);
  for (const p of pairwise) if (!p.clean) { conflictingBranches.add(p.a); conflictingBranches.add(p.b); }
  return { id: repo.id, target: repo.target, versusTarget, pairwise, pairwiseCapped: capped, summary: { conflictingBranches: [...conflictingBranches] } };
}

// selections = [{repoId, branch}] against a scanned project.
async function dryRunProject(scan, selections, { git = runGit, exec } = {}) {
  const version = await gitVersion({ exec });
  if (!version.mergeTreeSupported) {
    return { supported: false, reason: `git ${version.raw || '(unknown)'} lacks merge-tree --write-tree (needs >= 2.38)`, repos: [] };
  }
  const byRepo = new Map();
  for (const s of selections) {
    if (!byRepo.has(s.repoId)) byRepo.set(s.repoId, []);
    byRepo.get(s.repoId).push(s.branch);
  }
  const repos = [];
  for (const repo of scan.repos) {
    const branches = byRepo.get(repo.id);
    if (!branches || !branches.length) continue;
    repos.push(await dryRunRepo(repo, branches, { git }));
  }
  return { supported: true, reason: null, repos };
}

module.exports = { parseMergeTreeOutput, mergeTreePair, dryRunRepo, dryRunProject, MAX_PAIRS };
