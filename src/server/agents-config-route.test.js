'use strict';

// Settings ▸ Agents save must make a CLI installed AFTER server boot show up in the objective
// chat-model-selector without a restart: POST /api/agents-config re-detects agents in this
// process (its detect/bin caches are separate from Electron main's) and broadcasts a
// `providers:changed` frame; GET /api/agent-config?refresh=1 is the Re-Check equivalent.
//
// Same env pinning as agent-models-route.test.js — config.js reads these once at require time.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GLOBAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-agents-config-project-'));
const USER_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-agents-config-userdata-'));
process.env.TIPATASK_PROJECT_ROOT = GLOBAL_ROOT;
process.env.TIPATASK_USER_DATA = USER_DATA_ROOT;
process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const { test, after, beforeEach } = require('node:test');

const config = require('./config');
const { createHttpHandler } = require('./ws-handlers');
const { getTaskAgent } = require('./task-agent');
const websocket = require('./websocket');

after(() => {
  fs.rmSync(GLOBAL_ROOT, { recursive: true, force: true });
  fs.rmSync(USER_DATA_ROOT, { recursive: true, force: true });
});

const CREDS = { TASK_BACKEND: 'api', API_BASE_URL: 'http://127.0.0.1:1', API_TOKEN: 'tok-keep-me', API_PROJECT_ID: '7' };

function makeProject(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-agents-config-win-'));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({ ...CREDS, ...extra }));
  return root;
}

function fakeReq(method, url, headers = {}, body = '') {
  const req = { method, url, headers };
  req[Symbol.asyncIterator] = async function* () { if (body) yield body; };
  return req;
}

function fakeRes() {
  const res = { statusCode: null, body: '', writeHead(s) { res.statusCode = s; }, end(c) { res.body = c || ''; } };
  return res;
}

// Machine-independent detection: every agent's detect() is the one I/O seam swapped out.
let codexInstalled = false;
const detectCalls = { codex: 0 };
// (TPT567) The diagnostic payload every unavailable detect() carries — must reach the client.
const CODEX_DETAIL = { bin: 'C:\\Users\\Anton M\\AppData\\Roaming\\npm\\codex.cmd', exit: 1, output: 'Not logged in' };
// The model registry's I/O seam, swapped alongside detect(): an unavailable→available flip (and a
// Re-Check) now re-probes models, which must never spawn a real CLI scan from a unit test.
const probeCalls = { claude: 0, codex: 0, pi: 0 };
for (const id of ['claude', 'codex', 'pi']) {
  const agent = getTaskAgent(id);
  agent.probeModels = async () => { probeCalls[id] += 1; return []; };
  agent.getModelProbeKey = () => 'test-key';
  agent.detect = () => {
    if (id === 'codex') {
      detectCalls.codex += 1;
      return codexInstalled
        ? { id, label: agent.label, available: true, reason: null }
        : { id, label: agent.label, available: false, reason: 'Codex CLI not found', detail: CODEX_DETAIL };
    }
    return { id, label: agent.label, available: false, reason: 'not installed (test)' };
  };
}

const handler = createHttpHandler(new Map(), () => null, {});

// Capture broadcasts without a real WebSocketServer.
const sent = [];
websocket.init({ clients: new Set([{ readyState: 1, send: (m) => sent.push(JSON.parse(m)) }]) });

beforeEach(() => { sent.length = 0; });

async function getProviders(root) {
  const res = fakeRes();
  await handler(fakeReq('GET', '/api/objective/providers', { 'x-tipatask-project': root }), res);
  return JSON.parse(res.body).objectiveProviders;
}

