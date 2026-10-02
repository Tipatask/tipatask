import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:4455/' });
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });

class TestIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.IntersectionObserver = TestIntersectionObserver;
window.IntersectionObserver = TestIntersectionObserver;
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'board-filter-dom-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  // Execute production template event handlers with the real board module and a cached snapshot.
  const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  const from = template.indexOf('  // ── Search input ──');
  const to = template.indexOf('  // ── Show More button ──', from);
  assert.ok(from > 0 && to > from);
  const moreFrom = template.indexOf('  const loadMoreBtn = document.getElementById(\'btn-load-more\');', to);
  const moreTo = template.indexOf('  // Apply search filter after render', moreFrom);
  assert.ok(moreFrom > to && moreTo > moreFrom);
  const bundled = await build({
    stdin: { contents: `import * as board from './src/client/task-board.js';
      import state from './src/client/state.js';
      import { nextStatusSelection } from './src/client/status-filter-select.js';
      import { statusNames } from './src/client/status-registry.js';
      import { escapeAttr } from './src/client/utils.js';
      import { getSprintSortOrder } from './src/client/group-label.js';
      export { setSprintSortOrder } from './src/client/group-label.js';
      export { board, state };
      const { updateSearchInputWidth, assigneeFilterActive, statusFilterActive,
        onBoardFiltersChanged, refreshBoardForFilters, clearSearchQuery, refreshFilterBarChrome,
        computeVisibleTiers, anyNarrowingFilterActive, FILTERED_TIER_PAGE_SIZE } = board;
      const getSprintsEnabled = () => true;
      const perfStart = () => {}, perfEnd = () => {};
      let _statusFilterPanelOpen = false, _statusFilterPanelCleanup = null;
      let _peopleFilterPanelOpen = false, _peopleFilterPanelCleanup = null;
      export function bindFilters(app, tasks, loadAndRender) { ${template.slice(from, to)} }
      export function bindShowMore(loadAndRender) { ${template.slice(moreFrom, moreTo)} }`, resolveDir: root },
    bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { board, state, bindFilters, bindShowMore, setSprintSortOrder } = await import(pathToFileURL(bundlePath).href);
  window.scrollTo = () => {};
  const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
  let fetches = 0;
  globalThis.fetch = async (url, options) => {
    // Persisting filter preferences is expected; task reads must stay cached.
    if (url === '/api/project-config' && options?.method === 'POST') {
      return { ok: true, json: async () => ({}) };
    }
    fetches++;
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const unhandled = [];
  process.on('unhandledRejection', err => unhandled.push(err));
  let keys = Array.from({ length: 10 }, (_, i) => 356 + i);
  let tasks = keys.map(priority => ({
    id: `T${priority}`, priority, category: 'CODING',
    title: priority === 360 ? 'Unique needle' : 'Shared work', description: '',
    tags: priority === 360 ? ['special'] : ['general'],
    status: priority === 356 ? 'pending' : 'completed',
  }));
  Object.assign(state, { activeTab: 'board', tierKeys: keys,
    tiers: Object.fromEntries(tasks.map(task => [task.priority, [task]])),
    _lastVisibleTasks: tasks, allStepsLoaded: false, boardWindow: null, searchQuery: '' });
  state.activeTagFilters.clear(); state.statusFilter.clear();
  setSprintSortOrder('asc');
  document.body.innerHTML = '<main id="app"></main>';
  const app = document.getElementById('app');
  let renders = 0;
  const card = task => `<div class="card" data-id="${task.id}" data-status="${task.status}"
    data-tags='${JSON.stringify(task.tags)}'><span class="card-title">${task.title}</span></div>`;
  async function render() {
    renders++;
    app.innerHTML = `<div class="search-group"><input class="search-input"><button class="search-clear-btn">Clear phrase</button></div>
      <button id="search-reset-btn">Clear</button><button class="btn-tag-filter">Tags</button>
      ${board.renderStatusFilter(board.computeStatusCounts(tasks))}
      ${board.renderBoardContent(keys, state.tiers, rows => rows, card)}`;
    app.querySelector('.search-input').value = state.searchQuery;
    bindFilters(app, tasks, render);
    bindShowMore(render);
    board.applySearchFilter();
    board.refreshFilterBarChrome(app, render);
  }
  const visible = () => [...app.querySelectorAll('.tier:not(.tier--empty)')].map(el => Number(el.dataset.priority));
  const type = async (value, start = value.length, end = start) => {
    const input = app.querySelector('.search-input');
    input.focus(); input.value = value; input.setSelectionRange(start, end);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(180);
  };
  await render();
  assert.deepEqual(visible(), [356]);
  state.extraStepsLoaded = 1;
  await type('needle', 1, 4);
  assert.deepEqual(visible(), [360]);
  assert.equal(state.extraStepsLoaded, 0);
  assert.equal(board.computeVisibleTiers(keys, state.tiers).hiddenCount, 0);
  assert.equal(app.querySelectorAll('.tier.tier--empty').length, 9);
  assert.equal(app.querySelectorAll('.tier-drop-sentinel').length, 10);
  assert.equal(document.activeElement, app.querySelector('.search-input'));
  assert.equal(document.activeElement.selectionStart, 1);
  assert.equal(document.activeElement.selectionEnd, 4);
  await type('Shared');
  assert.deepEqual(visible(), keys.filter(k => k !== 360));
  app.querySelector('.search-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  assert.equal(state.searchQuery, '');
  assert.deepEqual(visible(), [356]);

  // Clearing must cancel a pending debounce referencing the detached input.
  const pending = app.querySelector('.search-input');
  pending.value = 'needle'; pending.dispatchEvent(new Event('input', { bubbles: true }));
  app.querySelector('.search-clear-btn').click();
  await tick(180);
  assert.equal(state.searchQuery, '');
  assert.deepEqual(visible(), [356]);

  state.statusFilter = new Set(['pending']);
  await render();
  const changeStatus = async (status, checked) => {
    const cb = app.querySelector(`input[data-status="${status}"]`);
    cb.focus(); cb.checked = checked; cb.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
  };
  for (let n = 0; n < 3; n++) {
    state.extraStepsLoaded = 1;
    await changeStatus('completed', true);
    assert.deepEqual(visible(), keys);
    assert.equal(state.extraStepsLoaded, 0);
    assert.equal(document.activeElement.dataset.status, 'completed');
    await changeStatus('pending', false);
    assert.deepEqual(visible(), keys.slice(1));
    await changeStatus('pending', true);
  }
  setSprintSortOrder('desc'); await render();
  assert.deepEqual(visible(), [...keys].reverse());
  setSprintSortOrder('asc'); state.statusFilter.clear(); await render();

  app.querySelector('.btn-tag-filter').click();
  const overlay = document.querySelector('.tag-cloud-modal-overlay');
  const toggleTag = async () => { overlay.querySelector('[data-tag="special"]').click(); await tick(); };
  await toggleTag();
  assert.equal(overlay.isConnected, true);
  assert.deepEqual(visible(), [360]);
  await toggleTag(); assert.deepEqual(visible(), [356]);
  await toggleTag();
  overlay.querySelector('.tag-cloud-close').click();
  const beforeChip = renders;
  app.querySelector('.tag-chip').click(); await tick();
  assert.equal(renders, beforeChip + 1);
  assert.deepEqual(visible(), [356]);
  assert.equal(state.activeTagFilters.size, 0);
  state.extraStepsLoaded = 50;
  await board.refreshBoardForFilters(render);
  assert.equal(state.extraStepsLoaded, 0);
  assert.equal(fetches, 0);
  assert.deepEqual(unhandled, []);

  // Completed spans many old sprints: only the newest 20 matching tiers appear at
  // first, and each real Show More click adds the next 20 without clearing the filter.
  keys = Array.from({ length: 163 }, (_, i) => 214 + i);
  const matchingKeys = keys.filter(priority => priority % 13 !== 0);
  tasks = keys.map(priority => ({
    id: `T${priority}`, priority, category: 'CODING', title: 'Finished work',
    description: '', tags: [], status: priority % 13 === 0 ? 'pending' : 'completed',
  }));
  state.tierKeys = keys;
  state.tiers = Object.fromEntries(tasks.map(task => [task.priority, [task]]));
  state._lastVisibleTasks = tasks;
  state.allStepsLoaded = true; // Full search results still need local paging.
  state.statusFilter = new Set(['completed']);
  await board.refreshBoardForFilters(render);
  assert.deepEqual(visible(), matchingKeys.slice(-20));
  assert.equal(board.computeVisibleTiers(keys, state.tiers).hiddenCount, matchingKeys.length - 20);
  assert.ok(app.querySelector('#btn-load-more'));
  setSprintSortOrder('desc'); await render();
  assert.deepEqual(visible(), [...matchingKeys.slice(-20)].reverse());
  setSprintSortOrder('asc'); await render();
  for (let page = 2; page <= Math.ceil(matchingKeys.length / 20); page++) {
    app.querySelector('#btn-load-more').click();
    await tick();
    assert.deepEqual(visible(), matchingKeys.slice(-Math.min(page * 20, matchingKeys.length)));
    assert.deepEqual([...state.statusFilter], ['completed']);
  }
  assert.equal(board.computeVisibleTiers(keys, state.tiers).hiddenCount, 0);
  assert.equal(app.querySelector('#btn-load-more'), null);
  await board.refreshBoardForFilters(render);
  assert.deepEqual(visible(), matchingKeys.slice(-20));
  assert.equal(state.extraStepsLoaded, 0);
  assert.equal(fetches, 0);
  assert.deepEqual(unhandled, []);
  console.log('BOARD_FILTER_DOM_PASS');
} catch (err) { console.error(err); exitCode = 1; }
finally { window.happyDOM.abort(); rmSync(temporary, { recursive: true, force: true }); }
process.exit(exitCode);
