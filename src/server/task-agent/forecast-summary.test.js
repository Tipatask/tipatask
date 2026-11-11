'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const registry = require('./index');

test('cold forecast summary is immediate and never starts detection', () => {
  const start = performance.now();
  assert.equal(registry.getAgentForecastSummary({ PROJECT_ROOT: '/cold' }), null);
  assert.ok(performance.now() - start < 2000);
});

test('forecast summary uses detected availability and project-scoped normalized quota only', async t => {
  const agent = registry.getTaskAgent('claude');
  const saved = { result: agent._detectResult, ts: agent._detectTs };
  t.after(() => { agent._detectResult = saved.result; agent._detectTs = saved.ts; });
  agent._detectResult = { available: true };
  agent._detectTs = Date.now();
  t.mock.method(agent, 'detect', () => assert.fail('no probes'));
  t.mock.method(agent, 'getQuotaStatus', async () => ({ plan: 'max', connectionState: 'connected',
    windows: [{ id: 'weekly', usagePercent: 25 }], token: 'must-not-escape' }));
  const cfg = { PROJECT_ROOT: '/forecast-summary' };
  await registry.getAgentQuotaStatus('claude', cfg);
  const start = performance.now();
  const summary = registry.getAgentForecastSummary(cfg);
  assert.ok(performance.now() - start < 2000);
  assert.equal(summary[0].plan, 'max');
  assert.equal(summary[0].usage.windows[0].usagePercent, 25);
  assert.ok(!JSON.stringify(summary).includes('must-not-escape'));
  summary[0].usage.windows[0].usagePercent = 99;
  assert.equal(registry.getAgentForecastSummary(cfg)[0].usage.windows[0].usagePercent, 25);
  assert.equal(registry.getAgentForecastSummary({ PROJECT_ROOT: '/another' })[0].usage, null);
  assert.deepEqual(registry.getAgentForecastSummary({ ...cfg, AVAILABLE_AGENTS: ['pi'] }), []);
  const expired = Date.now() + 60001;
  t.mock.method(Date, 'now', () => expired);
  assert.equal(registry.getAgentForecastSummary(cfg)[0].usage, null);
});
