'use strict';

// (TPT354) Builds the auto-posted session-exit resolution comment (ws-handlers.js
// wireSessionLifecycle → onSessionExit). Pure module — no IO, no session state — so the whole
// composition is unit-testable without node-pty (see exit-resolution.test.js).
//
// Why this exists: the comment used to be the raw ~80-line PTY scrollback tail. A TUI's
// scrollback is not text — it is redraw frames. Claude Code animates the terminal TITLE via
// OSC 0 (`ESC ] 0 ; <spinner> <title> BEL`) on every spinner tick, and neither stripAnsi() nor
// reflowChunk() removes an OSC *string* (they only drop the two-byte `ESC ]` introducer), so
// hundreds of `0;◐ <title>` repeats survived into the comment, interleaved with spinner
// frames, counter redraws, and status-bar chrome. Codex's tail is the same class of noise
// (`◦ Working (8m 12s • esc to interrupt)`, the `› Ask Codex…` composer, the model footer).
//
// Composition order (buildExitResolutionComment): the agent's own final assistant message →
// a sanitized, readability-checked tail → header only. See tt-claude-session-terminal.md
// § Exit resolution comment.

const { reflowChunk } = require('./screen-reflow');
const { AGENT_EXIT_MARKER, isAgentLogTailComment } = require('./resolution-payload');

const FINAL_MESSAGE_MAX_CHARS = 4000;
const TAIL_MAX_LINES = 25;
const TAIL_MAX_CHARS = 2000;
const TRUNC_NOTE = '…[truncated]';
// A line must be at least this long (non-space chars) to take part in global de-duplication —
// short lines ("}", "done") legitimately repeat and must survive.
const DEDUPE_MIN_CHARS = 12;

// ── Tail sanitization ──

// Full OSC strings (`ESC ] … BEL` / `ESC ] … ESC \`), plus DCS/APC/PM strings (ST-terminated).
// reflowChunk()/stripAnsi() drop only the introducer, leaving the payload behind as visible
// text — this must run BEFORE reflowChunk().
function stripStringSequences(s) {
  let out = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  out = out.replace(/\x1b[P_^][^\x1b]*\x1b\\/g, '');
  // Unterminated trailing string: the buffer was cut mid-sequence at the end.
  out = out.replace(/\x1b[\]P_^][^\x07\x1b]*$/, '');
  // Leading remnant: the buffer was truncated mid-OSC at the START, so it opens with title text
  // followed by the BEL that terminated it. Only the first line, only up to the first BEL.
  out = out.replace(/^[^\x1b\n\x07]*\x07/, '');
  return out;
}

// Spinner-frame glyphs that never begin real content: ✻ ✽ ✶ ✳ ✢ ✦, the ◐◑◒◓ / ◴◵◶◷ frames, and
// the braille block. A line opening with one is a status/spinner line ("✻ Sock-hopping…",
// "✻ Baked for 2m 3s"). Deliberately excludes `·` `*` `•` `◦` `⏺` — those are also legitimate
// bullet/assistant-message markers, handled only in their bare form by the short-line rule.
const STRONG_SPINNER_RE = /^[✻✽✶✳✢✦◐-◓◴-◷⠀-⣿]/;

// A terminal-title remnant: the payload of an OSC 0/1/2 whose `ESC ]` was already dropped —
// `0;◐ Ahrefs 76→88 …`. The char after `;` must be a non-digit/non-space (a spinner glyph or a
// letter), so "0;1" style numeric text is not mistaken for a title.
const TITLE_REMNANT_START_RE = /^[012];[^\s\d;]/;
const TITLE_REMNANT_ANY_RE = /(?<![\d.])[012];[^\s\d;]/g;

