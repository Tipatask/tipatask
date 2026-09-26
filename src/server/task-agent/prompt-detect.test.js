'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  GENERIC_PROMPT_PATTERNS,
  CLAUDE_PROMPT_PATTERNS,
  CLAUDE_FIRST_RUN_PATTERNS,
  CLAUDE_ASK_QUESTION_PATTERNS,
  CLAUDE_TOOL_APPROVAL_PATTERNS,
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
} = require('./prompt-detect');

// Table-driven: [agentId, patternTable, line, expectedKind|null]
// (C1059) 'Do you want to proceed?' is a dialogOnly pattern now — it only matches when the line
// itself looks like a rendered dialog row (box border or cursor marker). Fixtured here as a
// real dialog row, not bare prose.
// (C1060) `looksLikeDialogRow` now requires LEADING decoration (see prompt-detect.js's gate
// comment). 'Choose an option:' is itself anchored (`^\s*Choose an option:`), so it can never
// carry a leading box/cursor char without breaking its own match — under the stricter gate this
// pattern is now structurally unreachable via decoration and was dropped from the positive
// fixtures below (see the NEGATIVE_CASES entry that documents this deliberately). Its practical
// coverage is unaffected in production: the numbered option rows a real AskUserQuestion dialog
// also renders (`❯ 1. …`) still match the (still-ungated) ❯-digit generic pattern.
const CASES = [
  ['generic', GENERIC_PROMPT_PATTERNS, '│ Do you want to proceed? │', 'attention'],
  ['generic', GENERIC_PROMPT_PATTERNS, '[y/n]', 'attention'],
  ['generic', GENERIC_PROMPT_PATTERNS, 'random log line with no prompt', null],
  ['claude', CLAUDE_PROMPT_PATTERNS, 'New MCP server found in this project: tipatask', 'mcpTrust'],
  ['claude', CLAUDE_PROMPT_PATTERNS, 'Claude has written up a plan and is ready to execute.', 'planReady'],
  ['claude', CLAUDE_PROMPT_PATTERNS, 'Claude wants to exit plan mode', 'planReady'],
  ['codex', CODEX_PROMPT_PATTERNS, "bash -lc 'ls' needs your approval.", 'toolApproval'],
  ['codex', CODEX_PROMPT_PATTERNS, 'Codex wants to edit src/index.js', 'attention'],
  ['codex', CODEX_PROMPT_PATTERNS, 'Allow Codex to run `npm test` in `.`', 'attention'],
  ['codex', CODEX_PROMPT_PATTERNS, 'Approval requested: apply_patch', 'attention'],
  ['codex', CODEX_PROMPT_PATTERNS, 'Plan ready.', 'planReady'],
  ['codex', CODEX_PROMPT_PATTERNS, '  Plan ready.', 'planReady'],
  ['codex', CODEX_PROMPT_PATTERNS, '❯ Plan ready.', 'planReady'],
  ['codex', CODEX_PROMPT_PATTERNS, 'PLAN READY', 'planReady'],
  // (C1116) Pi's set is now the anchored PI_PLAN_READY_PATTERNS, not the shared loose table —
  // 'Implementation plan' (a bare CASES positive pre-C1116) is deliberately flipped to a
  // NEGATIVE_CASES entry below; it matches ordinary study-phase narration, not a real sentinel.
  ['pi', PI_PROMPT_PATTERNS, 'Plan ready.', 'planReady'],
  ['pi', PI_PROMPT_PATTERNS, '  Plan ready.', 'planReady'],
  ['pi', PI_PROMPT_PATTERNS, '❯ Plan ready.', 'planReady'],
  ['pi', PI_PROMPT_PATTERNS, 'PLAN READY', 'planReady'],
  // (C1134) Pi's mid-task question sentinel — BaseTaskAgent#buildClarifyDirective's compact
  // variant (base-agent.js, wired into pi-agent.js since C1528) instructs Pi to end its
  // question turn with a bare "Questions ready." line. kind stays undefined -> generic
  // 'attention', never 'planReady' (that would wrongly pop the plan-approval dialog).
  ['pi', PI_PROMPT_PATTERNS, 'Questions ready.', 'attention'],
  ['pi', PI_PROMPT_PATTERNS, '  Questions ready.', 'attention'],
  ['pi', PI_PROMPT_PATTERNS, '❯ Questions ready.', 'attention'],
  ['pi', PI_PROMPT_PATTERNS, 'QUESTIONS READY', 'attention'],
  // (C1529) Codex's own mid-task question sentinel — same directive, full variant
  // (base-agent.js#buildClarifyDirective, wired into codex-agent.js since C1528). kind stays
  // undefined -> generic 'attention', same reasoning as Pi's rows above.
  ['codex', CODEX_PROMPT_PATTERNS, 'Questions ready.', 'attention'],
  ['codex', CODEX_PROMPT_PATTERNS, '  Questions ready.', 'attention'],
  ['codex', CODEX_PROMPT_PATTERNS, '❯ Questions ready.', 'attention'],
  ['codex', CODEX_PROMPT_PATTERNS, 'QUESTIONS READY', 'attention'],
  // (C1066) Post-reflow option-row shapes — the INDIVIDUAL rows screen-reflow.js's
  // reflowChunk()/carveReflowLines() produce once real screen-row boundaries are restored for a
  // cursor-addressed multi-option AskUserQuestion dialog (claude 2.1.22x; see terminal-session
  // .test.js for the end-to-end pipeline test). Several unrelated labels/numbers, deliberately
  // NOT the reported task's own wording, to prove the (unchanged) ❯-digit regex generalizes to
  // the row SHAPE rather than being tuned to one dialog.
  ['generic', GENERIC_PROMPT_PATTERNS, ' ❯ 1. Blue/green (Recommended)', 'attention'],
  ['generic', GENERIC_PROMPT_PATTERNS, ' ❯ 3. Roll back to the previous build', 'attention'],
  ['generic', GENERIC_PROMPT_PATTERNS, ' ❯ 12. Retry with backoff', 'attention'],
];

