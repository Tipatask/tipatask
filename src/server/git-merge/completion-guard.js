'use strict';

// Strict automatic-merge verification and guarded task completion. The legacy dirty
// worktree notification below remains best-effort when automatic merge is disabled.

const { findTaskWorktrees } = require('./repo-discovery');
const { fetchVcsSettings } = require('../vcs-settings');
const { worktreeCommitMessage } = require('./task-branch');
const { parseTaskBranch } = require('./task-branch');
const { parseWorktreePorcelain, parseGitlinks } = require('../../mcp/git-worktree');
const { runGit } = require('./git-runner');
const { readVcsContext } = require('../vcs-context');
const path = require('node:path');

// Read-only and strict: unlike the merge panel's best-effort inventory, a failed Git
// read must never look like zero outstanding commits. No network/forge discovery.
async function verifyTaskCompletion({ backend, projectRoot, taskId, git = runGit } = {}) {
  const context = await readVcsContext(backend);
  const result = { ...context, ready: false, repositories: [], blockers: [] };
  if (!context.verified) {
    result.blockers.push({ code: context.reason });
    return result;
  }
  if (!/^[A-Z]+\d+$/.test(taskId || '')) {
    result.blockers.push({ code: 'invalid_task_key' });
    return result;
  }
  if (context.vcs.type !== 'git' || !context.vcs.merge) {
    result.ready = true;
    return result;
  }
  const read = async (cwd, args, allowed = [0]) => {
    const r = await git(args, { cwd });
    if (r.error || !allowed.includes(r.status)) throw new Error('git_read_failed');
    return r;
  };
  try {
    if (!projectRoot) throw new Error('missing_project_root');
    const roots = parseWorktreePorcelain((await read(projectRoot, ['worktree', 'list', '--porcelain'])).stdout);
    const mainRoot = roots[0]?.path;
    if (!mainRoot || roots[0].bare) throw new Error('missing_main_checkout');
    const seen = new Set();
    const walk = async (cwd, depth = 0) => {
      if (depth > 10 || seen.has(cwd)) throw new Error('invalid_repository_tree');
      seen.add(cwd);
      const target = (await read(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
      if (!target || parseTaskBranch(target)) throw new Error('invalid_local_target');
      const head = (await read(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
      const links = parseGitlinks((await read(cwd, ['ls-files', '-s'])).stdout);
      const children = [];
      for (const link of links) {
        const child = await walk(path.join(cwd, link.path), depth + 1);
        children.push({ link, child });
      }
      const refs = (await read(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/task/'])).stdout.trim().split('\n');
      const branches = refs.filter(b => parseTaskBranch(b)?.taskKey === taskId);
      const participates = branches.length > 0 || children.some(c => c.child.participates);
      const repo = { path: cwd, target, head, branches: [], participates };
      if (participates) {
        const merge = await read(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], [0, 1]);
        if (merge.status === 0) result.blockers.push({ code: 'merge_in_progress', path: cwd });
        const unresolved = (await read(cwd, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim();
        if (unresolved) result.blockers.push({ code: 'unresolved_conflicts', path: cwd });
        const worktrees = parseWorktreePorcelain((await read(cwd, ['worktree', 'list', '--porcelain'])).stdout);
        for (const branch of branches) {
          const count = (await read(cwd, ['rev-list', '--count', `${target}..${branch}`])).stdout.trim();
          if (!/^\d+$/.test(count)) throw new Error('invalid_ahead_count');
          const ahead = Number(count);
          repo.branches.push({ branch, ahead });
          if (ahead) result.blockers.push({ code: 'unmerged_branch', path: cwd, target, branch, ahead });
          for (const wt of worktrees.filter(w => w.branch === `refs/heads/${branch}` || w.branch === branch)) {
            const dirty = (await read(wt.path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'])).stdout.trim();
            if (dirty) result.blockers.push({ code: 'dirty_task_worktree', path: wt.path, branch });
          }
        }
        for (const { link, child } of children.filter(c => c.child.participates)) {
          // Check the committed tree, not the index: staging a pointer is not merging it.
          const committed = (await read(cwd, ['rev-parse', `HEAD:${link.path}`])).stdout.trim();
          if (committed !== child.head) result.blockers.push({ code: 'gitlink_mismatch', path: cwd, nested: link.path });
        }
      }
      result.repositories.push(repo); // Postorder: nested first, root last.
      return repo;
    };
    await walk(mainRoot);
    result.ready = result.blockers.length === 0;
  } catch {
    result.blockers.push({ code: 'git_verification_failed' });
  }
  return result;
}

async function completeVerifiedTask({ backend, projectRoot, taskId, resolution, git } = {}) {
  if (typeof resolution !== 'string' || !resolution.trim()) throw new Error('Resolution report required');
  const verification = await verifyTaskCompletion({ backend, projectRoot, taskId, git });
  if (!verification.ready) return { completed: false, verification };
  const task = await backend.getTask(taskId);
  if (!task) throw new Error('Task not found');
  // Resolve the actual workflow role. No legacy fallback can authorize a status write.
  const statuses = await backend.getStatuses({ refresh: true, strict: true });
  const complete = statuses.find(s => s.is_workflow_complete);
  if (!complete) throw new Error('Completion status unavailable');
  if (task.status !== complete.name) {
    await backend.createTaskComment(taskId, resolution.trim(), 'resolution');
    await backend.updateTask(taskId, { status: complete.name });
  }
  const saved = await backend.getTask(taskId);
  return { completed: saved?.status === complete.name, task: saved, verification };
}

// Remote MCP/REST writes bypass local tools. For an active terminal, do not announce
// successful completion when verification is unknown; retry on the next poll. A known
// merge violation reopens the task, with an actionable comment and no Git mutation.
async function guardCompletionTransition({ session, backend, projectRoot, git } = {}) {
  const verification = await verifyTaskCompletion({ backend, projectRoot, taskId: session.taskId, git });
  if (verification.ready) return { allowed: true, verification };
  if (!verification.verified) return { allowed: false, verification };
  const statuses = await backend.getStatuses({ refresh: true, strict: true });
  const reopen = statuses.find(s => s.name === 'on_fire') || statuses.find(s => s.is_in_progress);
  if (!reopen) return { allowed: false, verification };
  const task = await backend.updateTask(session.taskId, { status: reopen.name });
  const signature = JSON.stringify(verification.blockers);
  if (session._mergeViolation !== signature) {
    await backend.createTaskComment(session.taskId,
      `Automatic merge verification blocked completion. Merge the task branches into each original checkout's current branch, nested repositories first, preserve unrelated edits, and run the relevant checks before using complete_task. Verification: ${signature}`, 'comment');
    session._mergeViolation = signature;
  }
  return { allowed: false, task, verification };
}

async function checkCompletedTaskWorktrees({ projectRoot, taskId, git } = {}) {
  try {
    if (!projectRoot || !taskId) return { dirty: [] };
    const found = await findTaskWorktrees(projectRoot, taskId, git ? { git } : {});
    return { dirty: found.filter(w => (w.dirtyFileCount || 0) > 0), all: found };
  } catch {
    return { dirty: [] };
  }
}

async function warnIfCompletedWorktreeDirty({ session, backend, projectRoot, task, websocket, git } = {}) {
  try {
    if (!session || session._worktreeDirtyWarned) return null;
    session._worktreeDirtyWarned = true;
    const vcs = await fetchVcsSettings(backend);
    if (vcs.type !== 'git' || !vcs.worktree) return null;
    const { dirty } = await checkCompletedTaskWorktrees({ projectRoot, taskId: session.taskId, git });
    if (!dirty.length) return null;
    const title = task && task.title ? task.title : '';
    const payload = { taskId: session.taskId, worktrees: dirty, suggestedMessage: worktreeCommitMessage(session.taskId, title) };
    const ws = websocket || require('../websocket');
    if (typeof ws.emitWorktreeDirtyOnComplete === 'function') ws.emitWorktreeDirtyOnComplete(projectRoot, payload);
    console.warn(`[worktree] ${session.taskId} completed with uncommitted changes in ${dirty.map(d => d.path).join(', ')}`);
    return payload;
  } catch (err) {
    console.error('[worktree] completion guard failed:', err.message);
    return null;
  }
}

module.exports = { checkCompletedTaskWorktrees, warnIfCompletedWorktreeDirty, verifyTaskCompletion, completeVerifiedTask, guardCompletionTransition };
