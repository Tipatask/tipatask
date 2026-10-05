// ── Chat/Objective UI module ──
import state from './state.js';
import { DRAFT_KEY_OBJECTIVE, ACTIVE_NEW_TAB_KEY, LAST_PROMPT_KEY, CHAT_STATE_KEY, OBJECTIVE_MODEL_KEY, modelLabel, ensureAgentModels } from './constants.js';
import {
  saveDraft, loadDraft, clearDraft, getObjectiveDraftKey,
  escapeAttr, stripAnsi, stripJsonFromDisplay,
  parseObjectiveResult, buildObjectivePrompt, fetchWithRetry,
  showToast, projectHeader, isPristineObjectiveTab,
  isSubmitShortcut, isMacPlatform, submitShortcutLabel,
  captureSubtaskCtx, tabSubtaskContext, subtaskCtxFromChatState,
  canSubmitObjective, BLANK_SUBTASK_BRIEF,
} from './utils.js';
import { t, tc } from './i18n.js';
import { renderComposerHeader } from './composer-header.js';
export { renderComposerHeader };
import { buildWsUrl } from './ws-client.js';
import { cleanupChat, closeConsoleIfOpen } from './console-modal.js';
import { appendProgressLog, noteTurnBoundary, pushThinking, flushThinking, stageLogText } from './objective-progress-log.js';
import { saveRecipe } from './recipe-sidebar.js';
import { renderCardHtml, ensureExistingSnapshot, renderDiscussPreviewHtml, getLockedCardTarget } from './chat-task-preview.js';
import { countPendingSubtaskCards, hasProposalCards } from './subtask-preview.js';
import { attachImagePaste } from './task-board.js';
import { DROPDOWN_CARET_SVG, embedMenuHtml, attachEmbedMenu, closeOpenEmbedMenu } from './embed-menu.js';
import { openTaskEditModal } from './task-edit-modal.js';
import { showActionConfirm } from './action-confirm.js';
import { api } from './api-client.js';
import { countUnresolvedCards } from './chat-finalize.js';
import { ensureFileLinkHandler } from './file-attach.js';
import { requestPermission, notify, clearDebounce, objectiveTag, isNotifyEnabled } from './notifications.js';
import { pushNotification, dismissNotification } from './notification-center.js';
import { attachAudioRecorder, matchesVoiceShortcut, resolveVoiceTarget } from './audio-recorder.js';
import { getObjectiveGroupingEnabled } from './group-label.js';
import { buildInitialAcceptedMask } from './objective-origin-task.js';
import { draftRelationshipForSave, draftRelationshipNeedsLegacyFallback, restoreDraftRelationship } from './chat-draft-metadata.js';
import { collectDiscussingKeys, collectLockIntents, sameKeySet, sameIntentMap } from './discuss-lock.js';
import { shouldRefreshProviders, providersUnhealthy, providersSignature, PROVIDERS_RETRY_DELAY_MS } from './objective-providers-refresh.js';
// (TPT16) Re-exported (not imported for local use — nothing in this file calls it) so
// template.html's classic script, which only reaches chat-ui.js's exports via
// window.TipTask.chatUI (see index.js's `import * as chatUI`), can build the same seed
// string seedObjectiveFromTask() drops into #chat-input.
export { buildObjectiveSeed } from './objective-origin-task.js';

// (C1296) formatCost() removed with the assistant-bubble .ai-stats/.turn-timing render —
// no other call site existed.

function reload() {
  document.dispatchEvent(new Event('tiptask:reload'));
}

// (C1211) Shared by renderObjectiveContent()'s inputDisabled gate and attachChatHandlers()'s
// mic lock, so the two can never disagree on whether a turn is in flight.
function objectiveIsStreaming() {
  return !!(state.chatState && state.chatState.messages.some(m => m.streaming));
}

// Keep the mounted Objective shell in sync with the two composer layouts. Rendering stamps the
// initial class, while this DOM-level helper handles the empty -> active transition immediately
// when the first message creates state, before the normal full render catches up.
export function syncObjectiveChatLayout(root = typeof document !== 'undefined' ? document : null) {
  const container = root?.matches?.('.chat-container')
    ? root
    : root?.querySelector?.('.chat-container');
  if (!container) return false;

  const active = !!state.chatState;
  container.classList.toggle('objective-chat--empty', !active);
  container.classList.toggle('objective-chat--active', active);
  return true;
}

function notifyObjectiveStatusChanged() {
  // (TPT271) Safety net: every tab-bar repaint re-derives the discuss locks, covering tab
  // teardown routes that don't call syncDiscussLocks() themselves (cleanupChat(), restores).
  syncDiscussLocks();
  document.dispatchEvent(new Event('tiptask:objective-status-changed'));
}

// (TPT271/TPT283) Recompute state.discussingTaskKeys + state.discussLockIntents from the open
// tabs; dispatch 'tiptask:discuss-lock-changed' (detail.keys) only when either actually changed
// (an intent flip on the same key must still refresh the hourglass tooltip), so calling this
// freely is cheap and never spams listeners.
export function syncDiscussLocks() {
  const next = collectDiscussingKeys(state.tabsState);
  const intents = collectLockIntents(state.tabsState);
  if (sameKeySet(next, state.discussingTaskKeys) && sameIntentMap(intents, state.discussLockIntents)) return;
  state.discussingTaskKeys = next;
  state.discussLockIntents = intents;
  document.dispatchEvent(new CustomEvent('tiptask:discuss-lock-changed', { detail: { keys: [...next] } }));
}

// ── Chat-model-selector (C1029, extended to gemini/pi C1030) ──
// modelLabel() moved to constants.js (C1118) — shared with the terminal header caption in
// console-modal.js. (C1515) Server ships offered claude/codex ids from the C1504 live model
// registry (task-agent/model-registry.js) when it has a warm cache, falling back to the
// static config.js CLAUDE_MODELS/CODEX_MODELS list otherwise (registry.js offeredModelIds());
// gemini/pi still only ever have the static GEMINI_MODELS/PI_MODELS list, no probe exists for
// them. Display labels remain client-side — modelLabel() checks the C1505 live registry
// (constants.js _liveModelOptions, warmed below) before falling back to the static label
// lists, same lists the task-edit modal's Agent-Models selects already use.

// Per-tab override wins over the sticky cross-session default so two tabs can run
// different models at once.
function effectiveObjectiveModel() {
  return (state.chatState && state.chatState.objectiveModel) || state.objectiveModel || null;
}

// C1031 — label of the provider that ACTUALLY ran, for error copy. `providerId` comes from the
// server on objective-error and is authoritative: the client selector can legitimately name a
// different provider (the change handler updates state optimistically, a switch may have been
// rejected, and effectiveObjectiveModel() reads the ACTIVE tab while errors are routed per-tab).
// Falls back to that tab's own selection (old server / new client), then a neutral noun.
function providerLabelFor(cs, providerId) {
  const id = providerId || (((cs && cs.objectiveModel) || state.objectiveModel || '').split(':')[0]);
  if (!id) return 'The model';
  const entry = (state.objectiveProviders || []).find(p => p.id === id);
  return (entry && entry.label) || (id.charAt(0).toUpperCase() + id.slice(1));
}

// C1031 — coarse category for an objective-error reason. Drives BOTH the system-message
// sentence and the retry-banner line, so the two can never disagree.
// Reason strings by origin: claude-session.js emitObjectiveError (turn-deadline,
// stream-idle-timeout, stderr:*, exit-code-*, spawn-error:*, empty-history);
// gemini/codex 'exit-code-spawn-error'; pi 'spawn-error'; codex env-build 'spawn-error:*' and
// 'codex:*'; ws-handlers throttle gate 'circuit-open'/'queue-full'; applyModelSelection
// 'provider-unavailable'/'turn-in-progress'; finalize race 'finalize-timeout'; ws-handlers
// 'session-gone' (turn request or reconnect reached a server session that was already torn down).
function objectiveErrorCategory(reason) {
  if (reason === 'stream-stalled') return 'stall';
  if (reason === 'session-gone') return 'gone';
  if (reason === 'provider-unavailable' || reason === 'turn-in-progress') return 'selection';
  if (reason === 'circuit-open' || reason === 'queue-full') return 'throttle';
  if (reason === 'spawn-error' || reason === 'exit-code-spawn-error' || reason.startsWith('spawn-error:')) return 'spawn';
  if (reason === 'empty-history') return 'history';
  if (reason === 'finalize-timeout') return 'finalize';
  return 'stream';
}

// C1031 — full sentence pushed as a system message. Pre-C1031 every reason except the two
// selection ones rendered as "Claude stream failed after N retry attempt(s)…", which was wrong
// twice over: it named Claude for Codex/Gemini/Pi failures, and it claimed a stream failed for
// circuit-open / queue-full / spawn errors where no stream ever started.
function objectiveErrorMessage(reason, attempts, detail, label, model) {
  switch (objectiveErrorCategory(reason)) {
    case 'stall':
      return t('chat.error.stalled');
    case 'gone':
      return t('chat.error.sessionGone');
    case 'selection':
      return detail || `Model selection failed (${reason}). Retry or pick a different model.`;
    case 'throttle':
      return reason === 'circuit-open'
        ? 'The server paused new AI turns after repeated failures. Wait about 30 seconds and Retry, or pick a different model.'
        : 'The server is busy — too many AI turns are queued. Wait a moment, then Retry.';
    case 'spawn': {
      const why = reason.startsWith('spawn-error:') ? ` (${reason.slice('spawn-error:'.length)})` : '';
      return `${label}'s CLI could not be started${why}. Check that it is installed and signed in, or pick a different model.`;
    }
    case 'history':
      return 'This chat lost its message history and could not continue. Retry restarts from your original prompt, or start a new objective.';
    case 'finalize':
      return 'Saving the task cards timed out. Nothing was lost — Retry.';
    default: {
      // model/detail are sent by providers that know them (pi): which model id was actually
      // run, and the CLI's own stderr / provider error text.
      const tried = attempts > 0 ? ` after ${attempts} retry attempt(s)` : '';
      const which = model ? ` Model: ${model}.` : '';
      const why = detail ? ` Details: ${detail}` : '';
      return `${label} stream failed${tried} (${reason}).${which}${why} Retry or refine your prompt.`;
    }
  }
}

// C1031 — short actionable line for the retry banner above the input. Returns PLAIN text
// (including the raw parse preview); the caller escapes once.
function objectiveRetryBannerText(cs, previewSnippetRaw) {
  const reason = cs && cs._lastErrorReason;
  const label = providerLabelFor(cs, cs && cs._lastErrorProvider);
  if (!reason) return `${label} didn't produce task cards.${previewSnippetRaw} Retry or send refined instructions.`;
  switch (objectiveErrorCategory(reason)) {
    case 'stall':     return t('chat.error.stalledRetry');
    case 'gone':      return t('chat.error.sessionGoneRetry');
    case 'selection': return 'That model selection was rejected. Pick a different model, then Retry.';
    case 'throttle':  return 'The server is busy right now. Wait a moment, then Retry.';
    case 'spawn':     return `${label}'s CLI didn't start. Pick a different model, or Retry.`;
    case 'history':   return 'This chat lost its history. Retry restarts from your original prompt.';
    case 'finalize':  return 'Saving timed out. Retry to finish.';
    default:          return `${label} didn't finish this turn (${reason}). Retry or send refined instructions.`;
  }
}

// (C1045) Shared by the WS `config` frame handler and the page-load providers fetch
// (below) so the objectiveSelection-adoption rule can't drift between the two paths.
// Only adopt the server's selection as the sticky default when nothing local is set
// yet, or when the locally-remembered choice no longer names an available provider —
// server is authoritative once a session exists (chat-history-reset), but at this
// bare-config stage local preference should otherwise win.
//
// (TPT181) Every writer of state.objectiveProviders goes through here, so this is also where the
// composer-open refresh's bookkeeping lives: the last-applied time and signature. Returns true
// when the applied list/selection differs from the previous one — i.e. the selector would render
// differently — so callers repaint only on a real change instead of on every event/fetch.
let _providersFetchedAt = 0;
let _providersSig = '';
let _providersFetchInFlight = false;

function applyProviderConfig(payload) {
  const sig = Array.isArray(payload.objectiveProviders) ? providersSignature(payload) : null;
  if (sig !== null) _providersFetchedAt = Date.now();
  if (Array.isArray(payload.objectiveProviders)) state.objectiveProviders = payload.objectiveProviders;
  if (payload.objectiveSelection) {
    // (C1101) Check the exact provider:model pair, not just the provider — a sticky
    // localStorage default carries no project scope (OBJECTIVE_MODEL_KEY is one key
    // shared by every project window), so a model belonging to another project (e.g.
    // a per-project PI_MODEL) must not be kept just because its provider is available.
    // Keeping it would make the selector show a model the server will reject.
    const knownSelection = (raw) => {
      const i = raw ? raw.indexOf(':') : -1;
      if (i < 0) return false;
      const providerId = raw.slice(0, i);
      const model = raw.slice(i + 1);
      const p = state.objectiveProviders.find(pr => pr.id === providerId);
      return !!(p && p.available && Array.isArray(p.models) && p.models.some(m => m.value === model));
    };
    if (!state.objectiveModel || !knownSelection(state.objectiveModel)) {
      state.objectiveModel = payload.objectiveSelection;
    }
  }
  if (sig === null) return false;
  const changed = sig !== _providersSig;
  _providersSig = sig;
  return changed;
}

// (C1045) True once the page-load providers fetch below has settled (success or
// failure) — gates the empty-providers warn so a normal load's brief pre-fetch window
// (state.objectiveProviders still []) never false-positives.
let _providersInitSettled = false;
let _warnedNoProviders = false;

function buildModelSelectorHtml(disabledAttr) {
  const providers = state.objectiveProviders || [];
  if (providers.length === 0) {
    if (_providersInitSettled && !_warnedNoProviders) {
      _warnedNoProviders = true;
      console.warn('[objective:selector] no objectiveProviders in state after init fetch settled — model selector will not render');
    }
    return '';
  }
  const current = effectiveObjectiveModel();
  const optgroups = providers.map((p) => {
    const options = (p.models || []).map((m) => {
      const val = `${p.id}:${m.value}`;
      const selected = val === current ? ' selected' : '';
      const dis = !p.available ? ' disabled' : '';
      const titleAttr = !p.available && p.reason ? ` title="${escapeAttr(p.reason)}"` : '';
      return `<option value="${escapeAttr(val)}"${selected}${dis}${titleAttr}>${escapeAttr(modelLabel(p.id, m.value))}</option>`;
    }).join('');
    if (!options) return '';
    const groupDisabled = !p.available ? ' disabled' : '';
    const groupTitle = !p.available && p.reason ? ` title="${escapeAttr(p.reason)}"` : '';
    return `<optgroup label="${escapeAttr(p.label)}"${groupDisabled}${groupTitle}>${options}</optgroup>`;
  }).join('');
  if (!optgroups) return '';
  // (C1242) Visible label lives inside the wrapper (not a sibling in .chat-input-actions) so it
  // disappears together with the select on the empty-providers early return above, and stays on
  // the correct side of .chat-model-selector's margin-right:auto. <label for> is the accessible
  // name now — drop the old hardcoded aria-label="Model" so nothing overrides it.
  return `<div class="chat-model-selector"><label for="chat-model-select">${escapeAttr(t('field.model'))}</label><select id="chat-model-select"${disabledAttr}>${optgroups}</select></div>`;
}

// (C1241) Embed control — embed-menu.js, shared with the task / project chat composer. Keeps id
// #btn-obj-img-upload so COMPOSER_TOOLTIPS (below) and the C1211 disabled-state wiring in
// attachChatHandlers() need no change; (C1246) "Other file" uses its own picker (#obj-file-input).
function buildEmbedMenuHtml(disabledAttr) {
  return embedMenuHtml({
    label: t('nav.embed'),
    disabled: !!disabledAttr,
    triggerId: 'btn-obj-img-upload',
    imageInputId: 'obj-img-file-input',
    fileInputId: 'obj-file-input',
  });
}

// (C1240, .import-menu-trigger re-parented into composer C1241) selector → i18n key for every
// composer control's hover tooltip. Null-safe lookup (querySelector may miss on the New Task
// view, which renders neither control) so one table covers both chat view and any future render
// shape. Mic buttons excluded on purpose — audio-recorder.js's setIdle() owns their title
// (record label + shortcut, or disabled reason) and rewrites it per recording.
const COMPOSER_TOOLTIPS = [
  ['#chat-model-select', 'tooltip.model'],
  ['#btn-obj-img-upload', 'tooltip.embed'],
  ['.import-menu-trigger', 'tooltip.import'],
  ['#chat-input', 'tooltip.brief'],
  ['#btn-chat-send', 'tooltip.send'],
  ['#btn-chat-stop', 'tooltip.stop'],
  ['#btn-chat-retry', 'tooltip.retry'],
  ['#clear-objective-draft', 'tooltip.clearDraft'],
  ['#btn-archive', 'tooltip.history'],
  ['#chat-console-toggle', 'tooltip.console'],
  ['#new-task-preview', 'tooltip.preview'], // (C1242) New Task view — same null-safe lookup
];

// Icon-only buttons need aria-label too (no visible text to name them by). Text buttons
// (Send/Stop/Retry/History/Clear Draft/Embed/Import) keep their own visible label as the
// accessible name — setting aria-label there would override it and diverge from what's on screen.
const COMPOSER_TOOLTIP_ICON_ONLY = new Set(['#chat-console-toggle']);

export function addComposerTooltips(root = document) {
  // (C1242) shortcut substituted into tooltip.send/tooltip.preview — t() only replaces {param}
  // occurrences actually present in a given key's string, so the other entries are unaffected.
  const params = { shortcut: submitShortcutLabel(isMacPlatform()) };
  for (const [selector, key] of COMPOSER_TOOLTIPS) {
    const el = root.querySelector(selector);
    if (!el) continue;
    const label = t(key, params);
    el.title = label;
    if (COMPOSER_TOOLTIP_ICON_ONLY.has(selector)) el.setAttribute('aria-label', label);
  }
}

let _saveChatTimer = null;
let _saveDraftTimer = null;
let _objectiveNotificationPermissionRequested = false;
// (TPT16) One-shot seed queued by spawnObjectiveTab() for the tab it just created/reused —
// consumed by attachChatHandlers() the first time it runs against a LIVE #chat-input for
// this tabId (reload()'s loadAndRender() is async, so the DOM node at spawn time is stale
// or doesn't exist yet — see spawnObjectiveTab() below). Cleared on consume so a later
// render of the same tab never re-steals focus.
let _pendingComposerSeed = null;
const OBJECTIVE_HISTORY_PAGE_MESSAGES = 8;
const MAX_TABS = 10;
// Namespace BroadcastChannel per project so Electron windows for different
// projects don't receive each other's objective-ready toasts/counts.
// In browser/single-project mode (no ?projectPath=), falls back to 'tipatask'.
const _objectiveProjectKey = new URLSearchParams(
  typeof location !== 'undefined' ? location.search : ''
).get('projectPath') || '';
const OBJECTIVE_READY_CHANNEL_NAME = _objectiveProjectKey
  ? `tipatask:${_objectiveProjectKey}` : 'tipatask';
const OBJECTIVE_READY_SESSION_KEY = 'tipatask-objective-ready';
const OBJECTIVE_READY_SENDER_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let _objectiveReadyChannel = null;
let _objectiveReadyListenerAttached = false;

function requestObjectiveNotificationPermission() {
  if (_objectiveNotificationPermissionRequested) return;
  _objectiveNotificationPermissionRequested = true;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') requestPermission();
}

// (C1147) Shared tag-construction so every open/focus dismiss path stays consistent —
// used by focusObjectiveSession() (OS banner / in-app card click), switchTab() (tab-bar
// click), and template.html's top-nav "Objective" tab handler.
export function dismissObjectiveNotification(tabId) {
  dismissNotification(objectiveTag(tabId));
}

function focusObjectiveSession(tabId) {
  dismissObjectiveNotification(tabId);
  try { window.electronAPI && window.electronAPI.focusSelf && window.electronAPI.focusSelf(); } catch (_) {}
  const target = state.tabsState.find(t => t.tabId === tabId);
  if (target) {
    syncActiveChatState();
    state.activeTabId = target.tabId;
    state.chatState = target.chatState;
  }
  state.activeTab = 'objective';
  try { sessionStorage.setItem(ACTIVE_NEW_TAB_KEY, 'objective'); } catch (_) {}
  reload();
}

function getObjectiveReadyChannel() {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!_objectiveReadyChannel) {
    try {
      _objectiveReadyChannel = new BroadcastChannel(OBJECTIVE_READY_CHANNEL_NAME);
    } catch (_) {
      _objectiveReadyChannel = null;
    }
  }
  return _objectiveReadyChannel;
}

function rememberObjectiveReady(payload) {
  try {
    sessionStorage.setItem(OBJECTIVE_READY_SESSION_KEY, JSON.stringify(payload));
  } catch (_) {}
}

