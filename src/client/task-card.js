// ── Task Card rendering and interactions ──
import state from './state.js';
import { CHAIN_COLORS, MAX_DESC_LEN, HOURGLASS_SVG, EFFORT_LEVELS, EFFORT_LABELS } from './constants.js';
import { isTaskDiscussing, lockIntentOf, lockMessageKey } from './discuss-lock.js';
import {
  statusNames, statusLabel, statusColor, statusRoleToken,
  isActiveName, isClosedName, isStartName, isInProgressName, isCompleteName, isCanceledName,
  startName, inProgressName, completeName,
} from './status-registry.js';
import { escapeAttr, renderMarkdown, truncateMarkdownAtParagraph, renderTagBadge, shortModelName, computeTooltipAnchor, isRectClipped, pushSubtaskCrumb, showToast, projectHeader, markTruncatedCards } from './utils.js';
// (C1340) Aliased — renderCard()'s task-object param is itself named `t`, same
// collision chat-task-preview.js already works around this way.
import { t as translate } from './i18n.js';
import { startTerminalSession } from './ws-client.js';
import { showBulkAgentStartModal, terminateSessionFromCard, refreshParentSubtaskLabel, updateClaudeButtons } from './task-board.js';
import { agentNotice } from './console-modal.js';
import { groupTitle, getSprintsEnabled } from './group-label.js';
import { perfStart, perfEnd } from './perf-log.js';
import { buildSubtasksLabel } from './subtask-count.js';
import { attentionClass, isAttentionRaised, clearAttention } from './attention-state.js';
import { activityChipHtml, refreshActivityChip } from './task-activity.js';
import { MERGE_DOT, mergeButtonHtml, syncTaskMergeCard, initializeTaskMerge } from './task-merge.js';
import { isDragStateStale, resolveDropTier, shouldDeferForDrag } from './drag-state.js';
import { collectFamilyIds } from './related-cards.js';
import { HIDE_CLASS } from './sprint-tier-visibility.js';
import { cardVariant, cardMaxWidthPx, estimateTextWidth, TITLE_CHAR_PX } from './card-width.js';
import { hasUnmetDeps, unmetDependencyKeys, hasTaskSession, startBlockedByDeps } from './dependency-status.js';
import { expandedCardMaxHeight, clampExpandedTop, resolveAnchorTop } from './card-placement.js';
export { isDragStateStale, resolveDropTier, shouldDeferForDrag };
export { hasUnmetDeps, unmetDependencyKeys, hasTaskSession, startBlockedByDeps };
// (C1483) Shape check for "is this a real task key" (prefix+number or dashed epic form)
// vs a synthetic client id ('new'/'new-<ts>-<seq>'/'new-obj-...'). Server-side module,
// dependency-free CJS — safe to pull into the client bundle.
import { isTaskKeyLike } from '../server/task-key-format.js';

// ── Callback references (set once via registerCardCallbacks) ──
let _onLoadAndRender = null;
let _onOpenTerminal = null;
let _onOpenAgentSelectorModal = null;
let _onOpenAgentAssignModal = null;
let _onShowClaudeConfirmModal = null;
let _onShowConfirmModal = null;
let _onShowDeleteConfirmModal = null;
let _onUpdateBulkBar = null;
let _onShowReiterateModal = null;
let _onFetchActiveSessions = null;
let _onOpenTaskEditModal = null;
let _onOpenPreviewCardModal = null;

// ── Card button tooltips (C1568) ──
// Native `title=` is stuck at Chromium's own ~1s hover delay — can't be sped up via CSS,
// and stacks a second tooltip behind ours if left on the element. Reuses the same
// body-appended `position: fixed` pattern as the card-title tooltip (setupCardInteractions
// below), just with a much shorter delay and anchored below the button instead of the title.
let _btnTip = null;
let _btnTipTimer = null;
let _btnTipBound = false;
const BTN_TIP_DELAY_MS = 120;
// Card-scoped, not .card-btn-group-scoped: the objective card's .btn-create-subtasks
// sits in .controls-row, outside the button group (TPT26).
const BTN_TIP_SELECTOR = '.card [data-tip]';

function hideBtnTip() {
  clearTimeout(_btnTipTimer);
  _btnTipTimer = null;
  if (_btnTip) { _btnTip.remove(); _btnTip = null; }
}

function showBtnTip(btn) {
  const text = btn.getAttribute('data-tip');
  if (!text) return;
  const tip = document.createElement('div');
  tip.className = 'card-btn-tooltip';
  tip.textContent = text;
  document.body.appendChild(tip);
  const rect = btn.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  // (TPT306) Select and its drop-down action menu stack vertically, so a below-anchored tip
  // would cover the next menu item — anchor these to the left, vertically centred instead.
  if (btn.closest('.card-btn-group')) {
    tip.classList.add('tooltip-flip-left');
    tip.style.right = (viewportWidth - rect.left + 10) + 'px'; // clear of the tray's 5px edge (TPT308)
    tip.style.top = (rect.top + (rect.height - tip.getBoundingClientRect().height) / 2) + 'px';
    _btnTip = tip;
    return;
  }
  const anchor = computeTooltipAnchor(rect, tip.getBoundingClientRect().width, viewportWidth);
  if (anchor.flip) {
    tip.classList.add('tooltip-flip-left');
    tip.style.right = anchor.right + 'px';
  } else {
    tip.style.left = anchor.left + 'px';
  }
  // Below the button (not aligned to top like the title tooltip) so it never covers the
  // control being hovered.
  tip.style.top = (rect.bottom + 6) + 'px';
  _btnTip = tip;
}

// Bound once on the stable #app node (setupCardInteractions runs on every render — a
// per-button listener would multiply). Teardown on mouseout/mousedown/scroll so a modal
// open or board re-render never strands a body-appended tooltip node.
function ensureButtonTooltips(appEl) {
  if (_btnTipBound) return;
  _btnTipBound = true;
  appEl.addEventListener('mouseover', (e) => {
    const btn = e.target.closest?.(BTN_TIP_SELECTOR);
    if (!btn) return;
    hideBtnTip();
    _btnTipTimer = setTimeout(() => showBtnTip(btn), BTN_TIP_DELAY_MS);
  });
  appEl.addEventListener('mouseout', (e) => {
    if (e.target.closest?.(BTN_TIP_SELECTOR)) hideBtnTip();
  });
  appEl.addEventListener('mousedown', hideBtnTip, true);
  window.addEventListener('scroll', hideBtnTip, true);
}

// ── Assignee start guard ──

/**
 * Can the current user START a terminal session for this task?
 * Fail-OPEN: hide Start ONLY on a confirmed mismatch (task assigned to a
 * *known different* user). If the current user is unknown, show Start — the
 * server-side EASSIGNEE guard — assertTaskStartable() in ws-handlers.js (C1408,
 * moved out of terminal-session.js's spawnTerminal()) — is the authoritative
 * backstop and blocks a genuine cross-member spawn. Unassigned = always startable
 * (claimUnassignedTaskOnStart() assigns it to the starting user before spawn).
 * (C1340) An objective/parent container task never runs in a terminal — no
 * assignee check even applies. Checked first so all four call sites (card
 * render, sprint Play-All filter, bulk-start bar, edit modal) get this for free.
 */
export function canStartTaskCard(t) {
  if (t.isObjective) return false;                // objective tasks never run in a terminal
  if (isTaskDiscussing(state, t.id)) return false; // (TPT272/TPT283) locked by an open Rehash → Discuss/Split tab
  if (t.assignee == null) return true;           // unassigned — anyone can start
  if (state.currentUserId == null) return true;  // current user unknown → fail OPEN
  return Number(t.assignee) === Number(state.currentUserId);
}

// (C1407) Is this a teammate's task, opened via the People filter's All-Tasks scope (or
// subtask drill-down, or — before C1407's board scoping — the API's owner exemption)?
// Drives the Task Edit Modal's read-only lock (_applyModalLockState(), task-board.js).
// Same fail-OPEN discipline as canStartTaskCard() above: an unknown current user never
// locks a task that might actually be the viewer's own.
export function isTaskReadOnly(t) {
  return t.assignee != null && state.currentUserId != null && Number(t.assignee) !== Number(state.currentUserId);
}

// Backward-compatible name used throughout the board. The underlying predicate also
// accepts the edit modal's full-project task index through hasUnmetDeps(task, taskIndex).
export function isDepsBlocked(t) { return hasUnmetDeps(t); }

// (C1559) Picks the first of an is_objective task's children that is startable per its
// dependencies, for the "Start in Task App" web-button dispatch (§ objective-with-
// children branch — see ai/architecture/tt-objective-chat.md § Web→Task App handoff).
// Filter is the EXACT sprint Play-All predicate (task-board.js's own comment on that
// filter requires every copy to match) — never fork it; order is (priority DESC, order
// DESC), the same tier order sortTier() (task-board.js) and the API's
// `ORDER BY priority DESC, display_order DESC` both use. Returns null when no child
// qualifies (all closed/in-progress/blocked/not-mine/HUMAN).
export function pickFirstStartableChild(children) {
  const list = Array.isArray(children) ? children : [];
  const eligible = list.filter(t =>
    isActiveName(t.status) && !isInProgressName(t.status) && t.category === 'CODING'
    && !isDepsBlocked(t) && canStartTaskCard(t)
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => (Number(b.priority ?? 0) - Number(a.priority ?? 0)) || (Number(b.order ?? 0) - Number(a.order ?? 0)));
  return eligible[0];
}

// ── Module-level interaction state ──
const hoverExpandTimers = new WeakMap();
let hoverCollapseTimer = null;
let _titleTooltip = null;

// ── Drag-to-reorder state ──
let _isDragging = false;
let _dropInProgress = false;
// (C1438) True from mousedown, not just after the 5px activation threshold — a board
// re-render landing in that gap (WS echo, poll tick, agent status change) wipes #app and
// detaches the dragged card's DOM nodes before the drag even visually starts. See
// tt-task-cards-drag-drop.md "Root cause: drag vs. board re-render".
export function isDragging() { return _isDragging || _dragState !== null; }
export function isDropInProgress() { return _dropInProgress; }
let _dragState = null; // { sourceCard, tierCards, clone, placeholder, startX, startY, offsetX, offsetY, activated }

// (C1438) True only while `taskId` is the card currently being dragged (not just while any
// drag is active) — used to keep a WS-driven patch/regroup/remove out of the one card whose
// DOM node the gesture holds a reference to, without deferring updates to every other card.
export function isDragSourceId(taskId) {
  return !!_dragState && _dragState.sourceCard.dataset.id === taskId;
}

// (C1438) isDragStateStale() / shouldDeferForDrag() live in drag-state.js (pure, no DOM
// import graph) and are re-exported above so template.html's `taskCard` namespace import
// still finds them at the same names.

function _removeDragListeners() {
  document.removeEventListener('mousemove', _onDragMove);
  document.removeEventListener('mouseup', _onDragEnd);
  document.removeEventListener('keydown', _onDragKeydown);
  window.removeEventListener('blur', _onDragWindowBlur);
}

// (C1438) Widening isDragging() to cover mousedown means a lost mouseup (released outside
// the window, swallowed by a native menu) would otherwise strand _dragState and block every
// board render forever, not just the drag. Window blur is the catch-all for "mouse left the
// renderer".
function _onDragWindowBlur() { _cleanupDrag(); }

async function _patchTask(id, body, label) {
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      // (C1392) Was header-less — a bare browser tab against a multi-project server
      // resolves the unbound default backend instead of this project's. See utils.js
      // projectHeader() / ai/architecture/tt-task-board.md § C1391.
      headers: { 'Content-Type': 'application/json', ...projectHeader() },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`${label} PATCH failed for ${id}: ${res.status}`);
  } catch (err) {
    console.error(`${label} PATCH error for ${id}:`, err);
  }
}

// (C1559) The agent-resolution ladder itself, extracted out of _startTaskSession()
// (below in bindCardEvents) so startTaskById() can share it for a task with no rendered
// card. Reads the module-scoped _on*/state refs directly — none of this depends on
// `appEl` or any other bindCardEvents-local closure, so top-level placement is safe.
// opts: { agentAssignee, piModel } — the resolved pin, however the caller got it (DOM
// dataset for a card, the task record's own fields for a card-independent start).
function _startTaskSessionCore(taskId, taskTitle, taskDesc, taskStatus, { agentAssignee, piModel } = {}, extraOpts) {
  clearAttention(taskId, 'opened'); // (C1387) every branch below leads into openTerminal()
  document.dispatchEvent(new CustomEvent('tiptask:clear-new-assignment', { detail: { taskId } }));
  state.pendingRestoreContext = {
    scrollY: window.scrollY,
    cardId: state.selectedCardId,
    cardMode: state.expandedCardMode === 'pinned' ? 'pinned' : null,
  };
  collapseCard();
  const hasSession = state.activeSessions.has(taskId) || state.exitedSessions.has(taskId);
  const pinnedAgent = (agentAssignee === 'claude' || agentAssignee === 'codex' || agentAssignee === 'pi') ? agentAssignee : null;
  // (C1133) per-task Pi model pin, carried alongside pinnedAgent — undefined for
  // claude/codex (their per-task model resolves server-side from the task record) and
  // for a pi task with no model saved (server falls back to the project default row).
  const pinnedModel = (pinnedAgent === 'pi' && piModel) ? piModel : undefined;
  if (isClosedName(taskStatus) && !hasSession) {
    if (_onShowClaudeConfirmModal) _onShowClaudeConfirmModal(taskId, taskTitle, taskDesc, taskStatus, { agent: pinnedAgent, ...(pinnedModel ? { model: pinnedModel } : {}), ...extraOpts });
  } else if (hasSession) {
    if (_onOpenTerminal) _onOpenTerminal(taskId, taskTitle, taskDesc, taskStatus, extraOpts || {});
  } else if (pinnedAgent) {
    if (_onOpenTerminal) _onOpenTerminal(taskId, taskTitle, taskDesc, taskStatus, { agent: pinnedAgent, ...(pinnedModel ? { model: pinnedModel } : {}), ...extraOpts });
  } else if (state.availableAgents.length > 1 && state.sessionAgent === null) {
    if (_onOpenAgentSelectorModal) _onOpenAgentSelectorModal(taskId, taskTitle, taskDesc, taskStatus, extraOpts || {});
    else if (_onOpenTerminal) _onOpenTerminal(taskId, taskTitle, taskDesc, taskStatus, extraOpts || {});
  } else if (state.sessionAgent) {
    // (C1122) sessionAgentModel carries the specific Pi row the user remembered — undefined
    // for claude/codex and for a pre-C1122 remembered pi choice with no model recorded.
    if (_onOpenTerminal) _onOpenTerminal(taskId, taskTitle, taskDesc, taskStatus, { agent: state.sessionAgent, ...(state.sessionAgentModel ? { model: state.sessionAgentModel } : {}), ...extraOpts });
  } else {
    const unavailable = (state.agentStatuses || []).filter(s => !s.available);
    if (unavailable.length > 0) {
      const reasons = unavailable.map(s => `${s.label || s.id}: ${s.reason || 'unavailable'}`).join('; ');
      agentNotice(`Agent unavailable — ${reasons}. Launching ${state.taskAgentLabel || 'default'}.`);
    }
    if (_onOpenTerminal) _onOpenTerminal(taskId, taskTitle, taskDesc, taskStatus, extraOpts || {});
  }
}

