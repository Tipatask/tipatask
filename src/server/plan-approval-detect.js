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
//   (`accept edits on` / `auto mode on`, and since 2.1.311 also `bypass permissions on` /
//   `manual mode on`). Wording verified in the installed claude 2.1.296 and 2.1.311 bundles;
//   re-verify after CLI upgrades. The same footer confirms Claude live permission switches
//   (trackClaudeScreen(), task-agent/claude-live-mode.js).
// - Codex / Pi (no slash approval command): the user types the go-ahead into the agent's own
//   composer. The submission text decides — an approval-worded line flips the phase, anything
//   else is plan feedback and keeps the run in planning so a revised plan can be announced again.
//
// HARD RULE (same as prompt-detect.js): nothing here goes into a *_PROMPT_PATTERNS table or
// buildLegacyPatternTable(). These rows must never raise attention or gate injection.

const { createGrid, resizeGrid, feedGrid, gridLines } = require('./screen-grid');

// Leading row decoration: Ink paints a non-ASCII glyph (plan icon / tool marker) before the text.
// ASCII punctuation is deliberately excluded so a markdown bullet, a backtick-quoted mention of
// the phrase in this repo's own docs/tests (`- \`User approved Claude's plan\``) echoed through a
// tool-output row can never satisfy the anchor.
const ROW_GLYPHS = '(?:[^\\x00-\\x7f\\s]\\s*){0,4}';
const CLAUDE_PLAN_APPROVED_RE = new RegExp(`^\\s*${ROW_GLYPHS}(?:User approved Claude['’]?s plan|Exited plan mode)\\s*$`, 'i');
const CLAUDE_PLAN_REJECTED_RE = new RegExp(`^\\s*${ROW_GLYPHS}User rejected Claude['’]?s plan\\b`, 'i');
const CLAUDE_EXEC_MODE_RE = new RegExp(`^\\s*${ROW_GLYPHS}(?:accept edits|auto mode) on\\b`, 'i');
const CLAUDE_PLAN_MODE_RE = /\bplan mode on\b/i;