test('matchPromptLine classifies each verified prompt line with the expected kind', () => {
  for (const [label, patterns, line, expectedKind] of CASES) {
    const result = matchPromptLine(line, patterns);
    if (expectedKind === null) {
      assert.equal(result, null, `[${label}] expected no match for ${JSON.stringify(line)}`);
    } else {
      assert.ok(result, `[${label}] expected a match for ${JSON.stringify(line)}`);
      assert.equal(result.kind, expectedKind, `[${label}] wrong kind for ${JSON.stringify(line)}`);
    }
  }
});

// ── Negative cases — agent prose / ordinary output must never match ──
const NEGATIVE_CASES = [
  ["I'll check whether you want to proceed with the refactor.", GENERIC_PROMPT_PATTERNS], // "do you want to" anchor, not "you want to"
  ['diff --git a/src/index.js b/src/index.js', GENERIC_PROMPT_PATTERNS],
  ['src/server/terminal-session.js', CLAUDE_PROMPT_PATTERNS],
  ['Reading file: package.json', CODEX_PROMPT_PATTERNS],
  ['Implementation plan', CODEX_PROMPT_PATTERNS],
  ['Step 1: read the affected files.', CODEX_PROMPT_PATTERNS],
  ['I am ready to implement this once you approve.', CODEX_PROMPT_PATTERNS],
  ['Waiting for your approval before I continue studying.', CODEX_PROMPT_PATTERNS],
  ['The plan ready for review is attached below as a table.', CODEX_PROMPT_PATTERNS],
  // (C1236) Codex echoes this kickoff instruction before it has studied anything. The sentinel
  // copy is embedded in a prose line, so the anchored table must not classify the echo.
  ['Do not ask whether to create a plan or wait for Shift+Tab plan mode. Write the plan immediately in normal output, then stop. After the plan, emit one final line whose only content is the words Plan ready., then wait for Task App approval before mutating files.', CODEX_PROMPT_PATTERNS],
  ['Ready to code?', CLAUDE_PROMPT_PATTERNS], // removed dead pattern (C1057) — boot banner, not a real prompt
  ['esc to interrupt', CLAUDE_PROMPT_PATTERNS], // removed dead/inverted pattern (C1057)
  // (C1059) dialogOnly prose false-positives — undecorated lines carrying dialog wording but
  // no dialog-row decoration must not match; these are plain assistant prose.
  ['Do you want to proceed with the refactor before I continue?', GENERIC_PROMPT_PATTERNS],
  ['Would you like to see the diff for this change?', GENERIC_PROMPT_PATTERNS],
  ['Do you want to make this edit to config.js?', CLAUDE_PROMPT_PATTERNS],
  ['Choose an option: either approach works for this refactor.', CLAUDE_PROMPT_PATTERNS],
  // (C1060) Stricter DIALOG_ROW_RE (leading decoration only) — a mid-sentence "2." numbered
  // item, or a box char that only shows up trailing (a box's right border echoed without its
  // left border), no longer counts as dialog-row decoration.
  ['2. Would you like to keep it?', GENERIC_PROMPT_PATTERNS],
  ['Choose an option: │', CLAUDE_PROMPT_PATTERNS], // trailing-only decoration, no longer gates
  // (C1060) The ❯-digit and bracketed-y/n generic patterns are intentionally left ungated
  // (decoration is inherent to their own wording) but are now anchored — mid-sentence survival
  // of the same text must not match.
  ['output shows ❯ 2. done', GENERIC_PROMPT_PATTERNS],
  ['The docs mention the config supports [y/n] flags for legacy scripts.', GENERIC_PROMPT_PATTERNS],
  // (C1060) "allow this <noun>" required — bare "allow file"/"allow action" reads as prose.
  // Decorated so the gate passes and the assertion isolates the regex tightening itself.
  ['│ The system will allow file uploads up to 10MB. │', GENERIC_PROMPT_PATTERNS],
  // (C1066) The REST of a post-reflow multi-option dialog frame besides its selected option row
  // (see the CASES additions above) — the header question, an unselected option row, an indented
  // wrapped description line, and a trailing separator/footer row must all still read as `null`
  // once reflow hands them over as their own carved lines. Checked against BOTH tables since
  // production runs Claude sessions through CLAUDE_PROMPT_PATTERNS first.
  [' Pick a deploy target for this release?', GENERIC_PROMPT_PATTERNS],
  [' Pick a deploy target for this release?', CLAUDE_PROMPT_PATTERNS],
  ['   2. Rolling restart', GENERIC_PROMPT_PATTERNS],
  ['   2. Rolling restart', CLAUDE_PROMPT_PATTERNS],
  ['     Routes traffic gradually and rolls back automatically on error spikes.', GENERIC_PROMPT_PATTERNS],
  [' ' + '─'.repeat(40), GENERIC_PROMPT_PATTERNS],
  ['   4. Chat about this', GENERIC_PROMPT_PATTERNS],
  ['   4. Chat about this', CLAUDE_PROMPT_PATTERNS],
  // (C1116) The false positive this task fixes: Pi's own kickoff prompt (pi-agent.js
  // buildPrompt) is echoed into its TUI verbatim before any real study happens, and used to
  // contain "Plan ready." mid-sentence — /\bplan ready\b/i (the pre-fix shared pattern) matched
  // it. The anchored PI_PLAN_READY_PATTERNS must never match this echo, nor ordinary
  // study-phase narration mentioning plan-adjacent words.
  ['Write the plan immediately in normal output, then as the very last line of the response, by itself with nothing else on that line, write exactly the words Plan ready. — do this only after the plan is fully written, then wait for Task App approval before mutating files.', PI_PROMPT_PATTERNS],
  ['Implementation plan', PI_PROMPT_PATTERNS],
  ['Step 1: read the affected files.', PI_PROMPT_PATTERNS],
  ['I am ready to implement this once you approve.', PI_PROMPT_PATTERNS],
  ['Waiting for your approval before I continue studying.', PI_PROMPT_PATTERNS],
  ['This plan is nearly ready, one more file to check.', PI_PROMPT_PATTERNS],
  ['The plan ready for review is attached below as a table.', PI_PROMPT_PATTERNS],
  // (C1134, migrated onto the shared helper by C1528) The mid-sentence echo hazard, same shape
  // as the "Plan ready." one above: Pi's kickoff prompt embeds BaseTaskAgent#buildClarifyDirective's
  // compact variant (base-agent.js), echoed into Pi's TUI verbatim, whose own prose contains
  // "Questions ready." mid-sentence — the anchored PI_QUESTION_PATTERNS must never match that
  // echo line, only a standalone sentinel row. Kept wording-independent (a representative
  // sentence, not the directive's exact text) so a future reword of the directive can't make
  // this case stale without also making it wrong.
  ["...then stop, the last line of that response, alone on it, reading exactly the words Questions ready. — the next line typed into this terminal is the user's reply, and you resume from there.", PI_PROMPT_PATTERNS],
  ['I have some questions ready for the next batch once you confirm.', PI_PROMPT_PATTERNS],
  // (C1529) Same echo hazard for Codex — its own kickoff echoes the full-variant directive
  // (base-agent.js#buildClarifyDirective) mid-sentence, and ordinary narration mentioning the
  // words must not match either.
  ["...making its very last line, by itself with nothing else on it, read exactly the words Questions ready. — the next line typed into this terminal is the user's reply, and you resume from there, repeating this list-then-stop pattern for any follow-up batch until every question is answered.", CODEX_PROMPT_PATTERNS],
  ['I will tell you when my questions ready for review.', CODEX_PROMPT_PATTERNS],
  // (C1217) Lettered option rows — the picker substitute's actual output shape — must never
  // themselves read as a real dialog/option row (no ❯-digit decoration, no y/n bracket).
  ['   A) The existing Tipatask REST API', PI_PROMPT_PATTERNS],
  ['   A) The existing Tipatask REST API', GENERIC_PROMPT_PATTERNS],
  ['   C) Something else — describe it', PI_PROMPT_PATTERNS],
  ['   C) Something else — describe it', GENERIC_PROMPT_PATTERNS],
  ['Answer with letters like 1A 2C or type your own wording.', PI_PROMPT_PATTERNS],
];

