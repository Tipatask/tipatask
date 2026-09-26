'use strict';

// Module-level Map<taskId, Set<tagName>> — survives across task spawns within
// the same Task App server process. Populated by objective-chat tool_use parsing
// (claude-session.js) and consulted at spawn time (terminal-session.js,
// claude-session.js) to pre-inject previously-fetched arch docs.
const _taskTagCache = new Map();

function getTagsForTask(taskId) {
  return _taskTagCache.get(taskId) || new Set();
}

function addTagsForTask(taskId, tags) {
  if (!tags || tags.length === 0) return;
  let set = _taskTagCache.get(taskId);
  if (!set) { set = new Set(); _taskTagCache.set(taskId, set); }
  for (const t of tags) {
    if (t && t.startsWith('tt-')) set.add(t);
  }
}

module.exports = { getTagsForTask, addTagsForTask };
