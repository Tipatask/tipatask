import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// (TPT294) Regression guards for the client halves of objective-chat teardown: every way a chat
// disappears from the UI must also end its server session (or never open an orphan one), and the
// server's session-gone reply must render as a Retry. The code lives in inline WS/event-handler
// closures, so these are source-text scans — same idiom as chat-finalize-wiring.test.js. Server
// halves are covered by server/objective-teardown-wiring.test.js.

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));

function readSource(file) {
  return fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8');
}

// Strip `//` line comments so a guard never matches the prose explaining the very call it guards.
function stripLineComments(text) {
  return text.split('\n').map((line) => {
    const idx = line.indexOf('//');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start > -1, `marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `end marker not found after ${startMarker}: ${endMarker}`);
  return stripLineComments(src.slice(start, end));
}

test('first-turn Stop closes the removed tab\'s socket with a kill before splicing the tab', () => {
  const src = readSource('chat-ui.js');
  const block = slice(src, "msg.type === 'generation-aborted'", '// Reset streaming state');
  const firstTurn = block.slice(block.indexOf('if (cs.messages.length === 0)'));
  const kill = firstTurn.indexOf("type: 'kill'");
  const close = firstTurn.indexOf('.close()');
  const splice = firstTurn.indexOf('state.tabsState.splice(');
  assert.ok(kill > -1, 'first-turn abort must send kill');
  assert.ok(close > kill, 'and then close the socket');
  assert.ok(splice > close, 'before the tab is removed');
});

test('reconnects re-check tab ownership after the probe, then send reconnect=1', () => {
  const src = readSource('chat-ui.js');
  const timer = slice(src, 'ws.onclose = () => {', '// ── Send follow-up chat message ──');
  const timerGuard = timer.indexOf('_tabOwnsChat(taskId, cs)');
  assert.ok(timerGuard > -1, 'auto-reconnect must re-check the tab after its probe');
  assert.ok(timerGuard < timer.indexOf('connectObjectiveWS(taskId, null, { reconnect: true })'));

  const restore = slice(src, 'const restoredCs = state.chatState;', '// C1109:');
  const restoreGuard = restore.indexOf('_tabOwnsChat(tid, restoredCs)');
  assert.ok(restoreGuard > -1, 'page-reload restore must re-check the tab after its probe');
  assert.ok(restoreGuard < restore.indexOf('connectObjectiveWS(tid, null, { reconnect: true })'));

  const connect = slice(src, 'export function connectObjectiveWS(', 'ws._tabId = taskId;');
  assert.match(connect, /buildWsUrl\(taskId, reconnect \? \{ reconnect: '1' \} : undefined\)/);
});

test('session-gone renders through its own i18n category (message + retry banner)', () => {
  const src = stripLineComments(readSource('chat-ui.js'));
  assert.match(src, /if \(reason === 'session-gone'\) return 'gone';/);
  assert.match(src, /case 'gone':\s*\n?\s*return t\('chat\.error\.sessionGone'\);/);
  assert.match(src, /case 'gone':\s*return t\('chat\.error\.sessionGoneRetry'\);/);
  const i18n = readSource('i18n.js');
  for (const key of ['chat.error.sessionGone', 'chat.error.sessionGoneRetry']) {
    assert.equal(i18n.split(`'${key}':`).length - 1, 2, `${key} must exist in both en and uk`);
  }
});

test('closing a tab without a live socket cancels the cold prewarm before aborting', () => {
  const src = readSource('chat-ui.js');
  const closeTab = slice(src, 'export async function closeTab(', 'async function _abortTab(');
  const cancel = closeTab.indexOf("fetchWithRetry('/api/objective/prewarm', { method: 'DELETE'");
  assert.ok(cancel > -1, 'closeTab must DELETE the cold prewarm for socketless tabs');
  assert.ok(cancel < closeTab.indexOf('_abortTab(tabId);'), 'decided before _abortTab closes the socket');
});

test('per-card Accept closes the chat it was clicked in, not whichever chat is visible later', () => {
  const src = readSource('chat-task-preview.js');
  const handler = slice(src, "e.target.closest('.btn-accept-card')", '// ── Per-message Save Tasks button ──');
  assert.match(handler, /const cs = state\.chatState;/);
  assert.match(handler, /discardUnsavedProposals\(cs\.messages,/);
  assert.doesNotMatch(handler, /discardUnsavedProposals\(state\.chatState\.messages/);
  assert.equal((handler.match(/checkAllCardsHandled\(cs\)/g) || []).length, 2, 'accept and reject both pass cs');

  const check = slice(src, 'export function checkAllCardsHandled(', '\n}\n');
  assert.match(check, /export function checkAllCardsHandled\(cs = state\.chatState\)/);
  assert.match(check, /cleanupChat\(cs, \{ force: true \}\)/);
  assert.doesNotMatch(check, /cleanupChat\(undefined/);
});
