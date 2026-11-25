import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { computeTierWindow } from './sprint-tier-visibility.js';
import { isActiveName } from './status-registry.js';
import { groupLoadMore, groupShowMore } from './group-label.js';
import { t } from './i18n.js';

// Every root-board window reply decides state.allStepsLoaded again. Runs the production window
// and cache helpers from template.html, plus computeVisibleTiers() and the Load More markup from
// task-board.js, against one state object. No narrowing filter is active in these scenarios, so
// the two filter predicates take their no-filter values.

const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const boardSource = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
}

function loadBoard() {
  const state = {
    subtaskStack: [], searchQuery: '', assigneeScope: 'me', sprintWindowExtend: 0,
    boardWindow: null, allStepsLoaded: false, extraStepsLoaded: 0,
    sprints: [], tagDescriptions: new Map(), subtaskParentTask: null,
  };
  const sandbox = {
    state, window: {},
    utils: { pushSubtaskCrumb: (stack, entry) => { stack.push(entry); } },
    computeTierWindow, isActiveName, groupLoadMore, groupShowMore, t,
    anyNarrowingFilterActive: () => false,
    matchesFilters: () => true,
  };
  vm.runInNewContext([
    slice(template, 'const BOARD_TASK_CACHE_LIMIT', '// (C1293) Every full render gets'),
    slice(template, 'function _cloneBoardJson(', 'function _boardTaskFilterHash('),
    slice(template, 'function _boardSnapshotFingerprint(', 'function invalidateBoardTaskCache('),
    slice(boardSource, 'export const FILTERED_TIER_PAGE_SIZE', '// ── Empty state for fresh/empty projects')
      .replace(/^export /gm, ''),
    slice(boardSource, 'function _loadMoreButtonHtml(', '// ── Board view HTML'),
    `globalThis.board = {
      context: _boardTaskCacheContext, apply: _applyBoardWindow,
      remember: _rememberBoardSnapshot, restore: _restoreBoardCacheEntry, cache: _boardTaskCache,
      visibleTiers: computeVisibleTiers, loadMoreHtml: _loadMoreButtonHtml,
    };`,
  ].join('\n'), sandbox);
  return { state, ...sandbox.board };
}

// What the root board draws for one reply: the tiers with content and the Load More markup.
function drawn(board, tasks) {
  const tiers = {};
  for (const task of tasks) (tiers[task.priority] ||= []).push(task);
  const keys = Object.keys(tiers).map(Number).sort((a, b) => a - b);
  const { visibleKeys, hiddenCount } = board.visibleTiers(keys, tiers);
  return { visible: [...visibleKeys], hiddenCount, button: board.loadMoreHtml(hiddenCount) };
}

const task = (id, priority, status) => ({ id, priority, status, title: `Task ${id}` });
// Sprint 1 is the oldest populated sprint and holds the only old open task.
const openOldest = [
  task('T1', 1, 'pending'), task('T2', 2, 'completed'), task('T3', 3, 'completed'),
  task('T4', 4, 'in_progress'), task('T5', 5, 'completed'), task('T6', 6, 'pending'),
];
const replyNothingOlder = { tasks: openOldest, window: { floor: 1, has_older: false, extended: 0 } };
// T1 completed: the window floor rises to sprint 4, the oldest sprint holding an open task.
const replyFloorRaised = { tasks: openOldest.slice(3), window: { floor: 4, has_older: true, extended: 0 } };
// Load Earlier widened the window back past sprint 1.
const replyWidened = {
  tasks: [task('T1', 1, 'completed'), ...openOldest.slice(1)],
  window: { floor: 1, has_older: false, extended: 10 },
};
const snapshot = reply => ({ ...reply, sprints: [], tagDescriptions: new Map(), parentTask: null, ancestors: [] });

