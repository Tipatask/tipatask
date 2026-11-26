// Shared Create-section header, used by Objective chat and New Task.
import state from './state.js';
import { t } from './i18n.js';
import { escapeAttr } from './utils.js';
import { createMode } from './create-modes.js';
import { OBJECTIVE_GUIDE_ID, OBJECTIVE_HELP_BUTTON_ID } from './objective-stage.js';

const HELP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

// (TPT9390) The header names the Create mode the modal is showing; it does not switch it. The
// mode is picked in the left menu's Create flyout (create-flyout.js), which uses the same name,
// hint and icon (create-modes.js). `trailingHtml` is the Objective view's console toggle and
// History button; `tabBarHtml` is its session tab bar.
// (TPT9405) `helpHtml` is New Objective's guide popover (objective-stage.js
// renderObjectiveGuideHtml()), passed only while the guide applies. In the Objective mode it
// renders behind a (?) button ahead of the other actions, and right after that button, so the
// popover is next in the Tab order and hangs under this row. New Task gets no button.
export function renderComposerHeader(trailingHtml = '', tabBarHtml = '', { helpHtml = '' } = {}) {
  const mode = createMode(state.activeTab);
  const title = `<div class="composer-header-title" data-mode="${mode.mode}">`
    + `<span class="composer-header-icon">${mode.icon}</span>`
    + `<div class="composer-header-text"><h2 class="composer-header-heading">${escapeAttr(t(mode.labelKey))}</h2>`
    + `<p class="composer-subheader">${escapeAttr(t(mode.hintKey))}</p></div></div>`;
  const help = mode.mode === 'objective' && helpHtml ? helpButtonHtml() + helpHtml : '';
  const actions = help + trailingHtml;
  return `<div class="composer-header"><div class="composer-header-inner">${title}${actions ? `<div class="composer-header-actions">${actions}</div>` : ''}</div>${tabBarHtml}</div>`;
}

function helpButtonHtml() {
  const label = escapeAttr(t('chat.guide.help'));
  return `<button type="button" class="objective-help-btn" id="${OBJECTIVE_HELP_BUTTON_ID}" aria-expanded="false"`
    + ` aria-controls="${OBJECTIVE_GUIDE_ID}" title="${label}" aria-label="${label}">${HELP_ICON}</button>`;
}
