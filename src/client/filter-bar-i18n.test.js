import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9414) The board top nav's filter bar: the tag filter button, the search field, the Clear
// button and the refresh button were hard-coded English in template.html, so a Ukrainian,
// Chinese or Spanish project showed them untranslated beside localized controls. task-board.js
// renderFilterBar() now renders the bar through t(). These tests render the real function in
// every locale, bundled under happy-dom (sprint-order-switch.test.js's recipe) — no server, no
// network — and hold template.html's top nav to it.

const LANGS = ['en', 'uk', 'zh', 'es'];

let window, scratch, mod, app;
const globals = new Map();

function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

before(async () => {
  window = new Window({ url: 'http://localhost:4455/' });
  scratch = mkdtempSync(join(tmpdir(), 'tt-filter-bar-i18n-'));
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
    'FocusEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  for (const key of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, window[key].bind(window));
  }
  install('WebSocket', class { constructor() { this.readyState = 0; } send() {} close() {} });
  install('fetch', async (url) => { throw new Error(`Unexpected fetch: ${url}`); });
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    stdin: { contents: `export { default as state } from './src/client/state.js';
      export * as board from './src/client/task-board.js';
      export { LOCALES, setLocale } from './src/client/i18n.js';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    plugins: [{ name: 'terminal-double', setup(b) {
      b.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
      b.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
        export class FitAddon { fit() {} }
        export class Terminal { loadAddon() {} onData() {} open() {} write() {} dispose() {} }` }));
    } }],
  });
  const bundle = join(scratch, 'client.mjs');
  writeFileSync(bundle, result.outputFiles[0].contents);
  mod = await import(pathToFileURL(bundle).href);
});

after(async () => {
  mod?.setLocale('en');
  await window.happyDOM.abort();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  rmSync(scratch, { recursive: true, force: true });
});

// The board's default filter state: My Tasks, nothing narrowing.
function resetFilters() {
  Object.assign(mod.state, {
    activeTab: 'board', searchQuery: '', humanFilterActive: false, assigneeScope: 'me',
    statusFilter: new Set(), projectMembers: [], _lastVisibleTasks: [], subtaskStack: [],
  });
  mod.state.activeTagFilters.clear();
  mod.state.assigneeFilter.clear();
}

beforeEach(() => {
  resetFilters();
  mod.setLocale('en');
  document.body.innerHTML = '<div class="container" id="app"></div>';
  app = document.getElementById('app');
});

// What template.html's _loadAndRenderImpl() puts in the top nav on a tasks-section tab.
function renderBar() {
  app.innerHTML = mod.board.renderFilterBar(mod.board.computeAssigneeCounts([]), mod.board.computeStatusCounts([]));
}

// The four controls' texts as the user and a screen reader get them.
function labels() {
  const tag = app.querySelector('.btn-tag-filter');
  const refresh = app.querySelector('#btn-board-refresh');
  return {
    tagTitle: tag?.getAttribute('title'),
    tagName: tag?.getAttribute('aria-label'),
    placeholder: app.querySelector('.search-input')?.getAttribute('placeholder'),
    clear: app.querySelector('#search-reset-btn')?.textContent,
    refreshTitle: refresh?.getAttribute('title'),
    refreshName: refresh?.getAttribute('aria-label'),
  };
}

function expected(lang) {
  const table = mod.LOCALES[lang];
  return {
    tagTitle: table['filter.byTag'],
    tagName: table['filter.byTag'],
    placeholder: table['filter.searchPlaceholder'],
    clear: table['filter.clearAll'],
    refreshTitle: table['nav.refreshBoard'],
    refreshName: table['nav.refreshBoard'],
  };
}

test('the tag filter, search placeholder, Clear and refresh labels render in every locale', () => {
  const english = Object.values(expected('en'));
  for (const lang of LANGS) {
    mod.setLocale(lang);
    renderBar();
    const rendered = labels();
    assert.deepEqual(rendered, expected(lang), lang);
    for (const [control, text] of Object.entries(rendered)) assert.ok(text?.trim(), `${lang} ${control} is empty`);
    if (lang === 'en') continue;
    for (const [control, text] of Object.entries(rendered)) {
      assert.equal(english.includes(text), false, `${lang} ${control} is the English "${text}"`);
    }
    // Nor does the English text hide anywhere else in the bar's markup.
    for (const literal of ['Filter by tag', 'Search tasks', 'Clear search', '>Clear<', 'Refresh board']) {
      assert.equal(app.innerHTML.includes(literal), false, `${lang}: "${literal}" in the filter bar`);
    }
  }
});

