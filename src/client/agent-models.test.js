import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';

// (C1505) Client half of the C1504 live per-agent model registry: normalizeAgentModels() (pure
// shape bridge), ensureAgentModels() (single-flight fetch + cache), agentModelOptions()/
// agentModelsSignature() (sync readers), and modelLabel()'s live-cache lookup.
const {
  CLAUDE_MODELS, CODEX_MODELS,
  normalizeAgentModels, ensureAgentModels, agentModelOptions, agentModelsSignature,
  modelLabel, _resetAgentModelsForTest,
} = await import('./constants.js');

const originalFetch = globalThis.fetch;

beforeEach(() => {
  _resetAgentModelsForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(impl) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return impl(url, opts);
  };
  return calls;
}

function jsonResponse(body, { ok = true } = {}) {
  return { ok, json: async () => body };
}

// ── normalizeAgentModels (pure) ──

test('normalizeAgentModels: maps id to value and carries isLatest', () => {
  const out = normalizeAgentModels('claude', { models: [{ id: 'claude-opus-5', label: 'Opus 5', isLatest: true }] });
  assert.deepEqual(out, [{ value: 'claude-opus-5', label: 'Opus 5', isLatest: true }]);
});

test('normalizeAgentModels: static label wins over a raw-id server label (fallback source case)', () => {
  const staticEntry = CLAUDE_MODELS.find(m => m.value === 'claude-opus-4-8');
  assert.ok(staticEntry, 'fixture assumption: claude-opus-4-8 is in the static list');
  const out = normalizeAgentModels('claude', { models: [{ id: 'claude-opus-4-8', label: 'claude-opus-4-8', isLatest: false }] });
  assert.equal(out[0].label, staticEntry.label);
});

test('normalizeAgentModels: static Codex description survives onto the live entry', () => {
  const staticEntry = CODEX_MODELS.find(m => m.value === 'gpt-5.6-sol');
  assert.ok(staticEntry?.description);
  const out = normalizeAgentModels('codex', { models: [{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', isLatest: true }] });
  assert.equal(out[0].description, staticEntry.description);
});

test('normalizeAgentModels: unknown id keeps the server label, no description', () => {
  const out = normalizeAgentModels('claude', { models: [{ id: 'claude-mythos-1', label: 'Mythos 1', isLatest: false }] });
  assert.deepEqual(out, [{ value: 'claude-mythos-1', label: 'Mythos 1', isLatest: false }]);
});

test('normalizeAgentModels: empty/missing models falls back to the static list unchanged', () => {
  assert.deepEqual(normalizeAgentModels('claude', { models: [] }), CLAUDE_MODELS);
  assert.deepEqual(normalizeAgentModels('codex', {}), CODEX_MODELS);
});

test('normalizeAgentModels: unknown agent id (e.g. pi) returns []', () => {
  assert.deepEqual(normalizeAgentModels('pi', { models: [{ id: 'x', label: 'X' }] }), []);
});

// ── agentModelOptions before any fetch ──

test('agentModelOptions: returns the static fallback before ensureAgentModels() ever resolves', () => {
  assert.deepEqual(agentModelOptions('claude'), CLAUDE_MODELS);
  assert.deepEqual(agentModelOptions('codex'), CODEX_MODELS);
});

// ── ensureAgentModels ──

test('ensureAgentModels: success populates claude/codex, never pi', async () => {
  stubFetch(() => jsonResponse({
    agents: {
      claude: { agent: 'claude', models: [{ id: 'claude-opus-5', label: 'Opus 5', isLatest: true }], source: 'probe' },
      codex: { agent: 'codex', models: [{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', isLatest: true }], source: 'probe' },
      pi: { agent: 'pi', models: [], source: 'fallback' },
    },
  }));
  await ensureAgentModels();
  assert.deepEqual(agentModelOptions('claude'), [{ value: 'claude-opus-5', label: 'Opus 5', isLatest: true }]);
  assert.deepEqual(agentModelOptions('codex')[0].value, 'gpt-5.6-sol');
  // 'pi' was never a key in STATIC_MODEL_LISTS, so agentModelOptions('pi') stays [] regardless.
  assert.deepEqual(agentModelOptions('pi'), []);
});

test('ensureAgentModels: non-OK response leaves the static fallback in place', async () => {
  stubFetch(() => jsonResponse({}, { ok: false }));
  await ensureAgentModels();
  assert.deepEqual(agentModelOptions('claude'), CLAUDE_MODELS);
  assert.deepEqual(agentModelOptions('codex'), CODEX_MODELS);
});

test('ensureAgentModels: a rejected fetch leaves the static fallback in place', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  await ensureAgentModels();
  assert.deepEqual(agentModelOptions('claude'), CLAUDE_MODELS);
});

test('ensureAgentModels: a malformed body (bad JSON) leaves the static fallback in place', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  await ensureAgentModels();
  assert.deepEqual(agentModelOptions('claude'), CLAUDE_MODELS);
});

test('ensureAgentModels: concurrent calls issue exactly one fetch (single-flight)', async () => {
  let resolveResponse;
  const pending = new Promise((resolve) => { resolveResponse = resolve; });
  const calls = stubFetch(async () => { await pending; return jsonResponse({ agents: {} }); });
  const p1 = ensureAgentModels();
  const p2 = ensureAgentModels();
  resolveResponse();
  await Promise.all([p1, p2]);
  assert.equal(calls.length, 1);
});

test('ensureAgentModels: {force:true} requests ?refresh=1', async () => {
  const calls = stubFetch(() => jsonResponse({ agents: {} }));
  await ensureAgentModels({ force: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\?refresh=1$/);
});

test('ensureAgentModels: plain call requests no query string', async () => {
  const calls = stubFetch(() => jsonResponse({ agents: {} }));
  await ensureAgentModels();
  assert.equal(calls[0].url, '/api/agent-models');
});

// ── agentModelsSignature ──

test('agentModelsSignature: reflects the current option list', async () => {
  const beforeSig = agentModelsSignature('claude');
  assert.equal(beforeSig, CLAUDE_MODELS.map(m => m.value).join(','));
  stubFetch(() => jsonResponse({ agents: { claude: { agent: 'claude', models: [{ id: 'claude-opus-5', label: 'Opus 5', isLatest: true }], source: 'probe' } } }));
  await ensureAgentModels();
  assert.equal(agentModelsSignature('claude'), 'claude-opus-5');
  assert.notEqual(agentModelsSignature('claude'), beforeSig);
});

// ── modelLabel live-cache lookup ──

test('modelLabel: falls back to raw id before the registry has ever loaded', () => {
  assert.equal(modelLabel('claude', 'claude-mythos-1'), 'claude-mythos-1');
});

test('modelLabel: resolves a newly discovered id\'s live label once loaded', async () => {
  stubFetch(() => jsonResponse({
    agents: { claude: { agent: 'claude', models: [{ id: 'claude-mythos-1', label: 'Mythos 1', isLatest: false }], source: 'probe' } },
  }));
  await ensureAgentModels();
  assert.equal(modelLabel('claude', 'claude-mythos-1'), 'Mythos 1');
});

test('modelLabel: still resolves a static id (e.g. gemini/pi lists) untouched by the registry', () => {
  assert.equal(modelLabel('gemini', 'gemini-2.5-pro'), 'Gemini 2.5 Pro');
});
