// (TPT345) Pure, DOM-free helpers behind merge-branches-modal.js — the "Merge task branches"
// panel. Same split as voice-model-state.js: everything that can be unit-tested under plain
// node lives here (selection defaults, blocker summaries, step upserts, view derivation), the
// modal only renders. No imports on purpose — the modal test imports this module directly.

// Repos in execution order: nested repos first (deeper relPath first, then alphabetical),
// the root repo last. Mirrors the server's merge-plan.js ordering so the panel's top-to-bottom
// reading order is the order the merge will actually run in.
export function orderedRepos(repos) {
  const list = Array.isArray(repos) ? repos.slice() : [];
  return list.sort((a, b) => {
    const ar = a?.kind === 'root' ? 1 : 0;
    const br = b?.kind === 'root' ? 1 : 0;
    if (ar !== br) return ar - br;
    const ad = String(a?.relPath || '').split('/').length;
    const bd = String(b?.relPath || '').split('/').length;
    if (ad !== bd) return bd - ad;
    return String(a?.relPath || '').localeCompare(String(b?.relPath || ''));
  });
}

// Initial selection from a status payload: one entry per repo, target = the server's
// suggested target (the main checkout's current branch), branches = those the server marked
// selectedByDefault (completed + unmerged, no blocking task state).
export function defaultSelections(status) {
  const repos = Array.isArray(status?.repos) ? status.repos : [];
  return repos.map((repo) => ({
    repoId: repo.id,
    target: repo.target || repo.currentBranch || '',
    createBranch: null,
    branches: (repo.taskBranches || []).filter((b) => !!b.selectedByDefault).map((b) => b.branch),
  }));
}

function _cloneSel(sel) {
  return { ...sel, branches: sel.branches.slice() };
}

export function toggleBranch(selections, repoId, branch, checked) {
  return (selections || []).map((sel) => {
    if (sel.repoId !== repoId) return sel;
    const next = _cloneSel(sel);
    const has = next.branches.includes(branch);
    if (checked && !has) next.branches.push(branch);
    if (!checked && has) next.branches = next.branches.filter((b) => b !== branch);
    return next;
  });
}

// `{ target }` picks an existing branch; `{ createBranch }` asks the server to create a new
// branch from the current HEAD (only offered while the current branch is the main branch).
export function setTarget(selections, repoId, { target = null, createBranch = null } = {}) {
  return (selections || []).map((sel) => {
    if (sel.repoId !== repoId) return sel;
    const next = _cloneSel(sel);
    if (createBranch !== null) {
      next.createBranch = String(createBranch);
    } else {
      next.createBranch = null;
      if (target !== null) next.target = String(target);
    }
    return next;
  });
}

// Stable signature of a selection set — key order and branch order don't matter, so a
// re-render that rebuilt the same choice doesn't invalidate a completed dry run.
export function selectionSignature(selections) {
  const rows = (selections || [])
    .map((sel) => ({
      repoId: String(sel.repoId),
      target: sel.createBranch != null ? '' : String(sel.target || ''),
      createBranch: sel.createBranch != null ? String(sel.createBranch) : null,
      branches: (sel.branches || []).slice().sort(),
    }))
    .sort((a, b) => a.repoId.localeCompare(b.repoId));
  return JSON.stringify(rows);
}

export function selectedCount(selections) {
  return (selections || []).reduce((n, sel) => n + (sel.branches ? sel.branches.length : 0), 0);
}

export function canCreateBranch(repo) {
  if (!repo) return false;
  if (typeof repo.canCreateBranch === 'boolean') return repo.canCreateBranch;
  return !!repo.mainBranch && repo.currentBranch === repo.mainBranch;
}

// Server-shaped request bodies. `selections` (wire) is the flat [{repoId, branch}] list;
// `targets` is keyed by repoId with either {branch} or {createBranch}.
export function toWireSelections(selections) {
  const out = [];
  for (const sel of selections || []) {
    for (const branch of sel.branches || []) out.push({ repoId: sel.repoId, branch });
  }
  return out;
}

