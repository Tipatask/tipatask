'use strict';

// C1513 — blank-tag-description backfill directive applied to task-agent kickoff prompts.
// Covers tag-descriptions.js's pure helpers + fail-open fetcher, and each agent's
// buildPrompt() injection point. Modeled on vcs-prompt.test.js (the C1215 precedent this
// mirrors). See ai/architecture/tt-tag-system.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isBlankDescription,
  fetchTagDescriptions,
  selectTagsNeedingDescription,
  buildTagDescriptionDirective,
} = require('../tag-descriptions');
const ClaudeAgent = require('./claude-agent');
const CodexAgent = require('./codex-agent');
const PiAgent = require('./pi-agent');
const { matchPromptLine, PI_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS, buildLegacyPatternTable } = require('./prompt-detect');

function makeProjectDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-tagdesc-prompt-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  return dir;
}

// ── tag-descriptions.js: pure helpers ──

test('isBlankDescription: null/undefined/empty/whitespace -> true; real text -> false; placeholder text -> false (out of scope by design)', () => {
  assert.equal(isBlankDescription(null), true);
  assert.equal(isBlankDescription(undefined), true);
  assert.equal(isBlankDescription(''), true);
  assert.equal(isBlankDescription('   '), true);
  assert.equal(isBlankDescription('Handles webhook signing'), false);
  // C1038 placeholder text is a DIFFERENT problem (Knowledge Base > Re-Index owns it) —
  // pinning this false is the scope decision, not an oversight.
  assert.equal(isBlankDescription('Auto-registered by createTask'), false);
  assert.equal(isBlankDescription('auto-registered by whatever'), false);
});

test('selectTagsNeedingDescription: null registry (failed fetch) -> [] — unknown is never treated as blank', () => {
  assert.deepEqual(selectTagsNeedingDescription(['tt-foo', 'bar'], null), []);
});

test('selectTagsNeedingDescription: empty taskTags -> []', () => {
  assert.deepEqual(selectTagsNeedingDescription([], { 'tt-foo': '' }), []);
});

test('selectTagsNeedingDescription: unregistered tag (absent from registry map) is skipped, not treated as blank', () => {
  assert.deepEqual(selectTagsNeedingDescription(['tt-unregistered'], { 'tt-foo': '' }), []);
});

test('selectTagsNeedingDescription: only blank ones returned, in task-tag order, case-insensitive match', () => {
  const registry = { 'tt-foo': '', bar: 'real description', baz: '   ' };
  assert.deepEqual(
    selectTagsNeedingDescription(['bar', 'TT-Foo', 'baz'], registry),
    ['TT-Foo', 'baz']
  );
});

test('buildTagDescriptionDirective: "" when nothing blank, when taskTags empty, when tagDescriptions null', () => {
  assert.equal(buildTagDescriptionDirective(['tt-foo'], { 'tt-foo': 'real' }), '');
  assert.equal(buildTagDescriptionDirective([], { 'tt-foo': '' }), '');
  assert.equal(buildTagDescriptionDirective(['tt-foo'], null), '');
});

test('buildTagDescriptionDirective: names each offending tag; MCP wording by default, REST wording when compact', () => {
  const registry = { 'tt-foo': '', bar: 'real' };
  const note = buildTagDescriptionDirective(['tt-foo', 'bar'], registry);
  assert.match(note, /tt-foo/);
  assert.ok(!note.includes('bar:'), 'registered/real-description tag must not be named');
  assert.match(note, /ensure_project_tag/);
  assert.ok(!note.includes('PUT /tags'));

  const compactNote = buildTagDescriptionDirective(['tt-foo'], registry, { compact: true });
  assert.match(compactNote, /PUT \/tags/);
  assert.ok(!compactNote.includes('ensure_project_tag'));
});

test('buildTagDescriptionDirective: never suggests writing placeholder text', () => {
  const note = buildTagDescriptionDirective(['tt-foo'], { 'tt-foo': '' });
  assert.match(note, /Auto-registered/);
});

