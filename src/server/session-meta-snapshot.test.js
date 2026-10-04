'use strict';

// (TPT413) GET /api/sessions `sessionMeta[id].agent` must be read LIVE off the session object
// on every request — never a cached launch value. A task "restarted" under a different agent
// is a fresh session object, but the same object's taskAgent is also rewritten in place: at
// connect by the validated WS ?agent= param and again by spawnTerminal() after pty.spawn. The
// left-nav row icon (task-board.js syncActiveSessionsNav()) is painted from this field, so a
// stale value here is exactly the "icon shows the wrong agent" bug. Real HTTP parser, seeded
// sessions Map; no Task App port, API, or DB.
process.env.TASK_BACKEND = 'api';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-session-meta-'));
process.env.TIPATASK_PROJECT_ROOT = scratch;
process.env.TIPATASK_USER_DATA = scratch;
const { createHttpHandler, sessionMetaRow } = require('./ws-handlers');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function fakeSession(overrides = {}) {
  return {
    tabId: 'TPT1', type: 'terminal', alive: true, pending: false, _starting: false, projectPath: '',
    taskAgent: 'claude', taskAgentLabel: 'Claude Code', buffer: '',
    _attentionBroadcasted: false, _attentionLastBroadcast: null,
    ...overrides,
  };
}

