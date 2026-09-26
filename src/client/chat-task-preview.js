// ── Task card previews within chat replies ──
import state from './state.js';
import { statusLabel, statusColor, statusRoleToken, isActiveName, isStartName, startName } from './status-registry.js';
import { escapeAttr, showSaveToast, showToast, fetchWithRetry, projectHeader, showSavingIndicator, hideSavingIndicator, buildUsedIds, upsertTaskEntry } from './utils.js';
import { collapseCard, renderAgentBadge, renderCard as renderBoardCard } from './task-card.js';
import { api } from './api-client.js';
import {
  getUnsavedAcceptedCountForMsg, getConfirmedTaskIds,
  captureCardEdits, saveChatState, saveChatDraft, syncDiscussLocks,
} from './chat-ui.js';
import { cleanupChat } from './console-modal.js';
import { showActionConfirm } from './action-confirm.js';
import { hydrateModifiedCard, buildModifiedTaskPatch, reconcileModifiedCards, parseSnapshotPayload, applyModifiedCardToLiveTask } from './modified-task-merge.js';
import { attachOriginalSpecPayload } from './objective-spec-payload.js';
import { attachNewTagsPayload } from './objective-new-tags.js';
import { shouldCreateObjectiveParent, buildObjectiveParentTask, insertObjectiveParent, newObjectiveParentClientId } from './objective-parent-task.js';
import { resolveOriginPlan, attachSplitOriginPayload, adoptOriginKey, previewOriginSingleTarget, originConflictCardIndexes, outOfSubtreeModifiedIndexes } from './objective-origin-task.js';
import { discardUnsavedProposals, isMessageFullyResolved } from './chat-finalize.js';
// Aliased: `t` is already used locally in this file for "the card's task object"
// (renderCardHtml's renderCard() closure) — importing i18n's t() under its own name would shadow.
import { t as translate, tc } from './i18n.js';
import { groupTitle, groupNoun, getObjectiveGroupingEnabled } from './group-label.js';
import { countPendingSubtaskCards } from './subtask-preview.js';
import { normalizeSingleItemList } from './description-list.js';
// Re-exported so template.html's inline script (reached only via the window.TipTask.chatTaskPreview
// namespace, no direct ES import) can hydrate proposal.task itself in the compareTaskId fallback
// path (C1109's onCompareTaskResolved callback) without a second import wire-up.
export { hydrateModifiedCard };

function reload() {
  document.dispatchEvent(new Event('tiptask:reload'));
}

// Escape markdown strikethrough tildes for preview display only.
// Idempotent: leaves an already-escaped \~ untouched so it never
// double-escapes the planner's \~ output (GFM treats ~ and ~~ as strikethrough).
function escapeMarkdownTilde(text) {
  return String(text ?? '').replace(/\\?~/g, m => (m === '\\~' ? m : '\\~'));
}

// projectHeader() is called per-request (not captured at module load) so each
// request carries the current window's projectPath even if the URL changes.
const PERFORMANCE_SUGGESTION_TAG = 'tt-performance-suggestions';

let _newTaskClientIdSeq = 0;

function taskHasTag(task, tag) {
  return Array.isArray(task?.tags) && task.tags.includes(tag);
}

function normalizePerformanceSuggestionCard(card) {
  const task = card?.task;
  if (!task) return false;
  const isPerfSuggestion = !!card._efficiencyHint || !!task._efficiencyHint || taskHasTag(task, PERFORMANCE_SUGGESTION_TAG);
  if (!isPerfSuggestion) return false;
  if (!Array.isArray(task.tags)) task.tags = [];
  if (!task.tags.includes(PERFORMANCE_SUGGESTION_TAG)) task.tags.push(PERFORMANCE_SUGGESTION_TAG);
  if ((task.priority ?? 0) <= 0) task.priority = 0;
  return true;
}

// (TPT264) A lone "1." item is list syntax the planner contract forbids — render and save
// it as prose. Idempotent, so running it on every render and again on save is safe.
function normalizeCardDescription(card) {
  const task = card?.task;
  if (task && typeof task.description === 'string') task.description = normalizeSingleItemList(task.description);
}

// C1072: no longer a pure assertion — normalizes status per card type. "new" cards
// are force-pinned to pending. "modified" cards keep status ABSENT so Object.assign
// downstream can't flip a live task's real status. card._statusEdited (set only by
// template.html's proposal-edit modal, which today only opens for unconfirmed "new"
// cards — see task-card.js dblclick routing) is a forward-compatible escape hatch,
// not a live path for modified cards. This is also the belt for pre-C1072 chatState
// cards still carrying a stale forced 'pending' from before this fix.
function assertPendingProposalStatus(card, source = 'chat-save') {
  const task = card?.task;
  if (!task) return;
  if (card.type !== 'new') {
    if (!card._statusEdited) delete task.status;
    return;
  }
  // C1245: _statusEdited on a "new" card (manual New Task form) means the user
  // deliberately chose a status — respect it instead of force-pinning to start.
  if (card._statusEdited) return;
  const isPending = isStartName(task.status);
  console.assert(isPending, `[${source}] objective proposal status must be the project's start status`, task);
  if (!isPending) {
    console.warn(`[${source}] forcing proposed task ${task.id || task.title || '<new>'} status "${task.status || '<missing>'}" to "${startName()}"`);
  }
  task.status = startName();
}

function ensureNewTaskClientId(card, usedIds = new Set()) {
  if (!card || card.type !== 'new' || !card.task) return { id: '', oldId: '', changed: false };
  const current = String(card.task.id || '').trim();
  if (current && !usedIds.has(current)) {
    usedIds.add(current);
    return { id: current, oldId: current, changed: false };
  }
  let next;
  do {
    _newTaskClientIdSeq += 1;
    next = `new-${Date.now().toString(36)}-${_newTaskClientIdSeq.toString(36)}`;
  } while (usedIds.has(next));
  const oldId = current;
  card.task.id = next;
  usedIds.add(next);
  return { id: next, oldId, changed: true };
}

function getCardDisplayId(card, isConfirmed) {
  if (card?.type === 'new' && !isConfirmed) return 'new';
  return String(card?.task?.id || 'new');
}

function updatePreviewCardDomId(cardEl, task) {
  if (!cardEl || !task) return;
  const id = String(task.id || 'new');
  cardEl.dataset.taskId = id;
  const badge = cardEl.querySelector('.id-badge');
  if (!badge) return;
  badge.textContent = id;
  // (TPT299) An unsaved `new` card renders its badge hidden (no "new" placeholder next to the
  // NEW label) — reveal it once the card carries a real key.
  badge.hidden = !id || id === 'new' || id.startsWith('new-');
}

// ── Compute minStep for a card given sibling cards + existing tasks ──
// Returns lowest valid step (≥1), or 1 if no deps or all deps in backlog/unknown.
function computeMinStep(card, allCards, existingTasksMap) {
  const deps = card.task.dependencies || [];
  if (deps.length === 0) return 1;

  const cardMap = new Map(allCards.map(c => [c.task.id, c]));
  let max = 0;
  for (const depId of deps) {
    let depPriority = null;
    if (cardMap.has(depId)) {
      depPriority = cardMap.get(depId).task.priority ?? 0;
    } else if (existingTasksMap instanceof Map && existingTasksMap.has(depId)) {
      depPriority = existingTasksMap.get(depId).priority ?? 0;
    }
    if (depPriority !== null && Number(depPriority) > 0 && Number(depPriority) > max) {
      max = Number(depPriority);
    }
  }
  return max > 0 ? max + 1 : 1;
}

// ── Sprint priorities that should appear in the step-selector for a message's cards ──
// Includes: every sprint priority with at least one active existing task, plus every
// sprint priority currently proposed by any card in this message. (C1187: widened from
// pending/in_progress to the full active set — the old literal pair excluded on_fire,
// same latent-bug fix as task-board.js's bulk move-to combobox; consistent choice, see
// that site's comment.)
function computeActiveSteps(allCards, existingTasksMap) {
  const active = new Set();
  if (existingTasksMap instanceof Map) {
    for (const t of existingTasksMap.values()) {
      const p = Number(t.priority ?? 0);
      if (Number.isFinite(p) && p > 0 && isActiveName(t.status)) {
        active.add(p);
      }
    }
  }
  for (const c of allCards) {
    const p = Number(c.task.priority ?? 0);
    if (Number.isFinite(p) && p > 0) active.add(p);
  }
  return [...active].sort((a, b) => a - b);
}