// ── fetchTagDescriptions: fail-open ──

test('fetchTagDescriptions: fail-open — null backend, backend missing the method, a rejecting method, and empty taskTags all degrade to null', async () => {
  assert.equal(await fetchTagDescriptions(null, ['tt-foo']), null);
  assert.equal(await fetchTagDescriptions({}, ['tt-foo']), null);
  assert.equal(await fetchTagDescriptions({ getTagsDetailed: async () => { throw new Error('boom'); } }, ['tt-foo']), null);
  assert.equal(await fetchTagDescriptions({ getTagsDetailed: async () => [] }, []), null);
});

test('fetchTagDescriptions: builds a case-folded { name: description } map from getTagsDetailed()', async () => {
  const backend = {
    getTagsDetailed: async () => [
      { name: 'tt-Foo', description: '', knowledgeFileKey: null },
      { name: 'bar', description: 'real description', knowledgeFileKey: null },
    ],
  };
  const map = await fetchTagDescriptions(backend, ['tt-foo', 'bar']);
  assert.deepEqual(map, { 'tt-foo': '', bar: 'real description' });
});

// ── ClaudeAgent.buildPrompt ──

test('ClaudeAgent.buildPrompt: no opts.tagDescriptions and an all-real-descriptions map are byte-identical (default path unaffected)', () => {
  const agent = new ClaudeAgent();
  const withoutKey = agent.buildPrompt('Do the thing', { taskTags: ['tt-foo'] });
  const withAllReal = agent.buildPrompt('Do the thing', { taskTags: ['tt-foo'], tagDescriptions: { 'tt-foo': 'real description' } });
  assert.equal(withoutKey, withAllReal);
});

test('ClaudeAgent.buildPrompt: blank description appends the directive, task prompt still last', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-foo', 'bar'], tagDescriptions: { 'tt-foo': '', bar: 'real' } });
  assert.match(prompt, /tt-foo/);
  assert.ok(!prompt.includes('bar: '), 'registered/real-description tag must not be named');
  assert.match(prompt, /ensure_project_tag/);
  assert.ok(prompt.trim().endsWith('Do the thing'), 'task prompt must still be the last thing in the string');
});

test('ClaudeAgent.buildPrompt: designMode wins — no tag-description directive fused into the /design brief', () => {
  const agent = new ClaudeAgent();
  const prompt = agent.buildPrompt('Do the thing', { designMode: true, taskTags: ['tt-foo'], tagDescriptions: { 'tt-foo': '' } });
  assert.ok(prompt.startsWith('/design '));
  assert.ok(!prompt.includes('ensure_project_tag'));
});

// ── CodexAgent.buildPrompt ──

test('CodexAgent.buildPrompt: no opts.tagDescriptions and an all-real-descriptions map are byte-identical', () => {
  const agent = new CodexAgent();
  const withoutKey = agent.buildPrompt('Do the thing', { taskTags: ['tt-foo'] });
  const withAllReal = agent.buildPrompt('Do the thing', { taskTags: ['tt-foo'], tagDescriptions: { 'tt-foo': 'real description' } });
  assert.equal(withoutKey, withAllReal);
});

test('CodexAgent.buildPrompt: blank description appends the directive', () => {
  const agent = new CodexAgent();
  const prompt = agent.buildPrompt('Do the thing', { taskTags: ['tt-foo'], tagDescriptions: { 'tt-foo': '' } });
  assert.match(prompt, /tt-foo/);
  assert.match(prompt, /ensure_project_tag/);
});

// ── PiAgent.buildPrompt ──

