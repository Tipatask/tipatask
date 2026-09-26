import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Client half of "a closed objective chat leaves nothing running" (TPT294). chat-ui.js and
// chat-task-preview.js pull in DOM/network modules, so these are source-scan guards on the
// wiring; the server half is exercised for real in src/server/objective-teardown-wiring.test.js.
const chatUi = readFileSync(new URL('./chat-ui.js', import.meta.url), 'utf8');
const preview = readFileSync(new URL('./chat-task-preview.js', import.meta.url), 'utf8');
const { LOCALES } = await import('./i18n.js');

// Fixed-length window of `src` starting at the first occurrence of `marker`.
function sliceFrom(src, marker, length = 4000) {
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `marker not found: ${marker}`);
  return src.slice(at, at + length);
}

test('first-message Stop kills and closes the tab socket before dropping the tab', () => {
  const branch = sliceFrom(chatUi, 'if (cs.messages.length === 0) {', 1500);
  const kill = branch.indexOf("sock.send(JSON.stringify({ type: 'kill' }))");
  const close = branch.indexOf('sock.close()');
  const splice = branch.indexOf('state.tabsState.splice(tabIdx, 1)');
  assert.ok(kill !== -1, 'sends kill so the server drops the session');
  assert.ok(close > kill, 'then closes the socket');
  assert.ok(splice > close, 'before the tab disappears');
});

test('auto-reconnect re-checks the tab still owns its chat after the session probe', () => {
  const probe = sliceFrom(chatUi, "label: 'objective-session-probe-reconnect'", 800);
  const owns = probe.indexOf('if (!_tabOwnsChat(taskId, cs)) return;');
  const connect = probe.indexOf('connectObjectiveWS(taskId, null, { reconnect: true })');
  assert.ok(owns !== -1 && connect > owns, 'ownership check runs after the probe, before reconnecting');
  assert.match(chatUi, /function _tabOwnsChat\(tabId, cs\) \{\s*return state\.tabsState\.some\(t => t\.tabId === tabId && t\.chatState === cs\);/);
});

test('reconnect sockets identify themselves with reconnect=1', () => {
  assert.match(chatUi, /new WebSocket\(buildWsUrl\(taskId, reconnect \? \{ reconnect: '1' \} : undefined\)\)/);
});

test('session-gone maps to its own error category with en + uk copy', () => {
  assert.match(chatUi, /if \(reason === 'session-gone'\) return 'gone';/);
  assert.match(chatUi, /t\('chat\.error\.sessionGone'\)/);
  assert.match(chatUi, /case 'gone':\s+return t\('chat\.error\.sessionGoneRetry'\)/);
  for (const locale of ['en', 'uk']) {
    for (const key of ['chat.error.sessionGone', 'chat.error.sessionGoneRetry']) {
      assert.equal(typeof LOCALES[locale][key], 'string', `${locale}.${key}`);
      assert.ok(LOCALES[locale][key].length > 0, `${locale}.${key} is not empty`);
    }
  }
});

test('closing a tab without a live socket cancels the cold prewarm', () => {
  const close = sliceFrom(chatUi, 'const liveWs = tab.chatState && tab.chatState.ws;', 600);
  assert.match(close, /if \(!liveWs \|\| liveWs\.readyState !== WebSocket\.OPEN\) \{\s*fetchWithRetry\('\/api\/objective\/prewarm', \{ method: 'DELETE'/);
  assert.ok(close.indexOf("method: 'DELETE'") < close.indexOf('_abortTab(tabId)'), 'checked before _abortTab() closes the socket');
});

test('Accept closes the chat it was clicked in, never whichever chat is visible later', () => {
  // Per-card accept/reject capture the clicked chat before awaiting the save and hand it on.
  // (The synchronous Discard handler further down still uses the visible chat — it never awaits.)
  const fromCapture = sliceFrom(preview, 'const cs = state.chatState;', 8000);
  const perCard = fromCapture.slice(0, fromCapture.indexOf('// Reject') + 600);
  const calls = perCard.match(/checkAllCardsHandled\([^)]*\);/g) || []; // statements, not comment mentions
  assert.ok(calls.length >= 2, 'accept and reject both check completion');
  for (const call of calls) assert.equal(call, 'checkAllCardsHandled(cs);');
  // checkAllCardsHandled closes the chat it was given; bulk Save closes its captured chat.
  const check = sliceFrom(preview, 'export function checkAllCardsHandled(cs = state.chatState) {', 2500);
  assert.match(check, /cleanupChat\(cs, \{ force: true \}\);/);
  assert.match(check, /if \(cs === state\.chatState\) \{\s*state\.activeTab = 'board';/, 'only an on-screen chat navigates to the board');
  assert.doesNotMatch(preview, /cleanupChat\(state\.chatState/);
});
