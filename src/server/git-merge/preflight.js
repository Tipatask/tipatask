'use strict';

// TPT345 — pure preflight: attaches task metadata to each scanned branch and computes
// the blockers the panel shows. No IO. Severity contract: 'block' stops a run,
// 'warn' is advisory (and may flip selectedByDefault off), 'info' is context only.

const { worktreeCommitMessage } = require('./task-branch');

const SEVERITY = Object.freeze({ BLOCK: 'block', WARN: 'warn', INFO: 'info' });

function blocker(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

function isWorktreesEntry(p) {
  return p === '.worktrees' || p === '.worktrees/' || p.startsWith('.worktrees/');
}

function shapeTask(row, roles) {
  if (!row) return null;
  const status = row.status || null;
  const isComplete = !!status && status === roles.complete;
  const isClosed = isComplete || (!!status && status === roles.canceled);
  return { key: row.id || row.key || row.task_key, title: row.title || '', status, description: row.description || '', isComplete, isClosed };
}

// repo-level blockers (independent of branch selection)
function computeRepoBlockers(repo, { targetSpec } = {}) {
  const out = [];
  if (repo.midMerge) out.push(blocker('REPO_MID_MERGE', SEVERITY.BLOCK, `${repo.relPath || 'root'} is in the middle of a merge (MERGE_HEAD present)`, { paths: repo.midMergePaths || [], action: { type: 'abort-or-resume' } }));
  if (repo.detached) out.push(blocker('REPO_DETACHED', SEVERITY.BLOCK, `${repo.relPath || 'root'} has a detached HEAD — check out a branch first`));
  const spec = targetSpec || repo.targetSpec;
  if (spec && spec.createBranch) {
    if (repo.mainBranch && repo.currentBranch !== repo.mainBranch) {
      out.push(blocker('TARGET_CREATE_NOT_ON_MAIN', SEVERITY.BLOCK, `A new branch can only be created while the main branch (${repo.mainBranch}) is checked out; current branch is ${repo.currentBranch}`));
    }
  } else if (repo.target && repo.currentBranch && repo.target !== repo.currentBranch) {
    if (repo.targetMissing) {
      out.push(blocker('TARGET_NOT_CHECKED_OUT', SEVERITY.BLOCK, `Target branch ${repo.target} does not exist in ${repo.relPath || 'root'}`));
    } else {
      const dirty = new Set((repo.dirtyFiles || []).map(f => f.path));
      const overlap = (repo.targetSwitchFiles || []).filter(p => dirty.has(p));
      if (overlap.length) {
        out.push(blocker('TARGET_NOT_CHECKED_OUT', SEVERITY.BLOCK, `Switching ${repo.relPath || 'root'} to ${repo.target} would overwrite uncommitted changes`, { paths: overlap }));
      }
    }
  }
  if ((repo.gitlinkDrift || []).length) {
    out.push(blocker('GITLINK_DRIFT', SEVERITY.INFO, `Nested repository pointer differs from the recorded commit: ${repo.gitlinkDrift.map(d => d.relPath).join(', ')} — the gitlink bump step records the merged HEAD`, { paths: repo.gitlinkDrift.map(d => d.relPath) }));
  }
  return out;
}

// branch-level blockers
function computeBranchBlockers(repo, branch, { activeTaskKeys = new Set() } = {}) {
  const out = [];
  const task = branch.task;
  if (!task) {
    out.push(blocker('TASK_UNKNOWN', SEVERITY.WARN, `No task ${branch.taskKey} found in this project`));
  } else if (!task.isComplete) {
    out.push(blocker('TASK_NOT_COMPLETED', SEVERITY.WARN, `Task ${branch.taskKey} is ${task.status || 'not completed'}`));
  }
  if (branch.ahead === 0) {
    out.push(blocker('ALREADY_MERGED', SEVERITY.INFO, `${branch.branch} has no commits beyond ${repo.target || 'the target'}`));
  }
  if (branch.worktree && branch.worktree.dirty) {
    if (task && task.isComplete) {
      out.push(blocker('WORKTREE_DIRTY_COMPLETED', SEVERITY.BLOCK, `Completed task ${branch.taskKey} still has uncommitted changes in ${branch.worktree.path}`, {
        paths: branch.worktree.dirtyFiles.map(f => f.path),
        action: { type: 'commit-worktree', repoId: repo.id, branch: branch.branch, message: worktreeCommitMessage(branch.taskKey, task.title) },
      }));
    } else {
      out.push(blocker('WORKTREE_DIRTY', SEVERITY.WARN, `Worktree ${branch.worktree.path} has uncommitted changes`, { paths: branch.worktree.dirtyFiles.map(f => f.path) }));
    }
  }
  const childPaths = new Set((repo.gitlinkDrift || []).map(d => d.relPath));
  const dirtyMain = new Set((repo.dirtyFiles || []).map(f => f.path).filter(p => !isWorktreesEntry(p) && !childPaths.has(p)));
  const overlap = (branch.touchedFiles || []).filter(p => dirtyMain.has(p));
  if (overlap.length) {
    out.push(blocker('MAIN_DIRTY_OVERLAP', SEVERITY.BLOCK, `The main checkout has uncommitted changes in files ${branch.branch} touches`, { paths: overlap }));
  }
  if (activeTaskKeys.has(branch.taskKey)) {
    out.push(blocker('SESSION_ACTIVE', SEVERITY.WARN, `An agent session for ${branch.taskKey} is still running`));
  }
  return out;
}

function selectedByDefault(branch) {
  return !!(branch.task && branch.task.isComplete && branch.ahead !== 0);
}

// Returns a NEW scan object with task info, blockers and selectedByDefault filled in.
// `tasksByKey` = Map<taskKey, task row>, `roles` = { complete, canceled } (status-roles.js).
function applyPreflight(scan, { tasksByKey = new Map(), roles = { complete: 'completed', canceled: 'canceled' }, activeTaskKeys = new Set(), targets = {} } = {}) {
  const repos = scan.repos.map(repo => {
    const r = { ...repo };
    r.blockers = computeRepoBlockers(r, { targetSpec: targets[r.id] });
    r.taskBranches = (repo.taskBranches || []).map(b => {
      const branch = { ...b, task: shapeTask(tasksByKey.get(b.taskKey), roles) };
      branch.blockers = computeBranchBlockers(r, branch, { activeTaskKeys });
      branch.selectedByDefault = selectedByDefault(branch);
      branch.sessionActive = activeTaskKeys.has(branch.taskKey);
      return branch;
    });
    return r;
  });
  return { ...scan, repos };
}

// Validates a run request against a preflighted scan. Returns the list of 'block'
// severity blockers relevant to the selection (empty = OK) plus unknown selections.
function collectRunBlockers(scan, selections) {
  const out = [];
  const byRepo = new Map(scan.repos.map(r => [r.id, r]));
  const touchedRepos = new Set(selections.map(s => s.repoId));
  for (const repoIdSel of touchedRepos) {
    const repo = byRepo.get(repoIdSel);
    if (!repo) { out.push(blocker('UNKNOWN_REPO', SEVERITY.BLOCK, `Unknown repository ${repoIdSel}`)); continue; }
    for (const b of repo.blockers || []) if (b.severity === SEVERITY.BLOCK) out.push({ ...b, repoId: repo.id });
  }
  for (const sel of selections) {
    const repo = byRepo.get(sel.repoId);
    if (!repo) continue;
    const branch = (repo.taskBranches || []).find(b => b.branch === sel.branch);
    if (!branch) { out.push(blocker('UNKNOWN_BRANCH', SEVERITY.BLOCK, `Unknown branch ${sel.branch} in ${sel.repoId}`, { repoId: sel.repoId, branch: sel.branch })); continue; }
    for (const b of branch.blockers || []) if (b.severity === SEVERITY.BLOCK) out.push({ ...b, repoId: repo.id, branch: branch.branch });
  }
  // Every repo that will receive a gitlink bump (parent of a merged nested repo) must also be mergeable.
  for (const repo of scan.repos) {
    if (touchedRepos.has(repo.id)) continue;
    const childTouched = scan.repos.some(c => c.parentId === repo.id && touchedRepos.has(c.id));
    if (!childTouched) continue;
    for (const b of repo.blockers || []) if (b.severity === SEVERITY.BLOCK && b.code !== 'GITLINK_DRIFT') out.push({ ...b, repoId: repo.id });
  }
  return out;
}

module.exports = { SEVERITY, blocker, shapeTask, computeRepoBlockers, computeBranchBlockers, selectedByDefault, applyPreflight, collectRunBlockers, isWorktreesEntry };
