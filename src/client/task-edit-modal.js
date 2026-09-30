// Task Edit modal controller. Board and shared-form commands are configured by the page shell.
// Importing this module does not initialize the board, terminal, or chat modules.
import state from './state.js';
import { t, tc } from './i18n.js';
import { agentModelOptions, ensureAgentModels, EFFORT_LEVELS, EFFORT_LABELS } from './constants.js';
import { statusNames, statusLabel, statusColor, isInProgressName, startName } from './status-registry.js';
import { sessionButtonMode, SESSION_BUTTON_MODES } from './session-button-state.js';
import { escapeAttr, insertAtCursor, autoGrowTextarea, renderMarkdown, renderSprintCombobox, initSprintCombobox, showToast, showBoardLoader, hideBoardLoader, showActionBanner, hideActionBanner, taskOpenErrorLabel, sprintRecordMax } from './utils.js';
import { api } from './api-client.js';
import { isTaskDiscussing, lockIntentOf, lockMessageKey } from './discuss-lock.js';
import { buildMentionCandidates, highlightMentionsInHtml, AGENT_HANDLES } from './mention-highlight.js';
import { sanitizeMarkdownHtml } from './markdown-sanitize.js';
import { diffWords, opsToRanges, highlightPlainText, normalizeRaw, summarizeMetadata, collectTextSegments, applyRanges, markStructuralBlockChanges, mapRenderedOffsetToRaw } from './modified-task-diff.js';
import { hydrateModifiedCard } from './modified-task-merge.js';
import { attachAudioRecorder } from './audio-recorder.js';
import { clearAttention, mergeSessionsSnapshot } from './attention-state.js';
import { syncActivityChips, activityIds, markActivityRead, unmarkActivityRead } from './task-activity.js';
import { taskHasNullSprint } from './board-count-domain.js';
import { groupNoun, groupTitle, getSprintsEnabled } from './group-label.js';
import { perfStart, perfEnd } from './perf-log.js';
import { tagDescription, filterTagOptions } from './tag-match.js';
import { showActionConfirm } from './action-confirm.js';
import { activateDialogFocus } from './dialog-focus.js';

let commands;
export function configureTaskEditModal(boardCommands) {
  commands = boardCommands;
}

export function replaceModalImageBlobUrl(blobUrl, url) {
  if (!_modalState?.draft?.description?.includes(blobUrl)) return false;
  _modalState.draft.description = _modalState.draft.description.split(blobUrl).join(url);
  const descDisplay = document.querySelector('#task-edit-modal .modal-desc-display:not([data-diff-side="old"])');
  if (descDisplay && descDisplay.style.display !== 'none') {
    const modal = document.getElementById('task-edit-modal');
    if (_modalState.compareTask && modal) _applyModalDiffHighlights(modal);
    else descDisplay.innerHTML = _renderDescriptionHtml(_modalState.draft.description);
  }
  return true;
}

let _modalState = null;
let _modalDialogFocus = null;
let _mentionDropdown = null;
let _mentionState = null;
let _taskEditNavigationHandler = null;

export function registerTaskEditNavigation(handler) {
  _taskEditNavigationHandler = typeof handler === 'function' ? handler : null;
}

export function openTaskEditModalFromTerminal(taskId) {
  if (!taskId) return Promise.resolve();
  if (_taskEditNavigationHandler) return _taskEditNavigationHandler(taskId);
  state.activeTab = 'board';
  document.dispatchEvent(new Event('tiptask:reload'));
  return openTaskEditModal(taskId);
}

let _commentSeenObserver = null;
let _notifSeenObserver = null; // (TPT17) IntersectionObserver for the Notifications tab
const _START_SVG  = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><polygon points="3,2 14,8 3,14"/></svg>';
const _SPLIT_SVG  = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="4" cy="11" r="2"/><circle cx="4" cy="5" r="2"/><line x1="5.5" y1="6" x2="14" y2="14"/><line x1="5.5" y1="10" x2="14" y2="2"/></svg>';
const _DELETE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M2 4h12"/><path d="M5.333 4V2.667a1.333 1.333 0 0 1 1.334-1.334h2.666a1.333 1.333 0 0 1 1.334 1.334V4"/><path d="M12.667 4v9.333a1.333 1.333 0 0 1-1.334 1.334H4.667a1.333 1.333 0 0 1-1.334-1.334V4"/><path d="M6.667 7.333v4"/><path d="M9.333 7.333v4"/></svg>';
const _GENERAL_TAB_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M11.5 2.5l2 2L6 12H4v-2l7.5-7.5z"/><path d="M9.5 4.5l2 2"/></svg>';
const _COMMENTS_TAB_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 3.5h10a1.5 1.5 0 0 1 1.5 1.5v4.5A1.5 1.5 0 0 1 13 11H7l-3.5 2v-2H3A1.5 1.5 0 0 1 1.5 9.5V5A1.5 1.5 0 0 1 3 3.5z"/></svg>';
// (TPT17) Notifications tab — bell icon, same stroke style as the other tab icons.
const _NOTIF_TAB_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M8 1.5c-2 0-3.5 1.5-3.5 3.5v2.3c0 .5-.2 1-.6 1.4L3 9.7c-.3.3-.1.8.3.8h9.4c.4 0 .6-.5.3-.8l-.9-1c-.4-.4-.6-.9-.6-1.4V5c0-2-1.5-3.5-3.5-3.5z"/><path d="M6.5 12.5a1.5 1.5 0 0 0 3 0"/></svg>';
const _WAND_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M2 14l7-7"/><path d="M11 1.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/><path d="M14 7l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z"/></svg>';

function _modalUnmetDependencyKeys(task) {
  return commands.unmetDependencyKeys(task, commands._projectTaskIndex());
}

function _syncModalStartDependencyState(modal, task = _modalState?.draft) {
  const btn = modal?.querySelector('.modal-context-btns [data-action="start"]');
  if (!btn || !task) return;
  const taskIndex = commands._projectTaskIndex();
  const blocked = commands.hasUnmetDeps(task, taskIndex);
  const blockers = blocked ? commands.unmetDependencyKeys(task, taskIndex) : [];
  btn.disabled = blocked;
  btn.classList.toggle('deps-blocked', blocked);
  btn.title = blocked
    ? t('tooltip.waitingForDependencies', { ids: blockers.join(', ') })
    : _modalSessionButton(task).title;
}

// (TPT374) Footer Start/Resume/Show button state — icon, caption, and tooltip — for a given
// task. Mode is read off the task's SAVED status (`_modalState.lastSaved`), not `draft`: an
// unsaved status-select edit must not flip the button ahead of what clicking it would actually
// do (persistDraft() runs before launch either way — see § Save before Start, C1316). Falls
// back to `task.status` when no modal session is open yet (e.g. a cold call before
// openTaskEditModal() finishes populating `_modalState`).
function _modalSessionButton(task) {
  const savedStatus = _modalState?.lastSaved?.status ?? task?.status;
  const active = !!task && state.activeSessions.has(task.id);
  const exited = !!task && state.exitedSessions.has(task.id);
  const mode = sessionButtonMode(savedStatus, { active, exited });
  if (mode === SESSION_BUTTON_MODES.RUNNING) {
    return { mode, icon: '<span class="session-spinner" aria-hidden="true"></span>', label: t('btn.show'), title: t('tooltip.showRunningSession') };
  }
  if (mode === SESSION_BUTTON_MODES.RESUME) {
    return { mode, icon: _START_SVG, label: t('btn.resume'), title: t('tooltip.resumeTaskSession') };
  }
  return { mode, icon: _START_SVG, label: t('btn.start'), title: t('tooltip.startTaskSession') };
}

function _depTitleFor(key) {
  const candidates = Array.isArray(_modalState?.callbacks?.depCandidates) ? _modalState.callbacks.depCandidates : [];
  return commands._depTitleFor(key, candidates);
}

// Exported (with _statusOptionsHtml, _agentModelControlHtml, _applyModalAgentModelVisibility
// below): the New Task form in task-board.js renders and repaints through the same builders.
export function _renderDepChip(key) {
  const title = _depTitleFor(key);
  return `<span class="dep-chip modal-dep-chip" data-dep="${escapeAttr(key)}"${title ? ` title="${escapeAttr(title)}"` : ''}>${escapeAttr(key)}<button class="chip-remove" type="button" data-dep="${escapeAttr(key)}">&times;</button></span>`;
}

function _commentSeenKey(taskId) {
  return `tc-seen-${taskId}`;
}

function _commentId(comment) {
  const id = Number(comment?.id);
  return Number.isFinite(id) ? id : 0;
}

function _getSeenCommentId(taskId) {
  try {
    const stored = Number(localStorage.getItem(_commentSeenKey(taskId)));
    return Number.isFinite(stored) ? stored : 0;
  } catch {
    return 0;
  }
}

function _setSeenCommentId(taskId, id) {
  const next = Number(id);
  if (!Number.isFinite(next) || next <= 0) return;
  const current = _getSeenCommentId(taskId);
  if (next <= current) return;
  try {
    localStorage.setItem(_commentSeenKey(taskId), String(Math.floor(next)));
  } catch { /* localStorage may be unavailable */ }
}

function _modalUnreadCommentCount() {
  if (!_modalState) return 0;
  const seen = _getSeenCommentId(_modalState.taskId);
  return (_modalState.comments || []).filter(comment => _commentId(comment) > seen).length;
}

function _renderUnreadBadge() {
  const unread = _modalUnreadCommentCount();
  return unread > 0 ? `<span class="unread-badge">${escapeAttr(unread)}</span>` : '';
}

function _updateUnreadBadge(modal) {
  if (!modal || !_modalState) return;
  const btn = modal.querySelector('.modal-tab-btn[data-tab="comments"]');
  if (!btn) return;
  const unread = _modalUnreadCommentCount();
  let badge = btn.querySelector('.unread-badge');
  if (unread > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'unread-badge';
      btn.appendChild(badge);
    }
    badge.textContent = String(unread);
  } else if (badge) {
    badge.remove();
  }
}

function _disconnectCommentSeenObserver() {
  if (_commentSeenObserver) _commentSeenObserver.disconnect();
  _commentSeenObserver = null;
}

function _observeVisibleComments(modal) {
  _disconnectCommentSeenObserver();
  if (!modal || !_modalState || typeof IntersectionObserver === 'undefined') return;
  const panel = modal.querySelector('.modal-tab-panel[data-tab="comments"]');
  if (!panel || panel.hidden) return;
  const items = [...panel.querySelectorAll('.comment-item')];
  if (!items.length) return;

  // (TPT54) .modal-scroll-body is now the actual scrolling viewport; fall back to the
  // panel for any render path that lacks the wrapper.
  const root = modal.querySelector('.modal-scroll-body') || modal.querySelector('.task-edit-panel') || null;
  _commentSeenObserver = new IntersectionObserver((entries, observer) => {
    let changed = false;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = Number(entry.target.dataset.commentId);
      if (Number.isFinite(id) && id > 0) {
        _setSeenCommentId(_modalState.taskId, id);
        changed = true;
      }
      observer.unobserve(entry.target);
    }
    if (changed) _updateUnreadBadge(modal);
  }, { root, threshold: 0.1 });

  items.forEach(item => _commentSeenObserver.observe(item));
}

// ── TPT17: Notifications tab — task-wide event log + subscription toggle.
// Seen-marker/badge/observer helpers mirror the tc-seen-* comment ones above, keyed
// te-seen-{taskId}, except the unread COUNT also excludes events authored by the current
// user (comments don't need this — you already see your own comment appended locally on
// submit and its id gets marked seen immediately).
function _notifSeenKey(taskId) {
  return `te-seen-${taskId}`;
}

function _eventId(event) {
  const id = Number(event?.id);
  return Number.isFinite(id) ? id : 0;
}

function _getSeenEventId(taskId) {
  try {
    const stored = Number(localStorage.getItem(_notifSeenKey(taskId)));
    return Number.isFinite(stored) ? stored : 0;
  } catch {
    return 0;
  }
}

function _setSeenEventId(taskId, id) {
  const next = Number(id);
  if (!Number.isFinite(next) || next <= 0) return;
  const current = _getSeenEventId(taskId);
  if (next <= current) return;
  try {
    localStorage.setItem(_notifSeenKey(taskId), String(Math.floor(next)));
  } catch { /* localStorage may be unavailable */ }
}

function _modalUnreadEventCount() {
  if (!_modalState) return 0;
  const seen = _getSeenEventId(_modalState.taskId);
  return (_modalState.events || []).filter(event => {
    if (_eventId(event) <= seen) return false;
    const actorId = event?.actor?.id;
    // No actor (system event) or unknown current user → fail toward counting it unread,
    // never toward silently suppressing the badge.
    return actorId == null || state.currentUserId == null || Number(actorId) !== Number(state.currentUserId);
  }).length;
}

function _renderNotifUnreadBadge() {
  const unread = _modalUnreadEventCount();
  return unread > 0 ? `<span class="unread-badge">${escapeAttr(unread)}</span>` : '';
}

function _updateNotifUnreadBadge(modal) {
  if (!modal || !_modalState) return;
  const btn = modal.querySelector('.modal-tab-btn[data-tab="notifications"]');
  if (!btn) return;
  const unread = _modalUnreadEventCount();
  let badge = btn.querySelector('.unread-badge');
  if (unread > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'unread-badge';
      btn.appendChild(badge);
    }
    badge.textContent = String(unread);
  } else if (badge) {
    badge.remove();
  }
}

function _disconnectNotifSeenObserver() {
  if (_notifSeenObserver) _notifSeenObserver.disconnect();
  _notifSeenObserver = null;
}

function _observeVisibleEvents(modal) {
  _disconnectNotifSeenObserver();
  if (!modal || !_modalState || typeof IntersectionObserver === 'undefined') return;
  const panel = modal.querySelector('.modal-tab-panel[data-tab="notifications"]');
  if (!panel || panel.hidden) return;
  const items = [...panel.querySelectorAll('.notif-event-item')];
  if (!items.length) return;

  // (TPT54) .modal-scroll-body is now the actual scrolling viewport; fall back to the
  // panel for any render path that lacks the wrapper.
  const root = modal.querySelector('.modal-scroll-body') || modal.querySelector('.task-edit-panel') || null;
  _notifSeenObserver = new IntersectionObserver((entries, observer) => {
    let changed = false;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = Number(entry.target.dataset.eventId);
      if (Number.isFinite(id) && id > 0) {
        _setSeenEventId(_modalState.taskId, id);
        changed = true;
      }
      observer.unobserve(entry.target);
    }
    if (changed) _updateNotifUnreadBadge(modal);
  }, { root, threshold: 0.1 });

  items.forEach(item => _notifSeenObserver.observe(item));
}

