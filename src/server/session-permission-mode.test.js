'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-live-mode-'));
process.env.TIPATASK_PROJECT_ROOT = scratch;
process.env.TIPATASK_USER_DATA = scratch;
const { createSession } = require('./session-state');
const { buildPermissionPolicy } = require('./permission-policy');
const { requestPermissionMode, emitTerminalState, emitPermissionModeState, approvePlan, markPlanApprovedInTui, handleTerminalInput, pasteAndSubmit } = require('./terminal-session');
const { getTaskAgent } = require('./task-agent');
const websocket = require('./websocket');
const { handleConnection, sessionMetaRow } = require('./ws-handlers');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function socket(extra = {}) {
  const ws = new EventEmitter();
  Object.assign(ws, { OPEN: 1, readyState: 1, frames: [], ...extra });
  ws.send = raw => ws.frames.push(JSON.parse(raw));
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  return ws;
}

function fixture(agent = 'claude', mode = 'plan') {
  const ws = socket();
  const session = createSession(ws, false, 'TPT1', scratch);
  Object.assign(session, { taskAgent: agent, taskId: 'TPT1', projectPath: scratch, alive: true,
    pty: { write() {} }, permissionPolicy: buildPermissionPolicy({ mode, source: 'task' }, agent),
    permissionMode: { requested: mode, confirmed: mode, pending: false, error: null },
    terminalPhase: mode === 'plan' ? 'planning' : 'executing' });
  return { session, ws, sessions: new Map([['key', session]]) };
}

test('provider-confirmed switches cover all four transitions, retaining context and clearing the planning wait', async t => {
  for (const provider of ['claude', 'codex', 'pi']) {
    const agent = getTaskAgent(provider);
    const mock = t.mock.method(agent, 'switchPermissionMode', async (session, mode) => {
      assert.equal(session.permissionMode.pending, true);
      assert.notEqual(session.permissionMode.confirmed, mode);
      assert.match(agent.buildModeSwitchDirective(mode), /authorizes implementation now/);
      return { supported: true, confirmed: mode };
    });
    for (const [from, to] of [['plan', 'auto'], ['plan', 'bypass'], ['auto', 'bypass'], ['bypass', 'auto']]) {
      const { session, sessions, ws } = fixture(provider, from);
      const context = session.messages;
      context.push({ role: 'user', content: 'Keep working' });
      const pty = session.pty;
      session.codexPlanReady = true;
      session.agentPlanReady = true;
      session._planReadySent = true;
      session._typedLine = 'approved';
      session._localCommandBuffer = '/approve';
      session._interceptingApprovalCommand = true;
      const result = await requestPermissionMode('key', to, sessions);
      assert.deepEqual(result, { requested: to, confirmed: to, pending: false, error: null });
      assert.equal(session.permissionPolicy.mode, to);
      assert.equal(session.terminalPhase, 'executing');
      assert.equal(session._planReadySent, false);
      assert.equal(session.codexPlanReady, false);
      assert.equal(session.agentPlanReady, false);
      assert.equal(session._typedLine, '');
      assert.equal(session._localCommandBuffer, '');
      assert.equal(session.pty, pty);
      assert.equal(session.messages, context);
      assert.deepEqual(ws.frames.filter(f => f.type === 'session:permission-mode-changed').map(f => [f.pending, f.confirmed]),
        [[true, from], [false, to]]);
    }
    mock.mock.restore();
  }
});

