// TPT34 — client twin of api/src/lib/mentions.js's @mention matching rules, extended with
// an HTML text-node highlighter for the render path. The Task App is a separate git
// submodule and cannot require/import across the gitlink into api/ (same reason
// transliteration.js has a hand-synced twin at src/server/transliteration.js — see that
// file's own header for the pattern). Keep parseMentions()'s regex/boundary rules identical
// to the API's, so a name highlighted here is always a name the API actually notifies.
//
// mention-highlight.test.js copies api/src/lib/mentions.test.js's fixture table verbatim
// (behavioral parity, always runs) plus a lighter drift guard checking the API's
// boundary-regex source string is unchanged (skips when api/ isn't checked out).

// Agent handles the mention typeahead/highlight offer in addition to real project members.
// Centralized here so the dropdown (task-board.js) and the highlighter can't drift apart.
export const AGENT_HANDLES = ['claude', 'codex', 'pi'];

// Regex metacharacters in a member's own name (e.g. "O'Brien (PM)") must not be
// interpreted as regex syntax when building the alternation.
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// marked's HTML output escapes &<>"' — a candidate handle built from a raw member name
// must also match its escaped spelling in rendered markdown, or a name like "O'Brien (PM)"
// (which becomes "O&#39;Brien (PM)" after renderMarkdown()) would highlight nowhere even
// though the API still resolves and notifies it from the raw comment text.
function escapeHtmlEntities(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Client twin of api/src/lib/mentions.js parseMentions() — see that file's header for the
// full rationale. Kept as a near-verbatim port (not reusing buildMentionCandidates below)
// so this function stays easy to diff against the source of truth by eye.
export function parseMentions(text, members) {
  const source = String(text || '');
  if (!source || !Array.isArray(members) || members.length === 0) return [];

  const candidates = [];
  for (const m of members) {
    const userId = m?.user_id ?? m?.id;
    if (userId == null) continue;
    const handles = [];
    if (m?.name && String(m.name).trim()) handles.push(String(m.name).trim());
    if (m?.email) {
      const localPart = String(m.email).split('@')[0];
      if (localPart) handles.push(localPart);
    }
    for (const handle of handles) {
      candidates.push({ userId, name: m.name || handle, handle });
    }
  }
  if (candidates.length === 0) return [];

  // Longest handle first so a multi-word/longer name always wins over a shorter one it
  // starts with (e.g. "John Smith" before "John").
  candidates.sort((a, b) => b.handle.length - a.handle.length);
  const alternation = candidates.map((c) => escapeRegExp(c.handle)).join('|');
  const mentionRe = new RegExp(`(^|[^\\w.@-])@(${alternation})(?![\\w-])`, 'gi');

  const seen = new Set();
  const result = [];
  let match;
  while ((match = mentionRe.exec(source)) !== null) {
    const matchedHandle = match[2].toLowerCase();
    const candidate = candidates.find((c) => c.handle.toLowerCase() === matchedHandle);
    if (!candidate || seen.has(candidate.userId)) continue;
    seen.add(candidate.userId);
    result.push({ userId: candidate.userId, name: candidate.name });
  }
  return result;
}

// Build the flat candidate-handle table the highlighter matches against: one entry per
// (member × handle-form) — display name + email local-part, same "skip if no resolvable
// user id" (pending invite) rule as parseMentions above — plus both the raw and
// HTML-entity-escaped spelling of each handle, plus one synthetic entry per agent handle
// (kind:'agent', userId:null) so the highlighter can style @claude/@codex/@pi differently
// without treating them as a real notifiable member.
//
// Skips any handle containing '@': ws-handlers.js normalizeProjectMember() backfills a
// nameless member's `name` from their email, and that full address is already covered by
// the separate local-part handle below — a raw "@name@example.com" could never match the
// API's own regex anyway (the '@' fails the [^\w.@-] left-boundary character class).
export function buildMentionCandidates(members, agentHandles = AGENT_HANDLES) {
  const out = [];
  const pushHandle = (handle, userId, name, kind) => {
    if (!handle || handle.includes('@')) return;
    out.push({ handle, userId, name, kind });
    const escaped = escapeHtmlEntities(handle);
    if (escaped !== handle) out.push({ handle: escaped, userId, name, kind });
  };
  for (const m of Array.isArray(members) ? members : []) {
    const userId = m?.user_id ?? m?.id;
    if (userId == null) continue;
    const name = m?.name && String(m.name).trim();
    if (name) pushHandle(name, userId, name, 'member');
    if (m?.email) {
      const localPart = String(m.email).split('@')[0];
      if (localPart) pushHandle(localPart, userId, name || localPart, 'member');
    }
  }
  for (const handle of agentHandles || []) {
    pushHandle(handle, null, handle, 'agent');
  }
  // Longest handle first — same reasoning as parseMentions above.
  out.sort((a, b) => b.handle.length - a.handle.length);
  return out;
}

// Matches a whole <span class="file-ref">...</span> (renderMarkdown()'s wrapper for
// @path/file.js-looking tokens, utils.js) or any other tag, verbatim, before falling
// through to a bare text run. Trying the file-ref alternative first is load-bearing: a
// member literally named e.g. "ai" would otherwise match inside
// <span class="file-ref">@ai/todo/...</span> at its own text-node start.
const SPLIT_RE = /<span class="file-ref">[\s\S]*?<\/span>|<[^>]*>|([^<]+)/g;

// Render-path entry point: wraps every matching @handle in already-rendered HTML with
// <mark class="mention"> (member) or <mark class="mention mention--agent"> (agent handle),
// touching TEXT NODES ONLY — markup (links, bold, code, images, file-ref spans) is passed
// through untouched. `candidates` — the output of buildMentionCandidates() above.
export function highlightMentionsInHtml(html, candidates) {
  const source = String(html || '');
  if (!source || !Array.isArray(candidates) || candidates.length === 0) return source;

  const alternation = candidates.map((c) => escapeRegExp(c.handle)).join('|');
  const mentionRe = new RegExp(`(^|[^\\w.@-])@(${alternation})(?![\\w-])`, 'gi');
  const byHandle = new Map();
  for (const c of candidates) {
    const key = c.handle.toLowerCase();
    if (!byHandle.has(key)) byHandle.set(key, c);
  }

  return source.replace(SPLIT_RE, (whole, text) => {
    if (!text) return whole; // matched a tag, or a whole file-ref span — leave verbatim
    return text.replace(mentionRe, (m, lead, handle) => {
      const candidate = byHandle.get(handle.toLowerCase());
      const cls = candidate && candidate.kind === 'agent' ? 'mention mention--agent' : 'mention';
      return `${lead}<mark class="${cls}">@${handle}</mark>`;
    });
  });
}
