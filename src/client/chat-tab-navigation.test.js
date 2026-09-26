import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// Execute the real navigation functions without booting chat-ui's network/DOM
// imports. Browser verification covers pointer events and DOM reconciliation.
const source = readFileSync(new URL('./chat-ui.js', import.meta.url), 'utf8');
function navigation() {
  const active = { tabId: 'A', title: 'A', chatState: {
    messages: [{ role: 'assistant', streaming: true }],
    progressStage: 'Reading architecture…', ws: { owner: 'A' },
  } };
  const other = { tabId: 'B', title: 'B', chatState: {
    messages: [{ role: 'assistant', streaming: true }], ws: { owner: 'B' },
  }, viewState: { composer: { value: 'B draft' }, messagesScrollTop: 42 } };
  const state = { tabsState: [active, other], activeTabId: 'A', chatState: active.chatState };
  const renders = [];
  const outgoing = { composer: { value: 'A draft' }, messagesScrollTop: 24 };
  const env = {
    state, renders, outgoing, MAX_TABS: 3,
    dismissObjectiveNotification() {}, notifyObjectiveStatusChanged() {}, captureCardEdits() {},
    captureObjectiveViewState: () => outgoing,
    captureSubtaskCtx: () => null,
    refreshObjectiveContent: options => { renders.push(options); return true; },
    reload() { throw new Error('Navigation must not wait for the board reload'); },
  };
  vm.createContext(env);
  for (const name of ['getActiveTab', 'computeTabStatus', 'deriveTabTitle', 'syncActiveChatState',
    'switchTab', 'rememberActiveTabView', 'renderActiveTab', 'openNewTab']) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, name);
    const end = source.indexOf('\n}', start) + 2;
    vm.runInContext(source.slice(start, end), env);
  }
  return { ...env, active, other };
}

test('switch during architecture progress preserves each live session and its view', () => {
  const { state, switchTab, active, other, outgoing, renders } = navigation();
  const a = active.chatState, b = other.chatState;
  switchTab('B');
  assert.equal(state.activeTabId, 'B');
  assert.equal(state.chatState, b);
  assert.equal(active.chatState, a);
  assert.equal(active.status, 'streaming');
  assert.equal(active.viewState, outgoing);
  assert.equal(renders[0].viewState, other.viewState);
  assert.equal(a.ws.owner, 'A');
  assert.equal(b.ws.owner, 'B');
  switchTab('A');
  assert.equal(state.chatState, a);
  assert.equal(renders[1].viewState, outgoing);
});

test('same-tab and stale-tab clicks do not clear or repaint the active stream', () => {
  const { state, switchTab, active, renders } = navigation();
  switchTab('A');
  switchTab('gone');
  assert.equal(state.activeTabId, 'A');
  assert.equal(state.chatState, active.chatState);
  assert.equal(renders.length, 0);
});

test('adding a tab during streaming opens an empty composer without stopping the owner', () => {
  const { state, openNewTab, active, outgoing, renders } = navigation();
  const cs = active.chatState;
  openNewTab();
  assert.equal(state.tabsState.length, 3);
  assert.equal(state.activeTabId, state.tabsState[2].tabId);
  assert.equal(state.chatState, null);
  assert.equal(renders[0].viewState, null);
  assert.equal(active.viewState, outgoing);
  assert.equal(active.chatState, cs);
  assert.equal(active.status, 'streaming');
  assert.equal(cs.messages[0].streaming, true);
  openNewTab();
  assert.equal(state.tabsState.length, 3);
  assert.equal(renders.length, 1);
});
