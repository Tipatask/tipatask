import { permissionModeIcon } from './permission-mode.js';

let nextId = 0;
const bindings = new WeakMap();
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
// Open-menu placement (TPT9084): the gap between trigger and menu (the inline rule's
// calc(100% + 4px)), the viewport margin kept free beyond the menu, and the least height the
// menu keeps before it scrolls inside itself.
const MENU_GAP = 4;
const MENU_EDGE = 8;
const MENU_MIN_HEIGHT = 96;

// options are the trusted rows from buildTaskModeOptions/buildProjectModeOptions.
// `name` is both the form field name and the trigger id (for an external <label for>).
export function renderPermissionModeSelect({ name, options, value, t }) {
  const id = `permission-mode-list-${++nextId}`;
  const current = options.find(row => value !== undefined ? row.value === value : row.selected) || options[0];
  const content = row => `${row.icon || permissionModeIcon(row.value)}<span class="permission-mode-select-label">${escape(row.label)}</span>`;
  return `<div class="permission-mode-select" data-permission-mode-select>
    <input type="hidden" name="${escape(name)}" value="${escape(current?.value)}">
    <button type="button" id="${escape(name)}" class="permission-mode-select-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}"${current?.hint ? ` aria-describedby="${id}-hint"` : ''}${!options.length ? ' disabled' : ''}>
      <span class="permission-mode-select-value">${current ? content(current) : escape(t('permissionMode.notSet'))}</span>
      <span class="permission-mode-select-chevron" aria-hidden="true">⌄</span>
    </button>
    <span id="${id}-hint" class="permission-mode-select-description" hidden>${escape(current?.hint)}</span>
    <div class="permission-mode-select-menu" id="${id}" role="listbox" aria-labelledby="${escape(name)}" hidden>
      ${options.map((row, index) => `<div class="permission-mode-select-option" role="option" id="${id}-${index}" tabindex="-1" data-value="${escape(row.value)}" aria-selected="${row === current}"${row.placeholder || row.disabled ? ' aria-disabled="true"' : ''}${row.hint ? ` aria-describedby="${id}-${index}-hint"` : ''}>
        <span class="permission-mode-select-value">${content(row)}</span>
        <span class="permission-mode-select-option-hint" id="${id}-${index}-hint">${escape(row.hint)}</span>
      </div>`).join('')}
    </div>
  </div>`;
}

