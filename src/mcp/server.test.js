'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Read the registration as source: requiring server.js starts the stdio transport.
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('create_task_comment sends completion reports through complete_task and keeps blocked reports available', () => {
  const match = source.match(/server\.tool\(\s*'create_task_comment',\s*`([^`]*)`/);
  assert.ok(match, 'create_task_comment must have a tool description');
  const description = match[1];
  assert.match(description, /complete_task\(task_key, resolution\)/);
  assert.match(description, /type: "resolution".*completion status after verification/);
  assert.match(description, /only when completion is blocked.*on_fire/);
  assert.doesNotMatch(description, /SAME tool-call batch/i);
  assert.match(description, /plain English prose/);
  assert.match(description, /never in a compressed\/caveman style/);
  assert.match(description, /type='comment'/);
  assert.match(description, /type='spec'/);
});

// ── list_task_id_meta: reservation placeholders ──
// The registration block is run as source in a vm context (server.js calls main() on
// load, so it cannot be require()d) with only the backend/cache/status reads stubbed; the
// key-math and placeholder helpers are the real modules the handler imports.
const vm = require('node:vm');
const { maxNumbersByPrefix } = require('../server/task-key-format');
const { isReservationPlaceholder, RESERVED_PLACEHOLDER_DESCRIPTION } = require('../server/reservation-placeholder');

function listTaskIdMetaHandler(tasks) {
  const start = source.indexOf('// ── list_task_id_meta ──');
  const end = source.indexOf('// ── list_tasks ──', start);
  assert.ok(start >= 0 && end > start, 'list_task_id_meta registration block must exist');
  const tools = new Map();
  vm.runInNewContext(source.slice(start, end), {
    server: { tool: (name, _description, _schema, handler) => tools.set(name, handler) },
    ensureKbSynced() {},
    ensureBackend: async () => {},
    backend: {},
    taskCache: { getTasks: async () => tasks },
    fetchStatusContext: async () => ({ active: new Set(['pending', 'in_progress', 'on_fire']) }),
    maxNumbersByPrefix,
    isReservationPlaceholder,
    projectId: 2,
    projectScopeNote: '',
  });
  const handler = tools.get('list_task_id_meta');
  assert.ok(handler, 'list_task_id_meta must be registered');
  return handler;
}

test('list_task_id_meta drops reservation placeholders from active but counts their keys in maxByPrefix', async () => {
  const tasks = [
    { id: 'TPT10', projectId: 2, title: 'Real work', category: 'CODING', status: 'pending', priority: 5, tags: ['tt-mcp-server'], isReservation: false },
    { id: 'TPT11', projectId: 2, title: 'New task', category: 'CODING', status: 'pending', priority: 0, tags: [], description: RESERVED_PLACEHOLDER_DESCRIPTION },
    { id: 'TPT12', projectId: 2, title: 'New task', category: 'CODING', status: 'pending', priority: 0, tags: [], isReservation: true },
    { id: 'H3', projectId: 2, title: 'Done', category: 'HUMAN', status: 'completed', priority: 1, tags: [], isReservation: false },
  ];
  const reply = await listTaskIdMetaHandler(tasks)({});
  const meta = JSON.parse(reply.content[0].text);
  assert.deepEqual(meta.active.map(t => t.id), ['TPT10']);
  assert.deepEqual(meta.maxByPrefix, { TPT: 12, H: 3 });
  assert.equal(meta.maxCId, 0);
  assert.equal(meta.maxHId, 3);
  assert.equal(meta.project_id, 2);
});

// ── create_task: keys come from the allocator only (TPT9004) ──
// Same vm-slice technique as above: the create_task + reserve_task_keys registration block
// (which also declares the per-process sessionReservedKeys Set) runs with the backend/cache/
// status reads stubbed. normalizeTaskKey is lifted from the server source; the key-format and
// placeholder helpers are the real modules the handler imports.
const { isValidTaskKey } = require('../server/task-key-format');

function zodForHarness() {
  try { return require('zod').z; } catch { /* schemas are not exercised by the handlers */ }
  const chain = new Proxy(function () {}, { get: () => () => chain, apply: () => chain });
  return chain;
}

function createTaskHarness({ liveById = {}, created = { id: 'TPT9005' } } = {}) {
  const start = source.indexOf('  // ── create_task ──');
  const end = source.indexOf('  // ── purge_stale_reservations ──', start);
  assert.ok(start >= 0 && end > start, 'create_task + reserve_task_keys registration block must exist');
  const normalizeSrc = source.match(/function normalizeTaskKey\(raw\) \{[\s\S]*?\n\}\n/);
  assert.ok(normalizeSrc, 'normalizeTaskKey must be defined in the server source');
  const tools = new Map();
  const calls = { create: [], update: [], reserve: [], getTask: [] };
  const backend = {
    async createTask(task) { calls.create.push(task); return { ...task, id: created.id }; },
    async updateTask(id, fields) { calls.update.push({ id, fields }); return { id, ...fields }; },
    async getTask(id) { calls.getTask.push(id); return liveById[id] ?? null; },
    async reserveTaskKeys({ count, category }) {
      const keys = Array.from({ length: count }, (_, i) => `${category === 'HUMAN' ? 'H' : 'TPT'}${9100 + i}`);
      calls.reserve.push(keys);
      return { keys, tasks: keys.map(id => ({ id })) };
    },
    async createSprint() {},
  };
  vm.runInNewContext(normalizeSrc[0] + source.slice(start, end), {
    server: { tool: (name, _description, _schema, handler) => tools.set(name, handler) },
    ensureKbSynced() {},
    ensureBackend: async () => {},
    backend,
    taskCache: { getTasks: async () => [], invalidate() {} },
    fetchStatusContext: async () => ({
      names: ['pending', 'in_progress', 'on_fire', 'completed', 'canceled'],
      roles: { start: 'pending', in_progress: 'in_progress' },
      active: new Set(['pending', 'in_progress', 'on_fire']),
    }),
    resolveCreatePriority: () => ({ priority: 1, reason: 'stub' }),
    applyDependencyFloor: ({ priority }) => ({ priority, bumped: false }),
    isValidTaskKey,
    isReservationPlaceholder,
    z: zodForHarness(),
    process: { env: {}, stderr: { write() {} } },
    console: { error() {}, warn() {}, log() {} },
    projectId: 2,
    projectScopeNote: '',
  });
  const createTask = tools.get('create_task');
  const reserveKeys = tools.get('reserve_task_keys');
  assert.ok(createTask && reserveKeys, 'both tools must be registered by the slice');
  return { createTask, reserveKeys, calls };
}

const CREATE_ARGS = { title: 'Follow-up', description: 'Filed mid-task', category: 'CODING', dependencies: [], tags: [], priority: 399 };

test('create_task refuses a caller-supplied key that reserve_task_keys never returned in this session', async () => {
  const { createTask, calls } = createTaskHarness();
  const reply = await createTask({ ...CREATE_ARGS, task_key: 'TPT9001' });
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /"TPT9001" was not returned by mcp__tipatask__reserve_task_keys in this session/);
  assert.match(reply.content[0].text, /Omit task_key/);
  assert.equal(calls.create.length + calls.update.length, 0, 'nothing is written');
});

test('create_task still rejects a descriptive-slug key with the C1482 message', async () => {
  const { createTask, calls } = createTaskHarness();
  const reply = await createTask({ ...CREATE_ARGS, task_key: 'C-kb-dev-scripts' });
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /Invalid task_key/);
  assert.equal(calls.create.length + calls.update.length, 0);
});

test('create_task without task_key creates keyless and reports the key the API allocated', async () => {
  const { createTask, calls } = createTaskHarness({ created: { id: 'TPT9005' } });
  const reply = await createTask({ ...CREATE_ARGS });
  assert.equal(reply.isError, undefined, reply.content[0].text);
  assert.equal(calls.create.length, 1);
  assert.equal('id' in calls.create[0], false, 'no key leaves the tool');
  assert.equal(calls.create[0].title, 'Follow-up');
  assert.equal(calls.create[0].priority, 399);
  assert.equal(calls.update.length, 0);
  assert.equal(JSON.parse(reply.content[0].text).task.id, 'TPT9005');
});

test('create_task finalizes a key this session reserved by PATCH, without touching the assignee', async () => {
  const { createTask, reserveKeys, calls } = createTaskHarness({
    liveById: { TPT9100: { id: 'TPT9100', title: 'New task', description: RESERVED_PLACEHOLDER_DESCRIPTION, status: 'pending', isReservation: true } },
  });
  const reserved = JSON.parse((await reserveKeys({ count: 1, category: 'CODING' })).content[0].text);
  assert.deepEqual(reserved.keys, ['TPT9100']);
  const reply = await createTask({ ...CREATE_ARGS, task_key: 'tpt9100' });
  assert.equal(reply.isError, undefined, reply.content[0].text);
  assert.equal(calls.create.length, 0, 'a reserved key is never re-POSTed');
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].id, 'TPT9100', 'normalized before lookup');
  assert.equal('assignee' in calls.update[0].fields, false, 'the reservation keeps its creator stamp');
  assert.equal(calls.update[0].fields.title, 'Follow-up');
  assert.equal(JSON.parse(reply.content[0].text).task.id, 'TPT9100');
  const again = await createTask({ ...CREATE_ARGS, task_key: 'TPT9100' });
  assert.equal(again.isError, true, 'a consumed reservation cannot be reused');
});

test('create_task refuses a reserved key whose placeholder is already finalized or gone', async () => {
  const { createTask, reserveKeys, calls } = createTaskHarness({
    liveById: { TPT9100: { id: 'TPT9100', title: 'Already real', description: 'finalized elsewhere', status: 'pending', isReservation: false } },
  });
  await reserveKeys({ count: 2, category: 'CODING' });
  const finalized = await createTask({ ...CREATE_ARGS, task_key: 'TPT9100' });
  assert.equal(finalized.isError, true);
  assert.match(finalized.content[0].text, /no longer an unfinalized reservation placeholder/);
  const gone = await createTask({ ...CREATE_ARGS, task_key: 'TPT9101' });
  assert.equal(gone.isError, true, 'getTask returned null for the purged row');
  assert.equal(calls.create.length + calls.update.length, 0);
});
