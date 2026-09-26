'use strict';

// TPT345 — the merge executor. Events: 'progress', 'conflict', 'failed', 'done' ('failed'
// not 'error' — an unlistened EventEmitter 'error' throws). One MergeJob per project at a time (module-level `jobs`
// map is the single-flight guard; the project mutex is NOT held for the job's duration —
// a 10-minute lock would starve KB sync). Walks the plan from merge-plan.js; on the
// first real file conflict it stops with the repo left mid-merge (MERGE_HEAD in place)
// and hands off — never auto-picks a side. Gitlink-ONLY conflicts (root merge touching
// just the nested-repo pointer) are resolved deterministically to the child's merged
// HEAD, since that is always the right answer after nested-first ordering.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { runGit } = require('./git-runner');
const { gitlinkBumpMessage } = require('./task-branch');
const { buildConflictHandoff } = require('./handoff');
const { runRepoChecks, compareChecks, resolveNodeForChecks } = require('./checks');

const STATES = Object.freeze({ RUNNING: 'running', CONFLICT: 'conflict', DONE: 'done', FAILED: 'failed', ABORTED: 'aborted' });
const TERMINAL = new Set([STATES.DONE, STATES.FAILED, STATES.ABORTED]);
const MAX_LOG = 2000;

class MergeJobError extends Error {
  constructor(code, message, details) { super(message); this.name = 'MergeJobError'; this.code = code; this.details = details; }
}

class MergeJob extends EventEmitter {
  constructor({ projectRoot, repos, plan, options = {}, tasksByKey = new Map(), git = runGit, checksRunner, nodeResolver, logger = () => {} }) {
    super();
    this.jobId = crypto.randomUUID();
    this.projectRoot = projectRoot;
    this.repos = new Map(repos.map(r => [r.id, r]));
    this.steps = plan.map(s => ({ ...s }));
    this.options = { checks: { test: true, build: true, baseline: true, ...(options.checks || {}) }, commitEnabled: !!options.commitEnabled };
    this.tasksByKey = tasksByKey;
    this.git = git;
    this.checksRunner = checksRunner || runRepoChecks;
    this.nodeResolver = nodeResolver || resolveNodeForChecks;
    this.logger = logger;
    this.state = STATES.RUNNING;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.currentStep = 0;
    this.log = [];
    this.merged = {};        // repoId -> [taskKey]
    this.baseline = {};      // repoId -> phase result
    this.checks = {};        // repoId -> compareChecks report
    this.conflict = null;
    this.error = null;
    this.caveats = [];
    this.childHeads = {};    // repoId(parent) -> { nestedRelPath: sha } recorded at bump time
    this.repoStartSha = {};  // repoId -> HEAD before the first write step
    this._abortRequested = false;
    this._abortController = new AbortController();
    this._running = null;
    this._resolvedNode = null;
  }

  appendLog(line) {
    const stamp = new Date().toISOString().slice(11, 19);
    const entry = `[${stamp}] ${line}`;
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.logger(entry);
    return entry;
  }

  toJSON() {
    return {
      jobId: this.jobId, projectRoot: this.projectRoot, state: this.state,
      startedAt: this.startedAt, finishedAt: this.finishedAt, options: this.options,
      steps: this.steps.map(s => ({ index: s.index, kind: s.kind, repoId: s.repoId, repoRelPath: s.repoRelPath, branch: s.branch || null, taskKey: s.taskKey || null, target: s.target || null, label: s.label, status: s.status, mergeSha: s.mergeSha || null, gitlinkResolved: s.gitlinkResolved || null, error: s.error || null, startedAt: s.startedAt || null, finishedAt: s.finishedAt || null })),
      currentStep: this.currentStep, log: this.log.slice(-500),
      merged: this.merged, baseline: this.baseline, checks: this.checks,
      conflict: this.conflict, error: this.error ? this.error.message : null, errorCode: this.error ? this.error.code : null, caveats: this.caveats,
    };
  }

  _progress(step, message) {
    const payload = { jobId: this.jobId, state: this.state, stepIndex: step ? step.index : this.currentStep, total: this.steps.length, step: step ? this.toJSON().steps[step.index] : null, message: message || null };
    this.emit('progress', payload);
  }

