'use strict';

const TODO_JSON_BLOCK_RE = /^([\s\S]*?```json\s*\n)([\s\S]*)(```[\s\S]*)$/;

// `startName` (C1187) — this project's workflow-start role name (fetchStatusContext()
// .roles.start), defaulting to the legacy literal 'pending' so a caller not yet threading
// it degrades to today's exact behavior.
function forcePendingProposalStatuses(changes, source = 'objective-proposal', startName = 'pending') {
  if (!Array.isArray(changes)) return changes;
  for (const change of changes) {
    const task = change && change.task;
    if (!task) continue;
    // C1072: only "new" proposals get force-pinned to the start status. A "modified"
    // proposal must never carry status — it flips a live in_progress/on_fire task back to
    // the start status downstream (Object.assign(existing, card.task)).
    if (change.type !== 'new') {
      delete task.status;
      continue;
    }
    if (task.status !== startName) {
      console.warn(`[${source}] forcing proposed task ${task.id || task.title || '<new>'} status "${task.status || '<missing>'}" to "${startName}"`);
    }
    task.status = startName;
  }
  return changes;
}

function forcePendingTodoPayloadNewTasks(content, source = 'todo-write', startName = 'pending') {
  const match = typeof content === 'string' ? content.match(TODO_JSON_BLOCK_RE) : null;
  if (!match) return content;

  let parsed;
  try {
    parsed = JSON.parse(match[2]);
  } catch {
    return content;
  }
  if (!parsed || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.newTaskIds)) return content;

  const newTaskIds = new Set(parsed.newTaskIds.map(id => String(id || '')).filter(Boolean));
  if (newTaskIds.size === 0) return content;

  for (const task of parsed.tasks) {
    if (!task || !newTaskIds.has(String(task.id || ''))) continue;
    if (task.status !== startName) {
      console.warn(`[${source}] forcing new proposed task ${task.id || task.title || '<new>'} status "${task.status || '<missing>'}" to "${startName}"`);
    }
    task.status = startName;
  }

  return match[1] + JSON.stringify(parsed, null, 2) + '\n' + match[3];
}

module.exports = {
  forcePendingProposalStatuses,
  forcePendingTodoPayloadNewTasks,
};