// (C1559) Fetch one task through whichever transport this window uses — same
// electronAPI-vs-fetch branch template.html's _fetchTaskForHandoff() uses (not reachable
// from here, that's inline-script scope, not this ES module).
async function _fetchTaskForStart(taskId) {
  if (window.electronAPI?.api?.tasks?.get) {
    return window.electronAPI.api.tasks.get(taskId);
  }
  const r = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { headers: projectHeader() });
  if (!r.ok) throw new Error(r.statusText || 'Failed to load task');
  return r.json();
}

// (C1559) Card-independent entry point for starting a task's terminal session — the
// /start-task web-button dispatch's "regular task" and "first startable child" branches
// (see template.html's 'start-task' IPC listener) call this, since neither has a
// rendered DOM card to read a pinned agent/model from. Fetches the task fresh and
// resolves agentAssignee/piModel from its own live fields instead, then shares the exact
// same ladder _startTaskSession() (bindCardEvents, below) uses for a card-driven Start.
export async function startTaskById(taskId, extraOpts = {}) {
  let task;
  try {
    task = await _fetchTaskForStart(taskId);
  } catch (err) {
    showToast(err.message || `Failed to load task ${taskId}`, 'error');
    return;
  }
  if (!task) {
    showToast(`Task ${taskId} not found`, 'error');
    return;
  }
  _startTaskSessionCore(taskId, task.title || taskId, task.description || '', task.status,
    { agentAssignee: task.agentAssignee || task.agent_assignee || null, piModel: task.piModel || task.pi_model || null },
    extraOpts);
}

// ── One-time registration of callbacks + document-level handler ──
let _registered = false;

export function registerCardCallbacks({ onLoadAndRender, onOpenTerminal, onOpenAgentSelectorModal, onOpenAgentAssignModal, onShowClaudeConfirmModal, onShowConfirmModal, onShowDeleteConfirmModal, onUpdateBulkBar, onShowReiterateModal, onFetchActiveSessions, onOpenTaskEditModal, onOpenPreviewCardModal }) {
  _onLoadAndRender = onLoadAndRender;
  _onOpenTerminal = onOpenTerminal;
  _onOpenAgentSelectorModal = onOpenAgentSelectorModal || null;
  _onOpenAgentAssignModal = onOpenAgentAssignModal || null;
  _onShowClaudeConfirmModal = onShowClaudeConfirmModal;
  _onShowConfirmModal = onShowConfirmModal;
  _onShowDeleteConfirmModal = onShowDeleteConfirmModal;
  _onUpdateBulkBar = onUpdateBulkBar || null;
  _onShowReiterateModal = onShowReiterateModal || null;
  _onFetchActiveSessions = onFetchActiveSessions || null;
  _onOpenTaskEditModal = onOpenTaskEditModal || null;
  _onOpenPreviewCardModal = onOpenPreviewCardModal || null;

  if (!_registered) {
    _registered = true;
    // Click outside card to deselect/collapse (bound once)
    document.addEventListener('click', (e) => {
      if (!state.selectedCardId) return;
      if (e.target.closest('.card')) return;
      if (e.target.closest('.card-overlay-backdrop')) return;
      state.selectedCardId = null;
      clearHighlights();
      clearChainHighlights();
      clearFocusActive();
      collapseCard();
    });
  }
}

// ── HTML generators ──

export const CLAUDE_SVG = '<svg viewBox="0 0 248 248" width="14" height="14" fill="#D97757" xmlns="http://www.w3.org/2000/svg"><path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z"/></svg>';
export const CLAUDE_BADGE_SVG = '<svg viewBox="0 0 248 248" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z"/></svg>';
export const HUMAN_BADGE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg>';
export const CODEX_BADGE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" shape-rendering="geometricPrecision"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>';
// (C1133) π glyph, same path as console-modal.js's _PI_AGENT_SVG, badge-sized.
export const PI_BADGE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 7h16v2.2h-2.6l-.9 9.4a1.6 1.6 0 0 1-3.18-.16l.68-9.24H9.9l-.7 9.3a1.6 1.6 0 0 1-3.18-.18l.68-9.12H4V7z"/></svg>';

const _WAND_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14l7-7"/><path d="M11 1.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/><path d="M14 7l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z"/></svg>';
// Speech bubble — opens the task chat window (task-chat.js).
const _CHAT_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 9.5a1.5 1.5 0 0 1-1.5 1.5H5.5l-3 2.5V4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4z"/><path d="M5.5 6h5"/><path d="M5.5 8.25h3"/></svg>';
// (C1340) Subtasks glyph — stem branching into two rows, shared by the objective
// card's yellow "Create Subtasks" and green "Subtasks N/M" buttons (C1436).
const _SUBTASKS_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2h3"/><path d="M3.5 2v9.5a1 1 0 0 0 1 1H6"/><path d="M3.5 7H6"/><rect x="6" y="5" width="8" height="4" rx="1"/><rect x="6" y="10.5" width="8" height="4" rx="1"/></svg>';

export function renderAgentBadge(t) {
  if (!t.agentAssignee) return '';
  const locked = isInProgressName(t.status);
  const lockedClass = locked ? ' agent-badge--locked' : '';
  let icon, label;
  if (t.agentAssignee === 'claude') {
    icon = CLAUDE_BADGE_SVG; label = 'Claude Code';
  } else if (t.agentAssignee === 'codex') {
    icon = CODEX_BADGE_SVG; label = 'Codex';
  } else if (t.agentAssignee === 'pi') {
    // (C1302) show the pinned model id, not the bare 'Pi' — matches console-modal.js's
    // agent selector and task-board.js's picker, which already resolve the model.
    icon = PI_BADGE_SVG; label = t.piModel ? shortModelName(t.piModel) : 'Pi';
  } else {
    icon = HUMAN_BADGE_SVG; label = 'Human';
  }
  return `<span class="agent-badge agent-badge--${escapeAttr(t.agentAssignee)}${lockedClass}" data-task-id="${escapeAttr(t.id)}" data-agent="${escapeAttr(t.agentAssignee)}" title="${escapeAttr(label)}">${icon}</span>`;
}

// (TPT285) Per-task effort chip, sat just left of the agent badge. Gated on the same
// Claude/Codex rule as the edit modal's Effort row — a task switched to Pi/Human keeps its
// stored effort, but showing it there would imply a setting that agent never reads. Unknown
// values (a future API level this client doesn't list yet) render as-is, unstyled.
export function renderEffortBadge(t) {
  if (!t.effort || (t.agentAssignee !== 'claude' && t.agentAssignee !== 'codex')) return '';
  const level = String(t.effort);
  const known = EFFORT_LEVELS.includes(level);
  const label = known ? translate(EFFORT_LABELS[level]) : level;
  return `<span class="effort-badge${known ? ` effort-badge--${level}` : ''}" title="${escapeAttr(translate('badge.effort', { level: label }))}">${escapeAttr(level)}</span>`;
}

function bindAgentBadge(badge) {
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    if (badge.classList.contains('agent-badge--locked')) return;
    const card = badge.closest('.card');
    const taskId = badge.dataset.taskId;
    const current = badge.dataset.agent;
    const status = card?.dataset.status;
    if (_onOpenAgentAssignModal) _onOpenAgentAssignModal(taskId, current, status);
  });
}

function renderMemberBadge(t) {
  if (t.assignee == null) return '';
  const members = Array.isArray(state.projectMembers) ? state.projectMembers : [];
  const member = members.find(m => Number(m.user_id) === Number(t.assignee));
  if (!member || !member.name) return '';
  const title = escapeAttr(member.name);
  const initial = escapeAttr(member.name.trim()[0]?.toUpperCase() || '?');
  if (member.avatar_url) {
    return `<img class="member-badge" src="${escapeAttr(member.avatar_url)}" alt="${title}" title="${title}" referrerpolicy="no-referrer" loading="lazy" onerror="this.outerHTML='<span class=\\'member-badge member-badge--initials\\' title=\\'${title}\\'>${initial}</span>'">`;
  }
  return `<span class="member-badge member-badge--initials" title="${title}">${initial}</span>`;
}

function renderSprintBadgeLabel(task) {
  const p = task?.priority;
  if (task?.sprint_id === null || task?.sprintId === null || (p !== undefined && p !== '' && Number(p) === 0)) return 'Backlog';
  return groupTitle(task.priority ?? '?');
}

// ── Adaptive card width (C1580) ──
// Measures a title's rendered pixel width so cardMaxWidthPx() (card-width.js) can grow a card
// only as far as its own title needs. Canvas measurement is exact and cheap (no layout/reflow);
// falls back to card-width.js's char-count estimator when canvas is unavailable (no document,
// e.g. under `node --test`) or before the card font is known.
let _measureCtx = null;
let _measureFont = null; // cached so a whole render pass reads computed style at most once
function _cardTitleFont() {
  if (_measureFont) return _measureFont;
  if (typeof document === 'undefined') return null;
  const probe = document.querySelector('.card-title');
  const cs = probe && document.body.contains(probe) ? getComputedStyle(probe) : null;
  _measureFont = cs ? `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}` : '600 15.2px system-ui';
  return _measureFont;
}
function _measureTitle(text) {
  if (typeof document !== 'undefined') {
    try {
      if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
      if (_measureCtx) {
        _measureCtx.font = _cardTitleFont();
        return _measureCtx.measureText(text || '').width;
      }
    } catch {
      // fall through to the char-count estimator below
    }
  }
  return estimateTextWidth(text, TITLE_CHAR_PX);
}

const _DUE_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatDueDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${_DUE_MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : '';
}

// Preview cards omit board controls and data-id attributes so board selectors
// cannot drag, filter, or replace them. Proposal cards retain chat-review
// controls; lock intent labels the Rehash Discuss/Split overlay.
function discussOverlayHtml(intent) {
  const tip = escapeAttr(translate(lockMessageKey(intent)));
  return `<div class="card-discuss-overlay" title="${tip}" aria-label="${tip}" role="img">${HOURGLASS_SVG}</div>`;
}

// (TPT272) In-place sync of a mounted board card with state.discussingTaskKeys: toggles
// card--discussing + the overlay and strips Start while locked. Reads only the card's own
// dataset, never a (possibly stale) task object. Returns true when the card is unlocked but is
// missing a Start button renderCard() would emit — the caller must re-render to get one back,
// since setupCardInteractions() binds Start's click handler per element.
export function applyDiscussLock(card) {
  if (!card || !card.dataset.id) return false;
  const locked = isTaskDiscussing(state, card.dataset.id);
  card.classList.toggle('card--discussing', locked);
  const overlay = card.querySelector(':scope > .card-discuss-overlay');
  if (locked) {
    card.dataset.lockIntent = lockIntentOf(state, card.dataset.id);
    const tip = translate(lockMessageKey(card.dataset.lockIntent));
    if (!overlay) card.insertAdjacentHTML('beforeend', discussOverlayHtml(card.dataset.lockIntent));
    else if (overlay.title !== tip) { overlay.title = tip; overlay.setAttribute('aria-label', tip); }
    card.querySelectorAll('.btn-claude, .btn-start-discussion').forEach(b => b.remove());
    return false;
  }
  overlay?.remove();
  delete card.dataset.lockIntent;
  if (card.dataset.objective === '1' || card.querySelector('.btn-claude, .btn-start-discussion')) return false;
  const idBadge = card.querySelector('.id-badge');
  const category = idBadge?.classList.contains('coding') ? 'CODING' : 'HUMAN';
  const t = { id: card.dataset.id, isObjective: false, assignee: card.dataset.assignee === '' ? null : card.dataset.assignee };
  if (!canStartTaskCard(t)) return false;
  if (category === 'CODING') return card.dataset.agentAssignee !== 'human';
  return isActiveName(card.dataset.status);
}

