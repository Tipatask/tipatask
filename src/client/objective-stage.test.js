import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import * as statuses from './status-registry.js';
import { t, tc, setLocale, LOCALES } from './i18n.js';
import { normalizeSingleItemList } from './description-list.js';
import { reconcileModifiedCards } from './modified-task-merge.js';
import { previewOriginSingleTarget, outOfSubtreeModifiedIndexes } from './objective-origin-task.js';
import {
  OBJECTIVE_STAGES, OBJECTIVE_EXAMPLE_COUNT, SAVED_NOTE_MS,
  objectiveStageInfo, objectiveStageDetail, renderObjectiveStageHtml, syncObjectiveStageSlot,
  renderObjectiveGuideHtml, objectiveExampleText, applyObjectiveExample,
  noteObjectiveSaved, clearObjectiveSaved,
} from './objective-stage.js';

// (TPT9391) The New Objective view's guidance: the stage line, the empty-state guide, the
// labelled proposal controls and the pinned save bar. objective-stage.js is imported for real;
// the proposal cards run chat-task-preview.js in a vm with the board's own renderCard(), the
// recipe locked-target-preview.test.js uses.

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const cardsMsg = (n, { rejected = [], confirmed = [] } = {}) => ({
  role: 'assistant',
  cards: Array.from({ length: n }, (_, i) => ({ type: 'new', task: { id: `new-${i}`, title: `Proposal ${i + 1}`, description: 'Do the thing.', priority: 1, category: 'CODING', tags: [], dependencies: [], status: 'pending' } })),
  acceptedMask: Array.from({ length: n }, (_, i) => !rejected.includes(i)),
  confirmedMask: Array.from({ length: n }, (_, i) => confirmed.includes(i)),
});
const pending = msg => msg.cards.filter((_, i) => msg.acceptedMask[i] && !msg.confirmedMask[i]).length;

test.beforeEach(() => { setLocale('en'); clearObjectiveSaved(); });

test('the stage follows a run: planning, proposals ready, saving, saved', () => {
  assert.deepEqual(OBJECTIVE_STAGES, ['planning', 'ready', 'saving', 'saved']);
  assert.equal(objectiveStageInfo({ chatState: null }), null, 'the empty composer has no stage');

  const user = { role: 'user', content: 'Plan it' };
  assert.deepEqual(objectiveStageInfo({ chatState: { messages: [user, { role: 'assistant', streaming: true }] }, streaming: true }),
    { stage: 'planning', count: 0 });
  assert.equal(objectiveStageInfo({ chatState: { messages: [user, { role: 'assistant', content: 'Which page?' }] } }), null,
    'a reply without proposals has nothing to report');

  for (const n of [1, 5]) {
    const msg = cardsMsg(n);
    const cs = { messages: [user, msg] };
    assert.deepEqual(objectiveStageInfo({ chatState: cs, pendingCount: pending(msg) }), { stage: 'ready', count: n });
    msg._inFlight = true;
    assert.deepEqual(objectiveStageInfo({ chatState: cs, pendingCount: pending(msg) }), { stage: 'saving', count: n });
    msg._inFlight = false;
    msg.confirmedMask = msg.confirmedMask.map(() => true);
    assert.deepEqual(objectiveStageInfo({ chatState: cs, pendingCount: pending(msg) }), { stage: 'saved', count: n });
  }

  // A new turn over old proposals is planning again; all rejected is still "ready", with none.
  const rejected = cardsMsg(2, { rejected: [0, 1] });
  assert.deepEqual(objectiveStageInfo({ chatState: { messages: [rejected] }, pendingCount: 0 }), { stage: 'ready', count: 0 });
  assert.deepEqual(objectiveStageInfo({ chatState: { messages: [cardsMsg(2), { streaming: true }] }, streaming: true, pendingCount: 2 }),
    { stage: 'planning', count: 0 });
});

test('a bulk save carries "saved" over the chat it closes, until a chat is on screen or it ages out', () => {
  noteObjectiveSaved(3, 1000);
  assert.deepEqual(objectiveStageInfo({ chatState: null, now: 2000 }), { stage: 'saved', count: 3 });
  assert.equal(objectiveStageInfo({ chatState: null, now: 1000 + SAVED_NOTE_MS + 1 }), null);
  assert.equal(objectiveStageInfo({ chatState: null, now: 2000 }), null, 'an expired note is dropped');

  noteObjectiveSaved(2, 1000);
  assert.equal(objectiveStageInfo({ chatState: { messages: [] }, now: 1500 }), null);
  assert.equal(objectiveStageInfo({ chatState: null, now: 1600 }), null, 'a chat on screen ends the note');
});

