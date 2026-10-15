// (TPT672) One-task reads for actions that open something from a task key without a rendered
// card — task-card.js startTaskById() (the /start-task dispatch) and template.html's Objective
// hand-off + parent-pane fetch (reached as window.TipTask.taskFetch). Goes through
// api.tasks.get(), so Electron gets the 403 marker conversion and the { _ipcError } envelope,
// and the browser gets the same fetch with the project header.

import { api, isTransportError, errorDetail } from './api-client.js';
import { t } from './i18n.js';

// Resolves { task } or { message } — a localized toast text, never a raw IPC error:
// 403/404 → unavailable, no answer → common.networkError, any other failure → failKey
// ({ id, msg }) with the server's text, a null task → not found.
export async function loadTaskForAction(taskId, failKey) {
  let task;
  try {
    task = await api.tasks.get(taskId);
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 404) {
      return { message: t('modal.errTaskUnavailable', { id: taskId }) };
    }
    return { message: t(isTransportError(err) ? 'common.networkError' : failKey, { id: taskId, msg: errorDetail(err) }) };
  }
  if (!task) return { message: t('modal.errTaskNotFound', { id: taskId }) };
  return { task };
}

// The task, or null on any failure — for reads that must never break the caller.
export async function fetchTaskOrNull(taskId) {
  try {
    return (await api.tasks.get(taskId)) || null;
  } catch {
    return null;
  }
}