async function _loadModalEvents(taskId) {
  try {
    const data = await api.tasks.events.list(taskId);
    if (!_modalState || _modalState.taskId !== taskId) return;
    _modalState.events = data?.events || [];
    _modalState.subscribed = data?.subscribed !== false;
    _modalState.eventsLoading = false;
    _modalState.eventsError = '';
  } catch (err) {
    if (!_modalState || _modalState.taskId !== taskId) return;
    _modalState.eventsLoading = false;
    _modalState.eventsError = err.message || t('notif.errLoad');
  }
  const modal = document.getElementById('task-edit-modal');
  _renderModalEvents(modal);
  _syncSubscribedCheckbox(modal);
}

function _renderEventItem(event) {
  const name = event?.actor?.name || event?.actor?.email || t('comments.unknownUser');
  const timestamp = _formatTimestamp(event?.created_at);
  return `
    <div class="notif-event-item" data-event-id="${escapeAttr(event?.id || '')}">
      <div class="notif-event-icon">${_NOTIF_TAB_SVG}</div>
      <div class="notif-event-content">
        <div class="notif-event-meta"><strong>${escapeAttr(name)}</strong>${timestamp ? `<span>${escapeAttr(timestamp)}</span>` : ''}</div>
        <div class="notif-event-title">${escapeAttr(event?.title || '')}</div>
        ${event?.body ? `<div class="notif-event-body">${escapeAttr(event.body)}</div>` : ''}
      </div>
    </div>`;
}

function _renderModalEvents(modal) {
  if (!modal || !_modalState) return;
  const list = modal.querySelector('.notif-events-list');
  if (!list) return;
  _disconnectNotifSeenObserver();
  if (_modalState.eventsLoading) {
    list.innerHTML = `<div class="notif-event-empty">${t('notif.loading')}</div>`;
    _updateNotifUnreadBadge(modal);
    return;
  }
  if (_modalState.eventsError) {
    list.innerHTML = `<div class="notif-event-empty">${escapeAttr(_modalState.eventsError)}</div>`;
    _updateNotifUnreadBadge(modal);
    return;
  }
  const events = _modalState.events || [];
  list.innerHTML = events.length
    ? events.map(_renderEventItem).join('')
    : `<div class="notif-event-empty">${t('notif.empty')}</div>`;
  _updateNotifUnreadBadge(modal);
  _observeVisibleEvents(modal);
}

function _syncSubscribedCheckbox(modal) {
  if (!modal || !_modalState) return;
  const checkbox = modal.querySelector('.modal-notif-subscribed-checkbox');
  if (checkbox) checkbox.checked = _modalState.subscribed !== false;
}

async function _loadModalComments(taskId) {
  try {
    const comments = await api.tasks.comments.list(taskId);
    if (!_modalState || _modalState.taskId !== taskId) return;
    const loaded = (comments || []).slice().reverse();
    const loadedIds = new Set(loaded.map(c => c.id));
    const pending = (_modalState.comments || []).filter(c => !loadedIds.has(c.id));
    _modalState.comments = _sortModalComments([...pending, ...loaded]);
    _modalState.commentsLoading = false;
    _modalState.commentsError = '';
  } catch (err) {
    if (!_modalState || _modalState.taskId !== taskId) return;
    _modalState.commentsLoading = false;
    _modalState.commentsError = err.message || t('comments.errLoad');
  }
  _renderModalComments(document.getElementById('task-edit-modal'));
}

function _commentUserName(comment) {
  const user = comment?.user || {};
  return user.name || user.email || t('comments.unknownUser');
}

function _commentInitial(name) {
  const s = String(name || '').trim();
  return s ? s[0].toUpperCase() : '?';
}

function _formatTimestamp(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// (TPT34) Typeahead suggestion list — distinct from the highlighter's candidate table
// (_mentionCandidates() below, mention-highlight.js): this one drives what the dropdown
// SHOWS and INSERTS (one row per member, the display name), searchable by either name or
// email local-part; the highlighter matches either handle form independently once typed.
function _getMentionSuggestions() {
  const seen = new Set();
  const out = [];
  for (const m of (state.projectMembers || [])) {
    const name = m?.name && String(m.name).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const localPart = m?.email ? String(m.email).split('@')[0].toLowerCase() : '';
    out.push({ name, search: localPart ? `${key} ${localPart}` : key });
  }
  for (const handle of AGENT_HANDLES) {
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: handle, search: key });
  }
  return out;
}

// (TPT34) Candidate table for the mention HIGHLIGHTER — server-parity matching (real
// members by name/email-local-part + agent handles), no catch-all. See mention-highlight.js.
function _mentionCandidates() {
  return buildMentionCandidates(state.projectMembers || [], AGENT_HANDLES);
}

// (TPT34) Shared entry point for anywhere rendered markdown needs mention highlighting —
// currently comment bodies (_renderCommentContent below) and the modal description
// display (_renderDescriptionHtml). Diff mode deliberately does NOT use this — see
// _applyModalDiffHighlights, which splits the same text nodes into <ins>/<del>.
function _renderDescriptionHtml(raw) {
  return sanitizeMarkdownHtml(highlightMentionsInHtml(renderMarkdown(raw || ''), _mentionCandidates()));
}

function _renderCommentContent(content) {
  const clean = String(content || '').replace(/<!--\s*trello-action:[^\s>]*\s*-->/g, '').trim();
  return sanitizeMarkdownHtml(highlightMentionsInHtml(renderMarkdown(clean), _mentionCandidates()));
}

function _sortModalComments(arr) {
  const resolutions = arr.filter(c => c.comment_type === 'resolution');
  const regular = arr.filter(c => c.comment_type !== 'resolution');
  return [...resolutions, ...regular];
}

// (TPT34) Own-comment edit gate. `resolution`/`spec` rows are machine-written audit
// records (agent-authored reports, origin-spec captures) — never editable regardless of
// author. A null comment.user.id (author account since deleted) always 403s server-side,
// so it's never offered either way. state.currentUserId == null fails OPEN (same idiom as
// task-card.js's commands.canStartTaskCard) — the author-only 403 + apiRequest's allowForbidden
// non-latching path (api-backend.js) is the real backstop, not this client-side check.
function _canEditComment(comment) {
  if ((comment?.comment_type || 'comment') !== 'comment') return false;
  const authorId = comment?.user?.id;
  if (authorId == null) return false;
  if (state.currentUserId == null) return true;
  return Number(authorId) === Number(state.currentUserId);
}

function _renderCommentItem(comment) {
  const name = _commentUserName(comment);
  const timestamp = _formatTimestamp(comment?.created_at);
  const isResolution = comment?.comment_type === 'resolution';
  const badge = isResolution ? `<span class="badge-resolution">${t('comments.resolutionBadge')}</span>` : '';
  const edited = comment?.updated_at
    ? `<span class="comment-edited" title="${escapeAttr(_formatTimestamp(comment.updated_at))}">${t('comments.edited')}</span>`
    : '';
  const isEditing = _modalState && _modalState.editingCommentId === _commentId(comment);
  const canEdit = !isEditing && _canEditComment(comment);
  const editBtn = canEdit ? `<button type="button" class="comment-edit-btn" data-act="edit">${t('comments.edit')}</button>` : '';
  const bodyHtml = isEditing
    ? `<textarea class="comment-edit-input">${escapeAttr(_modalState.editingDraft)}</textarea>
       <div class="comment-edit-actions">
         <button type="button" class="comment-edit-cancel" data-act="cancel">${t('btn.cancel')}</button>
         <button type="button" class="comment-edit-save" data-act="save">${t('btn.save')}</button>
       </div>`
    : `<div class="comment-body"${_canEditComment(comment) ? ' data-act="edit"' : ''}>${_renderCommentContent(comment?.content || '')}</div>`;
  return `
    <div class="comment-item" data-comment-id="${escapeAttr(comment?.id || '')}" data-comment-type="${escapeAttr(comment?.comment_type || 'comment')}">
      <div class="comment-avatar">${escapeAttr(_commentInitial(name))}</div>
      <div class="comment-content">
        <div class="comment-meta">${badge}<strong>${escapeAttr(name)}</strong>${timestamp ? `<span>${escapeAttr(timestamp)}</span>` : ''}${edited}${editBtn}</div>
        ${bodyHtml}
      </div>
    </div>`;
}

function _renderModalComments(modal) {
  if (!modal || !_modalState) return;
  const list = modal.querySelector('.comments-list');
  if (!list) return;
  _disconnectCommentSeenObserver();
  if (_modalState.commentsLoading) {
    list.innerHTML = `<div class="comment-empty">${t('comments.loading')}</div>`;
    _updateUnreadBadge(modal);
    return;
  }
  if (_modalState.commentsError) {
    list.innerHTML = `<div class="comment-empty">${escapeAttr(_modalState.commentsError)}</div>`;
    _updateUnreadBadge(modal);
    return;
  }
  const comments = _modalState.comments || [];
  list.innerHTML = comments.length
    ? comments.map(_renderCommentItem).join('')
    : `<div class="comment-empty">${t('comments.empty')}</div>`;
  _updateUnreadBadge(modal);
  _observeVisibleComments(modal);
  // (TPT34) The edit textarea is brand new every render — safe to attach unconditionally.
  const editTa = list.querySelector('.comment-edit-input');
  if (editTa) {
    _attachMentionTypeahead(editTa);
    editTa.focus();
    editTa.setSelectionRange(editTa.value.length, editTa.value.length);
  }
}

function _removeMentionDropdown() {
  if (_mentionDropdown) _mentionDropdown.remove();
  _mentionDropdown = null;
  _mentionState = null;
}

function _activeMention(textarea) {
  const pos = textarea.selectionStart;
  if (pos == null || pos !== textarea.selectionEnd) return null;
  const before = textarea.value.slice(0, pos);
  const match = before.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;
  return {
    start: pos - match[2].length - 1,
    end: pos,
    query: match[2].toLowerCase(),
  };
}

function _caretPoint(textarea) {
  const rect = textarea.getBoundingClientRect();
  const style = getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const props = [
    'boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'letterSpacing', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom',
    'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
    'borderLeftWidth',
  ];
  for (const prop of props) mirror.style[prop] = style[prop];
  mirror.style.position = 'fixed';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.top = `${rect.top}px`;
  mirror.style.left = `${rect.left}px`;
  mirror.style.minHeight = `${textarea.offsetHeight}px`;
  mirror.textContent = textarea.value.slice(0, textarea.selectionStart);
  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(textarea.selectionStart) || ' ';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const markerRect = marker.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 18;
  mirror.remove();
  return {
    left: markerRect.left - textarea.scrollLeft + window.scrollX,
    top: markerRect.top - textarea.scrollTop + lineHeight + window.scrollY,
  };
}

function _positionMentionDropdown(textarea) {
  if (!_mentionDropdown) return;
  const point = _caretPoint(textarea);
  _mentionDropdown.style.left = `${Math.max(8, Math.min(point.left, window.scrollX + window.innerWidth - 220))}px`;
  _mentionDropdown.style.top = `${point.top + 4}px`;
}

function _selectMention(index) {
  if (!_mentionState) return;
  const opt = _mentionState.options[index];
  if (!opt) return;
  const { textarea, start, end } = _mentionState;
  const insert = `@${opt.name} `;
  textarea.value = textarea.value.slice(0, start) + insert + textarea.value.slice(end);
  const cursor = start + insert.length;
  textarea.setSelectionRange(cursor, cursor);
  textarea.focus();
  _removeMentionDropdown();
}

function _refreshMentionDropdown(textarea) {
  const active = _activeMention(textarea);
  if (!active) {
    _removeMentionDropdown();
    return;
  }
  const options = _getMentionSuggestions()
    .filter(opt => opt.search.includes(active.query))
    .slice(0, 8);
  if (!options.length) {
    _removeMentionDropdown();
    return;
  }
  if (!_mentionDropdown) {
    _mentionDropdown = document.createElement('div');
    _mentionDropdown.className = 'mention-dropdown';
    document.body.appendChild(_mentionDropdown);
  }
  const priorIndex = _mentionState ? _mentionState.activeIndex : 0;
  _mentionState = { textarea, ...active, options, activeIndex: Math.min(priorIndex, options.length - 1) };
  _mentionDropdown.innerHTML = options.map((opt, i) =>
    `<div class="mention-option${i === _mentionState.activeIndex ? ' active' : ''}" data-index="${i}">${escapeAttr(opt.name)}</div>`
  ).join('');
  _mentionDropdown.querySelectorAll('.mention-option').forEach(option => {
    option.addEventListener('mousedown', (e) => {
      e.preventDefault();
      _selectMention(Number(option.dataset.index));
    });
  });
  _positionMentionDropdown(textarea);
}

function _moveMentionSelection(delta) {
  if (!_mentionDropdown || !_mentionState) return;
  const count = _mentionState.options.length;
  _mentionState.activeIndex = (_mentionState.activeIndex + delta + count) % count;
  _mentionDropdown.querySelectorAll('.mention-option').forEach((option, i) => {
    option.classList.toggle('active', i === _mentionState.activeIndex);
  });
}

// (TPT34) Wires the @ typeahead onto any textarea — extracted so it can be shared by the
// comment composer, the description field's dynamically-created textarea, and a comment's
// inline edit textarea, instead of being re-wired ad hoc at each call site.
//
// e.stopImmediatePropagation() (not just preventDefault) alongside every dropdown-handled
// key is load-bearing for the description field: #modal-desc-textarea has its OWN keydown
// listener (Escape → blur, see the click-to-edit handler below) on the same element. Two
// listeners both fire on one event; a bare early return only exits THIS listener, so
// without stopImmediatePropagation an Escape meant to close the mention dropdown would
// also fall through and blur the whole textarea. Call this BEFORE registering any other
// keydown listener on the same element so ordering can't matter either way.
function _attachMentionTypeahead(textarea) {
  textarea.addEventListener('keydown', (e) => {
    if (_mentionDropdown && _mentionState?.textarea === textarea) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopImmediatePropagation();
        _moveMentionSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        _moveMentionSelection(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        _selectMention(_mentionState.activeIndex);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        _removeMentionDropdown();
        return;
      }
    }
    if (e.key === '@') {
      setTimeout(() => _refreshMentionDropdown(textarea), 0);
    }
  });
  textarea.addEventListener('input', () => _refreshMentionDropdown(textarea));
  textarea.addEventListener('click', () => _refreshMentionDropdown(textarea));
  textarea.addEventListener('blur', () => setTimeout(_removeMentionDropdown, 120));
}

