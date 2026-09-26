'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { applyRehashIntent } = require('./claude-session');
const { buildTurnPrompt } = require('./providers/transcript');
const { createHttpHandler } = require('./ws-handlers');
const config = require('./config');

// Execute the real WS routing closure while replacing provider processes and
// metadata lookups. This checks the boundary between wire payload and model input.
function wire(backend, { simpleMode = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'ws-handlers.js'), 'utf8');
  const start = source.indexOf('function wireClient(');
  const handlers = {}, frames = [], turns = [];
  const session = { type: 'objective', pending: true, messages: [], projectPath: '/fixture', ws: null };
  const ws = { OPEN: 1, readyState: 1, send: text => frames.push(JSON.parse(text)), on: (name, fn) => { handlers[name] = fn; } };
  session.ws = ws;
  const env = {
    config: { SIMPLE_MODE: simpleMode }, console: { log() {}, warn() {} },
    process: { env: { OBJECTIVE_RESPONSE_CACHE_ENABLED: '0' } },
    prefetchObjectiveWorkflow: async () => ({ bundle: '', elapsedMs: 0 }),
    getStaticBundle: () => 'PROJECT KNOWLEDGE', buildLanguageDirective: () => '',
    getStaticBundleStats: () => ({ chars: 17, sha: 'fixture', tagsCount: 0 }),
    getTaskAgentInfo: () => ({}), configForProject: () => ({}), listVisibleObjectiveProviders: () => [],
    getAvailableAgentsPeek: () => [], listTaskAgentStatusesPeek: () => [], _agentLabels: () => ({}),
    wireSessionLifecycle() {}, ensureSessionStartName: async () => {}, applyModelSelection: () => ({}),
    applyRehashIntent, maybeCompressHistory: async () => {},
    _throttledSpawn: (_id, _session, spawn) => spawn(),
    spawnTurn: s => turns.push({ system: s.systemPrompt, prompt: buildTurnPrompt(s, { includeSystemPrompt: false, freshSource: 'firstPrompt' }).prompt }),
    providerSessionId: () => 'fixture', killPrewarm() {},
    clearContext: s => { s.messages = []; s._providerSwitchPending = false; },
    throttle: { recordAbort() {} },
  };
  vm.createContext(env);
  vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), env);
  env.wireClient(ws, session, 'obj-fixture', 'fixture', new Map(), backend);
  return { handlers, frames, turns, session };
}

for (const simpleMode of [false, true]) {
  for (const intent of [{}, { rehashIntent: null }]) {
    test(`plain New Objective wire payload: ${simpleMode ? 'simple' : 'normal'} mode, ${'rehashIntent' in intent ? 'null' : 'omitted'} intent`, async () => {
      const { handlers, frames, turns, session } = wire({
        async getTask() { assert.fail('plain New Objective must not fetch a Rehash task'); },
      }, { simpleMode });
      const userText = 'Build a calendar';
      const prompt = `Objective from the user:\n\n${userText}`;
      await handlers.message(JSON.stringify({
        type: 'start', mode: 'objective', userText, prompt,
        systemPrompt: 'READ-ONLY PLANNER', ...intent,
      }));
      assert.equal(turns.length, 1);
      const expectedSystem = simpleMode ? '' : 'READ-ONLY PLANNER\n\nPROJECT KNOWLEDGE';
      assert.equal(turns[0].system, expectedSystem);
      assert.equal(turns[0].prompt, prompt);
      assert.equal(session.firstPrompt, prompt);
      assert.deepEqual(Array.from(session.messages, ({ role, content }) => ({ role, content })), [
        { role: 'user', content: userText },
      ]);
      await handlers.message(JSON.stringify({ type: 'chat', content: 'Include reminders', ...intent }));
      assert.equal(turns.length, 2);
      assert.equal(turns[1].system, expectedSystem);
      assert.doesNotMatch(JSON.stringify({ frames, messages: session.messages, turns }), /<\/?rehash-(?:split|discuss)>/);
      assert.ok(!frames.some(frame => frame.type === 'error' || frame.type === 'objective-error'));
    });
  }
}

