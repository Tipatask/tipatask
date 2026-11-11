'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { connectDeviceRelay, runId, captureSessionOwner, relayUrl, utf8Tail, remoteApprovalRequest, isTerminalReport } = require('./device-relay');

const LIMITS = { max_device_frame_bytes: 262144, max_output_data_bytes: 32768,
  max_replay_bytes: 262144, max_sessions: 64, frames_per_second: 200, output_bytes_per_second: 1048576 };
const token = (id = 1) => `header.${Buffer.from(JSON.stringify({ id, exp: 9999999999 })).toString('base64url')}.signature`;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('local opt-out fences buffered output and every command before notification or poll', async t => {
  const h = harness(t);
  const session = h.session();
  const ws = h.ready(undefined, {}, true);
  const binding = { local_id: runId(session), attachment_id: 'att_one' };
  await h.send({ action: 'attach', command_id: 'attach-consent', ...binding });
  h.events.emit('output', session, 'buffered-before-disable');
  const sent = ws.sent.length; const handled = h.commands.length;
  h.project.enabled = false;
  for (const action of ['input', 'resize', 'stop', 'approve', 'take_control', 'attach', 'start']) {
    await h.send({ action, command_id: `disabled-${action}`, ...binding, project_id: 2, task_key: 'TPT2',
      seq: 1, data: 'blocked', cols: 80, rows: 24, request_id: 'old-request', allow: true }, ws);
  }
  h.events.emit('output', session, 'after-disable'); h.events.emit('approval', session); h.tick(1200);
  assert.equal(ws.sent.length, sent);
  assert.equal(h.commands.length, handled);
  assert.equal(session.alive, true);
});

test('a replaced consent generation fences a pending start even after immediate re-enable', async t => {
  let context; let cancelled = 0;
  const h = harness(t, { handleCommand: async (_frame, ctx) => {
    context = ctx; ctx.onCancel(() => cancelled++); return { ok: true, code: 'queued' };
  } });
  h.project.consentGrant = 'old-grant'; h.relay.sync();
  h.tick(2000); h.ready();
  await h.send({ action: 'start', command_id: 'start-consent', project_id: 2, task_key: 'TPT1' });
  h.project.consentGrant = 'new-grant';
  assert.equal(context.isCurrent(), false);
  assert.equal(cancelled, 1);
});

test('consent disappearing between output checks drops the frame without throwing', async t => {
  let project; let reads = 0; let cutoff = Infinity;
  const h = harness(t, { getProjects: () => project && ++reads <= cutoff ? [project] : [] });
  project = h.project; h.relay.sync();
  const session = h.session(); const ws = h.ready();
  await h.send({ action: 'attach', command_id: 'attach-race', local_id: runId(session), attachment_id: 'att_one' });
  reads = 0; cutoff = 2;
  assert.doesNotThrow(() => h.events.emit('output', session, 'concurrent-opt-out'));
  h.tick(20);
  assert.equal(ws.sent.some(frame => frame.data === 'concurrent-opt-out'), false);
  assert.equal(session.alive, true);
});

test('launch grants are consumed once, bound to the request deadline, and require protocol support', async t => {
  let context;
  const h = harness(t, { monotonicNow: () => Date.now(), handleCommand: async (_frame, ctx) => {
    context = ctx; return { ok: true, code: 'queued', local_id: 'queued-run' };
  } });
  const ws = h.ready();
  await h.send({ action: 'start', command_id: 'grant-once', project_id: 2, task_key: 'TPT1' });
  const grant = context.authorizeStart(); h.tick(20);
  assert.equal(ws.sent.at(-1).type, 'authorize_start');
  ws.receive({ type: 'start_authorization', command_id: 'grant-once', allowed: true });
  const consume = await grant; consume();
  assert.throws(consume, { code: 'EAUTH' });
  await assert.rejects(context.authorizeStart(), { code: 'EAUTH' });

  await h.send({ action: 'start', command_id: 'grant-expired', project_id: 2, task_key: 'TPT2' });
  const expired = context.authorizeStart();
  h.tick(4999);
  ws.receive({ type: 'start_authorization', command_id: 'grant-expired', allowed: true });
  const expiredConsume = await expired;
  h.tick(1);
  assert.throws(expiredConsume, { code: 'EAUTH' }, 'reply arrival cannot extend the request deadline');
});

