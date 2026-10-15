'use strict';

// Follow-up capture is an exception for evidenced shipped defects/risks and required manual
// steps. Zero is normal; prefer outstanding-task comments and cap new tasks at two per run.
// Modeled on kb-hygiene-prompt.test.js — see
// ai/architecture/tt-task-agent.md § Follow-up Capture Directive.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BaseTaskAgent = require('./base-agent');
const ClaudeAgent = require('./claude-agent');
const CodexAgent = require('./codex-agent');
const PiAgent = require('./pi-agent');
const { projectFixture, followUps } = require('./prompt-contract-assertions');
const {
  matchPromptLine,
  CLAUDE_PROMPT_PATTERNS,
  CODEX_PROMPT_PATTERNS,
  PI_PROMPT_PATTERNS,
  GENERIC_PROMPT_PATTERNS,
  buildLegacyPatternTable,
} = require('./prompt-detect');

// The strict live-read context every real task-terminal spawn threads (vcs-context.js).
const VCS_CONTEXT = Object.freeze({
  verified: true, projectId: 2, checkedAt: '2026-01-01T00:00:00.000Z',
  vcs: { type: 'git', worktree: false, commit: true, pr: false, merge: false },
  runtime: { version: 'test', source: '/tmp/test', packaged: false, fingerprint: 'test', stale: false, protocol: 1 },
});

const TASK_TOOLS = ['list_tasks', 'get_task', 'create_task_comment', 'reserve_task_keys', 'update_task'];
const STATUS_LITERALS = /\bpending\b|\bon_fire\b|\bin_progress\b|\bcompleted\b/;

function bareAgent() {
  return new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
}

for (const compact of [false, true]) {
  test(`buildFollowUpDirective: ${compact ? 'compact' : 'full'} defaults to none and rejects task-generating drift`, () => {
    const note = bareAgent().buildFollowUpDirective({ compact });
    followUps(note);
    for (const rule of [
      'Zero follow-ups is the normal result.',
      'At most 2 new tasks per run, each with one sentence of evidence.',
      'Only capture a defect, data risk or security issue in shipped behavior, or a manual step the user must take.',
      'Never file improvements, refactors, extra tests, doc ideas, nice-to-haves',
      'Prefer a comment',
    ]) {
      assert.ok(note.includes(rule), rule);
      assert.throws(() => followUps(note.replace(rule, '')), { code: 'ERR_ASSERTION' }, `omitting ${rule} must fail`);
    }
  });
}

// ── BaseTaskAgent#buildFollowUpDirective ──

