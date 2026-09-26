'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const vm = require('node:vm');
const { createHttpHandler } = require('./ws-handlers');
const { readChatDraft } = require('./chat-persistence');
const config = require('./config');

const chatUiSource = fs.readFileSync(path.join(__dirname, '../client/chat-ui.js'), 'utf8');
function loadChatUiFunction(env, name) {
  const start = chatUiSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  const end = chatUiSource.indexOf('\n}', start) + 2;
  vm.runInContext(chatUiSource.slice(start, end), env);
}

function clientDraftPayload(chatState, draftRelationshipForSave) {
  const calls = [], timers = [];
  const state = { chatState, chatPersistEpoch: 0, cleanupInProgress: false };
  const env = {
    state, _saveDraftTimer: null, draftRelationshipForSave,
    syncChatHistoryMeta() {}, projectHeader: () => ({}),
    clearTimeout() {}, setTimeout: callback => { timers.push(callback); return timers.length; },
    fetchWithRetry: (url, options) => { calls.push({ url, options }); return Promise.resolve({ ok: true }); },
  };
  vm.createContext(env);
  loadChatUiFunction(env, 'rehashPayload');
  loadChatUiFunction(env, 'saveChatDraft');
  env.saveChatDraft();
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/objective/chat-draft');
  return JSON.parse(calls[0].options.body);
}

function clientRestore(draft, restoreDraftRelationship, legacySnapshot = null) {
  const env = { restoreDraftRelationship, normalizeChatMessages: messages => messages };
  vm.createContext(env);
  loadChatUiFunction(env, 'rehashPayload');
  loadChatUiFunction(env, 'chatStateFromDraft');
  return env.chatStateFromDraft(draft, legacySnapshot);
}

