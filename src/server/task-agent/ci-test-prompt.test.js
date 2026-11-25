'use strict';

// (TPT9393) CI-compatible tests directive. The Task App unit suite also runs on GitHub (Linux
// runner, the committed public snapshot, no signed-in account, no Electron binary), and its tests
// read production source: a change can break a test file its author never opened. A project that
// holds this source therefore gets a kickoff note: run the whole suite after the last source or
// test change and before the commit, a focused run is not a CI result, and new tests follow the
// project's CI checklist. Present only where BaseTaskAgent.resolveCiTests() finds the source;
// every other project's kickoff is unchanged. Modeled on kb-discovery-prompt.test.js — see
// ai/architecture/tt-task-agent.md § CI-Compatible Tests Directive.

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
const { resolvePresetHarness } = require('../project-seeder');
const { projectFixture, ciTests, kbHygiene, taskStatus, followUps } = require('./prompt-contract-assertions');
const {
  matchPromptLine,
  CLAUDE_PROMPT_PATTERNS,
  CODEX_PROMPT_PATTERNS,
  PI_PROMPT_PATTERNS,
  GENERIC_PROMPT_PATTERNS,
  buildLegacyPatternTable,
} = require('./prompt-detect');

// Deliberately spelled out here, not read from base-agent.js: the names a project is recognised by
// and the checklist the directive points at are part of the contract under test.
const MOUNT = 'ai/todo/server';
const DOC = 'ai/architecture/tt-ci.md';
const SECTION = 'Writing tests that pass on GitHub';
const MONOREPO = Object.freeze({ ciTests: Object.freeze({ dir: MOUNT, doc: DOC }) });
const MONOREPO_NO_DOC = Object.freeze({ ciTests: Object.freeze({ dir: MOUNT, doc: null }) });
const STANDALONE = Object.freeze({ ciTests: Object.freeze({ dir: '', doc: null }) });
const MCP_TOOLS = ['list_system_tags', 'create_task_comment', 'update_task', 'complete_task', 'mcp__'];
const STATUS_LITERALS = /\bpending\b|\bon_fire\b|\bin_progress\b|\bcompleted\b/;

// The strict live-read context every real task-terminal spawn threads (vcs-context.js).
const VCS_CONTEXT = Object.freeze({
  verified: true, projectId: 2, checkedAt: '2026-01-01T00:00:00.000Z',
  vcs: { type: 'git', worktree: false, commit: true, pr: false, merge: false },
  runtime: { version: 'test', source: '/tmp/test', packaged: false, fingerprint: 'test', stale: false, protocol: 1 },
});

function bareAgent() {
  return new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
}

// A scratch project tree: { 'relative/path': 'content' }, removed after the test.
function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-ci-tests-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

// The two files a Task App checkout is recognised by, under `dir` ('' = the project root).
function taskAppFiles(dir, { name = 'tipatask-app' } = {}) {
  return {
    [path.join(dir, 'package.json')]: JSON.stringify({ name, version: '0.0.0' }),
    [path.join(dir, 'scripts', 'run-tests.js')]: '// stand-in runner\n',
  };
}

// ── BaseTaskAgent.resolveCiTests ──

test('resolveCiTests: a standalone Task App checkout is found at the project root', (t) => {
  assert.deepEqual(BaseTaskAgent.resolveCiTests(tree(t, taskAppFiles(''))), { dir: '', doc: null });
});

test('resolveCiTests: the monorepo mount is found, with the checklist only when the KB doc has that section', (t) => {
  const mount = taskAppFiles(MOUNT);
  assert.deepEqual(BaseTaskAgent.resolveCiTests(tree(t, mount)), { dir: MOUNT, doc: null }, 'no KB doc');
  for (const heading of [`## ${SECTION}`, `### ${SECTION}`, `## ${SECTION}  `]) {
    const root = tree(t, { ...mount, [DOC]: `# tt-ci\n\n## Files\n\ntext\n\n${heading}\r\n\nrules\n` });
    assert.deepEqual(BaseTaskAgent.resolveCiTests(root), { dir: MOUNT, doc: DOC }, JSON.stringify(heading));
  }
  for (const body of [
    '# tt-ci\n\n## Files\n',
    `# tt-ci\n\nSee ${SECTION} in another doc.\n`,
    `# tt-ci\n\n## ${SECTION} Actions\n`,
    `# ${SECTION}\n`,
    '',
  ]) {
    assert.deepEqual(BaseTaskAgent.resolveCiTests(tree(t, { ...mount, [DOC]: body })), { dir: MOUNT, doc: null }, JSON.stringify(body));
  }
});