test('unsupported, rejected, missing or wrong confirmation retains the previous policy and planning wait', async t => {
  const agent = getTaskAgent('claude');
  for (const [result, reason] of [[{ supported: false }, 'unsupported'], [{ supported: true }, 'unconfirmed'],
    [{ supported: true, confirmed: 'bypass' }, 'unconfirmed'], [new Error('Native control failed'), 'failed']]) {
    const mock = t.mock.method(agent, 'switchPermissionMode', async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const { session, sessions, ws } = fixture();
    const policy = session.permissionPolicy;
    session._planReadySent = true;
    const state = await requestPermissionMode('key', 'auto', sessions);
    assert.equal(state.requested, 'auto');
    assert.equal(state.confirmed, 'plan');
    assert.equal(state.pending, false);
    assert.equal(state.error.reason, reason);
    assert.equal(session.permissionPolicy, policy);
    assert.equal(session.terminalPhase, 'planning');
    assert.equal(session._planReadySent, true);
    assert.equal(ws.frames.at(-1).permissionMode, 'plan', 'legacy display reports confirmed enforcement');
    mock.mock.restore();
  }
});

test('a failed Bypass to Auto switch retains Bypass and a same-mode request clears the error without touching the provider', async t => {
  const { session, sessions } = fixture('claude', 'bypass');
  const policy = session.permissionPolicy;
  const mock = t.mock.method(getTaskAgent('claude'), 'switchPermissionMode', async () => { throw new Error('Switch rejected'); });
  const result = await requestPermissionMode('key', 'auto', sessions);
  assert.equal(result.confirmed, 'bypass');
  assert.equal(result.error.reason, 'failed');
  assert.equal(session.permissionPolicy, policy);
  assert.deepEqual(await requestPermissionMode('key', 'bypass', sessions), {
    requested: 'bypass', confirmed: 'bypass', pending: false, error: null,
  });
  assert.equal(mock.mock.callCount(), 1);
});

test('invalid targets, inactive sessions, duplicate requests and old run confirmations cannot replace active policy', async t => {
  const { session, sessions } = fixture();
  let confirm;
  const mock = t.mock.method(getTaskAgent('claude'), 'switchPermissionMode', () => new Promise(resolve => { confirm = resolve; }));
  for (const mode of ['plan', 'typo', null, {}]) {
    const state = await requestPermissionMode('key', mode, sessions);
    assert.ok(state.error);
    assert.equal(state.confirmed, 'plan');
  }
  assert.equal(mock.mock.callCount(), 0);
  session.alive = false;
  assert.equal((await requestPermissionMode('key', 'auto', sessions)).error.reason, 'inactive');
  session.alive = true;
  const switchPromise = requestPermissionMode('key', 'auto', sessions);
  await assert.rejects(requestPermissionMode('key', 'bypass', sessions), { reason: 'busy' });
  assert.equal(session.permissionMode.requested, 'auto');
  const replacement = fixture('claude', 'bypass').session;
  sessions.set('key', replacement);
  confirm({ supported: true, confirmed: 'auto' });
  assert.equal((await switchPromise).error.reason, 'session_changed');
  assert.equal(replacement.permissionMode.confirmed, 'bypass');
});

// (TPT9138) The real Pi adapter and gate. The fake PTY plays Pi plus its gate extension: Enter
// submits the pasted text, and the extension reports a submitted switch directive to the gate.
test('Pi switches live through its gate: the directive report confirms, held calls follow, Bypass to Auto prompts again', async t => {
  const { createPermissionGate } = require('./permission-gate');
  const { switchDirectiveMode } = await import('./providers/pi-ext/permission-gate.mjs');
  const agent = getTaskAgent('pi');
  const { session, sessions } = fixture('pi', 'plan');
  assert.equal(agent.supportsLivePermissionSwitch(session), false, 'a run launched without the gate cannot switch');
  assert.deepEqual(await agent.switchPermissionMode(session, 'auto'), { supported: false });
  const gate = await createPermissionGate(session, { root: scratch, timeoutMs: 5000 });
  t.after(() => gate.close());
  session._permissionGate = gate;
  const post = event => fetch(gate.url, { method: 'POST', headers: { Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify(event) }).then(r => r.json());
  const tool = (tool_name, tool_input) => post({ hook_event_name: 'PreToolUse', tool_name, tool_input });
  const untilRequest = () => new Promise(resolve => { const poll = () => gate.snapshot() ? resolve() : setTimeout(poll, 5); poll(); });
  assert.equal((await requestPermissionMode('key', 'auto', sessions)).error.reason, 'inactive', 'not before the handshake');
  await post({ hook_event_name: 'SessionStart' });
  assert.equal(agent.supportsLivePermissionSwitch(session), true);
  let pasted = '';
  const writes = [];
  let reports = true;
  session.lastOutputAt = 0;
  session.pty.write = data => {
    writes.push(data);
    if (data.startsWith('\x1b[200~')) pasted = data.slice(6, -6);
    else if (data === '\r' && reports && switchDirectiveMode(pasted)) {
      post({ hook_event_name: 'UserPromptSubmit', permission_mode: switchDirectiveMode(pasted) });
    }
  };

  // Plan to Auto while planning: a write made during the switch waits, then runs under Auto.
  assert.equal((await tool('write', { path: 'out.txt' })).decision, 'deny');
  const toAuto = requestPermissionMode('key', 'auto', sessions);
  const heldWrite = tool('write', { path: 'out.txt' });
  assert.deepEqual(await toAuto, { requested: 'auto', confirmed: 'auto', pending: false, error: null });
  assert.deepEqual([(await heldWrite).decision, (await heldWrite).mode], ['allow', 'auto']);
  assert.match(writes[0], /^\x1b\[200~The user selected auto for this session\. Leaving Plan explicitly authorizes implementation now/);
  assert.match(writes[0], /does not cancel or reverse an action already running/);
  assert.deepEqual(writes.slice(1), ['\r']);
  assert.equal(session.terminalPhase, 'executing');
  assert.equal(session.permissionPolicy.mode, 'auto');

  // Auto to Bypass while a permission request is outstanding: it is revoked, and the retry runs.
  const outstanding = tool('bash', { command: 'npm test' });
  await untilRequest();
  assert.equal((await requestPermissionMode('key', 'bypass', sessions)).confirmed, 'bypass');
  assert.deepEqual([(await outstanding).decision, (await outstanding).reason], ['deny', 'Permission mode changed. Retry the action.']);
  assert.equal((await tool('bash', { command: 'npm test' })).decision, 'allow');

  // Bypass to Auto restores approval checks.
  assert.equal((await requestPermissionMode('key', 'auto', sessions)).confirmed, 'auto');
  const asked = tool('bash', { command: 'npm test' });
  await untilRequest();
  gate.answer(gate.snapshot().id, false);
  assert.equal((await asked).decision, 'deny');

  // Pi never reports the directive: the switch fails and Auto stays enforced and displayed.
  reports = false;
  const expect = gate.expectModeSwitch;
  t.mock.method(gate, 'expectModeSwitch', mode => expect(mode, { timeoutMs: 50 }));
  const failed = await requestPermissionMode('key', 'bypass', sessions);
  assert.deepEqual([failed.confirmed, failed.pending, failed.error.reason], ['auto', false, 'unconfirmed']);
  assert.equal(session.permissionPolicy.mode, 'auto');
  const stillAsked = tool('bash', { command: 'npm test' });
  await untilRequest();
  gate.answer(gate.snapshot().id, true);
  assert.equal((await stillAsked).decision, 'allow');
});

test('a relaunch or an exit during a provider await cannot claim confirmation for the new run', async t => {
  for (const change of ['relaunch', 'exit']) {
    const { session, sessions } = fixture();
    let confirm;
    const mock = t.mock.method(getTaskAgent('claude'), 'switchPermissionMode', () => new Promise(resolve => { confirm = resolve; }));
    const promise = requestPermissionMode('key', 'auto', sessions);
    if (change === 'relaunch') {
      session.permissionMode = { requested: 'bypass', confirmed: 'bypass', pending: false, error: null };
      session.permissionPolicy = buildPermissionPolicy({ mode: 'bypass' }, 'claude');
    } else session.alive = false;
    confirm({ supported: true, confirmed: 'auto' });
    const result = await promise;
    assert.equal(result.confirmed, change === 'relaunch' ? 'bypass' : 'plan');
    if (change === 'exit') assert.equal(result.error.reason, 'session_changed');
    mock.mock.restore();
  }
});

test('pending switches block input and Proceed, invalidate queued submissions and preserve last confirmed inventory', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, sessions } = fixture();
  const writes = [];
  session.pty.write = text => writes.push(text);
  session.lastOutputAt = Date.now();
  pasteAndSubmit(session, { getPasteSilenceMs: () => 100 }, 'old approval');
  let confirm;
  t.mock.method(getTaskAgent('claude'), 'switchPermissionMode', () => new Promise(resolve => { confirm = resolve; }));
  const promise = requestPermissionMode('key', 'bypass', sessions);
  approvePlan(session);
  handleTerminalInput(session, '/approve-plan\r');
  assert.equal(markPlanApprovedInTui(session, 'mode'), false, 'an interim native repaint cannot confirm a switch');
  assert.equal(session.terminalPhase, 'planning');
  assert.equal(sessionMetaRow(session).permissionMode.confirmed, 'plan');
  t.mock.timers.tick(200);
  assert.deepEqual(writes, []);
  confirm({ supported: true, confirmed: 'bypass' });
  await promise;
  t.mock.timers.tick(1000);
  assert.deepEqual(writes, []);
  emitTerminalState(session);
  assert.equal(session.ws.frames.at(-1).permissionMode, 'bypass');
});

test('all providers drop delayed approval text and Enter after the permission generation changes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(require('./vcs-context'), 'refreshSessionVcs', async () => ({ verified: true, vcs: { type: 'off' } }));
  for (const provider of ['claude', 'codex', 'pi']) {
    const { session } = fixture(provider);
    const writes = [];
    session.pty.write = text => writes.push(text);
    session.lastOutputAt = Date.now();
    const approval = getTaskAgent(provider).approvePlan(session);
    session._permissionEpoch++;
    await approval;
    const count = writes.length;
    t.mock.timers.tick(10000);
    assert.equal(writes.length, count, provider);
  }
});

