// Non-blocking confirmation dialog shared by Task Edit, chat, and settings.
import { t } from './i18n.js';
import { activateDialogFocus } from './dialog-focus.js';

export function showActionConfirm({ message, confirmLabel, danger = false, okOnly = false, overlayClass = 'modal-overlay--over-settings' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = `modal-overlay ${overlayClass}`;
    overlay.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="action-confirm-message">
        <p id="action-confirm-message">${message}</p>
        <div class="modal-buttons">
          ${okOnly ? '' : `<button class="btn-cancel">${t('btn.cancel')}</button>`}
          <button class="btn-confirm${danger ? ' settings-row-btn-danger' : ''}">${confirmLabel ?? t('btn.ok')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cancelBtn = overlay.querySelector('.btn-cancel');
    const focusHandle = activateDialogFocus({
      root: overlay,
      initialFocus: () => cancelBtn || overlay.querySelector('.btn-confirm'),
    });

    const finish = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      focusHandle.close();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      finish(false);
      e.preventDefault();
      e.stopPropagation();
    };
    if (cancelBtn) cancelBtn.addEventListener('click', () => finish(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    overlay.querySelector('.btn-confirm').addEventListener('click', () => finish(true));
    document.addEventListener('keydown', onKey, true);
  });
}
