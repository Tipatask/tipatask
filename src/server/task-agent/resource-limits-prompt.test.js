'use strict';

// Resource-limits directive applied to task-agent kickoff prompts: the spawn-side half of the
// agent resource limits. Every agent is told the same sub-agent cap the descendant watchdog
// enforces (process-group.js#resolveAgentLimits), so it stays inside the cap instead of being
// caught after the fact. Modeled on kb-hygiene-prompt.test.js (same helper pattern, same
// directive shape) — see ai/architecture/tt-task-agent.md § Resource Limits Directive.

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
const { AGENT_LIMIT_DEFAULTS, resolveAgentLimits } = require('../process-group');
const {
  matchPromptLine,
  CODEX_PROMPT_PATTERNS,
  PI_PROMPT_PATTERNS,
  GENERIC_PROMPT_PATTERNS,
  buildLegacyPatternTable,
} = require('./prompt-detect');

const DEFAULT_CAP = AGENT_LIMIT_DEFAULTS.maxSubagents;
const capRe = (cap) => new RegExp(`at most ${cap} sub-agents or background commands in parallel`);

function bareAgent() {
  return new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
}

function makeProjectDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-reslimits-prompt-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  return dir;
}

// ── BaseTaskAgent#buildResourceLimitsDirective ──

test('buildResourceLimitsDirective: states the cap, serial test/build runs, and background cleanup', () => {
  const note = bareAgent().buildResourceLimitsDirective({ maxSubagents: 7 });
  assert.ok(note.startsWith('Resource limits:'));
  assert.match(note, capRe(7));
  assert.match(note, /Never run test or build commands in parallel/);
  assert.match(note, /Before finishing, stop every background command and sub-agent you started/);
});

test('buildResourceLimitsDirective: missing or invalid limits fall back to the default cap', () => {
  const agent = bareAgent();
  const bad = [undefined, null, {}, { maxSubagents: 0 }, { maxSubagents: -2 }, { maxSubagents: '6' },
    { maxSubagents: 2.5 }, { maxSubagents: NaN }, { maxSubagents: Infinity }];
  for (const limits of bad) {
    for (const variant of [{}, { compact: true }]) {
      assert.match(agent.buildResourceLimitsDirective(limits, variant), capRe(DEFAULT_CAP),
        `limits=${JSON.stringify(limits)} compact=${!!variant.compact}`);
    }
  }
});

test('buildResourceLimitsDirective: takes the resolved limits object as is', () => {
  const limits = resolveAgentLimits('/p', {
    env: {}, readConfig: () => ({ AGENT_LIMITS_MAX_SUBAGENTS: 6 }), hardware: { totalMemBytes: 48 * 2 ** 30, cores: 12 },
  });
  assert.match(bareAgent().buildResourceLimitsDirective(limits), capRe(6));
});

test('buildResourceLimitsDirective: compact wording is shorter, keeps all three rules, stays echo-safe', () => {
  const agent = bareAgent();
  const full = agent.buildResourceLimitsDirective({ maxSubagents: 4 });
  const compact = agent.buildResourceLimitsDirective({ maxSubagents: 4 }, { compact: true });
  assert.ok(compact.length < full.length);
  assert.ok(compact.length < 260, `compact directive grew to ${compact.length} chars`);
  assert.match(compact, capRe(4));
  assert.match(compact, /test and build commands one at a time, never in parallel/);
  assert.match(compact, /Stop all background work you started before finishing/);
  assert.doesNotMatch(compact, /\?/);
  for (const line of compact.split('\n')) {
    assert.ok(line.trim().length > 0, 'no blank line inside the compact directive');
  }
});

// ── Cap number in every agent's kickoff prompt ──

for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
  test(`${new Agent().id}.buildPrompt: carries the threaded sub-agent cap, default when none is threaded`, (t) => {
    const agent = new Agent();
    const projectPath = require('./prompt-contract-assertions').projectFixture(t);
    const base = { taskTags: ['tt-task-agent'], projectPath };

    const threaded = agent.buildPrompt('Do the thing.', { ...base, agentLimits: { maxSubagents: 7 } });
    assert.match(threaded, capRe(7));
    assert.doesNotMatch(threaded, capRe(DEFAULT_CAP));

    const fallback = agent.buildPrompt('Do the thing.', base);
    assert.match(fallback, capRe(DEFAULT_CAP));

    const noteIdx = threaded.indexOf('Resource limits:');
    assert.ok(noteIdx >= 0 && noteIdx < threaded.lastIndexOf('Do the thing.'), 'directive precedes the task prompt');
    assert.ok(threaded.indexOf('Process safety:') < noteIdx, 'resource limits follow process safety');
    assert.ok(noteIdx < threaded.indexOf('KB hygiene:'), 'resource limits precede KB hygiene');
  });
}

