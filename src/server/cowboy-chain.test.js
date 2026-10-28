'use strict';

// (TPT9162) launchCowboyChain(): the run gates, one decision per run, one chain per project at a
// time, and the per-task launches it hands startTask(); spawnTerminal()'s cowboy run state and
// PTY env. See ai/architecture/tt-claude-session-terminal.md § Cowboy chains.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const config = require('./config');
const { launchCowboyChain, cowboyRunTokens, withCowboyEnv, spawnTerminal, COWBOY_TOKEN_ENV, COWBOY_URL_ENV } = require('./terminal-session');
const { createSession } = require('./session-state');
const { getTaskAgent } = require('./task-agent');

const ROOT = '/projects/cowboy';
const STATUSES = [
  { name: 'pending', is_workflow_start: true },
  { name: 'in_progress', is_in_progress: true },
  { name: 'completed', is_workflow_complete: true },
  { name: 'canceled', is_workflow_canceled: true },
];

function row(id, fields = {}) {
  return { id, title: `Task ${id}`, description: `Do ${id}.`, status: 'pending', category: 'CODING', priority: 5, order: 0,
    dependencies: [], assignee: 1, agentAssignee: 'claude', agentPermissionMode: null, ...fields };
}

function cowboyRun(taskId, fields = {}) {
  return { type: 'terminal', alive: true, tabId: taskId, taskId, projectPath: ROOT, cowboyChain: true,
    _cowboyToken: `token-${taskId}`, _cowboyNext: null, permissionPolicy: { mode: 'bypass' }, ...fields };
}

function backendFor(tasks, { projectMode = 'bypass', reads } = {}) {
  const byKey = () => new Map(tasks.map(t => [t.id, t]));
  return {
    async getTasksUnfiltered() { if (reads) reads.list++; return tasks; },
    async getTask(id) { return byKey().get(id) || null; },
    async getStatuses() { return STATUSES; },
    async getEffectiveProjectSettings() { return { settings: { agent_permission_mode: projectMode } }; },
    async getCurrentUserId() { return 1; },
  };
}

function harness(tasks, { runs = [cowboyRun('T1')], projectMode, startTask } = {}) {
  const sessions = new Map(runs.map(s => [`${s.taskId}\0${ROOT}`, s]));
  const launches = [];
  const broadcasts = [];
  const deps = {
    sessions,
    backend: backendFor(tasks, { projectMode }),
    websocket: { emitCowboyChainStarted: (projectPath, payload) => broadcasts.push({ projectPath, ...payload }) },
    startTask: startTask || (async launch => {
      launches.push(launch);
      sessions.set(`${launch.task.id}\0${ROOT}`, { type: 'terminal', taskId: launch.task.id, tabId: launch.task.id, projectPath: ROOT, _queued: true });
      return true;
    }),
  };
  return { sessions, launches, broadcasts, deps, run: key => launchCowboyChain(ROOT, key, deps) };
}

test('a finished cowboy run starts every qualifying dependent with its own agent, kickoff and token', async () => {
  const tasks = [
    row('T1', { status: 'completed', agentPermissionMode: 'bypass' }),
    row('T2', { dependencies: ['T1'], agentAssignee: 'codex', codexModel: 'gpt-x', order: 2 }),
    row('T3', { dependencies: ['T1'], agentAssignee: 'claude', claudeModel: 'opus-y', order: 1 }),
    row('T4', { dependencies: ['T1'], agentAssignee: null }),
    row('T5', { dependencies: ['T1'], status: 'in_progress' }),
  ];
  const h = harness(tasks);
  const result = await h.run('T1');
  assert.deepEqual(result, { started: ['T4', 'T3', 'T2'], reason: 'dependents' });
  assert.deepEqual(h.launches.map(l => [l.task.id, l.agent, l.cowboyChain]), [['T4', null, true], ['T3', 'claude', true], ['T2', 'codex', true]]);
  assert.equal(h.launches[1].prompt, 'Work on task T3: Task T3. Do T3.');
  const tokens = h.launches.map(l => l.env[COWBOY_TOKEN_ENV]);
  assert.equal(new Set(tokens).size, 3, 'every chained run gets its own token');
  for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(h.broadcasts, [{ projectPath: ROOT, taskId: 'T1', started: ['T4', 'T3', 'T2'] }]);
});

test('a repeat is a no-op that names the earlier decision, also while the first call is in flight', async () => {
  const tasks = [row('T1', { status: 'completed', agentPermissionMode: 'bypass' }), row('T2', { dependencies: ['T1'], agentPermissionMode: 'bypass' })];
  const h = harness(tasks);
  const [first, concurrent] = await Promise.all([h.run('T1'), h.run('T1')]);
  assert.deepEqual(first, { started: ['T2'], reason: 'dependents' });
  assert.deepEqual(concurrent, { started: [], reason: 'already_launched' });
  assert.deepEqual(await h.run('T1'), { started: [], reason: 'already_launched', previous: { started: ['T2'], reason: 'dependents' } });
  assert.equal(h.launches.length, 1);
  // A decision that started nothing is final too.
  const none = harness([row('T1', { status: 'completed', agentPermissionMode: 'bypass' })]);
  assert.deepEqual(await none.run('T1'), { started: [], reason: 'none' });
  assert.equal((await none.run('T1')).reason, 'already_launched');
});

