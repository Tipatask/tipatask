'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  getAttentionPromptMatch,
  codexPlanReadyIsFresh,
  CODEX_PLAN_QUIET_MS,
  handleTerminalInput,
  getMcpTrustAutoAnswer,
  sanitizeReplayBuffer,
  replayLiveTerminal,
  truncateBufferSafely,
  injectPastedImage,
  carveAttentionLines,
  feedAttentionChunk,
  stripAnsi,
  stripOscChunk,
  approvePlan,
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
  killRunawaySession,
  pauseRunawaySession,
  resumeRunawaySession,
  resumeAllRunawaySessions,
  killPausedTargets,
  buildTerminalExitFrame,
  exitReasonFields,
  spawnTerminal,
  fetchTaskCommentsContext,
  unsentPasteVisible,
  SUBMIT_VERIFY_MS,
  SUBMIT_QUIET_MS,
  SUBMIT_WATCH_MS,
  SUBMIT_STARTUP_WAIT_MAX_MS,  // (TPT9048)
  SUBMIT_MARKER_TRAILING_MAX,
  MAX_SUBMIT_RETRIES,
  MAX_PASTE_RETRIES,
  pasteAndSubmit,
  maybeNudgeIdleSession,
  exitRunSnapshot,
  flagTaskLeftUncommitted,
  markPlanApprovedInTui,
} = require('./terminal-session');
const { parsePsOutput, sweepDescendantWatchdog } = require('./process-group');
const config = require('./config');
const { getTaskAgent } = require('./task-agent');
const BaseTaskAgent = require('./task-agent/base-agent');
const { reflowChunk } = require('./screen-reflow');
const { createSession } = require('./session-state');
const { buildExitResolutionComment } = require('./exit-resolution');
const nodePty = require('node-pty');

// 1x1 transparent PNG — enough to pass saveBase64Image's MIME/size checks.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function cleanupTaskImage(localPath) {
  if (!localPath) return;
  try { fs.unlinkSync(localPath); } catch { /* already gone */ }
  try { fs.rmdirSync(path.dirname(localPath)); } catch { /* not empty / already gone */ }
}

// C1247: injectPastedImage now resolves its save dir via attachment-paths.js's
// resolveAttachmentDir(), which prefers <projectPath>/.tipatask/images/ when the project is
// configured (a real .tipatask/config.json on disk — content is never read, only existence
// checked). Build a throwaway one per test so paste-image tests never fall through to
// config.PROJECT_ROOT, which in this dev checkout IS the real Tipatask repo root.
function makeConfiguredProjectDir(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), '{}');
  return root;
}

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';

test('live reconnect replays one snapshot before subsequent output without modifying retained history', () => {
  for (const agent of ['codex', 'claude', 'pi']) {
    const frames = [];
    const ws = { OPEN: 1, readyState: 1, send: raw => frames.push(JSON.parse(raw)) };
    const session = { alive: true, ws, taskAgent: agent, tabId: 'reconnect', buffer: 'History once\r\n' };
    assert.equal(replayLiveTerminal(session), true);
    assert.deepEqual(frames, [{ type: 'data', tabId: 'reconnect',
      data: '\x1b[!p\x1b[?1049l\x1b[2J\x1b[HHistory once\r\n' }]);
    assert.equal(session.buffer, 'History once\r\n');
    // The next PTY event uses the same socket and only contributes new bytes.
    const next = 'Live once\r\n';
    session.buffer += next;
    ws.send(JSON.stringify({ type: 'data', tabId: session.tabId, data: next }));
    assert.equal(frames.length, 2);
    assert.equal(frames.map(frame => frame.data).join('').match(/History once/g).length, 1);
    assert.equal(frames[1].data, next);
  }
});

test('live replay provides an empty-buffer barrier and preserves only a fresh Codex plan frame', () => {
  const frames = [];
  const ws = { OPEN: 1, readyState: 1, send: raw => frames.push(JSON.parse(raw)) };
  const session = { alive: true, ws, tabId: 'reconnect', buffer: '' };
  assert.equal(replayLiveTerminal(session), true);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, '\x1b[!p\x1b[?1049l\x1b[2J\x1b[H');
  Object.assign(session, { taskAgent: 'codex', terminalPhase: 'planning', codexPlanReady: true,
    _codexPlan: { ready: true }, buffer: `${ALT_ON}Plan ready.\r\n${ALT_OFF}Initial screen` });
  replayLiveTerminal(session);
  assert.ok(frames.at(-1).data.endsWith(`${ALT_ON}Plan ready.\r\n`));
  assert.ok(session.buffer.endsWith('Initial screen'), 'replay sanitization never changes stored bytes');
  session._codexPlan.ready = false;
  replayLiveTerminal(session);
  assert.ok(frames.at(-1).data.endsWith(session.buffer));
  session.alive = false;
  assert.equal(replayLiveTerminal(session), false);
  session.alive = true;
  ws.readyState = 3;
  assert.equal(replayLiveTerminal(session), false);
  assert.equal(frames.length, 3);
});

test('truncateBufferSafely trims trailing alt-screen exit after captured plan content', () => {
  const replayTail = [
    'discarded prompt output\n',
    ALT_ON,
    'Implementation plan\n',
    'Plan ready.\n',
    ALT_OFF,
    '\r\nInitial screen\n',
  ].join('');

  const result = truncateBufferSafely('old output\n'.repeat(50) + replayTail, replayTail.length);
  const replayReset = '\x1b[!p\x1b[?1049l\x1b[2J\x1b[H';
  const replayAltOffCount = (replayReset + result).match(/\x1b\[\?1049l/g)?.length || 0;

  assert.equal(result, `${ALT_ON}Implementation plan\nPlan ready.\n`);
  assert.doesNotMatch(result, /\x1b\[\?1049l/);
  assert.doesNotMatch(result, /Initial screen/);
  assert.equal(replayAltOffCount, 1);
});

test('sanitizeReplayBuffer trims Codex plan alt-screen exit below scrollback cap', () => {
  const buffer = [
    'normal startup\n',
    ALT_ON,
    'Implementation plan\n',
    'Plan ready.\n',
    ALT_OFF,
    '\x1b[2J\x1b[HInitial screen\n',
  ].join('');

  const result = sanitizeReplayBuffer(buffer, { preserveAltScreenFrame: true });
  const replayReset = '\x1b[!p\x1b[?1049l\x1b[2J\x1b[H';
  const replayAltOffCount = (replayReset + result).match(/\x1b\[\?1049l/g)?.length || 0;

  assert.equal(result, `${ALT_ON}Implementation plan\nPlan ready.\n`);
  assert.doesNotMatch(result, /Initial screen/);
  assert.equal(replayAltOffCount, 1);
});

test('sanitizeReplayBuffer leaves replay unchanged when alt-screen preservation is disabled', () => {
  const buffer = `${ALT_ON}Plan\n${ALT_OFF}Back on normal screen\n`;

  assert.equal(sanitizeReplayBuffer(buffer), buffer);
});

test('truncateBufferSafely keeps alt-screen entry when no exit follows it', () => {
  const replayTail = `main screen\n${ALT_ON}Plan still visible\n`;
  const result = truncateBufferSafely('old output\n'.repeat(50) + replayTail, replayTail.length);

  assert.equal(result, `${ALT_ON}Plan still visible\n`);
});

test('truncateBufferSafely still anchors on alt-screen exit when entry rolled off', () => {
  const replayTail = `main screen\n${ALT_OFF}After exit\n`;
  const result = truncateBufferSafely('old output\n'.repeat(50) + replayTail, replayTail.length);

  assert.equal(result, `${ALT_OFF}After exit\n`);
});

test('truncateBufferSafely falls back to clear-screen anchor', () => {
  const replayTail = 'old frame\n\x1b[2J\x1b[Hfresh frame\n';
  const result = truncateBufferSafely('old output\n'.repeat(50) + replayTail, replayTail.length);

  assert.equal(result, '\x1b[2J\x1b[Hfresh frame\n');
});

test('Codex MCP approval prompt is classified as toolApproval', () => {
  const prompt = [
    'Tool call needs your approval',
    'mcp tool: mcp__tipatask__get_task',
    'Would you like to allow this tool to run?',
  ].join('\n');

  assert.deepEqual(getAttentionPromptMatch(prompt, 'codex'), { kind: 'toolApproval' });
});

test('Codex MCP approval wins over plan-ready wording in same tail', () => {
  const prompt = [
    'Implementation plan',
    'Tool call needs your approval',
    'Allow mcp__tipatask__update_task to run tool?',
  ].join('\n');

  assert.deepEqual(getAttentionPromptMatch(prompt, 'codex'), { kind: 'toolApproval' });
});

test('Codex plan completion output is classified as planReady', () => {
  const prompt = [
    'Implementation plan',
    '1. Update terminal attention detection.',
    'Plan ready.',
  ].join('\n');

  assert.deepEqual(getAttentionPromptMatch(prompt, 'codex'), { kind: 'planReady' });
});

test('Claude MCP trust dialog is classified as mcpTrust', () => {
  const dialog = [
    'New MCP server found in .mcp.json: tipatask',
    'Do you want to enable it?',
    '❯ 1. Use this MCP server',
    '  2. Skip',
  ].join('\n');

  assert.deepEqual(getAttentionPromptMatch(dialog, 'claude'), { kind: 'mcpTrust' });
});

test('Claude MCP trust dialog with "do you trust" wording is classified as mcpTrust', () => {
  const dialog = 'Do you trust the MCP server "tipatask" configured in .mcp.json? [y/n]';

  assert.deepEqual(getAttentionPromptMatch(dialog, 'claude'), { kind: 'mcpTrust' });
});

test('Claude numbered menu without MCP wording stays generic attention', () => {
  const dialog = '❯ 1. Yes\n  2. No';

  assert.deepEqual(getAttentionPromptMatch(dialog, 'claude'), { kind: 'attention' });
});

test('mcpTrust is ignored for non-claude agents', () => {
  const dialog = 'New MCP server found: tipatask\nDo you trust it?';

  // codex should not classify this as mcpTrust (patterns are claude-scoped)
  const match = getAttentionPromptMatch(dialog, 'codex');
  assert.ok(match === null || match.kind !== 'mcpTrust',
    `expected null or non-mcpTrust for codex, got ${JSON.stringify(match)}`);
});

// ── getMcpTrustAutoAnswer (C1047) ──

test('getMcpTrustAutoAnswer picks "all future" option over "this session only"', () => {
  const dialog = [
    'New MCP server found in this project: tipatask',
    '  1. Use this MCP server',
    '❯ 2. Use this and all future MCP servers in this project',
    '  3. Continue without using this MCP server',
  ].join('\n');

  assert.equal(getMcpTrustAutoAnswer(dialog), '2');
});

test('getMcpTrustAutoAnswer falls back to "use this MCP server" in the 2-option dialog', () => {
  // Same fixture the mcpTrust classification test above uses — option 2 here is "Skip",
  // so the auto-answer must pick 1, never a hardcoded 2.
  const dialog = [
    'New MCP server found in .mcp.json: tipatask',
    'Do you want to enable it?',
    '❯ 1. Use this MCP server',
    '  2. Skip',
  ].join('\n');

  assert.equal(getMcpTrustAutoAnswer(dialog), '1');
});

test('getMcpTrustAutoAnswer tolerates box-drawing borders around option lines', () => {
  const dialog = [
    '╭─────────────────────────────────────────────╮',
    '│ New MCP server found in this project:        │',
    '│ tipatask                                     │',
    '│   1. Use this MCP server                     │',
    '│ ❯ 2. Use this and all future MCP servers     │',
    '│   3. Continue without using this MCP server  │',
    '╰─────────────────────────────────────────────╯',
  ].join('\n');

  assert.equal(getMcpTrustAutoAnswer(dialog), '2');
});

test('getMcpTrustAutoAnswer never selects "continue without using this MCP server"', () => {
  const dialog = [
    '❯ 3. Continue without using this MCP server',
    '  1. Use this MCP server',
  ].join('\n');

  assert.equal(getMcpTrustAutoAnswer(dialog), '1');
});

test('getMcpTrustAutoAnswer returns null for the unrelated folder-trust dialog', () => {
  const dialog = [
    'Do you trust the files in this folder?',
    '❯ 1. Yes, proceed',
    '  2. No, exit',
  ].join('\n');

  assert.equal(getMcpTrustAutoAnswer(dialog), null);
});

test('getMcpTrustAutoAnswer returns null for a generic numbered menu with no MCP wording', () => {
  assert.equal(getMcpTrustAutoAnswer('❯ 1. Yes\n  2. No'), null);
});

test('getMcpTrustAutoAnswer returns null for empty/missing input', () => {
  assert.equal(getMcpTrustAutoAnswer(''), null);
  assert.equal(getMcpTrustAutoAnswer(undefined), null);
});

// (C1219) Companion to the folder-trust test above: the installed claude 2.1.241 CLI reworded
// the workspace-trust dialog away from "Do you trust the files in this folder?" entirely — the
// literal string no longer exists in the shipping binary (confirmed via a `strings` dump). The
// dialog is now classified 'firstRun' (see below), never 'mcpTrust', so this guards the SAME
// invariant the pre-2.1.24x test above pins, against the current wording.
test('getMcpTrustAutoAnswer returns null for the reworded (2.1.241) workspace-trust dialog', () => {
  const dialog = [
    'Accessing workspace: /Users/me/projects/new-repo',
    'Quick safety check: Is this a project you created or one you trust?',
    '❯ 1. Yes, I trust this folder',
    '  2. No, continue without these permissions',
    '  3. No, exit',
  ].join('\n');

  assert.equal(getMcpTrustAutoAnswer(dialog), null);
});

// ── C1219: Claude first-run / onboarding / workspace-trust gate ──
// getAttentionPromptMatch() is the tail-scoped consumer CLAUDE_FIRST_RUN_PATTERNS actually
// feeds (via buildLegacyPatternTable()) — these exercise it directly, glued (no '\n', mirroring
// how a cursor-addressed onboarding screen actually arrives in session._attentionTail).

test('getAttentionPromptMatch classifies the 2.1.241 workspace-trust dialog as firstRun, not null — regression guard for the reworded dialog going ungated', () => {
  const tail = 'Accessing workspace:Quick safety check: Is this a project you created or one you trust? ❯ 1. Yes, I trust this folder';
  assert.deepEqual(getAttentionPromptMatch(tail, 'claude'), { kind: 'firstRun' });
});

test('getAttentionPromptMatch classifies the full onboarding chain (theme/login/security/terminal-setup/managed-settings) as firstRun', () => {
  const screens = [
    "Choose the text style that looks best with your terminal To change this later, run /theme",
    'Select login method: ❯ 1. Claude account with subscription Pro, Max, Team, or Enterprise',
    "Security notes: You're responsible for Claude's actions and should always review them",
    "Use Claude Code's terminal setup? ❯ 1. Yes, use recommended settings",
    'Managed settings require approval ❯ 1. Yes, I trust these settings',
  ];
  for (const s of screens) {
    assert.deepEqual(getAttentionPromptMatch(s, 'claude'), { kind: 'firstRun' }, `expected firstRun for ${JSON.stringify(s)}`);
  }
});

test('getAttentionPromptMatch: mcpTrust wins over firstRun on a tail holding both — the C1047 auto-answer must never be shadowed by a stale onboarding match', () => {
  const tail = "Yes, I trust this folder New MCP server found in this project: tipatask ❯ 2. Use this and all future MCP servers";
  assert.deepEqual(getAttentionPromptMatch(tail, 'claude'), { kind: 'mcpTrust' });
});

// ── Legacy tail table regression guards (C1057) ──
// buildLegacyPatternTable() must preserve getAttentionPromptMatch()'s behavior for every
// pattern that existed before this task (the tests above already prove that) AND must not
// resurrect the three patterns removed as dead/inverted for the installed CLI version.

test('getAttentionPromptMatch regression: dead/inverted legacy patterns no longer match', () => {
  assert.equal(getAttentionPromptMatch('Ready to code?', 'claude'), null);
  assert.equal(getAttentionPromptMatch('esc to interrupt', 'claude'), null);
  assert.equal(getAttentionPromptMatch('Press enter to submit', 'claude'), null);
});

// ── carveAttentionLines / feedAttentionChunk — real-time attention signal (C1057) ──

function makeAttentionSession() {
  const events = [];
  return {
    session: {
      _attentionLineCarry: '',
      _attentionState: null,
      onAttentionNeeded: (detail) => events.push({ type: 'raise', ...detail }),
      onAttentionCleared: () => events.push({ type: 'clear' }),
    },
    events,
  };
}

test('carveAttentionLines carries a partial line across chunks and completes it', () => {
  const session = { _attentionLineCarry: '' };
  const first = carveAttentionLines(session, 'Do you want to proc');
  assert.deepEqual(first, ['Do you want to proc']); // provisional carry line
  assert.equal(session._attentionLineCarry, 'Do you want to proc');
  const second = carveAttentionLines(session, 'eed?\n');
  assert.deepEqual(second, ['Do you want to proceed?']);
  assert.equal(session._attentionLineCarry, '');
});

test('carveAttentionLines splits on \\r\\n, \\n, and bare \\r alike', () => {
  const session = { _attentionLineCarry: '' };
  assert.deepEqual(carveAttentionLines(session, 'a\r\nb\nc\rd'), ['a', 'b', 'c', 'd']);
});

test('carveAttentionLines caps an unterminated carry at the max length', () => {
  const session = { _attentionLineCarry: '' };
  const huge = 'x'.repeat(5000);
  carveAttentionLines(session, huge);
  assert.equal(session._attentionLineCarry.length, 4096);
});

test('feedAttentionChunk resets carry and clears state immediately on clear-screen', () => {
  const agent = getTaskAgent('claude');
  const session = { _attentionLineCarry: 'partial', _attentionState: { kind: 'attention', promptText: 'x', at: 0 } };
  const events = [];
  session.onAttentionCleared = () => events.push('clear');
  feedAttentionChunk(session, agent, '\x1b[2J', '');
  assert.equal(session._attentionLineCarry, '');
  assert.equal(session._attentionState, null);
  assert.deepEqual(events, ['clear']);
});

test('feedAttentionChunk raises once for a Claude permission dialog, ignores an identical repaint', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  // (C1059) Decorated as a real dialog row — 'do you want to ... proceed' is a dialogOnly
  // pattern now (see prompt-detect.js), so bare prose no longer matches it at all.
  const chunk = '│ Do you want to proceed? │\n';
  feedAttentionChunk(session, agent, chunk, chunk);
  feedAttentionChunk(session, agent, chunk, chunk);
  assert.equal(events.filter((e) => e.type === 'raise').length, 1);
  assert.equal(events[0].kind, 'attention');
  assert.equal(events[0].promptText, 'Do you want to proceed?');
});

test('feedAttentionChunk clears only after the redraw grace once substantive unrelated output arrives', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const chunk = '│ Do you want to proceed? │\n';
  feedAttentionChunk(session, agent, chunk, chunk, 1000);
  feedAttentionChunk(session, agent, 'working on it now\n', 'working on it now\n', 1000); // inside grace — no clear yet
  assert.notEqual(session._attentionState, null);
  feedAttentionChunk(session, agent, 'working on it now\n', 'working on it now\n', 1500); // past grace
  assert.equal(session._attentionState, null);
  assert.equal(events.filter((e) => e.type === 'clear').length, 1);
});

test('feedAttentionChunk does not clear while the dialog text is still visible in an unrelated redraw line', () => {
  // (C1060) Switched agent/fixture from the old 'Choose an option:' one (CLAUDE_GENERIC
  // dialogOnly, anchored) — the stricter leading-decoration gate (DIALOG_ROW_RE) means that
  // pattern can now never be raised via decoration at all (see prompt-detect.test.js's
  // CASES-table comment). C1236's Codex-specific wording reproduces the same shape: the
  // redraw's copy of the text is mid-sentence, so it produces no fresh hit — yet the raw text
  // is still present, so promptStillVisible() must still find it and keep state alive.
  const agent = getTaskAgent('codex');
  const { session, events } = makeAttentionSession();
  const raise = 'Codex wants to edit src/index.js\n';
  feedAttentionChunk(session, agent, raise, raise, 1000);
  assert.equal(session._attentionState.kind, 'attention');
  const redraw = 'note: Codex wants to edit src/index.js still applies\n'; // mid-sentence wording produces no fresh hit, but still contains the text
  feedAttentionChunk(session, agent, redraw, redraw, 5000);
  assert.notEqual(session._attentionState, null);
  assert.equal(events.filter((e) => e.type === 'clear').length, 0);
});

test('feedAttentionChunk raises on a raw BEL fallback signal (terminal-bell channel)', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  feedAttentionChunk(session, agent, '\x07', '');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'attention');
});

test('feedAttentionChunk regression: Claude boot banner "Ready to code?" does not raise', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const chunk = 'Welcome back!\nReady to code?\n';
  feedAttentionChunk(session, agent, chunk, chunk);
  assert.equal(events.length, 0);
});

test('feedAttentionChunk regression: a busy/spinner line does not raise', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const chunk = 'esc to interrupt\n';
  feedAttentionChunk(session, agent, chunk, chunk);
  assert.equal(events.length, 0);
});

test('feedAttentionChunk classifies a Claude MCP trust dialog as mcpTrust', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const chunk = 'New MCP server found in this project: tipatask\n';
  feedAttentionChunk(session, agent, chunk, chunk);
  assert.equal(events[0].kind, 'mcpTrust');
});

test('feedAttentionChunk classifies a Codex tool-approval line as toolApproval', () => {
  const agent = getTaskAgent('codex');
  const { session, events } = makeAttentionSession();
  const chunk = "bash -lc 'ls' needs your approval.\n";
  feedAttentionChunk(session, agent, chunk, chunk);
  assert.equal(events[0].kind, 'toolApproval');
});

test('feedAttentionChunk classifies new Codex network-access wording as generic attention, not toolApproval', () => {
  const agent = getTaskAgent('codex');
  const { session, events } = makeAttentionSession();
  const chunk = 'Do you want to approve network access to "api.example.com"\n';
  feedAttentionChunk(session, agent, chunk, chunk);
  assert.equal(events[0].kind, 'attention');
});

test('feedAttentionChunk confirms Codex "Plan ready." after its repaint settles', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const agent = getTaskAgent('codex');
  const { session, events } = makeAttentionSession();
  const chunk = 'Plan ready.\n';
  feedAttentionChunk(session, agent, chunk, chunk);
  assert.equal(events.length, 0);
  t.mock.timers.tick(CODEX_PLAN_QUIET_MS);
  assert.equal(events[0].kind, 'planReady');
});

test('feedAttentionChunk matches a prompt split across two PTY chunks', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  feedAttentionChunk(session, agent, '│ Do you want to proc', '│ Do you want to proc');
  assert.equal(events.length, 0);
  feedAttentionChunk(session, agent, 'eed? │\n', 'eed? │\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].promptText, 'Do you want to proceed?');
});

test('feedAttentionChunk sanitizes promptText: box-drawing/cursor chars stripped, length capped', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const chunk = "│ ❯ 1. Yes, and don't ask again for edits to this file │\n";
  feedAttentionChunk(session, agent, chunk, chunk);
  assert.equal(events.length, 1);
  assert.doesNotMatch(events[0].promptText, /[│❯]/);
  assert.ok(events[0].promptText.length <= 120);
});

// ── Attention re-fire regression (C1059) — reported bug: card ring flickers permanently and
// notifications never stop, because matchPromptLines()'s last-match-wins meant a single
// dialog's own Ink repaint (split across several PTY chunks) kept producing a *different*
// promptText each time, and the old code re-raised on any promptText change. See
// tt-terminal-attention-detection.md for the full analysis. ──

test('feedAttentionChunk regression: repeated redraws of one dialog, whose last-matching line varies per chunk, raise attention exactly once', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();

  // Same on-screen permission dialog. Each chunk's carved lines happen to end on a different
  // matching row purely because of Ink's repaint timing/padding (question vs. an option row),
  // and trailing box padding varies between repaints too — exactly what production sees.
  const chunkA = '│ Do you want to make this edit to config.js?   │\n│ ❯ 1. Yes                                       │\n';
  const chunkB = '│ Do you want to make this edit to config.js? │\n│   2. Yes, and always allow access to this file │\n';
  const chunkC = '│ Do you want to make this edit to config.js?│\n│ ❯ 1. Yes                                    │\n';

  let now = 1000;
  feedAttentionChunk(session, agent, chunkA, chunkA, now); now += 30;
  feedAttentionChunk(session, agent, chunkB, chunkB, now); now += 30;
  feedAttentionChunk(session, agent, chunkA, chunkA, now); now += 30; // literal repeat
  feedAttentionChunk(session, agent, chunkC, chunkC, now);

  assert.equal(events.filter((e) => e.type === 'raise').length, 1);
  assert.equal(events[0].kind, 'attention');

  // Dismissal after all that redraw noise still clears exactly once.
  const dismissEcho = 'Applying edit to config.js...\n';
  feedAttentionChunk(session, agent, dismissEcho, dismissEcho, now + 50); // inside grace — no clear yet
  assert.equal(events.filter((e) => e.type === 'clear').length, 0);
  const dismissDone = 'Edit applied successfully.\n';
  feedAttentionChunk(session, agent, dismissDone, dismissDone, now + 600); // past grace
  assert.equal(events.filter((e) => e.type === 'clear').length, 1);
});

test('feedAttentionChunk regression: a real kind change still re-raises immediately, even mid-repaint', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const permission = '│ Do you want to make this edit to config.js? │\n';
  feedAttentionChunk(session, agent, permission, permission, 1000);
  assert.equal(events.filter((e) => e.type === 'raise').length, 1);

  const trustDialog = 'New MCP server found in this project: tipatask\n';
  feedAttentionChunk(session, agent, trustDialog, trustDialog, 1010); // 10ms later — well inside grace
  assert.equal(events.filter((e) => e.type === 'raise').length, 2);
  assert.equal(events[1].kind, 'mcpTrust');
});

test('feedAttentionChunk regression: a BEL arriving mid-dialog never downgrades an active mcpTrust/toolApproval state', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const trustDialog = 'New MCP server found in this project: tipatask\n';
  feedAttentionChunk(session, agent, trustDialog, trustDialog, 1000);
  assert.equal(session._attentionState.kind, 'mcpTrust');

  feedAttentionChunk(session, agent, '\x07', '', 1010);
  assert.equal(events.filter((e) => e.type === 'raise').length, 1); // no second raise
  assert.equal(session._attentionState.kind, 'mcpTrust'); // not downgraded to generic 'attention'
});

test('feedAttentionChunk regression: a BEL-raised blank state is upgraded exactly once by a real prompt line', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  feedAttentionChunk(session, agent, '\x07', '', 1000);
  assert.equal(events.length, 1);
  assert.equal(events[0].promptText, '');

  const permission = '│ Do you want to make this edit to config.js? │\n';
  feedAttentionChunk(session, agent, permission, permission, 1010); // inside grace — upgrade bypasses it
  assert.equal(events.filter((e) => e.type === 'raise').length, 2);
  assert.equal(events[1].promptText, 'Do you want to make this edit to config.js?');

  // A further repaint of the same question does not re-fire a third time.
  feedAttentionChunk(session, agent, permission, permission, 1020);
  assert.equal(events.filter((e) => e.type === 'raise').length, 2);
});

