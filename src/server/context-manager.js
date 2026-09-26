'use strict';

const config = require('./config');
const { clearAllProviderSessionIds, clearProviderSessionId } = require('./providers/registry');

/**
 * Full context reset — use for task transitions and restart operations.
 * Kills any running process, clears message history, resets all buffers and tokens.
 * Does NOT preserve any messages — caller must save and restore as needed.
 * taskId keys the prewarm pool; without it the task's prewarm proc is left to its caller.
 */
function clearContext(session, taskId) {
  // Same teardown finalize/kill/detach use (timers, prewarm, group-kill of the turn proc), then
  // re-open the session: restart and new-session reuse keep this object alive for a fresh turn.
  // Lazy require — claude-session.js requires this module at load time.
  require('./claude-session').teardownObjectiveSession(session, taskId, 'clear-context');
  session._closed = false;
  session._aborted = false;
  session._retrying = false;
  session._retryAttempt = 0;
  // C1029: null every provider's session id, not just Claude's — a restart must not
  // leave a stale gemini/pi/codex session id behind that a later provider switch could
  // mis-resume. providerType/selectedModel are intentionally NOT reset here — a restart
  // keeps the user's current model choice (session-state.js comment).
  clearAllProviderSessionIds(session);
  session._providerSwitchPending = false;
  session.messages = [];
  session.buffer = '';
  session.turnBuffer = '';
  session.turnRawSse = '';
  session._lastEmittedCardsJson = null;
  session.turnTokens = null;
  session.totalTokens = { input: 0, output: 0, costUsd: 0, cacheCreation: 0, cacheRead: 0 };
  session.lastTurnAt = 0;
  session._heartbeatSleepBlocked = false;
  session._heartbeatDueAt = 0;
  session._lastCacheTouchAt = 0;
  session._heartbeatPings = 0;
  session.alive = false;
  session.compressedSummaries = [];
  session.compressedThrough = 0;
  session.pendingCompression = null;
}

/**
 * Partial trim — keeps first message (original objective context) + last N messages.
 * Resets claudeSessionId so next turn starts a fresh CLI session without stale resume.
 * Returns true if anything was trimmed, false if already within budget.
 */
function trimContext(session, options = {}) {
  if (session.type !== 'objective') return false;

  const keepMessages = options.keepMessages ?? config.CONTEXT_TRIM_KEEP_MESSAGES;

  // Nothing to trim if messages already within budget
  if (session.messages.length <= keepMessages + 1) return false;

  const first = session.messages[0];
  const tail = session.messages.slice(-keepMessages);
  session.messages = [first, ...tail];

  // Force fresh CLI session — old resume ID references trimmed turns. Clears whichever
  // provider is currently active (C1029) — not hardcoded to Claude, since trim can now
  // fire mid-chat on any provider.
  clearProviderSessionId(session, session.providerType || config.OBJECTIVE_PROVIDER);

  session.turnBuffer = '';
  session.turnRawSse = '';
  session._lastEmittedCardsJson = null;
  // Hard trim invalidates compressed summaries (base turn indices changed)
  session.compressedSummaries = [];
  session.compressedThrough = 0;
  session.pendingCompression = null;

  return true;
}

/**
 * Check whether auto-trim should fire based on token usage or message count.
 */
function shouldTrimContext(session) {
  if (session.type !== 'objective') return false;
  if (session.totalTokens.input > config.CONTEXT_MAX_INPUT_TOKENS) return true;
  if (session.messages.length > config.CONTEXT_MAX_MESSAGES) return true;
  return false;
}

/**
 * Clear per-turn streaming buffers only — use in abort handler.
 */
function resetTurnBuffers(session) {
  session.turnBuffer = '';
  session.turnRawSse = '';
  session._lastEmittedCardsJson = null;
}

module.exports = { clearContext, trimContext, shouldTrimContext, resetTurnBuffers };
