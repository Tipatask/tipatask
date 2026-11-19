'use strict';
const { nativeComputerUse } = require('../computer-use-runtime');

// (TPT9225) Computer-use directive: only a run with available computer use (opts.computerUse) is
// told to check UI changes in the running app with it, never to quit or drive the live TipATask
// app, and — while planning — to keep to screenshots. Delivered once through buildSharedPreamble(),
// after the resource limits, in all three adapters. Modeled on cowboy-prompt.test.js — see
// ai/architecture/tt-task-agent.md § Computer Use Directive.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const BaseTaskAgent = require('./base-agent');
const ClaudeAgent = require('./claude-agent');
const CodexAgent = require('./codex-agent');
const PiAgent = require('./pi-agent');
const { resolveComputerUse } = require('../computer-use');
const { projectFixture, computerUse } = require('./prompt-contract-assertions');
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
const AGENTS = [ClaudeAgent, CodexAgent, PiAgent];
const available = (provider) => provider === 'claude' ? resolveComputerUse(provider, 'darwin', { command: '/opt/claude/bin/claude', serverSupported: true }) : nativeComputerUse(provider, '/opt/task-app', '/opt/task-app/dist/computer-use-arm64');

function bareAgent() {
  return new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
}

const policy = (agent, mode) => agent.buildPermissionPolicy({ mode, source: 'task' });

function kickoff(agent, t, extra = {}) {
  return agent.buildPrompt('Implement fixture task.', {
    projectPath: projectFixture(t), taskTags: ['tt-task-agent'], vcsContext: VCS_CONTEXT, vcsSettings: VCS_CONTEXT.vcs, piMcpBridge: true, ...extra,
  });
}

// ── BaseTaskAgent#buildComputerUseDirective ──

test('buildComputerUseDirective: only an available answer gets it', () => {
  const agent = bareAgent();
  assert.ok(agent.buildComputerUseDirective({ computerUse: available('claude') }).startsWith('Computer use:'));
  for (const opts of [{}, { computerUse: null }, { computerUse: resolveComputerUse('claude', 'linux') },
    { computerUse: resolveComputerUse('codex', 'darwin') }, { computerUse: { available: 'yes' } }]) {
    assert.equal(agent.buildComputerUseDirective(opts), opts.computerUse?.provider === 'codex' && opts.computerUse.reason ? `Computer use unavailable: ${opts.computerUse.reason}` : '', JSON.stringify(opts));
  }
  assert.equal(agent.buildComputerUseDirective(), '');
});

for (const compact of [false, true]) {
  test(`buildComputerUseDirective: ${compact ? 'compact' : 'full'} wording states the rules and detects their omission`, () => {
    const agent = bareAgent();
    for (const [mode, planning] of [['bypass', false], ['auto', false], ['plan', true], [null, true], [undefined, true]]) {
      const permissionPolicy = mode === undefined ? undefined : policy(agent, mode);
      const note = agent.buildComputerUseDirective({ computerUse: available('claude'), permissionPolicy, compact });
      computerUse(note, { planning });
      assert.doesNotMatch(note, /\?/);
      for (const line of note.split('\n')) assert.ok(line.trim().length > 0, 'no blank line inside the directive');
    }
    const note = agent.buildComputerUseDirective({ computerUse: available('claude'), permissionPolicy: policy(agent, 'plan'), compact });
    for (const rule of ['Never quit, restart or close the live TipATask app', 'kill its processes', 'click or type in its windows', 'Plan mode']) {
      assert.ok(note.includes(rule), rule);
      assert.throws(() => computerUse(note.replace(rule, ''), { planning: true }), { code: 'ERR_ASSERTION' }, `omitting ${rule} must fail`);
    }
  });
}

test('buildComputerUseDirective: names the agent\'s tools when their prefix is known; compact is shorter and fits Pi\'s echo', () => {
  const agent = bareAgent();
  assert.match(agent.buildComputerUseDirective({ computerUse: available('claude') }), /with the computer-use tools \(`mcp__computer-use__\*`\)\./);
  assert.match(agent.buildComputerUseDirective({ computerUse: available('pi'), compact: true }), /with the computer-use tools \(`computer-use__\*`\):/);
  assert.match(agent.buildComputerUseDirective({ computerUse: available('codex') }), /with the computer-use tools\. Use them/);
  for (const mode of ['plan', 'bypass']) {
    const opts = { computerUse: available('pi'), permissionPolicy: policy(agent, mode) };
    const full = agent.buildComputerUseDirective(opts);
    const compact = agent.buildComputerUseDirective({ ...opts, compact: true });
    assert.ok(compact.length < full.length);
    assert.ok(compact.length < 500, `compact wording is ${compact.length} chars — Pi echoes the whole kickoff`);
    assert.ok(!compact.includes('mcp__'), 'compact wording names no MCP tool');
  }
});

