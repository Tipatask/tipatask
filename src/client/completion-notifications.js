// ── Task-completion notifications (C1355) ──
//
// Third OS-notification producer, alongside terminal attention (attention-notifications.js) and
// Objective Chat completion (chat-ui.js). Fires when a task's status transitions INTO the
// project's complete role — see ai/architecture/tt-notifications.md § C1355. Mirrors
// attention-notifications.js's structure deliberately: domain logic separate from transport,
// focus suppression reused (not reimplemented), in-app card pushed alongside the OS banner.
//
// Role resolution goes through status-registry.js's isCompleteName() — statuses are per-project
// and renameable (C1184/C1187), never a hardcoded 'completed' string.
//
// Tag is `completed-${taskId}`, NOT the bare taskId attention-notifications.js uses — a task
// usually completes shortly after its last attention prompt, so sharing a tag would let
// pushNotification() overwrite the still-visible attention card and let notify()'s 30s per-tag
// debounce swallow the completion banner outright.

import { notify, debugNotifyLog, isNotifyEnabled } from './notifications.js';
import { t } from './i18n.js';
import { pushNotification, dismissNotification } from './notification-center.js';
import { isCompleteName } from './status-registry.js';
import { buildNotificationTitle, isTaskInUserFocus, openTaskTerminalFromNotification } from './attention-notifications.js';
import state from './state.js';
import { showToast } from './utils.js';

// (C1355) "Already notified this completion" ledger — three separate code paths in template.html
// converge on the same completion event (browser board WS, Electron task-state event, and the
// payload-less tasks-updated poll fallback), and without this a single completion could notify up
// to three times. Cleared when the task's status leaves the complete role (see
// forgetTaskCompletion below), so a reopened-then-recompleted task notifies again.
const _notifiedCompletions = new Set();
const _openingTerminals = new Set();

function _tag(taskId) {
  return `completed-${taskId}`;
}

function _projectPath() {
  try {
    const electronPath = window.electronAPI?.getProjectPath?.();
    if (electronPath) return electronPath;
    if (typeof location !== 'undefined') return new URLSearchParams(location.search).get('projectPath');
  } catch (_) {}
  return null;
}

function _showMissingSession() {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    showToast(t('terminal.sessionMissing'), 'error');
  }
}

// Both notification surfaces share this action. The native transport has already focused the
// originating project window; the path check also protects an in-app card left behind after a
// project switch. Refreshing /api/sessions restores an exited session that a task-status update
// removed from the local sets. A completion click never launches a new agent or selects Edit.
function _completionAction(taskId, tag) {
  const originPath = _projectPath();
  const startedAt = state.sessionMeta?.get(taskId)?.startedAt;
  return () => {
    const currentPath = _projectPath();
    if (originPath && currentPath && originPath !== currentPath) {
      dismissNotification(tag);
      return;
    }
    dismissNotification(tag);
    try { window.electronAPI?.focusSelf?.(); } catch (_) {}
    if (_openingTerminals.has(taskId)) return;
    _openingTerminals.add(taskId);
    Promise.resolve().then(() => window.TipTask?.fetchActiveSessions?.())
      .then(() => {
        if (originPath && _projectPath() !== originPath) return;
        const hasSession = state.activeSessions?.has(taskId) || state.exitedSessions?.has(taskId);
        const currentStartedAt = state.sessionMeta?.get(taskId)?.startedAt;
        if (!hasSession || (startedAt && currentStartedAt !== startedAt)) {
          _showMissingSession();
          return;
        }
        openTaskTerminalFromNotification(taskId, state.taskStatusById?.get(taskId),
          { reconnectOnly: true, sessionStartedAt: startedAt || currentStartedAt });
      })
      .catch((err) => {
        debugNotifyLog('completion terminal open failed', taskId, err);
        _showMissingSession();
      })
      .finally(() => _openingTerminals.delete(taskId));
  };
}

// Direct entry point — fires unconditionally (module-load ledger + focus suppression aside).
// Prefer maybeNotifyCompletion() below for the actual WS wiring; this is the piece that mirrors
// attention-notifications.js#notifyTaskNeedsAttention's tail (pushNotification + notify pair).
export function notifyTaskCompleted(taskId, { title } = {}) {
  if (!taskId) return false;

  if (_notifiedCompletions.has(taskId)) {
    debugNotifyLog('completion suppressed: already-notified ledger hit', taskId);
    return false;
  }
  // Marked before the focus check, same pattern as attention-notifications.js's
  // notifyTaskNeedsAttention: a completion the user is already looking at still counts as "told",
  // so a later replay of the same completion (e.g. the tasks-updated poll fallback re-observing
  // an already-known status) stays silent instead of notifying twice.
  _notifiedCompletions.add(taskId);

  if (isTaskInUserFocus(taskId)) {
    debugNotifyLog('completion suppressed: task in user focus', taskId);
    return false;
  }

  const displayTitle = buildNotificationTitle(taskId, title || taskId);
  const body = t('completed.default');
  const tag = _tag(taskId);
  const onClick = _completionAction(taskId, tag);

  if (isNotifyEnabled('completed')) {
    pushNotification({ tag, title: displayTitle, body, onClick, category: 'completed' });
  }

  const sent = notify(displayTitle, body, tag, { category: 'completed', onClick });
  debugNotifyLog('notify() returned', taskId, sent);
  return sent;
}

// Clears the ledger entry for a task once its status leaves the complete role — mirrors
// attention-notifications.js#forgetTaskAttention. Deliberately does NOT clear notify()'s own
// per-tag debounce, same flap-damping rationale as the attention path (C1060).
export function forgetTaskCompletion(taskId) {
  if (!taskId) return;
  _notifiedCompletions.delete(taskId);
}

// Transition helper — only a known previous non-complete status proves a transition INTO the
// complete role. A first observation of an already-complete task is a silent baseline.
// Returns whatever notifyTaskCompleted() returned, or false for a non-transition/non-complete
// status.
export function maybeNotifyCompletion(taskId, prevStatus, nextStatus, title) {
  if (!taskId) return false;
  if (!isCompleteName(nextStatus)) {
    forgetTaskCompletion(taskId);
    return false;
  }
  if (typeof prevStatus !== 'string' || !prevStatus.trim() || isCompleteName(prevStatus)) return false;
  return notifyTaskCompleted(taskId, { title });
}

// Shared by the browser WS, Electron task-state event, and status-poll fallback. The status map
// is also used for nav/render state, so record every observation even when it cannot notify.
// Return the previous status for the objective-tab sync in the two event paths.
export function observeTaskStatusForCompletion(statusById, taskId, nextStatus, title) {
  const prevStatus = statusById.get(taskId);
  if (nextStatus !== undefined) {
    statusById.set(taskId, nextStatus);
    maybeNotifyCompletion(taskId, prevStatus, nextStatus, title);
  }
  return prevStatus;
}