function clearObjectiveReadyMemory(tabId) {
  try {
    const raw = sessionStorage.getItem(OBJECTIVE_READY_SESSION_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!tabId || !saved || saved.tabId === tabId) {
      sessionStorage.removeItem(OBJECTIVE_READY_SESSION_KEY);
    }
  } catch (_) {
    try { sessionStorage.removeItem(OBJECTIVE_READY_SESSION_KEY); } catch (_) {}
  }
}

function getObjectiveReadyTitle(tabId, cs) {
  const tab = state.tabsState.find(t => t.tabId === tabId);
  if (tab && tab.title && tab.title !== 'New objective') return tab.title;
  return deriveTabTitle(cs || (tab && tab.chatState));
}

function broadcastObjectiveReady(payload) {
  const channel = getObjectiveReadyChannel();
  if (!channel) return;
  try { channel.postMessage(payload); } catch (_) {}
}

function initObjectiveReadyBroadcastListener() {
  if (_objectiveReadyListenerAttached) return;
  const channel = getObjectiveReadyChannel();
  if (!channel) return;
  _objectiveReadyListenerAttached = true;
  channel.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type !== 'objective-ready' || msg.senderId === OBJECTIVE_READY_SENDER_ID) return;
    // Belt-and-suspenders: ignore cross-project messages even on the same channel
    if (msg.projectPath !== _objectiveProjectKey) return;
    rememberObjectiveReady(msg);
    notifyObjectiveStatusChanged();
    if (document.visibilityState === 'visible') {
      showToast(`Objective ready: ${msg.title || 'New objective'}`);
    }
  });
}

function notifyObjectiveCardsReady(message, count, tabId) {
  if (!message || message._objectiveCompleteNotified || count <= 0) return;
  message._objectiveCompleteNotified = true;
  const title = getObjectiveReadyTitle(tabId);
  const payload = {
    type: 'objective-ready',
    tabId,
    title,
    count,
    ts: Date.now(),
    senderId: OBJECTIVE_READY_SENDER_ID,
    projectPath: _objectiveProjectKey,
  };
  rememberObjectiveReady(payload);
  notifyObjectiveStatusChanged();
  broadcastObjectiveReady(payload);
  const summary = `${count} task suggestion(s) ready`;
  // (C1137) Same project-disambiguation reasoning as attention-notifications.js's
  // buildNotificationTitle — several projects can run in separate Electron windows.
  const notifTitle = state.projectName ? `${state.projectName} · Objective complete` : 'Objective complete';
  const onClick = () => focusObjectiveSession(tabId);
  // In-app stacked card — persists regardless of OS notification style, and (unlike the toast
  // 2s below) shown even when the window IS visible, since the toast alone vanishes fast too.
  if (isNotifyEnabled('objective')) {
    pushNotification({ tag: objectiveTag(tabId), title: notifTitle, body: summary, onClick, category: 'objective' });
  }
  if (document.visibilityState === 'visible') {
    showToast(`Objective ready: ${title}`);
  } else {
    notify(notifTitle, summary, objectiveTag(tabId), { category: 'objective', onClick });
  }
}

initObjectiveReadyBroadcastListener();

// ── Tab helpers ──

function getActiveTab() {
  return state.tabsState.find(t => t.tabId === state.activeTabId) || null;
}

function computeTabStatus(cs) {
  if (!cs) return 'idle';
  if (cs._lastErrorReason) return 'error';
  if (cs.messages && cs.messages.some(m => m.streaming)) return 'streaming';
  if (cs.messages && cs.messages.some(m => m.role === 'assistant' && !m.streaming)) return 'done';
  return 'idle';
}

function deriveTabTitle(cs) {
  const first = cs && cs.messages && cs.messages.find(m => m.role === 'user');
  return first ? (first.content.slice(0, 30).replace(/\s+/g, ' ').trim() || 'New objective') : 'New objective';
}

function syncActiveChatState() {
  const t = getActiveTab();
  if (!t) return;
  t.chatState = state.chatState;
  t.status = computeTabStatus(state.chatState);
  // (C1162) titlePinned tabs (spawnObjectiveTab() opts.title) keep their label —
  // deriveTabTitle() would otherwise overwrite it with the first message's text.
  if (!t.titlePinned && (!t.title || t.title === 'New objective')) t.title = deriveTabTitle(state.chatState);
}

function clearActiveTab() {
  const t = getActiveTab();
  if (t) { t.chatState = null; t.status = 'idle'; }
  state.chatState = null;
}

function switchTab(tabId) {
  // (C1147) Dismiss before the same-tab guard below — a re-click of the already-active
  // tab must still clear a lingering "Objective complete" card for it.
  dismissObjectiveNotification(tabId);
  if (tabId === state.activeTabId) return;
  const next = state.tabsState.find(t => t.tabId === tabId);
  if (!next) return;
  rememberActiveTabView();
  syncActiveChatState();
  state.activeTabId = tabId;
  state.chatState = next.chatState;
  renderActiveTab();
}

function rememberActiveTabView() {
  captureCardEdits();
  const tab = getActiveTab();
  if (tab) tab.viewState = captureObjectiveViewState();
}

// Session navigation uses already-loaded tab state, even while a turn is running.
// Never carry the outgoing composer's text/scroll into the incoming tab or wait for
// reload()'s unrelated board-data fetch before displaying it.
function renderActiveTab() {
  if (!refreshObjectiveContent({ viewState: getActiveTab()?.viewState || null })) reload();
  notifyObjectiveStatusChanged();
}

function openNewTab() {
  if (state.tabsState.length >= MAX_TABS) return;
  rememberActiveTabView();
  syncActiveChatState();
  // (C1156) Dismiss OUTGOING tab's card before reassign below — after reassign, C1154's
  // loadAndRender() guard would dismiss objective-<newTabId>, tag that never existed.
  if (state.activeTabId) dismissObjectiveNotification(state.activeTabId);
  const tabId = `obj-new-${Date.now()}`;
  // (C1410) Brand-new empty tab — snapshot board drill-down top ONCE at creation, never
  // re-read live. See utils.js captureSubtaskCtx() comment for the bug this replaces.
  // (C1559) originTaskKey: null — never inherited from a prior tab; only
  // spawnObjectiveTab()'s explicit opts.originTaskKey sets it.
  state.tabsState.push({ tabId, title: 'New objective', status: 'idle', chatState: null, subtaskCtx: captureSubtaskCtx(state.subtaskStack), originTaskKey: null });
  state.activeTabId = tabId;
  state.chatState = null;
  renderActiveTab();
}

// (C1162) Card/import entry points (Reiterate→Discuss, Reiterate→Split-AI, Trello import,
// Gmail import) call this instead of hand-seeding the currently-focused tab's draft.
// Reuses a pristine active tab (no msgs, no draft); else allocates a fresh obj-new-* tab,
// blocked by MAX_TABS. seedText → that tab's draft. opts.title pins the tab label so it
// doesn't get overwritten by deriveTabTitle(). opts.subtaskCtx sets tab-scoped subtask
// context (see tabSubtaskCtx()). (C1410) omitting is NOT "inherit the global stack" — it
// resolves to null (line below), same as passing null explicitly; the global-stack fallback
// this comment used to describe was removed by C1410 (see utils.js § Subtask context).
export function spawnObjectiveTab(seedText, opts = {}) {
  const text = String(seedText || '');
  syncActiveChatState();

  const active = getActiveTab();
  const reuse = isPristineObjectiveTab(active, loadDraft(getObjectiveDraftKey()));

  let tabId;
  if (reuse) {
    tabId = active.tabId;
  } else {
    if (state.tabsState.length >= MAX_TABS) {
      showToast(t('toast.objectiveTabsFull'));
      return null;
    }
    // (C1156) Dismiss OUTGOING tab's card before reassign — see openNewTab() above.
    if (state.activeTabId) dismissObjectiveNotification(state.activeTabId);
    tabId = `obj-new-${Date.now()}`;
    state.tabsState.push({ tabId, title: 'New objective', status: 'idle', chatState: null });
    state.activeTabId = tabId;
    state.chatState = null;
  }

  const tab = state.tabsState.find(t => t.tabId === tabId);
  if (opts.title) { tab.title = String(opts.title).slice(0, 30); tab.titlePinned = true; }
  tab.subtaskCtx = opts.subtaskCtx !== undefined ? opts.subtaskCtx : null;
  Object.assign(tab, rehashPayload(opts));
  tab.lockReleased = false; // (TPT283) a fresh Rehash open always locks, even on a reused tab
  if (tab.rehashIntent === 'discuss') discussTaskCache.delete(tab.taskKey); // fresh fetch per open
  syncDiscussLocks(); // (TPT271) unconditional — a reused pristine tab may have dropped a prior discuss
  tab.viewState = null;
  // (C1559) Explicit object-or-null form, same reason as subtaskCtx above — a
  // reused pristine tab (line ~523) must never carry a PRIOR handoff's origin
  // into an unrelated Trello/Gmail/Reiterate spawn.
  tab.originTaskKey = opts.originTaskKey !== undefined ? opts.originTaskKey : null;

  if (text) saveDraft(`${DRAFT_KEY_OBJECTIVE}-${tabId}`, { text });
  else clearDraft(`${DRAFT_KEY_OBJECTIVE}-${tabId}`);

  // (TPT16) Queue for attachChatHandlers() to apply once the live composer exists —
  // see _pendingComposerSeed's own comment above for why this can't be done here.
  _pendingComposerSeed = text ? { tabId, text } : null;

  state.activeTab = 'objective';
  state.pendingScrollTop = true;
  try { sessionStorage.setItem(ACTIVE_NEW_TAB_KEY, 'objective'); } catch {}
  reload();
  return tabId;
}

// Only explicit Rehash opens ('split' | 'discuss') carry hidden intent; ordinary tabs always send
// null. Literal comparisons, not a module-level Set: chat-rehash.test.js extracts this function's
// source into a bare vm context, where a module constant would be a ReferenceError.
function rehashPayload(context) {
  return (context?.rehashIntent === 'split' || context?.rehashIntent === 'discuss') && context.taskKey
    ? { rehashIntent: context.rehashIntent, taskKey: context.taskKey, ...(context.lockReleased ? { lockReleased: true } : {}) }
    : { rehashIntent: null, taskKey: null };
}

// (TPT179) Rehash → Discuss: the discussed task pinned above the transcript. Cache entry is
// { pending: true } | { task } | { error: true }. Errors stay cached (a permanently failing key —
// e.g. a since-deleted task — must not refetch on every re-render); spawnObjectiveTab() clears the
// key on every fresh Discuss open, so each open shows current data.
const discussTaskCache = new Map();

// Active tab's own captured discuss target, never live — same discipline as tabOriginTaskKey().
function tabDiscussKey() {
  const tab = getActiveTab();
  return tab && tab.rehashIntent === 'discuss' && tab.taskKey ? tab.taskKey : null;
}

function ensureDiscussTask(key) {
  const hit = discussTaskCache.get(key);
  if (hit) return hit;
  const pending = { pending: true };
  discussTaskCache.set(key, pending);
  api.tasks.get(key).then(
    (task) => discussTaskCache.set(key, task ? { task } : { error: true }),
    () => discussTaskCache.set(key, { error: true }),
  ).then(() => paintDiscussPreview(key));
  return pending;
}

// Repaint ONLY the preview node — no reload(), so the composer text, scroll position and any
// in-flight card edits survive, and there is no re-render loop against ensureDiscussTask().
function paintDiscussPreview(key) {
  const el = document.querySelector('.chat-discuss-preview');
  if (!el || el.dataset.discussKey !== key) return; // tab switched / view re-rendered meanwhile
  const tpl = document.createElement('template');
  tpl.innerHTML = renderDiscussPreviewHtml(key, discussTaskCache.get(key));
  const next = tpl.content.firstElementChild;
  el.replaceWith(next);
  bindDiscussPreview(next);
}

// Click/Enter/Space on the card opens the live task READ-ONLY (a direct edit mid-discussion would
// race the "modified" proposal whose baseline is hydrated from the live task). No detach control —
// discuss mode lasts for the tab's lifetime.
function bindDiscussPreview(root) {
  if (!root) return;
  const card = root.querySelector('.chat-discuss-card');
  if (card) {
    const open = () => openTaskEditModal(card.dataset.discussTask, { readOnly: true });
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  }
}

// (C1162) Objective-chat's per-tab subtask context — a tab spawned via spawnObjectiveTab()
// with an explicit subtaskCtx overrides the global state.subtaskStack (which still drives
// board drill-down/breadcrumbs unmodified). undefined tab.subtaskCtx = never set by
// spawnObjectiveTab() → fall back to the global stack (legacy single-tab behavior).
// (C1410) NO fallback to state.subtaskStack (the global board drill-down stack) here anymore —
// every tab-creation site below now sets tab.subtaskCtx explicitly (object or null), so a live
// re-read of the board's current stack can no longer leak into an unrelated/reused/restored tab.
function tabSubtaskCtx() {
  return tabSubtaskContext(getActiveTab());
}

// (C1559) Active tab's own captured web-origin task key — see spawnObjectiveTab()
// opts.originTaskKey above. Never live: set once at tab creation, same discipline
// as tabSubtaskCtx() above.
function tabOriginTaskKey() {
  return (getActiveTab() || {}).originTaskKey || null;
}

// (TPT20) Cards in this chat that are still live — neither saved nor rejected. Same rule
// checkAllCardsHandled() uses to decide the chat is finished, via the shared chat-finalize.js
// helper, so "the × asks first" and "the chat closes itself" can never disagree on what
// counts as unsaved.
function countUnsavedProposals(cs) {
  if (!cs || !Array.isArray(cs.messages)) return 0;
  return cs.messages.reduce((n, m) => n + countUnresolvedCards(m), 0);
}

// (TPT20) Re-entrancy guard for the tab-bar ×. closeTab() now awaits an in-app confirm, and
// a full pane render during that await rebuilds the bar and re-binds the handler to a fresh
// × node — so a module-level Set keyed by tabId, not a DOM dataset flag that the repaint
// would wipe. Same idiom as template.html's _closingObjectiveTabs (C1463).
const _closingChatTabs = new Set();

// (TPT20) Closing a chat tab ALWAYS discards that chat completely — server chat-state.json +
// .chat-draft*.json, sessionStorage CHAT_STATE_KEY, the per-tab AND bare composer draft keys —
// via cleanupChat(force:true). The old code skipped the entire purge whenever any card was
// still accepted-but-unconfirmed; because the draft file is per PROJECT and nothing else
// deletes it, a saved/resolved objective's whole transcript resurfaced on the next app start.
// Unsaved proposals are now protected by the confirm below, not by leaving files behind.
export async function closeTab(tabId) {
  if (_closingChatTabs.has(tabId)) return;
  const idx = state.tabsState.findIndex(t => t.tabId === tabId);
  if (idx === -1) return;
  _closingChatTabs.add(tabId);
  try {
    const pending = countUnsavedProposals(state.tabsState[idx].chatState);
    if (pending > 0) {
      const ok = await showActionConfirm({
        message: tc('chat.confirmCloseTabUnsaved', pending, { title: escapeAttr(state.tabsState[idx].title) }),
        confirmLabel: t('btn.discard'),
        danger: true,
        overlayClass: 'modal-overlay--over-chat',
      });
      // Cancel/Esc/backdrop: the chat stays open AND untouched — nothing aborted, nothing
      // purged, no notification dismissed. This is why _abortTab() moved in here (below), out
      // of the click handler, where it used to run before the user had any say.
      if (!ok) return;
    }
    // Re-resolve after the await — the tab list can change while the dialog is up (e.g. a
    // first-message abort elsewhere tearing down its own tab inline).
    const tab = state.tabsState.find(t => t.tabId === tabId);
    if (!tab) return;
    // A tab without a live socket (never sent a turn, or restored with no server session) may
    // still have warmed the global cold prewarm from its composer, and no server session exists
    // whose teardown would drop it — cancel it explicitly. Checked before _abortTab() closes the socket.
    const liveWs = tab.chatState && tab.chatState.ws;
    if (!liveWs || liveWs.readyState !== WebSocket.OPEN) {
      fetchWithRetry('/api/objective/prewarm', { method: 'DELETE', timeoutMs: 5000, retries: 0, label: 'objective-prewarm-cancel' }).catch(() => {});
    }
    // Not awaited: the ws `abort` frame + socket close happen synchronously (that's the part
    // teardown depends on), while its POST /api/objective/abort runs on fetchWithRetry's 30s ×
    // 3 defaults — awaiting it would freeze the tab on screen for up to ~90s after Discard.
    _abortTab(tabId);
    // (C1073/C1137) This tab's notification debounce stamp + stacked card + ready memory.
    // Deliberately below the confirm — a cancelled close must not clear a card for a tab that
    // stays open. cleanupChat() repeats the debounce/dismiss pair for the tab it splices; both
    // are idempotent, and the cs === null branch below never reaches it.
    clearDebounce(objectiveTag(tabId));
    dismissNotification(objectiveTag(tabId));
    clearObjectiveReadyMemory(tabId);
    const cs = tab.chatState;
    const wasActive = state.activeTabId === tabId;
    if (cs) {
      // cleanupChat() owns the whole teardown: ws kill, xterm/ticker dispose, splicing THIS
      // tab (located by chatState identity, not index), the persistence purge, and re-pointing
      // the active tab to a survivor. Never call it with a falsy cs — it falls back to
      // state.chatState and would tear down the wrong (visible) chat.
      cleanupChat(cs, { force: true });
      syncDiscussLocks();
      if (wasActive) renderActiveTab(); else renderTabBarOnly();
      return;
    }
    // Pristine tab: never sent a turn, so no chatState and nothing of its own on disk. Just
    // drop the row and its composer draft — clear the bare key too, since
    // getObjectiveDraftKey() falls back to it the moment activeTabId goes null (utils.js).
    state.tabsState.splice(state.tabsState.indexOf(tab), 1);
    clearDraft(`${DRAFT_KEY_OBJECTIVE}-${tabId}`);
    clearDraft(DRAFT_KEY_OBJECTIVE);
    if (state.activeTabId === tabId) {
      const first = state.tabsState[0] || null;
      state.activeTabId = first ? first.tabId : null;
      state.chatState = first ? first.chatState : null;
    }
    syncDiscussLocks();
    if (wasActive) renderActiveTab(); else renderTabBarOnly();
  } finally {
    _closingChatTabs.delete(tabId);
  }
}

async function _abortTab(tabId) {
  const tab = state.tabsState.find(t => t.tabId === tabId);
  const cs = tab && tab.chatState;
  const ws = cs && cs.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'abort', tabId })); } catch {}
    try { ws.close(); } catch {}
  }
  try {
    await fetchWithRetry(`/api/objective/abort?taskId=${encodeURIComponent(tabId)}`, { method: 'POST', label: 'objective-abort-close' });
  } catch {}
}

function _buildTabBarInnerHtml() {
  const tabs = state.tabsState.map(t => {
    const isActive = t.tabId === state.activeTabId;
    const icon = t.status === 'streaming'
      ? '<span class="chat-tab-spinner"></span>'
      : t.status === 'done' ? '<span class="chat-tab-tick">&#x2713;</span>'
      : t.status === 'error' ? '<span class="chat-tab-err">!</span>'
      : '';
    return `<button class="chat-tab${isActive ? ' chat-tab--active' : ''}" data-tab-id="${escapeAttr(t.tabId)}">${icon}<span class="chat-tab-title">${escapeAttr(t.title)}</span><span class="chat-tab-close" data-close-tab-id="${escapeAttr(t.tabId)}" title="Close tab">&#x2715;</span></button>`;
  }).join('');
  const addDisabled = state.tabsState.length >= MAX_TABS ? ' disabled' : '';
  return tabs + `<button class="chat-tab-add" id="chat-tab-add"${addDisabled}>+</button>`;
}

const _boundTabControls = new WeakSet();

function _attachTabBarHandlers(bar) {
  bar.querySelectorAll('.chat-tab-close[data-close-tab-id]').forEach(x => {
    if (_boundTabControls.has(x)) return;
    _boundTabControls.add(x);
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      // dataset read synchronously — closeTab() awaits a confirm dialog, and `x` is detached
      // by a full pane render during that await. (TPT20) _abortTab() moved
      // INTO closeTab(), below the confirm: aborting here killed the server turn and closed
      // the socket before the user could still say Cancel.
      void closeTab(x.dataset.closeTabId);
    });
  });
  bar.querySelectorAll('.chat-tab[data-tab-id]').forEach(btn => {
    if (_boundTabControls.has(btn)) return;
    _boundTabControls.add(btn);
    btn.addEventListener('click', () => switchTab(btn.dataset.tabId));
  });
  const addBtn = bar.querySelector('#chat-tab-add');
  if (addBtn && !_boundTabControls.has(addBtn)) {
    _boundTabControls.add(addBtn);
    addBtn.addEventListener('click', openNewTab);
  }
}

