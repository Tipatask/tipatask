// ── Console modal — xterm.js terminal overlay ──
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import state from './state.js';
import { XTERM_THEME, MAX_DESC_LEN, CHAT_STATE_KEY, DRAFT_KEY_OBJECTIVE, LAST_PROMPT_KEY, modelLabel } from './constants.js';
import { escapeAttr, projectHeader, fetchWithRetry, shortModelName, clearDraft } from './utils.js';
import { buildWsUrl, startTerminalSession, terminateTaskSession } from './ws-client.js';
import { updateClaudeButtons, syncActiveSessionsNav } from './task-board.js';
import { showActionConfirm } from './action-confirm.js';
import { dismissNotification } from './notification-center.js';
import { objectiveTag, clearDebounce } from './notifications.js';
import { forgetTaskAttention } from './attention-notifications.js';
import { createVoiceRecorder, voiceShortcutLabel, MIC_SVG } from './audio-recorder.js';
import { t } from './i18n.js';
import { isInProgressName, isClosedName, isCompleteName, inProgressName, loadStatuses } from './status-registry.js';
import { replayProgressLog, progressStatusLine } from './objective-progress-log.js';
import { getAgentDisplayLabel } from './agent-select.js';
import { clearAttention, mergeSessionsSnapshot } from './attention-state.js';
import { _isPinnedToBottom, createTerminalOutputWriter } from './terminal-output.js';

const CONSOLE_STATUS_TICK_MS = 500;
// (TPT19) How long cleanupChat() blocks state.cleanupInProgress (below) and, separately, how
// long it waits before re-persisting a surviving tab's draft (chatPersistEpoch, not this
// window, is what actually prevents an orphaned write from resurrecting a purged file — see
// state.js). Kept as one named constant so the guard and the delayed re-persist can't drift.
const CHAT_CLEANUP_GUARD_MS = 500;

// Shared close guard for terminal sessions. Completed tasks only have a lingering process
// to clean up, so they can be terminated without prompting; every other status requires an
// explicit confirmation before session teardown starts. The optional taskId keeps the
// localized prompt useful for both the modal and the left-nav entry point.
// (C1458) Split into a sync predicate + an async requester (mirrors task-board.js's
// closeTaskEditModal(force)/requestCloseTaskEditModal() split, C1392) — the predicate lets
// a completed-task fast path skip the dialog with no microtask hop, and the rename off
// "confirmSessionClose" is deliberate: task-board.js reaches this through the bridge
// (window.TipTask?.confirmSessionClose?.(...), C1223, to avoid an import cycle) using
// optional chaining, so a caller that missed this refactor now gets undefined → the guard
// returns early → no kill happens (fail-safe) instead of a stale sync confirmSessionClose
// name being wrapped, which would have let native confirm()'s blocking-freeze bug back in.
export function sessionCloseNeedsConfirm(taskStatus, taskId = '') {
  const currentStatus = taskId && state.taskStatusById?.get(taskId) || taskStatus;
  return !isCompleteName(currentStatus);
}

export async function requestSessionClose(taskStatus, taskId = '') {
  if (!sessionCloseNeedsConfirm(taskStatus, taskId)) return true;
  const key = taskId || state.activeTerminal?.taskId || t('nav.currentSession');
  return showActionConfirm({
    message: t('nav.confirmTerminateSession', { key: escapeAttr(key) }),
    confirmLabel: t('btn.terminate'),
    danger: true,
    overlayClass: 'modal-overlay--over-terminal',
  });
}

const _CLAUDE_AGENT_SVG = `<svg class="agent-logo" viewBox="0 0 248 248" width="20" height="20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z"/></svg>`;
const _CODEX_AGENT_SVG = `<svg class="agent-logo" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" shape-rendering="geometricPrecision"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>`;
const _HUMAN_AGENT_SVG = `<svg class="agent-logo" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg>`;
// (C1122) Pi glyph — a lowercase π, filled, same 24x24/currentColor contract as the SVGs
// above. Previously fell through to _HUMAN_AGENT_SVG, which reads wrong once the agent
// selector can render up to 8 Pi buttons (8 human silhouettes).
const _PI_AGENT_SVG = `<svg class="agent-logo" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 7h16v2.2h-2.6l-.9 9.4a1.6 1.6 0 0 1-3.18-.16l.68-9.24H9.9l-.7 9.3a1.6 1.6 0 0 1-3.18-.18l.68-9.12H4V7z"/></svg>`;
const _detachedCodexTerminals = new Map();

function _wsCanStayAttached(ws) {
  return ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
}

function _isCodexTerminal(terminal) {
  return terminal && (terminal.taskAgent === 'codex' || terminal.planApprovalCommand === null);
}

function _canShowPlanReadyDialog(terminal) {
  return terminal && (terminal.taskAgent !== 'codex' || terminal.codexPlanReady === true);
}

function _agentSelectorIcon(id) {
  if (id === 'claude') return _CLAUDE_AGENT_SVG;
  if (id === 'codex') return _CODEX_AGENT_SVG;
  if (id === 'pi') return _PI_AGENT_SVG;
  return _HUMAN_AGENT_SVG;
}

// (C1115) Live per-project configured model for a provider — same value pi-agent.js's
// resolveSpawnModel() would spawn with, sourced from state.objectiveProviders (populated
// from GET /api/objective/providers or the WS config frame, both project-scoped).
function _providerDefaultModel(id) {
  const p = (state.objectiveProviders || []).find((x) => x.id === id);
  return (p && p.defaultModel) || '';
}

// (C1122) Every Pi model this PROJECT has configured (ids only, apiKeys never leave the
// server) — separate from _providerDefaultModel()'s single row 0. Empty until the
// project has a PI_MODELS array; the agent-selector modal falls back to the single
// default-model button in that case (pre-C1121 project, or hydration hasn't landed yet).
function _piConfiguredModels() {
  const p = (state.objectiveProviders || []).find((x) => x.id === 'pi');
  return (p && p.configuredModels) || [];
}

// (C1279) `availableAgents` reports machine-level CLI availability, which is not enough
// for Pi: the project must also have a model + credential configured. The provider registry
// exposes that project-scoped answer as `selectable`; keep the configuredModels fallback for
// older provider payloads that predate that flag. An absent provider snapshot is deliberately
// treated as unknown/unusable until the late-hydration fetch below resolves.
function _isPiProviderUsable() {
  const p = (state.objectiveProviders || []).find((x) => x.id === 'pi');
  if (!p) return false;
  if (typeof p.selectable === 'boolean') return p.selectable;
  return Array.isArray(p.configuredModels) && p.configuredModels.length > 0;
}

// (C1133) shortModelName moved to utils.js so task-board.js can share it too.
const _shortModelName = shortModelName;

// (C1118) Friendly display name for a resolved model id — same labels as the settings/
// task-edit dropdowns (constants.js modelLabel()), with the "(default)" suffix those lists
// use stripped (it's meaningful in a dropdown, not in a terminal header). Falls back to
// _shortModelName() for ids not in the list (e.g. a custom Pi "Other Model" id).
function _modelDisplayName(agentId, model) {
  if (!model) return '';
  const label = modelLabel(agentId, model);
  if (label && label !== model) return label.replace(/\s*\(default\)$/, '');
  return _shortModelName(model);
}

// (C1118) Terminal header caption for an agent+model pair — decided format:
// pi: model name alone (Pi's whole point is the user-chosen model); claude/codex: "<agent
// label> · <model>"; no resolved model yet (e.g. Codex with no configured default): agent
// label alone, no dangling separator.
function _agentCaption(agentId, agentLabel, model) {
  const label = agentLabel || 'Claude Code';
  if (!model) return label;
  const displayModel = _modelDisplayName(agentId, model);
  return agentId === 'pi' ? displayModel : `${label} · ${displayModel}`;
}

function reload() {
  document.dispatchEvent(new Event('tiptask:reload'));
}

// (C1184, shared registry as of C1187) Fires the terminal session-start "advance to
// in_progress" PATCH. Fail-open: a status-registry fetch failure must never delay or
// block session start — status-registry.js's loadStatuses() never throws and degrades to
// the legacy role names on its own, so no local try/catch is needed here for that part.
async function maybeAdvanceToInProgress(taskId, currentStatus) {
  if (!currentStatus) return;
  await loadStatuses(); // usually already resolved (loaded at boot) — no round trip then
  if (isInProgressName(currentStatus)) return;
  // isClosedName covers both the complete role and the canceled role (C1187) — collapses
  // what used to be two separate checks (in_progress-role / complete-role / literal
  // 'canceled') into one.
  if (isClosedName(currentStatus)) return;
  try {
    await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: inProgressName() }),
    });
    reload();
  } catch { /* ignore — same fire-and-forget discipline as before C1184 */ }
}

