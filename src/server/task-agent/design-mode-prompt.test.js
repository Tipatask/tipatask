'use strict';

// Guard single-submission /design with task brief and no-ask suffix. Explicit
// design mode outranks SIMPLE_MODE; legacy prelude helpers remain independently
// tested but are not used by current spawns.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ClaudeAgent = require('./claude-agent');
const {
  shouldReleasePrelude,
  PRELUDE_MIN_RUN_MS,
  PRELUDE_QUIET_MS,
} = require('../terminal-session');

function makeProjectDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1207-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  return dir;
}

const FAKE_CONFIG = {
  CLAUDE_MODEL: 'opusplan',
  SIMPLE_MODE: false,
  PROJECT_ROOT: '/fallback/global/project',
  USER_DATA_ROOT: os.tmpdir(),
  CLAUDE_BIN: 'claude',
};

test('ClaudeAgent.buildPrompt: designMode returns a single /design submission with the task as its brief, no KB preamble', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { designMode: true });
  assert.ok(prompt.startsWith('/design '), 'must be a real /design command with the task as its argument');
  assert.ok(prompt.includes('Do the thing'), 'the task prompt must be the brief, not dropped');
  assert.ok(!prompt.includes('\n'), '/design registers as a command only when its argument has no embedded newline (C1260 finding)');
  assert.ok(!prompt.includes('/tipatask-expert'), 'KB preamble must be skipped');
  assert.ok(!prompt.includes('/caveman'), 'caveman line must be skipped');
});

test('ClaudeAgent.buildPrompt: designMode brief tells the model not to ask follow-up questions', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { designMode: true });
  assert.match(prompt, /do not ask follow-up questions/i);
});

test('ClaudeAgent.buildPrompt: designMode brief includes task comments after the task text, not before', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', {
    designMode: true,
    taskCommentsBlock: '## Task Comments\n**User (t):** please match dark mode',
  });
  const taskIdx = prompt.indexOf('Do the thing');
  const commentIdx = prompt.indexOf('please match dark mode');
  assert.ok(taskIdx >= 0 && commentIdx >= 0, 'both task text and comment text must survive flattening');
  assert.ok(taskIdx < commentIdx, 'task text must come before comments — comments are truncated first');
});

test('ClaudeAgent.buildPrompt: designMode caps overall length and never truncates away the no-ask suffix', () => {
  const agent = new ClaudeAgent();
  const hugeDesc = 'x'.repeat(10000);
  const prompt = agent.buildPrompt(hugeDesc, { designMode: true });
  assert.ok(prompt.length < 4200, 'brief must be capped, not left unbounded');
  assert.match(prompt, /do not ask follow-up questions/i, 'the no-ask suffix must survive truncation');
  assert.ok(prompt.includes('… (truncated)'), 'truncated brief must be marked, not silently cut');
});

test('ClaudeAgent.flattenDesignBrief: collapses all whitespace (including newlines) to single spaces', () => {
  const flat = ClaudeAgent.flattenDesignBrief('line one\n\nline   two\tline three', 1000);
  assert.equal(flat, 'line one line two line three');
});

test('ClaudeAgent.flattenDesignBrief: truncates with a marker once over the cap', () => {
  const flat = ClaudeAgent.flattenDesignBrief('a'.repeat(50), 20);
  assert.ok(flat.length <= 20);
  assert.ok(flat.endsWith('… (truncated)'));
});

test('ClaudeAgent.buildPreludePrompt: no longer overridden — always empty, even for designMode', () => {
  const agent = new ClaudeAgent();
  assert.strictEqual(agent.buildPreludePrompt({ designMode: true }), '');
  assert.strictEqual(agent.buildPreludePrompt({ designMode: false }), '');
  assert.strictEqual(agent.buildPreludePrompt({}), '');
});

test('ClaudeAgent.buildPrompt: designMode false/absent keeps the normal KB preamble', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', {});
  assert.ok(prompt.startsWith('/tipatask-expert'), 'normal path must be unaffected');
  assert.ok(!prompt.startsWith('/design'));
});

