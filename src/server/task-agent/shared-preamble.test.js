'use strict';

// BaseTaskAgent#buildSharedPreamble() — the one assembly point every adapter's buildPrompt()
// gets its common directives from. Covers the helper's own contract (slot shape, fixed order,
// no empty directive for absent optional data, per-agent full/compact + clarify policy) and
// that each directive lands exactly once in a real kickoff prompt.

const test = require('node:test');
const assert = require('node:assert/strict');
const BaseTaskAgent = require('./base-agent');
const ClaudeAgent = require('./claude-agent');
const CodexAgent = require('./codex-agent');
const PiAgent = require('./pi-agent');
const { buildVcsDirective } = require('../vcs-settings');

const GIT_ALL_ON = { type: 'git', worktree: true, commit: true, pr: true };
const BLANK_TAG_OPTS = { taskTags: ['tt-foo'], tagDescriptions: { 'tt-foo': '' } };
const ALL_OPTS = { vcsSettings: GIT_ALL_ON, agentLimits: { maxSubagents: 5 }, ...BLANK_TAG_OPTS };

function bareAgent() {
  return new (class extends BaseTaskAgent { constructor() { super('x', 'X'); } })();
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('buildSharedPreamble: absent optional data emits no empty directive', () => {
  for (const agent of [bareAgent(), new ClaudeAgent(), new CodexAgent(), new PiAgent()]) {
    const p = agent.buildSharedPreamble({});
    assert.equal(p.vcs, '');
    assert.equal(p.tagDesc, '');
    assert.deepEqual(p.directives, [p.processSafety, p.resourceLimits, p.kbHygiene, p.taskStatus]);
    assert.ok(p.directives.every(d => typeof d === 'string' && d.trim().length > 0));
  }
});

test('buildSharedPreamble: called with no argument at all -> same as empty opts', () => {
  const agent = bareAgent();
  assert.deepEqual(agent.buildSharedPreamble(), agent.buildSharedPreamble({}));
});

test('buildSharedPreamble: fixed order vcs -> tagDesc -> processSafety -> resourceLimits -> kbHygiene -> taskStatus', () => {
  for (const agent of [bareAgent(), new ClaudeAgent(), new CodexAgent(), new PiAgent()]) {
    const p = agent.buildSharedPreamble(ALL_OPTS);
    assert.ok(p.vcs && p.tagDesc, 'both optional directives must render for this fixture');
    assert.deepEqual(p.directives, [p.vcs, p.tagDesc, p.processSafety, p.resourceLimits, p.kbHygiene, p.taskStatus]);
  }
});

test('buildSharedPreamble: clarify is its own slot, never inside directives', () => {
  for (const agent of [bareAgent(), new CodexAgent(), new PiAgent()]) {
    const p = agent.buildSharedPreamble(ALL_OPTS);
    assert.ok(p.clarify.startsWith('Clarifying questions:'));
    assert.ok(!p.directives.includes(p.clarify));
    assert.ok(p.directives.every(d => !d.includes('Clarifying questions:')));
  }
});

test('getPreamblePolicy: base/Codex full + clarify, Claude full without clarify, Pi compact + clarify', () => {
  assert.deepEqual(bareAgent().getPreamblePolicy(), { compact: false, clarify: true });
  assert.deepEqual(new CodexAgent().getPreamblePolicy(), { compact: false, clarify: true });
  assert.deepEqual(new ClaudeAgent().getPreamblePolicy(), { compact: false, clarify: false });
  assert.deepEqual(new PiAgent().getPreamblePolicy(), { compact: true, clarify: true });
});

test('buildSharedPreamble: Claude and Codex get the full wording; Claude gets no clarify text', () => {
  const claude = new ClaudeAgent();
  const codex = new CodexAgent();
  for (const agent of [claude, codex]) {
    const p = agent.buildSharedPreamble(ALL_OPTS);
    assert.equal(p.processSafety, agent.buildProcessSafetyDirective());
    assert.equal(p.resourceLimits, agent.buildResourceLimitsDirective(ALL_OPTS.agentLimits));
    assert.equal(p.kbHygiene, agent.buildKbHygieneDirective());
    assert.equal(p.taskStatus, agent.buildTaskStatusDirective());
    assert.equal(p.vcs, buildVcsDirective(GIT_ALL_ON));
  }
  assert.equal(claude.buildSharedPreamble(ALL_OPTS).clarify, '');
  assert.equal(codex.buildSharedPreamble(ALL_OPTS).clarify, codex.buildClarifyDirective());
});

test('buildSharedPreamble: Pi gets compact wording everywhere, subclass overrides still honored', () => {
  const pi = new PiAgent();
  const p = pi.buildSharedPreamble(ALL_OPTS);
  assert.equal(p.processSafety, pi.buildProcessSafetyDirective({ compact: true }));
  assert.equal(p.resourceLimits, pi.buildResourceLimitsDirective(ALL_OPTS.agentLimits, { compact: true }));
  assert.equal(p.kbHygiene, pi.buildKbHygieneDirective({ compact: true }));
  assert.equal(p.taskStatus, pi.buildTaskStatusDirective({ compact: true }));
  assert.equal(p.clarify, pi.buildClarifyDirective({ compact: true }));
  // resolveVcsDirective()/buildTagDescriptionDirective() are Pi overrides — reached through `this`.
  assert.equal(p.vcs, buildVcsDirective(GIT_ALL_ON, { compact: true }));
  assert.equal(p.tagDesc, pi.buildTagDescriptionDirective(ALL_OPTS));
  assert.notEqual(p.tagDesc, new CodexAgent().buildSharedPreamble(ALL_OPTS).tagDesc);
});

test('buildSharedPreamble: a policy override alone switches the variant', () => {
  const agent = new (class extends BaseTaskAgent {
    constructor() { super('x', 'X'); }
    getPreamblePolicy() { return { compact: true, clarify: false }; }
  })();
  const p = agent.buildSharedPreamble({});
  assert.equal(p.processSafety, agent.buildProcessSafetyDirective({ compact: true }));
  assert.equal(p.resourceLimits, agent.buildResourceLimitsDirective(undefined, { compact: true }));
  assert.equal(p.kbHygiene, agent.buildKbHygieneDirective({ compact: true }));
  assert.equal(p.taskStatus, agent.buildTaskStatusDirective({ compact: true }));
  assert.equal(p.clarify, '');
});

test('buildPrompt: independently specified semantic contracts reach every agent once', (t) => {
  const { projectFixture, processSafety, resourceLimits, kbHygiene, taskStatus, tagBackfill, vcsOff } = require('./prompt-contract-assertions');
  const opts = {
    projectPath: projectFixture(t), vcsSettings: { type: 'off' }, agentLimits: { maxSubagents: 5 },
    taskTags: ['tt-fixture'], tagDescriptions: { 'tt-fixture': '' },
  };
  for (const agent of [new ClaudeAgent(), new CodexAgent(), new PiAgent()]) {
    const prompt = agent.buildPrompt('Do the thing', opts);
    processSafety(prompt);
    resourceLimits(prompt, 5);
    kbHygiene(prompt);
    taskStatus(prompt);
    tagBackfill(prompt, agent.id);
    vcsOff(prompt);
    assert.ok(prompt.trim().endsWith('Do the thing'), `${agent.id}: task prompt stays last`);
  }
});

test('buildPrompt: no blank directive gap when optional data is absent', () => {
  const claude = new ClaudeAgent().buildPrompt('Do the thing', {});
  assert.doesNotMatch(claude, /\n{3,}/, 'Claude framing never grows a triple newline');
  assert.ok(!claude.includes('Version control'));
  for (const agent of [new CodexAgent(), new PiAgent()]) {
    const prompt = agent.buildPrompt('Do the thing', {});
    assert.ok(!prompt.includes('Version control'), agent.id);
    assert.ok(prompt.includes('\nProcess safety:'), agent.id);
  }
});

test('buildPrompt: Claude carries no clarify text; Codex/Pi keep question-before-plan placement', () => {
  const claude = new ClaudeAgent().buildPrompt('Do the thing', ALL_OPTS);
  assert.equal(count(claude, 'Clarifying questions:'), 0);
  assert.ok(!/questions ready/i.test(claude), 'no question sentinel wording in the Claude kickoff');

  for (const agent of [new CodexAgent(), new PiAgent()]) {
    const prompt = agent.buildPrompt('Do the thing', ALL_OPTS);
    assert.equal(count(prompt, 'Clarifying questions:'), 1, agent.id);
    const planIdx = prompt.indexOf('Plan ready.');
    const clarifyIdx = prompt.indexOf('Clarifying questions:');
    const contextIdx = prompt.indexOf('Project context:');
    assert.ok(planIdx >= 0 && planIdx < clarifyIdx, `${agent.id}: clarify follows the plan-ready instruction`);
    assert.ok(clarifyIdx < contextIdx, `${agent.id}: clarify sits beside the plan instructions, before project context`);
    assert.ok(contextIdx < prompt.indexOf('Process safety:'), `${agent.id}: directives stay in project context`);
  }
});
