// ── Create flyout (TPT9390) ──
// The left menu's Create item is a menu button. Its menu opens to the right of the menu rail and
// lists the Create modes (create-modes.js) — New Objective and New Task, each with a one-line
// hint. A pick opens the Create modal (objective-modal.js) in that mode; that part is the page's,
// and template.html passes it in as `onSelect(mode)`. This module owns the menu alone: its DOM,
// the three ways it opens (click, hover, keyboard), where it sits and when it closes.
//
// The menu is a child of <body>, not of the rail: #left-nav-panel clips its content, and the menu
// has to paint over whatever is beside the rail — the board, the Create modal, a task terminal.
// styles.css puts it at the rail's edge (expanded, collapsed, narrow window); only its vertical
// position is computed here, from the Create item.
import { t } from './i18n.js';
import { hasOpenDialog } from './dialog-focus.js';
import { CREATE_MODES, createMode } from './create-modes.js';

export const CREATE_FLYOUT_ID = 'create-flyout';
export const CREATE_FLYOUT_MENU_ID = 'create-flyout-menu';
// Hover intent. Opening waits long enough that a pointer crossing the item on its way somewhere
// else opens nothing; closing waits long enough for the trip from the item across to the menu.
export const HOVER_OPEN_MS = 140;
export const HOVER_CLOSE_MS = 260;
const WINDOW_EDGE = 8; // kept clear between the menu and the window's top and bottom
const LIFT = 6;        // the menu's own padding: its first entry sits level with the Create item

let _trigger = null;
let _onSelect = null;
// How the open menu was opened — 'hover' | 'click' | 'keyboard' — and null while it is closed.
// A hover menu follows the pointer; the other two stay until they are dismissed.
let _via = null;
let _openTimer = null;
let _closeTimer = null;
let _globalsBound = false;

function host() {
  return typeof document === 'undefined' ? null : document.getElementById(CREATE_FLYOUT_ID);
}

function items() {
  return [...(host()?.querySelectorAll('.create-flyout-item') || [])];
}

function isNode(value) {
  return !!value && typeof value.nodeType === 'number';
}

// The menu or its button: the two places the menu's own pointer and keyboard handling live.
function inside(target) {
  return isNode(target) && (!!host()?.contains(target) || !!_trigger?.contains(target));
}

export function isCreateFlyoutOpen() {
  const el = host();
  return !!el && !el.hidden;
}

function cancelOpen() {
  if (_openTimer) clearTimeout(_openTimer);
  _openTimer = null;
}

function cancelClose() {
  if (_closeTimer) clearTimeout(_closeTimer);
  _closeTimer = null;
}

/**
 * Where the menu's top edge goes: level with the Create item, pulled up as far as it takes to
 * keep the menu's foot inside the window, and never above the window's top.
 */
export function createFlyoutTop({ anchorTop = 0, menuHeight = 0, viewportHeight = 0 } = {}) {
  const wanted = anchorTop - LIFT;
  return Math.round(Math.max(WINDOW_EDGE, Math.min(wanted, viewportHeight - menuHeight - WINDOW_EDGE)));
}

function place() {
  const el = host();
  if (!el || !_trigger) return;
  const top = createFlyoutTop({
    anchorTop: _trigger.getBoundingClientRect().top,
    menuHeight: el.getBoundingClientRect().height,
    viewportHeight: document.documentElement.clientHeight || window.innerHeight || 0,
  });
  if (el.style.getPropertyValue('--create-flyout-top') !== `${top}px`) el.style.setProperty('--create-flyout-top', `${top}px`);
}

function focusItem(index) {
  const list = items();
  if (list.length) list[((index % list.length) + list.length) % list.length].focus({ preventScroll: true });
}

