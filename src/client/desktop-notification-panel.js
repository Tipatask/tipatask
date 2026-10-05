// (TPT480) Full desktop-notification list inside a project window. The always-on-top banner
// window (main/desktop-notifications.js) shows only the five newest; its "Show More" focuses
// the newest notification's project window, and main sends that window the whole list here.
// main owns the model — this module renders snapshots and sends per-entry actions back, so a
// card for another project focuses that project's window (main's onClick routing).

import { createNotificationCard, updateNotificationCard } from './notification-center.js';
import { t, tc } from './i18n.js';

const PANEL_ID = 'tt-desktop-notif-panel';
// (TPT516) Expand toggle chevrons: up while collapsed (expand), down while expanded (collapse).
const _chevron = (points) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="${points}"></polyline></svg>`;
const CHEVRON_UP = _chevron('6 15 12 9 18 15');
const CHEVRON_DOWN = _chevron('6 9 12 15 18 9');
let _entries = [];
let _expanded = false;
let _installed = false;

const _api = () => (typeof window !== 'undefined' ? window.electronAPI : null);
const _act = (action, id) => { try { _api()?.desktopNotificationListAction?.(action, id); } catch (_) {} };
const _cardHandlers = { onActivate: (entry) => _act('click', entry.tag), onClose: (entry) => _act('close', entry.tag) };

function _button(className, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.addEventListener('click', onClick);
  return el;
}

function _close() {
  document.getElementById(PANEL_ID)?.remove();
  _act('panel-closed');
}

function _build() {
  const panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'region');
  const header = document.createElement('div');
  header.className = 'tt-dnp-header';
  const count = document.createElement('span');
  count.className = 'tt-dnp-count';
  const clear = _button('tt-dnp-clear', () => _act('clear-all'));
  const toggle = _button('tt-dnp-icon tt-dnp-toggle', () => { _expanded = !_expanded; _render(); });
  const close = _button('tt-dnp-icon tt-dnp-close', _close);
  close.textContent = '×';
  header.append(count, clear, toggle, close);
  const list = document.createElement('div');
  list.className = 'tt-dnp-list';
  const empty = document.createElement('div');
  empty.className = 'tt-dnp-empty';
  panel.append(header, list, empty);
  Object.assign(panel, { _count: count, _clear: clear, _toggle: toggle, _close: close, _list: list, _empty: empty });
  document.body.appendChild(panel);
  return panel;
}

function _render() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  panel.classList.toggle('is-expanded', _expanded);
  panel.setAttribute('aria-label', t('notifCenter.heading'));
  panel._count.textContent = tc('notifCenter.count', _entries.length);
  panel._clear.textContent = t('notifCenter.clearAll');
  panel._clear.hidden = !_entries.length;
  const toggleLabel = t(_expanded ? 'notifCenter.collapse' : 'notifCenter.expand');
  panel._toggle.innerHTML = _expanded ? CHEVRON_DOWN : CHEVRON_UP;
  panel._toggle.title = toggleLabel;
  panel._toggle.setAttribute('aria-label', toggleLabel);
  panel._toggle.setAttribute('aria-pressed', String(_expanded));
  panel._close.title = t('notifCenter.closePanel');
  panel._close.setAttribute('aria-label', t('notifCenter.closePanel'));
  panel._empty.textContent = t('notifCenter.empty');
  panel._empty.hidden = _entries.length > 0;

  // Keyed reuse by banner id — same discipline as notification-center.js's stack.
  const existing = new Map([...panel._list.children].map((el) => [el.dataset.tag, el]));
  for (const entry of _entries) {
    const model = { ...entry, tag: entry.id, dismissLabel: t('notifCenter.dismiss') };
    let el = existing.get(entry.id);
    if (el) { existing.delete(entry.id); updateNotificationCard(el, model); }
    else { el = createNotificationCard(model, _cardHandlers); el.classList.add('is-shown'); }
    panel._list.appendChild(el);
  }
  for (const el of existing.values()) el.remove();
}

function _onList(type, entries) {
  if (type === 'close') { document.getElementById(PANEL_ID)?.remove(); return; }
  _entries = Array.isArray(entries) ? entries : [];
  if (type === 'open' && !document.getElementById(PANEL_ID)) _build();
  _render();
}

export function installDesktopNotificationPanel() {
  const api = _api();
  if (_installed || typeof api?.onDesktopNotificationList !== 'function') return false;
  _installed = true;
  api.onDesktopNotificationList(_onList);
  return true;
}

installDesktopNotificationPanel();