function applyTaskAgentConfig(msg) {
  if (msg.taskAgent) state.taskAgent = msg.taskAgent;
  if (msg.taskAgentLabel) state.taskAgentLabel = msg.taskAgentLabel;
  if (msg.agentLabels && typeof msg.agentLabels === 'object' && !Array.isArray(msg.agentLabels)) {
    state.agentLabels = msg.agentLabels;
  }
  if ('planApprovalCommand' in msg) state.planApprovalCommand = msg.planApprovalCommand;
  if (msg.supportsPlanMode !== undefined) state.supportsPlanMode = msg.supportsPlanMode;
  if (Array.isArray(msg.availableAgents)) state.availableAgents = msg.availableAgents;
  if (Array.isArray(msg.agentStatuses)) state.agentStatuses = msg.agentStatuses;
}

export function agentNotice(text) {
  const existing = document.getElementById('agent-notice-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'agent-notice-toast';
  el.className = 'agent-notice-toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ── Objective debug console ──

export function openObjectiveConsole() {
  if (!state.chatState) return;

  const overlay = document.createElement('div');
  overlay.className = 'terminal-overlay';
  overlay.id = 'objective-console';
  overlay.innerHTML = `
    <div class="terminal-container">
      <div class="terminal-header">
        <span class="task-label">Debug Console</span>
        <span class="status-dot" title="Connected"></span>
        <div class="terminal-header-actions">
          <button class="btn-terminate-terminal">${escapeAttr(t('btn.terminate'))}</button>
          <button class="btn-close-terminal">${escapeAttr(t('btn.close'))}</button>
        </div>
      </div>
      <div class="terminal-body"></div>
      <div class="objective-console-status" id="objective-console-status"></div>
    </div>`;
  document.body.appendChild(overlay);

  const termBody = overlay.querySelector('.terminal-body');
  const statusBar = overlay.querySelector('#objective-console-status');

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, monospace',
    theme: XTERM_THEME,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  function _objMaybeScroll() {
    if (_isPinnedToBottom(term)) term.scrollToBottom();
  }
  term.open(termBody);
  requestAnimationFrame(() => {
    fitAddon.fit();
    requestAnimationFrame(() => {
      // C1255 — replay the buffered progress log (spawned/cli-init/tool/thinking/…) first, so a
      // console opened mid-turn shows everything that happened before it was opened, not a dead
      // static line. Falls back to a single dim placeholder only when there's truly nothing yet.
      if (state.chatState) replayProgressLog(term, state.chatState);
      if (state.chatState && state.chatState.clientBuffer) {
        term.write(state.chatState.clientBuffer);
      } else if (state.chatState && !state.chatState.processExited &&
                 !(state.chatState.progressLog && state.chatState.progressLog.length)) {
        term.write('\x1b[90mwaiting for first signal…\x1b[0m\r\n');
      }
      if (state.chatState) {
        state.chatState.term = term;
        state.chatState.termScroll = _objMaybeScroll;
      }
      _objMaybeScroll();
    });
  });

  state.chatState.fitAddon = fitAddon;

  // C1255 — live status bar: current stage / elapsed / time since last signal. Ticks
  // independently of WS frames so a stalled turn visibly shows its "since last signal" climb.
  function _renderConsoleStatus() {
    if (!statusBar) return;
    const cs = state.chatState;
    if (!cs || cs.processExited) {
      if (statusBar) statusBar.textContent = cs && cs.processExited ? t('console.processExited') : '';
      return;
    }
    const status = progressStatusLine(cs);
    if (!status || !status.stage) {
      statusBar.textContent = t('console.waiting');
      return;
    }
    const parts = [status.stage];
    if (status.elapsedMs != null) parts.push(t('console.elapsed', { s: (status.elapsedMs / 1000).toFixed(1) }));
    if (status.sinceLastSignalMs != null) parts.push(t('console.lastSignal', { s: (status.sinceLastSignalMs / 1000).toFixed(1) }));
    statusBar.textContent = parts.join(' · ');
  }
  _renderConsoleStatus();
  state.chatState._consoleTicker = setInterval(_renderConsoleStatus, CONSOLE_STATUS_TICK_MS);

  term.onData((data) => {
    if (state.chatState && state.chatState.ws && state.chatState.ws.readyState === WebSocket.OPEN) {
      state.chatState.ws.send(JSON.stringify({ type: 'data', data }));
    }
  });

  let lastEscTime = 0;
  term.attachCustomKeyEventHandler((e) => {
    if (e.key === 'Escape' && e.type === 'keydown') {
      const now = Date.now();
      if (state.chatState && state.chatState.processExited) {
        closeConsoleIfOpen();
        return false;
      }
      if (now - lastEscTime < 400) {
        lastEscTime = 0;
        closeConsoleIfOpen();
        return false;
      }
      lastEscTime = now;
      if (state.chatState && state.chatState.ws && state.chatState.ws.readyState === WebSocket.OPEN) {
        state.chatState.ws.send(JSON.stringify({ type: 'data', data: '\x1b' }));
      }
      return false;
    }
    return true;
  });

  const onResize = () => {
    fitAddon.fit();
    if (state.chatState && state.chatState.ws && state.chatState.ws.readyState === WebSocket.OPEN) {
      state.chatState.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };
  window.addEventListener('resize', onResize);
  state.chatState.onResize = onResize;

  overlay.querySelector('.btn-close-terminal').addEventListener('click', () => {
    closeConsoleIfOpen();
  });

  overlay.querySelector('.btn-terminate-terminal').addEventListener('click', async () => {
    // (C1458) Non-blocking confirm — agent-neutral wording (this console is shared by
    // every agent, not just Claude), previously hard-coded English with no i18n key.
    if (!(await showActionConfirm({
      message: t('nav.confirmTerminateProcess'),
      confirmLabel: t('btn.terminate'),
      danger: true,
      overlayClass: 'modal-overlay--over-terminal',
    }))) return;
    closeConsoleIfOpen();
    cleanupChat();
    reload();
  });

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) {
      closeConsoleIfOpen();
    }
  });
}

export function closeConsoleIfOpen() {
  if (!state.chatState) return;
  if (state.chatState._consoleTicker) {
    clearInterval(state.chatState._consoleTicker);
    state.chatState._consoleTicker = null;
  }
  if (state.chatState.term) {
    state.chatState.term.dispose();
    state.chatState.term = null;
    state.chatState.termScroll = null;
  }
  if (state.chatState.onResize) {
    window.removeEventListener('resize', state.chatState.onResize);
    state.chatState.onResize = null;
  }
  state.chatState.fitAddon = null;
  const el = document.getElementById('objective-console');
  if (el) el.remove();
}

