import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  collectDiscussingKeys, collectLockIntents, isTaskDiscussing, lockIntentOf, lockMessageKey, sameKeySet, sameIntentMap,
} from './discuss-lock.js';

test('collectDiscussingKeys: discuss and split tabs included, plain tab excluded', () => {
  const keys = collectDiscussingKeys([
    { tabId: 'a', rehashIntent: 'discuss', taskKey: 'TPT1', chatState: null },
    { tabId: 'b', rehashIntent: 'split', taskKey: 'TPT2', chatState: null },
    { tabId: 'c', rehashIntent: null, taskKey: null, chatState: null },
  ]);
  assert.deepEqual([...keys], ['TPT1', 'TPT2']);
});

test('collectDiscussingKeys: split tab locks its key', () => {
  const keys = collectDiscussingKeys([{ tabId: 'a', rehashIntent: 'split', taskKey: 'TPT7', chatState: null }]);
  assert.deepEqual([...keys], ['TPT7']);
});

test('collectDiscussingKeys + collectLockIntents: split and discuss tabs of different keys both lock', () => {
  const tabs = [
    { tabId: 'a', rehashIntent: 'split', taskKey: 'TPT1', chatState: null },
    { tabId: 'b', rehashIntent: 'discuss', taskKey: 'TPT2', chatState: null },
  ];
  assert.deepEqual([...collectDiscussingKeys(tabs)].sort(), ['TPT1', 'TPT2']);
  assert.deepEqual([...collectLockIntents(tabs)], [['TPT1', 'split'], ['TPT2', 'discuss']]);
});

test('collectDiscussingKeys: split without key excluded', () => {
  assert.equal(collectDiscussingKeys([{ rehashIntent: 'split', taskKey: null }]).size, 0);
  assert.equal(collectDiscussingKeys([{ rehashIntent: 'split', taskKey: '' }]).size, 0);
  assert.equal(collectLockIntents([{ rehashIntent: 'split', taskKey: null }]).size, 0);
});

test('collectDiscussingKeys: chatState-fallback split row locks', () => {
  const tabs = [{ tabId: 'a', chatState: { rehashIntent: 'split', taskKey: 'TPT8' } }];
  assert.deepEqual([...collectDiscussingKeys(tabs)], ['TPT8']);
  assert.equal(collectLockIntents(tabs).get('TPT8'), 'split');
});

test('collectDiscussingKeys: lockReleased (saved split) stops the lock, intent kept', () => {
  assert.equal(collectDiscussingKeys([{ rehashIntent: 'split', taskKey: 'TPT1', lockReleased: true }]).size, 0);
  assert.equal(collectDiscussingKeys([{ tabId: 'a', chatState: { rehashIntent: 'split', taskKey: 'TPT1', lockReleased: true } }]).size, 0);
  assert.equal(collectLockIntents([{ rehashIntent: 'split', taskKey: 'TPT1', lockReleased: true }]).size, 0);
  // Tab row still wins over a stale chatState, in both directions.
  assert.equal(collectDiscussingKeys([{
    rehashIntent: 'split', taskKey: 'TPT1', lockReleased: false,
    chatState: { rehashIntent: 'split', taskKey: 'TPT1', lockReleased: true },
  }]).size, 1);
  assert.equal(collectDiscussingKeys([{
    rehashIntent: 'split', taskKey: 'TPT1', lockReleased: true,
    chatState: { rehashIntent: 'split', taskKey: 'TPT1' },
  }]).size, 0);
});

test('collectLockIntents: first tab for a key wins; empty inputs', () => {
  const intents = collectLockIntents([
    { rehashIntent: 'discuss', taskKey: 'TPT1' },
    { rehashIntent: 'split', taskKey: 'TPT1' },
  ]);
  assert.deepEqual([...intents], [['TPT1', 'discuss']]);
  assert.equal(collectLockIntents(null).size, 0);
  assert.equal(collectLockIntents([null, { tabId: 'x' }]).size, 0);
});

test('lockIntentOf / lockMessageKey', () => {
  const state = { discussingTaskKeys: new Set(['TPT1', 'TPT2', 'TPT3']), discussLockIntents: new Map([['TPT1', 'split'], ['TPT2', 'discuss']]) };
  assert.equal(lockIntentOf(state, 'TPT1'), 'split');
  assert.equal(lockIntentOf(state, 'TPT2'), 'discuss');
  assert.equal(lockIntentOf(state, 'TPT3'), 'discuss'); // locked, no map entry
  assert.equal(lockIntentOf(state, 'TPT4'), null);
  assert.equal(lockIntentOf({ discussingTaskKeys: new Set(['TPT1']) }, 'TPT1'), 'discuss');
  assert.equal(lockIntentOf(null, 'TPT1'), null);
  assert.equal(lockMessageKey('split'), 'card.splitting');
  assert.equal(lockMessageKey('discuss'), 'card.discussing');
  assert.equal(lockMessageKey(null), 'card.discussing');
});

test('collectDiscussingKeys: discuss without key excluded', () => {
  assert.equal(collectDiscussingKeys([{ rehashIntent: 'discuss', taskKey: null }]).size, 0);
  assert.equal(collectDiscussingKeys([{ rehashIntent: 'discuss', taskKey: '' }]).size, 0);
});

test('collectDiscussingKeys: empty / missing tabs', () => {
  assert.equal(collectDiscussingKeys([]).size, 0);
  assert.equal(collectDiscussingKeys(null).size, 0);
  assert.equal(collectDiscussingKeys(undefined).size, 0);
  assert.equal(collectDiscussingKeys([null, { tabId: 'x' }]).size, 0);
});