test('resolveCiTests: the project root wins over a nested copy, and a foreign root manifest does not hide the mount', (t) => {
  assert.equal(BaseTaskAgent.resolveCiTests(tree(t, { ...taskAppFiles(''), ...taskAppFiles(MOUNT) })).dir, '');
  const foreignRoot = tree(t, { ...taskAppFiles('', { name: 'some-monorepo' }), ...taskAppFiles(MOUNT) });
  assert.equal(BaseTaskAgent.resolveCiTests(foreignRoot).dir, MOUNT);
  const brokenRoot = tree(t, { 'package.json': '{ not json', 'scripts/run-tests.js': '', ...taskAppFiles(MOUNT) });
  assert.equal(BaseTaskAgent.resolveCiTests(brokenRoot).dir, MOUNT);
});

test('resolveCiTests: null for every other project, and it never throws', (t) => {
  for (const [label, files] of [
    ['an empty project', { 'README.md': '# x\n' }],
    ['another package with the same runner path', taskAppFiles('', { name: 'another-app' })],
    ['the package without the suite runner', { 'package.json': JSON.stringify({ name: 'tipatask-app' }) }],
    ['a runner without a manifest', { 'scripts/run-tests.js': '' }],
    ['an unreadable manifest', { 'package.json': '{ not json', 'scripts/run-tests.js': '' }],
    ['a manifest that is not an object', { 'package.json': 'null', 'scripts/run-tests.js': '' }],
    ['a runner path that is a directory', { 'package.json': JSON.stringify({ name: 'tipatask-app' }), 'scripts/run-tests.js/keep': '' }],
    ['the KB doc alone', { [DOC]: `## ${SECTION}\n` }],
    ['a copy somewhere else in the tree', taskAppFiles('vendor/task-app')],
  ]) {
    assert.equal(BaseTaskAgent.resolveCiTests(tree(t, files)), null, label);
  }
  const gone = path.join(tree(t, {}), 'missing');
  for (const root of [undefined, null, '', 42, {}, [], gone]) {
    assert.equal(BaseTaskAgent.resolveCiTests(root), null, String(root));
  }
});

// ── BaseTaskAgent#buildCiTestDirective ──

test('buildCiTestDirective: only a run with a resolved suite gets it', () => {
  const agent = bareAgent();
  for (const compact of [false, true]) {
    for (const opts of [MONOREPO, MONOREPO_NO_DOC, STANDALONE]) {
      assert.ok(agent.buildCiTestDirective({ ...opts, compact }).startsWith('CI-compatible tests:'), JSON.stringify(opts));
    }
    for (const opts of [{}, { ciTests: null }, { ciTests: undefined }, { ciTests: {} }, { ciTests: { dir: null } }, { ciTests: { doc: DOC } }, { ciTests: 'yes' }, { ciTests: true }]) {
      assert.equal(agent.buildCiTestDirective({ ...opts, compact }), '', `${JSON.stringify(opts)} compact=${compact}`);
    }
  }
  assert.equal(agent.buildCiTestDirective(), '');
});