// (C1259) Timed wrapper — the fork-map profiling for this task found the dblclick→edit-
// modal path pays 2-3 sequential/parallel network round-trips (task/sessions/config)
// before anything paints; this measures the whole open end to end. Kept as a thin outer
// shell around the real implementation (many early returns below) for the same reason
// loadAndRender() is wrapped rather than instrumented internally.
export async function openTaskEditModal(taskId, callbacks = {}) {
  const _h = perfStart('edit-modal-open', { taskId, preloaded: !!callbacks.preloadedTask });
  // (TPT111) Board-blocking loader, shown from entry until the modal paints (or the
  // open fails). Ref-counted — see utils.js showBoardLoader() for why.
  showBoardLoader();
  try {
    return await _openTaskEditModalImpl(taskId, callbacks);
  } finally {
    hideBoardLoader();
    perfEnd(_h);
  }
}

async function _openTaskEditModalImpl(taskId, callbacks = {}) {
  const invokingElement = callbacks.trigger || document.activeElement;
  // callbacks.preloadedTask: optional task object — skips API fetch (for in-memory proposals)
  // callbacks.onSavePreview: optional async (draft) => void — custom save for in-memory proposals
  // callbacks.depCandidates: optional [{id, title, status}] — sibling chat proposals offered
  //   alongside persisted tasks in the dependency typeahead (preview mode)
  // callbacks.compareTask: optional live task object (C1095) — when set, the modal renders
  //   a two-column diff: compareTask read-only on the left, preloadedTask/draft editable on
  //   the right, with title/description differences highlighted. Distinct from
  //   _modalState.original/lastSaved (the proposal's own dirty baseline) — compareTask never
  //   changes while the modal is open.
  // callbacks.compareTaskId: optional task key (C1095) — fallback fetched here (task-board.js
  //   already imports `api`; template.html's inline script does not) when the caller couldn't
  //   supply compareTask directly (e.g. msg._existingTasksSnapshot hadn't loaded yet).
  // callbacks.onOpenLiveTask: optional (taskId) => void — diff-mode escape hatch, shown as a
  //   button in .modal-top-bar, that closes this modal and opens the real board-path modal.
  // callbacks.onCompareTaskResolved: optional (compareTask) => void — fired once compareTask
  //   resolves (C1109), so the caller (template.html) can hydrate its own in-memory proposal
  //   object too, not just the modal's local clones below.
  // callbacks.readOnly: optional boolean (TPT179) — view-only regardless of assignee. Locks the
  //   same surfaces as a teammate's task (commands.isTaskReadOnly, C1407) and additionally hides Start,
  //   with its own banner. Used by the objective chat's pinned discuss card, where a direct edit
  //   would race the "modified" proposal whose baseline is hydrated from the live task.
  // (TPT272/TPT283) A task locked by an open Rehash → Discuss/Split tab can't be edited from the
  // board or the terminal bridge until the chat is saved or closed. The chat's own read-only view
  // and in-memory proposals (preloadedTask) stay openable. The toast names the lock's mode.
  if (isTaskDiscussing(state, taskId) && !callbacks.readOnly && !callbacks.preloadedTask) {
    showToast(t(lockMessageKey(lockIntentOf(state, taskId))));
    return;
  }
  commands.resetProjectTaskList(); // tasks change often — refetch once per modal open
  let task;
  let projectConfig = {};
  let compareTask = callbacks.compareTask || null;
  // (TPT111) Sessions/config/task-list results the deferred repaint block below (right
  // after _renderTaskEditModal()) consumes — null in the preloaded-task branch and on
  // any error path, both of which skip the deferred repaints entirely.
  let deferred = null;
  try {
    if (!compareTask && callbacks.compareTaskId) {
      try { compareTask = await api.tasks.get(callbacks.compareTaskId); } catch { compareTask = null; }
    }
    if (callbacks.preloadedTask) {
      task = callbacks.preloadedTask;
      // C1109: compareTask (a modified proposal's live-task baseline) may carry fields the
      // proposal itself omitted (title, description, ...). Hydrate `task` from it here — before
      // original/draft/lastSaved are cloned from `task` below — so the modal never opens
      // already-dirty (hydrating after the clones would leave `original` thin and `draft` fat,
      // lighting the Save button and firing a false "Discard unsaved changes?" on close) and the
      // PROPOSED column never renders blank. Idempotent: the proposal's own values always win,
      // so this is a no-op once a card is already hydrated (the common case after C1109's other
      // fixes — see chat-task-preview.js ensureExistingSnapshot/reconcileModifiedCards). Callers
      // only ever pass compareTask alongside a `modified` proposal (template.html), never a
      // `new` one, so the synthetic type below is safe.
      if (compareTask) {
        hydrateModifiedCard({ type: 'modified', task }, compareTask);
        callbacks.onCompareTaskResolved?.(compareTask);
      }
      const configRes = await fetch('/api/config');
      if (configRes.ok) { try { projectConfig = await configRes.json(); } catch {} }
    } else {
      // (TPT111) All four legs still fire concurrently, but only the task fetch gates
      // first paint now — the other three only refine surfaces the board can already
      // render (Start/Stop state, model-default labels, dependency blocking) and are
      // repainted in place once they land, right after _renderTaskEditModal() below,
      // the same fire-and-forget-then-surgically-repaint shape as the C1505/C1520
      // blocks further down. Handlers are attached synchronously at creation (not
      // after awaiting the task) so a `!task`/catch early-return never leaves an
      // unhandled rejection.
      const sessionsP = fetch('/api/sessions').then(r => (r.ok ? r.json() : null)).catch(() => null);
      const configP = fetch('/api/config').then(r => (r.ok ? r.json() : null)).catch(() => null);
      const listP = commands._ensureProjectTaskList(); // single-flight, never rejects (own .catch above)
      deferred = { sessionsP, configP, listP };
      task = await api.tasks.get(taskId);
      // (C1392) Was alert() — a native dialog blocks the page event loop and stalls every
      // CDP/Claude-in-Chrome command (root-caused by C1391). This is a data condition (the
      // fetch itself succeeded), not a connectivity one, so a toast is enough — no server
      // guidance banner needed.
      if (!task) { showToast(t('modal.errTaskNotFound', { id: taskId }), 'error'); return; }
      // Warm seed for first paint — refined by the deferred configP repaint below, and by
      // whichever open resolves it first if this is a cold session (_cachedProjectConfig
      // starts undefined).
      projectConfig = commands.getCachedProjectConfig() || {};
    }
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 404) {
      showToast(t('modal.errTaskUnavailable', { id: taskId }), 'error');
      return;
    }
    // (C1392) Was alert() — the actual CDP-freezing call: this catch is what fires for the
    // browser-mode unscoped-fetch 500 that C1391 root-caused. Toast carries the raw error;
    // the persistent banner carries mode-specific recovery guidance + a Retry.
    showToast(t('common.networkError', { msg: err.message }), 'error');
    showActionBanner({
      id: 'task-open-error-banner',
      label: taskOpenErrorLabel({ isElectron: !!window.electronAPI?.api, taskId }),
      actionLabel: t('btn.retry'),
      busyLabel: t('btn.retrying'),
      onAction: async () => {
        hideActionBanner('task-open-error-banner');
        await openTaskEditModal(taskId, callbacks);
      },
    });
    return;
  }

  hideActionBanner('task-open-error-banner'); // (C1392) clear a stale banner on a recovered open

  if (_modalState) closeTaskEditModal(true);
  _modalState = {
    taskId,
    original: structuredClone(task),
    draft: structuredClone(task),
    lastSaved: structuredClone(task),
    hasSavedOnce: false,
    projectConfig,
    callbacks,
    compareTask: compareTask ? structuredClone(compareTask) : null,
    comments: [],
    commentsLoading: !callbacks.preloadedTask,
    commentsError: '',
    events: [],
    eventsLoading: !callbacks.preloadedTask,
    eventsError: '',
    subscribed: true,
    // (TPT34) Own-comment inline edit — render-from-state, not DOM-stashed, because
    // _renderModalComments() rebuilds .comments-list via wholesale innerHTML from several
    // call sites (incl. a background member-list refresh); a DOM-held draft would vanish
    // out from under the user on any of those.
    editingCommentId: null,
    editingDraft: '',
  };
  _renderTaskEditModal();
  const modalRoot = document.getElementById('task-edit-modal');
  _modalDialogFocus = activateDialogFocus({
    root: modalRoot,
    initialFocus: () => (!_isModalReadOnly(_modalState?.draft) && modalRoot.querySelector('.modal-title-input:not([hidden]):not(:disabled)'))
      || modalRoot.querySelector('.modal-task-id'),
    returnFocus: () => {
      if (invokingElement?.isConnected && invokingElement.getClientRects().length) return invokingElement;
      return [...document.querySelectorAll('.card-edit-btn')]
        .find(btn => btn.dataset.taskId === taskId) || document.getElementById('left-nav-toggle');
    },
    portals: '.tag-typeahead-dropdown, .dep-typeahead-dropdown, .member-typeahead-dropdown, .mention-dropdown, [data-portaled="1"]',
  });
  // (TPT111) Sessions/config/task-list all resolve after first paint now (see the split
  // above) — never re-run _renderTaskEditModal() here, a wholesale innerHTML rebuild would
  // clobber in-progress typing, scroll position, or an open dropdown. Each leg surgically
  // repaints only the surface it owns, same shape as C1505/C1520 just below.
  if (deferred) {
    void deferred.sessionsP.then((json) => {
      if (!json) return;
      // (C1387) Same merge helper fetchActiveSessions() uses — never wholesale-replace
      // attentionSessions/attentionDetails. Global board state, not modal-scoped, so this
      // runs unconditionally; commands.updateClaudeButtons() self-guards on _modalState itself and
      // also repaints the board cards, which the pre-TPT111 code never did after this merge.
      mergeSessionsSnapshot(json);
      commands.updateClaudeButtons();
    });
    void deferred.configP.then((cfg) => {
      if (!cfg || _modalState?.taskId !== taskId) return;
      _modalState.projectConfig = cfg; // commitAgentChoice() reads this live (5590-ish)
      commands.setCachedProjectConfig(cfg); // warms the module-lifetime cache for New Task + next open
      const modalEl = document.getElementById('task-edit-modal');
      const modelSel = modalEl?.querySelector('.modal-agent-model-select');
      if (!modalEl || document.activeElement === modelSel) return; // same guard as C1505 below
      _applyModalAgentModelVisibility(modalEl, _modalState.draft.agentAssignee || '', _modalState.draft, cfg, { hideBrowserTools: !!_modalState.callbacks.preloadedTask });
    });
    void deferred.listP.then(() => {
      if (_modalState?.taskId !== taskId) return;
      const modalEl = document.getElementById('task-edit-modal');
      if (!modalEl || modalEl.hidden) return;
      _syncModalStartDependencyState(modalEl, _modalState.draft);
    });
  }
  // (C1505) Warm the live model registry and repaint the Model select in place — not part of
  // the pre-paint Promise.all above, since a cold probe can take up to ~1.5s (model-registry.js
  // TTL/timeout notes) and this open path is already round-trip-bound (see perf comment above).
  // Renders from _modalState.draft, so an already-picked model survives the repaint; skipped
  // outright while the select itself is focused so an open dropdown is never yanked away.
  void ensureAgentModels().then(() => {
    if (_modalState?.taskId !== taskId) return;
    const modalEl = document.getElementById('task-edit-modal');
    const modelSel = modalEl?.querySelector('.modal-agent-model-select');
    if (!modalEl || document.activeElement === modelSel) return;
    _applyModalAgentModelVisibility(modalEl, _modalState.draft.agentAssignee || '', _modalState.draft, _modalState.projectConfig || {}, { hideBrowserTools: !!_modalState.callbacks.preloadedTask });
  });
  // (C1520) Re-check membership on every modal open — fire-and-forget, never
  // awaited (this open path is already round-trip-bound, see the C1505 perf
  // comment above). Repaints only the two surfaces that bake member names in at
  // render time rather than reading state.projectMembers live: the Assignee
  // combo-box (an assignee added after boot renders as `#42` until its row is
  // cached — see syncLabel()) and @mention highlighting in already-rendered
  // comments (_renderCommentContent). The mention *typeahead* needs nothing —
  // _getMentionSuggestions() reads state.projectMembers live on every keystroke.
  void commands.refreshProjectMembers().then((changed) => {
    if (!changed || _modalState?.taskId !== taskId) return;
    const modalEl = document.getElementById('task-edit-modal');
    if (!modalEl) return;
    _modalState._memberCombo?.refresh();
    if (!callbacks.preloadedTask) _renderModalComments(modalEl);
  });
  if (!callbacks.preloadedTask) {
    void _loadModalComments(taskId);
    void _loadModalEvents(taskId);
    _clearTaskActivityOnOpen(taskId);
  }
}

// (TPT12) Clear the card's unread-activity chip on open — optimistic local mark-read
// (immediate repaint) plus a batched server PATCH so the API's `notifications` inbox agrees.
// Fire-and-forget: the modal itself never blocks on this. On a partial or total failure,
// un-suppress exactly the ids that didn't actually get marked read server-side — the next
// poll tick then naturally re-shows them, rather than the chip silently lying "read" forever.
// Only for a real, persisted task (preview/proposal cards have no server-side activity of
// their own — see the `!callbacks.preloadedTask` guard at the call site above).
function _clearTaskActivityOnOpen(taskId) {
  const ids = activityIds(taskId);
  if (ids.length === 0) return;
  markActivityRead(taskId, ids);
  syncActivityChips();
  api.project.notifications.markRead(ids)
    .then((res) => {
      const failedIds = (res?.results || []).filter((r) => !r.ok).map((r) => r.id);
      if (failedIds.length === 0) return;
      unmarkActivityRead(taskId, failedIds);
      syncActivityChips();
    })
    .catch(() => {
      unmarkActivityRead(taskId, ids); // request never completed — assume nothing was marked
      syncActivityChips();
    });
}

// ── C981: full-size image lightbox for thumbnail-capped description/comment
// images. Escape/backdrop-click close only the lightbox — the Escape listener
// runs in the CAPTURE phase and stops propagation so template.html's
// bubble-phase document Escape handler (closeTaskEditModal) never fires while
// the lightbox is open. ──
let _imgLightboxOverlay = null;
function _openImageLightbox(src, alt) {
  if (_imgLightboxOverlay) return; // already open
  const overlay = document.createElement('div');
  overlay.className = 'img-lightbox-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('modal.imagePreview'));
  overlay.tabIndex = -1;
  const img = document.createElement('img');
  img.className = 'img-lightbox-img';
  img.src = src;
  img.alt = alt || 'Image preview';
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  const focusHandle = activateDialogFocus({ root: overlay, initialFocus: () => overlay });
  _imgLightboxOverlay = overlay;
  const close = () => {
    overlay.remove();
    focusHandle.close();
    _imgLightboxOverlay = null;
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    close();
    e.preventDefault();
    e.stopPropagation();
  };
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
}

