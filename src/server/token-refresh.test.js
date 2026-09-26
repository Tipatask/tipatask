'use strict';

// TPT349 — refreshProjectToken(): silent exchange of a still-valid project token for a fresh
// 7-day one through POST /api/auth/project-token, persisted to .tipatask/config.json and the
// .claude/settings.local.json env copy. Runs against a fake HTTP API + scratch project dirs.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { refreshProjectToken } = require('./token-refresh');
const { tokenExpiryMs } = require('./auth-guard');
const { projectEnvExtras } = require('./spawn-utils');

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt(expSeconds) {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ id: 1, project_id: 2, exp: expSeconds })}.sig`;
}
const nowSec = () => Math.floor(Date.now() / 1000);

async function withApi(handler, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      handler(req, res, requests.length);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function makeProject(cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-refresh-'));
  fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify(cfg, null, 2));
  return root;
}
const readCfg = (root) => JSON.parse(fs.readFileSync(path.join(root, '.tipatask', 'config.json'), 'utf8'));

test('refreshProjectToken: posts the current token, writes the fresh one, keeps every other key', async (t) => {
  const oldTok = makeJwt(nowSec() + 300);
  const newTok = makeJwt(nowSec() + 7 * 86400);
  await withApi((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: newTok }));
  }, async (baseUrl, requests) => {
    const root = makeProject({ TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: oldTok, API_PROJECT_ID: '2', CLAUDE_MODEL: 'opus' });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const out = await refreshProjectToken({ projectRoot: root, baseUrl: `${baseUrl}/`, token: oldTok, projectId: '2' });

    assert.deepStrictEqual(out, { token: newTok, rotated: false });
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].method, 'POST');
    assert.strictEqual(requests[0].url, '/api/auth/project-token');
    assert.strictEqual(requests[0].auth, `Bearer ${oldTok}`);
    assert.deepStrictEqual(JSON.parse(requests[0].body), { project_id: 2 });

    const cfg = readCfg(root);
    assert.strictEqual(cfg.API_TOKEN, newTok);
    assert.strictEqual(cfg.CLAUDE_MODEL, 'opus');
    assert.ok(!('theme' in cfg) && !('language' in cfg), 'reader defaults must not be persisted');
  });
});

test('refreshProjectToken: the spawn env (projectEnvExtras) carries the fresh token afterwards', async (t) => {
  const oldTok = makeJwt(nowSec() + 300);
  const newTok = makeJwt(nowSec() + 7 * 86400);
  await withApi((req, res) => { res.writeHead(200); res.end(JSON.stringify({ token: newTok })); }, async (baseUrl) => {
    const root = makeProject({ API_BASE_URL: baseUrl, API_TOKEN: oldTok, API_PROJECT_ID: '2' });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.strictEqual(tokenExpiryMs(projectEnvExtras(root).API_TOKEN), tokenExpiryMs(oldTok));
    await refreshProjectToken({ projectRoot: root, baseUrl, token: oldTok, projectId: '2' });
    const env = projectEnvExtras(root);
    assert.strictEqual(env.API_TOKEN, newTok);
    assert.strictEqual(tokenExpiryMs(env.API_TOKEN), tokenExpiryMs(newTok));
  });
});

test('refreshProjectToken: rewrites the settings.local.json env copy and gitignores it', async (t) => {
  const oldTok = makeJwt(nowSec() + 300);
  const newTok = makeJwt(nowSec() + 7 * 86400);
  await withApi((req, res) => { res.writeHead(200); res.end(JSON.stringify({ token: newTok })); }, async (baseUrl) => {
    const root = makeProject({ API_BASE_URL: baseUrl, API_TOKEN: oldTok, API_PROJECT_ID: '2' });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({ env: { API_TOKEN: oldTok, KEEP: 'me' } }));

    await refreshProjectToken({ projectRoot: root, baseUrl, token: oldTok, projectId: '2' });

    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8'));
    assert.strictEqual(settings.env.API_TOKEN, newTok);
    assert.strictEqual(settings.env.KEEP, 'me');
    assert.ok(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('.claude/settings.local.json'));
  });
});

test('refreshProjectToken: concurrent callers for one project share a single request', async (t) => {
  const oldTok = makeJwt(nowSec() + 300);
  const newTok = makeJwt(nowSec() + 7 * 86400);
  await withApi((req, res) => {
    setTimeout(() => { res.writeHead(200); res.end(JSON.stringify({ token: newTok })); }, 50);
  }, async (baseUrl, requests) => {
    const root = makeProject({ API_BASE_URL: baseUrl, API_TOKEN: oldTok, API_PROJECT_ID: '2' });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const args = { projectRoot: root, baseUrl, token: oldTok, projectId: '2' };
    const [a, b] = await Promise.all([refreshProjectToken(args), refreshProjectToken(args)]);
    assert.strictEqual(requests.length, 1);
    assert.deepStrictEqual(a, b);
    // The in-flight slot is released, so a later refresh issues a new request.
    await refreshProjectToken({ ...args, token: newTok }).catch(() => {});
    assert.strictEqual(requests.length, 2);
  });
});

test('refreshProjectToken: a token rotated in config.json meanwhile (re-auth) is never overwritten', async (t) => {
  const oldTok = makeJwt(nowSec() + 300);
  const reauthTok = makeJwt(nowSec() + 6 * 86400);
  const serverTok = makeJwt(nowSec() + 7 * 86400);
  await withApi((req, res) => { res.writeHead(200); res.end(JSON.stringify({ token: serverTok })); }, async (baseUrl) => {
    const root = makeProject({ API_BASE_URL: baseUrl, API_TOKEN: reauthTok, API_PROJECT_ID: '2' });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const out = await refreshProjectToken({ projectRoot: root, baseUrl, token: oldTok, projectId: '2' });
    assert.deepStrictEqual(out, { token: reauthTok, rotated: true });
    assert.strictEqual(readCfg(root).API_TOKEN, reauthTok);
  });
});

test('refreshProjectToken: a deliberate blank token (mid re-auth) stays blank', async (t) => {
  const oldTok = makeJwt(nowSec() + 300);
  await withApi((req, res) => { res.writeHead(200); res.end(JSON.stringify({ token: makeJwt(nowSec() + 86400) })); }, async (baseUrl) => {
    const root = makeProject({ API_BASE_URL: baseUrl, API_TOKEN: '', API_PROJECT_ID: '2' });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const out = await refreshProjectToken({ projectRoot: root, baseUrl, token: oldTok, projectId: '2' });
    assert.strictEqual(out.rotated, true);
    assert.strictEqual(readCfg(root).API_TOKEN, '');
  });
});

test('refreshProjectToken: non-2xx and unusable bodies reject with token-free messages and leave config alone', async (t) => {
  const oldTok = makeJwt(nowSec() + 300);
  for (const [status, payload, expected] of [
    [401, '{"error":"Unauthorized"}', /rejected \(HTTP 401\)/],
    [200, '{"token":"not-a-jwt"}', /no usable token/],
    [200, 'not json', /unreadable response/],
  ]) {
    await withApi((req, res) => { res.writeHead(status); res.end(payload); }, async (baseUrl) => {
      const root = makeProject({ API_BASE_URL: baseUrl, API_TOKEN: oldTok, API_PROJECT_ID: '2' });
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      await assert.rejects(
        () => refreshProjectToken({ projectRoot: root, baseUrl, token: oldTok, projectId: '2' }),
        (err) => { assert.match(err.message, expected); assert.ok(!err.message.includes(oldTok)); return true; });
      assert.strictEqual(readCfg(root).API_TOKEN, oldTok);
    });
  }
});

test('refreshProjectToken: an unreachable API rejects with the network code, not a stack of internals', async (t) => {
  const oldTok = makeJwt(nowSec() + 300);
  const root = makeProject({ API_BASE_URL: 'http://127.0.0.1:9', API_TOKEN: oldTok, API_PROJECT_ID: '2' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    () => refreshProjectToken({ projectRoot: root, baseUrl: 'http://127.0.0.1:9', token: oldTok, projectId: '2', timeoutMs: 2000 }),
    (err) => /^token refresh request failed/.test(err.message));
});

test('refreshProjectToken: missing inputs reject up front', async () => {
  await assert.rejects(() => refreshProjectToken({ projectRoot: '/x', baseUrl: '', token: 't', projectId: '1' }), /needs projectRoot/);
});
