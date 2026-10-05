'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

// Task-chat WS lifecycle through the real ws-handlers.js (vm sandbox, same approach as
// objective-teardown-wiring.test.js): start seeds the task and its comments and spawns through
// the provider dispatcher, follow-ups spawn again, the session survives its socket, and a
// reconnect gets `chat-history-reset` instead of a second start. Provider dispatch, the Claude
// session module and the throttle are spies — no CLI is ever spawned.
const SOURCE = path.join(__dirname, 'ws-handlers.js');
const CHAT_ID = 'taskChat:TPT1';
const TASK = { id: 'TPT1', title: 'Fix the thing', description: 'TASK_BODY_MARKER', status: 'pending', tags: [], priority: 5 };
const COMMENTS = [{ id: 1, content: 'COMMENT_MARKER', created_at: '2026-01-01T00:00:00.000Z', user: { name: 'Anton' } }];

function spyModule(calls, prefix, overrides = {}) {
  return new Proxy(overrides, {
    get(target, name) {
      if (Object.hasOwn(target, name)) return target[name];
      if (typeof name !== 'string') return undefined;
      return (...args) => { calls.push([`${prefix}.${name}`, ...args]); };
    },
  });
}

function harness({ provider = 'claude', applyModelSelection } = {}) {
  const calls = [];
  const config = { ...require('./config'), SIMPLE_MODE: false, OBJECTIVE_PROVIDER: provider,
    PROJECT_ROOT: '/proj/a', API_PROJECT_ID: null };
  const realRequire = createRequire(SOURCE);
  const mocks = {
    './config': config,
    './claude-session': spyModule(calls, 'claude', {
      startSleepWatchdog() {},
      objectiveCacheActivity: () => ({}),
    }),
    './objective-throttle': spyModule(calls, 'throttle', {
      getStatus: () => ({ active: 0, pending: 0 }),
      subscribe() {},
    }),
    './context-manager': spyModule(calls, 'ctx'),
    './providers/dispatch': spyModule(calls, 'dispatch', {
      applyModelSelection: applyModelSelection || (() => ({ changed: false })),
    }),
    './providers/registry': spyModule(calls, 'registry', {
      configForProject: () => config,
      listVisibleObjectiveProviders: () => [],
      listObjectiveProviders: () => [],
      currentSelection: session => ({ providerId: session.providerType, model: 'model-x' }),
      formatSelection: (providerId, model) => `${providerId}:${model}`,
    }),
    './task-agent': spyModule(calls, 'agent', {
      getTaskAgentInfo: () => ({ id: 'claude', label: 'Claude' }),
      getTaskAgentLabels: () => ({}),
      getAvailableAgentsPeek: () => [],
      listTaskAgentStatusesPeek: () => [],
    }),
    './arch-cache-prewarm': spyModule(calls, 'arch'),
    './websocket': spyModule(calls, 'websocket'),
  };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, __dirname, __filename: SOURCE,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
    console: { log() {}, warn() {}, error() {} },
    process, URL, URLSearchParams, Buffer, AbortController, TextEncoder, TextDecoder, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
  };
  vm.runInNewContext(fs.readFileSync(SOURCE, 'utf8'), sandbox, { filename: SOURCE });
  const named = prefix => calls.filter(c => c[0] === prefix);
  return { ctx: sandbox, exports: module.exports, calls, named, config };
}

function fakeWs() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.frames = [];
  ws.closed = false;
  ws.send = raw => ws.frames.push(JSON.parse(raw));
  ws.close = () => { ws.closed = true; ws.readyState = 3; };
  return ws;
}

function fakeBackend(overrides = {}) {
  return {
    getTask: async key => (key === 'TPT1' ? TASK : null),
    getTaskComments: async () => COMMENTS,
    ...overrides,
  };
}

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
const send = async (ws, msg) => { ws.emit('message', JSON.stringify(msg)); await flush(); };
const framesOf = (ws, type) => ws.frames.filter(f => f.type === type);

async function connect(h, sessions, backend, id = CHAT_ID, projectPath = '', query = '') {
  const ws = fakeWs();
  await h.exports.handleConnection(ws, { url: `/?taskId=${encodeURIComponent(id)}${query}`, headers: { host: 'localhost', 'x-tiptask-project-path': projectPath } }, sessions, () => backend, null, null, () => backend);
  return ws;
}

async function startedChat(h, { backend = fakeBackend(), start = {} } = {}) {
  const sessions = new Map();
  const ws = await connect(h, sessions, backend);
  await send(ws, { type: 'start-task-chat', ...start });
  return { ws, sessions, session: sessions.get(CHAT_ID), backend };
}

test('a promptless connect to a task-chat id is accepted and waits for start', async () => {
  const h = harness();
  const sessions = new Map();
  const ws = await connect(h, sessions, fakeBackend());
  assert.equal(ws.closed, false);
  assert.equal(framesOf(ws, 'error').length, 0);
  assert.equal(sessions.get(CHAT_ID).pending, true);
  assert.equal(h.named('dispatch.spawnTurn').length, 0);
});

function projectBackend(projectId, name = 'Project') {
  return fakeBackend({
    getCredentials: () => ({ projectId }),
    getProjectSettings: async () => ({ id: projectId, name, description: 'PROJECT_BODY_MARKER' }),
    getTasksUnfiltered: async () => [{ id: 'TPT1', title: `${name} task`, status: 'pending', priority: 4 }],
  });
}