function renderTabBarOnly() {
  notifyObjectiveStatusChanged();
  const bar = document.getElementById('chat-tab-bar');
  if (!bar) return;
  bar.closest('.content-area')?.style.setProperty('--chat-tab-count', state.tabsState.length);
  // Background frames can land between pointerdown and click. Replacing the
  // buttons here loses that click (and restarts every spinner), so patch them by
  // tab ID while keeping the button, title, close control, and unchanged icon alive.
  const template = document.createElement('template');
  template.innerHTML = _buildTabBarInnerHtml();
  const key = node => node.dataset.tabId || node.id;
  const existing = new Map([...bar.children].map(node => [key(node), node]));
  const iconSelector = '.chat-tab-spinner, .chat-tab-tick, .chat-tab-err';
  for (const [index, next] of [...template.content.children].entries()) {
    const current = existing.get(key(next));
    const node = current || next;
    if (current) {
      existing.delete(key(next));
      current.className = next.className;
      current.disabled = next.disabled;
      const title = current.querySelector('.chat-tab-title');
      const nextTitle = next.querySelector('.chat-tab-title');
      if (title && title.textContent !== nextTitle.textContent) title.textContent = nextTitle.textContent;
      const icon = current.querySelector(iconSelector);
      const nextIcon = next.querySelector(iconSelector);
      if (icon?.className !== nextIcon?.className) {
        icon?.remove();
        if (nextIcon) current.prepend(nextIcon);
      }
    }
    if (bar.children[index] !== node) bar.insertBefore(node, bar.children[index] || null);
  }
  for (const node of existing.values()) node.remove();
  _attachTabBarHandlers(bar);
}

// (TPT525) Repaint after a save path (chat-task-preview.js bulk Save Tasks /
// checkAllCardsHandled()) closed its chat via cleanupChat(). Same rule as closeTab()'s
// `if (wasActive) renderActiveTab(); else renderTabBarOnly();`: a chat that finished in a
// BACKGROUND tab while another objective tab is on screen must not reload() — that rewrites
// #app.innerHTML and steals focus/caret from the composer the user is typing in. Only the tab
// strip is patched; the board cache is marked stale (template.html) for the next board visit.
export function repaintAfterSavedChatClosed({ wasVisible } = {}) {
  if (wasVisible || state.activeTab !== 'objective') { reload(); return; }
  renderTabBarOnly();
  document.dispatchEvent(new Event('tiptask:board-cache-stale'));
}

// Internal version of getConfirmedTaskIds that operates on an arbitrary chatState.
function _getConfirmedTaskIds(cs, upToMsgIdx) {
  if (!cs) return new Set();
  const ids = new Set();
  const limit = upToMsgIdx !== undefined ? upToMsgIdx : cs.messages.length;
  for (let i = 0; i < limit; i++) {
    const msg = cs.messages[i];
    if (!msg.cards || msg.cards.length === 0) continue;
    const confirmed = msg.confirmedMask || [];
    for (let j = 0; j < msg.cards.length; j++) {
      if (confirmed[j]) ids.add(msg.cards[j].task.id);
    }
  }
  return ids;
}

function _wrapChatStateInTab(cs) {
  if (!cs) return;
  const tabId = cs.taskId;
  if (state.tabsState.some(t => t.tabId === tabId)) return;
  state.tabsState = [{
    tabId,
    title: deriveTabTitle(cs),
    status: computeTabStatus(cs),
    chatState: cs,
    // (C1410) Restore is never "brand new" — no live board stack to honestly consult here
    // anyway. Derive from the persisted parentTaskKey instead of leaving it undefined
    // (which used to fall back to whatever state.subtaskStack held at restore time).
    subtaskCtx: subtaskCtxFromChatState(cs),
    // (C1559) same reasoning — restore the tab's own origin from the persisted
    // chat state rather than leaving it undefined.
    ...rehashPayload(cs),
    originTaskKey: cs.originTaskKey || null,
  }];
  state.activeTabId = tabId;
}

function normalizeChatMessage(message) {
  const cards = Array.isArray(message.cards) ? message.cards : [];
  const acceptedMask = Array.isArray(message.acceptedMask)
    ? message.acceptedMask
    : cards.map(() => true);
  const confirmedMask = Array.isArray(message.confirmedMask)
    ? message.confirmedMask
    : cards.map(() => false);

  return {
    ...message,
    content: message.content || '',
    cards,
    acceptedMask,
    confirmedMask,
    filesAddressed: message.filesAddressed || [],
    docUpdates: message.docUpdates || [],
    discarded: !!message.discarded,
    streaming: !!message.streaming,
    timestamp: message.timestamp || Date.now(),
  };
}

function normalizeChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  // C1322 — drop legacy 'Refine objective' system bubbles persisted in older chat drafts
  return messages
    .filter(m => !(m && m.role === 'system' && m.content === 'Refine objective'))
    .map(normalizeChatMessage);
}

function syncChatHistoryMeta(chatState) {
  if (!chatState) return;
  const historyWindowStart = Math.max(1, Number(chatState.historyWindowStart) || 1);
  const visibleTailCount = Math.max(0, (chatState.messages || []).length - 1);
  const derivedTotalCount = historyWindowStart + visibleTailCount;
  chatState.historyWindowStart = historyWindowStart;
  chatState.historyTotalCount = Math.max(
    Number(chatState.historyTotalCount) || 0,
    derivedTotalCount,
    (chatState.messages || []).length
  );
  chatState.hasOlderHistory = historyWindowStart > 1;
}

// ── Bubble expand/collapse (C1390) ──
// Messages carry no id — role+timestamp is the existing identity convention in this file
// (see the "Load earlier messages" dedupe key below) and, unlike array index, survives
// older-history pages being spliced in ahead of index 0.
function bubbleKey(msg) {
  return `${msg.role}:${msg.timestamp}`;
}

// Lazily attach the Set — chatState is never JSON-serialized wholesale (saveChatDraft/
// saveChatState build explicit field-picked snapshots), so a Set here never round-trips
// through persistence and never needs to survive one.
function expandedBubbleSet(cs) {
  if (!(cs.expandedBubbleIds instanceof Set)) cs.expandedBubbleIds = new Set();
  return cs.expandedBubbleIds;
}

function bubbleExpandBtnHtml(key, expanded) {
  const label = expanded ? t('chat.bubble.showLess') : t('chat.bubble.showMore');
  return `<button type="button" class="chat-bubble-expand-btn" data-bubble-key="${escapeAttr(key)}" hidden>${escapeAttr(label)}</button>`;
}

// Post-render measurement pass: renderObjectiveContent() only returns an HTML string, so
// overflow can't be known until mounted. Buttons render `hidden`; this unhides the ones
// whose body actually overflows the clamp, and drops stale expanded state for bubbles that
// no longer overflow (e.g. a shorter message replacing a longer one at the same key).
function syncBubbleClamps() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const bodies = container.querySelectorAll('.chat-bubble-body');
  if (bodies.length === 0) return;
  const clampPx = parseFloat(getComputedStyle(bodies[0]).getPropertyValue('--chat-bubble-clamp')) || 320;
  const cs = state.chatState;
  bodies.forEach((body) => {
    const bubble = body.closest('.chat-bubble');
    const btn = bubble ? bubble.querySelector('.chat-bubble-expand-btn') : null;
    if (!btn) return; // streaming bubble — no toggle rendered
    const overflows = body.scrollHeight > clampPx + 8;
    btn.hidden = !overflows;
    if (!overflows && cs) {
      const key = btn.dataset.bubbleKey;
      if (key && expandedBubbleSet(cs).delete(key)) {
        bubble.classList.remove('chat-bubble--expanded');
        btn.textContent = t('chat.bubble.showMore');
      }
    }
  });
}

function ensureStreamingAssistant(chatState) {
  if (!chatState) return;
  const last = chatState.messages[chatState.messages.length - 1];
  if (last && last.role === 'assistant' && last.streaming) return;
  chatState.messages.push({
    role: 'assistant',
    content: '',
    cards: [],
    acceptedMask: [],
    confirmedMask: [],
    discarded: false,
    streaming: true,
    timestamp: Date.now(),
  });
  syncChatHistoryMeta(chatState);
}

export function saveChatDraft() {
  if (state.cleanupInProgress) return;
  if (!state.chatState || !state.chatState.messages.length) return;
  syncChatHistoryMeta(state.chatState);
  const payload = {
    // Strip transient _existingTasksSnapshot (a Map; JSON-serializes to {} and
    // breaks step computation on restore — see chat-task-preview.js).
    messages: state.chatState.messages.map(({ _existingTasksSnapshot, ...m }) => ({ ...m, streaming: false })),
    taskId: state.chatState.taskId,
    ...rehashPayload(state.chatState),
    ...draftRelationshipForSave(state.chatState),
    historyWindowStart: state.chatState.historyWindowStart || 1,
    objectiveModel: state.chatState.objectiveModel || null, // C1029 — per-tab selector override
  };
  // (TPT19) Capture the epoch now — if cleanupChat() purges before this timer fires, the
  // epoch it bumps won't match, and this write is dropped instead of resurrecting a
  // just-deleted draft. See state.js's chatPersistEpoch comment.
  const epoch = state.chatPersistEpoch;
  clearTimeout(_saveDraftTimer);
  _saveDraftTimer = setTimeout(() => {
    if (state.cleanupInProgress) return;
    if (state.chatPersistEpoch !== epoch) return;
    fetchWithRetry('/api/objective/chat-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...projectHeader() },
      body: JSON.stringify(payload),
      label: 'chat-draft-save',
    }).catch(() => {});
  }, 300);
}

function deleteChatDraft() {
  clearTimeout(_saveDraftTimer);
  fetchWithRetry('/api/objective/chat-draft', { method: 'DELETE', headers: projectHeader(), label: 'chat-draft-delete' }).catch(() => {});
}

// One auto-grow path for input, draft restore, and abort restore. Measure with
// overflow hidden, then scroll only at the 50vh cap. Ignore detached inputs
// whose scrollHeight is zero so an orphan recording cannot collapse the draft.
function autoGrowComposer(el) {
  if (!el || !el.isConnected) return;
  el.style.overflowY = 'hidden';
  el.style.height = 'auto';
  const cap = window.innerHeight * 0.5;
  if (el.scrollHeight > cap) {
    el.style.height = cap + 'px';
    el.style.overflowY = 'auto';
  } else {
    el.style.height = el.scrollHeight + 'px';
    el.style.overflowY = '';
  }
}

// Restore lastSentPrompt from sessionStorage on module load
if (!state.lastSentPrompt) {
  const saved = loadDraft(LAST_PROMPT_KEY);
  if (saved && saved.text) state.lastSentPrompt = saved.text;
}

// Restore the sticky chat-model-selector default from localStorage (C1029) — survives
// an app restart, not just a page reload. Overridden by the server's WS `config` frame
// only when nothing local is set or the remembered provider is no longer available.
if (!state.objectiveModel) {
  try {
    const savedModel = localStorage.getItem(OBJECTIVE_MODEL_KEY);
    if (savedModel) state.objectiveModel = savedModel;
  } catch {}
}

// (C1045) Seed state.objectiveProviders on page load — pre-fix this had exactly one
// writer (the objective-session WS `config` frame, opened only after the first send or
// on reconnect to a live session), so a fresh New Objective composer with no live
// session rendered no model selector at all. Same init-path fetch pattern as
// /api/objective/chat-draft and /api/chat-state above.
// (TPT181) Flagged in-flight so the first attachChatHandlers() pass doesn't fire a duplicate
// composer-open fetch alongside this one.
_providersFetchInFlight = true;
fetchWithRetry('/api/objective/providers', { timeoutMs: 5000, retries: 1, headers: projectHeader(), label: 'objective-providers' })
  .then(r => (r.ok ? r.json() : null))
  .then(payload => { if (payload && applyProviderConfig(payload)) reload(); })
  .catch(() => {})
  .finally(() => { _providersInitSettled = true; _providersFetchInFlight = false; });

// (TPT163) Settings → Edit Agents save (agents-modal.js) re-fetches the providers payload
// and hands it over here. The server only sends the `config` frame on WS connect, so this is
// the one path that gets a just-saved "Other Model" row into the selector without a reload.
// (TPT181) Also the path for a setup-modal save and for the server's own `providers:changed`
// broadcast (attention-ws.js) — the latter can arrive right after a caller's own re-fetch of the
// same payload, so repaint only when the list/selection actually changed.
if (typeof document !== 'undefined') {
  document.addEventListener('tiptask:providers-changed', (e) => {
    if (!e || !e.detail) return;
    if (applyProviderConfig(e.detail)) reload();
  });
}

// (TPT181) Composer-open refresh. Opening the composer re-renders from state.objectiveProviders
// but never re-fetched it, so a list fetched while the server's agent detection was stale (a CLI
// installed after boot) stayed empty — no selector at all — until something unrelated repainted.
// Called from attachChatHandlers(), i.e. every render pass while a New-section tab is showing;
// the gating policy (empty/all-disabled list, TTL, healthy-list-never-mid-turn / never
// concurrently) lives in objective-providers-refresh.js. Reads the cheap `{peek:true}` payload — no synchronous CLI
// probe — and repaints through refreshObjectiveContent() (the in-place swap that round-trips the
// composer's value/scroll/selection/focus), never reload(), which wipes #app under a composer
// the user may already be typing in. One delayed follow-up if the answer is still unhealthy:
// peekDetect() serves a stale negative to its FIRST caller and only then schedules the re-detect.
function refreshProvidersForComposer({ isRetry = false } = {}) {
  if (typeof document === 'undefined') return;
  if (_providersFetchInFlight) return;
  // (TPT182) Streaming is the policy's call, not a hard bail here: a healthy list is left alone
  // mid-turn, but an unhealthy one (a stale negative from before the CLI was detected) is what
  // the first turn's locked selector is showing, so it may heal while the turn runs and be
  // correct the moment the composer unlocks.
  if (!isRetry && !shouldRefreshProviders({
    providers: state.objectiveProviders,
    lastFetchedAt: _providersFetchedAt,
    now: Date.now(),
    inFlight: _providersFetchInFlight,
    streaming: objectiveIsStreaming(),
  })) return;
  _providersFetchInFlight = true;
  fetchWithRetry('/api/objective/providers', { timeoutMs: 5000, retries: 1, headers: projectHeader(), label: 'objective-providers-composer' })
    .then(r => (r.ok ? r.json() : null))
    .then(payload => {
      if (!payload) { _providersFetchedAt = Date.now(); return; } // back off a failing server
      if (applyProviderConfig(payload)) refreshObjectiveContent();
      if (!isRetry && providersUnhealthy(state.objectiveProviders)) {
        setTimeout(() => refreshProvidersForComposer({ isRetry: true }), PROVIDERS_RETRY_DELAY_MS);
      }
    })
    .catch(() => { _providersFetchedAt = Date.now(); })
    .finally(() => { _providersFetchInFlight = false; });
}

// (TPT181) The provider list is per-project (AVAILABLE_AGENTS, PI_CONFIGURED_MODELS), so a
// project switch must not leave the previous project's list standing in for up to the refresh
// TTL. Forgets the last-applied time and signature; the render pass that follows the switch
// re-fetches and repaints.
export function invalidateObjectiveProviders() {
  _providersFetchedAt = 0;
  _providersSig = '';
}

// (C1515) Warm the C1505 live-label cache too. buildModelSelectorHtml() already reuses
// modelLabel() (constants.js) unchanged — it checks this cache before falling back to the
// static label lists — but chat-ui.js was the one surface that never called
// ensureAgentModels() itself (task-board.js's edit modal/New Task form and agents-modal.js
// already do), so the objective composer only ever showed live labels by luck, if one of
// those other surfaces happened to warm the shared cache first in the same page session.
// Never blocks the composer — options render with raw-id/static-label fallback text in the
// meantime (modelLabel()'s existing behavior) and repaint once this resolves.
ensureAgentModels().then(() => reload()).catch(() => {});

// ── Persist / restore unsaved objective cards ──
export function saveChatState() {
  if (!state.chatState) {
    try { sessionStorage.removeItem(CHAT_STATE_KEY); } catch {}
    // (TPT19) See saveChatDraft()'s epoch comment — same fence against a purge racing this
    // debounced write.
    const epoch = state.chatPersistEpoch;
    clearTimeout(_saveChatTimer);
    _saveChatTimer = setTimeout(() => {
      if (state.chatPersistEpoch !== epoch) return;
      fetchWithRetry('/api/chat-state', { method: 'DELETE', headers: projectHeader(), label: 'chat-state-delete' }).catch(() => {});
    }, 2000);
    return;
  }
  syncChatHistoryMeta(state.chatState);
  // Only persist if there are unsaved cards
  const hasUnsaved = state.chatState.messages.some(m =>
    m.cards && m.cards.length > 0 &&
    (m.acceptedMask || []).some((v, i) => v && !(m.confirmedMask || [])[i])
  );
  if (!hasUnsaved) {
    try { sessionStorage.removeItem(CHAT_STATE_KEY); } catch {}
    const epoch = state.chatPersistEpoch;
    clearTimeout(_saveChatTimer);
    _saveChatTimer = setTimeout(() => {
      if (state.chatPersistEpoch !== epoch) return;
      fetchWithRetry('/api/chat-state', { method: 'DELETE', headers: projectHeader(), label: 'chat-state-delete' }).catch(() => {});
    }, 2000);
    return;
  }
  try {
    const snapshot = {
      taskId: state.chatState.taskId,
      messages: state.chatState.messages.map(m => ({
        role: m.role,
        content: m.content || '',
        cards: m.cards || [],
        acceptedMask: m.acceptedMask || [],
        confirmedMask: m.confirmedMask || [],
        filesAddressed: m.filesAddressed || [],
        docUpdates: m.docUpdates || [],
        // C1439: newTags/objectiveSummary were missing from this explicit whitelist —
        // a reload (sessionStorage restore, or the server's PUT /api/chat-state ->
        // GET round trip) silently dropped a message's new_tags, so a save made after
        // reloading a chat with unsaved cards lost its tag registrations.
        newTags: m.newTags || [],
        objectiveSummary: m.objectiveSummary || null,
        discarded: m.discarded || false,
        streaming: false,
        timestamp: m.timestamp,
      })),
      originalUserText: state.chatState.originalUserText,
      allChanges: state.chatState.allChanges || [],
      ...rehashPayload(state.chatState),
      parentTaskKey: state.chatState.parentTaskKey || null,
      objectiveParentKey: state.chatState.objectiveParentKey || null, // C1339
      originTaskKey: state.chatState.originTaskKey || null, // C1559
      originResolution: state.chatState.originResolution || null, // C1559
      historyWindowStart: state.chatState.historyWindowStart || 1,
      historyTotalCount: state.chatState.historyTotalCount || state.chatState.messages.length,
      hasOlderHistory: !!state.chatState.hasOlderHistory,
      objectiveModel: state.chatState.objectiveModel || null, // C1029
    };
    sessionStorage.setItem(CHAT_STATE_KEY, JSON.stringify(snapshot));
    const epoch = state.chatPersistEpoch;
    clearTimeout(_saveChatTimer);
    _saveChatTimer = setTimeout(() => {
      if (state.chatPersistEpoch !== epoch) return;
      fetchWithRetry('/api/chat-state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...projectHeader() },
        body: JSON.stringify(snapshot),
        label: 'chat-state-save',
      }).catch(() => {});
    }, 2000);
  } catch {}
}

export function restoreChatState() {
  if (state.chatState) return false;
  try {
    const raw = sessionStorage.getItem(CHAT_STATE_KEY);
    if (!raw) return false;
    const snapshot = JSON.parse(raw);
    if (!snapshot.messages || !snapshot.messages.length) return false;
    // Only restore if there are still unsaved cards
    const hasUnsaved = snapshot.messages.some(m =>
      m.cards && m.cards.length > 0 &&
      (m.acceptedMask || []).some((v, i) => v && !(m.confirmedMask || [])[i])
    );
    if (!hasUnsaved) {
      sessionStorage.removeItem(CHAT_STATE_KEY);
      return false;
    }
    state.chatState = {
      taskId: snapshot.taskId || `obj-restored-${Date.now()}`,
      messages: normalizeChatMessages(snapshot.messages),
      ws: null,
      clientBuffer: '',
      cleanContent: null,
      processExited: true,
      originalUserText: snapshot.originalUserText || '',
      allChanges: snapshot.allChanges || [],
      ...rehashPayload(snapshot),
      parentTaskKey: snapshot.parentTaskKey || null,
      objectiveParentKey: snapshot.objectiveParentKey || null, // C1339
      originTaskKey: snapshot.originTaskKey || null, // C1559
      originResolution: snapshot.originResolution || null, // C1559
      term: null,
      fitAddon: null,
      onResize: null,
      tickSeen: false,
      retryable: false,
      pendingCardsUpdate: false,
      chatReadySeen: false,
      autoRetryCount: 0,
      historyWindowStart: Math.max(1, Number(snapshot.historyWindowStart) || 1),
      historyTotalCount: Number(snapshot.historyTotalCount) || snapshot.messages.length,
      hasOlderHistory: !!snapshot.hasOlderHistory,
      objectiveModel: snapshot.objectiveModel || null, // C1029
    };
    syncChatHistoryMeta(state.chatState);
    _wrapChatStateInTab(state.chatState);
    state.activeTab = 'objective';
    return true;
  } catch {
    return false;
  }
}

