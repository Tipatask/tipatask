// (TPT345) "Merge task branches" panel — the user-triggered flow that integrates the
// `task/<KEY>` worktree branches agents leave behind (root repo + every nested repo) into a
// target branch. Reached from the Electron Project menu ('merge-branches' project:menu action)
// and from Settings ▸ Version Control (#settings-vcs-merge-btn). Git itself runs in the Task
// App server (src/server/git-merge/); this module only renders and calls api.merge.*.
//
// Shell mirrors agents-modal.js: own positioning class `.merge-modal` (never `.setup-modal`,
// which setup-modal.js removes on every repaint), the wizard's unscoped `.setup-modal-*` CSS
// for chrome, activateDialogFocus(), a capture-phase Escape that stops propagation so the
// underlying Settings modal doesn't also close, and an `owningOverlay` guard after every await.
//
// Node-importable on purpose (merge-branches-modal.test.js): module scope only declares state;
// every DOM access is inside a function. openTerminal is reached through window.TipTask at call
// time rather than a static console-modal.js import, so this module never pulls the xterm CSS
// chain into a plain-node import (same reasoning as attention-ws.js).
//
// Hide vs close: "Hide" during a run removes the DOM but keeps the job state — server frames
// keep arriving through handleMergeWsMessage() and drive a progress toast until the panel is
// reopened. Reopening always refetches GET /api/project/merge/status and adopts the server's
// `job` snapshot, so the server stays the source of truth after a hide or a page reload.
import { api } from './api-client.js';
import { escapeAttr, showToast, showProgressToast } from './utils.js';
import { t, tc } from './i18n.js';
import { showActionConfirm } from './action-confirm.js';
import { activateDialogFocus } from './dialog-focus.js';
import { pushNotification } from './notification-center.js';
import state from './state.js';
import { MAX_DESC_LEN } from './constants.js';
import {
  orderedRepos, defaultSelections, toggleBranch, setTarget, selectionSignature, selectedCount,
  canCreateBranch, toWireSelections, toWireTargets, collectBlockers, summarizeBlockers,
  conflictRows, branchConflictPaths, upsertStep, appendLog, viewForJob, truncatePrompt,
  cleanupPayload, publishEligible, branchStateKey, mergedRows, checksSummary,
} from './merge-branches-model.js';

let _overlay = null;
let _keyHandler = null;
let _focusHandle = null;
let _view = 'idle';
let _status = null;
let _selections = [];
let _dryRun = null;
let _dryRunSig = null;
let _checks = { test: true, build: true, baseline: true };
let _job = null;
let _publish = null;
let _cleanup = null;
let _busy = false;
let _busyKind = '';
let _msg = '';
let _jobToast = null;
let _lastToastJobId = null;
let _logPinned = true;

export function openMergeBranchesModal() {
  if (_overlay) {
    _focusHandle?.close?.();
    _renderShell();
  } else {
    _renderShell();
  }
  _focusHandle = activateDialogFocus({ root: _overlay, initialFocus: '.setup-modal-close' });
  if (!_keyHandler) {
    _keyHandler = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    document.addEventListener('keydown', _keyHandler, { capture: true });
  }
  _load();
}

export function closeMergeBranchesModal() { close(); }

// Test seam: drops every module singleton (no DOM touched).
export function _resetMergeModalForTests() {
  _overlay = null; _keyHandler = null; _focusHandle = null; _view = 'idle'; _status = null;
  _selections = []; _dryRun = null; _dryRunSig = null; _checks = { test: true, build: true, baseline: true };
  _job = null; _publish = null; _cleanup = null; _busy = false; _busyKind = ''; _msg = ''; _jobToast = null;
  _lastToastJobId = null; _logPinned = true;
}

function close() {
  if (_overlay) { _overlay.remove(); _overlay = null; }
  if (_keyHandler) { document.removeEventListener('keydown', _keyHandler, { capture: true }); _keyHandler = null; }
  _focusHandle?.close?.();
  _focusHandle = null;
  // A job in flight keeps reporting through the toast while the panel is hidden.
  if (_job && (_job.state === 'running') && !_jobToast) {
    try { _jobToast = showProgressToast(t('merge.toastRunning')); } catch (_) { _jobToast = null; }
  }
}

