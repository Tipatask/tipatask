'use strict';

// C1566 — process-safety directive applied to task-agent kickoff prompts. Responds to the C65
// incident (npm 6, on a stale ambient Node, silently drops an unrecognized --workspace flag
// instead of erroring, collapsing a self-referential build script into unbounded recursion —
// ~3,600 orphaned npm processes, 44GB of swap; a `pkill -f "<command text>"` mitigation could
// never have worked because npm's lifecycle re-exec drops the outer invocation text from every
// descendant's argv). Two rules: check the pinned Node before `npm run`, kill backgrounded
// commands by PID/process-group only. Modeled on vcs-prompt.test.js/tag-description-prompt.test.js
// (same helper pattern) — see ai/architecture/tt-task-agent.md § Process Safety Directive (C1566).

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-procsafety-prompt-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  return dir;
}

// ── BaseTaskAgent#buildProcessSafetyDirective ──

test('buildProcessSafetyDirective: unconditional — always a non-empty string, no opts', () => {
  const agent = new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
  const note = agent.buildProcessSafetyDirective();
  assert.ok(note.length > 0);
  assert.match(note, /node --version/);
  assert.match(note, /pkill -f/);
  assert.match(note, /PID or process group/i);
});

test('buildProcessSafetyDirective: compact wording is shorter, keeps both rules, drops incident backstory', () => {
  const agent = new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
  const full = agent.buildProcessSafetyDirective();
  const compact = agent.buildProcessSafetyDirective({ compact: true });
  assert.ok(compact.length < full.length);
  assert.match(compact, /node --version/);
  assert.match(compact, /pkill -f/);
  assert.match(compact, /process group/i);
  // Incident-scale backstory ("thousands of runaway processes") is full-only.
  assert.doesNotMatch(compact, /thousands/i);
});

// ── ClaudeAgent.buildPrompt ──

test('ClaudeAgent.buildPrompt: process-safety directive present, before the task prompt', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'] });
  assert.match(prompt, /node --version/);
  assert.match(prompt, /pkill -f/);
  const noteIdx = prompt.indexOf('Process safety:');
  const taskIdx = prompt.lastIndexOf('Do the thing');
  assert.ok(noteIdx >= 0 && noteIdx < taskIdx, 'directive must precede the task prompt');
});

test('ClaudeAgent.buildPrompt: designMode wins — no process-safety directive fused into the /design brief', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { designMode: true, taskTags: ['tt-task-agent'] });
  assert.ok(prompt.startsWith('/design '));
  assert.doesNotMatch(prompt, /Process safety:/);
});

// SIMPLE_MODE is read off the module-level `require('../config')` singleton, not the opts
// object (see design-mode-prompt.test.js's note on this) — verified in a child process so
// this file's own config singleton (used by every other test above) is untouched.
test('ClaudeAgent.buildPrompt: SIMPLE_MODE wins — bare prompt, no process-safety directive', () => {
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

test('CodexAgent.buildPrompt: process-safety directive present', () => {
  const agent = new CodexAgent();
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'] });
  assert.match(prompt, /node --version/);
  assert.match(prompt, /pkill -f/);
});

test('CodexAgent.buildPrompt: process-safety lines cannot false-trigger anchored plan-ready detection (C1236)', () => {
  const agent = new CodexAgent();
  const note = agent.buildProcessSafetyDirective();
  for (const line of note.split('\n')) {
    assert.equal(matchPromptLine(line, CODEX_PROMPT_PATTERNS), null, `Codex table matched: ${line}`);
  }
});

// ── PiAgent.buildPrompt ──

test('PiAgent.buildPrompt: compact process-safety directive present, PUT/no-MCP-agnostic wording, no incident backstory', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir });
    assert.match(prompt, /node --version/);
    assert.match(prompt, /pkill -f/);
    assert.doesNotMatch(prompt, /thousands/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (C1119/C1116/C1117) Same echo-safety battery every other Pi prompt-content test runs — the
// whole kickoff prompt is echoed verbatim into Pi's own TUI and scanned by prompt-detect.js.
test('PiAgent.buildPrompt: process-safety directive cannot false-trigger the attention/plan-ready detectors, stays under the size budget', () => {
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

      // Ceiling raised 8500 -> 9000 for C1542's unconditional compact KB-hygiene directive
      // — see pi-agent.test.js's own comment on the same change.
      assert.ok(prompt.length < 9000, `[discovery=${discovery}] prompt grew to ${prompt.length} chars`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Assert delivered meaning independently of buildSharedPreamble's own list.
for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
  test(`${new Agent().id}: processSafety contract survives shared assembly and detects omission/duplication`, (t) => {
    const agent = new Agent();
    const verify = require('./prompt-contract-assertions').processSafety;
    const opts = {};
    opts.projectPath = require('./prompt-contract-assertions').projectFixture(t);
    const build = () => agent.buildPrompt('Implement fixture task.', opts);
    verify(build(), agent.id);
    const original = agent.buildProcessSafetyDirective.bind(agent);
    const stub = t.mock.method(agent, 'buildProcessSafetyDirective', () => '');
    assert.throws(() => verify(build(), agent.id), { code: 'ERR_ASSERTION' }, 'missing directive must fail the semantic contract');
    stub.mock.mockImplementation((...args) => {
      const directive = original(...args);
      return directive + '\n' + directive;
    });
    assert.throws(() => verify(build(), agent.id), { code: 'ERR_ASSERTION' }, 'duplicated directive must fail the semantic contract');
  });
}