for (const [label, opts, doc] of [
  ['full', MONOREPO, true],
  ['full without a KB checklist', MONOREPO_NO_DOC, false],
  ['full standalone', STANDALONE, false],
  ['compact', { ...MONOREPO, compact: true }, true],
  ['compact standalone', { ...STANDALONE, compact: true }, false],
]) {
  test(`buildCiTestDirective: ${label} wording carries every rule and detects their omission`, () => {
    const note = bareAgent().buildCiTestDirective(opts);
    ciTests(note, { doc });
    for (const rule of [
      'CI-compatible tests:',
      'After your last change',
      'before the commit',
      'the whole suite',
      '`node scripts/run-tests.js`',
      'pinned',
      '`# fail 0`',
      'no guard violation',
      'is not a CI result',
      'no signed-in account',
      'no real network',
      'no fixed timing',
      ...(doc ? [DOC, SECTION] : []),
    ]) {
      assert.ok(note.includes(rule), rule);
      assert.throws(() => ciTests(note.split(rule).join(''), { doc }), { code: 'ERR_ASSERTION' }, `omitting ${rule} must fail`);
    }
  });
}

test('buildCiTestDirective: full wording names the CI job, what differs there, the changed paths and the checklist', () => {
  const note = bareAgent().buildCiTestDirective(MONOREPO);
  assert.match(note, /The Task App unit suite in `ai\/todo\/server` also runs on GitHub, in the job "Task App test suite"/);
  assert.match(note, /a Linux runner, the committed public snapshot, no signed-in account, no Electron binary/);
  assert.match(note, /source scans, vm harnesses[^\n]*comparisons of a whole spawn prompt/);
  assert.match(note, /a change under `ai\/todo\/server\/src`, `ai\/todo\/server\/main`, `ai\/todo\/server\/main\.js` or `ai\/todo\/server\/preload\.js` \(or to `scripts\/`, `templates\/` or `package\.json`, which tests also read\) can break a test file you never opened/);
  assert.match(note, /before the commit \(before completion when this run does not commit\), run the whole suite from `ai\/todo\/server` under the Node pinned in its `\.nvmrc`: `node scripts\/run-tests\.js`/);
  assert.match(note, /Require `# fail 0` in the totals and no guard violation after them/);
  assert.match(note, /A focused run of this task's own tests is not a CI result/);
  assert.match(note, /Fix every failure your change caused, in whichever test file it appears/);
  assert.match(note, /already red before your change is a caveat to report with that evidence/);
  assert.match(note, /no file outside the committed tree, no macOS-only path or filename case, no real network or PTY, no fixed timing/);
  assert.ok(note.endsWith(`Apply the checklist in \`${DOC}\` § ${SECTION} before the commit.`));
});

test('buildCiTestDirective: a standalone checkout gets root-relative paths; no KB checklist, no pointer to one', () => {
  const agent = bareAgent();
  const standalone = agent.buildCiTestDirective(STANDALONE);
  assert.match(standalone, /This project's unit suite also runs on GitHub/);
  assert.match(standalone, /a change under `src`, `main`, `main\.js` or `preload\.js` \(or to `scripts\/`/);
  assert.match(standalone, /run the whole suite from the project root under the Node pinned in its `\.nvmrc`/);
  for (const note of [standalone, agent.buildCiTestDirective({ ...STANDALONE, compact: true })]) {
    assert.ok(!note.includes(MOUNT), 'no monorepo mount path in a standalone checkout');
    assert.ok(!note.includes('tt-ci.md'), 'no checklist pointer without the KB doc');
  }
  const noDoc = agent.buildCiTestDirective(MONOREPO_NO_DOC);
  assert.ok(!noDoc.includes('tt-ci.md'));
  assert.ok(noDoc.endsWith('no real network or PTY, no fixed timing.'));
  assert.ok(agent.buildCiTestDirective({ ...MONOREPO_NO_DOC, compact: true }).endsWith('no fixed timing).'));
});

test('buildCiTestDirective: compact wording is short, names no MCP tool, asks nothing', () => {
  const agent = bareAgent();
  for (const opts of [MONOREPO, MONOREPO_NO_DOC, STANDALONE]) {
    const compact = agent.buildCiTestDirective({ ...opts, compact: true });
    assert.ok(compact.length < agent.buildCiTestDirective(opts).length);
    assert.ok(compact.length < 600, `compact directive is ${compact.length} chars`);
    for (const tool of MCP_TOOLS) assert.ok(!compact.includes(tool), `compact wording must not name ${tool}`);
    assert.doesNotMatch(compact, /\?/);
    assert.equal(compact.split('\n').length, 3, 'a header and two bullets');
    for (const line of compact.split('\n')) assert.ok(line.trim().length > 0, 'no blank line inside the compact directive');
  }
  assert.match(agent.buildCiTestDirective({ ...MONOREPO, compact: true }),
    /After your last change under ai\/todo\/server \(src, main, main\.js, preload\.js or a test\) and before the commit, run the whole suite from that directory under its pinned Node/);
  assert.match(agent.buildCiTestDirective({ ...STANDALONE, compact: true }),
    /After your last change to src, main, main\.js, preload\.js or a test and before the commit, run the whole suite from the project root under its pinned Node/);
});

test('buildCiTestDirective: workflow concepts only — no literal status names, no question in any variant', () => {
  const agent = bareAgent();
  for (const opts of [MONOREPO, MONOREPO_NO_DOC, STANDALONE]) {
    for (const compact of [false, true]) {
      const note = agent.buildCiTestDirective({ ...opts, compact });
      assert.doesNotMatch(note, STATUS_LITERALS, note);
      assert.doesNotMatch(note, /\?/, note);
    }
  }
});

test('buildCiTestDirective: no line can false-trigger line or tail attention detection', () => {
  const agent = bareAgent();
  const full = [CLAUDE_PROMPT_PATTERNS, CODEX_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS];
  const piTables = [PI_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS];
  const variants = [];
  for (const opts of [MONOREPO, MONOREPO_NO_DOC, STANDALONE]) {
    variants.push({ text: agent.buildCiTestDirective(opts), ids: ['claude', 'codex'], tables: full });
    variants.push({ text: agent.buildCiTestDirective({ ...opts, compact: true }), ids: ['pi'], tables: piTables });
  }
  for (const { text, ids, tables } of variants) {
    for (const line of text.split('\n')) {
      for (const patterns of tables) assert.equal(matchPromptLine(line, patterns), null, line);
    }
    for (const { re, agents } of buildLegacyPatternTable()) {
      if (agents && !agents.some(id => ids.includes(id))) continue;
      assert.ok(!re.test(text), `${ids.join('/')}: ${re}`);
    }
    assert.doesNotMatch(text, /^[\s>│┃╎┆❯➤▶›*]*plan ready[.!]?\s*$/im);
    assert.doesNotMatch(text, /^[\s>│┃╎┆❯➤▶›*]*questions ready[.!]?\s*$/im);
  }
});

// ── Delivery through buildSharedPreamble() ──

for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
  const id = new Agent().id;

  test(`${id}: a kickoff in a project holding the Task App source carries the directive once and names tt-ci.md`, (t) => {
    const agent = new Agent();
    const prompt = agent.buildPrompt('Implement fixture task.', { projectPath: projectFixture(t), taskTags: ['tt-task-agent'], ...MONOREPO });
    ciTests(prompt);
    kbHygiene(prompt);
    taskStatus(prompt);
    followUps(prompt);
    assert.match(prompt, /CI-compatible tests:/);
    assert.ok(prompt.includes('ai/architecture/tt-ci.md'), 'the kickoff names the CI checklist doc');
    assert.ok(prompt.includes(SECTION), 'the kickoff names the checklist section');
    const hygieneIdx = prompt.indexOf('KB hygiene:');
    const ciIdx = prompt.indexOf('CI-compatible tests:');
    const statusIdx = prompt.indexOf('Task status scope:');
    assert.ok(hygieneIdx >= 0 && hygieneIdx < ciIdx, 'the CI test directive follows KB hygiene');
    assert.ok(ciIdx < statusIdx, 'the CI test directive precedes the task status scope');
    assert.ok(ciIdx < prompt.lastIndexOf('Implement fixture task.'), 'the CI test directive precedes the task text');
    const variant = agent.getPreamblePolicy().compact ? { compact: true } : {};
    assert.ok(prompt.includes(agent.buildCiTestDirective({ ...MONOREPO, ...variant })), `${id} gets its own wording verbatim`);
    if (id === 'pi') assert.ok(!prompt.includes(agent.buildCiTestDirective(MONOREPO)), 'Pi never gets the full wording');
  });

  test(`${id}: a compose-mode kickoff places the directive after KB discovery`, (t) => {
    const agent = new Agent();
    const prompt = agent.buildPrompt('Implement fixture task.', {
      projectPath: projectFixture(t), kbMode: 'compose', task: { id: 'TPT1', category: 'CODING' }, ...MONOREPO,
    });
    ciTests(prompt);
    const discoveryIdx = prompt.indexOf('KB discovery:');
    const ciIdx = prompt.indexOf('CI-compatible tests:');
    assert.ok(discoveryIdx >= 0 && discoveryIdx < ciIdx && ciIdx < prompt.indexOf('Task status scope:'));
  });

  test(`${id}: no directive without a resolved suite, and none outside a software project`, (t) => {
    const agent = new Agent();
    const projectPath = projectFixture(t);
    for (const opts of [{}, { ciTests: null }, { ciTests: {} }, { ...MONOREPO, harness: resolvePresetHarness(['science']) }]) {
      const prompt = agent.buildPrompt('Implement fixture task.', { projectPath, ...opts });
      assert.doesNotMatch(prompt, /CI-compatible tests:/, JSON.stringify(Object.keys(opts)));
      assert.doesNotMatch(prompt, /run-tests\.js|tt-ci\.md/, JSON.stringify(Object.keys(opts)));
      followUps(prompt);
    }
    // A project that mixes software with another work preset still gets it.
    ciTests(agent.buildPrompt('Implement fixture task.', { projectPath, ...MONOREPO, harness: resolvePresetHarness(['software', 'science']) }));
  });

  // Assert delivered meaning independently of buildSharedPreamble's own list, with and without a
  // vcsContext (the completion wording around it changes, this directive does not).
  for (const withContext of [false, true]) {
    test(`${id}: ciTests contract survives shared assembly and detects omission/duplication${withContext ? ' (vcsContext)' : ''}`, (t) => {
      const agent = new Agent();
      const opts = withContext ? { ...MONOREPO, vcsContext: VCS_CONTEXT, vcsSettings: VCS_CONTEXT.vcs } : { ...MONOREPO };
      opts.projectPath = projectFixture(t);
      const build = () => agent.buildPrompt('Implement fixture task.', opts);
      ciTests(build());
      const original = agent.buildCiTestDirective.bind(agent);
      const stub = t.mock.method(agent, 'buildCiTestDirective', () => '');
      assert.throws(() => ciTests(build()), { code: 'ERR_ASSERTION' }, 'missing directive must fail the semantic contract');
      stub.mock.mockImplementation((...args) => {
        const directive = original(...args);
        return directive + '\n' + directive;
      });
      assert.throws(() => ciTests(build()), { code: 'ERR_ASSERTION' }, 'duplicated directive must fail the semantic contract');
    });
  }

  test(`${id}: a standalone checkout's kickoff carries the root-relative wording and no checklist pointer`, (t) => {
    const prompt = new Agent().buildPrompt('Implement fixture task.', { projectPath: projectFixture(t), ...STANDALONE });
    ciTests(prompt, { doc: false });
    assert.ok(!prompt.includes(MOUNT));
  });

  test(`${id}: legacy SIMPLE_MODE returns the bare task text, no CI test directive`, () => {
    const script = [
      "process.env.SIMPLE_MODE = 'true';",
      `const Agent = require(${JSON.stringify(path.join(__dirname, `${id}-agent.js`))});`,
      "process.stdout.write(new Agent().buildPrompt('Implement fixture task.', { ciTests: { dir: 'ai/todo/server', doc: 'ai/architecture/tt-ci.md' } }));",
    ].join('\n');
    assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), 'Implement fixture task.');
  });
}

