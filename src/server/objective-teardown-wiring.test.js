'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

// ws-handlers.js wiring that keeps a torn-down objective chat dead (TPT294): dropObjectiveSession
// releases throttle state + the cold spare, _throttledSpawn refuses closed/stale requests, the
// real wireClient message handler answers session-gone, history compression never outlives a
// teardown, reconnect=1 never creates a session, and the cold-prewarm HTTP routes. The real
// ws-handlers.js runs in a vm sandbox — its top-level function declarations (wireClient,
// dropObjectiveSession, …) land on the sandbox global — with claude-session, the throttle, the
// summarizer and provider dispatch replaced by spies.
const SOURCE = path.join(__dirname, 'ws-handlers.js');

function spyModule(calls, prefix, overrides = {}) {
  return new Proxy(overrides, {
    get(target, name) {
      if (Object.hasOwn(target, name)) return target[name];
      if (typeof name !== 'string') return undefined;
      return (...args) => { calls.push([`${prefix}.${name}`, ...args]); };
    },
  });
}

function harness({ summarize } = {}) {
  const calls = [];
  const config = { ...require('./config'), SIMPLE_MODE: false, OBJECTIVE_PROVIDER: 'claude',
    PROJECT_ROOT: '/proj/a', API_PROJECT_ID: null,
    OBJECTIVE_HISTORY_COMPRESS_ENABLED: true, OBJECTIVE_HISTORY_COMPRESS_TAIL_TURNS: 1 };
  const realRequire = createRequire(SOURCE);
  const mocks = {
    './config': config,
    './claude-session': spyModule(calls, 'claude', {
      startSleepWatchdog() {},
      objectiveCacheActivity: () => ({}),
    }),
    './objective-throttle': spyModule(calls, 'throttle', {
      requestTurn: (id, runFn) => { calls.push(['throttle.requestTurn', id]); return { ok: true }; },
      getStatus: () => ({ active: 0, pending: 0 }),
      subscribe() {},
    }),
    './objective-summarizer': {
      summarizeOldTurns: (pairs, opts) => {
        calls.push(['summarize', pairs.length]);
        return summarize ? summarize(pairs, opts) : Promise.resolve([]);
      },
    },
    './context-manager': spyModule(calls, 'ctx'),
    './providers/dispatch': spyModule(calls, 'dispatch', { applyModelSelection: () => ({}) }),
    './providers/registry': spyModule(calls, 'registry', {
      configForProject: () => config,
      listVisibleObjectiveProviders: () => [],
      listObjectiveProviders: () => [],
      currentSelection: () => null,
    }),
    './task-agent': spyModule(calls, 'agent', {
      getTaskAgentInfo: () => ({ id: 'claude', label: 'Claude' }),
      getTaskAgentLabels: () => ({}),
      getAvailableAgentsPeek: () => [],
      listTaskAgentStatusesPeek: () => [],
    }),
    './arch-cache-prewarm': spyModule(calls, 'arch'),
  };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, __dirname, __filename: SOURCE,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
    console: { log() {}, warn() {}, error() {} },
    process, URL, URLSearchParams, Buffer, AbortController, TextEncoder, TextDecoder, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
  };
  vm.runInNewContext(fs.readFileSync(SOURCE, 'utf8'), sandbox, { filename: SOURCE });
  const named = prefix => calls.filter(c => c[0] === prefix);
  return { ctx: sandbox, exports: module.exports, calls, named, config };
}

function fakeWs() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.frames = [];
  ws.closed = false;
  ws.send = raw => ws.frames.push(JSON.parse(raw));
  ws.close = () => { ws.closed = true; ws.readyState = 3; };
  return ws;
}