// (TPT19) `force: true` purges persistence unconditionally, regardless of whether `cs` is
// currently the visibly-active chatState — see the split below. Needed because a mid-save
// tab-switch can leave `cs !== state.chatState` AND leave the closed tab not the active one
// either, silently skipping the purge branch entirely before this option existed.
export function cleanupChat(targetCs, { force = false } = {}) {
  const cs = targetCs || state.chatState;
  if (!cs) return;
  state.cleanupInProgress = true;
  setTimeout(() => { state.cleanupInProgress = false; }, CHAT_CLEANUP_GUARD_MS);
  if (cs.ws) {
    if (cs.ws.readyState === WebSocket.OPEN) {
      cs.ws.send(JSON.stringify({ type: 'kill' }));
      cs.ws.close();
    } else if (cs.ws.readyState === WebSocket.CONNECTING) {
      cs.ws.close();
    }
  }
  // Dispose xterm/resize/status-ticker for the target session regardless of which tab is active.
  if (cs._consoleTicker) { clearInterval(cs._consoleTicker); cs._consoleTicker = null; }
  if (cs.term) { cs.term.dispose(); cs.term = null; cs.termScroll = null; }
  if (cs.onResize) { window.removeEventListener('resize', cs.onResize); cs.onResize = null; }
  cs.fitAddon = null;
  // Only remove the console DOM overlay when tearing down the currently-visible session.
  if (cs === state.chatState) {
    const el = document.getElementById('objective-console');
    if (el) el.remove();
  }
  // Locate the owning tab by chatState identity so a mid-save tab-switch does not
  // accidentally remove the wrong (active) tab from the bar.
  const idx = state.tabsState.findIndex(t => t.chatState === cs);
  const removedWasActive = idx !== -1 && state.tabsState[idx].tabId === state.activeTabId;
  const goneTabId = idx !== -1 ? state.tabsState[idx].tabId : null; // captured before splice, for the draft-key clear below
  // (C1156) Destroyed tab's "Objective complete" card + debounce/click-handler entry — same
  // pair closeTab() drops (C1073/C1137). cleanupChat() is the teardown funnel every close route
  // (New-Objective btn, Terminate confirm, save-and-close-tab) uses; loadAndRender()'s C1154
  // guard can't reach this — by render time activeTabId already points elsewhere (or null).
  if (idx !== -1) {
    const goneTag = objectiveTag(goneTabId);
    clearDebounce(goneTag);
    dismissNotification(goneTag);
  }
  if (idx !== -1) state.tabsState.splice(idx, 1);
  // (TPT19) Two independent concerns the pre-force code conflated into one condition:
  // persistence purging (safe and correct to do unconditionally under `force`, since the
  // whole chat is finalized regardless of which tab happens to be visible) vs. active-tab
  // re-pointing (must stay scoped to "this WAS the visible tab" — forcing it unconditionally
  // would teleport the user off a tab they deliberately switched to mid-save).
  const wasActive = cs === state.chatState || removedWasActive;
  if (force || wasActive) {
    // Bumped BEFORE the DELETEs so any saveChatDraft()/saveChatState() write already
    // in-flight from this finalized chat is disowned by the epoch check in chat-ui.js —
    // see state.js's chatPersistEpoch comment. This is the actual fix for the
    // resurrection bug; CHAT_CLEANUP_GUARD_MS above is not what prevents it.
    state.chatPersistEpoch++;
    try { sessionStorage.removeItem(CHAT_STATE_KEY); } catch {}
    // chat-draft is per-tab client-side (getObjectiveDraftKey(), utils.js) even though the
    // server file behind it is one-per-project — clear both this tab's keyed draft and the
    // bare fallback key a null activeTabId would have used.
    if (goneTabId) clearDraft(`${DRAFT_KEY_OBJECTIVE}-${goneTabId}`);
    clearDraft(DRAFT_KEY_OBJECTIVE);
    if (force) clearDraft(LAST_PROMPT_KEY);
    fetchWithRetry('/api/chat-state', { method: 'DELETE', headers: projectHeader(), retries: 1, timeoutMs: 5000, label: 'chat-state-delete' }).catch(() => {});
    fetchWithRetry('/api/objective/chat-draft', { method: 'DELETE', headers: projectHeader(), retries: 1, timeoutMs: 5000, label: 'chat-draft-delete' }).catch(() => {});
  }
  if (wasActive) {
    state.chatState = null;
    const next = state.tabsState[0] || null;
    state.activeTabId = next ? next.tabId : null;
    if (next) state.chatState = next.chatState;
  }
  // (TPT20) Re-persist the surviving tab's draft/state — moved OUT of the `wasActive` branch
  // above. chat-draft/chat-state are one file PER PROJECT, so ANY purge (force or wasActive)
  // deletes the persistence of whatever chat is still on screen, including a force:true purge
  // from closing a BACKGROUND tab — there wasActive is false and nothing gets re-pointed, yet
  // the files just DELETEd belonged to the still-visible active tab. Before this fix that case
  // silently dropped the survivor's own history (closeTab() didn't force-purge background tabs
  // pre-TPT20, so the gap was latent). Delayed past the cleanupInProgress window (via an event,
  // not a direct import, to avoid a chat-ui.js <-> console-modal.js cycle — see chat-ui.js's
  // ensureGlobalChatBindings()).
  if ((force || wasActive) && state.chatState) {
    setTimeout(() => {
      document.dispatchEvent(new CustomEvent('tiptask:chat-persist-purged'));
    }, CHAT_CLEANUP_GUARD_MS + 50);
  }
}

// ── Terminal overlay with persistent sessions ──

export async function fetchActiveSessions() {
  try {
    const res = await fetch('/api/sessions');
    // (C1387) Merge, never wholesale-replace — a snapshot must not silently drop an
    // attention-needed frame that landed while this request was in flight, nor resurrect a
    // flag the user already dismissed by opening the terminal. See attention-state.js.
    if (res.ok) mergeSessionsSnapshot(await res.json());
  } catch { /* ignore */ }
}

export function showClaudeConfirmModal(taskId, title, desc, taskStatus, opts = {}) {
  const agentLabel = escapeAttr(state.taskAgentLabel || 'selected agent');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <p>Task <strong>${escapeAttr(taskId)}</strong> is already completed. Start a new ${agentLabel} session anyway?</p>
      <div class="modal-buttons">
        <button class="btn-cancel">Cancel</button>
        <button class="btn-confirm">Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('.btn-cancel').addEventListener('click', () => {
    state.pendingRestoreContext = null;
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      state.pendingRestoreContext = null;
      overlay.remove();
    }
  });
  overlay.querySelector('.btn-confirm').addEventListener('click', () => {
    overlay.remove();
    openTerminal(taskId, title, desc, taskStatus, opts);
  });
}

function buildTaskSessionPrompt(taskId, title, desc, opts = {}) {
  // (TPT345) Verbatim kickoff override — only caller is merge-branches-modal.js's "Resolve
  // with agent", which hands the server-built conflict-resolution prompt to a task terminal.
  if (typeof opts.prompt === 'string' && opts.prompt.trim()) return opts.prompt;
  const rawDesc = String(desc || '');
  const isObjective = String(taskId || '').startsWith('obj-');
  const truncDesc = rawDesc.length > MAX_DESC_LEN
    ? rawDesc.slice(0, MAX_DESC_LEN) + '... (truncated)'
    : rawDesc;
  return opts.discussionMode
    ? `Task: ${title}\n${truncDesc}\n\nThis is a HUMAN task. Wait for the user's questions — do not start implementing anything.`
    : isObjective ? truncDesc : `Work on task ${taskId}: ${title}. ${truncDesc}`;
}

function buildTaskSessionWsExtra(taskId, title, desc, opts = {}) {
  const isResume = state.activeSessions.has(taskId);
  const wsExtra = isResume ? (opts.agent ? { agent: opts.agent } : null) : { prompt: buildTaskSessionPrompt(taskId, title, desc, opts) };
  if (wsExtra && opts.planOnly) wsExtra.planOnly = '1';
  if (wsExtra && opts.agent) wsExtra.agent = opts.agent;
  if (wsExtra && opts.model) wsExtra.model = opts.model; // C1122 — Pi launch-time model pick
  if (wsExtra && opts.discussionMode) wsExtra.discussion = '1';
  return wsExtra;
}

export function startTaskSession(taskId, title, desc, taskStatus, opts = {}) {
  const wsExtra = buildTaskSessionWsExtra(taskId, title, desc, opts);
  return startTerminalSession(taskId, wsExtra, { timeoutMs: opts.timeoutMs || 15000 }).then((result) => {
    if (result.ok) {
      if (result.message) applyTaskAgentConfig(result.message);
      state.activeSessions.add(taskId);
      state.exitedSessions.delete(taskId);
      clearAttention(taskId, 'opened'); // a fresh launch has nothing pending to be attentive about
      // (C1144) Known immediately from launch opts — no need to wait on a /api/sessions refetch
      // for the left-nav row's icon to be correct.
      state.sessionMeta.set(taskId, { agent: opts.agent || state.taskAgent, label: state.taskAgentLabel, type: 'terminal', alive: true });
      const card = document.querySelector(`.card[data-id="${CSS.escape(taskId)}"]`);
      if (card) card.classList.remove('needs-attention');
      updateClaudeButtons();
    } else {
      state.activeSessions.delete(taskId);
      state.exitedSessions.delete(taskId);
      clearAttention(taskId, 'session-ended');
      updateClaudeButtons();
    }
    return result;
  });
}

// (C1387) The one complete "user has seen it" clear — every place openTerminal() decides the
// user is now looking at this task's terminal must go through here, not just the main open
// path. Missing details/ledger cleanup or a nav repaint on the two early-return paths below
// (already-open refocus, detached-Codex reattach) was the reported "left-nav lags behind the
// card" desync.
function _markAttentionSeen(taskId) {
  clearAttention(taskId, 'opened'); // flag + details + snapshot-resurrection suppression
  forgetTaskAttention(taskId); // "already told the user" notification ledger
  dismissNotification(taskId); // (C1146) in-app notification card
  const card = document.querySelector(`.card[data-id="${CSS.escape(taskId)}"]`);
  if (card) card.classList.remove('needs-attention'); // immediate paint, no wait for the sweep below
  syncActiveSessionsNav(); // repaints every card's ring (attention-state.js sweep) + the nav row
}

