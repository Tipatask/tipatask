'use strict';

// (TPT9163) `tt next <key>` — the Pi/REST form of the start_next_tasks MCP tool. It needs only the
// run's own TIPATASK_COWBOY_TOKEN/URL, never the account store, and prints the decision as JSON.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { run } = require('./task-tools');

const CLI = path.join(__dirname, 'task-tools.js');

const SKIPPED = Object.freeze([{ key: 'TPT4', reason: 'deps_open' }, { key: 'TPT5', reason: 'other_assignee' }]);

// A stub of POST /api/tasks/TPT1/cowboy-next that answers `reply` to the run token tok-1.
async function stubRoute(t, reply = { status: 200, body: { started: ['TPT2', 'TPT3'], reason: 'dependents', skipped: SKIPPED } }) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, token: req.headers['x-tipatask-run-token'] });
    const ok = req.method === 'POST' && req.url === '/api/tasks/TPT1/cowboy-next' && req.headers['x-tipatask-run-token'] === 'tok-1';
    res.writeHead(ok ? reply.status : 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? reply.body : { error: 'Forbidden' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/TPT1/cowboy-next`;
  return { hits, env: { TIPATASK_COWBOY_TOKEN: 'tok-1', TIPATASK_COWBOY_URL: url } };
}

// Runs the CLI as Pi's `tt` does, in a scratch project with no account store: `next` must not
// need one. Asynchronous — the stub route answers from this process's event loop.
function tt(t, args, cowboyEnv) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-next-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, TIPATASK_PROJECT_ROOT: root, TIPATASK_USER_DATA: root };
  delete env.TIPATASK_COWBOY_TOKEN;
  delete env.TIPATASK_COWBOY_URL;
  Object.assign(env, cowboyEnv);
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env, cwd: root, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('run(["next", key]) asks the run\'s own route and returns the started keys and skips', async (t) => {
  const { hits, env } = await stubRoute(t);
  assert.deepEqual(await run(['next', 'TPT1'], { env }),
    { ok: true, status: 200, started: ['TPT2', 'TPT3'], reason: 'dependents', skipped: SKIPPED });
  assert.deepEqual(hits, [{ method: 'POST', url: '/api/tasks/TPT1/cowboy-next', token: 'tok-1' }]);
});

test('tt next <key> prints the started keys and per-task skip reasons and exits 0', async (t) => {
  const { hits, env } = await stubRoute(t);
  const out = await tt(t, ['next', 'TPT1'], env);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { ok: true, status: 200, started: ['TPT2', 'TPT3'], reason: 'dependents', skipped: SKIPPED });
  assert.equal(hits.length, 1);
  assert.ok(!out.stdout.includes('tok-1') && !out.stderr.includes('tok-1'), 'the token is never printed');
});

test('tt next exits 1 with a clear JSON error without the run token or on a refusal', async (t) => {
  const missing = await tt(t, ['next', 'TPT1'], {});
  assert.equal(missing.code, 1);
  const body = JSON.parse(missing.stdout);
  assert.deepEqual([body.ok, body.reason, body.started, body.skipped], [false, 'no_token', [], []]);
  assert.match(body.error, /TIPATASK_COWBOY_TOKEN is not set/);

  const { env } = await stubRoute(t, { status: 409, body: { started: [], reason: 'not_finished' } });
  const refused = await tt(t, ['next', 'TPT1'], env);
  assert.equal(refused.code, 1);
  assert.deepEqual(JSON.parse(refused.stdout), { ok: false, status: 409, started: [], skipped: [], reason: 'not_finished',
    error: 'Task App does not see this task as complete. Nothing was started.' });
});
