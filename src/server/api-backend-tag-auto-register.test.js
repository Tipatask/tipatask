'use strict';

// TPT623 — Task App UI saves register unknown tags with an LLM-written description instead
// of failing the C1439 tag gate. Real api-backend transport against a fake API server; the
// LLM describer (tag-auto-register.js describeTagsWithLlm) is stubbed. Never touches port
// 4455 or production (web.tipatask.com).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-tag-auto-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const tagAutoRegister = require('./tag-auto-register');
const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { writeAccountToken, clearAccountToken } = require('./account-store');

let describeCalls;
let describeResult;
beforeEach(() => {
  describeCalls = [];
  describeResult = new Map();
  tagAutoRegister.describeTagsWithLlm = async (names, opts) => {
    describeCalls.push({ names, context: opts && opts.context });
    return describeResult;
  };
});

async function withFakeApiServer(state, run) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const pathname = req.url.split('?')[0];
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const parsed = body ? JSON.parse(body) : null;
      if (req.method === 'GET' && pathname === '/api/auth/me') return send(200, { user: { id: 7 } });
      if (req.method === 'GET' && pathname === '/api/projects/1') return send(200, { project: { id: 1, task_prefix: 'MNY' } });
      if (req.method === 'GET' && pathname === '/api/projects/1/tags') {
        return send(200, { tags: state.tags.map(t => ({ name: t.name, description: t.description })) });
      }
      if (req.method === 'POST' && pathname === '/api/projects/1/tags') {
        state.calls.push('POST /tags');
        state.tagPosts.push(parsed);
        if (state.tagPostStatus && state.tagPostStatus !== 200) return send(state.tagPostStatus, { error: 'rejected' });
        for (const t of parsed.tags) state.tags.push(t);
        return send(200, { tags: parsed.tags });
      }
      if (req.method === 'POST' && pathname === '/api/projects/1/tasks') {
        state.calls.push('POST /tasks');
        state.taskPosts.push(parsed);
        return send(201, { task: { id: 2, project_id: 1, ...parsed, task_key: 'MNY1' } });
      }
      if (req.method === 'PATCH' && pathname.startsWith('/api/projects/1/tasks/')) {
        state.calls.push('PATCH /tasks');
        state.taskPatches.push(parsed);
        return send(200, { task: { id: 2, project_id: 1, task_key: 'MNY1', title: 'x', ...parsed } });
      }
      if (req.method === 'GET' && pathname === '/api/projects/1/tasks') return send(200, { tasks: [] });
      state.unexpected.push(`${req.method} ${req.url}`);
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-tag-auto-'));
  writeProjectConfig(projectRoot, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_PROJECT_ID: '1' });
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

function baseState(overrides = {}) {
  return {
    tags: [{ name: 'feature', description: 'New functionality.' }],
    calls: [], tagPosts: [], taskPosts: [], taskPatches: [], unexpected: [],
    ...overrides,
  };
}

function newTask(overrides) {
  return {
    title: 'Generating a project logo',
    description: 'Design a logo symbol',
    category: 'CODING',
    status: 'pending',
    priority: 3,
    dependencies: [],
    tags: ['feature', 'logo-design'],
    assignee: 1,
    ...overrides,
  };
}

test('createTask with autoRegisterTags registers logo-design (real description) before POST /tasks', async () => {
  const state = baseState();
  describeResult = new Map([['logo-design', 'Design work on the product logo mark and brand symbol.']]);
  await withFakeApiServer(state, async (backend) => {
    const created = await backend.createTask(newTask(), { autoRegisterTags: true });
    assert.deepStrictEqual(state.calls, ['POST /tags', 'POST /tasks']);
    assert.deepStrictEqual(state.tagPosts[0], { tags: [{ name: 'logo-design', description: 'Design work on the product logo mark and brand symbol.' }] });
    assert.deepStrictEqual(state.taskPosts[0].tags, ['feature', 'logo-design']);
    assert.strictEqual(created.id, 'MNY1');
    assert.deepStrictEqual(describeCalls, [{ names: ['logo-design'], context: { title: 'Generating a project logo', description: 'Design a logo symbol' } }]);
    assert.deepStrictEqual(state.unexpected, []);
  });
});

