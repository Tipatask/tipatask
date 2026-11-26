// Preview drawer — a non-blocking side drawer docked to the right edge of a host element (the
// task / project chat panel), so several documents can stay open beside the conversation. It
// takes ready content and knows nothing about chats or fetching (tt-task-chat.md § Stacking).
//
//   const drawer = createPreviewDrawer(host, { onClose, onLayoutChange, hostClass });
//   drawer.open({ id, title, body })  → { id, panel } — a new tab, or the open tab with this id
//   drawer.close(id) / drawer.closeAll() — closing the last tab closes the drawer, then onClose()
//
// No backdrop and no focus trap: the host stays fully usable beside the drawer. While open the
// drawer is the host's last child, `hostClass` (if given) is on the host so the host's own CSS
// can make room for it, and the drawer's width is published on the host as --preview-drawer-width.
// `onLayoutChange()` runs just before the drawer docks into the host or leaves it (the host's
// layout switches); a function it returns runs right after, with the new layout in place.
// Until the user picks a width the drawer fills the host: all of it but MIN_TRANSCRIPT_WIDTH.
// The handle on its left edge resizes it; the width is clamped so the rest of the host keeps
// MIN_TRANSCRIPT_WIDTH (again after every host or window resize) and the width the user picks
// is remembered in localStorage — the widest one as "fill" again. Escape while focus is inside
// the drawer closes the focused tab from a window capture-phase listener, ahead of every
// document-level Escape handler (the chat window's, the task workspace's).
import { t, getLocale } from './i18n.js';

export const PREVIEW_DRAWER_WIDTH_KEY = 'tipatask-preview-drawer-width';
export const PREVIEW_DRAWER_WIDTH_VAR = '--preview-drawer-width';
// Shown only while the host cannot be measured yet and no width is stored; a measured host
// with no stored width gets the fill width instead (clampDrawerWidth()).
export const DEFAULT_DRAWER_WIDTH = 480;
export const MIN_DRAWER_WIDTH = 280;
// A readable chat column: the messages, the composer and its action row still fit beside it.
// Also the chat column's width while the drawer fills the host.
export const MIN_TRANSCRIPT_WIDTH = 360;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

const ICON_CLOSE_TAB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M7 7l10 10M17 7 7 17"/></svg>';
// A panel with its right side folding away: closes the whole drawer, unlike the host's own ✕.
const ICON_CLOSE_DRAWER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/></svg>';

let drawerSeq = 0;

// The drawer width shown for a wanted `width` in a host `available` px wide: never under
// MIN_DRAWER_WIDTH, never so wide that the rest of the host drops under MIN_TRANSCRIPT_WIDTH.
// No wanted width (null: nothing stored) fills the host — everything but MIN_TRANSCRIPT_WIDTH,
// so the chat beside it is a slim column and the document gets the rest. An unmeasured host
// (0, hidden or not laid out) only applies the drawer's own minimum, and shows
// DEFAULT_DRAWER_WIDTH when nothing is wanted. When the host is too narrow for both minimums the
// drawer keeps its own (at ≤ 640 px it covers the host).
export function clampDrawerWidth(width, available) {
  const max = maxDrawerWidth(available);
  const want = Number.isFinite(width) ? width : (Number.isFinite(max) ? max : DEFAULT_DRAWER_WIDTH);
  return Math.round(Math.min(Math.max(want, MIN_DRAWER_WIDTH), max));
}

function maxDrawerWidth(available) {
  return Number.isFinite(available) && available > 0
    ? Math.max(MIN_DRAWER_WIDTH, available - MIN_TRANSCRIPT_WIDTH)
    : Infinity;
}

// The width the user last picked, or null when there is none: the drawer fills its host.
// Storage can be blocked: never throws.
export function readStoredDrawerWidth() {
  let raw = null;
  try { raw = localStorage.getItem(PREVIEW_DRAWER_WIDTH_KEY); } catch { /* storage unavailable */ }
  const n = Number(raw);
  return raw !== null && raw !== '' && Number.isFinite(n) && n > 0
    ? Math.max(MIN_DRAWER_WIDTH, Math.round(n))
    : null;
}

