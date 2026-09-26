// Track unread API notification rows for each card, distinct from terminal
// attention and assignment indicators. Keep this module DOM/terminal-import free
// so its reduction logic runs in plain Node tests.

import state from './state.js';

// Whether applyActivitySnapshot() has ever been called this page-load. The FIRST application
// (board-init fetch, or a WS frame that beats it) is always silent — it's establishing a
// baseline, not reporting new activity — otherwise a reload re-registers every already-known
// unread row as a "rise" and fires one push per task at once. A later WS reconnect is NOT
// silent: genuine misses during the outage must still surface.
let _hasBaseline = false;

// taskId -> Set<number> of notification ids marked read locally (optimistic) but not yet
// confirmed absent from a server snapshot. Subtracted from every incoming snapshot before
// computing count/rose, so a poll tick that rebuilds the old count while a mark-read PATCH is
// still in flight can't register a false "rise" (and therefore can't fire a spurious push) for
// activity the user is at that moment reading. GC'd per task the moment a fresh snapshot no
// longer contains an id — the server has confirmed the read.
const _locallyReadIds = new Map();

function _idsAfterLocalRead(taskId, ids) {
  const readSet = _locallyReadIds.get(taskId);
  if (!readSet || readSet.size === 0) return ids;
  return ids.filter((id) => !readSet.has(id));
}

function _gcLocallyRead(taskId, rawIds) {
  const readSet = _locallyReadIds.get(taskId);
  if (!readSet) return;
  for (const id of [...readSet]) {
    if (!rawIds.includes(id)) readSet.delete(id);
  }
  if (readSet.size === 0) _locallyReadIds.delete(taskId);
}

// Applies a fresh per-task activity snapshot — from either the poll's `task-activity` WS
// broadcast or the board-init one-shot fetch, both carrying the same
// `{ [taskId]: { count, ids, latest } }` shape (see task-change-poll.js#_reduceActivity).
//
// Idempotent by construction: it diffs against the CURRENT state.taskActivity and overwrites
// it before returning — so browser mode, which runs the __board__ and __attention__ sockets
// simultaneously (attention-ws.js's C1193 comment) and can dispatch one frame twice, sees an
// empty rose set on the second call for free (it diffs against what the first call just wrote).
//
// Returns the tasks whose (locally-adjusted) unread set gained a genuinely new id since the
// last application — the signal that should drive a push/toast. Never non-empty on the very
// first application (see _hasBaseline above).
export function applyActivitySnapshot(rawActivity) {
  const activity = rawActivity || {};
  const rose = [];
  const next = new Map();
  const knownTasks = state.taskStatusById;

  for (const [taskId, entry] of Object.entries(activity)) {
    // Drop task keys the board doesn't know about — cross-project WS fanout guard (see
    // task-change-poll.js's broadcastToProject doc) and the natural filter for
    // filtered/backlog/subtask-drilldown boards. Permissive when the map is empty (before the
    // first board render — nothing to paint a chip onto yet anyway).
    if (knownTasks && knownTasks.size > 0 && !knownTasks.has(taskId)) continue;

    const rawIds = Array.isArray(entry?.ids) ? entry.ids : [];
    _gcLocallyRead(taskId, rawIds);
    const visibleIds = _idsAfterLocalRead(taskId, rawIds);
    if (visibleIds.length === 0) continue;

    const prev = state.taskActivity.get(taskId);
    const prevIds = prev ? prev.ids : [];
    const newIds = visibleIds.filter((id) => !prevIds.includes(id));
    if (_hasBaseline && newIds.length > 0) {
      rose.push({ taskId, newIds, latest: entry.latest || null });
    }

    next.set(taskId, { count: visibleIds.length, ids: visibleIds, latest: entry.latest || null });
  }

  state.taskActivity = next;
  _hasBaseline = true;
  return rose;
}

// Client-side twin of task-change-poll.js's server-side `_reduceActivity()` — the board-init
// one-shot fetch (api.project.notifications.list()) gets raw `notifications` rows back, not
// the poll's already-reduced `{ [taskId]: { count, ids, latest } }` broadcast shape. Kept in
// sync by hand (small, pure, no shared runtime between the Task App server and its bundled
// client) rather than importing the server module into a browser bundle.
export function reduceActivityRows(rows) {
  const activity = {};
  for (const row of rows || []) {
    if (!row.task_key) continue;
    let entry = activity[row.task_key];
    if (!entry) {
      entry = { count: 0, ids: [], latest: null };
      activity[row.task_key] = entry;
    }
    entry.count += 1;
    entry.ids.push(row.id);
    if (!entry.latest) {
      entry.latest = { id: row.id, title: row.title, body: row.body, event_type: row.event_type, actor: row.actor, created_at: row.created_at };
    }
  }
  return activity;
}