test('WS switch and reconnect replay the confirmed session state, ignoring payload targets and displaced sockets', async t => {
  const { session } = fixture();
  // No remote API, KB sync or provider spawn in this in-process reconnect check.
  const backend = { getProjectSettings: async () => ({ vcs_type: null, vcs_worktree_enabled: false,
    vcs_commit_enabled: false, vcs_pr_enabled: false, vcs_merge_enabled: false }) };
  const key = 'TPT1\0' + scratch;
  const sessions = new Map([[key, session], ['other', fixture('claude', 'auto').session]]);
  const connect = async () => {
    const ws = socket();
    await handleConnection(ws, { url: '/?taskId=TPT1', headers: { host: 'localhost', 'x-tiptask-project-path': scratch } },
      sessions, () => backend, null, null, () => backend);
    return ws;
  };
  let confirm;
  t.mock.method(getTaskAgent('claude'), 'switchPermissionMode', () => new Promise(resolve => { confirm = resolve; }));
  const first = await connect();
  const message = first.listeners('message')[0];
  const switching = message(JSON.stringify({ type: 'session:permission-mode', mode: 'bypass', taskId: 'other', projectPath: '/wrong' }));
  assert.equal(session.permissionMode.confirmed, 'plan');
  const pendingSocket = await connect();
  const pendingReplay = pendingSocket.frames.find(f => f.type === 'session:permission-mode-changed');
  assert.equal(pendingReplay.confirmed, 'plan');
  assert.equal(pendingReplay.requested, 'bypass');
  assert.equal(pendingReplay.pending, true);
  confirm({ supported: true, confirmed: 'bypass' });
  await switching;
  assert.equal(pendingSocket.frames.findLast(f => f.type === 'session:permission-mode-changed').confirmed, 'bypass');
  assert.equal(session.permissionMode.confirmed, 'bypass');
  assert.equal(sessions.get('other').permissionMode.confirmed, 'auto');
  const second = await connect();
  const replay = second.frames.find(f => f.type === 'session:permission-mode-changed');
  assert.equal(replay.confirmed, 'bypass');
  assert.equal(replay.pending, false);
  assert.equal(second.frames.find(f => f.type === 'terminal-state').permissionMode, 'bypass');
  await message(JSON.stringify({ type: 'session:permission-mode', mode: 'auto' }));
  assert.equal(session.permissionMode.confirmed, 'bypass', 'displaced socket cannot switch');
  session.alive = false;
});

