// Focus and background isolation for body-level modal layers. A dialog may own
// portaled menus; those remain in its tab sequence while the rest of the page is inert.
const layers = [];
const priorInert = new Map();
let observer = null;

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

function top() { return layers[layers.length - 1]; }

function portalsFor(layer) {
  return layer.portals ? [...document.body.querySelectorAll(layer.portals)]
    .filter(el => !layer.root.contains(el) && el.isConnected) : [];
}

function inside(layer, el) {
  return !!el && (layer.root.contains(el) || portalsFor(layer).some(portal => portal.contains(el)));
}

function focusables(layer) {
  return [layer.root, ...portalsFor(layer)].flatMap(root => [...root.querySelectorAll(FOCUSABLE)])
    .filter(el => el.tabIndex >= 0 && !el.disabled && !el.closest('[hidden]')
      && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
}

function focusFirst(layer) {
  const preferred = typeof layer.initialFocus === 'function'
    ? layer.initialFocus() : (layer.initialFocus ? layer.root.querySelector(layer.initialFocus) : null);
  const target = preferred?.isConnected && !preferred.disabled && preferred.getClientRects().length
    ? preferred : (focusables(layer)[0] || layer.root);
  if (target === layer.root && !target.hasAttribute('tabindex')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

function syncInert() {
  const active = top();
  const allowed = active ? [active.root, ...portalsFor(active)] : [];
  for (const child of document.body.children) {
    if (!priorInert.has(child)) priorInert.set(child, child.inert);
    child.inert = active
      ? (priorInert.get(child) || !allowed.some(el => el === child || child.contains(el)))
      : priorInert.get(child);
  }
  if (!active) priorInert.clear();
}

function onKeydown(event) {
  if (event.key !== 'Tab' || !top()) return;
  const items = focusables(top());
  if (!items.length) {
    event.preventDefault();
    focusFirst(top());
    return;
  }
  const current = document.activeElement;
  const index = items.indexOf(current);
  if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1)) {
    event.preventDefault();
    (event.shiftKey ? items[items.length - 1] : items[0]).focus();
  }
}

function onFocusin(event) {
  if (top() && !inside(top(), event.target)) focusFirst(top());
}

export function activateDialogFocus({ root, initialFocus, returnFocus, portals } = {}) {
  if (!root?.isConnected) throw new Error('Dialog root must be connected');
  const layer = { root, initialFocus, returnFocus: returnFocus || document.activeElement, portals };
  layers.push(layer);
  if (layers.length === 1) {
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('focusin', onFocusin, true);
    observer = new MutationObserver(syncInert);
    observer.observe(document.body, { childList: true });
  }
  syncInert();
  focusFirst(layer);
  let closed = false;
  return {
    focusFirst: () => { if (top() === layer) focusFirst(layer); },
    isTop: () => top() === layer,
    close() {
      if (closed) return;
      closed = true;
      const wasTop = top() === layer;
      layers.splice(layers.indexOf(layer), 1);
      syncInert();
      if (!layers.length) {
        observer.disconnect();
        observer = null;
        document.removeEventListener('keydown', onKeydown, true);
        document.removeEventListener('focusin', onFocusin, true);
      }
      if (!wasTop) return;
      const candidate = typeof layer.returnFocus === 'function' ? layer.returnFocus() : layer.returnFocus;
      if (candidate?.isConnected && !candidate.inert && candidate.getClientRects().length) {
        candidate.focus({ preventScroll: true });
      } else if (top()) {
        focusFirst(top());
      }
    },
  };
}
