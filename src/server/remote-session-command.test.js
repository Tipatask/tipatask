'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = require('node:timers');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-remote-tests-'));
process.env.TIPATASK_PROJECT_ROOT = testRoot;
process.env.TIPATASK_USER_DATA = testRoot;
test.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
const { EventEmitter } = require('node:events');
const pty = require('node-pty');
test.mock.method(require('../cli/knowledge-sync'), 'fireSessionSync', async () => ({ pulledKeys: [] }));
const { handleRemoteSessionCommand, handleConnection, sessionQueue, createHttpHandler, sessionMetaRow } = require('./ws-handlers');
const { getTaskAgent } = require('./task-agent');
const { terminalEvents, runId } = require('./device-relay');
const websocket = require('./websocket');

function harness(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-remote-command-'));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask/config.json'), JSON.stringify({ TASK_AGENT: 'codex' }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sessions = new Map();
  const spawns = [];
  const task = { id: 'TPT1', title: 'Remote task', description: 'Do the work', category: 'CODING',
    assignee: 1, agentAssignee: 'codex', tags: [], status: 'pending', ...overrides.task };
  let allowed = true;
  const tokenFor = (id, nonce = '') => `e30.${Buffer.from(JSON.stringify({ id, nonce, exp: Math.floor(Date.now() / 1000) + 604800 })).toString('base64url')}.test`;
  let credentials = { baseUrl: 'https://example.test', projectId: 2, token: tokenFor(1) };
  const claims = [], identityReads = [];
  const backend = {
    getCredentials() { return credentials; },
    async getTask() { return { ...task }; }, async getCurrentUserId(opts) { identityReads.push(opts); return 1; },
    async claimTaskForStart() {
      claims.push(true);
      if (task.assignee != null && task.assignee !== 1) throw { body: { code: 'task_assigned_to_other_member' } };
      task.assignee = 1;
      return { ...task };
    },
    async getTaskComments() { return []; }, async addTokenUsage() {},
    async getStatuses() { return [{ name: 'pending', is_workflow_start: true }, { name: 'completed', is_workflow_complete: true }]; },
    async getEffectiveProjectSettings() { return { settings: { agent_permission_mode: 'bypass', kb_sync_as_you_go: false } }; },
    async getProjectSettings() { return { vcs_type: null, vcs_worktree_enabled: 0, vcs_commit_enabled: 0, vcs_pr_enabled: 0, vcs_merge_enabled: 0, kb_sync_as_you_go: false }; },
    ...overrides.backend,
  };
  // Bind the real device queue to this isolated registry, as server/index.js does.
  createHttpHandler(sessions, () => backend);
  sessionQueue.setAdmission({ tryReserve: () => ({ allowed: true }), snapshot: () => undefined });
  t.after(() => {
    for (const key of sessions.keys()) sessionQueue.remove(key);
    sessionQueue.setAdmission(null);
  });
  const agent = getTaskAgent('codex');
  t.mock.method(agent, 'cachedDetect', async () => ({ id: 'codex', available: true }));
  t.mock.method(agent, 'getPermissionVersion', async () => '0.200.0');
  t.mock.method(agent, 'detectComputerUse', async () => null);
  t.mock.method(agent, 'getSpawnSpec', async (_cfg, prompt, taskId, opts) => {
    overrides.beforeSpec?.();
    spawns.push({ prompt, taskId, opts });
    return { command: 'codex', args: [], cwd: root, env: { PATH: process.env.PATH, ...overrides.spawnEnv?.() } };
  });
  const writes = [], resizes = [], processes = [];
  let onData, onExit;
  t.mock.method(pty, 'spawn', () => {
    processes.push(true);
    return { pid: 99999999, write: data => writes.push(data), resize: (...size) => resizes.push(size),
      onData(callback) { onData = callback; }, onExit(callback) { onExit = callback; }, kill() {} };
  });
  const reports = [];
  const project = { projectPath: root, backend, ...credentials };
  const ctx = { project, isCurrent: () => allowed, report: session => reports.push(runId(session)),
    authorizeStart: async () => () => { assert.equal(allowed, true); } };
  const options = { sessions, availableAgents: async () => ['codex'] };
  const start = (command = {}) => handleRemoteSessionCommand({ action: 'start', command_id: 'start-0001',
    project_id: 2, task_key: 'TPT1', agent: 'codex', ...command }, ctx, options);
  return { root, sessions, task, backend, spawns, processes, claims, identityReads, reports, writes, resizes, options, ctx, start,
    changeAccount(id, nonce) { credentials = { ...credentials, token: tokenFor(id, nonce) }; },
    revoke() { allowed = false; }, output(data) { onData(data); }, exit(code = 0) { onExit({ exitCode: code }); } };
}

