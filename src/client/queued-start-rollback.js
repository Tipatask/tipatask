import { api } from './api-client.js';
import { inProgressName } from './status-registry.js';

// Only the renderer that made a batch start owns its rollback. Keep values, not task objects:
// board updates may mutate those objects while the start waits for a device slot.
const pending = new Map();
const RETAIN_MS = 24 * 60 * 60 * 1000;

export function forgetQueuedStart(taskId) {
  const entry = pending.get(taskId);
  if (entry) clearTimeout(entry.timer);
  pending.delete(taskId);
}

export function clearQueuedStarts() {
  for (const id of pending.keys()) forgetQueuedStart(id);
}

export async function trackQueuedStart(task, start, { restoreAgent = false, agent = task.agentAssignee } = {}) {
  forgetQueuedStart(task.id);
  const entry = {
    status: task.status, agent: task.agentAssignee || null,
    expectedStatus: inProgressName(), expectedAgent: agent || null, restoreAgent,
  };
  pending.set(task.id, entry);
  entry.timer = setTimeout(() => {
    if (pending.get(task.id) === entry) forgetQueuedStart(task.id);
  }, RETAIN_MS);
  try {
    const result = await start();
    if (result?.ok && result.message?.type === 'session-queued') return result;
    if (pending.get(task.id) === entry) forgetQueuedStart(task.id);
    return result;
  } catch (err) {
    if (pending.get(task.id) === entry) forgetQueuedStart(task.id);
    throw err;
  }
}

// Called for every session-ended, before toast coalescing. A repeated broadcast cannot write
// twice, and a successful attach/new start can invalidate an outstanding task read.
export function handleQueuedStartEnded(msg) {
  const entry = pending.get(msg?.taskId);
  if (!entry) return;
  if (msg.reason !== 'start-failed' || msg.error?.type !== 'error') {
    forgetQueuedStart(msg.taskId);
    return;
  }
  if (entry.restoring) return;
  entry.restoring = true;
  void (async () => {
    try {
      const task = await api.tasks.get(msg.taskId);
      if (pending.get(msg.taskId) !== entry || task?.status !== entry.expectedStatus) return;
      const body = {};
      if (entry.status && entry.status !== entry.expectedStatus) body.status = entry.status;
      if (entry.restoreAgent && (task.agentAssignee || null) === entry.expectedAgent) {
        body.agent_assignee = entry.agent;
      }
      if (Object.keys(body).length) await api.tasks.update(msg.taskId, body);
    } catch { /* Best effort, like direct-refusal rollback; the refusal toast remains visible. */ }
    finally {
      if (pending.get(msg.taskId) === entry) forgetQueuedStart(msg.taskId);
    }
  })();
}