// ── Cascading auto-bump: ensures no card has priority < minStep. Iterates to fixed point. ──
// Does NOT mark cards as pinned — pinning is exclusively user intent (step dropdown).
function cascadeBump(msg) {
  const cards = msg.cards || [];
  const existingMap = msg._existingTasksSnapshot || null;
  const maxIter = cards.length + 1;
  let changed = true;
  let iter = 0;
  while (changed && iter < maxIter) {
    changed = false;
    iter++;
    for (const card of cards) {
      const p = card.task.priority ?? 0;
      if (p === 0) continue; // backlog exempt
      const minStep = computeMinStep(card, cards, existingMap);
      if (p < minStep) {
        card.task.priority = minStep;
        changed = true;
      }
    }
  }
}

// ── Exported: write a user-selected sprint step back to a proposal card, run cascade, persist ──
export async function commitPreviewStep(msg, cardIdx, newPriority) {
  if (!msg || !msg.cards || !msg.cards[cardIdx]) return;
  msg.cards[cardIdx].task.priority = newPriority;
  msg.cards[cardIdx].task._stepPinned = true;
  await ensureExistingSnapshot(msg);
  cascadeBump(msg);
  saveChatState();
}

// ── Rewrite remapped IDs inside each card's dependency array after a server-side collision remap ──
function applyIdRemapToDeps(cards, idRemap) {
  if (!idRemap || Object.keys(idRemap).length === 0) return;
  for (const c of cards) {
    const deps = c.task && c.task.dependencies;
    if (Array.isArray(deps)) {
      c.task.dependencies = deps.map(dep => idRemap[dep] || dep);
    }
  }
}

function applyIdRemapToCards(cards, idRemap) {
  if (!idRemap || Object.keys(idRemap).length === 0) return;
  for (const c of cards) {
    // Only remap the card's own .id for new tasks — a modified card targets an existing
    // persisted task and must not be silently retargeted onto a freshly-created one.
    if (c.type === 'modified') continue;
    const id = c.task && c.task.id;
    const remapped = idRemap[id];
    if (remapped) c.task.id = remapped;
  }
  applyIdRemapToDeps(cards, idRemap);
}

// Fetch task snapshot once per message, but reconcile cards on every call because
// chat updates replace msg.cards. A failed fetch means target existence is unknown;
// never flip `modified` cards based on a possibly scoped or absent snapshot.
export async function ensureExistingSnapshot(msg) {
  // A persisted Map JSON-serializes to {} — rebuild unless it's a real Map.
  if (!(msg._existingTasksSnapshot instanceof Map)) {
    try {
      const res = await fetchWithRetry('./TODO.md?scope=all&_=' + Date.now(), {
        label: 'todo-read-snapshot',
        headers: { ...projectHeader() },
      });
      if (!res.ok) return;
      const parsed = parseSnapshotPayload(await res.text());
      if (!parsed) return;
      msg._existingTasksSnapshot = new Map((parsed.tasks || []).map(t => [t.id, t]));
      if (reconcileModifiedCards(msg, { flip: parsed.scope === 'all' })) saveChatState();
    } catch { /* graceful */ }
    return;
  }
  if (reconcileModifiedCards(msg)) saveChatState();
}