test('buildComputerUseDirective: no line can false-trigger line or tail attention detection', () => {
  const agent = bareAgent();
  const full = [CLAUDE_PROMPT_PATTERNS, CODEX_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS];
  const variants = [];
  for (const mode of ['plan', 'auto', 'bypass']) {
    variants.push({ text: agent.buildComputerUseDirective({ computerUse: available('claude'), permissionPolicy: policy(agent, mode) }), ids: ['claude', 'codex'], tables: full });
    variants.push({ text: agent.buildComputerUseDirective({ computerUse: available('pi'), permissionPolicy: policy(agent, mode), compact: true }),
      ids: ['pi'], tables: [PI_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS] });
  }
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

test('buildSharedPreamble: the computerUse slot sits after resourceLimits, before kbHygiene, and is empty without computer use', () => {
  for (const agent of [bareAgent(), new ClaudeAgent(), new CodexAgent(), new PiAgent()]) {
    const p = agent.buildSharedPreamble({ agentLimits: { maxSubagents: 3 }, computerUse: available(agent.id === 'x' ? 'claude' : agent.id) });
    assert.ok(p.computerUse.startsWith('Computer use:'));
    assert.deepEqual(p.directives, [p.processSafety, p.resourceLimits, p.computerUse, p.kbHygiene, p.taskStatus, p.followUps, p.cowboy]);
    const variant = agent.getPreamblePolicy().compact ? { compact: true } : {};
    assert.equal(p.computerUse, agent.buildComputerUseDirective({ computerUse: available(agent.id === 'x' ? 'claude' : agent.id), ...variant }));
    assert.equal(agent.buildSharedPreamble({}).computerUse, '');
  }
});

for (const Agent of AGENTS) {
  const id = new Agent().id;

  for (const mode of ['bypass', 'plan']) {
    test(`${id} ${mode}: a run with computer use gets the directive once, after the resource limits, before the task text`, (t) => {
      const agent = new Agent();
      const permissionPolicy = policy(agent, mode);
      const prompt = kickoff(agent, t, { permissionPolicy, computerUse: available(id) });
      computerUse(prompt, { planning: mode === 'plan' });
      const limitsIdx = prompt.indexOf('Resource limits:');
      const cuIdx = prompt.indexOf('Computer use:');
      assert.ok(limitsIdx >= 0 && limitsIdx < cuIdx, 'after the resource limits');
      assert.ok(cuIdx < prompt.indexOf('KB hygiene:'), 'before KB hygiene');
      assert.ok(cuIdx < prompt.lastIndexOf('Implement fixture task.'), 'before the task text');
      const expected = agent.buildComputerUseDirective({ permissionPolicy, computerUse: available(id), compact: id === 'pi' });
      assert.ok(prompt.includes(expected), `${id} gets its own wording verbatim`);
    });
  }

  test(`${id}: no directive without available computer use`, (t) => {
    const agent = new Agent();
    for (const extra of [{}, { computerUse: null }, { computerUse: resolveComputerUse(id, 'win32') }, { computerUse: resolveComputerUse(id, 'darwin') }]) {
      const prompt = kickoff(agent, t, { permissionPolicy: policy(agent, 'bypass'), ...extra });
      assert.doesNotMatch(prompt, /Computer use:|computer-use tools/, `${id} ${JSON.stringify(extra.computerUse?.reasonCode ?? extra.computerUse)}`);
    }
  });

  test(`${id}: omitting or duplicating the directive fails the semantic contract`, (t) => {
    const agent = new Agent();
    const build = () => kickoff(agent, t, { permissionPolicy: policy(agent, 'bypass'), computerUse: available(id) });
    computerUse(build());
    const original = agent.buildComputerUseDirective.bind(agent);
    const stub = t.mock.method(agent, 'buildComputerUseDirective', () => '');
    assert.throws(() => computerUse(build()), { code: 'ERR_ASSERTION' }, 'missing directive must fail');
    stub.mock.mockImplementation((...args) => {
      const directive = original(...args);
      return directive + '\n' + directive;
    });
    assert.throws(() => computerUse(build()), { code: 'ERR_ASSERTION' }, 'duplicated directive must fail');
  });
}

test('SIMPLE_MODE keeps the directive for an explicit Bypass run', (t) => {
  const config = require('../config');
  const previous = config.SIMPLE_MODE;
  config.SIMPLE_MODE = true;
  t.after(() => { config.SIMPLE_MODE = previous; });
  for (const Agent of AGENTS) {
    const agent = new Agent();
    computerUse(kickoff(agent, t, { permissionPolicy: policy(agent, 'bypass'), computerUse: available(agent.id) }));
  }
});