function objectiveSession(ws, extra = {}) {
  return {
    type: 'objective', tabId: 'obj-t', providerType: 'claude', ws, proc: null,
    messages: [{ role: 'user', content: 'Objective', timestamp: 0 }],
    compressedSummaries: [], compressedThrough: 0, buffer: '',
    _closed: false, _epoch: 0, ...extra,
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const goneFrames = ws => ws.frames.filter(f => f.type === 'objective-error' && f.reason === 'session-gone');

test('dropObjectiveSession tears down, releases the throttle slot and queue, kills the cold spare', () => {
  const h = harness();
  const session = objectiveSession(null);
  const sessions = new Map([['k', session]]);
  h.ctx.dropObjectiveSession(sessions, 'k', session, 'obj-t', 'kill');
  assert.equal(h.named('claude.teardownObjectiveSession').length, 1);
  assert.deepEqual(h.named('throttle.recordAbort').map(c => c[1]), ['obj-t']);
  assert.deepEqual(h.named('claude.killColdPrewarm').map(c => c[1]), ['kill']);
  assert.equal(sessions.has('k'), false);
});

test('dropObjectiveSession never deletes a newer session that reuses the tab key', () => {
  const h = harness();
  const stale = objectiveSession(null);
  const fresh = objectiveSession(null);
  const sessions = new Map([['k', fresh]]);
  h.ctx.dropObjectiveSession(sessions, 'k', stale, 'obj-t', 'ws-close');
  assert.equal(sessions.get('k'), fresh);
});

test('_throttledSpawn refuses a closed session with a session-gone error', () => {
  const h = harness();
  const ws = fakeWs();
  const session = objectiveSession(ws, { _closed: true });
  assert.equal(h.ctx._throttledSpawn('obj-t', session, () => {}, 0), false);
  assert.equal(h.named('throttle.requestTurn').length, 0, 'nothing is queued for a dead chat');
  assert.equal(goneFrames(ws).length, 1);
  assert.equal(goneFrames(ws)[0].tabId, 'obj-t');
});

test('_throttledSpawn drops a request whose epoch went stale during its awaits', () => {
  const h = harness();
  const ws = fakeWs();
  const session = objectiveSession(ws, { _epoch: 3 });
  assert.equal(h.ctx._throttledSpawn('obj-t', session, () => {}, 2), false);
  assert.equal(h.named('throttle.requestTurn').length, 0);
  assert.equal(ws.frames.length, 0, 'a restart owns the chat now — no error frame');
  assert.equal(h.ctx._throttledSpawn('obj-t', session, () => {}, 3), true);
  assert.equal(h.named('throttle.requestTurn').length, 1, 'a current-epoch request is gated as usual');
});

test('start/chat/revise pass the epoch captured at message receipt', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const spawnCalls = src.match(/_throttledSpawn\(taskId, session, \(\) => spawnTurn\(session, taskId\)(, epochAtReceipt)?\);/g) || [];
  // start + chat + revise carry the epoch; restart spawns synchronously right after its own clearContext().
  assert.equal(spawnCalls.filter(c => c.includes('epochAtReceipt')).length, 3);
  assert.match(src, /const epochAtReceipt = session\._epoch \|\| 0;/);
});

for (const type of ['chat', 'revise', 'restart']) {
  test(`wireClient: a ${type} on a closed chat answers session-gone and never re-opens it`, async () => {
    const h = harness();
    const ws = fakeWs();
    const session = objectiveSession(ws, { _closed: true });
    h.ctx.wireClient(ws, session, 'obj-t', 'k', new Map(), null);
    ws.frames.length = 0; // drop the config frame
    ws.emit('message', JSON.stringify({ type, content: 'more', model: 'claude:x' }));
    await flush();
    assert.equal(goneFrames(ws).length, 1);
    assert.equal(h.named('ctx.clearContext').length, 0, 'restart must not resurrect a torn-down chat');
    assert.equal(h.named('throttle.requestTurn').length, 0);
    assert.equal(session._closed, true);
  });
}

function historySession(ws, extra) {
  const messages = [{ role: 'user', content: 'Objective', timestamp: 0 }];
  for (let i = 1; i <= 3; i++) {
    messages.push({ role: 'user', content: `u${i}`, timestamp: i });
    messages.push({ role: 'assistant', content: `a${i}`, timestamp: i });
  }
  return objectiveSession(ws, { messages, ...extra });
}

test('maybeCompressHistory: no Haiku call for a closed chat', async () => {
  const h = harness();
  await h.ctx.maybeCompressHistory(historySession(null, { _closed: true }), 'obj-t');
  assert.equal(h.named('summarize').length, 0);
});

test('maybeCompressHistory registers the Haiku proc as a helper for teardown', async () => {
  const proc = { pid: 1 };
  const h = harness({ summarize: async (pairs, { onSpawn }) => { onSpawn(proc); return [{ turn: 1, summary: 's1' }, { turn: 2, summary: 's2' }]; } });
  const session = historySession(null);
  await h.ctx.maybeCompressHistory(session, 'obj-t');
  const tracked = h.named('claude.trackHelperProc');
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0][1], session);
  assert.equal(tracked[0][2], proc);
  assert.equal(session.compressedThrough, 2, 'a live chat keeps its summaries');
  assert.equal(session.compressedSummaries.length, 2);
});

