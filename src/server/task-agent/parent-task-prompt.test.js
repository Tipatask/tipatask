'use strict';

// C1575 — parent-task context injection into a child task's kickoff prompt. When an objective
// is planned in New Objective chat, C1339 auto-creates one is_objective parent task whose
// description is the user's own chat prompt history; a child subtask's kickoff prompt
// previously carried none of that context. This adds opts.parentTaskBlock, threaded by
// terminal-session.js's fetchParentTaskBlock() (see parent-task-block.test.js for that half)
// and rendered/prepended by base-agent.js's formatParentTaskBlock()/fitParentTaskBlock()/
// prependParentTask(). Modeled on kb-hygiene-prompt.test.js (same helper pattern) — see
// ai/architecture/tt-task-agent.md § Parent Task Injection (C1575).

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
  PI_PROMPT_PATTERNS,
  GENERIC_PROMPT_PATTERNS,
  buildLegacyPatternTable,
} = require('./prompt-detect');

function makeProjectDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-parenttask-prompt-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  return dir;
}

const GIT_ALL_ON = { type: 'git', worktree: true, commit: true, pr: true };

const PARENT_TASK = { id: 'C1200', title: 'Rework the sprint board', description: 'Full objective description text.' };
const PARENT_COMMENTS = [
  { id: 1, content: 'Original spec from chat.', type: 'spec', user: { name: 'Alice' }, created_at: '2026-01-01T00:00:00Z' },
  { id: 2, content: 'A clarifying note.', type: 'comment', user: { name: 'Bob' }, created_at: '2026-01-02T00:00:00Z' },
  { id: 3, content: 'auto-posted terminal tail log dump...', type: 'resolution', user: { name: 'Claude' }, created_at: '2026-01-03T00:00:00Z' },
];

// ── BaseTaskAgent#formatParentTaskBlock ──

