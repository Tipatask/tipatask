'use strict';

const { isTaskKeyLike } = require('./task-key-format');

const TODO_JSON_BLOCK_RE = /^([\s\S]*?```json\s*\n)([\s\S]*)(```[\s\S]*)$/;

function badSplitOrigin(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

// Called by PUT /api/todo before overwriteRawWithRemap() creates/finalizes children.
// Validate the save's actual new rows before promoting the existing origin. The
// snapshot may be assignee-scoped and omit the origin, so the backend owns the PATCH.
async function promoteSplitOriginInTodo(content, backend) {
  const match = typeof content === 'string' ? content.match(TODO_JSON_BLOCK_RE) : null;
  if (!match) return content;
  let data;
  try { data = JSON.parse(match[2]); } catch { return content; }
  if (!data || typeof data !== 'object') return content;
  if (!Object.prototype.hasOwnProperty.call(data, 'splitOrigin')) return content;

  const { originKey, childIds } = data.splitOrigin || {};
  if (!isTaskKeyLike(originKey) || !Array.isArray(childIds) || childIds.length === 0 ||
      !Array.isArray(data.tasks) || !Array.isArray(data.newTaskIds)) {
    throw badSplitOrigin('Invalid split origin save payload');
  }
  const ids = childIds.map(String);
  const newIds = new Set(data.newTaskIds.map(String));
  const rows = new Map(data.tasks.map(task => [String(task.id), task]));
  if (new Set(ids).size !== ids.length || ids.length !== newIds.size ||
      ids.some(id => id === originKey || !newIds.has(id) || rows.get(id)?.parentId !== originKey)) {
    throw badSplitOrigin('Split children must be new tasks linked to the origin');
  }

  const origin = await backend.getTask(originKey);
  if (!origin || origin.isReservation) {
    const error = new Error(`Split origin ${originKey} not found`);
    error.statusCode = 404;
    throw error;
  }
  const promoted = await backend.updateTask(originKey, { isObjective: true });
  if (!promoted) {
    const error = new Error(`Split origin ${originKey} not found`);
    error.statusCode = 404;
    throw error;
  }

  const snapshotOrigin = rows.get(originKey);
  if (snapshotOrigin) snapshotOrigin.isObjective = true;
  delete data.splitOrigin;
  return match[1] + JSON.stringify(data, null, 2) + '\n' + match[3];
}

module.exports = { promoteSplitOriginInTodo };