test('project connect waits for explicit Start; chosen model applies once without a task lookup', async () => {
  const selected = [];
  const h = harness({ applyModelSelection: (session, model) => {
    selected.push(model);
    session.providerType = 'codex';
    session.selectedModel = 'gpt-6';
    return { changed: true };
  } });
  const sessions = new Map();
  const backend = projectBackend('2', 'Alpha');
  backend.getTask = async () => { throw new Error('project chat must not fetch a selected task'); };
  const ws = await connect(h, sessions, backend, 'projectChat:2', '/proj/a');
  assert.equal(sessions.get('projectChat:2\0/proj/a').pending, true);
  assert.equal(h.named('dispatch.spawnTurn').length, 0);
  await send(ws, { type: 'start-project-chat', model: 'codex:gpt-6' });
  const session = sessions.get('projectChat:2\0/proj/a');
  assert.equal(session.type, 'taskChat');
  assert.equal(session.taskKey, null);
  assert.equal(session.chatProjectId, '2');
  assert.equal(session.toolProfile, 'taskChat');
  assert.match(session.messages[0].content, /PROJECT_BODY_MARKER/);
  assert.match(session.messages[0].content, /Alpha task/);
  assert.match(session.systemPrompt, /PROJECT CHAT/);
  assert.deepEqual(selected, ['codex:gpt-6']);
  assert.equal(h.named('dispatch.spawnTurn').length, 1);
  await send(ws, { type: 'start-project-chat', model: 'claude:x' });
  assert.equal(h.named('dispatch.spawnTurn').length, 1);
  assert.deepEqual(selected, ['codex:gpt-6']);
});

test('project reconnect restores its history and refuses another project identity', async () => {
  const h = harness();
  const sessions = new Map();
  const a = projectBackend('2', 'Alpha');
  const b = projectBackend('3', 'Beta');
  const wsA = await connect(h, sessions, a, 'projectChat:2', '/proj/a');
  await send(wsA, { type: 'start-project-chat' });
  const sessionA = sessions.get('projectChat:2\0/proj/a');
  sessionA.messages.push({ role: 'assistant', content: 'ALPHA_HISTORY', timestamp: 1 });
  wsA.emit('close');
  const wrong = await connect(h, sessions, b, 'projectChat:2', '/proj/b');
  assert.equal(wrong.closed, true);
  assert.match(framesOf(wrong, 'error')[0].message, /does not match/);
  assert.equal(sessions.size, 1);
  const wsB = await connect(h, sessions, b, 'projectChat:3', '/proj/b');
  await send(wsB, { type: 'start-project-chat' });
  assert.doesNotMatch(sessions.get('projectChat:3\0/proj/b').messages[0].content, /ALPHA_HISTORY|Alpha/);
  const restored = await connect(h, sessions, a, 'projectChat:2', '/proj/a');
  assert.equal(framesOf(restored, 'chat-history-reset')[0].projectId, '2');
  assert.match(framesOf(restored, 'chat-history-reset')[0].messages[1].content, /ALPHA_HISTORY/);
  assert.equal(h.named('dispatch.spawnTurn').length, 2, 'reconnect never starts another turn');
});

test('(TPT469) chats of one project are separate sessions; the first user message names each', async () => {
  const h = harness();
  const sessions = new Map();
  const backend = projectBackend('2', 'Alpha');
  const A = 'projectChat:2:aaaaaa1';
  const B = 'projectChat:2:bbbbbb2';
  const wsA = await connect(h, sessions, backend, A, '/proj/a');
  await send(wsA, { type: 'start-project-chat' });
  const wsB = await connect(h, sessions, backend, B, '/proj/a');
  await send(wsB, { type: 'start-project-chat' });
  const a = sessions.get(`${A}\0/proj/a`);
  const b = sessions.get(`${B}\0/proj/a`);
  assert.ok(a && b && a !== b);
  assert.equal(a.chatProjectId, '2');
  assert.equal(h.exports.sessionMetaRow(a).title, '', 'a started chat with only the seed turn is still a draft');
  assert.equal(h.exports.sessionMetaRow(a).chatProjectId, '2');
  await send(wsA, { type: 'task-chat-message', content: 'Which tasks block the release? Asking for the demo.' });
  assert.equal(a.chatTitle, 'Which tasks block the release?');
  assert.deepEqual(framesOf(wsA, 'project-chat-titled').map(f => f.title), ['Which tasks block the release?']);
  assert.equal(h.exports.sessionMetaRow(a).title, 'Which tasks block the release?');
  assert.equal(h.exports.sessionMetaRow(a).taskKey, undefined, 'a project chat row carries no task key (TPT526)');
  assert.equal(b.chatTitle, undefined, 'the other chat is untouched');
  assert.equal(framesOf(wsB, 'project-chat-titled').length, 0);
  await send(wsA, { type: 'task-chat-message', content: 'And the next one?' });
  assert.equal(a.chatTitle, 'Which tasks block the release?', 'later messages keep the name');
  assert.equal(framesOf(wsA, 'project-chat-titled').length, 1);
  assert.equal(b.messages.some(m => /block the release/.test(m.content)), false, 'transcripts stay apart');
  wsA.emit('close');
  const back = await connect(h, sessions, backend, A, '/proj/a');
  const reset = framesOf(back, 'chat-history-reset')[0];
  assert.equal(reset.title, 'Which tasks block the release?');
  assert.ok(reset.messages.some(m => m.content === 'And the next one?'));
  const other = await connect(h, sessions, projectBackend('3', 'Beta'), A, '/proj/b');
  assert.equal(other.closed, true, 'another project cannot open this chat');
  assert.match(framesOf(other, 'error')[0].message, /does not match/);
});

