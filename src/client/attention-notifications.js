import state from './state.js';
import { notify, onNotifyFailed, debugNotifyLog, isNotifyEnabled } from './notifications.js';
import { t } from './i18n.js';
import { pushNotification, dismissNotification } from './notification-center.js';
import { inProgressName } from './status-registry.js';

// (C1058) Per-task record of the last prompt signature we actually surfaced to the user (or
// deliberately skipped because they were already looking at it) — see forgetTaskAttention()
// and ai/architecture/tt-notifications.md § Replay & duplicate suppression. This is what makes
// the single trigger in attention-ws.js#handleAttentionMessage safe against a WS-reconnect
// replay: the replay carries the same content, so its signature already matches.
const _notifiedPrompts = new Map();
function _signature(detail) {
  return detail?.promptText || detail?.kind || 'attention';
}

function _cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function _taskCard(taskId) {
  if (typeof document === 'undefined') return null;
  const app = document.getElementById('app');
  return app?.querySelector?.(`.card[data-id="${_cssEscape(taskId)}"]`) || null;
}

// Shared notification-click action (attention + completion): focus the app and open the task's
// console. Title/status are re-read at click time — the card may have re-rendered since the
// banner was raised. openTerminal() itself reattaches a live or exited session.
export function openTaskTerminalFromNotification(taskId, fallbackStatus, opts = {}) {
  try { window.electronAPI?.focusSelf?.(); } catch (_) {}
  const card = _taskCard(taskId);
  const title = card?.querySelector?.('.card-title-inner')?.textContent?.trim()
    || state.taskTitleById?.get(taskId) || taskId;
  const status = card?.dataset?.status || fallbackStatus;
  if (Object.keys(opts).length) window.TipTask?.openTerminal?.(taskId, title, '', status, opts);
  else window.TipTask?.openTerminal?.(taskId, title, '', status);
}

// (TPT613) An exit-backstop banner's session is exited or gone. Exited: reconnect, which replays
// its last output. Gone: open the task workspace instead — openTerminal() would launch a fresh
// agent run for a task with no session, and a click on a banner must never start one.
function openLeftUncommittedTask(taskId, fallbackStatus) {
  if (state.activeSessions?.has(taskId) || state.exitedSessions?.has(taskId)) {
    openTaskTerminalFromNotification(taskId, fallbackStatus);
    return;
  }
  try { window.electronAPI?.focusSelf?.(); } catch (_) {}
  Promise.resolve(window.TipTask?.openTaskWorkspace?.(taskId))
    .catch((err) => debugNotifyLog('openTaskWorkspace failed', taskId, err));
}

function _windowHasUserFocus() {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState !== 'visible') return false;
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
  return true;
}

export function isTaskInUserFocus(taskId) {
  if (!taskId || !_windowHasUserFocus()) return false;
  if (state.activeTerminal?.taskId === taskId && state.activeTerminal.visible !== false) return true;

  const card = _taskCard(taskId);
  if (card) {
    if (state.selectedCardId === taskId) return true;
    if (card.contains?.(document.activeElement)) return true;
    try {
      if (card.matches?.(':hover')) return true;
    } catch (_) {}
  }

  const modal = document.getElementById('task-edit-modal');
  return Boolean(modal && !modal.hidden && modal.dataset.taskId === taskId);
}

// (C1057) Says what the agent is actually asking, instead of a hard-coded generic line.
// `detail` is { kind, promptText, agent } from state.attentionDetails — always a line that
// matched a prompt pattern (never arbitrary output), already sanitized + truncated by
// prompt-detect.js#sanitizePromptText on the server.
export function buildAttentionBody(detail) {
  if (detail?.promptText) return detail.promptText;
  switch (detail?.kind) {
    case 'toolApproval': return t('attention.toolApproval');
    case 'mcpTrust': return t('attention.mcpTrust');
    case 'planReady': return t('attention.planReady');
    case 'idle': return t('attention.idle');
    case 'runaway': return t(detail.killed ? 'attention.runawayKilled' : detail.paused ? 'attention.runawayPaused' : 'attention.runaway'); // (C1565, TPT357, TPT443) fallback only — server always sends promptText
    case 'uncommitted': return _uncommittedBody(detail.blockers); // (TPT613) built here, so it is localized
    default: return t('attention.default');
  }
}

// (TPT613) Exit-backstop reasons by blocker code (the frame's blocker codes, see attention-ws.js).
const UNCOMMITTED_REASON_KEYS = {
  TASK_COMMIT_MISSING: 'attention.uncommittedNoCommit',
  TASK_WORKTREE_DIRTY: 'attention.uncommittedDirty',
  dirty_task_worktree: 'attention.uncommittedDirty',
  unmerged_branch: 'attention.uncommittedUnmerged',
  gitlink_mismatch: 'attention.uncommittedUnmerged',
};

