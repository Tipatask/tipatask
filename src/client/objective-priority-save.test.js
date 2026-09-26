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