test('buildSharedPreamble: Claude and Codex get the full wording, Pi the compact one', () => {
  const full = bareAgent().buildCiTestDirective(MONOREPO);
  const compact = bareAgent().buildCiTestDirective({ ...MONOREPO, compact: true });
  assert.equal(new ClaudeAgent().buildSharedPreamble(MONOREPO).ciTests, full);
  assert.equal(new CodexAgent().buildSharedPreamble(MONOREPO).ciTests, full);
  assert.equal(new PiAgent().buildSharedPreamble(MONOREPO).ciTests, compact);
  // The completion path does not change it: it names no completion tool.
  assert.equal(new CodexAgent().buildSharedPreamble({ ...MONOREPO, vcsContext: VCS_CONTEXT }).ciTests, full);
});

test('an explicit permission policy keeps the directive in SIMPLE_MODE, as every shared directive', (t) => {
  const config = require('../config');
  const previous = config.SIMPLE_MODE;
  config.SIMPLE_MODE = true;
  t.after(() => { config.SIMPLE_MODE = previous; });
  for (const agent of [new ClaudeAgent(), new CodexAgent(), new PiAgent()]) {
    const permissionPolicy = agent.buildPermissionPolicy({ mode: 'auto', source: 'task' });
    ciTests(agent.buildPrompt('Implement fixture task.', { ...MONOREPO, permissionPolicy, projectPath: projectFixture(t) }));
  }
});

