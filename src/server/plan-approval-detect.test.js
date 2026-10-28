'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  matchClaudePlanOutcomeLine,
  trackTypedLine,
  classifyTypedSubmission,
  TYPED_LINE_MAX,
  APPROVAL_MAX_LEN,
} = require('./plan-approval-detect');
const { buildLegacyPatternTable, CLAUDE_PROMPT_PATTERNS } = require('./task-agent/prompt-detect');

test('Codex preset acknowledgement replay excludes selection requests, menus, quotes and partial rows', () => {
  const { matchCodexPermissionLine } = require('./plan-approval-detect');
  for (const [line, expected] of [
    ['• Permissions updated to Full Access', 'bypass'],
    ['  Permissions: Approve for me', 'auto'],
    ['  Permissions: Workspace (Approve for me)', 'auto'],
    ['  Permissions: Full Access', 'bypass'],
    ['• Permission selection requested: Full Access', null],
    ['3. Full Access (current)', null],
    ['`Permissions: Full Access`', null],
    ['Permissions: Full', null],
    ['I saw Permissions: Full Access', null],
  ]) assert.equal(matchCodexPermissionLine(line), expected, line);
});

test('recorded Codex 0.164 ANSI permission rows replay through the native confirmation classifier', () => {
  const { matchCodexPermissionLine } = require('./plan-approval-detect');
  const fixture = require('../../fixtures/attention/codex-permissions-0.164.json');
  for (const { raw, mode } of fixture.rows) {
    const clean = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    assert.equal(matchCodexPermissionLine(clean), mode);
  }
});

// ── matchClaudePlanOutcomeLine ──

test('matchClaudePlanOutcomeLine: collapsed dialog rows (claude 2.1.296 wording)', () => {
  for (const line of [
    "⏺ User approved Claude's plan",
    "  ✔ User approved Claude's plan  ",
    'User approved Claude’s plan',
    '⏺ Exited plan mode',
  ]) assert.equal(matchClaudePlanOutcomeLine(line), 'approved', line);
  for (const line of [
    "⏺ User rejected Claude's plan:",
    "  ⎿  User rejected Claude's plan:",
    "⏺ User rejected Claude's plan: make it shorter",
    'User rejected Claude’s plan',
  ]) assert.equal(matchClaudePlanOutcomeLine(line), 'rejected', line);
});

test('matchClaudePlanOutcomeLine: mode footer rows', () => {
  assert.equal(matchClaudePlanOutcomeLine('  ⏵⏵ accept edits on (shift+tab to cycle)'), 'execMode');
  assert.equal(matchClaudePlanOutcomeLine('⏵⏵ auto mode on (shift+tab to cycle)'), 'execMode');
  assert.equal(matchClaudePlanOutcomeLine('  ⏸ plan mode on (shift+tab to cycle)'), 'planMode');
  assert.equal(matchClaudePlanOutcomeLine('? for shortcuts            ⏸ plan mode on'), 'planMode');
});

test('matchClaudePlanOutcomeLine: the dialog itself, its options and ordinary prose never match', () => {
  for (const line of [
    'Claude has written up a plan and is ready to execute. Would you like to proceed?',
    '│ ❯ 1. Yes, auto-accept edits',
    '│   2. Yes, manually approve edits',
    '│   3. No, keep planning',
    'Claude wants to exit plan mode',
    'Ready to code?',
    // Self-echo guards: this repo's own docs/tests quoting the row through a tool-output row.
    "⎿  - `User approved Claude's plan` row flips the phase",
    "- `User approved Claude's plan`",
    "the collapsed row reads User approved Claude's plan and the phase flips",
    "'User approved Claude's plan',",
    "⏺ I noted that User approved Claude's plan earlier",
    'with accept edits on, Claude will edit files directly',
    'The user asked to exit plan mode later',
    '', null, undefined,
  ]) assert.equal(matchClaudePlanOutcomeLine(line), null, String(line));
});

// ── Claude mode footer, dialogs and composer (TPT9136) ──

test('matchClaudeModeIndicator: every claude 2.1.311 footer, glued raw-tail forms, never prose or quotes', () => {
  const { matchClaudeModeIndicator } = require('./plan-approval-detect');
  for (const [line, mode] of [
    ['  ⏸ plan mode on (shift+tab to cycle) · ← for agents', 'plan'],
    ['  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent', 'auto'],
    ['  ⏵⏵ accept edits on   (shift+tab to cycle) · ← 1 agent', 'acceptEdits'],
    ['  ⏵⏵ bypass permissions on (shift+tab   to cycle) · ← 1 agent', 'bypassPermissions'],
    ['  ⏸ manual mode on · ← 1 agen', 'default'],
    ["  ⏵⏵ don't ask on", 'dontAsk'],
    ['⏵⏵automodeon (shift+tabtocycle)·←1agent', 'auto'],
    ['? for shortcuts            ⏸ plan mode on', 'plan'],
  ]) assert.equal(matchClaudeModeIndicator(line), mode, line);
  for (const line of [
    'with accept edits on, Claude will edit files directly',
    '⏺ Plan mode on keeps edits off until approval',
    'auto mode on',
    '`⏵⏵ auto mode on`',
    "⏺ Session was started with bypass permissions, so plan mode won't ask before most edits or commands.",
    '│ ❯ 1. Yes, and use auto mode',
    '', null, undefined,
  ]) assert.equal(matchClaudeModeIndicator(line), null, String(line));
});

