'use strict';

// C1542 — KB-hygiene directive applied to task-agent kickoff prompts. Responds to a real
// pattern: agents were pasting task-specific investigation material — dated findings, evidence
// tables, "correction after reviewing the data" narratives that read as updates to their own
// earlier analysis — straight into ai/architecture/tt-*.md. The KB is standing reference (how
// the system works), not a per-task work log; that narrative belongs in the task's own
// resolution comment (create_task_comment, type: "resolution"), and C1541's
// list_task_resolutions tool exists so a later agent can read that history back without it
// ever having been written into the KB. Modeled on process-safety-prompt.test.js (same helper
// pattern, same C1566 directive shape) — see ai/architecture/tt-task-agent.md
// § KB Hygiene Directive (C1542).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BaseTaskAgent = require('./base-agent');
const ClaudeAgent = require('./claude-agent');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-kbhygiene-prompt-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  return dir;
}

// ── BaseTaskAgent#buildKbHygieneDirective ──

test('buildKbHygieneDirective: unconditional — always a non-empty string, no opts', () => {
  const agent = new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
  const note = agent.buildKbHygieneDirective();
  assert.ok(note.length > 0);
  assert.match(note, /ai\/architecture/);
  assert.match(note, /create_task_comment/);
  assert.match(note, /list_task_resolutions/);
  assert.match(note, /type: "resolution"/);
});

test('buildKbHygieneDirective: compact wording is shorter, keeps the rule, drops MCP tool names', () => {
  const agent = new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
  const full = agent.buildKbHygieneDirective();
  const compact = agent.buildKbHygieneDirective({ compact: true });
  assert.ok(compact.length < full.length);
  assert.match(compact, /ai\/architecture/);
  assert.match(compact, /resolution comment/i);
  // Pi has no MCP — the compact variant must never name an MCP tool.
  assert.ok(!compact.includes('create_task_comment'));
  assert.ok(!compact.includes('list_task_resolutions'));
  assert.ok(!compact.includes('get_tag_architecture'));
  assert.ok(!compact.includes('push_knowledge'));
});

test('buildKbHygieneDirective: compact variant stays inside Pi\'s echo-safety line shape (no question marks)', () => {
  const agent = new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
  const compact = agent.buildKbHygieneDirective({ compact: true });
  assert.doesNotMatch(compact, /\?/);
  for (const line of compact.split('\n')) {
    assert.ok(line.trim().length > 0, 'no blank line inside the compact directive');
  }
});

// ── ClaudeAgent.buildPrompt ──

test('ClaudeAgent.buildPrompt: KB-hygiene directive present, before the task prompt, after process safety', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'] });
  assert.match(prompt, /KB hygiene:/);
  assert.match(prompt, /list_task_resolutions/);
  const noteIdx = prompt.indexOf('KB hygiene:');
  const taskIdx = prompt.lastIndexOf('Do the thing');
  assert.ok(noteIdx >= 0 && noteIdx < taskIdx, 'directive must precede the task prompt');
  assert.ok(prompt.indexOf('Process safety:') < noteIdx, 'KB hygiene must come after process safety');
});

test('ClaudeAgent.buildPrompt: C1542 reconciliation — no contradicting "update KB immediately" instruction survives', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'] });
  assert.doesNotMatch(prompt, /when you find info missing from KB/);
  assert.match(prompt, /STANDING fact is missing from KB/);
});

test('ClaudeAgent.buildPrompt: designMode wins — no KB-hygiene directive fused into the /design brief', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { designMode: true, taskTags: ['tt-task-agent'] });
  assert.ok(prompt.startsWith('/design '));
  assert.doesNotMatch(prompt, /KB hygiene:/);
});

// SIMPLE_MODE is read off the module-level `require('../config')` singleton, not the opts
// object — verified in a child process so this file's own config singleton (used by every
// other test above) is untouched. Same idiom as process-safety-prompt.test.js.
test('ClaudeAgent.buildPrompt: SIMPLE_MODE wins — bare prompt, no KB-hygiene directive', () => {
  const script = [
    `process.env.SIMPLE_MODE = 'true';`,
    `const ClaudeAgent = require(${JSON.stringify(path.join(__dirname, 'claude-agent.js'))});`,
    `const agent = new ClaudeAgent();`,
    `const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'] });`,
    `process.stdout.write(prompt);`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out, 'Do the thing');
});