test('foreign assignment cannot reach PTY spawn when current identity is unknown', async t => {
  const h = harness(t, { task: { assignee: 2 }, backend: { async getCurrentUserId() { return null; } } });
  const result = await h.start();
  assert.equal(result.ok, false, `start result ${JSON.stringify(result)}, PTY spawns ${h.processes.length}`);
  assert.equal(h.processes.length, 0);
});

for (const [name, lookup] of [
  ['null', async () => null],
  ['rejected', async () => { throw new Error('offline'); }],
  ['timed out', async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }],
  ['another account', async () => 2],
  ['nonpositive', async () => 0],
]) test(`remote foreign task refuses ${name} identity without claiming or spawning`, async t => {
  const h = harness(t, { task: { assignee: 2 }, backend: { getCurrentUserId: lookup } });
  assert.equal((await h.start({ user_id: 2, assignee: 2 })).code, 'authentication_required');
  assert.equal(h.processes.length, 0);
  assert.equal(h.claims.length, 0);
  assert.equal(h.sessions.size, 0);
});

test('remote checks request fresh identity and do not use a stale cached account', async t => {
  const h = harness(t, { task: { assignee: 2 }, backend: {
    async getCurrentUserId(opts) { return opts?.strict ? 1 : 2; },
  } });
  assert.equal((await h.start()).code, 'task_assigned_to_other_member');
  assert.equal(h.processes.length, 0);
});

test('unassigned task is claimed once at the final gate; unavailable identity can recover', async t => {
  const h = harness(t, { task: { assignee: null } });
  const resolve = h.backend.getCurrentUserId;
  h.backend.getCurrentUserId = async () => null;
  assert.equal((await h.start()).code, 'authentication_required');
  assert.equal(h.claims.length, 0);
  h.backend.getCurrentUserId = resolve;
  assert.equal((await h.start({ command_id: 'recovered-001' })).ok, true);
  assert.equal(h.task.assignee, 1);
  assert.equal(h.claims.length, 1);
  assert.equal(h.processes.length, 1);
  assert.deepEqual(h.identityReads, [{ strict: true }, { strict: true }]);
});

for (const assignee of [1, null]) test(`assignment changes during preparation refuse spawn (initial ${assignee})`, async t => {
  const h = harness(t, { task: { assignee }, beforeSpec: () => { h.task.assignee = 2; } });
  assert.equal((await h.start()).code, 'task_assigned_to_other_member');
  assert.equal(h.claims.length, 0);
  assert.equal(h.processes.length, 0);
  assert.equal(h.task.assignee, 2);
});

test('another account during preparation refuses even a matching /me and task assignee', async t => {
  const h = harness(t, { beforeSpec: () => {
    h.changeAccount(2);
    h.backend.getCurrentUserId = async () => 2;
    h.task.assignee = 2;
  } });
  assert.equal((await h.start()).code, 'authentication_required');
  assert.equal(h.claims.length, 0);
  assert.equal(h.processes.length, 0);
});

test('safe same-account renewal during preparation still starts once', async t => {
  const h = harness(t, { beforeSpec: () => h.changeAccount(1, 'renewed') });
  assert.equal((await h.start()).ok, true);
  assert.equal(h.processes.length, 1);
});

test('a spec prepared under another account is refused even after switching back', async t => {
  let preparedToken;
  const h = harness(t, { beforeSpec: () => {
    h.changeAccount(2);
    preparedToken = h.backend.getCredentials().token;
    h.changeAccount(1);
  }, spawnEnv: () => ({ API_TOKEN: preparedToken }) });
  assert.equal((await h.start()).code, 'authentication_required');
  assert.equal(h.processes.length, 0);
  assert.equal(h.claims.length, 0);
});