test('matchPromptLine never fires on agent prose, diffs, file paths, or the removed dead patterns', () => {
  for (const [line, patterns] of NEGATIVE_CASES) {
    assert.equal(matchPromptLine(line, patterns), null, `expected no match for ${JSON.stringify(line)}`);
  }
});

test('matchPromptLine regression: the pre-fix glued mega-line (no reflow) still does not match — documents why reflow, not pattern-loosening, is the fix (C1066)', () => {
  // What stripAnsi() alone produces when an entire cursor-addressed dialog frame is glued into
  // one line (no row-reflow): every '^'-anchored pattern is structurally unreachable against
  // this shape. Regex here is byte-identical to pre-C1066 — the fix is restoring row boundaries
  // upstream (screen-reflow.js), never loosening these patterns. Generic content, not the
  // reported task's own wording.
  const glued = 'Pick a deploy target for this release?❯1. Blue/green (Recommended)Routes traffic gradually and rolls back automatically on error spikes.2. Rolling restart';
  assert.equal(matchPromptLine(glued, GENERIC_PROMPT_PATTERNS), null);
  assert.equal(matchPromptLine(glued, CLAUDE_PROMPT_PATTERNS), null);
});

// ── dialogOnly gate (C1059, tightened C1060) — same wording matches once LEADING dialog-row
// decoration is present ──
const DIALOG_ROW_CASES = [
  ['│ Do you want to proceed with the refactor? │', GENERIC_PROMPT_PATTERNS],
  ['❯ Would you like to see the diff for this change?', GENERIC_PROMPT_PATTERNS],
  ['│ Do you want to make this edit to config.js? │', CLAUDE_PROMPT_PATTERNS],
];

