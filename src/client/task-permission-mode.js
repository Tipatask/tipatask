// Card permission indicator. Editing belongs to the Task Edit modal.
import { t } from './i18n.js';
import { escapeAttr } from './utils.js';
import { projectPermissionMode } from './group-label.js';
import { normalizePermissionMode, effectivePermissionMode, permissionModeIcon, permissionModeTip } from './permission-mode.js';

const roots = new WeakSet();

function overrideOf(task) {
  return normalizePermissionMode(task?.agentPermissionMode ?? task?.agent_permission_mode);
}

function tipFor(override) {
  return permissionModeTip({ agentPermissionMode: override }, projectPermissionMode(), t);
}

// data-tip + aria-label, never title (the card's tooltip layer, task-card.js ensureButtonTooltips).
export function permissionButtonHtml(task) {
  const override = overrideOf(task);
  const tip = escapeAttr(tipFor(override));
  return `<button type="button" class="card-permission-btn card-ctl${override ? ' card-permission-btn--override' : ''}" data-task-id="${escapeAttr(task.id)}" data-permission-mode="${escapeAttr(override || '')}" data-tip="${tip}" aria-label="${tip}">${permissionModeIcon(effectivePermissionMode(task, projectPermissionMode()).mode)}</button>`;
}

// Re-tips one board card's button from the task's override — a payload without the field keeps
// the button's current value (refreshCard() is fed several patch shapes) — and the cached
// project default. Preview cards never carry the button.
export function syncPermissionModeButton(card, task = null) {
  if (!card || typeof card.matches !== 'function' || !card.matches('.card[data-id]:not(.card--preview)')) return;
  const button = card.querySelector('.card-permission-btn');
  if (!button) return;
  const hasField = !!task && (task.agentPermissionMode !== undefined || task.agent_permission_mode !== undefined);
  const override = hasField ? overrideOf(task) : (button.dataset.permissionMode || null);
  button.dataset.permissionMode = override || '';
  button.classList.toggle('card-permission-btn--override', !!override);
  const tip = tipFor(override);
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