test('collectDiscussingKeys: chatState fallback when tab row has no rehash fields', () => {
  const keys = collectDiscussingKeys([{ tabId: 'a', chatState: { rehashIntent: 'discuss', taskKey: 'TPT9' } }]);
  assert.deepEqual([...keys], ['TPT9']);
});

test('collectDiscussingKeys: cleared tab row wins over stale chatState', () => {
  const keys = collectDiscussingKeys([{
    tabId: 'a', rehashIntent: null, taskKey: null,
    chatState: { rehashIntent: 'discuss', taskKey: 'TPT9' },
  }]);
  assert.equal(keys.size, 0);
});

test('collectDiscussingKeys: duplicate keys collapse, numeric keys stringified', () => {
  const keys = collectDiscussingKeys([
    { rehashIntent: 'discuss', taskKey: 'TPT3' },
    { rehashIntent: 'discuss', taskKey: 'TPT3' },
    { rehashIntent: 'discuss', taskKey: 42 },
  ]);
  assert.deepEqual([...keys].sort(), ['42', 'TPT3']);
});

test('isTaskDiscussing', () => {
  const state = { discussingTaskKeys: new Set(['TPT1']) };
  assert.equal(isTaskDiscussing(state, 'TPT1'), true);
  assert.equal(isTaskDiscussing(state, 'TPT2'), false);
  assert.equal(isTaskDiscussing(state, null), false);
  assert.equal(isTaskDiscussing({}, 'TPT1'), false);
  assert.equal(isTaskDiscussing(null, 'TPT1'), false);
});

test('sameKeySet', () => {
  assert.equal(sameKeySet(new Set(['a', 'b']), new Set(['b', 'a'])), true);
  assert.equal(sameKeySet(new Set(['a']), new Set(['a', 'b'])), false);
  assert.equal(sameKeySet(new Set(['a']), new Set(['b'])), false);
  assert.equal(sameKeySet(new Set(), new Set()), true);
  assert.equal(sameKeySet(null, new Set()), false);
});

test('sameIntentMap', () => {
  assert.equal(sameIntentMap(new Map([['a', 'split']]), new Map([['a', 'split']])), true);
  assert.equal(sameIntentMap(new Map([['a', 'split']]), new Map([['a', 'discuss']])), false);
  assert.equal(sameIntentMap(new Map([['a', 'split']]), new Map()), false);
  assert.equal(sameIntentMap(new Map(), new Map()), true);
  assert.equal(sameIntentMap(undefined, new Map()), false);
});

// Wiring guard — source-text checks, same style as subtask-preview-wiring.test.js.
const read = name => readFileSync(new URL('./' + name, import.meta.url), 'utf8');
function fnBody(text, signature) {
  const start = text.indexOf(signature);
  assert.notEqual(start, -1, signature);
  return text.slice(start, text.indexOf('\n}', start));
}

test('chat-ui.js: syncDiscussLocks() wired into spawn, close, and the tab-bar safety net', () => {
  const src = read('chat-ui.js');
  assert.match(src, /export function syncDiscussLocks\(\)/);
  assert.match(src, /'tiptask:discuss-lock-changed'/);
  for (const sig of ['export function spawnObjectiveTab(', 'export async function closeTab(', 'function notifyObjectiveStatusChanged(']) {
    assert.ok(fnBody(src, sig).includes('syncDiscussLocks()'), `${sig} must call syncDiscussLocks()`);
  }
});

test('chat-task-preview.js: both save paths release the discuss lock', () => {
  const src = read('chat-task-preview.js');
  assert.ok(fnBody(src, 'export async function saveTaskChange(').includes('releaseDiscussLock(cs)'));
  const bulk = src.slice(src.indexOf("closest('.chat-save-btn')"), src.indexOf('export async function saveTaskChange('));
  assert.ok(bulk.includes('releaseDiscussLock(cs)'), 'bulk .chat-save-btn handler must release the lock');
});

test('chat-ui.js: syncDiscussLocks() tracks intents; spawnObjectiveTab() resets lockReleased', () => {
  const src = read('chat-ui.js');
  const sync = fnBody(src, 'export function syncDiscussLocks(');
  assert.ok(sync.includes('collectLockIntents(state.tabsState)'));
  assert.ok(sync.includes('sameIntentMap(') && sync.includes('state.discussLockIntents = intents'));
  assert.match(fnBody(src, 'export function spawnObjectiveTab('), /tab\.lockReleased = false/);
  assert.match(fnBody(src, 'function rehashPayload('), /lockReleased/);
});

test('chat-task-preview.js: releaseDiscussLock() split branch stamps lockReleased, keeps intent', () => {
  const body = fnBody(read('chat-task-preview.js'), 'function releaseDiscussLock(');
  const split = body.slice(body.indexOf("intent === 'split'"), body.indexOf('} else {'));
  assert.ok(split.includes('cs.lockReleased = true') && split.includes('tab.lockReleased = true'));
  assert.ok(!split.includes('rehashIntent'), 'split release must not clear rehashIntent');
  assert.ok(body.includes('syncDiscussLocks()'));
});

test('task-card.js / task-board.js / i18n.js: lock names its mode', () => {
  const card = read('task-card.js');
  assert.match(card, /data-lock-intent="\$\{lockIntent\}"/);
  assert.ok(fnBody(card, 'export function applyDiscussLock(').includes('card.dataset.lockIntent = lockIntentOf('));
  assert.match(fnBody(card, 'function discussOverlayHtml('), /lockMessageKey\(intent\)/);
  assert.match(read('task-edit-modal.js'), /showToast\(t\(lockMessageKey\(lockIntentOf\(state, taskId\)\)\)\)/);
  assert.equal((read('i18n.js').match(/'card\.splitting':/g) || []).length, 2, 'card.splitting in en + uk');
});
