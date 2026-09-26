'use strict';

// ── WebSocket broadcast module ──
// Singleton. Call init(wss) once from index.js.
// Import and call emit* helpers from any server module.

const config = require('./config');

let _wss = null;

// Track recent assignments: taskId → { assignee, at }
const _recentAssignments = new Map();

// Prune stale entries every 30s. unref() so requiring this module (e.g. websocket.test.js,
// C1057) never keeps a test process alive just because of this timer — the real server
// process always has other live handles (the HTTP/WS listener) keeping it running anyway.
const _recentAssignmentsPruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [taskId, entry] of _recentAssignments) {
    if (now - entry.at >= 60000) _recentAssignments.delete(taskId);
  }
}, 30000);
if (_recentAssignmentsPruneTimer.unref) _recentAssignmentsPruneTimer.unref();

function init(wss) {
  _wss = wss;
}

function broadcast(type, payload) {
  if (!_wss) return;
  const msg = JSON.stringify({ type, ...payload });
  for (const client of _wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// (C1057) Project-scoped broadcast. Skips a client only when BOTH it and the event carry a
// project stamp and they differ — an unstamped client (browser mode, terminal/objective
// sockets) still receives everything, exactly like broadcast() above, so this is a strict
// narrowing with zero behavior change for every pre-existing consumer. Clients get their
// `_projectPath` stamp on the __board__ and __attention__ WS branches only
// (ws-handlers.js) — see ai/architecture/tt-websocket.md.
function broadcastToProject(projectPath, type, payload) {
  if (!_wss) return;
  const msg = JSON.stringify({ type, ...payload });
  for (const client of _wss.clients) {
    if (client.readyState !== 1) continue;
    if (projectPath && client._projectPath && client._projectPath !== projectPath) continue;
    client.send(msg);
  }
}

// (C1259) projectPath is optional on every emit* below — omitting it keeps the exact
// prior unscoped broadcast() behavior (every existing caller). Passing it routes through
// broadcastToProject() (C1057, already used by broadcastKbReindexResult below) instead,
// so a card update sends one targeted frame to windows on THIS project instead of every
// open window regardless of project — a browser-mode multi-tab or multi-project Electron
// setup no longer makes every task mutation fan out everywhere.
function emitTaskCreated(task, projectPath) {
  if (projectPath) broadcastToProject(projectPath, 'task:created', { task });
  else broadcast('task:created', { task });
}

// opts: { assigneeChanged: bool } — set isNewlyAssigned flag when assignee changed to current user
function emitTaskUpdated(task, opts, projectPath) {
  const payload = { task };
  if (opts && opts.assigneeChanged && task.assignee != null && task.assignee === config.USER_ID) {
    payload.isNewlyAssigned = true;
    _recentAssignments.set(task.id, { assignee: task.assignee, at: Date.now() });
  }
  if (projectPath) broadcastToProject(projectPath, 'task:updated', payload);
  else broadcast('task:updated', payload);
}

function emitTaskDeleted(id, projectPath) {
  if (projectPath) broadcastToProject(projectPath, 'task:deleted', { id });
  else broadcast('task:deleted', { id });
}

function emitTasksFinalized(changes, projectPath) {
  const taskIds = changes.map(c => c.task && c.task.id).filter(Boolean);
  const payload = { count: changes.length, taskIds };
  if (projectPath) broadcastToProject(projectPath, 'tasks:finalized', payload);
  else broadcast('tasks:finalized', payload);
}

// Record a task assignment (called from finalize path)
function recordAssignment(taskId, assignee) {
  if (assignee != null && assignee === config.USER_ID) {
    _recentAssignments.set(taskId, { assignee, at: Date.now() });
  }
}

// Returns taskIds assigned to current user within last 60s
function getRecentAssignments() {
  const now = Date.now();
  const result = [];
  for (const [taskId, entry] of _recentAssignments) {
    if (now - entry.at < 60000) result.push(taskId);
    else _recentAssignments.delete(taskId);
  }
  return result;
}

function emitObjectiveQueueState({ active, pending, circuitState }) {
  broadcast('objective-queue-depth', { active, pending, circuitState });
}

// (C1230) Named helper for the KB re-index result frame. Deliberately emits the EXISTING
// `reindex-kb-result` type (C1218) rather than a new event — task-board.js's
// handleKbWsMessage() already renders a progress+result toast for it in both browser and
// Electron, so a second event would need a second client handler and risk a double toast.
// payload: { success, tagsUpdated, filesUpdated, skipped, errors, error? } — same shape
// kb-auto-reindex.js already broadcasts; `auto:true` is stamped here so callers don't repeat it.
function broadcastKbReindexResult(projectPath, payload) {
  broadcastToProject(projectPath || '', 'reindex-kb-result', { auto: true, ...payload });
}

function emitApiStatus(state, message, pendingCount = 0, pendingTaskIds = []) {
  broadcast('api-status', { state, message: message || null, pendingCount, pendingTaskIds });
}

// (C1565) Process-group descendant-count watchdog alert. Project-scoped for the same
// reason attention-needed/session-ended are (C1057): task keys collide across two open
// Electron project windows. Deliberately a distinct frame type, not attention-needed —
// the attention pipeline's !session.alive guard, ATTENTION_STALE_MS auto-clear, and
// attention-seen dismissal semantics all actively fight a "still running, growing"
// alert. Rides the same __attention__/__board__ sockets for free (broadcastToProject),
// same route voice-model:* took (C1193) — see tt-websocket.md.
function emitSessionRunaway(projectPath, { taskId, pid, count, threshold, promptText, killed }) {
  broadcastToProject(projectPath || '', 'session-runaway', { taskId, pid, count, threshold, promptText: promptText || '', killed: !!killed });
}

// (C1176) Voice-model download progress. Deliberately unscoped broadcast(), NOT
// broadcastToProject(): the model store (vendor/voice-models/) is machine-wide, shared by every
// project via config.USER_DATA_ROOT — see voice-model-manager.js — so any open window should
// see a shared download's progress, not just the one that started it. ws-handlers.js is the
// only caller; voice-model-manager.js itself stays WS-agnostic and reports through a plain
// onProgress callback.
function emitVoiceModelProgress(p) {
  broadcast('voice-model:progress', p);
}
function emitVoiceModelComplete({ modelId, dir, totalBytes, skipped, durationMs }) {
  broadcast('voice-model:complete', { modelId, dir, totalBytes, skipped: !!skipped, durationMs });
}
function emitVoiceModelError({ modelId, code, message }) {
  broadcast('voice-model:error', { modelId, code, message });
}
// (C1197) Delete completed — every open window's Voice tab drops the stale ready badge.
function emitVoiceModelDeleted({ modelId, dir, freedBytes }) {
  broadcast('voice-model:deleted', { modelId, dir, freedBytes });
}

// (TPT345) Task-branch merge job frames + the completion-time dirty-worktree warning.
// Project-scoped (broadcastToProject): the merge runs against one project's checkout, so
// only that project's windows care. Rides __board__ (browser) and __attention__
// (Electron) — see ai/architecture/tt-websocket.md § merge:* frames.
function emitMergeProgress(projectPath, payload) { broadcastToProject(projectPath || '', 'merge:progress', { projectPath: projectPath || '', ...payload }); }
function emitMergeConflict(projectPath, payload) { broadcastToProject(projectPath || '', 'merge:conflict', { projectPath: projectPath || '', ...payload }); }
function emitMergeDone(projectPath, payload) { broadcastToProject(projectPath || '', 'merge:done', { projectPath: projectPath || '', ...payload }); }
function emitMergeError(projectPath, payload) { broadcastToProject(projectPath || '', 'merge:error', { projectPath: projectPath || '', ...payload }); }
function emitWorktreeDirtyOnComplete(projectPath, payload) { broadcastToProject(projectPath || '', 'worktree-dirty-on-complete', { projectPath: projectPath || '', ...payload }); }

module.exports = { init, broadcast, broadcastToProject, emitMergeProgress, emitMergeConflict, emitMergeDone, emitMergeError, emitWorktreeDirtyOnComplete, emitTaskCreated, emitTaskUpdated, emitTaskDeleted, emitTasksFinalized, recordAssignment, getRecentAssignments, emitObjectiveQueueState, emitApiStatus, emitVoiceModelProgress, emitVoiceModelComplete, emitVoiceModelError, emitVoiceModelDeleted, broadcastKbReindexResult, emitSessionRunaway };
