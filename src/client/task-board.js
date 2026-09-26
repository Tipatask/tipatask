// ── Task Board rendering, search, and modals ──
import state from './state.js';
import { t, tc, setLocale } from './i18n.js';
import { isTaskDiscussing } from './discuss-lock.js';
import { DRAFT_KEY_TASK, ensureAgentModels } from './constants.js';
import {
  statusNames, statusLabel, statusColor, statusRoleToken, WORKFLOW_COLOR_SWATCHES,
  isActiveName, isClosedName, isInProgressName, isCompleteName, isCanceledName, isStartName,
  startName, inProgressName,
  seedStatuses,
} from './status-registry.js';
import { escapeAttr, insertAtCursor, markTruncatedCards, loadDraft, saveDraft, clearDraft, getObjectiveDraftKey, renderMarkdown, renderSprintCombobox, initSprintCombobox, refreshSprintComboboxItems, showToast, showProgressToast, sprintRecordMax, showSavingIndicator, hideSavingIndicator, shortModelName, pushSubtaskCrumb, renderTagBadge } from './utils.js';
import { computeTierWindow, HIDE_CLASS } from './sprint-tier-visibility.js';
import { isStatusRowChecked } from './status-filter-select.js';
import { buildWsUrl, terminateTaskSession } from './ws-client.js';
import { CLAUDE_SVG, CLAUDE_BADGE_SVG, CODEX_BADGE_SVG, PI_BADGE_SVG, HUMAN_BADGE_SVG, renderAgentBadge, refreshCard, regroupCardToSprint, regroupMovedCard, regroupNeedsReload, canStartTaskCard, isTaskReadOnly, applyTaskPatch, removeCardFromDom, isDepsBlocked, hasUnmetDeps, unmetDependencyKeys } from './task-card.js';
import { buildSubtasksLabel, closedDelta, applyChildStatusDelta, countChildProgress } from './subtask-count.js';
import { sessionButtonMode, SESSION_BUTTON_MODES } from './session-button-state.js';
import { createMemberCache } from './member-cache.js';
import { api } from './api-client.js';
import { getNotificationStatus, sendTestNotification, refreshNotificationStatus, repairNotificationRegistration } from './notifications.js';
import { buildDepGraph, collectCycleBlocked } from './dep-graph.js';
import { tagName } from './tag-match.js';
import { serializeBoardFilters, sanitizeBoardFilters } from './board-filter-prefs.js';
import { openAgentsModal } from './agents-modal.js';
import { activateDialogFocus } from './dialog-focus.js';
import { voiceModelBadge, applyVoiceModelProgress, voiceModelAction, voiceModelStateLabelKey, voiceModelNeedsDownload, isVoiceInputReady } from './voice-model-state.js';
import { setVoiceInputAvailability, setVoiceInputDeviceId, isAnyVoiceCaptureActive, attachAudioRecorder, setVoiceShortcut } from './audio-recorder.js';
import { filterAudioInputs, labelsUnlocked, buildInputDeviceOptions } from './voice-devices.js';
import { VOICE_SHORTCUT_OPTIONS, DEFAULT_VOICE_SHORTCUT, normalizeVoiceShortcut } from './voice-shortcut.js';
import { groupNoun, groupTitle, groupShowMore, groupLoadMore, groupEmpty, groupPriorityFieldLabel, TASK_GROUP_LABELS, DEFAULT_TASK_GROUP_LABEL, getGroupLabel, setGroupLabel, loadGroupLabel, groupPluralFor, getSprintsEnabled, setSprintsEnabled, getObjectiveGroupingEnabled, setObjectiveGroupingEnabled, getSprintSortOrder, isGeneratedGroupName } from './group-label.js';
// The Create header is shared by Objective chat and New Task without a board/chat import cycle.
import { renderComposerHeader } from './composer-header.js';
import { showActionConfirm } from './action-confirm.js';
export { showActionConfirm };
import { clearAttention, mergeSessionsSnapshot, syncAttentionClasses } from './attention-state.js';
import { syncActivityChips } from './task-activity.js';
import { taskHasNullSprint, tasksForActiveTab, taskHiddenByGrouping, tasksVisibleUnderGrouping } from './board-count-domain.js';
import { VCS_TYPES, VCS_GIT_FLAGS, buildVcsPatchBody } from './vcs-form.js';
import { shouldTypeToFilter } from './type-to-filter.js';
import {
  configureTaskEditModal, openTaskEditModal, closeTaskEditModal,
  requestCloseTaskEditModal, openTaskEditModalFromTerminal,
  registerTaskEditNavigation, syncTaskEditSessionButtons, replaceModalImageBlobUrl,
  // Builders shared with the New Task form (renderNewTaskForm / attachNewTaskFormHandlers).
  _renderDepChip, _statusOptionsHtml, _agentModelControlHtml, _applyModalAgentModelVisibility,
} from './task-edit-modal.js';

export {
  openTaskEditModal, closeTaskEditModal, requestCloseTaskEditModal,
  openTaskEditModalFromTerminal, registerTaskEditNavigation,
};

const LEFT_NAV_COLLAPSED_CLASS = 'left-nav-collapsed';
const LEFT_NAV_COLLAPSED_KEY = 'tiptask-left-nav-collapsed';
const LEFT_NAV_CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none"><polyline points="9 6 15 12 9 18"></polyline></svg>';
const LEFT_NAV_CHEVRON_LEFT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none"><polyline points="15 6 9 12 15 18"></polyline></svg>';

// Update collapse state without replacing #left-nav-toggle. With no argument this toggles;
// callers restoring persisted state can pass the desired boolean explicitly.
export function toggleSidebar(nextCollapsed) {
  const collapsed = typeof nextCollapsed === 'boolean'
    ? nextCollapsed
    : !document.body.classList.contains(LEFT_NAV_COLLAPSED_CLASS);
  document.body.classList.toggle(LEFT_NAV_COLLAPSED_CLASS, collapsed);
  try {
    localStorage.setItem(LEFT_NAV_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    // A blocked preference store must not prevent the navigation control from working.
  }

  const toggle = document.getElementById('left-nav-toggle');
  if (toggle) {
    toggle.innerHTML = collapsed ? LEFT_NAV_CHEVRON_RIGHT : LEFT_NAV_CHEVRON_LEFT;
    toggle.setAttribute('aria-label', collapsed ? 'Expand left navigation' : 'Collapse left navigation');
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
  syncActiveSessionsNav();
  return collapsed;
}

// C1235 — regex-escape helper for building the group-noun lead-in guard below.
function _escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// (C1258) _tierTitleFor() below used to `new RegExp(...)` this pattern on every call — once per
// tier, per render, on the board/list views. groupNoun() only actually changes on a project
// switch or a Workflow-tab label edit, so a single-entry cache keyed on its current value avoids
// recompiling the same pattern for every tier of every render.
let _tierTitleLeadReCache = null;
let _tierTitleLeadReNoun = null;
function _tierTitleLeadRe() {
  const noun = groupNoun();
  if (_tierTitleLeadReCache && _tierTitleLeadReNoun === noun) return _tierTitleLeadReCache;
  _tierTitleLeadReNoun = noun;
  _tierTitleLeadReCache = new RegExp(`^(${_escapeRe(noun)}|Sprint)\\s`, 'i');
  return _tierTitleLeadReCache;
}

// Sprint container title: "<Noun> <n>" (e.g. "Batch 237"), or "<Noun> <n> — <name>" when
// the API sprint record has a custom name — unless that name already leads with the
// project's group noun (avoids "Batch 5 — Batch 5"). "Sprint " kept as a legacy match too:
// rows created before C1232 are all named that way regardless of the project's current
// label. Shared by renderBoardContent and renderListContent (was duplicated inline).
function _tierTitleFor(p) {
  const rec = state.sprints?.find(s => (s.number ?? s.id) === p);
  const title = groupTitle(p);
  // (C1395) A stored row name that's just the auto-generated boilerplate (every writer —
  // sprint-assign.js/mcp/server.js/cli/migrate-tasks.js — writes literal "Sprint ${n}",
  // never the project's own noun) isn't a custom name. Without this clause the boilerplate
  // name won string every time a row existed, which is nearly always — the real noun only
  // ever showed on a not-yet-materialized tier (e.g. after "Load Earlier").
  if (!rec?.name || isGeneratedGroupName(rec.name, p)) return title;
  return _tierTitleLeadRe().test(rec.name) ? rec.name : `${title} — ${rec.name}`;
}

// ── Avatar circle: img if URL, else hashed-hue initial ──
export function renderHumanAvatar(avatarUrl, seed) {
  if (avatarUrl) {
    return `<span class="filter-icon filter-icon--avatar"><img src="${escapeAttr(avatarUrl)}" alt="" referrerpolicy="no-referrer" loading="lazy"></span>`;
  }
  const s = String(seed || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const initial = s.trim() ? s.trim()[0].toUpperCase() : '?';
  return `<span class="filter-icon filter-icon--user" style="background:hsl(${hue},55%,45%);color:var(--c-solid-text)">${escapeAttr(initial)}</span>`;
}

// ── Sort tasks within a tier by status order ──
export function sortTier(list) {
  return [...list].sort((a, b) =>
    (b.order ?? 0) - (a.order ?? 0)
  );
}

// ── Check if a task matches the active Human filter ──
function taskMatchesHumanFilter(t) {
  if (!state.humanFilterActive) return true;
  return taskIsForHuman(t);
}

// ── Same check, but reading from a rendered card's badge ──
function cardMatchesHumanFilter(card) {
  if (!state.humanFilterActive) return true;
  return !!card.querySelector('.id-badge.human');
}

// ── Human-assignee predicate: explicit human assignment OR unassigned HUMAN-category ──
function taskIsForHuman(t) {
  return t.agentAssignee === 'human' || (t.category === 'HUMAN' && !t.agentAssignee);
}

// ── People filter (C1407) — member sub-selection, applies in BOTH scopes (TPT180) ──
// assigneeScope ('me'/'all') is NOT checked here: it's a fetch-affecting dimension already
// applied server/client-side in api-backend.js (filterToOwnOrUnassigned()) before rows ever
// reach the renderer. The member sub-selection below IS a pure client-side filter over
// already-fetched rows — same render-time-baked treatment as the Human/status filters above
// it, empty selection = all members shown (mirrors statusFilter's empty-Set-means-all).
// TPT180: 'me' scope is no longer only "my own tasks" — it also holds tasks I created and
// handed to someone else, so the member sub-selection must work there too (ticking my own
// name hides those, ticking the assignee shows only them). Previously gated on
// assigneeScope === 'all', which left no way to hide them.
export function assigneeFilterActive() {
  return state.assigneeFilter.size > 0;
}

function taskMatchesAssigneeFilter(t) {
  if (!assigneeFilterActive()) return true;
  const key = t.assignee == null ? 'none' : Number(t.assignee);
  return state.assigneeFilter.has(key);
}

// ── Same check, but reading from a rendered card's data-assignee (task-card.js:248) ──
function cardMatchesAssigneeFilter(card) {
  if (!assigneeFilterActive()) return true;
  const raw = card.dataset.assignee;
  const key = raw === '' || raw == null ? 'none' : Number(raw);
  return state.assigneeFilter.has(key);
}

// ── Whether the status filter is currently narrowing anything (C1164) ──
// state.statusFilter is a Set now — truthiness checks on it are always true, so every
// call site that used to do `if (state.statusFilter)` must go through this instead.
export function statusFilterActive() {
  return state.statusFilter.size > 0;
}

// (C1442) Whether ANY of the five per-task filter dimensions is currently narrowing the
// visible set — search / tag / human / assignee-member / status. Deliberately excludes a
// bare `assigneeScope === 'all'` with no member ticked: switching scope BROADENS the fetched
// domain rather than narrowing what's shown, so it isn't "a filter is hiding your task" in the
// sense this helper answers. Was inlined separately in renderBacklogContent()'s
// hasActiveFilters and (with the scope disjunct added back) refreshFilterBarChrome()'s
// resetBtn.disabled check — extracted so the two can't drift apart, and reused by
// renderBacklogHintHtml() below.
export function anyNarrowingFilterActive() {
  return Boolean(
    state.searchQuery.trim() ||
    state.activeTagFilters.size > 0 ||
    state.humanFilterActive ||
    assigneeFilterActive() ||
    statusFilterActive()
  );
}

// (C1293) Full board renders capture this revision before any asynchronous task fetch.
// Filter changes increment it so an older render cannot put stale cards back into #app.
export function invalidateBoardRenderState() {
  state._boardRenderRevision = (state._boardRenderRevision || 0) + 1;
  return state._boardRenderRevision;
}

// ── Check if a task matches the active status filter (C1155, multi-select C1164) ──
function taskMatchesStatusFilter(task) {
  if (!statusFilterActive()) return true;
  return state.statusFilter.has(task.status);
}

// ── Same check, but reading from a rendered card's data-status ──
function cardMatchesStatusFilter(card) {
  if (!statusFilterActive()) return true;
  return state.statusFilter.has(card.dataset.status);
}

// (C1442/C1460) taskHasNullSprint/tasksForActiveTab/taskHiddenByGrouping/
// tasksVisibleUnderGrouping live in board-count-domain.js (pure, unit-tested without a DOM)
// — imported above, re-exported here so template.html's existing `taskHasNullSprint(...)`
// call sites and the count-domain wiring need no separate import. Composition order at
// every call site is fixed: grouping (C1460) narrows first, then tasksForActiveTab (C1442)
// narrows the result to the active tab's render domain.
export { taskHasNullSprint, tasksForActiveTab, taskHiddenByGrouping, tasksVisibleUnderGrouping };

function sprintTierKeys(tierKeys) {
  return [...(tierKeys || [])].map(Number).filter(k => Number.isFinite(k) && k > 0);
}

// (C1333) Client mirror of the server's highestActiveCodingPriority() (sprint-assign.js) —
// the sprint a new task silently joins when the sprint field is hidden (sprints_enabled
// false). Highest sprint number still holding an active-status task; falls back to the
// known sprint-record ceiling, then 1 for a genuinely empty project.
export function currentActiveSprintPriority() {
  const keys = sprintTierKeys(state.tierKeys).sort((a, b) => b - a);
  for (const k of keys) {
    const tier = state.tiers && state.tiers[k];
    if (Array.isArray(tier) && tier.some(t => isActiveName(t.status))) return k;
  }
  return sprintRecordMax(state.sprints) || 1;
}

// (C1485) Single snapshot the Electron main process reads over executeJavaScript for its
// window-close guard (main.js confirmWindowClose) — covers close paths that never reach the
// renderer's project:menu handler (role:'close' Ctrl+W on Win/Linux, title-bar X).
// Count source is LIVE SESSIONS ONLY (state.activeSessions, mirrors GET /api/sessions'
// alive||_starting bucket via mergeSessionsSnapshot() — see attention-state.js). Board task
// STATUS is never an input here — a prior C1429 version also counted
// !isStartName(status) && !isClosedName(status) tasks off state._lastVisibleTasks, which
// warned on window close even with zero sessions ever started (any in_progress/on_fire task
// sitting on the board tripped it). Removed in C1485; do not reintroduce a status-based count.
export function closeGuardState() {
  return { sessions: state.activeSessions.size };
}

// ── Check if a task matches current active filters ──
// opts.ignoreStatus skips the status clause — used by computeStatusCounts() to build
// per-status counts against every OTHER active filter, not against itself (C1155).
export function matchesFilters(t, opts = {}) {
  if (!taskMatchesHumanFilter(t)) return false;
  if (!opts.ignoreAssignee && !taskMatchesAssigneeFilter(t)) return false;
  if (!opts.ignoreStatus && !taskMatchesStatusFilter(t)) return false;
  const needle = state.searchQuery.trim().toLowerCase();
  if (needle) {
    const id = (t.id || '').toLowerCase();
    const title = (t.title || '').toLowerCase();
    const desc = (t.description || '').toLowerCase();
    if (!id.includes(needle) && !title.includes(needle) && !desc.includes(needle)) return false;
  }
  if (state.activeTagFilters.size > 0) {
    const tags = t.tags || [];
    if (![...state.activeTagFilters].every(tag => tags.includes(tag))) return false;
  }
  return true;
}

// ── Faceted per-status counts: each status counted against every OTHER active filter (C1155) ──
export function computeStatusCounts(tasks) {
  const base = tasks.filter(task => matchesFilters(task, { ignoreStatus: true }));
  const counts = { all: base.length };
  for (const s of statusNames()) counts[s] = 0;
  for (const task of base) if (counts[task.status] != null) counts[task.status]++;
  return counts;
}

// ── Status-filter dropdown — options carry faceted counts, replaces the old .summary row
// (C1155); multi-checkbox panel (C1164) — selection is a union (OR) across ticked statuses,
// empty selection = all. ──
// Extracted (C1259) so patchStatusFilterChrome() below can refresh the trigger button's
// label text without rebuilding the dropdown — used to be computed only inline here.
function statusFilterLabel(counts) {
  const selected = state.statusFilter;
  const n = selected.size;
  return n === 0
    ? `${t('filter.statusAll')} (${counts.all})`
    : n === 1
      ? `${statusLabel([...selected][0])} (${counts[[...selected][0]]})`
      : `${tc('filter.statusMulti', n)} (${[...selected].reduce((sum, s) => sum + (counts[s] || 0), 0)})`;
}

export function renderStatusFilter(counts) {
  const selected = state.statusFilter;
  const n = selected.size;
  const label = statusFilterLabel(counts);

  const row = (value, labelText, count, extraClass = '') =>
    `<label class="status-filter-option${extraClass}">`
    + `<input type="checkbox" data-status="${value}"${isStatusRowChecked(selected, value) ? ' checked' : ''}>`
    + `<span>${escapeAttr(labelText)}</span>`
    + `<span class="status-filter-count">(${count})</span>`
    + '</label>';

  return `<div class="status-filter-wrap${n > 0 ? ' active' : ''}">`
    + `<button type="button" class="btn-filter-status" aria-haspopup="true" aria-expanded="false" title="${escapeAttr(t('filter.byStatus'))}" aria-label="${escapeAttr(t('filter.byStatus'))}">${escapeAttr(label)}</button>`
    + `<div class="status-filter-dropdown" hidden>`
    + row('', t('filter.statusAll'), counts.all, ' status-filter-option--all')
    + statusNames().map(s => row(s, statusLabel(s), counts[s])).join('')
    + '</div></div>';
}

// ── People filter (C1407) — replaces the old bare Human-filter icon button. Faceted
// per-member counts, mirroring computeStatusCounts() above: each member counted against
// every OTHER active filter (human/status/search/tag) via matchesFilters' ignoreAssignee
// escape, over whatever rows are ALREADY loaded. Note: when assigneeScope is 'me' the
// loaded rows are already server/client-scoped to the current user (filterToOwnOrUnassigned()
// in api-backend.js: assigned to me, unassigned, or created by me, TPT180) — so a member's
// count there covers only the rows in that personal scope, and an accurate "All Tasks" count
// would need the unscoped superset, which isn't fetched until the user actually switches
// scope. So counts are only computed (and only rendered) for the member sub-selection rows,
// never for the My Tasks/All Tasks radios themselves — showing a number there would either
// lie (same narrowed count under both) or require a throwaway fetch just to label a button.
export function computeAssigneeCounts(tasks) {
  const base = tasks.filter(task => matchesFilters(task, { ignoreAssignee: true }));
  const counts = { none: 0 };
  for (const task of base) {
    const key = task.assignee == null ? 'none' : Number(task.assignee);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// (C1441) Decorative person glyph on the People-filter trigger — aria-hidden, the button's
// own title/aria-label (filter.byPeople) already names it, so no new i18n key. Same house
// Feather-icon style as .btn-tag-filter's inline SVG (template.html).
const PEOPLE_FILTER_ICON_SVG = '<svg class="people-filter-icon" aria-hidden="true" '
  + 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

// Trigger button text — deliberately count-free (see computeAssigneeCounts comment above).
// TPT180: a ticked member names the trigger in either scope; with none ticked it falls back
// to the scope's own label.
function peopleFilterLabel() {
  const n = state.assigneeFilter.size;
  if (n === 1) {
    const only = [...state.assigneeFilter][0];
    return only === 'none' ? t('filter.unassigned') : (_memberForAssignee(only)?.name || `#${only}`);
  }
  if (n > 1) return tc('filter.peopleSelected', n);
  return state.assigneeScope === 'all' ? t('filter.allTasks') : t('filter.myTasks');
}

// Panel layout, top to bottom (per the approved plan): My Tasks / All Tasks radio group →
// member checklist (rendered under BOTH scopes since TPT180 — 'me' scope now also holds
// tasks I created and reassigned, and the checklist is how the user hides them; the visible
// rows all come from _acceptedMembers(), independent of the sprint window, so a member whose
// only tasks predate the fetched window still gets a row, just with a (0) count) → a divider →
// the Human Tasks checkbox (unchanged taskIsForHuman()/humanFilterActive semantics, just
// relocated here from the old standalone icon button).
export function renderPeopleFilter(counts) {
  const scope = state.assigneeScope === 'all' ? 'all' : 'me';
  const selectedMembers = state.assigneeFilter;
  const members = _acceptedMembers();

  const memberRow = (value, labelText, count) =>
    `<label class="people-filter-option people-filter-option--member">`
    + `<input type="checkbox" data-assignee="${escapeAttr(String(value))}"${selectedMembers.has(value) ? ' checked' : ''}>`
    + `<span>${escapeAttr(labelText)}</span>`
    + `<span class="people-filter-count">(${count})</span>`
    + '</label>';

  const memberRows = memberRow('none', t('filter.unassigned'), counts.none || 0)
    + members.map(m => memberRow(Number(m.id), m.name, counts[Number(m.id)] || 0)).join('');

  const active = scope === 'all' || assigneeFilterActive() || state.humanFilterActive;

  return `<div class="people-filter-wrap${active ? ' active' : ''}">`
    + `<button type="button" class="btn-people-filter" aria-haspopup="true" aria-expanded="false" title="${escapeAttr(t('filter.byPeople'))}" aria-label="${escapeAttr(t('filter.byPeople'))}">${PEOPLE_FILTER_ICON_SVG}<span class="people-filter-label">${escapeAttr(peopleFilterLabel())}</span></button>`
    + `<div class="people-filter-dropdown" hidden>`
    + `<label class="people-filter-option">`
      + `<input type="radio" name="people-scope" data-assignee-scope="me"${scope === 'me' ? ' checked' : ''}>`
      + `<span>${escapeAttr(t('filter.myTasks'))}</span>`
    + `</label>`
    + `<label class="people-filter-option">`
      + `<input type="radio" name="people-scope" data-assignee-scope="all"${scope === 'all' ? ' checked' : ''}>`
      + `<span>${escapeAttr(t('filter.allTasks'))}</span>`
    + `</label>`
    + `<div class="people-filter-members">${memberRows}</div>`
    + `<div class="people-filter-divider"></div>`
    + `<label class="people-filter-option">`
      + `<input type="checkbox" data-human-filter${state.humanFilterActive ? ' checked' : ''}>`
      + `<span>${escapeAttr(t('filter.humanTasks'))}</span>`
    + `</label>`
    + '</div></div>';
}

// ── Compute which tiers to show (hide fully-done + card-less sprints, C1578) ──
// Exported (C1259) so template.html's Show More click handler can tell whether the next
// click should reveal an already-fetched-but-hidden tier locally, or must widen the
// server-side sprint window instead — see updateShowMoreButton()'s canFetchMore logic.
// Thin adapter over the pure computeTierWindow() (sprint-tier-visibility.js) — supplies
// live-state predicates so the reveal-pool math itself stays unit-testable with no DOM.
export function computeVisibleTiers(tierKeys, tiers) {
  return computeTierWindow(tierKeys, {
    allStepsLoaded: state.allStepsLoaded,
    extraStepsLoaded: state.extraStepsLoaded,
    hasActiveMatch: k => (tiers[k] || []).some(t => isActiveName(t.status) && matchesFilters(t)),
    hasAnyMatch: k => (tiers[k] || []).some(t => matchesFilters(t)),
  });
}

// ── Empty state for fresh/empty projects ──
export function renderEmptyBoardContent() {
  return `
    <div class="empty-board">
      <svg class="empty-board-icon" width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="5" y="3" width="14" height="18" rx="2"/>
        <path d="M9 3v2h6V3"/>
        <line x1="9" y1="11" x2="15" y2="11"/>
        <line x1="9" y1="15" x2="13" y2="15"/>
      </svg>
      <h2>${t('board.emptyTitle')}</h2>
      <p>${t('board.emptyHint')}</p>
      <div class="empty-board-actions">
        <button class="btn-empty-cta btn-empty-primary" id="empty-new-task">${t('board.newTaskCta')}</button>
        <button class="btn-empty-cta btn-empty-secondary" id="empty-objective">${t('board.createObjectiveCta')}</button>
      </div>
    </div>`;
}

// (C1245) Full field set for state.manualTaskState, defaulted from `src` (a
// sessionStorage draft, or nothing for a fresh form). Shared by the draft-rehydrate
// path below, ensureManualTaskState() (used by attachNewTaskFormHandlers), and the
// render-time fallback — one place defines what a "fresh" New Task form looks like.
function _manualTaskStateFields(src = {}) {
  return {
    title: src.title || '',
    description: src.description || '',
    priority: src.priority || '',
    type: src.type || 'task',
    tags: Array.isArray(src.tags) ? src.tags : [],
    category: src.category || 'CODING',
    status: src.status || startName(),
    agentAssignee: src.agentAssignee || '',
    // A fresh form preselects the current user; a draft always carries the key (see
    // saveNewTaskDraft), so an explicit "(none)" pick (null) survives a rehydrate.
    assignee: Object.hasOwn(src, 'assignee') ? (src.assignee ?? null) : (state.currentUserId ?? null),
    claudeModel: src.claudeModel || null,
    codexModel: src.codexModel || null,
    piModel: src.piModel || null,
    effort: src.effort || null,
    claudeDesignMode: !!src.claudeDesignMode,
    dependencies: Array.isArray(src.dependencies) ? src.dependencies : [],
  };
}

// Lazily creates state.manualTaskState so a field handler (status/category/agent/
// member/model/deps) that fires before the user has typed anything never silently
// drops its write — mirrors the draft-rehydrate branch in renderNewTaskForm below,
// minus the sessionStorage read (a fresh form, no draft to rehydrate from).
export function ensureManualTaskState() {
  if (!state.manualTaskState) {
    state.manualTaskState = { ..._manualTaskStateFields(), phase: 'form' };
  }
  return state.manualTaskState;
}

// ── New Task form (reusable — shared by root New Task and subtask creation) ──
export function renderNewTaskForm(tasks, tierKeys, parentTaskKey = null) {
  const parentAttr = `data-parent-task-key="${escapeAttr(parentTaskKey || '')}"`;
  const banner = parentTaskKey
    ? `<div class="subtask-context-note">${t('form.addingSubtaskTo')} <strong>${escapeAttr(parentTaskKey)}</strong></div>`
    : '';

  if (!state.manualTaskState || state.manualTaskState.phase === 'form') {
    if (!state.manualTaskState) {
      const taskDraft = loadDraft(DRAFT_KEY_TASK);
      if (taskDraft) {
        state.manualTaskState = { ..._manualTaskStateFields(taskDraft), phase: 'form' };
      }
    }
    // Render-only fallback (never mutates state) — same shape a fresh form would get.
    const s = state.manualTaskState || _manualTaskStateFields();
    const title = escapeAttr(s.title || '');
    const desc = escapeAttr(s.description || '');
    const selPriority = String(s.priority || '');
    const selType = s.type || 'task';
    const hasDraft = !!loadDraft(DRAFT_KEY_TASK);
    return `
        <div class="objective-form new-task-form" id="new-task-form" ${parentAttr}>
          ${banner}
          ${renderComposerHeader()}
          <div class="new-task-composer-card">
            <div class="new-task-primary-fields">
              <div class="new-task-field">
                <label for="new-task-title">${t('form.title')}</label>
                <input type="text" id="new-task-title" placeholder="${escapeAttr(t('form.titlePlaceholder'))}" value="${title}">
              </div>
              <div class="new-task-field">
                <label for="new-task-desc">${t('form.description')}</label>
                <textarea id="new-task-desc" placeholder="${escapeAttr(t('form.descPlaceholder'))}">${desc}</textarea>
              </div>
            </div>
            <div class="modal-fields new-task-meta-fields" id="new-task-fields">
              <div class="modal-field-row new-task-meta-row new-task-meta-row--wide"><label>${t('field.status')}</label><select class="modal-status-select">${_statusOptionsHtml(s.status)}</select></div>
              ${getSprintsEnabled() ? `<div class="modal-field-row new-task-meta-row new-task-meta-row--compact">
                <label for="new-task-priority">${groupPriorityFieldLabel()}</label>
                ${renderSprintCombobox({ id: 'new-task-priority', current: selPriority || '', keys: tierKeys, variant: 'plain', includeBacklog: true, globalMaxKey: sprintRecordMax(state.sprints) })}
              </div>` : ''}
              <div class="modal-field-row new-task-meta-row new-task-meta-row--wide"><label>${t('field.category')}</label><select class="new-task-category-select">
                <option value="CODING"${s.category !== 'HUMAN' ? ' selected' : ''}>${t('category.coding')}</option>
                <option value="HUMAN"${s.category === 'HUMAN' ? ' selected' : ''}>${t('category.human')}</option>
              </select></div>
              <div class="modal-field-row new-task-meta-row new-task-meta-row--wide"><label>${t('form.type')}</label>
                <select id="new-task-type">
                  <option value="task"${selType === 'task' ? ' selected' : ''}>${t('form.typeTask')}</option>
                  <option value="story"${selType === 'story' ? ' selected' : ''}>${t('form.typeStory')}</option>
                  <option value="bug"${selType === 'bug' ? ' selected' : ''}>${t('form.typeBug')}</option>
                </select>
              </div>
              <div class="modal-field-row new-task-meta-row new-task-meta-row--compact"><label>${t('field.agent')}</label>${renderAgentPicker('agentAssignee', s.agentAssignee || '', false, _taskAgentPickerOptions(), s.piModel)}</div>
              ${_agentModelControlHtml(s.agentAssignee || '', s, _cachedProjectConfig || {})}
              <div class="modal-field-row new-task-meta-row new-task-meta-row--wide"><label>${t('field.memberAssignee')}</label>${_renderMemberCombobox({ id: 'new-task-member-combo', assignee: s.assignee ?? null })}</div>
              <div class="modal-field-row new-task-meta-row new-task-meta-row--wide"><label>${t('form.tags')}</label>
                <div class="tag-input-wrapper" id="tag-input-wrapper">
                  ${(s.tags || []).map(tag => {
                    const tagDesc = state.tagDescriptions.get(tag);
                    return `<span class="tag-chip" data-tag="${escapeAttr(tag)}"${tagDesc ? ` title="${escapeAttr(tagDesc)}"` : ''}>${escapeAttr(tag)}<button class="tag-chip-remove" data-tag="${escapeAttr(tag)}">&times;</button></span>`;
                  }).join('')}
                  <input type="text" class="tag-input-field" id="tag-input-field" placeholder="${escapeAttr(t('form.tagsPlaceholder'))}" autocomplete="off">
                  <div class="tag-dropdown" id="tag-dropdown" style="display:none;"></div>
                </div>
              </div>
              <div class="modal-field-row new-task-meta-row new-task-meta-row--wide"><label>${t('field.dependencies')}</label>
                <div class="modal-deps">
                  ${(s.dependencies || []).map(_renderDepChip).join('')}
                  <input class="modal-dep-input" type="text" placeholder="${escapeAttr(t('field.addDepPlaceholder'))}" autocomplete="off">
                </div>
              </div>
            </div>
            <div class="form-actions-row new-task-actions">
              ${hasDraft ? `<button class="btn-clear-draft" id="clear-task-draft">${t('form.clearDraft')}</button>` : ''}
              <button class="btn-submit" id="new-task-preview">${t('form.preview')}</button>
            </div>
          </div>
        </div>`;
  }
  if (state.manualTaskState.phase === 'preview') {
    const pt = state.manualTaskState.previewTask;
    const idBadgeClass = pt.category === 'CODING' ? 'coding' : 'human';
    const agentLabel = pt.agentAssignee ? (_AGENT_PICKER_LABELS[pt.agentAssignee] || pt.agentAssignee) : '';
    const memberName = pt.assignee != null
      ? (Array.isArray(state.projectMembers) ? state.projectMembers.find(m => Number(m.user_id) === Number(pt.assignee)) : null)?.name
      : null;
    const metaExtras = [
      agentLabel ? `<span>${t('field.agent')}: ${escapeAttr(agentLabel)}</span>` : '',
      memberName ? `<span>${t('field.memberAssignee')}: ${escapeAttr(memberName)}</span>` : '',
      (pt.dependencies && pt.dependencies.length) ? `<span class="preview-deps">Deps: ${escapeAttr(pt.dependencies.join(', '))}</span>` : '',
    ].filter(Boolean).join('');
    return `
        <div class="objective-form" ${parentAttr}>
          <div class="objective-header">
            <span class="objective-header-label">${t('form.preview')}</span>
          </div>
          <div class="preview-cards-inline">
            <div class="preview-card new-task" data-task-id="${escapeAttr(pt.id)}">
              <span class="change-label">${t('form.newLabel')}</span>
              <div class="card-top">
                <span class="id-badge ${idBadgeClass}">${pt.id}</span>
                <span class="preview-title" contenteditable="false" data-field="title">${escapeAttr(pt.title)}</span>
              </div>
              <div class="preview-desc" contenteditable="false" data-field="description" data-raw="${escapeAttr(pt.description)}">${renderMarkdown(pt.description)}</div>
              <div class="preview-meta">
                <span class="status" style="--status-color:${statusColor(pt.status)}" data-status-role="${statusRoleToken(pt.status)}">${statusLabel(pt.status)}</span>
                <span>${t('form.priorityValue', { n: pt.priority })}</span>
                ${metaExtras}
              </div>
              ${(pt.tags && pt.tags.length) ? `<div class="card-tags">${pt.tags.map(tag => { const tagDesc = state.tagDescriptions.get(tag); return `<span class="tag-badge"${tagDesc ? ` title="${escapeAttr(tagDesc)}"` : ''}>${escapeAttr(tag)}</span>`; }).join('')}</div>` : ''}
            </div>
          </div>
          <div class="preview-actions-inline">
            <button class="btn-discard" id="new-task-back">${t('btn.back')}</button>
            <button class="btn-done" id="new-task-confirm">${t('btn.confirm')}</button>
          </div>
        </div>`;
  }
  return '';
}

// (C1259) Show More button markup shared by renderBoardContent/renderListContent and
// updateShowMoreButton()'s DOM-patch path below. Two states:
// - hiddenCount > 0: already-fetched tiers are hidden locally — reveal them, no fetch
//   (groupShowMore(n), exact count known).
// - hiddenCount === 0 but state.boardWindow.has_older: every fetched tier is visible,
//   but the server-side sprint window (api-backend.js getBoardTasks()) says older
//   sprints exist beyond what was fetched — offer to widen the window (groupLoadMore(),
//   no count: unknown until fetched). See template.html's #btn-load-more click handler.
function _loadMoreButtonHtml(hiddenCount, opts = {}) {
  if (hiddenCount > 0) {
    return `<div class="load-more-container"><button class="btn-load-more" id="btn-load-more">${groupShowMore(hiddenCount)}</button></div>`;
  }
  if (!state.allStepsLoaded && state.boardWindow && state.boardWindow.has_older) {
    // (C1333) Flat board has no group nouns to name — "Load Earlier Batches" reads wrong
    // with no batches on screen. Neutral label instead.
    const label = opts.flat ? t('board.loadEarlierTasks') : groupLoadMore();
    return `<div class="load-more-container"><button class="btn-load-more" id="btn-load-more">${label}</button></div>`;
  }
  return '';
}

// ── Board view HTML ──
export function renderBoardContent(tierKeys, tiers, sortTierFn, renderCardFn, renderState = null) {
  const keys = sprintTierKeys(tierKeys);
  const { visibleKeys, emptyKeys, hiddenCount } = computeVisibleTiers(keys, tiers);
  // (C1293) Use the filter snapshot belonging to this render. Reading the mutable global
  // Set while constructing markup could mix old fetched data with a newer filter selection.
  const selectedStatuses = renderState?.statusFilter instanceof Set
    ? renderState.statusFilter
    : state.statusFilter;
  const hasStatusFilter = selectedStatuses.size > 0;
  // (C1578) The board draws visibleKeys (active + revealed all-closed tiers) WITH content,
  // plus emptyKeys (card-less tiers) hidden — the latter must still exist in the DOM as
  // cross-sprint drop targets that reappear while body.board-dragging is set (styles.css).
  // Merge and re-derive from `keys` rather than concatenating, so the combined set comes
  // back in the board's natural ascending order regardless of each part's internal order.
  const renderSet = new Set([...visibleKeys, ...emptyKeys]);
  const mergedKeys = keys.filter(k => renderSet.has(k));
  // (C1577) 'asc' (default): lowest sprint at top, Load More at top. 'desc': legacy
  // highest-first order, Load More at bottom. computeVisibleTiers()'s reveal-pool
  // semantics (which tiers are visible/hidden) are untouched either way — only the
  // on-screen order of already-visible tiers and the Load-More button's position flip.
  const ascending = getSprintSortOrder() === 'asc';
  const orderedKeys = ascending ? [...mergedKeys] : [...mergedKeys].reverse();
  const loadMoreHtml = _loadMoreButtonHtml(hiddenCount);

  const timelineHtml = orderedKeys.map(p => {
    let sorted = sortTierFn(tiers[p] || []);
    sorted = sorted.filter(t => !taskHasNullSprint(t));
    if (state.humanFilterActive) sorted = sorted.filter(taskIsForHuman);
    if (assigneeFilterActive()) sorted = sorted.filter(taskMatchesAssigneeFilter);
    if (hasStatusFilter) sorted = sorted.filter(t => selectedStatuses.has(t.status));
    // (C1578) Was gated on a narrowing filter being active — now unconditional, so a
    // card-less tier (synthesized-empty, or emptied by completion/move/delete) is
    // rendered hidden rather than skipped: it must stay in the DOM as a drop target
    // that reappears while body.board-dragging is set (styles.css).
    const isEmpty = sorted.length === 0;
    const allDone = sorted.length > 0 && sorted.every(t => isClosedName(t.status));
    const isCollapsed = state.collapsedTiers.has(p) || (allDone && !state.expandedTiers.has(p));
    const incompleteCount = sorted.filter(t => isActiveName(t.status)).length;
    const badge = incompleteCount > 0 ? `<span class="tier-badge">${incompleteCount}</span>` : '';
    const doneCheck = allDone ? `<span class="tier-done-check"><svg viewBox="0 0 12 12" fill="none"><polyline points="2.5 6 5 8.5 9.5 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : '';
    // Must match task-card.js's .btn-sprint-play click-handler filter exactly — this
    // badge count is a promise about how many tasks that click will actually start.
    // (C1460) canStartTaskCard(t) matters more than it used to: it returns false for
    // t.isObjective, and under objective grouping ON a tier can now hold the parent
    // container instead of its (grouping-hidden) subtasks — without this filter the
    // button would read "Start 1" and start nothing.
    const playableCount = sorted.filter(
      t => isActiveName(t.status) && !isInProgressName(t.status) && t.category === 'CODING' && !isDepsBlocked(t)
        && canStartTaskCard(t)
    ).length;
    const playBtn = playableCount > 0 ? `<button class="btn-sprint-play" data-priority="${p}" title="${escapeAttr(tc('board.startTasks', playableCount))}" aria-label="${escapeAttr(t('board.startAllAria', { label: groupTitle(p) }))}"><svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor"><polygon points="3,2 10,6 3,10"/></svg><span class="btn-sprint-play-label">${t('btn.start')}</span></button>` : '';
    const _tierTitle = _tierTitleFor(p);
    return `
      <div class="tier${isEmpty ? ` ${HIDE_CLASS}` : ''}${isCollapsed ? ' collapsed' : ''}" data-priority="${p}">
        <div class="tier-label" data-priority="${p}">${_tierTitle}${badge}${doneCheck}${playBtn}</div>
        <div class="tier-cards">
          ${sorted.map(renderCardFn).join('')}
          <div class="tier-drop-sentinel" aria-hidden="true"></div>
        </div>
      </div>`;
  }).join('');

  // (C1578) Nothing is actually VISIBLE (e.g. a backlog-only project — every sprint record
  // is card-less) — still emit the (hidden) tiers so drag-drop into them keeps working, but
  // tell the user why the board looks blank instead of leaving an unexplained gap.
  if (visibleKeys.length === 0 && keys.length > 0) {
    return `
      ${loadMoreHtml}
      <div class="timeline">${timelineHtml}</div>
      <div class="board-no-sprint-tasks">${t('board.noSprintTasks')}</div>`;
  }
  return `
    ${ascending ? loadMoreHtml : ''}
    <div class="timeline">${timelineHtml}</div>
    ${ascending ? '' : loadMoreHtml}`;
}

// Without sprints, merge backlog into one tier and keep `.tier`/`.tier-cards`
// selectors for filtering and drag. Omit data-priority so drag cannot trigger
// a cross-sprint priority patch.
export function renderFlatBoardContent(allTasks, sortTierFn, renderCardFn, renderState = null) {
  const source = Array.isArray(allTasks) ? allTasks : [];
  // (C1293) Same filter-snapshot discipline as renderBoardContent above.
  const selectedStatuses = renderState?.statusFilter instanceof Set
    ? renderState.statusFilter
    : state.statusFilter;
  const hasStatusFilter = selectedStatuses.size > 0;
  // Cross-priority sort: sortTierFn (sortTier) only orders within one already-homogeneous
  // tier by `order` — a flat list spans every priority, so sort priority-major first,
  // `order` as tiebreak. Newest sprint first, backlog (priority 0) last.
  let sorted = [...source].sort((a, b) =>
    (Number(b.priority) || 0) - (Number(a.priority) || 0) || (b.order ?? 0) - (a.order ?? 0)
  );
  if (state.humanFilterActive) sorted = sorted.filter(taskIsForHuman);
  if (assigneeFilterActive()) sorted = sorted.filter(taskMatchesAssigneeFilter);
  if (hasStatusFilter) sorted = sorted.filter(t => selectedStatuses.has(t.status));
  return `
    <div class="timeline">
      <div class="tier tier--flat">
        <div class="tier-cards">
          ${sorted.map(renderCardFn).join('')}
          <div class="tier-drop-sentinel" aria-hidden="true"></div>
        </div>
      </div>
    </div>
    ${_loadMoreButtonHtml(0, { flat: true })}`;
}

// ── List view HTML ──
export function renderListContent(tierKeys, tiers, sortTierFn, renderCardFn) {
  const keys = sprintTierKeys(tierKeys);
  const { visibleKeys, hiddenCount } = computeVisibleTiers(keys, tiers);
  // (C1577) Same order-aware treatment as renderBoardContent — List tab must never
  // disagree with Board about sprint order.
  const ascending = getSprintSortOrder() === 'asc';
  const orderedKeys = ascending ? [...visibleKeys] : [...visibleKeys].reverse();
  const loadMoreHtml = _loadMoreButtonHtml(hiddenCount);
  // (C1578) List has no drag/drop and no post-render DOM filter pass of its own (List
  // cards live in .list-group-cards, never matched by applySearchFilter's selector) — a
  // card-less group is skipped outright rather than rendered hidden.
  if (orderedKeys.length === 0 && keys.length > 0) {
    return `${loadMoreHtml}<div class="board-no-sprint-tasks">${t('board.noSprintTasks')}</div>`;
  }
  return `
    ${ascending ? loadMoreHtml : ''}
    <div class="list-view">
      ${orderedKeys.map(p => {
        let sorted = sortTierFn(tiers[p] || []);
        sorted = sorted.filter(t => !taskHasNullSprint(t));
        if (state.humanFilterActive) sorted = sorted.filter(taskIsForHuman);
        if (assigneeFilterActive()) sorted = sorted.filter(taskMatchesAssigneeFilter);
        if (statusFilterActive()) sorted = sorted.filter(taskMatchesStatusFilter);
        if (sorted.length === 0) return ''; // (C1578) was gated on a narrowing filter; now unconditional
        const codingTasks = sorted.filter(t => t.category === 'CODING');
        const humanTasks = sorted.filter(taskIsForHuman);
        const _tierTitleL = _tierTitleFor(p);
        return `
          <div class="list-group">
            <h3 class="list-group-title">${_tierTitleL}</h3>
            <div class="list-group-columns">
              ${codingTasks.length ? `
                <div class="list-group-column list-group-column--coding">
                  <div class="list-group-subtitle">${t('board.codingColumn')}</div>
                  <div class="list-group-cards">
                    ${codingTasks.map(renderCardFn).join('')}
                  </div>
                </div>` : '<div></div>'}
              <div class="list-group-lifeline-gap"></div>
              ${humanTasks.length ? `
                <div class="list-group-column list-group-column--human">
                  <div class="list-group-subtitle">${t('board.humanColumn')}</div>
                  <div class="list-group-cards">
                    ${humanTasks.map(renderCardFn).join('')}
                  </div>
                </div>` : '<div></div>'}
            </div>
          </div>`;
      }).join('')}
    </div>
    ${ascending ? '' : loadMoreHtml}`;
}

// ── Backlog view HTML ──
export function renderBacklogContent(allTasks, sortTierFn, renderCardFn) {
  const source = Array.isArray(allTasks) ? allTasks : [];
  const hasAnyBacklog = source.some(taskHasNullSprint);
  let backlogTasks = source
    .filter(taskHasNullSprint);
  if (state.humanFilterActive) backlogTasks = backlogTasks.filter(taskIsForHuman);
  if (assigneeFilterActive()) backlogTasks = backlogTasks.filter(taskMatchesAssigneeFilter);
  if (statusFilterActive()) backlogTasks = backlogTasks.filter(taskMatchesStatusFilter);
  backlogTasks = sortTierFn(backlogTasks);
  const emptyText = hasAnyBacklog && anyNarrowingFilterActive()
    ? t('backlog.emptyFiltered')
    : t('backlog.empty');

  return `
    <section class="backlog-section" data-has-any-backlog="${hasAnyBacklog ? '1' : '0'}">
      <div class="backlog-header">
        <h2>${t('backlog.title')}</h2>
        <span class="backlog-count">${tc('backlog.taskCount', backlogTasks.length)}</span>
      </div>
      <div class="backlog-card-list"${backlogTasks.length ? '' : ' hidden'}>
        ${backlogTasks.map(renderCardFn).join('')}
      </div>
      <div class="backlog-empty"${backlogTasks.length ? ' hidden' : ''}>${emptyText}</div>
    </section>`;
}

// (C1442) Board/List/To-Do can never render a backlog (no-sprint) task — they only exist on
// the Backlog tab (or inline on the flat board when sprints are disabled, where this hint is
// unnecessary). When an active filter's only match is stranded in the backlog, the board would
// otherwise render empty with no explanation — this renders a click-through pointer instead.
// `allTasks` must be the SAME set renderBacklogContent() itself draws from, not the tab's own
// narrower render domain — it must look at backlog rows the active tab excludes but Backlog
// still shows. (C1460) That set is groupedTasks, not raw visibleTasks: renderBacklogContent
// is grouping-filtered too, so counting over the ungrouped set here would promise a Backlog
// match that's actually grouping-hidden and won't be there when the user clicks through.
export function renderBacklogHintHtml(allTasks) {
  if (!getSprintsEnabled()) return ''; // flat board already shows backlog inline, nothing to point at
  if (!anyNarrowingFilterActive()) return '';
  const source = Array.isArray(allTasks) ? allTasks : [];
  const n = source.filter(t => taskHasNullSprint(t) && matchesFilters(t)).length;
  if (!n) return '';
  return `<div class="backlog-hint"><button type="button" class="backlog-hint-link" data-tab="backlog">${escapeAttr(tc('backlog.filterHint', n))}</button></div>`;
}

// ── To-Do view HTML ──
export function renderTodoContent(allTasks, tierKeys) {
  const keys = sprintTierKeys(tierKeys || state.tierKeys).sort((a, b) => a - b);
  if (!keys.length) {
    state.todoSprintPriority = null;
    return `<div class="todo-empty">${t('todo.allComplete')}</div>`;
  }

  if (state.todoSprintPriority != null && !keys.includes(Number(state.todoSprintPriority))) {
    state.todoSprintPriority = null;
  }

  if (state.todoSprintPriority == null) {
    const highestActive = [...keys].reverse().find((priority) =>
      allTasks.some((t) =>
        !taskHasNullSprint(t) &&
        (t.priority ?? 99) === priority &&
        isActiveName(t.status)
      )
    );
    state.todoSprintPriority = highestActive ?? keys[keys.length - 1];
  }

  const current = Number(state.todoSprintPriority);
  const currentIdx = keys.indexOf(current);
  const prevKey = currentIdx > 0 ? keys[currentIdx - 1] : null;
  const nextKey = currentIdx >= 0 && currentIdx < keys.length - 1 ? keys[currentIdx + 1] : null;
  let sprintTasks = allTasks
    .filter((t) => !taskHasNullSprint(t) && (t.priority ?? 99) === current)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (state.humanFilterActive) sprintTasks = sprintTasks.filter(taskIsForHuman);
  if (assigneeFilterActive()) sprintTasks = sprintTasks.filter(taskMatchesAssigneeFilter);
  if (statusFilterActive()) sprintTasks = sprintTasks.filter(taskMatchesStatusFilter);

  const navHtml = `
    <div class="todo-sprint-nav">
      <button type="button" class="todo-sprint-prev"${prevKey == null ? ' disabled' : ''}>${t('btn.prev')}</button>
      ${renderSprintCombobox({ id: 'todo-sprint-combo', current: state.todoSprintPriority, keys, variant: 'plain' })}
      <button type="button" class="todo-sprint-next"${nextKey == null ? ' disabled' : ''}>${t('btn.next')}</button>
    </div>`;

  if (!sprintTasks.length) {
    return navHtml + `<div class="todo-empty">${groupEmpty()}</div>`;
  }

  return navHtml + `<div class="todo-list">${sprintTasks.map(task => {
    const aa = task.agentAssignee;
    const agentLocked = aa && aa !== 'human';
    let agentBadge = '';
    if (agentLocked) {
      // (C1326) mirror task-card.js renderAgentBadge() — this To-Do renderer previously
      // fell through to the Codex icon for any non-claude agent, mislabelling Pi tasks.
      let icon, label;
      if (aa === 'claude') { icon = CLAUDE_BADGE_SVG; label = 'Claude Code'; }
      else if (aa === 'codex') { icon = CODEX_BADGE_SVG; label = 'Codex'; }
      else if (aa === 'pi') { icon = PI_BADGE_SVG; label = task.piModel ? shortModelName(task.piModel) : 'Pi'; }
      else { icon = HUMAN_BADGE_SVG; label = 'Human'; }   // defensive: unknown agent id
      agentBadge = `<span class="agent-badge agent-badge--${escapeAttr(aa)}" title="${escapeAttr(label)}">${icon}</span>`;
    }
    const itemClass = `todo-item todo-item--${task.status}${agentLocked ? ' agent-assigned' : ''}`;
    return `
    <div class="${itemClass}" data-task-id="${escapeAttr(task.id)}" data-status-role="${statusRoleToken(task.status)}">
      <input type="checkbox" class="todo-check" data-task-id="${escapeAttr(task.id)}"${isCompleteName(task.status) ? ' checked' : ''}${agentLocked ? ' disabled' : ''}>
      ${agentBadge}
      <span class="todo-item-id">${escapeAttr(task.id)}</span>
      <span class="todo-title${isCompleteName(task.status) ? ' done' : ''}">${escapeAttr(task.title)}</span>
      <a class="todo-more" href="#" data-task-id="${escapeAttr(task.id)}">${t('todo.more')}</a>
    </div>`;
  }).join('')}</div>`;
}

// ── Search input dynamic width ──
let _searchMeasurer = null;
export function updateSearchInputWidth() {
  const wrap = document.querySelector('.search-input-wrap');
  const input = document.querySelector('.search-input');
  if (!wrap || !input) return;
  const resetBtn = document.getElementById('search-reset-btn');
  const hasClear = !!(resetBtn && resetBtn.classList.contains('visible'));

  // (C1384) Inline X clear button lives inside .search-field, right on top of the input's
  // own right edge. Sync its visibility here — this fn already runs from every path that can
  // change state.searchQuery (debounce input, focus/blur, Escape, Clear-All, project restore,
  // both applySearchFilter() branches) so it is the one shared choke point for all of them.
  const clearBtn = document.querySelector('.search-clear-btn');
  if (clearBtn) clearBtn.hidden = !input.value;

  const MIN = 180;
  const MAX = 320; // (C1155) bar is nowrap now — 420 fought the status select + reload for room

  let desired = MIN;
  if (input.value) {
    if (!_searchMeasurer) {
      _searchMeasurer = document.createElement('span');
      _searchMeasurer.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;top:-9999px;left:-9999px;pointer-events:none;';
      document.body.appendChild(_searchMeasurer);
    }
    const cs = getComputedStyle(input);
    _searchMeasurer.style.font = cs.font;
    _searchMeasurer.style.letterSpacing = cs.letterSpacing;
    _searchMeasurer.textContent = input.value;
    // (C1384) was 24 (2 * 0.6rem padding + 2 * 1.5px border) — .search-input now reserves an
    // extra 1.6rem on the right for the inline X gutter (styles.css), so text stops sliding
    // under the icon once the auto-width kicks in.
    const paddingX = 40;
    const buffer = 16;   // keep cursor off the edge
    let contentWidth = _searchMeasurer.offsetWidth + paddingX + buffer;
    if (hasClear && resetBtn.offsetWidth > 0) {
      const gap = 6; // .search-input-wrap gap: 0.35rem ≈ 5.6px
      contentWidth += resetBtn.offsetWidth + gap;
    }
    desired = Math.max(MIN, Math.min(MAX, contentWidth));
  }

  wrap.style.width = desired + 'px';
}

// (C1384) Inline X inside .search-field — clears ONLY the search phrase. Distinct from
// #search-reset-btn ("Clear"), which resets all four filter dimensions (search, tag, human,
// status). Mirrors refreshBoardForFilters()'s rerender-callback contract (C1321): use the
// passed-in loadAndRender when given, degrade to the DOM-only applySearchFilter() pass
// otherwise, since task-board.js cannot import loadAndRender (it lives in template.html).
export async function clearSearchQuery(rerender) {
  state.searchQuery = '';
  state.extraStepsLoaded = 0;
  state.allStepsLoaded = false;
  const input = document.querySelector('.search-input');
  if (input) input.value = '';
  onBoardFiltersChanged();
  if (typeof rerender === 'function') await rerender();
  else applySearchFilter();
  // loadAndRender() rewrites #app.innerHTML, detaching the input the click came from — re-query
  // after the render before focusing, same reason refreshBoardForFilters() re-focuses its
  // checkbox post-rebuild.
  const fresh = document.querySelector('.search-input');
  if (fresh) fresh.focus();
  updateSearchInputWidth();
}

// ── Search filter ──
export function applySearchFilter() {
  const needle = state.searchQuery.trim().toLowerCase();
  const resetBtn = document.getElementById('search-reset-btn');
  const humanFilter = state.humanFilterActive;
  const assigneeFilter = assigneeFilterActive();
  const statusFilter = statusFilterActive();
  const hasActiveFilters = Boolean(state.activeTagFilters.size > 0 || humanFilter || assigneeFilter || statusFilter || state.searchQuery.trim());
  const cardSelector = '.tier .card[data-id], .backlog-section .card[data-id]';

  if (!needle) {
    document.querySelectorAll('.card.search-hidden').forEach(c => c.classList.remove('search-hidden'));
    document.querySelectorAll('.card.search-match').forEach(c => c.classList.remove('search-match'));

    // Apply human + assignee + status filters when no search query
    if (humanFilter || assigneeFilter || statusFilter) {
      document.querySelectorAll(cardSelector).forEach(card => {
        if (!cardMatchesHumanFilter(card) || !cardMatchesAssigneeFilter(card) || !cardMatchesStatusFilter(card)) {
          card.classList.add('search-hidden');
        }
      });
    } else {
      document.querySelectorAll('.tier[data-priority]').forEach(tier => {
        const p = Number(tier.dataset.priority);
        const allDone = [...tier.querySelectorAll('.card[data-status]')].every(
          c => isClosedName(c.dataset.status)
        );
        if (state.collapsedTiers.has(p) || (allDone && !state.expandedTiers.has(p))) {
          tier.classList.add('collapsed');
        } else {
          tier.classList.remove('collapsed');
        }
      });
    }

    // Tag filter pass (no search query active)
    applyTagFilter();
    // (C1578) Sole point that hides/shows a tier by card count on this branch — covers both
    // the human/assignee/status-filter path above AND the plain no-filter resync, which is
    // exactly the tail a WS task:updated patch reaches (regroupCardToSprint()'s 'moved' path
    // never reloads, so this is what makes an emptied-by-move source tier disappear).
    syncEmptyTierVisibility();
    updateBacklogEmptyState();
    updateShowMoreButton();

    if (resetBtn) {
      resetBtn.disabled = !hasActiveFilters;
      resetBtn.classList.toggle('visible', hasActiveFilters);
    }
    updateSearchInputWidth();
    // (C1258) markTruncatedCards() call removed here — template.html's wire tail already calls
    // it exactly once per render (after this function returns), covering both branches of this
    // function. This branch used to call it AGAIN, a second forced-layout pass over every
    // .card/.preview-card on every render with no active search query.
    return;
  }

  // (TPT351) Visibility only: this pass toggles `search-hidden` and the style-free `search-match`
  // marker, nothing else — no inline styles, no expanded-state classes on cards or tiers. Card
  // layout is identical with and without a search term; expansion stays hover/focus/click-driven.
  document.querySelectorAll(cardSelector).forEach(card => {
    const id = (card.dataset.id || '').toLowerCase();
    const titleEl = card.querySelector('.card-title');
    const title = titleEl ? titleEl.textContent.toLowerCase() : '';
    const descEl = card.querySelector('.card-desc');
    const desc = descEl ? (descEl.dataset.raw || descEl.textContent || '').toLowerCase() : '';
    const badgeEl = card.querySelector('.id-badge');

    // Human + assignee + status filters take precedence over search match.
    if ((humanFilter && !cardMatchesHumanFilter(card)) || (assigneeFilter && !cardMatchesAssigneeFilter(card)) || (statusFilter && !cardMatchesStatusFilter(card))) {
      card.classList.add('search-hidden');
      card.classList.remove('search-match');
      return;
    }

    const badge = badgeEl ? badgeEl.textContent.toLowerCase() : '';
    const matches = id.includes(needle) || title.includes(needle) || desc.includes(needle) || badge.includes(needle);
    card.classList.toggle('search-hidden', !matches);
    card.classList.toggle('search-match', matches);
  });

  if (resetBtn) {
    resetBtn.disabled = !hasActiveFilters;
    resetBtn.classList.toggle('visible', hasActiveFilters);
  }
  updateSearchInputWidth();

  // Tag filter pass (runs after search + human filter)
  applyTagFilter();
  syncEmptyTierVisibility({ reveal: true }); // (C1578) search/tag path also un-collapses matches
  updateBacklogEmptyState();
  updateShowMoreButton();
}

// (C1502) Full-screen/blocking surfaces the client creates by appending an overlay node to
// `document.body` (removed on close, so mere presence == open) — a global type-to-filter
// handler must defer to whichever of these is up rather than hijacking the keystroke. The two
// static exceptions (`#task-edit-modal`, `#settings-modal`) never get removed, so they're
// tested by `hidden`/`.open` instead of presence. Keep this list in sync with any new overlay a
// future feature adds (see `ai/architecture/tt-task-board.md` § Type to filter).
const _TYPE_TO_FILTER_OVERLAY_SELECTOR = [
  '.modal-overlay', '.terminal-overlay', '.split-modal-overlay', '.reiterate-modal-overlay',
  '.trello-import-modal-overlay', '.trello-wizard-overlay', '.gmail-wizard-overlay',
  '.agent-assign-overlay', '.bulk-agent-start-overlay', '.bulk-deps-overlay',
  '.agent-selector-overlay', '.img-lightbox-overlay', '.tag-cloud-modal-overlay',
  '.mcp-auth-overlay', '.agents-modal', '.merge-modal', '.spec-chat-modal', '.setup-modal',
  '#task-edit-modal:not([hidden])', '#settings-modal.open', '.mobile-menu.open',
].join(', ');

let _typeToFilterBound = false;

// (C1502) Document-level keydown: with the Project Board in view and nothing focused, typing a
// plain printable character focuses the board's search input, appends the character, and fires
// the exact same `input` event the field's own listener (template.html) already handles — the
// 150ms debounce, state.searchQuery write, onBoardFiltersChanged() persistence, and
// applySearchFilter() repaint all run unchanged, so none of that is duplicated here.
//
// Bound once at bundle-eval time (index.js), same reasoning as registerVoiceShortcut()/
// ensureFileLinkHandler() there — loadAndRender() has early-return paths a render-bound listener
// could miss. Bound on the BUBBLE phase (not capture) so every existing capture-phase Escape
// handler (bulk-deps modal, image lightbox, showActionConfirm, the voice shortcut) still gets
// first look and can stopPropagation() before this ever runs.
export function enableTypeToFilter() {
  if (_typeToFilterBound) return;
  document.addEventListener('keydown', (e) => {
    // .search-input only exists in the DOM on tasks-section tabs (board/list/todo/backlog) —
    // re-queried every time, never cached: loadAndRender() rewrites #app.innerHTML on every
    // render, same contract clearSearchQuery() relies on above.
    const input = document.querySelector('.search-input');
    const ctx = {
      activeElement: document.activeElement,
      boardActive: state.activeTab === 'board',
      hasSearchInput: !!input,
      overlayOpen: !!document.querySelector(_TYPE_TO_FILTER_OVERLAY_SELECTOR),
      searchFocused: !!input && document.activeElement === input,
      searchHasText: !!state.searchQuery,
    };
    if (!shouldTypeToFilter(e, ctx)) return;
    e.preventDefault();
    input.focus();
    input.value += e.key;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  _typeToFilterBound = true;
}

function updateBacklogEmptyState() {
  const section = document.querySelector('.backlog-section');
  if (!section) return;
  const list = section.querySelector('.backlog-card-list');
  const empty = section.querySelector('.backlog-empty');
  const count = section.querySelector('.backlog-count');
  if (!list || !empty) return;

  const cards = [...list.querySelectorAll('.card[data-id]')];
  const visibleCards = cards.filter(card => !card.classList.contains('search-hidden'));
  const hasVisible = visibleCards.length > 0;
  const hasAnyBacklog = section.dataset.hasAnyBacklog === '1';
  const hasActiveFilters = Boolean(
    state.searchQuery.trim() ||
    state.activeTagFilters.size > 0 ||
    state.humanFilterActive ||
    assigneeFilterActive() ||
    statusFilterActive()
  );

  list.hidden = !hasVisible;
  empty.hidden = hasVisible;
  empty.textContent = hasAnyBacklog && hasActiveFilters
    ? t('backlog.emptyFiltered')
    : t('backlog.empty');
  if (count) count.textContent = tc('backlog.taskCount', visibleCards.length);
}

// ── Update Show More button text based on current filters ──
function updateShowMoreButton() {
  const btn = document.getElementById('btn-load-more');
  if (!btn || !state.tiers || !state.tierKeys) return;
  const { hiddenCount } = computeVisibleTiers(state.tierKeys, state.tiers);
  const container = btn.closest('.load-more-container');
  const canFetchMore = !state.allStepsLoaded && !!(state.boardWindow && state.boardWindow.has_older);
  if (hiddenCount > 0) {
    btn.textContent = groupShowMore(hiddenCount);
    if (container) container.style.display = '';
  } else if (canFetchMore) {
    // (C1259) local reveal pool exhausted, but the server-side sprint window says
    // older sprints exist — same button, now offers to widen the window instead.
    btn.textContent = groupLoadMore();
    if (container) container.style.display = '';
  } else {
    if (container) container.style.display = 'none';
  }
}

// (C1259) Patches the top-nav filter bar chrome (status-filter trigger label + per-row
// counts/checked state, tag-filter-chips bar, tag/human filter button active classes)
// in place — no fetch, no #app.innerHTML rebuild. Paired with applySearchFilter() (which
// already re-hides/re-shows cards+tiers without a re-render) by every filter-toggle
// handler in template.html that used to call loadAndRender() for a purely client-side
// filter change. Reads state._lastVisibleTasks (set once per real loadAndRender()) for
// facet counts — never re-fetches or re-derives it.
export function refreshFilterBarChrome(app = document.getElementById('app')) {
  if (!app) return;

  // (C1442/C1460) Same two-stage domain the full render computes at template.html — a
  // DOM-only filter toggle (search/tag) must not re-inflate counts back to "every fetched
  // row" including backlog the active tab can't draw, or subtasks/parents the objective
  // grouping filter hides. state._lastVisibleTasks stays unfiltered by design (see its
  // declaration in template.html), so grouping is re-derived here rather than read off state.
  const groupedVisible = tasksVisibleUnderGrouping(state._lastVisibleTasks || [], {
    objectiveGrouping: getObjectiveGroupingEnabled(),
    drilldown: state.subtaskStack.length > 0,
  });
  const countDomain = tasksForActiveTab(groupedVisible, { tab: state.activeTab, sprintsEnabled: getSprintsEnabled() });

  const statusWrap = app.querySelector('.status-filter-wrap');
  if (statusWrap) {
    const counts = computeStatusCounts(countDomain);
    statusWrap.classList.toggle('active', state.statusFilter.size > 0);
    const trigger = statusWrap.querySelector('.btn-filter-status');
    if (trigger) trigger.textContent = statusFilterLabel(counts);
    statusWrap.querySelectorAll('input[type="checkbox"][data-status]').forEach(cb => {
      const checked = isStatusRowChecked(state.statusFilter, cb.dataset.status);
      if (cb.checked !== checked) cb.checked = checked;
      const countEl = cb.closest('.status-filter-option')?.querySelector('.status-filter-count');
      const count = cb.dataset.status === '' ? counts.all : (counts[cb.dataset.status] || 0);
      if (countEl) countEl.textContent = `(${count})`;
    });
  }

  const tagFilterBtn = app.querySelector('.btn-tag-filter');
  if (tagFilterBtn) tagFilterBtn.classList.toggle('active', state.activeTagFilters.size > 0);

  const chipsHost = app.querySelector('.search-group');
  if (chipsHost) {
    const existing = chipsHost.querySelector('.tag-filter-chips');
    if (state.activeTagFilters.size === 0) {
      if (existing) existing.remove();
    } else {
      const html = [...state.activeTagFilters].map(tag =>
        `<button class="tag-chip" data-tag="${escapeAttr(tag)}">${escapeAttr(tag)} <span class="tag-chip-close">×</span></button>`
      ).join('');
      if (existing) {
        existing.innerHTML = html;
      } else {
        const div = document.createElement('div');
        div.className = 'tag-filter-chips';
        div.innerHTML = html;
        chipsHost.insertBefore(div, chipsHost.firstChild);
      }
      // Re-bind: the chip nodes are new/rebuilt, so their click listeners must be too.
      chipsHost.querySelectorAll('.tag-filter-chips .tag-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          state.activeTagFilters.delete(chip.dataset.tag);
          onBoardFiltersChanged();
          applySearchFilter();
          refreshFilterBarChrome(app);
        });
      });
    }
  }

  const peopleFilterBtn = app.querySelector('.btn-people-filter');
  if (peopleFilterBtn) {
    peopleFilterBtn.classList.toggle('active', state.assigneeScope === 'all' || assigneeFilterActive() || state.humanFilterActive);
    // (C1441) Write the label span, not the button — the button now also owns an icon
    // child (PEOPLE_FILTER_ICON_SVG); a whole-button textContent write would erase it.
    const peopleFilterLabelEl = peopleFilterBtn.querySelector('.people-filter-label');
    if (peopleFilterLabelEl) peopleFilterLabelEl.textContent = peopleFilterLabel();
    else peopleFilterBtn.textContent = peopleFilterLabel();
  }
  // (C1442) Per-member/Unassigned counts in the People dropdown — was never patched here
  // before, only the trigger label was; a DOM-only filter toggle left stale (or, pre-C1442,
  // wrongly backlog-inflated) numbers next to each row until the next full render.
  const peopleFilterPanel = app.querySelector('.people-filter-dropdown');
  if (peopleFilterPanel) {
    const assigneeCounts = computeAssigneeCounts(countDomain);
    peopleFilterPanel.querySelectorAll('.people-filter-option--member input[data-assignee]').forEach(cb => {
      const raw = cb.dataset.assignee;
      const key = raw === 'none' ? 'none' : Number(raw);
      const countEl = cb.closest('.people-filter-option')?.querySelector('.people-filter-count');
      if (countEl) countEl.textContent = `(${assigneeCounts[key] || 0})`;
    });
  }

  const resetBtn = app.querySelector('#search-reset-btn');
  if (resetBtn) {
    // (C1442) anyNarrowingFilterActive() covers 5 of the 6 dimensions; the bare
    // assigneeScope === 'all' (All Tasks, no member ticked) is added back here on purpose —
    // it isn't a "narrowing" filter (see that helper's comment) but IS a non-default state
    // the Reset button should still be able to clear.
    const hasActiveFilters = anyNarrowingFilterActive() || state.assigneeScope === 'all';
    resetBtn.disabled = !hasActiveFilters;
  }
}

// Status and assignee filters exclude tasks during render, so DOM-only search cannot
// reveal newly matching tasks. Rerender on those changes; the board-task cache is reused.
// Caller supplies rerender to avoid a template.html import cycle.
export function refreshBoardForFilters(rerender, opts = {}) {
  const app = opts.app || document.getElementById('app');
  // Persist first: the selection is durable even if the render below gets superseded by a
  // newer one (rapid clicking) or throws. (C1452) Also clears the bulk selection/bar —
  // status/human/people are the render-time-baked filters, so this must happen before
  // the render below repaints renderCard()'s selectedCardIds-derived markup.
  onBoardFiltersChanged();
  // Bumps state._boardRenderRevision so an already-in-flight older render (e.g. a background
  // cache refresh) cannot land after this and repaint #app with the previous selection.
  invalidateBoardRenderState();

  // Immediate first paint. On the common path `rerender()` below is a board-task-cache hit
  // and lands synchronously in this same tick, making this pass redundant — but it's the
  // only thing that shows anything on a cache MISS (evicted entry, subtask drill-down,
  // forceFresh), where the render must await a fetch, and it's the only thing that runs at
  // all if `rerender` is omitted or the render bails early (e.g. the C1200 live-recording
  // deferral in loadAndRender()). Never wrong, only incomplete for the widen/list/todo cases
  // this helper exists to fix — the render that follows completes those.
  applySearchFilter();
  refreshFilterBarChrome(app);

  if (typeof rerender !== 'function') return Promise.resolve();

  // #app.innerHTML is about to be replaced, which detaches the checkbox/button the user just
  // interacted with — capture it so focus (and thus space-bar toggling) survives the rebuild.
  // Only recapture if the browser actually gave this control focus: a <label>-wrapped
  // checkbox click focuses the input in Chromium/Firefox but not in Safari, and mirroring
  // activeElement means never stealing focus the browser itself didn't grant.
  const active = document.activeElement;
  const focusStatus = active && active.matches('input[type="checkbox"][data-status]')
    ? active.dataset.status
    : null;
  // (C1407) Human filter moved from a standalone .btn-human-filter icon button into the
  // People-filter panel — three more controls in there can hold focus at rebuild time,
  // same "only if the browser actually granted focus" discipline as focusStatus above.
  const focusWasPeopleBtn = !!(active && active.classList && active.classList.contains('btn-people-filter'));
  const focusAssigneeScope = active && active.matches('input[data-assignee-scope]')
    ? active.dataset.assigneeScope
    : null;
  const focusAssignee = active && active.matches('input[data-assignee]')
    ? active.dataset.assignee
    : null;
  const focusWasHumanCheckbox = !!(active && active.matches('input[data-human-filter]'));

  return Promise.resolve(rerender()).then(() => {
    const freshApp = opts.app || document.getElementById('app');
    if (!freshApp) return;
    if (focusStatus != null) {
      // Find by dataset.status rather than an attribute-selector template string: statuses
      // are user-creatable per project (C1181/C1184), and a custom name containing a quote
      // would otherwise break the selector.
      const cb = [...freshApp.querySelectorAll('input[type="checkbox"][data-status]')]
        .find(el => el.dataset.status === focusStatus);
      // preventScroll: the render's own scroll-position restore has already run by now: a
      // focus-induced scroll-into-view would fight it and jump the page.
      if (cb) cb.focus({ preventScroll: true });
    } else if (focusWasPeopleBtn) {
      const btn = freshApp.querySelector('.btn-people-filter');
      if (btn) btn.focus({ preventScroll: true });
    } else if (focusAssigneeScope != null) {
      const radio = freshApp.querySelector(`input[data-assignee-scope="${focusAssigneeScope}"]`);
      if (radio) radio.focus({ preventScroll: true });
    } else if (focusAssignee != null) {
      const cb = [...freshApp.querySelectorAll('input[data-assignee]')]
        .find(el => el.dataset.assignee === focusAssignee);
      if (cb) cb.focus({ preventScroll: true });
    } else if (focusWasHumanCheckbox) {
      const cb = freshApp.querySelector('input[data-human-filter]');
      if (cb) cb.focus({ preventScroll: true });
    }
  });
}

function applyTagFilter() {
  if (state.activeTagFilters.size === 0) return;
  const activeTags = [...state.activeTagFilters];
  document.querySelectorAll('.tier .card[data-id], .backlog-section .card[data-id]').forEach(card => {
    if (card.classList.contains('search-hidden')) return;
    const cardTags = JSON.parse(card.dataset.tags || '[]');
    const hasAll = activeTags.every(t => cardTags.includes(t));
    if (!hasAll) card.classList.add('search-hidden');
  });
}

// ── Sole writer of tier-level emptiness (C1578) ──
// One meaning, one class: `.tier.tier--empty` == "this sprint container shows no card right
// now" — card-less at render time, filtered/searched down to zero, or emptied in place by a
// move/delete. `search-hidden` stays a CARD-level class from here on; this is the only place
// that toggles it on a `.tier`. `.tier--flat` (Sprints-off flat board) carries no
// data-priority and is deliberately excluded — it IS the drop target/empty state, never hidden.
// reveal: true also un-collapses a tier that has matches again — only the search/tag paths
// want that; a plain WS-patch resync must not un-collapse every all-done tier on the board.
export function syncEmptyTierVisibility({ reveal = false } = {}) {
  document.querySelectorAll('.tier[data-priority]').forEach(tier => {
    const cards = tier.querySelectorAll('.tier-cards > .card[data-id]:not(.search-hidden)');
    if (cards.length === 0) {
      tier.classList.add(HIDE_CLASS);
    } else {
      tier.classList.remove(HIDE_CLASS);
      if (reveal) tier.classList.remove('collapsed');
    }
  });
}

// ── Live-update the parent objective card's "Subtasks N/M" label (C1453) ──
// Called from task-card.js's applyTaskPatch() after every in-place child-card patch (local
// status write or an incoming WS task:updated) — the one choke point C1259 already routes
// every single-card mutation through. childrenCount/completedChildrenCount (C1435) are
// list-route-only fields baked into cards at render time; nothing else keeps the PARENT
// card's label in sync when a child's status crosses the closed-role boundary (complete OR
// canceled, C1187 — never a hardcoded status name) between renders.
//
// `hint.prevStatus`/`hint.parentDbId` must be read by the caller BEFORE it calls
// refreshCard(childTask) — that overwrites the child card's own data-status/data-parent-db-id,
// so this function is intentionally handed pre-patch snapshots rather than re-reading the DOM.
export function refreshParentSubtaskLabel(childTask, { prevStatus, parentDbId } = {}) {
  if (!parentDbId) return;
  const delta = closedDelta(prevStatus, childTask?.status);
  if (delta === 0) return;

  // (C1461) Parent detail pane on the subtask drill-down board — a plain DOM element, not a
  // task-list entry, so patched independently of the parent-CARD lookup below (which never
  // matches on a drill-down board: getChildren() never returns the parent row, so it's never
  // in state._lastVisibleTasks there). data-subtasks-total/-done are stamped by
  // renderParentTaskPane() at render time; a status-crossing delta only ever moves -done.
  const pane = document.querySelector(`.parent-task-pane[data-db-id="${CSS.escape(String(parentDbId))}"]`);
  if (pane && pane.dataset.subtasksTotal) {
    const total = Number(pane.dataset.subtasksTotal);
    const done = Math.max(0, Math.min(total, Number(pane.dataset.subtasksDone || 0) + delta));
    pane.dataset.subtasksDone = String(done);
    const span = pane.querySelector('.parent-task-pane-subtasks');
    if (span) span.textContent = buildSubtasksLabel({ childrenCount: total, completedChildrenCount: done });
  }

  // (C1453) The parent's own card, if mounted, is by definition an entry in the list the
  // last render iterated — same source applyTaskPatch()'s siblings (regroupCardToSprint(),
  // refreshFilterBarChrome()) already treat as the in-memory task list.
  const parent = (state._lastVisibleTasks || []).find(x => String(x.dbId) === String(parentDbId));
  if (!parent) return;

  const patch = applyChildStatusDelta(parent, delta);
  if (!patch) return; // childrenCount null (drill-down board) — bare label, nothing to move

  Object.assign(parent, patch);

  const parentCard = document.querySelector(`.card[data-db-id="${CSS.escape(String(parentDbId))}"]`);
  const btn = parentCard?.querySelector('.btn-subtasks-show');
  if (btn) {
    const label = buildSubtasksLabel(parent);
    btn.title = label;
    const span = btn.querySelector('span');
    if (span) span.textContent = label;
  }

  // The board snapshot cache (_boardTaskCache, template.html) holds its own cloned copy of
  // every fetched task — patching `parent` above doesn't reach it, so a later cache-hit
  // render (tab switch, filter toggle) would resurrect the stale count. Same bridge-event
  // pattern as tiptask:sync-nav-statuses/tiptask:reload, since that cache is template.html-
  // local and task-board.js has no import path to it.
  document.dispatchEvent(new CustomEvent('tiptask:task-cache-patch', {
    detail: { tasks: [{ id: parent.id, childrenCount: patch.childrenCount, completedChildrenCount: patch.completedChildrenCount }] },
  }));
}

// (TPT3) Applies the TPT2 server-side parent-follow cascade (`parent_rescheduled: [{task_key,
// from, to}, …]`, riding a PATCH response whenever a subtask's own priority write pulled an
// `is_objective` ancestor to a new sprint) — the upward counterpart to C1464's own downward
// cascade, which local sprint-move handlers already reload for. Without this, a moved parent
// only reappears in its new tier on the next 10s task-change poll.
//
// `entries` is exactly the array off the wire (or undefined/empty — always safe to call).
// Returns true when at least one ancestor actually moved in the DOM (or needs a reload to),
// so the caller can fold that into whatever forceFresh reload decision it's already making —
// a moved parent invalidates two `.tier-badge` counts, recomputed only by renderBoardContent()
// during a full loadAndRender().
export function applyParentSprintFollow(entries) {
  let touched = false;
  for (const entry of entries || []) {
    if (!entry || !entry.task_key) continue;
    const parent = (state._lastVisibleTasks || []).find(x => x.id === entry.task_key);
    if (parent) parent.priority = entry.to;
    const result = regroupCardToSprint(entry.task_key, entry.to, Number(entry.to) <= 0);
    if (regroupMovedCard(result) || regroupNeedsReload(result)) touched = true;
  }
  return touched;
}

// ── Status change confirmation modal ──
export function showConfirmModal(taskId, prevStatus, newStatus, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <p>${t('modal.changeStatus', { id: `<strong>${taskId}</strong>`, label: `<strong>${statusLabel(newStatus)}</strong>` })}</p>
      <div class="modal-buttons">
        <button class="btn-cancel">${t('btn.cancel')}</button>
        <button class="btn-confirm">${t('btn.confirm')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('.btn-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('.btn-confirm').addEventListener('click', async () => {
    overlay.remove();
    try {
      // (C1259) applyTaskPatch() (task-card.js) patches the card in place from the PATCH
      // response — a status-only change never moves tiers, so this always takes the
      // refreshCard() path. onDone (loadAndRender, a full board rebuild) is now only a
      // fallback for the 'reload' case (card no longer in the DOM — e.g. a concurrent WS
      // update filtered it out between click and this resolving), not the normal path.
      // The old delayRender/350ms setTimeout existed solely to let the tier-collapse
      // animation below play out before the (now-removed) unconditional full reload —
      // no longer needed since there's no reload to defer.
      const fresh = await api.tasks.update(taskId, { status: newStatus });
      const result = applyTaskPatch(fresh);
      if (isClosedName(newStatus)) {
        clearAttention(taskId, 'closed');
        const card = document.querySelector(`.card[data-id="${taskId}"]`);
        if (card) {
          card.classList.remove('needs-attention');
          const tier = card.closest('.tier');
          if (tier) {
            const p = Number(tier.dataset.priority);
            state.expandedTiers.delete(p);
            const siblings = tier.querySelectorAll('.card');
            const allSiblingsDone = [...siblings].every(c =>
              c === card || isClosedName(c.dataset.status)
            );
            if (allSiblingsDone && !tier.classList.contains('collapsed')) {
              state.collapsedTiers.add(p);
              tier.classList.add('collapsed');
            }
          }
        }
        updateClaudeButtons();
      }
      if (result === 'reload' && onDone) await onDone();
    } catch (err) {
      showToast(t('common.networkError', { msg: err.message }), 'error');
      if (onDone) await onDone();
    }
  });
}

// (TPT255) Shared spawn path for "create subtasks with AI" — Rehash → Split → AI and the
// objective card's own yellow Create Subtasks button both call this so they land on an
// identical tab: seeded composer, subtask banner, hidden <rehash-split> directive server-side.
// Seed is a short editable brief; full task body reaches the planner via taskKey, not the box.
export function spawnSplitObjectiveTab(taskKey, taskTitle) {
  const title = taskTitle || taskKey;
  // (C1162) window.TipTask indirection — chat-ui.js statically imports task-board.js, direct
  // import here would cycle.
  const tabId = window.TipTask?.chatUI?.spawnObjectiveTab?.(t('chat.splitSeed', { key: taskKey }), {
    title: taskKey, subtaskCtx: { taskKey, title }, taskKey, rehashIntent: 'split',
  });
  if (!tabId) return null; // MAX_TABS hit — toast already shown by spawnObjectiveTab
  pushSubtaskCrumb(state.subtaskStack, { taskKey, title }); // (C1440) dedup vs. rapid re-clicks
  return tabId;
}

// ── Split task modal ──
export function showSplitModal(taskKey, taskTitle, onLoadAndRender) {
  const overlay = document.createElement('div');
  overlay.className = 'split-modal-overlay';
  overlay.innerHTML = `
    <div class="split-modal">
      <h3>${t('modal.breakIntoSubtasks', { title: escapeAttr(taskTitle) })}</h3>
      <button class="split-option-btn btn-split-auto"><span class="split-option-icon">✨</span><span class="split-option-label">${t('modal.splitAuto')}</span></button>
      <button class="split-option-btn btn-split-manual"><span class="split-option-icon">+</span><span class="split-option-label">${t('modal.splitManual')}</span></button>
      <button class="btn-split-close" aria-label="${escapeAttr(t('btn.close'))}">&times;</button>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  };
  function escHandler(e) { if (e.key === 'Escape') close(); }

  overlay.querySelector('.btn-split-auto').addEventListener('click', () => {
    if (!spawnSplitObjectiveTab(taskKey, taskTitle)) return; // MAX_TABS hit — toast already shown, modal stays open
    close(); // spawnObjectiveTab() already triggered reload()
  });
  overlay.querySelector('.btn-split-manual').addEventListener('click', () => {
    pushSubtaskCrumb(state.subtaskStack, { taskKey, title: taskTitle }); // (C1440) dedup vs. rapid re-clicks
    close();
    state.activeTab = 'new_task';
    if (onLoadAndRender) onLoadAndRender();
  });
  overlay.querySelector('.btn-split-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', escHandler);
}

// ── Reiterate modal (picker: split / spec / trello) ──
export function showReiterateModal(taskKey, taskTitle, onLoadAndRender) {
  const overlay = document.createElement('div');
  overlay.className = 'reiterate-modal-overlay';
  overlay.innerHTML = `
    <div class="reiterate-modal">
      <h3>${t('modal.reiterateTitle', { title: escapeAttr(taskTitle) })}</h3>
      <button class="reiterate-option-btn btn-reiterate-split"><span class="reiterate-option-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="4" cy="11" r="2"/><circle cx="4" cy="5" r="2"/><line x1="5.5" y1="6" x2="14" y2="14"/><line x1="5.5" y1="10" x2="14" y2="2"/></svg></span><span class="reiterate-option-label">${t('modal.reiterateSplit')}</span></button>
      <button class="reiterate-option-btn btn-reiterate-spec"><span class="reiterate-option-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M3 3.5h10a1.5 1.5 0 0 1 1.5 1.5v4.5A1.5 1.5 0 0 1 13 11H7l-3.5 2v-2H3A1.5 1.5 0 0 1 1.5 9.5V5A1.5 1.5 0 0 1 3 3.5z"/></svg></span><span class="reiterate-option-label">${t('modal.reiterateSpec')}</span></button>
      <button class="reiterate-option-btn btn-reiterate-trello"><span class="reiterate-option-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16"><rect x="2" y="2" width="12" height="12" rx="1.5"/><rect x="4" y="4" width="3" height="7" rx="0.5" fill="currentColor" stroke="none"/><rect x="9" y="4" width="3" height="4" rx="0.5" fill="currentColor" stroke="none"/></svg></span><span class="reiterate-option-label">${t('modal.reiterateTrello')}</span></button>
      <button class="btn-reiterate-close" aria-label="${escapeAttr(t('btn.close'))}">&times;</button>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  };
  function escHandler(e) { if (e.key === 'Escape') close(); }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.btn-reiterate-close').addEventListener('click', close);
  overlay.querySelector('.btn-reiterate-split').addEventListener('click', () => {
    close();
    showSplitModal(taskKey, taskTitle, onLoadAndRender);
  });
  overlay.querySelector('.btn-reiterate-spec').addEventListener('click', () => {
    // (TPT179) Own tab per task, keyed to taskKey. The composer stays empty: the pinned task card
    // and the refine-this-task directive both come from rehashIntent:'discuss' + taskKey (the
    // server resolves the task and appends the directive to the system prompt only) — nothing is
    // seeded into the visible textarea, so there is no instruction text for the user to see/edit.
    const tabId = window.TipTask?.chatUI?.spawnObjectiveTab?.('', {
      title: taskKey, taskKey, rehashIntent: 'discuss',
    });
    if (!tabId) return; // MAX_TABS hit — toast already shown, modal stays open
    close(); // spawnObjectiveTab() already triggered reload()
  });
  overlay.querySelector('.btn-reiterate-trello').addEventListener('click', () => {
    close();
    showTrelloImportModal(taskKey, onLoadAndRender);
  });
  document.addEventListener('keydown', escHandler);
}

const TRELLO_INLINE_IMAGE_RE = /https:\/\/(?:api\.)?trello\.com\/1\/cards\/[^\s)<>"']*?\/download\/[^\s)<>"']+/g;

function trelloImageProxyUrl(url) {
  return `/api/trello/image-proxy?url=${encodeURIComponent(url)}`;
}

function rewriteTrelloInlineImages(text) {
  return String(text || '').replace(TRELLO_INLINE_IMAGE_RE, url => trelloImageProxyUrl(url));
}

function renderTrelloAttachmentImages(attachments) {
  const images = (attachments || []).filter(att => att?.url);
  if (!images.length) return '';
  return `
    <div class="trello-import-attachments">
      ${images.map(att => `
        <figure class="trello-import-attachment">
          <img class="trello-import-attachment-img" src="${escapeAttr(trelloImageProxyUrl(att.url))}" alt="${escapeAttr(att.name || 'Trello attachment')}" loading="lazy">
          ${att.name ? `<figcaption>${escapeAttr(att.name)}</figcaption>` : ''}
        </figure>
      `).join('')}
    </div>`;
}

// ── Trello card import modal ──
export async function showTrelloImportModal(taskKey, onLoadAndRender) {
  const overlay = document.createElement('div');
  overlay.className = 'trello-import-modal-overlay';
  overlay.innerHTML = `
    <div class="trello-import-modal">
      <button class="btn-trello-import-close" aria-label="${escapeAttr(t('btn.close'))}">&times;</button>
      <h3>${t('modal.trelloImportTitle')}</h3>
      <p class="trello-import-hint">${t('trello.pasteHint')}</p>
      <div class="trello-import-row">
        <input class="trello-card-url-input" placeholder="https://trello.com/c/abc123/..." autocomplete="off">
        <button class="btn-trello-fetch">${t('btn.fetch')}</button>
      </div>
      <p class="trello-import-error" hidden></p>
      <div class="trello-import-preview" hidden></div>
      <div class="trello-import-actions" hidden>
        <button class="btn-trello-cancel">${t('btn.cancel')}</button>
        <button class="btn-trello-confirm">${t('trello.importIntoDesc')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let fetchedCard = null;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  };
  function escHandler(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.btn-trello-import-close').addEventListener('click', close);
  overlay.querySelector('.btn-trello-cancel').addEventListener('click', close);
  document.addEventListener('keydown', escHandler);

  const input = overlay.querySelector('.trello-card-url-input');
  const fetchBtn = overlay.querySelector('.btn-trello-fetch');
  const errorEl = overlay.querySelector('.trello-import-error');
  const previewEl = overlay.querySelector('.trello-import-preview');
  const actionsEl = overlay.querySelector('.trello-import-actions');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() { errorEl.hidden = true; }

  function buildChecklistMarkdown(checklists) {
    if (!checklists || !checklists.length) return '';
    return checklists.map(cl => {
      const items = (cl.checkItems || []).map(ci => {
        const checked = ci.state === 'complete' ? 'x' : ' ';
        return `- [${checked}] ${ci.name}`;
      }).join('\n');
      return `**${cl.name}**\n${items}`;
    }).join('\n\n');
  }

  fetchBtn.addEventListener('click', async () => {
    clearError();
    const raw = input.value.trim();
    if (!raw) { showError(t('trello.errNoInput')); return; }
    const match = raw.match(/trello\.com\/c\/([^/?#]+)/);
    const cardId = match ? match[1] : raw;
    if (!cardId) { showError(t('trello.errNoCardId')); return; }

    fetchBtn.disabled = true;
    fetchBtn.textContent = t('trello.fetching');
    previewEl.hidden = true;
    actionsEl.hidden = true;

    try {
      const resp = await fetch(`/api/trello/cards/${encodeURIComponent(cardId)}`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        // C1551 — this modal's showError() is a plain textContent banner (no list markup
        // support like openTrelloWizard's renderNotConfigured), so compose one line naming
        // the missing vars rather than leaving them unmentioned or printing the raw token.
        const nc = integrationNotConfigured(data);
        showError(nc
          ? t('integration.notConfiguredTitle', { service: 'Trello' }) + ' ' + nc.missing.join(', ')
          : (data.error === 'card_not_found' ? t('trello.errCardNotFound') : t('trello.errFetchFailed')));
        return;
      }
      fetchedCard = data;
      const checklistMd = buildChecklistMarkdown(data.checklists);
      const desc = rewriteTrelloInlineImages(data.desc || '');
      const previewMd = `### ${data.name}\n\n${desc || t('trello.noDescription')}${checklistMd ? '\n\n' + checklistMd : ''}`;
      previewEl.innerHTML = renderMarkdown(previewMd) + renderTrelloAttachmentImages(data.attachments);
      previewEl.hidden = false;
      actionsEl.hidden = false;
    } catch (err) {
      showError(t('common.networkError', { msg: err.message }));
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = t('btn.fetch');
    }
  });

  overlay.querySelector('.btn-trello-confirm').addEventListener('click', async () => {
    if (!fetchedCard) return;
    const confirmBtn = overlay.querySelector('.btn-trello-confirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = t('trello.importing');

    try {
      console.log('[client] trello apply-to-task — window project=%s', await window.electronAPI?.getCurrentProject?.());
      const resp = await fetch(
        `/api/trello/cards/${encodeURIComponent(fetchedCard.id)}/apply-to-task`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskKey }),
        }
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const nc = integrationNotConfigured(data);
        showError(nc
          ? t('integration.notConfiguredTitle', { service: 'Trello' }) + ' ' + nc.missing.join(', ')
          : t('trello.errImportFailed'));
        confirmBtn.disabled = false;
        confirmBtn.textContent = t('trello.importIntoDesc');
        return;
      }
      close();
      if (onLoadAndRender) onLoadAndRender();
    } catch (err) {
      showError(t('common.error', { msg: err.message }));
      confirmBtn.disabled = false;
      confirmBtn.textContent = t('trello.importIntoDesc');
    }
  });
}

// C1551 — pure detector for the API's `<integration>_not_configured` 503 body (see
// api/src/lib/integration-config.js and its web-SPA twin, lib/import-picker-shell.js's
// notConfiguredFrom()). Takes the already-parsed JSON body, not a fetch Response/err — every
// call site here already has `data` on hand from its own `await r.json()`. Exported so it's
// directly unit-testable without spinning up either wizard.
export function integrationNotConfigured(data) {
  const code = data && typeof data.error === 'string' ? data.error : '';
  if (!/^[a-z]+_not_configured$/.test(code)) return null;
  if (!Array.isArray(data.missing) || !data.missing.length) return null;
  return { service: data.service || code.replace(/_not_configured$/, ''), missing: data.missing, docs: data.docs || '' };
}

// Whole-body notice markup naming exactly which env vars are missing — shared by both
// wizards below instead of duplicating the escaping/markup once per integration.
// serviceLabel is the CALLER's own display label ('Gmail'/'Trello'), never nc.service —
// same "don't let a server string decide display text" rule the web SPA's setupNoticeHtml
// follows (lib/import-picker-shell.js).
function buildNotConfiguredHtml(serviceLabel, nc) {
  const vars = nc.missing.map(v => `<li><code>${escapeAttr(v)}</code></li>`).join('');
  const footer = nc.docs
    ? `<p style="margin:0;font-size:.85rem;color:var(--c-text-secondary)">${t('integration.notConfiguredFooter', { doc: escapeAttr(nc.docs) })}</p>`
    : '';
  return `
    <button class="btn-trello-import-close trello-wizard-close" aria-label="${escapeAttr(t('btn.close'))}">&times;</button>
    <h3>${t('integration.notConfiguredTitle', { service: escapeAttr(serviceLabel) })}</h3>
    <p style="margin:0 0 8px;font-size:0.9rem;color:var(--c-text-secondary)">${t('integration.notConfiguredHint')}</p>
    <ul style="margin:0 0 12px;padding-left:20px">${vars}</ul>
    ${footer}
    <div class="trello-import-actions"><button class="btn-trello-cancel">${t('btn.close')}</button></div>`;
}

// ── Trello import wizard (multi-step: board select → card pick → preview → create) ──
export async function openTrelloWizard(onLoadAndRender) {
  const overlay = document.createElement('div');
  overlay.className = 'trello-wizard-overlay';
  overlay.innerHTML = `<div class="trello-wizard-modal"><div class="trello-wizard-body"></div></div>`;
  document.body.appendChild(overlay);

  const modal = overlay.querySelector('.trello-wizard-modal');
  const body = overlay.querySelector('.trello-wizard-body');

  let activeBoardId = null;
  let selectedCard = null;
  let selectedCardDetail = null;
  let allCards = [];

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  };
  function escHandler(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', escHandler);

  function buildChecklistMd(checklists) {
    if (!checklists || !checklists.length) return '';
    return checklists.map(cl => {
      const items = (cl.checkItems || []).map(ci =>
        `- [${ci.state === 'complete' ? 'x' : ' '}] ${ci.name}`
      ).join('\n');
      return `**${cl.name}**\n${items}`;
    }).join('\n\n');
  }

  function showError(msg) {
    let el = modal.querySelector('.trello-wizard-error');
    if (!el) {
      el = document.createElement('p');
      el.className = 'trello-wizard-error';
      modal.appendChild(el);
    }
    el.textContent = msg;
    el.hidden = false;
  }
  function clearError() {
    const el = modal.querySelector('.trello-wizard-error');
    if (el) el.hidden = true;
  }

  // C1551 — see openGmailWizard's identical helper for the rationale (whole-body swap,
  // nothing useful survives underneath a server-side config fault).
  function renderNotConfigured(nc) {
    body.innerHTML = buildNotConfiguredHtml('Trello', nc);
    body.querySelector('.trello-wizard-close').addEventListener('click', close);
    body.querySelector('.btn-trello-cancel').addEventListener('click', close);
  }

  // ── Step 2: board select ──
  async function showStep2() {
    clearError();
    body.innerHTML = `
      <button class="btn-trello-import-close trello-wizard-close" aria-label="${escapeAttr(t('btn.close'))}">&times;</button>
      <h3>${t('trello.selectBoard')}</h3>
      <div class="trello-wizard-field">
        <label class="trello-wizard-label">${t('trello.workspace')}</label>
        <select class="trello-wizard-select" id="tw-workspace-select"><option value="">${t('common.loading')}</option></select>
      </div>
      <div class="trello-wizard-field">
        <label class="trello-wizard-label">${t('trello.board')}</label>
        <select class="trello-wizard-select" id="tw-board-select" disabled><option value="">${t('trello.selectWorkspaceFirst')}</option></select>
      </div>
      <div class="trello-import-actions">
        <button class="btn-trello-cancel">${t('btn.cancel')}</button>
        <button class="btn-trello-confirm" id="tw-board-confirm" disabled>${t('btn.continue')}</button>
      </div>`;
    body.querySelector('.trello-wizard-close').addEventListener('click', close);
    body.querySelector('.btn-trello-cancel').addEventListener('click', close);

    const wsSelect = body.querySelector('#tw-workspace-select');
    const boardSelect = body.querySelector('#tw-board-select');
    const confirmBtn = body.querySelector('#tw-board-confirm');

    // Load workspaces
    try {
      const r = await fetch('/api/trello/workspaces');
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const nc = integrationNotConfigured(data);
        if (nc) { renderNotConfigured(nc); return; }
        showError(t('trello.errLoadWorkspaces'));
        return;
      }
      wsSelect.innerHTML = `<option value="">${t('trello.selectWorkspacePlaceholder')}</option>` +
        data.map(w => `<option value="${escapeAttr(w.id)}">${escapeAttr(w.name)}</option>`).join('');
    } catch (err) {
      showError(t('common.networkError', { msg: err.message }));
      return;
    }

    wsSelect.addEventListener('change', async () => {
      const wsId = wsSelect.value;
      boardSelect.disabled = true;
      boardSelect.innerHTML = `<option value="">${t('common.loading')}</option>`;
      confirmBtn.disabled = true;
      if (!wsId) { boardSelect.innerHTML = `<option value="">${t('trello.selectWorkspaceFirst')}</option>`; return; }
      try {
        const r = await fetch(`/api/trello/boards?workspaceId=${encodeURIComponent(wsId)}`);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const nc = integrationNotConfigured(data);
          if (nc) { renderNotConfigured(nc); return; }
          showError(t('trello.errLoadBoards'));
          return;
        }
        boardSelect.innerHTML = `<option value="">${t('trello.selectBoardPlaceholder')}</option>` +
          data.map(b => `<option value="${escapeAttr(b.id)}" data-name="${escapeAttr(b.name)}">${escapeAttr(b.name)}</option>`).join('');
        boardSelect.disabled = false;
      } catch (err) {
        showError(t('common.networkError', { msg: err.message }));
      }
    });

    boardSelect.addEventListener('change', () => {
      confirmBtn.disabled = !boardSelect.value;
    });

    confirmBtn.addEventListener('click', async () => {
      clearError();
      const wsId = wsSelect.value;
      const boardId = boardSelect.value;
      const boardName = boardSelect.selectedOptions[0]?.dataset.name || '';
      if (!wsId || !boardId) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = t('common.saving');
      try {
        const r = await fetch('/api/trello/board-association', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trello_workspace_id: wsId, trello_board_id: boardId, trello_board_name: boardName }),
        });
        const data = await r.json();
        if (!r.ok) { showError(data.error || t('trello.errSaveBoard')); confirmBtn.disabled = false; confirmBtn.textContent = t('btn.continue'); return; }
        activeBoardId = boardId;
        showStep3();
      } catch (err) {
        showError(t('common.networkError', { msg: err.message }));
        confirmBtn.disabled = false;
        confirmBtn.textContent = t('btn.continue');
      }
    });
  }

  // ── Step 3: card list + search + preview + create ──
  async function showStep3() {
    clearError();
    body.innerHTML = `
      <button class="btn-trello-import-close trello-wizard-close" aria-label="${escapeAttr(t('btn.close'))}">&times;</button>
      <h3>${t('modal.trelloImportTitle')}</h3>
      <input class="trello-wizard-search" placeholder="${escapeAttr(t('trello.searchCardsPlaceholder'))}" autocomplete="off">
      <div class="trello-wizard-card-list" id="tw-card-list"><div class="trello-wizard-loading">${t('trello.loadingCards')}</div></div>
      <div class="trello-import-preview trello-wizard-preview" id="tw-preview" hidden></div>
      <div class="trello-import-actions" id="tw-actions" hidden>
        <button class="btn-trello-cancel">${t('btn.cancel')}</button>
        <button class="btn-trello-confirm" id="tw-use-objective-btn">${t('btn.useAsObjective')}</button>
      </div>`;
    body.querySelector('.trello-wizard-close').addEventListener('click', close);
    body.querySelector('.btn-trello-cancel').addEventListener('click', close);

    const searchInput = body.querySelector('.trello-wizard-search');
    const cardList = body.querySelector('#tw-card-list');
    const previewEl = body.querySelector('#tw-preview');
    const actionsEl = body.querySelector('#tw-actions');
    const importBtn = body.querySelector('#tw-use-objective-btn');

    // Load cards
    try {
      const r = await fetch(`/api/trello/cards-list?boardId=${encodeURIComponent(activeBoardId)}`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const nc = integrationNotConfigured(data);
        if (nc) { renderNotConfigured(nc); return; }
        cardList.innerHTML = `<p class="trello-wizard-error-inline">${t('trello.errLoadCards')}</p>`;
        return;
      }
      allCards = data;
      renderCardList(allCards);
    } catch (err) {
      cardList.innerHTML = `<p class="trello-wizard-error-inline">${t('common.networkError', { msg: err.message })}</p>`;
      return;
    }

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      const filtered = q ? allCards.filter(c => c.name.toLowerCase().includes(q)) : allCards;
      renderCardList(filtered);
    });

    function renderCardList(cards) {
      if (!cards.length) {
        cardList.innerHTML = `<p class="trello-wizard-empty">${t('trello.noCards')}</p>`;
        return;
      }
      cardList.innerHTML = cards.map(c =>
        `<div class="trello-wizard-card-item" data-id="${escapeAttr(c.id)}"><span class="trello-card-name">${escapeAttr(c.name)}</span>${c.listName ? `<span class="trello-card-list-badge">${escapeAttr(c.listName)}</span>` : ''}<span class="trello-card-status-badge ${c.dueComplete ? 'done' : 'open'}">${c.dueComplete ? t('common.done') : t('common.open')}</span></div>`
      ).join('');
      cardList.querySelectorAll('.trello-wizard-card-item').forEach(el => {
        el.addEventListener('click', () => selectCard(el, cards.find(c => c.id === el.dataset.id)));
      });
    }

    async function selectCard(el, card) {
      clearError();
      cardList.querySelectorAll('.trello-wizard-card-item').forEach(i => i.classList.remove('selected'));
      el.classList.add('selected');
      selectedCard = card;
      selectedCardDetail = null;
      previewEl.hidden = true;
      actionsEl.hidden = true;
      importBtn.disabled = true;

      try {
        const r = await fetch(`/api/trello/cards/${encodeURIComponent(card.id)}`);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const nc = integrationNotConfigured(data);
          if (nc) { renderNotConfigured(nc); return; }
          showError(data.error === 'card_not_found' ? t('trello.errCardNotFoundShort') : t('trello.errFetchCard'));
          return;
        }
        const checklistMd = buildChecklistMd(data.checklists);
        const desc = rewriteTrelloInlineImages(data.desc || '');
        const previewMd = `### ${data.name}\n\n${desc || t('trello.noDescription')}${checklistMd ? '\n\n' + checklistMd : ''}`;
        previewEl.innerHTML = renderMarkdown(previewMd) + renderTrelloAttachmentImages(data.attachments);
        // Capture detail-fetch data (with proxied image URLs) for prompt building
        selectedCardDetail = { name: data.name, desc, checklists: data.checklists, attachments: data.attachments };
        previewEl.hidden = false;
        actionsEl.hidden = false;
        importBtn.disabled = false;
      } catch (err) {
        showError(t('common.networkError', { msg: err.message }));
      }
    }

    importBtn.addEventListener('click', async () => {
      if (!selectedCard) return;
      const detail = selectedCardDetail;
      const title = (detail ? detail.name : null) || selectedCard.name || '';
      const body_ = detail ? detail.desc : rewriteTrelloInlineImages(selectedCard.desc || '');
      const checklistMd = detail ? buildChecklistMd(detail.checklists) : '';

      // Upload card image attachments as real project images (paste-identical behavior).
      // Falls back to Trello proxy URLs if the endpoint fails or user is not connected.
      let uploadedImages = [];
      try {
        const imgResp = await fetch(`/api/trello/cards/${encodeURIComponent(selectedCard.id)}/images`);
        if (imgResp.ok) {
          const imgData = await imgResp.json();
          uploadedImages = Array.isArray(imgData.images) ? imgData.images : [];
        }
      } catch (err) {
        console.warn('[trello] card images fetch failed:', err.message);
      }

      // Build attachment markdown — prefer uploaded project images, fallback to proxy URLs
      let attMd;
      if (uploadedImages.length > 0) {
        attMd = uploadedImages.map(img => `![${img.name || 'attachment'}](${img.url})`).join('\n');
      } else {
        attMd = (detail?.attachments || [])
          .filter(att => att?.url)
          .map(att => `![${att.name || 'attachment'}](${trelloImageProxyUrl(att.url)})`)
          .join('\n');
      }

      const parts = [`### ${title}`];
      if (body_) parts.push(body_);
      if (checklistMd) parts.push(checklistMd);
      if (attMd) parts.push(attMd);
      const prompt = parts.join('\n\n');

      // (C1162) Own tab per import, keyed to card title — not the focused tab.
      if (!window.TipTask?.chatUI?.spawnObjectiveTab?.(prompt, { title })) return; // MAX_TABS hit, wizard stays open
      close();
      // Populate the textarea after render (same as recipe-sidebar.js:106-113)
      const ta = document.getElementById('chat-input');
      if (ta) {
        ta.value = prompt;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.5) + 'px';
        saveDraft(getObjectiveDraftKey(), { text: prompt, height: ta.style.height });
        ta.focus();
      }
      // Emit preview events so chat-ui's thumbnail strip populates (same as paste path)
      for (const img of uploadedImages) {
        document.dispatchEvent(new CustomEvent('tiptask:obj-image-preview', {
          detail: { name: img.name || 'attachment', url: img.url },
        }));
      }
      showToast(t('toast.loadedIntoObjective'));
    });
  }

  // ── Step 1: check saved board association ──
  body.innerHTML = `<div class="trello-wizard-loading">${t('trello.checkingAssociation')}</div>`;
  try {
    const r = await fetch('/api/trello/board-association');
    const data = await r.json();
    if (r.ok && data.association?.trello_board_id) {
      activeBoardId = data.association.trello_board_id;
      showStep3();
    } else {
      showStep2();
    }
  } catch {
    showStep2();
  }
}

// ── Gmail thread picker wizard (mirrors openTrelloWizard) ──
export async function openGmailWizard(onLoadAndRender) {
  const overlay = document.createElement('div');
  overlay.className = 'gmail-wizard-overlay';
  overlay.innerHTML = `<div class="gmail-wizard-modal"><div class="gmail-wizard-body"></div></div>`;
  document.body.appendChild(overlay);

  const modal = overlay.querySelector('.gmail-wizard-modal');
  const body = overlay.querySelector('.gmail-wizard-body');

  let selectedThread = null;
  let selectedThreadDetail = null;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  };
  function escHandler(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', escHandler);

  function showError(msg) {
    let el = modal.querySelector('.gmail-wizard-error');
    if (!el) {
      el = document.createElement('p');
      el.className = 'gmail-wizard-error';
      modal.appendChild(el);
    }
    el.textContent = msg;
    el.hidden = false;
  }
  function clearError() {
    const el = modal.querySelector('.gmail-wizard-error');
    if (el) el.hidden = true;
  }

  // C1551 — full-body notice (never showError()'s textContent-only banner, which can't
  // render a list) naming exactly which GMAIL_* env vars the API is missing. Whole-body
  // swap because there is nothing useful to keep underneath: the server, not the user's
  // connection, is what's unconfigured.
  function renderNotConfigured(nc) {
    body.innerHTML = buildNotConfiguredHtml('Gmail', nc);
    body.querySelector('.trello-wizard-close').addEventListener('click', close);
    body.querySelector('.btn-trello-cancel').addEventListener('click', close);
  }

  // ── Step 1: show search ──
  async function showSearchStep() {
    clearError();
    body.innerHTML = `
      <button class="btn-trello-import-close trello-wizard-close" aria-label="${escapeAttr(t('btn.close'))}">&times;</button>
      <h3>${t('gmail.importTitle')}</h3>
      <input class="gmail-wizard-search" placeholder="${escapeAttr(t('gmail.searchPlaceholder'))}" autocomplete="off">
      <div class="gmail-wizard-thread-list" id="gw-thread-list"><div class="gmail-wizard-loading">${t('gmail.loadingThreads')}</div></div>
      <div class="trello-import-preview gmail-wizard-preview" id="gw-preview" hidden></div>
      <div class="trello-import-actions" id="gw-actions" hidden>
        <button class="btn-trello-cancel">${t('btn.cancel')}</button>
        <button class="btn-trello-confirm" id="gw-use-objective-btn">${t('btn.useAsObjective')}</button>
      </div>`;
    body.querySelector('.trello-wizard-close').addEventListener('click', close);
    body.querySelector('.btn-trello-cancel').addEventListener('click', close);

    const searchInput = body.querySelector('.gmail-wizard-search');
    const threadList = body.querySelector('#gw-thread-list');
    const previewEl = body.querySelector('#gw-preview');
    const actionsEl = body.querySelector('#gw-actions');
    const useBtn = body.querySelector('#gw-use-objective-btn');

    // Stale-response guard
    let latestSeq = 0;

    async function fetchThreads(q) {
      const seq = ++latestSeq;
      try {
        const url = '/api/gmail/threads' + (q ? '?q=' + encodeURIComponent(q) : '');
        const r = await fetch(url);
        if (seq !== latestSeq) return; // superseded
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const nc = integrationNotConfigured(data);
          if (nc) { renderNotConfigured(nc); return; }
          if (data.error === 'not_connected') {
            threadList.innerHTML = `<p class="gmail-wizard-empty">${t('gmail.notConnected')}</p>`;
          } else {
            threadList.innerHTML = `<p class="gmail-wizard-error" style="margin:8px 12px">${escapeAttr(t('gmail.errLoadThreads'))}</p>`;
          }
          return;
        }
        renderThreadList(data);
      } catch (err) {
        if (seq !== latestSeq) return;
        threadList.innerHTML = `<p class="gmail-wizard-error" style="margin:8px 12px">${t('common.networkError', { msg: escapeAttr(err.message) })}</p>`;
      }
    }

    // Load recent threads on open
    fetchThreads('');

    let debounceTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fetchThreads(searchInput.value.trim()), 300);
    });

    function renderThreadList(threads) {
      if (!threads.length) {
        threadList.innerHTML = `<p class="gmail-wizard-empty">${t('gmail.noThreads')}</p>`;
        return;
      }
      threadList.innerHTML = threads.map(th =>
        `<div class="gmail-wizard-thread-item" data-id="${escapeAttr(th.id)}">
          <div class="gmail-wizard-thread-subject">${escapeAttr(th.subject || t('gmail.noSubject'))}</div>
          <div class="gmail-wizard-thread-meta">${escapeAttr(th.from || '')}${th.date ? ' · ' + escapeAttr(th.date) : ''}</div>
          ${th.snippet ? `<div class="gmail-wizard-thread-snippet">${escapeAttr(th.snippet)}</div>` : ''}
        </div>`
      ).join('');
      threadList.querySelectorAll('.gmail-wizard-thread-item').forEach(el => {
        el.addEventListener('click', () => selectThread(el, threads.find(th => th.id === el.dataset.id)));
      });
    }

    async function selectThread(el, thread) {
      clearError();
      threadList.querySelectorAll('.gmail-wizard-thread-item').forEach(i => i.classList.remove('selected'));
      el.classList.add('selected');
      selectedThread = thread;
      selectedThreadDetail = null;
      previewEl.hidden = true;
      actionsEl.hidden = true;
      useBtn.disabled = true;

      try {
        const r = await fetch(`/api/gmail/threads/${encodeURIComponent(thread.id)}`);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const nc = integrationNotConfigured(data);
          if (nc) { renderNotConfigured(nc); return; }
          showError(data.error === 'thread_not_found' ? t('gmail.errThreadNotFound') : t('gmail.errFetchThread'));
          return;
        }
        selectedThreadDetail = data;

        // Build preview markdown
        const msgsMd = (data.messages || []).map(m =>
          `**${t('gmail.from')}:** ${m.from || ''}${m.date ? ' · ' + m.date : ''}\n\n${m.body || ''}`
        ).join('\n\n---\n\n');
        const previewMd = `### ${data.subject || t('gmail.noSubject')}\n\n${msgsMd}`;
        previewEl.innerHTML = renderMarkdown(previewMd);
        previewEl.hidden = false;
        actionsEl.hidden = false;
        useBtn.disabled = false;
      } catch (err) {
        showError(t('common.networkError', { msg: err.message }));
      }
    }

    useBtn.addEventListener('click', () => {
      if (!selectedThread) return;
      const detail = selectedThreadDetail;
      const subject = (detail?.subject) || selectedThread.subject || t('gmail.noSubject');
      const msgsMd = detail
        ? (detail.messages || []).map(m =>
            `**${t('gmail.from')}:** ${m.from || ''}${m.date ? ' · ' + m.date : ''}\n\n${m.body || ''}`
          ).join('\n\n---\n\n')
        : '';
      const parts = [`### ${subject}`];
      if (msgsMd) parts.push(msgsMd);
      const prompt = parts.join('\n\n');

      // (C1162) Own tab per import, keyed to thread subject — not the focused tab.
      if (!window.TipTask?.chatUI?.spawnObjectiveTab?.(prompt, { title: subject })) return; // MAX_TABS hit, wizard stays open
      close();
      const ta = document.getElementById('chat-input');
      if (ta) {
        ta.value = prompt;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.5) + 'px';
        saveDraft(getObjectiveDraftKey(), { text: prompt, height: ta.style.height });
        ta.focus();
      }
      showToast(t('toast.loadedIntoObjective'));
    });
  }

  // ── Entry: check Gmail connection ──
  body.innerHTML = `<div class="gmail-wizard-loading">${t('gmail.checkingConnection')}</div>`;
  try {
    const r = await fetch('/api/gmail/status');
    const data = await r.json().catch(() => ({}));
    const nc = integrationNotConfigured(data);
    if (nc) {
      // C1551 — must be checked BEFORE `r.ok && data.connected` below: a 503 makes r.ok
      // false, so without this branch the wizard fell straight into "Connect Gmail",
      // blaming the user for a server-side misconfiguration.
      renderNotConfigured(nc);
    } else if (r.ok && data.connected) {
      showSearchStep();
    } else {
      // Not connected — show connect prompt
      body.innerHTML = `
        <button class="btn-trello-import-close trello-wizard-close" aria-label="${escapeAttr(t('btn.close'))}">&times;</button>
        <h3>${t('gmail.connectTitle')}</h3>
        <p style="font-size:0.9rem;color:var(--c-text-secondary);margin:0">${t('gmail.connectHint')}</p>
        <div class="trello-import-actions">
          <button class="btn-trello-cancel">${t('btn.cancel')}</button>
          <button class="btn-trello-confirm" id="gw-connect-btn">${t('gmail.connectTitle')}</button>
        </div>`;
      body.querySelector('.trello-wizard-close').addEventListener('click', close);
      body.querySelector('.btn-trello-cancel').addEventListener('click', close);
      body.querySelector('#gw-connect-btn').addEventListener('click', () => {
        // C1551 — must check res.ok/parse the body before deciding what happened: the
        // pre-existing code only checked `d.url` truthiness, so a 503 body (no `.url`,
        // but valid JSON) silently did nothing at all — a dead button with zero feedback.
        fetch('/api/gmail/auth/initiate')
          .then(async (res) => {
            const d = await res.json().catch(() => ({}));
            const nc2 = integrationNotConfigured(d);
            if (nc2) { renderNotConfigured(nc2); return; }
            if (res.ok && d.url) window.open(d.url, '_blank');
            else showError(t('gmail.errInitiate'));
          })
          .catch(() => showError(t('gmail.errInitiate')));
      });
    }
  } catch (err) {
    body.innerHTML = `
      <button class="btn-trello-import-close trello-wizard-close" aria-label="${escapeAttr(t('btn.close'))}">&times;</button>
      <p class="gmail-wizard-error" style="margin:0">${t('gmail.errCheckStatus', { msg: escapeAttr(err.message) })}</p>
      <div class="trello-import-actions"><button class="btn-trello-cancel">${t('btn.close')}</button></div>`;
    body.querySelector('.trello-wizard-close').addEventListener('click', close);
    body.querySelector('.btn-trello-cancel').addEventListener('click', close);
  }
}

// ── Delete confirmation modal ──
export function showDeleteConfirmModal(taskId, taskTitle, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-task-message">
      <p id="delete-task-message">${t('modal.deleteTask', { id: `<strong>${escapeAttr(taskId)}</strong>`, title: escapeAttr(taskTitle) })}</p>
      <div class="modal-buttons">
        <button class="btn-cancel">${t('btn.cancel')}</button>
        <button class="btn-confirm btn-confirm--danger">${t('btn.delete')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const focusHandle = activateDialogFocus({ root: overlay, initialFocus: '.btn-cancel' });
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    focusHandle.close();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);

  overlay.querySelector('.btn-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  overlay.querySelector('.btn-confirm').addEventListener('click', async () => {
    close();
    try {
      await api.tasks.delete(taskId);
      // (C1259) removeCardFromDom() (task-card.js) — the same patch the board WS's own
      // task:deleted handler already applies for a delete from ANOTHER window/client.
      // `onDone` still runs unconditionally after: some callers (the Task Edit Modal's
      // delete action) need it for their own side effects (closing the modal) regardless
      // of whether the DOM patch found a card to remove; the board-click caller
      // (template.html) now passes a lightweight selection-cleanup callback instead of a
      // full loadAndRender().
      removeCardFromDom(taskId);
    } catch (err) {
      showToast(t('common.networkError', { msg: err.message }), 'error');
    }
    if (onDone) await onDone();
  });
}

// ── SVG icons for compact completed-card buttons ──
const PLAY_ICON = '<svg width="12" height="12" viewBox="0 0 12 12"><polygon points="2,0 12,6 2,12" fill="currentColor"/></svg>';
const STOP_ICON = '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="1" fill="currentColor"/></svg>';
// (TPT374) Same arc-spinner recipe as the left-nav "+ Create" loading ring (styles.css
// .left-nav-btn--primary.loading .left-nav-icon::after) — reused here via .session-spinner so
// an in-progress task with a live agent process reads as busy, not actionable.
const SESSION_SPINNER_HTML = '<span class="session-spinner" aria-hidden="true"></span>';

// (C1463) Purge local session bookkeeping for a task whose session already ended
// server-side — extracted out of terminateSessionFromCard()'s .finally so the objective-tab
// bulk close path (template.html) can reuse it per terminated child without dragging in
// updateClaudeButtons() per-call (caller batches that once after the whole loop instead).
export function forgetLocalSession(taskId) {
  state.activeSessions.delete(taskId);
  state.exitedSessions.delete(taskId);
  clearAttention(taskId, 'session-ended');
  state.sessionMeta.delete(taskId); // (C1144)
}

// ── Terminate a session directly from the card (no terminal modal) ──
export function terminateSessionFromCard(taskId) {
  const card = document.querySelector(`.card[data-id="${CSS.escape(taskId)}"]`);
  if (card) card.classList.remove('needs-attention');
  clearAttention(taskId, 'session-ended');
  return terminateTaskSession(taskId, { timeoutMs: 5000 }).finally(() => {
    forgetLocalSession(taskId);
    updateClaudeButtons();
  });
}

// ── Update Claude button labels for active sessions ──
export function updateClaudeButtons() {
  // (C1306) Session/attention events can repaint this module after a card was patched in
  // place but before a full loadAndRender() rebuilds taskStatusById. The left-nav rows read
  // that map, while the buttons below read the mounted card's newer data-status. Reconcile
  // the two sources first so a completed session gets its done styling without requiring the
  // user to open the task (which incidentally forced a full board refresh).
  // (C1329) Never let this downgrade a server-confirmed completion: a mounted card can be
  // stale (rendered from a cache-hit snapshot, or ahead of an in-flight WS echo) while
  // taskStatusById already holds a completion the server sent directly — see
  // syncNavStatusesFromServer()/the task:updated handlers in template.html.
  for (const taskId of state.activeSessions) {
    const card = document.querySelector(`.card[data-id="${CSS.escape(taskId)}"]`);
    const status = card?.dataset.status;
    if (!status) continue;
    if (isCompleteName(state.taskStatusById.get(taskId)) && !isCompleteName(status)) continue;
    state.taskStatusById.set(taskId, status);
  }

  document.querySelectorAll('.btn-claude').forEach(btn => {
    const taskId = btn.dataset.taskId;
    const card = btn.closest('.card');
    // (C1340) An objective/parent container task never runs in a terminal — same
    // defensive removal as the human-assignee branch below, for the same reason:
    // applyTaskPatch()/refreshCard() don't rebuild .controls-row, so a stale
    // .btn-claude can still be mounted right after an isObjective flip until the
    // 'reload' it now triggers finishes.
    if (card?.dataset.objective === '1') {
      card.querySelector('.btn-terminate')?.remove();
      btn.remove();
      return;
    }
    if (card?.dataset.agentAssignee === 'human') {
      card.querySelector('.btn-terminate')?.remove();
      btn.remove();
      return;
    }
    // (TPT272/TPT283) Locked by an open Rehash → Discuss/Split tab — no Start/Resume until it clears.
    if (isTaskDiscussing(state, taskId)) {
      btn.remove();
      return;
    }
    const isCompleted = isCompleteName(card?.dataset.status);
    const existingTermBtn = card?.querySelector('.btn-terminate');
    const isActive = state.activeSessions.has(taskId);
    const isExited = state.exitedSessions.has(taskId);
    // (TPT374) mode is role-derived from the card's live status, not a literal name — an
    // in-progress task with the agent process still running reads as RUNNING (spinner), while
    // RESUME covers both "interrupted, no process" and "done but the agent kept going".
    const mode = sessionButtonMode(card?.dataset.status, { active: isActive, exited: isExited });

    if (mode === SESSION_BUTTON_MODES.RUNNING) {
      // In-progress with a live process — busy, not actionable. Same spinner recipe as the
      // left-nav "+ Create" loading ring. Only mount the span once: rewriting innerHTML on
      // every repaint (attention events fire often) would restart the CSS animation.
      if (!btn.querySelector('.session-spinner')) btn.innerHTML = SESSION_SPINNER_HTML;
      btn.title = t('tooltip.showRunningSession');
      btn.classList.add('resumable', 'session-running');
      if (card) card.classList.add('has-active-session');
      if (!isCompleted && existingTermBtn) existingTermBtn.remove();
    } else if (isActive) {
      // Process is running but status isn't in-progress (e.g. a completed task whose agent
      // kept going) — play icon, resumable, Terminate offered on completed cards.
      btn.innerHTML = PLAY_ICON;
      btn.title = t('tooltip.resumeSession');
      btn.classList.remove('session-running');
      btn.classList.add('resumable');
      if (card) card.classList.add('has-active-session');

      // Show Stop button for completed cards with active sessions
      if (isCompleted && !existingTermBtn) {
        const termBtn = document.createElement('button');
        termBtn.className = 'btn-terminate card-ctl';
        termBtn.innerHTML = STOP_ICON;
        termBtn.title = t('tooltip.terminateSession');
        termBtn.dataset.taskId = taskId;
        termBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          clearAttention(taskId, 'session-ended');
          termBtn.disabled = true;
          termBtn.innerHTML = '...';
          terminateSessionFromCard(taskId);
        });
        btn.insertAdjacentElement('afterend', termBtn);
      } else if (!isCompleted && existingTermBtn) {
        existingTermBtn.remove();
      }

    } else if (isExited) {
      // Process exited but session exists — show play icon
      btn.innerHTML = PLAY_ICON;
      btn.title = t('tooltip.resumeSessionExited');
      btn.classList.remove('session-running');
      btn.classList.add('resumable');
      if (card) card.classList.add('has-active-session');

      // Show Stop button for completed cards with exited sessions
      if (isCompleted && !existingTermBtn) {
        const termBtn = document.createElement('button');
        termBtn.className = 'btn-terminate card-ctl';
        termBtn.innerHTML = STOP_ICON;
        termBtn.title = t('tooltip.terminateSession');
        termBtn.dataset.taskId = taskId;
        termBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          clearAttention(taskId, 'session-ended');
          termBtn.disabled = true;
          termBtn.innerHTML = '...';
          terminateSessionFromCard(taskId);
        });
        btn.insertAdjacentElement('afterend', termBtn);
      }
    } else {
      // No session — show default (play icon for completed, text for others)
      if (isCompleted) {
        btn.innerHTML = PLAY_ICON;
        btn.title = t('btn.start');
      } else {
        btn.textContent = t('btn.start');
      }
      btn.classList.remove('resumable', 'session-running');
      if (card) card.classList.remove('has-active-session');
      if (existingTermBtn) existingTermBtn.remove();
    }
  });

  document.querySelectorAll('.btn-start-discussion').forEach(btn => {
    const taskId = btn.dataset.taskId;
    const card = btn.closest('.card');
    // (C1340) Same defensive removal as the .btn-claude loop above.
    if (card?.dataset.objective === '1') {
      btn.remove();
      return;
    }
    const isActive = state.activeSessions.has(taskId);
    const isExited = state.exitedSessions.has(taskId);

    if (isActive || isExited) {
      btn.innerHTML = PLAY_ICON;
      btn.title = t('tooltip.resumeSession');
      btn.classList.add('resumable');
      if (card) card.classList.add('has-active-session');
    } else {
      btn.textContent = t('btn.start');
      btn.classList.remove('resumable');
      if (card) card.classList.remove('has-active-session');
    }
  });

  syncTaskEditSessionButtons();

  // (C1144) Every session start/exit/terminate and attention transition funnels through
  // here, so the left-nav active-sessions list piggybacks on it too. C1306's reconciliation
  // above ensures this repaint sees a mounted card's latest status.
  syncActiveSessionsNav();

  // (C1462) A local session start (openTerminal()'s ws.onopen, startTaskSession()) never
  // triggers a full loadAndRender() — only this function. The objective nav tabs live in
  // #app, which template.html owns, and this module can't call loadAndRender()/
  // pushSubtaskCrumb() — bridge event, same rationale as tiptask:task-cache-patch.
  document.dispatchEvent(new CustomEvent('tiptask:objective-tabs-sync'));
}

// ── (C1144) Active agent sessions — left nav ──
// Reuses the card-badge icon set from task-card.js (already imported above). Task agents are
// only 'claude' | 'codex' | 'pi' — gemini is an objective-chat-only provider and never runs a
// terminal session, so it has no icon here; an unknown/missing id falls back to the Claude
// glyph rather than rendering nothing.
function _sessionAgentIcon(id) {
  if (id === 'codex') return CODEX_BADGE_SVG;
  if (id === 'pi') return PI_BADGE_SVG;
  return CLAUDE_BADGE_SVG;
}

// (C1157) Completed badge — a green tick centered over the agent icon (CSS dims the icon's
// own svg to 0.4 behind it), replacing the C1152 diagonal strike: "done", not "disabled".
// Decorative — the row's own title/aria-label already identifies the session.
const SESSION_DONE_BADGE = '<span class="session-check" aria-hidden="true">'
  + '<svg viewBox="0 0 12 12" fill="none"><polyline points="2.5 6 5 8.5 9.5 3.5" '
  + 'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '</svg></span>';

// One row per RUNNING terminal session, rendered into #active-sessions-list in the left nav.
// `sessions` entries: { taskId, agent, title, isOpen, needsAttention }. `collapsed` mirrors
// document.body.classList.contains('left-nav-collapsed') — the row markup is identical either
// way (CSS hides the key/title spans when collapsed, same pattern as .left-nav-label), but the
// flag still drives the tooltip so an icon-only row stays identifiable on hover.
export function renderActiveSessionsList(sessions, collapsed) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (list.length === 0) return '';
  return list.map((s) => {
    const key = escapeAttr(s.taskId);
    const title = escapeAttr(s.title || '');
    const done = isCompleteName(s.status); // (C1152) row styling + (C1157) check badge
    const cls = 'active-session-item'
      + (s.isOpen ? ' active' : '')
      + (s.needsAttention ? ' needs-attention' : '')
      + (done ? ' session-completed' : '')
      + (collapsed ? ' collapsed' : '');
    // Falls back to the bare task key when title is unknown (session's task fell outside the
    // current fetch — subtask drill-in / assignee scoping) so the tooltip never dangles a
    // trailing "KEY — " with nothing after it.
    const base = s.title ? t('nav.sessionTooltip', { key: s.taskId, title: s.title }) : String(s.taskId);
    const tip = escapeAttr(s.needsAttention ? t('nav.sessionNeedsAttention', { label: base }) : base);
    // (C1152) Close control — nested <span role="button"> since .active-session-item is
    // itself a <button> (nested <button> invalid HTML). Mirrors .chat-tab-close (chat-ui.js),
    // plus keyboard support that precedent lacks.
    const closeTip = escapeAttr(t('tooltip.terminateSession'));
    const closeBtn = `<span class="active-session-close" role="button" tabindex="0" `
      + `data-close-task-id="${key}" title="${closeTip}" aria-label="${closeTip}">&#x2715;</span>`;
    return `<button type="button" class="${cls}" data-task-id="${key}" title="${tip}" aria-label="${tip}">`
      + `<span class="active-session-icon">${_sessionAgentIcon(s.agent)}${done ? SESSION_DONE_BADGE : ''}</span>`
      + `<span class="active-session-key">${key}</span>`
      + `<span class="active-session-title">${title}</span>`
      + closeBtn
      + `</button>`;
  }).join('');
}

// Builds the session row list from state, paints it into the left nav, and (re)wires clicks.
// Called from updateClaudeButtons() (every session/attention state change), syncLeftNavPanel()
// (every render + visibility/focus resync), and setLeftNavCollapsed() (collapse toggle) — see
// template.html. No-ops before the nav exists (first paint order, or the panel not yet mounted).
export function syncActiveSessionsNav() {
  // (C1387) Re-applies .needs-attention to every mounted card from state.attentionSessions —
  // the re-render-survival counterpart of renderCard()'s own attentionClass() emission. Placed
  // here (not only inside updateClaudeButtons()'s two button loops, which skip any card with no
  // Start/Discussion button — objective/human-assigned cards) so every call site that reaches
  // this function also repaints the board, not just the nav row. See attention-state.js.
  syncAttentionClasses();
  // (TPT12) Same re-render-survival reasoning — the activity chip is a real DOM element, not
  // a class, so it needs the same repaint-on-every-call-site treatment.
  syncActivityChips();
  const host = document.getElementById('active-sessions-list');
  if (!host) return;
  const collapsed = document.body.classList.contains('left-nav-collapsed');
  const openId = state.activeTerminal?.taskId || null;
  const rows = [...state.activeSessions]
    // /api/sessions does not filter by session type — keep objective/spec-chat sessions
    // (and their 'obj-'-prefixed synthetic ids) out of what is meant to be a terminal list.
    .filter((id) => (state.sessionMeta.get(id)?.type || 'terminal') === 'terminal')
    .filter((id) => !String(id).startsWith('obj-'))
    .sort()
    .map((id) => ({
      taskId: id,
      agent: state.sessionMeta.get(id)?.agent || state.taskAgent,
      title: state.taskTitleById.get(id) || '',
      status: state.taskStatusById.get(id) || '', // (C1152) drives .session-completed styling
      isOpen: id === openId,
      needsAttention: state.attentionSessions.has(id),
    }));
  const html = renderActiveSessionsList(rows, collapsed);
  host.hidden = rows.length === 0;
  const divider = document.getElementById('active-sessions-divider');
  if (divider) divider.hidden = rows.length === 0;
  // (TPT360) The rail stays reachable while a terminal is open, and session/attention events
  // repaint it often — rewriting identical markup would replace the very row under the pointer
  // between mousedown and click, so that click would be lost. Row listeners wired on the prior
  // paint stay valid on the untouched nodes.
  if (host._sessionsHtml === html && host.children.length === rows.length) return;
  host._sessionsHtml = html;
  host.innerHTML = html;
  host.querySelectorAll('.active-session-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.taskId;
      const title = state.taskTitleById.get(id) || id;
      const status = state.taskStatusById.get(id) || inProgressName();
      window.TipTask?.openTerminal?.(id, title, '', status);
    });
  });
  // (C1152) Per-row terminate control — completed sessions kill with no ceremony (the work
  // is done, only a lingering process remains); anything else confirms first since a stray
  // click on a 32px row would otherwise kill an agent mid-task.
  // (C1223) Shared status-aware confirmation lives in console-modal.js and is reached through
  // the bridge to avoid a console-modal.js ↔ task-board.js import cycle.
  // (C1458) requestSessionClose() is async (non-blocking confirm) — set data-busy BEFORE
  // the await, not after, so a second Enter/click during the confirm can't fire this twice
  // (a native confirm() used to make that impossible by blocking the event loop); clear it
  // again on cancel so the row is retryable.
  host.querySelectorAll('.active-session-close[data-close-task-id]').forEach((x) => {
    const kill = async (e) => {
      e.stopPropagation(); // never let the click reach the row → openTerminal
      e.preventDefault();
      if (x.dataset.busy) return; // re-entrancy guard
      const id = x.dataset.closeTaskId;
      const status = state.taskStatusById.get(id) || '';
      x.dataset.busy = '1';
      if (!(await window.TipTask?.requestSessionClose?.(status, id))) {
        delete x.dataset.busy;
        return;
      }
      clearAttention(id, 'session-ended');
      terminateSessionFromCard(id);
    };
    x.addEventListener('click', kill);
    x.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') kill(e); });
  });
}

// ── Bulk action bar ──

let _bulkBarInited = false;
let _bulkOnLoadAndRender = null;
let _bulkStartTaskSession = null;
let _bulkFetchActiveSessions = null;

function _findTaskForBulkStart(id) {
  for (const list of Object.values(state.tiers || {})) {
    if (!Array.isArray(list)) continue;
    const found = list.find(t => t.id === id);
    if (found) return found;
  }

  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!card) return { id, title: id, description: '', status: startName(), agentAssignee: null, assignee: null };
  return {
    id,
    title: card.querySelector('.card-title')?.textContent?.trim() || id,
    description: card.querySelector('.card-desc')?.dataset.raw || '',
    status: card.dataset.status || startName(),
    agentAssignee: card.dataset.agentAssignee || null,
    assignee: card.dataset.assignee ? Number(card.dataset.assignee) : null,
  };
}

function _patchBulkStartTask(t, body) {
  return api.tasks.update(t.id, body);
}

function _hasTerminalAgent(t) {
  return t.agentAssignee && t.agentAssignee !== 'human';
}

async function _startBulkTerminalTask(t, agent) {
  await _patchBulkStartTask(t, { status: inProgressName() });
  if (!_bulkStartTaskSession) throw new Error('Session starter unavailable');
  await _bulkStartTaskSession(t, agent);
}

async function _finishBulkStart() {
  state.selectedCardIds.clear();
  updateBulkActionBar();
  if (_bulkOnLoadAndRender) await _bulkOnLoadAndRender();
}

async function _refreshBulkSessions() {
  if (_bulkFetchActiveSessions) await _bulkFetchActiveSessions();
}

export function initBulkActionBar(onLoadAndRender, opts = {}) {
  _bulkOnLoadAndRender = onLoadAndRender;
  if (opts.onStartTaskSession) _bulkStartTaskSession = opts.onStartTaskSession;
  if (opts.onFetchActiveSessions) _bulkFetchActiveSessions = opts.onFetchActiveSessions;
  if (_bulkBarInited) return;
  _bulkBarInited = true;

  const bar = document.createElement('div');
  bar.className = 'bulk-action-bar';
  bar.id = 'bulk-action-bar';
  bar.hidden = true;
  // (TPT273) Three .bulk-group clusters: selection | edit fields | actions. Field
  // wrappers are divs, not wrapping <label>s — a wrapping label forwarded clicks to
  // the agent picker's trigger button (double toggle); native controls get a
  // for-bound label instead, the custom agent picker gets aria-labelledby.
  bar.innerHTML = `
    <div class="bulk-group bulk-group--selection">
      <span class="bulk-count"></span>
      <button type="button" class="bulk-clear bulk-btn bulk-btn--ghost" title="${escapeAttr(t('btn.clearSelection'))}" aria-label="${escapeAttr(t('btn.clearSelection'))}"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg><span class="bulk-clear-text">${t('bulk.clear')}</span></button>
    </div>
    <div class="bulk-group bulk-group--edit">
      <div class="bulk-field bulk-move-label bulk-move-priority-label"><label class="bulk-field-label bulk-move-text" for="bulk-move-input">${t('bulk.moveTo')}</label><div class="sprint-combo sprint-combo--plain bulk-priority-combo" data-id="__bulk__" data-current=""><input id="bulk-move-input" class="sprint-combo-input" type="text" readonly placeholder="${escapeAttr(t('bulk.moveToPlaceholder'))}"><div class="sprint-combo-dropdown" hidden></div></div></div>
      <div class="bulk-field bulk-move-label"><label class="bulk-field-label bulk-status-text" for="bulk-status-select">${t('bulk.status')}</label><select id="bulk-status-select" class="bulk-status-select" aria-label="${escapeAttr(t('bulk.status'))}"></select></div>
      <div class="bulk-field bulk-move-label"><span class="bulk-field-label bulk-agent-text" id="bulk-agent-label">${t('bulk.agent')}</span><span class="bulk-agent-picker-slot"></span></div>
      <div class="bulk-field bulk-move-label bulk-assignee-label"><label class="bulk-field-label bulk-assignee-text" for="bulk-assignee-input">${t('bulk.assignee')}</label><span class="bulk-assignee-picker-slot"></span></div>
    </div>
    <div class="bulk-group bulk-group--actions">
      <button type="button" class="btn-bulk-start bulk-btn bulk-btn--primary">${t('btn.start')}</button>
      <button type="button" class="btn-bulk-deps bulk-btn bulk-btn--secondary">${t('bulk.deps')}</button>
      <span class="bulk-spacer"></span>
      <button type="button" class="bulk-delete bulk-btn bulk-btn--danger">${t('btn.delete')}</button>
    </div>`;
  document.body.appendChild(bar);

  bar.querySelector('.bulk-clear').addEventListener('click', () => {
    clearBulkSelection();
  });

  bar.querySelector('.bulk-delete').addEventListener('click', async () => {
    const ids = [...state.selectedCardIds];
    if (!ids.length) return;
    const confirmed = await showActionConfirm({
      message: tc('bulk.confirmDelete', ids.length),
      confirmLabel: t('btn.delete'),
      danger: true,
      overlayClass: 'modal-overlay--over-board',
    });
    if (!confirmed) return;
    showSavingIndicator();
    try {
      for (const id of ids) {
        await api.tasks.delete(id).catch(() => {});
      }
      state.selectedCardIds.clear();
      updateBulkActionBar();
      if (_bulkOnLoadAndRender) await _bulkOnLoadAndRender();
    } finally {
      hideSavingIndicator();
    }
  });

  function rebuildStatusOptions() {
    const select = bar.querySelector('.bulk-status-select');
    if (!select) return;
    const current = select.value;
    const names = statusNames();
    select.innerHTML = `<option value="">${escapeAttr(t('bulk.statusPlaceholder'))}</option>`
      + names.map(name => `<option value="${escapeAttr(name)}">${escapeAttr(statusLabel(name))}</option>`).join('');
    select.value = names.includes(current) ? current : '';
  }

  async function bulkPatchStatus(status, confirmMsgFn) {
    const ids = [...state.selectedCardIds];
    if (!ids.length) return;
    if (!(await showActionConfirm({ message: confirmMsgFn(ids.length), confirmLabel: t('btn.confirm'), overlayClass: 'modal-overlay--over-board' }))) return;
    showSavingIndicator();
    try {
      for (const id of ids) {
        await api.tasks.update(id, { status }).catch(() => {});
      }
      state.selectedCardIds.clear();
      updateBulkActionBar();
      if (_bulkOnLoadAndRender) await _bulkOnLoadAndRender();
    } finally {
      hideSavingIndicator();
    }
  }

  bar.querySelector('.bulk-status-select').addEventListener('change', async (event) => {
    const select = event.currentTarget;
    const status = select.value;
    if (!status) return;
    // (C1458) Reset the select before awaiting the now-async confirm — otherwise it would
    // visibly sit on the chosen status for as long as the non-blocking dialog is open.
    select.value = '';
    await bulkPatchStatus(status, (n) => tc('bulk.confirmStatus', n, { status: statusLabel(status) }));
  });
  rebuildStatusOptions();
  bar.querySelector('.btn-bulk-start').addEventListener('click', async () => {
    const ids = [...state.selectedCardIds];
    if (!ids.length) return;
    const tasks = ids.map(_findTaskForBulkStart).filter(Boolean).filter(canStartTaskCard);
    const nonPendingCount = tasks.reduce((count, task) => !isStartName(task.status) ? count + 1 : count, 0);
    const startBtn = bar.querySelector('.btn-bulk-start');
    if (nonPendingCount > 0) {
      // (C1458) Disable the button BEFORE the now-async confirm so a second click during
      // the dialog can't queue a duplicate bulk-start (native confirm() used to make that
      // impossible by blocking the event loop); re-enable on cancel.
      startBtn.disabled = true;
      const ok = await showActionConfirm({ message: tc('bulk.confirmRestart', nonPendingCount), confirmLabel: t('btn.confirm'), overlayClass: 'modal-overlay--over-board' });
      if (!ok) { startBtn.disabled = false; return; }
    }

    const terminalAssigned = tasks.filter(_hasTerminalAgent);
    const humanAssigned = tasks.filter(t => t.agentAssignee === 'human');
    const unassigned = tasks.filter(t => !t.agentAssignee);
    let waitingForModal = false;
    startBtn.disabled = true;

    try {
      await Promise.allSettled([
        ...humanAssigned.map(t => _patchBulkStartTask(t, { status: inProgressName() })),
        ...terminalAssigned.map(t => _startBulkTerminalTask(t, t.agentAssignee)),
      ]);
      await _refreshBulkSessions();

      if (unassigned.length > 0) {
        waitingForModal = true;
        showBulkAgentStartModal(unassigned, async (choice) => {
          try {
            if (choice === 'human') {
              await Promise.allSettled(
                unassigned.map(t => _patchBulkStartTask(t, { agent_assignee: 'human', status: inProgressName() }))
              );
            } else {
              await Promise.allSettled(
                unassigned.map(async t => {
                  await _patchBulkStartTask(t, { agent_assignee: choice, status: inProgressName() });
                  if (!_bulkStartTaskSession) throw new Error('Session starter unavailable');
                  await _bulkStartTaskSession(t, choice);
                })
              );
              await _refreshBulkSessions();
            }
          } catch (err) {
            showToast(t('bulk.errStartFailed', { msg: err.message }), 'error');
          }
          startBtn.disabled = false;
          await _finishBulkStart();
        }, {
          onCancel: async () => {
            startBtn.disabled = false;
            await _finishBulkStart();
          },
        });
      } else {
        await _finishBulkStart();
      }
    } catch (err) {
      showToast(t('bulk.errStartFailed', { msg: err.message }), 'error');
    } finally {
      if (!waitingForModal) startBtn.disabled = false;
    }
  });

  bar.querySelector('.btn-bulk-deps').addEventListener('click', () => {
    const ids = [...state.selectedCardIds];
    if (!ids.length) return;
    showBulkDepsModal(ids, async (picked) => {
      const msg = picked.length
        ? tc('bulk.confirmSetDeps', ids.length, { deps: escapeAttr(picked.join(', ')) })
        : tc('bulk.confirmClearDeps', ids.length);
      // (C1458) Destructive REPLACE guard — non-blocking confirm, danger styling since it
      // overwrites (not merges) every selected task's dependency list.
      if (!(await showActionConfirm({ message: msg, confirmLabel: t('btn.confirm'), danger: true, overlayClass: 'modal-overlay--over-board' }))) return;
      showSavingIndicator();
      const failed = [];
      try {
        for (const id of ids) {
          const next = picked.filter(d => d !== id); // belt & braces: no task depends on itself
          try {
            await api.tasks.update(id, { dependencies: next });
          } catch {
            failed.push(id);
          }
        }
        state.selectedCardIds.clear();
        updateBulkActionBar();
        if (_bulkOnLoadAndRender) await _bulkOnLoadAndRender();
      } finally {
        hideSavingIndicator();
      }
      if (failed.length) showToast(t('bulk.errDepsFailed', { ids: failed.join(', ') }), 'error');
    });
  });

  initSprintCombobox(bar.querySelector('.bulk-priority-combo'), { onSelect: async (raw) => {
    if (!raw) return;
    const isNewSprint = raw === '__new__';
    const isBacklog = raw === 'null';
    const newPriority = isNewSprint
      ? Math.max(...(state.tierKeys || []), 0, sprintRecordMax(state.sprints)) + 1
      : isBacklog ? 0
      : Number(raw);
    const ids = [...state.selectedCardIds];
    showSavingIndicator();
    try {
      // TPT3 — capture each PATCH response instead of discarding it: a moved subtask can
      // carry its own objective parent along (parent_rescheduled), and that cascade needs
      // applying to the board same as the child's own move does, below.
      const results = [];
      for (const id of ids) {
        results.push(await api.tasks.update(id, { priority: newPriority }).catch(() => null));
      }
      state.expandedTiers.add(newPriority);
      state.collapsedTiers.delete(newPriority);
      // Immediately regroup cards to the new sprint tier; reload only when needed
      let needsReload = isNewSprint;
      if (!isNewSprint) {
        for (const id of ids) {
          // Clear selection visual before moving
          const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
          if (card) { card.classList.remove('selected'); card.querySelector('.btn-select-card')?.classList.remove('checked'); }
          const r = regroupCardToSprint(id, newPriority, isBacklog);
          if (regroupNeedsReload(r)) needsReload = true;
        }
      }
      for (const res of results) {
        if (res?.parentRescheduled && applyParentSprintFollow(res.parentRescheduled)) needsReload = true;
      }
      state.selectedCardIds.clear();
      updateBulkActionBar();
      if (needsReload && _bulkOnLoadAndRender) await _bulkOnLoadAndRender({ forceFresh: true });
    } finally {
      hideSavingIndicator();
    }
  }});

  async function handleBulkAgentChange(agentId) {
    if (!agentId) return;
    const ids = [...state.selectedCardIds];
    if (!ids.length) { rebuildAgentOptions(); return; }

    // Must be a live function, not a Set snapshotted at module-eval time — the registry
    // may not have loaded yet when this module first evaluates (C1187).
    const isLocked = (s) => isInProgressName(s) || isCanceledName(s);
    const reassignable = [];
    const locked = [];
    for (const id of ids) {
      const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
      const status = card ? card.dataset.status : startName();
      (isLocked(status) ? locked : reassignable).push(id);
    }

    if (reassignable.length === 0) {
      showToast(t('bulk.allLocked'), 'error');
      rebuildAgentOptions();
      return;
    }
    if (locked.length > 0) {
      const agentLabel = escapeAttr(_AGENT_PICKER_LABELS[agentId] || agentId);
      const ok = await showActionConfirm({
        message: t('bulk.confirmSkipLocked', { locked: locked.length, n: reassignable.length, agent: agentLabel }),
        confirmLabel: t('btn.confirm'),
        overlayClass: 'modal-overlay--over-board',
      });
      if (!ok) { rebuildAgentOptions(); return; }
    }
    showSavingIndicator();
    try {
      for (const id of reassignable) {
        await api.tasks.update(id, { agent_assignee: agentId }).catch(() => {});
      }
      state.selectedCardIds.clear();
      updateBulkActionBar();
      if (_bulkOnLoadAndRender) await _bulkOnLoadAndRender();
    } finally {
      hideSavingIndicator();
    }
  }

  function rebuildAgentOptions() {
    const slot = bar.querySelector('.bulk-agent-picker-slot');
    if (!slot) return;
    const ids = ['human', ...(state.availableAgents || [])];
    slot.innerHTML = renderAgentPicker('bulkAgent', '', false, ids);
    const picker = slot.querySelector('.agent-picker');
    if (picker) initAgentPicker(picker, { onChange: handleBulkAgentChange });
    slot.querySelector('.agent-picker-trigger')?.setAttribute('aria-labelledby', 'bulk-agent-label');
  }

  async function handleBulkAssigneeChange(assignee) {
    const ids = [...state.selectedCardIds];
    if (!ids.length) return;
    showSavingIndicator();
    try {
      for (const id of ids) {
        await api.tasks.update(id, { assignee }).catch(() => {});
      }
      bar._resetBulkAssigneePicker?.();
      state.selectedCardIds.clear();
      updateBulkActionBar();
      if (_bulkOnLoadAndRender) await _bulkOnLoadAndRender();
    } finally {
      hideSavingIndicator();
    }
  }

  function rebuildAssigneePicker() {
    const slot = bar.querySelector('.bulk-assignee-picker-slot');
    if (!slot || slot.querySelector('.bulk-assignee-picker')) return;
    slot.innerHTML = `
      <div class="bulk-assignee-picker">
        <input id="bulk-assignee-input" class="bulk-assignee-input" type="text" role="combobox" aria-expanded="false" aria-controls="bulk-assignee-options" autocomplete="off" placeholder="${escapeAttr(t('bulk.assigneePlaceholder'))}">
        <div class="bulk-assignee-dropdown" id="bulk-assignee-options" role="listbox" hidden></div>
      </div>`;

    const picker = slot.querySelector('.bulk-assignee-picker');
    const input = picker.querySelector('.bulk-assignee-input');
    const dropdown = picker.querySelector('.bulk-assignee-dropdown');

    const renderOptions = () => {
      const query = input.value.trim().toLocaleLowerCase();
      const members = _acceptedMembers()
        .filter(member => !query || member.name.toLocaleLowerCase().includes(query));
      dropdown.innerHTML = members.length
        ? members.map(member => `<div class="bulk-assignee-option" role="option" data-value="${escapeAttr(String(member.id))}" data-name="${escapeAttr(member.name)}">${escapeAttr(member.name)}</div>`).join('')
        : `<div class="bulk-assignee-empty">${escapeAttr(t('bulk.noMembers'))}</div>`;
    };

    const open = () => {
      renderOptions();
      dropdown.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      dropdown.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    };

    // (C1520) Focus is the one moment worth a round-trip — `input` fires per
    // keystroke, so it keeps the cache-only `open()`. Repainting an open list is
    // already the status quo here (updateBulkActionBar() calls
    // _refreshBulkAssigneePicker on every loadAndRender) and is safe: this picker
    // has no active-row state — Enter always takes the first rendered option —
    // and renderOptions() re-reads input.value, so a typed query survives.
    const openAndRevalidate = () => {
      open();
      void refreshProjectMembers().then((changed) => {
        if (!changed || dropdown.hidden) return;
        renderOptions();
      });
    };

    input.addEventListener('focus', openAndRevalidate);
    input.addEventListener('input', open);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        close();
        return;
      }
      if (event.key !== 'Enter') return;
      const first = dropdown.querySelector('.bulk-assignee-option');
      if (!first) return;
      event.preventDefault();
      first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    dropdown.addEventListener('mousedown', (event) => {
      const option = event.target.closest('.bulk-assignee-option');
      if (!option) return;
      event.preventDefault();
      input.value = option.dataset.name || '';
      close();
      void handleBulkAssigneeChange(Number(option.dataset.value));
    });

    document.addEventListener('click', (event) => {
      if (!picker.contains(event.target)) close();
    });

    bar._refreshBulkAssigneePicker = renderOptions;
    bar._resetBulkAssigneePicker = () => {
      input.value = '';
      close();
      renderOptions();
    };
    renderOptions();
  }

  bar._rebuildAgentOptions = rebuildAgentOptions;
  rebuildAgentOptions();
  rebuildAssigneePicker();
  void ensureProjectMembers().then(() => {
    if (bar.isConnected) bar._refreshBulkAssigneePicker?.();
  });
}

// Clears the bulk-selection Set + its DOM markers (card ring, select-button dot) and
// hides the bulk-action bar. Extracted from the `.bulk-clear` button's own handler
// (C1452) so filter-change call sites (onBoardFiltersChanged() below,
// applyProjectBoardFilters()) can reuse the exact same reset instead of duplicating it.
export function clearBulkSelection() {
  state.selectedCardIds.clear();
  document.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.btn-select-card.checked').forEach(b => b.classList.remove('checked'));
  updateBulkActionBar();
}

// (TPT274) Tabs whose rendered cards the bulk-action bar may act on. Backlog reuses
// renderCard(), so its cards carry the same .card[data-id] hooks every bulk handler reads.
function isBulkBarTab(tab = state.activeTab) {
  return tab === 'board' || tab === 'backlog';
}

export function updateBulkActionBar() {
  const bar = document.getElementById('bulk-action-bar');
  if (!bar) return;
  if (!isBulkBarTab()) { bar.hidden = true; return; }
  const count = state.selectedCardIds.size;
  bar.hidden = count === 0;
  if (count === 0) return;

  bar.querySelector('.bulk-count').textContent = t('bulk.selected', { n: count });
  // Refresh static labels: the bar is built once, so a locale switch would
  // otherwise leave it in the previous language.
  const clearBtn = bar.querySelector('.bulk-clear');
  clearBtn.querySelector('.bulk-clear-text').textContent = t('bulk.clear');
  clearBtn.title = t('btn.clearSelection');
  clearBtn.setAttribute('aria-label', t('btn.clearSelection'));
  bar.querySelector('.bulk-delete').textContent = t('btn.delete');
  bar.querySelector('.btn-bulk-start').textContent = t('btn.start');
  bar.querySelector('.btn-bulk-deps').textContent = t('bulk.deps');
  // (C1333) "Move to" combo built once at init and never removed — sync its visibility to
  // the live sprints_enabled flag every refresh, so toggling Show Sprints hides it without
  // needing a page reload (initBulkActionBar/updateBulkActionBar already re-run every
  // loadAndRender via tiptask:reload).
  const moveLabel = bar.querySelector('.bulk-move-priority-label');
  if (moveLabel) moveLabel.hidden = !getSprintsEnabled();
  const moveText = bar.querySelector('.bulk-move-text');
  if (moveText) moveText.textContent = t('bulk.moveTo');
  const statusText = bar.querySelector('.bulk-status-text');
  if (statusText) statusText.textContent = t('bulk.status');
  const statusSelect = bar.querySelector('.bulk-status-select');
  if (statusSelect) {
    statusSelect.setAttribute('aria-label', t('bulk.status'));
    const currentStatus = statusSelect.value;
    const names = statusNames();
    statusSelect.innerHTML = `<option value="">${escapeAttr(t('bulk.statusPlaceholder'))}</option>`
      + names.map(name => `<option value="${escapeAttr(name)}">${escapeAttr(statusLabel(name))}</option>`).join('');
    statusSelect.value = names.includes(currentStatus) ? currentStatus : '';
  }
  const agentText = bar.querySelector('.bulk-agent-text');
  if (agentText) agentText.textContent = t('bulk.agent');
  const assigneeText = bar.querySelector('.bulk-assignee-text');
  if (assigneeText) assigneeText.textContent = t('bulk.assignee');
  const assigneeInput = bar.querySelector('.bulk-assignee-input');
  if (assigneeInput) assigneeInput.placeholder = t('bulk.assigneePlaceholder');
  const moveInput = bar.querySelector('.bulk-priority-combo .sprint-combo-input');
  if (moveInput) moveInput.placeholder = t('bulk.moveToPlaceholder');

  const combo = bar.querySelector('.bulk-priority-combo');
  if (combo) {
    const activeKeys = (state.tierKeys || []).filter(k => {
      if (k <= 0) return false;
      const tier = state.tiers && state.tiers[k];
      if (!Array.isArray(tier)) return false;
      // C1187: widened from pending/in_progress to the full active set — the old literal
      // pair excluded on_fire, which was a latent bug (an on_fire-only sprint disappeared
      // from this picker). Also now generalizes to custom statuses.
      return tier.some(t => isActiveName(t.status));
    });
    const allSprintKeys = (state.tierKeys || []).filter(k => k > 0);
    const globalMaxKey = Math.max(allSprintKeys.length ? Math.max(...allSprintKeys) : 0, sprintRecordMax(state.sprints));
    refreshSprintComboboxItems(combo, activeKeys, { includeBacklog: true, globalMaxKey });
    combo.dataset.current = '';
    const input = combo.querySelector('.sprint-combo-input');
    if (input) input.value = '';
  }

  if (bar._rebuildAgentOptions) bar._rebuildAgentOptions();
  if (bar._refreshBulkAssigneePicker) bar._refreshBulkAssigneePicker();
}

// ── Agent assignment modal ──
// NOTE: do NOT capture CLAUDE_BADGE_SVG/CODEX_BADGE_SVG into module-level consts here —
// task-board.js ↔ task-card.js is a circular import; top-level eager capture yields undefined.
// Reference the imports directly inside the function (call-time binding, already live).
const _HUMAN_MODAL_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg>';

export function openAgentAssignModal(taskId, current, status, onLoadAndRender) {
  if (isAgentLocked(status)) return;

  const card = document.querySelector(`.card[data-id="${CSS.escape(taskId)}"]`);
  const currentPiModel = current === 'pi' ? (card?.dataset.piModel || '') : '';
  const options = _taskAgentPickerOptions().map((option) => {
    const iconSvg = option.id === 'human' ? _HUMAN_MODAL_SVG
      : option.id === 'claude' ? CLAUDE_BADGE_SVG
        : option.id === 'codex' ? CODEX_BADGE_SVG
          : PI_BADGE_SVG;
    return {
      ...option,
      icon: `<span class="agent-assign-option-icon agent-assign-option-icon--${option.id}">${iconSvg}</span>`,
    };
  });

  const overlay = document.createElement('div');
  overlay.className = 'agent-assign-overlay';
  overlay.innerHTML = `
    <div class="agent-assign-modal">
      <h3>${t('modal.assignAgent')}</h3>
      ${options.map(o => `
        <button class="agent-assign-option${_agentPickerOptionMatches(o, current, currentPiModel) ? ' agent-assign-option--active' : ''}" data-value="${escapeAttr(o.id)}" data-pi-model="${escapeAttr(o.piModel || '')}"${o.title ? ` title="${escapeAttr(o.title)}"` : ''}>
          ${o.icon}
          <span>${escapeAttr(o.label)}</span>
        </button>`).join('')}
    </div>`;
  document.body.appendChild(overlay);

  function close() { overlay.remove(); document.removeEventListener('keydown', onEsc); }

  function onEsc(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onEsc);

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

  overlay.querySelectorAll('.agent-assign-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      const choice = btn.dataset.value;
      const piModel = choice === 'pi' ? (btn.dataset.piModel || null) : null;
      close();
      const patch = { agent_assignee: choice };
      if (choice === 'pi') patch.pi_model = piModel;
      await api.tasks.update(taskId, patch).catch(() => {});
      if (onLoadAndRender) await onLoadAndRender();
    });
  });
}

// ── Bulk agent start modal (sprint play-all / bulk start: unassigned tasks) ──
export function showBulkAgentStartModal(unassignedTasks, onConfirm, opts = {}) {
  const n = unassignedTasks.length;
  const agents = opts.agents || ['human', ...(state.availableAgents || [])];
  const overlay = document.createElement('div');
  overlay.className = 'bulk-agent-start-overlay';
  overlay.innerHTML = `
    <div class="bulk-agent-start-modal">
      <h3>${tc('board.startTasks', n)}</h3>
      <p class="bulk-agent-start-sub">${tc('modal.tasksNeedAgent', n)}</p>
      <div class="bulk-agent-start-picker">${renderAgentPicker('bulkStartAgent', '', false, agents)}</div>
      <div class="bulk-agent-start-actions">
        <button type="button" class="bulk-agent-start-cancel">${t('btn.cancel')}</button>
        <button type="button" class="bulk-agent-start-confirm" disabled>${t('btn.start')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const pickerEl = overlay.querySelector('.agent-picker');
  const confirmBtn = overlay.querySelector('.bulk-agent-start-confirm');
  let chosenValue = '';

  initAgentPicker(pickerEl, {
    onChange: (val) => {
      chosenValue = val;
      confirmBtn.disabled = !val;
    },
  });

  let closed = false;
  function close(canceled = false) {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onEsc);
    if (canceled && opts.onCancel) opts.onCancel();
  }
  function onEsc(e) { if (e.key === 'Escape') close(true); }
  document.addEventListener('keydown', onEsc);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(true); });
  overlay.querySelector('.bulk-agent-start-cancel').addEventListener('click', () => close(true));
  confirmBtn.addEventListener('click', () => {
    if (!chosenValue) return;
    close();
    onConfirm(chosenValue);
  });
}

// Bulk "Set Dependencies" modal (C1076). REPLACE semantics: the caller applies
// `onConfirm`'s picked keys as the exact dependency list for every task in
// `taskIds`, wiping whatever deps each task had — the caller is responsible for
// the destructive-action confirm(). Every id in `taskIds` is excluded from its
// own candidate list, since none of them may depend on themselves or on each
// other in a single bulk op (that stays an edit-modal operation).
// C1093: cycle guard uses the plain (pre-apply) graph — a taskIds entry's own
// stale out-edges never affect which candidates would cycle back to it (only
// edges INTO it matter, see dep-graph.js), so no REPLACE-in-progress override
// is needed here despite this modal's REPLACE semantics.
export function showBulkDepsModal(taskIds, onConfirm, opts = {}) {
  const n = taskIds.length;
  _cachedProjectTaskList = null; // same rationale as openTaskEditModal — tasks change often
  let picked = [];

  const overlay = document.createElement('div');
  overlay.className = 'bulk-deps-overlay';
  overlay.innerHTML = `
    <div class="bulk-deps-modal">
      <h3>${tc('bulk.depsTitle', n)}</h3>
      <p class="bulk-deps-sub">${t('bulk.depsHint')}</p>
      <div class="modal-deps bulk-deps-field">
        <input class="modal-dep-input" type="text" placeholder="${escapeAttr(t('field.addDepPlaceholder'))}" autocomplete="off">
      </div>
      <div class="bulk-deps-actions">
        <button type="button" class="bulk-deps-cancel">${t('btn.cancel')}</button>
        <button type="button" class="bulk-deps-confirm">${t('btn.apply')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const chipInput = _createDepsChipInput(overlay, {
    scrollEl: overlay,
    isAlive: () => overlay.isConnected,
    getDeps: () => picked,
    setDeps: (next) => { picked = next; },
    getExcludedIds: () => taskIds,
    getCandidates: () => [],
    onResizeHandler: () => {}, // cleanup handled by chipInput.destroy()
    onUpdate: () => {},
  });

  let closed = false;
  function close(canceled = false) {
    if (closed) return;
    closed = true;
    chipInput.destroy();
    overlay.remove();
    // capture-phase listener — see onKeydown below
    document.removeEventListener('keydown', onKeydown, true);
    if (canceled && opts.onCancel) opts.onCancel();
  }
  // Capture phase (same trick as _openImageLightbox, C981): fires BEFORE the
  // typeahead input's own bubble-phase Escape handler, so while the dropdown is
  // open Escape only dismisses the dropdown; a second Escape closes the modal.
  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.dep-typeahead-dropdown')) return;
    e.stopPropagation();
    close(true);
  }
  document.addEventListener('keydown', onKeydown, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(true); });
  overlay.querySelector('.bulk-deps-cancel').addEventListener('click', () => close(true));
  overlay.querySelector('.bulk-deps-confirm').addEventListener('click', () => {
    const chosen = picked.slice();
    close();
    onConfirm(chosen);
  });
  overlay.querySelector('.modal-dep-input').focus();
}

// Show the full ancestor chain, collapsing paths deeper than four levels to
// root › … › parent › current. Reset expansion on stack shrink, but retain it
// when drilling deeper or rerendering at the same depth.
let _breadcrumbExpanded = false;
let _lastBreadcrumbStackLen = 0;

const _BREADCRUMB_SEP = `<span class="breadcrumb-sep">›</span>`;

function _renderBreadcrumbSegment(item, i, isLast) {
  const label = `<span class="breadcrumb-key">${escapeAttr(item.taskKey)}</span> · ${escapeAttr(item.title)}`;
  return isLast
    ? `<span class="breadcrumb-current">${label}</span>`
    : `<button class="breadcrumb-item" data-idx="${i}">${label}</button>`;
}

// Click target for `.breadcrumb-ellipsis` (template.html) — expands the collapsed
// path on the next renderBreadcrumbs() call. Reset happens inside renderBreadcrumbs()
// itself once the stack shrinks again, so no matching "collapse" setter is needed.
export function expandBreadcrumbs() {
  _breadcrumbExpanded = true;
}

export function renderBreadcrumbs(subtaskStack) {
  if (!subtaskStack || subtaskStack.length === 0) {
    _breadcrumbExpanded = false;
    _lastBreadcrumbStackLen = 0;
    return '';
  }
  // Strictly '<' — NOT '<=': clicking "…" re-renders at the SAME length (no push/pop),
  // and that render is exactly the one that must show the flag it just set.
  if (subtaskStack.length < _lastBreadcrumbStackLen) _breadcrumbExpanded = false;
  _lastBreadcrumbStackLen = subtaskStack.length;

  const last = subtaskStack.length - 1;
  let pieces;
  if (subtaskStack.length > 4 && !_breadcrumbExpanded) {
    const hidden = subtaskStack.slice(0, last - 1);
    const hiddenTitles = hidden.map(item => `${item.taskKey} · ${item.title}`).join('\n');
    const ellipsis = `<button class="breadcrumb-ellipsis" title="${escapeAttr(hiddenTitles)}" aria-label="${escapeAttr(t('breadcrumb.expand'))}">…</button>`;
    pieces = [
      ellipsis,
      _renderBreadcrumbSegment(subtaskStack[last - 1], last - 1, false),
      _renderBreadcrumbSegment(subtaskStack[last], last, true),
    ];
  } else {
    pieces = subtaskStack.map((item, i) => _renderBreadcrumbSegment(item, i, i === last));
  }
  return `<div class="breadcrumb-bar">${pieces.join(_BREADCRUMB_SEP)}</div>`;
}

// ── Parent task pane (subtask board) ── (C1461)
// Shows the drilled-into objective's own detail (key/title/status/tags/description/live
// subtasks count) directly under the breadcrumb bar — getChildren() (api-backend.js) never
// returns the parent row itself, so without this the parent is invisible while its children
// are on screen. _parentPaneExpanded mirrors _breadcrumbExpanded's reset rule above: cleared
// whenever the rendered parent's key changes, so drilling into a DIFFERENT objective never
// inherits a stale "expanded description" state.
let _parentPaneExpanded = false;
let _lastParentPaneKey = null;

// Click target for `.parent-task-pane-toggle` (template.html).
export function setParentPaneExpanded(expanded) {
  _parentPaneExpanded = !!expanded;
}

// parentTask: full task object from state.subtaskParentTask, or null when the fetch
// failed/hasn't landed yet (degraded path below). fallback: stack-top { taskKey, title } —
// keeps the pane non-blank even without a resolved parent. children: visibleTasks (already
// excludes reserve_task_keys placeholders, C1017) — the live N/M count is derived from what's
// actually on screen since a drill-down's fetched rows never carry the list-route-only
// childrenCount/completedChildrenCount fields (see subtask-count.js's buildSubtasksLabel doc).
export function renderParentTaskPane(parentTask, { fallback, children } = {}) {
  const key = parentTask?.id ?? fallback?.taskKey;
  if (!key) return '';
  if (key !== _lastParentPaneKey) _parentPaneExpanded = false;
  _lastParentPaneKey = key;

  const title = parentTask?.title ?? fallback?.title ?? '';
  if (!parentTask) {
    return `<div class="parent-task-pane" data-task-key="${escapeAttr(key)}">
      <div class="parent-task-pane-header">
        <span class="id-badge">${escapeAttr(key)}</span>
        <span class="parent-task-pane-title-text">${escapeAttr(title)}</span>
      </div>
    </div>`;
  }

  const badgeClass = parentTask.category === 'CODING' ? 'coding' : 'human';
  const { total, done } = countChildProgress(children);
  const subtasksLabel = buildSubtasksLabel({ childrenCount: total, completedChildrenCount: done });
  const tags = (parentTask.tags || []).map(tag => renderTagBadge(tag, state.tagDescriptions)).join('');
  const desc = renderMarkdown(parentTask.description || '');

  return `<div class="parent-task-pane" data-task-key="${escapeAttr(key)}" data-db-id="${escapeAttr(parentTask.dbId ?? '')}" data-subtasks-total="${total}" data-subtasks-done="${done}">
    <div class="parent-task-pane-header">
      <span class="id-badge ${badgeClass}">${escapeAttr(key)}</span>
      <button type="button" class="parent-task-pane-title" data-task-id="${escapeAttr(key)}">${escapeAttr(title)}</button>
      <span class="status" style="--status-color:${statusColor(parentTask.status)}">${statusLabel(parentTask.status)}</span>
      <span class="parent-task-pane-subtasks">${escapeAttr(subtasksLabel)}</span>
    </div>
    ${tags ? `<div class="card-tags parent-task-pane-tags">${tags}</div>` : ''}
    ${desc ? `
    <div class="parent-task-pane-desc${_parentPaneExpanded ? '' : ' clamped'}">${desc}</div>
    <button type="button" class="parent-task-pane-toggle">${_parentPaneExpanded ? t('chat.bubble.showLess') : t('chat.bubble.showMore')}</button>` : ''}
  </div>`;
}

// ── Agent Picker (custom dropdown with logos, replaces native <select>) ──────

const _CODEX_PICKER_SVG = '<svg class="agent-picker-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" shape-rendering="geometricPrecision"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>';
const _HUMAN_PICKER_SVG = '<svg class="agent-picker-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg>';
// (C1133) Same π glyph as console-modal.js's _PI_AGENT_SVG, just at picker size.
const _PI_PICKER_SVG = '<svg class="agent-picker-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M4 7h16v2.2h-2.6l-.9 9.4a1.6 1.6 0 0 1-3.18-.16l.68-9.24H9.9l-.7 9.3a1.6 1.6 0 0 1-3.18-.18l.68-9.12H4V7z"/></svg>';
const _CARET_SVG = '<svg class="agent-picker-caret" viewBox="0 0 10 6" width="8" height="8" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const _AGENT_PICKER_LABELS = { get human() { return t('agent.human'); }, claude: 'Claude Code', codex: 'Codex', pi: 'Pi' };
// C1187: must be a live function, not a Set captured at module-eval time — the registry
// may not have loaded yet when this module first evaluates. Highest-risk site of this
// migration: a stale Set here would silently unlock the agent picker on a task whose
// status is actually the project's (possibly renamed) in_progress/canceled role.
const isAgentLocked = (s) => isInProgressName(s) || isCanceledName(s);

function _agentPickerIcon(id) {
  if (id === 'claude') return CLAUDE_SVG.replace('<svg ', '<svg class="agent-picker-icon" ');
  if (id === 'codex') return _CODEX_PICKER_SVG;
  if (id === 'pi') return _PI_PICKER_SVG;
  if (id === 'human') return _HUMAN_PICKER_SVG;
  return '';
}

function _configuredPiModels() {
  const configured = (state.objectiveProviders || []).find(provider => provider.id === 'pi')?.configuredModels;
  if (!Array.isArray(configured)) return [];
  return [...new Set(configured.map(model => String(model || '').trim()).filter(Boolean))];
}

function _taskAgentPickerOptions() {
  const piModels = _configuredPiModels();
  return [
    { id: 'human', label: _AGENT_PICKER_LABELS.human },
    { id: 'claude', label: _AGENT_PICKER_LABELS.claude },
    { id: 'codex', label: _AGENT_PICKER_LABELS.codex },
    ...(piModels.length
      ? piModels.map(model => ({ id: 'pi', piModel: model, label: shortModelName(model), title: model }))
      : [{ id: 'pi', piModel: null, label: _AGENT_PICKER_LABELS.pi }]),
  ];
}

function _normalizeAgentPickerOption(option) {
  if (typeof option === 'string') {
    return { id: option, piModel: null, label: _AGENT_PICKER_LABELS[option] || option, icon: _agentPickerIcon(option) };
  }
  const id = option?.id || option?.value || '';
  return {
    id,
    piModel: id === 'pi' ? (option?.piModel || null) : null,
    label: option?.label || _AGENT_PICKER_LABELS[id] || id,
    title: option?.title || '',
    icon: option?.icon || _agentPickerIcon(id),
  };
}

function _agentPickerOptionMatches(option, currentValue, currentPiModel) {
  if (option.id !== (currentValue || '')) return false;
  return option.id !== 'pi' || (option.piModel || '') === (currentPiModel || '');
}

function _applyAgentPickerSelection(draft, value, { piModel } = {}, emptyValue = null) {
  draft.agentAssignee = value || emptyValue;
  if (value === 'pi') draft.piModel = piModel || null;
}

export function renderAgentPicker(name, currentValue, disabled, agents, currentPiModel = null) {
  const allOpts = [
    { id: '', piModel: null, label: t('agent.unassigned'), icon: '' },
    ...agents.map(_normalizeAgentPickerOption),
  ];
  const cur = allOpts.find(o => _agentPickerOptionMatches(o, currentValue, currentPiModel))
    || (currentValue === 'pi'
      ? { id: 'pi', piModel: currentPiModel || null, label: currentPiModel ? shortModelName(currentPiModel) : _AGENT_PICKER_LABELS.pi, icon: _agentPickerIcon('pi') }
      : allOpts[0]);
  const disabledClass = disabled ? ' agent-picker--disabled' : '';
  const titleAttr = disabled ? ` title="${escapeAttr(t('tooltip.cannotReassign'))}"` : '';
  return `
    <div class="agent-picker${disabledClass}" data-name="${escapeAttr(name)}" data-pi-model="${escapeAttr(currentPiModel || '')}"${titleAttr}>
      <button type="button" class="agent-picker-trigger"${disabled ? ' tabindex="-1"' : ''}>
        ${cur.icon}<span class="agent-picker-label">${escapeAttr(cur.label)}</span>${_CARET_SVG}
      </button>
      <ul class="agent-picker-dropdown" hidden>
        ${allOpts.map(o => `<li class="agent-picker-option${_agentPickerOptionMatches(o, currentValue, currentPiModel) ? ' active' : ''}" data-value="${escapeAttr(o.id)}" data-pi-model="${escapeAttr(o.piModel || '')}"${o.title ? ` title="${escapeAttr(o.title)}"` : ''}>${o.icon}<span>${escapeAttr(o.label)}</span></li>`).join('')}
      </ul>
      <input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(currentValue || '')}" data-pi-model="${escapeAttr(currentPiModel || '')}">
    </div>`;
}

let _agentPickerDocListenerAdded = false;
let _openAgentPickerClose = null;

function _ensureAgentPickerDocListener() {
  if (_agentPickerDocListenerAdded) return;
  _agentPickerDocListenerAdded = true;
  document.addEventListener('click', () => {
    if (_openAgentPickerClose) {
      _openAgentPickerClose();
      _openAgentPickerClose = null;
    }
  });
}

export function initAgentPicker(pickerEl, { onChange } = {}) {
  if (!pickerEl || pickerEl.dataset.apInited) return;
  pickerEl.dataset.apInited = '1';
  _ensureAgentPickerDocListener();
  const trigger = pickerEl.querySelector('.agent-picker-trigger');
  const dropdown = pickerEl.querySelector('.agent-picker-dropdown');
  const hiddenInput = pickerEl.querySelector('input[type="hidden"]');
  if (!trigger || !dropdown || !hiddenInput) return;
  if (pickerEl.classList.contains('agent-picker--disabled')) return;

  let _scrollHandler = null;
  let _resizeHandler = null;

  function positionDropdown() {
    const rect = trigger.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';
    dropdown.style.minWidth = rect.width + 'px';
    const h = dropdown.offsetHeight || 200;
    if (rect.bottom + h + 3 > window.innerHeight && rect.top > h + 3) {
      dropdown.style.top = (rect.top - h - 3) + 'px';
    } else {
      dropdown.style.top = (rect.bottom + 3) + 'px';
    }
  }

  function closeDropdown() {
    if (_scrollHandler) { window.removeEventListener('scroll', _scrollHandler, true); _scrollHandler = null; }
    if (_resizeHandler) { window.removeEventListener('resize', _resizeHandler); _resizeHandler = null; }
    dropdown.hidden = true;
    if (dropdown.dataset.portaled) {
      delete dropdown.dataset.portaled;
      pickerEl._portaledDropdown = null;
      if (pickerEl.isConnected) {
        pickerEl.appendChild(dropdown);
      } else {
        dropdown.remove();
      }
      dropdown.style.position = '';
      dropdown.style.zIndex = '';
      dropdown.style.left = '';
      dropdown.style.top = '';
      dropdown.style.minWidth = '';
    }
    if (_openAgentPickerClose === closeDropdown) _openAgentPickerClose = null;
  }

  function openDropdown() {
    if (_openAgentPickerClose && _openAgentPickerClose !== closeDropdown) _openAgentPickerClose();
    dropdown.dataset.portaled = '1';
    pickerEl._portaledDropdown = dropdown;
    document.body.appendChild(dropdown);
    dropdown.style.position = 'fixed';
    dropdown.style.zIndex = '3100'; // C1358: dialog band moved to 3000+, keep in sync
    dropdown.hidden = false;
    positionDropdown();
    _scrollHandler = positionDropdown;
    _resizeHandler = positionDropdown;
    window.addEventListener('scroll', _scrollHandler, true);
    window.addEventListener('resize', _resizeHandler);
    _openAgentPickerClose = closeDropdown;
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!dropdown.hidden) {
      closeDropdown();
    } else {
      openDropdown();
    }
  });

  pickerEl.querySelectorAll('.agent-picker-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const value = opt.dataset.value;
      const piModel = value === 'pi' ? (opt.dataset.piModel || null) : null;
      hiddenInput.value = value;
      hiddenInput.dataset.piModel = piModel || '';
      pickerEl.dataset.piModel = piModel || '';
      pickerEl.querySelectorAll('.agent-picker-option').forEach(o => o.classList.toggle('active', o === opt));
      const icon = value ? _agentPickerIcon(value) : '';
      const label = opt.querySelector('span')?.textContent || _AGENT_PICKER_LABELS[value] || t('agent.unassigned');
      trigger.innerHTML = `${icon}<span class="agent-picker-label">${escapeAttr(label)}</span>${_CARET_SVG}`;
      closeDropdown();
      hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
      if (onChange) onChange(value, { piModel });
    });
  });
}

// Shared controls and caches used by Task Edit, New Task, and bulk actions.

let _cachedProjectTags = null;
let _projectTagsPromise = null;
let _cachedProjectTaskList = null;
let _projectTaskListPromise = null;
// (C1245) New Task form's own project-config cache — mirrors _cachedProjectTags
// (module-lifetime, not reset per open like the task list, since defaults rarely
// change). The edit modal fetches this per modal-open into _modalState.projectConfig
// instead; the New Task form has no equivalent "open" event to hang a fetch off, so
// it gets its own single-flight cache.
let _cachedProjectConfig = null;
let _projectConfigPromise = null;
// (C1245) Dependency chip-input instance for the New Task form — module-level so
// attachNewTaskFormHandlers can destroy() the previous one before creating a new
// one on every loadAndRender() re-render (the factory leaks a resize listener +
// a body-portaled dropdown otherwise).
let _newTaskDepsInput = null;
// (C1251) Member combo-box instance for the New Task form — same reason as
// _newTaskDepsInput above: destroy() the previous one before wiring a new one
// on every loadAndRender() re-render, or its resize listener + portaled
// dropdown leak.
let _newTaskMemberCombo = null;

let _imagePasteWs = null;
const _imagePasteTargets = new Map();

const _memberCache = createMemberCache({
  fetchMembers: () => api.members.list(),
  normalize: _normalizeProjectMember,
});

export async function ensureProjectMembers() {
  state.projectMembers = await _memberCache.ensure();
  return state.projectMembers;
}

// (C1520) Always hits the network (joining an in-flight request rather than firing
// a second one) and resolves the `changed` boolean so a caller only needs to repaint
// when the member list actually differs — the cached list stays rendered meanwhile.
// Deliberately NOT wired into _createMemberCombobox's init: that factory is
// recreated on every loadAndRender() for the New Task form (see its own header
// comment), so a revalidate there would fire one GET per board re-render. Instead
// called from user-intent moments only: the member combo-box's `focus` handler
// (both Task Edit Modal and New Task form instances), the bulk
// `.bulk-assignee-picker`'s `focus` handler, and every Task Edit Modal open.
export async function refreshProjectMembers() {
  const { members, changed } = await _memberCache.revalidate();
  state.projectMembers = members;
  return changed;
}

// (C1251) Member Assignee typeahead combo-box — replaces the old plain
// `<select>`. Shared by the Task Edit Modal and the New Task form; see
// _createMemberCombobox below for the behavior factory.

// API mode returns project-membership rows, while Electron IPC and older
// backends can still return the pre-normalized shape. Keep one client-side
// contract so either transport renders the same member identity.
function _normalizeProjectMember(member) {
  if (!member || typeof member !== 'object') return null;
  const id = member.user_id != null ? member.user_id
    : member.userId != null ? member.userId
      : member.user_id === undefined && member.userId === undefined && member.status !== 'pending'
        ? member.id ?? null
        : null;
  const name = [member.name, member.display_name, member.displayName, member.email]
    .find(value => typeof value === 'string' && value.trim())?.trim() || '';
  const avatarUrl = member.avatar_url ?? member.avatarUrl ?? null;
  return {
    ...member,
    id,
    user_id: id,
    name,
    display_name: name,
    avatar_url: avatarUrl,
    avatarUrl,
  };
}

function _memberId(member) {
  if (!member || typeof member !== 'object') return null;
  return member.user_id != null ? member.user_id
    : member.userId != null ? member.userId
      : member.user_id === undefined && member.userId === undefined && member.status !== 'pending'
        ? member.id ?? null
        : null;
}

function _memberForAssignee(id) {
  if (id == null) return null;
  const members = Array.isArray(state.projectMembers) ? state.projectMembers : [];
  return members
    .map(_normalizeProjectMember)
    .find(member => member && member.id != null && Number(member.id) === Number(id)) || null;
}

// Pending invites (user_id/name null) never resolve to a real assignee — same
// filter the old select used.
function _acceptedMembers() {
  const members = Array.isArray(state.projectMembers) ? state.projectMembers : [];
  return members
    .map(_normalizeProjectMember)
    .filter(member => member?.id != null && member.name);
}

// Resolves an assignee id to its display label. Falls back to `#<id>` when the
// id doesn't match any loaded member (member removed, members not yet fetched,
// file backend which never has members) — a blank field would read as
// "unassigned", which is wrong; the id is at least honest.
function _memberLabelFor(id) {
  if (id == null) return '';
  const member = _memberForAssignee(id);
  return member ? member.name : `#${id}`;
}

function _memberAvatarHtml(member) {
  const name = member?.name || '';
  const title = escapeAttr(name);
  const initial = escapeAttr(name.trim()[0]?.toUpperCase() || '?');
  const avatarUrl = member?.avatarUrl ?? member?.avatar_url;
  if (avatarUrl) {
    return `<img class="member-avatar" src="${escapeAttr(avatarUrl)}" alt="${title}" referrerpolicy="no-referrer" loading="lazy" onerror="this.outerHTML='<span class=\\'member-avatar member-avatar--initials\\'>${initial}</span>'">`;
  }
  return `<span class="member-avatar member-avatar--initials">${initial}</span>`;
}

// Selected-value renderer shared by the edit modal and New Task form. The
// hidden input continues to carry the numeric ID; this markup is display-only.
// A loaded member always wins over the numeric fallback. `#<id>` is reserved
// for a task whose old assignee no longer exists in the current member list.
export function renderAssigneeSelection(member, id = null) {
  const name = member?.name || '';
  if (member && name) {
    return `${_memberAvatarHtml(member)}<span class="assignee-combobox-selection-name">${escapeAttr(name)}</span>`;
  }
  if (id != null) {
    return `<span class="assignee-combobox-selection-fallback">${escapeAttr(`#${id}`)}</span>`;
  }
  return `<span class="assignee-combobox-selection-empty">${escapeAttr(t('common.none'))}</span>`;
}

function _renderMemberCombobox({ id, assignee, disabled = false }) {
  const member = _memberForAssignee(assignee);
  return `<div class="member-combo" data-id="${id}">
    <div class="assignee-combobox-selection" aria-hidden="true" title="${escapeAttr(member?.name || (assignee == null ? t('common.none') : `#${assignee}`))}">${renderAssigneeSelection(member, assignee)}</div>
    <input class="member-combo-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-options" autocomplete="off" placeholder="${escapeAttr(t('field.searchMembers'))}" value="${escapeAttr(_memberLabelFor(assignee))}"${disabled ? ' disabled' : ''}>
    <input type="hidden" class="member-combo-value" value="${assignee ?? ''}">
  </div>`;
}

// Unlike the dependency-chip input, this persistent field mirrors committed text,
// opens the full list on focus, and consumes Escape while its menu is open.
// opts supplies getValue():number|null, setValue(id|null), isAlive():boolean,
// onUpdate(), scrollEl, onResizeHandler(fn), and optional isDisabled():boolean.
// Returns { destroy, refresh, setDisabled, close }.
function _createMemberCombobox(root, opts) {
  const { getValue, setValue, isAlive, scrollEl, onResizeHandler, onUpdate } = opts;
  const isDisabled = opts.isDisabled || (() => false);
  const combo = root.querySelector('.member-combo');
  const input = combo?.querySelector('.member-combo-input');
  const valueInput = combo?.querySelector('.member-combo-value');
  const selection = combo?.querySelector('.assignee-combobox-selection');
  if (!combo || !input || !valueInput) return { destroy() {}, refresh() {}, setDisabled() {}, close() {} };

  let dropdown = null;
  let options = [];
  let activeIndex = -1;
  let blurTimer = null;

  function syncLabel() {
    const id = getValue();
    const member = _memberForAssignee(id);
    input.value = member?.name || (id == null ? '' : `#${id}`);
    if (selection) {
      selection.innerHTML = renderAssigneeSelection(member, id);
      selection.classList.toggle('assignee-combobox-selection--empty', id == null);
      selection.title = member?.name || (id == null ? t('common.none') : `#${id}`);
    }
  }

  function positionDropdown() {
    if (!dropdown) return;
    const r = combo.getBoundingClientRect();
    dropdown.style.top = `${input.getBoundingClientRect().bottom + 2}px`;
    dropdown.style.left = `${r.left}px`;
    dropdown.style.width = `${Math.max(r.width, 180)}px`;
  }

  const onScrollOrResize = () => positionDropdown();
  if (scrollEl) scrollEl.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  if (onResizeHandler) onResizeHandler(onScrollOrResize);

  function buildOptions(query) {
    const q = query.trim().toLowerCase();
    const none = { id: null, name: t('common.none') };
    const matches = _acceptedMembers().filter(m => m.name.toLowerCase().includes(q));
    // (none) is always offered, never filtered — otherwise there is no keyboard
    // path to unassign once any text has been typed.
    return [none, ...matches];
  }

  function updateDropdownActive() {
    if (!dropdown) return;
    dropdown.querySelectorAll('.member-typeahead-option').forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
    });
  }

  function onDropdownMousedown(e) {
    const opt = e.target.closest('.member-typeahead-option');
    if (!opt) return;
    e.preventDefault(); // keep focus on the input — don't let the click blur it first
    const entry = options[Number(opt.dataset.index)];
    if (entry) commit(entry);
  }

  // (C1520) `preserveActive` keeps the arrow-key highlight (and scroll position)
  // steady across a repaint triggered by an async membership re-check — without
  // it, every rebuild snaps `activeIndex` back to 0 (`(none)`), yanking the row a
  // user has already arrowed down to out from under them.
  function renderDropdown({ preserveActive = false } = {}) {
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.className = 'member-typeahead-dropdown';
      dropdown.id = `${combo.dataset.id}-options`;
      dropdown.addEventListener('mousedown', onDropdownMousedown);
      document.body.appendChild(dropdown);
    }
    const priorId = (preserveActive && activeIndex >= 0) ? (options[activeIndex]?.id ?? null) : undefined;
    const priorScroll = dropdown.scrollTop;
    options = buildOptions(input.value);
    activeIndex = options.length ? 0 : -1;
    if (priorId !== undefined) {
      const restored = options.findIndex(o => (o.id ?? null) === priorId);
      if (restored >= 0) activeIndex = restored;
    }
    dropdown.innerHTML = options.length
      ? options.map((m, i) => `<div class="member-typeahead-option" data-index="${i}">${m.id == null ? '' : _memberAvatarHtml(m)}<span>${escapeAttr(m.name)}</span></div>`).join('')
      : `<div class="member-typeahead-empty">${escapeAttr(t('field.noMembers'))}</div>`;
    updateDropdownActive();
    positionDropdown();
    if (preserveActive) dropdown.scrollTop = priorScroll;
  }

  function hideDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    options = [];
    activeIndex = -1;
    input.setAttribute('aria-expanded', 'false');
    combo.classList.remove('assignee-combobox--open');
  }

  function openDropdown() {
    if (isDisabled()) return;
    input.setAttribute('aria-expanded', 'true');
    combo.classList.add('assignee-combobox--open');
    renderDropdown();
  }

  function commit(entry) {
    setValue(entry.id);
    valueInput.value = entry.id ?? '';
    syncLabel();
    hideDropdown();
    onUpdate();
  }

  input.addEventListener('focus', () => {
    if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
    // (C1297) Clear the committed label BEFORE opening — otherwise it is handed
    // to buildOptions() as the query and filters the list to near-nothing. The
    // focused field reads as a plain search box (placeholder shows); blur,
    // Escape, or a commit restores the label via syncLabel().
    input.value = '';
    openDropdown();
    // (C1520) Re-check membership on every open — single-flight, and this is the
    // moment the user can actually pick someone, so a teammate added via the web
    // app becomes assignable without reloading the window. Repaint only on a real
    // change, only while this same dropdown is still open and focused, and
    // preserve the arrow-key row — a late response must never yank an open list
    // or reset a mid-typed query (buildOptions() re-reads input.value).
    void refreshProjectMembers().then((changed) => {
      if (!changed || !isAlive() || !dropdown || document.activeElement !== input) return;
      renderDropdown({ preserveActive: true });
    });
  });

  input.addEventListener('click', () => { if (!dropdown) openDropdown(); });

  input.addEventListener('input', () => { renderDropdown(); });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!dropdown) { openDropdown(); return; }
      if (options.length) { activeIndex = (activeIndex + 1) % options.length; updateDropdownActive(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (dropdown && options.length) { activeIndex = (activeIndex - 1 + options.length) % options.length; updateDropdownActive(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (dropdown && options.length && activeIndex >= 0) commit(options[activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (dropdown) {
        // Dropdown open: close it and stop the keypress from also reaching
        // template.html's document-level Escape listener, which would close
        // the whole modal (and prompt "Discard unsaved changes?").
        e.stopPropagation();
        syncLabel();
        hideDropdown();
      } else {
        // Dropdown already closed: blur so a second Escape closes the modal —
        // matches the title/description field behavior elsewhere in this modal.
        e.stopPropagation();
        syncLabel();
        input.blur();
      }
    }
  });

  input.addEventListener('blur', () => {
    blurTimer = setTimeout(() => {
      if (!isAlive()) return;
      hideDropdown();
      syncLabel();
    }, 150);
  });

  function refresh() {
    setDisabled(isDisabled());
    if (document.activeElement !== input) syncLabel();
    else if (dropdown) renderDropdown({ preserveActive: true });
  }

  function setDisabled(v) {
    input.disabled = !!v;
    combo.classList.toggle('assignee-combobox--disabled', !!v);
    if (v) hideDropdown();
  }

  function destroy() {
    hideDropdown();
    if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
    if (scrollEl) scrollEl.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize);
  }

  syncLabel();
  setDisabled(isDisabled());
  // Members load async; the boot-time ensureProjectMembers() call (template.html)
  // usually already resolved this by the time the modal opens, but this covers
  // the cold-boot / retry case without every host needing its own fetch+refresh.
  void ensureProjectMembers().then(() => { if (isAlive()) refresh(); });

  return { destroy, refresh, setDisabled, close: hideDropdown };
}

function _projectTagName(tag) {
  return tagName(tag);
}

async function _ensureProjectTags() {
  if (Array.isArray(_cachedProjectTags)) return _cachedProjectTags;
  if (_projectTagsPromise) return _projectTagsPromise;
  _projectTagsPromise = api.tags.listProject()
    .then(rawTags => {
      const tags = (rawTags || []).filter(tag => _projectTagName(tag));
      tags.forEach(tag => {
        if (typeof tag !== 'string' && tag.description !== undefined) {
          state.tagDescriptions.set(tag.name, tag.description || null);
        }
      });
      _cachedProjectTags = tags;
      return _cachedProjectTags;
    })
    .catch(() => {
      _cachedProjectTags = [];
      return _cachedProjectTags;
    })
    .finally(() => {
      _projectTagsPromise = null;
    });
  return _projectTagsPromise;
}

// Slim project task list ({id, title, status}) for the modal's dependency
// typeahead. Reset per modal-open (unlike tags) since tasks change often.
async function _ensureProjectTaskList() {
  if (Array.isArray(_cachedProjectTaskList)) return _cachedProjectTaskList;
  if (_projectTaskListPromise) return _projectTaskListPromise;
  _projectTaskListPromise = api.tasks.listAll()
    .then(tasks => {
      _cachedProjectTaskList = tasks || [];
      return _cachedProjectTaskList;
    })
    .catch(() => {
      _cachedProjectTaskList = [];
      return _cachedProjectTaskList;
    })
    .finally(() => {
      _projectTaskListPromise = null;
    });
  return _projectTaskListPromise;
}

// (TPT111) Dependency index for the modal, before/without a resolved project task list.
// Falls back to state.taskStatusById — the same Map<id,status> unmetDependencyKeys()
// already defaults to, and the one renderCard()/isDepsBlocked() gate the board CARD on
// (task-card.js). Using it here keeps the modal's first paint (which no longer awaits
// _ensureProjectTaskList(), see openTaskEditModal) consistent with the card the user just
// double-clicked, rather than briefly showing Start as enabled on a blocked task.
function _projectTaskIndex() {
  return Array.isArray(_cachedProjectTaskList) ? _cachedProjectTaskList : state.taskStatusById;
}

async function _ensureProjectConfig() {
  if (_cachedProjectConfig) return _cachedProjectConfig;
  if (_projectConfigPromise) return _projectConfigPromise;
  _projectConfigPromise = fetch('/api/config')
    .then(res => (res.ok ? res.json() : {}))
    .then(cfg => { _cachedProjectConfig = cfg || {}; return _cachedProjectConfig; })
    .catch(() => { _cachedProjectConfig = {}; return _cachedProjectConfig; })
    .finally(() => { _projectConfigPromise = null; });
  return _projectConfigPromise;
}

// Looks up a task's title for a dependency chip — checks the cached project task list
// first, then callbacks.depCandidates (sibling chat proposals, preview mode), then
// (TPT111) state.taskTitleById so a chip still gets a tooltip before the project task
// list round-trip lands. Board-snapshot fallback is last on purpose: it must never
// override a `modified` proposal's own proposed title in preview mode.
function _readFileBase64(file) {
  console.debug('[uploadImage] start', file?.name, file?.size);
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = e => {
      const result = String(e.target.result || '').split(',')[1] || '';
      console.debug('[uploadImage] encoded', result.length, 'chars');
      resolve(result);
    };
    r.onerror = () => reject(new Error('Read failed'));
    r.readAsDataURL(file);
  });
}

function _imageExtension(mimeType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
  };
  if (map[mimeType]) return map[mimeType];
  const raw = String(mimeType || '').split('/')[1] || 'png';
  return raw.replace(/[^a-z0-9]+/gi, '').toLowerCase() || 'png';
}

function _randomImageId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function _getImagePasteWs() {
  if (_imagePasteWs && (_imagePasteWs.readyState === WebSocket.OPEN || _imagePasteWs.readyState === WebSocket.CONNECTING)) {
    return _imagePasteWs;
  }
  _imagePasteWs = new WebSocket(buildWsUrl('__board__'));
  _imagePasteWs.addEventListener('message', _handleImagePasteWsMessage);
  _imagePasteWs.addEventListener('close', () => { _imagePasteWs = null; });
  _imagePasteWs.addEventListener('error', () => {});
  return _imagePasteWs;
}

function _sendImagePasteUpload(message, wsClient) {
  const ws = wsClient || _getImagePasteWs();
  const send = () => ws.send(JSON.stringify(message));
  if (ws.readyState === WebSocket.OPEN) {
    send();
  } else if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener('open', send, { once: true });
  } else {
    throw new Error(t('common.errUploadSocket'));
  }
}

export function syncKb() {
  showToast(t('toast.syncingKb'));
  try { _sendImagePasteUpload({ type: 'sync-kb' }); }
  catch (err) { showToast(err.message || t('toast.syncSocketNotConnected'), 'error'); }
}

// C1040 — Knowledge Base > Re-Index. A single persistent toast tracks progress frames
// (`_reindexKbToast`, module-scope so `_handleImagePasteWsMessage` below can update the
// same element) instead of the fire-and-forget toast `syncKb()` uses — a run takes
// minutes, not seconds.
let _reindexKbToast = null;

export function reindexKb() {
  _reindexKbToast = showProgressToast(t('toast.reindexingKb'));
  try { _sendImagePasteUpload({ type: 'reindex-kb' }); }
  catch (err) {
    _reindexKbToast.fail(err.message || t('toast.syncSocketNotConnected'));
    _reindexKbToast = null;
  }
}

function _replaceImageBlobUrl(blobUrl, url) {
  const target = _imagePasteTargets.get(blobUrl);
  let replaced = false;
  if (target?.textarea?.isConnected && target.textarea.value.includes(blobUrl)) {
    target.textarea.value = target.textarea.value.split(blobUrl).join(url);
    target.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    replaced = true;
  }
  if (!replaced) replaceModalImageBlobUrl(blobUrl, url);
  console.debug('[uploadImage] done', url);
  if (target?.onUploaded) {
    try {
      target.onUploaded(target.file, url, blobUrl);
    } catch (err) {
      console.error('[uploadImage] upload callback failed', err);
    }
  }
  URL.revokeObjectURL(blobUrl);
  _imagePasteTargets.delete(blobUrl);
}

function _reportImagePasteError(target, err) {
  console.error('[uploadImage] failed', err);
  if (target?.onUploadError) {
    try {
      target.onUploadError(target.file, err);
      return;
    } catch (callbackErr) {
      console.error('[uploadImage] error callback failed', callbackErr);
    }
  }
  showToast(t('common.errImageUpload', { msg: err.message || 'Upload failed' }), 'error');
}

// C1218 — shared by both board sockets: this file's own image-paste socket
// (`_handleImagePasteWsMessage` below, the ONLY board socket Electron ever opens — see
// template.html's connectBoardWs() guard) and template.html's main connectBoardWs()
// onmessage (browser mode). One handler means an auto-fired reindex toast looks and
// behaves identically regardless of which trigger fired it or which socket delivered the
// frame. Returns true when it consumed the message, so a caller can `if (handleKbWsMessage(msg)) return;`.
export function handleKbWsMessage(msg) {
  switch (msg && msg.type) {
    case 'sync-kb-result':
      if (msg.success) showToast(t('toast.kbSynced', { pushed: msg.pushed, pulled: msg.pulled }), 'success');
      else showToast(msg.error || t('toast.kbSyncFailed'), 'error');
      return true;

    case 'reindex-kb-auto': {
      // Auto-fired run detected — distinct opening toast from the manual reindexKb()'s
      // toast.reindexingKb, so an auto run never looks user-initiated. `||=` guards a
      // frame arriving on a socket that only just (re)connected mid-run.
      // (C1230) msg.forced: a once-per-project force run skips the stale-count detect
      // (server-side manual:true), so staleCount/tagCount/fileCount are always 0 here —
      // "Found 0 stale descriptions" would be misleading. Use the dedicated copy instead.
      // (C1244) msg.linkOnly: a link-only run (tags.knowledge_file_id repair, H96)
      // also has staleCount:0 — same problem, different dedicated copy. forced still
      // wins if somehow both are true (a forced run reports zero counts by design).
      const linkOnly = !msg.forced && !(msg.staleCount || 0) && (msg.linkOnlyCount || 0) > 0;
      if (!_reindexKbToast) {
        _reindexKbToast = showProgressToast(msg.forced
          ? t('toast.forceReindexStarted')
          : linkOnly
            ? tc('toast.autoLinkRepairDetected', msg.linkOnlyCount)
            : tc('toast.autoReindexDetected', msg.staleCount ?? 0, { tags: msg.tagCount, files: msg.fileCount }));
      }
      return true;
    }

    case 'reindex-kb-joined':
      _reindexKbToast?.update(t('toast.reindexAlreadyRunning'));
      return true;

    case 'reindex-kb-progress':
      if (!_reindexKbToast && msg.auto) _reindexKbToast = showProgressToast(t('toast.reindexingKb'));
      _reindexKbToast?.update(t('toast.reindexProgress', { phase: msg.phase, done: msg.done, total: msg.total }));
      return true;

    case 'reindex-kb-result': {
      if (!_reindexKbToast && msg.auto) _reindexKbToast = showProgressToast(t('toast.reindexingKb'));
      if (_reindexKbToast) {
        if (msg.success) {
          const n = (msg.tagsUpdated || 0) + (msg.filesUpdated || 0);
          // (C1244) A link-only run's own tags_updated count reflects the DB link repair,
          // not a description change — "N descriptions updated" would misdescribe it.
          const linkOnly = msg.auto && !(msg.staleCount || 0) && (msg.linkOnlyCount || 0) > 0;
          _reindexKbToast.done(linkOnly
            ? tc('toast.autoLinkRepaired', msg.linkOnlyCount)
            : msg.auto
              ? tc('toast.autoReindexed', n, { tags: msg.tagsUpdated, files: msg.filesUpdated })
              : t('toast.kbReindexed', { tags: msg.tagsUpdated, files: msg.filesUpdated }));
        } else {
          _reindexKbToast.fail(msg.error || t(msg.auto ? 'toast.autoReindexFailed' : 'toast.kbReindexFailed'));
        }
        _reindexKbToast = null;
      }
      if (msg.success && Array.isArray(msg.errors) && msg.errors.length) {
        console.warn('[reindexKb] completed with per-item errors:', msg.errors);
      }
      return true;
    }

    default:
      return false;
  }
}

function _handleImagePasteWsMessage(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.type === 'image-uploaded' && msg.blobUrl && msg.url) {
    _replaceImageBlobUrl(msg.blobUrl, msg.url);
  } else if (msg.type === 'image-upload-error' && msg.blobUrl) {
    const target = _imagePasteTargets.get(msg.blobUrl);
    const err = new Error(msg.error || 'Upload failed');
    err.status = msg.status;
    URL.revokeObjectURL(msg.blobUrl);
    _imagePasteTargets.delete(msg.blobUrl);
    if (target?.textarea?.isConnected) target.textarea.focus();
    _reportImagePasteError(target, err);
  } else {
    handleKbWsMessage(msg);
  }
}

function _getClipboardFiles(clipboardData) {
  const files = Array.from(clipboardData?.files || []).filter(Boolean);
  if (files.length) return files;
  return Array.from(clipboardData?.items || [])
    .filter(i => i.kind === 'file')
    .map(i => i.getAsFile())
    .filter(Boolean);
}

export function attachImagePaste(textarea, wsClient = null, opts = {}) {
  if (!textarea || textarea._imagePasteAttached) return;
  textarea._imagePasteAttached = true;
  textarea.addEventListener('paste', (e) => {
    const pastedFiles = _getClipboardFiles(e.clipboardData);
    const files = [];
    pastedFiles.forEach(file => {
      if (file.type && file.type.startsWith('image/')) {
        if (opts.onFileDetected) opts.onFileDetected(file);
        files.push(file);
      } else if (opts.onFileSkipped) {
        opts.onFileSkipped(file);
      }
    });
    if (!files.length) return;
    e.preventDefault();
    files.forEach(async (file) => {
      const blobUrl = URL.createObjectURL(file);
      _imagePasteTargets.set(blobUrl, {
        textarea,
        file,
        onUploaded: opts.onUploaded,
        onUploadError: opts.onUploadError,
      });
      insertAtCursor(textarea, `![img](${blobUrl})`);
      try {
        const data = await _readFileBase64(file);
        _sendImagePasteUpload({
          type: 'upload-image',
          blobUrl,
          filename: `${_randomImageId()}.${_imageExtension(file.type)}`,
          mimeType: file.type,
          data,
          taskKey: opts.taskKey || null,
        }, wsClient);
      } catch (err) {
        URL.revokeObjectURL(blobUrl);
        const target = _imagePasteTargets.get(blobUrl);
        _imagePasteTargets.delete(blobUrl);
        _reportImagePasteError(target, err);
      }
    });
  });
}

export function uploadImageFile(file, textarea, wsClient = null, opts = {}) {
  if (!file || !file.type || !file.type.startsWith('image/')) {
    if (opts.onFileSkipped) opts.onFileSkipped(file);
    return;
  }
  if (opts.onFileDetected) opts.onFileDetected(file);
  const blobUrl = URL.createObjectURL(file);
  _imagePasteTargets.set(blobUrl, {
    textarea,
    file,
    onUploaded: opts.onUploaded,
    onUploadError: opts.onUploadError,
  });
  insertAtCursor(textarea, `![img](${blobUrl})`);
  (async () => {
    try {
      const data = await _readFileBase64(file);
      _sendImagePasteUpload({
        type: 'upload-image',
        blobUrl,
        filename: `${_randomImageId()}.${_imageExtension(file.type)}`,
        mimeType: file.type,
        data,
        taskKey: opts.taskKey || null,
      }, wsClient);
    } catch (err) {
      URL.revokeObjectURL(blobUrl);
      const target = _imagePasteTargets.get(blobUrl);
      _imagePasteTargets.delete(blobUrl);
      _reportImagePasteError(target, err);
    }
  })();
}

// Notifications-tab-less proposal/preview modal (no checkbox in the DOM) is a silent no-op.
function _depTitleFor(key, candidates = []) {
  const list = Array.isArray(_cachedProjectTaskList) ? _cachedProjectTaskList : [];
  const found = list.find(task => task.id === key) || candidates.find(task => task.id === key);
  return found?.title || state.taskTitleById.get(key) || '';
}

function _createDepsChipInput(root, opts) {
  const { getDeps, setDeps, getExcludedIds, getCandidates, isAlive, scrollEl, onResizeHandler, onUpdate } = opts;
  const getCycleRoots = opts.getCycleRoots || getExcludedIds;
  const depsDiv = root.querySelector('.modal-deps');
  const input   = root.querySelector('.modal-dep-input');
  if (!depsDiv || !input) return { destroy() {}, refreshChips() {} };
  let dropdown = null;
  let options = [];
  let activeIndex = -1;
  let blurTimer = null;

  function positionDropdown() {
    if (!dropdown) return;
    const inputR = input.getBoundingClientRect();
    const rowR = depsDiv.getBoundingClientRect();
    dropdown.style.top   = `${inputR.bottom + 2}px`;
    dropdown.style.left  = `${rowR.left}px`;
    dropdown.style.width = `${rowR.width}px`;
  }

  const onScrollOrResize = () => positionDropdown();
  if (scrollEl) scrollEl.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  if (onResizeHandler) onResizeHandler(onScrollOrResize);

  function refreshChips() {
    depsDiv.querySelectorAll('.modal-dep-chip').forEach(c => c.remove());
    const frag = document.createDocumentFragment();
    getDeps().forEach(key => {
      const span = document.createElement('span');
      span.className = 'dep-chip modal-dep-chip';
      span.dataset.dep = key;
      const title = _depTitleFor(key, getCandidates());
      if (title) span.title = title;
      span.innerHTML = `${escapeAttr(key)}<button class="chip-remove" type="button" data-dep="${escapeAttr(key)}">&times;</button>`;
      frag.appendChild(span);
    });
    depsDiv.insertBefore(frag, input);
  }

  function hideDropdown() {
    if (dropdown) dropdown.remove();
    dropdown = null;
    options = [];
    activeIndex = -1;
  }

  function updateDropdownActive() {
    if (!dropdown) return;
    dropdown.querySelectorAll('.dep-typeahead-option').forEach((option, i) => {
      option.classList.toggle('active', i === activeIndex);
    });
  }

  function addDep(key) {
    if (!key) return;
    const deps = getDeps();
    if (deps.some(d => d.toLowerCase() === key.toLowerCase())) { input.value = ''; hideDropdown(); return; }
    setDeps([...deps, key]);
    refreshChips();
    input.value = '';
    hideDropdown();
    onUpdate();
  }

  function selectOption(index) {
    const entry = options[index];
    if (!entry?.id) return;
    addDep(entry.id);
  }

  function renderDropdown() {
    if (!options.length) {
      hideDropdown();
      return;
    }
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.className = 'dep-typeahead-dropdown';
      document.body.appendChild(dropdown);
    }
    dropdown.innerHTML = options.map((entry, i) =>
      `<div class="dep-typeahead-option${i === activeIndex ? ' active' : ''}" data-index="${i}">${escapeAttr(entry.id)}<small>${escapeAttr(entry.title || '')}</small></div>`
    ).join('');
    dropdown.querySelectorAll('.dep-typeahead-option').forEach(option => {
      option.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectOption(Number(option.dataset.index));
      });
    });
    positionDropdown();
  }

  // Candidates = cached project task list + getCandidates() (sibling chat
  // proposals in preview mode, including not-yet-persisted new-* ids).
  async function refreshDropdown() {
    const query = input.value.trim().toLowerCase();
    if (!query) {
      hideDropdown();
      return;
    }
    const list = await _ensureProjectTaskList();
    if (!isAlive()) return;
    if (query !== input.value.trim().toLowerCase()) {
      void refreshDropdown();
      return;
    }
    const candidates = getCandidates();
    const excluded = new Set(getExcludedIds());
    const selected = new Set(getDeps().map(d => d.toLowerCase()));
    const seen = new Set();
    // C1093: candidates that already (transitively) depend on a root would close a
    // cycle if picked — silently dropped, same treatment as completed/canceled below.
    const graph = buildDepGraph(list);
    const cycleBlocked = collectCycleBlocked(graph, getCycleRoots());
    options = [...list, ...candidates]
      .filter(entry => {
        if (!entry?.id || seen.has(entry.id)) return false;
        if (excluded.has(entry.id)) return false;
        if (selected.has(entry.id.toLowerCase())) return false;
        if (isClosedName(entry.status)) return false;
        if (cycleBlocked.has(entry.id.toLowerCase())) return false;
        const idMatch = entry.id.toLowerCase().includes(query);
        const titleMatch = (entry.title || '').toLowerCase().includes(query);
        if (!idMatch && !titleMatch) return false;
        seen.add(entry.id);
        return true;
      })
      .slice(0, 8);
    activeIndex = options.length ? 0 : -1;
    renderDropdown();
  }

  function onChipClick(e) {
    const btn = e.target.closest('.chip-remove');
    if (!btn) return;
    const key = btn.dataset.dep;
    setDeps(getDeps().filter(d => d !== key));
    refreshChips();
    void refreshDropdown();
    onUpdate();
  }
  depsDiv.addEventListener('click', onChipClick);

  function onInput() {
    void refreshDropdown();
  }
  input.addEventListener('input', onInput);

  function onKeydown(e) {
    if (e.key === 'ArrowDown' && options.length) {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % options.length;
      updateDropdownActive();
    } else if (e.key === 'ArrowUp' && options.length) {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + options.length) % options.length;
      updateDropdownActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // No free-text add — a dependency must resolve to a real task/proposal.
      if (options.length && activeIndex >= 0) selectOption(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideDropdown();
    } else if (e.key === 'Backspace' && !input.value && getDeps().length) {
      setDeps(getDeps().slice(0, -1));
      refreshChips();
      void refreshDropdown();
      onUpdate();
    }
  }
  input.addEventListener('keydown', onKeydown);

  function onBlur() {
    blurTimer = setTimeout(hideDropdown, 50);
  }
  input.addEventListener('blur', onBlur);

  function onFocus() {
    if (blurTimer) clearTimeout(blurTimer);
    void refreshDropdown();
  }
  input.addEventListener('focus', onFocus);

  // Warm the task-list cache so existing-dep chips get their hover tooltip on
  // open (chip text itself is always key-only; cache is nulled per modal-open
  // by design, C1077).
  if (getDeps().length) {
    void _ensureProjectTaskList().then(() => {
      if (isAlive()) refreshChips();
    });
  }

  function destroy() {
    hideDropdown();
    if (blurTimer) clearTimeout(blurTimer);
    if (scrollEl) scrollEl.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize);
    depsDiv.removeEventListener('click', onChipClick);
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeydown);
    input.removeEventListener('blur', onBlur);
    input.removeEventListener('focus', onFocus);
  }

  return { destroy, refreshChips };
}

// Edit-modal binding for the dependency chip input — keeps the pre-C1076 name
// and signature so its call site and closeTaskEditModal's cleanup need no edit.
// Behavior is byte-for-byte the C1074/C1077 implementation, just routed
// through _modalState via the generic factory above.
// No getCycleRoots override (C1093): the factory default (getCycleRoots =
// getExcludedIds = [draft.id]) is already correct here.
export function saveNewTaskDraft() {
  const s = state.manualTaskState;
  if (!s || s.phase !== 'form') return;
  const d = _manualTaskStateFields(); // defaults, for the "is this a pristine form" check
  const isDefault = !(s.title || '').trim() && !(s.description || '').trim() && !s.priority
    && (s.tags || []).length === 0 && (s.type || 'task') === d.type && (s.category || 'CODING') === d.category
    && s.status === d.status && !s.agentAssignee && (s.assignee ?? null) === (d.assignee ?? null)
    && !s.claudeModel && !s.codexModel && !s.piModel && !s.effort && !s.claudeDesignMode
    && (s.dependencies || []).length === 0;
  if (isDefault) { clearDraft(DRAFT_KEY_TASK); return; }
  const { title, description, priority, type, tags, category, status, agentAssignee, assignee, claudeModel, codexModel, piModel, effort, claudeDesignMode, dependencies } = s;
  saveDraft(DRAFT_KEY_TASK, { title, description, priority, type, tags, category, status, agentAssignee, assignee, claudeModel, codexModel, piModel, effort, claudeDesignMode, dependencies });
}

// (C1245) Wires the New Task form's status/category/agent/model/design-mode/member/
// dependencies rows — everything renderNewTaskForm's form phase adds beyond the
// pre-existing title/desc/sprint/type/tags fields (those stay owned by template.html).
// Called once per loadAndRender() pass (same as every other handler block in that
// function) against the freshly-rendered #new-task-form. Resolve #new-task-fields
// inside it so layout wrappers can change without leaking selectors outside the form.
export function attachNewTaskFormHandlers(root, { onRerender } = {}) {
  const isFirstMount = _newTaskDepsInput === null;
  if (_newTaskDepsInput) { _newTaskDepsInput.destroy(); _newTaskDepsInput = null; }
  if (_newTaskMemberCombo) { _newTaskMemberCombo.destroy(); _newTaskMemberCombo = null; }
  if (!root) return;
  const fieldsRoot = root.matches('#new-task-fields') ? root : root.querySelector('#new-task-fields');
  if (!fieldsRoot) return;
  // Tasks change often — refetch once per tab entry, not once per WS-driven re-render.
  if (isFirstMount) _cachedProjectTaskList = null;

  const draft = () => ensureManualTaskState();

  const statusSel = fieldsRoot.querySelector('.modal-status-select');
  if (statusSel) statusSel.addEventListener('change', () => {
    draft().status = statusSel.value;
    saveNewTaskDraft();
  });

  const categorySel = fieldsRoot.querySelector('.new-task-category-select');
  if (categorySel) categorySel.addEventListener('change', () => {
    const st = draft();
    st.category = categorySel.value;
    // Mirrors the API's own auto-stamp (POST /tasks: agent_assignee defaults to
    // 'human' for an unassigned HUMAN-category task) so the picker doesn't lie.
    st.agentAssignee = st.category === 'HUMAN' ? 'human' : '';
    saveNewTaskDraft();
    if (onRerender) onRerender();
  });

  const agentPickerEl = fieldsRoot.querySelector('.agent-picker[data-name="agentAssignee"]');
  if (agentPickerEl) {
    initAgentPicker(agentPickerEl, { onChange: (value, { piModel } = {}) => {
      const st = draft();
      _applyAgentPickerSelection(st, value, { piModel }, '');
      _applyModalAgentModelVisibility(fieldsRoot, value || '', st, _cachedProjectConfig || {});
      saveNewTaskDraft();
    } });
  }

  // Member assignee — same combo-box factory as the edit modal (C1251). The
  // factory fetches/refreshes projectMembers itself, so the C1245 cold-boot
  // fetch this used to need here is no longer required.
  _newTaskMemberCombo = _createMemberCombobox(fieldsRoot, {
    getValue: () => draft().assignee ?? null,
    setValue: (id) => { draft().assignee = id; },
    isAlive: () => fieldsRoot.isConnected,
    scrollEl: document, // New Task tab scrolls the page, not an overlay
    onResizeHandler: () => {}, // destroy() above owns teardown
    onUpdate: saveNewTaskDraft,
  });

  const agentModelSel = fieldsRoot.querySelector('.modal-agent-model-select');
  const designModeCb = fieldsRoot.querySelector('.modal-claude-design-mode');
  if (agentModelSel) agentModelSel.addEventListener('change', () => {
    if (agentModelSel.dataset.agent === 'claude') draft().claudeModel = agentModelSel.value || null;
    if (agentModelSel.dataset.agent === 'codex') draft().codexModel = agentModelSel.value || null;
    saveNewTaskDraft();
  });
  if (designModeCb) designModeCb.addEventListener('change', () => { draft().claudeDesignMode = designModeCb.checked; saveNewTaskDraft(); });
  const effortSel = fieldsRoot.querySelector('.modal-effort-select');
  if (effortSel) effortSel.addEventListener('change', () => { draft().effort = effortSel.value || null; saveNewTaskDraft(); });

  // (TPT95) Same project-level (not draft) persistence as the edit modal — see the
  // comment at that call site for why this never touches draft()/saveNewTaskDraft().
  fieldsRoot.querySelectorAll('.modal-browser-tool').forEach(cb => {
    cb.addEventListener('change', () => {
      const ids = Array.from(fieldsRoot.querySelectorAll('.modal-browser-tool:checked')).map(el => el.value);
      writeProjectBrowserTools(ids);
    });
  });

  // (C1505) Same warm-and-repaint as the edit modal — ensureAgentModels() alongside the
  // existing project-defaults fetch, both feeding one _applyModalAgentModelVisibility() repaint.
  void Promise.all([_ensureProjectConfig(), ensureAgentModels()]).then(([cfg]) => {
    if (!fieldsRoot.isConnected) return;
    const st = draft();
    _applyModalAgentModelVisibility(fieldsRoot, st.agentAssignee || '', st, cfg);
  });

  // Dependencies — third adapter over the host-agnostic factory (edit modal's
  // _attachModalDepsInput and showBulkDepsModal are the other two).
  _newTaskDepsInput = _createDepsChipInput(fieldsRoot, {
    scrollEl: document, // New Task tab scrolls the page, not an overlay
    isAlive: () => fieldsRoot.isConnected,
    getDeps: () => (state.manualTaskState && state.manualTaskState.dependencies) || [],
    setDeps: (next) => { draft().dependencies = next; },
    getExcludedIds: () => [], // no id yet — nothing to exclude
    getCycleRoots: () => [], // nothing can depend on a not-yet-created task
    getCandidates: () => [],
    onResizeHandler: () => {}, // cleanup handled by destroy() above, not window-tracked
    onUpdate: saveNewTaskDraft,
  });
}

// ── Settings modal + theme ──

export function openSettingsModal() {
  document.getElementById('settings-modal')?.classList.add('open');
  _populateSettingsAgentsRow();
  _populateSettingsLanguageSelect();
  _populateSettingsNotificationsRows();
  _populateSettingsDebugRow();
  _populateSettingsVoiceTab();
  _populateSettingsWorkflowTab();
  _populateSettingsMemoryTab();
  _populateSettingsVersionControlTab();
  // (C1305) Re-sync the theme select + palette with the DB every time Settings opens —
  // catches a color_scheme changed elsewhere (web app, another Task App instance) since
  // this window's last read. Fire-and-forget; applyProjectTheme() never throws.
  applyProjectTheme();
}
export function closeSettingsModal() {
  document.getElementById('settings-modal')?.classList.remove('open');
}

// TPT220 — the shipped default theme: 'paper' (TipATask dawn), what a fresh install with no
// project color_scheme, no config.json theme and no stored preference paints. Keep in sync
// with `DEFAULT` in template.html's anti-FOUC IIFE, its static <html data-theme>, and the
// :root block in styles.css — theme-default.test.js guards the mirror.
export const DEFAULT_THEME = 'paper';
// Legacy selector aliases (old value → new value). '' (unset config) → DEFAULT_THEME
// (was 'parchment' before TPT220; still a valid named scheme) — keep in sync with the
// anti-FOUC ALIASES literal in template.html.
const _THEME_ALIASES = { '': DEFAULT_THEME, greenish: 'meadow', blueish: 'arctic', reddish: 'terracotta' };
// C1267 — 9 dark ids; TPT215 adds 'ink' (10). Keep in sync with the DARK literal in template.html's anti-FOUC IIFE.
const _DARK_THEMES = new Set(['mocha', 'ocean', 'ember', 'forest', 'nord', 'rose', 'graphite', 'espresso', 'neon', 'ink']);
// Falls back to DEFAULT_THEME (not '') so every caller — including the two
// #settings-theme-select assignments below — always resolves to a real <option> value.
function _normalizeTheme(v) { return _THEME_ALIASES[v] || v || DEFAULT_THEME; }

// Apply a theme value to <html data-theme> and keep localStorage cache in sync.
// Normalizes legacy aliases and toggles .theme-dark for dark-palette overrides.
function applyThemeClass(val) {
  val = _normalizeTheme(val);
  if (val) {
    document.documentElement.setAttribute('data-theme', val);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  document.documentElement.classList.toggle('theme-dark', _DARK_THEMES.has(val));
  try {
    if (val) localStorage.setItem('tiptask-theme', val);
    else localStorage.removeItem('tiptask-theme');
  } catch { /* ignore */ }
}

// Read theme from the local project config only (Electron: IPC; browser: HTTP GET).
// This is the offline/unconfigured-project fallback cache — see readProjectTheme() below
// for the full resolution order (C1305).
async function _readLocalConfigTheme() {
  try {
    if (window.electronAPI?.api) {
      const ctx = await window.electronAPI.api.project.config();
      return (ctx && ctx.config && ctx.config.theme) || '';
    } else {
      const r = await fetch('/api/project-config', { cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        return (data.config && data.config.theme) || '';
      }
    }
  } catch { /* ignore — fall through */ }
  return '';
}

// Project color_scheme wins unless 'default'; fall back to local config. Never throws.
async function readProjectTheme() {
  try {
    const settings = await api.project.settings();
    const scheme = settings?.colorScheme;
    if (scheme && scheme !== 'default') return scheme;
  } catch { /* ignore — fall through to local config */ }
  return _readLocalConfigTheme();
}

// Persist theme to the local project config without triggering a backend rebind.
// Local mirror/offline-cache write, and the fallback for an unconfigured api project.
function writeProjectTheme(val) {
  try {
    if (window.electronAPI?.api) {
      window.electronAPI.api.project.mergeConfig({ theme: val || '' }).catch(() => {});
    } else {
      fetch('/api/project-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: val || '' }),
      }).catch(() => {});
    }
  } catch { /* ignore */ }
}

// User-initiated theme change: paint immediately, then persist. The project's
// color_scheme is a shared DB value (C1305) — PATCH /api/projects/:id via
// api.project.update(), owner-only on the API side. On failure (403 for a non-owner
// member, offline, etc.) revert the paint + select to the previously-applied theme and
// toast, same pattern as writeProjectGroupLabel(). `prev` is read from <html data-theme>
// (already normalized — applyThemeClass keeps it in sync with the last successful paint)
// rather than threaded through the caller. An unconfigured api project (api.project.update()
// reports it as `{ ok, skipped: true }` → null) falls back to the local config.json write.
async function setTheme(val) {
  const prev = document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
  applyThemeClass(val);
  const sel = document.getElementById('settings-theme-select');
  // Normalized, not raw `val` — the raw legacy/empty value has no matching <option>,
  // which leaves the select showing blank (selectedIndex -1) even though the palette
  // painted correctly (C1267).
  if (sel) sel.value = _normalizeTheme(val);

  if (sel) sel.disabled = true;
  try {
    const project = await api.project.update({ color_scheme: _normalizeTheme(val) });
    if (!project) {
      // No API project configured — { ok, skipped: true } contract. Keep a local theme
      // so the picker still works on an otherwise-unconfigured project.
      writeProjectTheme(val);
    }
  } catch (err) {
    console.error('[settings] Failed to save project color scheme:', err.message);
    applyThemeClass(prev);
    if (sel) sel.value = _normalizeTheme(prev);
    showToast(t('settings.themeSaveFailed', { msg: err.message }), 'error');
  } finally {
    if (sel) sel.disabled = false;
  }
}

// Project-load path: read authoritative theme from project config and apply it.
// Called once on init, again on every project switch, and on every Settings-modal open
// (C1305 — so opening Settings re-syncs with a color_scheme changed elsewhere, e.g. the
// web app or another Task App instance). Never writes.
export async function applyProjectTheme() {
  const val = await readProjectTheme();
  applyThemeClass(val);
  const sel = document.getElementById('settings-theme-select');
  if (sel) sel.value = _normalizeTheme(val); // see setTheme()'s comment above
}

// Read this project's saved `boardFilters` from project config (Electron: IPC,
// re-reads disk; browser: HTTP GET). Returns the raw stored value (or null/undefined
// if nothing's been saved yet) — callers run it through sanitizeBoardFilters()
// before trusting its shape.
async function readProjectBoardFilters() {
  try {
    if (window.electronAPI?.api) {
      const ctx = await window.electronAPI.api.project.config();
      return ctx?.config?.boardFilters ?? null;
    } else {
      const r = await fetch('/api/project-config', { cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        return data.config?.boardFilters ?? null;
      }
    }
  } catch { /* ignore — fall through */ }
  return null;
}

// Fire-and-forget partial write, same idiom as writeProjectTheme(). Best-effort:
// a failed write must never surface to the user or block filtering.
function writeProjectBoardFilters(payload) {
  try {
    if (window.electronAPI?.api) {
      window.electronAPI.api.project.mergeConfig({ boardFilters: payload }).catch(() => {});
    } else {
      fetch('/api/project-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardFilters: payload }),
      }).catch(() => {});
    }
  } catch { /* ignore */ }
}

// Project-load path: read this project's saved filters and assign them into
// state — called after loadStatuses() (the sanitizer needs the current status
// registry to drop stale names) and before the first loadAndRender()/on a project
// switch, mirroring applyProjectTheme()/applyProjectLanguage(). Never writes.
export async function applyProjectBoardFilters() {
  const raw = await readProjectBoardFilters();
  const clean = sanitizeBoardFilters(raw, statusNames());
  state.searchQuery = clean.search;
  state.humanFilterActive = clean.human;
  state.statusFilter = new Set(clean.statuses);
  state.activeTagFilters = new Set(clean.tags);
  state.assigneeScope = clean.assigneeScope;
  state.assigneeFilter = new Set(clean.assignees);
  // (C1452) A restore (boot or Electron project switch) can silently carry a stale
  // selection from the previous project/session into the newly-restored filters — clear
  // it directly (not onBoardFiltersChanged(), which would write these filters straight
  // back to disk, breaking this function's "never writes" contract).
  clearBulkSelection();
}

// User-initiated filter change: call right after the state mutation at each of
// the board's filter controls (search, Human toggle, status checkboxes, tag
// cloud/chips) so a close/reopen or project switch restores exactly what was
// left active.
export function persistBoardFilters() {
  writeProjectBoardFilters(serializeBoardFilters(state));
}

// (C1452) Single entry point for a live user filter-control change: clears the bulk
// selection (and hides #bulk-action-bar) before persisting, so a filter change never
// leaves the bar showing a stale count for cards the new filter has hidden — and so a
// bulk action can never fire against a task the user can no longer see. Order matters:
// clearBulkSelection() must run before any re-render, since renderCard() reads
// state.selectedCardIds at markup time. Call this instead of the bare
// persistBoardFilters() at every filter-mutation site (search, human/people, status,
// tags, assignee). Restore-on-load (applyProjectBoardFilters()) calls
// clearBulkSelection() directly instead — it must never write filters back to disk.
export function onBoardFiltersChanged() {
  clearBulkSelection();
  persistBoardFilters();
}

// (C1259) Debug ▸ click-to-render perf logging — Settings modal toggle, persisted to
// .tipatask/config.json as `debugPerfLog` (same merge path theme/language use). Read
// once at boot/project-switch, same call sites as applyProjectBoardFilters(); a one-time
// settings read is not the kind of round-trip this task is about eliminating — every
// per-click path stays untouched by this.
async function readDebugPerfLog() {
  try {
    if (window.electronAPI?.api) {
      const ctx = await window.electronAPI.api.project.config();
      return !!(ctx?.config?.debugPerfLog);
    } else {
      const r = await fetch('/api/project-config', { cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        return !!(data.config?.debugPerfLog);
      }
    }
  } catch { /* ignore — defaults to off */ }
  return false;
}

export async function applyProjectDebugPerfLog() {
  state.debugPerfLog = await readDebugPerfLog();
}

// Fire-and-forget partial write, same idiom as writeProjectBoardFilters().
export function writeDebugPerfLog(enabled) {
  try {
    if (window.electronAPI?.api) {
      window.electronAPI.api.project.mergeConfig({ debugPerfLog: enabled }).catch(() => {});
    } else {
      fetch('/api/project-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debugPerfLog: enabled }),
      }).catch(() => {});
    }
  } catch { /* ignore */ }
}

// (TPT95) Codex-only opt-in browser-tools MCP presets (Playwright, Chrome DevTools) —
// project-level MCP_BROWSER_TOOLS, sticky like LAST_AGENT: the Task Edit Modal's
// Codex-agent row reads/writes it, and every subsequent Codex spawn in the project
// applies whatever it currently says (ensureProjectCodexHome() in codex-mcp-config.js).
// Same read/write idiom as readDebugPerfLog()/writeDebugPerfLog() above. `null`/absent
// on read means "both presets on" — the modal must default its checkboxes to checked.
const BROWSER_TOOL_IDS = ['playwright', 'chrome-devtools'];

async function readProjectBrowserTools() {
  try {
    if (window.electronAPI?.api) {
      const ctx = await window.electronAPI.api.project.config();
      return normalizeBrowserToolsList(ctx?.config?.MCP_BROWSER_TOOLS);
    } else {
      const r = await fetch('/api/project-config', { cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        return normalizeBrowserToolsList(data.config?.MCP_BROWSER_TOOLS);
      }
    }
  } catch { /* ignore — defaults to both on */ }
  return BROWSER_TOOL_IDS.slice();
}

// Client-side mirror of codex-mcp-config.js's normalizeBrowserToolIds() — kept
// deliberately tiny and independent (no cross-package import from the client bundle
// into ai/todo/server's Node-only module); the server re-validates on both read
// (readBrowserToolSelection) and write (ws-handlers.js POST /api/project-config), so
// this copy only needs to get the modal's own checkbox state right, not enforce safety.
function normalizeBrowserToolsList(value) {
  if (!Array.isArray(value)) return BROWSER_TOOL_IDS.slice();
  return BROWSER_TOOL_IDS.filter(id => value.includes(id));
}

export async function applyProjectBrowserTools() {
  state.browserTools = await readProjectBrowserTools();
}

// Fire-and-forget partial write, same idiom as writeDebugPerfLog().
export function writeProjectBrowserTools(ids) {
  const normalized = normalizeBrowserToolsList(ids);
  state.browserTools = normalized;
  try {
    if (window.electronAPI?.api) {
      window.electronAPI.api.project.mergeConfig({ MCP_BROWSER_TOOLS: normalized }).catch(() => {});
    } else {
      fetch('/api/project-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ MCP_BROWSER_TOOLS: normalized }),
      }).catch(() => {});
    }
  } catch { /* ignore */ }
}

// Project-load path: read authoritative language from project config and set the
// UI locale. Mirrors applyProjectTheme — called on init and on every project
// switch (before loadAndRender so the first paint is already localized). Never writes.
export async function applyProjectLanguage() {
  const lang = await readProjectLanguage();
  setLocale(lang);
  // (C1388) Follow the native Electron menu's locale to whichever project's language
  // this window just loaded — see main/menu-i18n.js. No-op in browser mode (no
  // electronAPI, no native menu to speak of) and non-fatal on failure (the menu just
  // keeps its previous locale, same fail-open posture as every other IPC call here).
  try { await window.electronAPI?.setAppLocale?.(lang); } catch { /* non-fatal */ }
}

// Read project language from project config (Electron: IPC; browser: HTTP GET).
async function readProjectLanguage() {
  try {
    if (window.electronAPI?.api) {
      const ctx = await window.electronAPI.api.project.config();
      return (ctx && ctx.config && ctx.config.language) || 'en';
    } else {
      const r = await fetch('/api/project-config', { cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        return (data.config && data.config.language) || 'en';
      }
    }
  } catch { /* ignore — fall through */ }
  return 'en';
}

// Persist language to project config without triggering a backend rebind.
// Unlike theme (per-user layout), language is a project-wide setting: after the
// local config write it PATCHes the Tipatask API project (via api.project.update() —
// C1271, same backend-method write path the Group Tasks Into select below uses) so the
// DB value stays authoritative for every member.
// On API failure the config write is rolled back to `prev` and the select reset.
async function writeProjectLanguage(val, prev) {
  const lang = val || 'en';
  const writeConfig = (v) => {
    if (window.electronAPI?.api) {
      return window.electronAPI.api.project.mergeConfig({ language: v });
    }
    return fetch('/api/project-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: v }),
    });
  };
  try {
    await writeConfig(lang);
    await api.project.update({ language: lang });
    // Persisted everywhere — switch the UI locale and re-render the board live.
    setLocale(lang);
    try { await window.electronAPI?.setAppLocale?.(lang); } catch { /* non-fatal, see applyProjectLanguage() */ }
    document.dispatchEvent(new Event('tiptask:reload'));
  } catch (err) {
    console.error('[settings] Failed to save project language:', err.message);
    // Roll back so config file and API DB stay consistent.
    try { await writeConfig(prev || 'en'); } catch { /* ignore */ }
    const sel = document.getElementById('settings-language-select');
    if (sel) sel.value = prev || 'en';
    showToast(t('settings.errUpdateLanguage', { msg: err.message }), 'error');
  }
}

// (C1271) Persist task_group_label — project-wide setting, DB-only (unlike language,
// there's no local .tipatask/config.json half to write). Uses a toast, not alert(), on
// both success and failure — matches every other write in the Workflow tab, not the
// General tab's language row.
async function writeProjectGroupLabel(val, prev) {
  const sel = document.getElementById('settings-task-group-label');
  if (sel) sel.disabled = true;
  try {
    await api.project.update({ task_group_label: val });
    setGroupLabel(val);
    showToast(t('settings.workflow.groupLabelSaved', { label: groupPluralFor(val) }), 'success');
    document.dispatchEvent(new Event('tiptask:reload'));
  } catch (err) {
    console.error('[settings] Failed to save group label:', err.message);
    if (sel) sel.value = prev || getGroupLabel();
    showToast(t('settings.workflow.groupLabelFailed', { msg: err.message }), 'error');
  } finally {
    if (sel) sel.disabled = false;
    // (C1457) The Show {noun} caption above interpolates groupPluralFor(getGroupLabel()) —
    // re-render it here so it tracks the new noun live, not only on the next modal open.
    // In the finally (not the try) so a failed save, which rolls the select back to `prev`
    // without touching getGroupLabel(), leaves the caption matching what actually persisted.
    _populateSettingsSprintsRow();
  }
}

// (C1332) Persist sprints_enabled — project-wide, DB-only, same idiom as
// writeProjectGroupLabel() above (toast not alert, tiptask:reload on success). On success
// or failure, re-populate the row so the Group Tasks Into row's visibility (which this
// value controls) tracks whatever actually got saved.
async function writeProjectSprintsEnabled(val, prev) {
  const toggle = document.getElementById('settings-sprints-enabled-toggle');
  if (toggle) toggle.disabled = true;
  try {
    await api.project.update({ sprints_enabled: val });
    setSprintsEnabled(val);
    showToast(
      val ? t('settings.workflow.sprintsEnabledSaved', { label: groupPluralFor(getGroupLabel()) })
        : t('settings.workflow.sprintsDisabledSaved', { label: groupPluralFor(getGroupLabel()) }),
      'success'
    );
    document.dispatchEvent(new Event('tiptask:reload'));
  } catch (err) {
    console.error('[settings] Failed to save sprints_enabled:', err.message);
    if (toggle) toggle.checked = prev !== undefined ? prev : getSprintsEnabled();
    showToast(t('settings.workflow.sprintsEnabledFailed', { msg: err.message }), 'error');
  } finally {
    if (toggle) toggle.disabled = false;
    _populateSettingsSprintsRow();
  }
}

// (C1558/C1460) Persist use_objective_grouping — project-wide, DB-only, same idiom as
// writeProjectSprintsEnabled() above (toast not alert, tiptask:reload on success). The board
// filter is C1460's board-count-domain.js#tasksVisibleUnderGrouping, read live via
// getObjectiveGroupingEnabled() on every render — the reload is what makes flipping this
// toggle repaint the already-open board immediately instead of waiting for the next
// unrelated render. The objective-save gate and the planner prompt also read
// getObjectiveGroupingEnabled() live on their own next use, independent of this dispatch.
async function writeProjectObjectiveGrouping(val, prev) {
  const toggle = document.getElementById('settings-objective-grouping-toggle');
  if (toggle) toggle.disabled = true;
  try {
    await api.project.update({ use_objective_grouping: val });
    setObjectiveGroupingEnabled(val);
    showToast(
      val ? t('settings.workflow.objectiveGroupingSaved') : t('settings.workflow.objectiveGroupingDisabledSaved'),
      'success'
    );
    document.dispatchEvent(new Event('tiptask:reload'));
  } catch (err) {
    console.error('[settings] Failed to save use_objective_grouping:', err.message);
    if (toggle) toggle.checked = prev !== undefined ? prev : getObjectiveGroupingEnabled();
    showToast(t('settings.workflow.objectiveGroupingFailed', { msg: err.message }), 'error');
  } finally {
    if (toggle) toggle.disabled = false;
    _populateSettingsObjectiveGroupingRow();
  }
}

// (C1490) Persist kb_sync_as_you_go — project-wide, DB-only, same idiom as
// writeProjectSprintsEnabled() above (toast not alert on both outcomes). No
// tiptask:reload dispatch here — unlike sprints/group-label, nothing on the board reads
// this value.
async function writeProjectKbSyncAsYouGo(val, prev) {
  const toggle = document.getElementById('settings-kb-sync-toggle');
  if (toggle) toggle.disabled = true;
  try {
    await api.project.update({ kb_sync_as_you_go: val });
    showToast(
      val ? t('settings.memory.syncAsYouGoSaved') : t('settings.memory.syncDisabledSaved'),
      'success'
    );
  } catch (err) {
    console.error('[settings] Failed to save kb_sync_as_you_go:', err.message);
    if (toggle) toggle.checked = prev !== undefined ? prev : true;
    showToast(t('settings.memory.syncAsYouGoFailed', { msg: err.message }), 'error');
  } finally {
    if (toggle) toggle.disabled = false;
  }
}

// Populate the language <select> in the Settings modal from project config.
// Called each time the modal opens so the value reflects the current project.
async function _populateSettingsLanguageSelect() {
  const sel = document.getElementById('settings-language-select');
  if (!sel) return;
  sel.value = await readProjectLanguage();
  // Unknown/legacy code in config → fall back to English visually.
  if (!sel.value) sel.value = 'en';
}

// ── Voice tab (C1178) ──
//
// Local-only settings: `voicePreset`/`voiceLocalModel`/`ASSEMBLYAI_API_KEY` live in
// .tipatask/config.json alongside theme/language, but — unlike writeProjectLanguage() —
// are never PATCHed to the remote Tipatask API project. That was an explicit scope call:
// these are per-machine preferences plus a third-party credential, not project-wide DB
// state other members should see. The key itself never round-trips back into the
// renderer for display — readProjectVoiceSettings() only ever returns a
// `hasAssemblyaiKey` boolean; see the input's masked-placeholder handling below.

// (C1197) state -> label key now lives in voice-model-state.js (voiceModelStateLabelKey),
// shared with voice-errors.js's MODEL_NOT_DOWNLOADED toast — was a local-only copy here.

// (C1198) Button copy keyed by *action* (voiceModelAction()'s return value), not by badge
// state — the button only ever offers abort or delete now. Download/Resume/Update labels
// are gone: the radio (and modal-open auto-resume, see _populateSettingsVoiceTab) is what
// starts or resumes a download, never the button.
const _VOICE_ACTION_LABEL_KEY = {
  abort: 'settings.voiceModelAbort',
  delete: 'settings.voiceModelDelete',
};

let _voiceModelsCache = []; // last GET /api/voice-models result; refreshed on open + WS events

function _fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// IPC and HTTP both mask the AssemblyAI key. On failure, ok:false tells availability
// checks to keep their current state; display callers may still use the defaults.
async function readProjectVoiceSettings() {
  const defaults = { voicePreset: 'assemblyai', voiceLocalModel: 'whisper-base', hasAssemblyaiKey: false, voiceInputDeviceId: '', voiceShortcut: DEFAULT_VOICE_SHORTCUT };
  try {
    if (window.electronAPI?.api) {
      const ctx = await window.electronAPI.api.project.config();
      const cfg = (ctx && ctx.config) || {};
      return {
        voicePreset: cfg.voicePreset || defaults.voicePreset,
        voiceLocalModel: cfg.voiceLocalModel || defaults.voiceLocalModel,
        hasAssemblyaiKey: !!cfg.hasAssemblyaiKey,
        voiceInputDeviceId: cfg.voiceInputDeviceId || defaults.voiceInputDeviceId,
        voiceShortcut: normalizeVoiceShortcut(cfg.voiceShortcut),
        ok: true,
      };
    }
    const r = await fetch('/api/project-config', { cache: 'no-store' });
    if (r.ok) {
      const data = await r.json();
      const cfg = data.config || {};
      return {
        voicePreset: cfg.voicePreset || defaults.voicePreset,
        voiceLocalModel: cfg.voiceLocalModel || defaults.voiceLocalModel,
        hasAssemblyaiKey: !!cfg.hasAssemblyaiKey,
        voiceInputDeviceId: cfg.voiceInputDeviceId || defaults.voiceInputDeviceId,
        voiceShortcut: normalizeVoiceShortcut(cfg.voiceShortcut),
        ok: true,
      };
    }
    console.warn(`[voice] readProjectVoiceSettings: GET /api/project-config -> ${r.status}`);
  } catch (err) {
    console.warn('[voice] readProjectVoiceSettings failed:', err.message);
  }
  return { ...defaults, ok: false };
}

// Persist voice settings to project config only. No remote PATCH (unlike
// writeProjectLanguage) — see the section comment above. Returns the underlying
// write promise so callers can await/catch it (unlike writeProjectTheme, which is
// fire-and-forget — a failed voice-settings write needs to surface to the user).
function writeProjectVoiceSettings(partial) {
  if (window.electronAPI?.api) {
    return window.electronAPI.api.project.mergeConfig(partial);
  }
  return fetch('/api/project-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  }).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

// Static Voice-panel labels aren't hardcoded in template.html (unlike the General tab —
// a pre-existing i18n gap, see tt-audio-input.md) so they actually relocalize. Called once
// from initSettingsModal() and again from _populateSettingsVoiceTab() on every open, in
// case the project language changed while the modal was closed.
function _localizeVoiceStaticLabels() {
  const setText = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  setText('settings-voice-tab-btn', 'settings.tabVoice');
  setText('settings-voice-input-device-label', 'settings.voiceInputDevice');
  setText('settings-voice-preset-assemblyai-label', 'settings.voicePresetAssemblyai');
  // No visible <label> for the key input any more (C1195 merged it into the AssemblyAI
  // row) — aria-label carries the name for a11y, _applyVoiceKeyMaskedState()'s placeholder
  // carries it visually when the input is empty.
  const keyInput = document.getElementById('settings-voice-assemblyai-key');
  if (keyInput) keyInput.setAttribute('aria-label', t('settings.voiceKeyLabel'));
  setText('settings-voice-key-save', 'btn.save');
  setText('settings-voice-key-clear', 'settings.voiceKeyClear');
  setText('settings-voice-local-not-wired-hint', 'settings.voiceLocalNotWired');
  setText('settings-voice-shortcut-label', 'settings.voiceShortcut');
  setText('settings-voice-shortcut-hint', 'settings.voiceShortcutHint');
}

// (C1210) Global shortcut picker. Unlike the input-device <select> above this list is static
// (VOICE_SHORTCUT_OPTIONS, voice-shortcut.js — curated, never enumerated), so populating it is a
// one-time innerHTML build; only the selected value changes per open/change.
function _populateVoiceShortcutSelect(current) {
  const select = document.getElementById('settings-voice-shortcut');
  if (!select) return;
  if (!select.childElementCount) {
    for (const opt of VOICE_SHORTCUT_OPTIONS) {
      const el = document.createElement('option');
      el.value = opt.code;
      el.textContent = (window.electronAPI?.platform === 'darwin' ? '⇧⌘' : 'Ctrl+Shift+') + opt.label;
      select.appendChild(el);
    }
  }
  select.value = (current || DEFAULT_VOICE_SHORTCUT).code;
}

// Wired once from initSettingsModal() — mirrors _wireVoiceInputDeviceSelect() immediately above.
function _wireVoiceShortcutSelect() {
  const select = document.getElementById('settings-voice-shortcut');
  if (!select) return;
  select.addEventListener('change', (e) => {
    const opt = VOICE_SHORTCUT_OPTIONS.find(o => o.code === e.target.value) || DEFAULT_VOICE_SHORTCUT;
    setVoiceShortcut(opt); // instant effect — no round-trip, matches the input-device select
    writeProjectVoiceSettings({ voiceShortcut: opt }).catch((err) => {
      showToast(t('settings.voiceModelActionFailed', { msg: err.message }), 'error');
    });
  });
}

// (C1204) Voice-tab input-device picker. `_voiceInputDeviceEnumInFlight` dedupes concurrent
// populate calls (modal open + a devicechange burst can overlap), mirroring the model list's
// own `_refreshInFlight` idiom below. `_voiceInputDeviceLabelsUnlocked` is a once-per-page-
// session latch on the label-unlock capture (see below); `_voiceInputDeviceWriteSeq` guards
// refreshVoiceInputAvailability() against overwriting a just-made selection with a
// still-in-flight, now-stale config read (same class of race C1202 already fixed for the
// model list via its own in-flight dedupe).
let _voiceInputDeviceEnumInFlight = null;
let _voiceInputDeviceLabelsUnlocked = false;
let _voiceInputDeviceWriteSeq = 0;

// `allowUnlock`: true only when the Voice panel is actually visible right now.
// enumerateDevices() itself never prompts, but a blank-labels result means this origin has no
// mic grant yet — the only way to reveal real device names is a real getUserMedia() capture,
// which DOES prompt/flash the mic indicator. openSettingsModal() calls
// _populateSettingsVoiceTab() unconditionally on every open regardless of which tab is
// active, so this must not fire just because Settings happened to open on General.
async function _populateVoiceInputDeviceSelect(savedId, { allowUnlock = false } = {}) {
  const row = document.getElementById('settings-voice-input-device-row');
  const select = document.getElementById('settings-voice-input-device');
  if (!row || !select) return;
  if (!navigator.mediaDevices?.enumerateDevices) { row.hidden = true; return; } // insecure-context browser mode (C1200-style guard, see attachAudioRecorder())
  row.hidden = false;

  if (_voiceInputDeviceEnumInFlight) return _voiceInputDeviceEnumInFlight;
  _voiceInputDeviceEnumInFlight = (async () => {
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      let inputs = filterAudioInputs(devices);
      // (C1204) Blank labels until this origin holds a mic grant — one-shot unlock: open +
      // immediately stop a throwaway capture to reveal real names, then re-enumerate. Never
      // while a mic is already live elsewhere (isAnyVoiceCaptureActive() — terminal or a field
      // recording), and at most once per page session so a user who dismisses the OS prompt
      // isn't re-prompted on every tab switch.
      if (allowUnlock && !_voiceInputDeviceLabelsUnlocked && !labelsUnlocked(inputs) && !isAnyVoiceCaptureActive()) {
        _voiceInputDeviceLabelsUnlocked = true; // set before awaiting — a denial must not retry
        try {
          const unlockStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          unlockStream.getTracks().forEach(tr => tr.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
          inputs = filterAudioInputs(devices);
        } catch { /* denied/unavailable — render with whatever labels were already visible */ }
      }
      const options = buildInputDeviceOptions(inputs, savedId, {
        defaultLabel: t('settings.voiceInputDeviceDefault'),
        unnamedLabel: (n) => t('settings.voiceInputDeviceUnnamed', { n }),
        missingLabel: t('settings.voiceInputDeviceMissing'),
      });
      // The modal can close (or the awaits above can simply outlast a fast reopen) mid-flight —
      // re-check before writing, same reasoning as _populateSettingsVoiceTab()'s own catch.
      if (!document.getElementById('settings-modal')?.classList.contains('open')) return;
      select.innerHTML = '';
      for (const opt of options) {
        const el = document.createElement('option');
        el.value = opt.value;
        el.textContent = opt.label;
        if (opt.title) el.title = opt.title; // full name on hover if truncated by the select's width
        el.selected = opt.selected;
        select.appendChild(el);
      }
    } catch (err) {
      console.warn('[voice] enumerateDevices failed:', err.message);
    }
  })().finally(() => { _voiceInputDeviceEnumInFlight = null; });
  return _voiceInputDeviceEnumInFlight;
}

// Wired once from initSettingsModal() — the <select> element is static, only its <option>s
// are re-rendered per open/tab-switch (mirrors _wireVoiceAssemblyaiRow()).
function _wireVoiceInputDeviceSelect() {
  const select = document.getElementById('settings-voice-input-device');
  if (!select) return;
  select.addEventListener('change', (e) => {
    const value = e.target.value;
    _voiceInputDeviceWriteSeq++;
    setVoiceInputDeviceId(value); // instant effect — no round-trip, matches the engine radios
    writeProjectVoiceSettings({ voiceInputDeviceId: value }).catch((err) => {
      showToast(t('settings.voiceModelActionFailed', { msg: err.message }), 'error');
    });
  });
}

// (C1195) The AssemblyAI key row is always visible now — this only toggles the
// local-model download hint below the merged list.
// (C1209) Also hidden once the selected local model is already `ready` — the hint explains
// the download/first-load wait, which is over. isVoiceInputReady() is the same predicate
// setVoiceInputAvailability() uses, so hint + mic-enabled state can't disagree. `models`
// defaults to the module cache so call sites that already have a fresh list can pass it,
// and ones that don't just fall back to whatever was last fetched.
function _applyVoiceLocalHintVisibility(preset, selectedModelId, models = _voiceModelsCache) {
  const hint = document.getElementById('settings-voice-local-not-wired-hint');
  if (hint) hint.hidden = isVoiceInputReady(preset, models, selectedModelId);
}

// (C1195) The AssemblyAI radio is static markup (not re-rendered), so it needs its own
// checked-state sync; the matching model radio is checked at render time instead, via the
// `preset`/`selectedModelId` args _renderVoiceModelRows() already takes.
function _applyVoiceEngineSelection(preset) {
  const assemblyaiRadio = document.getElementById('settings-voice-preset-assemblyai');
  if (assemblyaiRadio) assemblyaiRadio.checked = preset === 'assemblyai';
}

function _applyVoiceKeyMaskedState(hasKey) {
  const input = document.getElementById('settings-voice-assemblyai-key');
  const clearBtn = document.getElementById('settings-voice-key-clear');
  if (input) {
    input.value = '';
    input.placeholder = hasKey ? t('settings.voiceKeyPlaceholderSet') : t('settings.voiceKeyLabel');
  }
  if (clearBtn) clearBtn.hidden = !hasKey;
}

function _voiceModelRowHtml(m, selected) {
  const badge = voiceModelBadge(m);
  const action = voiceModelAction(badge.key, selected);
  const size = _fmtBytes(m.totalBytes);
  // (C1198) Button always in the DOM, `hidden` when there's no action — so
  // _markVoiceModelRowDownloading() has an element to unhide+repurpose as Abort the instant
  // a just-selected row starts downloading, without a re-render (C1193's synchronous feedback).
  const dangerClass = action === 'delete' ? ' settings-row-btn-danger' : '';
  return `
    <div class="settings-voice-model-row" data-model-id="${escapeAttr(m.modelId)}">
      <label class="settings-voice-model-label">
        <input type="radio" name="settings-voice-engine" value="${escapeAttr(m.modelId)}"${selected ? ' checked' : ''}>
        <span class="settings-voice-model-name">${escapeAttr(m.label || m.modelId)}</span>
        ${size ? `<span class="settings-voice-model-size">${escapeAttr(size)}</span>` : ''}
      </label>
      <span class="settings-voice-model-state" data-state="${escapeAttr(badge.key)}">${escapeAttr(t(voiceModelStateLabelKey(badge.key)))}</span>
      <div class="settings-voice-model-progress"${badge.key === 'downloading' ? '' : ' hidden'}>
        <div class="settings-voice-model-progress-bar" style="width:${badge.percent ?? 0}%"></div>
      </div>
      <button type="button" class="settings-row-btn settings-voice-model-action${dangerClass}" data-action="${action || ''}"${action ? '' : ' hidden'}>${action ? escapeAttr(t(_VOICE_ACTION_LABEL_KEY[action])) : ''}</button>
    </div>`;
}

function _wireVoiceModelRow(row) {
  const modelId = row.dataset.modelId;
  const radio = row.querySelector('input[type="radio"]');
  if (radio) {
    radio.addEventListener('change', () => {
      // writeProjectVoiceSettings()'s own doc comment says a failed voice-settings write must
      // surface to the user (unlike the fire-and-forget writeProjectTheme()) — this used to be
      // an unhandled rejection that silently dropped the persisted selection.
      // (C1195) A model radio now sets both fields in one write — it's the only "local"
      // engine choice in the merged group, so picking it always means voicePreset:'local'.
      writeProjectVoiceSettings({ voicePreset: 'local', voiceLocalModel: modelId }).catch((err) => {
        showToast(t('settings.voiceModelActionFailed', { msg: err.message }), 'error');
      });
      _maybeStartVoiceModelDownload(modelId);
      // (C1199) _maybeStartVoiceModelDownload() above patches _voiceModelsCache to
      // 'downloading' synchronously (before its first await) whenever a download actually
      // starts — so the cache here already reflects reality in the SAME tick as the click,
      // no round trip needed to disable mics right away. A ready model leaves the cache
      // untouched, so this correctly stays enabled instead.
      // (C1209) Hint read AFTER the patch above too, same reason — a not-yet-ready model
      // must show the hint the instant its radio is picked, not just on next open.
      _applyVoiceLocalHintVisibility('local', modelId);
      setVoiceInputAvailability('local', _voiceModelsCache, modelId);
    });
  }
  const actionBtn = row.querySelector('.settings-voice-model-action');
  if (actionBtn) {
    actionBtn.addEventListener('click', async () => {
      const action = actionBtn.dataset.action;
      if (!action) return; // hidden button, shouldn't be reachable, defensive
      // (C1198) Delete is destructive-ish (frees a downloaded model, re-downloadable later)
      // — gate it behind a confirm dialog. Abort has no such gate; it always did not.
      if (action === 'delete') {
        const status = _voiceModelsCache.find(m => m.modelId === modelId);
        const label = (status && status.label) || modelId;
        const size = _fmtBytes(status && status.totalBytes) || '0 B';
        const ok = await showActionConfirm({
          message: t('settings.voiceModelDeleteConfirm', { model: label, size }),
          confirmLabel: t('settings.voiceModelDelete'),
          danger: true,
        });
        if (!ok) return;
      }
      actionBtn.disabled = true;
      try {
        if (action === 'abort') {
          await api.voiceModels.abort(modelId);
        } else if (action === 'delete') {
          const result = await api.voiceModels.remove(modelId);
          showToast(t('settings.voiceModelDeleted', { model: modelId, size: _fmtBytes(result.freedBytes) || '0 B' }), 'success');
          _refreshVoiceModelRowsIfOpen();
        }
      } catch (err) {
        showToast(t('settings.voiceModelActionFailed', { msg: err.message }), 'error');
        actionBtn.disabled = false;
      }
      // On success, leave it disabled — the next state (downloading/partial/missing) arrives
      // via WS progress/deleted or the next modal open, whichever is first.
    });
  }
}

// Generic confirmation dialog. overlayClass selects the stacking context; all variants
// render at z-index 3400. Focus Cancel (or the sole button for okOnly) to prevent Enter
// from activating the underlying page. Escape/backdrop/Cancel resolve false.
function _markVoiceModelRowDownloading(row, percent) {
  const stateEl = row.querySelector('.settings-voice-model-state');
  const bar = row.querySelector('.settings-voice-model-progress');
  const barFill = row.querySelector('.settings-voice-model-progress-bar');
  const actionBtn = row.querySelector('.settings-voice-model-action');
  if (stateEl) {
    stateEl.dataset.state = 'downloading';
    stateEl.textContent = t(voiceModelStateLabelKey('downloading'));
  }
  if (bar) {
    bar.hidden = false;
    if (barFill && typeof percent === 'number') barFill.style.width = `${percent}%`;
  }
  if (actionBtn) {
    actionBtn.hidden = false;
    actionBtn.classList.remove('settings-row-btn-danger'); // was Delete if this was an inactive row before selection
    actionBtn.dataset.action = 'abort';
    actionBtn.textContent = t(_VOICE_ACTION_LABEL_KEY.abort);
    actionBtn.disabled = false;
  }
}

// Selecting a missing local model starts its download. Mark the row and cache
// as downloading before POST so the UI responds immediately and a quick repeat
// click cannot attach duplicate completion toasts.
async function _maybeStartVoiceModelDownload(modelId) {
  const status = _voiceModelsCache.find(m => m.modelId === modelId);
  const badge = voiceModelBadge(status || {});
  if (!voiceModelNeedsDownload(badge.key)) return;

  const prevState = status ? status.state : undefined;
  if (status) status.state = 'downloading';
  const row = document.querySelector(`.settings-voice-model-row[data-model-id="${CSS.escape(modelId)}"]`);
  if (row) _markVoiceModelRowDownloading(row);

  try {
    await api.voiceModels.download(modelId);
  } catch (err) {
    showToast(t('settings.voiceModelActionFailed', { msg: err.message }), 'error');
    // Revert the optimistic patch — the POST never actually started a download, so leaving
    // the row/cache in a fake "Downloading" state would strand it there until the modal is
    // closed and reopened.
    if (status) status.state = prevState;
    _refreshVoiceModelRowsIfOpen();
  }
}

// `preset` decides whether any model row is checked at all — a local row is only ever
// checked when the saved preset is actually 'local' (mirrors _applyVoiceEngineSelection()
// leaving the AssemblyAI radio unchecked whenever preset !== 'assemblyai').
function _renderVoiceModelRows(models, preset, selectedModelId) {
  const list = document.getElementById('settings-voice-local-list');
  if (!list) return;
  list.innerHTML = models.map(m => _voiceModelRowHtml(m, preset === 'local' && m.modelId === selectedModelId)).join('');
  list.querySelectorAll('.settings-voice-model-row').forEach(row => _wireVoiceModelRow(row));
}

// Called from openSettingsModal() on every open. Re-reads config + live model status —
// cheap (stat-only on the server side, see getVoiceModelStatus()) — so the tab always
// reflects reality even after a download finished while the modal was closed.
async function _populateSettingsVoiceTab() {
  const localList = document.getElementById('settings-voice-local-list');
  if (!localList) return; // modal markup not present (shouldn't happen, defensive)

  _localizeVoiceStaticLabels();
  const settings = await readProjectVoiceSettings();
  _applyVoiceEngineSelection(settings.voicePreset);
  // (C1209) Pre-fetch pass — reads whatever _voiceModelsCache last held (could be stale/empty
  // on first-ever open). Re-applied below once the fresh list lands, so a ready model doesn't
  // flash the hint before the fetch resolves.
  _applyVoiceLocalHintVisibility(settings.voicePreset, settings.voiceLocalModel);
  _applyVoiceKeyMaskedState(settings.hasAssemblyaiKey);
  const keyStatus = document.getElementById('settings-voice-key-status');
  if (keyStatus) keyStatus.hidden = true;
  setVoiceInputDeviceId(settings.voiceInputDeviceId);
  // (C1204) allowUnlock only when the Voice panel is the one actually showing right now —
  // openSettingsModal() calls this on every open regardless of which tab was last active.
  const voicePanelVisible = !document.querySelector('.modal-tab-panel[data-tab="voice"]')?.hidden;
  _populateVoiceInputDeviceSelect(settings.voiceInputDeviceId, { allowUnlock: voicePanelVisible });
  // (C1210) Global shortcut — instant effect on every mic tooltip/toast (voiceShortcutLabel())
  // like setVoiceInputDeviceId() above, plus the Settings row reflecting current config.
  setVoiceShortcut(settings.voiceShortcut);
  _populateVoiceShortcutSelect(settings.voiceShortcut);

  try {
    const { models } = await api.voiceModels.list();
    _voiceModelsCache = Array.isArray(models) ? models : [];
    _renderVoiceModelRows(_voiceModelsCache, settings.voicePreset, settings.voiceLocalModel);
    // (C1209) Re-apply against the freshly-fetched cache — the pre-fetch call above may have
    // read a stale/empty cache (first-ever open) and left the hint showing on an already-ready
    // model.
    _applyVoiceLocalHintVisibility(settings.voicePreset, settings.voiceLocalModel, _voiceModelsCache);
    // (C1199) Already have both settings + models in hand from the fetches above — reuse them
    // instead of refreshVoiceInputAvailability() firing a redundant pair.
    setVoiceInputAvailability(settings.voicePreset, _voiceModelsCache, settings.voiceLocalModel);
    // (C1198) The button no longer offers Resume/Update, so an active model left partial or
    // stale (interrupted last session, or a pinned revision bumped) has no button of its own
    // to retry from — auto-resume it here instead, once per modal open.
    // _maybeStartVoiceModelDownload() already no-ops for ready/downloading, so this is safe to
    // call unconditionally. Deliberately NOT called from _refreshVoiceModelRowsIfOpen() — that
    // fires on every voice-model:error WS frame too, and retrying from there would spin a
    // download-error-download loop while offline instead of surfacing the error.
    if (settings.voicePreset === 'local' && settings.voiceLocalModel) {
      _maybeStartVoiceModelDownload(settings.voiceLocalModel);
    }
  } catch (err) {
    console.error('[settings] Failed to load voice models:', err.message);
    const list = document.getElementById('settings-voice-local-list');
    if (list) list.innerHTML = `<div class="settings-row-hint">${escapeAttr(t('settings.voiceModelsLoadFailed'))}</div>`;
  }
}

// AssemblyAI radio — wired once (static element, not re-created per open), mirroring the
// language select's wiring in initSettingsModal() below. Model radios are re-wired per
// render instead, in _wireVoiceModelRow(), since the list itself is re-rendered on every
// open (see _renderVoiceModelRows()).
function _wireVoiceAssemblyaiRow() {
  const radio = document.getElementById('settings-voice-preset-assemblyai');
  if (!radio) return;
  radio.addEventListener('change', (e) => {
    if (!e.target.checked) return;
    writeProjectVoiceSettings({ voicePreset: 'assemblyai' }).catch((err) => {
      showToast(t('settings.voiceModelActionFailed', { msg: err.message }), 'error');
    });
    _applyVoiceLocalHintVisibility('assemblyai', null);
    // (C1205) Prev-active local row was rendered selected:true -> button hidden
    // (voiceModelAction('ready', true) === null). Nothing repainted it on engine
    // switch -> Delete stayed invisible til modal reopen. Re-render from cache (same
    // call _populateSettingsVoiceTab()/refreshVoiceInputAvailability() use) so every
    // row recomputes its action against new preset same tick as click. selectedModelId
    // irrelevant under 'assemblyai' — _renderVoiceModelRows() only checks a row when
    // preset === 'local'. Guard on cache.length: empty cache means the list failed to
    // load (#settings-voice-local-list holds the voiceModelsLoadFailed hint instead of
    // rows) — an unguarded re-render would blank that hint.
    if (_voiceModelsCache.length) _renderVoiceModelRows(_voiceModelsCache, 'assemblyai', null);
    // (C1199) AssemblyAI needs nothing on disk — always ready, no fetch needed to know that.
    setVoiceInputAvailability('assemblyai', _voiceModelsCache, null);
  });
}

function _wireVoiceKeyButtons() {
  const saveBtn = document.getElementById('settings-voice-key-save');
  const clearBtn = document.getElementById('settings-voice-key-clear');
  const input = document.getElementById('settings-voice-assemblyai-key');
  const status = document.getElementById('settings-voice-key-status');
  const showStatus = (key, cls) => {
    if (!status) return;
    status.hidden = false;
    status.className = `settings-row-hint${cls ? ` ${cls}` : ''}`;
    status.textContent = t(key);
  };
  if (saveBtn && input) {
    saveBtn.addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) return; // blank Save = no-op, never accidentally erases a saved key
      saveBtn.disabled = true;
      try {
        await writeProjectVoiceSettings({ assemblyaiKey: { action: 'replace', value } });
        _applyVoiceKeyMaskedState(true);
        showStatus('settings.voiceKeySaved', 'settings-row-hint--success');
      } catch (err) {
        showStatus('settings.voiceKeySaveFailed', null);
        if (status) status.textContent = t('settings.voiceKeySaveFailed', { msg: err.message });
      }
      saveBtn.disabled = false;
    });
  }
  if (clearBtn && input) {
    clearBtn.addEventListener('click', async () => {
      clearBtn.disabled = true;
      try {
        await writeProjectVoiceSettings({ assemblyaiKey: { action: 'clear' } });
        _applyVoiceKeyMaskedState(false);
        showStatus('settings.voiceKeyCleared', 'settings-row-hint--success');
      } catch (err) {
        showStatus('settings.voiceKeySaveFailed', null);
        if (status) status.textContent = t('settings.voiceKeySaveFailed', { msg: err.message });
      }
      clearBtn.disabled = false;
    });
  }
}

// ── Workflow tab (C1182) ──
// Project Workflow settings: add/rename/recolor/delete/reorder this project's custom
// task statuses and move the 3 workflow roles (is_workflow_start/is_in_progress/
// is_workflow_complete — see status-roles.js) between them. Mirrors the equivalent tab
// in the web app (api/web/src/pages/settings.js's renderWorkflowTab()) — same controls,
// same API (api/src/routes/statuses.js), different host UI.

// Swatch hexes match api/web's Catppuccin Mocha `--c-<name>` values (styles.css) — this
// app's own theme system has no per-token color variables (19 named themes, semantic
// --c-success/-danger/etc. only, see tt-web-theme's counterpart doc), so these are literal
// decorative hex values for the chip preview + add-form <select>, not a global CSS token.
// (C1187) Canonical copy moved to status-registry.js (imported above) — statusColor()
// resolves a status's own color; WORKFLOW_COLOR_SWATCHES is re-exported for this tab's
// color-token <select> lists, which enumerate every available token, not one status's.

let _workflowStatuses = []; // last-fetched list, kept in display_order for optimistic UI

function _workflowSwatch(color) {
  return WORKFLOW_COLOR_SWATCHES[color] || 'var(--c-primary)';
}

// NOTE: also called on raw color-TOKEN names (e.g. 'overlay1'), not just status names —
// do not replace with status-registry.js's statusLabel(), which special-cases the
// status.* i18n keys and would be wrong here.
function _workflowLabel(name) {
  return String(name || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function _populateSettingsWorkflowAddForm() {
  const colorSelect = document.getElementById('settings-workflow-add-color');
  const nameInput = document.getElementById('settings-workflow-add-name');
  const addBtn = document.getElementById('settings-workflow-add-btn');
  if (colorSelect && !colorSelect.options.length) {
    colorSelect.innerHTML = Object.keys(WORKFLOW_COLOR_SWATCHES)
      .map((name) => `<option value="${name}">${_workflowLabel(name)}</option>`).join('');
  }
  if (nameInput) nameInput.placeholder = t('settings.workflow.addPlaceholder');
  if (addBtn) addBtn.textContent = t('settings.workflow.addBtn');
}

// (C1271) Group Tasks Into select — populates the caption + rebuilds the option list
// from TASK_GROUP_LABELS each open (locale can have changed since last open), then sets
// the value from the already-loaded group-label.js state (loadGroupLabel() is awaited by
// the caller, _populateSettingsWorkflowTab(), before this runs).
function _populateSettingsGroupLabelRow() {
  const caption = document.getElementById('settings-task-group-label-caption');
  const sel = document.getElementById('settings-task-group-label');
  if (caption) {
    caption.innerHTML = `${escapeAttr(t('settings.workflow.groupLabel'))} <small class="settings-row-note">${escapeAttr(t('settings.workflow.groupLabelNote'))}</small>`;
  }
  if (sel) {
    sel.innerHTML = TASK_GROUP_LABELS
      .map((label) => `<option value="${escapeAttr(label)}">${escapeAttr(groupPluralFor(label))}</option>`).join('');
    sel.value = getGroupLabel();
  }
}

// (C1332) Show Sprints checkbox — caption uses the current Group Tasks Into noun ("Show
// Batches" / "Show Sprints" / ...), value from the already-loaded group-label.js state
// (loadGroupLabel() is awaited by the caller before this runs, same as the group-label row
// above). Also owns the Group Tasks Into row's visibility: that row is meaningless once
// sprints are hidden, so hide the whole row (not just its <select>) rather than leave an
// orphan caption behind.
function _populateSettingsSprintsRow() {
  const caption = document.getElementById('settings-sprints-enabled-caption');
  const toggle = document.getElementById('settings-sprints-enabled-toggle');
  const enabled = getSprintsEnabled();
  if (caption) {
    caption.innerHTML = `${escapeAttr(t('settings.workflow.sprintsEnabled', { label: groupPluralFor(getGroupLabel()) }))} <small class="settings-row-note">${escapeAttr(t('settings.workflow.sprintsEnabledNote'))}</small>`;
  }
  if (toggle) toggle.checked = enabled;
  const groupRow = document.getElementById('settings-task-group-label-row');
  if (groupRow) groupRow.hidden = !enabled;
}

// (C1558) Use Objective Tasks Grouping checkbox — value from the already-loaded
// group-label.js state (loadGroupLabel() is awaited by the caller before this runs, same
// idiom as the sprints/group-label rows above).
function _populateSettingsObjectiveGroupingRow() {
  const caption = document.getElementById('settings-objective-grouping-caption');
  const toggle = document.getElementById('settings-objective-grouping-toggle');
  if (caption) {
    caption.innerHTML = `${escapeAttr(t('settings.workflow.objectiveGrouping'))} <small class="settings-row-note">${escapeAttr(t('settings.workflow.objectiveGroupingNote'))}</small>`;
  }
  if (toggle) toggle.checked = getObjectiveGroupingEnabled();
}

async function _populateSettingsWorkflowTab() {
  const tabBtn = document.getElementById('settings-workflow-tab-btn');
  const list = document.getElementById('settings-workflow-list');
  const caption = document.getElementById('settings-workflow-caption');
  const head = document.getElementById('settings-workflow-head');
  if (!tabBtn || !list) return;
  tabBtn.textContent = t('settings.workflow.tab');
  // Caption + stage header (C1192) — filled via t() here, not frozen at module load, so a
  // live locale switch (setLocale()) re-populating this tab picks up the new language, same
  // discipline as every other t() call in this file.
  if (caption) caption.textContent = t('settings.workflow.caption');
  if (head) {
    head.innerHTML = `
      <span class="settings-wf-head-spacer"></span>
      <span class="settings-wf-count" title="${escapeAttr(t('settings.workflow.countTitle'))}">#</span>
      <span class="settings-wf-head-cell">${escapeAttr(t('settings.workflow.roleToDo'))}</span>
      <span class="settings-wf-head-cell">${escapeAttr(t('settings.workflow.roleInProgress'))}</span>
      <span class="settings-wf-head-cell">${escapeAttr(t('settings.workflow.roleCompleted'))}</span>
      <span class="settings-wf-head-cell">${escapeAttr(t('settings.workflow.roleCanceled'))}</span>
      <span class="settings-wf-head-x"></span>`;
  }

  _populateSettingsWorkflowAddForm();
  await loadGroupLabel();
  _populateSettingsGroupLabelRow();
  // (C1332) Must run after the group-label row above — it owns that row's hidden state.
  _populateSettingsSprintsRow();
  // (C1558) No ordering dependency on the two rows above — independent setting.
  _populateSettingsObjectiveGroupingRow();

  try {
    _workflowStatuses = await api.statuses.list();
    seedStatuses(_workflowStatuses); // (C1187) inform the shared registry — no extra HTTP
  } catch (err) {
    list.innerHTML = `<div class="settings-row-hint">${escapeAttr(t('settings.workflow.loadFailed', { msg: err.message }))}</div>`;
    return;
  }
  _renderWorkflowRows();
}

// (C1490) Memory tab — Sync as you go toggle (kb_sync_as_you_go, C1488 migration/PATCH).
// No module-level cache like group-label.js's sprintsEnabled/taskGroupLabel — nothing on
// the board renders from this value, so a plain read-on-open covers it. Fail-open on a
// load error (checkbox defaults checked), matching the flag's own fail-open default.
async function _populateSettingsMemoryTab() {
  const tabBtn = document.getElementById('settings-memory-tab-btn');
  const caption = document.getElementById('settings-kb-sync-caption');
  const toggle = document.getElementById('settings-kb-sync-toggle');
  if (!tabBtn) return;
  tabBtn.textContent = t('settings.memory.tab');
  if (caption) {
    caption.innerHTML = `${escapeAttr(t('settings.memory.syncAsYouGo'))} <small class="settings-row-note">${escapeAttr(t('settings.memory.syncAsYouGoNote'))}</small>`;
  }
  try {
    const s = await api.project.settings();
    if (toggle) toggle.checked = s?.kbSyncAsYouGo !== false;
  } catch (err) {
    console.error('[settings] Failed to load Memory tab settings:', err.message);
    if (toggle) toggle.checked = true;
  }
}

// (TPT62) Version Control tab — vcs_type ('' | 'git' | 'svn') + the four git-only
// suboption flags (worktree/commit/PR/merge). Held here
// (not in group-label.js) since nothing outside this tab reads it — a checkbox change
// needs BOTH the current type and all four flags to compose a patch body via
// buildVcsPatchBody(), and this is also what a failed save rolls back to.
let _vcsSettings = { type: '', flags: {} };

// Deliberately NOT fail-open to Disabled on a load error — unlike Memory's kb-sync
// toggle above, a save composed from an unread state here could silently clear the
// user's real git setting. Every control stays disabled and a hint explains why until
// the tab is reopened.
async function _populateSettingsVersionControlTab() {
  const tabBtn = document.getElementById('settings-vcs-tab-btn');
  const caption = document.getElementById('settings-vcs-caption');
  const typeOptions = document.getElementById('settings-vcs-type-options');
  const gitOptions = document.getElementById('settings-vcs-git-options');
  const hint = document.getElementById('settings-vcs-hint');
  if (!tabBtn) return;
  tabBtn.textContent = t('settings.vcs.tab');
  if (caption) {
    caption.innerHTML = `${escapeAttr(t('settings.vcs.caption'))} <small class="settings-row-note">${escapeAttr(t('settings.vcs.note'))}</small>`;
  }
  if (typeOptions) {
    typeOptions.innerHTML = VCS_TYPES.map((opt) => `
      <label class="settings-vcs-option">
        <input type="radio" name="settings-vcs-type" value="${escapeAttr(opt.value)}">
        <span class="settings-vcs-option-label">${escapeAttr(t(opt.labelKey))}</span>
      </label>`).join('');
  }
  if (gitOptions) {
    gitOptions.innerHTML = VCS_GIT_FLAGS.map((f) => `
      <label class="settings-vcs-suboption">
        <input type="checkbox" data-field="${escapeAttr(f.field)}">
        <span class="settings-vcs-suboption-label">${escapeAttr(t(f.labelKey))}</span>
        <span class="settings-vcs-suboption-hint">${escapeAttr(t(f.hintKey))}</span>
      </label>`).join('');
  }
  if (hint) hint.hidden = true;
  try {
    const s = await api.project.settings();
    _vcsSettings = {
      type: s?.vcsType || '',
      flags: {
        vcs_worktree_enabled: !!s?.vcsWorktreeEnabled,
        vcs_commit_enabled: !!s?.vcsCommitEnabled,
        vcs_pr_enabled: !!s?.vcsPrEnabled,
        vcs_merge_enabled: !!s?.vcsMergeEnabled,
      },
    };
    _setVcsControlsDisabled(false);
  } catch (err) {
    console.error('[settings] Failed to load Version Control tab settings:', err.message);
    _setVcsControlsDisabled(true);
    if (hint) {
      hint.hidden = false;
      hint.textContent = t('settings.vcs.loadFailed', { msg: err.message });
    }
  }
  _applyVcsControls();
}

function _setVcsControlsDisabled(disabled) {
  document.querySelectorAll('#settings-vcs-type-options input, #settings-vcs-git-options input')
    .forEach((el) => { el.disabled = disabled; });
}

// Sets every control's visible state from _vcsSettings, including the git-only checkbox
// block's visibility. Hidden checkboxes keep their `checked` state (only `hidden` flips)
// so a git -> svn -> git flip in one session restores the previous ticks with no
// round-trip — same behavior as the web twin's renderVersionControlTab().
function _applyVcsControls() {
  const typeOptions = document.getElementById('settings-vcs-type-options');
  const gitOptions = document.getElementById('settings-vcs-git-options');
  if (typeOptions) {
    typeOptions.querySelectorAll('input[name="settings-vcs-type"]').forEach((el) => {
      el.checked = el.value === _vcsSettings.type;
    });
  }
  if (gitOptions) {
    gitOptions.querySelectorAll('input[data-field]').forEach((el) => {
      el.checked = !!_vcsSettings.flags[el.dataset.field];
    });
    gitOptions.hidden = _vcsSettings.type !== 'git';
  }
}

// Persist vcs_type/vcs_*_enabled — project-wide, DB-only, same idiom as
// writeProjectKbSyncAsYouGo() above (toast not alert, no tiptask:reload — nothing on the
// board reads this value). buildVcsPatchBody() is the single source of the dormant-flag
// rule (omit the four flags entirely unless nextType === 'git') — never hand-build this
// body inline, so the Disabled/SVN save path can't accidentally wipe stored flags.
async function writeProjectVcs(nextType, nextFlags, prev) {
  _setVcsControlsDisabled(true);
  try {
    await api.project.update(buildVcsPatchBody(nextType, nextFlags));
    _vcsSettings = { type: nextType, flags: nextFlags };
    document.dispatchEvent(new document.defaultView.CustomEvent('tiptask:merge-status-changed'));
    showToast(t('settings.vcs.saved'), 'success');
  } catch (err) {
    console.error('[settings] Failed to save version control settings:', err.message);
    _vcsSettings = prev;
    showToast(t('settings.vcs.failed', { msg: err.message }), 'error');
  } finally {
    _setVcsControlsDisabled(false);
    _applyVcsControls();
  }
}

function _renderWorkflowRows() {
  const list = document.getElementById('settings-workflow-list');
  if (!list) return;
  const rows = [...(_workflowStatuses || [])].sort((a, b) => a.display_order - b.display_order);
  list.innerHTML = rows.map((s) => {
    const holdsRole = s.is_workflow_start || s.is_in_progress || s.is_workflow_complete || s.is_workflow_canceled;
    const deleteBlocked = holdsRole || s.task_count > 0;
    const deleteTitle = holdsRole
      ? t('settings.workflow.deleteBlockedRole')
      : (s.task_count > 0 ? t('settings.workflow.deleteBlockedTasks', { n: s.task_count }) : t('settings.workflow.deleteTitle'));
    return `
    <div class="settings-wf-row" data-id="${s.id}">
      <span class="settings-wf-handle" title="${escapeAttr(t('settings.workflow.dragTitle'))}">&#10495;</span>
      <span class="settings-wf-chip" style="--wf-color:${_workflowSwatch(s.color)}">
        <input type="text" class="settings-wf-chip-name" value="${escapeAttr(s.name)}" data-id="${s.id}" data-prev="${escapeAttr(s.name)}" title="${escapeAttr(s.name)}">
        <select class="settings-wf-chip-color" data-id="${s.id}" title="${escapeAttr(_workflowLabel(s.color))}" aria-label="${escapeAttr(t('settings.workflow.colorLabel', { name: s.name }))}">
          ${Object.keys(WORKFLOW_COLOR_SWATCHES).map((name) =>
            `<option value="${name}" ${name === s.color ? 'selected' : ''}>${_workflowLabel(name)}</option>`).join('')}
        </select>
      </span>
      <span class="settings-wf-count">${s.task_count}</span>
      <label class="settings-wf-radio" title="${escapeAttr(t('settings.workflow.roleToDo'))}">
        <input type="radio" name="wf-role-start" data-role="is_workflow_start" data-id="${s.id}" aria-label="${escapeAttr(t('settings.workflow.roleToDo'))}: ${escapeAttr(s.name)}" ${s.is_workflow_start ? 'checked' : ''}>
      </label>
      <label class="settings-wf-radio" title="${escapeAttr(t('settings.workflow.roleInProgress'))}">
        <input type="radio" name="wf-role-progress" data-role="is_in_progress" data-id="${s.id}" aria-label="${escapeAttr(t('settings.workflow.roleInProgress'))}: ${escapeAttr(s.name)}" ${s.is_in_progress ? 'checked' : ''}>
      </label>
      <label class="settings-wf-radio" title="${escapeAttr(t('settings.workflow.roleCompleted'))}">
        <input type="radio" name="wf-role-complete" data-role="is_workflow_complete" data-id="${s.id}" aria-label="${escapeAttr(t('settings.workflow.roleCompleted'))}: ${escapeAttr(s.name)}" ${s.is_workflow_complete ? 'checked' : ''}>
      </label>
      <label class="settings-wf-radio" title="${escapeAttr(t('settings.workflow.roleCanceled'))}">
        <input type="radio" name="wf-role-canceled" data-role="is_workflow_canceled" data-id="${s.id}" aria-label="${escapeAttr(t('settings.workflow.roleCanceled'))}: ${escapeAttr(s.name)}" ${s.is_workflow_canceled ? 'checked' : ''}>
      </label>
      <button type="button" class="settings-wf-row-x" data-id="${s.id}" ${deleteBlocked ? 'disabled' : ''} title="${escapeAttr(deleteTitle)}">&times;</button>
    </div>`;
  }).join('');
}

// Wired once (static container, re-rendered content) — event delegation on
// #settings-workflow-list for rename/color/role/delete, plus the house mouse-based drag
// idiom (mousedown/mousemove/mouseup, clone+placeholder — same as the web app's
// backlog.js) for reorder, and the add-form's submit.
function _wireSettingsWorkflowTab() {
  const list = document.getElementById('settings-workflow-list');
  const addForm = document.getElementById('settings-workflow-add-form');
  if (!list) return;

  // Rename — commit on blur, Enter commits (blurs), Escape reverts (blurs unchanged).
  list.addEventListener('focusout', async (e) => {
    const input = e.target.closest('.settings-wf-chip-name');
    if (!input) return;
    const id = input.dataset.id;
    const prev = input.dataset.prev;
    const next = input.value.trim();
    if (!next || next === prev) { input.value = prev; return; }
    input.disabled = true;
    try {
      await api.statuses.update(id, { name: next });
      input.dataset.prev = next;
      const row = _workflowStatuses.find((s) => String(s.id) === String(id));
      if (row) row.name = next;
      seedStatuses(_workflowStatuses);
      showToast(t('settings.workflow.renamed', { from: prev, to: next }), 'success');
    } catch (err) {
      input.value = prev;
      showToast(err.message || t('settings.workflow.saveFailed'), 'error');
    }
    input.disabled = false;
  });
  list.addEventListener('keydown', (e) => {
    const input = e.target.closest('.settings-wf-chip-name');
    if (!input) return;
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { input.value = input.dataset.prev; input.blur(); }
  });

  // Color select + role radios (delegated 'change')
  list.addEventListener('change', async (e) => {
    const colorSelect = e.target.closest('.settings-wf-chip-color');
    if (colorSelect) {
      const id = colorSelect.dataset.id;
      const color = colorSelect.value;
      try {
        await api.statuses.update(id, { color });
        const row = _workflowStatuses.find((s) => String(s.id) === String(id));
        if (row) row.color = color;
        seedStatuses(_workflowStatuses);
      } catch (err) {
        showToast(err.message || t('settings.workflow.saveFailed'), 'error');
      }
      _renderWorkflowRows();
      return;
    }
    const radio = e.target.closest('input[type="radio"][data-role]');
    if (radio) {
      const id = radio.dataset.id;
      const role = radio.dataset.role;
      radio.disabled = true;
      try {
        // The API moves the role (clears whichever other status held it) atomically —
        // refetch the full list so that status's own radio unchecks in this UI too.
        await api.statuses.update(id, { [role]: true });
        _workflowStatuses = await api.statuses.list();
        seedStatuses(_workflowStatuses);
      } catch (err) {
        showToast(err.message || t('settings.workflow.saveFailed'), 'error');
      }
      _renderWorkflowRows();
      return;
    }
  });

  // Delete
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('.settings-wf-row-x');
    if (!btn || btn.disabled) return;
    const id = btn.dataset.id;
    const row = _workflowStatuses.find((s) => String(s.id) === String(id));
    if (!row) return;
    // (C1458) Disable BEFORE the now-async confirm (re-entrancy guard — a second click
    // during the dialog used to be impossible while confirm() blocked the event loop),
    // re-enable on cancel. Re-resolve the row after the await: _renderWorkflowRows() can
    // rebuild _workflowStatuses while the dialog is open (another row's delete/reorder).
    btn.disabled = true;
    const ok = await showActionConfirm({
      message: t('settings.workflow.confirmDelete', { name: escapeAttr(row.name) }),
      confirmLabel: t('btn.delete'),
      danger: true,
      overlayClass: 'modal-overlay--over-settings',
    });
    if (!ok) { btn.disabled = false; return; }
    const current = _workflowStatuses.find((s) => String(s.id) === String(id));
    if (!current) { _renderWorkflowRows(); return; } // deleted/gone while the dialog was open
    try {
      await api.statuses.remove(id);
      _workflowStatuses = _workflowStatuses.filter((s) => String(s.id) !== String(id));
      seedStatuses(_workflowStatuses);
      showToast(t('settings.workflow.deleted', { name: current.name }), 'success');
    } catch (err) {
      showToast(err.message || t('settings.workflow.saveFailed'), 'error');
      btn.disabled = false;
    }
    _renderWorkflowRows();
  });

  // Drag reorder — single container, so no cross-lane target logic needed.
  let drag = null;
  const WF_DRAG_THRESHOLD = 5;
  list.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.settings-wf-handle');
    if (!handle) return;
    const row = handle.closest('.settings-wf-row');
    if (!row) return;
    const rect = row.getBoundingClientRect();
    drag = {
      id: row.dataset.id, el: row, clone: null, placeholder: null,
      startX: e.clientX, startY: e.clientY,
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
      moved: false,
    };
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.sqrt(dx * dx + dy * dy) < WF_DRAG_THRESHOLD) return;
      drag.moved = true;
      drag.clone = drag.el.cloneNode(true);
      drag.clone.classList.add('settings-wf-row-dragging');
      drag.clone.style.width = `${drag.el.offsetWidth}px`;
      document.body.appendChild(drag.clone);
      drag.placeholder = document.createElement('div');
      drag.placeholder.className = 'settings-wf-placeholder';
      drag.placeholder.style.height = `${drag.el.offsetHeight}px`;
      drag.el.parentNode.insertBefore(drag.placeholder, drag.el);
      drag.el.classList.add('settings-wf-row-hidden');
    }
    drag.clone.style.left = `${e.clientX - drag.offsetX}px`;
    drag.clone.style.top = `${e.clientY - drag.offsetY}px`;
    const rows = [...list.querySelectorAll('.settings-wf-row:not(.settings-wf-row-hidden)')];
    let insertBefore = null;
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) { insertBefore = r; break; }
    }
    if (insertBefore) list.insertBefore(drag.placeholder, insertBefore);
    else list.appendChild(drag.placeholder);
  });
  document.addEventListener('mouseup', async () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    const newIndex = [...list.children].indexOf(d.placeholder);
    if (d.clone) d.clone.remove();
    if (d.placeholder) d.placeholder.remove();
    d.el.classList.remove('settings-wf-row-hidden');

    const ordered = [..._workflowStatuses].sort((a, b) => a.display_order - b.display_order);
    const prevIds = ordered.map((s) => s.id);
    const from = ordered.findIndex((s) => String(s.id) === String(d.id));
    if (from === -1) return;
    const [moved] = ordered.splice(from, 1);
    ordered.splice(Math.min(newIndex, ordered.length), 0, moved);
    const ids = ordered.map((s) => s.id);
    if (ids.every((id, i) => id === prevIds[i])) return; // dropped back in place

    ordered.forEach((s, i) => { s.display_order = i; });
    _workflowStatuses = ordered; // optimistic UI step — not seeded into the shared registry yet
    _renderWorkflowRows();
    try {
      _workflowStatuses = await api.statuses.reorder(ids);
      seedStatuses(_workflowStatuses);
    } catch (err) {
      showToast(err.message || t('settings.workflow.saveFailed'), 'error');
      try {
        _workflowStatuses = await api.statuses.list();
        seedStatuses(_workflowStatuses);
      } catch { /* keep optimistic state on double failure */ }
    }
    _renderWorkflowRows();
  });

  // Add form
  if (addForm) {
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('settings-workflow-add-name');
      const colorSelect = document.getElementById('settings-workflow-add-color');
      const addBtn = document.getElementById('settings-workflow-add-btn');
      const name = nameInput.value.trim();
      if (!name) return;
      addBtn.disabled = true;
      try {
        await api.statuses.create({ name, color: colorSelect.value });
        nameInput.value = '';
        _workflowStatuses = await api.statuses.list();
        seedStatuses(_workflowStatuses);
        _renderWorkflowRows();
        showToast(t('settings.workflow.added', { name }), 'success');
      } catch (err) {
        showToast(err.message || t('settings.workflow.saveFailed'), 'error');
      }
      addBtn.disabled = false;
    });
  }
}

// Live update for one row from a `voice-model:progress` WS payload — patches in place
// rather than a full re-render so an in-progress bar doesn't jump/flicker. Shares its DOM
// patch with the optimistic pre-POST call (_maybeStartVoiceModelDownload) via
// _markVoiceModelRowDownloading.
function _applyVoiceModelRowProgress(row, progress) {
  const badge = applyVoiceModelProgress({ key: 'downloading', percent: null }, progress);
  _markVoiceModelRowDownloading(row, typeof badge.percent === 'number' ? badge.percent : undefined);
}

// (C1199) Re-pulls the full model list (need updated state/totalBytes/etc from disk, not
// just the one model the event named), updates mic availability for the whole page, and —
// only when the Settings modal is actually open — re-renders its rows too. Mics live on the
// board regardless of whether the modal is open, so unlike the old modal-gated version this
// always fetches; the fetch itself is cheap (stat-only server side, see
// getVoiceModelStatus()) and only runs off boot + the rare voice-model:* WS frames, never
// per :progress tick. Exported so initSettingsModal() (boot) can kick off the first check.
// (C1202) In-flight dedupe — a burst of voice-model:* WS frames (progress/complete/error can
// arrive close together) used to fire one fetch pair PER frame with no coordination; the
// later-resolving one silently won regardless of which fetch actually started later. One
// shared in-flight promise makes concurrent triggers converge on a single fetch pair instead.
let _refreshInFlight = null;

export function refreshVoiceInputAvailability() {
  if (_refreshInFlight) return _refreshInFlight;
  // (C1204) Snapshot the write counter BEFORE the async read starts — if the user picks a
  // different device while this read is in flight (e.g. a voice-model:* WS frame triggers a
  // refresh right as the device select's own change handler fires), the read's
  // now-stale voiceInputDeviceId must not clobber the fresher in-memory selection.
  const deviceWriteSeqAtStart = _voiceInputDeviceWriteSeq;
  _refreshInFlight = Promise.all([readProjectVoiceSettings(), api.voiceModels.list()]).then(([settings, { models }]) => {
    _voiceModelsCache = Array.isArray(models) ? models : [];
    // (C1202) `settings.ok === false` means the config read itself failed — readProjectVoiceSettings()
    // returns `voicePreset:'assemblyai'` defaults in that case, which would read as "always
    // ready" and could re-enable mics on a project actually running the `local` preset. Leave
    // whatever availability was already in effect instead of trusting the defaults.
    if (settings.ok === false) {
      console.warn('[voice] availability refresh: project-config read failed, keeping previous availability');
      return;
    }
    setVoiceInputAvailability(settings.voicePreset, _voiceModelsCache, settings.voiceLocalModel);
    if (deviceWriteSeqAtStart === _voiceInputDeviceWriteSeq) {
      setVoiceInputDeviceId(settings.voiceInputDeviceId);
    }
    // (C1210) Same "apply at boot, not just on Settings open" need as the device id above — the
    // configured shortcut must be live before the user ever opens Settings. No write-seq race to
    // guard against yet (the shortcut <select> only exists once Settings has opened at least
    // once), but reads the same settings snapshot for consistency.
    setVoiceShortcut(settings.voiceShortcut);
    const modal = document.getElementById('settings-modal');
    if (modal && modal.classList.contains('open')) {
      _renderVoiceModelRows(_voiceModelsCache, settings.voicePreset, settings.voiceLocalModel);
      // (C1209) A download finishing while the modal is open (voice-model:complete WS frame)
      // must clear the hint live, no reopen needed.
      _applyVoiceLocalHintVisibility(settings.voicePreset, settings.voiceLocalModel, _voiceModelsCache);
    }
  }).catch((err) => {
    // fail open — best-effort refresh, previous availability stands — but no longer silent.
    console.warn('[voice] availability refresh failed:', err.message);
  }).finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}

// Pre-C1199 name — every existing call site (radio-download failure revert, Delete success,
// the WS handler below) wants "re-sync everything voice-related", which is exactly what
// refreshVoiceInputAvailability() now does. Kept as an alias so those sites read the same.
const _refreshVoiceModelRowsIfOpen = refreshVoiceInputAvailability;

// Board WS → Voice tab live updates (voice-model:progress/complete/error, see
// voice-model-manager.js + websocket.js's unscoped broadcast()). Safe to call with the
// modal closed or a different model's row rendered — every lookup here is DOM-optional.
//
// (C1193) Hides that model's progress track immediately on :complete/:error instead of
// leaving it sitting at its last percent until _refreshVoiceModelRowsIfOpen()'s two awaited
// fetches land — that gap is small but visible on a fast finish.
function _hideVoiceModelRowProgress(modelId) {
  const row = document.querySelector(`.settings-voice-model-row[data-model-id="${CSS.escape(modelId)}"]`);
  const bar = row && row.querySelector('.settings-voice-model-progress');
  if (bar) bar.hidden = true;
}

export function handleVoiceModelMessage(msg) {
  if (!msg || !msg.modelId) return;
  if (msg.type === 'voice-model:progress') {
    const row = document.querySelector(`.settings-voice-model-row[data-model-id="${CSS.escape(msg.modelId)}"]`);
    if (row) _applyVoiceModelRowProgress(row, msg);
    return;
  }
  if (msg.type === 'voice-model:complete') {
    if (!msg.skipped) showToast(t('settings.voiceModelDownloadComplete', { model: msg.modelId }), 'success');
    _hideVoiceModelRowProgress(msg.modelId);
    _refreshVoiceModelRowsIfOpen();
    return;
  }
  if (msg.type === 'voice-model:error') {
    // VOICE_MODEL_ABORTED is a user-initiated cancel, not a failure — no error toast for
    // it (see VOICE_MODEL_ERRORS in voice-model-manager.js).
    if (msg.code !== 'VOICE_MODEL_ABORTED') {
      showToast(t('settings.voiceModelActionFailed', { msg: msg.message || msg.code || '' }), 'error');
    }
    _hideVoiceModelRowProgress(msg.modelId);
    _refreshVoiceModelRowsIfOpen();
    return;
  }
  if (msg.type === 'voice-model:deleted') {
    // (C1197) No toast here — the window that clicked Delete shows its own. This branch just
    // repaints every OTHER open window's row (ready -> missing) off the shared store.
    _hideVoiceModelRowProgress(msg.modelId);
    _refreshVoiceModelRowsIfOpen();
  }
}

// (C1058) Badge/hint copy for the Notifications status row — one lookup per transport/permission
// combination. Electron's renderer permission is always 'granted' (the main-process transport
// bypasses it entirely); the only failure signal there is a captured notify:show IPC error.
function _notifStatusKey(status) {
  if (status.transport === 'unsupported') return 'settings.notifStateUnsupported';
  if (status.transport === 'electron') return status.lastError ? 'settings.notifStateBlocked' : 'settings.notifStateNative';
  switch (status.permission) {
    case 'granted': return 'settings.notifStateAllowed';
    case 'denied': return 'settings.notifStateBlocked';
    default: return 'settings.notifStateNotAsked';
  }
}

// Populate the Notifications status row in the Settings modal. Called each time the modal opens
// so it reflects the current transport/permission state, which can change between opens (a Test
// press, or the OS permission being flipped in System Settings).
// (C1259) Settings ▸ Debug row — checkbox state + the log-path hint underneath it.
// state.debugPerfLog is already hydrated at boot/project-switch (applyProjectDebugPerfLog());
// this only reads the log PATH, which needs a round-trip (Electron IPC or a tiny GET) since
// it's server-computed (USER_DATA_ROOT isn't known client-side). Called on modal open and
// right after the toggle itself changes.
function _populateSettingsDebugRow() {
  const toggle = document.getElementById('settings-debug-perf-toggle');
  if (toggle) toggle.checked = !!state.debugPerfLog;
  const hint = document.getElementById('settings-debug-perf-hint');
  const pathSpan = document.getElementById('settings-debug-perf-path');
  const revealBtn = document.getElementById('settings-debug-perf-reveal');
  if (!hint || !pathSpan) return;
  hint.hidden = !state.debugPerfLog;
  if (!state.debugPerfLog) return;
  (async () => {
    let info = { path: '' };
    try {
      if (window.electronAPI?.api?.debug?.perfLogInfo) {
        info = await window.electronAPI.api.debug.perfLogInfo();
      } else {
        const r = await fetch('/api/debug/perf');
        if (r.ok) info = await r.json();
      }
    } catch { /* ignore — leave the hint blank rather than error the whole modal */ }
    pathSpan.textContent = info.path || '';
    if (revealBtn) revealBtn.hidden = !window.electronAPI?.revealPerfLog;
  })();
}

// (C1318) Async — re-verifies against main.js's live notify:status (bundle seal +
// Notification Center registration) before rendering, instead of only ever showing the
// boot-time snapshot notifications.js captured at module load. No-op/instant outside
// Electron. Callers are fire-and-forget (unchanged) — the DOM updates once the refresh
// settles rather than blocking the modal open.
async function _populateSettingsNotificationsRows() {
  await refreshNotificationStatus();

  const stateEl = document.getElementById('settings-notifications-state');
  const testBtn = document.getElementById('settings-notifications-test');
  const hintEl = document.getElementById('settings-notifications-hint');
  const hintTextEl = document.getElementById('settings-notifications-hint-text');
  const repairBtn = document.getElementById('settings-notifications-repair');
  if (!stateEl && !testBtn) return;

  const status = getNotificationStatus();
  if (stateEl) stateEl.textContent = t(_notifStatusKey(status));

  if (testBtn) {
    const needsEnable = status.transport === 'web' && status.permission === 'default';
    testBtn.textContent = needsEnable ? t('settings.notifEnable') : t('settings.notifTest');
    testBtn.disabled = status.transport === 'unsupported'
      || (status.transport === 'web' && status.permission === 'denied');
  }

  if (hintEl) {
    const blocked = status.transport === 'unsupported'
      || status.permission === 'denied'
      || (status.transport === 'electron' && status.lastError);
    // (C1125) 'unsigned' gets its own hint — "notifications blocked, go check System
    // Settings" sends the user chasing a permission that was never the problem.
    // (C1141) 'seal-broken' likewise — the bundle WAS signed, but its seal broke at runtime
    // (see tt-notifications.md § C1141); naming that (and that a relaunch, not a System
    // Settings change, is the fix) beats the generic blocked hint here too.
    // (C1318) 'not-registered' — signed AND seal valid, but macOS never connected the bundle
    // to Notification Center anyway (the direct registration probe, not an inferred cause);
    // a relaunch is the fix here too, same as seal-broken.
    // (C1355) 'not-registered' gets a more specific hint when the actual cause (other bundles
    // claiming the same identifier) is known — falls back to the generic not-registered hint
    // when conflicts is null/0 (e.g. non-darwin, or the LaunchServices check itself failed).
    const mountedVolume = status.installerVolumes?.[0];
    const notRegisteredHint = status.conflicts
      ? (mountedVolume
        ? t('settings.notifHintDuplicateBundlesWithVolume', { count: status.conflicts, volume: mountedVolume.split('/').pop() })
        : t('settings.notifHintDuplicateBundles', { count: status.conflicts }))
      : t('settings.notifHintNotRegistered');
    if (hintTextEl) {
      hintTextEl.textContent = status.transport === 'unsupported' ? t('settings.notifHintUnsupported')
        : status.lastError === 'unsigned' ? t('settings.notifHintUnsigned')
        : status.lastError === 'seal-broken' ? t('settings.notifHintSealBroken')
        : status.lastError === 'not-registered' ? notRegisteredHint
        : (blocked ? t('settings.notifHintBlocked') : '');
    }
    hintEl.hidden = !blocked;
    // (C1355) Repair button only makes sense when there's an actual duplicate-claimant conflict
    // to fix — for every other blocked reason (unsigned, seal-broken, denied, unsupported) it
    // would just fail with nothing to repair.
    if (repairBtn) {
      repairBtn.hidden = !(status.lastError === 'not-registered' && status.conflicts > 0);
      repairBtn.textContent = t('settings.notifRepairBtn');
    }
  }

  // (C1137) macOS-only Banner-vs-Alert hint — only the OS setting itself can make banners
  // stack and persist; the in-app card stack (notification-center.js) is the other half of
  // the answer and needs no Settings row of its own since it just works everywhere.
  const styleHint = document.getElementById('settings-notifications-style-hint');
  if (styleHint) {
    const isMac = window.electronAPI?.platform === 'darwin';
    styleHint.hidden = !isMac;
    if (isMac) {
      const textEl = document.getElementById('settings-notifications-style-text');
      const btnEl = document.getElementById('settings-notifications-style-btn');
      if (textEl) textEl.textContent = t('settings.notifHintStyleMac');
      if (btnEl) btnEl.textContent = t('settings.notifOpenSystemSettings');
    }
  }
}

// Populate the Settings "Agents" row summary — reads the WINDOW'S REAL project config
// (Electron: api:project.config(), which re-reads disk; browser: GET /api/agents-config),
// NOT state.taskAgent/state.availableAgents — those reflect the forked server's process-
// global config singleton, seeded from whichever project the server started up against
// (wrong project in multi-window Electron; a location inside the packaged app bundle if
// TIPATASK_PROJECT_ROOT was never set at all) rather than necessarily this window's project.
// agentsSummary, when passed (agents-modal.js's onSaved callback), skips the re-fetch.
async function _populateSettingsAgentsRow(agentsSummary) {
  const row = document.getElementById('settings-agents-row');
  const el = document.getElementById('settings-agents-summary');
  if (!row || !el) return;
  let agents = agentsSummary;
  if (!agents) {
    try {
      if (window.electronAPI?.api) {
        const ctx = await window.electronAPI.api.project.config();
        if (!ctx) { row.style.display = 'none'; return; } // no project bound to this window
        agents = ctx.agents;
      } else {
        const r = await fetch('/api/agents-config', { cache: 'no-store' });
        agents = r.ok ? (await r.json()).agents : null;
      }
    } catch (err) { console.error('[settings] Failed to load agents summary:', err.message); }
  }
  row.style.display = '';
  el.textContent = agents?.summary || t('settings.agentsNone');
  el.title = el.textContent;
}

let _settingsModalWired = false;
export function initSettingsModal() {
  if (_settingsModalWired) return;
  _settingsModalWired = true;
  // (C1199) Fire at boot, independent of whether #settings-modal markup exists — mics on the
  // board (New Task title/desc, New Objective chat input, any open terminal) need their
  // correct disabled/enabled state before the user ever opens Settings.
  refreshVoiceInputAvailability();
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  // (C1155) Hamburger trigger removed — Settings now opens only via the Electron
  // Project menu (Project → Settings…, ⌘,), wired through onProjectMenu() in template.html.
  modal.querySelector('.settings-close')?.addEventListener('click', closeSettingsModal);
  // (C1178) General/Voice tab switching — same pattern as the task-edit modal's
  // switchTab() (~line 3379), simplified: no per-tab side effects needed here. Panels are
  // `.settings-body.modal-tab-panel` siblings of `.modal-tabs`, not nested inside a shared
  // wrapper (see template.html's C1178 comment for why), so this queries the modal root
  // directly rather than a `.settings-body` ancestor.
  modal.querySelectorAll('.modal-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modal.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      modal.querySelectorAll('.modal-tab-panel').forEach(panel => {
        panel.hidden = panel.dataset.tab !== btn.dataset.tab;
      });
      // (C1204) _populateSettingsVoiceTab() (called once per modal OPEN, not per tab switch)
      // only allows the label-unlock capture when Voice is already the active tab at that
      // moment — switching to Voice afterward needs its own trigger, now that the panel is
      // actually visible. Re-reads config rather than caching it — cheap, same "reflect
      // reality on demand" idiom as the rest of this tab.
      if (btn.dataset.tab === 'voice') {
        readProjectVoiceSettings().then(s => _populateVoiceInputDeviceSelect(s.voiceInputDeviceId, { allowUnlock: true }));
      }
    });
  });
  _wireVoiceAssemblyaiRow();
  _wireVoiceKeyButtons();
  _wireVoiceInputDeviceSelect();
  _wireVoiceShortcutSelect();
  // (C1204) Repopulate on hardware change (device plugged/unplugged) while Voice is the
  // visible tab — debounced (macOS/Windows can fire several devicechange events per physical
  // plug event) and gated behind isAnyVoiceCaptureActive() the same way the initial populate
  // is, via _populateVoiceInputDeviceSelect()'s own guard.
  if (navigator.mediaDevices) {
    let deviceChangeTimer = 0;
    navigator.mediaDevices.addEventListener('devicechange', () => {
      clearTimeout(deviceChangeTimer);
      deviceChangeTimer = setTimeout(() => {
        const voicePanelVisible = modal.classList.contains('open')
          && !document.querySelector('.modal-tab-panel[data-tab="voice"]')?.hidden;
        if (!voicePanelVisible) return;
        readProjectVoiceSettings().then(s => _populateVoiceInputDeviceSelect(s.voiceInputDeviceId, { allowUnlock: true }));
      }, 300);
    });
  }
  _wireSettingsWorkflowTab();
  // Backdrop click closes
  modal.addEventListener('click', (e) => { if (e.target === modal) closeSettingsModal(); });
  // Escape closes (only when open; other Escape handlers keep their own guards)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeSettingsModal();
  });
  // Theme select inside the modal — wired once (element is static, not in #app).
  const themeSelect = modal.querySelector('#settings-theme-select');
  if (themeSelect) {
    themeSelect.addEventListener('change', (e) => setTheme(e.target.value));
  }
  // Agents row Edit button — wired once; opens the Edit Agents modal (agents-modal.js),
  // which handles the actual TASK_AGENT/AVAILABLE_AGENTS/PI_MODELS/CLAUDE_MODEL/CODEX_MODEL
  // save as one write. onSaved relabels this row without a full reload.
  const agentsEditBtn = modal.querySelector('#settings-agents-edit');
  if (agentsEditBtn) {
    agentsEditBtn.addEventListener('click', () => {
      openAgentsModal({ onSaved: (agents) => _populateSettingsAgentsRow(agents) });
    });
  }
  // Language select — project-wide setting; value repopulated on each open.
  const languageSelect = modal.querySelector('#settings-language-select');
  if (languageSelect) {
    let _prevLanguage = languageSelect.value || 'en';
    languageSelect.addEventListener('focus', () => { _prevLanguage = languageSelect.value || 'en'; });
    languageSelect.addEventListener('change', (e) => {
      const prev = _prevLanguage;
      _prevLanguage = e.target.value;
      writeProjectLanguage(e.target.value, prev);
    });
  }
  // (C1271) Group Tasks Into select — Workflow tab, project-wide setting; value
  // repopulated on each open by _populateSettingsGroupLabelRow(). Same
  // focus-captures-prev / change idiom as the language select above.
  const groupLabelSelect = modal.querySelector('#settings-task-group-label');
  if (groupLabelSelect) {
    let _prevGroupLabel = groupLabelSelect.value || DEFAULT_TASK_GROUP_LABEL;
    groupLabelSelect.addEventListener('focus', () => { _prevGroupLabel = groupLabelSelect.value || DEFAULT_TASK_GROUP_LABEL; });
    groupLabelSelect.addEventListener('change', (e) => {
      const prev = _prevGroupLabel;
      _prevGroupLabel = e.target.value;
      writeProjectGroupLabel(e.target.value, prev);
    });
  }
  // (C1332) Show Sprints checkbox — Workflow tab, project-wide setting; value/caption
  // repopulated on each open by _populateSettingsSprintsRow(). Same wired-once idiom as the
  // debug toggle below, but writes through the API (project-wide) like the group-label select.
  const sprintsToggle = modal.querySelector('#settings-sprints-enabled-toggle');
  if (sprintsToggle) {
    sprintsToggle.addEventListener('change', (e) => {
      writeProjectSprintsEnabled(e.target.checked, !e.target.checked);
    });
  }
  // (C1558) Use Objective Tasks Grouping checkbox — Workflow tab, project-wide setting;
  // value/caption repopulated on each open by _populateSettingsObjectiveGroupingRow(). Same
  // wired-once idiom as the sprints toggle above.
  const objectiveGroupingToggle = modal.querySelector('#settings-objective-grouping-toggle');
  if (objectiveGroupingToggle) {
    objectiveGroupingToggle.addEventListener('change', (e) => {
      writeProjectObjectiveGrouping(e.target.checked, !e.target.checked);
    });
  }
  // (C1490) Sync as you go checkbox — Memory tab, project-wide setting; value/caption
  // repopulated on each open by _populateSettingsMemoryTab(). Same wired-once idiom as the
  // sprints toggle above.
  const kbSyncToggle = modal.querySelector('#settings-kb-sync-toggle');
  if (kbSyncToggle) {
    kbSyncToggle.addEventListener('change', (e) => {
      writeProjectKbSyncAsYouGo(e.target.checked, !e.target.checked);
    });
  }
  // (TPT62) Version Control tab — the radio/checkbox inputs are re-rendered on every
  // open (VCS_TYPES/VCS_GIT_FLAGS-driven, see _populateSettingsVersionControlTab()), so
  // listeners are delegated on the two stable containers rather than bound to the inputs
  // themselves, same wired-once-per-modal idiom as every other control here.
  const vcsTypeOptions = modal.querySelector('#settings-vcs-type-options');
  if (vcsTypeOptions) {
    vcsTypeOptions.addEventListener('change', (e) => {
      if (!e.target.matches('input[name="settings-vcs-type"]')) return;
      const prev = _vcsSettings;
      const nextType = e.target.value;
      // Flip the checkbox block's visibility immediately, before the PATCH resolves —
      // same as the web twin's renderVersionControlTab() toggle handler.
      const gitOptions = document.getElementById('settings-vcs-git-options');
      if (gitOptions) gitOptions.hidden = nextType !== 'git';
      writeProjectVcs(nextType, prev.flags, prev);
    });
  }
  const vcsGitOptions = modal.querySelector('#settings-vcs-git-options');
  if (vcsGitOptions) {
    vcsGitOptions.addEventListener('change', (e) => {
      if (!e.target.matches('input[data-field]')) return;
      const prev = _vcsSettings;
      const nextFlags = { ...prev.flags, [e.target.dataset.field]: e.target.checked };
      writeProjectVcs(prev.type, nextFlags, prev);
    });
  }
  // Notifications: status/Test button — wired once; labels/values repopulated on each open via
  // _populateSettingsNotificationsRows(). sendTestNotification() itself requests permission first
  // when it's still 'default', so the button doubles as the "Enable" gesture (see
  // _populateSettingsNotificationsRows()'s label swap).
  const notifTestBtn = modal.querySelector('#settings-notifications-test');
  if (notifTestBtn) {
    notifTestBtn.addEventListener('click', async () => {
      notifTestBtn.disabled = true;
      const res = await sendTestNotification(t('settings.notifTestTitle'), t('settings.notifTestBody'));
      if (!res.ok) showToast(t('settings.notifTestFailed', { reason: res.reason || '' }), 'error');
      _populateSettingsNotificationsRows();
    });
  }
  // (C1259) Debug ▸ click-to-render perf logging toggle + log-path hint buttons — wired
  // once; state/path repopulated on each open via _populateSettingsDebugRow().
  const debugToggle = modal.querySelector('#settings-debug-perf-toggle');
  if (debugToggle) {
    debugToggle.addEventListener('change', (e) => {
      state.debugPerfLog = e.target.checked;
      writeDebugPerfLog(state.debugPerfLog);
      _populateSettingsDebugRow();
    });
  }
  const debugCopyBtn = modal.querySelector('#settings-debug-perf-copy');
  if (debugCopyBtn) {
    debugCopyBtn.addEventListener('click', async () => {
      const pathSpan = document.getElementById('settings-debug-perf-path');
      const text = pathSpan ? pathSpan.textContent : '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        showToast('Log path copied', 'success');
      } catch {
        showToast('Could not copy — select and copy the path manually', 'error');
      }
    });
  }
  const debugRevealBtn = modal.querySelector('#settings-debug-perf-reveal');
  if (debugRevealBtn) {
    debugRevealBtn.addEventListener('click', () => {
      window.electronAPI?.revealPerfLog?.();
    });
  }
  // (C1137) macOS-only: no app-side API sets Banner-vs-Alert style (Electron's Notification is
  // UNUserNotificationCenter-backed there), so the button just deep-links to the one place that
  // can — System Settings › Notifications › TipATask, where the user picks "Alerts".
  const notifStyleBtn = modal.querySelector('#settings-notifications-style-btn');
  if (notifStyleBtn) {
    notifStyleBtn.addEventListener('click', () => {
      window.electronAPI?.openNotificationSettings?.();
    });
  }
  // (C1355) Repair: re-registers the running bundle with LaunchServices so it becomes the
  // freshest claimant of com.tipatask.app — wired once, shown/hidden per open by
  // _populateSettingsNotificationsRows() above. Still needs a relaunch afterward (usernoted only
  // decides Notification Center registration at process launch), same as the C1318 seal-repair
  // path — the toast says so instead of silently leaving the row in a stale "fixed" state.
  const notifRepairBtn = modal.querySelector('#settings-notifications-repair');
  if (notifRepairBtn) {
    notifRepairBtn.addEventListener('click', async () => {
      notifRepairBtn.disabled = true;
      const res = await repairNotificationRegistration();
      notifRepairBtn.disabled = false;
      showToast(res.ok ? t('settings.notifRepairSucceeded') : t('settings.notifRepairFailed', { reason: res.reason || '' }), res.ok ? 'success' : 'error');
      _populateSettingsNotificationsRows();
    });
  }
  // Apply authoritative per-project theme on first open.
  applyProjectTheme();
}

// Page-level command bridge. Task Edit owns its state and DOM lifecycle; board supplies
// shared New Task controls and card/session actions without an editor-to-board import.
configureTaskEditModal({
  _createMemberCombobox, _memberLabelFor, _renderMemberCombobox,
  refreshProjectMembers, _ensureProjectTags, _ensureProjectTaskList,
  _projectTaskIndex, _projectTagName, _depTitleFor, _createDepsChipInput,
  renderAgentPicker, initAgentPicker, _taskAgentPickerOptions,
  _applyAgentPickerSelection, isAgentLocked,
  showReiterateModal, showDeleteConfirmModal, terminateSessionFromCard,
  updateClaudeButtons, applyParentSprintFollow, writeProjectBrowserTools,
  attachImagePaste,
  renderAgentBadge, refreshCard, regroupCardToSprint, regroupNeedsReload,
  isTaskReadOnly, hasUnmetDeps, unmetDependencyKeys, canStartTaskCard,
  sprintTierKeys, STOP_ICON,
  getProjectTaskList: () => _cachedProjectTaskList,
  resetProjectTaskList: () => { _cachedProjectTaskList = null; },
  getCachedProjectConfig: () => _cachedProjectConfig,
  setCachedProjectConfig: cfg => { _cachedProjectConfig = cfg; },
});