test('(TPT469) terminate-on-connect ends a project chat and tells its window', async () => {
  const h = harness();
  const sessions = new Map();
  const backend = projectBackend('2');
  const id = 'projectChat:2:cccccc3';
  const ws = await connect(h, sessions, backend, id, '/proj/a');
  await send(ws, { type: 'start-project-chat' });
  const killer = await connect(h, sessions, backend, id, '/proj/a', '&terminate=1');
  assert.equal(sessions.has(`${id}\0/proj/a`), false);
  assert.equal(framesOf(ws, 'chat-ended').length, 1);
  assert.equal(framesOf(killer, 'session-ended')[0].taskId, id);
  assert.equal(framesOf(killer, 'chat-history-reset').length, 0, 'the terminate socket never attaches');
});

test('project Start rejects settings returned for another project', async () => {
  const h = harness();
  const sessions = new Map();
  const backend = projectBackend('2');
  backend.getProjectSettings = async () => ({ id: 3, name: 'Wrong project' });
  const ws = await connect(h, sessions, backend, 'projectChat:2');
  await send(ws, { type: 'start-project-chat' });
  assert.match(framesOf(ws, 'error')[0].message, /do not match/);
  assert.equal(sessions.size, 0);
  assert.equal(h.named('dispatch.spawnTurn').length, 0);
});

test('project chat refuses a terminal prompt on connect', async () => {
  const h = harness();
  const sessions = new Map();
  const ws = await connect(h, sessions, projectBackend('2'), 'projectChat:2', '/proj/a', '&prompt=run');
  assert.equal(ws.closed, true);
  assert.match(framesOf(ws, 'error')[0].message, /start-project-chat/);
  assert.equal(sessions.size, 0);
  assert.equal(h.named('dispatch.spawnTurn').length, 0);
});

test('project chats with the same API id remain separate across project paths', async () => {
  const h = harness();
  const sessions = new Map();
  const a = projectBackend('2', 'Alpha');
  const b = projectBackend('2', 'Beta');
  const wsA = await connect(h, sessions, a, 'projectChat:2', '/proj/a');
  await send(wsA, { type: 'start-project-chat' });
  const wsB = await connect(h, sessions, b, 'projectChat:2', '/proj/b');
  await send(wsB, { type: 'start-project-chat' });
  assert.equal(sessions.size, 2);
  assert.match(sessions.get('projectChat:2\0/proj/a').messages[0].content, /Alpha task/);
  assert.match(sessions.get('projectChat:2\0/proj/b').messages[0].content, /Beta task/);
  assert.equal(framesOf(wsB, 'chat-history-reset').length, 0);
});

test('reconnect during project context fetch retains the pending Start and chosen model', async () => {
  let resolveSettings;
  const settings = new Promise(resolve => { resolveSettings = resolve; });
  const selected = [];
  const h = harness({ applyModelSelection: (_session, model) => { selected.push(model); return { changed: true }; } });
  const sessions = new Map();
  const backend = projectBackend('2', 'Alpha');
  backend.getProjectSettings = () => settings;
  const first = await connect(h, sessions, backend, 'projectChat:2', '/proj/a');
  first.emit('message', JSON.stringify({ type: 'start-project-chat', model: 'codex:gpt-6' }));
  await flush();
  const starting = sessions.get('projectChat:2\0/proj/a');
  assert.equal(starting._projectChatStarting, true);
  first.emit('close');
  const second = await connect(h, sessions, backend, 'projectChat:2', '/proj/a');
  assert.equal(sessions.get('projectChat:2\0/proj/a'), starting);
  assert.equal(framesOf(second, 'chat-history-reset')[0].running, true);
  resolveSettings({ id: '2', name: 'Alpha' });
  await flush();
  assert.equal(starting._projectChatStarting, false);
  assert.equal(starting.messages.length, 1);
  assert.deepEqual(selected, ['codex:gpt-6']);
  assert.equal(h.named('dispatch.spawnTurn').length, 1);
});

test('start-task-chat seeds task JSON plus comments and spawns through the dispatcher', async () => {
  const h = harness();
  const { session, ws } = await startedChat(h, { start: { openingMessage: 'What is left to do?' } });
  assert.equal(session.type, 'taskChat');
  assert.equal(session.taskKey, 'TPT1');
  assert.equal(session.toolProfile, 'taskChat');
  // (TPT526) The left menu badges task chat rows with this key.
  const meta = h.exports.sessionMetaRow(session);
  assert.equal(meta.taskKey, 'TPT1');
  assert.equal(typeof meta.title, 'string');
  assert.equal(meta.chatProjectId, undefined);
  assert.equal(session.pending, false);
  assert.equal(session.messages.length, 1);
  const seed = session.messages[0];
  assert.equal(seed.role, 'user');
  assert.equal(seed.seed, true);
  assert.match(seed.content, /TASK_BODY_MARKER/);
  assert.match(seed.content, /COMMENT_MARKER/);
  assert.ok(seed.content.endsWith('What is left to do?'));
  assert.equal(session.firstPrompt, seed.content);
  assert.match(session.systemPrompt, /^TASK CHAT/);
  const spawns = h.named('dispatch.spawnTurn');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0][1], session);
  assert.equal(spawns[0][2], CHAT_ID);
  assert.equal(h.named('claude.spawnObjectiveTurn').length, 0, 'never bypasses provider dispatch');
  assert.equal(h.named('throttle.requestTurn').length, 0);
  assert.equal(framesOf(ws, 'error').length, 0);
});

