import { t } from './i18n.js';
import { permissionModeLabel } from './permission-mode.js';

export function renderTerminalPermissions(overlay, message, send) {
  let label = overlay.querySelector('.terminal-permission-mode');
  if (message.permissionMode) {
    if (!label) {
      label = document.createElement('span');
      label.className = 'terminal-permission-mode';
      const header = overlay.querySelector('.terminal-header');
      header.insertBefore(label, header.querySelector('.terminal-header-actions'));
    }
    label.textContent = t('terminal.permission.run', { mode: permissionModeLabel(message.permissionMode, t) });
    label.title = t(message.permissionSource === 'project' ? 'terminal.permission.inherited' : 'terminal.permission.fixed');
  } else label?.remove();
  const request = message.permissionRequest;
  let panel = overlay.querySelector('.terminal-permission-request');
  if (!request) { panel?.remove(); return; }
  if (panel?.dataset.requestId === request.id) {
    // A reconnect can repeat an unanswered request after the answer frame was
    // lost. The server's single-use id makes retrying safe.
    panel.querySelectorAll('button').forEach(b => { b.disabled = false; });
    return;
  }
  panel?.remove();
  panel = document.createElement('div');
  panel.className = 'terminal-permission-request';
  panel.dataset.requestId = request.id;
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', t('terminal.permission.title'));
  const title = document.createElement('strong');
  title.textContent = `${t('terminal.permission.title')}: ${request.tool}`;
  const details = document.createElement('pre');
  details.textContent = request.input;
  panel.append(title, details);
  for (const [allow, key] of [[false, 'terminal.permission.deny'], [true, 'terminal.permission.allow']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t(key);
    button.addEventListener('click', () => {
      if (send({ type: 'permission-answer', id: request.id, allow }) !== false) {
        panel.querySelectorAll('button').forEach(b => { b.disabled = true; });
      }
    });
    panel.appendChild(button);
  }
  overlay.querySelector('.terminal-container').appendChild(panel);
}