test('feedAttentionChunk regression: clear check sanitizes the repaint line before the containment check', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const raise = '│ Do you want to run this command now? │\n';
  feedAttentionChunk(session, agent, raise, raise, 1000);
  assert.equal(session._attentionState.promptText, 'Do you want to run this command now?');

  // Ordinary tool output that happens to echo the question with irregular inter-word spacing
  // (Ink pads dialog columns differently redraw-to-redraw) — no pattern matches this line, so
  // it goes through the clear path. The RAW line does not contain state.promptText as a
  // contiguous substring (extra spaces break it); the SANITIZED line does. Must not be read
  // as "the dialog is gone".
  const echo = 'Log: Do you  want to  run this  command now? -- proceeding\n';
  feedAttentionChunk(session, agent, echo, echo, 1500); // past the redraw grace
  assert.notEqual(session._attentionState, null);
  assert.equal(events.filter((e) => e.type === 'clear').length, 0);

  // Genuinely unrelated output with no trace of the question clears normally.
  const unrelated = 'Running tests...\n';
  feedAttentionChunk(session, agent, unrelated, unrelated, 2000);
  assert.equal(session._attentionState, null);
  assert.equal(events.filter((e) => e.type === 'clear').length, 1);
});

// ── OSC/BEL false-attention regression (C1060) — reported bug: card ring flickers permanently
// and notifications never stop. Root cause: stripAnsi() strips CSI/2-char escapes but never
// stripped OSC strings (`ESC ] … BEL` or `ESC ] … ESC \`) — Claude Code emits these constantly
// (terminal title OSC 0/1/2, `OSC 9;4` progress "during long operations", OSC 8 hyperlinks, OSC
// 52 clipboard; confirmed via strings dump of the installed claude 2.1.222 binary), and their
// BEL terminator survived into both the raw chunk and cleanChunk. feedAttentionChunk() step 2
// reads any bare \x07 as the opt-in terminal-bell "needs input" signal, so every title/progress
// repaint raised attention, plain output cleared it ~400ms later, the next repaint raised it
// again — a raise/clear flap at repaint rate, and (client-side) a fresh OS notification on every
// cycle. stripOscChunk() now runs ahead of feedAttentionChunk() in production (spawnTerminal()'s
// onData handler) — these tests replicate that same two-step pipeline. ──

// (C1066) Mirrors PRODUCTION's onData wiring exactly — stripOscChunk -> stripAnsi/reflowChunk ->
// feedAttentionChunk with BOTH streams (superset matching). Every OSC/BEL regression test below
// already existed pre-C1066 and ran through the two-step (no-reflow) version of this helper;
// updating it in place means each of those tests now implicitly re-verifies that adding the
// reflow stream changes none of their outcomes — the "nothing that already works breaks" guard.
function feedRaw(session, agent, raw, now) {
  const oscFree = stripOscChunk(session, raw);
  const clean = stripAnsi(oscFree);
  const rowChunk = reflowChunk(session, oscFree);
  feedAttentionChunk(session, agent, oscFree, clean, now, rowChunk);
}

test('stripOscChunk strips a self-contained OSC string (title, BEL-terminated) to nothing', () => {
  const session = { _attentionOscOpen: false };
  const out = stripOscChunk(session, '\x1b]0;✳ Claude Code — running\x07plain text after\n');
  assert.equal(out, 'plain text after\n');
  assert.equal(session._attentionOscOpen, false);
});

test('stripOscChunk carries an OSC left open at chunk end and consumes its terminator on the next chunk', () => {
  const session = { _attentionOscOpen: false };
  const first = stripOscChunk(session, '\x1b]0;Claude Code — running long title text');
  assert.equal(first, '');
  assert.equal(session._attentionOscOpen, true);
  const second = stripOscChunk(session, ' still going\x07plain output after title\n');
  assert.equal(second, 'plain output after title\n');
  assert.equal(session._attentionOscOpen, false);
});

test('feedAttentionChunk regression: OSC title/progress/hyperlink/clipboard BEL terminators never raise attention', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const chunks = [
    '\x1b]0;✳ Claude Code — running\x07',              // terminal title (OSC 0), BEL-terminated
    '\x1b]9;4;1;50\x07',                                          // OSC 9;4 progress sequence
    '\x1b]8;;https://example.com\x07docs\x1b]8;;\x07',           // OSC 8 hyperlink, two BELs
    '\x1b]52;c;aGVsbG8=\x07',                                     // OSC 52 clipboard
  ];
  let now = 1000;
  for (const raw of chunks) { feedRaw(session, agent, raw, now); now += 50; }
  assert.equal(events.length, 0);
  assert.equal(session._attentionState, null);
});

test('feedAttentionChunk regression: an OSC string split across two PTY chunks never leaks its BEL as a bell signal', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  feedRaw(session, agent, '\x1b]0;Claude Code — running long title text', 1000);
  assert.equal(session._attentionOscOpen, true);
  feedRaw(session, agent, ' still going\x07plain output after title\n', 1050);
  assert.equal(session._attentionOscOpen, false);
  assert.equal(events.length, 0);
  assert.equal(session._attentionState, null);
});

test('feedAttentionChunk regression: a realistic normal Claude output stream (titles, box UI, numbered prose, spinner) raises nothing and never pins state', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const stream = [
    '\x1b]0;✳ Claude Code — running\x07',
    '╭────────────────╮\n',
    '│ > Reading files…           │\n',
    '╰────────────────╯\n',
    'I found 3 issues to fix:\n',
    '2. Tighten the regex anchors\n',
    '3. Add the OSC strip\n',
    'Thinking...\r',
    'Thinking..\r',
    '\x1b]9;4;1;80\x07',
    'Running tests now.\n',
    '\x1b]0;✳ Claude Code — running\x07',
  ];
  let now = 1000;
  for (const raw of stream) { feedRaw(session, agent, raw, now); now += 100; }
  assert.equal(events.filter((e) => e.type === 'raise').length, 0);
  assert.equal(session._attentionState, null);
});

test('feedAttentionChunk regression: continuous plain output after a real dialog clears well within ATTENTION_STALE_MS and never re-flaps', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const raise = '│ Do you want to make this edit to config.js? │\n';
  feedRaw(session, agent, raise, 1000);
  assert.equal(session._attentionState.kind, 'attention');
  let now = 1500; // past the 400ms redraw grace
  for (let i = 0; i < 20; i++) {
    feedRaw(session, agent, `Applying edit ${i}...\n`, now);
    now += 500;
  }
  // Cleared well before ATTENTION_STALE_MS (120000ms, index.js's reconciliation-sweep
  // stale-latch fallback) would ever need to intervene.
  assert.equal(session._attentionState, null);
  assert.equal(events.filter((e) => e.type === 'clear').length, 1);
  assert.equal(events.filter((e) => e.type === 'raise').length, 1); // no re-raise flap from the noise
});

// ── ATTENTION_PROMPT_TEXT_MIN guard (C1060) — task step 2: a short generic promptText must not
// be able to `.includes()`-match unrelated later output and pin _attentionState open forever. ──

test('feedAttentionChunk regression: a short generic promptText cannot pin _attentionState open via unrelated later text', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const raise = '[y/n]\n';
  feedAttentionChunk(session, agent, raise, raise, 1000);
  assert.equal(session._attentionState.promptText, '[y/n]');
  // Unrelated later output that happens to echo the same short substring mid-sentence — pre-
  // C1060 this kept promptStillVisible() true forever (no length floor), pinning
  // _attentionState open indefinitely even with the real dialog long gone.
  const echo = 'The changelog documents the old [y/n] flag for legacy scripts.\n';
  feedAttentionChunk(session, agent, echo, echo, 1500); // past the redraw grace
  assert.equal(session._attentionState, null);
  assert.equal(events.filter((e) => e.type === 'clear').length, 1);
});

// ── injectPastedImage (C1051) ──

test('injectPastedImage writes through the resolved agent and returns the saved path', () => {
  const projectPath = makeConfiguredProjectDir('tt-inject-ok-');
  const writes = [];
  const session = {
    tabId: 'test-inject-ok',
    alive: true,
    taskAgent: 'claude',
    projectPath,
    pty: { write: (s) => writes.push(s) },
    // Pre-seeded with the marker so the async verify step resolves on its very first
    // (synchronous) check — this test only asserts the injection call, not verify timing.
    _attentionTail: '[Image#1]',
    ws: null,
  };

  let localPath;
  try {
    localPath = injectPastedImage(session, 'image/png', TINY_PNG_B64);
    assert.ok(fs.existsSync(localPath));
    // C1247: paste images save in-tree now, not USER_DATA_ROOT/.task-images/.
    assert.strictEqual(path.dirname(localPath), path.join(projectPath, '.tipatask', 'images', 'test-inject-ok'));
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0], '\x1b[200~' + localPath + '\x1b[201~');
  } finally {
    cleanupTaskImage(localPath);
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('injectPastedImage falls back to USER_DATA_ROOT/.task-images when no project is configured', () => {
  const unconfiguredRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-inject-unconfigured-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-inject-datar-'));
  const originalProjectRoot = config.PROJECT_ROOT;
  const originalUserDataRoot = config.USER_DATA_ROOT;
  config.PROJECT_ROOT = unconfiguredRoot; // no .tipatask/config.json under here
  config.USER_DATA_ROOT = dataRoot;

  const writes = [];
  const session = {
    tabId: 'test-inject-fallback',
    alive: true,
    taskAgent: 'claude',
    // no projectPath — must fall back to config.PROJECT_ROOT, which here is unconfigured
    pty: { write: (s) => writes.push(s) },
    _attentionTail: '[Image#1]',
    ws: null,
  };

  let localPath;
  try {
    localPath = injectPastedImage(session, 'image/png', TINY_PNG_B64);
    assert.ok(fs.existsSync(localPath));
    assert.strictEqual(path.dirname(localPath), path.join(dataRoot, '.task-images', 'test-inject-fallback'));
  } finally {
    config.PROJECT_ROOT = originalProjectRoot;
    config.USER_DATA_ROOT = originalUserDataRoot;
    cleanupTaskImage(localPath);
    fs.rmSync(unconfiguredRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('injectPastedImage emits a failure notice when the attach marker never appears', (t) => {
  // Both APIs must be mocked together: verifyImageAttach's deadline check reads Date.now(),
  // which stays real (and barely advances during a synchronous test) if only setTimeout is
  // mocked — the recursive re-arm then ticks forever without ever crossing the deadline.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  const projectPath = makeConfiguredProjectDir('tt-inject-timeout-');
  const sent = [];
  const session = {
    tabId: 'test-inject-timeout',
    alive: true,
    taskAgent: 'claude',
    projectPath,
    pty: { write: () => {} },
    _attentionTail: '', // marker never shows up
    ws: { OPEN: 1, readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) },
  };

  let localPath;
  try {
    localPath = injectPastedImage(session, 'image/png', TINY_PNG_B64);
    // Advance in small steps — the verify loop re-arms its own setTimeout on every poll
    // (IMAGE_ATTACH_VERIFY_POLL_MS), so a single huge tick isn't guaranteed to cascade
    // through every re-arm depending on the mock-timer implementation's semantics.
    for (let i = 0; i < 20; i++) t.mock.timers.tick(200);

    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].data, /Image paste did not attach/);
  } finally {
    t.mock.timers.reset();
    cleanupTaskImage(localPath);
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

// ── Screen reflow (C1066) — cursor-addressed AskUserQuestion-shaped dialogs now detected ──
// Reported bug: a multi-option AskUserQuestion dialog (bold header question, a cursor-marked
// numbered option row with indented wrapped description lines, further options, no "Choose an
// option:" text) never raised attention. Root cause: claude 2.1.22x paints dialog rows via
// cursor-positioning escapes (`ESC[r;cH`) instead of '\n'-separated lines, so stripAnsi() alone
// glues an entire multi-row frame into one unmatchable mega-line — not a wrong cursor glyph (the
// installed CLI's own figures.pointer is the same '❯' already in the pattern table, and that
// exact rendered line matches the table fine on its own). See screen-reflow.js's header comment
// and tt-terminal-attention-detection.md § Screen Reflow for the full writeup.
//
// Content below is deliberately GENERIC and varies header wording / option count / wrap presence
// / separator presence across cases — this proves the fix generalizes to the render SHAPE, not
// to any one specific dialog's wording (the reported screenshot's own phrasing is intentionally
// never reproduced here).
function cursorFrame(rows) {
  return rows.map(([r, c, t]) => `\x1b[${r};${c}H${t}`).join('');
}

const CURSOR_DIALOG_CASES = [
  {
    label: '4-option, cursor-marked selection, wrapped description, trailing separator + extra row (reported shape)',
    frame: cursorFrame([
      [3, 2, 'Pick a deploy target for this release?'],
      [5, 2, '❯'], [5, 4, '1. Blue/green (Recommended)'],
      [6, 6, 'Routes traffic gradually and rolls back automatically on'],
      [7, 6, 'error spikes.'],
      [8, 4, '2. Rolling restart'],
      [9, 4, '3. Canary'],
      [10, 2, '─'.repeat(40)],
      [11, 4, '4. Chat about this'],
    ]),
    expectedPromptText: '1. Blue/green (Recommended)',
  },
  {
    label: '2-option, no wrapped description, no separator',
    frame: cursorFrame([
      [2, 2, 'Should we retry the failed deploy step automatically?'],
      [4, 2, '❯'], [4, 4, '1. Retry automatically'],
      [5, 4, '2. Leave it for me'],
    ]),
    expectedPromptText: '1. Retry automatically',
  },
  {
    label: '5-option, wrapped description under a non-selected row too',
    frame: cursorFrame([
      [2, 2, 'Which log level should new services default to?'],
      [4, 4, '1. debug'],
      [5, 2, '❯'], [5, 4, '2. info (Recommended)'],
      [6, 4, '3. warn'],
      [7, 4, '4. error'],
      [8, 6, 'Suppresses all output below error severity.'],
      [9, 4, '5. Type something.'],
    ]),
    expectedPromptText: '2. info (Recommended)',
  },
];

test('feedAttentionChunk raises {kind: attention} for cursor-addressed multi-option dialogs of varying shape (C1066)', () => {
  for (const { label, frame, expectedPromptText } of CURSOR_DIALOG_CASES) {
    const agent = getTaskAgent('claude');
    const { session, events } = makeAttentionSession();
    feedRaw(session, agent, frame, 1000);
    assert.equal(events.length, 1, `[${label}] expected exactly one raise`);
    assert.equal(events[0].kind, 'attention', `[${label}] expected kind=attention`);
    assert.equal(events[0].promptText, expectedPromptText, `[${label}] wrong promptText`);
  }
});

test('feedAttentionChunk regression: the pre-fix glued stream alone (stripAnsi, no reflow) does NOT match these frames — documents why reflow, not pattern-loosening, is the fix', () => {
  for (const { label, frame } of CURSOR_DIALOG_CASES) {
    const agent = getTaskAgent('claude');
    const session = { _attentionLineCarry: '' };
    const clean = stripAnsi(frame);
    const lines = carveAttentionLines(session, clean);
    const hit = agent.matchPromptLines(lines);
    assert.equal(hit, null, `[${label}] expected the glued legacy-only stream to NOT match`);
  }
});

test('feedAttentionChunk regression: a cursor-addressed dialog prefixed with a clear-screen op in the same chunk still raises (C1066 step-1 hardening)', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const { frame, expectedPromptText } = CURSOR_DIALOG_CASES[0];
  // Claude's alt-screen full-repaint writes ESC[2J ESC[3J ESC[H immediately followed by the
  // whole redrawn frame in the SAME PTY chunk (confirmed via a strings dump of the installed
  // claude 2.1.224 binary) — pre-C1066 step-4 this early-returned and discarded the frame
  // outright; since nothing else is written while a dialog waits, the prompt was never seen.
  const clearAndFrame = '\x1b[2J\x1b[3J' + frame;
  feedRaw(session, agent, clearAndFrame, 1000);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'attention');
  assert.equal(events[0].promptText, expectedPromptText);
});

test('feedAttentionChunk regression: legacy plain-\\n dialogs still raise identically through the full production pipeline (C1066 superset guard)', () => {
  // Not cursor-addressed at all — every pre-C1066 test in this file exercises this shape.
  // Re-run once more explicitly through feedRaw() (which now always includes the reflow stream)
  // to prove superset matching adds recall without changing this outcome.
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  const dialog = '│ Do you want to make this edit to config.js? │\n';
  feedRaw(session, agent, dialog, 1000);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'attention');
  assert.equal(events[0].promptText, 'Do you want to make this edit to config.js?');
});

// ── C1116 fixture-driven test: premature "plan ready" for Pi terminal sessions ──
// First fixture-driven test in this file (see fixtures/attention/pi-planning-phase.jsonl /
// pi-plan-ready.jsonl — recorded-PTY-output convention, C1066 precedent). Replays the SAME
// two-source pipeline onData() drives the plan-ready state machine off: the tail-scoped
// getAttentionPromptMatch() over a rolling window (where the false positive lived — the
// pre-C1116 shared PLAN_READY_SHARED_PATTERNS' unanchored /\bplan ready\b/i matched Pi's own
// echoed kickoff instruction) OR'd with feedAttentionChunk()'s line-scoped/reflow-aware return
// value (the C1116 recall guard for the new anchored PI_PLAN_READY_PATTERNS — see that file's
// comments). onData() itself isn't exported, so this reproduces its wiring at the call-site
// level using only exported building blocks, same discipline as feedRaw() above.

const ATTENTION_TAIL_WINDOW_BYTES = 1024; // mirrors terminal-session.js's own ATTENTION_WINDOW_BYTES

function loadAttentionFixture(name) {
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'attention', name), 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// (C1529) Generalized from the Pi-only replayPiPlanReady() this task's predecessor (C1116) wrote —
// same two-source union (tail-scoped getAttentionPromptMatch() OR'd with feedAttentionChunk()'s
// line-scoped/reflow-aware return value), parameterized by agent id and the kind being hunted so
// it also covers Codex's C1529 question sentinel, not just Pi's plan-ready one.
function replayAgentKind(chunks, agentId, kind, opts = {}) {
  const agent = getTaskAgent(agentId);
  const { session, events } = makeAttentionSession();
  const messages = [];
  Object.assign(session, {
    taskAgent: agentId, _attentionTail: '', terminalPhase: 'planning', alive: true,
    buffer: 'x'.repeat(501), tabId: 'replay',
    ws: { OPEN: 1, readyState: 1, send: msg => messages.push(JSON.parse(msg)) },
  });
  let saw = false;
  for (const raw of chunks) {
    const oscFree = stripOscChunk(session, raw);
    const clean = stripAnsi(oscFree);
    const rowChunk = reflowChunk(session, oscFree);
    if (/\x1b\[2J|\x1b\[\?1049[hl]/.test(raw)) session._attentionTail = '';
    session._attentionTail = (session._attentionTail + clean).slice(-ATTENTION_TAIL_WINDOW_BYTES);
    const tailKind = getAttentionPromptMatch(session._attentionTail, agentId, session)?.kind;
    const lineHit = feedAttentionChunk(session, agent, oscFree, clean, undefined, rowChunk, tailKind);
    const tailHit = getAttentionPromptMatch(session._attentionTail, agentId, session);
    if (tailHit?.kind === kind || lineHit?.kind === kind) saw = true;
    opts.tick?.(20);
  }
  opts.tick?.(CODEX_PLAN_QUIET_MS);
  saw ||= events.some(event => event.type === 'raise' && event.kind === kind);
  return opts.details ? { saw, session, events, messages } : saw;
}

function replayPiPlanReady(chunks) {
  return replayAgentKind(chunks, 'pi', 'planReady');
}

test('Codex tail classifier rejects historical readiness after a submission or Working row', () => {
  for (const suffix of ['› Review this task\n', '• Working (15s • esc to interrupt)\n']) {
    assert.equal(getAttentionPromptMatch(`Plan ready.\n${suffix}`, 'codex'), null);
  }
  assert.deepEqual(getAttentionPromptMatch('Plan ready.\n› Ask Codex to do anything\n', 'codex'), { kind: 'planReady' });
  assert.deepEqual(getAttentionPromptMatch('• Working (15s • esc to interrupt)\nPlan ready.\n', 'codex'), { kind: 'planReady' });
});

test('Codex historical plan replay raises zero events across frame and sentinel chunk boundaries', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const historical = '\x1b[2J\x1b[HPlan ready.\n› Review this task\n• Reading source files\n• Working (15s • esc to interrupt)\n› Ask Codex to do anything\n';
  const variants = [
    [historical],
    ['Plan rea', 'dy.\n', '› Review this task\n', '• Wor', 'king (15s • esc to interrupt)\n'],
    ['\x1b[2;1HPlan rea', 'dy.', '\x1b[4;1H› Review this task', '\x1b[8;1H• Working (15s • esc to interrupt)'],
    [historical, '• Working (16s • esc to interrupt)\n', historical],
    ['Plan ready.', ' for the next review, but still checking.\n'],
  ];
  for (const chunks of variants) {
    const result = replayAgentKind(chunks, 'codex', 'planReady', {
      tick: ms => t.mock.timers.tick(ms), details: true,
    });
    assert.equal(result.saw, false, JSON.stringify(chunks));
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.messages, []);
    assert.equal(codexPlanReadyIsFresh(result.session), false);
  }
});

test('Codex startup, command output, and background waits never confirm a pending plan', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const activity = [
    '• Ran npm test\n  └ (no output)\n',
    '• Running npm ci\n',
    '• Waiting for background terminal\n',
    '• Waiting for 2 background agents to finish\n',
    '  └ added 273 packages in 2s\n',
    'esc to interrupt\n',
  ];
  for (const output of activity) {
    for (const prefix of ['', 'Plan ready.\n']) {
      const { session, events, messages } = replayAgentKind([
        ...loadAttentionFixture('codex-planning-phase.jsonl'), prefix,
        output, '› Ask Codex to do anything\n',
      ], 'codex', 'planReady', { tick: ms => t.mock.timers.tick(ms), details: true });
      t.mock.timers.tick(30000);
      assert.equal(codexPlanReadyIsFresh(session), false, JSON.stringify({ prefix, output }));
      assert.ok(!events.some(event => event.kind === 'planReady'));
      assert.ok(!messages.some(message => message.type === 'plan-ready'));
    }
  }
});

test('Codex resumed work sends a state update that dismisses the open approval dialog', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const output of ['• Working (10m 16s • esc to interrupt)\n', '• Ran npm ci\n']) {
    const { session, messages } = replayAgentKind(['Plan ready.\n'], 'codex', 'planReady', {
      tick: ms => t.mock.timers.tick(ms), details: true,
    });
    assert.equal(messages[0].type, 'plan-ready');
    feedRaw(session, getTaskAgent('codex'), output);
    assert.equal(messages.at(-1).type, 'terminal-state');
    assert.equal(messages.at(-1).codexPlanReady, false);
    const count = messages.length;
    feedRaw(session, getTaskAgent('codex'), output);
    t.mock.timers.tick(30000);
    assert.equal(messages.length, count, 'continued work does not flood state updates');
  }
});

test('Codex split command repaint dismisses an announced plan even after readiness flags reset', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { session, events, messages } = replayAgentKind(['Plan ready.\n'], 'codex', 'planReady', {
    tick: ms => t.mock.timers.tick(ms), details: true,
  });
  const agent = getTaskAgent('codex');
  feedRaw(session, agent, '\x1b[2J\x1b[HPlan ready.\n');
  assert.equal(session.codexPlanReady, false);
  assert.equal(messages.length, 1, 'repaint does not flicker the existing dialog');
  feedRaw(session, agent, '\x1b[8;1H• R');
  feedRaw(session, agent, 'an npm test');
  feedRaw(session, agent, '\x1b[9;1H  └ (no output)');
  t.mock.timers.tick(30000);
  assert.deepEqual(messages.map(e => e.type), ['plan-ready', 'terminal-state']);
  assert.equal(messages[1].codexPlanReady, false);
  assert.equal(events.filter(e => e.type === 'clear').length, 1);
});

test('Codex resize replay keeps announced approval through historical submissions and status requests', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { session, messages, events } = replayAgentKind(['Plan ready.\n'], 'codex', 'planReady', {
    tick: ms => t.mock.timers.tick(ms), details: true,
  });
  const agent = getTaskAgent('codex');
  const repaint = loadAttentionFixture('codex-plan-resize.jsonl');
  for (const chunk of repaint) {
    feedRaw(session, agent, chunk);
    // A status request can interleave with any part of the repaint.
    require('./terminal-session').emitTerminalState(session);
    assert.ok(!messages.some(msg => msg.codexPlanReady === false));
    t.mock.timers.tick(20);
  }
  assert.equal(codexPlanReadyIsFresh(session), false);
  t.mock.timers.tick(CODEX_PLAN_QUIET_MS);
  assert.equal(codexPlanReadyIsFresh(session), true);
  assert.equal(messages.filter(msg => msg.type === 'plan-ready').length, 1);
  assert.equal(events.filter(event => event.type === 'clear').length, 0);
});

test('Codex incomplete repaint expires approval and explicit submission cancels it immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const submitted of [false, true]) {
    const { session, messages } = replayAgentKind(['Plan ready.\n'], 'codex', 'planReady', {
      tick: ms => t.mock.timers.tick(ms), details: true,
    });
    feedRaw(session, getTaskAgent('codex'), '\x1b[2J\x1b[H› Old request\n');
    assert.equal(messages.length, 1);
    if (submitted) {
      session.pty = { write() {} };
      handleTerminalInput(session, 'New request\r');
    } else t.mock.timers.tick(CODEX_PLAN_QUIET_MS);
    assert.equal(messages.at(-1).codexPlanReady, false);
    assert.equal(codexPlanReadyIsFresh(session), false);
  }
});

test('Codex continuous work during repaint cannot keep old approval alive', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { session, messages } = replayAgentKind(['Plan ready.\n'], 'codex', 'planReady', {
    tick: ms => t.mock.timers.tick(ms), details: true,
  });
  const agent = getTaskAgent('codex');
  feedRaw(session, agent, '\x1b[2J\x1b[H› New request\n');
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(500);
    feedRaw(session, agent, `• Working (${i}s • esc to interrupt)\n`);
  }
  assert.equal(messages.at(-1).codexPlanReady, false);
  assert.equal(codexPlanReadyIsFresh(session), false);
});

test('Codex ordinary attention never opens plan approval after a quiet interval', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const prompt of ['\x07', 'Questions ready.\n', 'Approval requested: run command\n']) {
    const { session, events, messages } = replayAgentKind([prompt], 'codex', 'attention', {
      tick: ms => t.mock.timers.tick(ms), details: true,
    });
    t.mock.timers.tick(30000);
    assert.ok(events.some(event => event.type === 'raise'));
    assert.equal(codexPlanReadyIsFresh(session), false);
    assert.deepEqual(messages, []);
  }
});

test('Codex submitted sentinel text is input, not a plan approval prompt', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const prompt of ['› Plan ready.\n', '❯ Plan ready.\n', '> Plan ready.\n']) {
    const { events, messages } = replayAgentKind([prompt], 'codex', 'planReady', {
      tick: ms => t.mock.timers.tick(ms), details: true,
    });
    assert.ok(!events.some(event => event.kind === 'planReady'));
    assert.deepEqual(messages, []);
  }
});

