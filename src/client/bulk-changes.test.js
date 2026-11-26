import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hasBulkChanges, stagedBulkFields, stageBulkField, stageBulkAgent, stageBulkModel, stageBulkEffort, stageBulkDesignMode, resolveBulkAgentModel,
  bulkPatchBody, bulkCowboyBlockedTaskIds, agentHasEffort, BULK_MODEL_FIELDS, BULK_EFFORT_AGENTS,
  splitBulkEditable, bulkApplyWrites,
} from './bulk-changes.js';
import { CODEX_MODELS, CLAUDE_MODELS, EFFORT_LEVELS, normalizeAgentModels } from './constants.js';

// (TPT9159) The bulk bar's staged-edit record and the PATCH body Apply builds from it.

test('an empty record has nothing to apply', () => {
  assert.equal(hasBulkChanges({}), false);
  assert.equal(hasBulkChanges(null), false);
  assert.deepEqual(stagedBulkFields({}), []);
  assert.deepEqual(bulkPatchBody({}, {}), {});
});

test('permission mode stages independently, clears with Project Default, and leaves untouched PATCHes alone', () => {
  const original = { status: 'on_fire' };
  assert.deepEqual(bulkPatchBody(original), { status: 'on_fire' });
  for (const permissionMode of [null, 'plan', 'auto', 'bypass']) {
    const changes = stageBulkField(original, 'permissionMode', permissionMode);
    assert.equal(hasBulkChanges({ permissionMode }), true);
    assert.deepEqual(stagedBulkFields(changes), ['status', 'permissionMode']);
    assert.deepEqual(bulkPatchBody(changes, { reassign: false }), { status: 'on_fire', agent_permission_mode: permissionMode },
      'permission overrides also apply to agent-locked tasks');
    assert.deepEqual(stageBulkField(changes, 'permissionMode', ''), original);
    assert.deepEqual(stageBulkField(changes, 'permissionMode', undefined), original);
  }
  assert.deepEqual(original, { status: 'on_fire' });
});

test('staged Bypass permits either Cowboy scope in the same PATCH regardless of saved overrides', () => {
  const tasks = [{ id: 'plan', agentPermissionMode: 'plan' }, { id: 'auto', agent_permission_mode: 'auto' }, { id: 'unset' }];
  for (const cowboyScope of ['related', 'project']) {
    const changes = { permissionMode: 'bypass', cowboyScope };
    assert.deepEqual(bulkCowboyBlockedTaskIds(changes, tasks, 'plan'), []);
    assert.deepEqual(bulkPatchBody(changes), { agent_permission_mode: 'bypass', cowboy_mode: cowboyScope });
  }
});

test('staged Plan or Auto blocks Cowboy even for saved and inherited Bypass tasks', () => {
  const tasks = [{ id: 'bypass', agentPermissionMode: 'bypass' }, { id: 'raw', agent_permission_mode: 'bypass' }, { id: 'inherited' }];
  for (const permissionMode of ['plan', 'auto']) {
    for (const cowboyScope of ['related', 'project']) {
      assert.deepEqual(bulkCowboyBlockedTaskIds({ permissionMode, cowboyScope }, tasks, 'bypass'), ['bypass', 'raw', 'inherited']);
    }
    assert.deepEqual(bulkCowboyBlockedTaskIds({ permissionMode, cowboyScope: 'disabled' }, tasks, 'bypass'), []);
  }
});

test('staged Project Default resolves the project mode instead of either saved override shape', () => {
  const tasks = [{ id: 'camel', agentPermissionMode: 'auto' }, { id: 'raw', agent_permission_mode: 'plan' }];
  for (const cowboyScope of ['related', 'project']) {
    assert.deepEqual(bulkCowboyBlockedTaskIds({ permissionMode: null, cowboyScope }, tasks, 'bypass'), []);
    for (const projectDefault of ['plan', 'auto', null]) {
      assert.deepEqual(bulkCowboyBlockedTaskIds({ permissionMode: null, cowboyScope }, tasks, projectDefault), ['camel', 'raw']);
    }
  }
});

