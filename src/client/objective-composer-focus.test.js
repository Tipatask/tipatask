import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { escapeAttr } from './utils.js';

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
      getElementById: id => (id === 'chat-input' ? input
        : id === 'chat-messages' ? { scrollTop: 99, scrollHeight: 900, clientHeight: 300, dataset: {} } : null),
    },
  };
  vm.createContext(env);
  vm.runInContext(extract(chatUi, 'function captureObjectiveViewState('), env);
  vm.runInContext(extract(chatUi, 'function captureTranscriptView('), env);
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

// (TPT9086) Transcript scroll across a repaint. The real stamp/capture/restore/scroll functions run
// against fake #chat-messages nodes. paint() stamps each node through transcriptStampAttrs(), the
// attribute string renderObjectiveContent() writes, and requestAnimationFrame is a manual queue.
function transcriptEnv() {
  const frames = [];
  const env = {
    state: { activeTabId: 'A', chatState: { taskId: 'A', historyWindowStart: 1, messages: [
      { role: 'user', content: 'Plan the export', timestamp: 1 },
      { role: 'assistant', content: 'Plan', cards: [], streaming: false, timestamp: 2 },
    ] } },
    escapeAttr, _chatScrollToEndToken: 0, node: null,
    requestAnimationFrame: cb => frames.push(cb),
    document: { activeElement: null, getElementById: id => (id === 'chat-messages' ? env.node : null) },
  };
  vm.createContext(env);
  for (const name of ['bubbleKey', 'transcriptStamp', 'transcriptStampAttrs', 'captureTranscriptView',
    'captureObjectiveViewState', 'captureTranscriptForRerender', 'transcriptEndsAfterRepaint',
    'restoreTranscriptScroll', 'restoreObjectiveViewState', 'setTranscriptScrollTop', 'transcriptLaidOut',
    'scrollChatToEnd']) {
    vm.runInContext(extract(chatUi, `function ${name}(`), env);
  }
  // What a repaint leaves behind: a fresh #chat-messages at the top, stamped from the chat state.
  env.paint = (props = {}) => {
    const dataset = { activeTab: env.state.chatState.taskId };
    for (const [, key, value] of env.transcriptStampAttrs(env.state.chatState).matchAll(/data-([\w-]+)="([^"]*)"/g)) {
      dataset[key.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
    }
    env.node = { scrollTop: 0, scrollHeight: 2400, clientHeight: 600, isConnected: true, dataset,
      querySelectorAll: () => [], ...props };
    return env.node;
  };
  env.frame = async () => {
    for (const cb of frames.splice(0)) cb();
    await new Promise(resolve => setImmediate(resolve));
  };
  env.flush = async () => { while (frames.length) await env.frame(); };
  return env;
}

async function repaint(env, change, props) {
  const saved = env.captureObjectiveViewState();
  change(env.state.chatState);
  const node = env.paint(props);
  env.restoreObjectiveViewState(saved);
  await env.flush();
  return node;
}

test('(TPT9086) a repaint after a new message scrolls #chat-messages to scrollHeight', async () => {
  const env = transcriptEnv();
  env.paint({ scrollTop: 300 }); // the reader scrolled up
  const node = await repaint(env, cs => cs.messages.push({ role: 'user', content: 'Split it', timestamp: 3 }));
  assert.equal(node.scrollTop, node.scrollHeight);
});

test('(TPT9086) a repaint without a new message restores the saved scrollTop', async () => {
  const env = transcriptEnv();
  env.paint({ scrollTop: 300 });
  assert.equal((await repaint(env, () => {})).scrollTop, 300);
});

test('(TPT9086) a finished reply, its proposal cards, and an error replacing the typing bubble count as new', async () => {
  const changes = {
    'reply finished': cs => { cs.messages[1].streaming = false; },
    'proposal cards landed': cs => { cs.messages[1].streaming = false; cs.messages[1].cards = [{ task: { id: 'TPT1' } }]; },
    'error replaced the typing bubble': cs => { cs.messages.splice(1, 1, { role: 'system', content: 'Error', timestamp: 3 }); },
  };
  for (const [label, change] of Object.entries(changes)) {
    const env = transcriptEnv();
    env.state.chatState.messages[1].streaming = true;
    env.paint({ scrollTop: 300 });
    const node = await repaint(env, change);
    assert.equal(node.scrollTop, node.scrollHeight, label);
  }
});

