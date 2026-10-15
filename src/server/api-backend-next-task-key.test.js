'use strict';

// TPT659 — getNextTaskKey(category): GET /tasks/next-key, the key the API would allocate for
// the next keyless create. Fails open to null on every failure — the New Task Preview keeps
// its own nextTaskKeyGuess() — and never throws.
//
// Genuine backend against a throwaway fake HTTP server; never port 4455 or a real API.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Own user-data root: the test runner's shared one is rewritten concurrently by other files.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-next-key-data-'));
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
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-next-key-'));
  writeProjectConfig(projectRoot, {
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    API_TOKEN: 'test-token',
    API_PROJECT_ID: '1',
  });
  try {
    await run(createApiBackend(null, projectRoot), requests, server);
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

test('getNextTaskKey: returns the API key and forwards the category', async () => {
  await withBackend(
    (req, res) => json(res, 200, { task_key: req.url.includes('HUMAN') ? 'H9' : 'MNY42' }),
    async (backend, requests) => {
      assert.equal(await backend.getNextTaskKey('CODING'), 'MNY42');
      assert.equal(await backend.getNextTaskKey('HUMAN'), 'H9');
      assert.equal(await backend.getNextTaskKey(undefined), 'MNY42', 'anything but HUMAN is CODING');
      assert.deepEqual(requests, [
        'GET /api/projects/1/tasks/next-key?category=CODING',
        'GET /api/projects/1/tasks/next-key?category=HUMAN',
        'GET /api/projects/1/tasks/next-key?category=CODING',
      ]);
    },
  );
});

test('getNextTaskKey: 404 (deployment predating the route) returns null', async () => {
  await withBackend(
    (req, res) => json(res, 404, { error: 'Task not found' }),
    async (backend) => { assert.equal(await backend.getNextTaskKey('CODING'), null); },
  );
});

test('getNextTaskKey: a malformed body or a 4xx/5xx returns null, never throws', async () => {
  for (const [status, body] of [[200, {}], [200, { task_key: 7 }], [200, { task_key: '' }], [400, { error: 'bad' }], [500, { error: 'boom' }]]) {
    await withBackend(
      (req, res) => json(res, status, body),
      async (backend) => { assert.equal(await backend.getNextTaskKey('CODING'), null, `${status} ${JSON.stringify(body)}`); },
    );
  }
});

test('getNextTaskKey: an unreachable API returns null, never throws', async () => {
  await withBackend(
    (req, res) => json(res, 200, { task_key: 'MNY1' }),
    async (backend, requests, server) => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      assert.equal(await backend.getNextTaskKey('CODING'), null);
    },
  );
});