test('identity loss after initial admission refuses at the PTY boundary', async t => {
  const h = harness(t, { beforeSpec: () => { h.backend.getCurrentUserId = async () => null; } });
  assert.equal((await h.start()).code, 'authentication_required');
  assert.equal(h.processes.length, 0);
  assert.equal(h.claims.length, 0);
});

test('competing assignment at claim refuses without an unconditional PATCH', async t => {
  const h = harness(t, { task: { assignee: null } });
  h.backend.updateTask = async () => assert.fail('remote admission must never call updateTask');
  h.backend.claimTaskForStart = async () => {
    h.task.assignee = 2;
    throw { body: { code: 'task_assigned_to_other_member' } };
  };
  assert.equal((await h.start()).code, 'task_assigned_to_other_member');
  assert.equal(h.task.assignee, 2);
  assert.equal(h.processes.length, 0);
});

test('account change while claim is pending refuses its response', async t => {
  const h = harness(t, { task: { assignee: null } });
  h.backend.claimTaskForStart = async () => { h.changeAccount(2); return { ...h.task, assignee: 1 }; };
  assert.equal((await h.start()).code, 'authentication_required');
  assert.equal(h.processes.length, 0);
});

test('offline or missing atomic claim never launches and leaves task unassigned', async t => {
  const h = harness(t, { task: { assignee: null } });
  h.backend.claimTaskForStart = undefined;
  assert.equal((await h.start()).code, 'task_claim_failed');
  assert.equal(h.task.assignee, null);
  assert.equal(h.processes.length, 0);
});