function chatStateFromDraft(draft, legacySnapshot = null) {
  return {
    taskId: draft.taskId || `obj-restored-${Date.now()}`,
    messages: normalizeChatMessages(draft.messages),
    ws: null,
    clientBuffer: '',
    cleanContent: null,
    processExited: true,
    originalUserText: draft.messages.find(m => m.role === 'user')?.content || '',
    allChanges: [],
    ...rehashPayload(draft),
    ...restoreDraftRelationship(draft, legacySnapshot),
    term: null,
    fitAddon: null,
    onResize: null,
    tickSeen: false,
    retryable: true,
    pendingCardsUpdate: false,
    chatReadySeen: false,
    autoRetryCount: 0,
    historyWindowStart: Math.max(1, Number(draft.historyWindowStart) || 1),
    historyTotalCount: Number(draft.historyTotalCount) || draft.messages.length,
    hasOlderHistory: !!draft.hasOlderHistory,
    objectiveModel: draft.objectiveModel || null, // C1029
  };
}

// Restore on module load — sessionStorage first, then chat-draft, then chat-state fallback
const _hadSessionRestore = restoreChatState();
(async () => {
  if (!_hadSessionRestore) {
    // Try chat-draft first (persists ALL conversations, not just unsaved cards)
    try {
      const draftRes = await fetchWithRetry('/api/objective/chat-draft', { timeoutMs: 5000, headers: projectHeader(), label: 'chat-draft-restore' });
      if (draftRes.ok) {
        const draft = await draftRes.json();
        if (draft.messages && draft.messages.length > 0) {
          let legacySnapshot = null;
          if (draftRelationshipNeedsLegacyFallback(draft)) {
            try {
              const stateRes = await fetchWithRetry('/api/chat-state', { timeoutMs: 5000, headers: projectHeader(), label: 'chat-state-legacy-link' });
              if (stateRes.ok) legacySnapshot = await stateRes.json();
            } catch {}
          }
          state.chatState = chatStateFromDraft(draft, legacySnapshot);
          syncChatHistoryMeta(state.chatState);
          _wrapChatStateInTab(state.chatState);
          state.activeTab = 'objective';
        }
      }
    } catch {}

    // Fallback: chat-state (unsaved accepted cards only)
    if (!state.chatState) {
      try {
        const res = await fetchWithRetry('/api/chat-state', { timeoutMs: 5000, headers: projectHeader(), label: 'chat-state-restore' });
        if (res.ok) {
          const snapshot = await res.json();
          if (snapshot.messages && snapshot.messages.length) {
            const hasUnsaved = snapshot.messages.some(m =>
              m.cards && m.cards.length > 0 &&
              (m.acceptedMask || []).some((v, i) => v && !(m.confirmedMask || [])[i])
            );
            if (hasUnsaved) {
              state.chatState = {
                taskId: snapshot.taskId || `obj-restored-${Date.now()}`,
                messages: normalizeChatMessages(snapshot.messages),
                ws: null,
                clientBuffer: '',
                cleanContent: null,
                processExited: true,
                originalUserText: snapshot.originalUserText || '',
                allChanges: snapshot.allChanges || [],
                ...rehashPayload(snapshot),
                parentTaskKey: snapshot.parentTaskKey || null,
                objectiveParentKey: snapshot.objectiveParentKey || null, // C1339
                originTaskKey: snapshot.originTaskKey || null, // C1559
                originResolution: snapshot.originResolution || null, // C1559
                term: null,
                fitAddon: null,
                onResize: null,
                tickSeen: false,
                retryable: false,
                pendingCardsUpdate: false,
                chatReadySeen: false,
                autoRetryCount: 0,
                historyWindowStart: Math.max(1, Number(snapshot.historyWindowStart) || 1),
                historyTotalCount: Number(snapshot.historyTotalCount) || snapshot.messages.length,
                hasOlderHistory: !!snapshot.hasOlderHistory,
                objectiveModel: snapshot.objectiveModel || null, // C1029
              };
              syncChatHistoryMeta(state.chatState);
              _wrapChatStateInTab(state.chatState);
              state.activeTab = 'objective';
            }
          }
        }
      } catch {}
    }
  }

  if (!state.chatState) return;

  // Any "streaming" flag in persisted messages is stale after a reload —
  // it'll get reset to true only if the server actually has a live turn
  // (info.running below).
  for (const m of state.chatState.messages) { if (m.streaming) m.streaming = false; }
  state.chatState.processExited = true;

  // (C1427) Belt-and-braces: every branch below finishes with reload() (a dispatched
  // 'tiptask:reload', not a synchronous render), so a rebind call placed here would run against
  // the DOM this restore is about to replace. Wait for the render it triggers to actually finish
  // instead. window.TipTask.wireObjectivePane() is idempotent (the objWired stamp) — that render
  // already wires the pane on its own, so this is a genuine no-op on the normal path and only
  // does real work if some future render path skips that step.
  document.addEventListener('tiptask:rendered', () => {
    const root = document.querySelector('.content-area .chat-container');
    if (root) window.TipTask?.wireObjectivePane?.(root);
  }, { once: true });

  // If restored taskId looks like a real obj-* (not obj-restored-*), probe server
  // and reconnect to the live session — this is how we recover results when the
  // WS was closed (page reload, tab discard) before the turn ended.
  const tid = state.chatState.taskId;
  const restoredCs = state.chatState;
  if (tid && tid.startsWith('obj-') && !tid.startsWith('obj-restored-')) {
    try {
      const probe = await fetchWithRetry(`/api/objective/session?taskId=${encodeURIComponent(tid)}`, { timeoutMs: 5000, headers: projectHeader(), label: 'objective-session-probe-restore' });
      if (probe.ok) {
        const info = await probe.json();
        // Tab closed while the probe was in flight: reattaching now would open a socket no tab
        // owns — it cancels the server's detach teardown and keeps the session alive.
        if (!_tabOwnsChat(tid, restoredCs)) return;
        if (info.exists) {
          // Drop a trailing placeholder pair (user + empty streaming assistant)
          // left over from the moment the tab was reloaded — server replays the
          // authoritative messages via chat-history.
          const msgs = state.chatState.messages;
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant' && !last.content && (!last.cards || !last.cards.length)) {
            msgs.pop();
            if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop();
          }
          state.chatState.processExited = !info.running;
          state.chatState.retryable = false;
          if (info.running) {
            ensureStreamingAssistant(state.chatState);
          }
          reload();
          connectObjectiveWS(tid, null, { reconnect: true });
          return;
        }
      }
    } catch {}
  }

  // C1109: cards restored from sessionStorage/chat-draft/chat-state carry no
  // _existingTasksSnapshot (stripped on persist, see saveChatState/saveChatDraft) —
  // reconcile the last assistant message with cards so a `modified` card's
  // title/description aren't blank until the user first interacts with it. The
  // live-reconnect path above (return at line ~810) doesn't need this: the server's
  // authoritative chat-history-reset fires shortly after and reconciles on its own.
  const lastCardsMsgRestore = [...state.chatState.messages].reverse().find(m => m.role === 'assistant' && m.cards?.length);
  if (lastCardsMsgRestore) ensureExistingSnapshot(lastCardsMsgRestore).then(() => reload());

  // No live server session — mark retryable so the user sees a Retry button
  // instead of a spinner on a dead turn.
  state.chatState.retryable = true;
  reload();
})();

// ── Count unsaved accepted cards across all messages ──
export function getUnsavedAcceptedCount() {
  if (!state.chatState) return 0;
  let count = 0;
  for (const msg of state.chatState.messages) {
    count += getUnsavedAcceptedCountForMsg(msg);
  }
  return count;
}

export function getUnsavedAcceptedCountForMsg(msg) {
  if (!msg.cards || msg.cards.length === 0) return 0;
  let count = 0;
  const mask = msg.acceptedMask || [];
  const confirmed = msg.confirmedMask || [];
  for (let i = 0; i < msg.cards.length; i++) {
    if (mask[i] && !confirmed[i] && !getLockedCardTarget(msg, i)) count++;
  }
  return count;
}

// ── Get Set of task IDs confirmed before a given message index ──
export function getConfirmedTaskIds(upToMsgIdx) {
  if (!state.chatState) return new Set();
  const ids = new Set();
  const limit = upToMsgIdx !== undefined ? upToMsgIdx : state.chatState.messages.length;
  for (let i = 0; i < limit; i++) {
    const msg = state.chatState.messages[i];
    if (!msg.cards || msg.cards.length === 0) continue;
    const confirmed = msg.confirmedMask || [];
    for (let j = 0; j < msg.cards.length; j++) {
      if (confirmed[j]) ids.add(msg.cards[j].task.id);
    }
  }
  return ids;
}

// ── Capture contenteditable edits before re-render ──
export function captureCardEdits() {
  if (!state.chatState) return;
  // Guard: if the DOM still shows a different tab's cards (stale repaint window
  // after switchTab / post-save auto-switch), writing would copy that tab's
  // title/description onto the new chatState's cards — causing duplicate tasks.
  const _container = document.getElementById('chat-messages');
  const _stamped = _container && _container.dataset.activeTab;
  if (_stamped && _stamped !== String(state.chatState.taskId || '')) return;
  document.querySelectorAll('.preview-card[data-msg-idx]').forEach(card => {
    const msgIdx = parseInt(card.dataset.msgIdx);
    const cardIdx = parseInt(card.dataset.cardIdx);
    const msg = state.chatState.messages[msgIdx];
    if (!msg || !msg.cards || !msg.cards[cardIdx]) return;
    const confirmed = msg.confirmedMask || [];
    if (confirmed[cardIdx]) return;
    const titleEl = card.querySelector('.preview-title');
    const descEl = card.querySelector('.preview-desc');
    if (titleEl) {
      // C1158: an empty title is never a legal state (ws-handlers.js PATCH guard +
      // api tasks.js validateTask both 400 on it), so a blank read here is always a
      // stale/unhydrated paint (async hydrateModifiedCard hasn't landed yet), never
      // user intent. Writing it anyway would poison card.task.title with a *defined*
      // '' that hydrateModifiedCard's `!== undefined` skip can no longer backfill —
      // permanently blocking Save. Stricter than the description guard below, where
      // '' is a legal, intentional value (C922).
      const nextTitle = titleEl.innerText.trim();
      if (nextTitle) msg.cards[cardIdx].task.title = nextTitle;
    }
    if (descEl) {
      const task = msg.cards[cardIdx].task;
      // dataset.raw is '' (not absent) for a `modified` card that omitted description
      // (C1071) — nullish coalescing, not ||, so we don't fall through to innerText
      // (markdown-rendered, syntax-stripped) for that case. And only WRITE an empty
      // result if the card already had a description field — never introduce one.
      const nextDesc = (descEl.dataset.raw ?? descEl.innerText).trim();
      if (nextDesc || task.description !== undefined) task.description = nextDesc;
    }
  });
}

// ── Lightweight DOM patch during streaming ──
export function updateStreamingBubble() {
  const msgContainer = document.getElementById('chat-messages');
  if (!msgContainer || !state.chatState) return;

  const lastMsg = state.chatState.messages[state.chatState.messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'assistant') return;

  const bubbles = msgContainer.querySelectorAll('.chat-msg--assistant');
  const lastBubble = bubbles[bubbles.length - 1]; // last in DOM = newest (chronological order)
  if (!lastBubble) return;

  const textEl = lastBubble.querySelector('.chat-stream-text');
  if (textEl) {
    let stripped = stripJsonFromDisplay(lastMsg.content);
    // If cards exist and JSON fragments remain, suppress
    if (lastMsg.cards && lastMsg.cards.length > 0) {
      if (/"type"\s*:\s*"(?:modified|new)"/.test(stripped) ||
          /"task"\s*:/.test(stripped)) {
        stripped = '';
      }
    }
    textEl.textContent = stripped;
  }

  // Auto-scroll to bottom so newest streaming content stays visible
  msgContainer.scrollTop = msgContainer.scrollHeight;
}

// ── Mutate progress chip without a full reload ──
function updateProgressChip() {
  const bubbles = document.querySelectorAll('#chat-messages .chat-msg--assistant');
  const lastBubble = bubbles[bubbles.length - 1];
  if (!lastBubble) return;
  let chip = lastBubble.querySelector('.chat-progress-stage');
  const label = state.chatState && state.chatState.progressStage;
  if (!label) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('div');
    chip.className = 'chat-progress-stage';
    const bubble = lastBubble.querySelector('.chat-bubble--assistant');
    if (bubble) bubble.appendChild(chip);
  }
  chip.textContent = label;
}

function _toProxyImageUrl(url) {
  return String(url).replace(
    /^.*?\/api\/projects\/(\d+)\/images\/(\d+).*$/,
    '/api/images/$1/$2'
  );
}

let _lightboxOverlay = null;
function openImageLightbox(src, alt) {
  if (_lightboxOverlay) return; // already open
  const overlay = document.createElement('div');
  overlay.className = 'img-lightbox-overlay';
  const img = document.createElement('img');
  img.className = 'img-lightbox-img';
  img.src = src;
  img.alt = alt || 'Image preview';
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  _lightboxOverlay = overlay;
  const close = () => {
    overlay.remove();
    _lightboxOverlay = null;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}

// Guard so we only register the tiptask:obj-image-preview listener once across re-renders.
let _objImgPreviewListenerRegistered = false;

// (TPT19) Guard so we only register the tiptask:chat-persist-purged listener once. Dispatched
// by cleanupChat() (console-modal.js) after it re-points state.chatState to a surviving tab —
// chat-draft/chat-state are one file PER PROJECT, not per tab, so the purge that just ran also
// wiped the survivor's own history. Going through an event (instead of console-modal.js
// importing saveChatDraft() directly) avoids a new import cycle — chat-ui.js already imports
// console-modal.js for cleanupChat().
let _chatPersistPurgedListenerRegistered = false;

// Guard so the global voice-input shortcut is bound once, ever — attachChatHandlers() runs every
// render cycle but the listener lives on `document`.
let _voiceShortcutRegistered = false;

// (C1210) A held key repeats `keydown` every ~30ms — without this a held combo would toggle the
// mic dozens of times a second instead of once. Also the last line of defense against a double
// toggle if the Electron menu accelerator (main.js) AND this DOM listener both somehow see one
// physical press (normally the accelerator consumes the key and the DOM listener never fires it
// at all — see index.js's onVoiceShortcut subscription) — a second arrival within this window for
// the SAME already-handled press is dropped rather than instantly re-toggling.
const VOICE_TRIGGER_COALESCE_MS = 250;
let _lastVoiceTriggerAt = 0;

// (C1210) The one place a voice-shortcut press becomes an action, whatever route it arrived by:
// this file's own capture-phase DOM keydown listener below (the only route in a plain browser
// tab), or the Electron app-menu accelerator relayed over IPC (index.js's onVoiceShortcut →
// main.js's menu item — the route that actually fires in the packaged app; see
// tt-audio-input.md § Keyboard Shortcut, C1210, for why the DOM route alone doesn't). One shared
// body means the two routes can never drift apart.
export function triggerVoiceShortcut(source = 'dom') {
  const now = Date.now();
  if (now - _lastVoiceTriggerAt < VOICE_TRIGGER_COALESCE_MS) return false;
  _lastVoiceTriggerAt = now;
  const target = resolveVoiceTarget();
  // (C1206) A matched combo with no resolvable target used to be indistinguishable from the
  // listener never having been bound at all — the single biggest source of "the shortcut does
  // nothing" reports (see this task and its predecessor C1202). The toast turns a silent dead
  // key into a diagnosable signal.
  console.info(`[voice] shortcut triggered via ${source} — target: ${target ? 'found' : 'none'}`);
  if (!target) { showToast(t('voice.noTarget')); return false; }
  target.toggle();
  return true;
}

// Global voice-input shortcut (default Cmd/Ctrl+Shift+D — see audio-recorder.js's
// setVoiceShortcut/matchesVoiceShortcut, configurable in Settings > Voice) toggles whichever mic
// resolveVoiceTarget() finds relevant (open agent terminal > focused mic-enabled field > New
// Objective chat input). Bound on the capture phase so it fires before xterm.js's own key
// handling on the focused .xterm-helper-textarea inside an open terminal (same reasoning as the
// capture-phase paste listener in console-modal.js).
export function registerVoiceShortcut() {
  if (_voiceShortcutRegistered) return;
  document.addEventListener('keydown', (e) => {
    if (!matchesVoiceShortcut(e)) return;
    // preventDefault()/stopPropagation() run unconditionally on match, before the repeat check —
    // the combo must never fall through and type a literal letter, held or not.
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return; // held combo = one toggle, not a toggle every ~30ms
    triggerVoiceShortcut('dom');
  }, { capture: true });
  // (C1210) Set AFTER the listener actually attaches, not before. Setting it first meant a throw
  // mid-setup (impossible in practice, but index.js:36's boot call wraps this in try/catch
  // specifically because it can't rule it out) would permanently mark the shortcut "registered"
  // while no listener existed — every later retry (attachChatHandlers(), every render) would then
  // see the guard already true and no-op forever.
  _voiceShortcutRegistered = true;
  console.info('[voice] global shortcut DOM listener bound (capture phase)');
}

// (C1210) Read from main.js via webContents.executeJavaScript('window.TipTask.chatUI.
// isVoiceShortcutBound()') by the Voice Shortcut Diagnostics menu item — lets a future "shortcut
// does nothing" report be triaged from the packaged app with no DevTools. Not used by app code.
export function isVoiceShortcutBound() { return _voiceShortcutRegistered; }

function appendNewObjectiveImagePreview(file, url) {
  const area = document.getElementById('new-obj-image-feedback');
  if (!area || !url) return;
  // Idempotent: the render-cycle rebuild and the one-shot tiptask:obj-image-preview
  // event can both fire for the same URL — never show duplicate thumbnails.
  const existing = area.querySelectorAll('.new-obj-img-preview');
  for (const el of existing) {
    if (el.dataset.uploadedUrl === url) return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'new-obj-img-preview-wrap';
  wrap.style.marginTop = '6px';
  wrap.style.display = 'none';
  const img = document.createElement('img');
  img.className = 'new-obj-img-preview';
  img.alt = file?.name ? `${file.name} preview` : 'Uploaded image preview';
  img.style.maxWidth = '180px';
  img.style.borderRadius = '6px';
  img.dataset.uploadedUrl = url;
  img.style.cursor = 'zoom-in';
  img.onload = () => wrap.style.removeProperty('display');
  img.onerror = () => wrap.remove();
  img.src = _toProxyImageUrl(url);
  img.addEventListener('click', () => openImageLightbox(img.src, img.alt));
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'new-obj-img-preview-remove';
  removeBtn.title = 'Remove image';
  removeBtn.setAttribute('aria-label', 'Remove image');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Direct removal covers previews whose URL isn't in the textarea
    // (e.g. Trello-import event); markdown strip covers the rest.
    wrap.remove();
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
      const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const next = chatInput.value.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
      if (next !== chatInput.value) {
        chatInput.value = next;
        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  });
  wrap.appendChild(img);
  wrap.appendChild(removeBtn);
  area.appendChild(wrap);
}

// Re-populate the preview strip from image markdown already in the chat input.
// Every loadAndRender rebuilds app.innerHTML with an empty #new-obj-image-feedback
// while the draft text survives — without this rebuild, thumbnails vanish on the
// ~1s background board-snapshot refresh (and the 5s Electron poll).
function rebuildObjectiveImagePreviews(chatInput) {
  if (!chatInput || !chatInput.value) return;
  const mdImageRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = mdImageRe.exec(chatInput.value)) !== null) {
    const url = m[2];
    if (/\/api\/projects\/\d+\/images\/\d+/.test(url) || url.startsWith('/api/trello/image-proxy?')) {
      appendNewObjectiveImagePreview({ name: m[1] || null }, url);
    }
  }
}

function appendNewObjectiveUploadError(file, err) {
  const area = document.getElementById('new-obj-image-feedback');
  if (!area) return;
  const banner = document.createElement('div');
  banner.className = 'new-obj-upload-error';

  const msg = document.createElement('span');
  const name = file?.name ? `${file.name}: ` : '';
  msg.textContent = `Image upload failed: ${name}${err?.message || 'Upload failed'}`;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'new-obj-upload-error-dismiss';
  close.textContent = 'x';
  close.title = 'Dismiss';
  close.addEventListener('click', () => banner.remove());

  banner.appendChild(msg);
  banner.appendChild(close);
  area.appendChild(banner);
}

