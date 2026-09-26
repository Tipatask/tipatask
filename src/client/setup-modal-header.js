// Shared header for the project setup wizards (project-creation-wizard.js,
// setup-modal.js): title on line 1, full absolute project path as a
// head-truncated subheader on line 2 (C1064).
import { t } from './i18n.js';

export function headerHtml({ title, projectPath }) {
  const path = projectPath || '';
  return `
    <div class="setup-modal-header">
      <div class="setup-modal-header-text">
        <span class="setup-modal-title">${_esc(title)}</span>
        <span class="setup-modal-header-path" data-path="${_esc(path)}" title="${_esc(path)}">${_esc(path)}</span>
      </div>
      <button class="setup-modal-close" aria-label="${_esc(t('common.close'))}">×</button>
    </div>
  `;
}

// Trim from the FRONT until the path fits its box: "…/server/src/client".
// Binary search on scrollWidth — font-agnostic, ~7 measurements, runs once per render.
// Must run after the header is attached to the document (needs layout to measure).
export function fitHeaderPath(root) {
  const el = root?.querySelector('.setup-modal-header-path');
  if (!el) return;
  const full = el.dataset.path || '';
  el.textContent = full;
  if (!full || el.scrollWidth <= el.clientWidth) return;
  let lo = 0, hi = full.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    el.textContent = '…' + full.slice(-mid);
    if (el.scrollWidth <= el.clientWidth) lo = mid; else hi = mid - 1;
  }
  el.textContent = '…' + full.slice(-lo);
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
