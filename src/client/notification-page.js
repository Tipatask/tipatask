// (TPT484) The one compact notification page, rendered by the always-on-top banner
// (src/client/desktop-notifications.js) and the in-app panel (notification-center.js): count
// header with Clear All (the banner: Hide, TPT505), the newest cards, and a footer row with Show
// More (the banner adds its "Show" on-top checkbox there). Styles: notification-cards.css; the
// fixed heights are mirrored by pageHeight() in main/desktop-notifications.js.

import { t, tc } from './i18n.js';
import { desktopPageModel } from './desktop-notifications-model.js';

// Glyph shown in the toast-style icon slot, keyed by entry.category (C1151 — mirrors the
// glyph convention utils.js#showToast() uses for its own corner-toast family).
function _categoryGlyph(category) {
  if (category === 'attention') return '!';
  if (category === 'objective') return '✓'; // ✓
  if (category === 'completed') return '✓'; // ✓ (C1355) — same glyph as objective, distinct color
  return 'i';
}

// (TPT498) Splits "[Project · ]KEY: title" (attention-notifications.js#buildNotificationTitle,
// completion/activity titles) into the muted key prefix and the title text. Titles without a
// task key (uppercase letters + digits, e.g. TPT498) come back whole as `text`.
const TITLE_KEY_RE = /^((?:.*? · )?[A-Z][A-Z0-9]*-?\d+):\s+(\S[\s\S]*)$/;
export function splitNotificationTitle(title) {
  const value = String(title || '');
  const match = TITLE_KEY_RE.exec(value);
  return match ? { key: match[1], text: match[2] } : { key: '', text: value };
}

// Creates a card element once. Click/close handlers read `el._entry` (kept live by
// updateNotificationCard()) rather than closing over the `entry` passed at creation time, so an
// upsert that changes `onClick`/title/body never needs to re-bind or re-create the node (C1151).
// `onActivate`/`onClose` receive the card's current entry.
export function createNotificationCard(entry, { onActivate, onClose } = {}) {
  const card = document.createElement('div');
  card.className = 'tt-notif-card';
  card.dataset.tag = entry.tag;
  if (entry.id != null) card.dataset.id = entry.id;
  card._entry = entry;

  const icon = document.createElement('span');
  icon.className = 'tt-notif-card-icon';
  icon.setAttribute('aria-hidden', 'true');
  card._iconEl = icon;

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'tt-notif-card-body-wrap';

  // Title row: muted task-key prefix + title text; body: one span clamped by its row.
  const title = document.createElement('div');
  title.className = 'tt-notif-card-title';
  const key = document.createElement('span');
  key.className = 'tt-notif-key';
  card._keyEl = key;
  const titleText = document.createElement('span');
  titleText.className = 'tt-notif-title';
  card._titleEl = titleText;
  title.append(key, titleText);

  const body = document.createElement('div');
  body.className = 'tt-notif-card-body';
  const bodyText = document.createElement('span');
  bodyText.className = 'tt-notif-body';
  card._bodyEl = bodyText;
  body.append(bodyText);

  bodyWrap.append(title, body);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tt-notif-card-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    try { onClose?.(card._entry); } catch (_) {}
  });
  card._closeEl = closeBtn;

  card.append(icon, bodyWrap, closeBtn);
  const activate = () => { try { onActivate?.(card._entry); } catch (_) {} };
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.addEventListener('click', activate);
  card.addEventListener('keydown', (event) => {
    if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    activate();
  });

  updateNotificationCard(card, entry);
  return card;
}

// Refreshes an existing card's content/entry reference in place — no DOM re-creation, so an
// in-flight entrance transition (or the user's hover) is undisturbed by an unrelated upsert.
export function updateNotificationCard(card, entry) {
  card._entry = entry;
  card._closeEl.setAttribute('aria-label', entry.dismissLabel || t('notifCenter.dismiss'));
  card.classList.remove('tt-notif-card--attention', 'tt-notif-card--objective', 'tt-notif-card--completed');
  if (entry.category) card.classList.add(`tt-notif-card--${entry.category}`);
  card.dataset.category = entry.category || 'info'; // badge color (notification-cards.css)
  card._iconEl.textContent = _categoryGlyph(entry.category);
  const { key, text } = splitNotificationTitle(entry.title);
  card._keyEl.textContent = key;
  card._keyEl.hidden = !key;
  card._titleEl.textContent = text;
  card._bodyEl.textContent = entry.body || '';
  card.title = entry.title || '';
}

