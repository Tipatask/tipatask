'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyPreflight, collectRunBlockers, computeRepoBlockers, computeBranchBlockers, shapeTask } = require('./preflight');

const roles = { complete: 'completed', canceled: 'canceled' };
function branch(over = {}) {
  return { branch: 'task/TPT1', taskKey: 'TPT1', suffix: null, headSha: 'a', ahead: 2, behind: 0, touchedFiles: ['src/a.js'], worktree: null, ...over };
}
function repo(over = {}) {
  return { id: 'root', relPath: '', path: '/p', kind: 'root', currentBranch: 'master', detached: false, midMerge: false, midMergePaths: [], mainBranch: 'master', target: 'master', targetSpec: null, dirtyFiles: [], gitlinkDrift: [], targetSwitchFiles: [], taskBranches: [branch()], ...over };
}
const codes = (list) => list.map(b => b.code);

test('shapeTask: complete / closed / missing', () => {
  assert.equal(shapeTask(null, roles), null);
  assert.equal(shapeTask({ id: 'TPT1', status: 'completed', title: 'x' }, roles).isComplete, true);
  const canceled = shapeTask({ id: 'TPT1', status: 'canceled' }, roles);
  assert.equal(canceled.isComplete, false); assert.equal(canceled.isClosed, true);
});

test('repo blockers: mid-merge, detached, target switch overlap, missing target, createBranch off-main, gitlink drift info', () => {
  assert.deepEqual(codes(computeRepoBlockers(repo({ midMerge: true, midMergePaths: ['x'] }))), ['REPO_MID_MERGE']);
  assert.deepEqual(codes(computeRepoBlockers(repo({ currentBranch: 'HEAD', detached: true }))), ['REPO_DETACHED']);
  assert.deepEqual(codes(computeRepoBlockers(repo({ target: 'release', targetSwitchFiles: ['a', 'b'], dirtyFiles: [{ status: ' M', path: 'b' }] }))), ['TARGET_NOT_CHECKED_OUT']);
  assert.deepEqual(codes(computeRepoBlockers(repo({ target: 'release', targetSwitchFiles: ['a'], dirtyFiles: [{ status: ' M', path: 'z' }] }))), [], 'no overlap → switching is fine');
  assert.deepEqual(codes(computeRepoBlockers(repo({ target: 'nope', targetMissing: true }))), ['TARGET_NOT_CHECKED_OUT']);
  assert.deepEqual(codes(computeRepoBlockers(repo({ currentBranch: 'feature' }), { targetSpec: { createBranch: 'x' } })), ['TARGET_CREATE_NOT_ON_MAIN']);
  assert.deepEqual(codes(computeRepoBlockers(repo(), { targetSpec: { createBranch: 'x' } })), [], 'on main → create allowed');
  const drift = computeRepoBlockers(repo({ gitlinkDrift: [{ relPath: 'ai/todo/server' }] }));
  assert.deepEqual(codes(drift), ['GITLINK_DRIFT']); assert.equal(drift[0].severity, 'info');
});

