// (TPT9422) Project brand colors as the window's accent colors.
//
// A project's identity holds 0–3 brand colors (`identity.brand_colors`, ../brand-colors.mjs).
// With none, the window keeps its palette's accents. With some, this module derives the accent
// custom properties from them and sets them inline on <html>, where the palette formulas in
// styles.css (:root, .theme-dark) read them:
//
//   first color          -> the primary accent family: --c-primary, --c-primary-hover,
//                           --c-on-primary, the --c-primary-light / -lighter tints,
//                           --c-primary-text (accent text), --c-primary-border (focus rings,
//                           selected edges) and the left nav's --left-nav-active-bg / -fg;
//   second, third colors -> the secondary accents --c-accent-2 / --c-accent-3 and their non-text
//                           variants --c-accent-2-border / --c-accent-3-border. Unset ones fall
//                           back in styles.css :root (accent-3 -> accent-2 -> primary).
//
// Every derived token is checked against the painted palette's own grounds — the grounds
// theme-default.test.js checks the palettes on — so an arbitrary brand color never takes accent
// text under 4.5:1, a focus ring under 3:1, or button text under 4.5:1. A color that passes is
// used as is; one that does not is mixed toward the palette's text color only as far as needed.
// The button fill keeps white text with up to 20% shade, else takes dark text on the exact color.
//
// Tokens depend on the palette, so a theme change repaints them (task-board.js
// applyThemeClass() -> paintBrandAccents()). The tokens last painted for a project are kept in
// localStorage under brandAccentStorageKey(); template.html's second pre-paint script applies
// them before the first frame while the cached palette matches the one being painted.

import { MAX_BRAND_COLORS, normalizeBrandColors } from '../brand-colors.mjs';

export { MAX_BRAND_COLORS, normalizeBrandColors };

export const BRAND_ACCENT_STORAGE_KEY = 'tiptask-brand-accents';

// Every property this module may set on <html>. Clearing them restores the palette's accents.
export const BRAND_ACCENT_PROPS = Object.freeze([
  '--c-primary', '--c-primary-hover', '--c-on-primary', '--c-primary-light', '--c-primary-lighter',
  '--c-primary-text', '--c-primary-border', '--left-nav-active-bg', '--left-nav-active-fg',
  '--c-accent-2', '--c-accent-2-border', '--c-accent-3', '--c-accent-3-border',
]);

const MIN_TEXT = 4.5;
const MIN_UI = 3;
const MAX_SHADE = 0.2;
const WHITE = Object.freeze({ r: 255, g: 255, b: 255, a: 1 });
const BLACK = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });

// The default light and dark palettes' grounds (paper / ink), for a root whose computed palette
// cannot be read.
const FALLBACK_PALETTES = {
  light: { text: '#1a1a19', card: '#fbf9f3', bg: '#f4f1ea', subNav: '#ece8de', navBg: '#f8f6f0', tier: '#ded8c9' },
  dark: { text: '#f4f1ea', card: '#2a2a28', bg: '#1a1a19', subNav: '#141413', navBg: '#141413', tier: '#0f0f0e' },
};
const PALETTE_PROPS = { text: '--c-text', card: '--c-bg-card', bg: '--c-bg', subNav: '--c-bg-sub-nav', navBg: '--c-nav-bg', tier: '--c-bg-tier' };

// ── Color math (sRGB, as CSS color-mix(in srgb) and alpha compositing compute it) ──────────

const clampByte = value => Math.min(255, Math.max(0, Math.round(value)));

// A CSS color in hex (#rgb, #rgba, #rrggbb, #rrggbbaa) or rgb()/rgba() -> { r, g, b, a }; else null.
export function parseColor(text) {
  const value = String(text ?? '').trim().toLowerCase();
  const hexMatch = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hexMatch) {
    let digits = hexMatch[1];
    if (digits.length <= 4) digits = [...digits].map(d => d + d).join('');
    const bytes = digits.match(/../g).map(pair => parseInt(pair, 16));
    return { r: bytes[0], g: bytes[1], b: bytes[2], a: bytes.length === 4 ? bytes[3] / 255 : 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/.exec(value);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : Number(fn[4]) / (fn[5] ? 100 : 1);
    return { r: clampByte(Number(fn[1])), g: clampByte(Number(fn[2])), b: clampByte(Number(fn[3])), a: Math.min(1, Math.max(0, alpha)) };
  }
  return null;
}

