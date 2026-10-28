'use strict';

// (TPT9162) POST /api/tasks/:key/cowboy-next: the local-access guard's run-token check in front of
// the real createHttpHandler(), and the real chain start path behind it — startChainedTaskSession(),
// the start queue, launchNewTerminalSession() and spawnTerminal() up to a mocked pty.spawn.
// Offline: stub backend, no real agent CLI, no real API.

process.env.TASK_BACKEND = 'api';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { createLocalAccess, electronCapability, LOCAL_HOST, RUN_TOKEN_HEADER } = require('./local-access');
const { createHttpHandler, sessionQueue } = require('./ws-handlers');
const { cowboyRunTokens, COWBOY_TOKEN_ENV, COWBOY_URL_ENV } = require('./terminal-session');
const { getTaskAgent } = require('./task-agent');

const STATUSES = [
  { name: 'pending', is_workflow_start: true },
  { name: 'in_progress', is_in_progress: true },
  { name: 'completed', is_workflow_complete: true },
  { name: 'canceled', is_workflow_canceled: true },
];

function row(id, fields = {}) {
  return { id, title: `Task ${id}`, description: `Do ${id}.`, status: 'pending', category: 'CODING', priority: 5, order: 0,
    dependencies: [], assignee: 1, agentAssignee: 'claude', agentPermissionMode: null, claudeDesignMode: false,
    isObjective: false, isReservation: false, tags: [], ...fields };
}

// A live cowboy run of `taskId` whose agent already completed its task (the completion sweep set
// _completionEmitted, so it no longer holds a start slot).
function finishedRun(taskId, root, token) {
  return { type: 'terminal', alive: true, tabId: taskId, taskId, projectPath: root, cowboyChain: true, _cowboyToken: token,
    _cowboyNext: null, permissionPolicy: { mode: 'bypass' }, _completionEmitted: true };
}

function backendFor(tasks) {
  const byKey = () => new Map(tasks.map(t => [t.id, t]));
  return {
    async getTasksUnfiltered() { return tasks; },
    async getTask(id) { const t = byKey().get(id); return t ? { ...t } : null; },
    async getStatuses() { return STATUSES; },
    async getEffectiveProjectSettings() { return { settings: { agent_permission_mode: 'bypass' } }; },
    async getCurrentUserId() { return 1; },
    async getProjectSettings() { return { vcs_type: null, vcs_worktree_enabled: 0, vcs_commit_enabled: 0, vcs_pr_enabled: 0, vcs_merge_enabled: 0, kb_sync_as_you_go: false }; },
    async getTaskComments() { return []; },
    async updateTask(id, fields) { return { ...byKey().get(id), ...fields }; },
  };
}

async function serve(t, handler, accessOptions) {
  let access;
  const server = http.createServer((req, res) => access.guardHttp(req, res, handler));
  await new Promise(resolve => server.listen(0, LOCAL_HOST, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  access = createLocalAccess({ port, ...accessOptions });
  return Object.assign(function request(urlPath, { method = 'POST', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: LOCAL_HOST, port, path: urlPath, method, headers }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text, json() { return JSON.parse(text); } }));
      });
      req.on('error', reject);
      req.end();
    });
  }, { port });
}