test('loopback HTTP/WS remote launch refuses identity failures and preserves receipts across recovery', { timeout: 10000 }, async t => {
  const h = harness(t);
  const http = require('node:http');
  const { WebSocketServer } = require('ws');
  const { createApiBackend } = require('./api-backend');
  const { writeProjectConfig } = require('./project-config');
  const { writeAccountToken, clearAccountToken } = require('./account-store');
  const { connectDeviceRelay } = require('./device-relay');
  const rawTask = { task_key: 'TPT1', title: 'Remote task', description: 'Do the work', category: 'CODING',
    assignee: 2, agent_assignee: 'codex', tags: [], status: 'pending' };
  let meStatus = 503, meId = 1, claimCount = 0;
  const server = http.createServer((req, res) => {
    let status = 200, body;
    if (req.url === '/api/auth/me') { status = meStatus; body = { user: { id: meId } }; }
    else if (req.method === 'GET' && req.url === '/api/projects/2/tasks/TPT1') body = { task: rawTask };
    else if (req.method === 'POST' && req.url === '/api/projects/2/tasks/TPT1/start-claim') {
      claimCount++;
      if (rawTask.assignee != null && rawTask.assignee !== 1) { status = 409; body = { code: 'task_assigned_to_other_member' }; }
      else { rawTask.assignee = 1; body = { task: rawTask }; }
    } else { status = 404; body = {}; }
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  const wss = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  writeProjectConfig(h.root, { API_BASE_URL: baseUrl, API_PROJECT_ID: '2' });
  writeAccountToken(baseUrl, h.backend.getCredentials().token);
  const actual = createApiBackend(null, h.root);
  for (const name of ['getCredentials', 'getCurrentUserId', 'getTask', 'claimTaskForStart']) h.backend[name] = actual[name].bind(actual);
  let peer, manager;
  t.after(async () => {
    manager?.close(); actual.dispose();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    clearAccountToken(baseUrl);
  });
  const hello = new Promise(resolve => wss.once('connection', (socket, req) => {
    peer = socket;
    assert.equal(req.headers.authorization, `Bearer ${actual.getCredentials().token}`);
    socket.on('message', data => {
      const frame = JSON.parse(data);
      if (frame.type === 'hello') resolve();
      if (frame.type === 'authorize_start') socket.send(JSON.stringify({ type: 'start_authorization', command_id: frame.command_id, allowed: true }));
    });
    socket.send(JSON.stringify({ type: 'ready', protocol: 1, project_ids: [2], expiry_ms: 180000, start_authorization: true,
      limits: { frames_per_second: 200, output_bytes_per_second: 1048576, max_output_data_bytes: 32768,
        max_device_frame_bytes: 262144, max_replay_bytes: 262144, max_sessions: 64 } }));
  }));
  manager = connectDeviceRelay({ getProjects: () => [{ enabled: true, deviceId: 7, projectPath: h.root, backend: h.backend }],
    getSessions: () => h.sessions, setTimer: realSetTimeout, clearTimer: realClearTimeout,
    handleCommand: (command, context) => handleRemoteSessionCommand(command, context, h.options) });
  await hello;
  const send = (id, action = 'start', extra = {}) => new Promise(resolve => {
    const listener = data => {
      const frame = JSON.parse(data);
      if (frame.type === 'command_result' && frame.command_id === id) { peer.off('message', listener); resolve(frame); }
    };
    peer.on('message', listener);
    peer.send(JSON.stringify({ type: 'command', action, command_id: id, project_id: 2, task_key: 'TPT1',
      agent: 'codex', user_id: 2, assignee: 2, ...extra }));
  });
  assert.equal((await send('failure-001')).code, 'authentication_required');
  meStatus = 200; meId = 2;
  assert.equal((await send('mismatch-001')).code, 'authentication_required');
  meId = 1;
  assert.equal((await send('foreign-001')).code, 'task_assigned_to_other_member');
  assert.equal(h.processes.length, 0); assert.equal(claimCount, 0);
  rawTask.assignee = null;
  assert.equal((await send('failure-001')).code, 'authentication_required', 'old receipt cannot silently turn into a start');
  const started = await send('recovered-001');
  assert.equal(started.ok, true);
  assert.equal((await send('recovered-001')).local_id, started.local_id);
  assert.equal((await send('duplicate-001')).code, 'already_running');
  assert.equal(h.processes.length, 1); assert.equal(claimCount, 1);
  assert.equal((await send('stop-test-001', 'stop', { local_id: started.local_id })).ok, true);
});

test('remote start uses real spawn gates and deduplicates simultaneous starts by task', async t => {
  const h = harness(t);
  const first = h.start();
  const duplicate = await h.start({ command_id: 'start-0002' });
  assert.equal(duplicate.code, 'already_running');
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(h.spawns.length, 1);
  assert.match(h.spawns[0].prompt, /Work on task TPT1: Remote task\. Do the work/);
  assert.equal(h.spawns[0].opts.vcsContext.verified, true);
  assert.equal(h.spawns[0].opts.permissionPolicy.mode, 'bypass');
  assert.equal(result.local_id, h.reports[0], 'queued/starting and running use the same run identity');
  assert.equal((await h.start({ command_id: 'start-0003' })).code, 'already_running');
});

for (const mode of ['plan', 'auto', 'bypass']) test(`remote input and explicit human approvals preserve ${mode} mode`, async t => {
  const h = harness(t, { task: { agentPermissionMode: mode } });
  await h.start();
  const session = [...h.sessions.values()][0];
  const context = { session, isCurrent: () => true };
  assert.equal(h.spawns[0].opts.permissionPolicy.mode, mode);
  await handleRemoteSessionCommand({ action: 'input', data: 'y\r' }, context, h.options);
  assert.ok(h.writes.includes('y\r'), 'native CLI permission responses reach the PTY');
  let request = { id: 'tool-one', tool: 'bash', input: 'npm test' };
  const answers = [];
  session._permissionGate = { snapshot: () => request, answer(id, allow) { answers.push([id, allow]); request = null; return true; } };
  const answer = { action: 'approve', request_id: request.id, allow: true };
  assert.equal((await handleRemoteSessionCommand(answer, context, h.options)).ok, true);
  assert.equal((await handleRemoteSessionCommand(answer, context, h.options)).code, 'approval_stale');
  request = { id: 'tool-two', tool: 'bash', input: 'next command' };
  assert.equal((await handleRemoteSessionCommand({ ...answer, request_id: request.id, allow: false }, context, h.options)).ok, true);
  assert.deepEqual(answers, [['tool-one', true], ['tool-two', false]]);
  assert.equal(session.permissionPolicy.mode, mode, 'an action approval never switches the agent policy');
  session._permissionGate = null;
  if (mode === 'plan') {
    session._planReadySent = true;
    const { remoteApprovalRequest } = require('./device-relay');
    const plan = remoteApprovalRequest(session);
    const agent = getTaskAgent('codex');
    let approved = 0;
    t.mock.method(agent, 'approvePlan', () => { approved++; });
    const ptyBefore = session.pty;
    assert.equal((await handleRemoteSessionCommand({ action: 'approve', request_id: plan.id, allow: true }, context, h.options)).ok, true);
    assert.equal(approved, 1);
    assert.equal(session.terminalPhase, 'executing');
    assert.equal(session.pty, ptyBefore, 'plan approval continues the existing run');
  }
});

test('remote start preserves assignee and unavailable-agent gates', async t => {
  const h = harness(t, { task: { assignee: 2 } });
  assert.equal((await h.start()).code, 'task_assigned_to_other_member');
  assert.equal(h.spawns.length, 0); assert.equal(h.sessions.size, 0);
  h.task.assignee = 1;
  assert.equal((await h.start({ agent: 'claude' })).code, 'agent_unavailable');
});

test('remote start rejects missing tasks, reservations and human work', async t => {
  const h = harness(t);
  h.task.category = 'HUMAN'; assert.equal((await h.start()).code, 'task_not_startable');
  h.task.category = 'CODING'; h.task.isReservation = true; assert.equal((await h.start()).code, 'task_not_startable');
  h.task.isReservation = false; h.backend.getTask = async () => null;
  assert.equal((await h.start()).code, 'task_not_startable');
  assert.equal(h.spawns.length, 0);
  assert.equal(h.claims.length, 0);
});

test('a remote objective start runs parent-objective preparation, as a local Start does', async t => {
  const h = harness(t, { task: { isObjective: true, assignee: null } });
  const result = await h.start();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.processes.length, 1);
  assert.equal(h.claims.length, 1, 'the objective is claimed through the same atomic start gate');
  const [{ taskId, opts }] = h.spawns;
  assert.equal(taskId, 'TPT1');
  assert.equal(opts.parentPreparation, true);
  assert.deepEqual(opts.objectiveChain, { rootTaskId: 'TPT1' });
  assert.equal(opts.cowboyChain, false, 'an objective chain never spills into Cowboy selection');
  const [session] = h.sessions.values();
  assert.equal(session.parentPreparation, true);
  assert.ok(session._cowboyToken, 'the run can hand its subtasks to start_next_tasks');
});

test('revocation during launch prevents PTY spawn; queued starts recheck before launching', async t => {
  const h = harness(t, { beforeSpec: () => h.revoke() });
  assert.equal((await h.start()).code, 'remote_control_disabled');
  assert.equal(h.sessions.size, 0);
  assert.equal(h.spawns.length, 1, 'agent spec prepared, but final authorization gate refused spawn');
});

test('queued remote start returns stable identity and stop cancels it without a PTY', async t => {
  const h = harness(t);
  sessionQueue.setAdmission({ tryReserve: () => ({ allowed: false }), snapshot: () => undefined });
  const result = await h.start(); assert.equal(result.ok, true);
  const session = [...h.sessions.values()][0]; assert.equal(session._queued, true);
  assert.equal(session.alive, false); assert.equal(h.spawns.length, 0);
  assert.equal(result.local_id, runId(session));
  const stopped = await handleRemoteSessionCommand({ action: 'stop', local_id: result.local_id },
    { session, isCurrent: () => true }, h.options);
  assert.equal(stopped.ok, true); assert.equal(h.sessions.size, 0); assert.equal(sessionQueue.size(), 0);
});

test('queued remote start cannot launch after authorization is revoked', async t => {
  const h = harness(t);
  sessionQueue.setAdmission({ tryReserve: () => ({ allowed: false }), snapshot: () => undefined });
  assert.equal((await h.start()).ok, true);
  h.revoke();
  sessionQueue.setAdmission({ tryReserve: () => ({ allowed: true }), snapshot: () => undefined });
  sessionQueue.drain();
  for (let i = 0; i < 20 && h.sessions.size; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.spawns.length, 0);
  assert.equal(h.sessions.size, 0);
});

test('remote input and resize use PTY operations; explicit stop releases process ownership once', async t => {
  const h = harness(t);
  const result = await h.start(); const session = [...h.sessions.values()][0];
  const context = { session, isCurrent: () => true };
  await handleRemoteSessionCommand({ action: 'input', data: 'remote keystrokes' }, context, h.options);
  assert.ok(h.writes.includes('remote keystrokes'));
  await handleRemoteSessionCommand({ action: 'resize', cols: 132, rows: 44 }, context, h.options);
  assert.deepEqual(h.resizes.at(-1), [132, 44]);
  let releases = 0; session.onProcessExited = () => { releases++; };
  assert.equal((await handleRemoteSessionCommand({ action: 'stop', local_id: result.local_id }, context, h.options)).ok, true);
  assert.equal(session.alive, false); assert.equal(h.sessions.size, 0); assert.equal(releases, 1);
  h.exit(); assert.equal(releases, 1);
});

test('real PTY output/exit publish lifecycle; local viewer disconnect preserves execution and attribution', async t => {
  const h = harness(t);
  const states = [], outputs = [];
  const stateListener = (session, state) => { if (session.projectPath === h.root) states.push(state); };
  const outputListener = (session, data) => { if (session.projectPath === h.root) outputs.push(data); };
  terminalEvents.on('state', stateListener); terminalEvents.on('output', outputListener);
  t.after(() => { terminalEvents.off('state', stateListener); terminalEvents.off('output', outputListener); });
  await h.start(); const session = [...h.sessions.values()][0];
  let releases = 0;
  session.onProcessExited = () => { releases++; };
  class Viewer extends EventEmitter {
    OPEN = 1; readyState = 1; sent = [];
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const viewer = new Viewer();
  await handleConnection(viewer, { url: '/?taskId=TPT1&reconnect=1', headers: { host: 'localhost', 'x-tiptask-project-path': h.root } },
    h.sessions, () => h.backend, () => {}, () => {}, () => h.backend);
  // wireClient refreshes lifecycle callbacks; observe only this run's process hook.
  session.onProcessExited = () => { releases++; };
  h.output('terminal output');
  assert.deepEqual(outputs, ['terminal output']);
  assert.ok(viewer.sent.some(f => f.type === 'data' && f.data === 'terminal output'));
  viewer.close();
  assert.equal(session.alive, true); assert.equal(releases, 0); assert.equal(session.ws, null);
  h.exit();
  assert.equal(session.alive, false); assert.equal(releases, 1);
  assert.deepEqual(states, ['running', 'exited']);
});

test('(TPT9273) only keys and pastes in a Task App terminal take keyboard control back; its own reports do not', async t => {
  const h = harness(t);
  await h.start(); const session = [...h.sessions.values()][0];
  const locals = [];
  const localListener = s => { if (s === session) locals.push(true); };
  terminalEvents.on('local', localListener);
  t.after(() => terminalEvents.off('local', localListener));
  class Viewer extends EventEmitter {
    OPEN = 1; readyState = 1; sent = [];
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const viewer = new Viewer();
  await handleConnection(viewer, { url: '/?taskId=TPT1&reconnect=1', headers: { host: 'localhost', 'x-tiptask-project-path': h.root } },
    h.sessions, () => h.backend, () => {}, () => {}, () => h.backend);
  const afterOpen = locals.length; // opening a local viewer is itself a local claim
  // Focus out/in, pointer motion, and answers to the agent's own queries reach the agent...
  for (const report of ['\x1b[O', '\x1b[I', '\x1b[<35;12;7M', '\x1b[?1;2c', '\x1b[24;80R', '\x1bP>|xterm.js(5.5.0)\x1b\\', '\x1b]11;rgb:1e1e/1e1e/2e2e\x07']) {
    viewer.emit('message', JSON.stringify({ type: 'data', data: report }));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(locals.length, afterOpen, 'reports never move keyboard control');
  assert.ok(h.writes.includes('\x1b[O') && h.writes.includes('\x1b[?1;2c'), 'reports still reach the agent');
  // ...while a key, Enter or a paste is the person at the Task App taking the keyboard.
  viewer.emit('message', JSON.stringify({ type: 'data', data: 'y' }));
  viewer.emit('message', JSON.stringify({ type: 'data', data: '\x1b[200~pasted\x1b[201~' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(locals.length, afterOpen + 2);
  viewer.close();
});

// (TPT9239) What this device's Task App windows hear: every project-scoped broadcast, as the
// __attention__ / __board__ watcher sockets of the harness project's window would.
function captureBroadcasts(t, projectPath) {
  const frames = [];
  websocket.init({ clients: new Set([{ readyState: 1, _projectPath: projectPath, send: raw => frames.push(JSON.parse(raw)) }]) });
  t.after(() => websocket.init(null));
  return frames;
}
const webStates = frames => frames.filter(f => f.type === 'remote-session-state').map(f => f.state);

class FakeViewer extends EventEmitter {
  OPEN = 1; readyState = 1; sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
}
const viewerRequest = (root, query) => ({ url: `/?${query}`, headers: { host: 'localhost', 'x-tiptask-project-path': root } });

test('a web start is listed with the web origin and tells this device\'s windows as it starts, runs and exits', async t => {
  const h = harness(t);
  const frames = captureBroadcasts(t, h.root);
  assert.equal((await h.start()).ok, true);
  const session = [...h.sessions.values()][0];
  assert.equal(session.startOrigin, 'web');
  assert.equal(sessionMetaRow(session).origin, 'web');
  assert.deepEqual(webStates(frames), ['starting', 'running']);
  assert.deepEqual(frames.find(f => f.type === 'remote-session-state'), {
    type: 'remote-session-state', projectPath: h.root, taskId: 'TPT1', tabId: 'TPT1', state: 'starting',
    origin: 'web', agent: 'codex', startedAt: session.startedAt,
  });
  h.exit();
  assert.deepEqual(webStates(frames), ['starting', 'running', 'exited']);
  assert.equal(frames.some(f => f.type === 'session-ended'), false, 'a natural exit stays listed as exited');
  assert.equal(sessionMetaRow(session).origin, 'web', 'the retained exited run keeps its origin');
});

test('stopping a web run ends it through session-ended alone; a refused web start reports exited', async t => {
  const h = harness(t);
  const frames = captureBroadcasts(t, h.root);
  const result = await h.start();
  const session = [...h.sessions.values()][0];
  await handleRemoteSessionCommand({ action: 'stop', local_id: result.local_id }, { session, isCurrent: () => true }, h.options);
  assert.deepEqual(webStates(frames), ['starting', 'running']);
  assert.equal(frames.filter(f => f.type === 'session-ended' && f.taskId === 'TPT1').length, 1);

  frames.length = 0;
  h.task.assignee = 2;
  assert.equal((await h.start({ command_id: 'start-0002' })).code, 'task_assigned_to_other_member');
  assert.deepEqual(webStates(frames), ['exited'], 'foreign assignment is refused before launch admission');
  assert.equal(h.sessions.size, 0);
});

test('a Task App viewer of a web run sees the web origin; closing it and reopening keeps the run and the origin', async t => {
  const h = harness(t);
  await h.start();
  const session = [...h.sessions.values()][0];
  const first = new FakeViewer();
  await handleConnection(first, viewerRequest(h.root, 'taskId=TPT1'), h.sessions, () => h.backend, () => {}, () => {}, () => h.backend);
  assert.equal(first.sent.find(f => f.type === 'config').origin, 'web');
  assert.equal(first.sent.find(f => f.type === 'terminal-state').origin, 'web');
  first.close();
  assert.equal(session.alive, true, 'closing the Task App viewer leaves the run');
  const again = new FakeViewer();
  await handleConnection(again, viewerRequest(h.root, `taskId=TPT1&startedAt=${session.startedAt}`), h.sessions, () => h.backend, () => {}, () => {}, () => h.backend);
  assert.equal(again.sent.find(f => f.type === 'config').origin, 'web');
  assert.equal(again.sent.find(f => f.type === 'terminal-state').origin, 'web');
  assert.equal(h.sessions.size, 1);
  assert.equal(h.spawns.length, 1, 'reopening never starts a second agent');
  assert.equal(session.alive, true);
});

test('a run started in Task App carries no origin and sends no remote-session-state frame', async t => {
  const h = harness(t);
  const frames = captureBroadcasts(t, h.root);
  const viewer = new FakeViewer();
  await handleConnection(viewer, viewerRequest(h.root, 'taskId=TPT1&prompt=Work%20on%20task%20TPT1'), h.sessions, () => h.backend, () => {}, () => {}, () => h.backend);
  const session = [...h.sessions.values()][0];
  assert.equal(session.alive, true);
  assert.equal(session.startOrigin, null);
  assert.equal('origin' in sessionMetaRow(session), false);
  assert.equal('origin' in viewer.sent.find(f => f.type === 'config'), false);
  assert.equal('origin' in viewer.sent.find(f => f.type === 'terminal-state'), false);
  h.exit();
  assert.deepEqual(webStates(frames), []);
});
