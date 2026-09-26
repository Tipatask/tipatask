import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FALLBACK_AGENTS } from './agent-select.js';
import {
  fetchAgentStatusesFromServer, recheckAgents, refreshObjectiveProviders, notifyServerAgentsSaved,
} from './agent-recheck.js';

// agent-recheck.js reads fetch/window/location/document at CALL time — stub them per test, in the
// style of agent-select.test.js's withWindow().
async function withEnv({ fetchImpl, win = {}, search = '' }, fn) {
  const saved = {};
  const keys = ['fetch', 'window', 'location', 'document'];
  for (const k of keys) saved[k] = { had: k in globalThis, val: globalThis[k] };
  const events = [];
  globalThis.fetch = fetchImpl;
  globalThis.window = win;
  globalThis.location = { search };
  globalThis.document = { dispatchEvent: (e) => { events.push(e); return true; } };
  try { return await fn(events); } finally {
    for (const k of keys) { if (saved[k].had) globalThis[k] = saved[k].val; else delete globalThis[k]; }
  }
}

const json = (body, ok = true) => ({ ok, json: async () => body });
const STATUSES = [{ id: 'claude', label: 'Claude Code', available: true }];

// ── fetchAgentStatusesFromServer ─────────────────────────────────────────────────────────────

test('fetchAgentStatusesFromServer: bare URL by default, ?refresh=1 when forced', async () => {
  const urls = [];
  await withEnv({ fetchImpl: async (url) => { urls.push(url); return json({ agentStatuses: STATUSES }); } }, async () => {
    assert.deepEqual(await fetchAgentStatusesFromServer(), STATUSES);
    assert.deepEqual(await fetchAgentStatusesFromServer(true), STATUSES);
  });
  assert.deepEqual(urls, ['/api/agent-config', '/api/agent-config?refresh=1']);
});

test('fetchAgentStatusesFromServer: null on a non-ok response or a body with no agentStatuses', async () => {
  await withEnv({ fetchImpl: async () => json({}, false) }, async () => assert.equal(await fetchAgentStatusesFromServer(true), null));
  await withEnv({ fetchImpl: async () => json({ availableAgents: [] }) }, async () => assert.equal(await fetchAgentStatusesFromServer(true), null));
});

test('fetchAgentStatusesFromServer: forwards the window project as x-tipatask-project', async () => {
  let headers;
  await withEnv({ search: '?projectPath=%2Ftmp%2Fproj', fetchImpl: async (_u, opts) => { headers = opts.headers; return json({ agentStatuses: [] }); } },
    async () => { await fetchAgentStatusesFromServer(); });
  assert.deepEqual(headers, { 'x-tipatask-project': '/tmp/proj' });
});

// ── recheckAgents ────────────────────────────────────────────────────────────────────────────

test('recheckAgents: asks the forked server first and never touches the Electron IPC when it answers', async () => {
  const urls = [];
  let ipcCalled = false;
  const win = { electronAPI: { setupGetAvailableAgents: async () => { ipcCalled = true; return []; } } };
  const out = await withEnv({ win, fetchImpl: async (url) => { urls.push(url); return json({ agentStatuses: STATUSES }); } }, () => recheckAgents());
  assert.deepEqual(out, STATUSES);
  assert.deepEqual(urls, ['/api/agent-config?refresh=1']);
  assert.equal(ipcCalled, false);
});

test('recheckAgents: falls back to the Electron IPC (force=true) when the server has nothing usable', async () => {
  const DETECTED = [{ id: 'claude', label: 'Claude Code', available: true }];
  for (const serverAnswer of [
    async () => json({ agentStatuses: [] }),
    async () => json({}, false),
    async () => { throw new Error('server down'); },
  ]) {
    const seen = [];
    const win = { electronAPI: { setupGetAvailableAgents: async (force) => { seen.push(force); return DETECTED; } } };
    const out = await withEnv({ win, fetchImpl: serverAnswer }, () => recheckAgents());
    assert.equal(out, DETECTED);
    assert.deepEqual(seen, [true]);
  }
});

