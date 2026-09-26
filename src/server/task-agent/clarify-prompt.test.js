'use strict';

// C1527 — clarifying-questions directive applied to task-agent kickoff prompts. Codex (and any
// future non-Claude agent) has no AskUserQuestion tool and no interactive picker, so a task
// instruction to "ask the user first" otherwise falls through to plain generation with no pause
// — the same gap C1134/C1217 closed for Pi locally as PI_QUESTION_MECHANISM. This is that
// mechanism's shared, agent-agnostic form: a numbered question list with lettered A)/B)/C)
// options, ending in a standalone "Questions ready." sentinel — the SAME sentinel
// PI_QUESTION_PATTERNS already anchors on, reused rather than forked. Modeled on
// kb-hygiene-prompt.test.js/process-safety-prompt.test.js (same helper pattern) — see
// ai/architecture/tt-task-agent.md § Clarifying-Question Directive (C1527).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BaseTaskAgent = require('./base-agent');
const CodexAgent = require('./codex-agent');
const PiAgent = require('./pi-agent');
const {
  matchPromptLine,
  CODEX_PROMPT_PATTERNS,
  PI_PROMPT_PATTERNS,
  GENERIC_PROMPT_PATTERNS,
  buildLegacyPatternTable,
} = require('./prompt-detect');

function makeProjectDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-clarify-prompt-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  return dir;
}

// Banned substrings: each would false-trigger a live detector pattern if it crept into the
// directive's wording. See buildClarifyDirective()'s own ECHO SAFETY comment in base-agent.js.
const BANNED_SUBSTRINGS = [
  'needs your approval',
  'to run tool',
  'approve this',
  'allow this',
  'Type something',
  'press enter',
  'press Enter',
];

function assertNoBannedSubstrings(text) {
  for (const needle of BANNED_SUBSTRINGS) {
    assert.ok(!text.toLowerCase().includes(needle.toLowerCase()), `directive contains banned substring: "${needle}"`);
  }
}

function assertNoBareSentinelLine(text) {
  assert.doesNotMatch(text, /^[\s>│┃╎┆❯➤▶›*]*questions ready[.!]?\s*$/im);
  assert.doesNotMatch(text, /^[\s>│┃╎┆❯➤▶›*]*plan ready[.!]?\s*$/im);
}

// ── BaseTaskAgent#buildClarifyDirective ──

test('buildClarifyDirective: unconditional — always a non-empty string, no opts', () => {
  const agent = new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
  const note = agent.buildClarifyDirective();
  assert.ok(note.length > 0);
  assert.match(note, /Questions ready\./);
  assert.match(note, /A\) B\) C\)/);
  assert.match(note, /1A 2C/);
});

test('buildClarifyDirective: compact wording is shorter, keeps the sentinel and lettered options', () => {
  const agent = new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
  const full = agent.buildClarifyDirective();
  const compact = agent.buildClarifyDirective({ compact: true });
  assert.ok(compact.length < full.length);
  assert.match(compact, /Questions ready\./);
  assert.match(compact, /A\) B\) C\)/);
  assert.match(compact, /1A 2C/);
  // Pi has no MCP — the compact variant must never name an MCP tool.
  assert.ok(!compact.includes('create_task_comment'));
  assert.ok(!compact.includes('get_tag_architecture'));
});

test('buildClarifyDirective: neither variant contains a question mark or a blank line', () => {
  const agent = new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
  for (const compact of [false, true]) {
    const note = agent.buildClarifyDirective({ compact });
    assert.doesNotMatch(note, /\?/);
    for (const line of note.split('\n')) {
      assert.ok(line.trim().length > 0, 'no blank line inside the directive');
    }
  }
});

test('buildClarifyDirective: sentinel is never a bare line in either variant (C1236/C1116 discipline)', () => {
  const agent = new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
  for (const compact of [false, true]) {
    const note = agent.buildClarifyDirective({ compact });
    assertNoBareSentinelLine(note);
    assertNoBannedSubstrings(note);
    // "plan-ready" must stay hyphenated — a spaced "plan ready" is claude-scoped/unanchored
    // and would make this helper unsafe to wire into ClaudeAgent later.
    assert.ok(!/\bplan ready\b/i.test(note), 'directive must never contain a spaced "plan ready"');
  }
});

// ── CodexAgent.buildPrompt ──

test('CodexAgent.buildPrompt: clarify directive present, after the Plan ready. instruction, before the task prompt', () => {
  const agent = new CodexAgent();
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'] });
  assert.match(prompt, /Clarifying questions:/);
  assert.match(prompt, /Questions ready\./);
  const planIdx = prompt.indexOf('Plan ready.');
  const clarifyIdx = prompt.indexOf('Clarifying questions:');
  const taskIdx = prompt.lastIndexOf('Do the thing');
  assert.ok(planIdx >= 0 && planIdx < clarifyIdx, 'clarify directive must come after the plan-ready instruction');
  assert.ok(clarifyIdx < taskIdx, 'clarify directive must precede the task prompt');
});

test('CodexAgent.buildPrompt: designMode wins — no clarify directive fused into the /design brief', () => {
  const agent = new CodexAgent();
  // CodexAgent has no designMode of its own (Claude-only), so this asserts SIMPLE_MODE's
  // sibling guarantee instead: buildPrompt() with no special opts still contains the directive,
  // confirming it isn't accidentally gated on an opt that's absent by default.
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'] });
  assert.match(prompt, /Clarifying questions:/);
});

