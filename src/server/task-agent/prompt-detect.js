'use strict';

// Tail-scoped patterns gate injection; line-scoped patterns drive live attention.
// Changing mcpTrust/toolApproval/firstRun/askQuestion kinds also changes injection
// deferral. Keep toolApproval tail-only: line matching is last-hit-wins and can
// flip kind on one dialog's repaint. Recheck real CLI output after upgrades with
// probe:attention. Avoid generic busy/boot text such as "esc to interrupt" or
// "ready to code"; those are not user prompts.

const KIND_PRIORITY = ['toolApproval', 'mcpTrust', 'firstRun', 'askQuestion', 'planReady', 'attention'];

// Box-drawing / cursor-marker chars that render around dialog rows but carry no semantic
// content — stripped from promptText before it goes on the wire / into a notification body.
const DECOR_RE = /[│┃|╎┆❯➤▶›*]/g;
const PROMPT_TEXT_MAX = 120;

function sanitizePromptText(line) {
  if (typeof line !== 'string') return '';
  return line
    .replace(DECOR_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROMPT_TEXT_MAX);
}

// ── Prose-vs-dialog gate (C1059, tightened C1060) ──
// A handful of generic/Claude patterns below are loose enough to match ordinary assistant
// prose ("Do you want to proceed with the refactor?" inside a normal reply). Real dialog rows
// render with box-drawing borders, a cursor marker, or numbered-option decoration; prose
// doesn't. Patterns flagged `dialogOnly: true` only match a line carrying one of those —
// honoured ONLY by the line-scoped matchPromptLine()/_resolveMatch() below, never by
// buildLegacyPatternTable()'s tail-scoped consumer (see its own comment for why).
//
// (C1060) The gate now requires the decoration to be LEADING — a box-drawing/cursor char (or
// numbered option) anywhere on the line, incl. trailing (e.g. a box's right border, or a bare
// mid-sentence "2." in ordinary prose), used to be enough. That let ordinary numbered prose
// ("2. Would you like to keep it?") and a decoration-free line that merely echoes a box's right
// edge unlock every dialogOnly pattern — the reported "detecting ANY output as a prompt"
// symptom. Real dialog rows render decoration at the START of the line (a box's left border, or
// a cursor marker directly before the option digit); prose doesn't.
const DIALOG_ROW_RE = /^\s*[│┃╎┆]|^\s*[❯➤▶›]\s/;
function looksLikeDialogRow(line) {
  return typeof line === 'string' && DIALOG_ROW_RE.test(line);
}

// ── Generic (agent-agnostic) patterns ──
// (C1060) The two numbered/y-n patterns below are deliberately left UNGATED by dialogOnly (see
// § Prose-vs-dialog gate doc note in tt-terminal-attention-detection.md — decoration is
// inherent to the pattern's own wording). Tightened instead with an anchor: a real option row
// or y/n prompt sits at the START (❯ digit) or END (bracketed y/n) of its own line; the same
// text surviving mid-sentence in ordinary output ("output shows ❯ 2. done", "supports [y/n]
// flags for legacy scripts") no longer matches.
const GENERIC_PROMPT_PATTERNS = [
  { re: /^\s*[│┃╎┆]?\s*❯\s*\d+[.)]\s+\S/m },
  { re: /\[(?:y\/n|y\/N|Y\/n|yes\/no)\]\s*[:?]?\s*$/im },
  { re: /\((?:y\/n|yes\/no)\)\s*[:?]?\s*$/im },
  { re: /\bpress\s+(?:enter|return)\s+to\s+(?:continue|accept|confirm|approve)\b/i, dialogOnly: true },
  // (C1060) Span shortened 140 -> 80 chars and now excludes '?', box-drawing chars, and
  // newlines — the old class matched ANY char (including \n), so it could glue two separate
  // dialog-box lines' text together across a border, or run the full width of a long prose
  // sentence before finally hitting a '?' many words later.
  { re: /\bdo you want to\b[^?│┃╎┆\n]{0,80}\?/i, dialogOnly: true },
  { re: /\bwould you like to\b[^?│┃╎┆\n]{0,80}\?/i, dialogOnly: true },
  // (C1060) Dropped the optional "this" — bare "allow file"/"allow action" reads as ordinary
  // prose ("the config will allow file uploads"); a real dialog says "Allow this <noun>".
  { re: /\ballow\s+this\s+(?:command|edit|file|tool|action)\b/i, dialogOnly: true },
  { re: /\bapprove\s+this\s+(?:plan|edit|command|action)\b/i, dialogOnly: true },
];