test('the stage line marks the current step and says what is happening, in every language', () => {
  for (const locale of Object.keys(LOCALES)) {
    setLocale(locale);
    for (const [info, done, current] of [
      [{ stage: 'planning', count: 0 }, [], 'planning'],
      [{ stage: 'ready', count: 1 }, ['planning'], 'ready'],
      [{ stage: 'ready', count: 5 }, ['planning'], 'ready'],
      [{ stage: 'saving', count: 5 }, ['planning', 'ready'], 'saving'],
      [{ stage: 'saved', count: 5 }, OBJECTIVE_STAGES, null],
    ]) {
      const dom = new JSDOM(`<div id="slot">${renderObjectiveStageHtml(info)}</div>`);
      const line = dom.window.document.querySelector('#objective-stage');
      assert.equal(line.dataset.stage, info.stage);
      const steps = [...line.querySelectorAll('.objective-stage-step')];
      assert.deepEqual(steps.map(s => s.dataset.step), OBJECTIVE_STAGES);
      assert.deepEqual(steps.map(s => s.querySelector('.objective-stage-name').textContent), OBJECTIVE_STAGES.map(s => t(`chat.stage.${s}`)));
      assert.deepEqual(steps.filter(s => s.classList.contains('is-done')).map(s => s.dataset.step), done);
      assert.deepEqual(steps.filter(s => s.classList.contains('is-current')).map(s => s.dataset.step), current ? [current] : []);
      assert.equal(line.querySelector('[aria-current="step"]').dataset.step, info.stage);
      const detail = line.querySelector('.objective-stage-detail');
      assert.equal(detail.getAttribute('role'), 'status');
      assert.equal(detail.textContent, objectiveStageDetail(info));
      assert.ok(detail.textContent.trim() && !detail.textContent.startsWith('chat.'), `${locale} ${info.stage} detail is translated`);
      if (info.count > 0 && info.stage !== 'saving') assert.ok(detail.textContent.includes(String(info.count)));
      dom.window.close();
    }
  }
  assert.equal(renderObjectiveStageHtml(null), '');
  setLocale('en');
  assert.equal(objectiveStageDetail({ stage: 'ready', count: 1 }), '1 proposal is ready. Reject it if you do not need it, then choose Save Tasks.');
  assert.equal(objectiveStageDetail({ stage: 'saved', count: 0 }), 'The tasks were added to the board.');
  assert.equal(objectiveStageDetail({ stage: 'ready', count: 0 }), t('chat.stage.noneDetail'));
});

test('a mounted stage line is patched in place, keeping its live region', () => {
  const dom = new JSDOM('<div id="slot"></div>');
  const slot = dom.window.document.getElementById('slot');
  assert.equal(syncObjectiveStageSlot(null, { stage: 'ready', count: 1 }), false);

  syncObjectiveStageSlot(slot, { stage: 'ready', count: 4 });
  const line = slot.querySelector('.objective-stage');
  const detail = line.querySelector('.objective-stage-detail');
  assert.equal(line.dataset.stage, 'ready');

  syncObjectiveStageSlot(slot, { stage: 'ready', count: 3 });
  assert.equal(slot.querySelector('.objective-stage-detail'), detail, 'same status node');
  assert.equal(detail.textContent, tc('chat.stage.readyDetail', 3));

  syncObjectiveStageSlot(slot, { stage: 'saving', count: 3 });
  assert.equal(slot.querySelector('.objective-stage'), line);
  assert.equal(line.dataset.stage, 'saving');
  assert.equal(line.querySelector('.is-current').dataset.step, 'saving');
  assert.deepEqual([...line.querySelectorAll('.is-done')].map(s => s.dataset.step), ['planning', 'ready']);
  assert.ok(line.querySelector('[data-step="ready"] .objective-stage-dot svg'), 'a finished step shows a tick');
  assert.equal(line.querySelector('[aria-current="step"]').dataset.step, 'saving');
  assert.equal(detail.textContent, t('chat.stage.savingDetail'));

  syncObjectiveStageSlot(slot, null);
  assert.equal(slot.innerHTML, '');
  dom.window.close();
});

