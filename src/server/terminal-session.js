'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { beginSessionMemory, endSessionMemory } = require('./session-memory');
const { refreshSessionVcs } = require('./vcs-context');
let pty;
try {
  pty = require('node-pty');
} catch (err) {
  const hint = /NODE_MODULE_VERSION|was compiled against a different/i.test(String(err && err.message))
    ? 'node-pty ABI mismatch — run: npm rebuild node-pty (or under Electron: npx electron-rebuild -f -w node-pty)'
    : 'node-pty failed to load';
  console.error(`[terminal-session] ${hint}\n${err && err.stack || err}`);
  throw err;
}
const config = require('./config');
const { assertCredentialsUsable, tokenExpiryMs, formatTokenExpiry } = require('./auth-guard');
const { refreshProjectToken } = require('./token-refresh');
const { getApiCredentials } = require('./api-credentials');
const { getTaskAgent } = require('./task-agent');
const BaseTaskAgent = require('./task-agent/base-agent');
const { buildLegacyPatternTable, sanitizePromptText, isClaudeReplReady, matchClaudeBgAgentsLine } = require('./task-agent/prompt-detect');
const { reflowChunk, carveReflowLines, resetReflow } = require('./screen-reflow');
const { maxCommentId, isTerminalTailExitComment } = require('./exit-resolution');
const { syncOnSessionStart, isSyncAsYouGoEnabled } = require('../cli/knowledge-sync');
const archCache = require('../mcp/architecture-cache');
const { getTagsForTask } = require('./tag-cache');
const { resolveAttachmentDir } = require('./attachment-paths');
const {
  killProcessGroup,
  killProcessTree,
  resolveTreeTargets,
  signalTargets,
  DESCENDANT_ALERT_THRESHOLD,
  describeActPolicy,
  describeRunawayReason,
  describeTree,
  resolveAgentLimits,
  countActiveAgentSessions,
  scaleAgentLimitsForConcurrency,
} = require('./process-group');

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
function stripAnsi(s) { return s.replace(ANSI_RE, ''); }

// ── OSC strip (C1060) ──
// stripAnsi() above only strips CSI (`ESC [ … final`) and 2-char escapes — it does NOT strip
// OSC strings (`ESC ] … BEL` or `ESC ] … ESC \`). Claude Code emits OSC constantly (terminal
// title OSC 0/1/2, `OSC 9;4` progress "during long operations", OSC 8 hyperlinks, OSC 52
// clipboard — confirmed via strings dump of the installed claude 2.1.222 binary), and their
// BEL terminator survived stripAnsi() into both the raw chunk and cleanChunk. feedAttentionChunk()
// step 2 reads any bare \x07 as the opt-in terminal-bell "needs input" signal — so every title/
// progress repaint was raising attention, plain output cleared it ~400ms later, the next repaint
// raised it again: a raise/clear flap at repaint rate. This is the confirmed root cause of the
// reported "permanent flicker, notifications never stop" bug (C1060) — NOT a prompt-pattern
// over-match, though prompt-detect.js patterns are also tightened separately below.
// Chunk-carrying: an OSC string routinely spans two PTY flushes, so a half-consumed OSC's BEL
// must not leak into the next chunk as a false bell. `session._attentionOscOpen` tracks an OSC
// left open at the end of a chunk; reset alongside `_attentionLineCarry` on clear/alt-screen.
const OSC_OPEN_RE = /\x1b\]/;
function stripOscChunk(session, s) {
  let out = '';
  let i = 0;
  let open = !!(session && session._attentionOscOpen);
  while (i < s.length) {
    if (open) {
      // OSC terminates on BEL or ST (ESC \).
      const bel = s.indexOf('\x07', i);
      const st = s.indexOf('\x1b\\', i);
      let end = -1, skip = 0;
      if (bel !== -1 && (st === -1 || bel < st)) { end = bel; skip = 1; }
      else if (st !== -1) { end = st; skip = 2; }
      if (end === -1) { i = s.length; break; } // OSC still open at chunk end
      open = false;
      i = end + skip;
      continue;
    }
    const m = OSC_OPEN_RE.exec(s.slice(i));
    if (!m) { out += s.slice(i); break; }
    out += s.slice(i, i + m.index);
    i += m.index + m[0].length;
    open = true;
  }
  if (session) session._attentionOscOpen = open;
  return out;
}

// Tail-scoped pattern table (C1057): sourced from task-agent/prompt-detect.js so this stays
// byte-identical to the pre-C1057 inline array for getAttentionPromptMatch()'s two consumers
// below — onInjectSilence()'s paste-injection gate and the plan-ready state machine in
// onData(). The REAL-TIME attention signal (session._attentionState) no longer reads this
// table at all — see carveAttentionLines()/feedAttentionChunk() and
// BaseTaskAgent#isPromptLine() further down, which is line-scoped and per-agent instead.
const ATTENTION_PROMPT_PATTERNS = buildLegacyPatternTable();
const ATTENTION_WINDOW_BYTES = 1024;
const ATTENTION_CLEAR_MIN_BYTES = 4;
// (C1060) Floor on a hit's sanitized promptText before it counts as a "distinct" prompt for the
// re-raise/clear identity checks below. A short, generic promptText (a single common word, a
// bare "[y/n]") can `.includes()`-match all sorts of unrelated later output — without this floor
// that kept promptStillVisible() perpetually true, pinning _attentionState open past
// ATTENTION_STALE_MS even once the real dialog was long gone.
const ATTENTION_PROMPT_TEXT_MIN = 12;
const ATTENTION_LINE_CARRY_MAX = 4096; // cap the cross-chunk partial-line buffer (C1057)
const ATTENTION_REDRAW_GRACE_MS = 400; // dialogs commonly repaint across several PTY chunks
// (C1386) Hard ceiling on how long shouldHoldAttention() below may keep _attentionState raised
// with no fresh line-scoped evidence, purely because the tail still reports an unanswered
// inject-gate dialog. Must exceed index.js's ATTENTION_STALE_MS (120000) or that sweep clears the
// state before the hold ever has anything to do. 30min matches this file's other "a human has to
// walk over and answer this" budgets (MAX_FIRST_RUN_RETRIES/MAX_ASK_QUESTION_RETRIES *
// INJECT_DIALOG_RETRY_MS, PRELUDE_MAX_WAIT_MS).
const ATTENTION_HOLD_MAX_MS = 30 * 60 * 1000;
// (TPT348) Ceiling on how long bgAgentsBusy() below stays true with no fresh sighting of a
// "Waiting for N background agents to finish" row or an agents-panel row, so a missed clear can
// never mute the quiet-screen attention fallbacks forever. Same 30min budget as the hold above.
const BG_AGENTS_BUSY_MAX_MS = 30 * 60 * 1000;
const MAX_INJECT_DIALOG_RETRIES = 3;  // cap deferrals so a stuck dialog still injects (C880)
const MAX_MCP_TRUST_RETRIES = 60;  // fallback cap when the dialog can't be auto-answered — defer up to ~60s (C997, C1047)
// (C1219) Claude's first-run onboarding chain / workspace-trust dialog has no safe auto-answer
// (unlike mcpTrust) and is not machine-fast (unlike toolApproval) — there is no value at which
// falling through to a blind paste is better than continuing to wait, so this cap governs a
// quiet give-up instead of a paste-at-cap fallback (see onInjectSilence()'s 'firstRun' branch).
// Every screen transition already resets injectRetries to 0 (lineDialogLeftScreen()/
// dialogGateCleared() below), so this budget is effectively PER SCREEN, not a single global
// wait — ~30 min at INJECT_DIALOG_RETRY_MS pacing per screen is generous without being infinite.
const MAX_FIRST_RUN_RETRIES = 1800;
const FIRST_RUN_LONG_WAIT_RETRIES = 120;  // ~2 min — second, more insistent notice
// (C1272) An open AskUserQuestion menu (design mode's model asking a clarifying question, or
// any future prelude-style submission that ends up on one) has no safe auto-answer — same
// give-up discipline as firstRun above, never a blind paste-at-cap. A human may take a while to
// notice and answer, so the budget matches firstRun's ~30min rather than the machine-fast
// toolApproval cap.
const MAX_ASK_QUESTION_RETRIES = 1800;
const MCP_TRUST_ANSWER_ENTER_DELAY_MS = 200;  // gap between digit keypress and Enter so Claude's Ink TUI sees two distinct key events, not one "2\r" chunk (C1047)
const INJECT_DIALOG_RETRY_MS = 1000;  // reschedule interval while MCP trust / tool dialog is up (C880)
const INJECT_MAX_WAIT_MS = 10000;  // ceiling: force paste/Enter if the TUI never goes quiet (C947)
const RESUME_REPAINT_WOBBLE_MS = 120;  // gap between resize-down and resize-restore on resume (C966)
// (C1260) spec.preludePrompt phase — a slash command (e.g. /design) submitted alone
// before the task prompt so it actually runs as a command instead of being swallowed as
// the task prompt's first line. Completion is judged by PTY SILENCE, not readiness:
// isClaudeReplReady() matches "plan mode on" (this app always spawns
// --permission-mode plan), which is present in the footer WHILE the turn is still
// running too, so it can't be the signal a turn ended. A real turn repaints its spinner
// continuously; only a multi-second quiet window means it's actually done.
const PRELUDE_MIN_RUN_MS = 3000;   // floor: never call it done before /design even starts rendering
const PRELUDE_QUIET_MS = 5000;     // required silence (off session.lastOutputAt) before release
const PRELUDE_MAX_WAIT_MS = 30 * 60 * 1000;  // give-up ceiling, mirrors MAX_FIRST_RUN_RETRIES's ~30min budget
const PRELUDE_LONG_WAIT_MS = 5 * 60 * 1000;  // second, more insistent "still running" notice
// (TPT364) Submit verification. The kickoff's Enter can be lost with the paste already sitting in
// the input box (the user then presses Enter by hand). A submitted prompt starts a turn whose
// spinner repaints continuously; a stranded one leaves the agent's paste marker
// (agent.getUnsentPasteRe(), the `[Pasted text #N]` chip for Claude) in the tail with the PTY
// completely silent. That state — and only that state, and never with a dialog on screen — gets
// the Enter re-sent, bounded, with a terminal notice.
const SUBMIT_VERIFY_MS = 2500;   // first check this long after the Enter
const SUBMIT_QUIET_MS = 1500;    // PTY silence that separates "stranded" from "a turn is running"
const SUBMIT_POLL_MS = 1000;     // re-check cadence while the marker is visible but the TUI still animates
const SUBMIT_WATCH_MS = 15000;   // stop watching this long after the last Enter
const SUBMIT_MARKER_TRAILING_MAX = 500;  // an unsent paste is the LAST thing drawn: only footer/hint text may follow its marker in the tail
const MAX_SUBMIT_RETRIES = 2;

// True when `re` (the agent's unsent-paste marker) occurs in `tail` with at most
// SUBMIT_MARKER_TRAILING_MAX chars after its last occurrence. The rolling tail is a stream, not a
// screen: after a real submit an old marker can linger in it, but real output then follows it.
function unsentPasteVisible(re, tail) {
  if (!re || typeof tail !== 'string' || !tail) return false;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let last = -1;
  for (const m of tail.matchAll(g)) last = m.index;
  return last >= 0 && tail.length - last <= SUBMIT_MARKER_TRAILING_MAX;
}

// Pure predicate for the awaitPreludeRun release decision — exported for unit testing
// alongside the other pure gate helpers below (isInjectGateKind/lineDialogLeftScreen/
// dialogGateCleared). All four conditions must hold:
// - waitedMs: time since the prelude was submitted (Enter pressed) — guards the instant
//   right after submit where the TUI still looks idle before /design starts rendering.
// - quietMs: time since the PTY last produced output — the actual "the turn ended" signal.
// - gated: true when an isInjectGateKind() dialog (mcpTrust/toolApproval/firstRun) is on
//   screen — /design run under --permission-mode plan normally ends AT a plan-approval
//   dialog, and injecting the task prompt into that open dialog would be swallowed by it.
// - replReady: cheap "REPL is alive at all" sanity check (isClaudeReplReady()).
function shouldReleasePrelude({ waitedMs, quietMs, gated, replReady }) {
  return waitedMs >= PRELUDE_MIN_RUN_MS && quietMs >= PRELUDE_QUIET_MS && !gated && !!replReady;
}