// ── Render card HTML for a single assistant message ──
export function renderCardHtml(msg, msgIdx) {
  if (!msg.cards || msg.cards.length === 0) return '';

  // C1158: hydrate-only reconcile on the render path itself. renderCardHtml is sync
  // while ensureExistingSnapshot's fetch is async — a WS frame (task-cards,
  // cards-update, chat-history-reset) can swap in fresh `modified` cards and trigger
  // a render before that fetch resolves, or before a snapshot exists at all. Reading
  // `msg._existingTasksSnapshot` here (if already loaded) closes that gap instead of
  // leaving title/description blank until the next unrelated reload. Idempotent, no
  // fetch, `flip` stays false (default) — the modified->new absent-target flip is
  // fetch-pass-only (C1109/C1110), never triggered from a render.
  if (reconcileModifiedCards(msg)) saveChatState();

  const mask = msg.acceptedMask || [];
  const confirmed = msg.confirmedMask || [];
  const allCards = msg.cards;
  const existingMap = msg._existingTasksSnapshot || null;
  // (C1559) The card that WILL be adopted onto the origin task on save (mode
  // 'single' only) — same resolution logic the save path uses, so the badge
  // can never say NEW while the save actually writes back to an existing key.
  const originPreviewIdx = previewOriginSingleTarget(state.chatState, msg);
  // (TPT15) Same set buildInitialAcceptedMask() used to seed msg.acceptedMask — recomputed
  // here (not read off the card) purely for the hint's visibility: a card the user has since
  // manually re-Accepted still gets the "outside" badge, since it's still outside the
  // subtree — only its checked state changed, not its target.
  const outOfSubtreeIdxSet = new Set(outOfSubtreeModifiedIndexes(state.chatState, allCards));
  // (TPT257) Subtask (split) chat: every `new` card will be saved as a child of this key
  // (Phase 2.7 in both save paths). Read once per render; null for every other chat.
  const subtaskParentKey = (state.chatState && state.chatState.parentTaskKey) || null;

  const renderCard = (c, cardIdx) => {
    const t = c.task;
    normalizeCardDescription(c);
    const accepted = mask[cardIdx] !== false;
    const isConfirmed = confirmed[cardIdx];
    const isHint = !!c._efficiencyHint;
    const isOriginTarget = cardIdx === originPreviewIdx && !isConfirmed;
    const isOutOfSubtree = outOfSubtreeIdxSet.has(cardIdx) && !isConfirmed;
    // (TPT257) Parent attribution on a proposed subtask — same display-only slot as the
    // C1559 origin badge; mutually exclusive with it (origin mode is 'none' in subtask mode).
    const isSubtaskCard = !!subtaskParentKey && c.type === 'new' && !isOriginTarget;
    const subtaskBadge = isSubtaskCard
      ? `<span class="change-target change-target--subtask" title="${escapeAttr(translate('chat.subtaskOf', { key: subtaskParentKey }))}">\u21b3 ${escapeAttr(subtaskParentKey)}</span>`
      : '';
    const typeClass = (c.type === 'new' && !isOriginTarget) ? 'new-task' : 'modified-task';
    const typeLabel = (c.type === 'new' && !isOriginTarget) ? 'NEW' : 'MODIFIED';
    const deps = t.dependencies && t.dependencies.length
      ? `<span class="preview-deps">Deps: ${t.dependencies.join(', ')}</span>` : '';

    const minStep = computeMinStep(c, allCards, existingMap);
    const currentStep = t.priority ?? 0;
    const activeSteps = computeActiveSteps(allCards, existingMap);
    const maxActive = activeSteps.length ? activeSteps[activeSteps.length - 1] : 0;
    const newStep = maxActive + 1;

    let stepOptionsHtml = `<option value="0"${currentStep === 0 ? ' selected' : ''}>Backlog</option>`;
    for (const s of activeSteps) {
      const isDisabled = s < minStep;
      const hint = isDisabled ? ` title="${escapeAttr(translate('group.dependsOn', { label: groupTitle(minStep - 1) }))}"` : '';
      stepOptionsHtml += `<option value="${s}"${currentStep === s ? ' selected' : ''}${isDisabled ? ' disabled' : ''}${hint}>${groupTitle(s)}</option>`;
    }
    const newDisabled = newStep < minStep;
    const newHint = newDisabled ? ` title="${escapeAttr(translate('group.dependsOn', { label: groupTitle(minStep - 1) }))}"` : '';
    stepOptionsHtml += `<option value="${newStep}"${currentStep === newStep ? ' selected' : ''}${newDisabled ? ' disabled' : ''}${newHint}>${groupTitle(newStep)} (new)</option>`;

    // (TPT279) Both carry card-ctl: the shared 32px control sizing of the board's .controls-row.
    // The confirmed read-only label is `.step-label`, never `.step-selector` (the change handler
    // below matches `.step-selector`). (TPT299) `.preview-step-select` is the themed surface
    // (the composer's .chat-model-selector look, no native chrome).
    const stepSelector = isConfirmed
      ? `<span class="step-label card-ctl">${escapeAttr(groupNoun())}: ${currentStep === 0 ? 'Backlog' : currentStep}</span>`
      : `<select class="step-selector preview-step-select card-ctl" data-msg-idx="${msgIdx}" data-card-idx="${cardIdx}">${stepOptionsHtml}</select>`;

    const efficiencyBanner = isHint ? `<div class="efficiency-hint-banner">Performance suggestion</div>` : '';
    const hintClass = isHint ? ' task-card--efficiency' : '';
    const displayId = getCardDisplayId(c, isConfirmed);
    // (TPT299) Same condition as getCardDisplayId()'s placeholder: the NEW label already says it,
    // so the id badge renders hidden instead of printing "new".
    const hideIdBadge = c.type === 'new' && !isConfirmed;
    const dataTaskId = t.id || displayId;
    // C1072: modified cards no longer carry status — derive it for display only from
    // the live task snapshot; never write it back onto t (that would re-introduce the
    // stale-status-in-chatState bug).
    // C1111: a `modified` card CAN still arrive from the planner carrying a status (only
    // the finalize path strips it, not the task-cards WS frame — see claude-session.js).
    // Unless the user explicitly set it here (_statusEdited), prefer the live snapshot so
    // the card badge agrees with the diff modal's lock/status display, which also seeds
    // from the live task.
    const displayStatus = (c.type === 'modified' && !c._statusEdited
      ? existingMap?.get(t.id)?.status || t.status
      : t.status || existingMap?.get(t.id)?.status) || startName();

    // (TPT269) Rendered through the board's own renderCard() in proposal mode, so the card body
    // (id badge, title, Board markdown description, tags) is identical to the Project Board.
    // Proposal-only controls ride in its head/meta/foot slots; the root and fields keep the
    // .preview-card / .preview-title / .preview-desc hooks every chat reader queries.
    const rootClass = `${typeClass}${hintClass}${accepted ? '' : ' rejected'}${isConfirmed ? ' confirmed' : ''}${isOutOfSubtree ? ' preview-card--outside' : ''}${isSubtaskCard ? ' preview-card--subtask' : ''}`;
    const rootAttrs = `data-msg-idx="${msgIdx}" data-card-idx="${cardIdx}" data-task-id="${escapeAttr(dataTaskId)}" data-accepted="${accepted}"${isSubtaskCard ? ` data-parent-key="${escapeAttr(subtaskParentKey)}"` : ''}`;
    const headHtml = `${efficiencyBanner}<div class="preview-card-head"><span class="change-label">${typeLabel}</span>${subtaskBadge}${isOriginTarget ? `<span class="change-target">→ ${escapeAttr(state.chatState.originTaskKey)}</span>` : ''}${isOutOfSubtree ? `<span class="change-target change-target--outside" title="${escapeAttr(translate('preview.outsideSubtree'))}">⚠ ${escapeAttr(translate('preview.outsideSubtree'))}</span>` : ''}</div>`;
    // (TPT279) .card-preview-meta flex row: status → sprint → deps → agent badge (always last,
    // static — pushed to the row end by CSS, never floated over .preview-card-actions).
    // (TPT303) Status + sprint share one non-wrapping .preview-meta-controls group, so they stay
    // on a single line under the title; only deps and the agent badge may wrap below it.
    const metaHtml = `<span class="preview-meta-controls"><span class="status card-ctl" style="--status-color:${statusColor(displayStatus)}" data-status-role="${statusRoleToken(displayStatus)}">${statusLabel(displayStatus)}</span>${stepSelector}</span>${deps}${renderAgentBadge(t)}`;
    const footHtml = isConfirmed ? '' : `<div class="preview-card-actions">
          <button class="btn-accept-card${accepted ? ' active' : ''}" data-msg-idx="${msgIdx}" data-card-idx="${cardIdx}" title="Accept">
            <svg viewBox="0 0 16 16" fill="none"><polyline points="3 8 6.5 11.5 13 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="btn-reject-card${accepted ? '' : ' active'}" data-msg-idx="${msgIdx}" data-card-idx="${cardIdx}" title="Reject">
            <svg viewBox="0 0 16 16" fill="none"><line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>`;
    const cardTask = {
      ...t,
      id: displayId,
      status: displayStatus,
      title: t.title || '',
      description: t.description || '',
      dependencies: t.dependencies || [],
      tags: t.tags || [],
    };
    return renderBoardCard(cardTask, {
      proposal: { rootClass, rootAttrs, headHtml, metaHtml, footHtml, hideIdBadge, descTransform: escapeMarkdownTilde },
    });
  };

  const hasEfficiencyCards = msg.cards.some(c => c._efficiencyHint);
  let cardsHtml;
  if (hasEfficiencyCards) {
    const regular = msg.cards.map((c, i) => c._efficiencyHint ? '' : renderCard(c, i)).join('');
    const hintSep = `<div class="efficiency-section-header">AI performance suggestions</div>`;
    const hints = msg.cards.map((c, i) => c._efficiencyHint ? renderCard(c, i) : '').join('');
    cardsHtml = `${regular}${hintSep}${hints}`;
  } else {
    cardsHtml = msg.cards.map((c, i) => renderCard(c, i)).join('');
  }

  const cardsIntro = subtaskParentKey
    ? escapeAttr(translate('chat.subtaskCardsIntro', { key: subtaskParentKey }))
    : 'Proposed tasks:';
  let html = `<div class="chat-cards-intro">${cardsIntro}</div><div class="chat-cards-grid">${cardsHtml}</div>`;
  if (msg.filesAddressed && msg.filesAddressed.length > 0) {
    const items = msg.filesAddressed.map(f => `<li class="files-addressed-item">${escapeAttr(f)}</li>`).join('');
    html += `<div class="chat-files-addressed collapsed">
      <div class="files-addressed-header">
        <span class="files-addressed-label">Files Addressed (${msg.filesAddressed.length})</span>
        <span class="files-addressed-chevron"></span>
      </div>
      <ul class="files-addressed-list">${items}</ul>
    </div>`;
  }
  if (msg.docUpdates && msg.docUpdates.length > 0) {
    const items = msg.docUpdates.map(u => {
      const kind = u.kind === 'source' ? 'source' : 'kb';
      return `<li class="doc-updates-item doc-updates-${kind}"><span class="doc-updates-kind">${kind}</span> <code>${escapeAttr(u.file || '')}</code> — ${escapeAttr(u.summary || '')}</li>`;
    }).join('');
    html += `<div class="chat-doc-updates collapsed">
      <div class="doc-updates-header">
        <span class="doc-updates-label">Agent edits during analysis (${msg.docUpdates.length})</span>
        <span class="doc-updates-chevron"></span>
      </div>
      <ul class="doc-updates-list">${items}</ul>
    </div>`;
  }
  html += renderSaveBarHtml(msg, msgIdx);
  return html;
}

// ── (TPT179) Rehash → Discuss: the discussed task, pinned above the message list ──
// Mounted by chat-ui.js's renderObjectiveContent() outside .chat-messages (so it never scrolls
// with the transcript, and stays visible in the empty layout where .chat-messages is hidden).
// `entry` is chat-ui.js's discuss-task cache value: undefined while the fetch is pending,
// { error: true } on failure, { task } once loaded. The card is the board's own renderCard() in
// its inert `preview` form — informational only, and deliberately without data-id/data-db-id
// (see renderCard()'s note). The clickable region is .chat-discuss-card. There is no detach
// control: the preview stays pinned for the tab's lifetime and ends when the session tab closes.
export function renderDiscussPreviewHtml(taskKey, entry) {
  const key = String(taskKey || '');
  const head = `<div class="chat-discuss-head"><span class="chat-discuss-caption">${escapeAttr(translate('chat.discussCaption'))}</span></div>`;
  let body;
  if (entry && entry.task) {
    const task = {
      ...entry.task,
      id: entry.task.id || key,
      title: entry.task.title || key,
      description: entry.task.description || '',
      tags: entry.task.tags || [],
      dependencies: entry.task.dependencies || [],
    };
    const label = escapeAttr(translate('chat.discussOpenTask', { key }));
    body = `<div class="chat-discuss-card" role="button" tabindex="0" data-discuss-task="${escapeAttr(key)}" title="${label}" aria-label="${label}">${renderBoardCard(task, { preview: true })}</div>`;
  } else if (entry && entry.error) {
    body = `<div class="chat-discuss-note">${escapeAttr(translate('chat.discussUnavailable', { key }))}</div>`;
  } else {
    body = `<div class="chat-discuss-note chat-discuss-note--loading">${escapeAttr(key)}…</div>`;
  }
  return `<div class="chat-discuss-preview" data-discuss-key="${escapeAttr(key)}">${head}${body}</div>`;
}