test('Claude and Codex get the full wording, Pi the compact one', (t) => {
  const projectPath = require('./prompt-contract-assertions').projectFixture(t);
  const opts = { projectPath, agentLimits: { maxSubagents: 7 } };
  for (const agent of [new ClaudeAgent(), new CodexAgent()]) {
    const prompt = agent.buildPrompt('Do the thing.', opts);
    assert.ok(prompt.includes(agent.buildResourceLimitsDirective(opts.agentLimits)), agent.id);
  }
  const pi = new PiAgent();
  const prompt = pi.buildPrompt('Do the thing.', opts);
  assert.ok(prompt.includes(pi.buildResourceLimitsDirective(opts.agentLimits, { compact: true })));
  assert.ok(!prompt.includes(pi.buildResourceLimitsDirective(opts.agentLimits)));
});

// The real spawn path must hand the resolved limits to the adapter, or every kickoff would
// silently state the default instead of the project's configured cap.
test('terminal-session.js threads resolveAgentLimits() into getSpawnSpec() as agentLimits', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'terminal-session.js'), 'utf8');
  assert.match(src, /const agentLimits = resolveAgentLimits\(session\.projectPath \|\| config\.PROJECT_ROOT\);/);
  assert.match(src, /agent\.getSpawnSpec\([^\n]*\bagentLimits\b/);
});

// ── Modes that carry no shared directives ──

test('ClaudeAgent.buildPrompt: designMode wins — no resource-limits directive fused into the /design brief', () => {
  const prompt = new ClaudeAgent().buildPrompt('Do the thing', { designMode: true, agentLimits: { maxSubagents: 7 } });
  assert.ok(prompt.startsWith('/design '));
  assert.doesNotMatch(prompt, /Resource limits:/);
});

// SIMPLE_MODE is read off the module-level config singleton — verified in a child process so
// this file's own singleton is untouched. Same idiom as kb-hygiene-prompt.test.js.
for (const file of ['claude-agent.js', 'codex-agent.js', 'pi-agent.js']) {
  test(`${file}: SIMPLE_MODE wins — bare prompt, no resource-limits directive`, () => {
    const script = [
      `process.env.SIMPLE_MODE = 'true';`,
      `const Agent = require(${JSON.stringify(path.join(__dirname, file))});`,
      `const prompt = new Agent().buildPrompt('Do the thing.', { agentLimits: { maxSubagents: 7 } });`,
      `process.stdout.write(prompt);`,
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(out, 'Do the thing.');
  });
}

// ── Echo safety ──

test('CodexAgent: resource-limits lines cannot false-trigger anchored plan-ready detection', () => {
  const note = new CodexAgent().buildResourceLimitsDirective({ maxSubagents: 7 });
  for (const line of note.split('\n')) {
    assert.equal(matchPromptLine(line, CODEX_PROMPT_PATTERNS), null, `Codex table matched: ${line}`);
  }
});

// Same echo-safety battery every other Pi prompt-content test runs — the whole kickoff prompt
// is echoed verbatim into Pi's own TUI and scanned by prompt-detect.js.
test('PiAgent.buildPrompt: resource-limits directive cannot false-trigger the attention/plan-ready detectors, stays under the size budget', (t) => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    for (const discovery of [false, true]) {
      // A three-digit cap is the widest value worth budgeting for.
      const prompt = agent.buildPrompt('Do the thing.', {
        taskTags: ['tt-pi-session'], projectPath: dir, discovery, agentLimits: { maxSubagents: 128 },
      });
      assert.match(prompt, capRe(128));

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

      t.diagnostic(`Pi resource-limits/discovery=${discovery}: ${prompt.length} / 9300`);
      assert.ok(prompt.length < 9300, `[discovery=${discovery}] prompt grew to ${prompt.length} chars`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Assert delivered meaning independently of buildSharedPreamble's own list.
for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
  test(`${new Agent().id}: resourceLimits contract survives shared assembly and detects omission/duplication`, (t) => {
    const agent = new Agent();
    const { resourceLimits: verify, projectFixture } = require('./prompt-contract-assertions');
    const opts = { projectPath: projectFixture(t), agentLimits: { maxSubagents: 7 } };
    const build = () => agent.buildPrompt('Implement fixture task.', opts);
    verify(build(), 7);
    assert.throws(() => verify(build(), DEFAULT_CAP), { code: 'ERR_ASSERTION' }, 'a wrong cap must fail the semantic contract');
    const original = agent.buildResourceLimitsDirective.bind(agent);
    const stub = t.mock.method(agent, 'buildResourceLimitsDirective', () => '');
    assert.throws(() => verify(build(), 7), { code: 'ERR_ASSERTION' }, 'missing directive must fail the semantic contract');
    stub.mock.mockImplementation((...args) => {
      const directive = original(...args);
      return directive + '\n' + directive;
    });
    assert.throws(() => verify(build(), 7), { code: 'ERR_ASSERTION' }, 'duplicated directive must fail the semantic contract');
  });
}