// ── Claude mode footer (TPT9136) ──
// The prompt footer names the native permission mode: `⏸ plan mode on`, `⏵⏵ auto mode on`,
// `⏵⏵ accept edits on`, `⏵⏵ bypass permissions on`, `⏸ manual mode on` (the CLI's `default`
// mode), `⏵⏵ don't ask on` — verified in claude 2.1.311 and 2.1.312, whose mode table maps each
// mode to one of those indicators. The ⏸/⏵ glyph is required: assistant prose and tool output
// rows start with ⏺ or plain text, so a sentence mentioning "plan mode on" never reads as the
// footer. `\s*` between words because the raw tail glues words Ink places with cursor moves. The
// footer is hidden while a permission dialog replaces the prompt, and repainted with the new mode
// within one frame of a Shift+Tab press — but only the cells that changed are written, so it is
// read from the screen (trackClaudeScreen()), never from one chunk.
const CLAUDE_MODE_INDICATOR_RE = /(?:^|\s)(?:[⏸⏵]\s*){1,2}(plan\s*mode|auto\s*mode|accept\s*edits|bypass\s*permissions|manual\s*mode|default\s*mode|don['’]?t\s*ask)\s*on\b/i;
const CLAUDE_MODE_BY_LABEL = [
  [/^plan/i, 'plan'], [/^auto/i, 'auto'], [/^accept/i, 'acceptEdits'], [/^bypass/i, 'bypassPermissions'],
  [/^(?:manual|default)/i, 'default'], [/^don/i, 'dontAsk'],
];

// Returns Claude's native mode id ('plan' | 'auto' | 'acceptEdits' | 'bypassPermissions' |
// 'default' | 'dontAsk') for a footer row, else null.
function matchClaudeModeIndicator(line) {
  if (typeof line !== 'string' || !line) return null;
  const m = CLAUDE_MODE_INDICATOR_RE.exec(line);
  if (!m) return null;
  for (const [re, mode] of CLAUDE_MODE_BY_LABEL) if (re.test(m[1])) return mode;
  return null;
}

// Rows only an open Claude dialog paints: the highlighted numbered option (`❯ 1. Yes`), the
// permission and plan questions, the command-approval heading and the dialog's own key hint.
// While one is on screen a keypress would answer the dialog (Shift+Tab in a permission dialog
// selects its allow-for-the-session option), so a live switch waits for the prompt instead.
const CLAUDE_DIALOG_ROW_RES = [
  /^\s*[│┃]?\s*❯\s*\d+[.)]\s+\S/,
  /\bDo you want to (?:proceed|make this edit|create|overwrite|delete|allow)\b/i,
  /\bWould you like to proceed\?/i,
  /\bThis command requires approval\b/i,
  /^\s*[│┃]?\s*Esc to cancel\b/i,
];
function matchClaudeDialogLine(line) {
  return typeof line === 'string' && !!line && CLAUDE_DIALOG_ROW_RES.some((re) => re.test(line));
}

// The composer's placeholder while a message waits in Claude's queue for the next tool boundary.
const CLAUDE_QUEUED_HINT_RE = /\bPress up to edit queued messages\b/i;
const CLAUDE_COMPOSER_ROW_RE = /^❯(?:\s(.*))?$/;
const CLAUDE_INPUT_RULE_RE = /^─{20,}$/;
const INPUT_BOX_MAX_ROWS = 12; // a wrapped composer can span several rows between its rules

// What Claude's screen shows now, from its rows (screen-grid.js gridLines()). The prompt is its
// input box — a rule, the `❯` composer row(s), a rule — with the mode footer below it. A dialog
// replaces the whole box; for 8 s after a paste (or until a Shift+Tab) the footer row reads
// "paste again to expand" instead of the mode.
//   inputBox  the box is on screen (keys reach the composer, not a dialog)
//   composer  the composer's first row without `❯` ('' when empty), null without a box
//   footer    the mode the footer below the box shows, null when no footer is there
//   dialog    a dialog row is visible while no input box is
function claudeScreenState(lines) {
  let composer = null;
  let boxEnd = -1;
  for (let close = lines.length - 1; close > 1 && boxEnd < 0; close--) {
    if (!CLAUDE_INPUT_RULE_RE.test(lines[close])) continue;
    for (let open = close - 2; open >= 0 && open >= close - 1 - INPUT_BOX_MAX_ROWS; open--) {
      if (!CLAUDE_INPUT_RULE_RE.test(lines[open])) continue;
      const m = CLAUDE_COMPOSER_ROW_RE.exec(lines[open + 1]);
      if (m) { composer = (m[1] || '').trim(); boxEnd = close; }
      break;
    }
  }
  let footer = null;
  for (let r = lines.length - 1; boxEnd >= 0 && r > boxEnd && !footer; r--) footer = matchClaudeModeIndicator(lines[r]);
  return { inputBox: boxEnd >= 0, composer, footer, dialog: boxEnd < 0 && lines.some(matchClaudeDialogLine) };
}

// Feeds one PTY chunk (OSC already stripped) into session._claudeTui: a screen grid sized like
// the PTY and what it shows now (claudeScreenState()), plus `mode`, the last footer mode seen,
// and `seq`, a per-chunk counter. Returns { from, to } when the footer shows a different mode
// than before (from null on the first one), else null.
function trackClaudeScreen(session, chunk, { now = Date.now(), rows, cols } = {}) {
  if (!session || typeof chunk !== 'string') return null;
  const tui = session._claudeTui || (session._claudeTui = {
    grid: createGrid(rows || 40, cols || 120), mode: null, modeAt: 0, inputBox: false, composer: null, footer: null, dialog: false, seq: 0,
  });
  if (rows > 0 && cols > 0) resizeGrid(tui.grid, rows, cols);
  feedGrid(tui.grid, chunk);
  Object.assign(tui, claudeScreenState(gridLines(tui.grid)));
  tui.seq++;
  if (!tui.footer) return null;
  const change = tui.footer !== tui.mode ? { from: tui.mode, to: tui.footer } : null;
  tui.mode = tui.footer;
  tui.modeAt = now;
  return change;
}

// Returns 'approved' | 'rejected' | 'execMode' | 'planMode' | null for one carved output row.
// Any non-plan footer (auto, accept edits, bypass permissions, manual) means plan mode was left.
function matchClaudePlanOutcomeLine(line) {
  if (typeof line !== 'string' || !line) return null;
  if (CLAUDE_PLAN_APPROVED_RE.test(line)) return 'approved';
  if (CLAUDE_PLAN_REJECTED_RE.test(line)) return 'rejected';
  if (CLAUDE_EXEC_MODE_RE.test(line)) return 'execMode';
  const mode = matchClaudeModeIndicator(line);
  if (mode && mode !== 'plan') return 'execMode';
  if (CLAUDE_PLAN_MODE_RE.test(line)) return 'planMode';
  return null;
}

// Native permission acknowledgement, never the picker or "selection requested" row.
// 0.164 uses /status's Permissions row; older TUIs announce the applied preset.
function matchCodexPermissionLine(line) {
  const m = /^\s*(?:[•●]\s*)?(?:Permissions updated to\s+|Permissions:\s*)(Approve for me|Workspace \(Approve for me\)|Full Access|Custom \(config\.toml\))\s*\.?\s*$/i.exec(line || '');
  return m ? (/^Full Access$/i.test(m[1]) ? 'bypass' : /^Custom/i.test(m[1]) ? 'custom' : 'auto') : null;
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
// 'approve' only for a short line made entirely of recognizable go-ahead phrases with no feedback
// cue; a question mark, a revision/negation word, or any unrecognized suffix reads as feedback. An
// unusual approval phrasing therefore stays 'feedback' (the run keeps waiting for Proceed or a
// clearer go-ahead) rather than a revision request ever counting as approval.
const APPROVAL_MAX_LEN = 80;
const APPROVAL_PHRASE = "(?:y|yes|yep|yup|yeah|ok|okay|k|sure|fine|good|great|perfect|agreed|confirmed|go(?: ahead| on)?|do it|proceed|approved?|plan approved|(?:implement|execute)(?: (?:it|(?:the |this )?(?:approved )?plan))?|(?:start|continue)(?: (?:implementing|implementation|coding))?|lgtm|looks good|sounds good|ship it|let['’]?s go|make it so)(?: now)?";
const APPROVAL_RE = new RegExp(`^(?:please )?${APPROVAL_PHRASE}(?:(?:[,.!; ]+| and )(?:please )?${APPROVAL_PHRASE})*[.! ]*$`, 'i');
const FEEDBACK_CUE_RE = /\?|\b(?:but|instead|however|don['’]?t|do not|not|no|nope|change|revise|rework|rethink|re-?plan(?:ning)?|planning|first|before|wait|hold|stop|except|unless|also|add|remove|drop|skip|without|rather|why|what|how|where|which|when|explain|question)\b/i;

function classifyTypedSubmission(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length > APPROVAL_MAX_LEN) return 'feedback';
  if (FEEDBACK_CUE_RE.test(t)) return 'feedback';
  return APPROVAL_RE.test(t) ? 'approve' : 'feedback';
}

module.exports = {
  matchCodexPermissionLine,
  matchClaudePlanOutcomeLine,
  matchClaudeModeIndicator,
  matchClaudeDialogLine,
  claudeScreenState,
  trackClaudeScreen,
  CLAUDE_QUEUED_HINT_RE,
  trackTypedLine,
  classifyTypedSubmission,
  TYPED_LINE_MAX,
  APPROVAL_MAX_LEN,
};