test('matchPromptLine matches dialogOnly patterns once the line carries dialog-row decoration', () => {
  for (const [line, patterns] of DIALOG_ROW_CASES) {
    assert.ok(looksLikeDialogRow(line), `fixture should look like a dialog row: ${JSON.stringify(line)}`);
    assert.ok(matchPromptLine(line, patterns), `expected a match for ${JSON.stringify(line)}`);
  }
});

test('matchPromptLine returns null for empty/non-string input', () => {
  assert.equal(matchPromptLine('', GENERIC_PROMPT_PATTERNS), null);
  assert.equal(matchPromptLine(undefined, GENERIC_PROMPT_PATTERNS), null);
  assert.equal(matchPromptLine(null, GENERIC_PROMPT_PATTERNS), null);
});

test('sanitizePromptText strips box-drawing/cursor chars, collapses whitespace, caps length', () => {
  const decorated = '│ ❯ 1.   Yes,   and always allow access to  this  │';
  const clean = sanitizePromptText(decorated);
  assert.doesNotMatch(clean, /[│❯]/);
  assert.doesNotMatch(clean, /\s{2,}/);
  assert.equal(clean, clean.trim());
  const long = 'x'.repeat(200);
  assert.equal(sanitizePromptText(long).length, 120);
});

// ── buildLegacyPatternTable — priority resolution (toolApproval > mcpTrust > planReady > attention) ──

test('buildLegacyPatternTable reconstructs an agent-scoped flat table usable by kind-priority resolution', () => {
  const table = buildLegacyPatternTable();
  const codexEntries = table.filter((p) => p.agents && p.agents.includes('codex'));
  const claudeEntries = table.filter((p) => p.agents && p.agents.includes('claude'));
  assert.ok(codexEntries.some((p) => p.kind === 'toolApproval'));
  assert.ok(claudeEntries.some((p) => p.kind === 'mcpTrust'));
  // Every entry either has no `agents` (generic) or a non-empty array — never an empty scope.
  for (const entry of table) {
    assert.ok(entry.agents === undefined || entry.agents.length > 0);
    assert.ok(entry.re instanceof RegExp);
  }
});

test('buildLegacyPatternTable scopes PI_PLAN_READY_PATTERNS to pi only, not codex (C1116)', () => {
  const table = buildLegacyPatternTable();
  const piEntries = table.filter((p) => p.agents && p.agents.includes('pi'));
  assert.equal(piEntries.length, PI_PLAN_READY_PATTERNS.length);
  assert.ok(piEntries.every((p) => p.kind === 'planReady'));
  assert.ok(piEntries.every((p) => !p.agents.includes('codex')));
  // Codex has its own anchored plan-ready set after C1236.
  const codexPlanReadyEntries = table.filter((p) => p.agents && p.agents.includes('codex') && p.kind === 'planReady');
  assert.equal(codexPlanReadyEntries.length, CODEX_PLAN_READY_PATTERNS.length);
  assert.ok(codexPlanReadyEntries.every((entry) => CODEX_PLAN_READY_PATTERNS.some((p) => p.re === entry.re)));
});

test('buildLegacyPatternTable scopes CODEX_PLAN_READY_PATTERNS to codex and keeps loose shared entries off codex (C1236)', () => {
  const table = buildLegacyPatternTable();
  const codexPlanReadyEntries = table.filter((p) => p.agents && p.agents.includes('codex') && p.kind === 'planReady');
  assert.equal(codexPlanReadyEntries.length, CODEX_PLAN_READY_PATTERNS.length);
  assert.ok(codexPlanReadyEntries.every((entry) => entry.re.source === '^[\\s>│┃╎┆❯➤▶›*]*plan ready[.!]?\\s*$'));
  assert.ok(codexPlanReadyEntries.every((entry) => !/implementation plan|ready to implement|waiting for/i.test(entry.re.source)));
});

test('buildLegacyPatternTable deliberately excludes PI_QUESTION_PATTERNS — line-scoped only (C1134)', () => {
  const table = buildLegacyPatternTable();
  const piEntries = table.filter((p) => p.agents && p.agents.includes('pi'));
  // Still exactly the plan-ready set — the tail-scoped inject/mcpTrust gate is a no-op for Pi
  // (positional-prompt spawn mode), so widening it here would buy nothing. Line-scoped coverage
  // is PI_PROMPT_PATTERNS directly (see the CASES table above), not this legacy table.
  assert.equal(piEntries.length, PI_PLAN_READY_PATTERNS.length);
  assert.equal(PI_QUESTION_PATTERNS.length, 1);
});