test('Claude design mode keeps the CI test directive out of the /design submission', () => {
  const prompt = new ClaudeAgent().buildPrompt('Fixture brief.', { designMode: true, taskTags: ['tt-task-agent'], ...MONOREPO });
  assert.ok(prompt.startsWith('/design '));
  assert.doesNotMatch(prompt, /CI-compatible tests:/);
});

// ── Pi: the echoed kickoff budget ──

// (C1119/C1116/C1117) The whole Pi kickoff is echoed verbatim into its TUI and rescanned by
// prompt-detect.js. With the directive a kickoff stays under the shared Pi ceilings (9900; 10200
// with every Git flag on), grows by under 600 characters, and its worst case (a discovery-tagged
// task with every Git flag on) stays inside the 12,000-character assembled Pi budget.
test('Pi kickoff with the CI test directive stays echo-safe and inside its budgets', (t) => {
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
    const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath, ...scenario, ...MONOREPO });
    ciTests(prompt);
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
    const ceiling = scenario.discovery ? 12000 : scenario.vcsSettings ? 10200 : 9900;
    t.diagnostic(`Pi CI tests ${JSON.stringify(scenario)}: ${prompt.length} / ${ceiling} (+${prompt.length - base.length})`);
    assert.ok(prompt.length < ceiling, `${JSON.stringify(scenario)} prompt grew to ${prompt.length} chars`);
    assert.ok(prompt.length - base.length < 600, `${JSON.stringify(scenario)} the directive added ${prompt.length - base.length} chars`);
  }
});