test('a reply with older sprints clears the flag a nothing-older reply set, so Load Earlier returns with no filter change', () => {
  const board = loadBoard();
  const { state } = board;

  board.apply(replyNothingOlder.window, false);
  assert.equal(state.allStepsLoaded, true);
  let view = drawn(board, replyNothingOlder.tasks);
  assert.deepEqual(view.visible, [1, 2, 3, 4, 5, 6], 'nothing older: every fetched sprint shows');
  assert.equal(view.button, '', 'nothing older: no Load More');

  board.apply(replyFloorRaised.window, false);
  assert.equal(state.allStepsLoaded, false, 'a reply with has_older:true must clear the flag');
  view = drawn(board, replyFloorRaised.tasks);
  assert.deepEqual(view.visible, [4, 6], 'the all-closed sprint folds back into the Show More pool');
  assert.equal(view.hiddenCount, 1);
  assert.match(view.button, /id="btn-load-more"/);
  assert.ok(view.button.includes(groupShowMore(1)), view.button);

  // Show More reveals the local pool; the same button then offers the older window.
  state.extraStepsLoaded += 10;
  view = drawn(board, replyFloorRaised.tasks);
  assert.deepEqual(view.visible, [4, 5, 6]);
  assert.equal(view.hiddenCount, 0);
  assert.match(view.button, /id="btn-load-more"/);
  assert.ok(view.button.includes(groupLoadMore()), view.button);

  // Pressing it widens the window, and the reply reaches the oldest sprint again.
  state.sprintWindowExtend += 10;
  board.apply(replyWidened.window, false);
  assert.equal(state.allStepsLoaded, true);
  view = drawn(board, replyWidened.tasks);
  assert.deepEqual(view.visible, [1, 2, 3, 4, 5, 6]);
  assert.equal(view.button, '');
});

test('a cache hit restores the flag from the cached reply in both directions', () => {
  const board = loadBoard();
  const { state } = board;
  board.remember('nothing-older', snapshot(replyNothingOlder), board.context());
  board.remember('floor-raised', snapshot(replyFloorRaised), board.context());

  board.restore(board.cache.get('nothing-older'));
  assert.equal(state.allStepsLoaded, true);
  board.restore(board.cache.get('floor-raised'));
  assert.equal(state.allStepsLoaded, false);
  assert.equal(state.boardWindow.has_older, true);
  assert.match(board.loadMoreHtml(0), /id="btn-load-more"/);
  board.restore(board.cache.get('nothing-older'));
  assert.equal(state.allStepsLoaded, true);

  // A full-window search snapshot (window:null) restores as fully loaded; the windowed
  // snapshot restored after the search clears does not keep that flag.
  state.boardWindow = replyFloorRaised.window;
  state.searchQuery = 'needle';
  const searchContext = board.context();
  assert.equal(searchContext.fullWindow, true);
  board.remember('search', snapshot({ tasks: replyWidened.tasks, window: null }), searchContext);
  board.restore(board.cache.get('search'));
  assert.equal(state.allStepsLoaded, true);
  assert.equal(state.boardWindow, null);
  state.searchQuery = '';
  board.restore(board.cache.get('floor-raised'));
  assert.equal(state.allStepsLoaded, false);
});

test('a subtask drill-down reply leaves the flag unchanged', () => {
  const board = loadBoard();
  const { state } = board;
  state.subtaskStack = [{ taskKey: 'T4', title: 'Objective' }];
  board.remember('drilldown', snapshot({ tasks: [task('T7', 4, 'completed')], window: null }), board.context());
  for (const before of [true, false]) {
    state.allStepsLoaded = before;
    board.apply(null, false);
    assert.equal(state.allStepsLoaded, before);
    assert.equal(state.boardWindow, null);
    board.restore(board.cache.get('drilldown'));
    assert.equal(state.allStepsLoaded, before);
  }
});

test('every _applyBoardWindow() caller passes the reply window and its fetch mode', () => {
  const calls = [...template.matchAll(/_applyBoardWindow\(([^)]*)\)/g)]
    .map(match => match[1])
    // Skip the declaration and "_applyBoardWindow()" mentions in comments.
    .filter(args => args && !args.includes('fullWindow = false'));
  assert.ok(calls.length >= 3, 'fresh fetch, background snapshot and cache hit');
  for (const args of calls) assert.match(args, /^[\w.?]+\.window, [\w.?]+\.fullWindow$/, args);
});
