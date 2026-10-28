'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-agent-assignee-'));
process.env.TIPATASK_PROJECT_ROOT = path.join(temp, 'project');
process.env.TIPATASK_USER_DATA = path.join(temp, 'data');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { writeAccountToken } = require('./account-store');

const allowed = ['human', 'claude', 'codex', 'pi'];

test('shared agent contract stays aligned with API task-service validation', t => {
  const { VALID_AGENT_ASSIGNEES, normalizeAgentAssignee } = require('../agent-assignee.mjs');
  assert.deepEqual(VALID_AGENT_ASSIGNEES, allowed);
  for (const value of ['', undefined, null, 'pi:row', 'gpt-5.6-sol', {}, 1]) {
    assert.equal(normalizeAgentAssignee(value), null);
  }
  const apiFile = path.resolve(__dirname, '../../../../../api/src/lib/task-service.js');
  if (!fs.existsSync(apiFile)) return t.diagnostic('API checkout absent; canonical contract checked locally');
  const literal = fs.readFileSync(apiFile, 'utf8').match(/const VALID_AGENT_ASSIGNEES = (\[[^;]+\]);/)[1];
  assert.deepEqual(VALID_AGENT_ASSIGNEES, JSON.parse(literal.replaceAll("'", '"')));
});

async function fixture(t) {
  const state = { writes: [], rows: [], unexpected: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const route = req.url.split('?')[0];
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (route === '/api/auth/me') return send(200, { user: { id: 7 } });
    if (route === '/api/projects/1/tags') return send(200, { tags: [] });
    if (req.method === 'GET' && route === '/api/projects/1/tasks') return send(200, { tasks: state.rows });
    const key = route.match(/^\/api\/projects\/1\/tasks\/([^/]+)$/)?.[1];
    if (req.method === 'GET' && key) return send(200, { task: state.rows.find(r => r.task_key === key) });
    if (route.startsWith('/api/projects/1/tasks') && ['POST', 'PATCH', 'PUT'].includes(req.method)) {
      state.writes.push({ method: req.method, body });
      for (const row of body.tasks || [body]) {
        if (row.agent_assignee != null && !allowed.includes(row.agent_assignee)) {
          return send(400, { error: 'Invalid agent_assignee. Must be one of: human, claude, codex, pi or null' });
        }
      }
      if (req.method === 'PATCH') {
        const row = state.rows.find(r => r.task_key === key);
        Object.assign(row, body);
        return send(200, { task: row });
      }
      if (req.method === 'POST') {
        const row = { id: state.rows.length + 1, project_id: 1, ...body, task_key: `TST${state.rows.length + 1}` };
        state.rows.push(row);
        return send(201, { task: row });
      }
      return send(200, { tasks: body.tasks });
    }
    state.unexpected.push(`${req.method} ${route}`);
    send(404, { error: 'Unexpected request' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = fs.mkdtempSync(path.join(temp, 'project-'));
  writeProjectConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_PROJECT_ID: '1' });
  writeAccountToken(baseUrl, 'test-token');
  const backend = createApiBackend(null, root);
  t.after(async () => {
    backend.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(state.unexpected, []);
  });
  return { backend, state };
}

test('create and bulk mappings send only base agents or null, preserving model pins', async t => {
  const { backend, state } = await fixture(t);
  for (const input of ['', undefined, null, 'human', 'claude', 'codex', 'pi', 'openrouter/model', 'pi:row-1', {}, 17]) {
    const expected = allowed.includes(input) ? input : null;
    const task = { title: 'Task', assignee: 7, agentAssignee: input,
      claudeModel: 'claude-sonnet-5', codexModel: 'gpt-5.6-sol', piModel: 'openrouter/image-row' };
    const created = await backend.createTask(task);
    assert.equal(state.writes.at(-1).body.agent_assignee, expected);
    assert.equal(created.agentAssignee, expected);
    assert.equal(created.piModel, task.piModel);
    assert.equal(created.claudeModel, task.claudeModel);
    assert.equal(created.codexModel, task.codexModel);
    assert.equal((await backend.getTasksUnfiltered()).some(row => row.id === created.id), true, 'saved task reaches board list');
    await backend.saveTasks([{ ...task, id: created.id }]);
    assert.equal(state.writes.at(-1).body.tasks[0].agent_assignee, expected);
  }
});

test('targeted updates normalize both casings and preserve an omitted assignment', async t => {
  const { backend, state } = await fixture(t);
  const created = await backend.createTask({ title: 'Task', agentAssignee: 'codex' });
  await backend.updateTask(created.id, { title: 'Renamed' });
  assert.equal(Object.hasOwn(state.writes.at(-1).body, 'agent_assignee'), false);
  assert.equal(state.rows[0].agent_assignee, 'codex');
  for (const casing of ['agentAssignee', 'agent_assignee']) {
    for (const value of ['', null, ...allowed, 'row-id']) {
      await backend.updateTask(created.id, { [casing]: value, piModel: 'openrouter/image-row' });
      assert.equal(state.writes.at(-1).body.agent_assignee, allowed.includes(value) ? value : null);
      assert.equal(state.rows[0].pi_model, 'openrouter/image-row');
    }
  }
});

test('manual write-task payload with an untouched picker saves and appears on board', async t => {
  const { backend, state } = await fixture(t);
  const task = { id: 'new-preview-1', title: 'Manual task', description: 'Description', category: 'CODING',
    status: 'pending', priority: 1, agentAssignee: '', tags: [], assignee: 7 };
  await backend.overwriteRawWithRemap('```json\n' + JSON.stringify({ tasks: [task] }) + '\n```');
  assert.equal(state.writes.at(-1).body.agent_assignee, null);
  const rows = await backend.getTasksUnfiltered();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, task.title);
  assert.equal(rows[0].agentAssignee, null);
});

test('HTTP assignment guard accepts the API contract and rejects row IDs', async () => {
  const { createHttpHandler } = require('./ws-handlers');
  let writes = 0;
  const backend = {
    getStatuses: async () => [],
    updateTask: async (id, fields) => { writes++; return { id, ...fields }; },
  };
  const handler = createHttpHandler(new Map(), () => backend);
  for (const value of [...allowed, null, '', 'openrouter/image-row', 'pi:row-1']) {
    const req = { method: 'PATCH', url: '/api/tasks/TST1', headers: {},
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ agent_assignee: value })); } };
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    const valid = value === null || allowed.includes(value);
    const before = writes;
    await handler(req, res);
    assert.equal(res.status, valid ? 200 : 400, res.body);
    assert.equal(writes, before + Number(valid));
    if (!valid) assert.equal(JSON.parse(res.body).error, 'Invalid agent_assignee. Must be one of: human, claude, codex, pi or null');
  }
});