test('a language change repaints the bar, and DOM-only filter refreshes never bring English back', () => {
  renderBar();
  assert.deepEqual(labels(), expected('en'));
  // Settings → General saves the language, calls setLocale() and dispatches tiptask:reload:
  // a full render, which rebuilds the bar.
  mod.setLocale('uk');
  renderBar();
  assert.deepEqual(labels(), expected('uk'));
  // A tag, a search phrase and a status change are patched onto the bar in place
  // (refreshFilterBarChrome(), updateSearchInputWidth()) — state only, never the labels.
  mod.state.activeTagFilters.add('ui');
  mod.state.searchQuery = 'needle';
  mod.state.statusFilter.add('pending');
  app.querySelector('.search-input').value = 'needle';
  mod.board.refreshFilterBarChrome(app);
  mod.board.updateSearchInputWidth();
  assert.deepEqual(labels(), expected('uk'));
  assert.equal(app.querySelector('.btn-tag-filter').classList.contains('active'), true);
  assert.equal(app.querySelector('.tag-filter-chips .tag-chip[data-tag="ui"]') !== null, true);
  assert.equal(app.querySelector('#search-reset-btn').disabled, false);
  assert.equal(app.querySelector('.search-clear-btn').hidden, false);
});

test('the search field fits its localized placeholder beside the localized Clear button', (t) => {
  // Layout stand-in for happy-dom, which measures nothing: 7px a character, and the Clear
  // button 25px wider than its label (padding and border).
  const proto = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
  const textPx = text => text.length * 7;
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get() {
    return this.id === 'search-reset-btn' ? textPx(this.textContent) + 25 : textPx(this.textContent || '');
  } });
  t.after(() => Object.defineProperty(proto, 'offsetWidth', original));
  const wrapWidth = () => parseFloat(app.querySelector('.search-input-wrap').style.width);
  const gap = 6;
  for (const lang of LANGS) {
    mod.setLocale(lang);
    renderBar();
    const input = app.querySelector('.search-input');
    mod.board.updateSearchInputWidth();
    const placeholder = mod.LOCALES[lang]['filter.searchPlaceholder'];
    const clear = textPx(mod.LOCALES[lang]['filter.clearAll']) + 25;
    const rest = wrapWidth();
    // At rest the field holds the whole placeholder and its paddings (40px) next to Clear,
    // never narrower than the bar's 180px layout width.
    assert.ok(rest - clear - gap >= textPx(placeholder) + 40, `${lang}: ${rest}px wrap clips "${placeholder}"`);
    assert.ok(rest >= 180, `${lang}: ${rest}px is under the 180px minimum`);
    // Typing a short phrase keeps the width; a longer one grows it, up to the 320px cap.
    input.value = 'ab';
    mod.board.updateSearchInputWidth();
    assert.equal(wrapWidth(), rest, `${lang}: typing a short phrase changes the width`);
    input.value = 'x'.repeat(24);
    mod.board.updateSearchInputWidth();
    assert.equal(wrapWidth(), Math.min(320, Math.max(rest, textPx(input.value) + 40 + 16 + clear + gap)), `${lang}: grows with the phrase`);
    input.value = 'x'.repeat(80);
    mod.board.updateSearchInputWidth();
    assert.equal(wrapWidth(), 320, `${lang}: capped`);
  }
});

