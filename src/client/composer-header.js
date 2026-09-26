// Shared Create-section header, used by Objective chat and New Task.
import state from './state.js';
import { t } from './i18n.js';
import { escapeAttr } from './utils.js';

export function renderComposerHeader(trailingHtml = '', tabBarHtml = '') {
  const modes = [
    { tab: 'objective', label: t('nav.objective'), sub: t('nav.objectiveSub') },
    { tab: 'new_task', label: t('nav.task'), sub: t('nav.taskSub') },
  ];
  const nav = `<div class="composer-header-nav" role="tablist" aria-label="${escapeAttr(t('nav.create'))}">${modes.map(m =>
    `<button type="button" role="tab" aria-selected="${state.activeTab === m.tab ? 'true' : 'false'}" class="composer-header-btn${state.activeTab === m.tab ? ' is-active' : ''}" data-tab="${m.tab}"><span class="composer-header-label">${escapeAttr(m.label)}</span><span class="composer-subheader">${escapeAttr(m.sub)}</span></button>`
  ).join('')}</div>`;
  return `<div class="composer-header"><div class="composer-header-inner">${nav}${trailingHtml ? `<div class="composer-header-actions">${trailingHtml}</div>` : ''}</div>${tabBarHtml}</div>`;
}