test('stageBulkField stages a value and unstages it on an empty one', () => {
  let changes = stageBulkField({}, 'status', 'completed');
  assert.deepEqual(changes, { status: 'completed' });
  changes = stageBulkField(changes, 'assignee', 7, { assigneeName: 'Dana' });
  assert.deepEqual(stagedBulkFields(changes), ['status', 'assignee']);
  changes = stageBulkField(changes, 'status', '');
  changes = stageBulkField(changes, 'assignee', undefined, { assigneeName: '' });
  assert.deepEqual(changes, {});
});

test('Design mode lives only beside a staged Claude and is cleared by another agent', () => {
  let changes = stageBulkAgent({}, 'claude');
  assert.equal(changes.claudeDesignMode, false);
  changes = stageBulkDesignMode(changes, true);
  assert.equal(changes.claudeDesignMode, true);
  assert.equal(stageBulkAgent(changes, 'claude').claudeDesignMode, true, 'picking Claude again keeps it');
  changes = stageBulkAgent(changes, 'codex');
  assert.equal('claudeDesignMode' in changes, false);
  assert.deepEqual(stageBulkDesignMode(changes, true), changes, 'no Design mode without Claude');
  assert.equal(stageBulkAgent(changes, 'claude').claudeDesignMode, false);
  assert.deepEqual(stageBulkAgent(changes, ''), {});
});

test('a Pi row id rides with the Pi agent only', () => {
  assert.deepEqual(stageBulkAgent({}, 'pi', 'openrouter/qwen'), { agent: 'pi', model: 'openrouter/qwen' });
  assert.deepEqual(stageBulkAgent({ agent: 'pi', model: 'x' }, 'codex'), { agent: 'codex' });
  assert.deepEqual(bulkPatchBody({ agent: 'pi', model: 'x' }), { agent_assignee: 'pi', pi_model: 'x' });
  assert.deepEqual(bulkPatchBody({ agent: 'pi' }), { agent_assignee: 'pi' });
});

// (TPT9212) The bulk Model select: which model a staged agent is saved with.

// The live Codex catalog as GET /api/agent-models serves it (model-registry.js parseCodexCatalog():
// listed models only, top priority flagged isLatest), here without gpt-5.5, which the CLI dropped.
const liveCodex = normalizeAgentModels('codex', { models: [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', isLatest: true },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', isLatest: false },
  { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', isLatest: false },
] });

test('a fresh project assigning Codex saves the recommended live model, never an unavailable gpt-5.5', () => {
  // A new project has no CODEX_MODEL, so the Codex CLI would otherwise run the model its own
  // config names — inherited from ~/.codex/config.toml, possibly gpt-5.5.
  assert.equal(resolveBulkAgentModel('codex', { models: liveCodex, configuredDefault: '' }), 'gpt-6.1-sol');
  assert.equal(resolveBulkAgentModel('codex', { models: liveCodex, configuredDefault: 'gpt-5.5' }), 'gpt-6.1-sol',
    'a configured default the agent no longer offers is skipped');
  assert.equal(resolveBulkAgentModel('codex', { models: liveCodex, picked: 'gpt-5.5', configuredDefault: 'gpt-5.5' }), 'gpt-6.1-sol',
    'so is a pick the agent no longer offers');
  // Before the registry answers, the static list stands in; its first entry is the default.
  assert.ok(CODEX_MODELS.some(m => m.value === 'gpt-5.5'), 'the static fallback still lists gpt-5.5');
  assert.equal(resolveBulkAgentModel('codex', { models: CODEX_MODELS, configuredDefault: '' }), CODEX_MODELS[0].value);
  assert.notEqual(CODEX_MODELS[0].value, 'gpt-5.5');
  const body = bulkPatchBody({ agent: 'codex' }, { model: resolveBulkAgentModel('codex', { models: liveCodex, configuredDefault: '' }) });
  assert.deepEqual(body, { agent_assignee: 'codex', codex_model: 'gpt-6.1-sol' });
});

