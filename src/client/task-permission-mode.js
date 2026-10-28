// Card permission indicator. Editing belongs to the Task Edit modal.
import { t } from './i18n.js';
import { escapeAttr } from './utils.js';
import { projectPermissionMode } from './group-label.js';
import { normalizePermissionMode, effectivePermissionMode, permissionModeIcon, permissionModeTip } from './permission-mode.js';

const roots = new WeakSet();

function overrideOf(task) {
  return normalizePermissionMode(task?.agentPermissionMode ?? task?.agent_permission_mode);
}

// (TPT9161) The stored Cowboy-coding flag. The button keeps it raw (data-cowboy-mode) and the tip
// marks it only while the effective mode is Bypass (cowboyModeOn() inside permissionModeTip()),
// so a project-default change re-tips every card without a fresh task payload.
function cowboyOf(task) {
  return !!(task?.cowboyMode ?? task?.cowboy_mode);
}

function tipFor(override, cowboy = false) {
  return permissionModeTip({ agentPermissionMode: override, cowboyMode: cowboy }, projectPermissionMode(), t);
}

// data-tip + aria-label, never title (the card's tooltip layer, task-card.js ensureButtonTooltips).
export function permissionButtonHtml(task) {
  const override = overrideOf(task);
  const cowboy = cowboyOf(task);
  const tip = escapeAttr(tipFor(override, cowboy));
  return `<button type="button" class="card-permission-btn card-ctl${override ? ' card-permission-btn--override' : ''}" data-task-id="${escapeAttr(task.id)}" data-permission-mode="${escapeAttr(override || '')}"${cowboy ? ' data-cowboy-mode="1"' : ''} data-tip="${tip}" aria-label="${tip}">${permissionModeIcon(effectivePermissionMode(task, projectPermissionMode()).mode)}</button>`;
}

// Re-tips one board card's button from the task's override and Cowboy-coding flag — a payload
// without a field keeps the button's current value for it (refreshCard() is fed several patch
// shapes) — and the cached project default. Preview cards never carry the button.
export function syncPermissionModeButton(card, task = null) {
  if (!card || typeof card.matches !== 'function' || !card.matches('.card[data-id]:not(.card--preview)')) return;
  const button = card.querySelector('.card-permission-btn');
  if (!button) return;
  const hasField = !!task && (task.agentPermissionMode !== undefined || task.agent_permission_mode !== undefined);
  const override = hasField ? overrideOf(task) : (button.dataset.permissionMode || null);
  const hasCowboy = !!task && (task.cowboyMode !== undefined || task.cowboy_mode !== undefined);
  const cowboy = hasCowboy ? cowboyOf(task) : button.dataset.cowboyMode === '1';
  button.dataset.permissionMode = override || '';
  if (cowboy) button.dataset.cowboyMode = '1';
  else delete button.dataset.cowboyMode;
  button.classList.toggle('card-permission-btn--override', !!override);
  const tip = tipFor(override, cowboy);
  button.innerHTML = permissionModeIcon(effectivePermissionMode({ agentPermissionMode: override }, projectPermissionMode()).mode);
  button.dataset.tip = tip;
  button.setAttribute('aria-label', tip);
}

export function syncAllPermissionButtons(root) {
  const host = root || (typeof document !== 'undefined' ? document : null);
  if (!host || typeof host.querySelectorAll !== 'function') return;
  host.querySelectorAll('.card[data-id]').forEach(card => syncPermissionModeButton(card));
}

// One delegated click per root (task-merge.js / task-finish.js shape); discussing and preview
// cards are inert.
export function initializeTaskPermissionMode(root, openSettings) {
  if (root && !roots.has(root)) {
    roots.add(root);
    root.addEventListener('click', event => {
      const button = event.target.closest('.card-permission-btn');
      if (!button || button.disabled) return;
      event.stopPropagation();
      if (button.closest('.card--discussing, .card--preview')) return;
      void openSettings(button.dataset.taskId);
    });
  }
  syncAllPermissionButtons(root);
}