test('buildFollowUpDirective: unconditional, full wording names the task tools and the outstanding-status rule', () => {
  const note = bareAgent().buildFollowUpDirective();
  assert.ok(note.startsWith('Follow-up capture:'));
  for (const tool of TASK_TOOLS) assert.ok(note.includes(`\`${tool}`), `full wording names ${tool}`);
  assert.match(note, /type: "comment"/);
  assert.match(note, /only tasks in the project's not-started and urgent statuses count/);
  assert.match(note, /Never touch a task that is in progress, done or canceled/);
  assert.match(note, /never while planning, which forbids task writes/);
  assert.match(note, /Never file work this task's own scope requires/);
  followUps(note);
});

test('buildFollowUpDirective: guardedCompletion makes complete_task the deadline; compact ignores the flag', () => {
  const agent = bareAgent();
  assert.match(agent.buildFollowUpDirective({ guardedCompletion: true }), /After implementation and before `complete_task`/);
  const legacy = agent.buildFollowUpDirective();
  assert.match(legacy, /before the final status update/);
  assert.doesNotMatch(legacy, /complete_task/);
  assert.equal(agent.buildFollowUpDirective({ compact: true, guardedCompletion: true }), agent.buildFollowUpDirective({ compact: true }));
});

test('buildFollowUpDirective: compact wording is shorter, keeps every rule, names no MCP tool', () => {
  const agent = bareAgent();
  const compact = agent.buildFollowUpDirective({ compact: true });
  assert.ok(compact.length < agent.buildFollowUpDirective().length);
  followUps(compact);
  // Pi reaches tasks through its REST command or bridged tool names — never the MCP names.
  for (const tool of [...TASK_TOOLS, 'create_task', 'complete_task', 'mcp__']) {
    assert.ok(!compact.includes(tool), `compact wording must not name ${tool}`);
  }
  assert.doesNotMatch(compact, /\?/);
  for (const line of compact.split('\n')) assert.ok(line.trim().length > 0, 'no blank line inside the compact directive');
});

test('buildFollowUpDirective: workflow concepts only — no literal status names in any variant', () => {
  const agent = bareAgent();
  for (const opts of [{}, { guardedCompletion: true }, { compact: true }]) {
    assert.doesNotMatch(agent.buildFollowUpDirective(opts), STATUS_LITERALS, JSON.stringify(opts));
  }
});

test('buildFollowUpDirective: no line can false-trigger line or tail attention detection', () => {
  const agent = bareAgent();
  const full = [CLAUDE_PROMPT_PATTERNS, CODEX_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS];
  const variants = [
    { text: agent.buildFollowUpDirective(), ids: ['claude', 'codex'], tables: full },
    { text: agent.buildFollowUpDirective({ guardedCompletion: true }), ids: ['claude', 'codex'], tables: full },
    { text: agent.buildFollowUpDirective({ compact: true }), ids: ['pi'], tables: [PI_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS] },
  ];
  for (const { text, ids, tables } of variants) {
    for (const line of text.split('\n')) {
      for (const patterns of tables) assert.equal(matchPromptLine(line, patterns), null, line);
    }
    for (const { re, agents } of buildLegacyPatternTable()) {
      if (agents && !agents.some(id => ids.includes(id))) continue;
      assert.ok(!re.test(text), `${ids.join('/')}: ${re}`);
    }
  }
});

// ── Delivery through buildSharedPreamble() ──

for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
  const id = new Agent().id;

  test(`${id}: follow-up capture lands once, after the task status scope, before the task text`, (t) => {
    const agent = new Agent();
    const prompt = agent.buildPrompt('Implement fixture task.', { projectPath: projectFixture(t), taskTags: ['tt-task-agent'] });
    followUps(prompt);
    const statusIdx = prompt.indexOf('Task status scope:');
    const followIdx = prompt.indexOf('Follow-up capture:');
    assert.ok(statusIdx >= 0 && statusIdx < followIdx, 'follow-up capture follows the task status scope');
    assert.ok(followIdx < prompt.lastIndexOf('Implement fixture task.'), 'follow-up capture precedes the task text');
    if (id === 'pi') {
      assert.ok(prompt.includes(agent.buildFollowUpDirective({ compact: true })), 'Pi gets the compact wording verbatim');
      assert.ok(!prompt.includes(agent.buildFollowUpDirective()), 'Pi never gets the full wording');
    } else {
      assert.ok(prompt.includes(agent.buildFollowUpDirective()), `${id} gets the full wording verbatim`);
    }
  });

  // Assert delivered meaning independently of buildSharedPreamble's own list, with and without a
  // vcsContext (which switches the full wording's deadline to complete_task).
  for (const withContext of [false, true]) {
    test(`${id}: followUps contract survives shared assembly and detects omission/duplication${withContext ? ' (vcsContext)' : ''}`, (t) => {
      const agent = new Agent();
      const opts = withContext ? { vcsContext: VCS_CONTEXT, vcsSettings: VCS_CONTEXT.vcs } : {};
      opts.projectPath = projectFixture(t);
      const build = () => agent.buildPrompt('Implement fixture task.', opts);
      followUps(build());
      const original = agent.buildFollowUpDirective.bind(agent);
      const stub = t.mock.method(agent, 'buildFollowUpDirective', () => '');
      assert.throws(() => followUps(build()), { code: 'ERR_ASSERTION' }, 'missing directive must fail the semantic contract');
      stub.mock.mockImplementation((...args) => {
        const directive = original(...args);
        return directive + '\n' + directive;
      });
      assert.throws(() => followUps(build()), { code: 'ERR_ASSERTION' }, 'duplicated directive must fail the semantic contract');
    });
  }

  test(`${id}: SIMPLE_MODE returns the bare task text, no follow-up capture`, () => {
    const script = [
      "process.env.SIMPLE_MODE = 'true';",
      `const Agent = require(${JSON.stringify(path.join(__dirname, `${id}-agent.js`))});`,
      "process.stdout.write(new Agent().buildPrompt('Implement fixture task.'));",
    ].join('\n');
    assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), 'Implement fixture task.');
  });
}