test('resolveBulkAgentModel prefers the pick, then a valid project default, then the recommended model', () => {
  assert.equal(resolveBulkAgentModel('codex', { models: liveCodex, picked: 'gpt-6-luna', configuredDefault: 'gpt-5.6-sol' }), 'gpt-6-luna');
  assert.equal(resolveBulkAgentModel('codex', { models: liveCodex, configuredDefault: 'gpt-5.6-sol' }), 'gpt-5.6-sol');
  assert.equal(resolveBulkAgentModel('codex', { models: liveCodex, picked: '', configuredDefault: ' gpt-6-luna ' }), 'gpt-6-luna');
  // Claude: an unset project default is 'opusplan', the model its launches fall back to.
  assert.equal(resolveBulkAgentModel('claude', { models: CLAUDE_MODELS, configuredDefault: 'opusplan' }), 'opusplan');
  assert.equal(resolveBulkAgentModel('claude', { models: CLAUDE_MODELS, configuredDefault: 'claude-sonnet-4-6' }), 'claude-sonnet-4-6');
  // The first isLatest entry is the recommendation, not necessarily the first entry.
  assert.equal(resolveBulkAgentModel('codex', { models: [{ value: 'old' }, { value: 'new', isLatest: true }] }), 'new');
  // Pi lists its task-capable rows as plain ids; its default is the first row.
  const rows = ['openrouter/qwen/qwen3', 'openrouter/deepseek/r1'];
  assert.equal(resolveBulkAgentModel('pi', { models: rows, configuredDefault: rows[0] }), rows[0]);
  assert.equal(resolveBulkAgentModel('pi', { models: rows, picked: rows[1], configuredDefault: rows[0] }), rows[1]);
});

test('resolveBulkAgentModel answers null when the agent has no models to offer', () => {
  assert.equal(resolveBulkAgentModel('human', { models: liveCodex, configuredDefault: 'gpt-6.1-sol' }), null);
  assert.equal(resolveBulkAgentModel('', { models: liveCodex }), null);
  assert.equal(resolveBulkAgentModel(undefined), null);
  for (const inherited of ['constructor', '__proto__', 'toString']) {
    assert.equal(resolveBulkAgentModel(inherited, { models: liveCodex }), null, `${inherited} is no agent`);
  }
  assert.equal(resolveBulkAgentModel('pi', { models: [], configuredDefault: '' }), null, 'Pi rows not known yet');
  assert.equal(resolveBulkAgentModel('codex', { models: null }), null);
  assert.deepEqual(Object.keys(BULK_MODEL_FIELDS), ['claude', 'codex', 'pi']);
});

test('a Model pick belongs to its agent: kept on the same agent, dropped by another agent or none', () => {
  let changes = stageBulkAgent({}, 'codex');
  assert.deepEqual(changes, { agent: 'codex' });
  changes = stageBulkModel(changes, 'gpt-6-luna');
  assert.deepEqual(changes, { agent: 'codex', model: 'gpt-6-luna' });
  assert.deepEqual(stageBulkAgent(changes, 'codex'), changes, 'picking Codex again keeps the pick');
  assert.deepEqual(stageBulkAgent(changes, 'claude'), { agent: 'claude', claudeDesignMode: false }, 'another agent drops it');
  assert.deepEqual(stageBulkAgent(changes, ''), {});
  assert.deepEqual(stageBulkAgent(changes, 'human', 'gpt-6-luna'), { agent: 'human' }, 'Human never carries a model');
  assert.deepEqual(stageBulkModel(changes, ''), { agent: 'codex' }, 'an empty pick goes back to the default');
  assert.deepEqual(stageBulkModel({ status: 'on_fire' }, 'gpt-6-luna'), { status: 'on_fire' }, 'no model without an agent');
  assert.deepEqual(stageBulkModel({ agent: 'human' }, 'gpt-6-luna'), { agent: 'human' });
  assert.equal(hasBulkChanges({ agent: 'codex', model: 'gpt-6-luna' }), true);
  assert.deepEqual(stagedBulkFields({ agent: 'codex', model: 'gpt-6-luna' }), ['agent'], 'the model is part of the agent change');
});