// ── WS frames ─────────────────────────────────────────────────────────────────────────────
// Returns true iff the frame was a merge frame (handled or not) so callers can `return`.
// Idempotent: the same frame applied twice yields the same state (upsertStep is keyed by
// step index, terminal toasts are deduped per jobId).
export function handleMergeWsMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type === 'worktree-dirty-on-complete') {
    _notifyWorktreeDirty(msg);
    return true;
  }
  if (!msg.type.startsWith('merge:')) return false;
  if (['merge:done', 'merge:error', 'merge:conflict'].includes(msg.type) && typeof document !== 'undefined') {
    document.dispatchEvent(new document.defaultView.CustomEvent('tiptask:merge-status-changed'));
  }
  if (!_job || (msg.jobId && _job.jobId !== msg.jobId)) {
    _job = { jobId: msg.jobId || null, state: 'running', steps: [], log: [], merged: {}, checks: null, conflict: null, error: null, caveats: [] };
  }
  if (msg.type === 'merge:progress') {
    if (msg.step && typeof msg.step.index === 'number') {
      _job.steps = upsertStep(_job.steps, msg.step);
      _job.currentStep = msg.step.index;
    }
    if (typeof msg.total === 'number') _job.total = msg.total;
    if (msg.message) _job.log = appendLog(_job.log, msg.message);
    _job.state = 'running';
    _view = viewForJob(_job) || 'running';
    if (_jobToast && msg.step?.label) { try { _jobToast.update(msg.step.label); } catch (_) { /* gone */ } }
  } else if (msg.type === 'merge:conflict') {
    _job.conflict = msg.conflict || null;
    _job.state = 'conflict';
    _view = 'conflict';
    if (_jobToast) { try { _jobToast.fail(t('merge.toastConflict')); } catch (_) { /* gone */ } _jobToast = null; }
    if (_lastToastJobId !== `${_job.jobId}:conflict`) {
      _lastToastJobId = `${_job.jobId}:conflict`;
      if (!_overlay) showToast(t('merge.toastConflict'), 'error');
    }
  } else if (msg.type === 'merge:done') {
    _job.state = msg.state || 'done';
    if (msg.merged) _job.merged = msg.merged;
    if (msg.checks) _job.checks = msg.checks;
    if (Array.isArray(msg.caveats)) _job.caveats = msg.caveats;
    _view = viewForJob(_job) || 'done';
    const ok = _job.state === 'done';
    if (_lastToastJobId !== `${_job.jobId}:done`) {
      _lastToastJobId = `${_job.jobId}:done`;
      if (_jobToast) {
        try { ok ? _jobToast.done(t('merge.toastDone')) : _jobToast.fail(t('merge.toastDoneErrors')); } catch (_) { /* gone */ }
        _jobToast = null;
      } else {
        showToast(ok ? t('merge.toastDone') : t('merge.toastDoneErrors'), ok ? 'success' : 'error');
      }
    }
  } else if (msg.type === 'merge:error') {
    _job.state = 'failed';
    _job.error = msg.error || msg.message || 'error';
    _view = 'error';
    if (_lastToastJobId !== `${_job.jobId}:error`) {
      _lastToastJobId = `${_job.jobId}:error`;
      if (_jobToast) { try { _jobToast.fail(t('merge.errGeneric', { msg: _job.error })); } catch (_) { /* gone */ } _jobToast = null; }
      else showToast(t('merge.errGeneric', { msg: _job.error }), 'error');
    }
  }
  if (_overlay) _render();
  return true;
}

function _notifyWorktreeDirty(msg) {
  const key = msg.taskId || msg.taskKey || '';
  const body = (msg.worktrees || []).map((w) => `${w.path || w.repoId || ''}${w.dirtyFileCount != null ? ` (${w.dirtyFileCount})` : ''}`).join('\n');
  try {
    pushNotification({
      tag: `worktree-dirty:${key}`,
      title: t('merge.worktreeDirtyOnComplete', { key }),
      body,
      category: 'merge',
      onClick: () => { try { openMergeBranchesModal(); } catch (_) { /* no DOM */ } },
    });
  } catch (_) {
    try { showToast(t('merge.worktreeDirtyOnComplete', { key }), 'error'); } catch (_e) { /* no DOM */ }
  }
}

// ── Shell ─────────────────────────────────────────────────────────────────────────────────
function _renderShell() {
  const existing = document.querySelector('.merge-modal');
  if (existing) existing.remove();

  _overlay = document.createElement('div');
  _overlay.className = 'merge-modal';
  _overlay.setAttribute('role', 'dialog');
  _overlay.setAttribute('aria-modal', 'true');
  _overlay.setAttribute('aria-labelledby', 'merge-modal-title');
  _overlay.innerHTML = `
    <div class="setup-modal-backdrop"></div>
    <div class="setup-modal-panel merge-modal-panel">
      <div class="setup-modal-header">
        <span class="setup-modal-title" id="merge-modal-title">${escapeAttr(t('merge.title'))}</span>
        <div class="merge-modal-steps" id="merge-modal-steps"></div>
        <button class="setup-modal-close" type="button" aria-label="${escapeAttr(t('btn.close'))}">&times;</button>
      </div>
      <div class="setup-modal-step-body merge-modal-body" id="merge-modal-body" data-view="idle"></div>
      <div class="setup-modal-footer" id="merge-modal-footer"></div>
    </div>
  `;
  document.body.appendChild(_overlay);
  _overlay.querySelector('.setup-modal-close').addEventListener('click', close);
  _overlay.querySelector('.setup-modal-backdrop').addEventListener('click', close);
  const body = _overlay.querySelector('#merge-modal-body');
  const footer = _overlay.querySelector('#merge-modal-footer');
  body.addEventListener('click', _onBodyClick);
  body.addEventListener('change', _onBodyChange);
  body.addEventListener('input', _onBodyInput);
  body.addEventListener('scroll', _onBodyScroll, true);
  footer.addEventListener('click', _onFooterClick);
}

async function _load({ keepSelections = false } = {}) {
  const owningOverlay = _overlay;
  _view = 'scanning';
  _msg = '';
  _render();
  let status = null;
  try {
    status = await api.merge.status(keepSelections ? toWireTargets(_selections) : undefined);
  } catch (err) {
    if (_overlay !== owningOverlay) return;
    _status = null;
    _view = 'error';
    _msg = err?.message || String(err);
    _render();
    return;
  }
  if (_overlay !== owningOverlay) return;
  _status = status;
  if (status?.vcs && status.vcs.type !== 'git') {
    _view = 'error';
    _msg = t('merge.vcsNotGit');
    _render();
    return;
  }
  if (status?.job && status.job.state) {
    _job = { steps: [], log: [], merged: {}, caveats: [], ...status.job };
    _view = viewForJob(_job) || 'ready';
    if (_view === 'ready') _job = null;
    if (_jobToast && _view !== 'running' && _view !== 'checks') { try { _jobToast.done(''); } catch (_) { /* gone */ } _jobToast = null; }
  } else {
    _job = null;
    _view = 'ready';
  }
  if (_view === 'ready') {
    const fresh = defaultSelections(status);
    if (keepSelections && _selections.length) {
      const prev = new Map(_selections.map((s) => [s.repoId, s]));
      _selections = fresh.map((sel) => {
        const p = prev.get(sel.repoId);
        if (!p) return sel;
        const repo = (status.repos || []).find((r) => r.id === sel.repoId);
        const known = new Set((repo?.taskBranches || []).map((b) => b.branch));
        return { ...sel, target: p.target || sel.target, createBranch: p.createBranch, branches: p.branches.filter((b) => known.has(b)) };
      });
    } else {
      _selections = fresh;
    }
    _dryRun = null;
    _dryRunSig = null;
  }
  _render();
}

