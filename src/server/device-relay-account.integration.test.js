'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { WebSocketServer } = require('ws');
const accounts = require('./account-store');
const { getApiCredentials } = require('./api-credentials');
const { writeProjectConfig } = require('./project-config');
const { createRemoteControlConsent } = require('./remote-control-consent');
const { connectDeviceRelay, captureSessionOwner, runId } = require('./device-relay');

const token = (id, revision = 1) => `synthetic.${Buffer.from(JSON.stringify({ id, revision, exp: 4000000000 })).toString('base64url')}.signature`;
// The relay learns of a consent change from a real directory watcher, and macOS can drop a watcher
// event on a busy disk: it is then never delivered, however long the wait. A wait that is not over
// after a moment therefore touches the consent records again. Another event on that directory
// makes the watcher fire again, and the relay's sync is driven by state, so the repeat changes
// nothing once the first event was handled. The cap only ends a run that is really stuck.
let consentDir = null;
function nudgeConsentWatch() {
  if (!consentDir) return;
  const now = new Date();
  try {
    for (const name of fs.readdirSync(consentDir)) fs.utimesSync(path.join(consentDir, name), now, now);
  } catch { /* a write is replacing a record at this moment; the next nudge sees it */ }
}
const waitFor = async predicate => {
  const end = Date.now() + 20000;
  let nudgeAt = Date.now() + 250;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'isolated relay condition timed out');
    if (Date.now() >= nudgeAt) { nudgeConsentWatch(); nudgeAt = Date.now() + 250; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const limits = { max_device_frame_bytes: 262144, max_output_data_bytes: 32768,
  max_replay_bytes: 262144, max_sessions: 64, frames_per_second: 200, output_bytes_per_second: 1048576 };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-relay-accounts-'));
  const prior = process.env.TIPATASK_USER_DATA;
  process.env.TIPATASK_USER_DATA = root;
  const machineIdPath = path.join(root, 'machine'); fs.writeFileSync(machineIdPath, 'isolated-device');
  const consent = createRemoteControlConsent({ userDataRoot: root, machineIdPath });
  consentDir = path.join(root, 'remote-control');
  const servers = []; const projects = []; const sessions = new Map(); const events = new EventEmitter();
  const held = []; let hold = false; let queued; let delayed; let finish; let cancelled = 0;
  let relay; let stopConsentWatch;
  t.after(async () => {
    consentDir = null;
    relay?.close();
    stopConsentWatch?.();
    for (const { server, wss } of servers) {
      for (const ws of wss.clients) ws.terminate();
      wss.close(); await new Promise(resolve => server.close(resolve));
    }
    if (prior === undefined) delete process.env.TIPATASK_USER_DATA; else process.env.TIPATASK_USER_DATA = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 2; i++) {
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ server }); const connections = [];
    wss.on('connection', (ws, request) => {
      const row = { ws, frames: [], token: request.headers.authorization.slice(7),
        instanceId: new URL(request.url, 'http://localhost').searchParams.get('instance_id') }; connections.push(row);
      ws.on('message', data => row.frames.push(JSON.parse(data)));
      ws.send(JSON.stringify({ type: 'ready', protocol: 1, project_ids: [2, 3], limits,
        start_authorization: true, approval_controls: true, expiry_ms: 180000 }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    accounts.writeAccountToken(baseUrl, token(1));
    servers.push({ server, wss, connections, baseUrl });
    for (const projectId of i ? [2] : [2, 3]) {
      const projectPath = path.join(root, `server-${i}-project-${projectId}`);
      const config = { API_BASE_URL: baseUrl, API_PROJECT_ID: String(projectId) };
      writeProjectConfig(projectPath, config);
      consent.write(projectPath, true, consent.read(projectPath).context);
      const backend = { getCredentials: () => getApiCredentials(projectPath) };
      const project = { projectPath, config, backend, deviceId: 7 };
      projects.push(project);
      const session = { type: 'terminal', projectPath, taskId: `TEST${i}${projectId}`, alive: true,
        taskAgent: 'codex', buffer: `private-history-${i}-${projectId}`, pty: { alive: true }, ws: null };
      captureSessionOwner(session, backend); sessions.set(session.taskId, session);
    }
  }
  relay = connectDeviceRelay({ getProjects: () => projects.map(project => {
    const state = consent.read(project.projectPath);
    return { ...project, enabled: state.enabled, consentGrant: state.grant };
  }), getSessions: () => sessions, events, pollMs: 60000, random: () => 0,
  setTimer: (callback, ms) => {
    if (hold && ms === 10) { const timer = { callback, unref() {} }; held.push(timer); return timer; }
    return setTimeout(callback, ms);
  }, clearTimer: timer => { if (!timer?.callback) clearTimeout(timer); },
  handleCommand: async (command, context) => {
    if (command.action === 'attach') return context.attach();
    if (command.action === 'start') { queued = context; context.onCancel(() => cancelled++); return { ok: true, code: 'queued' }; }
    if (command.action === 'stop') { delayed = context; return new Promise(resolve => { finish = resolve; }); }
    return { ok: true };
  } });
  stopConsentWatch = consent.watch(() => relay.sync());
  await waitFor(() => servers.every(s => s.connections[0]?.frames.some(f => f.type === 'hello')));
  const send = (row, command) => row.ws.send(JSON.stringify({ type: 'command', ...command }));
  const attach = async (row, session, id) => {
    send(row, { action: 'attach', command_id: `attach-${id}`, local_id: runId(session), attachment_id: `att_${id}`, replay_bytes: 0 });
    await waitFor(() => row.frames.some(f => f.command_id === `attach-${id}` && f.ok));
  };
  return { servers, projects, sessions: [...sessions.values()], events, consent, send, attach,
    hold: () => { hold = true; }, flushLate: () => { hold = false; held.splice(0).forEach(timer => timer.callback()); },
    get queued() { return queued; }, get cancelled() { return cancelled; }, get delayed() { return delayed; },
    finish: () => finish({ ok: true }),
  };
}

test('real sockets: account swap withdraws all projects on that server before poll; new account cannot discover, attach or replay old runs', async t => {
  const h = await fixture(t); const [server, other] = h.servers;
  const row = server.connections[0]; const unaffected = other.connections[0];
  for (const [i, session] of h.sessions.entries()) await h.attach(i < 2 ? row : unaffected, session, `initial${i}`);
  h.send(row, { action: 'start', command_id: 'queued-old-account', project_id: 2, task_key: 'NEW1' });
  await waitFor(() => h.queued);
  h.send(row, { action: 'stop', command_id: 'delayed-old-stop', local_id: runId(h.sessions[0]) });
  await waitFor(() => h.delayed);
  const owners = h.sessions.map(s => s._relayOwner);
  h.hold();
  h.events.emit('output', h.sessions[0], 'never-send-buffered-account-a');
  h.events.emit('approval', h.sessions[0]);
  // Same persisted writer used by the UI account switch; no sync/config/poll call.
  accounts.saveAccountForServer(server.baseUrl, { token: token(2), userId: 2 });
  assert.equal(h.cancelled, 1, 'synchronous store signal cancels pending work');
  assert.equal(h.queued.isCurrent(), false); assert.equal(h.delayed.isCurrent(), false);
  h.finish(); h.flushLate();
  await waitFor(() => row.ws.readyState === 3);
  const after = row.frames.length;
  h.events.emit('output', h.sessions[0], 'never-send-late-account-a');
  h.events.emit('state', h.sessions[1], 'running');
  h.events.emit('local', h.sessions[0]);
  assert.equal(h.consent.read(h.projects[0].projectPath).enabled, false);
  assert.equal(h.consent.read(h.projects[1].projectPath).enabled, false);
  h.events.emit('output', h.sessions[2], 'unrelated-server-still-streams');
  await waitFor(() => unaffected.frames.some(f => f.data === 'unrelated-server-still-streams'));
  assert.equal(other.connections.length, 1);
  assert.equal(row.frames.length, after);
  assert.equal(row.frames.some(f => f.data?.includes('never-send')), false);
  assert.equal(row.frames.some(f => f.command_id === 'delayed-old-stop'), false);
  for (const project of h.projects.slice(0, 2)) h.consent.write(project.projectPath, true, h.consent.read(project.projectPath).context);
  h.events.emit('config'); // Explicit new-account local consent, never automatic inheritance.
  await waitFor(() => server.connections[1]?.frames.some(f => f.type === 'hello'));
  const next = server.connections[1];
  assert.deepEqual(next.frames.find(f => f.type === 'hello').sessions, []);
  h.send(next, { action: 'attach', command_id: 'attach-initial0', local_id: runId(h.sessions[0]), attachment_id: 'att_initial0', replay_bytes: 1000 });
  await waitFor(() => next.frames.some(f => f.command_id === 'attach-initial0'));
  assert.equal(next.frames.find(f => f.command_id === 'attach-initial0').code, 'session_not_found');
  assert.equal(next.frames.some(f => f.type === 'output'), false);
  assert.deepEqual(h.sessions.map(s => s._relayOwner), owners);
  assert.ok(h.sessions.every(s => s.alive && s.pty.alive));
});

for (const transition of ['renewal', 'sign-out', 'file-removal', 'opt-out']) {
  test(`real sockets: buffered output across ${transition}, unaffected server and live local terminals`, async t => {
    const h = await fixture(t); const [server, other] = h.servers;
    const row = server.connections[0]; const session = h.sessions[0];
    await h.attach(row, session, 'transition');
    const grant = h.consent.read(h.projects[0].projectPath).grant;
    h.hold(); h.events.emit('output', session, `buffered-${transition}`);
    if (transition === 'renewal') accounts.writeAccountToken(server.baseUrl, token(1, 2));
    if (transition === 'sign-out') writeProjectConfig(h.projects[0].projectPath, { ...h.projects[0].config, API_TOKEN: '' });
    if (transition === 'file-removal') fs.unlinkSync(accounts.accountStorePath());
    if (transition === 'opt-out') {
      h.consent.write(h.projects[0].projectPath, false, h.consent.read(h.projects[0].projectPath).context);
      h.events.emit('config');
    }
    h.flushLate(); // Force a callback scheduled under old credentials, even if canceled.
    await waitFor(() => row.ws.readyState === 3);
    assert.equal(row.frames.some(f => f.data === `buffered-${transition}`), false);
    assert.ok(h.sessions.every(s => s.alive && s.pty.alive));
    if (transition === 'file-removal') await waitFor(() => other.connections[0].ws.readyState === 3);
    else assert.equal(other.connections[0].ws.readyState, 1);
    if (transition === 'renewal') {
      assert.equal(h.consent.read(h.projects[0].projectPath).grant, grant);
      await waitFor(() => server.connections[1]?.frames.some(f => f.type === 'hello'));
      const next = server.connections[1];
      assert.equal(next.token, token(1, 2));
      assert.equal(next.frames.find(f => f.type === 'hello').sessions.length, 2);
      assert.deepEqual(next.frames.find(f => f.type === 'hello').project_ids, [2, 3]);
      assert.equal(next.instanceId, row.instanceId);
      h.events.emit('output', session, 'no-inherited-attachment');
      await h.attach(next, session, 'renewed');
      h.events.emit('output', session, 'fresh-attachment-streams');
      await waitFor(() => next.frames.some(f => f.data === 'fresh-attachment-streams'));
      assert.equal(next.frames.some(f => f.data === 'no-inherited-attachment'), false);
    }
  });
}

test('real consent watcher re-announces the remaining and re-enabled projects without polling', async t => {
  const h = await fixture(t);
  const server = h.servers[0];
  const project = h.projects[1];
  const initialId = server.connections[0].instanceId;
  assert.deepEqual(server.connections[0].frames.find(f => f.type === 'hello').project_ids, [2, 3]);
  h.consent.write(project.projectPath, false, h.consent.read(project.projectPath).context);
  await waitFor(() => server.connections[1]?.frames.some(f => f.type === 'hello'));
  assert.deepEqual(server.connections[1].frames.find(f => f.type === 'hello').project_ids, [2]);
  h.consent.write(project.projectPath, true, h.consent.read(project.projectPath).context);
  await waitFor(() => server.connections[2]?.frames.some(f => f.type === 'hello'));
  assert.deepEqual(server.connections[2].frames.find(f => f.type === 'hello').project_ids, [2, 3]);
  assert.equal(server.connections[2].instanceId, initialId);
  assert.equal(h.servers[1].connections.length, 1);
});
