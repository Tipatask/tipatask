'use strict';

// Strict automatic-merge verification and guarded task completion. With commits on,
// guarded completion also requires the task's own commit: instead of the merge walk when
// automatic merge is off, after it when merge is on. The legacy dirty worktree
// notification below remains best-effort when merge is disabled.

const { findTaskWorktrees } = require('./repo-discovery');
const { fetchVcsSettings } = require('../vcs-settings');
const { worktreeCommitMessage } = require('./task-branch');
const { parseTaskBranch } = require('./task-branch');
const { parseWorktreePorcelain, parseGitlinks } = require('../../mcp/git-worktree');
const { runGit } = require('./git-runner');
const { readVcsContext } = require('../vcs-context');
const { isTaskKeyLike, isLegacyTaskKey } = require('../task-key-format');
const fs = require('node:fs');
const path = require('node:path');

// A task commit's subject starts with the key followed by a non-key character, so TPT5
// never claims "TPT57 …" and a slug key never claims a longer slug.
function isTaskCommitSubject(subject, taskId) {
  return subject.startsWith(taskId) && !/^[A-Za-z0-9_-]/.test(subject.slice(taskId.length));
}

// The newest task commit reachable from cwd's HEAD, or null. verifyTaskCompletion()
// validates keys to [A-Za-z0-9_-], so the key is literal in this ERE. --grep matches any
// message line; only the subject counts.
async function findTaskCommit(read, cwd, taskId) {
  const grep = `--grep=^${taskId}([^A-Za-z0-9_-]|$)`;
  const log = (await read(cwd, ['log', '-n', '200', '--no-show-signature', '--format=%H %s', '-E', grep, 'HEAD'])).stdout;
  for (const line of log.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0 && isTaskCommitSubject(line.slice(sp + 1), taskId)) return line.slice(0, sp);
  }
  return null;
}

// Commit-first wording; with worktrees and automatic merge on, the merge follows the commit.
function taskCommitMissing(taskId, { worktree, merge }) {
  const enabled = merge ? 'Commits and automatic merge are enabled' : 'Commits are enabled';
  return { code: 'TASK_COMMIT_MISSING',
    message: worktree
      ? `${enabled} for this project and no commit for ${taskId} was found: commit the task changes in the task worktree on task/${taskId} with a message starting with ${taskId}${merge ? `, then merge task/${taskId} into each original checkout's current branch,` : ''} before completing the task.`
      : `${enabled} for this project and no commit starting with ${taskId} is reachable from the main checkout HEAD: git add the task changes and commit them with a message starting with ${taskId} before completing the task.` };
}