test('ClaudeAgent.getSpawnSpec: designMode true -> /design initialPrompt carries the brief, no preludePrompt key, spawn args unchanged', async () => {
  const dir = makeProjectDir({ CLAUDE_MODEL: 'opusplan' });
  try {
    const agent = new ClaudeAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'Do the thing', 'C1207', { projectPath: dir, designMode: true });

    assert.ok(spec.initialPrompt.startsWith('/design '));
    assert.ok(spec.initialPrompt.includes('Do the thing'));
    assert.ok(!('preludePrompt' in spec), 'design mode is now a single submission — no prelude key at all');
    assert.ok(spec.args.includes('--permission-mode'), 'plan mode must be unaffected by designMode');
    assert.ok(spec.args.includes('plan'));
    assert.ok(spec.args.includes('--append-system-prompt'), 'static KB system-prompt bundle must still be sent');
    assert.ok(spec.args.includes('--exclude-dynamic-system-prompt-sections'));
    assert.ok(!('designMode' in spec), 'designMode must never leak into the returned spec (recordLastUsedAgent only persists spec.model)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ClaudeAgent.getSpawnSpec: designMode false/absent -> normal preamble, no preludePrompt key at all', async () => {
  const dir = makeProjectDir({ CLAUDE_MODEL: 'opusplan' });
  try {
    const agent = new ClaudeAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'Do the thing', 'C1207', { projectPath: dir });
    assert.ok(spec.initialPrompt.startsWith('/tipatask-expert'));
    assert.ok(!('preludePrompt' in spec), 'non-design spawn spec must keep its exact pre-C1260 shape');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ClaudeAgent.getSpawnSpec: designMode wins over SIMPLE_MODE ordering', async () => {
  const dir = makeProjectDir({ CLAUDE_MODEL: 'opusplan' });
  try {
    const agent = new ClaudeAgent();
    const simpleConfig = { ...FAKE_CONFIG, SIMPLE_MODE: true };
    const spec = await agent.getSpawnSpec(simpleConfig, 'Do the thing', 'C1207', { projectPath: dir, designMode: true });
    assert.ok(spec.initialPrompt.startsWith('/design '), 'designMode branch must be checked before the SIMPLE_MODE early return');
    assert.ok(spec.initialPrompt.includes('Do the thing'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── shouldReleasePrelude() — pure predicate, retained for terminal-session.js's (currently
// unused-by-any-agent) awaitPreludeRun gate — see this file's top-of-file doc comment ──

test('shouldReleasePrelude: false before the min-run floor even if perfectly quiet/ungated/ready', () => {
  assert.strictEqual(shouldReleasePrelude({
    waitedMs: PRELUDE_MIN_RUN_MS - 1, quietMs: PRELUDE_QUIET_MS + 1000, gated: false, replReady: true,
  }), false);
});

test('shouldReleasePrelude: false while still noisy (quietMs below the floor)', () => {
  assert.strictEqual(shouldReleasePrelude({
    waitedMs: PRELUDE_MIN_RUN_MS + 1000, quietMs: PRELUDE_QUIET_MS - 1, gated: false, replReady: true,
  }), false);
});

test('shouldReleasePrelude: false while a gate-kind dialog (mcpTrust/toolApproval/firstRun/askQuestion) is on screen', () => {
  assert.strictEqual(shouldReleasePrelude({
    waitedMs: PRELUDE_MIN_RUN_MS + 5000, quietMs: PRELUDE_QUIET_MS + 5000, gated: true, replReady: true,
  }), false);
});

test('shouldReleasePrelude: false when the REPL is not confirmed ready', () => {
  assert.strictEqual(shouldReleasePrelude({
    waitedMs: PRELUDE_MIN_RUN_MS + 5000, quietMs: PRELUDE_QUIET_MS + 5000, gated: false, replReady: false,
  }), false);
});

test('shouldReleasePrelude: true once all four conditions clear', () => {
  assert.strictEqual(shouldReleasePrelude({
    waitedMs: PRELUDE_MIN_RUN_MS + 1, quietMs: PRELUDE_QUIET_MS + 1, gated: false, replReady: true,
  }), true);
});

test('Design Mode excludes shared assembly, orders task before comments, and enforces the 4000-character brief budget', (t) => {
  const agent = new ClaudeAgent();
  t.mock.method(agent, 'buildSharedPreamble', () => { throw new Error('Design must bypass shared directives'); });
  const opts = { designMode: true, parentTaskBlock: 'PARENT_MARKER', taskCommentsBlock: 'COMMENT_MARKER', vcsSettings: { type: 'off' } };
  const prompt = agent.buildPrompt('TASK_MARKER', opts);
  assert.ok(prompt.indexOf('TASK_MARKER') < prompt.indexOf('COMMENT_MARKER'));
  assert.doesNotMatch(prompt, /PARENT_MARKER|\n|Process safety:|KB hygiene:/);
  assert.equal(agent.buildPreludePrompt('TASK', opts), '');
  const huge = agent.buildPrompt('x'.repeat(10000), opts);
  assert.ok(huge.slice('/design '.length).length <= 4000);
});
