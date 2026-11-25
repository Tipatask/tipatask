// ── Create modal shell (TPT9389) ──
// New Objective and New Task open in one large dialog over the project board instead of
// replacing it. This module owns only the shell: the body-level `.objective-modal` host, its
// open/closed state, keyboard focus and the three close gestures (×, Escape, backdrop). What is
// shown inside is rendered by template.html's loadAndRender() into objectiveModalBody() while
// state.activeTab is 'objective' or 'new_task'; closing goes through the handler template.html
// registers, because leaving Create is a page-state change (state.activeTab, left menu, board).
//
// The board is not made inert through dialog-focus.js: Create used to be a page, and the
// surfaces that open over it (History, the objective console, wizards, the image lightbox,
// notification cards) do not all own a dialog-focus layer. Focus is kept inside this dialog and
// the left menu by a Tab cycle and a focusin guard instead; a real dialog-focus layer opened on
// top takes over while it is up.
import { t } from './i18n.js';
import { hasOpenDialog } from './dialog-focus.js';
import { createMode } from './create-modes.js';

export const OBJECTIVE_MODAL_ID = 'objective-modal';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';
// Open popups and in-place edits inside the dialog own the first Escape. Several of these stay in
// the DOM while closed (the tag list, a sprint list), so only a displayed one counts.
const ESCAPE_OWNERS = '.import-submenu, .sprint-combo-dropdown, .tag-dropdown, '
  + '.dep-typeahead-dropdown, .member-typeahead-dropdown, .mention-dropdown, '
  + '.preview-title.editing, .preview-desc.editing';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

let _closeHandler = null;
let _isCovered = null;
let _returnFocus = null;
let _lastFocused = null;
let _backdropPressed = false;
let _escapeIsOurs = false;
let _documentBound = false;

function host() {
  return typeof document === 'undefined' ? null : document.getElementById(OBJECTIVE_MODAL_ID);
}

function panel() {
  return host()?.querySelector('.objective-modal-panel') || null;
}

/** The element Create content renders into, or null before the dialog was first opened. */
export function objectiveModalBody() {
  return host()?.querySelector('.objective-modal-body') || null;
}

export function isObjectiveModalOpen() {
  const el = host();
  return !!el && !el.hidden;
}

/**
 * `onRequestClose(reason)` runs for ×, Escape and a backdrop click ('button' | 'escape' |
 * 'backdrop'). `isCovered()` reports another overlay above the dialog, which then keeps the
 * keyboard: no Escape close, no Tab cycle.
 */
export function configureObjectiveModal({ onRequestClose, isCovered } = {}) {
  _closeHandler = typeof onRequestClose === 'function' ? onRequestClose : null;
  _isCovered = typeof isCovered === 'function' ? isCovered : null;
}

function covered() {
  if (hasOpenDialog()) return true;
  try { return !!_isCovered?.(); } catch { return false; }
}

function requestClose(reason) {
  if (_closeHandler) _closeHandler(reason);
  else closeObjectiveModal();
}

function visible(el) {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function focusablesIn(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)]
    .filter(el => el.tabIndex >= 0 && !el.disabled && !el.closest('[hidden], [inert]') && visible(el));
}

// The dialog first, then the left menu: it stays uncovered and usable, so it stays in the cycle.
// The two sit far apart in the document, so the order is kept here, not left to the browser.
function tabCycle() {
  return [...focusablesIn(panel()), ...focusablesIn(document.getElementById('left-nav-panel'))];
}

function preferredFocus() {
  const root = panel();
  if (!root) return null;
  const wanted = root.querySelector('#chat-input:not(:disabled), #new-task-title:not(:disabled)');
  if (wanted && visible(wanted)) return wanted;
  return focusablesIn(root.querySelector('.objective-modal-body'))[0] || root;
}