// (C1392) force-close stays fully SYNCHRONOUS on purpose: the diff-mode "Open live task"
// escape hatch (.btn-diff-open-live click, above) calls closeTaskEditModal(true) and
// immediately reopens the modal on the very next statement, writing a new _modalState —
// a deferred/async teardown here would race and null out that new state. The dirty-discard
// confirm() that used to live in this function's `!force` branch is gone (it was a native
// blocking dialog); interactive callers now go through requestCloseTaskEditModal() below,
// which awaits a non-blocking confirm and then calls this with force=true.
export function closeTaskEditModal(force = false) {
  if (!_modalState) return;
  const el = document.getElementById('task-edit-modal');
  if (el) { el.hidden = true; el.innerHTML = ''; delete el.dataset.taskId; }
  clearTimeout(_modalState._diffTimer); // C1095 — no stray live-diff recompute after close
  _removeMentionDropdown();
  _disconnectCommentSeenObserver();
  _disconnectNotifSeenObserver(); // (TPT17)
  _modalState._memberCombo?.destroy(); // (C1251) removes its resize/scroll listeners
  // Clean up all dropdowns portaled to body (tag typeahead, dep typeahead, member typeahead, sprint combo, agent picker)
  document.querySelectorAll('.tag-typeahead-dropdown').forEach(d => d.remove());
  document.querySelectorAll('.dep-typeahead-dropdown').forEach(d => d.remove());
  document.querySelectorAll('.member-typeahead-dropdown').forEach(d => d.remove());
  document.querySelectorAll('[data-portaled="1"]').forEach(d => d.remove());
  if (_modalState?._tagDropdownHandlers) {
    window.removeEventListener('resize', _modalState._tagDropdownHandlers.resize);
  }
  if (_modalState?._depDropdownHandlers) {
    window.removeEventListener('resize', _modalState._depDropdownHandlers.resize);
  }
  _modalState = null;
  _modalDialogFocus?.close();
  _modalDialogFocus = null;
}

// (C1392) Interactive close path (Esc key, backdrop click) — replaces the native
// confirm() that used to gate closeTaskEditModal()'s !force branch (a blocking dialog
// that stalls CDP/Claude-in-Chrome automation). Non-interactive/force callers keep
// calling closeTaskEditModal(true) directly and are unaffected.
let _discardConfirmOpen = false;
export async function requestCloseTaskEditModal() {
  if (!_modalState) return false;
  if (_isModalDirty()) {
    if (_discardConfirmOpen) return false; // Esc re-entered while the confirm is already up
    _discardConfirmOpen = true;
    let ok;
    try {
      ok = await showActionConfirm({
        message: t('modal.confirmDiscard'),
        confirmLabel: t('btn.discard'),
        danger: true,
        overlayClass: 'modal-overlay--over-modal',
      });
    } finally {
      _discardConfirmOpen = false;
    }
    if (!ok) return false;
  }
  closeTaskEditModal(true);
  return true;
}

// (C1245) Pure option-builders shared by _renderTaskEditModal and the New Task
// form (renderNewTaskForm) — extracted so both surfaces stay in sync instead of
// drifting apart. Kept string-identical to what they replaced in the modal.

export function _statusOptionsHtml(selected) {
  const names = statusNames();
  if (!names.length) {
    // Cold-boot guard: registry not loaded yet. Never emit an empty <select>.
    const fallback = startName() || 'pending';
    return `<option value="${fallback}" selected>${statusLabel(fallback)}</option>`;
  }
  return names.map(s =>
    `<option value="${s}"${s === selected ? ' selected' : ''}>${statusLabel(s)}</option>`
  ).join('');
}

// (C1505) Options come from agentModelOptions() — the live per-agent registry
// (GET /api/agent-models, C1504) once warm, else the static CLAUDE_MODELS/CODEX_MODELS
// fallback baked into constants.js. Same {value,label,description?} shape either way, so this
// mapper and the "Project default (…)" first option are unchanged from before C1505.
function _modelOptionHtml(m, selectedValue) {
  return `<option value="${escapeAttr(m.value)}"${selectedValue === m.value ? ' selected' : ''}${m.description ? ` title="${escapeAttr(m.description)}"` : ''}>${escapeAttr(m.label)}</option>`;
}

function _modelOptionsForAgent(assignee, draft, projectConfig) {
  const projClaudeModel = projectConfig.CLAUDE_MODEL || 'opusplan';
  const projCodexModel  = projectConfig.CODEX_MODEL  || '';
  if (assignee === 'claude') {
    return [
      `<option value=""${!draft.claudeModel ? ' selected' : ''}>${t('modal.projectDefault')} (${escapeAttr(projClaudeModel)})</option>`,
      ...agentModelOptions('claude').map(m => _modelOptionHtml(m, draft.claudeModel)),
    ].join('');
  }
  if (assignee === 'codex') {
    return [
      `<option value=""${!draft.codexModel ? ' selected' : ''}>${t('modal.projectDefault')}${projCodexModel ? ` (${escapeAttr(projCodexModel)})` : ` (${t('modal.codexDefault')})`}</option>`,
      ...agentModelOptions('codex').map(m => _modelOptionHtml(m, draft.codexModel)),
    ].join('');
  }
  return '';
}

// (TPT285) Per-task reasoning effort — blank = inherit the agent default (tasks.effort NULL).
// One shared select for Claude and Codex: unlike the model pins, effort is a single column,
// not per-agent, so an agent switch keeps the chosen level.
function _effortOptionsHtml(draft) {
  const cur = draft.effort || '';
  return [
    `<option value=""${!cur ? ' selected' : ''}>${escapeAttr(t('effort.inherit'))}</option>`,
    ...EFFORT_LEVELS.map(v => `<option value="${v}"${cur === v ? ' selected' : ''}>${escapeAttr(t(EFFORT_LABELS[v]))}</option>`),
  ].join('');
}

// (TPT95) Codex-only browser-tools MCP presets row. Checked state comes from
// state.browserTools (project-level, sticky) — NOT from `draft` — since this setting
// isn't part of the task's own fields and Save doesn't persist it; see
// _isModalDirty()'s draft/original comparison, which must never see this value.
function _browserToolCheckboxHtml(id, labelText, disabled) {
  return `<label class="modal-browser-tool-label"><input type="checkbox" class="modal-browser-tool" value="${escapeAttr(id)}"${state.browserTools.includes(id) ? ' checked' : ''}${disabled ? ' disabled' : ''}> ${escapeAttr(labelText)}</label>`;
}

// (TPT197) `hideBrowserTools` keeps ONLY the Codex browser-tools row hidden — used by the
// objective-chat proposal-edit modal, where model + design-mode are now editable (they live
// on the draft and ride onSavePreview back to proposal.task) but browser tools are a
// project-level MCP_BROWSER_TOOLS setting written immediately, with no draft/Save gating.
export function _agentModelControlHtml(assignee, draft, projectConfig, { hidden = false, hideBrowserTools = false, disabled = false } = {}) {
  const supportsModel = assignee === 'claude' || assignee === 'codex';
  return `
            <div class="modal-field-row modal-agent-model-row"${hidden || !supportsModel ? ' hidden' : ''}><label>${t('field.model')}</label><select class="modal-agent-model-select" data-agent="${escapeAttr(supportsModel ? assignee : '')}"${disabled ? ' disabled' : ''}>${_modelOptionsForAgent(assignee, draft, projectConfig)}</select></div>
            <div class="modal-field-row modal-effort-row"${hidden || !supportsModel ? ' hidden' : ''}><label>${t('field.effort')}</label><select class="modal-effort-select" title="${escapeAttr(t('tooltip.effort'))}"${disabled ? ' disabled' : ''}>${_effortOptionsHtml(draft)}</select></div>
            <div class="modal-field-row modal-claude-design-row"${hidden || assignee !== 'claude' ? ' hidden' : ''}><label>${t('field.designMode')}</label><input type="checkbox" class="modal-claude-design-mode"${draft.claudeDesignMode ? ' checked' : ''}${disabled ? ' disabled' : ''} title="${escapeAttr(t('tooltip.designMode'))}"></div>
            <div class="modal-field-row modal-codex-browser-row"${hidden || hideBrowserTools || assignee !== 'codex' ? ' hidden' : ''}><label>${t('field.browserTools')}</label><span class="modal-browser-tools" title="${escapeAttr(t('tooltip.browserTools'))}">${_browserToolCheckboxHtml('playwright', t('label.playwright'), disabled)}${_browserToolCheckboxHtml('chrome-devtools', t('label.chromeDevtools'), disabled)}</span></div>`;
}

function _renderTaskEditModal() {
  const modal = document.getElementById('task-edit-modal');
  if (!modal) return;
  const { draft } = _modalState;
  const tierKeys = state.tierKeys || [];
  const dirty = _isModalDirty();

  const statusOptions = _statusOptionsHtml(draft.status);

  const isPreviewTask = !!_modalState.callbacks.preloadedTask;
  const compareTask = _modalState.compareTask;
  const isDiffMode = !!compareTask;

  // (C1407) A teammate's task — reachable via the People filter's All-Tasks scope,
  // subtask drill-down, or (formerly) the API's project-owner exemption. Per the answered
  // design decision: view + comment only. Everything else that would mutate the task
  // locks below, alongside a banner stating why (never a stray-looking disabled field).
  const readOnly = _isModalReadOnly(draft);
  const canEditText = !readOnly && !isInProgressName(draft.status);
  const agentLocked = commands.isAgentLocked(draft.status) || readOnly;

  const agentPickerHtml = commands.renderAgentPicker('agentAssignee', draft.agentAssignee || '', agentLocked, commands._taskAgentPickerOptions(), draft.piModel);

  // Derive assignee once for conditional model visibility
  const assignee = draft.agentAssignee || '';

  // Agent model select
  const projectConfig = _modalState.projectConfig || {};

  const tagsHtml = (draft.tags || []).map(tag =>
    `<span class="tag-chip modal-tag-chip" data-tag="${escapeAttr(tag)}"${state.tagDescriptions.get(tag) ? ` title="${escapeAttr(state.tagDescriptions.get(tag))}"` : ''}>${escapeAttr(tag)}<button class="chip-remove" type="button" data-tag="${escapeAttr(tag)}"${readOnly ? ' disabled hidden' : ''}>&times;</button></span>`
  ).join('');

  const depsHtml = (draft.dependencies || []).map(_renderDepChip).join('');
  const readOnlyBannerHtml = readOnly
    ? `<div class="modal-readonly-banner">${escapeAttr(commands.isTaskReadOnly(draft)
        ? t('modal.readOnlyAssignee', { name: commands._memberLabelFor(draft.assignee) })
        : t('modal.readOnlyDiscuss'))}</div>`
    : '';

  const showStart = !isPreviewTask && !readOnly && draft.category === 'CODING' && draft.agentAssignee !== 'human' && commands.canStartTaskCard(draft);
  const hasActiveSession = state.activeSessions.has(draft.id);
  // (TPT374) mode/icon/label/title for the footer Start/Resume/Show button — see
  // _modalSessionButton() just below _syncModalStartDependencyState().
  const sessionBtn = _modalSessionButton(draft);
  const projectTaskIndex = commands._projectTaskIndex(); // (TPT111) falls back to state.taskStatusById pre-list
  const startBlocked = showStart && commands.hasUnmetDeps(draft, projectTaskIndex);
  const unmetDeps = startBlocked ? _modalUnmetDependencyKeys(draft) : [];
  const startLabel = sessionBtn.label;
  const startTitle = startBlocked
    ? t('tooltip.waitingForDependencies', { ids: unmetDeps.join(', ') })
    : sessionBtn.title;
  const unreadBadge = _renderUnreadBadge();
  const notifUnreadBadge = _renderNotifUnreadBadge();

  // ── C1095: dual-panel old/new diff header when compareTask is set (a modified
  // objective-chat proposal opened for editing). Both `.diff-title-display` /
  // `.modal-desc-display` bodies are left empty here and filled by
  // _applyModalDiffHighlights() right after this innerHTML assignment — that keeps
  // exactly one code path that renders markdown + computes highlights, run for the
  // initial paint, Reset, and every live recompute alike. `.modal-title-input` stays
  // in the DOM (just `hidden`) so _attachModalHandlers' unguarded querySelector never
  // throws, and Reset/Save need no diff-mode awareness. ──
  const openLiveBtnHtml = (isDiffMode && _modalState.callbacks.onOpenLiveTask)
    ? `<button type="button" class="btn-diff-open-live">${escapeAttr(t('diff.openLiveTask'))}</button>`
    : '';
  const titleDescHtml = isDiffMode ? `
    <div class="diff-header-row">
      <div class="diff-col" data-diff-side="old">
        <div class="diff-col-label">${escapeAttr(t('diff.current'))}</div>
        <div class="diff-title-display" data-diff-side="old"></div>
        <div class="modal-desc-display" data-diff-side="old"></div>
      </div>
      <div class="diff-col" data-diff-side="new">
        <div class="diff-col-label">${escapeAttr(t('diff.proposed'))}<span class="diff-change-badge" hidden></span></div>
        <div class="diff-title-display" data-diff-side="new"${canEditText ? ` role="button" tabindex="0" aria-label="${escapeAttr(t('modal.editTitle'))}"` : ''}></div>
        <input class="modal-title-input" type="text" aria-label="${escapeAttr(t('field.title'))}" value="${escapeAttr(draft.title)}" hidden>
        <div class="modal-desc-display" data-diff-side="new"${canEditText ? ` role="button" tabindex="0" aria-label="${escapeAttr(t('modal.editDescription'))}"` : ''}></div>
      </div>
    </div>
    <div class="diff-meta-row" hidden></div>
  ` : `
    <input class="modal-title-input" type="text" aria-label="${escapeAttr(t('field.title'))}" value="${escapeAttr(draft.title)}">
    <div class="modal-desc-display"${canEditText ? ` role="button" tabindex="0" aria-label="${escapeAttr(t('modal.editDescription'))}"` : ''}>${_renderDescriptionHtml(draft.description)}</div>
  `;

  _disconnectCommentSeenObserver();
  modal.innerHTML = `
    <div class="task-edit-overlay">
      <div class="task-edit-panel${isDiffMode ? ' task-edit-panel--diff' : ''}" role="dialog" aria-modal="true" aria-label="${escapeAttr(t(readOnly ? 'modal.taskDetails' : 'modal.editTask', { id: draft.id }))}">
        <div class="modal-top-bar">
          <div class="modal-head-meta">
            <span class="modal-task-id" tabindex="-1">${escapeAttr(draft.id)}</span>
            <select class="modal-status-select" style="--status-color:${statusColor(draft.status)}" aria-label="${escapeAttr(t('field.status'))}" title="${escapeAttr(t('field.status'))}"${readOnly ? ' disabled' : ''}>${statusOptions}</select>
          </div>
          ${openLiveBtnHtml}
          <div class="modal-primary-actions">
            <button class="btn-modal-cancel" type="button">${t('btn.cancel')}</button>
            <button class="btn-modal-reset"${!dirty || readOnly ? ' disabled' : ''}>${t('btn.reset')}</button>
            <button class="btn-modal-save"${!dirty || readOnly ? ' disabled' : ''}>${t('btn.save')}</button>
          </div>
        </div>
        <div class="modal-scroll-body">
        ${readOnlyBannerHtml}
        ${titleDescHtml}
        <div class="modal-tabs">
          <button class="modal-tab-btn active" type="button" data-tab="general">${_GENERAL_TAB_SVG}<span>${t('modal.tabGeneral')}</span></button>
          <button class="modal-tab-btn" type="button" data-tab="comments"${isPreviewTask ? ' hidden' : ''}>${_COMMENTS_TAB_SVG}<span>${t('modal.tabComments')}</span>${unreadBadge}</button>
          <button class="modal-tab-btn" type="button" data-tab="notifications"${isPreviewTask ? ' hidden' : ''}>${_NOTIF_TAB_SVG}<span>${t('modal.tabNotifications')}</span>${notifUnreadBadge}</button>
        </div>
        <div class="modal-tab-panel" data-tab="general">
          <div class="modal-fields">
            <section class="modal-field-group" data-group="planning">
            ${getSprintsEnabled() ? `<div class="modal-field-row"><label>${groupNoun()}</label>${renderSprintCombobox({ id: 'modal-sprint-combo', current: taskHasNullSprint(draft) ? null : draft.priority ?? '', keys: tierKeys, variant: 'plain', includeBacklog: true, globalMaxKey: sprintRecordMax(state.sprints) })}</div>` : ''}
            <div class="modal-field-row"><label>${t('field.memberAssignee')}</label>${commands._renderMemberCombobox({ id: 'modal-member-combo', assignee: draft.assignee ?? null, disabled: agentLocked })}</div>
            </section>
            <section class="modal-field-group" data-group="agent">
              <div class="modal-field-group-title">${t('modal.groupAgent')}</div>
            <div class="modal-field-row"><label>${t('field.agent')}</label>${agentPickerHtml}</div>
            ${_agentModelControlHtml(assignee, draft, projectConfig, { hideBrowserTools: isPreviewTask, disabled: agentLocked })}
            </section>
            <section class="modal-field-group modal-field-group--wide" data-group="links">
            <div class="modal-field-row"><label>${t('field.tags')}</label>
              <div class="modal-tags">
                ${tagsHtml}
                <input class="modal-tag-input" type="text" placeholder="${escapeAttr(t('field.addTagPlaceholder'))}" autocomplete="off"${readOnly ? ' disabled' : ''}>
              </div>
            </div>
            <div class="modal-field-row"><label>${t('field.dependencies')}</label>
              <div class="modal-deps">
                ${depsHtml}
                <input class="modal-dep-input" type="text" placeholder="${escapeAttr(t('field.addDepPlaceholder'))}" autocomplete="off"${readOnly ? ' disabled' : ''}>
              </div>
            </div>
            </section>
          </div>
        </div>
        <div class="modal-tab-panel" data-tab="comments" hidden>
          <div class="modal-comments">
            <div class="modal-comments-title">${t('modal.tabComments')}</div>
            <div class="comments-list"></div>
            <div class="comment-compose">
              <textarea id="modal-comment-input" class="comment-input" placeholder="${escapeAttr(t('comments.placeholder'))}"></textarea>
              <button class="comment-submit" type="button">${t('btn.submit')}</button>
            </div>
          </div>
        </div>
        <div class="modal-tab-panel" data-tab="notifications" hidden>
          <div class="modal-notifications">
            <label class="modal-notif-subscribe-row">
              <input type="checkbox" class="modal-notif-subscribed-checkbox"${_modalState.subscribed !== false ? ' checked' : ''}>
              <span>${t('notif.subscribed')}</span>
            </label>
            <div class="notif-events-list"></div>
          </div>
        </div>
        </div>
        <div class="modal-context-btns"${isPreviewTask ? ' hidden' : ''}>
          <div class="modal-actions-run">
          ${showStart ? `<button type="button" data-action="start" data-session-mode="${sessionBtn.mode}" class="${startBlocked ? 'deps-blocked' : ''}" title="${escapeAttr(startTitle)}"${startBlocked ? ' disabled' : ''}>${sessionBtn.icon}<span class="btn-label">${startLabel}</span></button>` : ''}
          ${showStart && hasActiveSession ? `<button type="button" data-action="stop" title="${escapeAttr(t('tooltip.stopSession'))}">${commands.STOP_ICON}<span class="btn-label">${t('btn.stop')}</span></button>` : ''}
          </div>
          ${readOnly ? '' : `<div class="modal-actions-manage">
          <button type="button" data-action="reiterate" title="${escapeAttr(t('tooltip.reiterate'))}">${_WAND_SVG}<span class="btn-label">${t('btn.reiterate')}</span></button>
          <button type="button" data-action="delete" title="${escapeAttr(t('tooltip.deleteTask'))}">${_DELETE_SVG}<span class="btn-label">${t('btn.delete')}</span></button>
          </div>`}
        </div>
      </div>
    </div>`;

  modal.dataset.taskId = draft.id;
  modal.hidden = false;
  if (isDiffMode) _applyModalDiffHighlights(modal);
  _applyModalLockState(modal, draft);
  _renderModalComments(modal);
  _renderModalEvents(modal);
  _syncSubscribedCheckbox(modal);
  _attachModalHandlers(modal);
}