export function activityCount(taskId) {
  return state.taskActivity.get(taskId)?.count || 0;
}

export function activityIds(taskId) {
  return (state.taskActivity.get(taskId)?.ids || []).slice();
}

// HTML fragment for renderCard()'s template string — same precedent as attention-state.js's
// attentionClass(). A real element, not a class toggle: both of .card's pseudo-element slots
// (::before orange dot, ::after green dot) are already taken.
export function activityChipHtml(taskId) {
  const n = activityCount(taskId);
  if (n <= 0) return '';
  return `<span class="card-activity-chip" data-count="${n}">${n > 99 ? '99+' : n}</span>`;
}

// Optimistic local mark-read — called before/alongside the batched
// POST /api/project/notifications/read. Re-filters the task's currently visible ids through
// the (now larger) suppression set; server confirmation later GCs the ledger via
// applyActivitySnapshot's _gcLocallyRead.
export function markActivityRead(taskId, ids) {
  if (!taskId || !Array.isArray(ids) || ids.length === 0) return;
  let readSet = _locallyReadIds.get(taskId);
  if (!readSet) {
    readSet = new Set();
    _locallyReadIds.set(taskId, readSet);
  }
  for (const id of ids) readSet.add(id);

  const prev = state.taskActivity.get(taskId);
  if (!prev) return;
  const remaining = prev.ids.filter((id) => !readSet.has(id));
  if (remaining.length === 0) state.taskActivity.delete(taskId);
  else state.taskActivity.set(taskId, { ...prev, count: remaining.length, ids: remaining });
}

// Rolls back a markActivityRead() suppression for ids the server-side PATCH actually failed
// on (see ws-handlers.js's POST /api/project/notifications/read, which reports per-id
// success/failure — never trust a bare count for this). Doesn't try to synchronously restore
// the exact prior state.taskActivity entry; simply lifting the suppression is enough — the
// next poll/board-init snapshot naturally re-shows the id, since it's still present in the
// server's own raw unread list.
export function unmarkActivityRead(taskId, ids) {
  const readSet = _locallyReadIds.get(taskId);
  if (!readSet || !Array.isArray(ids)) return;
  for (const id of ids) readSet.delete(id);
  if (readSet.size === 0) _locallyReadIds.delete(taskId);
}

// Paints/removes the chip on one already-mounted card element. Shared by syncActivityChips()
// below (full re-render survival sweep) and task-card.js's refreshCard() (in-place
// `task:updated` patch path) — miss the latter and the chip silently disappears the moment
// anyone edits the task, the same class of bug C1387 documents for needs-attention.
export function refreshActivityChip(card) {
  if (!card || !card.dataset) return;
  const taskId = card.dataset.id;
  const count = activityCount(taskId);
  let chip = card.querySelector('.card-activity-chip');
  card.classList.toggle('has-activity-badge', count > 0);
  if (count <= 0) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'card-activity-chip';
    const idBadge = card.querySelector('.id-badge');
    if (idBadge) idBadge.insertAdjacentElement('afterend', chip);
    else card.querySelector('.card-top')?.prepend(chip);
  }
  chip.textContent = count > 99 ? '99+' : String(count);
  chip.dataset.count = String(count);
}

// Re-render-survival sweep — the counterpart of activityChipHtml() emitted in the initial
// HTML. Needed because a full board re-render (app.innerHTML = ...) rebuilds every card node
// from the template string; this repaints any card whose count changed after that render.
export function syncActivityChips(root) {
  const host = root || (typeof document !== 'undefined' ? document.getElementById('app') : null);
  if (!host || typeof host.querySelectorAll !== 'function') return;
  host.querySelectorAll('.card[data-id]').forEach(refreshActivityChip);
}

// test-only
export function _resetTaskActivity() {
  _hasBaseline = false;
  _locallyReadIds.clear();
  state.taskActivity = new Map();
}
