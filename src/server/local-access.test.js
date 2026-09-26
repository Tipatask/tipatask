'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { WebSocket, WebSocketServer } = require('ws');
const { createLocalAccess, electronCapability, stampElectronRequest, LOCAL_HOST } = require('./local-access');

test('Electron stamps only its local window traffic and replaces renderer-supplied selectors', () => {
  const options = { requestUrl: 'http://127.0.0.1:4455/api/sessions', port: 4455,
    secret: 'test-only-secret', projectPath: '/alpha', knownWindow: true };
  const headers = stampElectronRequest({
    'X-TipATask-Capability': 'forged', 'x-tipatask-project': '/beta',
    'X-TipTask-Project-Path': '/beta', Accept: 'application/json',
  }, options);
  assert.equal(headers['x-tipatask-capability'], electronCapability(options.secret, '/alpha'));
  assert.equal(headers['x-tipatask-project'], '/alpha');
  assert.equal(headers['X-TipTask-Project-Path'], '/alpha');
  assert.equal(headers.Accept, 'application/json');
  const external = stampElectronRequest({ 'x-tipatask-capability': 'forged' },
    { ...options, requestUrl: 'https://web.tipatask.com/api/projects' });
  assert.equal(external['x-tipatask-capability'], undefined);
  const unknown = stampElectronRequest({}, { ...options, knownWindow: false });
  assert.equal(unknown['x-tipatask-capability'], undefined);
});

async function fixture(t, { electron = false, activeProject = '/alpha' } = {}) {
  const secret = 'test-only-secret';
  let access;
  let httpCalls = 0;
  let wsCalls = 0;
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => { wsCalls++; ws.send('connected'); });
  const server = http.createServer((req, res) => access.guardHttp(req, res, (request, response) => {
    httpCalls++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ projectPath: request.localAccess.projectPath, kind: request.localAccess.kind }));
  }));
  server.on('upgrade', (req, socket, head) => access.guardUpgrade(req, socket, head, wss));
  await new Promise(resolve => server.listen(0, LOCAL_HOST, resolve));
  t.after(() => new Promise(resolve => { wss.close(); server.close(resolve); }));
  const port = server.address().port;
  assert.equal(server.address().address, '127.0.0.1');
  access = createLocalAccess({ port, secret, electron, getActiveProjectPath: () => activeProject });

  function request(path, { method = 'GET', headers = {}, body = '' } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: LOCAL_HOST, port, path, method, headers }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  function socket(path, { origin = `http://127.0.0.1:${port}`, headers = {} } = {}) {
    return new Promise(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin, headers });
      ws.once('open', () => { ws.close(); resolve(101); });
      ws.once('unexpected-response', (_req, res) => { const code = res.statusCode; res.resume(); resolve(code); });
      ws.once('error', err => {
        const status = Number(/Unexpected server response: (\d+)/.exec(err.message)?.[1]);
        resolve(status || 0);
      });
    });
  }

  return { access, port, request, socket, secret, get httpCalls() { return httpCalls; }, get wsCalls() { return wsCalls; } };
}

