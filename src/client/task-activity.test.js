// (TPT12) Unit tests for the per-card activity chip reducer/ledger. No jsdom — hand-rolled
// card/document mocks, same style as attention-state.test.js.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const stateModule = await import('./state.js');
const state = stateModule.default;
const {
  applyActivitySnapshot, activityCount, activityIds, activityChipHtml,
  markActivityRead, unmarkActivityRead, refreshActivityChip, syncActivityChips,
  reduceActivityRows, _resetTaskActivity,
} = await import('./task-activity.js');

function row(id, taskKey, extra = {}) {
  return { id, task_key: taskKey, title: `t${id}`, body: `b${id}`, event_type: 'comment', actor: { id: 9 }, created_at: `2026-01-0${id}`, ...extra };
}

// task-change-poll.js's reduced shape: { [taskKey]: { count, ids, latest } }
function snapshot(entries) {
  const out = {};
  for (const [taskKey, ids] of Object.entries(entries)) {
    out[taskKey] = { count: ids.length, ids, latest: { id: ids[ids.length - 1] || ids[0], title: 'latest', body: '', event_type: 'comment', actor: null, created_at: 'x' } };
  }
  return out;
}

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    toggle(name, on) { if (on) set.add(name); else set.delete(name); },
    add(name) { set.add(name); },
    remove(name) { set.delete(name); },
    contains(name) { return set.has(name); },
  };
}

function makeCard(id, { hasIdBadge = true } = {}) {
  const children = {};
  const idBadge = hasIdBadge ? { insertAdjacentElement(_pos, el) { children.chip = el; } } : null;
  const cardTop = { prepend(el) { children.chip = el; } };
  return {
    dataset: { id },
    classList: makeClassList(),
    querySelector(sel) {
      if (sel === '.card-activity-chip') return children.chip || null;
      if (sel === '.id-badge') return idBadge;
      if (sel === '.card-top') return cardTop;
      return null;
    },
  };
}

beforeEach(() => {
  state.taskStatusById = new Map();
  _resetTaskActivity();
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
      createElement: () => ({ classList: makeClassList(), dataset: {}, remove() {} }),
    };
  }
});

test('applyActivitySnapshot: first-ever application is silent (no rose), even with rows', () => {
  const rose = applyActivitySnapshot(snapshot({ TPT1: [1, 2] }));
  assert.deepEqual(rose, []);
  assert.equal(activityCount('TPT1'), 2);
});

test('applyActivitySnapshot: a later genuinely-new id rises', () => {
  applyActivitySnapshot(snapshot({ TPT1: [1] })); // baseline
  const rose = applyActivitySnapshot(snapshot({ TPT1: [1, 2] }));
  assert.equal(rose.length, 1);
  assert.equal(rose[0].taskId, 'TPT1');
  assert.deepEqual(rose[0].newIds, [2]);
  assert.equal(activityCount('TPT1'), 2);
});

test('applyActivitySnapshot: unchanged snapshot on a later call never rises (idempotent — double-dispatch safe)', () => {
  applyActivitySnapshot(snapshot({ TPT1: [1] })); // baseline
  applyActivitySnapshot(snapshot({ TPT1: [1, 2] })); // rises once
  const rose = applyActivitySnapshot(snapshot({ TPT1: [1, 2] })); // same frame dispatched twice
  assert.deepEqual(rose, []);
});

test('applyActivitySnapshot: drops task keys not present in state.taskStatusById once it is populated', () => {
  state.taskStatusById = new Map([['TPT1', 'pending']]);
  applyActivitySnapshot(snapshot({ TPT1: [], TPT99: [] })); // baseline
  const rose = applyActivitySnapshot(snapshot({ TPT1: [1], TPT99: [1] }));
  assert.equal(activityCount('TPT1'), 1);
  assert.equal(activityCount('TPT99'), 0, 'TPT99 unknown to the board — dropped');
  assert.deepEqual(rose.map((r) => r.taskId), ['TPT1']);
});

test('applyActivitySnapshot: empty taskStatusById is permissive (pre-first-render)', () => {
  state.taskStatusById = new Map(); // nothing rendered yet
  applyActivitySnapshot(snapshot({ TPT1: [1] }));
  assert.equal(activityCount('TPT1'), 1);
});

test('markActivityRead: optimistic local decrement, no rise on the next unchanged-from-server snapshot (no flicker-push)', () => {
  applyActivitySnapshot(snapshot({ TPT1: [1, 2] })); // baseline
  markActivityRead('TPT1', [1]);
  assert.equal(activityCount('TPT1'), 1);
  assert.deepEqual(activityIds('TPT1'), [2]);

  // Poll tick lands before the server has processed the mark-read PATCH — still reports [1,2].
  const rose = applyActivitySnapshot(snapshot({ TPT1: [1, 2] }));
  assert.deepEqual(rose, [], 'id 1 is locally suppressed — must not register as a new rise');
  assert.equal(activityCount('TPT1'), 1);
});