export function openTerminal(taskId, title, desc, taskStatus, opts = {}) {
  function captureOpenContext() {
    return state.pendingRestoreContext || {
      scrollY: window.scrollY,
      cardId: state.selectedCardId,
      cardMode: state.expandedCardMode === 'pinned' ? 'pinned' : null,
    };
  }

  if (state.activeTerminal) {
    if (state.activeTerminal.taskId === taskId) {
      _markAttentionSeen(taskId); // (C1387) refocusing an already-open terminal counts as seen
      state.activeTerminal.refresh?.({ send: true, focus: true });
      return;
    }
    // Different task (notification click, card Start/Resume) — minimize the irrelevant
    // terminal, keeping its process alive server-side, then fall through and open ours.
    state.activeTerminal.detach?.({ refreshBoard: false });
  }

  const detachedCodex = _detachedCodexTerminals.get(taskId);
  if (detachedCodex && _isCodexTerminal(detachedCodex) && detachedCodex.processRunning && _wsCanStayAttached(detachedCodex.ws)) {
    _markAttentionSeen(taskId); // (C1387) reattaching a detached Codex terminal also counts as seen
    const restoredContext = captureOpenContext();
    state.pendingRestoreContext = restoredContext;
    detachedCodex.reattach?.(restoredContext);
    return;
  }
  if (detachedCodex) {
    detachedCodex.dispose?.();
    _detachedCodexTerminals.delete(taskId);
  }

  const isResume = state.activeSessions.has(taskId);
  _markAttentionSeen(taskId); // (C1387) the single, complete clear trigger
  const terminalOpenContext = captureOpenContext();
  state.pendingRestoreContext = terminalOpenContext;
  const isObjective = taskId.startsWith('obj-');
  // (C1118) Seed the initial caption with the resolved model where it's already known
  // client-side (pi's project-scoped default, same value the agent-selector card shows,
  // C1115) so there's no flash of the bare agent label; claude/codex wait for terminal-state
  // (their objectiveProviders.defaultModel is the global config value and could briefly show
  // a model the project/task overrides).
  const initialAgentId = opts.agent || state.taskAgent;
  const initialAgentLabel = state.taskAgentLabel || 'Claude Code';
  const initialModel = initialAgentId === 'pi' ? _providerDefaultModel('pi') : '';
  const discussionSuffix = opts.discussionMode ? ' · Discussion' : '';

  // (TPT309) Board-card hierarchy: key chip (.id-badge look) → title (.card-title look) → muted
  // agent chip. Parts are separated by the flex gap on .task-label, not by inline text, so there
  // is no leading/trailing space for the flex-item edge-collapse to eat (C1342). The agent dot
  // takes only the `agent-badge--{id}` colour modifier — never the absolutely-positioned
  // `.agent-badge` base class the board cards query.
  function renderTaskLabel(agentId, caption) {
    if (isObjective) return 'New Objective';
    const safeTaskId = escapeAttr(taskId);
    const safeTitle = escapeAttr(title || '');
    const dotAgent = ['claude', 'codex', 'pi'].includes(agentId) ? agentId : 'human';
    const safeCaption = escapeAttr(`${caption}${discussionSuffix}`);
    return `<span class="terminal-task-key">${safeTaskId}</span><span class="terminal-task-title" title="${safeTitle}">${safeTitle}</span><span class="terminal-task-caption" title="${safeCaption}"><span class="terminal-agent-dot agent-badge--${dotAgent}" aria-hidden="true">${_agentSelectorIcon(dotAgent)}</span><span class="terminal-task-caption-text">${escapeAttr(caption)}${discussionSuffix}</span></span>`;
  }

  // Build DOM
  // (C1262) Icon-only mic button — title alone isn't a real accessible name, aria-label mirrors
  // it. createVoiceRecorder() re-labels both attrs the instant the mic registers below
  // (_applyVoiceAvailability()), this is belt-and-braces for the render gap before that runs.
  const voiceBtnLabel = escapeAttr(t('voice.record', { shortcut: voiceShortcutLabel() }));
  const overlay = document.createElement('div');
  // (TPT360) `--task` offsets the overlay by the left-nav width (styles.css) so the rail's
  // active-session rows stay clickable while a terminal is open.
  overlay.className = 'terminal-overlay terminal-overlay--task';
  overlay.innerHTML = `
    <div class="terminal-container">
      <div class="terminal-header">
        <span class="task-label">${renderTaskLabel(initialAgentId, _agentCaption(initialAgentId, initialAgentLabel, initialModel))}</span>
        <span class="status-dot" title="Connected"></span>
        <div class="terminal-header-actions">
          ${isObjective ? '' : `<button class="btn-show-task" type="button">${escapeAttr(t('terminal.showTask'))}</button>`}
          <button class="terminal-voice-btn" type="button" title="${voiceBtnLabel}" aria-label="${voiceBtnLabel}">${MIC_SVG(14)}</button>
          <button class="btn-terminate-terminal">${escapeAttr(t('btn.terminate'))}</button>
          <button class="btn-close-terminal">${escapeAttr(t('terminal.minimize'))}</button>
        </div>
      </div>
      <div class="terminal-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const termBody = overlay.querySelector('.terminal-body');
  const taskLabelEl = overlay.querySelector('.task-label');
  const statusDot = overlay.querySelector('.status-dot');
  const showTaskBtn = overlay.querySelector('.btn-show-task');
  const closeBtn = overlay.querySelector('.btn-close-terminal');
  const terminateBtn = overlay.querySelector('.btn-terminate-terminal');

  showTaskBtn?.addEventListener('click', () => {
    const navigate = window.TipTask?.openTaskEditModal;
    detachTerminal({ refreshBoard: false });
    if (typeof navigate !== 'function') {
      console.warn('[terminal] task edit navigation bridge unavailable');
      return;
    }
    Promise.resolve(navigate(taskId)).catch((err) => {
      console.error('[terminal] task edit navigation failed', err);
    });
  });

  // (C1118) lastKnownAgentId/lastKnownModel persist across calls so the model-less `config`
  // frame (agent/label only) can't clobber a caption already populated by `terminal-state`.
  let lastKnownAgentId = initialAgentId;
  let lastKnownModel = initialModel;
  function updateTaskLabel({ agent, label, model } = {}) {
    if (agent) lastKnownAgentId = agent;
    if (model !== undefined) lastKnownModel = model || '';
    const safeAgentLabel = label || state.taskAgentLabel || 'Claude Code';
    taskLabelEl.innerHTML = renderTaskLabel(lastKnownAgentId, _agentCaption(lastKnownAgentId, safeAgentLabel, lastKnownModel));
  }

  // Init xterm.js
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, monospace',
    theme: XTERM_THEME,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  let processRunning = true;
  let terminalPhase = 'planning';
  let terminalOpened = false;
  let terminalClosing = false;
  let terminalDisposed = false;
  let terminationInFlight = false;
  let viewportListenersAttached = false;
  let openRaf = 0;
  // Connect WebSocket — include prompt only for new sessions
  let firstReplayCleared = !isResume;
  let firstResumeDataSeen = !isResume;
  let firstResumeDataWritten = !isResume;
  let codexResumeRedrawSent = !isResume;
  let pendingPlanReady = false;
  let terminalPlanApprovalCommand = isResume ? undefined : state.planApprovalCommand;
  let terminalPlanApprovalCommandKnown = !isResume;
  let terminalCodexPlanReady = false;
  let wheelHandler = null;
  let outputWriter = null;
  const wsExtra = buildTaskSessionWsExtra(taskId, title, desc, opts);
  let ws = null;

  function wsIsOpen() {
    return ws && ws.readyState === WebSocket.OPEN;
  }

  // Voice input (tt-audio-input): transcript is sent over the same `type: 'data'` frame as
  // keystrokes/paste — it lands in the agent's input line, the user presses Enter to submit.
  // No mic on the read-only objective debug console (openObjectiveConsole).
  const voiceBtn = overlay.querySelector('.terminal-voice-btn');
  // (C1185) onFinal only — never onPartial. A PTY has no cursor-relative "replace the partial
  // span" operation like a text field does (see createLiveInserter in utils.js); the only way
  // to show a growing partial in a terminal would be to erase-and-retype with backspace bytes,
  // which breaks the instant the agent's own output/line-wrapping touches that row. Finalized
  // turns land as whole-utterance data frames instead, same shape as the batch onTranscript
  // fallback below, just delivered incrementally per utterance instead of once at the end.
  const voiceRecorder = voiceBtn ? createVoiceRecorder({
    button: voiceBtn,
    iconSize: 14,
    onTranscript: text => {
      if (wsIsOpen()) ws.send(JSON.stringify({ type: 'data', data: text }));
    },
    onFinal: text => {
      if (wsIsOpen()) ws.send(JSON.stringify({ type: 'data', data: `${text} ` }));
    },
    onError: msg => term.write(`\r\n\x1b[31m[voice: ${msg}]\x1b[0m\r\n`),
  }) : null;
  if (voiceRecorder) {
    voiceBtn.addEventListener('click', () => voiceRecorder.toggle());
    overlay.__voiceRecorder = voiceRecorder;
  }

  function sendResize() {
    if (!wsIsOpen()) return;
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }

  function maybeScrollToBottom() {
    if (_isPinnedToBottom(term)) term.scrollToBottom();
  }

  function refreshTerminalViewport({ send = false } = {}) {
    if (!terminalOpened || terminalClosing) return;
    fitAddon.fit();
    maybeScrollToBottom();
    if (term.rows > 0) term.refresh(0, term.rows - 1);
    if (send) sendResize();
  }

  function scheduleTerminalRefresh(opts = {}) {
    requestAnimationFrame(() => refreshTerminalViewport(opts));
  }

  function setCodexPlanReady(value) {
    terminalCodexPlanReady = value === true;
    terminalController.codexPlanReady = terminalCodexPlanReady;
    if (state.activeTerminal === terminalController) {
      state.activeTerminal.codexPlanReady = terminalCodexPlanReady;
    }
    if (!terminalCodexPlanReady) {
      const existing = overlay.querySelector('.plan-ready-dialog');
      if (existing) {
        existing.remove();
        scheduleTerminalRefresh({ send: true });
      }
    }
  }

  function applyCodexPlanReady(msg) {
    if ('codexPlanReady' in msg && (msg.taskAgent || terminalController.taskAgent) === 'codex') {
      setCodexPlanReady(msg.codexPlanReady);
    }
  }

  function fitAndSendResize() {
    refreshTerminalViewport({ send: true });
  }

  function scheduleCodexTerminalRedraw() {
    setTimeout(() => {
      if (_isCodexTerminal(terminalController) && wsIsOpen()) {
        ws.send(JSON.stringify({ type: 'data', data: '\x0c' }));
      }
    }, 200);
  }

  function maybeSendCodexResumeRedraw() {
    if (!isResume || codexResumeRedrawSent || !firstResumeDataWritten) return;
    if (!terminalPlanApprovalCommandKnown || terminalPlanApprovalCommand || !wsIsOpen()) return;
    if (terminalPhase === 'planning' || terminalCodexPlanReady) return;
    ws.send(JSON.stringify({ type: 'data', data: '\x0c' }));
    codexResumeRedrawSent = true;
  }

  function showPlanReadyDialog() {
    if (!_canShowPlanReadyDialog(terminalController)) return;
    if (overlay.querySelector('.plan-ready-dialog')) return;
    const dlg = document.createElement('div');
    dlg.className = 'plan-ready-dialog';
    dlg.innerHTML = `
      <div class="plan-ready-text">Agent has a plan ready. Proceed with implementation?</div>
      <div class="plan-ready-actions">
        <button class="btn-plan-discard">Discard</button>
        <button class="btn-plan-proceed">Proceed with Implementation</button>
      </div>`;
    overlay.querySelector('.terminal-container').appendChild(dlg);
    dlg.querySelector('.btn-plan-proceed').addEventListener('click', () => {
      if (wsIsOpen()) ws.send(JSON.stringify({ type: 'plan-approve' }));
      setCodexPlanReady(false);
    });
    dlg.querySelector('.btn-plan-discard').addEventListener('click', () => {
      dlg.remove();
      terminateSession();
    });
    scheduleTerminalRefresh({ send: true });
  }

  async function openAuthSettings() {
    try {
      let projectPath, config;
      if (window.electronAPI?.api?.project?.config) {
        const ctx = await window.electronAPI.api.project.config();
        projectPath = ctx.projectPath;
        config = ctx.config;
      } else {
        const res = await fetch('/api/project-config');
        if (!res.ok) return;
        ({ projectPath, config } = await res.json());
      }
      window.TipTask?.setupModal?.openReauth({
        projectPath,
        existingConfig: config || {},
        onComplete: () => {},
        onCancel: () => {},
      });
    } catch { /* ignore */ }
  }

  function removeMcpAuthDialog() {
    const existing = overlay.querySelector('[data-mcp-auth]');
    if (existing) {
      existing.remove();
      scheduleTerminalRefresh({ send: true });
    }
  }

  function showMcpAuthDialog(authState) {
    if (overlay.querySelector('[data-mcp-auth]')) return;
    const isInitial = authState === 'initial';
    const body = isInitial
      ? 'No API token configured — run initial setup to connect.'
      : 'Your API token is invalid or expired — please re-authenticate.';
    const dlg = document.createElement('div');
    dlg.className = 'mcp-auth-overlay';
    dlg.dataset.mcpAuth = authState || 'reauth';
    dlg.innerHTML = `
      <div class="mcp-auth-dialog">
        <div class="mcp-auth-title">Session not authenticated</div>
        <div class="mcp-auth-body">${body}</div>
        <div class="mcp-auth-actions">
          <button class="btn-mcp-auth-dismiss">Dismiss</button>
          <button class="btn-mcp-auth-settings">Open Settings</button>
        </div>
      </div>`;
    termBody.appendChild(dlg);
    dlg.querySelector('.btn-mcp-auth-dismiss').addEventListener('click', () => {
      removeMcpAuthDialog();
    });
    dlg.querySelector('.btn-mcp-auth-settings').addEventListener('click', () => {
      openAuthSettings();
    });
    scheduleTerminalRefresh({ send: true });
  }

  function connectWebSocket() {
    ws = new WebSocket(buildWsUrl(taskId, wsExtra));
    terminalController.ws = ws;

    ws.onopen = () => {
      if (terminalClosing) return;
      statusDot.className = 'status-dot';
      statusDot.title = 'Connected';
      fitAndSendResize();
      ws.send(JSON.stringify({ type: 'session-status' }));
      // (C1356) Tell the server this client is now actually looking at the terminal, so a
      // still-open TUI prompt can be re-raised (not permanently deduped) if the user leaves
      // without answering — see the local _markAttentionSeen(taskId) call above (C1387) and
      // the server-side attention-seen handler (ws-handlers.js) for the full reasoning.
      ws.send(JSON.stringify({ type: 'attention-seen' }));
      state.activeSessions.add(taskId);
      // (C1144) Known immediately — no need to wait on a /api/sessions refetch for the
      // left-nav row's icon to be correct.
      state.sessionMeta.set(taskId, { agent: opts.agent || state.taskAgent, label: state.taskAgentLabel, type: 'terminal', alive: true });
      updateClaudeButtons();

      // Auto-set → in_progress role for new sessions (skip for plan-only and discussion
      // launches). C1184: was a literal `taskStatus === 'pending' || 'on_fire'` gate;
      // now advances unless the task is already closed (complete or canceled role, C1187)
      // or already at the in_progress role — on a default project that is exactly
      // pending ✓, on_fire ✓, in_progress ✗, completed ✗, canceled ✗, same behavior as before.
      if (!isResume && !opts.planOnly && !opts.discussionMode) {
        void maybeAdvanceToInProgress(taskId, taskStatus);
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'config') {
        state.showAiStats = msg.showAiStats;
        applyTaskAgentConfig(msg);
        if (!isResume && 'planApprovalCommand' in msg) {
          terminalPlanApprovalCommand = msg.planApprovalCommand;
          terminalPlanApprovalCommandKnown = true;
        }
        updateTaskLabel({ label: state.taskAgentLabel });
        maybeSendCodexResumeRedraw();
      } else if (msg.type === 'terminal-state') {
        applyTaskAgentConfig(msg);
        applyCodexPlanReady(msg);
        if ('planApprovalCommand' in msg) {
          terminalPlanApprovalCommand = msg.planApprovalCommand;
          terminalPlanApprovalCommandKnown = true;
        }
        terminalPhase = msg.phase || terminalPhase;
        updateTaskLabel({ agent: msg.taskAgent, label: msg.taskAgentLabel || state.taskAgentLabel, model: msg.taskAgentModel });
        statusDot.title = terminalPhase === 'planning'
          ? (state.planApprovalCommand
              ? `Planning — type ${state.planApprovalCommand} to continue`
              : 'Planning — awaiting approval dialog')
          : 'Executing';
        terminalController.phase = terminalPhase;
        terminalController.taskAgentLabel = state.taskAgentLabel;
        terminalController.taskAgentModel = msg.taskAgentModel || ''; // (C1118) parity with taskAgentLabel
        terminalController.taskAgent = msg.taskAgent || terminalController.taskAgent;
        terminalController.planApprovalCommand = terminalPlanApprovalCommand;
        terminalController.codexPlanReady = terminalCodexPlanReady;
        maybeSendCodexResumeRedraw();
      } else if (msg.type === 'data') {
        const isFirstResumeData = isResume && !firstResumeDataSeen;
        if (isFirstResumeData) firstResumeDataSeen = true;
        if (!firstReplayCleared) {
          firstReplayCleared = true;
          term.clear();
        }
        outputWriter.write(msg.data, () => {
          if (isFirstResumeData) {
            firstResumeDataWritten = true;
            // Repaints the local xterm canvas over the replayed buffer. Pairs with the
            // server's forceResumeRepaint() resize wobble (terminal-session.js, C966),
            // which makes the agent TUI itself re-emit a fresh frame instead of relying
            // on stale replayed content.
            scheduleTerminalRefresh({ send: true });
            maybeSendCodexResumeRedraw();
            if (pendingPlanReady) {
              pendingPlanReady = false;
              showPlanReadyDialog();
            }
          }
        });
      } else if (msg.type === 'exit') {
        processRunning = false;
        setCodexPlanReady(false);
        statusDot.className = 'status-dot exited';
        if (msg.reason === 'runaway-killed') {
          // (TPT357) The descendant-process watchdog ended this session — say so, in red,
          // instead of the generic "Process exited (code N)" line (the code is just the
          // SIGTERM/SIGKILL exit and says nothing about why).
          const runawayLine = `${t('terminal.runawayKilled')}${msg.reasonText ? ` — ${msg.reasonText}` : ''}`;
          statusDot.title = runawayLine;
          term.write(`\r\n\x1b[31m--- ${runawayLine} ---\x1b[0m\r\n`);
        } else {
          statusDot.title = `Exited (code ${msg.code})`;
          term.write(`\r\n\x1b[90m--- Process exited (code ${msg.code}) ---\x1b[0m\r\n`);
        }
        term.scrollToBottom();
        if (state.showAiStats && msg.tokens) {
          const t = msg.tokens;
          const costStr = t.costUsd > 0 ? ` · $${t.costUsd >= 0.01 ? t.costUsd.toFixed(2) : t.costUsd.toFixed(4)}` : '';
          const footer = document.createElement('div');
          footer.className = 'terminal-footer';
          footer.textContent = `Tokens: ${t.input.toLocaleString()} in / ${t.output.toLocaleString()} out${costStr}`;
          overlay.querySelector('.terminal-container').appendChild(footer);
        }
        // (C1356) A process exit is exactly when the agent's task most often just went
        // `completed` (interactive TUIs don't otherwise exit on their own, C982) — this
        // branch used to leave state.taskStatusById/the left-nav row completely
        // unrefreshed until something else repainted (modal close, an unrelated re-render).
        // updateClaudeButtons() re-syncs from the still-mounted card's own status if the
        // board rendered it; tiptask:sync-nav-statuses (template.html) force-fetches this
        // session's real task status from the server regardless, so a completion lands on
        // the tick even with the modal still open and even if the card isn't mounted.
        updateClaudeButtons();
        document.dispatchEvent(new Event('tiptask:sync-nav-statuses'));
      } else if (msg.type === 'error') {
        processRunning = false;
        setCodexPlanReady(false);
        statusDot.className = 'status-dot disconnected';
        statusDot.title = 'Error';
        term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
        term.scrollToBottom();
        clearTaskSessionState();
      } else if (msg.type === 'session-ended' && (!msg.taskId || msg.taskId === taskId)) {
        processRunning = false;
        setCodexPlanReady(false);
        removeMcpAuthDialog();
        clearTaskSessionState();
        if (!terminationInFlight) finishTerminalEnded();
      } else if (msg.type === 'detached') {
        // Another client took over — just close our UI
        detachTerminal({ persistCodex: false });
      } else if (msg.type === 'plan-ready') {
        applyCodexPlanReady(msg);
        if (!_canShowPlanReadyDialog(terminalController)) return;
        if (isResume && !firstResumeDataWritten) {
          pendingPlanReady = true;
          return;
        }
        showPlanReadyDialog();
      } else if (msg.type === 'paste-image-done') {
        // No-op: Claude Code renders its own native [Image #N] placeholder once
        // the bracketed-paste path lands (C1003) — a client-side write here would
        // draw stray text over Claude's alt-screen input box.
      } else if (msg.type === 'paste-image-error') {
        term.write(`\r\n\x1b[31m[image paste failed: ${msg.error}]\x1b[0m\r\n`);
      } else if (msg.type === 'mcp-auth-failure') {
        showMcpAuthDialog(msg.authState);
      }
    };

    ws.onclose = () => {
      // Only show disconnected if the process was still running and this terminal is
      // still the visible one (not detached/minimized, and not swapped out by another
      // terminal taking over state.activeTerminal).
      if (processRunning && state.activeTerminal === terminalController) {
        statusDot.className = 'status-dot disconnected';
        statusDot.title = 'Disconnected';
      }
      if (terminalController.detached && !_wsCanStayAttached(ws)) {
        _detachedCodexTerminals.delete(taskId);
        disposeTerminal();
      }
    };

    ws.onerror = () => {
      statusDot.className = 'status-dot disconnected';
      statusDot.title = 'Connection error';
    };
  }

  // Terminal → Server
  term.onData((data) => {
    if (wsIsOpen()) {
      ws.send(JSON.stringify({ type: 'data', data }));
    }
  });

  let lastEscTime = 0;
  term.attachCustomKeyEventHandler((e) => {
    if (e.key === 'Escape' && e.type === 'keydown') {
      const now = Date.now();
      if (!processRunning) {
        detachTerminal();
        return false;
      }
      if (now - lastEscTime < 400) {
        lastEscTime = 0;
        detachTerminal();
        return false;
      }
      lastEscTime = now;
      if (wsIsOpen()) {
        ws.send(JSON.stringify({ type: 'data', data: '\x1b' }));
      }
      return false;
    }
    return true;
  });

  // Resize handling
  const onResize = () => {
    fitAndSendResize();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      fitAndSendResize();
      scheduleCodexTerminalRedraw();
    }
  };

  // (TPT360) The task overlay's width now follows the left-nav rail (200px / 56px collapsed /
  // 56px on narrow viewports), and the rail collapse animates over 0.2s — a window `resize`
  // event alone never sees that. Observe the terminal body itself and refit once the size has
  // settled (trailing debounce, so the animation yields one fit instead of a PTY-resize storm).
  // Only sends `resize` to the PTY when cols/rows actually changed.
  let bodyResizeObserver = null;
  let bodyResizeTimer = 0;
  function fitIfSizeChanged() {
    if (!terminalOpened || terminalClosing || terminalDisposed) return;
    const { cols, rows } = term;
    refreshTerminalViewport();
    if (term.cols !== cols || term.rows !== rows) sendResize();
  }
  function scheduleBodyRefit() {
    clearTimeout(bodyResizeTimer);
    bodyResizeTimer = setTimeout(() => { bodyResizeTimer = 0; fitIfSizeChanged(); }, 120);
  }

  function attachViewportListeners() {
    if (viewportListenersAttached) return;
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (typeof ResizeObserver === 'function') {
      bodyResizeObserver = new ResizeObserver(scheduleBodyRefit);
      bodyResizeObserver.observe(termBody);
    }
    viewportListenersAttached = true;
  }

  function detachViewportListeners() {
    if (!viewportListenersAttached) return;
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (bodyResizeObserver) { bodyResizeObserver.disconnect(); bodyResizeObserver = null; }
    clearTimeout(bodyResizeTimer);
    bodyResizeTimer = 0;
    viewportListenersAttached = false;
  }

  function focusTerminalWithoutScrollJump() {
    const scrollY = window.scrollY;
    term.focus();
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
  }

  function disposeTerminal() {
    if (terminalDisposed) return;
    terminalDisposed = true;
    outputWriter?.dispose();
    if (wheelHandler && term.element) {
      try { term.element.removeEventListener('wheel', wheelHandler); } catch { /* ignore */ }
    }
    wheelHandler = null;
    if (terminalController._pasteHandler && term.element) {
      try { term.element.removeEventListener('paste', terminalController._pasteHandler, true); } catch { /* ignore */ }
    }
    terminalController._pasteHandler = null;
    try { term.dispose(); } catch { /* ignore */ }
  }

  function closeTerminalSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
  }

  function clearTaskSessionState() {
    state.activeSessions.delete(taskId);
    state.exitedSessions.delete(taskId);
    clearAttention(taskId, 'session-ended');
    state.sessionMeta.delete(taskId); // (C1144)
    const card = document.querySelector(`.card[data-id="${CSS.escape(taskId)}"]`);
    if (card) card.classList.remove('needs-attention', 'has-active-session');
    updateClaudeButtons();
  }

  function finishTerminalEnded() {
    terminalClosing = true;
    terminationInFlight = false;
    if (openRaf) {
      cancelAnimationFrame(openRaf);
      openRaf = 0;
    }
    detachViewportListeners();
    _detachedCodexTerminals.delete(taskId);
    if (voiceRecorder) voiceRecorder.stop();
    closeTerminalSocket();
    disposeTerminal();
    document.body.style.overflow = '';
    overlay.remove();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (state.activeTerminal === terminalController) state.activeTerminal = null;
    clearTaskSessionState();
    // Re-assert restore context in case a modal cancel nulled it between openTerminal and now
    if (!state.pendingRestoreContext) state.pendingRestoreContext = terminalOpenContext;
    // (C1306) Completion and terminal teardown can land close together. Refresh both sources:
    // /api/sessions reconciles every left-nav session row, while tiptask:reload invalidates the
    // board cache and fetches authoritative task statuses. Either request may finish first;
    // both paths end in updateClaudeButtons(), so the final sidebar paint is consistent.
    fetchActiveSessions().then(updateClaudeButtons);
    reload();
    // (C1356) This session's own row is already gone (clearTaskSessionState() above), but
    // any OTHER still-active session's status may be equally stale — force an authoritative
    // resync so teardown doesn't just fix the row that ended.
    document.dispatchEvent(new Event('tiptask:sync-nav-statuses'));
  }

  function reattachTerminal(restoredContext = terminalOpenContext) {
    terminalClosing = false;
    terminalController.detached = false;
    _detachedCodexTerminals.delete(taskId);
    state.activeTerminal = terminalController;
    state.pendingRestoreContext = restoredContext;
    // (C1144) This minimize→reopen path changes which console is "open" but previously never
    // repainted — the left-nav active-sessions row would keep highlighting the wrong session.
    updateClaudeButtons();
    // (C1356) Force a real status refetch for THIS session's row on reattach — the task's
    // own status may have gone stale while detached (sprint-window backfill preserves the
    // last-known value rather than refreshing it; see tt-task-board.md § C1329), so "close
    // and reopen the terminal" alone didn't previously guarantee an up-to-date tick.
    document.dispatchEvent(new Event('tiptask:sync-nav-statuses'));
    if (!overlay.isConnected) document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    attachViewportListeners();
    scheduleTerminalRefresh({ send: true });
    requestAnimationFrame(() => {
      refreshTerminalViewport({ send: true });
      focusTerminalWithoutScrollJump();
    });
  }

  attachViewportListeners();

  const terminalController = {
    taskId,
    overlay,
    term,
    ws,
    onResize,
    phase: terminalPhase,
    taskAgentLabel: state.taskAgentLabel,
    taskAgentModel: initialModel, // (C1118) parity with taskAgentLabel; kept current by terminal-state
    taskAgent: opts.agent || state.taskAgent,
    planApprovalCommand: terminalPlanApprovalCommand,
    codexPlanReady: terminalCodexPlanReady,
    detached: false,
    refresh({ send = false, focus = false } = {}) {
      scheduleTerminalRefresh({ send });
      if (focus) requestAnimationFrame(focusTerminalWithoutScrollJump);
    },
    reattach: reattachTerminal,
    dispose: disposeTerminal,
    detach: detachTerminal,
    get processRunning() { return processRunning; },
  };
  state.activeTerminal = terminalController;

  openRaf = requestAnimationFrame(() => {
    openRaf = 0;
    if (terminalClosing) return;
    term.open(termBody);
    outputWriter = createTerminalOutputWriter(term);
    terminalOpened = true;
    refreshTerminalViewport();
    // Trap wheel scroll inside xterm: prevent page scroll at top/bottom boundaries.
    wheelHandler = (e) => {
      const vp = term.element && term.element.querySelector('.xterm-viewport');
      if (!vp) return;
      const atTop = vp.scrollTop === 0;
      const atBottom = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 1;
      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) e.preventDefault();
    };
    term.element.addEventListener('wheel', wheelHandler, { passive: false });
    terminalController._wheelHandler = wheelHandler;
    // Paste a clipboard image → upload + inject @localpath into the PTY (agent vision input).
    // Registered on CAPTURE phase (C1051): xterm.js's own paste listener sits on the focused
    // .xterm-helper-textarea (a descendant of term.element) and calls e.stopPropagation() as
    // the first line of its handler, so a bubble-phase listener on term.element never used to
    // fire at all — this was the actual root cause of "paste does nothing" (injectPastedImage()
    // on the server was never even reached). A capture-phase listener on the ancestor runs
    // before xterm's target-phase listener, so it always sees the event.
    const pasteHandler = (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imgItem = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
      if (!imgItem) return; // not an image → let xterm handle normal text paste
      // An image is present — consume the event fully (preventDefault + stopPropagation) so
      // xterm's own handler never also processes it. Left unconsumed, xterm would read the
      // (empty, image-only) text/plain clipboard data and write a bare bracketed paste to the
      // PTY, which is itself a native-clipboard-read trigger for some agents (Claude Code
      // C1003) — racing/duplicating the explicit upload below.
      e.preventDefault();
      e.stopPropagation();
      const file = imgItem.getAsFile();
      if (!file) { term.write('\r\n\x1b[31m[image paste failed: clipboard unreadable]\x1b[0m\r\n'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        if (!wsIsOpen()) { term.write('\r\n\x1b[31m[image paste failed: not connected]\x1b[0m\r\n'); return; }
        const data = String(reader.result).split(',')[1] || '';
        if (!data) { term.write('\r\n\x1b[31m[image paste failed: empty data]\x1b[0m\r\n'); return; }
        // No "uploading…" cosmetic write — paste→inject is near-instant and Claude
        // Code renders its own native [Image #N] placeholder once it lands (C1003).
        ws.send(JSON.stringify({ type: 'paste-image', mimeType: file.type, data }));
      };
      reader.onerror = () => term.write('\r\n\x1b[31m[image read failed]\x1b[0m\r\n');
      reader.readAsDataURL(file);
    };
    term.element.addEventListener('paste', pasteHandler, true);
    terminalController._pasteHandler = pasteHandler;
    if (!isResume && wsExtra) {
      wsExtra.cols = term.cols;
      wsExtra.rows = term.rows;
    }
    connectWebSocket();

    const scrollY = window.scrollY;
    focusTerminalWithoutScrollJump();
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
    if (isResume) scheduleTerminalRefresh();
  });

  // Minimize — detach UI, keep process alive on server
  function detachTerminal({ persistCodex = true, refreshBoard = true } = {}) {
    terminalClosing = true;
    if (openRaf) {
      cancelAnimationFrame(openRaf);
      openRaf = 0;
    }
    detachViewportListeners();
    if (voiceRecorder) voiceRecorder.stop();
    const keepCodexTerminal = persistCodex
      && processRunning
      && _isCodexTerminal(terminalController)
      && wsIsOpen()
      && !terminalDisposed;
    if (keepCodexTerminal) {
      terminalController.detached = true;
      _detachedCodexTerminals.set(taskId, terminalController);
    } else {
      _detachedCodexTerminals.delete(taskId);
      closeTerminalSocket();
      disposeTerminal();
    }
    removeMcpAuthDialog();
    document.body.style.overflow = '';
    overlay.remove();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (state.activeTerminal === terminalController) state.activeTerminal = null;
    state.pendingRestoreContext = terminalOpenContext;
    // Refresh button states — skipped during a notification/card-triggered swap (the incoming
    // terminal's own ws.onopen + eventual detach already refresh). (C1387) The resurrection
    // hazard this comment used to describe — an immediate fetch here seeing the outgoing task
    // still under `attention` and re-lighting a badge the swap-in terminal's open was about to
    // clear — can no longer happen: fetchActiveSessions() now merges through
    // attention-state.js's mergeSessionsSnapshot(), which only ever raises a flag the server
    // actually reports, and openTerminal()'s clearAttention(taskId, 'opened') suppresses
    // resurrection for a task the user has already seen. Left skipped anyway — no reason to
    // pay for an extra fetch mid-swap.
    if (refreshBoard) {
      fetchActiveSessions().then(updateClaudeButtons);
      reload();
      // (C1356) Force this session's own status refetch on minimize — the whole point of
      // "minimize, keep running in background" is that its status keeps changing with
      // nobody watching the terminal; the left-nav tick must not wait for the next 10s
      // poll tick or a manual board interaction to notice.
      document.dispatchEvent(new Event('tiptask:sync-nav-statuses'));
    }
  }

  // Terminate — kill the process, then close UI
  // (C1458) async: requestSessionClose() opens a non-blocking confirm. terminationInFlight
  // is set BEFORE the confirm (re-entrancy guard) — a native confirm() used to make a
  // second click impossible by blocking the event loop; an async one doesn't, so a second
  // click must be rejected explicitly, and cleared again if the user cancels.
  async function terminateSession() {
    if (terminationInFlight) return;
    terminationInFlight = true;
    if (!(await requestSessionClose(taskStatus, taskId))) {
      terminationInFlight = false;
      return;
    }
    terminalClosing = true;
    if (openRaf) {
      cancelAnimationFrame(openRaf);
      openRaf = 0;
    }
    clearAttention(taskId, 'session-ended');
    const _killCard = document.querySelector(`.card[data-id="${CSS.escape(taskId)}"]`);
    if (_killCard) _killCard.classList.remove('needs-attention');
    terminateTaskSession(taskId, { timeoutMs: 5000 }).then(() => finishTerminalEnded());
  }

  closeBtn.addEventListener('click', detachTerminal);
  terminateBtn.addEventListener('click', terminateSession);

  // (TPT360) The overlay box now starts at the left-nav rail's edge, so this backdrop-minimize
  // only ever fires for a click on the board-side backdrop — it can no longer swallow a click
  // meant for a rail row. Switching sessions from the rail goes through openTerminal()'s
  // mismatched-open path (detach the current terminal, keep its PTY alive, open the target).
  overlay.addEventListener('mousedown', (e) => {
    if (e.target !== overlay) return;
    e.preventDefault();
    e.stopPropagation();
    detachTerminal();
  });
}

// (C1122/C1279) One button per agent id, except 'pi': when the project has configured
// PI_MODELS rows, one button PER ROW (data-model carries the id so a click can request
// that exact model) instead of the single row-0 button C1115 rendered. Pi is omitted when
// its provider has no usable project configuration; while the provider snapshot is still
// loading, it stays omitted and the late-hydration block below can add it once confirmed.
//
// (C1131) state.taskAgent now carries the project's actual last-used default (server-
// resolved: LAST_AGENT > TASK_AGENT > global, see task-agent/index.js resolveTaskAgentId())
// rather than always the global startup snapshot, so it doubles as "the current default"
// here. The matching button renders first and gets an `--current` marker. For Pi, row 0 of
// _piConfiguredModels() IS the last-used model by construction — recordLastUsedAgent()
// (project-config.js) reorders PI_MODELS to put a used row at index 0 on every task start —
// so no separate "last-used Pi model" field is needed; only mark it current when the
// project's last-used AGENT was actually pi (state.taskAgent === 'pi'), else row 0 is just
// the configured default with no bearing on what last ran.
function _buildAgentSelectorButtons() {
  const ids = [...state.availableAgents].filter((id) => id !== 'pi' || _isPiProviderUsable());
  const currentIndex = ids.indexOf(state.taskAgent);
  if (currentIndex > 0) {
    const [currentAgent] = ids.splice(currentIndex, 1);
    ids.unshift(currentAgent);
  }
  return ids.map(id => {
    if (id === 'pi') {
      const configured = _piConfiguredModels();
      const piIsCurrent = state.taskAgent === 'pi';
      if (configured.length) {
        return configured.map((model, i) => {
          const current = piIsCurrent && i === 0;
          const cls = current ? ' agent-selector-btn--current' : '';
          const ariaAttr = current ? ' aria-current="true"' : '';
          return `<button class="agent-selector-btn${cls}" data-agent="pi" data-model="${escapeAttr(model)}" title="${escapeAttr(model)}"${ariaAttr}>${_agentSelectorIcon('pi')}<span class="agent-btn-label">${escapeAttr(_shortModelName(model))}</span></button>`;
        }).join('');
      }
      // (C1115) Pi's card names the actually-configured model, not the generic "Other
      // Model" label — full id kept in title= for the truncated cases. (C1136 rename —
      // was "Pi"/"Pi Coding Agent".)
      const piModel = _providerDefaultModel('pi');
      const label = piModel
        ? escapeAttr(_shortModelName(piModel))
        : escapeAttr(getAgentDisplayLabel('pi', state.agentLabels, state.agentStatuses));
      const titleAttr = piModel ? ` title="${escapeAttr(piModel)}"` : '';
      const cls = piIsCurrent ? ' agent-selector-btn--current' : '';
      const ariaAttr = piIsCurrent ? ' aria-current="true"' : '';
      return `<button class="agent-selector-btn${cls}" data-agent="pi"${titleAttr}${ariaAttr}>${_agentSelectorIcon('pi')}<span class="agent-btn-label">${label}</span></button>`;
    }
    const current = id === state.taskAgent;
    // C1285 — labels are keyed by agent id. `current` controls ordering/selection styling
    // only; it must never decide whether Claude is called "Claude" or "Claude Code".
    const label = escapeAttr(getAgentDisplayLabel(id, state.agentLabels, state.agentStatuses));
    const cls = current ? ' agent-selector-btn--current' : '';
    const ariaAttr = current ? ' aria-current="true"' : '';
    return `<button class="agent-selector-btn${cls}" data-agent="${escapeAttr(id)}"${ariaAttr}>${_agentSelectorIcon(id)}<span class="agent-btn-label">${label}</span></button>`;
  }).join('');
}

export function openAgentSelectorModal(taskId, title, desc, taskStatus, baseOpts = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'agent-selector-overlay';

  overlay.innerHTML = `
    <div class="agent-selector-card">
      <div class="agent-selector-title">Choose agent for this task</div>
      <div class="agent-selector-buttons">${_buildAgentSelectorButtons()}</div>
      <div class="agent-selector-remember">
        <label><input type="checkbox" class="agent-selector-remember-cb"> Remember for this session</label>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  function close() {
    state.pendingRestoreContext = null;
    overlay.remove();
  }

  function wireButtons() {
    overlay.querySelectorAll('.agent-selector-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const agentId = btn.dataset.agent;
        const model = btn.dataset.model || null;
        const remember = overlay.querySelector('.agent-selector-remember-cb').checked;
        if (remember) { state.sessionAgent = agentId; state.sessionAgentModel = model; }
        overlay.remove();
        openTerminal(taskId, title, desc, taskStatus, { ...baseOpts, agent: agentId, ...(model ? { model } : {}) });
      });
    });
  }
  wireButtons();

  // (C1115/C1122) Modal can open before the module-load /api/objective/providers fetch
  // (chat-ui.js) has landed — hydrate in place once it does, rather than leaving the
  // generic "Pi"/"Pi Coding Agent" label (or a single stale button) stuck for this
  // modal's lifetime. Re-render the whole button row (not just patch one label) since
  // the row shape itself (1 button vs N) depends on the fetch result.
  if (state.availableAgents.includes('pi') && !_piConfiguredModels().length) {
    fetchWithRetry('/api/objective/providers', { timeoutMs: 5000, retries: 1, headers: projectHeader(), label: 'agent-selector-providers' })
      .then(r => (r.ok ? r.json() : null))
      .then(payload => {
        if (payload && Array.isArray(payload.objectiveProviders)) state.objectiveProviders = payload.objectiveProviders;
        if (!overlay.isConnected) return;
        const buttonsEl = overlay.querySelector('.agent-selector-buttons');
        if (buttonsEl) buttonsEl.innerHTML = _buildAgentSelectorButtons();
        wireButtons();
      })
      .catch(() => {});
  }

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onEsc);
    }
  });
}