test('buildLegacyPatternTable deliberately excludes CODEX_QUESTION_PATTERNS — line-scoped only (C1529)', () => {
  const table = buildLegacyPatternTable();
  const codexEntries = table.filter((p) => p.agents && p.agents.includes('codex'));
  // Still exactly the plan-ready + tool-approval + generic set — the tail-scoped consumer reads
  // the un-reflowed stripAnsi() stream, where a '^'-anchored pattern (this one included) is
  // structurally unreachable. Line-scoped coverage is CODEX_PROMPT_PATTERNS directly (see the
  // CASES table above), not this legacy table.
  assert.ok(codexEntries.every((entry) => !CODEX_QUESTION_PATTERNS.some((p) => p.re === entry.re)));
  assert.equal(CODEX_QUESTION_PATTERNS.length, 1);
});

test('buildLegacyPatternTable strips dialogOnly — the tail-scoped consumer must stay unaffected by the prose gate (C1059)', () => {
  const table = buildLegacyPatternTable();
  for (const entry of table) {
    assert.equal('dialogOnly' in entry, false, `dialogOnly leaked into legacy table entry: ${entry.re}`);
  }
  // Sanity: source tables DO carry dialogOnly on some entries, so this isn't a vacuous check.
  assert.ok(GENERIC_PROMPT_PATTERNS.some((p) => p.dialogOnly === true));
});

// ── C1219: Claude first-run / onboarding / workspace-trust gate ──
// Verbatim strings confirmed present in the installed claude 2.1.241 binary (`strings` dump).
// Each covers one onboarding/trust screen; tested in GLUED (no '\n') form — see the file-level
// doc comment on CLAUDE_FIRST_RUN_PATTERNS for why: getAttentionPromptMatch() reads the
// un-reflowed rolling tail, where a cursor-addressed screen glues its rows together with no
// line breaks at all, same constraint the C1066 glued-mega-line regression test above pins for
// other patterns.
const FIRST_RUN_POSITIVE_CASES = [
  "Let's get started.To change this later, run /theme",
  'Choose the text style that looks best with your terminal',
  '❯ 3. Dark mode (colorblind-friendly)',
  '❯ 1. Auto (match terminal)',
  'Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.',
  'Select login method:❯ 1. Claude account with subscription  Pro, Max, Team, or Enterprise',
  '❯ 2. Anthropic Console account  API usage billing',
  "Security notes:Claude can make mistakes.You're responsible for Claude's actions and should always review them, especially when running code.",
  'Due to prompt injection risks, only use it with code you trust',
  "Use Claude Code's terminal setup?For the optimal coding experience, enable the recommended settings",
  '❯ 2. No, maybe later with /terminal-setup',
  '❯ 1. Yes, use recommended settings',
  '❯ 1. Yes, I trust this folder',
  '❯ 2. No, continue without these permissions',
  'This folder pre-approves 3 tool permissions',
  'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).',
  'Accessing workspace:/Users/me/projects/new-repo',
  'Managed settings require approval These settings were configured by your organization.',
  '❯ 1. Yes, I trust these settings',
  '❯ 2. No, exit Claude Code',
];

test('C1219: CLAUDE_FIRST_RUN_PATTERNS match every verified 2.1.241 onboarding/trust screen in glued (un-reflowed) form', () => {
  for (const line of FIRST_RUN_POSITIVE_CASES) {
    const result = matchPromptLine(line, CLAUDE_FIRST_RUN_PATTERNS);
    assert.ok(result, `expected a firstRun match for ${JSON.stringify(line)}`);
    assert.equal(result.kind, 'firstRun', `wrong kind for ${JSON.stringify(line)}`);
  }
});

const FIRST_RUN_NEGATIVE_CASES = [
  // Deliberately-rejected bare phrases — see CLAUDE_FIRST_RUN_PATTERNS' doc comment for why.
  'Security notes: see the architecture doc before touching auth middleware.',
  'Select login method: this project supports Google OAuth and API-key auth.',
  "Let's get started.",
  'No, exit code 0 means success.',
  '2. No, that file was already deleted.',
  // Ordinary agent prose / repo content that must never be mistaken for onboarding.
  'Running /security-review on the current diff now.',
  'The login flow lets a user pick between subscription billing and API usage.',
  'This PR adds a dark mode toggle to the settings page.',
];

test('C1219: CLAUDE_FIRST_RUN_PATTERNS never match ordinary agent prose, security-review headings, or login-flow content in this repo', () => {
  for (const line of FIRST_RUN_NEGATIVE_CASES) {
    assert.equal(matchPromptLine(line, CLAUDE_FIRST_RUN_PATTERNS), null, `expected no match for ${JSON.stringify(line)}`);
  }
});

test('C1219: firstRun is deliberately excluded from CLAUDE_PROMPT_PATTERNS — tail-scoped/gate-only (mirrors the C1134 PI_QUESTION_PATTERNS exclusion, inverted)', () => {
  for (const line of FIRST_RUN_POSITIVE_CASES) {
    assert.equal(matchPromptLine(line, CLAUDE_PROMPT_PATTERNS), null, `line-scoped table must never classify ${JSON.stringify(line)}`);
  }
});

