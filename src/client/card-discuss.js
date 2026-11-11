// (TPT9268/TPT9271/TPT9283) Card Discuss control: the icon-only square button just left of Start
// on a saved board card. It is a plain action, not a model picker: activating it (click, Enter or
// Space) opens the task's chat pane, whose start gate holds the model selector — filled with the
// task chat's own models and the saved or default choice — and the Start chat button
// (task-chat.js open()). Nothing here starts an agent, starts a terminal or changes the task.
import { t } from './i18n.js';
import { CHAT_BUBBLE_SVG } from './constants.js';
import { escapeAttr } from './utils.js';

// The button. It shows only the chat glyph (aria-hidden), so aria-label carries its accessible
// name; data-tip is the card's hover tooltip.
export function discussButtonHtml(taskId) {
  return `<button type="button" class="btn-task-discuss card-ctl" data-task-id="${escapeAttr(taskId)}"`
    + ` aria-label="${escapeAttr(t('card.discuss'))}" data-tip="${escapeAttr(t('tooltip.discuss'))}">`
    + `${CHAT_BUBBLE_SVG}</button>`;
}

// `onActivate(btn)` runs on the button's click — which a native button also fires for Enter and
// Space. The click never reaches the card (no expand, select or edit-modal open).
export function bindDiscussButton(btn, { onActivate } = {}) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onActivate?.(btn);
  });
}