function _button(className, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.addEventListener('click', onClick);
  return el;
}

function _reveal(cards) {
  if (!cards.length) return;
  const show = () => { for (const el of cards) el.classList.add('is-shown'); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(show);
  else show();
}

// Renders `entries` (newest first, each with a stable `id`) into `host`, reusing card nodes by
// id so an arrival never re-creates (flashes) a visible card. `act(id, action)` receives
// 'click' | 'close' | 'clear-all' | 'hide' | 'show-more' | 'on-top-off'. `paged: false` shows
// every entry (the stack scrolls) for the browser-mode local list; `header: false` hides the
// count row. `headerAction` picks the header button: 'clear-all' (default) or 'hide' (the banner,
// TPT505 — keeps every alert). `onTopToggle` adds the footer's checked "Show" box (banner only);
// unchecking it acts 'on-top-off'.
export function renderNotificationPage(host, entries, act,
  { paged = true, header = true, headerAction = 'clear-all', onTopToggle = false } = {}) {
  let page = host.querySelector(':scope > .tt-notif-page');
  if (!entries.length) { page?.remove(); return null; }
  const model = paged ? desktopPageModel(entries)
    : { total: entries.length, visible: entries, hasMore: false, hidden: 0 };
  if (!page) {
    page = document.createElement('div');
    page.className = 'tt-notif-page';
    const head = document.createElement('div');
    head.className = 'tt-notif-page-header';
    const count = document.createElement('span');
    count.className = 'tt-notif-page-count';
    const action = _button('', () => page._act(null, page._headerAction));
    head.append(count, action);
    const cards = document.createElement('div');
    cards.className = 'tt-notif-page-cards';
    const footer = document.createElement('div');
    footer.className = 'tt-notif-page-footer';
    const onTop = document.createElement('label');
    onTop.className = 'tt-notif-page-ontop';
    const onTopInput = document.createElement('input');
    onTopInput.type = 'checkbox';
    const onTopText = document.createElement('span');
    onTop.append(onTopInput, onTopText);
    onTopInput.addEventListener('change', () => { if (!onTopInput.checked) page._act(null, 'on-top-off'); });
    const more = _button('tt-notif-page-more', () => page._act(null, 'show-more'));
    footer.append(onTop, more);
    page.append(head, cards, footer);
    page._handlers = { onActivate: (e) => page._act(e.id, 'click'), onClose: (e) => page._act(e.id, 'close') };
    Object.assign(page, { _head: head, _count: count, _action: action, _cards: cards, _footer: footer,
      _onTop: onTop, _onTopInput: onTopInput, _onTopText: onTopText, _more: more });
    host.appendChild(page);
  }
  const hide = headerAction === 'hide';
  page._act = act;
  page._headerAction = hide ? 'hide' : 'clear-all';
  page.classList.toggle('is-paged', paged);
  page._head.hidden = !header;
  page._count.textContent = tc('notifCenter.count', model.total);
  page._action.className = hide ? 'tt-notif-page-hide' : 'tt-notif-page-clear';
  page._action.textContent = t(hide ? 'notifCenter.hide' : 'notifCenter.clearAll');
  page._onTop.hidden = !onTopToggle;
  page._onTop.title = t('notifCenter.showOnTopTitle');
  page._onTopText.textContent = t('notifCenter.showOnTop');
  // Shown only while "Show on Top" is on, so it always renders checked.
  page._onTopInput.checked = true;
  page._more.textContent = t('notifCenter.showMore', { n: model.hidden });
  page._more.hidden = !model.hasMore;
  page._footer.hidden = !onTopToggle && !model.hasMore;

  const existing = new Map([...page._cards.children].map((el) => [el.dataset.id, el]));
  const created = [];
  for (const entry of model.visible) {
    const card = { ...entry, id: String(entry.id), dismissLabel: t('notifCenter.dismiss') };
    let el = existing.get(card.id);
    if (el) { existing.delete(card.id); updateNotificationCard(el, card); }
    else { el = createNotificationCard(card, page._handlers); created.push(el); }
    page._cards.appendChild(el);
  }
  for (const el of existing.values()) el.remove();
  _reveal(created);
  return page;
}
