'use strict';

const MAX_PLAN_CHARS = 2000;

function _formatChange(c) {
  const t = c && c.task;
  if (!t) return null;
  const verb = c.type === 'new' ? 'new' : 'mod';
  const id = t.id ? `${t.id}` : '';
  const title = (t.title || '').trim();
  const desc = (t.description || '').trim().slice(0, 200);
  let line = `[${verb}]${id ? ` ${id}` : ''} — ${title}`;
  if (desc) line += `\n  ${desc}`;
  return line;
}

function buildPlanText(session, changes) {
  const objective = ((session.messages && session.messages[0] && session.messages[0].content) || '').trim();
  const lines = changes.map(_formatChange).filter(Boolean);
  let text = '';
  if (objective) text += `**Objective:**\n${objective}\n\n`;
  text += `**Proposed changes (${lines.length}):**\n${lines.join('\n')}`;
  if (text.length > MAX_PLAN_CHARS) {
    text = text.slice(0, MAX_PLAN_CHARS - 14) + '…[truncated]';
  }
  return text;
}

async function postPlanComments(backend, session, changes) {
  if (typeof backend.createTaskComment !== 'function') return;
  const text = buildPlanText(session, changes);
  const targetKeys = new Set();
  for (const c of changes) {
    if (c && c.task && c.task.id) targetKeys.add(String(c.task.id));
  }
  for (const c of changes) {
    const p = c && c.task && c.task.parentId;
    if (typeof p === 'string' && p) targetKeys.add(p);
  }
  await Promise.allSettled([...targetKeys].map(key =>
    backend.createTaskComment(key, text, 'resolution')
      .catch(err => console.warn(`[plan-comment] ${key} failed: ${err.message}`)),
  ));
}

module.exports = { buildPlanText, postPlanComments };
