'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { beginSessionMemory, endSessionMemory } = require('./session-memory');
const { refreshSessionVcs } = require('./vcs-context');
const { resolvePermissionMode, assertPermissionSupport, permissionError, applyLivePolicy,
  validateLiveMode, modeSwitchError, permissionModeSnapshot, versionAtLeast, PI_GATE_VERSION } = require('./permission-policy');
const { createPermissionGate } = require('./permission-gate');
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
const { terminalCopy, normalizeLocale, refreshErrorCopy } = require('./terminal-copy'); // (TPT9002) project-language notices
const { refreshProjectToken } = require('./token-refresh');
const { getApiCredentials } = require('./api-credentials');
const { getTaskAgent } = require('./task-agent');
const BaseTaskAgent = require('./task-agent/base-agent');
const { buildLegacyPatternTable, sanitizePromptText, isClaudeReplReady, matchClaudeBgAgentsLine, CODEX_COMPOSER_PLACEHOLDERS, CODEX_EMPTY_COMPOSER_RE } = require('./task-agent/prompt-detect');
const { reflowChunk, carveReflowLines, resetReflow } = require('./screen-reflow');
const { matchClaudePlanOutcomeLine, trackTypedLine, classifyTypedSubmission, trackClaudeScreen } = require('./plan-approval-detect'); // (TPT654, TPT9136)
const { maxCommentId, isTerminalTailExitComment } = require('./exit-resolution');
const { syncOnSessionStart, isSyncAsYouGoEnabled } = require('../cli/knowledge-sync');
const archCache = require('../mcp/architecture-cache');
const { getTagsForTask } = require('./tag-cache');
const { resolveAttachmentDir } = require('./attachment-paths');
const { openPtyTrace } = require('./pty-trace'); // (TPT9048) TIPATASK_PTY_TRACE kickoff diagnostics
const { selectNextCowboyTasks, effectivePermissionMode, chainKickoffPrompt, chainLaunchAgent } = require('./cowboy-next'); // (TPT9162)
const { withProjectLock } = require('./project-mutex');
const { LOCAL_HOST } = require('./local-access');
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
// isClaudeReplReady() matches the permission-mode footer ("plan mode on", "auto mode on", …),
// which is present WHILE the turn is still running too, so it can't be the signal a turn
// ended. A real turn repaints its spinner continuously; only a multi-second quiet window
// means it's actually done.
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
// (TPT9048) How long a kickoff may sit queued behind the agent's own startup (the TUI's
// "Waiting for startup" footer, Codex) before verification stops watching. Startup is bounded by
// the MCP servers' startup_timeout_sec (60 s) on a cold Windows machine, plus the model catalog.
const SUBMIT_STARTUP_WAIT_MAX_MS = 120000;
// (TPT571) Lost-paste fallback, Codex. A kickoff paste the TUI never took leaves the composer EMPTY
// (agent.getEmptyComposerRe() — the bare placeholder row), so re-sending the Enter would submit
// nothing. That state — the empty composer as the last thing drawn, PTY silent, no dialog, the
// agent's paste chip never echoed after the paste, and almost no output since the Enter — gets the
// whole kickoff pasted again, once. The byte ceiling is what separates "nothing happened" from a
// turn that ran and ended quickly inside SUBMIT_WATCH_MS (its transcript alone is far larger).
const MAX_PASTE_RETRIES = 1;
const EMPTY_COMPOSER_MAX_BYTES = 2048;

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

