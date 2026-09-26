// Task-activity notifications use an activity-specific tag so they cannot overwrite
// attention banners. The ledger keys on notification row id: one task can have several
// unread events, and both WebSocket channels may deliver the same row.

import { notify, debugNotifyLog, isNotifyEnabled } from './notifications.js';
import { pushNotification } from './notification-center.js';
import { buildNotificationTitle, isTaskInUserFocus } from './attention-notifications.js';

const _notifiedIds = new Set();

function _tag(taskId) {
  return `activity-${taskId}`;
}

// Direct entry point — fires unconditionally (ledger + focus suppression aside). `latest` is
// the newest unread row for this task, as reduced by task-change-poll.js#_reduceActivity:
// { id, title, body, event_type, actor, created_at }.
export function notifyTaskActivity(taskId, { latest, taskTitle } = {}) {
  if (!taskId || !latest) return false;

  if (_notifiedIds.has(latest.id)) {
    debugNotifyLog('activity suppressed: already-notified ledger hit', taskId, latest.id);
    return false;
  }
  // Marked before the focus check, same pattern as completion-notifications.js: activity the
  // user is already looking at still counts as "told", so a later replay of the same row
  // (e.g. a duplicate WS dispatch, or a poll tick that re-sends an unchanged snapshot) stays
  // silent instead of notifying twice.
  _notifiedIds.add(latest.id);

  if (isTaskInUserFocus(taskId)) {
    debugNotifyLog('activity suppressed: task in user focus', taskId);
    return false;
  }

  const displayTitle = buildNotificationTitle(taskId, taskTitle || taskId);
  const body = latest.body || latest.title || '';
  const tag = _tag(taskId);

  if (isNotifyEnabled('activity')) {
    pushNotification({ tag, title: displayTitle, body, category: 'activity' });
  }

  const sent = notify(displayTitle, body, tag, { category: 'activity' });
  debugNotifyLog('notify() returned', taskId, sent);
  return sent;
}

// No forgetTaskActivity() counterpart to completion-notifications.js's forgetTaskCompletion():
// a notification row's id is immutable — unlike "is this task complete", which can toggle
// back to incomplete and genuinely needs to fire again, a given unread row is only ever
// notified once, period. The ledger just grows for the life of the page session, same as
// attention-notifications.js's _notifiedPrompts and completion-notifications.js's
// _notifiedCompletions already do.

// test-only
export function _resetActivityNotifications() {
  _notifiedIds.clear();
}
