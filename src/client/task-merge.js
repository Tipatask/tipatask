import state from './state.js';
import { api } from './api-client.js';
import { t } from './i18n.js';
import { escapeAttr, showToast, projectHeader } from './utils.js';
import { openMergeBranchesModal } from './merge-branches-modal.js';

export const MERGE_DOT = '<span class="merge-attention-dot" aria-hidden="true"></span>';
// Shortest gap between two non-forced reads (board re-render, the visible-window interval)
// while the project has the manual merge UI.
const SCAN_THROTTLE_MS = 10000;
// (TPT9211) The same gap while it has none. Such a read only re-checks the project settings, and
// the backend answering api.project.settings() and the one behind the merge routes (one and the
// same in browser mode) each cache them for 30 s, so a sooner re-check could not see a change
// made elsewhere. A Version Control save in this window forces a read anyway.
const RECHECK_THROTTLE_MS = 30000;
const roots = new WeakSet();
let initialized = false;
let pending = null;
let refreshAgain = false;
let lastRead = 0;
let project = null;
let submitting = false;
// True while the last read found no manual-merge UI for this project: its settings say VCS off,
// svn or automatic merge (no status request was sent), or the server answered VCS_NOT_GIT.
// Non-forced reads then wait RECHECK_THROTTLE_MS; forced reads (focus, settings save, merge
// frames) always look again.
let inapplicable = false;

// (TPT9211) The per-card merge UI exists only on git with automatic worktree merge off. With it
// on, the agent merges at completion and POST …/task answers 409 AUTO_MERGE_ENABLED.
function manualMergeApplies(vcs) {
  return vcs?.type === 'git' && vcs.merge === false;
}

// (TPT9211) Whether a merge-status scan applies to this project now, from its live settings
// bundle (api.project.settings(): vcsType + vcsMergeEnabled, the backend.getProjectSettings() row
// the merge routes gate on). VCS off, svn, automatic merge and an unreadable bundle answer false,
// so those projects never send GET /api/project/merge/status, which the server refuses with
// 409 VCS_NOT_GIT for anything but git. A request gate only: every merge route still checks the
// setting itself.
export async function shouldFetchMergeStatus() {
  try {
    const settings = await api.project.settings();
    return manualMergeApplies({ type: settings?.vcsType, merge: !!settings?.vcsMergeEnabled });
  } catch {
    return false;
  }
}

export function mergeButtonHtml(key) {
  const label = escapeAttr(t('card.mergeTask'));
  return `<button type="button" class="btn-merge-task" data-task-id="${escapeAttr(key)}" data-tip="${label}" aria-label="${label}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="4" cy="3" r="2"/><circle cx="12" cy="3" r="2"/><circle cx="4" cy="13" r="2"/><path d="M4 5v6m8-6c0 4-8 2-8 6"/></svg>${MERGE_DOT}</button>`;
}

export function syncTaskMergeCard(card) {
  if (!card.matches('.card[data-id]:not(.card--preview)')) return;
  const snapshot = state.taskMergeStatus;
  // A null snapshot (VCS switched off or to svn, automatic merge, project switch, failed read)
  // removes every marker this function adds.
  const show = manualMergeApplies(snapshot?.vcs) && snapshot.tasks?.[card.dataset.id]?.unmerged === true;
  card.classList.toggle('has-unmerged-worktree', !!show);
  const select = card.querySelector('.btn-select-card');
  const menu = card.querySelector('.card-action-menu');
  if (select) {
    select.querySelector('.merge-attention-dot')?.remove();
    if (show) select.insertAdjacentHTML('beforeend', MERGE_DOT);
    // (TPT614) Select's label carries every collapsed-tray marker; task-finish.js composes the same way.
    const label = t('tooltip.selectCard') + (show ? ` — ${t('card.unmergedWorktree')}` : '') + (card.classList.contains('has-left-uncommitted') ? ` — ${t('card.leftUncommitted')}` : '');
    select.setAttribute('aria-label', label);
    select.dataset.tip = label;
  }
  let button = menu?.querySelector('.btn-merge-task');
  if (!show) button?.remove();
  else if (menu) {
    if (!button) {
      // (TPT614) Merge stays ahead of the Finish item when both show.
      const finish = menu.querySelector('.btn-finish-task');
      if (finish) finish.insertAdjacentHTML('beforebegin', mergeButtonHtml(card.dataset.id));
      else menu.insertAdjacentHTML('beforeend', mergeButtonHtml(card.dataset.id));
      button = menu.querySelector('.btn-merge-task');
    }
    button.disabled = submitting || ['running', 'conflict'].includes(snapshot.job?.state);
  }
}