test('late authorization, cancellation and reconnect cannot revive a queued receipt', async t => {
  let context, cancelled = 0;
  const h = harness(t, { monotonicNow: () => Date.now(), handleCommand: async (_frame, ctx) => {
    context = ctx; ctx.onCancel(() => cancelled++);
    return { ok: true, code: 'queued', local_id: 'queued-run' };
  } });
  const ws = h.ready();
  const frame = { action: 'start', command_id: 'cancel-grant', project_id: 2, task_key: 'TPT1' };
  await h.send(frame);
  const grant = context.authorizeStart();
  ws.receive({ type: 'command_cancelled', command_id: frame.command_id });
  const consume = await grant;
  assert.throws(consume, { code: 'EAUTH' });
  ws.receive({ type: 'start_authorization', command_id: frame.command_id, allowed: true });
  assert.equal(context.isCurrent(), false);
  assert.equal(cancelled, 1);
  ws.close(1006); h.tick(2000); h.ready();
  await h.send(frame);
  assert.equal(h.sockets.at(-1).sent.filter(f => f.type === 'command_result').at(-1).ok, false);
  assert.equal(cancelled, 1);
});

test('a stalled authorization times out and a late positive reply remains unusable', async t => {
  let context;
  const h = harness(t, { monotonicNow: () => Date.now(), handleCommand: async (_frame, ctx) => {
    context = ctx; return { ok: true, code: 'queued' };
  } });
  const ws = h.ready();
  await h.send({ action: 'start', command_id: 'stalled-grant', project_id: 2, task_key: 'TPT1' });
  const grant = context.authorizeStart(); h.tick(5000);
  const consume = await grant;
  ws.receive({ type: 'start_authorization', command_id: 'stalled-grant', allowed: true });
  assert.throws(consume, { code: 'EAUTH' });
});

test('older API without final-start authorization refuses remote starts', async t => {
  const h = harness(t);
  const ws = h.sockets.at(-1);
  ws.receive({ type: 'ready', protocol: 1, project_ids: [2], expiry_ms: 180000, limits: LIMITS });
  await h.send({ action: 'start', command_id: 'old-server', project_id: 2, task_key: 'TPT1' });
  assert.equal(h.commands.length, 0);
  assert.equal(ws.sent.filter(f => f.type === 'command_result').at(-1).code, 'authentication_required');
});

test('a duplicate waiting for initial preparation observes cancellation instead of its late acceptance', async t => {
  let finish;
  const h = harness(t, { handleCommand: () => new Promise(resolve => { finish = resolve; }) });
  const ws = h.ready();
  const frame = { action: 'start', command_id: 'pending-duplicate', project_id: 2, task_key: 'TPT1' };
  await h.send(frame); await h.send(frame);
  ws.receive({ type: 'command_cancelled', command_id: frame.command_id });
  finish({ ok: true, code: 'queued' });
  await settle(); h.tick(20);
  assert.ok(ws.sent.filter(f => f.type === 'command_result').every(f => f.ok === false));
});