// ════════════════════════════════════════════════════════════════════════
// C1095 — dual-panel old/new diff helpers for a modified-task proposal.
// Called only when _modalState.compareTask is set. See modified-task-diff.js
// for the underlying pure diff algorithm and DOM-segment mapping.
// ════════════════════════════════════════════════════════════════════════

// ── Full recompute: renders both title/description panels from source (compareTask
// = old, draft = new) and re-applies highlights. This is the single code path used
// for the initial paint, Reset, and "commit" recompute on blur — regenerating from
// source every time means highlight spans can never nest/accumulate. ──
function _applyModalDiffHighlights(modal) {
  const { compareTask, draft } = _modalState;
  if (!compareTask) return;

  // Title — plain text, no rendering step, both sides highlighted directly.
  const titleOps = diffWords(compareTask.title || '', draft.title || '');
  const { oldRanges: titleOldRanges, newRanges: titleNewRanges } = opsToRanges(titleOps);
  const oldTitleEl = modal.querySelector('.diff-title-display[data-diff-side="old"]');
  const newTitleEl = modal.querySelector('.diff-title-display[data-diff-side="new"]');
  const emptyHtml = () => `<span class="diff-empty">${escapeAttr(t('diff.empty'))}</span>`;
  if (oldTitleEl) {
    oldTitleEl.classList.remove('diff-raw-mode');
    oldTitleEl.innerHTML = highlightPlainText(compareTask.title || '', titleOldRanges, 'diff-removed') || emptyHtml();
  }
  if (newTitleEl) {
    newTitleEl.innerHTML = highlightPlainText(draft.title || '', titleNewRanges, 'diff-added') || emptyHtml();
  }

  // Description — render markdown fresh on both sides, then diff the RENDERED TEXT
  // (not raw markdown source — offsets don't survive rendering) and map ranges back
  // onto the live rendered DOM via collectTextSegments/applyRanges.
  const oldDescEl = modal.querySelector('.modal-desc-display[data-diff-side="old"]');
  const newDescEl = modal.querySelector('.modal-desc-display[data-diff-side="new"]');
  if (oldDescEl) {
    oldDescEl.classList.remove('diff-raw-mode');
    oldDescEl.innerHTML = renderMarkdown(compareTask.description || '') || emptyHtml();
  }
  if (newDescEl) {
    newDescEl.innerHTML = renderMarkdown(draft.description || '') || emptyHtml();
  }
  if (oldDescEl && newDescEl) {
    const oldSeg = collectTextSegments(oldDescEl);
    const newSeg = collectTextSegments(newDescEl);
    const ops = diffWords(oldSeg.text, newSeg.text);
    const { oldRanges, newRanges } = opsToRanges(ops);
    applyRanges(oldSeg.segments, oldRanges, 'diff-removed', 'del');
    applyRanges(newSeg.segments, newRanges, 'diff-added', 'ins');
    markStructuralBlockChanges(oldDescEl, newDescEl, 'diff-block-changed');
  }

  _updateModalDiffBadgeAndMeta(modal);
}

// ── Live (debounced) recompute while the user is actively typing. Only touches the
// OLD side + the badge/meta row — the NEW side is either the focused input/textarea
// itself (title) or intentionally left as plain raw text (description, per the "plain
// text while editing" requirement) until blur triggers the full _applyModalDiffHighlights. ──
function _scheduleModalDiffRecompute(modal, { title, description } = {}) {
  if (!_modalState) return;
  clearTimeout(_modalState._diffTimer);
  _modalState._diffTimer = setTimeout(() => {
    if (!_modalState?.compareTask) return;
    if (title) {
      const oldTitleEl = modal.querySelector('.diff-title-display[data-diff-side="old"]');
      if (oldTitleEl) {
        const ops = diffWords(_modalState.compareTask.title || '', _modalState.draft.title || '');
        const { oldRanges } = opsToRanges(ops);
        oldTitleEl.innerHTML = highlightPlainText(_modalState.compareTask.title || '', oldRanges, 'diff-removed')
          || `<span class="diff-empty">${escapeAttr(t('diff.empty'))}</span>`;
      }
    }
    if (description) _switchOldSideToRawMode(modal);
    _updateModalDiffBadgeAndMeta(modal);
  }, 200);
}

// ── Switch the OLD description panel to plain raw-text highlighting (used while the
// NEW side's textarea is focused, so both sides compare apples-to-apples raw text). ──
function _switchOldSideToRawMode(modal) {
  const oldDescEl = modal.querySelector('.modal-desc-display[data-diff-side="old"]');
  if (!oldDescEl || !_modalState?.compareTask) return;
  // Diff and display must use the SAME string — ranges computed against
  // normalizeRaw()'d text but sliced out of the original would be off by however
  // many "\~" -> "~" collapses occurred before each offset. Unescaping is also the
  // right thing to *show* here: a rendered-markdown view would show "~" too.
  const rawOld = normalizeRaw(_modalState.compareTask.description || '');
  const rawNew = normalizeRaw(_modalState.draft.description || '');
  const ops = diffWords(rawOld, rawNew);
  const { oldRanges } = opsToRanges(ops);
  oldDescEl.classList.add('diff-raw-mode');
  oldDescEl.innerHTML = highlightPlainText(rawOld, oldRanges, 'diff-removed')
    || `<span class="diff-empty">${escapeAttr(t('diff.empty'))}</span>`;
}

// ── Compact "what else changed" row (tags/dependencies/sprint) + the change-count
// badge. status is deliberately excluded — see summarizeMetadata() in
// modified-task-diff.js for why. ──
function _updateModalDiffBadgeAndMeta(modal) {
  const { compareTask, draft } = _modalState;
  const titleChanged = normalizeRaw(compareTask.title || '') !== normalizeRaw(draft.title || '');
  const descChanged = normalizeRaw(compareTask.description || '') !== normalizeRaw(draft.description || '');
  const metaSummary = summarizeMetadata(compareTask, draft);
  _renderDiffMetaRow(modal, metaSummary);
  const totalChanges = (titleChanged ? 1 : 0) + (descChanged ? 1 : 0)
    + metaSummary.tags.added.length + metaSummary.tags.removed.length
    + metaSummary.dependencies.added.length + metaSummary.dependencies.removed.length
    + (metaSummary.priority ? 1 : 0) + (metaSummary.category ? 1 : 0) + (metaSummary.assignee ? 1 : 0);
  const badge = modal.querySelector('.diff-change-badge');
  if (badge) {
    badge.hidden = false;
    badge.textContent = totalChanges > 0 ? tc('diff.changeCount', totalChanges) : t('diff.noChanges');
  }
}

function _renderDiffMetaRow(modal, summary) {
  const row = modal.querySelector('.diff-meta-row');
  if (!row) return;
  const parts = [];
  if (summary.tags.added.length || summary.tags.removed.length) {
    const chips = [
      ...summary.tags.removed.map(tag => `<span class="tag-chip tag-diff-removed">${escapeAttr(tag)}</span>`),
      ...summary.tags.added.map(tag => `<span class="tag-chip tag-diff-added">${escapeAttr(tag)}</span>`),
    ].join('');
    parts.push(`<div class="diff-meta-item"><span class="diff-meta-label">${escapeAttr(t('field.tags'))}</span>${chips}</div>`);
  }
  if (summary.dependencies.added.length || summary.dependencies.removed.length) {
    const chips = [
      ...summary.dependencies.removed.map(id => `<span class="tag-chip tag-diff-removed">${escapeAttr(id)}</span>`),
      ...summary.dependencies.added.map(id => `<span class="tag-chip tag-diff-added">${escapeAttr(id)}</span>`),
    ].join('');
    parts.push(`<div class="diff-meta-item"><span class="diff-meta-label">${escapeAttr(t('field.dependencies'))}</span>${chips}</div>`);
  }
  if (summary.priority) {
    const fmt = (p) => p === 0 ? t('backlog.title') : groupTitle(p);
    parts.push(`<div class="diff-meta-item"><span class="diff-meta-label">${escapeAttr(groupNoun())}</span> ${escapeAttr(fmt(summary.priority.from))} → ${escapeAttr(fmt(summary.priority.to))}</div>`);
  }
  row.innerHTML = parts.length ? parts.join('') : `<span class="diff-meta-empty">${escapeAttr(t('diff.noOtherChanges'))}</span>`;
  row.hidden = false;
}

