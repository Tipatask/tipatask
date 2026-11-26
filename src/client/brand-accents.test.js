// (TPT9422) Brand colors as the window's accent colors: the derived tokens clear the same
// contrast floors theme-default.test.js holds the palettes to, on every palette, for any brand
// color; the window state, the pre-paint cache and template.html's pre-paint script agree.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  BRAND_ACCENT_PROPS, BRAND_ACCENT_STORAGE_KEY, brandAccentStorageKey, brandAccentTokens, colorDistance, contrastRatio,
  followBrandProject, getBrandColors, mix, paintBrandAccents, parseColor, setBrandColors,
} from './brand-accents.js';
import { identityBrandColors, normalizeBrandColors, sameBrandColors } from '../brand-colors.mjs';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8');
const CSS = read('styles.css');
const TEMPLATE = read('template.html');
const BOARD = read('task-board.js');

const tokensOf = block => Object.fromEntries([...block.replace(/\/\*[\s\S]*?\*\//g, '')
  .matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const DARK_IDS = new Set([.../_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(BOARD)[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
const PALETTES = [...CSS.matchAll(/^\s*\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/gm)].map(([, id, block]) => {
  const v = tokensOf(block);
  return { id, palette: { dark: DARK_IDS.has(id), text: v['--c-text'], card: v['--c-bg-card'], bg: v['--c-bg'],
    subNav: v['--c-bg-sub-nav'], navBg: v['--c-nav-bg'], tier: v['--c-bg-tier'] } };
});

// Brand colors across the hue circle and lightness range, plus the hard cases: white, black,
// near-palette grounds, pale and neon colors.
const SAMPLES = ['#0E8377', '#FFCC00', '#FF6600', '#1B2A4A', '#4FC3F7', '#E53935', '#FFFFFF', '#000000', '#7C3AED',
  '#22C55E', '#F4F1EA', '#2A2A28', '#808080', '#FF00FF', '#00FFFF', '#FFF3B0', '#3B0A45', '#14B8A6', '#B45309', '#9CA3AF'];
for (let h = 0; h < 360; h += 30) {
  for (const l of [25, 50, 75]) {
    const c = (1 - Math.abs(2 * l / 100 - 1)) * 0.9;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l / 100 - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    SAMPLES.push('#' + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase());
  }
}

const parse = value => {
  const color = parseColor(value);
  assert.ok(color, `not a colour: ${value}`);
  return color;
};
const over = (rgba, ground) => {
  const c = parse(rgba);
  return mix(c, parse(ground), c.a);
};

test('brand color lists are uppercase, distinct, valid and at most three; identities read old and new APIs', () => {
  assert.deepEqual(normalizeBrandColors(null), []);
  assert.deepEqual(normalizeBrandColors(['#0e8377', '#0E8377', 'teal', '#12345', '#ff6600', '#7c3aed', '#000000']),
    ['#0E8377', '#FF6600', '#7C3AED']);
  assert.deepEqual(identityBrandColors(null), null, 'no identity is unknown, not "none selected"');
  assert.deepEqual(identityBrandColors({ brand_colors: [] }), []);
  assert.deepEqual(identityBrandColors({ brand_color: '#123abc' }), ['#123ABC'], 'an API before the list sends one color');
  assert.deepEqual(identityBrandColors({ brand_color: null }), []);
  assert.deepEqual(identityBrandColors({ brand_color: '#111111', brand_colors: ['#222222'] }), ['#222222'], 'the list wins');
  assert.equal(sameBrandColors(['#aaaaaa'], ['#AAAAAA']), true);
  assert.equal(sameBrandColors(['#AAAAAA', '#BBBBBB'], ['#BBBBBB', '#AAAAAA']), false, 'order is meaning: first = primary');
});

test('no brand colors derive no tokens: the palette keeps its own accents', () => {
  assert.deepEqual(brandAccentTokens([], PALETTES[0].palette), {});
  assert.deepEqual(brandAccentTokens(null, PALETTES[0].palette), {});
});

test('every derived token clears the palette contrast floors on every palette for any brand color', () => {
  assert.ok(PALETTES.length >= 20, 'palettes parsed from styles.css');
  for (const { id, palette } of PALETTES) {
    for (const color of SAMPLES) {
      const t = brandAccentTokens([color, '#C2185B', '#3E2723'], palette);
      assert.equal(Object.keys(t).length, BRAND_ACCENT_PROPS.length, `${id} ${color}: one value per accent token`);
      const at = `${id} ${color}`;
      for (const [name, value] of Object.entries(t)) {
        assert.match(value, /^(#[0-9A-F]{6}|rgba\(\d{1,3},\d{1,3},\d{1,3},0\.\d+\))$/, `${at} ${name} is not a plain colour: ${value}`);
      }
      const on = parse(t['--c-on-primary']);
      const fill = parse(t['--c-primary']);
      for (const name of ['--c-primary', '--c-primary-hover']) {
        const ratio = contrastRatio(on, parse(t[name]));
        assert.ok(ratio >= 4.5, `${at}: button text on ${name} is ${ratio.toFixed(2)}:1`);
      }
      assert.ok(colorDistance(fill, parse(t['--c-primary-hover'])) >= 0.01, `${at}: hover looks like the fill`);
      for (const ground of ['card', 'bg', 'navBg', 'subNav']) {
        assert.ok(colorDistance(fill, parse(palette[ground])) >= 0.1, `${at}: the fill disappears into ${ground}`);
      }
      const light = ground => over(t['--c-primary-light'], palette[ground]);
      const textGrounds = {
        card: parse(palette.card), bg: parse(palette.bg), subNav: parse(palette.subNav), nav: parse(palette.navBg), tier: parse(palette.tier),
        'light on card': light('card'), 'light on bg': light('bg'), 'light on sub-nav': light('subNav'), 'light on nav': light('navBg'),
        'lighter on card': over(t['--c-primary-lighter'], palette.card),
      };
      for (const [label, ground] of Object.entries(textGrounds)) {
        const ratio = contrastRatio(parse(t['--c-primary-text']), ground);
        assert.ok(ratio >= 4.5, `${at}: --c-primary-text on ${label} is ${ratio.toFixed(2)}:1`);
        if (label === 'tier') continue;
        for (const name of ['--c-primary-border', '--c-accent-2-border', '--c-accent-3-border']) {
          const ui = contrastRatio(parse(t[name]), ground);
          assert.ok(ui >= 3, `${at}: ${name} on ${label} is ${ui.toFixed(2)}:1`);
        }
      }
      const activeBg = parse(t['--left-nav-active-bg']);
      const activeFg = parse(t['--left-nav-active-fg']);
      assert.ok(contrastRatio(activeFg, activeBg) >= 4.5, `${at}: selected nav label ${contrastRatio(activeFg, activeBg).toFixed(2)}:1`);
      assert.ok(contrastRatio(activeFg, parse(palette.card)) >= 3, `${at}: selected nav bar on the card`);
    }
  }
});

test('a brand color that already passes is used exactly; white button text is kept where it can be', () => {
  const paper = PALETTES.find(p => p.id === 'paper').palette;
  const ink = PALETTES.find(p => p.id === 'ink').palette;
  for (const palette of [paper, ink]) {
    const violet = brandAccentTokens(['#7c3aed'], palette);
    assert.equal(violet['--c-primary'], '#7C3AED');
    assert.equal(violet['--c-on-primary'], '#FFFFFF');
    // A light brand color keeps its fill under dark text instead of turning muddy.
    const yellow = brandAccentTokens(['#FFCC00'], palette);
    assert.equal(yellow['--c-primary'], '#FFCC00');
    assert.ok(contrastRatio(parse(yellow['--c-on-primary']), parse('#FFCC00')) >= 4.5);
    assert.notEqual(yellow['--c-on-primary'], '#FFFFFF');
  }
  // A mid red needs only a little shade for white text: still the brand's red.
  const red = brandAccentTokens(['#E53935'], paper);
  assert.equal(red['--c-on-primary'], '#FFFFFF');
  assert.ok(colorDistance(parse(red['--c-primary']), parse('#E53935')) < 0.05, red['--c-primary']);
  // Navy on ink and white on paper move off the surface just enough to read as an accent.
  assert.notEqual(brandAccentTokens(['#1B2A4A'], ink)['--c-primary'], '#1B2A4A');
  assert.notEqual(brandAccentTokens(['#FFFFFF'], paper)['--c-primary'], '#FFFFFF');
  // Accent text keeps the brand hue where the brand color itself clears 4.5:1.
  assert.equal(brandAccentTokens(['#1B2A4A'], paper)['--c-primary-text'], '#1B2A4A');
});

test('first color is the primary family, the others are the secondary accents in order', () => {
  const palette = PALETTES.find(p => p.id === 'paper').palette;
  const one = brandAccentTokens(['#0E8377'], palette);
  assert.equal(Object.keys(one).some(name => name.startsWith('--c-accent-')), false, 'one color: styles.css falls back to the primary');
  const two = brandAccentTokens(['#0E8377', '#ff6600'], palette);
  assert.equal(two['--c-accent-2'], '#FF6600');
  assert.equal(Object.hasOwn(two, '--c-accent-3'), false, 'accent-3 falls back to accent-2 in styles.css');
  const three = brandAccentTokens(['#0E8377', '#FF6600', '#7C3AED'], palette);
  assert.equal(three['--c-accent-2'], '#FF6600');
  assert.equal(three['--c-accent-3'], '#7C3AED');
  for (const name of Object.keys(three)) assert.ok(BRAND_ACCENT_PROPS.includes(name), `${name} is not cleared on reset`);
  assert.deepEqual(brandAccentTokens(['#0e8377', '#FF6600', '#7C3AED'], palette), three, 'pure and deterministic');
});

test('styles.css falls the secondary accents back to the primary accent', () => {
  const root = tokensOf(/:root\s*\{([^}]*)\}/.exec(CSS)[1]);
  assert.equal(root['--c-accent-2'], 'var(--c-primary)');
  assert.equal(root['--c-accent-2-border'], 'var(--c-primary-border)');
  assert.equal(root['--c-accent-3'], 'var(--c-accent-2)');
  assert.equal(root['--c-accent-3-border'], 'var(--c-accent-2-border)');
});

function fakeRoot(theme = 'paper', dark = false) {
  const props = new Map();
  const attrs = new Map([['data-theme', theme]]);
  return {
    props, attrs,
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) },
    getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: k => attrs.delete(k),
    classList: { contains: c => c === 'theme-dark' && dark },
  };
}

function fakeStorage() {
  const map = new Map();
  return { map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}

test('painting sets the tokens inline, marks the root, caches them per project; clearing restores the palette', () => {
  const root = fakeRoot();
  const storage = fakeStorage();
  const palette = PALETTES.find(p => p.id === 'paper').palette;
  const tokens = setBrandColors(['#ff6600', '#0E8377'], { root, storage, palette });
  assert.deepEqual(getBrandColors(), ['#FF6600', '#0E8377']);
  assert.equal(root.props.get('--c-primary'), tokens['--c-primary']);
  assert.equal(root.props.get('--c-accent-2'), '#0E8377');
  assert.equal(root.attrs.get('data-brand-accents'), '2');
  const cached = JSON.parse(storage.map.get(BRAND_ACCENT_STORAGE_KEY));
  assert.deepEqual(cached, { theme: 'paper', count: 2, colors: ['#FF6600', '#0E8377'], tokens });

  // A theme change repaints for the new palette and re-keys the cache to it.
  root.attrs.set('data-theme', 'ink');
  const ink = PALETTES.find(p => p.id === 'ink').palette;
  const dark = paintBrandAccents({ root, storage, palette: ink });
  assert.equal(JSON.parse(storage.map.get(BRAND_ACCENT_STORAGE_KEY)).theme, 'ink');
  assert.deepEqual(Object.fromEntries(root.props), dark);

  setBrandColors([], { root, storage, palette: ink });
  assert.equal(root.props.size, 0, 'every override is removed');
  assert.equal(root.attrs.has('data-brand-accents'), false);
  assert.equal(storage.map.has(BRAND_ACCENT_STORAGE_KEY), false);
});

test('a project switch shows only what was painted for the new project, never the previous brand', () => {
  const root = fakeRoot();
  const storage = fakeStorage();
  const palette = PALETTES.find(p => p.id === 'paper').palette;
  const location = globalThis.location;
  try {
    globalThis.location = { search: '?projectPath=%2Fwork%2Falpha' };
    assert.equal(brandAccentStorageKey(), `${BRAND_ACCENT_STORAGE_KEY}:/work/alpha`);
    setBrandColors(['#FF6600'], { root, storage, palette });
    assert.equal(followBrandProject({ root, storage, palette }), false, 'same project: nothing to do');

    globalThis.location = { search: '?projectPath=%2Fwork%2Fbeta' };
    assert.equal(followBrandProject({ root, storage, palette }), true);
    assert.deepEqual(getBrandColors(), [], 'beta has nothing cached: palette accents, not alpha\'s');
    assert.equal(root.props.size, 0);

    globalThis.location = { search: '?projectPath=%2Fwork%2Falpha' };
    followBrandProject({ root, storage, palette });
    assert.deepEqual(getBrandColors(), ['#FF6600'], 'alpha comes back with its cached colors');
  } finally {
    if (location === undefined) delete globalThis.location;
    else globalThis.location = location;
  }
});

function prepaintSource() {
  const start = TEMPLATE.indexOf("var key = 'tiptask-brand-accents'");
  assert.ok(start !== -1, 'template.html has no brand accent pre-paint');
  const open = TEMPLATE.lastIndexOf('(function() {', start);
  const close = TEMPLATE.indexOf('})();', start) + '})();'.length;
  const scriptOpen = TEMPLATE.lastIndexOf('<script>', open);
  assert.ok(TEMPLATE.indexOf('</script>', scriptOpen) > close, 'the pre-paint runs in the head script, before the stylesheet');
  assert.ok(TEMPLATE.indexOf('tiptask-theme') < open, 'brand accents pre-paint after the theme is chosen');
  return TEMPLATE.slice(open, close);
}

function runPrepaint({ theme = 'paper', search = '', stored, throws = false }) {
  const root = fakeRoot(theme);
  const sandbox = {
    location: { search },
    URLSearchParams,
    JSON,
    String,
    localStorage: { getItem: key => { if (throws) throw new Error('blocked'); return stored?.[key] ?? null; } },
    document: { documentElement: root },
  };
  vm.runInNewContext(prepaintSource(), sandbox);
  return root;
}

test('pre-paint applies the cached tokens of this project window while its palette is the one painted', () => {
  const palette = PALETTES.find(p => p.id === 'paper').palette;
  const tokens = brandAccentTokens(['#FF6600', '#0E8377', '#7C3AED'], palette);
  const entry = JSON.stringify({ theme: 'paper', count: 3, colors: ['#FF6600', '#0E8377', '#7C3AED'], tokens });
  const key = brandAccentStorageKey('?projectPath=%2Fwork%2Falpha');

  const painted = runPrepaint({ search: '?projectPath=%2Fwork%2Falpha', stored: { [key]: entry } });
  assert.deepEqual(Object.fromEntries(painted.props), tokens, 'every derived token passes the pre-paint filters');
  assert.equal(painted.attrs.get('data-brand-accents'), '3');

  assert.equal(runPrepaint({ theme: 'ink', search: '?projectPath=%2Fwork%2Falpha', stored: { [key]: entry } }).props.size, 0,
    'tokens derived for another palette are not painted');
  assert.equal(runPrepaint({ search: '?projectPath=%2Fwork%2Fbeta', stored: { [key]: entry } }).props.size, 0,
    'another project window paints nothing of alpha');
  assert.equal(runPrepaint({ search: '', stored: { [BRAND_ACCENT_STORAGE_KEY]: entry } }).props.size, Object.keys(tokens).length,
    'browser mode (no project path) uses the plain key');
  assert.equal(runPrepaint({ throws: true }).props.size, 0, 'blocked storage paints the palette and does not throw');

  const hostile = JSON.stringify({ theme: 'paper', count: 1, tokens: { color: 'red', '--c-primary': 'url(x)', '--c-primary-hover': '#123456' } });
  const filtered = runPrepaint({ stored: { [BRAND_ACCENT_STORAGE_KEY]: hostile } });
  assert.deepEqual(Object.fromEntries(filtered.props), { '--c-primary-hover': '#123456' }, 'only accent tokens with plain colours');
});