function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sockets = [];
  const events = new EventEmitter();
  const sessions = new Map();
  const commands = [];
  const refreshes = [];
  const credentials = { baseUrl: 'https://example.test', projectId: '2', token: token() };
  const project = { projectPath: '/project', deviceId: 7, enabled: true, backend: { getCredentials: () => credentials } };
  let projects = [project];
  class Socket extends EventEmitter {
    constructor(url, protocol, opts) {
      super(); Object.assign(this, { url, protocol, opts, readyState: 1, bufferedAmount: 0, sent: [] }); sockets.push(this);
    }
    send(json) { this.sent.push({ at: Date.now(), ...JSON.parse(json) }); }
    receive(frame) { this.emit('message', Buffer.from(JSON.stringify(frame)), false); }
    close(code) { this.readyState = 3; this.emit('close', code); }
    terminate() { if (this.readyState !== 3) this.close(1006); }
  }
  const handler = async (frame, ctx) => {
    commands.push(frame);
    if (frame.action === 'attach') return ctx.attach();
    if (frame.action === 'detach') return ctx.detach();
    if (frame.action === 'start') return { ok: true, local_id: 'new-run' };
    return { ok: true };
  };
  const relay = connectDeviceRelay({ getProjects: () => projects, getSessions: () => sessions,
    events, subscribeAccountChanges: () => () => {}, WebSocketImpl: Socket, instanceId: 'instance-test', random: () => 0.5,
    handleCommand: options.handleCommand || handler,
    refreshToken: async args => { refreshes.push(args); return { token: token() }; }, ...options });
  t.after(() => relay.close());
  function ready(socket = sockets.at(-1), limits = {}, approvalControls = false) {
    socket.receive({ type: 'ready', protocol: 1, project_ids: [2], expiry_ms: 180000, approval_controls: approvalControls, start_authorization: true,
      limits: { ...LIMITS, ...limits } });
    return socket;
  }
  function session(extra = {}) {
    const s = { type: 'terminal', taskId: 'TPT1', taskAgent: 'codex', projectPath: '/project',
      alive: true, pty: {}, buffer: 'history 🦊 Україна', ws: null, ...extra };
    captureSessionOwner(s, project.backend);
    sessions.set(s.taskId, s);
    return s;
  }
  async function send(frame, ws = sockets.at(-1)) {
    ws.receive({ type: 'command', ...frame }); await settle(); t.mock.timers.tick(20); await settle();
  }
  return { sockets, events, sessions, commands, credentials, project, relay, ready, session, send, refreshes,
    setProjects(next) { projects = next; }, tick(ms) { t.mock.timers.tick(ms); } };
}

test('approval snapshots are private to attachments, replay current requests, and negotiate older APIs', async t => {
  const h = harness(t);
  let request = { id: 'request-1', tool: 'bash', input: 'echo test' };
  const session = h.session({ _permissionGate: { snapshot: () => request } });
  const ws = h.ready(undefined, {}, true);
  assert.ok(ws.sent.find(f => f.type === 'hello').capabilities.commands.includes('approve'));
  // Objectives start remotely in parent-objective mode; the web offers Start for one only here.
  assert.deepEqual(ws.sent.find(f => f.type === 'hello').capabilities.task_kinds, ['objective']);
  h.events.emit('approval', session); h.tick(20);
  assert.equal(ws.sent.filter(f => f.type === 'approval').length, 0);
  await h.send({ action: 'attach', command_id: 'attach-0001', local_id: runId(session), attachment_id: 'att_one', replay_bytes: 0 });
  assert.equal(ws.sent.filter(f => f.type === 'approval').at(-1).request.id, request.id);
  request = null;
  h.events.emit('approval', session); h.tick(20);
  assert.equal(ws.sent.filter(f => f.type === 'approval').at(-1).request, null);
  ws.close(1006); h.tick(2000);
  const old = h.ready();
  assert.equal(old.sent.find(f => f.type === 'hello').capabilities.commands.includes('approve'), false);
});

test('plan approval ids change between ready intervals and pending mode changes suspend approvals', () => {
  const session = { alive: true, terminalPhase: 'planning', _planReadySent: true };
  const first = remoteApprovalRequest(session);
  assert.equal(remoteApprovalRequest(session).id, first.id);
  session._planReadySent = false;
  assert.equal(remoteApprovalRequest(session), null);
  session._planReadySent = true;
  assert.notEqual(remoteApprovalRequest(session).id, first.id);
  session.permissionMode = { pending: true };
  assert.equal(remoteApprovalRequest(session), null);
});

