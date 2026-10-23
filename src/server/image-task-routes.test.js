'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-image-route-'));
process.env.TIPATASK_PROJECT_ROOT = ROOT;
process.env.TIPATASK_USER_DATA = ROOT;
process.env.TASK_BACKEND = 'api';
fs.mkdirSync(path.join(ROOT, '.tipatask'));
fs.writeFileSync(path.join(ROOT, '.tipatask/config.json'), JSON.stringify({ API_BASE_URL: 'https://example.test', API_PROJECT_ID: '99' }));
const { createHttpHandler } = require('./ws-handlers');
const { storeFor } = require('./image-task');
const backend = { getCredentials: () => ({ baseUrl: 'https://example.test', projectId: 99 }) };
const handler = createHttpHandler(new Map(), () => backend);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ZkAAAAASUVORK5CYII=';
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

async function request(url, root = ROOT) {
  const req = { method: 'GET', url, headers: { 'x-tipatask-project': root } };
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(data) { this.data = data; } };
  await handler(req, res);
  return res;
}

test('cached result route serves only authenticated-project run images, never a caller filesystem path', async () => {
  const store = storeFor(ROOT, ROOT, 'IMG1', backend);
  const runId = crypto.randomUUID();
  const files = await store.cache(runId, [{ type: 'image', mimeType: 'image/png', data: PNG }], 'IMG1');
  await store.write({ taskId: 'IMG1', runId, files, stage: 'failed' });
  const url = `/api/image-task/result?task=IMG1&run=${runId}&index=0`;
  const good = await request(url);
  assert.equal(good.status, 200);
  assert.equal(good.data.toString('base64'), PNG);
  assert.equal(good.headers['Content-Type'], 'image/png');
  assert.match(good.headers['Content-Security-Policy'], /sandbox/);
  assert.equal((await request(url, path.join(ROOT, 'another-project'))).status, 404);
  assert.equal((await request(url.replace(runId, crypto.randomUUID()))).status, 404);
  assert.equal((await request(url.replace('index=0', 'index=-1'))).status, 404);
  assert.equal((await request('/api/image-task/result?task=..%2Fsecret&run=x&index=0')).status, 404);
  fs.writeFileSync(store.cachePath(runId, files[0].filename), 'changed');
  assert.equal((await request(url)).status, 404);
});

test('image model discovery uses the image catalog and excludes other providers', async t => {
  const provider = require('./pi-image-provider');
  t.mock.method(provider, 'listImageModels', async () => [{ id: 'recraft/recraft-v3', name: 'Recraft V3' }]);
  const good = await request('/api/pi/models?provider=openrouter&purpose=image');
  assert.equal(good.status, 200);
  assert.equal(JSON.parse(good.data)[0].id, 'recraft/recraft-v3');
  assert.deepEqual(JSON.parse((await request('/api/pi/models?provider=custom&purpose=image')).data), []);
});