// Commits on, automatic merge off: completion needs the task's own commit in the original
// checkout or a checked-out nested repo. Main-checkout working trees are never read, so
// unrelated edits there never block.
async function verifyTaskCommit({ read, mainRoot, taskId, legacyKey, worktree, result }) {
  const repos = [];
  const seen = new Set();
  const collect = async (cwd, depth = 0) => {
    if (depth > 10 || seen.has(cwd)) throw new Error('invalid_repository_tree');
    seen.add(cwd);
    for (const link of parseGitlinks((await read(cwd, ['ls-files', '-s'])).stdout)) {
      const child = path.join(cwd, link.path);
      if (fs.existsSync(path.join(child, '.git'))) await collect(child, depth + 1); // Uncloned gitlinks hold no commits.
    }
    repos.push(cwd); // Postorder: nested first, root last.
  };
  await collect(mainRoot);
  let committed = false;
  for (const cwd of repos) {
    const repo = { path: cwd, taskCommit: await findTaskCommit(read, cwd, taskId), branches: [] };
    // Also covers a worktree task branch that is already merged (0 ahead).
    if (repo.taskCommit) committed = true;
    if (worktree) { // Worktrees off: task branches never count.
      const refs = (await read(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/task/'])).stdout.trim().split('\n');
      const branches = refs.filter(b => (legacyKey ? b === `task/${taskId}` : parseTaskBranch(b)?.taskKey === taskId));
      // Entry 0 is the main checkout; a prunable entry has no directory left to be dirty.
      const worktrees = branches.length
        ? parseWorktreePorcelain((await read(cwd, ['worktree', 'list', '--porcelain'])).stdout).slice(1).filter(w => !w.prunable)
        : [];
      for (const branch of branches) {
        const count = (await read(cwd, ['rev-list', '--count', `HEAD..${branch}`])).stdout.trim();
        if (!/^\d+$/.test(count)) throw new Error('invalid_ahead_count');
        const ahead = Number(count);
        repo.branches.push({ branch, ahead });
        if (ahead) committed = true;
        for (const wt of worktrees.filter(w => w.branch === `refs/heads/${branch}` || w.branch === branch)) {
          const dirty = (await read(wt.path, ['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=all'])).stdout.trim();
          if (dirty) {
            result.blockers.push({ code: 'TASK_WORKTREE_DIRTY', path: wt.path, branch,
              message: `Commits are enabled for this project: commit the tracked changes in ${wt.path} on ${branch} with a message starting with ${taskId} before completing the task.` });
          }
        }
      }
    }
    result.repositories.push(repo);
  }
  if (!committed) result.blockers.push(taskCommitMissing(taskId, { worktree, merge: false }));
}

// Commits and automatic merge on, after the merge walk: a task branch with commits ahead is
// already an unmerged_branch blocker; otherwise a task commit must be reachable from a
// walked repo's main checkout HEAD, which covers a merged task branch and a commit made on
// the current branch. Main-checkout working trees are not read here either.
async function verifyMergeModeCommit({ read, taskId, worktree, result }) {
  let committed = false;
  for (const repo of result.repositories) {
    repo.taskCommit = await findTaskCommit(read, repo.path, taskId);
    if (repo.taskCommit || repo.branches.some(b => b.ahead)) committed = true;
  }
  if (!committed) result.blockers.push(taskCommitMissing(taskId, { worktree, merge: true }));
}

// Read-only and strict: unlike the merge panel's best-effort inventory, a failed Git
// read must never look like zero outstanding commits. No network/forge discovery.
async function verifyTaskCompletion({ backend, projectRoot, taskId, git = runGit, requireCommit = true } = {}) {
  const context = await readVcsContext(backend);
  const result = { ...context, ready: false, repositories: [], blockers: [] };
  if (!context.verified) {
    result.blockers.push({ code: context.reason });
    return result;
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    result.blockers.push({ code: 'invalid_task_key' });
    return result;
  }
  // Legacy slug keys (e.g. "C-kb-docs-site") predate the strict prefix+number contract but
  // exist in the API; accept them only when the project actually returns the task.
  const legacyKey = !isTaskKeyLike(taskId);
  if (legacyKey) {
    if (!isLegacyTaskKey(taskId)) {
      result.blockers.push({ code: 'invalid_task_key' });
      return result;
    }
    let found = null;
    try {
      found = await backend.getTask(taskId);
    } catch {
      result.blockers.push({ code: 'task_lookup_failed' });
      return result;
    }
    if (!found) {
      result.blockers.push({ code: 'unknown_task_key' });
      return result;
    }
  }
  // Commits on: the task commit is required instead of the merge walk (merge off) or after
  // it (merge on). The terminal monitor passes requireCommit: false.
  const checkCommit = requireCommit && context.vcs.commit;
  if (context.vcs.type !== 'git' || !(context.vcs.merge || checkCommit)) {
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
      // parseTaskBranch only understands prefix+number keys; a slug key's branch is the
      // exact `task/<key>` (no suffix matching, so "C-kb-docs" never claims "C-kb-docs-site").
      const branches = refs.filter(b => (legacyKey ? b === `task/${taskId}` : parseTaskBranch(b)?.taskKey === taskId));
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
    if (!context.vcs.merge) await verifyTaskCommit({ read, mainRoot, taskId, legacyKey, worktree: context.vcs.worktree, result });
    else {
      await walk(mainRoot);
      if (checkCommit) await verifyMergeModeCommit({ read, taskId, worktree: context.vcs.worktree, result });
    }
    result.ready = result.blockers.length === 0;
  } catch {
    result.blockers.push({ code: 'git_verification_failed' });
  }
  return result;
}

// True when the task already carries this exact report, so a retried call (a lost tool response,
// a status write that failed after the comment, a report already posted while completion was
// blocked) does not post it twice. An unreadable comment list counts as no match: a duplicate
// beats a lost report.
async function hasComment(backend, taskId, content) {
  try {
    const comments = typeof backend.getTaskComments === 'function' ? await backend.getTaskComments(taskId) : null;
    return Array.isArray(comments) && comments.some(c => typeof c?.content === 'string' && c.content.trim() === content);
  } catch {
    return false;
  }
}

async function completeVerifiedTask({ backend, projectRoot, taskId, resolution, git } = {}) {
  if (typeof resolution !== 'string' || !resolution.trim()) throw new Error('Resolution report required');
  const verification = await verifyTaskCompletion({ backend, projectRoot, taskId, git });
  if (!verification.ready) return { completed: false, resolutionPosted: false, verification };
  const task = await backend.getTask(taskId);
  if (!task) throw new Error('Task not found');
  // Resolve the actual workflow role. No legacy fallback can authorize a status write.
  const statuses = await backend.getStatuses({ refresh: true, strict: true });
  const complete = statuses.find(s => s.is_workflow_complete);
  if (!complete) throw new Error('Completion status unavailable');
  // The report is posted even when the task is already complete (a merge hand-off or re-run
  // session must not lose its report); only the status write is skipped then.
  const report = resolution.trim();
  const resolutionPosted = !(await hasComment(backend, taskId, report));
  if (resolutionPosted) await backend.createTaskComment(taskId, report, 'resolution');
  if (task.status !== complete.name) await backend.updateTask(taskId, { status: complete.name });
  const saved = await backend.getTask(taskId);
  return { completed: saved?.status === complete.name, resolutionPosted, task: saved, verification };
}

// Remote MCP/REST writes bypass local tools. For an active terminal, do not announce
// successful completion when verification is unknown; retry on the next poll. A known
// merge violation reopens the task, with an actionable comment and no Git mutation.
async function guardCompletionTransition({ session, backend, projectRoot, git } = {}) {
  // Merge only: the task-commit requirement is enforced by complete_task / tt complete, so a
  // remote completion in a commits-on, merge-off project is announced without Git reads, and
  // TASK_COMMIT_MISSING never reopens a merge-on task.
  const verification = await verifyTaskCompletion({ backend, projectRoot, taskId: session.taskId, git, requireCommit: false });
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