test('Codex genuine split readiness emits once, survives idle repaint, and expires on resumed work', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const result = replayAgentKind([
    '› Review this task\n• Working (15s • esc to interrupt)\n',
    '\x1b[7;1HPlan rea', 'dy.', '\x1b[9;1H› Ask', ' Codex to do any', 'thing\n',
  ], 'codex', 'planReady', { tick: ms => t.mock.timers.tick(ms), details: true });
  const { session, events, messages } = result;
  const agent = getTaskAgent('codex');
  assert.equal(result.saw, true);
  assert.equal(events.filter(e => e.type === 'raise').length, 1);
  assert.equal(messages.filter(e => e.type === 'plan-ready').length, 1);
  feedRaw(session, agent, '\x1b[2J\x1b[HPlan ready.\n› Ask Codex to do anything\n');
  assert.equal(codexPlanReadyIsFresh(session), false, 'reconnect waits for full repaint to settle');
  t.mock.timers.tick(CODEX_PLAN_QUIET_MS);
  assert.equal(events.filter(e => e.type === 'raise').length, 1, 'same plan repaint is deduplicated');
  assert.equal(messages.length, 1);
  feedRaw(session, agent, '• Working (1s • esc to interrupt)\n');
  assert.equal(codexPlanReadyIsFresh(session), false);
  assert.equal(session.codexPlanReady, false);
  assert.equal(session.agentPlanReady, false);
  assert.equal(session._planReadySent, false);
  assert.equal(events.filter(e => e.type === 'clear').length, 1);
  assert.equal(messages.at(-1).type, 'terminal-state');
  assert.equal(messages.at(-1).codexPlanReady, false);
  t.mock.timers.tick(20000);
  assert.equal(messages.filter(e => e.type === 'plan-ready').length, 1, 'no delayed stale event');
  feedRaw(session, agent, 'Plan ready.\n');
  t.mock.timers.tick(CODEX_PLAN_QUIET_MS);
  assert.equal(messages.filter(e => e.type === 'plan-ready').length, 2, 'a later genuine plan can be announced');
});

test('Codex submitted input cancels readiness before output, while typing does not', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { session, messages } = replayAgentKind(['Plan ready.\n'], 'codex', 'planReady', {
    tick: ms => t.mock.timers.tick(ms), details: true,
  });
  const writes = [];
  session.pty = { write: data => writes.push(data) };
  handleTerminalInput(session, 'Please revise');
  assert.equal(codexPlanReadyIsFresh(session), true);
  handleTerminalInput(session, '\r');
  assert.equal(codexPlanReadyIsFresh(session), false);
  assert.deepEqual(writes, ['Please revise', '\r']);
  t.mock.timers.tick(20000);
  assert.deepEqual(messages.map(e => e.type), ['plan-ready', 'terminal-state']);
  assert.equal(messages[1].codexPlanReady, false);
});

test('Codex pending readiness cannot hide tool approval or question attention', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const prompt of ['Approval requested: run command\n', 'Questions ready.\n']) {
    for (const chunks of [['Plan ready.\n', prompt], [prompt + 'Plan ready.\n']]) {
      const { events, messages } = replayAgentKind(chunks, 'codex', 'planReady', {
        tick: ms => t.mock.timers.tick(ms), details: true,
      });
      assert.ok(events.some(e => e.type === 'raise' && e.kind !== 'planReady'));
      assert.ok(!events.some(e => e.kind === 'planReady'));
      assert.deepEqual(messages, []);
    }
  }
  assert.deepEqual(getAttentionPromptMatch('Plan ready.\nneeds your approval\n• Working (1s • esc to interrupt)', 'codex'), { kind: 'toolApproval' });
});

test('Codex reconnect rejects stale latches, replays genuine readiness, and rechecks delayed sends', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { maybeRefirePlanReady } = require('./ws-handlers');
  const { session, messages } = replayAgentKind(['Plan ready.\n'], 'codex', 'planReady', {
    tick: ms => t.mock.timers.tick(ms), details: true,
  });
  maybeRefirePlanReady(session, session.ws);
  assert.equal(messages.length, 2, 'fresh readiness replays on reconnect');
  session._codexPlan = { ready: false };
  for (const sent of [true, false]) {
    session._planReadySent = sent;
    maybeRefirePlanReady(session, session.ws);
  }
  assert.equal(messages.length, 2, 'old booleans cannot bypass freshness');
  session._codexPlan = { ready: true };
  session.lastOutputAt = Date.now();
  maybeRefirePlanReady(session, session.ws);
  session._codexPlan = { ready: false };
  t.mock.timers.tick(CODEX_PLAN_QUIET_MS);
  assert.equal(messages.length, 2, 'timer rechecks current freshness');
});

test('C1116 regression: Pi planning-phase fixture (echoed kickoff prompt + study narration) never triggers planReady', () => {
  // This fixture directly reproduces the reported bug's trigger: the kickoff prompt Pi echoes
  // into its own TUI (containing "...write exactly the words Plan ready. — do this only..."),
  // plus study-phase narration hitting the OLD loose Codex-shared wording ("Implementation
  // plan", "Step 1: ...", "nearly ready"). None of it may raise planReady for a pi session.
  const chunks = loadAttentionFixture('pi-planning-phase.jsonl');
  assert.equal(replayPiPlanReady(chunks), false);
});

test('C1116: Pi plan-ready fixture triggers planReady once the real cursor-addressed "Plan ready." sentinel streams', () => {
  // Same planning-phase content, then a genuine standalone "Plan ready." sentinel painted via a
  // cursor-addressed row jump (ESC[r;cH) glued directly onto the prior unterminated line — the
  // shape a cursor-addressed TUI renders, same failure mode C1066 fixed for dialogs.
  const chunks = loadAttentionFixture('pi-plan-ready.jsonl');
  assert.equal(replayPiPlanReady(chunks), true);
});

test("C1116: the plan-ready fixture's sentinel is caught ONLY through feedAttentionChunk's reflow stream, not the tail-scoped legacy detector — proves recall depends on the C1116 reflow addition, not the anchored regex alone", () => {
  const chunks = loadAttentionFixture('pi-plan-ready.jsonl');
  const agent = getTaskAgent('pi');
  const session = { _attentionLineCarry: '', _attentionState: null, _attentionTail: '' };
  let tailSawPlanReady = false;
  let lineSawPlanReady = false;
  for (const raw of chunks) {
    const oscFree = stripOscChunk(session, raw);
    const clean = stripAnsi(oscFree);
    const rowChunk = reflowChunk(session, oscFree);
    session._attentionTail = ((session._attentionTail || '') + clean).slice(-ATTENTION_TAIL_WINDOW_BYTES);
    if (getAttentionPromptMatch(session._attentionTail, 'pi')?.kind === 'planReady') tailSawPlanReady = true;
    if (feedAttentionChunk(session, agent, oscFree, clean, undefined, rowChunk)?.kind === 'planReady') lineSawPlanReady = true;
  }
  assert.equal(tailSawPlanReady, false, 'the un-reflowed tail stream glues the sentinel onto the prior line, breaking the anchor — must NOT match');
  assert.equal(lineSawPlanReady, true, 'the reflow-aware line-scoped stream restores the row boundary — must match');
});

// ── C1529 fixture-driven tests: Codex's own "Questions ready." sentinel (CODEX_QUESTION_PATTERNS) ──

test('C1529 regression: Codex planning-phase fixture (echoed kickoff prompt + study narration) never triggers attention from the question pattern', () => {
  // Pre-existing corpus (predates this task) — must stay silent. Guards against the new anchored
  // pattern picking up ordinary Codex study-phase narration or its own kickoff echo.
  const chunks = loadAttentionFixture('codex-planning-phase.jsonl');
  assert.equal(replayAgentKind(chunks, 'codex', 'attention'), false);
});

test('C1529: Codex questions-ready fixture never triggers attention from the echoed kickoff/directive text, only from the real sentinel', () => {
  // Same discipline as the Pi C1116 pair above: replay only up through the echoed directive +
  // study narration + question-batch prose (everything before the genuine cursor-addressed
  // sentinel) and confirm it stays silent, then replay the full fixture and confirm it raises.
  const allChunks = loadAttentionFixture('codex-questions-ready.jsonl');
  const beforeSentinel = allChunks.slice(0, -2); // drop the two cursor-addressed sentinel chunks
  assert.equal(replayAgentKind(beforeSentinel, 'codex', 'attention'), false);
  assert.equal(replayAgentKind(allChunks, 'codex', 'attention'), true);
});

test('C1529: Codex questions-ready fixture raises the real onAttentionNeeded broadcast exactly once, with a generic attention kind', () => {
  // Unlike the two tests above (which only check feedAttentionChunk()'s/getAttentionPromptMatch()'s
  // return values), this drives the actual session.onAttentionNeeded callback — the thing that
  // fires the WS 'attention-needed' broadcast (see terminal-session.js's feedAttentionChunk() step
  // 3, index.js's broadcastAttentionFor()) — proving the card ring would actually light up, not
  // just that the pattern matches in isolation.
  const chunks = loadAttentionFixture('codex-questions-ready.jsonl');
  const agent = getTaskAgent('codex');
  const { session, events } = makeAttentionSession();
  let now = 1000;
  for (const raw of chunks) { feedRaw(session, agent, raw, now); now += 50; }
  const raises = events.filter((e) => e.type === 'raise');
  assert.equal(raises.length, 1, 'expected exactly one attention raise for the whole fixture');
  assert.equal(raises[0].kind, 'attention', 'must be generic attention, never planReady/askQuestion/toolApproval — see the HARD RULE in prompt-detect.js');
  assert.match(raises[0].promptText, /questions ready/i);
});

// ── Post-approval stall watchdog (C1117) ──
// approvePlan()'s watchdog is agent-agnostic — it only calls the four BaseTaskAgent hooks
// (getApprovalWatchdogMs/approvalStalled/retryApproval, plus the existing approvePlan). These
// tests monkeypatch the real cached 'pi' agent instance's hooks (restored in `finally`) so the
// orchestration is tested independently of PiAgent's own submission timing, which is already
// covered directly in pi-agent.test.js.

test('approvePlan(): a stalled Pi approval gets one notice + retry, then a final notice with no further retry', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const agent = getTaskAgent('pi');
  const original = {
    approvePlan: agent.approvePlan,
    getApprovalWatchdogMs: agent.getApprovalWatchdogMs,
    approvalStalled: agent.approvalStalled,
    retryApproval: agent.retryApproval,
  };
  const approveCalls = [];
  const retryCalls = [];
  const stalledVerdicts = [true, true]; // both watchdog fires report "still stalled"

  agent.approvePlan = () => { approveCalls.push('approve'); };
  agent.getApprovalWatchdogMs = () => 5000;
  agent.approvalStalled = () => stalledVerdicts.shift();
  agent.retryApproval = () => { retryCalls.push('retry'); };

  const sent = [];
  const session = {
    tabId: 'test-approve-watchdog-stalled',
    taskAgent: 'pi',
    alive: true,
    pty: { write: () => {} },
    buffer: '',
    terminalPhase: 'planning',
    ws: { OPEN: 1, readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) },
  };

  try {
    approvePlan(session);
    assert.deepStrictEqual(approveCalls, ['approve']);
    assert.ok(session._approvalWatchdogTimer, 'watchdog timer armed');

    t.mock.timers.tick(5000); // first fire: stalled -> notice + one retry, re-arms
    assert.deepStrictEqual(retryCalls, ['retry']);
    assert.ok(sent.some((f) => f.type === 'data' && /retrying once/.test(f.data)));

    t.mock.timers.tick(5000); // second fire: still stalled -> notice only, no further retry
    assert.deepStrictEqual(retryCalls, ['retry'], 'no second retry after the final check');
    assert.ok(sent.some((f) => f.type === 'data' && /still looks stalled after a retry/.test(f.data)));
  } finally {
    Object.assign(agent, original);
    t.mock.timers.reset();
  }
});

test('approvePlan(): a healthy Pi approval never triggers a stalled notice', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const agent = getTaskAgent('pi');
  const original = {
    approvePlan: agent.approvePlan,
    getApprovalWatchdogMs: agent.getApprovalWatchdogMs,
    approvalStalled: agent.approvalStalled,
    retryApproval: agent.retryApproval,
  };
  const retryCalls = [];
  agent.approvePlan = () => {};
  agent.getApprovalWatchdogMs = () => 5000;
  agent.approvalStalled = () => false; // real turn happened — never stalled
  agent.retryApproval = () => { retryCalls.push('retry'); };

  const sent = [];
  const session = {
    tabId: 'test-approve-watchdog-healthy',
    taskAgent: 'pi',
    alive: true,
    pty: { write: () => {} },
    buffer: '',
    terminalPhase: 'planning',
    ws: { OPEN: 1, readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) },
  };

  try {
    approvePlan(session);
    t.mock.timers.tick(5000);
    assert.deepStrictEqual(retryCalls, []);
    assert.ok(!sent.some((f) => f.type === 'data' && /stalled/.test(f.data)));
  } finally {
    Object.assign(agent, original);
    t.mock.timers.reset();
  }
});

test('approvePlan(): claude/codex never arm a watchdog (getApprovalWatchdogMs() defaults to 0)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    for (const taskAgent of ['claude', 'codex']) {
      const sent = [];
      const session = {
        tabId: `test-approve-watchdog-${taskAgent}`,
        taskAgent,
        alive: true,
        pty: { write: () => {} },
        buffer: '',
        terminalPhase: 'planning',
        ws: { OPEN: 1, readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) },
      };
      approvePlan(session);
      assert.ok(!session._approvalWatchdogTimer, `${taskAgent}: no watchdog timer armed`);
      t.mock.timers.tick(60000);
      assert.ok(!sent.some((f) => f.type === 'data' && /stalled/.test(f.data)), `${taskAgent}: no stalled notice ever sent`);
    }
  } finally {
    t.mock.timers.reset();
  }
});

// ── Dialog-kind-cleared transition (C1120) ──
// Closes the C1047 doc's open "Known limitation": Claude's folder-trust dialog is classified
// mcpTrust by the tail-scoped getAttentionPromptMatch() but getMcpTrustAutoAnswer() returns null
// for it (its options never mention "MCP server"), so the only pre-existing proactive
// _attentionTail reset (the auto-answer path) never runs — a manually-typed dismissal left the
// stale dialog text sitting in the rolling tail, re-blocking onInjectSilence()'s paste-injection
// gate for the full ~60s MAX_MCP_TRUST_RETRIES budget, with the eventual cap-triggered blind
// paste+Enter confirming whatever dialog option was still highlighted instead of landing the
// task prompt.

test('lineDialogLeftScreen(): true only when a line-scoped state was active, is now cleared, AND the tail is still reporting a gate kind', () => {
  // primary case: dialog left the screen (line state active -> null) while tail still stuck.
  assert.equal(lineDialogLeftScreen('attention', null, 'mcpTrust'), true);
  assert.equal(lineDialogLeftScreen('mcpTrust', null, 'mcpTrust'), true);
  assert.equal(lineDialogLeftScreen('toolApproval', null, 'toolApproval'), true);
  // (C1219) firstRun joined INJECT_GATE_KINDS — same transition, same predicate, unchanged code.
  assert.equal(lineDialogLeftScreen('attention', null, 'firstRun'), true);
  assert.equal(lineDialogLeftScreen('firstRun', null, 'firstRun'), true);
  // no prior active state -> nothing "left the screen".
  assert.equal(lineDialogLeftScreen(null, null, 'mcpTrust'), false);
  // still active (repaint, not a real clear) -> must not fire.
  assert.equal(lineDialogLeftScreen('attention', 'attention', 'mcpTrust'), false);
  assert.equal(lineDialogLeftScreen('mcpTrust', 'attention', 'mcpTrust'), false);
  // line cleared but the tail isn't reporting a gate-relevant dialog -> nothing to release.
  assert.equal(lineDialogLeftScreen('attention', null, null), false);
  assert.equal(lineDialogLeftScreen('attention', null, 'planReady'), false);
  assert.equal(lineDialogLeftScreen('attention', null, 'attention'), false);
});

test('dialogGateCleared(): true only when the PREVIOUS tail kind was itself a gate kind and it changed', () => {
  assert.equal(dialogGateCleared('mcpTrust', null), true);
  assert.equal(dialogGateCleared('mcpTrust', 'attention'), true);
  assert.equal(dialogGateCleared('toolApproval', null), true);
  // (C1219) firstRun joined INJECT_GATE_KINDS — same transition, same predicate, unchanged code.
  assert.equal(dialogGateCleared('firstRun', null), true);
  assert.equal(dialogGateCleared('firstRun', 'mcpTrust'), true);
  assert.equal(dialogGateCleared('firstRun', 'firstRun'), false);
  assert.equal(dialogGateCleared('mcpTrust', 'mcpTrust'), false);
  assert.equal(dialogGateCleared(null, null), false);
  assert.equal(dialogGateCleared('attention', null), false);
  assert.equal(dialogGateCleared('planReady', null), false);
});

