'use strict';

// (C1504) GET /api/agent-models route test. Pins TIPATASK_PROJECT_ROOT + TIPATASK_USER_DATA
// to scratch dirs BEFORE requiring ws-handlers (config.js reads both once, at require time —
// same reasoning as api-config-project-root.test.js's C1132 lock), so this never touches the
// real checkout's model-registry.json or reads this repo's real .tipatask/config.json.
//
// Real ClaudeAgent/CodexAgent singletons are used (via task-agent's getTaskAgent()) with
// probeModels() monkey-patched per test — same "swap the one I/O seam" approach as
// api-config-project-root.test.js, and avoids depending on claude/codex actually being
// installed in whatever environment runs `npm test`.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GLOBAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1504-project-'));
const USER_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1504-userdata-'));
process.env.TIPATASK_PROJECT_ROOT = GLOBAL_ROOT;
process.env.TIPATASK_USER_DATA = USER_DATA_ROOT;
process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');

const { createHttpHandler } = require('./ws-handlers');
const { getTaskAgent } = require('./task-agent');
const { _resetForTest } = require('./task-agent/model-registry');

after(() => {
  fs.rmSync(GLOBAL_ROOT, { recursive: true, force: true });
  fs.rmSync(USER_DATA_ROOT, { recursive: true, force: true });
});

function fakeReq(method, url) {
  const req = { method, url, headers: {} };
  req[Symbol.asyncIterator] = async function* () {};
  return req;
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: '',
    writeHead(status) { res.statusCode = status; },
    end(chunk) { res.body = chunk || ''; },
  };
  return res;
}

function json(res) {
  return JSON.parse(res.body || '{}');
}

// All 4 tests below share one USER_DATA_ROOT (fixed for this whole process — config.js reads
// it once at require time), so a probe result one test persists to
// USER_DATA_ROOT/model-registry.json would otherwise survive into the next test's
// _resetForTest() (which only clears IN-MEMORY state) and hydrate back in via
// resolveModels()'s disk fallback, masking that test's own monkey-patched probeModels(). Wipe
// the file too, every time.
const REGISTRY_FILE = path.join(USER_DATA_ROOT, 'model-registry.json');
function resetModelRegistry() {
  _resetForTest();
  try { fs.unlinkSync(REGISTRY_FILE); } catch { /* nothing to wipe yet */ }
}

const handler = createHttpHandler(new Map(), () => ({}), null);

test('GET /api/agent-models returns models for every registered agent', async (t) => {
  resetModelRegistry();
  const claude = getTaskAgent('claude');
  const codex = getTaskAgent('codex');
  const origClaude = claude.probeModels;
  const origCodex = codex.probeModels;
  claude.probeModels = async () => [{ id: 'claude-opus-5', label: 'Opus 5', isLatest: true }];
  codex.probeModels = async () => [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', isLatest: true }];
  t.after(() => { claude.probeModels = origClaude; codex.probeModels = origCodex; _resetForTest(); });

  const res = fakeRes();
  await handler(fakeReq('GET', '/api/agent-models'), res);
  assert.strictEqual(res.statusCode, 200, res.body);
  const body = json(res);
  assert.ok(body.agents.claude.models.some(m => m.id === 'claude-opus-5'));
  assert.strictEqual(body.agents.claude.source, 'probe');
  assert.ok(body.agents.codex.models.some(m => m.id === 'gpt-5.6-sol'));
  assert.ok('pi' in body.agents, 'pi has no probe of its own — must still appear (empty fallback)');
});

test('GET /api/agent-models?agent=claude scopes the response to one agent', async (t) => {
  resetModelRegistry();
  const claude = getTaskAgent('claude');
  const orig = claude.probeModels;
  claude.probeModels = async () => [{ id: 'claude-opus-5', label: 'Opus 5', isLatest: true }];
  t.after(() => { claude.probeModels = orig; _resetForTest(); });

  const res = fakeRes();
  await handler(fakeReq('GET', '/api/agent-models?agent=claude'), res);
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.deepStrictEqual(Object.keys(json(res).agents), ['claude']);
});

test('a failing probe still yields a fallback list, not a 500', async (t) => {
  resetModelRegistry();
  const claude = getTaskAgent('claude');
  const orig = claude.probeModels;
  claude.probeModels = async () => { throw new Error('probe boom'); };
  t.after(() => { claude.probeModels = orig; _resetForTest(); });

  const res = fakeRes();
  await handler(fakeReq('GET', '/api/agent-models?agent=claude'), res);
  assert.strictEqual(res.statusCode, 200, res.body);
  const body = json(res);
  assert.strictEqual(body.agents.claude.source, 'fallback');
  assert.ok(body.agents.claude.models.length > 0, 'claude fallback list is non-empty');
});

test('?refresh=1 forces a re-probe even though the prior result is still fresh', async (t) => {
  resetModelRegistry();
  const claude = getTaskAgent('claude');
  const orig = claude.probeModels;
  let calls = 0;
  claude.probeModels = async () => { calls += 1; return [{ id: 'claude-opus-5', label: 'Opus 5', isLatest: true }]; };
  t.after(() => { claude.probeModels = orig; _resetForTest(); });

  await handler(fakeReq('GET', '/api/agent-models?agent=claude'), fakeRes());
  assert.strictEqual(calls, 1);
  await handler(fakeReq('GET', '/api/agent-models?agent=claude'), fakeRes());
  assert.strictEqual(calls, 1, 'second call within TTL must not re-probe');
  await handler(fakeReq('GET', '/api/agent-models?agent=claude&refresh=1'), fakeRes());
  assert.strictEqual(calls, 2, 'refresh=1 must bypass the cache');
});