/** Moves keyboard focus into the dialog: the composer, the New Task title, or the panel. */
export function focusObjectiveModal() {
  if (!isObjectiveModalOpen()) return false;
  const target = preferredFocus();
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

// Whether an Escape is the dialog's to act on. Decided in the capture phase, before any other
// listener runs: a menu or a dialog above that closes itself on this same keypress would be gone
// by the time the bubble-phase handler looked, and one Escape would then close both.
function escapeIsForDialog(event) {
  if (!isObjectiveModalOpen() || covered()) return false;
  const root = host();
  const target = event.target instanceof Element ? event.target : null;
  // Escape typed inside some other body-level surface belongs to that surface.
  if (target && target !== document.body && target !== document.documentElement
    && !root.contains(target) && !target.closest('#left-nav-panel')) return false;
  return ![...document.querySelectorAll(ESCAPE_OWNERS)].some(visible);
}

function onDocumentKeydownCapture(event) {
  if (event.key === 'Escape') {
    _escapeIsOurs = escapeIsForDialog(event);
    return;
  }
  if (event.key !== 'Tab' || !isObjectiveModalOpen() || covered()) return;
  const active = document.activeElement;
  // A menu the dialog moved to <body> while it is open keeps its own Tab order.
  if (active && active !== document.body && !panel().contains(active)
    && !active.closest('#left-nav-panel, #app')) return;
  event.preventDefault();
  const items = tabCycle();
  if (!items.length) {
    panel().focus({ preventScroll: true });
    return;
  }
  const index = items.indexOf(active);
  const step = event.shiftKey ? -1 : 1;
  const next = index < 0
    ? (event.shiftKey ? items[items.length - 1] : items[0])
    : items[(index + step + items.length) % items.length];
  next.focus({ preventScroll: true });
}

function onDocumentKeydown(event) {
  if (event.key !== 'Escape') return;
  const ours = _escapeIsOurs;
  _escapeIsOurs = false;
  if (!ours || event.defaultPrevented || !isObjectiveModalOpen()) return;
  event.preventDefault();
  requestClose('escape');
}

function onDocumentFocusin(event) {
  if (!isObjectiveModalOpen()) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const root = panel();
  if (root.contains(target)) { _lastFocused = target; return; }
  // The board is behind the backdrop: focus that lands there comes back to the dialog.
  if (covered() || !target.closest('#app')) return;
  const back = _lastFocused?.isConnected && root.contains(_lastFocused) && visible(_lastFocused)
    ? _lastFocused : preferredFocus();
  back?.focus({ preventScroll: true });
}

function bindDocument() {
  if (_documentBound) return;
  _documentBound = true;
  document.addEventListener('keydown', onDocumentKeydownCapture, true);
  document.addEventListener('keydown', onDocumentKeydown);
  document.addEventListener('focusin', onDocumentFocusin, true);
}

function build() {
  const overlay = document.createElement('div');
  overlay.id = OBJECTIVE_MODAL_ID;
  overlay.className = 'objective-modal';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="objective-modal-panel" role="dialog" aria-modal="true" tabindex="-1">`
    + `<button type="button" class="objective-modal-close">${CLOSE_ICON}</button>`
    + `<div class="objective-modal-body" id="objective-modal-body"></div></div>`;
  // Close only on a press that both starts and ends on the backdrop, so a text selection
  // dragged out of the composer never dismisses the dialog.
  overlay.addEventListener('mousedown', (event) => { _backdropPressed = event.target === overlay; });
  overlay.addEventListener('click', (event) => {
    const onBackdrop = _backdropPressed && event.target === overlay;
    _backdropPressed = false;
    if (onBackdrop) requestClose('backdrop');
  });
  overlay.querySelector('.objective-modal-close').addEventListener('click', () => requestClose('button'));
  document.body.appendChild(overlay);
  bindDocument();
  return overlay;
}

function applyLabels(overlay, mode) {
  const root = overlay.querySelector('.objective-modal-panel');
  const shown = createMode(mode);
  root.dataset.mode = shown.mode;
  // (TPT9390) The dialog is called what its heading and the Create flyout's entry call it.
  root.setAttribute('aria-label', t(shown.labelKey));
  const close = overlay.querySelector('.objective-modal-close');
  close.setAttribute('aria-label', t('btn.close'));
  close.title = `${t('btn.close')} (Esc)`;
}

/**
 * Shows the dialog for `mode` ('objective' | 'new_task') and returns the element to render into.
 * Safe to call on every render: an open dialog only refreshes its labels. `opened` is true on
 * the call that actually opened it — the caller moves focus in once its content is rendered.
 */
export function openObjectiveModal({ mode = 'objective' } = {}) {
  const overlay = host() || build();
  const opened = overlay.hidden;
  applyLabels(overlay, mode);
  if (opened) {
    const active = document.activeElement;
    _returnFocus = active && active !== document.body ? active : null;
    _lastFocused = null;
    // The page behind is held still (styles.css). Its scrollbar track stays reserved only when
    // that scrollbar takes layout space, so the board keeps its exact width either way.
    const root = document.documentElement;
    root.classList.toggle('objective-modal-open--gutter', window.innerWidth - root.clientWidth > 0);
    root.classList.add('objective-modal-open');
    overlay.hidden = false;
  }
  return { body: overlay.querySelector('.objective-modal-body'), opened };
}

/**
 * Hides the dialog and removes its content. Drafts and running turns live in state, not in this
 * DOM, so nothing is lost; the next open renders it again. Returns whether it was open.
 */
export function closeObjectiveModal({ restoreFocus = true } = {}) {
  const overlay = host();
  if (!overlay || overlay.hidden) return false;
  const hadFocus = overlay.contains(document.activeElement);
  overlay.hidden = true;
  overlay.querySelector('.objective-modal-body').innerHTML = '';
  document.documentElement.classList.remove('objective-modal-open', 'objective-modal-open--gutter');
  const back = _returnFocus;
  _returnFocus = null;
  _lastFocused = null;
  if (restoreFocus && hadFocus && !hasOpenDialog()) {
    const target = back?.isConnected && !back.closest('[hidden], [inert]') && visible(back)
      ? back : document.querySelector('#left-nav-panel [data-section="new"]');
    target?.focus({ preventScroll: true });
  }
  return true;
}