// Replays a fixture through the SAME production pipeline onData() drives (stripOscChunk ->
// stripAnsi -> tail clear on \x1b[2J/alt-screen -> append+slice(-ATTENTION_WINDOW_BYTES) ->
// getAttentionPromptMatch -> reflowChunk + feedAttentionChunk -> the C1120 transition check),
// same call-site-reconstruction discipline as the C1116 replayPiPlanReady() helper above
// (onData() itself isn't exported). Drives a VIRTUAL clock (chunkMs per chunk) through
// feedAttentionChunk()'s `now` param — required because ATTENTION_REDRAW_GRACE_MS is 400ms and a
// real-time replay loop finishes in microseconds, so the clear path could never be reached
// otherwise. Simulates onInjectSilence()'s per-chunk injectRetries counter (incremented once per
// chunk while the tail-scoped gate blocks) so a test can assert the reset lands well under the
// real MAX_MCP_TRUST_RETRIES budget.
// (C1386) `opts.injectDone` mirrors session._injectDone — default false matches production's
// pre-injection state, which is what every pre-existing caller below exercises. Passing
// `injectDone: true` simulates a POST-injection session (the C1386 hold's only valid window) —
// see shouldHoldAttention()'s own doc block for why the hold must never engage pre-injection.
function replayInjectGate(chunks, agentId, chunkMs, opts = {}) {
  const injectDone = opts.injectDone === true;
  const agent = getTaskAgent(agentId);
  const session = {
    _attentionLineCarry: '', _attentionOscOpen: false, _attentionState: null, _attentionTail: '',
    _attentionRow: 1, _attentionCol: 1, _attentionRowCarry: '',
    _lastAttentionKind: null, _lastTailDialogKind: null, _injectDone: injectDone,
  };
  let now = 0;
  let injectRetries = 0;
  let resetCount = 0;
  let resetAtElapsed = null;
  let resetVia = null;
  const perChunk = [];
  for (const rawChunk of chunks) {
    now += chunkMs;
    const oscFree = stripOscChunk(session, rawChunk);
    const clean = stripAnsi(oscFree);
    if (/\x1b\[2J|\x1b\[\?1049[hl]/.test(rawChunk)) session._attentionTail = '';
    session._attentionTail = ((session._attentionTail || '') + clean).slice(-ATTENTION_WINDOW_BYTES);
    const attentionMatch = getAttentionPromptMatch(session._attentionTail, agentId);
    const tailKind = attentionMatch ? attentionMatch.kind : null;
    const rowChunk = reflowChunk(session, oscFree);
    feedAttentionChunk(session, agent, oscFree, clean, now, rowChunk, tailKind);
    const lineKind = session._attentionState ? session._attentionState.kind : null;
    const clearedA = lineDialogLeftScreen(session._lastAttentionKind, lineKind, tailKind);
    const clearedB = dialogGateCleared(session._lastTailDialogKind, tailKind);
    if (clearedA || clearedB) {
      resetCount++;
      if (resetAtElapsed === null) { resetAtElapsed = now; resetVia = clearedA ? 'line' : 'tail'; }
      session._attentionTail = '';
      injectRetries = 0;
    } else if (isInjectGateKind(tailKind)) {
      injectRetries++;
    }
    session._lastAttentionKind = lineKind;
    session._lastTailDialogKind = tailKind;
    perChunk.push({ lineKind, tailKind, reset: clearedA || clearedB });
  }
  return { resetCount, resetAtElapsed, resetVia, injectRetries, perChunk };
}

test('C1120 regression: manually-dismissed folder-trust dialog (in-place TUI redraw, no auto-answer) releases the injection gate well before the 60s/60-retry cap', () => {
  const chunks = loadAttentionFixture('claude-folder-trust-manual-dismiss.jsonl');
  const result = replayInjectGate(chunks, 'claude', 500);
  assert.equal(result.resetCount >= 1, true, 'gate must release at least once');
  assert.equal(result.resetVia, 'line', 'the line-scoped detector (not the sticky tail) must be what releases it');
  assert.ok(result.resetAtElapsed < 60000, `reset fired at ${result.resetAtElapsed}ms, expected well under the 60s cap`);
  assert.ok(result.resetAtElapsed <= 2000, `reset fired at ${result.resetAtElapsed}ms, expected within ~2s of the dismissal chunk`);
  assert.ok(result.injectRetries < 60, `only ${60 - result.injectRetries} of 60 retries were spent`);
});

test('C1120 regression: the gate stays blocked while the dialog frame is only repainting (no false clear)', () => {
  const chunks = loadAttentionFixture('claude-folder-trust-manual-dismiss.jsonl');
  const result = replayInjectGate(chunks, 'claude', 500);
  // Fixture layout: [0] boot banner, [1] dialog opens, [2] idle repaint of the SAME frame,
  // [3] manual dismissal, [4..] normal REPL. The repaint at index 2 must not itself look like a
  // clear — only the dismissal at index 3 may release the gate.
  assert.equal(result.perChunk[1].tailKind, 'mcpTrust');
  assert.equal(result.perChunk[2].reset, false, 'idle repaint of the still-open dialog must not release the gate');
  assert.equal(result.perChunk[3].reset, true, 'the in-place post-dismissal repaint is what must release it');
});

test('C1120 regression: without the dismissal chunk, the tail alone never self-clears — proves the fixture reproduces the sticky-tail condition the fix addresses', () => {
  const chunks = loadAttentionFixture('claude-folder-trust-manual-dismiss.jsonl').slice(0, 3); // boot + dialog-open + idle-repaint only
  const result = replayInjectGate(chunks, 'claude', 500);
  assert.equal(result.resetCount, 0, 'gate must still be blocked with the dismissal withheld');
  assert.equal(result.perChunk[result.perChunk.length - 1].tailKind, 'mcpTrust', 'the sticky tail is still reporting the dialog');
});

// Replay real Claude onboarding through prompt and injection gates. Keep
// injection blocked across successive trust screens; release only at REPL.

test('C1219 regression: the live-captured first-run onboarding fixture blocks the injection gate through the trust dialog, then releases once the real REPL renders', () => {
  const chunks = loadAttentionFixture('claude-first-run-onboarding.jsonl');
  const result = replayInjectGate(chunks, 'claude', 500);
  assert.equal(result.resetCount >= 1, true, 'gate must release at least once');
  assert.ok(result.resetAtElapsed < 1800 * 1000, `reset fired at ${result.resetAtElapsed}ms, expected well under the ~30min-per-screen firstRun cap`);
  assert.ok(result.injectRetries < 1800, `only ${1800 - result.injectRetries} of 1800 retries were spent`);
  // The dialog itself must actually have been seen and classified firstRun before it released —
  // otherwise this test would trivially pass on a fixture that never blocked anything.
  assert.ok(result.perChunk.some((c) => c.tailKind === 'firstRun'), 'the workspace-trust dialog must have been classified firstRun at some point in this capture');
});

test('C1219 regression: an in-place advance from one real onboarding screen straight into another never falsely releases the gate', () => {
  const chunks = loadAttentionFixture('claude-first-run-manual-advance.jsonl');
  const result = replayInjectGate(chunks, 'claude', 500);
  assert.equal(result.resetCount, 0, 'the gate must stay blocked — both the theme picker and the login-method screen are firstRun');
  assert.equal(result.perChunk[result.perChunk.length - 1].tailKind, 'firstRun', 'the tail must still be reporting an onboarding screen after the in-place advance');
});

// (C1219) onInjectSilence()'s firstRun branch is a closure internal to spawnTerminal(), not
// exported — no existing test in this file drives spawnTerminal() end-to-end (it needs a real
// pty.spawn() and a full agent/backend stack), so this pins the NEVER-BLIND-PASTE contract at the
// level that actually IS testable: the source text of the branch itself. This is a narrower
// guarantee than a live-timer integration test would give, but it directly catches the one
// regression that matters — someone copying the mcpTrust/toolApproval branch's
// `if (injectRetries < cap) { defer } ` / fall-through-to-paste shape onto firstRun, which is
// exactly the mistake MAX_FIRST_RUN_RETRIES's own doc comment in terminal-session.js warns
// against. The exported constants confirm the cap itself is real and materially larger than the
// auto-answerable mcpTrust cap, since firstRun has no safe guess to fall back on.
test('C1219: firstRun has its own, larger retry budget than mcpTrust, and is registered as a gate kind', () => {
  assert.ok(isInjectGateKind('firstRun'));
  assert.ok(MAX_FIRST_RUN_RETRIES > MAX_MCP_TRUST_RETRIES, 'firstRun gets a materially larger budget than the auto-answerable mcpTrust cap, since there is no safe guess to fall back on');
});

test('C1219: onInjectSilence()\'s firstRun branch never falls through to a pty.write() paste at its cap — source-level guard against reintroducing the mcpTrust/toolApproval paste-at-cap shape', () => {
  const src = fs.readFileSync(path.join(__dirname, 'terminal-session.js'), 'utf8');
  const branchStart = src.indexOf("dlg.kind === 'firstRun'");
  assert.ok(branchStart >= 0, 'the firstRun defer branch must exist in onInjectSilence()');
  const branchEnd = src.indexOf('\n    if (dlg && (dlg.kind ===', branchStart); // start of the shared mcpTrust/toolApproval defer block that follows it
  assert.ok(branchEnd > branchStart, 'could not isolate the firstRun branch body — has the surrounding code moved?');
  const branchBody = src.slice(branchStart, branchEnd);
  assert.match(branchBody, /injectDone = true/, 'the firstRun branch must give up by setting injectDone directly');
  assert.doesNotMatch(branchBody, /session\.pty\.write/, 'the firstRun branch must never call pty.write() — it must never paste the task prompt into an unidentified onboarding screen');
});

// ── C1386: held attention while an unanswered gate dialog is still on the tail ──
// Reported bug: a Claude terminal session sitting on a tool-approval dialog ("Do you want to
// proceed? / 1. Yes / 2. Yes, and don't ask again for … / 3. No, and tell Claude what to do
// differently") loses its board/left-menu highlight while the dialog is still open and
// unanswered. Root cause: Claude's Ink TUI repaints cursor-addressed FRAGMENTS (footer/token
// counter) while the dialog is fully on screen — such a chunk produces no `hit` in
// feedAttentionChunk() and satisfies every other step-4 clear condition, so the highlight drops
// ~400ms after the dialog painted, while the human is still staring at it.

test('C1386: shouldHoldAttention() holds only for a gate-kind tail, only after injection, and only inside the hard ceiling', () => {
  const state = { kind: 'attention', promptText: '3. No, and tell Claude what to do differently (esc)', agent: 'claude', at: 1000 };
  for (const k of ['toolApproval', 'mcpTrust', 'firstRun', 'askQuestion']) {
    assert.equal(shouldHoldAttention(state, k, 500, true), true, k);
  }
  for (const k of ['attention', 'planReady', null, undefined]) {
    assert.equal(shouldHoldAttention(state, k, 500, true), false, String(k));
  }
  assert.equal(shouldHoldAttention(null, 'toolApproval', 500, true), false, 'no active state -> nothing to hold');
  // Pre-injection the hold must be inert, or it swallows C1120's lineDialogLeftScreen() release
  // (see the C1120-interaction test below).
  assert.equal(shouldHoldAttention(state, 'toolApproval', 500, false), false, 'must be inert before injection');
  // Hard ceiling: holds right up to ATTENTION_HOLD_MAX_MS, releases at/after it.
  assert.equal(shouldHoldAttention(state, 'toolApproval', ATTENTION_HOLD_MAX_MS - 1, true), true);
  assert.equal(shouldHoldAttention(state, 'toolApproval', ATTENTION_HOLD_MAX_MS, true), false);
  assert.ok(ATTENTION_HOLD_MAX_MS > 120000, 'must outlast index.js\'s ATTENTION_STALE_MS (120000) or the sweep clears first');
});

test('C1386 regression: a fragment repaint arriving while a Claude tool-approval dialog is still on the tail no longer clears the attention state', () => {
  const agent = getTaskAgent('claude');
  const dialog = "│ Do you want to proceed? │\n│ ❯ 1. Yes │\n│   2. Yes, and don't ask again for tipatask — Get Project Tags commands │\n│   3. No, and tell Claude what to do differently (esc) │\n";
  const footer = '  ⏵⏵ plan mode on · 12.4k tokens\n'; // no hit, >= ATTENTION_CLEAR_MIN_BYTES, dialog text absent

  // Without a tail kind (or pre-injection), the fragment repaint clears exactly as before this
  // task — this is the reported bug, pinned so a future change can't silently reintroduce it.
  {
    const { session, events } = makeAttentionSession();
    feedAttentionChunk(session, agent, dialog, dialog, 1000);
    feedAttentionChunk(session, agent, footer, footer, 2000);
    assert.equal(session._attentionState, null, 'documents the reported bug when nothing holds it');
    assert.equal(events.filter((e) => e.type === 'clear').length, 1);
  }

  // Fixed: tail reports an unanswered toolApproval dialog, post-injection -> the fragment
  // repaint must not clear it.
  {
    const { session, events } = makeAttentionSession();
    session._injectDone = true;
    feedAttentionChunk(session, agent, dialog, dialog, 1000, null, 'toolApproval');
    assert.equal(session._attentionState.kind, 'attention',
      'line-scoped kind stays generic (last-match-wins) — the gate is keyed on the TAIL kind, not state.kind');
    feedAttentionChunk(session, agent, footer, footer, 2000, null, 'toolApproval');
    assert.notEqual(session._attentionState, null, 'held — must not clear while the tail still reports the dialog');
    assert.equal(events.filter((e) => e.type === 'clear').length, 0);
    // Released once the answered dialog rolls out of the tail (tailKind -> null).
    feedAttentionChunk(session, agent, footer, footer, 3000, null, null);
    assert.equal(session._attentionState, null);
    assert.equal(events.filter((e) => e.type === 'clear').length, 1);
  }
});

test('C1386 regression: a tail permanently stuck reporting toolApproval still clears exactly once, at the hard ceiling', () => {
  const agent = getTaskAgent('claude');
  const dialog = "│ Do you want to proceed? │\n│   2. Yes, and don't ask again for tipatask — Get Project Tags commands │\n";
  const footer = '  ⏵⏵ plan mode on · 12.4k tokens\n';
  const { session, events } = makeAttentionSession();
  session._injectDone = true;
  feedAttentionChunk(session, agent, dialog, dialog, 1000, null, 'toolApproval');
  feedAttentionChunk(session, agent, footer, footer, 1000 + ATTENTION_HOLD_MAX_MS - 1, null, 'toolApproval');
  assert.notEqual(session._attentionState, null, 'still inside the ceiling');
  feedAttentionChunk(session, agent, footer, footer, 1000 + ATTENTION_HOLD_MAX_MS, null, 'toolApproval');
  assert.equal(session._attentionState, null, 'at the ceiling — must clear even though the tail never released');
  assert.equal(events.filter((e) => e.type === 'clear').length, 1);
});

test('C1386 regression: the hold is inert before injection, so C1120\'s in-place-dismissal release still fires', () => {
  // This is the exact conflict shouldHoldAttention()'s injectDone gating exists to avoid: the
  // dismissal chunk in this fixture is simultaneously C1120's release trigger (line state
  // active -> null WHILE the tail still says mcpTrust) and the C1386 hold's hold condition. Only
  // one of the two mechanisms may act on it, and which one depends entirely on injectDone.
  const chunks = loadAttentionFixture('claude-folder-trust-manual-dismiss.jsonl');

  const pre = replayInjectGate(chunks, 'claude', 500); // injectDone: false (default) — matches production pre-injection
  assert.equal(pre.perChunk[3].reset, true, 'C1120 transition A must still fire pre-injection');
  assert.equal(pre.resetVia, 'line');

  const post = replayInjectGate(chunks, 'claude', 500, { injectDone: true });
  assert.equal(post.perChunk[3].reset, false, 'post-injection the hold suppresses the clear the C1120 reset depends on, so the reset never fires');
  assert.equal(post.perChunk[3].lineKind, 'attention', 'held instead of released');
});

test('C1386 regression (fixture-driven): a Claude tool-approval dialog that only fragment-repaints keeps its highlight for the whole open window, then releases once it rolls out of the tail', () => {
  const chunks = loadAttentionFixture('claude-tool-approval-idle-repaint.jsonl');
  // Fixture layout: [0] ready REPL, [1] approval dialog paints, [2..9] footer-only fragment
  // repaints (the reported trigger), [10] dialog answered, redraws in place, [11..13] ordinary
  // post-answer output that rolls the dialog out of the 1KB tail.
  const held = replayInjectGate(chunks, 'claude', 500, { injectDone: true });
  assert.equal(held.perChunk[1].tailKind, 'toolApproval', 'the new tail table must classify this dialog');
  assert.equal(held.perChunk[1].lineKind, 'attention');
  for (let i = 2; i <= 12; i++) {
    assert.equal(held.perChunk[i].lineKind, 'attention', `chunk ${i}: highlight must stay raised through the fragment repaint/in-place answer`);
  }
  assert.equal(held.perChunk[held.perChunk.length - 1].lineKind, null, 'cleared once the answered dialog rolls out of the tail');

  // Same fixture, no hold (pre-injection) — proves the fixture genuinely reproduces the reported
  // bug rather than merely exercising the hold in a vacuum.
  const bug = replayInjectGate(chunks, 'claude', 500);
  assert.equal(bug.perChunk[2].lineKind, null, 'pre-fix shape: the very first fragment repaint already drops the highlight');
});

test('C1386: index.js\'s ATTENTION_STALE_MS sweep consults shouldHoldAttention() before nulling a held state — source-level guard', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const sweepStart = src.indexOf('session._attentionState && now - session._attentionState.at > ATTENTION_STALE_MS');
  assert.ok(sweepStart >= 0, 'could not find the stale-latch sweep condition — has it moved?');
  const sweepEnd = src.indexOf('if (session._attentionState) {', sweepStart);
  assert.ok(sweepEnd > sweepStart, 'could not isolate the sweep body — has the surrounding code moved?');
  const sweepBody = src.slice(sweepStart, sweepEnd);
  assert.match(sweepBody, /shouldHoldAttention\(/, 'the stale-latch sweep must consult shouldHoldAttention() before nulling _attentionState');
});

// ── TPT348: Claude "waiting on background agents" busy latch ──
// The reported frame: hook-error rows, "Plan skeleton written…", two turn-end "Waiting for N
// background agents to finish" rows, an empty ❯ box, the plan-mode footer, and a live agents
// panel. It matches NO prompt pattern (pinned below) — the false highlight came from the
// quiet-screen raisers reading this idle-looking screen as "needs a human".
const BG_WAIT_FRAME = [
  '  ⎿  PostToolUse:Write hook error',
  '  ⎿  Failed with non-blocking status code: node:internal/modules/cjs/loader:1503',
  '● Plan skeleton written. Waiting on 3 Explore agents.',
  '* Waiting for 3 background agents to finish',
  '● Agent "Oversized image origins" finished · 3m 1s',
  '● Image agent done: 3 src build assets (4096px, never resized), 5 CMS uploads (no size',
  '  cap), 1 legacy WP file, 2 external hosts. Waiting on the other two.',
  '* Waiting for 2 background agents to finish',
  '❯ ',
  '  [CAVEMAN]',
  '  ⏸ plan mode on (shift+tab to cycle) · ← for agents',
  '  ● main',
  '  ○ Explore  Counting title tags in cms_content              4m 17s · ↓ 116.0k tokens',
  '  ○ Explore  Checking store pagination in index.view.php     4m 17s · ↓ 123.6k tokens',
];
// Same frame, no waiting row / panel — an ordinary idle Claude prompt.
const IDLE_FRAME = BG_WAIT_FRAME.filter((l) => !/Waiting for \d+ background|tokens\s*$/.test(l));
const paintCursorAddressed = (rows) => rows.map((t, i) => `\x1b[${i + 1};1H\x1b[2K${t}`).join('');
const paintPlain = (rows) => rows.join('\r\n') + '\r\n';
const raises = (events) => events.filter((e) => e.type === 'raise');

test('TPT348: the reported frame matches no prompt pattern for any matcher — nothing to tighten', () => {
  const agent = getTaskAgent('claude');
  assert.equal(agent.matchPromptLines(BG_WAIT_FRAME), null);
  for (const line of BG_WAIT_FRAME) assert.equal(agent.isPromptLine(line), null, line);
  assert.equal(getAttentionPromptMatch(BG_WAIT_FRAME.join('\n'), 'claude'), null);
  assert.equal(getAttentionPromptMatch(BG_WAIT_FRAME.join(''), 'claude'), null, 'glued (un-reflowed) shape too');
});

for (const [shape, paint] of [['cursor-addressed cell-diff', paintCursorAddressed], ['plain \\r\\n', paintPlain]]) {
  test(`TPT348: a Claude session on the reported frame (${shape}) never raises attention — not on the BEL idle_prompt, not later`, () => {
    const agent = getTaskAgent('claude');
    const { session, events } = makeAttentionSession();
    feedRaw(session, agent, paint(BG_WAIT_FRAME), 1000);
    assert.equal(bgAgentsBusy(session, 1000), true, 'the waiting row / panel must latch the session busy');
    assert.equal(raises(events).length, 0, 'the frame itself raises nothing');
    // Claude rings the terminal bell on idle_prompt once its turn has ended (terminal_bell channel).
    feedRaw(session, agent, '\x07', 61000);
    // ...and a timer-tick repaint of just the panel counters keeps arriving while agents run.
    feedRaw(session, agent, '\x1b[13;60H4m 18s · ↓ 116.4k tokens', 62000);
    feedRaw(session, agent, '\x07', 121000);
    assert.equal(raises(events).length, 0, 'BEL must not raise while background agents are pending');
    assert.equal(session._attentionState, null);
    assert.equal(bgAgentsBusy(session, 121000), true, 'ticking panel rows keep the latch alive');
  });
}

test('TPT348 control: the same idle frame WITHOUT a waiting row / panel still raises on the BEL', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  feedRaw(session, agent, paintCursorAddressed(IDLE_FRAME), 1000);
  assert.equal(bgAgentsBusy(session, 1000), false);
  feedRaw(session, agent, '\x07', 61000);
  assert.equal(raises(events).length, 1);
  assert.equal(raises(events)[0].kind, 'attention');
});

test('TPT348: the ordinary turn-end duration row supersedes the waiting row, and normal BEL detection resumes', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  feedRaw(session, agent, paintPlain(BG_WAIT_FRAME), 1000);
  assert.equal(bgAgentsBusy(session, 1000), true);
  // last agent reports back, Claude works, the turn ends normally
  feedRaw(session, agent, paintPlain(['● Agent "X" finished · 5m 2s', '✻ Worked for 12s']), 90000);
  assert.equal(bgAgentsBusy(session, 90000), false);
  feedRaw(session, agent, '\x07', 150000);
  assert.equal(raises(events).length, 1, 'a genuinely idle session raises again once the waiting row is superseded');
});

test('TPT348: a second turn that ends still waiting keeps the latch (a "Waiting for N" row after a "done" row re-latches)', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  feedRaw(session, agent, paintPlain(['✻ Worked for 12s']), 1000);
  assert.equal(bgAgentsBusy(session, 1000), false);
  feedRaw(session, agent, paintPlain(['* Waiting for 1 background agent to finish']), 2000);
  assert.equal(bgAgentsBusy(session, 2000), true);
  feedRaw(session, agent, '\x07', 62000);
  assert.equal(raises(events).length, 0);
});

test('TPT348: the latch expires BG_AGENTS_BUSY_MAX_MS after the last sighting so a missed clear cannot mute attention forever', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  feedRaw(session, agent, paintPlain(['* Waiting for 2 background agents to finish']), 1000);
  assert.equal(bgAgentsBusy(session, 1000 + BG_AGENTS_BUSY_MAX_MS - 1), true);
  assert.equal(bgAgentsBusy(session, 1000 + BG_AGENTS_BUSY_MAX_MS), false);
  feedRaw(session, agent, '\x07', 1000 + BG_AGENTS_BUSY_MAX_MS);
  assert.equal(raises(events).length, 1);
  assert.equal(bgAgentsBusy({}, 0), false, 'a session that never saw the row is not busy');
});

test('TPT348: a clear-screen/alt-screen repaint un-latches, but re-latches when the repainted frame still shows the row', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  feedRaw(session, agent, paintPlain(BG_WAIT_FRAME), 1000);
  assert.equal(bgAgentsBusy(session, 1000), true);
  // repaint of a frame without the row (agents finished, transcript scrolled)
  feedRaw(session, agent, '\x1b[2J\x1b[3J\x1b[H' + paintCursorAddressed(IDLE_FRAME), 2000);
  assert.equal(bgAgentsBusy(session, 2000), false);
  feedRaw(session, agent, '\x07', 62000);
  assert.equal(raises(events).length, 1);
  // repaint of a frame that still contains the row / panel
  const { session: s2, events: e2 } = makeAttentionSession();
  feedRaw(s2, agent, paintPlain(BG_WAIT_FRAME), 1000);
  feedRaw(s2, agent, '\x1b[?1049h\x1b[2J\x1b[H' + paintCursorAddressed(BG_WAIT_FRAME), 2000);
  assert.equal(bgAgentsBusy(s2, 2000), true, 'the fall-through carve re-latches from the repainted frame');
  feedRaw(s2, agent, '\x07', 62000);
  assert.equal(raises(e2).length, 0);
});

test('TPT348: a real permission / plan-approval dialog still raises — while latched, and after the latch clears', () => {
  const agent = getTaskAgent('claude');
  const { session, events } = makeAttentionSession();
  feedRaw(session, agent, paintPlain(BG_WAIT_FRAME), 1000);
  assert.equal(bgAgentsBusy(session, 1000), true);
  // a background agent (or the plan flow) puts a dialog on the main UI while the latch is set
  feedRaw(session, agent, paintPlain(['│ Do you want to proceed? │']), 5000);
  assert.equal(raises(events).length, 1, 'line-pattern hits are never suppressed by the busy latch');
  assert.equal(raises(events)[0].promptText, 'Do you want to proceed?');
  // dialog answered, output moves on, agents finish, turn ends
  feedRaw(session, agent, paintPlain(['working on it now, applying the change']), 6000);
  assert.equal(session._attentionState, null);
  feedRaw(session, agent, paintPlain(['✻ Worked for 12s']), 7000);
  assert.equal(bgAgentsBusy(session, 7000), false);
  // ...and a later dialog raises exactly as it always did
  feedRaw(session, agent, paintPlain(['│ Do you want to make this edit to src/app.js? │']), 9000);
  assert.equal(raises(events).length, 2);
  assert.equal(raises(events)[1].promptText, 'Do you want to make this edit to src/app.js?');
});

test('TPT348: the busy latch is Claude-only — a Codex session fed the same rows still raises on BEL', () => {
  const agent = getTaskAgent('codex');
  const { session, events } = makeAttentionSession();
  feedRaw(session, agent, paintPlain(BG_WAIT_FRAME), 1000);
  assert.equal(bgAgentsBusy(session, 1000), false);
  feedRaw(session, agent, '\x07', 61000);
  assert.equal(raises(events).length, 1);
});

test('TPT348: index.js\'s idle fallback consults bgAgentsBusy() — source-level guard', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const start = src.indexOf('function terminalIdleFallbackNeeded(');
  assert.ok(start >= 0, 'could not find terminalIdleFallbackNeeded — has it moved?');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'could not isolate the function body');
  const body = src.slice(start, end);
  assert.match(body, /bgAgentsBusy\(session, now\)/, 'the idle fallback must stand down while Claude waits on background agents');
  assert.ok(body.indexOf('bgAgentsBusy(') < body.indexOf('lastOutputAt'), 'the busy check must precede the silence comparison');
});

test('TPT348: onData\'s plan-ready arm block stands down while busy and restarts the 10s ceiling — source-level guard', () => {
  const src = fs.readFileSync(path.join(__dirname, 'terminal-session.js'), 'utf8');
  const start = src.indexOf('if (bgAgentsBusy(session)) {');
  assert.ok(start >= 0, 'could not find the plan-ready busy gate in onData — has it moved?');
  const armIdx = src.indexOf("} else if (session.taskAgent !== 'codex' && planReadyEligible", start);
  assert.ok(armIdx > start, 'the busy gate must sit directly in front of the plan-ready arm block');
  const gateBody = src.slice(start, armIdx);
  assert.match(gateBody, /clearTimeout\(session\._planIdleTimer\)/, 'a pending plan-ready timer must be cancelled');
  assert.match(gateBody, /_planFirstArmedAt = null/, 'the arm ceiling must restart, or delay collapses to 0 the moment agents report back');
});

// ── (TPT349) API token expiry watch ──

const {
  scheduleTokenExpiryWatch,
  buildTokenExpiryNotice,
  TOKEN_WATCH_LEAD_MS,
} = require('./terminal-session');

test('scheduleTokenExpiryWatch: fires once, lead time before expiry', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let fired = 0;
  const watch = scheduleTokenExpiryWatch({ expMs: 1_000_000 + 3_600_000, onFire: () => { fired++; } });
  assert.equal(watch.delayMs, 3_600_000 - TOKEN_WATCH_LEAD_MS);
  t.mock.timers.tick(watch.delayMs - 1);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
  t.mock.timers.tick(10 * 3_600_000);
  assert.equal(fired, 1);
});

test('scheduleTokenExpiryWatch: already inside the lead window fires immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000 });
  let fired = 0;
  const watch = scheduleTokenExpiryWatch({ expMs: 5_000 + 60_000, onFire: () => { fired++; } });
  assert.equal(watch.delayMs, 0);
  t.mock.timers.tick(0);
  assert.equal(fired, 1);
});

test('scheduleTokenExpiryWatch: cancel() stops it; far-future expiry is clamped to the timer maximum', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let fired = 0;
  const watch = scheduleTokenExpiryWatch({ expMs: 3_600_000, onFire: () => { fired++; } });
  watch.cancel();
  t.mock.timers.tick(10 * 3_600_000);
  assert.equal(fired, 0);
  const far = scheduleTokenExpiryWatch({ expMs: 10 ** 15, onFire: () => {} });
  assert.equal(far.delayMs, 2 ** 31 - 1);
  far.cancel();
});

test('buildTokenExpiryNotice: wording follows what the user can actually do', () => {
  const expMs = Date.now() + 10 * 60_000;
  const reconnect = buildTokenExpiryNotice({ expMs, saved: true, headersHelper: true });
  assert.equal(reconnect.warn, false);
  assert.match(reconnect.text, /expires at/);
  assert.match(reconnect.text, /\/mcp → tipatask → Reconnect/);

  const restart = buildTokenExpiryNotice({ expMs, saved: true, headersHelper: false });
  assert.equal(restart.warn, true);
  assert.match(restart.text, /restart the session/);
  assert.match(restart.text, /REST/);

  const failed = buildTokenExpiryNotice({ expMs, saved: false, headersHelper: true });
  assert.equal(failed.warn, true);
  assert.match(failed.text, /could not be refreshed/);
  assert.match(failed.text, /Re-authenticate/);

  const late = buildTokenExpiryNotice({ expMs: Date.now() - 60_000, saved: false, headersHelper: true });
  assert.match(late.text, /expired at/);
});

// ── (TPT357) killRunawaySession() / exit-frame reason ──
//
// process.kill is stubbed and timers are mocked for the WHOLE scenario, including the SIGKILL
// follow-up tick: killRunawaySession() schedules a real 1.5s SIGKILL, and a timer that outlived
// the stub would signal a real process group on the dev machine.

function makeRunawaySession(overrides = {}) {
  const sent = [];
  const ptyCalls = [];
  return {
    sent,
    ptyCalls,
    session: {
      tabId: 'T1',
      alive: true,
      ptyPid: 424242,
      buffer: 'agent output\r\n',
      ws: { readyState: 1, OPEN: 1, send: (m) => sent.push(JSON.parse(m)) },
      pty: { kill: (sig) => ptyCalls.push(sig) },
      _exitReason: null,
      ...overrides,
    },
  };
}

function runWithStubbedKill(fn) {
  const calls = [];
  const origKill = process.kill;
  process.kill = (pid, sig) => { calls.push([pid, sig]); };
  test.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    fn(calls);
  } finally {
    test.mock.timers.reset();
    process.kill = origKill;
  }
}

const RUNAWAY_SNAPSHOT = parsePsOutput('  424242  424242  1\n  424242  424243  424242\n  555  555  424243\n');

test('killRunawaySession is a no-op returning null when the session is not alive or has no ptyPid', () => {
  runWithStubbedKill((calls) => {
    const dead = makeRunawaySession({ alive: false });
    assert.equal(killRunawaySession(dead.session, { count: 60, threshold: 50, snapshot: RUNAWAY_SNAPSHOT }), null);
    assert.equal(dead.session._exitReason, null);
    assert.equal(dead.session.buffer, 'agent output\r\n');

    const noPid = makeRunawaySession({ ptyPid: null });
    assert.equal(killRunawaySession(noPid.session, { count: 60, threshold: 50, snapshot: RUNAWAY_SNAPSHOT }), null);
    assert.equal(killRunawaySession(null, {}), null);
    assert.deepEqual(calls, []);
  });
});

test('killRunawaySession records the reason, appends a [Task App] notice to the buffer, emits it, and kills the tree', () => {
  runWithStubbedKill((calls) => {
    const { session, sent } = makeRunawaySession();
    const result = killRunawaySession(session, { count: 127, threshold: 50, snapshot: RUNAWAY_SNAPSHOT });

    assert.equal(result.first, true);
    assert.match(result.text, /^Watchdog killed this session: resource watchdog intervention; 127 descendant processes/);
    assert.match(result.text, /\u226550/);
    assert.match(result.text, /\u2265150/);
    assert.deepEqual(session._exitReason, { kind: 'runaway-killed', count: 127, threshold: 50, text: result.text, display: result.text });
    // Buffer: reconnect replay + the resolution-comment tail both read it.
    assert.ok(session.buffer.startsWith('agent output\r\n'));
    assert.ok(session.buffer.includes(`[Task App] ${result.text}`));
    // Live emit to the connected client, same [Task App] format as every other notice.
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'data');
    assert.ok(sent[0].data.includes(`[Task App] ${result.text}`));
    // Whole tree: the pty leader's group, plus the setsid()'d descendant-led group 555.
    assert.deepEqual(calls, [[-424242, 'SIGTERM'], [-555, 'SIGTERM']]);
  });
});

test('killRunawaySession appends a process summary to the kill text when one is given (TPT370)', () => {
  runWithStubbedKill(() => {
    const { session } = makeRunawaySession();
    const result = killRunawaySession(session, { count: 127, threshold: 50, snapshot: RUNAWAY_SNAPSHOT, summary: 'npm ×24, node ×12' });
    assert.match(result.text, /Top processes: npm ×24, node ×12\.$/);
  });
});

test('killRunawaySession follows SIGTERM with SIGKILL on the same targets after 1500ms', () => {
  runWithStubbedKill((calls) => {
    const { session } = makeRunawaySession();
    killRunawaySession(session, { count: 60, threshold: 50, snapshot: RUNAWAY_SNAPSHOT });
    assert.deepEqual(calls, [[-424242, 'SIGTERM'], [-555, 'SIGTERM']]);
    test.mock.timers.tick(1499);
    assert.equal(calls.length, 2); // not yet
    test.mock.timers.tick(1);
    assert.deepEqual(calls.slice(2), [[-424242, 'SIGKILL'], [-555, 'SIGKILL']]);
  });
});

test('killRunawaySession on a repeat sweep re-signals the tree but writes the reason and notice only once', () => {
  runWithStubbedKill((calls) => {
    const { session, sent } = makeRunawaySession();
    const first = killRunawaySession(session, { count: 127, threshold: 50, snapshot: RUNAWAY_SNAPSHOT });
    const bufferAfterFirst = session.buffer;
    const second = killRunawaySession(session, { count: 90, threshold: 50, snapshot: RUNAWAY_SNAPSHOT });

    assert.equal(first.first, true);
    assert.equal(second.first, false);
    assert.equal(session.buffer, bufferAfterFirst); // no duplicate notice line
    assert.equal(sent.length, 1);
    assert.equal(session._exitReason.count, 127); // the original reason is kept
    assert.equal(calls.filter(([, sig]) => sig === 'SIGTERM').length, 4); // signaled again both times
  });
});

test('killRunawaySession falls back to pty.kill() when the process tree yields nothing to signal', () => {
  runWithStubbedKill((calls) => {
    const { session, ptyCalls } = makeRunawaySession({ ptyPid: 1 }); // pid 1 is never signaled
    killRunawaySession(session, { count: 60, threshold: 50, snapshot: null });
    assert.deepEqual(calls, []);
    assert.deepEqual(ptyCalls, ['SIGTERM']);
    test.mock.timers.tick(1500);
    assert.deepEqual(ptyCalls, ['SIGTERM', 'SIGKILL']);
  });
});

test('killRunawaySession words a memory kill around the limit and records the figures', () => {
  runWithStubbedKill(() => {
    const { session } = makeRunawaySession();
    const result = killRunawaySession(session, { count: 12, threshold: 50, rssMb: 4800, limitMb: 3072, reason: 'memory-growth', snapshot: RUNAWAY_SNAPSHOT });
    assert.match(result.text, /^Watchdog killed this session: sustained high RSS and memory growth; 12 descendant processes using 4800 MiB/);
    assert.match(result.text, /12 descendant processes/);
    assert.equal(session._exitReason.kind, 'runaway-killed');
    assert.equal(session._exitReason.rssMb, 4800);
    assert.equal(session._exitReason.limitMb, 3072);
  });
});

// ── pauseRunawaySession() / resumeRunawaySession() — process.kill stubbed, nothing real is signaled ──

const PAUSE_ARGS = { count: 12, threshold: 50, rssMb: 3300, limitMb: 3072, reason: 'memory-growth', snapshot: RUNAWAY_SNAPSHOT };

