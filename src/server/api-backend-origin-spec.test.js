'use strict';

// TPT29 — real-transport integration test for the origin-spec-capture hook wired into
// api-backend.js's updateTask(). Exercises the genuine updateTask -> _rawUpdateTask ->
// PATCH /tasks/:key -> POST /tasks/:key/comments chain against a throwaway fake HTTP
// server. Never touches port 4455 or production (web.tipatask.com).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// writeProjectConfig() routes API_TOKEN into the account store under TIPATASK_USER_DATA.
// Own user-data root: the test runner's shared one is rewritten concurrently by other files.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-origin-spec-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');

// Same throwaway-project harness as board-assignee-scope.test.js / user-context-reset.test.js.
async function withFakeApiServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-origin-spec-'));
  writeProjectConfig(projectRoot, {
    TASK_BACKEND: 'api',
    API_BASE_URL: `http://127.0.0.1:${port}`,
    API_TOKEN: 'test-token',
    API_PROJECT_ID: '1',
  });
  const backend = createApiBackend(null, projectRoot);
  try {
    await run(backend);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// Builds a fake API server around a mutable `state.task` row. Records every request in
// state.requests (method+url) and every posted comment body in state.comments.
function makeServer(state) {
  return (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.requests.push(`${req.method} ${req.url}`);
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      if (req.method === 'GET' && req.url === '/api/projects/1/tasks/C500') {
        return send(200, { task: state.task });
      }
      if (req.method === 'PATCH' && req.url === '/api/projects/1/tasks/C500') {
        if (state.patchStatus && state.patchStatus !== 200) {
          return send(state.patchStatus, { error: 'unregistered tag' });
        }
        const patch = JSON.parse(body);
        state.lastPatch = patch;
        state.task = { ...state.task, ...patch };
        return send(200, { task: state.task });
      }
      if (req.method === 'GET' && req.url === '/api/projects/1/tasks/C500/comments') {
        return send(200, { comments: state.existingComments || [] });
      }
      if (req.method === 'POST' && req.url === '/api/projects/1/tasks/C500/comments') {
        const parsed = JSON.parse(body);
        state.comments.push(parsed);
        return send(201, { comment: { id: state.comments.length, ...parsed } });
      }
      if (req.method === 'GET' && req.url === '/api/projects/1/images/task/C500') {
        return send(200, { images: state.images || [] });
      }
      if (req.method === 'GET' && req.url === '/api/projects/1/files/task/C500') {
        return send(200, { files: state.files || [] });
      }
      if (req.method === 'GET' && req.url === '/api/projects/1/tasks/C501') {
        return send(200, { task: state.task });
      }
      if (req.method === 'PATCH' && req.url === '/api/projects/1/tasks/C501') {
        const patch = JSON.parse(body);
        state.task = { ...state.task, ...patch };
        return send(200, { task: state.task });
      }
      return send(404, { error: 'not found' });
    });
  };
}

function baseState(overrides) {
  return {
    requests: [],
    comments: [],
    existingComments: [],
    images: [],
    files: [],
    task: {
      id: 1,
      project_id: 1,
      task_key: 'C500',
      title: 'Original title',
      description: 'Original text',
      category: 'CODING',
      status: 'pending',
      priority: 1,
      is_objective: 1,
      ...overrides,
    },
  };
}

test('updateTask: adoption-shaped patch posts exactly one spec comment after the PATCH lands', async () => {
  const state = baseState({});
  state.images = [{ id: 1, url: '/api/projects/1/images/1', filename: 'diagram.png' }];
  state.files = [{ id: 1, url: '/api/projects/1/files/1', filename: 'spec.pdf' }];
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.updateTask('C500', { isObjective: false, title: 'Refined title', description: 'Refined text' });

    assert.strictEqual(state.comments.length, 1, 'expected exactly one spec comment');
    const posted = state.comments[0];
    assert.strictEqual(posted.type, 'spec');
    assert.ok(posted.content.startsWith('## Original Objective (reference only)'));
    assert.ok(posted.content.includes('### Original title\n\nOriginal text'));
    assert.ok(posted.content.includes('### Attachments'));
    assert.ok(posted.content.includes('diagram.png'));
    assert.ok(posted.content.includes('spec.pdf'));

    assert.strictEqual(state.lastPatch.is_objective, false);
    assert.strictEqual(state.lastPatch.description, 'Refined text');

    const getIdx = state.requests.indexOf('GET /api/projects/1/tasks/C500');
    const patchIdx = state.requests.indexOf('PATCH /api/projects/1/tasks/C500');
    const postIdx = state.requests.indexOf('POST /api/projects/1/tasks/C500/comments');
    assert.ok(getIdx > -1 && patchIdx > -1 && postIdx > -1);
    assert.ok(getIdx < patchIdx, 'GET must precede PATCH');
    assert.ok(postIdx > patchIdx, 'the spec comment must post only after the PATCH succeeds');
  });
});

test('updateTask: attachments already inlined in the description produce no Attachments block', async () => {
  const imgUrl = '/api/projects/1/images/1';
  const fileUrl = '/api/projects/1/files/1';
  const state = baseState({ description: `Original text ![d](${imgUrl}) [s](${fileUrl})` });
  state.images = [{ id: 1, url: imgUrl, filename: 'diagram.png' }];
  state.files = [{ id: 1, url: fileUrl, filename: 'spec.pdf' }];
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.updateTask('C500', { isObjective: false, description: 'Refined text' });
    assert.strictEqual(state.comments.length, 1);
    assert.ok(!state.comments[0].content.includes('### Attachments'));
  });
});

test('updateTask: ordinary edit-modal write (no is_objective flag) posts zero comments', async () => {
  const state = baseState({});
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.updateTask('C500', { description: 'just an edit' });
    assert.strictEqual(state.comments.length, 0);
  });
});

test('updateTask: overwriteRaw carried-over-task shape (live row already non-objective) posts zero comments and never reads comments', async () => {
  const state = baseState({ is_objective: 0 });
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.updateTask('C500', { isObjective: false, description: 'Original text' });
    assert.strictEqual(state.comments.length, 0);
    assert.ok(!state.requests.includes('GET /api/projects/1/tasks/C500/comments'));
  });
});

test('updateTask: a rejected PATCH posts zero comments (orphan-comment guard)', async () => {
  const state = baseState({});
  state.patchStatus = 400;
  await withFakeApiServer(makeServer(state), async (backend) => {
    await assert.rejects(() => backend.updateTask('C500', { isObjective: false, description: 'Refined text' }));
    assert.strictEqual(state.comments.length, 0);
  });
});

test('updateTask: running the same adoption twice posts exactly one comment total (idempotent)', async () => {
  const state = baseState({});
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.updateTask('C500', { isObjective: false, description: 'Refined text' });
    // Second save: live row is now already non-objective (the PATCH above landed it),
    // and would independently bail on the live.isObjective===true gate too.
    await backend.updateTask('C500', { isObjective: false, description: 'Refined again' });
    assert.strictEqual(state.comments.length, 1);
  });
});