test('the empty-state guide explains the three steps and offers examples that fill the composer', () => {
  for (const locale of Object.keys(LOCALES)) {
    setLocale(locale);
    const dom = new JSDOM(renderObjectiveGuideHtml());
    const guide = dom.window.document.getElementById('objective-guide');
    assert.deepEqual([...guide.querySelectorAll('.objective-guide-heading')].map(h => h.textContent),
      [t('chat.guide.nextTitle'), t('chat.guide.examplesTitle')]);
    const steps = [...guide.querySelectorAll('.objective-guide-step')];
    assert.equal(steps.length, 3);
    steps.forEach((step, i) => {
      assert.equal(step.querySelector('strong').textContent, t(`chat.guide.step${i + 1}Title`));
      assert.ok(step.textContent.includes(t(`chat.guide.step${i + 1}`)));
    });
    const examples = [...guide.querySelectorAll('button.objective-example')];
    assert.equal(examples.length, OBJECTIVE_EXAMPLE_COUNT);
    examples.forEach((btn, i) => {
      assert.equal(btn.getAttribute('type'), 'button');
      assert.equal(btn.dataset.example, String(i));
      assert.equal(btn.textContent, objectiveExampleText(i));
      assert.ok(!btn.textContent.startsWith('chat.'), `${locale} example ${i + 1} is translated`);
    });
    dom.window.close();
  }
  setLocale('en');
  const [first, second] = [objectiveExampleText(0), objectiveExampleText(1)];
  assert.equal(objectiveExampleText(OBJECTIVE_EXAMPLE_COUNT), '');
  assert.equal(applyObjectiveExample('', 0), first);
  assert.equal(applyObjectiveExample('  \n', 0), first);
  assert.equal(applyObjectiveExample(first, 1), second, 'another example replaces the one picked before');
  assert.equal(applyObjectiveExample('My own brief  \n', 1), `My own brief\n\n${second}`, 'the user\'s own text is kept');
  assert.equal(applyObjectiveExample(`My own brief\n\n${second}`, 1), `My own brief\n\n${second}`, 'no duplicate');
  assert.equal(applyObjectiveExample('kept', 99), 'kept');
});

test('every string of the guidance exists in all four languages', () => {
  const keys = Object.keys(LOCALES.en).filter(k => /^chat\.(guide|stage|card|saveBar)\.|^chat\.(cardsIntro|filesAddressed|docUpdates)$/.test(k));
  assert.ok(keys.length >= 40, `expected the TPT9391 copy, got ${keys.length} keys`);
  for (const locale of ['uk', 'zh', 'es']) {
    for (const key of keys) {
      // uk has three count forms; every other key matches en one to one (i18n.test.js).
      assert.ok(LOCALES[locale][key]?.trim(), `${locale}.${key}`);
    }
    for (const base of ['chat.stage.readyDetail', 'chat.stage.savedDetail', 'chat.saveBar.ready']) {
      setLocale(locale);
      for (const n of [1, 2, 5, 21]) assert.ok(tc(base, n).includes(String(n)), `${locale} ${base} ${n}`);
    }
  }
  assert.ok(LOCALES.uk['chat.saveBar.ready.few'] && LOCALES.uk['chat.stage.readyDetail.few'] && LOCALES.uk['chat.stage.savedDetail.few']);
});

// ── Proposal cards and the save bar: chat-task-preview.js in a vm ──
const previewSrc = read('./chat-task-preview.js').replace(/^import[\s\S]*?;\n/gm, '')
  .replace(/^export \{[^}]+\};/gm, '').replace(/^export /gm, '');
const chatSrc = read('./chat-ui.js');
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const empty = () => '';

