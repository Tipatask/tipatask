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

test('matchClaudePlanOutcomeLine is in no prompt table (HARD RULE)', () => {
  const rows = ["⏺ User approved Claude's plan", '⏵⏵ accept edits on (shift+tab to cycle)'];
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
