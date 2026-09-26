'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const websocket = require('./websocket');

function fakeClient(readyState, projectPath) {
  const sent = [];
  return { readyState, _projectPath: projectPath, send: (msg) => sent.push(JSON.parse(msg)), sent };
}

test('broadcastToProject: unstamped client receives every event regardless of scope', () => {
  const client = fakeClient(1, undefined);
  websocket.init({ clients: new Set([client]) });
  websocket.broadcastToProject('/projects/a', 'attention-needed', { taskId: 'C1' });
  websocket.broadcastToProject(undefined, 'attention-needed', { taskId: 'C2' });
  assert.equal(client.sent.length, 2);
});

test('broadcastToProject: a client stamped for project A receives A-scoped and unscoped events, not B', () => {
  const a = fakeClient(1, '/projects/a');
  const b = fakeClient(1, '/projects/b');
  websocket.init({ clients: new Set([a, b]) });

  websocket.broadcastToProject('/projects/a', 'attention-needed', { taskId: 'C1' });
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0);

  websocket.broadcastToProject(undefined, 'attention-needed', { taskId: 'C2' });
  assert.equal(a.sent.length, 2);
  assert.equal(b.sent.length, 1);
});

test('broadcastToProject: skips clients whose socket is not open', () => {
  const closed = fakeClient(3, '/projects/a'); // CLOSED
  websocket.init({ clients: new Set([closed]) });
  websocket.broadcastToProject('/projects/a', 'attention-needed', { taskId: 'C1' });
  assert.equal(closed.sent.length, 0);
});

test('broadcastToProject: no-op before init()/without a wss', () => {
  // Re-require in isolation would be needed to truly reset _wss; instead just confirm
  // calling with no clients set never throws.
  websocket.init({ clients: new Set() });
  assert.doesNotThrow(() => websocket.broadcastToProject('/projects/a', 'attention-needed', { taskId: 'C1' }));
});

test('broadcast (legacy, unscoped) still reaches every open client regardless of project stamp', () => {
  const a = fakeClient(1, '/projects/a');
  const b = fakeClient(1, '/projects/b');
  websocket.init({ clients: new Set([a, b]) });
  websocket.broadcast('tasks-updated', {});
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
});

// (C1230)
test('broadcastKbReindexResult: emits the EXISTING reindex-kb-result type (no new event name), project-scoped, auto:true stamped', () => {
  const a = fakeClient(1, '/projects/a');
  const b = fakeClient(1, '/projects/b');
  websocket.init({ clients: new Set([a, b]) });

  websocket.broadcastKbReindexResult('/projects/a', { success: true, tagsUpdated: 2, filesUpdated: 1, skipped: 0, errors: [] });

  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0);
  assert.deepEqual(a.sent[0], {
    type: 'reindex-kb-result', auto: true, success: true, tagsUpdated: 2, filesUpdated: 1, skipped: 0, errors: [],
  });
});

test('broadcastKbReindexResult: no projectPath falls through to every client, same as an unscoped event', () => {
  const a = fakeClient(1, '/projects/a');
  const b = fakeClient(1, '/projects/b');
  websocket.init({ clients: new Set([a, b]) });

  websocket.broadcastKbReindexResult(undefined, { success: false, tagsUpdated: 0, filesUpdated: 0, skipped: 0, errors: [], error: 'boom' });

  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
  assert.equal(a.sent[0].error, 'boom');
});