test('start/chat/restart route split metadata to hidden system context; exit clears it', async () => {
  const { handlers, frames, turns, session } = wire({ async getTask(key) {
    assert.equal(key, 'TPT210');
    return { id: key, title: 'Upload files', description: 'Validate file types and display progress.' };
  } });
  await handlers.message(JSON.stringify({ type: 'start', mode: 'objective', userText: 'Split the task', prompt: 'Split the task', rehashIntent: 'split', taskKey: 'TPT210' }));
  assert.equal(turns.length, 1);
  assert.match(turns[0].system, /Upload files/);
  assert.equal(turns[0].prompt, 'Split the task');
  assert.equal(session.messages[0].content, 'Split the task');
  await handlers.message(JSON.stringify({ type: 'restart', rehashIntent: 'split', taskKey: 'TPT210' }));
  assert.equal(turns.length, 2);
  assert.match(turns[1].system, /rehash-split/);
  await handlers.message(JSON.stringify({ type: 'chat', content: 'Plan something else', rehashIntent: null }));
  assert.equal(turns.length, 3);
  assert.doesNotMatch(turns[2].system, /rehash-split/);
  assert.doesNotMatch(JSON.stringify(frames), /Validate file types|<rehash-split>/);
});

test('discuss routes the refine directive to system context only; transcript, prompt and frames stay clean', async () => {
  const { handlers, frames, turns, session } = wire({ async getTask(key) {
    assert.equal(key, 'TPT179');
    return { id: key, title: 'Pinned card preview', description: 'Show the task at the top of the chat.', tags: ['feature'] };
  } });
  await handlers.message(JSON.stringify({ type: 'start', mode: 'objective', userText: 'improve this', prompt: 'improve this', rehashIntent: 'discuss', taskKey: 'TPT179' }));
  assert.equal(turns.length, 1);
  assert.match(turns[0].system, /<rehash-discuss>/);
  assert.match(turns[0].system, /Pinned card preview/);
  assert.equal(turns[0].prompt, 'improve this');
  assert.equal(session.messages[0].content, 'improve this');
  assert.equal(session.firstPrompt, 'improve this');
  assert.doesNotMatch(JSON.stringify(session.messages), /rehash-discuss|Pinned card preview|modified/);
  await handlers.message(JSON.stringify({ type: 'chat', content: 'Tighten the scope', rehashIntent: 'discuss', taskKey: 'TPT179' }));
  assert.equal(turns.length, 2);
  assert.equal(turns[1].system.split('<rehash-discuss>').length, 2); // follow-up does not duplicate it
  await handlers.message(JSON.stringify({ type: 'chat', content: 'Plan something else', rehashIntent: null }));
  assert.equal(turns.length, 3);
  assert.doesNotMatch(turns[2].system, /rehash-discuss/);
  assert.doesNotMatch(JSON.stringify(frames), /Show the task at the top|<rehash-discuss>/);
});

test('chat draft HTTP round-trip preserves split and discuss context and removes it on ordinary save', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rehash-chat-'));
  const previous = config.USER_DATA_ROOT;
  config.USER_DATA_ROOT = root;
  const handler = createHttpHandler(new Map(), () => ({}));
  async function request(method, payload) {
    const req = Readable.from(payload ? [JSON.stringify(payload)] : []);
    Object.assign(req, { method, url: '/api/objective/chat-draft', headers: {} });
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await handler(req, res);
    assert.equal(res.status, 200);
    return res.body;
  }
  try {
    for (const [mode, taskKey, text] of [['split', 'TPT210', 'Split the task'], ['discuss', 'TPT179', 'improve this']]) {
      await request('POST', { taskId: 'obj-fixture', messages: [{ role: 'user', content: text }], rehashIntent: mode, taskKey });
      const restored = await request('GET');
      assert.equal(restored.rehashIntent, mode);
      assert.equal(restored.taskKey, taskKey);
      assert.equal(restored.messages[0].content, text);
      assert.equal(restored.lockReleased, false);
    }
    // TPT283 — a saved split keeps its intent but round-trips the board-lock release.
    await request('POST', { taskId: 'obj-fixture', messages: [{ role: 'user', content: 'Split' }], rehashIntent: 'split', taskKey: 'TPT210', lockReleased: true });
    const released = await request('GET');
    assert.equal(released.rehashIntent, 'split');
    assert.equal(released.taskKey, 'TPT210');
    assert.equal(released.lockReleased, true);
    await request('POST', { taskId: 'obj-normal', messages: [{ role: 'user', content: 'New objective' }] });
    const normal = await request('GET');
    assert.equal(normal.rehashIntent, null);
    assert.equal(normal.taskKey, null);
    assert.equal(normal.lockReleased, false);
  } finally {
    config.USER_DATA_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
