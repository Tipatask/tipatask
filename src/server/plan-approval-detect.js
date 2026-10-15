'use strict';

// ── In-TUI plan approval detection (TPT654) ──
// Pure helpers (no IO, no session side effects beyond the typed-line accumulator) behind
// terminal-session.js's markPlanApprovedInTui(). The Task App's own approval paths — the Proceed
// button (`plan-approve`) and a typed `/approve-plan` — call approvePlan() directly; these helpers
// notice the OTHER ways a plan gets approved, which used to leave session.terminalPhase stuck on
// 'planning' for the whole run (so neither the idle completion nudge nor the exit backstop ever
// guarded the commit requirement):
//
// - Claude: the user answers Claude Code's own ExitPlanMode dialog inside the xterm. The dialog
//   collapses into a permanent transcript row — `User approved Claude's plan` (or `Exited plan
//   mode` for the plan-less "Claude wants to exit plan mode" variant), or `User rejected Claude's
//   plan:` for "No, keep planning". A shift+tab out of plan mode shows up as the mode footer
//   (`accept edits on` / `auto mode on`). Wording verified in the installed claude 2.1.296 bundle;
//   re-verify after CLI upgrades.
// - Codex / Pi (no slash approval command): the user types the go-ahead into the agent's own
//   composer. The submission text decides — an approval-worded line flips the phase, anything
//   else is plan feedback and keeps the run in planning so a revised plan can be announced again.
//
// HARD RULE (same as prompt-detect.js): nothing here goes into a *_PROMPT_PATTERNS table or
// buildLegacyPatternTable(). These rows must never raise attention or gate injection.

// Leading row decoration: Ink paints a non-ASCII glyph (plan icon / tool marker) before the text.
// ASCII punctuation is deliberately excluded so a markdown bullet, a backtick-quoted mention of
// the phrase in this repo's own docs/tests (`- \`User approved Claude's plan\``) echoed through a
// tool-output row can never satisfy the anchor.
const ROW_GLYPHS = '(?:[^\\x00-\\x7f\\s]\\s*){0,4}';
const CLAUDE_PLAN_APPROVED_RE = new RegExp(`^\\s*${ROW_GLYPHS}(?:User approved Claude['’]?s plan|Exited plan mode)\\s*$`, 'i');
const CLAUDE_PLAN_REJECTED_RE = new RegExp(`^\\s*${ROW_GLYPHS}User rejected Claude['’]?s plan\\b`, 'i');
const CLAUDE_EXEC_MODE_RE = new RegExp(`^\\s*${ROW_GLYPHS}(?:accept edits|auto mode) on\\b`, 'i');
const CLAUDE_PLAN_MODE_RE = /\bplan mode on\b/i;

// Returns 'approved' | 'rejected' | 'execMode' | 'planMode' | null for one carved output row.
function matchClaudePlanOutcomeLine(line) {
  if (typeof line !== 'string' || !line) return null;
  if (CLAUDE_PLAN_APPROVED_RE.test(line)) return 'approved';
  if (CLAUDE_PLAN_REJECTED_RE.test(line)) return 'rejected';
  if (CLAUDE_EXEC_MODE_RE.test(line)) return 'execMode';
  if (CLAUDE_PLAN_MODE_RE.test(line)) return 'planMode';
  return null;
}

// ── Typed-line accumulator ──
// xterm.js delivers keyboard input as it is typed: printable characters one chunk at a time,
// Enter as '\r', backspace as DEL, arrows/function keys as escape sequences, and a clipboard paste
// as one bracketed-paste block. Rebuilds the composer line from that stream so the submission can
// be classified at Enter. Newlines inside a bracketed paste are literal line breaks for the agent,
// not submissions.
const TYPED_LINE_MAX = 2000;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const ESCAPE_SEQ_RE = /\x1b\[[0-9;:<=>?]*[ -/]*[@-~]|\x1bO[@-~]|\x1b[@-Z\\-_]|\x1b/g;

// Feeds one input chunk; returns the lines submitted by this chunk (empty when it carried no Enter).
function trackTypedLine(session, data) {
  const submitted = [];
  if (!session || typeof data !== 'string' || !data) return submitted;
  let line = typeof session._typedLine === 'string' ? session._typedLine : '';
  let pasting = session._typedPasting === true;
  let rest = data;
  while (rest.length) {
    const marker = pasting ? PASTE_END : PASTE_START;
    const at = rest.indexOf(marker);
    const segment = at === -1 ? rest : rest.slice(0, at);
    rest = at === -1 ? '' : rest.slice(at + marker.length);
    const text = pasting ? segment : segment.replace(ESCAPE_SEQ_RE, '');
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        if (pasting) line += ' ';
        else { submitted.push(line); line = ''; }
      } else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1);
      else if (ch === '\x15') line = '';
      else if (ch >= ' ') line += ch;
      if (line.length > TYPED_LINE_MAX) line = line.slice(-TYPED_LINE_MAX);
    }
    if (at !== -1) pasting = !pasting;
  }
  session._typedLine = line;
  session._typedPasting = pasting;
  return submitted;
}

// ── Submission classifier ──
// 'approve' only for a short line that opens with a recognizable go-ahead and carries no feedback
// cue; a question mark, a revision/negation word, or anything longer reads as plan feedback. An
// unusual approval phrasing therefore stays 'feedback' (the run keeps waiting for Proceed or a
// clearer go-ahead) rather than a revision request ever counting as approval.
const APPROVAL_MAX_LEN = 80;
const APPROVAL_START_RE = /^(?:y|yes|yep|yup|yeah|ok|okay|k|sure|fine|good|great|perfect|agreed|confirmed|go(?: ahead| on)?|do it|proceed|approved?|implement|start|continue|execute|lgtm|looks good|sounds good|ship it|let['’]?s go|make it so)\b/i;
const FEEDBACK_CUE_RE = /\?|\b(?:but|instead|however|don['’]?t|do not|not|no|nope|change|revise|rework|rethink|re-?plan(?:ning)?|planning|first|before|wait|hold|stop|except|unless|also|add|remove|drop|skip|without|rather|why|what|how|where|which|when|explain|question)\b/i;

function classifyTypedSubmission(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/^plan approved\b/i.test(t)) return 'approve';
  if (t.length > APPROVAL_MAX_LEN) return 'feedback';
  if (FEEDBACK_CUE_RE.test(t)) return 'feedback';
  return APPROVAL_START_RE.test(t) ? 'approve' : 'feedback';
}

module.exports = {
  matchClaudePlanOutcomeLine,
  trackTypedLine,
  classifyTypedSubmission,
  TYPED_LINE_MAX,
  APPROVAL_MAX_LEN,
};
