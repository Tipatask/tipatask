'use strict';

// (TPT9163) start_next_tasks over the real stdio transport: the tipatask-local server
// (TIPATASK_MCP_LOCAL_ONLY=1) lists the tool, refuses clearly without the run token, and relays a
// cowboy-next decision from a stub Task App route. Real src/mcp/server.js child, scratch project,
// no API and no backend — the tool reads only TIPATASK_COWBOY_TOKEN/URL.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const SERVER = path.join(__dirname, 'server.js');
const COWBOY_ENV = ['TIPATASK_COWBOY_TOKEN', 'TIPATASK_COWBOY_URL'];

async function connectLocal(t, cowboyEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-start-next-'));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask/config.json'), '{}');
  const env = { ...process.env, TIPATASK_PROJECT_ROOT: root, TIPATASK_USER_DATA: root,
    TIPATASK_MCP_LOCAL_ONLY: '1', OBJECTIVE_TIMING_ENABLED: 'false' };
  for (const key of COWBOY_ENV) delete env[key];
  Object.assign(env, cowboyEnv);
  const client = new Client({ name: 'start-next-tasks-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, cwd: root, stderr: 'ignore' }));
  t.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return client;
}

test('tipatask-local lists start_next_tasks and refuses clearly without the run token', async (t) => {
  const client = await connectLocal(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(),
    ['batch_grep_tags', 'complete_task', 'git_worktree_status', 'pull_knowledge', 'push_knowledge', 'start_next_tasks']);
  const tool = tools.find(item => item.name === 'start_next_tasks');
  assert.deepEqual(tool.inputSchema.required, ['task_key']);
  assert.match(tool.description, /after complete_task succeeded/);
  assert.match(tool.description, /never start them yourself/);

  const reply = await client.callTool({ name: 'start_next_tasks', arguments: { task_key: 'TPT1' } });
  assert.equal(reply.isError, true);
  const body = JSON.parse(reply.content[0].text);
  assert.deepEqual([body.ok, body.reason, body.started], [false, 'no_token', []]);
  assert.match(body.error, /TIPATASK_COWBOY_TOKEN is not set: start_next_tasks works only inside a cowboy chain run/);
});

test('start_next_tasks sends the run token to the run\'s own route and returns the started keys', async (t) => {
  const hits = [];
  const stub = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, token: req.headers['x-tipatask-run-token'] });
    const ok = req.method === 'POST' && req.url === '/api/tasks/TPT1/cowboy-next' && req.headers['x-tipatask-run-token'] === 'tok-123';
    res.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { started: ['TPT2', 'TPT3'], reason: 'dependents' } : { error: 'Forbidden' }));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => stub.close(resolve)));
  const client = await connectLocal(t, {
    TIPATASK_COWBOY_TOKEN: 'tok-123',
    TIPATASK_COWBOY_URL: `http://127.0.0.1:${stub.address().port}/api/tasks/TPT1/cowboy-next`,
  });

  // The key is normalized like every other tool's (" tpt1" → TPT1).
  const reply = await client.callTool({ name: 'start_next_tasks', arguments: { task_key: ' tpt1' } });
  assert.notEqual(reply.isError, true, reply.content[0].text);
  assert.deepEqual(JSON.parse(reply.content[0].text), { ok: true, status: 200, started: ['TPT2', 'TPT3'], reason: 'dependents' });
  assert.deepEqual(hits, [{ method: 'POST', url: '/api/tasks/TPT1/cowboy-next', token: 'tok-123' }]);
  assert.ok(!reply.content[0].text.includes('tok-123'), 'the token never comes back to the agent');

  const other = await client.callTool({ name: 'start_next_tasks', arguments: { task_key: 'TPT2' } });
  assert.equal(other.isError, true);
  assert.equal(JSON.parse(other.content[0].text).reason, 'wrong_task');
  assert.equal(hits.length, 1, 'another task\'s key is refused before any request');
});
