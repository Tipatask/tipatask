'use strict';

// (C1407) Task App board scoping — closes the project-owner exemption gap: the Tipatask
// API's ?assignee=<id> filter is IGNORED for the project owner (owner sees every task,
// tt-api-backend.md § C904), so an owner's board previously showed every member's tasks.
// filterToOwnOrUnassigned() (api-backend.js) re-filters client-side on top of the API's own
// scoping. This test simulates exactly that: a fake API that IGNORES ?assignee= and always
// returns rows for assignee 7, 9, and null — that IS the owner exemption — and asserts the
// backend still narrows to "assignee === me OR unassigned" unless explicitly told not to
// (the People filter's "All Tasks" scope, opts.unscoped).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApiBackend, filterToOwnOrUnassigned } = require('./api-backend');

// Same throwaway-project harness as reserve-task-keys.test.js.
async function withFakeApiServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-assignee-scope-'));
  fs.mkdirSync(path.join(projectRoot, '.tipatask'));
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${port}`,
    API_TOKEN: 'test-token',
    API_PROJECT_ID: '1',
  }));
  const backend = createApiBackend(null, projectRoot);
  try {
    await run(backend, () => server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

const RAW_TASKS = [
  { id: 1, project_id: 1, task_key: 'C1', title: 'Mine', category: 'CODING', status: 'pending', priority: 1, assignee: 7 },
  { id: 2, project_id: 1, task_key: 'C2', title: 'Teammate', category: 'CODING', status: 'pending', priority: 1, assignee: 9 },
  { id: 3, project_id: 1, task_key: 'C3', title: 'Unassigned', category: 'CODING', status: 'pending', priority: 1, assignee: null },
];

// Owner-exemption simulation: every /tasks* request gets all three rows regardless of
// ?assignee=. lastTasksUrl captures the most recent /tasks* request path for assertions
// about what the backend actually sent on the wire.
// apiRequest() (api-backend.js) builds every URL as `${baseUrl}/api/projects/${id}${urlPath}`
// — e.g. `/api/projects/1/tasks?...` — so these checks match on substring/suffix, the same
// way reserve-task-keys.test.js's fake handlers do, rather than assuming a bare `/tasks` prefix.
function makeOwnerExemptHandler(state, rows = RAW_TASKS) {
  return (req, res) => {
    if (req.url === '/api/auth/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ user: { id: 7 } }));
    }
    if (req.url.includes('/children')) {
      state.lastTasksUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ children: rows }));
    }
    state.lastTasksUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      tasks: rows,
      window: { floor: 1, has_older: false, extended: 0 },
    }));
  };
}

// (TPT180) Creator-inclusion fixture, kept separate from RAW_TASKS so the cases above stay
// exactly as C1407 wrote them. Signed-in user is 7 (see /api/auth/me above).
//   A1 — created by me, reassigned to 9      → MUST stay visible (the TPT180 fix)
//   A2 — created by 9, assigned to 9          → must stay hidden (unrelated teammate work)
//   A3 — created by 9, assigned to me         → visible via assignee, as before
//   A4 — author unknown (pre-066, no backfill), assigned to 9 → must stay hidden: a null
//        created_by may never match everyone
const RAW_AUTHORED_TASKS = [
  { id: 11, project_id: 1, task_key: 'A1', title: 'I made it, Bob has it', category: 'CODING', status: 'pending', priority: 1, assignee: 9, created_by: 7 },
  { id: 12, project_id: 1, task_key: 'A2', title: 'Bob\'s own', category: 'CODING', status: 'pending', priority: 1, assignee: 9, created_by: 9 },
  { id: 13, project_id: 1, task_key: 'A3', title: 'Bob gave me this', category: 'CODING', status: 'pending', priority: 1, assignee: 7, created_by: 9 },
  { id: 14, project_id: 1, task_key: 'A4', title: 'Unknown author', category: 'CODING', status: 'pending', priority: 1, assignee: 9, created_by: null },
];

test('getTasks() re-filters to assignee===me OR unassigned despite the owner exemption', async () => {
  const state = {};
  await withFakeApiServer(makeOwnerExemptHandler(state), async (backend) => {
    await backend.init(); // resolves _currentUserId (7) so getTasks() takes the scoped path
    const rows = await backend.getTasks();
    assert.deepStrictEqual(rows.map(t => t.id).sort(), ['C1', 'C3']);
  });
});

test('getBoardTasks() re-filters the same way and passes window through untouched', async () => {
  const state = {};
  await withFakeApiServer(makeOwnerExemptHandler(state), async (backend) => {
    await backend.init();
    const { tasks, window } = await backend.getBoardTasks();
    assert.deepStrictEqual(tasks.map(t => t.id).sort(), ['C1', 'C3']);
    assert.deepStrictEqual(window, { floor: 1, has_older: false, extended: 0 });
  });
});

test('getBoardTasks({unscoped:true}) returns every assignee and omits ?assignee= on the wire', async () => {
  const state = {};
  await withFakeApiServer(makeOwnerExemptHandler(state), async (backend) => {
    await backend.init();
    const { tasks } = await backend.getBoardTasks({ unscoped: true });
    assert.deepStrictEqual(tasks.map(t => t.id).sort(), ['C1', 'C2', 'C3']);
    assert.ok(state.lastTasksUrl, 'expected a /tasks request');
    assert.ok(!state.lastTasksUrl.includes('assignee='), `expected no assignee= param, got ${state.lastTasksUrl}`);
  });
});

test('scoped and unscoped getBoardTasks() calls at the same extendSprints do not alias each other\'s cache', async () => {
  const state = {};
  await withFakeApiServer(makeOwnerExemptHandler(state), async (backend) => {
    await backend.init();
    const scoped1 = await backend.getBoardTasks({ extendSprints: 0 });
    const unscoped = await backend.getBoardTasks({ extendSprints: 0, unscoped: true });
    const scoped2 = await backend.getBoardTasks({ extendSprints: 0 }); // within TTL — must be a cache hit, but the SCOPED entry
    assert.deepStrictEqual(scoped1.tasks.map(t => t.id).sort(), ['C1', 'C3']);
    assert.deepStrictEqual(unscoped.tasks.map(t => t.id).sort(), ['C1', 'C2', 'C3']);
    assert.deepStrictEqual(scoped2.tasks.map(t => t.id).sort(), ['C1', 'C3']);
  });
});

test('full board fetch includes a sprint below the active floor and keeps scoped/windowed caches separate', async () => {
  const state = { urls: [] };
  const older = { id: 4, project_id: 1, task_key: 'C4', title: 'Older search hit', category: 'CODING', status: 'completed', priority: 350, assignee: 7 };
  const handler = (req, res) => {
    if (req.url === '/api/auth/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ user: { id: 7 } }));
    }
    state.urls.push(req.url);
    const windowed = new URL(req.url, 'http://localhost').searchParams.has('window');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      tasks: windowed ? [RAW_TASKS[0]] : [RAW_TASKS[0], older, RAW_TASKS[1]],
      window: windowed ? { floor: 365, has_older: true, extended: 0 } : null,
    }));
  };
  await withFakeApiServer(handler, async (backend) => {
    await backend.init();
    state.urls.length = 0;
    const limited = await backend.getBoardTasks();
    const full = await backend.getBoardTasks({ fullWindow: true, extendSprints: 10 });
    const limitedAgain = await backend.getBoardTasks();
    assert.deepStrictEqual(limited.tasks.map(t => t.id), ['C1']);
    assert.deepStrictEqual(full.tasks.map(t => t.id), ['C1', 'C4']);
    assert.strictEqual(full.window, null);
    assert.deepStrictEqual(limitedAgain.tasks.map(t => t.id), ['C1']);
    assert.equal(state.urls.length, 2, 'full and windowed reads use separate cache entries');
    const fullParams = new URL(state.urls[1], 'http://localhost').searchParams;
    assert.equal(fullParams.get('assignee'), '7');
    assert.equal(fullParams.get('include_reservations'), 'true');
    assert.equal(fullParams.has('window'), false);
    assert.equal(fullParams.has('extend_sprints'), false);
  });
});

test('getChildren() filters by default, opts.unscoped:true returns every assignee', async () => {
  const state = {};
  await withFakeApiServer(makeOwnerExemptHandler(state), async (backend) => {
    await backend.init();
    const scoped = await backend.getChildren('C0');
    assert.deepStrictEqual(scoped.map(t => t.id).sort(), ['C1', 'C3']);
    const unscoped = await backend.getChildren('C0', { unscoped: true });
    assert.deepStrictEqual(unscoped.map(t => t.id).sort(), ['C1', 'C2', 'C3']);
  });
});

test('getTasksUnfiltered() is never filtered by assignee — save/agent/system paths must see everyone', async () => {
  const state = {};
  await withFakeApiServer(makeOwnerExemptHandler(state), async (backend) => {
    await backend.init();
    const rows = await backend.getTasksUnfiltered();
    assert.deepStrictEqual(rows.map(t => t.id).sort(), ['C1', 'C2', 'C3']);
  });
});

// ── Pure helper — no server needed ──

test('filterToOwnOrUnassigned(rows, null) returns the list unchanged (can\'t scope, don\'t pretend to)', () => {
  const rows = [{ assignee: 1 }, { assignee: 2 }, { assignee: null }];
  assert.deepStrictEqual(filterToOwnOrUnassigned(rows, null), rows);
});

test('filterToOwnOrUnassigned(rows, id) keeps only assignee===id or null', () => {
  const rows = [{ id: 'a', assignee: 1 }, { id: 'b', assignee: 2 }, { id: 'c', assignee: null }];
  assert.deepStrictEqual(filterToOwnOrUnassigned(rows, 1).map(r => r.id), ['a', 'c']);
});

test('filterToOwnOrUnassigned coerces string/number assignee ids the same way (C1049-style)', () => {
  const rows = [{ id: 'a', assignee: '7' }, { id: 'b', assignee: 9 }];
  assert.deepStrictEqual(filterToOwnOrUnassigned(rows, 7).map(r => r.id), ['a']);
});

// ── (TPT180) Creator inclusion ──

test('filterToOwnOrUnassigned keeps a task I created after it was reassigned to someone else', () => {
  const rows = [
    { id: 'reassigned', assignee: 9, createdBy: 7 },
    { id: 'theirs', assignee: 9, createdBy: 9 },
  ];
  assert.deepStrictEqual(filterToOwnOrUnassigned(rows, 7).map(r => r.id), ['reassigned']);
});

test('filterToOwnOrUnassigned coerces string/number createdBy ids the same way', () => {
  const rows = [
    { id: 'a', assignee: 9, createdBy: '7' },
    { id: 'b', assignee: 9, createdBy: 8 },
  ];
  assert.deepStrictEqual(filterToOwnOrUnassigned(rows, '7').map(r => r.id), ['a']);
});

test('filterToOwnOrUnassigned: createdBy null/undefined never matches — unknown author is not "everyone"', () => {
  const rows = [
    { id: 'nullAuthor', assignee: 9, createdBy: null },
    { id: 'noField', assignee: 9 },
  ];
  assert.deepStrictEqual(filterToOwnOrUnassigned(rows, 7), []);
});

test('filterToOwnOrUnassigned: currentUserId null still returns the list unchanged with createdBy rows present', () => {
  const rows = [{ id: 'a', assignee: 9, createdBy: 7 }, { id: 'b', assignee: 9, createdBy: 9 }];
  assert.deepStrictEqual(filterToOwnOrUnassigned(rows, null), rows);
});

const AUTHORED_SCOPED = ['A1', 'A3'];
const AUTHORED_ALL = ['A1', 'A2', 'A3', 'A4'];

test('getTasks() keeps a created-but-reassigned task and still excludes unrelated assigned tasks', async () => {
  const state = {};
  await withFakeApiServer(makeOwnerExemptHandler(state, RAW_AUTHORED_TASKS), async (backend) => {
    await backend.init();
    const rows = await backend.getTasks();
    assert.deepStrictEqual(rows.map(t => t.id).sort(), AUTHORED_SCOPED);
    const kept = rows.find(t => t.id === 'A1');
    assert.strictEqual(kept.assignee, 9);
    assert.strictEqual(kept.createdBy, 7, 'fromApi() must map created_by → createdBy');
  });
});

test('getBoardTasks() keeps a created-but-reassigned task (and window passes through)', async () => {
  const state = {};
  await withFakeApiServer(makeOwnerExemptHandler(state, RAW_AUTHORED_TASKS), async (backend) => {
    await backend.init();
    const { tasks, window } = await backend.getBoardTasks();
    assert.deepStrictEqual(tasks.map(t => t.id).sort(), AUTHORED_SCOPED);
    assert.deepStrictEqual(window, { floor: 1, has_older: false, extended: 0 });
  });
});

test('getChildren() keeps a created-but-reassigned subtask; unscoped:true returns everyone', async () => {
  const state = {};
  await withFakeApiServer(makeOwnerExemptHandler(state, RAW_AUTHORED_TASKS), async (backend) => {
    await backend.init();
    const scoped = await backend.getChildren('C0');
    assert.deepStrictEqual(scoped.map(t => t.id).sort(), AUTHORED_SCOPED);
    const unscoped = await backend.getChildren('C0', { unscoped: true });
    assert.deepStrictEqual(unscoped.map(t => t.id).sort(), AUTHORED_ALL);
  });
});

test('scope follows the resolved signed-in user id: same rows, /me answers 9', async () => {
  // Same rows, but /me now answers 9. A1 (created by 7, assigned to 9), A2 and A4 (assigned
  // to 9) are visible via assignee; A3 (assigned to 7, created by 9) is visible via createdBy.
  // Mid-session identity swaps are covered separately by user-context-reset.test.js.
  const state = {};
  const handler = (req, res) => {
    if (req.url === '/api/auth/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ user: { id: 9 } }));
    }
    return makeOwnerExemptHandler(state, RAW_AUTHORED_TASKS)(req, res);
  };
  await withFakeApiServer(handler, async (backend) => {
    await backend.init();
    const rows = await backend.getTasks();
    assert.deepStrictEqual(rows.map(t => t.id).sort(), AUTHORED_ALL);
  });
});
