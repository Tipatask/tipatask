import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// (TPT19) Regression guards for the objective-chat persistence purge fix — the pure logic
// (discardUnsavedProposals/isMessageFullyResolved) is unit-tested directly in
// chat-finalize.test.js; this file only guards that the call sites wire it together
// correctly, since the mutated code lives in inline event-handler closures (the
// `.chat-save-btn` click handler, `cleanupChat()`'s purge branch), not top-level functions —
// same source-text-scan idiom as objective-origin-wiring.test.js.

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));

function readSource(file) {
  return fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8');
}

// (TPT20) Strip `//` line comments before scanning source slices for real call sites — several
// of the guards below live right beside a doc comment that mentions the very call it's guarding
// (e.g. "_abortTab() moved into closeTab()"), and a naive indexOf/regex would match that prose
// instead of the actual code.
function stripLineComments(text) {
  return text.split('\n').map((line) => {
    const idx = line.indexOf('//');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

// ── chat-task-preview.js: bulk Save Tasks handler ──

test('chat-task-preview.js: .chat-save-btn handler discards other messages BEFORE saveChatState()', () => {
  const src = readSource('chat-task-preview.js');
  const handlerStart = src.indexOf("e.target.closest('.chat-save-btn')");
  const handlerEnd = src.indexOf("e.target.closest('.chat-discard-btn')");
  assert.ok(handlerStart > -1, 'could not find the .chat-save-btn handler');
  assert.ok(handlerEnd > handlerStart, 'could not find the end of the .chat-save-btn handler');
  const slice = src.slice(handlerStart, handlerEnd);

  const discardIdx = slice.indexOf('discardUnsavedProposals(');
  const saveStateIdx = slice.indexOf('saveChatState();');
  assert.ok(discardIdx > -1, 'discardUnsavedProposals( not found in the .chat-save-btn handler');
  assert.ok(saveStateIdx > -1, 'saveChatState(); not found in the .chat-save-btn handler');
  assert.ok(
    discardIdx < saveStateIdx,
    'saveChatState() must run AFTER discardUnsavedProposals() — saveChatState() captures its ' +
    'snapshot synchronously, so a stale ordering here is what let an orphaned debounced PUT ' +
    'resurrect earlier iterations\' unsaved cards after the tab was already torn down (TPT19).'
  );

  // The bulk-save sweep must NOT preserve the efficiency-hint exemption — cleanupChat(force:true)
  // destroys the whole tab right after regardless, and keeping the exemption here left
  // hasUnsaved permanently true for any chat that produced hints.
  assert.ok(
    !slice.slice(discardIdx, discardIdx + 120).includes('keepEfficiencyHints: true'),
    'bulk-save discardUnsavedProposals() call must not pass keepEfficiencyHints: true'
  );
});

test('chat-task-preview.js: both cleanupChat() calls pass force: true', () => {
  const src = readSource('chat-task-preview.js');
  const calls = [...src.matchAll(/cleanupChat\([^)]*\)/g)].map(m => m[0]);
  assert.equal(calls.length, 2, `expected exactly 2 cleanupChat() calls in chat-task-preview.js, found ${calls.length}: ${calls.join(' | ')}`);
  for (const call of calls) {
    assert.ok(call.includes('{ force: true }'), `cleanupChat() call missing { force: true }: ${call}`);
  }
});

// ── console-modal.js: cleanupChat()'s purge branch ──

test('console-modal.js: chatPersistEpoch is bumped before both persistence DELETEs', () => {
  const src = readSource('console-modal.js');
  const epochIdx = src.indexOf('state.chatPersistEpoch++');
  const stateDeleteIdx = src.indexOf("fetchWithRetry('/api/chat-state', { method: 'DELETE'");
  const draftDeleteIdx = src.indexOf("fetchWithRetry('/api/objective/chat-draft', { method: 'DELETE'");
  assert.ok(epochIdx > -1, 'state.chatPersistEpoch++ not found');
  assert.ok(stateDeleteIdx > epochIdx, 'chat-state DELETE must come after the epoch bump');
  assert.ok(draftDeleteIdx > epochIdx, 'chat-draft DELETE must come after the epoch bump');
});

test('console-modal.js: state.chatState = null only appears inside the wasActive-only branch, never the force-only branch', () => {
  const src = readSource('console-modal.js');
  const purgeBranchIdx = src.indexOf('if (force || wasActive) {');
  const reposIdx = src.indexOf('if (wasActive) {');
  const nullIdx = src.indexOf('state.chatState = null;');
  assert.ok(purgeBranchIdx > -1, 'persistence-purge branch "if (force || wasActive) {" not found');
  assert.ok(reposIdx > purgeBranchIdx, 're-pointing branch "if (wasActive) {" not found after the purge branch');
  assert.ok(nullIdx > -1, 'state.chatState = null; not found');
  assert.ok(
    nullIdx > reposIdx,
    'state.chatState = null must live inside the wasActive-only branch, not the force-only ' +
    'purge branch — otherwise force:true would teleport the user off a tab they switched to ' +
    'mid-save (TPT19).'
  );
});

test('console-modal.js: DELETE fetchWithRetry calls use retries: 1 (not the default 3)', () => {
  const src = readSource('console-modal.js');
  const stateDeleteLine = src.slice(src.indexOf("fetchWithRetry('/api/chat-state', { method: 'DELETE'"));
  const draftDeleteLine = src.slice(src.indexOf("fetchWithRetry('/api/objective/chat-draft', { method: 'DELETE'"));
  assert.ok(stateDeleteLine.slice(0, 160).includes('retries: 1'), 'chat-state DELETE missing retries: 1');
  assert.ok(draftDeleteLine.slice(0, 160).includes('retries: 1'), 'chat-draft DELETE missing retries: 1');
});

// ── chat-ui.js: every debounced persistence timer is epoch-guarded ──

// ── chat-ui.js: closeTab() always force-purges, gated by a confirm dialog (TPT20) ──

function sliceCloseTab(src) {
  const start = src.indexOf('export async function closeTab(tabId) {');
  const end = src.indexOf('\nasync function _abortTab(tabId) {');
  assert.ok(start > -1, 'could not find export async function closeTab(tabId) {');
  assert.ok(end > start, 'could not find the end of closeTab (next: _abortTab)');
  return src.slice(start, end);
}

test('chat-ui.js: closeTab() is async and no longer skips the purge for unsaved cards', () => {
  const src = readSource('chat-ui.js');
  assert.match(src, /export async function closeTab\(tabId\) \{/, 'closeTab must be async — it awaits a confirm dialog');
  const body = sliceCloseTab(src);
  assert.doesNotMatch(
    body,
    /pendingCount === 0/,
    'closeTab must not reintroduce a skip-the-purge-when-cards-are-unsaved branch — that is the ' +
    'exact bug (TPT20) that let a saved/resolved objective\'s whole chat resurrect on next app start'
  );
});

test('chat-ui.js: closeTab() awaits the confirm BEFORE aborting the session or purging persistence', () => {
  const src = readSource('chat-ui.js');
  const body = stripLineComments(sliceCloseTab(src));
  const confirmIdx = body.indexOf('await showActionConfirm(');
  const okReturnIdx = body.indexOf('if (!ok) return;');
  const abortIdx = body.indexOf('_abortTab(');
  const cleanupIdx = body.indexOf('cleanupChat(');
  assert.ok(confirmIdx > -1, 'closeTab must await showActionConfirm(...) when cards are unsaved');
  assert.ok(okReturnIdx > confirmIdx, 'a declined confirm must return before any teardown runs');
  assert.ok(
    abortIdx > okReturnIdx,
    '_abortTab() must run AFTER the confirm decision — aborting first would kill the server ' +
    'turn/socket of a chat the user might still choose to keep open (Cancel)'
  );
  assert.ok(cleanupIdx > okReturnIdx, 'cleanupChat() must run AFTER the confirm decision');
  assert.match(
    body.slice(cleanupIdx, cleanupIdx + 40),
    /cleanupChat\(cs, \{ force: true \}\)/,
    'closeTab\'s cleanupChat() call must pass { force: true } — an unforced purge only fires ' +
    'when the closed tab happens to still be the active one, which is the TPT20 bug'
  );
});

test('chat-ui.js: the chat-tab-close click handler no longer calls _abortTab directly', () => {
  const src = readSource('chat-ui.js');
  const start = src.indexOf("bar.querySelectorAll('.chat-tab-close[data-close-tab-id]')");
  const end = src.indexOf('});', start);
  assert.ok(start > -1, 'could not find the .chat-tab-close click handler');
  const body = stripLineComments(src.slice(start, end));
  assert.doesNotMatch(
    body,
    /_abortTab\(/,
    '_abortTab() must be called from inside closeTab() (after the confirm), not from the click ' +
    'handler — calling it here runs before the user can Cancel'
  );
  assert.match(body, /void closeTab\(/, 'the handler must still call closeTab()');
});

// ── console-modal.js: survivor re-persist fires on ANY purge with a surviving chat (TPT20) ──

test('console-modal.js: the chat-persist-purged dispatch is not scoped to the wasActive branch', () => {
  const src = readSource('console-modal.js');
  const wasActiveIdx = src.indexOf('if (wasActive) {\n    state.chatState = null;');
  const dispatchGuardIdx = src.indexOf("if ((force || wasActive) && state.chatState) {");
  const dispatchIdx = src.indexOf("document.dispatchEvent(new CustomEvent('tiptask:chat-persist-purged'));");
  assert.ok(wasActiveIdx > -1, 'could not find the wasActive re-pointing branch');
  assert.ok(dispatchGuardIdx > wasActiveIdx, 'the chat-persist-purged dispatch guard must come after the wasActive re-pointing branch closes');
  assert.ok(dispatchIdx > dispatchGuardIdx, 'could not find the chat-persist-purged dispatch inside its own guard');
  // The wasActive block itself (up to the dispatch guard) must not already contain the dispatch —
  // i.e. it must not be nested one level deeper than the guard above expects. A background-tab
  // force purge (wasActive === false) must still reach this dispatch or the surviving ACTIVE
  // tab's own chat-draft/chat-state silently never gets re-written after being wiped.
  const wasActiveBody = src.slice(wasActiveIdx, dispatchGuardIdx);
  assert.doesNotMatch(
    wasActiveBody,
    /tiptask:chat-persist-purged/,
    'chat-persist-purged must not be dispatched only inside the wasActive branch — a force ' +
    'purge from a BACKGROUND tab close (wasActive === false) also wipes the active tab\'s own ' +
    'persistence and must still trigger the re-persist'
  );
});

test('chat-ui.js: saveChatDraft() and saveChatState() epoch-guard every setTimeout callback', () => {
  const src = readSource('chat-ui.js');
  const draftStart = src.indexOf('function saveChatDraft() {');
  const draftEnd = src.indexOf('function deleteChatDraft() {');
  const stateStart = src.indexOf('export function saveChatState() {');
  assert.ok(draftStart > -1 && draftEnd > draftStart, 'could not locate saveChatDraft() body');
  assert.ok(stateStart > draftEnd, 'could not locate saveChatState() after saveChatDraft()');

  const draftBody = src.slice(draftStart, draftEnd);
  const draftTimers = [...draftBody.matchAll(/setTimeout\(\(\) => \{/g)];
  assert.equal(draftTimers.length, 1, `expected exactly 1 setTimeout in saveChatDraft(), found ${draftTimers.length}`);

  // saveChatState() has no explicit end marker as clean as deleteChatDraft() — bound the body
  // by its own opening brace and take a generous slice; the epoch-guard count assertion below
  // still catches a missing guard even if the slice runs a little long.
  const stateBody = src.slice(stateStart, stateStart + 4000);
  const stateTimers = [...stateBody.matchAll(/setTimeout\(\(\) => \{/g)];
  assert.equal(stateTimers.length, 3, `expected exactly 3 setTimeout sites in saveChatState() (2 DELETE branches + 1 PUT branch), found ${stateTimers.length}`);

  const combined = draftBody + stateBody;
  const timerCount = [...combined.matchAll(/setTimeout\(\(\) => \{/g)].length;
  const guardCount = [...combined.matchAll(/if \(state\.chatPersistEpoch !== epoch\) return;/g)].length;
  assert.equal(guardCount, timerCount, `every setTimeout callback (${timerCount}) must contain a chatPersistEpoch guard — found ${guardCount}`);
});