// Stores a picked width; null forgets it, so drawers fill their host again.
function storeDrawerWidth(px) {
  try {
    if (px === null) localStorage.removeItem(PREVIEW_DRAWER_WIDTH_KEY);
    else localStorage.setItem(PREVIEW_DRAWER_WIDTH_KEY, String(px));
  } catch { /* storage unavailable */ }
}

function nameControl(el, text) {
  el.title = text;
  el.setAttribute('aria-label', text);
}

export function createPreviewDrawer(host, { onClose, onSelect, onLayoutChange, hostClass = '' } = {}) {
  if (!host || typeof host.appendChild !== 'function') throw new Error('createPreviewDrawer needs a host element');
  const seq = ++drawerSeq;
  const hostClasses = String(hostClass || '').split(/\s+/).filter(Boolean);
  const items = new Map();    // id -> { id, title, tab, btn, text, closeBtn, panel, scrollTop }, in tab order
  let activeId = null;
  let root = null;            // aside.preview-drawer, built on the first open, detached while closed
  let tablist = null;
  let panels = null;
  let handle = null;          // the resize separator
  let closeBtn = null;
  let preferred = readStoredDrawerWidth(); // the width the user picked (null: fill the host); the shown one may be clamped
  let applied = clampDrawerWidth(preferred, 0);
  let available = 0;          // host width at the last clamp (0 = unmeasured)
  let opener = null;          // where focus goes back to when the drawer closes with focus inside it
  let labelledLocale = '';
  let frame = 0;
  let observer = null;
  let drag = null;            // { pointerId, startX, startWidth, startPreferred } while resizing
  let tabSeq = 0;
  let destroyed = false;

  const isOpen = () => items.size > 0;

  function build() {
    root = document.createElement('aside');
    root.className = 'preview-drawer';
    root.id = `preview-drawer-${seq}`;
    root.innerHTML = `
      <div class="preview-drawer-resize" role="separator" aria-orientation="vertical" tabindex="0"
        aria-controls="${root.id}-panels"></div>
      <div class="preview-drawer-header">
        <div class="preview-drawer-tabs" role="tablist" aria-orientation="horizontal"></div>
        <button type="button" class="preview-drawer-close">${ICON_CLOSE_DRAWER}</button>
      </div>
      <div class="preview-drawer-panels" id="${root.id}-panels"></div>`;
    handle = root.querySelector('.preview-drawer-resize');
    tablist = root.querySelector('.preview-drawer-tabs');
    panels = root.querySelector('.preview-drawer-panels');
    closeBtn = root.querySelector('.preview-drawer-close');
    closeBtn.addEventListener('click', () => closeAll());
    tablist.addEventListener('keydown', onTabKeydown);
    handle.addEventListener('keydown', onHandleKeydown);
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pointerId) stopDrag(true); });
    handle.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pointerId) stopDrag(false); });
    handle.addEventListener('lostpointercapture', (e) => { if (drag && e.pointerId === drag.pointerId) stopDrag(true); });
  }

  // Labels are looked up when drawn and again when the project language changes under an open
  // drawer (Settings dispatches tiptask:reload after setLocale).
  function relabel() {
    labelledLocale = getLocale();
    if (!root) return;
    nameControl(closeBtn, t('previewDrawer.close'));
    nameControl(handle, t('previewDrawer.resize'));
    for (const item of items.values()) nameControl(item.closeBtn, t('previewDrawer.closeTab', { title: item.title }));
  }

  function onReload() {
    if (getLocale() !== labelledLocale) relabel();
  }

  // ── Open / close ──

  // The host's layout switches when the drawer docks into it or leaves it (`hostClass` comes or
  // goes): onLayoutChange() runs before, and the function it returns after, so the host can keep
  // what it shows across the switch — the chat its transcript position. A failing callback never
  // stops the drawer opening or closing.
  function beforeLayoutChange() {
    if (typeof onLayoutChange !== 'function') return null;
    try {
      const after = onLayoutChange();
      return typeof after === 'function' ? after : null;
    } catch (err) {
      console.error('[preview-drawer] onLayoutChange failed:', err);
      return null;
    }
  }

  function afterLayoutChange(after) {
    if (!after) return;
    try { after(); } catch (err) { console.error('[preview-drawer] onLayoutChange failed:', err); }
  }

  function attach() {
    if (!root) build();
    if (labelledLocale !== getLocale()) relabel();
    const after = beforeLayoutChange();
    host.appendChild(root);
    if (hostClasses.length) host.classList.add(...hostClasses);
    applyWidth();
    afterLayoutChange(after);
    window.addEventListener('keydown', onWindowKeydown, true);
    window.addEventListener('resize', scheduleClamp);
    document.addEventListener('tiptask:reload', onReload);
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(scheduleClamp);
      observer.observe(host);
    }
  }

  function open({ id, title = '', body } = {}, { focus = true } = {}) {
    if (destroyed || id === undefined || id === null || String(id) === '') return null;
    const key = String(id);
    if (!isOpen()) attach();
    // Focus goes back to the control that opened the latest item (a link in the transcript).
    const current = document.activeElement;
    if (current && current !== document.body && !root.contains(current)) opener = current;
    const text = String(title || '').trim();
    let item = items.get(key);
    if (!item) item = addItem(key, text || key);
    else if (text && text !== item.title) setTitle(item, text);
    if (body !== undefined) setBody(item, body);
    select(key, { focus });
    return { id: key, panel: item.panel, signal: item.lifetime.signal };
  }

  function addItem(id, title) {
    const n = ++tabSeq;
    const tabId = `${root.id}-tab-${n}`;
    const panelId = `${root.id}-panel-${n}`;
    // The wrapper carries no role, so the tablist's children are its tabs; each tab's close
    // button sits beside it, reachable by Tab from the selected tab.
    const tab = document.createElement('div');
    tab.className = 'preview-drawer-tab';
    tab.setAttribute('role', 'presentation');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preview-drawer-tab-btn';
    btn.id = tabId;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('aria-controls', panelId);
    btn.tabIndex = -1;
    // The title runs inside a <bdi> so styles.css can keep a long title's end in view (a file
    // name rather than the folders before it) whatever characters it starts or ends with.
    const label = document.createElement('span');
    label.className = 'preview-drawer-tab-title';
    const text = document.createElement('bdi');
    label.appendChild(text);
    btn.appendChild(label);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'preview-drawer-tab-close';
    x.tabIndex = -1;
    x.innerHTML = ICON_CLOSE_TAB;
    tab.append(btn, x);
    const panel = document.createElement('div');
    panel.className = 'preview-drawer-panel';
    panel.id = panelId;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tabId);
    panel.tabIndex = 0; // scrollable by keyboard whatever its content
    panel.hidden = true;
    const item = { id, title, tab, btn, text, closeBtn: x, panel, scrollTop: 0, lifetime: new AbortController() };
    btn.addEventListener('click', () => select(id, { focus: true }));
    x.addEventListener('click', (e) => { e.stopPropagation(); closeItem(id); });
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeItem(id); } });
    tablist.appendChild(tab);
    panels.appendChild(panel);
    items.set(id, item);
    setTitle(item, title);
    return item;
  }

  function setTitle(item, title) {
    item.title = title;
    item.text.textContent = title;
    item.btn.title = title;
    nameControl(item.closeBtn, t('previewDrawer.closeTab', { title }));
  }

  // `body` is ready content: a DOM node is placed as is; anything else is shown as plain text
  // (never parsed as HTML). New content starts at its top.
  function setBody(item, body) {
    if (body === null) item.panel.replaceChildren();
    else if (typeof Node === 'function' && body instanceof Node) item.panel.replaceChildren(body);
    else item.panel.textContent = String(body);
    item.scrollTop = 0;
    item.panel.scrollTop = 0;
  }

  function select(id, { focus = false } = {}) {
    const next = items.get(id);
    if (!next) return;
    if (activeId !== id) {
      const prev = items.get(activeId);
      if (prev) {
        prev.scrollTop = prev.panel.scrollTop; // each tab keeps its own scroll position
        prev.panel.hidden = true;
        markSelected(prev, false);
      }
      next.panel.hidden = false;
      next.panel.scrollTop = next.scrollTop;
      markSelected(next, true);
      activeId = id;
      root.setAttribute('aria-labelledby', next.btn.id);
      onSelect?.(next.panel);
    }
    revealTab(next);
    if (focus) next.btn.focus({ preventScroll: true });
  }

  function markSelected(item, on) {
    item.tab.classList.toggle('preview-drawer-tab--active', on);
    item.btn.setAttribute('aria-selected', on ? 'true' : 'false');
    item.btn.tabIndex = on ? 0 : -1;
    item.closeBtn.tabIndex = on ? 0 : -1;
  }

  // Scrolls the tab strip (not the page or the host) so the tab is fully visible.
  function revealTab(item) {
    const left = item.tab.offsetLeft;
    const right = left + item.tab.offsetWidth;
    if (left < tablist.scrollLeft) tablist.scrollLeft = left;
    else if (right > tablist.scrollLeft + tablist.clientWidth) tablist.scrollLeft = right - tablist.clientWidth;
  }

  function itemContaining(el) {
    for (const item of items.values()) {
      if (item.tab.contains(el) || item.panel.contains(el)) return item;
    }
    return null;
  }

  function focusInside() {
    return !!root && root.contains(document.activeElement);
  }

  function closeItem(id) {
    const key = String(id);
    const item = items.get(key);
    if (!item) return false;
    const hadFocus = focusInside();
    const order = [...items.keys()];
    const at = order.indexOf(key);
    item.lifetime.abort();
    items.delete(key);
    item.tab.remove();
    item.panel.remove();
    if (!items.size) {
      teardown({ hadFocus, notify: true });
      return true;
    }
    if (activeId === key) {
      activeId = null;
      select(order[at + 1] ?? order[at - 1], { focus: hadFocus });
    } else if (hadFocus && !focusInside()) {
      items.get(activeId)?.btn.focus({ preventScroll: true }); // a removed close button held it
    }
    return true;
  }

  function closeAll() {
    if (!isOpen()) return false;
    teardown({ hadFocus: focusInside(), notify: true });
    return true;
  }

  // `relayout: false` when the host itself is going away (destroy()): nothing left to keep.
  function teardown({ hadFocus = false, notify = true, relayout = true } = {}) {
    stopDrag(false);
    cancelAnimationFrame(frame);
    frame = 0;
    window.removeEventListener('keydown', onWindowKeydown, true);
    window.removeEventListener('resize', scheduleClamp);
    document.removeEventListener('tiptask:reload', onReload);
    if (observer) { observer.disconnect(); observer = null; }
    const after = relayout && host.isConnected ? beforeLayoutChange() : null;
    for (const item of items.values()) { item.lifetime.abort(); item.tab.remove(); item.panel.remove(); }
    items.clear();
    activeId = null;
    if (root) {
      root.removeAttribute('aria-labelledby');
      root.remove();
    }
    if (hostClasses.length) host.classList.remove(...hostClasses);
    host.style.removeProperty(PREVIEW_DRAWER_WIDTH_VAR);
    afterLayoutChange(after);
    const back = opener;
    opener = null;
    if (hadFocus && back && back.isConnected && !back.closest('[hidden], [inert]')) back.focus({ preventScroll: true });
    if (notify && typeof onClose === 'function') onClose();
  }

  function destroy() {
    if (destroyed) return;
    if (isOpen()) teardown({ hadFocus: focusInside(), notify: true, relayout: false });
    destroyed = true;
    root = null;
  }

  // ── Keyboard ──

  // Window capture phase: runs before any document-level listener, so an Escape meant for the
  // drawer never reaches the chat window's or the task workspace's own Escape handler.
  function onWindowKeydown(e) {
    if (e.key !== 'Escape' || e.isComposing) return;
    if (!host.isConnected) { teardown({ notify: false }); return; } // the host went away under us
    if (drag) {
      e.preventDefault();
      e.stopPropagation();
      stopDrag(false); // Escape cancels a resize in progress
      return;
    }
    if (!focusInside()) return;
    const item = itemContaining(document.activeElement) || items.get(activeId);
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    closeItem(item.id);
  }

  // Tabs pattern: arrows / Home / End move and select, Delete closes the focused tab.
  function onTabKeydown(e) {
    const item = itemContaining(e.target);
    if (!item || e.target !== item.btn) return;
    if (e.key === 'Delete') {
      e.preventDefault();
      closeItem(item.id);
      return;
    }
    const order = [...items.keys()];
    const at = order.indexOf(item.id);
    const next = {
      ArrowRight: order[(at + 1) % order.length],
      ArrowLeft: order[(at - 1 + order.length) % order.length],
      Home: order[0],
      End: order[order.length - 1],
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(next, { focus: true });
  }

  // Window splitter pattern: the value is the drawer's width; moving the handle left widens it.
  function onHandleKeydown(e) {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const next = {
      ArrowLeft: applied + step,
      ArrowRight: applied - step,
      Home: MIN_DRAWER_WIDTH,
      End: maxDrawerWidth(measureHost()),
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setWidth(Number.isFinite(next) ? next : applied, { remember: true });
  }

  // ── Width ──

  function measureHost() {
    return host.clientWidth || 0;
  }

  // Shows the preferred width, clamped to the host as it is now — or, with none picked, the fill
  // width for the host as it is now. Never stores anything: a narrow window shrinks the drawer
  // for now, and a wider one gives the remembered width back.
  function applyWidth() {
    if (!root || !root.isConnected) return;
    available = measureHost();
    applied = clampDrawerWidth(preferred, available);
    host.style.setProperty(PREVIEW_DRAWER_WIDTH_VAR, `${applied}px`);
    const max = available > 0 ? maxDrawerWidth(available) : applied; // unmeasured: no known room
    handle.setAttribute('aria-valuemin', String(MIN_DRAWER_WIDTH));
    handle.setAttribute('aria-valuemax', String(Math.max(applied, max)));
    handle.setAttribute('aria-valuenow', String(applied));
  }

  // A width the user picked (drag or keys): what is shown after clamping is what is remembered.
  function setWidth(px, { remember }) {
    preferred = Math.max(MIN_DRAWER_WIDTH, Math.round(px));
    applyWidth();
    preferred = applied;
    if (remember) rememberWidth();
  }

  // The widest width the host allows — the chat at its minimum — is remembered as "fill", so a
  // window that grows later still gives the document all the room. (A host too narrow for both
  // minimums has no such choice: its one width is stored as it is.)
  function rememberWidth() {
    const widest = available > 0 && applied > MIN_DRAWER_WIDTH && applied >= maxDrawerWidth(available);
    preferred = widest ? null : applied;
    storeDrawerWidth(preferred);
  }

  function scheduleClamp() {
    if (frame || !isOpen()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!isOpen()) return;
      if (!host.isConnected) { teardown({ notify: false }); return; }
      applyWidth();
    });
  }

  function onPointerDown(e) {
    if (e.button !== 0 || e.isPrimary === false || !isOpen()) return;
    e.preventDefault();
    drag = { pointerId: e.pointerId, startX: e.clientX, startWidth: applied, startPreferred: preferred };
    try { handle.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }
    root.classList.add('preview-drawer--resizing');
    document.body.classList.add('preview-drawer-resizing');
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    setWidth(drag.startWidth + (drag.startX - e.clientX), { remember: false });
  }

  function stopDrag(commit) {
    if (!drag) return;
    const ended = drag;
    drag = null;
    try { handle.releasePointerCapture?.(ended.pointerId); } catch { /* already released */ }
    root?.classList.remove('preview-drawer--resizing');
    document.body.classList.remove('preview-drawer-resizing');
    if (commit) {
      rememberWidth();
    } else {
      preferred = ended.startPreferred;
      applyWidth();
    }
  }

  return {
    open,
    close: closeItem,
    closeAll,
    destroy,
    relabel,
    has: (id) => items.has(String(id)),
    ids: () => [...items.keys()],
    activeId: () => activeId,
    isOpen,
    get element() { return root; },
  };
}