test('PiAgent.buildPrompt: no opts.tagDescriptions and an all-real-descriptions map are byte-identical', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const withoutKey = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir });
    const withAllReal = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir, tagDescriptions: { 'tt-pi-session': 'real description' } });
    assert.equal(withoutKey, withAllReal);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.buildPrompt: blank description uses PUT /tags/:name wording (no MCP), stays echo-safe and under the size budget', (t) => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    // A long tag list on top of a blank one exercises the MAX_LISTED_TAGS cap alongside
    // the existing 9000-char budget in the same pass.
    const manyTags = Array.from({ length: 20 }, (_, i) => `tt-tag-${i}`);
    const taskTags = ['tt-pi-session', ...manyTags];
    const tagDescriptions = { 'tt-pi-session': '' };
    for (const t of manyTags) tagDescriptions[t] = '';

    const prompt = agent.buildPrompt('Do the thing.', { taskTags, projectPath: dir, tagDescriptions });

    assert.match(prompt, /PUT \/tags/);
    assert.ok(!prompt.includes('ensure_project_tag'));

    for (const line of prompt.split('\n')) {
      assert.equal(matchPromptLine(line, PI_PROMPT_PATTERNS), null, `PI table matched: ${line}`);
      assert.equal(matchPromptLine(line, GENERIC_PROMPT_PATTERNS), null, `generic table matched: ${line}`);
    }
    for (const { re, agents } of buildLegacyPatternTable()) {
      if (agents && !agents.includes('pi')) continue;
      assert.ok(!re.test(prompt), `tail-scoped pattern matched the prompt: ${re}`);
    }
    assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*plan ready[.!]?\s*$/im);
    assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*questions ready[.!]?\s*$/im);

    // Ceiling raised 8500 -> 9000 for C1542's unconditional compact KB-hygiene directive
    // — see pi-agent.test.js's own comment on the same change.
    t.diagnostic(`Pi blank-tag fixture: ${prompt.length} / 9000`);
    assert.ok(prompt.length < 9000, `prompt grew to ${prompt.length} chars`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Assert delivered meaning independently of buildSharedPreamble's own list.
for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
  test(`${new Agent().id}: tagBackfill contract survives shared assembly and detects omission/duplication`, (t) => {
    const agent = new Agent();
    const verify = require('./prompt-contract-assertions').tagBackfill;
    const opts = { taskTags: ['tt-fixture'], tagDescriptions: { 'tt-fixture': '' } };
    opts.projectPath = require('./prompt-contract-assertions').projectFixture(t);
    const build = () => agent.buildPrompt('Implement fixture task.', opts);
    verify(build(), agent.id);
    const original = agent.buildTagDescriptionDirective.bind(agent);
    const stub = t.mock.method(agent, 'buildTagDescriptionDirective', () => '');
    assert.throws(() => verify(build(), agent.id), { code: 'ERR_ASSERTION' }, 'missing directive must fail the semantic contract');
    stub.mock.mockImplementation((...args) => {
      const directive = original(...args);
      return directive + '\n' + directive;
    });
    assert.throws(() => verify(build(), agent.id), { code: 'ERR_ASSERTION' }, 'duplicated directive must fail the semantic contract');
  });
}

test('all adapters omit backfill when data is unknown, unregistered, real, or placeholder-only', (t) => {
  const projectPath = require('./prompt-contract-assertions').projectFixture(t);
  for (const Agent of [ClaudeAgent, CodexAgent, PiAgent]) {
    for (const tagDescriptions of [undefined, null, {}, { 'tt-fixture': 'Real module summary' }, { 'tt-fixture': 'Auto-registered by createTask' }]) {
      const prompt = new Agent().buildPrompt('TASK', { projectPath, taskTags: ['tt-fixture'], tagDescriptions });
      assert.doesNotMatch(prompt, /Blank tag description/);
    }
    for (const description of ['', '  ', null]) {
      const agent = new Agent();
      const prompt = agent.buildPrompt('TASK', { projectPath, taskTags: ['tt-fixture'], tagDescriptions: { 'tt-fixture': description } });
      require('./prompt-contract-assertions').tagBackfill(prompt, agent.id);
    }
  }
});
