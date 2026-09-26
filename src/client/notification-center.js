// ── In-app notification stack (C1137, C1151) ──
//
// A fixed bottom-right column of cards that stay until dismissed (moved from top-right in
// C1151 — the old anchor sat on top of the board's filter controls). Exists because macOS's
// default "Banners" notification style auto-dismisses after ~5s and there is no app-side API to
// force "Alerts" style (see ai/architecture/tt-notifications.md § macOS Code-Signing Requirement
// / § In-app notification stack for the UNUserNotificationCenter finding this is built around).
// This module is the in-app fallback surface that persists regardless of OS notification style
// or platform, so a missed OS banner is not a missed prompt.
//
// Model first, DOM second (same split as notifications.js) — the model half is plain data and
// unit-testable under `node --test` with no `document`; `_render()` is the only DOM-touching
// piece, and it's a no-op outside a browser.

import { t } from './i18n.js';

const MAX_ENTRIES = 5;

// Ordered newest-first. Array, not Map, so eviction/reorder-to-top stay simple splices.
let _entries = [];

// Guards on createElement too, not just `document` existing — attention-notifications.js's own
// unit tests stub a minimal MockDocument (getElementById only, no createElement/body) so the
// model half (pushNotification/_entries) stays testable there without pulling in a full DOM.
function _hasDocument() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

// Upsert keyed by `tag` — an existing entry for the same tag is updated in place and moved to
// the top (fresh content, fresh position) instead of duplicated. Evicts the oldest entry past
// MAX_ENTRIES. Returns the stored entry.
export function pushNotification({ tag, title, body, onClick, category } = {}) {
  if (!tag) return null;
  _entries = _entries.filter((e) => e.tag !== tag);
  const entry = { tag, title: title || '', body: body || '', onClick: onClick || null, category: category || null };
  _entries.unshift(entry);
  if (_entries.length > MAX_ENTRIES) _entries.length = MAX_ENTRIES;
  _render();
  return entry;
}

export function dismissNotification(tag) {
  if (!tag) return;
  const before = _entries.length;
  _entries = _entries.filter((e) => e.tag !== tag);
  if (_entries.length !== before) _render();
}

export function clearAllNotifications() {
  if (!_entries.length) return;
  _entries = [];
  _render();
}

// Model read — used by tests and by _render(). Returns a shallow copy so callers can't mutate
// internal state by reference.
export function getNotificationEntries() {
  return _entries.slice();
}

// Glyph shown in the toast-style icon slot, keyed by entry.category (C1151 — mirrors the
// glyph convention utils.js#showToast() uses for its own corner-toast family).
function _categoryGlyph(category) {
  if (category === 'attention') return '!';
  if (category === 'objective') return '✓'; // ✓
  if (category === 'completed') return '✓'; // ✓ (C1355) — same glyph as objective, distinct color
  return 'ℹ'; // ℹ
}

// Creates a card element once. Click/close handlers read `el._entry` (kept live by _render()'s
// update-in-place path below) rather than closing over the `entry` passed at creation time, so
// an upsert that changes `onClick`/title/body never needs to re-bind or re-create the node —
// see _render()'s keyed-reuse comment (C1151).
function _cardEl(entry) {
  const card = document.createElement('div');
  card.className = 'tt-notif-card';
  card.dataset.tag = entry.tag;
  card._entry = entry;

  const icon = document.createElement('span');
  icon.className = 'tt-notif-card-icon';
  icon.setAttribute('aria-hidden', 'true');
  card._iconEl = icon;

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'tt-notif-card-body-wrap';

  const title = document.createElement('div');
  title.className = 'tt-notif-card-title';
  card._titleEl = title;

  const body = document.createElement('div');
  body.className = 'tt-notif-card-body';
  card._bodyEl = body;

  bodyWrap.append(title, body);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tt-notif-card-close';
  closeBtn.setAttribute('aria-label', t('notifCenter.dismiss'));
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    dismissNotification(card._entry.tag);
  });

  card.append(icon, bodyWrap, closeBtn);
  card.addEventListener('click', () => {
    try { card._entry.onClick && card._entry.onClick(); } catch (_) {}
    dismissNotification(card._entry.tag);
  });

  _updateCardEl(card, entry);
  return card;
}

// Refreshes an existing card's content/entry reference in place — no DOM re-creation, so an
// in-flight entrance transition (or the user's hover) is undisturbed by an unrelated upsert.
function _updateCardEl(card, entry) {
  card._entry = entry;
  card.classList.remove('tt-notif-card--attention', 'tt-notif-card--objective', 'tt-notif-card--completed');
  if (entry.category) card.classList.add(`tt-notif-card--${entry.category}`);
  card._iconEl.textContent = _categoryGlyph(entry.category);
  card._titleEl.textContent = entry.title;
  card._bodyEl.textContent = entry.body;
}

function _render() {
  if (!_hasDocument()) return;
  let stack = document.getElementById('tt-notif-stack');
  if (!_entries.length) {
    if (stack) stack.remove();
    return;
  }
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'tt-notif-stack';
    document.body.appendChild(stack);
  }

  // Keyed reuse (C1151): update/move existing card elements instead of tearing the stack down
  // and rebuilding it on every push/dismiss — that used to replay every card's entrance
  // transition as a flash on any unrelated change.
  const existingByTag = new Map();
  for (const el of stack.querySelectorAll('.tt-notif-card')) existingByTag.set(el.dataset.tag, el);

  let header = stack._headerEl;
  if (!header) {
    header = document.createElement('div');
    header.className = 'tt-notif-stack-header';
    const heading = document.createElement('span');
    heading.textContent = t('notifCenter.heading');
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'tt-notif-stack-clear';
    clearBtn.textContent = t('notifCenter.clearAll');
    clearBtn.addEventListener('click', () => clearAllNotifications());
    header.append(heading, clearBtn);
    stack._headerEl = header;
  }
  if (_entries.length > 1) {
    stack.appendChild(header); // first child — header renders above the card column
  } else if (header.isConnected) {
    header.remove();
  }

  const newlyCreated = [];
  for (const entry of _entries) {
    let el = existingByTag.get(entry.tag);
    if (el) {
      existingByTag.delete(entry.tag);
      _updateCardEl(el, entry);
    } else {
      el = _cardEl(entry);
      newlyCreated.push(el);
    }
    stack.appendChild(el); // (re)places in current _entries order — a move, not a re-create
  }

  // Anything left in existingByTag fell out of _entries (dismissed/evicted) — remove it.
  for (const el of existingByTag.values()) el.remove();

  if (newlyCreated.length) {
    requestAnimationFrame(() => {
      for (const el of newlyCreated) el.classList.add('is-shown');
    });
  }
}
