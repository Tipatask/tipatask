'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-quota-route-'));
process.env.TIPATASK_PROJECT_ROOT = root;
process.env.TIPATASK_USER_DATA = root;
const { createHttpHandler } = require('./ws-handlers');
const { getTaskAgent } = require('./task-agent');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const handler = createHttpHandler(new Map(), () => { throw new Error('quota route must not access task backend'); });
async function request(url, projectRoot) {
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = JSON.parse(body); } };
  await handler({ method: 'GET', url, headers: projectRoot ? { 'x-tipatask-project': projectRoot } : {} }, res);
  return res;
}

test('quota endpoint scopes concurrent projects and exposes only normalized fields', async t => {
  const seen = [];
  for (const id of ['claude', 'codex']) {
    const agent = getTaskAgent(id), original = agent.getQuotaStatus;
    t.after(() => { agent.getQuotaStatus = original; });
    agent.getQuotaStatus = async (cfg, opts) => {
      seen.push(opts.projectRoot);
      await new Promise(resolve => setImmediate(resolve));
      return { connectionState: 'connected', plan: id === 'claude' ? 'max' : 'pro', windows: [{ id: 'weekly', usagePercent: opts.projectRoot.endsWith('a') ? 12 : 85, resetAt: null, token: 'secret' }], accessToken: 'secret', email: 'secret' };
    };
  }
  const [a, b] = await Promise.all([request('/api/agent-quota', '/project-a'), request('/api/agent-quota', '/project-b')]);
  for (const [res, project, used] of [[a, '/project-a', 12], [b, '/project-b', 85]]) {
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.body.projectRoot, project);
    assert.deepEqual(Object.keys(res.body.agents), ['claude', 'codex']);
    for (const value of Object.values(res.body.agents)) {
      assert.equal(value.projectRoot, project);
      assert.equal(value.windows[0].usagePercent, used);
    }
    assert.equal(JSON.stringify(res.body).includes('secret'), false);
  }
  assert.equal(seen.length, 4);
  const single = await request('/api/agent-quota?agent=codex');
  assert.equal(single.body.projectRoot, root);
  assert.deepEqual(Object.keys(single.body.agents), ['codex']);
});

test('one provider failure cannot hide the other provider and raw errors never reach clients', async t => {
  for (const id of ['claude', 'codex']) {
    const agent = getTaskAgent(id), original = agent.getQuotaStatus;
    t.after(() => { agent.getQuotaStatus = original; });
    agent.getQuotaStatus = async () => {
      if (id === 'claude') throw new Error('Bearer secret');
      return { connectionState: 'signed_out', unavailableReason: 'signed_out' };
    };
  }
  const res = await request('/api/agent-quota');
  assert.equal(res.body.agents.claude.unavailableReason, 'provider_error');
  assert.equal(res.body.agents.codex.unavailableReason, 'signed_out');
  assert.equal(JSON.stringify(res.body).includes('secret'), false);
  const unsupported = await request('/api/agent-quota?agent=__proto__');
  assert.equal(unsupported.body.agents.__proto__.unavailableReason, 'unsupported_provider');
});

test('headerless quota requests follow active project changes and capture scope before awaiting', async t => {
  let active = '/project-a';
  const scopedHandler = createHttpHandler(new Map(), () => ({}), { getActiveProjectPath: () => active });
  const agent = getTaskAgent('codex'), original = agent.getQuotaStatus;
  t.after(() => { agent.getQuotaStatus = original; });
  agent.getQuotaStatus = async (cfg, opts) => {
    await new Promise(resolve => setImmediate(resolve));
    return { connectionState: 'connected', windows: [{ id: 'weekly', usagePercent: opts.projectRoot === '/project-a' ? 10 : 90 }] };
  };
  const read = (headers = {}) => {
    const res = { writeHead() {}, end(body) { this.body = JSON.parse(body); } };
    return scopedHandler({ method: 'GET', url: '/api/agent-quota?agent=codex', headers }, res).then(() => res.body);
  };
  const before = read();
  active = '/project-b';
  const afterSwitch = read();
  const [a, b, explicit] = await Promise.all([before, afterSwitch, read({ 'x-tipatask-project': '/project-a' })]);
  assert.equal(a.projectRoot, '/project-a');
  assert.equal(b.projectRoot, '/project-b');
  assert.equal(explicit.projectRoot, '/project-a');
  assert.deepEqual([a,b,explicit].map(v => v.agents.codex.windows[0].usagePercent), [10,90,10]);
});
