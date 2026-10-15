// (TPT662) Notification text for an offline-queued write the reconnect replay could not
// save. The server/main process reports such an entry as
// { op, taskId, title, code, statusCode, message } (api-backend.js `_drainPendingMutations()`
// `dropped`); this module turns it into the { tag, title, body } a notification card needs.
// Pure: no DOM, no imports — `t` is injected so plain Node tests cover it.

const TAG_GATE_CODE = 'TAGS_UNREGISTERED';

export function droppedMutationTag(entry) {
  return `mutation-dropped-${entry && entry.taskId ? entry.taskId : 'unknown'}`;
}

// A temporary create id (`tmp-…`) means nothing to the user — the title is the only label.
function taskLabel(entry) {
  const title = typeof entry.title === 'string' ? entry.title.trim() : '';
  const isTmp = typeof entry.taskId === 'string' && entry.taskId.startsWith('tmp-');
  if (entry.op === 'create' || isTmp) return title || entry.taskId || '';
  if (!entry.taskId) return title;
  return title ? `${entry.taskId} · ${title}` : entry.taskId;
}

export function describeDroppedMutation(entry, t) {
  const e = entry || {};
  const msg = typeof e.message === 'string' && e.message.trim() ? e.message.trim() : (e.code || 'rejected');
  const task = taskLabel(e);
  let body = e.op === 'create'
    ? t('queue.droppedCreate', { task, msg })
    : t('queue.droppedBody', { task, msg });
  if (e.code === TAG_GATE_CODE) body += `\n${t('queue.droppedTagHint')}`;
  return { tag: droppedMutationTag(e), title: t('queue.droppedTitle'), body };
}
