'use strict';

// A task-list response that was already in flight when a write invalidated the caches
// predates that write. It must not be installed as the fresh cache entry, and it must not
// clear the in-flight slot of the request that replaced it — otherwise a save that just
// reserved a key reads a list without that key and tries to create the row a second time.
//
// Genuine backend against a throwaway fake HTTP server; never port 4455 or a real API.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// writeProjectConfig() routes API_TOKEN into the account store under TIPATASK_USER_DATA.
// Own user-data root: the test runner's shared one is rewritten concurrently by other files.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-list-gen-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');

function row(taskKey, dbId, extra = {}) {
  return {
    id: dbId, project_id: 1, task_key: taskKey, title: taskKey, description: 'x',
    category: 'CODING', status: 'pending', priority: 1, tags: [], ...extra,
  };
}

async function withBackend(state, run) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const pathname = req.url.split('?')[0];
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && pathname === '/api/projects/1/tasks') {
        state.listRequests += 1;
        // Snapshot at request time, answered later — the response a slow API would give.
        const snapshot = JSON.parse(JSON.stringify(state.rows));
        const release = () => send(200, { tasks: snapshot });
        if (state.holdNextList) {
          state.holdNextList = false;
          state.releaseHeld = release;
          return undefined;
        }
        return release();
      }
      if (req.method === 'POST' && pathname === '/api/projects/1/tasks/reserve') {
        const reserved = row('C901', 901, { title: 'New task', is_reservation: 1 });
        state.rows.push(reserved);
        return send(201, { tasks: [reserved] });
      }
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-list-gen-'));
  writeProjectConfig(projectRoot, {
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    API_TOKEN: 'test-token',
    API_PROJECT_ID: '1',
  });
  try {
    await run(createApiBackend(null, projectRoot));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(predicate(), 'condition was never reached');
}

test('a list response in flight across a reservation is not served as the fresh list', async () => {
  const state = { rows: [row('C1', 1)], listRequests: 0, holdNextList: true, releaseHeld: null };
  await withBackend(state, async (backend) => {
    const stale = backend.getTasksUnfiltered();          // snapshot taken before the reserve
    await until(() => typeof state.releaseHeld === 'function');

    await backend.reserveTaskKeys({ count: 1 });         // writes, invalidates the caches
    state.releaseHeld();                                 // the old response lands afterwards
    assert.deepEqual((await stale).map(t => t.id), ['C1'], 'the original caller still gets its own answer');

    const fresh = await backend.getTasksUnfiltered();
    assert.deepEqual(fresh.map(t => t.id), ['C1', 'C901'], 'the reserved key must be visible to the next read');
    assert.equal(state.listRequests, 2, 'the stale response was not cached');
  });
});

test('a superseded request does not clear the in-flight slot of its replacement', async () => {
  const state = { rows: [row('C1', 1)], listRequests: 0, holdNextList: true, releaseHeld: null };
  await withBackend(state, async (backend) => {
    const first = backend.getTasksUnfiltered();
    await until(() => typeof state.releaseHeld === 'function');
    const releaseFirst = state.releaseHeld;

    await backend.reserveTaskKeys({ count: 1 });
    state.holdNextList = true;
    state.releaseHeld = null;
    const second = backend.getTasksUnfiltered();         // the replacement, also held
    await until(() => typeof state.releaseHeld === 'function');
    const releaseSecond = state.releaseHeld;

    releaseFirst();
    await first;
    const joined = backend.getTasksUnfiltered();         // must join `second`, not start a third
    releaseSecond();
    assert.deepEqual((await second).map(t => t.id), ['C1', 'C901']);
    assert.deepEqual((await joined).map(t => t.id), ['C1', 'C901']);
    assert.equal(state.listRequests, 2);
  });
});