// ── Render ────────────────────────────────────────────────────────────────────────────────
const STEP_KEYS = ['select', 'preflight', 'run', 'finish'];
function _stepIndexForView(view) {
  if (view === 'ready' || view === 'scanning' || view === 'idle') return _dryRun ? 1 : 0;
  if (view === 'dry-running') return 1;
  if (view === 'running' || view === 'checks' || view === 'conflict') return 2;
  return 3;
}

function _render() {
  if (!_overlay) return;
  const body = _overlay.querySelector('#merge-modal-body');
  const footer = _overlay.querySelector('#merge-modal-footer');
  const steps = _overlay.querySelector('#merge-modal-steps');
  if (!body || !footer) return;
  body.dataset.view = _view;
  const active = _stepIndexForView(_view);
  steps.innerHTML = STEP_KEYS.map((k, i) => `<span class="setup-modal-dot${i < active ? ' is-done' : ''}${i === active ? ' is-active' : ''}" title="${escapeAttr(t('merge.step.' + k))}"></span>`).join('');

  switch (_view) {
    case 'scanning': body.innerHTML = `<p class="setup-modal-hint">${escapeAttr(t('merge.scanning'))}</p>`; footer.innerHTML = _btn('cancel', t('btn.cancel'), 'secondary'); break;
    case 'ready':
    case 'dry-running': body.innerHTML = _renderReady(); footer.innerHTML = _renderReadyFooter(); break;
    case 'running':
    case 'checks': body.innerHTML = _renderProgress(); footer.innerHTML = _btn('hide', t('merge.hide'), 'secondary') + _btn('abort', t('merge.abort'), 'secondary', _busy); break;
    case 'conflict': body.innerHTML = _renderProgress() + _renderConflict(); footer.innerHTML = _btn('hide', t('merge.hide'), 'secondary') + _btn('abort', t('merge.abort'), 'secondary', _busy) + _btn('resolve-agent', t('merge.resolveWithAgent'), 'secondary', _busy) + _btn('resume', t('merge.continue'), 'primary', _busy); break;
    case 'done': body.innerHTML = _renderDone(); footer.innerHTML = _btn('close', t('btn.close'), 'secondary') + _btn('start-over', t('merge.startOver'), 'primary', _busy); break;
    case 'error': body.innerHTML = _renderError(); footer.innerHTML = _btn('close', t('btn.close'), 'secondary') + _btn('start-over', t('merge.startOver'), 'primary', _busy); break;
    default: body.innerHTML = ''; footer.innerHTML = _btn('close', t('btn.close'), 'secondary');
  }
  _scrollLogToBottom();
}

function _btn(action, label, kind, disabled = false) {
  return `<button type="button" class="setup-modal-btn setup-modal-btn--${kind}" data-action="${escapeAttr(action)}"${disabled ? ' disabled' : ''}>${escapeAttr(label)}</button>`;
}

function _msgBlock() {
  return _msg ? `<div class="setup-modal-msg setup-modal-msg--error" id="merge-modal-msg">${escapeAttr(_msg)}</div>` : '<div class="setup-modal-msg" id="merge-modal-msg"></div>';
}

function _onOff(v) { return t(v ? 'merge.on' : 'merge.off'); }

function _repoLabel(repo) {
  return repo.kind === 'root' || !repo.relPath ? t('merge.rootRepo') : t('merge.nestedRepo', { path: repo.relPath });
}