test('recheckAgents: resolves to FALLBACK_AGENTS (never throws) when the server and the IPC both fail', async () => {
  const win = { electronAPI: { setupGetAvailableAgents: async () => { throw new Error('ipc down'); } } };
  const out = await withEnv({ win, fetchImpl: async () => { throw new Error('server down'); } }, () => recheckAgents());
  assert.equal(out, FALLBACK_AGENTS);
});

// ── refreshObjectiveProviders ────────────────────────────────────────────────────────────────

const PAYLOAD = { objectiveProviders: [{ id: 'claude', available: true, models: [{ value: 'opus' }] }], objectiveSelection: 'claude:opus' };

test('refreshObjectiveProviders: dispatches tiptask:providers-changed carrying the payload, and returns it', async () => {
  await withEnv({ fetchImpl: async () => json(PAYLOAD) }, async (events) => {
    assert.deepEqual(await refreshObjectiveProviders(), PAYLOAD);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'tiptask:providers-changed');
    assert.deepEqual(events[0].detail, PAYLOAD);
  });
});

test('refreshObjectiveProviders: an explicit project path wins over location.search', async () => {
  let headers;
  await withEnv({ search: '?projectPath=%2Fold', fetchImpl: async (_u, o) => { headers = o.headers; return json(PAYLOAD); } },
    async () => { await refreshObjectiveProviders('/new'); });
  assert.deepEqual(headers, { 'x-tipatask-project': '/new' });
});

test('refreshObjectiveProviders: no path and no ?projectPath= sends no project header', async () => {
  let headers;
  await withEnv({ fetchImpl: async (_u, o) => { headers = o.headers; return json(PAYLOAD); } }, async () => { await refreshObjectiveProviders(); });
  assert.deepEqual(headers, {});
});

test('refreshObjectiveProviders: null and no event on a failed fetch, a non-ok reply, or a malformed body', async () => {
  for (const fetchImpl of [async () => { throw new Error('boom'); }, async () => json({}, false), async () => json({ nope: 1 })]) {
    await withEnv({ fetchImpl }, async (events) => {
      assert.equal(await refreshObjectiveProviders(), null);
      assert.equal(events.length, 0);
    });
  }
});

// ── notifyServerAgentsSaved ──────────────────────────────────────────────────────────────────

test('notifyServerAgentsSaved: POSTs an applyOnly agents-config for the given project, then re-fetches providers AFTER it', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers, body: opts.body && JSON.parse(opts.body) });
    return url === '/api/objective/providers' ? json(PAYLOAD) : json({ ok: true });
  };
  await withEnv({ fetchImpl }, async (events) => {
    await notifyServerAgentsSaved('/tmp/proj', { availableAgents: ['claude', 'codex'], taskAgent: 'claude' });
    assert.equal(events.length, 1, 'providers-changed fires once the re-fetch lands');
  });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['POST /api/agents-config', 'GET /api/objective/providers']);
  assert.deepEqual(calls[0].body, { availableAgents: ['claude', 'codex'], taskAgent: 'claude', applyOnly: true });
  assert.equal(calls[0].headers['x-tipatask-project'], '/tmp/proj');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(calls[1].headers['x-tipatask-project'], '/tmp/proj', 'the re-fetch is scoped to the same project');
});

test('notifyServerAgentsSaved: a failing POST never throws and the providers re-fetch still runs', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === '/api/agents-config') throw new Error('server down');
    return json(PAYLOAD);
  };
  await withEnv({ fetchImpl }, async () => { await notifyServerAgentsSaved('/p', { availableAgents: ['claude'], taskAgent: 'claude' }); });
  assert.deepEqual(calls, ['/api/agents-config', '/api/objective/providers']);
});