// (TPT197) `hideBrowserTools` mirrors _agentModelControlHtml's flag so an agent switch inside
// the objective-chat proposal-edit modal can't re-reveal the Codex browser-tools row that
// render-time keeps hidden there. Default false = New Task form + board modal, unchanged.
export function _applyModalAgentModelVisibility(modal, assignee, draft, projectConfig = {}, { hideBrowserTools = false } = {}) {
  const a = assignee || '';
  const supportsModel = a === 'claude' || a === 'codex';
  const modelRow = modal.querySelector('.modal-agent-model-row');
  const modelSelect = modal.querySelector('.modal-agent-model-select');
  const designRow = modal.querySelector('.modal-claude-design-row');
  const browserRow = modal.querySelector('.modal-codex-browser-row');
  if (modelRow) modelRow.hidden = !supportsModel;
  if (modelSelect) {
    modelSelect.dataset.agent = supportsModel ? a : '';
    modelSelect.innerHTML = _modelOptionsForAgent(a, draft, projectConfig);
  }
  if (designRow) designRow.hidden = a !== 'claude';
  // (TPT285) Effort row follows the Model row's Claude/Codex gate; value re-synced from the
  // draft (one shared column, so no per-agent repopulate like the model select above).
  const effortRow = modal.querySelector('.modal-effort-row');
  const effortSelect = modal.querySelector('.modal-effort-select');
  if (effortRow) effortRow.hidden = !supportsModel;
  if (effortSelect) effortSelect.value = draft.effort || '';
  // (TPT95) Same hidden-toggle-only convention as designRow above — checked state is
  // baked in at HTML-render time from state.browserTools and doesn't need a rebuild
  // here (state.browserTools doesn't change mid-visibility-toggle).
  if (browserRow) browserRow.hidden = hideBrowserTools || a !== 'codex';
}