test('Electron capability binds HTTP and WebSocket traffic to one project', async t => {
  const f = await fixture(t, { electron: true });
  const scope = '/alpha';
  const headers = {
    'x-tipatask-capability': electronCapability(f.secret, scope),
    'x-tipatask-project': scope,
    'x-tiptask-project-path': scope,
  };
  assert.equal((await f.request('/api/sessions')).status, 401);
  assert.equal((await f.request('/api/sessions', { headers: { ...headers, 'x-tipatask-capability': 'bad' } })).status, 401);
  assert.equal((await f.request('/api/sessions', { headers: { ...headers, Host: 'evil.example' } })).status, 403);
  assert.equal((await f.request('/api/sessions', { headers: { ...headers, Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await f.request('/api/sessions', { headers: { ...headers, 'x-tipatask-project': '/beta' } })).status, 403);
  assert.equal((await f.request('/api/sessions?projectPath=%2Fbeta', { headers })).status, 403);
  assert.equal(f.httpCalls, 0);
  const allowed = await f.request('/api/sessions', { headers });
  assert.equal(allowed.status, 200);
  assert.deepEqual(JSON.parse(allowed.text), { projectPath: '/alpha', kind: 'electron' });

  assert.equal(await f.socket('/?taskId=__voice__'), 401);
  assert.equal(await f.socket('/?taskId=__board__', { origin: 'http://evil.example', headers }), 403);
  assert.equal(await f.socket('/?taskId=task1&projectPath=%2Fbeta', { headers }), 403);
  assert.equal(f.wsCalls, 0);
  for (const taskId of ['task1', '__voice__', 'obj-test']) {
    assert.equal(await f.socket(`/?taskId=${taskId}&projectPath=%2Falpha`, { headers }), 101);
  }
  assert.equal(f.wsCalls, 3);
});

test('browser bootstrap issues a one-time, same-site session', async t => {
  const f = await fixture(t);
  const websiteLink = await f.request('/start-task?projectId=2&task=TPT315&userId=1', {
    headers: { Host: `localhost:${f.port}` },
  });
  assert.equal(websiteLink.status, 303);
  assert.equal(websiteLink.headers.location,
    `http://127.0.0.1:${f.port}/start-task?projectId=2&task=TPT315&userId=1`);
  assert.equal(f.httpCalls, 0);
  assert.equal((await f.request('/todo.html')).status, 303);
  assert.equal((await f.request('/login')).status, 200);
  assert.equal((await f.request('/api/local-auth', { method: 'POST', headers: { Origin: `http://127.0.0.1:${f.port}` }, body: 'code=wrong' })).status, 401);
  const login = await f.request('/api/local-auth', {
    method: 'POST', headers: { Origin: `http://127.0.0.1:${f.port}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `code=${encodeURIComponent(f.access.loginCode)}`,
  });
  assert.equal(login.status, 303);
  assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.equal((await f.request('/api/local-auth', { method: 'POST', headers: { Origin: `http://127.0.0.1:${f.port}` }, body: `code=${f.access.loginCode}` })).status, 401);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await f.request('/api/sessions', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await f.request('/api/sessions', { headers: { Cookie: cookie, 'x-tipatask-project': '/beta' } })).status, 403);
  assert.equal((await f.request('/api/sessions', { headers: { Cookie: cookie, Origin: 'http://evil.example' } })).status, 403);
  assert.equal(await f.socket('/?taskId=__attention__', { headers: { Cookie: cookie } }), 101);
  assert.equal(await f.socket('/?taskId=__attention__', { origin: 'http://evil.example', headers: { Cookie: cookie } }), 403);
});

test('web and Electron handoffs stop before backend selection when native confirmation is denied', async () => {
  const { createHttpHandler } = require('./ws-handlers');
  let confirmations = 0;
  const handler = createHttpHandler(new Map(), () => { throw new Error('backend selected before consent'); }, {
    confirmHandoffViaMain: async () => { confirmations++; return false; },
  });
  for (const kind of ['handoff', 'electron']) {
    const req = {
      method: 'GET', url: '/start-task?projectId=2&task=TPT315&userId=1',
      headers: { host: 'localhost:4455' }, localAccess: { kind },
    };
    const res = { status: null, writeHead(status) { this.status = status; }, end() {} };
    await handler(req, res);
    assert.equal(res.status, 403);
  }
  assert.equal(confirmations, 2);
});

test('Electron cannot use browser project-switch route', async () => {
  const { createHttpHandler } = require('./ws-handlers');
  const handler = createHttpHandler(new Map(), () => { throw new Error('backend selected'); }, {});
  const req = {
    method: 'GET', url: '/api/project-switch?path=%2Fbeta', headers: { host: 'localhost:4455' },
    localAccess: { kind: 'electron', projectPath: '/alpha' },
  };
  const res = { status: null, writeHead(status) { this.status = status; }, end() {} };
  await handler(req, res);
  assert.equal(res.status, 403);
});

test('handoff rejects an explicit path outside registered project candidates', async () => {
  const { createHttpHandler } = require('./ws-handlers');
  const originalSend = process.send;
  process.send = () => {};
  try {
    const handler = createHttpHandler(new Map(), () => ({}), {
      confirmHandoffViaMain: async () => true,
      resolveProjectPathViaMain: async () => ['/alpha'],
      getBackendForPath: () => { throw new Error('forged path reached backend'); },
    });
    const req = {
      method: 'GET', url: '/start-task?projectId=2&task=TPT315&userId=1&projectPath=%2Fforged',
      headers: { host: 'localhost:4455' }, localAccess: { kind: 'handoff' },
    };
    const res = { status: null, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await handler(req, res);
    assert.equal(res.status, 403);
    assert.match(res.body, /not registered/);
  } finally {
    process.send = originalSend;
  }
});
