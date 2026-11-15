'use strict';

// (TPT9317) KB discovery directive: a project created with the wizard's compose preset
// (KB_MODE 'compose' in .tipatask/config.json, TPT9316) ran no discovery tasks, so every CODING
// kickoff tells the agent to document what the task touches — inspect the code, create the
// missing tt-* tags, write standing facts into the matching architecture doc, tag the task.
// Present only in compose mode for CODING tasks; absent otherwise and for HUMAN tasks.
// Modeled on follow-up-prompt.test.js — see ai/architecture/tt-task-agent.md
// § KB Discovery Directive (compose mode).

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
const { KB_MODE_COMPOSE } = require('../project-config');
const { projectFixture, kbDiscovery, kbHygiene, taskStatus, followUps } = require('./prompt-contract-assertions');
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

const CODING = Object.freeze({ id: 'TPT1', category: 'CODING' });
const HUMAN = Object.freeze({ id: 'H1', category: 'HUMAN' });
const COMPOSE = Object.freeze({ kbMode: 'compose', task: CODING });
const MCP_TOOLS = ['list_system_tags', 'create_system_tag', 'update_task', 'complete_task', 'mcp__'];
const STATUS_LITERALS = /\bpending\b|\bon_fire\b|\bin_progress\b|\bcompleted\b/;

function bareAgent() {
  return new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
}

