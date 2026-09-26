'use strict';

// C1110: GET /TODO.md branch coverage. Locks the route's scope semantics so a future
// change can't silently re-widen (or re-narrow) which read each query variant uses —
// that mismatch is exactly what caused the original bug (see modified-task-merge.js
// and chat-task-preview.js's ensureExistingSnapshot for the client-side half).
//
// config.js reads process.env.TASK_BACKEND once at require time, and the developer's
// shell may already export TASK_BACKEND=api — set it explicitly BEFORE requiring
// ws-handlers.js (which requires config.js transitively) so results are deterministic
// regardless of the ambient shell.
process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHttpHandler } = require('./ws-handlers');

// ── Minimal fake IncomingMessage/ServerResponse ──
function fakeReq(url) {
  return { method: 'GET', url, headers: {} };
}

function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(chunk) { res.body = chunk || ''; },
  };
  return res;
}

function parseBody(body) {
  const match = String(body).match(/```json\s*([\s\S]*)```/);
  assert.ok(match, `response body must contain a fenced json block, got: ${body}`);
  return JSON.parse(match[1].trim());
}

// Stub backend: getTasks() is assignee-scoped (only C1, "mine"); getTasksUnfiltered()
// spans the whole project (C1 + C2, "teammate's").
function makeStub({ withUnfiltered = true } = {}) {
  const mine = { id: 'C1', title: 'Mine', status: 'pending', assignee: 1 };
  const teammates = { id: 'C2', title: "Teammate's", status: 'pending', assignee: 9 };
  const stub = {
    async getTasks() { return [mine]; },
    async getChildren() { return []; },
    // (C1407) People filter "All Tasks" — opts.unscoped threaded from the route.
    // Captures the opts it was called with so tests can assert what the route sent.
    async getBoardTasks(opts) {
      stub._lastBoardOpts = opts;
      return {
        tasks: opts && opts.unscoped ? [mine, teammates] : [mine],
        window: { floor: 1, has_older: false, extended: 0 },
      };
    },
  };
  if (withUnfiltered) stub.getTasksUnfiltered = async () => [mine, teammates];
  return stub;
}

