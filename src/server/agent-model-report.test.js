'use strict';

// The device's agent model report (agent-model-report.js): what one project's report holds, when
// a report is sent, how refusals back off, and the model registry's resolve listener that
// triggers it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  REPORT_LIMITS, HEARTBEAT_MS, POLL_MS, RETRY_MS, isReportableModelId, registryModels, piTaskModelIds,
  buildAgentModelReport, createAgentModelReporter,
} = require('./agent-model-report');

const CLAUDE_PROBE = {
  source: 'probe',
  models: [
    { id: 'opusplan', label: 'opusplan (default)', isLatest: true },
    { id: 'opus', label: 'opus (latest Opus)', isLatest: true },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', isLatest: true },
    { id: 'claude-fable-5-1', label: 'claude-fable-5-1', isLatest: true },
  ],
};
const CODEX_PROBE = { source: 'probe', models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', isLatest: true }] };

test('isReportableModelId: one printable token within the API limit', () => {
  for (const id of ['opusplan', 'gpt-6.1-sol', 'openrouter/anthropic/claude-sonnet-5-5', 'llama3.1:8b']) assert.equal(isReportableModelId(id), true, id);
  for (const id of ['', 'two words', 'x'.repeat(REPORT_LIMITS.MAX_ID_LENGTH + 1), 'модель', null]) assert.equal(isReportableModelId(id), false, String(id));
});

test('registryModels: a live probe entry as { id, label? }, nothing for a fallback, error or cold cache', () => {
  assert.deepEqual(registryModels(CLAUDE_PROBE), [
    { id: 'opusplan', label: 'opusplan (default)' },
    { id: 'opus', label: 'opus (latest Opus)' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-fable-5-1' },
  ]);
  assert.equal(registryModels({ source: 'fallback', models: [{ id: 'opusplan', label: 'opusplan' }] }), null);
  assert.equal(registryModels({ source: 'error', models: [] }), null);
  assert.equal(registryModels({ source: 'probe', models: [] }), null);
  assert.equal(registryModels(null), null);
  const many = { source: 'probe', models: Array.from({ length: 150 }, (_, i) => ({ id: `m${i}` })).concat([{ id: 'bad id' }]) };
  assert.equal(registryModels(many).length, REPORT_LIMITS.MAX_MODELS_PER_AGENT);
});

test('piTaskModelIds: configured rows a task can start on — tool-less rows out, image rows in, legacy pair kept', () => {
  const cfg = { PI_MODELS: [
    { model: 'openrouter/anthropic/claude-sonnet-5-5', apiKey: 'k1' },
    { provider: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1:8b', tools: false },
    { model: 'deepseek-flash', provider: 'deepseek', apiKey: '' },
    { provider: 'custom', baseUrl: 'http://localhost:8000/v1', model: 'qwen-coder' },
  ] };
  const ids = piTaskModelIds(cfg);
  assert.ok(ids.includes('openrouter/anthropic/claude-sonnet-5-5'));
  assert.ok(ids.includes('qwen-coder'));
  assert.ok(!ids.includes('llama3.1:8b'), 'a tool-less row cannot start a task');
  assert.ok(!ids.includes('deepseek-flash'), 'a row missing its key is not configured');
  assert.deepEqual(piTaskModelIds({ PI_MODEL: 'openrouter/openai/gpt-6', OPENROUTER_API_KEY: 'k' }), ['openrouter/openai/gpt-6']);
  assert.deepEqual(piTaskModelIds({}), []);
  assert.deepEqual(piTaskModelIds(null), []);
});

test('buildAgentModelReport: live registry lists for Claude/Codex, Pi always present', () => {
  assert.deepEqual(buildAgentModelReport({ registry: { claude: CLAUDE_PROBE, codex: CODEX_PROBE }, piModelIds: ['a/b', 'a/b', 'c d'] }), {
    claude: { models: registryModels(CLAUDE_PROBE) },
    codex: { models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }] },
    pi: { models: [{ id: 'a/b' }] },
  });
  assert.deepEqual(buildAgentModelReport({ registry: { claude: { source: 'fallback', models: [{ id: 'opusplan' }] } } }), { pi: { models: [] } });
  assert.deepEqual(buildAgentModelReport(), { pi: { models: [] } });
});

// A reporter over fakes: two checkouts of API project 7 (one with a Pi row each), one checkout of
// project 9, one folder that is no API project. `responses` answers each PUT in turn (default 200).
function harness({ responses = [], deviceId = 41, registry = { claude: CLAUDE_PROBE, codex: CODEX_PROBE } } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const warnings = [];
  const projects = {
    '/work/a': { credentials: { baseUrl: 'https://api.test/', token: 'tok', projectId: '7' }, config: { PI_MODELS: [{ model: 'openrouter/x/one', apiKey: 'k' }] } },
    '/work/a-copy': { credentials: { baseUrl: 'https://api.test', token: 'tok', projectId: '7' }, config: { PI_MODELS: [{ model: 'openrouter/x/two', apiKey: 'k' }] } },
    '/work/b': { credentials: { baseUrl: 'https://api.test', token: 'tok', projectId: '9' }, config: {} },
    '/work/plain': { credentials: null, config: null },
  };
  const reporter = createAgentModelReporter({
    getProjectPaths: () => Object.keys(projects).values(),
    deviceIdentity: { deviceIdForAccount: async () => deviceId },
    getCredentials: (p) => {
      if (!projects[p].credentials) throw new Error('API not configured for this project');
      return projects[p].credentials;
    },
    readConfig: p => projects[p].config,
    peekEntry: agent => registry[agent] || null,
    request: async (url, opts) => {
      calls.push({ url, ...opts });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next || { status: 200, data: {} };
    },
    now: () => clock,
    log: { warn: text => warnings.push(text), log: () => {} },
  });
  return { reporter, calls, warnings, projects, registry, advance: ms => { clock += ms; } };
}

test('reporter: one PUT per API project and device, checkouts merged, non-API folders skipped', async () => {
  const { reporter, calls } = harness();
  await reporter.sync();
  assert.deepEqual(calls.map(c => [c.method, c.url]), [
    ['PUT', 'https://api.test/api/projects/7/agent-models'],
    ['PUT', 'https://api.test/api/projects/9/agent-models'],
  ]);
  assert.deepEqual(calls[0].headers, { Authorization: 'Bearer tok' });
  assert.equal(calls[0].timeoutMs, 10_000);
  assert.deepEqual(calls[0].body, {
    device_id: 41,
    agents: {
      claude: { models: registryModels(CLAUDE_PROBE) },
      codex: { models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }] },
      pi: { models: [{ id: 'openrouter/x/one' }, { id: 'openrouter/x/two' }] },
    },
  });
  assert.deepEqual(calls[1].body.agents.pi, { models: [] }, 'a project without Pi rows clears them');
});

