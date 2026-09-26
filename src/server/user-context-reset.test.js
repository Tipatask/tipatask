'use strict';

// (C1522) Re-auth as a DIFFERENT user must drop every cached identity/scoping artifact:
// _currentUserId, the assignee-scoped task-list caches, and the status/project-settings
// registries. Before this fix, _currentUserId was only reset by reconfigureAndProbe() —
// the forked task server and the MCP stdio child never call that on a re-auth (only the
// Electron main-process per-window backend does), so their board/`?assignee=` scoping
// stayed on the previous user until a process restart. The fix hangs the reset off
// getApiCredentials()'s token-change watcher, which every process already calls on its
// own next request (apiRequest/_fetchCurrentUserId/_probeConnection) — no new IPC needed.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');

// Same throwaway-project harness as board-assignee-scope.test.js / reserve-task-keys.test.js.
async function withFakeApiServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-user-context-reset-'));
  const config = {
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${port}`,
    API_TOKEN: 'token-a',
    API_PROJECT_ID: '1',
  };
  writeProjectConfig(projectRoot, config);
  const backend = createApiBackend(null, projectRoot);
  try {
    await run(backend, { projectRoot, config, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// token-a belongs to user 7, token-b to user 9 — mirrors a re-auth as a different account.
const TOKEN_TO_USER = { 'token-a': 7, 'token-b': 9 };

function makeHandler(state) {
  return (req, res) => {
    if (req.url === '/api/auth/me') {
      state.meCalls++;
      const auth = req.headers.authorization || '';
      const token = auth.replace(/^Bearer\s+/, '');
      const userId = TOKEN_TO_USER[token];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ user: { id: userId ?? null } }));
    }
    // Every other request in this test is a /tasks* board/list fetch — record the
    // ?assignee= param actually sent on the wire and answer with an empty, valid payload.
    state.lastTasksUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      tasks: [],
      window: { floor: 0, has_older: false, extended: 0 },
    }));
  };
}

function assigneeParam(url) {
  const m = /[?&]assignee=([^&]+)/.exec(url || '');
  return m ? m[1] : null;
}

test('resetUserContext() fires on a token swap: identity and board scoping follow the new user', async () => {
  const state = { meCalls: 0, lastTasksUrl: null };
  await withFakeApiServer(makeHandler(state), async (backend, { projectRoot, config }) => {
    await backend.init();
    assert.strictEqual(await backend.getCurrentUserId(), 7, 'resolves the initial token\'s user');
    assert.strictEqual(state.meCalls, 1);

    await backend.getBoardTasks();
    assert.strictEqual(assigneeParam(state.lastTasksUrl), '7', 'board fetch scoped to user 7');

    // Re-auth as a different user — same shape as reconfigureWindowBackend() writing a
    // fresh API_TOKEN after force-reauth, but WITHOUT calling reconfigureAndProbe(): this
    // is exactly the forked-server/MCP-child situation, which only ever re-reads
    // config.json on its own next request.
    writeProjectConfig(projectRoot, { ...config, API_TOKEN: 'token-b' });

    assert.strictEqual(await backend.getCurrentUserId(), 9, 'identity follows the new token');
    assert.strictEqual(state.meCalls, 2, 'exactly one re-fetch of /me — one reset, not a loop');

    await backend.getBoardTasks();
    assert.strictEqual(assigneeParam(state.lastTasksUrl), '9', 'board cache was dropped, not reused, under the new user');

    // Steady state: no further /me calls once the new identity is resolved.
    await backend.getCurrentUserId();
    await backend.getBoardTasks();
    assert.strictEqual(state.meCalls, 2, 'no reset loop — identity stays resolved once refreshed');
  });
});

test('resetUserContext() does not fire on a no-op re-read of the same token', async () => {
  const state = { meCalls: 0, lastTasksUrl: null };
  await withFakeApiServer(makeHandler(state), async (backend, { projectRoot, config }) => {
    await backend.init();
    await backend.getBoardTasks();
    assert.strictEqual(state.meCalls, 1);

    // Rewrite the SAME token — e.g. an unrelated config field changing (theme, language).
    writeProjectConfig(projectRoot, { ...config, language: 'uk' });

    await backend.getBoardTasks();
    await backend.getCurrentUserId();
    assert.strictEqual(state.meCalls, 1, 'identical token — no reset, no extra /me call');
    assert.strictEqual(assigneeParam(state.lastTasksUrl), '7', 'still scoped to the same user');
  });
});

test('backend.resetUserContext() is available for an explicit caller-driven reset', async () => {
  const state = { meCalls: 0, lastTasksUrl: null };
  await withFakeApiServer(makeHandler(state), async (backend) => {
    await backend.init();
    assert.strictEqual(await backend.getCurrentUserId(), 7);

    backend.resetUserContext('test');
    assert.strictEqual(state.meCalls, 1, 'reset alone does not re-fetch — only the next read does');

    assert.strictEqual(await backend.getCurrentUserId(), 7, 're-resolves against whatever token is live');
    assert.strictEqual(state.meCalls, 2);
  });
});
