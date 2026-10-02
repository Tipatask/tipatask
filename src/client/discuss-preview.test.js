import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// (TPT179) Rehash → Discuss: pinned task-card preview + read-only modal opening.
// task-card.js / chat-task-preview.js aren't importable under node (DOM + WebSocket imports), so —
// same house pattern as chat-rehash.test.js — the real function source is extracted and run in a
// vm with stubbed collaborators, and wiring that can't be exercised is source-scanned.
const read = name => readFileSync(new URL('./' + name, import.meta.url), 'utf8');
import { MERGE_DOT, mergeButtonHtml } from './task-merge.js';

function extract(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found`);
  const end = text.indexOf('\n}', start) + 2;
  return text.slice(start, end);
}

function cardEnv(overrides = {}) {
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const empty = () => '';
  const env = {
    state: { childrenByParent: new Map([['TPT179', [{ id: 'TPT180', title: 'Child', status: 'pending' }]]]), selectedCardIds: new Set(['TPT179']), pendingTaskIds: new Set(['TPT179']), tagDescriptions: new Map(), showAiStats: false, deviceId: 'd1' },
    MAX_DESC_LEN: 500,
    unmetDependencyKeys: () => [], isActiveName: () => true, isStartName: () => false, isInProgressName: () => true,
    isCanceledName: () => false, isCompleteName: () => false, canStartTaskCard: () => true,
    escapeAttr: esc, renderMarkdown: v => esc(v), truncateMarkdownAtParagraph: v => v, renderTagBadge: tag => `<span class="tag-badge">${esc(tag)}</span>`,
    translate: k => k, statusRoleToken: () => 'active', statusColor: () => '#3b82f6', statusLabel: s => `label:${s}`,
    statusNames: () => ['pending', 'in_progress'], cardVariant: () => 'narrow', cardMaxWidthPx: () => 300, _measureTitle: () => 10,
    renderAgentBadge: () => '<span class="agent-badge"></span>', renderEffortBadge: () => '', renderMemberBadge: () => '<span class="member-badge"></span>',
    activityChipHtml: () => '<span class="activity-chip"></span>', attentionClass: () => ' needs-attention',
    getSprintsEnabled: () => true, renderSprintBadgeLabel: () => 'Sprint 341', buildSubtasksLabel: () => '0/1',
    formatDueDate: () => '', _WAND_SVG: '<svg/>', _CHAT_SVG: '<svg/>', _SUBTASKS_SVG: '<svg/>',
    isTaskDiscussing: () => false, lockIntentOf: () => null, discussOverlayHtml: () => '<div class="card-discuss-overlay"></div>',
    Date, JSON, Set, Map, String, Number,
    ...overrides,
  };
  vm.createContext(env);
  vm.runInContext(extract(read('task-card.js'), 'renderCard'), env);
  return env;
}

const task = {
  id: 'TPT179', title: 'Rehash discuss', description: 'Pin a card.', category: 'CODING', status: 'in_progress', priority: 341,
  order: 45, dependencies: ['TPT210'], tags: ['feature', 'tt-objective-chat'], dbId: 36789, parentDbId: null, assignee: 1, agentAssignee: 'claude',
  isObjective: false, hasChildren: true,
};

test('renderCard shows merge controls only for manual unmerged board cards', () => {
  const env = cardEnv({ MERGE_DOT, mergeButtonHtml });
  env.state.taskMergeStatus = { vcs: { type: 'git', merge: false }, tasks: { [task.id]: { unmerged: true } } };
  const html = env.renderCard(task);
  assert.match(html, /btn-merge-task/);
  assert.equal((html.match(/merge-attention-dot/g) || []).length, 2);
  assert.doesNotMatch(env.renderCard(task, { preview: true }), /btn-merge-task|merge-attention-dot/);
  env.state.taskMergeStatus.vcs.merge = true;
  assert.doesNotMatch(env.renderCard(task), /btn-merge-task|merge-attention-dot/);
});

test('renderCard(preview) keeps what a card shows and drops every control and board lookup attribute', () => {
  const html = cardEnv().renderCard(task, { preview: true });
  // Informational content survives.
  assert.match(html, /class="id-badge coding"/);
  assert.match(html, />TPT179</);
  assert.match(html, /Rehash discuss/);
  assert.match(html, /Pin a card\./);
  assert.match(html, /tag-badge">feature</);
  assert.match(html, /class="status"/);
  assert.match(html, /label:in_progress/);
  assert.match(html, /Deps: TPT210/);
  assert.match(html, /member-badge/);
  assert.match(html, /agent-badge/);
  assert.match(html, /data-preview-task="TPT179"/);
  // Board machinery is gone: ~35 selectors key on `.card[data-id]`, so none of these may appear.
  for (const banned of [
    'data-id=', 'data-db-id=', 'data-parent-db-id=', 'data-deps=', 'data-tags=', 'data-task-id=',
    'card-action-menu', 'card-btn-group', 'btn-chain-deps', 'btn-reiterate', 'btn-task-chat', 'btn-delete-task', 'btn-select-card',
    'task-card-hover-controls', 'card-status-select', 'card-start-btn', 'subtask-list', 'subtask-radio',
    'activity-chip', 'needs-attention', ' selected', 'pending-sync', 'card-ctl',
  ]) assert.ok(!html.includes(banned), `preview card must not contain "${banned}"`);
});

test('renderCard sends the paragraph-truncated description to markdown while retaining full raw text', () => {
  const fullDescription = 'First paragraph.\n\nSecond paragraph that crosses the preview limit.';
  const html = cardEnv({ truncateMarkdownAtParagraph: () => 'First paragraph.\n\n… (truncated)' })
    .renderCard({ ...task, description: fullDescription });

  assert.match(html, /class="card-desc"[^>]*data-raw="First paragraph\.\n\nSecond paragraph that crosses the preview limit\."/);
  assert.match(html, />First paragraph\.\n\n… \(truncated\)<\/div>/);
  assert.doesNotMatch(html, />First paragraph\.\n\nSecond paragraph that crosses the preview limit\.<\/div>/);
});

test('renderCard() without preview is unchanged: full board card with lookup attributes and controls', () => {
  const html = cardEnv().renderCard(task);
  for (const wanted of [
    'data-id="TPT179"', 'data-db-id="36789"', 'card-btn-group', 'card-action-menu', 'btn-reiterate',
    'class="btn-task-chat" type="button" data-task-id="TPT179"',
    'card-status-select', 'subtask-radio', 'activity-chip',
    // (TPT278) every header control carries the shared sizing class
    'class="card-status-select card-ctl"',
    'class="card-start-btn btn-claude card-ctl"', 'class="btn-open-subtask-board card-ctl"',
  ]) assert.ok(html.includes(wanted), `board card must still contain "${wanted}"`);
  assert.ok(!html.includes('data-preview-task'));
  assert.ok(!html.includes('card--preview'));
});

// (TPT269) Objective-chat proposal cards render through the same renderCard(), so they match the
// Project Board; proposal-only controls come in through the head/meta/foot slots.
test('renderCard(proposal) is the board card plus caller slots and the legacy .preview-* hooks', () => {
  const html = cardEnv().renderCard({ ...task, description: 'a ~b~ c' }, {
    proposal: {
      rootClass: 'new-task rejected',
      rootAttrs: 'data-msg-idx="2" data-card-idx="0" data-task-id="new" data-accepted="false"',
      headHtml: '<span class="change-label">NEW</span>',
      metaHtml: '<select class="step-selector"></select>',
      footHtml: '<div class="preview-card-actions"></div>',
      descTransform: v => v.replace(/~/g, '\\~'),
    },
  });
  assert.match(html, /class="card card--preview preview-card new-task rejected"/);
  assert.match(html, /data-msg-idx="2" data-card-idx="0" data-task-id="new" data-accepted="false"/);
  assert.match(html, /class="card-title preview-title" data-field="title"/);
  assert.match(html, /class="card-desc preview-desc" data-field="description"/);
  // descTransform shapes only the rendered markdown; data-raw keeps the untouched description.
  assert.match(html, /data-raw="a ~b~ c">a \\~b\\~ c<\/div>/);
  assert.match(html, /<div class="card-preview-meta"><select class="step-selector"><\/select><\/div>/);
  const head = html.indexOf('change-label');
  const top = html.indexOf('class="card-top card-top--proposal"');
  const meta = html.indexOf('card-preview-meta');
  const desc = html.indexOf('class="card-desc');
  const foot = html.indexOf('preview-card-actions');
  assert.ok(head < top && top < meta && meta < desc && desc < foot, 'slot order: head, card-top, meta, desc, foot');
  assert.match(html, /tag-badge">feature</);
  // No corner badges (the caller places the agent badge in the meta row) and no board lookups.
  for (const banned of ['agent-badge', 'member-badge', 'data-id=', 'data-db-id=', 'data-preview-task="TPT179" data-status', 'card-hamburger', 'card-status-select', 'label:in_progress']) {
    assert.ok(!html.includes(banned), `proposal card must not contain "${banned}"`);
  }
  // (TPT299) Without hideIdBadge the real key shows.
  assert.match(html, /<span class="id-badge coding" data-preview-task="TPT179" title="[^"]*">TPT179<\/span>/);
});

// (TPT299) An unsaved `new` proposal keeps only the NEW label: the id badge is present (so
// updatePreviewCardDomId() can fill it after save) but empty and hidden.
test('renderCard(proposal, hideIdBadge) renders an empty hidden id badge; board/preview cards keep a plain .card-top', () => {
  const env = cardEnv();
  const html = env.renderCard({ ...task, id: 'new' }, { proposal: { hideIdBadge: true } });
  assert.match(html, /<span class="id-badge coding" data-preview-task="new" title="[^"]*" hidden><\/span>/);
  assert.ok(!/>new</.test(html), 'placeholder "new" must not render as badge text');
  assert.match(html, /class="card-top card-top--proposal"/);
  for (const opts of [{}, { preview: true }]) {
    const other = env.renderCard(task, opts);
    assert.match(other, /class="card-top">/);
    assert.ok(!other.includes('card-top--proposal'));
    assert.ok(!/class="id-badge[^>]*hidden/.test(other));
  }
});

test('chat-task-preview.js: proposal cards go through the board renderCard() in proposal mode', () => {
  const src = read('chat-task-preview.js');
  const body = src.slice(src.indexOf('export function renderCardHtml('), src.indexOf('export function renderDiscussPreviewHtml('));
  assert.match(body, /renderBoardCard\(cardTask, \{\s*proposal: \{ rootClass, rootAttrs, headHtml, metaHtml, footHtml, hideIdBadge, descTransform: escapeMarkdownTilde \}/);
  // (TPT279) Meta-row controls carry the shared card-ctl sizing; the agent badge is the last item.
  assert.ok(body.includes('<span class="status card-ctl"'), 'status chip must carry card-ctl');
  assert.ok(body.includes('<select class="step-selector preview-step-select card-ctl"'), 'sprint select must carry the themed class + card-ctl');
  // (TPT299) The badge is hidden for exactly the unsaved-new placeholder case.
  assert.match(body, /const hideIdBadge = c\.type === 'new' && !isConfirmed;/);
  const upd = src.slice(src.indexOf('function updatePreviewCardDomId('), src.indexOf('function computeMinStep('));
  assert.match(upd, /badge\.hidden = !id \|\| id === 'new' \|\| id\.startsWith\('new-'\)/);
  assert.ok(body.includes('<span class="step-label card-ctl"'), 'confirmed sprint label must carry card-ctl');
  // (TPT303) Status + sprint are one .preview-meta-controls group; deps and agent badge follow it.
  assert.match(body, /const metaHtml = `<span class="preview-meta-controls"><span class="status card-ctl"[^`]*\$\{stepSelector\}<\/span>\$\{deps\}\$\{renderAgentBadge\(t\)\}`;/);
  assert.ok(!body.includes('<div class="preview-card '), 'bespoke .preview-card markup must be gone');
  assert.ok(!body.includes('class="preview-desc"'), 'bespoke .preview-desc markup must be gone');
  const css = read('styles.css');
  assert.match(css, /\.preview-card:not\(\.card\) \.preview-desc \{/);
  assert.match(css, /\.card\.preview-card:not\(\.card-expanded\) \.card-desc \{/);
});

function previewEnv() {
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const env = {
    escapeAttr: esc,
    translate: (k, p) => (p && p.key ? `${k}:${p.key}` : k),
    renderBoardCard: (t, opts) => `<div class="card card--preview" data-preview-task="${esc(t.id)}" data-opts="${esc(JSON.stringify(opts))}">${esc(t.title)}</div>`,
  };
  vm.createContext(env);
  vm.runInContext(extract(read('chat-task-preview.js'), 'renderDiscussPreviewHtml'), env);
  return env;
}

test('renderDiscussPreviewHtml: loading, error and loaded states', () => {
  const { renderDiscussPreviewHtml } = previewEnv();
  const loading = renderDiscussPreviewHtml('TPT179', { pending: true });
  assert.match(loading, /data-discuss-key="TPT179"/);
  assert.match(loading, /chat-discuss-note--loading/);
  assert.ok(!loading.includes('chat-discuss-card'));
  const failed = renderDiscussPreviewHtml('TPT179', { error: true });
  assert.match(failed, /chat\.discussUnavailable:TPT179/);
  assert.ok(!failed.includes('chat-discuss-card'));
  const ok = renderDiscussPreviewHtml('TPT179', { task: { id: 'TPT179', title: 'Rehash discuss', description: null, tags: null, dependencies: null } });
  assert.match(ok, /data-discuss-task="TPT179"/);
  assert.match(ok, /&quot;preview&quot;:true/);       // rendered through the board's renderCard in preview mode
  assert.match(ok, /Rehash discuss/);
});

test('renderDiscussPreviewHtml: no detach control in any state; no proposal-card handles', () => {
  const { renderDiscussPreviewHtml } = previewEnv();
  const html = renderDiscussPreviewHtml('TPT179', { task: { id: 'TPT179', title: 'T' } });
  for (const state of [html, renderDiscussPreviewHtml('TPT179', undefined), renderDiscussPreviewHtml('TPT179', { error: true })]) {
    assert.ok(!state.includes('btn-clear-discuss-ctx'), 'discuss preview must not carry a close/detach button');
    assert.ok(!state.includes('<button'), 'discuss preview header holds only the caption');
  }
  const cardStart = html.indexOf('<div class="chat-discuss-card"');
  const cardEnd = html.indexOf('</div>', html.indexOf('data-preview-task', cardStart)) + 6;
  const cardHtml = html.slice(cardStart, cardEnd);
  assert.notEqual(cardStart, -1);
  assert.match(cardHtml, /role="button" tabindex="0"/);
  // attachCardHandlers() delegates on these — the preview must never match them.
  for (const banned of ['data-msg-idx', 'data-card-idx', 'preview-card', 'btn-accept-card', 'step-selector']) {
    assert.ok(!html.includes(banned), `discuss preview must not contain "${banned}"`);
  }
});

test('Discuss handler no longer seeds the composer: hidden intent only', () => {
  const src = read('task-board.js');
  const start = src.indexOf("overlay.querySelector('.btn-reiterate-spec')");
  const end = src.indexOf("overlay.querySelector('.btn-reiterate-trello')");
  assert.ok(start !== -1 && end > start);
  const body = src.slice(start, end);
  assert.match(body, /rehashIntent: 'discuss'/);
  assert.match(body, /spawnObjectiveTab\?\.\(\s*''/);          // empty seed text
  for (const banned of ["research and improve", 'chat-input', 'saveDraft', 'getObjectiveDraftKey', 'taskLoadedForDiscuss', 'JSON.stringify(curated', "fetch(`/api/tasks/"]) {
    assert.ok(!body.includes(banned), `Discuss handler must not reference "${banned}"`);
  }
  // Discuss is neither subtask mode nor web-origin planning (C1559's origin prompt forbids a modified card for the origin id).
  assert.ok(!/subtaskCtx|originTaskKey/.test(body.replace(/\/\/.*$/gm, '')), 'discuss must not set subtaskCtx/originTaskKey');
});

test('task edit modal: every read-only lock goes through _isModalReadOnly(); Start is hidden when read-only', () => {
  const src = read('task-edit-modal.js');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  // import + helper body + the banner's cause check are the only remaining direct callers.
  const direct = code.match(/commands\.isTaskReadOnly\(/g) || [];
  assert.equal(direct.length, 2, 'only _isModalReadOnly() and the banner cause check may call isTaskReadOnly() directly');
  assert.ok((code.match(/_isModalReadOnly\(/g) || []).length >= 7, 'render, _applyModalLockState x3, desc click guard and member combo all use it');
  assert.match(code, /function _isModalReadOnly\(draft\)\s*\{\s*return commands\.isTaskReadOnly\(draft\) \|\| !!_modalState\?\.callbacks\?\.readOnly;/);
  assert.match(code, /const showStart = !isPreviewTask && !readOnly && /);
  assert.match(code, /modal\.readOnlyDiscuss/);
});

test('chat-ui.js wiring: preview sits outside .chat-body, hint/placeholder are discuss-aware, card opens the modal read-only', () => {
  const src = read('chat-ui.js');
  const shell = src.slice(src.indexOf('<div class="chat-container ${layoutClass}">'));
  const previewAt = shell.indexOf('${discussPreviewHtml}');
  assert.ok(previewAt !== -1, 'preview slot missing from the chat shell');
  assert.ok(previewAt < shell.indexOf('<div class="chat-body">'), 'preview must be a sibling ABOVE .chat-body (outside the .chat-messages scroller)');
  assert.match(src, /!state\.chatState && !discussKey \? '<div class="chat-brief-hint"/);
  assert.match(src, /t\('chat\.discussPlaceholder', \{ key: discussKey \}\)/);
  assert.match(src, /openTaskEditModal\(card\.dataset\.discussTask, \{ readOnly: true \}\)/);
  // Errors must stay cached so a permanently failing key can't refetch on every re-render.
  assert.match(src, /\(\) => discussTaskCache\.set\(key, \{ error: true \}\)/);
});

test('i18n: discuss keys exist in en and uk; orphaned toast is gone', () => {
  const src = read('i18n.js');
  for (const key of ['chat.discussPlaceholder', 'chat.discussCaption', 'chat.discussOpenTask', 'chat.discussUnavailable', 'modal.readOnlyDiscuss']) {
    assert.equal((src.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g')) || []).length, 2, `${key} must be defined once per locale`);
  }
  assert.ok(!src.includes('taskLoadedForDiscuss'));
  assert.ok(!src.includes('chat.discussExit'), 'detach control removed; its label must not linger');
});

// (TPT272) Board card of a task locked by an open Rehash → Discuss tab.
test('renderCard: a discussing board card is greyed with the hourglass overlay and no Start; preview is untouched', () => {
  const env = cardEnv({ isTaskDiscussing: () => true, canStartTaskCard: () => false });
  const board = env.renderCard(task);
  assert.match(board, /class="card[^"]* card--discussing"/);
  assert.match(board, /card-discuss-overlay/);
  assert.doesNotMatch(board, /btn-claude/);
  assert.doesNotMatch(board, /btn-start-discussion/);
  const preview = env.renderCard(task, { preview: true });
  assert.doesNotMatch(preview, /card--discussing|card-discuss-overlay/);
  const unlocked = cardEnv().renderCard(task);
  assert.doesNotMatch(unlocked, /card--discussing|card-discuss-overlay/);
  assert.doesNotMatch(unlocked, /data-lock-intent/);
  assert.match(unlocked, /btn-claude/);
});

// (TPT283) Rehash → Split locks the same way; the root names the mode for the overlay/toast.
test('renderCard: a split-locked board card carries data-lock-intent="split"; preview never does', () => {
  const env = cardEnv({ isTaskDiscussing: () => true, lockIntentOf: () => 'split', canStartTaskCard: () => false });
  const board = env.renderCard(task);
  assert.match(board, /card--discussing/);
  assert.match(board, /data-lock-intent="split"/);
  assert.doesNotMatch(env.renderCard(task, { preview: true }), /data-lock-intent/);
});

test('discuss lock guards: Start helper, board dblclick, edit modal, Start repaint, live listener', () => {
  const card = read('task-card.js');
  assert.match(extract(card, 'canStartTaskCard'), /if \(isTaskDiscussing\(state, t\.id\)\) return false;/);
  assert.match(card, /if \(isTaskDiscussing\(state, card\.dataset\.id\)\) return; \/\/ \(TPT272\/TPT283\)/);
  assert.match(extract(card, 'refreshCard'), /applyDiscussLock\(card\);/);
  const board = read('task-board.js');
  assert.match(read('task-edit-modal.js'), /isTaskDiscussing\(state, taskId\) && !callbacks\.readOnly && !callbacks\.preloadedTask/);
  const update = board.slice(board.indexOf('export function updateClaudeButtons('));
  assert.match(update.slice(0, 4000), /if \(isTaskDiscussing\(state, taskId\)\) \{\s*btn\.remove\(\);/);
  const tpl = read('template.html');
  assert.match(tpl, /addEventListener\('tiptask:discuss-lock-changed'/);
  assert.match(tpl, /applyDiscussLock\(card\)/);
  const i18n = read('i18n.js');
  assert.equal((i18n.match(/'card\.discussing':/g) || []).length, 2);
  assert.match(read('constants.js'), /export const HOURGLASS_SVG = '<svg[^']*fill="currentColor"/);
  assert.match(read('styles.css'), /@keyframes hourglass-spin/);
});
