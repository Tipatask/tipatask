'use strict';

// TPT61 — GET/PATCH /api/project(/settings) vcs_* round-trip. Same createHttpHandler +
// stub-backend harness as member-assignee.test.js / api-config-project-root.test.js.
// Offline only — no network, no real API (.tipatask/config.json here points at
// production, web.tipatask.com, so live-hitting it from a test is never OK).

process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { createHttpHandler } = require('./ws-handlers');

function fakeReq(method, url, { body } = {}) {
  const req = { method, url, headers: {} };
  req[Symbol.asyncIterator] = async function* () {
    if (body != null) yield Buffer.from(body);
  };
  return req;
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

function json(res) {
  return JSON.parse(res.body || '{}');
}

// getCredentials() must resolve truthy so PATCH /api/project's resolveProjectContext()
// doesn't short-circuit to { ok: true, skipped: true } before ever calling updateProject().
function makeBackend({ row = null, updateProject } = {}) {
  const calls = [];
  return {
    calls,
    getCredentials() { return { baseUrl: 'https://tt.example.test', projectId: '2', token: 'tok' }; },
    async getProjectSettings() { return row; },
    async updateProject(fields) {
      calls.push(fields);
      if (updateProject) return updateProject(fields);
      return { ...row, ...fields };
    },
  };
}

test('GET /api/project/settings reports raw vcs_* fields off a git-project row', async () => {
  const backend = makeBackend({
    row: { vcs_type: 'git', vcs_worktree_enabled: 1, vcs_commit_enabled: 1, vcs_pr_enabled: 0, vcs_merge_enabled: 1 },
  });
  const handler = createHttpHandler(new Map(), () => backend, null);
  const res = fakeRes();
  await handler(fakeReq('GET', '/api/project/settings'), res);
  const body = json(res);
  assert.equal(res.statusCode, 200);
  assert.equal(body.vcsType, 'git');
  assert.equal(body.vcsWorktreeEnabled, true);
  assert.equal(body.vcsCommitEnabled, true);
  assert.equal(body.vcsPrEnabled, false);
  assert.equal(body.vcsMergeEnabled, true);
});

test('GET /api/project/settings does NOT mask dormant flags when vcs_type is svn (raw, not normalizeVcsSettings())', async () => {
  const backend = makeBackend({
    row: { vcs_type: 'svn', vcs_worktree_enabled: 1, vcs_commit_enabled: 0, vcs_pr_enabled: 1, vcs_merge_enabled: 1 },
  });
  const handler = createHttpHandler(new Map(), () => backend, null);
  const res = fakeRes();
  await handler(fakeReq('GET', '/api/project/settings'), res);
  const body = json(res);
  // Regression guard: normalizeVcsSettings() would force these to false since type !== 'git'.
  // A settings FORM must show the stored choice survives a type switch (dormant-flag rule).
  assert.equal(body.vcsType, 'svn');
  assert.equal(body.vcsWorktreeEnabled, true);
  assert.equal(body.vcsCommitEnabled, false);
  assert.equal(body.vcsPrEnabled, true);
  assert.equal(body.vcsMergeEnabled, true);
});

test('GET /api/project/settings reports vcsType null for a null stored value', async () => {
  const backend = makeBackend({ row: { vcs_type: null } });
  const handler = createHttpHandler(new Map(), () => backend, null);
  const res = fakeRes();
  await handler(fakeReq('GET', '/api/project/settings'), res);
  assert.equal(json(res).vcsType, null);
  assert.equal(json(res).vcsMergeEnabled, false);
});

test('PATCH /api/project saves the merge choice and GET restores it after a type switch', async () => {
  const row = { vcs_type: 'git', vcs_merge_enabled: 0 };
  const backend = makeBackend({ row, updateProject: async (fields) => Object.assign(row, fields) });
  const handler = createHttpHandler(new Map(), () => backend, null);
  for (const patch of [{ vcs_merge_enabled: true }, { vcs_type: 'svn' }, { vcs_type: 'git' }, { vcs_merge_enabled: false }]) {
    const res = fakeRes();
    await handler(fakeReq('PATCH', '/api/project', { body: JSON.stringify(patch) }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(backend.calls.at(-1), patch);
    const read = fakeRes();
    await handler(fakeReq('GET', '/api/project/settings'), read);
    assert.equal(json(read).vcsMergeEnabled, patch.vcs_merge_enabled !== false);
    assert.equal(json(read).vcsType, row.vcs_type);
  }
});

test('PATCH /api/project rejects a non-boolean merge flag without sending it to the backend', async () => {
  const backend = makeBackend({ row: { vcs_type: 'git' } });
  const handler = createHttpHandler(new Map(), () => backend, null);
  const res = fakeRes();
  await handler(fakeReq('PATCH', '/api/project', { body: JSON.stringify({ vcs_merge_enabled: 1 }) }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error, 'vcs_merge_enabled must be a boolean');
  assert.equal(backend.calls.length, 0);
});

test('GET /api/project/settings falls back to vcsType null for a value that is neither git nor svn (defensive)', async () => {
  const backend = makeBackend({ row: { vcs_type: 'hg' } }); // never legitimately stored, but defensive
  const handler = createHttpHandler(new Map(), () => backend, null);
  const res = fakeRes();
  await handler(fakeReq('GET', '/api/project/settings'), res);
  assert.equal(json(res).vcsType, null);
});

test('PATCH /api/project with git + worktree flag reaches backend.updateProject with exactly those keys', async () => {
  const backend = makeBackend({ row: { vcs_type: null } });
  const handler = createHttpHandler(new Map(), () => backend, null);
  const res = fakeRes();
  await handler(fakeReq('PATCH', '/api/project', {
    body: JSON.stringify({ vcs_type: 'git', vcs_worktree_enabled: true }),
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(backend.calls.length, 1);
  assert.deepEqual(backend.calls[0], { vcs_type: 'git', vcs_worktree_enabled: true });
  assert.equal(json(res).ok, true);
});

test('PATCH /api/project normalizes vcs_type "" (Disabled radio) to null', async () => {
  const backend = makeBackend({ row: { vcs_type: 'git' } });
  const handler = createHttpHandler(new Map(), () => backend, null);
  const res = fakeRes();
  await handler(fakeReq('PATCH', '/api/project', {
    body: JSON.stringify({ vcs_type: '' }),
  }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(backend.calls[0], { vcs_type: null });
});

test('PATCH /api/project rejects an unrecognized vcs_type without calling updateProject', async () => {
  const backend = makeBackend({ row: {} });
  const handler = createHttpHandler(new Map(), () => backend, null);
  const res = fakeRes();
  await handler(fakeReq('PATCH', '/api/project', {
    body: JSON.stringify({ vcs_type: 'hg' }),
  }), res);
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /vcs_type must be/);
  assert.equal(backend.calls.length, 0);
});

test('PATCH /api/project rejects a non-boolean vcs flag without calling updateProject', async () => {
  const backend = makeBackend({ row: {} });
  const handler = createHttpHandler(new Map(), () => backend, null);
  const res = fakeRes();
  await handler(fakeReq('PATCH', '/api/project', {
    body: JSON.stringify({ vcs_commit_enabled: 1 }), // number, not boolean
  }), res);
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /vcs_commit_enabled must be a boolean/);
  assert.equal(backend.calls.length, 0);
});

test('PATCH /api/project with a language-only body still round-trips unchanged (no vcs regression)', async () => {
  const backend = makeBackend({ row: {} });
  const handler = createHttpHandler(new Map(), () => backend, null);
  const res = fakeRes();
  await handler(fakeReq('PATCH', '/api/project', {
    body: JSON.stringify({ language: 'uk' }),
  }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(backend.calls[0], { language: 'uk' });
});

test('Electron settings expose and save merge per window, preserving the dormant choice', async () => {
  const firstRow = { vcs_type: 'svn', vcs_merge_enabled: 1 };
  const first = makeBackend({ row: firstRow, updateProject: async (fields) => Object.assign(firstRow, fields) });
  const second = makeBackend({ row: { vcs_type: 'git', vcs_merge_enabled: 0 } });
  const states = new Map([[1, { backend: first }], [2, { backend: second }]]);
  const handlers = new Map();
  const routerPath = require.resolve('../../main/ipc/api-router');
  const prior = require.cache[routerPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, app: {} };
    if (request === '../window-state') return { getWindowState: id => states.get(id) };
    if (request === '../../src/server/config') return {};
    if (request === '../../src/server/reopen-closed-task') return { applyReopenToPatch() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[routerPath];
    require(routerPath).registerApiHandlers();
  } finally {
    Module._load = originalLoad;
    if (prior) require.cache[routerPath] = prior;
    else delete require.cache[routerPath];
  }
  const event = id => ({ sender: { id } });
  const settings = id => handlers.get('api:project.settings')(event(id));
  const before = await settings(1);
  assert.equal(before.vcsType, 'svn');
  assert.equal(before.vcsMergeEnabled, true);
  assert.equal((await settings(2)).vcsMergeEnabled, false);
  await handlers.get('api:project.update')(event(1), { fields: { vcs_type: 'git', vcs_merge_enabled: false } });
  assert.deepEqual(first.calls, [{ vcs_type: 'git', vcs_merge_enabled: false }]);
  assert.equal((await settings(1)).vcsMergeEnabled, false);
  assert.equal(second.calls.length, 0);
  const httpRes = fakeRes();
  await createHttpHandler(new Map(), () => first, null)(fakeReq('GET', '/api/project/settings'), httpRes);
  for (const field of ['vcsType', 'vcsWorktreeEnabled', 'vcsCommitEnabled', 'vcsPrEnabled', 'vcsMergeEnabled']) {
    assert.equal((await settings(1))[field], json(httpRes)[field], `HTTP/IPC parity: ${field}`);
  }
});