// Bind one rendered widget (or a containing host). Returns value/disabled setters for
// autosave rollback and a destroy() hook; callers destroy before removing/replacing it.
// While open, the listbox is moved to the end of <body> (data-portaled="1", position: fixed —
// see .permission-mode-select-menu[data-portaled] in styles.css) and placed from the trigger's
// viewport rect, so a short, scrolling host such as the Task Edit modal's .modal-scroll-body
// under its pinned footer never clips it. dialog-focus.js admits that menu to the focus layer
// holding its trigger. close() and destroy() put it back and drop the window listeners.
export function bindPermissionModeSelect(host, onChange) {
  const root = host.matches('[data-permission-mode-select]') ? host : host.querySelector('[data-permission-mode-select]');
  if (!root) throw new Error('Permission mode select not found');
  bindings.get(root)?.destroy();
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const trigger = root.querySelector('.permission-mode-select-trigger');
  const menu = root.querySelector('[role="listbox"]');
  const input = root.querySelector('input');
  const description = root.querySelector('.permission-mode-select-description');
  const rows = Array.from(menu.querySelectorAll('[role="option"]'));
  const enabled = rows.filter(row => row.getAttribute('aria-disabled') !== 'true');
  let active = null;
  let destroyed = false;

  // Below the trigger, left/width from it; above it when the room below runs out and there is
  // more above. max-height is the free room in that direction, so a cramped viewport scrolls the
  // list inside the menu instead of cutting it. Re-run on capture-phase scroll and on resize.
  // A menu a stylesheet min-width makes wider than its trigger (the terminal header's compact
  // live selector, TPT9139) shifts left rather than run off the viewport's right edge.
  function place() {
    if (!trigger.isConnected || !trigger.getClientRects().length) { close(); return; }
    const rect = trigger.getBoundingClientRect();
    const below = view.innerHeight - rect.bottom - MENU_GAP - MENU_EDGE;
    const above = rect.top - MENU_GAP - MENU_EDGE;
    const need = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
    const flip = need > below && above > below;
    menu.style.width = `${rect.width}px`;
    const width = Math.max(rect.width, menu.offsetWidth);
    const overflow = rect.left + width > view.innerWidth - MENU_EDGE;
    menu.style.left = `${overflow ? Math.max(MENU_EDGE, view.innerWidth - width - MENU_EDGE) : rect.left}px`;
    menu.style.maxHeight = `${Math.max(flip ? above : below, MENU_MIN_HEIGHT)}px`;
    menu.style.top = flip ? 'auto' : `${rect.bottom + MENU_GAP}px`;
    menu.style.bottom = flip ? `${view.innerHeight - rect.top + MENU_GAP}px` : 'auto';
  }
  function portal() {
    menu.dataset.portaled = '1';
    doc.body.appendChild(menu);
    view.addEventListener('scroll', place, true);
    view.addEventListener('resize', place);
  }
  function unportal() {
    if (!menu.dataset.portaled) return;
    view.removeEventListener('scroll', place, true);
    view.removeEventListener('resize', place);
    delete menu.dataset.portaled;
    menu.removeAttribute('style');
    // dialog-focus.js stamps inert on body children: a dialog opening above the host inerts the
    // menu, then takes focus, which dismisses it. Back inside the widget it inherits the host's
    // inertness and must not keep its own, or its next open could not focus a row.
    menu.inert = false;
    if (root.isConnected) root.appendChild(menu); else menu.remove();
  }
  function close(restoreFocus = false) {
    menu.hidden = true;
    unportal();
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
    active = null;
  }
  function focusRow(row) {
    if (!row) return;
    active = row;
    row.focus();
    row.scrollIntoView?.({ block: 'nearest' });
  }
  function open(last = false) {
    if (trigger.disabled || !enabled.length) return;
    if (menu.hidden) {
      portal();
      menu.hidden = false;
      place();
    }
    trigger.setAttribute('aria-expanded', 'true');
    focusRow(enabled.find(row => row.dataset.value === input.value) || (last ? enabled.at(-1) : enabled[0]));
  }
  function setValue(value) {
    const selected = rows.find(row => row.dataset.value === value);
    if (!selected) return;
    input.value = value;
    rows.forEach(row => row.setAttribute('aria-selected', String(row === selected)));
    trigger.querySelector('.permission-mode-select-value').innerHTML = selected.querySelector('.permission-mode-select-value').innerHTML;
    description.textContent = selected.querySelector('.permission-mode-select-option-hint').textContent;
    trigger.setAttribute('aria-describedby', description.id);
  }
  function choose(row) {
    if (trigger.disabled || !enabled.includes(row)) return;
    const changed = input.value !== row.dataset.value;
    setValue(row.dataset.value);
    close(true);
    if (changed) {
      input.dispatchEvent(new view.Event('change', { bubbles: true }));
      onChange?.(input.value);
    }
  }
  // Bound on the trigger and on the menu: the open menu sits outside root, so root-level
  // delegation would miss its rows.
  function click(event) {
    if (trigger.contains(event.target)) {
      if (menu.hidden) open(); else close(true);
      return;
    }
    const row = event.target.closest('[role="option"]');
    if (row && menu.contains(row)) choose(row);
  }
  function keydown(event) {
    if (trigger.disabled) return;
    const isOpen = !menu.hidden;
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Escape') {
      if (!isOpen) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!isOpen) {
      open(event.key === 'ArrowUp' || event.key === 'End');
      if (event.key === 'Home') focusRow(enabled[0]);
      if (event.key === 'End') focusRow(enabled.at(-1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      choose(active);
    } else {
      const index = enabled.indexOf(active);
      focusRow(event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1)
        : enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]);
    }
  }
  function outside(event) { if (!root.contains(event.target) && !menu.contains(event.target)) close(); }
  trigger.addEventListener('click', click);
  menu.addEventListener('click', click);
  trigger.addEventListener('keydown', keydown);
  menu.addEventListener('keydown', keydown);
  doc.addEventListener('pointerdown', outside);
  doc.addEventListener('focusin', outside);
  const control = {
    get value() { return input.value; },
    set value(value) { setValue(value); },
    get disabled() { return trigger.disabled; },
    set disabled(value) { trigger.disabled = !!value; input.disabled = !!value; if (value) close(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      close();
      trigger.removeEventListener('click', click);
      menu.removeEventListener('click', click);
      trigger.removeEventListener('keydown', keydown);
      menu.removeEventListener('keydown', keydown);
      doc.removeEventListener('pointerdown', outside);
      doc.removeEventListener('focusin', outside);
      bindings.delete(root);
    },
  };
  bindings.set(root, control);
  return control;
}