// ── Render save bar HTML for a single message ──
export function renderSaveBarHtml(msg, msgIdx) {
  if (!msg.cards || msg.cards.length === 0) return '';

  const msgCount = getUnsavedAcceptedCountForMsg(msg);

  if (msg.discarded) {
    return `<div class="chat-save-bar resolved" data-msg-idx="${msgIdx}">
      <span class="save-bar-status">Discarded</span>
    </div>`;
  }

  if (msgCount > 0) {
    return `<div class="chat-save-bar" data-msg-idx="${msgIdx}">
      <span class="save-bar-count">${msgCount} task${msgCount !== 1 ? 's' : ''} ready to save</span>
      <button class="btn-discard chat-discard-btn" data-msg-idx="${msgIdx}">Discard</button>
      <button class="btn-done chat-save-btn" data-msg-idx="${msgIdx}">Save Tasks</button>
    </div>`;
  }

  const anyConfirmed = (msg.confirmedMask || []).some(v => v);
  if (anyConfirmed) {
    return `<div class="chat-save-bar resolved" data-msg-idx="${msgIdx}">
      <span class="save-bar-status">\u2713 Saved</span>
    </div>`;
  }

  return '';
}

// ── Attach card event handlers (called each render cycle) ──
export function attachCardHandlers() {
  const chatMessages = document.getElementById('chat-messages');
  if (!chatMessages) return;

  // Step selector: change handler
  chatMessages.addEventListener('change', async (e) => {
    const sel = e.target.closest('.step-selector');
    if (!sel || !state.chatState) return;
    const msgIdx = parseInt(sel.dataset.msgIdx);
    const cardIdx = parseInt(sel.dataset.cardIdx);
    const msg = state.chatState.messages[msgIdx];
    if (!msg || !msg.cards || !msg.cards[cardIdx]) return;
    const newStep = Number(sel.value);
    msg.cards[cardIdx].task.priority = newStep;
    msg.cards[cardIdx].task._stepPinned = true;
    // Ensure snapshot loaded before cascade so minStep reflects real deps
    await ensureExistingSnapshot(msg);
    cascadeBump(msg);
    saveChatState();
    reload();
  });

  chatMessages.addEventListener('click', async (e) => {
    if (!state.chatState) return;

    // ── Toggle Files Addressed collapse ──
    const filesHeader = e.target.closest('.files-addressed-header');
    if (filesHeader) {
      filesHeader.closest('.chat-files-addressed')?.classList.toggle('collapsed');
      return;
    }

    // ── Toggle Doc Updates collapse ──
    const docUpdatesHeader = e.target.closest('.doc-updates-header');
    if (docUpdatesHeader) {
      docUpdatesHeader.closest('.chat-doc-updates')?.classList.toggle('collapsed');
      return;
    }

    // ── Accept / Reject individual cards ──
    const acceptBtn = e.target.closest('.btn-accept-card');
    const rejectBtn = e.target.closest('.btn-reject-card');
    if (acceptBtn || rejectBtn) {
      const btn = acceptBtn || rejectBtn;
      const msgIdx = parseInt(btn.dataset.msgIdx);
      const cardIdx = parseInt(btn.dataset.cardIdx);
      // The chat this click belongs to. Accept awaits its save, and the user may switch tabs
      // meanwhile — everything after the await must act on THIS chat (sweep, auto-close + server
      // kill), never on whichever chat happens to be visible by then.
      const cs = state.chatState;
      if (!cs) return;
      const msg = cs.messages[msgIdx];
      if (!msg || !msg.cards || !msg.cards[cardIdx]) return;
      const confirmed = msg.confirmedMask || [];
      if (confirmed[cardIdx]) return;

      const card = btn.closest('.preview-card');

      if (acceptBtn) {
        msg.acceptedMask[cardIdx] = true;
        card.classList.remove('rejected');
        card.dataset.accepted = 'true';
        acceptBtn.classList.add('active');
        card.querySelector('.btn-reject-card').classList.remove('active');

        // Read user edits from contenteditable fields
        const titleEl = card.querySelector('.preview-title');
        const descEl = card.querySelector('.preview-desc');
        // C1158: same non-empty guard as captureCardEdits() above — a blank read here
        // is always a stale/unhydrated paint, never real user intent, and writing it
        // would poison the title with a defined '' that hydration can't recover from.
        if (titleEl) {
          const nextTitle = titleEl.innerText.trim();
          if (nextTitle) msg.cards[cardIdx].task.title = nextTitle;
        }
        if (descEl) msg.cards[cardIdx].task.description = (descEl.dataset.raw || descEl.innerText).trim();

        // Disable buttons during save
        const buttons = card.querySelectorAll('button');
        buttons.forEach(b => b.disabled = true);

        try {
          if (!msg.cards[cardIdx].task.assignee) msg.cards[cardIdx].task.assignee = (state.currentUser && state.currentUser.id) || null;
          await saveTaskChange(msg.cards[cardIdx], { msg });
          msg.confirmedMask[cardIdx] = true;
          updatePreviewCardDomId(card, msg.cards[cardIdx].task);

          const priority = msg.cards[cardIdx].task.priority;
          if (priority !== undefined) {
            state.collapsedTiers.delete(priority);
            state.expandedTiers.add(priority);
          }

          // Collapse if this card is currently expanded
          if (card.classList.contains('card-expanded')) collapseCard();
          card.classList.add('confirmed');
          card.addEventListener('transitionend', () => card.remove());
          showSaveToast(1);
          // (TPT19) Once every card in THIS message is handled (via individual ticks, not
          // Save Tasks), sweep stale accepted-but-unconfirmed cards left over from earlier,
          // superseded suggestion iterations — same end state Save Tasks always produced, so
          // finishing an edition by ticking every card also leaves zero live cards. Unlike the
          // bulk-save sweep, this path does NOT immediately destroy the tab, so the
          // efficiency-hint exemption still means something here: a message left with only a
          // live hint card keeps its save bar (checkAllCardsHandled() below correctly finds
          // allHandled===false and leaves the tab open for it).
          const sweepChanged = isMessageFullyResolved(msg)
            && discardUnsavedProposals(cs.messages, { exceptIdx: msgIdx, keepEfficiencyHints: true });
          // Save bar + persisted snapshot describe the visible chat only.
          if (cs === state.chatState) {
            if (sweepChanged) updateSaveBar(); else updateSaveBar(msgIdx);
            saveChatState();
            // A successful single-card save may memoize the objective parent or
            // consume a web origin even when no unsaved cards remain for chat-state.
            saveChatDraft();
          }
          checkAllCardsHandled(cs);
        } catch (err) {
          buttons.forEach(b => b.disabled = false);
          showToast(translate('chat.errSaveTask', { msg: err.message }), 'error');
        }
      } else {
        // Reject
        msg.acceptedMask[cardIdx] = false;
        // Collapse if this card is currently expanded
        if (card.classList.contains('card-expanded')) collapseCard();
        card.classList.add('rejected');
        card.dataset.accepted = 'false';
        rejectBtn.classList.add('active');
        card.querySelector('.btn-accept-card').classList.remove('active');
        updateSaveBar(msgIdx);
        saveChatState();
        checkAllCardsHandled(cs);
      }
      return;
    }

    // ── Per-message Save Tasks button ──
    const saveBtn = e.target.closest('.chat-save-btn');
    if (saveBtn) {
      const msgIdx = parseInt(saveBtn.dataset.msgIdx);
      // Capture tab at click time — prevents mid-save tab-switch from redirecting
      // acceptedChanges, auto-discard loop, and teardown to the wrong session.
      const cs = state.chatState;
      const startedOnObjective = state.activeTab === 'objective';
      if (!cs) return;
      const msg = cs.messages[msgIdx];
      if (!msg || !msg.cards) return;

      // Idempotency guard — prevent double-save if button clicked twice before the
      // async flow even starts (DOM disabled flag is set too late to catch that).
      if (msg._inFlight) return;

      captureCardEdits();

      // Collect accepted, non-confirmed cards from THIS message only
      const mask = msg.acceptedMask || [];
      const confirmed = msg.confirmedMask || [];
      const acceptedChanges = [];
      for (let i = 0; i < msg.cards.length; i++) {
        if (mask[i] && !confirmed[i]) acceptedChanges.push({ card: msg.cards[i], cardIdx: i });
      }
      if (acceptedChanges.length === 0) return;

      msg._inFlight = true;
      saveBtn.disabled = true;
      showSavingIndicator();

      try {
        try {
          // (C1110) Intentionally scoped (no `?scope=all`) — data.tasks below becomes the
          // PUT /api/todo body via overwriteRaw(), so widening this to unscoped would push
          // every teammate's task through the write path. A `modified` card whose target
          // isn't in this scoped read is covered by the absent-target PATCH fallback further
          // down (`card.type === 'modified'` branch, C922/Bug 3), not by making this read
          // unscoped.
          const res = await fetchWithRetry('./TODO.md?_=' + Date.now(), {
            label: 'todo-read-save',
            headers: { 'Cache-Control': 'no-cache', ...projectHeader() },
          });
          if (!res.ok) throw new Error(`Failed to load tasks: ${await readErrorBody(res)}`);
          const { data, text } = parseTodoJson(await res.text());
          const taskMap = new Map(data.tasks.map(t => [t.id, t]));

          // Collision set for ensureNewTaskClientId below. Excludes live reservation
          // placeholders (C1017) — a proposal card's id matching one of those IS the
          // reserved key being finalized, not a collision; keeping it in usedIds used
          // to force every accepted task through a second, wasted reservation.
          const usedIds = buildUsedIds(data.tasks);

          for (const { card } of acceptedChanges) {
            assertPendingProposalStatus(card, 'chat-save-bulk');
          }

          // Phase 0: fill in any field a `modified` proposal omitted, from the freshly-read
          // live task (C1071) — safety net for when ensureExistingSnapshot never ran/loaded
          // (offline/race). A modified card must never acquire fields nobody asked to change.
          for (const { card } of acceptedChanges) {
            if (card.type === 'modified') hydrateModifiedCard(card, taskMap.get(card.task.id));
          }

          // Phase 0.5 (C1559): web-origin resolution. proposedNewCount MUST be computed
          // here, before adoptOriginKey below can run — adoptOriginKey flips a 'new' card
          // to 'modified', which is exactly what this count filters on; computing it later
          // (e.g. inside Phase 3.5) would silently undercount after a 'single' adoption.
          // Reused unchanged by Phase 3.5 further down (C1415: proposed, not accepted, count).
          const proposedNewCount = (msg.cards || []).filter(c => c.type === 'new').length;
          const originPlan = resolveOriginPlan(cs, proposedNewCount);
          if (originPlan.mode !== 'none') {
            // The planner will sometimes ALSO propose a `modified` card targeting the
            // origin (its own system-prompt rule: "if active task overlaps objective,
            // propose modified") — drop it before it can race the adopted card for the
            // same row (mode 'single') or overwrite content the 'parent' branch below
            // deliberately preserves.
            const conflictIdxSet = new Set(originConflictCardIndexes(msg.cards, originPlan.originTaskKey));
            if (conflictIdxSet.size) {
              for (const i of conflictIdxSet) msg.acceptedMask[i] = false;
              for (let i = acceptedChanges.length - 1; i >= 0; i--) {
                if (conflictIdxSet.has(acceptedChanges[i].cardIdx)) acceptedChanges.splice(i, 1);
              }
            }
          }
          if (originPlan.mode === 'single') {
            const target = acceptedChanges.find(({ card }) => card.type === 'new');
            if (target) {
              adoptOriginKey(target.card, originPlan.originTaskKey);
              hydrateModifiedCard(target.card, taskMap.get(originPlan.originTaskKey));
            }
          }

          // Phase 1: ensure every new card has a unique client-side key.
          for (const { card } of acceptedChanges) {
            if (card.type === 'new') {
              if (!card.task.assignee) card.task.assignee = (state.currentUser && state.currentUser.id) || null;
              ensureNewTaskClientId(card, usedIds);
            }
          }

          // Phase 2.7: stamp parentId on new cards when in subtask mode
          if (cs.parentTaskKey) {
            for (const { card } of acceptedChanges) {
              if (card.type === 'new') {
                card.task.parentId = cs.parentTaskKey;
              }
            }
          }

          for (const { card } of acceptedChanges) {
            normalizePerformanceSuggestionCard(card);
            normalizeCardDescription(card);
          }

          // Phase 2.4: preload existing snapshot + cascade client-side to absorb
          // same-step-dep cases before the server round-trip.
          await ensureExistingSnapshot(msg);
          cascadeBump(msg);

          // Phase 2.5: resolve sprint assignments via server (respecting user-pinned steps)
          const pinned = acceptedChanges
            .filter(({ card }) => card.task._stepPinned)
            .map(({ card }) => card.task.id);
          let autoBumpedFromServer = [];
          try {
            const resolveRes = await fetchWithRetry('/api/resolve-sprints', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...projectHeader() },
              body: JSON.stringify({ changes: acceptedChanges.map(({ card }) => card), pinned }),
              label: 'resolve-sprints',
              retryOn: [408, 429, 500, 502, 503, 504],
            });
            if (resolveRes.status === 422) {
              const body = await resolveRes.json();
              // (C1458) A toast can't render this (multi-line, one item per conflict) — use
              // an okOnly ack dialog instead. Each line escaped individually, then joined
              // with <br> (showActionConfirm injects message as innerHTML).
              const conflictLines = (body.conflicts || []).map(c => escapeAttr(translate('chat.pinnedStepConflictLine', {
                taskId: c.taskId, taskStep: c.taskStep, depId: c.depId, depStep: c.depStep, next: c.depStep + 1,
              })));
              saveBtn.disabled = false;
              await showActionConfirm({
                okOnly: true,
                message: `<strong>${escapeAttr(translate('chat.pinnedStepConflictTitle'))}</strong><br>${conflictLines.join('<br>')}`,
                overlayClass: 'modal-overlay--over-chat',
              });
              return;
            }
            if (resolveRes.ok) {
              const body = await resolveRes.json();
              autoBumpedFromServer = Array.isArray(body.autoBumped) ? body.autoBumped : [];
              if (body.idRemap && Object.keys(body.idRemap).length > 0) {
                applyIdRemapToCards(acceptedChanges.map(({ card }) => card), body.idRemap);
                for (let i = 0; i < pinned.length; i++) pinned[i] = body.idRemap[pinned[i]] || pinned[i];
              }
              const resolvedMap = new Map(
                (body.changes || []).filter(c => c.type === 'new').map(c => [c.task.id, c.task.priority])
              );
              for (const { card } of acceptedChanges) {
                if (card.type === 'new' && !card.task._stepPinned && resolvedMap.has(card.task.id)) {
                  card.task.priority = resolvedMap.get(card.task.id);
                }
              }
              cascadeBump(msg);
            }
          } catch { /* graceful degradation — keep current priorities */ }
          if (autoBumpedFromServer.length > 0) {
            console.log('[chat-save] Auto-adjusted steps:', autoBumpedFromServer);
          }

          // Phase 3: insert/update tasks (strip internal flags before write)
          for (const { card } of acceptedChanges) {
            delete card.task._stepPinned;
            delete card.task._efficiencyHint;
            if (card.type === 'new') {
              const samePriority = data.tasks.filter(t => t.priority === card.task.priority);
              const maxOrder = samePriority.length > 0 ? Math.max(...samePriority.map(t => t.order ?? 0)) : 0;
              card.task.order = maxOrder + 1;
              // upsertTaskEntry, not push: card.task.id may already be a live reservation
              // row read into `data.tasks` above — see utils.js's comment on this helper.
              upsertTaskEntry(data.tasks, card.task);
              taskMap.set(card.task.id, card.task);
            } else if (card.type === 'modified') {
              const existing = taskMap.get(card.task.id);
              if (existing) {
                // C1165: merges card.task onto existing, reopening existing to
                // in_progress if it was completed/canceled (unless card._statusEdited).
                applyModifiedCardToLiveTask(existing, card);
              } else {
                // Target is persisted server-side but absent from the scoped TODO.md.
                // Update it in place via PATCH rather than duplicating it as a new task (C922 / Bug 3).
                await api.tasks.update(card.task.id, buildModifiedTaskPatch(card.task));
              }
            }
          }

          // Phase 3.5 (C1339): objective parent task. Rides along as one extra entry in
          // data.tasks/newTaskIds — there's no client-reachable single-task create route
          // (api.tasks only has get/update/delete/listAll), so the server's own
          // overwriteRawWithRemap() reserves it a real key, rewrites the children's
          // parentId refs to it (applyIdRemapToTaskPayload), and finalizes it, all inside
          // this one atomic PUT. See tt-objective-chat.md "Objective Parent Task (C1339)".
          const newCardTasks = acceptedChanges
            .filter(({ card }) => card.type === 'new')
            .map(({ card }) => card.task);
          // C1415: the parent is decided by how many new tasks the objective PROPOSED, not
          // how many are being saved right now — a per-card Accept flow must still land one
          // shared parent (the cs.objectiveParentKey memo reuses it for later saves in this
          // chat), so this must be the message's total, not the accepted subset above.
          // (proposedNewCount itself is computed once in Phase 0.5 above, before any
          // origin adoption can flip a card's type and skew the count.)
          // (C1559) originPlan.mode 'parent' means the origin task is ALREADY the
          // is_objective parent (web-created tasks are always stamped is_objective,
          // C1341) — it just needs children. No new parent is ever built for it.
          const originParentKey = (originPlan.mode === 'parent') ? originPlan.originTaskKey : null;
          let objectiveParent = null;
          if (!cs.parentTaskKey && newCardTasks.length > 0) {
            const memoKey = cs.objectiveParentKey || originParentKey;
            if (memoKey) {
              // Reuse this chat's already-created/reused parent for a later save in the
              // same chat, or (C1559) the origin task itself.
              for (const t of newCardTasks) t.parentId = memoKey;
            } else if (shouldCreateObjectiveParent(cs, proposedNewCount, { groupingEnabled: getObjectiveGroupingEnabled() })) {
              objectiveParent = buildObjectiveParentTask(cs, {
                id: newObjectiveParentClientId(Date.now(), usedIds),
                status: startName(),
                assignee: (state.currentUser && state.currentUser.id) || null,
                summary: msg.objectiveSummary || null,
              });
              // insertObjectiveParent needs children's FINAL priorities (post
              // resolve-sprints) to place the parent at its LAST child's sprint (C1425),
              // and must run after the Phase 3 merge loop above so its order lands on top.
              if (objectiveParent) insertObjectiveParent(data, objectiveParent, newCardTasks);
            }
          }

          // Embed new_tags from the LLM proposal so overwriteRaw can register them before
          // PUT /tasks — only entries whose tag name appears on at least one accepted card.
          attachNewTagsPayload(data, msg.newTags, acceptedChanges.map(({ card }) => card));
          attachOriginalSpecPayload(
            data,
            [
              ...acceptedChanges.filter(({ card }) => card.type === 'new').map(({ card }) => card.task.id),
              ...(objectiveParent ? [objectiveParent.id] : []),
            ],
            cs
          );
          attachSplitOriginPayload(data, resolveOriginPlan(cs, proposedNewCount, newCardTasks.map(t => t.id)));
          data.newTaskPinnedIds = pinned;

          const jsonStr = JSON.stringify(data, null, 2);
          const newTodoText = text.replace(/```json\s*[\s\S]*```/, () => '```json\n' + jsonStr + '\n```');
          const putRes = await fetchWithRetry('/api/todo', { method: 'PUT', headers: { 'Content-Type': 'text/plain', ...projectHeader() }, body: newTodoText, label: 'todo-write' });
          if (!putRes.ok) throw new Error(await readErrorBody(putRes));
          // Apply server-side ID remap to accepted cards so confirmedMask / later references stay consistent
          try {
            const putBody = await putRes.json();
            if (putBody.idRemap && Object.keys(putBody.idRemap).length > 0) {
              console.warn('[save] PUT bulk: server remapped IDs due to concurrent tab collision:', putBody.idRemap);
              applyIdRemapToCards(acceptedChanges.map(({ card }) => card), putBody.idRemap);
            }
            // (C1339) applyIdRemapToCards only walks cards — the objective parent isn't
            // one, so its real reserved key needs a separate hop out of idRemap.
            if (objectiveParent) {
              const finalKey = putBody.idRemap && putBody.idRemap[objectiveParent.id];
              if (finalKey) cs.objectiveParentKey = finalKey;
              else console.warn('[save] objective parent not remapped — expected a reserved key for', objectiveParent.id);
            }
            // (C1559) Commit AFTER a successful PUT, mirroring the objectiveParent hop
            // above — a failed save must not memoize a resolution that never landed, so
            // a later revise-and-retry in the same chat still resolves fresh.
            if (originParentKey) { cs.objectiveParentKey = originParentKey; cs.originResolution = 'parent'; }
            if (originPlan.mode === 'single') cs.originResolution = 'single';
          } catch { /* non-critical */ }
        } catch (err) {
          msg._inFlight = false;
          saveBtn.disabled = false;
          showToast(translate('chat.errSaveTasks', { msg: err.message }), 'error');
          return;
        }

        // Mark cards as confirmed
        for (const { cardIdx } of acceptedChanges) {
          msg.confirmedMask[cardIdx] = true;
        }
        releaseDiscussLock(cs); // (TPT271) PUT succeeded — the discussion is resolved

        // Expand affected tiers
        for (const { card } of acceptedChanges) {
          if (card.task.priority !== undefined) {
            state.collapsedTiers.delete(card.task.priority);
            state.expandedTiers.add(card.task.priority);
          }
        }

        showSaveToast(acceptedChanges.length);

        // (TPT19) Discard every OTHER assistant message's still-live proposal cards from
        // earlier, now-superseded suggestion iterations BEFORE saveChatState() below —
        // cleanupChat's force:true (below) destroys this whole tab regardless of which message an
        // efficiency-hint card lives on, so the old exemption that kept a hint message's save
        // bar alive is unreachable here (it's already gone in the same close either way);
        // keeping it would also leave saveChatState()'s hasUnsaved check permanently true for
        // any chat that produced hints, defeating the purge below for exactly those objectives.
        discardUnsavedProposals(cs.messages, { exceptIdx: msgIdx });

        // Must run AFTER the discard sweep above — saveChatState()'s snapshot is captured
        // synchronously, so a stale ordering here is what let an orphaned debounced PUT
        // resurrect earlier iterations' unsaved cards after this tab's files were deleted.
        saveChatState();

        // Kill server session and close this tab (cleanupChat handles tab teardown + purge;
        // force:true so persistence is purged unconditionally even if a mid-save tab-switch
        // means `cs` is no longer the visibly-active chatState — force also clears
        // LAST_PROMPT_KEY, so the explicit clearDraft() call that used to live here is gone).
        state.sessionAgent = null;
        cleanupChat(cs, { force: true });
        if (startedOnObjective && state.activeTab === 'objective') {
          state.activeTab = 'objective';
        } else {
          showToast('Objective saved');
        }
        reload();
        return;
      } finally {
        hideSavingIndicator();
      }
    }

    // ── Per-message Discard button ──
    const discardBtn = e.target.closest('.chat-discard-btn');
    if (discardBtn) {
      const msgIdx = parseInt(discardBtn.dataset.msgIdx);
      const msg = state.chatState.messages[msgIdx];
      if (!msg) return;

      // Mark all unconfirmed cards as rejected
      if (msg.cards) {
        for (let i = 0; i < msg.cards.length; i++) {
          if (!msg.confirmedMask[i]) {
            msg.acceptedMask[i] = false;
          }
        }
      }
      msg.discarded = true;

      updateSaveBar(msgIdx);
      saveChatState();
      checkAllCardsHandled();
      reload();
      return;
    }
  });
}

