// Shared Create-section header, used by Objective chat and New Task.
import state from './state.js';
import { t } from './i18n.js';
import { escapeAttr } from './utils.js';
import { createMode } from './create-modes.js';

// (TPT9390) The header names the Create mode the modal is showing; it does not switch it. The
// mode is picked in the left menu's Create flyout (create-flyout.js), which uses the same name,
// hint and icon (create-modes.js). `trailingHtml` is the Objective view's console toggle and
// History button; `tabBarHtml` is its session tab bar.
export function renderComposerHeader(trailingHtml = '', tabBarHtml = '') {
  const mode = createMode(state.activeTab);
  const title = `<div class="composer-header-title" data-mode="${mode.mode}">`
    + `<span class="composer-header-icon">${mode.icon}</span>`
    + `<div class="composer-header-text"><h2 class="composer-header-heading">${escapeAttr(t(mode.labelKey))}</h2>`
    + `<p class="composer-subheader">${escapeAttr(t(mode.hintKey))}</p></div></div>`;
  return `<div class="composer-header"><div class="composer-header-inner">${title}${trailingHtml ? `<div class="composer-header-actions">${trailingHtml}</div>` : ''}</div>${tabBarHtml}</div>`;
}