test('reporter: nothing new sends nothing; a change or the heartbeat sends again', async () => {
  const { reporter, calls, projects, registry, advance } = harness();
  await reporter.sync();
  assert.equal(calls.length, 2);
  await reporter.sync();
  assert.equal(calls.length, 2, 'unchanged lists are not sent again');

  projects['/work/b'].config = { PI_MODELS: [{ model: 'openrouter/x/three', apiKey: 'k' }] };
  await reporter.sync();
  assert.equal(calls.length, 3, 'a Pi row edit reports that project only');
  assert.equal(calls[2].url, 'https://api.test/api/projects/9/agent-models');

  registry.claude = { source: 'probe', models: [{ id: 'claude-opus-6', label: 'Opus 6' }] };
  await reporter.sync();
  assert.equal(calls.length, 5, 'a new registry list reports every project');

  registry.codex = { source: 'fallback', models: [{ id: 'gpt-5.5' }] };
  await reporter.sync();
  assert.equal(calls.length, 7);
  assert.equal(calls[5].body.agents.codex, undefined, 'a fallback list is left out, the stored live one kept');

  advance(HEARTBEAT_MS);
  await reporter.sync();
  assert.equal(calls.length, 9, 'the heartbeat re-sends unchanged lists');
});

test('reporter: no device, no report', async () => {
  const { reporter, calls } = harness({ deviceId: null });
  await reporter.sync();
  assert.deepEqual(calls, []);
});

test('reporter: a refusal backs off by its kind and is logged once per streak', async () => {
  const { reporter, calls, warnings, advance } = harness({ responses: [
    { status: 404, data: 'Cannot PUT' }, { status: 500, data: {} },
  ] });
  await reporter.sync();
  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /project 7 \(HTTP 404\); retrying in 360 min/);
  assert.match(warnings[1], /project 9 \(HTTP 500\); retrying in 1 min/);

  await reporter.sync();
  assert.equal(calls.length, 2, 'both still inside their delay');
  advance(RETRY_MS.other);
  await reporter.sync();
  assert.equal(calls.length, 3, 'the 5xx project is retried after a minute');
  assert.equal(calls[2].url, 'https://api.test/api/projects/9/agent-models');
  advance(RETRY_MS.notFound);
  await reporter.sync();
  assert.equal(calls.length, 4, 'the 404 project after hours');
  assert.equal(warnings.length, 2, 'success ends the streaks without new warnings');
});