// ── Read error body from response ──
async function readErrorBody(res) {
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text);
      return body.error || text;
    } catch {
      return text || `HTTP ${res.status}`;
    }
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ── Parse tasks JSON from TODO.md text ──
function parseTodoJson(text) {
  if (!text || !text.trim()) throw new Error('TODO.md response was empty');
  const match = text.match(/```json\s*([\s\S]*)```/);
  if (!match) throw new Error(`No JSON block found in TODO.md (${text.length} chars)`);
  const jsonContent = match[1].trim();
  if (!jsonContent) throw new Error('JSON block in TODO.md was empty');
  try {
    const data = JSON.parse(jsonContent);
    if (!data.tasks) data.tasks = [];
    return { data, text };
  } catch (e) {
    console.error('[save] JSON parse failed. Content length:', jsonContent.length, 'First 200 chars:', jsonContent.slice(0, 200));
    throw new Error(`Invalid JSON in TODO.md: ${e.message} (content length: ${jsonContent.length})`);
  }
}

// ── Save a single task change to TODO.md ──
export async function saveTaskChange(change, { msg } = {}) {
  const cs = state.chatState; // capture at call time; mid-save tab-switch must not redirect spec read
  // (C1110) Intentionally scoped (no `?scope=all`) — same reasoning as the bulk-save read
  // above: `data` here feeds the PUT /api/todo body. The absent-target PATCH fallback below
  // (`change.type === 'modified'` branch, C922/Bug 3) is what covers a target missing from
  // this scoped read; don't "fix" the scoping instead.
  const res = await fetchWithRetry('./TODO.md?_=' + Date.now(), {
    label: 'todo-read-single-save',
    headers: { 'Cache-Control': 'no-cache', ...projectHeader() },
  });
  if (!res.ok) throw new Error(`Failed to load tasks: ${await readErrorBody(res)}`);
  const { data, text } = parseTodoJson(await res.text());
  const taskMap = new Map(data.tasks.map(t => [t.id, t]));

  // (C1559) Web-origin resolution — mirrors chat-task-preview.js bulk-save Phase 0.5.
  // proposedNewCount must be read from msg.cards BEFORE adoptOriginKey below can flip
  // change.type — same ordering constraint as the bulk path. change._manual (manual
  // New Task form, template.html) has no msg/cs tie — same C1245 guard used further
  // down for the tags/spec payloads.
  const proposedNewCount = (msg?.cards || []).filter(c => c.type === 'new').length;
  const originPlan = !change._manual ? resolveOriginPlan(cs, proposedNewCount) : { mode: 'none', originTaskKey: null };
  if (originPlan.mode !== 'none' && change.type === 'modified' && change.task
    && String(change.task.id) === String(originPlan.originTaskKey)) {
    // Stray planner-proposed 'modified' card targeting the very task this chat is
    // planning FOR — same drop the bulk path applies via originConflictCardIndexes.
    // Nothing to save: the origin's own resolution (single/parent) governs this
    // task's fate, not a leftover proposal against its pre-planning content.
    return;
  }
  if (originPlan.mode === 'single' && change.type === 'new') {
    adoptOriginKey(change, originPlan.originTaskKey);
    hydrateModifiedCard(change, taskMap.get(originPlan.originTaskKey));
  }

  // Fill in any field a `modified` proposal omitted, from the freshly-read live task
  // (C1071) — a modified card must never acquire fields (e.g. assignee) nobody changed.
  if (change.type === 'modified') hydrateModifiedCard(change, taskMap.get(change.task.id));

  if (change.type === 'new' && !change.task.assignee) {
    change.task.assignee = (state.currentUser && state.currentUser.id) || null;
  }

  assertPendingProposalStatus(change, 'chat-save-single');
  normalizePerformanceSuggestionCard(change);
  normalizeCardDescription(change);
  const isStepPinned = !!change.task._stepPinned;
  let objectiveParent = null; // C1339 — set below only for a type:'new', non-manual, non-subtask save
  // (C1559) originPlan.mode 'parent' means the origin task is ALREADY the is_objective
  // parent (C1341) — it just needs children, no new parent is ever built for it.
  const originParentKey = (originPlan.mode === 'parent') ? originPlan.originTaskKey : null;

  // Strip internal flags before write
  delete change.task._stepPinned;
  delete change.task._efficiencyHint;

  if (change.type === 'new') {
    // Phase 2.7 (TPT257) — mirrors the bulk `.chat-save-btn` handler: a subtask (split)
    // chat stamps the parent key so a per-card Accept lands a real child, not an orphan
    // top-level task. change._manual (manual New Task form, template.html) carries its own
    // parentId from the form (C303) — never overwrite it. Mutually exclusive with the
    // C1339 objective-parent block further down, which is guarded by `!cs.parentTaskKey`.
    if (!change._manual && cs && cs.parentTaskKey) change.task.parentId = cs.parentTaskKey;
    // See buildUsedIds() (C1017) — excludes live reservation placeholders so the
    // planner's reserved key survives a single-card Accept too.
    ensureNewTaskClientId(change, buildUsedIds(data.tasks));
    // Mirror bulk-save Phase 2.5: resolve sprint assignment so single-accept
    // lands in the current sprint instead of AI's proposed priority.
    // A temporary/proposal ID must be set above before calling resolve-sprints.
    try {
      const resolveRes = await fetchWithRetry('/api/resolve-sprints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...projectHeader() },
        body: JSON.stringify({ changes: [change], pinned: isStepPinned ? [change.task.id] : [] }),
        label: 'resolve-sprints-single',
        retryOn: [408, 429, 500, 502, 503, 504],
      });
      if (resolveRes.ok) {
        const resolveBody = await resolveRes.json();
        // Apply any server-side ID remap (collision with a concurrent tab's task)
        if (resolveBody.idRemap && Object.keys(resolveBody.idRemap).length > 0) {
          const before = change.task.id;
          applyIdRemapToCards([change], resolveBody.idRemap);
          if (before !== change.task.id) console.warn(`[save] ID collision resolved: ${before} -> ${change.task.id}`);
        }
        const resolved = (resolveBody.changes || []).find(c => c.type === 'new' && c.task.id === change.task.id);
        if (resolved && typeof resolved.task.priority === 'number') {
          change.task.priority = resolved.task.priority;
        }
      }
    } catch { /* graceful degradation — keep AI's priority */ }
    const samePriority = data.tasks.filter(t => t.priority === change.task.priority);
    const maxOrder = samePriority.length > 0 ? Math.max(...samePriority.map(t => t.order ?? 0)) : 0;
    change.task.order = maxOrder + 1;
    // upsertTaskEntry, not push: change.task.id may already be a live reservation row
    // read into `data.tasks` above — see utils.js's comment on this helper.
    upsertTaskEntry(data.tasks, change.task);
    taskMap.set(change.task.id, change.task);

    // Phase objective-parent (C1339/C1559) — mirrors chat-task-preview.js bulk-save
    // Phase 3.5. change._manual (manual New Task form, template.html) must never
    // acquire an unrelated chat's parent — same C1245 reasoning as the spec-comment
    // guard below.
    if (!change._manual && cs && !cs.parentTaskKey) {
      const memoKey = cs.objectiveParentKey || originParentKey;
      if (memoKey) {
        change.task.parentId = memoKey;
      } else if (shouldCreateObjectiveParent(cs, proposedNewCount, { groupingEnabled: getObjectiveGroupingEnabled() })) {
        objectiveParent = buildObjectiveParentTask(cs, {
          id: newObjectiveParentClientId(),
          status: startName(),
          assignee: change.task.assignee ?? null,
          summary: (msg && msg.objectiveSummary) || null,
        });
        // change.task.order is already final (computed just above) — insertObjectiveParent
        // places the parent above it in the same tier.
        if (objectiveParent) insertObjectiveParent(data, objectiveParent, [change.task]);
      }
    }
  } else if (change.type === 'modified') {
    const existing = taskMap.get(change.task.id);
    if (existing) {
      // C1165: merges change.task onto existing, reopening existing to
      // in_progress if it was completed/canceled (unless change._statusEdited).
      applyModifiedCardToLiveTask(existing, change);
    } else {
      // Target is persisted server-side but absent from the scoped TODO.md.
      // Update it in place via PATCH rather than duplicating it as a new task (C922 / Bug 3).
      // KNOWN GAP (pre-existing C922/Bug 3 shape, C1559 makes it reachable more often):
      // this branch skips the TODO.md PUT entirely, so attachNewTagsPayload's
      // data.new_tags mechanism (consumed by overwriteRaw()) never runs — a tag the
      // refined card coined here is never registered, and this PATCH can 400 on an
      // unregistered tag. No clean fix without a separate tag-registration round trip;
      // documented, not closed by this task.
      await api.tasks.update(change.task.id, buildModifiedTaskPatch(change.task));
      // (C1559) Commit the 'single' resolution even on this early-return fallback —
      // otherwise a later save in the same chat would try to re-adopt an already-
      // adopted card (harmless — the PATCH above is idempotent — but wasted).
      if (originPlan.mode === 'single' && String(change.task.id) === String(originPlan.originTaskKey)) {
        cs.originResolution = 'single';
      }
      releaseDiscussLock(cs); // (TPT271) PATCH succeeded — same release as the PUT path below
      return; // patched directly — skip the TODO.md PUT (task not in data.tasks)
    }
  }

  // C1439: per-card ✓ Accept used to send NO new_tags at all — data.new_tags was only
  // ever set by the bulk "Save Tasks" button, so a solo Accept whose card carries a tag
  // the registry doesn't have yet always 400'd. Same `!change._manual` guard as the spec
  // payload below — a manual New Task form save has no LLM proposal (`msg` is undefined).
  if (!change._manual) attachNewTagsPayload(data, msg && msg.newTags, [change]);

  // C1245: state.chatState is global, not tab-scoped — a manual New Task save
  // (change._manual) must never attach an unrelated objective's spec comment or
  // trip the newTaskIds-gated server logic (id reassignment, status re-force).
  attachOriginalSpecPayload(
    data,
    (change.type === 'new' && !change._manual)
      ? [change.task.id, ...(objectiveParent ? [objectiveParent.id] : [])]
      : [],
    cs
  );
  if (change.type === 'new' && !change._manual) {
    attachSplitOriginPayload(data, resolveOriginPlan(cs, proposedNewCount, [change.task.id]));
  }
  data.newTaskPinnedIds = change.type === 'new' && !change._manual && isStepPinned ? [change.task.id] : [];
  const jsonStr = JSON.stringify(data, null, 2);
  const newTodoText = text.replace(/```json\s*[\s\S]*```/, () => '```json\n' + jsonStr + '\n```');
  const putRes = await fetchWithRetry('/api/todo', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain', ...projectHeader() },
    body: newTodoText,
    label: 'todo-write-single',
  });
  if (!putRes.ok) throw new Error(await readErrorBody(putRes));
  // Apply any server-side ID remap from PUT (last-chance collision detection)
  if (putRes.ok) {
    try {
      const putBody = await putRes.clone().json();
      if (putBody.idRemap && Object.keys(putBody.idRemap).length > 0) {
        const before = change.task.id;
        applyIdRemapToCards([change], putBody.idRemap);
        if (before !== change.task.id) console.warn(`[save] PUT ID collision resolved: ${before} -> ${change.task.id}`);
      }
      // (C1339) applyIdRemapToCards only walks `change` — the objective parent isn't a
      // card, so its real reserved key needs a separate hop out of idRemap. Persists via
      // saveChatState() in the caller right after this resolves.
      if (objectiveParent) {
        const finalKey = putBody.idRemap && putBody.idRemap[objectiveParent.id];
        if (finalKey) cs.objectiveParentKey = finalKey;
        else console.warn('[save] objective parent not remapped — expected a reserved key for', objectiveParent.id);
      }
      // (C1559) Commit AFTER a successful PUT — same reasoning as the objectiveParent
      // hop above: a failed save must not memoize a resolution that never landed.
      if (originParentKey) { cs.objectiveParentKey = originParentKey; cs.originResolution = 'parent'; }
      if (originPlan.mode === 'single') cs.originResolution = 'single';
    } catch { /* non-critical — ID already committed to file */ }
  }
  releaseDiscussLock(cs); // (TPT271) PUT succeeded — the discussion is resolved
}