async function run(stub, url) {
  const handler = createHttpHandler(new Map(), () => stub, null);
  const req = fakeReq(url);
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test('GET /TODO.md (default, no query) — scoped: only the caller\'s own tasks', async () => {
  const res = await run(makeStub(), '/TODO.md?_=123');
  assert.equal(res.statusCode, 200);
  const data = parseBody(res.body);
  assert.deepEqual(data.tasks.map(t => t.id), ['C1']);
  assert.equal('scope' in data, false, 'default branch must never emit a scope key — it feeds the PUT /api/todo body verbatim');
});

test('GET /TODO.md?scope=all — unscoped: every assignee, scope echoed, no nextIdHint', async () => {
  const res = await run(makeStub(), '/TODO.md?scope=all&_=123');
  assert.equal(res.statusCode, 200);
  const data = parseBody(res.body);
  assert.deepEqual(data.tasks.map(t => t.id).sort(), ['C1', 'C2']);
  assert.equal(data.scope, 'all');
  assert.doesNotMatch(res.body, /Next available task IDs/, 'scope=all is a scope switch, not a status filter — no hint line');
});

test('GET /TODO.md?scope=all — backend without getTasksUnfiltered falls back to getTasks()', async () => {
  const res = await run(makeStub({ withUnfiltered: false }), '/TODO.md?scope=all&_=123');
  assert.equal(res.statusCode, 200);
  const data = parseBody(res.body);
  assert.deepEqual(data.tasks.map(t => t.id), ['C1']);
  assert.equal(data.scope, 'all', 'scope marker still present even on the fallback path');
});

test('GET /TODO.md?parentKey=X&scope=all — parentKey wins, children-only, no scope marker', async () => {
  const stub = makeStub();
  stub.getChildren = async (key) => (key === 'X' ? [{ id: 'C1-1', title: 'Child' }] : []);
  const res = await run(stub, '/TODO.md?parentKey=X&scope=all&_=123');
  assert.equal(res.statusCode, 200);
  const data = parseBody(res.body);
  assert.deepEqual(data.tasks.map(t => t.id), ['C1-1']);
  assert.equal('scope' in data, false, 'parentKey branch predates and is unrelated to the scope marker');
});

test('GET /TODO.md?scope=bogus — unrecognized scope value falls through to default (scoped) behavior, no 500', async () => {
  const res = await run(makeStub(), '/TODO.md?scope=bogus&_=123');
  assert.equal(res.statusCode, 200);
  const data = parseBody(res.body);
  assert.deepEqual(data.tasks.map(t => t.id), ['C1']);
  assert.equal('scope' in data, false);
});

test('GET /TODO.md?status=pending — unchanged by this change: unscoped rows plus nextIdHint', async () => {
  const res = await run(makeStub(), '/TODO.md?status=pending&_=123');
  assert.equal(res.statusCode, 200);
  const data = parseBody(res.body);
  assert.deepEqual(data.tasks.map(t => t.id).sort(), ['C1', 'C2']);
  assert.match(res.body, /Next available task IDs/, 'the pre-existing ?status= branch still appends the hint line');
});

// ── C1407: ?assignees=all — People filter "All Tasks" scope ──

test('GET /TODO.md?window=active — scoped by default, no assignees marker', async () => {
  const stub = makeStub();
  const res = await run(stub, '/TODO.md?window=active&_=123');
  assert.equal(res.statusCode, 200);
  const data = parseBody(res.body);
  assert.deepEqual(data.tasks.map(t => t.id), ['C1']);
  assert.equal(stub._lastBoardOpts.unscoped, false);
  assert.equal('assignees' in data, false);
});

test('GET /TODO.md?window=active&assignees=all — unscoped: every assignee, assignees echoed', async () => {
  const stub = makeStub();
  const res = await run(stub, '/TODO.md?window=active&assignees=all&_=123');
  assert.equal(res.statusCode, 200);
  const data = parseBody(res.body);
  assert.deepEqual(data.tasks.map(t => t.id).sort(), ['C1', 'C2']);
  assert.equal(stub._lastBoardOpts.unscoped, true, 'getBoardTasks() must be called with unscoped:true');
  assert.equal(data.assignees, 'all');
  assert.ok(data.window, 'window must still pass through untouched');
});

test('GET /TODO.md?parentKey=X&assignees=all — drill-down obeys the same filter as the board', async () => {
  const stub = makeStub();
  stub.getChildren = async (key, opts) => {
    stub._lastChildrenOpts = opts;
    if (key !== 'X') return [];
    return (opts && opts.unscoped)
      ? [{ id: 'C1-1', assignee: 1 }, { id: 'C1-2', assignee: 9 }]
      : [{ id: 'C1-1', assignee: 1 }];
  };
  const res = await run(stub, '/TODO.md?parentKey=X&assignees=all&_=123');
  assert.equal(res.statusCode, 200);
  const data = parseBody(res.body);
  assert.deepEqual(data.tasks.map(t => t.id).sort(), ['C1-1', 'C1-2']);
  assert.equal(stub._lastChildrenOpts.unscoped, true);
  assert.equal(data.assignees, 'all');
});

test('GET /TODO.md?window=active&assignees=bogus — unrecognized value falls through as scoped, no 500', async () => {
  const stub = makeStub();
  const res = await run(stub, '/TODO.md?window=active&assignees=bogus&_=123');
  assert.equal(res.statusCode, 200);
  const data = parseBody(res.body);
  assert.deepEqual(data.tasks.map(t => t.id), ['C1']);
  assert.equal(stub._lastBoardOpts.unscoped, false);
  assert.equal('assignees' in data, false);
});