test('bulkPatchBody saves the model in the staged agent\'s own field, only with the agent', () => {
  assert.deepEqual(bulkPatchBody({ agent: 'claude', claudeDesignMode: false }, { model: 'claude-opus-5' }),
    { agent_assignee: 'claude', claude_model: 'claude-opus-5', claude_design_mode: false });
  assert.deepEqual(bulkPatchBody({ agent: 'codex', model: 'gpt-6-luna' }), { agent_assignee: 'codex', codex_model: 'gpt-6-luna' });
  assert.deepEqual(bulkPatchBody({ agent: 'codex', model: 'gpt-6-luna' }, { model: 'gpt-6.1-sol' }),
    { agent_assignee: 'codex', codex_model: 'gpt-6.1-sol' }, 'the resolved model Apply passes wins');
  assert.deepEqual(bulkPatchBody({ agent: 'pi' }, { model: 'openrouter/qwen/qwen3' }), { agent_assignee: 'pi', pi_model: 'openrouter/qwen/qwen3' });
  assert.deepEqual(bulkPatchBody({ agent: 'codex' }, { model: null }), { agent_assignee: 'codex' }, 'no model to save');
  assert.deepEqual(bulkPatchBody({ agent: 'human' }, { model: 'gpt-6.1-sol' }), { agent_assignee: 'human' });
  assert.deepEqual(bulkPatchBody({ status: 'completed', agent: 'codex' }, { reassign: false, model: 'gpt-6.1-sol' }), { status: 'completed' },
    'a locked task keeps its agent and model');
});

// (TPT9323) The Effort flyout beside Claude Code and Codex in the bulk agent picker: one pick
// stages the agent and its effort, saved in tasks.effort like the Task Edit modal's Effort row.

test('stageBulkEffort stages a level or Agent default beside a staged Claude or Codex', () => {
  assert.deepEqual(BULK_EFFORT_AGENTS, ['claude', 'codex']);
  assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'max'], 'the Task Edit modal levels');
  for (const agent of BULK_EFFORT_AGENTS) {
    assert.equal(agentHasEffort(agent), true);
    const withAgent = stageBulkAgent({ status: 'on_fire' }, agent);
    for (const level of EFFORT_LEVELS) assert.equal(stageBulkEffort(withAgent, level).effort, level, `${agent} ${level}`);
    assert.equal(stageBulkEffort(withAgent, ' HIGH ').effort, 'high', 'normalized like the API');
    const agentDefault = stageBulkEffort(withAgent, null);
    assert.equal(Object.hasOwn(agentDefault, 'effort'), true);
    assert.equal(agentDefault.effort, null, 'null is an explicit Agent default');
    for (const unstage of ['', undefined]) {
      assert.deepEqual(stageBulkEffort(stageBulkEffort(withAgent, 'max'), unstage), withAgent, 'an empty value removes the pick');
    }
    assert.deepEqual(stageBulkEffort(stageBulkEffort(withAgent, 'low'), 'extreme'), { ...withAgent, effort: 'low' }, 'an unknown level stages nothing');
    assert.deepEqual(stageBulkEffort(withAgent, 3), withAgent);
    assert.deepEqual(stagedBulkFields(stageBulkEffort(withAgent, 'max')), ['status', 'agent'], 'the effort is part of the agent change');
  }
  for (const agent of ['human', 'pi', '', undefined, 'constructor', 'toString']) assert.equal(agentHasEffort(agent), false, `${agent} has no effort`);
});