function getJson(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: route, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

test('sessionMetaRow includes the current paused summary for reconnecting clients', () => {
  assert.equal(sessionMetaRow(fakeSession({ startedAt: 1790780000000 })).startedAt, 1790780000000);
  assert.deepEqual(sessionMetaRow(fakeSession()), { agent: 'claude', label: 'Claude Code', type: 'terminal', alive: true, paused: null });
  assert.deepEqual(sessionMetaRow({ tabId: 'X' }), { agent: null, label: '', type: 'terminal', alive: false, paused: null });
  const paused = sessionMetaRow(fakeSession({ _pause: { at: 123, reason: 'memory', count: 35, threshold: 50, rssMb: 6400, limitMb: 3072 } }));
  assert.deepEqual(paused.paused, { at: 123, reason: 'memory', count: 35, threshold: 50, rssMb: 6400, limitMb: 3072 });
});

test('session creation, terminal-state replies and snapshots share one stable start timestamp', () => {
  const frames = [];
  const ws = { OPEN: 1, readyState: 1, send: raw => frames.push(JSON.parse(raw)) };
  const before = Date.now();
  const s = require('./session-state').createSession(ws, false, 'TPT415', scratch);
  assert.ok(s.startedAt >= before && s.startedAt <= Date.now());
  const { emitTerminalState } = require('./terminal-session');
  emitTerminalState(s);
  emitTerminalState(s);
  assert.equal(frames[0].startedAt, s.startedAt);
  assert.equal(frames[1].startedAt, s.startedAt);
  assert.equal(sessionMetaRow(s).startedAt, s.startedAt);
});

test('GET /api/sessions reports the live session agent — a rewritten taskAgent shows on the next request', async () => {
  const sessions = new Map();
  const s = fakeSession({ startedAt: 1790780000000 });
  sessions.set('TPT1', s);
  const server = http.createServer(createHttpHandler(sessions, () => ({})));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    let r = await getJson(port, '/api/sessions');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.sessions, ['TPT1']);
    assert.equal(r.json.sessionMeta.TPT1.agent, 'claude');
    assert.equal(r.json.sessionMeta.TPT1.label, 'Claude Code');
    assert.equal(r.json.sessionMeta.TPT1.startedAt, s.startedAt);

    // The in-place rewrite handleConnection()/spawnTerminal() perform on a restart under
    // another agent — the snapshot must follow it, not remember the first spawn.
    s.taskAgent = 'codex';
    s.taskAgentLabel = 'Codex';
    r = await getJson(port, '/api/sessions');
    assert.equal(r.json.sessionMeta.TPT1.agent, 'codex');
    assert.equal(r.json.sessionMeta.TPT1.label, 'Codex');

    // A _starting (mid-spawn) session is listed as active and already names the chosen agent.
    sessions.set('TPT2', fakeSession({ tabId: 'TPT2', alive: false, _starting: true, taskAgent: 'pi', taskAgentLabel: 'Pi Coding Agent' }));
    r = await getJson(port, '/api/sessions');
    assert.deepEqual(r.json.sessions.sort(), ['TPT1', 'TPT2']);
    assert.deepEqual(r.json.sessionMeta.TPT2, { agent: 'pi', label: 'Pi Coding Agent', type: 'terminal', alive: false, paused: null });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('handleConnection: a validated ?agent= override moves label and approval command with the id; a reattach ignores it', () => {
  const src = fs.readFileSync(path.join(__dirname, 'ws-handlers.js'), 'utf8');
  const start = src.indexOf('async function handleConnection(');
  assert.ok(start > -1);
  const body = src.slice(start, src.indexOf('\nfunction wireClient(', start));
  assert.match(body, /const _chosen = getTaskAgentInfo\(agentParam\);\s*session\.taskAgent = _chosen\.id;\s*session\.taskAgentLabel = _chosen\.label;\s*session\.planApprovalCommand = _chosen\.approvalCommand;/);
  const reattach = body.slice(body.indexOf('// ── Reconnect to existing non-objective session'), body.indexOf('// ── Reconnect to objective session'));
  assert.match(reattach, /agentParam && agentParam !== existing\.taskAgent/);
  assert.match(reattach, /ignored on reattach/);
  assert.doesNotMatch(reattach, /existing\.taskAgent = /, 'a reattach must never rewrite the running session agent');
});

test('GET /api/sessions restores project-scoped losses from disk after registry restart', async t => {
  const { writeLastExit, forgetLostSession } = require('./last-exit');
  const oldSessions = new Map([
    ['T1', fakeSession({ tabId: 'T1', projectPath: scratch, startedAt: Date.now() - 1000 })],
    ['T2', fakeSession({ tabId: 'T2', projectPath: scratch, alive: false, _starting: true })],
    ['other', fakeSession({ tabId: 'T1', projectPath: '/other-project', taskAgent: 'codex' })],
    ['dead', fakeSession({ tabId: 'DEAD', projectPath: scratch, alive: false })],
    ['chat', fakeSession({ tabId: 'obj-1', projectPath: scratch, type: 'objective' })],
  ]);
  writeLastExit({ reason: 'signal:SIGTERM', stack: 'private stack', sessions: oldSessions, root: scratch });
  t.after(() => fs.rmSync(path.join(scratch, 'last-exit.json'), { force: true }));
  // A fresh handler and empty registry stand in for the restarted server.
  const sessions = new Map();
  const server = http.createServer(createHttpHandler(sessions, () => ({})));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    let r = await getJson(port, '/api/sessions');
    assert.deepEqual(r.json.lost, ['T1', 'T2']);
    assert.deepEqual(r.json.sessions, []);
    assert.equal(r.json.lostDetails.T1.reason, 'signal:SIGTERM');
    assert.ok(Number.isFinite(Date.parse(r.json.lostDetails.T1.at)));
    assert.equal(r.json.sessionMeta.T1.agent, 'claude');
    assert.equal(r.json.sessionMeta.T1.alive, false);
    assert.equal(JSON.stringify(r.json).includes('private stack'), false);
    const other = await getJson(port, '/api/sessions', { 'x-tipatask-project': '/other-project' });
    assert.deepEqual(other.json.lost, ['T1']);
    assert.equal(other.json.sessionMeta.T1.agent, 'codex', 'same key in another project stays isolated');
    sessions.set('T1', fakeSession({ tabId: 'T1', projectPath: scratch, _starting: true, alive: false }));
    r = await getJson(port, '/api/sessions');
    assert.deepEqual(r.json.sessions, ['T1']);
    assert.deepEqual(r.json.lost, ['T2']);
    forgetLostSession('T1', scratch, scratch);
    sessions.clear();
    r = await getJson(port, '/api/sessions');
    assert.deepEqual(r.json.lost, ['T2'], 'recovered record stays retired after registry pruning');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('HTTP inventory and queue WS frames preserve diagnostics and detail-only updates', async () => {
  const { sessionQueue, queuedSessionFrame } = require('./ws-handlers');
  const websocket = require('./websocket');
  const frames = [], broadcasts = [];
  const ws = { OPEN: 1, readyState: 1, send: raw => frames.push(JSON.parse(raw)) };
  const s = fakeSession({ tabId: 'QUEUE', taskId: 'QUEUE', alive: false, projectPath: scratch, ws });
  const key = `QUEUE\0${scratch}`;
  const sessions = new Map([[key, s]]);
  let diagnostic = { allowed: false, reason: 'coordination', coordinationReason: 'unregistered-server',
    detail: null, instances: 1, censusPidCount: 2, unregisteredCount: 1, unregisteredPids: [9999] };
  const server = http.createServer(createHttpHandler(sessions, () => ({})));
  websocket.init({ clients: new Set([{ readyState: 1, _projectPath: scratch,
    send: raw => broadcasts.push(JSON.parse(raw)) }]) });
  sessionQueue.setAdmission({ tryReserve: () => diagnostic, snapshot: () => diagnostic });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    sessionQueue.submit({ key, session: s, taskId: 'QUEUE', start: () => assert.fail('must stay queued') });
    for (const next of [diagnostic, { ...diagnostic, coordinationReason: null, detail: 'lock-busy',
      instances: null, unregisteredCount: null, unregisteredPids: null },
    { ...diagnostic, coordinationReason: null, detail: 'state-invalid', instances: null,
      unregisteredCount: null, unregisteredPids: null }]) {
      diagnostic = next;
      sessionQueue.drain();
      const response = await getJson(server.address().port, '/api/sessions', { 'x-tipatask-project': scratch });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json.admission, diagnostic);
      const snapshot = sessionQueue.snapshot(scratch);
      assert.deepEqual(response.json.queued, snapshot.queued);
      assert.deepEqual(broadcasts.at(-1).queued, snapshot.queued);
      assert.deepEqual(frames.at(-1), queuedSessionFrame(s, 'QUEUE', snapshot));
      for (const field of ['coordinationReason', 'detail', 'instances', 'censusPidCount', 'unregisteredCount', 'unregisteredPids']) {
        assert.deepEqual(frames.at(-1)[field], diagnostic[field], field);
      }
    }
  } finally {
    sessionQueue.remove(key); sessionQueue.setAdmission(null); websocket.init(null);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
