'use strict';

// (TPT9163) requestNextTasks() — the request behind the start_next_tasks MCP tool and `tt next`.
// Stubbed fetch for the answer mapping; one real HTTP round trip through createLocalAccess()'s
// guard proves the request shape (host, method, run-token header) is the one the route accepts.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { requestNextTasks, COWBOY_TOKEN_ENV, COWBOY_URL_ENV, COWBOY_ENV_VARS } = require('./cowboy-next-request');
const { createLocalAccess, RUN_TOKEN_HEADER, LOCAL_HOST } = require('./local-access');

const TOKEN = 'run-token-secret-value';
const URL_TPT1 = 'http://127.0.0.1:4455/api/tasks/TPT1/cowboy-next';
const ENV = Object.freeze({ [COWBOY_TOKEN_ENV]: TOKEN, [COWBOY_URL_ENV]: URL_TPT1 });

function answer(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status, json: async () => { if (body === undefined) throw new SyntaxError('no body'); return body; } };
  };
  return { calls, fetchImpl };
}

test('env names are the ones terminal-session.js sets on a cowboy run', () => {
  const terminalSession = require('./terminal-session');
  assert.equal(COWBOY_TOKEN_ENV, 'TIPATASK_COWBOY_TOKEN');
  assert.equal(COWBOY_URL_ENV, 'TIPATASK_COWBOY_URL');
  assert.equal(terminalSession.COWBOY_TOKEN_ENV, COWBOY_TOKEN_ENV);
  assert.equal(terminalSession.COWBOY_URL_ENV, COWBOY_URL_ENV);
  assert.deepEqual([...COWBOY_ENV_VARS], [COWBOY_TOKEN_ENV, COWBOY_URL_ENV]);
});

