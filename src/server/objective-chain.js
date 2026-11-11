'use strict';

// Objective chains are bounded to one descendant tree and admit one child per decision.
function selectNextObjectiveTask(parent, rows, { statusRoles, liveTaskIds = [], currentUserId = null, isImageTask = () => false } = {}) {
  const tasks = Array.isArray(rows) ? rows : [];
  const byKey = new Map(tasks.map(t => [t.id, t]));
  const children = task => tasks.filter(t => task.dbId != null && t.parentDbId != null && String(t.parentDbId) === String(task.dbId));
  const descendants = [];
  const seen = new Set([parent.id]);
  const visit = task => {
    for (const child of children(task)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      descendants.push(child);
      visit(child);
    }
  };
  visit(parent);
  const complete = task => task.status === statusRoles.complete;
  const stopped = task => task.status === statusRoles.canceled || task.status === 'on_fire';
  const result = (reason, task = null, skipped = []) => ({ tasks: task ? [task] : [], reason, skipped });
  if (stopped(parent) || descendants.some(stopped)) return result('objective_stopped');
  if (!descendants.length) return result('no_children');
  if (descendants.every(complete)) return result('objective_complete');
  if (complete(parent)) return result('parent_closed');
  const open = descendants.filter(t => !complete(t));
  const live = new Set(liveTaskIds);
  // Preparation containers can remain open while their leaves execute. An executing or
  // interrupted leaf still blocks every other start, including across nested containers.
  if (open.some(t => !children(t).length && live.has(t.id))) return result('objective_busy');
  if (open.some(t => t.status !== statusRoles.start && !(children(t).length && t.status === statusRoles.in_progress))) return result('objective_stopped');
  const skipped = [];
  const candidates = open.filter(t => !children(t).length).sort((a, b) =>
    (Number(a.priority) || 0) - (Number(b.priority) || 0)
    || (Number(a.order) || 0) - (Number(b.order) || 0)
    || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  for (const task of candidates) {
    const reason = task.isReservation ? 'reservation'
      : task.category !== 'CODING' ? 'category'
      : task.agentAssignee === 'human' ? 'human'
      : isImageTask(task) ? 'image_task'
      : currentUserId != null && task.assignee != null && String(task.assignee) !== String(currentUserId) ? 'other_assignee'
      : !(task.dependencies || []).every(key => complete(byKey.get(key) || {})) ? 'deps_open' : null;
    if (!reason) return result('objective_child', task, skipped);
    skipped.push({ key: task.id, reason });
  }
  return result('objective_blocked', null, skipped);
}

module.exports = { selectNextObjectiveTask };