// (C1282) A task status event can arrive while Objective is selected. The task list cache and
// left-nav state can be updated without rebuilding the whole app, but the Objective pane still
// needs a fresh render when its state changes. Capture live DOM state before that small refresh
// so an unsaved composer value (and the user's place in it) is never replaced by the persisted
// draft snapshot.
function captureObjectiveViewState() {
  const input = document.getElementById('chat-input');
  const messages = document.getElementById('chat-messages');
  return {
    composer: input ? {
      value: input.value,
      height: input.style.height,
      scrollTop: input.scrollTop,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
      selectionDirection: input.selectionDirection,
      focused: document.activeElement === input,
    } : null,
    messagesScrollTop: messages ? messages.scrollTop : null,
  };
}

function restoreObjectiveViewState(viewState) {
  if (!viewState) return;
  const input = document.getElementById('chat-input');
  const composer = viewState.composer;
  if (input && composer) {
    input.value = composer.value;
    if (composer.height) input.style.height = composer.height;
    input.scrollTop = composer.scrollTop || 0;

    if (composer.focused) {
      try { input.focus({ preventScroll: true }); } catch { input.focus(); }
      const max = input.value.length;
      const start = Number.isFinite(composer.selectionStart)
        ? Math.min(max, Math.max(0, composer.selectionStart)) : max;
      const end = Number.isFinite(composer.selectionEnd)
        ? Math.min(max, Math.max(start, composer.selectionEnd)) : start;
      try { input.setSelectionRange(start, end, composer.selectionDirection || 'none'); } catch {}
    }
  }
  const messages = document.getElementById('chat-messages');
  if (messages && Number.isFinite(viewState.messagesScrollTop)) {
    messages.scrollTop = viewState.messagesScrollTop;
  }
}

// (TPT525) Focus guard for a full render (template.html's #app.innerHTML rewrite), which has no
// viewState of its own. Captures the live composer only while it is focused AND still belongs to
// the tab about to be rendered (#chat-input's data-tab-id === state.activeTabId) — when the
// removed tab was the active one, the active tab changed and nothing is carried over. Message
// scroll is left to the full render's own scroll handling. Consumed once by attachChatHandlers().
let _pendingComposerRestore = null;

function captureFocusedComposerForRerender() {
  if (typeof document === 'undefined') return null;
  const input = document.getElementById('chat-input');
  if (!input || !input.isConnected || document.activeElement !== input) return null;
  if ((input.dataset.tabId || '') !== String(state.activeTabId ?? '')) return null;
  return { ...captureObjectiveViewState(), messagesScrollTop: null, tabId: state.activeTabId };
}

// ── Render objective tab content (returns HTML string) ──
export function renderObjectiveContent(options = {}) {
  if (state.chatState) syncChatHistoryMeta(state.chatState);
  // (TPT525) An explicit viewState (refreshObjectiveContent()/renderActiveTab()) is restored by
  // its caller; only a viewState-less full render arms the one-shot restore.
  _pendingComposerRestore = options.viewState ? null : captureFocusedComposerForRerender();
  const composerView = options.viewState || _pendingComposerRestore;
  const layoutClass = state.chatState ? 'objective-chat--active' : 'objective-chat--empty';

  // Build message bubbles HTML
  const messagesHtml = (() => {
    if (!state.chatState) return '';
    const expandedIds = expandedBubbleSet(state.chatState);
    return state.chatState.messages.map((msg, msgIdx) => {
      const key = bubbleKey(msg);
      const expanded = expandedIds.has(key);
      if (msg.role === 'user') {
        // (TPT254) A blank subtask kickoff carries no user text — render nothing instead of
        // an empty grey pill. The planner still gets BLANK_SUBTASK_BRIEF via the prompt payload.
        if (!msg.content) return '';
        const expandedCls = expanded ? ' chat-bubble--expanded' : '';
        return `<div class="chat-msg chat-msg--user"><div class="chat-bubble chat-bubble--user${expandedCls}"><div class="chat-bubble-body">${escapeAttr(msg.content)}</div>${bubbleExpandBtnHtml(key, expanded)}</div></div>`;
      }
      if (msg.role === 'system') {
        return `<div class="chat-msg chat-msg--system"><div class="chat-bubble chat-bubble--system">${escapeAttr(msg.content)}</div></div>`;
      }
      // Assistant message
      let body = '';
      // Streamed text (JSON stripped for display)
      let displayText = stripJsonFromDisplay(msg.content || '');
      // Secondary suppression: if task cards were parsed but JSON fragments
      // still leaked through stripping, suppress the text entirely
      if (displayText && msg.cards && msg.cards.length > 0) {
        if (/"type"\s*:\s*"(?:modified|new)"/.test(displayText) ||
            /"task"\s*:/.test(displayText)) {
          displayText = '';
        }
      }
      if (displayText) {
        body += `<div class="chat-stream-text">${escapeAttr(displayText)}</div>`;
      }
      // Typing indicator — stays inside the clamped body so it never gets stranded below a
      // clip that hasn't measured yet; harmless since streaming bubbles render expanded.
      if (msg.streaming) {
        body += '<div class="chat-typing-indicator"><span></span><span></span><span></span></div>';
      }
      // (C1390) Streaming bubbles always render expanded with no toggle — clamping live text
      // mid-stream would hide content the user is actively watching arrive.
      const isExpanded = expanded || msg.streaming;
      let inner = `<div class="chat-bubble-body">${body}</div>`;
      if (!msg.streaming) inner += bubbleExpandBtnHtml(key, expanded);
      // Task cards (delegated to chat-task-preview) render outside the clamped body — they
      // carry Accept/Discard/step controls that must never be hidden behind a toggle.
      inner += renderCardHtml(msg, msgIdx);

      // (C1296) Token-stats line (.ai-stats) and the dark per-span timing block (.turn-timing)
      // are no longer rendered — assistant bubbles carry just the bubble. Server-side token
      // accounting (token-usage endpoint on session exit) is untouched; this only stops the
      // client chrome. timingMilestones/tokens still flow through msg objects.
      const expandedCls = isExpanded ? ' chat-bubble--expanded' : '';
      return `<div class="chat-msg chat-msg--assistant"><div class="chat-bubble chat-bubble--assistant${expandedCls}">${inner}</div></div>`;
    }).join('');
  })();

  // Is streaming right now?
  const isStreaming = objectiveIsStreaming();
  const canRetry = state.chatState && state.chatState.retryable && !isStreaming;
  const parseErr = state.chatState && state.chatState.lastParseError;
  // C1031 — raw (unescaped); objectiveRetryBannerText() composes it and the single call site
  // below escapes the whole line once. Escaping here too would double-escape.
  const previewSnippetRaw = parseErr && parseErr.preview
    ? ` Got: ${parseErr.preview.slice(0, 120)}…`
    : '';
  const hiddenHistoryCount = state.chatState
    ? Math.max(0, (state.chatState.historyWindowStart || 1) - 1)
    : 0;
  const loadEarlierCount = Math.min(OBJECTIVE_HISTORY_PAGE_MESSAGES, hiddenHistoryCount);
  const historyBannerHtml = hiddenHistoryCount > 0
    ? `<div class="chat-history-banner">
        <button class="btn-chat-history-load" id="btn-load-earlier-history">Load ${loadEarlierCount} earlier message${loadEarlierCount === 1 ? '' : 's'}</button>
        <span class="chat-history-meta">${hiddenHistoryCount} older hidden</span>
      </div>`
    : '';

  // Input area
  const liveComposer = composerView?.composer;
  const objDraft = liveComposer
    ? (liveComposer.value ? { text: liveComposer.value, height: liveComposer.height } : null)
    : loadDraft(getObjectiveDraftKey());
  const draftText = objDraft ? escapeAttr(objDraft.text || '') : '';
  const draftHeight = objDraft && objDraft.height ? objDraft.height : '';
  const hasDraft = !!objDraft;
  const inputDisabled = isStreaming ? ' disabled' : '';
  // (TPT179) Rehash → Discuss: the discussed task's key, or null for every other chat.
  const discussKey = tabDiscussKey();
  const chatPlaceholder = state.chatState
    ? 'Send feedback to refine tasks...'
    : discussKey
    ? t('chat.discussPlaceholder', { key: discussKey })
    : 'What do you want to build or fix?\n\nBe specific — include:\n• Context: what exists today and what\'s broken/missing\n• Goal: exact behaviour you want after the change\n• Constraints: files to avoid, APIs to use, edge cases to handle\n• Acceptance: how you\'ll verify it works\n\nExample: "The objective chat textarea resets to 2 rows on every reload, losing the user\'s typed brief. Store draft text + height in sessionStorage on input and restore on mount. Don\'t change the placeholder logic or the send-button disabled state."';

  // Console toggle (only when state.chatState is active)
  const consoleToggle = state.chatState ? `<button class="chat-console-toggle" id="chat-console-toggle">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
  </button>` : '';

  const subtaskCtx = tabSubtaskCtx(); // (C1162/C1410) active tab's own captured context, never live
  // (TPT255) Names the split target — key alone when title is missing/equal to the key
  // (captureSubtaskCtx()/subtaskCtxFromChatState() both fall back title -> taskKey, so the
  // naive "key · title" form would otherwise render "TPT255 · TPT255").
  const subtaskLabel = subtaskCtx && subtaskCtx.title && subtaskCtx.title !== subtaskCtx.taskKey
    ? `${subtaskCtx.taskKey} · ${subtaskCtx.title}` : (subtaskCtx ? subtaskCtx.taskKey : '');
  const subtaskBannerHtml = subtaskCtx
    ? `<div class="subtask-context-banner">${escapeAttr(t('chat.splitCaption'))} <strong>${escapeAttr(subtaskLabel)}</strong> <button class="btn-clear-subtask-ctx" title="${escapeAttr(t('chat.splitExit'))}">&#x2715;</button></div>`
    : '';
  // (TPT257) Subtask preview summary — "N subtasks will be created under <key>". Keyed on
  // the chat's own persisted parentTaskKey (what Phase 2.7 actually stamps on save), not the
  // tab banner above; the banner's × clears both together. Rendered only once the planner
  // has produced cards, so a fresh split tab never shows "0 subtasks". Kept current between
  // paints by chat-task-preview.js refreshSubtaskSummary() (called from updateSaveBar()).
  const subtaskParentKey = state.chatState && state.chatState.parentTaskKey;
  const subtaskSummaryHtml = subtaskParentKey && hasProposalCards(state.chatState.messages)
    ? (() => {
        const n = countPendingSubtaskCards(state.chatState.messages);
        return `<div class="subtask-preview-summary" id="subtask-preview-summary" data-count="${n}">${escapeAttr(tc('chat.subtaskSummary', n, { key: subtaskParentKey }))}</div>`;
      })()
    : '';

  // (C1559) Origin mode is otherwise invisible — a handoff tab is spawned with
  // no subtaskCtx, so without this banner nothing on screen tells the user this
  // chat will refine/parent a specific existing task rather than create fresh
  // ones. Mutually exclusive with subtaskCtx in practice (a C1389 handoff never
  // sets both), but rendered independently rather than assumed.
  const originTaskKey = tabOriginTaskKey(); // active tab's own captured origin, never live
  const originTab = originTaskKey ? getActiveTab() : null;
  const originBannerHtml = originTaskKey
    ? `<div class="subtask-context-banner origin-context-banner">Planning <strong>${escapeAttr(originTaskKey)}${originTab && originTab.title ? ' — ' + escapeAttr(originTab.title) : ''}</strong> <button class="btn-clear-origin-ctx" title="Exit planning mode">&#x2715;</button></div>`
    : '';

  // (TPT179) Outside .chat-body/.chat-messages on purpose — never scrolls with the transcript and
  // stays visible in the empty layout, where .chat-messages is display:none.
  const discussPreviewHtml = discussKey ? renderDiscussPreviewHtml(discussKey, ensureDiscussTask(discussKey)) : '';

  const tabBarHtml = state.tabsState.length > 0
    ? `<div class="chat-tab-bar" id="chat-tab-bar">${_buildTabBarInnerHtml()}</div>`
    : '';

  return `
    <div class="chat-container ${layoutClass}">
      ${renderComposerHeader(`${consoleToggle}<button class="btn-archive" id="btn-archive">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            History
          </button>`, tabBarHtml)}
      ${subtaskBannerHtml}
      ${subtaskSummaryHtml}
      ${originBannerHtml}
      ${discussPreviewHtml}
      <div class="chat-body">
      <div class="chat-messages" id="chat-messages" data-active-tab="${escapeAttr(state.chatState && state.chatState.taskId ? String(state.chatState.taskId) : '')}">
        ${historyBannerHtml}
        ${messagesHtml}
      </div>
      <div class="chat-input-area">
        <textarea id="chat-input" data-tab-id="${escapeAttr(state.activeTabId ?? '')}" placeholder="${escapeAttr(chatPlaceholder)}" rows="${state.chatState ? '2' : '7'}"${inputDisabled}${draftHeight ? ` style="height:${draftHeight}"` : ''}>${draftText}</textarea>
        <div class="new-obj-image-feedback" id="new-obj-image-feedback" aria-live="polite"></div>
        ${!state.chatState && !discussKey ? '<div class="chat-brief-hint" id="chat-brief-hint"><span id="chat-word-count">0 words</span> — aim for 40+ words for detailed task cards</div>' : ''}
        ${canRetry ? `<div class="chat-retry-banner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>${escapeAttr(objectiveRetryBannerText(state.chatState, previewSnippetRaw))}</span>
        </div>` : ''}
        <div class="chat-input-actions">
          ${buildModelSelectorHtml(inputDisabled)}
          <div class="chat-input-action-controls">
            ${buildEmbedMenuHtml(inputDisabled)}
            <div class="import-menu-wrap"><button class="import-menu-trigger" type="button" aria-haspopup="true">${t('nav.import')}${DROPDOWN_CARET_SVG}</button></div>
            ${hasDraft ? '<button class="btn-clear-draft" id="clear-objective-draft">Clear Draft</button>' : ''}
            ${canRetry
              ? `<button class="btn-chat-retry" id="btn-chat-retry">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                  Retry
                </button>`
              : ''
            }
            ${isStreaming
              ? `<button class="btn-chat-stop" id="btn-chat-stop">
                  <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                  Stop
                </button>`
              : `<button class="btn-chat-send" id="btn-chat-send"${inputDisabled}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  Send
                </button>`
            }
          </div>
        </div>
      </div>
      </div>
    </div>`;
}

// (C1282) Repaint only the Objective container from current chat state. The surrounding app,
// left nav, and terminal overlay stay mounted; composer and message-scroll state are restored
// after the new markup is wired. This is intentionally separate from reload()/loadAndRender(),
// whose app.innerHTML replacement is correct for real navigation but destructive during compose.
export function refreshObjectiveContent({ viewState = captureObjectiveViewState() } = {}) {
  if (state.activeTab !== 'objective') return false;
  const contentArea = document.querySelector('.content-area');
  const current = contentArea?.querySelector('.chat-container');
  if (!current) return false;
  contentArea.style.setProperty('--chat-tab-count', state.tabsState.length);

  const nextTemplate = document.createElement('template');
  nextTemplate.innerHTML = renderObjectiveContent({ viewState }).trim();
  const next = nextTemplate.content.firstElementChild;
  if (!next) return false;

  // (C1427) The node about to be destroyed may be pinned-expanded. collapseCard() is what
  // removes the body-level .card-overlay-backdrop and unlocks page scroll (task-card.js) — both
  // survive replaceWith() otherwise, since the expanded node's own cleanup branch only runs
  // while it's still attached. Must also run BEFORE wireObjectivePane() below blanks
  // state.hoverScrollHandler (setupCardInteractions() resets it unconditionally) without
  // removing its window 'scroll' listener.
  window.TipTask?.taskCard?.collapseCard?.();

  // A composer popover owns document-level listeners. Tear those down before removing the
  // old subtree, then attach the normal handlers to the replacement subtree below.
  ensureGlobalChatBindings();
  current.replaceWith(next);
  try {
    attachChatHandlers();
    window.TipTask?.chatTaskPreview?.attachCardHandlers?.();
    // (C1427) replaceWith() leaves `next` listener-less for everything the full render wires in
    // template.html's tail — composer-header tab switcher, Import/History/console-toggle, and
    // per-card hover/click/dblclick. See tt-objective-chat-persistence.md § Lifecycle.
    window.TipTask?.wireObjectivePane?.(next);
  } catch (err) {
    // (C1427) template.html's loadAndRender().catch(() => {}) swallows this whole event handler
    // silently — log here so a future regression in any of the three calls above is visible in
    // devtools instead of presenting as "the pane went dead, no error".
    console.error('[refreshObjectiveContent] wiring failed', err);
  }
  restoreObjectiveViewState(viewState);
  return true;
}

// Run bind-once shortcuts/link handlers and document-listener cleanup on every
// render, including board renders. The remaining chat handlers mount only on
// Create; otherwise a tab switch can leak a portaled menu listener.
export function ensureGlobalChatBindings() {
  registerVoiceShortcut();
  ensureFileLinkHandler();
  closeOpenEmbedMenu(); // (C1248) a render must not leave an open menu's document listeners
  if (!_objImgPreviewListenerRegistered) {
    _objImgPreviewListenerRegistered = true;
    document.addEventListener('tiptask:obj-image-preview', e => {
      const { name, url } = e.detail || {};
      if (url) appendNewObjectiveImagePreview({ name: name || null }, url);
    });
  }
  if (!_chatPersistPurgedListenerRegistered) {
    _chatPersistPurgedListenerRegistered = true;
    // (TPT20) saveChatState() as well as the draft — the purge also removed sessionStorage
    // CHAT_STATE_KEY and DELETEd chat-state.json, so a survivor with unsaved cards needs both
    // re-written or it loses its own save-bar state on the next restore.
    document.addEventListener('tiptask:chat-persist-purged', () => { saveChatDraft(); saveChatState(); });
  }
}

