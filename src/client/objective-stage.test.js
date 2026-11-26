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
  OBJECTIVE_GUIDE_ID, OBJECTIVE_HELP_BUTTON_ID, objectiveGuideOpen, setObjectiveGuideOpen,
  captureObjectiveGuide, restoreObjectiveGuide, bindObjectiveGuideDismiss,
} from './objective-stage.js';
import state from './state.js';
import { renderComposerHeader } from './composer-header.js';

// (TPT9391) The New Objective view's guidance: the stage line, the empty-state guide, the
// labelled proposal controls and the pinned save bar. objective-stage.js is imported for real;
// the proposal cards run chat-task-preview.js in a vm with the board's own renderCard(), the
// recipe locked-target-preview.test.js uses. (TPT9405) The guide is a popover behind the (?)
// button composer-header.js renders; both run for real in jsdom.

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

// (TPT9404) One slim row: a dot, the current stage's name, its "n/4" counter and one sentence.
function readStageLine(line) {
  const count = line.querySelector('.objective-stage-count');
  return {
    stage: line.dataset.stage,
    parts: [...line.children].map(el => el.className),
    names: [...line.querySelectorAll('.objective-stage-name')].map(el => el.textContent),
    digits: count.querySelector('[aria-hidden="true"]').textContent,
    label: count.querySelector('.objective-stage-count-label').textContent,
    detail: line.querySelector('.objective-stage-detail'),
  };
}

test('the stage line shows only the current stage: a dot, its name, an n/4 counter and one sentence, in every language', () => {
  for (const locale of Object.keys(LOCALES)) {
    setLocale(locale);
    for (const info of [
      { stage: 'planning', count: 0 },
      { stage: 'ready', count: 1 },
      { stage: 'ready', count: 5 },
      { stage: 'ready', count: 0 },
      { stage: 'saving', count: 5 },
      { stage: 'saved', count: 5 },
      { stage: 'saved', count: 0 },
    ]) {
      const n = OBJECTIVE_STAGES.indexOf(info.stage) + 1;
      const dom = new JSDOM(`<div id="slot">${renderObjectiveStageHtml(info)}</div>`);
      const line = dom.window.document.querySelector('#objective-stage');
      const read = readStageLine(line);
      const where = `${locale} ${info.stage} ${info.count}`;
      assert.equal(read.stage, info.stage);
      assert.deepEqual(read.parts, ['objective-stage-dot', 'objective-stage-name', 'objective-stage-count', 'objective-stage-detail'], where);
      assert.deepEqual(read.names, [t(`chat.stage.${info.stage}`)], `${where}: one stage name, the current one`);
      assert.equal(read.digits, `${n}/${OBJECTIVE_STAGES.length}`);
      assert.equal(read.label, t('chat.stage.step', { n, total: OBJECTIVE_STAGES.length }));
      assert.ok(read.label.includes(String(n)) && !read.label.startsWith('chat.'), `${where}: the counter's spoken label is translated`);
      const dot = line.querySelector('.objective-stage-dot');
      assert.equal(dot.getAttribute('aria-hidden'), 'true');
      assert.equal(dot.textContent, '');
      assert.equal(read.detail.getAttribute('role'), 'status');
      assert.equal(read.detail.textContent, objectiveStageDetail(info));
      assert.ok(read.detail.textContent.trim() && !read.detail.textContent.startsWith('chat.'), `${where}: the sentence is translated`);
      if (info.count > 0 && info.stage !== 'saving') assert.ok(read.detail.textContent.includes(String(info.count)));
      assert.equal(line.textContent, read.names[0] + read.digits + read.label + read.detail.textContent, `${where}: no other text`);
      assert.equal(line.querySelectorAll('ol, li, svg, [aria-current]').length, 0, `${where}: no step list`);
      dom.window.close();
    }
  }
  assert.equal(renderObjectiveStageHtml(null), '');
  assert.equal(renderObjectiveStageHtml({ stage: 'unknown', count: 1 }), '');
  setLocale('en');
  assert.equal(objectiveStageDetail({ stage: 'ready', count: 1 }), 'Review 1 proposal, then Save Tasks.');
  assert.equal(objectiveStageDetail({ stage: 'saved', count: 0 }), 'Tasks added to the board.');
  assert.equal(objectiveStageDetail({ stage: 'ready', count: 0 }), t('chat.stage.noneDetail'));
  assert.equal(t('chat.stage.step', { n: 2, total: 4 }), 'Step 2 of 4');
});