function proposals(n, options) {
  const msg = cardsMsg(n, options);
  const dom = new JSDOM('<div id="chat-messages"></div>');
  const listeners = {};
  const stageSyncs = [];
  const root = dom.window.document.getElementById('chat-messages');
  root.addEventListener = (name, fn) => { listeners[name] = fn; };
  const env = {
    ...statuses, Map, Set, Date, console, document: dom.window.document,
    state: { chatState: { messages: [msg] } },
    translate: t, tc, escapeAttr: esc, normalizeSingleItemList, reconcileModifiedCards,
    previewOriginSingleTarget, outOfSubtreeModifiedIndexes, saveChatState() {},
    syncObjectiveStage: () => stageSyncs.push(pending(msg)), noteObjectiveSaved() {},
    groupTitle: k => `Batch ${k}`, groupNoun: () => 'Batch',
    renderAgentBadge: empty, renderEffortBadge: empty, renderMemberBadge: empty,
    renderMarkdown: esc, truncateMarkdownAtParagraph: v => v, MAX_DESC_LEN: 500,
    unmetDependencyKeys: () => [], cardVariant: () => 'narrow', cardMaxWidthPx: () => 300,
    dependencyKeysMarkup: keys => keys.map(esc).join(', '),
    _measureTitle: () => 10, _CHAT_SVG: '', _WAND_SVG: '', getSprintsEnabled: () => true,
    renderSprintBadgeLabel: empty, buildSubtasksLabel: empty, collapseCard() {},
    projectHeader: () => ({}), captureCardEdits() {}, cleanupChat() {}, repaintAfterSavedChatClosed() {},
    countPendingSubtaskCards: () => 0, showToast() {},
  };
  vm.createContext(env);
  vm.runInContext(extract(read('./task-card.js'), 'renderCard') + '\nglobalThis.renderBoardCard = renderCard;', env);
  vm.runInContext(previewSrc + '\n' + extract(chatSrc, 'getUnsavedAcceptedCountForMsg'), env);
  root.innerHTML = `<div class="chat-bubble chat-bubble--assistant">${env.renderCardHtml(msg, 0)}</div>`;
  env.attachCardHandlers();
  return { dom, env, msg, root, listeners, stageSyncs, close: () => dom.window.close() };
}

for (const n of [1, 5]) {
  test(`${n} proposal(s): every card names its controls and its state, and one save bar carries the count`, () => {
    statuses.resetStatuses();
    for (const locale of ['en', 'uk']) {
      setLocale(locale);
      const f = proposals(n, n > 1 ? { rejected: [1] } : {});
      try {
        const cards = [...f.root.querySelectorAll('.preview-card')];
        assert.equal(cards.length, n);
        assert.equal(f.root.querySelector('.chat-cards-intro').textContent, t('chat.cardsIntro'));
        cards.forEach((card, i) => {
          const isRejected = n > 1 && i === 1;
          const foot = card.querySelector(':scope > .preview-card-actions');
          assert.ok(foot, 'the foot is the card\'s own child, so a rejected card can dim everything else');
          const accept = foot.querySelector('.btn-accept-card');
          const reject = foot.querySelector('.btn-reject-card');
          assert.equal(accept.querySelector('.preview-card-action-label').textContent, t('chat.card.accept'));
          assert.equal(reject.querySelector('.preview-card-action-label').textContent, t('chat.card.reject'));
          assert.equal(accept.getAttribute('title'), t('chat.card.acceptTitle'));
          assert.equal(reject.getAttribute('title'), t('chat.card.rejectTitle'));
          assert.equal(reject.getAttribute('aria-pressed'), String(isRejected));
          for (const btn of [accept, reject]) {
            assert.equal(btn.getAttribute('type'), 'button');
            assert.equal(btn.querySelector('svg').getAttribute('aria-hidden'), 'true');
          }
          const chip = foot.querySelector('.preview-card-state');
          assert.equal(chip.dataset.state, isRejected ? 'rejected' : 'included');
          assert.equal(chip.textContent, t(`chat.card.state.${isRejected ? 'rejected' : 'included'}`));
          assert.equal(card.classList.contains('rejected'), isRejected);
        });

        const bars = f.root.querySelectorAll('.chat-save-bar');
        assert.equal(bars.length, 1);
        const bar = bars[0];
        const ready = n > 1 ? n - 1 : 1;
        assert.equal(bar.parentElement.lastElementChild, bar, 'the bar closes its reply bubble');
        assert.ok(bar.parentElement.classList.contains('chat-bubble--assistant'));
        assert.equal(bar.classList.contains('resolved'), false);
        assert.equal(bar.querySelector('.save-bar-count').textContent, tc('chat.saveBar.ready', ready));
        assert.equal(bar.querySelector('.chat-save-btn').textContent, t('chat.saveBar.save'));
        assert.equal(bar.querySelector('.chat-discard-btn').textContent, t('chat.saveBar.discard'));
      } finally { f.close(); }
    }
    setLocale('en');
    const f = proposals(n);
    try {
      assert.equal(f.root.querySelector('.save-bar-count').textContent, n === 1 ? '1 task ready to save' : '5 tasks ready to save');
    } finally { f.close(); }
  });
}