test('maybeCompressHistory discards summaries that land after a teardown/restart', async () => {
  let session;
  const h = harness({ summarize: async () => {
    session._epoch += 1; // teardown (or restart) while Haiku ran
    return [{ turn: 1, summary: 's1' }, { turn: 2, summary: 's2' }];
  } });
  session = historySession(null);
  await h.ctx.maybeCompressHistory(session, 'obj-t');
  assert.equal(session.compressedThrough, 0);
  assert.equal(session.compressedSummaries.length, 0);
  assert.equal(h.named('dispatch.clearProviderSessionId').length, 0, 'the provider session id is left alone');
  assert.equal(session.pendingCompression, null);
});

test('handleConnection: reconnect=1 with no live session answers session-gone and creates nothing', async () => {
  const h = harness();
  const ws = fakeWs();
  const sessions = new Map();
  const req = { url: '/?taskId=obj-gone&tabId=obj-gone&reconnect=1', headers: { host: 'localhost' } };
  await h.exports.handleConnection(ws, req, sessions, () => null);
  assert.equal(goneFrames(ws).length, 1);
  assert.equal(goneFrames(ws)[0].tabId, 'obj-gone');
  assert.equal(ws.closed, true);
  assert.equal(sessions.size, 0, 'no pending session nobody would ever start');
});

function fakeRes() {
  return {
    statusCode: null, body: '',
    writeHead(status) { this.statusCode = status; },
    setHeader() {},
    end(chunk) { this.body = chunk || ''; },
  };
}

test('terminal reconnect reports a newer server exit only for a missing registry entry', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tt-reconnect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = harness();
  h.config.USER_DATA_ROOT = root;
  const at = new Date(Date.now() - 1000).toISOString();
  const before = Date.parse(at) - 1000;
  const recordPath = path.join(root, 'last-exit.json');
  fs.writeFileSync(recordPath, JSON.stringify({ at, reason: 'signal:SIGTERM', stack: 'private', liveSessionCount: 2 }));
  async function connect(start, existing) {
    const ws = fakeWs();
    const sessions = new Map(existing ? [['TPT415', existing]] : []);
    await h.exports.handleConnection(ws, {
      url: `/?taskId=TPT415${start == null ? '' : `&startedAt=${start}`}`, headers: { host: 'localhost' },
    }, sessions, () => null);
    assert.equal(ws.closed, !existing);
    assert.equal(sessions.size, existing ? 1 : 0);
    return { error: ws.frames.find(f => f.type === 'error'), frames: ws.frames };
  }
  const { error: frame } = await connect(before);
  assert.deepEqual(frame, { type: 'error', code: 'ESESSION_LOST', reason: 'signal:SIGTERM', at,
    message: `Terminal session for TPT415 was lost when the server exited (signal:SIGTERM, ${at}).` });
  for (const start of [null, '', 'bad', Date.parse(at), Date.parse(at) + 1000]) {
    // (TPT9002) The generic "no session" frame is coded too, with the key as its param.
    assert.deepEqual((await connect(start)).error, { type: 'error', code: 'ENOSESSION', params: { taskId: 'TPT415' },
      message: 'No active terminal session for TPT415' });
  }
  const exited = { type: 'terminal', tabId: 'TPT415', alive: false, buffer: 'retained history' };
  const retained = await connect(before, exited);
  assert.equal(retained.error, undefined);
  assert.match(retained.frames.find(f => f.type === 'data').data, /retained history$/);
  assert.equal(retained.frames.find(f => f.type === 'exit').code, null);
  assert.equal(exited.buffer, 'retained history');
  fs.writeFileSync(recordPath, '{');
  assert.equal((await connect(before)).error.code, 'ENOSESSION');
});

