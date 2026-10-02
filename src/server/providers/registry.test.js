'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../config');
const registry = require('./registry');
const { applyModelSelection } = require('./dispatch');
const modelRegistry = require('../task-agent/model-registry');
const { getTaskAgent } = require('../task-agent');

// Provider-list tests are about selection/configuration, not machine CLI state. Keep
// synchronous cache peeks warm so no test starts a real login-shell lookup in background.
for (const id of ['claude', 'codex', 'pi']) {
  const agent = getTaskAgent(id);
  agent._detectResult = { id, label: agent.label, available: true };
  agent._detectTs = Date.now();
}

function makeProjectDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-registry-'));
  if (cfg !== undefined) {
    fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  }
  return dir;
}

test('isValidSelection accepts every SELECTABLE_PROVIDERS entry with a model from its allowlist', () => {
  // CODEX_MODEL (the configured *default*) can be '' on a machine with no project-level
  // override (config.js falls back to '' when unset) — so this checks the modelsKey
  // allowlist itself, not the possibly-empty default, for every selectable provider.
  for (const providerId of registry.SELECTABLE_PROVIDERS) {
    const meta = registry.PROVIDER_META[providerId];
    const models = config[meta.modelsKey] || [];
    assert.ok(models.length > 0, `expected a non-empty ${meta.modelsKey} allowlist for ${providerId}`);
    assert.ok(
      registry.isValidSelection(registry.formatSelection(providerId, models[0])),
      `expected ${providerId}:${models[0]} to be a valid selection`,
    );
  }
});

test('isValidSelection rejects an unknown provider', () => {
  assert.equal(registry.isValidSelection('unknown-provider:some-model'), false);
});

test('isValidSelection rejects a model outside the provider\'s allowlist', () => {
  assert.equal(registry.isValidSelection('claude:not-a-real-model'), false);
  assert.equal(registry.isValidSelection('gemini:not-a-real-model'), false);
  assert.equal(registry.isValidSelection('pi:not-a-real-model'), false);
});

test('clearAllProviderSessionIds nulls every provider session id field', () => {
  const session = {
    claudeSessionId: 'a', codexSessionId: 'b', geminiSessionId: 'c', piSessionId: 'd',
  };
  registry.clearAllProviderSessionIds(session);
  assert.equal(session.claudeSessionId, null);
  assert.equal(session.codexSessionId, null);
  assert.equal(session.geminiSessionId, null);
  assert.equal(session.piSessionId, null);
});

test('resolveProviderModel prefers session.selectedModel over the provider default', () => {
  const session = { selectedModel: 'custom-model' };
  assert.equal(registry.resolveProviderModel(session, 'gemini', config), 'custom-model');
});

test('resolveProviderModel falls back to the provider default when no selection is set', () => {
  const session = { selectedModel: null };
  assert.equal(registry.resolveProviderModel(session, 'pi', config), config.PI_MODEL);
});

// ── getProviderDefaultModel (C1115 — agent-selector modal Pi caption) ──

test('getProviderDefaultModel returns the global default for the bare config singleton', () => {
  assert.equal(registry.getProviderDefaultModel('pi'), config.PI_MODEL);
  assert.equal(registry.getProviderDefaultModel('claude'), config.CLAUDE_MODEL);
});

