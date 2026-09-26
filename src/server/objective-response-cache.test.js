'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const objectiveResponseCache = require('./objective-response-cache');

const { buildKey } = objectiveResponseCache;

const TASK_ID = 'TPT355';
const PROJECT_PATH = '/fixture-project';

// Runs the real `wireClient` start handler from ws-handlers.js with the response cache ENABLED
// (rehash-chat.test.js's harness turns it off, which is how a bare out-of-scope `projectPath`
// in the lookup went unnoticed). Only process/provider/metadata collaborators are stubbed;
// objective-response-cache.js is the real module.
function wire({ session: sessionOverrides = {}, config: configOverrides = {}, env: processEnv = {}, tasks } = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'ws-handlers.js'), 'utf8');
  const start = source.indexOf('function wireClient(');
  const handlers = {}, frames = [], turns = [], warns = [];
  const session = {
    type: 'objective', pending: true, messages: [], projectPath: PROJECT_PATH, ws: null,
    providerType: 'claude', selectedModel: 'claude-sonnet-5', ...sessionOverrides,
  };
  const ws = { OPEN: 1, readyState: 1, send: text => frames.push(JSON.parse(text)), on: (name, fn) => { handlers[name] = fn; } };
  session.ws = ws;
  const fixtureTasks = tasks || [
    { id: TASK_ID, status: 'in_progress', tags: ['Bugfix', 'caching'] },
    { id: 'TPT356', status: 'pending', tags: [] },
    { id: 'TPT357', status: 'completed', tags: [] },
  ];
  const env = {
    config: { SIMPLE_MODE: false, PROJECT_ROOT: '/config-project-root', ...configOverrides },
    console: { log() {}, warn: (...args) => warns.push(args.join(' ')) },
    process: { env: processEnv },
    taskCache: { getTasks: async () => fixtureTasks },
    objectiveResponseCache,
    prefetchObjectiveWorkflow: async () => ({ bundle: '', elapsedMs: 0 }),
    getStaticBundle: () => 'PROJECT KNOWLEDGE', buildLanguageDirective: () => '',
    getStaticBundleStats: () => ({ chars: 17, sha: 'fixture', tagsCount: 0 }),
    getTaskAgentInfo: () => ({}), configForProject: () => ({}), listVisibleObjectiveProviders: () => [],
    // session.selectedModel is set (the cache key needs it), so the config frame resolves a selection
    currentSelection: s => ({ providerId: s.providerType, model: s.selectedModel }),
    clampSelectionToProviders: sel => sel, formatSelection: (providerId, model) => `${providerId}:${model}`,
    getAvailableAgentsPeek: () => [], listTaskAgentStatusesPeek: () => [], _agentLabels: () => ({}),
    wireSessionLifecycle() {}, ensureSessionStartName: async () => {}, applyModelSelection: () => ({}),
    applyRehashIntent: async () => {}, maybeCompressHistory: async () => {},
    _throttledSpawn: (_id, _session, spawn) => spawn(),
    spawnTurn: () => turns.push(true),
    providerSessionId: () => 'fixture', killPrewarm() {},
    clearContext: s => { s.messages = []; s._providerSwitchPending = false; },
    throttle: { recordAbort() {} },
  };
  vm.createContext(env);
  vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), env);
  env.wireClient(ws, session, TASK_ID, 'fixture', new Map(), {});
  return { handlers, frames, turns, warns, session, tasks: fixtureTasks };
}

const USER_TEXT = 'Add a retry button to the export dialog';
const startMsg = () => JSON.stringify({
  type: 'start', mode: 'objective', userText: USER_TEXT, prompt: `Objective from the user:\n\n${USER_TEXT}`,
  systemPrompt: 'READ-ONLY PLANNER',
});

function expectedKey({ tasks, projectPath = PROJECT_PATH, provider = 'claude', model = 'claude-sonnet-5' }) {
  return buildKey({
    taskId: TASK_ID, task: tasks.find(t => t.id === TASK_ID) || null, tasks, userText: USER_TEXT,
    projectPath, provider, model,
  });
}

test.beforeEach(() => objectiveResponseCache.invalidateAll());

