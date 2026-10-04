// In-app notification panel for project windows. The local model (`_entries`) owns this
// window's cards and their click/dismiss callbacks; it upserts by (project, tag) and never
// evicts by count. Model operations work without a DOM.
//
// (TPT484) Under Electron every card is also mirrored into main's shared alert registry
// (main/desktop-notifications.js), which owns one identity per (project, tag) and decides
// which surface shows the whole set: the focused project window's in-app panel, or the
// always-on-top banner while another app is focused. While shared, this window renders main's
// snapshot (every project's alerts, paged like the banner) only when it is the active host,
// and nothing otherwise. Browser mode and the "on top" setting turned off fall back to
// rendering the local model. Both surfaces render the same page (notification-page.js).

import { t, getLocale } from './i18n.js';
import { renderNotificationPage, createNotificationCard, updateNotificationCard } from './notification-page.js';

export { createNotificationCard, updateNotificationCard };

// Ordered newest-first; tag upserts move to the front.
let _entries = [];
// Main's decision for this window: shared registry on?, this window the in-app host?, and the
// all-project snapshot to render while active.
let _surface = { shared: false, active: false, entries: [] };
let _surfaceInstalled = false;
// Monotonic per-window card sequence. Main echoes the newest sequence it has seen for an alert
// on dismiss/click, so a late removal never takes a card pushed again after it.
let _seq = 0;

export function notificationProjectPath() {
  try {
    return window.electronAPI?.getProjectPath?.()
      || new URLSearchParams(window.location?.search || '').get('projectPath') || null;
  } catch (_) { return null; }
}

export function taskNotificationTags(taskId) {
  return new Set([taskId, `activity-${taskId}`, `completed-${taskId}`]);
}

const entryKey = (entry) => JSON.stringify([entry.projectPath, entry.tag]);
const _api = () => (typeof window !== 'undefined' ? window.electronAPI : null);

function _mirror(method, ...args) {
  try {
    const result = _api()?.[method]?.(...args);
    Promise.resolve(result).catch(() => {});
  } catch (_) {}
}

function _mirrorPush(entry) {
  if (entry.projectPath !== notificationProjectPath()) return;
  _mirror('pushSharedNotification', { tag: entry.tag, title: entry.title, body: entry.body,
    category: entry.category, locale: entry.locale, seq: entry.seq });
}

// Local-only removal; returns the removed entry. Never mirrors and never runs callbacks.
// `upTo`: only remove a card main had already seen (seq <= upTo).
function _removeLocal(tag, projectPath, upTo = null) {
  const entry = _entries.find((e) => e.tag === tag && e.projectPath === projectPath);
  if (!entry || (Number.isFinite(upTo) && entry.seq > upTo)) return null;
  _entries = _entries.filter((e) => e !== entry);
  _render();
  return entry;
}

// Remove presentation state only: no activation/dismiss callbacks or API read writes. Main's
// matching entries are removed by notifications.js#dismissTaskNotifications (notify:dismiss-task).
export function dismissTaskNotificationCards(taskId, projectPath = notificationProjectPath()) {
  if (!taskId) return;
  const tags = taskNotificationTags(taskId);
  const before = _entries.length;
  _entries = _entries.filter((entry) => entry.projectPath !== projectPath || !tags.has(entry.tag));
  if (_entries.length !== before) _render();
}

// Guards on createElement too, not just `document` existing — attention-notifications.js's own
// unit tests stub a minimal MockDocument (getElementById only, no createElement/body) so the
// model half (pushNotification/_entries) stays testable there without pulling in a full DOM.
function _hasDocument() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

// Upsert keyed by (project, tag) — an existing entry is updated in place and moved to the top
// instead of duplicated. No count-based eviction. Mirrored to main's shared registry (TPT484)
// under the same identity, so the banner and this panel never show it twice. Returns the entry.
export function pushNotification({ tag, title, body, onClick, onDismiss, category, showClearAll = true } = {}) {
  if (!tag) return null;
  const projectPath = notificationProjectPath();
  _entries = _entries.filter((e) => e.tag !== tag || e.projectPath !== projectPath);
  const entry = { tag, projectPath, title: title || '', body: body || '', onClick: onClick || null, category: category || null, onDismiss, showClearAll, dismissLabel: t('notifCenter.dismiss'), locale: _safeLocale(), seq: ++_seq };
  _entries.unshift(entry);
  _render();
  _mirrorPush(entry);
  return entry;
}

function _safeLocale() {
  try { return getLocale(); } catch (_) { return 'en'; }
}

