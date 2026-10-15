'use strict';

// Real-transport lock for the task key createTask() -> _rawCreateTask -> POST /tasks sends.
// TPT9004 (single-allocator rule): no key ever reaches POST /tasks — not the manual New Task
// form's C<n> guess (TPT622), not a key that happens to sit in the project's own namespace
// (how a project ends up with TPT70x beside TPT900x), not an H<n> guess for a HUMAN task.
// The API's allocateTaskKeyOnCreate() assigns <task_prefix>N / H<n>; a reserved key is
// finalized by PATCH, never POSTed. The fake below mirrors that allocator and its read-only
// peek (GET /tasks/next-key, TPT659) off one shared counter, so the create-equals-peek parity
// the New Task form's Preview badge relies on is checked end-to-end over real HTTP.
//
// Same fake-HTTP harness shape as api-backend-create-assignee.test.js. Never touches port
// 4455 or production (web.tipatask.com).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-create-prefix-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { writeAccountToken, clearAccountToken } = require('./account-store');

async function withFakeApiServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-create-prefix-'));
  writeProjectConfig(projectRoot, {
    TASK_BACKEND: 'api',
    API_BASE_URL: baseUrl,
    API_PROJECT_ID: '1',
  });
  writeAccountToken(baseUrl, 'test-token');
  const backend = createApiBackend(null, projectRoot);
  backend.resetUserContext('test');
  try {
    await run(backend);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    clearAccountToken(baseUrl);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// Mimics the API: a keyless CODING POST gets `${taskPrefix}${next}`, HUMAN gets H<next>, both
// off the same counter GET /tasks/next-key peeks. An explicit key would be inserted as-is by
// the real API (the bypass this suite locks out), so it is echoed back to make a leak visible.
// `state.projectStatus` other than 200 simulates an unreadable project row.
function makeServer(state) {
  return (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const prefixFor = (category) => (category === 'HUMAN' ? 'H' : (state.taskPrefix || 'C'));

      if (req.method === 'GET' && pathname === '/api/auth/me') {
        return send(200, { user: { id: 7 } });
      }
      if (req.method === 'GET' && pathname === '/api/projects/1') {
        state.projectReads += 1;
        if (state.projectStatus !== 200) return send(state.projectStatus, { error: 'unavailable' });
        return send(200, { project: { id: 1, name: 'MoneyMero', task_prefix: state.taskPrefix } });
      }
      if (req.method === 'GET' && pathname === '/api/projects/1/tasks/next-key') {
        const prefix = prefixFor(url.searchParams.get('category'));
        return send(200, { task_key: `${prefix}${(state.next[prefix] || 0) + 1}` });
      }
      if (req.method === 'POST' && pathname === '/api/projects/1/tasks') {
        const parsed = JSON.parse(body);
        state.posts.push(parsed);
        let taskKey = parsed.task_key;
        if (!taskKey) {
          const prefix = prefixFor(parsed.category);
          state.next[prefix] = (state.next[prefix] || 0) + 1;
          taskKey = `${prefix}${state.next[prefix]}`;
        }
        return send(201, { task: { id: 2, project_id: 1, ...parsed, task_key: taskKey } });
      }
      state.unexpected.push(`${req.method} ${req.url}`);
      return send(404, { error: 'not found' });
    });
  };
}

function baseState(overrides = {}) {
  return { taskPrefix: 'MNY', projectStatus: 200, posts: [], next: {}, unexpected: [], projectReads: 0, ...overrides };
}

function newTask(overrides) {
  return {
    id: 'C1',
    title: 'Generating a project logo',
    description: 'Design a logo symbol',
    category: 'CODING',
    status: 'pending',
    priority: 3,
    order: 1,
    dependencies: [],
    tags: [],
    assignee: 1,
    ...overrides,
  };
}

