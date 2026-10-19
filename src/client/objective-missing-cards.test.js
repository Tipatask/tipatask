import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseObjectiveResult, stripAnsi, stripJsonFromDisplay, escapeAttr } from './utils.js';
import { t, tc, setLocale } from './i18n.js';

const source = fs.readFileSync(new URL('./chat-ui.js', import.meta.url), 'utf8');
const recordings = JSON.parse(fs.readFileSync(new URL('../../fixtures/objective-missing-cards.json', import.meta.url)));

function client() {
  const sockets = [], sent = [];
  const cs = { messages: [{ role: 'user', content: 'Windows Pi screenshot report' },
    { role: 'assistant', content: '', cards: [], streaming: true }],
    clientBuffer: '', autoRetryCount: 0, allChanges: [], originalUserText: 'Windows Pi screenshot report' };
  const tab = { tabId: 'objective', chatState: cs };
  const state = { tabsState: [tab], activeTabId: 'objective', chatState: cs };
  const env = { state, t, tc, parseObjectiveResult, stripAnsi, escapeAttr,
    console: { error() {}, warn() {} }, Date, setTimeout() {}, clearTimeout() {},
    WebSocket: class {
      static OPEN = 1;
      readyState = 1;
      constructor() { sockets.push(this); }
      send(raw) { sent.push(JSON.parse(raw)); }
    },
    buildWsUrl: () => 'ws://fixture', updateProgressChip() {}, updateStreamingBubble() {},
    appendProgressLog() {}, notifyObjectiveCardsReady() {}, notifyObjectiveStatusChanged() {},
    reload() {}, renderTabBarOnly() {}, saveChatDraft() {}, saveChatState() {}, syncChatHistoryMeta() {},
    ensureExistingSnapshot: async () => {}, buildInitialAcceptedMask: (_cs, cards) => cards.map(() => true),
    _getConfirmedTaskIds: () => new Set(), rehashPayload: () => ({}),
    normalizeChatMessages: rows => rows, ensureStreamingAssistant() {},
    errorFrameText: msg => msg.message,
  };
  vm.createContext(env);
  for (const name of ['computeTabStatus', 'providerLabelFor', 'objectiveErrorCategory',
    'objectiveErrorMessage', 'objectiveRetryBannerText', 'objectiveProposalNotice', 'connectObjectiveWS']) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, name);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), env);
  }
  env.connectObjectiveWS('objective', null);
  const frame = msg => sockets[0].onmessage({ data: JSON.stringify(msg) });
  function result(content, extra = {}) {
    let parsed;
    try { parsed = parseObjectiveResult(content); } catch { /* malformed/empty response */ }
    cs.messages.at(-1).content = content;
    frame({ type: 'objective-result', content, cards: parsed?.changes,
      proposalResult: parsed?.proposalResult, ...extra });
    frame({ type: 'exit', code: 0 });
  }
  return { env, cs, tab, state, sent, frame, result };
}

for (const [index, recording] of recordings.entries()) {
  test(`objectiveMissingCards: recorded ${recording.model} reply ${index} renders its outcome without restart`, () => {
    const h = client();
    h.result(recording.content, { timingMilestones: { turnStart: 0, turnEnd: 180000 } });
    const msg = h.cs.messages[1];
    assert.equal(msg.cards.length, index < 6 ? 0 : index === 6 ? 1 : 3);
    assert.equal(h.cs.retryable, false);
    assert.equal(h.cs.pendingCardsUpdate, false);
    assert.equal(h.cs.messages.some(m => m.streaming), false);
    assert.equal(h.sent.length, 0);
    if (index < 6) assert.match(h.env.objectiveProposalNotice(msg), /No task changes.*\n.*(?:TPT9036|Pi|Screenshot)/);
    else assert.equal(h.env.objectiveProposalNotice(msg), '');
  });
}

test('objectiveMissingCards: empty and unreadable output expose Retry even after a slow turn', () => {
  for (const content of ['', '```json\n{"changes": [\n```']) {
    const h = client();
    h.cs.autoRetryCount = 1;
    h.result(content, { timingMilestones: { turnStart: 0, turnEnd: 180000 } });
    assert.equal(h.cs.retryable, true);
    assert.equal(h.cs.pendingCardsUpdate, false);
    assert.match(h.env.objectiveRetryBannerText(h.cs, ''), content ? /unreadable task proposal/ : /returned no response/);
    assert.equal(h.sent.length, 0);
  }
});