test('C1219: buildLegacyPatternTable scopes CLAUDE_FIRST_RUN_PATTERNS to claude only and strips dialogOnly', () => {
  const table = buildLegacyPatternTable();
  const firstRunEntries = table.filter((p) => p.kind === 'firstRun');
  assert.equal(firstRunEntries.length, CLAUDE_FIRST_RUN_PATTERNS.length);
  assert.ok(firstRunEntries.every((p) => p.agents && p.agents.length === 1 && p.agents[0] === 'claude'));
  assert.ok(firstRunEntries.every((p) => !('dialogOnly' in p)));
});

test('C1219: isClaudeReplReady matches the plan-mode REPL footer and nothing in the onboarding frames', () => {
  assert.ok(isClaudeReplReady('some earlier output\n? for shortcuts\n'));
  assert.ok(isClaudeReplReady('some earlier output\nplan mode on (shift+tab to cycle)\n'));
  assert.equal(isClaudeReplReady(''), false);
  assert.equal(isClaudeReplReady(undefined), false);
  for (const line of FIRST_RUN_POSITIVE_CASES) {
    assert.equal(isClaudeReplReady(line), false, `onboarding frame should not look REPL-ready: ${JSON.stringify(line)}`);
  }
});

test('C1219: KIND_PRIORITY places firstRun below mcpTrust and above askQuestion/planReady/attention', () => {
  assert.deepEqual(KIND_PRIORITY, ['toolApproval', 'mcpTrust', 'firstRun', 'askQuestion', 'planReady', 'attention']);
});

// ── C1272: Claude AskUserQuestion menu gate ──
// Real fixture (fixtures/attention/claude-askuserquestion-1.jsonl, and the C1066 glued-mega-line
// regression above reusing the same shape): what stripAnsi() alone produces when an entire
// cursor-addressed AskUserQuestion frame is glued into one line, no reflow. Tested glued, same
// reasoning as the C1219 first-run cases above — getAttentionPromptMatch() reads the un-reflowed
// rolling tail.
const ASK_QUESTION_POSITIVE_CASES = [
  'Pick a deploy target for this release?❯1. Blue/green (Recommended)Routes traffic gradually and rolls back automatically on error spikes.2. Rolling restart3. Canary──────────────────────────────────────4. Type something.5. Chat about this',
  'What should I design, and what\'s it for?❯ 1. Tipatask UI screen Mockup of a Task App / web frontend screen 2. New feature UI 3. Marketing / landing page 4. Print piece 5. Type something. 6. Chat about this',
  '❯ 1. Yes, that works for me 2. No, let me clarify Type something',
];

test('C1272: CLAUDE_ASK_QUESTION_PATTERNS match a glued (un-reflowed) AskUserQuestion menu', () => {
  for (const line of ASK_QUESTION_POSITIVE_CASES) {
    const result = matchPromptLine(line, CLAUDE_ASK_QUESTION_PATTERNS);
    assert.ok(result, `expected an askQuestion match for ${JSON.stringify(line)}`);
    assert.equal(result.kind, 'askQuestion', `wrong kind for ${JSON.stringify(line)}`);
  }
});

const ASK_QUESTION_NEGATIVE_CASES = [
  'This PR adds a dark mode toggle to the settings page.',
  'Running /security-review on the current diff now.',
  'Claude has written up a plan and is ready to execute.',
  'random log line with no prompt',
];

test('C1272: CLAUDE_ASK_QUESTION_PATTERNS never match ordinary agent prose or unrelated dialog kinds', () => {
  for (const line of ASK_QUESTION_NEGATIVE_CASES) {
    assert.equal(matchPromptLine(line, CLAUDE_ASK_QUESTION_PATTERNS), null, `expected no match for ${JSON.stringify(line)}`);
  }
});

test('C1272: askQuestion is deliberately excluded from CLAUDE_PROMPT_PATTERNS — tail-scoped/gate-only, same as firstRun', () => {
  for (const line of ASK_QUESTION_POSITIVE_CASES) {
    assert.equal(matchPromptLine(line, CLAUDE_PROMPT_PATTERNS), null, `line-scoped table must never classify ${JSON.stringify(line)}`);
  }
});

test('C1272: buildLegacyPatternTable scopes CLAUDE_ASK_QUESTION_PATTERNS to claude only and strips dialogOnly', () => {
  const table = buildLegacyPatternTable();
  const askQuestionEntries = table.filter((p) => p.kind === 'askQuestion');
  assert.equal(askQuestionEntries.length, CLAUDE_ASK_QUESTION_PATTERNS.length);
  assert.ok(askQuestionEntries.every((p) => p.agents && p.agents.length === 1 && p.agents[0] === 'claude'));
  assert.ok(askQuestionEntries.every((p) => !('dialogOnly' in p)));
});

// ── C1386: Claude tool-approval dialog gate ──
// Reported bug: a Claude terminal session sitting on
// "Do you want to proceed? / 1. Yes / 2. Yes, and don't ask again for … / 3. No, and tell Claude
// what to do differently" loses its board/left-menu attention highlight while still open and
// unanswered. Root cause (this file's half): Claude had NO toolApproval pattern at all — the
// wording above lived in CLAUDE_GENERIC_PATTERNS with no kind, so getAttentionPromptMatch()
// returned generic 'attention' and every gate keyed on isInjectGateKind() skipped it.