test('Codex installed after boot: invisible until an agents save, then offered + broadcast', async () => {
  const root = makeProject({ AVAILABLE_AGENTS: 'codex', TASK_AGENT: 'codex' });
  try {
    codexInstalled = false;
    await getTaskAgent('codex').cachedDetect({}, true); // boot-time negative
    assert.equal((await getProviders(root)).find((p) => p.id === 'codex')?.selectable, false);

    codexInstalled = true; // user installs the CLI — peek surfaces still serve the cached negative
    assert.equal((await getProviders(root)).find((p) => p.id === 'codex')?.selectable, false);

    const res = fakeRes();
    await handler(fakeReq('POST', '/api/agents-config', { 'x-tipatask-project': root },
      JSON.stringify({ applyOnly: true, taskAgent: 'codex', availableAgents: ['codex'] })), res);
    assert.equal(res.statusCode, 200);

    const codex = (await getProviders(root)).find((p) => p.id === 'codex');
    assert.equal(codex.available, true);
    assert.equal(codex.selectable, true);
    assert.ok(codex.models.length > 0, 'codex offered with models');

    const frame = sent.find((m) => m.type === 'providers:changed');
    assert.ok(frame, 'providers:changed broadcast');
    assert.equal(frame.projectPath, root);
    assert.ok(frame.objectiveProviders.some((p) => p.id === 'codex' && p.selectable));
    assert.match(frame.objectiveSelection, /^codex:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The setup modal (agent-recheck.js notifyServerAgentsSaved) saves through Electron MAIN, which
// cannot reach this process's detect caches or WS clients, so it then posts THIS narrow shape —
// selection only, none of the Claude/Codex model fields Settings ▸ Edit Agents also sends.
test('setup-modal payload (applyOnly, no model fields): re-detects + broadcasts, touches neither disk nor model defaults', async () => {
  const root = makeProject({ AVAILABLE_AGENTS: 'codex', TASK_AGENT: 'codex', CLAUDE_MODEL: 'sonnet' });
  const cfgPath = path.join(root, '.tipatask', 'config.json');
  try {
    const diskBefore = fs.readFileSync(cfgPath, 'utf8');
    const claudeBefore = config.CLAUDE_MODEL;
    const codexBefore = config.CODEX_MODEL;
    const detectsBefore = detectCalls.codex;

    const res = fakeRes();
    await handler(fakeReq('POST', '/api/agents-config', { 'x-tipatask-project': root },
      JSON.stringify({ availableAgents: ['codex'], taskAgent: 'codex', applyOnly: true })), res);

    assert.equal(res.statusCode, 200);
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), diskBefore, 'applyOnly must not write the project config');
    assert.equal(config.CLAUDE_MODEL, claudeBefore, 'no claudeModel in the payload -> singleton default untouched');
    assert.equal(config.CODEX_MODEL, codexBefore, 'no codexModel in the payload -> singleton default untouched');
    assert.ok(detectCalls.codex > detectsBefore, 'a forced re-detect ran in this process');
    const frame = sent.find((m) => m.type === 'providers:changed');
    assert.ok(frame, 'providers:changed broadcast');
    assert.equal(frame.projectPath, root, 'scoped by the explicit x-tipatask-project header, not the boot project');
    assert.notEqual(frame.projectPath, GLOBAL_ROOT);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('non-applyOnly save writes AVAILABLE_AGENTS with codex and keeps credentials', async () => {
  const root = makeProject({ AVAILABLE_AGENTS: 'pi', TASK_AGENT: 'pi' });
  try {
    codexInstalled = true;
    const res = fakeRes();
    await handler(fakeReq('POST', '/api/agents-config', { 'x-tipatask-project': root },
      JSON.stringify({ taskAgent: 'codex', availableAgents: ['pi', 'codex'] })), res);
    assert.equal(res.statusCode, 200);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.tipatask', 'config.json'), 'utf8'));
    assert.deepEqual(onDisk.AVAILABLE_AGENTS.split(','), ['pi', 'codex']);
    for (const k of Object.keys(CREDS).filter((key) => key !== 'API_TOKEN')) assert.equal(onDisk[k], CREDS[k], `${k} preserved`);
    // The token is the account's: moved to the app-level store, never rewritten into config.json.
    assert.ok(!Object.hasOwn(onDisk, 'API_TOKEN'));
    assert.equal(require('./account-store').readAccount(CREDS.API_BASE_URL).token, CREDS.API_TOKEN, 'API_TOKEN preserved');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/agent-config?refresh=1 forces a re-detect; the bare route does not', async () => {
  codexInstalled = false;
  await getTaskAgent('codex').cachedDetect({}, true);
  codexInstalled = true;
  const before = detectCalls.codex;

  let res = fakeRes();
  await handler(fakeReq('GET', '/api/agent-config'), res);
  assert.equal(detectCalls.codex, before);
  const codexStatus = JSON.parse(res.body).agentStatuses.find((a) => a.id === 'codex');
  assert.equal(codexStatus.available, false);
  assert.deepEqual(codexStatus.detail, CODEX_DETAIL, 'GET /api/agent-config returns detect()\'s detail verbatim (TPT567)');

  res = fakeRes();
  await handler(fakeReq('GET', '/api/agent-config?refresh=1'), res);
  assert.equal(detectCalls.codex, before + 1);
  const codexNow = JSON.parse(res.body).agentStatuses.find((a) => a.id === 'codex');
  assert.equal(codexNow.available, true);
  assert.equal(codexNow.detail, undefined, 'a positive carries no detail');
  // A Re-Check also re-probes models off the request path and broadcasts once more when that
  // lands — drain it so its second frame can't leak into the next test's `sent` buffer.
  await waitFor(() => providerFrames().length >= 2);
});

// Re-Check used to re-detect and answer over plain HTTP only — an already-open objective chat
// (another window, or the same one behind the Settings modal) kept its stale provider list until
// something else repainted it. It now pushes `providers:changed` at once, then again when the
// forced model re-probe lands (a CLI installed after boot leaves the registry on its fallback).
async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const providerFrames = () => sent.filter((m) => m.type === 'providers:changed');

test('Re-Check broadcasts providers:changed immediately, then again after the forced model re-probe', async () => {
  const root = makeProject({ AVAILABLE_AGENTS: 'codex', TASK_AGENT: 'codex' });
  try {
    codexInstalled = false;
    await getTaskAgent('codex').cachedDetect({}, true); // boot-time negative
    codexInstalled = true; // user installs the CLI, then presses Re-Check
    const probesBefore = { ...probeCalls };

    const res = fakeRes();
    await handler(fakeReq('GET', '/api/agent-config?refresh=1', { 'x-tipatask-project': root }), res);
    assert.equal(res.statusCode, 200);

    // First push is synchronous with the request: fresh availability, no waiting on any probe.
    assert.ok(providerFrames().length >= 1, 'broadcast before the response returns');
    const first = providerFrames()[0];
    assert.equal(first.projectPath, root, 'scoped by the x-tipatask-project header, not the boot project');
    assert.ok(first.objectiveProviders.some((p) => p.id === 'codex' && p.selectable), 'availability already fresh');

    // Second push follows the forced re-probe.
    await waitFor(() => providerFrames().length >= 2);
    assert.equal(providerFrames()[1].projectPath, root);
    for (const id of ['claude', 'codex']) {
      assert.ok(probeCalls[id] > probesBefore[id], `${id} models were force re-probed`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the bare /api/agent-config route neither broadcasts nor re-probes models', async () => {
  const before = { ...probeCalls };
  const res = fakeRes();
  await handler(fakeReq('GET', '/api/agent-config'), res);
  assert.equal(res.statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(providerFrames().length, 0);
  assert.deepEqual(probeCalls, before);
});

test('Re-Check with a failing model re-probe still answers 200 and still sent the immediate push', async () => {
  const claude = getTaskAgent('claude');
  const original = claude.probeModels;
  claude.probeModels = async () => { throw new Error('probe exploded'); };
  const root = makeProject({ AVAILABLE_AGENTS: 'claude', TASK_AGENT: 'claude' });
  try {
    const res = fakeRes();
    await handler(fakeReq('GET', '/api/agent-config?refresh=1', { 'x-tipatask-project': root }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(providerFrames().length >= 1);
    await waitFor(() => providerFrames().length >= 2); // resolveModels() degrades to fallback, never rejects
  } finally {
    claude.probeModels = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