test('only the live run\'s own token opens cowboy-next, for its own task; a repeat is a no-op', async t => {
  for (const electron of [false, true]) {
    const root = `/projects/cowboy-${electron ? 'electron' : 'browser'}`;
    const token = `run-token-${electron}`;
    const sessions = new Map([[`TPT1\0${root}`, finishedRun('TPT1', root, token)]]);
    // Nothing else can start: the decision is 'none', so no session is spawned here.
    const backend = backendFor([row('TPT1', { status: 'completed' }), row('TPT2', { status: 'in_progress' })]);
    const handler = createHttpHandler(sessions, () => backend, { getBackendForPath: () => backend });
    const secret = 'test-only-secret';
    const request = await serve(t, handler, { electron, secret, getActiveProjectPath: () => root,
      liveRunTokens: key => cowboyRunTokens(sessions, key) });
    const url = '/api/tasks/TPT1/cowboy-next';

    assert.equal((await request(url)).status, 403, 'no token');
    assert.equal((await request(url, { headers: { [RUN_TOKEN_HEADER]: 'forged' } })).status, 403, 'wrong token');
    assert.equal((await request('/api/tasks/TPT2/cowboy-next', { headers: { [RUN_TOKEN_HEADER]: token } })).status, 403, 'another task');
    assert.equal((await request(url, { method: 'GET', headers: { [RUN_TOKEN_HEADER]: token } })).status, 403, 'not a POST');
    if (electron) {
      const capability = { 'x-tipatask-capability': electronCapability(secret, root), 'x-tipatask-project': root };
      assert.equal((await request(url, { headers: capability })).status, 403, 'a window capability does not open it');
      assert.equal((await request('/api/sessions', { method: 'GET', headers: { [RUN_TOKEN_HEADER]: token } })).status, 401,
        'the token opens nothing else');
    }
    assert.equal(sessions.get(`TPT1\0${root}`)._cowboyNext, null, 'no refused request reached the launcher');

    const first = await request(url, { headers: { [RUN_TOKEN_HEADER]: token } });
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.json(), { started: [], reason: 'none' });
    const repeat = await request(url, { headers: { [RUN_TOKEN_HEADER]: token } });
    assert.equal(repeat.status, 200);
    assert.deepEqual(repeat.json(), { started: [], reason: 'already_launched', previous: { started: [], reason: 'none' } });

    sessions.get(`TPT1\0${root}`).alive = false;
    assert.equal((await request(url, { headers: { [RUN_TOKEN_HEADER]: token } })).status, 403, 'an exited run\'s token is dead');
  }
});

// (TPT9163) The agent side: start_next_tasks / `tt next` (cowboy-next-request.js) with the run's PTY
// env reach the real guard and handler, and a repeat comes back as the first decision.
test('requestNextTasks() with the run\'s env gets the decision from the real route', async t => {
  const { requestNextTasks } = require('./cowboy-next-request');
  const root = '/projects/cowboy-agent';
  const token = 'agent-run-token';
  const sessions = new Map([[`TPT1\0${root}`, finishedRun('TPT1', root, token)]]);
  const backend = backendFor([row('TPT1', { status: 'completed' }), row('TPT2', { status: 'in_progress' })]);
  const handler = createHttpHandler(sessions, () => backend, { getBackendForPath: () => backend });
  const request = await serve(t, handler, { getActiveProjectPath: () => root, liveRunTokens: key => cowboyRunTokens(sessions, key) });
  const env = { [COWBOY_TOKEN_ENV]: token, [COWBOY_URL_ENV]: `http://${LOCAL_HOST}:${request.port}/api/tasks/TPT1/cowboy-next` };

  assert.deepEqual(await requestNextTasks('TPT1', { env }), { ok: true, status: 200, started: [], reason: 'none' });
  assert.deepEqual(await requestNextTasks('TPT1', { env }),
    { ok: true, status: 200, started: [], reason: 'already_launched', previous: { started: [], reason: 'none' } });
  const forged = await requestNextTasks('TPT1', { env: { ...env, [COWBOY_TOKEN_ENV]: 'forged' } });
  assert.deepEqual([forged.ok, forged.reason, forged.status], [false, 'forbidden', 403]);
});

test('the handler refuses a request the guard did not mark as the run of that task, and reports refusals', async () => {
  const root = '/projects/cowboy-handler';
  const sessions = new Map([[`TPT1\0${root}`, finishedRun('TPT1', root, 'tok')]]);
  const backend = backendFor([row('TPT1', { status: 'in_progress' })]);
  const handler = createHttpHandler(sessions, () => backend, { getBackendForPath: () => backend });
  const call = async (url, localAccess, method = 'POST') => {
    const req = { method, url, headers: { host: '127.0.0.1:4455', 'x-tipatask-project': root }, localAccess };
    req[Symbol.asyncIterator] = async function* () {};
    const res = { status: null, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b || ''; } };
    await handler(req, res);
    return res;
  };
  const run = { kind: 'run', projectPath: root, taskKey: 'TPT1' };
  assert.equal((await call('/api/tasks/TPT1/cowboy-next', { kind: 'electron', projectPath: root })).status, 403);
  assert.equal((await call('/api/tasks/TPT1/cowboy-next', { ...run, taskKey: 'TPT2' })).status, 403);
  assert.equal((await call('/api/tasks/TPT1/cowboy-next', run, 'GET')).status, 403);
  assert.equal((await call('/api/sessions', run, 'GET')).status, 403, 'a run token never reaches another route');
  const refused = await call('/api/tasks/TPT1/cowboy-next', run);
  assert.equal(refused.status, 409);
  assert.deepEqual(JSON.parse(refused.body), { started: [], reason: 'not_finished' });
});