// (TPT9002) Every terminal start failure goes out with a stable code (+ params) beside the English
// message the console modal used to print verbatim.
test('startFailureFrame: stable codes with params beside the English message', () => {
  const h = harness();
  // The frame is built inside the vm context (another realm): compare it as the client sees it.
  const frame = (err, session) => JSON.parse(JSON.stringify(h.ctx.startFailureFrame(err, session)));
  const session = { taskAgentLabel: 'Codex' };
  assert.deepEqual(frame(Object.assign(new Error('TASK_ASSIGNED_TO_OTHER_MEMBER'), { code: 'EASSIGNEE' }), session),
    { type: 'error', code: 'EASSIGNEE', message: 'Cannot start a task assigned to another member.' });
  assert.deepEqual(frame(Object.assign(new Error('Assignee claim did not persist'), { code: 'ECLAIM' }), session),
    { type: 'error', code: 'ECLAIM', message: 'Could not assign this task to you. Task start canceled.' });
  assert.deepEqual(frame(new Error('Codex CLI not found'), session),
    { type: 'error', code: 'ESTART', params: { label: 'Codex', message: 'Codex CLI not found' }, message: 'Failed to start Codex: Codex CLI not found' });
  const { AuthCorruptedError } = require('./auth-guard');
  assert.deepEqual(frame(new AuthCorruptedError('API rejected this account — sign in again.', { reasonCode: 'unauthorized' }), session),
    { type: 'error', code: 'EAUTH', message: 'Authentication expired or invalid — sign in again.' });
  const expired = new AuthCorruptedError('API token expired at 09:05 — sign in again.', { reasonCode: 'expired', detail: { when: '09:05', expiresAt: 1 } });
  assert.deepEqual(frame(expired, session),
    { type: 'error', code: 'EAUTH', reason: 'expired', params: { when: '09:05', expiresAt: 1 }, message: expired.message });
  const expiring = new AuthCorruptedError('API token expires at 09:05 and could not be refreshed (offline) — sign in again.',
    { reasonCode: 'expiring', detail: { when: '09:05', expiresAt: 1, refreshError: 'offline' } });
  assert.deepEqual(frame(expiring, session),
    { type: 'error', code: 'EAUTH', reason: 'expiring', params: { when: '09:05', expiresAt: 1, refreshError: 'offline' }, message: expiring.message });
  // (TPT9008) A coded start failure adds its reason and params; label and message stay the frame's own.
  const coded = Object.assign(new Error('Codex is not logged in'),
    { reasonCode: 'not_logged_in', reasonParams: { agent: 'codex', label: 'spoofed', message: 'spoofed' } });
  assert.deepEqual(frame(coded, session), {
    type: 'error', code: 'ESTART', reason: 'not_logged_in',
    params: { agent: 'codex', label: 'Codex', message: 'Codex is not logged in' },
    message: 'Failed to start Codex: Codex is not logged in',
  });
  // A null/empty code is an uncoded failure: no reason, and its params are not forwarded.
  assert.deepEqual(frame(Object.assign(new Error('boom'), { reasonCode: null, reasonParams: { agent: 'codex' } }), session),
    { type: 'error', code: 'ESTART', params: { label: 'Codex', message: 'boom' }, message: 'Failed to start Codex: boom' });
  // Missing taskId on connect.
  const ws = fakeWs();
  return h.exports.handleConnection(ws, { url: '/?', headers: { host: 'localhost' } }, new Map(), () => null).then(() => {
    assert.deepEqual(ws.frames.find(f => f.type === 'error'), { type: 'error', code: 'EBADREQUEST', message: 'Missing taskId parameter' });
  });
});

// (TPT9014) A queued start drained after its headless Play All / bulk Start socket closed has no
// socket for the refusal: the coded frame rides the session-ended broadcast instead.
test('a queued start refused on drain broadcasts session-ended carrying the coded error frame', async () => {
  const h = harness();
  const websocket = require('./websocket');
  const realBroadcast = websocket.broadcastToProject;
  const broadcasts = [];
  websocket.broadcastToProject = (projectPath, type, payload) => {
    broadcasts.push(JSON.parse(JSON.stringify({ projectPath, type, payload })));
  };
  try {
    // The state the start queue hands launchNewTerminalSession(): no socket attached.
    const session = { type: 'terminal', tabId: 'TPT1', ws: null, projectPath: '/proj/a', taskAgent: 'claude', taskAgentLabel: 'Claude' };
    const sessionKey = h.ctx.sessKey('TPT1', '/proj/a');
    const sessions = new Map([[sessionKey, session]]);
    const backend = { getTask: async () => ({ id: 'TPT1', assignee: 7, tags: [] }), getCurrentUserId: async () => 3 };
    await h.ctx.launchNewTerminalSession({ session, prompt: 'Work on task TPT1', taskId: 'TPT1', sessionKey, sessions, backend, projectPath: '/proj/a' });
    assert.equal(sessions.has(sessionKey), false, 'the refused session leaves the map');
    assert.deepEqual(broadcasts.filter(b => b.type === 'session-ended'), [{
      projectPath: '/proj/a',
      type: 'session-ended',
      payload: { taskId: 'TPT1', tabId: 'TPT1', reason: 'start-failed',
        error: { type: 'error', code: 'EASSIGNEE', message: 'Cannot start a task assigned to another member.' } },
    }]);
  } finally {
    websocket.broadcastToProject = realBroadcast;
  }
});

