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
const { createHttpHandler, sessionQueue, startChainedTaskSession } = require('./ws-handlers');
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
function finishedRun(taskId, root, token, fields = {}) {
  return { type: 'terminal', alive: true, tabId: taskId, taskId, projectPath: root, cowboyChain: true, _cowboyToken: token,
    _cowboyNext: null, permissionPolicy: { mode: 'bypass' }, _completionEmitted: true, ...fields };
}

// updateTask() saves into the row, as the API does, so a later getTask() reads what was written.
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
    async updateTask(id, fields) { const t = byKey().get(id); return t ? { ...Object.assign(t, fields) } : null; },
  };
}

// The real start path up to pty.spawn in a scratch project whose default agent is `defaultAgent`:
// agent detection, CLI versions, getSpawnSpec() and pty.spawn mocked; returns the spec calls.
function mockStartPath(t, { defaultAgent = 'codex', available = ['claude', 'codex'], piModels } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cowboy-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'),
    JSON.stringify({ TASK_AGENT: defaultAgent, ...(piModels ? { PI_MODELS: piModels } : {}) }));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  sessionQueue.setAdmission({ tryReserve: () => ({ allowed: true }), snapshot: () => undefined });
  t.after(() => sessionQueue.setAdmission(null));
  const versions = { claude: '2.1.311', codex: '0.200.0', pi: '0.1.0' };
  const specs = [];
  for (const id of ['claude', 'codex', 'pi']) {
    const agent = getTaskAgent(id);
    t.mock.method(agent, 'cachedDetect', async () => ({ id, available: available.includes(id) }));
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
  const settle = async count => {
    for (let i = 0; i < 5000 && specs.length < count; i++) await new Promise(resolve => setImmediate(resolve));
  };
  return { root, specs, envs, settle };
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
    const skipped = [{ key: 'TPT2', reason: 'status' }];
    assert.deepEqual(first.json(), { started: [], reason: 'none', skipped });
    const repeat = await request(url, { headers: { [RUN_TOKEN_HEADER]: token } });
    assert.equal(repeat.status, 200);
    assert.deepEqual(repeat.json(), { started: [], reason: 'already_launched', skipped: [], previous: { started: [], reason: 'none', skipped } });

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

  const skipped = [{ key: 'TPT2', reason: 'status' }];
  assert.deepEqual(await requestNextTasks('TPT1', { env }), { ok: true, status: 200, started: [], reason: 'none', skipped });
  assert.deepEqual(await requestNextTasks('TPT1', { env }),
    { ok: true, status: 200, started: [], reason: 'already_launched', skipped: [], previous: { started: [], reason: 'none', skipped } });
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

// (TPT9193) The agent learns why nothing started: each dependent and each open task of the
// finished task's sprint, with the first start check it failed.
test('a none answer lists each dependent and sprint candidate with its reason', async () => {
  const root = '/projects/cowboy-skips';
  const sessions = new Map([[`TPT1\0${root}`, finishedRun('TPT1', root, 'tok')]]);
  const backend = backendFor([
    row('TPT1', { status: 'completed' }),
    row('TPT2', { dependencies: ['TPT1', 'TPT9'] }),
    row('TPT3', { dependencies: ['TPT1'], category: 'HUMAN' }),
    row('TPT4', { assignee: 2 }),
    row('TPT5', { status: 'completed' }), // closed: no candidate
    row('TPT6', { agentAssignee: 'human' }),
    row('TPT7', { priority: 6 }), // another sprint
    row('TPT9', { status: 'in_progress', priority: 4 }),
  ]);
  const handler = createHttpHandler(sessions, () => backend, { getBackendForPath: () => backend });
  const call = async () => {
    const req = { method: 'POST', url: '/api/tasks/TPT1/cowboy-next', headers: { host: '127.0.0.1:4455', 'x-tipatask-project': root },
      localAccess: { kind: 'run', projectPath: root, taskKey: 'TPT1' } };
    req[Symbol.asyncIterator] = async function* () {};
    const res = { status: null, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b || ''; } };
    await handler(req, res);
    return { status: res.status, body: JSON.parse(res.body) };
  };
  const skipped = [
    { key: 'TPT2', reason: 'deps_open' },
    { key: 'TPT3', reason: 'category' },
    { key: 'TPT4', reason: 'other_assignee' },
    { key: 'TPT6', reason: 'human' },
  ];
  assert.deepEqual(await call(), { status: 200, body: { started: [], reason: 'none', skipped } });
  assert.deepEqual(await call(), { status: 200, body: { started: [], reason: 'already_launched', skipped: [],
    previous: { started: [], reason: 'none', skipped } } });
});