// ── Attach chat input handlers (called each render cycle while a New-section tab is active) ──
export function attachChatHandlers() {
  syncObjectiveChatLayout();
  addComposerTooltips(); // (C1240) re-applied every render cycle — see COMPOSER_TOOLTIPS above
  // (TPT181) Fire-and-forget: self-gated (empty/all-disabled list, TTL, not mid-turn), so calling
  // it on every render pass is cheap. Fires before the rest of the DOM wiring so the fetch overlaps it.
  void refreshProvidersForComposer();

  // Tab bar
  const tabBar = document.getElementById('chat-tab-bar');
  if (tabBar) _attachTabBarHandlers(tabBar);

  // Chat-model-selector (C1029) — value renders from state each cycle (see
  // buildModelSelectorHtml), so the handler only needs to persist the change; no reload().
  const modelSelect = document.getElementById('chat-model-select');
  if (modelSelect) {
    // (C1136) The rendered <select>'s value can diverge from what state thinks is picked —
    // a per-tab override or sticky default naming a provider/model this project no longer
    // offers (de-selected in Settings → Agents, an "Other Model" row removed).
    // applyProviderConfig()/knownSelection() above already heals the STICKY
    // state.objectiveModel default this way; it never touches state.chatState.objectiveModel,
    // the per-tab value effectiveObjectiveModel() reads FIRST. The <select> itself already
    // fell back to its first real option per the HTML default-selection algorithm (objectiveProviders
    // is now filtered server-side to only selected+configured providers) — adopt that so the
    // next turn SENDS what the user SEES, instead of dispatch.js rejecting a stale value with
    // provider-unavailable.
    if (modelSelect.value && modelSelect.value !== effectiveObjectiveModel()) {
      state.objectiveModel = modelSelect.value;
      if (state.chatState) state.chatState.objectiveModel = modelSelect.value;
    }
    modelSelect.addEventListener('change', () => {
      const val = modelSelect.value;
      if (!val) return;
      state.objectiveModel = val; // sticky cross-session default
      try { localStorage.setItem(OBJECTIVE_MODEL_KEY, val); } catch {}
      if (state.chatState) {
        state.chatState.objectiveModel = val; // per-tab override
        saveChatDraft();
      }
    });
  }

  const chatSendBtn = document.getElementById('btn-chat-send');
  const chatInput = document.getElementById('chat-input');
  let chatVoiceRec = null;
  if (chatInput) {
    requestObjectiveNotificationPermission();
    rebuildObjectiveImagePreviews(chatInput);
    attachImagePaste(chatInput, null, {
      onFileDetected: file => console.debug('[NewObj:paste]', file.name, file.size, file.type),
      onFileSkipped: file => console.warn('[NewObj:paste] skipped non-image', file.name, file.size, file.type),
      onUploaded: (file, url) => appendNewObjectiveImagePreview(file, url),
      onUploadError: (file, err) => {
        console.error('[NewObj:upload] failed', err);
        appendNewObjectiveUploadError(file, err);
      },
    });
    // Remove stale previews when user edits/deletes the image markdown
    chatInput.addEventListener('input', () => {
      document.querySelectorAll('#new-obj-image-feedback .new-obj-img-preview')
        .forEach(img => {
          const u = img.dataset.uploadedUrl;
          if (u && !chatInput.value.includes(u)) {
            (img.closest('.new-obj-img-preview-wrap') || img).remove();
          }
        });
    });
    // (C1241, listener-leak fixed C1248) Embed dropdown — embed-menu.js; every close path tears
    // down its document-level outside-click/Escape listeners (closeOpenEmbedMenu() also runs on
    // every render, from ensureGlobalChatBindings()).
    const embedWrap = document.getElementById('btn-obj-img-upload')?.closest('.embed-menu-wrap');
    if (embedWrap) {
      attachEmbedMenu(embedWrap, chatInput, {
        imageOpts: {
          onFileDetected: file => console.debug('[NewObj:file]', file.name, file.size, file.type),
          onFileSkipped: file => console.warn('[NewObj:file] skipped non-image', file.name, file.size, file.type),
          onUploaded: (file, url) => appendNewObjectiveImagePreview(file, url),
          onUploadError: (file, err) => {
            console.error('[NewObj:file] upload failed', err);
            appendNewObjectiveUploadError(file, err);
          },
        },
      });
    }
    // (C1211) Mic shares composer's disabled state — locked for the whole in-flight turn,
    // same predicate renderObjectiveContent() used to disable textarea/select/send above.
    // attachChatHandlers() re-runs every render cycle, so this stays in lockstep with
    // isStreaming with no separate enable/disable event wiring needed.
    chatVoiceRec = attachAudioRecorder(chatInput, { emphasis: true });
    if (chatVoiceRec) chatVoiceRec.setLocked(objectiveIsStreaming());
    // Word-count indicator (only shown on new objective, no chatState)
    const wordCountEl = document.getElementById('chat-word-count');
    if (wordCountEl) {
      const updateWordCount = () => {
        const words = chatInput.value.trim().split(/\s+/).filter(Boolean).length;
        wordCountEl.textContent = `${words} word${words !== 1 ? 's' : ''}`;
        const hint = wordCountEl.closest('.chat-brief-hint');
        if (hint) {
          hint.setAttribute('aria-live', 'polite');
          hint.classList.toggle('chat-brief-hint--low', words > 0 && words < 40);
        }
      };
      chatInput.addEventListener('input', updateWordCount);
      updateWordCount();
    }
  }
  if (chatSendBtn && chatInput) {
    const doSend = async () => {
      // (C1225) Send must stop any live New Objective recording before processing the
      // prompt. Use the recorder's external stop path so its normal setIdle() lifecycle
      // still owns onSessionEnd/onTranscript completion.
      if (chatVoiceRec?.isActive) chatVoiceRec.stop();
      const text = chatInput.value.trim();
      // (TPT254) A subtask/split tab may kick off its FIRST turn with a blank composer — the
      // split target reaches the agent through applyRehashIntent()'s --append-system-prompt
      // directive, built from taskKey alone. Follow-ups and ordinary chat still require text.
      const blankSplitStart = !state.chatState && !!tabSubtaskCtx();
      if (!canSubmitObjective(text, { allowBlank: blankSplitStart, busy: objectiveIsStreaming() })) return;
      _prewarmSent = false; // reset so next turn's typing triggers another prewarm
      clearTimeout(_prewarmTimer);
      state.lastSentPrompt = text;
      saveDraft(LAST_PROMPT_KEY, { text });
      chatInput.value = '';
      chatInput.style.height = 'auto';

      if (!state.chatState) {
        // First message — start new objective session.
        // Open the WS immediately (deferred-start), then fetch conventions +
        // save recipe in parallel. Send `start` once the prompt is ready.
        clearDraft(getObjectiveDraftKey());
        sessionStorage.removeItem(ACTIVE_NEW_TAB_KEY);

        // Mount streaming bubble + open WS now (prompt delivered later via _sendStart)
        startChat(null, text, null, null);
        const sendingChat = state.chatState;

        try {
          // (TPT254) A blank subtask kickoff is not a user-authored brief. Both writers
          // (api/src/routes/recipes.js, ws-handlers.js POST /api/recipes) reject empty
          // content with 400 anyway, and saveRecipe() swallows it, so this would be a
          // guaranteed no-op round trip that still nulls state.recipesCache.
          if (text) await saveRecipe(text);
        } catch (err) {
          // (C1458) showToast doesn't block/await, so WS teardown below still runs
          // immediately — unlike a real confirm dialog, there's nothing to delay.
          showToast(t('chat.errSaveRecipe', { msg: err.message }), 'error');
          sendingChat?.ws?.close();
          if (state.chatState === sendingChat) clearActiveTab();
          return;
        }

        const buildStart = Date.now();
        // (TPT254) text is '' only on a blank split kickoff (the guard above rejects every
        // other blank send). The nudge goes into the prompt body alone; startChat() already
        // stored userText '' so the transcript and originalUserText stay empty.
        const { systemPrompt, userPrompt } = buildObjectivePrompt(text || BLANK_SUBTASK_BRIEF, null, null, { groupingEnabled: getObjectiveGroupingEnabled(), originTaskKey: sendingChat?.originTaskKey });
        const buildPromptMs = Date.now() - buildStart;
        const clientTiming = { buildPromptMs };

        if (sendingChat && sendingChat._sendStart) {
          sendingChat.systemPrompt = systemPrompt;
          sendingChat._sendStart({ prompt: userPrompt, systemPrompt, clientTiming });
        }
      } else {
        // Follow-up message — send feedback
        await sendChatMessage(text);
      }
    };
    chatSendBtn.addEventListener('click', doSend);
    // (C1242) Cmd/Ctrl+Enter submits; plain Enter (and Shift+Enter) now just inserts a newline —
    // the composer's own multi-line brief design (7-row textarea, "aim for 40+ words" hint)
    // fought plain-Enter-to-send. Send button + tooltip.send (submitShortcutLabel) are the
    // discoverability path.
    chatInput.addEventListener('keydown', (e) => {
      if (!isSubmitShortcut(e)) return;
      e.preventDefault();
      doSend();
    });
    // Auto-grow textarea + debounced prewarm hint to server
    let _prewarmSent = false;
    let _prewarmTimer = null;
    chatInput.addEventListener('input', () => {
      // autoGrowComposer() no-ops on a detached orphan (C1200 — createLiveInserter's write() can
      // still dispatch `input` here) but the draft save below still runs for it.
      autoGrowComposer(chatInput);
      const val = chatInput.value;
      if (val.trim()) saveDraft(getObjectiveDraftKey(), { text: val, height: chatInput.style.height });
      else clearDraft(getObjectiveDraftKey());
      // Debounced prewarm signal: spin up next claude proc while user types
      if (!_prewarmSent) {
        clearTimeout(_prewarmTimer);
        _prewarmTimer = setTimeout(() => {
          const cs = state.chatState;
          if (cs && cs.isStreaming) return; // turn in flight — skip
          _prewarmSent = true;
          const ws = cs && cs.ws;
          if (ws && ws.readyState === WebSocket.OPEN) {
            // Warm path: active session, next follow-up turn
            ws.send(JSON.stringify({ type: 'objective-typing', model: effectiveObjectiveModel() }));
          } else if (!cs || !cs.ws) {
            // Cold path: no session yet — first-turn compose; trigger global cold prewarm
            fetchWithRetry('/api/objective/prewarm', { method: 'POST', timeoutMs: 5000, retries: 0, label: 'objective-prewarm-cold' }).catch(() => {});
          }
        }, 300);
      }
    });
    // Trigger auto-grow on load to adjust height for restored draft. (C1243) Deferred one
    // frame — this fires synchronously right after attachAudioRecorder() (above) re-parents
    // #chat-input into a brand-new .audio-rec-wrap, so an immediate autoGrowComposer() forces
    // a layout read against DOM that was inserted moments ago in the same tick. rAF lets the
    // browser's own paint absorb that layout instead of an extra forced-synchronous one during
    // the render's hot path — same end state, no visible height jump (next paint hasn't happened
    // yet), measurably cheaper on every Objective render that restores a non-empty draft.
    // (C1296) Runs unconditionally now — an empty composer recounts immediately so the long
    // multi-line placeholder fits without a scrollbar.
    requestAnimationFrame(() => autoGrowComposer(chatInput));

    // (TPT525) Restore the focused composer a full render rebuilt (armed by
    // renderObjectiveContent()). Runs after attachAudioRecorder() re-parented #chat-input above,
    // which blurs it. One-shot, and only for the same tab it was captured on.
    if (_pendingComposerRestore) {
      const pending = _pendingComposerRestore;
      _pendingComposerRestore = null;
      if (pending.tabId === state.activeTabId) restoreObjectiveViewState(pending);
    }

    // (TPT16) Apply a seed queued by spawnObjectiveTab() now that this IS the live composer
    // and every input listener above (word count, autoGrow+draft-save, prewarm) is bound, and
    // rebuildObjectiveImagePreviews() above has already rebuilt the thumbnail strip from the
    // draft text. One-shot: cleared immediately so a later render of the same tab (background
    // board-snapshot refresh, switching back to this tab) never re-steals focus or re-fires
    // the prewarm. The dispatched 'input' event is what actually runs those listeners — the
    // draft-restored `value` alone (rendered from state, above) never fires them.
    if (_pendingComposerSeed && _pendingComposerSeed.tabId === state.activeTabId) {
      const seed = _pendingComposerSeed;
      _pendingComposerSeed = null;
      if (!chatInput.value) chatInput.value = seed.text; // backstop — render should have this already
      chatInput.dispatchEvent(new Event('input', { bubbles: true }));
      try { chatInput.focus({ preventScroll: true }); } catch { chatInput.focus(); }
      const end = chatInput.value.length;
      try { chatInput.setSelectionRange(end, end); } catch {}
    }
  }

  // ── Stop button handler (visible during streaming) ──
  const chatStopBtn = document.getElementById('btn-chat-stop');
  if (chatStopBtn) {
    chatStopBtn.addEventListener('click', async () => {
      if (!state.chatState) return;
      chatStopBtn.disabled = true;
      const ws = state.chatState.ws;
      const tid = state.chatState.taskId;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'abort', tabId: tid }));
      }
      // Always also issue HTTP abort — WS send is fire-and-forget, and if the
      // WS is closed/reconnecting we'd otherwise silently do nothing.
      let serverHadSession = false;
      if (tid) {
        try {
          const res = await fetchWithRetry(`/api/objective/abort?taskId=${encodeURIComponent(tid)}`, { method: 'POST', label: 'objective-abort' });
          serverHadSession = res.ok;
        } catch {}
      }
      // If server has no session, the "streaming" state is a leftover from a
      // previous tab session — reset the UI locally so the user isn't stuck.
      if (!serverHadSession) {
        for (const m of state.chatState.messages) { if (m.streaming) m.streaming = false; }
        state.chatState.processExited = true;
        state.chatState.retryable = true;
        reload();
      }
    });
  }

  // ── Retry button handler ──
  const retryBtn = document.getElementById('btn-chat-retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      if (!state.chatState) return;
      retryBtn.disabled = true;
      const originalText = state.chatState.originalUserText;
      const ws = state.chatState.ws;
      clearObjectiveReadyMemory(state.chatState.taskId);

      if (ws && ws.readyState === WebSocket.OPEN) {
        // Server-side restart — optimistic UI reset
        state.chatState.messages = [
          { role: 'user', content: originalText, cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: false, timestamp: Date.now() },
          { role: 'assistant', content: '', cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: true, timestamp: Date.now() },
        ];
        state.chatState.clientBuffer = '';
        state.chatState.cleanContent = null;
        state.chatState.processExited = false;
        state.chatState.retryable = false;
        state.chatState.lastParseError = null;
        state.chatState._lastErrorReason = null;   // C1031
        state.chatState._lastErrorProvider = null;
        state.chatState.chatReadySeen = false;
        state.chatState.allChanges = [];
        state.chatState.autoRetryCount = 0;
        state.chatState.historyWindowStart = 1;
        state.chatState.historyTotalCount = 2;
        state.chatState.hasOlderHistory = false;
        syncChatHistoryMeta(state.chatState);
        reload();
        ws.send(JSON.stringify({ type: 'restart', ...rehashPayload(state.chatState), tabId: state.chatState.taskId, model: effectiveObjectiveModel() }));
      } else {
        // WS closed — create fresh session
        closeConsoleIfOpen();
        clearActiveTab();
        const { systemPrompt: wsClosed_sp, userPrompt: wsClosed_up } = buildObjectivePrompt(originalText, null, null, { groupingEnabled: getObjectiveGroupingEnabled(), originTaskKey: tabOriginTaskKey() });
        startChat(wsClosed_up, originalText, wsClosed_sp);
      }
    });
  }

  // Auto-focus retry button when visible (after DOM settles)
  if (retryBtn) requestAnimationFrame(() => retryBtn.focus());

  // Clear objective draft button
  const clearObjDraftBtn = document.getElementById('clear-objective-draft');
  if (clearObjDraftBtn) {
    clearObjDraftBtn.addEventListener('click', () => {
      clearDraft(getObjectiveDraftKey());
      clearDraft(LAST_PROMPT_KEY);
      state.lastSentPrompt = null;
      sessionStorage.removeItem(ACTIVE_NEW_TAB_KEY);
      const ta = document.getElementById('chat-input');
      if (ta) ta.value = '';
      reload();
    });
  }

  const newObjectiveBtn = document.getElementById('btn-new-objective');
  if (newObjectiveBtn) {
    newObjectiveBtn.addEventListener('click', () => {
      cleanupChat();
      reload();
    });
  }

  // Exit subtask mode button (× in banner)
  // (C1410) Only detach THIS tab from its subtask target — clearActiveTab() used to also wipe
  // the tab's whole chatState (the only way to dismiss a wrong banner deleted the transcript),
  // and wiping the global state.subtaskStack reset the BOARD's drill-down, which the chat has
  // no business touching.
  const clearSubtaskCtxBtn = document.querySelector('.btn-clear-subtask-ctx');
  if (clearSubtaskCtxBtn) {
    clearSubtaskCtxBtn.addEventListener('click', () => {
      const activeTab = getActiveTab();
      if (activeTab) { activeTab.subtaskCtx = null; Object.assign(activeTab, rehashPayload(null)); }
      if (state.chatState) {
        state.chatState.parentTaskKey = null;
        Object.assign(state.chatState, rehashPayload(null));
        saveChatDraft();
        saveChatState();
      }
      syncDiscussLocks();
      reload();
    });
  }

  // (TPT179) Pinned discuss preview: open-read-only card + exit ×.
  bindDiscussPreview(document.querySelector('.chat-discuss-preview'));

  // Exit planning mode button (× in origin banner) — same detach-only discipline
  // as the subtask-ctx clear handler above (C1559).
  const clearOriginCtxBtn = document.querySelector('.btn-clear-origin-ctx');
  if (clearOriginCtxBtn) {
    clearOriginCtxBtn.addEventListener('click', () => {
      const activeTab = getActiveTab();
      if (activeTab) activeTab.originTaskKey = null;
      if (state.chatState) {
        const oldOrigin = state.chatState.originTaskKey;
        state.chatState.originTaskKey = null;
        state.chatState.originResolution = null;
        if (oldOrigin && state.chatState.objectiveParentKey === oldOrigin) state.chatState.objectiveParentKey = null;
        saveChatDraft();
        saveChatState();
      }
      reload();
    });
  }

  const loadEarlierBtn = document.getElementById('btn-load-earlier-history');
  if (loadEarlierBtn) {
    loadEarlierBtn.addEventListener('click', async () => {
      if (!state.chatState || !state.chatState.taskId) return;
      loadEarlierBtn.disabled = true;
      const before = state.chatState.historyWindowStart || 1;
      try {
        const res = await fetchWithRetry(
          `/api/objective/history?taskId=${encodeURIComponent(state.chatState.taskId)}&before=${before}&limit=${OBJECTIVE_HISTORY_PAGE_MESSAGES}`,
          { timeoutMs: 5000, headers: projectHeader(), label: 'objective-history-load' }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        const chunk = normalizeChatMessages(payload.messages);
        if (chunk.length > 0) {
          const first = state.chatState.messages[0];
          const existingTail = first ? state.chatState.messages.slice(1) : state.chatState.messages.slice();
          const seen = new Set(existingTail.map(m => `${m.role}:${m.timestamp}`));
          const toPrepend = chunk.filter(m => !seen.has(`${m.role}:${m.timestamp}`));
          state.chatState.messages = first
            ? [first, ...toPrepend, ...existingTail]
            : [...toPrepend, ...existingTail];
          state.chatState.historyWindowStart = Math.max(1, Number(payload.historyWindowStart) || 1);
          state.chatState.historyTotalCount = Number(payload.historyTotalCount) || state.chatState.historyTotalCount;
          state.chatState.hasOlderHistory = !!payload.hasOlderHistory;
          syncChatHistoryMeta(state.chatState);
          saveChatDraft();
          reload();
        }
      } catch (err) {
        showToast(t('chat.errLoadEarlier', { msg: err.message }), 'error');
      } finally {
        loadEarlierBtn.disabled = false;
      }
    });
  }

  // Scroll to bottom after reload() when flagged
  if (state.chatState && state.chatState.shouldScrollToBottom) {
    state.chatState.shouldScrollToBottom = false;
    const msgContainer = document.getElementById('chat-messages');
    if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  // (C1390) Bubble expand/collapse — delegated on #chat-messages, which is fully rebuilt on
  // every render, so this listener never stacks across renders like the other handlers here.
  // Toggling is DOM-only (no reload()), so scroll position / streaming state are untouched.
  const chatMessagesEl = document.getElementById('chat-messages');
  if (chatMessagesEl) {
    chatMessagesEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.chat-bubble-expand-btn');
      if (!btn || !state.chatState) return;
      const bubble = btn.closest('.chat-bubble');
      if (!bubble) return;
      const key = btn.dataset.bubbleKey;
      const expandedIds = expandedBubbleSet(state.chatState);
      const nowExpanded = !expandedIds.has(key);
      if (nowExpanded) expandedIds.add(key); else expandedIds.delete(key);
      bubble.classList.toggle('chat-bubble--expanded', nowExpanded);
      btn.textContent = nowExpanded ? t('chat.bubble.showLess') : t('chat.bubble.showMore');
      if (!nowExpanded) bubble.scrollIntoView({ block: 'nearest' });
    });
  }
  syncBubbleClamps();
}

// ── Start a new chat session ──
export function startChat(prompt, userText, systemPrompt, clientTiming) {
  state.cleanupInProgress = false;
  // Find or create the active tab entry
  let tab = getActiveTab();
  if (!tab) {
    // No active tab — create one. (C1410) Brand-new tab, same capture-once rule as
    // openNewTab() — snapshot the board drill-down top now, never re-read it live later.
    const newTabId = `obj-${Date.now()}`;
    tab = { tabId: newTabId, title: deriveTabTitle({ messages: [{ role: 'user', content: userText || '' }] }), status: 'streaming', chatState: null, subtaskCtx: captureSubtaskCtx(state.subtaskStack), originTaskKey: null };
    state.tabsState.push(tab);
    state.activeTabId = newTabId;
  } else if (tab.chatState && tab.chatState.messages && tab.chatState.messages.some(m => m.streaming)) {
    // Active tab mid-stream — don't overwrite
    return;
  } else if (tab.tabId.startsWith('obj-new-')) {
    // Placeholder from + button — assign real id
    const newId = `obj-${Date.now()}`;
    tab.tabId = newId;
    state.activeTabId = newId;
  }
  tab.status = 'streaming';
  // (C1162) Pinned title (spawnObjectiveTab() opts.title, e.g. task key) survives send.
  if (!tab.titlePinned) tab.title = deriveTabTitle({ messages: [{ role: 'user', content: userText || '' }] });

  const taskId = tab.tabId;
  clearObjectiveReadyMemory(taskId);
  state.chatState = {
    taskId,
    messages: [
      { role: 'user', content: userText, cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: false, timestamp: Date.now() },
      { role: 'assistant', content: '', cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: true, timestamp: Date.now() },
    ],
    ws: null,
    clientBuffer: '',
    cleanContent: null,
    processExited: false,
    originalUserText: userText,
    systemPrompt: systemPrompt || null,
    allChanges: [],
    ...rehashPayload(tab),
    // (TPT254) userText is legitimately '' on a blank subtask kickoff. startChat() never reads
    // the composer and derives nothing from the text — parentTaskKey, rehashPayload(tab) and
    // originTaskKey all come from the tab — so no empty-input branch is needed here, and no
    // default brief is synthesised: the split target travels via --append-system-prompt only.
    parentTaskKey: (tabSubtaskCtx() || {}).taskKey || null, // (C1162/C1410) active tab's own captured context, never live
    objectiveParentKey: null, // C1339 — a fresh chat must never inherit another chat's parent
    originTaskKey: tabOriginTaskKey(), // (C1559) active tab's own captured web-origin key, never live
    originResolution: null, // (C1559) 'single'|'parent' once a save consumes the origin plan
    term: null,
    fitAddon: null,
    onResize: null,
    tickSeen: false,
    retryable: false,
    pendingCardsUpdate: false,
    chatReadySeen: false,
    autoRetryCount: 0,
    historyWindowStart: 1,
    historyTotalCount: 2,
    hasOlderHistory: false,
    // C1029 — seed from the sticky cross-session default so this tab is self-contained
    // (a later change on another tab must not bleed into this one via a shared fallback).
    objectiveModel: state.objectiveModel || null,
  };
  tab.chatState = state.chatState;

  syncChatHistoryMeta(state.chatState);
  state.activeTab = 'objective';
  state.chatState.shouldScrollToBottom = true;
  syncObjectiveChatLayout();
  reload();

  connectObjectiveWS(taskId, prompt, { clientTiming });
  saveChatDraft();
}

