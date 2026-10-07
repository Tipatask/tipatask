'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// spawnTurn() routing. The four provider modules are replaced in the require cache before
// dispatch.js loads, so each call records which provider would have spawned — no CLI runs.
const calls = [];
function stub(relPath, exportsObj) {
  const file = require.resolve(path.join(__dirname, relPath));
  const mod = new Module(file);
  mod.filename = file;
  mod.loaded = true;
  mod.exports = exportsObj;
  require.cache[file] = mod;
}
stub('../claude-session.js', { spawnObjectiveTurn: (s, id) => calls.push(['claude', s, id]), killPrewarm() {}, killColdPrewarm() {} });
stub('./gemini-session.js', { spawnGeminiTurn: (s, id) => calls.push(['gemini', s, id]) });
stub('./pi-session.js', { spawnPiTurn: (s, id) => calls.push(['pi', s, id]) });
stub('./codex-session.js', { spawnCodexTurn: (s, id) => calls.push(['codex', s, id]) });

const { spawnTurn } = require('./dispatch');

function route(session) {
  calls.length = 0;
  const original = console.warn;
  console.warn = () => {};
  try { spawnTurn(session, 'id-1'); } finally { console.warn = original; }
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], session);
  assert.equal(calls[0][2], 'id-1');
  return calls[0][0];
}

test('objective turns go to the session\'s provider', () => {
  for (const provider of ['claude', 'codex', 'pi', 'gemini']) {
    assert.equal(route({ type: 'objective', providerType: provider }), provider);
  }
});

test('spec chat always runs on Claude', () => {
  for (const provider of ['claude', 'codex', 'pi', 'gemini']) {
    assert.equal(route({ type: 'specChat', providerType: provider }), 'claude');
  }
});

test('task chat runs on Claude, Codex and Pi', () => {
  for (const provider of ['claude', 'codex', 'pi']) {
    const session = { type: 'taskChat', toolProfile: 'taskChat', providerType: provider, selectedModel: 'm' };
    assert.equal(route(session), provider);
    assert.equal(session.providerType, provider);
    assert.equal(session.selectedModel, 'm');
  }
});

test('task chat never runs on a provider with no tool fence', () => {
  const session = { type: 'taskChat', toolProfile: 'taskChat', providerType: 'gemini', selectedModel: 'gemini-model' };
  assert.equal(route(session), 'claude');
  assert.equal(session.providerType, 'claude', 'the session is moved so follow-up turns and the client agree');
  assert.equal(session.selectedModel, null, 'a gemini model id must not reach the Claude CLI');
});

test('objective dispatch waits for unfiltered target snapshot before every provider spawn', async () => {
  for (const provider of ['claude', 'codex', 'gemini', 'pi']) {
    calls.length = 0;
    let release;
    const session = { type: 'objective', providerType: provider, backend: {
      getTasksUnfiltered: () => new Promise(resolve => { release = resolve; }),
    } };
    const pending = spawnTurn(session, 'id-1');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 0);
    assert.equal(session._spawning, true);
    assert.equal(spawnTurn(session, 'id-1'), undefined, 'duplicate spawn is suppressed');
    release([{ id: 'TPT1', status: 'in_progress' }]);
    await pending;
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], provider);
    assert.equal(session._spawning, false);
    assert.equal(session._proposalContext.tasks.get('TPT1').status, 'in_progress');
  }
});

test('closing a session during snapshot read prevents provider spawn', async () => {
  calls.length = 0;
  let release;
  const session = { type: 'objective', backend: {
    getTasksUnfiltered: () => new Promise(resolve => { release = resolve; }),
  } };
  const pending = spawnTurn(session, 'id-1');
  await new Promise(resolve => setImmediate(resolve));
  session._closed = true;
  release([]);
  await pending;
  assert.equal(calls.length, 0);
  assert.equal(session._proposalContext.tasks, null);
});

test('restarted snapshot read cannot publish old targets or clear replacement spawn state', async () => {
  calls.length = 0;
  let release;
  const session = { type: 'objective', backend: {
    getTasksUnfiltered: () => new Promise(resolve => { release = resolve; }),
  } };
  const pending = spawnTurn(session, 'id-1');
  await new Promise(resolve => setImmediate(resolve));
  session._epoch = 1;
  session._spawning = true;
  const replacement = { tasks: new Map() };
  session._proposalContext = replacement;
  release([{ id: 'TPT1', status: 'pending' }]);
  await pending;
  assert.equal(calls.length, 0);
  assert.equal(session._spawning, true);
  assert.equal(session._proposalContext, replacement);
});

test('abort during snapshot read never spawns; a later turn can still start', async () => {
  calls.length = 0;
  let release;
  const session = { type: 'objective', backend: {
    getTasksUnfiltered: () => new Promise(resolve => { release = resolve; }),
  } };
  const pending = spawnTurn(session, 'id-1');
  await new Promise(resolve => setImmediate(resolve));
  session._aborted = true;
  session._spawning = false;
  release([]);
  await pending;
  assert.equal(calls.length, 0);
  const next = spawnTurn(session, 'id-1');
  await new Promise(resolve => setImmediate(resolve));
  release([]);
  await next;
  assert.equal(calls.length, 1);
});

test('abort followed by a new turn fences the old read even without an epoch change', async () => {
  calls.length = 0;
  const releases = [];
  const session = { type: 'objective', backend: {
    getTasksUnfiltered: () => new Promise(resolve => { releases.push(resolve); }),
  } };
  const old = spawnTurn(session, 'id-1');
  await new Promise(resolve => setImmediate(resolve));
  session._aborted = true;
  session._spawning = false;
  const next = spawnTurn(session, 'id-1');
  await new Promise(resolve => setImmediate(resolve));
  releases[0]([{ id: 'TPT1', status: 'pending' }]);
  await old;
  assert.equal(calls.length, 0);
  assert.equal(session._spawning, true);
  releases[1]([{ id: 'TPT1', status: 'completed' }]);
  await next;
  assert.equal(calls.length, 1);
  assert.equal(session._proposalContext.tasks.get('TPT1').status, 'completed');
});

test('(TPT538) a chat resumed from history never spawns without its native session id', () => {
  calls.length = 0;
  const frames = [];
  const session = {
    type: 'taskChat', toolProfile: 'taskChat', providerType: 'codex', codexSessionId: null,
    _resumedHistory: { historyId: 'h1', provider: 'codex', nativeSessionId: 'tid' },
    ws: { readyState: 1, send: raw => frames.push(JSON.parse(raw)) },
  };
  spawnTurn(session, 'id-1');
  assert.equal(calls.length, 0);
  assert.equal(frames[0].reason, 'history-unavailable');
  assert.equal(frames[0].historyId, 'h1');
  session.codexSessionId = 'tid';
  assert.equal(route(session), 'codex', 'with the restored id the turn resumes normally');
});
