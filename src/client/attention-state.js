// Centralize attention state. Clear the orange marker only when user opens
// terminal, session ends/restarts, or task closes without a live session. A
// transient WS snapshot or board rerender must not erase unread attention.

import state from './state.js';

// Tasks the user has already dismissed by opening the terminal, or that were pruned as closed.
// A /api/sessions snapshot must not resurrect these off a stale `attention[]` entry — the
// server deliberately keeps `_attentionBroadcasted` latched after an `attention-seen` message
// (it only nulls `_attentionLastBroadcast`, see ws-handlers.js), so the task keeps appearing in
// `attention[]` long after the user has seen it. A genuinely NEW raise (attention-needed frame)
// always lifts the suppression — see raiseAttention() below.
const _suppressed = new Set();
const _dismissedLosses = new Map();
let _snapshotProject;

export function markSessionLost(taskId, detail = {}) {
  state.activeSessions.delete(taskId);
  state.exitedSessions.delete(taskId);
  state.lostSessions.set(taskId, { ...state.lostSessions.get(taskId), ...detail });
  const meta = state.sessionMeta.get(taskId);
  if (meta) state.sessionMeta.set(taskId, { ...meta, alive: false });
  clearAttention(taskId, 'gone');
}

export function dismissLostSession(taskId) {
  if (state.lostSessions.has(taskId)) {
    _dismissedLosses.set(taskId, state.lostSessions.get(taskId)?.at || 'unknown');
    state.lostSessions.delete(taskId);
  }
}

export function isAttentionRaised(taskId) {
  return state.attentionSessions.has(taskId);
}

// Whether the user is currently looking at this task's terminal — the one case a server
// `attention-cleared` broadcast is trustworthy enough to actually clear the flag (see
// attention-ws.js#handleAttentionMessage).
export function isTerminalOpenFor(taskId) {
  return !!taskId && state.activeTerminal?.taskId === taskId;
}

// Class-list fragment for renderCard()'s template string — same precedent as the existing
// `pending-sync`/`objective-highlight` branches there, and the same "emit in the initial HTML,
// re-sweep after any DOM rebuild" pattern applyPendingSyncClass() already uses.
export function attentionClass(taskId) {
  if (state.lostSessions.has(taskId)) return ' session-lost';
  return state.attentionSessions.has(taskId) ? ' needs-attention' : '';
}

export function raiseAttention(taskId, detail) {
  if (!taskId) return;
  _suppressed.delete(taskId); // a genuinely new prompt always wins over a past dismissal
  state.attentionSessions.add(taskId);
  if (detail) state.attentionDetails.set(taskId, detail);
}

// reason: 'opened' | 'session-ended' | 'closed' | 'gone' | 'server'
// 'opened' and 'closed' arm the resurrection-suppression above; the others don't need to — the
// session itself is gone (terminated/ended/never existed), so there is nothing left for a later
// snapshot to wrongly resurrect against.
export function clearAttention(taskId, reason = 'server') {
  if (!taskId) return;
  state.attentionSessions.delete(taskId);
  state.attentionDetails.delete(taskId);
  if (reason === 'opened' || reason === 'closed') _suppressed.add(taskId);
  else _suppressed.delete(taskId);
}

