import state from './state.js';
import { api } from './api-client.js';
import { t } from './i18n.js';
import { escapeAttr, showToast, projectHeader } from './utils.js';
import { openMergeBranchesModal } from './merge-branches-modal.js';

export const MERGE_DOT = '<span class="merge-attention-dot" aria-hidden="true"></span>';
const roots = new WeakSet();
let initialized = false;
let pending = null;
let refreshAgain = false;
let lastRead = 0;
let project = null;
let submitting = false;
// True while the last read said this project has no manual-merge UI to show (svn/off, or
// auto-merge on). Only forced reads (focus, settings save, merge frames) look again.
let inapplicable = false;

export function mergeButtonHtml(key) {
  const label = escapeAttr(t('card.mergeTask'));
  return `<button type="button" class="btn-merge-task" data-task-id="${escapeAttr(key)}" data-tip="${label}" aria-label="${label}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="4" cy="3" r="2"/><circle cx="12" cy="3" r="2"/><circle cx="4" cy="13" r="2"/><path d="M4 5v6m8-6c0 4-8 2-8 6"/></svg>${MERGE_DOT}</button>`;
}

export function syncTaskMergeCard(card) {
  if (!card.matches('.card[data-id]:not(.card--preview)')) return;
  const snapshot = state.taskMergeStatus;
  const show = snapshot?.vcs?.type === 'git' && snapshot.vcs.merge === false && snapshot.tasks?.[card.dataset.id]?.unmerged === true;
  card.classList.toggle('has-unmerged-worktree', !!show);
  const select = card.querySelector('.btn-select-card');
  const menu = card.querySelector('.card-action-menu');
  if (select) {
    select.querySelector('.merge-attention-dot')?.remove();
    if (show) select.insertAdjacentHTML('beforeend', MERGE_DOT);
    const label = t('tooltip.selectCard') + (show ? ` — ${t('card.unmergedWorktree')}` : '');
    select.setAttribute('aria-label', label);
    select.dataset.tip = label;
  }
  let button = menu?.querySelector('.btn-merge-task');
  if (!show) button?.remove();
  else if (menu) {
    if (!button) {
      menu.insertAdjacentHTML('beforeend', mergeButtonHtml(card.dataset.id));
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
  if (!force && (inapplicable || Date.now() - lastRead < 10000)) return;
  pending = (async () => {
    try {
      const snapshot = await api.merge.status();
      if (scope === project) {
        state.taskMergeStatus = snapshot;
        inapplicable = snapshot?.vcs?.merge === true;
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