test('markActivityRead: GC drops the local suppression once the server confirms the id is gone', () => {
  applyActivitySnapshot(snapshot({ TPT1: [1, 2] }));
  markActivityRead('TPT1', [1]);
  applyActivitySnapshot(snapshot({ TPT1: [2] })); // server now agrees id 1 is read
  // A brand new id 1 reappearing later (e.g. a new, unrelated row happens to reuse... it can't,
  // ids are never reused, but the ledger should be gone regardless) rises normally now.
  const rose = applyActivitySnapshot(snapshot({ TPT1: [2, 3] }));
  assert.deepEqual(rose[0].newIds, [3]);
});

test('unmarkActivityRead: rolls back a failed mark-read so the next snapshot re-shows it (not silently lost forever)', () => {
  applyActivitySnapshot(snapshot({ TPT1: [1, 2] })); // baseline
  markActivityRead('TPT1', [1]);
  assert.equal(activityCount('TPT1'), 1, 'optimistically hidden');

  // Server PATCH for id 1 actually failed — roll the suppression back.
  unmarkActivityRead('TPT1', [1]);

  // id 1 is still present in the server's raw list (the failed PATCH never took effect) —
  // it must reappear now that it's no longer locally suppressed. It legitimately counts as a
  // "rise" again too: the chip had already been optimistically hidden from the user, so
  // resurfacing it (worst case: one extra push on a rare rollback) beats silently losing it.
  const rose = applyActivitySnapshot(snapshot({ TPT1: [1, 2] }));
  assert.equal(activityCount('TPT1'), 2);
  assert.deepEqual(rose[0].newIds, [1]);
});

test('unmarkActivityRead is a no-op when nothing was suppressed for that task', () => {
  assert.doesNotThrow(() => unmarkActivityRead('TPT-NEVER-SEEN', [1]));
});

test('activityChipHtml: empty when zero, a numeric span otherwise, capped display at 99+', () => {
  assert.equal(activityChipHtml('TPT1'), '');
  applyActivitySnapshot(snapshot({ TPT1: [1] }));
  assert.match(activityChipHtml('TPT1'), /class="card-activity-chip"[^>]*>1</);
});

test('refreshActivityChip: creates the chip after the id-badge, removes it when count drops to zero', () => {
  applyActivitySnapshot(snapshot({ TPT1: [1, 2] }));
  const card = makeCard('TPT1');
  refreshActivityChip(card);
  assert.equal(card.classList.contains('has-activity-badge'), true);
  const chip = card.querySelector('.card-activity-chip');
  assert.ok(chip);
  assert.equal(chip.textContent, '2');

  markActivityRead('TPT1', [1, 2]);
  refreshActivityChip(card);
  assert.equal(card.classList.contains('has-activity-badge'), false);
});

// ── reduceActivityRows — client-side twin of task-change-poll.js's server-side reducer,
// used by the board-init one-shot fetch (which gets raw rows, not the poll's pre-reduced shape) ──

test('reduceActivityRows: matches the poll broadcast shape — merges by task_key, newest row wins latest, no-task_key rows dropped', () => {
  const rows = [
    row(9, 'TPT1', { title: 'newest' }),
    row(3, 'TPT1', { title: 'older' }),
    row(4, null, { title: 'orphan' }),
  ];
  const activity = reduceActivityRows(rows);
  assert.deepEqual(Object.keys(activity), ['TPT1']);
  assert.equal(activity.TPT1.count, 2);
  assert.deepEqual(activity.TPT1.ids, [9, 3]);
  assert.equal(activity.TPT1.latest.title, 'newest');
});

test('reduceActivityRows: empty/undefined input yields an empty snapshot', () => {
  assert.deepEqual(reduceActivityRows([]), {});
  assert.deepEqual(reduceActivityRows(undefined), {});
});

test('syncActivityChips: repaints every mounted card from current state', () => {
  applyActivitySnapshot(snapshot({ TPT1: [1], TPT2: [1, 2] }));
  const cardA = makeCard('TPT1');
  const cardB = makeCard('TPT2');
  const host = { querySelectorAll: () => [cardA, cardB] };
  syncActivityChips(host);
  assert.equal(cardA.querySelector('.card-activity-chip').textContent, '1');
  assert.equal(cardB.querySelector('.card-activity-chip').textContent, '2');
});