test('LLM failure keeps the gate error and writes nothing', async () => {
  const state = baseState();
  await withFakeApiServer(state, async (backend) => {
    await assert.rejects(backend.createTask(newTask(), { autoRegisterTags: true }), (err) => {
      assert.strictEqual(err.code, 'TAGS_UNREGISTERED');
      assert.match(err.message, /"logo-design"/);
      assert.match(err.message, /Automatic registration could not describe/);
      return true;
    });
    assert.deepStrictEqual(state.calls, []);
  });
});

test('a placeholder description from the model is never registered', async () => {
  const state = baseState();
  describeResult = new Map([['logo-design', 'Auto-registered by createTask']]);
  await withFakeApiServer(state, async (backend) => {
    await assert.rejects(backend.createTask(newTask(), { autoRegisterTags: true }), { code: 'TAGS_UNREGISTERED' });
    assert.deepStrictEqual(state.calls, []);
  });
});

test('a rejected POST /tags keeps the gate error', async () => {
  const state = baseState({ tagPostStatus: 400 });
  describeResult = new Map([['logo-design', 'Logo work.']]);
  await withFakeApiServer(state, async (backend) => {
    await assert.rejects(backend.createTask(newTask(), { autoRegisterTags: true }), { code: 'TAGS_UNREGISTERED' });
    assert.deepStrictEqual(state.calls, ['POST /tags']);
  });
});

test('without the flag (MCP agents) the strict gate is unchanged and the LLM is never asked', async () => {
  const state = baseState();
  describeResult = new Map([['logo-design', 'Logo work.']]);
  await withFakeApiServer(state, async (backend) => {
    await assert.rejects(backend.createTask(newTask()), (err) => {
      assert.strictEqual(err.code, 'TAGS_UNREGISTERED');
      assert.doesNotMatch(err.message, /Automatic registration/);
      return true;
    });
    assert.strictEqual(describeCalls.length, 0);
    assert.deepStrictEqual(state.calls, []);
  });
});

test('tt-* tags are never auto-registered', async () => {
  const state = baseState();
  describeResult = new Map([['tt-api-logo', 'Logo API module.']]);
  await withFakeApiServer(state, async (backend) => {
    await assert.rejects(backend.createTask(newTask({ tags: ['tt-api-logo'] }), { autoRegisterTags: true }), { code: 'TAGS_UNREGISTERED' });
    assert.deepStrictEqual(state.calls, []);
  });
});

test('updateTask with autoRegisterTags registers before the PATCH; without it, no gate on PATCH', async () => {
  const state = baseState();
  describeResult = new Map([['logo-design', 'Logo work.']]);
  await withFakeApiServer(state, async (backend) => {
    await backend.updateTask('MNY1', { tags: ['Feature', 'logo-design'] }, { autoRegisterTags: true });
    assert.deepStrictEqual(state.calls, ['POST /tags', 'PATCH /tasks']);
    assert.deepStrictEqual(state.taskPatches[0].tags, ['feature', 'logo-design'], 'rewritten to the registry spelling');

    state.calls.length = 0;
    describeCalls.length = 0;
    await backend.updateTask('MNY1', { tags: ['brand-new'] });
    assert.deepStrictEqual(state.calls, ['PATCH /tasks']);
    assert.strictEqual(describeCalls.length, 0);
  });
});

test('overwriteRaw honours autoRegisterTags from the manual New Task payload', async () => {
  const state = baseState();
  describeResult = new Map([['logo-design', 'Logo work.']]);
  await withFakeApiServer(state, async (backend) => {
    const payload = { tasks: [newTask({ id: 'C1' })], autoRegisterTags: true };
    await backend.overwriteRaw('# Tasks\n\n```json\n' + JSON.stringify(payload) + '\n```\n');
    assert.deepStrictEqual(state.calls.filter(c => c !== 'PATCH /tasks'), ['POST /tags', 'POST /tasks']);
    assert.deepStrictEqual(state.tagPosts[0].tags.map(t => t.name), ['logo-design']);
  });
});

test('overwriteRaw without the flag (objective saves) keeps the gate error', async () => {
  const state = baseState();
  describeResult = new Map([['logo-design', 'Logo work.']]);
  await withFakeApiServer(state, async (backend) => {
    const payload = { tasks: [newTask({ id: 'C1' })] };
    await assert.rejects(backend.overwriteRaw('# Tasks\n\n```json\n' + JSON.stringify(payload) + '\n```\n'), { code: 'TAGS_UNREGISTERED' });
    assert.strictEqual(describeCalls.length, 0);
    assert.ok(!state.calls.includes('POST /tasks'));
  });
});
