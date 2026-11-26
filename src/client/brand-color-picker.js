// (TPT9422) The Brand colors field of the project identity form (project-profile.js
// renderProfile()): the ordered 0–3 `brand_colors` list the window paints as its accent colors
// (brand-accents.js). No color is the default and reads as a highlighted "Not selected" chip
// around an empty, struck-through well, so the theme's own accent never passes for a chosen brand
// color. "Add color" appends a swatch (a visible, removable choice) and opens its native picker;
// each swatch has its own remove button. The first color is labelled Primary, the others
// Secondary — the order the window uses them in. The wells are the identity form's .project-swatch.
//
// Editing a swatch updates it in place: the native color panel stays bound to its <input> while
// the user drags. Only adding or removing a color re-renders the list.
import { t } from './i18n.js';
import { MAX_BRAND_COLORS, normalizeBrandColors } from '../brand-colors.mjs';

const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const PLUS_ICON = '<svg class="brand-colors-add-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2.25" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const REMOVE_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" '
  + 'stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

// Where a first color starts: the window's accent, else TipATask teal.
const FIRST_COLOR = '#0E8377';

function hexToHsl(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map(pair => parseInt(pair, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// The color a new swatch starts with. The first takes the window's current accent; later ones
// take split-complementary hues of the first, so three quick Adds already read as a palette.
export function suggestBrandColor(colors, accent = FIRST_COLOR) {
  const list = normalizeBrandColors(colors);
  if (!list.length) return normalizeBrandColors([accent])[0] || FIRST_COLOR;
  const [h, s, l] = hexToHsl(list[0]);
  for (const turn of [150, 210, 60, 300, 180]) {
    const next = hslToHex((h + turn) % 360, Math.max(s, 0.45), Math.min(Math.max(l, 0.35), 0.6));
    if (!list.includes(next)) return next;
  }
  return FIRST_COLOR;
}

function windowAccent() {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--c-primary').trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : FIRST_COLOR;
  } catch { return FIRST_COLOR; }
}

const roleText = index => t(index === 0 ? 'profile.colorPrimary' : 'profile.colorSecondary');

// Mount the field into `host`. `labelledBy` names the field's label element. `onChange(list)`
// runs after every add, edit and removal with the new list. Returns { colors(), set(list) }.
export function mountBrandColorPicker(host, { colors = [], labelledBy = '', describedBy = '', onChange = () => {} } = {}) {
  let list = normalizeBrandColors(colors);
  host.classList.add('brand-colors');
  host.setAttribute('role', 'group');
  if (labelledBy) host.setAttribute('aria-labelledby', labelledBy);
  if (describedBy) host.setAttribute('aria-describedby', describedBy);
  host.innerHTML = '<div class="brand-colors-items" data-brand-colors-items></div>'
    + '<span class="brand-colors-live" aria-live="polite" data-brand-colors-live></span>';
  const items = host.querySelector('[data-brand-colors-items]');
  const live = host.querySelector('[data-brand-colors-live]');

  const announce = text => {
    live.textContent = '';
    // A changed text node is what screen readers announce; set it on the next frame.
    setTimeout(() => { if (live.isConnected) live.textContent = text; }, 30);
  };

  function itemMarkup(hex, index) {
    const n = index + 1;
    return `<span class="brand-color${index === 0 ? ' brand-color--primary' : ''}" data-brand-color="${index}">`
      + `<span class="project-swatch brand-color-swatch" style="--swatch:${esc(hex)}">`
      + `<input type="color" value="${esc(hex.toLowerCase())}" data-brand-color-input="${index}" `
      + `aria-label="${esc(t('profile.colorInput', { n, role: roleText(index), hex }))}"></span>`
      + '<span class="brand-color-meta">'
      + `<span class="brand-color-role">${esc(roleText(index))}</span>`
      + `<span class="project-swatch-value brand-color-hex" data-brand-color-hex>${esc(hex)}</span></span>`
      + `<button type="button" class="brand-color-remove" data-brand-color-remove="${index}" `
      + `aria-label="${esc(t('profile.removeColor', { n, hex }))}" title="${esc(t('profile.removeColor', { n, hex }))}">${REMOVE_ICON}</button>`
      + '</span>';
  }

  function render() {
    const none = list.length ? '' : '<span class="brand-colors-none" data-brand-colors-none>'
      + '<span class="project-swatch is-unset" aria-hidden="true"></span>'
      + `<span class="brand-colors-none-text">${esc(t('profile.colorNotSelected'))}</span></span>`;
    const add = list.length < MAX_BRAND_COLORS
      ? `<button type="button" class="brand-colors-add" data-brand-colors-add>${PLUS_ICON}<span>${esc(t('profile.addColor'))}</span></button>`
      : `<span class="brand-colors-full" data-brand-colors-full>${esc(t('profile.colorsFull'))}</span>`;
    items.innerHTML = none + list.map(itemMarkup).join('') + add;
  }

  function commit() {
    onChange([...list]);
  }

  items.addEventListener('click', event => {
    const add = event.target.closest('[data-brand-colors-add]');
    if (add) {
      if (list.length >= MAX_BRAND_COLORS) return;
      const hex = suggestBrandColor(list, windowAccent());
      list = [...list, hex];
      render();
      commit();
      announce(t('profile.colorAdded', { hex }));
      const input = items.querySelector(`[data-brand-color-input="${list.length - 1}"]`);
      input?.focus();
      // Open the new swatch's picker straight away; dismissing it keeps the suggested color.
      try { input?.click(); } catch { /* no picker in this environment */ }
      return;
    }
    const remove = event.target.closest('[data-brand-color-remove]');
    if (remove) {
      const index = Number(remove.dataset.brandColorRemove);
      const [hex] = list.splice(index, 1);
      list = [...list];
      render();
      commit();
      announce(t('profile.colorRemoved', { hex }));
      // Keep keyboard focus in the field: the next swatch's remove, the previous one's, or Add.
      const next = items.querySelector(`[data-brand-color-remove="${Math.min(index, list.length - 1)}"]`)
        || items.querySelector('[data-brand-colors-add]');
      next?.focus();
    }
  });

  items.addEventListener('input', event => {
    const input = event.target.closest('[data-brand-color-input]');
    if (!input) return;
    const index = Number(input.dataset.brandColorInput);
    const hex = String(input.value || '').toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(hex) || list[index] === undefined) return;
    if (list.some((color, i) => i !== index && color === hex)) return; // the other swatch already has it
    list = list.map((color, i) => (i === index ? hex : color));
    const item = input.closest('[data-brand-color]');
    item.querySelector('.brand-color-swatch').style.setProperty('--swatch', hex);
    item.querySelector('[data-brand-color-hex]').textContent = hex;
    input.setAttribute('aria-label', t('profile.colorInput', { n: index + 1, role: roleText(index), hex }));
    const remove = item.querySelector('[data-brand-color-remove]');
    remove.setAttribute('aria-label', t('profile.removeColor', { n: index + 1, hex }));
    remove.title = t('profile.removeColor', { n: index + 1, hex });
    commit();
  });

  // The panel closed on a color another swatch already has: show this swatch's kept color.
  items.addEventListener('change', event => {
    const input = event.target.closest('[data-brand-color-input]');
    const kept = input && list[Number(input.dataset.brandColorInput)];
    if (kept && input.value.toUpperCase() !== kept) input.value = kept.toLowerCase();
  });

  render();
  return {
    colors: () => [...list],
    set(next) { list = normalizeBrandColors(next); render(); },
  };
}