export function renderCard(t, { preview = false, proposal = null } = {}) {
  if (proposal) preview = true;
  const blocking = unmetDependencyKeys(t);
  const depsBlocked = blocking.length > 0;
  // (TPT552) data-deps-blocked keeps the raw dependency fact; the button itself is only gated
  // for a fresh launch. A task with a session (e.g. pending follow-ups were added as its deps
  // after it ran) stays resumable — updateClaudeButtons() re-applies this as sessions change.
  const startGated = depsBlocked && !hasTaskSession(t.id);

  const deps = t.dependencies.length
    ? `<div class="deps">Depends on: ${t.dependencies.map(d => `<span class="dep-badge">${d}</span>`).join(' ')}</div>`
    : '';

  const truncatedDesc = truncateMarkdownAtParagraph(t.description, MAX_DESC_LEN);
  const renderedDesc = proposal && proposal.descTransform
    ? truncateMarkdownAtParagraph(proposal.descTransform(t.description), MAX_DESC_LEN)
    : truncatedDesc;
  const liveDevice = t.activeDevice && t.activeDevice.id !== state.deviceId;
  const recentOther = !liveDevice && t.recentDevice && t.recentDevice.id !== state.deviceId;
  const showDeviceBadge = (liveDevice || recentOther) && isActiveName(t.status);
  let deviceBadge = '';
  if (showDeviceBadge) {
    const dev = liveDevice ? t.activeDevice : t.recentDevice;
    const modifier = liveDevice ? '' : ' device-badge--recent';
    const tooltip = liveDevice ? `Active on ${dev.name}` : `Last worked on ${dev.name}`;
    deviceBadge = `<span class="device-badge${modifier}" title="${escapeAttr(tooltip)}">${escapeAttr(dev.name)}</span>`;
  }
  let dueDatePill = '';
  if (t.due_date) {
    const dueLabel = formatDueDate(t.due_date);
    if (dueLabel) {
      const overdue = t.due_date < new Date().toISOString().slice(0, 10)
        && isActiveName(t.status);
      dueDatePill = `<span class="card-due${overdue ? ' overdue' : ''}" title="Due ${escapeAttr(t.due_date)}">${dueLabel}</span>`;
    }
  }
  const badgeClass = t.category === 'CODING' ? 'coding' : 'human';
  const variant = cardVariant(t.description.length);
  const wideClass = variant === 'wide' ? ' card--wide' : variant === 'medium' ? ' card--medium' : '';
  // (C1580) How far this card is allowed to flex-grow (styles.css's --card-max-w consumer) —
  // only as far as its own title needs, floored at the variant's basis (see card-width.js).
  const cardMaxW = cardMaxWidthPx({ title: t.title, taskKey: t.id, variant, measureTitle: _measureTitle });
  // NOTE: deliberately NOT "not complete" — this quirk (on_fire is undeletable, same as
  // completed) predates C1187 and is preserved via the explicit role triple rather than
  // simplified to !isCompleteName(t.status), which would silently make on_fire deletable.
  const deletable = isStartName(t.status) || isInProgressName(t.status) || isCanceledName(t.status);
  const deleteBtn = deletable
    ? `<button class="btn-delete-task" data-task-id="${escapeAttr(t.id)}" data-task-title="${escapeAttr(t.title)}" data-tip="${escapeAttr(translate('tooltip.deleteTask'))}" aria-label="${escapeAttr(translate('tooltip.deleteTask'))}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12"/><path d="M5.333 4V2.667a1.333 1.333 0 0 1 1.334-1.334h2.666a1.333 1.333 0 0 1 1.334 1.334V4"/><path d="M12.667 4v9.333a1.333 1.333 0 0 1-1.334 1.334H4.667a1.333 1.333 0 0 1-1.334-1.334V4"/><path d="M6.667 7.333v4"/><path d="M9.333 7.333v4"/></svg></button>`
    : '';
  const chainBtn = `<button class="btn-chain-deps" data-task-id="${escapeAttr(t.id)}" data-tip="${escapeAttr(translate('tooltip.chain'))}" aria-label="${escapeAttr(translate('tooltip.chain'))}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5l3-3"/><path d="M9 10.5a2.5 2.5 0 0 1-3.536 0l-1.5-1.5a2.5 2.5 0 0 1 3.536-3.536l.5.5"/><path d="M7 5.5a2.5 2.5 0 0 1 3.536 0l1.5 1.5a2.5 2.5 0 0 1-3.536 3.536l-.5-.5"/></svg></button>`;
  const editBtn = `<button class="card-edit-btn" type="button" data-task-id="${escapeAttr(t.id)}" data-tip="${escapeAttr(translate('card.editTask'))}" aria-label="${escapeAttr(translate('card.editTask'))}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13h10"/><path d="M4 10.5V12h1.5l7-7-1.5-1.5-7 7Z"/><path d="m10.5 4 1.5-1.5 1.5 1.5L12 5.5"/></svg></button>`;
  const chatBtn = `<button class="btn-task-chat" type="button" data-task-id="${escapeAttr(t.id)}" data-tip="${escapeAttr(translate('tooltip.taskChat'))}" aria-label="${escapeAttr(translate('tooltip.taskChat'))}">${_CHAT_SVG}</button>`;
  const reiterateBtn = `<button class="btn-reiterate" data-task-id="${escapeAttr(t.id)}" data-task-title="${escapeAttr(t.title)}" data-tip="${escapeAttr(translate('tooltip.reiterate'))}" aria-label="${escapeAttr(translate('tooltip.reiterate'))}">${_WAND_SVG}</button>`;
  const inlineChildren = preview ? [] : (state.childrenByParent?.get(t.id) || []); // radios mutate status — never in a preview
  const hasInlineChildren = inlineChildren.length > 0;
  const subtaskList = hasInlineChildren ? `
        <div class="subtask-list">
          ${inlineChildren.map(c => `<div class="subtask-item" data-key="${escapeAttr(c.id)}"><input type="radio" class="subtask-radio"${isCompleteName(c.status) ? ' checked' : ''} data-key="${escapeAttr(c.id)}" data-current-status="${escapeAttr(c.status)}" aria-label="Mark complete"><span class="subtask-title" data-key="${escapeAttr(c.id)}" data-title="${escapeAttr(c.title)}" title="${escapeAttr(c.title)}">${escapeAttr(c.title.length > 40 ? c.title.slice(0, 40) + '…' : c.title)}</span></div>`).join('')}
        </div>` : '';
  const isSelected = !preview && state.selectedCardIds.has(t.id);
  // (TPT272/TPT283) Locked by an open Rehash → Discuss/Split tab. Board cards only — the chat's
  // own pinned Discuss card is a preview of the very same task and must stay fully readable.
  const discussing = !preview && isTaskDiscussing(state, t.id);
  const lockIntent = discussing ? lockIntentOf(state, t.id) : null;
  const isPendingSync = !preview && (state.pendingTaskIds && state.pendingTaskIds.has(t.id) || t._pendingSync);
  const manualMerge = !preview && state.taskMergeStatus?.vcs?.type === 'git' && state.taskMergeStatus.vcs.merge === false && state.taskMergeStatus.tasks?.[t.id]?.unmerged === true;
  const mergeBtn = manualMerge ? mergeButtonHtml(t.id) : '';
  const selectBtn = `<button class="btn-select-card${isSelected ? ' checked' : ''}" data-task-id="${escapeAttr(t.id)}" data-tip="${escapeAttr(translate('tooltip.selectCard'))}" aria-label="${escapeAttr(translate('tooltip.selectCard'))}"><span class="select-dot"></span>${manualMerge ? MERGE_DOT : ''}</button>`;
  const agentBadge = proposal ? '' : renderAgentBadge(t);
  const effortBadge = proposal ? '' : renderEffortBadge(t);
  const memberBadge = proposal ? '' : renderMemberBadge(t);
  // (TPT12) Unread-activity chip — someone else commented on/changed this task. Both of
  // .card's pseudo-element slots are taken (::before orange attention dot, ::after green
  // newly-assigned dot) and all four corners are occupied by badges, so this is a real
  // inline element next to the id-badge instead, not another ring/dot.
  const activityChip = preview ? '' : activityChipHtml(t.id);
  // (C1333) Sprints off: no group noun to show — blank label, tooltip drops its sprint half.
  // data-priority stays on the card either way (task-card.js flat-drag-reorder reads it).
  const sprintBadgeLabel = getSprintsEnabled() ? renderSprintBadgeLabel(t) : '';
  const idBadgeTitle = sprintBadgeLabel ? `Order: ${t.order ?? 0} - ${sprintBadgeLabel}` : `Order: ${t.order ?? 0}`;
  // (C1436) childrenCount/completedChildrenCount are list-route-only (C1435) — null on a
  // drill-down board (getChildren() maps children through fromApi(), no count fields).
  // Bare label there rather than a false "0/0" on a card that provably has children.
  // (C1453) Extracted to subtask-count.js so the live-update path (applyTaskPatch() below
  // -> task-board.js's refreshParentSubtaskLabel()) can rebuild the same string in-place.
  const subtasksLabel = buildSubtasksLabel(t);
  // (TPT179) Preview swaps the board's lookup attributes for a single inert one, and shows the
  // status/deps that otherwise live only inside the hover controls as a static row.
  const idAttr = preview ? 'data-preview-task' : 'data-task-id';
  const rootAttrs = proposal
    ? (proposal.rootAttrs || '')
    : preview
    ? `data-preview-task="${escapeAttr(t.id)}" data-status="${escapeAttr(t.status)}" data-status-role="${statusRoleToken(t.status)}" data-objective="${t.isObjective ? '1' : ''}"`
    : `data-id="${escapeAttr(t.id)}" data-status="${t.status}" data-status-role="${statusRoleToken(t.status)}" data-priority="${t.priority ?? ''}" data-sprint-label="${escapeAttr(sprintBadgeLabel)}" data-assignee="${t.assignee ?? ''}" data-agent-assignee="${escapeAttr(t.agentAssignee || '')}" data-pi-model="${escapeAttr(t.piModel || '')}" data-objective="${t.isObjective ? '1' : ''}" data-db-id="${escapeAttr(t.dbId ?? '')}" data-parent-db-id="${escapeAttr(t.parentDbId ?? '')}" data-deps='${JSON.stringify(t.dependencies)}' data-tags='${JSON.stringify(t.tags || [])}'${depsBlocked ? ' data-deps-blocked="1"' : ''}${lockIntent ? ` data-lock-intent="${lockIntent}"` : ''}`;
  const previewMetaHtml = proposal
    ? `<div class="card-preview-meta">${proposal.metaHtml || ''}</div>`
    : `<div class="card-preview-meta"><span class="status" style="--status-color:${statusColor(t.status)}" data-status-role="${statusRoleToken(t.status)}">${escapeAttr(statusLabel(t.status))}</span>${t.dependencies.length ? `<span class="card-preview-deps" title="Deps: ${escapeAttr(t.dependencies.join(', '))}">Deps: ${escapeAttr(t.dependencies.join(', '))}</span>` : ''}</div>`;
  // (C1387) needs-attention is intrinsic to the card markup, not applied post-render only —
  // a full board re-render used to permanently drop the ring for any card without a Start
  // button (objective/human-assigned cards). syncAttentionClasses() (attention-state.js) is
  // the re-render-survival counterpart, swept from syncActiveSessionsNav() after every render.
  return `
      <div class="card${wideClass}${isSelected ? ' selected' : ''}${agentBadge ? ' has-agent-badge' : ''}${effortBadge ? ' has-effort-badge' : ''}${memberBadge ? ' has-member-badge' : ''}${isPendingSync ? ' pending-sync' : ''}${preview ? ' card--preview' : attentionClass(t.id)}${proposal ? ` preview-card${proposal.rootClass ? ' ' + proposal.rootClass : ''}` : ''}${activityChip ? ' has-activity-badge' : ''}${t.isObjective ? ' objective-highlight' : ''}${discussing ? ' card--discussing' : ''}" ${rootAttrs} style="--card-max-w:${cardMaxW}px">
        ${proposal ? (proposal.headHtml || '') : ''}<div class="card-top${proposal ? ' card-top--proposal' : ''}">
          <span class="id-badge ${badgeClass}" ${idAttr}="${escapeAttr(t.id)}" title="${escapeAttr(idBadgeTitle)}"${proposal && proposal.hideIdBadge ? ' hidden>' : `>${t.id}`}</span>
          ${activityChip}
          <span class="card-title${proposal ? ' preview-title' : ''}"${proposal ? ' data-field="title" contenteditable="false"' : ''} ${idAttr}="${escapeAttr(t.id)}" title="${escapeAttr(t.title)}"><span class="card-title-inner">${escapeAttr(t.title)}</span></span>
          ${preview ? '' : `<div class="card-btn-group">
            ${selectBtn}<div class="card-action-menu" role="group" aria-label="${escapeAttr(translate('card.actionsMenu'))}">${editBtn}${chatBtn}${chainBtn}${reiterateBtn}${deleteBtn}${mergeBtn}</div>
          </div>`}
        </div>
        ${preview ? previewMetaHtml : `<div class="task-card-hover-controls">
          <div class="hover-controls-inner">
            <div class="controls-row">
              <select class="card-status-select card-ctl" style="--status-color:${statusColor(t.status)}" data-task-id="${escapeAttr(t.id)}" data-current="${t.status}">
                ${statusNames().map(s => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')}
              </select>
              ${deviceBadge}
              ${t.isObjective
                ? (t.hasChildren
                    ? `<button class="btn-open-subtask-board btn-subtasks-show card-ctl" data-task-key="${escapeAttr(t.id)}" data-task-title="${escapeAttr(t.title)}" title="${escapeAttr(subtasksLabel)}">${_SUBTASKS_SVG}<span>${escapeAttr(subtasksLabel)}</span></button>`
                    : `<button class="btn-create-subtasks card-ctl" data-task-key="${escapeAttr(t.id)}" data-task-title="${escapeAttr(t.title)}" data-tip="${escapeAttr(translate('tooltip.createSubtasks'))}" aria-label="${escapeAttr(translate('tooltip.createSubtasks'))}">${_SUBTASKS_SVG}<span>${escapeAttr(translate('btn.startObjective'))}</span></button>`)
                : `${(t.category === 'CODING' && t.agentAssignee !== 'human' && canStartTaskCard(t))
                  ? `<button class="card-start-btn btn-claude card-ctl${startGated ? ' deps-blocked' : ''}" data-task-id="${escapeAttr(t.id)}" data-task-title="${escapeAttr(t.title)}" data-task-desc="${escapeAttr(truncatedDesc)}" data-task-status="${t.status}"${startGated ? ` disabled title="Waiting for: ${escapeAttr(blocking.join(', '))}"` : ''}>Start</button>`
                  : (t.category === 'HUMAN' && isActiveName(t.status) && canStartTaskCard(t))
                    ? `<button class="card-start-btn btn-start-discussion card-ctl" data-task-id="${escapeAttr(t.id)}" data-task-title="${escapeAttr(t.title)}" data-task-desc="${escapeAttr(truncatedDesc)}" data-task-status="${t.status}">Start</button>`
                    : ''}${t.hasChildren ? `<button class="btn-open-subtask-board card-ctl" data-task-key="${escapeAttr(t.id)}" data-task-title="${escapeAttr(t.title)}">${translate('btn.subtasks')}</button>` : ''}`}
            </div>
            ${t.dependencies.length
              ? `<span class="card-deps-label" title="Deps: ${t.dependencies.join(', ')}">Deps: ${t.dependencies.join(', ')}</span>`
              : ''}
          </div>
        </div>`}
        <div class="card-desc${proposal ? ' preview-desc' : ''}"${proposal ? ' data-field="description" contenteditable="false"' : ''} ${idAttr}="${escapeAttr(t.id)}" data-raw="${escapeAttr(t.description)}">${renderMarkdown(renderedDesc)}</div>
        ${(t.tags && t.tags.length) ? `<div class="card-tags">${t.tags.map(tag => renderTagBadge(tag, state.tagDescriptions)).join('')}</div>` : ''}
        ${dueDatePill}
        ${subtaskList}
        ${(t.totalInputTokens > 0 || t.totalOutputTokens > 0) ? `<div class="ai-stats"${state.showAiStats ? '' : ' style="display:none"'}>${(t.totalInputTokens || 0).toLocaleString()} in · ${(t.totalOutputTokens || 0).toLocaleString()} out${t.totalCostUsd > 0 ? ` · ${t.totalCostUsd >= 0.01 ? '$' + t.totalCostUsd.toFixed(2) : '$' + t.totalCostUsd.toFixed(4)}` : ''}</div>` : ''}
        ${memberBadge}
        ${effortBadge}
        ${agentBadge}
        ${discussing ? discussOverlayHtml(lockIntent) : ''}
        ${proposal ? (proposal.footHtml || '') : ''}
      </div>`;
}

// ── Card expand/collapse overlay ──

function lockBodyScroll() {
  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.paddingRight = scrollbarWidth + 'px';
  document.documentElement.style.overflowY = 'hidden';
}

function unlockBodyScroll() {
  document.documentElement.style.overflowY = '';
  document.body.style.paddingRight = '';
}

// (TPT456) Detaches the expanded overlay's placement listeners (ResizeObserver, window resize +
// scroll). The scroll handler also stays on state.hoverScrollHandler for collapseCard()'s
// existing removal, but setupCardInteractions() blanks that field on re-render without removing
// the listener, so the teardown owns its removal too.
let expandedPlacementTeardown = null;

export function expandCard(card, mode = 'pinned') {
  collapseCard();
  state.expandedCardMode = mode;
  const rect = card.getBoundingClientRect();
  const computedStyle = getComputedStyle(card);

  // Freeze the container's height so siblings below don't jump when the card goes
  // position:fixed. (C1580) .tier-cards/.backlog-card-list/.list-group-cards are wrapping
  // flex rows, not a CSS grid — there is no track list to freeze any more, just height.
  const container = card.closest('.tier-cards, .backlog-card-list, .list-group-cards');
  if (container) {
    container.style.minHeight = container.offsetHeight + 'px';
  }

  // Insert placeholder to hold the card's on-screen width+height while it's position:fixed.
  // (C1580) flex-basis pins the card's actual measured width (its grown --card-max-w extent,
  // not just its variant floor) — the card--wide/card--medium class copy stays too, since
  // .chat-cards-grid (a different, still-grid container) has no flex-basis counterpart.
  const placeholder = document.createElement('div');
  placeholder.className = 'card-placeholder';
  if (card.classList.contains('card--wide')) placeholder.classList.add('card--wide');
  else if (card.classList.contains('card--medium')) placeholder.classList.add('card--medium');
  placeholder.style.flex = `0 0 ${rect.width}px`;
  placeholder.style.height = rect.height + 'px';
  placeholder.style.marginBottom = computedStyle.marginBottom;
  placeholder._frozenContainer = container;
  card.parentNode.insertBefore(placeholder, card);

  if (mode === 'pinned') {
    const backdrop = document.createElement('div');
    backdrop.className = 'card-overlay-backdrop';
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', () => {
      state.selectedCardId = null;
      clearHighlights();
      clearChainHighlights();
      clearFocusActive();
      collapseCard();
    });
    lockBodyScroll();
  }
  card.classList.add('card-expanded');
  card.style.position = 'fixed';
  card.style.left = rect.left + 'px';
  card.style.width = rect.width + 'px';
  // (C1433) kept in sync with .card.chain-hl's z-index: 100 in styles.css — an
  // expanded objective card must stack above the ringed subtask cards behind it.
  card.style.zIndex = '101';
  // (TPT303) A chat proposal overlay may use the whole viewport height (10px margins) so most
  // proposals open without scrolling; board cards keep 80vh. Preview overlays still scroll as a
  // whole (inline overflowY); a board card's .card-desc is its only scroller (TPT344).
  const isPreviewOverlay = card.matches('.card--preview, .preview-card');
  if (isPreviewOverlay) card.style.overflowY = 'auto';

  // (TPT456) Placement is re-run whenever the card's real height can change — its own size
  // (late images, the title marquee, anything still settling), a window resize, or a window
  // scroll — instead of being estimated once at expand time. Measuring the laid-out
  // offsetHeight (already capped by max-height) means the overlay is never left hanging off
  // the bottom of the viewport; ResizeObserver callbacks run after layout and before paint,
  // so a correction never shows a frame offscreen.
  // (TPT472) Anchor rule: top/left come from the placeholder's LIVE rect on every run — it sits
  // in the card's resting slot, so it follows both scroll and layout shifts above it (a card
  // above dropping its peek controls, a late image). A top frozen at expand time only tracked
  // scroll and left the overlay hanging ~56px below its slot. The body is observed too, so a
  // shift above the slot re-runs placement even when the card itself doesn't resize.
  const scrollYAtExpand = window.scrollY;
  const placeExpanded = () => {
    if (!card.isConnected || !card.classList.contains('card-expanded')) return;
    const viewportHeight = window.innerHeight;
    card.style.maxHeight = expandedCardMaxHeight({ viewportHeight, isPreview: card.classList.contains('preview-card') }) + 'px';
    const slot = placeholder.isConnected ? placeholder.getBoundingClientRect() : null;
    if (slot) card.style.left = slot.left + 'px';
    const top = clampExpandedTop({
      anchorTop: resolveAnchorTop({ slotTop: slot?.top, expandTop: rect.top, scrollDelta: window.scrollY - scrollYAtExpand }),
      height: card.offsetHeight,
      viewportHeight,
    });
    card.style.top = top + 'px';
  };
  placeExpanded();

  state.hoverScrollHandler = placeExpanded;
  window.addEventListener('scroll', placeExpanded, { passive: true });
  window.addEventListener('resize', placeExpanded);
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(placeExpanded) : null;
  if (resizeObserver) {
    resizeObserver.observe(card);
    resizeObserver.observe(document.body);
  }
  expandedPlacementTeardown = () => {
    window.removeEventListener('resize', placeExpanded);
    window.removeEventListener('scroll', placeExpanded);
    if (resizeObserver) resizeObserver.disconnect();
  };
}