// The page syncs the menu on every render and on every objective status event, so nothing here
// writes to the DOM unless the value changed.
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function setAttr(el, name, value) {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

/**
 * Brings the menu up to date with the page: its strings in the project language, which mode the
 * Create modal is showing (`current`: 'objective' | 'new_task' | null while it is closed), and
 * whether an objective is being planned (`running`) or has proposals waiting (`ready`) — New
 * Objective then says so, since that is the entry that leads to them.
 */
export function syncCreateFlyout({ current = null, running = false, ready = false } = {}) {
  const el = host();
  if (!el) return;
  setAttr(el.querySelector('.create-flyout-menu'), 'aria-label', t('nav.create'));
  for (const item of items()) {
    const mode = createMode(item.dataset.mode);
    setText(item.querySelector('.create-flyout-label'), t(mode.labelKey));
    setText(item.querySelector('.create-flyout-hint'), t(mode.hintKey));
    const isCurrent = current === mode.mode;
    if (item.classList.contains('is-current') !== isCurrent) item.classList.toggle('is-current', isCurrent);
    setAttr(item, 'aria-current', isCurrent ? 'true' : null);
    const status = item.querySelector('.create-flyout-status');
    const state = mode.mode !== 'objective' ? '' : running ? 'running' : ready ? 'ready' : '';
    if (status.hidden !== !state) status.hidden = !state;
    setAttr(status, 'data-state', state || null);
    setText(status.querySelector('.create-flyout-status-text'),
      state === 'running' ? t('nav.createFlyoutPlanning') : state === 'ready' ? t('nav.createFlyoutReady') : '');
    const hintId = `create-flyout-${mode.mode}-hint`;
    setAttr(item, 'aria-describedby', state ? `${hintId} create-flyout-${mode.mode}-status` : hintId);
  }
  // A longer string can make the menu taller: keep its foot inside the window.
  if (!el.hidden) place();
}

/**
 * Shows the menu. `via` is what opened it ('hover' | 'click' | 'keyboard'); `focus` moves the
 * keyboard into it ('first' | 'last'). Calling it on an open menu only updates those two.
 * False when there is no mounted menu, or a dialog owns the page.
 */
export function openCreateFlyout({ via = 'click', focus = null } = {}) {
  const el = host();
  if (!el || !_trigger?.isConnected || hasOpenDialog()) return false;
  cancelOpen();
  cancelClose();
  _via = via;
  if (el.hidden) {
    el.hidden = false;
    _trigger.setAttribute('aria-expanded', 'true');
    place();
  }
  if (focus) focusItem(focus === 'last' ? -1 : 0);
  return true;
}

/**
 * Hides the menu. Keyboard focus that was inside it goes back to the Create item, so it is never
 * left on a hidden entry. Returns whether the menu was open.
 */
export function closeCreateFlyout() {
  cancelOpen();
  cancelClose();
  _via = null;
  const el = host();
  if (!el || el.hidden) return false;
  const hadFocus = el.contains(document.activeElement);
  el.hidden = true;
  _trigger?.setAttribute('aria-expanded', 'false');
  if (hadFocus && _trigger?.isConnected) _trigger.focus({ preventScroll: true });
  return true;
}

// ── The Create item ──

function onTriggerClick(event) {
  // Enter and Space arrive as a click with no pointer behind it (detail 0): the keyboard then
  // goes into the menu. A mouse click leaves focus on the item.
  const keyboard = event.detail === 0;
  if (!isCreateFlyoutOpen()) {
    openCreateFlyout({ via: keyboard ? 'keyboard' : 'click', focus: keyboard ? 'first' : null });
    return;
  }
  // Hovering opened it before the click landed: the click keeps it open rather than undoing that.
  if (_via === 'hover') {
    openCreateFlyout({ via: keyboard ? 'keyboard' : 'click', focus: keyboard ? 'first' : null });
    return;
  }
  closeCreateFlyout();
}

function onTriggerKeydown(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  // The menu opens to the right of the item, so Right opens it as it would a submenu; Down and
  // Up are the menu-button keys.
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault();
    openCreateFlyout({ via: 'keyboard', focus: 'first' });
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    openCreateFlyout({ via: 'keyboard', focus: 'last' });
  }
}

function onTriggerEnter(event) {
  cancelClose();
  // A card dragged across the item opens nothing.
  if (event.buttons || isCreateFlyoutOpen() || _openTimer) return;
  _openTimer = setTimeout(() => {
    _openTimer = null;
    openCreateFlyout({ via: 'hover' });
  }, HOVER_OPEN_MS);
}

function scheduleHoverClose() {
  if (!isCreateFlyoutOpen() || _via !== 'hover' || _closeTimer) return;
  _closeTimer = setTimeout(() => {
    _closeTimer = null;
    if (_via === 'hover') closeCreateFlyout();
  }, HOVER_CLOSE_MS);
}

function onTriggerLeave() {
  cancelOpen();
  scheduleHoverClose();
}

// ── The menu ──

function onMenuClick(event) {
  const item = event.target instanceof Element ? event.target.closest('.create-flyout-item') : null;
  if (!item) return;
  const mode = item.dataset.mode;
  // Focus goes back to the Create item first: the Create modal takes it from there, and returns
  // it there when it closes.
  closeCreateFlyout();
  _onSelect?.(mode);
}

function onMenuKeydown(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const index = items().indexOf(document.activeElement);
  switch (event.key) {
    case 'ArrowDown': focusItem(index + 1); break;
    case 'ArrowUp': focusItem(index < 0 ? -1 : index - 1); break;
    case 'Home': case 'PageUp': focusItem(0); break;
    case 'End': case 'PageDown': focusItem(-1); break;
    // Left goes back the way Right came in.
    case 'ArrowLeft': closeCreateFlyout(); break;
    // Tab leaves the menu: focus returns to the Create item, and the browser moves on from there.
    case 'Tab': closeCreateFlyout(); return;
    default: return;
  }
  event.preventDefault();
  event.stopPropagation();
}

