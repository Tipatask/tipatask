import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { attachOriginalSpecPayload } from './objective-spec-payload.js';
import { attachNewTagsPayload } from './objective-new-tags.js';
import { resolveOriginPlan, attachSplitOriginPayload } from './objective-origin-task.js';
import { shouldCreateObjectiveParent } from './objective-parent-task.js';
import { buildUsedIds, upsertTaskEntry } from './utils.js';

const require = createRequire(import.meta.url);
const { createHttpHandler } = require('../server/ws-handlers.js');
// Browser-only dependencies are replaced at their imports. The actual single-card
// save function and HTTP handler execute, including the failed-preview fallback.
const source = fs.readFileSync(new URL('./chat-task-preview.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '')
  .replace(/^export \{[^}]+\};/gm, '')
  .replace(/^export /gm, '');

for (const provider of ['claude', 'codex', 'gemini', 'pi']) {
  for (const pinned of [false, true]) {
    test(`${provider} single-card save after resolve failure: ${pinned ? 'user Backlog retained' : 'planner zero assigned active sprint'}`, async () => {
      let persisted;
      let payload;
      const backend = {
        async getTasksUnfiltered() { return [{ id: 'TPT1', category: 'CODING', status: 'pending', priority: 42 }]; },
        async getSprints() { return [{ number: 42 }]; },
        async createSprint() { assert.fail('active sprint already exists'); },
        async overwriteRawWithRemap(body) {
          persisted = JSON.parse(body.match(/```json\s*\n([\s\S]*?)```/)[1]);
          return new Map();
        },
      };
      const handler = createHttpHandler(new Map(), () => backend);
      const context = {
        console, Date, Set, Map,
        state: { chatState: { providerType: provider, messages: [{ role: 'user', content: 'Improve product search' }] } },
        attachOriginalSpecPayload, attachNewTagsPayload, resolveOriginPlan, attachSplitOriginPayload,
        shouldCreateObjectiveParent, buildUsedIds, upsertTaskEntry,
        getObjectiveGroupingEnabled: () => false,
        projectHeader: () => ({}), isStartName: status => status === 'pending', startName: () => 'pending',
        async fetchWithRetry(url, options) {
          if (url.startsWith('./TODO.md')) return { ok: true, text: async () => '```json\n{"tasks":[]}\n```' };
          if (url === '/api/resolve-sprints') throw new Error('Preview resolution unavailable');
          assert.equal(url, '/api/todo');
          payload = JSON.parse(options.body.match(/```json\s*\n([\s\S]*?)```/)[1]);
          const req = { method: 'PUT', url, headers: {}, async *[Symbol.asyncIterator]() { yield options.body; } };
          const res = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
          await handler(req, res);
          assert.equal(res.status, 200, res.body);
          return { ok: true, clone: () => ({ json: async () => JSON.parse(res.body) }) };
        },
      };
      vm.runInNewContext(source + '\nglobalThis.save = saveTaskChange;', context);
      const change = { type: 'new', task: { id: 'TPT2', title: 'Product search', status: 'pending', category: 'CODING', priority: 0, _stepPinned: pinned } };
      await context.save(change, { msg: { cards: [change] } });
      assert.deepEqual(payload.newTaskPinnedIds, pinned ? ['TPT2'] : []);
      assert.equal(payload.tasks[0]._stepPinned, undefined);
      assert.equal(persisted.tasks[0].priority, pinned ? 0 : 42);
      assert.equal(persisted.newTaskPinnedIds, undefined);
    });
  }
}

// ── Save failure contract: one attempt, server message shown ──

// Runs the real saveTaskChange() against the real PUT /api/todo handler, handing the
// handler's actual status and body back the way fetch would.
async function saveSingleCard(backend) {
  const puts = [];
  const handler = createHttpHandler(new Map(), () => backend);
  const context = {
    console: { ...console, error() {}, warn() {} }, Date, Set, Map,
    state: { chatState: { providerType: 'claude', messages: [{ role: 'user', content: 'Improve product search' }] } },
    attachOriginalSpecPayload, attachNewTagsPayload, resolveOriginPlan, attachSplitOriginPayload,
    shouldCreateObjectiveParent, buildUsedIds, upsertTaskEntry,
    getObjectiveGroupingEnabled: () => false,
    projectHeader: () => ({}), isStartName: status => status === 'pending', startName: () => 'pending',
    async fetchWithRetry(url, options) {
      if (url.startsWith('./TODO.md')) return { ok: true, text: async () => '```json\n{"tasks":[]}\n```' };
      if (url === '/api/resolve-sprints') throw new Error('Preview resolution unavailable');
      puts.push(options);
      const req = { method: 'PUT', url, headers: {}, async *[Symbol.asyncIterator]() { yield options.body; } };
      const res = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
      await handler(req, res);
      const ok = res.status >= 200 && res.status < 300;
      return { ok, status: res.status, text: async () => res.body, clone: () => ({ json: async () => JSON.parse(res.body) }) };
    },
  };
  vm.runInNewContext(source + '\nglobalThis.save = saveTaskChange;', context);
  const change = { type: 'new', task: { id: 'TPT2', title: 'Product search', status: 'pending', category: 'CODING', priority: 5, tags: ['cleanup'] } };
  let error = null;
  try { await context.save(change, { msg: { cards: [change] } }); } catch (err) { error = err; }
  return { puts, error };
}

function savingBackend(overwriteRawWithRemap) {
  return {
    async getTasksUnfiltered() { return [{ id: 'TPT1', category: 'CODING', status: 'pending', priority: 42 }]; },
    async getSprints() { return [{ number: 42 }]; },
    async createSprint() {},
    overwriteRawWithRemap,
  };
}

test('single-card save sends the non-idempotent write exactly once', async () => {
  const { puts, error } = await saveSingleCard(savingBackend(async () => new Map()));
  assert.equal(error, null);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].label, 'todo-write-single');
  assert.equal(puts[0].retries, 1, 'fetchWithRetry must not resend a save that may have partly applied');
});