function projectWithConfig(t, cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-kb-discovery-'));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify(cfg));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// ── BaseTaskAgent.resolveKbMode ──

test('resolveKbMode: compose only from the project\'s own config.json KB_MODE', (t) => {
  assert.equal(KB_MODE_COMPOSE, 'compose');
  assert.equal(BaseTaskAgent.resolveKbMode(projectWithConfig(t, { KB_MODE: 'compose' })), 'compose');
  for (const cfg of [{}, { KB_MODE: '' }, { KB_MODE: 'Compose' }, { KB_MODE: 'default' }, { KB_MODE: true }]) {
    assert.equal(BaseTaskAgent.resolveKbMode(projectWithConfig(t, cfg)), null, JSON.stringify(cfg));
  }
  const noConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-kb-discovery-none-'));
  t.after(() => fs.rmSync(noConfig, { recursive: true, force: true }));
  assert.equal(BaseTaskAgent.resolveKbMode(noConfig), null, 'a project without config.json');
  for (const root of [undefined, null, '', 42, {}]) assert.equal(BaseTaskAgent.resolveKbMode(root), null, String(root));
});

test('resolveKbMode: never process.env — an exported KB_MODE reaches no other project', (t) => {
  const previous = process.env.KB_MODE;
  process.env.KB_MODE = 'compose';
  t.after(() => { if (previous === undefined) delete process.env.KB_MODE; else process.env.KB_MODE = previous; });
  assert.equal(BaseTaskAgent.resolveKbMode(projectWithConfig(t, {})), null);
});

// ── BaseTaskAgent#buildKbDiscoveryDirective ──

test('buildKbDiscoveryDirective: only a CODING task of a compose project gets it', () => {
  const agent = bareAgent();
  for (const compact of [false, true]) {
    assert.ok(agent.buildKbDiscoveryDirective({ ...COMPOSE, compact }).startsWith('KB discovery:'));
    for (const opts of [
      {},
      { task: CODING },
      { kbMode: null, task: CODING },
      { kbMode: 'Compose', task: CODING },
      { kbMode: 'default', task: CODING },
      { kbMode: 'compose' },
      { kbMode: 'compose', task: null },
      { kbMode: 'compose', task: {} },
      { kbMode: 'compose', task: HUMAN },
      { kbMode: 'compose', task: { id: 'TPT2', category: 'coding' } },
    ]) {
      assert.equal(agent.buildKbDiscoveryDirective({ ...opts, compact }), '', `${JSON.stringify(opts)} compact=${compact}`);
    }
  }
});

for (const [label, opts] of [['full', {}], ['guarded', { guardedCompletion: true }], ['compact', { compact: true }]]) {
  test(`buildKbDiscoveryDirective: ${label} wording carries every rule and detects their omission`, () => {
    const note = bareAgent().buildKbDiscoveryDirective({ ...COMPOSE, ...opts });
    kbDiscovery(note);
    for (const rule of [
      'KB discovery:',
      'as it goes',
      'separate discovery',
      'Inspect the code',
      'touched module no',
      'standing facts',
      'GENERAL.md',
      'this task before',
    ]) {
      assert.ok(note.includes(rule), rule);
      assert.throws(() => kbDiscovery(note.split(rule).join('')), { code: 'ERR_ASSERTION' }, `omitting ${rule} must fail`);
    }
  });
}

test('buildKbDiscoveryDirective: full wording names the tag tools, the stub hand-off and the KB placeholder', () => {
  const note = bareAgent().buildKbDiscoveryDirective(COMPOSE);
  assert.match(note, /`list_system_tags`/);
  assert.match(note, /`create_system_tag\(tag_name, description, architecture_hint\)`/);
  assert.match(note, /`architecture_hint` naming the module's purpose, key files and endpoints/);
  assert.match(note, /follow the `next_step` it returns so the stub is on disk/);
  assert.match(note, /`update_task` with a final tag list/);
  assert.match(note, /"not documented yet" placeholder/);
  assert.match(note, /never file a separate discovery or documentation task/);
  assert.match(note, /Planning only reads/);
  assert.match(note, /KB hygiene above still applies/);
});

test('buildKbDiscoveryDirective: guardedCompletion makes complete_task the deadline; compact ignores the flag', () => {
  const agent = bareAgent();
  assert.match(agent.buildKbDiscoveryDirective({ ...COMPOSE, guardedCompletion: true }), /Tag this task before `complete_task`/);
  const legacy = agent.buildKbDiscoveryDirective(COMPOSE);
  assert.match(legacy, /Tag this task before the final status update/);
  assert.doesNotMatch(legacy, /complete_task/);
  assert.equal(
    agent.buildKbDiscoveryDirective({ ...COMPOSE, compact: true, guardedCompletion: true }),
    agent.buildKbDiscoveryDirective({ ...COMPOSE, compact: true }),
  );
});

test('buildKbDiscoveryDirective: compact wording is short, names no MCP tool, asks nothing', () => {
  const agent = bareAgent();
  const compact = agent.buildKbDiscoveryDirective({ ...COMPOSE, compact: true });
  assert.ok(compact.length < agent.buildKbDiscoveryDirective(COMPOSE).length);
  assert.ok(compact.length < 500, `compact directive is ${compact.length} chars`);
  for (const tool of MCP_TOOLS) assert.ok(!compact.includes(tool), `compact wording must not name ${tool}`);
  assert.doesNotMatch(compact, /\?/);
  for (const line of compact.split('\n')) assert.ok(line.trim().length > 0, 'no blank line inside the compact directive');
});

test('PiAgent#buildKbDiscoveryDirective: always compact; bridged tool with the MCP bridge, REST registration without it', () => {
  const pi = new PiAgent();
  const rest = pi.buildKbDiscoveryDirective(COMPOSE);
  kbDiscovery(rest);
  assert.match(rest, /register its tag with a real description \(POST \/tags\)/);
  for (const tool of MCP_TOOLS) assert.ok(!rest.includes(tool), `REST wording must not name ${tool}`);
  const bridge = pi.buildKbDiscoveryDirective({ ...COMPOSE, piMcpBridge: true });
  kbDiscovery(bridge);
  assert.match(bridge, /tipatask__create_system_tag and a real description, then follow its next_step/);
  assert.doesNotMatch(bridge, /mcp__|POST \/tags/);
  for (const note of [rest, bridge]) {
    assert.doesNotMatch(note, /\?/);
    assert.ok(note.length < 500, `Pi directive is ${note.length} chars`);
  }
  assert.equal(pi.buildKbDiscoveryDirective({ kbMode: 'compose', task: HUMAN, piMcpBridge: true }), '');
});

test('buildKbDiscoveryDirective: workflow concepts only — no literal status names in any variant', () => {
  const agent = bareAgent();
  const pi = new PiAgent();
  for (const note of [
    agent.buildKbDiscoveryDirective(COMPOSE),
    agent.buildKbDiscoveryDirective({ ...COMPOSE, guardedCompletion: true }),
    agent.buildKbDiscoveryDirective({ ...COMPOSE, compact: true }),
    pi.buildKbDiscoveryDirective(COMPOSE),
    pi.buildKbDiscoveryDirective({ ...COMPOSE, piMcpBridge: true }),
  ]) {
    assert.doesNotMatch(note, STATUS_LITERALS, note);
  }
});

test('buildKbDiscoveryDirective: no line can false-trigger line or tail attention detection', () => {
  const agent = bareAgent();
  const pi = new PiAgent();
  const full = [CLAUDE_PROMPT_PATTERNS, CODEX_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS];
  const piTables = [PI_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS];
  const variants = [
    { text: agent.buildKbDiscoveryDirective(COMPOSE), ids: ['claude', 'codex'], tables: full },
    { text: agent.buildKbDiscoveryDirective({ ...COMPOSE, guardedCompletion: true }), ids: ['claude', 'codex'], tables: full },
    { text: pi.buildKbDiscoveryDirective(COMPOSE), ids: ['pi'], tables: piTables },
    { text: pi.buildKbDiscoveryDirective({ ...COMPOSE, piMcpBridge: true }), ids: ['pi'], tables: piTables },
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

  test(`${id}: a compose project's CODING kickoff carries the note once, after KB hygiene, before task status`, (t) => {
    const agent = new Agent();
    const prompt = agent.buildPrompt('Implement fixture task.', { projectPath: projectFixture(t), taskTags: ['tt-task-agent'], ...COMPOSE });
    kbDiscovery(prompt);
    kbHygiene(prompt);
    taskStatus(prompt);
    followUps(prompt);
    const hygieneIdx = prompt.indexOf('KB hygiene:');
    const discoveryIdx = prompt.indexOf('KB discovery:');
    const statusIdx = prompt.indexOf('Task status scope:');
    assert.ok(hygieneIdx >= 0 && hygieneIdx < discoveryIdx, 'KB discovery follows KB hygiene');
    assert.ok(discoveryIdx < statusIdx, 'KB discovery precedes the task status scope');
    assert.ok(discoveryIdx < prompt.lastIndexOf('Implement fixture task.'), 'KB discovery precedes the task text');
    if (id === 'pi') {
      assert.ok(prompt.includes(agent.buildKbDiscoveryDirective(COMPOSE)), 'Pi gets its compact REST wording verbatim');
      assert.ok(!prompt.includes(bareAgent().buildKbDiscoveryDirective(COMPOSE)), 'Pi never gets the full wording');
    } else {
      assert.ok(prompt.includes(agent.buildKbDiscoveryDirective(COMPOSE)), `${id} gets the full wording verbatim`);
    }
  });

  test(`${id}: no note for a HUMAN task, outside compose mode, or without a task row`, (t) => {
    const agent = new Agent();
    const projectPath = projectFixture(t);
    for (const opts of [
      { kbMode: 'compose', task: HUMAN },
      { kbMode: null, task: CODING },
      { task: CODING },
      { kbMode: 'compose' },
    ]) {
      const prompt = agent.buildPrompt('Implement fixture task.', { projectPath, ...opts });
      assert.doesNotMatch(prompt, /KB discovery:/, JSON.stringify(opts));
      assert.doesNotMatch(prompt, /composes its (?:KB|knowledge base) as it goes/, JSON.stringify(opts));
      followUps(prompt);
    }
  });

  // Assert delivered meaning independently of buildSharedPreamble's own list, with and without a
  // vcsContext (which switches the full wording's deadline to complete_task).
  for (const withContext of [false, true]) {
    test(`${id}: kbDiscovery contract survives shared assembly and detects omission/duplication${withContext ? ' (vcsContext)' : ''}`, (t) => {
      const agent = new Agent();
      const opts = withContext ? { ...COMPOSE, vcsContext: VCS_CONTEXT, vcsSettings: VCS_CONTEXT.vcs } : { ...COMPOSE };
      opts.projectPath = projectFixture(t);
      const build = () => agent.buildPrompt('Implement fixture task.', opts);
      kbDiscovery(build());
      const original = agent.buildKbDiscoveryDirective.bind(agent);
      const stub = t.mock.method(agent, 'buildKbDiscoveryDirective', () => '');
      assert.throws(() => kbDiscovery(build()), { code: 'ERR_ASSERTION' }, 'missing directive must fail the semantic contract');
      stub.mock.mockImplementation((...args) => {
        const directive = original(...args);
        return directive + '\n' + directive;
      });
      assert.throws(() => kbDiscovery(build()), { code: 'ERR_ASSERTION' }, 'duplicated directive must fail the semantic contract');
    });
  }

  test(`${id}: legacy SIMPLE_MODE returns the bare task text, no KB discovery note`, () => {
    const script = [
      "process.env.SIMPLE_MODE = 'true';",
      `const Agent = require(${JSON.stringify(path.join(__dirname, `${id}-agent.js`))});`,
      "process.stdout.write(new Agent().buildPrompt('Implement fixture task.', { kbMode: 'compose', task: { id: 'TPT1', category: 'CODING' } }));",
    ].join('\n');
    assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), 'Implement fixture task.');
  });
}

for (const Agent of [ClaudeAgent, CodexAgent]) {
  test(`${new Agent().id}: with a vcsContext the KB discovery deadline is complete_task`, (t) => {
    const agent = new Agent();
    const prompt = agent.buildPrompt('Implement fixture task.', {
      projectPath: projectFixture(t), vcsContext: VCS_CONTEXT, vcsSettings: VCS_CONTEXT.vcs, ...COMPOSE,
    });
    assert.ok(prompt.includes(agent.buildKbDiscoveryDirective({ ...COMPOSE, guardedCompletion: true })));
    assert.doesNotMatch(prompt, /Tag this task before the final status update/);
  });
}

test('an explicit permission policy keeps the note in SIMPLE_MODE, as every shared directive', (t) => {
  const config = require('../config');
  const previous = config.SIMPLE_MODE;
  config.SIMPLE_MODE = true;
  t.after(() => { config.SIMPLE_MODE = previous; });
  for (const agent of [new ClaudeAgent(), new CodexAgent(), new PiAgent()]) {
    const permissionPolicy = agent.buildPermissionPolicy({ mode: 'auto', source: 'task' });
    kbDiscovery(agent.buildPrompt('Implement fixture task.', { ...COMPOSE, permissionPolicy, projectPath: projectFixture(t) }));
  }
});

test('Claude design mode keeps the KB discovery note out of the /design submission', () => {
  const prompt = new ClaudeAgent().buildPrompt('Fixture brief.', { designMode: true, taskTags: ['tt-task-agent'], ...COMPOSE });
  assert.ok(prompt.startsWith('/design '));
  assert.doesNotMatch(prompt, /KB discovery:/);
});

// ── Pi: the echoed kickoff budget ──

// (C1119/C1116/C1117) The whole Pi kickoff is echoed verbatim into its TUI and rescanned by
// prompt-detect.js. A compose-mode CODING kickoff stays under the shared Pi ceilings (9300; 9600
// with every Git flag on), grows by under 500 characters, and its worst case (a discovery-tagged
// task with every Git flag on) stays inside the 12,000-character assembled Pi budget.
test('Pi compose-mode kickoff stays echo-safe and inside its budgets', (t) => {
  const agent = new PiAgent();
  const projectPath = projectFixture(t);
  const GIT_ALL_ON = { type: 'git', worktree: true, commit: true, pr: true, merge: true };
  for (const scenario of [
    {},
    { piMcpBridge: true },
    { vcsSettings: GIT_ALL_ON },
    { discovery: true, vcsSettings: GIT_ALL_ON },
  ]) {
    const base = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath, ...scenario });
    const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath, ...scenario, ...COMPOSE });
    kbDiscovery(prompt);
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
    const ceiling = scenario.discovery ? 12000 : scenario.vcsSettings ? 9600 : 9300;
    t.diagnostic(`Pi compose ${JSON.stringify(scenario)}: ${prompt.length} / ${ceiling} (+${prompt.length - base.length})`);
    assert.ok(prompt.length < ceiling, `${JSON.stringify(scenario)} prompt grew to ${prompt.length} chars`);
    assert.ok(prompt.length - base.length < 500, `${JSON.stringify(scenario)} the note added ${prompt.length - base.length} chars`);
  }
});