function _uncommittedBody(codes) {
  const reasons = [];
  for (const code of Array.isArray(codes) ? codes : []) {
    const key = UNCOMMITTED_REASON_KEYS[code];
    const reason = key ? t(key) : '';
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  }
  return reasons.length ? `${t('attention.uncommitted')}: ${reasons.join('; ')}` : t('attention.uncommitted');
}

// (C1137) Banner title names the project + task, not just the task title — several projects
// run in separate Electron windows and every banner used to look alike. `state.projectName`
// (fed by the __board__ WS config frame) is '' for file backend / unset browser mode, in which
// case this degrades to the pre-C1137 `taskId: title` shape instead of a bare " · " prefix.
export function buildNotificationTitle(taskId, title) {
  const project = state.projectName ? `${state.projectName} · ` : '';
  return `${project}${taskId}: ${title}`;
}

// (C1058) The single notification trigger for both transports — called from
// attention-ws.js#handleAttentionMessage, DOM-independent (no card required). Returns whatever
// notify() returned: true when handed to a transport, false when suppressed (user in focus,
// already-seen prompt signature, category pref off, or no permission).
export function notifyTaskNeedsAttention(taskId, detail = state.attentionDetails?.get(taskId)) {
  if (!taskId) return false;

  const sig = _signature(detail);
  if (_notifiedPrompts.get(taskId) === sig) {
    debugNotifyLog('suppressed: already-notified ledger hit', taskId, sig);
    return false; // already told the user this exact prompt
  }

  // (TPT613) A live prompt in focus is on screen already; an exit-backstop verdict is on screen
  // nowhere (the session has ended), so focus never suppresses it.
  if (detail?.kind !== 'uncommitted' && isTaskInUserFocus(taskId)) {
    _notifiedPrompts.set(taskId, sig); // seen live — a later replay of the same prompt stays silent
    debugNotifyLog('suppressed: task in user focus', taskId, sig);
    return false;
  }

  const card = _taskCard(taskId);
  // Raw task title — feeds openTerminal()'s header, must NOT carry the project/taskId prefix
  // buildNotificationTitle() below adds for the banner/in-app card.
  const title = card?.querySelector?.('.card-title-inner')?.textContent?.trim()
    || state.taskTitleById?.get(taskId) || taskId;
  const status = card?.dataset?.status || inProgressName();
  const body = buildAttentionBody(detail);
  const onClick = detail?.kind === 'uncommitted'
    ? () => openLeftUncommittedTask(taskId, status)
    : () => openTaskTerminalFromNotification(taskId, status);

  // (C1137) In-app stacked card — persists until dismissed, independent of the OS banner's
  // own 30s debounce/platform auto-dismiss (see notification-center.js). Tag-keyed upsert, so
  // a repeat call for the same task never duplicates a card. Gated on the same category pref
  // as the OS transport (a user who muted attention notifications wants no surface at all).
  if (isNotifyEnabled('attention')) {
    pushNotification({ tag: taskId, title: buildNotificationTitle(taskId, title), body, onClick, category: 'attention' });
  }

  const sent = notify(buildNotificationTitle(taskId, title), body, taskId, { category: 'attention', onClick });
  debugNotifyLog('notify() returned', taskId, sent);
  if (sent) _notifiedPrompts.set(taskId, sig);
  return sent;
}

// (C1058) Clears the "already told the user" ledger entry for a task — called on
// attention-cleared/session-ended so a genuinely new prompt on the same task (even one with an
// identical signature to a since-resolved prompt) notifies again.
//
// (C1060) No longer clears the 30s notify() debounce (clearDebounce()) here — belt-and-braces
// flap damping. A server-side detector false-positive can still in principle raise/clear the
// same task in a tight loop (see terminal-session.js's feedAttentionChunk comment for the C1060
// root cause this guards); with the debounce left untouched across a clear, that can never
// produce more than one OS notification per 30s per task, no matter how many raise/clear cycles
// happen. A genuinely different question still notifies immediately regardless — see
// attention-ws.js#handleAttentionMessage, which calls clearDebounce() itself whenever
// `promptText` actually changed, independent of this function.
export function forgetTaskAttention(taskId) {
  if (!taskId) return;
  _notifiedPrompts.delete(taskId);
}

// (C1125) The tag notify() is called with above IS the taskId on this path — a send the OS
// silently dropped (e.g. the unsigned-bundle condition in main.js) must not leave the ledger
// thinking the user was told, or the task goes permanently silent until attention-cleared/
// session-ended happens to fire. See notifications.js#onNotifyFailed.
onNotifyFailed((taskId) => forgetTaskAttention(taskId));