test('a decision starts each task through the Start path with that task\'s own agent and model', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cowboy-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  sessionQueue.setAdmission({ tryReserve: () => ({ allowed: true }), snapshot: () => undefined });
  t.after(() => sessionQueue.setAdmission(null));
  const versions = { claude: '2.1.311', codex: '0.200.0', pi: '0.1.0' };
  const specs = [];
  for (const id of ['claude', 'codex', 'pi']) {
    const agent = getTaskAgent(id);
    t.mock.method(agent, 'cachedDetect', async () => ({ id, available: id !== 'pi' }));
    t.mock.method(agent, 'getPermissionVersion', async () => versions[id]);
    t.mock.method(agent, 'getSpawnSpec', async (cfg, prompt, taskId, opts) => {
      specs.push({ agent: id, taskId, prompt, model: opts.model, cowboyChain: opts.cowboyChain });
      return { command: id, args: [], cwd: root, env: { PATH: process.env.PATH }, model: opts.model || '' };
    });
  }
  const envs = new Map();
  t.mock.method(pty, 'spawn', (command, args, options) => {
    envs.set(command, options.env);
    return { pid: 424242, write() {}, onData() {}, onExit() {}, resize() {}, kill() {} };
  });

  const tasks = [
    row('TPT1', { status: 'completed' }),
    row('TPT2', { dependencies: ['TPT1'], agentAssignee: 'codex', codexModel: 'gpt-5.5-codex', claudeModel: 'unused', order: 1 }),
    row('TPT3', { dependencies: ['TPT1'], agentAssignee: 'claude', claudeModel: 'claude-opus-5-5', codexModel: 'unused', order: 2 }),
  ];
  const backend = backendFor(tasks);
  const sessions = new Map([[`TPT1\0${root}`, finishedRun('TPT1', root, 'tok')]]);
  const handler = createHttpHandler(sessions, () => backend, { getBackendForPath: () => backend });
  const call = async () => {
    const req = { method: 'POST', url: '/api/tasks/TPT1/cowboy-next', headers: { host: '127.0.0.1:4455', 'x-tipatask-project': root },
      localAccess: { kind: 'run', projectPath: root, taskKey: 'TPT1' } };
    req[Symbol.asyncIterator] = async function* () {};
    const res = { status: null, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b || ''; } };
    await handler(req, res);
    return { status: res.status, body: JSON.parse(res.body) };
  };

  const first = await call();
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { started: ['TPT2', 'TPT3'], reason: 'dependents' });
  for (let i = 0; i < 200 && specs.length < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(specs.map(s => [s.taskId, s.agent, s.model, s.cowboyChain]).sort(),
    [['TPT2', 'codex', 'gpt-5.5-codex', true], ['TPT3', 'claude', 'claude-opus-5-5', true]]);
  assert.equal(specs.find(s => s.taskId === 'TPT3').prompt.endsWith('Work on task TPT3: Task TPT3. Do TPT3.'), true);
  for (const [key, agentId] of [['TPT2', 'codex'], ['TPT3', 'claude']]) {
    const session = sessions.get(`${key}\0${root}`);
    assert.equal(session.taskAgent, agentId);
    assert.equal(session.cowboyChain, true);
    assert.equal(session.alive, true);
    assert.equal(envs.get(agentId)[COWBOY_TOKEN_ENV], session._cowboyToken);
    assert.match(envs.get(agentId)[COWBOY_URL_ENV], new RegExp(`/api/tasks/${key}/cowboy-next$`));
  }
  assert.notEqual(sessions.get(`TPT2\0${root}`)._cowboyToken, sessions.get(`TPT3\0${root}`)._cowboyToken);

  const repeat = await call();
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.reason, 'already_launched');
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(specs.length, 2, 'the repeat started nothing');
  for (const session of sessions.values()) session.alive = false;
});