test('first-turn lookup with a valid project root misses cleanly, records the key, and spawns', async () => {
  const { handlers, frames, turns, warns, session, tasks } = wire();
  await handlers.message(startMsg());
  assert.deepEqual(warns.filter(w => /lookup error/.test(w)), []);
  assert.equal(session._objectiveCacheKey, expectedKey({ tasks }));
  assert.equal(session._objectiveCacheTaskId, TASK_ID);
  assert.equal(turns.length, 1);
  assert.ok(!frames.some(f => f.type === 'objective-result'));
});

test('first-turn lookup replays a cached payload instead of spawning', async () => {
  const { handlers, frames, turns, warns, session, tasks } = wire();
  objectiveResponseCache.set(expectedKey({ tasks }), {
    content: 'cached answer', tokens: { input: 1, output: 2 }, cards: [], filesAddressed: [],
    docUpdates: [], newTags: ['caching'], objectiveSummary: null, cachedAt: Date.now(),
  });
  await handlers.message(startMsg());
  assert.deepEqual(warns.filter(w => /lookup error/.test(w)), []);
  assert.equal(turns.length, 0);
  const result = frames.find(f => f.type === 'objective-result');
  assert.ok(result, 'objective-result frame emitted');
  assert.equal(result.fromCache, true);
  assert.equal(result.content, 'cached answer');
  assert.ok(frames.some(f => f.type === 'chat-ready'));
  const assistant = session.messages[session.messages.length - 1];
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.fromCache, true);
  assert.deepEqual(Array.from(assistant.newTags), ['caching']);
});

test('lookup key is scoped to the session project root, falling back to config.PROJECT_ROOT', async () => {
  const a = wire({ session: { projectPath: '/project-a' } });
  await a.handlers.message(startMsg());
  const b = wire({ session: { projectPath: '/project-b' } });
  await b.handlers.message(startMsg());
  assert.equal(a.session._objectiveCacheKey, expectedKey({ tasks: a.tasks, projectPath: '/project-a' }));
  assert.equal(b.session._objectiveCacheKey, expectedKey({ tasks: b.tasks, projectPath: '/project-b' }));
  assert.notEqual(a.session._objectiveCacheKey, b.session._objectiveCacheKey);

  const fallback = wire({ session: { projectPath: undefined } });
  await fallback.handlers.message(startMsg());
  assert.equal(fallback.session._objectiveCacheKey,
    expectedKey({ tasks: fallback.tasks, projectPath: '/config-project-root' }));
});

test('lookup is skipped when OBJECTIVE_RESPONSE_CACHE_ENABLED=0 or SIMPLE_MODE is on', async () => {
  for (const opts of [{ config: { SIMPLE_MODE: true } }, { env: { OBJECTIVE_RESPONSE_CACHE_ENABLED: '0' } }]) {
    const w = wire(opts);
    await w.handlers.message(startMsg());
    assert.equal(w.session._objectiveCacheKey, undefined);
    assert.equal(w.turns.length, 1);
  }
});

test('buildKey is stable and sensitive to each input it documents', () => {
  const tasks = [{ id: TASK_ID, status: 'pending', tags: ['b', 'A'] }, { id: 'x', status: 'completed', tags: [] }];
  const base = { taskId: TASK_ID, task: tasks[0], tasks, userText: ' hello ', projectPath: '/p', provider: 'claude', model: 'm1' };
  const key = buildKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(buildKey({ ...base }), key);
  // userText is trimmed; tag order/case do not matter
  assert.equal(buildKey({ ...base, userText: 'hello' }), key);
  assert.equal(buildKey({ ...base, task: { ...tasks[0], tags: ['a', 'B'] } }), key);
  for (const change of [
    { projectPath: '/other' }, { provider: 'codex' }, { model: 'm2' }, { userText: 'different' },
    { taskId: 'other' }, { task: { ...tasks[0], status: 'in_progress' } },
    { tasks: [...tasks, { id: 'y', status: 'pending', tags: [] }] },
  ]) {
    assert.notEqual(buildKey({ ...base, ...change }), key, `key must change with ${Object.keys(change)[0]}`);
  }
  // Omitted optional inputs hash as empty strings, never throw
  assert.doesNotThrow(() => buildKey({ taskId: TASK_ID, task: null, tasks: [], userText: '' }));
});