function repaint() {
  document.querySelectorAll('.card[data-id]').forEach(syncTaskMergeCard);
}

// One scan per window, never one per card. A forced refresh arriving during a scan
// schedules a second read so a completion cannot be overwritten by an older snapshot.
// (TPT9211) Every read asks shouldFetchMergeStatus() first. A project without the manual merge
// UI sends no status request and drops any earlier snapshot, so switching Git off clears the
// dots and Merge buttons at once; switching it back on is seen by the next forced read or by a
// non-forced one after RECHECK_THROTTLE_MS.
export async function refreshTaskMergeStatus(force = false) {
  const scope = JSON.stringify(projectHeader());
  if (scope !== project) {
    project = scope;
    state.taskMergeStatus = null;
    inapplicable = false;
    lastRead = 0;
    repaint();
  }
  if (pending) { refreshAgain ||= force; return pending; }
  if (!force && Date.now() - lastRead < (inapplicable ? RECHECK_THROTTLE_MS : SCAN_THROTTLE_MS)) return;
  pending = (async () => {
    try {
      const applies = await shouldFetchMergeStatus();
      // Settings of a project this window has since left: the re-read below serves the new one.
      if (scope !== project) return;
      if (!applies) {
        state.taskMergeStatus = null;
        inapplicable = true;
        return;
      }
      const snapshot = await api.merge.status();
      if (scope === project) {
        state.taskMergeStatus = snapshot;
        inapplicable = !manualMergeApplies(snapshot?.vcs);
      }
    } catch (err) {
      // Unknown/failed status must not advertise a merge action based on stale data.
      if (scope === project) {
        state.taskMergeStatus = null;
        inapplicable = err?.code === 'VCS_NOT_GIT';
      }
    } finally {
      if (scope === project) { lastRead = Date.now(); repaint(); }
    }
  })();
  try { await pending; } finally {
    pending = null;
    if (refreshAgain || scope !== project) {
      refreshAgain = false;
      void refreshTaskMergeStatus(true);
    }
  }
}

export async function mergeTaskFromCard(key) {
  if (submitting) return;
  submitting = true;
  repaint();
  try {
    await api.merge.task(key);
    openMergeBranchesModal();
  } catch (err) {
    const blockers = err.details?.blockers?.map(item => item.message).join('\n');
    showToast(t('merge.errGeneric', { msg: blockers || err.message }), 'error');
    if (err.code === 'JOB_RUNNING') openMergeBranchesModal();
  } finally {
    submitting = false;
    await refreshTaskMergeStatus(true);
  }
}

export function initializeTaskMerge(root) {
  if (!roots.has(root)) {
    roots.add(root);
    root.addEventListener('click', event => {
      const button = event.target.closest('.btn-merge-task');
      if (!button || button.disabled) return;
      event.stopPropagation();
      if (button.closest('.card--discussing, .card--preview')) return;
      void mergeTaskFromCard(button.dataset.taskId);
    });
  }
  if (!initialized) {
    initialized = true;
    document.addEventListener('tiptask:merge-status-changed', () => { void refreshTaskMergeStatus(true); });
    window.addEventListener('focus', () => { void refreshTaskMergeStatus(true); });
    // Commits made in terminals (including other devices) need no task-field change.
    setInterval(() => { if (!document.hidden) void refreshTaskMergeStatus(); }, 60000);
  }
  repaint();
  void refreshTaskMergeStatus();
}
