'use strict';

// C1541 — hand-synced copy of the remote MCP router's resolution-payload shaping logic, so
// this local stdio server produces identical list_task_resolutions payloads to the remote
// HTTP transport. Source of truth to mirror by hand if either changes:
//   - api/src/lib/resolution-payload.js
// `ai/todo/server` is a separate git submodule and cannot require across the api/ boundary,
// so this cannot be a shared require — it must be copied.
//
// No env/IO in any function here — api-backend.js resolves the task+comment snapshot and
// passes it in, same discipline as priority-fallback.js, so this stays trivially
// unit-testable (node:test, no network mocking). See resolution-payload.test.js.

// ── caps ──
// Kept deliberately tight — list_task_resolutions is meant as a cheap "how was this kind of
// task resolved before" lookup, not a bulk export. A single auto-posted exit comment
// (see AGENT_LOG_HEADER_RE below) can alone be ~4000 chars, so MAX_TOTAL_CHARS
// exists as a hard backstop even with agent logs excluded by default.
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const MAX_COMMENTS_PER_TASK = 3; // newest first
const MAX_COMMENT_CHARS = 1500;
const MAX_DESCRIPTION_CHARS = 400;
const MAX_TOTAL_CHARS = 20000; // ~5k tokens, hard stop across the whole payload
const TRUNC_MARK = '…[truncated]';

// The Task App's session-lifecycle hook posts exactly one of these three headers as the
// first line of an auto-posted session-exit comment (ws-handlers.js onSessionExit,
// C948/C982). Requiring the header line AND a second structural signal (below) keeps this
// from false-positiving on a genuine agent-authored report that happens to start with
// similar wording.
const AGENT_LOG_HEADER_RE = /^(Agent session terminated by user|Agent completed the task|Agent session ended \(exit code [^)]*\)|Agent session killed by the descendant-process watchdog(?: — .*)?)$/;

// (TPT354) Invisible HTML comment written as the LAST line of every auto-posted exit comment
// (exit-resolution.js). The body between header and marker is rendered markdown (the agent's
// final message) or a fenced sanitized tail, so the old "blank line + ``` fence" shape can no
// longer be relied on — the marker is the current structural signal. Both markdown renderers
// (Task App marked+DOMPurify, web marked) hide an HTML comment.
const AGENT_EXIT_MARKER = '<!-- tipatask:agent-exit -->';

function isAgentLogTailComment(content) {
  const s = String(content || '');
  const lines = s.split('\n');
  if (!AGENT_LOG_HEADER_RE.test((lines[0] || '').trim())) return false;
  // Current shape (TPT354): header … marker as the last non-empty line.
  let last = lines.length - 1;
  while (last > 0 && !lines[last].trim()) last--;
  if (last > 0 && lines[last].trim() === AGENT_EXIT_MARKER) return true;
  // Legacy shape (pre-TPT354 rows stay in the DB): header, blank line, fenced block start —
  // mirrors the old template literal `${header}\n\n\`\`\`\n${tail}\n\`\`\``.
  return lines[1] === '' && (lines[2] || '').trimStart().startsWith('```');
}

// Clips text to `max` chars, reserving room for TRUNC_MARK so the returned text length is
// ALWAYS <= max, even when max is smaller than the marker itself (that edge case still
// needs to never throw and never overshoot — a caller passing a tiny per-comment budget
// near the global cap boundary is a real path, see shapeResolutionPayload below).
function clip(text, max) {
  const s = String(text || '');
  const cap = Math.max(0, max);
  if (s.length <= cap) return { text: s, truncated: false };
  const keep = cap - TRUNC_MARK.length;
  // Normal case: room for at least some real text plus the full marker.
  if (keep >= 0) return { text: s.slice(0, keep) + TRUNC_MARK, truncated: true };
  // cap is smaller than the marker itself — fall back to a partial marker so length still
  // never exceeds cap. truncated stays true; the returned text may not literally
  // end with the full TRUNC_MARK string in this narrow edge case.
  return { text: TRUNC_MARK.slice(0, cap), truncated: true };
}

// tasks: [{ id, title, status, tags, description }] (wire-shaped, already filtered/sorted/
//   sliced to the caller's limit — this function does not re-filter or re-order tasks).
// commentsByTaskId: { [taskId]: [{ id, content, comment_type|type, created_at }] } — ANY
//   comment type is eligible (comment/resolution/spec), per C1541's "all comment types"
//   scope; only the auto-posted log-tail artifact is excluded by default.
// Returns { resolutions, truncated, returned, total_matched } — resolutions carry
// `resolution_comments` (task's own literal field name from its spec) holding all comment
// types subject to the caps.
function shapeResolutionPayload({ tasks, commentsByTaskId, includeAgentLogs = false, totalMatched }) {
  let budget = MAX_TOTAL_CHARS;
  let globalTruncated = false;
  const resolutions = [];

  for (const t of tasks) {
    const rawComments = (commentsByTaskId && commentsByTaskId[t.id]) || [];
    let comments = rawComments
      .filter(c => includeAgentLogs || !isAgentLogTailComment(c.content))
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0)) // newest first
      .slice(0, MAX_COMMENTS_PER_TASK);

    const shapedComments = [];
    for (const c of comments) {
      if (budget <= 0) { globalTruncated = true; break; }
      const perCommentMax = Math.min(MAX_COMMENT_CHARS, budget);
      const { text, truncated } = clip(c.content, perCommentMax);
      budget -= text.length;
      if (truncated || perCommentMax < MAX_COMMENT_CHARS) globalTruncated = true;
      shapedComments.push({
        id: c.id,
        type: c.comment_type || c.type || 'comment',
        created_at: c.created_at,
        content: text,
        truncated,
      });
    }

    const { text: descText, truncated: descTruncated } = clip(t.description, MAX_DESCRIPTION_CHARS);
    if (descTruncated) globalTruncated = true;

    resolutions.push({
      id: t.id,
      title: t.title,
      status: t.status,
      tags: t.tags || [],
      description: descText,
      resolution_comments: shapedComments,
    });
  }

  return {
    resolutions,
    truncated: globalTruncated,
    returned: resolutions.length,
    total_matched: totalMatched != null ? totalMatched : resolutions.length,
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_COMMENTS_PER_TASK,
  MAX_COMMENT_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_TOTAL_CHARS,
  TRUNC_MARK,
  AGENT_LOG_HEADER_RE,
  AGENT_EXIT_MARKER,
  isAgentLogTailComment,
  clip,
  shapeResolutionPayload,
};