export function collapseCard() {
  state.expandedCardMode = null;
  if (expandedPlacementTeardown) {
    expandedPlacementTeardown();
    expandedPlacementTeardown = null;
  }
  if (state.hoverScrollHandler) {
    window.removeEventListener('scroll', state.hoverScrollHandler);
    state.hoverScrollHandler = null;
  }
  const expanded = document.querySelector('.card-expanded');
  if (expanded) {
    // Remove placeholder that was holding grid space and unfreeze container
    const placeholder = expanded.previousElementSibling;
    if (placeholder && placeholder.classList.contains('card-placeholder')) {
      if (placeholder._frozenContainer) {
        placeholder._frozenContainer.style.minHeight = '';
      }
      placeholder.remove();
    }
    expanded.style.transition = 'none';
    expanded.classList.remove('card-expanded');
    expanded.style.position = '';
    expanded.style.top = '';
    expanded.style.left = '';
    expanded.style.width = '';
    expanded.style.zIndex = '';
    expanded.style.maxHeight = '';
    expanded.style.overflowY = '';
    // (TPT344) Back at rest the description is overflow: hidden — a leftover scroll offset would
    // show a mid-text slice with no way to scroll it back.
    const expandedDesc = expanded.querySelector(':scope > .card-desc');
    if (expandedDesc) expandedDesc.scrollTop = 0;
    expanded.offsetHeight;
    expanded.style.transition = '';
  }
  const backdrop = document.querySelector('.card-overlay-backdrop');
  if (backdrop) backdrop.remove();
  unlockBodyScroll();
}

// ── Dependency highlighting ──

export function highlightCardAndDeps(id) {
  const appEl = document.getElementById('app');
  const card = appEl.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;
  const color = CHAIN_COLORS[state.chainHighlightColorIndex % CHAIN_COLORS.length];
  const shadowValue = `0 0 0 3px ${color}, 0 2px 8px ${color}40`;
  card.classList.add('chain-hl');
  card.style.setProperty('--chain-hl-shadow', shadowValue);
  card.style.setProperty('--chain-hl-color', color);
  const deps = JSON.parse(card.dataset.deps || '[]');
  for (const depId of deps) {
    const dep = appEl.querySelector(`.card[data-id="${depId}"]`);
    if (dep) {
      dep.classList.add('chain-hl');
      dep.style.setProperty('--chain-hl-shadow', shadowValue);
      dep.style.setProperty('--chain-hl-color', color);
    }
  }
}

export function clearHighlights() {
  const appEl = document.getElementById('app');
  appEl.querySelectorAll('.card.chain-hl').forEach(c => {
    if (!c.dataset.depColor) {
      c.classList.remove('chain-hl');
      c.style.removeProperty('--chain-hl-shadow');
      c.style.removeProperty('--chain-hl-color');
    }
  });
}

export function getFullDependencyChain(originId) {
  const appEl = document.getElementById('app');
  const allCards = appEl.querySelectorAll('.card[data-id]');
  const visited = new Set();
  const dependedOnBy = {};
  allCards.forEach(card => {
    const cardId = card.dataset.id;
    const deps = JSON.parse(card.dataset.deps || '[]');
    for (const depId of deps) {
      if (!dependedOnBy[depId]) dependedOnBy[depId] = new Set();
      dependedOnBy[depId].add(cardId);
    }
  });
  const queue = [originId];
  visited.add(originId);
  while (queue.length > 0) {
    const current = queue.shift();
    const card = appEl.querySelector(`.card[data-id="${current}"]`);
    if (!card) continue;
    const deps = JSON.parse(card.dataset.deps || '[]');
    for (const depId of deps) {
      if (!visited.has(depId)) { visited.add(depId); queue.push(depId); }
    }
    const downstreamIds = dependedOnBy[current] || new Set();
    for (const downId of downstreamIds) {
      if (!visited.has(downId)) { visited.add(downId); queue.push(downId); }
    }
  }
  return visited;
}

export function clearChainHighlights() {
  const appEl = document.getElementById('app');
  appEl.querySelectorAll('.card.chain-hl').forEach(c => {
    c.classList.remove('chain-hl');
    c.style.removeProperty('--chain-hl-shadow');
    c.style.removeProperty('--chain-hl-color');
    delete c.dataset.depColor;
  });
  appEl.querySelectorAll('.card.chain-blur').forEach(c => {
    c.classList.remove('chain-blur');
  });
  appEl.querySelectorAll('.btn-chain-deps.active').forEach(b => {
    b.classList.remove('active');
  });
  // (C1569) applyRelatedHighlight() can ring the drill-down board's .parent-task-pane
  // (not a .card) — clear it here too, same as the .card.chain-hl loop above.
  document.querySelectorAll('.parent-task-pane.chain-hl').forEach(p => {
    p.classList.remove('chain-hl');
    p.style.removeProperty('--chain-hl-shadow');
    p.style.removeProperty('--chain-hl-color');
  });
  state.chainHighlightedTaskId = null;
  state.chainHighlightMode = 'deps';
}

function clearFocusActive() {
  document.getElementById('app')
    .querySelectorAll('.btn-focus-card.active')
    .forEach(b => b.classList.remove('active'));
}

// (C1569) Shared ring-application loop — was duplicated inline in applyChainHighlight()
// and applyObjectiveHighlight(); now also backs applyRelatedHighlight(). Adds .chain-hl +
// the two custom properties + data-depColor to each id in `ids` that has a rendered card,
// and un-collapses that card's tier if collapsed. Blur is intentionally NOT handled here —
// callers have different blur rules (unconditional vs. the C1460 "ring-only if alone" guard).
function _ringCards(appEl, ids, color, shadowValue) {
  for (const id of ids) {
    const card = appEl.querySelector(`.card[data-id="${id}"]`);
    if (!card) continue;
    card.classList.add('chain-hl');
    card.style.setProperty('--chain-hl-shadow', shadowValue);
    card.style.setProperty('--chain-hl-color', color);
    card.dataset.depColor = color;
    const tier = card.closest('.tier');
    if (tier && tier.classList.contains('collapsed')) {
      const p = Number(tier.dataset.priority);
      tier.classList.remove('collapsed');
      state.collapsedTiers.delete(p);
      state.expandedTiers.add(p);
    }
  }
}

export function applyChainHighlight(taskId) {
  const appEl = document.getElementById('app');
  const color = CHAIN_COLORS[state.chainHighlightColorIndex % CHAIN_COLORS.length];
  state.chainHighlightColorIndex++;
  const chainIds = getFullDependencyChain(taskId);
  const shadowValue = `0 0 0 3px ${color}, 0 2px 8px ${color}40`;
  const allCards = appEl.querySelectorAll('.card[data-id]');
  _ringCards(appEl, chainIds, color, shadowValue);
  allCards.forEach(card => {
    if (!chainIds.has(card.dataset.id)) {
      card.classList.add('chain-blur');
    }
  });
  const sourceCard = appEl.querySelector(`.card[data-id="${taskId}"]`);
  if (sourceCard) {
    const sourceBtn = sourceCard.querySelector('.btn-chain-deps');
    if (sourceBtn) sourceBtn.classList.add('active');
  }
  state.chainHighlightedTaskId = taskId;
  state.chainHighlightMode = 'deps';
}

// (C1433) Objective-card counterpart to applyChainHighlight() above: rings the clicked
// objective plus its whole subtask subtree (nested objectives included) in one color and
// blurs everything else, instead of walking `data-deps`. Purely DOM-driven, same as
// getFullDependencyChain() — a subtask outside the current sprint window's render is not
// reachable and stays unhighlighted (matches hasChildren's own window-fallback caveat).
export function applyObjectiveHighlight(taskId) {
  const appEl = document.getElementById('app');
  const sourceCard = appEl.querySelector(`.card[data-id="${taskId}"]`);
  if (!sourceCard) return;
  const color = CHAIN_COLORS[state.chainHighlightColorIndex % CHAIN_COLORS.length];
  state.chainHighlightColorIndex++;
  const shadowValue = `0 0 0 3px ${color}, 0 2px 8px ${color}40`;

  const subtreeIds = new Set([taskId]);
  const queue = [sourceCard.dataset.dbId].filter(Boolean);
  while (queue.length > 0) {
    const parentDbId = queue.shift();
    appEl.querySelectorAll(`.card[data-parent-db-id="${parentDbId}"]`).forEach(child => {
      const childId = child.dataset.id;
      if (subtreeIds.has(childId)) return; // guard against a parent_id cycle in the data
      subtreeIds.add(childId);
      if (child.dataset.dbId) queue.push(child.dataset.dbId);
    });
  }

  const allCards = appEl.querySelectorAll('.card[data-id]');
  _ringCards(appEl, subtreeIds, color, shadowValue);
  // (C1460) subtreeIds is just {taskId} whenever every child this objective actually has is
  // grouping-hidden (objective grouping ON, the normal case) or out of the sprint window
  // (the pre-existing caveat above) — blurring the rest of the board to ring one card alone
  // reads as "the whole board vanished" rather than a highlight. Ring-only, no blur, in that
  // case; the click is still a pin-expand via expandCard() at the call site.
  if (subtreeIds.size > 1) {
    allCards.forEach(card => {
      if (!subtreeIds.has(card.dataset.id)) {
        card.classList.add('chain-blur');
      }
    });
  }
  state.chainHighlightedTaskId = taskId;
  state.chainHighlightMode = 'objective';
}

