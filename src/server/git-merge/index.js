'use strict';

// TPT345 — facade for the user-triggered task-branch merge flow, called by
// src/server/merge-routes.js. Every entry point re-checks the project's VCS setting
// (git only), loads task rows + status roles from the backend, and runs the read-only
// scan under the per-project mutex; the long-running MergeJob itself runs outside the
// lock (merge-job.js's jobs map is the single-flight guard).

const { withProjectLock } = require('../project-mutex');
const { fetchVcsSettings } = require('../vcs-settings');
const { fetchStatusRoles } = require('../status-roles');
const { runGit } = require('./git-runner');
const { scanProject, discoverRepos } = require('./repo-discovery');
const { applyPreflight, collectRunBlockers, shapeTask } = require('./preflight');
const { dryRunProject } = require('./dry-run');
const { buildPlan } = require('./merge-plan');
const { startJob, getJob, MergeJobError, STATES } = require('./merge-job');
const { publishProject } = require('./publish');
const { cleanupProject } = require('./cleanup');
const { parseWorktreePorcelain } = require('../../mcp/git-worktree');
const { worktreeCommitMessage } = require('./task-branch');

class MergeError extends Error {
  constructor(code, status, message, details) { super(message); this.name = 'MergeError'; this.code = code; this.status = status; this.details = details || null; }
}

function activeTaskKeysFor(sessions, projectRoot) {
  const keys = new Set();
  if (!sessions || typeof sessions.values !== 'function') return keys;
  for (const s of sessions.values()) {
    if (!s || s.type !== 'terminal' || !s.taskId) continue;
    if (!(s.alive || s._spawnPending)) continue;
    if (s.projectPath && projectRoot && s.projectPath !== projectRoot) continue;
    keys.add(s.taskId);
  }
  return keys;
}

async function loadContext({ projectRoot, backend, sessions }) {
  const vcs = await fetchVcsSettings(backend);
  if (vcs.type !== 'git') throw new MergeError('VCS_NOT_GIT', 409, `Version control is not git for this project (setting: ${vcs.type || 'off'})`);
  let rows = [];
  try { rows = backend && typeof backend.getTasksUnfiltered === 'function' ? await backend.getTasksUnfiltered() : []; } catch { rows = []; }
  const tasksByKey = new Map();
  for (const t of Array.isArray(rows) ? rows : []) if (t && t.id) tasksByKey.set(String(t.id), t);
  const roles = await fetchStatusRoles(backend);
  return { vcs, tasksByKey, roles, activeTaskKeys: activeTaskKeysFor(sessions, projectRoot) };
}

async function scanAndPreflight({ projectRoot, ctx, targets = {}, git, exec }) {
  const scan = await scanProject(projectRoot, { git, exec, targets });
  return applyPreflight(scan, { tasksByKey: ctx.tasksByKey, roles: ctx.roles, activeTaskKeys: ctx.activeTaskKeys, targets });
}

function jobPayload(projectRoot) {
  const job = getJob(projectRoot);
  return job ? job.toJSON() : null;
}

async function getMergeStatus({ projectRoot, backend, sessions, targets = {}, git, exec }) {
  const ctx = await loadContext({ projectRoot, backend, sessions });
  const scan = await withProjectLock(projectRoot, () => scanAndPreflight({ projectRoot, ctx, targets, git, exec }));
  // Only tasks that own a task/<KEY> branch appear; a missing key means "nothing to merge".
  const tasks = {};
  for (const repo of scan.repos) {
    for (const branch of repo.taskBranches) {
      const entry = tasks[branch.taskKey] || (tasks[branch.taskKey] = { unmerged: false });
      if (branch.ahead > 0) entry.unmerged = true;
    }
  }
  return { ok: true, git: scan.git, vcs: ctx.vcs, job: jobPayload(projectRoot), repos: scan.repos, tasks };
}

function normalizeSelections(selections) {
  if (!Array.isArray(selections)) throw new MergeError('BAD_REQUEST', 400, 'selections must be an array of { repoId, branch }');
  return selections.map(s => {
    if (!s || typeof s.repoId !== 'string' || typeof s.branch !== 'string') throw new MergeError('BAD_REQUEST', 400, 'each selection needs repoId and branch');
    return { repoId: s.repoId, branch: s.branch };
  });
}

function normalizeTargets(targets) {
  if (targets === undefined || targets === null) return {};
  if (typeof targets !== 'object' || Array.isArray(targets)) throw new MergeError('BAD_REQUEST', 400, 'targets must be an object keyed by repoId');
  const out = {};
  for (const [id, spec] of Object.entries(targets)) {
    if (!spec || typeof spec !== 'object') continue;
    if (typeof spec.createBranch === 'string' && spec.createBranch.trim()) {
      const name = spec.createBranch.trim();
      if (!/^[A-Za-z0-9._\-/]+$/.test(name) || name.startsWith('-') || name.includes('..')) throw new MergeError('BAD_REQUEST', 400, `invalid branch name ${name}`);
      out[id] = { createBranch: name };
    } else if (typeof spec.branch === 'string' && spec.branch.trim()) {
      out[id] = { branch: spec.branch.trim() };
    }
  }
  return out;
}