// True while tab `tabId` still exists and still holds chat state `cs` (not closed or replaced).
function _tabOwnsChat(tabId, cs) {
  return state.tabsState.some(t => t.tabId === tabId && t.chatState === cs);
}

// ── Connect WebSocket for objective session ──
export function connectObjectiveWS(taskId, prompt, opts) {
  const reconnect = !!(opts && opts.reconnect);
  // Resolve tab entry at call time; tab.chatState may differ from state.chatState after switches.
  const callerTab = state.tabsState.find(t => t.tabId === taskId);
  if (!callerTab || !callerTab.chatState) {
    // Reconnect path: server session may still be live even if chatState was cleared.
    if (!reconnect) return;
  }

  const wsConnectStart = Date.now();
  // reconnect=1: reattach only. A server whose session is already gone answers with a
  // session-gone objective-error instead of opening a pending session nobody will start.
  const ws = new WebSocket(buildWsUrl(taskId, reconnect ? { reconnect: '1' } : undefined));
  ws._tabId = taskId; // stamp so onmessage can route to the right tab
  // Write ws reference into this tab's chatState (not necessarily state.chatState)
  const initialCs = callerTab ? callerTab.chatState : null;
  if (initialCs) { initialCs.ws = ws; initialCs.taskId = taskId; }

  // Deferred-start support: when prompt is null at connect time, _sendStart()
  // delivers it later (once saveRecipe + buildObjectivePrompt finish).
  let _wsOpen = false;
  let _pendingStart = null;

  function _doSendStart(payload) {
    const t = state.tabsState.find(t => t.tabId === taskId);
    const cs = t ? t.chatState : null;
    const wsOpenMs = Date.now() - wsConnectStart;
    const baseTiming = payload.clientTiming ? { ...payload.clientTiming } : {};
    baseTiming.wsOpenMs = wsOpenMs;
    ws.send(JSON.stringify({
      type: 'start',
      tabId: taskId,
      prompt: payload.prompt,
      userText: cs && cs.originalUserText,
      mode: 'objective',
      ...rehashPayload(cs),
      systemPrompt: cs && cs.systemPrompt,
      clientTiming: baseTiming,
      // C1029 — this tab's chatState may not be state.chatState by the time a deferred
      // start fires (user switched tabs mid-flight), so resolve against the tab-scoped
      // `cs`, not the global active-tab helper.
      model: (cs && cs.objectiveModel) || state.objectiveModel || null,
    }));
  }

  if (initialCs) {
    initialCs._sendStart = (payload) => {
      if (_wsOpen) _doSendStart(payload);
      else _pendingStart = payload;
    };
  }

  ws.onopen = () => {
    _wsOpen = true;
    if (!reconnect) {
      if (prompt != null) {
        // Eager mode: prompt was ready at connect time
        _doSendStart({ prompt, clientTiming: opts && opts.clientTiming });
      } else if (_pendingStart) {
        // Deferred mode: _sendStart was already called while WS was connecting
        _doSendStart(_pendingStart);
        _pendingStart = null;
      }
      // else: _sendStart will be called once prompt is built
    }
    // In reconnect mode, the server's reconnect path replays chat-history,
    // any buffered data, and either `objective-result`+`exit` (pending turn
    // result) or `chat-ready` (session idle) — no 'start' needed.
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    // Route to the tab that owns this WS, regardless of which tab is active.
    const wsTabId = ws._tabId;
    const tab = state.tabsState.find(t => t.tabId === wsTabId);
    const isActiveTab = state.activeTabId === wsTabId;
    // Repaint: full reload if this is the visible tab, else just update the tab bar icon.
    const repaint = () => {
      if (tab) tab.status = computeTabStatus(tab.chatState);
      if (isActiveTab) reload(); else renderTabBarOnly();
    };

    if (msg.type === 'config') {
      state.showAiStats = msg.showAiStats;
      if (msg.taskAgent) state.taskAgent = msg.taskAgent;
      if (msg.taskAgentLabel) state.taskAgentLabel = msg.taskAgentLabel;
      if (msg.agentLabels && typeof msg.agentLabels === 'object' && !Array.isArray(msg.agentLabels)) state.agentLabels = msg.agentLabels;
      if (msg.planApprovalCommand) state.planApprovalCommand = msg.planApprovalCommand;
      // C1029 — chat-model-selector option list, always refreshed (availability can
      // change between reconnects, e.g. Codex logs out).
      // (C1045) A current server always sends 4 entries (registry.js SELECTABLE_PROVIDERS)
      // — this rarely fires against anything but a genuinely old build predating C1029/C1030.
      if (!Array.isArray(msg.objectiveProviders) || msg.objectiveProviders.length === 0) {
        console.warn('[objective:selector] config frame missing objectiveProviders — server may predate C1029/C1030', msg);
      }
      // (TPT181) This frame used to adopt the list without repainting, so a selector that was
      // missing/all-disabled stayed that way until some unrelated re-render (the turn's own
      // completion) — the "dropdown only appears after the first turn" symptom. In-place
      // repaint, and only when the list actually changed.
      if (applyProviderConfig(msg)) refreshObjectiveContent();
      return;
    }

    // All subsequent handlers need the tab's chatState.
    const cs = tab ? tab.chatState : null;
    if (!cs) return;

    if (msg.type === 'objective-progress') {
      // C1031 — first frame of every turn from all four providers, so this is the one reliable
      // "new turn started" signal. Clears the sticky error state the retry banner reads, so a
      // later unrelated "no cards" outcome doesn't render stale error copy.
      cs._lastErrorReason = null;
      cs._lastErrorProvider = null;
      // Transient progress chip — shows Claude's internal stage without polluting the buffer
      const PROGRESS_LABELS = {
        spawned:                 'Starting model…',
        'cli-init':              'Initializing tools…',
        'model-thinking':        'Thinking…',
        working:                 'Working…',
        'pi-retry':              'Provider retrying…',
        'pi-compaction':         'Compacting context…',
        'tool:mcp__tipatask__list_tasks':          'Scanning tasks…',
        'tool:mcp__tipatask__list_system_tags':    'Reading tag taxonomy…',
        'tool:mcp__tipatask__get_tag_architecture': 'Reading architecture…',
        'tool:mcp__tipatask__get_tag_architectures':'Reading architectures…',
        'tool:mcp__tipatask__get_task':            'Loading task…',
        'tool:mcp__tipatask-local__batch_grep_tags': 'Batch source scan…',
      };
      const key = msg.stage === 'tool' ? `tool:${msg.name}` : msg.stage;
      const label = PROGRESS_LABELS[key] || (msg.stage === 'tool' ? `Tool: ${msg.name}…` : null);
      // tool-end keeps the current label visible until the next signal clears it
      if (msg.stage !== 'tool-end' && label) {
        cs.progressStage = label;
      }
      // C1255 — feed the Debug Console's live progress log. 'spawned' is the one reliable
      // per-turn signal (see comment above), so it doubles as the turn-boundary marker.
      if (msg.stage === 'spawned') noteTurnBoundary(cs);
      appendProgressLog(cs, {
        kind: msg.stage,
        text: stageLogText(msg.stage, msg.name, msg.detail),
        toolName: msg.name,
        elapsedMs: msg.elapsedMs,
      });
      if (tab) tab.status = 'streaming';
      if (isActiveTab) updateProgressChip(); else renderTabBarOnly();
    } else if (msg.type === 'objective-thinking') {
      // Thinking tokens from extended-thinking model — show live preview in progress chip area.
      // Kept in a ring-buffer so only the tail is visible; doesn't pollute turnBuffer/cards.
      const prev = cs.thinkingPreview || '';
      const combined = prev + msg.data;
      cs.thinkingPreview = combined.length > 400 ? combined.slice(-400) : combined;
      // Show last line of thinking as the progress chip label
      const lastLine = cs.thinkingPreview.trimEnd().split('\n').pop().trim();
      if (lastLine) cs.progressStage = `Thinking: ${lastLine.slice(0, 60)}${lastLine.length > 60 ? '…' : ''}`;
      // C1255 — coalesced into the Debug Console log (one line per idle/newline/char-threshold
      // flush, not per token — see objective-progress-log.js pushThinking()).
      pushThinking(cs, msg.data);
      if (isActiveTab) updateProgressChip();
    } else if (msg.type === 'data') {
      cs.progressStage = null; // real data — clear chip
      cs.thinkingPreview = '';  // discard thinking preview
      flushThinking(cs); // C1255 — real text arrived; flush any pending thinking line first
      if (isActiveTab) updateProgressChip();
      cs.clientBuffer += msg.data;
      // Update last assistant message content
      let lastMsg = cs.messages[cs.messages.length - 1];
      if (!lastMsg || lastMsg.role !== 'assistant') {
        ensureStreamingAssistant(cs);
        lastMsg = cs.messages[cs.messages.length - 1];
      }
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content += msg.data;
      }
      // Forward to xterm if console is open
      if (cs.term) {
        cs.term.write(msg.data);
        (cs.termScroll ?? cs.term.scrollToBottom.bind(cs.term))();
      }
      if (tab) tab.status = 'streaming';
      // Lightweight DOM update (active tab only)
      if (isActiveTab) updateStreamingBubble(); else renderTabBarOnly();
    } else if (msg.type === 'objective-result') {
      cs.progressStage = null;
      cs.thinkingPreview = '';
      if (isActiveTab) updateProgressChip();
      // C1255 — Debug Console log: mark turn completion with card/token summary.
      const cardCount = msg.cards ? msg.cards.length : 0;
      const tokSummary = msg.tokens ? ` · ${msg.tokens.input ?? 0}/${msg.tokens.output ?? 0} tokens` : '';
      appendProgressLog(cs, { kind: 'result', text: `${cardCount} card${cardCount === 1 ? '' : 's'}${tokSummary}` });
      cs.cleanContent = msg.content;
      const lastMsgOR = cs.messages[cs.messages.length - 1];
      if (lastMsgOR && lastMsgOR.role === 'assistant') {
        if (msg.tokens) lastMsgOR.tokens = msg.tokens;
        if (msg.filesAddressed) lastMsgOR.filesAddressed = msg.filesAddressed;
        if (msg.docUpdates) lastMsgOR.docUpdates = msg.docUpdates;
        if (msg.timingMilestones) lastMsgOR.timingMilestones = msg.timingMilestones;
        if (Array.isArray(msg.cards)) {
          lastMsgOR._serverCards = msg.cards;
          lastMsgOR.streaming = false;
          if (tab) tab.status = 'done';
          notifyObjectiveCardsReady(lastMsgOR, msg.cards.length, wsTabId);
        }
        if (msg.newTags) lastMsgOR._serverNewTags = msg.newTags;
        if (msg.objectiveSummary) lastMsgOR._serverObjectiveSummary = msg.objectiveSummary; // C1339
        if (msg.tokens || msg.timingMilestones) {
          if (tab) tab.status = computeTabStatus(cs);
          if (isActiveTab) reload(); else renderTabBarOnly();
        }
      }
    } else if (msg.type === 'chat-history-reset') {
      cs.messages = normalizeChatMessages(msg.messages);
      // C1029 — server is authoritative on reconnect: this session's actual provider/model
      // may not match whatever the client last remembered (page reload, another tab, etc).
      if (msg.objectiveSelection) cs.objectiveModel = msg.objectiveSelection;
      cs.historyWindowStart = Math.max(1, Number(msg.historyWindowStart) || 1);
      cs.historyTotalCount = Number(msg.historyTotalCount) || cs.messages.length;
      cs.hasOlderHistory = !!msg.hasOlderHistory;
      cs.originalUserText = cs.messages.find(m => m.role === 'user')?.content || cs.originalUserText || '';
      cs.processExited = !msg.running;
      cs.retryable = false;
      cs._lastErrorReason = null;   // C1031
      cs._lastErrorProvider = null;
      cs.pendingCardsUpdate = false;
      cs.chatReadySeen = false;
      cs.clientBuffer = '';
      cs.cleanContent = null;
      if (msg.running) ensureStreamingAssistant(cs);
      syncChatHistoryMeta(cs);
      saveChatDraft();
      // C1109: cards arriving here are a wholesale replacement with no
      // _existingTasksSnapshot (stripped on persist, see saveChatState below) — a
      // `modified` card renders blank title/description until reconciled. Hydrate the
      // last assistant message carrying cards so cards + its diff modal render correctly
      // right after a reconnect/reload, not only after the user first interacts with it.
      const lastCardsMsgOR = [...cs.messages].reverse().find(m => m.role === 'assistant' && m.cards?.length);
      if (lastCardsMsgOR) ensureExistingSnapshot(lastCardsMsgOR).then(() => { if (isActiveTab) repaint(); });
      repaint();
    } else if (msg.type === 'exit') {
      cs.processExited = true;
      cs.progressStage = null;   // C1031 — parity with data/objective-result
      cs.thinkingPreview = '';
      if (cs.term) {
        cs.term.write('\r\n\x1b[90m--- Process exited ---\x1b[0m\r\n');
        (cs.termScroll ?? cs.term.scrollToBottom.bind(cs.term))();
        if (isActiveTab) {
          const closeBtn = document.querySelector('#objective-console .btn-close-terminal');
          if (closeBtn) closeBtn.textContent = 'Close';
        }
      }
      // Parse result and update last assistant message
      const rawContent = cs.cleanContent || stripAnsi(cs.clientBuffer);
      const lastMsg = cs.messages[cs.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.streaming = false;
        try {
          let cards;
          if (Array.isArray(lastMsg._serverCards)) {
            cards = lastMsg._serverCards;
            lastMsg.newTags = Array.isArray(lastMsg._serverNewTags) ? lastMsg._serverNewTags : [];
            lastMsg.objectiveSummary = lastMsg._serverObjectiveSummary || null; // C1339
            delete lastMsg._serverCards;
            delete lastMsg._serverNewTags;
            delete lastMsg._serverObjectiveSummary;
          } else {
            const proposals = parseObjectiveResult(rawContent);
            cards = proposals.changes;
            lastMsg.filesAddressed = proposals.files_addressed || [];
            lastMsg.docUpdates = proposals.doc_updates || [];
            lastMsg.newTags = Array.isArray(proposals.new_tags) ? proposals.new_tags : [];
            // C1339 — LLM-written objective scope summary, used as the auto-created
            // parent objective task's title on save.
            lastMsg.objectiveSummary = typeof proposals.objective_summary === 'string'
              ? proposals.objective_summary.trim() : null;
          }
          const lastMsgIdx = cs.messages.indexOf(lastMsg);
          const confirmedIds = _getConfirmedTaskIds(cs, lastMsgIdx);
          const filtered = cards.filter(c => !confirmedIds.has(c.task.id));
          filtered.forEach(c => { if (!c.task.tags) c.task.tags = []; });
          lastMsg.cards = filtered;
          // (TPT15) origin-linked chat: a stray "modified" card outside the objective's
          // own subtree starts unchecked (opt-in), not just accepted by default.
          lastMsg.acceptedMask = buildInitialAcceptedMask(cs, filtered);
          lastMsg.confirmedMask = filtered.map(() => false);
          notifyObjectiveCardsReady(lastMsg, cards.length, wsTabId);
          // Accumulate for feedback context
          cs.allChanges = cs.allChanges.concat(filtered);

          // Output quality check: if any card has a thin description (< 200 chars)
          // or no @file reference, request a revision turn automatically — once.
          // C871: blueprint check — flag cards missing any of: @file ref, named symbol+action, verification cue.
          const thinCards = filtered.filter(c => {
            const d = c.task && (c.task.description || '');
            return d.length < 200 || !/@[\w./]/.test(d) || !/\b(verify|confirm|check|ensure|expect|renders?|returns?|opens?|confirms?)\b/i.test(d);
          });
          if (thinCards.length > 0 && !cs._descRevisionSent && ws && ws.readyState === WebSocket.OPEN) {
            cs._descRevisionSent = true;
            const thinList = thinCards.map(c => `${c.task.id}: "${c.task.title}"`).join(', ');
            const revisionMsg = `The following task descriptions are missing required blueprint elements: ${thinList}. ` +
              'Please rewrite each to ≥3 numbered steps. Each step MUST include: ' +
              '(a) an @path/to/file.ext reference sourced from KB arch-doc Files tables (not from grep), ' +
              '(b) the specific function or variable name to add/change, ' +
              '(c) a one-sentence verification (e.g. "confirm endpoint returns 200", "board renders without console errors"). ' +
              'Minimum 200 characters per description.';
            cs.messages.push({ role: 'system', content: '(Auto-requesting richer descriptions...)', cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: false, timestamp: Date.now() });
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'revise', ...rehashPayload(cs), tabId: wsTabId, accepted: [], rejected: [], feedback: revisionMsg, model: (cs && cs.objectiveModel) || state.objectiveModel || null }));
              }
            }, 200);
          }

          saveChatState();
          ensureExistingSnapshot(lastMsg).then(() => { if (tab) tab.status = computeTabStatus(cs); if (isActiveTab) reload(); else renderTabBarOnly(); });
        } catch (err) {
          console.error('[objective:parse-fail]', err.message, 'preview:', err.preview, 'rawLength:', err.rawLength);
          cs.lastParseError = { message: err.message, preview: err.preview || '', rawLength: err.rawLength || 0 };
        }
      }
      // Determine if this exit is retryable (error, no result, or no cards)
      const lastAssistant = [...cs.messages].reverse().find(m => m.role === 'assistant');
      const hasCards = lastAssistant && lastAssistant.cards && lastAssistant.cards.length > 0;

      // Deferred efficiency analysis (claude-session.js:1136) may emit a `cards-update`
      // frame on slow turns — suppress retry banner until that arrives.
      const tm = lastAssistant && lastAssistant.timingMilestones;
      const totalTurnMs = (tm && tm.turnStart != null && tm.turnEnd != null)
        ? (tm.turnEnd - tm.turnStart) : 0;
      const SLOW_TURN_MS = 60000;
      if (!hasCards && msg.code === 0 && totalTurnMs > SLOW_TURN_MS) {
        cs.pendingCardsUpdate = true;
      }

      if ((msg.code !== 0 || !cs.cleanContent || !hasCards) && !cs.pendingCardsUpdate) {
        cs.retryable = true;
      }

      // Auto-retry once silently when code=0, content present, but no cards
      if (msg.code === 0 && cs.cleanContent && !hasCards && !cs.pendingCardsUpdate && cs.autoRetryCount < 1) {
        cs.autoRetryCount++;
        cs.messages.push({ role: 'system', content: 'No tasks parsed — retrying automatically...', cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: false, timestamp: Date.now() });
        repaint();
        const originalText = cs.originalUserText;
        if (ws.readyState === WebSocket.OPEN) {
          cs.messages = [
            { role: 'user', content: originalText, cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: false, timestamp: Date.now() },
            { role: 'assistant', content: '', cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: true, timestamp: Date.now() },
          ];
          cs.clientBuffer = '';
          cs.cleanContent = null;
          cs.processExited = false;
          cs.retryable = false;
          cs.chatReadySeen = false;
          cs.allChanges = [];
          cs.historyWindowStart = 1;
          cs.historyTotalCount = 2;
          cs.hasOlderHistory = false;
          syncChatHistoryMeta(cs);
          repaint();
          ws.send(JSON.stringify({ type: 'restart', ...rehashPayload(cs), tabId: wsTabId, model: (cs && cs.objectiveModel) || state.objectiveModel || null }));
        } else {
          const autoRetryCount = cs.autoRetryCount;
          closeConsoleIfOpen();
          if (tab) {
            tab.chatState = null;
            tab.status = 'idle';
            // Assign fresh tabId so startChat opens a new WS URL (old session terminated)
            const freshId = `obj-${Date.now()}`;
            tab.tabId = freshId;
            if (isActiveTab) state.activeTabId = freshId;
          }
          if (isActiveTab) state.chatState = null;
          const { systemPrompt: retry_sp, userPrompt: retry_up } = buildObjectivePrompt(originalText, null, null, { groupingEnabled: getObjectiveGroupingEnabled(), originTaskKey: tabOriginTaskKey() });
          startChat(retry_up, originalText, retry_sp);
          if (state.chatState) state.chatState.autoRetryCount = autoRetryCount;
        }
        return;
      }

      if (tab) tab.status = computeTabStatus(cs);
      notifyObjectiveStatusChanged();
      repaint();
      saveChatDraft();
    } else if (msg.type === 'error') {
      // C1255 — console now logs the failure instead of slamming shut; the user reads
      // exactly where the turn died. Read-only console, no in-flight state to lose.
      cs.progressStage = null;   // C1031 — parity with data/objective-result
      cs.thinkingPreview = '';
      appendProgressLog(cs, { kind: 'error', text: `turn failed: ${msg.message || 'unknown error'}` });
      cs.messages.push({ role: 'system', content: `Error: ${msg.message}`, cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: false, timestamp: Date.now() });
      const lastMsg = cs.messages.find(m => m.streaming);
      if (lastMsg) lastMsg.streaming = false;
      cs.retryable = true;
      notifyObjectiveStatusChanged();
      repaint();
    } else if (msg.type === 'objective-retry') {
      // Server is respawning the Claude subprocess. Reset the streaming
      // assistant bubble so the fresh stream doesn't concatenate onto the dead one,
      // and surface the retry so the user knows it's not hung.
      cs.clientBuffer = '';
      cs.cleanContent = null;
      const lastAssistantForRetry = [...cs.messages].reverse().find(m => m.role === 'assistant');
      if (lastAssistantForRetry) {
        lastAssistantForRetry.content = '';
        lastAssistantForRetry.cards = [];
        lastAssistantForRetry.acceptedMask = [];
        lastAssistantForRetry.confirmedMask = [];
        lastAssistantForRetry.streaming = true;
      }
      const attempt = msg.attempt != null ? msg.attempt : '?';
      const reason = msg.reason || 'stream interrupted';
      appendProgressLog(cs, { kind: 'retry', text: `attempt ${attempt} — ${reason}` }); // C1255
      cs.messages.push({
        role: 'system',
        content: `Retrying Claude (attempt ${attempt}) — ${reason}. Press Stop to cancel.`,
        cards: [], acceptedMask: [], confirmedMask: [],
        discarded: false, streaming: false, timestamp: Date.now(),
      });
      cs.pendingCardsUpdate = false;
      cs.shouldScrollToBottom = true;
      if (tab) tab.status = 'streaming';
      if (isActiveTab) { updateStreamingBubble(); reload(); } else renderTabBarOnly();
    } else if (msg.type === 'objective-error') {
      // C1255 — console stays open on final failure too (was closeConsoleIfOpen()); the log
      // line below is exactly the moment a stuck-looking turn needs explaining.
      cs.clientBuffer = '';
      cs.cleanContent = null;
      // C1031 — the data (:1725) and objective-result (:1747) handlers clear these; the error
      // path did not, so a failed turn's thinkingPreview kept accumulating and bled into the
      // NEXT turn's progress-chip label.
      cs.progressStage = null;
      cs.thinkingPreview = '';
      cs.messages = cs.messages.filter(m => !(m.streaming && m.role === 'assistant'
        && !m.content?.trim() && !m.cards?.length));
      for (const m of cs.messages) { if (m.streaming) m.streaming = false; }
      const reason = msg.reason || 'unknown';
      const attempts = msg.attempts != null ? msg.attempts : 0;
      appendProgressLog(cs, { kind: 'error', text: `turn failed: ${reason} (${attempts} ${attempts === 1 ? 'try' : 'tries'})${msg.model ? ` model=${msg.model}` : ''}` });
      if (msg.detail) appendProgressLog(cs, { kind: 'error', text: String(msg.detail).replace(/\s*\n\s*/g, ' | ') });
      cs._lastErrorReason = reason;
      // C1031 — server-sent, authoritative (see providerLabelFor). Absent on an old server.
      cs._lastErrorProvider = msg.provider || null;
      // C1029/C1031 — reason-aware copy. See objectiveErrorMessage() for the category map.
      const errMsg = objectiveErrorMessage(
        reason, attempts, msg.detail,
        providerLabelFor(cs, cs._lastErrorProvider),
        msg.model,
      );
      cs.messages.push({ role: 'system', content: errMsg, cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: false, timestamp: Date.now() });
      cs.processExited = true;
      cs.retryable = true;
      cs.pendingCardsUpdate = false;
      if (tab) tab.status = 'error';
      notifyObjectiveStatusChanged();
      repaint();
    } else if (msg.type === 'chat-history') {
      const m = msg.message;
      const exists = cs.messages.some(
        existing => existing.role === m.role && existing.timestamp === m.timestamp
      );
      if (!exists) {
        cs.messages.push(normalizeChatMessage({
          ...m,
          acceptedMask: m.acceptedMask || (m.cards ? m.cards.map(() => true) : []),
          confirmedMask: m.confirmedMask || (m.cards ? m.cards.map(() => false) : []),
          streaming: false,
        }));
        syncChatHistoryMeta(cs);
        saveChatDraft();
      }
    } else if (msg.type === 'chat-ready') {
      cs.chatReadySeen = true;
      for (const m of cs.messages) {
        if (m.streaming) m.streaming = false;
      }
      if (tab) tab.status = 'done';
      notifyObjectiveStatusChanged();
      repaint();
    } else if (msg.type === 'task-cards') {
      const lastAssistant = [...cs.messages].reverse().find(m => m.role === 'assistant');
      if (lastAssistant) {
        const lastAssistantIdx = cs.messages.lastIndexOf(lastAssistant);
        const confirmedIds = _getConfirmedTaskIds(cs, lastAssistantIdx);
        const filtered = msg.cards.filter(c => !confirmedIds.has(c.task.id));
        lastAssistant.cards = filtered;
        // (TPT15) see buildInitialAcceptedMask() call above — same out-of-subtree guard.
        lastAssistant.acceptedMask = buildInitialAcceptedMask(cs, filtered);
        lastAssistant.confirmedMask = filtered.map(() => false);
        lastAssistant.filesAddressed = msg.filesAddressed || [];
        lastAssistant.docUpdates = msg.docUpdates || [];
        // C1439: the server already sends newTags/objectiveSummary on this frame
        // (claude-session.js + the 3 provider mirrors) but this handler never read
        // them — cards become savable the moment this frame lands, so a user who
        // Accepts before `exit` fires saved with no new_tags at all (exit is where
        // these were previously assigned, too late for an early Accept).
        lastAssistant.newTags = Array.isArray(msg.newTags) ? msg.newTags : [];
        lastAssistant.objectiveSummary = msg.objectiveSummary || null;
        if (msg.timingMilestones) lastAssistant.timingMilestones = msg.timingMilestones;
        cs.pendingCardsUpdate = false;
        if (filtered.length > 0) {
          cs.retryable = false;
          cs.lastParseError = null;
          lastAssistant.streaming = false;
          if (tab) tab.status = 'done';
          notifyObjectiveCardsReady(lastAssistant, filtered.length, wsTabId);
        }
        saveChatState();
        saveChatDraft();
        // C1158: this was fire-and-forget (no repaint after hydration resolved) — the
        // only snapshot call site missing it (cards-update below already has the
        // .then(...) pattern). A modified card's blank first paint (title/description
        // still undefined pre-hydration) used to survive until some unrelated reload.
        ensureExistingSnapshot(lastAssistant).then(() => { if (!lastAssistant.streaming) repaint(); });
        if (!lastAssistant.streaming) repaint();
      }
    } else if (msg.type === 'generation-aborted') {
      // Pop the partial assistant message (streaming)
      if (cs.messages.length > 0) {
        const last = cs.messages[cs.messages.length - 1];
        if (last.role === 'assistant' && last.streaming) cs.messages.pop();
      }
      // Pop the user message that triggered the aborted turn
      if (cs.messages.length > 0) {
        const last = cs.messages[cs.messages.length - 1];
        if (last.role === 'user') cs.messages.pop();
      }

      if (cs.messages.length === 0) {
        // First-message abort — tear down this tab inline (avoids cleanupChat nulling wrong chatState)
        // The tab disappears, so its socket must too: `kill` makes the server drop the session
        // (abort alone keeps it alive for a follow-up nobody can send any more).
        if (cs.ws) {
          const sock = cs.ws;
          cs.ws = null;
          if (sock.readyState === WebSocket.OPEN) {
            try { sock.send(JSON.stringify({ type: 'kill' })); } catch {}
          }
          try { sock.close(); } catch {}
        }
        if (cs.term) { cs.term.dispose(); cs.term = null; }
        if (cs.onResize) { window.removeEventListener('resize', cs.onResize); cs.onResize = null; }
        cs.fitAddon = null;
        const tabIdx = state.tabsState.findIndex(t => t.tabId === wsTabId);
        if (tabIdx !== -1) state.tabsState.splice(tabIdx, 1);
        syncDiscussLocks();
        const fallback = state.tabsState[state.tabsState.length - 1] || null;
        state.activeTabId = fallback ? fallback.tabId : null;
        state.chatState = fallback ? fallback.chatState : null;
        reload();
        const restoredInput = document.getElementById('chat-input');
        if (restoredInput && state.lastSentPrompt) {
          restoredInput.value = state.lastSentPrompt;
          autoGrowComposer(restoredInput);
        }
        return;
      }

      // Reset streaming state
      for (const m of cs.messages) {
        if (m.streaming) m.streaming = false;
      }
      cs.clientBuffer = '';
      cs.cleanContent = null;
      cs.processExited = false;
      cs.retryable = true;
      cs.pendingCardsUpdate = false;
      if (tab) tab.status = computeTabStatus(cs);
      notifyObjectiveStatusChanged();
      repaint();

      // Restore the saved prompt text into the textarea (active tab only)
      if (isActiveTab) {
        const restoredInput = document.getElementById('chat-input');
        if (restoredInput && state.lastSentPrompt) {
          restoredInput.value = state.lastSentPrompt;
          autoGrowComposer(restoredInput);
        }
      }
    } else if (msg.type === 'restarted') {
      // Server reset to original prompt and re-spawned Claude
      cs.messages = [
        { role: 'user', content: cs.originalUserText, cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: false, timestamp: Date.now() },
        { role: 'assistant', content: '', cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: true, timestamp: Date.now() },
      ];
      cs.clientBuffer = '';
      cs.cleanContent = null;
      cs.processExited = false;
      cs.retryable = false;
      cs.pendingCardsUpdate = false;
      cs.chatReadySeen = false;
      cs.allChanges = [];
      cs.historyWindowStart = 1;
      cs.historyTotalCount = 2;
      cs.hasOlderHistory = false;
      syncChatHistoryMeta(cs);
      if (cs.term) {
        cs.term.clear();
        cs.term.write('\x1b[90m--- Restarted ---\x1b[0m\r\n');
        (cs.termScroll ?? cs.term.scrollToBottom.bind(cs.term))();
      }
      if (tab) tab.status = 'streaming';
      notifyObjectiveStatusChanged();
      repaint();
    } else if (msg.type === 'context-trimmed') {
      cs.messages.push({
        role: 'system',
        content: `Context trimmed to ${msg.messagesKept} messages for optimal performance.`,
        cards: [], acceptedMask: [], confirmedMask: [],
        discarded: false, streaming: false, timestamp: Date.now(),
      });
      // C1255 — routed through the log now (was a one-off cs.term.write) so it survives a
      // console close/reopen instead of only appearing if the console happened to be open.
      appendProgressLog(cs, { kind: 'note', text: `context trimmed (${msg.messagesKept} messages kept)` });
      repaint();
    } else if (msg.type === 'cards-update') {
      // Deferred efficiency hint cards appended after turn delivery (C371).
      // msg.turnIndex identifies the assistant message; msg.cards is the full replacement array.
      const targetMsg = cs.messages[msg.turnIndex];
      if (!targetMsg || targetMsg.role !== 'assistant') return;
      const targetIdx = msg.turnIndex;
      const confirmedIds = _getConfirmedTaskIds(cs, targetIdx);
      const filtered = (msg.cards || []).filter(c => !confirmedIds.has(c.task && c.task.id));
      filtered.forEach(c => { if (c.task && !c.task.tags) c.task.tags = []; });
      targetMsg.cards = filtered;
      // (TPT15) see buildInitialAcceptedMask() call above — same out-of-subtree guard.
      targetMsg.acceptedMask = buildInitialAcceptedMask(cs, filtered);
      targetMsg.confirmedMask = filtered.map(() => false);
      cs.pendingCardsUpdate = false;
      if (filtered.length > 0) {
        cs.retryable = false;
        cs.lastParseError = null;
      }
      saveChatState();
      saveChatDraft();
      ensureExistingSnapshot(targetMsg).then(() => { if (tab) tab.status = computeTabStatus(cs); if (isActiveTab) reload(); else renderTabBarOnly(); });
    }
  };

  ws.onclose = () => {
    // Route via taskId, not state.chatState (user may have switched tabs)
    const t = state.tabsState.find(t => t.tabId === taskId);
    const cs = t ? t.chatState : null;
    if (!cs) return;
    if (cs.ws !== ws) return; // superseded by a newer socket
    const isActive = state.activeTabId === taskId;
    const isStreaming = cs.messages.some(m => m.streaming);
    const midTurn = isStreaming || !cs.processExited;
    if (!midTurn) return;

    // Attempt auto-reconnect with bounded budget (500 + 1000 + 2000 = 3.5s total).
    // Server keeps the session alive and replays chat-history + any pending result.
    const attempts = (cs._reconnectAttempts || 0);
    const MAX_RECONNECT_ATTEMPTS = 3;
    if (attempts < MAX_RECONNECT_ATTEMPTS) {
      cs._reconnectAttempts = attempts + 1;
      const delay = 500 * Math.pow(2, attempts);
      // Surface the reconnect attempt so the user isn't staring at a frozen bubble.
      if (attempts === 0) {
        cs.messages.push({
          role: 'system', content: 'Connection lost — reconnecting…',
          cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: false, timestamp: Date.now(),
        });
        if (isActive) reload();
      }
      setTimeout(() => {
        const tNow = state.tabsState.find(t => t.tabId === taskId);
        if (!tNow || tNow.chatState !== cs) return; // tab was replaced
        fetchWithRetry(`/api/objective/session?taskId=${encodeURIComponent(taskId)}`, { timeoutMs: 5000, retries: 1, headers: projectHeader(), label: 'objective-session-probe-reconnect' })
          .then(r => r.ok ? r.json() : null)
          .then(info => {
            // Closed/replaced while the probe was in flight — an orphan socket would cancel the
            // server's detach teardown and keep the session (and its prewarm) alive.
            if (!_tabOwnsChat(taskId, cs)) return;
            if (!info || !info.exists) throw new Error('no session');
            connectObjectiveWS(taskId, null, { reconnect: true });
          })
          .catch(() => {
            for (const m of cs.messages) { if (m.streaming) m.streaming = false; }
            cs.retryable = true;
            cs.messages.push({
              role: 'system', content: 'Connection lost unexpectedly. Retry or refine your prompt.',
              cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: false, timestamp: Date.now(),
            });
            if (t) t.status = 'error';
            if (isActive) reload(); else renderTabBarOnly();
          });
      }, delay);
      return;
    }

    for (const m of cs.messages) { if (m.streaming) m.streaming = false; }
    cs.retryable = true;
    cs.messages.push({
      role: 'system', content: 'Connection lost unexpectedly.',
      cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: false, timestamp: Date.now(),
    });
    if (t) t.status = 'error';
    if (isActive) reload(); else renderTabBarOnly();
  };
}

