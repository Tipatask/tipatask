'use strict';

// C1132 regression lock: Settings modal "Coding Agent" default (Pi/Codex/Claude) must
// persist to the REQUESTING WINDOW's project — not the forked server's boot-time
// config.PROJECT_ROOT, which in a packaged Electron build resolves inside the read-only
// app.asar bundle (see ai/architecture/tt-electron-app.md § C1132 and tt-project-config.md).
//
// TIPATASK_PROJECT_ROOT must be set BEFORE requiring ws-handlers.js (which requires
// config.js transitively — config.js reads it once at module-load time), so the "global"
// side of every test below is a scratch dir, never the real repo — that scratch-dir pin is
// what actually isolates these tests from needing real API credentials, not TASK_BACKEND
// (which config.js sources from _startupProjectCfg/env, never gated by TASK_BACKEND at all).
// TASK_BACKEND is pinned to 'api' below only because config.js snapshots
// process.env.TASK_BACKEND once at require time and a dev shell may have something else
// exported — pin it so this file is deterministic.
const GLOBAL_ROOT_PLACEHOLDER = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'tt-c1132-global-')
);
process.env.TIPATASK_PROJECT_ROOT = GLOBAL_ROOT_PLACEHOLDER;
process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHttpHandler } = require('./ws-handlers');
const { readProjectConfig } = require('./project-config');
const config = require('./config');

const GLOBAL_ROOT = GLOBAL_ROOT_PLACEHOLDER;
assert.strictEqual(config.PROJECT_ROOT, GLOBAL_ROOT, 'sanity: config.PROJECT_ROOT must be the pinned scratch dir, not the real repo');

function makeProjectDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1132-proj-'));
  if (cfg) {
    fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  }
  return dir;
}

// ── Minimal fake IncomingMessage/ServerResponse (async-iterable req — the handler does
// `for await (const chunk of req)` to read POST bodies) ──
function fakeReq(method, url, { headers = {}, body } = {}) {
  const req = { method, url, headers };
  req[Symbol.asyncIterator] = async function* () {
    if (body != null) yield Buffer.from(body);
  };
  return req;
}

function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; res.headersSent = true; },
    end(chunk) { res.body = chunk || ''; },
  };
  return res;
}

function json(res) {
  return JSON.parse(res.body || '{}');
}

const handler = createHttpHandler(new Map(), () => ({}), null);

