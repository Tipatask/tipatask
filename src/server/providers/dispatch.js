'use strict';

// Provider dispatcher for objective-chat turns.
// Routes based on session.providerType (C1029: user-switchable per turn via the
// chat-model-selector — see applyModelSelection() below — not just frozen at creation).
// Falls back to config.OBJECTIVE_PROVIDER for any pre-existing sessions without the field.
// spec-chat sessions are always routed to Claude (no Gemini/Pi/Codex spec-chat support in v1).
// A session carrying a tool profile (task chat — providers/tool-profiles.js) only runs on a
// provider that can enforce that profile; anything else falls back to Claude.

const config = require('../config');
const { spawnObjectiveTurn, killPrewarm, killColdPrewarm } = require('../claude-session');
const { spawnGeminiTurn } = require('./gemini-session');
const { spawnPiTurn } = require('./pi-session');
const { spawnCodexTurn } = require('./codex-session');
const registry = require('./registry');
const { listTaskAgentStatuses } = require('../task-agent');
const { providerSupportsProfile } = require('./tool-profiles');
const { prepareObjectiveProposalContext } = require('../objective-proposal-status');

/**
 * Provider-agnostic objective-turn entry point.
 * Drop-in replacement for spawnObjectiveTurn(session, taskId) — same signature.
 */
function spawnTurn(session, taskId) {
  const identity = require('../api-credentials').projectContextIdentity(session.projectPath);
  if (session._agentContextIdentity !== undefined && session._agentContextIdentity !== identity) {
    registry.clearAllProviderSessionIds(session);
    if (session.ws?.readyState === 1) session.ws.send(JSON.stringify({ type: 'objective-error', tabId: session.tabId,
      reason: 'project-context-changed', status: 409, detail: 'Project or account changed. Start a new chat.' }));
    return;
  }
  session._agentContextIdentity = identity;
  // A chat resumed from history (ws-handlers.js resumeChatFromHistory) has no local transcript
  // to rebuild from (its `restored` messages are display-only): without the provider's session id a turn would silently start a new
  // conversation, so it is refused instead.
  const resumed = session._resumedHistory;
  if (resumed && resumed.provider === (session.providerType || config.OBJECTIVE_PROVIDER) && !providerSessionId(session)) {
    if (session.ws?.readyState === 1) session.ws.send(JSON.stringify({ type: 'objective-error', tabId: session.tabId,
      reason: 'history-unavailable', status: 410, historyId: resumed.historyId,
      detail: 'The saved session for this chat is no longer attached. Start a new chat.' }));
    return;
  }
  if (session.type === 'objective' && session.backend) {
    if (session._spawning || session.proc) return;
    const epoch = session._epoch || 0;
    session._aborted = false;
    session._spawning = true;
    const preparing = prepareObjectiveProposalContext(session);
    const context = session._proposalContext;
    return preparing.then(() => {
      // Teardown/restart owns its throttle slot and replacement spawn state.
      if (session._closed || session._aborted || (session._epoch || 0) !== epoch
        || session._proposalContext !== context) return;
      session._spawning = false;
      return spawnPreparedTurn(session, taskId);
    });
  }
  return spawnPreparedTurn(session, taskId);
}

function spawnPreparedTurn(session, taskId) {
  let provider = session.providerType || config.OBJECTIVE_PROVIDER;
  if (!providerSupportsProfile(session, provider)) {
    // Never run a fenced chat on a provider with no fence. Reachable only through a server
    // default (OBJECTIVE_PROVIDER) — applyModelSelection() rejects an explicit pick.
    console.warn(`[${session.type}] provider "${provider}" cannot enforce the ${session.toolProfile} tool profile — using claude for task ${taskId}`);
    provider = 'claude';
    session.providerType = 'claude';
    session.selectedModel = null;
  }
  if (provider === 'gemini' && session.type !== 'specChat') {
    return spawnGeminiTurn(session, taskId);
  }
  if (provider === 'pi' && session.type !== 'specChat') {
    return spawnPiTurn(session, taskId);
  }
  if (provider === 'codex' && session.type !== 'specChat') {
    return spawnCodexTurn(session, taskId);
  }
  return spawnObjectiveTurn(session, taskId);
}

/**
 * Return the active session-id for the session's current provider.
 * Use instead of session.claudeSessionId in guards that must work for all providers —
 * i.e. any non-null value means "a prior turn exists and follow-up is valid."
 */
function providerSessionId(session) {
  const provider = session.providerType || config.OBJECTIVE_PROVIDER;
  return registry.getProviderSessionId(session, provider);
}

// Clear the CURRENT provider's session id (used by trimContext/maybeCompressHistory when
// forcing a fresh CLI session without a full provider switch).
function clearProviderSessionId(session) {
  const provider = session.providerType || config.OBJECTIVE_PROVIDER;
  registry.clearProviderSessionId(session, provider);
}