test('every stage sentence is six words or fewer in every language', () => {
  const sentenceKey = /^chat\.stage\.[a-z]+Detail(Plain)?(\.(one|few|many))?$/;
  for (const locale of Object.keys(LOCALES)) {
    const keys = Object.keys(LOCALES[locale]).filter(k => sentenceKey.test(k));
    assert.ok(keys.length >= 8, `${locale}: expected the stage sentences, got ${keys.length}`);
    for (const key of keys) {
      const text = LOCALES[locale][key];
      if (locale === 'zh') {
        // No spaces to count words by: six words is about a dozen characters.
        const han = text.match(/\p{Script=Han}/gu) || [];
        assert.ok(han.length <= 12, `${locale}.${key}: ${han.length} characters — "${text}"`);
      } else {
        const words = text.split(/\s+/).filter(w => /[\p{L}\p{N}{]/u.test(w));
        assert.ok(words.length <= 6, `${locale}.${key}: ${words.length} words — "${text}"`);
      }
    }
  }
});

test('a mounted stage line is patched in place through all four stages, keeping its live region', () => {
  setLocale('en');
  const dom = new JSDOM('<div id="slot"></div>');
  const slot = dom.window.document.getElementById('slot');
  assert.equal(syncObjectiveStageSlot(null, { stage: 'ready', count: 1 }), false);

  syncObjectiveStageSlot(slot, { stage: 'planning', count: 0 });
  const line = slot.querySelector('.objective-stage');
  const name = line.querySelector('.objective-stage-name');
  const detail = line.querySelector('.objective-stage-detail');
  assert.equal(line.dataset.stage, 'planning');

  for (const [info, digits] of [
    [{ stage: 'ready', count: 4 }, '2/4'],
    [{ stage: 'ready', count: 3 }, '2/4'],
    [{ stage: 'saving', count: 3 }, '3/4'],
    [{ stage: 'saved', count: 3 }, '4/4'],
    [{ stage: 'planning', count: 0 }, '1/4'],
  ]) {
    assert.equal(syncObjectiveStageSlot(slot, info), true);
    assert.equal(slot.querySelector('.objective-stage') === line, true, `${info.stage}: same line`);
    assert.equal(slot.querySelector('.objective-stage-name') === name, true, `${info.stage}: same name node`);
    assert.equal(slot.querySelector('.objective-stage-detail') === detail, true, `${info.stage}: same status node`);
    const read = readStageLine(line);
    assert.equal(read.stage, info.stage);
    assert.deepEqual(read.names, [t(`chat.stage.${info.stage}`)]);
    assert.equal(read.digits, digits);
    assert.equal(read.label, `Step ${digits[0]} of 4`);
    assert.equal(detail.textContent, objectiveStageDetail(info));
    assert.equal(line.querySelectorAll('.objective-stage-name').length, 1);
  }
  assert.equal(detail.textContent, t('chat.stage.planningDetail'));

  // A slot holding a line without the parts (an earlier build's markup) is rendered afresh.
  slot.innerHTML = '<div class="objective-stage" data-stage="ready"><ol class="objective-stage-steps"></ol></div>';
  syncObjectiveStageSlot(slot, { stage: 'saving', count: 2 });
  assert.equal(readStageLine(slot.querySelector('.objective-stage')).digits, '3/4');
  assert.equal(slot.querySelectorAll('ol').length, 0);

  syncObjectiveStageSlot(slot, null);
  assert.equal(slot.innerHTML, '');
  syncObjectiveStageSlot(slot, { stage: 'unknown', count: 1 });
  assert.equal(slot.innerHTML, '');
  dom.window.close();
});

test('the empty-state guide explains the three steps and offers examples that fill the composer', () => {
  for (const locale of Object.keys(LOCALES)) {
    setLocale(locale);
    const dom = new JSDOM(renderObjectiveGuideHtml());
    const guide = dom.window.document.getElementById('objective-guide');
    assert.equal(guide.tagName, 'SECTION');
    assert.equal(guide.hidden, true, `${locale}: closed until the (?) button opens it`);
    assert.equal(guide.getAttribute('aria-label'), t('chat.guide.help'));
    assert.ok(!guide.getAttribute('aria-label').startsWith('chat.'), `${locale}: the popover's name is translated`);
    assert.deepEqual([...guide.querySelectorAll('.objective-guide-heading')].map(h => h.textContent),
      [t('chat.guide.nextTitle'), t('chat.guide.examplesTitle')]);
    const steps = [...guide.querySelectorAll('.objective-guide-step')];
    assert.equal(steps.length, 3);
    steps.forEach((step, i) => {
      assert.equal(step.querySelector('strong').textContent, t(`chat.guide.step${i + 1}Title`));
      assert.ok(step.textContent.includes(t(`chat.guide.step${i + 1}`)));
      assert.equal(step.querySelector('.objective-guide-step-text').textContent,
        `${t(`chat.guide.step${i + 1}Title`)} ${t(`chat.guide.step${i + 1}`)}`, 'one run of text: the title, a space, what happens');
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

// (TPT9405) The heading row as the Objective view renders it — the (?) button, its closed popover
// and History — over the composer, with a control outside the dialog.
function helpPage({ locale = 'en', mode = 'objective' } = {}) {
  setLocale(locale);
  const previous = state.activeTab;
  state.activeTab = mode;
  try {
    const header = renderComposerHeader('<button class="btn-archive" id="btn-archive">History</button>', '',
      { helpHtml: renderObjectiveGuideHtml() });
    return new JSDOM(`<!doctype html><body><div class="chat-container">${header}`
      + '<div class="chat-body"><textarea id="chat-input"></textarea></div></div>'
      + '<button id="outside">Board</button></body>', { pretendToBeVisual: true });
  } finally {
    state.activeTab = previous;
  }
}

test('the heading\'s (?) button sits ahead of History and controls the closed guide, in New Objective only', () => {
  assert.equal(OBJECTIVE_GUIDE_ID, 'objective-guide');
  assert.equal(OBJECTIVE_HELP_BUTTON_ID, 'objective-help-btn');
  for (const locale of Object.keys(LOCALES)) {
    const dom = helpPage({ locale });
    const doc = dom.window.document;
    const actions = doc.querySelector('.composer-header-inner > .composer-header-actions');
    assert.deepEqual([...actions.children].map(el => el.id), [OBJECTIVE_HELP_BUTTON_ID, OBJECTIVE_GUIDE_ID, 'btn-archive'],
      `${locale}: the popover follows its button, so it is next in the Tab order`);
    const btn = doc.getElementById(OBJECTIVE_HELP_BUTTON_ID);
    assert.equal(btn.className, 'objective-help-btn');
    assert.equal(btn.getAttribute('type'), 'button');
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.equal(btn.getAttribute('aria-controls'), OBJECTIVE_GUIDE_ID);
    assert.equal(btn.getAttribute('title'), t('chat.guide.help'));
    assert.equal(btn.getAttribute('aria-label'), t('chat.guide.help'), 'icon only: its label is its name');
    assert.ok(btn.title.trim() && !btn.title.startsWith('chat.'), `${locale}: the title is translated`);
    assert.equal(btn.textContent.trim(), '');
    assert.equal(btn.querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.equal(doc.getElementById(OBJECTIVE_GUIDE_ID).hidden, true);
    assert.equal(objectiveGuideOpen(doc), false);
    dom.window.close();
  }
  // New Task gets no button, even when handed a popover; a view with no guide gets none either.
  const task = helpPage({ mode: 'new_task' });
  assert.equal(task.window.document.querySelector('.objective-help-btn, #objective-guide') === null, true);
  assert.deepEqual([...task.window.document.querySelectorAll('.composer-header-actions > *')].map(el => el.id), ['btn-archive']);
  task.window.close();
  const previous = state.activeTab;
  state.activeTab = 'objective';
  try {
    const plain = new JSDOM(renderComposerHeader('<button id="btn-archive">History</button>'));
    assert.equal(plain.window.document.querySelector('.objective-help-btn') === null, true, 'no popover, no button');
    plain.window.close();
  } finally {
    state.activeTab = previous;
  }
});

test('the guide popover closes on Escape, on a press outside it and when focus moves on past it', () => {
  const dom = helpPage();
  const { window } = dom;
  const doc = window.document;
  const btn = doc.getElementById(OBJECTIVE_HELP_BUTTON_ID);
  const guide = doc.getElementById(OBJECTIVE_GUIDE_ID);
  const examples = [...guide.querySelectorAll('.objective-example')];
  const byId = id => doc.getElementById(id);
  const open = () => {
    assert.equal(setObjectiveGuideOpen(doc, true), true);
    assert.equal(guide.hidden, false);
    assert.equal(btn.getAttribute('aria-expanded'), 'true');
  };
  const closed = why => {
    assert.equal(guide.hidden, true, why);
    assert.equal(btn.getAttribute('aria-expanded'), 'false', why);
    assert.equal(objectiveGuideOpen(doc), false, why);
  };
  const key = (target, name) => {
    const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  const press = target => target.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  const focusMoves = (from, to) => from.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: to }));
  try {
    assert.equal(bindObjectiveGuideDismiss(doc), true);
    assert.equal(bindObjectiveGuideDismiss(doc), false, 'bound once per document');

    // Closed, Escape is the Create modal's to close the dialog with.
    assert.equal(key(btn, 'Escape').defaultPrevented, false);

    // Escape from an example closes it and gives focus back to the (?) button.
    open();
    examples[1].focus();
    assert.equal(key(examples[1], 'Escape').defaultPrevented, true, 'the popover takes this Escape');
    closed('Escape from an example');
    assert.equal(doc.activeElement === btn, true, 'focus is back on the (?) button');
    open();
    btn.focus();
    assert.equal(key(btn, 'Escape').defaultPrevented, true);
    closed('Escape on the button');
    assert.equal(doc.activeElement === btn, true);
    open();
    assert.equal(key(btn, 'Enter').defaultPrevented, false, 'other keys are not the popover\'s');
    assert.equal(objectiveGuideOpen(doc), true);

    // A press on the popover or its button keeps it open; anywhere else closes it.
    press(examples[0]);
    press(guide.querySelector('.objective-guide-heading'));
    press(btn);
    assert.equal(objectiveGuideOpen(doc), true);
    press(byId('chat-input'));
    closed('a press in the composer');
    open();
    press(byId('outside'));
    closed('a press outside the dialog');

    // Focus moving between the button and the popover keeps it, and so does focus going nowhere (a
    // click on its text); Tab on past the last example closes it.
    open();
    focusMoves(btn, examples[0]);
    focusMoves(examples[0], examples[2]);
    focusMoves(examples[2], null);
    assert.equal(objectiveGuideOpen(doc), true);
    focusMoves(byId('chat-input'), byId('outside'));
    assert.equal(objectiveGuideOpen(doc), true, 'focus moving elsewhere, from outside it, is not its business');
    focusMoves(examples[2], byId('btn-archive'));
    closed('Tab past the last example');

    // A view without the guide: nothing opens, and Escape stays the modal's.
    guide.remove();
    assert.equal(setObjectiveGuideOpen(doc, true), false);
    assert.equal(objectiveGuideOpen(doc), false);
    assert.equal(key(btn, 'Escape').defaultPrevented, false);
  } finally {
    window.close();
  }
});

test('a repaint draws the popover open again, with keyboard focus where it was', () => {
  const dom = helpPage();
  const doc = dom.window.document;
  const example = n => doc.querySelector(`#${OBJECTIVE_GUIDE_ID} .objective-example[data-example="${n}"]`);
  const btn = () => doc.getElementById(OBJECTIVE_HELP_BUTTON_ID);
  // What refreshObjectiveContent() does to the heading row: replace it with a fresh render.
  const repaint = () => {
    const previous = state.activeTab;
    state.activeTab = 'objective';
    try {
      doc.querySelector('.composer-header').outerHTML = renderComposerHeader(
        '<button class="btn-archive" id="btn-archive">History</button>', '', { helpHtml: renderObjectiveGuideHtml() });
    } finally {
      state.activeTab = previous;
    }
  };
  try {
    assert.equal(captureObjectiveGuide(doc), null, 'closed: nothing to carry over');
    assert.equal(restoreObjectiveGuide(doc, null), false);

    setObjectiveGuideOpen(doc, true);
    example(2).focus();
    let saved = captureObjectiveGuide(doc);
    assert.deepEqual(saved, { focus: 2 });
    repaint();
    assert.equal(objectiveGuideOpen(doc), false, 'a render draws it closed');
    assert.equal(restoreObjectiveGuide(doc, saved), true);
    assert.equal(objectiveGuideOpen(doc), true);
    assert.equal(btn().getAttribute('aria-expanded'), 'true');
    assert.equal(doc.activeElement === example(2), true, 'the same example has focus again');

    btn().focus();
    saved = captureObjectiveGuide(doc);
    assert.deepEqual(saved, { focus: 'button' });
    repaint();
    restoreObjectiveGuide(doc, saved);
    assert.equal(doc.activeElement === btn(), true);

    doc.getElementById('chat-input').focus();
    assert.deepEqual(captureObjectiveGuide(doc), { focus: null });
    // The first turn started meanwhile: the repainted view has no guide to open.
    doc.getElementById(OBJECTIVE_GUIDE_ID).remove();
    assert.equal(restoreObjectiveGuide(doc, { focus: 1 }), false);
  } finally {
    dom.window.close();
  }
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
  // (TPT9406) The default state has no chip, so no locale names it.
  for (const locale of Object.keys(LOCALES)) assert.equal(LOCALES[locale]['chat.card.state.included'], undefined, locale);
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
    isTaskReadOnly: () => false, statusLockAttrs: empty, // (TPT9417) board-card lock, never reached by a proposal
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
  test(`${n} proposal(s): every card names its controls, only a rejected one carries a state chip, and one save bar carries the count`, () => {
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
          // (TPT9406) The default state (in the next Save Tasks) has no chip: the foot holds just
          // Accept and Reject. A rejected card's chip leads the foot.
          assert.deepEqual([...foot.children].map(el => el.className),
            isRejected ? ['preview-card-state', 'preview-card-buttons'] : ['preview-card-buttons'], `card ${i + 1}: the foot's parts`);
          assert.deepEqual([...foot.querySelector('.preview-card-buttons').children].map(el => el.classList[0]),
            ['btn-accept-card', 'btn-reject-card']);
          if (isRejected) {
            const chip = foot.querySelector('.preview-card-state');
            assert.equal(chip.dataset.state, 'rejected');
            assert.equal(chip.textContent, t('chat.card.state.rejected'));
          }
          assert.equal(foot.textContent.replace(/\s+/g, ''),
            ((isRejected ? t('chat.card.state.rejected') : '') + t('chat.card.accept') + t('chat.card.reject')).replace(/\s+/g, ''),
            'no other text in the foot');
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

// The foot of a mounted card as the tests compare it: its parts in order and the chip's state.
const readFoot = card => {
  const foot = card.querySelector(':scope > .preview-card-actions');
  return {
    parts: [...foot.children].map(el => el.className),
    chip: foot.querySelector('.preview-card-state')?.dataset.state ?? null,
    chipText: foot.querySelector('.preview-card-state')?.textContent ?? null,
  };
};

test('Reject adds the Rejected chip and un-Reject removes it, with the save bar and the stage line, without a repaint', async () => {
  statuses.resetStatuses();
  setLocale('en');
  const f = proposals(5);
  try {
    const card = f.root.querySelectorAll('.preview-card')[2];
    const accept = card.querySelector('.btn-accept-card');
    const reject = card.querySelector('.btn-reject-card');
    const fresh = readFoot(card);
    assert.deepEqual(fresh, { parts: ['preview-card-buttons'], chip: null, chipText: null }, 'a fresh foot: Accept and Reject only');
    const buttons = card.querySelector('.preview-card-buttons');

    await f.listeners.click({ target: reject });
    assert.equal(f.msg.acceptedMask[2], false);
    assert.deepEqual(readFoot(card), { parts: ['preview-card-state', 'preview-card-buttons'], chip: 'rejected', chipText: 'Rejected' });
    assert.equal(card.querySelector('.preview-card-buttons') === buttons, true, 'the buttons are the same nodes');
    assert.equal(reject.getAttribute('aria-pressed'), 'true');
    assert.equal(reject.classList.contains('active'), true);
    assert.equal(accept.classList.contains('active'), false);
    assert.equal(card.classList.contains('rejected'), true);
    assert.equal(card.dataset.accepted, 'false');
    assert.equal(f.root.querySelector('.save-bar-count').textContent, '4 tasks ready to save');
    assert.equal(f.stageSyncs.at(-1), 4, 'the stage line was re-synced after the mask changed');

    // A repaint draws the foot the live update left.
    const repainted = new JSDOM(`<div>${f.env.renderCardHtml(f.msg, 0)}</div>`);
    assert.deepEqual(readFoot(repainted.window.document.querySelectorAll('.preview-card')[2]), readFoot(card));
    repainted.window.close();

    // Reject is a toggle: pressed again (here on its label), the card is back in the save and the chip goes.
    await f.listeners.click({ target: reject.querySelector('.preview-card-action-label') });
    assert.equal(f.msg.acceptedMask[2], true);
    assert.deepEqual(readFoot(card), fresh);
    assert.equal(card.querySelector('.preview-card-buttons') === buttons, true);
    assert.equal(reject.getAttribute('aria-pressed'), 'false');
    assert.equal(reject.classList.contains('active'), false);
    assert.equal(accept.classList.contains('active'), true);
    assert.equal(card.classList.contains('rejected'), false);
    assert.equal(card.dataset.accepted, 'true');
    assert.equal(f.root.querySelector('.save-bar-count').textContent, '5 tasks ready to save');
    assert.equal(f.stageSyncs.at(-1), 5);
    assert.equal(f.root.querySelectorAll('.preview-card-state').length, 0, 'no card shows a chip');
  } finally { f.close(); }
});

test('Accept shows Saving while its write runs; a failed write puts the card back with no chip', async () => {
  statuses.resetStatuses();
  setLocale('en');
  const f = proposals(5, { rejected: [1] });
  try {
    let fail;
    f.env.saveTaskChange = () => new Promise((_, reject) => { fail = reject; });
    f.env.console = { ...console, error() {} };
    // Accept reads the title and description edits through innerText, which jsdom lacks.
    Object.defineProperty(f.dom.window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
    // An included card and a rejected one: Accept saves either, and both return to the default.
    for (const idx of [3, 1]) {
      const card = f.root.querySelectorAll('.preview-card')[idx];
      const clicked = f.listeners.click({ target: card.querySelector('.btn-accept-card') });
      assert.deepEqual(readFoot(card), { parts: ['preview-card-state', 'preview-card-buttons'], chip: 'saving', chipText: 'Saving…' });
      assert.equal(card.querySelector('.btn-reject-card').getAttribute('aria-pressed'), 'false');
      assert.equal(card.classList.contains('rejected'), false);
      fail(new Error('offline'));
      await clicked;
      assert.deepEqual(readFoot(card), { parts: ['preview-card-buttons'], chip: null, chipText: null }, `card ${idx + 1}: back to the default`);
      assert.equal(f.msg.acceptedMask[idx], true);
      assert.equal(card.querySelector('.btn-accept-card').disabled, false, 'the buttons work again');
    }
  } finally { f.close(); }
});

test('wiring: the view mounts the stage slot, the guide behind the heading\'s (?) button, and the save paths drive the stage', () => {
  const render = chatSrc.slice(chatSrc.indexOf('export function renderObjectiveContent('), chatSrc.indexOf('export function refreshObjectiveContent('));
  // (TPT9405) Nothing between the stage slot and the composer: the guide is the heading row's popover.
  assert.match(render, /<div class="objective-stage-slot" id="objective-stage-slot">\$\{renderObjectiveStage\(\)\}<\/div>\s*<div class="chat-body">/);
  assert.match(render, /const guideHtml = !state\.chatState && !discussKey && !subtaskCtx && !originTaskKey\s*\? renderObjectiveGuideHtml\(\) : '';/);
  assert.match(render, /<\/button>`, tabBarHtml, \{ helpHtml: guideHtml \}\)\}/);
  assert.equal((render.match(/guideHtml/g) || []).length, 2, 'built once, handed to the heading row once');
  assert.equal((render.match(/renderComposerHeader\(/g) || []).length, 1, 'one heading row: the Create modal\'s own');
  assert.doesNotMatch(render, /<h[12]\b/, 'no second title inside the view');
  const attach = chatSrc.slice(chatSrc.indexOf('export function attachChatHandlers('));
  assert.match(attach, /const guide = document\.getElementById\('objective-guide'\);\s*if \(guide\) \{\s*document\.getElementById\('objective-help-btn'\)\?\.addEventListener\('click', \(\) => \{\s*setObjectiveGuideOpen\(document, !objectiveGuideOpen\(document\)\);\s*\}\);\s*bindObjectiveGuideDismiss\(document\);\s*guide\.addEventListener\('click'/);
  assert.match(attach, /applyObjectiveExample\(chatInput\.value, Number\(btn\.dataset\.example\)\);\s*setObjectiveGuideOpen\(document, false\);[\s\S]{0,300}dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)[\s\S]{0,100}chatInput\.focus\(\);/);
  // A repaint carries an open popover across: refreshObjectiveContent() round-trips the view state.
  assert.match(extract(chatSrc, 'captureObjectiveViewState'),
    /const guide = document\.getElementById\('objective-guide'\);\s*return \{\s*guide: guide && !guide\.hidden \? captureObjectiveGuide\(document\) : null,/);
  assert.match(extract(chatSrc, 'restoreObjectiveViewState'), /\n  if \(viewState\.guide\) restoreObjectiveGuide\(document, viewState\.guide\);\n/);
  assert.match(chatSrc, /restoreObjectiveViewState\(viewState\);\s*return true;\s*\}/, 'refreshObjectiveContent() restores after wiring');

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
  // (TPT9406) No chip for the default state, and Accept / Reject keep their place when one
  // appears: right-aligned, with a chip that does not fit beside them wrapping under them.
  assert.doesNotMatch(css, /preview-card-state\[data-state="included"\]/);
  assert.match(rule('.preview-card-actions'), /flex-wrap: wrap-reverse;/);
  assert.match(rule('.preview-card-buttons'), /margin-left: auto;/);
  // (TPT9404) The stage line is one borderless 0.82rem row; the sentence gives way first, with an ellipsis.
  const line = rule('.objective-stage');
  assert.doesNotMatch(line, /background|border|padding|flex-wrap/);
  assert.match(line, /display: flex;/);
  assert.match(line, /font-size: 0\.82rem;/);
  assert.match(line, /white-space: nowrap;/);
  const detail = rule('.objective-stage-detail');
  assert.match(detail, /flex: 1 1 0;/);
  assert.match(detail, /min-width: 0;/);
  assert.match(detail, /overflow: hidden;/);
  assert.match(detail, /text-overflow: ellipsis;/);
  assert.match(rule('.objective-stage-name'), /text-overflow: ellipsis;/);
  assert.match(rule('.objective-stage-count'), /flex-shrink: 0;/);
  assert.match(rule('.objective-stage-count-label'), /clip-path: inset\(50%\);/);
  assert.match(rule('.objective-stage-dot'), /background: var\(--c-primary-border\);/);
  assert.doesNotMatch(css, /objective-stage-step/, 'no step list left in the stylesheet');
  // (TPT9405) The guide is a popover that hangs from the heading row over the composer, flush with
  // the row's buttons, and fits the dialog; closed, it takes no room at all.
  const guide = rule('.objective-guide');
  assert.match(guide, /position: absolute;/);
  assert.match(guide, /top: calc\(100% \+ 0\.5rem\);/);
  assert.match(guide, /right: var\(--composer-header-end, 0px\);/);
  assert.match(guide, /z-index: 5;/);
  assert.match(guide, /width: min\(30rem, calc\(100% - var\(--composer-header-end, 0px\)\)\);/);
  assert.match(guide, /max-height: min\(34rem, calc\(100vh - 9rem\)\);/);
  assert.match(guide, /overflow-y: auto;/);
  assert.match(guide, /background: var\(--c-bg-card\);/);
  assert.match(guide, /border: 1px solid var\(--objective-edge\);/);
  assert.match(guide, /box-shadow: [^;]*var\(--c-shadow\)/);
  assert.doesNotMatch(guide, /flex-shrink|margin-bottom/, 'no longer a block in the view\'s column');
  assert.match(rule('.objective-guide[hidden]'), /display: none;/);
  assert.match(rule('.composer-header-inner'), /position: relative;/);
  assert.match(css, /\n {2}\.objective-modal-body \.composer-header-inner,\n {2}\.objective-modal-body \.objective-header \{\n {4}--composer-header-end: 36px;\n {4}padding-right: var\(--composer-header-end\);\n {2}\}/);
  assert.doesNotMatch(rule('.objective-guide-steps,\n  .objective-guide-examples'), /grid-template-columns/, 'one column: a step or an example per row');
  assert.match(rule('.objective-example-text'), /-webkit-line-clamp: 2;/);
  assert.doesNotMatch(css, /#objective-guide-next \{ display: none; \}|\.objective-guide \{ display: none; \}/, 'no window size hides it');
  const help = rule('.objective-help-btn');
  assert.match(help, /align-self: stretch;/, 'as tall as History beside it');
  assert.match(help, /color: var\(--c-text-secondary\);/);
  assert.match(help, /border: 1\.5px solid var\(--c-border-input\);/);
  assert.match(rule('.objective-help-btn:hover,\n  .objective-help-btn[aria-expanded="true"]'), /background: var\(--c-primary-light\);/);
  assert.match(rule('.objective-help-btn:focus-visible'), /box-shadow: 0 0 0 2px var\(--c-primary-border\);/);
  assert.match(css, /@media \(forced-colors: active\) \{\n {4}\.objective-help-btn\[aria-expanded="true"\] \{\n {6}background: Highlight;/);
  // Secondary copy of the guidance never uses the muted token (under 4.5:1 in light palettes).
  const guidance = css.slice(css.indexOf('  .chat-container {\n    --objective-edge:'), css.indexOf('── Composer header: the Create modal\'s heading row ──'));
  assert.ok(guidance.length > 2000);
  assert.doesNotMatch(guidance.replace(/\/\*[\s\S]*?\*\//g, ''), /--c-text-muted/);
});
