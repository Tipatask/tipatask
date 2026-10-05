import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import * as statuses from './status-registry.js';
import { t, setLocale } from './i18n.js';
import { normalizeSingleItemList } from './description-list.js';
import { reconcileModifiedCards } from './modified-task-merge.js';
import { previewOriginSingleTarget, outOfSubtreeModifiedIndexes } from './objective-origin-task.js';

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const preview = read('./chat-task-preview.js').replace(/^import[\s\S]*?;\n/gm, '')
  .replace(/^export \{[^}]+\};/gm, '').replace(/^export /gm, '');
const chat = read('./chat-ui.js');
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const empty = () => '';

function fixture(targetStatus, { type = 'modified', confirmed = false, origin = false } = {}) {
  const target = { id: 'TPT1', title: 'Existing target', status: targetStatus, priority: 1, tags: [], dependencies: [] };
  const card = { type, task: { id: type === 'new' ? 'TPT2' : target.id, title: 'Proposed change', description: 'Keep this specification.', priority: 1, category: 'CODING', tags: [], dependencies: [], status: 'pending' } };
  const msg = { cards: [card], acceptedMask: [true], confirmedMask: [confirmed], _existingTasksSnapshot: new Map([[target.id, target]]) };
  const dom = new JSDOM('<div id="chat-messages"></div>');
  const listeners = {}, writes = [], toasts = [];
  dom.window.document.getElementById('chat-messages').addEventListener = (name, fn) => { listeners[name] = fn; };
  const env = {
    ...statuses, Map, Set, Date, console, document: dom.window.document,
    state: { chatState: { messages: [msg], ...(origin ? { originTaskKey: target.id } : {}) } },
    translate: t, tc: t, escapeAttr: esc, normalizeSingleItemList, reconcileModifiedCards,
    previewOriginSingleTarget, outOfSubtreeModifiedIndexes, saveChatState() {},
    groupTitle: n => `Batch ${n}`, groupNoun: () => 'Batch',
    renderAgentBadge: empty, renderEffortBadge: empty, renderMemberBadge: empty,
    renderMarkdown: esc, truncateMarkdownAtParagraph: v => v, MAX_DESC_LEN: 500,
    unmetDependencyKeys: () => [], cardVariant: () => 'narrow', cardMaxWidthPx: () => 300,
    _measureTitle: () => 10, _CHAT_SVG: '', _WAND_SVG: '', getSprintsEnabled: () => true,
    renderSprintBadgeLabel: empty, buildSubtasksLabel: empty,
    projectHeader: () => ({}), captureCardEdits() {},
    fetchWithRetry: async (...args) => { writes.push(args); throw new Error('Unexpected write'); },
    api: { tasks: { get: async (...args) => { writes.push(args); throw new Error('Unexpected read'); } } },
    showToast: (...args) => toasts.push(args), cleanupChat() {}, repaintAfterSavedChatClosed() {},
  };
  vm.createContext(env);
  vm.runInContext(extract(read('./task-card.js'), 'renderCard') + '\nglobalThis.renderBoardCard = renderCard;', env);
  vm.runInContext(preview + '\n' + extract(chat, 'getUnsavedAcceptedCountForMsg'), env);
  const repaint = () => { dom.window.document.getElementById('chat-messages').innerHTML = env.renderCardHtml(msg, 0); };
  repaint();
  env.attachCardHandlers();
  return { dom, env, msg, card, target, writes, toasts, listeners, repaint, close: () => dom.window.close() };
}

for (const locale of ['en', 'uk']) {
  for (const custom of [false, true]) {
    test(`locked previews use target status and disable saves (${locale}, ${custom ? 'custom' : 'legacy'})`, async () => {
      setLocale(locale);
      if (custom) statuses.seedStatuses([
        { name: 'ready', is_workflow_start: true }, { name: 'working', is_in_progress: true },
        { name: 'shipped', is_workflow_complete: true }, { name: 'dropped', is_workflow_canceled: true },
      ]); else statuses.resetStatuses();
      try {
        for (const status of custom ? ['working', 'shipped', 'dropped'] : ['in_progress', 'completed', 'canceled']) {
          const f = fixture(status);
          try {
            const root = f.dom.window.document;
            const label = statuses.statusLabel(status);
            assert.ok(root.querySelector('.card.preview-card.locked-target'));
            assert.equal(root.querySelector('.change-target--locked').textContent, t('chat.lockedTargetBadge', { status: label }));
            assert.equal(root.querySelector('.change-target--locked').title, t('chat.lockedTargetError', { id: 'TPT1', status: label }));
            assert.equal(root.querySelector('.status').textContent, label);
            assert.equal(root.querySelector('.btn-accept-card').disabled, true);
            assert.equal(root.querySelector('.btn-accept-card').classList.contains('active'), false);
            assert.equal(root.querySelector('.step-selector').disabled, true);
            assert.equal(root.querySelector('.chat-save-btn').disabled, true);
            assert.equal(root.querySelector('.btn-reject-card').disabled, false);
            assert.equal(f.env.getUnsavedAcceptedCountForMsg(f.msg), 0);
            // Delegated handlers must also refuse synthetic clicks.
            await f.listeners.click({ target: root.querySelector('.btn-accept-card') });
            await f.listeners.click({ target: root.querySelector('.chat-save-btn') });
            assert.equal(f.writes.length, 0);
            assert.equal(f.toasts[0][0], t('chat.lockedTargetError', { id: 'TPT1', status: label }));
            assert.equal(f.msg.confirmedMask[0], false);
          } finally { f.close(); }
        }
      } finally { setLocale('en'); statuses.resetStatuses(); }
    });
  }
}