// (TPT9139) The terminal header shows its live selector only while `supported` is true: an
// adapter that implements switchPermissionMode(), on a task terminal it has not refused.
test('state frames carry `supported` from the adapter, false for the base contract, other sessions and after an unsupported refusal', async t => {
  const BaseTaskAgent = require('./task-agent/base-agent');
  class LiveAgent extends BaseTaskAgent { async switchPermissionMode(session, mode) { return { supported: true, confirmed: mode }; } }
  assert.equal(new BaseTaskAgent('base', 'Base').supportsLivePermissionSwitch({}), false);
  assert.equal(new LiveAgent('live', 'Live').supportsLivePermissionSwitch({}), true);

  const { session, ws, sessions } = fixture();
  const agent = getTaskAgent('claude');
  const native = agent.supportsLivePermissionSwitch(session);
  emitTerminalState(session);
  assert.equal(ws.frames.at(-1).permissionModeState.supported, native);
  assert.equal(sessionMetaRow(session).permissionMode.supported, native);

  const mock = t.mock.method(agent, 'switchPermissionMode', async (s, mode) => ({ supported: true, confirmed: mode }));
  // (TPT9136) Claude offers the switch for runs it launched (session._claudeNative); stand in for one.
  t.mock.method(agent, 'supportsLivePermissionSwitch', () => true);
  emitTerminalState(session);
  assert.equal(ws.frames.at(-1).permissionModeState.supported, true, 'an implemented switch is offered');
  await requestPermissionMode('key', 'auto', sessions);
  const changes = ws.frames.filter(f => f.type === 'session:permission-mode-changed');
  assert.deepEqual(changes.map(f => [f.pending, f.supported]), [[true, true], [false, true]]);
  assert.equal(ws.frames.at(-1).type, 'terminal-state');
  assert.deepEqual(ws.frames.at(-1).permissionModeState,
    { requested: 'auto', confirmed: 'auto', pending: false, error: null, supported: true });

  mock.mock.mockImplementation(async () => ({ supported: false }));
  const refused = await requestPermissionMode('key', 'bypass', sessions);
  assert.equal(refused.error.reason, 'unsupported');
  assert.equal(ws.frames.findLast(f => f.type === 'session:permission-mode-changed').supported, false);
  assert.equal(ws.frames.at(-1).permissionModeState.supported, false);
  assert.equal(sessionMetaRow(session).permissionMode.supported, false);

  // Only a task terminal with a policy offers the switch, never an image run or a chat.
  mock.mock.mockImplementation(async (s, mode) => ({ supported: true, confirmed: mode }));
  session.permissionMode = { ...session.permissionMode, error: null };
  emitTerminalState(session);
  assert.equal(ws.frames.at(-1).permissionModeState.supported, true);
  session._imageOperation = {};
  emitTerminalState(session);
  assert.equal(ws.frames.at(-1).permissionModeState.supported, false);
  session._imageOperation = null;
  session.type = 'taskChat';
  assert.equal(sessionMetaRow(session).permissionMode.supported, false);
});