test('(TPT9273) terminal reports are told apart from keys and pastes', () => {
  const reports = [
    '\x1b[I', '\x1b[O', '\x1b[O\x1b[I', // focus out/in
    '\x1b[<0;10;5M', '\x1b[<0;10;5m', '\x1b[<35;120;40M', '\x1b[M !!', // SGR and X10 mouse
    '\x1b[?1;2c', '\x1b[>0;276;0c', // device attributes
    '\x1b[24;80R', '\x1b[?24;80;1R', '\x1b[0n', // cursor position, status
    '\x1b[?2026;2$y', '\x1b[4;1$y', // mode reports
    '\x1bP>|xterm.js(5.5.0)\x1b\\', '\x1bP1$r0m\x1b\\', // DCS replies
    '\x1b]11;rgb:1e1e/1e1e/2e2e\x07', '\x1b]10;rgb:cdcd/d6d6/f4f4\x1b\\', // OSC colour replies
    '\x1b[8;40;120t', '\x1b[?0u', // window and keyboard-protocol reports
  ];
  for (const data of reports) assert.equal(isTerminalReport(data), true, JSON.stringify(data));
  const input = [
    'a', 'hello', '\r', '\x7f', '\t', '\x03', '\x1b', '\x1b[A', '\x1bOA', '\x1b[3~', '\x1b[Z', '\x1bb',
    '\x1b[200~pasted\x1b[201~', 'x\x1b[I', '\x1b[Ix', '', null,
  ];
  for (const data of input) assert.equal(isTerminalReport(data), false, JSON.stringify(data));
});

test('an attached owner can take keyboard control from a local viewer; local interaction and detach release it', async t => {
  const h = harness(t);
  const session = h.session({ ws: { readyState: 1 } });
  const ws = h.ready(undefined, {}, true);
  const base = { local_id: runId(session), attachment_id: 'att_one' };
  await h.send({ action: 'attach', command_id: 'attach-0001', ...base });
  assert.equal(ws.sent.filter(f => f.type === 'controller').at(-1).attachment_id, 'local');
  await h.send({ action: 'take_control', command_id: 'control-001', ...base });
  assert.equal(ws.sent.filter(f => f.type === 'controller').at(-1).attachment_id, 'att_one');
  await h.send({ action: 'input', seq: 1, data: 'y\r', ...base });
  assert.equal(h.commands.at(-1).action, 'input');
  h.events.emit('local', session); h.tick(20);
  assert.equal(ws.sent.filter(f => f.type === 'controller').at(-1).attachment_id, 'local');
  const count = h.commands.length;
  await h.send({ action: 'input', seq: 2, data: 'blocked', ...base });
  assert.equal(h.commands.length, count);
  await h.send({ action: 'take_control', command_id: 'control-002', ...base });
  await h.send({ action: 'detach', ...base });
  await h.send({ action: 'take_control', command_id: 'control-003', ...base });
  assert.equal(ws.sent.filter(f => f.type === 'command_result').at(-1).code, 'not_attached');
});

test('disabled mode neither resolves credentials nor opens a socket; TLS rejects non-loopback HTTP', t => {
  let credentialReads = 0;
  const h = harness(t, { getProjects: () => [{ enabled: false, deviceId: 7,
    backend: { getCredentials() { credentialReads++; throw new Error(); } } }] });
  h.tick(120000);
  assert.equal(h.sockets.length, 0); assert.equal(credentialReads, 0);
  assert.throws(() => relayUrl('http://example.test', 1, 'instance'), /HTTPS/);
  assert.throws(() => relayUrl('https://user:pass@example.test', 1, 'instance'), /HTTPS/);
  assert.match(relayUrl('http://127.0.0.1:4454', 1, 'instance'), /^ws:/);
  assert.match(relayUrl('https://example.test', 1, 'instance'), /^wss:/);
});