function _renderReady() {
  const s = _status || {};
  const repos = orderedRepos(s.repos);
  const blockers = collectBlockers(s, _dryRun, _selections);
  const summary = summarizeBlockers(blockers);
  const rows = conflictRows(_dryRun);
  const caption = t('merge.vcsCaption', {
    version: s.git?.version || '?',
    worktree: _onOff(s.vcs?.worktree),
    commit: _onOff(s.vcs?.commit),
    pr: _onOff(s.vcs?.pr),
  });
  const dis = _view === 'dry-running' || _busy ? ' disabled' : '';
  let html = `<div class="merge-toolbar"><span class="merge-vcs-caption">${escapeAttr(caption)}</span><button type="button" class="setup-modal-btn setup-modal-btn--secondary merge-btn-small" data-action="rescan"${dis}>${escapeAttr(t('merge.rescan'))}</button></div>`;
  if (!repos.length) html += `<p class="setup-modal-hint">${escapeAttr(t('merge.noBranches'))}</p>`;
  for (const repo of repos) {
    const sel = _selections.find((x) => x.repoId === repo.id) || { branches: [], target: repo.target, createBranch: null };
    const repoBlockers = blockers.filter((b) => b.repoId === repo.id && !b.branch);
    html += `<section class="merge-repo" data-repo-id="${escapeAttr(repo.id)}">`;
    html += `<div class="merge-repo-head"><strong class="merge-repo-name">${escapeAttr(_repoLabel(repo))}</strong><span class="merge-repo-branch">${escapeAttr(t('merge.currentBranch', { branch: repo.currentBranch || '?' }))}</span>`;
    html += `<label class="merge-target"><span>${escapeAttr(t('merge.target'))}</span><select class="merge-target-select" data-repo-id="${escapeAttr(repo.id)}"${dis}>`;
    const targets = Array.from(new Set([repo.currentBranch, ...(repo.otherBranches || [])].filter(Boolean)));
    for (const b of targets) html += `<option value="${escapeAttr(b)}"${sel.createBranch == null && sel.target === b ? ' selected' : ''}>${escapeAttr(b)}</option>`;
    if (canCreateBranch(repo)) html += `<option value="__new__"${sel.createBranch != null ? ' selected' : ''}>${escapeAttr(t('merge.targetNew'))}</option>`;
    html += `</select></label>`;
    html += `<input type="text" class="merge-target-new" data-repo-id="${escapeAttr(repo.id)}" placeholder="${escapeAttr(t('merge.newBranchName'))}" value="${escapeAttr(sel.createBranch || '')}"${sel.createBranch == null ? ' hidden' : ''}${dis}>`;
    if (repo.dirtyFiles && repo.dirtyFiles.length) {
      html += `<span class="merge-dirty-main" title="${escapeAttr(repo.dirtyFiles.map((f) => f.path).join('\n'))}">${escapeAttr(tc('merge.mainDirty', repo.dirtyFiles.length))}</span>`;
    }
    if (repo.midMerge) html += `<span class="merge-pill" data-state="dirty">${escapeAttr(t('merge.blocker.REPO_MID_MERGE'))}</span>`;
    html += `</div>`;
    const branches = repo.taskBranches || [];
    if (!branches.length) {
      html += `<p class="merge-empty">${escapeAttr(t('merge.noBranches'))}</p>`;
    } else {
      html += `<div class="merge-branch-table"><div class="merge-branch-head"><span></span><span>${escapeAttr(t('merge.colBranch'))}</span><span>${escapeAttr(t('merge.colStatus'))}</span><span>${escapeAttr(t('merge.colAheadBehind'))}</span><span>${escapeAttr(t('merge.colWorktree'))}</span><span>${escapeAttr(t('merge.colConflicts'))}</span></div>`;
      for (const b of branches) {
        const checked = sel.branches.includes(b.branch);
        const stateKey = branchStateKey(b);
        const paths = _dryRun ? branchConflictPaths(_dryRun, repo.id, b.branch) : null;
        const wt = b.worktree
          ? (b.worktree.dirty ? tc('merge.wtDirty', (b.worktree.dirtyFiles || []).length) : t('merge.wtClean'))
          : t('merge.wtNone');
        const confCell = paths === null
          ? t('merge.notChecked')
          : (paths.length ? tc('merge.conflictCount', paths.length) : t('merge.noConflicts'));
        html += `<div class="merge-branch-row" data-repo-id="${escapeAttr(repo.id)}" data-branch="${escapeAttr(b.branch)}">`
          + `<span><input type="checkbox" class="merge-branch-check" data-repo-id="${escapeAttr(repo.id)}" data-branch="${escapeAttr(b.branch)}"${checked ? ' checked' : ''}${b.ahead === 0 ? ' disabled' : ''}${dis}></span>`
          + `<span class="merge-branch-cell"><span class="merge-branch-key">${escapeAttr(b.taskKey || b.branch)}</span> <span class="merge-branch-title">${escapeAttr(b.task?.title || t('merge.noTask'))}</span>${b.sessionActive ? ` <span class="merge-pill" data-state="open">${escapeAttr(t('merge.blocker.SESSION_ACTIVE'))}</span>` : ''}</span>`
          + `<span><span class="merge-pill" data-state="${escapeAttr(stateKey)}">${escapeAttr(t('merge.state.' + stateKey))}</span></span>`
          + `<span class="merge-ab">+${Number(b.ahead) || 0} / −${Number(b.behind) || 0}</span>`
          + `<span class="merge-wt" title="${escapeAttr((b.worktree?.dirtyFiles || []).join('\n'))}">${escapeAttr(wt)}</span>`
          + `<span class="merge-conf" title="${escapeAttr((paths || []).join('\n'))}">${escapeAttr(confCell)}</span>`
          + `</div>`;
      }
      html += `</div>`;
    }
    const branchBlockers = blockers.filter((b) => b.repoId === repo.id && b.branch);
    const all = [...repoBlockers, ...branchBlockers];
    if (all.length) {
      html += `<div class="merge-blockers">`;
      for (const b of all) html += _renderBlocker(repo, b);
      html += `</div>`;
    }
    const pairs = rows.filter((r) => r.repoId === repo.id && r.kind === 'pair');
    if (pairs.length) {
      html += `<div class="merge-pairwise"><div class="merge-pairwise-caption">${escapeAttr(t('merge.pairwise'))}</div>`;
      for (const p of pairs) html += `<div class="merge-pairwise-row"><code>${escapeAttr(p.a)}</code> × <code>${escapeAttr(p.b)}</code><ul class="merge-file-list">${p.paths.map((x) => `<li>${escapeAttr(x)}</li>`).join('')}</ul></div>`;
      html += `</div>`;
    }
    html += `</section>`;
  }
  const checksOff = !_checks.test && !_checks.build;
  html += `<div class="merge-options">`
    + `<label><input type="checkbox" id="merge-checks-enabled"${!checksOff ? ' checked' : ''}${dis}> ${escapeAttr(t('merge.optChecks'))}</label>`
    + `<label><input type="checkbox" id="merge-checks-baseline"${_checks.baseline ? ' checked' : ''}${checksOff ? ' disabled' : dis}> ${escapeAttr(t('merge.optBaseline'))}</label>`
    + `</div>`;
  if (_dryRun) {
    if (_dryRun.supported === false) html += `<p class="setup-modal-msg setup-modal-msg--muted">${escapeAttr(t('merge.dryRunUnsupported'))}${_dryRun.reason ? ` (${escapeAttr(_dryRun.reason)})` : ''}</p>`;
    else if (!rows.length) html += `<p class="setup-modal-msg setup-modal-msg--ok">${escapeAttr(t('merge.dryRunClean'))}</p>`;
    if (!summary.canRun) html += `<p class="setup-modal-msg setup-modal-msg--error">${escapeAttr(t('merge.blocked'))}</p>`;
  } else {
    html += `<p class="setup-modal-hint">${escapeAttr(t('merge.dryRunRequired'))}</p>`;
  }
  html += _msgBlock();
  return html;
}

