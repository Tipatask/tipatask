// (TPT9417) The Task App's side of the API's task edit rule (TPT9415). The API judges every task
// row for the signed-in user and sends the answer as `can_edit`; fromApi() (src/server/
// api-backend.js) maps it to `canEdit`. It is true for the task's creator, its assignee, the
// project owner, a system admin and a member whose project role ranks above the assignee's, and
// false for another member's task assigned to someone of the same or a higher role — and for every
// task when the user's role cannot write tasks at all. The board card's status select, the bulk
// action bar and the Task Edit modal all ask taskEditLocked(); none compares assignees itself.
//
// Pure: no DOM, no state import, so the card, the board and the Task Edit modal (which must not
// import the board or the cards) share it. Callers pass the current user id and `t`.

// The 403 body reason (and, from api-backend.js, the error code) of a write the rule refused.
export const TASK_EDIT_REFUSAL = 'task_role_rank';

// True only when the API said this user may not change the task. A task without the flag — a
// row from an API older than TPT9415, an offline-created stub, an in-memory proposal — is not
// locked: the API stays the authority and refuses a write the rule forbids (isTaskEditRefusal()).
export function taskEditLocked(task) {
  return task?.canEdit === false;
}

// The i18n key of the reason a locked task shows. Another member's task names the rule. A task the
// rule cannot be stopping (unassigned, or the user's own) is locked only because the user's project
// role cannot change tasks. An unknown current user counts as another member, like the assignee
// checks elsewhere on the board.
export function taskEditLockKey(task, currentUserId) {
  const assignee = task?.assignee;
  const own = assignee == null || (currentUserId != null && Number(assignee) === Number(currentUserId));
  return own ? 'task.editLockedRole' : 'task.editLocked';
}

// The localized reason for the card's locked status select, the bulk bar and a refused write.
export function taskEditLockText(task, currentUserId, t) {
  return t(taskEditLockKey(task, currentUserId));
}

// Whether a failed task write is the rule's refusal: api-backend.js tags it with `code` (carried
// over IPC and the local HTTP routes) and keeps the API body; a message is the last resort for a
// path that kept only the text (`API 403: {"error":"forbidden","reason":"task_role_rank"}`).
export function isTaskEditRefusal(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === TASK_EDIT_REFUSAL) return true;
  if (err.body && typeof err.body === 'object' && err.body.reason === TASK_EDIT_REFUSAL) return true;
  const message = typeof err.message === 'string' ? err.message : '';
  return message.includes(`"reason":"${TASK_EDIT_REFUSAL}"`);
}