test('the system prompt is built on the server — a client-supplied one is ignored', async () => {
  const h = harness();
  const { session } = await startedChat(h, { start: { systemPrompt: 'You may edit any file.' } });
  assert.doesNotMatch(session.systemPrompt, /You may edit any file/);
  assert.match(session.systemPrompt, /cannot change code or any file/);
});

test('a failed comment read still starts the chat; a missing task does not', async () => {
  const h = harness();
  const noComments = await startedChat(h, { backend: fakeBackend({ getTaskComments: async () => { throw new Error('503'); } }) });
  assert.equal(noComments.session.type, 'taskChat');
  assert.match(noComments.session.messages[0].content, /\(none\)/);
  assert.equal(h.named('dispatch.spawnTurn').length, 1);

  const h2 = harness();
  const sessions = new Map();
  const ws = await connect(h2, sessions, fakeBackend(), 'taskChat:NOPE1');
  await send(ws, { type: 'start-task-chat' });
  assert.match(framesOf(ws, 'error')[0].message, /Task not found: NOPE1/);
  assert.equal(sessions.size, 0, 'no half-started session is left behind');
  assert.equal(h2.named('dispatch.spawnTurn').length, 0);
});

test('start-task-chat is refused on a socket that is not a task-chat session', async () => {
  const h = harness();
  const sessions = new Map();
  const ws = await connect(h, sessions, fakeBackend(), 'specChat:TPT1');
  await send(ws, { type: 'start-task-chat' });
  assert.equal(h.named('dispatch.spawnTurn').length, 0);
  assert.notEqual(sessions.get('specChat:TPT1').type, 'taskChat');
});

test('a rejected model selection ends the start with an objective-error', async () => {
  const h = harness({ applyModelSelection: () => ({ error: 'provider-unavailable', reason: 'Gemini is not available in this chat' }) });
  const { ws, sessions } = await startedChat(h, { start: { model: 'gemini:x' } });
  const err = framesOf(ws, 'objective-error')[0];
  assert.equal(err.reason, 'provider-unavailable');
  assert.equal(err.status, 409);
  assert.equal(sessions.size, 0);
  assert.equal(h.named('dispatch.spawnTurn').length, 0);
});

test('a server default the profile cannot run on is replaced before the prompt is built', async () => {
  const h = harness({ provider: 'gemini' });
  const { session } = await startedChat(h);
  assert.equal(session.providerType, 'claude');
  assert.equal(session._taskChatPromptProvider, 'claude');
});