test('POST /api/agents-config writes to the header-supplied project root, not config.PROJECT_ROOT', async () => {
  const proj = makeProjectDir({ projectName: 'X' });
  try {
    const req = fakeReq('POST', '/api/agents-config', {
      headers: { 'x-tipatask-project': proj },
      body: JSON.stringify({ taskAgent: 'pi', availableAgents: ['claude', 'pi'] }),
    });
    const res = fakeRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

    const onDisk = readProjectConfig(proj);
    assert.strictEqual(onDisk.TASK_AGENT, 'pi');
    assert.strictEqual(onDisk.LAST_AGENT, 'pi');
    assert.ok(onDisk.AVAILABLE_AGENTS.split(',').includes('pi'));

    // The C1132 lock: nothing was ever written under the global boot-time root.
    assert.strictEqual(
      fs.existsSync(path.join(GLOBAL_ROOT, '.tipatask', 'config.json')),
      false,
      'save must not touch the forked server\'s boot-time project root'
    );
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('POST /api/agents-config merges into existing project config — credentials survive', async () => {
  const proj = makeProjectDir({ projectName: 'X', API_BASE_URL: 'https://api-config.test', API_TOKEN: 'secret-token', CLAUDE_MODEL: 'opusplan' });
  try {
    const req = fakeReq('POST', '/api/agents-config', {
      headers: { 'x-tipatask-project': proj },
      body: JSON.stringify({ taskAgent: 'codex', availableAgents: ['claude', 'codex'] }),
    });
    const res = fakeRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200);

    const onDisk = readProjectConfig(proj);
    assert.equal(onDisk.API_TOKEN, undefined);
    assert.equal(require('./account-store').readAccount('https://api-config.test').token, 'secret-token');
    assert.strictEqual(onDisk.CLAUDE_MODEL, 'opusplan');
    assert.strictEqual(onDisk.TASK_AGENT, 'codex');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('GET /api/agents-config round-trips the header-scoped project, isolated from a second project', async () => {
  const projA = makeProjectDir({ TASK_AGENT: 'pi', AVAILABLE_AGENTS: 'claude,pi', LAST_AGENT: 'pi' });
  const projB = makeProjectDir({ TASK_AGENT: 'codex', AVAILABLE_AGENTS: 'claude,codex', LAST_AGENT: 'codex' });
  try {
    const resA = fakeRes();
    await handler(fakeReq('GET', '/api/agents-config', { headers: { 'x-tipatask-project': projA } }), resA);
    assert.strictEqual(json(resA).selection.taskAgent, 'pi');

    const resB = fakeRes();
    await handler(fakeReq('GET', '/api/agents-config', { headers: { 'x-tipatask-project': projB } }), resB);
    assert.strictEqual(json(resB).selection.taskAgent, 'codex', 'project B must not see project A\'s save');
  } finally {
    fs.rmSync(projA, { recursive: true, force: true });
    fs.rmSync(projB, { recursive: true, force: true });
  }
});

test('GET /api/agent-config (C1132 fix) resolves taskAgent per-project via the header, not the global snapshot', async () => {
  const proj = makeProjectDir({ TASK_AGENT: 'pi', LAST_AGENT: 'pi' });
  try {
    const withHeader = fakeRes();
    await handler(fakeReq('GET', '/api/agent-config', { headers: { 'x-tipatask-project': proj } }), withHeader);
    assert.strictEqual(json(withHeader).taskAgent, 'pi');

    const withoutHeader = fakeRes();
    await handler(fakeReq('GET', '/api/agent-config', {}), withoutHeader);
    assert.strictEqual(json(withoutHeader).taskAgent, config.TASK_AGENT || 'claude', 'no header → falls back to the global default, unchanged from before C1132');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('GET /api/config and POST /api/config remain header-scoped (pre-existing C1124 fix) — locked here since it had no direct test', async () => {
  const proj = makeProjectDir({ projectName: 'X' });
  try {
    const post = fakeRes();
    await handler(fakeReq('POST', '/api/config', {
      headers: { 'x-tipatask-project': proj },
      body: JSON.stringify({ CLAUDE_MODEL: 'claude-opus-5' }),
    }), post);
    assert.strictEqual(post.statusCode, 200, post.body);
    assert.strictEqual(readProjectConfig(proj).CLAUDE_MODEL, 'claude-opus-5');
    assert.strictEqual(fs.existsSync(path.join(GLOBAL_ROOT, '.tipatask', 'config.json')), false);

    const get = fakeRes();
    await handler(fakeReq('GET', '/api/config', { headers: { 'x-tipatask-project': proj } }), get);
    assert.strictEqual(json(get).CLAUDE_MODEL, 'claude-opus-5');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('POST /api/config with TASK_AGENT does not throw when the project has no AVAILABLE_AGENTS on disk and the global fallback is an array (C1132 AVAILABLE_AGENTS.split TypeError fix)', async () => {
  // No AVAILABLE_AGENTS key at all. The handler builds the allowlist from the project's own
  // disk value only, so the array-shaped global must be neither split nor persisted. Pinned
  // to a known array here (ambient env may seed it) and restored afterwards.
  const savedAvailable = config.AVAILABLE_AGENTS;
  config.AVAILABLE_AGENTS = [];
  const proj = makeProjectDir({ projectName: 'X' });
  try {
    assert.ok(Array.isArray(config.AVAILABLE_AGENTS), 'sanity: the global fallback really is an array, not a string');
    const res = fakeRes();
    await handler(fakeReq('POST', '/api/config', {
      headers: { 'x-tipatask-project': proj },
      body: JSON.stringify({ TASK_AGENT: 'pi' }),
    }), res);
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const onDisk = readProjectConfig(proj);
    assert.strictEqual(onDisk.TASK_AGENT, 'pi');
    assert.ok(onDisk.AVAILABLE_AGENTS.split(',').includes('pi'));
    assert.deepEqual(config.AVAILABLE_AGENTS, [], 'global allowlist untouched by the save');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    config.AVAILABLE_AGENTS = savedAvailable;
  }
});

test('POST /api/config rejects an unknown TASK_AGENT and writes nothing', async () => {
  const proj = makeProjectDir(); // no .tipatask/config.json at all
  try {
    const res = fakeRes();
    await handler(fakeReq('POST', '/api/config', {
      headers: { 'x-tipatask-project': proj },
      body: JSON.stringify({ TASK_AGENT: 'bogus-agent' }),
    }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(readProjectConfig(proj), null, 'a validation rejection must not create a config file at all');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('saving agents in one project never leaks into the global config or another project (TPT169)', async () => {
  const registry = require('./providers/registry');
  const { getTaskAgent } = require('./task-agent');
  const detectState = ['claude', 'codex', 'pi'].map((id) => {
    const agent = getTaskAgent(id);
    const saved = { agent, detect: agent.detect, result: agent._detectResult, ts: agent._detectTs };
    agent.detect = async () => ({ id, label: agent.label, available: true });
    agent._detectResult = { id, label: agent.label, available: true };
    agent._detectTs = Date.now();
    return saved;
  });
  const savedAvailable = config.AVAILABLE_AGENTS;
  const savedAgent = config.TASK_AGENT;
  config.AVAILABLE_AGENTS = [];
  const projA = makeProjectDir({ projectName: 'A' });
  const projB = makeProjectDir({ projectName: 'B' }); // no AVAILABLE_AGENTS key
  const visibleB = () => registry.listVisibleObjectiveProviders(registry.configForProject(projB), { peek: true }).map((p) => p.id);
  try {
    const beforeB = visibleB();
    const beforeAllowB = registry.configForProject(projB).AVAILABLE_AGENTS;
    const selection = { taskAgent: 'codex', availableAgents: ['codex'] };
    for (const body of [selection, { ...selection, applyOnly: true }]) {
      const res = fakeRes();
      await handler(fakeReq('POST', '/api/agents-config', {
        headers: { 'x-tipatask-project': projA }, body: JSON.stringify(body),
      }), res);
      assert.strictEqual(res.statusCode, 200, res.body);
    }
    const res2 = fakeRes();
    await handler(fakeReq('POST', '/api/config', {
      headers: { 'x-tipatask-project': projA }, body: JSON.stringify({ TASK_AGENT: 'codex' }),
    }), res2);
    assert.strictEqual(res2.statusCode, 200, res2.body);
    assert.strictEqual(json(res2).TASK_AGENT, 'codex');

    // A's own file and view carry the restrictive allowlist…
    assert.strictEqual(readProjectConfig(projA).AVAILABLE_AGENTS, 'codex');
    assert.deepEqual(registry.configForProject(projA).AVAILABLE_AGENTS, ['codex']);
    // …the global singleton is still its boot-time value and shape…
    assert.deepEqual(config.AVAILABLE_AGENTS, []);
    assert.ok(Array.isArray(config.AVAILABLE_AGENTS));
    assert.strictEqual(config.TASK_AGENT, savedAgent);
    // …and B is unaffected, in memory and on disk.
    assert.deepEqual(registry.configForProject(projB).AVAILABLE_AGENTS, beforeAllowB);
    assert.deepEqual(visibleB(), beforeB);
    const res3 = fakeRes();
    await handler(fakeReq('POST', '/api/config', {
      headers: { 'x-tipatask-project': projB }, body: JSON.stringify({ CLAUDE_MODEL: 'opusplan' }),
    }), res3);
    assert.strictEqual(res3.statusCode, 200, res3.body);
    assert.ok(!('AVAILABLE_AGENTS' in readProjectConfig(projB)));
  } finally {
    for (const { agent, detect, result, ts } of detectState) {
      agent.detect = detect;
      agent._detectResult = result;
      agent._detectTs = ts;
    }
    fs.rmSync(projA, { recursive: true, force: true });
    fs.rmSync(projB, { recursive: true, force: true });
    config.AVAILABLE_AGENTS = savedAvailable;
    config.TASK_AGENT = savedAgent;
  }
});