test('Reject updates the card\'s state, the save bar count and the stage line without a repaint', async () => {
  statuses.resetStatuses();
  setLocale('en');
  const f = proposals(5);
  try {
    const card = f.root.querySelectorAll('.preview-card')[2];
    await f.listeners.click({ target: card.querySelector('.btn-reject-card') });
    assert.equal(f.msg.acceptedMask[2], false);
    assert.equal(card.querySelector('.preview-card-state').dataset.state, 'rejected');
    assert.equal(card.querySelector('.preview-card-state').textContent, 'Rejected');
    assert.equal(card.querySelector('.btn-reject-card').getAttribute('aria-pressed'), 'true');
    assert.equal(f.root.querySelector('.save-bar-count').textContent, '4 tasks ready to save');
    assert.equal(f.stageSyncs.at(-1), 4, 'the stage line was re-synced after the mask changed');
  } finally { f.close(); }
});

test('wiring: the view mounts the stage slot and the guide, and the save paths drive the stage', () => {
  const render = chatSrc.slice(chatSrc.indexOf('export function renderObjectiveContent('), chatSrc.indexOf('export function refreshObjectiveContent('));
  assert.match(render, /<div class="objective-stage-slot" id="objective-stage-slot">\$\{renderObjectiveStage\(\)\}<\/div>\s*\$\{guideHtml\}\s*<div class="chat-body">/);
  assert.match(render, /const guideHtml = !state\.chatState && !discussKey && !subtaskCtx && !originTaskKey\s*\? renderObjectiveGuideHtml\(\) : '';/);
  assert.equal((render.match(/renderComposerHeader\(/g) || []).length, 1, 'one heading row: the Create modal\'s own');
  assert.doesNotMatch(render, /<h[12]\b/, 'no second title inside the view');
  assert.match(chatSrc, /guide\.addEventListener\('click'[\s\S]{0,400}applyObjectiveExample\(chatInput\.value, Number\(btn\.dataset\.example\)\)[\s\S]{0,300}dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/);

  const preview = read('./chat-task-preview.js');
  assert.match(preview, /msg\._inFlight = true;\s*saveBtn\.disabled = true;\s*showSavingIndicator\(\);\s*syncObjectiveStage\(\);/);
  assert.match(preview, /msg\._inFlight = false;\s*saveBtn\.disabled = false;\s*syncObjectiveStage\(\);/);
  assert.match(preview, /if \(cs === state\.chatState\) noteObjectiveSaved\(acceptedChanges\.length\);/);
  assert.match(preview, /export function updateSaveBar\(targetMsgIdx\) \{\s*if \(!state\.chatState\) return;\s*refreshSubtaskSummary\(\);\s*syncObjectiveStage\(\);/);
});

test('styles: the save bar is pinned in the transcript and the composer is attached to it', () => {
  const css = read('./styles.css');
  const rule = selector => {
    const start = css.indexOf(`\n  ${selector} {`);
    assert.notEqual(start, -1, `${selector} rule`);
    return css.slice(start, css.indexOf('\n  }', start));
  };
  const bar = rule('.chat-bubble--assistant > .chat-save-bar:not(.resolved)');
  assert.match(bar, /position: sticky;/);
  assert.match(bar, /bottom: calc\(-1 \* var\(--objective-well-pad, 0px\)\);/);
  assert.match(bar, /background: var\(--c-bg-card\);/);
  const composer = css.slice(css.lastIndexOf('\n  .objective-chat--active .chat-input-area {'));
  assert.match(composer.slice(0, composer.indexOf('\n  }')), /border: 0;\s*border-top: 1px solid var\(--objective-edge\);\s*border-radius: 0;\s*box-shadow: none;/);
  assert.match(rule('.preview-card.rejected > :not(.preview-card-actions)'), /opacity: 0\.5;/);
  assert.doesNotMatch(rule('.preview-card.rejected'), /opacity/);
  // Secondary copy of the guidance never uses the muted token (under 4.5:1 in light palettes).
  const guidance = css.slice(css.indexOf('  .chat-container {\n    --objective-edge:'), css.indexOf('── Composer header: the Create modal\'s heading row ──'));
  assert.ok(guidance.length > 2000);
  assert.doesNotMatch(guidance.replace(/\/\*[\s\S]*?\*\//g, ''), /--c-text-muted/);
});