test('eligible, missing-snapshot, new and confirmed previews retain ordinary controls', () => {
  for (const options of [{ status: 'pending' }, { status: 'on_fire' }, { status: 'completed', type: 'new' }, { status: 'completed', confirmed: true }, { status: 'completed', missing: true }]) {
    const f = fixture(options.status, options);
    try {
      if (options.missing) { delete f.msg._existingTasksSnapshot; f.repaint(); }
      const root = f.dom.window.document;
      assert.equal(root.querySelector('.locked-target'), null);
      assert.equal(root.querySelector('.change-target--locked'), null);
      if (options.confirmed) assert.equal(root.querySelector('.btn-accept-card'), null);
      else {
        assert.equal(root.querySelector('.btn-accept-card').disabled, false);
        assert.equal(root.querySelector('.step-selector').disabled, false);
        assert.equal(root.querySelector('.chat-save-btn').disabled, false);
        assert.equal(f.env.getUnsavedAcceptedCountForMsg(f.msg), 1);
      }
    } finally { f.close(); }
  }
});

test('new card adopted onto a locked origin also shows the actual target status', () => {
  const f = fixture('completed', { type: 'new', origin: true });
  try {
    assert.equal(f.env.getLockedCardTarget(f.msg, 0), f.target);
    assert.ok(f.dom.window.document.querySelector('.locked-target'));
    assert.equal(f.dom.window.document.querySelector('.status').textContent, statuses.statusLabel('completed'));
  } finally { f.close(); }
});

test('mixed-card save readiness and bulk selection exclude only known locked targets', () => {
  const f = fixture('completed');
  try {
    f.msg.cards.push({ type: 'modified', task: { id: 'TPT3', title: 'Eligible change' } });
    f.msg._existingTasksSnapshot.set('TPT3', { id: 'TPT3', title: 'Pending task', status: 'pending', tags: [], dependencies: [] });
    f.msg.acceptedMask.push(true);
    f.msg.confirmedMask.push(false);
    f.repaint();
    assert.equal(f.env.getUnsavedAcceptedCountForMsg(f.msg), 1);
    assert.equal(f.dom.window.document.querySelector('.chat-save-btn').disabled, false);
    const start = preview.indexOf('      const mask = msg.acceptedMask', preview.indexOf('const saveBtn ='));
    const end = preview.indexOf('      if (acceptedChanges.length', start);
    vm.runInContext(`globalThis.selected = (() => { const msg = state.chatState.messages[0], cs = state.chatState;\n${preview.slice(start, end)}\nreturn acceptedChanges.map(c => c.cardIdx); })();`, f.env);
    assert.deepEqual(Array.from(f.env.selected), [1]);
    f.msg.confirmedMask[1] = true;
    f.env.updateSaveBar(0);
    assert.equal(f.dom.window.document.querySelector('.chat-save-btn').disabled, true);
    assert.equal(f.dom.window.document.querySelector('.chat-save-bar').classList.contains('resolved'), false);
    // A refreshed snapshot removes the UI lock without baking status into proposals.
    f.target.status = 'pending';
    f.env.updateSaveBar(0);
    assert.equal(f.dom.window.document.querySelector('.chat-save-btn').disabled, false);
    f.msg.confirmedMask[1] = false;
    f.repaint();
    assert.equal(f.dom.window.document.querySelector('.locked-target'), null);
    assert.equal(f.env.getUnsavedAcceptedCountForMsg(f.msg), 2);
    assert.equal(f.card.task.status, 'pending');
  } finally { f.close(); }
});

test('Reject stays available on locked previews and updates the acceptance mask', async () => {
  const f = fixture('in_progress');
  try {
    f.env.Event = f.dom.window.Event;
    await f.listeners.click({ target: f.dom.window.document.querySelector('.btn-reject-card') });
    assert.equal(f.msg.acceptedMask[0], false);
    assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});
