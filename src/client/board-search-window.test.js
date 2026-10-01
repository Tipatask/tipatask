import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { computeTierWindow } from './sprint-tier-visibility.js';

const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const boardSource = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = template.indexOf(start);
  const to = template.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing template section: ${start}`);
  return template.slice(from, to);
}

test('search fetches an older matching sprint on the first render, then clearing search restores the active window', async () => {
  const state = {
    searchQuery: 'older hit',
    boardWindow: { floor: 365, has_older: true, extended: 0 },
    subtaskStack: [], sprintWindowExtend: 0, assigneeScope: 'me', allStepsLoaded: false,
  };
  const urls = [];
  const sandbox = {
    state, window: {}, projectHeader: () => ({}),
    fetch: async (url) => {
      urls.push(url);
      const isFull = new URL(url, 'http://localhost').searchParams.has('full_window');
      const payload = isFull
        ? { tasks: [{ id: 'C4', priority: 350, title: 'Older hit' }], window: null }
        : { tasks: [], window: { floor: 365, has_older: true, extended: 0 } };
      return { ok: true, text: async () => `# TODO\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` };
    },
  };
  vm.runInNewContext([
    section('let _searchFullWindowActive = false;', 'function _boardTaskFilterHash'),
    section('function _applyBoardWindow(win, fullWindow = false)', '// Rebuild breadcrumbs'),
    section('async function fetchBoardWindow(', 'async function hydrateSprints'),
    'globalThis.boardApi = { context: _boardTaskCacheContext, apply: _applyBoardWindow, fetch: fetchBoardWindow };',
  ].join('\n'), sandbox);
  const buttonStart = boardSource.indexOf('function _loadMoreButtonHtml(');
  const buttonEnd = boardSource.indexOf('// ── Board view HTML', buttonStart);
  assert.ok(buttonStart >= 0 && buttonEnd > buttonStart);
  vm.runInNewContext(`${boardSource.slice(buttonStart, buttonEnd)}\nglobalThis.loadMoreHtml = _loadMoreButtonHtml;`, sandbox);
  const { context, apply, fetch: fetchBoardWindow } = sandbox.boardApi;

  const searchContext = context();
  assert.equal(searchContext.fullWindow, true);
  const full = await fetchBoardWindow(null, 0, false, searchContext.fullWindow);
  apply(full.window, searchContext.fullWindow);
  assert.equal(full.window, null);
  assert.equal(state.allStepsLoaded, true);
  assert.equal(state.boardWindow, null);
  assert.equal(sandbox.loadMoreHtml(0), '', 'full results must not offer Load More');
  const visible = computeTierWindow(full.tasks.map(t => t.priority), {
    revealAll: true, hasActiveMatch: () => false,
    hasAnyMatch: priority => full.tasks.some(t => t.priority === priority && /older hit/i.test(t.title)),
  });
  assert.deepEqual(Array.from(visible.visibleKeys), [350]);
  assert.equal(visible.hiddenCount, 0);
  assert.equal(context().fullWindow, true, 'a null response window must not shrink the next search fetch');
  assert.equal(new URL(urls[0], 'http://localhost').searchParams.has('window'), false);
  assert.equal(new URL(urls[0], 'http://localhost').searchParams.has('extend_sprints'), false);

  state.searchQuery = '';
  state.allStepsLoaded = false;
  const clearedContext = context();
  assert.equal(clearedContext.fullWindow, false);
  const limited = await fetchBoardWindow(null, 0, false, clearedContext.fullWindow);
  apply(limited.window, clearedContext.fullWindow);
  assert.equal(new URL(urls[1], 'http://localhost').searchParams.get('window'), 'active');
  assert.equal(state.boardWindow.floor, 365);
  assert.equal(state.allStepsLoaded, false);
});