const TOOL_APPROVAL_POSITIVE_CASES = [
  // The reported dialog, glued the way the un-reflowed rolling tail actually sees a Claude Ink
  // frame — no '\n' between rows, box-drawing/cursor decoration intact.
  "tipatask - Get Project Tags(project_path: \"/Users/alice/Projects/Tipatask\")Do you want to proceed?❯ 1. Yes  2. Yes, and don't ask again for tipatask — Get Project Tags commands in /Users/alice/Projects/Tipatask  3. No, and tell Claude what to do differently (esc)",
  "Do you want to make this edit to config.js?❯ 1. Yes 2. Yes, and don't ask again for edits to this file 3. No, and tell Claude what to do differently (esc)",
  '❯ 3. No, and tell Claude what to do differently (esc)',
  '  2. Yes, and always allow access to this file',
  '│ 2. Yes, and don\'t ask again for Bash(npm test:*) commands in /repo │',
];

test('C1386: CLAUDE_TOOL_APPROVAL_PATTERNS classify the reported tool-approval dialog wording as toolApproval', () => {
  for (const line of TOOL_APPROVAL_POSITIVE_CASES) {
    const result = matchPromptLine(line, CLAUDE_TOOL_APPROVAL_PATTERNS);
    assert.ok(result, `expected a toolApproval match for ${JSON.stringify(line)}`);
    assert.equal(result.kind, 'toolApproval', `wrong kind for ${JSON.stringify(line)}`);
  }
});

const TOOL_APPROVAL_NEGATIVE_CASES = [
  // Verbatim from ai/architecture/tt-terminal-attention-detection.md — an agent Read()/Grep()ing
  // this repo's own docs prints this into its own terminal. The leading \d[.)] option-digit guard
  // is what keeps the backticked, digit-less doc quote from matching.
  "- **Claude**: `do you want to (make this edit|create|proceed|run)`, `^\\s*Choose an option:`, `No, and tell Claude what to do differently`, `Yes, and (don't ask again for|always allow access to)`.",
  "The dialog's second row reads Yes, and don't ask again for whichever tool is being approved.",
  'Add a No, and tell Claude what to do differently row to the mock.',
  "{ re: /\\bYes, and (?:don'?t ask again for|always allow access to)\\b/i, dialogOnly: true },",
  'This PR adds a dark mode toggle to the settings page.',
];

test('C1386: CLAUDE_TOOL_APPROVAL_PATTERNS never match this repo\'s own doc/task prose quoting the same wording without an option digit', () => {
  for (const line of TOOL_APPROVAL_NEGATIVE_CASES) {
    assert.equal(matchPromptLine(line, CLAUDE_TOOL_APPROVAL_PATTERNS), null, `expected no match for ${JSON.stringify(line)}`);
  }
});

test('C1386: toolApproval stays out of CLAUDE_PROMPT_PATTERNS — the line-scoped table keeps reporting these rows as generic attention', () => {
  // The option row must be BOX-DECORATED to be seen line-scoped at all: the matching
  // CLAUDE_GENERIC_PATTERNS entry is dialogOnly, and DIALOG_ROW_RE (C1060) requires LEADING
  // decoration. Fixture it as a real box row so the assertion isolates the KIND, not the gate.
  const decorated = "│   2. Yes, and don't ask again for edits to this file │";
  assert.ok(looksLikeDialogRow(decorated));
  const lineResult = matchPromptLine(decorated, CLAUDE_PROMPT_PATTERNS);
  assert.ok(lineResult);
  assert.equal(lineResult.kind, 'attention',
    "line-scoped kind must stay 'attention' — a 'toolApproval' kind here would make one dialog's "
    + 'own repaints alternate kinds row-by-row (question/❯-digit row vs. option-text row), and '
    + 'every such flip is a kindChanged re-raise (the C1059 flicker bug)');
  assert.equal(matchPromptLine(decorated, CLAUDE_TOOL_APPROVAL_PATTERNS).kind, 'toolApproval');
  // Some of these rows already match a PRE-EXISTING line-scoped pattern unrelated to this task
  // (e.g. the `❯ digit.` generic option-row pattern) and legitimately resolve 'attention' — that
  // is untouched, expected behavior. What must never happen, for any of them, is 'toolApproval'.
  for (const line of TOOL_APPROVAL_POSITIVE_CASES) {
    const result = matchPromptLine(line, CLAUDE_PROMPT_PATTERNS);
    assert.notEqual(result?.kind, 'toolApproval',
      `line-scoped table must never classify ${JSON.stringify(line)} as toolApproval`);
  }
});

test('C1386: buildLegacyPatternTable scopes CLAUDE_TOOL_APPROVAL_PATTERNS to claude only, strips dialogOnly, and leaves Codex\'s own toolApproval set alone', () => {
  const table = buildLegacyPatternTable();
  const claudeToolApproval = table.filter((p) => p.kind === 'toolApproval' && p.agents?.includes('claude'));
  assert.equal(claudeToolApproval.length, CLAUDE_TOOL_APPROVAL_PATTERNS.length);
  assert.ok(claudeToolApproval.every((p) => p.agents.length === 1 && !('dialogOnly' in p)));
  const codexToolApproval = table.filter((p) => p.kind === 'toolApproval' && p.agents?.includes('codex'));
  assert.ok(codexToolApproval.length > 0 && codexToolApproval.every((p) => !p.agents.includes('claude')));
});