test('objectiveMissingCards: malformed output retries once; repeated exit cannot restart it twice', () => {
  const h = client();
  h.result('No JSON this time');
  assert.equal(h.cs.autoRetryCount, 1);
  assert.equal(h.sent.length, 1);
  h.result('Still no JSON');
  h.frame({ type: 'exit', code: 0 });
  assert.equal(h.sent.length, 1);
  assert.equal(h.cs.retryable, true);
});

test('objectiveMissingCards: server-rejected cards stay rejected without fallback parsing or auto-retry', () => {
  const h = client();
  h.result(recordings[6].content, { cards: [], proposalResult: { status: 'rejected', reason: '' } });
  assert.equal(h.cs.messages[1].cards.length, 0);
  assert.equal(h.cs.retryable, true);
  assert.equal(h.sent.length, 0);
  assert.match(h.env.objectiveRetryBannerText(h.cs, ''), /validation.*locked/);
});

test('objectiveMissingCards: legacy empty server cards finish successfully; failed follow-up preserves earlier cards', () => {
  const legacy = client();
  legacy.result(recordings[2].content, { cards: [], proposalResult: undefined });
  assert.equal(legacy.cs.retryable, false);
  assert.equal(legacy.sent.length, 0);
  const h = client();
  h.cs.messages.splice(1, 0, { role: 'assistant', cards: [{ task: { id: 'TPT1' } }] },
    { role: 'user', content: 'Refine' });
  h.result('unreadable follow-up');
  assert.equal(h.sent.length, 0);
  assert.equal(h.cs.messages[1].cards.length, 1);
  assert.equal(h.cs.retryable, true);
});

test('objectiveMissingCards: actual assistant renderer shows escaped empty explanation outside hidden JSON', () => {
  const h = client();
  h.result(recordings[2].content);
  const msg = h.cs.messages[1];
  msg.proposalResult.reason += ' <img src=x onerror=alert(1)>';
  const start = source.indexOf('      // Assistant message\n');
  const end = source.indexOf('      // Typing indicator', start);
  Object.assign(h.env, { msg, stripJsonFromDisplay });
  const html = vm.runInContext('(function () {' + source.slice(start, end) + '\nreturn body;})()', h.env);
  assert.match(html, /No task changes proposed/);
  assert.match(html, /TPT9036/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /```json|<img/);
});

test('objectiveMissingCards: duplicate frames preserve decisions and do not duplicate changes', () => {
  const h = client();
  const parsed = parseObjectiveResult(recordings[6].content);
  h.frame({ type: 'task-cards', cards: parsed.changes, proposalResult: parsed.proposalResult });
  const msg = h.cs.messages[1];
  msg.acceptedMask[0] = false;
  msg.confirmedMask[0] = true;
  h.frame({ type: 'task-cards', cards: parsed.changes, proposalResult: parsed.proposalResult });
  h.result(recordings[6].content);
  h.frame({ type: 'exit', code: 0 });
  h.frame({ type: 'cards-update', turnIndex: 1, cards: parsed.changes });
  assert.equal(msg.acceptedMask[0], false);
  assert.equal(msg.confirmedMask[0], true);
  assert.equal(h.cs.allChanges.length, 1);
  assert.equal(h.sent.length, 0);
});

test('objectiveMissingCards: history restores empty reasons; background results stay on their tab', () => {
  const h = client();
  const parsed = parseObjectiveResult(recordings[4].content);
  h.state.chatState = { messages: [] };
  h.state.activeTabId = 'other';
  h.frame({ type: 'chat-history-reset', messages: [{ role: 'assistant', content: recordings[4].content,
    cards: [], proposalResult: parsed.proposalResult }], running: false });
  assert.match(h.env.objectiveProposalNotice(h.cs.messages[0]), /TPT9036/);
  assert.equal(h.state.chatState.messages.length, 0);
});

test('objectiveMissingCards: provider errors remain actionable and empty notices are localized', () => {
  const h = client();
  h.frame({ type: 'objective-error', reason: 'codex:request failed', provider: 'codex' });
  assert.equal(h.cs.retryable, true);
  assert.equal(h.cs.processExited, true);
  assert.match(h.cs.messages.at(-1).content, /Codex stream failed/);
  setLocale('uk');
  try {
    assert.match(h.env.objectiveProposalNotice({ proposalResult: { status: 'empty', reason: 'TPT9036' } }), /Змін задач.*\nTPT9036/);
  } finally { setLocale('en'); }
});