test('a legacy C<n> guess is dropped and the project prefix key comes back (MoneyMero -> MNY1)', async () => {
  const state = baseState();
  await withFakeApiServer(makeServer(state), async (backend) => {
    const created = await backend.createTask(newTask());

    assert.deepStrictEqual(state.unexpected, []);
    assert.strictEqual(state.posts.length, 1);
    assert.ok(!('task_key' in state.posts[0]), 'the C1 guess must not reach POST /tasks');
    assert.strictEqual(created.id, 'MNY1');
  });
});

test('a key already in the project namespace is dropped too — the API allocates (TPT9004)', async () => {
  const state = baseState();
  await withFakeApiServer(makeServer(state), async (backend) => {
    const created = await backend.createTask(newTask({ id: 'MNY7' }));

    assert.ok(!('task_key' in state.posts[0]), 'an in-namespace guess is still a guess — it was how TPT701 landed beside TPT9003');
    assert.strictEqual(created.id, 'MNY1', 'the counter decides, not the client');
    assert.strictEqual(state.projectReads, 0, 'no project-row read is needed to decide anymore');
  });
});

test('a foreign prefix is dropped too', async () => {
  const state = baseState();
  await withFakeApiServer(makeServer(state), async (backend) => {
    const created = await backend.createTask(newTask({ id: 'TPT5' }));

    assert.ok(!('task_key' in state.posts[0]));
    assert.strictEqual(created.id, 'MNY1');
  });
});

test('a HUMAN H<n> guess is dropped and the API allocates the next H key', async () => {
  const state = baseState();
  await withFakeApiServer(makeServer(state), async (backend) => {
    const created = await backend.createTask(newTask({ id: 'H4', category: 'HUMAN' }));

    assert.ok(!('task_key' in state.posts[0]));
    assert.strictEqual(created.id, 'H1');
  });
});

test('an unreadable project row still never persists a C<n> guess', async () => {
  const state = baseState({ projectStatus: 500 });
  await withFakeApiServer(makeServer(state), async (backend) => {
    const created = await backend.createTask(newTask());

    assert.ok(!('task_key' in state.posts[0]), 'unknown prefix: legacy C is still a guess');
    assert.strictEqual(created.id, 'MNY1', 'the API side holds the real prefix');
  });
});

// The New Task form's verification: the key a create lands on is the key the API peeked just
// before it (GET /tasks/next-key, the Preview badge's source) — one allocator, one sequence.
test('a create lands on the key getNextTaskKey() peeked right before it, for CODING and HUMAN', async () => {
  const state = baseState();
  await withFakeApiServer(makeServer(state), async (backend) => {
    const codingPeek = await backend.getNextTaskKey('CODING');
    const coding = await backend.createTask(newTask({ id: 'MNY999' }));
    assert.strictEqual(codingPeek, 'MNY1');
    assert.strictEqual(coding.id, codingPeek, 'the create took the peeked number, not the client id');
    assert.ok(!('task_key' in state.posts[0]));

    const humanPeek = await backend.getNextTaskKey('HUMAN');
    const human = await backend.createTask(newTask({ id: 'H77', category: 'HUMAN' }));
    assert.strictEqual(humanPeek, 'H1');
    assert.strictEqual(human.id, humanPeek);

    assert.strictEqual(await backend.getNextTaskKey('CODING'), 'MNY2', 'the peek moved past the allocated key');
    assert.deepStrictEqual(state.unexpected, []);
  });
});

test('a key-shaped client id is logged as dropped; a synthetic id is not', async (t) => {
  const state = baseState();
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  await withFakeApiServer(makeServer(state), async (backend) => {
    await backend.createTask(newTask({ id: 'MNY7' }));
    assert.ok(logs.some(l => l.includes('dropped client key MNY7')), `expected a dropped-key log, got ${JSON.stringify(logs)}`);

    logs.length = 0;
    await backend.createTask(newTask({ id: 'new-1760000000000-1' }));
    assert.ok(!logs.some(l => l.includes('dropped client key')), 'a synthetic id is the normal case — no log');
    assert.strictEqual(state.posts.length, 2);
    assert.ok(state.posts.every(p => !('task_key' in p)));
  });
});
