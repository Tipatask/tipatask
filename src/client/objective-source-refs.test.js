import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { attachOriginalSpecPayload, getOriginalSpec } from './objective-spec-payload.js';
import { attachNewTagsPayload } from './objective-new-tags.js';
import { resolveOriginPlan, attachSplitOriginPayload, previewOriginSingleTarget, outOfSubtreeModifiedIndexes } from './objective-origin-task.js';
import { buildUsedIds, upsertTaskEntry } from './utils.js';
import { normalizeSingleItemList } from './description-list.js';
import { hydrateModifiedCard, buildModifiedTaskPatch, applyModifiedCardToLiveTask, reconcileModifiedCards } from './modified-task-merge.js';
import { missingSourceRefsBlock } from '../server/spec-comment.js';

// Execute the actual save paths, replacing browser/network imports at the boundary.
const source = readFileSync(new URL('./chat-task-preview.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export \{[^}]+\};/gm, '').replace(/^export /gm, '');
const FIGMA_URL = 'https://www.figma.com/design/RcOVAPflBtbKMQZZw1ikSG/Seminar-Pages?node-id=1353-7890&p=f&m=dev';
const IMAGE_REF = '![img](https://tt.apppixies.com/api/projects/3/images/259)';
const QUOTE = 'Design The Life You Want to Live';
const OBJECTIVE = `Update just the Master Planning hero.\nUpdated in Figma ${FIGMA_URL} (open in my Chrome tab)\n${QUOTE}\n${IMAGE_REF}`;
const newCard = (description = 'Refresh hero with live event dates.', extra = {}) => ({
  type: 'new', task: { id: 'TPT1', title: 'Refresh Master Planning hero', description, category: 'CODING', status: 'pending', priority: 1, tags: [], dependencies: [] }, ...extra,
});

function fixture(cards, { objective = OBJECTIVE, lang = 'en', accepted = cards.map(() => true), tasks = [] } = {}) {
  cards.forEach((card, index) => { card.task.id = `TPT${index + 1}`; });
  const msg = { cards, acceptedMask: accepted, confirmedMask: [], _existingTasksSnapshot: new Map() };
  const cs = { messages: [{ role: 'user', content: objective }, msg] };
  const listeners = {}, writes = [], errors = [];
  const saveButton = { dataset: { msgIdx: '1' }, disabled: false };
  const env = {
    console, Date, Map, Set,
    state: { chatState: cs, currentUser: { id: 1 }, activeTab: 'objective', collapsedTiers: new Set(), expandedTiers: new Set() },
    document: { getElementById: () => ({ addEventListener: (event, handler) => { listeners[event] = handler; } }) },
    attachOriginalSpecPayload, getOriginalSpec, missingSourceRefsBlock, normalizeSingleItemList,
    attachNewTagsPayload, resolveOriginPlan, attachSplitOriginPayload, previewOriginSingleTarget, outOfSubtreeModifiedIndexes,
    hydrateModifiedCard, buildModifiedTaskPatch, applyModifiedCardToLiveTask, reconcileModifiedCards, buildUsedIds, upsertTaskEntry,
    getLocale: () => lang, getObjectiveGroupingEnabled: () => false, shouldCreateObjectiveParent: () => false,
    startName: () => 'pending', isStartName: status => status === 'pending', isLockedTargetStatus: () => false,
    loadStatuses: async () => [],
    projectHeader: () => ({}), captureCardEdits() {}, showSavingIndicator() {}, hideSavingIndicator() {},
    showSaveToast() {}, saveChatState() {}, discardUnsavedProposals() {}, cleanupChat() {}, repaintAfterSavedChatClosed() {},
    translate: (key, params) => params?.msg || key,
    showToast: (message, type) => { if (type === 'error') errors.push(message); },
    api: { tasks: { get: async id => ({ id, status: 'pending' }) } },
    async fetchWithRetry(url, options) {
      if (url.startsWith('./TODO.md')) return { ok: true, text: async () => '```json\n' + JSON.stringify({ tasks }) + '\n```' };
      if (url === '/api/resolve-sprints') return { ok: true, json: async () => ({ changes: [] }) };
      assert.equal(url, '/api/todo');
      writes.push(JSON.parse(options.body.match(/```json\s*\n([\s\S]*?)```/)[1]));
      return { ok: true, json: async () => ({}), clone: () => ({ json: async () => ({}) }) };
    },
  };
  vm.runInNewContext(source + '\nattachCardHandlers(); globalThis.save = saveTaskChange; globalThis.normalize = normalizeCardDescription;', env);
  return {
    msg, cs, env, writes,
    async save(bulk, card = cards[0]) {
      if (bulk) await listeners.click({ target: { closest: selector => selector === '.chat-save-btn' ? saveButton : null } });
      else await env.save(card, { msg });
      assert.deepEqual(errors, []);
      assert.ok(writes.length > 0, 'save must send a task payload');
      return writes.at(-1);
    },
  };
}

for (const bulk of [false, true]) {
  const path = bulk ? 'bulk Save Tasks' : 'single Accept';
  test(`${path} names only accepted writes and sends the base before modified-card merge`, async () => {
    const base = { id: 'TPT1', title: 'Original', description: 'Original body', status: 'pending', priority: 1, tags: [] };
    const untouched = { ...base, id: 'TPT99', status: 'in_progress' };
    const card = { type: 'modified', task: { id: base.id, title: 'Accepted title' } };
    const payload = await fixture([card], { tasks: [base, untouched] }).save(bulk);
    assert.deepEqual(payload.writeTaskIds, ['TPT1']);
    assert.deepEqual(payload.taskBases, [base]);
    assert.equal(payload.tasks[0].title, 'Accepted title');
    assert.deepEqual(payload.tasks[1], untouched);
  });

  test(`${path} names new writes without treating unrelated snapshot tasks as edited`, async () => {
    const untouched = { id: 'TPT99', title: 'Unrelated', description: 'Body', status: 'in_progress', priority: 1 };
    const payload = await fixture([newCard()], { tasks: [untouched] }).save(bulk);
    assert.deepEqual(payload.writeTaskIds, ['TPT1']);
    assert.deepEqual(payload.taskBases, []);
    assert.deepEqual(payload.newTaskIds, ['TPT1']);
  });
  test(`${path} persists dropped screenshot Figma URL and image, idempotently`, async () => {
    const card = newCard();
    const f = fixture([card]);
    const first = await f.save(bulk);
    const description = first.tasks[0].description;
    assert.ok(description.includes(FIGMA_URL));
    assert.ok(description.includes(IMAGE_REF));
    assert.equal((description.match(/### Source material/g) || []).length, 1);
    f.msg.confirmedMask = [];
    f.msg._inFlight = false;
    const second = await f.save(bulk);
    assert.equal(second.tasks[0].description, description);
  });

  test(`${path} restores refs when description was omitted`, async () => {
    const card = newCard();
    delete card.task.description;
    const payload = await fixture([card]).save(bulk);
    assert.ok(payload.tasks[0].description.includes(IMAGE_REF));
  });

  test(`${path} leaves already inlined sources unchanged`, async () => {
    const description = `Use [Figma](${FIGMA_URL}) and ${IMAGE_REF}`;
    const payload = await fixture([newCard(description)]).save(bulk);
    assert.equal(payload.tasks[0].description, description);
  });

  test(`${path} uses Ukrainian source heading`, async () => {
    const payload = await fixture([newCard()], { lang: 'uk' }).save(bulk);
    assert.ok(payload.tasks[0].description.includes('### Джерельні матеріали'));
  });

  test(`${path} keeps multi-card scope even when only one card is accepted`, async () => {
    const unrelated = newCard('Update infrastructure configuration.');
    const quoting = newCard(`Use copy “${QUOTE}” in the hero.`);
    const f = fixture([unrelated, quoting], { accepted: [true, false] });
    const payload = await f.save(bulk, unrelated);
    assert.equal(payload.tasks[0].description, 'Update infrastructure configuration.');
  });

  test(`${path} restores multi-card refs on a card quoting the objective`, async () => {
    const quoting = newCard(`Use copy “${QUOTE}” in the hero.`);
    const unrelated = newCard('Update infrastructure configuration.');
    const payload = await fixture([quoting, unrelated]).save(bulk, quoting);
    assert.ok(payload.tasks[0].description.includes(FIGMA_URL));
    assert.ok(payload.tasks[0].description.includes(IMAGE_REF));
    assert.ok(!unrelated.task.description.includes('### Source material'));
  });

  test(`${path} skips refs present in another batch description`, async () => {
    const quoting = newCard(`Copy “${QUOTE}”.`);
    const sources = newCard(`Use ${FIGMA_URL} and ${IMAGE_REF}`);
    const payload = await fixture([quoting, sources]).save(bulk, quoting);
    assert.equal(payload.tasks[0].description, `Copy “${QUOTE}”.`);
  });
}

test('source recovery skips modified/manual cards, blank objectives and render-only normalization', () => {
  for (const card of [newCard(undefined, { type: 'modified' }), newCard(undefined, { _manual: true })]) {
    const f = fixture([card]);
    const before = card.task.description;
    f.env.normalize(card, f.msg, f.cs);
    assert.equal(card.task.description, before);
  }
  const card = newCard();
  const f = fixture([card], { objective: ' ' });
  f.env.normalize(card, f.msg, f.cs);
  f.env.normalize(card);
  assert.equal(card.task.description, 'Refresh hero with live event dates.');
});

test('multi-card recovery recognizes block quotes and complete objective lines', () => {
  for (const description of [`> ${QUOTE}`, `Use copy: ${QUOTE}`]) {
    const card = newCard(description);
    const f = fixture([card, newCard('Unrelated work.')]);
    f.env.normalize(card, f.msg, f.cs);
    assert.ok(card.task.description.includes(IMAGE_REF));
  }
});

test('normalization uses the captured chat if the active tab changes during a save', () => {
  const card = newCard();
  const f = fixture([card]);
  f.env.state.chatState = { messages: [{ content: 'Other objective https://example.com/unrelated' }] };
  f.env.normalize(card, f.msg, f.cs);
  assert.ok(card.task.description.includes(FIGMA_URL));
  assert.ok(!card.task.description.includes('https://example.com/unrelated'));
});
