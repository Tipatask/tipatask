'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSession, isAgentChatType, isAgentChatId } = require('./session-state');

test('a new session starts as a pending terminal with no chat scope', () => {
  const session = createSession(null, true, 'TPT1', '');
  assert.equal(session.type, 'terminal');
  assert.equal(session.pending, true);
  assert.equal(session.taskKey, null);
  assert.equal(session.chatProjectId, null);
  assert.equal(session.toolProfile, null, 'no profile = the provider\'s own objective fence');
  assert.equal(session.pendingResult, null);
  assert.deepEqual(session.messages, []);
});

test('sessions never share mutable chat state', () => {
  const a = createSession(null, true, 'a', '');
  const b = createSession(null, true, 'b', '');
  a.messages.push({ role: 'user', content: 'x' });
  a._cachedTagsSerialized.add('tt-x');
  assert.equal(b.messages.length, 0);
  assert.equal(b._cachedTagsSerialized.size, 0);
});

test('isAgentChatType covers objective, spec chat and task chat only', () => {
  for (const type of ['objective', 'specChat', 'taskChat']) assert.equal(isAgentChatType(type), true, type);
  for (const type of ['terminal', '', undefined, null, 'taskchat']) assert.equal(isAgentChatType(type), false, String(type));
});

test('isAgentChatId recognises chat session ids by prefix, never a task key', () => {
  for (const id of ['obj-1790000000', 'specChat:C524', 'taskChat:TPT420', 'projectChat:2']) assert.equal(isAgentChatId(id), true, id);
  for (const id of ['TPT420', 'C524', 'H12', '', null, undefined, 42, 'xtaskChat:TPT1']) assert.equal(isAgentChatId(id), false, String(id));
});


test('permission-mode requests are unset at creation and isolated per session', () => {
  const a = createSession(null, true, 'a', '');
  const b = createSession(null, true, 'b', '');
  assert.deepEqual(a.permissionMode, { requested: null, confirmed: null, pending: false, error: null });
  a.permissionMode.requested = 'bypass';
  a.permissionMode.pending = true;
  assert.equal(b.permissionMode.requested, null);
  assert.equal(b.permissionMode.pending, false);
});
