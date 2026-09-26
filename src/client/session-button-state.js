// ── Console-control button state (TPT374) ──
// Pure module, no DOM/network — same idiom as subtask-count.js/group-label.js — so both
// task-board.js's card button (.btn-claude) and task-edit-modal.js's footer Start button can
// share one role-derived decision instead of each re-deriving it from a literal status name.
//
// Before this, both surfaces painted play/"Resume" any time a session existed at all — active
// (agent running) and exited (process gone, scrollback kept) were treated the same. That's
// wrong for an in-progress task with a still-running agent: there's nothing to "resume", the
// terminal is already live, so the control should read as busy (spinner) rather than
// actionable (play). RESUME still covers both the interrupted-but-in-progress case (no active
// process) and the completed-but-still-running case (agent kept going past the status write).

import { isInProgressName, isCompleteName } from './status-registry.js';

export const SESSION_BUTTON_MODES = Object.freeze({
  START: 'start',     // no session — click starts a fresh one
  RESUME: 'resume',   // a session exists but this task isn't actively running right now
  RUNNING: 'running',  // in-progress status AND the agent process is live right now
});

// `status` is a role name from the project's live status registry (never a hardcoded legacy
// literal) — isInProgressName()/isCompleteName() resolve it against the current role map.
// `active` = state.activeSessions has this task (process live); `exited` = process gone but
// session/scrollback kept (state.exitedSessions).
export function sessionButtonMode(status, { active = false, exited = false } = {}) {
  if (isInProgressName(status)) return active ? SESSION_BUTTON_MODES.RUNNING : SESSION_BUTTON_MODES.RESUME;
  if (isCompleteName(status) && active) return SESSION_BUTTON_MODES.RESUME;
  return (active || exited) ? SESSION_BUTTON_MODES.RESUME : SESSION_BUTTON_MODES.START;
}