test('API aliases use distinct instance ids and reconnect with their own served projects', t => {
  const h = harness(t);
  const other = { ...h.project, projectPath: '/alias', backend: { getCredentials: () => ({
    ...h.credentials, baseUrl: 'https://alias.test', projectId: '3',
  }) } };
  h.setProjects([h.project, other]); h.relay.sync();
  const ids = () => h.sockets.map(ws => new URL(ws.url).searchParams.get('instance_id'));
  assert.notEqual(ids()[0], ids()[1], 'aliases reaching one API must not supersede each other');
  for (const ws of h.sockets) ws.receive({ type: 'ready', protocol: 1, project_ids: [2, 3, 4], limits: LIMITS });
  assert.deepEqual(h.sockets.map(ws => ws.sent[0].project_ids), [[2], [3]]);
  h.sockets[1].close(1006); h.tick(2000);
  assert.equal(ids()[2], ids()[1], 'reconnect retains only its own instance identity');
  h.ready();
  assert.deepEqual(h.sockets[2].sent[0].project_ids, [3]);
  assert.equal(h.sockets[0].readyState, 1);
});

test('one outbound authenticated socket multiplexes projects; idle sends only hello', t => {
  const h = harness(t);
  h.setProjects([h.project, { ...h.project, projectPath: '/other' }]); h.relay.sync();
  h.session(); h.session({ taskId: 'TPT2', projectPath: '/disabled' }); h.session({ taskId: 'taskChat:TPT1', type: 'taskChat' });
  h.tick(2000);
  const ws = h.ready();
  assert.equal(h.sockets.filter(socket => socket.readyState === 1).length, 1);
  assert.equal(ws.protocol, 'tipatask-relay.v1');
  assert.equal(ws.opts.headers.Authorization, `Bearer ${h.credentials.token}`);
  assert.equal(ws.opts.headers.Origin, undefined);
  assert.equal(ws.opts.perMessageDeflate, false);
  assert.equal(ws.opts.followRedirects, false);
  assert.ok(!ws.url.includes(h.credentials.token));
  assert.equal(ws.sent[0].sessions.length, 1);
  assert.deepEqual(ws.sent[0].project_ids, [2], 'two checkouts of one project announce it once');
  h.tick(60000);
  assert.equal(ws.sent.length, 1);
});

test('another checkout in the same account re-announces the union without losing the first project', t => {
  const h = harness(t);
  const first = h.ready();
  h.setProjects([h.project, { ...h.project, projectPath: '/other-project', backend: {
    getCredentials: () => ({ ...h.credentials, projectId: '3' }),
  } }]);
  h.relay.sync(); h.tick(2000);
  const next = h.ready();
  assert.equal(first.readyState, 3);
  assert.deepEqual(next.sent[0].project_ids, [2, 3]);
  assert.equal(new URL(first.url).searchParams.get('instance_id'), new URL(next.url).searchParams.get('instance_id'));
  h.tick(30000);
  assert.equal(next.readyState, 1);
});

test('a saved config immediately starts or closes the relay without waiting for its poll', t => {
  const h = harness(t);
  const first = h.ready();
  h.project.enabled = false;
  h.events.emit('config');
  assert.equal(first.readyState, 3);
  h.project.enabled = true;
  h.events.emit('config');
  assert.equal(h.sockets.length, 2);
  h.ready();
  h.relay.close();
  assert.equal(h.events.listenerCount('config'), 0);
});