// Reconciles a GET /api/sessions payload. ADDITIVE ONLY for attention — a snapshot can raise a
// flag the client missed (e.g. a WS drop while a dialog was already open), but can never lower
// one just because this particular fetch didn't happen to see it, since the server's own
// broadcast latch (see module doc above) already makes "missing from attention[]" an unreliable
// signal for "resolved". The one case a snapshot IS authoritative about is the session's own
// existence: a flag is cleared when its taskId is absent from both `sessions` and `exited`,
// i.e. the session is gone entirely, not merely quiet. Missing terminals remain
// separately recoverable in lostSessions; only activeSessions contributes to live counts.
export function mergeSessionsSnapshot(data, project = data?.projectPath || '') {
  if (!data) return;
  if (_snapshotProject !== undefined && _snapshotProject !== project) {
    state.activeSessions.clear();
    state.lostSessions.clear();
    state.sessionMeta.clear();
    state.attentionSessions.clear();
    state.attentionDetails.clear();
    _dismissedLosses.clear();
    _suppressed.clear();
  }
  _snapshotProject = project;
  const attention = new Set(data.attention || []);
  const details = data.attentionDetails || {};
  const sessions = new Set(data.sessions || []);
  const exited = new Set(data.exited || []);

  for (const id of attention) {
    if (_suppressed.has(id)) continue; // user already dismissed this — needs a fresh raise
    state.attentionSessions.add(id);
    if (details[id]) state.attentionDetails.set(id, details[id]); // never blank a live detail
  }
  for (const id of [...state.attentionSessions]) {
    if (sessions.has(id) || exited.has(id)) continue; // session still known to the server — keep
    clearAttention(id, 'gone');
  }
  for (const id of [..._suppressed]) {
    if (!sessions.has(id) && !exited.has(id)) _suppressed.delete(id); // session gone — GC the ledger
  }

  const meta = new Map(Object.entries(data.sessionMeta || {}));
  for (const id of new Set([...state.activeSessions, ...(data.lost || [])])) {
    if (sessions.has(id) || exited.has(id)) continue;
    const oldMeta = meta.get(id) || state.sessionMeta.get(id);
    if ((oldMeta?.type || 'terminal') !== 'terminal' || /^(obj-|specChat:)/.test(id)) continue;
    const detail = data.lostDetails?.[id] || state.lostSessions.get(id) || {};
    if (!state.activeSessions.has(id) && _dismissedLosses.get(id) === (detail.at || 'unknown')) continue;
    markSessionLost(id, detail);
  }
  for (const id of [...state.lostSessions.keys()]) {
    if (sessions.has(id) || exited.has(id)) {
      dismissLostSession(id);
      continue;
    }
    clearAttention(id, 'gone');
    const row = meta.get(id) || state.sessionMeta.get(id);
    if (row) meta.set(id, { ...row, alive: false });
  }
  state.activeSessions = sessions;
  state.exitedSessions = exited;
  state.sessionMeta = meta;
}

// Guarded replacement for the inline "delete attentionSessions for closed tasks" loops that
// used to live in template.html. Never prunes a task that still has a live terminal session —
// attention flags are only ever raised for `type: 'terminal'` sessions server-side (the
// __attention__ sweep and broadcastAttentionFor() both gate on `session.type === 'terminal'`),
// so a live entry in state.activeSessions is always a live terminal for these ids.
export function pruneClosedAttention(taskStatusById, isClosedFn) {
  for (const id of [...state.attentionSessions]) {
    if (state.activeSessions.has(id)) continue; // live session — closed-looking status may be stale/racy
    const status = taskStatusById.get(id);
    if (status !== undefined && isClosedFn(status)) clearAttention(id, 'closed');
  }
}

// Re-applies `.needs-attention` to every mounted card from state.attentionSessions — the
// re-render-survival counterpart of the `${attentionClass(t.id)}` renderCard() emits. Needed
// because a full board re-render (app.innerHTML = ...) rebuilds every card node from the
// template string; this repaints any card whose flag changed after that render. Safe to call
// before the board has ever rendered (no-op).
export function syncAttentionClasses(root) {
  const host = root || (typeof document !== 'undefined' ? document.getElementById('app') : null);
  if (!host || typeof host.querySelectorAll !== 'function') return;
  host.querySelectorAll('.card[data-id]').forEach((card) => {
    card.classList.toggle('needs-attention', state.attentionSessions.has(card.dataset.id) && !state.lostSessions.has(card.dataset.id));
    card.classList.toggle('session-lost', state.lostSessions.has(card.dataset.id));
  });
}

export function isOpenSuppressed(taskId) {
  return _suppressed.has(taskId);
}

// test-only
export function _resetAttentionState() {
  _snapshotProject = undefined;
  _dismissedLosses.clear();
  state.lostSessions.clear();
  _suppressed.clear();
}
