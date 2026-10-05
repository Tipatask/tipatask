import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// (TPT525) Composer focus survives a background objective tab closing itself after a save.
// The real functions run in a bare vm context (same approach as chat-tab-navigation.test.js);
// browser verification covers the actual focus/caret behavior.
const chatUi = readFileSync(new URL('./chat-ui.js', import.meta.url), 'utf8');
const preview = readFileSync(new URL('./chat-task-preview.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');

function extract(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, signature);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

function repaintEnv(activeTab) {
  const calls = [];
  const env = {
    state: { activeTab },
    reload: () => calls.push('reload'),
    renderTabBarOnly: () => calls.push('tab-bar'),
    Event: class { constructor(type) { this.type = type; } },
    document: { dispatchEvent: e => calls.push(e.type) },
  };
  vm.createContext(env);
  vm.runInContext(extract(chatUi, 'export function repaintAfterSavedChatClosed(').replace('export ', ''), env);
  return { env, calls };
}

test('background save on the objective tab patches only the tab strip', () => {
  const { env, calls } = repaintEnv('objective');
  env.repaintAfterSavedChatClosed({ wasVisible: false });
  assert.deepEqual(calls, ['tab-bar', 'tiptask:board-cache-stale']);
});

test('visible save, or a background save while off the objective tab, still reloads', () => {
  for (const [activeTab, wasVisible] of [['objective', true], ['board', false], ['board', true]]) {
    const { env, calls } = repaintEnv(activeTab);
    env.repaintAfterSavedChatClosed({ wasVisible });
    assert.deepEqual(calls, ['reload'], `${activeTab}/${wasVisible}`);
  }
});

function captureEnv({ focused = true, inputTabId = 'B', activeTabId = 'B' } = {}) {
  const input = {
    isConnected: true, dataset: { tabId: inputTabId }, value: 'typing in B',
    style: { height: '80px' }, scrollTop: 3, selectionStart: 4, selectionEnd: 6, selectionDirection: 'forward',
  };
  const env = {
    state: { activeTabId },
    document: {
      activeElement: focused ? input : null,
      getElementById: id => (id === 'chat-input' ? input : id === 'chat-messages' ? { scrollTop: 99 } : null),
    },
  };
  vm.createContext(env);
  vm.runInContext(extract(chatUi, 'function captureObjectiveViewState('), env);
  vm.runInContext(extract(chatUi, 'function captureFocusedComposerForRerender('), env);
  return env;
}

test('full-render guard captures the focused composer of the tab being rendered', () => {
  const view = captureEnv().captureFocusedComposerForRerender();
  assert.equal(view.tabId, 'B');
  assert.equal(view.messagesScrollTop, null);
  assert.equal(view.composer.value, 'typing in B');
  assert.equal(view.composer.selectionStart, 4);
  assert.equal(view.composer.selectionEnd, 6);
  assert.equal(view.composer.focused, true);
});

test('full-render guard skips an unfocused composer or one from another (removed) tab', () => {
  assert.equal(captureEnv({ focused: false }).captureFocusedComposerForRerender(), null);
  assert.equal(captureEnv({ inputTabId: 'A', activeTabId: 'B' }).captureFocusedComposerForRerender(), null);
});

test('render arms the one-shot restore and attachChatHandlers consumes it for the same tab', () => {
  const render = extract(chatUi, 'export function renderObjectiveContent(');
  assert.match(render, /_pendingComposerRestore = options\.viewState \? null : captureFocusedComposerForRerender\(\);/);
  assert.match(render, /const liveComposer = composerView\?\.composer;/);
  assert.match(render, /<textarea id="chat-input" data-tab-id="\$\{escapeAttr\(state\.activeTabId \?\? ''\)\}"/);
  const attach = extract(chatUi, 'export function attachChatHandlers(');
  assert.match(attach, /_pendingComposerRestore = null;\s*if \(pending\.tabId === state\.activeTabId\) restoreObjectiveViewState\(pending\);/);
  assert.ok(attach.indexOf('_pendingComposerRestore') > attach.indexOf('attachAudioRecorder(chatInput'),
    'restore runs after the recorder re-parents (and blurs) #chat-input');
});

test('both save close paths capture visibility before cleanup and never reload blindly', () => {
  const bulk = preview.slice(preview.indexOf('state.sessionAgent = null;\n        // (TPT525)'));
  const bulkTail = bulk.slice(0, bulk.indexOf('return;'));
  assert.match(bulkTail, /const wasVisible = cs === state\.chatState;\s*cleanupChat\(cs, \{ force: true \}\);/);
  assert.match(bulkTail, /repaintAfterSavedChatClosed\(\{ wasVisible \}\);/);
  assert.doesNotMatch(bulkTail, /\breload\(\)/);

  const check = extract(preview, 'export function checkAllCardsHandled(');
  assert.ok(check.indexOf('const wasVisible = cs === state.chatState;') < check.indexOf('cleanupChat(cs, { force: true });'));
  assert.match(check, /cleanupChat\(cs, \{ force: true \}\);\s*\/\/[^\n]*\n\s*repaintAfterSavedChatClosed\(\{ wasVisible \}\);/);
  assert.doesNotMatch(check, /\breload\(\)/);
});

test('template.html marks the board cache stale on a background save close', () => {
  assert.match(template, /addEventListener\('tiptask:board-cache-stale', \(\) => staleBoardTaskCache\(\)\)/);
});