// ── The repository this checkout is mounted in ──

// The directive, CLAUDE.md and AGENTS.md all point at one section of the monorepo's CI doc. Those
// files live in the root repository this checkout is mounted in at ai/todo/server; a standalone
// checkout (the public repository, the export test gate's copy) has none of them.
const MONOREPO_ROOT = path.resolve(__dirname, '../../../../../..');
const inMonorepo = ['CLAUDE.md', 'AGENTS.md', DOC].every(rel => fs.existsSync(path.join(MONOREPO_ROOT, rel)))
  && fs.existsSync(path.join(MONOREPO_ROOT, MOUNT, 'src/server/task-agent/base-agent.js'));
const needsMonorepo = { skip: inMonorepo ? false : 'the root repository guides are absent in this standalone Task App checkout' };

// The rule as a guide states it: the line after `marker` plus its nested bullets, indentation dropped.
function guideRule(guide, marker) {
  const from = guide.indexOf(marker);
  if (from < 0) return null;
  const lines = guide.slice(from + marker.length).split('\n');
  const rule = [lines[0]];
  for (const line of lines.slice(1)) {
    if (!/^\s+- /.test(line)) break;
    rule.push(line);
  }
  return rule.map(line => line.trim()).join('\n');
}

test('this repository resolves to its own suite and a live checklist section', needsMonorepo, () => {
  assert.deepEqual(BaseTaskAgent.resolveCiTests(MONOREPO_ROOT), MONOREPO.ciTests,
    `${DOC} must keep a "## ${SECTION}" section: buildCiTestDirective(), CLAUDE.md and AGENTS.md name it`);
});

