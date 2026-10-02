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
  SUBMIT_WATCH_MS,
  SUBMIT_MARKER_TRAILING_MAX,
  MAX_SUBMIT_RETRIES,
} = require('./terminal-session');
const { parsePsOutput } = require('./process-group');
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
  assert.equal(result.resetVia, 'tail', 'this capture dismisses via an alt-screen toggle, which clears the tail directly — not an in-place line-state drop');
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
    assert.match(result.text, /^Descendant watchdog killed this session: 127 descendant processes/);
    assert.match(result.text, /\u226550/);
    assert.match(result.text, /\u2265150/);
    assert.deepEqual(session._exitReason, { kind: 'runaway-killed', count: 127, threshold: 50, text: result.text });
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
    const result = killRunawaySession(session, { count: 12, threshold: 50, rssMb: 4800, limitMb: 3072, reason: 'memory', snapshot: RUNAWAY_SNAPSHOT });
    assert.match(result.text, /^Watchdog killed this session: its process tree used 4800 MB, over the 3072 MB memory limit/);
    assert.match(result.text, /12 descendant processes/);
    assert.equal(session._exitReason.kind, 'runaway-killed');
    assert.equal(session._exitReason.rssMb, 4800);
    assert.equal(session._exitReason.limitMb, 3072);
  });
});

// ── pauseRunawaySession() / resumeRunawaySession() — process.kill stubbed, nothing real is signaled ──

const PAUSE_ARGS = { count: 12, threshold: 50, rssMb: 3300, limitMb: 3072, reason: 'memory', snapshot: RUNAWAY_SNAPSHOT };

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
    assert.match(result.text, /^Watchdog paused this session: its process tree uses 3300 MB, over the 3072 MB memory limit/);
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
    assert.equal(session._pause.reason, 'memory');
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
    assert.equal(sent[1].paused.reason, 'memory');
  });
});

test('pauseRunawaySession words a count pause around the process growth', () => {
  runWithStubbedKill(() => {
    const { session } = makeRunawaySession();
    const result = pauseRunawaySession(session, { count: 86, threshold: 50, rssMb: 700, limitMb: 3072, reason: 'count', snapshot: RUNAWAY_SNAPSHOT });
    assert.match(result.text, /^Watchdog paused this session: 86 descendant processes using 700 MB and growing/);
    assert.match(result.text, /warn ≥50/);
    assert.equal(session._pause.reason, 'count');
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

// One spawn on a fresh session. Returns handles to feed PTY output and inspect PTY input.
async function startClaudeKickoff(t, { initialPrompt = 'Work on task TPT364', kickoffTypedLine } = {}) {
  const writes = [];
  const sent = [];
  let dataCb = null;
  const fakePty = {
    pid: 424242,
    write: (d) => { writes.push(d); },
    onData: (cb) => { dataCb = cb; },
    onExit: () => {},
    resize: () => {},
    kill: () => {},
  };
  t.mock.method(nodePty, 'spawn', () => fakePty);
  const agent = getTaskAgent('claude');
  t.mock.method(agent, 'cachedDetect', async () => ({ id: 'claude', label: 'Claude Code', available: true }));
  t.mock.method(agent, 'getSpawnSpec', async () => ({
    command: 'claude', args: [], cwd: os.tmpdir(), env: {}, initialPrompt, model: 'test-model',
    ...(kickoffTypedLine ? { kickoffTypedLine } : {}),
  }));
  const session = createSession(null, false, 'TPT364-tab', '');
  session.taskAgent = 'claude';
  session.ws = { OPEN: 1, readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
  await spawnTerminal(session, 'raw prompt', 'TPT364', [], {});
  assert.equal(session.alive, true, 'the fake spawn must have gone live');
  assert.equal(typeof dataCb, 'function', 'onData handler must be registered');
  const k = {
    session,
    writes,
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

// The teardown terminateTerminalSession() (ws-handlers.js) performs on Stop/Restart. It does NOT
// touch the submit-check timer — that one relies on its own liveness guards.
function stopSession(session) {
  clearTimeout(session._injectTimer);
  session._injectTimer = null;
  session._terminated = true;
  session.alive = false;
  session.pty = null;
}

test('TPT364 fixture guard: the chip strings match the marker, and a real turn buries it', () => {
  const re = getTaskAgent('claude').getUnsentPasteRe();
  assert.ok(re, 'Claude must expose an unsent-paste marker');
  assert.equal(unsentPasteVisible(re, CHIP), true);
  assert.equal(unsentPasteVisible(re, '> [Pastedtext #7 +3lines]'), true, 'Ink glues words after ANSI stripping');
  assert.equal(unsentPasteVisible(re, `${CHIP}${TURN_OUTPUT}`), false, 'real output after the chip buries it');
  assert.equal(unsentPasteVisible(re, 'no chip here'), false);
  assert.equal(unsentPasteVisible(null, CHIP), false);
  assert.equal(getTaskAgent('codex').getUnsentPasteRe(), null, 'agents without a marker never re-send Enter');
  assert.equal(getTaskAgent('pi').getUnsentPasteRe(), null);
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