function channel(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance({ r, g, b }) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Euclidean distance in OKLab: how far apart two colors look, hue and chroma included (a
// saturated yellow stands out on cream at a luminance contrast of only 1.45:1; white does not).
function oklab({ r, g, b }) {
  const [lr, lg, lb] = [r, g, b].map(channel);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function colorDistance(a, b) {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// color-mix(in srgb, a share, b): rounded to the bytes a browser paints.
export function mix(a, b, share) {
  return { r: clampByte(a.r * share + b.r * (1 - share)), g: clampByte(a.g * share + b.g * (1 - share)),
    b: clampByte(a.b * share + b.b * (1 - share)), a: 1 };
}

export const toHex = ({ r, g, b }) => '#' + [r, g, b].map(v => clampByte(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const toRgba = ({ r, g, b }, alpha) => `rgba(${clampByte(r)},${clampByte(g)},${clampByte(b)},${alpha})`;

// The largest share of `color` mixed toward `toward` (1 -> 0 in 2% steps) that passes `ok`.
// `toward` is the palette's text color or black/white, which passes every check used here.
function strongestMix(color, toward, ok) {
  for (let step = 50; step >= 0; step--) {
    const candidate = mix(color, toward, step / 50);
    if (ok(candidate)) return candidate;
  }
  return mix(toward, toward, 1);
}

const clears = (grounds, min) => color => grounds.every(ground => contrastRatio(color, ground) >= min);

// A fill or tint must stand apart from the surfaces it sits on: white on paper or navy on ink
// would read as no accent at all.
const MIN_SEPARATION = 0.1;
const separated = palette => color => [palette.card, palette.bg, palette.navBg, palette.subNav]
  .every(ground => colorDistance(color, ground) >= MIN_SEPARATION);

// The brand color moved off the surfaces as little as needed: darker on a light palette, lighter
// on a dark one.
function offSurface(color, palette) {
  return strongestMix(color, palette.dark ? WHITE : BLACK, separated(palette));
}

// The button fill and its foreground. White text is the app's convention and survives up to
// 20% shade of the (surface-separated) brand color; a lighter color keeps its fill under dark
// text — a near-black of its own hue, else black. Either white or black clears 4.5:1 on any color.
function primaryFill(color, palette) {
  const base = offSurface(color, palette);
  const apart = separated(palette);
  for (let step = 0; step <= MAX_SHADE * 50; step++) {
    const fill = mix(BLACK, base, step / 50);
    if (contrastRatio(WHITE, fill) >= MIN_TEXT && (step === 0 || apart(fill))) return { fill, on: WHITE };
  }
  const ink = mix(BLACK, base, 0.85);
  if (contrastRatio(ink, base) >= MIN_TEXT) return { fill: base, on: ink };
  if (contrastRatio(BLACK, base) >= MIN_TEXT) return { fill: base, on: BLACK };
  return { fill: strongestMix(base, BLACK, fill => contrastRatio(WHITE, fill) >= MIN_TEXT), on: WHITE };
}

// Hover darkens the fill like every palette's --c-primary-hover; a fill that cannot get darker,
// or whose dark text would drop under 4.5:1, lightens instead.
function hoverFill(fill, on) {
  const darker = mix(BLACK, fill, 0.08);
  if (colorDistance(darker, fill) >= 0.01 && contrastRatio(on, darker) >= MIN_TEXT) return darker;
  const lighter = mix(WHITE, fill, 0.12);
  return contrastRatio(on, lighter) >= MIN_TEXT ? lighter : darker;
}

// Pure: brand colors + a palette ({ dark, text, card, bg, subNav, navBg, tier } as parsed
// colors or CSS strings) -> { '--token': 'value' }. No colors -> {}.
export function brandAccentTokens(colors, palette) {
  const list = normalizeBrandColors(colors);
  if (!list.length) return {};
  const p = resolvePalette(palette);
  const [first, ...rest] = list.map(parseColor);
  const { fill, on } = primaryFill(first, p);
  // The translucent tints and the selected row's ground: the separated color, and on a dark
  // palette a lighter one than the card (a black brand would otherwise darken, not highlight).
  const cardLuminance = luminance(p.card);
  const tint = strongestMix(first, p.dark ? WHITE : BLACK,
    c => separated(p)(c) && (p.dark ? luminance(c) > cardLuminance : luminance(c) < cardLuminance));
  const lightAlpha = p.dark ? 0.15 : 0.1;
  const lighterAlpha = p.dark ? 0.08 : 0.06;
  const light = ground => mix(tint, ground, lightAlpha);
  const lighter = ground => mix(tint, ground, lighterAlpha);
  // Accent text sits on every surface, bare and under the tints (chips, selected options, hovers);
  // non-text accents (focus rings, selected borders, icon glyphs) on the same, at 3:1.
  const textGrounds = [p.card, p.bg, p.subNav, p.navBg, p.tier, light(p.card), light(p.bg), light(p.subNav), light(p.navBg), lighter(p.card)];
  const uiGrounds = [p.card, p.subNav, p.bg, p.navBg, lighter(p.card), light(p.card), light(p.subNav), light(p.bg), light(p.navBg)];
  const activeBg = mix(tint, p.card, 0.18);
  const tokens = {
    '--c-primary': toHex(fill),
    '--c-primary-hover': toHex(hoverFill(fill, on)),
    '--c-on-primary': toHex(on),
    '--c-primary-light': toRgba(tint, lightAlpha),
    '--c-primary-lighter': toRgba(tint, lighterAlpha),
    '--c-primary-text': toHex(strongestMix(first, p.text, clears(textGrounds, MIN_TEXT))),
    '--c-primary-border': toHex(strongestMix(first, p.text, clears(uiGrounds, MIN_UI))),
    '--left-nav-active-bg': toHex(activeBg),
    // The selected row's label (4.5:1 on its ground) and its inset bar (3:1 on the card).
    '--left-nav-active-fg': toHex(strongestMix(first, p.text, c => contrastRatio(c, activeBg) >= MIN_TEXT && contrastRatio(c, p.card) >= MIN_UI)),
  };
  // Secondary accents mark selection (the selected nav row's bar, active tab underlines): 3:1
  // on the same grounds and on the selected row itself.
  rest.forEach((color, i) => {
    tokens[`--c-accent-${i + 2}`] = toHex(color);
    tokens[`--c-accent-${i + 2}-border`] = toHex(strongestMix(color, p.text, clears([...uiGrounds, activeBg], MIN_UI)));
  });
  return tokens;
}

function resolvePalette(palette = {}) {
  const dark = !!palette.dark;
  const fallback = FALLBACK_PALETTES[dark ? 'dark' : 'light'];
  const resolved = { dark };
  for (const key of Object.keys(PALETTE_PROPS)) {
    const value = palette[key];
    const parsed = typeof value === 'string' ? parseColor(value) : value;
    resolved[key] = parsed && parsed.a === 1 ? parsed : parseColor(fallback[key]);
  }
  return resolved;
}

// The painted palette's grounds, read from <html>. Brand tokens never override these, so they
// read the palette even while brand accents are painted.
export function readPalette(root = document.documentElement) {
  const palette = { dark: root.classList.contains('theme-dark') };
  let style = null;
  try { style = getComputedStyle(root); } catch { /* no layout engine: fallbacks */ }
  for (const [key, prop] of Object.entries(PALETTE_PROPS)) palette[key] = style?.getPropertyValue(prop) || '';
  return resolvePalette(palette);
}

// ── Window state ───────────────────────────────────────────────────────────────────────────

// One cache entry per project window: Electron loads todo.html?projectPath=<dir> and keeps the
// query current across in-window project switches; browser mode has no path and one entry.
export function brandAccentStorageKey(search = globalThis.location?.search || '') {
  let project = '';
  try { project = new URLSearchParams(search).get('projectPath') || ''; } catch { /* malformed */ }
  return project ? `${BRAND_ACCENT_STORAGE_KEY}:${project}` : BRAND_ACCENT_STORAGE_KEY;
}

let _colors = [];
let _paintedKey = null;

export function getBrandColors() {
  return [..._colors];
}

// Replace the current project's brand colors and repaint. Returns the tokens painted.
export function setBrandColors(colors, options = {}) {
  _colors = normalizeBrandColors(colors);
  return paintBrandAccents(options);
}

// The window now shows another project (template.html rewrites ?projectPath= on a switch), or
// nothing was painted yet: until that project's own read answers, show the colors last painted
// for it, else the palette's accents — never the previous project's brand. Same project: no-op.
export function followBrandProject({ storage = defaultStorage(), ...options } = {}) {
  const key = brandAccentStorageKey();
  if (key === _paintedKey) return false;
  let cached = null;
  try { cached = JSON.parse(storage?.getItem(key) || 'null'); } catch { cached = null; }
  setBrandColors(Array.isArray(cached?.colors) ? cached.colors : [], { storage, ...options });
  return true;
}

// Repaint the current colors for the palette <html> shows now: clear the previous overrides,
// derive the tokens again, mark <html data-brand-accents="<count>">, refresh the pre-paint cache.
export function paintBrandAccents({ root = globalThis.document?.documentElement, storage = defaultStorage(), palette } = {}) {
  if (!root) return {};
  for (const prop of BRAND_ACCENT_PROPS) root.style.removeProperty(prop);
  const key = brandAccentStorageKey();
  _paintedKey = key;
  if (!_colors.length) {
    root.removeAttribute('data-brand-accents');
    try { storage?.removeItem(key); } catch { /* storage blocked */ }
    return {};
  }
  const tokens = brandAccentTokens(_colors, palette || readPalette(root));
  for (const [prop, value] of Object.entries(tokens)) root.style.setProperty(prop, value);
  root.setAttribute('data-brand-accents', String(_colors.length));
  try {
    storage?.setItem(key, JSON.stringify({ theme: root.getAttribute('data-theme') || '', count: _colors.length, colors: _colors, tokens }));
  } catch { /* storage blocked: the next start paints the palette first */ }
  return tokens;
}

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}
