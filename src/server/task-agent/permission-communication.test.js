'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ClaudeAgent = require('./claude-agent');
const CodexAgent = require('./codex-agent');
const PiAgent = require('./pi-agent');
const { MODES, resolvePermissionMode } = require('../permission-policy');
const { projectFixture } = require('./prompt-contract-assertions');
const { matchPromptLine, PI_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS, buildLegacyPatternTable } = require('./prompt-detect');

const agents = () => [new ClaudeAgent(), new CodexAgent(), new PiAgent()];
const vcs = { type: 'git', worktree: false, commit: true, pr: false, merge: false };

function autonomousContract(text, mode) {
  assert.match(text, /inspect the task, comments, repository and KB using permitted tools/);
  assert.match(text, /Compare reasonable options against the user's requirements, correctness, compatibility, maintainability and scope/);
  assert.match(text, /choose the best overall option and continue/);
  assert.match(text, /Briefly report material decisions or assumptions without an unsolicited questionnaire or approval pause/);
  assert.match(text, /honor explicit user instructions to consult them/);
  assert.match(text, /genuinely missing external input or a blocking requirement that available context cannot resolve/);
  assert.match(text, /never invent an answer or treat silence as consent/);
  assert.doesNotMatch(text, /3-5 questions|write the plan immediately|Assumption line in the plan/i);
  if (mode === 'auto') assert.match(text, /Uncertain actions still require approval through the existing permission gate/);
  if (mode === 'accept_edits') assert.match(text, /Other actions still require approval; approval of an edit never broadens that authority/);
  if (mode === 'bypass') assert.match(text, /Do not request routine preferences or approval for already-authorized work/);
}

test('all providers deliver permission-specific communication in normal and simple kickoff prompts', async t => {
  const config = require('../config');
  const oldSimple = config.SIMPLE_MODE;
  t.after(() => { config.SIMPLE_MODE = oldSimple; });
  const projectPath = projectFixture(t);
  for (const simple of [false, true]) for (const agent of agents()) for (const mode of MODES) {
    config.SIMPLE_MODE = simple;
    for (const inherited of [true, false]) {
      const resolved = await resolvePermissionMode({
        task: { agentPermissionMode: inherited ? null : mode },
        backend: { getEffectiveProjectSettings: async () => ({ settings: { agent_permission_mode: mode } }) },
      });
      const permissionPolicy = agent.buildPermissionPolicy(resolved);
      const text = agent.buildPrompt('Implement a bounded cache; choose between reasonable eviction strategies.', {
        projectPath, permissionPolicy, vcsSettings: vcs, vcsContext: { verified: true, vcs }, piMcpBridge: true,
      });
      if (mode !== 'plan' || (agent.id === 'claude' && !simple)) assert.match(text, new RegExp(`Permission policy for this run \\(${mode}\\)`));
      else assert.doesNotMatch(text, /Permission policy for this run/);
      if (!simple || mode !== 'plan') {
        assert.match(text, /complete_task/);
        assert.match(text, /git commit/);
      }
      if (['auto', 'accept_edits', 'bypass'].includes(mode)) {
        autonomousContract(text, mode);
        assert.equal(text.split('Communication for this run:').length - 1, 1);
        if (agent.id !== 'claude') {
          assert.match(text, /one question is enough/);
          assert.match(text, /Questions ready\./);
        } else assert.match(text, /native question tool/);
      } else if (mode === 'plan') {
        assert.equal(permissionPolicy.enforced, false);
        if (!simple && agent.id !== 'claude') assert.ok(text.includes(agent.buildClarifyDirective({ compact: agent.id === 'pi' })));
      } else {
        assert.match(text, /every tool action requires a separate approval/);
        assert.doesNotMatch(text, /autonomous decision-making|one question is enough/);
        if (agent.id !== 'claude') assert.match(text, /material choice remains unresolved/);
      }
      if (mode !== 'plan') assert.doesNotMatch(text, /then wait for Task App approval|Write the plan immediately/);
    }
  }
});

test('continuation consumes the frozen run; inherited relaunch and explicit override resolve afresh', async () => {
  for (const agent of agents()) {
    let mode = 'bypass';
    const backend = { getEffectiveProjectSettings: async () => ({ settings: { agent_permission_mode: mode } }) };
    const launch = async task => agent.buildPermissionPolicy(await resolvePermissionMode({ backend, task }));
    const session = { permissionPolicy: await launch({}) };
    const original = agent.getApprovalText(session);
    mode = 'plan';
    assert.ok(Object.isFrozen(session.permissionPolicy));
    assert.throws(() => { session.permissionPolicy.communication = ''; }, TypeError);
    assert.equal(agent.getApprovalText(session), original);
    autonomousContract(original, 'bypass');
    session.permissionPolicy = await launch({});
    const relaunched = agent.getApprovalText(session);
    assert.equal(relaunched, agent.getApprovalText());
    session.permissionPolicy = await launch({ agentPermissionMode: 'auto' });
    autonomousContract(agent.getApprovalText(session), 'auto');
  }
});

test('legacy null policy keeps existing question and approval flow', () => {
  for (const agent of agents()) {
    const opts = { permissionPolicy: agent.buildPermissionPolicy({ mode: null, source: 'legacy' }) };
    assert.equal(agent.buildCommunicationDirective(opts), agent.buildSharedPreamble().clarify);
    assert.equal(agent.getApprovalText(opts), agent.getApprovalText());
  }
});

test('Plan approval sends a go-ahead instead of repeating planning instructions, including older enforced snapshots', () => {
  for (const agent of agents()) for (const enforced of [false, true]) {
    const permissionPolicy = Object.freeze({ ...agent.buildPermissionPolicy({ mode: 'plan' }), enforced });
    const text = agent.getApprovalText({ permissionPolicy });
    if (!enforced) assert.equal(text, agent.getApprovalText());
    assert.match(text, /^Plan approved\. Implement the approved plan now\b/);
    assert.doesNotMatch(text, /Wait for user approval|Plan ready\./);
  }
});

test('Codex and Pi Plan retain the legacy planning prompt and submit approval in the same terminal', async t => {
  const config = require('../config');
  const oldSimple = config.SIMPLE_MODE;
  t.after(() => { config.SIMPLE_MODE = oldSimple; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(require('../vcs-context'), 'refreshSessionVcs', async () => ({ verified: true, vcs }));
  const projectPath = projectFixture(t);
  for (const agent of [new CodexAgent(), new PiAgent()]) {
    if (agent.id === 'codex') t.mock.method(agent, 'prepareKickoff', (_config, text) => ({ initialPrompt: text }));
    for (const simple of [false, true]) for (const enforced of [false, true]) {
      config.SIMPLE_MODE = simple;
      const permissionPolicy = { ...agent.buildPermissionPolicy({ mode: 'plan' }), enforced };
      const prompt = agent.buildPrompt('Work on task T1: add a cache.', { projectPath, permissionPolicy });
      assert.match(prompt, /planning mode enforced by Task App/);
      assert.match(prompt, /Plan ready\./);
      assert.match(prompt, /until the user approves the plan/);
      assert.doesNotMatch(prompt, /restart|Plan mode is read-only/);
      const writes = [];
      const session = { alive: true, taskId: 'T1', permissionPolicy, pty: { write: text => writes.push(text) } };
      const originalPty = session.pty;
      await agent.approvePlan(session);
      t.mock.timers.tick(250);
      assert.equal(session.pty, originalPty);
      assert.match(writes.join(''), /Plan approved\. Implement the approved plan now/);
      assert.equal(writes.at(-1), '\r');
      assert.doesNotMatch(writes.join(''), /Plan ready\.|Wait for user approval/);
    }
  }
});

test('Claude and Codex continuation submission threads the existing session policy', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(require('../vcs-context'), 'refreshSessionVcs', async () => ({ verified: true, vcs }));
  for (const agent of [new ClaudeAgent(), new CodexAgent()]) {
    const writes = [];
    const session = {
      alive: true, taskId: 'T1',
      permissionPolicy: agent.buildPermissionPolicy({ mode: 'auto', source: 'project' }),
      pty: { write: text => writes.push(text) },
    };
    if (agent.id === 'codex') t.mock.method(agent, 'prepareKickoff', (_config, text) => ({ initialPrompt: text }));
    await agent.approvePlan(session);
    t.mock.timers.tick(250);
    autonomousContract(writes.join('\n'), 'auto');
    assert.doesNotMatch(writes.join('\n'), /Plan approved/);
  }
});

test('Pi discovery, REST fallback and approval retry retain scoped communication without forcing a plan', t => {
  const agent = new PiAgent();
  const permissionPolicy = agent.buildPermissionPolicy({ mode: 'bypass', source: 'task' });
  for (const piMcpBridge of [true, false]) {
    const text = agent.buildPrompt('Discover existing code and consult me about missing requirements.', {
      permissionPolicy, projectPath: projectFixture(t), discovery: true, piMcpBridge,
    });
    autonomousContract(text, 'bypass');
    assert.match(text, /Honor the task's explicit request to consult the user/);
    assert.doesNotMatch(text, /plan comes after the answers/);
  }
  let submitted;
  t.mock.method(agent, '_submitApproval', (_session, text) => { submitted = text; });
  const session = { pty: {}, permissionPolicy };
  agent.approvePlan(session);
  autonomousContract(submitted, 'bypass');
  agent.retryApproval(session);
  autonomousContract(submitted, 'bypass');
});

test('Pi communication is echo-safe in every mode', () => {
  const agent = new PiAgent();
  for (const mode of MODES) {
    const text = agent.buildCommunicationDirective({ permissionPolicy: agent.buildPermissionPolicy({ mode }) });
    for (const line of text.split('\n')) {
      assert.equal(matchPromptLine(line, PI_PROMPT_PATTERNS), null, line);
      assert.equal(matchPromptLine(line, GENERIC_PROMPT_PATTERNS), null, line);
    }
    for (const { re, agents } of buildLegacyPatternTable()) {
      if (!agents || agents.includes('pi')) assert.ok(!re.test(text), String(re));
    }
    assert.doesNotMatch(text, /^\s*(?:Questions|Plan) ready\.\s*$/m);
  }
});