// emitPermissionModeState()'s own backstop: a pending chat still has the default terminal type.
test('a chat session gets its terminal-state reply but never a permission-mode frame or project broadcast', () => {
  const watcher = socket({ _projectPath: scratch, _attentionSubscriber: true });
  websocket.init({ clients: new Set([watcher]) });
  try {
    for (const id of ['taskChat:TPT1', `projectChat:2:chat-1`, 'obj-1']) {
      const ws = socket();
      const chat = Object.assign(createSession(ws, false, id, scratch), { projectPath: scratch });
      emitPermissionModeState(chat);
      assert.deepEqual(ws.frames.map(f => f.type), ['terminal-state'], id);
    }
    assert.deepEqual(watcher.frames, []);
    const { session, ws } = fixture();
    emitPermissionModeState(session);
    assert.deepEqual(ws.frames.map(f => f.type), ['session:permission-mode-changed', 'terminal-state']);
    assert.equal(watcher.frames.length, 1, 'a task terminal still reaches its project windows');
  } finally { websocket.init(null); }
});

// A task or project chat socket connects as a pending session that keeps the default terminal
// type until its start-* message. wireClient() goes by the chat id: no mode state on connect, and
// a switch request is refused before the session's mode is touched.
test('a pending chat socket gets no mode state on connect and its switch request is refused without a broadcast', async () => {
  const watchers = [socket({ _projectPath: scratch, _attentionSubscriber: true }),
    socket({ _projectPath: scratch, _boardWatcher: true })];
  websocket.init({ clients: new Set(watchers) });
  const backend = { getCredentials: () => ({ projectId: '2' }) };
  const sessions = new Map();
  try {
    for (const id of ['taskChat:TPT1', 'projectChat:2:chat01']) {
      const ws = socket();
      await handleConnection(ws, { url: `/?taskId=${encodeURIComponent(id)}`, headers: { host: 'localhost', 'x-tiptask-project-path': scratch } },
        sessions, () => backend, null, null, () => backend);
      const chat = sessions.get(`${id}\0${scratch}`);
      assert.deepEqual([chat.type, chat.pending], ['terminal', true], `${id} is still pending`);
      const mode = chat.permissionMode;
      assert.deepEqual(ws.frames.filter(f => f.type === 'terminal-state' || f.type === 'session:permission-mode-changed'), [], id);
      assert.equal('permissionMode' in sessionMetaRow(chat), false, id);

      ws.emit('message', JSON.stringify({ type: 'session:permission-mode', mode: 'auto' }));
      await new Promise(resolve => setImmediate(resolve));
      const changes = ws.frames.filter(f => f.type === 'session:permission-mode-changed');
      assert.equal(changes.length, 1, id);
      assert.deepEqual(changes[0].error, { code: 'EPERMISSION_MODE', reason: 'inactive',
        message: 'Permission mode can only change in a running task terminal.' });
      assert.deepEqual([changes[0].taskId, changes[0].requested, changes[0].supported], [id, null, false]);
      assert.equal(chat.permissionMode, mode, `${id} keeps its mode state`);
      assert.deepEqual(mode, { requested: null, confirmed: null, pending: false, error: null });
    }
    assert.deepEqual(watchers.map(ws => ws.frames), [[], []], 'no project window hears about a chat');
  } finally { websocket.init(null); }
});

test('permission-mode broadcasts reach only window watchers in the exact project', () => {
  const clients = [socket({ _projectPath: scratch, _boardWatcher: true }),
    socket({ _projectPath: scratch, _attentionSubscriber: true }),
    socket({ _projectPath: '/other', _boardWatcher: true }), socket({ _boardWatcher: true }), socket()];
  websocket.init({ clients: new Set(clients) });
  try {
    websocket.emitSessionPermissionModeChanged(scratch, { taskId: 'TPT1', confirmed: 'auto' });
    assert.deepEqual(clients.map(ws => ws.frames.length), [1, 1, 0, 0, 0]);
  } finally { websocket.init(null); }
});