// The render, the DOM-only chrome refresh and the search pass that runs after every full render
// all set Clear's disabled state; applySearchFilter() used to leave the All Tasks scope out, so
// a render under All Tasks enabled Clear and the pass right after disabled it again.
test('Clear is enabled exactly when there is a filter to reset, through every path that sets it', () => {
  const cases = [
    ['nothing narrowing', () => {}, true],
    ['blank search phrase', s => { s.searchQuery = '   '; }, true],
    ['search phrase', s => { s.searchQuery = 'needle'; }, false],
    ['tag', s => { s.activeTagFilters.add('ui'); }, false],
    ['Human Tasks', s => { s.humanFilterActive = true; }, false],
    ['All Tasks scope', s => { s.assigneeScope = 'all'; }, false],
    ['member', s => { s.assigneeFilter.add(3); }, false],
    ['status', s => { s.statusFilter.add('pending'); }, false],
  ];
  for (const [name, apply, disabled] of cases) {
    resetFilters();
    apply(mod.state);
    renderBar();
    const clear = app.querySelector('#search-reset-btn');
    assert.equal(clear.disabled, disabled, `${name}: rendered`);
    clear.disabled = !disabled;
    mod.board.refreshFilterBarChrome(app);
    assert.equal(clear.disabled, disabled, `${name}: after refreshFilterBarChrome()`);
    clear.disabled = !disabled;
    mod.board.applySearchFilter();
    assert.equal(clear.disabled, disabled, `${name}: after applySearchFilter()`);
  }
});

test('the bar keeps the structure, classes and ids its bindings and styles select by', () => {
  renderBar();
  const group = app.querySelector('.search-group');
  assert.equal(group !== null && group.parentElement === app, true, 'one .search-group');
  // styles.css hides every direct child but these three below 768px — keep them direct children.
  assert.deepEqual([...group.children].map(el => el.className),
    ['tag-filter-wrap', 'people-filter-wrap', 'status-filter-wrap', 'search-input-wrap', 'btn-board-refresh']);
  assert.equal(group.querySelector('.tag-filter-wrap > button.btn-tag-filter') !== null, true);
  const input = group.querySelector('.search-input-wrap > .search-field > input.search-input');
  assert.equal(input?.getAttribute('type'), 'text');
  assert.equal(group.querySelector('.search-field > button.search-clear-btn[type="button"][hidden]') !== null, true,
    'the inline X starts hidden with no phrase');
  assert.equal(group.querySelector('.search-input-wrap > button#search-reset-btn.search-reset-btn') !== null, true);
  assert.equal(group.querySelector('button#btn-board-refresh.btn-board-refresh') !== null, true);
  for (const selector of ['.btn-tag-filter', '.search-clear-btn', '#btn-board-refresh']) {
    assert.equal(group.querySelector(`${selector} > svg[aria-hidden="true"]`) !== null, true, `${selector}: decorative icon`);
  }

  // Active tag filters add their chips in front of the tag filter button.
  mod.state.activeTagFilters.add('ui');
  renderBar();
  assert.deepEqual([...app.querySelector('.search-group').children].slice(0, 2).map(el => el.className),
    ['tag-filter-chips', 'tag-filter-wrap']);
  assert.equal(app.querySelector('.btn-tag-filter').classList.contains('active'), true);
});

test('tag chips and the search phrase are escaped', () => {
  mod.state.activeTagFilters.add('a"b<i>c</i>');
  mod.state.searchQuery = 'say "hi" <b>now</b>';
  renderBar();
  const chip = app.querySelector('.tag-filter-chips .tag-chip');
  assert.equal(chip.dataset.tag, 'a"b<i>c</i>');
  assert.equal(chip.textContent, 'a"b<i>c</i> ×');
  assert.equal(app.querySelector('.search-input').value, 'say "hi" <b>now</b>');
  assert.equal(app.querySelector('.search-group i, .search-group b') === null, true, 'no injected markup');
  assert.equal(app.querySelector('.search-clear-btn').hidden, false, 'the inline X shows with a phrase');
});

test('template.html renders the top nav filter bar through renderFilterBar(), with no English literals left', () => {
  const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  const start = html.indexOf('app.innerHTML = `\n    <nav class="top-nav">');
  const end = html.indexOf('</nav>', start);
  assert.ok(start >= 0 && end > start, 'top nav markup found');
  const nav = html.slice(start, end);
  assert.match(nav, /\$\{isTasksSection \? (?:\/\*[^*]*\*\/ )?renderFilterBar\(assigneeCounts, statusCounts\) : ''\}/);
  assert.equal(nav.includes('class="search-group"'), false, 'the bar markup lives in renderFilterBar() only');
  assert.match(nav, /<button class="burger-btn" aria-label="\$\{escapeAttr\(t\('nav\.menu'\)\)\}"/);
  for (const literal of ['Filter by tag', 'Search tasks', 'Refresh board', '>Clear<', 'aria-label="Menu"']) {
    assert.equal(nav.includes(literal), false, `template.html top nav still holds "${literal}"`);
  }
});