test('stageBulkEffort stages nothing without a staged Claude or Codex', () => {
  for (const changes of [{}, { status: 'on_fire' }, { agent: 'human' }, { agent: 'pi', model: 'openrouter/qwen' }]) {
    const next = stageBulkEffort(changes, 'high');
    assert.deepEqual(next, changes);
    assert.notEqual(next, changes, 'still a new record');
  }
  assert.deepEqual(stageBulkEffort({ agent: 'pi', effort: 'high' }, 'max'), { agent: 'pi' }, 'a stray effort beside Pi is dropped');
  assert.equal(hasBulkChanges(stageBulkEffort({}, 'max')), false);
});

test('an Effort pick belongs to its agent: kept on the same agent, dropped by another agent, Human or none', () => {
  const claudeHigh = stageBulkEffort(stageBulkAgent({}, 'claude'), 'high');
  assert.deepEqual(claudeHigh, { agent: 'claude', claudeDesignMode: false, effort: 'high' });
  assert.deepEqual(stageBulkAgent(claudeHigh, 'claude'), claudeHigh, 'picking the Claude row again keeps the effort');
  assert.deepEqual(stageBulkAgent(claudeHigh, 'codex'), { agent: 'codex' }, 'Codex drops the Claude effort');
  assert.deepEqual(stageBulkAgent(claudeHigh, 'human'), { agent: 'human' });
  assert.deepEqual(stageBulkAgent(claudeHigh, 'pi', 'openrouter/qwen'), { agent: 'pi', model: 'openrouter/qwen' });
  assert.deepEqual(stageBulkAgent(claudeHigh, ''), {});
  const codexDefault = stageBulkEffort(stageBulkAgent({ status: 'on_fire' }, 'codex'), null);
  assert.deepEqual(codexDefault, { status: 'on_fire', agent: 'codex', effort: null });
  assert.deepEqual(stageBulkAgent(codexDefault, 'codex'), codexDefault, 'so is Agent default');
  assert.deepEqual(stageBulkAgent(codexDefault, 'claude'), { status: 'on_fire', agent: 'claude', claudeDesignMode: false });
  // A flyout pick re-stages the agent, then its effort: the new level replaces the old one, and
  // the agent's Model pick and Design mode stay.
  const picked = stageBulkEffort(stageBulkAgent({ ...claudeHigh, model: 'claude-opus-5-5', claudeDesignMode: true }, 'claude'), 'max');
  assert.deepEqual(picked, { agent: 'claude', model: 'claude-opus-5-5', claudeDesignMode: true, effort: 'max' });
  // Picking another agent's level switches both at once.
  assert.deepEqual(stageBulkEffort(stageBulkAgent(picked, 'codex'), 'low'), { agent: 'codex', effort: 'low' });
  assert.deepEqual(claudeHigh, { agent: 'claude', claudeDesignMode: false, effort: 'high' }, 'records are never changed in place');
});

test('bulkPatchBody saves the staged effort with the agent only', () => {
  assert.deepEqual(bulkPatchBody({ agent: 'codex', effort: 'max' }, { model: 'gpt-6.1-sol' }),
    { agent_assignee: 'codex', codex_model: 'gpt-6.1-sol', effort: 'max' });
  assert.deepEqual(bulkPatchBody({ agent: 'claude', claudeDesignMode: true, effort: 'low' }, { model: 'opusplan' }),
    { agent_assignee: 'claude', claude_model: 'opusplan', claude_design_mode: true, effort: 'low' });
  assert.deepEqual(bulkPatchBody({ agent: 'claude', claudeDesignMode: false, effort: null }),
    { agent_assignee: 'claude', claude_design_mode: false, effort: null }, 'Agent default clears the saved level');
  assert.deepEqual(bulkPatchBody({ agent: 'codex' }, { model: 'gpt-6.1-sol' }), { agent_assignee: 'codex', codex_model: 'gpt-6.1-sol' },
    'no staged effort: every task keeps its own');
  assert.deepEqual(bulkPatchBody({ status: 'completed', agent: 'codex', effort: 'high' }, { reassign: false, model: 'gpt-6.1-sol' }), { status: 'completed' },
    'a locked task keeps its agent, model and effort');
  // A record stageBulkEffort() would not build never writes an effort.
  assert.deepEqual(bulkPatchBody({ agent: 'pi', effort: 'high' }, { model: 'openrouter/qwen' }), { agent_assignee: 'pi', pi_model: 'openrouter/qwen' });
  assert.deepEqual(bulkPatchBody({ agent: 'human', effort: 'high' }), { agent_assignee: 'human' });
  assert.deepEqual(bulkPatchBody({ agent: 'codex', effort: 'extreme' }), { agent_assignee: 'codex' });
  assert.deepEqual(bulkPatchBody({ status: 'on_fire', effort: 'high' }), { status: 'on_fire' }, 'no effort without an agent');
});