test('the run gates: a live cowboy run, still in bypass, whose task is complete with a stored bypass mode', async () => {
  const finished = row('T1', { status: 'completed', agentPermissionMode: null });
  const tasks = [finished, row('T2', { dependencies: ['T1'], agentPermissionMode: 'bypass' })];
  assert.deepEqual(await harness(tasks, { runs: [] }).run('T1'), { started: [], reason: 'no_session' });
  assert.deepEqual(await harness(tasks, { runs: [cowboyRun('T1', { alive: false })] }).run('T1'), { started: [], reason: 'no_session' });
  assert.deepEqual(await harness(tasks, { runs: [cowboyRun('T1', { projectPath: '/projects/other' })] }).run('T1'), { started: [], reason: 'no_session' });
  assert.deepEqual(await harness(tasks, { runs: [cowboyRun('T1', { cowboyChain: false })] }).run('T1'), { started: [], reason: 'not_cowboy' });
  assert.deepEqual(await harness(tasks, { runs: [cowboyRun('T1', { permissionPolicy: { mode: 'auto' } })] }).run('T1'), { started: [], reason: 'not_bypass' },
    'a run switched live out of bypass stops the chain');
  assert.deepEqual(await harness(tasks, { projectMode: 'auto' }).run('T1'), { started: [], reason: 'not_bypass' },
    'the finished task inherits a project default that is no longer bypass');
  const unfinished = harness([{ ...finished, status: 'in_progress' }, tasks[1]], { projectMode: 'bypass' });
  assert.deepEqual(await unfinished.run('T1'), { started: [], reason: 'not_finished' });
  const canceled = harness([{ ...finished, status: 'canceled' }, tasks[1]], { projectMode: 'bypass' });
  assert.deepEqual(await canceled.run('T1'), { started: [], reason: 'not_finished' });
  // A refusal is not a decision: once the task completes, the same run may ask again.
  unfinished.deps.backend = backendFor(tasks, { projectMode: 'bypass' });
  assert.deepEqual(await unfinished.run('T1'), { started: ['T2'], reason: 'dependents' });
  assert.equal(unfinished.launches.length, 1);
});

test('a failed task read throws and leaves the run free to ask again', async () => {
  const tasks = [row('T1', { status: 'completed', agentPermissionMode: 'bypass' }), row('T2', { dependencies: ['T1'], agentPermissionMode: 'bypass' })];
  const h = harness(tasks);
  const good = h.deps.backend.getTasksUnfiltered;
  h.deps.backend.getTasksUnfiltered = async () => { throw new Error('API down'); };
  await assert.rejects(h.run('T1'), /API down/);
  h.deps.backend.getTasksUnfiltered = good;
  assert.deepEqual(await h.run('T1'), { started: ['T2'], reason: 'dependents' });
});

test('tasks with a live, starting or queued session are skipped; a refused start is reported', async () => {
  const tasks = [
    row('T1', { status: 'completed', agentPermissionMode: 'bypass' }),
    row('T2', { dependencies: ['T1'], agentPermissionMode: 'bypass' }),
    row('T3', { dependencies: ['T1'], agentPermissionMode: 'bypass' }),
  ];
  const queued = { type: 'terminal', taskId: 'T2', tabId: 'T2', projectPath: ROOT, _queued: true };
  const h = harness(tasks, { runs: [cowboyRun('T1'), queued] });
  assert.deepEqual(await h.run('T1'), { started: ['T3'], reason: 'dependents' });
  const refusing = harness(tasks, { startTask: async () => false });
  assert.deepEqual(await refusing.run('T1'), { started: [], reason: 'start_failed' });
  assert.deepEqual(refusing.broadcasts, []);
});

test('two runs finishing together start a shared dependent once', async () => {
  const tasks = [
    row('T1', { status: 'completed', agentPermissionMode: 'bypass' }),
    row('T2', { status: 'completed', agentPermissionMode: 'bypass' }),
    row('T3', { dependencies: ['T1', 'T2'], agentPermissionMode: 'bypass' }),
  ];
  const h = harness(tasks, { runs: [cowboyRun('T1'), cowboyRun('T2')] });
  const [a, b] = await Promise.all([h.run('T1'), h.run('T2')]);
  assert.deepEqual([...a.started, ...b.started], ['T3']);
  assert.equal(h.launches.length, 1);
});

