'use strict';

// ── C1165: reopen a closed task on a chat-driven edit ──
// Server-side twin of the client's `applyModifiedCardToLiveTask` /
// `CLOSED_STATUSES` (src/client/modified-task-merge.js) — that helper covers the
// primary objective-chat save path (PUT /api/todo, target present in the scoped
// TODO.md read). This module covers the two paths that write directly to a single
// task via `backend.updateTask()` instead: the absent-target PATCH fallback
// (C922/Bug 3 — target owned by a teammate) and spec-chat's apply-spec-update.
// Keep CLOSED_STATUSES in sync with the client copy if either changes.
//
// C1187: `applyReopenToPatch` (the only path real callers use) now resolves the
// project's own status registry via `fetchStatusContext()` and reopens/closes by ROLE
// (complete/canceled -> in_progress), not by matching the literal names below.
// CLOSED_STATUSES/REOPEN_STATUS/isClosedStatus/reopenStatusFor's 2-arg form stay exactly
// as they were — they're the legacy fallback `reopenStatusFor()` degrades to when no
// `roles` map is supplied (backend has no getStatuses, network hiccup, direct unit-test
// call) — so a renamed registry now reopens correctly, and every pre-C1187 caller/test is
// unaffected.

const { fetchStatusContext, isClosedName } = require('./status-roles');

const CLOSED_STATUSES = new Set(['completed', 'canceled']);
const REOPEN_STATUS = 'in_progress';

function isClosedStatus(status) {
  return CLOSED_STATUSES.has(status);
}

// Pure decision: given the task's live status and the status (if any) the incoming
// edit already carries explicitly, what should the patch's status become?
// Returns null when no reopen is warranted (live task isn't closed, or the edit
// already carries an explicit status that must not be second-guessed).
// `roles` (optional, C1187) — a fetchStatusContext().roles map. Omitted -> legacy
// literal-name behavior (isClosedStatus/REOPEN_STATUS), byte-identical to pre-C1187.
function reopenStatusFor(liveStatus, incomingStatus, roles) {
  if (incomingStatus !== undefined) return null;
  const closed = roles ? isClosedName(liveStatus, roles) : isClosedStatus(liveStatus);
  if (!closed) return null;
  return roles ? roles.in_progress : REOPEN_STATUS;
}

// Mutates `patch` in place, adding the project's in-progress-role status when the target
// task is currently closed (complete or canceled role) and the patch doesn't already
// carry an explicit status. Non-throwing: a failed/missing live-status lookup or a
// registry fetch failure is logged/fail-soft and leaves the patch untouched rather than
// failing the caller's save — a chat edit must never fail because the reopen probe failed.
// Returns true if the patch was modified, false otherwise.
async function applyReopenToPatch(backend, taskKey, patch, source = 'chat-edit') {
  if (!patch || patch.status !== undefined) return false;
  if (!backend || typeof backend.getTask !== 'function') return false;
  let live;
  try {
    live = await backend.getTask(taskKey);
  } catch (err) {
    console.warn(`[${source}] reopen check failed for ${taskKey}: ${err.message}`);
    return false;
  }
  if (!live) return false;
  const { roles } = await fetchStatusContext(backend); // fail-open, never throws
  const next = reopenStatusFor(live.status, patch.status, roles);
  if (!next) return false;
  patch.status = next;
  console.log(`[${source}] reopening ${taskKey}: ${live.status} -> ${next}`);
  return true;
}

module.exports = {
  CLOSED_STATUSES,
  REOPEN_STATUS,
  isClosedStatus,
  reopenStatusFor,
  applyReopenToPatch,
};