test('bounded UTF-8 replay is private; local and remote viewers coexist and controller transfers', async t => {
  const h = harness(t); const session = h.session({ ws: { readyState: 1 } }); const ws = h.ready(); const id = runId(session);
  await h.send({ action: 'attach', command_id: 'attach-0001', local_id: id, attachment_id: 'att_one', replay_bytes: 12 });
  const replay = ws.sent.filter(f => f.type === 'output');
  assert.ok(replay.length); assert.ok(replay.every(f => f.attachment_id === 'att_one' && Buffer.byteLength(f.data) <= 12));
  assert.ok(!replay.some(f => f.data.includes('�')));
  assert.equal(ws.sent.filter(f => f.type === 'controller').at(-1).attachment_id, 'local');
  await h.send({ action: 'input', local_id: id, attachment_id: 'att_one', seq: 1, data: 'denied' });
  assert.equal(h.commands.filter(f => f.action === 'input').length, 0);
  session.ws = null; h.events.emit('local', session); h.tick(20);
  await h.send({ action: 'attach', command_id: 'attach-0002', local_id: id, attachment_id: 'att_two', replay_bytes: 0 });
  assert.equal(ws.sent.filter(f => f.type === 'controller').at(-1).attachment_id, 'att_one');
  await h.send({ action: 'input', local_id: id, attachment_id: 'att_one', seq: 1, data: 'allowed' });
  await h.send({ action: 'input', local_id: id, attachment_id: 'att_one', seq: 1, data: 'duplicate' });
  await h.send({ action: 'resize', local_id: id, attachment_id: 'att_two', cols: 100, rows: 30 });
  assert.equal(h.commands.filter(f => f.action === 'input').length, 1);
  assert.equal(h.commands.filter(f => f.action === 'resize').length, 0);
  await h.send({ action: 'detach', local_id: id, attachment_id: 'att_one' });
  assert.equal(ws.sent.filter(f => f.type === 'controller').at(-1).attachment_id, 'att_two');
  assert.equal(session.alive, true);
  await h.send({ action: 'resize', local_id: id, attachment_id: 'att_two', cols: 100, rows: 30 });
  assert.equal(h.commands.filter(f => f.action === 'resize').length, 1);
  await h.send({ action: 'detach', local_id: id, attachment_id: 'att_two' });
  const before = ws.sent.length;
  h.events.emit('output', session, 'not subscribed'); h.tick(100);
  assert.equal(ws.sent.length, before); assert.equal(session.alive, true);
});

test('PTY bursts coalesce and respect advertised frame, byte and UTF-8 limits', async t => {
  const h = harness(t); const session = h.session(); const ws = h.ready(undefined, {
    frames_per_second: 20, output_bytes_per_second: 4000, max_output_data_bytes: 3000,
  }); const id = runId(session);
  await h.send({ action: 'attach', command_id: 'attach-load', local_id: id, attachment_id: 'att_one', replay_bytes: 0 });
  for (let i = 0; i < 1000; i++) h.events.emit('output', session, '🦊');
  for (let i = 0; i < 60; i++) h.tick(100);
  const outputs = ws.sent.filter(f => f.type === 'output');
  assert.equal(outputs.map(f => f.data).join(''), '🦊'.repeat(1000));
  assert.ok(outputs.length < 10);
  for (const frame of outputs) assert.ok(Buffer.byteLength(frame.data) <= 3000);
  for (const frame of ws.sent) {
    const window = ws.sent.filter(f => f.at >= frame.at && f.at < frame.at + 1000);
    assert.ok(window.length <= 20);
    assert.ok(window.reduce((bytes, f) => bytes + (f.type === 'output' ? Buffer.byteLength(f.data) : 0), 0) <= 4000);
  }
});

test('start receipts survive reconnect; reused ids refuse different work', async t => {
  const h = harness(t); let ws = h.ready();
  const command = { action: 'start', command_id: 'start-0001', project_id: 2, task_key: 'TPT1', agent: 'codex' };
  await h.send(command);
  ws.close(1011); h.tick(1000); ws = h.ready();
  await h.send(command);
  assert.equal(h.commands.filter(f => f.action === 'start').length, 1);
  await h.send({ ...command, task_key: 'TPT2' });
  assert.equal(ws.sent.at(-1).code, 'command_id_reused');
});

test('4409 and 4403 never reconnect; 4401 renews credentials first', async t => {
  const h = harness(t); let ws = h.ready();
  ws.close(4409); h.tick(120000); assert.equal(h.sockets.length, 1);
  h.relay.close();
  t.mock.timers.reset();
  const other = harness(t); ws = other.ready(); ws.close(4403); other.tick(120000); assert.equal(other.sockets.length, 1);
  other.relay.close();
  t.mock.timers.reset();
  const renewal = harness(t); ws = renewal.ready(); ws.close(4401); await settle();
  assert.equal(renewal.refreshes.length, 1); renewal.tick(1000); assert.equal(renewal.sockets.length, 2);
});