// ── CodexAgent.buildPrompt ──

test('CodexAgent.buildPrompt: KB-hygiene directive present', () => {
  const agent = new CodexAgent();
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'] });
  assert.match(prompt, /KB hygiene:/);
  assert.match(prompt, /list_task_resolutions/);
});

test('CodexAgent.buildPrompt: KB-hygiene lines cannot false-trigger anchored plan-ready detection (C1236)', () => {
  const agent = new CodexAgent();
  const note = agent.buildKbHygieneDirective();
  for (const line of note.split('\n')) {
    assert.equal(matchPromptLine(line, CODEX_PROMPT_PATTERNS), null, `Codex table matched: ${line}`);
  }
});

test('CodexAgent.buildPrompt: SIMPLE_MODE wins — bare prompt, no KB-hygiene directive', () => {
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

// ── PiAgent.buildPrompt ──

test('PiAgent.buildPrompt: compact KB-hygiene directive present, full-variant text absent', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir });
    assert.ok(prompt.includes(agent.buildKbHygieneDirective({ compact: true })));
    assert.ok(!prompt.includes(agent.buildKbHygieneDirective()));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.buildPrompt: C1542 reconciliation — no contradicting "fix that doc immediately" instruction survives', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir });
    assert.doesNotMatch(prompt, /if you find something missing from a tt-\*\.md/);
    assert.match(prompt, /STANDING fact is missing from a tt-\*\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.buildPrompt: SIMPLE_MODE wins — bare prompt, no KB-hygiene directive', () => {
  const script = [
    `process.env.SIMPLE_MODE = 'true';`,
    `const PiAgent = require(${JSON.stringify(path.join(__dirname, 'pi-agent.js'))});`,
    `const agent = new PiAgent();`,
    `const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'] });`,
    `process.stdout.write(prompt);`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out, 'Do the thing.');
});

// (C1119/C1116/C1117) Same echo-safety battery every other Pi prompt-content test runs — the
// whole kickoff prompt is echoed verbatim into Pi's own TUI and scanned by prompt-detect.js.
test('PiAgent.buildPrompt: KB-hygiene directive cannot false-trigger the attention/plan-ready detectors, stays under the size budget', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    for (const discovery of [false, true]) {
      const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir, discovery });

      for (const line of prompt.split('\n')) {
        assert.equal(matchPromptLine(line, PI_PROMPT_PATTERNS), null, `[discovery=${discovery}] PI table matched: ${line}`);
        assert.equal(matchPromptLine(line, GENERIC_PROMPT_PATTERNS), null, `[discovery=${discovery}] generic table matched: ${line}`);
      }
      for (const { re, agents } of buildLegacyPatternTable()) {
        if (agents && !agents.includes('pi')) continue;
        assert.ok(!re.test(prompt), `[discovery=${discovery}] tail-scoped pattern matched the prompt: ${re}`);
      }
      assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*plan ready[.!]?\s*$/im);
      assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*questions ready[.!]?\s*$/im);

      // Shared Pi ceiling — see pi-agent.test.js's comment on how each unconditional compact
      // directive raised it. Worst measured case (20 blank tag descriptions) is ~9100 chars.
      assert.ok(prompt.length < 9300, `[discovery=${discovery}] prompt grew to ${prompt.length} chars`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Assert delivered meaning independently of buildSharedPreamble's own list.
for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
  test(`${new Agent().id}: kbHygiene contract survives shared assembly and detects omission/duplication`, (t) => {
    const agent = new Agent();
    const verify = require('./prompt-contract-assertions').kbHygiene;
    const opts = {};
    opts.projectPath = require('./prompt-contract-assertions').projectFixture(t);
    const build = () => agent.buildPrompt('Implement fixture task.', opts);
    verify(build(), agent.id);
    const original = agent.buildKbHygieneDirective.bind(agent);
    const stub = t.mock.method(agent, 'buildKbHygieneDirective', () => '');
    assert.throws(() => verify(build(), agent.id), { code: 'ERR_ASSERTION' }, 'missing directive must fail the semantic contract');
    stub.mock.mockImplementation((...args) => {
      const directive = original(...args);
      return directive + '\n' + directive;
    });
    assert.throws(() => verify(build(), agent.id), { code: 'ERR_ASSERTION' }, 'duplicated directive must fail the semantic contract');
  });
}