// (C1569) "Highlight Related" — the .btn-chain-deps click and the Task Edit Modal's
// matching "chain" action both route here now, so the button's C1568 label ("Highlight
// Related") matches what it actually rings: the dependency chain (getFullDependencyChain,
// both directions) UNION the card's family (collectFamilyIds — its own subtask descendants,
// its parent objective, and that parent's other children/siblings). Purely DOM-driven, same
// caveats as the two functions above: a card outside the current sprint window's render, or
// hidden by objective grouping, is unreachable and stays unhighlighted.
export function applyRelatedHighlight(taskId) {
  const appEl = document.getElementById('app');
  const sourceCard = appEl.querySelector(`.card[data-id="${taskId}"]`);
  if (!sourceCard) return;
  const color = CHAIN_COLORS[state.chainHighlightColorIndex % CHAIN_COLORS.length];
  state.chainHighlightColorIndex++;
  const shadowValue = `0 0 0 3px ${color}, 0 2px 8px ${color}40`;

  const allCards = appEl.querySelectorAll('.card[data-id]');
  const nodes = [...allCards].map(c => ({
    id: c.dataset.id,
    dbId: c.dataset.dbId || null,
    parentDbId: c.dataset.parentDbId || null,
  }));
  const chainIds = getFullDependencyChain(taskId);
  const familyIds = collectFamilyIds(nodes, taskId);
  const relatedIds = new Set([...chainIds, ...familyIds]);

  _ringCards(appEl, relatedIds, color, shadowValue);

  // (C1569) Drill-down board renders the parent objective as a .parent-task-pane, not a
  // .card — ring that too when it's present, so "Highlight Related" on a subtask actually
  // shows its parent in the view where this button is used most.
  const parentDbId = sourceCard.dataset.parentDbId || '';
  let parentPane = null;
  if (parentDbId) {
    parentPane = document.querySelector(`.parent-task-pane[data-db-id="${CSS.escape(parentDbId)}"]`);
    if (parentPane) {
      parentPane.classList.add('chain-hl');
      parentPane.style.setProperty('--chain-hl-shadow', shadowValue);
      parentPane.style.setProperty('--chain-hl-color', color);
    }
  }

  // (C1460-style guard) Blurring the rest of the board to ring one card alone reads as "the
  // whole board vanished" rather than a highlight — only blur once something besides the
  // source card itself was actually ringed.
  if (relatedIds.size > 1 || parentPane) {
    allCards.forEach(card => {
      if (!relatedIds.has(card.dataset.id)) {
        card.classList.add('chain-blur');
      }
    });
  }

  const sourceBtn = sourceCard.querySelector('.btn-chain-deps');
  if (sourceBtn) sourceBtn.classList.add('active');
  state.chainHighlightedTaskId = taskId;
  state.chainHighlightMode = 'related';
}

// ── Pointer-based drag-to-reorder helpers ──

function _findInsertionIndex(tierCards, cursorX, cursorY, sourceCard) {
  const placeholder = tierCards.querySelector('.card-drag-placeholder');
  const children = [...tierCards.children].filter(el =>
    el !== sourceCard && el !== placeholder && el.classList.contains('card')
  );
  if (children.length === 0) return -1;

  const rects = children.map(el => {
    const r = el.getBoundingClientRect();
    return { el, cx: r.left + r.width / 2, cy: r.top + r.height / 2, h: r.height };
  });

  // Sort reading order (row then column)
  rects.sort((a, b) => {
    const rowThreshold = Math.min(a.h, b.h) * 0.5;
    if (Math.abs(a.cy - b.cy) > rowThreshold) return a.cy - b.cy;
    return a.cx - b.cx;
  });

  for (const item of rects) {
    const rowThreshold = item.h * 0.5;
    const sameRow = Math.abs(item.cy - cursorY) <= rowThreshold;
    if (sameRow) {
      if (item.cx > cursorX) return children.indexOf(item.el);
    } else if (item.cy > cursorY) {
      return children.indexOf(item.el);
    }
  }
  return -1;
}

function _resolveDropTierAtPoint(cursorX, cursorY) {
  const tiers = [...document.querySelectorAll('.tier-cards')].filter(tier => tier.isConnected);
  const hit = document.elementFromPoint(cursorX, cursorY);
  const directHitTier = hit?.closest?.('.tier-cards') || null;
  const candidates = tiers.map(tier => ({ tier, rect: tier.getBoundingClientRect() }));
  return resolveDropTier({ cursorX, cursorY, directHitTier, candidates });
}

function _startDrag(sourceCard, e) {
  // Capture visual position before collapse — expanded cards may be
  // repositioned (e.g. shifted upward for bottom-of-viewport cards)
  const visualRect = sourceCard.getBoundingClientRect();

  // Dismiss expanded card, backdrop, and selection state
  const wasExpanded = sourceCard.classList.contains('card-expanded');
  collapseCard();
  if (wasExpanded) {
    state.selectedCardId = null;
    clearHighlights();
    clearChainHighlights();
    clearFocusActive();
  }

  // Collapsed dimensions for clone sizing and placeholder
  const rect = sourceCard.getBoundingClientRect();

  // Create clone
  const clone = sourceCard.cloneNode(true);
  clone.className = sourceCard.className + ' card-dragging-clone';
  clone.removeAttribute('data-id');
  clone.style.width = rect.width + 'px';
  clone.style.maxHeight = rect.height + 'px';
  clone.style.overflow = 'hidden';
  clone.querySelectorAll('select, button').forEach(el => el.setAttribute('tabindex', '-1'));
  document.body.appendChild(clone);

  // Offset from visual position so clone tracks cursor correctly
  _dragState.offsetX = e.clientX - visualRect.left;
  _dragState.offsetY = e.clientY - visualRect.top;
  _dragState.clone = clone;

  // Position clone at cursor-relative visual position
  clone.style.left = (e.clientX - _dragState.offsetX) + 'px';
  clone.style.top = (e.clientY - _dragState.offsetY) + 'px';

  // Create placeholder with collapsed dimensions. (C1580) flex-basis pins the source card's
  // actual measured width, same reasoning as expandCard()'s placeholder above.
  const placeholder = document.createElement('div');
  placeholder.className = 'card-drag-placeholder';
  placeholder.style.flex = `0 0 ${rect.width}px`;
  placeholder.style.minHeight = rect.height + 'px';
  if (sourceCard.classList.contains('card--wide')) placeholder.classList.add('card--wide');
  else if (sourceCard.classList.contains('card--medium')) placeholder.classList.add('card--medium');

  sourceCard.parentNode.insertBefore(placeholder, sourceCard);
  sourceCard.classList.add('drag-source');
  _dragState.placeholder = placeholder;

  _dragState.tierCards.classList.add('drag-active');

  // (C1578) Reveal empty sprint tiers as cross-sprint drop targets for the gesture. Anchored
  // on the placeholder (the dragged card's stand-in, which never itself moves) so a tier
  // appearing ABOVE it can't shove the board — and the cursor's target — down the page; the
  // hit-test in _onDragMove uses viewport coords via elementFromPoint, so this has to happen
  // synchronously before the gesture's first move, not deferred to any render.
  const anchorBefore = placeholder.getBoundingClientRect().top;
  document.body.classList.add('board-dragging');
  const anchorDelta = placeholder.getBoundingClientRect().top - anchorBefore;
  if (anchorDelta) window.scrollBy(0, anchorDelta);

  _isDragging = true;
}

// Sole teardown for every drag exit. `preserveDropState` removes all visible artifacts
// before async persistence while keeping the render guard active; _onDragEnd's finally calls
// this again without the option to clear state and emit the one drag-ended notification.
// The DOM sweeps are intentional fallbacks: cleanup must also remove an orphaned clone or
// placeholder after its owning _dragState reference has already gone stale.
function _cleanupDrag({ preserveDropState = false } = {}) {
  const dragState = _dragState;
  const hadGesture = !!dragState || _isDragging;
  const { sourceCard, tierCards, currentTier, clone, placeholder } = dragState || {};
  // (C1578) Anchor on tierCards (the source .tier-cards — never removed, unlike the
  // placeholder) so re-hiding the revealed empty tiers can't jump the page under the user.
  // A stale-state self-heal may hold detached nodes, in which case no viewport anchor exists.
  const anchorBefore = tierCards?.isConnected ? tierCards.getBoundingClientRect().top : null;
  clone?.remove();
  placeholder?.remove();
  sourceCard?.classList.remove('drag-source');
  tierCards?.classList.remove('drag-active');
  if (currentTier && currentTier !== tierCards) currentTier.classList.remove('sprint-drop-target');
  document.querySelectorAll('.card-dragging-clone, .card-drag-placeholder').forEach(el => el.remove());
  document.querySelectorAll('.drag-source').forEach(el => el.classList.remove('drag-source'));
  document.querySelectorAll('.tier-cards.drag-active').forEach(el => el.classList.remove('drag-active'));
  document.querySelectorAll('.tier-cards.sprint-drop-target').forEach(el => el.classList.remove('sprint-drop-target'));

  _removeDragListeners();

  if (preserveDropState) return;

  document.body.classList.remove('board-dragging');
  if (anchorBefore !== null && tierCards.isConnected) {
    const anchorDelta = tierCards.getBoundingClientRect().top - anchorBefore;
    if (anchorDelta) window.scrollBy(0, anchorDelta);
  }

  _isDragging = false;
  _dropInProgress = false;
  _dragState = null;

  if (hadGesture) document.dispatchEvent(new CustomEvent('tiptask:drag-ended'));
}

function _onDragMove(e) {
  if (!_dragState) return;

  // (C1438) Lost mouseup — button released outside the window / swallowed elsewhere.
  if (e.buttons === 0) { _cleanupDrag(); return; }

  // (C1438) Self-heal: source card or its tier got detached by a re-render this module's
  // own guard failed to catch. Degrades to "drag does nothing" instead of committing the
  // drop against a dead subtree and writing garbage `order` values.
  if (isDragStateStale(_dragState)) {
    _cleanupDrag();
    return;
  }

  const dx = e.clientX - _dragState.startX;
  const dy = e.clientY - _dragState.startY;

  if (!_dragState.activated) {
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    _startDrag(_dragState.sourceCard, e);
    _dragState.activated = true;
  }

  const clone = _dragState.clone;
  clone.style.left = (e.clientX - _dragState.offsetX) + 'px';
  clone.style.top = (e.clientY - _dragState.offsetY) + 'px';

  // Resolve against fresh rectangles for every rendered sprint. elementFromPoint() alone
  // can miss on gaps/overlays or return a stale/source node; geometry keeps cross-sprint and
  // revealed-empty-sprint targets available from the cursor's current viewport position.
  const targetTier = _resolveDropTierAtPoint(e.clientX, e.clientY);

  const placeholder = _dragState.placeholder;
  const prevTier = _dragState.currentTier;
  const sourceTier = _dragState.tierCards;

  if (targetTier && targetTier !== prevTier) {
    // Leave highlight on source tier via drag-active; toggle sprint-drop-target for others
    if (prevTier && prevTier !== sourceTier) prevTier.classList.remove('sprint-drop-target');
    if (targetTier !== sourceTier) targetTier.classList.add('sprint-drop-target');
    _dragState.currentTier = targetTier;
    // Move placeholder into new tier
    targetTier.appendChild(placeholder);
  }

  const activeTier = _dragState.currentTier || sourceTier;
  const insertIdx = _findInsertionIndex(activeTier, e.clientX, e.clientY, _dragState.sourceCard);

  if (insertIdx === -1) {
    activeTier.appendChild(placeholder);
  } else {
    const visibleCards = [...activeTier.children].filter(el =>
      el !== _dragState.sourceCard && el !== placeholder && el.classList.contains('card')
    );
    const refCard = visibleCards[insertIdx];
    if (refCard && refCard !== placeholder.nextElementSibling) {
      activeTier.insertBefore(placeholder, refCard);
    }
  }
}