test('formatParentTaskBlock: renders key/title/description, keeps spec+comment, drops resolution', () => {
  const block = BaseTaskAgent.formatParentTaskBlock(PARENT_TASK, PARENT_COMMENTS);
  assert.match(block, /## Parent Task — C1200: Rework the sprint board/);
  assert.match(block, /Full objective description text\./);
  assert.match(block, /Original spec from chat\./);
  assert.match(block, /A clarifying note\./);
  assert.ok(!block.includes('auto-posted terminal tail log dump'), 'resolution-type comment must be dropped');
});

test('formatParentTaskBlock: null parent -> empty string', () => {
  assert.equal(BaseTaskAgent.formatParentTaskBlock(null, PARENT_COMMENTS), '');
  assert.equal(BaseTaskAgent.formatParentTaskBlock(undefined, []), '');
});

test('formatParentTaskBlock: no comments (or all filtered out) -> no "Parent Task Comments" section', () => {
  const noneBlock = BaseTaskAgent.formatParentTaskBlock(PARENT_TASK, []);
  assert.ok(!noneBlock.includes('Parent Task Comments'));
  const onlyResolutionBlock = BaseTaskAgent.formatParentTaskBlock(PARENT_TASK, [PARENT_COMMENTS[2]]);
  assert.ok(!onlyResolutionBlock.includes('Parent Task Comments'));
});

test('formatParentTaskBlock: guard sentence carries zero question marks (Pi echo safety)', () => {
  const block = BaseTaskAgent.formatParentTaskBlock(PARENT_TASK, []);
  assert.doesNotMatch(block, /\?/);
});

// ── BaseTaskAgent#fitParentTaskBlock ──

test('fitParentTaskBlock: passthrough when already under the cap', () => {
  assert.equal(BaseTaskAgent.fitParentTaskBlock('short block', 2000), 'short block');
});

test('fitParentTaskBlock: hard-sliced with the truncation marker when over the cap', () => {
  const big = 'x'.repeat(3000);
  const fitted = BaseTaskAgent.fitParentTaskBlock(big, 500);
  assert.ok(fitted.length <= 500);
  assert.match(fitted, /… \(parent context truncated\)$/);
});

test('fitParentTaskBlock: empty string below the 200-char floor', () => {
  assert.equal(BaseTaskAgent.fitParentTaskBlock('some real content here', 150), '');
  assert.equal(BaseTaskAgent.fitParentTaskBlock('some real content here', 0), '');
});

test('fitParentTaskBlock: falsy block -> empty string', () => {
  assert.equal(BaseTaskAgent.fitParentTaskBlock('', 2000), '');
  assert.equal(BaseTaskAgent.fitParentTaskBlock(null, 2000), '');
});

// ── BaseTaskAgent#prependParentTask ──

test('prependParentTask: passthrough when opts.parentTaskBlock is absent', () => {
  assert.equal(BaseTaskAgent.prependParentTask('the task', {}), 'the task');
  assert.equal(BaseTaskAgent.prependParentTask('the task'), 'the task');
});

test('prependParentTask: composes with prependTaskComments in order parent -> comments -> prompt', () => {
  const opts = { parentTaskBlock: '## Parent Task — C1200: X', taskCommentsBlock: '## Task Comments\nfoo' };
  const composed = BaseTaskAgent.prependParentTask(BaseTaskAgent.prependTaskComments('the task', opts), opts);
  const parentIdx = composed.indexOf('## Parent Task');
  const commentsIdx = composed.indexOf('## Task Comments');
  const taskIdx = composed.lastIndexOf('the task');
  assert.ok(parentIdx === 0, 'parent block must lead');
  assert.ok(parentIdx < commentsIdx && commentsIdx < taskIdx);
});

// ── ClaudeAgent.buildPrompt ──

test('ClaudeAgent.buildPrompt: parent block present and precedes the task prompt when opts.parentTaskBlock is set', () => {
  const agent = new ClaudeAgent();
  const parentTaskBlock = BaseTaskAgent.formatParentTaskBlock(PARENT_TASK, PARENT_COMMENTS);
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'], parentTaskBlock });
  assert.match(prompt, /## Parent Task — C1200/);
  const parentIdx = prompt.indexOf('## Parent Task');
  const taskIdx = prompt.lastIndexOf('Do the thing');
  assert.ok(parentIdx >= 0 && parentIdx < taskIdx);
});

test('ClaudeAgent.buildPrompt: no opts.parentTaskBlock -> no Parent Task section at all (absent-key regression)', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'] });
  assert.ok(!prompt.includes('## Parent Task'));
});

test('ClaudeAgent.buildPrompt: designMode wins — no parent block fused into the /design brief', () => {
  const agent = new ClaudeAgent();
  const parentTaskBlock = BaseTaskAgent.formatParentTaskBlock(PARENT_TASK, PARENT_COMMENTS);
  const prompt = agent.buildPrompt('Do the thing', { designMode: true, taskTags: ['tt-task-agent'], parentTaskBlock });
  assert.ok(prompt.startsWith('/design '));
  assert.ok(!prompt.includes('## Parent Task'));
});

// SIMPLE_MODE is read off the module-level require('../config') singleton — verified in a
// child process so this file's own config singleton is untouched. Same idiom as
// kb-hygiene-prompt.test.js.
test('ClaudeAgent.buildPrompt: SIMPLE_MODE keeps the parent block (only KB/directive preamble is stripped)', () => {
  const script = [
    `process.env.SIMPLE_MODE = 'true';`,
    `const ClaudeAgent = require(${JSON.stringify(path.join(__dirname, 'claude-agent.js'))});`,
    `const agent = new ClaudeAgent();`,
    `const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'], parentTaskBlock: '## Parent Task — C1200: X\\n\\nGuard.' });`,
    `process.stdout.write(prompt);`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out, '## Parent Task — C1200: X\n\nGuard.\n\nDo the thing');
});

// ── CodexAgent.buildPrompt ──

test('CodexAgent.buildPrompt: parent block present when opts.parentTaskBlock is set', () => {
  const agent = new CodexAgent();
  const parentTaskBlock = BaseTaskAgent.formatParentTaskBlock(PARENT_TASK, PARENT_COMMENTS);
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'], parentTaskBlock });
  assert.match(prompt, /## Parent Task — C1200/);
});

test('CodexAgent.buildPrompt: no opts.parentTaskBlock -> no Parent Task section (absent-key regression)', () => {
  const agent = new CodexAgent();
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'] });
  assert.ok(!prompt.includes('## Parent Task'));
});

test('CodexAgent.buildPrompt: SIMPLE_MODE keeps the parent block', () => {
  const script = [
    `process.env.SIMPLE_MODE = 'true';`,
    `const CodexAgent = require(${JSON.stringify(path.join(__dirname, 'codex-agent.js'))});`,
    `const agent = new CodexAgent();`,
    `const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-task-agent'], parentTaskBlock: '## Parent Task — C1200: X\\n\\nGuard.' });`,
    `process.stdout.write(prompt);`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out, '## Parent Task — C1200: X\n\nGuard.\n\nDo the thing');
});

// ── PiAgent.buildPrompt ──

test('PiAgent.buildPrompt: parent block present when opts.parentTaskBlock is set', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const parentTaskBlock = BaseTaskAgent.formatParentTaskBlock(PARENT_TASK, PARENT_COMMENTS);
    const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir, parentTaskBlock });
    assert.match(prompt, /## Parent Task — C1200/);
    const parentIdx = prompt.indexOf('## Parent Task');
    const taskIdx = prompt.lastIndexOf('Do the thing.');
    assert.ok(parentIdx >= 0 && parentIdx < taskIdx);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.buildPrompt: no opts.parentTaskBlock -> no Parent Task section (absent-key regression, prompt stays byte-identical to pre-C1575 shape)', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir });
    assert.ok(!prompt.includes('## Parent Task'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.buildPrompt: SIMPLE_MODE keeps the parent block', () => {
  const script = [
    `process.env.SIMPLE_MODE = 'true';`,
    `const PiAgent = require(${JSON.stringify(path.join(__dirname, 'pi-agent.js'))});`,
    `const agent = new PiAgent();`,
    `const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], parentTaskBlock: '## Parent Task — C1200: X\\n\\nGuard.' });`,
    `process.stdout.write(prompt);`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out, '## Parent Task — C1200: X\n\nGuard.\n\nDo the thing.');
});

test('PiAgent.buildPrompt: parent block is truncated (not dropped) under the worst-case combined budget, and the truncated prompt still stays under 12000 chars', (t) => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const tags = Array.from({ length: 21 }, (_, i) => `tt-tag-${i}`);
    const tagDescriptions = {};
    for (const t of tags) tagDescriptions[t] = '';
    const bigParent = {
      id: 'C1200',
      title: 'Rework the whole sprint board end to end',
      description: 'x'.repeat(5000),
    };
    const parentTaskBlock = BaseTaskAgent.formatParentTaskBlock(bigParent, []);
    const prompt = agent.buildPrompt('Do the thing.', {
      taskTags: tags,
      tagDescriptions,
      projectPath: dir,
      vcsSettings: GIT_ALL_ON,
      discovery: true,
      parentTaskBlock,
    });
    t.diagnostic(`Pi combined parent fixture: ${prompt.length} / 12000`);
    assert.ok(prompt.length < 12000, `prompt grew to ${prompt.length} chars`);
    assert.match(prompt, /## Parent Task — C1200/);
    assert.match(prompt, /… \(parent context truncated\)/, 'a 5000-char block under worst-case framing must be truncated, not dropped whole');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.buildPrompt: parent block drops entirely (not a near-empty fragment) when there is no room left under the budget', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const tags = Array.from({ length: 21 }, (_, i) => `tt-tag-${i}`);
    const tagDescriptions = {};
    for (const t of tags) tagDescriptions[t] = '';
    const parentTaskBlock = BaseTaskAgent.formatParentTaskBlock(PARENT_TASK, []);
    // Task text itself is huge — eats essentially the whole 12000 budget, leaving under the
    // 200-char floor for the parent block.
    const hugeTask = 'y'.repeat(11000);
    const prompt = agent.buildPrompt(hugeTask, {
      taskTags: tags,
      tagDescriptions,
      projectPath: dir,
      vcsSettings: GIT_ALL_ON,
      discovery: true,
      parentTaskBlock,
    });
    assert.ok(!prompt.includes('## Parent Task'), 'block must be dropped entirely, not left as an unusable fragment');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (C1119/C1116/C1117) Same echo-safety battery every other Pi prompt-content test runs — the
// whole kickoff prompt (parent block included) is echoed verbatim into Pi's own TUI and
// scanned by prompt-detect.js.
test('PiAgent.buildPrompt: a benign parent block cannot false-trigger the attention/plan-ready detectors', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const parentTaskBlock = BaseTaskAgent.formatParentTaskBlock(PARENT_TASK, PARENT_COMMENTS);
    for (const discovery of [false, true]) {
      const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir, discovery, parentTaskBlock });

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
      assert.ok(prompt.length < 12000, `[discovery=${discovery}] prompt grew to ${prompt.length} chars`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('all assembled tails keep parent, own comments, then task exactly once; SIMPLE_MODE keeps the tail only', () => {
  const config = require('../config');
  const oldSimple = config.SIMPLE_MODE;
  const opts = { parentTaskBlock: 'PARENT_MARKER', taskCommentsBlock: 'COMMENT_MARKER' };
  try {
    for (const simple of [false, true]) {
      config.SIMPLE_MODE = simple;
      for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
        const agent = new Agent();
        const prompt = agent.buildPrompt('TASK_MARKER', opts);
        for (const marker of ['PARENT_MARKER', 'COMMENT_MARKER', 'TASK_MARKER']) {
          assert.equal(prompt.split(marker).length - 1, 1, `${agent.id}: ${marker}`);
        }
        assert.ok(prompt.indexOf('PARENT_MARKER') < prompt.indexOf('COMMENT_MARKER'));
        assert.ok(prompt.indexOf('COMMENT_MARKER') < prompt.indexOf('TASK_MARKER'));
        if (simple) assert.doesNotMatch(prompt, /Process safety:|KB hygiene:|Clarifying questions:|STATIC CONTEXT/);
        assert.equal(agent.buildPreludePrompt('TASK', opts), '');
      }
    }
  } finally { config.SIMPLE_MODE = oldSimple; }
});