export function toWireTargets(selections) {
  const out = {};
  for (const sel of selections || []) {
    if (sel.createBranch != null && String(sel.createBranch).trim()) {
      out[sel.repoId] = { createBranch: String(sel.createBranch).trim() };
    } else if (sel.target) {
      out[sel.repoId] = { branch: String(sel.target) };
    }
  }
  return out;
}

// Every blocker the panel should show, gathered from BOTH the status payload (repo-level +
// per-branch) and the dry-run payload (repo-level + per-branch), limited to selected branches
// for the per-branch ones. Each entry is `{ repoId, branch|null, ...blocker }`.
export function collectBlockers(status, dryRun, selections) {
  const out = [];
  const selectedFor = new Map((selections || []).map((s) => [s.repoId, new Set(s.branches || [])]));
  const push = (repoId, branch, list) => {
    for (const b of list || []) {
      if (!b || typeof b !== 'object') continue;
      out.push({ repoId, branch: branch || null, ...b });
    }
  };
  for (const repo of status?.repos || []) {
    const selected = selectedFor.get(repo.id);
    if (!selected || selected.size === 0) continue;
    push(repo.id, null, repo.blockers);
    for (const tb of repo.taskBranches || []) {
      if (!selected.has(tb.branch)) continue;
      push(repo.id, tb.branch, tb.blockers);
    }
  }
  for (const repo of dryRun?.repos || []) {
    const selected = selectedFor.get(repo.id);
    if (!selected || selected.size === 0) continue;
    push(repo.id, null, repo.blockers);
    const perBranch = repo.branchBlockers && typeof repo.branchBlockers === 'object' ? repo.branchBlockers : {};
    for (const [branch, list] of Object.entries(perBranch)) {
      if (!selected.has(branch)) continue;
      push(repo.id, branch, list);
    }
  }
  return dedupeBlockers(out);
}

