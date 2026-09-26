'use strict';

// (C1504) Cache/coalescing/disk-persistence tests for model-registry.js's resolveModels(),
// using a FakeAgent (same style as cached-detect.test.js's FakeAgent for detect()).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BaseTaskAgent = require('./base-agent');
const modelRegistry = require('./model-registry');
const { resolveModels, TTL_MS, FALLBACK_TTL_MS, _resetForTest } = modelRegistry;

function makeConfig(userDataRoot) {
  return {
    USER_DATA_ROOT: userDataRoot,
    CLAUDE_MODELS: ['opusplan', 'claude-opus-5'],
    CODEX_MODELS: ['gpt-5.6-sol', 'gpt-5.5'],
  };
}

// probeFn: () => models[] | throws. keyFn: () => string.
class FakeAgent extends BaseTaskAgent {
  constructor(id, probeFn, keyFn = () => '') {
    super(id, 'Fake');
    this._probeFn = probeFn;
    this._keyFn = keyFn;
    this.probeCalls = 0;
  }
  async probeModels() {
    this.probeCalls += 1;
    return this._probeFn();
  }
  getModelProbeKey() {
    return this._keyFn();
  }
}

function tmpUserDataRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tt-model-cache-'));
}

test('cold probe caches, second call within TTL is served from memory (no re-probe)', async (t) => {
  _resetForTest();
  const dir = tmpUserDataRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = makeConfig(dir);
  const agent = new FakeAgent('fake', () => [{ id: 'm1', label: 'M1', isLatest: true }]);

  const first = await resolveModels(agent, config);
  assert.strictEqual(first.source, 'probe');
  assert.strictEqual(agent.probeCalls, 1);

  const second = await resolveModels(agent, config);
  assert.strictEqual(agent.probeCalls, 1, 'fresh cache hit must not re-probe');
  assert.deepStrictEqual(second.models, first.models);
});

test('10 concurrent callers coalesce onto exactly one probe', async (t) => {
  _resetForTest();
  const dir = tmpUserDataRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = makeConfig(dir);
  let resolveProbe;
  const gate = new Promise((r) => { resolveProbe = r; });
  const agent = new FakeAgent('fake', async () => { await gate; return [{ id: 'm1', label: 'M1', isLatest: true }]; });

  const calls = Array.from({ length: 10 }, () => resolveModels(agent, config));
  // let the microtask queue settle so all 10 calls have registered before the probe resolves
  await new Promise((r) => setImmediate(r));
  resolveProbe();
  const results = await Promise.all(calls);
  assert.strictEqual(agent.probeCalls, 1, 'concurrent callers must share one in-flight probe');
  assert.ok(results.every(r => r.source === 'probe'));
});

test('force:true bypasses a fresh cache and re-probes', async (t) => {
  _resetForTest();
  const dir = tmpUserDataRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = makeConfig(dir);
  const agent = new FakeAgent('fake', () => [{ id: 'm1', label: 'M1', isLatest: true }]);

  await resolveModels(agent, config);
  assert.strictEqual(agent.probeCalls, 1);
  await resolveModels(agent, config, { force: true });
  assert.strictEqual(agent.probeCalls, 2, 'force must bypass TTL freshness');
});

test('empty probe result falls back to the static config list', async (t) => {
  _resetForTest();
  const dir = tmpUserDataRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = makeConfig(dir);
  const agent = new FakeAgent('claude', () => []);

  const entry = await resolveModels(agent, config);
  assert.strictEqual(entry.source, 'fallback');
  assert.deepStrictEqual(entry.models.map(m => m.id), config.CLAUDE_MODELS);
});

test('throwing probe falls back to the static config list, never rejects', async (t) => {
  _resetForTest();
  const dir = tmpUserDataRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = makeConfig(dir);
  const agent = new FakeAgent('codex', () => { throw new Error('boom'); });

  const entry = await resolveModels(agent, config);
  assert.strictEqual(entry.source, 'fallback');
  assert.deepStrictEqual(entry.models.map(m => m.id), config.CODEX_MODELS);
});

test('changed probe key (CLI auto-updated) re-probes even though TTL has not expired', async (t) => {
  _resetForTest();
  const dir = tmpUserDataRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = makeConfig(dir);
  let key = 'v1';
  const agent = new FakeAgent('fake', () => [{ id: 'm1', label: 'M1', isLatest: true }], () => key);

  await resolveModels(agent, config);
  assert.strictEqual(agent.probeCalls, 1);
  await resolveModels(agent, config);
  assert.strictEqual(agent.probeCalls, 1, 'unchanged key within TTL — no re-probe');

  key = 'v2';
  await resolveModels(agent, config);
  assert.strictEqual(agent.probeCalls, 2, 'changed key must invalidate the cache immediately');
});

test('disk round-trip: a fresh process (cleared in-memory cache) hydrates from the written file', async (t) => {
  _resetForTest();
  const dir = tmpUserDataRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = makeConfig(dir);
  const agent = new FakeAgent('fake', () => [{ id: 'm1', label: 'M1', isLatest: true }]);

  await resolveModels(agent, config);
  assert.ok(fs.existsSync(path.join(dir, 'model-registry.json')), 'probe result must be persisted to disk');

  // Simulate a fresh process: wipe in-memory state only, disk file stays.
  _resetForTest();
  const agent2 = new FakeAgent('fake', () => { throw new Error('must not re-probe — disk cache is fresh'); });
  const entry = await resolveModels(agent2, config);
  assert.strictEqual(entry.source, 'probe');
  assert.strictEqual(agent2.probeCalls, 0, 'a fresh in-memory cache must hydrate from disk before probing');
});

test('TTL expiry triggers a re-probe; fallback entries expire far sooner than real probes', async (t) => {
  _resetForTest();
  const dir = tmpUserDataRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = makeConfig(dir);
  t.mock.timers.enable({ apis: ['Date'] });

  const probeAgent = new FakeAgent('fake', () => [{ id: 'm1', label: 'M1', isLatest: true }]);
  await resolveModels(probeAgent, config);
  t.mock.timers.tick(TTL_MS - 1000);
  await resolveModels(probeAgent, config);
  assert.strictEqual(probeAgent.probeCalls, 1, 'still fresh just under the 24h TTL');
  t.mock.timers.tick(2000);
  await resolveModels(probeAgent, config);
  assert.strictEqual(probeAgent.probeCalls, 2, 'expired past the 24h TTL — must re-probe');

  _resetForTest();
  const fallbackAgent = new FakeAgent('fake2', () => []);
  await resolveModels(fallbackAgent, config);
  t.mock.timers.tick(FALLBACK_TTL_MS + 1000);
  await resolveModels(fallbackAgent, config);
  assert.strictEqual(fallbackAgent.probeCalls, 2, 'a fallback result must retry well before 24h');
  t.mock.timers.reset();
});