test('task-chat-message appends the user turn and spawns again', async () => {
  const h = harness();
  const { session, ws } = await startedChat(h);
  session.messages.push({ role: 'assistant', content: 'Summary.', timestamp: 1 });
  await send(ws, { type: 'task-chat-message', content: '  Rename it to Foo  ' });
  assert.deepEqual(session.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(session.messages[2].content, 'Rename it to Foo');
  assert.equal(h.named('dispatch.spawnTurn').length, 2);
});

test('task-chat-message is rejected mid-turn and when empty, with an error frame', async () => {
  const h = harness();
  const { session, ws } = await startedChat(h);
  session.proc = { pid: 1 };
  await send(ws, { type: 'task-chat-message', content: 'again' });
  assert.match(framesOf(ws, 'error').at(-1).message, /still in progress/);
  session.proc = null;
  session._spawning = true;
  await send(ws, { type: 'task-chat-message', content: 'again' });
  session._spawning = false;
  await send(ws, { type: 'task-chat-message', text: 'wrong field' });
  assert.match(framesOf(ws, 'error').at(-1).message, /`content`/);
  assert.equal(session.messages.length, 1);
  assert.equal(h.named('dispatch.spawnTurn').length, 1);
});

test('the system prompt is rebuilt when the provider changes, and only then', async () => {
  let pick = null;
  const h = harness({ applyModelSelection: (session) => {
    if (pick) { session.providerType = pick; return { changed: true, providerChanged: true }; }
    return { changed: false };
  } });
  const { session, ws } = await startedChat(h);
  session.systemPrompt += '\n\nTAG_BUNDLE';
  await send(ws, { type: 'task-chat-message', content: 'one' });
  assert.match(session.systemPrompt, /TAG_BUNDLE/, 'same provider keeps the cached prefix');
  pick = 'pi';
  await send(ws, { type: 'task-chat-message', content: 'two' });
  assert.match(session.systemPrompt, /tipatask_api/);
  assert.doesNotMatch(session.systemPrompt, /TAG_BUNDLE/);
});

test('closing the socket keeps the session, idle or mid-turn', async () => {
  for (const proc of [null, { pid: 7 }]) {
    const h = harness();
    const { session, ws, sessions } = await startedChat(h);
    session.proc = proc;
    ws.emit('close');
    await flush();
    assert.equal(sessions.get(CHAT_ID), session);
    assert.equal(session.ws, null);
    assert.equal(h.named('claude.teardownObjectiveSession').length, 0);
  }
});

test('a socket that never started is dropped on close', async () => {
  const h = harness();
  const sessions = new Map();
  const ws = await connect(h, sessions, fakeBackend());
  ws.emit('close');
  await flush();
  assert.equal(sessions.size, 0);
});

test('reconnect returns chat-history-reset with the stored history and starts nothing new', async () => {
  const h = harness();
  const { session, ws, sessions, backend } = await startedChat(h);
  session.messages.push({ role: 'assistant', content: 'Summary.', timestamp: 1 });
  ws.emit('close');

  const ws2 = await connect(h, sessions, backend);
  const reset = framesOf(ws2, 'chat-history-reset');
  assert.equal(reset.length, 1);
  assert.equal(ws2.frames[0].type, 'chat-history-reset', 'history arrives before anything else');
  assert.equal(reset[0].taskKey, 'TPT1');
  assert.equal(reset[0].running, false);
  assert.equal(reset[0].historyTotalCount, 2);
  assert.equal(reset[0].objectiveSelection, 'claude:model-x');
  assert.deepEqual(reset[0].messages.map(m => [m.role, !!m.seed]), [['user', true], ['assistant', false]]);
  assert.equal(framesOf(ws2, 'chat-ready').length, 1);
  assert.equal(sessions.get(CHAT_ID), session, 'the same session object is reattached');
  assert.equal(session.ws, ws2);

  await send(ws2, { type: 'start-task-chat' });
  assert.equal(session.messages.length, 2, 'a second start on a live chat is ignored');
  assert.equal(h.named('dispatch.spawnTurn').length, 1);
});

test('reconnect mid-turn replays the partial reply and reports running', async () => {
  const h = harness();
  const { session, ws, sessions, backend } = await startedChat(h);
  session.proc = { pid: 7 };
  session.turnBuffer = 'partial reply';
  ws.emit('close');
  const ws2 = await connect(h, sessions, backend);
  assert.equal(framesOf(ws2, 'chat-history-reset')[0].running, true);
  assert.deepEqual(framesOf(ws2, 'data').map(f => f.data), ['partial reply']);
  assert.equal(framesOf(ws2, 'chat-ready').length, 0);
});

test('a turn that finished while detached is closed out on reconnect', async () => {
  const h = harness();
  const { session, ws, sessions, backend } = await startedChat(h);
  ws.emit('close');
  session.messages.push({ role: 'assistant', content: 'Done while away.', timestamp: 2 });
  session.pendingResult = { content: 'Done while away.', tokens: { input: 1, output: 2 }, turnIndex: 1, code: 0 };
  const ws2 = await connect(h, sessions, backend);
  assert.equal(framesOf(ws2, 'chat-history-reset')[0].messages.at(-1).content, 'Done while away.');
  assert.equal(framesOf(ws2, 'objective-result')[0].content, 'Done while away.');
  assert.equal(framesOf(ws2, 'chat-ready')[0].turnIndex, 1);
  assert.equal(framesOf(ws2, 'exit')[0].chatContinues, true);
  assert.equal(session.pendingResult, null);
});

test('a second client displaces the first without ending the chat', async () => {
  const h = harness();
  const { session, ws, sessions, backend } = await startedChat(h);
  const ws2 = await connect(h, sessions, backend);
  assert.equal(framesOf(ws, 'detached').length, 1);
  assert.equal(ws.closed, true);
  ws.emit('close'); // the displaced socket's close must not detach its replacement
  await flush();
  assert.equal(session.ws, ws2);
  assert.equal(sessions.get(CHAT_ID), session);
});

test('abort keeps the seed but drops a typed message', async () => {
  const h = harness();
  const { session, ws } = await startedChat(h);
  await send(ws, { type: 'abort' });
  assert.equal(session.messages.length, 1, 'the seed is the chat context, not a retypeable message');
  assert.equal(framesOf(ws, 'generation-aborted').length, 1);
  await send(ws, { type: 'task-chat-message', content: 'typed' });
  await send(ws, { type: 'abort' });
  assert.deepEqual(session.messages.map(m => !!m.seed), [true]);
});

test('kill tears the chat down and removes it', async () => {
  const h = harness();
  const { session, ws, sessions } = await startedChat(h);
  await send(ws, { type: 'kill' });
  assert.equal(h.named('claude.teardownObjectiveSession').length, 1);
  assert.equal(h.named('claude.teardownObjectiveSession')[0][1], session);
  assert.equal(h.named('claude.killColdPrewarm').length, 0, 'the objective cold spare is not a task chat\'s to kill');
  assert.equal(sessions.size, 0);
  assert.equal(framesOf(ws, 'chat-ended').length, 1);
});

test('a torn-down chat answers session-gone instead of spawning', async () => {
  const h = harness();
  const { session, ws } = await startedChat(h);
  session._closed = true;
  await send(ws, { type: 'task-chat-message', content: 'still there?' });
  assert.equal(ws.frames.filter(f => f.type === 'objective-error' && f.reason === 'session-gone').length, 1);
  assert.equal(h.named('dispatch.spawnTurn').length, 1);
});

test('restart replays from the seed through the dispatcher, unthrottled', async () => {
  const h = harness();
  const { session, ws } = await startedChat(h);
  const seed = session.messages[0];
  session.messages.push({ role: 'assistant', content: 'a', timestamp: 1 }, { role: 'user', content: 'b', timestamp: 2 });
  await send(ws, { type: 'restart' });
  assert.equal(h.named('ctx.clearContext').length, 1);
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0], seed);
  assert.equal(framesOf(ws, 'restarted').length, 1);
  assert.equal(h.named('dispatch.spawnTurn').length, 2);
  assert.equal(h.named('claude.spawnObjectiveTurn').length, 0);
  assert.equal(h.named('throttle.requestTurn').length, 0);
});

