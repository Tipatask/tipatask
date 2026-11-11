'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { WebSocketServer } = require('ws');
const { createRemoteControlConsent } = require('./remote-control-consent');
const { saveAccountForServer, readAccount } = require('./account-store');
const { connectDeviceRelay, captureSessionOwner, runId } = require('./device-relay');

const waitFor = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for isolated relay');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test('real HTTP/WS: copied flags and browser writes cannot opt in; disable drops queued authority without stopping local execution', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-consent-sockets-'));
  const project = path.join(root, 'project'); const userDataRoot = path.join(root, 'data');
  fs.mkdirSync(path.join(project, '.tipatask'), { recursive: true }); fs.mkdirSync(userDataRoot);
  const machineIdPath = path.join(root, 'machine'); fs.writeFileSync(machineIdPath, 'synthetic-machine');
  const previousEnv = { TIPATASK_USER_DATA: process.env.TIPATASK_USER_DATA, TIPATASK_PROJECT_ROOT: process.env.TIPATASK_PROJECT_ROOT };
  process.env.TIPATASK_USER_DATA = userDataRoot; process.env.TIPATASK_PROJECT_ROOT = project;
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const handler = require('./ws-handlers').createHttpHandler(new Map(), () => ({}), {});
  const server = http.createServer(handler);
  const wss = new WebSocketServer({ server });
  const sockets = []; const frames = [];
  const limits = { max_device_frame_bytes: 262144, max_output_data_bytes: 32768,
    max_replay_bytes: 262144, max_sessions: 64, frames_per_second: 200, output_bytes_per_second: 1048576 };
  wss.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', data => {
      const frame = JSON.parse(data); frames.push(frame);
      if (frame.type === 'authorize_start') socket.send(JSON.stringify({ type: 'start_authorization', command_id: frame.command_id, allowed: true }));
    });
    socket.send(JSON.stringify({ type: 'ready', protocol: 1, project_ids: [2], expiry_ms: 180000,
      limits, start_authorization: true, approval_controls: true }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = 'synthetic.' + Buffer.from(JSON.stringify({ id: 1, exp: 4000000000 })).toString('base64url') + '.signature';
  saveAccountForServer(base, { token }, { userDataRoot });
  fs.writeFileSync(path.join(project, '.tipatask/config.json'), JSON.stringify({ API_BASE_URL: base, API_PROJECT_ID: '2', REMOTE_CONTROL_ENABLED: true }));
  const consent = createRemoteControlConsent({ userDataRoot, machineIdPath });
  const backend = { getCredentials: () => ({ baseUrl: base, projectId: '2', token: readAccount(base, { userDataRoot }).token }) };
  const session = { type: 'terminal', taskId: 'TEST1', taskAgent: 'codex', projectPath: project, alive: true, buffer: 'local-only-history', pty: {} };
  captureSessionOwner(session, backend);
  const events = new EventEmitter(); let queued; let cancelled = 0; let input = 0; let spawned = 0;
  const relay = connectDeviceRelay({ getProjects: () => {
    const state = consent.read(project);
    return [{ projectPath: project, enabled: state.enabled, consentGrant: state.grant, deviceId: 7, backend }];
  }, getSessions: () => new Map([['TEST1', session]]), events, pollMs: 60000,
  handleCommand: async (command, context) => {
    if (command.action === 'attach') return context.attach();
    if (command.action === 'start') { queued = context; context.onCancel(() => cancelled++); return { ok: true, code: 'queued' }; }
    if (command.action === 'input') input++;
    return { ok: true };
  } });
  t.after(async () => { relay.close(); for (const socket of wss.clients) socket.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); });
  assert.equal(sockets.length, 0);
  const refused = await fetch(base + '/api/project-config', { method: 'POST', headers: { 'x-tipatask-project': project, 'Content-Type': 'application/json' }, body: JSON.stringify({ REMOTE_CONTROL_ENABLED: true }) });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /local desktop consent/);
  const state = await (await fetch(base + '/api/project-config', { headers: { 'x-tipatask-project': project } })).json();
  assert.equal(state.remoteControl.available, false);
  assert.equal(state.remoteControl.enabled, false);
  assert.equal(consent.read(project).enabled, false);
  consent.write(project, true, consent.read(project).context); relay.sync();
  await waitFor(() => frames.some(f => f.type === 'hello'));
  const send = frame => sockets.at(-1).send(JSON.stringify({ type: 'command', ...frame }));
  send({ action: 'attach', command_id: 'attach-test-1', local_id: runId(session), attachment_id: 'att_test', replay_bytes: 0 });
  await waitFor(() => frames.some(f => f.command_id === 'attach-test-1' && f.ok));
  send({ action: 'start', command_id: 'start-test-1', project_id: 2, task_key: 'TEST2' });
  await waitFor(() => queued);
  const consume = await queued.authorizeStart();
  events.emit('output', session, 'must-never-cross-opt-out');
  // Simulates another window/process saving before either IPC or polling runs.
  consent.write(project, false, consent.read(project).context);
  assert.throws(() => { consume(); spawned++; }, { code: 'EAUTH' });
  assert.equal(queued.isCurrent(), false);
  await waitFor(() => sockets[0].readyState === 3);
  assert.equal(frames.some(f => f.data?.includes('must-never-cross-opt-out')), false);
  assert.equal(cancelled, 1); assert.equal(spawned, 0); assert.equal(input, 0);
  assert.equal(session.alive, true, 'opt-out leaves the local agent running');
  consent.write(project, true, consent.read(project).context); relay.sync();
  await waitFor(() => frames.filter(f => f.type === 'hello').length === 2);
  assert.equal(queued.isCurrent(), false, 'fresh grant cannot revive an old pending start');
  events.emit('output', session, 'needs-fresh-attachment');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(frames.some(f => f.data?.includes('needs-fresh-attachment')), false);
  assert.equal(session.alive, true);
});