async function dryRun({ projectRoot, backend, sessions, selections, targets, git, exec }) {
  const ctx = await loadContext({ projectRoot, backend, sessions });
  const sel = normalizeSelections(selections);
  const tg = normalizeTargets(targets);
  return withProjectLock(projectRoot, async () => {
    const scan = await scanAndPreflight({ projectRoot, ctx, targets: tg, git, exec });
    const dr = await dryRunProject(scan, sel, { git, exec });
    const byId = new Map(scan.repos.map(r => [r.id, r]));
    return {
      ok: true,
      supported: dr.supported, reason: dr.reason,
      repos: dr.repos.map(r => {
        const repo = byId.get(r.id);
        const branchBlockers = {};
        for (const b of (repo && repo.taskBranches) || []) branchBlockers[b.branch] = b.blockers || [];
        return { ...r, blockers: repo ? repo.blockers : [], branchBlockers };
      }),
      runBlockers: collectRunBlockers(scan, sel),
    };
  });
}

async function commitWorktree({ projectRoot, backend, sessions, repoId, branch, force = false, git = runGit }) {
  const ctx = await loadContext({ projectRoot, backend, sessions });
  if (typeof repoId !== 'string' || typeof branch !== 'string') throw new MergeError('BAD_REQUEST', 400, 'repoId and branch are required');
  return withProjectLock(projectRoot, async () => {
    const repos = await discoverRepos(projectRoot, { git });
    const repo = repos.find(r => r.id === repoId);
    if (!repo) throw new MergeError('UNKNOWN_REPO', 404, `Unknown repository ${repoId}`);
    const list = await git(['worktree', 'list', '--porcelain'], { cwd: repo.path });
    const wt = (list.status === 0 ? parseWorktreePorcelain(list.stdout) : []).find(w => w.branch && w.branch.replace(/^refs\/heads\//, '') === branch);
    if (!wt) throw new MergeError('NO_WORKTREE', 404, `No worktree checked out on ${branch} in ${repoId}`);
    const m = /^task\/([A-Z]+\d+)/.exec(branch);
    const taskKey = m ? m[1] : null;
    const task = shapeTask(taskKey ? ctx.tasksByKey.get(taskKey) : null, ctx.roles);
    if (!force && !(task && task.isComplete)) throw new MergeError('NOT_COMPLETED', 409, `Task ${taskKey || branch} is not completed — pass force to commit anyway`);
    const status = await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'], { cwd: wt.path });
    if (status.status === 0 && !status.stdout.trim()) throw new MergeError('WORKTREE_CLEAN', 400, `${wt.path} has nothing to commit`);
    const message = worktreeCommitMessage(taskKey || branch, task ? task.title : '');
    const add = await git(['add', '-A'], { cwd: wt.path });
    if (add.status !== 0) throw new MergeError('GIT_FAILED', 500, `git add failed: ${(add.stderr || '').trim().slice(0, 500)}`);
    const commit = await git(['commit', '-m', message], { cwd: wt.path, timeoutMs: 60_000 });
    if (commit.status !== 0) throw new MergeError('GIT_FAILED', 500, `git commit failed: ${(commit.stderr || commit.stdout || '').trim().slice(0, 500)}`);
    const sha = await git(['rev-parse', 'HEAD'], { cwd: wt.path });
    return { ok: true, repoId, branch, sha: sha.status === 0 ? sha.stdout.trim() : null, message };
  });
}

function wireJobEvents(job, projectRoot, emitters) {
  const ws = emitters || require('../websocket');
  job.on('progress', p => ws.emitMergeProgress && ws.emitMergeProgress(projectRoot, p));
  job.on('conflict', p => ws.emitMergeConflict && ws.emitMergeConflict(projectRoot, p));
  job.on('done', p => ws.emitMergeDone && ws.emitMergeDone(projectRoot, p));
  job.on('failed', p => ws.emitMergeError && ws.emitMergeError(projectRoot, p));
}

async function startMergeRun({ projectRoot, backend, sessions, selections, taskKey, targets, checks, git, exec, emitters, checksRunner, nodeResolver }) {
  const ctx = await loadContext({ projectRoot, backend, sessions });
  let sel = taskKey === undefined ? normalizeSelections(selections) : null;
  if (taskKey !== undefined) {
    if (typeof taskKey !== 'string' || !/^[A-Z]+\d+$/.test(taskKey)) throw new MergeError('BAD_REQUEST', 400, 'A valid taskKey is required');
    if (!ctx.tasksByKey.has(taskKey)) throw new MergeError('TASK_NOT_FOUND', 404, `Unknown task ${taskKey}`);
    if (ctx.vcs.merge) throw new MergeError('AUTO_MERGE_ENABLED', 409, 'Automatic worktree merging is enabled');
  }
  const tg = normalizeTargets(targets);
  const existing = getJob(projectRoot);
  if (existing && existing.state !== STATES.DONE && existing.state !== STATES.FAILED && existing.state !== STATES.ABORTED) {
    throw new MergeError('JOB_RUNNING', 409, 'A merge is already running for this project', { jobId: existing.jobId, state: existing.state });
  }
  const { scan, plan } = await withProjectLock(projectRoot, async () => {
    const s = await scanAndPreflight({ projectRoot, ctx, targets: tg, git, exec });
    if (taskKey !== undefined) {
      sel = s.repos.flatMap(repo => repo.taskBranches
        .filter(branch => branch.taskKey === taskKey && branch.ahead > 0)
        .map(branch => ({ repoId: repo.id, branch: branch.branch })));
    }
    const blockers = collectRunBlockers(s, sel);
    if (blockers.length) throw new MergeError('PREFLIGHT_BLOCKED', 409, 'Preflight blockers must be resolved before merging', { blockers });
    const p = buildPlan({ repos: s.repos, selections: sel, targets: tg, checks: { test: true, build: true, baseline: true, ...(checks || {}) } });
    if (!p.some(step => step.kind === 'merge')) throw new MergeError('NOTHING_TO_MERGE', 400, 'No mergeable branches selected');
    return { scan: s, plan: p };
  });
  let job;
  try {
    job = startJob(projectRoot, { repos: scan.repos, plan, options: { checks, commitEnabled: ctx.vcs.commit }, tasksByKey: ctx.tasksByKey, git: git || runGit, checksRunner, nodeResolver, logger: (l) => console.log(`[merge ${projectRoot}] ${l}`) });
  } catch (err) {
    if (err instanceof MergeJobError && err.code === 'JOB_RUNNING') throw new MergeError('JOB_RUNNING', 409, err.message, err.details);
    throw err;
  }
  wireJobEvents(job, projectRoot, emitters);
  return { ok: true, jobId: job.jobId, state: job.state, plan: job.toJSON().steps };
}

function getJobState({ projectRoot }) { return { ok: true, job: jobPayload(projectRoot) }; }

async function abortJob({ projectRoot, backend, sessions, git = runGit }) {
  await loadContext({ projectRoot, backend, sessions });
  const job = getJob(projectRoot);
  if (job) { const state = await job.abort(); return { ok: true, state, jobId: job.jobId }; }
  // Standalone abort (server restarted mid-job): back out any repo left mid-merge.
  const aborted = [];
  for (const repo of await discoverRepos(projectRoot, { git })) {
    const mid = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repo.path });
    if (mid.status !== 0) continue;
    const r = await git(['merge', '--abort'], { cwd: repo.path });
    if (r.status === 0) aborted.push(repo.id);
  }
  return { ok: true, state: 'aborted', standalone: true, aborted };
}