// Legacy tail-scoped plan-ready wording retained for Claude. Codex no longer uses this loose
// set — see CODEX_PLAN_READY_PATTERNS below (C1236). Pi no longer uses it either — see
// PI_PLAN_READY_PATTERNS (C1116).
const PLAN_READY_SHARED_PATTERNS = [
  { re: /\bplan ready\b/i, kind: 'planReady' },
  { re: /\bimplementation plan\b/i, kind: 'planReady' },
  { re: /\bready to implement\b/i, kind: 'planReady' },
  { re: /\bwaiting for (?:your )?approval\b/i, kind: 'planReady' },
  { re: /^\s*(?:Step\s+\d+|Here(?:'s| is) (?:the|my) plan)/im, kind: 'planReady' },
];

// (C1236) Codex's kickoff prompt is echoed into its ratatui TUI. The old shared table's loose
// /\bplan ready\b/i matched that echo before Codex had studied anything, latching the plan-ready
// state before the real sentinel could arrive. Require a standalone line, allowing only the
// same harmless TUI row decoration as Pi's anchored sentinel (C1116).
const CODEX_PLAN_READY_PATTERNS = [
  { re: /^[\s>│┃╎┆❯➤▶›*]*plan ready[.!]?\s*$/im, kind: 'planReady' },
];

// (C1116) Pi-only plan-ready sentinel. Pi's kickoff prompt (pi-agent.js buildPrompt) instructs
// it to end its plan with a bare "Plan ready." line — but that SAME instruction text is
// echoed into Pi's own interactive TUI in the first frames (Pi has no --append-system-prompt
// suppression the way Claude/Codex do), and the loose PLAN_READY_SHARED_PATTERNS'
// /\bplan ready\b/i matched that echo, firing the ready dialog almost immediately instead of
// waiting for Pi's real sentinel after a full study/execution-steps block. Anchored to a
// whole line (optionally decorated by TUI row chars, never a double quote) so the echoed
// "...end with exactly "Plan ready.", then wait..." sentence can never satisfy it — only a
// standalone "Plan ready." row can. implementation plan / Step N / ready to implement /
// waiting for approval are dropped for Pi too — all match ordinary study-phase narration.
const PI_PLAN_READY_PATTERNS = [
  { re: /^[\s>│┃╎┆❯➤▶›*]*plan ready[.!]?\s*$/im, kind: 'planReady' },
];

// (C1134) Pi has no question tool — it asks by printing a numbered list and ending its turn
// (see BaseTaskAgent#buildClarifyDirective's compact variant, base-agent.js — wired into
// pi-agent.js's buildPrompt() since C1528; Codex uses the same sentinel via the full variant,
// codex-agent.js). Anchored the same way as PI_PLAN_READY_PATTERNS so the verbatim prompt echo
// can't self-trigger. kind stays undefined -> generic 'attention'; a 'planReady' kind here would
// wrongly pop the plan-approval dialog instead of prompting the user to type answers.
const PI_QUESTION_PATTERNS = [
  { re: /^[\s>│┃╎┆❯➤▶›*]*questions ready[.!]?\s*$/im },
];

// ── Codex-specific ──
const CODEX_TOOL_APPROVAL_PATTERNS = [
  { re: /\btool call needs your approval\b/i, kind: 'toolApproval' },
  { re: /\bneeds your approval\b/i, kind: 'toolApproval' },
  { re: /\ballow\b[\s\S]{0,120}\bto run tool\b/i, kind: 'toolApproval' },
  { re: /(?:^|\n)\s*(?:mcp\s+tool|agent\s+tool|tool):\s*\S/im, kind: 'toolApproval' },
];

// New in C1057, verified live against codex-cli 0.146.0. Deliberately generic kind (NOT
// toolApproval) — see HARD RULE above: these must never touch onInjectSilence()'s gate.
const CODEX_GENERIC_PATTERNS = [
  { re: /\bDo you want to approve network access to\b/i },
  { re: /\bCodex wants to edit\b/i },
  { re: /\bAllow Codex to run\b/i },
  { re: /^\s*Approval requested\b/i },
  { re: /\bYes, and don'?t ask again for commands that start with\b/i },
];

// Codex and Pi share the whole-line Questions ready. sentinel. Keep it line-only:
// the raw tail glues cursor-addressed rows, so anchored patterns cannot match there.
// Generic attention invites a typed answer without opening plan approval or gating
// initial injection.
const CODEX_QUESTION_PATTERNS = [
  { re: /^[\s>│┃╎┆❯➤▶›*]*questions ready[.!]?\s*$/im },
];

// ── Claude-specific ──
const CLAUDE_MCP_TRUST_PATTERNS = [
  { re: /\bnew mcp server(?:s)?\b/i, kind: 'mcpTrust' },
  { re: /\bmcp server(?:s)?\b[\s\S]{0,80}\b(?:trust|enable|allow|use this|do you)\b/i, kind: 'mcpTrust' },
  { re: /\b(?:trust|enable|allow|use this)\b[\s\S]{0,80}\bmcp server(?:s)?\b/i, kind: 'mcpTrust' },
  { re: /\bdo you trust\b/i, kind: 'mcpTrust' },
];

// New in C1057, verified live against claude 2.1.220.
const CLAUDE_GENERIC_PATTERNS = [
  { re: /\bdo you want to (?:make this edit|create|proceed|run)\b/i, dialogOnly: true },
  { re: /^\s*Choose an option:/i, dialogOnly: true },
  { re: /\bNo, and tell Claude what to do differently\b/i, dialogOnly: true },
  { re: /\bYes, and (?:don'?t ask again for|always allow access to)\b/i, dialogOnly: true },
  { re: /\bMCP server\b.{0,60}\b(?:requests your input|wants to open a URL)\b/i },
  { re: /\bClaude has written up a plan\b/i, kind: 'planReady' },
  { re: /\bClaude wants to (?:exit|enter) plan mode\b/i, kind: 'planReady' },
];

// First-run and per-project trust screens can block initial prompt injection.
// Match these only in the tail: the injection gate needs them, while line-scoped
// matching would let later reads of quoted screen text raise false attention.
// Raw tail rows may be glued, so avoid line anchors. Keep a late-painted option or
// footer phrase per screen within the 1KB tail; avoid generic security/login text.
const CLAUDE_FIRST_RUN_PATTERNS = [
  // Theme picker (onboarding step: preflight)
  { re: /\bTo change this later, run \/theme\b/i, kind: 'firstRun' },
  { re: /\bChoose the text style that looks best with your terminal\b/i, kind: 'firstRun' },
  { re: /\bDark mode \((?:colorblind-friendly|ANSI colors only)\)/i, kind: 'firstRun' },
  { re: /\bAuto \(match terminal\)/i, kind: 'firstRun' },
  // Login picker (onboarding step: api-key)
  { re: /\bClaude Code can be used with your Claude subscription or billed based on API usage\b/i, kind: 'firstRun' },
  { re: /\bSelect login method:[\s\S]{0,240}\bClaude account with subscription\b/i, kind: 'firstRun' },
  { re: /\bAnthropic Console account\b[\s\S]{0,120}\bAPI usage billing\b/i, kind: 'firstRun' },
  // Security notes (onboarding step: security)
  { re: /\bYou'?re responsible for Claude'?s actions and should always\b/i, kind: 'firstRun' },
  { re: /\bDue to prompt injection risks, only use it with code you trust\b/i, kind: 'firstRun' },
  // Terminal setup (onboarding step: terminal-setup)
  { re: /\bUse Claude Code'?s terminal setup\?/i, kind: 'firstRun' },
  { re: /\bNo, maybe later with \/terminal-setup\b/i, kind: 'firstRun' },
  { re: /\bYes, use recommended settings\b/i, kind: 'firstRun' },
  // Workspace / folder trust (onboarding_trust_dialog) — fires on EVERY new project directory,
  // not just a first-ever run; wording reconfirmed live against claude 2.1.241 (see doc block
  // above)
  { re: /\bYes, I trust this folder\b/i, kind: 'firstRun' },
  { re: /\bNo, continue without these permissions\b/i, kind: 'firstRun' },
  { re: /\bThis folder pre-approves \d+ tool permission/i, kind: 'firstRun' },
  { re: /\bQuick safety check: Is this a project you created or one you trust\b/i, kind: 'firstRun' },
  { re: /\bAccessing workspace:/i, kind: 'firstRun' },
  // Managed settings (enterprise policy trust confirm)
  { re: /\bManaged settings require approval\b/i, kind: 'firstRun' },
  { re: /\bYes, I trust these settings\b/i, kind: 'firstRun' },
  { re: /\bNo, exit Claude Code\b/i, kind: 'firstRun' },
];

// (C1219) Consulted ONLY inside terminal-session.js's onInjectSilence() 'firstRun' defer branch
// — proof of an actually-ready REPL, not just silence, before injecting the task prompt. C1120's
// dismiss-detection (lineDialogLeftScreen/dialogGateCleared) clears the gate the moment a
// screen's line-scoped state goes inactive, but an option-less intermediate wait between two
// onboarding steps (e.g. "opening browser for login…") also looks inactive — pure silence would
// paste into that wait. Both markers verified present in the installed claude 2.1.241 binary via
// a `strings` dump: the CLI's own REPL footer hint, and this app's spawn always passes
// `--permission-mode plan` (claude-agent.js), which renders a "plan mode on" indicator once the
// REPL is truly up.
const CLAUDE_REPL_READY_PATTERNS = [
  /\?\s*for shortcuts\b/i,
  /\bplan mode on\b/i,
];
function isClaudeReplReady(tail) {
  return typeof tail === 'string' && CLAUDE_REPL_READY_PATTERNS.some((re) => re.test(tail));
}

// A large paste is not echoed into Claude's input box verbatim: the TUI collapses it to a
// `[Pasted text #N +M lines]` chip, and that chip stays in the input until the prompt is
// submitted (on submit it expands into the transcript). It is therefore the on-screen proof that
// the kickoff was pasted but NOT yet submitted. Consulted ONLY by terminal-session.js's submit
// verification (after the Enter), together with PTY silence and the absence of any dialog —
// never by the injection gate or the attention detector. `\s*` between the words because Ink
// draws with cursor moves, so ANSI-stripped output can glue them ("Pastedtext #1"). Verified live
// against claude 2.1.283 (~5-6 KB kickoff pastes): chip present + PTY silent for seconds while
// unsubmitted; gone within ms of an Enter, followed by continuous spinner output. Re-verify after
// CLI upgrades — a CLI that stops collapsing pastes simply never matches, which disables the
// re-send (the Enter is then sent exactly once, as before).
const CLAUDE_PENDING_PASTE_RE = /\[Pasted\s*text\s*#\d+/i;

// Before first injection, Claude's AskUserQuestion menu must defer pending paste.
// Match stable menu chrome in the raw tail without line anchors; keep it out of
// line-scoped patterns to avoid later self-echo from docs or task text.
const CLAUDE_ASK_QUESTION_PATTERNS = [
  { re: /\bType something\b/i, kind: 'askQuestion' },
  { re: /\bChat about this\b/i, kind: 'askQuestion' },
];

// Tool approval is a tail-only kind. Line-scoped last-match-wins classification
// would flip between generic question and approval rows as the dialog repaints,
// raising attention repeatedly. Match late-painted option text so it stays in
// the 1KB tail; require a leading option digit to avoid quoted prose matches.
// Do not anchor to line start: cursor-addressed rows are glued in the raw tail.
const CLAUDE_TOOL_APPROVAL_PATTERNS = [
  { re: /\d[.)][\s│┃╎┆❯➤▶›]*Yes, and (?:don'?t ask again for|always allow access to)\b/i, kind: 'toolApproval' },
  { re: /\d[.)][\s│┃╎┆❯➤▶›]*No, and tell Claude what to do differently\b/i, kind: 'toolApproval' },
];

// ── Claude "background agents still running" busy signal (TPT348) ──
// NOT an attention pattern and deliberately in no prompt table above: it never raises anything,
// it only tells terminal-session.js that a quiet screen means "waiting on sub-agents", not
// "waiting on a human" (so the BEL fallback, index.js's idle fallback and the plan-ready idle
// timer stand down). Consumed line-by-line, in stream order, via matchClaudeBgAgentsLine().
//
// 'wait' — the turn-end status row Claude prints instead of its duration row while Agent-tool
//   runs are still in flight ("Waiting for 2 background agents to finish", singular for one).
//   It is a permanent transcript row, painted once and never repainted, so the consumer latches
//   on it rather than expecting to see it again. Anchored to the START of the line (only a
//   spinner/bullet glyph may precede it — never a quote or backtick): the same phrase quoted
//   mid-sentence in a kickoff prompt, in ai/architecture/tt-terminal-attention-detection.md, or
//   inside a test file's quoted string must never latch a session busy. The doc spells the
//   count as a placeholder, not a digit.
// 'row'  — a live agents-panel row ("○ Explore  <description>  4m 17s · ↓ 116.0k tokens") or the
//   bare elapsed/tokens fragment Claude's cell-diff renderer repaints as the timer ticks. These
//   refresh the latch while agents run silently for a long time.
// 'done' — the ordinary turn-end duration row ("✻ Worked for 12s"). Verb list confirmed against
//   the installed claude 2.1.282 binary (byte-scan: Baked, Brewed, Churned, Cogitated, Cooked,
//   Crunched, Sautéed, Worked). It supersedes an earlier 'wait' row, so it un-latches.
// Wording comes from a screenshot plus that binary scan, not a literal live capture — re-verify
// after CLI upgrades.
const CLAUDE_BG_AGENTS_WAIT_RE = /^\s*[✻✳✶✽✢✺⏺*·●•]?\s*Waiting for (\d+) background agents? to finish\b/i;
const CLAUDE_BG_AGENTS_ROW_RE = /^\s*(?:[○◯●◦•]\s+\S.*?\s+)?\d+(?:h \d+m|m \d+s|s)\s+·\s+[↓↑]\s*[\d.,]+[kKmM]?\s+tokens\s*$/;
const CLAUDE_TURN_DONE_RE = /^\s*[✻✳✶✽✢✺⏺*·●•]?\s*(?:Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked) for \d+(?:h|m|s)\b/;

// Returns 'wait' | 'row' | 'done' | null for one carved line.
function matchClaudeBgAgentsLine(line) {
  if (typeof line !== 'string' || !line) return null;
  if (CLAUDE_BG_AGENTS_WAIT_RE.test(line)) return 'wait';
  if (CLAUDE_TURN_DONE_RE.test(line)) return 'done';
  if (CLAUDE_BG_AGENTS_ROW_RE.test(line)) return 'row';
  return null;
}

// ── Per-agent tables consumed by BaseTaskAgent#isPromptLine() overrides ──
// (C1219) CLAUDE_FIRST_RUN_PATTERNS is deliberately NOT included here — see its own doc block
// above for why it stays tail-scoped only (buildLegacyPatternTable() below), never line-scoped.
const CLAUDE_PROMPT_PATTERNS = [...CLAUDE_GENERIC_PATTERNS, ...CLAUDE_MCP_TRUST_PATTERNS];
const CODEX_PROMPT_PATTERNS = [...CODEX_GENERIC_PATTERNS, ...CODEX_TOOL_APPROVAL_PATTERNS, ...CODEX_PLAN_READY_PATTERNS, ...CODEX_QUESTION_PATTERNS];
const PI_PROMPT_PATTERNS = [...PI_PLAN_READY_PATTERNS, ...PI_QUESTION_PATTERNS];

// Resolves the highest-priority kind among all patterns that match a single line/tail,
// returning null when nothing matched. Shared priority order for both consumers described
// at the top of this file. `gateDialogOnly` (line-scoped consumer only, see caller) skips a
// `dialogOnly` pattern unless `line` itself looks like a rendered dialog row — prose never
// carries that decoration, so this is what keeps assistant prose from matching the loose
// "do you want to…?" style patterns (C1059).
function _resolveMatch(patterns, testFn, line, gateDialogOnly) {
  const saw = { toolApproval: false, mcpTrust: false, firstRun: false, planReady: false, attention: false };
  const isDialogRow = gateDialogOnly ? looksLikeDialogRow(line) : true;
  for (const { re, kind, dialogOnly } of patterns) {
    if (dialogOnly && gateDialogOnly && !isDialogRow) continue;
    if (!testFn(re)) continue;
    saw[kind || 'attention'] = true;
  }
  for (const kind of KIND_PRIORITY) {
    if (saw[kind]) return { kind, promptText: sanitizePromptText(line) };
  }
  return null;
}

// Line-scoped match used by BaseTaskAgent#isPromptLine() (C1057). Applies the dialogOnly
// prose gate (C1059) — the tail-scoped consumer (buildLegacyPatternTable() below) does not,
// per the HARD RULE at the top of this file.
function matchPromptLine(line, patterns) {
  if (typeof line !== 'string' || !line) return null;
  return _resolveMatch(patterns, (re) => re.test(line), line, true);
}

// Reconstructs the flat [{re, agents?, kind?}] table the original inline array in
// terminal-session.js exposed, so getAttentionPromptMatch()'s tail-scoped behaviour for
// every pre-existing pattern (and its four dependent bug fixes) stays byte-identical.
// Strips `dialogOnly` (C1059) — that gate is meaningless against a multi-line rolling tail
// and must never change what onInjectSilence()/the MCP-trust auto-answer react to; see the
// HARD RULE at the top of this file.
function buildLegacyPatternTable() {
  const stripDialogOnly = (p) => {
    const { dialogOnly, ...rest } = p; // eslint-disable-line no-unused-vars
    return rest;
  };
  return [
    ...GENERIC_PROMPT_PATTERNS.map(stripDialogOnly),
    // (C1236) These older loose entries remain tail-scoped for Claude only. Codex uses the
    // anchored CODEX_PLAN_READY_PATTERNS below; retaining the old entries under codex would
    // reintroduce the echoed-kickoff false positive through getAttentionPromptMatch().
    ...PLAN_READY_SHARED_PATTERNS.map((p) => ({ ...stripDialogOnly(p), agents: ['claude'] })),
    ...CODEX_PLAN_READY_PATTERNS.map((p) => ({ ...stripDialogOnly(p), agents: ['codex'] })),
    ...PI_PLAN_READY_PATTERNS.map((p) => ({ ...stripDialogOnly(p), agents: ['pi'] })),
    // (C1134) Deliberately NOT added here — buildLegacyPatternTable() feeds the tail-scoped
    // inject/mcpTrust gate, which is already a no-op for Pi (positional-prompt spawn mode has
    // injectDone=true at spawn, see terminal-session.js). Line-scoped only via PI_PROMPT_PATTERNS.
    ...CODEX_TOOL_APPROVAL_PATTERNS.map((p) => ({ ...stripDialogOnly(p), agents: ['codex'] })),
    ...CODEX_GENERIC_PATTERNS.map((p) => ({ ...stripDialogOnly(p), agents: ['codex'] })),
    ...CLAUDE_GENERIC_PATTERNS.map((p) => ({ ...stripDialogOnly(p), agents: ['claude'] })),
    ...CLAUDE_MCP_TRUST_PATTERNS.map((p) => ({ ...stripDialogOnly(p), agents: ['claude'] })),
    // (C1219) Tail-scoped only, by design — see CLAUDE_FIRST_RUN_PATTERNS' own doc block.
    ...CLAUDE_FIRST_RUN_PATTERNS.map((p) => ({ ...stripDialogOnly(p), agents: ['claude'] })),
    // (C1272) Tail-scoped only, by design — see CLAUDE_ASK_QUESTION_PATTERNS' own doc block.
    ...CLAUDE_ASK_QUESTION_PATTERNS.map((p) => ({ ...stripDialogOnly(p), agents: ['claude'] })),
    // (C1386) Tail-scoped only, by design — see CLAUDE_TOOL_APPROVAL_PATTERNS' own doc block.
    ...CLAUDE_TOOL_APPROVAL_PATTERNS.map((p) => ({ ...stripDialogOnly(p), agents: ['claude'] })),
  ];
}

module.exports = {
  GENERIC_PROMPT_PATTERNS,
  CLAUDE_PROMPT_PATTERNS,
  CLAUDE_FIRST_RUN_PATTERNS,
  CLAUDE_ASK_QUESTION_PATTERNS,
  CLAUDE_TOOL_APPROVAL_PATTERNS,
  CLAUDE_REPL_READY_PATTERNS,
  CLAUDE_PENDING_PASTE_RE,
  CODEX_PROMPT_PATTERNS,
  CODEX_PLAN_READY_PATTERNS,
  CODEX_QUESTION_PATTERNS,
  PI_PROMPT_PATTERNS,
  PI_PLAN_READY_PATTERNS,
  PI_QUESTION_PATTERNS,
  matchPromptLine,
  matchClaudeBgAgentsLine,
  sanitizePromptText,
  looksLikeDialogRow,
  isClaudeReplReady,
  buildLegacyPatternTable,
  KIND_PRIORITY,
};