// ── (C1470) Map a click inside the rendered .modal-desc-display onto an offset in
//    rawMarkdown, so entering edit mode lands the caret near the clicked word instead
//    of always at 0. document.caretRangeFromPoint is the standard/Chromium API;
//    caretPositionFromPoint is the (older-Firefox-only) fallback shape, {offsetNode,
//    offset} instead of {startContainer, startOffset}. Returns null on anything it
//    can't resolve — callers fall back to today's caret-0 behavior. try/catch on
//    purpose: a caret nicety must never be able to break click-to-edit itself. ──
function _caretOffsetFromClick(evt, rawMarkdown) {
  try {
    const root = evt.currentTarget;
    if (!root || !rawMarkdown) return null;
    if (evt.detail === 0) return null; // synthetic click (e.g. keyboard-triggered) — no real coords
    let node, offset;
    if (typeof document.caretRangeFromPoint === 'function') {
      const range = document.caretRangeFromPoint(evt.clientX, evt.clientY);
      if (!range) return null;
      node = range.startContainer;
      offset = range.startOffset;
    } else if (typeof document.caretPositionFromPoint === 'function') {
      const pos = document.caretPositionFromPoint(evt.clientX, evt.clientY);
      if (!pos) return null;
      node = pos.offsetNode;
      offset = pos.offset;
    } else {
      return null;
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;

    const { segments } = collectTextSegments(root);
    const hitIndex = segments.findIndex(seg => seg.node === node);
    if (hitIndex === -1) return null;
    const nodeTexts = segments.map(seg => seg.node.nodeValue);
    return mapRenderedOffsetToRaw(nodeTexts, hitIndex, offset, rawMarkdown);
  } catch {
    return null;
  }
}

// (TPT179) Single predicate for every read-only lock in the edit modal: a teammate's task
// (C1407, assignee-derived) OR an explicit callbacks.readOnly opt-in from the opener.
function _isModalReadOnly(draft) {
  return commands.isTaskReadOnly(draft) || !!_modalState?.callbacks?.readOnly;
}

function _applyModalLockState(modal, draft) {
  // (C1407) A teammate's task (commands.isTaskReadOnly) locks title/desc/sprint the same as an
  // in-progress task does — plus status/tags/deps/save/reset/chain/reiterate/delete,
  // all handled at render time in _renderTaskEditModal() (readOnly/agentLocked locals
  // there) since those don't need live re-sync on a status change the way title/desc/
  // sprint do here. Comment composer deliberately stays live either way.
  const locked = isInProgressName(draft.status) || _isModalReadOnly(draft);
  const titleInput = modal.querySelector('.modal-title-input');
  // C1095: in diff mode there are two .modal-desc-display elements (old + new) —
  // the lock only ever applies to the editable (new/no-diff-attr) one; the old side
  // is inherently read-only regardless of lock state.
  const descDisplay = modal.querySelector('.modal-desc-display:not([data-diff-side="old"])');
  const descTextarea = modal.querySelector('.modal-desc-textarea');
  const sprintComboEl = modal.querySelector('.sprint-combo[data-id="modal-sprint-combo"]');
  const sprintInput = sprintComboEl?.querySelector('.sprint-combo-input');
  const sprintDropdown = sprintComboEl && (sprintComboEl._portaledDropdown || sprintComboEl.querySelector('.sprint-combo-dropdown'));

  if (titleInput) {
    titleInput.readOnly = locked;
    titleInput.classList.toggle('field-locked', locked);
  }
  if (descDisplay) {
    descDisplay.classList.toggle('field-locked', locked);
    if (locked) {
      descDisplay.removeAttribute('role');
      descDisplay.removeAttribute('tabindex');
      descDisplay.removeAttribute('aria-label');
    } else {
      descDisplay.setAttribute('role', 'button');
      descDisplay.tabIndex = 0;
      descDisplay.setAttribute('aria-label', t('modal.editDescription'));
    }
  }
  const diffTitleDisplay = modal.querySelector('.diff-title-display[data-diff-side="new"]');
  if (diffTitleDisplay) {
    if (locked) {
      diffTitleDisplay.removeAttribute('role');
      diffTitleDisplay.removeAttribute('tabindex');
      diffTitleDisplay.removeAttribute('aria-label');
    } else {
      diffTitleDisplay.setAttribute('role', 'button');
      diffTitleDisplay.tabIndex = 0;
      diffTitleDisplay.setAttribute('aria-label', t('modal.editTitle'));
    }
  }
  if (descTextarea) {
    descTextarea.readOnly = locked;
    descTextarea.classList.toggle('field-locked', locked);
  }
  if (sprintInput) {
    sprintInput.disabled = locked;
    sprintInput.classList.toggle('field-locked', locked);
  }
  if (sprintDropdown && locked) {
    sprintDropdown.hidden = true;
  }

  // (C1407) Dep chips' remove buttons — _renderDepChip() is shared with the New Task form
  // (which is never read-only), so the disable lives here as a post-render DOM pass rather
  // than a param threaded through that shared helper.
  if (_isModalReadOnly(draft)) {
    modal.querySelectorAll('.modal-deps .chip-remove').forEach(btn => {
      btn.disabled = true;
      btn.hidden = true;
    });
  }

  // (TPT55) Agent-model select + Claude design-mode checkbox carry a `disabled` attribute
  // baked in at render time from the `agentLocked` local (_renderTaskEditModal — same
  // predicate as below). Unlike the agent picker (rebuilt in place) and the member combo
  // (setDisabled()), these two had no live re-sync, so switching status back to a pending
  // role inside an already-open modal left them stuck disabled from the prior in_progress/
  // canceled/read-only render. Re-derive and reapply here so status changes take effect
  // immediately; the call from _renderTaskEditModal() itself is a no-op since it recomputes
  // the identical value the markup already used.
  const agentLocked = commands.isAgentLocked(draft.status) || _isModalReadOnly(draft);
  const modelSelect = modal.querySelector('.modal-agent-model-select');
  const designModeCb = modal.querySelector('.modal-claude-design-mode');
  if (modelSelect) modelSelect.disabled = agentLocked;
  if (designModeCb) designModeCb.disabled = agentLocked;
  // (TPT285) Effort select — same live re-sync.
  const effortSelect = modal.querySelector('.modal-effort-select');
  if (effortSelect) effortSelect.disabled = agentLocked;
  // (TPT95) Same live re-sync as the two above.
  modal.querySelectorAll('.modal-browser-tool').forEach(cb => { cb.disabled = agentLocked; });
}

// (C1316) Single source of truth for the modal dirty check — was inlined identically
// at 4 call sites (closeTaskEditModal, initial render, button-state sync, Start branch).
function _isModalDirty() {
  if (!_modalState) return false;
  return JSON.stringify(_modalState.draft) !== JSON.stringify(_modalState.original);
}

function _modalUpdateButtonStates(saveBtn, resetBtn) {
  const dirty = _isModalDirty();
  saveBtn.disabled = !dirty;
  resetBtn.disabled = !dirty;
}

function _attachModalHandlers(modal) {
  const overlay  = modal.querySelector('.task-edit-overlay');
  const titleInput = modal.querySelector('.modal-title-input');
  // C1095: in diff mode there are two .modal-desc-display elements (old + new) — the
  // editable one is always the one WITHOUT data-diff-side="old" (either the plain
  // no-diff-mode element, or the new/right-hand one).
  const descDisplay = modal.querySelector('.modal-desc-display:not([data-diff-side="old"])');
  const statusSelect = modal.querySelector('.modal-status-select');
  const agentPickerEl = modal.querySelector('.agent-picker[data-name="agentAssignee"]');
  const saveBtn  = modal.querySelector('.btn-modal-save');
  const resetBtn = modal.querySelector('.btn-modal-reset');
  modal.querySelector('.btn-modal-cancel').addEventListener('click', () => { void requestCloseTaskEditModal(); });
  const sprintCombo = modal.querySelector('.sprint-combo[data-id="modal-sprint-combo"]');

  const upd = () => _modalUpdateButtonStates(saveBtn, resetBtn);
  const commitAgentChoice = (value, { piModel } = {}) => {
    commands._applyAgentPickerSelection(_modalState.draft, value, { piModel });
    _applyModalAgentModelVisibility(
      modal,
      _modalState.draft.agentAssignee || '',
      _modalState.draft,
      _modalState.projectConfig || {},
      { hideBrowserTools: !!_modalState.callbacks.preloadedTask },
    );
    upd();
  };
  const switchTab = (tab) => {
    modal.querySelectorAll('.modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    modal.querySelectorAll('.modal-tab-panel').forEach(panel => {
      panel.hidden = panel.dataset.tab !== tab;
    });
    if (tab === 'comments') {
      _observeVisibleComments(modal);
    } else {
      _disconnectCommentSeenObserver();
    }
    if (tab === 'notifications') {
      // (TPT17) Refetch on every activation — not just on modal open — so a comment/status
      // change made by someone else while the modal was already open shows up, and the
      // Subscribed checkbox always reflects the server's current state.
      _disconnectNotifSeenObserver();
      if (_modalState) {
        _modalState.eventsLoading = true;
        _renderModalEvents(modal);
        void _loadModalEvents(_modalState.taskId);
      }
    } else {
      _disconnectNotifSeenObserver();
    }
  };

  modal.querySelectorAll('.modal-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Backdrop close: require both mousedown+mouseup on overlay — prevents resize-drag
  // releasing over backdrop from closing the modal.
  let _overlayMdTarget = null;
  overlay.addEventListener('mousedown', (e) => { _overlayMdTarget = e.target; });
  overlay.addEventListener('mouseup', (e) => {
    if (_overlayMdTarget === overlay && e.target === overlay) void requestCloseTaskEditModal();
    _overlayMdTarget = null;
  });

  // C981: delegated click-to-zoom on rendered images inside the description
  // and comments. Registered on .task-edit-panel (rebuilt each full re-render,
  // but survives per-comment re-renders which only replace .comments-list) so
  // one listener covers both surfaces without re-attaching per image. Capture
  // phase + stopPropagation so an image click never reaches descDisplay's own
  // click handler (which would otherwise swap the description into edit mode).
  const panel = modal.querySelector('.task-edit-panel');
  panel?.addEventListener('click', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.closest('.modal-desc-display') && !img.closest('.comment-item')) return;
    e.preventDefault();
    e.stopPropagation();
    _openImageLightbox(img.currentSrc || img.src, img.alt);
  }, true);

  // Title
  titleInput.addEventListener('input', () => {
    _modalState.draft.title = titleInput.value;
    upd();
    if (_modalState.compareTask) _scheduleModalDiffRecompute(modal, { title: true });
  });

  // C1095: diff mode — title display swaps to the (hidden-by-default) input on click,
  // mirroring the description's click-to-edit pattern below. Non-diff mode leaves
  // titleInput visible/editable directly, exactly as before.
  if (_modalState.compareTask) {
    const newTitleDisplay = modal.querySelector('.diff-title-display[data-diff-side="new"]');
    if (newTitleDisplay) {
      const editTitle = () => {
        if (isInProgressName(_modalState.draft.status) || _isModalReadOnly(_modalState.draft)) return;
        newTitleDisplay.hidden = true;
        titleInput.hidden = false;
        titleInput.focus();
      };
      newTitleDisplay.addEventListener('click', editTitle);
      newTitleDisplay.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        editTitle();
      });
    }
    titleInput.addEventListener('blur', () => {
      titleInput.hidden = true;
      if (newTitleDisplay) newTitleDisplay.hidden = false;
      _applyModalDiffHighlights(modal);
    });
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); titleInput.blur(); newTitleDisplay?.focus();
      }
    });
  }

  // Description display is a keyboard-operable editor trigger when text is editable.
  const editDescription = (evt) => {
    if (!_modalState) return; // modal torn down mid-flight — draft below would throw
    if (isInProgressName(_modalState.draft.status)) return;
    if (_isModalReadOnly(_modalState.draft)) return; // (C1470) was CSS-only (.field-locked pointer-events) before
    if (descDisplay.dataset.diffSide === 'old') return; // defensive — old side never has this listener (selector at top of fn), but never let it click-to-edit if it ever does
    if (descDisplay.style.display === 'none') return;
    const rawDesc = _modalState.draft.description || '';
    // (C1470) Resolve BEFORE any DOM changes — needs the display's live rendered geometry.
    // Maps against the raw value verbatim (not normalizeRaw()'d) since that's what ta.value
    // is about to hold.
    const caretOffset = evt instanceof MouseEvent && evt.detail > 0
      ? _caretOffsetFromClick(evt, rawDesc) : null;
    // Measure before any DOM changes so layout is stable
    const displayHeight = descDisplay.getBoundingClientRect().height;
    const ta = document.createElement('textarea');
    ta.id = 'modal-desc-textarea';
    ta.className = 'modal-desc-textarea';
    ta.setAttribute('aria-label', t('field.description'));
    ta.value = rawDesc;
    ta.style.height = displayHeight + 'px'; // pre-reparent pin, avoids a flash before the correction below
    descDisplay.style.display = 'none';
    descDisplay.parentNode.insertBefore(ta, descDisplay.nextSibling);
    _attachImageHandlers(ta);
    // (C1212) mic → dictate into description via createLiveInserter. keep handle: blur
    // teardown below must not rip field out from under a live recording.
    const micHandle = attachAudioRecorder(ta);
    // (C1470) attachAudioRecorder just re-parented ta into a .audio-rec-wrap and stacked a
    // mic button above it — that adds height the displayHeight pin above didn't account for.
    // Subtract the wrap's overhead so the TOTAL swapped-in block still matches displayHeight.
    const micWrap = ta.closest('.audio-rec-wrap');
    if (micWrap) {
      const overhead = micWrap.getBoundingClientRect().height - ta.getBoundingClientRect().height;
      ta.style.height = Math.max(0, displayHeight - overhead) + 'px';
    }
    // (TPT34) Must run before the keydown listener below (Escape→blur) is registered — see
    // _attachMentionTypeahead's own comment for why ordering matters on a shared element.
    _attachMentionTypeahead(ta);
    // C1095: while editing raw markdown, show the OLD side as raw highlighted text too
    // (not rendered) — comparing raw-vs-raw while typing, rendered-vs-rendered once
    // blurred, keeps highlight ranges internally consistent on both sides at all times.
    if (_modalState.compareTask) _switchOldSideToRawMode(modal);
    // (C1470) Set selection before focus() — Chromium scrolls the caret into view on focus,
    // so doing it in this order means the visible scroll position already matches the caret.
    // Null (unresolved click, e.g. clicked padding/an image/unsupported API) falls back to
    // today's top-anchored behavior instead of an arbitrary position.
    ta.setSelectionRange(caretOffset ?? 0, caretOffset ?? 0);
    ta.focus();
    if (caretOffset == null) ta.scrollTop = 0;
    ta.addEventListener('input', () => {
      _modalState.draft.description = ta.value;
      // (C1470) Auto-grow while typing so leaving edit mode isn't a jump either — cap
      // mirrors .modal-desc-display's max-height (60vh plain, 40vh in the narrower diff
      // columns, see styles.css .task-edit-panel--diff .modal-desc-textarea).
      autoGrowTextarea(ta, window.innerHeight * (_modalState.compareTask ? 0.4 : 0.6));
      upd();
      if (_modalState.compareTask) _scheduleModalDiffRecompute(modal, { description: true });
    });
    let restoreDisplayFocus = false;
    ta.addEventListener('blur', () => {
      _modalState.draft.description = ta.value;
      // (C1212) mic click blurs field (mousedown preventDefault stops focus-steal, but
      // toggling mid-dictation still blurs via other paths) — keep editor open while
      // recording live, else field ripped out from under createLiveInserter.
      if (micHandle?.isActive) { upd(); return; }
      const wrap = ta.closest('.audio-rec-wrap') || ta; // (C1212) remove mic wrap too, not just ta
      if (_modalState.compareTask) {
        descDisplay.style.display = '';
        wrap.remove();
        _applyModalDiffHighlights(modal); // restores rendered markdown + highlights, both sides
      } else {
        descDisplay.innerHTML = _renderDescriptionHtml(ta.value);
        descDisplay.style.display = '';
        wrap.remove();
      }
      upd();
      if (restoreDisplayFocus) descDisplay.focus();
    });
    ta.addEventListener('keydown', (e) => {
      // stopPropagation: without it, Escape also reaches template.html's document-level
      // Escape listener (closeTaskEditModal()) on the same keypress — blurring the
      // textarea AND closing the modal at once. Pre-existing; matters more here because
      // blur also triggers a full diff re-highlight.
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); restoreDisplayFocus = true; ta.blur();
      }
    });
  };
  descDisplay.addEventListener('click', editDescription);
  descDisplay.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    editDescription(e);
  });

  // C1095: diff-mode escape hatch — close this modal and open the real board-path one.
  const openLiveBtn = modal.querySelector('.btn-diff-open-live');
  if (openLiveBtn) {
    openLiveBtn.addEventListener('click', () => {
      const onOpenLiveTask = _modalState.callbacks.onOpenLiveTask;
      const liveTaskId = _modalState.taskId;
      closeTaskEditModal(true);
      if (onOpenLiveTask) onOpenLiveTask(liveTaskId);
    });
  }

  // Status
  statusSelect.addEventListener('change', () => {
    _modalState.draft.status = statusSelect.value;
    // (TPT307) Header status pill is tinted from --status-color — recolor live, like a card's pill.
    statusSelect.style.setProperty('--status-color', statusColor(statusSelect.value));
    _applyModalLockState(modal, _modalState.draft);
    const slot = modal.querySelector('.modal-field-row .agent-picker[data-name="agentAssignee"]')?.parentElement;
    if (slot) {
      const oldPicker = slot.querySelector('.agent-picker[data-name="agentAssignee"]');
      if (oldPicker) {
        const tmp = document.createElement('div');
        tmp.innerHTML = commands.renderAgentPicker(
          'agentAssignee',
          _modalState.draft.agentAssignee || '',
          commands.isAgentLocked(_modalState.draft.status),
          commands._taskAgentPickerOptions(),
          _modalState.draft.piModel,
        );
        const newPicker = tmp.firstElementChild;
        oldPicker.replaceWith(newPicker);
        commands.initAgentPicker(newPicker, { onChange: commitAgentChoice });
      }
    }
    // Sync disabled state of member combo-box with agent-lock rule
    _modalState._memberCombo?.setDisabled(commands.isAgentLocked(_modalState.draft.status));
    upd();
  });

  // Sprint
  if (sprintCombo) {
    initSprintCombobox(sprintCombo, { onSelect: (raw) => {
      _modalState.draft.priority = raw === 'null'
        ? 0
        : raw === '__new__'
          ? Math.max(...commands.sprintTierKeys(state.tierKeys), 0, sprintRecordMax(state.sprints)) + 1
          : Number(raw);
      upd();
    }});
  }

  // Agent assignee
  if (agentPickerEl) commands.initAgentPicker(agentPickerEl, { onChange: commitAgentChoice });

  // Member assignee — host-agnostic combo-box factory (C1251). Destroy any
  // prior handle first: Reset re-renders the modal and re-runs this whole
  // function against the same _modalState, and the factory owns a resize
  // listener + a body-portaled dropdown that would otherwise leak.
  _modalState._memberCombo?.destroy();
  _modalState._memberCombo = commands._createMemberCombobox(modal, {
    getValue: () => _modalState.draft.assignee ?? null,
    setValue: (id) => { _modalState.draft.assignee = id; },
    isAlive: () => modal.isConnected && !!_modalState,
    // (C1407) Also locked for the lifetime of a read-only (teammate's) task — status can't
    // change out from under it since the status select itself is disabled in that case.
    isDisabled: () => commands.isAgentLocked(_modalState.draft.status) || _isModalReadOnly(_modalState.draft),
    scrollEl: modal.querySelector('.task-edit-overlay'),
    onResizeHandler: () => {}, // destroy() above owns teardown
    onUpdate: upd,
  });

  // Agent model — one per-task select, repopulated for Claude or Codex.
  const agentModelSel = modal.querySelector('.modal-agent-model-select');
  if (agentModelSel) agentModelSel.addEventListener('change', () => {
    if (agentModelSel.dataset.agent === 'claude') _modalState.draft.claudeModel = agentModelSel.value || null;
    if (agentModelSel.dataset.agent === 'codex') _modalState.draft.codexModel = agentModelSel.value || null;
    upd();
  });

  // C1207 — per-task Claude /design mode checkbox
  const designModeCb = modal.querySelector('.modal-claude-design-mode');
  if (designModeCb) designModeCb.addEventListener('change', () => { _modalState.draft.claudeDesignMode = designModeCb.checked; upd(); });

  // (TPT285) Per-task effort — blank option = null (inherit the agent default).
  const effortSel = modal.querySelector('.modal-effort-select');
  if (effortSel) effortSel.addEventListener('change', () => { _modalState.draft.effort = effortSel.value || null; upd(); });

  // (TPT95) Codex-only browser-tools checkboxes — project-level MCP_BROWSER_TOOLS, NOT
  // a task field: writes straight to state/config via commands.writeProjectBrowserTools(), never
  // into _modalState.draft. Must not call upd() either — upd()'s dirty check is a
  // draft/original diff (_isModalDirty()), and this setting has no draft/original pair
  // for Save to act on.
  modal.querySelectorAll('.modal-browser-tool').forEach(cb => {
    cb.addEventListener('change', () => {
      const ids = Array.from(modal.querySelectorAll('.modal-browser-tool:checked')).map(el => el.value);
      commands.writeProjectBrowserTools(ids);
    });
  });

  // Tags
  _attachModalTagInput(modal, upd);

  // Dependencies
  _attachModalDepsInput(modal, () => {
    upd();
    _syncModalStartDependencyState(modal);
  });

  // Comments
  _attachModalCommentHandlers(modal);
  _attachCommentEditHandlers(modal);

  // Notifications
  _attachModalNotifHandlers(modal);

  // (C1316) Shared persist path — used by the Save button and by Start, which must write
  // a dirty draft before launching (agent sessions read the task from the server, so an
  // unsaved edit would otherwise be invisible to the launched agent). Resolves true when
  // the stored task matches the draft (saved, or nothing to save), false when the write
  // failed and an error alert has already been shown to the user.
  const persistDraft = async () => {
    try {
    const { draft, original, taskId, callbacks } = _modalState;
    const patch = {};
    if (draft.title !== original.title) patch.title = draft.title;
    if (draft.description !== original.description) patch.description = draft.description;
    if (draft.status !== original.status) patch.status = draft.status;
    if (draft.priority !== original.priority) {
      if (taskHasNullSprint(draft)) patch.sprint_id = null;
      else patch.priority = draft.priority;
    }
    if ((draft.agentAssignee || null) !== (original.agentAssignee || null)) patch.agent_assignee = draft.agentAssignee || null;
    if ((draft.assignee || null) !== (original.assignee || null)) patch.assignee = draft.assignee || null;
    if (JSON.stringify(draft.tags || []) !== JSON.stringify(original.tags || [])) patch.tags = draft.tags || [];
    if (JSON.stringify(draft.dependencies || []) !== JSON.stringify(original.dependencies || [])) patch.dependencies = draft.dependencies || [];
    if ((draft.claudeModel || null) !== (original.claudeModel || null)) patch.claude_model = draft.claudeModel || null;
    if ((draft.codexModel  || null) !== (original.codexModel  || null)) patch.codex_model  = draft.codexModel  || null;
    if ((draft.piModel     || null) !== (original.piModel     || null)) patch.pi_model     = draft.piModel     || null;
    if ((draft.effort      || null) !== (original.effort      || null)) patch.effort       = draft.effort      || null;
    // C1207: `!!` on BOTH sides, not the `|| null` shape used for the model fields above.
    // `false || null` is `null`, and `null !== false` would fire a spurious PATCH on every
    // save of any task with design mode off.
    if (!!draft.claudeDesignMode !== !!original.claudeDesignMode) patch.claude_design_mode = !!draft.claudeDesignMode;
    if (!Object.keys(patch).length) return true;
    // In-memory proposal save: delegate to caller, skip all DB/board-DOM operations.
    if (callbacks.onSavePreview) {
      await callbacks.onSavePreview(draft);
      return true;
    }
    let updateResult;
    try {
      updateResult = await api.tasks.update(taskId, patch);
    } catch (err) { console.error('[modal] Task update failed:', err); showToast(t('common.networkError', { msg: err.message }), 'error'); return false; }
    // (C1316) The modal may have been closed/replaced by the time the PATCH resolves
    // (e.g. Start already tore it down while awaiting persistDraft()) — the write itself
    // succeeded, so report success, but skip the board-DOM/baseline bookkeeping below
    // since _modalState no longer refers to this save.
    if (!_modalState || _modalState.taskId !== taskId) return true;
    // Sprint change: immediately move card to its new tier (or reload for edge cases).
    if (draft.priority !== original.priority) {
      const r = commands.regroupCardToSprint(taskId, draft.priority, taskHasNullSprint(draft));
      // TPT3 — the server only ever emits parent_rescheduled when this PATCH actually
      // changed priority, so gating the cascade check inside this same branch is correct.
      const parentTouched = updateResult?.parentRescheduled
        && commands.applyParentSprintFollow(updateResult.parentRescheduled);
      if (commands.regroupNeedsReload(r) || parentTouched) _modalState.callbacks?.onLoadAndRender?.({ forceFresh: true });
    }
    if ('agent_assignee' in patch) {
      const card = document.querySelector(`.card[data-id="${CSS.escape(taskId)}"]`);
      if (card) {
        card.querySelector('.agent-badge')?.remove();
        const newAssignee = draft.agentAssignee || '';
        card.dataset.agentAssignee = newAssignee;
        card.classList.toggle('has-agent-badge', !!newAssignee);
        if (newAssignee) {
          const html = commands.renderAgentBadge({ id: taskId, agentAssignee: newAssignee, status: card.dataset.status });
          if (html) card.querySelector('.card-top')?.insertAdjacentHTML('beforebegin', html);
        }
      }
    }
    // Patch card in-place so title/description/tags/status update immediately.
    // Required in Electron mode where the board WS is not connected and
    // task:updated broadcasts never reach the renderer. Safe no-op when the
    // card was detached by the sprint-move above (priority changed case).
    commands.refreshCard(_modalState.draft);
    _modalState.original  = structuredClone(draft);
    _modalState.lastSaved = structuredClone(draft);
    _modalState.hasSavedOnce = true;
    // (TPT374) _modalSessionButton() reads the just-updated lastSaved.status, not draft — do
    // this after the assignment above so a saved status change (e.g. Start's own in_progress
    // write) repaints this modal's own footer button, not just the board card.
    syncTaskEditSessionButtons();
    upd();
    return true;
    } catch (err) { console.error('[modal] Save failed:', err); showToast(t('modal.errSave', { msg: err.message }), 'error'); return false; }
  };

  // Save
  saveBtn.addEventListener('click', () => { persistDraft(); });

  // Reset
  resetBtn.addEventListener('click', () => {
    _modalState.draft = structuredClone(_modalState.lastSaved);
    _renderTaskEditModal();
    _modalDialogFocus?.focusFirst();
  });

  // Context buttons
  modal.querySelector('.modal-context-btns').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { draft, taskId, callbacks } = _modalState;
    const action = btn.dataset.action;

    if (action === 'start') {
      // Dependencies can change without a full modal re-render. Re-check the shared
      // predicate before saving or launching so stale button state cannot bypass the gate.
      // (TPT111) The modal is interactive from first paint now, before the project task
      // list round-trip lands — a click that races it must wait for the real list rather
      // than gate on the state.taskStatusById fallback, which is assignee/sprint-window
      // scoped (see loadAndRender()) and can fail a dependency open by omission. No-op
      // once the list is already cached (the common case — the request was fired at
      // modal open, well before a user can click Start).
      if (!Array.isArray(commands.getProjectTaskList())) await commands._ensureProjectTaskList();
      if (commands.hasUnmetDeps(draft, commands.getProjectTaskList())) {
        _syncModalStartDependencyState(modal, draft);
        return;
      }
      // (C1316) Persist a dirty draft and wait for success before launching — the agent
      // reads the task from the server, so an unsaved edit must land before Start fires.
      // A clean draft launches immediately, no extra round-trip.
      if (_isModalDirty()) {
        btn.disabled = true; // re-entrancy guard: no double-launch while the save is in flight
        let saved = false;
        try { saved = await persistDraft(); } finally { _syncModalStartDependencyState(modal, draft); }
        if (!saved) return; // error already alerted; modal stays open, nothing launched
      }
      closeTaskEditModal(true);
      if (callbacks.onStart) await callbacks.onStart(draft);
    } else if (action === 'stop') {
      // (TPT395) Same save-first path as Start (C1316): persist a dirty draft before
      // stopping so edits made while the session ran are not discarded by the close.
      if (_isModalDirty()) {
        btn.disabled = true; // re-entrancy guard while the save is in flight
        let saved = false;
        try { saved = await persistDraft(); } finally { btn.disabled = false; }
        if (!saved) return; // persistDraft() already toasted; modal stays open, session untouched
      }
      clearAttention(taskId, 'session-ended');
      commands.terminateSessionFromCard(taskId);
      closeTaskEditModal(true);
    } else if (action === 'reiterate') {
      closeTaskEditModal(true);
      if (callbacks.onLoadAndRender) commands.showReiterateModal(taskId, draft.title, callbacks.onLoadAndRender);
    } else if (action === 'delete') {
      commands.showDeleteConfirmModal(taskId, draft.title, () => {
        closeTaskEditModal(true);
        if (callbacks.onLoadAndRender) callbacks.onLoadAndRender();
      });
    }
  });
}

