'use strict';

// (TPT9163) Cowboy chain hand-off: only a bypass run launched with cowboyChain is told how its chain
// continues, never starting tasks itself. (TPT9195) Its successful completion starts the chain, and
// start_next_tasks (Claude/Codex), the bridged tool or `tt next` (Pi) is only the retry of an
// `unavailable` answer. Modeled on follow-up-prompt.test.js — see ai/architecture/tt-task-agent.md
// § Cowboy Directive.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const BaseTaskAgent = require('./base-agent');
const ClaudeAgent = require('./claude-agent');
const CodexAgent = require('./codex-agent');
const PiAgent = require('./pi-agent');
const { projectFixture, cowboyChain } = require('./prompt-contract-assertions');
const {
  matchPromptLine,
  CLAUDE_PROMPT_PATTERNS,
  CODEX_PROMPT_PATTERNS,
  PI_PROMPT_PATTERNS,
  GENERIC_PROMPT_PATTERNS,
  buildLegacyPatternTable,
} = require('./prompt-detect');

const VCS_CONTEXT = Object.freeze({
  verified: true, projectId: 2, checkedAt: '2026-01-01T00:00:00.000Z',
  vcs: { type: 'git', worktree: false, commit: true, pr: false, merge: false },
  runtime: { version: 'test', source: '/tmp/test', packaged: false, fingerprint: 'test', stale: false, protocol: 1 },
});
const STATUS_LITERALS = /\bpending\b|\bon_fire\b|\bin_progress\b|\bcompleted\b(?!:)/;
const AGENTS = [ClaudeAgent, CodexAgent, PiAgent];

function bareAgent() {
  return new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
}

function policy(agent, mode) {
  return agent.buildPermissionPolicy({ mode, source: 'task' });
}

function kickoff(agent, t, extra = {}) {
  return agent.buildPrompt('Implement fixture task.', {
    projectPath: projectFixture(t), taskTags: ['tt-task-agent'], vcsContext: VCS_CONTEXT, vcsSettings: VCS_CONTEXT.vcs, ...extra,
  });
}

// ── BaseTaskAgent#buildCowboyDirective ──

test('buildCowboyDirective: only a bypass run launched with cowboyChain gets it', () => {
  const agent = bareAgent();
  const bypass = policy(agent, 'bypass');
  assert.ok(agent.buildCowboyDirective({ cowboyChain: true, permissionPolicy: bypass }).startsWith('Cowboy chain:'));
  for (const opts of [
    {},
    { cowboyChain: true },
    { permissionPolicy: bypass },
    { cowboyChain: false, permissionPolicy: bypass },
    { cowboyChain: 'true', permissionPolicy: bypass },
    { cowboyChain: true, permissionPolicy: policy(agent, 'auto') },
    { cowboyChain: true, permissionPolicy: policy(agent, 'plan') },
    { cowboyChain: true, permissionPolicy: policy(agent, null) },
  ]) {
    assert.equal(agent.buildCowboyDirective(opts), '', JSON.stringify({ ...opts, permissionPolicy: opts.permissionPolicy?.mode }));
  }
  assert.equal(agent.buildCowboyDirective(), '');
});

for (const compact of [false, true]) {
  test(`buildCowboyDirective: ${compact ? 'compact' : 'full'} wording states the chain rules and detects their omission`, () => {
    const agent = bareAgent();
    const note = agent.buildCowboyDirective({ cowboyChain: true, permissionPolicy: policy(agent, 'bypass'), compact });
    cowboyChain(note);
    for (const rule of ['starts the chain itself', 'Never pick, start or work on the next tasks yourself', 'refused', 'unavailable', 'started task keys']) {
      assert.ok(note.includes(rule), rule);
      assert.throws(() => cowboyChain(note.replace(rule, '')), { code: 'ERR_ASSERTION' }, `omitting ${rule} must fail`);
    }
    assert.doesNotMatch(note, /\?/);
    assert.doesNotMatch(note, STATUS_LITERALS, 'workflow concepts only, never a status name');
    for (const line of note.split('\n')) assert.ok(line.trim().length > 0, 'no blank line inside the directive');
  });
}