test('CLAUDE.md and AGENTS.md carry the same CI-compatible tests rule and name the checklist section', needsMonorepo, () => {
  const claude = guideRule(fs.readFileSync(path.join(MONOREPO_ROOT, 'CLAUDE.md'), 'utf8'), '3b. **CI-compatible tests**');
  const agents = guideRule(fs.readFileSync(path.join(MONOREPO_ROOT, 'AGENTS.md'), 'utf8'), '- **CI-compatible tests**');
  assert.ok(claude, 'CLAUDE.md § Working on a task step 3b is missing');
  assert.ok(agents, 'AGENTS.md § Core Workflow rule is missing');
  assert.equal(agents, claude, 'the two guides must word the rule identically');
  assert.match(claude, /`ai\/todo\/server\/src`[^\n]*`ai\/todo\/server\/main`[^\n]*`main\.js`[^\n]*`preload\.js`/);
  assert.match(claude, /`cd ai\/todo\/server && node scripts\/run-tests\.js`/);
  assert.match(claude, /the whole suite after its last source change and before its commit/);
  assert.match(claude, /`# fail 0`[^\n]*no guard violation/);
  assert.match(claude, /focused run[^\n]*is not enough/);
  assert.ok(claude.includes(`\`${DOC}\` § ${SECTION}`), 'the rule links to the checklist section by name');
  assert.match(claude, /buildCiTestDirective\(\)/);
});

// The checklist is only as good as the files it points at: every item states its rule in bold and
// names at least one test file, and each named file (and helper function) exists in this checkout.
test('every item of the CI checklist names a reference test file that exists', needsMonorepo, () => {
  const doc = fs.readFileSync(path.join(MONOREPO_ROOT, DOC), 'utf8');
  const section = doc.split(`\n## ${SECTION}\n`)[1]?.split(/\n## /)[0];
  assert.ok(section, `${DOC} has no "## ${SECTION}" section`);
  const checklist = section.split('\n### Checklist\n')[1]?.split(/\n### /)[0];
  assert.ok(checklist, 'the section keeps its "### Checklist" subsection');
  const items = checklist.split(/\n(?=\d+\. \*\*)/).slice(1);
  assert.ok(items.length >= 10, `only ${items.length} checklist items found`);
  const checkout = path.join(MONOREPO_ROOT, MOUNT);
  items.forEach((item, index) => {
    const number = index + 1;
    assert.match(item, new RegExp(`^${number}\\. \\*\\*[\\s\\S]+?\\*\\*`), `item ${number} is numbered in order and states its rule in bold`);
    const reference = item.split('Reference:')[1];
    assert.ok(reference, `item ${number} has no "Reference:"`);
    const files = [...reference.matchAll(/`(src\/[^`\s]+\.(?:js|cjs|mjs))`/g)].map(match => match[1]);
    assert.ok(files.length > 0, `item ${number} names no reference test file`);
    for (const file of files) assert.ok(fs.existsSync(path.join(checkout, file)), `item ${number}: ${file} does not exist`);
    const sources = files.map(file => fs.readFileSync(path.join(checkout, file), 'utf8'));
    for (const [, helper] of reference.matchAll(/`(\w+)\(\)`/g)) {
      assert.ok(sources.some(source => new RegExp(`function ${helper}\\(`).test(source)), `item ${number}: ${helper}() is not defined in ${files.join(', ')}`);
    }
  });
});