// ── Widgets: dialog answers, task events, mid-turn replay ──

const widgets = require('./task-chat-widgets');
const DIALOG_TEXT = 'Pick.\n\n```ask_user\n{"question": "Which sprint?", "options": ["Current", "Backlog"], "multi": false}\n```';

// A chat whose last message is an assistant turn that asked a dialog.
async function askedChat(h) {
  const chat = await startedChat(h);
  const [dialog] = widgets.parseAskUserBlocks(DIALOG_TEXT);
  chat.session.messages.push({ role: 'assistant', content: DIALOG_TEXT, dialogs: [dialog], timestamp: 1 });
  return { ...chat, dialog };
}

test('task-chat-answer records the chosen option as the next user turn and spawns', async () => {
  const h = harness();
  const { session, ws, dialog } = await askedChat(h);
  await send(ws, { type: 'task-chat-answer', dialogId: dialog.id, selected: [1] });
  assert.equal(framesOf(ws, 'error').length, 0);
  const turn = session.messages.at(-1);
  assert.equal(turn.role, 'user');
  assert.equal(turn.content, 'Answer to "Which sprint?": Backlog');
  assert.equal(turn.dialogAnswer.dialogId, dialog.id);
  assert.deepEqual(Array.from(turn.dialogAnswer.selected), ['Backlog']);
  assert.deepEqual(Array.from(dialog.answer.selected), ['Backlog']);
  assert.equal(typeof dialog.answer.at, 'number');
  assert.equal(h.named('dispatch.spawnTurn').length, 2);
  assert.equal(h.named('throttle.requestTurn').length, 0);
});

test('task-chat-answer accepts a free-text answer in place of an option', async () => {
  const h = harness();
  const { session, ws, dialog } = await askedChat(h);
  await send(ws, { type: 'task-chat-answer', dialogId: dialog.id, other: 'The sprint after next' });
  assert.equal(session.messages.at(-1).content, 'Answer to "Which sprint?": The sprint after next');
  assert.equal(h.named('dispatch.spawnTurn').length, 2);
});

test('task-chat-answer is rejected mid-turn, for an unknown or answered dialog, and for a bad pick', async () => {
  const h = harness();
  const { session, ws, dialog } = await askedChat(h);
  const before = session.messages.length;
  const lastError = () => framesOf(ws, 'error').at(-1).message;

  session.proc = { pid: 1 };
  await send(ws, { type: 'task-chat-answer', dialogId: dialog.id, selected: [0] });
  assert.match(lastError(), /still in progress/);
  session.proc = null;

  await send(ws, { type: 'task-chat-answer', dialogId: 'dlg-nope', selected: [0] });
  assert.match(lastError(), /Unknown dialog/);
  await send(ws, { type: 'task-chat-answer', dialogId: dialog.id, selected: [0, 1] });
  assert.match(lastError(), /exactly one/);
  await send(ws, { type: 'task-chat-answer', dialogId: dialog.id, selected: [7] });
  assert.match(lastError(), /option indexes/);
  await send(ws, { type: 'task-chat-answer', dialogId: dialog.id });
  assert.match(lastError(), /at least one/);
  assert.equal(session.messages.length, before);
  assert.equal(dialog.answer, undefined);
  assert.equal(h.named('dispatch.spawnTurn').length, 1);

  await send(ws, { type: 'task-chat-answer', dialogId: dialog.id, selected: [0] });
  assert.equal(h.named('dispatch.spawnTurn').length, 2);
  await send(ws, { type: 'task-chat-answer', dialogId: dialog.id, selected: [1] });
  assert.match(lastError(), /no open dialog/, 'the chat has moved on to the answer turn');
  assert.equal(h.named('dispatch.spawnTurn').length, 2);
});

test('aborting the answer turn re-opens the dialog', async () => {
  const h = harness();
  const { session, ws, dialog } = await askedChat(h);
  await send(ws, { type: 'task-chat-answer', dialogId: dialog.id, selected: [0] });
  assert.ok(dialog.answer);
  await send(ws, { type: 'abort' });
  assert.equal(dialog.answer, undefined);
  assert.equal(session.messages.at(-1).role, 'assistant');
  await send(ws, { type: 'task-chat-answer', dialogId: dialog.id, selected: [1] });
  assert.equal(session.messages.at(-1).content, 'Answer to "Which sprint?": Backlog');
});