test('(TPT9086) a reader at the end stays there as cards grow; Load earlier keeps the place', async () => {
  const env = transcriptEnv();
  env.paint({ scrollTop: 1800 }); // 2400 - 1800 - 600: at the end
  assert.equal((await repaint(env, () => {}, { scrollHeight: 2700 })).scrollTop, 2700);

  const earlier = transcriptEnv();
  earlier.state.chatState.historyWindowStart = 3;
  earlier.paint({ scrollTop: 40 });
  const node = await repaint(earlier, cs => {
    cs.messages.unshift({ role: 'user', content: 'Older', timestamp: 0 }, { role: 'assistant', content: 'Older', timestamp: 0.5 });
    cs.historyWindowStart = 1;
  });
  assert.equal(node.scrollTop, 40);
});

test('(TPT9086) a full render keeps the place only for the same chat and ends a first paint at the bottom', async () => {
  const env = transcriptEnv();
  env.paint({ scrollTop: 300 });
  assert.equal(env.captureTranscriptForRerender().messagesScrollTop, 300);
  env.node.dataset.activeTab = 'B';
  assert.deepEqual({ ...env.captureTranscriptForRerender() }, { messagesScrollTop: null });
  env.node = null; // opening the Objective tab: no live transcript yet
  const view = env.captureTranscriptForRerender();
  const node = env.paint();
  env.restoreTranscriptScroll(node, view);
  await env.flush();
  assert.equal(node.scrollTop, node.scrollHeight);
  env.state.chatState = null;
  assert.equal(env.captureTranscriptForRerender(), null);
});

test('(TPT9086) scrollChatToEnd pins instantly, repins after layout, and respects a reader who scrolled up', async () => {
  const env = transcriptEnv();
  const behaviors = [];
  const node = env.paint({ scrollTo(options) { behaviors.push(options.behavior); this.scrollTop = options.top; } });
  env.scrollChatToEnd();
  env.scrollChatToEnd(); // same frame: one pass
  await env.frame();
  assert.equal(node.scrollTop, 2400);
  node.scrollHeight = 2900; // an image in a proposal card finished loading
  await env.flush();
  assert.equal(node.scrollTop, 2900);
  assert.deepEqual(behaviors, ['instant', 'instant']);

  env.scrollChatToEnd();
  await env.frame();
  node.scrollTop = 500; // the reader scrolled up before the second pass
  node.scrollHeight = 3200;
  await env.flush();
  assert.equal(node.scrollTop, 500);

  env.scrollChatToEnd(); // queued for chat A, then the user switches to chat B in the same frame
  env.state.chatState = { taskId: 'B', messages: [] };
  const other = env.paint({ scrollTop: 120 });
  await env.flush();
  assert.equal(other.scrollTop, 120);
});

test('(TPT9086) both repaint paths and every stream update scroll through the helpers', () => {
  const render = extract(chatUi, 'export function renderObjectiveContent(');
  assert.match(render, /_pendingTranscriptRestore = options\.viewState \? null : captureTranscriptForRerender\(\);/);
  assert.match(render, /id="chat-messages" data-active-tab="[^\n]*" \$\{transcriptStampAttrs\(state\.chatState\)\}>/);
  const attach = extract(chatUi, 'export function attachChatHandlers(');
  assert.ok(attach.indexOf('restoreTranscriptScroll(messages, view)') > attach.indexOf('syncBubbleClamps();'));
  assert.match(extract(chatUi, 'export function updateStreamingBubble('), /scrollChatToEnd\(\);/);
  assert.doesNotMatch(chatUi, /shouldScrollToBottom/);
  assert.doesNotMatch(chatUi, /\b(?:msgContainer|messages)\.scrollTop\s*=/);
});