// ── (TPT271/TPT283) Release a Rehash → Discuss/Split lock after a successful save ──
// Located by the chatState captured at save start (never the live active tab — a mid-save tab
// switch must not release a different tab). Discuss: clears rehashIntent/taskKey on both the tab
// row and its chatState (restore re-derives the tab from chatState). Split: keeps the intent —
// later per-card accepts in the same chat still need split mode (resolveOriginPlan()) and the
// server's split directive — and stamps lockReleased instead, which discuss-lock.js skips. Then
// recomputes the board's lock state. No-op for other chats and the manual New Task form (cs null).
function releaseDiscussLock(cs) {
  if (!cs) return;
  const tab = Array.isArray(state.tabsState) ? state.tabsState.find(t => t.chatState === cs) : null;
  const intent = (tab && tab.rehashIntent) || cs.rehashIntent;
  if (intent === 'discuss') {
    if (tab) Object.assign(tab, { rehashIntent: null, taskKey: null });
    Object.assign(cs, { rehashIntent: null, taskKey: null });
  } else if (intent === 'split') {
    if (tab) tab.lockReleased = true;
    cs.lockReleased = true;
  } else {
    return;
  }
  saveChatState();
  // chat-draft is the restore fallback once no unsaved cards remain; keep its rehash fields
  // current too. Written from state.chatState, so only when cs is the active chat.
  if (state.chatState === cs) saveChatDraft();
  syncDiscussLocks();
}

