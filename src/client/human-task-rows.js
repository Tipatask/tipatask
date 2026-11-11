// ── Left-nav human task rows (TPT9201) ──
// Which tasks get a row in the left nav's human section, and what a task write means for those
// rows. Reads only status-registry.js, so the rules run under node without a DOM.
import { inProgressName } from './status-registry.js';

const HUMAN = 'HUMAN';
// What a row reads. A cached board row is merged with these and nothing else: a saved task can
// carry transport extras (_pendingSync, parentRescheduled) that do not belong in a snapshot.
const ROW_FIELDS = ['status', 'title', 'category', 'assignee'];

// Task keys are a prefix plus a number: TPT9 sorts before TPT10.
const compareKeys = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

// The People filter's All Tasks scope widens the fetch to every member: a teammate's task is in
// the maps then, but it is not "my" task. An unknown user fails open, as the board does.
function isMine(assignee, currentUserId) {
  return assignee == null || currentUserId == null || Number(assignee) === Number(currentUserId);
}

// Rows for the left nav: HUMAN tasks of the current user in the in-progress role, by key. A task
// with a live or lost session is already a row of the agent section above.
// `s` is the state shape; `openId` is the task whose workspace is on screen.
export function humanInProgressRows(s, openId = null) {
  const inProgress = inProgressName();
  if (!inProgress) return [];
  return [...s.taskCategoryById]
    .filter(([id, category]) => category === HUMAN
      && s.taskStatusById.get(id) === inProgress
      && !s.activeSessions.has(id)
      && !s.lostSessions.has(id)
      && isMine(s.taskAssigneeById.get(id), s.currentUserId))
    .map(([id]) => id)
    .sort(compareKeys)
    .map((id) => ({ taskId: id, title: s.taskTitleById.get(id) || '', isOpen: id === openId }));
}

// Every HUMAN task the board knows, in any status: the ids a status refresh has to cover, since
// any of them can move into or out of the in-progress role.
export function knownHumanTaskIds(categoryById) {
  return [...categoryById].filter(([, category]) => category === HUMAN).map(([id]) => id);
}

// A drill-down fetch lists one objective's children and says nothing about the rest of the board,
// so the HUMAN tasks it omits carry over from `prev` into the `next` maps. Additive, like the
// session backfill at the same build site: it only fills ids the fetch left out.
export function keepHumanTaskEntries(next, prev) {
  for (const id of knownHumanTaskIds(prev.taskCategoryById)) {
    if (next.taskCategoryById.has(id)) continue;
    next.taskCategoryById.set(id, HUMAN);
    next.taskAssigneeById.set(id, prev.taskAssigneeById.get(id) ?? null);
    if (!next.taskStatusById.has(id) && prev.taskStatusById.has(id)) next.taskStatusById.set(id, prev.taskStatusById.get(id));
    if (!next.taskTitleById.has(id) && prev.taskTitleById.has(id)) next.taskTitleById.set(id, prev.taskTitleById.get(id));
  }
}

// The fields of a task write the rail needs, or null when the task neither is nor was HUMAN — the
// board's CODING writes (a card drag sends several per drop) stay out of this path. `task` may be
// partial: the offline stub, or a bare { id, status } from a To-Do row.
export function humanTaskWritePatch(task, categoryById) {
  if (!task?.id) return null;
  const id = String(task.id);
  if (task.category !== HUMAN && categoryById.get(id) !== HUMAN) return null;
  const patch = { id };
  for (const field of ROW_FIELDS) {
    if (task[field] !== undefined) patch[field] = task[field];
  }
  return patch;
}