// Programmatic removal (resolved prompt, opened objective, ...). Also removes the shared alert
// of the same identity, so a dismissed alert cannot come back on the other surface.
export function dismissNotification(tag, projectPath = notificationProjectPath()) {
  if (!tag) return;
  _removeLocal(tag, projectPath);
  if (projectPath === notificationProjectPath()) _mirror('dismissSharedNotification', tag);
}

export function clearAllNotifications() {
  if (!_entries.length) return;
  _entries = [];
  _render();
}

// (TPT484) Main removed an alert (closed on either surface, Clear All, completion cleanup):
// drop the local card without callbacks. Returns true when one was removed.
export function removeLocalNotification(tag, projectPath = notificationProjectPath(), { upTo = null } = {}) {
  return !!(tag && _removeLocal(tag, projectPath, upTo));
}

// (TPT484) Main routed a click to this window for an alert whose callback lives on the local
// card (no notify() callback registered). Removes the card, then runs its onClick exactly once.
export function activateLocalNotification(tag, projectPath = notificationProjectPath(), { upTo = null } = {}) {
  const entry = tag && _removeLocal(tag, projectPath, upTo);
  if (!entry || typeof entry.onClick !== 'function') return false;
  try { entry.onClick(); } catch (_) {}
  return true;
}

// Model read — used by tests and by _render(). Returns a shallow copy so callers can't mutate
// internal state by reference.
export function getNotificationEntries() {
  return _entries.slice();
}

export function getNotificationSurface() {
  return { ..._surface, entries: _surface.entries.slice() };
}

// (TPT484) Applies main's surface decision for this window. When sharing turns on (first read,
// or the on-top setting re-enabled), re-mirror this window's local cards so main holds them.
export function applyNotificationSurface(state = {}) {
  const wasShared = _surface.shared;
  const wasActive = _surface.active;
  _surface = { shared: !!state.shared, active: !!state.shared && !!state.active,
    entries: Array.isArray(state.entries) ? state.entries : [] };
  if (_surface.shared && !wasShared) for (const entry of _entries.slice().reverse()) _mirrorPush(entry);
  if (_surface.active && !wasActive) _sendTheme();
  _render();
}

// Banner colors follow the in-app host's palette, so both surfaces look the same.
const THEME_TOKENS = { bg: '--c-bg-card', text: '--c-text', muted: '--c-text-muted', border: '--c-border',
  primary: '--c-primary', warning: '--c-warning', success: '--c-success', shadow: '--c-shadow' };
function _sendTheme() {
  if (!_hasDocument() || typeof getComputedStyle !== 'function' || !document.documentElement) return;
  try {
    const style = getComputedStyle(document.documentElement);
    const tokens = {};
    for (const [key, prop] of Object.entries(THEME_TOKENS)) tokens[key] = style.getPropertyValue(prop).trim();
    _api()?.setNotificationTheme?.(tokens);
  } catch (_) {}
}

export function installNotificationSurface() {
  const api = _api();
  if (_surfaceInstalled || typeof api?.onNotificationSurface !== 'function') return false;
  _surfaceInstalled = true;
  api.onNotificationSurface((state) => applyNotificationSurface(state));
  try {
    Promise.resolve(api.notificationSurfaceState?.()).then((state) => {
      if (state) applyNotificationSurface(state);
    }).catch(() => {});
  } catch (_) {}
  // A theme switch while hosting re-sends the palette to the banner.
  try {
    if (typeof MutationObserver === 'function' && _hasDocument()) {
      new MutationObserver(() => { if (_surface.active) _sendTheme(); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
  } catch (_) {}
  return true;
}

// Local-mode actions: activating or closing removes the entry first, then runs its callback.
function _localAct(id, action) {
  if (action === 'clear-all') return clearAllNotifications();
  const entry = _entries.find((e) => entryKey(e) === id);
  if (!entry) return;
  dismissNotification(entry.tag, entry.projectPath);
  if (action === 'click') entry.onClick?.();
  else if (action === 'close') entry.onDismiss?.();
}

// Shared-mode actions go to main, which owns the alert and routes clicks to its project.
function _sharedAct(id, action) {
  try { _api()?.notificationSurfaceAction?.(action, id); } catch (_) {}
}

function _render() {
  if (!_hasDocument()) return;
  const shared = _surface.shared;
  const entries = shared
    ? (_surface.active ? _surface.entries : [])
    : _entries.map((e) => ({ ...e, id: entryKey(e) }));
  let stack = document.getElementById('tt-notif-stack');
  if (!entries.length) {
    if (stack) stack.remove();
    return;
  }
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'tt-notif-stack';
    document.body.appendChild(stack);
  }
  if (shared) {
    renderNotificationPage(stack, entries, _sharedAct);
  } else {
    renderNotificationPage(stack, entries, _localAct, { paged: false,
      header: entries.length > 1 && _entries.every((e) => e.showClearAll) });
  }
}