// (TPT9048) The kickoff text (agent.getKickoffEchoRe()) is still sitting UNSENT in the composer:
// its last occurrence is near the end of the tail, nothing that proves a running turn follows it
// (a `Working (` / `esc to interrupt` / activity row, see codexTurnMarker()), and no empty
// composer placeholder row follows it either (that pairing is the echoed transcript row of a turn
// that DID go in, with the composer repainted empty below it). Wider trailing budget than the
// chip's: the whole handoff row plus the footer sits after the match.
const KICKOFF_ECHO_TRAILING_MAX = 900;
function kickoffEchoStranded(re, tail) {
  if (!re || typeof tail !== 'string' || !tail) return false;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let last = -1;
  let end = -1;
  for (const m of tail.matchAll(g)) { last = m.index; end = m.index + m[0].length; }
  if (last < 0 || tail.length - last > KICKOFF_ECHO_TRAILING_MAX) return false;
  const after = tail.slice(end);
  for (const line of after.split(/\r\n|[\r\n]/)) {
    if (codexTurnMarker(line) === 'work' && !/^\s*[›❯>]/.test(line)) return false; // a turn is running
    if (CODEX_EMPTY_COMPOSER_RE.test(line)) return false;                           // echo row + empty composer
  }
  return true;
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
// placeholders (CODEX_COMPOSER_PLACEHOLDERS, prompt-detect.js — shared with the TPT571
// empty-composer marker) are not submissions (they also remain visible during active work).
const CODEX_PLAN_QUIET_MS = 2000;
function codexTurnMarker(line) {
  // Worked-for duration, model/effort status and warning footers are idle chrome:
  // none matches the submission or active-work markers below. They cannot create
  // readiness on their own, and must not discard a preceding plan sentinel.
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

function piPlanReadyIsFresh(session) {
  if (session.taskAgent !== 'pi' || !session._transcriptHint) return true;
  // Pi echoes the full kickoff and task attachments. A painted sentinel alone
  // cannot distinguish those user/tool messages from a completed assistant plan.
  try {
    const message = getTaskAgent('pi').readFinalMessage(session);
    return message?.turnEnded === true && typeof message.text === 'string'
      && /^\s*Plan ready[.!]?\s*$/i.test(message.text.trim().split(/\r?\n/).at(-1));
  } catch { return false; }
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
    // (TPT571) Codex's kickoff is paste-injected now, and the kickoff text itself carries the
    // sentinel instruction. Nothing Codex paints before the kickoff Enter can be a real plan —
    // leave the candidate and let the genuine post-submit sentinel re-arm this timer.
    if (session._injectDone === false) return;
    const wasAnnounced = session._planReadySent;
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
    // Publish the rising edge as well as invalidateCodexPlan's falling edge.
    // A resize repaint of an announced plan keeps the same client dialog.
    if (!wasAnnounced) emitTerminalState(session);
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
  // A live Pi session confirms its candidate from the native transcript in the
  // quiet-window callback below. Do not raise attention from the echoed prompt.
  if (agent.id === 'pi' && session._transcriptHint && hit?.kind === 'planReady') return hit;
  // (TPT654) The answered ExitPlanMode dialog collapses to a transcript row (or the mode footer
  // changes after a shift+tab) — a plan approved inside Claude's own TUI. Same stream-order row
  // set as trackBgAgents() above; acts only on a planning session past its kickoff.
  // (TPT9136) The chunk also updates session._claudeTui, a screen grid read for the footer mode,
  // an open dialog and the composer — what confirms live switches (Ink writes only changed cells,
  // so rows alone cannot); a footer change nobody requested goes to the adapter.
  if (agent.id === 'claude') {
    const modeChange = trackClaudeScreen(session, rawChunk, { now, rows: session.pty?.rows, cols: session.pty?.cols });
    if (modeChange) agent.observeModeChange?.(session, modeChange, now);
    trackClaudePlanOutcome(session, rowChunk == null ? legacyLines : rowLines);
  }
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

// Called synchronously during live reattachment, before the event loop can forward
// another PTY chunk. Replay is one snapshot, never appended back into session.buffer.
// Even an empty snapshot provides a parser barrier for the client's repaint nudge.
function replayLiveTerminal(session, ws = session?.ws) {
  if (!session?.alive || !ws || ws.readyState !== ws.OPEN) return false;
  const reset = '\x1b[!p\x1b[?1049l\x1b[2J\x1b[H';
  const buffer = sanitizeReplayBuffer(session.buffer || '', {
    preserveAltScreenFrame: session.taskAgent === 'codex'
      && session.terminalPhase === 'planning'
      && session.codexPlanReady === true && codexPlanReadyIsFresh(session),
  });
  ws.send(JSON.stringify({ type: 'data', tabId: session.tabId, data: reset + buffer }));
  return true;
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
      permissionMode: session.permissionPolicy?.mode ?? null,
      permissionModeState: permissionModeFrame(session),
      permissionSource: session.permissionPolicy?.source ?? null,
      permissionRequest: session._permissionGate?.snapshot() || null,
      ...(session._imageState ? { imageTask: session._imageState } : {}),
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

// (TPT9139) Whether this run offers live switching at all: a task terminal with a resolved policy
// whose adapter implements it (supportsLivePermissionSwitch()) and has not refused this run as
// unsupported. Clients hide their selector while false; it never authorizes a switch.
function permissionModeSupported(session) {
  if (!session || session.type !== 'terminal' || !session.permissionPolicy || session._imageOperation) return false;
  if (session.permissionMode?.error?.reason === 'unsupported') return false;
  try {
    return getTaskAgent(session.taskAgent).supportsLivePermissionSwitch?.(session) === true;
  } catch { return false; }
}

// The state every client-facing frame carries: the snapshot plus `supported`, and (TPT9136)
// `native` when the run's adapter reports what its modes mean natively (Claude: whether Auto is
// native auto or the acceptEdits fallback, and whether Bypass is reachable).
function permissionModeFrame(session) {
  const frame = { ...permissionModeSnapshot(session), supported: permissionModeSupported(session) };
  let native = null;
  try { native = session?.permissionPolicy ? getTaskAgent(session.taskAgent).nativePermissionSummary?.(session) || null : null; } catch { native = null; }
  if (native) frame.native = native;
  return frame;
}

function emitPermissionModeState(session) {
  // Tool calls a pending switch held at the Pi gate are decided once it settles.
  session._permissionGate?.policyChanged?.();
  // Backstop for chats: wireClient() neither replays nor switches a chat's mode, but a pending
  // chat still has the default terminal type, so any other caller gets only the terminal-state
  // reply, never a permission-mode frame or project broadcast.
  if (require('./session-state').isAgentChatId(session.taskId || session.tabId)) {
    emitTerminalState(session);
    return;
  }
  const payload = { taskId: session.taskId || session.tabId, tabId: session.tabId,
    startedAt: session.startedAt, ...permissionModeFrame(session) };
  if (session.ws && session.ws.readyState === session.ws.OPEN) {
    session.ws.send(JSON.stringify({ type: 'session:permission-mode-changed', ...payload }));
  }
  require('./websocket').emitSessionPermissionModeChanged(session.projectPath, payload);
  emitTerminalState(session);
}

// id is the server's project-scoped sessions Map key, never a client-supplied task id.
async function requestPermissionMode(id, mode, sessions) {
  const session = sessions?.get(id);
  if (!session) throw modeSwitchError('inactive');
  if (session.permissionMode?.pending) throw modeSwitchError('busy');
  const state = permissionModeSnapshot(session);
  session.permissionMode = state;
  const fail = err => {
    state.pending = false;
    state.error = { code: err.code || 'EPERMISSION_MODE', reason: err.reason || 'failed',
      message: err.message || modeSwitchError('failed').message };
    emitPermissionModeState(session);
    return permissionModeSnapshot(session);
  };
  try {
    // Keep untrusted malformed inputs out of session inventory and broadcast frames.
    if (typeof mode === 'string' && mode.length <= 32) state.requested = mode;
    validateLiveMode(mode);
    if (session.type !== 'terminal' || !session.alive || !session.pty || session._terminated
      || session._starting || session._imageOperation || !session.permissionPolicy) throw modeSwitchError('inactive');
    if (mode === state.confirmed) {
      state.error = null;
      emitPermissionModeState(session);
      return permissionModeSnapshot(session);
    }
  } catch (err) { return fail(err); }

  const agent = getTaskAgent(session.taskAgent);
  const ptyAtRequest = session.pty;
  const startedAt = session.startedAt;
  state.pending = true;
  state.error = null;
  session._permissionEpoch = (session._permissionEpoch || 0) + 1;
  // Revoke queued app approvals before awaiting the provider. Failed switches also
  // require fresh approval IDs; they cannot revive an old authorization.
  if (session._approvalWatchdogTimer) clearTimeout(session._approvalWatchdogTimer);
  session._approvalWatchdogTimer = null;
  session._permissionGate?.cancelPending();
  emitPermissionModeState(session);
  try {
    const result = await agent.switchPermissionMode(session, mode);
    if (session.permissionMode !== state) return permissionModeSnapshot(session); // a fresh launch owns state now
    if (sessions.get(id) !== session || !session.alive || session._terminated
      || session.pty !== ptyAtRequest || session.startedAt !== startedAt) throw modeSwitchError('session_changed');
    if (result?.supported !== true) throw modeSwitchError('unsupported');
    if (result.confirmed !== mode) throw modeSwitchError('unconfirmed');
    applyLivePolicy(session, mode);
    state.confirmed = mode;
    state.pending = false;
    state.error = null;
    session._permissionGate?.cancelPending();
    // Clear the awaiting-plan state used by plan-approval-detect.js and its timers.
    clearTimeout(session._planIdleTimer);
    session._planIdleTimer = null;
    session._planFirstArmedAt = null;
    session._codexPlan = { candidate: null, ready: false };
    session._planReadySent = false;
    session.codexPlanReady = false;
    session.agentPlanReady = false;
    session._typedLine = '';
    session._typedPasting = false;
    session._localCommandBuffer = '';
    session._interceptingApprovalCommand = false;
    session.planOnly = false;
    session.discussionMode = false;
    session.terminalPhase = 'executing';
    if (session._attentionState?.kind === 'planReady') {
      session._attentionState = null;
      session._patternAttentionNeeded = false;
      session.onAttentionCleared?.();
    }
    emitPermissionModeState(session);
    return permissionModeSnapshot(session);
  } catch (err) {
    if (session.permissionMode !== state) return permissionModeSnapshot(session);
    return fail(err);
  }
}

// (TPT443) What a client needs to render the watchdog-paused banner — never the signal
// target set or the notice text. null while the session is not paused.
function pausedSummary(session) {
  const p = session && session._pause;
  if (!p) return null;
  return { at: p.at, reason: p.reason, count: p.count, threshold: p.threshold, rssMb: p.rssMb || 0, limitMb: p.limitMb || 0 };
}

function emitTerminalNotice(session, text, { retain = false } = {}) {
  const data = `\r\n\x1b[90m[Task App] ${text}\x1b[0m\r\n`;
  if (retain) session.buffer = (session.buffer || '') + data;
  if (session.ws && session.ws.readyState === session.ws.OPEN) {
    session.ws.send(JSON.stringify({
      type: 'data',
      tabId: session.tabId,
      data,
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

// (TPT9002) The project's UI language, for the text this file writes into the PTY stream. Read
// live from the account-scoped settings mirror, so a Settings change
// applies to the next notice without a restart; anything unreadable → 'en'. The same lookup
// serves the watchdog sweep (index.js passes it as `resolveLocale`).
function sessionLocale(session) {
  const root = (session && session.projectPath) || config.PROJECT_ROOT;
  if (!root) return 'en';
  try {
    return normalizeLocale(require('./project-config').readProjectLanguage(root));
  } catch {
    return 'en';
  }
}

function sessionCopy(session, key, params) {
  return terminalCopy(sessionLocale(session), key, params);
}

// Keyed twins of emitTerminalNotice()/emitTerminalWarning(): `key` names a terminal-copy.js
// entry, rendered in the session's project language.
function noticeCopy(session, key, params, options) {
  emitTerminalNotice(session, sessionCopy(session, key, params), options);
}

function warningCopy(session, key, params) {
  emitTerminalWarning(session, sessionCopy(session, key, params));
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
function buildTokenExpiryNotice({ expMs, now = Date.now(), saved, headersHelper, locale = 'en' }) {
  const when = formatTokenExpiry(expMs, now);
  const copy = (key, params) => terminalCopy(locale, key, params);
  const head = copy(now >= expMs ? 'notice.token.headExpired' : 'notice.token.headExpires', { when });
  if (saved && headersHelper) {
    return { warn: false, text: copy('notice.token.savedReconnect', { head }) };
  }
  if (saved) {
    return { warn: true, text: copy('notice.token.savedRestart', { head, when }) };
  }
  return { warn: true, text: copy('notice.token.notSaved', { head }) };
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
  const { warn, text } = buildTokenExpiryNotice({ expMs, saved, headersHelper, locale: sessionLocale(session) });
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
// (TPT9002) `display: true` picks the project-language text the console modal shows; the default
// is the English text the resolution comment is written with (identical for an English project).
function exitReasonFields(session, { display = false } = {}) {
  const r = session && session._exitReason;
  return r ? { reason: r.kind, reasonText: display ? (r.display || r.text) : r.text } : {};
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
    ...exitReasonFields(session, { display: true }),
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
// (TPT9002) The kill sentence in one language. `summary` is the process breakdown already built
// for that language (summarizeDescendants(…, locale)).
function buildKillText(locale, { reason, count, rssMb, threshold, limitMb, policy = {}, summary }) {
  const text = terminalCopy(locale, 'watchdog.killed', {
    reason: describeRunawayReason(reason, locale),
    tree: describeTree(count, rssMb, locale),
    policy: describeActPolicy(threshold, { limitMb, ...policy, locale }),
  });
  return summary ? `${text} ${terminalCopy(locale, 'watchdog.topProcesses', { summary })}` : text;
}

function killRunawaySession(session, { count, threshold, rssMb = 0, limitMb = 0, reason, snapshot, summary, summaryLocal, locale: localeOpt, policy = {} } = {}) {
  if (!session || !session.alive || !session.ptyPid) return null;
  const first = !session._exitReason;
  const byMemory = reason?.startsWith('memory');
  // (TPT9002) `text` stays English for the exit resolution comment; `display` is the same
  // sentence in the project language — the buffer, the live notice, the exit frame and the
  // session-runaway prompt all show that one.
  const text = buildKillText('en', { reason, count, rssMb, threshold, limitMb, policy, summary });
  const locale = typeof localeOpt === 'string' ? localeOpt : sessionLocale(session);
  const display = locale === 'en' ? text : buildKillText(locale, { reason, count, rssMb, threshold, limitMb, policy, summary: summaryLocal || summary });
  if (first) {
    session._exitReason = { kind: 'runaway-killed', count, threshold, text, display, ...(byMemory ? { rssMb, limitMb } : {}) };
    session.buffer += `\r\n\x1b[90m[Task App] ${display}\x1b[0m\r\n`;
    emitTerminalNotice(session, display);
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
  return { text: display, first };
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
function pauseRunawaySession(session, { count, threshold, rssMb = 0, limitMb = 0, reason, snapshot, summary, summaryLocal, locale: localeOpt, policy = {} } = {}) {
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
  // (TPT9002) Written in the project language: the buffer, the live warning and the
  // session-runaway prompt all show this text; nothing English-only reads it.
  const locale = typeof localeOpt === 'string' ? localeOpt : sessionLocale(session);
  const pausedText = terminalCopy(locale, 'watchdog.paused', {
    reason: describeRunawayReason(reason, locale),
    tree: describeTree(count, rssMb, locale),
    threshold,
    policy: describeActPolicy(threshold, { limitMb, ...policy, locale }),
  });
  const shownSummary = locale === 'en' ? summary : (summaryLocal || summary);
  const text = shownSummary ? `${pausedText} ${terminalCopy(locale, 'watchdog.topProcesses', { summary: shownSummary })}` : pausedText;
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
  const text = sessionCopy(session, 'watchdog.resumed');
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
// Codex is skipped: its client waits for replay parsing, then wobbles columns.
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
      noticeCopy(session, 'notice.approval.stalledAfterRetry', { label: agent.label });
      return;
    }
    noticeCopy(session, 'notice.approval.stalledRetrying', { label: agent.label });
    agent.retryApproval(session);
    armApprovalWatchdog(session, agent, true);
  }, ms);
  if (timer.unref) timer.unref();
  session._approvalWatchdogTimer = timer;
}

function approvePlan(session) {
  if (session.permissionMode?.pending) return;
  if (session.taskAgent === 'codex') invalidateCodexPlan(session);
  if (session._planIdleTimer) { clearTimeout(session._planIdleTimer); session._planIdleTimer = null; }
  if (session._approvalWatchdogTimer) { clearTimeout(session._approvalWatchdogTimer); session._approvalWatchdogTimer = null; }
  session.codexPlanReady = false;
  session.agentPlanReady = false;
  if (session.terminalPhase === 'executing') {
    emitTerminalState(session);
    noticeCopy(session, 'notice.plan.alreadyApproved');
    return;
  }
  const agent = getTaskAgent(session.taskAgent);
  session.terminalPhase = 'executing';
  emitTerminalState(session);
  noticeCopy(session, 'notice.plan.approved');
  agent.approvePlan(session, config);
  armApprovalWatchdog(session, agent);
}

// ── In-TUI plan approval (TPT654) ──
// The phase change approvePlan() makes, for a plan the user approved inside the agent's own TUI
// instead of through the Task App: Claude's ExitPlanMode dialog answered in the xterm (`how:
// 'dialog'`), plan mode left via shift+tab (`'mode'`), or an approval-worded line typed into
// Codex's/Pi's composer after plan-ready latched (`'typed'`) — see plan-approval-detect.js. No
// approval keystrokes are sent (the agent already has its go-ahead) and no watchdog is armed; the
// VCS context directive Codex's approvePlan() pastes is not re-sent either (the kickoff carries
// it). Without this flip the run stayed 'planning' for its whole life, so neither the idle
// completion nudge (maybeNudgeIdleSession) nor the exit backstop (flagTaskLeftUncommitted) ever
// guarded its commit requirement. Returns false (no-op) unless the session is still planning.
function markPlanApprovedInTui(session, how) {
  if (!session || session.terminalPhase !== 'planning' || session.permissionMode?.pending) return false;
  if (session.taskAgent === 'codex') invalidateCodexPlan(session);
  if (session._planIdleTimer) { clearTimeout(session._planIdleTimer); session._planIdleTimer = null; }
  session.codexPlanReady = false;
  session.agentPlanReady = false;
  if (session._attentionState?.kind === 'planReady') {
    // The announced plan is approved — the board's "plan ready for review" ring is stale.
    session._attentionState = null;
    session._patternAttentionNeeded = false;
    session.onAttentionCleared?.();
  }
  session.terminalPhase = 'executing';
  session._planApprovedInTui = how;
  emitTerminalState(session);
  noticeCopy(session, 'notice.plan.approvedInTui');
  console.log(`[terminal:${session.taskAgent}] Plan approved inside the agent's own TUI (${how}) for task ${session.tabId}`);
  return true;
}

// Claude only, called per chunk from feedAttentionChunk() with the carved rows: the collapsed
// dialog row `User approved Claude's plan` / `Exited plan mode` (answered with a Yes option) or a
// non-plan mode footer (`accept edits on` / `auto mode on`, shift+tab) ends planning; `User
// rejected Claude's plan:` (No, keep planning) and a `plan mode on` footer change nothing. Gated
// on the kickoff having been delivered so nothing painted before it can count.
function trackClaudePlanOutcome(session, lines) {
  if (session.terminalPhase !== 'planning' || session._injectDone !== true) return;
  for (const line of lines) {
    const outcome = matchClaudePlanOutcomeLine(line);
    if (outcome === 'approved') { markPlanApprovedInTui(session, 'dialog'); return; }
    if (outcome === 'execMode') { markPlanApprovedInTui(session, 'mode'); return; }
  }
}

// ── Idle completion nudge (TPT612) ──
// Same wait-quiet shape as the kickoff injector (C947) and PiAgent#_submitApproval(): wait for PTY
// silence, bracketed-paste the text, wait again, type `typedLine` when the agent refuses a
// paste-only message (Claude, TPT445), wait again, then Enter. Every step re-checks the session,
// so a Stop/Restart in between turns the rest into a no-op.
function pasteAndSubmit(session, agent, text, typedLine = '', { verify = null } = {}) {
  const quietMs = agent.getPasteSilenceMs();
  const permissionEpoch = session._permissionEpoch;
  const live = () => session.alive && session.pty && !session._terminated && session._permissionEpoch === permissionEpoch;
  const later = (fn, ms) => { const timer = setTimeout(fn, ms); if (timer.unref) timer.unref(); };
  const plain = typeof agent.wrapsBracketedPaste === 'function' && agent.wrapsBracketedPaste() === false;
  const frame = (body) => (plain ? body : `\x1b[200~${body}\x1b[201~`);
  // After a write, wait at least one silence window before checking: the echo of the write has
  // not arrived yet, so lastOutputAt alone would read as already quiet.
  const waitQuiet = (cb, afterWrite) => {
    const ceiling = Date.now() + INJECT_MAX_WAIT_MS; // a permanently noisy PTY still gets the write
    const check = () => {
      if (!live()) return;
      if (Date.now() - (session.lastOutputAt || 0) >= quietMs || Date.now() >= ceiling) { cb(); return; }
      later(check, 100);
    };
    if (afterWrite) later(check, quietMs);
    else check();
  };
  const steps = [() => session.pty.write(frame(text))];
  if (typedLine) steps.push(() => session.pty.write(typedLine));
  steps.push(() => session.pty.write('\r'));
  const run = (i) => {
    if (i >= steps.length) {
      if (verify) verifyPastedSubmission(session, agent, verify);
      return;
    }
    waitQuiet(() => { steps[i](); run(i + 1); }, i > 0);
  };
  run(0);
}

// (TPT9048) Bounded submit verification for pasteAndSubmit() callers (Windows Codex plan
// approval, idle nudges): the same stranded-text / startup-queued reading as the kickoff
// injector's checkSubmitted(), without its chip and empty-composer states. `echoRe` is the
// submission's own last words (prompt-detect.js buildComposerEchoRe()). Never Enters into a
// dialog, never while the TUI reports the submission queued behind startup, and stops once a
// turn is running or the retry budget is spent. Timers are unref'd and every step re-checks
// liveness, so a Stop/Restart turns the rest into a no-op.
function verifyPastedSubmission(session, agent, { echoRe, label = 'submission' }) {
  if (!echoRe) return;
  const permissionEpoch = session._permissionEpoch;
  const live = () => session.alive && session.pty && !session._terminated && session._permissionEpoch === permissionEpoch;
  const later = (fn, ms) => { const timer = setTimeout(fn, ms); if (timer.unref) timer.unref(); };
  let retries = 0;
  let startupWaitSeenAt = 0;
  let startupWaitClearedAt = 0;
  let watchUntil = Date.now() + SUBMIT_WATCH_MS;
  const check = () => {
    if (!live()) return;
    const tail = session._attentionTail || '';
    const now = Date.now();
    if (unsentPasteVisible(agent.getStartupWaitRe(), tail)) {
      if (!startupWaitSeenAt) startupWaitSeenAt = now;
      watchUntil = Math.max(watchUntil, startupWaitSeenAt + SUBMIT_STARTUP_WAIT_MAX_MS);
      if (now < watchUntil) later(check, SUBMIT_POLL_MS);
      return;
    }
    if (!kickoffEchoStranded(echoRe, tail)) return;             // accepted (or buried)
    if (now >= watchUntil) return;
    if (now - (session.lastOutputAt || 0) < SUBMIT_QUIET_MS) { later(check, SUBMIT_POLL_MS); return; }
    if (startupWaitSeenAt && !startupWaitClearedAt) { startupWaitClearedAt = now; later(check, SUBMIT_QUIET_MS); return; }
    const dlg = getAttentionPromptMatch(tail, session.taskAgent, session);
    if (dlg && isInjectGateKind(dlg.kind)) { later(check, SUBMIT_POLL_MS); return; }
    if (retries >= MAX_SUBMIT_RETRIES) {
      console.log(`[terminal:${agent.id}] ${label} for task ${session.taskId} still unsent after ${retries} Enter retries; tail=${JSON.stringify(tail.slice(-160))}`);
      return;
    }
    retries++;
    console.log(`[terminal:${agent.id}] ${label} for task ${session.taskId} still on the composer row (PTY silent ${now - (session.lastOutputAt || 0)}ms) — re-sending Enter ${retries}/${MAX_SUBMIT_RETRIES}`);
    if (session._ptyTrace) session._ptyTrace.write('log', `${label}: re-sending Enter ${retries}/${MAX_SUBMIT_RETRIES}`);
    session.pty.write('\r');
    watchUntil = Date.now() + SUBMIT_WATCH_MS;
    later(check, SUBMIT_VERIFY_MS);
  };
  later(check, SUBMIT_VERIFY_MS);
}

// Called by index.js's 1s sweep while terminalIdleFallbackNeeded() holds — watcher-independent.
// Checks once per idle period (keyed on lastOutputAt) and nudges at most MAX_NUDGES times per
// session: only an executing task session whose task is still in the in-progress role. Kind
// 'commit' when, with commits on, the read-only check (completion-guard.js checkTaskCommit())
// reports a commit/merge blocker; kind 'complete' (any project, TPT650) when that check is
// verified and ready, so only the completion call is missing. A closed or blocked status, an
// unverified settings read or a failed Git read never nudge. Never throws.
async function maybeNudgeIdleSession(session, { backend = session && session.backend, projectRoot, deps = {} } = {}) {
  const nudge = require('./completion-nudge');
  if (!session || session.type !== 'terminal' || !session.alive || !session.pty || !session.taskId) return { nudged: false, reason: 'not_task_terminal' };
  if (session.terminalPhase !== 'executing' || session._injectDone !== true) return { nudged: false, reason: 'not_executing' };
  if (session._terminated || session._completionEmitted || session._pause) return { nudged: false, reason: 'inactive' };
  if (session._taskClosed) return { nudged: false, reason: 'task_closed' };
  if ((session.nudgeCount || 0) >= nudge.MAX_NUDGES) return { nudged: false, reason: 'max_nudges' };
  if (session._nudgeInFlight || session._nudgeCheckedOutputAt === session.lastOutputAt) return { nudged: false, reason: 'already_checked' };
  if (!backend) return { nudged: false, reason: 'no_backend' };
  const idleSince = session.lastOutputAt;
  session._nudgeCheckedOutputAt = idleSince;
  session._nudgeInFlight = true;
  try {
    const fetchRoles = deps.fetchStatusRoles || BaseTaskAgent.fetchStatusRoles;
    const checkCommit = deps.checkTaskCommit || require('./git-merge/completion-guard').checkTaskCommit;
    const [task, roles] = await Promise.all([backend.getTask(session.taskId), fetchRoles(backend)]);
    // Status first: a closed, blocked or reassigned task never costs a Git read.
    if (!task || task.status !== roles.in_progress) return { nudged: false, reason: 'not_in_progress' };
    const check = await checkCommit({ backend, projectRoot: projectRoot || session.projectPath || config.PROJECT_ROOT, taskId: session.taskId });
    const blockers = check && check.verified ? check.blockers : [];
    const kind = nudge.nudgeKind({
      status: task.status, roles, vcs: check && check.vcs, blockers,
      verified: !!(check && check.verified), ready: !!(check && check.ready), nudgeCount: session.nudgeCount || 0,
    });
    if (!kind) return { nudged: false, reason: 'no_nudge_needed' };
    // The agent may have resumed (or the session ended) during the async checks.
    if (!session.alive || !session.pty || session._terminated || session._taskClosed || session._completionEmitted || session.lastOutputAt !== idleSince) return { nudged: false, reason: 'resumed' };
    session.nudgeCount = (session.nudgeCount || 0) + 1;
    const agent = getTaskAgent(session.taskAgent);
    const count = `${session.nudgeCount}/${nudge.MAX_NUDGES}`;
    if (kind === 'commit') {
      console.log(`[nudge] ${session.taskId}: idle in ${task.status} with ${blockers.map(b => b.code).join(',')} — nudge ${count}`);
      noticeCopy(session, 'notice.nudge.commit', { count });
      pasteAndSubmit(session, agent, nudge.buildNudgePrompt(session.taskId, blockers, agent.id), session._nudgeTypedLine || '');
    } else {
      console.log(`[nudge] ${session.taskId}: idle in ${task.status} with completion verification ready — completion nudge ${count}`);
      noticeCopy(session, 'notice.nudge.complete', { count });
      pasteAndSubmit(session, agent, nudge.buildCompleteNudgePrompt(session.taskId, agent.id), session._nudgeTypedLine || '');
    }
    return { nudged: true, reason: 'nudged', kind };
  } catch (err) {
    console.error(`[nudge] ${session.taskId}: check failed: ${err.message}`);
    return { nudged: false, reason: 'error' };
  } finally {
    session._nudgeInFlight = false;
  }
}

// ── Exit backstop (TPT613) ──
// What the backstop needs from the run that just ended, read synchronously when the exit hook
// fires: Terminate clears alive/pty right after calling the hook, and a later run resets these
// fields, so the backstop never reads the live session.
function exitRunSnapshot(session) {
  return {
    type: session && session.type,
    taskId: session && session.taskId,
    projectPath: (session && session.projectPath) || '',
    agent: (session && session.taskAgent) || '',
    executing: !!session && session.terminalPhase === 'executing' && session._injectDone === true,
    nudgeCount: (session && session.nudgeCount) || 0,
    spawnedAt: (session && session._transcriptHint && session._transcriptHint.spawnedAt) || null,
  };
}

// Called from the shared exit hook (ws-handlers.js onSessionExit) after the auto exit comment, for
// a natural exit and for Terminate alike. A run that reached execution and left its task in the
// in-progress role, in a project with commits on, whose read-only commit check
// (completion-guard.js checkTaskCommit()) still reports a commit/merge blocker, is flagged:
// on_fire when the project's strict status list has it (no legacy fallback authorizes a status
// write), a resolution comment, and a project-scoped `task-left-uncommitted` frame. Never flagged:
// a 'completed' exit, an objective-tab close (a confirmed bulk stop), a clean commit, an unknown
// check, or a task a newer run (isSuperseded) or the user already picked up. Never throws.
async function flagTaskLeftUncommitted(run, { backend, projectRoot, reason, terminateReason, exitCode, isSuperseded, deps = {} } = {}) {
  const nudge = require('./completion-nudge');
  if (!run || run.type !== 'terminal' || !run.taskId) return { flagged: false, reason: 'not_task_terminal' };
  if (!run.executing) return { flagged: false, reason: 'not_executing' };
  if (reason === 'completed' || terminateReason === 'objective-closed') return { flagged: false, reason: 'not_abandoned' };
  if (!backend || typeof backend.getTask !== 'function' || typeof backend.createTaskComment !== 'function') return { flagged: false, reason: 'no_backend' };
  const taskId = run.taskId;
  const superseded = () => typeof isSuperseded === 'function' && isSuperseded() === true;
  try {
    const fetchRoles = deps.fetchStatusRoles || BaseTaskAgent.fetchStatusRoles;
    const checkCommit = deps.checkTaskCommit || require('./git-merge/completion-guard').checkTaskCommit;
    const websocket = deps.websocket || require('./websocket');
    const [task, roles] = await Promise.all([backend.getTask(taskId), fetchRoles(backend)]);
    // Status first: a closed, blocked or reassigned task never costs a Git read.
    if (!task || task.status !== roles.in_progress) return { flagged: false, reason: 'not_in_progress' };
    const check = await checkCommit({ backend, projectRoot: projectRoot || run.projectPath || config.PROJECT_ROOT, taskId });
    const vcs = check && check.vcs;
    const blockers = check && check.verified ? check.blockers : [];
    if (!nudge.shouldFlagExit({ status: task.status, roles, vcs, blockers })) return { flagged: false, reason: 'no_flag_needed' };
    let onFire = null;
    if (typeof backend.getStatuses === 'function') {
      try {
        const statuses = await backend.getStatuses({ refresh: true, strict: true });
        onFire = (statuses || []).find(s => s && s.name === 'on_fire') || null;
      } catch { /* unknown registry: leave the status alone */ }
    }
    // Last look before writing: a newer run, or a status the user changed meanwhile, means the
    // task is not abandoned.
    if (superseded()) return { flagged: false, reason: 'superseded' };
    const fresh = await backend.getTask(taskId);
    if (!fresh || fresh.status !== roles.in_progress) return { flagged: false, reason: 'status_changed' };
    let status = fresh.status;
    if (onFire && typeof backend.updateTask === 'function') {
      try {
        const saved = await backend.updateTask(taskId, { status: onFire.name });
        if (saved) {
          status = saved.status || onFire.name;
          websocket.emitTaskUpdated(saved, null, run.projectPath);
        }
      } catch (err) {
        console.error(`[exit-backstop] ${taskId}: status write failed: ${err.message}`);
      }
    }
    try {
      await backend.createTaskComment(taskId, nudge.buildExitBackstopComment(taskId, blockers, {
        reason, exitCode, inProgress: roles.in_progress, nudgeCount: run.nudgeCount,
        onFire: !!onFire && status === onFire.name, merge: !!(vcs && vcs.merge),
      }), 'resolution');
    } catch (err) {
      console.error(`[exit-backstop] ${taskId}: comment failed: ${err.message}`);
    }
    const eligible = nudge.uncommittedBlockers(blockers);
    if (!superseded()) {
      const exitId = `${taskId}@${run.spawnedAt || Date.now()}`;
      // (TPT664) Server-side record first: every window rebuilds its flag from it (GET /api/sessions
      // `leftUncommitted` + the connect replay), and a closed task:updated drops it by these names.
      const registry = deps.leftUncommitted || require('./left-uncommitted');
      registry.record(run.projectPath, taskId, {
        exitId, blockers: eligible, status, agent: run.agent, nudgeCount: run.nudgeCount, at: Date.now(),
        closedNames: [roles.complete, roles.canceled],
      });
      websocket.emitTaskLeftUncommitted(run.projectPath, taskId, eligible, {
        status, nudgeCount: run.nudgeCount, agent: run.agent, exitId,
      });
    }
    console.log(`[exit-backstop] ${taskId}: session ended in ${roles.in_progress} with ${eligible.map(b => b.code).join(',')} — flagged (status ${status})`);
    return { flagged: true, reason: 'flagged', blockers: eligible, status };
  } catch (err) {
    console.error(`[exit-backstop] ${taskId}: check failed: ${err.message}`);
    return { flagged: false, reason: 'error' };
  }
}

// ── Cowboy-coding chains (TPT9162) ──
// A cowboy run is a bypass run whose task has cowboyMode on, or one launchCowboyChain() started
// (spawnTerminal() opts.cowboyChain). Its PTY env carries a per-run token and the exact URL of
// POST /api/tasks/<key>/cowboy-next; local-access.js lets that token, sent as the
// x-tipatask-run-token header while the run is live, open that one route for that one task. The
// agent's start_next_tasks tool and `tt next` send it (cowboy-next-request.js, TPT9163).
const { COWBOY_TOKEN_ENV, COWBOY_URL_ENV } = require('./cowboy-next-request');

function mintCowboyToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function cowboyNextUrl(taskId) {
  return `http://${LOCAL_HOST}:${config.PORT}/api/tasks/${encodeURIComponent(taskId)}/cowboy-next`;
}

// The spawn env with this run's cowboy variables, and without any inherited from the server's
// own environment (a server started from a cowboy terminal would otherwise pass its parent's on).
function withCowboyEnv(env, session, taskId) {
  const out = { ...(env || {}) };
  delete out[COWBOY_TOKEN_ENV];
  delete out[COWBOY_URL_ENV];
  if (session.cowboyChain && session._cowboyToken) {
    out[COWBOY_TOKEN_ENV] = session._cowboyToken;
    out[COWBOY_URL_ENV] = cowboyNextUrl(taskId);
  }
  return out;
}

function sessionRoot(session) {
  return session.projectPath || config.PROJECT_ROOT;
}

function sessionTaskKey(session) {
  return session.taskId || session.tabId || null;
}

// The live task terminal of `taskKey` in this project, or null.
function findCowboyRun(sessions, projectRoot, taskKey) {
  for (const session of sessions?.values() || []) {
    if (session && session.type === 'terminal' && session.alive && sessionTaskKey(session) === taskKey
      && sessionRoot(session) === projectRoot) return session;
  }
  return null;
}

// Task keys in this project with a live, starting or queued terminal session.
function liveTerminalTaskKeys(sessions, projectRoot) {
  const keys = new Set();
  for (const session of sessions?.values() || []) {
    if (!session || session.type !== 'terminal' || sessionRoot(session) !== projectRoot) continue;
    if (session.alive || session._starting || session._launching || session._queued) {
      const key = sessionTaskKey(session);
      if (key) keys.add(key);
    }
  }
  return keys;
}

// local-access.js liveRunTokens(): { token, projectPath } of every live cowboy run of `taskKey`.
function cowboyRunTokens(sessions, taskKey) {
  const runs = [];
  for (const session of sessions?.values() || []) {
    if (session && session.type === 'terminal' && session.alive && session.cowboyChain
      && session._cowboyToken && sessionTaskKey(session) === taskKey) {
      runs.push({ token: session._cowboyToken, projectPath: session.projectPath || '' });
    }
  }
  return runs;
}

async function readProjectPermissionMode(backend) {
  try {
    const result = await backend.getEffectiveProjectSettings({ strict: true, refresh: true });
    return result?.settings?.agent_permission_mode ?? null;
  } catch { return null; }
}

// Starts the next tasks of a cowboy chain once the run of `finishedKey` has finished its task —
// POST /api/tasks/:key/cowboy-next. Refuses (reason, nothing started) unless that run is live,
// carries cowboyChain and is still confirmed in bypass, and its task — read fresh — is in the
// complete role with a stored effective mode of bypass. The picks are selectNextCowboyTasks()
// (cowboy-next.js) over a fresh read; each one starts through deps.startTask() — ws-handlers.js
// startChainedTaskSession(): the session setup, start queue and spawnTerminal() a Start uses — with
// the task's own agent, its Start kickoff, { cowboyChain: true } and its own TIPATASK_COWBOY_TOKEN.
// One decision per run: a repeat returns 'already_launched' and starts nothing. Chains of one
// project run one at a time, so two runs finishing together never start the same task.
// Returns { started, reason } (+ `previous` on a repeat); a failed task read throws and leaves the
// run free to ask again. deps: { sessions, backend, startTask, fetchStatusRoles?, websocket? }.
async function launchCowboyChain(projectRoot, finishedKey, deps = {}) {
  const { sessions, backend, startTask } = deps;
  const root = projectRoot || config.PROJECT_ROOT;
  const run = findCowboyRun(sessions, root, finishedKey);
  if (!run) return { started: [], reason: 'no_session' };
  if (!run.cowboyChain) return { started: [], reason: 'not_cowboy' };
  if (run._cowboyNext) {
    return run._cowboyNext.pending
      ? { started: [], reason: 'already_launched' }
      : { started: [], reason: 'already_launched', previous: { started: run._cowboyNext.started, reason: run._cowboyNext.reason } };
  }
  if (run.permissionPolicy?.mode !== 'bypass') return { started: [], reason: 'not_bypass' };
  run._cowboyNext = { pending: true };
  let decision = null;
  try {
    decision = await withProjectLock(`cowboy\0${root}`, async () => {
      const fetchRoles = deps.fetchStatusRoles || BaseTaskAgent.fetchStatusRoles;
      const [tasks, statusRoles, projectMode, currentUserId, finished] = await Promise.all([
        backend.getTasksUnfiltered(),
        fetchRoles(backend),
        readProjectPermissionMode(backend),
        Promise.resolve(typeof backend.getCurrentUserId === 'function' ? backend.getCurrentUserId() : null).catch(() => null),
        backend.getTask(finishedKey),
      ]);
      if (!finished || finished.status !== statusRoles.complete) return { started: [], reason: 'not_finished' };
      if (effectivePermissionMode(finished, projectMode) !== 'bypass') return { started: [], reason: 'not_bypass' };
      // The task list is cached briefly; the finished row is the fresh read.
      const rows = [finished, ...(tasks || []).filter(t => t && t.id !== finished.id)];
      const picked = selectNextCowboyTasks(finished, rows, {
        statusRoles, projectMode, currentUserId, liveTaskIds: liveTerminalTaskKeys(sessions, root),
      });
      const started = [];
      for (const task of picked.tasks) {
        let ok = false;
        try {
          ok = await startTask({
            task,
            agent: chainLaunchAgent(task),
            prompt: chainKickoffPrompt(task),
            cowboyChain: true,
            env: { [COWBOY_TOKEN_ENV]: mintCowboyToken() },
          });
        } catch (err) {
          console.warn(`[cowboy] ${finishedKey}: could not start ${task.id}: ${err.message}`);
        }
        if (ok) started.push(task.id);
      }
      const reason = started.length || !picked.tasks.length ? picked.reason : 'start_failed';
      return { started, reason, decided: true };
    });
  } finally {
    run._cowboyNext = decision && decision.decided ? { started: decision.started, reason: decision.reason } : null;
  }
  console.log(`[cowboy] ${finishedKey}: ${decision.reason} — started ${decision.started.join(', ') || 'nothing'}`);
  if (decision.started.length) {
    (deps.websocket || require('./websocket')).emitCowboyChainStarted(run.projectPath || '', { taskId: finishedKey, started: decision.started });
  }
  return { started: decision.started, reason: decision.reason };
}

// (C1444) Thin wrapper — flags the session as "starting" for the full duration of
// _spawnTerminal()'s awaited remote round-trips (KB pull, task comments, status/VCS
// settings) before pty.spawn() flips `alive`. GET /api/sessions (ws-handlers.js
// sessionListBucket()) reads this flag so the session isn't misreported as exited
// during that window. `finally` covers every throw path so a failed/canceled spawn
// never leaves the flag stuck true.
async function spawnTerminal(session, prompt, taskId, taskTags = [], opts = {}) {
  session._starting = true;
  // (TPT664) A new run of the task supersedes the exit-backstop flag everywhere — drop the server
  // registry entry and broadcast the cleared frame so every window's Finish button goes too. The
  // old run's late flagTaskLeftUncommitted() cannot re-add it: isSuperseded() sees this session.
  if (taskId && (!session.type || session.type === 'terminal')) {
    try {
      const removed = require('./left-uncommitted').clear(session.projectPath, taskId);
      if (removed) require('./websocket').emitTaskLeftUncommitted(session.projectPath, taskId, [], { cleared: true, exitId: removed.exitId });
    } catch (err) {
      console.warn(`[exit-backstop] ${taskId}: could not clear the left-uncommitted flag: ${err.message}`);
    }
  }
  try {
    return await _spawnTerminal(session, prompt, taskId, taskTags, opts);
  } catch (err) {
    session._permissionGate?.close();
    session._permissionGate = null;
    throw err;
  } finally {
    session._starting = false;
  }
}

async function _spawnTerminal(session, prompt, taskId, taskTags = [], opts = {}) {
  const permissionAgent = getTaskAgent(session.taskAgent || config.TASK_AGENT);
  noticeCopy(session, 'notice.starting', { label: permissionAgent.label }, { retain: true });
  const resolved = await resolvePermissionMode({ backend: opts.backend, task: opts.task, taskId, planOnly: session.planOnly || session.discussionMode });
  throwIfTerminated(session);
  // (TPT9162) A chain launch (launchCowboyChain()) runs only in bypass. The task's own cowboyMode
  // counts only while this run is bypass: a stored flag can outlive the mode it was set under.
  if (opts.cowboyChain === true && resolved.mode !== 'bypass') {
    throw new Error('Cowboy chain launches run only in Bypass mode.');
  }
  session.cowboyChain = resolved.mode === 'bypass' && (opts.cowboyChain === true || opts.task?.cowboyMode === true);
  session._cowboyToken = session.cowboyChain ? (opts.env?.[COWBOY_TOKEN_ENV] || mintCowboyToken()) : null;
  session._cowboyNext = null;
  // Only a fresh spawn resolves stored preferences. Live switches replace this
  // snapshot after the provider confirms enforcement and behavioral instructions.
  session.permissionPolicy = permissionAgent.buildPermissionPolicy(resolved);
  session.permissionMode = { requested: resolved.mode, confirmed: resolved.mode, pending: false, error: null };
  session._permissionEpoch = (session._permissionEpoch || 0) + 1;
  session._permissionGate?.close();
  session._permissionGate = null;
  if (session.taskAgent === 'pi' && opts.task) {
    const projectRoot = session.projectPath || config.PROJECT_ROOT;
    const images = require('./image-task');
    const entry = images.resolveImageEntry(projectRoot, opts.model, opts.task);
    if (entry) {
      if (session.permissionPolicy.enforced) throw permissionError('unsupported', { mode: resolved.mode, agent: 'pi', supportReason: 'images' });
      if (session.planOnly || session.discussionMode) {
        const { imageTaskCopy } = require('../image-task-copy.mjs');
        throw Object.assign(new Error(imageTaskCopy(sessionLocale(session), 'imageTask.error.textOnly')), { reasonCode: 'image_textOnly', reasonParams: { agent: 'pi' } });
      }
      await assertCredentialsUsable(opts.backend, { projectRoot });
      throwIfTerminated(session);
      await images.startImageTask(session, { task: opts.task, entry, backend: opts.backend, projectRoot, userDataRoot: config.USER_DATA_ROOT });
      emitTerminalState(session);
      return;
    }
  }
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
  // (TPT572) Name the CLI build behind this start whenever detection reports one (Codex: the parsed
  // `codex --version`), so a CLI upgrade that changes prompt intake is visible in the server log.
  const cliVersion = status.available && session.permissionPolicy.enforced
    ? await agent.getPermissionVersion(status) : status.detail?.version;
  if (status.available) assertPermissionSupport(session.permissionPolicy, cliVersion);
  if (cliVersion) {
    console.log(`[terminal:${agent.id}] start gate for task ${taskId}: ${agent.label} CLI ${cliVersion}`
      + `${status.detail?.bin ? ` (${status.detail.bin})` : ''} — `
      + `${status.available ? 'available' : `unavailable: ${status.reason || 'no reason'}`}`);
  }
  if (!status.available) {
    // (TPT9008) The detection code (+ its params and this agent's id) rides on the error, so
    // ws-handlers.js startFailureFrame() sends a `reason` the console modal renders in the project
    // language (terminal.error.ESTART.<reason>.<agent>); the message stays the English reason.
    throw Object.assign(new Error(status.reason || `${agent.label} is unavailable`), {
      reasonCode: status.reasonCode || null,
      reasonParams: { ...status.reasonParams, agent: agent.id },
    });
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
  // (TPT9138) Pi loads the gate in every mode, so a live switch takes effect at the next tool call.
  // Auto already required this CLI version (assertPermissionSupport); an older Pi keeps launching
  // Plan and Bypass without the gate and offers no live switch.
  if (agent.id === 'pi' && versionAtLeast(cliVersion, PI_GATE_VERSION)) {
    session._permissionGate = await createPermissionGate(session, {
      root: session.projectPath || config.PROJECT_ROOT, changed: () => emitTerminalState(session),
      attentionText: terminalCopy(sessionLocale(session), 'notice.permission.approval'),
    });
  }
  const spec = await agent.getSpawnSpec(config, finalPrompt, taskId, { taskTags, cachedTags, taskCommentsBlock, statusRoles, statusNames, vcsSettings, vcsContext, tagDescriptions, parentTaskBlock, agentLimits, projectPath: session.projectPath, model: opts.model, discovery: opts.discovery, designMode: opts.designMode, task: opts.task || null, agentSessionId, permissionPolicy: session.permissionPolicy, permissionGate: session._permissionGate, backend: opts.backend, cowboyChain: session.cowboyChain });
  throwIfTerminated(session);
  spec.env = withCowboyEnv(spec.env, session, taskId); // (TPT9162)
  const spawnedAt = Date.now(); // (TPT354) lower bound for locating this run's transcript file
  const nativePty = pty.spawn(spec.command, spec.args, {
    name: 'xterm-256color',
    cols: opts.initialCols || 120,
    rows: opts.initialRows || 40,
    cwd: spec.cwd,
    env: spec.env,
  });
  const ptyProcess = agent.wrapPty
    ? agent.wrapPty(nativePty, { spawn: pty.spawn.bind(pty), spec, session, version: cliVersion })
    : nativePty;
  if (session._terminated) {
    killSpawnedPty(ptyProcess);
    throw terminalStartCanceledError();
  }
  // (TPT9048) Optional PTY I/O trace — one wrap of pty.write() covers every input site (the
  // injector, submit verification, pasteAndSubmit(), approvePlan(), handleTerminalInput(), the
  // MCP-trust auto-answer); onData() below records the raw output. Off unless TIPATASK_PTY_TRACE is set.
  const ptyTrace = openPtyTrace({
    agentId: agent.id, taskId, spawnedAt, spec,
    cols: opts.initialCols || 120, rows: opts.initialRows || 40,
    userDataRoot: config.USER_DATA_ROOT,
  });
  if (ptyTrace) {
    const rawWrite = ptyProcess.write.bind(ptyProcess);
    ptyProcess.write = (data) => { ptyTrace.write('in', data); return rawWrite(data); };
    console.log(`[terminal:${agent.id}] PTY trace for task ${taskId}: ${ptyTrace.file}`);
  }
  session._ptyTrace = ptyTrace;

  // C1218 — auto-reindex, fired strictly AFTER the PTY is alive (never before pty.spawn,
  // never awaited) so a stale-descriptions Opus run can never add latency to task launch.
  // `void`-marked: the drop is intentional, fireAutoReindexWithBroadcast never throws.
  if (_kbAutoReindexArgs) {
    void require('./kb-auto-reindex').fireAutoReindexWithBroadcast(_kbAutoReindexArgs);
  }

  session.taskAgent = agent.id;
  session.taskAgentLabel = agent.label;
  session.taskAgentModel = spec.model || ''; // (C1118) resolved --model value, for the terminal header caption
  // (TPT9136) An agent may refine the run's policy with what it resolved at launch (Claude: the
  // text for native auto vs. the acceptEdits fallback); the mode itself never changes here.
  if (spec.permissionPolicy && spec.permissionPolicy.mode === session.permissionPolicy?.mode) {
    session.permissionPolicy = spec.permissionPolicy;
  }
  // Claude's native modes for this run (claude-live-mode.js); `expected` is the native mode the
  // app last put it in. The footer tracker and the user's own Shift+Tab start fresh per spawn.
  session._claudeNative = spec.nativePermission ? { ...spec.nativePermission, expected: spec.nativePermission.launch } : null;
  session._claudeTui = null;
  session._claudeDriving = false;
  session._userModeKeyAt = 0;
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
  session.terminalPhase = session.permissionPolicy.planning ? 'planning' : 'executing';
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
  session._typedLine = '';               // (TPT654) composer line rebuilt from typed input (plan-approval-detect.js)
  session._typedPasting = false;         // (TPT654) inside a bracketed paste split across input chunks
  session._planApprovedInTui = null;     // (TPT654) 'dialog' | 'mode' | 'typed' once markPlanApprovedInTui() fired
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
  session.nudgeCount = 0;                 // (TPT612) idle completion nudges sent this session
  session._nudgeCheckedOutputAt = null;   // (TPT612) lastOutputAt of the idle period already checked
  session._nudgeInFlight = false;
  // (TPT612) An agent that needs typed words after a paste (Claude, kickoffTypedLine) gets them for the nudge too.
  session._nudgeTypedLine = spec.kickoffTypedLine ? require('./completion-nudge').NUDGE_TYPED_LINE : '';
  console.log(`[terminal:${agent.id}] New session for task ${taskId} (pid ${ptyProcess.pid})`);

  // (TPT349) Surface the token preflight outcome, then arm the mid-session expiry watch on the
  // token the child was actually launched with (spec.env.API_TOKEN — projectEnvExtras() read).
  if (authCheck && authCheck.refreshed) {
    noticeCopy(session, 'notice.token.refreshed', { until: formatTokenExpiry(authCheck.expiresAt) });
  } else if (authCheck && authCheck.warningDetail) {
    // (TPT9002) Structured twin of `warning` — the same facts, in the project language; (TPT9008)
    // a coded refresh failure is named in that language too.
    warningCopy(session, 'notice.token.expiresNotRefreshed', {
      when: authCheck.warningDetail.when,
      error: refreshErrorCopy(sessionLocale(session), authCheck.warningDetail),
    });
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
  let firstRunPending = false;
  let mcpTrustAnswered = false;  // guards firing the auto-answer keystroke more than once per session (C1047)
  let firstRunNoticeShown = false;  // (C1219) guards the first, softer onboarding-wait notice
  let askQuestionNoticeShown = false;  // (C1272) guards the first "a question is waiting" notice
  let preludeSubmittedAt = 0;  // (C1260) dedicated clock for awaitPreludeRun's min/quiet/max wait — kept SEPARATE from injectPhaseStartAt, which the onData force-check below mutates for other reasons
  let preludeLongNoticeShown = false;  // (C1260) guards the ~5min "still running" notice
  let composerStartingNoticeShown = false;  // (TPT9048) guards the composer-ready wait notice
  // (TPT9048) The composer-ready marker is latched the moment any chunk paints it: the ready
  // status row is painted once, and ConPTY's later blank-row repaints push it out of the
  // 1024-byte tail long before the paste check runs.
  const composerReadyRe = typeof agent.getComposerReadyRe === 'function' ? agent.getComposerReadyRe() : null;
  let composerReadySeen = false;

  const clearInjectTimer = () => {
    if (session._injectTimer) { clearTimeout(session._injectTimer); session._injectTimer = null; }
  };
  const armInjectTimer = (delayMs) => {
    clearInjectTimer();
    session._injectTimer = setTimeout(onInjectSilence, delayMs);
  };
  // (TPT9048) Injector diagnostics go to the server log AND the optional PTY trace, so a
  // packaged Windows app (no console) still leaves evidence of what the kickoff did.
  const logInject = (msg) => {
    console.log(`[terminal:${agent.id}] ${msg}`);
    if (session._ptyTrace) session._ptyTrace.write('log', msg);
  };
  // (TPT364) See SUBMIT_VERIFY_MS. Everything here is guarded on the session still being live, so a
  // timer that outlives a Stop/Restart is a no-op (terminateTerminalSession() nulls pty/alive).
  let submitRetries = 0;
  let submitWatchUntil = 0;
  let pasteRetries = 0;        // (TPT571) lost-paste re-paste budget — see MAX_PASTE_RETRIES
  let pasteChipSeen = false;   // (TPT571) the agent's unsent-paste chip echoed after the paste: it landed
  let bufferLenAtEnter = 0;    // (TPT571) session.buffer length when the kickoff Enter went out
  // (TPT9048) The kickoff's own last words on the composer row (Windows Codex file handoff — no
  // chip ever appears), and the TUI's "queued behind startup" footer. See kickoffEchoStranded().
  const kickoffEchoRe = typeof agent.getKickoffEchoRe === 'function' ? agent.getKickoffEchoRe(spec) : null;
  let startupWaitSeenAt = 0;     // first time the startup footer was seen after the Enter
  let startupWaitClearedAt = 0;  // first poll that no longer saw it — one quiet window before any Enter
  // (TPT9048) Composer writes: a bracketed-paste frame unless the agent says the console never
  // delivers paste events to it (Codex on Windows), in which case the text goes in plain.
  const wrapPaste = typeof agent.wrapsBracketedPaste === 'function' && agent.wrapsBracketedPaste() === false
    ? (text) => text
    : (text) => `\x1b[200~${text}\x1b[201~`;
  const writePaste = (text) => session.pty.write(wrapPaste(text));
  const armSubmitCheck = (delayMs) => {
    clearTimeout(session._submitCheckTimer);
    session._submitCheckTimer = setTimeout(checkSubmitted, delayMs);
    if (session._submitCheckTimer.unref) session._submitCheckTimer.unref();
  };
  function checkSubmitted() {
    session._submitCheckTimer = null;
    if (!session.alive || session._terminated || !session.pty) return;
    const tail = session._attentionTail || '';
    const chipVisible = unsentPasteVisible(agent.getUnsentPasteRe(), tail);
    // (TPT571) Lost paste: the EMPTY composer is the last thing drawn (never the chip), see
    // MAX_PASTE_RETRIES. Only an agent exposing getEmptyComposerRe() (Codex) can reach this.
    // (TPT9048) A typed handoff that is still visible anywhere in the tail reached the composer
    // (the chip-less Windows twin of pasteChipSeen) — never re-paste on top of it.
    const echoVisible = !!(kickoffEchoRe && kickoffEchoRe.test(tail));
    const composerEmpty = !chipVisible && !pasteChipSeen && !echoVisible
      && unsentPasteVisible(agent.getEmptyComposerRe(), tail)
      && (session.buffer || '').length - bufferLenAtEnter <= EMPTY_COMPOSER_MAX_BYTES;
    // (TPT9048) Queued behind the TUI's startup: never Enter (pointless) and never anything else
    // (a key cancels the queue) — only wait, well past the ordinary watch window.
    const startupWait = unsentPasteVisible(agent.getStartupWaitRe(), tail);
    // (TPT9048) The kickoff text itself, stranded on the composer row with no running turn after it.
    const echoStranded = !chipVisible && !composerEmpty && kickoffEchoStranded(kickoffEchoRe, tail);
    const now = Date.now();
    if (startupWait) {
      if (!startupWaitSeenAt) {
        startupWaitSeenAt = now;
        logInject(`Submit verification: kickoff for task ${taskId} is queued behind the agent's startup — holding`);
        noticeCopy(session, 'notice.submit.waitingForStartup');
      }
      submitWatchUntil = Math.max(submitWatchUntil, startupWaitSeenAt + SUBMIT_STARTUP_WAIT_MAX_MS);
      if (now >= submitWatchUntil) {
        logInject(`Submit verification: kickoff for task ${taskId} still queued behind startup after ${SUBMIT_STARTUP_WAIT_MAX_MS}ms — giving up`);
        return;
      }
      armSubmitCheck(SUBMIT_POLL_MS);
      return;
    }
    if (!chipVisible && !composerEmpty && !echoStranded) {
      // marker gone (or buried): the prompt went in
      logInject(`Submit verification: kickoff for task ${taskId} shows no unsent marker — accepted`);
      return;
    }
    if (now >= submitWatchUntil) {
      logInject(`Submit verification: kickoff for task ${taskId} still unsent when the watch window closed — no more retries`);
      return;
    }
    if (now - (session.lastOutputAt || 0) < SUBMIT_QUIET_MS) {
      armSubmitCheck(SUBMIT_POLL_MS);                       // still animating: a turn is (about to be) running
      return;
    }
    if (startupWaitSeenAt && !startupWaitClearedAt) {
      // (TPT9048) The footer just went away: the TUI replays the queued submission itself. Give
      // that one full quiet window before judging the composer again.
      startupWaitClearedAt = now;
      armSubmitCheck(SUBMIT_QUIET_MS);
      return;
    }
    const dlg = getAttentionPromptMatch(tail, session.taskAgent, session);
    if (dlg && isInjectGateKind(dlg.kind)) {
      armSubmitCheck(SUBMIT_POLL_MS);                       // a dialog owns the input — never Enter into it
      return;
    }
    if (composerEmpty) {
      if (pasteRetries >= MAX_PASTE_RETRIES) {
        noticeCopy(session, 'notice.submit.notReachedRestart');
        return;
      }
      pasteRetries++;
      logInject(`Submit verification: kickoff for task ${taskId} never reached the composer `
        + `(PTY silent ${now - (session.lastOutputAt || 0)}ms, ${(session.buffer || '').length - bufferLenAtEnter} bytes since the Enter) `
        + `— pasting it again ${pasteRetries}/${MAX_PASTE_RETRIES}; tail=${JSON.stringify(tail.slice(-160))}`);
      noticeCopy(session, 'notice.submit.notReachedRepaste');
      // Re-enter the injector at awaitPasteAck: paste now, then the same settle -> (typed line) ->
      // Enter -> verify sequence as the first attempt. The onData handler re-arms the silence timer
      // per chunk while injectDone is false, exactly as during the original paste.
      injectDone = false;
      session._injectDone = false;
      injectPhase = 'awaitPasteAck';
      typedLineSent = false;
      writePaste(initialPrompt);
      injectPhaseStartAt = now;
      armInjectTimer(agent.getPasteSilenceMs());
      return;
    }
    // (TPT9048) Authoritative duplicate guard before any re-sent Enter: the agent's native
    // transcript for this spawn already carries the kickoff -> it was accepted, whatever the
    // screen says (a stale echo row, a repaint in flight).
    if (echoStranded && typeof agent.kickoffAccepted === 'function' && agent.kickoffAccepted(session)) {
      logInject(`Submit verification: kickoff for task ${taskId} is in the agent's transcript — accepted`);
      return;
    }
    if (submitRetries >= MAX_SUBMIT_RETRIES) {
      noticeCopy(session, 'notice.submit.typedPressEnter');
      return;
    }
    submitRetries++;
    // Server-log the state too: why the first Enter was lost is not known, and this line is the
    // evidence a future diagnosis needs (how long the PTY was silent, what the tail looked like).
    logInject(`Submit verification: kickoff for task ${taskId} still unsent after the Enter `
      + `(${echoStranded ? 'typed text on the composer row' : 'paste chip'}, PTY silent ${now - (session.lastOutputAt || 0)}ms) — re-sending Enter ${submitRetries}/${MAX_SUBMIT_RETRIES}; `
      + `tail=${JSON.stringify(tail.slice(-160))}`);
    noticeCopy(session, 'notice.submit.typedRetryEnter');
    session.pty.write('\r');
    submitWatchUntil = Date.now() + SUBMIT_WATCH_MS;
    armSubmitCheck(SUBMIT_VERIFY_MS);
  }
  function onInjectSilence() {
    if (session._permissionGate && !session._permissionGate.ready) {
      if (Date.now() - spawnedAt > 30000) {
        clearInjectTimer();
        noticeCopy(session, 'notice.permission.unavailable');
        session._permissionGate.close();
        killSpawnedPty(ptyProcess);
      } else armInjectTimer(250);
      return;
    }
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
        noticeCopy(session, 'notice.inject.mcpAutoApproved');
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
    if (dlg && dlg.kind === 'firstRun') firstRunPending = true;
    if (firstRunPending && isClaudeReplReady(session._attentionTail)) firstRunPending = false;
    if (firstRunPending) {
      if (!firstRunNoticeShown) {
        firstRunNoticeShown = true;
        noticeCopy(session, 'notice.inject.firstRunWaiting');
      }
      if (injectRetries === FIRST_RUN_LONG_WAIT_RETRIES) {
        noticeCopy(session, 'notice.inject.firstRunStillWaiting');
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
      noticeCopy(session, 'notice.inject.firstRunNotFinished');
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
        noticeCopy(session, 'notice.inject.questionWaiting');
      }
      injectRetries++;
      // Same C1047 ceiling-burn fix as the other gate branches — refresh on every deferral.
      injectPhaseStartAt = Date.now();
      if (injectRetries < MAX_ASK_QUESTION_RETRIES) {
        armInjectTimer(INJECT_DIALOG_RETRY_MS);
        return;
      }
      noticeCopy(session, 'notice.inject.questionNotSent');
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
          noticeCopy(session, 'notice.inject.mcpTrustWaiting');
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
      // (TPT9048) Composer-ready marker (Codex on Windows): the TUI paints its composer long
      // before the thread is started, and a kickoff typed into that provisional composer is
      // queued behind startup at best. Defer, refreshing injectPhaseStartAt so the onData
      // ceiling cannot force the paste; past getComposerReadyMaxMs() paste anyway and let submit
      // verification deal with it.
      if (composerReadyRe && !composerReadySeen && !composerReadyRe.test(session._attentionTail || '')) {
        if (elapsed < agent.getComposerReadyMaxMs()) {
          if (!composerStartingNoticeShown) {
            composerStartingNoticeShown = true;
            logInject(`awaitReady: composer for task ${taskId} is still starting — holding the kickoff`);
            noticeCopy(session, 'notice.inject.composerStarting');
          }
          injectPhaseStartAt = Date.now();
          armInjectTimer(INJECT_DIALOG_RETRY_MS);
          return;
        }
        logInject(`awaitReady: composer-ready marker for task ${taskId} not seen within ${agent.getComposerReadyMaxMs()}ms — pasting anyway`);
      }
      // (C1260) design mode: paste the /design prelude alone first, never fused with the
      // task prompt — a slash command fused into a multi-line paste never runs as a
      // command. No prelude -> unchanged original behavior.
      if (preludePrompt) {
        writePaste(preludePrompt);
        injectPhase = 'awaitPreludeAck';
      } else {
        writePaste(initialPrompt);
        injectPhase = 'awaitPasteAck';
        logInject(`awaitReady: kickoff for task ${taskId} pasted after ${elapsed}ms (${initialPrompt.length} chars${kickoffTypedLine ? ', typed suffix follows' : ''})`);
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
      noticeCopy(session, 'notice.inject.designRunning');
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
        writePaste(initialPrompt);
        injectPhase = 'awaitPasteAck';
        injectPhaseStartAt = now;
        armInjectTimer(agent.getPasteSilenceMs());
      };
      if (waitedMs >= PRELUDE_MAX_WAIT_MS) {
        if (gated) {
          noticeCopy(session, 'notice.inject.designDialogNotSent');
          injectDone = true;
          injectPhase = 'done';
          return;
        }
        noticeCopy(session, 'notice.inject.designTooLong');
        release();
        return;
      }
      if (shouldReleasePrelude({ waitedMs, quietMs, gated, replReady })) {
        release();
        return;
      }
      if (!preludeLongNoticeShown && waitedMs >= PRELUDE_LONG_WAIT_MS) {
        preludeLongNoticeShown = true;
        noticeCopy(session, 'notice.inject.designStillRunning');
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
        logInject(`awaitPasteAck: typed suffix for task ${taskId} written`);
        injectPhaseStartAt = Date.now();
        armInjectTimer(agent.getPasteSilenceMs());
        return;
      }
      injectDone = true;
      injectPhase = 'done';
      session.pty.write('\r');
      logInject(`awaitPasteAck: kickoff Enter for task ${taskId} written`);
      // (TPT364) Confirm the Enter actually submitted the paste — see SUBMIT_VERIFY_MS.
      // (TPT571) Also watches for the empty-composer lost-paste state, see MAX_PASTE_RETRIES.
      // (TPT9048) And for the stranded typed handoff / startup-queued states.
      submitWatchUntil = Date.now() + SUBMIT_WATCH_MS;
      bufferLenAtEnter = (session.buffer || '').length;
      if (agent.getUnsentPasteRe() || agent.getEmptyComposerRe() || kickoffEchoRe || agent.getStartupWaitRe()) armSubmitCheck(SUBMIT_VERIFY_MS);
    }
  }

  emitTerminalState(session);
  if (session.terminalPhase === 'planning' && session.planApprovalCommand) {
    noticeCopy(session, 'notice.planning.command', { command: session.planApprovalCommand });
  } else if (session.terminalPhase === 'planning') {
    noticeCopy(session, 'notice.planning.dialog');
  }

  ptyProcess.onData((data) => {
    if (ptyTrace) ptyTrace.write('out', data);
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
    if (!injectDone && composerReadyRe && !composerReadySeen && composerReadyRe.test(session._attentionTail)) {
      composerReadySeen = true; // (TPT9048) see the latch's declaration
    }
    // Tail-scoped match: feeds ONLY onInjectSilence()'s paste-injection gate (above) and the
    // plan-ready state machine below. The real-time attention signal is computed separately,
    // line-scoped, by feedAttentionChunk() — see its comment for why the two are kept apart.
    let attentionMatch = getAttentionPromptMatch(session._attentionTail, session.taskAgent, session);
    if (!injectDone && attentionMatch?.kind === 'firstRun') firstRunPending = true;
    if (firstRunPending && isClaudeReplReady(session._attentionTail)) firstRunPending = false;
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
      // (TPT571) The paste chip echoing while the paste settles proves it reached the composer —
      // the lost-paste fallback in checkSubmitted() must then never fire for this attempt.
      if (injectPhase === 'awaitPasteAck'
          && (unsentPasteVisible(agent.getUnsentPasteRe(), session._attentionTail)
              || (kickoffEchoRe && kickoffEchoRe.test(session._attentionTail || '')))) { // (TPT9048) typed handoff echoed
        pasteChipSeen = true;
      }
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
    // (TPT571) `&& injectDone`: a paste-injected kickoff (Codex now, like Claude) carries the
    // sentinel instruction itself — nothing on screen before the kickoff Enter can be a real plan.
    const planMatched = requiresExplicitPlanReadyPattern(session)
      && session.terminalPhase === 'planning'
      && injectDone
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
        if (session.alive && session.terminalPhase === 'planning' && !session._planReadySent
            && piPlanReadyIsFresh(session)
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
    session._permissionGate?.close();
    session._permissionGate = null;
    endSessionMemory(session, 'exited');
    clearInjectTimer();
    clearTimeout(session._submitCheckTimer); // (TPT364)
    if (session.taskAgent === 'codex') invalidateCodexPlan(session);
    if (session._approvalWatchdogTimer) { clearTimeout(session._approvalWatchdogTimer); session._approvalWatchdogTimer = null; }
    if (session._tokenExpiryWatch) { session._tokenExpiryWatch.cancel(); session._tokenExpiryWatch = null; } // (TPT349)
    console.log(`[terminal:${agent.id}] Process exited for task ${taskId} (code ${exitCode})`);
    if (ptyTrace) { ptyTrace.write('log', `exit code ${exitCode}`); ptyTrace.close(); }
    if (session._ptyTrace === ptyTrace) session._ptyTrace = null;
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
  if (session.permissionMode?.pending) return;
  // (TPT9136) The user's own Shift+Tab: the footer change that follows is their choice, never
  // read as the CLI refusing auto mode (claude-live-mode.js observeModeChange()).
  if (data.includes('\x1b[Z')) session._userModeKeyAt = Date.now();
  // (TPT654) Agents without a slash approval command (Codex, Pi) are approved by typing into their
  // own composer. Rebuild the typed line and, once plan-ready has latched, treat an approval-worded
  // submission as the go-ahead; any other line is plan feedback and keeps the run planning. Runs
  // before the Codex Enter block below, which resets _planReadySent.
  if (!session.planApprovalCommand && session.terminalPhase === 'planning') {
    for (const line of trackTypedLine(session, data)) {
      if ((session._planReadySent || session.agentPlanReady === true) && classifyTypedSubmission(line) === 'approve') {
        markPlanApprovedInTui(session, 'typed');
        break;
      }
    }
  }
  if (session.taskAgent === 'codex' && /[\r\n]/.test(data)) {
    invalidateCodexPlan(session);
    session._attentionTail = '';
    session._attentionLineCarry = '';
    session._attentionRowCarry = '';
  }
  // (TPT9048) A user Enter takes over the kickoff: the automatic submit retry must not follow it
  // with another Enter into whatever the user is now doing.
  if (/[\r\n]/.test(data) && session._submitCheckTimer) {
    clearTimeout(session._submitCheckTimer);
    session._submitCheckTimer = null;
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
// (TPT9002) Paste failures carry a stable `code` (+ `params`) beside the English message, so the
// console modal can render them in the project language (terminal.pasteError.* in i18n.js).
function codedError(code, message, params) {
  return Object.assign(new Error(message), { code, ...(params ? { params } : {}) });
}

const PASTE_IMAGE_MAX_MB = 12;

function saveBase64Image(projectRoot, tabId, mimeType, base64) {
  if (!imageMimeAllowed(mimeType)) throw codedError('EIMAGE_TYPE', 'Unsupported image type: ' + mimeType, { type: String(mimeType) });
  if (typeof base64 !== 'string' || !base64) throw codedError('EIMAGE_EMPTY', 'Empty image data');
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw codedError('EIMAGE_EMPTY', 'Empty image data');
  if (buf.length > PASTE_IMAGE_MAX_MB * 1024 * 1024) throw codedError('EIMAGE_TOO_LARGE', `Image too large (>${PASTE_IMAGE_MAX_MB} MB)`, { maxMb: PASTE_IMAGE_MAX_MB });
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
    noticeCopy(session, 'notice.paste.imageNotAttached');
    return;
  }
  const timer = setTimeout(() => verifyImageAttach(session, agent, localPath, deadline), IMAGE_ATTACH_VERIFY_POLL_MS);
  if (timer.unref) timer.unref();
}

function injectPastedImage(session, mimeType, dataB64) {
  if (!session || !session.alive || !session.pty) {
    throw codedError('EIMAGE_NOT_RUNNING', 'Terminal not running');
  }
  if (typeof dataB64 !== 'string' || !dataB64) {
    throw codedError('EIMAGE_MISSING', 'Missing image data');
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
  MAX_PASTE_RETRIES,
  EMPTY_COMPOSER_MAX_BYTES,
  unsentPasteVisible,
  kickoffEchoStranded,          // (TPT9048)
  KICKOFF_ECHO_TRAILING_MAX,    // (TPT9048)
  SUBMIT_STARTUP_WAIT_MAX_MS,   // (TPT9048)
  verifyPastedSubmission,       // (TPT9048)
  emitTerminalState,
  emitPermissionModeState,
  permissionModeFrame,          // (TPT9139)
  requestPermissionMode,
  emitTerminalNotice,
  emitTerminalWarning,
  sessionLocale,
  noticeCopy,
  warningCopy,
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
  resolvePermissionMode,
  fetchTaskCommentsContext,
  fetchParentTaskBlock,
  approvePlan,
  markPlanApprovedInTui,
  forceResumeRepaint,
  getAttentionPromptMatch,
  codexPlanReadyIsFresh,
  piPlanReadyIsFresh,
  CODEX_PLAN_QUIET_MS,
  getMcpTrustAutoAnswer,
  carveAttentionLines,
  feedAttentionChunk,
  requiresExplicitPlanReadyPattern,
  planReadyMinBufferLength,
  truncateBufferSafely,
  sanitizeReplayBuffer,
  replayLiveTerminal,
  imageMimeAllowed,
  saveBase64Image,
  injectPastedImage,
  pasteAndSubmit,
  maybeNudgeIdleSession,
  exitRunSnapshot,
  flagTaskLeftUncommitted,
  COWBOY_TOKEN_ENV,             // (TPT9162)
  COWBOY_URL_ENV,               // (TPT9162)
  withCowboyEnv,                // (TPT9162)
  cowboyRunTokens,              // (TPT9162)
  launchCowboyChain,            // (TPT9162)
};
