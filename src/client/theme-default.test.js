import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_COLOR_SWATCHES } from './status-registry.js';

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
    '.agent-selector-btn--current',
    '.image-task-action:focus-visible',
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
  .map((m, index) => ({ index, parts: splitArgs(m[1].trim()).map((p) => p.replace(/\s+/g, ' ')), body: m[2] }));

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

// (TPT9060) sRGB hex ↔ OKLab (Björn Ottosson's matrices), for the relative oklch() colour the
// completed-card grey is. Channels are clamped to the sRGB gamut the way a browser paints them.
function toOklab(hex) {
  const [r, g, b] = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return `#${linear.map((channel) => {
    const v = Math.min(1, Math.max(0, channel));
    const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255).toString(16).padStart(2, '0');
  }).join('')}`;
}

// An rgba() token composited over an opaque hex ground (the objective card's --c-primary-lighter tint).
function overRgba(expr, groundHex) {
  const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(expr.trim());
  assert.ok(m, `expected an rgba() tint, got ${expr}`);
  const alpha = Number(m[4]);
  const ground = rgb(groundHex);
  return `#${[m[1], m[2], m[3]].map((c, i) => Math.round(Number(c) * alpha + ground[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
}

// Resolves hex, var(--x[, fallback]), two-stop color-mix(in srgb, …) and a relative
// oklch(from … calc(l ± n) c h) or oklch(from … n c h) (lightness shifted or set) to a hex colour.
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
  m = /^oklch\(from (.+) calc\(l ([+-]) (\d*\.?\d+)\) c h\)$/.exec(e);
  if (m) {
    const [L, a, b] = toOklab(resolveColor(m[1], values));
    return fromOklab([L + (m[2] === '-' ? -1 : 1) * Number(m[3]), a, b]);
  }
  m = /^oklch\(from (.+) (\d*\.?\d+) c h\)$/.exec(e);
  if (m) {
    const [, a, b] = toOklab(resolveColor(m[1], values));
    return fromOklab([Number(m[2]), a, b]);
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

test('canceled cards and done To-Do rows keep text at AA at their effective opacity in every palette', () => {
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  // (TPT9060) Completed cards paint every glyph in one grey — covered by the test below.
  const META = ':is(.deps, .card-deps-label, .effort-badge, .card-due:not(.overdue))';
  const cases = [];
  const canceled = '.card[data-status-role="canceled"]';
  for (const el of ['.card-title', '.card-desc', META]) {
    cases.push({ label: `canceled card ${el === META ? 'meta' : el}`, container: canceled, el: `${canceled} ${el}`, ground: canceled });
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
    const title = resolveColor(value(`${canceled} .card-title`, 'color'), v);
    assert.notEqual(title, resolveColor('var(--c-text)', v), `${id} canceled title must not use the open-card --c-text`);
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

// (TPT9060) A completed card paints every glyph in one grey, --c-card-completed-text: its closed
// ground moved a fixed OKLCH lightness step, which lands just above AA in every palette with no
// per-theme value. Chips drop their fills, so every glyph's ground is the card itself — the plain
// closed ground, or the objective tint over it. The grey has to clear 4.5:1 on both and stay at or
// under 6:1 on the plain ground; any brighter and the card stops reading as done.
const COMPLETED = '.card[data-status-role="complete"]';
const COMPLETED_TEXT_TARGETS = [
  '.card-title', '.card-desc', '.card-desc *', '.card-preview-meta', '.id-badge', '.tag-badge', '.deps',
  '.dep-badge', '.card-deps-label', '.card-due', '.effort-badge', '.ai-stats', '.subtask-item .subtask-title',
];
const COMPLETED_CHIP_TARGETS = ['.id-badge', '.tag-badge', '.dep-badge', '.card-due', '.card-desc code', '.card-desc .file-ref', '.effort-badge'];

// Specificity [ids, classes, types] of one complex selector: :is()/:not()/:has() count their most
// specific argument, :where() counts nothing, a pseudo-element counts as a type.
function specificity(selector) {
  const out = [0, 0, 0];
  const name = /^[\w-]+/;
  for (let i = 0; i < selector.length;) {
    const ch = selector[i];
    if (ch === '#' || ch === '.') {
      out[ch === '#' ? 0 : 1]++;
      i += 1 + (name.exec(selector.slice(i + 1))?.[0].length ?? 0);
    } else if (ch === '[') {
      out[1]++;
      const close = selector.indexOf(']', i);
      i = close < 0 ? selector.length : close + 1;
    } else if (ch === ':') {
      const element = selector[i + 1] === ':';
      i += element ? 2 : 1;
      const pseudo = name.exec(selector.slice(i))?.[0] ?? '';
      i += pseudo.length;
      let args = null;
      if (selector[i] === '(') {
        let depth = 0;
        const start = i + 1;
        for (; i < selector.length; i++) {
          if (selector[i] === '(') depth++;
          else if (selector[i] === ')' && --depth === 0) break;
        }
        args = selector.slice(start, i++);
      }
      if (element || ['before', 'after', 'first-line', 'first-letter'].includes(pseudo)) out[2]++;
      else if (['is', 'not', 'has', 'matches'].includes(pseudo)) {
        const top = splitArgs(args).map(specificity).sort(compareSpecificity).pop();
        top.forEach((n, k) => { out[k] += n; });
      } else if (pseudo !== 'where') out[1]++;
    } else if (/[a-z]/i.test(ch)) {
      out[2]++;
      i += name.exec(selector.slice(i))[0].length;
    } else i++;
  }
  return out;
}

function compareSpecificity(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// The last compound selector: the part that names the element a rule styles.
function lastCompound(selector) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && ' >+~'.includes(ch)) start = i + 1;
  }
  return selector.slice(start).trim();
}

// The last `prop` a completed-card rule gives `target` — a `${COMPLETED} ${target}` selector or a
// `${COMPLETED} :is(…)` list naming it — with that rule's specificity and source position.
function completedRule(target, prop) {
  let found = null;
  for (const { index, parts, body } of CLEAN_RULES) {
    for (const part of parts) {
      if (!part.startsWith(`${COMPLETED} `)) continue;
      const rest = part.slice(COMPLETED.length + 1);
      const list = /^:is\((.*)\)$/.exec(rest);
      if (!(list ? splitArgs(list[1]) : [rest]).includes(target)) continue;
      for (const d of body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))) {
        found = { value: d[1].trim(), specificity: specificity(part), index };
      }
    }
  }
  return found;
}

test('completed cards paint every glyph in one grey just above AA in every palette', () => {
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  // The objective tint below is composited from this exact layering.
  assert.match(
    ruleValue('.card.objective-highlight', 'background') ?? '',
    /^linear-gradient\(var\(--c-primary-lighter\), var\(--c-primary-lighter\)\),\s*var\(--card-bg\)$/,
    '.card.objective-highlight changed how it tints the card ground — update the objective case here',
  );
  for (const target of COMPLETED_TEXT_TARGETS) {
    assert.ok(completedRule(target, 'color'), `${COMPLETED} ${target} has no color rule`);
    assert.equal(completedRule(target, 'opacity'), null, `${COMPLETED} ${target} must not fade`);
  }
  for (const target of COMPLETED_CHIP_TARGETS) {
    assert.equal(completedRule(target, 'background')?.value, 'transparent', `${COMPLETED} ${target} keeps a fill`);
  }

  for (const { id, values } of themePalettes()) {
    if (id !== ':root') {
      assert.equal(values['--c-card-completed-text'], undefined, `[data-theme="${id}"] must not carry its own completed-card grey`);
    }
    const dark = darkIds.has(id);
    const v = layeredPalette(id, values, darkIds);
    const value = (sel, prop) => (dark && ruleValue(`.theme-dark ${sel}`, prop)) || ruleValue(sel, prop);
    const grey = resolveColor('var(--c-card-completed-text)', v);
    for (const target of COMPLETED_TEXT_TARGETS) {
      assert.equal(resolveColor(completedRule(target, 'color').value, v), grey, `${id} completed ${target} must use --c-card-completed-text`);
    }
    assert.equal(resolveOpacity(value(COMPLETED, 'opacity'), v), 1, `${id} completed card must not fade`);

    const ground = resolveColor(value(COMPLETED, 'background'), v);
    const plain = contrastRatio(grey, ground);
    const tinted = contrastRatio(grey, overRgba(v['--c-primary-lighter'], ground));
    assert.ok(plain >= 4.5, `${id} completed text is ${plain.toFixed(2)}:1 on the closed ground; expected at least 4.5:1`);
    assert.ok(tinted >= 4.5, `${id} completed text is ${tinted.toFixed(2)}:1 under the objective tint; expected at least 4.5:1`);
    assert.ok(plain <= 6, `${id} completed text is ${plain.toFixed(2)}:1 on the closed ground; expected at most 6:1 so it reads muted`);
    for (const open of ['--c-text', '--c-text-secondary']) {
      assert.notEqual(grey, resolveColor(`var(${open})`, v), `${id} completed text must not reuse the open-card ${open}`);
    }
  }
});

// (TPT9060) The completed-card rules sit late in styles.css because some component and
// .theme-dark rules share their specificity. Any other rule that colours one of those elements
// (hover states included) or fills one of the chips must lose the cascade to them: lower
// specificity, or equal and earlier in the file.
test('no other rule outranks the completed-card text and chip rules', () => {
  // Never on a completed card: another status role's rules, and proposal cards (.preview-card),
  // which carry no data-status-role at all.
  const elsewhere = (part) => /\[data-status-role=/.test(part) || /\.preview-card\b/.test(part);
  const names = (cls) => (part) => new RegExp(`\\.${cls}(?:--[\\w-]+)?(?![\\w-])`).test(lastCompound(part));
  const inDesc = (last) => (part) => /\.card-desc\s/.test(part) && last.test(lastCompound(part));
  const COLOR = /(?:^|[;\s])color\s*:/;
  const BACKGROUND = /(?:^|[;\s])background(?:-color)?\s*:/;
  const offenders = [];
  const check = (target, prop, declares, styles) => {
    const ours = completedRule(target, prop);
    assert.ok(ours, `${COMPLETED} ${target} has no ${prop} rule`);
    for (const { index, parts, body } of CLEAN_RULES) {
      if (!declares.test(body)) continue;
      for (const part of parts) {
        if (elsewhere(part) || !styles(part)) continue;
        if ((compareSpecificity(specificity(part), ours.specificity) || index - ours.index) > 0) {
          offenders.push(`${part} outranks the completed-card ${target} ${prop}`);
        }
      }
    }
  };
  for (const target of COMPLETED_TEXT_TARGETS) {
    check(target, 'color', COLOR, target === '.card-desc *' ? inDesc(/./) : names(/([\w-]+)$/.exec(target)[1]));
  }
  for (const target of COMPLETED_CHIP_TARGETS) {
    const styles = target === '.card-desc code' ? inDesc(/^code\b/)
      : target === '.card-desc .file-ref' ? inDesc(/\.file-ref(?![\w-])/)
      : names(target.slice(1));
    check(target, 'background', BACKGROUND, styles);
  }
  assert.deepEqual(offenders, [], `rules that would recolour completed-card text: ${offenders.join('; ')}`);
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

// (TPT9117) Settings ▸ Workflow status chips: the tint and the colour dot are the row's swatch
// (--wf-color, set inline by _workflowSwatch()), and the name is --wf-ink, a readable ink derived
// from it. The swatches are Catppuccin Mocha pastels, so the raw swatch as text vanished on its own
// tint in every light palette. This composites each swatch's tint over the dialog ground and checks
// the name at 4.5:1 there and on the plain field it gets while being renamed, in every palette.
test('Settings Workflow status names clear AA on their chip for every swatch in every palette', () => {
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const fallback = /function _workflowSwatch\(color\)\s*\{\s*return WORKFLOW_COLOR_SWATCHES\[color\] \|\| '([^']+)';/.exec(BOARD);
  assert.ok(fallback, 'task-board.js _workflowSwatch() fallback not found');
  const swatches = [...Object.entries(WORKFLOW_COLOR_SWATCHES), ['unknown token', fallback[1]]];

  const CHIP = '.settings-wf-chip';
  const NAME = '.settings-wf-chip-name';
  const tint = /^color-mix\(in srgb, (.+) (\d+(?:\.\d+)?)%, transparent\)$/.exec(ruleValue(CHIP, 'background') ?? '');
  assert.ok(tint, `${CHIP} background is no longer a translucent color-mix() tint`);
  assert.match(tint[1], /^var\(--wf-color\b/, 'the chip tint must stay the row swatch');
  assert.match(ruleValue('.settings-wf-chip-color', 'background') ?? '', /^var\(--wf-color\b/, 'the colour dot must stay the row swatch');

  for (const { id, values } of themePalettes()) {
    const dark = darkIds.has(id);
    const value = (sel, prop) => (dark && ruleValue(`.theme-dark ${sel}`, prop)) || ruleValue(sel, prop);
    const palette = layeredPalette(id, values, darkIds);
    const dialog = resolveColor(ruleValue('.settings-panel', 'background'), palette);
    for (const [name, swatch] of swatches) {
      const v = { ...palette, '--wf-color': swatch, '--wf-ink': value(CHIP, '--wf-ink') };
      const ink = resolveColor(value(NAME, 'color'), v);
      for (const [ground, bg] of [
        ['tinted chip', mixHex(resolveColor(tint[1], v), dialog, Number(tint[2]))],
        ['rename field', resolveColor(value(`${NAME}:focus`, 'background'), v)],
      ]) {
        const ratio = contrastRatio(ink, bg);
        assert.ok(ratio >= 4.5, `${id} ${name} status name on its ${ground} is ${ratio.toFixed(2)}:1; expected at least 4.5:1`);
      }
    }
  }
});

// (TPT9118) Status pills: the board card's status select, the .status chip (chat proposal cards,
// card previews, the parent-task pane, the manual-task preview), the to-do drawer's select and the
// Task Edit header select. Each tints its --status-color swatch (set inline from statusColor()) and
// paints the name in an ink derived from it; the old ink, the swatch 65% toward black, sat under
// 4.5:1 on its own tint in every light palette. The tint is mixed into an opaque --c-bg-card, so the
// pill's ground is the same on open and closed cards, proposal tints and the modal header. This
// checks every swatch, plus each rule's own var() fallback, on that ground in every palette.
test('status pill names clear AA on their tint for every swatch in every palette', () => {
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const PILLS = ['.status-select', '.card-status-select', '.drawer-status', '.status', '.modal-top-bar .modal-status-select'];
  const TINT = /^color-mix\(in srgb, var\(--status-color, #[0-9a-f]{3,6}\) \d+(?:\.\d+)?%, var\(--c-bg-card\)\)$/i;

  for (const { id, values } of themePalettes()) {
    const dark = darkIds.has(id);
    const value = (sel, prop) => (dark && ruleValue(`.theme-dark ${sel}`, prop)) || ruleValue(sel, prop);
    const palette = layeredPalette(id, values, darkIds);
    for (const pill of PILLS) {
      const bgExpr = value(pill, 'background-color');
      const inkExpr = value(pill, 'color');
      assert.ok(bgExpr && inkExpr, `${id} ${pill} has no background-color or color rule`);
      assert.match(bgExpr, TINT, `${id} ${pill} must tint --status-color into the opaque --c-bg-card`);
      assert.match(inkExpr, /var\(--status-color\b/, `${id} ${pill} ink must stay derived from the swatch`);
      const fallbacks = new Set([...`${bgExpr} ${inkExpr}`.matchAll(/var\(--status-color, (#[0-9a-f]{3,6})\)/gi)].map((m) => m[1]));
      const cases = [
        ...Object.entries(WORKFLOW_COLOR_SWATCHES).map(([name, swatch]) => [name, { ...palette, '--status-color': swatch }]),
        ...[...fallbacks].map((hex) => [`unset --status-color (${hex})`, palette]),
      ];
      for (const [name, v] of cases) {
        const ratio = contrastRatio(resolveColor(inkExpr, v), resolveColor(bgExpr, v));
        assert.ok(ratio >= 4.5, `${id} ${pill} ${name} status name is ${ratio.toFixed(2)}:1 on its tint; expected at least 4.5:1`);
      }
    }
  }
});

// (TPT9120) Status select chevrons. The board card's select and the Task Edit header select drew
// their dropdown chevron as a data-URI stroke in a fixed #666, which cannot follow the theme: it sat
// at 1.01–2.36:1 on the pill in every dark palette, under the 3:1 WCAG 1.4.11 asks of a graphic that
// identifies a control. The chevron is now two gradient strokes in currentColor, the pill's ink.
// The first test resolves every colour a chevron paints (gradient stops, or a data-URI's stroke and
// fill) and needs 3:1 on the pill fill for every swatch and fallback in every palette. Contextual
// rules (hover controls, phone width, :disabled, .theme-dark) may move or remove the strokes, but may
// only draw in currentColor, and must give each stroke its own background-position: a single
// position stacks both arms on one spot.
const CHEVRON_PILLS = ['.status-select', '.card-status-select', '.modal-top-bar .modal-status-select'];

// The chevron pill a selector targets, or null.
function chevronPillOf(selector) {
  if (/\.modal-status-select(?![\w-])/.test(selector)) {
    return /\.modal-top-bar(?![\w-])/.test(selector) ? '.modal-top-bar .modal-status-select' : null;
  }
  if (/\.card-status-select(?![\w-])/.test(selector)) return '.card-status-select';
  if (/\.status-select(?![\w-])/.test(selector)) return '.status-select';
  return null;
}

// Top-level whitespace-separated tokens of a CSS value; parenthesised groups stay whole.
function valueTokens(text) {
  const out = [];
  let depth = 0;
  let token = '';
  for (const ch of text.trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && /\s/.test(ch)) {
      if (token) out.push(token);
      token = '';
    } else {
      token += ch;
    }
  }
  if (token) out.push(token);
  return out;
}

// The colours a background-image value paints: gradient colour stops, and a data-URI SVG's stroke
// and fill attributes. `transparent` and `none` paint nothing and are left out.
function imagePaints(image) {
  const paints = [];
  for (const layer of splitArgs(image)) {
    const fn = /^([\w-]+)\(([\s\S]*)\)$/.exec(layer);
    assert.ok(fn, `unreadable background-image layer: ${layer}`);
    if (fn[1] === 'url') {
      const svg = decodeURIComponent(fn[2].trim().replace(/^(["'])([\s\S]*)\1$/, '$2'));
      for (const m of svg.matchAll(/\b(?:stroke|fill)=["']([^"']+)["']/g)) {
        if (m[1] !== 'none') paints.push({ color: m[1], image: true });
      }
      continue;
    }
    assert.match(fn[1], /-gradient$/, `unsupported background-image layer: ${layer}`);
    for (const stop of splitArgs(fn[2])) {
      const [first] = valueTokens(stop);
      // A direction, angle or shape prelude, or a bare colour hint, is not a colour stop.
      if (/^(?:to|from|at|circle|ellipse|(?:closest|farthest)-(?:side|corner))$/.test(first)) continue;
      if (/^(?:-?[\d.]|calc\()/.test(first) || /^transparent$/i.test(first)) continue;
      paints.push({ color: first, image: false });
    }
  }
  return paints;
}

// One chevron paint's colour on a pill. currentColor is the pill's ink, except inside a data-URI SVG:
// an image cannot see the page's `color`, so its currentColor is the SVG's initial black.
function paintColor(paint, inkExpr, values) {
  if (/^currentcolor$/i.test(paint.color)) return paint.image ? '#000000' : resolveColor(inkExpr, values);
  return resolveColor(paint.color, values);
}

// The last `prop` a rule body declares, whitespace collapsed, or null.
function declaredValue(body, prop) {
  let value = null;
  for (const d of body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))) value = d[1].trim().replace(/\s+/g, ' ');
  return value;
}

// The background image a rule body sets: its background-image, else the url() and gradient layers of
// a background shorthand ('none' when it names none: the shorthand resets the image), else null.
function declaredImage(body) {
  const shorthand = declaredValue(body, 'background');
  return declaredValue(body, 'background-image')
    ?? (shorthand && (splitArgs(shorthand).flatMap((layer) => valueTokens(layer).filter((t) => /^(?:url|[\w-]*gradient)\(/.test(t))).join(', ') || 'none'));
}

test('status select chevrons clear 3:1 on the pill for every swatch in every palette', () => {
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  for (const { id, values } of themePalettes()) {
    const dark = darkIds.has(id);
    const value = (sel, prop) => (dark && ruleValue(`.theme-dark ${sel}`, prop)) || ruleValue(sel, prop);
    const palette = layeredPalette(id, values, darkIds);
    for (const pill of CHEVRON_PILLS) {
      const image = value(pill, 'background-image');
      assert.ok(image && image !== 'none', `${id} ${pill} lost its dropdown chevron`);
      const paints = imagePaints(image);
      assert.ok(paints.length, `${id} ${pill} chevron paints nothing`);
      const bgExpr = value(pill, 'background-color');
      const inkExpr = value(pill, 'color');
      const fallbacks = new Set([...`${bgExpr} ${inkExpr}`.matchAll(/var\(--status-color, (#[0-9a-f]{3,6})\)/gi)].map((m) => m[1]));
      const cases = [
        ...Object.entries(WORKFLOW_COLOR_SWATCHES).map(([name, swatch]) => [name, { ...palette, '--status-color': swatch }]),
        ...[...fallbacks].map((hex) => [`unset --status-color (${hex})`, palette]),
      ];
      for (const [name, v] of cases) {
        const fill = resolveColor(bgExpr, v);
        for (const paint of paints) {
          const ratio = contrastRatio(paintColor(paint, inkExpr, v), fill);
          assert.ok(ratio >= 3, `${id} ${pill} ${name} chevron (${paint.color}) is ${ratio.toFixed(2)}:1 on the pill; expected at least 3:1`);
        }
      }
    }
  }
});

test('status select chevron rules draw in currentColor and position every stroke', () => {
  const strokes = Object.fromEntries(CHEVRON_PILLS.map((pill) => [pill, splitArgs(ruleValue(pill, 'background-image') ?? 'none').length]));
  let checked = 0;
  for (const { parts, body } of CLEAN_RULES) {
    for (const selector of parts) {
      const pill = chevronPillOf(selector);
      if (!pill) continue;
      const image = declaredImage(body);
      if (image === 'none') {
        assert.match(selector, /:disabled\b/, `${selector} removes the status select chevron; only the :disabled state may`);
      } else if (image && !CHEVRON_PILLS.includes(selector)) {
        for (const paint of imagePaints(image)) {
          assert.ok(!paint.image && /^currentcolor$/i.test(paint.color), `${selector} draws its chevron in ${paint.color}; a contextual chevron rule must use currentColor (the pill ink)`);
        }
      }
      const position = declaredValue(body, 'background-position');
      if (position) {
        checked++;
        assert.equal(splitArgs(position).length, strokes[pill], `${selector} background-position "${position}" must give each of the ${strokes[pill]} chevron strokes its own position`);
      }
    }
  }
  assert.ok(checked >= 4, `expected the base, hover-controls, modal and phone-width chevron positions; found ${checked}`);
  assert.equal(ruleValue('.modal-top-bar .modal-status-select:disabled', 'background-image'), 'none', 'the read-only header select must keep hiding its chevron');
});

// (TPT9124) Settings dialog select chevrons. The dialog's row selects (.settings-row-control >
// select) and the Workflow add form's colour select drew the same fixed-#666 data-URI chevron as the
// status selects, at 2.18–2.97:1 on their --c-bg field in seven dark palettes. They now use the
// TPT9120 strokes in currentColor, the field's own text colour. The first test needs every chevron
// paint to be currentColor and to clear 3:1 on the field in every palette. The second covers every
// other rule that styles these selects (a state, a theme or width override, a select's own id): it
// may not remove or repaint the strokes, and a background-position must place each stroke.
const SETTINGS_SELECTS = ['.settings-row-control > select', '.settings-wf-add-color'];
const SETTINGS_SELECT_IDS = [...TEMPLATE.matchAll(/<select\b[^>]*\bid="(settings-[\w-]+)"/g)].map((m) => m[1]);

// Whether a selector styles a Settings select: its last compound names the colour select's class or
// one of the dialog's select ids, or is a `select` under a .settings-* or #settings-* ancestor.
function stylesSettingsSelect(selector) {
  const subject = lastCompound(selector);
  if (/\.settings-wf-add-color(?![\w-])/.test(subject)) return true;
  if (SETTINGS_SELECT_IDS.some((id) => new RegExp(`#${id}(?![\\w-])`).test(subject))) return true;
  return /^select(?![\w-])/.test(subject) && /[.#]settings-[\w-]/.test(selector.slice(0, -subject.length));
}

// A Settings chevron paint as a failure message names it. Inside a data-URI image even currentColor
// is not the field's colour (see paintColor()).
const settingsPaintLabel = (paint) => (paint.image ? `${paint.color} inside a data-URI image` : paint.color);
const SETTINGS_PAINT_RULE = "it must be a currentColor gradient stroke (the field's text colour)";

test('Settings select chevrons paint only currentColor and clear 3:1 on the field in every palette', () => {
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  for (const { id, values } of themePalettes()) {
    const dark = darkIds.has(id);
    const value = (sel, prop) => (dark && ruleValue(`.theme-dark ${sel}`, prop)) || ruleValue(sel, prop);
    const palette = layeredPalette(id, values, darkIds);
    for (const sel of SETTINGS_SELECTS) {
      const image = value(sel, 'background-image');
      assert.ok(image && image !== 'none', `${id} ${sel} lost its dropdown chevron`);
      const paints = imagePaints(image);
      assert.ok(paints.length, `${id} ${sel} chevron paints nothing`);
      const bgExpr = value(sel, 'background-color');
      const inkExpr = value(sel, 'color');
      assert.ok(bgExpr && inkExpr, `${id} ${sel} has no background-color or color rule`);
      const field = resolveColor(bgExpr, palette);
      for (const paint of paints) {
        assert.ok(!paint.image && /^currentcolor$/i.test(paint.color), `${id} ${sel} chevron paints ${settingsPaintLabel(paint)}; ${SETTINGS_PAINT_RULE}`);
        const ratio = contrastRatio(paintColor(paint, inkExpr, palette), field);
        assert.ok(ratio >= 3, `${id} ${sel} chevron is ${ratio.toFixed(2)}:1 on the field; expected at least 3:1`);
      }
    }
  }
});

test('no rule removes, repaints or stacks the Settings select chevron strokes', () => {
  assert.ok(SETTINGS_SELECT_IDS.includes('settings-theme-select'), 'template.html Settings select ids not found');
  const [strokes, ...others] = SETTINGS_SELECTS.map((sel) => splitArgs(ruleValue(sel, 'background-image') ?? 'none').length);
  assert.ok(others.every((n) => n === strokes), 'the Settings selects must share one chevron');
  let checked = 0;
  for (const { parts, body } of CLEAN_RULES) {
    for (const selector of parts) {
      if (!stylesSettingsSelect(selector)) continue;
      const image = declaredImage(body);
      assert.notEqual(image, 'none', `${selector} removes the Settings select chevron`);
      for (const paint of image ? imagePaints(image) : []) {
        assert.ok(!paint.image && /^currentcolor$/i.test(paint.color), `${selector} draws the Settings select chevron in ${settingsPaintLabel(paint)}; ${SETTINGS_PAINT_RULE}`);
      }
      const position = declaredValue(body, 'background-position');
      if (position) {
        checked++;
        assert.equal(splitArgs(position).length, strokes, `${selector} background-position "${position}" must give each of the ${strokes} chevron strokes its own position`);
      }
    }
  }
  assert.ok(checked >= SETTINGS_SELECTS.length, `expected a chevron position for each Settings select; found ${checked}`);
});

// Forced colours (Windows contrast themes) compute a gradient background-image to none, so the
// strokes vanish there. Each Settings select must hand the arrow back to the native control inside
// an @media (forced-colors: active) block.
const UNCOMMENTED_CSS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

// Every innermost rule of the sheet, comments stripped, with its source offset. `forced` marks a rule
// inside an @media (forced-colors: active) block, nested media queries included.
function sheetRules() {
  const css = UNCOMMENTED_CSS;
  const blocks = [];
  for (const m of css.matchAll(/@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{/g)) {
    const start = m.index + m[0].length;
    let end = start;
    for (let depth = 1; end < css.length && depth; end++) depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0;
    blocks.push([start, end]);
  }
  return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({
    offset: m.index,
    parts: splitArgs(m[1].trim()).map((p) => p.replace(/\s+/g, ' ')),
    body: m[2],
    forced: blocks.some(([start, end]) => m.index >= start && m.index < end),
  }));
}

// The last appearance a forced-colours block gives each selector, as { value, offset }.
function forcedAppearance() {
  const out = new Map();
  for (const { offset, parts, body, forced } of sheetRules()) {
    const value = forced && declaredValue(body, 'appearance');
    if (value) for (const part of parts) out.set(part, { value, offset });
  }
  return out;
}

test('Settings selects get the native arrow back under forced colours', () => {
  const native = forcedAppearance();
  for (const sel of SETTINGS_SELECTS) {
    assert.equal(native.get(sel)?.value, 'auto', `${sel} must set appearance: auto under @media (forced-colors: active), where its gradient chevron is dropped`);
  }
});

// (TPT9127) The status selects' TPT9120 strokes are gradients too, so they vanish under forced colours
// the same way. Each status select must set appearance: auto in a forced-colours block, and that rule
// must win the cascade: no other rule may set the select's appearance at a higher specificity, or at
// the same specificity later in the sheet. The read-only header select shows no arrow outside forced
// colours, so the block keeps it at appearance: none.
test('status selects get the native arrow back under forced colours', () => {
  const native = forcedAppearance();
  const rules = sheetRules();
  let compared = 0;
  for (const pill of CHEVRON_PILLS) {
    const own = native.get(pill);
    assert.equal(own?.value, 'auto', `${pill} must set appearance: auto under @media (forced-colors: active), where its gradient chevron is dropped`);
    for (const { offset, parts, body, forced } of rules) {
      if (forced || !declaredValue(body, 'appearance')) continue;
      for (const selector of parts) {
        if (chevronPillOf(selector) !== pill || /:disabled\b/.test(selector)) continue;
        compared++;
        const order = compareSpecificity(specificity(selector), specificity(pill));
        assert.ok(order < 0 || (order === 0 && offset < own.offset), `${selector} sets the appearance of ${pill} after or above its forced-colours rule, so the native arrow loses the cascade`);
      }
    }
  }
  assert.ok(compared >= CHEVRON_PILLS.length, `expected each status select's own appearance: none rule; compared ${compared}`);
  const readOnly = '.modal-top-bar .modal-status-select:disabled';
  assert.equal(native.get(readOnly)?.value, 'none', `${readOnly} must keep appearance: none under forced colours, as the read-only header select shows no arrow`);
});

// (TPT9130) The proposal card's sprint select draws its chevron as TPT299 gradient triangles, which
// vanish under forced colours too. It must set appearance: auto in a forced-colours block whose rule
// wins the cascade over every other appearance rule on the select, and give back the right padding
// the triangles needed, since the native control reserves its own room for the arrow.
test('the proposal sprint select gets the native arrow back under forced colours', () => {
  const sel = '.preview-step-select';
  const own = forcedAppearance().get(sel);
  assert.equal(own?.value, 'auto', `${sel} must set appearance: auto under @media (forced-colors: active), where its gradient chevron is dropped`);
  const rules = sheetRules();
  let compared = 0;
  for (const { offset, parts, body, forced } of rules) {
    if (forced || !declaredValue(body, 'appearance')) continue;
    for (const selector of parts) {
      if (!/\.preview-step-select(?![\w-])/.test(lastCompound(selector))) continue;
      compared++;
      const order = compareSpecificity(specificity(selector), specificity(sel));
      assert.ok(order < 0 || (order === 0 && offset < own.offset), `${selector} sets the appearance of ${sel} after or above its forced-colours rule, so the native arrow loses the cascade`);
    }
  }
  assert.ok(compared >= 1, `expected the sprint select's own appearance: none rule; compared ${compared}`);
  const meta = '.card.preview-card .card-preview-meta .preview-step-select';
  const padding = rules.filter((r) => r.forced && r.parts.includes(meta)).map((r) => declaredValue(r.body, 'padding-right')).filter(Boolean).pop();
  assert.equal(padding, 'var(--card-ctrl-pad-x)', `${meta} must drop its right padding to the .card-ctl inline padding under forced colours`);
});

// (TPT9131) The board's Status and People filter chevrons are mask-image ::after boxes painted with
// background-color, which forced colours turn into Canvas, the ground colour. Each chevron must take
// a foreground system colour in a forced-colours block, and for every other rule that paints the
// chevron (the .active and :hover states included) a forced-colours rule must win the cascade: a
// higher specificity, or the same specificity later in the sheet.
test('the board filter chevrons keep a system colour under forced colours', () => {
  const SYSTEM_INK = /^(ButtonText|CanvasText|FieldText)$/i;
  const rules = sheetRules();
  const paint = (body) => declaredValue(body, 'background-color') ?? declaredValue(body, 'background');
  for (const name of ['status', 'people']) {
    const chevron = new RegExp(`\\.${name}-filter-wrap(?![\\w-])[^ >+~]*::after$`);
    const forced = [];
    let compared = 0;
    for (const { offset, parts, body, forced: inForced } of rules) {
      const value = paint(body);
      if (!value) continue;
      for (const selector of parts) {
        if (!chevron.test(lastCompound(selector))) continue;
        if (inForced) {
          assert.match(value, SYSTEM_INK, `${selector} paints the chevron ${value} under forced colours; expected ButtonText, CanvasText or FieldText`);
          forced.push({ selector, offset });
        }
      }
    }
    const base = `.${name}-filter-wrap::after`;
    assert.ok(forced.some((f) => f.selector === base), `${base} must take a system colour under @media (forced-colors: active), where its background-color is forced to Canvas`);
    for (const { offset, parts, body, forced: inForced } of rules) {
      if (inForced || !paint(body)) continue;
      for (const selector of parts) {
        if (!chevron.test(lastCompound(selector))) continue;
        compared++;
        const wins = forced.some((f) => {
          const order = compareSpecificity(specificity(f.selector), specificity(selector));
          return order > 0 || (order === 0 && f.offset > offset);
        });
        assert.ok(wins, `${selector} paints the ${name} filter chevron after or above every forced-colours rule, so the chevron vanishes under forced colours`);
      }
    }
    assert.ok(compared >= 2, `expected the ${name} filter chevron's rest and .active/:hover paint rules; compared ${compared}`);
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

// (TPT9139) The terminal header's permission-mode control: its pending and error states paint
// from local tokens over the theme variables (.session-mode in styles.css). Text clears 4.5:1 on
// its own tinted ground (tints composited over the card) and the state borders clear 3:1 against
// the card, in every palette; the static chip's muted text clears 4.5:1 on the card.
test('session-mode pending and error tokens clear AA contrast in every palette', () => {
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const token = (name) => {
    const value = ruleValue('.session-mode', name);
    assert.ok(value, `.session-mode has no ${name}`);
    assert.match(value, /^var\(--c-[\w-]+\)$/, `${name} must come from a theme variable, not a literal`);
    return value;
  };
  // A token that resolves to an rgba() tint is composited over the card it sits on.
  const paint = (expr, values, ground) => {
    const raw = /^var\((--[\w-]+)\)$/.exec(expr);
    const value = raw ? values[raw[1]] : expr;
    return /^rgba\(/.test(value ?? '') ? overRgba(value, ground) : resolveColor(expr, values);
  };
  const chipColor = ruleValue('.session-mode-chip', 'color');
  assert.equal(chipColor, 'var(--c-text-muted)');
  for (const { id, values: own } of themePalettes()) {
    const values = layeredPalette(id, own, darkIds);
    const card = resolveColor('var(--c-bg-card)', values);
    for (const [state, minimum] of [['pending', 4.5], ['error', 4.5]]) {
      const bg = paint(token(`--session-mode-${state}-bg`), values, card);
      const fg = paint(token(`--session-mode-${state}-fg`), values, bg);
      const border = paint(token(`--session-mode-${state}-border`), values, card);
      const text = contrastRatio(fg, bg);
      assert.ok(text >= minimum, `${id} ${state} text is ${text.toFixed(2)}:1; expected at least ${minimum}:1`);
      const edge = contrastRatio(border, card);
      assert.ok(edge >= 3, `${id} ${state} border is ${edge.toFixed(2)}:1 on the card; expected at least 3:1`);
    }
    const chip = contrastRatio(resolveColor(chipColor, values), card);
    assert.ok(chip >= 4.5, `${id} static mode chip text is ${chip.toFixed(2)}:1; expected at least 4.5:1`);
  }
  for (const state of ['pending', 'error']) {
    const rule = ruleValue(`.session-mode-${state} .permission-mode-select-trigger`, 'background');
    assert.equal(rule, `var(--session-mode-${state}-bg)`, `.session-mode-${state} paints from its token`);
    assert.equal(ruleValue(`.session-mode-${state} .permission-mode-select-trigger`, 'color'), `var(--session-mode-${state}-fg)`);
  }
});

// (TPT9165) The voice recording widget, in every palette: its timer and hint text clear 4.5:1
// on the card; the wave's gradient ends (which double as the recording dot) and the Stop glyph
// on its own tinted ground clear the 3:1 non-text minimum. The canvas reads the gradient ends with
// getPropertyValue(), so they must stay plain hexes in every theme block.
test('voice recording widget text and graphics clear contrast on the card in every palette', () => {
  const boardSet = /_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD);
  assert.ok(boardSet, 'task-board.js has no _DARK_THEMES set');
  const darkIds = new Set([...boardSet[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  assert.match(cssBlock('\\.voice-rec-dot'), /background:\s*var\(--c-voice-wave-to\)/, 'the dot paints with the wave end');
  for (const { id, values: own } of themePalettes()) {
    const dark = darkIds.has(id);
    const values = layeredPalette(id, own, darkIds);
    const card = resolveColor(ruleValue('#voice-rec-toast', 'background'), values);
    for (const selector of ['.voice-rec-timer', '.voice-rec-hint']) {
      const ratio = contrastRatio(resolveColor(ruleValue(selector, 'color'), values), card);
      assert.ok(ratio >= 4.5, `${id} ${selector} is ${ratio.toFixed(2)}:1 on the card; expected at least 4.5:1`);
    }
    for (const token of ['--c-voice-wave-from', '--c-voice-wave-to']) {
      assert.match(values[token] ?? '', /^#[0-9a-f]{6}$/i, `${id} ${token} must be a plain hex the canvas can parse`);
      const ratio = contrastRatio(values[token], card);
      assert.ok(ratio >= 3, `${id} ${token} is ${ratio.toFixed(2)}:1 on the card; expected at least 3:1`);
    }
    const stopBg = resolveColor((dark && ruleValue('.theme-dark .voice-rec-stop', 'background')) || ruleValue('.voice-rec-stop', 'background'), values);
    const glyph = contrastRatio(resolveColor(ruleValue('.voice-rec-stop', 'color'), values), stopBg);
    assert.ok(glyph >= 3, `${id} Stop glyph is ${glyph.toFixed(2)}:1 on its button; expected at least 3:1`);
  }
});