test('reporter: a network error or a forbidden answer is retried after its delay', async () => {
  const offline = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const { reporter, calls, warnings, advance } = harness({ responses: [offline, { status: 403, data: {} }] });
  await reporter.sync();
  assert.match(warnings[0], /\(ECONNREFUSED\); retrying in 1 min/);
  assert.match(warnings[1], /\(HTTP 403\); retrying in 60 min/);
  advance(RETRY_MS.forbidden);
  await reporter.sync();
  assert.equal(calls.length, 4);
});

test('reporter: a sync requested while one runs runs once more after it, never in parallel', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const reporter = createAgentModelReporter({
    getProjectPaths: () => ['/p'],
    deviceIdentity: { deviceIdForAccount: async () => 1 },
    getCredentials: () => ({ baseUrl: 'https://api.test', token: 't', projectId: 1 }),
    readConfig: () => ({}),
    peekEntry: () => null,
    request: async () => {
      active += 1; runs += 1; maxActive = Math.max(maxActive, active);
      if (runs === 1) await gate;
      active -= 1;
      return { status: 200 };
    },
    heartbeatMs: 0,
    log: { warn() {}, log() {} },
  });
  const first = reporter.sync();
  const second = reporter.sync();
  const third = reporter.sync();
  assert.equal(second, first);
  assert.equal(third, first);
  release();
  await first;
  assert.equal(runs, 2, 'the three calls ran as the running sync plus one more');
  assert.equal(maxActive, 1);
});

test('reporter: start() syncs shortly after, the poll picks up changes, stop() ends it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { reporter, calls, registry } = harness();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  reporter.start();
  await flush();
  assert.equal(calls.length, 0, 'nothing before the debounce');
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(calls.length, 2, 'the first sync follows start()');

  // A timer set inside tick() counts from the tick's end, so the poll's debounce needs its own.
  registry.claude = { source: 'probe', models: [{ id: 'claude-opus-6' }] };
  t.mock.timers.tick(POLL_MS);
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(calls.length, 4, 'the poll picks up a changed list');

  reporter.schedule();
  reporter.schedule();
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(calls.length, 4, 'schedule() coalesces and an unchanged report sends nothing');

  reporter.stop();
  registry.claude = { source: 'probe', models: [{ id: 'claude-opus-7' }] };
  t.mock.timers.tick(POLL_MS);
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(calls.length, 4, 'nothing after stop()');
});

test('model registry: onModelsResolved hears every stored probe and fallback, unsubscribes, survives a throwing listener', async (t) => {
  const registry = require('./task-agent/model-registry');
  const BaseTaskAgent = require('./task-agent/base-agent');
  registry._resetForTest();
  t.after(() => registry._resetForTest());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-model-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { USER_DATA_ROOT: dir, CLAUDE_MODELS: ['opusplan'], CODEX_MODELS: [] };
  class FakeAgent extends BaseTaskAgent {
    constructor(probe) { super('claude', 'Fake'); this.probe = probe; }
    async probeModels() { return this.probe(); }
    getModelProbeKey() { return 'k'; }
  }
  const heard = [];
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  registry.onModelsResolved(() => { throw new Error('listener boom'); });
  const off = registry.onModelsResolved((agentId, entry) => heard.push([agentId, entry.source]));

  await registry.resolveModels(new FakeAgent(() => [{ id: 'claude-opus-6', label: 'Opus 6', isLatest: true }]), config, { force: true });
  await registry.resolveModels(new FakeAgent(() => { throw new Error('probe down'); }), config, { force: true });
  assert.deepEqual(heard, [['claude', 'probe'], ['claude', 'fallback']]);
  assert.ok(errors.some(e => /listener failed: listener boom/.test(e)));
  assert.equal(registry.peekModelEntry('claude', config).source, 'fallback', 'a throwing listener changes nothing');

  off();
  await registry.resolveModels(new FakeAgent(() => [{ id: 'x' }]), config, { force: true });
  assert.equal(heard.length, 2);
});
