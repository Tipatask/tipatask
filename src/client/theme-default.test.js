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
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
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

test('accent controls consume --c-on-primary for text, icons, dots and chevrons', () => {
  for (const selector of [
    '\\.btn-chat-send',
    '\\.modal-buttons \\.btn-confirm',
    '\\.modal-top-bar button\\.btn-modal-save',
    '\\.agent-badge--human',
    '\\.member-badge--initials',
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