async function _onDragEnd(e) {
  if (!_dragState) return;

  if (!_dragState.activated) {
    _cleanupDrag();
    return;
  }

  const { tierCards: sourceTier, currentTier, sourceCard, placeholder } = _dragState;
  // Resolve once more at mouseup: the pointer can enter a tier without delivering another
  // mousemove first. Fall back to the last valid tier so releasing just outside the board
  // retains the existing sticky-target behavior.
  const targetTier = _resolveDropTierAtPoint(e.clientX, e.clientY) || currentTier || sourceTier;
  const crossSprint = targetTier !== sourceTier;

  if (targetTier !== currentTier) {
    targetTier.appendChild(placeholder);
    _dragState.currentTier = targetTier;
  }

  _dropInProgress = true;
  try {
    // Move source card to placeholder's position in target tier
    targetTier.insertBefore(sourceCard, placeholder);
    // Remove fixed-position clone/placeholder immediately instead of leaving them visible
    // during PATCHes. Keep _dragState/_dropInProgress until finally so full renders remain
    // suppressed and the drag-ended event fires only after persistence finishes.
    _cleanupDrag({ preserveDropState: true });

    if (crossSprint) {
      const targetPriority = Number(targetTier.closest('.tier')?.dataset.priority);
      const movedId = sourceCard.dataset.id;

      // PATCH moved card first: new priority + order based on position in target tier —
      // the two re-rank groups below are keyed off values that assume this already landed.
      const targetOrdered = [...targetTier.querySelectorAll('.card[data-id]')].map(c => c.dataset.id);
      const movedIdx = targetOrdered.indexOf(movedId);
      const movedOrder = targetOrdered.length - 1 - movedIdx;
      await _patchTask(movedId, { priority: targetPriority, order: movedOrder }, 'Cross-sprint');

      // (C1438) Re-rank remaining cards in source tier and target tier in parallel — these
      // PATCHes target disjoint task keys (source tier no longer holds the moved card; the
      // target re-rank explicitly skips it), so there is no write-write race. Was a serial
      // await-per-card loop, which held _dropInProgress (and so the drag mousedown guard)
      // open for one round-trip per card in both tiers combined.
      const sourceOrdered = [...sourceTier.querySelectorAll('.card[data-id]')].map(c => c.dataset.id);
      await Promise.all([
        ...sourceOrdered.map((id, i) =>
          _patchTask(id, { order: sourceOrdered.length - 1 - i }, 'Source reorder')),
        ...targetOrdered
          .map((id, i) => ({ id, order: targetOrdered.length - 1 - i }))
          .filter(({ id }) => id !== movedId)
          .map(({ id, order }) => _patchTask(id, { order }, 'Target reorder')),
      ]);
    } else if (!getSprintsEnabled()) {
      // (C1333) Flat mode: a single .tier spans every sprint (crossSprint is always false
      // here — see the `.tier--flat` render), so a same-container drop can still cross a
      // priority boundary. Adopt the priority of whichever neighbour the card landed next
      // to — `data-priority` already lives on every card (task-card.js renderCard). Re-rank
      // only among siblings that already share that priority, not the whole flat list —
      // unlike the cross-sprint branch above, the flat tier mixes every sprint's cards, so a
      // full-list re-rank would clobber unrelated sprints' order values.
      const movedId = sourceCard.dataset.id;
      const neighbourCard = sourceCard.nextElementSibling?.classList?.contains('card')
        ? sourceCard.nextElementSibling
        : sourceCard.previousElementSibling?.classList?.contains('card')
          ? sourceCard.previousElementSibling
          : null;
      const targetPriority = neighbourCard
        ? (Number(neighbourCard.dataset.priority) || 0)
        : (Number(sourceCard.dataset.priority) || 0);
      const siblingsInGroup = [...targetTier.querySelectorAll('.card[data-id]')]
        .filter(c => (Number(c.dataset.priority) || 0) === targetPriority);
      const movedIdx = siblingsInGroup.indexOf(sourceCard);
      const movedOrder = movedIdx === -1 ? 0 : siblingsInGroup.length - 1 - movedIdx;
      await _patchTask(movedId, { priority: targetPriority, order: movedOrder }, 'Flat reorder');
    } else {
      // (C1438) Same-tier reorder — disjoint task keys, parallelised (was a serial loop).
      const ordered = [...targetTier.querySelectorAll('.card[data-id]')].map(c => c.dataset.id);
      await Promise.all(ordered.map((id, i) =>
        _patchTask(id, { order: ordered.length - 1 - i }, 'Reorder')));
    }

    state.pendingRestoreContext = {
      scrollY: window.scrollY,
      cardId: state.selectedCardId,
      cardMode: state.expandedCardMode,
    };

    // (C1438) forceFresh so this render reflects the order just written instead of the
    // pre-drop cached snapshot (nothing on this path invalidates _boardTaskCache, so a
    // plain loadAndRender() would repaint stale order and visually revert the drop).
    // afterDrop escapes the drag-suppression choke point in loadAndRender() itself — that
    // guard would otherwise defer this exact render, since _dropInProgress is still true.
    if (_onLoadAndRender) await _onLoadAndRender({ forceFresh: true, afterDrop: true });
  } catch (err) {
    // A thrown insertBefore/PATCH still reaches the same teardown as every other exit.
    console.error('[drag] drop failed:', err);
  } finally {
    _cleanupDrag();
  }
}

function _onDragKeydown(e) {
  if (e.key === 'Escape' && _dragState) _cleanupDrag();
}

// ── In-place card refresh (called after modal Save; avoids full board reload) ──

export function refreshCard(t) {
  if (!t || !t.id) return;
  const card = document.querySelector(`.card[data-id="${CSS.escape(t.id)}"]`);
  if (!card) return; // card detached (e.g. sprint move pending reload) — no-op
  if (state.taskMergeStatus) syncTaskMergeCard(card);

  // (TPT374) The console-control button's icon/caption now depends on status (an in-progress
  // task with a live session paints a spinner, not the plain play icon) — a status-only patch
  // used to leave a stale button until the next session/attention event repainted it.
  const prevStatus = card.dataset.status;
  const statusChanged = prevStatus !== t.status;

  // data-attributes
  card.dataset.status = t.status;
  card.dataset.statusRole = statusRoleToken(t.status);
  if (t.priority != null) card.dataset.priority = t.priority;
  card.dataset.assignee = t.assignee ?? '';
  card.dataset.agentAssignee = t.agentAssignee || '';
  card.dataset.piModel = t.piModel || '';
  // (C1340) applyTaskPatch() below forces a full 'reload' whenever isObjective
  // actually flips (the controls-row button swap isn't worth duplicating here),
  // so this keeps the dataset/class mirror correct for the common unchanged case.
  card.dataset.objective = t.isObjective ? '1' : '';
  card.classList.toggle('objective-highlight', !!t.isObjective);
  // (C1433) keep the objective-highlight subtree walk's DOM anchors correct across patches
  card.dataset.dbId = t.dbId ?? '';
  card.dataset.parentDbId = t.parentDbId ?? '';
  // (C1387) In-place patch runs after the initial render — re-assert from live state in case
  // a clear happened in the gap between render and this patch.
  card.classList.toggle('needs-attention', isAttentionRaised(t.id));
  // (TPT12) Same reason — the activity chip is a real DOM element, not a class, so an
  // in-place patch that skips this silently drops it the moment anyone edits the task.
  refreshActivityChip(card);
  // (TPT272/TPT283) Keep the discuss/split lock styling/Start removal across in-place patches.
  applyDiscussLock(card);
  card.dataset.deps = JSON.stringify(t.dependencies || []);
  card.dataset.tags = JSON.stringify(t.tags || []);

  // agent badge — mirror renderCard() so task:updated patches immediately show
  // the selected agent after Start, reassignment, or unassignment.
  card.querySelector('.agent-badge')?.remove();
  const agentAssignee = t.agentAssignee || '';
  card.classList.toggle('has-agent-badge', !!agentAssignee);
  // (TPT285) effort chip — same remove-and-reinsert mirror of renderCard().
  card.querySelector('.effort-badge')?.remove();
  const effortBadge = renderEffortBadge({ ...t, agentAssignee });
  card.classList.toggle('has-effort-badge', !!effortBadge);
  if (effortBadge) card.insertAdjacentHTML('beforeend', effortBadge);
  if (agentAssignee) {
    const agentBadge = renderAgentBadge({ ...t, agentAssignee });
    if (agentBadge) {
      card.insertAdjacentHTML('beforeend', agentBadge);
      const badge = card.querySelector('.agent-badge');
      if (badge) bindAgentBadge(badge);
    }
  }

  // board-card status select (.card-status-select; not .status-select which is list/todo view)
  const sel = card.querySelector('.card-status-select');
  if (sel) {
    sel.value = t.status;
    sel.dataset.current = t.status;
    sel.className = 'card-status-select card-ctl';
    sel.style.setProperty('--status-color', statusColor(t.status));
  }

  // title (skip while user has inline-edited the element)
  const titleEl = card.querySelector('.card-title');
  if (titleEl && !titleEl.isContentEditable) {
    const inner = titleEl.querySelector('.card-title-inner');
    if (inner) inner.textContent = t.title;
    titleEl.title = t.title;
    // (C1580) recompute the flex-grow ceiling for the new title — variant (base/medium/wide)
    // is read off the card's own classList rather than re-derived from description length,
    // matching this function's existing behavior of not live-patching card--wide/card--medium.
    const variant = card.classList.contains('card--wide') ? 'wide'
      : card.classList.contains('card--medium') ? 'medium' : 'base';
    const cardMaxW = cardMaxWidthPx({ title: t.title, taskKey: t.id, variant, measureTitle: _measureTitle });
    card.style.setProperty('--card-max-w', `${cardMaxW}px`);
  }

  // description (skip while user is inline-editing)
  const descEl = card.querySelector('.card-desc');
  if (descEl && !descEl.isContentEditable) {
    descEl.dataset.raw = t.description;
    descEl.innerHTML = renderMarkdown(truncateMarkdownAtParagraph(t.description, MAX_DESC_LEN));
  }

  // tags — use renderTagBadge so tooltips match renderCard output
  const existingTags = card.querySelector('.card-tags');
  if (t.tags && t.tags.length) {
    const html = t.tags.map(tag => renderTagBadge(tag, state.tagDescriptions)).join('');
    if (existingTags) {
      existingTags.innerHTML = html;
    } else if (descEl) {
      descEl.insertAdjacentHTML('afterend', `<div class="card-tags">${html}</div>`);
    }
  } else if (existingTags) {
    existingTags.remove();
  }

  // deps hover label (C1076) — kept in sync with renderCard's .card-deps-label;
  // data-deps above was already updated, this just mirrors it into the visible
  // (hover-only) text so a deps-only save doesn't leave stale text until reload.
  const depsLabel = card.querySelector('.card-deps-label');
  const depsText = (t.dependencies || []).join(', ');
  if (depsText) {
    const label = `Deps: ${depsText}`;
    if (depsLabel) {
      depsLabel.textContent = label;
      depsLabel.title = label;
    } else {
      card.querySelector('.hover-controls-inner')?.insertAdjacentHTML('beforeend',
        `<span class="card-deps-label" title="${escapeAttr(label)}">${escapeAttr(label)}</span>`);
    }
  } else if (depsLabel) {
    depsLabel.remove();
  }

  // (TPT374) A status-only patch (WS task:updated, the board's own status <select>, or the
  // edit modal's Save) never used to repaint the console-control button — stale play/spinner
  // until the next unrelated session/attention event happened to call updateClaudeButtons().
  // Scoped to cards that actually carry the button, since updateClaudeButtons() repaints every
  // mounted .btn-claude/.btn-start-discussion on the page, not just this one.
  if (statusChanged && card.querySelector('.btn-claude, .btn-start-discussion')) updateClaudeButtons();
}

// ── Sprint regroup: instantly moves an existing card to a new sprint tier ──
//
// Returns:
//   'moved'   — card element was re-parented into the target tier, source tier still has cards
//   'emptied' — same as 'moved', but the move left the SOURCE tier with zero cards (C1578) —
//               the source is hidden instantly, but caller must still reload to recompute its
//               stale .tier-badge count (that recount lives only in renderBoardContent)
//   'removed' — card was removed (Backlog / priority-0 destination — correct on board view)
//   'reload'  — card not in DOM or target tier not rendered; caller must reload
//
// Use regroupMovedCard()/regroupNeedsReload() below rather than comparing these literals
// directly — keeps every call site in sync with this alphabet.
export function regroupCardToSprint(taskId, newPriority, isBacklog) {
  // (C1438) Re-parenting the card currently being dragged would move the exact DOM node
  // _dragState holds a reference to out from under the gesture. Caller's 'reload' fallback
  // is deferred by the drag-suppression choke point until the drag ends, then re-applied.
  if (isDragSourceId(taskId)) return 'reload';
  const card = document.querySelector(`.card[data-id="${CSS.escape(taskId)}"]`);
  if (!card) return 'reload'; // paginated / not yet rendered

  // (C1578) Capture BEFORE any mutation — this is the tier the card is leaving.
  const sourceTierCards = card.closest('.tier-cards');

  if (isBacklog) {
    card.remove();
    _hideIfEmptied(sourceTierCards, null);
    return 'removed';
  }

  const p = Number(newPriority);
  const targetTier = document.querySelector(`.tier[data-priority="${p}"] .tier-cards`);
  if (!targetTier) return 'reload'; // new sprint not yet rendered

  // Expand target tier in state + DOM
  if (state.collapsedTiers) state.collapsedTiers.delete(p);
  if (state.expandedTiers) state.expandedTiers.add(p);
  const tierEl = targetTier.closest('.tier');
  if (tierEl) {
    tierEl.classList.remove('collapsed');
    // (C1578) The destination lookup above matches a hidden (card-less) tier just as well as
    // a visible one — without this the card gets inserted into a display:none container and
    // silently vanishes from view.
    tierEl.classList.remove(HIDE_CLASS);
  }

  // Insert at top (before first existing card, above the sentinel)
  card.dataset.priority = p;
  const firstCard = targetTier.querySelector('.card[data-id]');
  const sentinel = targetTier.querySelector('.tier-drop-sentinel');
  if (firstCard) {
    targetTier.insertBefore(card, firstCard);
  } else if (sentinel) {
    targetTier.insertBefore(card, sentinel);
  } else {
    targetTier.appendChild(card);
  }

  return _hideIfEmptied(sourceTierCards, targetTier) ? 'emptied' : 'moved';
}

// (C1578) Hides the source tier in place if the move/remove left it card-less. `targetTier`
// guards against a same-tier no-op "move" hiding the tier it just re-inserted into.
function _hideIfEmptied(sourceTierCards, targetTier) {
  if (!sourceTierCards || sourceTierCards === targetTier) return false;
  const stillHasCards = sourceTierCards.querySelector(':scope > .card[data-id]');
  if (stillHasCards) return false;
  sourceTierCards.closest('.tier')?.classList.add(HIDE_CLASS);
  return true;
}

// A 'moved' or 'emptied' result means the card element itself was successfully re-parented —
// its field values still need a refreshCard()/refreshParentSubtaskLabel() pass.
export function regroupMovedCard(result) {
  return result === 'moved' || result === 'emptied';
}

// Any of these means a caller must force a fresh loadAndRender() to recompute what a DOM
// patch alone can't: a new sprint's tier badge, the emptied source's stale badge, etc.
export function regroupNeedsReload(result) {
  return result === 'reload' || result === 'removed' || result === 'emptied';
}