test('a rejected save surfaces the server message and the step that threw', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { puts, error } = await saveSingleCard(savingBackend(async () => {
    throw Object.assign(new Error('Unregistered tag(s) "cleanup" in project 16 (registry has 42 tags)'), {
      code: 'TAGS_UNREGISTERED', saveStep: 'tag-registry',
    });
  }));
  assert.equal(puts.length, 1);
  assert.ok(error, 'the save must reject');
  assert.equal(error.message, 'Unregistered tag(s) "cleanup" in project 16 (registry has 42 tags) (tag-registry)');
});

test('an unexpected server failure still shows its real message, not a bare HTTP 500', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { error } = await saveSingleCard(savingBackend(async () => { throw new Error('kaboom in persist'); }));
  assert.equal(error.message, 'kaboom in persist (persist)');
});

test('bulk Save Tasks sends its write once and keeps the failure toast readable', () => {
  const raw = fs.readFileSync(new URL('./chat-task-preview.js', import.meta.url), 'utf8');
  assert.match(raw, /const TODO_WRITE_ATTEMPTS = 1;/);
  assert.match(raw, /label: 'todo-write', retries: TODO_WRITE_ATTEMPTS/);
  assert.match(raw, /label: 'todo-write-single',\s+retries: TODO_WRITE_ATTEMPTS/);
  assert.match(raw, /translate\('chat\.errSaveTasks', \{ msg: err\.message \}\), 'error', \{ durationMs: SAVE_ERROR_TOAST_MS \}/);
  assert.match(raw, /translate\('chat\.errSaveTask', \{ msg: err\.message \}\), 'error', \{ durationMs: SAVE_ERROR_TOAST_MS \}/);
});