// ── Send follow-up chat message ──
export async function sendChatMessage(userText) {
  if (!state.chatState) return;
  clearObjectiveReadyMemory(state.chatState.taskId);

  // Gather unsaved prior card proposals for context
  const unsavedCards = [];
  for (const msg of state.chatState.messages) {
    if (!msg.cards || msg.cards.length === 0) continue;
    const confirmed = msg.confirmedMask || [];
    for (let i = 0; i < msg.cards.length; i++) {
      if (!confirmed[i]) unsavedCards.push(msg.cards[i]);
    }
  }

  // Add user message to local state
  state.chatState.messages.push({
    role: 'user', content: userText, cards: [], acceptedMask: [], confirmedMask: [],
    discarded: false, streaming: false, timestamp: Date.now(),
  });

  // Reset streaming state
  state.chatState.clientBuffer = '';
  state.chatState.cleanContent = null;
  state.chatState.processExited = false;
  state.chatState.retryable = false;
  state.chatState.lastParseError = null;
  state.chatState.chatReadySeen = false;

  // Add empty assistant message for streaming
  state.chatState.messages.push({
    role: 'assistant', content: '', cards: [], acceptedMask: [], confirmedMask: [],
    discarded: false, streaming: true, timestamp: Date.now(),
  });

  clearDraft(getObjectiveDraftKey());
  syncChatHistoryMeta(state.chatState);
  state.chatState.shouldScrollToBottom = true;
  reload();
  saveChatDraft();

  // If WS is open: send follow-up over existing session (--resume path, no full context re-send)
  const ws = state.chatState.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Build compact follow-up: user text + any unsaved proposals so Claude knows pending state
    let content = userText;
    if (unsavedCards.length > 0) {
      content += `\n\nUnsaved proposals from previous turn (still pending):\n\`\`\`json\n${JSON.stringify({ changes: unsavedCards }, null, 2)}\n\`\`\`\n\nRevise or extend accordingly. Respond with ONLY a \`\`\`json code block.`;
    } else {
      content += '\n\nRespond with ONLY a ```json code block.';
    }
    ws.send(JSON.stringify({ type: 'chat', content, ...rehashPayload(state.chatState), tabId: state.chatState.taskId, model: effectiveObjectiveModel() }));
    return;
  }

  // Fallback: WS closed — start a new session with full context
  const originalText = state.chatState.originalUserText;
  clearActiveTab();
  const { systemPrompt: fbSystemPrompt, userPrompt: fbUserPrompt } = buildObjectivePrompt(
    originalText,
    unsavedCards.length > 0 ? unsavedCards : null, userText,
    { groupingEnabled: getObjectiveGroupingEnabled(), originTaskKey: tabOriginTaskKey() }
  );
  startChat(fbUserPrompt, userText, fbSystemPrompt);
}

// ── Auth-expiry: pause streaming tabs; auto-resume on auth:refreshed ──

window.addEventListener('auth:expired', () => {
  for (const tab of state.tabsState) {
    const cs = tab.chatState;
    if (!cs) continue;
    const isActive = cs.messages.some(m => m.streaming) || (!cs.processExited && !cs.retryable);
    if (isActive) cs._authStalled = true;
  }
});

window.addEventListener('auth:refreshed', () => {
  for (const tab of state.tabsState) {
    const cs = tab.chatState;
    if (!cs || !cs._authStalled) continue;
    cs._authStalled = false;
    if (!cs.retryable) continue;
    // Auto-retry the stalled turn
    const originalText = cs.originalUserText;
    const ws = cs.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      cs.messages = [
        { role: 'user', content: originalText, cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: false, timestamp: Date.now() },
        { role: 'assistant', content: '', cards: [], acceptedMask: [], confirmedMask: [], discarded: false, streaming: true, timestamp: Date.now() },
      ];
      cs.clientBuffer = '';
      cs.cleanContent = null;
      cs.processExited = false;
      cs.retryable = false;
      cs.chatReadySeen = false;
      cs.allChanges = [];
      cs.historyWindowStart = 1;
      cs.historyTotalCount = 2;
      cs.hasOlderHistory = false;
      syncChatHistoryMeta(cs);
      ws.send(JSON.stringify({ type: 'restart', ...rehashPayload(cs), tabId: cs.taskId, model: cs.objectiveModel || state.objectiveModel || null }));
    } else {
      const { systemPrompt: rs_sp, userPrompt: rs_up } = buildObjectivePrompt(originalText, null, null, { groupingEnabled: getObjectiveGroupingEnabled(), originTaskKey: tabOriginTaskKey() });
      const wasActiveTab = state.activeTabId === tab.tabId;
      if (wasActiveTab) state.chatState = null;
      tab.chatState = null;
      tab.status = 'idle';
      const freshId = `obj-${Date.now()}`;
      tab.tabId = freshId;
      if (wasActiveTab) { state.activeTabId = freshId; state.chatState = null; }
      startChat(rs_up, originalText, rs_sp);
    }
    if (state.activeTabId === tab.tabId) reload();
  }
});

window.addEventListener('auth:cancelled', () => {
  for (const tab of state.tabsState) {
    const cs = tab.chatState;
    if (!cs || !cs._authStalled) continue;
    cs._authStalled = false;
    for (const m of cs.messages) { if (m.streaming) m.streaming = false; }
    cs.processExited = true;
    cs.retryable = false;
    cs.messages.push({
      role: 'system',
      content: 'Session expired — please sign in to continue.',
      cards: [], acceptedMask: [], confirmedMask: [],
      discarded: false, streaming: false, timestamp: Date.now(),
    });
    if (state.activeTabId === tab.tabId) reload();
  }
});