function _renderBlocker(repo, b) {
  const labelKey = `merge.blocker.${b.code}`;
  const params = { key: b.taskKey || (b.branch ? String(b.branch).replace(/^task\//, '') : ''), repo: _repoLabel(repo), branch: b.branch || '' };
  let label = t(labelKey, params);
  if (label === labelKey) label = b.message || b.code || '';
  let html = `<div class="merge-blocker" data-severity="${escapeAttr(b.severity || 'info')}" data-code="${escapeAttr(b.code || '')}">`;
  html += `<span class="merge-blocker-text">${escapeAttr(label)}</span>`;
  if (b.message && b.message !== label) html += `<span class="merge-blocker-detail">${escapeAttr(b.message)}</span>`;
  if (Array.isArray(b.paths) && b.paths.length) html += `<ul class="merge-file-list">${b.paths.map((p) => `<li>${escapeAttr(p)}</li>`).join('')}</ul>`;
  if (b.action && b.action.type === 'commit-worktree' && b.branch) {
    const key = params.key;
    const title = String(b.action.message || '').replace(new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*'), '');
    html += `<button type="button" class="settings-row-btn merge-commit-wt" data-action="commit-worktree" data-repo-id="${escapeAttr(repo.id)}" data-branch="${escapeAttr(b.branch)}"${_busy ? ' disabled' : ''}>${escapeAttr(t('merge.commitAs', { key, title }))}</button>`;
  }
  html += `</div>`;
  return html;
}

function _renderReadyFooter() {
  const n = selectedCount(_selections);
  const blockers = collectBlockers(_status, _dryRun, _selections);
  const fresh = _dryRun && _dryRunSig === selectionSignature(_selections);
  const canRun = fresh && summarizeBlockers(blockers).canRun && n > 0 && !_busy && _view !== 'dry-running';
  return `<span class="merge-footer-count">${escapeAttr(tc('merge.selectedCount', n))}</span>`
    + _btn('cancel', t('btn.cancel'), 'secondary')
    + _btn('dry-run', _view === 'dry-running' ? t('merge.dryRunning') : t('merge.dryRun'), 'secondary', n === 0 || _busy || _view === 'dry-running')
    + _btn('run', t('merge.run'), 'primary', !canRun);
}

function _renderProgress() {
  const job = _job || { steps: [], log: [] };
  let html = `<div class="merge-progress"><ol class="merge-steps">`;
  for (const s of job.steps || []) {
    const chip = [s.repoId, s.branch].filter(Boolean).join(' · ');
    html += `<li class="merge-step" data-state="${escapeAttr(s.status || 'pending')}" data-step-id="${escapeAttr(String(s.index))}"><span class="merge-step-icon" aria-hidden="true"></span><span class="merge-step-label">${escapeAttr(s.label || s.kind || '')}</span>${chip ? `<span class="merge-step-chip">${escapeAttr(chip)}</span>` : ''}</li>`;
  }
  html += `</ol>`;
  if (_view === 'checks') html += `<p class="setup-modal-hint">${escapeAttr(t('merge.checksRunning'))}</p>`;
  html += `<details class="merge-log-wrap"${_view === 'conflict' ? '' : ' open'}><summary>${escapeAttr(t('merge.log'))}</summary><pre class="merge-log" id="merge-log">${escapeAttr((job.log || []).join('\n'))}</pre></details>`;
  html += `</div>`;
  return html;
}

function _renderConflict() {
  const c = _job?.conflict;
  if (!c) return '';
  const repo = (_status?.repos || []).find((r) => r.id === c.repoId);
  const repoLabel = repo ? _repoLabel(repo) : (c.repoId || '');
  let html = `<div class="merge-conflict-panel">`;
  html += `<h3 class="merge-conflict-title">${escapeAttr(t('merge.conflictTitle', { repo: repoLabel, branch: c.branch || '' }))}</h3>`;
  html += `<p>${escapeAttr(t('merge.conflictIntro', { key: c.taskKey || '' }))}</p>`;
  if (c.autoResolvedGitlink) html += `<p class="setup-modal-msg setup-modal-msg--muted">${escapeAttr(t('merge.gitlinkAutoResolved'))}</p>`;
  html += `<h4>${escapeAttr(t('merge.conflictedFiles'))}</h4><ul class="merge-file-list">${(c.conflictedPaths || []).map((p) => `<li>${escapeAttr(p)}</li>`).join('')}</ul>`;
  const cmds = (c.manualCommands || []).join('\n');
  html += `<h4>${escapeAttr(t('merge.manualCommands'))} <button type="button" class="settings-row-btn merge-btn-small" data-action="copy-commands">${escapeAttr(t('merge.copy'))}</button></h4><pre class="merge-commands" id="merge-commands">${escapeAttr(cmds)}</pre>`;
  html += `<details class="merge-prompt"><summary>${escapeAttr(t('merge.handoffPrompt'))} <button type="button" class="settings-row-btn merge-btn-small" data-action="copy-prompt">${escapeAttr(t('merge.copy'))}</button></summary><textarea class="merge-prompt-text" id="merge-prompt-text" readonly>${escapeAttr(c.handoffPrompt || '')}</textarea></details>`;
  html += _msgBlock();
  html += `</div>`;
  return html;
}

function _renderDone() {
  const job = _job || {};
  const ok = job.state === 'done';
  let html = `<div class="merge-summary">`;
  html += `<p class="setup-modal-msg ${ok ? 'setup-modal-msg--ok' : 'setup-modal-msg--error'}">${escapeAttr(ok ? t('merge.doneOk') : t('merge.doneWithErrors'))}</p>`;
  const rows = mergedRows(job.merged, _status?.repos);
  if (rows.length) {
    html += `<h4>${escapeAttr(t('merge.mergedList'))}</h4><ul class="merge-merged">`;
    for (const r of rows) {
      const repo = (_status?.repos || []).find((x) => x.id === r.repoId);
      const title = _titleForKey(r.key);
      html += `<li><span class="merge-branch-key">${escapeAttr(r.key)}</span>${title ? ` — ${escapeAttr(title)}` : ''} <span class="merge-step-chip">${escapeAttr(repo ? _repoLabel(repo) : r.repoId)}</span></li>`;
    }
    html += `</ul>`;
  }
  const cs = checksSummary(job.checks);
  if (cs.ran) {
    html += `<div class="merge-checks-result">`;
    if (!cs.blocking && cs.newFailures === 0 && !cs.buildFailed) html += `<p class="setup-modal-msg setup-modal-msg--ok">${escapeAttr(t('merge.checksPassed'))}</p>`;
    if (cs.newFailures > 0) html += `<p class="setup-modal-msg setup-modal-msg--error">${escapeAttr(tc('merge.checksNewFailures', cs.newFailures))}</p>`;
    if (cs.buildFailed) html += `<p class="setup-modal-msg setup-modal-msg--error">${escapeAttr(t('merge.buildFailed'))}</p>`;
    if (cs.preExisting > 0) html += `<p class="setup-modal-msg setup-modal-msg--muted">${escapeAttr(t('merge.checksBaselineFailures', { n: cs.preExisting }))}</p>`;
    const details = [];
    for (const [repoId, repo] of Object.entries(job.checks || {})) {
      if (repo?.test?.newFailures?.length) details.push(`[${repoId}] ${t('merge.checksNewFailures.many', { n: repo.test.newFailures.length })}\n` + repo.test.newFailures.map((x) => `  - ${x}`).join('\n'));
      if (repo?.test?.preExisting?.length) details.push(`[${repoId}] ${t('merge.checksBaselineFailures', { n: repo.test.preExisting.length })}\n` + repo.test.preExisting.map((x) => `  - ${x}`).join('\n'));
      if (repo?.test?.stdoutTail) details.push(`[${repoId}] test\n${repo.test.stdoutTail}`);
      if (repo?.build?.stdoutTail) details.push(`[${repoId}] build\n${repo.build.stdoutTail}`);
    }
    if (details.length) html += `<details class="merge-log-wrap"><summary>${escapeAttr(t('merge.checksOutput'))}</summary><pre class="merge-log">${escapeAttr(details.join('\n\n'))}</pre></details>`;
    html += `</div>`;
  }
  if (Array.isArray(job.caveats) && job.caveats.length) {
    html += `<ul class="merge-caveats">${job.caveats.map((c) => `<li>${escapeAttr(c)}</li>`).join('')}</ul>`;
  }
  if (job.error) html += `<p class="setup-modal-msg setup-modal-msg--error">${escapeAttr(String(job.error))}</p>`;
  html += `</div><div class="merge-post-actions">`;
  if (publishEligible(_status)) {
    html += `<div class="merge-post-row" id="merge-publish-row"><button type="button" class="settings-row-btn" data-action="publish"${_busy ? ' disabled' : ''}>${escapeAttr(_busy && _busyKind === 'publish' ? t('merge.publishing') : t('merge.publish'))}</button>${_renderPublishResult()}</div>`;
  }
  html += `<div class="merge-post-row" id="merge-cleanup-row"><button type="button" class="settings-row-btn settings-row-btn-danger" data-action="cleanup"${_busy ? ' disabled' : ''}>${escapeAttr(_busy && _busyKind === 'cleanup' ? t('merge.cleaning') : t('merge.cleanup'))}</button>${_renderCleanupResult()}</div>`;
  html += `</div>${_msgBlock()}`;
  return html;
}

function _renderPublishResult() {
  if (!_publish) return '';
  let html = `<ul class="merge-result-list">`;
  for (const r of _publish.repos || []) {
    const repo = (_status?.repos || []).find((x) => x.id === r.repoId);
    const parts = [];
    if (r.pushed) parts.push(escapeAttr(t('merge.pushed')));
    if (r.prUrl) parts.push(`<a href="${escapeAttr(r.prUrl)}" target="_blank" rel="noopener">${escapeAttr(t('merge.prOpened'))}</a>`);
    if (r.error) parts.push(`<span class="merge-result-error">${escapeAttr(t('merge.publishError', { msg: r.error }))}</span>${r.suggested ? `<pre class="merge-commands">${escapeAttr(r.suggested)}</pre>` : ''}`);
    if (r.skipped) parts.push(escapeAttr(String(r.skipped)));
    html += `<li><strong>${escapeAttr(repo ? _repoLabel(repo) : r.repoId)}</strong>: ${parts.join(' · ')}</li>`;
  }
  return html + `</ul>`;
}

function _renderCleanupResult() {
  if (!_cleanup) return '';
  let html = `<ul class="merge-result-list">`;
  for (const r of _cleanup.repos || []) {
    const repo = (_status?.repos || []).find((x) => x.id === r.repoId);
    html += `<li><strong>${escapeAttr(repo ? _repoLabel(repo) : r.repoId)}</strong>: ${escapeAttr(t('merge.cleanupResult', { worktrees: (r.removedWorktrees || []).length, branches: (r.deletedBranches || []).length }))}`;
    if (r.failures && r.failures.length) html += `<div class="merge-result-error">${escapeAttr(t('merge.cleanupErrors'))}</div><ul class="merge-file-list">${r.failures.map((f) => `<li>${escapeAttr(f.branch || f.path || '')}: ${escapeAttr(f.message || '')}</li>`).join('')}</ul>`;
    html += `</li>`;
  }
  return html + `</ul>`;
}

function _renderError() {
  const text = _msg || (_job?.error ? t('merge.errGeneric', { msg: _job.error }) : t('merge.doneWithErrors'));
  return `<div class="setup-modal-msg setup-modal-msg--error" id="merge-modal-msg">${escapeAttr(text)}</div>${_job?.steps?.length ? _renderProgress() : ''}`;
}

function _titleForKey(key) {
  try { return state.taskTitleById?.get?.(key) || ''; } catch (_) { return ''; }
}

// ── Events ────────────────────────────────────────────────────────────────────────────────
function _onBodyChange(e) {
  const el = e.target;
  if (!el) return;
  if (el.classList.contains('merge-branch-check')) {
    _selections = toggleBranch(_selections, el.dataset.repoId, el.dataset.branch, el.checked);
    _invalidateDryRun();
    return;
  }
  if (el.classList.contains('merge-target-select')) {
    const repoId = el.dataset.repoId;
    if (el.value === '__new__') _selections = setTarget(_selections, repoId, { createBranch: '' });
    else _selections = setTarget(_selections, repoId, { target: el.value });
    _invalidateDryRun();
    return;
  }
  if (el.id === 'merge-checks-enabled') {
    _checks = { ..._checks, test: el.checked, build: el.checked };
    _render();
    return;
  }
  if (el.id === 'merge-checks-baseline') {
    _checks = { ..._checks, baseline: el.checked };
  }
}

function _onBodyInput(e) {
  const el = e.target;
  if (el && el.classList.contains('merge-target-new')) {
    _selections = setTarget(_selections, el.dataset.repoId, { createBranch: el.value });
    _dryRun = null; _dryRunSig = null;
    const footer = _overlay?.querySelector('#merge-modal-footer');
    if (footer) footer.innerHTML = _renderReadyFooter();
  }
}

function _invalidateDryRun() {
  _dryRun = null;
  _dryRunSig = null;
  _msg = '';
  _render();
}

function _onBodyClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  _dispatch(btn.dataset.action, btn);
}

function _onFooterClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  _dispatch(btn.dataset.action, btn);
}

function _onBodyScroll(e) {
  const log = e.target;
  if (!log || log.id !== 'merge-log') return;
  _logPinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
}

function _scrollLogToBottom() {
  const log = _overlay?.querySelector('#merge-log');
  if (log && _logPinned) log.scrollTop = log.scrollHeight;
}

function _dispatch(action, btn) {
  switch (action) {
    case 'cancel':
    case 'close':
    case 'hide': close(); break;
    case 'rescan': _load({ keepSelections: true }); break;
    case 'dry-run': _runDryRun(); break;
    case 'run': _runMerge(); break;
    case 'commit-worktree': _commitWorktree(btn.dataset.repoId, btn.dataset.branch); break;
    case 'abort': _abort(); break;
    case 'resume': _resume(); break;
    case 'resolve-agent': _resolveWithAgent(); break;
    case 'copy-commands': _copy((_job?.conflict?.manualCommands || []).join('\n')); break;
    case 'copy-prompt': _copy(_job?.conflict?.handoffPrompt || ''); break;
    case 'publish': _publishRun(); break;
    case 'cleanup': _cleanupRun(); break;
    case 'start-over': _job = null; _publish = null; _cleanup = null; _dryRun = null; _dryRunSig = null; _load(); break;
    default: break;
  }
}

async function _copy(text) {
  try { await navigator.clipboard.writeText(text); showToast(t('merge.copied'), 'success'); } catch (_) { showToast(t('merge.copyFailed'), 'error'); }
}

async function _runDryRun() {
  const owningOverlay = _overlay;
  const sig = selectionSignature(_selections);
  _view = 'dry-running';
  _msg = '';
  _render();
  try {
    const res = await api.merge.dryRun(toWireSelections(_selections), toWireTargets(_selections));
    if (_overlay !== owningOverlay) return;
    _dryRun = res || { supported: false, repos: [] };
    _dryRunSig = sig;
  } catch (err) {
    if (_overlay !== owningOverlay) return;
    _dryRun = null; _dryRunSig = null;
    _msg = err?.message || String(err);
  }
  _view = 'ready';
  _render();
}

async function _commitWorktree(repoId, branch) {
  const owningOverlay = _overlay;
  _busy = true; _busyKind = 'commit';
  _msg = '';
  _render();
  try {
    await api.merge.commitWorktree(repoId, branch);
    if (_overlay !== owningOverlay) return;
    showToast(t('merge.commitDone'), 'success');
  } catch (err) {
    if (_overlay !== owningOverlay) return;
    _msg = t('merge.commitFailed', { msg: err?.message || String(err) });
  } finally {
    if (_overlay === owningOverlay) { _busy = false; _busyKind = ''; }
  }
  if (_overlay !== owningOverlay) return;
  // Rescan so the dirty flag clears, then re-run the dry run for the same selection.
  await _load({ keepSelections: true });
  if (_overlay !== owningOverlay || _view !== 'ready') return;
  await _runDryRun();
}

async function _runMerge() {
  const owningOverlay = _overlay;
  _busy = true; _busyKind = 'run';
  _msg = '';
  _render();
  try {
    const res = await api.merge.run(toWireSelections(_selections), toWireTargets(_selections), { ..._checks });
    if (_overlay !== owningOverlay) return;
    _job = { jobId: res?.jobId || null, state: 'running', steps: Array.isArray(res?.plan) ? res.plan.map((s) => ({ ...s, status: s.status || 'pending' })) : [], log: [], merged: {}, checks: null, conflict: null, error: null, caveats: [] };
    _view = 'running';
  } catch (err) {
    if (_overlay !== owningOverlay) return;
    if (err?.statusCode === 409) {
      showToast(t('merge.errInProgress'), 'error');
      _busy = false; _busyKind = '';
      await _load({ keepSelections: true });
      return;
    }
    _msg = t('merge.errGeneric', { msg: err?.message || String(err) });
    _view = 'ready';
  } finally {
    if (_overlay === owningOverlay) { _busy = false; _busyKind = ''; }
  }
  if (_overlay === owningOverlay) _render();
}

async function _abort() {
  const owningOverlay = _overlay;
  const ok = await showActionConfirm({ message: escapeAttr(t('merge.confirmAbort')), confirmLabel: t('merge.abort'), danger: true, overlayClass: 'modal-overlay--over-settings' });
  if (!ok || _overlay !== owningOverlay) return;
  _busy = true; _busyKind = 'abort';
  _render();
  try {
    await api.merge.abort();
  } catch (err) {
    if (_overlay === owningOverlay) _msg = t('merge.errGeneric', { msg: err?.message || String(err) });
  } finally {
    if (_overlay === owningOverlay) { _busy = false; _busyKind = ''; }
  }
  if (_overlay !== owningOverlay) return;
  // The server answers with a terminal frame; if none arrives (e.g. no live socket), refetch.
  await _load({ keepSelections: true });
}

async function _resume() {
  const owningOverlay = _overlay;
  _busy = true; _busyKind = 'resume';
  _msg = '';
  _render();
  try {
    await api.merge.resume();
    if (_overlay !== owningOverlay) return;
    if (_job) { _job.state = 'running'; _job.conflict = null; }
    _view = 'running';
  } catch (err) {
    if (_overlay !== owningOverlay) return;
    _msg = t('merge.continueFailed', { msg: err?.message || String(err) });
  } finally {
    if (_overlay === owningOverlay) { _busy = false; _busyKind = ''; }
  }
  if (_overlay === owningOverlay) _render();
}

// Opens a terminal session for the conflicting task with the server-built kickoff prompt.
// The prompt travels in the terminal WS URL (server reads `prompt` from the query string), so
// it is capped at MAX_DESC_LEN the same way a task description is; the full text stays in the
// panel's copy box. A task that already has a live session can't take a URL prompt (resume
// path) — copy it to the clipboard instead.
async function _resolveWithAgent() {
  const owningOverlay = _overlay;
  const c = _job?.conflict;
  if (!c || !c.taskKey) return;
  const taskKey = c.taskKey;
  const title = _titleForKey(taskKey) || taskKey;
  let status = 'completed';
  try { status = state.taskStatusById?.get?.(taskKey) || status; } catch (_) { /* default */ }
  const openTerminal = window.TipTask?.openTerminal;
  const openAgentSelectorModal = window.TipTask?.openAgentSelectorModal;
  if (typeof openTerminal !== 'function') { showToast(t('merge.errNoTerminal'), 'error'); return; }
  const prompt = truncatePrompt(c.handoffPrompt || '', MAX_DESC_LEN);
  let isResume = false;
  try { isResume = !!state.activeSessions?.has?.(taskKey); } catch (_) { isResume = false; }
  if (isResume) {
    try { await navigator.clipboard.writeText(c.handoffPrompt || ''); } catch (_) { /* clipboard unavailable */ }
    if (_overlay !== owningOverlay) return;
    showToast(t('merge.promptCopiedResume'));
  }
  close();
  const opts = { prompt };
  const multiAgent = Array.isArray(state.availableAgents) && state.availableAgents.length > 1 && !state.sessionAgent;
  if (multiAgent && typeof openAgentSelectorModal === 'function') openAgentSelectorModal(taskKey, title, '', status, opts);
  else openTerminal(taskKey, title, '', status, opts);
  showToast(t('merge.resumeHint'));
}

async function _publishRun() {
  const owningOverlay = _overlay;
  const ok = await showActionConfirm({ message: escapeAttr(t('merge.confirmPublish')), confirmLabel: t('merge.publish'), overlayClass: 'modal-overlay--over-settings' });
  if (!ok || _overlay !== owningOverlay) return;
  _busy = true; _busyKind = 'publish';
  _msg = '';
  _render();
  try {
    const repoIds = Object.keys(_job?.merged || {});
    const ids = repoIds.length ? repoIds : orderedRepos(_status?.repos).map((r) => r.id);
    _publish = await api.merge.publish(ids, true);
  } catch (err) {
    if (_overlay === owningOverlay) _msg = t('merge.errGeneric', { msg: err?.message || String(err) });
  } finally {
    if (_overlay === owningOverlay) { _busy = false; _busyKind = ''; }
  }
  if (_overlay === owningOverlay) _render();
}

async function _cleanupRun() {
  const owningOverlay = _overlay;
  const ok = await showActionConfirm({ message: escapeAttr(t('merge.confirmCleanup')), confirmLabel: t('merge.cleanup'), danger: true, overlayClass: 'modal-overlay--over-settings' });
  if (!ok || _overlay !== owningOverlay) return;
  _busy = true; _busyKind = 'cleanup';
  _msg = '';
  _render();
  try {
    const payload = cleanupPayload(_job?.merged);
    _cleanup = await api.merge.cleanup(payload.selections);
  } catch (err) {
    if (_overlay === owningOverlay) _msg = t('merge.errGeneric', { msg: err?.message || String(err) });
  } finally {
    if (_overlay === owningOverlay) { _busy = false; _busyKind = ''; }
  }
  if (_overlay === owningOverlay) _render();
}
