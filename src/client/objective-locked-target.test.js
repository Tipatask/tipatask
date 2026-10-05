import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import state from './state.js';
import { parseObjectiveResult, buildUsedIds, upsertTaskEntry } from './utils.js';
import { seedStatuses, resetStatuses, isLockedTargetStatus, statusLabel } from './status-registry.js';
import { t } from './i18n.js';
import { normalizeSingleItemList } from './description-list.js';
import { hydrateModifiedCard, buildModifiedTaskPatch, applyModifiedCardToLiveTask } from './modified-task-merge.js';
import { previewOriginSingleTarget } from './objective-origin-task.js';

const source = fs.readFileSync(new URL('./chat-task-preview.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export \{[^}]+\};/gm, '').replace(/^export /gm, '');
const rows = [
  { name: 'ready', is_workflow_start: true }, { name: 'working', is_in_progress: true },
  { name: 'shipped', is_workflow_complete: true }, { name: 'dropped', is_workflow_canceled: true },
  { name: 'review' },
];

test('empty server card result stays authoritative instead of reviving raw proposals', () => {
  const chat = fs.readFileSync(new URL('./chat-ui.js', import.meta.url), 'utf8');
  const lastMsg = { role: 'assistant' };
  const env = { cs: { messages: [lastMsg] }, msg: { cards: [] }, tab: null,
    notifyObjectiveCardsReady() {}, wsTabId: 'objective', lastMsg,
    parseObjectiveResult() { assert.fail('must not reparse rejected raw model proposals'); },
  };
  vm.createContext(env);
  const resultStart = chat.indexOf('      const lastMsgOR =');
  vm.runInContext(chat.slice(resultStart, chat.indexOf("    } else if (msg.type === 'chat-history-reset')", resultStart)), env);
  assert.deepEqual(lastMsg._serverCards, []);
  const parseStart = chat.indexOf('          let cards;');
  vm.runInContext(chat.slice(parseStart, chat.indexOf('          const lastMsgIdx', parseStart)) + '\nglobalThis.result = cards;', env);
  assert.deepEqual(env.result, []);
});

for (const custom of [false, true]) {
  test(`client parser filters locked live statuses (${custom ? 'custom' : 'legacy'})`, () => {
    if (custom) seedStatuses(rows); else resetStatuses();
    const statuses = custom ? ['ready', 'working', 'shipped', 'dropped', 'review'] : ['pending', 'in_progress', 'completed', 'canceled', 'on_fire'];
    const prior = state.taskStatusById;
    try {
      state.taskStatusById = new Map(statuses.map((status, i) => [`TPT${i}`, status]));
      const changes = statuses.map((_, i) => ({ type: 'modified', task: { id: `TPT${i}`, status: 'pending', title: 'Change' } }));
      changes.push({ type: 'new', task: { id: 'TPT9', title: 'New' } });
      const result = parseObjectiveResult('```json\n' + JSON.stringify({ changes }) + '\n```');
      assert.deepEqual(result.changes.map(c => c.task.id), ['TPT0', 'TPT4', 'TPT9']);
    } finally { state.taskStatusById = prior; resetStatuses(); }
  });
}

function fixture(status, { bulk = false, scoped = false, origin = false } = {}) {
  const dom = new JSDOM('<div id="chat-messages"><div class="preview-card"><button class="btn-accept-card" data-msg-idx="0" data-card-idx="0"></button><button class="btn-reject-card"></button></div><button class="chat-save-btn" data-msg-idx="0"></button></div>');
  const listeners = {}, writes = [], toasts = [], reads = [];
  dom.window.document.getElementById('chat-messages').addEventListener = (name, fn) => { listeners[name] = fn; };
  const card = { type: origin ? 'new' : 'modified', task: { id: origin ? 'TPT9' : 'TPT1', title: 'Edited', tags: [] } };
  const msg = { cards: bulk ? [{ type: 'new', task: { id: 'TPT8', title: 'New', status: 'pending' } }, card] : [card], acceptedMask: bulk ? [true, true] : [true], confirmedMask: bulk ? [false, false] : [false] };
  const live = { id: 'TPT1', title: 'Live', status, tags: [], priority: 0 };
  const env = {
    document: dom.window.document, console: { ...console, error() {}, warn() {} }, Date, Set, Map,
    state: { chatState: { messages: [msg] } }, translate: t, statusLabel, isLockedTargetStatus,
    loadStatuses: async () => {}, projectHeader: () => ({}), buildUsedIds, upsertTaskEntry,
    hydrateModifiedCard, buildModifiedTaskPatch, applyModifiedCardToLiveTask,
    normalizeSingleItemList, previewOriginSingleTarget,
    startName: () => 'pending', isStartName: s => s === 'pending',
    resolveOriginPlan: () => ({ mode: origin ? 'single' : 'none', originTaskKey: origin ? 'TPT1' : null }),
    originConflictCardIndexes: () => [], adoptOriginKey: c => { c.type = 'modified'; c.task.id = 'TPT1'; },
    api: { tasks: {
      get: async id => { reads.push(id); if (status === 'offline') throw new Error('offline'); return status == null ? null : live; },
      update: async (...args) => { writes.push(args); },
    } },
    async fetchWithRetry(url, opts) {
      if (url.startsWith('./TODO.md')) return { ok: true, text: async () => '```json\n' + JSON.stringify({ tasks: scoped ? [{ ...live, status: 'pending' }] : [] }) + '\n```' };
      writes.push({ url, opts });
      throw new Error('Unexpected write');
    },
    captureCardEdits() {}, showSavingIndicator() {}, hideSavingIndicator() {}, saveChatState() {},
    showToast: (...args) => toasts.push(args),
  };
  vm.runInNewContext(source + '\nattachCardHandlers(); globalThis.save = saveTaskChange;', env);
  return { dom, env, msg, card, writes, reads, toasts, click: () => listeners.click({ target: dom.window.document.querySelector(bulk ? '.chat-save-btn' : '.btn-accept-card') }) };
}

for (const status of ['in_progress', 'completed', 'canceled', 'working', 'shipped', 'dropped']) {
  for (const bulk of [false, true]) {
    for (const scoped of [false, true]) {
      test(`${bulk ? 'bulk' : 'single'} Save shows error and writes nothing for ${status}, ${scoped ? 'stale' : 'absent'} snapshot`, async () => {
        if (['working', 'shipped', 'dropped'].includes(status)) seedStatuses(rows); else resetStatuses();
        const f = fixture(status, { bulk, scoped });
        try {
          await f.click();
          assert.deepEqual(f.reads, ['TPT1']);
          assert.equal(f.writes.length, 0);
          assert.equal(f.toasts.length, 1);
          assert.match(f.toasts[0][0], /Task TPT1 cannot be changed/);
          assert.equal(f.toasts[0][1], 'error');
          assert.equal(f.msg.confirmedMask.some(Boolean), false);
        } finally { f.dom.window.close(); resetStatuses(); }
      });
    }
  }
}

for (const status of [null, 'offline']) {
  test(`unverifiable target fails closed: ${status}`, async () => {
    const f = fixture(status);
    try {
      await assert.rejects(f.env.save(f.card, { msg: f.msg }), /Cannot verify|offline/);
      assert.equal(f.writes.length, 0);
    } finally { f.dom.window.close(); }
  });
}

test('origin adoption cannot bypass locked target check', async () => {
  const f = fixture('completed', { origin: true });
  try {
    await assert.rejects(f.env.save(f.card, { msg: f.msg }), /cannot be changed/);
    assert.deepEqual(f.reads, ['TPT1']);
    assert.equal(f.writes.length, 0);
  } finally { f.dom.window.close(); }
});

for (const status of ['pending', 'on_fire', 'ready', 'review']) {
  test(`eligible modification still PATCHes ${status} target`, async () => {
    if (['ready', 'review'].includes(status)) seedStatuses(rows); else resetStatuses();
    const f = fixture(status);
    try {
      await f.env.save(f.card, { msg: f.msg });
      assert.deepEqual(f.reads, ['TPT1']);
      assert.equal(f.writes.length, 1);
      assert.equal(f.writes[0][0], 'TPT1');
      assert.equal(f.writes[0][1].title, 'Edited');
      assert.equal(f.writes[0][1].status, undefined);
    } finally { f.dom.window.close(); resetStatuses(); }
  });
}