test('the run token is listed only for a live cowboy run of that task', () => {
  const sessions = new Map([
    ['a', cowboyRun('T1')],
    ['b', cowboyRun('T2', { alive: false })],
    ['c', cowboyRun('T3', { cowboyChain: false })],
    ['d', { type: 'taskChat', taskId: 'T1', alive: true, cowboyChain: true, _cowboyToken: 'chat' }],
  ]);
  assert.deepEqual(cowboyRunTokens(sessions, 'T1'), [{ token: 'token-T1', projectPath: ROOT }]);
  assert.deepEqual(cowboyRunTokens(sessions, 'T2'), []);
  assert.deepEqual(cowboyRunTokens(sessions, 'T3'), []);
});

test('the PTY env carries the run\'s own token and route URL, and never an inherited one', () => {
  const inherited = { PATH: '/bin', [COWBOY_TOKEN_ENV]: 'parent', [COWBOY_URL_ENV]: 'http://parent' };
  assert.deepEqual(withCowboyEnv(inherited, { cowboyChain: false, _cowboyToken: null }, 'T1'), { PATH: '/bin' });
  const env = withCowboyEnv(inherited, { cowboyChain: true, _cowboyToken: 'mine' }, 'T 1');
  assert.equal(env[COWBOY_TOKEN_ENV], 'mine');
  assert.equal(env[COWBOY_URL_ENV], `http://127.0.0.1:${config.PORT}/api/tasks/T%201/cowboy-next`);
  assert.equal(inherited[COWBOY_TOKEN_ENV], 'parent', 'the spec env is copied, not changed');
});

// The real spawnTerminal() up to pty.spawn, as vcs-spawn.test.js drives it: what makes a run a
// cowboy run, and what reaches the agent's spec and env.
test('spawnTerminal: bypass with the task flag or a chain launch makes a cowboy run; a chain launch outside bypass is refused', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cowboy-spawn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const agent = getTaskAgent('claude');
  t.mock.method(agent, 'cachedDetect', async () => ({ id: 'claude', available: true }));
  t.mock.method(agent, 'getPermissionVersion', async () => '2.1.311');
  const specs = [];
  t.mock.method(agent, 'getSpawnSpec', async (cfg, prompt, taskId, opts) => {
    specs.push(opts);
    return { command: 'claude', args: [], cwd: root, env: { PATH: process.env.PATH, [COWBOY_TOKEN_ENV]: 'inherited' }, model: opts.model || '' };
  });
  const envs = [];
  t.mock.method(pty, 'spawn', (command, args, options) => {
    envs.push(options.env);
    return { pid: 424242, write() {}, onData() {}, onExit() {}, resize() {}, kill() {} };
  });
  const backend = {
    async getEffectiveProjectSettings() { return { settings: { agent_permission_mode: 'auto' } }; },
    async getProjectSettings() { return { vcs_type: null, vcs_worktree_enabled: 0, vcs_commit_enabled: 0, vcs_pr_enabled: 0, vcs_merge_enabled: 0, kb_sync_as_you_go: false }; },
    async getStatuses() { return STATUSES; },
    async getTaskComments() { return []; },
  };
  const spawn = async (task, opts = {}) => {
    const session = createSession(null, false, task.id, root);
    session.projectPath = root;
    session.taskAgent = 'claude';
    await spawnTerminal(session, `Work on task ${task.id}`, task.id, [], { backend, task, ...opts });
    session.alive = false;
    return session;
  };

  const own = await spawn(row('T1', { agentPermissionMode: 'bypass', cowboyMode: true }));
  assert.equal(own.cowboyChain, true);
  assert.match(own._cowboyToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(envs.at(-1)[COWBOY_TOKEN_ENV], own._cowboyToken);
  assert.equal(envs.at(-1)[COWBOY_URL_ENV], `http://127.0.0.1:${config.PORT}/api/tasks/T1/cowboy-next`);
  assert.equal(specs.at(-1).cowboyChain, true);

  const stale = await spawn(row('T2', { agentPermissionMode: null, cowboyMode: true })); // inherits auto
  assert.equal(stale.cowboyChain, false, 'a stored flag outside bypass is ignored');
  assert.equal(stale._cowboyToken, null);
  assert.equal(envs.at(-1)[COWBOY_TOKEN_ENV], undefined);
  assert.equal(specs.at(-1).cowboyChain, false);

  const chained = await spawn(row('T3', { agentPermissionMode: 'bypass', cowboyMode: false }),
    { cowboyChain: true, env: { [COWBOY_TOKEN_ENV]: 'chain-token' } });
  assert.equal(chained.cowboyChain, true);
  assert.equal(chained._cowboyToken, 'chain-token');
  assert.equal(envs.at(-1)[COWBOY_TOKEN_ENV], 'chain-token');

  const spawned = envs.length;
  await assert.rejects(spawn(row('T4', { agentPermissionMode: null }), { cowboyChain: true, env: { [COWBOY_TOKEN_ENV]: 'x' } }),
    /Cowboy chain launches run only in Bypass mode/);
  assert.equal(envs.length, spawned, 'nothing was spawned');
});