test('CodexAgent.buildPrompt: SIMPLE_MODE wins — bare prompt, no clarify directive', () => {
  const script = [
    `process.env.SIMPLE_MODE = 'true';`,
    `const CodexAgent = require(${JSON.stringify(path.join(__dirname, 'codex-agent.js'))});`,
    `const agent = new CodexAgent();`,
    `const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'] });`,
    `process.stdout.write(prompt);`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out, 'Do the thing');
});

// ── Echo safety (C1236/C1116) — line-scoped AND tail-scoped, both against the real Codex spawn prompt ──

test('CodexAgent.buildPrompt: clarify directive lines cannot false-trigger line-scoped Codex/generic detection', () => {
  const agent = new CodexAgent();
  const note = agent.buildClarifyDirective();
  for (const line of note.split('\n')) {
    assert.equal(matchPromptLine(line, CODEX_PROMPT_PATTERNS), null, `Codex table matched: ${line}`);
    assert.equal(matchPromptLine(line, GENERIC_PROMPT_PATTERNS), null, `generic table matched: ${line}`);
  }
});

test('CodexAgent.buildPrompt: full spawn prompt cannot false-trigger tail-scoped Codex-agent detection', () => {
  const agent = new CodexAgent();
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'] });
  for (const { re, agents } of buildLegacyPatternTable()) {
    if (agents && !agents.includes('codex')) continue;
    assert.ok(!re.test(prompt), `tail-scoped pattern matched the prompt: ${re}`);
  }
  assertNoBareSentinelLine(prompt);
  assertNoBannedSubstrings(prompt);
});

// ── PiAgent.buildPrompt (C1528 — migrated off the private PI_QUESTION_MECHANISM const) ──

test('PiAgent.buildPrompt: compact clarify directive present, full-variant text absent', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-pi-session'], projectPath: dir });
    assert.ok(prompt.includes(agent.buildClarifyDirective({ compact: true })));
    assert.ok(!prompt.includes(agent.buildClarifyDirective()));
    // Regression guard for a partial revert: the retired const's distinguishing opener must
    // not reappear verbatim.
    assert.ok(!prompt.includes('You have no AskUserQuestion tool and no interactive picker'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.buildPrompt: clarify directive present, after the Plan ready. instruction, before the task prompt', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-pi-session'], projectPath: dir });
    assert.match(prompt, /Clarifying questions:/);
    assert.match(prompt, /Questions ready\./);
    const planIdx = prompt.indexOf('Plan ready.');
    const clarifyIdx = prompt.indexOf('Clarifying questions:');
    const taskIdx = prompt.lastIndexOf('Do the thing');
    assert.ok(planIdx >= 0 && planIdx < clarifyIdx, 'clarify directive must come after the plan-ready instruction');
    assert.ok(clarifyIdx < taskIdx, 'clarify directive must precede the task prompt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.buildPrompt: SIMPLE_MODE wins — bare prompt, no clarify directive', () => {
  const script = [
    `process.env.SIMPLE_MODE = 'true';`,
    `const PiAgent = require(${JSON.stringify(path.join(__dirname, 'pi-agent.js'))});`,
    `const agent = new PiAgent();`,
    `const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-pi-session'] });`,
    `process.stdout.write(prompt);`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out, 'Do the thing');
});

// ── Echo safety (C1236/C1116/C1134) — line-scoped, directive text only ──
// pi-agent.test.js already sweeps the WHOLE real Pi kickoff prompt (line-scoped + tail-scoped +
// size budget) on every edit to buildPrompt(); this is the narrower coverage gap the C1528
// migration opens — the directive itself, swept against the PI table specifically, since it
// didn't run through pi-agent.js's own battery before this migration.

test('PiAgent.buildPrompt: clarify directive lines cannot false-trigger line-scoped Pi/generic detection', () => {
  const agent = new PiAgent();
  const note = agent.buildClarifyDirective({ compact: true });
  for (const line of note.split('\n')) {
    assert.equal(matchPromptLine(line, PI_PROMPT_PATTERNS), null, `Pi table matched: ${line}`);
    assert.equal(matchPromptLine(line, GENERIC_PROMPT_PATTERNS), null, `generic table matched: ${line}`);
  }
});

test('PiAgent.buildPrompt: full spawn prompt cannot false-trigger tail-scoped Pi-agent detection', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-pi-session'], projectPath: dir });
    for (const { re, agents } of buildLegacyPatternTable()) {
      if (agents && !agents.includes('pi')) continue;
      assert.ok(!re.test(prompt), `tail-scoped pattern matched the prompt: ${re}`);
    }
    assertNoBareSentinelLine(prompt);
    assertNoBannedSubstrings(prompt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude leaves questions native; Codex/Pi state question-before-plan semantics beside plan instructions', () => {
  const ClaudeAgent = require('./claude-agent');
  const claude = new ClaudeAgent().buildPrompt('TASK');
  assert.doesNotMatch(claude, /Questions ready\.|Clarifying questions:|no question tool/);
  for (const agent of [new CodexAgent(), new PiAgent()]) {
    const prompt = agent.buildPrompt('TASK');
    const { once } = require('./prompt-contract-assertions');
    once(prompt, /Clarifying questions:/, 'one clarification mechanism');
    assert.match(prompt, /before the plan/i);
    assert.match(prompt, /never in the same response|no plan text, no partial plan/i);
    assert.match(prompt, /Questions ready\./);
    assert.match(prompt, /Assumption line/);
    assert.ok(prompt.indexOf('Plan ready.') < prompt.indexOf('Clarifying questions:'));
    assert.ok(prompt.indexOf('Clarifying questions:') < prompt.indexOf('Project context:'));
    assertNoBareSentinelLine(prompt);
  }
});