test('branch blockers: task unknown/not completed, already merged, dirty worktree (completed → block with commit action), overlap, session', () => {
  const r = repo();
  assert.deepEqual(codes(computeBranchBlockers(r, branch({ task: null }))), ['TASK_UNKNOWN']);
  assert.deepEqual(codes(computeBranchBlockers(r, branch({ task: shapeTask({ id: 'TPT1', status: 'in_progress' }, roles) }))), ['TASK_NOT_COMPLETED']);
  assert.deepEqual(codes(computeBranchBlockers(r, branch({ task: shapeTask({ id: 'TPT1', status: 'completed' }, roles), ahead: 0 }))), ['ALREADY_MERGED']);
  const dirtyDone = computeBranchBlockers(r, branch({ task: shapeTask({ id: 'TPT1', status: 'completed', title: 'Title here' }, roles), worktree: { path: '/p/.worktrees/TPT1', dirty: true, dirtyFiles: [{ status: '??', path: 'new.js' }] } }));
  assert.deepEqual(codes(dirtyDone), ['WORKTREE_DIRTY_COMPLETED']);
  assert.equal(dirtyDone[0].severity, 'block');
  assert.deepEqual(dirtyDone[0].action, { type: 'commit-worktree', repoId: 'root', branch: 'task/TPT1', message: 'TPT1 Title here' });
  const dirtyOpen = computeBranchBlockers(r, branch({ task: shapeTask({ id: 'TPT1', status: 'pending' }, roles), worktree: { path: '/w', dirty: true, dirtyFiles: [] } }));
  assert.deepEqual(codes(dirtyOpen).sort(), ['TASK_NOT_COMPLETED', 'WORKTREE_DIRTY']);
  const done = shapeTask({ id: 'TPT1', status: 'completed' }, roles);
  const overlap = computeBranchBlockers(repo({ dirtyFiles: [{ status: ' M', path: 'src/a.js' }, { status: '??', path: '.worktrees/' }, { status: ' M', path: 'ai/todo/server' }], gitlinkDrift: [{ relPath: 'ai/todo/server' }] }), branch({ task: done, touchedFiles: ['src/a.js', 'ai/todo/server', '.worktrees/x'] }));
  assert.deepEqual(codes(overlap), ['MAIN_DIRTY_OVERLAP']);
  assert.deepEqual(overlap[0].paths, ['src/a.js'], 'gitlink + .worktrees rows never count as overlap');
  assert.deepEqual(codes(computeBranchBlockers(repo({ dirtyFiles: [{ status: ' M', path: 'other.js' }] }), branch({ task: done }))), [], 'dirty file the branch does not touch is fine');
  assert.deepEqual(codes(computeBranchBlockers(r, branch({ task: done }), { activeTaskKeys: new Set(['TPT1']) })), ['SESSION_ACTIVE']);
});

test('applyPreflight: selectedByDefault only for completed + ahead>0; collectRunBlockers gathers block-severity only + parent repos of merged children', () => {
  const scan = { repos: [
    repo({ dirtyFiles: [{ status: ' M', path: 'src/a.js' }], taskBranches: [branch(), branch({ branch: 'task/TPT2', taskKey: 'TPT2', touchedFiles: ['x'] }), branch({ branch: 'task/TPT3', taskKey: 'TPT3', ahead: 0 })] }),
    repo({ id: 'ai/todo/server', relPath: 'ai/todo/server', kind: 'nested', parentId: 'root', taskBranches: [branch({ branch: 'task/TPT2', taskKey: 'TPT2', touchedFiles: ['y'] })] }),
  ] };
  const tasks = new Map([['TPT1', { id: 'TPT1', status: 'completed' }], ['TPT2', { id: 'TPT2', status: 'in_progress' }], ['TPT3', { id: 'TPT3', status: 'completed' }]]);
  const out = applyPreflight(scan, { tasksByKey: tasks, roles });
  const root = out.repos[0];
  assert.deepEqual(root.taskBranches.map(b => b.selectedByDefault), [true, false, false]);
  assert.deepEqual(codes(root.taskBranches[0].blockers), ['MAIN_DIRTY_OVERLAP']);
  assert.deepEqual(codes(root.taskBranches[1].blockers), ['TASK_NOT_COMPLETED']);
  assert.notEqual(out, scan, 'no mutation');
  assert.equal(scan.repos[0].taskBranches[0].blockers, undefined);
  // warn-only selection passes; block-only selection fails; nested selection pulls in root's blocks
  assert.deepEqual(collectRunBlockers(out, [{ repoId: 'root', branch: 'task/TPT2' }]), []);
  assert.deepEqual(codes(collectRunBlockers(out, [{ repoId: 'root', branch: 'task/TPT1' }])), ['MAIN_DIRTY_OVERLAP']);
  assert.deepEqual(codes(collectRunBlockers(out, [{ repoId: 'root', branch: 'task/nope' }])), ['UNKNOWN_BRANCH']);
  const midRoot = applyPreflight({ repos: [repo({ midMerge: true, taskBranches: [] }), scan.repos[1]] }, { tasksByKey: tasks, roles });
  assert.deepEqual(codes(collectRunBlockers(midRoot, [{ repoId: 'ai/todo/server', branch: 'task/TPT2' }])), ['REPO_MID_MERGE'], 'root receives the gitlink bump, so its blockers apply');
});
