'use strict';

// (C1541) getTasksByTags() / selectResolutionCandidates() — backs the list_task_resolutions
// MCP tool. Same throwaway-project fake-API harness as board-assignee-scope.test.js /
// reserve-task-keys.test.js. The fake server never implements GET /statuses — getStatuses()
// (api-backend.js) fails open to LEGACY_STATUSES on any non-2xx/network error, so
// closedSet = {completed, canceled} with nothing to stub.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApiBackend, selectResolutionCandidates } = require('./api-backend');

async function withFakeApiServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-tasks-by-tags-'));
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

// tasks: [{ id (raw numeric PK), task_key, title, status, tags, is_reservation? }]
// commentsByKey: { [task_key]: [{id, content, comment_type, created_at}] } — a key absent
// from this map makes the fake server 404 the comments endpoint (apiRequest -> _notFound).
function makeHandler(tasks, commentsByKey, state = {}) {
  return (req, res) => {
    if (req.url === '/api/auth/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ user: { id: 7 } }));
    }
    const commentsMatch = req.url.match(/\/tasks\/([^/?]+)\/comments/);
    if (commentsMatch) {
      state.commentRequests = (state.commentRequests || 0) + 1;
      state.requestedKeys = state.requestedKeys || [];
      state.requestedKeys.push(decodeURIComponent(commentsMatch[1]));
      const key = decodeURIComponent(commentsMatch[1]);
      const comments = commentsByKey[key];
      if (!comments) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ comments }));
    }
    if (req.url.startsWith('/api/projects/1/statuses')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' })); // -> LEGACY_STATUSES fallback
    }
    if (req.url.startsWith('/api/projects/1/tasks')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tasks }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unhandled: ' + req.url }));
  };
}

const REAL_REPORT = 'Fixed the bug by moving the guard clause up. Verify: run the tests.';
const LOG_TAIL = 'Agent completed the task\n\n```\nsome PTY output\n```';