test('pauseRunawaySession is a no-op returning null when the session is not alive or has no ptyPid', () => {
  runWithStubbedKill((calls) => {
    const dead = makeRunawaySession({ alive: false });
    assert.equal(pauseRunawaySession(dead.session, PAUSE_ARGS), null);
    const noPid = makeRunawaySession({ ptyPid: null });
    assert.equal(pauseRunawaySession(noPid.session, PAUSE_ARGS), null);
    assert.equal(pauseRunawaySession(null, {}), null);
    assert.equal(dead.session._pause, undefined);
    assert.equal(dead.session.buffer, 'agent output\r\n');
    assert.deepEqual(calls, []);
  });
});

test('pauseRunawaySession SIGSTOPs the whole tree, never kills, and writes one [Task App] notice', () => {
  runWithStubbedKill((calls) => {
    const { session, sent, ptyCalls } = makeRunawaySession();
    const result = pauseRunawaySession(session, { ...PAUSE_ARGS, summary: 'node ×9' });

    assert.equal(result.first, true);
    assert.match(result.text, /^Watchdog paused this session: sustained high RSS and memory growth; 12 descendant processes using 3300 MiB/);
    assert.match(result.text, /Nothing was killed/);
    assert.match(result.text, /Resume the session/);
    assert.match(result.text, /Top processes: node ×9\.$/);
    // The pty leader's group plus the setsid()'d descendant-led group 555 — SIGSTOP only.
    assert.deepEqual(calls, [[-424242, 'SIGSTOP'], [-555, 'SIGSTOP']]);
    assert.deepEqual(ptyCalls, []);
    test.mock.timers.tick(5000); // no SIGKILL follow-up is ever scheduled
    assert.deepEqual(calls, [[-424242, 'SIGSTOP'], [-555, 'SIGSTOP']]);
    // Not an exit: no reason recorded, session still alive.
    assert.equal(session._exitReason, null);
    assert.equal(session.alive, true);
    assert.deepEqual(session._pause.targets, { pgids: [424242, 555], pids: [] });
    assert.equal(session._pause.reason, 'memory-growth');
    assert.equal(session._pause.rssMb, 3300);
    // Buffer (reconnect replay) and the live socket both carry the notice.
    assert.ok(session.buffer.startsWith('agent output\r\n'));
    assert.ok(session.buffer.includes(`[Task App] ${result.text}`));
    assert.equal(sent.length, 2);
    assert.equal(sent[0].type, 'data');
    assert.ok(sent[0].data.includes(`[Task App] ${result.text}`));
    // (TPT443) followed by a terminal-state frame carrying the paused-banner summary — figures
    // only, never the signal target set.
    assert.equal(sent[1].type, 'terminal-state');
    assert.deepEqual(Object.keys(sent[1].paused).sort(), ['at', 'count', 'limitMb', 'reason', 'rssMb', 'threshold']);
    assert.equal(sent[1].paused.rssMb, 3300);
    assert.equal(sent[1].paused.limitMb, 3072);
    assert.equal(sent[1].paused.reason, 'memory-growth');
  });
});

test('pauseRunawaySession words a count pause around the process growth', () => {
  runWithStubbedKill(() => {
    const { session } = makeRunawaySession();
    const result = pauseRunawaySession(session, { count: 86, threshold: 50, rssMb: 700, limitMb: 3072, reason: 'count-growth', snapshot: RUNAWAY_SNAPSHOT });
    assert.match(result.text, /^Watchdog paused this session: sustained process-count growth; 86 descendant processes using 700 MiB/);
    assert.match(result.text, /warn ≥50/);
    assert.equal(session._pause.reason, 'count-growth');
  });
});

test('pauseRunawaySession on a repeat sweep re-signals and folds in new targets, with no second notice', () => {
  runWithStubbedKill((calls) => {
    const { session, sent } = makeRunawaySession();
    const first = pauseRunawaySession(session, PAUSE_ARGS);
    const bufferAfterFirst = session.buffer;
    // A member that forked just before the first SIGSTOP now leads its own group (777).
    const later = parsePsOutput('  424242  424242  1\n  424242  424243  424242\n  555  555  424243\n  777  777  424243\n');
    const second = pauseRunawaySession(session, { ...PAUSE_ARGS, count: 13, rssMb: 3400, snapshot: later });

    assert.equal(second.first, false);
    assert.equal(second.text, first.text);
    assert.equal(session.buffer, bufferAfterFirst);
    assert.equal(sent.filter(m => m.type === 'data').length, 1);
    // (TPT443) each sweep refreshes the paused banner's figures
    assert.equal(sent.at(-1).type, 'terminal-state');
    assert.equal(sent.at(-1).paused.rssMb, 3400);
    assert.deepEqual(calls.slice(2), [[-424242, 'SIGSTOP'], [-555, 'SIGSTOP'], [-777, 'SIGSTOP']]);
    assert.deepEqual(session._pause.targets, { pgids: [424242, 555, 777], pids: [] });
    assert.equal(session._pause.rssMb, 3400); // latest figures, used as the resume base
    assert.equal(session._pause.count, 13);
  });
});

test('pauseRunawaySession returns null, and records no pause, when nothing could be signaled', () => {
  runWithStubbedKill((calls) => {
    const { session, sent } = makeRunawaySession({ ptyPid: 1 }); // pid 1 is never signaled
    assert.equal(pauseRunawaySession(session, { ...PAUSE_ARGS, snapshot: null }), null);
    assert.equal(session._pause, undefined);
    assert.equal(session.buffer, 'agent output\r\n');
    assert.equal(sent.length, 0);
    assert.deepEqual(calls, []);
  });
});

test('resumeRunawaySession SIGCONTs exactly the stopped set, clears the pause and re-arms the watchdog', () => {
  runWithStubbedKill((calls) => {
    const { session, sent } = makeRunawaySession({
      descendantWatchdog: { threshold: 50, lastCount: 12, paused: true, actReason: 'memory', growthStreak: 1, rssStreak: 4, pauseFailed: true },
    });
    pauseRunawaySession(session, PAUSE_ARGS);
    calls.length = 0;
    const result = resumeRunawaySession(session);

    assert.equal(result.resumed, true);
    assert.match(result.text, /^Session resumed\./);
    assert.deepEqual(calls, [[-424242, 'SIGCONT'], [-555, 'SIGCONT']]);
    assert.equal(session._pause, null);
    assert.equal(session._exitReason, null);
    assert.deepEqual(session.descendantWatchdog, {
      threshold: 50, lastCount: 12, paused: false, actReason: null, growthStreak: 0, rssStreak: 0, pauseFailed: false,
      rssGrowthStreak: 0, pressureGrowthStreak: 0, pressureStreak: 0, rssSince: null, lastSampleAt: null, lastRssMb: null,
      resumeBase: { count: 12, rssMb: 3300 },
    });
    assert.ok(session.buffer.includes(`[Task App] ${result.text}`));
    assert.equal(sent.filter(m => m.type === 'data').length, 2); // pause notice + resume notice
    // (TPT443) the attached client's banner goes away: last frame is terminal-state, paused null
    assert.equal(sent.at(-1).type, 'terminal-state');
    assert.equal(sent.at(-1).paused, null);
    // Not paused any more: a second resume is a no-op.
    assert.equal(resumeRunawaySession(session), null);
    assert.equal(calls.length, 2);
  });
});

test('resumeRunawaySession is a no-op for a session that was never paused', () => {
  runWithStubbedKill((calls) => {
    const { session } = makeRunawaySession();
    assert.equal(resumeRunawaySession(session), null);
    assert.equal(resumeRunawaySession(null), null);
    assert.deepEqual(calls, []);
    assert.equal(session.buffer, 'agent output\r\n');
  });
});

test('resumeRunawaySession falls back to the pty leader group when the stored set no longer answers', () => {
  const calls = [];
  const origKill = process.kill;
  // Stored members are gone (ESRCH); the leader's group still exists.
  process.kill = (pid, sig) => { calls.push([pid, sig]); if (pid !== -424242) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
  try {
    const { session } = makeRunawaySession({ _pause: { count: 3, rssMb: 10, targets: { pgids: [555], pids: [9001] } } });
    const result = resumeRunawaySession(session);
    assert.equal(result.resumed, true);
    assert.deepEqual(calls, [[-555, 'SIGCONT'], [9001, 'SIGCONT'], [-424242, 'SIGCONT']]);
  } finally {
    process.kill = origKill;
  }
});

test('resumeAllRunawaySessions resumes every paused session and leaves the others alone', () => {
  runWithStubbedKill((calls) => {
    const a = makeRunawaySession({ tabId: 'A' });
    const b = makeRunawaySession({ tabId: 'B', ptyPid: 525252 });
    const c = makeRunawaySession({ tabId: 'C', ptyPid: 626262 });
    pauseRunawaySession(a.session, PAUSE_ARGS);
    pauseRunawaySession(c.session, { ...PAUSE_ARGS, snapshot: parsePsOutput('  626262  626262  1\n') });
    calls.length = 0;
    const sessions = new Map([['a', a.session], ['b', b.session], ['c', c.session], ['gone', null]]);

    assert.deepEqual(resumeAllRunawaySessions(sessions), ['A', 'C']);
    assert.deepEqual(calls, [[-424242, 'SIGCONT'], [-555, 'SIGCONT'], [-626262, 'SIGCONT']]);
    assert.equal(a.session._pause, null);
    assert.equal(c.session._pause, null);
    assert.deepEqual(resumeAllRunawaySessions(sessions), []); // all resumable, none left paused
    assert.deepEqual(resumeAllRunawaySessions(null), []);
  });
});

test('a watchdog sweep pauses with a whole-MiB tree RSS, reports it, and resumes from it (TPT9009)', () => {
  runWithStubbedKill(() => {
    const { session, sent } = makeRunawaySession({ type: 'terminal', descendantWatchdog: { threshold: 50, lastCount: 0 } });
    const sessions = new Map([['T1', session]]);
    const frames = [];
    const notices = [];
    const deps = {
      resolveLimits: () => ({ warnDescendants: 50, maxTreeRssMb: 3072, watchdogAction: 'pause' }),
      pauseRunawaySession,
      killRunawaySession,
      emitTerminalNotice: (s, text) => notices.push(text),
      emitSessionRunaway: (projectPath, detail) => frames.push(detail),
      log() {},
    };
    // 150 descendants reach the count ceiling at once; the leader's KB total is not a whole MiB.
    const tree = (leaderKb) => parsePsOutput([`  424242  424242  1  ${leaderKb}  S  node`,
      ...Array.from({ length: 150 }, (_, i) => `  424242  ${500000 + i}  424242  0  S  npm`)].join('\n'));
    sweepDescendantWatchdog(sessions, tree(6384200), { ...deps, sampledAt: 30000 }); // 6234.5703125 MiB

    assert.match(session._pause.text, /; 150 descendant processes using 6235 MiB \(warn ≥50;/);
    assert.equal(session._pause.rssMb, 6235);
    // the paused banner's tooltip figures
    assert.equal(sent.filter(m => m.type === 'terminal-state').at(-1).paused.rssMb, 6235);
    assert.deepEqual({ paused: frames[0].paused, rssMb: frames[0].rssMb }, { paused: true, rssMb: 6235 });

    resumeRunawaySession(session);
    assert.deepEqual(session.descendantWatchdog.resumeBase, { count: 150, rssMb: 6235 });
    // A whole-MiB resume base keeps the raised action mark (6235 + 25% of 3072) printable.
    sweepDescendantWatchdog(sessions, tree(9626184), { ...deps, sampledAt: 60000 }); // 9400.5703125 MiB
    assert.match(notices.at(-1), /uses 9401 MiB; RSS warning threshold 3072 MiB \(150 descendant processes\)/);
    assert.match(notices.at(-1), /RSS stays >7003 MiB for 3 30-second samples/);
    assert.equal(frames.at(-1).rssMb, 9401);
  });
});

test('killRunawaySession continues a paused tree before terminating it', () => {
  runWithStubbedKill((calls) => {
    const { session } = makeRunawaySession();
    pauseRunawaySession(session, PAUSE_ARGS);
    calls.length = 0;
    killRunawaySession(session, { count: 12, threshold: 50, snapshot: RUNAWAY_SNAPSHOT });
    assert.deepEqual(calls, [[-424242, 'SIGCONT'], [-555, 'SIGCONT'], [-424242, 'SIGTERM'], [-555, 'SIGTERM']]);
    assert.equal(session._pause, null);
  });
});

test('killPausedTargets continues, SIGTERMs, then SIGKILLs the stored set; no-op when not paused', () => {
  runWithStubbedKill((calls) => {
    const { session } = makeRunawaySession();
    assert.equal(killPausedTargets(session), false);
    assert.equal(killPausedTargets(null), false);
    assert.deepEqual(calls, []);

    pauseRunawaySession(session, PAUSE_ARGS);
    calls.length = 0;
    assert.equal(killPausedTargets(session), true);
    assert.equal(session._pause, null);
    assert.deepEqual(calls, [[-424242, 'SIGCONT'], [-555, 'SIGCONT'], [-424242, 'SIGTERM'], [-555, 'SIGTERM']]);
    test.mock.timers.tick(1500);
    assert.deepEqual(calls.slice(4), [[-424242, 'SIGKILL'], [-555, 'SIGKILL']]);
  });
});

test('exitReasonFields is empty without a reason and carries reason/reasonText with one', () => {
  assert.deepEqual(exitReasonFields({ _exitReason: null }), {});
  assert.deepEqual(exitReasonFields({}), {});
  assert.deepEqual(
    exitReasonFields({ _exitReason: { kind: 'runaway-killed', count: 9, threshold: 50, text: 'why' } }),
    { reason: 'runaway-killed', reasonText: 'why' },
  );
});

test('buildTerminalExitFrame adds reason/reasonText for a runaway kill and omits them for a natural exit', () => {
  const natural = JSON.parse(JSON.stringify(buildTerminalExitFrame({ tabId: 'T1', _exitReason: null }, 0, [])));
  assert.deepEqual(natural, { type: 'exit', tabId: 'T1', code: 0, tokens: null });

  const killed = JSON.parse(JSON.stringify(buildTerminalExitFrame(
    { tabId: 'T1', _exitReason: { kind: 'runaway-killed', count: 127, threshold: 50, text: 'watchdog text' } },
    143,
    ['a.js'],
  )));
  assert.deepEqual(killed, {
    type: 'exit', tabId: 'T1', code: 143, tokens: null, filesRead: ['a.js'],
    reason: 'runaway-killed', reasonText: 'watchdog text',
  });
});

// (TPT9008) The start gate rethrows an agent-detection negative with its stable code, the
// detection's params and the agent id, so ws-handlers.js startFailureFrame() can send a `reason`
// the console modal translates. The English message is the detection's own sentence.
test('spawnTerminal: an unavailable agent fails the start with its detection code, params and agent id', async (t) => {
  const ptySpawn = t.mock.method(nodePty, 'spawn', () => { throw new Error('pty.spawn must not be reached'); });
  const agent = getTaskAgent('claude');
  const negative = agent.unavailableResult('cli_not_found', { detail: { bin: null, exit: null, output: '' } });
  const detect = t.mock.method(agent, 'cachedDetect', async () => negative);
  const session = createSession(null, false, 'TPT9008-tab', '');
  session.taskAgent = 'claude';
  await assert.rejects(spawnTerminal(session, 'Work on task TPT9008', 'TPT9008', [], { sessions: new Map() }), {
    message: 'Claude CLI not found. Install claude or ensure its directory is on PATH.',
    reasonCode: 'cli_not_found',
    reasonParams: { agent: 'claude' },
  });
  assert.equal(detect.mock.callCount(), 2, 'a negative is re-probed once with a cleared bin cache');
  assert.equal(ptySpawn.mock.callCount(), 0);
  // An uncoded negative (an older or third-party detect()) still fails the start, without a code.
  detect.mock.mockImplementation(async () => ({ id: 'claude', label: agent.label, available: false, reason: 'gone' }));
  await assert.rejects(spawnTerminal(session, 'Work on task TPT9008', 'TPT9008', [], { sessions: new Map() }),
    { message: 'gone', reasonCode: null, reasonParams: { agent: 'claude' } });
});

// ── Kickoff submit across a stop -> restart ──
// Drives the REAL _spawnTerminal() injection state machine (onInjectSilence + the submit
// verification) end to end with a fake node-pty and mocked timers/Date: boot output -> boot floor ->
// bracketed paste -> the `[Pasted text]` chip echo -> the Enter. `pty.spawn` is looked up on the
// module object at call time, so mocking the method on the shared require('node-pty') object is
// enough. The fake "TUI" is whatever the test feeds: silence after an Enter it dropped, or spinner
// output after one it accepted.
const SUBMIT = '\r';
const PASTE_OPEN = '\x1b[200~';
const BOOT_OUTPUT = 'Claude Code\n  ? for shortcuts';
const CHIP = '> [Pasted text #1 +42 lines]\n  ? for shortcuts';
const SPINNER = '✻ Crafting… (3s · esc to interrupt)\n';
// What a real submit paints: the chip is replaced by the transcript, then a spinner repaints.
const TURN_OUTPUT = `${'●'.repeat(1)} Reply with the single word READY.\n${'.'.repeat(SUBMIT_MARKER_TRAILING_MAX + 100)}\n${SPINNER}`;

// (TPT571) Codex's equivalents: its boot frame, its collapsed-paste chip, and what a real submit
// paints (the echoed submission row, then the Working spinner).
// (TPT9048) The READY frame: the status row under the composer names the model and effort
// (`GPT-6.1-Sol high · ~/Projects/AptRabbit`). The provisional startup frame (model `loading`,
// no such row) never receives the kickoff — see CODEX_COMPOSER_READY_RE and the TPT9048 tests.
const CODEX_BOOT = '╭─ Codex CLI ─╮\n>_ OpenAI Codex (v0.160.0)\n~/Projects/AptRabbit\nYou bring the idea. I\u2019ll bring the brackets.\n› Ask Codex to do anything\nGPT-6.1-Sol high · ~/Projects/AptRabbit · ← for agents\n';
const CODEX_CHIP = '› [Pasted Content 5120 chars]\n';
const CODEX_SPINNER = '• Working (2s • esc to interrupt)\n';
const CODEX_TURN_OUTPUT = `› Work on task TPT571\n${'.'.repeat(SUBMIT_MARKER_TRAILING_MAX + 100)}\n${CODEX_SPINNER}`;

// One spawn on a fresh session. Returns handles to feed PTY output and inspect PTY input.
async function startKickoff(t, agentId, { initialPrompt = 'Work on task TPT364', kickoffTypedLine, specExtras, sessions, captureSpawn, onDetect } = {}) {
  const writes = [];
  const sent = [];
  let dataCb = null;
  let exitCb = null;
  const fakePty = {
    pid: 424242,
    write: (d) => { writes.push(d); },
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    resize: () => {},
    kill: () => {},
  };
  t.mock.method(nodePty, 'spawn', () => fakePty);
  const agent = getTaskAgent(agentId);
  t.mock.method(agent, 'cachedDetect', async () => {
    onDetect?.(sent);
    return { id: agentId, label: agent.label, available: true };
  });
  t.mock.method(agent, 'getSpawnSpec', async (_config, prompt, taskId, opts) => {
    captureSpawn?.(agent, prompt, opts);
    return {
      command: agentId, args: [], cwd: os.tmpdir(), env: {}, initialPrompt, model: 'test-model',
      ...(kickoffTypedLine ? { kickoffTypedLine } : {}),
      ...(specExtras || {}),  // (TPT9048) e.g. kickoffFile, which turns on the Windows handoff markers
    };
  });
  const session = createSession(null, false, 'TPT364-tab', '');
  session.taskAgent = agentId;
  session.ws = { OPEN: 1, readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
  await spawnTerminal(session, 'raw prompt', 'TPT364', [], { sessions });
  assert.equal(session.alive, true, 'the fake spawn must have gone live');
  assert.equal(typeof dataCb, 'function', 'onData handler must be registered');
  const k = {
    session,
    writes,
    sent,
    exit: () => exitCb({ exitCode: 0 }),
    feed: (chunk) => dataCb(chunk),
    // Advance in small steps so timers armed by a callback that fall inside the window still fire.
    advance: (ms) => { for (let left = ms; left > 0; left -= 50) t.mock.timers.tick(Math.min(50, left)); },
    // Stop the moment `pred` holds — the chip echo must be fed right after the paste lands (as a
    // real TUI does), before the silence timer that releases the Enter can run out.
    advanceUntil: (pred, maxMs = 10_000) => {
      for (let left = maxMs; left > 0 && !pred(); left -= 50) t.mock.timers.tick(50);
      return pred();
    },
    // A TUI that keeps repainting (spinner): output every `everyMs` for `ms`.
    advanceWithOutput: (ms, chunk = SPINNER, everyMs = 200) => {
      for (let left = ms; left > 0; left -= everyMs) { dataCb(chunk); k.advance(Math.min(everyMs, left)); }
    },
    pasteWritten: () => writes.some((w) => typeof w === 'string' && w.startsWith(PASTE_OPEN)),
    pastes: () => writes.filter((w) => typeof w === 'string' && w.startsWith(PASTE_OPEN)).length,
    enters: () => writes.filter((w) => w === SUBMIT).length,
    notices: () => sent.filter((m) => m.type === 'data').map((m) => m.data).filter((d) => d.includes('[Task App]')),
    // Boot -> paste -> chip echo -> the first Enter has been written.
    reachFirstEnter: () => {
      dataCb(BOOT_OUTPUT);
      assert.equal(k.advanceUntil(k.pasteWritten), true, 'the kickoff must be pasted after the boot floor');
      assert.equal(k.enters(), 0, 'Enter must wait for the paste echo to settle');
      dataCb(CHIP);
      assert.equal(k.advanceUntil(() => k.enters() >= 1), true, 'the Enter must follow the settled paste');
    },
  };
  return k;
}
const startClaudeKickoff = (t, opts) => startKickoff(t, 'claude', opts);
const startCodexKickoff = (t, opts) => startKickoff(t, 'codex', opts);

// The teardown terminateTerminalSession() (ws-handlers.js) performs on Stop/Restart. It does NOT
// touch the submit-check timer — that one relies on its own liveness guards.
function stopSession(session) {
  clearTimeout(session._injectTimer);
  session._injectTimer = null;
  session._terminated = true;
  session.alive = false;
  session.pty = null;
}

test('agent startup reports progress before CLI detection can leave an empty terminal', async t => {
  let checked = false;
  await startKickoff(t, 'pi', { initialPrompt: '', onDetect: sent => {
    checked = true;
    assert.ok(sent.some(frame => frame.type === 'data' && /Starting .*…/.test(frame.data)));
  } });
  assert.equal(checked, true);
});

test('Windows cursor-positioned Claude folder trust never receives kickoff input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startClaudeKickoff(t);
  k.feed(cursorFrame([
    [1, 1, 'Accessing'], [1, 11, 'workspace:'],
    [3, 1, 'This'], [3, 6, 'folder'], [3, 13, 'pre-approves'], [3, 26, '4'],
    [3, 28, 'tool'], [3, 33, 'permissions'],
    [8, 1, '›'], [8, 3, 'No,'], [8, 7, 'exit'],
    [9, 3, 'Yes,'], [9, 8, 'I'], [9, 10, 'trust'], [9, 16, 'this'], [9, 21, 'folder'],
    [11, 1, 'Enter'], [11, 7, 'to'], [11, 10, 'confirm'],
  ]));
  k.advance(60_000);
  assert.equal(k.pastes(), 0, 'never paste into folder trust');
  assert.equal(k.enters(), 0, 'never confirm its default No, exit selection');
  k.feed('\x1b[2J\x1b[H' + BOOT_OUTPUT);
  assert.equal(k.advanceUntil(k.pasteWritten), true, 'send the pending task after the user finishes setup');
  stopSession(k.session);
});

test('Claude onboarding stays gated when a split repaint rolls all trust text out of the raw tail', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startClaudeKickoff(t);
  k.feed('Accessing workspace:\nYes, I trust this folder\n');
  // No quiet interval before the rest of the repaint: the dialog must latch on output.
  k.feed('x'.repeat(ATTENTION_WINDOW_BYTES + 1) + '\n› No, exit\nEnter to confirm\n');
  k.advance(60_000);
  assert.equal(k.writes.length, 0, 'loss of raw-tail text cannot grant folder trust');
  k.feed('\x1b[2J\x1b[H' + BOOT_OUTPUT);
  assert.equal(k.advanceUntil(k.pasteWritten), true);
  stopSession(k.session);
});

test('Windows Codex cursor-spaced paste chip gets a bounded submit retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startCodexKickoff(t);
  k.feed(CODEX_BOOT);
  assert.equal(k.advanceUntil(k.pasteWritten), true);
  k.feed(cursorFrame([
    [5, 1, '›'], [5, 3, '[Pasted'], [5, 11, 'Content'], [5, 19, '18800'], [5, 25, 'chars]'],
    [7, 1, 'GPT-6.1-Sol high'],
  ]));
  assert.equal(k.advanceUntil(() => k.enters() === 1), true);
  k.advance(SUBMIT_VERIFY_MS + 100);
  assert.equal(k.enters(), 2, 'the landed paste must submit without a manual Enter');
  assert.equal(k.pastes(), 1);
  k.feed(CODEX_TURN_OUTPUT);
  k.advanceWithOutput(30_000, CODEX_SPINNER);
  assert.equal(k.enters(), 2, 'stop retrying as soon as the turn runs');
});

test('Pi kickoff echo and tool output cannot approve a plan without a finished assistant transcript', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-plan-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const k = await startKickoff(t, 'pi', { initialPrompt: '' });
  k.session._transcriptHint.env.PI_CODING_AGENT_SESSION_DIR = dir;
  const file = path.join(dir, 'session.jsonl');
  const user = { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Work on task TPT364\nPlan ready.' }] } };
  const write = (...rows) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  write(user);
  k.feed('Pi v0.84.1\n' + 'Startup and echoed prompt. '.repeat(40) + '\nPlan ready.\n');
  k.advance(3000);
  assert.equal(k.sent.some(frame => frame.type === 'plan-ready'), false, 'user echo is not an assistant plan');
  assert.notEqual(k.session._attentionState?.kind, 'planReady');
  write(user, { type: 'message', message: { role: 'assistant', stopReason: 'toolUse',
    content: [{ type: 'text', text: 'Quoted example\nPlan ready.' }] } });
  k.feed('\nPlan ready.\n');
  k.advance(3000);
  assert.equal(k.sent.some(frame => frame.type === 'plan-ready'), false, 'a running tool turn is not finished');
  write(user, { type: 'message', message: { role: 'assistant', stopReason: 'stop',
    content: [{ type: 'text', text: '1. Inspect source.\n2. Fix startup.\nPlan ready.' }] } });
  k.feed('\nPlan ready.\n');
  k.advance(3000);
  assert.equal(k.sent.filter(frame => frame.type === 'plan-ready').length, 1);
  assert.equal(k.session._attentionState?.kind, 'planReady');
  write(user, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Revise that plan.' }] } });
  require('./ws-handlers').maybeRefirePlanReady(k.session, k.session.ws);
  assert.equal(k.sent.filter(frame => frame.type === 'plan-ready').length, 1, 'reconnect must not replay an answered plan');
  k.exit();
});

test('TPT364 fixture guard: the chip strings match the marker, and a real turn buries it', () => {
  const re = getTaskAgent('claude').getUnsentPasteRe();
  assert.ok(re, 'Claude must expose an unsent-paste marker');
  assert.equal(unsentPasteVisible(re, CHIP), true);
  assert.equal(unsentPasteVisible(re, '> [Pastedtext #7 +3lines]'), true, 'Ink glues words after ANSI stripping');
  assert.equal(unsentPasteVisible(re, `${CHIP}${TURN_OUTPUT}`), false, 'real output after the chip buries it');
  assert.equal(unsentPasteVisible(re, 'no chip here'), false);
  assert.equal(unsentPasteVisible(null, CHIP), false);
  // (TPT571) Codex has its own chip now; Pi (positional prompt) still has none.
  const codexRe = getTaskAgent('codex').getUnsentPasteRe();
  assert.ok(codexRe, 'Codex must expose an unsent-paste marker');
  assert.equal(unsentPasteVisible(codexRe, CODEX_CHIP), true);
  assert.equal(unsentPasteVisible(codexRe, `${CODEX_CHIP}${CODEX_TURN_OUTPUT}`), false, 'a running turn buries the chip');
  assert.equal(getTaskAgent('pi').getUnsentPasteRe(), null, 'agents without a marker never re-send Enter');
  assert.equal(getTaskAgent('pi').getEmptyComposerRe(), null);
  assert.equal(getTaskAgent('claude').getEmptyComposerRe(), null);
});

test('TPT364 control: a submit the TUI accepts is sent exactly once, never re-sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startClaudeKickoff(t);
  k.reachFirstEnter();
  k.feed(TURN_OUTPUT);                       // the TUI took the Enter: transcript + spinner
  k.advanceWithOutput(30_000);
  assert.equal(k.enters(), 1);
  assert.deepEqual(k.notices().filter((n) => /not submitted/.test(n)), []);
});

