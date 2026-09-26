'use strict';

// Regression test for the "reserve_task_keys returns empty array" bug: the objective
// planner calls MCP reserve_task_keys -> backend.reserveTaskKeys() -> POST /tasks/reserve.
// Root cause: apiRequest() (api-backend.js) swallows a 404 into { _notFound: true }
// instead of throwing (correct for "row doesn't exist yet" callers), but
// reserveTaskKeys() then did `(data.tasks || [])` -> silently returned `keys: []` with
// NO error. A 404 here means the deployed API predates the /tasks/reserve route (C980)
// or the project lookup 404'd — the planner saw an empty array indistinguishable from
// "server is fine, zero keys available" and gave up after two tries.
// Fix: reserveTaskKeys() now throws a clear, diagnosable error instead of degrading to
// an empty array — for the 404/_notFound case and for any 2xx response missing tasks.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApiBackend } = require('./api-backend');

// Spin a throwaway local HTTP server that always responds the same way, and build a
// backend instance pointed at it through a temporary project config.json.
async function withFakeApiServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-reserve-'));
  fs.mkdirSync(path.join(projectRoot, '.tipatask'));
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${port}`,
    API_TOKEN: 'test-token',
    API_PROJECT_ID: '1',
  }));
  const backend = createApiBackend(null, projectRoot);
  try {
    await run(backend);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

test('reserveTaskKeys throws a diagnosable error on 404 (API missing the reserve route)', async () => {
  await withFakeApiServer(
    (req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    },
    async (backend) => {
      await assert.rejects(
        () => backend.reserveTaskKeys({ count: 1 }),
        /out of date|reserve route|not found/i,
        'expected a clear error identifying the 404, not a silent empty result'
      );
    }
  );
});

test('reserveTaskKeys throws when the API returns 2xx with no tasks (unexpected shape)', async () => {
  await withFakeApiServer(
    (req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks: [] }));
    },
    async (backend) => {
      await assert.rejects(
        () => backend.reserveTaskKeys({ count: 1 }),
        /no tasks|unexpected/i
      );
    }
  );
});

test('reserveTaskKeys returns keys on a normal successful reservation', async () => {
  await withFakeApiServer(
    (req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks: [{ id: 1, project_id: 1, task_key: 'C42', title: 'New task', category: 'CODING', status: 'pending', priority: 0 }] }));
    },
    async (backend) => {
      const { keys } = await backend.reserveTaskKeys({ count: 1 });
      assert.deepStrictEqual(keys, ['C42']);
    }
  );
});

// ── C1017: getTasks()/getTasksUnfiltered() must keep seeing reservation placeholders ──
// The API excludes them by default (board/list views); internal id-collision/finalize
// logic needs them, so these calls must pass include_reservations=true explicitly.

test('getTasksUnfiltered() requests include_reservations=true', async () => {
  let requestedUrl = null;
  await withFakeApiServer(
    (req, res) => {
      requestedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks: [] }));
    },
    async (backend) => {
      await backend.getTasksUnfiltered();
      assert.match(requestedUrl, /include_reservations=true/);
    }
  );
});

test('getTasks() (scoped, current user resolved) requests include_reservations=true', async () => {
  let scopedUrl = null;
  await withFakeApiServer(
    (req, res) => {
      // /api/auth/me is a top-level route (not nested under /api/projects/:id) —
      // hit once by init() to resolve _currentUserId.
      if (req.url === '/api/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ user: { id: 7 } }));
      }
      if (req.url.includes('assignee=')) scopedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks: [] }));
    },
    async (backend) => {
      await backend.init(); // resolves _currentUserId so getTasks() takes the scoped path
      await backend.getTasks();
      assert.ok(scopedUrl, 'expected a scoped (assignee=) request');
      assert.match(scopedUrl, /include_reservations=true/);
    }
  );
});

// ── C1017: purgeStaleReservations ──

test('purgeStaleReservations throws a diagnosable error on 404 (API missing the purge route)', async () => {
  await withFakeApiServer(
    (req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    },
    async (backend) => {
      await assert.rejects(
        () => backend.purgeStaleReservations({ olderThanHours: 24 }),
        /out of date|purge route|not found/i,
        'expected a clear error identifying the 404, not a silent empty result'
      );
    }
  );
});

test('purgeStaleReservations returns purged count and keys on success', async () => {
  await withFakeApiServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ purged: 2, keys: ['C1008', 'C1009'] }));
    },
    async (backend) => {
      const result = await backend.purgeStaleReservations({ olderThanHours: 24 });
      assert.deepStrictEqual(result, { purged: 2, keys: ['C1008', 'C1009'] });
    }
  );
});

test('purgeStaleReservations dry_run does not require a follow-up cache invalidation to work correctly', async () => {
  let receivedBody = null;
  await withFakeApiServer(
    (req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ purged: 1, keys: ['C1010'] }));
      });
    },
    async (backend) => {
      const result = await backend.purgeStaleReservations({ olderThanHours: 24, dryRun: true });
      assert.deepStrictEqual(result, { purged: 1, keys: ['C1010'] });
      assert.strictEqual(receivedBody.dry_run, true);
    }
  );
});