// Lines that are TUI chrome rather than content. Tested against the line with any leading
// prompt glyph removed.
const CHROME_RES = [
  /esc to interrupt/i,
  /\? for shortcuts/i,
  /plan mode (?:on|off)/i,
  /shift\+tab/i,
  /\bctrl[+-]c\b.*\b(?:exit|interrupt|quit)\b/i,
  /^Ask Codex to do anything/i,
  /\bf2 to view\b/i,
  /\b\d+ new messages?\b/i,
  /Too many changed files to show diff/i,
  /Per-file diff is skipped/i,
  /\b\d+ files? changed \+\d+ -\d+/i,
  /\bcontext left\b/i,
  // Codex footer: `<model> · ~/path · <branch or title>` — a ` · ~/…` or ` · /…` path segment.
  /\s[·•]\s(?:~|\/)\S*\s*(?:[·•]|$)/,
  /^\W{0,3}Tip:\s/,
  /^(?:To continue this session|Resume this session with)\b/i,
  /^\s*(?:claude|codex|pi)\s+(?:--)?resume\b/i,
];

// A bare status word with an ellipsis and nothing else ("Sock-hopping…    88", "Thinking...").
const STATUS_WORD_RE = /^[A-Za-z][A-Za-z'-]{2,}(?:…|\.\.\.)\s*(?:\d+\s*)?(?:\([^)]*\))?$/;

function isDroppableLine(line) {
  // line is already trimmed both ends here
  if (!line) return false; // blanks are handled by the collapse pass, not dropped here
  if (TITLE_REMNANT_START_RE.test(line)) return true;
  const remnants = line.match(TITLE_REMNANT_ANY_RE);
  if (remnants && remnants.length >= 2) return true;
  if (STRONG_SPINNER_RE.test(line)) return true;
  // Digits/space only — the frame counters a spinner redraw leaves behind ("38", "825").
  if (/^\d[\d\s.,]*$/.test(line)) return true;
  // Box-drawing / braille only — frame borders.
  if (/^[\s─-▟⠀-⣿]+$/.test(line)) return true;
  // ≤3 visible chars with no letters — a lone `›` / `>` / `⏺` / `✕` / `5`. Closing brackets
  // (`}` `);` `]`) are the exception so a trailing code line is not eaten.
  const compact = line.replace(/\s+/g, '');
  if (compact.length <= 3 && !/\p{L}/u.test(compact) && !/^[)\]}]+[;,]?$/.test(compact)) return true;
  const stripped = line.replace(/^[›❯>]\s*/, '');
  if (CHROME_RES.some(re => re.test(stripped))) return true;
  if (STATUS_WORD_RE.test(stripped)) return true;
  return false;
}

// ≥1 line with ≥3 real words and ≥15 letters. Guards against posting a "tail" that survived
// the drop rules only as fragments.
function isReadable(text) {
  if (typeof text !== 'string' || !text) return false;
  return text.split('\n').some((line) => {
    const words = line.split(/\s+/).filter(w => /\p{L}{2,}/u.test(w));
    if (words.length < 3) return false;
    return (line.match(/\p{L}/gu) || []).length >= 15;
  });
}

// raw PTY buffer → clean, readable text, or '' when nothing readable remains.
function sanitizeTerminalTail(raw, { maxLines = TAIL_MAX_LINES, maxChars = TAIL_MAX_CHARS } = {}) {
  if (typeof raw !== 'string' || !raw) return '';
  const lines = [];
  for (const rawLine of reflowChunk(null, stripStringSequences(raw)).split('\n')) {
    // A carriage return rewinds to column 0 — the last non-empty segment is what the screen
    // shows after an in-place spinner rewrite.
    const segments = rawLine.split('\r').filter(seg => seg.trim() !== '');
    let line = segments.length ? segments[segments.length - 1] : '';
    line = line.replace(/\t/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    // Input-box side borders (`│ text │`) wrap real content — peel them off before judging it.
    line = line.replace(/^[\s│┃]+/, '').replace(/[\s│┃]+$/, '');
    if (isDroppableLine(line)) continue;
    lines.push(line);
  }

  // Global de-dup, keep-LAST: a redrawn frame repeats its rows, and the last copy reflects the
  // final screen. Walk backwards so the final occurrence wins, then restore order.
  const seen = new Set();
  const keptRev = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line && line.replace(/\s+/g, '').length >= DEDUPE_MIN_CHARS) {
      if (seen.has(line)) continue;
      seen.add(line);
    }
    keptRev.push(line);
  }
  const deduped = keptRev.reverse();

  // Collapse consecutive duplicates and runs of blank lines.
  const collapsed = [];
  for (const line of deduped) {
    const prev = collapsed[collapsed.length - 1];
    if (line === '' && (prev === '' || prev === undefined)) continue;
    if (line !== '' && line === prev) continue;
    collapsed.push(line);
  }

  let text = collapsed.slice(-maxLines).join('\n').trim();
  if (text.length > maxChars) {
    text = text.slice(-maxChars);
    const nl = text.indexOf('\n');
    if (nl !== -1) text = text.slice(nl + 1); // drop the partial first line the cut created
    text = text.trim();
  }
  return isReadable(text) ? text : '';
}

