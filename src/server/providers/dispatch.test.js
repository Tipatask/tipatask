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