test('buildCowboyDirective: full wording names complete_task and start_next_tasks; compact is shorter and names only its call', () => {
  const agent = bareAgent();
  const opts = { cowboyChain: true, permissionPolicy: policy(agent, 'bypass') };
  const full = agent.buildCowboyDirective(opts);
  assert.match(full, /When `complete_task` succeeds \(it returns completed: true\), it starts the chain itself/);
  assert.match(full, /`cowboyNext` lists the tasks it started, the reason, and `skipped`/);
  assert.match(full, /tipatask-local tool `start_next_tasks\(task_key\)` only as a retry: once, with this task's key, when `cowboyNext\.reason` is `unavailable`/);
  assert.match(full, /After any other answer, do not call it\./);
  assert.match(full, /its own new agent session with this run's agent and model/);
  const compact = agent.buildCowboyDirective({ ...opts, compact: true });
  assert.ok(compact.length < full.length);
  assert.match(compact, /Completion \(completed:true\) starts the chain itself[^\n]*cowboyNext/);
  for (const name of ['complete_task', 'mcp__']) assert.ok(!compact.includes(name), `compact wording must not name ${name}`);
  for (const nextCall of [undefined, '`tipatask-local__start_next_tasks(task_key)`', '`tt next "$TIPATASK_TASK_ID"`']) {
    const note = agent.buildCowboyDirective({ ...opts, compact: true, nextCall });
    assert.ok(note.length < 400, `compact wording is ${note.length} chars with ${nextCall} — Pi echoes the whole kickoff`);
  }
  assert.match(agent.buildCowboyDirective({ ...opts, compact: true, nextCall: '`tt next "$TIPATASK_TASK_ID"`' }),
    /Retry with `tt next "\$TIPATASK_TASK_ID"` once, only if cowboyNext\.reason is unavailable\./);
});

test('PiAgent#buildCowboyDirective: always compact; bridged tool with the MCP bridge, `tt next` without it', () => {
  const pi = new PiAgent();
  const opts = { cowboyChain: true, permissionPolicy: policy(pi, 'bypass') };
  const rest = pi.buildCowboyDirective(opts);
  const bridge = pi.buildCowboyDirective({ ...opts, piMcpBridge: true });
  assert.match(rest, /Retry with `tt next "\$TIPATASK_TASK_ID"` once, only if cowboyNext\.reason is unavailable/);
  assert.doesNotMatch(rest, /start_next_tasks/);
  assert.match(bridge, /Retry with `tipatask-local__start_next_tasks\(task_key\)` once, only if cowboyNext\.reason is unavailable/);
  assert.doesNotMatch(bridge, /tt next/);
  for (const note of [rest, bridge]) {
    cowboyChain(note);
    assert.doesNotMatch(note, /complete_task/);
  }
  assert.equal(pi.buildCowboyDirective({ ...opts, permissionPolicy: policy(pi, 'auto') }), '');
});

test('buildCowboyDirective: no line can false-trigger line or tail attention detection', () => {
  const agent = bareAgent();
  const pi = new PiAgent();
  const bypass = { cowboyChain: true, permissionPolicy: policy(agent, 'bypass') };
  const full = [CLAUDE_PROMPT_PATTERNS, CODEX_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS];
  const variants = [
    { text: agent.buildCowboyDirective(bypass), ids: ['claude', 'codex'], tables: full },
    { text: pi.buildCowboyDirective(bypass), ids: ['pi'], tables: [PI_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS] },
    { text: pi.buildCowboyDirective({ ...bypass, piMcpBridge: true }), ids: ['pi'], tables: [PI_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS] },
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

for (const Agent of AGENTS) {
  const id = new Agent().id;

  test(`${id}: a bypass cowboy run gets the directive once, after follow-up capture, before the task text`, (t) => {
    const agent = new Agent();
    const permissionPolicy = policy(agent, 'bypass');
    const prompt = kickoff(agent, t, { permissionPolicy, cowboyChain: true, piMcpBridge: true });
    cowboyChain(prompt);
    const followIdx = prompt.indexOf('Follow-up capture:');
    const cowboyIdx = prompt.indexOf('Cowboy chain:');
    assert.ok(followIdx >= 0 && followIdx < cowboyIdx, 'the hand-off follows follow-up capture');
    assert.ok(cowboyIdx < prompt.lastIndexOf('Implement fixture task.'), 'the hand-off precedes the task text');
    const expected = agent.buildCowboyDirective({ permissionPolicy, cowboyChain: true, piMcpBridge: true, compact: id === 'pi' });
    assert.ok(prompt.includes(expected), `${id} gets its own wording verbatim`);
    if (id === 'pi') assert.match(prompt, /tipatask-local__start_next_tasks\(task_key\)/);
    else assert.match(prompt, /tipatask-local tool `start_next_tasks\(task_key\)`/);
  });

  test(`${id}: no directive for a run without cowboyChain or outside bypass`, (t) => {
    const agent = new Agent();
    for (const extra of [
      { permissionPolicy: policy(agent, 'bypass') },
      { permissionPolicy: policy(agent, 'auto'), cowboyChain: true },
      { permissionPolicy: policy(agent, 'plan'), cowboyChain: true },
      { cowboyChain: true },
    ]) {
      const prompt = kickoff(agent, t, extra);
      assert.doesNotMatch(prompt, /Cowboy chain:|start_next_tasks|tt next/, `${id} ${JSON.stringify({ ...extra, permissionPolicy: extra.permissionPolicy?.mode })}`);
    }
  });

  test(`${id}: omitting or duplicating the directive fails the semantic contract`, (t) => {
    const agent = new Agent();
    const build = () => kickoff(agent, t, { permissionPolicy: policy(agent, 'bypass'), cowboyChain: true });
    cowboyChain(build());
    const original = agent.buildCowboyDirective.bind(agent);
    const stub = t.mock.method(agent, 'buildCowboyDirective', () => '');
    assert.throws(() => cowboyChain(build()), { code: 'ERR_ASSERTION' }, 'missing directive must fail');
    stub.mock.mockImplementation((...args) => {
      const directive = original(...args);
      return directive + '\n' + directive;
    });
    assert.throws(() => cowboyChain(build()), { code: 'ERR_ASSERTION' }, 'duplicated directive must fail');
  });
}

test('SIMPLE_MODE keeps the directive for an explicit bypass cowboy run', (t) => {
  const config = require('../config');
  const previous = config.SIMPLE_MODE;
  config.SIMPLE_MODE = true;
  t.after(() => { config.SIMPLE_MODE = previous; });
  for (const Agent of AGENTS) {
    const agent = new Agent();
    cowboyChain(kickoff(agent, t, { permissionPolicy: policy(agent, 'bypass'), cowboyChain: true }));
  }
});

test('Claude design mode keeps the directive out of the /design submission', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Fixture brief.', { designMode: true, cowboyChain: true, permissionPolicy: policy(agent, 'bypass') });
  assert.ok(prompt.startsWith('/design '));
  assert.doesNotMatch(prompt, /Cowboy chain:/);
});

// The whole Pi kickoff is echoed into its TUI and rescanned by prompt-detect.js. Bypass kickoffs
// carry the permission policy instead of the planning text; the cowboy hand-off must keep them
// echo-safe and inside the 12,000-character Pi budget (PI_PROMPT_BUDGET in pi-agent.js).
test('Pi cowboy kickoff stays echo-safe and under the Pi prompt budget', (t) => {
  const agent = new PiAgent();
  const permissionPolicy = policy(agent, 'bypass');
  for (const scenario of [
    { discovery: false },
    { discovery: true },
    { discovery: true, vcsSettings: { type: 'git', worktree: true, commit: true, pr: true, merge: true } },
    { discovery: true, piMcpBridge: true },
    { discovery: true, piMcpBridge: true, vcsSettings: { type: 'git', worktree: true, commit: true, pr: true, merge: true } },
  ]) {
    const opts = { taskTags: ['tt-pi-session'], projectPath: projectFixture(t), permissionPolicy, ...scenario };
    const prompt = agent.buildPrompt('Do the thing.', { ...opts, cowboyChain: true });
    cowboyChain(prompt);
    for (const line of prompt.split('\n')) {
      assert.equal(matchPromptLine(line, PI_PROMPT_PATTERNS), null, `${JSON.stringify(scenario)} PI table matched: ${line}`);
      assert.equal(matchPromptLine(line, GENERIC_PROMPT_PATTERNS), null, `${JSON.stringify(scenario)} generic table matched: ${line}`);
    }
    for (const { re, agents } of buildLegacyPatternTable()) {
      if (agents && !agents.includes('pi')) continue;
      assert.ok(!re.test(prompt), `${JSON.stringify(scenario)} tail-scoped pattern matched the prompt: ${re}`);
    }
    assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*(?:plan|questions) ready[.!]?\s*$/im);
    const growth = prompt.length - agent.buildPrompt('Do the thing.', opts).length;
    t.diagnostic(`Pi cowboy ${JSON.stringify(scenario)}: ${prompt.length} / 12000 (+${growth})`);
    assert.ok(prompt.length < 12000, `${JSON.stringify(scenario)} prompt grew to ${prompt.length} chars`);
    assert.ok(growth < 400, `the hand-off added ${growth} chars`);
  }
});