async function _uploadModalImage(file, taskKey = null) {
  const data = await new Promise(res => {
    const r = new FileReader();
    r.onload = e => res(e.target.result.split(',')[1]);
    r.readAsDataURL(file);
  });
  return api.images.upload(file.name, file.type, data, taskKey); // { id, url }
}

function _insertMarkdownImage(textarea, url, name) {
  insertAtCursor(textarea, `![${name}](${url})`);
}

function _attachImageHandlers(textarea) {
  const taskKey = _modalState?.taskId || null;
  commands.attachImagePaste(textarea, null, { taskKey });
  const handle = async (file) => {
    try {
      const { url } = await _uploadModalImage(file, taskKey);
      _insertMarkdownImage(textarea, url, file.name);
    } catch (err) {
      showToast(t('common.errImageUpload', { msg: err.message }), 'error');
    }
  };
  textarea.addEventListener('dragover', (e) => {
    e.preventDefault();
    textarea.classList.add('img-drop-active');
  });
  textarea.addEventListener('dragleave', () => textarea.classList.remove('img-drop-active'));
  textarea.addEventListener('drop', (e) => {
    e.preventDefault();
    textarea.classList.remove('img-drop-active');
    Array.from(e.dataTransfer.files || [])
      .filter(f => f.type.startsWith('image/'))
      .forEach(handle);
  });
}

// (TPT17) Subscribed checkbox — toggling calls PUT .../subscription, reverts + toasts on
// failure. Independent of the comment-submit compose box below; wired separately so a
function _attachModalNotifHandlers(modal) {
  const checkbox = modal.querySelector('.modal-notif-subscribed-checkbox');
  if (!checkbox) return;
  checkbox.addEventListener('change', async () => {
    if (!_modalState) return;
    const next = checkbox.checked;
    const taskId = _modalState.taskId;
    checkbox.disabled = true;
    try {
      await api.tasks.events.setSubscription(taskId, next);
      if (_modalState && _modalState.taskId === taskId) {
        _modalState.subscribed = next;
      }
    } catch (err) {
      checkbox.checked = !next;
      showToast(t('common.networkError', { msg: err.message }), 'error');
    } finally {
      checkbox.disabled = false;
    }
  });
}

function _attachModalCommentHandlers(modal) {
  const textarea = modal.querySelector('.comment-input');
  const submitBtn = modal.querySelector('.comment-submit');
  if (!textarea || !submitBtn) return;

  _attachImageHandlers(textarea);
  attachAudioRecorder(textarea); // (C1212) mic → dictate into comment box via createLiveInserter
  _attachMentionTypeahead(textarea);

  submitBtn.addEventListener('click', async () => {
    if (!_modalState) return;
    const content = textarea.value.trim();
    if (!content) return;
    submitBtn.disabled = true;
    try {
      const comment = await api.tasks.comments.create(_modalState.taskId, content);
      _modalState.comments = _sortModalComments([comment, ...(_modalState.comments || [])]);
      _setSeenCommentId(_modalState.taskId, _commentId(comment));
      _modalState.commentsLoading = false;
      _modalState.commentsError = '';
      textarea.value = '';
      _removeMentionDropdown();
      _renderModalComments(modal);
    } catch (err) {
      showToast(t('common.networkError', { msg: err.message }), 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// (TPT34) Own-comment inline edit — separate from _attachModalCommentHandlers above (that
// one early-returns when the composer textarea/submit button are missing, e.g. read-only
// mode; the edit affordance must not inherit that coupling). DELEGATED on .comments-list:
// _renderModalComments() rebuilds that element's innerHTML wholesale from several call
// sites (incl. a background member-list refresh), so per-row listeners would be lost on
// the very next render — the .comments-list element itself only changes on a full modal
// render, and this function re-runs then (see the call site below), same reasoning as the
// C981 .task-edit-panel image-lightbox delegation elsewhere in this file.
function _attachCommentEditHandlers(modal) {
  const list = modal.querySelector('.comments-list');
  if (!list) return;

  list.addEventListener('input', (e) => {
    if (!_modalState || !e.target.classList?.contains('comment-edit-input')) return;
    _modalState.editingDraft = e.target.value;
  });

  // Double-click a own-comment body as a second way into edit mode, alongside the Edit
  // button — both routes land on the same [data-act="edit"] handling below.
  list.addEventListener('dblclick', (e) => {
    const body = e.target.closest('.comment-body[data-act="edit"]');
    if (body) _startCommentEdit(modal, list, body.closest('.comment-item'));
  });

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.tagName !== 'BUTTON' || !list.contains(btn) || !_modalState) return;
    const item = btn.closest('.comment-item');

    if (btn.dataset.act === 'edit') return _startCommentEdit(modal, list, item);

    if (btn.dataset.act === 'cancel') {
      _modalState.editingCommentId = null;
      _modalState.editingDraft = '';
      _removeMentionDropdown();
      return _renderModalComments(modal);
    }

    if (btn.dataset.act === 'save') {
      const id = Number(item?.dataset.commentId);
      if (!id) return;
      const content = String(_modalState.editingDraft || '').trim();
      if (!content) return;
      btn.disabled = true;
      try {
        const updated = await api.tasks.comments.update(_modalState.taskId, id, content);
        if (!_modalState) return; // modal torn down mid-flight
        _modalState.comments = _sortModalComments(
          (_modalState.comments || []).map(c => (_commentId(c) === id ? updated : c))
        );
        _modalState.editingCommentId = null;
        _modalState.editingDraft = '';
        _removeMentionDropdown();
        _renderModalComments(modal);
      } catch (err) {
        showToast(t('common.networkError', { msg: err.message }), 'error');
        btn.disabled = false; // leave edit mode open so the user can retry
      }
    }
  });
}

function _startCommentEdit(modal, list, item) {
  const id = Number(item?.dataset.commentId);
  if (!id || !_modalState) return;
  const comment = (_modalState.comments || []).find(c => _commentId(c) === id);
  if (!comment || !_canEditComment(comment)) return;
  _modalState.editingCommentId = id;
  _modalState.editingDraft = comment.content || '';
  _removeMentionDropdown();
  _renderModalComments(modal);
}

function _attachModalTagInput(modal, onUpdate) {
  const tagsDiv = modal.querySelector('.modal-tags');
  const input   = modal.querySelector('.modal-tag-input');
  if (!tagsDiv || !input) return;
  let dropdown = null;
  let options = [];
  let activeIndex = -1;
  let blurTimer = null;

  function positionDropdown() {
    if (!dropdown) return;
    const inputR = input.getBoundingClientRect();
    const rowR = tagsDiv.getBoundingClientRect();
    dropdown.style.top   = `${inputR.bottom + 2}px`;
    dropdown.style.left  = `${rowR.left}px`;
    dropdown.style.width = `${rowR.width}px`;
  }

  const onScrollOrResize = () => positionDropdown();
  const overlay = modal.querySelector('.task-edit-overlay');
  if (overlay) overlay.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  if (_modalState) _modalState._tagDropdownHandlers = { resize: onScrollOrResize };

  function refreshChips() {
    tagsDiv.querySelectorAll('.modal-tag-chip').forEach(c => c.remove());
    const frag = document.createDocumentFragment();
    (_modalState.draft.tags || []).forEach(tag => {
      const span = document.createElement('span');
      span.className = 'tag-chip modal-tag-chip';
      span.dataset.tag = tag;
      const desc = state.tagDescriptions.get(tag);
      if (desc) span.title = desc;
      span.innerHTML = `${escapeAttr(tag)}<button class="chip-remove" type="button" data-tag="${escapeAttr(tag)}">&times;</button>`;
      frag.appendChild(span);
    });
    tagsDiv.insertBefore(frag, input);
  }

  function hideDropdown() {
    if (dropdown) dropdown.remove();
    dropdown = null;
    options = [];
    activeIndex = -1;
  }

  function updateDropdownActive() {
    if (!dropdown) return;
    dropdown.querySelectorAll('.tag-typeahead-option').forEach((option, i) => {
      option.classList.toggle('active', i === activeIndex);
    });
  }

  function addTag(raw) {
    const tag = raw.trim();
    if (!tag) return;
    const tags = _modalState.draft.tags = _modalState.draft.tags || [];
    if (tags.some(t => t.toLowerCase() === tag.toLowerCase())) { input.value = ''; hideDropdown(); return; }
    tags.push(tag);
    refreshChips();
    input.value = '';
    hideDropdown();
    onUpdate();
  }

  function selectOption(index) {
    const entry = options[index];
    const name = commands._projectTagName(entry);
    if (!name) return;
    addTag(name);
  }

  function renderDropdown() {
    if (!options.length) {
      hideDropdown();
      return;
    }
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.className = 'tag-typeahead-dropdown';
      document.body.appendChild(dropdown);
    }
    dropdown.innerHTML = options.map((entry, i) => {
      const name = commands._projectTagName(entry);
      const desc = tagDescription(entry, state.tagDescriptions);
      return `<div class="tag-typeahead-option${i === activeIndex ? ' active' : ''}" data-index="${i}">${escapeAttr(name)}${desc ? `<small>${escapeAttr(desc)}</small>` : ''}</div>`;
    }).join('');
    dropdown.querySelectorAll('.tag-typeahead-option').forEach(option => {
      option.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectOption(Number(option.dataset.index));
      });
    });
    positionDropdown();
  }

  async function refreshDropdown() {
    const query = input.value.trim().toLowerCase();
    if (!query) {
      hideDropdown();
      return;
    }
    const tags = await commands._ensureProjectTags();
    if (!modal.isConnected || !_modalState) return;
    if (query !== input.value.trim().toLowerCase()) {
      void refreshDropdown();
      return;
    }
    options = filterTagOptions(tags, query, {
      selected: _modalState.draft.tags || [],
      descriptions: state.tagDescriptions,
      limit: 8,
    });
    activeIndex = options.length ? 0 : -1;
    renderDropdown();
  }

  tagsDiv.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-remove');
    if (!btn) return;
    const tag = btn.dataset.tag;
    _modalState.draft.tags = (_modalState.draft.tags || []).filter(t => t !== tag);
    refreshChips();
    void refreshDropdown();
    onUpdate();
  });

  input.addEventListener('input', () => {
    void refreshDropdown();
  });

  input.addEventListener('keydown', (e) => {
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
      if (options.length && activeIndex >= 0) selectOption(activeIndex);
      else addTag(input.value);
    } else if (e.key === ',') {
      e.preventDefault();
      addTag(input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideDropdown();
    } else if (e.key === 'Backspace' && !input.value && (_modalState.draft.tags || []).length) {
      _modalState.draft.tags.pop();
      refreshChips();
      void refreshDropdown();
      onUpdate();
    }
  });

  input.addEventListener('blur', () => {
    blurTimer = setTimeout(hideDropdown, 50);
  });

  input.addEventListener('focus', () => {
    if (blurTimer) clearTimeout(blurTimer);
    void refreshDropdown();
  });
}

// Adapt the shared dependency chip control to this modal's draft and lifetime.
function _attachModalDepsInput(modal, onUpdate) {
  commands._createDepsChipInput(modal, {
    scrollEl: modal.querySelector('.task-edit-overlay'),
    isAlive: () => modal.isConnected && !!_modalState,
    getDeps: () => _modalState.draft.dependencies || [],
    setDeps: (next) => { _modalState.draft.dependencies = next; },
    getExcludedIds: () => (_modalState.draft.id ? [_modalState.draft.id] : []),
    getCandidates: () => (Array.isArray(_modalState.callbacks.depCandidates) ? _modalState.callbacks.depCandidates : []),
    onResizeHandler: (h) => { if (_modalState) _modalState._depDropdownHandlers = { resize: h }; },
    onUpdate,
  });
}

export function syncTaskEditSessionButtons() {
  if (!_modalState) return;
  const modalTaskId = _modalState.draft?.id;
  const modal = document.getElementById('task-edit-modal');
  const startBtn = modal?.querySelector('[data-action="start"]');
  if (!startBtn || !modalTaskId) return;
  const isActive = state.activeSessions.has(modalTaskId);
  const sessionBtn = _modalSessionButton(_modalState.draft);
  // (TPT374) Only rebuild icon+label when the mode actually changed — rewriting the spinner
  // span on every repaint (session/attention events fire often) would restart its CSS
  // animation. _syncModalStartDependencyState() below still owns the title on every call.
  if (startBtn.dataset.sessionMode !== sessionBtn.mode) {
    startBtn.dataset.sessionMode = sessionBtn.mode;
    startBtn.innerHTML = `${sessionBtn.icon}<span class="btn-label">${sessionBtn.label}</span>`;
  }
  _syncModalStartDependencyState(modal, _modalState.draft);
  const ctxBtns = modal.querySelector('.modal-context-btns');
  const existingStop = ctxBtns?.querySelector('[data-action="stop"]');
  if (isActive && !existingStop && ctxBtns) {
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.dataset.action = 'stop';
    stopBtn.innerHTML = `${commands.STOP_ICON}<span class="btn-label">${t('btn.stop')}</span>`;
    startBtn.insertAdjacentElement('afterend', stopBtn);
  } else if (!isActive && existingStop) {
    existingStop.remove();
  }
}
