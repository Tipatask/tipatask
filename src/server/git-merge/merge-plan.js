'use strict';

// TPT345 — pure ordering of the merge run. Nested repos first (deepest first), each
// repo's selected task branches in task-key order with `git merge --no-ff`; a parent repo
// gets a gitlink-bump step for every child that received merges BEFORE its own merges
// (so each task's gitlink is an ancestor of the recorded one and fast-forwards instead of
// conflicting); checks last, nested first. No IO.

const { taskKeyOrder, mergeCommitMessage } = require('./task-branch');
const { executionOrder } = require('./repo-discovery');

function labelFor(step) {
  const repo = step.repoRelPath || 'root';
  switch (step.kind) {
    case 'baseline': return `Baseline checks in ${repo}`;
    case 'checkout-target': return step.create ? `Create branch ${step.target} in ${repo}` : `Check out ${step.target} in ${repo}`;
    case 'merge': return `Merge ${step.branch} into ${step.target} (${repo})`;
    case 'gitlink-bump': return `Record ${step.nestedRelPath} at its merged HEAD in ${repo}`;
    case 'verify-gitlinks': return `Verify nested repository pointers in ${repo}`;
    case 'checks': return `Post-merge checks in ${repo}`;
    default: return step.kind;
  }
}

// repos = preflighted scan repos; selections = [{repoId, branch}]; targets = {repoId: spec};
// checks = { test, build, baseline }. Returns ordered steps with index + status 'pending'.
function buildPlan({ repos, selections, targets = {}, checks = { test: true, build: true, baseline: true } }) {
  const byRepo = new Map(repos.map(r => [r.id, r]));
  const selectedByRepo = new Map();
  for (const s of selections) {
    const repo = byRepo.get(s.repoId);
    if (!repo) continue;
    const branch = (repo.taskBranches || []).find(b => b.branch === s.branch);
    if (!branch) continue;
    if (!selectedByRepo.has(repo.id)) selectedByRepo.set(repo.id, []);
    selectedByRepo.get(repo.id).push(branch);
  }
  for (const list of selectedByRepo.values()) list.sort(taskKeyOrder);

  // A repo participates when it has merges itself or a descendant does (gitlink bump).
  const participates = new Set();
  for (const id of selectedByRepo.keys()) {
    let cur = byRepo.get(id);
    while (cur) { participates.add(cur.id); cur = cur.parentId ? byRepo.get(cur.parentId) : null; }
  }
  const wantsChecks = (repo) => !!(checks && (checks.test || checks.build) && ((checks.test && repo.checks?.test) || (checks.build && repo.checks?.build)));

  const steps = [];
  const push = (step) => { steps.push({ index: steps.length, status: 'pending', label: labelFor(step), ...step }); };
  const ordered = executionOrder(repos).filter(r => participates.has(r.id));
  for (const repo of ordered) {
    const spec = targets[repo.id] || repo.targetSpec || null;
    const target = spec && spec.createBranch ? spec.createBranch : (spec && spec.branch) || repo.target || repo.currentBranch;
    const base = { repoId: repo.id, repoRelPath: repo.relPath, repoPath: repo.path, target };
    if (checks && checks.baseline && wantsChecks(repo)) push({ kind: 'baseline', ...base });
    if (spec && spec.createBranch) push({ kind: 'checkout-target', ...base, create: true });
    else if (spec && spec.branch && spec.branch !== repo.currentBranch) push({ kind: 'checkout-target', ...base, create: false });
    const bumped = [];
    for (const child of ordered.filter(c => c.parentId === repo.id)) {
      const keys = (selectedByRepo.get(child.id) || []).map(b => b.taskKey);
      push({ kind: 'gitlink-bump', ...base, nestedId: child.id, nestedRelPath: child.relToParent, nestedPath: child.path, keys });
      bumped.push({ nestedId: child.id, nestedRelPath: child.relToParent, nestedPath: child.path });
    }
    for (const branch of selectedByRepo.get(repo.id) || []) {
      const title = branch.task ? branch.task.title : '';
      push({ kind: 'merge', ...base, branch: branch.branch, taskKey: branch.taskKey, title, branchSha: branch.headSha, message: mergeCommitMessage(branch.taskKey, title) });
    }
    if (bumped.length) push({ kind: 'verify-gitlinks', ...base, nested: bumped });
  }
  for (const repo of ordered) {
    if (wantsChecks(repo)) {
      const spec = targets[repo.id] || repo.targetSpec || null;
      const target = spec && spec.createBranch ? spec.createBranch : (spec && spec.branch) || repo.target || repo.currentBranch;
      push({ kind: 'checks', repoId: repo.id, repoRelPath: repo.relPath, repoPath: repo.path, target });
    }
  }
  return steps;
}

module.exports = { buildPlan, labelFor };