test('project revocation, account switch and opt-out drop streams without stopping execution', async t => {
  const h = harness(t); const session = h.session(); const ws = h.ready(); const id = runId(session);
  await h.send({ action: 'attach', command_id: 'attach-revoke', local_id: id, attachment_id: 'att_one', replay_bytes: 0 });
  ws.receive({ type: 'projects', project_ids: [] });
  const before = ws.sent.length;
  h.events.emit('output', session, 'secret');
  await h.send({ action: 'input', local_id: id, attachment_id: 'att_one', seq: 1, data: 'bad' });
  assert.equal(ws.sent.length, before); assert.equal(session.alive, true);
  h.credentials.token = token(2); h.relay.sync();
  assert.equal(ws.readyState, 3); assert.equal(h.sockets.length, 2);
  const switched = h.ready();
  assert.deepEqual(switched.sent[0].sessions, [], 'a new account cannot see an old account terminal');
  h.project.enabled = false; h.relay.sync(); assert.equal(h.sockets.at(-1).readyState, 3);
  assert.equal(session.alive, true);
  h.relay.close(); assert.equal(h.events.listenerCount('output'), 0);
});

test('stream_stop cancels queued replay and live output; disconnect requires fresh attach', async t => {
  const h = harness(t); const session = h.session(); let ws = h.ready(); const id = runId(session);
  await h.send({ action: 'attach', command_id: 'attach-stream', local_id: id, attachment_id: 'att_one', replay_bytes: 0 });
  h.events.emit('output', session, 'queued'); ws.receive({ type: 'stream_stop', local_id: id }); h.tick(20);
  assert.equal(ws.sent.filter(f => f.type === 'output').length, 0);
  ws.close(1006); h.tick(1000); ws = h.ready();
  h.events.emit('output', session, 'not attached'); h.tick(20);
  assert.equal(ws.sent.filter(f => f.type === 'output').length, 0);
  await h.send({ action: 'attach', command_id: 'attach-stream', local_id: id, attachment_id: 'att_one', replay_bytes: 0 });
  h.events.emit('output', session, 'attached again'); h.tick(20);
  assert.ok(ws.sent.some(f => f.type === 'output'));
});

test('UTF-8 tail never starts inside a multibyte character', () => {
  assert.equal(utf8Tail('A🦊B', 4), 'B');
  assert.equal(utf8Tail('A🦊B', 5), '🦊B');
});

test('bounded output backpressure reconnects for replay and never stops the terminal', async t => {
  const h = harness(t); const session = h.session(); const ws = h.ready();
  await h.send({ action: 'attach', command_id: 'attach-pressure', local_id: runId(session), attachment_id: 'att_one', replay_bytes: 0 });
  ws.bufferedAmount = 300000;
  for (let i = 0; i < 100; i++) h.events.emit('output', session, 'x'.repeat(30000));
  assert.equal(ws.readyState, 3);
  assert.equal(session.alive, true);
  h.tick(1000); const next = h.ready();
  assert.equal(next.sent[0].sessions.length, 1);
  h.events.emit('output', session, 'requires fresh attachment'); h.tick(20);
  assert.equal(next.sent.filter(f => f.type === 'output').length, 0);
});

test('a settings poll preserves queued final output and exit after the process ends', async t => {
  const h = harness(t); const session = h.session(); const ws = h.ready();
  await h.send({ action: 'attach', command_id: 'attach-final', local_id: runId(session), attachment_id: 'att_one', replay_bytes: 0 });
  h.events.emit('output', session, 'final output');
  session.alive = false; h.events.emit('state', session, 'exited');
  h.sessions.clear(); h.relay.sync(); h.tick(20);
  assert.equal(ws.sent.filter(f => f.type === 'output').at(-1).data, 'final output');
  assert.equal(ws.sent.filter(f => f.type === 'session').at(-1).state, 'exited');
});