test('a torn-down chat answers session-gone to a dialog answer', async () => {
  const h = harness();
  const { session, ws, dialog } = await askedChat(h);
  session._closed = true;
  await send(ws, { type: 'task-chat-answer', dialogId: dialog.id, selected: [0] });
  assert.equal(ws.frames.filter(f => f.type === 'objective-error' && f.reason === 'session-gone').length, 1);
  assert.equal(h.named('dispatch.spawnTurn').length, 1);
});

test('an updated task is read back, sent as task-chat-task and broadcast to the project boards', async () => {
  const h = harness();
  const fresh = { ...TASK, title: 'Renamed by the agent' };
  const { session, ws } = await startedChat(h, { backend: fakeBackend({ getTask: async () => fresh }) });
  session.projectPath = '/proj/a';
  assert.equal(typeof session.onTaskChatMutation, 'function');
  const event = await session.onTaskChatMutation({ action: 'updated', taskKey: 'TPT1', toolId: 'toolu_1' });
  assert.equal(event.task, fresh);
  const frame = framesOf(ws, 'task-chat-task')[0];
  assert.equal(frame.action, 'updated');
  assert.equal(frame.toolId, 'toolu_1');
  assert.equal(frame.taskKey, 'TPT1');
  assert.equal(frame.tabId, session.tabId);
  assert.equal(frame.task.title, 'Renamed by the agent');
  const broadcast = h.named('websocket.emitTaskUpdated');
  assert.equal(broadcast.length, 1);
  assert.equal(broadcast[0][1], fresh);
  assert.equal(broadcast[0][3], '/proj/a');
  assert.equal(h.named('websocket.emitTaskCreated').length, 0);
});

test('a created task is broadcast as task:created; a failed read-back sends nothing', async () => {
  const h = harness();
  const created = { id: 'TPT60', title: 'Follow-up', status: 'pending' };
  let fail = false;
  const { session, ws } = await startedChat(h, { backend: fakeBackend({
    getTask: async (key) => { if (fail) throw new Error('503'); return key === 'TPT60' ? created : TASK; },
  }) });
  await session.onTaskChatMutation({ action: 'created', taskKey: 'TPT60', toolId: 'item_1' });
  assert.equal(framesOf(ws, 'task-chat-task')[0].action, 'created');
  assert.equal(h.named('websocket.emitTaskCreated')[0][1], created);
  assert.equal(h.named('websocket.emitTaskUpdated').length, 0);

  fail = true;
  assert.equal(await session.onTaskChatMutation({ action: 'updated', taskKey: 'TPT1', toolId: 'item_2' }), null);
  assert.equal(framesOf(ws, 'task-chat-task').length, 1);
  assert.equal(h.named('websocket.emitTaskUpdated').length, 0);
});

test('a task changed after the client left is still broadcast to the boards', async () => {
  const h = harness();
  const { session, ws } = await startedChat(h);
  ws.emit('close');
  await flush();
  const event = await session.onTaskChatMutation({ action: 'updated', taskKey: 'TPT1', toolId: 't' });
  assert.equal(event.action, 'updated');
  assert.equal(h.named('websocket.emitTaskUpdated').length, 1);
});

test('reconnect mid-turn replays the running turn\'s widgets; an idle reconnect does not', async () => {
  const h = harness();
  const { session, ws, sessions, backend } = await startedChat(h);
  session.turnBuffer = DIALOG_TEXT;
  widgets.emitDialogs(session, () => {});
  widgets.toolStarted(session, () => {}, { id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } });
  session.proc = { pid: 7 };
  ws.emit('close');
  const ws2 = await connect(h, sessions, backend);
  assert.deepEqual(framesOf(ws2, 'task-chat-tool').map(f => [f.tool.id, f.tool.status, f.tabId]), [['toolu_1', 'running', session.tabId]]);
  assert.equal(framesOf(ws2, 'task-chat-dialog').length, 1);
  const order = ws2.frames.map(f => f.type);
  assert.ok(order.indexOf('chat-history-reset') < order.indexOf('task-chat-tool'));

  session.proc = null;
  ws2.emit('close');
  const ws3 = await connect(h, sessions, backend);
  assert.equal(framesOf(ws3, 'task-chat-tool').length, 0, 'a finished turn\'s widgets come with the history');
});

// A chat whose agent already updated TPT1 (the card the user then opens and edits by hand).
async function chatWithCard(h, edited) {
  let current = TASK;
  const chat = await startedChat(h, { backend: fakeBackend({ getTask: async key => (key === 'TPT1' ? current : null) }) });
  chat.session.messages.push({ role: 'assistant', content: 'Updated it.', taskEvents: [{ action: 'updated', toolId: 'toolu_1', task: TASK }], timestamp: 1 });
  return { ...chat, edit: (patch = edited) => { current = { ...current, ...patch }; return current; } };
}