  async _git(args, cwd, opts = {}) {
    return this.git(args, { cwd, signal: this._abortController.signal, ...opts });
  }

  async _gitOk(args, cwd, opts = {}) {
    const r = await this._git(args, cwd, opts);
    if (r.error || r.status !== 0) {
      const msg = r.error ? (r.timedOut ? 'timed out' : r.error.message) : `exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 600)}`;
      throw new MergeJobError('GIT_FAILED', `git ${args.join(' ')} ${msg}`, { args, cwd, status: r.status, stderr: r.stderr });
    }
    return r.stdout.replace(/\n$/, '');
  }

  // Deferred one tick so a caller can attach listeners after startJob() returns and still
  // see the first progress frame (or an immediate done on an empty plan).
  start() {
    if (this._running) return this._running;
    this._running = Promise.resolve().then(() => this._run()).catch((err) => this._fail(err));
    return this._running;
  }

  async _run() {
    while (this.currentStep < this.steps.length) {
      if (this._abortRequested) return this._finish(STATES.ABORTED);
      const step = this.steps[this.currentStep];
      if (step.status === 'done' || step.status === 'skipped') { this.currentStep++; continue; }
      step.status = 'running'; step.startedAt = Date.now();
      this._progress(step, `▶ ${step.label}`);
      this.appendLog(`▶ ${step.label}`);
      let outcome;
      try {
        outcome = await this._execute(step);
      } catch (err) {
        step.status = 'failed'; step.finishedAt = Date.now(); step.error = err.message;
        this.appendLog(`✕ ${step.label}: ${err.message}`);
        this._progress(step, err.message);
        return this._fail(err);
      }
      if (outcome && outcome.conflict) {
        step.status = 'failed'; step.finishedAt = Date.now(); step.error = 'conflict';
        this.state = STATES.CONFLICT;
        this.conflict = outcome.conflict;
        this.appendLog(`⚠ conflict in ${step.repoRelPath || 'root'} merging ${step.branch}: ${outcome.conflict.conflictedPaths.join(', ')}`);
        this._progress(step, 'conflict');
        this.emit('conflict', { jobId: this.jobId, conflict: this.conflict });
        return;
      }
      step.status = outcome && outcome.skipped ? 'skipped' : 'done';
      step.finishedAt = Date.now();
      this.appendLog(`${step.status === 'skipped' ? '–' : '✓'} ${step.label}${outcome && outcome.note ? ` — ${outcome.note}` : ''}`);
      this._progress(step, outcome && outcome.note ? outcome.note : null);
      this.currentStep++;
    }
    return this._finish(STATES.DONE);
  }

  _finish(state) {
    if (TERMINAL.has(this.state)) return;
    this.state = state;
    this.finishedAt = Date.now();
    const blocking = Object.values(this.checks).some(c => c && c.blocking);
    this.appendLog(state === STATES.DONE ? (blocking ? '■ finished — post-merge checks report NEW failures' : '■ finished') : `■ ${state}`);
    this.emit('done', { jobId: this.jobId, state, ok: state === STATES.DONE && !blocking, merged: this.merged, checks: this.checks, caveats: this.caveats, error: this.error ? this.error.message : null });
  }

  _fail(err) {
    if (TERMINAL.has(this.state)) return;
    this.error = { code: err.code || 'MERGE_FAILED', message: err.message, details: err.details || null };
    this.state = STATES.FAILED;
    this.finishedAt = Date.now();
    this.appendLog(`■ failed: ${err.message}`);
    this.emit('failed', { jobId: this.jobId, error: this.error.message, errorCode: this.error.code, details: this.error.details });
    this.emit('done', { jobId: this.jobId, state: this.state, ok: false, merged: this.merged, checks: this.checks, caveats: this.caveats, error: this.error.message });
  }

  async _execute(step) {
    switch (step.kind) {
      case 'baseline': return this._runChecks(step, 'baseline');
      case 'checks': return this._runChecks(step, 'post');
      case 'checkout-target': return this._checkoutTarget(step);
      case 'merge': return this._merge(step);
      case 'gitlink-bump': return this._gitlinkBump(step);
      case 'verify-gitlinks': return this._verifyGitlinks(step);
      default: throw new MergeJobError('UNKNOWN_STEP', `Unknown step kind ${step.kind}`);
    }
  }