test('OR across tags — a task carrying both wanted tags appears exactly once', async () => {
  const tasks = [
    { id: 350, task_key: 'C3', title: 'Both tags', category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server', 'tt-api-backend'] },
    { id: 300, task_key: 'C1', title: 'One tag', category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server'] },
  ];
  const commentsByKey = {
    C3: [{ id: 1, content: REAL_REPORT, comment_type: 'resolution', created_at: '2026-01-01' }],
    C1: [{ id: 2, content: REAL_REPORT, comment_type: 'resolution', created_at: '2026-01-01' }],
  };
  await withFakeApiServer(makeHandler(tasks, commentsByKey), async (backend) => {
    const result = await backend.getTasksByTags(['tt-mcp-server', 'tt-api-backend'], { limit: 10 });
    assert.strictEqual(result.resolutions.length, 2); // C3 once, not twice
    const ids = result.resolutions.map(r => r.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });
});

test('ordering is by dbId descending, not by task_key text (epic-style key proves it)', async () => {
  const tasks = [
    { id: 100, task_key: 'C1', title: 'Lower dbId', category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server'] },
    { id: 400, task_key: 'TIP-3', title: 'Epic, highest dbId', category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server'] },
  ];
  const commentsByKey = {
    C1: [{ id: 1, content: REAL_REPORT, comment_type: 'resolution', created_at: '2026-01-01' }],
    'TIP-3': [{ id: 2, content: REAL_REPORT, comment_type: 'resolution', created_at: '2026-01-01' }],
  };
  await withFakeApiServer(makeHandler(tasks, commentsByKey), async (backend) => {
    const result = await backend.getTasksByTags(['tt-mcp-server'], { limit: 10 });
    assert.deepStrictEqual(result.resolutions.map(r => r.id), ['TIP-3', 'C1']);
  });
});

test('a task whose only comment is an agent-log-tail is skipped; a lower-ranked task fills the slot', async () => {
  const tasks = [
    { id: 300, task_key: 'C-TOP', title: 'Only a log tail', category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server'] },
    { id: 250, task_key: 'C-NEXT', title: 'Real report', category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server'] },
  ];
  const commentsByKey = {
    'C-TOP': [{ id: 1, content: LOG_TAIL, comment_type: 'resolution', created_at: '2026-01-01' }],
    'C-NEXT': [{ id: 2, content: REAL_REPORT, comment_type: 'resolution', created_at: '2026-01-01' }],
  };
  await withFakeApiServer(makeHandler(tasks, commentsByKey), async (backend) => {
    const result = await backend.getTasksByTags(['tt-mcp-server'], { limit: 1 });
    assert.strictEqual(result.resolutions.length, 1);
    assert.strictEqual(result.resolutions[0].id, 'C-NEXT');
  });
});

test('includeAgentLogs:true lets a log-tail-only task through', async () => {
  const tasks = [
    { id: 300, task_key: 'C-TOP', title: 'Only a log tail', category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server'] },
  ];
  const commentsByKey = {
    'C-TOP': [{ id: 1, content: LOG_TAIL, comment_type: 'resolution', created_at: '2026-01-01' }],
  };
  await withFakeApiServer(makeHandler(tasks, commentsByKey), async (backend) => {
    const result = await backend.getTasksByTags(['tt-mcp-server'], { limit: 1, includeAgentLogs: true });
    assert.strictEqual(result.resolutions.length, 1);
    assert.strictEqual(result.resolutions[0].id, 'C-TOP');
  });
});

test('a 404 on comments (getTaskComments -> null) is handled without throwing', async () => {
  const tasks = [
    { id: 300, task_key: 'C-GONE', title: 'Comments 404', category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server'] },
    { id: 250, task_key: 'C-OK', title: 'Has comments', category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server'] },
  ];
  const commentsByKey = {
    // C-GONE intentionally absent -> fake server 404s -> getTaskComments() returns null
    'C-OK': [{ id: 1, content: REAL_REPORT, comment_type: 'resolution', created_at: '2026-01-01' }],
  };
  await withFakeApiServer(makeHandler(tasks, commentsByKey), async (backend) => {
    const result = await backend.getTasksByTags(['tt-mcp-server'], { limit: 10 });
    assert.strictEqual(result.resolutions.length, 1);
    assert.strictEqual(result.resolutions[0].id, 'C-OK');
  });
});

test('reservation placeholders are never candidates even with a matching tag and status', async () => {
  const tasks = [
    { id: 999, task_key: 'C-RES', title: 'Reservation', category: 'CODING', status: 'completed', priority: 0, tags: ['tt-mcp-server'], is_reservation: true },
    { id: 100, task_key: 'C-REAL', title: 'Real task', category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server'] },
  ];
  const commentsByKey = {
    'C-RES': [{ id: 1, content: REAL_REPORT, comment_type: 'resolution', created_at: '2026-01-01' }],
    'C-REAL': [{ id: 2, content: REAL_REPORT, comment_type: 'resolution', created_at: '2026-01-01' }],
  };
  await withFakeApiServer(makeHandler(tasks, commentsByKey), async (backend) => {
    const result = await backend.getTasksByTags(['tt-mcp-server'], { limit: 10 });
    assert.deepStrictEqual(result.resolutions.map(r => r.id), ['C-REAL']);
  });
});

test('default scope is closed statuses only; explicit status overrides', async () => {
  const tasks = [
    { id: 100, task_key: 'C-OPEN', title: 'Still open', category: 'CODING', status: 'pending', priority: 1, tags: ['tt-mcp-server'] },
    { id: 200, task_key: 'C-DONE', title: 'Closed', category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server'] },
  ];
  const commentsByKey = {
    'C-OPEN': [{ id: 1, content: REAL_REPORT, comment_type: 'comment', created_at: '2026-01-01' }],
    'C-DONE': [{ id: 2, content: REAL_REPORT, comment_type: 'resolution', created_at: '2026-01-01' }],
  };
  await withFakeApiServer(makeHandler(tasks, commentsByKey), async (backend) => {
    const closedOnly = await backend.getTasksByTags(['tt-mcp-server'], { limit: 10 });
    assert.deepStrictEqual(closedOnly.resolutions.map(r => r.id), ['C-DONE']);

    const explicitOpen = await backend.getTasksByTags(['tt-mcp-server'], { limit: 10, status: 'pending' });
    assert.deepStrictEqual(explicitOpen.resolutions.map(r => r.id), ['C-OPEN']);
  });
});

test('comment-probe requests are bounded per batch and stop once limit is satisfied', async () => {
  // 8 candidates, all with real comments — limit:1 should only need to probe the first
  // batch (5), not all 8, once the first candidate alone satisfies limit:1.
  const tasks = [];
  const commentsByKey = {};
  for (let i = 8; i >= 1; i--) {
    const key = `C${i}`;
    tasks.push({ id: i * 10, task_key: key, title: `Task ${i}`, category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server'] });
    commentsByKey[key] = [{ id: i, content: REAL_REPORT, comment_type: 'resolution', created_at: '2026-01-01' }];
  }
  const state = {};
  await withFakeApiServer(makeHandler(tasks, commentsByKey, state), async (backend) => {
    const result = await backend.getTasksByTags(['tt-mcp-server'], { limit: 1 });
    assert.strictEqual(result.resolutions.length, 1);
    // Probe batch size is 5 (see api-backend.js PROBE_BATCH) — the first batch alone
    // already satisfies limit:1, so requests must stay within that first batch.
    assert.ok(state.commentRequests <= 5, `expected <=5 comment requests, got ${state.commentRequests}`);
  });
});

test('case-insensitive tag matching', async () => {
  const tasks = [
    { id: 100, task_key: 'C1', title: 'Mixed case tag', category: 'CODING', status: 'completed', priority: 1, tags: ['TT-MCP-Server'] },
  ];
  const commentsByKey = {
    C1: [{ id: 1, content: REAL_REPORT, comment_type: 'resolution', created_at: '2026-01-01' }],
  };
  await withFakeApiServer(makeHandler(tasks, commentsByKey), async (backend) => {
    const result = await backend.getTasksByTags(['tt-mcp-server'], { limit: 10 });
    assert.strictEqual(result.resolutions.length, 1);
  });
});

test('empty tags array is rejected, never treated as "all tasks"', async () => {
  const tasks = [
    { id: 100, task_key: 'C1', title: 'Any task', category: 'CODING', status: 'completed', priority: 1, tags: ['tt-mcp-server'] },
  ];
  await withFakeApiServer(makeHandler(tasks, {}), async (backend) => {
    await assert.rejects(() => backend.getTasksByTags([], { limit: 10 }), /non-empty/);
  });
});

// ── Pure helper — no server needed ──

test('selectResolutionCandidates: any-of tag match, case-insensitive, excludes reservations and non-closed', () => {
  const closedSet = new Set(['completed', 'canceled']);
  const tasks = [
    { id: 'A', status: 'completed', tags: ['TT-Foo'], isReservation: false },
    { id: 'B', status: 'completed', tags: ['tt-bar'], isReservation: false },
    { id: 'C', status: 'completed', tags: ['tt-foo'], isReservation: true }, // excluded: reservation
    { id: 'D', status: 'pending', tags: ['tt-foo'], isReservation: false }, // excluded: not closed
    { id: 'E', status: 'completed', tags: ['unrelated'], isReservation: false }, // excluded: no tag match
  ];
  const result = selectResolutionCandidates(tasks, { tagSet: new Set(['tt-foo']), closedSet });
  assert.deepStrictEqual(result.map(t => t.id), ['A']);
});

test('selectResolutionCandidates: explicit statusName overrides the default closed-only scope', () => {
  const closedSet = new Set(['completed', 'canceled']);
  const tasks = [
    { id: 'A', status: 'in_progress', tags: ['tt-foo'], isReservation: false },
    { id: 'B', status: 'completed', tags: ['tt-foo'], isReservation: false },
  ];
  const result = selectResolutionCandidates(tasks, { tagSet: new Set(['tt-foo']), statusName: 'in_progress', closedSet });
  assert.deepStrictEqual(result.map(t => t.id), ['A']);
});