test('bulkPatchBody carries every staged field in one body', () => {
  const changes = { priority: '4', status: 'on_fire', agent: 'claude', claudeDesignMode: true, assignee: 7, assigneeName: 'Dana' };
  assert.deepEqual(bulkPatchBody(changes, { priority: 4 }), {
    priority: 4, status: 'on_fire', assignee: 7, agent_assignee: 'claude', claude_design_mode: true,
  });
  assert.deepEqual(bulkPatchBody({ agent: 'claude', claudeDesignMode: false }), { agent_assignee: 'claude', claude_design_mode: false });
  assert.deepEqual(bulkPatchBody({ agent: 'codex' }), { agent_assignee: 'codex' }, 'Design mode is never written for another agent');
});

test('a locked task keeps its agent and Design mode but takes the other fields', () => {
  const changes = { status: 'completed', agent: 'claude', claudeDesignMode: true };
  assert.deepEqual(bulkPatchBody(changes, { reassign: false }), { status: 'completed' });
  assert.deepEqual(bulkPatchBody({ agent: 'codex' }, { reassign: false }), {});
});

test('Backlog is sent as sprint_id:null, a sprint as its number', () => {
  assert.deepEqual(bulkPatchBody({ priority: 'null' }, { priority: 0 }), { sprint_id: null });
  assert.deepEqual(bulkPatchBody({ priority: '__new__' }, { priority: 9 }), { priority: 9 });
});

test('Cowboy scopes stage beside Bypass, normalize legacy values and preserve other edits', () => {
  const original = { status: 'on_fire', assignee: 7, agent: 'claude', claudeDesignMode: true, permissionMode: 'bypass' };
  for (const [value, scope] of [['disabled', 'disabled'], ['related', 'related'], ['project', 'project'], [true, 'project'], [false, 'disabled']]) {
    const changes = stageBulkField(original, 'cowboyScope', value);
    assert.equal(hasBulkChanges({ cowboyScope: changes.cowboyScope }), true);
    assert.deepEqual(bulkPatchBody(changes), {
      status: 'on_fire', assignee: 7, agent_permission_mode: 'bypass', agent_assignee: 'claude', claude_design_mode: true, cowboy_mode: scope,
    });
    assert.deepEqual(bulkPatchBody(changes, { reassign: false }), { status: 'on_fire', assignee: 7, agent_permission_mode: 'bypass', cowboy_mode: scope });
    assert.deepEqual(stageBulkField(changes, 'cowboyScope', ''), original);
  }
  assert.deepEqual(bulkPatchBody(original), { status: 'on_fire', assignee: 7, agent_permission_mode: 'bypass', agent_assignee: 'claude', claude_design_mode: true });
  assert.deepEqual(original, { status: 'on_fire', assignee: 7, agent: 'claude', claudeDesignMode: true, permissionMode: 'bypass' });
});