  async _ensureNotMidMerge(step) {
    const r = await this._git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], step.repoPath);
    if (r.status === 0) throw new MergeJobError('REPO_MID_MERGE', `${step.repoRelPath || 'root'} is already in the middle of a merge`);
  }

  async _recordStart(step) {
    if (!this.repoStartSha[step.repoId]) this.repoStartSha[step.repoId] = await this._gitOk(['rev-parse', 'HEAD'], step.repoPath);
  }

  async _checkoutTarget(step) {
    await this._ensureNotMidMerge(step);
    await this._recordStart(step);
    if (step.create) {
      await this._gitOk(['checkout', '-b', step.target], step.repoPath);
      return { note: `created ${step.target}` };
    }
    await this._gitOk(['checkout', step.target], step.repoPath);
    return { note: `checked out ${step.target}` };
  }

  async _merge(step) {
    await this._ensureNotMidMerge(step);
    await this._recordStart(step);
    const r = await this._git(['merge', '--no-ff', '--no-edit', '-m', step.message, step.branch], step.repoPath, { timeoutMs: 120_000 });
    if (r.error) throw new MergeJobError('GIT_FAILED', `git merge ${step.branch}: ${r.timedOut ? 'timed out' : r.error.message}`);
    if (r.status === 0) {
      step.mergeSha = await this._gitOk(['rev-parse', 'HEAD'], step.repoPath);
      this._recordMerged(step);
      return { note: step.mergeSha.slice(0, 12) };
    }
    const mid = await this._git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], step.repoPath);
    if (mid.status !== 0) {
      // No MERGE_HEAD → git refused before touching anything (dirty overlap, unknown ref…)
      throw new MergeJobError('MERGE_REFUSED', `git merge ${step.branch} refused: ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
    }
    const u = await this._git(['diff', '--name-only', '--diff-filter=U'], step.repoPath);
    const conflictedPaths = u.status === 0 ? u.stdout.split('\n').filter(Boolean) : [];
    const childHeads = this.childHeads[step.repoId] || {};
    const gitlinkOnly = conflictedPaths.length > 0 && conflictedPaths.every(p => Object.prototype.hasOwnProperty.call(childHeads, p));
    if (gitlinkOnly) {
      for (const p of conflictedPaths) await this._gitOk(['update-index', '--cacheinfo', `160000,${childHeads[p]},${p}`], step.repoPath);
      await this._gitOk(['commit', '--no-edit'], step.repoPath);
      step.mergeSha = await this._gitOk(['rev-parse', 'HEAD'], step.repoPath);
      step.gitlinkResolved = conflictedPaths.map(p => ({ relPath: p, sha: childHeads[p] }));
      this.caveats.push(`gitlink conflict on ${conflictedPaths.join(', ')} while merging ${step.branch} auto-resolved to the merged nested HEAD`);
      this._recordMerged(step);
      return { note: `gitlink conflict auto-resolved (${conflictedPaths.join(', ')})` };
    }
    const repo = this.repos.get(step.repoId);
    const task = this.tasksByKey.get(step.taskKey) || null;
    const priorTasks = await this._priorTasks(step, conflictedPaths);
    const handoff = buildConflictHandoff({ repo, branch: step.branch, taskKey: step.taskKey, target: step.target, conflictedPaths, task: task ? { key: step.taskKey, title: task.title, description: task.description } : null, priorTasks, mergeMessage: step.message, commitEnabled: this.options.commitEnabled });
    return {
      conflict: {
        repoId: step.repoId, repoPath: step.repoPath, repoRelPath: step.repoRelPath, branch: step.branch, taskKey: step.taskKey, target: step.target,
        branchSha: step.branchSha || null, stepIndex: step.index, conflictedPaths, commitRange: handoff.ingredients.commitRange,
        task: handoff.ingredients.task, priorTasks: handoff.ingredients.priorTasks,
        manualCommands: handoff.manualCommands, handoffPrompt: handoff.prompt, autoResolvedGitlink: false,
      },
    };
  }

  _recordMerged(step) {
    if (!this.merged[step.repoId]) this.merged[step.repoId] = [];
    this.merged[step.repoId].push(step.taskKey);
  }

  // Tasks merged earlier in this run (same repo) whose branches touched any of the
  // conflicted paths — context for the hand-off prompt. Uses the scan's touchedFiles
  // (merge-base diff) rather than `git log -- <path>`, whose history simplification
  // drops clean merge commits.
  async _priorTasks(step, paths) {
    const repo = this.repos.get(step.repoId);
    const wanted = new Set(paths);
    const out = []; const seen = new Set();
    for (const prev of this.steps) {
      if (prev.index >= step.index || prev.kind !== 'merge' || prev.repoId !== step.repoId || prev.status !== 'done') continue;
      if (seen.has(prev.taskKey)) continue;
      const branch = ((repo && repo.taskBranches) || []).find(b => b.branch === prev.branch);
      const touched = branch ? branch.touchedFiles || [] : [];
      if (!touched.some(p => wanted.has(p))) continue;
      seen.add(prev.taskKey);
      const t = this.tasksByKey.get(prev.taskKey);
      out.push({ key: prev.taskKey, title: t ? t.title : '', description: t ? t.description : '' });
    }
    return out;
  }

  async _gitlinkBump(step) {
    await this._ensureNotMidMerge(step);
    await this._recordStart(step);
    const nestedHead = await this._gitOk(['rev-parse', 'HEAD'], step.nestedPath);
    if (!this.childHeads[step.repoId]) this.childHeads[step.repoId] = {};
    this.childHeads[step.repoId][step.nestedRelPath] = nestedHead;
    await this._gitOk(['update-index', '--cacheinfo', `160000,${nestedHead},${step.nestedRelPath}`], step.repoPath);
    const staged = await this._git(['diff', '--cached', '--quiet', '--', step.nestedRelPath], step.repoPath);
    if (staged.status === 0) return { skipped: true, note: `already at ${nestedHead.slice(0, 12)}` };
    await this._gitOk(['commit', '-m', gitlinkBumpMessage(step.nestedRelPath, nestedHead, step.keys || [])], step.repoPath);
    return { note: nestedHead.slice(0, 12) };
  }

  async _verifyGitlinks(step) {
    const notes = [];
    for (const n of step.nested || []) {
      const expected = (this.childHeads[step.repoId] || {})[n.nestedRelPath];
      if (!expected) continue;
      const r = await this._git(['ls-files', '-s', '--', n.nestedRelPath], step.repoPath);
      const m = /^160000 ([0-9a-f]+)/.exec(r.stdout || '');
      if (m && m[1] === expected) { notes.push(`${n.nestedRelPath} ok`); continue; }
      await this._gitOk(['update-index', '--cacheinfo', `160000,${expected},${n.nestedRelPath}`], step.repoPath);
      await this._gitOk(['commit', '-m', gitlinkBumpMessage(n.nestedRelPath, expected, [])], step.repoPath);
      this.caveats.push(`${n.nestedRelPath} pointer had to be re-recorded after the root merges (a task branch moved it elsewhere)`);
      notes.push(`${n.nestedRelPath} re-recorded`);
    }
    return { note: notes.join('; ') };
  }

  async _runChecks(step, phase) {
    const repo = this.repos.get(step.repoId);
    if (!this._resolvedNode) this._resolvedNode = await this.nodeResolver({ projectRoot: this.projectRoot });
    const enabled = { test: !!this.options.checks.test, build: !!this.options.checks.build };
    const result = await this.checksRunner({ repo, enabled, resolved: this._resolvedNode, signal: this._abortController.signal, onOutput: null });
    if (phase === 'baseline') {
      this.baseline[step.repoId] = result;
      const f = result.test ? result.test.failures.length : 0;
      return { note: result.error ? `skipped: ${result.error}` : `${f} pre-existing test failure(s)` };
    }
    const report = compareChecks(this.baseline[step.repoId], result);
    this.checks[step.repoId] = report;
    if (report.error) return { note: `skipped: ${report.error}` };
    const parts = [];
    if (report.test) parts.push(`tests: ${report.test.newFailures.length} new / ${report.test.preExisting.length} pre-existing failure(s)`);
    if (report.build) parts.push(`build: ${report.build.status === 0 ? 'ok' : 'FAILED'}`);
    return { note: parts.join(', ') };
  }

  // After the user (or an agent) resolved the conflict: no unmerged paths left → commit
  // (if MERGE_HEAD still there) → continue from the next step.
  async resume() {
    if (this.state !== STATES.CONFLICT || !this.conflict) throw new MergeJobError('NOT_IN_CONFLICT', 'The job is not waiting on a conflict');
    const c = this.conflict;
    const u = await this._git(['diff', '--name-only', '--diff-filter=U'], c.repoPath);
    const unmerged = u.status === 0 ? u.stdout.split('\n').filter(Boolean) : [];
    if (unmerged.length) throw new MergeJobError('STILL_CONFLICTED', `Unresolved conflicts remain in ${c.repoRelPath || 'root'}`, { conflictedPaths: unmerged });
    const mid = await this._git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], c.repoPath);
    if (mid.status === 0) {
      await this._gitOk(['commit', '--no-edit'], c.repoPath);
    } else {
      const parent2 = await this._git(['rev-parse', '-q', '--verify', 'HEAD^2'], c.repoPath);
      const branchSha = await this._git(['rev-parse', '-q', '--verify', c.branch], c.repoPath);
      if (parent2.status !== 0 || (branchSha.status === 0 && parent2.stdout.trim() !== branchSha.stdout.trim())) {
        throw new MergeJobError('MERGE_NOT_FOUND', `No merge of ${c.branch} is in progress or committed in ${c.repoRelPath || 'root'} — was it aborted by hand`);
      }
    }
    const step = this.steps[c.stepIndex];
    step.status = 'done'; step.finishedAt = Date.now(); step.error = null;
    step.mergeSha = await this._gitOk(['rev-parse', 'HEAD'], c.repoPath);
    this._recordMerged(step);
    this.appendLog(`✓ ${step.label} — conflict resolved, ${step.mergeSha.slice(0, 12)}`);
    this.conflict = null;
    this.state = STATES.RUNNING;
    this.currentStep = c.stepIndex + 1;
    this._progress(step, 'conflict resolved');
    // Continuation runs in the background (progress/done arrive via events); the caller
    // only awaits the validation + merge commit above.
    this._running = this._run().catch((err) => this._fail(err));
    return this.state;
  }

  async abort() {
    if (TERMINAL.has(this.state)) return this.state;
    this._abortRequested = true;
    if (this.state === STATES.CONFLICT && this.conflict) {
      const r = await this._git(['merge', '--abort'], this.conflict.repoPath, { signal: undefined });
      this.appendLog(r.status === 0 ? `merge --abort in ${this.conflict.repoRelPath || 'root'}` : `merge --abort failed: ${(r.stderr || '').trim().slice(0, 300)}`);
      this.conflict = null;
      this._finish(STATES.ABORTED);
      return this.state;
    }
    this._abortController.abort();
    // The running loop observes _abortRequested between steps; a step killed by the
    // signal surfaces as a failed git call → _fail → 'failed'. Normalize to aborted.
    try { await this._running; } catch { /* reported via events */ }
    if (this.state === STATES.FAILED) { this.state = STATES.ABORTED; }
    return this.state;
  }
}

const jobs = new Map(); // projectRoot -> MergeJob

function getJob(projectRoot) { return jobs.get(projectRoot) || null; }

function startJob(projectRoot, params) {
  const existing = jobs.get(projectRoot);
  if (existing && !TERMINAL.has(existing.state)) throw new MergeJobError('JOB_RUNNING', 'A merge is already running for this project', { jobId: existing.jobId, state: existing.state });
  const job = new MergeJob({ projectRoot, ...params });
  jobs.set(projectRoot, job);
  job.start();
  return job;
}

function clearJob(projectRoot) { jobs.delete(projectRoot); }

module.exports = { MergeJob, MergeJobError, STATES, jobs, getJob, startJob, clearJob };
