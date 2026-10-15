// (TPT614) Task-card Finish button: the one-click recovery for a task the exit backstop flagged
// (state.leftUncommitted, set by attention-ws.js on the `task-left-uncommitted` frame — live or the
// connect-time replay — and by attention-state.js from GET /api/sessions's `leftUncommitted`, the
// server registry left-uncommitted.js every window rebuilds from (TPT664): its terminal ended with
// the task still in progress and its required commit missing). Click fetches the
// server-built finalize kickoff (GET /api/tasks/:key/finish-prompt → git-merge/handoff.js
// buildFinishHandoff(), built from a live read-only commit check) and reopens the task's terminal
// with it, through the card Start ladder (task-card.js startTaskById(), so the task's pinned agent
// is honored) with `relaunch: true`, so a retained exited session is replaced instead of reattached
// (console-modal.js). A live session can never take a prompt — the text goes over the clipboard,
// like the merge panel's "Resolve with agent". Sibling of task-merge.js: same markup contract (an
// item at the end of .card-action-menu, a dot on Select while the tray is collapsed), same
// vm-harness testability — console-modal.js / task-card.js are reached through window.TipTask at
// click time, never imported.
import state from './state.js';
import { api } from './api-client.js';
import { t } from './i18n.js';
import { escapeAttr, showToast } from './utils.js';
import { isClosedName } from './status-registry.js';
import { MAX_DESC_LEN } from './constants.js';
import { truncatePrompt } from './merge-branches-model.js';

export const FINISH_DOT = '<span class="finish-attention-dot" aria-hidden="true"></span>';
const roots = new WeakSet();
const inFlight = new Set();
// 409 codes that mean the flag is stale: the task is committed, closed, or needs no commit any more.
const STALE_FLAG_CODES = new Set(['TASK_COMMITTED', 'TASK_CLOSED', 'COMMITS_OFF']);

// The flag plus the card's live status: an in-place status patch (task:updated) hides the button
// before the render-time prune (attention-state.js pruneClosedAttention()) drops the Map entry.
export function isLeftUncommitted(taskId, status) {
  return !!taskId && !!state.leftUncommitted?.has?.(taskId) && !isClosedName(status);
}

export function finishButtonHtml(key) {
  const label = escapeAttr(t('card.finishTask'));
  return `<button type="button" class="btn-finish-task" data-task-id="${escapeAttr(key)}" data-tip="${label}" aria-label="${label}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="m5.5 8 1.8 1.8L10.8 6"/></svg>${FINISH_DOT}</button>`;
}

// Select's label carries every collapsed-tray marker — the merge one (task-merge.js composes the
// same way) and this one.
function selectLabel(card, show) {
  const parts = [t('tooltip.selectCard')];
  if (card.classList.contains('has-unmerged-worktree')) parts.push(t('card.unmergedWorktree'));
  if (show) parts.push(t('card.leftUncommitted'));
  return parts.join(' — ');
}

export function syncTaskFinishCard(card) {
  if (!card || typeof card.matches !== 'function' || !card.matches('.card[data-id]:not(.card--preview)')) return;
  const key = card.dataset.id;
  const show = isLeftUncommitted(key, card.dataset.status);
  card.classList.toggle('has-left-uncommitted', show);
  const select = card.querySelector('.btn-select-card');
  const menu = card.querySelector('.card-action-menu');
  if (select) {
    select.querySelector('.finish-attention-dot')?.remove();
    if (show) select.insertAdjacentHTML('beforeend', FINISH_DOT);
    const label = selectLabel(card, show);
    select.setAttribute('aria-label', label);
    select.dataset.tip = label;
  }
  let button = menu?.querySelector('.btn-finish-task');
  if (!show) button?.remove();
  else if (menu) {
    if (!button) {
      menu.insertAdjacentHTML('beforeend', finishButtonHtml(key));
      button = menu.querySelector('.btn-finish-task');
    }
    button.disabled = inFlight.has(key);
  }
}

export function syncAllFinishCards(root) {
  const host = root || (typeof document !== 'undefined' ? document : null);
  if (!host || typeof host.querySelectorAll !== 'function') return;
  host.querySelectorAll('.card[data-id]').forEach(syncTaskFinishCard);
}

function cardFor(key) {
  return document.querySelector(`.card[data-id="${CSS.escape(key)}"]`);
}

export async function finishTaskFromCard(key) {
  if (!key || inFlight.has(key)) return;
  inFlight.add(key);
  syncTaskFinishCard(cardFor(key));
  try {
    const result = await api.tasks.finishPrompt(key);
    const prompt = typeof result?.prompt === 'string' ? result.prompt.trim() : '';
    if (!prompt) throw new Error('Empty finish prompt');
    // Title/status are re-read at click time — the card may have re-rendered since the flag was set.
    const card = cardFor(key);
    const title = card?.querySelector('.card-title-inner')?.textContent?.trim() || state.taskTitleById?.get?.(key) || key;
    const status = card?.dataset?.status || state.taskStatusById?.get?.(key) || result.status || '';
    const openTerminal = window.TipTask?.openTerminal;
    const startTaskById = window.TipTask?.taskCard?.startTaskById;
    if (state.activeSessions?.has?.(key)) {
      // A live session reattaches and never takes a URL prompt (the server ignores it): hand the
      // text over the clipboard and open the terminal, like the merge panel does.
      try { await navigator.clipboard.writeText(prompt); } catch (_) { /* clipboard unavailable */ }
      showToast(t('card.finishPromptCopied'));
      if (typeof openTerminal === 'function') openTerminal(key, title, '', status);
      return;
    }
    const launchOpts = { prompt: truncatePrompt(prompt, MAX_DESC_LEN), relaunch: true };
    if (typeof startTaskById === 'function') await startTaskById(key, launchOpts);
    else if (typeof openTerminal === 'function') openTerminal(key, title, '', status, launchOpts);
    else showToast(t('merge.errNoTerminal'), 'error');
  } catch (err) {
    if (err?.statusCode === 409 && STALE_FLAG_CODES.has(err.code)) {
      state.leftUncommitted.delete(key);
      showToast(t('card.finishNothingToDo', { key }));
    } else {
      showToast(t('card.finishFailed', { msg: err?.message || String(err) }), 'error');
    }
  } finally {
    inFlight.delete(key);
    syncTaskFinishCard(cardFor(key));
  }
}

export function initializeTaskFinish(root) {
  if (root && !roots.has(root)) {
    roots.add(root);
    root.addEventListener('click', event => {
      const button = event.target.closest('.btn-finish-task');
      if (!button || button.disabled) return;
      event.stopPropagation();
      if (button.closest('.card--discussing, .card--preview')) return;
      void finishTaskFromCard(button.dataset.taskId);
    });
  }
  syncAllFinishCards(root);
}