// (TPT9008) End to end for every coded start failure the server can send: the agent's real
// detect() sentence (DETECT_REASONS via unavailableResult(), base-agent's detection_failed, Pi's
// tool-compat refusal) → the spawn gate's error shape → startFailureFrame() → the console modal's
// errorFrameText(). An English project must read exactly the server's message, a Ukrainian one a
// full translation — so a sentence edited on either side without the other fails here.
test('startFailureFrame: every coded start failure renders the server text in English and a full translation in Ukrainian', async () => {
  const h = harness();
  const frame = (err, session) => JSON.parse(JSON.stringify(h.ctx.startFailureFrame(err, session)));
  const { setLocale } = await import('../client/i18n.js');
  const { errorFrameText } = await import('../client/terminal-frame-text.js');
  const BaseTaskAgent = require('./task-agent/base-agent');
  const { toolCompatMessage } = require('./pi-custom-endpoint');
  // As terminal-session.js _spawnTerminal() throws it for a detect() negative.
  const gateError = (agent, status) => Object.assign(new Error(status.reason),
    { reasonCode: status.reasonCode, reasonParams: { ...status.reasonParams, agent: agent.id } });
  const cases = [];
  for (const Agent of [require('./task-agent/claude-agent'), require('./task-agent/codex-agent'), require('./task-agent/pi-agent')]) {
    const agent = new Agent();
    const codes = Object.keys(Agent.DETECT_REASONS);
    assert.ok(codes.length >= 3, `${agent.id} declares its detection reasons`);
    for (const code of codes) {
      const params = Agent.DETECT_REASONS[code].includes('{output}') ? { output: 'Error: Cannot find module $& x' } : undefined;
      const status = agent.unavailableResult(code, { params });
      assert.equal(status.reasonCode, code);
      assert.doesNotMatch(status.reason, /\{\w+\}/, `${agent.id}.${code}: every placeholder filled`);
      cases.push({ name: `${agent.id}.${code}`, err: gateError(agent, status), label: agent.label });
    }
  }
  class Broken extends BaseTaskAgent { async detect() { throw new Error('probe exploded'); } }
  const broken = new Broken('codex', 'Codex');
  const failed = await broken.cachedDetect({});
  assert.equal(failed.reasonCode, 'detection_failed');
  cases.push({ name: 'base.detection_failed', err: gateError(broken, failed), label: broken.label });
  const host = 'openrouter.ai';
  cases.push({
    name: 'pi.no_tool_calls',
    err: Object.assign(new Error(toolCompatMessage('recraft-v3', host, { declared: true })),
      { reasonCode: 'no_tool_calls', reasonParams: { agent: 'pi', model: 'recraft-v3', host } }),
    label: 'Other Model',
  });
  try {
    for (const { name, err, label } of cases) {
      const sent = frame(err, { taskAgentLabel: label });
      assert.equal(sent.reason, err.reasonCode, name);
      setLocale('en');
      assert.equal(errorFrameText(sent), sent.message, `${name}: English renders the server's message`);
      setLocale('uk');
      const uk = errorFrameText(sent);
      assert.notEqual(uk, sent.message, `${name}: Ukrainian is translated`);
      assert.match(uk, /^Не вдалося запустити /, name);
      assert.doesNotMatch(uk, /\{\w+\}|terminal\.|undefined/, name);
      assert.doesNotMatch(uk, /not found|not logged in|probe failed|detection failed|does not support/, `${name}: no English sentence left`);
    }
  } finally {
    setLocale('en');
  }
});

test('DELETE /api/objective/prewarm kills the cold spare', async () => {
  const h = harness();
  const handler = h.exports.createHttpHandler(new Map(), () => ({}), null);
  const res = fakeRes();
  await handler({ method: 'DELETE', url: '/api/objective/prewarm', headers: { host: 'localhost' } }, res);
  assert.equal(res.statusCode, 204);
  assert.deepEqual(h.named('claude.killColdPrewarm').map(c => c[1]), ['tab-closed']);
});

test('POST /api/objective/prewarm forwards the requesting project root', async () => {
  const h = harness();
  const handler = h.exports.createHttpHandler(new Map(), () => ({}), null);
  const post = async headers => {
    const res = fakeRes();
    await handler({ method: 'POST', url: '/api/objective/prewarm', headers: { host: 'localhost', ...headers } }, res);
    assert.equal(res.statusCode, 204);
  };
  await post({ 'x-tipatask-project': '/proj/other' });
  await post({});
  assert.deepEqual(h.named('claude.prewarmObjectiveCold').map(c => c[1]), ['/proj/other', '/proj/a']);
});