// ── TPT348: Claude background-agents busy signal (matchClaudeBgAgentsLine) ──

test('TPT348: the waiting status row matches "wait" — plural, singular, decorated, undecorated', () => {
  for (const line of [
    'Waiting for 2 background agents to finish',
    '* Waiting for 3 background agents to finish',
    '✻ Waiting for 1 background agent to finish',
    '  ● Waiting for 12 background agents to finish · 4m 17s',
    'waiting for 2 Background Agents to finish',
  ]) {
    assert.equal(matchClaudeBgAgentsLine(line), 'wait', line);
  }
});

test('TPT348: the waiting status row does NOT match when quoted, placeholder-counted, or ordinary prose (self-echo guard)', () => {
  for (const line of [
    // mid-sentence echo of a kickoff prompt / task description
    'then * Waiting for 2 background agents to finish. Under that sat an empty box',
    "Claude Code is idle at its prompt showing 'Waiting for N background agents to finish', 'plan mode on'",
    // quoted / backticked in a doc, a test file, or agent prose
    "'Waiting for 2 background agents to finish\n',",
    '`Waiting for 2 background agents to finish`',
    '"Waiting for 2 background agents to finish"',
    // placeholder count (how the KB doc spells it)
    'Waiting for N background agents to finish',
    'Waiting for <N> background agents to finish',
    // the neighbouring, unrelated row in the reported frame
    'Plan skeleton written. Waiting on 3 Explore agents.',
    'Waiting for 2 workflows to finish',
  ]) {
    assert.equal(matchClaudeBgAgentsLine(line), null, line);
  }
});

test('TPT348: agents-panel rows and the bare timer-tick fragment match "row"', () => {
  for (const line of [
    '○ Explore  Counting title tags in cms_content                4m 17s · ↓ 116.0k tokens',
    '  ○ Explore  Checking store pagination in index.view.php     4m 17s · ↓ 123.6k tokens  ',
    '◯ general-purpose  Oversized image origins   45s · ↓ 9.1k tokens',
    // the cell-diff renderer repaints just the counters as the elapsed timer ticks
    '                                                             4m 18s · ↓ 116.4k tokens',
    '1h 2m · ↑ 3.2M tokens',
  ]) {
    assert.equal(matchClaudeBgAgentsLine(line), 'row', line);
  }
});

test('TPT348: rows that merely resemble the panel do not match', () => {
  for (const line of [
    '● main',                                          // the panel's own header row carries no counters
    '✻ Thinking… (12s · ↓ 3.4k tokens · esc to interrupt)', // the working spinner — busy anyway, and a different shape
    'Total: 4m 17s · ↓ 116.0k tokens used',            // prose with the same tail, no leading timer
    'Counting title tags in cms_content',
  ]) {
    assert.equal(matchClaudeBgAgentsLine(line), null, line);
  }
});

test('TPT348: the ordinary turn-end duration row matches "done" for every verb in the CLI list', () => {
  for (const verb of ['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked']) {
    assert.equal(matchClaudeBgAgentsLine(`✻ ${verb} for 12s`), 'done', verb);
  }
  assert.equal(matchClaudeBgAgentsLine('Worked for 1m 3s'), 'done');
  assert.equal(matchClaudeBgAgentsLine('  * Cooked for 2h 5m'), 'done');
  // prose that only resembles it
  assert.equal(matchClaudeBgAgentsLine('The build worked for 3 hours before failing'), null);
  assert.equal(matchClaudeBgAgentsLine("'✻ Worked for 12s',"), null);
  assert.equal(matchClaudeBgAgentsLine('Worked for several minutes'), null);
});

test('TPT348: the reported frame, row by row, classifies only its waiting/panel rows', () => {
  const frame = [
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
  assert.deepEqual(frame.map(matchClaudeBgAgentsLine),
    [null, null, null, 'wait', null, null, null, 'wait', null, null, null, null, 'row', 'row']);
  // ...and, the finding that prompted the busy latch: none of these rows is a prompt line
  // for any agent's line-scoped table, so there is no pattern to tighten.
  for (const table of [GENERIC_PROMPT_PATTERNS, CLAUDE_PROMPT_PATTERNS]) {
    for (const line of frame) assert.equal(matchPromptLine(line, table), null, line);
  }
});

test('TPT348: matchClaudeBgAgentsLine is in no prompt table and adds nothing to buildLegacyPatternTable()', () => {
  const probe = 'Waiting for 2 background agents to finish';
  for (const table of [GENERIC_PROMPT_PATTERNS, CLAUDE_PROMPT_PATTERNS, CODEX_PROMPT_PATTERNS, PI_PROMPT_PATTERNS]) {
    assert.equal(matchPromptLine(probe, table), null);
  }
  assert.ok(buildLegacyPatternTable().every((p) => !p.re.test(probe)),
    'the busy signal must not touch the tail-scoped gate behind onInjectSilence()');
});