// Codex redraws scrollback above its live composer. A standalone sentinel is only
// a candidate: a later submitted prompt or busy row makes it historical. Composer
// placeholders are not submissions (they also remain visible during active work).
const CODEX_PLAN_QUIET_MS = 2000;
const CODEX_COMPOSER_PLACEHOLDERS = [
  'Ask Codex to do anything', 'Type a message', 'Find and fix a bug in @filename',
  'Explain this codebase', 'Summarize recent commits', 'Write tests for @filename',
  'Improve documentation in @filename', 'Implement {feature}',
];
function codexTurnMarker(line) {
  const prompt = /^\s*[›❯>]\s*(\S.*)$/.exec(line);
  // Prefixes matter too: the placeholder itself can arrive in split PTY writes.
  // Check input before the sentinel: "› Plan ready." is an echoed submission.
  if (prompt && !CODEX_COMPOSER_PLACEHOLDERS.some(text => text.toLowerCase().startsWith(prompt[1].trim().toLowerCase()))) return 'work';
  if (getTaskAgent('codex').isPromptLine(line)?.kind === 'planReady') return 'plan';
  if (/^\s*[•·◦*]?\s*Working\s*\(/i.test(line)
      || /^\s*[•·◦*].*\besc to interrupt\b/i.test(line)
      || /^\s*esc to interrupt\s*$/i.test(line)
      // Commands and background waits can go quiet without a Working repaint.
      // Their transcript rows invalidate an older sentinel just like the spinner.
      || /^\s*[•·◦*]\s*(?:Ran|Running|Waiting|Reading|Calling|Installing|Testing)\b/i.test(line)
      || /^\s*[└├]/.test(line)) return 'work';
  return null;
}

function codexTextPlanReady(text) {
  let marker = null;
  for (const line of text.split(/\r\n|[\r\n]/)) marker = codexTurnMarker(line) || marker;
  return marker === 'plan';
}

function codexPlanReadyIsFresh(session) {
  return session.taskAgent !== 'codex' || session._codexPlan?.ready === true;
}

function invalidateCodexPlan(session) {
  if (session.taskAgent !== 'codex' && !session._codexPlan) return;
  const announced = session._planReadySent || session.codexPlanReady === true;
  session._codexPlan = { candidate: null, ready: false };
  clearTimeout(session._planIdleTimer);
  session._planIdleTimer = null;
  session._planFirstArmedAt = null;
  session._planReadySent = false;
  session.codexPlanReady = false;
  session.agentPlanReady = false;
  if (session._attentionState?.kind === 'planReady') {
    session._attentionState = null;
    session._patternAttentionNeeded = false;
    session.onAttentionCleared?.();
  }
  // The client removes its approval dialog on terminal-state, not on the board's
  // attention-cleared event. Publish the falling edge, including after repaint
  // temporarily reset the readiness flags but left the announced dialog open.
  if (announced) emitTerminalState(session);
}

function feedCodexPlan(session, agent, lines, carry, hit) {
  session._codexPlan ||= { candidate: null, ready: false };
  // A provisional end-of-chunk sentinel can grow into ordinary prose on the
  // next write. Do not keep the earlier candidate when that line is extended.
  if (session._codexPlan.partial && lines.length && codexTurnMarker(lines[0]) !== 'plan') {
    if (session._codexPlan.repainting) {
      session._codexPlan.candidate = null;
      session._codexPlan.partial = false;
    } else invalidateCodexPlan(session);
  }
  let marker = null;
  for (const line of lines) marker = codexTurnMarker(line) || marker;
  if (hit && hit.kind !== 'planReady') invalidateCodexPlan(session);
  else if (marker === 'work') {
    if (session._codexPlan.repainting) session._codexPlan.candidate = null;
    else invalidateCodexPlan(session);
  } else if (marker === 'plan') {
    session._codexPlan.candidate = { kind: 'planReady', promptText: 'Plan ready.' };
    session._codexPlan.partial = !!carry && codexTurnMarker(carry) === 'plan';
  }
  const state = session._codexPlan;
  if ((!state.candidate && !state.repainting) || state.ready) return;
  // Wait for the rest of a split repaint before raising either attention or the
  // approval dialog. Never use the generic ten-second ceiling while Codex works.
  clearTimeout(session._planIdleTimer);
  session._planIdleTimer = setTimeout(() => {
    if (session._codexPlan !== state || session.alive === false
        || session._terminated || (session.terminalPhase && session.terminalPhase !== 'planning')) return;
    state.repainting = false;
    if (!state.candidate) {
      invalidateCodexPlan(session);
      return;
    }
    const tailHit = getAttentionPromptMatch(session._attentionTail || '', 'codex', session);
    if (tailHit && tailHit.kind !== 'planReady') return;
    state.ready = true;
    session.agentPlanReady = true;
    session.codexPlanReady = true;
    if (session._attentionState?.kind !== 'planReady') {
      session._attentionState = { ...state.candidate, agent: agent.id, at: Date.now() };
      session._patternAttentionNeeded = true;
      session.onAttentionNeeded?.({ ...state.candidate, agent: agent.id });
    }
    if (session.terminalPhase === 'planning' && !session._planReadySent
        && (session.buffer || '').length > planReadyMinBufferLength(session)
        && session.ws && session.ws.readyState === session.ws.OPEN) {
      session._planReadySent = true;
      session.ws.send(JSON.stringify({ type: 'plan-ready', tabId: session.tabId, codexPlanReady: true }));
    }
  }, state.repainting && !state.candidate
    ? Math.max(0, state.repaintDeadline - Date.now()) : CODEX_PLAN_QUIET_MS);
  session._planIdleTimer.unref?.();
}

function getAttentionPromptMatch(s, agentId, session = null) {
  let sawAttention = false;
  let sawPlanReady = false;
  let sawToolApproval = false;
  let sawMcpTrust = false;
  let sawFirstRun = false;
  let sawAskQuestion = false;

  for (const { re, agents, kind } of ATTENTION_PROMPT_PATTERNS) {
    if (agents && !agents.includes(agentId)) continue;
    if (!re.test(s)) continue;
    if (kind === 'toolApproval') sawToolApproval = true;
    else if (kind === 'mcpTrust') sawMcpTrust = true;
    else if (kind === 'firstRun') sawFirstRun = true;
    else if (kind === 'askQuestion') sawAskQuestion = true;
    else if (kind === 'planReady') {
      if (agentId !== 'codex' || (codexTextPlanReady(s)
          && (!session || codexPlanReadyIsFresh(session)))) sawPlanReady = true;
    }
    else sawAttention = true;
  }
  // Priority order kept in sync with task-agent/prompt-detect.js's exported KIND_PRIORITY.
  if (sawToolApproval) return { kind: 'toolApproval' };
  if (sawMcpTrust) return { kind: 'mcpTrust' };
  if (sawFirstRun) return { kind: 'firstRun' };
  if (sawAskQuestion) return { kind: 'askQuestion' };
  if (sawPlanReady) return { kind: 'planReady' };
  if (sawAttention) return { kind: 'attention' };
  return null;
}

// ── Real-time attention detection (C1057) ──
// Line-scoped, symmetric raise/clear, fires immediately from onData() instead of the old
// idle-timeout sweep. Deliberately separate from (and never touches) the tail-scoped
// getAttentionPromptMatch() above, which stays wired to onInjectSilence()'s paste-injection
// gate and the plan-ready state machine — see the HARD RULE in task-agent/prompt-detect.js.

// Splits a stripAnsi'd chunk into complete display lines, carrying the trailing partial line
// across calls in session._attentionLineCarry. Bare \r is treated as a line boundary too —
// TUIs redraw a status line in place with \r, so the text before it is a finished render,
// not a fragment. Prepending the carry to the first element is what lets a prompt split
// across two PTY chunks still match on the chunk that completes it. The carry is also
// re-emitted as a *provisional* line (dialog rows often paint with no trailing newline at
// all) — at most this double-evaluates one line, which feedAttentionChunk()'s
// "same promptText -> don't re-raise" rule absorbs for free.
function carveAttentionLines(session, cleanChunk) {
  const combined = (session._attentionLineCarry || '') + cleanChunk;
  const parts = combined.split(/\r\n|\n|\r/);
  let carry = parts.pop() || '';
  if (carry.length > ATTENTION_LINE_CARRY_MAX) carry = carry.slice(-ATTENTION_LINE_CARRY_MAX);
  session._attentionLineCarry = carry;
  const lines = parts;
  if (carry) lines.push(carry);
  return lines;
}

// (C1059) Sanitized membership check shared by the re-raise and clear paths below. `promptText`
// (on session._attentionState) is already sanitized — it comes straight out of
// matchPromptLine()'s sanitizePromptText() call — but raw carved `lines` are not, so each line
// must be sanitized before the containment check. Without this, a prompt whose sanitized form
// differs from its raw rendering only by decoration (sanitizePromptText's DECOR_RE strips
// box-drawing/cursor chars AND '*'/'|', so e.g. a prompt mentioning "tt-*.md" or a shell pipe
// never matches its own raw repaint) would spuriously look "gone", clearing the state and then
// re-raising on the very next chunk — a second, narrower source of the same repaint flicker.
function promptStillVisible(lines, promptText) {
  // (C1060) A promptText shorter than ATTENTION_PROMPT_TEXT_MIN (a bare "[y/n]", a single
  // common word) is generic enough to `.includes()`-match unrelated later output forever —
  // treat it as never "still visible" so a short false-positive can't pin _attentionState open
  // past ATTENTION_STALE_MS once the containment check below is the only thing blocking clear.
  if (!promptText || promptText.length < ATTENTION_PROMPT_TEXT_MIN) return false;
  return lines.some((l) => sanitizePromptText(l).includes(promptText));
}

// Claude "waiting on background agents" busy latch (TPT348). A turn that ends with
// Agent-tool runs in flight prints "Waiting for N background agents to finish" and goes
// quiet; the quiet-screen raisers (BEL fallback, idle fallback, plan-ready idle timer)
// would read that as "needs a human". Latched because the status row paints once and
// never repaints: set/refreshed on the waiting row or an agents-panel row, cleared on the
// turn-end duration row or a full repaint. Gates only quiet-screen raisers — real
// line-pattern dialogs still raise. Row shapes: matchClaudeBgAgentsLine() in prompt-detect.js.
function trackBgAgents(session, lines, now) {
  for (const line of lines) {
    const kind = matchClaudeBgAgentsLine(line);
    if (kind === 'wait' || kind === 'row') session._bgAgentsBusyAt = now;
    else if (kind === 'done') session._bgAgentsBusyAt = null;
  }
}

function bgAgentsBusy(session, now = Date.now()) {
  const at = session._bgAgentsBusyAt;
  return typeof at === 'number' && now - at < BG_AGENTS_BUSY_MAX_MS;
}

// Feed both legacy and row-reflowed PTY text to line-scoped attention detection.
// Always feed rowChunk when supplied, even if it equals cleanChunk: skipping a chunk
// would break cross-chunk row carry. Return the resolved hit for anchored plan
// sentinels, which the un-reflowed tail cannot reliably detect.
// tailKind is the raw-tail classification used by shouldHoldAttention().
function feedAttentionChunk(session, agent, rawChunk, cleanChunk, now = Date.now(), rowChunk = null, tailKind = null) {
  if (/\x1b\[2J|\x1b\[\?1049[hl]/.test(rawChunk)) {
    if (agent.id === 'codex' && session._codexPlan) {
      // A full repaint may be replaying old scrollback. Withhold reconnect
      // eligibility until its current prompt/footer has had time to arrive.
      session._codexPlan.ready = false;
      session._codexPlan.candidate = null;
      session._codexPlan.partial = false;
      // Resize redraws replay old submissions before the still-current plan.
      // Resolve the complete repaint before dismissing an announced approval:
      // removing its footer would itself resize the PTY and start another redraw.
      session._codexPlan.repainting = true;
      session._codexPlan.repaintDeadline = now + CODEX_PLAN_QUIET_MS;
      clearTimeout(session._planIdleTimer);
      session.agentPlanReady = false;
      session.codexPlanReady = false;
    }
    session._attentionLineCarry = '';
    session._attentionRowCarry = '';
    // (C1125) This flag was missing from the reset list despite terminal-session.js:41's own
    // comment and tt-terminal-attention-detection.md § OSC Strip both claiming it happens here.
    // If an OSC string's terminator is ever swallowed by a clear/alt-screen toggle before it
    // arrives, _attentionOscOpen stays latched true forever — stripOscChunk() then treats every
    // later chunk as "still inside an open OSC" and strips it to '', killing attention detection
    // for the rest of the session with no way to recover (the closing sequence is itself inside
    // the swallowed region).
    session._attentionOscOpen = false;
    // (TPT348) A full repaint redraws whatever is still on screen; the carve below re-latches if
    // the waiting row / agents panel is still part of the repainted frame.
    session._bgAgentsBusyAt = null;
    resetReflow(session);
    if (session._attentionState && !(agent.id === 'codex' && session._attentionState.kind === 'planReady')) {
      session._attentionState = null;
      session._patternAttentionNeeded = false;
      session.onAttentionCleared?.();
    }
    // (C1066) Fall through instead of returning — Claude's alt-screen full-repaint writes
    // `ESC[2J ESC[3J ESC[H` immediately followed by the whole redrawn frame in the SAME PTY
    // chunk (confirmed via a strings dump of the installed claude 2.1.224 binary). Returning
    // here used to discard that entire frame — including a dialog it painted — and since
    // nothing else is written while a dialog waits for input, the prompt was then never seen
    // at all. Carries were just reset above, so carving below starts clean from row 1.
  }

  const legacyLines = carveAttentionLines(session, cleanChunk);
  const rowLines = (rowChunk === null || rowChunk === undefined) ? [] : carveReflowLines(session, rowChunk);
  const lines = [...legacyLines, ...rowLines];
  // (TPT348) Stream-order scan of ONE line set (row-aware when available, same convention as
  // feedCodexPlan below) — scanning the legacy+row union would double-count and scramble order.
  if (agent.id === 'claude') trackBgAgents(session, rowChunk == null ? legacyLines : rowLines, now);
  let hit = agent.matchPromptLines(lines);
  if (agent.id === 'codex') {
    feedCodexPlan(session, agent, rowChunk == null ? legacyLines : rowLines,
      rowChunk == null ? session._attentionLineCarry : session._attentionRowCarry, hit);
    if (hit?.kind === 'planReady' && !session._codexPlan.ready) {
      // Reject only plan readiness; permission/question detection keeps its own
      // priority even when a historical sentinel is repainted after the dialog.
      hit = agent.matchPromptLines(lines.filter(line => agent.isPromptLine(line)?.kind !== 'planReady'));
      if (hit) invalidateCodexPlan(session);
    }
  }
  // Deterministic fallback (C1057, opt-in via claude-agent.js's --settings
  // preferredNotifChannel:terminal_bell): a raw BEL means the CLI itself signaled
  // "needs input", independent of prompt wording. (C1059) Gated on no active state — a stray
  // BEL arriving mid-dialog must never downgrade an already-classified mcpTrust/toolApproval
  // state to a blank generic one.
  // (TPT348) Not while Claude is waiting on background agents — its idle_prompt bell rings once
  // the turn has ended, but the session is working, not waiting on a human (see bgAgentsBusy()).
  if (!hit && !session._attentionState && /\x07/.test(rawChunk) && !bgAgentsBusy(session, now)) {
    hit = { kind: 'attention', promptText: '' };
  }

  if (hit) {
    const state = session._attentionState;
    // (C1059) Repaint-tolerant re-raise. One dialog commonly spans several PTY chunks (an Ink
    // frame repaint is 5-10KB of ANSI), and matchPromptLines()'s last-match-wins rule means
    // each chunk's winning line can differ (the question vs. an option row) even though it's
    // the same on-screen dialog — raising on every such split turned one prompt into an
    // endless broadcast (repeated notifications, a flickering card ring). Raise only on an
    // actual state change:
    const kindChanged = !state || state.kind !== hit.kind;
    const upgradedFromBlank = !kindChanged && !state.promptText && hit.promptText;
    // Same kind, different wording: could still be a mid-frame chunk split, not a new
    // question. Only treat it as new once the previous text has been gone long enough
    // (ATTENTION_REDRAW_GRACE_MS — dialogs commonly repaint across several chunks) AND is no
    // longer present anywhere in this chunk's lines.
    // (C1060) A short/generic hit.promptText is too noisy to trust as "a genuinely new
    // question" — require it clear ATTENTION_PROMPT_TEXT_MIN too, so wording churn on a short
    // generic match just refreshes state.at (below) instead of re-broadcasting a "new" prompt.
    const staleAndGone = !kindChanged && !upgradedFromBlank
      && state.promptText !== hit.promptText
      && now - state.at >= ATTENTION_REDRAW_GRACE_MS
      && hit.promptText.length >= ATTENTION_PROMPT_TEXT_MIN
      && !promptStillVisible(lines, state.promptText);
    if (kindChanged || upgradedFromBlank || staleAndGone) {
      session._attentionState = { kind: hit.kind, promptText: hit.promptText, agent: agent.id, at: now };
      session._patternAttentionNeeded = true;
      session.onAttentionNeeded?.({ kind: hit.kind, promptText: hit.promptText, agent: agent.id });
    } else {
      // Same dialog, just repainting (or a mid-frame chunk split) — refresh freshness only.
      // Keep the originally-raised promptText as the stable wire identity instead of
      // overwriting it with a possibly-partial line from this chunk.
      state.at = now;
    }
    return hit;
  }

  const state = session._attentionState;
  if (!state) return null;
  if (agent.id === 'codex' && state.kind === 'planReady'
      && (session._codexPlan?.candidate || session._codexPlan?.repainting)) return null;
  if (now - state.at < ATTENTION_REDRAW_GRACE_MS) return null;
  if (cleanChunk.replace(/\s+/g, '').length < ATTENTION_CLEAR_MIN_BYTES) return null;
  if (promptStillVisible(lines, state.promptText)) return null; // dialog still on screen, just repainting
  // (C1386) …and the tail still reports an unanswered inject-gate dialog (post-injection only) ->
  // hold. See shouldHoldAttention()'s own doc block, incl. why this is disjoint from C1120 above.
  if (shouldHoldAttention(state, tailKind, now - state.at, session._injectDone === true)) return null;
  session._attentionState = null;
  session._patternAttentionNeeded = false;
  session.onAttentionCleared?.();
  return null;
}

// ── MCP trust dialog auto-answer (C1047) ──
// Claude Code's "New MCP server found" dialog renders numbered options inside a rounded-box
// border, optionally with a `❯` cursor marker on the highlighted line, e.g.:
//   │   1. Use this MCP server                        │
//   │ ❯ 2. Use this and all future MCP servers …       │
//   │   3. Continue without using this MCP server      │
// stripAnsi() removes color/cursor escapes but the box-drawing chars are literal text, so the
// leading-char class below tolerates them (and plain leading whitespace for the 2-option
// variant, which has no box). Preference: "…and all future MCP servers" (broadest, matches
// what the user actually wants) over a bare "Use this MCP server" (single-session only).
// A veto list keeps "Continue without using this MCP server" from ever being selected even if
// matched incidentally. Returns null when no option line names an MCP server at all — this is
// what keeps the auto-answer away from Claude's unrelated folder-trust dialog (also classified
// kind:'mcpTrust' by ATTENTION_PROMPT_PATTERNS above, via the generic /\bdo you trust\b/i
// pattern), whose options ("1. Yes, proceed" / "2. No, exit") never mention "MCP server".
const MCP_TRUST_OPTION_LINE_RE = /^[\s│┃|╎┆╷╵]*[❯➤▶›>*]?\s*(\d+)[.)]\s+(.+?)\s*[│┃|]?\s*$/;
const MCP_TRUST_VETO_RE = /\bwithout\b|\bskip\b|\bexit\b|\bquit\b|\bno,|\bdon'?t\b|\bdo not\b/i;

function getMcpTrustAutoAnswer(tail) {
  if (typeof tail !== 'string' || !tail) return null;
  let broadMatch = null;
  let narrowMatch = null;
  for (const line of tail.split('\n')) {
    const m = MCP_TRUST_OPTION_LINE_RE.exec(line);
    if (!m) continue;
    const [, digit, label] = m;
    if (!/\bmcp\s+servers?\b/i.test(label) || MCP_TRUST_VETO_RE.test(label)) continue;
    if (/\ball\s+future\b/i.test(label)) broadMatch = digit;
    else if (/\buse\s+this\b/i.test(label)) narrowMatch = narrowMatch || digit;
  }
  return broadMatch || narrowMatch || null;
}

// A dismissed dialog can leave stale gate text in the raw tail after an in-place
// TUI redraw. Clear the injection gate when a gate kind remains in the tail but
// line-scoped attention goes active -> inactive, or when the tail rolls past it.
// Use tail kind for dialog identity: line matching may label an option row generic.
// Reset readiness after dismissal; never infer dismissal from silence alone.
const INJECT_GATE_KINDS = new Set(['mcpTrust', 'toolApproval', 'firstRun', 'askQuestion']);
function isInjectGateKind(kind) { return INJECT_GATE_KINDS.has(kind); }

function lineDialogLeftScreen(prevLineKind, curLineKind, tailKind) {
  return prevLineKind !== null && curLineKind === null && isInjectGateKind(tailKind);
}

function dialogGateCleared(prevKind, curKind) {
  return isInjectGateKind(prevKind) && prevKind !== curKind;
}

// After injection, fragment-only TUI repaints can clear line attention while an
// approval dialog still occupies the raw tail. Hold that attention briefly using
// tailKind; line kind may be generic. injectDone keeps this separate from the
// pre-injection dialog-dismissal transition above. The hold expires without a
// full-frame repaint, so stale tail text cannot latch attention forever.
function shouldHoldAttention(state, tailKind, heldMs, injectDone) {
  if (!state || !injectDone) return false;
  if (!isInjectGateKind(tailKind)) return false;
  return heldMs < ATTENTION_HOLD_MAX_MS;
}

function requiresExplicitPlanReadyPattern(session) {
  return session.taskAgent === 'codex' || session.taskAgent === 'pi';
}

function planReadyMinBufferLength(session) {
  // (C1116) Pi's 100-byte floor is dropped — with the anchored PI_PLAN_READY_PATTERNS sentinel
  // a low floor bought nothing but a wider false-positive window while Pi's TUI banner cleared
  // it on its own. Uniform 500 across dialog-approval agents now.
  return 500;
}

function trimTrailingAltScreenExit(buf) {
  const altOn = buf.lastIndexOf('\x1b[?1049h');
  const altOff = buf.lastIndexOf('\x1b[?1049l');
  if (altOn >= 0 && altOff > altOn) return buf.slice(altOn, altOff);
  return null;
}

// Slice anchored at the start of a complete escape sequence so the parser
// never resumes mid-CSI after rollover. Prefer alt-screen toggles or full
// clears when present in the truncated tail — those force a clean redraw.
function truncateBufferSafely(buf, max) {
  if (buf.length <= max) return buf;
  const tail = buf.slice(-max);
  const altScreenTail = trimTrailingAltScreenExit(tail);
  if (altScreenTail !== null) return altScreenTail;
  const altOn = tail.lastIndexOf('\x1b[?1049h');
  const altOff = tail.lastIndexOf('\x1b[?1049l');
  const altAnchor = altOn >= 0 ? altOn : altOff;
  if (altAnchor >= 0) return tail.slice(altAnchor);
  const clearScreen = tail.lastIndexOf('\x1b[2J');
  if (clearScreen >= 0) return tail.slice(clearScreen);
  const firstEsc = tail.indexOf('\x1b');
  if (firstEsc > 0) return tail.slice(firstEsc);
  return tail;
}

function sanitizeReplayBuffer(buf, opts = {}) {
  if (!opts.preserveAltScreenFrame) return buf;
  return trimTrailingAltScreenExit(buf) ?? buf;
}

function readTrackedFiles(taskId) {
  const trackFile = path.join(config.USER_DATA_ROOT, '.file-tracks', `${taskId}.txt`);
  try {
    const content = fs.readFileSync(trackFile, 'utf8');
    try { fs.unlinkSync(trackFile); } catch { /* ignore */ }
    return [...new Set(content.split('\n').map(l => l.trim()).filter(Boolean))];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[terminal] Error reading track file for ${taskId}:`, err.message);
    }
    return [];
  }
}

// (TPT354) One fetch feeds two consumers: the kickoff prompt's comments block AND the comment
// baseline (highest existing comment id) that ws-handlers.js's onSessionExit uses to tell "the
// agent posted its own resolution report during THIS run" from an earlier run's. `baselineId`
// is null when the fetch failed/was unavailable — an unknown baseline never suppresses the
// auto-posted exit comment (exit-resolution.js hasSelfAuthoredResolution).
// The block leaves out the previous run's auto-posted terminal-tail exit comment: it is raw TUI
// redraw text (spinner frames, title strings, dialog wording), not narrative, and it would be
// pasted straight back into a fresh TUI. A restart is the only start whose task has such a
// comment, so leaving it in would make a restart's kickoff differ from a first start's. The
// baseline still counts EVERY comment, the omitted one included.
async function fetchTaskCommentsContext(backend, taskId) {
  if (!taskId || !backend || typeof backend.getTaskComments !== 'function') return { block: '', baselineId: null };
  try {
    const comments = await backend.getTaskComments(taskId);
    const context = Array.isArray(comments)
      ? comments.filter((c) => !isTerminalTailExitComment(c && c.content))
      : comments;
    return { block: BaseTaskAgent.formatTaskCommentsBlock(context), baselineId: maxCommentId(comments) };
  } catch {
    return { block: '', baselineId: null };
  }
}

// Env vars that decide where an agent CLI writes its session transcript — snapshotted per spawn
// onto session._transcriptHint for the exit-comment reader (task-agent/final-message.js).
const TRANSCRIPT_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR'];
function pickTranscriptEnv(env) {
  const out = {};
  for (const k of TRANSCRIPT_ENV_KEYS) if (env && env[k]) out[k] = env[k];
  return out;
}

// (C1575) Parent-task context for a child's kickoff prompt. `task` is the fetched task row
// (ws-handlers.js's `_task`, threaded through opts.task) — needed for its numeric
// `parentDbId`, since the API has no GET-by-numeric-id route and task keys (not db ids) are
// the only addressable identifier. Same fail-open discipline as fetchTaskCommentsContext()
// above: a missing parent, a missing task, or ANY fetch failure must never block the spawn —
// returns null (not '', matching this task's "non-null when parentDbId is set, null when it
// is not" contract), and getSpawnSpec()'s opts key is simply absent/null on failure, which
// BaseTaskAgent.prependParentTask() already treats as a no-op.
async function fetchParentTaskBlock(backend, task) {
  if (!task || task.parentDbId == null) return null;
  if (!backend || typeof backend.getTasksUnfiltered !== 'function') return null;
  try {
    // No GET /tasks/:numericId route exists — the API is keyed entirely on task_key. Scan
    // the full (TTL-cached, single-flight) task list for the matching dbId, same idiom
    // ws-handlers.js's resolveObjectiveDescendants() and api-backend.js's getChildren() use.
    // Deliberately unfiltered — a parent owned by a different assignee must still resolve.
    const rows = await backend.getTasksUnfiltered();
    const parent = (rows || []).find(r => r && r.dbId === task.parentDbId);
    if (!parent) return null;
    let comments = [];
    if (typeof backend.getTaskComments === 'function') {
      try {
        comments = (await backend.getTaskComments(parent.id)) || [];
      } catch {
        // Parent found but its comments failed to fetch — still return the parent's own
        // title/description context rather than dropping the whole block.
      }
    }
    return BaseTaskAgent.formatParentTaskBlock(parent, comments) || null;
  } catch {
    return null;
  }
}

function emitTerminalState(session) {
  if (session.ws && session.ws.readyState === session.ws.OPEN) {
    session.ws.send(JSON.stringify({
      type: 'terminal-state',
      tabId: session.tabId,
      startedAt: session.startedAt,
      phase: session.terminalPhase,
      taskAgent: session.taskAgent,
      taskAgentLabel: session.taskAgentLabel,
      taskAgentModel: session.taskAgentModel || '', // (C1118) resolved model for the header caption
      planApprovalCommand: session.planApprovalCommand,
      // An incomplete repaint is unknown, not a rejection of the displayed plan.
      // Reconnect replay remains gated by codexPlanReadyIsFresh().
      ...(session._codexPlan?.repainting && session._planReadySent ? {} : {
        codexPlanReady: session.codexPlanReady === true && codexPlanReadyIsFresh(session),
      }),
      paused: pausedSummary(session),
    }));
  }
}

// (TPT443) What a client needs to render the watchdog-paused banner — never the signal
// target set or the notice text. null while the session is not paused.
function pausedSummary(session) {
  const p = session && session._pause;
  if (!p) return null;
  return { at: p.at, reason: p.reason, count: p.count, threshold: p.threshold, rssMb: p.rssMb || 0, limitMb: p.limitMb || 0 };
}

function emitTerminalNotice(session, text) {
  if (session.ws && session.ws.readyState === session.ws.OPEN) {
    session.ws.send(JSON.stringify({
      type: 'data',
      tabId: session.tabId,
      data: `\r\n\x1b[90m[Task App] ${text}\x1b[0m\r\n`,
    }));
  }
}

// Same channel as emitTerminalNotice, yellow instead of grey — for a condition the user
// should act on (TPT349: a token that could not be refreshed).
function emitTerminalWarning(session, text) {
  if (session.ws && session.ws.readyState === session.ws.OPEN) {
    session.ws.send(JSON.stringify({
      type: 'data',
      tabId: session.tabId,
      data: `\r\n\x1b[33m[Task App] ${text}\x1b[0m\r\n`,
    }));
  }
}

// ── API token expiry watch (TPT349) ──
// A session's remote MCP server authenticates with the API_TOKEN it was launched with (7-day
// JWT). Shortly before that token expires the Task App renews it — when it can — and tells the
// user how to get the running agent onto the new one. One unref'd timer per session; cleared on
// pty exit, and its callback re-checks liveness so a terminated session is never messaged.
const TOKEN_WATCH_LEAD_MS = 15 * 60 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;

// Pure scheduler, injectable for tests. Fires `onFire` once, `leadMs` before `expMs` (at once
// when already inside that window). Returns { delayMs, cancel }.
function scheduleTokenExpiryWatch({ expMs, leadMs = TOKEN_WATCH_LEAD_MS, now = Date.now(), onFire, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const delayMs = Math.min(Math.max(0, expMs - leadMs - now), MAX_TIMER_MS);
  const timer = setTimer(onFire, delayMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return { delayMs, cancel: () => clearTimer(timer) };
}

// What to tell the user when the spawn token is about to lapse. `saved`: a newer token is now
// in .tipatask/config.json. `headersHelper`: this agent re-reads that file on MCP reconnect.
function buildTokenExpiryNotice({ expMs, now = Date.now(), saved, headersHelper }) {
  const when = formatTokenExpiry(expMs, now);
  const head = `The API token this session started with ${now >= expMs ? 'expired' : 'expires'} at ${when}.`;
  if (saved && headersHelper) {
    return { warn: false, text: `${head} A fresh token is saved — in the agent type /mcp → tipatask → Reconnect (restart the session if MCP still answers 401).` };
  }
  if (saved) {
    return { warn: true, text: `${head} A fresh token is saved, but this agent only reads it at launch — task tools stop at ${when}, so restart the session to pick it up. Until then the agent can fall back to REST (see CLAUDE.md, MCP 401 fallback).` };
  }
  return { warn: true, text: `${head} It could not be refreshed automatically. Sign in again (Project ▸ Re-authenticate / Change Account), then in the agent type /mcp → tipatask → Reconnect.` };
}

async function onTokenExpiryNear(session, { spawnToken, expMs, headersHelper }) {
  if (!session.alive || session._terminated) return;
  const projectRoot = session.projectPath || config.PROJECT_ROOT;
  let saved = false;
  try {
    const creds = getApiCredentials(projectRoot);
    if (creds.token === spawnToken) {
      // Config still holds the token this session was launched with — renew it.
      await refreshProjectToken({ projectRoot, baseUrl: creds.baseUrl, token: creds.token, projectId: creds.projectId });
      saved = true;
    } else {
      // Re-auth or another window already replaced it; "saved" only if the replacement outlives ours.
      const newExp = tokenExpiryMs(creds.token);
      saved = newExp != null && newExp > expMs;
    }
  } catch (err) {
    console.log(`[terminal] token expiry watch: refresh failed: ${err.message}`);
  }
  if (!session.alive || session._terminated) return;
  const { warn, text } = buildTokenExpiryNotice({ expMs, saved, headersHelper });
  (warn ? emitTerminalWarning : emitTerminalNotice)(session, text);
}

function terminalStartCanceledError() {
  const err = new Error('Terminal start canceled');
  err.code = 'ETERMINATED';
  return err;
}

function throwIfTerminated(session) {
  if (session._terminated) throw terminalStartCanceledError();
}

// (C1565) Group-kill first — reaps any backgrounded subprocess tree the agent spawned
// inside the pty, not just the pty leader itself (see process-group.js header). Falls
// through to the pre-C1565 leader-only kill when the group-kill guard refuses (win32,
// already-dead pid, etc.) — same shape as claude-session.js's killObjectiveProc().
function killSpawnedPty(ptyProcess) {
  const pid = ptyProcess && ptyProcess.pid;
  if (!killProcessGroup(pid, 'SIGTERM')) {
    try { ptyProcess.kill('SIGTERM'); } catch { try { ptyProcess.kill(); } catch { /* already dead */ } }
  }
  const forceTimer = setTimeout(() => {
    if (!killProcessGroup(pid, 'SIGKILL')) {
      try { ptyProcess.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }, 1500);
  if (forceTimer.unref) forceTimer.unref();
}

// (TPT357) `{ reason, reasonText }` when the watchdog ended the session, `{}` otherwise — spread
// into both the WS `exit` frame and the onSessionExit() payload so the console modal and the
// resolution comment see the same reason.
function exitReasonFields(session) {
  const r = session && session._exitReason;
  return r ? { reason: r.kind, reasonText: r.text } : {};
}

// The WS `exit` frame a naturally-exited terminal session sends its client. Split out of the
// ptyProcess.onExit closure (which needs a real pty to drive) so the frame shape — notably the
// runaway `reason`/`reasonText` the console modal renders — is unit-testable.
function buildTerminalExitFrame(session, exitCode, filesRead) {
  return {
    type: 'exit',
    tabId: session.tabId,
    code: exitCode,
    tokens: null,
    filesRead: filesRead && filesRead.length > 0 ? filesRead : undefined,
    ...exitReasonFields(session),
  };
}

const RUNAWAY_FORCE_KILL_MS = 1500; // SIGTERM -> SIGKILL follow-up delay, same as killSpawnedPty()

// (TPT357) Descendant-watchdog escalation, called by index.js's 30s sweep when
// evaluateRunaway() reports `kill`. Ends a runaway session: records WHY on the session
// (`_exitReason`, read back by ptyProcess.onExit for the `exit` frame + resolution comment),
// writes the same reason into the replay buffer so reconnect replay and the resolution
// comment's terminal tail both carry it, then tears down the WHOLE tree — killProcessTree()
// also reaches setsid()/detached subtrees a plain group kill of the pty leader misses.
// SIGKILL follows after RUNAWAY_FORCE_KILL_MS on the exact same targets. Idempotent across
// sweeps: a tree that survives is signaled again next sweep, but the reason/notice are
// written once. `summary` (process-group.js's summarizeDescendants(), optional) names what
// was actually running, e.g. "npm \u00d724, node \u00d718, 3 other" \u2014 the 54-descendant false-kill
// this closes (TPT370) could not be diagnosed after the fact without it. `reason: 'memory'`
// (with `rssMb`/`limitMb`) words the text around the memory limit instead of the process
// count. A session the watchdog had paused is continued first \u2014 a stopped process does not
// act on SIGTERM until it runs again. Returns { text, first }, or null when there is nothing
// live to kill.
function killRunawaySession(session, { count, threshold, rssMb = 0, limitMb = 0, reason, snapshot, summary, policy = {} } = {}) {
  if (!session || !session.alive || !session.ptyPid) return null;
  const first = !session._exitReason;
  const byMemory = reason?.startsWith('memory');
  const text = `Watchdog killed this session: ${describeRunawayReason(reason)}; ${describeTree(count, rssMb)} `
    + `(kill ${describeActPolicy(threshold, { limitMb, ...policy })}).`
    + (summary ? ` Top processes: ${summary}.` : '');
  if (first) {
    session._exitReason = { kind: 'runaway-killed', count, threshold, text, ...(byMemory ? { rssMb, limitMb } : {}) };
    session.buffer += `\r\n\x1b[90m[Task App] ${text}\x1b[0m\r\n`;
    emitTerminalNotice(session, text);
  }
  if (session._pause) {
    signalTargets(session._pause.targets, 'SIGCONT');
    session._pause = null;
  }
  const ptyProcess = session.pty;
  const targets = killProcessTree(snapshot, session.ptyPid, 'SIGTERM');
  if (!targets.signaled && ptyProcess) {
    try { ptyProcess.kill('SIGTERM'); } catch { try { ptyProcess.kill(); } catch { /* already dead */ } }
  }
  const forceTimer = setTimeout(() => {
    if (!signalTargets(targets, 'SIGKILL').signaled && ptyProcess) {
      try { ptyProcess.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }, RUNAWAY_FORCE_KILL_MS);
  if (forceTimer.unref) forceTimer.unref();
  return { text, first };
}

// ── Watchdog pause / resume ──
//
// The watchdog's default action on a session over its limits (process-group.js's
// evaluateRunaway() reporting `pause`): SIGSTOP the WHOLE tree — the pty leader's group, every
// descendant-led group, and lone descendants in foreign groups (resolveTreeTargets()) — so it
// stops consuming CPU and stops growing, while every process keeps its state. Nothing is
// killed and nothing is recorded as an exit reason: resumeRunawaySession() continues exactly
// the processes that were stopped, at any later time. The stopped set is kept on the session
// (`_pause.targets`) for that, since a ps snapshot taken at resume time could no longer find
// members whose parent was reparented.
//
// A paused tree keeps its memory. Ending the session (killPausedTargets() below) is what
// frees it.

function unionTargets(a, b) {
  return {
    pgids: [...new Set([...(a && a.pgids || []), ...(b && b.pgids || [])])],
    pids: [...new Set([...(a && a.pids || []), ...(b && b.pids || [])])],
  };
}

// Called by the 30s sweep on every sweep that reports `pause`. The first call writes the
// reason into the replay buffer (so reconnect replay carries it) and emits it live; later
// calls only re-signal — catching a member that forked between the snapshot and the first
// SIGSTOP — and fold any new targets into the stored set. Returns { text, first }, or null
// when there is no live session or nothing could be signaled (the caller then falls back to
// a warning rather than reporting a pause that did not happen).
function pauseRunawaySession(session, { count, threshold, rssMb = 0, limitMb = 0, reason, snapshot, summary, policy = {} } = {}) {
  if (!session || !session.alive || !session.ptyPid) return null;
  const signaled = signalTargets(resolveTreeTargets(snapshot, session.ptyPid), 'SIGSTOP');
  const first = !session._pause;
  if (!signaled.signaled) return first ? null : { text: session._pause.text, first: false };
  if (!first) {
    session._pause.targets = unionTargets(session._pause.targets, signaled);
    session._pause.count = count;
    session._pause.rssMb = rssMb;
    emitTerminalState(session); // (TPT443) keep the paused banner's figures current
    return { text: session._pause.text, first: false };
  }
  const why = `${describeRunawayReason(reason)}; ${describeTree(count, rssMb)} `
    + `(warn ≥${threshold}; pause ${describeActPolicy(threshold, { limitMb, ...policy })})`;
  const text = `Watchdog paused this session: ${why}. Nothing was killed — every process is stopped `
    + `and keeps its state. Resume the session to continue, or terminate it to free its memory.`
    + (summary ? ` Top processes: ${summary}.` : '');
  session._pause = {
    at: Date.now(),
    reason: reason || 'count',
    count,
    threshold,
    rssMb,
    limitMb,
    text,
    targets: { pgids: signaled.pgids, pids: signaled.pids },
  };
  session.buffer += `\r\n\x1b[33m[Task App] ${text}\x1b[0m\r\n`;
  emitTerminalWarning(session, text);
  emitTerminalState(session); // (TPT443) an already-open terminal shows the paused banner
  return { text, first: true };
}

// Continues a session pauseRunawaySession() stopped. SIGCONT goes to the exact stored target
// set (falling back to the pty leader's group), the watchdog's pause latch is cleared, and
// `resumeBase` is stamped so evaluateRunaway() acts again only on further growth instead of
// re-pausing the still-large tree at the next sweep. Returns { text, resumed }, or null when
// the session is not paused.
function resumeRunawaySession(session) {
  const pause = session && session._pause;
  if (!pause) return null;
  session._pause = null;
  let resumed = signalTargets(pause.targets, 'SIGCONT').signaled;
  if (!resumed) resumed = killProcessGroup(session.ptyPid, 'SIGCONT');
  const state = session.descendantWatchdog;
  if (state) {
    state.paused = false;
    state.actReason = null;
    state.pauseFailed = false;
    state.growthStreak = 0;
    state.rssStreak = 0;
    state.rssGrowthStreak = 0;
    state.pressureGrowthStreak = 0;
    state.pressureStreak = 0;
    state.rssSince = null;
    state.lastSampleAt = null;
    state.lastRssMb = null;
    state.resumeBase = { count: pause.count || 0, rssMb: pause.rssMb || 0 };
  }
  const text = 'Session resumed. The watchdog pauses it again only if it keeps growing.';
  session.buffer += `\r\n\x1b[90m[Task App] ${text}\x1b[0m\r\n`;
  emitTerminalNotice(session, text);
  emitTerminalState(session); // (TPT443) clears the paused banner on the attached client
  return { text, resumed };
}

// Resumes every watchdog-paused session in the `sessions` Map; returns their tab ids.
function resumeAllRunawaySessions(sessions) {
  const resumed = [];
  if (!sessions) return resumed;
  for (const [, session] of sessions) {
    if (!session || !session._pause) continue;
    if (resumeRunawaySession(session)) resumed.push(session.tabId);
  }
  return resumed;
}

// Teardown of a paused session (user Terminate/Restart). The ordinary pty group kill is not
// enough here: a stopped process does not act on SIGTERM until continued, and a member
// outside the pty leader's group would otherwise stay stopped — and keep its memory — after
// the session is gone. Continues, then SIGTERMs the stored set, with the same SIGKILL
// follow-up as every other kill path. Returns false when the session was not paused.
function killPausedTargets(session) {
  const pause = session && session._pause;
  if (!pause) return false;
  session._pause = null;
  signalTargets(pause.targets, 'SIGCONT');
  signalTargets(pause.targets, 'SIGTERM');
  const forceTimer = setTimeout(() => { signalTargets(pause.targets, 'SIGKILL'); }, RUNAWAY_FORCE_KILL_MS);
  if (forceTimer.unref) forceTimer.unref();
  return true;
}

// ── Resume force-repaint (C966) ──
// A same-size pty.resize() is a no-op to the kernel — both macOS and Linux
// suppress SIGWINCH when the winsize doesn't change, so it never reaches the
// TUI. Wobble the row count down and back (with a gap so the two SIGWINCHes
// don't coalesce) to force Claude/Pi to re-emit a fresh full-screen frame on
// reattach, instead of relying on the user nudging the cursor to trigger it.
// Codex is skipped: it already self-redraws via a client-sent \x0c and has a
// delicate plan-ready alt-screen replay this could disturb.
function forceResumeRepaint(session) {
  if (!session || !session.alive || !session.pty) return;
  if (session.taskAgent === 'codex') return;
  const cols = session.cols || 120;
  const rows = session.rows || 40;
  try {
    session.pty.resize(cols, Math.max(1, rows - 1));
  } catch { return; }
  const timer = setTimeout(() => {
    if (session.alive && session.pty) {
      try { session.pty.resize(cols, rows); } catch { /* ignore */ }
    }
  }, RESUME_REPAINT_WOBBLE_MS);
  if (timer.unref) timer.unref();
  console.log(`[terminal:${session.taskAgent}] Resume repaint nudge (resize wobble) for task ${session.tabId} (${cols}x${rows})`);
}

// ── Post-approval stall watchdog (C1117) ──
// agent.approvePlan() below only proves the PTY write/keypress happened — not that the agent
// did anything useful with it. A degenerate model reply (e.g. Kimi K3 leaking a bare
// `<|sep|>` chat-template token instead of a real turn) looks identical to a healthy approval
// from the PTY's point of view: the write succeeded, Enter was sent, nothing more to check
// without actually watching what comes back. getApprovalWatchdogMs()/approvalStalled()/
// retryApproval() are opt-in hooks on BaseTaskAgent (default: watchdog disabled — see
// base-agent.js) — only pi-agent.js currently overrides them, so this is a complete no-op for
// Claude/Codex (ms === 0, function returns immediately). Fires once after approval; on a
// stalled verdict, notifies + retries once via agent.retryApproval(), then arms a second,
// final check that only notifies (no further retries) so a persistently degenerate model can't
// loop forever.
function armApprovalWatchdog(session, agent, isRetry = false) {
  const ms = agent.getApprovalWatchdogMs();
  if (!ms) return;
  const bufferLenAtArm = session.buffer.length;
  const armedAt = Date.now();
  const timer = setTimeout(() => {
    session._approvalWatchdogTimer = null;
    if (!session.alive || !session.pty) return;
    const ctx = {
      growthBytes: session.buffer.length - bufferLenAtArm,
      tail: session._attentionTail || '',
      idleMs: Date.now() - (session.lastOutputAt || armedAt),
    };
    if (!agent.approvalStalled(session, ctx)) return;
    if (isRetry) {
      emitTerminalNotice(session, `${agent.label} approval still looks stalled after a retry (no real activity — the model may keep returning an empty or malformed reply). Check the model configured for this project.`);
      return;
    }
    emitTerminalNotice(session, `${agent.label} approval looks stalled (no real activity yet) — retrying once.`);
    agent.retryApproval(session);
    armApprovalWatchdog(session, agent, true);
  }, ms);
  if (timer.unref) timer.unref();
  session._approvalWatchdogTimer = timer;
}

function approvePlan(session) {
  if (session.taskAgent === 'codex') invalidateCodexPlan(session);
  if (session._planIdleTimer) { clearTimeout(session._planIdleTimer); session._planIdleTimer = null; }
  if (session._approvalWatchdogTimer) { clearTimeout(session._approvalWatchdogTimer); session._approvalWatchdogTimer = null; }
  session.codexPlanReady = false;
  session.agentPlanReady = false;
  if (session.terminalPhase === 'executing') {
    emitTerminalState(session);
    emitTerminalNotice(session, 'Plan is already approved.');
    return;
  }
  const agent = getTaskAgent(session.taskAgent);
  session.terminalPhase = 'executing';
  emitTerminalState(session);
  emitTerminalNotice(session, 'Plan approved. Continuing in execution mode.');
  agent.approvePlan(session, config);
  armApprovalWatchdog(session, agent);
}

// (C1444) Thin wrapper — flags the session as "starting" for the full duration of
// _spawnTerminal()'s awaited remote round-trips (KB pull, task comments, status/VCS
// settings) before pty.spawn() flips `alive`. GET /api/sessions (ws-handlers.js
// sessionListBucket()) reads this flag so the session isn't misreported as exited
// during that window. `finally` covers every throw path so a failed/canceled spawn
// never leaves the flag stuck true.
async function spawnTerminal(session, prompt, taskId, taskTags = [], opts = {}) {
  session._starting = true;
  try {
    return await _spawnTerminal(session, prompt, taskId, taskTags, opts);
  } finally {
    session._starting = false;
  }
}

async function _spawnTerminal(session, prompt, taskId, taskTags = [], opts = {}) {
  // C1408 — the start-time assignee guard/auto-claim used to live inline here. Moved to
  // ws-handlers.js's assertTaskStartable()/claimUnassignedTaskOnStart(), called by both
  // spawn call sites before spawnTerminal() — they already have the task row fetched, so
  // the guard no longer pays a second, uncached GET /tasks/:key per start.
  const agent = getTaskAgent(session.taskAgent || config.TASK_AGENT);
  let status = await agent.cachedDetect(config);
  if (!status.available) {
    // Never fail a task start on a cached negative — one fresh probe (~500ms)
    // beats a false "not logged in" from a startup-poisoned cache.
    const { clearBinCache } = require('./spawn-utils');
    clearBinCache();
    status = await agent.cachedDetect(config, true);
  }
  if (!status.available) {
    throw new Error(status.reason || `${agent.label} is unavailable`);
  }
  // (C1383) Fail closed before spawning anything: a task started with a known-dead
  // (expired/malformed) token, or a backend already latched 'unauthorized' from a prior
  // 401/403, must never launch a real Claude/Codex/Pi process — it would only fail deep
  // inside its own session with no useful signal. Local-only check (JWT `exp` decode +
  // connection-state read), no network round trip, so an offline task start still works.
  // Must run before every network fan-out below (KB sync, comments, status/VCS/tags) and
  // long before pty.spawn(). Thrown error carries code:'EAUTH' — caught by the same
  // err.code discriminator in ws-handlers.js that already handles ETERMINATED/EASSIGNEE/ECLAIM.
  //
  // (TPT349) The same gate now also renews a token with under 24h left before the spawn (so
  // projectEnvExtras() below injects the fresh one) and refuses one that could not be renewed
  // and dies within 30 minutes. `authCheck` carries the outcome to the notices after pty.spawn.
  let authCheck = null;
  if (opts.backend) {
    const authRoot = session.projectPath || config.PROJECT_ROOT;
    authCheck = await assertCredentialsUsable(opts.backend, {
      refresh: (creds) => refreshProjectToken({ ...creds, projectRoot: authRoot }),
    });
  }
  let finalPrompt = prompt;
  if (taskId) {
    const planPath = path.join(config.PLANS_DIR, `${taskId}.md`);
    if (fs.existsSync(planPath)) {
      const planContent = fs.readFileSync(planPath, 'utf8');
      finalPrompt = `[Stored plan for task ${taskId}:]\n${planContent}\n\n---\n\n${prompt}`;
    }
  }

  // Per-task fresh KB pull before spawning the agent. Bypasses fireSessionSync's
  // single-flight latch so the agent always starts against the newest remote KB
  // (C929). Fail-open: a slow/unreachable API must never block task execution.
  // C1218: also captures {rootPath, backend} for the auto-reindex trigger fired below —
  // AFTER pty.spawn, never here, so a stale-descriptions Opus run can never delay a task
  // start.
  let _kbAutoReindexArgs = null;
  // C1490 — Sync-as-you-go off skips this pre-spawn pull (and, since _kbAutoReindexArgs
  // stays null, the deferred spawn-time auto-reindex below too). Boot sync, WS-connect
  // sync, project-close push, and manual Project > Knowledge Base > Sync stay
  // unconditional — only the per-task path and the Edit/Write hook honor this flag.
  if (opts.backend && typeof opts.backend.getCredentials === 'function' && await isSyncAsYouGoEnabled(opts.backend)) {
    try {
      const { baseUrl, projectId, token } = opts.backend.getCredentials();
      const _root = session.projectPath || config.PROJECT_ROOT;
      const syncRes = await syncOnSessionStart(baseUrl, projectId, token, _root);
      archCache.invalidateArchForKeys(syncRes.pulledKeys, _root);
      // C1220 — let this agent know its KB edits may be overwriting content someone else
      // never got to save, and vice versa.
      if (syncRes.conflicts && syncRes.conflicts.length > 0) {
        process.stderr.write(`[kb-conflict:spawn] ${syncRes.conflicts.length} remote KB edit(s) overwritten — recover with MCP list_knowledge_conflicts\n`);
      }
      _kbAutoReindexArgs = { rootPath: _root, projectPath: session.projectPath || '', backend: opts.backend, label: 'spawn' };
    } catch (err) {
      process.stderr.write(`[kb-sync:spawn] ${err.message}\n`);
    }
  }

  const cachedTags = taskId ? Array.from(getTagsForTask(taskId)) : [];
  const { block: taskCommentsBlock, baselineId: commentBaselineId } = await fetchTaskCommentsContext(opts.backend, taskId);
  // (TPT354) Claude only: a per-spawn uuid passed as `--session-id` (claude-agent.js), so the
  // exit-comment builder reads THIS run's transcript by name. Codex/Pi can't be pinned — their
  // transcripts are located by spawn time + kickoff line (task-agent/final-message.js).
  const agentSessionId = agent.id === 'claude' ? crypto.randomUUID() : null;
  // C1184 — resolve this project's workflow-role status names once per spawn, so agent
  // prompts reference the real in-progress/complete status names instead of hardcoded
  // literals. Fail-open (never throws — see status-roles.js), same discipline as the
  // KB sync above: a statuses fetch failure must never block a task start.
  const statusRoles = await BaseTaskAgent.fetchStatusRoles(opts.backend);
  const statusNames = await BaseTaskAgent.fetchStatusNames(opts.backend);
  // Strict live VCS permissions: failure permits read-only planning, never VCS writes
  // or verified completion. Capture runtime identity alongside the effective flags.
  // C1513 — resolve this task's tag descriptions alongside it (independent fetch, run
  // together instead of adding a 4th serial await): fail-open, degrades to no backfill
  // directive at all. See tag-descriptions.js.
  // C1575 — resolve this task's parent context alongside the other two: fail-open, degrades
  // to no parent block at all. opts.task is the already-fetched task row (ws-handlers.js) —
  // no second GET /tasks/:key round trip.
  const [vcsContext, tagDescriptions, parentTaskBlock] = await Promise.all([
    refreshSessionVcs(session, opts.backend),
    BaseTaskAgent.fetchTagDescriptions(opts.backend, taskTags),
    fetchParentTaskBlock(opts.backend, opts.task),
  ]);
  throwIfTerminated(session);
  // TPT286 — opts.task (the same fetched row) also rides into getSpawnSpec() so each agent
  // can read task.effort through BaseTaskAgent#resolveEffort().
  const vcsSettings = vcsContext.vcs;
  console.log(`[vcs] ${taskId}: ${JSON.stringify(vcsContext)}`);
  // The prompt gets a concurrency-scaled fan-out allowance; watchdog enforcement
  // remains independent. See base-agent.js#buildResourceLimitsDirective.
  const activeCount = countActiveAgentSessions(opts.sessions || []) + 1;
  const agentLimits = scaleAgentLimitsForConcurrency(
    resolveAgentLimits(session.projectPath || config.PROJECT_ROOT), activeCount,
  );
  const spec = await agent.getSpawnSpec(config, finalPrompt, taskId, { taskTags, cachedTags, taskCommentsBlock, statusRoles, statusNames, vcsSettings, vcsContext, tagDescriptions, parentTaskBlock, agentLimits, projectPath: session.projectPath, model: opts.model, discovery: opts.discovery, designMode: opts.designMode, task: opts.task || null, agentSessionId });
  throwIfTerminated(session);
  const spawnedAt = Date.now(); // (TPT354) lower bound for locating this run's transcript file
  const ptyProcess = pty.spawn(spec.command, spec.args, {
    name: 'xterm-256color',
    cols: opts.initialCols || 120,
    rows: opts.initialRows || 40,
    cwd: spec.cwd,
    env: spec.env,
  });
  if (session._terminated) {
    killSpawnedPty(ptyProcess);
    throw terminalStartCanceledError();
  }

  // C1218 — auto-reindex, fired strictly AFTER the PTY is alive (never before pty.spawn,
  // never awaited) so a stale-descriptions Opus run can never add latency to task launch.
  // `void`-marked: the drop is intentional, fireAutoReindexWithBroadcast never throws.
  if (_kbAutoReindexArgs) {
    void require('./kb-auto-reindex').fireAutoReindexWithBroadcast(_kbAutoReindexArgs);
  }

  session.taskAgent = agent.id;
  session.taskAgentLabel = agent.label;
  session.taskAgentModel = spec.model || ''; // (C1118) resolved --model value, for the terminal header caption
  session.planApprovalCommand = agent.approvalCommand;
  session.pty = ptyProcess;
  session.ptyPid = ptyProcess.pid; // (C1565) survives session.pty being nulled on terminate
  beginSessionMemory(session);
  session.descendantWatchdog = {   // (C1565) consumed by index.js's 30s watchdog sweep
    pid: ptyProcess.pid,
    lastCount: 0,
    lastAlertCount: 0,
    threshold: agentLimits.warnDescendants || DESCENDANT_ALERT_THRESHOLD, // refreshed each sweep
    alerted: false,
    growthStreak: 0,                // (TPT370) consecutive sweeps that both cleared threshold
                                     // AND grew by >=10 over the sweep before — count trigger
    rssStreak: 0,                   // consecutive sweeps at/above the memory limit
    rssAlerted: false,
    lastAlertRssMb: 0,
    paused: false,                  // latches on a pause decision; resumeRunawaySession() clears it
    killed: false,                  // (TPT370) latches true once a kill decision fires
    actReason: null,                // specific growth/ceiling/pressure cause of the latched action
    resumeBase: null,               // { count, rssMb } at resume — re-act only on growth past it
  };
  session._exitReason = null;      // (TPT357) set by killRunawaySession(), read by onExit
  session._pause = null;           // set by pauseRunawaySession() while the tree is SIGSTOPped
  session.cols = opts.initialCols || 120;
  session.rows = opts.initialRows || 40;
  session.alive = true;
  session.pending = false;
  session.terminalPhase = 'planning';
  session.lastOutputAt = Date.now();
  session._terminalOutputSeen = false;
  session._attentionBroadcasted = false;
  session._patternAttentionNeeded = false;
  session._attentionTail = '';
  session._attentionLineCarry = '';
  session._attentionOscOpen = false;
  session._attentionState = null;
  session._attentionRowCarry = '';  // (C1066) screen-reflow.js's carveReflowLines() carry
  resetReflow(session);             // (C1066) session._attentionRow / _attentionCol = 1
  session._lastAttentionKind = null;    // (C1120) line-scoped kind seen on the PREVIOUS chunk
  session._lastTailDialogKind = null;   // (C1120) tail-scoped gate kind seen on the PREVIOUS chunk
  session._localCommandBuffer = '';
  session._interceptingApprovalCommand = false;
  session._planFirstArmedAt = null;
  session._planReadySent = false;
  session._codexPlan = null;
  session._resolutionPosted = false;
  // (TPT354) Per-run state for ws-handlers.js's onSessionExit (exit-resolution.js): where this
  // run's agent transcript lives, and the comment id watermark before the agent started.
  session._commentBaselineId = commentBaselineId;
  session._transcriptHint = {
    cwd: spec.cwd,
    spawnedAt,
    taskId,
    agentSessionId,
    env: pickTranscriptEnv(spec.env),
  };
  session._injectTimer = null;
  session._submitCheckTimer = null;       // (TPT364) checkSubmitted()'s timer handle
  session._approvalWatchdogTimer = null;  // (C1117) armApprovalWatchdog()'s timer handle
  session._piApprovalRetried = false;     // (C1117) PiAgent#retryApproval()'s single-shot guard
  session.codexPlanReady = false;
  session.agentPlanReady = false;
  console.log(`[terminal:${agent.id}] New session for task ${taskId} (pid ${ptyProcess.pid})`);

  // (TPT349) Surface the token preflight outcome, then arm the mid-session expiry watch on the
  // token the child was actually launched with (spec.env.API_TOKEN — projectEnvExtras() read).
  if (authCheck && authCheck.refreshed) {
    emitTerminalNotice(session, `API token refreshed — valid until ${formatTokenExpiry(authCheck.expiresAt)}.`);
  } else if (authCheck && authCheck.warning) {
    emitTerminalWarning(session, authCheck.warning);
  }
  const spawnToken = spec.env && spec.env.API_TOKEN;
  const spawnExpMs = spawnToken ? tokenExpiryMs(spawnToken) : null;
  session.spawnTokenExpMs = spawnExpMs;
  if (session._tokenExpiryWatch) session._tokenExpiryWatch.cancel();
  session._tokenExpiryWatch = spawnExpMs == null ? null : scheduleTokenExpiryWatch({
    expMs: spawnExpMs,
    onFire: () => {
      session._tokenExpiryWatch = null;
      onTokenExpiryNear(session, { spawnToken, expMs: spawnExpMs, headersHelper: spec.mcpHeadersHelper === true })
        .catch((err) => console.log(`[terminal] token expiry watch error: ${err.message}`));
    },
  });

  // ── Idle-silence paste injection (C947) ──
  // Paste + Enter key off PTY quiescence, not a cumulative byte count + fixed Enter gap.
  // Phases: awaitReady (wait for boot to settle) -> awaitPasteAck (verify paste echo
  // settled, then (TPT445) type spec.kickoffTypedLine + one more silence, then Enter) -> done. (C1260) When spec.preludePrompt is set (Claude's
  // /design mode), a slash-command prelude must land as its OWN submission or it never
  // executes as a command — two extra phases splice in before the task prompt:
  // awaitReady -> awaitPreludeAck (verify prelude paste echo, Enter) -> awaitPreludeRun
  // (poll until /design goes quiet) -> awaitPasteAck (task prompt, unchanged) -> done.
  const initialPrompt = spec.initialPrompt;
  const preludePrompt = spec.preludePrompt || '';
  const kickoffTypedLine = spec.kickoffTypedLine || '';  // (TPT445) typed after the paste, before Enter
  let typedLineSent = false;
  let injectDone = !initialPrompt;
  session._injectDone = injectDone;  // (C1386) mirrored for shouldHoldAttention()/index.js's sweep — see onData()
  let injectPhase = injectDone ? 'done' : 'awaitReady';
  let injectFirstOutputAt = 0;
  let injectPhaseStartAt = 0;
  let injectRetries = 0;
  let mcpTrustNoticeShown = false;
  let mcpTrustAnswered = false;  // guards firing the auto-answer keystroke more than once per session (C1047)
  let firstRunNoticeShown = false;  // (C1219) guards the first, softer onboarding-wait notice
  let askQuestionNoticeShown = false;  // (C1272) guards the first "a question is waiting" notice
  let preludeSubmittedAt = 0;  // (C1260) dedicated clock for awaitPreludeRun's min/quiet/max wait — kept SEPARATE from injectPhaseStartAt, which the onData force-check below mutates for other reasons
  let preludeLongNoticeShown = false;  // (C1260) guards the ~5min "still running" notice

  const clearInjectTimer = () => {
    if (session._injectTimer) { clearTimeout(session._injectTimer); session._injectTimer = null; }
  };
  const armInjectTimer = (delayMs) => {
    clearInjectTimer();
    session._injectTimer = setTimeout(onInjectSilence, delayMs);
  };
  // (TPT364) See SUBMIT_VERIFY_MS. Everything here is guarded on the session still being live, so a
  // timer that outlives a Stop/Restart is a no-op (terminateTerminalSession() nulls pty/alive).
  let submitRetries = 0;
  let submitWatchUntil = 0;
  const armSubmitCheck = (delayMs) => {
    clearTimeout(session._submitCheckTimer);
    session._submitCheckTimer = setTimeout(checkSubmitted, delayMs);
    if (session._submitCheckTimer.unref) session._submitCheckTimer.unref();
  };
  function checkSubmitted() {
    session._submitCheckTimer = null;
    if (!session.alive || session._terminated || !session.pty) return;
    const tail = session._attentionTail || '';
    if (!unsentPasteVisible(agent.getUnsentPasteRe(), tail)) return;  // marker gone (or buried): the prompt went in
    const now = Date.now();
    if (now >= submitWatchUntil) return;
    if (now - (session.lastOutputAt || 0) < SUBMIT_QUIET_MS) {
      armSubmitCheck(SUBMIT_POLL_MS);                       // still animating: a turn is (about to be) running
      return;
    }
    const dlg = getAttentionPromptMatch(tail, session.taskAgent, session);
    if (dlg && isInjectGateKind(dlg.kind)) {
      armSubmitCheck(SUBMIT_POLL_MS);                       // a dialog owns the input — never Enter into it
      return;
    }
    if (submitRetries >= MAX_SUBMIT_RETRIES) {
      emitTerminalNotice(session, 'The task prompt is typed but was not submitted — press Enter to start it.');
      return;
    }
    submitRetries++;
    // Server-log the state too: why the first Enter was lost is not known, and this line is the
    // evidence a future diagnosis needs (how long the PTY was silent, what the tail looked like).
    console.log(`[terminal:${agent.id}] Submit verification: kickoff for task ${taskId} still unsent after the Enter `
      + `(PTY silent ${now - (session.lastOutputAt || 0)}ms) — re-sending Enter ${submitRetries}/${MAX_SUBMIT_RETRIES}; `
      + `tail=${JSON.stringify(tail.slice(-160))}`);
    emitTerminalNotice(session, 'The task prompt was typed but not submitted — pressing Enter again.');
    session.pty.write('\r');
    submitWatchUntil = Date.now() + SUBMIT_WATCH_MS;
    armSubmitCheck(SUBMIT_VERIFY_MS);
  }
  function onInjectSilence() {
    session._injectTimer = null;
    if (injectDone || !session.alive || !session.pty) return;
    const dlg = getAttentionPromptMatch(session._attentionTail, session.taskAgent, session);
    // C1047: auto-answer the MCP trust dialog instead of only deferring (C997's approach,
    // which left the user manually clicking Allow with no task prompt ever landing after).
    // Parse the "Use this [and all future] MCP server(s)" option digit and select it
    // ourselves, so a brand-new project's first task never stalls on a dialog nobody is
    // watching.
    if (dlg && dlg.kind === 'mcpTrust' && !mcpTrustAnswered) {
      const digit = getMcpTrustAutoAnswer(session._attentionTail);
      if (digit) {
        mcpTrustAnswered = true;
        const preAnswerTail = session._attentionTail;
        session.pty.write(digit);
        emitTerminalNotice(session, 'Auto-approved project MCP servers.');
        // Claude's Ink TUI doesn't emit a clear-screen or alt-screen toggle when the dialog
        // dismisses, so the stale "New MCP server…" text would otherwise sit in the rolling
        // tail and keep matching kind 'mcpTrust' on every subsequent onData chunk — reblocking
        // injection forever. Clear it now, and restart the awaitReady boot floor against
        // post-dialog output instead of the original (long-elapsed) first-output timestamp.
        session._attentionTail = '';
        injectRetries = 0;
        injectFirstOutputAt = Date.now();
        injectPhaseStartAt = Date.now();
        // Claude Code's numbered Select confirms on the digit alone; Enter is only insurance
        // for a rendering that still needs it. Send it after a real gap (not the same
        // pty.write chunk — Ink's stdin parser reads "2\r" as one unrecognized keypress and
        // drops it, matching neither the digit option nor key.return) and only if nothing
        // else has rendered meanwhile — an unconditional Enter risks confirming a *different*
        // dialog that appeared in the gap (e.g. a second server's trust prompt).
        const enterTimer = setTimeout(() => {
          if (!session.alive || !session.pty) return;
          if (session._attentionTail === '' || session._attentionTail === preAnswerTail) {
            session.pty.write('\r');
          }
        }, MCP_TRUST_ANSWER_ENTER_DELAY_MS);
        if (enterTimer.unref) enterTimer.unref();
        armInjectTimer(agent.getPasteSilenceMs());
        return;
      }
    }
    // (C1219) Claude's first-run onboarding chain / workspace-trust screen — no auto-answer
    // exists (unlike mcpTrust) and there's no safe guess at what option to pick, so this always
    // defers. Unlike the mcpTrust/toolApproval branch below, it also requires POSITIVE proof of
    // a ready REPL (isClaudeReplReady()) before releasing, not just the dialog's own kind
    // disappearing from the tail — an option-less intermediate wait between two onboarding steps
    // (e.g. an "opening browser for login…" pause) also reports no gate kind, and injecting into
    // that silently-empty wait would just move the bug rather than fix it. Deliberately placed
    // before the shared mcpTrust/toolApproval defer block so 'firstRun' never falls through that
    // branch's cap-then-paste fallback — see the constant's own doc comment for why 'firstRun'
    // must never fall through to a blind paste at all.
    if (dlg && dlg.kind === 'firstRun' && !isClaudeReplReady(session._attentionTail)) {
      if (!firstRunNoticeShown) {
        firstRunNoticeShown = true;
        emitTerminalNotice(session, 'Claude Code first-run setup is waiting for your input. Answer the prompts above — the task prompt will be sent automatically once setup finishes.');
      }
      if (injectRetries === FIRST_RUN_LONG_WAIT_RETRIES) {
        emitTerminalNotice(session, 'Still waiting on Claude Code first-run setup.');
      }
      injectRetries++;
      // Same C1047 ceiling-burn fix as the mcpTrust branch below — refresh on every deferral so
      // the INJECT_MAX_WAIT_MS check in the onData handler can't force retries faster than
      // INJECT_DIALOG_RETRY_MS pacing and burn through the budget in a handful of chunks.
      injectPhaseStartAt = Date.now();
      if (injectRetries < MAX_FIRST_RUN_RETRIES) {
        armInjectTimer(INJECT_DIALOG_RETRY_MS);
        return;
      }
      emitTerminalNotice(session, 'Claude Code first-run setup did not finish — the task prompt was NOT sent. Finish setup, then restart the task.');
      injectDone = true;
      injectPhase = 'done'; // give up quietly — never paste the task prompt into an unknown screen
      return;
    }
    // (C1272) An open AskUserQuestion menu (design mode's model asking a clarifying question) —
    // same give-up discipline as firstRun above: no safe auto-answer exists (unlike mcpTrust),
    // so this always defers rather than falling through to a blind paste. Placed before the
    // shared mcpTrust/toolApproval defer block below for the same reason firstRun is: so
    // 'askQuestion' can never fall through that block's cap-then-paste fallback (it can't reach
    // that block anyway, since its kind check is scoped to mcpTrust/toolApproval only — kept
    // here purely for consistency with the other gate-kind branches).
    if (dlg && dlg.kind === 'askQuestion') {
      if (!askQuestionNoticeShown) {
        askQuestionNoticeShown = true;
        emitTerminalNotice(session, 'A question is waiting above — the task prompt will be sent once you answer it.');
      }
      injectRetries++;
      // Same C1047 ceiling-burn fix as the other gate branches — refresh on every deferral.
      injectPhaseStartAt = Date.now();
      if (injectRetries < MAX_ASK_QUESTION_RETRIES) {
        armInjectTimer(INJECT_DIALOG_RETRY_MS);
        return;
      }
      emitTerminalNotice(session, 'A question is waiting above — the task prompt was NOT sent. Answer it, then restart the task.');
      injectDone = true;
      injectPhase = 'done'; // give up quietly — never paste the task prompt into an open menu
      return;
    }
    // C880: a bracketed paste is swallowed by an MCP-trust / tool-approval dialog. Defer (capped).
    // C997/C1047: mcpTrust needs a human to read + click Allow (routinely >3s) — give it a much
    // larger cap than toolApproval (machine-fast, Codex-only) so the prompt never gets
    // pasted+submitted into the still-open trust dialog and swallowed. This branch is now the
    // fallback for a dialog getMcpTrustAutoAnswer() couldn't parse. `injectPhaseStartAt` is
    // refreshed on every deferral below — without this, the INJECT_MAX_WAIT_MS ceiling in the
    // onData handler (once 10s had elapsed since first output) forced onInjectSilence() on
    // every single chunk regardless of the 1s retry pacing, burning through all 60 retries in
    // one or two Ink redraw ticks instead of the intended ~60 real seconds. That premature
    // exhaustion — not the lack of an auto-answer — was the actual root cause of the prompt
    // never landing even after the user answered the dialog manually.
    if (dlg && (dlg.kind === 'mcpTrust' || dlg.kind === 'toolApproval')) {
      const cap = dlg.kind === 'mcpTrust' ? MAX_MCP_TRUST_RETRIES : MAX_INJECT_DIALOG_RETRIES;
      if (injectRetries < cap) {
        if (dlg.kind === 'mcpTrust' && !mcpTrustNoticeShown) {
          mcpTrustNoticeShown = true;
          emitTerminalNotice(session, 'Waiting for MCP server trust approval before sending task prompt.');
        }
        injectRetries++;
        injectPhaseStartAt = Date.now();
        armInjectTimer(INJECT_DIALOG_RETRY_MS);
        return;
      }
    }
    if (injectPhase === 'awaitReady') {
      // Floor: give the TUI getInteractiveReadyMs() to boot even if it briefly paused,
      // so we never paste into a half-initialised prompt.
      const elapsed = Date.now() - injectFirstOutputAt;
      const floor = agent.getInteractiveReadyMs();
      if (elapsed < floor) { armInjectTimer(floor - elapsed); return; }
      // (C1260) design mode: paste the /design prelude alone first, never fused with the
      // task prompt — a slash command fused into a multi-line paste never runs as a
      // command. No prelude -> unchanged original behavior.
      if (preludePrompt) {
        session.pty.write(`\x1b[200~${preludePrompt}\x1b[201~`);
        injectPhase = 'awaitPreludeAck';
      } else {
        session.pty.write(`\x1b[200~${initialPrompt}\x1b[201~`);
        injectPhase = 'awaitPasteAck';
      }
      injectPhaseStartAt = Date.now();
      // Verify the paste landed: the TUI echoes it; once that render settles the paste
      // is fully consumed -> submit with Enter.
      armInjectTimer(agent.getPasteSilenceMs());
      return;
    }
    if (injectPhase === 'awaitPreludeAck') {
      // (C1260) Prelude paste settled -> submit it as ITS OWN message (Enter), then
      // switch to polling for it to finish instead of falling straight to 'done' the way
      // awaitPasteAck below does — there's a whole /design turn to wait out first.
      session.pty.write('\r');
      injectPhase = 'awaitPreludeRun';
      const now = Date.now();
      preludeSubmittedAt = now;
      injectPhaseStartAt = now;
      injectRetries = 0;  // fresh mcpTrust/toolApproval defer budget for /design's own dialogs
      emitTerminalNotice(session, '/design running — the task prompt will be sent once it finishes.');
      armInjectTimer(INJECT_DIALOG_RETRY_MS);
      return;
    }
    if (injectPhase === 'awaitPreludeRun') {
      const now = Date.now();
      const waitedMs = now - preludeSubmittedAt;
      const quietMs = now - (session.lastOutputAt || now);
      // dlg (resolved above) can still be a gate kind here even after the shared
      // mcpTrust/toolApproval block's own cap ran out and fell through without
      // returning (unlike that block, we must NOT treat cap-exhaustion as license to
      // paste the task prompt into a still-open dialog) — recheck directly.
      const gated = !!(dlg && isInjectGateKind(dlg.kind));
      const replReady = isClaudeReplReady(session._attentionTail);
      const release = () => {
        session.pty.write(`\x1b[200~${initialPrompt}\x1b[201~`);
        injectPhase = 'awaitPasteAck';
        injectPhaseStartAt = now;
        armInjectTimer(agent.getPasteSilenceMs());
      };
      if (waitedMs >= PRELUDE_MAX_WAIT_MS) {
        if (gated) {
          emitTerminalNotice(session, '/design is still waiting on a dialog above — the task prompt was NOT sent. Answer it, then restart the task.');
          injectDone = true;
          injectPhase = 'done';
          return;
        }
        emitTerminalNotice(session, '/design is taking unusually long — sending the task prompt now.');
        release();
        return;
      }
      if (shouldReleasePrelude({ waitedMs, quietMs, gated, replReady })) {
        release();
        return;
      }
      if (!preludeLongNoticeShown && waitedMs >= PRELUDE_LONG_WAIT_MS) {
        preludeLongNoticeShown = true;
        emitTerminalNotice(session, '/design is still running — the task prompt will be sent once it finishes.');
      }
      // (C1047 ceiling-burn fix) refresh on every deferral, same discipline as the
      // mcpTrust/toolApproval/firstRun branches above — otherwise the onData handler's
      // own INJECT_MAX_WAIT_MS force-check would fire onInjectSilence() on every single
      // PTY chunk once 10s elapse, instead of at the INJECT_DIALOG_RETRY_MS pace below.
      injectPhaseStartAt = now;
      armInjectTimer(INJECT_DIALOG_RETRY_MS);
      return;
    }
    if (injectPhase === 'awaitPasteAck') {
      // (TPT445) Type the agent's short kickoff line as its own write, then wait one more silence
      // window before Enter — a message that is only a paste is refused as "no words from you".
      if (kickoffTypedLine && !typedLineSent) {
        typedLineSent = true;
        session.pty.write(kickoffTypedLine);
        injectPhaseStartAt = Date.now();
        armInjectTimer(agent.getPasteSilenceMs());
        return;
      }
      injectDone = true;
      injectPhase = 'done';
      session.pty.write('\r');
      // (TPT364) Confirm the Enter actually submitted the paste — see SUBMIT_VERIFY_MS.
      submitWatchUntil = Date.now() + SUBMIT_WATCH_MS;
      if (agent.getUnsentPasteRe()) armSubmitCheck(SUBMIT_VERIFY_MS);
    }
  }

  emitTerminalState(session);
  if (session.planApprovalCommand) {
    emitTerminalNotice(session, `Planning mode. Review the plan, then type ${session.planApprovalCommand} and press Enter to continue.`);
  } else {
    emitTerminalNotice(session, 'Planning mode. Review the plan, then use the approval dialog to continue.');
  }

  ptyProcess.onData((data) => {
    session.lastOutputAt = Date.now();
    session._terminalOutputSeen = true;
    // (C1060) Strip OSC (terminal title, OSC 9;4 progress, OSC 8 hyperlinks, OSC 52 clipboard)
    // BEFORE stripAnsi() — stripAnsi only strips CSI/2-char escapes, so an OSC's BEL terminator
    // otherwise survives into cleanChunk and _attentionTail and gets read as the terminal-bell
    // "needs input" signal by feedAttentionChunk() step 2 below. See stripOscChunk()'s comment.
    // session.buffer (the xterm replay buffer, further down) stays on raw `data` — the client
    // still renders titles/hyperlinks; only the attention pipeline is OSC-free.
    const oscFreeChunk = stripOscChunk(session, data);
    const cleanChunk = stripAnsi(oscFreeChunk);
    // (C1066) Row-aware stream for the line-scoped attention detector ONLY — restores real
    // screen-row boundaries for CLIs (claude 2.1.22x) that paint via cursor-addressed escapes
    // (`ESC[r;cH`) instead of '\n'-separated rows, which stripAnsi() alone glues into one
    // unmatchable mega-line. _attentionTail/getAttentionPromptMatch() below deliberately stay
    // on the plain `cleanChunk` stream — see screen-reflow.js's header comment and
    // prompt-detect.js's HARD RULE (this must never touch the paste-injection gate / MCP-trust
    // auto-answer / plan-ready state machine).
    const rowChunk = reflowChunk(session, oscFreeChunk);
    if (/\x1b\[2J|\x1b\[\?1049[hl]/.test(data)) {
      session._attentionTail = '';
    }
    session._attentionTail = ((session._attentionTail || '') + cleanChunk).slice(-ATTENTION_WINDOW_BYTES);
    // Tail-scoped match: feeds ONLY onInjectSilence()'s paste-injection gate (above) and the
    // plan-ready state machine below. The real-time attention signal is computed separately,
    // line-scoped, by feedAttentionChunk() — see its comment for why the two are kept apart.
    let attentionMatch = getAttentionPromptMatch(session._attentionTail, session.taskAgent, session);
    // (C1386) Hoisted above feedAttentionChunk() so its step 4 can consult shouldHoldAttention()
    // against the SAME tail kind the C1120 block below reasons about — was previously computed
    // only after feedAttentionChunk() ran.
    const tailKind = attentionMatch ? attentionMatch.kind : null;
    // (C1386) Mirrored onto the session every chunk — index.js's ATTENTION_STALE_MS sweep runs
    // outside this closure and has no other way to read the current inject-injection phase.
    session._injectDone = injectDone;
    // (C1116) lineHit is the line-scoped/reflow-aware result — a second planReady source below,
    // needed because PI_PLAN_READY_PATTERNS is line-anchored and the tail stream (attentionMatch
    // above) deliberately stays un-reflowed (HARD RULE, prompt-detect.js). Does not change
    // attentionMatch/getAttentionPromptMatch() itself, so the paste-injection gate / MCP-trust
    // auto-answer this session's onInjectSilence() drives off attentionMatch are untouched.
    const lineHit = feedAttentionChunk(session, agent, oscFreeChunk, cleanChunk, undefined, rowChunk, tailKind);
    attentionMatch = getAttentionPromptMatch(session._attentionTail, session.taskAgent, session);
    // (C1120) Dialog-kind-cleared transition — see the comment above lineDialogLeftScreen()/
    // dialogGateCleared(). Fires on either the line-scoped signal (session._attentionState just
    // went active -> null while the tail is still gate-blocked — this is what actually notices an
    // in-place TUI dismissal, e.g. Claude's folder-trust dialog) or the tail-scoped one
    // (attentionMatch's own kind changed away from a gate kind — re-applies the awaitReady boot
    // floor once the sticky tail has caught up on its own). Tracking runs unconditionally; only
    // the reset itself is gated on !injectDone. (C1386: disjoint from shouldHoldAttention() above
    // by construction — that predicate requires injectDone===true, this block requires !injectDone.)
    const lineKind = session._attentionState ? session._attentionState.kind : null;
    if (!injectDone
        && (lineDialogLeftScreen(session._lastAttentionKind, lineKind, tailKind)
            || dialogGateCleared(session._lastTailDialogKind, tailKind))) {
      session._attentionTail = '';
      injectRetries = 0;
      injectFirstOutputAt = Date.now();
      injectPhaseStartAt = Date.now();
    }
    session._lastAttentionKind = lineKind;
    session._lastTailDialogKind = tailKind;
    if (!injectDone) {
      const now = Date.now();
      if (!injectFirstOutputAt) { injectFirstOutputAt = now; injectPhaseStartAt = now; }
      // Reset the silence window on every chunk; fire only once the PTY is quiet.
      // Ceiling: if the TUI never goes quiet, force the phase forward.
      if (now - injectPhaseStartAt >= INJECT_MAX_WAIT_MS) {
        clearInjectTimer();
        onInjectSilence();
      } else {
        armInjectTimer(agent.getPasteSilenceMs());
      }
    }
    session.buffer += data;
    if (session.buffer.length > config.MAX_SCROLLBACK) {
      session.buffer = truncateBufferSafely(session.buffer, config.MAX_SCROLLBACK);
    }
    if (session.ws && session.ws.readyState === session.ws.OPEN) {
      session.ws.send(JSON.stringify({ type: 'data', tabId: session.tabId, data }));
    }
    const isToolApproval = attentionMatch?.kind === 'toolApproval';
    const planMatched = requiresExplicitPlanReadyPattern(session)
      && session.terminalPhase === 'planning'
      && !isToolApproval
      && (attentionMatch?.kind === 'planReady' || lineHit?.kind === 'planReady');
    if (planMatched) session.agentPlanReady = true;
    if (session.taskAgent === 'codex' && planMatched) session.codexPlanReady = true;
    const planReadyEligible = requiresExplicitPlanReadyPattern(session)
      ? session.agentPlanReady === true && (session.taskAgent !== 'codex' || session.codexPlanReady === true)
      : (session.planOnly || (!session.planApprovalCommand && session._userInteracted));
    // Codex's shared quiet-window callback also publishes attention; bypass this
    // independent latch/timer so a split historical repaint cannot race it.
    if (bgAgentsBusy(session)) {
      // (TPT348) Claude has ended its turn and is waiting on background agents — quiet output is
      // not "plan ready". Cancel any pending timer and restart the 10s arm ceiling: left alone,
      // `10000 - elapsed` collapses the delay to 0 and plan-ready would fire on the very first
      // chunk after the agents report back, mid-turn.
      clearTimeout(session._planIdleTimer);
      session._planFirstArmedAt = null;
    } else if (session.taskAgent !== 'codex' && planReadyEligible && !session._planReadySent && session.buffer.length > planReadyMinBufferLength(session)) {
      clearTimeout(session._planIdleTimer);
      if (!session._planFirstArmedAt) session._planFirstArmedAt = Date.now();
      const elapsed = Date.now() - session._planFirstArmedAt;
      const delay = Math.max(0, Math.min(2000, 10000 - elapsed));
      session._planIdleTimer = setTimeout(() => {
        if (session.terminalPhase === 'planning' && !session._planReadySent
            && session.ws && session.ws.readyState === session.ws.OPEN) {
          session._planReadySent = true;
          if (!session._attentionState) {
            session._attentionState = { kind: 'planReady', promptText: '', agent: agent.id, at: Date.now() };
            session._patternAttentionNeeded = true;
            session.onAttentionNeeded?.({ kind: 'planReady', promptText: '', agent: agent.id });
          }
          session.ws.send(JSON.stringify({
            type: 'plan-ready',
            tabId: session.tabId,
            codexPlanReady: session.codexPlanReady === true,
          }));
        }
      }, delay);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    endSessionMemory(session, 'exited');
    clearInjectTimer();
    clearTimeout(session._submitCheckTimer); // (TPT364)
    if (session.taskAgent === 'codex') invalidateCodexPlan(session);
    if (session._approvalWatchdogTimer) { clearTimeout(session._approvalWatchdogTimer); session._approvalWatchdogTimer = null; }
    if (session._tokenExpiryWatch) { session._tokenExpiryWatch.cancel(); session._tokenExpiryWatch = null; } // (TPT349)
    console.log(`[terminal:${agent.id}] Process exited for task ${taskId} (code ${exitCode})`);
    if (session._terminated) return;
    session.alive = false;
    session.exitCode = exitCode;
    session.codexPlanReady = false;
    session.agentPlanReady = false;
    // (C1565) A dead pid can be recycled by the OS — the watchdog must never resume
    // counting a stranger's process tree against this session.
    session.descendantWatchdog = null;
    session.ptyPid = null;
    session._pause = null;
    const filesRead = readTrackedFiles(taskId);
    if (filesRead.length > 0) {
      console.log(`[terminal:${agent.id}] Task ${taskId} read ${filesRead.length} file path(s)`);
    }
    if (session.ws && session.ws.readyState === session.ws.OPEN) {
      session.ws.send(JSON.stringify(buildTerminalExitFrame(session, exitCode, filesRead)));
    }
    session.onSessionExit?.({ exitCode, buffer: session.buffer, ...exitReasonFields(session) });
    try { session.onSlotFreed?.(); } catch { /* queue drain must never break exit handling */ } // (TPT444)
  });
}

function handleTerminalInput(session, data) {
  if (!session.alive || !session.pty || typeof data !== 'string' || !data.length) return;
  if (session.taskAgent === 'codex' && /[\r\n]/.test(data)) {
    invalidateCodexPlan(session);
    session._attentionTail = '';
    session._attentionLineCarry = '';
    session._attentionRowCarry = '';
  }
  if (!session._userInteracted) session._userInteracted = true;

  // Fast path: agents without a slash approval command, or executing phase with no pending
  // interception, write the entire chunk intact. This preserves multi-byte escape sequences
  // (arrow keys, etc.) that char-by-char writes would split.
  if (!session.planApprovalCommand || (session.terminalPhase !== 'planning' && !session._interceptingApprovalCommand)) {
    session.pty.write(data);
    return;
  }

  // Planning phase: scan for '/' to intercept the plan-approval command.
  // Everything else is bulk-written to avoid splitting escape sequences.
  let i = 0;
  while (i < data.length) {
    if (session._interceptingApprovalCommand) {
      const ch = data[i++];

      if (ch === '\u007f') {
        session._localCommandBuffer = session._localCommandBuffer.slice(0, -1);
        if (session._localCommandBuffer.length === 0) {
          session._interceptingApprovalCommand = false;
        }
        continue;
      }

      if (ch === '\r' || ch === '\n') {
        const command = session._localCommandBuffer.trim();
        session._localCommandBuffer = '';
        session._interceptingApprovalCommand = false;
        if (command === session.planApprovalCommand) {
          approvePlan(session);
          // Phase is now 'executing' — bulk-write any remaining data.
          if (i < data.length) {
            session.pty.write(data.slice(i));
          }
          return;
        } else {
          session.pty.write(command + ch);
        }
        continue;
      }

      session._localCommandBuffer += ch;
      if (!session.planApprovalCommand.startsWith(session._localCommandBuffer)) {
        session.pty.write(session._localCommandBuffer);
        session._localCommandBuffer = '';
        session._interceptingApprovalCommand = false;
      }
      continue;
    }

    // Not intercepting: find next '/' and bulk-write everything before it.
    const slashIndex = data.indexOf('/', i);
    if (slashIndex === -1) {
      session.pty.write(data.slice(i));
      return;
    }
    if (slashIndex > i) {
      session.pty.write(data.slice(i, slashIndex));
    }
    session._interceptingApprovalCommand = true;
    session._localCommandBuffer = '/';
    i = slashIndex + 1;
  }
}

// ── Terminal image paste (C809, C1003, C1051) ──
// Save a base64 clipboard image to disk and inject it into the PTY so the agent attaches it
// and renders its native `[Image #N]` placeholder, same as a real terminal clipboard paste.
// The byte format is agent-specific (BaseTaskAgent#injectImagePath(), overridable per agent)
// — the default is a *bare* absolute path delivered inside a bracketed-paste frame
// (ESC[200~ … ESC[201~), no `@` prefix, no quotes, no trailing newline. This differs from the
// @<localpath> C639/C818 convention used at spawn time for prompt-embedded image refs: `@`
// there opens the agent's project-scoped file-mention autocomplete, which silently no-ops on
// an out-of-tree temp path (root cause of C1003 — paste did nothing at the CLI level).
//
// C1051 root cause: the client-side paste never reached this code at all — see
// console-modal.js's pasteHandler comment. This bracketed-paste-bare-path format was
// confirmed correct for the currently installed `claude` and `codex` CLIs via
// scripts/probe-image-paste.js (real CLI spawn, no mocking); undocumented CLI behavior,
// re-verify with that script after CLI upgrades.
//
// C1247: paste images are now saved in-tree (<projectRoot>/.tipatask/images/<tabId>/, via
// resolveAttachmentDir()) rather than under USER_DATA_ROOT, matching the spawn-time
// localizers. The C1003 "out-of-tree temp path" rationale above no longer applies to a
// project-bound session, but do NOT switch this back to the `@` convention on the strength
// of that alone — the bracketed-paste-bare-path format was verified empirically against real
// CLI behavior; re-run scripts/probe-image-paste.js before revisiting it.

const _PASTE_MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function imageMimeAllowed(mimeType) {
  return typeof mimeType === 'string'
    && Object.prototype.hasOwnProperty.call(_PASTE_MIME_EXT, mimeType);
}

// projectRoot is a required leading param (not an optional trailing one) so a caller can't
// silently fall through to the wrong location when it forgets to pass it — see
// resolveAttachmentDir() for the in-project-vs-USER_DATA_ROOT fallback rule.
function saveBase64Image(projectRoot, tabId, mimeType, base64) {
  if (!imageMimeAllowed(mimeType)) throw new Error('Unsupported image type: ' + mimeType);
  if (typeof base64 !== 'string' || !base64) throw new Error('Empty image data');
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw new Error('Empty image data');
  if (buf.length > 12 * 1024 * 1024) throw new Error('Image too large (>12 MB)');
  const dir = resolveAttachmentDir('images', projectRoot, tabId || 'terminal');
  const localPath = path.join(dir, crypto.randomUUID() + _PASTE_MIME_EXT[mimeType]);
  fs.writeFileSync(localPath, buf);
  return localPath;
}

const IMAGE_ATTACH_VERIFY_MS = 2500;  // ceiling to wait for the agent's attach marker (C1051)
const IMAGE_ATTACH_VERIFY_POLL_MS = 200;

// Polls the rolling stripAnsi'd PTY tail (session._attentionTail, already maintained by the
// onData handler in spawnTerminal()) for the agent's image-attach marker so a paste failure
// is visible instead of silently assumed successful. Left on the input line, not auto-
// submitted, so there is no "did the user press Enter" race — the marker either renders
// within the window or the paste didn't attach.
function verifyImageAttach(session, agent, localPath, deadline) {
  if (!session.alive) return; // session ended mid-check — nothing left to report
  const markerRe = agent.getImageAttachMarkerRe();
  if (markerRe.test(session._attentionTail || '')) {
    console.log(`[terminal:${agent.id}] Image paste attach confirmed for task ${session.tabId}`);
    return;
  }
  if (Date.now() >= deadline) {
    console.log(`[terminal:${agent.id}] Image paste attach NOT confirmed for task ${session.tabId} (path=${localPath})`);
    emitTerminalNotice(session, 'Image paste did not attach — the CLI may not support this on the installed version, or the paste was interrupted.');
    return;
  }
  const timer = setTimeout(() => verifyImageAttach(session, agent, localPath, deadline), IMAGE_ATTACH_VERIFY_POLL_MS);
  if (timer.unref) timer.unref();
}

function injectPastedImage(session, mimeType, dataB64) {
  if (!session || !session.alive || !session.pty) {
    throw new Error('Terminal not running');
  }
  if (typeof dataB64 !== 'string' || !dataB64) {
    throw new Error('Missing image data');
  }
  const localPath = saveBase64Image(session.projectPath || config.PROJECT_ROOT, session.tabId, mimeType, dataB64);
  const agent = getTaskAgent(session.taskAgent || config.TASK_AGENT);
  console.log(`[terminal:${agent.id}] Injecting pasted image for task ${session.tabId} (${dataB64.length} b64 chars) -> ${localPath}`);
  agent.injectImagePath(session, localPath);
  verifyImageAttach(session, agent, localPath, Date.now() + IMAGE_ATTACH_VERIFY_MS);
  return localPath;
}

module.exports = {
  stripAnsi,
  stripOscChunk,
  ATTENTION_PROMPT_TEXT_MIN,
  ATTENTION_WINDOW_BYTES,
  MAX_MCP_TRUST_RETRIES,
  MAX_FIRST_RUN_RETRIES,
  isInjectGateKind,
  lineDialogLeftScreen,
  dialogGateCleared,
  shouldHoldAttention,
  ATTENTION_HOLD_MAX_MS,
  bgAgentsBusy,
  BG_AGENTS_BUSY_MAX_MS,
  shouldReleasePrelude,
  PRELUDE_MIN_RUN_MS,
  PRELUDE_QUIET_MS,
  SUBMIT_VERIFY_MS,
  SUBMIT_QUIET_MS,
  SUBMIT_POLL_MS,
  SUBMIT_WATCH_MS,
  SUBMIT_MARKER_TRAILING_MAX,
  MAX_SUBMIT_RETRIES,
  unsentPasteVisible,
  emitTerminalState,
  emitTerminalNotice,
  emitTerminalWarning,
  scheduleTokenExpiryWatch,
  buildTokenExpiryNotice,
  TOKEN_WATCH_LEAD_MS,
  killRunawaySession,
  pauseRunawaySession,
  resumeRunawaySession,
  pausedSummary,
  resumeAllRunawaySessions,
  killPausedTargets,
  buildTerminalExitFrame,
  exitReasonFields,
  handleTerminalInput,
  spawnTerminal,
  fetchTaskCommentsContext,
  fetchParentTaskBlock,
  approvePlan,
  forceResumeRepaint,
  getAttentionPromptMatch,
  codexPlanReadyIsFresh,
  CODEX_PLAN_QUIET_MS,
  getMcpTrustAutoAnswer,
  carveAttentionLines,
  feedAttentionChunk,
  requiresExplicitPlanReadyPattern,
  planReadyMinBufferLength,
  truncateBufferSafely,
  sanitizeReplayBuffer,
  imageMimeAllowed,
  saveBase64Image,
  injectPastedImage,
};