function dedupeBlockers(list) {
  const seen = new Set();
  const out = [];
  for (const b of list) {
    const key = `${b.repoId}\u0000${b.branch || ''}\u0000${b.code}\u0000${(b.paths || []).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

// Severity decides, never the code: a new server-side 'block' blocker must gate the Run
// button without a client change.
export function summarizeBlockers(blockers) {
  const hard = [];
  const warnings = [];
  const infos = [];
  for (const b of blockers || []) {
    if (b.severity === 'block') hard.push(b);
    else if (b.severity === 'warn') warnings.push(b);
    else infos.push(b);
  }
  return { hard, warnings, infos, canRun: hard.length === 0 };
}

export function hasConflicts(dryRun) {
  return conflictRows(dryRun).length > 0;
}

// Flat list of predicted conflicts: `{ repoId, kind:'target'|'pair', a, b|null, paths }`.
export function conflictRows(dryRun) {
  const rows = [];
  for (const repo of dryRun?.repos || []) {
    for (const v of repo.versusTarget || []) {
      if (v.clean === false || (v.conflicts && v.conflicts.length)) {
        rows.push({ repoId: repo.id, kind: 'target', a: v.branch, b: repo.target || null, paths: v.conflicts || [] });
      }
    }
    for (const p of repo.pairwise || []) {
      if (p.clean === false || (p.conflicts && p.conflicts.length)) {
        rows.push({ repoId: repo.id, kind: 'pair', a: p.a, b: p.b, paths: p.conflicts || [] });
      }
    }
  }
  return rows;
}

// Predicted conflict paths for one branch (vs target and vs any other selected branch),
// for the per-row "Conflicts" cell.
export function branchConflictPaths(dryRun, repoId, branch) {
  const paths = new Set();
  for (const row of conflictRows(dryRun)) {
    if (row.repoId !== repoId) continue;
    if (row.a !== branch && row.b !== branch) continue;
    if (row.kind === 'target' && row.a !== branch) continue;
    for (const p of row.paths) paths.add(p);
  }
  return [...paths];
}

// Idempotent upsert keyed by `step.index` — the same frame applied twice yields the same
// list, and steps stay in index order regardless of arrival order.
export function upsertStep(steps, step) {
  if (!step || typeof step.index !== 'number') return Array.isArray(steps) ? steps.slice() : [];
  const list = (steps || []).filter((s) => s.index !== step.index);
  list.push({ ...step });
  list.sort((a, b) => a.index - b.index);
  return list;
}

export function appendLog(log, line, max = 500) {
  const list = Array.isArray(log) ? log.slice() : [];
  if (line == null || line === '') return list;
  list.push(String(line));
  if (list.length > max) list.splice(0, list.length - max);
  return list;
}

// Panel view for a server job snapshot (or the client's own accumulated job object).
export function viewForJob(job) {
  if (!job || !job.state) return null;
  if (job.state === 'conflict') return 'conflict';
  if (job.state === 'done') return 'done';
  if (job.state === 'failed' || job.state === 'aborted') return 'error';
  if (job.state === 'running') {
    const cur = (job.steps || []).find((s) => s.index === job.currentStep)
      || (job.steps || []).find((s) => s.status === 'running');
    if (cur && (cur.kind === 'checks' || cur.kind === 'baseline')) return 'checks';
    return 'running';
  }
  return null;
}

// Same suffix console-modal.js's buildTaskSessionPrompt() uses, so the handoff prompt that
// travels in the terminal WS URL reads identically to a truncated task description.
export function truncatePrompt(text, max) {
  const s = String(text || '');
  if (!(max > 0) || s.length <= max) return s;
  return s.slice(0, max) + '... (truncated)';
}

// Cleanup request body from a finished job: the merged branches per repo, so cleanup only
// touches branches this run actually integrated.
export function cleanupPayload(merged) {
  const selections = [];
  for (const [repoId, keys] of Object.entries(merged || {})) {
    for (const entry of keys || []) {
      const branch = typeof entry === 'string'
        ? (entry.startsWith('task/') ? entry : `task/${entry}`)
        : (entry?.branch || (entry?.taskKey ? `task/${entry.taskKey}` : null));
      if (branch) selections.push({ repoId, branch });
    }
  }
  return { selections };
}

export function publishEligible(status) {
  return !!status?.vcs?.pr;
}

// Row pill: merged → dirty → closed → open → orphan (no task row).
export function branchStateKey(branch) {
  if (!branch) return 'orphan';
  if (branch.ahead === 0) return 'merged';
  if (branch.worktree && branch.worktree.dirty) return 'dirty';
  if (!branch.task) return 'orphan';
  return branch.task.isClosed || branch.task.isComplete ? 'closed' : 'open';
}

// Merged-branch rows for the done view: `[{ repoId, key, branch }]` in repo order.
export function mergedRows(merged, repos) {
  const order = orderedRepos(repos).map((r) => r.id);
  const rows = [];
  for (const [repoId, keys] of Object.entries(merged || {})) {
    for (const entry of keys || []) {
      const key = typeof entry === 'string' ? entry.replace(/^task\//, '') : (entry?.taskKey || entry?.key || '');
      rows.push({ repoId, key, branch: key.startsWith('task/') ? key : `task/${key}` });
    }
  }
  rows.sort((a, b) => {
    const ai = order.indexOf(a.repoId);
    const bi = order.indexOf(b.repoId);
    if (ai !== bi) return ai - bi;
    return a.key.localeCompare(b.key, undefined, { numeric: true });
  });
  return rows;
}

// New-vs-baseline check outcome across repos, for the done view's summary line.
export function checksSummary(checks) {
  let newFailures = 0;
  let preExisting = 0;
  let blocking = false;
  let buildFailed = false;
  let ran = false;
  for (const repo of Object.values(checks || {})) {
    if (!repo) continue;
    if (repo.test) {
      ran = true;
      newFailures += (repo.test.newFailures || []).length;
      preExisting += (repo.test.preExisting || []).length;
      if (repo.test.blocking) blocking = true;
    }
    if (repo.build) {
      ran = true;
      if (repo.build.status !== 0 && repo.build.status != null) { buildFailed = true; blocking = true; }
    }
  }
  return { ran, newFailures, preExisting, blocking, buildFailed };
}