// ── (TPT257) Rewrite the subtask summary line in place ──
// chat-ui.js's renderObjectiveContent() renders `#subtask-preview-summary` once per paint;
// a per-card Reject only calls updateSaveBar() (no reload), so the count is patched here.
// No-op when the element isn't mounted (not a subtask chat, or no cards yet).
export function refreshSubtaskSummary() {
  const cs = state.chatState;
  const el = document.getElementById('subtask-preview-summary');
  if (!el || !cs || !cs.parentTaskKey) return;
  const n = countPendingSubtaskCards(cs.messages);
  el.dataset.count = String(n);
  el.textContent = tc('chat.subtaskSummary', n, { key: cs.parentTaskKey });
}

// ── Update save bar count (per-message or all bars) ──
export function updateSaveBar(targetMsgIdx) {
  if (!state.chatState) return;
  refreshSubtaskSummary();

  if (targetMsgIdx !== undefined) {
    const msg = state.chatState.messages[targetMsgIdx];
    const bar = document.querySelector(`.chat-save-bar[data-msg-idx="${targetMsgIdx}"]`);
    if (!msg) { if (bar) bar.remove(); return; }

    const count = getUnsavedAcceptedCountForMsg(msg);

    if (msg.discarded) {
      if (bar) {
        bar.classList.add('resolved');
        bar.innerHTML = '<span class="save-bar-status">Discarded</span>';
      }
      return;
    }

    if (count === 0) {
      const anyConfirmed = (msg.confirmedMask || []).some(v => v);
      if (bar) {
        if (anyConfirmed) {
          bar.classList.add('resolved');
          bar.innerHTML = '<span class="save-bar-status">\u2713 Saved</span>';
        } else {
          bar.remove();
        }
      }
      return;
    }

    if (bar) {
      const countEl = bar.querySelector('.save-bar-count');
      if (countEl) countEl.textContent = `${count} task${count !== 1 ? 's' : ''} ready to save`;
    } else if (count > 0) {
      reload();
    }
  } else {
    document.querySelectorAll('.chat-save-bar[data-msg-idx]').forEach(bar => {
      updateSaveBar(parseInt(bar.dataset.msgIdx));
    });
  }
}