test('TPT445: kickoffTypedLine is typed as a separate write after the paste, then Enter after another silence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const LINE = 'Please carry out the task brief pasted above.';
  const k = await startClaudeKickoff(t, { kickoffTypedLine: LINE });
  k.feed(BOOT_OUTPUT);
  assert.equal(k.advanceUntil(k.pasteWritten), true);
  k.feed(CHIP);
  assert.equal(k.advanceUntil(() => k.writes.includes(LINE)), true, 'the typed line must follow the settled paste');
  assert.equal(k.enters(), 0, 'Enter must wait one more silence after the typed line');
  const pasteIdx = k.writes.findIndex((w) => typeof w === 'string' && w.startsWith(PASTE_OPEN));
  const lineIdx = k.writes.indexOf(LINE);
  assert.ok(lineIdx > pasteIdx, 'typed line comes after the paste');
  assert.ok(!LINE.includes(PASTE_OPEN) && !/[\r\n]/.test(LINE));
  assert.equal(k.advanceUntil(() => k.enters() >= 1), true, 'Enter follows the typed line');
  assert.ok(k.writes.lastIndexOf(SUBMIT) > lineIdx);
  k.feed(TURN_OUTPUT);
  k.advanceWithOutput(30_000);
  assert.equal(k.enters(), 1);
});

test('TPT364 regression: stop then restart — a restarted kickoff whose Enter is dropped is re-submitted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });

  // First start: stopped right after the paste, before its Enter went out.
  const first = await startClaudeKickoff(t);
  first.feed(BOOT_OUTPUT);
  assert.equal(first.advanceUntil(first.pasteWritten), true);
  stopSession(first.session);
  first.advance(60_000);
  assert.equal(first.enters(), 0, 'a stopped session must never write again');

  // Restart: a fresh session; the TUI swallows the first Enter and goes silent, the paste chip
  // stranded in its input box — the state the user had to fix by pressing Enter.
  const second = await startClaudeKickoff(t);
  second.reachFirstEnter();
  assert.equal(second.enters(), 1);
  second.advance(SUBMIT_VERIFY_MS + 100);
  assert.equal(second.enters(), 2, 'the stranded paste must be submitted again without the user pressing Enter');
  assert.match(second.notices().join('\n'), /typed but not submitted — pressing Enter again/);

  // ...and this time the TUI accepts it.
  second.feed(TURN_OUTPUT);
  second.advanceWithOutput(30_000);
  assert.equal(second.enters(), 2, 'no further Enters once the turn is running');
});

test('TPT364: a dropped Enter is retried at most MAX_SUBMIT_RETRIES times, then the user is told', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startClaudeKickoff(t);
  k.reachFirstEnter();
  k.advance(SUBMIT_WATCH_MS * MAX_SUBMIT_RETRIES + 60_000);   // TUI never wakes up
  assert.equal(k.enters(), 1 + MAX_SUBMIT_RETRIES);
  assert.match(k.notices().join('\n'), /press Enter to start it/);
});

test('TPT364 safety: a dialog on screen next to the stranded paste is never answered with an Enter', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startClaudeKickoff(t);
  k.reachFirstEnter();
  // A workspace-trust dialog paints after the paste; the chip is still the last thing on the tail.
  k.feed("\nQuick safety check: Is this a project you created or one you trust?\n" + CHIP);
  const gate = getAttentionPromptMatch(k.session._attentionTail, 'claude');
  assert.equal(gate && gate.kind, 'firstRun', `tail was ${JSON.stringify(k.session._attentionTail)}`);
  k.advance(60_000);
  assert.equal(k.enters(), 1, 'never press Enter into a dialog');
});

test('TPT364: a TUI that keeps animating with the chip still on the tail is not re-Entered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startClaudeKickoff(t);
  k.reachFirstEnter();
  k.advanceWithOutput(20_000, `${SPINNER}${CHIP}`, 300);   // output every 300ms: a turn is running
  assert.equal(k.enters(), 1);
});

test('TPT364: a stop during verification leaves a stray check timer that never writes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startClaudeKickoff(t);
  k.reachFirstEnter();
  assert.ok(k.session._submitCheckTimer, 'the verification is armed after the Enter');
  stopSession(k.session);                    // terminateTerminalSession() does not clear it
  k.advance(60_000);
  assert.equal(k.enters(), 1);
});

test('TPT364 guard: a gate dialog on screen BEFORE the paste still holds the paste back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startClaudeKickoff(t);
  k.feed(`${BOOT_OUTPUT}\nType something.\n4. Chat about this`);
  k.advance(5000);
  assert.equal(k.pasteWritten(), false, 'pre-paste gating must be untouched');
  assert.equal(k.enters(), 0);
});

// ── (TPT571) Codex kickoff: paste-injected like Claude's, with Codex's own markers and timing ──

test('TPT571: Codex kickoff is pasted only after its boot floor, submitted after the chip settles, no typed line', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const agent = getTaskAgent('codex');
  const k = await startCodexKickoff(t, { initialPrompt: 'Work on task TPT571' });
  k.feed(CODEX_BOOT);
  k.advance(agent.getInteractiveReadyMs() - 200);
  assert.equal(k.pasteWritten(), false, 'never paste into a still-booting ratatui composer');
  assert.equal(k.advanceUntil(k.pasteWritten, agent.getInteractiveReadyMs() + 2000), true, 'the kickoff is pasted once the floor passes');
  assert.equal(k.enters(), 0, 'Enter waits for the chip echo to settle');
  k.feed(CODEX_CHIP);
  assert.equal(k.advanceUntil(() => k.enters() >= 1), true);
  assert.ok(!k.writes.some((w) => typeof w === 'string' && !w.startsWith(PASTE_OPEN) && w !== SUBMIT),
    `only the paste and the Enter may be written for Codex: ${JSON.stringify(k.writes.map((w) => w.slice(0, 20)))}`);
  k.feed(CODEX_TURN_OUTPUT);
  k.advanceWithOutput(30_000, CODEX_SPINNER);
  assert.equal(k.enters(), 1, 'an accepted submit is never re-sent');
  assert.equal(k.pastes(), 1);
});

test('TPT571: a Codex chip stranded after the Enter gets the Enter re-sent (TPT364 parity)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startCodexKickoff(t, { initialPrompt: 'Work on task TPT571' });
  k.feed(CODEX_BOOT);
  assert.equal(k.advanceUntil(k.pasteWritten), true);
  k.feed(CODEX_CHIP);
  assert.equal(k.advanceUntil(() => k.enters() >= 1), true);
  k.advance(SUBMIT_VERIFY_MS + 100);           // silent, chip still the last thing drawn
  assert.equal(k.enters(), 2, 'the stranded paste is submitted again');
  assert.equal(k.pastes(), 1, 'a landed paste is never pasted twice');
  k.feed(CODEX_TURN_OUTPUT);
  k.advanceWithOutput(30_000, CODEX_SPINNER);
  assert.equal(k.enters(), 2);
});

test('TPT571: a paste Codex never took (empty composer after the Enter) is pasted again once, then the user is told', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startCodexKickoff(t, { initialPrompt: 'Work on task TPT571' });
  k.feed(CODEX_BOOT);
  assert.equal(k.advanceUntil(k.pasteWritten), true);
  // No chip ever echoes: the TUI dropped the paste. The composer repaints empty after the Enter.
  assert.equal(k.advanceUntil(() => k.enters() >= 1), true, 'the first Enter still goes out on silence');
  k.feed('› Ask Codex to do anything\n');
  assert.equal(k.advanceUntil(() => k.pastes() >= 2, SUBMIT_VERIFY_MS + SUBMIT_QUIET_MS + 2000), true, 'the lost kickoff is pasted again');
  assert.match(k.notices().join('\n'), /did not reach the composer — pasting it again/);
  assert.equal(k.enters(), 1, 'the re-paste settles before its own Enter');
  k.feed(CODEX_CHIP);                           // this time the chip lands
  assert.equal(k.advanceUntil(() => k.enters() >= 2), true, 'Enter follows the settled re-paste');
  k.feed(CODEX_TURN_OUTPUT);
  k.advanceWithOutput(30_000, CODEX_SPINNER);
  assert.equal(k.pastes(), 2);
  assert.equal(k.enters(), 2);
});

test('TPT571: the lost-paste re-paste is bounded — a second empty composer only produces a notice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startCodexKickoff(t, { initialPrompt: 'Work on task TPT571' });
  k.feed(CODEX_BOOT);
  assert.equal(k.advanceUntil(k.pasteWritten), true);
  assert.equal(k.advanceUntil(() => k.enters() >= 1), true);
  k.feed('› Ask Codex to do anything\n');
  assert.equal(k.advanceUntil(() => k.pastes() >= 2), true);
  assert.equal(k.advanceUntil(() => k.enters() >= 2), true);
  k.feed('› Ask Codex to do anything\n');       // dropped again
  k.advance(60_000);
  assert.equal(k.pastes(), 1 + MAX_PASTE_RETRIES);
  assert.equal(k.enters(), 2);
  assert.match(k.notices().join('\n'), /did not reach the composer — restart the task/);
});

test('TPT571: an empty composer after a turn that already ran is never re-pasted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startCodexKickoff(t, { initialPrompt: 'Work on task TPT571' });
  k.feed(CODEX_BOOT);
  assert.equal(k.advanceUntil(k.pasteWritten), true);
  k.feed(CODEX_CHIP);                           // the paste landed
  assert.equal(k.advanceUntil(() => k.enters() >= 1), true);
  // A short turn runs and ends inside the watch window; the composer is idle and empty again.
  k.feed(`${CODEX_TURN_OUTPUT}Short reply.\n› Ask Codex to do anything\n`);
  k.advance(60_000);
  assert.equal(k.pastes(), 1, 'a landed paste (chip seen) is never pasted twice');
  assert.equal(k.enters(), 1);
  assert.deepEqual(k.notices().filter((n) => /did not reach the composer/.test(n)), []);
});

test('TPT571: a Codex tool-approval dialog on the tail before the paste holds the paste back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startCodexKickoff(t, { initialPrompt: 'Work on task TPT571' });
  k.feed(`${CODEX_BOOT}bash -lc 'ls' needs your approval.\n`);
  const gate = getAttentionPromptMatch(k.session._attentionTail, 'codex');
  assert.equal(gate && gate.kind, 'toolApproval');
  // The machine-fast toolApproval cap (MAX_INJECT_DIALOG_RETRIES x INJECT_DIALOG_RETRY_MS, C880)
  // defers the paste for ~3s and then injects anyway — unchanged for Codex, now actually exercised.
  k.advance(2500);
  assert.equal(k.pasteWritten(), false, 'the toolApproval gate still defers injection for Codex');
  assert.equal(k.advanceUntil(k.pasteWritten, 10_000), true, 'a stuck dialog still injects once the cap runs out (C880)');
});

// ── (TPT9048) Windows Codex: the short file handoff never collapses into a chip, Codex paints its
// composer before the thread is started, and ConPTY drops the bracketed-paste frame. ──
const CODEX_WIN_HANDOFF = 'Work on task C1. Read the entire UTF-8 file "C:/Users/anton/AppData/Roaming/TipATask/spawn-args/2f3938e0.md", '
  + 'in chunks if needed. Treat its contents as my instructions for this task and follow them.';
const CODEX_WIN_FILE = 'C:\\Users\\anton\\AppData\\Roaming\\TipATask\\spawn-args\\2f3938e0.md';
const CODEX_WIN_TYPED = ' Begin.';
// The composer row with the handoff typed, as the ANSI-stripped stream carries it (wrapped once).
const CODEX_WIN_ROW = `› ${CODEX_WIN_HANDOFF.slice(0, 110)}\n  ${CODEX_WIN_HANDOFF.slice(110)}${CODEX_WIN_TYPED}\n`;
const CODEX_WIN_STARTUP_WAIT = 'Waiting for startup  esc cancel\n';
const CODEX_WIN_FOOTER = 'GPT-6.1-Sol high  100% context left\n';
// What a real submit paints: the echoed transcript row, then the spinner.
const CODEX_WIN_TURN = `${CODEX_WIN_ROW}${CODEX_SPINNER}`;

async function startWindowsCodexKickoff(t) {
  const agent = getTaskAgent('codex');
  // Mock once per test: re-mocking an already mocked method leaves the mock in place after
  // restoration, which would turn every later Codex test's paste into plain text.
  if (!agent.wrapsBracketedPaste.mock) t.mock.method(agent, 'wrapsBracketedPaste', () => false);
  const k = await startCodexKickoff(t, { initialPrompt: CODEX_WIN_HANDOFF, kickoffTypedLine: CODEX_WIN_TYPED, specExtras: { kickoffFile: CODEX_WIN_FILE } });
  k.handoffWritten = () => k.writes.includes(CODEX_WIN_HANDOFF);
  k.typedWritten = () => k.writes.includes(CODEX_WIN_TYPED);
  // Boot -> plain handoff write -> composer echo -> typed suffix -> its echo -> the first Enter.
  k.reachWindowsEnter = () => {
    k.feed(CODEX_BOOT);
    assert.equal(k.advanceUntil(k.handoffWritten), true, 'the handoff is written after the boot floor');
    assert.equal(k.pastes(), 0, 'no bracketed-paste frame on Windows');
    k.feed(`› ${CODEX_WIN_HANDOFF}\n`);
    assert.equal(k.advanceUntil(k.typedWritten), true, 'the typed suffix follows the settled handoff');
    k.feed(CODEX_WIN_ROW);
    assert.equal(k.advanceUntil(() => k.enters() >= 1), true, 'Enter follows the settled suffix');
    assert.equal(k.enters(), 1);
  };
  return k;
}

test('TPT9048: a Windows Codex handoff stranded on the composer row gets a bounded Enter retry, and never while queued behind startup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startWindowsCodexKickoff(t);
  k.reachWindowsEnter();
  assert.ok(k.writes.every((w) => typeof w !== 'string' || !w.startsWith(PASTE_OPEN)), 'Windows Codex writes are plain text');
  // The Enter landed in Codex's startup composer: the TUI queues it and says so. Nothing may be typed now.
  k.feed(`${CODEX_WIN_ROW}${CODEX_WIN_STARTUP_WAIT}`);
  k.advance(SUBMIT_WATCH_MS + 20_000);
  assert.equal(k.enters(), 1, 'no Enter while the submission is queued behind startup');
  assert.match(k.notices().join('\n'), /queued behind the agent's startup/);
  // Startup finished; the TUI repainted the composer with the handoff still there and no turn.
  k.feed(`\x1b[2J${CODEX_WIN_ROW}${CODEX_WIN_FOOTER}`);
  assert.equal(k.advanceUntil(() => k.enters() >= 2, 15_000), true, 'the stranded handoff is submitted again once the footer is gone and the TUI is quiet');
  assert.match(k.notices().join('\n'), /pressing Enter again/);
  assert.equal(k.pastes(), 0);
  assert.equal(k.writes.filter((w) => w === CODEX_WIN_HANDOFF).length, 1, 'the handoff is never typed twice');
  k.feed(CODEX_WIN_TURN);
  k.advanceWithOutput(30_000, CODEX_SPINNER);
  assert.equal(k.enters(), 2, 'stop retrying as soon as the turn runs');
});

test('TPT9048: the stranded-handoff Enter retry is bounded, then the user is told to press Enter', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startWindowsCodexKickoff(t);
  k.reachWindowsEnter();
  k.feed(`${CODEX_WIN_ROW}${CODEX_WIN_FOOTER}`);   // silent, text still on the composer row
  k.advance(60_000);
  assert.equal(k.enters(), 1 + MAX_SUBMIT_RETRIES);
  assert.match(k.notices().join('\n'), /press Enter to start it/);
});

test('TPT9048: an echoed handoff followed by a running turn, an empty composer or a transcript hit is never re-submitted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  for (const [label, frame] of [
    ['running turn', CODEX_WIN_TURN],
    ['echo row then empty composer', `${CODEX_WIN_ROW}› Ask Codex to do anything\n`],
  ]) {
    const k = await startWindowsCodexKickoff(t);
    k.reachWindowsEnter();
    k.feed(frame);
    k.advance(60_000);
    assert.equal(k.enters(), 1, `${label}: an accepted submit is never re-sent`);
    assert.doesNotMatch(k.notices().join('\n'), /pressing Enter again|press Enter to start it/, label);
  }
  // The screen still shows the handoff row, but the native rollout already holds the kickoff.
  const agent = getTaskAgent('codex');
  t.mock.method(agent, 'kickoffAccepted', () => true);
  const k = await startWindowsCodexKickoff(t);
  k.reachWindowsEnter();
  k.feed(`${CODEX_WIN_ROW}${CODEX_WIN_FOOTER}`);
  k.advance(60_000);
  assert.equal(k.enters(), 1, 'the transcript is the authority: no duplicate turn');
});

test('TPT9048: a dialog on the tail holds the stranded-handoff Enter back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startWindowsCodexKickoff(t);
  k.reachWindowsEnter();
  k.feed(`${CODEX_WIN_ROW}bash -lc 'ls' needs your approval.\n`);
  k.advance(SUBMIT_WATCH_MS + 5000);
  assert.equal(k.enters(), 1, 'never Enter into a tool-approval dialog');
});

test('TPT9048: a startup hold outlives the ordinary watch window but not SUBMIT_STARTUP_WAIT_MAX_MS', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startWindowsCodexKickoff(t);
  k.reachWindowsEnter();
  k.feed(`${CODEX_WIN_ROW}${CODEX_WIN_STARTUP_WAIT}`);
  k.advance(SUBMIT_WATCH_MS * 3);              // far past the ordinary 15 s window
  k.feed(`\x1b[2J${CODEX_WIN_ROW}${CODEX_WIN_FOOTER}`);
  assert.equal(k.advanceUntil(() => k.enters() >= 2, 15_000), true, 'still verified after a long startup');
  const k2 = await startWindowsCodexKickoff(t);
  k2.reachWindowsEnter();
  k2.feed(`${CODEX_WIN_ROW}${CODEX_WIN_STARTUP_WAIT}`);
  k2.advance(SUBMIT_STARTUP_WAIT_MAX_MS + 5000);
  k2.feed(`\x1b[2J${CODEX_WIN_ROW}${CODEX_WIN_FOOTER}`);
  k2.advance(30_000);
  assert.equal(k2.enters(), 1, 'a hold past the ceiling is given up, not retried');
});

test('TPT9048: a manual Enter from the user cancels the automatic submit retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startWindowsCodexKickoff(t);
  k.reachWindowsEnter();
  k.feed(`${CODEX_WIN_ROW}${CODEX_WIN_FOOTER}`);
  handleTerminalInput(k.session, '\r');
  assert.equal(k.enters(), 2, 'the user\'s own Enter went through');
  k.advance(60_000);
  assert.equal(k.enters(), 2, 'no automatic Enter follows the user\'s');
  assert.doesNotMatch(k.notices().join('\n'), /pressing Enter again/);
});

test('TPT9048: the composer-ready marker holds the Codex kickoff back, bounded by getComposerReadyMaxMs()', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const agent = getTaskAgent('codex');
  // The real marker is the status row (CODEX_COMPOSER_READY_RE, covered in prompt-detect.test.js);
  // a synthetic one isolates the injector's gate from the fixture's own status row.
  t.mock.method(agent, 'getComposerReadyRe', () => /COMPOSER_READY_MARKER/);
  t.mock.method(agent, 'getComposerReadyMaxMs', () => 90_000);
  const k = await startCodexKickoff(t, { initialPrompt: 'Work on task TPT9048' });
  k.feed(CODEX_BOOT);
  k.advance(20_000);
  assert.equal(k.pasteWritten(), false, 'a composer without its ready marker gets no kickoff');
  assert.match(k.notices().join('\n'), /still starting/);
  k.feed('COMPOSER_READY_MARKER\n');
  assert.equal(k.advanceUntil(k.pasteWritten, 3000), true, 'the kickoff follows the marker promptly');
  const k2 = await startCodexKickoff(t, { initialPrompt: 'Work on task TPT9048' });
  k2.feed(CODEX_BOOT);
  k2.advance(89_000);
  assert.equal(k2.pasteWritten(), false);
  assert.equal(k2.advanceUntil(k2.pasteWritten, 5000), true, 'past the ceiling the kickoff is pasted anyway');
  // The marker is painted once; ConPTY's blank-row repaints then push it out of the 1024-byte
  // tail before the paste check runs. The latch must remember it.
  const k3 = await startCodexKickoff(t, { initialPrompt: 'Work on task TPT9048' });
  k3.feed(CODEX_BOOT);
  k3.feed('COMPOSER_READY_MARKER\n');
  k3.feed(`${' '.repeat(120)}\r\n`.repeat(20));           // > ATTENTION_WINDOW_BYTES of blank rows
  assert.doesNotMatch(k3.session._attentionTail, /COMPOSER_READY_MARKER/, 'the marker has left the tail');
  assert.equal(k3.advanceUntil(k3.pasteWritten, agent.getInteractiveReadyMs() + 3000), true, 'a marker seen earlier still releases the kickoff');
});

test('TPT571: a "Plan ready." row painted before the kickoff Enter never flips codexPlanReady', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const k = await startCodexKickoff(t, { initialPrompt: 'Work on task TPT571' });
  k.session.terminalPhase = 'planning';
  k.session.buffer = 'x'.repeat(600);
  k.feed(`${CODEX_BOOT}Plan ready.\n`);      // the echoed kickoff instruction, pre-submit
  k.advance(CODEX_PLAN_QUIET_MS + 500);
  assert.equal(k.session.codexPlanReady, false, 'nothing before the Enter is a real plan');
  assert.equal(k.session.agentPlanReady, false);
  assert.ok(!k.sent.some((m) => m.type === 'plan-ready'), 'no plan-ready frame before the kickoff is submitted');
  assert.equal(k.advanceUntil(k.pasteWritten), true);
  k.feed(CODEX_CHIP);
  assert.equal(k.advanceUntil(() => k.enters() >= 1), true);
  assert.equal(k.session.codexPlanReady, false, 'the stale pre-submit candidate is not promoted by the Enter');
  k.feed(CODEX_TURN_OUTPUT);
  k.advanceWithOutput(3_000, CODEX_SPINNER);
  k.feed('Plan ready.\n');                    // the genuine sentinel, post-submit
  k.advance(CODEX_PLAN_QUIET_MS + 500);
  assert.equal(k.session.codexPlanReady, true, 'the real sentinel after the submit still confirms');
  assert.ok(k.sent.some((m) => m.type === 'plan-ready' && m.codexPlanReady === true));
});

// ── The kickoff's comments block on a restart ──
// A restart is the only start whose task already carries the previous run's auto-posted exit
// comment. Its terminal-tail form is raw TUI text and must never reach the next kickoff.

const NOISY_TAIL = [
  '\x1b]0;◐ fix-restart-submit\x07\x1b[2K✻ Sock-hopping…\r\n',
  'Do you want to proceed?\r\n',
  '❯ 1. Yes\r\n  2. Yes, and don\'t ask again for npm test commands\r\n  3. No, and tell Claude what to do differently\r\n',
  'Type something.\r\n4. Chat about this\r\n',
].join('');

function makeCommentFixtures() {
  const tail = buildExitResolutionComment({ reason: 'user-terminated', exitCode: null, finalMessage: '', buffer: NOISY_TAIL });
  const finalMsg = buildExitResolutionComment({
    reason: 'user-terminated', exitCode: null, buffer: NOISY_TAIL,
    finalMessage: 'I finished the parser change and stopped before wiring the route.',
  });
  assert.equal(tail.source, 'tail', 'fixture must be the tail form');
  assert.equal(finalMsg.source, 'final-message', 'fixture must be the final-message form');
  return {
    spec: { id: 10, type: 'spec', content: 'Original objective text.', created_at: '2026-09-26T10:00:00.000Z', user: { name: 'Anton' } },
    note: { id: 11, type: 'comment', content: 'Please keep the API unchanged.', created_at: '2026-09-26T10:05:00.000Z', user: { name: 'Anton' } },
    finalMsgExit: { id: 12, type: 'resolution', content: finalMsg.content, created_at: '2026-09-26T10:30:00.000Z', user: { name: 'Anton' } },
    tailExit: { id: 13, type: 'resolution', content: tail.content, created_at: '2026-09-26T10:31:00.000Z', user: { name: 'Anton' } },
  };
}

