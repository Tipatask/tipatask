'use strict';

// Assemble objective turns consistently across providers. Fresh turns use
// system rules and current objective; resumes rely on provider session id;
// handoffs replay conversation when no provider session can be resumed.

const config = require('../config');
const { codingPriorityBaseline } = require('../sprint-assign');

// Read only the server-prefetched metadata section, never proposal JSON from the
// conversation. Legacy drafts lack priorityBaseline but still carry active rows.
function priorityBaselineLine(session) {
  const match = (session.firstPrompt || '').match(/^### list_task_id_meta\s*\n```json\s*\n([\s\S]*?)\n```/m);
  if (!match) return '';
  try {
    const meta = JSON.parse(match[1]);
    let baseline = meta.priorityBaseline;
    if (!(Number.isInteger(baseline) && baseline > 0)) {
      if (!Array.isArray(meta.active)) return '';
      baseline = codingPriorityBaseline(meta.active, new Set(meta.active.map(t => t.status)));
    }
    return `Priority baseline (list_task_id_meta): ${baseline}. New regular tasks use this sprint or a later dependency-required sprint; priority 0 is reserved for tt-performance-suggestions or an explicit user Backlog choice.`;
  } catch { return ''; }
}

// Render a message range as "[User]: ...\n\n[Assistant]: ..." blocks.
function renderMessages(messages, { from, to } = {}) {
  const start = Math.max(0, from ?? 0);
  const end = to ?? messages.length;
  if (end <= start) return '';
  return messages.slice(start, end)
    .map(m => `[${m.role === 'user' ? 'User' : 'Assistant'}]: ${m.content}`)
    .join('\n\n');
}

// The richest statement of the objective the session holds: firstPrompt carries the
// prefetched task metadata / project tags / budgeted architectures plus any revise payload;
// messages[0] is only the user's visible text.
function objectiveText(session) {
  return session.firstPrompt || (session.messages[0] ? session.messages[0].content : '');
}

function compressedBlock(session) {
  if (!session.compressedSummaries || session.compressedSummaries.length === 0) return '';
  const lines = session.compressedSummaries.map(s => JSON.stringify(s)).join('\n');
  return `<prior-decisions-compressed>\n${lines}\n</prior-decisions-compressed>`;
}

// Fresh CLI session over an existing conversation (post-trim / post-compression). Verbatim
// tail is bounded to the same OBJECTIVE_HISTORY_COMPRESS_TAIL_TURNS window for every
// provider and never re-sends a pair already covered by a compressed summary.
function buildRebuildPrompt(session, { includeSystemPrompt } = {}) {
  const messages = session.messages;
  const lastMsg = messages[messages.length - 1];
  const tailTurns = config.OBJECTIVE_HISTORY_COMPRESS_TAIL_TURNS || 3;
  const tailEnd = messages.length - 1;
  const tailStart = Math.max(1 + (session.compressedThrough || 0) * 2, tailEnd - tailTurns * 2);
  const verbatim = renderMessages(messages, { from: tailStart, to: tailEnd });

  const parts = [];
  if (includeSystemPrompt && session.systemPrompt) parts.push(session.systemPrompt);
  parts.push(`<objective>\n${objectiveText(session)}\n</objective>`);
  parts.push(compressedBlock(session));
  if (verbatim) parts.push(`<recent-context-verbatim>\n${verbatim}\n</recent-context-verbatim>`);
  parts.push(lastMsg ? lastMsg.content : '');
  return parts.filter(Boolean).join('\n\n');
}

const HANDOFF_STEER =
  'You are taking over this planning conversation from another model. Continue it — ' +
  'do not restart or re-ask settled questions already answered above.';

// Cross-provider handoff transcript — objective + compressed-decisions + full remaining
// verbatim conversation (assistant ```json blocks preserved) + steer line + trailing ask.
function buildHandoffPrompt(session, { includeSystemPrompt } = {}) {
  const messages = session.messages;
  const lastMsg = messages[messages.length - 1];
  const objective = objectiveText(session);
  const fromIdx = 1 + (session.compressedThrough || 0) * 2;
  const toIdx = Math.max(fromIdx, messages.length - 1);
  let transcript = renderMessages(messages, { from: fromIdx, to: toIdx });

  const maxChars = config.OBJECTIVE_HANDOFF_MAX_CHARS || 120000;
  if (transcript.length > maxChars) {
    const pairs = transcript.split('\n\n');
    let kept = pairs;
    let elided = 0;
    while (kept.join('\n\n').length > maxChars && kept.length > 2) {
      kept = kept.slice(2); // drop the oldest user+assistant pair
      elided++;
    }
    transcript = (elided > 0 ? `[… ${elided} earlier turn(s) elided …]\n\n` : '') + kept.join('\n\n');
  }

  const parts = [];
  if (includeSystemPrompt && session.systemPrompt) parts.push(session.systemPrompt);
  parts.push(`<objective>\n${objective}\n</objective>`);
  parts.push(compressedBlock(session));
  if (transcript) parts.push(`<conversation-so-far>\n${transcript}\n</conversation-so-far>`);
  parts.push(HANDOFF_STEER);
  parts.push(lastMsg ? lastMsg.content : '');
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Single entry point used by every provider's spawn function.
 *
 * @param {object}  session
 * @param {object}  opts
 * @param {boolean} opts.hasProviderSession - !!session[<this provider's session-id field>]
 * @param {boolean} opts.includeSystemPrompt - true when this CLI has no --append-system-prompt
 *   equivalent and the system prompt must be folded into stdin (gemini/pi/codex); false for
 *   claude, which ships it as a separate flag on every spawn.
 * @returns {{ prompt: string, mode: 'resume'|'fresh'|'handoff' }}
 */
function buildTurnPrompt(session, { includeSystemPrompt, hasProviderSession } = {}) {
  const messages = session.messages;
  const lastMsg = messages[messages.length - 1];
  const baseline = priorityBaselineLine(session);
  const result = (prompt, mode) => ({ prompt: baseline ? `${baseline}\n\n${prompt}` : prompt, mode });

  if (hasProviderSession) {
    return result(lastMsg ? lastMsg.content : '', 'resume');
  }

  if (session._providerSwitchPending && messages.length > 1) {
    return result(buildHandoffPrompt(session, { includeSystemPrompt }), 'handoff');
  }

  if (messages.length > 1) {
    return result(buildRebuildPrompt(session, { includeSystemPrompt }), 'fresh');
  }

  const base = session.firstPrompt || (lastMsg ? lastMsg.content : '');
  const prompt = (includeSystemPrompt && session.systemPrompt)
    ? `${session.systemPrompt}\n\n${base}`
    : base;
  return result(prompt, 'fresh');
}

// Shared nudge-message selection (claude-session.js originally; codex-session.js reuses).
// Caller owns the attempt counter, message push, and re-spawn — this just picks the text.
function buildNudgeMessage(turnBuffer) {
  const implProse = /\b(let me|now i'?ll|the fix[: ]|i'?ll (insert|edit|make)|i need to use)\b/i.test(turnBuffer);
  return implProse
    ? 'STOP. You are the PLANNER — you make tasks for another agent to execute. Do NOT edit files, solve problems, or narrate implementation. Output ONLY the fenced ```json block.'
    : 'Your previous response had no fenced ```json block. Re-emit your answer as a single fenced ```json block per the OBJECTIVE MODE rules. No prose.';
}

module.exports = {
  renderMessages,
  buildRebuildPrompt,
  buildHandoffPrompt,
  buildTurnPrompt,
  buildNudgeMessage,
};