// ── Check if all cards across all messages are confirmed or rejected ──
// `cs` is the chat to check and, when finished, close (its tab + server session via cleanupChat's
// kill). Callers that awaited in between pass the chat they started on; default = visible chat.
export function checkAllCardsHandled(cs = state.chatState) {
  if (!cs) return false;
  let anyCards = false;
  let allHandled = true;
  for (const msg of cs.messages) {
    if (!msg.cards || msg.cards.length === 0) continue;
    anyCards = true;
    const mask = msg.acceptedMask || [];
    const confirmed = msg.confirmedMask || [];
    for (let i = 0; i < msg.cards.length; i++) {
      if (!confirmed[i] && mask[i] !== false) { allHandled = false; break; }
    }
    if (!allHandled) break;
  }
  if (anyCards && allHandled) {
    // Expand tiers for confirmed tasks
    const affectedPriorities = new Set();
    for (const msg of cs.messages) {
      if (!msg.cards) continue;
      const confirmed = msg.confirmedMask || [];
      for (let i = 0; i < msg.cards.length; i++) {
        if (confirmed[i] && msg.cards[i].task.priority !== undefined) {
          affectedPriorities.add(msg.cards[i].task.priority);
        }
      }
    }
    for (const p of affectedPriorities) {
      state.collapsedTiers.delete(p);
      state.expandedTiers.add(p);
    }
    // Navigate to the board only when the finished chat is the one on screen — one finished in a
    // background tab just closes (cleanupChat re-points the active tab only if it was active).
    if (cs === state.chatState) {
      state.activeTab = 'board';
      state.pendingScrollTop = true; // navigate to board → reset to top
      state.sessionAgent = null;
    }
    // (TPT19) force:true — same unconditional-purge reasoning as the bulk-save handler
    // above; also clears LAST_PROMPT_KEY, so the explicit clearDraft() call here is gone.
    cleanupChat(cs, { force: true });
    reload();
    return true;
  }
  return false;
}