// (C1259) Combines regroupCardToSprint()'s tier-move decision with refreshCard()'s field
// patch into the one call every single-card mutation site needs — shared by the board
// WS's task:updated handler (template.html) and every direct-mutation click handler
// (status-change confirm, agent-badge assign, subtask radio, To-Do checkbox/drawer
// status) that used to fall back to a full loadAndRender() just to reflect one card's
// new field values. Was two near-identical field-patch blocks (this file's refreshCard()
// and a template.html-local copy inside the WS handler) — now one.
// Returns 'patched' | 'moved' | 'removed' | 'reload'. 'reload' means the card isn't
// currently in the DOM (filtered/collapsed/paginated out) or its target tier isn't
// rendered — the caller must fall back to loadAndRender(). (C1340) Also returned when
// the objective/hasChildren flip below means .controls-row's button choice is stale.
export function applyTaskPatch(t) {
  if (!t || !t.id) return 'reload';
  const card = document.querySelector(`.card[data-id="${CSS.escape(t.id)}"]`);
  if (!card) return 'reload';

  // (C1453) Snapshot BEFORE refreshCard() below overwrites data-status/data-parent-db-id —
  // refreshParentSubtaskLabel() needs the pre-patch status (to know whether this write
  // crossed the closed-role boundary) and the parent link (parentDbId isn't always on `t`
  // itself — the PATCH-response callers only send it when the API returned it — so the
  // card's own last-known data-parent-db-id is the fallback).
  const prevStatus = card.dataset.status || '';
  const parentDbIdHint = card.dataset.parentDbId || '';

  // (C1340) refreshCard() only patches field values — it never rebuilds
  // .controls-row, so an isObjective flip (Start/Subtasks <-> the yellow/green
  // objective buttons) or a hasChildren flip on an already-objective card
  // (yellow "Create Subtasks" <-> green "Subtasks N/M", C1436) would leave the wrong
  // button mounted. Force a full reload in either case rather than duplicating
  // renderCard()'s button-choice branching here.
  const wasObjective = card.dataset.objective === '1';
  const isObjective = !!t.isObjective;
  if (wasObjective !== isObjective) return 'reload';
  if (isObjective) {
    const showedSubtasks = !!card.querySelector('.btn-subtasks-show');
    if (showedSubtasks !== !!t.hasChildren) return 'reload';
  }

  const currentTierEl = card.closest('[data-priority]');
  const currentTierPriority = currentTierEl ? Number(currentTierEl.dataset.priority) : null;
  const currentBacklogEl = card.closest('.backlog-section');
  const nextPriority = t.priority ?? null;
  const nextIsBacklog = t.sprint_id === null || t.sprintId === null
    || (nextPriority !== null && nextPriority !== '' && Number(nextPriority) === 0);
  const tierChanged = (currentBacklogEl && !nextIsBacklog)
    || (currentTierPriority !== null && (nextIsBacklog || currentTierPriority !== (t.priority ?? null)));

  if (tierChanged) {
    const result = regroupCardToSprint(t.id, t.priority, nextIsBacklog);
    if (regroupMovedCard(result)) {
      refreshCard(t); // field values still need updating post-move
      refreshParentSubtaskLabel(t, { prevStatus, parentDbId: t.parentDbId ?? parentDbIdHint });
    }
    return result;
  }

  refreshCard(t);
  refreshParentSubtaskLabel(t, { prevStatus, parentDbId: t.parentDbId ?? parentDbIdHint });
  return 'patched';
}

// (C1259) Removes a card's DOM node and hides its tier if now empty — shared by the
// board WS's task:deleted handler and showDeleteConfirmModal() (task-board.js), which
// both used to differ only in whether they trusted this DOM patch or fell back to a
// full loadAndRender() for the exact same effect.
export function removeCardFromDom(taskId) {
  // (C1438) Deleting the card currently being dragged would let _onDragEnd's
  // `targetTier.insertBefore(sourceCard, placeholder)` resurrect a just-deleted card.
  // Caller (task:deleted WS handler) simply drops the DOM patch; the drag's own cleanup
  // (self-heal in _onDragMove, or the eventual re-render once the drag ends) reconciles it.
  if (isDragSourceId(taskId)) return false;
  const card = document.querySelector(`.card[data-id="${CSS.escape(taskId)}"]`);
  if (!card) return false;
  const tierCards = card.closest('.tier-cards');
  card.remove();
  _hideIfEmptied(tierCards, null); // (C1578)
  return true;
}

// ── Card title overflow measurement (marquee + tooltip trigger) ──
// Adds/removes 'is-overflowing' per current measurement — safe to call repeatedly on the same
// live elements (unlike the pre-C1580 version, which only ever added the class once per render).
export function refreshTitleOverflow(appEl) {
  const root = appEl || document;
  // (TPT306) Select's slot in .card-top is always reserved (hidden by opacity, never
  // display:none), so the title has the same width at rest and on hover — measure as-is. (C1259) Read ALL titles, then write
  // all classes: a per-title read→write would force a layout recalc per card.
  // (TPT299) Proposal titles wrap on their own line — never marquee candidates.
  const _cardTitles = root.querySelectorAll('.card-title:not(.preview-title)');
  const _overflowFlags = Array.from(_cardTitles, el => el.scrollWidth > el.clientWidth);
  _cardTitles.forEach((el, i) => el.classList.toggle('is-overflowing', _overflowFlags[i]));
}

// (C1580) Adaptive widths reflow on window resize (fixed grid-column spans never did, outside
// the 768px breakpoint), so title-overflow/description-truncation state needs a resize-time
// re-measure. Bound once per appEl (the #app node persists across renders — only its innerHTML
// is rebuilt), debounced since resize fires continuously while dragging the window edge.
const _titleOverflowResizeBound = new WeakSet();
function _ensureTitleOverflowResizeListener(appEl) {
  if (!appEl || _titleOverflowResizeBound.has(appEl)) return;
  _titleOverflowResizeBound.add(appEl);
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      refreshTitleOverflow(appEl);
      markTruncatedCards();
    }, 150);
  }, { passive: true });
}

// ── Post-render setup: attaches all event listeners ──