// (TPT9194) A Claude run chains into Claude sessions on its own model, even for a task with no
// agent of its own in a project whose default agent is Codex; each task is saved with those settings.
test('a decision starts each task through the Start path with the finished run\'s agent and model', async t => {
  const { root, specs, envs, settle } = mockStartPath(t, { defaultAgent: 'codex' });
  const tasks = [
    row('TPT1', { status: 'completed' }),
    row('TPT2', { dependencies: ['TPT1'], agentAssignee: null, claudeModel: null, order: 1 }),
    row('TPT3', { dependencies: ['TPT1'], agentAssignee: 'codex', codexModel: 'gpt-5.5-codex', claudeModel: 'unused', order: 2 }),
  ];
  const backend = backendFor(tasks);
  const sessions = new Map([[`TPT1\0${root}`, finishedRun('TPT1', root, 'tok', { taskAgent: 'claude', taskAgentModel: 'claude-opus-5-5' })]]);
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
  assert.deepEqual(first.body, { started: ['TPT2', 'TPT3'], reason: 'dependents', skipped: [] });
  await settle(2);
  assert.deepEqual(specs.map(s => [s.taskId, s.agent, s.model, s.cowboyChain]).sort(),
    [['TPT2', 'claude', 'claude-opus-5-5', true], ['TPT3', 'claude', 'claude-opus-5-5', true]]);
  assert.equal(specs.find(s => s.taskId === 'TPT3').prompt.endsWith('Work on task TPT3: Task TPT3. Do TPT3.'), true);
  for (const key of ['TPT2', 'TPT3']) {
    const session = sessions.get(`${key}\0${root}`);
    assert.equal(session.taskAgent, 'claude');
    assert.equal(session.cowboyChain, true);
    assert.equal(session.alive, true);
    assert.equal(session.permissionPolicy.mode, 'bypass');
    const saved = await backend.getTask(key);
    assert.deepEqual([saved.agentAssignee, saved.claudeModel, saved.agentPermissionMode, saved.cowboyMode],
      ['claude', 'claude-opus-5-5', 'bypass', true], `get_task ${key} after the chain step`);
  }
  assert.equal((await backend.getTask('TPT3')).codexModel, 'gpt-5.5-codex', 'another agent\'s model stays');
  assert.match(envs.get('claude')[COWBOY_URL_ENV], /\/api\/tasks\/TPT[23]\/cowboy-next$/);
  assert.notEqual(sessions.get(`TPT2\0${root}`)._cowboyToken, sessions.get(`TPT3\0${root}`)._cowboyToken);
  assert.ok([sessions.get(`TPT2\0${root}`)._cowboyToken, sessions.get(`TPT3\0${root}`)._cowboyToken].includes(envs.get('claude')[COWBOY_TOKEN_ENV]));

  const repeat = await call();
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.reason, 'already_launched');
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(specs.length, 2, 'the repeat started nothing');
  for (const session of sessions.values()) session.alive = false;
});

// (TPT9194) startChainedTaskSession() itself: the inherited model goes ahead of the row's, only with
// the agent it came from; an unavailable inherited agent falls back to the project default with that
// agent's own model from the row; a Pi model must be a usable row of the project's PI_MODELS.
test('a chained start prefers the inherited agent and model, and falls back to the project default', async t => {
  const piModels = [{ model: 'deepseek/deepseek-v4', apiKey: 'k1' }, { model: 'moonshot/kimi-k3', apiKey: 'k2' }];
  const { root, specs, settle } = mockStartPath(t, { defaultAgent: 'codex', available: ['claude', 'codex', 'pi'], piModels });
  const tasks = [
    row('TPT2', { claudeModel: 'row-claude', agentPermissionMode: 'bypass' }),
    row('TPT3', { agentAssignee: 'pi', piModel: 'moonshot/kimi-k3', agentPermissionMode: 'bypass' }),
    row('TPT4', { agentAssignee: 'pi', piModel: 'moonshot/kimi-k3', agentPermissionMode: 'bypass' }),
  ];
  const backend = backendFor(tasks);
  const sessions = new Map();
  // The start queue reads the sessions Map the HTTP handler was created with: register this one.
  createHttpHandler(sessions, () => backend, { getBackendForPath: () => backend });
  const start = (task, agent, model) => startChainedTaskSession(
    { task, agent, model, prompt: `Work on task ${task.id}`, cowboyChain: true, env: { [COWBOY_TOKEN_ENV]: `tok-${task.id}` } },
    { sessions, backend, projectPath: root });

  assert.equal(await start(tasks[0], 'claude', 'claude-opus-5-5'), true);
  assert.equal(await start(tasks[1], 'pi', 'deepseek/deepseek-v4'), true);
  assert.equal(await start(tasks[2], 'pi', 'unknown/model'), true);
  await settle(3);
  assert.deepEqual(specs.map(s => [s.taskId, s.agent, s.model]).sort(), [
    ['TPT2', 'claude', 'claude-opus-5-5'],
    ['TPT3', 'pi', 'deepseek/deepseek-v4'],
    ['TPT4', 'pi', 'moonshot/kimi-k3'],
  ]);
  for (const session of sessions.values()) session.alive = false;
});

test('an unavailable inherited agent starts the project default with that agent\'s model from the row', async t => {
  const { root, specs, settle } = mockStartPath(t, { defaultAgent: 'codex', available: ['claude', 'codex'] });
  const task = row('TPT2', { agentAssignee: 'pi', piModel: 'deepseek/deepseek-v4', codexModel: 'gpt-5.5-codex', agentPermissionMode: 'bypass' });
  const backend = backendFor([task]);
  const sessions = new Map();
  createHttpHandler(sessions, () => backend, { getBackendForPath: () => backend }); // the start queue's Map
  assert.equal(await startChainedTaskSession(
    { task, agent: 'pi', model: 'deepseek/deepseek-v4', prompt: 'Work on task TPT2', cowboyChain: true, env: { [COWBOY_TOKEN_ENV]: 'tok' } },
    { sessions, backend, projectPath: root }), true);
  await settle(1);
  assert.deepEqual(specs.map(s => [s.taskId, s.agent, s.model]), [['TPT2', 'codex', 'gpt-5.5-codex']]);
  assert.equal((await backend.getTask('TPT2')).agentAssignee, 'codex', 'the start records the agent that ran');
  for (const session of sessions.values()) session.alive = false;
});