for (const Agent of [ClaudeAgent, CodexAgent]) {
  test(`${new Agent().id}: with a vcsContext the follow-up deadline is complete_task`, (t) => {
    const agent = new Agent();
    const prompt = agent.buildPrompt('Implement fixture task.', {
      projectPath: projectFixture(t), vcsContext: VCS_CONTEXT, vcsSettings: VCS_CONTEXT.vcs,
    });
    assert.ok(prompt.includes(agent.buildFollowUpDirective({ guardedCompletion: true })));
    assert.ok(!prompt.includes('before the final status update'));
  });
}

test('Claude design mode keeps follow-up capture out of the /design submission', () => {
  const prompt = new ClaudeAgent().buildPrompt('Fixture brief.', { designMode: true, taskTags: ['tt-task-agent'] });
  assert.ok(prompt.startsWith('/design '));
  assert.doesNotMatch(prompt, /Follow-up capture:/);
});

// ── Pi: REST transport and the echoed kickoff budget ──

test('Pi REST recipe documents keyless task creation, which compact follow-up filing relies on', (t) => {
  const prompt = new PiAgent().buildPrompt('Do the thing.', { projectPath: projectFixture(t) });
  assert.match(prompt, /Create with keyless POST \/tasks/);
});

// (C1119/C1116/C1117) The whole Pi kickoff is echoed verbatim into its TUI and rescanned by
// prompt-detect.js; the follow-up directive must not push it past the shared Pi REST ceiling
// (9300 normally; the existing git-all-on discovery exception is 9600 for its commit-on
// definition-of-done line). Do not increase either ceiling for follow-up instructions.
test('Pi kickoff with follow-up capture stays echo-safe and under its 9300/9600-char budgets', (t) => {
  const agent = new PiAgent();
  for (const scenario of [
    { discovery: false },
    { discovery: true },
    { discovery: true, vcsSettings: { type: 'git', worktree: true, commit: true, pr: true, merge: true } },
    { discovery: true, piMcpBridge: true },
  ]) {
    const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: projectFixture(t), ...scenario });
    for (const line of prompt.split('\n')) {
      assert.equal(matchPromptLine(line, PI_PROMPT_PATTERNS), null, `${JSON.stringify(scenario)} PI table matched: ${line}`);
      assert.equal(matchPromptLine(line, GENERIC_PROMPT_PATTERNS), null, `${JSON.stringify(scenario)} generic table matched: ${line}`);
    }
    for (const { re, agents } of buildLegacyPatternTable()) {
      if (agents && !agents.includes('pi')) continue;
      assert.ok(!re.test(prompt), `${JSON.stringify(scenario)} tail-scoped pattern matched the prompt: ${re}`);
    }
    assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*plan ready[.!]?\s*$/im);
    assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*questions ready[.!]?\s*$/im);
    const ceiling = scenario.vcsSettings ? 9600 : 9300;
    t.diagnostic(`Pi follow-up ${JSON.stringify(scenario)}: ${prompt.length} / ${ceiling}`);
    assert.ok(prompt.length < ceiling, `${JSON.stringify(scenario)} prompt grew to ${prompt.length} chars`);
  }
});