// ── Final assistant message ──

// The opening code fence still unclosed at the end of `s`, or null.
function openFenceOf(s) {
  let open = null;
  for (const line of s.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    const ch = m[1][0];
    const len = m[1].length;
    if (!open) open = { ch, len };
    else if (ch === open.ch && len >= open.len && /^ {0,3}[`~]+\s*$/.test(line)) open = null;
  }
  return open;
}

// The agent's final message → comment-ready markdown ('' when there is nothing worth posting).
function prepareFinalMessage(text) {
  if (typeof text !== 'string') return '';
  let s = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  if (!s || !/\p{L}/u.test(s)) return '';
  // An unterminated `<!--` in the message would swallow the rest of the comment (marker
  // included) into one HTML comment block.
  s = s.replace(/<!--/g, '&lt;!--');
  let truncated = false;
  if (s.length > FINAL_MESSAGE_MAX_CHARS) {
    let cut = s.slice(0, FINAL_MESSAGE_MAX_CHARS);
    const nl = cut.lastIndexOf('\n');
    if (nl > FINAL_MESSAGE_MAX_CHARS * 0.6) cut = cut.slice(0, nl);
    s = cut.trimEnd();
    truncated = true;
  }
  // Close an unbalanced fence BEFORE appending anything, so neither the truncation note nor
  // the marker is swallowed into a code block that never ends.
  const open = openFenceOf(s);
  if (open) s += `\n${open.ch.repeat(open.len)}`;
  if (truncated) s += `\n\n${TRUNC_NOTE}`;
  return s;
}

// ── Comment assembly ──

function exitHeader(reason, exitCode, reasonText) {
  if (reason === 'user-terminated') return 'Agent session terminated by user';
  if (reason === 'completed') return 'Agent completed the task';
  if (reason === 'runaway-killed') return `Agent session killed by the descendant-process watchdog${reasonText ? ` — ${reasonText}` : ''}`; // (TPT357)
  return `Agent session ended (exit code ${exitCode})`;
}

// A fence longer than any backtick run inside `text`, so terminal output that itself contains
// ``` cannot close it early.
function fenceBlock(text) {
  const runs = text.match(/`+/g) || [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

// → { content, source } where source ∈ 'final-message' | 'tail' | 'header-only'.
// Header is always one of the exact shapes isAgentLogTailComment() recognises; the marker
// is always the last line (see resolution-payload.js).
function buildExitResolutionComment({ reason, reasonText, exitCode, finalMessage, buffer }) {
  const header = exitHeader(reason, exitCode, reasonText);
  const msg = prepareFinalMessage(finalMessage);
  if (msg) return { content: `${header}\n\n${msg}\n\n${AGENT_EXIT_MARKER}`, source: 'final-message' };
  const tail = sanitizeTerminalTail(buffer);
  if (tail) return { content: `${header}\n\n${fenceBlock(tail)}\n\n${AGENT_EXIT_MARKER}`, source: 'tail' };
  return { content: `${header}\n\n${AGENT_EXIT_MARKER}`, source: 'header-only' };
}

// ── Terminal-tail exit comment detection ──

// A run of 3+ backticks alone on a line — the fence fenceBlock() writes (no info string).
const FENCE_LINE_RE = /^`{3,}\s*$/;

// True for the auto-posted exit comment whose WHOLE body is the fenced terminal-screen tail: the
// current shape (`header`, blank, fence, tail, fence, blank, marker) and the legacy pre-TPT354 shape
// (same, no marker). False for an exit comment carrying the agent's own final message (real prose)
// and for every ordinary comment. The tail is machine-generated TUI redraw text — no narrative — so
// callers that feed comments back into an agent prompt use this to leave it out.
function isTerminalTailExitComment(content) {
  if (!isAgentLogTailComment(content)) return false;
  const lines = String(content).split('\n');
  if (lines[1] !== '' || !FENCE_LINE_RE.test(lines[2] || '')) return false;
  let last = lines.length - 1;
  while (last > 0 && !lines[last].trim()) last--;
  if (lines[last].trim() === AGENT_EXIT_MARKER) {
    last--;
    while (last > 0 && !lines[last].trim()) last--;
  }
  return last > 2 && FENCE_LINE_RE.test(lines[last]);
}

// ── Self-authored report detection ──

// Highest comment id in a fetched comment list; 0 for an empty list, null when the list itself
// is unavailable. The 0-vs-null distinction matters: 0 means "no comments existed at spawn",
// null means "unknown" (hasSelfAuthoredResolution then never suppresses).
function maxCommentId(comments) {
  if (!Array.isArray(comments)) return null;
  let max = 0;
  for (const c of comments) {
    const n = Number(c && c.id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

// True when the agent posted its own (non-auto) resolution comment during THIS run — i.e. one
// newer than the comment baseline captured at spawn. Unknown baseline → false: fail toward
// posting rather than silently dropping the only record of the run.
function hasSelfAuthoredResolution(comments, baselineId) {
  if (baselineId == null || !Array.isArray(comments)) return false;
  return comments.some((c) => {
    if (!c) return false;
    const type = c.comment_type || c.commentType || c.type;
    return type === 'resolution' && Number(c.id) > baselineId && !isAgentLogTailComment(c.content);
  });
}

// ── Turn-end wait ──

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// read() → { text, turnEnded } | null. Re-reads until the agent's turn has ended (the
// completion poller can fire a few seconds before the agent writes its closing message), up to
// timeoutMs; returns the newest result that carried text. A null read means "no transcript" —
// not transient, so it returns immediately instead of burning the whole timeout.
async function waitForFinalMessage(read, {
  needTurnEnd = false,
  timeoutMs = 90_000,
  intervalMs = 5_000,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let best = null;
  for (;;) {
    let r = null;
    try { r = await read(); } catch { r = null; }
    if (!r) return best;
    if (r.text) best = r;
    if (!needTurnEnd || r.turnEnded) return best;
    if (now() >= deadline) return best;
    await sleep(intervalMs);
  }
}

// Policy for a transcript read that may still be mid-turn. On a 'completed' exit the task is
// done, so text that never reached a turn end ("Let me check…", or a plan message from before
// the work) is not the outcome — drop it and let the comment fall back. On terminate / natural
// exit, the last thing the agent said is the best context available, mid-turn or not.
function selectFinalMessage(result, reason) {
  if (!result || typeof result.text !== 'string' || !result.text.trim()) return '';
  if (reason === 'completed' && !result.turnEnded) return '';
  return result.text;
}

module.exports = {
  FINAL_MESSAGE_MAX_CHARS,
  TAIL_MAX_LINES,
  TAIL_MAX_CHARS,
  stripStringSequences,
  isDroppableLine,
  isReadable,
  sanitizeTerminalTail,
  prepareFinalMessage,
  exitHeader,
  fenceBlock,
  buildExitResolutionComment,
  isTerminalTailExitComment,
  maxCommentId,
  hasSelfAuthoredResolution,
  waitForFinalMessage,
  selectFinalMessage,
};