async function withDraftApi(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-draft-metadata-'));
  const previous = config.USER_DATA_ROOT;
  config.USER_DATA_ROOT = root;
  const handler = createHttpHandler(new Map(), () => ({}));
  async function request(method, payload, projectPath = '/fixture') {
    const req = Readable.from(payload ? [JSON.stringify(payload)] : []);
    Object.assign(req, { method, url: '/api/objective/chat-draft', headers: { 'x-tipatask-project': projectPath } });
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await handler(req, res);
    return { status: res.status, body: res.body };
  }
  try { await run({ request, read: () => readChatDraft('/fixture') }); }
  finally {
    config.USER_DATA_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('versioned objective relationship survives client -> HTTP -> disk -> restore and controls later saves', async () => {
  const { draftRelationshipForSave, restoreDraftRelationship } = await import('../client/chat-draft-metadata.js');
  const { resolveOriginPlan } = await import('../client/objective-origin-task.js');
  const { shouldCreateObjectiveParent } = await import('../client/objective-parent-task.js');
  await withDraftApi(async ({ request, read }) => {
    const messages = [{ role: 'user', content: 'Plan this work' }];
    const cases = [
      { name: 'web origin', state: { originTaskKey: 'TPT100' }, check(links) {
        assert.equal(resolveOriginPlan(links, 1).mode, 'single');
        assert.equal(resolveOriginPlan(links, 3).mode, 'parent');
      } },
      { name: 'manual child', state: { parentTaskKey: 'TPT42' }, check(links) {
        assert.equal(links.parentTaskKey, 'TPT42');
        assert.equal(shouldCreateObjectiveParent(links, 3), false);
      } },
      { name: 'partially saved objective', state: { objectiveParentKey: 'TPT88' }, check(links) {
        assert.equal(links.objectiveParentKey, 'TPT88');
        assert.equal(shouldCreateObjectiveParent(links, 3), false);
      } },
      { name: 'consumed web origin', state: { originTaskKey: 'TPT100', originResolution: 'single' }, check(links) {
        assert.equal(resolveOriginPlan(links, 1).mode, 'none');
      } },
      { name: 'split', state: { parentTaskKey: 'TPT210', rehashIntent: 'split', taskKey: 'TPT210' }, check(links) {
        assert.equal(resolveOriginPlan({ ...links, rehashIntent: 'split', taskKey: 'TPT210' }, 2, ['TPT211']).mode, 'split');
      } },
      { name: 'discuss', state: { rehashIntent: 'discuss', taskKey: 'TPT179' }, check(links) {
        assert.equal(links.parentTaskKey, null);
        assert.equal(links.originTaskKey, null);
      } },
    ];
    for (const [index, scenario] of cases.entries()) {
      const taskId = `obj-${index}`;
      const payload = clientDraftPayload({ taskId, messages, ...scenario.state }, draftRelationshipForSave);
      assert.equal((await request('POST', payload)).status, 200, scenario.name);
      const disk = await read();
      assert.equal(disk.draftVersion, 2, scenario.name);
      const { status, body } = await request('GET');
      assert.equal(status, 200);
      assert.equal(body.draftVersion, 2);
      for (const field of ['parentTaskKey', 'objectiveParentKey', 'originTaskKey', 'originResolution']) {
        assert.equal(body[field], payload[field], `${scenario.name}: ${field}`);
      }
      assert.equal(body.rehashIntent, scenario.state.rehashIntent || null);
      scenario.check(clientRestore(body, restoreDraftRelationship));
    }
  });
});

test('legacy draft borrows matching unsaved snapshot only for absent fields; explicit null and new chat clear links', async () => {
  const { draftRelationshipForSave, draftRelationshipNeedsLegacyFallback, restoreDraftRelationship } = await import('../client/chat-draft-metadata.js');
  await withDraftApi(async ({ request }) => {
    const messages = [{ role: 'user', content: 'Legacy work' }];
    const snapshot = { taskId: 'old', originTaskKey: 'TPT100', objectiveParentKey: 'TPT100', originResolution: 'parent', messages: [
      { cards: [{ type: 'new' }], acceptedMask: [true], confirmedMask: [false] },
    ] };
    assert.equal((await request('POST', { taskId: 'old', messages, rehashIntent: 'split', taskKey: 'TPT210' })).status, 200);
    const legacy = (await request('GET')).body;
    assert.equal(draftRelationshipNeedsLegacyFallback(legacy), true);
    assert.deepEqual(restoreDraftRelationship(legacy, snapshot), {
      parentTaskKey: 'TPT210', objectiveParentKey: 'TPT100', originTaskKey: 'TPT100', originResolution: 'parent',
    });
    assert.equal(restoreDraftRelationship(legacy, { ...snapshot, taskId: 'other' }).originTaskKey, null);
    const cleared = { taskId: 'old', messages, ...draftRelationshipForSave({}), rehashIntent: 'split', taskKey: 'TPT210' };
    assert.equal((await request('POST', cleared)).status, 200);
    const explicit = (await request('GET')).body;
    assert.equal(draftRelationshipNeedsLegacyFallback(explicit), false);
    assert.deepEqual(restoreDraftRelationship(explicit, snapshot), {
      parentTaskKey: null, objectiveParentKey: null, originTaskKey: null, originResolution: null,
    });
    assert.equal((await request('POST', { taskId: 'new', messages, ...draftRelationshipForSave({}) })).status, 200);
    const fresh = (await request('GET')).body;
    assert.equal(fresh.rehashIntent, null);
    assert.equal(fresh.originTaskKey, null);
    assert.equal(fresh.objectiveParentKey, null);
  });
});

test('versioned draft validates relationship fields and retains them across a same-chat history window merge', async () => {
  const { draftRelationshipForSave } = await import('../client/chat-draft-metadata.js');
  await withDraftApi(async ({ request, read }) => {
    const messages = [{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Second' }];
    const base = { taskId: 'obj-merge', messages, ...draftRelationshipForSave({ originTaskKey: 'TPT100' }) };
    assert.equal((await request('POST', base)).status, 200);
    assert.equal((await request('POST', { ...base, originTaskKey: 123 })).status, 400);
    assert.equal((await request('POST', { ...base, originResolution: 'unknown' })).status, 400);
    assert.equal((await request('POST', { ...base, originTaskKey: undefined })).status, 400);
    assert.equal((await read()).originTaskKey, 'TPT100');
    assert.equal((await request('POST', { taskId: 'obj-merge', messages })).status, 200);
    assert.equal((await read()).originTaskKey, 'TPT100');
    assert.equal((await request('POST', { taskId: 'obj-merge', messages: [messages[1]], historyWindowStart: 2 })).status, 200);
    const merged = (await request('GET')).body;
    assert.equal(merged.originTaskKey, 'TPT100');
    assert.equal(merged.draftVersion, 2);
    assert.equal(merged.messages.length, 2);
  });
});