test('matchClaudeDialogLine: permission and plan dialog rows (2.1.311), not transcript, queue or footer rows', () => {
  const { matchClaudeDialogLine } = require('./plan-approval-detect');
  for (const line of [
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '│ ❯ 1. Yes, auto-accept edits',
    ' This command requires approval',
    ' Esc to cancel · Tab to amend',
    'Claude has written up a plan and is ready to execute. Would you like to proceed?',
    ' Do you want to make this edit to README.md?',
  ]) assert.equal(matchClaudeDialogLine(line), true, line);
  for (const line of [
    '   2. Yes, and don’t ask again for: python3 *',
    '  1. Read the architecture docs',
    '❯ The user selected auto for this session.',
    '❯ Press up to edit queued messages',
    '❯',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
    'Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
    '', null,
  ]) assert.equal(matchClaudeDialogLine(line), false, String(line));
});

test('claudeScreenState: the input box (rule, ❯ composer, rule) with the footer below; a dialog replaces the box; a paste swaps the footer', () => {
  const { claudeScreenState } = require('./plan-approval-detect');
  const RULE = '─'.repeat(60);
  assert.deepEqual(claudeScreenState(['⏺ Working', RULE, '❯', RULE, '', '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent']),
    { inputBox: true, composer: '', footer: 'auto', dialog: false });
  assert.deepEqual(claudeScreenState(['❯ queued text', RULE, '❯ Press up to edit queued messages', RULE, '', '  ⏸ manual mode on · ← 1 agent']),
    { inputBox: true, composer: 'Press up to edit queued messages', footer: 'default', dialog: false });
  assert.deepEqual(claudeScreenState([RULE, '❯ [Pasted text #1 +11 lines]', RULE, '', '  paste again to expand']),
    { inputBox: true, composer: '[Pasted text #1 +11 lines]', footer: null, dialog: false });
  assert.deepEqual(claudeScreenState(['❯ earlier user message', RULE, ' Bash command', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel']),
    { inputBox: false, composer: null, footer: null, dialog: true });
  // A wrapped composer spans rows between its rules; a footer is only read below the box.
  assert.equal(claudeScreenState([RULE, '❯ a long message', '  that wraps', RULE, '  ⏸ plan mode on']).composer, 'a long message');
  assert.equal(claudeScreenState(['  ⏵⏵ auto mode on (shift+tab to cycle)', RULE, '❯', RULE]).footer, null);
  assert.deepEqual(claudeScreenState([]), { inputBox: false, composer: null, footer: null, dialog: false });
});

test('trackClaudeScreen reads the footer from the screen even when only the changed cells are rewritten', () => {
  const { trackClaudeScreen } = require('./plan-approval-detect');
  const { stripAnsi } = require('./terminal-session');
  const RULE = '─'.repeat(60);
  const session = {};
  const frame = `\x1b[2J\x1b[H⏺ Working\r\n${RULE}\r\n❯\r\n${RULE}\r\n\r\n  ⏵⏵ auto mode on (shift+tab to cycle)`;
  assert.deepEqual(trackClaudeScreen(session, frame), { from: null, to: 'auto' });
  assert.equal(trackClaudeScreen(session, '\x1b[1;3HWorking harder'), null, 'a repaint elsewhere is no change');
  // Ink's diff for "⏸ manual mode on" over "⏵⏵ auto mode on": the shared "a" cell is skipped.
  const diff = '\x1b[6;3H⏸ m\x1b[6;7Hnual mode on\x1b[K';
  assert.doesNotMatch(stripAnsi(diff), /manual/);
  assert.deepEqual(trackClaudeScreen(session, diff), { from: 'auto', to: 'default' });
  assert.deepEqual([session._claudeTui.footer, session._claudeTui.composer, session._claudeTui.inputBox], ['default', '', true]);
  // A dialog in the box's place: no footer, no box, mode remembered.
  assert.equal(trackClaudeScreen(session, `\x1b[2J\x1b[H${RULE}\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No`), null);
  assert.deepEqual([session._claudeTui.footer, session._claudeTui.inputBox, session._claudeTui.dialog, session._claudeTui.mode], [null, false, true, 'default']);
  assert.equal(trackClaudeScreen(null, 'x'), null);
  assert.equal(trackClaudeScreen(session, null), null);
});

test('matchClaudePlanOutcomeLine: bypass and manual footers also mean plan mode was left', () => {
  assert.equal(matchClaudePlanOutcomeLine('  ⏵⏵ bypass permissions on (shift+tab to cycle)'), 'execMode');
  assert.equal(matchClaudePlanOutcomeLine('  ⏸ manual mode on · ← 1 agent'), 'execMode');
  assert.equal(matchClaudePlanOutcomeLine('  ⏸ plan mode on (shift+tab to cycle)'), 'planMode');
});

test('matchClaudePlanOutcomeLine is in no prompt table (HARD RULE)', () => {
  const rows = ["⏺ User approved Claude's plan", '⏵⏵ accept edits on (shift+tab to cycle)', '⏵⏵ bypass permissions on', '⏸ manual mode on'];
  for (const { re } of [...CLAUDE_PROMPT_PATTERNS, ...buildLegacyPatternTable()]) {
    for (const row of rows) assert.equal(re.test(row), false, `${re} must not match ${row}`);
  }
});

// ── trackTypedLine ──

function feed(session, chunks) {
  const out = [];
  for (const c of chunks) out.push(...trackTypedLine(session, c));
  return out;
}

test('trackTypedLine: char-by-char typing, backspace, arrows and Enter', () => {
  const session = {};
  assert.deepEqual(feed(session, ['g', 'p', '\x7f', 'o', '\x1b[D', '\x1b[C', '\x1bOA']), []);
  assert.equal(session._typedLine, 'go');
  assert.deepEqual(trackTypedLine(session, '\r'), ['go']);
  assert.equal(session._typedLine, '');
});

test('trackTypedLine: a whole line in one chunk, several submissions, bare Enter, ctrl-u', () => {
  const session = {};
  assert.deepEqual(trackTypedLine(session, 'ok go\r'), ['ok go']);
  assert.deepEqual(trackTypedLine(session, 'a\rb\n'), ['a', 'b']);
  assert.deepEqual(trackTypedLine(session, '\r'), ['']);
  assert.deepEqual(feed(session, ['abc', '\x15', 'd', '\r']), ['d']);
  assert.deepEqual(feed(session, ['\t\x03x']), []);
  assert.equal(session._typedLine, 'x');
});

test('trackTypedLine: newlines inside a bracketed paste are not submissions, even split across chunks', () => {
  const session = {};
  assert.deepEqual(trackTypedLine(session, '\x1b[200~line one\nline two\x1b[201~'), []);
  assert.equal(session._typedLine, 'line one line two');
  assert.deepEqual(trackTypedLine(session, '\r'), ['line one line two']);
  assert.deepEqual(feed(session, ['\x1b[200~a\r', 'b\x1b[201~']), []);
  assert.equal(session._typedPasting, false);
  assert.deepEqual(trackTypedLine(session, '\r'), ['a b']);
});

test('trackTypedLine: ignores non-string input and caps the line', () => {
  const session = {};
  assert.deepEqual(trackTypedLine(session, null), []);
  assert.deepEqual(trackTypedLine(null, 'x\r'), []);
  trackTypedLine(session, 'y'.repeat(TYPED_LINE_MAX + 50));
  assert.equal(session._typedLine.length, TYPED_LINE_MAX);
});

// ── classifyTypedSubmission ──

test('classifyTypedSubmission: approval wording', () => {
  for (const t of ['go', 'Go.', 'yes', 'y', 'ok', 'OK, go ahead', 'approved', 'Approve', 'proceed',
    'implement it', 'implement the plan', 'looks good', 'LGTM', 'sounds good, proceed', 'do it',
    'start', 'continue', 'ship it', "let's go", 'Plan approved. Implement the approved plan now.',
    'yes, start implementing now', 'k']) {
    assert.equal(classifyTypedSubmission(t), 'approve', t);
  }
});

test('classifyTypedSubmission: feedback wording and empty input', () => {
  for (const t of ['no', 'not yet', 'wait', 'yes but rename the module first', 'ok, also add tests',
    'Please revise step 2', 'change step 3 to use Postgres', 'Use Postgres.', 'What about tests?',
    'go?', 'continue planning', 're-plan with fewer steps', 'looks good, instead of X do Y',
    'why is step 2 needed', 'stop', 'approve the plan but skip the migration',
    'go ahead ' + 'and keep going '.repeat(10)]) {
    assert.equal(classifyTypedSubmission(t), 'feedback', t);
  }
  assert.equal(classifyTypedSubmission(''), null);
  assert.equal(classifyTypedSubmission('   '), null);
  assert.equal(classifyTypedSubmission(null), null);
  assert.ok(('go ahead ' + 'and keep going '.repeat(10)).length > APPROVAL_MAX_LEN);
});

test('approval prefixes do not authorize revision requests or conditional approval', () => {
  for (const text of ['Yes, simplify step 2', 'Continue investigating the memory limit',
    'Looks good, clarify the recovery path', 'Plan approved? Explain step 2',
    'Plan approved, but revise step 2', 'Plan approved after you resolve the open questions']) {
    assert.equal(classifyTypedSubmission(text), 'feedback', text);
  }
});