/**
 * Apply an incoming `msg.model` selection ("provider:model") to a session, ahead of a
 * start/chat/revise/restart spawn. Returns:
 *   { changed: false }                          — no-op (absent/invalid/specChat — safe default)
 *   { changed: true, providerChanged: bool }     — applied
 *   { error: 'provider-unavailable'|'turn-in-progress' } — caller must reject the turn
 *
 * A stale or malformed client value NEVER breaks the chat — it's treated as "keep current."
 */
async function applyModelSelection(session, raw, { taskId } = {}) {
  if (!session || session.type === 'specChat') return { changed: false };
  if (!raw) return { changed: false };
  // C1101 — project-scoped view so a project's saved "Other Model" (PI_MODEL) choice
  // validates instead of being rejected against the global PI_MODELS allowlist.
  const cfg = registry.configForProject(session.projectPath);
  if (!registry.isValidSelection(raw, cfg)) {
    console.warn(`[objective:model] ignoring invalid selection "${raw}" for task ${taskId}`);
    return { changed: false };
  }
  const { providerId, model } = registry.parseSelection(raw);
  if (!providerSupportsProfile(session, providerId)) {
    const label = (registry.PROVIDER_META[providerId] && registry.PROVIDER_META[providerId].label) || providerId;
    return { error: 'provider-unavailable', reason: `${label} is not available in this chat` };
  }
  if (session.proc || session._spawning) return { error: 'turn-in-progress' };
  const selectionEpoch = (session._modelSelectionEpoch || 0) + 1;
  session._modelSelectionEpoch = selectionEpoch;

  // (C1136) isValidSelection() above only checks the model against cfg.PI_MODELS, which
  // (configForProject) is still deliberately unioned with the global env-default list for
  // back-compat — so a stale/crafted selection naming a global Pi default this project has
  // no key for would pass it. This is the real enforcement point: entry.selectable folds in
  // enabled (AVAILABLE_AGENTS) + CLI availability + has-any-configured-model.
  // (C1515) The membership check reads entry.allowedModels, not entry.models — for
  // claude/codex that's the wider live-∪-static allowlist (registry.js allowedModelIds()),
  // so a resumed session or sticky pick naming an id the live catalog has since dropped from
  // the DISPLAYED `models` list still gets accepted here, matching what isValidSelection()
  // already allows. For pi, allowedModels is just an alias for the same narrowed `models`
  // value (see registry.js), so the pi-narrowed-models case isValidSelection lets through
  // is still caught here exactly as before.
  // `providers.find` never returns undefined here (listObjectiveProviders always returns all
  // SELECTABLE_PROVIDERS), but the fallback stays defensive.
  const providers = registry.listObjectiveProviders(cfg, { statuses: await listTaskAgentStatuses(cfg) });
  if (session._modelSelectionEpoch !== selectionEpoch) return { changed: false };
  const entry = providers.find(p => p.id === providerId);
  const offered = !!entry && entry.selectable && entry.allowedModels.some(m => m === model);
  if (!offered) {
    const label = (entry && entry.label) || providerId;
    return { error: 'provider-unavailable', reason: (entry && entry.reason) || `${label} is not available for this project` };
  }

  if (session.proc || session._spawning) {
    return { error: 'turn-in-progress' };
  }

  const currentProvider = session.providerType || config.OBJECTIVE_PROVIDER;
  const providerChanged = providerId !== currentProvider;
  const modelChanged = model !== session.selectedModel;
  if (!providerChanged && !modelChanged) return { changed: false };

  session.providerType = providerId;
  session.selectedModel = model;

  if (providerChanged) {
    session._providerSwitchPending = true;
    // An explicit switch leaves a resumed history entry behind: the new provider gets the
    // in-memory handoff and a native session (and history entry) of its own.
    session._resumedHistory = null;
    // Risk 10: any provider change nulls ALL provider session ids, so returning to a
    // provider used earlier in the same chat forces a fresh handoff instead of silently
    // --resume-ing a CLI history that's missing everything that happened in between.
    registry.clearAllProviderSessionIds(session);
    killPrewarm(taskId, 'provider-change');
    killColdPrewarm('provider-change');
  } else if (modelChanged && currentProvider === 'claude') {
    // Model-only change within Claude keeps claudeSessionId by default (--resume still
    // valid — verified: Claude CLI accepts a different --model on a resumed session and
    // keeps prior context); the prewarm pool always needs invalidating since it was
    // spawned with the old model's argv. OBJECTIVE_MODEL_SWITCH_RESUME=false is an escape
    // hatch that routes model-only changes through the same full-transcript handoff a
    // provider switch uses, in case --resume+--model ever misbehaves for some model pair.
    killPrewarm(taskId, 'model-change');
    killColdPrewarm('model-change');
    if (!config.OBJECTIVE_MODEL_SWITCH_RESUME) {
      session._providerSwitchPending = true;
      session._resumedHistory = null;
      registry.clearAllProviderSessionIds(session);
    }
  }

  return { changed: true, providerChanged };
}

module.exports = { spawnTurn, providerSessionId, clearProviderSessionId, applyModelSelection };