// With the keyboard in the menu, the entry under the pointer takes focus too, so one entry is
// highlighted, not two.
function onMenuMouseover(event) {
  const item = event.target instanceof Element ? event.target.closest('.create-flyout-item') : null;
  const active = document.activeElement;
  if (item && active !== item && host().contains(active)) item.focus({ preventScroll: true });
}

// ── Dismissal ──

// Escape is taken here, in the window's capture phase, ahead of every other listener: the menu
// closes and nothing behind it does — not the Create modal, not a task terminal beside the rail.
// Only while the keyboard is on the Create item or in the menu; an Escape typed anywhere else
// belongs to whatever has focus, and a hover menu simply stays under the pointer.
function onWindowKeydownCapture(event) {
  if (event.key !== 'Escape' || !isCreateFlyoutOpen() || !inside(document.activeElement)) return;
  event.preventDefault();
  event.stopPropagation();
  closeCreateFlyout();
}

function onDocumentPointerdown(event) {
  if (isCreateFlyoutOpen() && !inside(event.target)) closeCreateFlyout();
}

function onDocumentFocusin(event) {
  if (!isCreateFlyoutOpen() || inside(event.target)) return;
  // A hover menu follows the pointer, not the keyboard: a chat repaint that puts focus back in
  // its composer must not take the menu from under the pointer. A dialog that opened is another
  // matter — the menu is behind it now.
  if (_via === 'hover' && !hasOpenDialog()) return;
  closeCreateFlyout();
}

// The window changed size, or the app went to the background: the menu goes, as a native one does.
function onWindowChange() {
  closeCreateFlyout();
}

function bindGlobals() {
  if (_globalsBound) return;
  _globalsBound = true;
  window.addEventListener('keydown', onWindowKeydownCapture, true);
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('blur', onWindowChange);
  document.addEventListener('pointerdown', onDocumentPointerdown, true);
  document.addEventListener('focusin', onDocumentFocusin, true);
}

function build() {
  const el = document.createElement('div');
  el.id = CREATE_FLYOUT_ID;
  el.className = 'create-flyout';
  el.hidden = true;
  // Each entry is named by its label alone; the hint — and the status, while it shows — is its
  // description.
  el.innerHTML = `<div class="create-flyout-menu" id="${CREATE_FLYOUT_MENU_ID}" role="menu" aria-orientation="vertical">${
    CREATE_MODES.map(({ mode, icon }) => `<button type="button" class="create-flyout-item" role="menuitem" tabindex="-1" data-mode="${mode}" aria-labelledby="create-flyout-${mode}-label" aria-describedby="create-flyout-${mode}-hint">`
      + `<span class="create-flyout-icon">${icon}</span>`
      + `<span class="create-flyout-label" id="create-flyout-${mode}-label"></span>`
      + `<span class="create-flyout-status" id="create-flyout-${mode}-status" hidden><span class="create-flyout-status-mark" aria-hidden="true"></span><span class="create-flyout-status-text"></span></span>`
      + `<span class="create-flyout-hint" id="create-flyout-${mode}-hint"></span>`
      + `</button>`).join('')
  }</div>`;
  el.addEventListener('click', onMenuClick);
  el.addEventListener('keydown', onMenuKeydown);
  el.addEventListener('mouseover', onMenuMouseover);
  el.addEventListener('mouseenter', cancelClose);
  el.addEventListener('mouseleave', scheduleHoverClose);
  document.body.appendChild(el);
  return el;
}

/**
 * Turns `trigger` — the left menu's Create item — into the menu's button and builds the menu.
 * `onSelect(mode)` runs for a pick, with 'objective' or 'new_task'. Safe to call again: the menu
 * is built once, and a new trigger replaces the old one.
 */
export function mountCreateFlyout({ trigger, onSelect } = {}) {
  if (!trigger) return null;
  _onSelect = typeof onSelect === 'function' ? onSelect : null;
  const el = host() || build();
  if (_trigger !== trigger) {
    closeCreateFlyout();
    _trigger = trigger;
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-controls', CREATE_FLYOUT_MENU_ID);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', onTriggerClick);
    trigger.addEventListener('keydown', onTriggerKeydown);
    trigger.addEventListener('mouseenter', onTriggerEnter);
    trigger.addEventListener('mouseleave', onTriggerLeave);
  }
  bindGlobals();
  syncCreateFlyout();
  return el;
}
