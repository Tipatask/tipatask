import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

// No top-level DOM access in agent-select.js (same pattern as utils.js/dep-graph.js) —
// safe to unit test the pure helpers under node --test without a browser environment.
const {
  PI_MAX_MODELS, PI_DEFAULT_PROVIDER, normalizePiProvider, normalizePiModels, computePiSaveRows, piCredentialsMissing,
  setPiProviders, resetPiProviders, getPiProviders, piProvidersLoaded, ensurePiProviders, piProviderMeta, normalizePiBaseUrl,
  fetchPiModels, filterPiModelSuggestions, piCatalogDisplayId,
  getAgentDisplayLabel, loadAgents, FALLBACK_AGENTS,
  stripPiModelPrefix, applyPiModelPrefix, buildPiRowState, orderPiModelsForSave, addPiModelIssue, buildAgentCardRows,
  buildDetailLines,
} = await import('./agent-select.js');
const { t } = await import('./i18n.js');
const { createRequire } = await import('node:module');

// (TPT191) The provider registry normally arrives from GET /api/pi/providers. Seed the same
// payload shape, in registry order, so every test below runs against a loaded registry.
const REGISTRY = [
  { id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', keyRequired: true, supportsBaseUrl: false },
  { id: 'deepseek', label: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', keyRequired: true, supportsBaseUrl: false },
  { id: 'anthropic', label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', keyRequired: true, supportsBaseUrl: false },
  { id: 'google-vertex', label: 'Google Vertex AI', envKey: 'GOOGLE_CLOUD_API_KEY', keyRequired: false, supportsBaseUrl: false },
  { id: 'custom', label: 'Custom endpoint', envKey: 'TIPATASK_PI_CUSTOM_API_KEY', keyRequired: false, supportsBaseUrl: true },
];
setPiProviders(REGISTRY);

test('getAgentDisplayLabel uses canonical id metadata regardless of selected/default agent', () => {
  const labels = { claude: 'Claude Code', codex: 'Codex', pi: 'Other Model' };
  assert.equal(getAgentDisplayLabel('claude', labels), 'Claude Code');
  assert.equal(getAgentDisplayLabel('codex', labels), 'Codex');
  assert.equal(getAgentDisplayLabel('pi', labels), 'Other Model');
});

test('getAgentDisplayLabel falls back to registry status metadata and safe built-ins', () => {
  assert.equal(getAgentDisplayLabel('claude', {}, [{ id: 'claude', label: 'Claude Code' }]), 'Claude Code');
  assert.equal(getAgentDisplayLabel('claude'), 'Claude Code');
  assert.equal(getAgentDisplayLabel('codex'), 'Codex');
  assert.equal(getAgentDisplayLabel('pi'), 'Other Model');
});

// ── normalizePiModels() ──────────────────────────────────────────────────────

test('normalizePiModels seeds a single blank row from empty/absent input', () => {
  assert.deepEqual(normalizePiModels(undefined), [{ model: '', apiKey: '' }]);
  assert.deepEqual(normalizePiModels({}), [{ model: '', apiKey: '' }]);
});

test('normalizePiModels accepts the legacy piModel/piApiKey scalar pair', () => {
  assert.deepEqual(normalizePiModels({ piModel: 'm1', piApiKey: 'k1' }), [{ model: 'm1', apiKey: 'k1' }]);
});

test('normalizePiModels accepts a piModels array of objects or bare id strings', () => {
  assert.deepEqual(
    normalizePiModels({ piModels: [{ model: 'm1', apiKey: 'k1' }, { model: 'm2', apiKey: 'k2' }] }),
    [{ model: 'm1', apiKey: 'k1' }, { model: 'm2', apiKey: 'k2' }]
  );
  assert.deepEqual(normalizePiModels({ piModels: ['m1', 'm2'] }), [{ model: 'm1', apiKey: '' }, { model: 'm2', apiKey: '' }]);
});

test('normalizePiModels caps at PI_MAX_MODELS', () => {
  assert.equal(PI_MAX_MODELS, 8);
  const piModels = Array.from({ length: 12 }, (_, i) => ({ model: `m${i}`, apiKey: `k${i}` }));
  const rows = normalizePiModels({ piModels });
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[7], { model: 'm7', apiKey: 'k7' });
});

test('normalizePiModels never aliases the caller-supplied row objects', () => {
  const input = [{ model: 'm1', apiKey: 'k1' }];
  const rows = normalizePiModels({ piModels: input });
  rows[0].model = 'mutated';
  assert.equal(input[0].model, 'm1', 'mutating the result must not mutate the caller input');
});

// ── piCredentialsMissing() ───────────────────────────────────────────────────

test('piCredentialsMissing is false when pi is not enabled, regardless of rows', () => {
  assert.equal(piCredentialsMissing({ availableAgents: ['claude'], piModels: [{ model: '', apiKey: '' }] }), false);
});

test('piCredentialsMissing legacy scalar pair: matches pre-C1121 behavior', () => {
  assert.equal(piCredentialsMissing({ availableAgents: ['pi'], piModel: 'm', piApiKey: 'k' }), false);
  assert.equal(piCredentialsMissing({ availableAgents: ['pi'], piModel: 'm', piApiKey: '' }), true);
  assert.equal(piCredentialsMissing({ availableAgents: ['pi'], piModel: '', piApiKey: '' }), true);
});

test('piCredentialsMissing piModels array: false only when every row is complete', () => {
  assert.equal(
    piCredentialsMissing({ availableAgents: ['pi'], piModels: [{ model: 'm1', apiKey: 'k1' }, { model: 'm2', apiKey: 'k2' }] }),
    false
  );
  assert.equal(
    piCredentialsMissing({ availableAgents: ['pi'], piModels: [{ model: 'm1', apiKey: 'k1' }, { model: '', apiKey: 'k2' }] }),
    true
  );
  assert.equal(piCredentialsMissing({ availableAgents: ['pi'], piModels: [] }), true);
});

test('piCredentialsMissing rejects duplicate model ids (case/whitespace insensitive)', () => {
  assert.equal(
    piCredentialsMissing({ availableAgents: ['pi'], piModels: [{ model: 'openrouter/x/m', apiKey: 'k1' }, { model: ' OpenRouter/X/M ', apiKey: 'k2' }] }),
    true
  );
});

// ── loadAgents() ─────────────────────────────────────────────────────────────

// loadAgents() reads window.electronAPI at call time — stub the global per test.
async function withWindow(win, fn) {
  const had = 'window' in globalThis;
  const prev = globalThis.window;
  globalThis.window = win;
  try { return await fn(); } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
}
const DETECTED = [{ id: 'claude', label: 'Claude Code', available: true }];

test('loadAgents returns the Electron IPC result and forwards force', async () => {
  const seen = [];
  const win = { electronAPI: { setupGetAvailableAgents: async (force) => { seen.push(force); return DETECTED; } } };
  await withWindow(win, async () => {
    assert.equal(await loadAgents(), DETECTED);
    assert.equal(await loadAgents({ force: true }), DETECTED);
  });
  assert.deepEqual(seen, [false, true]);
});

test('loadAgents falls back to FALLBACK_AGENTS when the IPC call throws', async () => {
  const win = { electronAPI: { setupGetAvailableAgents: async () => { throw new Error('ipc down'); } } };
  await withWindow(win, async () => assert.equal(await loadAgents({ force: true }), FALLBACK_AGENTS));
});

test('loadAgents never runs browserFallback when the IPC bridge exists, even on an empty result', async () => {
  let called = false;
  const win = { electronAPI: { setupGetAvailableAgents: async () => [] } };
  await withWindow(win, async () => {
    assert.equal(await loadAgents({ browserFallback: async () => { called = true; return DETECTED; } }), FALLBACK_AGENTS);
  });
  assert.equal(called, false);
});

test('loadAgents without an IPC bridge and without browserFallback returns FALLBACK_AGENTS', async () => {
  await withWindow({}, async () => assert.equal(await loadAgents(), FALLBACK_AGENTS));
});

test('loadAgents uses browserFallback when the IPC bridge is absent', async () => {
  await withWindow({}, async () => {
    assert.equal(await loadAgents({ browserFallback: async () => DETECTED }), DETECTED);
  });
});

test('loadAgents falls back to FALLBACK_AGENTS when browserFallback throws or yields nothing usable', async () => {
  await withWindow({}, async () => {
    assert.equal(await loadAgents({ browserFallback: async () => { throw new Error('offline'); } }), FALLBACK_AGENTS);
    assert.equal(await loadAgents({ browserFallback: async () => null }), FALLBACK_AGENTS);
    assert.equal(await loadAgents({ browserFallback: async () => [] }), FALLBACK_AGENTS);
  });
});

// ── (TPT163) per-row provider ────────────────────────────────────────────────

test('normalizePiModels keeps a known non-default provider and drops the default/unknown one', () => {
  assert.deepEqual(
    normalizePiModels({ piModels: [
      { model: 'deepseek-v4-flash', apiKey: 'k1', provider: 'deepseek' },
      { model: 'a/b', apiKey: 'k2', provider: 'openrouter' },
      { model: 'c/d', apiKey: 'k3', provider: 'bogus' },
    ] }),
    [
      { model: 'deepseek-v4-flash', apiKey: 'k1', provider: 'deepseek' },
      { model: 'a/b', apiKey: 'k2' },
      { model: 'c/d', apiKey: 'k3' },
    ],
  );
  assert.equal(normalizePiProvider(undefined), PI_DEFAULT_PROVIDER);
});

test('a slash-less model id with a key is not a credentials problem', () => {
  assert.equal(piCredentialsMissing({ availableAgents: ['pi'], piModels: [{ model: 'deepseek-flash', apiKey: 'k', provider: 'deepseek' }] }), false);
});

// computePiSaveRows is the one persistence filter both the create wizard and setup-modal use.
test('computePiSaveRows keeps provider only on a known non-default row, trims, and drops incomplete rows', () => {
  assert.deepEqual(
    computePiSaveRows([
      { model: '  deepseek-v4-flash ', apiKey: ' sk-ds ', provider: 'deepseek' },
      { model: 'a/b', apiKey: 'k2', provider: 'openrouter' },
      { model: 'c/d', apiKey: 'k3', provider: 'bogus' },
      { model: 'e/f', apiKey: 'k4' },
      { model: '', apiKey: 'x', provider: 'deepseek' },
      { model: 'g', apiKey: '', provider: 'deepseek' },
    ]),
    // (TPT172) OpenRouter rows are stored WITH the openrouter/ prefix; a DeepSeek id stays verbatim.
    [
      { model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' },
      { model: 'openrouter/a/b', apiKey: 'k2' },
      { model: 'openrouter/c/d', apiKey: 'k3' },
      { model: 'openrouter/e/f', apiKey: 'k4' },
    ],
  );
  assert.deepEqual(computePiSaveRows(undefined), []);
});

test('credential-safe Pi rows remain editable without plaintext key prefill', () => {
  const row = { model: 'deepseek-flash', provider: 'deepseek', hasApiKey: true,
    apiKeyAction: 'preserve', credentialRef: { model: 'deepseek-flash', provider: 'deepseek' } };
  const working = normalizePiModels({ piModels: [row] });
  assert.equal(piCredentialsMissing({ availableAgents: ['pi'], piModels: working }), false);
  assert.deepEqual(computePiSaveRows(working), [{ ...row, apiKey: '' }]);
  assert.equal(piCredentialsMissing({ availableAgents: ['pi'], piModels: [{ ...row, apiKeyAction: 'clear', hasApiKey: false }] }), true);
  assert.ok(t('agentSelect.savedKeyKept'));
  assert.ok(t('agentSelect.clearSavedKey'));
});

test('the provider hint copy exists in both locales', async () => {
  const { t, setLocale } = await import('./i18n.js');
  for (const locale of ['en', 'uk']) {
    setLocale(locale);
    const text = t('agentSelect.providerHint');
    assert.notEqual(text, 'agentSelect.providerHint', `${locale} table is missing agentSelect.providerHint`);
    assert.match(text, /openrouter\//);
  }
  setLocale('en');
});

// ── (TPT172) openrouter/ prefix: shown stripped, stored exactly once ─────────

test('applyPiModelPrefix adds openrouter/ to a bare OpenRouter id', () => {
  assert.equal(applyPiModelPrefix('anthropic/claude-sonnet-4.5', 'openrouter'), 'openrouter/anthropic/claude-sonnet-4.5');
  assert.equal(applyPiModelPrefix('  anthropic/claude-sonnet-4.5  '), 'openrouter/anthropic/claude-sonnet-4.5', 'no provider = OpenRouter, and trims');
  assert.equal(applyPiModelPrefix('', 'openrouter'), '', 'a blank id must never become a bare "openrouter/"');
  assert.equal(applyPiModelPrefix(undefined), '');
});

test('applyPiModelPrefix never doubles an already-prefixed id', () => {
  const once = applyPiModelPrefix('openrouter/anthropic/claude-sonnet-4.5', 'openrouter');
  assert.equal(once, 'openrouter/anthropic/claude-sonnet-4.5');
  assert.equal(applyPiModelPrefix(once, 'openrouter'), once, 'applying twice is a no-op');
  assert.equal(applyPiModelPrefix('OpenRouter/anthropic/x'), 'openrouter/anthropic/x', 'the prefix itself is case-normalized, not repeated');
});

test('prefix helpers are no-ops for a non-OpenRouter provider', () => {
  assert.equal(applyPiModelPrefix('deepseek-chat', 'deepseek'), 'deepseek-chat');
  assert.equal(applyPiModelPrefix('openrouter/x', 'deepseek'), 'openrouter/x', 'a deepseek id is stored verbatim');
  assert.equal(stripPiModelPrefix('openrouter/x', 'deepseek'), 'openrouter/x');
  assert.equal(stripPiModelPrefix('deepseek-chat', 'deepseek'), 'deepseek-chat');
});

test('stripPiModelPrefix is the display inverse, idempotent, and keeps OpenRouter\'s own openrouter/* ids intact', () => {
  assert.equal(stripPiModelPrefix('openrouter/anthropic/claude-sonnet-4.5'), 'anthropic/claude-sonnet-4.5');
  assert.equal(stripPiModelPrefix('anthropic/claude-sonnet-4.5'), 'anthropic/claude-sonnet-4.5');
  assert.equal(stripPiModelPrefix(stripPiModelPrefix('openrouter/anthropic/x')), 'anthropic/x');
  // Stored `openrouter/openrouter/auto` must survive a strip → apply round-trip, not collapse to `openrouter/auto`.
  const stored = 'openrouter/openrouter/auto';
  assert.equal(stripPiModelPrefix(stored), stored);
  assert.equal(applyPiModelPrefix(stripPiModelPrefix(stored)), stored);
});

test('normalizePiModels shows an OpenRouter row without its prefix and leaves other providers alone', () => {
  assert.deepEqual(
    normalizePiModels({ piModels: [
      { model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'k1' },
      { model: 'deepseek-chat', apiKey: 'k2', provider: 'deepseek' },
      'openrouter/openai/gpt-4o',
    ] }),
    [
      { model: 'anthropic/claude-sonnet-4.5', apiKey: 'k1' },
      { model: 'deepseek-chat', apiKey: 'k2', provider: 'deepseek' },
      { model: 'openai/gpt-4o', apiKey: '' },
    ],
  );
  assert.deepEqual(
    normalizePiModels({ piModel: 'openrouter/moonshotai/kimi-k3', piApiKey: 'k' }),
    [{ model: 'moonshotai/kimi-k3', apiKey: 'k' }],
    'the legacy scalar pair is stripped for display too',
  );
});

test('computePiSaveRows stores openrouter/anthropic/claude-sonnet-4.5 exactly once, whichever form was typed', () => {
  const want = [{ model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'k' }];
  assert.deepEqual(computePiSaveRows([{ model: 'anthropic/claude-sonnet-4.5', apiKey: 'k' }]), want, 'typed without the prefix');
  assert.deepEqual(computePiSaveRows([{ model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'k' }]), want, 'typed with the prefix');
  assert.deepEqual(computePiSaveRows(computePiSaveRows([{ model: 'anthropic/claude-sonnet-4.5', apiKey: 'k' }])), want, 'a second pass (emit → save) never doubles it');
});

test('a stored OpenRouter row round-trips through the picker unchanged', () => {
  for (const model of ['openrouter/anthropic/claude-sonnet-4.5', 'openrouter/openrouter/auto']) {
    const stored = { model, apiKey: 'sk-or' };
    assert.deepEqual(computePiSaveRows(normalizePiModels({ piModels: [stored] })), [stored], model);
  }
  const ds = { model: 'deepseek-chat', apiKey: 'sk-ds', provider: 'deepseek' };
  assert.deepEqual(computePiSaveRows(normalizePiModels({ piModels: [ds] })), [ds]);
});

test('a legacy unprefixed OpenRouter row is canonicalized to the prefixed id on save', () => {
  assert.deepEqual(computePiSaveRows(normalizePiModels({ piModels: [{ model: 'anthropic/x', apiKey: 'k' }] })), [{ model: 'openrouter/anthropic/x', apiKey: 'k' }]);
});

// ── (TPT172) choosing the default row ────────────────────────────────────────

const _rows = () => [
  { model: 'a', apiKey: 'k1', enabled: true },
  { model: 'b', apiKey: 'k2', enabled: true },
  { model: 'c', apiKey: 'k3', enabled: true },
];

test('orderPiModelsForSave puts the chosen default row first and keeps the rest in display order', () => {
  assert.deepEqual(orderPiModelsForSave(_rows(), 2).map((r) => r.model), ['c', 'a', 'b']);
  assert.deepEqual(orderPiModelsForSave(_rows(), 1).map((r) => r.model), ['b', 'a', 'c']);
  assert.deepEqual(orderPiModelsForSave(_rows(), 0).map((r) => r.model), ['a', 'b', 'c']);
});

test('orderPiModelsForSave omits unchecked rows, and a checked default still leads', () => {
  const rows = _rows();
  rows[0].enabled = false;
  assert.deepEqual(orderPiModelsForSave(rows, 2).map((r) => r.model), ['c', 'b']);
  assert.deepEqual(orderPiModelsForSave(rows, 0).map((r) => r.model), ['b', 'c'], 'an unchecked "default" cannot lead');
});

test('orderPiModelsForSave keeps display order for a missing/out-of-range default', () => {
  assert.deepEqual(orderPiModelsForSave(_rows(), -1).map((r) => r.model), ['a', 'b', 'c']);
  assert.deepEqual(orderPiModelsForSave(_rows(), 9).map((r) => r.model), ['a', 'b', 'c']);
  assert.deepEqual(orderPiModelsForSave(undefined, 0), []);
});

test('the default row survives the emit → save pipeline as PI_MODELS[0]', () => {
  const saved = computePiSaveRows(orderPiModelsForSave(_rows(), 2));
  assert.equal(saved[0].model, 'openrouter/c', 'row 0 is what the server reads as the default');
});

test('buildPiRowState seeds every stored row enabled with row 0 as default, and nothing for an empty config', () => {
  const s = buildPiRowState({ piModels: [{ model: 'openrouter/x/y', apiKey: 'k' }, { model: 'deepseek-chat', apiKey: 'k2', provider: 'deepseek' }] });
  assert.deepEqual(s.rows, [
    { model: 'x/y', apiKey: 'k', enabled: true },
    { model: 'deepseek-chat', apiKey: 'k2', provider: 'deepseek', enabled: true },
  ]);
  assert.equal(s.defaultIdx, 0);
  for (const empty of [undefined, {}, { piModels: [] }, { piModels: [{ model: '', apiKey: '' }] }]) {
    assert.deepEqual(buildPiRowState(empty), { rows: [], defaultIdx: -1 });
  }
});

// ── (TPT172) Pi models as top-level cards ────────────────────────────────────

const AGENTS = [
  { id: 'claude', label: 'Claude Code', available: true },
  { id: 'codex', label: 'Codex', available: true },
  { id: 'pi', label: 'Pi', available: true },
];
const _cards = (over = {}) => buildAgentCardRows({
  agents: AGENTS, piModels: [], enabledIds: ['claude'], defaultId: 'claude', piDefaultIdx: -1, single: false, ...over,
});

test('buildAgentCardRows lists each Pi model as its own top-level card, labeled provider · model', () => {
  const cards = _cards({
    piModels: [
      { model: 'deepseek-chat', apiKey: 'k', provider: 'deepseek', enabled: true },
      { model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'k2', enabled: true },
    ],
    enabledIds: ['claude', 'pi'], defaultId: 'pi', piDefaultIdx: 0,
  });
  assert.deepEqual(cards.map((c) => c.kind), ['agent', 'agent', 'pi-model', 'pi-model']);
  const [, , ds, or] = cards;
  assert.equal(ds.name, 'DeepSeek · deepseek-chat');
  assert.equal(ds.providerLabel, 'DeepSeek');
  assert.equal(ds.modelText, 'deepseek-chat');
  assert.equal(or.name, 'OpenRouter · anthropic/claude-sonnet-4.5', 'an OpenRouter card shows the id without its prefix');
  assert.equal(or.storedModel, 'openrouter/anthropic/claude-sonnet-4.5', 'while the stored id keeps it');
  assert.equal(ds.hasCheckbox && ds.hasRadio, true);
});

test('every Pi card keeps the literal agent id "pi", and only the default row is the default', () => {
  const piModels = [
    { model: 'a', apiKey: 'k', enabled: true },
    { model: 'b', apiKey: 'k', enabled: true },
    { model: 'c', apiKey: 'k', provider: 'deepseek', enabled: true },
  ];
  const pi = _cards({ piModels, enabledIds: ['pi'], defaultId: 'pi', piDefaultIdx: 1 }).filter((c) => c.kind === 'pi-model');
  assert.deepEqual(pi.map((c) => c.id), ['pi', 'pi', 'pi'], 'TASK_AGENT must stay claude|codex|pi, never a per-model id');
  assert.deepEqual(pi.map((c) => c.piIdx), [0, 1, 2]);
  assert.deepEqual(pi.map((c) => c.isDefault), [false, true, false]);
  // Default is claude: no Pi card is the default, whatever piDefaultIdx says.
  const other = _cards({ piModels, enabledIds: ['claude', 'pi'], defaultId: 'claude', piDefaultIdx: 1 }).filter((c) => c.kind === 'pi-model');
  assert.deepEqual(other.map((c) => c.isDefault), [false, false, false]);
});

test('an unchecked Pi row is a card that is not enabled', () => {
  const pi = _cards({
    piModels: [{ model: 'a', apiKey: 'k', enabled: true }, { model: 'b', apiKey: 'k', enabled: false }],
    enabledIds: ['pi'], defaultId: 'pi', piDefaultIdx: 0,
  }).filter((c) => c.kind === 'pi-model');
  assert.deepEqual(pi.map((c) => c.enabled), [true, false]);
});

test('buildAgentCardRows renders one placeholder Pi card, with no checkbox or radio, when no model is configured', () => {
  const pi = _cards().filter((c) => c.id === 'pi');
  assert.equal(pi.length, 1);
  assert.equal(pi[0].kind, 'pi-empty');
  assert.equal(pi[0].hasCheckbox, false);
  assert.equal(pi[0].hasRadio, false);
  assert.equal(pi[0].name, t('agentSelect.namePi'));
});

test('buildAgentCardRows renders exactly one unavailable Pi card (not one per row) when the pi CLI is missing', () => {
  const agents = AGENTS.map((a) => (a.id === 'pi' ? { ...a, available: false, reason: 'not found' } : a));
  const pi = buildAgentCardRows({
    agents, piModels: [{ model: 'a', apiKey: 'k', enabled: true }, { model: 'b', apiKey: 'k', enabled: true }],
    enabledIds: ['claude'], defaultId: 'claude', piDefaultIdx: 0, single: false,
  }).filter((c) => c.id === 'pi');
  assert.equal(pi.length, 1);
  assert.equal(pi[0].kind, 'pi-unavailable');
  assert.equal(pi[0].available, false);
  assert.equal(pi[0].reason, 'not found');
});

test('single-installed-agent mode drops the checkboxes on Pi model cards but keeps the Default radio', () => {
  const agents = [{ id: 'pi', label: 'Pi', available: true }];
  const [card] = buildAgentCardRows({
    agents, piModels: [{ model: 'a', apiKey: 'k', enabled: true }], enabledIds: ['pi'], defaultId: 'pi', piDefaultIdx: 0, single: true,
  });
  assert.equal(card.hasCheckbox, false);
  assert.equal(card.hasRadio, true);
  assert.equal(card.isDefault, true);
});

// ── (TPT172) the Add/Edit form's validation ──────────────────────────────────

test('addPiModelIssue rejects a blank model, a blank key, and a duplicate — judged on the SAVED id', () => {
  const rows = [{ model: 'anthropic/x', apiKey: 'k' }, { model: 'deepseek-chat', apiKey: 'k', provider: 'deepseek' }];
  assert.equal(addPiModelIssue(rows, { model: '  ', apiKey: 'k' }), t('agentSelect.errModelRequired'));
  assert.equal(addPiModelIssue(rows, { model: 'm', apiKey: ' ' }), t('agentSelect.errApiKeyRequired'));
  // Typed with the prefix, but the stored row is `openrouter/anthropic/x` — the same model.
  assert.equal(addPiModelIssue(rows, { model: 'openrouter/anthropic/x', apiKey: 'k' }), t('agentSelect.duplicateModel'));
  assert.equal(addPiModelIssue(rows, { model: 'ANTHROPIC/X', apiKey: 'k' }), t('agentSelect.duplicateModel'), 'case-insensitive, like sanitizePiModels');
  assert.equal(addPiModelIssue(rows, { model: 'deepseek-chat', apiKey: 'k', provider: 'deepseek' }), t('agentSelect.duplicateModel'));
  assert.equal(addPiModelIssue(rows, { model: 'deepseek-chat', apiKey: 'k' }), null, 'same text under OpenRouter is a different stored id (openrouter/deepseek-chat)');
  assert.equal(addPiModelIssue(rows, { model: 'openai/gpt-4o', apiKey: 'k' }), null);
});

test('addPiModelIssue in edit mode ignores the row being edited', () => {
  const rows = [{ model: 'anthropic/x', apiKey: 'k' }, { model: 'openai/y', apiKey: 'k' }];
  assert.equal(addPiModelIssue(rows, { model: 'anthropic/x', apiKey: 'k2' }, 0), null, 'saving a row over itself is fine');
  assert.equal(addPiModelIssue(rows, { model: 'anthropic/x', apiKey: 'k2' }, 1), t('agentSelect.duplicateModel'));
});

test('piCredentialsMissing de-dupes on the stored id, so a bare and a prefixed id collide', () => {
  assert.equal(
    piCredentialsMissing({ availableAgents: ['pi'], piModels: [{ model: 'anthropic/x', apiKey: 'k1' }, { model: 'openrouter/anthropic/x', apiKey: 'k2' }] }),
    true,
  );
  assert.equal(
    piCredentialsMissing({ availableAgents: ['pi'], piModels: [{ model: 'anthropic/x', apiKey: 'k1' }, { model: 'anthropic/x', apiKey: 'k2', provider: 'deepseek' }] }),
    false,
    'the same text under a different provider is a different stored id',
  );
});

test('the OpenRouter model placeholder no longer asks for the prefix', () => {
  const src = fs.readFileSync(new URL('./agent-select.js', import.meta.url), 'utf8');
  assert.match(src, /openrouter: \{[^}]*modelPlaceholder: 'anthropic\/claude-sonnet-4\.5'/);
});

test('the new Add/Edit form copy exists in both locales', async () => {
  const { t: tt, setLocale } = await import('./i18n.js');
  const keys = ['noModelsYet', 'editModelName', 'removeModelName', 'saveModel', 'errModelRequired', 'errApiKeyRequired', 'uncheckedNotSaved'];
  for (const locale of ['en', 'uk']) {
    setLocale(locale);
    for (const k of keys) assert.notEqual(tt(`agentSelect.${k}`, { name: 'X' }), `agentSelect.${k}`, `${locale} is missing agentSelect.${k}`);
  }
  setLocale('en');
});

// ── (TPT191) any provider: registry, keyless rows, custom endpoint rows ──────

const OLLAMA = { model: 'llama3.1:8b', apiKey: '', provider: 'custom', baseUrl: 'http://localhost:11434/v1' };

test('computePiSaveRows keeps a keyless row only for a provider whose keyRequired is false', () => {
  assert.deepEqual(
    computePiSaveRows([
      { model: 'gemini-2.5-pro', apiKey: '', provider: 'google-vertex' },
      { model: 'claude-sonnet-4-5', apiKey: '', provider: 'anthropic' },
      { model: 'claude-opus-4-5', apiKey: ' sk-ant ', provider: 'anthropic' },
      { model: 'x/y', apiKey: '' },
    ]),
    [
      { model: 'gemini-2.5-pro', apiKey: '', provider: 'google-vertex' },
      { model: 'claude-opus-4-5', apiKey: 'sk-ant', provider: 'anthropic' },
    ],
  );
});

test('computePiSaveRows keeps a keyless custom row with its baseUrl, keyed too, and passes api through', () => {
  assert.deepEqual(
    computePiSaveRows([
      { ...OLLAMA, baseUrl: '  http://localhost:11434/v1  ' },
      { model: 'gpt-4o-mini', apiKey: 'sk-gw', provider: 'custom', baseUrl: 'https://gw.example.com/v1', api: 'openai-responses' },
    ]),
    [
      OLLAMA,
      { model: 'gpt-4o-mini', apiKey: 'sk-gw', provider: 'custom', baseUrl: 'https://gw.example.com/v1', api: 'openai-responses' },
    ],
  );
});

test('computePiSaveRows drops a custom row with a missing or unusable baseUrl; other rows survive', () => {
  const bad = ['', '   ', 'localhost:11434', 'ftp://host/v1', 'http://', 'http://user:pw@host/v1', 'https://tok@host/v1', 'not a url'];
  const rows = bad.map((baseUrl, i) => ({ model: `m${i}`, apiKey: '', provider: 'custom', baseUrl }));
  assert.deepEqual(computePiSaveRows([...rows, { model: 'no-url', apiKey: 'k', provider: 'custom' }, OLLAMA]), [OLLAMA]);
  for (const u of bad) assert.equal(normalizePiBaseUrl(u), '', u);
  assert.equal(normalizePiBaseUrl(' https://gw.example.com/v1 '), 'https://gw.example.com/v1');
});

test('baseUrl/api never ride along on a non-custom row, and a custom id is stored verbatim', () => {
  assert.deepEqual(
    computePiSaveRows([{ model: 'a/b', apiKey: 'k', baseUrl: 'http://x/v1', api: 'openai-responses' }]),
    [{ model: 'openrouter/a/b', apiKey: 'k' }],
  );
  assert.deepEqual(
    computePiSaveRows([{ model: 'claude', apiKey: 'k', provider: 'anthropic', baseUrl: 'http://x/v1' }]),
    [{ model: 'claude', apiKey: 'k', provider: 'anthropic' }],
  );
  assert.equal(computePiSaveRows([{ ...OLLAMA, model: 'openrouter/x' }])[0].model, 'openrouter/x');
});

test('a custom row round-trips through the picker with baseUrl and api intact', () => {
  const stored = { model: 'gpt-4o-mini', apiKey: '', provider: 'custom', baseUrl: 'https://gw.example.com/v1', api: 'openai-responses' };
  assert.deepEqual(normalizePiModels({ piModels: [stored, OLLAMA] }), [stored, OLLAMA]);
  assert.deepEqual(computePiSaveRows(normalizePiModels({ piModels: [stored, OLLAMA] })), [stored, OLLAMA]);
  assert.deepEqual(buildPiRowState({ piModels: [OLLAMA] }).rows, [{ ...OLLAMA, enabled: true }]);
});

test('addPiModelIssue: key optional for a keyless provider, baseUrl required for a custom endpoint', () => {
  assert.equal(addPiModelIssue([], { model: 'gemini', apiKey: '', provider: 'google-vertex' }), null);
  assert.equal(addPiModelIssue([], { model: 'claude', apiKey: '', provider: 'anthropic' }), t('agentSelect.errApiKeyRequired'));
  assert.equal(addPiModelIssue([], OLLAMA), null);
  assert.equal(addPiModelIssue([], { ...OLLAMA, baseUrl: '' }), t('agentSelect.errBaseUrlRequired'));
  assert.equal(addPiModelIssue([], { ...OLLAMA, baseUrl: 'http://u:p@localhost/v1' }), t('agentSelect.errBaseUrlRequired'));
  assert.equal(addPiModelIssue([OLLAMA], OLLAMA), t('agentSelect.duplicateModel'));
});

test('piCredentialsMissing accepts keyless and custom rows, rejects a custom row without a baseUrl', () => {
  const on = (piModels) => piCredentialsMissing({ availableAgents: ['pi'], piModels });
  assert.equal(on([OLLAMA, { model: 'gemini', apiKey: '', provider: 'google-vertex' }, { model: 'claude', apiKey: 'k', provider: 'anthropic' }]), false);
  assert.equal(on([{ ...OLLAMA, baseUrl: '' }]), true);
  assert.equal(on([{ model: 'claude', apiKey: '', provider: 'anthropic' }]), true);
});

test('cards are labeled from the registry, for any provider', () => {
  const pi = _cards({
    piModels: [{ model: 'claude-sonnet-4-5', apiKey: 'k', provider: 'anthropic', enabled: true }, { ...OLLAMA, enabled: true }],
    enabledIds: ['pi'], defaultId: 'pi', piDefaultIdx: 0,
  }).filter((c) => c.kind === 'pi-model');
  assert.deepEqual(pi.map((c) => c.name), ['Anthropic · claude-sonnet-4-5', 'Custom endpoint · llama3.1:8b']);
});

test('piProviderMeta carries keyRequired/supportsBaseUrl and placeholders; generic placeholders otherwise', () => {
  assert.equal(piProviderMeta('custom').keyRequired, false);
  assert.equal(piProviderMeta('custom').supportsBaseUrl, true);
  assert.equal(piProviderMeta('anthropic').keyRequired, true);
  assert.equal(piProviderMeta(undefined).id, 'openrouter');
  assert.equal(piProviderMeta('openrouter').modelPlaceholder, 'anthropic/claude-sonnet-4.5');
  assert.equal(typeof piProviderMeta('anthropic').modelPlaceholder, 'string');
});

// An anthropic row, a keyless custom Ollama row and an openrouter row are what every host
// (create wizard, setup-modal, agents-modal) hands to the server after computePiSaveRows();
// the server's own sanitizePiModels() must persist all three exactly as emitted.
test('anthropic, keyless custom Ollama and openrouter rows survive computePiSaveRows() → server sanitizePiModels()', () => {
  const { sanitizePiModels } = createRequire(import.meta.url)('../server/project-config.js');
  const typed = [
    { model: 'claude-sonnet-4-5', apiKey: 'sk-ant', provider: 'anthropic' },
    { model: 'llama3.1:8b', apiKey: '', provider: 'custom', baseUrl: 'http://localhost:11434/v1' },
    { model: 'anthropic/claude-sonnet-4.5', apiKey: 'sk-or' },
  ];
  const saved = computePiSaveRows(typed);
  assert.deepEqual(saved, [
    { model: 'claude-sonnet-4-5', apiKey: 'sk-ant', provider: 'anthropic' },
    OLLAMA,
    { model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or' },
  ]);
  assert.deepEqual(sanitizePiModels(saved), saved);
  assert.deepEqual(computePiSaveRows(normalizePiModels({ piModels: sanitizePiModels(saved) })), saved, 're-open + untouched save');
});

test('filterPiModelSuggestions: substring match, prefix hits first, capped, quiet on an exact sole match', () => {
  const ids = ['openai/gpt-5', 'anthropic/claude-sonnet-4.5', 'anthropic/claude-opus-4.5', 'claude-local'];
  assert.deepEqual(filterPiModelSuggestions(ids, ''), ids);
  assert.deepEqual(filterPiModelSuggestions(ids, 'CLAUDE'), ['claude-local', 'anthropic/claude-sonnet-4.5', 'anthropic/claude-opus-4.5']);
  assert.deepEqual(filterPiModelSuggestions(ids, 'claude', 2), ['claude-local', 'anthropic/claude-sonnet-4.5']);
  assert.deepEqual(filterPiModelSuggestions(ids, 'openai/gpt-5'), []);
  assert.deepEqual(filterPiModelSuggestions(ids, 'nope'), []);
  assert.deepEqual(filterPiModelSuggestions(undefined, 'x'), []);
});

test('piCatalogDisplayId keeps OpenRouter\'s own openrouter/* ids round-trippable', () => {
  assert.equal(piCatalogDisplayId('anthropic/claude-sonnet-4.5', 'openrouter'), 'anthropic/claude-sonnet-4.5');
  const held = piCatalogDisplayId('openrouter/auto', 'openrouter');
  assert.equal(held, 'openrouter/openrouter/auto');
  assert.deepEqual(computePiSaveRows([{ model: held, apiKey: 'k' }]), [{ model: 'openrouter/openrouter/auto', apiKey: 'k' }]);
  assert.equal(piCatalogDisplayId('openrouter/x', 'custom'), 'openrouter/x');
});

// Registry loading — these reset the module registry, so they run last and restore it.
async function withFetch(impl, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = prev; }
}

test('before the registry loads an unknown stored provider is kept verbatim, not collapsed to OpenRouter', () => {
  resetPiProviders();
  try {
    assert.equal(piProvidersLoaded(), false);
    assert.deepEqual(getPiProviders().map((p) => p.id), ['openrouter', 'custom']);
    assert.equal(normalizePiProvider('anthropic'), 'anthropic');
    assert.equal(normalizePiProvider('Not A Provider!'), 'openrouter');
    const stored = { model: 'claude-sonnet-4-5', apiKey: 'k', provider: 'anthropic' };
    assert.deepEqual(computePiSaveRows(normalizePiModels({ piModels: [stored] })), [stored], 'no openrouter/ prefix sneaks in');
    assert.deepEqual(computePiSaveRows([OLLAMA]), [OLLAMA], 'the fallback registry already knows the keyless custom endpoint');
  } finally { setPiProviders(REGISTRY); }
  assert.equal(normalizePiProvider('bogus'), 'openrouter', 'once loaded, an unknown id is an OpenRouter row (as server-side)');
});

test('ensurePiProviders loads GET /api/pi/providers once; a failure keeps the fallback and retries later', async () => {
  resetPiProviders();
  try {
    const urls = [];
    await withFetch(async () => { throw new Error('offline'); }, async () => {
      assert.deepEqual((await ensurePiProviders()).map((p) => p.id), ['openrouter', 'custom']);
      assert.equal(piProvidersLoaded(), false);
    });
    await withFetch(async (url) => { urls.push(url); return { ok: true, json: async () => REGISTRY }; }, async () => {
      const [a, b] = await Promise.all([ensurePiProviders(), ensurePiProviders()]);
      assert.equal(a, b);
      await ensurePiProviders();
      assert.deepEqual(a.map((p) => p.id), REGISTRY.map((p) => p.id));
      assert.equal(Object.hasOwn(a[0], 'envKey'), false, 'only the fields the UI uses are kept');
    });
    assert.deepEqual(urls, ['/api/pi/providers'], 'single-flight, then cached');
    assert.equal(setPiProviders([{ id: 'deepseek', label: 'DeepSeek' }]), false, 'a payload without the default provider is rejected');
    assert.equal(setPiProviders('nope'), false);
  } finally { setPiProviders(REGISTRY); }
});

test('fetchPiModels asks for one provider\'s catalog, returns ids, and degrades to []', async () => {
  const urls = [];
  await withFetch(async (url) => { urls.push(url); return { ok: true, json: async () => [{ id: 'claude-a', name: 'claude-a' }, { id: ' ' }, { id: 'claude-b' }] }; }, async () => {
    assert.deepEqual(await fetchPiModels('anthropic'), ['claude-a', 'claude-b']);
    assert.deepEqual(await fetchPiModels('anthropic'), ['claude-a', 'claude-b']);
  });
  assert.deepEqual(urls, ['/api/pi/models?provider=anthropic'], 'cached per provider');
  await withFetch(async () => { throw new Error('offline'); }, async () => assert.deepEqual(await fetchPiModels('deepseek'), []));
  await withFetch(async () => ({ ok: false, json: async () => ({}) }), async () => assert.deepEqual(await fetchPiModels('deepseek'), []));
});

test('the any-provider form copy exists in both locales', async () => {
  const { t: tt, setLocale } = await import('./i18n.js');
  for (const locale of ['en', 'uk']) {
    setLocale(locale);
    for (const k of ['apiKeyOptional', 'baseUrl', 'errBaseUrlRequired']) assert.notEqual(tt(`agentSelect.${k}`), `agentSelect.${k}`, `${locale} is missing agentSelect.${k}`);
  }
  setLocale('en');
});

// ── (TPT567) detection diagnostics under the reason text ─────────────────────────────────────
const SELECT_SRC = fs.readFileSync(new URL('./agent-select.js', import.meta.url), 'utf8');

test('buildAgentCardRows carries `detail` on an unavailable claude/codex row and on the single unavailable Pi card', () => {
  const detail = { bin: 'C:\\Users\\Anton M\\AppData\\Roaming\\npm\\claude.cmd', exit: 1, output: '{"loggedIn":false}' };
  const rows = buildAgentCardRows({
    agents: [
      { id: 'claude', label: 'Claude Code', available: false, reason: 'Claude is not logged in', detail },
      { id: 'codex', label: 'Codex', available: true },
      { id: 'pi', label: 'Pi', available: false, reason: 'Pi CLI not found', detail: { bin: null, exit: null, output: '' } },
    ],
    piModels: [{ model: 'x', apiKey: 'k' }],
  });
  assert.deepEqual(rows.find((r) => r.id === 'claude').detail, detail);
  assert.equal(rows.find((r) => r.id === 'codex').detail, null, 'a positive never carries detail');
  const pi = rows.filter((r) => r.id === 'pi');
  assert.equal(pi.length, 1);
  assert.equal(pi[0].kind, 'pi-unavailable');
  assert.deepEqual(pi[0].detail, { bin: null, exit: null, output: '' });
});

test('buildDetailLines folds the exit code into the output line and renders nothing for an empty/absent detail', () => {
  assert.deepEqual(buildDetailLines(undefined), { bin: '', output: '' });
  assert.deepEqual(buildDetailLines(null), { bin: '', output: '' });
  assert.deepEqual(buildDetailLines({ bin: null, exit: null, output: '' }), { bin: '', output: '' });
  assert.deepEqual(buildDetailLines({ bin: '/usr/local/bin/codex', exit: 1, output: ' Not logged in\n' }),
    { bin: '/usr/local/bin/codex', output: 'exit=1 · Not logged in' });
  assert.deepEqual(buildDetailLines({ bin: 'C:\\x\\claude.cmd', exit: null, output: 'ENOENT' }),
    { bin: 'C:\\x\\claude.cmd', output: 'ENOENT' });
  assert.deepEqual(buildDetailLines({ bin: null, exit: 0, output: '{"loggedIn":false}' }),
    { bin: '', output: 'exit=0 · {"loggedIn":false}' });
});

// _cardHtml()/_renderEmpty() are private DOM builders — pin at the source level that BOTH the
// card grid and the all-unavailable list route the detail through the shared _detailHtml().
test('both the card grid and the all-unavailable list render the detail block, escaped', () => {
  assert.match(SELECT_SRC, /const detailHtml = !d\.available \? _detailHtml\(d\.detail\) : ''/);
  assert.match(SELECT_SRC, /const diagHtml = _detailHtml\(detail\);/);
  const fn = SELECT_SRC.slice(SELECT_SRC.indexOf('function _detailHtml('), SELECT_SRC.indexOf('\n}', SELECT_SRC.indexOf('function _detailHtml(')));
  assert.match(fn, /_esc\(bin\)/);
  assert.match(fn, /_esc\(output\)/);
  assert.match(fn, /setup-modal-agent-detail-bin/);
  assert.match(fn, /setup-modal-agent-detail-output/);
});

test('the detail labels exist in both locales', async () => {
  const { t: tt, setLocale } = await import('./i18n.js');
  for (const locale of ['en', 'uk']) {
    setLocale(locale);
    for (const k of ['detailLauncher', 'detailProbe']) assert.notEqual(tt(`agentSelect.${k}`), `agentSelect.${k}`, `${locale} is missing agentSelect.${k}`);
  }
  setLocale('en');
});
