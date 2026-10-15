import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8');

const TEMPLATE = read('template.html');
const BOARD = read('task-board.js');
const CSS = read('styles.css');

// (TPT220) The shipped default theme is 'paper' (TipATask dawn). The id lives in four places
// that cannot import one another — styles.css :root, template.html (static <html data-theme>
// + the anti-FOUC IIFE) and task-board.js — so this file is the only thing keeping them in
// step. The IIFE is additionally executed in a vm sandbox so "no stored preference → paper"
// and "a stored theme still wins" are proven by running the pre-paint code, not by reading it.
const DEFAULT_ID = 'paper';

// The 17 palette tokens a light [data-theme] block carries; :root must mirror them for the
// default to paint correctly before any attribute is set.
const PALETTE_TOKENS = [
  '--c-primary', '--c-primary-hover', '--c-on-primary', '--c-primary-light', '--c-primary-lighter',
  '--c-bg', '--c-bg-card', '--c-bg-sub-nav', '--c-bg-tier',
  '--c-text', '--c-text-secondary', '--c-text-muted', '--c-text-faint',
  '--c-border', '--c-border-input', '--c-nav-bg', '--c-shadow',
];

function cssBlock(selectorPattern) {
  const m = new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`).exec(CSS);
  assert.ok(m, `styles.css has no ${selectorPattern} block`);
  return m[1];
}

function tokens(block) {
  const out = {};
  // Comments first: a token name followed by a colon inside a comment would otherwise win.
  for (const m of block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function rgb(hex) {
  assert.match(hex, /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, `expected a hex colour, got ${hex}`);
  const raw = hex.slice(1);
  const expanded = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw;
  return expanded.match(/../g).map((pair) => parseInt(pair, 16));
}

function relativeLuminance(hex) {
  const [r, g, b] = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function themePalettes() {
  const palettes = [{ id: ':root', values: tokens(cssBlock(':root')) }];
  for (const match of CSS.matchAll(/^\s*\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/gm)) {
    palettes.push({ id: match[1], values: tokens(match[2]) });
  }
  return palettes;
}

function iifeSource() {
  const m = /\(function\(\)\s*\{[\s\S]*?\n\s*\}\)\(\);/.exec(TEMPLATE);
  assert.ok(m, 'template.html anti-FOUC IIFE not found');
  assert.match(m[0], /tiptask-theme/, 'first IIFE in template.html is not the theme bootstrap');
  return m[0];
}

// Run the real pre-paint IIFE against a stub DOM/localStorage; return what it painted.
function runPrepaint({ stored, storageThrows = false }) {
  const store = new Map();
  if (stored !== undefined) store.set('tiptask-theme', stored);
  const attrs = {};
  const classes = new Set();
  const sandbox = {
    localStorage: {
      getItem: (k) => {
        if (storageThrows) throw new Error('storage blocked');
        return store.has(k) ? store.get(k) : null;
      },
      setItem: (k, v) => {
        if (storageThrows) throw new Error('storage blocked');
        store.set(k, v);
      },
    },
    document: {
      documentElement: {
        setAttribute: (k, v) => { attrs[k] = v; },
        classList: { add: (c) => classes.add(c) },
      },
    },
  };
  vm.runInNewContext(iifeSource(), sandbox);
  return { theme: attrs['data-theme'], dark: classes.has('theme-dark'), stored: store.get('tiptask-theme') };
}

test('static <html data-theme> ships the default id', () => {
  const m = /<html\b[^>]*\bdata-theme="([^"]*)"/.exec(TEMPLATE);
  assert.ok(m, '<html> has no static data-theme attribute');
  assert.equal(m[1], DEFAULT_ID);
});

test('template.html IIFE and task-board.js agree on the default id', () => {
  const iifeDefault = /var DEFAULT\s*=\s*'([^']+)'/.exec(iifeSource());
  assert.ok(iifeDefault, 'IIFE has no DEFAULT literal');
  assert.equal(iifeDefault[1], DEFAULT_ID);
  assert.match(iifeSource(), /ALIASES\s*=\s*\{\s*'':\s*DEFAULT\b/, "IIFE ALIASES[''] must resolve to DEFAULT");

  const boardDefault = /export const DEFAULT_THEME\s*=\s*'([^']+)'/.exec(BOARD);
  assert.ok(boardDefault, 'task-board.js has no exported DEFAULT_THEME');
  assert.equal(boardDefault[1], DEFAULT_ID);
  assert.match(BOARD, /_THEME_ALIASES\s*=\s*\{\s*'':\s*DEFAULT_THEME\b/, "_THEME_ALIASES[''] must resolve to DEFAULT_THEME");
});

test('no hardcoded fallback literal for a previous default remains in task-board.js', () => {
  assert.doesNotMatch(BOARD, /\|\|\s*'parchment'/, "a `|| 'parchment'` fallback is still in task-board.js");
});

test(":root palette mirrors [data-theme='paper'] token for token", () => {
  const root = tokens(cssBlock(':root'));
  const paper = tokens(cssBlock('\\[data-theme="paper"\\]'));
  for (const name of PALETTE_TOKENS) {
    assert.ok(paper[name], `[data-theme="paper"] is missing ${name}`);
    assert.equal(root[name], paper[name], `:root ${name} drifted from [data-theme="paper"]`);
  }
});

test('primary fills use a light foreground with AA contrast in every theme', () => {
  for (const { id, values } of themePalettes()) {
    assert.equal(values['--c-on-primary'].toLowerCase(), '#fff', `${id} must use a light primary foreground`);
    for (const token of ['--c-primary', '--c-primary-hover']) {
      const ratio = contrastRatio(values['--c-on-primary'], values[token]);
      assert.ok(ratio >= 4.5, `${id} ${token} contrast is ${ratio.toFixed(2)}:1; expected at least 4.5:1`);
    }
  }
});

// (TPT371) --left-nav-active-bg/-fg are color-mix() formulas (see styles.css :root and
// .theme-dark), not literal hexes, so this mixes them the same way the browser would and
// checks the result against every real palette instead of eyeballing one theme.
function colorMixPercent(varName, block) {
  const re = new RegExp(`${varName}:\\s*color-mix\\(in srgb,\\s*var\\(--c-primary\\)\\s*(\\d+)%`);
  const m = re.exec(block);
  assert.ok(m, `${varName} is missing or not a --c-primary color-mix() in the given block`);
  return Number(m[1]);
}

function mixHex(primaryHex, otherHex, primaryPercent) {
  const [pr, pg, pb] = rgb(primaryHex);
  const [or_, og, ob] = rgb(otherHex);
  const p = primaryPercent / 100;
  const blend = (a, b) => Math.round(a * p + b * (1 - p));
  return `#${[blend(pr, or_), blend(pg, og), blend(pb, ob)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

test('left-nav focused-row tokens clear AA contrast in every theme', () => {
  const rootBlock = cssBlock(':root');
  const darkBlock = cssBlock('\\.theme-dark');
  const bgPercent = colorMixPercent('--left-nav-active-bg', rootBlock);
  const lightFgPercent = colorMixPercent('--left-nav-active-fg', rootBlock);
  const darkFgPercent = colorMixPercent('--left-nav-active-fg', darkBlock);

  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  for (const { id, values } of themePalettes()) {
    const fgPercent = darkIds.has(id) ? darkFgPercent : lightFgPercent;
    const bg = mixHex(values['--c-primary'], values['--c-bg-card'], bgPercent);
    const fg = mixHex(values['--c-primary'], values['--c-text'], fgPercent);
    const textRatio = contrastRatio(fg, bg);
    assert.ok(textRatio >= 4.5, `${id} focused-row text/bg contrast is ${textRatio.toFixed(2)}:1; expected at least 4.5:1`);
    const barRatio = contrastRatio(fg, values['--c-bg-card']);
    assert.ok(barRatio >= 3, `${id} focused-row accent bar/card contrast is ${barRatio.toFixed(2)}:1; expected at least 3:1`);
  }
});

test('left-nav active rows consume the dedicated focused-row tokens, not the shared hover tint', () => {
  for (const selector of ['\\.left-nav-btn\\.active', '\\.active-session-item\\.active']) {
    const block = cssBlock(selector);
    assert.match(block, /color:\s*var\(--left-nav-active-fg\)/, `${selector} lost --left-nav-active-fg`);
    assert.match(block, /background-color:\s*var\(--left-nav-active-bg\)/, `${selector} lost --left-nav-active-bg`);
  }
});

// (TPT652) --c-primary-text is the AA-safe accent *text* colour: a color-mix() of --c-primary
// toward --c-text (light % in :root, dark % in .theme-dark). (TPT677) Every accent `color:` in
// styles.css uses it, so it is checked on each ground accent text sits on: card, page bg, sub-nav,
// nav bar and tier (file refs), bare and under the --c-primary-light / -lighter tints (chips,
// selected options, hovers).
function compositeOver(rgba, baseHex) {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(rgba);
  assert.ok(m, `expected an rgba() colour, got ${rgba}`);
  const [r, g, b, a] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const base = rgb(baseHex);
  const blend = (c, i) => Math.round(c * a + base[i] * (1 - a));
  return `#${[r, g, b].map(blend).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

test('--c-primary-text clears AA contrast on every accent-text ground in every theme', () => {
  const lightPercent = colorMixPercent('--c-primary-text', cssBlock(':root'));
  const darkPercent = colorMixPercent('--c-primary-text', cssBlock('\\.theme-dark'));
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  for (const { id, values } of themePalettes()) {
    const fg = mixHex(values['--c-primary'], values['--c-text'], darkIds.has(id) ? darkPercent : lightPercent);
    const light = (base) => compositeOver(values['--c-primary-light'], base);
    const grounds = [
      ['card', values['--c-bg-card']],
      ['bg', values['--c-bg']],
      ['sub-nav', values['--c-bg-sub-nav']],
      ['nav', values['--c-nav-bg']],
      ['tier', values['--c-bg-tier']],
      ['primary-light tint', light(values['--c-bg-card'])],
      ['primary-light tint on bg', light(values['--c-bg'])],
      ['primary-light tint on sub-nav', light(values['--c-bg-sub-nav'])],
      ['primary-light tint on nav', light(values['--c-nav-bg'])],
      ['primary-lighter tint', compositeOver(values['--c-primary-lighter'], values['--c-bg-card'])],
    ];
    for (const [label, bg] of grounds) {
      const ratio = contrastRatio(fg, bg);
      assert.ok(ratio >= 4.5, `${id} --c-primary-text on ${label} is ${ratio.toFixed(2)}:1; expected at least 4.5:1`);
    }
  }
});

// (TPT676) --c-primary-border is the non-text accent (focus/selected borders, focus outlines,
// active step dots, tab underlines). WCAG 1.4.11 asks 3:1 against the adjacent colour: the card,
// the sub-nav (setup-modal inputs) and the card under --c-primary-lighter (selected cards).
// (TPT677) Also the icon-only chrome glyphs: filter chevrons on the nav bar, and hovered icons
// under --c-primary-light on the card (left nav, composer), sub-nav, page bg and nav bar.
test('--c-primary-border clears 3:1 non-text contrast on every non-text accent ground in every theme', () => {
  const lightPercent = colorMixPercent('--c-primary-border', cssBlock(':root'));
  const darkPercent = colorMixPercent('--c-primary-border', cssBlock('\\.theme-dark'));
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  for (const { id, values } of themePalettes()) {
    const accent = mixHex(values['--c-primary'], values['--c-text'], darkIds.has(id) ? darkPercent : lightPercent);
    const card = values['--c-bg-card'];
    const light = (base) => compositeOver(values['--c-primary-light'], base);
    for (const [label, bg] of [
      ['card', card],
      ['sub-nav', values['--c-bg-sub-nav']],
      ['bg', values['--c-bg']],
      ['nav', values['--c-nav-bg']],
      ['primary-lighter tint', compositeOver(values['--c-primary-lighter'], card)],
      ['primary-light tint', light(card)],
      ['primary-light tint on sub-nav', light(values['--c-bg-sub-nav'])],
      ['primary-light tint on bg', light(values['--c-bg'])],
      ['primary-light tint on nav', light(values['--c-nav-bg'])],
    ]) {
      const ratio = contrastRatio(accent, bg);
      assert.ok(ratio >= 3, `${id} --c-primary-border on ${label} is ${ratio.toFixed(2)}:1; expected at least 3:1`);
    }
  }
});

test('setup-modal focus, selected and active accents consume --c-primary-border, not raw --c-primary', () => {
  for (const selector of [
    '\\.setup-modal-dot\\.is-active',
    '\\.setup-modal-input:focus',
    '\\.setup-modal-textarea:focus',
    '\\.setup-modal-tab\\.is-active',
    '\\.setup-modal-preset-card\\.is-selected',
    '\\.setup-modal-project-card\\.is-selected',
    '\\.setup-modal-agent-card\\.is-selected',
  ]) {
    assert.match(cssBlock(selector), /var\(--c-primary-border\)/, `${selector} lost --c-primary-border`);
  }

  const offenders = [];
  for (const m of CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!selector.startsWith('.setup-modal') || !/:focus|\.is-selected|\.is-active/.test(selector)) continue;
    if (/(?:border[\w-]*|outline[\w-]*|background)\s*:[^;]*var\(--c-primary\)(?![-\w])/.test(m[2])) offenders.push(selector);
  }
  assert.deepEqual(offenders, [], `setup-modal state rules still paint raw --c-primary: ${offenders.join(', ')}`);
});

// (TPT680) Focus rings and inline-edit outlines anywhere in the sheet are non-text state
// indicators too: raw --c-primary is a fill colour and falls under 3:1 on dark cards (nord ~2.2:1).
// (TPT683) So are `--current` state markers such as the agent selector's default-pick ring.
test('no focus, inline-edit or current-pick rule paints an outline, border or box-shadow with raw --c-primary', () => {
  const usesBorder = rulesMatching(/var\(--c-primary-border\)/);
  for (const selector of [
    '.agent-quota-sidebar-row:focus-visible .agent-quota-sidebar-bar',
    '.modal-top-bar button.task-modal-tab:focus-visible',
    '.card-desc.editing',
    '.card-title.editing',
    '.preview-card:not(.card) .preview-title.editing',
    '.preview-card:not(.card) .preview-desc.editing',
    '.agent-selector-btn--current',
  ]) {
    assert.ok(usesBorder.includes(selector), `${selector} lost --c-primary-border`);
  }

  const offenders = rulesMatching(/(?:border[\w-]*|outline[\w-]*|box-shadow)\s*:[^;]*var\(--c-primary\)(?![-\w])/)
    .filter((selector) => /:focus(?:-visible|-within)?\b|\.editing\b|--current\b/.test(selector));
  assert.deepEqual(offenders, [], `focus/edit/current rules still paint raw --c-primary — use --c-primary-border: ${offenders.join(', ')}`);
});

// (TPT677) Raw --c-primary / --c-primary-hover are fill colours, dark enough for white-on-primary
// buttons; as text they fall under 4.5:1 on every dark card (nord ~2.2:1). Accent text uses
// --c-primary-text, text on a primary fill --c-on-primary. A selector belongs on this allowlist
// only with a contrast check proving its own ground keeps the raw fill at 4.5:1 in every palette.
const RAW_PRIMARY_TEXT_ALLOWLIST = [];

// The only rules allowed to colour with the 3:1 --c-primary-border: icon-only glyphs on chrome
// surfaces (nav, left nav, composer, modals). Text needs 4.5:1, and card-surface icons sit on
// state tints (dark canceled, objective) where the border token drops under 3:1, so both use
// --c-primary-text instead.
const PRIMARY_BORDER_ICON_SELECTORS = [
  '.sidebar-toggle:hover',
  '.agent-quota-sidebar-refresh:hover, .agent-quota-sidebar-refresh:focus-visible',
  '.btn-board-refresh:hover',
  '.audio-rec-btn:hover',
  '.audio-rec-btn.voice-btn-emphasis',
  '.audio-rec-btn.voice-btn-emphasis:disabled:hover',
  '.task-chat-start-mark',
  '.task-chat-attach-icon',
  '.chat-console-toggle:hover',
  '.task-modal-empty-mark',
];

// Selectors (whitespace-normalised) of every innermost rule whose body matches `pattern`.
// Comments are stripped from the whole sheet first: several contain braces.
function rulesMatching(pattern) {
  const out = [];
  for (const m of CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (pattern.test(m[2])) out.push(m[1].trim().replace(/\s+/g, ' '));
  }
  return out;
}

test('no styles.css rule paints text with raw --c-primary or --c-primary-hover', () => {
  const offenders = rulesMatching(/(?:^|[^-\w])color\s*:\s*var\(--c-primary(?:-hover)?\s*[,)]/)
    .filter((selector) => !RAW_PRIMARY_TEXT_ALLOWLIST.includes(selector));
  assert.deepEqual(offenders, [], `rules still paint text with a primary fill colour — use --c-primary-text: ${offenders.join(', ')}`);
});

test('only the pinned icon-only chrome rules colour with --c-primary-border', () => {
  const used = rulesMatching(/(?:^|[^-\w])color\s*:\s*var\(--c-primary-border\s*[,)]/);
  assert.deepEqual([...used].sort(), [...PRIMARY_BORDER_ICON_SELECTORS].sort());
});

test('active nav labels, filter chevrons and tag badges consume the AA accent tokens', () => {
  for (const selector of [
    '\\.nav-tabs button\\.active',
    '\\.nav-objective-tabs \\.nav-tab-objective-wrap\\.active button\\.nav-tab-objective',
    '\\.nav-section\\.active',
    '\\.mobile-menu-item\\.active',
  ]) {
    assert.match(cssBlock(selector), /color:\s*var\(--c-primary-text\)/, `${selector} lost --c-primary-text`);
  }
  for (const name of ['people', 'status']) {
    assert.match(
      cssBlock(`\\.${name}-filter-wrap::after`),
      /background-color:\s*var\(--c-primary-border\)/,
      `${name} filter chevron lost --c-primary-border`
    );
  }
  // Opaque chip ground: a bare translucent tint takes on the card's state colour.
  assert.match(
    cssBlock('\\.tag-badge'),
    /background:\s*linear-gradient\(var\(--c-primary-light\),\s*var\(--c-primary-light\)\),\s*var\(--c-bg-card\)/,
    '.tag-badge lost its opaque --c-bg-card chip ground'
  );
});

// (TPT681) Accent text on card *state* tints (new-proposal success tint, dark canceled card) is
// not covered by the --c-primary-text ground list above, so those elements avoid the bare tint.
test('accent text on tinted task cards sits on an AA-safe ground', () => {
  assert.match(
    cssBlock('\\.preview-card \\.change-target--subtask'),
    /background:\s*linear-gradient\(var\(--c-primary-light\),\s*var\(--c-primary-light\)\),\s*var\(--c-bg-card\)/,
    '.change-target--subtask lost its opaque --c-bg-card chip ground'
  );
  const hover = cssBlock('\\.subtask-title:hover');
  assert.match(hover, /color:\s*var\(--c-text\)/, '.subtask-title:hover must use --c-text');
  assert.doesNotMatch(hover, /--c-primary-text/, '.subtask-title:hover must not use --c-primary-text');
});

// (TPT682) Closed cards and done To-Do rows used to fade with group opacity, which blends every
// glyph toward the backdrop and put all their text under 4.5:1. The closed cue is now the ground,
// a dimmer text colour, strike-through and a flat card. This composites each closed-state text
// colour over its real ground at whatever opacity the sheet applies (container × element), so a
// re-added fade or a token swap to a too-faint colour fails here.
const CLEAN_RULES = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((m) => ({ parts: splitArgs(m[1].trim()).map((p) => p.replace(/\s+/g, ' ')), body: m[2] }));

// Last value of `prop` among the rules whose selector list holds `selector` exactly.
function ruleValue(selector, prop) {
  let value = null;
  for (const { parts, body } of CLEAN_RULES) {
    if (!parts.includes(selector)) continue;
    for (const d of body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))) value = d[1].trim();
  }
  return value;
}

function splitArgs(inner) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') depth++;
    else if (inner[i] === ')') depth--;
    else if (inner[i] === ',' && depth === 0) { out.push(inner.slice(start, i).trim()); start = i + 1; }
  }
  out.push(inner.slice(start).trim());
  return out;
}

// Resolves hex, var(--x[, fallback]) and two-stop color-mix(in srgb, …) to a hex colour.
function resolveColor(expr, values) {
  const e = expr.trim();
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(e)) return e;
  let m = /^var\((.*)\)$/.exec(e);
  if (m) {
    const [name, fallback] = splitArgs(m[1]);
    if (values[name] !== undefined) return resolveColor(values[name], values);
    assert.ok(fallback, `cannot resolve ${name}`);
    return resolveColor(fallback, values);
  }
  m = /^color-mix\(in srgb,(.*)\)$/.exec(e);
  assert.ok(m, `unsupported colour expression: ${e}`);
  const stops = splitArgs(m[1]).map((s) => {
    const pm = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(s);
    return pm ? { color: pm[1], pct: Number(pm[2]) } : { color: s, pct: null };
  });
  assert.equal(stops.length, 2, `color-mix needs two stops: ${e}`);
  const p = stops[0].pct ?? (stops[1].pct !== null ? 100 - stops[1].pct : 50);
  return mixHex(resolveColor(stops[0].color, values), resolveColor(stops[1].color, values), p);
}

function resolveOpacity(expr, values) {
  if (expr === null) return 1;
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(expr);
  if (m) return resolveOpacity(values[m[1]] ?? m[2]?.trim() ?? null, values);
  const n = Number(expr);
  assert.ok(Number.isFinite(n), `unsupported opacity value: ${expr}`);
  return n;
}

// Cascaded token values for one palette: :root → .theme-dark → [data-theme] → .theme-dark[data-theme].
function layeredPalette(id, values, darkIds) {
  if (id === ':root') return { ...values };
  const dark = darkIds.has(id);
  const darkThemed = CSS.match(new RegExp(`\\.theme-dark\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`));
  return {
    ...tokens(cssBlock(':root')),
    ...(dark ? tokens(cssBlock('\\.theme-dark')) : {}),
    ...values,
    ...(dark && darkThemed ? tokens(darkThemed[1]) : {}),
  };
}

test('closed cards and done To-Do rows keep text at AA at their effective opacity in every palette', () => {
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  const META = ':is(.deps, .card-deps-label, .effort-badge, .card-due:not(.overdue))';
  const cases = [];
  for (const role of ['complete', 'canceled']) {
    const card = `.card[data-status-role="${role}"]`;
    for (const el of ['.card-title', '.card-desc', META]) {
      cases.push({ label: `${role} card ${el === META ? 'meta' : el}`, container: card, el: `${card} ${el}`, ground: `${card}` });
    }
  }
  const todo = '.todo-item[data-status-role="complete"]';
  cases.push({ label: 'done To-Do title', container: todo, el: '.todo-title.done', ground: '.todo-item' });
  cases.push({ label: 'done To-Do id', container: todo, el: '.todo-item-id', ground: '.todo-item' });

  for (const { id, values } of themePalettes()) {
    const dark = darkIds.has(id);
    const v = layeredPalette(id, values, darkIds);
    // A .theme-dark-prefixed rule outranks the base one, so it decides the value in dark ids.
    const value = (sel, prop) => (dark && ruleValue(`.theme-dark ${sel}`, prop)) || ruleValue(sel, prop);
    for (const { label, container, el, ground } of cases) {
      const fgExpr = value(el, 'color');
      assert.ok(fgExpr, `${label}: no color rule for ${el}`);
      const bgExpr = value(container, 'background') || value(ground, 'background');
      assert.ok(bgExpr, `${label}: no background rule for ${container} or ${ground}`);
      const o = resolveOpacity(value(container, 'opacity'), v) * resolveOpacity(value(el, 'opacity'), v);
      const fg = resolveColor(fgExpr, v);
      const bg = resolveColor(bgExpr, v);
      for (const backdrop of [v['--c-bg'], v['--c-bg-tier']]) {
        const ratio = contrastRatio(mixHex(fg, backdrop, o * 100), mixHex(bg, backdrop, o * 100));
        assert.ok(ratio >= 4.5, `${id} ${label} is ${ratio.toFixed(2)}:1 at opacity ${o}; expected at least 4.5:1`);
      }
    }

    // The closed cue must survive without the fade: a dimmer title than open cards…
    for (const role of ['complete', 'canceled']) {
      const title = resolveColor(value(`.card[data-status-role="${role}"] .card-title`, 'color'), v);
      assert.notEqual(title, resolveColor('var(--c-text)', v), `${id} ${role} title must not use the open-card --c-text`);
    }
    // …and, in light palettes, a closed ground distinct from the open card.
    if (!dark) {
      assert.notEqual(
        resolveColor(value('.card[data-status-role="complete"]', 'background'), v),
        resolveColor('var(--c-bg-card)', v),
        `${id} completed card ground must differ from --c-bg-card`,
      );
    }
  }

  for (const selector of [
    '.card[data-status-role="canceled"] .card-title',
    '.card[data-status-role="canceled"] .card-desc',
    '.todo-title.done',
  ]) {
    assert.match(ruleValue(selector, 'text-decoration') ?? '', /line-through/, `${selector} lost its strike-through closed cue`);
  }
});

// (TPT686) The Start button on a closed card is still an active control (it re-runs the task),
// so WCAG 1.4.11 wants 3:1 for its edge and glyph against the closed ground. An opacity fade can
// never get there (a faded --c-primary fill sits near 1.2:1 on nord's canceled ground), so the
// button is an outlined secondary control at rest and the full primary fill on hover — and only
// on a card without a session: .has-active-session cards keep the filled/emerald/spinner button.
test('closed-card Start button keeps 3:1 non-text contrast at rest and on hover in every palette', () => {
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  for (const role of ['complete', 'canceled']) {
    const card = `.card[data-status-role="${role}"]`;
    // No closed-card rule may target the button without the session guard: that would override
    // the lower-specificity .resumable / .session-running fills on a card with a session.
    for (const prop of ['background', 'border-color', 'color', 'opacity']) {
      assert.equal(ruleValue(`${card} .btn-claude`, prop), null, `${card} .btn-claude must not set ${prop} — guard with :not(.has-active-session)`);
    }
    assert.equal(ruleValue(`${card}.has-active-session .btn-claude`, 'opacity'), null, `${role}: the opacity override is gone with the fade`);
  }

  for (const { id, values } of themePalettes()) {
    const dark = darkIds.has(id);
    const v = layeredPalette(id, values, darkIds);
    const value = (sel, prop) => (dark && ruleValue(`.theme-dark ${sel}`, prop)) || ruleValue(sel, prop);
    for (const role of ['complete', 'canceled']) {
      const card = `.card[data-status-role="${role}"]`;
      const btn = `${card}:not(.has-active-session) .btn-claude`;
      const ground = resolveColor(value(card, 'background'), v);

      // At rest: no fade, transparent fill (so the ground is the adjacent colour), and the
      // edge + glyph tokens clear 3:1 / 4.5:1 (the glyph is "Start" text until the play icon lands).
      const o = resolveOpacity(value(card, 'opacity'), v) * resolveOpacity(value(btn, 'opacity'), v);
      assert.equal(o, 1, `${id} ${role} Start button is faded to ${o}`);
      assert.equal(value(btn, 'background'), 'transparent', `${id} ${role} Start button at rest must have a transparent fill`);
      const edge = contrastRatio(resolveColor(value(btn, 'border-color'), v), ground);
      assert.ok(edge >= 3, `${id} ${role} Start button edge is ${edge.toFixed(2)}:1 on the closed ground; expected at least 3:1`);
      const glyph = contrastRatio(resolveColor(value(btn, 'color'), v), ground);
      assert.ok(glyph >= 4.5, `${id} ${role} Start button glyph is ${glyph.toFixed(2)}:1 on the closed ground; expected at least 4.5:1`);

      // Hover: the edge still clears 3:1 against the ground and the glyph 4.5:1 on its own fill.
      const hover = `${btn}:hover`;
      const hoverFill = resolveColor(value(hover, 'background'), v);
      assert.notEqual(hoverFill, 'transparent', `${id} ${role} Start button hover must fill`);
      const hoverEdge = contrastRatio(resolveColor(value(hover, 'border-color'), v), ground);
      assert.ok(hoverEdge >= 3, `${id} ${role} hovered Start button edge is ${hoverEdge.toFixed(2)}:1; expected at least 3:1`);
      const hoverGlyph = contrastRatio(resolveColor(value(hover, 'color'), v), hoverFill);
      assert.ok(hoverGlyph >= 4.5, `${id} ${role} hovered Start button glyph is ${hoverGlyph.toFixed(2)}:1 on its fill; expected at least 4.5:1`);

    }
  }
});

// (TPT685) The open card's "Depends on:" line was --c-text-faint: 2.67–4.24:1 on --c-bg-card,
// under AA in every palette. It now uses --c-text-muted; this pins it at AA on the open card
// ground (closed cards are covered by the meta case above).
test('card dependency line clears AA on the open card ground in every palette', () => {
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  for (const { id, values } of themePalettes()) {
    const v = layeredPalette(id, values, darkIds);
    const fgExpr = (darkIds.has(id) && ruleValue('.theme-dark .deps', 'color')) || ruleValue('.deps', 'color');
    assert.ok(fgExpr, '.deps has no color rule');
    const fg = resolveColor(fgExpr, v);
    const bg = resolveColor('var(--c-bg-card)', v);
    assert.notEqual(fg, resolveColor('var(--c-text-faint)', v), `${id} .deps must not use --c-text-faint`);
    const ratio = contrastRatio(fg, bg);
    assert.ok(ratio >= 4.5, `${id} .deps on --c-bg-card is ${ratio.toFixed(2)}:1; expected at least 4.5:1`);
  }
});

// (TPT652) --c-mauve / --c-green / --c-red are Catppuccin names no theme defines, so their
// Mocha fallbacks painted in every palette. (TPT675) Widened from the .setup-modal-* rules to
// every rule in styles.css. (TPT679) Generalised from those three names to every token: a
// var(--c-…) that no theme block defines paints its hard-coded fallback in every palette (or,
// with no fallback, nothing at all). Theme blocks are :root, [data-theme="…"], .theme-dark and
// .theme-dark[data-theme="…"]. A name belongs on the allowlist only when its fallback is not a
// colour and is meant to apply everywhere.
const UNDEFINED_TOKEN_ALLOWLIST = ['--c-mono'];
const THEME_BLOCK_SELECTOR = /^(?::root|\[data-theme="[^"]+"\]|\.theme-dark(?:\[data-theme="[^"]+"\])?)$/;

function cssTokenUsage() {
  const defined = new Set();
  const used = new Map();
  for (const m of CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (THEME_BLOCK_SELECTOR.test(selector)) {
      for (const d of m[2].matchAll(/(--c-[\w-]+)\s*:/g)) defined.add(d[1]);
    }
    for (const u of m[2].matchAll(/var\(\s*(--c-[\w-]+)/g)) {
      if (!used.has(u[1])) used.set(u[1], selector);
    }
  }
  return { defined, used };
}

test('every var(--c-…) in styles.css is defined by a theme block', () => {
  const { defined, used } = cssTokenUsage();
  const offenders = [...used]
    .filter(([name]) => !defined.has(name) && !UNDEFINED_TOKEN_ALLOWLIST.includes(name))
    .map(([name, selector]) => `${name} (first used by ${selector})`);
  assert.deepEqual(offenders, [], `styles.css uses tokens no theme defines: ${offenders.join(', ')}`);
});

test('the undefined-token allowlist holds only names still used and still undefined', () => {
  const { defined, used } = cssTokenUsage();
  for (const name of UNDEFINED_TOKEN_ALLOWLIST) {
    assert.ok(used.has(name), `${name} is allowlisted but no longer used; drop it from the allowlist`);
    assert.ok(!defined.has(name), `${name} is allowlisted but now defined; drop it from the allowlist`);
  }
});

// (TPT679) The agent notice toast and the spec chat focus ring painted Mocha literals in every
// palette; both now come from the theme, and the toast's text clears AA on its own ground.
test('agent notice toast and spec chat focus ring consume per-theme tokens', () => {
  const toast = cssBlock('\\.agent-notice-toast');
  assert.match(toast, /background:\s*var\(--c-bg-card\)/, '.agent-notice-toast lost its --c-bg-card ground');
  assert.match(toast, /(?:^|[^-\w])color:\s*var\(--c-text-secondary\)/, '.agent-notice-toast lost --c-text-secondary');
  assert.match(
    cssBlock('\\.spec-chat-input:focus'),
    /box-shadow:\s*0 0 0 2px var\(--c-primary-light\)/,
    '.spec-chat-input:focus glow must follow the palette accent'
  );
  for (const { id, values } of themePalettes()) {
    const ratio = contrastRatio(values['--c-text-secondary'], values['--c-bg-card']);
    assert.ok(ratio >= 4.5, `${id} toast text on card is ${ratio.toFixed(2)}:1; expected at least 4.5:1`);
  }
});

test('accent controls consume --c-on-primary for text, icons, dots and chevrons', () => {
  for (const selector of [
    '\\.btn-chat-send',
    '\\.modal-buttons \\.btn-confirm',
    '\\.modal-top-bar button\\.btn-modal-save',
    '\\.agent-badge--human',
    '\\.member-badge--initials',
    '\\.setup-modal-btn--primary',
  ]) {
    assert.match(cssBlock(selector), /color:\s*var\(--c-on-primary\)/, `${selector} lost its primary foreground token`);
  }

  assert.match(
    cssBlock('\\.subtask-radio:checked::after'),
    /background:\s*var\(--c-on-primary\)/,
    'checked subtask radio dot lost its primary foreground token'
  );

  for (const name of ['people', 'status']) {
    const selector = `\\.${name}-filter-wrap\\.active::after,\\s*\\.${name}-filter-wrap:hover::after`;
    assert.match(
      cssBlock(selector),
      /background-color:\s*var\(--c-on-primary\)/,
      `${name} filter chevron lost its primary foreground token`
    );
  }
});

test('the default is a light theme and the dark lists stay in sync', () => {
  const iifeDark = /var DARK\s*=\s*\{([^}]*)\}/.exec(iifeSource());
  assert.ok(iifeDark, 'IIFE has no DARK literal');
  const iifeIds = [...iifeDark[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]).sort();

  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const boardIds = [...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

  assert.deepEqual(iifeIds, boardIds, 'template.html DARK and task-board.js _DARK_THEMES diverged');
  assert.ok(!boardIds.includes(DEFAULT_ID), 'the default theme must not be a dark id');
  assert.ok(boardIds.includes('ink'), "'ink' (TipATask dusk) must stay a dark id");
});

test('the default id has a selectable #settings-theme-select option', () => {
  assert.match(TEMPLATE, new RegExp(`<option value="${DEFAULT_ID}">TipATask dawn</option>`));
});

test('pre-paint: a profile with nothing stored paints the default, light', () => {
  const r = runPrepaint({});
  assert.equal(r.theme, DEFAULT_ID);
  assert.equal(r.dark, false);
});

test('pre-paint: a legacy empty stored value resolves to the default and is migrated', () => {
  const r = runPrepaint({ stored: '' });
  assert.equal(r.theme, DEFAULT_ID);
  assert.equal(r.stored, DEFAULT_ID);
});

test('pre-paint: a stored theme still wins over the new default', () => {
  const light = runPrepaint({ stored: 'parchment' });
  assert.equal(light.theme, 'parchment');
  assert.equal(light.dark, false);

  const dark = runPrepaint({ stored: 'mocha' });
  assert.equal(dark.theme, 'mocha');
  assert.equal(dark.dark, true);

  const dusk = runPrepaint({ stored: 'ink' });
  assert.equal(dusk.theme, 'ink');
  assert.equal(dusk.dark, true);
});

test('pre-paint: legacy color-name aliases still map forward', () => {
  assert.equal(runPrepaint({ stored: 'greenish' }).theme, 'meadow');
  assert.equal(runPrepaint({ stored: 'reddish' }).theme, 'terracotta');
});

test('pre-paint: blocked storage still paints the default instead of throwing', () => {
  const r = runPrepaint({ storageThrows: true });
  assert.equal(r.theme, DEFAULT_ID);
  assert.equal(r.dark, false);
});

test('readProjectTheme keeps project color_scheme ahead of local config, and the default last', () => {
  const m = /async function readProjectTheme\(\)\s*\{([\s\S]*?)\n\}/.exec(BOARD);
  assert.ok(m, 'readProjectTheme() not found in task-board.js');
  const body = m[1];
  const schemeAt = body.indexOf("scheme !== 'default'");
  const localAt = body.indexOf('_readLocalConfigTheme()');
  assert.ok(schemeAt !== -1, "readProjectTheme() no longer guards on scheme !== 'default'");
  assert.ok(localAt !== -1, 'readProjectTheme() no longer falls back to _readLocalConfigTheme()');
  assert.ok(schemeAt < localAt, 'project color_scheme must be consulted before the local config theme');
  assert.doesNotMatch(body, /DEFAULT_THEME|'paper'/, 'readProjectTheme() must not inject the default itself — _normalizeTheme() does');
});

test('running-session spinner button is filled from the theme accent token, after the fixed resumable green (TPT399)', () => {
  const block = cssBlock('\\.btn-claude\\.session-running');
  const hover = cssBlock('\\.btn-claude\\.session-running:hover');
  assert.match(block, /background:\s*var\(--c-primary\)/);
  assert.match(block, /border-color:\s*var\(--c-primary\)/);
  assert.match(block, /color:\s*var\(--c-on-primary/);
  assert.match(hover, /background:\s*var\(--c-primary-hover\)/);
  assert.doesNotMatch(block + hover, /#[0-9a-fA-F]{3,8}\b(?![^)]*\))/, 'no hex literal in the running rule');
  assert.ok(
    CSS.indexOf('.btn-claude.session-running {') > CSS.indexOf('.btn-claude.resumable:hover'),
    '.session-running must come after .resumable so it wins at equal specificity',
  );
});