async function resumeJob({ projectRoot, backend, sessions }) {
  await loadContext({ projectRoot, backend, sessions });
  const job = getJob(projectRoot);
  if (!job) throw new MergeError('NO_JOB', 409, 'No merge job to resume (the server may have restarted — abort or finish the merge by hand, then rescan)');
  try {
    await job.resume(); // validates + commits the resolved merge; the continuation runs in the background
  } catch (err) {
    if (err instanceof MergeJobError) throw new MergeError(err.code, 409, err.message, err.details);
    throw err;
  }
  return { ok: true, jobId: job.jobId, state: job.state };
}

async function publish({ projectRoot, backend, sessions, repoIds, pr = true, bases = {}, targets, git, exec }) {
  const ctx = await loadContext({ projectRoot, backend, sessions });
  if (pr && !ctx.vcs.pr) throw new MergeError('PR_DISABLED', 409, 'Pull requests are not enabled for this project (Version control ▸ pull requests)');
  const tg = normalizeTargets(targets);
  const job = getJob(projectRoot);
  return withProjectLock(projectRoot, async () => {
    const scan = await scanAndPreflight({ projectRoot, ctx, targets: tg, git, exec });
    const res = await publishProject({ repos: scan.repos, merged: job ? job.merged : {}, tasksByKey: ctx.tasksByKey, pr, bases: bases || {}, repoIds: Array.isArray(repoIds) && repoIds.length ? repoIds : null, git: git || runGit, exec });
    return { ok: true, ...res };
  });
}

async function cleanup({ projectRoot, backend, sessions, selections, git, exec }) {
  const ctx = await loadContext({ projectRoot, backend, sessions });
  const sel = normalizeSelections(selections);
  return withProjectLock(projectRoot, async () => {
    const scan = await scanAndPreflight({ projectRoot, ctx, git, exec });
    const res = await cleanupProject({ repos: scan.repos, selections: sel, git: git || runGit });
    return { ok: true, ...res };
  });
}

module.exports = { MergeError, getMergeStatus, dryRun, commitWorktree, startMergeRun, getJobState, abortJob, resumeJob, publish, cleanup, loadContext, normalizeSelections, normalizeTargets, activeTaskKeysFor };