test('TPT364 fetchTaskCommentsContext leaves the previous run\'s terminal-tail exit comment out of the block', async () => {
  const f = makeCommentFixtures();
  const backend = { getTaskComments: async () => [f.spec, f.note, f.finalMsgExit, f.tailExit] };
  const { block } = await fetchTaskCommentsContext(backend, 'TPT364');
  assert.match(block, /Original objective text\./);
  assert.match(block, /Please keep the API unchanged\./);
  assert.match(block, /I finished the parser change and stopped before wiring the route\./, 'a final-message exit comment is real context and stays');
  assert.doesNotMatch(block, /Sock-hopping|Chat about this|Type something|don't ask again/, 'no terminal screen text may reach the kickoff');
  assert.equal((block.match(/tipatask:agent-exit/g) || []).length, 1, 'only the kept final-message exit comment remains — the omitted one leaves no stub behind');
});

test('TPT364 fetchTaskCommentsContext: the baseline still counts the omitted comment', async () => {
  const f = makeCommentFixtures();
  const backend = { getTaskComments: async () => [f.spec, f.note, f.finalMsgExit, f.tailExit] };
  const { baselineId } = await fetchTaskCommentsContext(backend, 'TPT364');
  assert.equal(baselineId, 13, 'the exit comment id (13) is the watermark, so it is never mistaken for a comment posted during the new run');
});

test('TPT364 fetchTaskCommentsContext: tasks without an exit comment get the block byte-for-byte as before', async () => {
  const f = makeCommentFixtures();
  const comments = [f.spec, f.note, f.finalMsgExit];
  const { block } = await fetchTaskCommentsContext({ getTaskComments: async () => comments }, 'TPT364');
  assert.equal(block, BaseTaskAgent.formatTaskCommentsBlock(comments));
});

test('TPT364 a restart\'s kickoff prompt is identical to the first start\'s once the prior run\'s tail comment exists', async () => {
  const f = makeCommentFixtures();
  const agent = getTaskAgent('claude');
  const first = await fetchTaskCommentsContext({ getTaskComments: async () => [f.spec, f.note] }, 'TPT364');
  const restart = await fetchTaskCommentsContext({ getTaskComments: async () => [f.spec, f.note, f.tailExit] }, 'TPT364');
  const promptOf = (block) => agent.buildPrompt('Work on task TPT364', { taskCommentsBlock: block, taskTags: ['tt-claude-session-terminal'] });
  assert.equal(promptOf(restart.block), promptOf(first.block));
  assert.notEqual(restart.baselineId, first.baselineId, 'only the watermark differs between the two starts');
});

test('TPT364 fetchTaskCommentsContext stays fail-open: no backend, a throwing backend and a non-array result never throw', async () => {
  assert.deepEqual(await fetchTaskCommentsContext(null, 'TPT364'), { block: '', baselineId: null });
  assert.deepEqual(await fetchTaskCommentsContext({ getTaskComments: async () => { throw new Error('boom'); } }, 'TPT364'), { block: '', baselineId: null });
  const r = await fetchTaskCommentsContext({ getTaskComments: async () => null }, 'TPT364');
  assert.equal(r.block, '');
  assert.equal(r.baselineId, null);
});


test('terminal kickoff scales the prompt cap against live sessions across projects', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const sessions = new Map([
    ['chat', { type: 'objective', alive: true, ptyPid: 1 }],
    ['dead', { type: 'terminal', alive: false, ptyPid: 2 }],
    ['queued', { type: 'terminal', alive: false, _queued: true }],
  ]);
  const captures = [];
  const captureSpawn = (agent, prompt, opts) => captures.push({
    limits: opts.agentLimits,
    prompt: agent.buildPrompt(prompt, opts),
  });
  const first = await startClaudeKickoff(t, { sessions, captureSpawn });
  t.after(() => stopSession(first.session));
  first.session.projectPath = '/other-project';
  sessions.set('first', first.session);
  const second = await startClaudeKickoff(t, { sessions, captureSpawn });
  t.after(() => stopSession(second.session));
  const base = require('./process-group').resolveAgentLimits(config.PROJECT_ROOT);
  const scaled = require('./process-group').scaleAgentLimitsForConcurrency;
  assert.deepEqual(captures[0].limits, scaled(base, 1));
  assert.deepEqual(captures[1].limits, scaled(base, 2));
  assert.ok(captures[1].limits.maxSubagents < captures[0].limits.maxSubagents);
  for (const [i, kickoff] of [first, second].entries()) {
    assert.match(captures[i].prompt, new RegExp(`at most ${captures[i].limits.maxSubagents} sub-agents`));
    assert.equal(kickoff.session.descendantWatchdog.threshold, captures[i].limits.warnDescendants);
  }
});

test('terminal spawn and natural exit notify memory lifetime tracker exactly once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { setSessionMemoryTracker } = require('./session-memory');
  const calls = [];
  setSessionMemoryTracker({ begin: s => calls.push(['start', s]), end: (s, reason) => calls.push([reason, s]) });
  t.after(() => setSessionMemoryTracker(null));
  const k = await startClaudeKickoff(t);
  t.after(() => stopSession(k.session));
  assert.deepEqual(calls, [['start', k.session]]);
  k.exit();
  assert.deepEqual(calls, [['start', k.session], ['exited', k.session]]);
  assert.equal(k.session.ptyPid, null);
});

// ── Idle completion nudge (TPT612) ──
const NUDGE_ROLES = { start: 'pending', in_progress: 'in_progress', complete: 'completed', canceled: 'canceled' };
const NUDGE_VCS = { type: 'git', worktree: false, commit: true, pr: false, merge: false };
function makeNudgeSession(overrides = {}) {
  const writes = [];
  const session = {
    type: 'terminal', alive: true, taskId: 'TPT1', taskAgent: 'codex', terminalPhase: 'executing',
    _injectDone: true, lastOutputAt: Date.now() - 120000, nudgeCount: 0, _nudgeTypedLine: '',
    pty: { write: (d) => writes.push(d) }, ...overrides,
  };
  return { session, writes };
}
function nudgeBackend(status = 'in_progress') {
  return { getTask: async (id) => ({ id, status }) };
}
function nudgeDeps(check, calls = []) {
  return {
    fetchStatusRoles: async () => NUDGE_ROLES,
    checkTaskCommit: async (args) => { calls.push(args); return check; },
  };
}
const MISSING_CHECK = { verified: true, vcs: NUDGE_VCS, ready: false, blockers: [{ code: 'TASK_COMMIT_MISSING', message: 'no commit starting with TPT1' }] };

