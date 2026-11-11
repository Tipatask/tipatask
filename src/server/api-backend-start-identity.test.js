'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-start-identity-data-'));
process.env.TIPATASK_USER_DATA = dataRoot;
test.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { writeAccountToken, clearAccountToken } = require('./account-store');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-start-identity-'));
  const state = { me: 1, status: 200, requests: [], claimStatus: 200 };
  let pending;
  const server = http.createServer((req, res) => {
    state.requests.push(req.method + ' ' + req.url);
    const send = () => {
      const me = req.url === '/api/auth/me';
      res.writeHead(me ? state.status : state.claimStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(me ? { user: { id: state.me } } : {
        task: { task_key: 'TPT1', category: 'CODING', assignee: 1 }, code: 'task_assigned_to_other_member',
      }));
    };
    if (state.hold) { pending = send; state.arrived?.(); } else send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  writeProjectConfig(root, { API_BASE_URL: baseUrl, API_PROJECT_ID: '2' });
  writeAccountToken(baseUrl, 'synthetic-first');
  const backend = createApiBackend(null, root);
  t.after(async () => {
    backend.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    clearAccountToken(baseUrl);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { backend, state, baseUrl, root, release: () => pending(), hold: () => {
    state.hold = true;
    return new Promise(resolve => { state.arrived = resolve; });
  } };
}

for (const failure of ['status', 'null', 'zero', 'string', 'timeout', 'missing credentials']) {
  test(`strict identity rejects ${failure} instead of using cached identity`, async t => {
    const h = await fixture(t);
    assert.equal(await h.backend.getCurrentUserId(), 1);
    if (failure === 'status') h.state.status = 503;
    if (failure === 'null') h.state.me = null;
    if (failure === 'zero') h.state.me = 0;
    if (failure === 'string') h.state.me = '1';
    if (failure === 'timeout') h.state.hold = true;
    if (failure === 'missing credentials') clearAccountToken(h.baseUrl);
    await assert.rejects(h.backend.getCurrentUserId({ strict: true, timeoutMs: 30 }), { code: 'EAUTH' });
    h.state.hold = false; h.state.status = 200; h.state.me = 2;
    writeAccountToken(h.baseUrl, 'synthetic-recovered');
    assert.equal(await h.backend.getCurrentUserId({ strict: true }), 2);
    assert.equal(await h.backend.getCurrentUserId(), 2);
  });
}

for (const change of ['account', 'reset', 'project']) test(`late /me response after ${change} change cannot restore old identity`, async t => {
  const h = await fixture(t);
  const arrived = h.hold();
  const reading = h.backend.getCurrentUserId({ strict: true });
  const refused = assert.rejects(reading, { code: 'EAUTH' });
  await arrived;
  if (change === 'account') writeAccountToken(h.baseUrl, 'synthetic-second');
  if (change === 'reset') h.backend.resetUserContext('test account event');
  if (change === 'project') writeProjectConfig(h.root, { API_PROJECT_ID: '3' });
  h.release();
  await refused;
  if (change !== 'project') {
    h.state.hold = false; h.state.me = 2;
    assert.equal(await h.backend.getCurrentUserId({ strict: true }), 2);
  }
});

test('atomic start claims bypass offline writes and refuse missing or conflicting endpoints', async t => {
  const h = await fixture(t);
  for (const status of [503, 404, 409]) {
    h.state.claimStatus = status;
    await assert.rejects(h.backend.claimTaskForStart('TPT1'));
    assert.equal(h.backend.getPendingMutationCount(), 0);
  }
  h.state.claimStatus = 200;
  assert.equal((await h.backend.claimTaskForStart('TPT1')).assignee, 1);
  assert.ok(h.state.requests.every(r => r === 'POST /api/projects/2/tasks/TPT1/start-claim'));
});

test('an atomic claim response authenticated before account rotation is discarded', async t => {
  const h = await fixture(t);
  const arrived = h.hold();
  const claiming = h.backend.claimTaskForStart('TPT1');
  const refused = assert.rejects(claiming, { contextChanged: true });
  await arrived;
  writeAccountToken(h.baseUrl, 'synthetic-second');
  h.release();
  await refused;
  assert.equal(h.backend.getPendingMutationCount(), 0);
});

test('account rotation between proof and claim refuses before sending any write', async t => {
  const h = await fixture(t);
  const credentials = h.backend.getCredentials();
  assert.equal(await h.backend.getCurrentUserId({ strict: true }), 1);
  writeAccountToken(h.baseUrl, 'synthetic-second');
  await assert.rejects(h.backend.claimTaskForStart('TPT1', { credentials }), { code: 'EAUTH' });
  assert.deepEqual(h.state.requests, ['GET /api/auth/me']);
  assert.equal(h.backend.getPendingMutationCount(), 0);
});
