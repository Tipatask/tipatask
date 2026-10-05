'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ClaudeAgent = require('./claude-agent');
const CodexAgent = require('./codex-agent');
const PiAgent = require('./pi-agent');
const { projectFixture, taskStatus } = require('./prompt-contract-assertions');
const {
  matchPromptLine, PI_PROMPT_PATTERNS, CODEX_PROMPT_PATTERNS,
  GENERIC_PROMPT_PATTERNS, buildLegacyPatternTable,
} = require('./prompt-detect');

for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
  const id = new Agent().id;
  test(`${id}: task status contract reaches the kickoff once and detects omitted or duplicated rules`, (t) => {
    const agent = new Agent();
    const opts = { projectPath: projectFixture(t) };
    const build = () => agent.buildPrompt('Implement fixture task.', opts);
    const prompt = build();
    taskStatus(prompt);
    assert.ok(prompt.indexOf('Task status scope:') < prompt.lastIndexOf('Implement fixture task.'));
    const original = agent.buildTaskStatusDirective.bind(agent);
    const stub = t.mock.method(agent, 'buildTaskStatusDirective', () => '');
    assert.throws(() => taskStatus(build()), { code: 'ERR_ASSERTION' });
    stub.mock.mockImplementation((...args) => [original(...args), original(...args)].join('\n'));
    assert.throws(() => taskStatus(build()), { code: 'ERR_ASSERTION' });
  });

  test(`${id}: task status contract preserves custom completion names without inventing on_fire`, (t) => {
    const prompt = new Agent().buildPrompt('Implement fixture task.', {
      projectPath: projectFixture(t),
      statusRoles: { start: 'queued', in_progress: 'working', complete: 'shipped' },
      statusNames: ['queued', 'working', 'shipped'],
    });
    taskStatus(prompt);
    assert.match(prompt, /shipped/);
    assert.doesNotMatch(prompt.replaceAll('completed:true', ''), /\bcompleted\b|\bon_fire\b/);
  });

  test(`${id}: SIMPLE_MODE still returns only the task text`, () => {
    const script = [
      "process.env.SIMPLE_MODE = 'true';",
      `const Agent = require(${JSON.stringify(path.join(__dirname, `${id}-agent.js`))});`,
      "process.stdout.write(new Agent().buildPrompt('Implement fixture task.'));",
    ].join('\n');
    assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), 'Implement fixture task.');
  });
}

test('Claude design mode keeps the status rule out of the design submission', () => {
  const prompt = new ClaudeAgent().buildPrompt('Fixture brief.', { designMode: true });
  assert.ok(prompt.startsWith('/design Fixture brief.'));
  assert.doesNotMatch(prompt, /Task status scope:|Unrelated tasks|Unrelated unfinished tasks/);
});

test('full status rule rejects incomplete or deferred scope and unsupported unrelated-failure claims', () => {
  const note = new CodexAgent().buildTaskStatusDirective();
  taskStatus(note);
  assert.match(note, /incomplete scope, relevant failures/);
  assert.match(note, /never assume it is unrelated merely because it occurs outside the files you edited/);
  assert.match(note, /Deferring requested work to another task does not make this task complete/);
});

test('compact status rule retains acceptance semantics without MCP names or question-shaped text', () => {
  const agent = new PiAgent();
  const full = agent.buildTaskStatusDirective();
  const compact = agent.buildTaskStatusDirective({ compact: true });
  taskStatus(compact);
  assert.ok(compact.length < full.length);
  assert.doesNotMatch(compact, /\?|MCP|create_task_comment|update_task|get_task/);
  for (const text of [full, compact]) {
    assert.throws(() => taskStatus(text.replace(/unless[^.]+\./, 'regardless of scope.')), { code: 'ERR_ASSERTION' });
    assert.throws(() => taskStatus(text.replace(/(?:own regressions block|regressions caused by your changes block completion)/, 'ignore regressions')), { code: 'ERR_ASSERTION' });
  }
});

test('status directive does not trigger line or tail attention detection', () => {
  for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
    const agent = new Agent();
    const note = agent.buildTaskStatusDirective({ compact: agent.id === 'pi' });
    for (const line of note.split('\n')) {
      for (const patterns of [PI_PROMPT_PATTERNS, CODEX_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS]) {
        assert.equal(matchPromptLine(line, patterns), null, line);
      }
    }
    for (const { re, agents } of buildLegacyPatternTable()) {
      if (agents && !agents.includes(agent.id)) continue;
      assert.ok(!re.test(note), `${agent.id}: ${re}`);
    }
  }
});

test('Pi combined kickoff keeps compact status semantics, echo safety, and the existing VCS budget', (t) => {
  const prompt = new PiAgent().buildPrompt('Do the thing.', {
    projectPath: projectFixture(t), discovery: true,
    vcsSettings: { type: 'git', worktree: true, commit: true, pr: true },
    taskTags: ['tt-task-agent'],
  });
  taskStatus(prompt);
  for (const line of prompt.split('\n')) {
    for (const patterns of [PI_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS]) {
      assert.equal(matchPromptLine(line, patterns), null, line);
    }
  }
  for (const { re, agents } of buildLegacyPatternTable()) {
    if (agents && !agents.includes('pi')) continue;
    assert.ok(!re.test(prompt), String(re));
  }
  t.diagnostic(`Pi task-status combined fixture: ${prompt.length} / 9900`);
  assert.ok(prompt.length < 9900);
});

test('installed guide templates agree on task-local status, caveats, and relevant blockers', () => {
  const sections = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const guide = fs.readFileSync(path.resolve(__dirname, '../../../templates', name), 'utf8');
    const section = guide.split('### Task status scope\n')[1]?.split('\n### ')[0];
    assert.ok(section, `${name}: missing task status scope`);
    assert.match(section, /own requested scope and task-local verification/);
    assert.match(section, /Unrelated unfinished tasks and unrelated failures in a broad test suite are caveats, not blockers/);
    assert.match(section, /unless the user or task explicitly connects them/);
    assert.match(section, /regressions caused by this task's changes block completion/);
    assert.match(section, /Deferring requested work to another task does not make this task complete/);
    assert.match(section, /supporting evidence in this task's resolution comment and final reply/);
    assert.doesNotMatch(guide, /Blocked\/issues:|\*\*When blocked\*\*|IMMEDIATELY after last code change/);
    sections.push(section);
  }
  assert.equal(sections[0], sections[1]);
});