test('maybeNudgeIdleSession: in-progress task without its commit gets one pasted nudge per idle period, max 2', async (t) => {
  const { session, writes } = makeNudgeSession();
  t.after(() => { session.alive = false; });
  const calls = [];
  const opts = { backend: nudgeBackend(), projectRoot: '/p', deps: nudgeDeps(MISSING_CHECK, calls) };
  let r = await maybeNudgeIdleSession(session, opts);
  assert.equal(r.nudged, true);
  assert.equal(session.nudgeCount, 1);
  assert.equal(writes.length, 1, 'paste is written at once on an idle PTY');
  assert.match(writes[0], /^\x1b\[200~\[Tipatask\] Task TPT1 is still in progress/);
  assert.match(writes[0], /call complete_task\(TPT1, resolution\).*\x1b\[201~$/);
  assert.deepEqual(calls[0], { backend: opts.backend, projectRoot: '/p', taskId: 'TPT1' });

  r = await maybeNudgeIdleSession(session, opts);
  assert.equal(r.reason, 'already_checked', 'same idle period is never re-checked');
  assert.equal(calls.length, 1);

  session.lastOutputAt -= 1; // a new idle period
  assert.equal((await maybeNudgeIdleSession(session, opts)).nudged, true);
  assert.equal(session.nudgeCount, 2);
  session.lastOutputAt -= 1;
  assert.equal((await maybeNudgeIdleSession(session, opts)).reason, 'max_nudges');
  assert.equal(calls.length, 2);
});

test('maybeNudgeIdleSession: closed status, planning phase, commits off and unknown verification never nudge', async () => {
  for (const status of ['completed', 'canceled', 'on_fire']) {
    const { session, writes } = makeNudgeSession();
    const calls = [];
    const r = await maybeNudgeIdleSession(session, { backend: nudgeBackend(status), deps: nudgeDeps(MISSING_CHECK, calls) });
    assert.equal(r.reason, 'not_in_progress', status);
    assert.equal(calls.length, 0, `${status}: no git check`);
    assert.deepEqual(writes, []);
    assert.equal(session.nudgeCount, 0);
  }
  for (const overrides of [{ terminalPhase: 'planning' }, { _injectDone: false }, { _completionEmitted: true }, { _pause: { at: 1 } }, { alive: false }]) {
    const { session, writes } = makeNudgeSession(overrides);
    const r = await maybeNudgeIdleSession(session, { backend: nudgeBackend(), deps: nudgeDeps(MISSING_CHECK) });
    assert.equal(r.nudged, false, JSON.stringify(overrides));
    assert.deepEqual(writes, []);
  }
  for (const check of [
    { ...MISSING_CHECK, vcs: { ...NUDGE_VCS, commit: false }, blockers: [] },
    { verified: false, vcs: NUDGE_VCS, ready: false, blockers: [{ code: 'settings_unavailable' }] },
    { ...MISSING_CHECK, blockers: [{ code: 'git_verification_failed' }] },
  ]) {
    const { session, writes } = makeNudgeSession();
    assert.equal((await maybeNudgeIdleSession(session, { backend: nudgeBackend(), deps: nudgeDeps(check) })).nudged, false);
    assert.deepEqual(writes, []);
  }
  const { session } = makeNudgeSession();
  const throwing = { getTask: async () => { throw new Error('offline'); } };
  assert.equal((await maybeNudgeIdleSession(session, { backend: throwing, deps: nudgeDeps(MISSING_CHECK) })).reason, 'error');
  assert.equal(session._nudgeInFlight, false);
});

test('maybeNudgeIdleSession: output during the async check cancels the nudge', async () => {
  const { session, writes } = makeNudgeSession();
  const deps = nudgeDeps(MISSING_CHECK);
  const inner = deps.checkTaskCommit;
  deps.checkTaskCommit = async (a) => { session.lastOutputAt = Date.now(); return inner(a); };
  assert.equal((await maybeNudgeIdleSession(session, { backend: nudgeBackend(), deps })).reason, 'resumed');
  assert.deepEqual(writes, []);
  assert.equal(session.nudgeCount, 0);
});

test('maybeNudgeIdleSession: a reachable <KEY>: commit (real Git fixture) gets the completion-only nudge', async (t) => {
  const fx = require('./git-merge/test-fixture');
  fx.applyFixtureEnvToProcess();
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const row = { id: 7, vcs_type: 'git', vcs_worktree_enabled: 0, vcs_commit_enabled: 1, vcs_pr_enabled: 0, vcs_merge_enabled: 0 };
  const backend = {
    getCredentials: () => ({ projectId: 7 }),
    async getProjectSettings() { return { ...row }; },
    async getTask(id) { return { id, status: 'in_progress' }; },
  };
  const deps = { fetchStatusRoles: async () => NUDGE_ROLES };
  const { session, writes } = makeNudgeSession({ projectPath: f.root });
  t.after(() => { session.alive = false; });
  const first = await maybeNudgeIdleSession(session, { backend, deps });
  assert.equal(first.kind, 'commit', 'no TPT1 commit yet');
  writes.length = 0;
  fx.commit(f.git, f.nested, { 'src/fix1.js': 'fix\n' }, 'TPT1: Fix the nested server');
  session.lastOutputAt -= 1;
  const r = await maybeNudgeIdleSession(session, { backend, deps });
  assert.equal(r.kind, 'complete', 'commit reachable, completion call still missing');
  assert.equal(writes.length, 1);
  assert.match(writes[0], /TPT1 is still in progress and its completion check passes/);
  assert.doesNotMatch(writes[0], /commit/i);
  assert.equal(session.nudgeCount, 2);
});

// ── Completion-only nudge (TPT650) ──
const READY_CHECK = { verified: true, vcs: NUDGE_VCS, ready: true, blockers: [] };

test('maybeNudgeIdleSession: ready verification with an in-progress task gets the completion-only nudge in any project', async (t) => {
  for (const vcs of [NUDGE_VCS, { ...NUDGE_VCS, commit: false }, { type: 'off', worktree: false, commit: false, pr: false, merge: false }]) {
    const { session, writes } = makeNudgeSession();
    t.after(() => { session.alive = false; });
    const r = await maybeNudgeIdleSession(session, { backend: nudgeBackend(), deps: nudgeDeps({ ...READY_CHECK, vcs }) });
    assert.deepEqual(r, { nudged: true, reason: 'nudged', kind: 'complete' }, JSON.stringify(vcs));
    assert.equal(session.nudgeCount, 1);
    assert.equal(writes.length, 1);
    assert.match(writes[0], /^\x1b\[200~\[Tipatask\] Task TPT1 is still in progress and its completion check passes/);
    assert.match(writes[0], /call complete_task\(TPT1, resolution\).*\x1b\[201~$/);
    assert.doesNotMatch(writes[0], /commit/i);
  }
  // Same MAX_NUDGES budget and once-per-idle-period gate as the blocker nudge.
  const { session, writes } = makeNudgeSession();
  t.after(() => { session.alive = false; });
  const opts = { backend: nudgeBackend(), deps: nudgeDeps(READY_CHECK) };
  assert.equal((await maybeNudgeIdleSession(session, opts)).kind, 'complete');
  assert.equal((await maybeNudgeIdleSession(session, opts)).reason, 'already_checked');
  session.lastOutputAt -= 1;
  assert.equal((await maybeNudgeIdleSession(session, opts)).kind, 'complete');
  session.lastOutputAt -= 1;
  assert.equal((await maybeNudgeIdleSession(session, opts)).reason, 'max_nudges');
  assert.equal(writes.length, 2);
});

test('maybeNudgeIdleSession: a completed task or an unverified ready read gets no completion nudge', async () => {
  for (const status of ['completed', 'canceled', 'on_fire']) {
    const { session, writes } = makeNudgeSession();
    const calls = [];
    const r = await maybeNudgeIdleSession(session, { backend: nudgeBackend(status), deps: nudgeDeps(READY_CHECK, calls) });
    assert.equal(r.reason, 'not_in_progress', status);
    assert.equal(calls.length, 0);
    assert.deepEqual(writes, []);
  }
  const { session, writes } = makeNudgeSession();
  const r = await maybeNudgeIdleSession(session, { backend: nudgeBackend(), deps: nudgeDeps({ ...READY_CHECK, verified: false }) });
  assert.equal(r.reason, 'no_nudge_needed');
  assert.deepEqual(writes, []);
});

// ── Exit backstop (TPT613) ──
function exitRun(overrides = {}) {
  return { type: 'terminal', taskId: 'TPT1', projectPath: '/projects/a', agent: 'claude', executing: true, nudgeCount: 1, spawnedAt: 111, ...overrides };
}
const EXIT_STATUSES = [{ name: 'pending' }, { name: 'in_progress', is_in_progress: true }, { name: 'on_fire' }, { name: 'completed', is_workflow_complete: true }];
// Every write lands in `log`, in order. The first getTask returns `status`, later ones `freshStatus`.
function exitBackstopFakes({ status = 'in_progress', freshStatus = status, statuses = EXIT_STATUSES, check = MISSING_CHECK, statusesThrow = false } = {}) {
  const log = [];
  const checks = [];
  let reads = 0;
  const backend = {
    async getTask(id) { reads++; return { id, status: reads === 1 ? status : freshStatus }; },
    async getStatuses(opts) { log.push(['getStatuses', opts]); if (statusesThrow) throw new Error('offline'); return statuses; },
    async updateTask(id, fields) { log.push(['updateTask', id, fields]); return { id, ...fields }; },
    async createTaskComment(id, content, type) { log.push(['comment', id, content, type]); return { id: 1 }; },
  };
  const deps = {
    fetchStatusRoles: async () => NUDGE_ROLES,
    checkTaskCommit: async (args) => { checks.push(args); return check; },
    websocket: {
      emitTaskUpdated: (task, opts, projectPath) => log.push(['task:updated', task, projectPath]),
      emitTaskLeftUncommitted: (projectPath, taskKey, blockers, extra) => log.push(['frame', projectPath, taskKey, blockers, extra]),
    },
    // (TPT664) the server-side flag registry every window rebuilds from
    leftUncommitted: { record: (projectPath, taskKey, entry) => log.push(['record', projectPath, taskKey, entry]) },
  };
  return { backend, deps, log, checks };
}

test('flagTaskLeftUncommitted: an executing run that left its task in progress without the commit gets on_fire, a comment and a frame, in that order', async () => {
  const f = exitBackstopFakes();
  const r = await flagTaskLeftUncommitted(exitRun(), { backend: f.backend, projectRoot: '/p', reason: 'user-terminated', deps: f.deps });
  assert.equal(r.flagged, true);
  assert.equal(r.status, 'on_fire');
  assert.deepEqual(f.checks, [{ backend: f.backend, projectRoot: '/p', taskId: 'TPT1' }]);
  assert.deepEqual(f.log.map(e => e[0]), ['getStatuses', 'updateTask', 'task:updated', 'comment', 'record', 'frame']);
  assert.deepEqual(f.log[0][1], { refresh: true, strict: true }, 'on_fire only from the strict registry');
  assert.deepEqual(f.log[1].slice(1), ['TPT1', { status: 'on_fire' }]);
  assert.equal(f.log[2][2], '/projects/a', 'task:updated is project-scoped');
  const [, id, content, type] = f.log[3];
  assert.equal(id, 'TPT1');
  assert.equal(type, 'resolution');
  assert.match(content, /^Agent exited without committing \/ completing: no task commit found\n\n- no commit starting with TPT1\n\n/);
  assert.match(content, /terminated by the user while the task was still in_progress, after 1 idle completion nudge\. .*Status set to on_fire\.$/);
  // (TPT664) Recorded server-side before the frame, under the run's project, with the closed role
  // names a later task:updated is judged against — never a hardcoded literal.
  const [, recProject, recKey, rec] = f.log[4];
  assert.equal(recProject, '/projects/a');
  assert.equal(recKey, 'TPT1');
  assert.deepEqual({ ...rec, at: 0 }, { exitId: 'TPT1@111', blockers: [{ code: 'TASK_COMMIT_MISSING', message: 'no commit starting with TPT1' }],
    status: 'on_fire', agent: 'claude', nudgeCount: 1, at: 0, closedNames: [NUDGE_ROLES.complete, NUDGE_ROLES.canceled] });
  assert.ok(rec.at > 0);
  assert.deepEqual(f.log[5].slice(1), ['/projects/a', 'TPT1',
    [{ code: 'TASK_COMMIT_MISSING', message: 'no commit starting with TPT1' }],
    { status: 'on_fire', nudgeCount: 1, agent: 'claude', exitId: 'TPT1@111' }]);
});

test('flagTaskLeftUncommitted: nothing is recorded server-side unless the frame goes out; spawnTerminal() retires the flag for a new run', async () => {
  const f = exitBackstopFakes();
  assert.equal((await flagTaskLeftUncommitted(exitRun(), { backend: f.backend, deps: f.deps, isSuperseded: () => true })).reason, 'superseded');
  assert.equal(f.log.some(e => e[0] === 'record'), false);
  const g = exitBackstopFakes({ check: { verified: true, vcs: NUDGE_VCS, ready: true, blockers: [] } });
  await flagTaskLeftUncommitted(exitRun(), { backend: g.backend, deps: g.deps });
  assert.equal(g.log.some(e => e[0] === 'record'), false);
  // _spawnTerminal() is not unit-runnable (CLI detection, token gate); pin the wrapper's clear by source.
  const src = require('node:fs').readFileSync(require.resolve('./terminal-session'), 'utf8');
  const wrapper = src.slice(src.indexOf('async function spawnTerminal('), src.indexOf('async function _spawnTerminal('));
  assert.match(wrapper, /require\('\.\/left-uncommitted'\)\.clear\(session\.projectPath, taskId\)/);
  assert.match(wrapper, /emitTaskLeftUncommitted\(session\.projectPath, taskId, \[\], \{ cleared: true, exitId: removed\.exitId \}\)/);
});

test('flagTaskLeftUncommitted: a clean commit posts nothing', async () => {
  const f = exitBackstopFakes({ check: { verified: true, vcs: NUDGE_VCS, ready: true, blockers: [] } });
  assert.deepEqual(await flagTaskLeftUncommitted(exitRun(), { backend: f.backend, deps: f.deps }), { flagged: false, reason: 'no_flag_needed' });
  assert.equal(f.checks.length, 1);
  assert.deepEqual(f.log, [], 'no status write, no comment, no frame');
});

test('flagTaskLeftUncommitted: a closed or blocked task never reads Git; planning, completed, objective close and unknown checks never flag', async () => {
  for (const status of ['completed', 'canceled', 'on_fire', 'pending']) {
    const f = exitBackstopFakes({ status });
    assert.equal((await flagTaskLeftUncommitted(exitRun(), { backend: f.backend, deps: f.deps })).reason, 'not_in_progress', status);
    assert.equal(f.checks.length, 0, `${status}: no git check`);
    assert.deepEqual(f.log, []);
  }
  for (const [run, opts, reason] of [
    [exitRun({ executing: false }), {}, 'not_executing'],
    [exitRun({ type: 'taskChat' }), {}, 'not_task_terminal'],
    [exitRun(), { reason: 'completed' }, 'not_abandoned'],
    [exitRun(), { reason: 'user-terminated', terminateReason: 'objective-closed' }, 'not_abandoned'],
  ]) {
    const f = exitBackstopFakes();
    assert.equal((await flagTaskLeftUncommitted(run, { backend: f.backend, deps: f.deps, ...opts })).reason, reason);
    assert.equal(f.checks.length, 0);
    assert.deepEqual(f.log, []);
  }
  for (const check of [
    { verified: false, vcs: NUDGE_VCS, ready: false, blockers: [{ code: 'settings_unavailable' }] },
    { ...MISSING_CHECK, vcs: { ...NUDGE_VCS, commit: false } },
    { ...MISSING_CHECK, blockers: [...MISSING_CHECK.blockers, { code: 'git_verification_failed' }] },
  ]) {
    const f = exitBackstopFakes({ check });
    assert.equal((await flagTaskLeftUncommitted(exitRun(), { backend: f.backend, deps: f.deps })).flagged, false);
    assert.deepEqual(f.log, []);
  }
  assert.equal((await flagTaskLeftUncommitted(exitRun(), { backend: null })).reason, 'no_backend');
  const offline = exitBackstopFakes();
  offline.backend.getTask = async () => { throw new Error('offline'); };
  assert.equal((await flagTaskLeftUncommitted(exitRun(), { backend: offline.backend, deps: offline.deps })).reason, 'error');
});

test('flagTaskLeftUncommitted: a newer run, or a status the user changed meanwhile, wins: nothing is written', async () => {
  const f = exitBackstopFakes();
  assert.equal((await flagTaskLeftUncommitted(exitRun(), { backend: f.backend, deps: f.deps, isSuperseded: () => true })).reason, 'superseded');
  assert.deepEqual(f.log.map(e => e[0]), ['getStatuses']);
  const g = exitBackstopFakes({ freshStatus: 'completed' });
  assert.equal((await flagTaskLeftUncommitted(exitRun(), { backend: g.backend, deps: g.deps })).reason, 'status_changed');
  assert.deepEqual(g.log.map(e => e[0]), ['getStatuses']);
});

test('flagTaskLeftUncommitted: no on_fire status, an unreadable registry or a failed status write leave the status alone; comment and frame still go out', async () => {
  for (const opts of [{ statuses: [{ name: 'in_progress' }, { name: 'completed' }] }, { statusesThrow: true }]) {
    const f = exitBackstopFakes(opts);
    const r = await flagTaskLeftUncommitted(exitRun(), { backend: f.backend, deps: f.deps, reason: 'user-terminated' });
    assert.equal(r.flagged, true);
    assert.equal(r.status, 'in_progress');
    assert.deepEqual(f.log.map(e => e[0]), ['getStatuses', 'comment', 'record', 'frame']);
    assert.doesNotMatch(f.log[1][2], /on_fire/, 'the comment never claims a status it did not set');
    assert.equal(f.log[2][3].status, 'in_progress', 'the registry entry carries the status actually left');
    assert.equal(f.log[3][4].status, 'in_progress');
  }
  const h = exitBackstopFakes();
  h.backend.updateTask = async () => { throw new Error('400 invalid status'); };
  assert.equal((await flagTaskLeftUncommitted(exitRun(), { backend: h.backend, deps: h.deps })).flagged, true);
  assert.deepEqual(h.log.map(e => e[0]), ['getStatuses', 'comment', 'record', 'frame']);
  assert.doesNotMatch(h.log[1][2], /on_fire/);
});

test('exitRunSnapshot: reads the run that just ended', () => {
  assert.deepEqual(
    exitRunSnapshot({ type: 'terminal', taskId: 'TPT1', projectPath: '/a', taskAgent: 'codex', terminalPhase: 'executing', _injectDone: true, nudgeCount: 2, _transcriptHint: { spawnedAt: 5 } }),
    { type: 'terminal', taskId: 'TPT1', projectPath: '/a', agent: 'codex', executing: true, nudgeCount: 2, spawnedAt: 5 });
  assert.equal(exitRunSnapshot({ type: 'terminal', terminalPhase: 'planning', _injectDone: true }).executing, false);
  assert.equal(exitRunSnapshot({ type: 'terminal', terminalPhase: 'executing', _injectDone: false }).executing, false);
});

test('flagTaskLeftUncommitted: real Git fixture — no task commit flags the task, a reachable <KEY>: commit posts nothing', async (t) => {
  const fx = require('./git-merge/test-fixture');
  fx.applyFixtureEnvToProcess();
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const row = { id: 7, vcs_type: 'git', vcs_worktree_enabled: 0, vcs_commit_enabled: 1, vcs_pr_enabled: 0, vcs_merge_enabled: 0 };
  const posted = [];
  const frames = [];
  const backend = {
    getCredentials: () => ({ projectId: 7 }),
    async getProjectSettings() { return { ...row }; },
    async getTask(id) { return { id, status: 'in_progress' }; },
    async getStatuses() { return [{ name: 'in_progress' }, { name: 'on_fire' }]; },
    async updateTask(id, fields) { posted.push(['status', fields.status]); return { id, ...fields }; },
    async createTaskComment(id, content) { posted.push(['comment', content]); },
  };
  const deps = { fetchStatusRoles: async () => NUDGE_ROLES, websocket: { emitTaskUpdated() {}, emitTaskLeftUncommitted: (...a) => frames.push(a) } };
  const run = exitRun({ projectPath: f.root });
  assert.equal((await flagTaskLeftUncommitted(run, { backend, deps, reason: 'user-terminated' })).flagged, true, 'no TPT1 commit yet');
  assert.deepEqual(posted.map(p => p[0]), ['status', 'comment']);
  assert.equal(frames.length, 1);
  posted.length = 0;
  frames.length = 0;
  fx.commit(f.git, f.nested, { 'src/fix1.js': 'fix\n' }, 'TPT1: Fix the nested server');
  assert.equal((await flagTaskLeftUncommitted(run, { backend, deps, reason: 'user-terminated' })).reason, 'no_flag_needed');
  assert.deepEqual(posted, []);
  assert.deepEqual(frames, []);
});

test('pasteAndSubmit: paste, then typed line, then Enter, each after a silence window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const writes = [];
  const session = { alive: true, lastOutputAt: 0, pty: { write: (d) => { writes.push(d); session.lastOutputAt = Date.now(); } } };
  const agent = { getPasteSilenceMs: () => 400 };
  pasteAndSubmit(session, agent, 'Finish the task.', 'Please finish the steps pasted above.');
  assert.deepEqual(writes, ['\x1b[200~Finish the task.\x1b[201~']);
  t.mock.timers.tick(399);
  assert.equal(writes.length, 1, 'waits for the echo to settle');
  t.mock.timers.tick(1);
  assert.deepEqual(writes.slice(1), ['Please finish the steps pasted above.']);
  t.mock.timers.tick(400);
  assert.deepEqual(writes.slice(2), ['\r']);
  const late = { alive: true, lastOutputAt: 0, pty: { write: (d) => writes.push(d) } };
  const before = writes.length;
  pasteAndSubmit(late, agent, 'x');
  late.alive = false;
  t.mock.timers.tick(5000);
  assert.equal(writes.length, before + 1, 'a stopped session gets no Enter');
});

// ── In-TUI plan approval (TPT654) ──
// A plan approved inside the agent's own TUI (Claude's ExitPlanMode dialog answered in the xterm,
// a typed go-ahead to Codex/Pi) must flip terminalPhase exactly like approvePlan() does, because
// the idle nudge and the exit backstop above only act on an executing run. Claude cases replay
// recorded PTY output (fixtures/attention/claude-plan-*.jsonl); Codex/Pi cases latch plan-ready
// the way the existing plan-ready tests do and then type into the composer.

function tuiSession(agentId, overrides = {}) {
  const { session, events } = makeAttentionSession();
  const messages = [];
  Object.assign(session, {
    type: 'terminal', taskId: 'TPT1', tabId: 'TPT1', taskAgent: agentId, terminalPhase: 'planning',
    _injectDone: true, alive: true, buffer: 'x'.repeat(501), _attentionTail: '', _attentionRowCarry: '',
    planApprovalCommand: getTaskAgent(agentId).approvalCommand,
    pty: { write() {} },
    ws: { OPEN: 1, readyState: 1, send: msg => messages.push(JSON.parse(msg)) },
    ...overrides,
  });
  return { session, events, messages };
}

// The dialog frame and its collapsed outcome rows, painted the way Ink does (cursor-addressed rows,
// each frame ending in a line break so the legacy newline-carved stream keeps pace with the reflow
// stream, as in the recorded captures).
const CLAUDE_PLAN_DIALOG_CHUNK = '\x1b[H\x1b[3;2H╭──────────────────────────────────────────╮\x1b[4;2H│ Ready to code?                           │'
  + "\x1b[6;2H│ Claude has written up a plan and is ready to execute. Would you like to proceed? │"
  + '\x1b[8;2H│ ❯ 1. Yes, auto-accept edits               │\x1b[9;2H│   2. Yes, manually approve edits          │\x1b[10;2H│   3. No, keep planning                     │'
  + '\x1b[11;2H╰──────────────────────────────────────────╯\r\n';
const CLAUDE_APPROVED_CHUNK = "\x1b[H\x1b[2K\x1b[3;2H⏺ User approved Claude's plan\x1b[4;4HPlan saved to: /tmp/plan.md\x1b[6;2H⏺ Creating hello.txt now.\x1b[8;2H╭──────────────────────────╮\x1b[9;2H│ >                        │\x1b[10;2H╰──────────────────────────╯\x1b[11;4H⏵⏵ accept edits on (shift+tab to cycle)\r\n";
const CLAUDE_REJECTED_CHUNK = "\x1b[H\x1b[2K\x1b[3;2H⏺ User rejected Claude's plan:\x1b[4;4HMake the plan a single line.\x1b[6;2H⏺ Revising the plan.\x1b[8;2H╭──────────────────────────╮\x1b[9;2H│ >                        │\x1b[10;2H╰──────────────────────────╯\x1b[11;4H⏸ plan mode on (shift+tab to cycle)\r\n";

// Each chunk lands 10s after the previous one, so the detector's redraw grace never keeps a
// dismissed dialog's attention state alive across the replay.
function feedClaude(session, chunks) {
  session._tuiClock = session._tuiClock || Date.now();
  for (const raw of chunks) { session._tuiClock += 10000; feedRaw(session, getTaskAgent('claude'), raw, session._tuiClock); }
}

test('TPT654 step 1: a Claude dialog left unanswered keeps planning — no nudge, no exit backstop (the pre-fix life of every in-TUI approval)', async () => {
  const { session, events, messages } = tuiSession('claude', { lastOutputAt: Date.now() - 120000, nudgeCount: 0, _nudgeTypedLine: '' });
  feedClaude(session, [CLAUDE_PLAN_DIALOG_CHUNK]);
  assert.equal(session.terminalPhase, 'planning');
  assert.ok(events.some(e => e.type === 'raise'), 'the dialog itself raises attention (its option row wins the last-match rule)');
  assert.deepEqual(messages, [], 'no terminal-state while the dialog waits');
  const writes = [];
  session.pty = { write: d => writes.push(d) };
  assert.equal((await maybeNudgeIdleSession(session, { backend: nudgeBackend(), deps: nudgeDeps(MISSING_CHECK) })).reason, 'not_executing');
  assert.deepEqual(writes, []);
  const run = exitRunSnapshot(session);
  assert.equal(run.executing, false);
  const f = exitBackstopFakes();
  assert.equal((await flagTaskLeftUncommitted(run, { backend: f.backend, deps: f.deps, reason: 'user-terminated' })).reason, 'not_executing');
  assert.deepEqual(f.log, []);
});

test('TPT654 Claude: the answered dialog\'s "User approved Claude\'s plan" row flips the phase once, with a terminal-state + notice and the planReady ring cleared', () => {
  const { session, events, messages } = tuiSession('claude');
  feedClaude(session, [CLAUDE_PLAN_DIALOG_CHUNK, CLAUDE_APPROVED_CHUNK]);
  assert.equal(session.terminalPhase, 'executing');
  assert.equal(session._planApprovedInTui, 'dialog');
  assert.equal(session.agentPlanReady, false);
  const states = messages.filter(m => m.type === 'terminal-state');
  assert.equal(states.length, 1);
  assert.equal(states[0].phase, 'executing');
  assert.equal(states[0].tabId, 'TPT1');
  assert.ok(messages.some(m => m.type === 'data' && /Plan approved inside the agent/.test(m.data)));
  assert.ok(events.some(e => e.type === 'clear'), 'the dialog ring is withdrawn');
  assert.equal(session._attentionState, null);
  // The same row repainted later (scrollback redraw) is a no-op.
  feedClaude(session, [CLAUDE_APPROVED_CHUNK]);
  assert.equal(messages.filter(m => m.type === 'terminal-state').length, 1);
  assert.equal(session.terminalPhase, 'executing');
});

test('TPT654 Claude: "No, keep planning" stays planning; the later approval still flips', () => {
  const { session, messages } = tuiSession('claude');
  feedClaude(session, [CLAUDE_PLAN_DIALOG_CHUNK, CLAUDE_REJECTED_CHUNK]);
  assert.equal(session.terminalPhase, 'planning');
  assert.equal(session._planApprovedInTui, undefined);
  assert.deepEqual(messages.filter(m => m.type === 'terminal-state'), []);
  feedClaude(session, [CLAUDE_PLAN_DIALOG_CHUNK, CLAUDE_APPROVED_CHUNK]);
  assert.equal(session.terminalPhase, 'executing');
});

test('TPT654 Claude: leaving plan mode via shift+tab (mode footer) counts; a plan-mode footer and pre-kickoff rows do not', () => {
  const { session } = tuiSession('claude');
  feedClaude(session, ['\x1b[H\x1b[11;4H⏸ plan mode on (shift+tab to cycle)\n']);
  assert.equal(session.terminalPhase, 'planning');
  feedClaude(session, ['\x1b[H\x1b[11;4H⏵⏵ accept edits on (shift+tab to cycle)\n']);
  assert.equal(session.terminalPhase, 'executing');
  assert.equal(session._planApprovedInTui, 'mode');
  const early = tuiSession('claude', { _injectDone: false });
  feedClaude(early.session, [CLAUDE_PLAN_DIALOG_CHUNK, CLAUDE_APPROVED_CHUNK, '\x1b[H⏵⏵ accept edits on (shift+tab to cycle)\n']);
  assert.equal(early.session.terminalPhase, 'planning', 'nothing painted before the kickoff can approve');
  // Only Claude reads these rows: the same text in a Codex/Pi terminal means nothing.
  for (const agentId of ['codex', 'pi']) {
    const other = tuiSession(agentId);
    for (const raw of [CLAUDE_APPROVED_CHUNK, '⏵⏵ accept edits on\n']) feedRaw(other.session, getTaskAgent(agentId), raw);
    assert.equal(other.session.terminalPhase, 'planning', agentId);
  }
});

test('TPT654 Codex: an approval typed into the composer after plan-ready latched flips the phase; feedback keeps planning and the revised plan re-fires', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { session, messages } = replayAgentKind(['Plan ready.\n'], 'codex', 'planReady', { tick: ms => t.mock.timers.tick(ms), details: true });
  Object.assign(session, { type: 'terminal', taskId: 'TPT1', planApprovalCommand: null, _injectDone: true });
  assert.equal(session._planReadySent, true);
  assert.equal(messages.filter(m => m.type === 'plan-ready').length, 1);
  const writes = [];
  session.pty = { write: d => writes.push(d) };
  // Feedback first: the run stays planning and the Enter still invalidates the announced plan.
  handleTerminalInput(session, 'Please revise step 2\r');
  assert.equal(session.terminalPhase, 'planning');
  assert.equal(codexPlanReadyIsFresh(session), false);
  assert.equal(session._planReadySent, false);
  // The revised plan is announced again — the pre-existing re-fire path is intact.
  feedRaw(session, getTaskAgent('codex'), 'Revised.\nPlan ready.\n');
  t.mock.timers.tick(CODEX_PLAN_QUIET_MS);
  assert.equal(messages.filter(m => m.type === 'plan-ready').length, 2);
  assert.equal(session._planReadySent, true);
  // Typed char by char, with a typo fixed by backspace: "go" + Enter.
  for (const ch of ['g', 'p', '\x7f', 'o', '\r']) handleTerminalInput(session, ch);
  assert.equal(session.terminalPhase, 'executing');
  assert.equal(session._planApprovedInTui, 'typed');
  assert.equal(codexPlanReadyIsFresh(session), false);
  assert.deepEqual(writes, ['Please revise step 2\r', 'g', 'p', '\x7f', 'o', '\r'], 'every keystroke still reaches the PTY untouched');
  const last = messages.at(-1);
  assert.equal(last.type, 'data');
  assert.match(last.data, /Plan approved inside the agent/);
  const lastState = messages.filter(m => m.type === 'terminal-state').at(-1);
  assert.equal(lastState.phase, 'executing');
  assert.equal(lastState.codexPlanReady, false);
  // Executing now: typing no longer goes through the classifier.
  handleTerminalInput(session, 'go\r');
  assert.equal(messages.filter(m => m.type === 'terminal-state' && m.phase === 'executing').length, 1);
});

test('TPT654 Pi: typed approval after the recorded "Plan ready." sentinel flips; bare Enter, pre-latch typing and feedback never do', () => {
  const chunks = loadAttentionFixture('pi-plan-ready.jsonl');
  const { session, messages } = replayAgentKind(chunks, 'pi', 'planReady', { details: true });
  Object.assign(session, { type: 'terminal', taskId: 'TPT1', planApprovalCommand: null, _injectDone: true, pty: { write() {} } });
  // Before the onData timer announces the plan, a typed line is just a message to Pi.
  session._planReadySent = false;
  session.agentPlanReady = false;
  handleTerminalInput(session, 'go\r');
  assert.equal(session.terminalPhase, 'planning');
  session._planReadySent = true; // what onData's quiet timer sets once it sends plan-ready
  handleTerminalInput(session, '\r');
  assert.equal(session.terminalPhase, 'planning', 'a bare Enter is not an approval');
  handleTerminalInput(session, 'What about the tests?\r');
  assert.equal(session.terminalPhase, 'planning', 'a question is feedback');
  handleTerminalInput(session, '\x1b[200~looks good\x1b[201~');
  handleTerminalInput(session, '\r');
  assert.equal(session.terminalPhase, 'executing', 'a pasted approval + Enter counts');
  assert.equal(session._planApprovedInTui, 'typed');
  assert.equal(messages.filter(m => m.type === 'terminal-state').at(-1).phase, 'executing');
});

test('TPT654: Claude\'s typed input never goes through the composer classifier (its /approve-plan interception is unchanged)', () => {
  const { session, messages } = tuiSession('claude');
  const writes = [];
  session.pty = { write: d => writes.push(d) };
  session._planReadySent = true;
  handleTerminalInput(session, 'go\r');
  assert.equal(session.terminalPhase, 'planning');
  assert.equal(session._typedLine, undefined);
  handleTerminalInput(session, '/approve-plan\r');
  assert.equal(session.terminalPhase, 'executing');
  assert.equal(session._planApprovedInTui, undefined, 'approvePlan(), not the in-TUI path');
  assert.ok(messages.some(m => m.type === 'data' && /Plan approved\. Continuing in execution mode/.test(m.data)));
  assert.ok(writes.includes('go\r'));
});

test('TPT654: Proceed after an in-TUI approval is the existing "already approved" no-op', () => {
  const { session, messages } = tuiSession('claude');
  feedClaude(session, [CLAUDE_PLAN_DIALOG_CHUNK, CLAUDE_APPROVED_CHUNK]);
  const before = messages.length;
  approvePlan(session);
  assert.equal(session.terminalPhase, 'executing');
  assert.ok(messages.slice(before).some(m => m.type === 'data' && /Plan is already approved/.test(m.data)));
  assert.equal(markPlanApprovedInTui(session, 'typed'), false);
  assert.equal(markPlanApprovedInTui(null, 'typed'), false);
});

test('TPT654 end to end: an in-TUI-approved run is guarded — idle nudge pasted, exit backstop comment on Terminate', async (t) => {
  const { session } = tuiSession('claude', { nudgeCount: 0, _nudgeTypedLine: '' });
  feedClaude(session, [CLAUDE_PLAN_DIALOG_CHUNK, CLAUDE_APPROVED_CHUNK]);
  session.lastOutputAt = Date.now() - 120000;
  const writes = [];
  session.pty = { write: d => writes.push(d) };
  t.after(() => { session.alive = false; });
  const r = await maybeNudgeIdleSession(session, { backend: nudgeBackend(), projectRoot: '/p', deps: nudgeDeps(MISSING_CHECK) });
  assert.equal(r.nudged, true);
  assert.match(writes[0], /Task TPT1 is still in progress/);
  const run = exitRunSnapshot(session);
  assert.equal(run.executing, true);
  assert.equal(run.nudgeCount, 1);
  const f = exitBackstopFakes();
  const flagged = await flagTaskLeftUncommitted(run, { backend: f.backend, projectRoot: '/p', reason: 'user-terminated', deps: f.deps });
  assert.equal(flagged.flagged, true);
  const comment = f.log.find(e => e[0] === 'comment');
  assert.match(comment[2], /^Agent exited without committing \/ completing/);
  assert.match(comment[2], /after 1 idle completion nudge/);
});

// Literal claude 2.1.296 captures (fixtures/attention/claude-plan-*.jsonl): the kickoff paste, the
// plan, the ExitPlanMode dialog and the user's answer typed inside the TUI. Replays every chunk
// through feedRaw() as a post-kickoff planning session and reports where the phase flipped.
function replayClaudePlanFixture(name) {
  const chunks = loadAttentionFixture(name);
  const { session, events, messages } = tuiSession('claude');
  const agent = getTaskAgent('claude');
  const marks = { dialogAt: -1, approvedRowAt: -1, rejectedRowAt: -1, flipAt: -1 };
  let clock = Date.now();
  chunks.forEach((raw, i) => {
    const text = stripAnsi(raw);
    if (marks.dialogAt === -1 && /written\s*up\s*a\s*plan/i.test(text)) marks.dialogAt = i;
    if (marks.rejectedRowAt === -1 && /User\s*rejected\s*Claude/i.test(text)) marks.rejectedRowAt = i;
    if (marks.approvedRowAt === -1 && /User\s*approved\s*Claude/i.test(text)) marks.approvedRowAt = i;
    clock += 50;
    feedRaw(session, agent, raw, clock);
    if (marks.flipAt === -1 && session.terminalPhase === 'executing') marks.flipAt = i;
  });
  return { session, events, messages, marks, count: chunks.length };
}

test('TPT654 Claude (recorded 2.1.296): the ExitPlanMode dialog answered Yes inside the TUI flips the phase at the collapsed "User approved" row', () => {
  const { session, events, messages, marks } = replayClaudePlanFixture('claude-plan-approved.jsonl');
  assert.ok(marks.dialogAt > 0, 'the capture holds the dialog');
  assert.ok(marks.approvedRowAt > marks.dialogAt, 'the capture holds the answered row after the dialog');
  assert.equal(marks.flipAt, marks.approvedRowAt, 'planning until the very chunk that paints the collapsed row');
  assert.equal(session.terminalPhase, 'executing');
  assert.equal(session._planApprovedInTui, 'dialog');
  assert.ok(events.some(e => e.type === 'raise'), 'the dialog raised attention first');
  const states = messages.filter(m => m.type === 'terminal-state');
  assert.equal(states.length, 1, 'one flip, even though the row is repainted later in the capture');
  assert.equal(states[0].phase, 'executing');
});

test('TPT654 Claude (recorded 2.1.296): "No, keep planning" answered inside the TUI stays planning; the revised plan\'s dialog answered Yes flips', () => {
  const { session, messages, marks } = replayClaudePlanFixture('claude-plan-keep-planning.jsonl');
  assert.ok(marks.dialogAt > 0, 'the capture holds the first dialog');
  assert.ok(marks.rejectedRowAt > marks.dialogAt, 'the capture holds the "User rejected" row after it');
  assert.ok(marks.approvedRowAt > marks.rejectedRowAt, 'the capture holds the later approval');
  assert.equal(marks.flipAt, marks.approvedRowAt, 'planning through the rejection and the re-plan, executing at the approved row');
  assert.equal(session.terminalPhase, 'executing');
  assert.equal(session._planApprovedInTui, 'dialog');
  const states = messages.filter(m => m.type === 'terminal-state');
  assert.equal(states.length, 1);
  assert.equal(states[0].phase, 'executing');
});

// ── (TPT9002) Project-language notices ──
// The server writes its [Task App] notices in the project's language (read live from
// .tipatask/config.json), the buffer and the exit frame included; the exit resolution comment
// keeps the English text.
{
  const tsMod = require('./terminal-session');
  const { LOCALES: COPY } = require('./terminal-copy');
  const sub = (text, params) => Object.entries(params).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);

  function ukProject(t, language = 'uk') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-locale-'));
    fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({ language }));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
  }

  test('sessionLocale reads the project language from .tipatask/config.json and falls back to en', (t) => {
    assert.equal(tsMod.sessionLocale({ projectPath: ukProject(t) }), 'uk');
    assert.equal(tsMod.sessionLocale({ projectPath: ukProject(t, 'en') }), 'en');
    assert.equal(tsMod.sessionLocale({ projectPath: ukProject(t, 'xx') }), 'en');
    assert.equal(tsMod.sessionLocale({ projectPath: path.join(os.tmpdir(), 'tt-no-such-project-' + process.pid) }), 'en');
    assert.equal(tsMod.sessionLocale({ projectPath: '' }), 'en');
  });

  test('noticeCopy / warningCopy write the Ukrainian notice for a uk project, with the [Task App] prefix and colours in code', (t) => {
    const sent = [];
    const session = { tabId: 'T1', projectPath: ukProject(t), ws: { OPEN: 1, readyState: 1, send: (m) => sent.push(JSON.parse(m)) } };
    tsMod.noticeCopy(session, 'notice.plan.alreadyApproved');
    tsMod.warningCopy(session, 'notice.token.expiresNotRefreshed', { when: '09:05', error: 'offline' });
    assert.deepEqual(sent.map((f) => f.type), ['data', 'data']);
    assert.equal(sent[0].data, `\r\n\x1b[90m[Task App] ${COPY.uk['notice.plan.alreadyApproved']}\x1b[0m\r\n`);
    assert.equal(sent[1].data, `\r\n\x1b[33m[Task App] ${sub(COPY.uk['notice.token.expiresNotRefreshed'], { when: '09:05', error: 'offline' })}\x1b[0m\r\n`);
    // An English project keeps the exact wording the server always printed.
    const enSent = [];
    tsMod.noticeCopy({ tabId: 'T2', projectPath: ukProject(t, 'en'), ws: { OPEN: 1, readyState: 1, send: (m) => enSent.push(JSON.parse(m)) } }, 'notice.plan.alreadyApproved');
    assert.equal(enSent[0].data, '\r\n\x1b[90m[Task App] Plan is already approved.\x1b[0m\r\n');
  });

  test('approvePlan(): a stalled approval on a uk project reports the retry and the final notice in Ukrainian', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const agent = require('./task-agent').getTaskAgent('pi');
    const original = {
      approvePlan: agent.approvePlan,
      getApprovalWatchdogMs: agent.getApprovalWatchdogMs,
      approvalStalled: agent.approvalStalled,
      retryApproval: agent.retryApproval,
    };
    const stalledVerdicts = [true, true];
    agent.approvePlan = () => {};
    agent.getApprovalWatchdogMs = () => 5000;
    agent.approvalStalled = () => stalledVerdicts.shift();
    agent.retryApproval = () => {};
    const sent = [];
    const session = {
      tabId: 'test-approve-watchdog-uk', taskAgent: 'pi', alive: true, pty: { write: () => {} }, buffer: '',
      terminalPhase: 'planning', projectPath: ukProject(t),
      ws: { OPEN: 1, readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) },
    };
    try {
      tsMod.approvePlan(session);
      assert.ok(sent.some((f) => f.type === 'data' && f.data.includes(`[Task App] ${COPY.uk['notice.plan.approved']}`)));
      t.mock.timers.tick(5000);
      assert.ok(sent.some((f) => f.type === 'data' && f.data.includes(sub(COPY.uk['notice.approval.stalledRetrying'], { label: agent.label }))));
      t.mock.timers.tick(5000);
      assert.ok(sent.some((f) => f.type === 'data' && f.data.includes(sub(COPY.uk['notice.approval.stalledAfterRetry'], { label: agent.label }))));
      assert.ok(!sent.some((f) => f.type === 'data' && /looks stalled/.test(f.data)), 'no English notice on a uk project');
      tsMod.approvePlan(session);
      assert.ok(sent.some((f) => f.type === 'data' && f.data.includes(`[Task App] ${COPY.uk['notice.plan.alreadyApproved']}`)));
    } finally {
      Object.assign(agent, original);
      t.mock.timers.reset();
    }
  });

  test('killRunawaySession on a uk project: buffer, notice, exit frame and prompt in Ukrainian; the comment text stays English', (t) => {
    runWithStubbedKill(() => {
      const { session, sent } = makeRunawaySession({ projectPath: ukProject(t) });
      const result = tsMod.killRunawaySession(session, { count: 127, threshold: 50, snapshot: RUNAWAY_SNAPSHOT, summary: 'npm ×24, 3 other', summaryLocal: 'npm ×24, інших: 3' });
      assert.equal(result.first, true);
      assert.match(result.text, /^Сторож завершив цю сесію: втручання сторожа ресурсів; дочірніх процесів: 127 \(завершення після 2 поспіль перевірок/);
      assert.match(result.text, /Найбільше процесів: npm ×24, інших: 3\.$/);
      assert.match(session._exitReason.text, /^Watchdog killed this session: resource watchdog intervention; 127 descendant processes \(kill after 2 consecutive checks/);
      assert.match(session._exitReason.text, /Top processes: npm ×24, 3 other\.$/);
      assert.equal(session._exitReason.display, result.text);
      assert.ok(session.buffer.includes(`[Task App] ${result.text}`));
      assert.ok(!session.buffer.includes('Watchdog killed'));
      assert.equal(sent[0].type, 'data');
      assert.ok(sent[0].data.includes(`[Task App] ${result.text}`));
      // The exit frame shows the Ukrainian text; the onSessionExit payload (resolution comment) the English one.
      assert.equal(tsMod.buildTerminalExitFrame(session, 143, []).reasonText, result.text);
      assert.deepEqual(tsMod.exitReasonFields(session), { reason: 'runaway-killed', reasonText: session._exitReason.text });
      assert.deepEqual(tsMod.exitReasonFields(session, { display: true }), { reason: 'runaway-killed', reasonText: result.text });
    });
  });

  test('pauseRunawaySession / resumeRunawaySession on a uk project write Ukrainian into the buffer and the live stream', (t) => {
    runWithStubbedKill(() => {
      const { session, sent } = makeRunawaySession({ projectPath: ukProject(t) });
      const paused = tsMod.pauseRunawaySession(session, { count: 60, threshold: 50, snapshot: RUNAWAY_SNAPSHOT });
      assert.equal(paused.first, true);
      assert.match(paused.text, /^Сторож призупинив цю сесію: втручання сторожа ресурсів; дочірніх процесів: 60 \(попередження ≥50; призупинення після 2 поспіль/);
      assert.match(paused.text, /Нічого не завершено — усі процеси зупинено, їхній стан збережено\./);
      assert.equal(session._pause.text, paused.text);
      assert.ok(session.buffer.includes(`\x1b[33m[Task App] ${paused.text}`));
      assert.ok(sent.some((f) => f.type === 'data' && f.data.includes(`[Task App] ${paused.text}`)));
      const resumed = tsMod.resumeRunawaySession(session);
      assert.equal(resumed.text, COPY.uk['watchdog.resumed']);
      assert.ok(session.buffer.includes(`\x1b[90m[Task App] ${COPY.uk['watchdog.resumed']}`));
    });
  });

  test('buildTokenExpiryNotice follows the locale; the English default is unchanged', () => {
    const expMs = Date.now() + 10 * 60 * 1000;
    const uk = tsMod.buildTokenExpiryNotice({ expMs, saved: true, headersHelper: true, locale: 'uk' });
    assert.equal(uk.warn, false);
    assert.match(uk.text, /^Термін дії API-токена, з яким запущено цю сесію, спливає \(\d{2}:\d{2}\)\. Новий токен збережено — в агенті введіть \/mcp → tipatask → Reconnect/);
    const ukNotSaved = tsMod.buildTokenExpiryNotice({ expMs, now: expMs + 1, saved: false, headersHelper: false, locale: 'uk' });
    assert.match(ukNotSaved.text, /^Термін дії API-токена, з яким запущено цю сесію, минув \(.*\)\. Автоматично оновити його не вдалося\. Увійдіть знову \(Проєкт ▸ Повторна автентифікація \/ Змінити акаунт\)/);
    const en = tsMod.buildTokenExpiryNotice({ expMs, saved: false, headersHelper: false });
    assert.match(en.text, /^The API token this session started with expires at \d{2}:\d{2}\. It could not be refreshed automatically\. Sign in again \(Project ▸ Re-authenticate \/ Change Account\), then in the agent type \/mcp → tipatask → Reconnect\.$/);
  });

  test('paste failures carry a stable code and params beside the English message', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-paste-'));
    try {
      assert.throws(() => tsMod.saveBase64Image(root, 'T', 'image/bmp', 'AAAA'),
        (err) => err.code === 'EIMAGE_TYPE' && err.message === 'Unsupported image type: image/bmp' && err.params.type === 'image/bmp');
      assert.throws(() => tsMod.saveBase64Image(root, 'T', undefined, 'AAAA'),
        (err) => err.code === 'EIMAGE_TYPE' && err.message === 'Unsupported image type: undefined' && err.params.type === 'undefined');
      assert.throws(() => tsMod.saveBase64Image(root, 'T', 'image/png', ''),
        (err) => err.code === 'EIMAGE_EMPTY' && err.message === 'Empty image data' && err.params === undefined);
      assert.throws(() => tsMod.saveBase64Image(root, 'T', 'image/png', '!!!!'),
        (err) => err.code === 'EIMAGE_EMPTY' && err.message === 'Empty image data');
      assert.throws(() => tsMod.saveBase64Image(root, 'T', 'image/png', Buffer.alloc(12 * 1024 * 1024 + 1).toString('base64')),
        (err) => err.code === 'EIMAGE_TOO_LARGE' && err.message === 'Image too large (>12 MB)' && err.params.maxMb === 12);
      assert.throws(() => tsMod.injectPastedImage({ alive: false }, 'image/png', 'AAAA'),
        (err) => err.code === 'EIMAGE_NOT_RUNNING' && err.message === 'Terminal not running');
      assert.throws(() => tsMod.injectPastedImage({ alive: true, pty: {} }, 'image/png', ''),
        (err) => err.code === 'EIMAGE_MISSING' && err.message === 'Missing image data');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
