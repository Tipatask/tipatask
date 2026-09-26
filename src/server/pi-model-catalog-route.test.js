'use strict';

// TPT190 — deterministic coverage for Pi provider/catalog HTTP routes. The route resolves Pi
// through the real resolvePiLaunch() path, pointed at a tiny fixture executable via PI_BIN; no
// API key, network request, user Pi config, or installed global CLI is involved.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pi-model-catalog-'));
const COUNTER = path.join(ROOT, 'calls.txt');
const PI_FIXTURE = path.join(ROOT, 'pi-fixture');
fs.mkdirSync(path.join(ROOT, '.tipatask'));
fs.writeFileSync(path.join(ROOT, '.tipatask', 'config.json'), JSON.stringify({
  PI_MODELS: [{ model: 'openai/gpt-5', apiKey: 'never-serialize-this' }],
}));
fs.writeFileSync(PI_FIXTURE, `#!/bin/sh
printf 'call\\n' >> '${COUNTER}'
printf '%s\\n' \\
  'provider    model                         context  max-out  thinking  images' \\
  'deepseek    deepseek-v4-flash            128K     8K       yes       no' \\
  'openrouter  anthropic/claude-sonnet-4.5  200K     64K      yes       yes' \\
  'openrouter  openai/gpt-5                  400K     128K     yes       yes'
`);
fs.chmodSync(PI_FIXTURE, 0o755);
process.env.TIPATASK_PROJECT_ROOT = ROOT;
process.env.TIPATASK_USER_DATA = ROOT;
process.env.PI_BIN = PI_FIXTURE;
process.env.TASK_BACKEND = 'api';

const {
  createHttpHandler,
  parsePiModelList,
  queryPiModels,
  listPiModels,
  PI_MODEL_CACHE_TTL_MS,
} = require('./ws-handlers');
const { PI_PROVIDERS } = require('./project-config');

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function fakeReq(url) {
  const req = { method: 'GET', url, headers: { 'x-tipatask-project': ROOT } };
  req[Symbol.asyncIterator] = async function* () {};
  return req;
}

function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(chunk) { res.body = chunk || ''; },
  };
  return res;
}

async function request(url) {
  const handler = createHttpHandler(new Map(), () => ({}), null);
  const res = fakeRes();
  await handler(fakeReq(url), res);
  return res;
}

function callCount() {
  try { return fs.readFileSync(COUNTER, 'utf8').trim().split(/\n/).filter(Boolean).length; }
  catch { return 0; }
}

test('GET /api/pi/providers returns registry metadata and never serializes apiKey', async () => {
  const res = await request('/api/pi/providers');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.includes('apiKey'), false);
  assert.equal(res.body.includes('never-serialize-this'), false);

  const providers = JSON.parse(res.body);
  assert.equal(providers.length, Object.keys(PI_PROVIDERS).length);
  assert.deepEqual(Object.keys(providers[0]), ['id', 'label', 'envKey', 'keyRequired', 'supportsBaseUrl']);
  assert.deepEqual(providers.filter((provider) => provider.supportsBaseUrl).map((provider) => provider.id), ['custom']);
});

test('GET /api/pi/models returns a non-empty exact-provider catalog for openrouter', async () => {
  const before = callCount();
  const res = await request('/api/pi/models?provider=openrouter');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), [
    { id: 'anthropic/claude-sonnet-4.5', name: 'anthropic/claude-sonnet-4.5' },
    { id: 'openai/gpt-5', name: 'openai/gpt-5' },
  ]);
  assert.equal(callCount(), before + 1);
});

test('GET /api/pi/models returns 200 [] for an unknown provider without leaking other rows', async () => {
  const before = callCount();
  const res = await request('/api/pi/models?provider=unknown-provider');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), []);
  assert.equal(callCount(), before, 'unknown registry id must not spawn Pi');
});

test('GET /api/pi/models caches results per provider', async () => {
  const before = callCount();
  const first = await request('/api/pi/models?provider=deepseek');
  const second = await request('/api/pi/models?provider=deepseek');
  assert.deepEqual(JSON.parse(first.body), [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }]);
  assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
  assert.equal(callCount(), before + 1, 'second request inside the ten-minute TTL uses the cache');
});

test('parsePiModelList strips ANSI, filters exact provider, and deduplicates model ids', () => {
  const output = [
    'provider    model       context  max-out  thinking  images',
    '\u001b[32mopenrouter\u001b[0m  a/model     100K     8K       no        no',
    'deepseek    other       100K     8K       no        no',
    'openrouter  a/model     100K     8K       no        no',
  ].join('\n');
  assert.deepEqual(parsePiModelList(output, 'OPENROUTER'), [{ id: 'a/model', name: 'a/model' }]);
  assert.deepEqual(parsePiModelList(output, 'missing'), []);
});

function fakeChild(onStart) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => { child.killSignals.push(signal); return true; };
  queueMicrotask(() => onStart(child));
  return child;
}

test('queryPiModels uses resolvePiLaunch argv and returns [] on non-zero exit', async () => {
  let captured;
  const models = await queryPiModels('openrouter', ROOT, {
    resolveLaunch: () => ({ command: '/fake/pi', argsPrefix: ['cli.js'], env: {} }),
    spawn(command, args, options) {
      captured = { command, args, options };
      return fakeChild((child) => child.emit('close', 1));
    },
    timeoutMs: 50,
  });
  assert.deepEqual(models, []);
  assert.equal(captured.command, '/fake/pi');
  assert.deepEqual(captured.args, ['cli.js', '--list-models', '--provider', 'openrouter']);
  assert.equal(captured.options.cwd, ROOT);
});

test('queryPiModels kills a stalled Pi after the configured cap and returns []', async () => {
  let child;
  const models = await queryPiModels('openrouter', ROOT, {
    resolveLaunch: () => ({ command: '/fake/pi', argsPrefix: [], env: {} }),
    spawn() { child = fakeChild(() => {}); return child; },
    timeoutMs: 5,
  });
  assert.deepEqual(models, []);
  assert.deepEqual(child.killSignals, ['SIGKILL']);
});

test('listPiModels caches empty results and expires entries after ten minutes', async () => {
  const cache = new Map();
  let now = 1_000;
  let calls = 0;
  const deps = {
    cache,
    now: () => now,
    query: async () => { calls += 1; return []; },
  };
  assert.deepEqual(await listPiModels('xai', ROOT, deps), []);
  now += PI_MODEL_CACHE_TTL_MS - 1;
  assert.deepEqual(await listPiModels('xai', ROOT, deps), []);
  assert.equal(calls, 1);
  now += 1;
  assert.deepEqual(await listPiModels('xai', ROOT, deps), []);
  assert.equal(calls, 2);
});
