import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { attachOriginalSpecPayload, getOriginalSpec } from './objective-spec-payload.js';
import { missingSourceRefsBlock } from '../server/spec-comment.js';
import { attachNewTagsPayload } from './objective-new-tags.js';
import { resolveOriginPlan, attachSplitOriginPayload } from './objective-origin-task.js';
import { shouldCreateObjectiveParent } from './objective-parent-task.js';
import { buildUsedIds, upsertTaskEntry, parseObjectiveResult } from './utils.js';
import { normalizeSingleItemList } from './description-list.js';
import { previewOriginSingleTarget, outOfSubtreeModifiedIndexes } from './objective-origin-task.js';
import { reconcileModifiedCards } from './modified-task-merge.js';

const require = createRequire(import.meta.url);
const { createHttpHandler } = require('../server/ws-handlers.js');
// Browser-only dependencies are replaced at their imports. The actual single-card
// save function and HTTP handler execute, including the failed-preview fallback.
const source = fs.readFileSync(new URL('./chat-task-preview.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '')
  .replace(/^export \{[^}]+\};/gm, '')
  .replace(/^export /gm, '');

// Run both real client save paths through the real resolve and persistence handlers.
// Provider output is parsed exactly as it is after a handoff; only external IO is stubbed.
async function savePriorityProposals(provider, bulk, proposals) {
  let persisted;
  const existing = [
    { id: 'TPT1', category: 'CODING', status: 'pending', priority: 400 },
    { id: 'TPT2', category: 'CODING', status: 'in_progress', priority: 423 },
  ];
  const backend = {
    async getTasksUnfiltered() { return existing; },
    async getSprints() { return [400, 423, 424, 450].map(number => ({ number })); },
    async createSprint() { assert.fail('all required sprints already exist'); },
    async overwriteRawWithRemap(body) {
      persisted = JSON.parse(body.match(/```json\s*\n([\s\S]*?)```/)[1]);
      return new Map();
    },
  };
  const handler = createHttpHandler(new Map(), () => backend);
  const { changes: cards } = parseObjectiveResult('```json\n' + JSON.stringify({ changes: proposals }) + '\n```');
  const msg = { cards, acceptedMask: cards.map(() => true), confirmedMask: [], _existingTasksSnapshot: new Map(existing.map(t => [t.id, t])) };
  const cs = { providerType: provider, messages: [{ role: 'user', content: 'Fix urgent agent maintenance; keep optional suggestions and requested Backlog choices' }, msg] };
  const listeners = {}, errors = [];
  const context = {
    console, Date, Set, Map,
    state: { chatState: cs, currentUser: { id: 1 }, activeTab: 'objective', collapsedTiers: new Set(), expandedTiers: new Set() },
    document: { getElementById: () => ({ addEventListener: (event, fn) => { listeners[event] = fn; } }) },
    attachOriginalSpecPayload, getOriginalSpec, missingSourceRefsBlock, getLocale: () => 'en', attachNewTagsPayload, resolveOriginPlan, attachSplitOriginPayload,
    previewOriginSingleTarget, outOfSubtreeModifiedIndexes, reconcileModifiedCards, normalizeSingleItemList,
    shouldCreateObjectiveParent, buildUsedIds, upsertTaskEntry, getObjectiveGroupingEnabled: () => false,
    projectHeader: () => ({}), isStartName: status => status === 'pending', startName: () => 'pending', loadStatuses: async () => [],
    captureCardEdits() {}, showSavingIndicator() {}, hideSavingIndicator() {}, showSaveToast() {}, saveChatState() {},
    discardUnsavedProposals() {}, cleanupChat() {}, repaintAfterSavedChatClosed() {},
    translate: (key, params) => params?.msg || key, showToast: (text, type) => { if (type === 'error') errors.push(text); },
    async fetchWithRetry(url, options) {
      if (url.startsWith('./TODO.md')) return { ok: true, text: async () => '```json\n' + JSON.stringify({ tasks: existing }) + '\n```' };
      const req = { method: options.method, url, headers: {}, async *[Symbol.asyncIterator]() { yield options.body; } };
      const res = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
      await handler(req, res);
      assert.equal(res.status, 200, res.body);
      return { ok: true, json: async () => JSON.parse(res.body), clone: () => ({ json: async () => JSON.parse(res.body) }) };
    },
  };
  vm.runInNewContext(source + '\nattachCardHandlers(); globalThis.save = saveTaskChange;', context);
  if (bulk) {
    const button = { dataset: { msgIdx: '1' }, disabled: false };
    await listeners.click({ target: { closest: selector => selector === '.chat-save-btn' ? button : null } });
  } else {
    for (const card of cards) await context.save(card, { msg });
  }
  assert.deepEqual(errors, []);
  assert.ok(persisted, 'save must reach persistence');
  return persisted;
}

for (const provider of ['claude', 'codex', 'gemini', 'pi']) {
  for (const bulk of [false, true]) {
    for (const scenario of [
      { title: 'Urgent agent maintenance', priority: 423, tags: ['tt-task-agent', 'bugfix'] },
      { title: 'Dependent agent maintenance', priority: 424, dependencies: ['TPT2'], tags: ['tt-task-agent', 'bugfix'] },
      { title: 'Optional workflow suggestion', priority: 0, tags: ['tt-performance-suggestions'] },
      { title: 'Explicit Backlog request', priority: 0, _stepPinned: true },
      { title: 'Explicit later sprint request', priority: 450, _stepPinned: true },
    ]) {
      test(`${provider} ${bulk ? 'Save Tasks' : 'Accept'} preserves ${scenario.title}`, async () => {
        const result = await savePriorityProposals(provider, bulk, [{ type: 'new', task: {
          id: 'TPT3', description: 'Verify planning priority survives save.', category: 'CODING', status: 'pending', ...scenario,
        } }]);
        const saved = result.tasks.find(t => t.id === 'TPT3');
        assert.equal(saved.priority, scenario.priority);
        assert.equal(saved._stepPinned, undefined, 'intent pin is transport-only');
        assert.equal(result.newTaskPinnedIds, undefined, 'intent metadata never reaches persistence');
      });
    }
  }
  test(`${provider} Save Tasks preserves a mixed maintenance and optional-suggestion batch`, async () => {
    const proposals = [
      { id: 'TPT3', title: 'Urgent maintenance', priority: 423, tags: ['tt-task-agent', 'bugfix'] },
      { id: 'TPT4', title: 'Dependent maintenance', priority: 424, dependencies: ['TPT3'] },
      { id: 'TPT5', title: 'Optional workflow suggestion', priority: 0, tags: ['tt-performance-suggestions'] },
      { id: 'TPT6', title: 'Explicit Backlog request', priority: 0, _stepPinned: true },
    ].map(task => ({ type: 'new', task: { category: 'CODING', status: 'pending', ...task } }));
    const result = await savePriorityProposals(provider, true, proposals);
    assert.deepEqual(result.tasks.filter(t => ['TPT3', 'TPT4', 'TPT5', 'TPT6'].includes(t.id)).map(t => t.priority), [423, 424, 0, 0]);
  });
}

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
        attachOriginalSpecPayload, getOriginalSpec, missingSourceRefsBlock, getLocale: () => 'en', attachNewTagsPayload, resolveOriginPlan, attachSplitOriginPayload,
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
    attachOriginalSpecPayload, getOriginalSpec, missingSourceRefsBlock, getLocale: () => 'en', attachNewTagsPayload, resolveOriginPlan, attachSplitOriginPayload,
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