// (TPT9322) The bulk bar shows Cowboy only beside a staged Bypass, and the record follows it.
test('a staged Cowboy scope stays with Bypass and drops with Plan, Auto, Project Default or an unstaged mode', () => {
  for (const scope of ['disabled', 'related', 'project']) {
    const withCowboy = stageBulkField(stageBulkField({ status: 'on_fire' }, 'permissionMode', 'bypass'), 'cowboyScope', scope);
    assert.deepEqual(withCowboy, { status: 'on_fire', permissionMode: 'bypass', cowboyScope: scope });
    assert.deepEqual(bulkPatchBody(withCowboy), { status: 'on_fire', agent_permission_mode: 'bypass', cowboy_mode: scope },
      'Apply sends the scope with Bypass in one PATCH');
    assert.deepEqual(stageBulkField(withCowboy, 'permissionMode', 'bypass'), withCowboy, 'picking Bypass again keeps the scope');
    assert.deepEqual(stageBulkField(withCowboy, 'status', 'completed').cowboyScope, scope, 'other fields leave it alone');
    for (const mode of ['plan', 'auto', null]) {
      const next = stageBulkField(withCowboy, 'permissionMode', mode);
      assert.deepEqual(next, { status: 'on_fire', permissionMode: mode }, `${mode ?? 'Project Default'} drops the scope`);
      assert.deepEqual(bulkPatchBody(next), { status: 'on_fire', agent_permission_mode: mode }, 'and Apply writes no cowboy_mode');
    }
    for (const unstaged of ['', undefined]) {
      assert.deepEqual(stageBulkField(withCowboy, 'permissionMode', unstaged), { status: 'on_fire' }, 'unstaging the mode drops the scope');
    }
    assert.deepEqual(withCowboy, { status: 'on_fire', permissionMode: 'bypass', cowboyScope: scope }, 'the record itself is never changed');
  }
});

test('a Cowboy scope does not stage without a staged Bypass', () => {
  for (const changes of [{}, { status: 'on_fire' }, { permissionMode: 'plan' }, { permissionMode: 'auto' }, { permissionMode: null }]) {
    const next = stageBulkField(changes, 'cowboyScope', 'related');
    assert.deepEqual(next, changes);
    assert.notEqual(next, changes, 'still a new record');
    assert.deepEqual(stageBulkField(next, 'permissionMode', 'bypass').cowboyScope, undefined, 'a later Bypass pick starts with no scope');
  }
  assert.equal(hasBulkChanges(stageBulkField({}, 'cowboyScope', 'project')), false);
});

test('enabling Cowboy requires effective Bypass; disabling and unrelated edits work in any mode', () => {
  const tasks = [
    { id: 'override', agentPermissionMode: 'bypass' },
    { id: 'inherited', agentPermissionMode: null },
    { id: 'auto', agent_permission_mode: 'auto' },
    { id: 'plan', agentPermissionMode: 'plan' },
  ];
  for (const cowboyScope of ['related', 'project']) {
    assert.deepEqual(bulkCowboyBlockedTaskIds({ cowboyScope }, tasks, 'bypass'), ['auto', 'plan']);
    assert.deepEqual(bulkCowboyBlockedTaskIds({ cowboyScope }, tasks, 'auto'), ['inherited', 'auto', 'plan']);
    assert.deepEqual(bulkCowboyBlockedTaskIds({ cowboyScope }, tasks, null), ['inherited', 'auto', 'plan']);
  }
  assert.deepEqual(bulkCowboyBlockedTaskIds({ cowboyScope: 'disabled' }, tasks, 'auto'), []);
  assert.deepEqual(bulkCowboyBlockedTaskIds({ status: 'on_fire' }, tasks, null), []);
});

test('tasks without permission overrides inherit Bypass for either enabled Cowboy scope', () => {
  const tasks = [
    { id: 'omitted' },
    { id: 'null', agentPermissionMode: null },
    { id: 'api-null', agent_permission_mode: null },
  ];
  // The Apply backstop reads any record, including one stageBulkField() would not build.
  for (const cowboyScope of ['related', 'project']) {
    const changes = { cowboyScope };
    assert.deepEqual(bulkCowboyBlockedTaskIds(changes, tasks, 'bypass'), []);
    assert.deepEqual(bulkPatchBody(changes), { cowboy_mode: cowboyScope },
      'the scope does not create a permission override');
  }
});