// (TPT9217) A proxy that strips the Upgrade header answers every retry with plain HTTP. The
// reason is logged once per distinct answer, without credentials, and retries continue.
test('an HTTP answer to the upgrade is logged once per status, names a stripped upgrade, and keeps retrying', async t => {
  const lines = [];
  const h = harness(t, { log: { warn: line => lines.push(line) } });
  const refuse = (status, ws = h.sockets.at(-1)) => ws.emit('unexpected-response', {}, { statusCode: status, resume() {} });
  refuse(200);
  h.tick(2000); refuse(200);
  assert.equal(h.sockets.length, 2, 'a 2xx answer retries');
  assert.equal(lines.length, 1, 'the same answer is not logged again');
  assert.match(lines[0], /^\[device-relay\] https:\/\/example\.test refused the relay connection \(HTTP 200\): .*reverse proxy.*not forwarding WebSocket upgrades/);
  h.tick(4000); refuse(426);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /HTTP 426\): .*not forwarding WebSocket upgrades/);
  h.tick(8000); h.ready();
  refuse(426, h.sockets.at(-1)); // a later outage after a working connection is news again
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => !line.includes(h.credentials.token) && !line.includes('device_id')));
  h.tick(16000); refuse(403);
  assert.match(lines.at(-1), /HTTP 403\): .*stays off until Task App restarts/);
  const sockets = h.sockets.length;
  h.tick(120000);
  assert.equal(h.sockets.length, sockets, 'a 403 never retries');
});

test('A3: changing account before enqueue or a scheduled flush sends no old output or control state', async t => {
  const h = harness(t); const session = h.session(); const ws = h.ready(undefined, {}, true);
  await h.send({ action: 'attach', command_id: 'attach-account', local_id: runId(session), attachment_id: 'att_a', replay_bytes: 0 });
  h.events.emit('output', session, 'buffered-account-a');
  const before = ws.sent.length;
  h.credentials.token = token(2);
  h.tick(20); // Old scheduled flush, before any sync or poll.
  h.events.emit('output', session, 'late-account-a');
  h.events.emit('state', session, 'running'); h.events.emit('approval', session); h.events.emit('local', session);
  h.tick(20);
  assert.equal(ws.sent.length, before);
  assert.equal(ws.readyState, 3);
  assert.equal(session.alive, true);
  h.relay.sync();
  const next = h.ready();
  assert.deepEqual(next.sent.find(f => f.type === 'hello').sessions, []);
  await h.send({ action: 'attach', command_id: 'attach-account', local_id: runId(session), attachment_id: 'att_a', replay_bytes: 1000 });
  assert.equal(next.sent.at(-1).code, 'session_not_found');
  assert.equal(next.sent.some(f => f.type === 'output'), false);
});

test('rotation while connecting closes the old handshake and ignores its late ready/open/close callbacks', t => {
  let notify;
  const h = harness(t, { subscribeAccountChanges: callback => { notify = callback; return () => {}; } });
  h.session(); const old = h.sockets[0];
  h.credentials.token = token(1).replace('signature', 'renewed');
  notify();
  assert.equal(old.readyState, 3, 'connecting socket must be invalidated synchronously');
  old.emit('open'); h.ready(old); old.emit('close', 4403);
  assert.equal(old.sent.length, 0);
  h.tick(2000); const next = h.ready();
  assert.notEqual(next, old);
  assert.equal(next.opts.headers.Authorization, `Bearer ${h.credentials.token}`);
  assert.equal(next.sent.find(f => f.type === 'hello').sessions.length, 1);
});

test('late attachment and command completions cannot restore an old credential generation', async t => {
  let delayed; let finish;
  const h = harness(t, { handleCommand: (_frame, ctx) => {
    delayed = ctx; return new Promise(resolve => { finish = resolve; });
  } });
  const session = h.session(); const ws = h.ready();
  await h.send({ action: 'attach', command_id: 'delayed-attach', local_id: runId(session), attachment_id: 'att_a', replay_bytes: 1000 });
  h.credentials.token = token(2); h.relay.sync();
  const before = ws.sent.length;
  assert.equal(delayed.isCurrent(), false);
  assert.equal(delayed.attach().ok, false);
  finish({ ok: true }); await settle(); h.tick(20);
  assert.equal(ws.sent.length, before);
  assert.equal(session.alive, true);
});