test('a task the user edited by hand is queued and opens the next user turn as a task_edits block', async () => {
  const h = harness();
  const { session, ws, edit } = await chatWithCard(h);
  const fresh = edit({ title: 'Renamed by hand', status: 'completed' });
  await send(ws, { type: 'task-chat-task-edited', taskKey: 'TPT1' });

  const frame = framesOf(ws, 'task-chat-task-edited')[0];
  assert.equal(frame.taskKey, 'TPT1');
  assert.equal(frame.task.title, 'Renamed by hand');
  assert.deepEqual(Array.from(frame.changed), ['title', 'status']);
  assert.equal(session.messages.at(-1).taskEvents[0].task, fresh, "the chat's own copy of the task is refreshed");
  assert.equal(h.named('dispatch.spawnTurn').length, 1, 'an edit alone starts no turn');
  assert.equal(framesOf(ws, 'error').length, 0);

  await send(ws, { type: 'task-chat-message', content: 'What changed?' });
  const turn = session.messages.at(-1);
  assert.match(turn.content, widgets.TASK_EDITS_RE);
  assert.ok(turn.content.endsWith('\n\nWhat changed?'));
  const body = JSON.parse(turn.content.split('\n')[1]);
  assert.equal(body.tasks[0].task.title, 'Renamed by hand');
  assert.deepEqual(body.tasks[0].changed, ['title', 'status']);
  assert.deepEqual(JSON.parse(JSON.stringify(turn.taskEdits)), [{ taskKey: 'TPT1', changed: ['title', 'status'] }]);
  assert.equal(h.named('dispatch.spawnTurn').length, 2);

  await send(ws, { type: 'task-chat-message', content: 'And now?' });
  assert.equal(session.messages.at(-1).content, 'And now?', 'an edit is told once');
});

test('several saves of one task collapse to its latest state, compared with what the agent last saw', async () => {
  const h = harness();
  const { session, ws, edit } = await chatWithCard(h);
  edit({ title: 'First try' });
  await send(ws, { type: 'task-chat-task-edited', taskKey: 'TPT1' });
  edit({ title: TASK.title, priority: 9 });
  await send(ws, { type: 'task-chat-task-edited', taskKey: 'TPT1' });
  assert.deepEqual(Array.from(framesOf(ws, 'task-chat-task-edited').at(-1).changed), ['priority'], 'the title is back where the agent left it');
  assert.equal(session.pendingTaskEdits.size, 1);

  edit({ priority: TASK.priority });
  await send(ws, { type: 'task-chat-task-edited', taskKey: 'TPT1' });
  assert.equal(session.pendingTaskEdits.size, 0, 'an edit undone by hand leaves nothing to tell');
  await send(ws, { type: 'task-chat-message', content: 'Hi' });
  assert.equal(session.messages.at(-1).content, 'Hi');
});

test('a dialog answer carries queued edits too, and aborting that turn puts them back', async () => {
  const h = harness();
  const { session, ws, edit } = await chatWithCard(h);
  const [dialog] = widgets.parseAskUserBlocks(DIALOG_TEXT);
  session.messages.push({ role: 'assistant', content: DIALOG_TEXT, dialogs: [dialog], timestamp: 2 });
  edit({ title: 'Renamed by hand' });
  await send(ws, { type: 'task-chat-task-edited', taskKey: 'TPT1' });

  await send(ws, { type: 'task-chat-answer', dialogId: dialog.id, selected: [1] });
  const turn = session.messages.at(-1);
  assert.match(turn.content, widgets.TASK_EDITS_RE);
  assert.ok(turn.content.endsWith('\n\nAnswer to "Which sprint?": Backlog'));
  assert.equal(session.pendingTaskEdits.size, 0);

  await send(ws, { type: 'abort' });
  assert.equal(session.pendingTaskEdits.size, 1, 'the aborted turn never told the agent');
  assert.equal(dialog.answer, undefined);
  await send(ws, { type: 'task-chat-message', content: 'Typed instead' });
  assert.match(session.messages.at(-1).content, widgets.TASK_EDITS_RE);
  assert.ok(session.messages.at(-1).content.endsWith('\n\nTyped instead'));
});

test('an edit is accepted mid-turn, and ignored for a bad key, a missing task or a failing read', async () => {
  const h = harness();
  const { session, ws, edit } = await chatWithCard(h);
  session.proc = { pid: 1 };
  edit({ description: 'Rewritten by hand' });
  await send(ws, { type: 'task-chat-task-edited', taskKey: 'TPT1' });
  assert.equal(session.pendingTaskEdits.size, 1, 'queued while the agent is still talking');
  session.proc = null;

  const before = framesOf(ws, 'task-chat-task-edited').length;
  await send(ws, { type: 'task-chat-task-edited', taskKey: '../etc/passwd' });
  await send(ws, { type: 'task-chat-task-edited' });
  await send(ws, { type: 'task-chat-task-edited', taskKey: 'TPT404' });
  session.backend.getTask = async () => { throw new Error('API down'); };
  await send(ws, { type: 'task-chat-task-edited', taskKey: 'TPT1' });
  assert.equal(framesOf(ws, 'task-chat-task-edited').length, before);
  assert.equal(framesOf(ws, 'error').length, 0, 'never an error frame: that would fail the running turn in the window');
  assert.equal(session.pendingTaskEdits.size, 1);
});

test('task-chat-task-edited is not handled on a socket that is not a task chat', async () => {
  const h = harness();
  const sessions = new Map();
  let reads = 0;
  const ws = await connect(h, sessions, fakeBackend({ getTask: async () => { reads += 1; return TASK; } }), 'specChat:TPT1');
  await send(ws, { type: 'task-chat-task-edited', taskKey: 'TPT1' });
  assert.ok(sessions.get('specChat:TPT1'), 'the socket is wired, just not as a task chat');
  assert.equal(framesOf(ws, 'task-chat-task-edited').length, 0);
  assert.equal(reads, 0);
});
