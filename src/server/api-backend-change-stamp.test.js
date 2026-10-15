'use strict';

// TPT610 — getTaskChangeStamp(): GET /tasks/changes (TPT609) normalized to a fixed shape;
// only a 404 means "route missing" (null → the poll falls back to the full list). A
// transport failure must reject, never resolve null.
//
// Genuine backend against a throwaway fake HTTP server; never port 4455 or a real API.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Own user-data root: the test runner's shared one is rewritten concurrently by other files.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-change-stamp-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');

async function withBackend(handler, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-change-stamp-'));
  writeProjectConfig(projectRoot, {
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    API_TOKEN: 'test-token',
    API_PROJECT_ID: '1',
  });
  try {
    await run(createApiBackend(null, projectRoot), requests);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

test('getTaskChangeStamp: 200 returns the stamp in a fixed key order', async () => {
  await withBackend(
    (req, res) => json(res, 200, { max_updated_at: '2026-10-12T10:00:00.000Z', max_id: 42, count: 7 }),
    async (backend, requests) => {
      const stamp = await backend.getTaskChangeStamp();
      assert.deepEqual(stamp, { count: 7, max_id: 42, max_updated_at: '2026-10-12T10:00:00.000Z' });
      assert.deepEqual(Object.keys(stamp), ['count', 'max_id', 'max_updated_at']);
      assert.deepEqual(requests, ['GET /api/projects/1/tasks/changes']);
    },
  );
});

test('getTaskChangeStamp: an empty project keeps nulls', async () => {
  await withBackend(
    (req, res) => json(res, 200, { count: 0, max_id: null, max_updated_at: null }),
    async (backend) => {
      assert.deepEqual(await backend.getTaskChangeStamp(), { count: 0, max_id: null, max_updated_at: null });
    },
  );
});

test('getTaskChangeStamp: 404 (deployment predating the route) returns null', async () => {
  await withBackend(
    (req, res) => json(res, 404, { error: 'Task not found' }),
    async (backend) => {
      assert.equal(await backend.getTaskChangeStamp(), null);
    },
  );
});

test('getTaskChangeStamp: a transport failure rejects instead of returning null', async () => {
  await withBackend(
    (req, res) => req.socket.destroy(),
    async (backend) => {
      await assert.rejects(backend.getTaskChangeStamp(), (err) => err.networkError === true);
    },
  );
});