test('inherited Auto and Plan block enabling Cowboy while explicit Bypass still passes', () => {
  const tasks = [{ id: 'inherited' }, { id: 'override', agent_permission_mode: 'bypass' }];
  for (const projectDefault of ['auto', 'plan']) {
    for (const cowboyScope of ['related', 'project']) {
      assert.deepEqual(bulkCowboyBlockedTaskIds({ cowboyScope }, tasks, projectDefault), ['inherited']);
    }
  }
});

test('mixed inherited Bypass and explicit Plan or Auto reports only the blocking overrides', () => {
  const tasks = [
    { id: 'inherited', agentPermissionMode: null },
    { id: 'bypass', agent_permission_mode: 'bypass' },
    { id: 'plan', agentPermissionMode: 'plan' },
  ];
  assert.deepEqual(bulkCowboyBlockedTaskIds({ cowboyScope: 'related' }, tasks, 'bypass'), ['plan']);
  tasks.push({ id: 'auto', agent_permission_mode: 'auto' });
  assert.deepEqual(bulkCowboyBlockedTaskIds({ cowboyScope: 'project' }, tasks, 'bypass'), ['plan', 'auto']);
});

// (TPT9417) The API's task edit rule: a selected task whose canEdit (the API's can_edit) is false
// gets no Apply write and comes back as skipped; a task without the flag (an older API) is written.
test('splitBulkEditable separates view-only tasks in selection order', () => {
  const tasks = [
    { id: 'A', canEdit: true }, { id: 'X', canEdit: false }, { id: 'B' },
    { id: 'Y', canEdit: false }, { id: 'C', canEdit: null }, { canEdit: false }, null,
  ];
  assert.deepEqual(splitBulkEditable(tasks), { editable: ['A', 'B', 'C'], viewOnly: ['X', 'Y'] });
  assert.deepEqual(splitBulkEditable([]), { editable: [], viewOnly: [] });
  assert.deepEqual(splitBulkEditable(undefined), { editable: [], viewOnly: [] });
});

test('bulkApplyWrites leaves view-only tasks out of the Apply body and reports them as skipped', () => {
  const tasks = [{ id: 'A', canEdit: true }, { id: 'X', canEdit: false }, { id: 'B' }, { id: 'Y', canEdit: false }];
  const changes = stageBulkField({}, 'status', 'completed');
  const { writes, skipped } = bulkApplyWrites(changes, tasks);
  assert.deepEqual(writes, [{ id: 'A', body: { status: 'completed' } }, { id: 'B', body: { status: 'completed' } }]);
  assert.deepEqual(skipped, ['X', 'Y']);
  assert.ok(!writes.some(write => write.id === 'X' || write.id === 'Y'), 'a view-only task gets no PATCH');
});

test('bulkApplyWrites keeps the sprint, agent lock and model rules of bulkPatchBody for the editable tasks', () => {
  const tasks = [{ id: 'A', canEdit: true }, { id: 'L', canEdit: true }, { id: 'X', canEdit: false }];
  let changes = stageBulkAgent({}, 'claude');
  changes = stageBulkField(changes, 'status', 'on_fire');
  const { writes, skipped } = bulkApplyWrites(changes, tasks, { priority: 0, reassignable: new Set(['A']), model: 'claude-opus-5' });
  assert.deepEqual(writes, [
    { id: 'A', body: { sprint_id: null, status: 'on_fire', agent_assignee: 'claude', claude_model: 'claude-opus-5', claude_design_mode: false } },
    // Agent-locked (in progress, canceled): every staged field except the agent.
    { id: 'L', body: { sprint_id: null, status: 'on_fire' } },
  ]);
  assert.deepEqual(skipped, ['X']);
  // Every selected task view only: nothing to write.
  assert.deepEqual(bulkApplyWrites(changes, [{ id: 'X', canEdit: false }]), { writes: [], skipped: ['X'] });
  // An agent-only change on an agent-locked task has nothing to save, so no empty PATCH either.
  assert.deepEqual(bulkApplyWrites(stageBulkAgent({}, 'codex'), [{ id: 'L' }], { reassignable: new Set() }), { writes: [], skipped: [] });
});
