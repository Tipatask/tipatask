import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hasBulkChanges, stagedBulkFields, stageBulkField, stageBulkAgent, stageBulkModel, stageBulkDesignMode, resolveBulkAgentModel,
  bulkPatchBody, bulkCowboyBlockedTaskIds, BULK_MODEL_FIELDS,
} from './bulk-changes.js';
import { CODEX_MODELS, CLAUDE_MODELS, normalizeAgentModels } from './constants.js';

// (TPT9159) The bulk bar's staged-edit record and the PATCH body Apply builds from it.

test('an empty record has nothing to apply', () => {
  assert.equal(hasBulkChanges({}), false);
  assert.equal(hasBulkChanges(null), false);
  assert.deepEqual(stagedBulkFields({}), []);
  assert.deepEqual(bulkPatchBody({}, {}), {});
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

test('Cowboy scopes stage independently, normalize legacy values and preserve other edits', () => {
  const original = { status: 'on_fire', assignee: 7, agent: 'claude', claudeDesignMode: true };
  for (const [value, scope] of [['disabled', 'disabled'], ['related', 'related'], ['project', 'project'], [true, 'project'], [false, 'disabled']]) {
    const changes = stageBulkField(original, 'cowboyScope', value);
    assert.equal(hasBulkChanges({ cowboyScope: changes.cowboyScope }), true);
    assert.deepEqual(bulkPatchBody(changes), {
      status: 'on_fire', assignee: 7, agent_assignee: 'claude', claude_design_mode: true, cowboy_mode: scope,
    });
    assert.deepEqual(bulkPatchBody(changes, { reassign: false }), { status: 'on_fire', assignee: 7, cowboy_mode: scope });
    assert.deepEqual(stageBulkField(changes, 'cowboyScope', ''), original);
  }
  assert.deepEqual(bulkPatchBody(original), { status: 'on_fire', assignee: 7, agent_assignee: 'claude', claude_design_mode: true });
  assert.deepEqual(original, { status: 'on_fire', assignee: 7, agent: 'claude', claudeDesignMode: true });
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