export function setupCardInteractions(appEl) {
  // Reset selection state at start of each render cycle
  state.selectedCardId = null;
  state.expandedCardMode = null;
  state.hoverScrollHandler = null;
  // (C1568) a re-render can drop the hovered button out from under a pending/shown
  // tooltip without ever firing mouseout — clear unconditionally, bind delegation once.
  hideBtnTip();
  ensureButtonTooltips(appEl);
  initializeTaskMerge(appEl);

  // ── Status select change handlers ──
  appEl.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const select = e.target;
      const taskId = select.dataset.id;
      const prev = select.dataset.current;
      const next = select.value;
      if (next === prev) return;
      select.value = prev;
      if (_onShowConfirmModal) _onShowConfirmModal(taskId, prev, next);
    });
  });

  // ── Hover-controls status select ──
  appEl.querySelectorAll('.card-status-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const select = e.target;
      const taskId = select.dataset.taskId;
      const prev = select.dataset.current;
      const next = select.value;
      if (next === prev) return;
      select.value = prev;
      if (_onShowConfirmModal) _onShowConfirmModal(taskId, prev, next);
    });
  });

  // ── Shared session-start helper (used by Start and Discussion buttons) ──
  // Thin wrapper — reads the card's pinned agent/model from its DOM dataset, then
  // delegates the actual ladder to the card-independent _startTaskSessionCore() below
  // (C1559 — extracted so startTaskById() can reuse the exact same ladder for a task
  // with no rendered card).
  function _startTaskSession(taskId, taskTitle, taskDesc, taskStatus, card, extraOpts) {
    if (card) card.classList.remove('needs-attention');
    const cardAgentAssignee = card?.dataset.agentAssignee;
    const pinnedAgent = (cardAgentAssignee === 'claude' || cardAgentAssignee === 'codex' || cardAgentAssignee === 'pi') ? cardAgentAssignee : null;
    // (C1133) saved per-task Pi model pin, carried alongside pinnedAgent — undefined for
    // claude/codex (their per-task model resolves server-side from the task record) and
    // for a pi card with no model saved (server falls back to the project default row).
    const pinnedModel = (pinnedAgent === 'pi' && card?.dataset.piModel) ? card.dataset.piModel : undefined;
    _startTaskSessionCore(taskId, taskTitle, taskDesc, taskStatus, { agentAssignee: pinnedAgent, piModel: pinnedModel }, extraOpts);
  }

  // ── Claude button handlers ──
  appEl.querySelectorAll('.btn-claude').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.card');
      const { taskId, taskTitle, taskDesc, taskStatus } = btn.dataset;
      // Blocked by an incomplete dependency — a fresh launch only; an existing session reopens (TPT552).
      if (card?.dataset.depsBlocked === '1' && !hasTaskSession(taskId)) return;
      _startTaskSession(taskId, taskTitle, taskDesc, taskStatus, card);
    });
  });

  // ── Discussion button handlers (HUMAN tasks) ──
  appEl.querySelectorAll('.btn-start-discussion').forEach(btn => {
    btn.addEventListener('click', () => {
      const { taskId, taskTitle, taskDesc, taskStatus } = btn.dataset;
      _startTaskSession(taskId, taskTitle, taskDesc, taskStatus, btn.closest('.card'), { discussionMode: true });
    });
  });

  // ── Reiterate button handlers ──
  appEl.querySelectorAll('.btn-reiterate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const { taskId, taskTitle } = btn.dataset;
      if (_onShowReiterateModal) _onShowReiterateModal(taskId, taskTitle);
    });
  });

  // ── Delete button handlers ──
  appEl.querySelectorAll('.btn-delete-task').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const { taskId, taskTitle } = btn.dataset;
      if (_onShowDeleteConfirmModal) _onShowDeleteConfirmModal(taskId, taskTitle);
    });
  });


  // ── Subtask radio (toggle completion) ──
  appEl.querySelectorAll('.subtask-radio').forEach(radio => {
    radio.addEventListener('click', async (e) => {
      e.stopPropagation();
      const key = radio.dataset.key;
      const wasCompleted = isCompleteName(radio.dataset.currentStatus);
      const next = wasCompleted ? startName() : completeName();
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(key)}`, {
          method: 'PATCH',
          // (C1392) Was header-less — see _patchTask() above for why this matters in
          // browser mode.
          headers: { 'Content-Type': 'application/json', ...projectHeader() },
          body: JSON.stringify({ status: next }),
        });
        if (!res.ok) throw new Error(res.statusText);
        if (isCompleteName(next)) terminateSessionFromCard(key);
        // (C1259) Patch the inline subtask row directly — it's a nested
        // `.subtask-item` inside the parent card, not a top-level `.card[data-id]`,
        // so applyTaskPatch()/refreshCard() can't target it. Nothing else on the
        // board depends on a subtask's own status, so no reload is needed at all —
        // this used to be a full loadAndRender() for a single checkbox toggle.
        radio.checked = isCompleteName(next);
        radio.dataset.currentStatus = next;
        state.taskStatusById.set(key, next);
      } catch (err) {
        // (C1392) Was alert() — a native dialog blocks the page event loop and stalls
        // every CDP/Claude-in-Chrome command (C1391).
        showToast(translate('card.errSubtaskUpdate', { msg: err.message }), 'error');
      }
    });
  });

  // ── Subtask title click (drill into subtask board) ──
  appEl.querySelectorAll('.subtask-title').forEach(span => {
    span.addEventListener('click', async (e) => {
      e.stopPropagation();
      const key = span.dataset.key;
      const title = span.dataset.title;
      pushSubtaskCrumb(state.subtaskStack, { taskKey: key, title }); // (C1440) dedup vs. rapid re-clicks
      state.activeTab = 'board';
      if (_onLoadAndRender) await _onLoadAndRender();
    });
  });

  // ── Chain deps button handlers ──
  // (C1569) "Highlight Related" — routes to applyRelatedHighlight() (deps chain + family),
  // not the deps-only applyChainHighlight(). Toggle test matches the objective card-click
  // branch below: check chainHighlightMode too, not just the id, so pressing this button on
  // a card whose *objective* highlight is currently active switches modes instead of only
  // clearing it.
  appEl.querySelectorAll('.btn-chain-deps').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const _h = perfStart('chain-deps-click');
      const taskId = btn.dataset.taskId;
      const wasActive = state.chainHighlightedTaskId === taskId && state.chainHighlightMode === 'related';
      state.selectedCardId = null;
      clearHighlights();
      clearChainHighlights();
      clearFocusActive();
      collapseCard();
      if (!wasActive) {
        applyRelatedHighlight(taskId);
      }
      perfEnd(_h);
    });
  });

  // ── Agent badge click → open assign modal ──
  appEl.querySelectorAll('.agent-badge').forEach(badge => {
    bindAgentBadge(badge);
  });

  // ── Card select button (multi-select for bulk actions) ──
  appEl.querySelectorAll('.btn-select-card').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btn.dataset.taskId;
      const card = btn.closest('.card');
      if (state.selectedCardIds.has(taskId)) {
        state.selectedCardIds.delete(taskId);
        btn.classList.remove('checked');
        if (card) card.classList.remove('selected');
      } else {
        state.selectedCardIds.add(taskId);
        btn.classList.add('checked');
        if (card) card.classList.add('selected');
      }
      if (_onUpdateBulkBar) _onUpdateBulkBar();
    });
  });

  // ── Pointer-based drag-to-reorder: badge as drag handle ──
  appEl.querySelectorAll('.id-badge').forEach(badge => {
    badge.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (_dragState || _isDragging || _dropInProgress) return;

      const card = badge.closest('.card');
      if (!card) return;
      const tierCards = card.closest('.tier-cards');
      if (!tierCards) return;

      _dragState = {
        sourceCard: card,
        tierCards: tierCards,
        currentTier: tierCards,
        clone: null,
        placeholder: null,
        startX: e.clientX,
        startY: e.clientY,
        offsetX: 0,
        offsetY: 0,
        activated: false,
      };

      document.addEventListener('mousemove', _onDragMove);
      document.addEventListener('mouseup', _onDragEnd);
      document.addEventListener('keydown', _onDragKeydown);
      window.addEventListener('blur', _onDragWindowBlur);

      e.preventDefault();
    });
  });

  // ── Card hover/click interactions ──
  appEl.querySelectorAll('.card, .preview-card').forEach(card => {
    const isPreviewCard = card.classList.contains('preview-card');
    let cardPeekTimer = null;
    let cardExpandTimer = null;

    card.addEventListener('mouseenter', () => {
      if (_isDragging) return;
      if (!isPreviewCard && !state.selectedCardId) highlightCardAndDeps(card.dataset.id);
      if (isPreviewCard && document.activeElement && document.activeElement.closest('.preview-card') === card) return;
      if (isPreviewCard && card.classList.contains('confirmed')) return;
      if (state.expandedCardMode !== 'pinned') {
        clearTimeout(hoverCollapseTimer);
        hoverCollapseTimer = null;
        clearTimeout(hoverExpandTimers.get(card));
        const timer = setTimeout(() => {
          if (state.expandedCardMode !== 'pinned') {
            expandCard(card, 'hover');
          }
        }, 250);
        hoverExpandTimers.set(card, timer);
      }
      if (!isPreviewCard) {
        clearTimeout(cardPeekTimer);
        clearTimeout(cardExpandTimer);
        cardPeekTimer = setTimeout(() => {
          if (state.expandedCardMode !== 'pinned') card.classList.add('card-peek');
        }, 350);
        cardExpandTimer = setTimeout(() => {
          if (state.expandedCardMode !== 'pinned') card.classList.add('card-hover-expanded');
        }, 800);
      }
    });

    card.addEventListener('mouseleave', () => {
      if (!isPreviewCard && !state.selectedCardId) clearHighlights();
      clearTimeout(hoverExpandTimers.get(card));
      if (state.expandedCardMode === 'hover') {
        hoverCollapseTimer = setTimeout(() => {
          if (state.expandedCardMode === 'hover') {
            collapseCard();
          }
        }, 200);
      }
      if (!isPreviewCard) {
        clearTimeout(cardPeekTimer);
        clearTimeout(cardExpandTimer);
        if (!card.contains(document.activeElement)) {
          card.classList.remove('card-peek', 'card-hover-expanded');
        }
      }
    });

    card.addEventListener('click', (e) => {
      // (C1259) Wraps the whole handler (many early returns below) rather than
      // instrumenting each branch — task item 2's "clicking a card badge updates in
      // under 100ms" ask, measured end to end including the expandCard()/
      // highlightCardAndDeps() DOM work in the branches further down.
      const _h = perfStart('card-click');
      try {
      if (e.detail >= 2) return; // 2nd click of dblclick must not toggle expand/collapse
      if (e.target.closest('select, button, option, .subtask-item')) return;
      if (_isDragging) return;

      if (isPreviewCard) {
        if (e.target.closest('.editing')) return;
        if (e.target.closest('.preview-card-actions')) return;
        if (card.classList.contains('confirmed') || card.classList.contains('rejected')) return;
      }

      const id = isPreviewCard ? card.dataset.taskId : card.dataset.id;

      // Clear green assignment highlight on user interaction
      if (!isPreviewCard) {
        document.dispatchEvent(new CustomEvent('tiptask:clear-new-assignment', { detail: { taskId: id } }));
      }

      // (C1433) Objective/parent card click: ring the objective + its whole subtask
      // subtree instead of the dependency chain, and still pin-expand the objective
      // itself over the blurred board. Supersedes the hover-pin branch below (an
      // objective card always goes through this path, whatever its hover state).
      // Toggle semantics match .btn-chain-deps: clicking the same active objective
      // clears only; clicking a different one clears then re-applies.
      if (!isPreviewCard && card.dataset.objective === '1') {
        const wasActive = state.chainHighlightedTaskId === id && state.chainHighlightMode === 'objective';
        state.selectedCardId = null;
        clearHighlights();
        clearChainHighlights();
        clearFocusActive();
        collapseCard();
        if (!wasActive) {
          state.selectedCardId = id;
          applyObjectiveHighlight(id);
          expandCard(card, 'pinned');
          const focusBtn = card.querySelector('.btn-focus-card');
          if (focusBtn) focusBtn.classList.add('active');
        }
        return;
      }

      if (state.expandedCardMode === 'hover' && card.classList.contains('card-expanded')) {
        state.expandedCardMode = 'pinned';
        clearTimeout(hoverCollapseTimer);
        hoverCollapseTimer = null;
        const backdrop = document.createElement('div');
        backdrop.className = 'card-overlay-backdrop';
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', () => {
          state.selectedCardId = null;
          clearHighlights();
          clearChainHighlights();
          clearFocusActive();
          collapseCard();
        });
        lockBodyScroll();
        if (!isPreviewCard) {
          clearFocusActive();
          state.selectedCardId = id;
          clearHighlights();
          highlightCardAndDeps(id);
          const focusBtn = card.querySelector('.btn-focus-card');
          if (focusBtn) focusBtn.classList.add('active');
        }
        return;
      }

      if (isPreviewCard) {
        if (card.classList.contains('card-expanded') && state.expandedCardMode === 'pinned') {
          collapseCard();
        } else {
          expandCard(card, 'pinned');
        }
      } else {
        if (state.selectedCardId === id) {
          // Already focused — do nothing (use focus button to unfocus)
          return;
        } else {
          clearFocusActive();
          state.selectedCardId = id;
          clearHighlights();
          clearChainHighlights();
          highlightCardAndDeps(id);
          expandCard(card, 'pinned');
          const focusBtn = card.querySelector('.btn-focus-card');
          if (focusBtn) focusBtn.classList.add('active');
          const deps = JSON.parse(card.dataset.deps || '[]');
          for (const depId of deps) {
            const depCard = appEl.querySelector(`.card[data-id="${depId}"]`);
            if (depCard) {
              const depTier = depCard.closest('.tier');
              if (depTier && depTier.classList.contains('collapsed')) {
                const p = Number(depTier.dataset.priority);
                depTier.classList.remove('collapsed');
                state.collapsedTiers.delete(p);
                state.expandedTiers.add(p);
              }
            }
          }
        }
      }
      } finally {
        perfEnd(_h);
      }
    });

    if (!isPreviewCard) {
      card.addEventListener('focusin', () => {
        if (state.expandedCardMode === 'pinned') return;
        clearTimeout(cardPeekTimer);
        clearTimeout(cardExpandTimer);
        card.classList.add('card-peek', 'card-hover-expanded');
      });

      card.addEventListener('focusout', (e) => {
        if (e.relatedTarget && card.contains(e.relatedTarget)) return;
        if (!card.matches(':hover')) {
          card.classList.remove('card-peek', 'card-hover-expanded');
        }
      });
    }
  });

  // ── Collapsible tier labels ──
  appEl.querySelectorAll('.tier-label').forEach(label => {
    label.addEventListener('click', () => {
      const _h = perfStart('sprint-collapse');
      const p = Number(label.dataset.priority);
      const tier = label.closest('.tier');
      if (tier.classList.contains('collapsed')) {
        tier.classList.remove('collapsed');
        state.collapsedTiers.delete(p);
        state.expandedTiers.add(p);
      } else {
        tier.classList.add('collapsed');
        state.expandedTiers.delete(p);
        state.collapsedTiers.add(p);
      }
      perfEnd(_h);
    });
  });

  // ── Sprint play-all buttons ──
  appEl.querySelectorAll('.btn-sprint-play').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      const p = Number(btn.dataset.priority);
      const all = (state.tiers[p] || []).filter(
        t => isActiveName(t.status) && !isInProgressName(t.status) && t.category === 'CODING' && !isDepsBlocked(t)
          && canStartTaskCard(t)
      );
      const humanTasks    = all.filter(t => t.agentAssignee === 'human');
      const assignedTasks = all.filter(t => t.agentAssignee && t.agentAssignee !== 'human');
      const unassigned    = all.filter(t => !t.agentAssignee);

      function _buildPrompt(t) {
        const d = truncateMarkdownAtParagraph(t.description, MAX_DESC_LEN);
        return `Work on task ${t.id}: ${t.title}. ${d}`;
      }

      function _openTerminalWs(t, agent) {
        return startTerminalSession(t.id, { prompt: _buildPrompt(t), agent }).catch(() => ({ ok: false }));
      }

      function _patchStatus(t, body) {
        return fetch(`/api/tasks/${encodeURIComponent(t.id)}`, {
          method: 'PATCH',
          // (C1392) Was header-less — see _patchTask() above for why this matters in
          // browser mode.
          headers: { 'Content-Type': 'application/json', ...projectHeader() },
          body: JSON.stringify(body),
        });
      }

      try {
        // Human: patch in_progress only
        const humanWork = humanTasks.map(t => _patchStatus(t, { status: inProgressName() }));

        // Assigned (claude/codex): patch in_progress + open terminal
        const assignedWork = assignedTasks.map(async t => {
          await _patchStatus(t, { status: inProgressName() });
          return _openTerminalWs(t, t.agentAssignee);
        });

        await Promise.allSettled([...humanWork, ...assignedWork]);
        if (_onFetchActiveSessions) await _onFetchActiveSessions();
      } catch (err) {
        // (C1392) Was alert() — see subtask-radio handler above.
        showToast(translate('card.errStartSprint', { msg: err.message }), 'error');
      }

      if (unassigned.length > 0) {
        showBulkAgentStartModal(unassigned, async (choice) => {
          try {
            if (choice === 'human') {
              await Promise.allSettled(
                unassigned.map(t => _patchStatus(t, { agent_assignee: 'human', status: inProgressName() }))
              );
            } else {
              await Promise.allSettled(
                unassigned.map(t => _patchStatus(t, { agent_assignee: choice, status: inProgressName() }))
              );
              await Promise.allSettled(
                unassigned.map(t => _openTerminalWs(t, choice))
              );
            }
            if (_onFetchActiveSessions) await _onFetchActiveSessions();
          } catch (err) {
            // (C1392) Was alert() — see subtask-radio handler above.
            showToast(translate('card.errStartTasks', { msg: err.message }), 'error');
          }
          if (_onLoadAndRender) await _onLoadAndRender();
        });
      } else {
        if (_onLoadAndRender) await _onLoadAndRender();
      }
    });
  });

  // ── Board card double-click → task edit modal ──
  appEl.querySelectorAll('.card-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_onOpenTaskEditModal) _onOpenTaskEditModal(btn.dataset.taskId, btn);
    });
  });

  // ── Task chat button → chat window for this task (one persisted session per task) ──
  // Reached through window.TipTask rather than an import: task-chat.js imports renderCard
  // from this module.
  appEl.querySelectorAll('.btn-task-chat').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btn.dataset.taskId;
      // (TPT272/TPT283) Locked by Rehash → Discuss/Split: the chat agent can change the task,
      // which would race the open proposal — same rule as the edit modal.
      if (isTaskDiscussing(state, taskId)) {
        showToast(translate(lockMessageKey(lockIntentOf(state, taskId))));
        return;
      }
      if (btn.closest('.card')?.classList.contains('pending-sync')) return; // no server task yet
      collapseCard();
      window.TipTask?.taskChat?.open(taskId);
    });
  });
  appEl.querySelectorAll('.card[data-id]').forEach(card => {
    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('select, button, input, textarea, .agent-badge, .sprint-combo, .id-badge')) return;
      if (_isDragging) return;
      if (isTaskDiscussing(state, card.dataset.id)) return; // (TPT272/TPT283) locked by Rehash → Discuss/Split
      e.preventDefault();
      collapseCard();
      if (_onOpenTaskEditModal) _onOpenTaskEditModal(card.dataset.id, card.querySelector('.card-edit-btn'));
    });
  });

  // ── Preview-card double-click → task edit modal (real keys) or proposal modal (new) ──
  appEl.querySelectorAll('.preview-card').forEach(card => {
    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('select, button, input, textarea, .preview-card-actions')) return;
      if (_isDragging) return;
      e.preventDefault();
      e.stopPropagation(); // prevent delegated inline-edit handler
      collapseCard();
      const taskId = card.dataset.taskId;
      const isConfirmed = card.classList.contains('confirmed');
      // C1095: an unconfirmed 'modified' card still has a real task id (it targets an
      // existing task) but must open the dual-panel diff/proposal modal, not the
      // board-path live-task modal — that would bypass the proposal entirely and edit
      // the live DB task directly. Only a CONFIRMED card (already saved for real) goes
      // to the board path.
      // (C1483) isTaskKeyLike replaces the old sentinel-only check (taskId !== 'new' &&
      // !taskId.startsWith('new-')) with a real shape check against TASK_KEY_RE/
      // EPIC_KEY_RE — subsumes both sentinels ('new'/'new-...'/'new-obj-...' all fail
      // the regex) and additionally rejects a descriptive-slug id that isn't a real key.
      const isRealKey = isConfirmed && isTaskKeyLike(taskId);
      if (isRealKey) {
        if (_onOpenTaskEditModal) _onOpenTaskEditModal(taskId);
      } else {
        if (_onOpenPreviewCardModal) _onOpenPreviewCardModal(card);
      }
    });
  });

  // ── Overflow detection + title tooltip for card titles ──
  refreshTitleOverflow(appEl);
  // (C1580) Adaptive card widths mean the measurement above can go stale on a window resize
  // (unlike the old fixed grid-column spans, which only ever changed at the 768px breakpoint).
  // Bound once, globally, behind a module flag — appEl is the stable #app node every render
  // reuses (only its innerHTML is rebuilt), so a single listener covers every future render.
  _ensureTitleOverflowResizeListener(appEl);
  const _cardTitles = appEl.querySelectorAll('.card-title');
  _cardTitles.forEach((el) => {
    el.addEventListener('mouseenter', () => {
      if (el.isContentEditable) return;
      // (TPT346) A proposal title wraps in full on its own line, so the one-line pill would only
      // cover its first line and spill past a narrow card. Show one only when the card really
      // clips the title, and then as a wrapping pill pinned inside the card. Board titles keep
      // the original one-line pill below.
      const isProposalTitle = el.classList.contains('preview-title');
      const rect = el.getBoundingClientRect();
      const cardRect = isProposalTitle ? el.closest('.preview-card')?.getBoundingClientRect() : null;
      if (isProposalTitle && !isRectClipped(rect, cardRect)) return;
      // A proposal title is editable, so read its live text: the title= attribute is not
      // rewritten after an edit.
      const text = isProposalTitle ? el.textContent.trim() : el.getAttribute('title');
      if (!text) return;
      if (_titleTooltip) _titleTooltip.remove();
      const tip = document.createElement('div');
      tip.className = 'card-title-tooltip';
      tip.textContent = text;
      document.body.appendChild(tip);
      if (isProposalTitle) {
        tip.classList.add('card-title-tooltip--wrap');
        tip.style.left = rect.left + 'px';
        tip.style.width = rect.width + 'px';
        // Vertical clamp keeps a partly scrolled-out title's pill inside the card's own box.
        const tipHeight = tip.getBoundingClientRect().height;
        const maxTop = Math.max(cardRect.top, cardRect.bottom - tipHeight);
        tip.style.top = Math.min(Math.max(rect.top, cardRect.top), maxTop) + 'px';
        _titleTooltip = tip;
        return;
      }
      // (C1385) Flip to right-anchored when left-anchoring would run the tooltip off the
      // viewport's right edge — measure only after the tooltip is in the DOM so the real
      // rendered width (post max-width clamp) is used, not an estimate.
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const anchor = computeTooltipAnchor(rect, tip.getBoundingClientRect().width, viewportWidth);
      if (anchor.flip) {
        tip.classList.add('tooltip-flip-left');
        tip.style.right = anchor.right + 'px';
      } else {
        tip.style.left = anchor.left + 'px';
      }
      tip.style.top = rect.top + 'px';
      _titleTooltip = tip;
    });

    el.addEventListener('mouseleave', () => {
      if (_titleTooltip) { _titleTooltip.remove(); _titleTooltip = null; }
    });
  });
}