test('getProviderDefaultModel returns a project-custom PI_MODEL via configForProject', () => {
  const custom = 'openrouter/x-ai/grok-4';
  const dir = makeProjectDir({ PI_MODEL: custom });
  try {
    const view = registry.configForProject(dir);
    assert.equal(registry.getProviderDefaultModel('pi', view), custom);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getProviderDefaultModel returns empty string for an unknown provider', () => {
  assert.equal(registry.getProviderDefaultModel('unknown-provider'), '');
});

test('listObjectiveProviders defaultModel for pi matches getProviderDefaultModel (single code path)', () => {
  const custom = 'openrouter/x-ai/grok-4';
  const dir = makeProjectDir({ PI_MODEL: custom });
  try {
    const view = registry.configForProject(dir);
    const entry = registry.listObjectiveProviders(view).find((p) => p.id === 'pi');
    assert.equal(entry.defaultModel, registry.getProviderDefaultModel('pi', view));
    assert.equal(entry.defaultModel, custom);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── configForProject (C1101 — per-project PI_MODEL) ──

test('configForProject returns the config singleton by identity when there is nothing to override', () => {
  assert.strictEqual(registry.configForProject(''), config);
  assert.strictEqual(registry.configForProject(null), config);

  const noConfigDir = makeProjectDir();
  try {
    assert.strictEqual(registry.configForProject(noConfigDir), config, 'no .tipatask/config.json at all');
  } finally {
    fs.rmSync(noConfigDir, { recursive: true, force: true });
  }

  const noPiModelDir = makeProjectDir({ API_PROJECT_ID: '42' });
  const blankPiModelDir = makeProjectDir({ PI_MODEL: '  ' });
  const sameAsGlobalDir = makeProjectDir({ PI_MODEL: config.PI_MODEL });
  try {
    assert.strictEqual(registry.configForProject(noPiModelDir), config, 'PI_MODEL absent');
    assert.strictEqual(registry.configForProject(blankPiModelDir), config, 'PI_MODEL blank/whitespace');
    assert.strictEqual(registry.configForProject(sameAsGlobalDir), config, 'PI_MODEL equal to the global default');
  } finally {
    fs.rmSync(noPiModelDir, { recursive: true, force: true });
    fs.rmSync(blankPiModelDir, { recursive: true, force: true });
    fs.rmSync(sameAsGlobalDir, { recursive: true, force: true });
  }
});

test('configForProject builds a view with a project-custom PI_MODEL unioned into PI_MODELS', () => {
  const custom = 'openrouter/x-ai/grok-4';
  const dir = makeProjectDir({ PI_MODEL: custom });
  try {
    const view = registry.configForProject(dir);
    assert.notStrictEqual(view, config);
    assert.strictEqual(view.PI_MODEL, custom);
    assert.ok(view.PI_MODELS.includes(custom));
    for (const m of config.PI_MODELS) assert.ok(view.PI_MODELS.includes(m), `global PI_MODELS entry ${m} preserved`);
    assert.ok(!config.PI_MODELS.includes(custom), 'global config.PI_MODELS left unmutated');

    // Inheritance intact — untouched fields fall through to the singleton.
    assert.strictEqual(view.CLAUDE_MODEL, config.CLAUDE_MODEL);
    assert.strictEqual(view.OBJECTIVE_PROVIDER, config.OBJECTIVE_PROVIDER);

    // Laziness guard — the *_BIN getters (login-shell probes) must not be materialized
    // as own properties by the view construction itself. Do not read view.PI_BIN here,
    // which would fire a real probe.
    assert.deepEqual(Object.getOwnPropertyNames(view).sort(), ['PI_MODEL', 'PI_MODELS']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configForProject is what makes a project-custom Pi model a valid selection', () => {
  const custom = 'openrouter/x-ai/grok-4';
  const dir = makeProjectDir({ PI_MODEL: custom });
  try {
    const view = registry.configForProject(dir);
    assert.equal(registry.isValidSelection('pi:' + custom, view), true);
    assert.equal(registry.isValidSelection('pi:' + custom), false, 'rejected against the global (non-project) view — the regression this covers');

    assert.equal(registry.currentSelection({ providerType: 'pi' }, view).model, custom);
    assert.equal(registry.resolveProviderModel({ selectedModel: null }, 'pi', view), custom);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── C1122: configuredModels (launch-time Pi model picker) ──

test('listObjectiveProviders: pi.configuredModels lists only the project\'s own PI_MODELS rows, never the global default list, never an apiKey; models is narrowed to the same set (C1136)', () => {
  const dir = makeProjectDir({
    PI_MODELS: [
      { model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or-row0' },
      { model: 'openrouter/openai/gpt-4o-mini', apiKey: 'sk-or-row1' },
    ],
  });
  try {
    const view = registry.configForProject(dir);
    const entry = registry.listObjectiveProviders(view).find((p) => p.id === 'pi');
    assert.deepEqual(entry.configuredModels, ['openrouter/anthropic/claude-sonnet-4.5', 'openrouter/openai/gpt-4o-mini']);
    // Global env-default models (config.PI_MODELS) must never leak into configuredModels —
    // those have no project-owned apiKey behind them. Neither test project row happens to
    // collide with a global default, so this is a real assertion, not a tautology.
    for (const m of config.PI_MODELS) assert.ok(!entry.configuredModels.includes(m), `global default ${m} must not appear in configuredModels`);
    assert.ok(!JSON.stringify(entry.configuredModels).includes('sk-or-'), 'apiKey must never appear in configuredModels');
    // (C1136) `models` — what the chat-model-selector actually offers — is now narrowed to
    // the SAME project-configured set as configuredModels, not unioned with the global
    // env-default list: a global default has no api key behind it for this project, so it
    // must never appear as an offerable option. `isValidSelection()` still reads the wider
    // cfg.PI_MODELS union (unchanged, back-compat for resume paths) — this is specifically
    // about what the dropdown renders.
    const modelValues = entry.models.map((m) => m.value);
    assert.deepEqual(modelValues, entry.configuredModels);
    for (const m of config.PI_MODELS) assert.ok(!modelValues.includes(m), `global default ${m} must not be offered as a model`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listObjectiveProviders: pi.configuredModels is [] for a project with no PI_MODELS array', () => {
  const dir = makeProjectDir({ API_PROJECT_ID: '42' });
  try {
    const view = registry.configForProject(dir);
    const entry = registry.listObjectiveProviders(view).find((p) => p.id === 'pi');
    assert.deepEqual(entry.configuredModels, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listObjectiveProviders: configuredModels is [] for every non-pi provider', () => {
  const entries = registry.listObjectiveProviders(config);
  for (const entry of entries) {
    if (entry.id === 'pi') continue;
    assert.deepEqual(entry.configuredModels, []);
  }
});

test('configForProject: PI_CONFIGURED_MODELS view field holds exactly the project\'s PI_MODELS ids', () => {
  const dir = makeProjectDir({
    PI_MODELS: [{ model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or-row0' }],
  });
  try {
    const view = registry.configForProject(dir);
    assert.deepEqual(view.PI_CONFIGURED_MODELS, ['openrouter/anthropic/claude-sonnet-4.5']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (TPT163) A model id with no "vendor/" slash (a non-OpenRouter row) is a first-class id:
// configured, valid as a selection, and offered by the chat selector's pi entry.
test('configForProject: a bare slash-less deepseek row is configured, valid, and offered', () => {
  const dir = makeProjectDir({
    AVAILABLE_AGENTS: 'pi',
    PI_MODELS: [{ model: 'deepseek-flash', apiKey: 'sk-ds', provider: 'deepseek' }],
  });
  try {
    const view = registry.configForProject(dir);
    assert.deepEqual(view.PI_CONFIGURED_MODELS, ['deepseek-flash']);
    assert.equal(registry.isValidSelection('pi:deepseek-flash', view), true);
    const pi = registry.listObjectiveProviders(view).find(p => p.id === 'pi');
    assert.deepEqual(pi.models, [{ value: 'deepseek-flash' }]);
    assert.deepEqual(pi.allowedModels, ['deepseek-flash']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configForProject: a present-but-empty AVAILABLE_AGENTS is owned by the view as []; an absent key falls through to the global', () => {
  const saved = config.AVAILABLE_AGENTS;
  config.AVAILABLE_AGENTS = ['codex'];
  const empty = makeProjectDir({ AVAILABLE_AGENTS: '' });
  const absent = makeProjectDir({ projectName: 'X' });
  try {
    assert.deepEqual(registry.configForProject(empty).AVAILABLE_AGENTS, []);
    assert.deepEqual(registry.configForProject(absent).AVAILABLE_AGENTS, ['codex']);
  } finally {
    config.AVAILABLE_AGENTS = saved;
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(absent, { recursive: true, force: true });
  }
});

// ── C1136: project-scoped AVAILABLE_AGENTS + enabled/selectable + legacy Pi compat ──

test('configForProject: AVAILABLE_AGENTS CSV on disk becomes a parsed array on the view; global config.AVAILABLE_AGENTS is left unmutated', () => {
  const dir = makeProjectDir({ AVAILABLE_AGENTS: ' claude , pi ' });
  try {
    const view = registry.configForProject(dir);
    assert.deepEqual(view.AVAILABLE_AGENTS, ['claude', 'pi']);
    assert.notDeepEqual(config.AVAILABLE_AGENTS, ['claude', 'pi']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configForProject: sets PI_CONFIGURED_MODELS from the legacy flat PI_MODEL+OPENROUTER_API_KEY pair (pre-C1121 project)', () => {
  const dir = makeProjectDir({ PI_MODEL: 'openrouter/moonshotai/kimi-k3', OPENROUTER_API_KEY: 'sk-or-legacy' });
  try {
    const view = registry.configForProject(dir);
    assert.deepEqual(view.PI_CONFIGURED_MODELS, ['openrouter/moonshotai/kimi-k3']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configForProject: a legacy PI_MODEL with no OPENROUTER_API_KEY is NOT configured', () => {
  const dir = makeProjectDir({ PI_MODEL: 'openrouter/moonshotai/kimi-k3' });
  try {
    const view = registry.configForProject(dir);
    assert.equal(view.PI_CONFIGURED_MODELS, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configForProject: PI_CONFIGURED_MODELS is set for the startup project too, even though its PI_MODEL equals the global default (not gated on "differs from global")', () => {
  const dir = makeProjectDir({ PI_MODEL: config.PI_MODEL, OPENROUTER_API_KEY: 'sk-or-startup' });
  try {
    const view = registry.configForProject(dir);
    assert.deepEqual(view.PI_CONFIGURED_MODELS, [config.PI_MODEL]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listObjectiveProviders: a provider absent from AVAILABLE_AGENTS is enabled=false, selectable=false, with a reason', () => {
  const dir = makeProjectDir({ AVAILABLE_AGENTS: 'claude' });
  try {
    const view = registry.configForProject(dir);
    const codex = registry.listObjectiveProviders(view).find((p) => p.id === 'codex');
    assert.equal(codex.enabled, false);
    assert.equal(codex.selectable, false);
    assert.match(codex.reason || '', /not enabled for this project/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listObjectiveProviders: an explicit AVAILABLE_AGENTS naming every provider enables every provider', () => {
  // NOT testing "absent AVAILABLE_AGENTS" here — this repo's own ai/todo/server/.env sets
  // AVAILABLE_AGENTS=claude,codex globally, so config.AVAILABLE_AGENTS (the fallback an
  // empty project override falls through to) is legitimately NOT empty in this environment.
  // A project-level AVAILABLE_AGENTS always fully overrides that global value when present
  // (configForProject), which is what this asserts hermetically regardless of ambient env.
  const dir = makeProjectDir({ AVAILABLE_AGENTS: 'claude,codex,gemini,pi' });
  try {
    const view = registry.configForProject(dir);
    for (const entry of registry.listObjectiveProviders(view)) assert.equal(entry.enabled, true, `${entry.id} should be enabled`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listObjectiveProviders: claude/codex/gemini models are never narrowed — only pi is', () => {
  const dir = makeProjectDir({ AVAILABLE_AGENTS: 'claude,codex,gemini' });
  try {
    const view = registry.configForProject(dir);
    const entries = registry.listObjectiveProviders(view);
    // gemini has no live probe (task-agent/index.js registers no gemini task-agent plugin) —
    // always the full static allowlist, unaffected by C1515.
    const gemini = entries.find((p) => p.id === 'gemini');
    assert.deepEqual(gemini.models.map((m) => m.value), view.GEMINI_MODELS || []);
    // (C1515) claude/codex now follow the live-registry ladder (offeredModelIds()) instead of
    // always the raw static list — "never narrowed" here means never cut down to a
    // project-scoped subset the way pi is, not "always exactly the static array". Assert
    // against the ladder function itself (independently covered with a seeded cache further
    // below) rather than the raw static list, so this test doesn't flake depending on whether
    // this machine's model registry cache happens to be warm.
    for (const id of ['claude', 'codex']) {
      const entry = entries.find((p) => p.id === id);
      assert.deepEqual(entry.models.map((m) => m.value), registry.offeredModelIds(id, view));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listVisibleObjectiveProviders: hides pi when neither AVAILABLE_AGENTS nor a configured model include it, alongside a selectable provider', () => {
  const dir = makeProjectDir({ AVAILABLE_AGENTS: 'claude' });
  try {
    const view = registry.configForProject(dir);
    const visible = registry.listVisibleObjectiveProviders(view);
    assert.ok(!visible.some((p) => p.id === 'pi'), 'pi must not appear — not in AVAILABLE_AGENTS and has no configured model');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listVisibleObjectiveProviders: rung 2 still surfaces an enabled-but-unconfigured provider (pi) rather than dropping it', () => {
  // pi allowed but unconfigured (no PI_MODELS, no legacy pair) — nothing is genuinely
  // selectable. Rung 2 requires an EXPLICIT AVAILABLE_AGENTS (unlike an empty allowlist,
  // which now returns [] instead of falling through to every provider's hardcoded static
  // list — see the TPT162 tests below) — this project named pi, so it still surfaces pi
  // disabled with its real reason instead of silently dropping the only agent it selected.
  const dir = makeProjectDir({ AVAILABLE_AGENTS: 'pi' });
  try {
    const view = registry.configForProject(dir);
    const visible = registry.listVisibleObjectiveProviders(view);
    assert.ok(visible.length > 0, 'an explicit single-provider allowlist must still surface that provider');
    assert.ok(visible.some((p) => p.id === 'pi'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── TPT162: Gemini opt-in + rung-3 removal ──
//
// claude/codex CLI *availability* is real machine state (base-agent.js peekDetect() serves a
// process-global per-agent singleton that ignores its `config` argument after the first call —
// see registry.js:155's liveModelIds() comment), so these tests assert on `enabled`/list
// membership only, never on `available` or `selectable` for claude/codex, to stay deterministic
// regardless of what's installed on the machine running them.

test('listObjectiveProviders: an empty AVAILABLE_AGENTS enables claude/codex/pi but NOT gemini (TPT162 — gemini is opt-in)', () => {
  // Can't use makeProjectDir({AVAILABLE_AGENTS: ''}) — readAvailableAgents() returns [] for
  // a blank string, configForProject() then skips the own-prop entirely (registry.js) and
  // falls through to the ambient config.AVAILABLE_AGENTS, which this repo's own
  // .tipatask/config.json seeds as "claude,codex,pi" (non-empty) before .env is even read.
  // Building the view directly (same house pattern as the C1515 tests below) is the only way
  // to hermetically exercise a genuinely empty allowlist.
  const cfg = Object.create(config);
  cfg.AVAILABLE_AGENTS = [];
  const entries = registry.listObjectiveProviders(cfg);
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  assert.equal(byId.claude.enabled, true);
  assert.equal(byId.codex.enabled, true);
  assert.equal(byId.pi.enabled, true);
  assert.equal(byId.gemini.enabled, false);
  assert.equal(byId.gemini.selectable, false);
  assert.match(byId.gemini.reason || '', byId.gemini.available ? /opt-in/ : /CLI not found/);
  assert.ok(!registry.listVisibleObjectiveProviders(cfg).some((p) => p.id === 'gemini'), 'the direct bug-report regression guard: gemini must never appear under an empty allowlist');
});

test('listObjectiveProviders/listVisibleObjectiveProviders: gemini appears when AVAILABLE_AGENTS names it explicitly (the documented escape hatch)', () => {
  const dir = makeProjectDir({ AVAILABLE_AGENTS: 'gemini' });
  try {
    const view = registry.configForProject(dir);
    const gemini = registry.listObjectiveProviders(view).find((p) => p.id === 'gemini');
    assert.equal(gemini.enabled, true);
    assert.deepEqual(gemini.models.map((m) => m.value), view.GEMINI_MODELS);
    const visible = registry.listVisibleObjectiveProviders(view);
    assert.deepEqual(visible.map((p) => p.id), ['gemini']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listVisibleObjectiveProviders: a Pi-only project shows only its own configured Other Model entries — never Gemini, never the global Pi defaults (TPT162)', () => {
  const dir = makeProjectDir({
    AVAILABLE_AGENTS: 'pi',
    PI_MODELS: [{ model: 'openrouter/moonshotai/kimi-k3', apiKey: 'sk-or-test' }],
  });
  try {
    const view = registry.configForProject(dir);
    const visible = registry.listVisibleObjectiveProviders(view);
    assert.deepEqual(visible.map((p) => p.id), ['pi']);
    const values = visible[0].models.map((m) => m.value);
    assert.deepEqual(values, ['openrouter/moonshotai/kimi-k3']);
    for (const m of config.PI_MODELS) assert.ok(!values.includes(m), `global default ${m} must not appear`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listVisibleObjectiveProviders: returns [] when AVAILABLE_AGENTS names nothing real (rung 3 removed, TPT162)', () => {
  // Pre-TPT162 this fell through to "the full unfiltered list" — every SELECTABLE_PROVIDERS
  // entry, including Gemini's and Pi's hardcoded config.js model lists. Consumers already
  // degrade safely on []: chat-ui.js buildModelSelectorHtml() renders no selector,
  // clampSelectionToProviders() returns its input unchanged, console-modal.js
  // _isPiProviderUsable() reports false.
  const dir = makeProjectDir({ AVAILABLE_AGENTS: 'not-a-real-agent' });
  try {
    const view = registry.configForProject(dir);
    assert.deepEqual(registry.listVisibleObjectiveProviders(view), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── applyModelSelection (providers/dispatch.js) ──

function makeSession(overrides = {}) {
  return {
    type: 'objective',
    providerType: 'claude',
    selectedModel: null,
    claudeSessionId: null,
    codexSessionId: null,
    geminiSessionId: null,
    piSessionId: null,
    messages: [],
    proc: null,
    _spawning: false,
    _providerSwitchPending: false,
    ...overrides,
  };
}

test('applyModelSelection is a no-op for specChat sessions', async () => {
  const session = makeSession({ type: 'specChat' });
  const result = await applyModelSelection(session, 'codex:' + config.CODEX_MODELS[0], { taskId: 't1' });
  assert.deepEqual(result, { changed: false });
  assert.equal(session.providerType, 'claude');
});

test('applyModelSelection refuses a provider that cannot enforce a task chat\'s tool profile', async () => {
  const session = makeSession({ type: 'taskChat', toolProfile: 'taskChat', providerType: 'claude', selectedModel: 'keep-me' });
  const result = await applyModelSelection(session, 'gemini:' + config.GEMINI_MODELS[0], { taskId: 'taskChat:TPT1' });
  assert.equal(result.error, 'provider-unavailable');
  assert.match(result.reason, /not available in this chat/);
  assert.equal(session.providerType, 'claude');
  assert.equal(session.selectedModel, 'keep-me');
  assert.equal(session._providerSwitchPending, false);
});

test('applyModelSelection leaves a task chat alone when no model is sent', async () => {
  const session = makeSession({ type: 'taskChat', toolProfile: 'taskChat' });
  assert.deepEqual(await applyModelSelection(session, undefined, { taskId: 'taskChat:TPT1' }), { changed: false });
});

test('applyModelSelection ignores an absent selection', async () => {
  const session = makeSession();
  assert.deepEqual(await applyModelSelection(session, null, { taskId: 't1' }), { changed: false });
  assert.deepEqual(await applyModelSelection(session, undefined, { taskId: 't1' }), { changed: false });
});

test('applyModelSelection ignores an invalid selection rather than erroring', async () => {
  const session = makeSession();
  const result = await applyModelSelection(session, 'not-a-real-provider:xyz', { taskId: 't1' });
  assert.deepEqual(result, { changed: false });
  assert.equal(session.providerType, 'claude');
});

test('applyModelSelection rejects when a turn is already spawning (Codex async image-localize window)', async () => {
  const session = makeSession({ _spawning: true });
  const result = await applyModelSelection(session, 'codex:' + config.CODEX_MODELS[0], { taskId: 't1' });
  assert.deepEqual(result, { error: 'turn-in-progress' });
});

test('applyModelSelection on a provider change nulls ALL provider session ids and preserves session.messages', async () => {
  const session = makeSession({
    claudeSessionId: 'claude-sid',
    codexSessionId: 'codex-sid',
    geminiSessionId: 'gemini-sid',
    piSessionId: 'pi-sid',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
  });
  const result = await applyModelSelection(session, 'codex:' + config.CODEX_MODELS[0], { taskId: 't1' });

  assert.equal(result.changed, true);
  assert.equal(result.providerChanged, true);
  assert.equal(session.providerType, 'codex');
  assert.equal(session.claudeSessionId, null);
  assert.equal(session.codexSessionId, null);
  assert.equal(session.geminiSessionId, null);
  assert.equal(session.piSessionId, null);
  assert.equal(session._providerSwitchPending, true);
  assert.equal(session.messages.length, 2, 'a provider switch must never touch conversation history');
});

test('applyModelSelection on a Claude model-only change keeps claudeSessionId (OBJECTIVE_MODEL_SWITCH_RESUME default true)', async () => {
  const session = makeSession({ claudeSessionId: 'claude-sid' });
  const otherModel = config.CLAUDE_MODELS.find(m => m !== config.CLAUDE_MODEL) || config.CLAUDE_MODELS[0];
  const result = await applyModelSelection(session, 'claude:' + otherModel, { taskId: 't1' });

  assert.equal(result.changed, true);
  assert.equal(result.providerChanged, false);
  assert.equal(session.selectedModel, otherModel);
  assert.equal(session.claudeSessionId, 'claude-sid', '--resume with a different --model keeps prior context (verified live, C1029)');
  assert.equal(session._providerSwitchPending, false);
});

// The last hop of "the picked model reaches the next turn": applyModelSelection() stores the pick
// on the session, and resolveClaudeModel() is what both Claude spawn sites pass as `--model`.
test('the model applyModelSelection stores is the exact --model the next Claude turn resolves', async () => {
  const { resolveClaudeModel } = require('../claude-session');
  const session = makeSession({ claudeSessionId: 'claude-sid' });
  const picked = config.CLAUDE_MODELS.find(m => m !== config.CLAUDE_MODEL) || config.CLAUDE_MODELS[0];

  assert.equal(resolveClaudeModel(session), config.CLAUDE_MODEL, 'before any pick: the configured default');
  const result = await applyModelSelection(session, 'claude:' + picked, { taskId: 't1' });
  assert.equal(result.changed, true);
  assert.equal(resolveClaudeModel(session), picked, 'after the pick: the next turn spawns with the picked model');
});

test('a rejected selection leaves the next Claude turn on the model it already had', async () => {
  const { resolveClaudeModel } = require('../claude-session');
  const session = makeSession({ selectedModel: config.CLAUDE_MODELS[1] || config.CLAUDE_MODELS[0] });
  const before = resolveClaudeModel(session);
  const result = await applyModelSelection(session, 'claude:not-a-real-model', { taskId: 't1' });
  assert.equal(result.changed, false);
  assert.equal(resolveClaudeModel(session), before);
});

// ── C1136: applyModelSelection enforces project-scoped configuration, not just CLI availability ──

test('applyModelSelection rejects a provider that is valid/available globally but absent from THIS project\'s AVAILABLE_AGENTS', async () => {
  const dir = makeProjectDir({ AVAILABLE_AGENTS: 'claude' });
  try {
    const session = makeSession({ projectPath: dir });
    const result = await applyModelSelection(session, 'codex:' + config.CODEX_MODELS[0], { taskId: 't1' });
    assert.equal(result.error, 'provider-unavailable');
    assert.equal(session.providerType, 'claude', 'a rejected selection must not mutate the session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyModelSelection rejects a pi model that is not one of the project\'s own configured rows, even though it passes the global PI_MODELS allowlist', async () => {
  const dir = makeProjectDir({ PI_MODELS: [{ model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or-row0' }] });
  try {
    const session = makeSession({ projectPath: dir });
    const globalDefault = config.PI_MODELS.find((m) => m !== 'openrouter/anthropic/claude-sonnet-4.5') || config.PI_MODEL;
    const result = await applyModelSelection(session, 'pi:' + globalDefault, { taskId: 't1' });
    assert.equal(result.error, 'provider-unavailable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyModelSelection rejects gemini on a project with no AVAILABLE_AGENTS naming it (TPT162 — proves the opt-in rule reaches the real per-turn gate, not just isValidSelection)', async () => {
  const dir = makeProjectDir({ API_PROJECT_ID: '42' });
  try {
    const session = makeSession({ projectPath: dir });
    const result = await applyModelSelection(session, 'gemini:' + config.GEMINI_MODELS[0], { taskId: 't1' });
    assert.equal(result.error, 'provider-unavailable');
    assert.equal(session.providerType, 'claude', 'a rejected selection must not mutate the session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── C1515: live model registry ladder (claude/codex only — offeredModelIds/allowedModelIds) ──
//
// modelRegistry's cache (task-agent/model-registry.js) is process-global, keyed by agent id
// only — not by project — so every test below isolates the disk mirror with its own temp
// USER_DATA_ROOT view (never the real config singleton's, which in dev points at this repo
// checkout — see config.js SERVER_ROOT fallback) and calls _resetForTest() before AND after,
// so a seeded 'claude'/'codex' entry never leaks into another test in this file.

function makeModelRegistryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tt-model-registry-'));
}

function makeModelRegistryCfg(dir) {
  const view = Object.create(config);
  view.USER_DATA_ROOT = dir;
  return view;
}

test('offeredModelIds/isValidSelection: a live registry entry replaces (not unions) the static list for claude, and widens what validates', async () => {
  const dir = makeModelRegistryDir();
  modelRegistry._resetForTest();
  try {
    const cfg = makeModelRegistryCfg(dir);
    const stubAgent = { id: 'claude', probeModels: async () => [{ id: 'claude-opus-9-new', label: 'Opus 9 (new)', isLatest: true }], getModelProbeKey: () => 'test-key' };
    await modelRegistry.resolveModels(stubAgent, cfg);

    assert.deepEqual(registry.offeredModelIds('claude', cfg), ['claude-opus-9-new'], 'the ladder shows the live id, not a union with the static list');
    const entry = registry.listObjectiveProviders(cfg).find((p) => p.id === 'claude');
    assert.deepEqual(entry.models.map((m) => m.value), ['claude-opus-9-new']);

    assert.ok(registry.isValidSelection('claude:claude-opus-9-new', cfg), 'a live-only id validates');
    assert.ok(registry.isValidSelection('claude:' + config.CLAUDE_MODELS[0], cfg), 'a static id still validates even once live data exists (allowedModelIds is a superset)');
    assert.ok(entry.allowedModels.includes('claude-opus-9-new') && entry.allowedModels.includes(config.CLAUDE_MODELS[0]), 'entry.allowedModels carries the same superset applyModelSelection() enforces');
  } finally {
    modelRegistry._resetForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('offeredModelIds: falls back to the static list when the registry cache is cold (no probe ever run)', () => {
  const dir = makeModelRegistryDir();
  modelRegistry._resetForTest();
  try {
    const cfg = makeModelRegistryCfg(dir);
    assert.deepEqual(registry.offeredModelIds('claude', cfg), cfg.CLAUDE_MODELS);
    assert.deepEqual(registry.offeredModelIds('codex', cfg), cfg.CODEX_MODELS);
    const entry = registry.listObjectiveProviders(cfg).find((p) => p.id === 'claude');
    assert.deepEqual(entry.models.map((m) => m.value), cfg.CLAUDE_MODELS, 'never an empty dropdown on a cold cache');
  } finally {
    modelRegistry._resetForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('allowedModelIds/isValidSelection: pi is NOT routed through the claude/codex ladder — stays the unchanged wide cfg.PI_MODELS check', () => {
  const custom = 'openrouter/x-ai/grok-4';
  const dir = makeModelRegistryDir();
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify({ PI_MODEL: custom }), 'utf8');
  modelRegistry._resetForTest();
  try {
    const view = registry.configForProject(dir);
    // Same assertion the pre-existing C1101 test makes (line ~154 above) — C1515 must not
    // have changed this: a legacy PI_MODEL-only project (no api key, so NOT in
    // PI_CONFIGURED_MODELS/offeredModelIds) still validates via the wide cfg.PI_MODELS union.
    assert.equal(registry.isValidSelection('pi:' + custom, view), true);
  } finally {
    modelRegistry._resetForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listObjectiveProviders: pi.allowedModels stays narrowed to configuredModels — an alias for the C1136 boundary, not a wider union', () => {
  const dir = makeModelRegistryDir();
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify({
    PI_MODELS: [{ model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or-row0' }],
  }), 'utf8');
  modelRegistry._resetForTest();
  try {
    const view = registry.configForProject(dir);
    const entry = registry.listObjectiveProviders(view).find((p) => p.id === 'pi');
    assert.deepEqual(entry.allowedModels, entry.models.map((m) => m.value));
    assert.deepEqual(entry.allowedModels, entry.configuredModels);
    for (const m of config.PI_MODELS) assert.ok(!entry.allowedModels.includes(m), `global default ${m} must not be allowed via allowedModels`);
  } finally {
    modelRegistry._resetForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listObjectiveProviders: gemini is unaffected by a seeded claude/codex live cache (no probe exists for it)', async () => {
  const dir = makeModelRegistryDir();
  modelRegistry._resetForTest();
  try {
    const cfg = makeModelRegistryCfg(dir);
    const stubAgent = { id: 'codex', probeModels: async () => [{ id: 'gpt-9-new', label: 'gpt-9-new', isLatest: true }], getModelProbeKey: () => 'test-key' };
    await modelRegistry.resolveModels(stubAgent, cfg);
    const entries = registry.listObjectiveProviders(cfg);
    const codex = entries.find((p) => p.id === 'codex');
    const gemini = entries.find((p) => p.id === 'gemini');
    assert.deepEqual(codex.models.map((m) => m.value), ['gpt-9-new']);
    assert.deepEqual(gemini.models.map((m) => m.value), cfg.GEMINI_MODELS, 'gemini has no probe — always the static list');
  } finally {
    modelRegistry._resetForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyModelSelection accepts a live-only claude model id end-to-end (the registry ladder reaches the real per-turn gate, not just isValidSelection)', async () => {
  const dir = makeModelRegistryDir();
  modelRegistry._resetForTest();
  try {
    // Seed the model-registry cache. Its `_cache` Map (task-agent/model-registry.js) is keyed
    // by agent id only — not by which `cfg` object was passed — so it's inherently
    // process-global; only the disk-mirror WRITE this triggers needs isolating, via the temp
    // USER_DATA_ROOT view. Any later read (real config singleton included) sees this same
    // seeded entry.
    const seedCfg = makeModelRegistryCfg(dir);
    const stubAgent = { id: 'claude', probeModels: async () => [{ id: 'claude-opus-9-new', label: 'Opus 9 (new)', isLatest: true }], getModelProbeKey: () => 'test-key' };
    await modelRegistry.resolveModels(stubAgent, seedCfg);

    // A plain project dir with no .tipatask/config.json override — configForProject()
    // resolves this to the real `config` singleton by identity, exactly like a real session
    // with nothing project-custom set.
    const projectDir = makeProjectDir();
    try {
      const session = makeSession({ projectPath: projectDir });
      const result = await applyModelSelection(session, 'claude:claude-opus-9-new', { taskId: 't1' });
      assert.equal(result.changed, true, `expected the live-only model to be accepted, got ${JSON.stringify(result)}`);
      assert.equal(session.selectedModel, 'claude-opus-9-new');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  } finally {
    modelRegistry._resetForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