test('a decision: one POST with the run token to the run\'s own route, started keys and reason back', async () => {
  const { calls, fetchImpl } = answer(200, { started: ['TPT2', 'TPT3'], reason: 'dependents' });
  const result = await requestNextTasks(' TPT1 ', { env: ENV, fetchImpl });
  assert.deepEqual(result, { ok: true, status: 200, started: ['TPT2', 'TPT3'], reason: 'dependents' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_TPT1);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, { [RUN_TOKEN_HEADER]: TOKEN });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('a repeat is reported as already_launched with the first decision', async () => {
  const previous = { started: ['TPT2'], reason: 'sprint' };
  const { fetchImpl } = answer(200, { started: [], reason: 'already_launched', previous });
  assert.deepEqual(await requestNextTasks('TPT1', { env: ENV, fetchImpl }),
    { ok: true, status: 200, started: [], reason: 'already_launched', previous });
});

test('without the run token, a usable URL or the run\'s own key nothing is sent', async () => {
  const cases = [
    { key: '', env: ENV, reason: 'no_task_key' },
    { key: undefined, env: ENV, reason: 'no_task_key' },
    { key: 'TPT1', env: {}, reason: 'no_token', error: /TIPATASK_COWBOY_TOKEN is not set: start_next_tasks works only inside a cowboy chain run/ },
    { key: 'TPT1', env: { [COWBOY_TOKEN_ENV]: '' }, reason: 'no_token' },
    { key: 'TPT1', env: { [COWBOY_TOKEN_ENV]: TOKEN }, reason: 'no_url', error: /TIPATASK_COWBOY_URL is missing/ },
    { key: 'TPT1', env: { ...ENV, [COWBOY_URL_ENV]: 'not a url' }, reason: 'no_url' },
    { key: 'TPT1', env: { ...ENV, [COWBOY_URL_ENV]: 'https://127.0.0.1:4455/api/tasks/TPT1/cowboy-next' }, reason: 'no_url' },
    { key: 'TPT1', env: { ...ENV, [COWBOY_URL_ENV]: 'http://tasks.example.com/api/tasks/TPT1/cowboy-next' }, reason: 'no_url' },
    { key: 'TPT1', env: { ...ENV, [COWBOY_URL_ENV]: 'http://localhost:4455/api/tasks/TPT1/cowboy-next' }, reason: 'no_url' },
    { key: 'TPT1', env: { ...ENV, [COWBOY_URL_ENV]: 'http://127.0.0.1:4455/api/sessions' }, reason: 'no_url' },
    { key: 'TPT2', env: ENV, reason: 'wrong_task', error: /TPT2 is not this run's task: pass TPT1/ },
  ];
  for (const { key, env, reason, error } of cases) {
    const { calls, fetchImpl } = answer(200, { started: ['X'], reason: 'dependents' });
    const result = await requestNextTasks(key, { env, fetchImpl });
    assert.equal(result.ok, false, JSON.stringify({ key, reason }));
    assert.equal(result.reason, reason);
    assert.deepEqual(result.started, []);
    assert.match(result.error, /Nothing was started\./);
    if (error) assert.match(result.error, error);
    assert.equal(calls.length, 0, `${reason}: no request`);
  }
});

test('refusals, a refused token and an unreadable task list come back as clear errors', async () => {
  const refused = await requestNextTasks('TPT1', { env: ENV, fetchImpl: answer(409, { started: [], reason: 'not_finished' }).fetchImpl });
  assert.deepEqual(refused, { ok: false, status: 409, started: [], reason: 'not_finished',
    error: 'Task App does not see this task as complete. Nothing was started.' });
  const unknown = await requestNextTasks('TPT1', { env: ENV, fetchImpl: answer(409, { started: [], reason: 'new_reason' }).fetchImpl });
  assert.equal(unknown.reason, 'new_reason');
  assert.match(unknown.error, /Task App refused \(new_reason\)\. Nothing was started\./);

  const forbidden = await requestNextTasks('TPT1', { env: ENV, fetchImpl: answer(403, { error: 'Forbidden' }).fetchImpl });
  assert.equal(forbidden.reason, 'forbidden');
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.error, /refused this run's token/);

  const unavailable = await requestNextTasks('TPT1', { env: ENV,
    fetchImpl: answer(503, { started: [], reason: 'unavailable', error: `read failed near ${TOKEN}` }).fetchImpl });
  assert.equal(unavailable.reason, 'unavailable');
  assert.match(unavailable.error, /could not read the tasks: read failed near \[redacted\]/);
  assert.ok(!JSON.stringify(unavailable).includes(TOKEN), 'the token never comes back');

  const odd = await requestNextTasks('TPT1', { env: ENV, fetchImpl: answer(500).fetchImpl });
  assert.deepEqual([odd.reason, odd.status], ['unexpected', 500]);
});

test('an unreachable Task App or a timeout is reported without the token', async () => {
  const unreachable = await requestNextTasks('TPT1', { env: ENV,
    fetchImpl: async () => { throw new TypeError(`fetch failed (${TOKEN})`); } });
  assert.equal(unreachable.reason, 'unreachable');
  assert.match(unreachable.error, /Could not reach Task App at http:\/\/127\.0\.0\.1:4455/);
  assert.ok(!JSON.stringify(unreachable).includes(TOKEN));

  const slow = await requestNextTasks('TPT1', { env: ENV, timeoutMs: 1000,
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); } });
  assert.equal(slow.reason, 'timeout');
  assert.match(slow.error, /did not answer within 1 s; it may still start the next tasks/);
});

test('the real request passes the local-access run-token guard over HTTP', async (t) => {
  const seen = [];
  let access;
  const server = http.createServer((req, res) => access.guardHttp(req, res, async () => {
    seen.push(req.localAccess);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ started: ['TPT2'], reason: 'dependents' }));
  }));
  await new Promise(resolve => server.listen(0, LOCAL_HOST, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  access = createLocalAccess({ port, liveRunTokens: key => (key === 'TPT1' ? [{ token: TOKEN, projectPath: '/projects/p' }] : []) });
  const env = { [COWBOY_TOKEN_ENV]: TOKEN, [COWBOY_URL_ENV]: `http://${LOCAL_HOST}:${port}/api/tasks/TPT1/cowboy-next` };

  assert.deepEqual(await requestNextTasks('TPT1', { env }), { ok: true, status: 200, started: ['TPT2'], reason: 'dependents' });
  assert.deepEqual(seen, [{ kind: 'run', projectPath: '/projects/p', taskKey: 'TPT1' }]);

  const forged = await requestNextTasks('TPT1', { env: { ...env, [COWBOY_TOKEN_ENV]: 'forged' } });
  assert.deepEqual([forged.ok, forged.reason, forged.status], [false, 'forbidden', 403]);
  assert.equal(seen.length, 1, 'a forged token never reaches the handler');
});
