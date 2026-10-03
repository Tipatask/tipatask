// Task chat window — a conversation with an agent (Claude / Codex / Pi) about one task, or about
// the selected project (no task). Server side: ws-handlers.js `taskChat:<taskKey>` /
// `projectChat:<API_PROJECT_ID>:<chatId>` session (see tt-task-chat.md). The chat lives on the server
// until it is killed, so closing this window only detaches: reopening restores the transcript
// from `chat-history-reset` and picks a running turn back up. A chat with no session yet waits
// behind the start gate: nothing is sent to the server until the user picks a model and Starts.
// (TPT466) A task's chat is shown on the Chat pane of its workspace modal (task-edit-modal.js),
// mounted there through mount(); open() routes to that workspace. The project chat (left menu
// "Start Chat") stays a window of its own.
import { buildWsUrl, wsSend, WS_SEND_TYPES, WS_RECV_TYPES } from './ws-client.js';
import { renderMarkdown, escapeAttr, autoGrowTextarea, projectHeader, showToast } from './utils.js';
import { modelLabel, CHAT_BUBBLE_SVG } from './constants.js';
import state from './state.js';
import { activateDialogFocus } from './dialog-focus.js';
import { t, getLocale } from './i18n.js';
import { renderCard } from './task-card.js';
import { openTaskEditModal } from './task-edit-modal.js';
import { attachImagePaste } from './task-board.js';
import { embedMenuHtml, attachEmbedMenu, attachFileDrop, closeOpenEmbedMenu } from './embed-menu.js';
import {
  taskChatProviders, pickSelection, buildModelOptionsHtml, stripAskUserFence,
  visibleHistory, upsertById, shortToolName, hasWidgets, collapseTaskEvents,
  dialogSubmission, localAnswer, answerSummary, dialogWidgetHtml, toolChipHtml,
  splitAttachmentRefs, attachmentsHtml, userMessageHtml, stripPendingImageRefs,
  dialogState, lastTurnMessage,
} from './task-chat-model.js';

const SESSION_PREFIX = 'taskChat:';
const PROJECT_SESSION_PREFIX = 'projectChat:';
// Sticky model choice for this window. Deliberately not the objective chat's key: the two
// chats offer different provider sets and a pick here must not move the planner's default.
const MODEL_STORAGE_KEY = 'tipatask-task-chat-model';
const DRAFT_STORAGE_PREFIX = 'tipatask-task-chat-draft:';
const STICK_THRESHOLD_PX = 64;
const FRESH_START_TIMEOUT_MS = 3000;

const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg>';
const ICON_CHAT = CHAT_BUBBLE_SVG;
// (TPT469) A project holds several chats, `projectChat:<projectId>:<chatId>`. The bare
// `projectChat:<projectId>` is a chat started before that, still reopened from the left menu.
const PROJECT_CHAT_ID_RE = /^projectChat:([1-9]\d*)(?::[a-z0-9]{6,32})?$/;

let ws = null;
let chat = null;            // { kind: 'task'|'project', key, sessionId, title } — the open chat
let openSeq = 0;            // bumped per open request; a slower project-config read loses to a newer one
let root = null;            // .task-chat-modal
let messages = [];          // [{ role, content, streaming?, error?, retry?, dialogAnswer?, dialogs, tools, taskEvents, el }]
let providers = [];
let selection = '';         // "provider:model" sent with the next turn
let running = false;        // a turn is in progress on the server
let connected = false;
let sawReset = false;       // this socket attached to an existing session
let resetSelection = '';
let ended = false;          // the server confirmed this session is gone
let wantFresh = false;      // discard whatever session exists and start a new chat
let freshTimer = null;
let awaitingStart = false;  // the start gate is up: connected, no session, nothing sent yet
let starting = false;       // Start was pressed on this socket — a second press sends nothing
let stickToBottom = true;
let renderFrame = 0;
let focusHandle = null;
let keyHandler = null;
let providersHandler = null;
let reloadHandler = null;
let renderedLocale = '';     // locale the window's labels were last written in
let pendingAnswer = null;   // { dialog, userMsg } — an answer sent, no frame of its turn back yet
let widgetSeq = 0;
const widgetSig = new WeakMap(); // widget element -> signature of the record it was built from
let embedded = null;        // { host, onOpenTask, onClosed } while mounted in a workspace pane
let uploadsPending = 0;     // attachments uploading into the composer; Send waits for them
let uploadGen = 0;          // bumped per built window; a late upload callback of an old one is ignored
// (TPT469) Per project, the chat Start Chat opens: kept until its first user message gives it a
// title, so repeated clicks land on the same untouched draft instead of piling up new ones.
// localStorage carries it across a renderer reload, together with that chat's composer text.
const DRAFT_CHAT_STORAGE_PREFIX = 'tipatask-project-chat-draft:';
const projectDraftChats = new Map();
// Unsent composer text per project and chat. The map also keeps drafts available when browser
// storage is blocked; localStorage carries them across a renderer reload.
const composerDrafts = new Map();

export async function open(taskId) {
  const key = String(taskId || '').trim();
  if (!key) return;
  const openWorkspace = window.TipTask?.openTaskWorkspace;
  if (typeof openWorkspace === 'function') return openWorkspace(key, { pane: 'chat' });
  openSeq++;
  openChat({ kind: 'task', key, sessionId: SESSION_PREFIX + key, title: '' });
}

// (TPT466) The task's chat inside `host` — a workspace pane — rather than a window of its own.
// The pane's modal owns the backdrop, focus layer, Escape and heading; this fills the rest.
// The returned handle: show()/hide() for pane switches (transcript, scroll and typed text stay
// as they are), dispose() to detach (the server chat keeps running), taskEdited(key) to tell
// the agent about a save made in the Edit pane. `onOpenTask(key)` handles a task card click;
// `onClosed()` fires if the chat closes on its own (another window took it over).
export function mount(host, taskId, { onOpenTask, onClosed } = {}) {
  const key = String(taskId || '').trim();
  if (!host || !key) return null;
  openSeq++;
  openChat({ kind: 'task', key, sessionId: SESSION_PREFIX + key, title: '' }, { host, onOpenTask, onClosed });
  const target = chat;
  const live = () => chat === target && !!root;
  return {
    show({ focus = true } = {}) {
      if (!live()) return;
      growInput();
      scrollToBottom(stickToBottom);
      if (!focus) return;
      if (awaitingStart) {
        const go = root.querySelector('.task-chat-start-go');
        if (go && !go.disabled) go.focus({ preventScroll: true });
      } else {
        focusComposer();
      }
    },
    hide() {
      if (live() && root.contains(document.activeElement)) document.activeElement.blur();
    },
    dispose() {
      if (chat === target) close();
    },
    taskEdited(editedKey) {
      if (live() && connected && ws) wsSend(ws, WS_SEND_TYPES.TASK_CHAT_TASK_EDITED, { taskKey: editedKey || key });
    },
  };
}

// The project id a project chat session id belongs to ('' for anything else).
export function projectIdOfChat(id) {
  const m = typeof id === 'string' ? PROJECT_CHAT_ID_RE.exec(id) : null;
  return m ? m[1] : '';
}

// Session id of the chat window open right now ('' when none) — the left menu marks its row.
export function currentChatId() {
  return chat && root ? chat.sessionId : '';
}

function newProjectChatId(projectId) {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${PROJECT_SESSION_PREFIX}${projectId}:${Date.now().toString(36)}${rand}`;
}

// Which chat Start Chat opens: the remembered draft while it is still untitled, else an untitled
// chat of this project the server already holds (started in another window or before a reload),
// else a new one. A titled chat is a conversation of its own and is only opened from its row.
function pickProjectChatId(projectId) {
  const meta = state.sessionMeta instanceof Map ? state.sessionMeta : new Map();
  const untitled = id => !meta.get(id)?.title;
  const remembered = readDraftChat(projectId);
  if (remembered && untitled(remembered)) return remembered;
  const serverDraft = [...meta.entries()]
    .filter(([id, row]) => projectIdOfChat(id) === projectId && id !== PROJECT_SESSION_PREFIX + projectId && !row?.title)
    .sort((a, b) => (b[1]?.startedAt || 0) - (a[1]?.startedAt || 0))[0];
  const id = serverDraft ? serverDraft[0] : newProjectChatId(projectId);
  writeDraftChat(projectId, id);
  return id;
}

function draftChatKey(projectId) {
  return DRAFT_CHAT_STORAGE_PREFIX + JSON.stringify([projectHeader()['x-tipatask-project'] || '', projectId]);
}

function readDraftChat(projectId) {
  const key = draftChatKey(projectId);
  if (projectDraftChats.has(key)) return projectDraftChats.get(key);
  let id = '';
  try { id = localStorage.getItem(key) || ''; } catch { /* storage unavailable */ }
  return projectIdOfChat(id) === projectId ? id : '';
}

function writeDraftChat(projectId, id) {
  const key = draftChatKey(projectId);
  projectDraftChats.set(key, id);
  try { localStorage.setItem(key, id); } catch { /* storage unavailable */ }
}

// The chat is named: Start Chat must open a new draft from now on.
function forgetDraftChat(projectId, id) {
  if (readDraftChat(projectId) !== id) return;
  const key = draftChatKey(projectId);
  projectDraftChats.delete(key);
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

// Repaint the left menu's session rows; `refetch` first reloads GET /api/sessions.
function refreshSessionsNav(refetch = false) {
  const repaint = () => window.TipTask?.taskBoard?.updateClaudeButtons?.();
  if (!refetch) { repaint(); return; }
  Promise.resolve(window.TipTask?.fetchActiveSessions?.()).then(repaint).catch(() => {});
}

// A chat about the project selected in this window, with no task. The id is read from this
// window's own project config (header-scoped) — the one the server checks the session id against.
// Without `chatId` (Start Chat) it opens the project's draft chat; a left-menu row passes its own.
export async function openProjectChat({ chatId = '' } = {}) {
  const seq = ++openSeq;
  // (TPT466) Started from the left menu, which stays live beside a task workspace on its Agent
  // Terminal pane: close that workspace first (dirty-discard confirm), or the chat would open
  // underneath it (body.task-chat-open lifts the task modal above this window).
  const workspace = document.getElementById('task-edit-modal');
  if (workspace && !workspace.hidden && typeof window.TipTask?.requestCloseTaskEditModal === 'function') {
    if (!(await window.TipTask.requestCloseTaskEditModal())) return;
    if (seq !== openSeq) return;
  }
  let cfg = {};
  try {
    const res = await fetch('/api/project-config', { headers: projectHeader(), cache: 'no-store' });
    if (res.ok) cfg = ((await res.json()) || {}).config || {};
  } catch { /* no id: reported below */ }
  if (seq !== openSeq) return; // a later open (double click, task chat) superseded this one
  const id = String(cfg.API_PROJECT_ID || '').trim();
  if (!/^[1-9]\d*$/.test(id)) { showToast(t('taskChat.error.noProject'), 'error'); return; }
  if (chatId && projectIdOfChat(chatId) !== id) { showToast(t('taskChat.error.noProject'), 'error'); return; }
  // Fresh titles first: a draft another window has since named must not be reused.
  try { await window.TipTask?.fetchActiveSessions?.(); } catch { /* the known list still works */ }
  if (seq !== openSeq) return;
  const sessionId = chatId || pickProjectChatId(id);
  if (chat && chat.sessionId === sessionId && root && !embedded) return; // already in front
  const title = (state.sessionMeta instanceof Map && state.sessionMeta.get(sessionId)?.title) || '';
  openChat({ kind: 'project', key: id, sessionId, title, projectName: String(cfg.projectName || '') });
}

function openChat(target, embedOpts = null) {
  if (chat) close();
  const projectPath = projectHeader()['x-tipatask-project'] || '';
  chat = { ...target, draftKey: DRAFT_STORAGE_PREFIX + JSON.stringify([projectPath, target.sessionId]) };
  embedded = embedOpts;
  messages = [];
  providers = taskChatProviders(state.objectiveProviders);
  selection = pickSelection({ providers, stored: readStoredSelection(), fallback: state.objectiveModel });
  running = false;
  connected = false;
  wantFresh = false;
  awaitingStart = false;
  starting = false;
  stickToBottom = true;
  pendingAnswer = null;

  renderWindow();
  connect();
  if (chat.kind === 'task' && !embedded) loadTaskTitle(chat.key);
  if (chat.kind === 'project') refreshSessionsNav();
}

function isProjectChat() {
  return !!chat && chat.kind === 'project';
}

export function close() {
  const wasEmbedded = embedded;
  embedded = null;
  closeOpenEmbedMenu();
  uploadsPending = 0;
  uploadGen++;
  detachSocket();
  clearTimeout(freshTimer);
  freshTimer = null;
  if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0; }
  if (keyHandler) { document.removeEventListener('keydown', keyHandler, true); keyHandler = null; }
  if (providersHandler) { document.removeEventListener('tiptask:providers-changed', providersHandler); providersHandler = null; }
  if (reloadHandler) { document.removeEventListener('tiptask:reload', reloadHandler); reloadHandler = null; }
  if (root) { root.remove(); root = null; }
  if (focusHandle) { focusHandle.close(); focusHandle = null; }
  if (!wasEmbedded) {
    document.documentElement.style.overflowY = '';
    document.body.style.paddingRight = '';
    document.body.classList.remove('task-chat-open');
  }
  const wasProject = isProjectChat();
  chat = null;
  messages = [];
  running = false;
  connected = false;
  wantFresh = false;
  awaitingStart = false;
  starting = false;
  pendingAnswer = null;
  if (wasProject) refreshSessionsNav();
}

// ── Window ──

function renderWindow() {
  const host = embedded ? embedded.host : null;
  root = document.createElement('div');
  root.className = host ? 'task-chat-embed' : 'task-chat-modal';
  if (!host) {
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'task-chat-title');
  }
  // Standalone: one quiet header row — connection dot, kind and title, Close. Embedded, the
  // workspace's own top bar carries the task key and title, so there is no header at all.
  const headerHtml = host ? '' : `
      <header class="task-chat-header">
        <span class="task-chat-dot" aria-hidden="true"></span>
        <div class="task-chat-title" id="task-chat-title">
          <span class="task-chat-eyebrow-text"></span>
          ${chat.kind === 'task' ? `<span class="task-chat-key">${escapeAttr(chat.key)}</span>` : ''}
          <span class="task-chat-title-text"></span>
        </div>
        <button type="button" class="task-chat-icon-btn task-chat-close">${ICON_CLOSE}</button>
      </header>`;
  root.innerHTML = `
    ${host ? '' : '<div class="task-chat-backdrop"></div>'}
    <div class="task-chat-panel task-chat-panel--connecting${host ? ' task-chat-panel--embedded' : ''}">
      ${headerHtml}
      <div class="task-chat-scroll">
        <section class="task-chat-start" aria-labelledby="task-chat-start-title" hidden>
          <span class="task-chat-start-mark">${ICON_CHAT}</span>
          <h2 class="task-chat-start-title" id="task-chat-start-title"></h2>
          <p class="task-chat-start-lead"></p>
          <div class="task-chat-start-model"></div>
          <div class="task-chat-start-embed">${embedMenuHtml({ label: '' })}</div>
          <div class="task-chat-start-attachments" hidden>
            <p class="task-chat-start-attachments-note"></p>
            <div class="task-chat-start-attachments-list"></div>
          </div>
          <p class="task-chat-start-note" role="status" hidden></p>
          <div class="task-chat-start-actions">
            <button type="button" class="task-chat-start-cancel"></button>
            <button type="button" class="task-chat-start-go"></button>
          </div>
        </section>
        <div class="task-chat-messages" role="log" aria-live="polite"></div>
      </div>
      <footer class="task-chat-footer">
        <button type="button" class="task-chat-jump" hidden>${ICON_DOWN}<span></span></button>
        <div class="task-chat-composer">
          <textarea class="task-chat-input" rows="1"></textarea>
          <div class="task-chat-actions">
            <div class="task-chat-embed-slot">${embedMenuHtml({ label: '' })}</div>
            <div class="task-chat-selector-slot"></div>
            <span class="task-chat-hint"></span>
            <span class="task-chat-upload-status" role="status" hidden></span>
            <button type="button" class="btn-chat-send task-chat-send">${ICON_SEND}<span></span></button>
            <button type="button" class="btn-chat-stop task-chat-stop" hidden>${ICON_STOP}<span></span></button>
          </div>
        </div>
      </footer>
    </div>`;
  (host || document.body).appendChild(root);

  if (!host) {
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.paddingRight = scrollbarWidth + 'px';
    document.documentElement.style.overflowY = 'hidden';
    // Lifts the Task Edit Modal (opened from a task widget) above this window — see styles.css.
    document.body.classList.add('task-chat-open');
    root.querySelector('.task-chat-backdrop').addEventListener('click', close);
    root.querySelector('.task-chat-close').addEventListener('click', close);
  }

  const input = root.querySelector('.task-chat-input');
  input.value = readDraft(chat.draftKey);
  root.querySelector('.task-chat-send').addEventListener('click', sendMessage);
  root.querySelector('.task-chat-stop').addEventListener('click', stopTurn);
  root.querySelector('.task-chat-jump').addEventListener('click', () => scrollToBottom(true));
  // Cancel at the gate closes the window (embedded: the workspace goes back to Edit — its
  // onOpenTask with this task's own key). The socket only ever held a pending session, which
  // the server drops on close — no start frame went out, so nothing was spawned.
  root.querySelector('.task-chat-start-cancel').addEventListener('click', () => {
    if (embedded && embedded.onOpenTask && chat) embedded.onOpenTask(chat.key);
    else close();
  });
  root.querySelector('.task-chat-start-go').addEventListener('click', beginChat);

  input.addEventListener('input', () => { rememberDraft(); growInput(); syncComposer(); syncGateAttachments(); });
  wireAttachments(input);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  });

  const scroller = root.querySelector('.task-chat-scroll');
  scroller.addEventListener('scroll', () => {
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_THRESHOLD_PX;
    if (stickToBottom) root.querySelector('.task-chat-jump').hidden = true;
  });

  if (!host) {
    // Capture phase, and only while this window is the top dialog layer: with the Task Edit Modal
    // or a confirm open above it, Escape belongs to that layer and must not also close the chat.
    // An open Embed menu takes Escape for itself (embed-menu.js).
    const embedMenuOpen = () => !!(root && root.querySelector('.embed-menu-wrap .import-submenu'));
    keyHandler = (e) => { if (e.key === 'Escape' && focusHandle && focusHandle.isTop() && !embedMenuOpen()) close(); };
    document.addEventListener('keydown', keyHandler, true);
  }
  providersHandler = (e) => {
    const list = e && e.detail && e.detail.objectiveProviders;
    if (Array.isArray(list)) applyProviders(list);
  };
  document.addEventListener('tiptask:providers-changed', providersHandler);
  // The project language can change under an open window (Settings dispatches tiptask:reload
  // after setLocale); every other reload leaves the locale alone and is a no-op here.
  reloadHandler = () => relabel();
  document.addEventListener('tiptask:reload', reloadHandler);

  // The composer is hidden until the chat is known to exist or has been started (dialog-focus
  // skips a hidden target), so Close takes focus while connecting; focusComposer() moves it on.
  if (!host) focusHandle = activateDialogFocus({ root, initialFocus: () => input });
  applyChromeLabels();
  renderSelector();
  renderTranscript();
  growInput();
  syncComposer();
}

function rememberDraft() {
  const input = root && root.querySelector('.task-chat-input');
  if (!chat || !input) return;
  if (input.value) {
    composerDrafts.set(chat.draftKey, input.value);
    try { localStorage.setItem(chat.draftKey, input.value); } catch { /* storage unavailable */ }
  } else {
    clearDraft();
  }
}

function readDraft(key) {
  if (composerDrafts.has(key)) return composerDrafts.get(key);
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function clearDraft() {
  if (!chat) return;
  composerDrafts.delete(chat.draftKey);
  try { localStorage.removeItem(chat.draftKey); } catch { /* storage unavailable */ }
}

// The window's fixed labels, written when it is built and again when the language changes.
function applyChromeLabels() {
  if (!root) return;
  const q = sel => root.querySelector(sel);
  const name = (el, text) => { el.title = text; el.setAttribute('aria-label', text); };
  const project = isProjectChat();
  const eyebrow = q('.task-chat-eyebrow-text');
  if (eyebrow) eyebrow.textContent = t(project ? 'taskChat.projectEyebrow' : 'taskChat.eyebrow');
  const title = q('.task-chat-title-text');
  if (project && title) {
    title.textContent = chatTitle();
    title.title = chatTitle();
  }
  const closeBtn = q('.task-chat-close');
  if (closeBtn) name(closeBtn, t('btn.close'));
  if (embedded) root.setAttribute('aria-label', t(project ? 'taskChat.projectEyebrow' : 'taskChat.eyebrow'));
  q('.task-chat-jump span').textContent = t('taskChat.jumpToLatest');
  const input = q('.task-chat-input');
  const placeholder = t(project ? 'taskChat.project.placeholder' : 'taskChat.placeholder');
  input.placeholder = placeholder;
  input.setAttribute('aria-label', placeholder);
  q('.task-chat-hint').textContent = t('taskChat.hint');
  q('.task-chat-send span').textContent = t('taskChat.send');
  q('.task-chat-stop').title = t('tooltip.stop');
  q('.task-chat-stop span').textContent = t('btn.stop');
  q('.task-chat-start-title').textContent = t('taskChat.start.title');
  q('.task-chat-start-lead').textContent = project
    ? t('taskChat.start.projectLead', { project: projectLabel() })
    : t('taskChat.start.taskLead', { key: chat.key });
  q('.task-chat-start-cancel').textContent = t('btn.cancel');
  for (const trigger of root.querySelectorAll('.embed-menu-trigger')) {
    trigger.querySelector('.embed-menu-label').textContent = t('taskChat.embed.button');
    trigger.title = t('taskChat.embed.tooltip');
    trigger.setAttribute('aria-label', t('taskChat.embed.button'));
  }
  q('.task-chat-start-attachments-note').textContent = t('taskChat.embed.queued');
  q('.task-chat-panel').dataset.dropLabel = t('taskChat.embed.drop');
  syncStartGate();
  renderedLocale = getLocale();
}

// The project's name, else its id.
function projectLabel() {
  if (!chat) return '';
  return chat.projectName || `#${chat.key}`;
}

// A project chat's heading: its summary title once the first message named it, else the project.
function chatTitle() {
  if (!chat) return '';
  return chat.title || projectLabel();
}

// The server named this project chat from its first user message (or a reattach carried the
// name): show it, stop treating the chat as the project's draft, and list it in the left menu.
function applyProjectChatTitle(title) {
  const text = String(title || '').trim();
  if (!isProjectChat() || !text) return;
  const changed = chat.title !== text;
  chat.title = text;
  forgetDraftChat(chat.key, chat.sessionId);
  const el = root && root.querySelector('.task-chat-title-text');
  if (el) { el.textContent = text; el.title = text; }
  if (changed) refreshSessionsNav(true);
}

// Language switched while the window is open: rewrite the fixed labels and rebuild the
// transcript from state, which re-translates author names, widget captions and the model label.
// Notices already shown keep the language they were written in.
function relabel() {
  if (!root || getLocale() === renderedLocale) return;
  applyChromeLabels();
  renderSelector();
  renderTranscript();
}

async function loadTaskTitle(key) {
  let title = '';
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(key)}`, { headers: projectHeader() });
    if (res.ok) title = ((await res.json()) || {}).title || '';
  } catch { /* the key alone still identifies the chat */ }
  if (!chat || chat.kind !== 'task' || chat.key !== key || !root) return;
  const el = root.querySelector('.task-chat-title-text'); // none when embedded

  if (el) { el.textContent = title; el.title = title; }
}

// ── Model selector ──

function readStoredSelection() {
  try { return localStorage.getItem(MODEL_STORAGE_KEY) || ''; } catch { return ''; }
}

// `serverSelection` is passed only when attaching to an existing session, where the server's
// provider is the one the conversation is actually running on.
function applyProviders(list, serverSelection = '') {
  providers = taskChatProviders(list);
  selection = pickSelection({
    providers,
    serverSelection,
    stored: selection || readStoredSelection(),
    fallback: state.objectiveModel,
  });
  renderSelector();
}

// Two selects drive the one `selection`: the composer's, and the start gate's.
const SELECTOR_SLOTS = [
  ['.task-chat-selector-slot', 'task-chat-model-select'],
  ['.task-chat-start-model', 'task-chat-start-model-select'],
];

function renderSelector() {
  if (!root) return;
  const options = buildModelOptionsHtml(providers, selection, modelLabel);
  for (const [slotSel, id] of SELECTOR_SLOTS) {
    const slot = root.querySelector(slotSel);
    if (!slot) continue;
    if (!options) { slot.innerHTML = ''; continue; }
    slot.innerHTML = `<div class="chat-model-selector"><label for="${id}">${escapeAttr(t('field.model'))}</label>`
      + `<select id="${id}"${running ? ' disabled' : ''}>${options}</select></div>`;
    const select = slot.querySelector('select');
    // Nothing matched `selection` (model no longer offered): adopt what the select fell back to.
    if (select.value && select.value !== selection) selection = select.value;
    select.addEventListener('change', () => setSelection(select.value));
  }
  syncStartGate();
}

function setSelection(value) {
  selection = value;
  try { localStorage.setItem(MODEL_STORAGE_KEY, selection); } catch { /* private mode */ }
  for (const [, id] of SELECTOR_SLOTS) {
    const select = root && root.querySelector(`#${id}`);
    if (select && select.value !== value) select.value = value;
  }
  syncStartGate();
}

// ── Start gate ──
// A socket that connected with no session behind it (the `config` frame came without a
// `chat-history-reset`) shows the gate: model choice, Start, Cancel. Only Start sends the start
// frame, at most once per socket, carrying the chosen model for the first turn.

function showStartGate() {
  awaitingStart = true;
  starting = false;
  syncStartGate();
  syncEmptyState();
  syncComposer();
  const go = root && root.querySelector('.task-chat-start-go');
  if (go && !go.disabled) go.focus({ preventScroll: true });
}

function syncStartGate() {
  if (!root) return;
  const gate = root.querySelector('.task-chat-start');
  gate.hidden = !awaitingStart;
  root.querySelector('.task-chat-panel').classList.toggle('task-chat-panel--gated', awaitingStart);
  const go = gate.querySelector('.task-chat-start-go');
  go.textContent = t(starting ? 'taskChat.start.starting' : 'taskChat.start.button');
  go.disabled = !awaitingStart || starting || !connected || noUsableModel();
  const note = gate.querySelector('.task-chat-start-note');
  note.hidden = !noUsableModel();
  note.textContent = noUsableModel() ? t('taskChat.start.noModels') : '';
  syncGateAttachments();
}

// Providers were offered but none of them can run a chat. With no provider list at all the start
// frame goes out without `model` and the server applies its own default.
function noUsableModel() {
  return providers.length > 0 && !selection;
}

function beginChat() {
  if (!awaitingStart || starting || !connected || !ws || noUsableModel()) return;
  starting = true;
  awaitingStart = false;
  syncStartGate();
  pushMessage({ role: 'assistant', content: '', streaming: true });
  setRunning(true);
  sendStartFrame();
  focusComposer();
}

// Hand focus to the input once the composer shows, unless the user already moved it elsewhere.
function focusComposer() {
  const input = root && root.querySelector('.task-chat-input');
  if (!input || !input.getClientRects().length) return;
  const active = document.activeElement;
  if (!active || active === document.body || !root.contains(active) || active.closest('.task-chat-start, .task-chat-header')) {
    input.focus({ preventScroll: true });
  }
}

function sendStartFrame() {
  const type = isProjectChat() ? WS_SEND_TYPES.START_PROJECT_CHAT : WS_SEND_TYPES.START_TASK_CHAT;
  wsSend(ws, type, { model: selection || undefined });
}

// ── Transcript ──

function listEl() { return root ? root.querySelector('.task-chat-messages') : null; }

function renderTranscript() {
  const list = listEl();
  if (!list) return;
  list.innerHTML = '';
  for (const m of messages) list.appendChild(buildMessageEl(m));
  syncEmptyState();
  syncDialogWidgets();
  scrollToBottom(true);
}

function syncEmptyState() {
  const list = listEl();
  if (!list) return;
  let empty = list.querySelector('.task-chat-empty');
  // The start gate stands in for the empty state.
  if (messages.length || awaitingStart) { if (empty) empty.remove(); return; }
  if (!empty) {
    empty = document.createElement('div');
    empty.className = 'task-chat-empty';
    list.appendChild(empty);
  }
  if (!connected) empty.textContent = t('taskChat.connecting');
  else empty.textContent = t(isProjectChat() ? 'taskChat.project.empty' : 'taskChat.empty');
}

function buildMessageEl(m) {
  const el = document.createElement('div');
  el.className = `task-chat-msg task-chat-msg--${m.role}${m.error ? ' task-chat-msg--error' : ''}`;
  if (m.role === 'assistant') {
    el.innerHTML = `<div class="task-chat-author">${escapeAttr(t('taskChat.assistant'))}</div>`
      + '<div class="task-chat-body task-chat-md"></div>'
      // Slot for the interactive dialog / tool / task widgets of this turn.
      + '<div class="task-chat-widgets"></div>'
      + '<div class="task-chat-status" hidden></div>';
  } else {
    el.innerHTML = '<div class="task-chat-body"></div>';
    const body = el.querySelector('.task-chat-body');
    // A user turn shows its attachments as thumbnails and chips; a notice is plain text.
    if (m.role === 'user') body.innerHTML = userMessageHtml(m.content, { t });
    else body.textContent = m.content;
    if (m.retry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'task-chat-retry';
      btn.textContent = t('btn.retry');
      btn.addEventListener('click', m.retry);
      el.appendChild(btn);
    }
  }
  m.el = el;
  if (m.role === 'assistant') { paintAssistant(m); paintWidgets(m); }
  return el;
}

// The reply text without its `ask_user` fence — the dialog widget stands in for it.
function assistantMarkdown(m) {
  return stripAskUserFence(m.content);
}

function paintAssistant(m) {
  const body = m.el && m.el.querySelector('.task-chat-body');
  if (!body) return;
  const md = assistantMarkdown(m);
  if (md) {
    body.innerHTML = renderMarkdown(md, { cache: !m.streaming });
  } else if (m.streaming) {
    body.innerHTML = '<span class="chat-typing-indicator"><span></span><span></span><span></span></span>';
  } else {
    body.textContent = '';
  }
  // A reply that is only widgets (a dialog, a task card) has no text row to show.
  body.hidden = !md && !m.streaming;
  m.el.classList.toggle('task-chat-msg--streaming', !!m.streaming);
}

function pushMessage(m) {
  const entry = { dialogs: [], tools: [], taskEvents: [], ...m };
  messages.push(entry);
  const list = listEl();
  if (list) {
    syncEmptyState();
    list.appendChild(buildMessageEl(entry));
    scrollToBottom(entry.role === 'user');
  }
  syncDialogWidgets();
  return entry;
}

function removeMessage(m) {
  const i = messages.indexOf(m);
  if (i >= 0) messages.splice(i, 1);
  if (m.el) m.el.remove();
  syncEmptyState();
  syncDialogWidgets();
}

function pushNotice(text, { error = false, retry = null } = {}) {
  return pushMessage({ role: 'system', content: text, error, retry });
}

function streamingMessage() {
  return messages.findLast(m => m.role === 'assistant' && m.streaming) || null;
}

function ensureStreaming() {
  return streamingMessage() || pushMessage({ role: 'assistant', content: '', streaming: true });
}

// The assistant message widget frames belong to: the running turn, else the latest reply
// (a task read-back can arrive just after its turn closed).
function widgetTarget() {
  return streamingMessage() || messages.findLast(m => m.role === 'assistant') || null;
}

// Re-render the streaming reply at most once per frame, however many chunks arrive.
function schedulePaint() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    const m = streamingMessage();
    if (m) { paintAssistant(m); scrollToBottom(false); }
  });
}

function setStatus(text) {
  const m = streamingMessage();
  const el = m && m.el && m.el.querySelector('.task-chat-status');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
  scrollToBottom(false);
}

function finishStreaming(finalContent) {
  const m = streamingMessage();
  if (!m) return null;
  if (typeof finalContent === 'string' && finalContent) m.content = finalContent;
  m.streaming = false;
  const status = m.el && m.el.querySelector('.task-chat-status');
  if (status) { status.hidden = true; status.textContent = ''; }
  if (!assistantMarkdown(m) && !hasWidgets(m)) { removeMessage(m); return null; }
  paintAssistant(m);
  scrollToBottom(false);
  return m;
}

function scrollToBottom(force) {
  const scroller = root && root.querySelector('.task-chat-scroll');
  if (!scroller) return;
  if (force) stickToBottom = true;
  const jump = root.querySelector('.task-chat-jump');
  if (stickToBottom) {
    scroller.scrollTop = scroller.scrollHeight;
    jump.hidden = true;
  } else {
    jump.hidden = false;
  }
}

// ── Widgets ──
// Each assistant message has a `.task-chat-widgets` slot holding, in this order, the turn's tool
// chips, the cards of the tasks it created or updated, and the dialogs it asked.

const WIDGET_GROUPS = ['task-chat-tools', 'task-chat-tasks', 'task-chat-dialogs'];

function fromHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content.firstElementChild;
}

function widgetGroup(slot, cls) {
  let el = slot.querySelector(`:scope > .${cls}`);
  if (el) return el;
  el = document.createElement('div');
  el.className = cls;
  const after = WIDGET_GROUPS.slice(WIDGET_GROUPS.indexOf(cls) + 1)
    .map(c => slot.querySelector(`:scope > .${c}`)).find(Boolean);
  slot.insertBefore(el, after || null);
  return el;
}

// Reconcile one group with its records `[{ id, sig, record }]`. An element whose record did not
// change is kept as it is, so an expanded chip or a half-filled dialog survives later frames.
function syncWidgetGroup(slot, cls, items, build) {
  if (!items.length && !slot.querySelector(`:scope > .${cls}`)) return;
  const group = widgetGroup(slot, cls);
  const old = new Map([...group.children].map(el => [el.dataset.widgetId, el]));
  let prev = null;
  for (const item of items) {
    const id = String(item.id);
    let el = old.get(id);
    if (!el || widgetSig.get(el) !== item.sig) {
      const next = build(item.record, el);
      if (!next) continue;
      next.dataset.widgetId = id;
      widgetSig.set(next, item.sig);
      if (el) el.replaceWith(next);
      el = next;
    }
    old.delete(id);
    const want = prev ? prev.nextSibling : group.firstChild;
    if (el !== want) group.insertBefore(el, want);
    prev = el;
  }
  for (const el of old.values()) el.remove();
  if (!group.children.length) group.remove();
}

function paintWidgets(m) {
  const slot = m.el && m.el.querySelector('.task-chat-widgets');
  if (!slot) return;
  syncWidgetGroup(slot, 'task-chat-tools',
    (m.tools || []).filter(tool => tool && tool.id != null).map(tool => ({ id: tool.id, sig: JSON.stringify(tool), record: tool })),
    renderToolChip);
  syncWidgetGroup(slot, 'task-chat-tasks',
    collapseTaskEvents(m.taskEvents).map(entry => ({ id: entry.id, sig: JSON.stringify([entry.action, entry.task]), record: entry })),
    renderTaskWidget);
  // A dialog is built once (sig = its id); its open / answered state is synced separately.
  syncWidgetGroup(slot, 'task-chat-dialogs',
    (m.dialogs || []).filter(dialog => dialog && dialog.id != null).map(dialog => ({ id: dialog.id, sig: String(dialog.id), record: dialog })),
    dialog => renderDialogWidget(m, dialog));
}

// A tool call as a chip: what it read or wrote. One with arguments or an error expands.
function renderToolChip(tool, previous) {
  const open = !!(previous && previous.classList.contains('task-chat-widget--open'));
  const el = fromHtml(toolChipHtml(tool, { t, open }));
  const button = el.querySelector('button.task-chat-tool-chip');
  const detail = el.querySelector('.task-chat-tool-detail');
  if (button && detail) {
    button.addEventListener('click', () => {
      const expand = detail.hidden;
      detail.hidden = !expand;
      button.setAttribute('aria-expanded', expand ? 'true' : 'false');
      el.classList.toggle('task-chat-widget--open', expand);
      scrollToBottom(false);
    });
  }
  return el;
}

// A task the agent created or updated, drawn with the board's own card in its inert `preview`
// form. Click / Enter / Space opens the Task Edit Modal above this window.
function renderTaskWidget(entry) {
  const key = String(entry.id);
  const task = {
    ...entry.task,
    id: entry.task.id || key,
    title: entry.task.title || key,
    description: entry.task.description || '',
    tags: entry.task.tags || [],
    dependencies: entry.task.dependencies || [],
  };
  const el = document.createElement('div');
  el.className = 'task-chat-widget task-chat-widget--task';
  el.dataset.action = entry.action;
  el.dataset.taskKey = key;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  const label = t('taskChat.task.open', { key });
  el.title = label;
  el.setAttribute('aria-label', label);
  let cardHtml;
  try {
    cardHtml = renderCard(task, { preview: true });
  } catch {
    // The board's status registry is not ready (or the task is malformed): key and title only.
    cardHtml = `<div class="task-chat-task-fallback"><span class="task-chat-key">${escapeAttr(key)}</span> ${escapeAttr(task.title)}</div>`;
  }
  el.innerHTML = `<span class="task-chat-task-badge">${escapeAttr(t(entry.action === 'created' ? 'taskChat.task.created' : 'taskChat.task.updated'))}</span>${cardHtml}`;
  const open = () => openTaskFromChat(key, el);
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); }
  });
  return el;
}

// Editable, without the footer actions (Start, Reiterate, Delete): each opens a terminal or a
// board dialog underneath this window. A save is reported to the server, which tells the agent
// about it with the next user turn.
function openTaskFromChat(key, trigger) {
  if (embedded && embedded.onOpenTask) { embedded.onOpenTask(key); return; }
  const chatId = chat && chat.sessionId;
  const socket = ws;
  Promise.resolve(openTaskEditModal(key, {
    trigger,
    hideActions: true,
    onSaved: () => {
      if (chat && chat.sessionId === chatId && ws === socket && connected) {
        wsSend(ws, WS_SEND_TYPES.TASK_CHAT_TASK_EDITED, { taskKey: key });
      }
    },
  })).catch((err) => console.warn('[task-chat] Could not open task', key, err));
}

// open / waiting / answered / skipped — the rule is dialogState() in task-chat-model.js.
function widgetState(m, dialog) {
  return dialogState({ messages, message: m, dialog, connected, running });
}

function readDialog(el, dialog) {
  const toggles = [...el.querySelectorAll('.task-chat-dialog-options input:checked:not(.task-chat-dialog-other)')];
  const otherOn = toggles.some(input => input.value === 'other');
  return dialogSubmission(dialog, {
    picked: toggles.filter(input => input.value !== 'other').map(input => Number(input.value)),
    other: otherOn ? el.querySelector('.task-chat-dialog-other').value : '',
  });
}

function applyDialogState(el, m, dialog) {
  const state = widgetState(m, dialog);
  el.dataset.state = state;
  el.disabled = state !== 'open';
  const submit = el.querySelector('.task-chat-dialog-submit');
  const caption = el.querySelector('.task-chat-dialog-state');
  if (state === 'answered') {
    const picked = new Set(Array.isArray(dialog.answer.indexes) ? dialog.answer.indexes : []);
    const free = dialog.answer.other || '';
    for (const input of el.querySelectorAll('.task-chat-dialog-options input:not(.task-chat-dialog-other)')) {
      input.checked = input.value === 'other' ? !!free : picked.has(Number(input.value));
    }
    el.querySelector('.task-chat-dialog-other').value = free;
  }
  caption.textContent = state === 'answered' ? t('taskChat.dialog.answered') : (state === 'skipped' ? t('taskChat.dialog.skipped') : '');
  submit.hidden = state === 'answered' || state === 'skipped';
  submit.disabled = state !== 'open' || !readDialog(el, dialog);
}

// The agent's question as a form: one option per row (radio or checkbox), a free-text Other,
// and Submit. Answering locks it and becomes the next user turn.
function renderDialogWidget(m, dialog) {
  const el = fromHtml(dialogWidgetHtml(dialog, { t, name: `task-chat-dlg-${++widgetSeq}` }));
  if (!el) return null;
  // A re-sent frame replaces the record in m.dialogs (upsertById) while this element is kept:
  // read and answer the current one, the record syncDialogWidgets() checks.
  const current = () => (m.dialogs || []).find(d => d && String(d.id) === String(dialog.id)) || dialog;
  const other = el.querySelector('.task-chat-dialog-other');
  const otherToggle = el.querySelector('.task-chat-dialog-options input[value="other"]');
  const submit = el.querySelector('.task-chat-dialog-submit');
  const sync = () => { submit.disabled = el.disabled || !readDialog(el, current()); };
  el.addEventListener('change', (e) => {
    if (e.target === otherToggle && otherToggle.checked) other.focus();
    sync();
  });
  other.addEventListener('input', () => {
    if (other.value.trim()) otherToggle.checked = true;
    sync();
  });
  other.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitDialog(el, m, current()); }
  });
  submit.addEventListener('click', () => submitDialog(el, m, current()));
  applyDialogState(el, m, dialog);
  return el;
}

function submitDialog(el, m, dialog) {
  if (!ws || widgetState(m, dialog) !== 'open') return;
  const submission = readDialog(el, dialog);
  if (!submission) return;
  wsSend(ws, WS_SEND_TYPES.TASK_CHAT_ANSWER, { ...submission, model: selection || undefined });
  // The server stores the same answer and starts the turn; show both right away.
  dialog.answer = localAnswer(dialog, submission);
  const userMsg = pushMessage({ role: 'user', content: answerSummary(dialog.answer), dialogAnswer: { dialogId: dialog.id } });
  pushMessage({ role: 'assistant', content: '', streaming: true });
  pendingAnswer = { dialog, userMsg };
  setRunning(true);
}

function syncDialogWidgets() {
  for (const m of messages) {
    if (!m.el || !Array.isArray(m.dialogs) || !m.dialogs.length) continue;
    for (const el of m.el.querySelectorAll('.task-chat-dialogs > .task-chat-widget--dialog')) {
      const dialog = m.dialogs.find(d => String(d.id) === el.dataset.widgetId);
      if (dialog) applyDialogState(el, m, dialog);
    }
  }
}

// The server refused the answer before starting a turn (bad pick, dialog no longer open, model
// unavailable): take the optimistic turn back and re-open the dialog.
function revertPendingAnswer() {
  const pending = pendingAnswer;
  pendingAnswer = null;
  if (!pending) return false;
  const partial = streamingMessage();
  if (partial) removeMessage(partial);
  delete pending.dialog.answer;
  removeMessage(pending.userMsg);
  return true;
}

// The user saved a task from one of this chat's cards: redraw every card of it.
function applyEditedTask(task) {
  for (const m of messages) {
    let touched = false;
    for (const event of m.taskEvents || []) {
      if (event.task && event.task.id === task.id) { event.task = task; touched = true; }
    }
    if (touched) paintWidgets(m);
  }
}

// ── Composer ──

// ── Attachments ──
// The objective chat's Embed control (embed-menu.js), clipboard image paste (task-board.js
// attachImagePaste) and file drop, all inserting their markdown reference into the composer
// textarea — so the reference is part of the `task-chat-message` content. The start gate has the
// same Embed control, and the drop target is the whole panel: anything attached before Start
// waits in the composer draft for the first message.

function wireAttachments(input) {
  const gen = ++uploadGen;
  const live = () => gen === uploadGen && !!root;
  const started = () => {
    if (!live()) return;
    uploadsPending++;
    syncComposer();
    syncGateAttachments();
  };
  const settled = () => {
    if (!live()) return;
    uploadsPending = Math.max(0, uploadsPending - 1);
    if (!uploadsPending) {
      // A failed image upload leaves its blob placeholder behind.
      const cleaned = stripPendingImageRefs(input.value);
      if (cleaned !== input.value) { input.value = cleaned; rememberDraft(); growInput(); }
    }
    syncComposer();
    syncGateAttachments();
  };
  const imageOpts = {
    // A task chat links its images to the task, as the spec chat does.
    taskKey: chat && chat.kind === 'task' ? chat.key : null,
    onFileDetected: started,
    onUploaded: settled,
    onUploadError: (file, err) => {
      if (live()) {
        const name = (file && file.name) || t('taskChat.embed.image');
        showToast(t('taskChat.embed.error', { name, msg: (err && err.message) || '' }), 'error');
      }
      settled();
    },
  };
  // uploadAttachmentFile() shows its own progress and error toasts and never rejects.
  const onFileUpload = (upload) => {
    if (!live()) return;
    started();
    Promise.resolve(upload).then(settled, settled);
  };
  const labels = {
    image: () => t('taskChat.embed.image'),
    file: () => t('taskChat.embed.file'),
    fileTitle: () => t('taskChat.embed.fileTooltip'),
  };
  attachImagePaste(input, null, imageOpts);
  for (const wrap of root.querySelectorAll('.embed-menu-wrap')) {
    attachEmbedMenu(wrap, input, { imageOpts, onFileUpload, labels });
  }
  attachFileDrop(root.querySelector('.task-chat-panel'), input, { imageOpts, onFileUpload, activeClass: 'task-chat-panel--drop' });
}

// At the start gate the composer is hidden: show what is attached and waiting in its draft.
function syncGateAttachments() {
  if (!root) return;
  const box = root.querySelector('.task-chat-start-attachments');
  const input = root.querySelector('.task-chat-input');
  if (!box || !input) return;
  const { attachments } = splitAttachmentRefs(input.value);
  box.hidden = !awaitingStart || (!attachments.length && !uploadsPending);
  const list = box.querySelector('.task-chat-start-attachments-list');
  const html = attachmentsHtml(attachments, { t });
  if (list.dataset.sig !== html) { list.innerHTML = html; list.dataset.sig = html; }
}

function growInput() {
  const input = root && root.querySelector('.task-chat-input');
  if (input) autoGrowTextarea(input, Math.round(window.innerHeight * 0.3));
}

function setRunning(value) {
  running = !!value;
  syncComposer();
  syncDialogWidgets();
}

// Every change of the socket state repaints the dialogs too: a reattach restores the history
// (and closes a finished turn) before its `config` frame, so its dialogs are built `waiting`.
function setConnected(value) {
  connected = !!value;
  syncComposer();
  syncDialogWidgets();
}

function syncComposer() {
  if (!root) return;
  const input = root.querySelector('.task-chat-input');
  const send = root.querySelector('.task-chat-send');
  const stop = root.querySelector('.task-chat-stop');
  const select = root.querySelector('#task-chat-model-select');
  send.hidden = running;
  stop.hidden = !running;
  if (!running) stop.disabled = false;
  send.disabled = !connected || running || awaitingStart || uploadsPending > 0 || !input.value.trim();
  const uploading = root.querySelector('.task-chat-upload-status');
  uploading.hidden = uploadsPending === 0;
  uploading.textContent = uploadsPending ? t('taskChat.embed.uploading') : '';
  root.querySelector('.task-chat-hint').hidden = uploadsPending > 0;
  if (select) select.disabled = running;
  // No composer until there is a chat to type into: while the first connect is still deciding
  // between restore and the start gate, and while the gate is up.
  root.querySelector('.task-chat-panel').classList.toggle('task-chat-panel--connecting', !connected && !messages.length);
  // Keep assistive tech from announcing every streamed re-render; the finished reply is read once.
  root.querySelector('.task-chat-messages').setAttribute('aria-busy', running ? 'true' : 'false');
  root.querySelector('.task-chat-panel').classList.toggle('task-chat-panel--running', running);
}

function sendMessage() {
  if (!root || !connected || running || awaitingStart || uploadsPending > 0 || ws?.readyState !== WebSocket.OPEN) return;
  const input = root.querySelector('.task-chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  growInput();
  pushMessage({ role: 'user', content: text });
  pushMessage({ role: 'assistant', content: '', streaming: true });
  setRunning(true);
  wsSend(ws, WS_SEND_TYPES.TASK_CHAT_MESSAGE, { content: text, model: selection || undefined });
  clearDraft();
}

function stopTurn() {
  if (!running) return;
  root.querySelector('.task-chat-stop').disabled = true;
  wsSend(ws, WS_SEND_TYPES.ABORT, {});
}

// ── Connection ──

function detachSocket() {
  if (!ws) return;
  const old = ws;
  ws = null;
  old.onopen = old.onmessage = old.onerror = old.onclose = null;
  try { old.close(); } catch { /* already closed */ }
}

function connect() {
  detachSocket();
  setConnected(false);
  sawReset = false;
  ended = false;
  resetSelection = '';
  pendingAnswer = null;
  awaitingStart = false;
  starting = false;
  syncStartGate();
  const socket = new WebSocket(buildWsUrl(chat.sessionId));
  ws = socket;
  socket.onmessage = (event) => {
    if (ws !== socket) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleFrame(msg);
  };
  socket.onerror = () => {};
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setConnected(false);
    // A gate on a dead socket cannot start anything; the notice below offers the reconnect.
    awaitingStart = false;
    syncStartGate();
    finishStreaming();
    setRunning(false);
    // After `chat-ended` the transcript already says why the socket went away.
    if (root && !ended) pushNotice(t('taskChat.error.disconnected'), { error: true, retry: reconnect });
  };
  syncEmptyState();
  syncComposer();
}

function reconnect() {
  messages = [];
  setRunning(false);
  renderTranscript();
  connect();
}

// Drop the server session (if any) and begin a new chat. The kill is confirmed by
// `chat-ended` before reconnecting, so the new socket cannot race onto the old session.
function startFresh() {
  wantFresh = true;
  messages = [];
  setRunning(false);
  renderTranscript();
  if (ws && ws.readyState === WebSocket.OPEN && sawReset) {
    wsSend(ws, WS_SEND_TYPES.KILL, {});
    clearTimeout(freshTimer);
    freshTimer = setTimeout(() => { if (wantFresh && root) connect(); }, FRESH_START_TIMEOUT_MS);
  } else {
    connect();
  }
}

const PROGRESS_KEYS = {
  spawned: 'taskChat.status.starting',
  'cli-init': 'taskChat.status.initializing',
  'model-thinking': 'taskChat.status.thinking',
  working: 'taskChat.status.working',
  'pi-retry': 'taskChat.status.retrying',
  'pi-compaction': 'taskChat.status.compacting',
};

function turnFailed(text) {
  // No completed reply yet means the chat never got going (start refused, first turn died, or
  // the session is gone) — there is nothing to continue, so retrying starts a new chat.
  const established = messages.some(m => m.role === 'assistant' && !m.streaming);
  finishStreaming();
  setRunning(false);
  pushNotice(text, { error: true, retry: established ? null : startFresh });
}

// Frames that can only come from a turn that started — the answer that began it was accepted.
const TURN_FRAMES = new Set([
  WS_RECV_TYPES.DATA, 'objective-progress', 'objective-thinking', 'objective-retry',
  WS_RECV_TYPES.OBJECTIVE_RESULT, WS_RECV_TYPES.CHAT_READY, WS_RECV_TYPES.EXIT,
  WS_RECV_TYPES.TASK_CHAT_DIALOG, WS_RECV_TYPES.TASK_CHAT_TOOL, WS_RECV_TYPES.TASK_CHAT_TASK,
]);

function handleFrame(msg) {
  if (pendingAnswer && TURN_FRAMES.has(msg.type)) pendingAnswer = null;
  switch (msg.type) {
    case WS_RECV_TYPES.CHAT_HISTORY_RESET: {
      sawReset = true;
      resetSelection = msg.objectiveSelection || '';
      // History without even the generated seed is a session that cannot continue.
      if (!msg.running && !(Array.isArray(msg.messages) && msg.messages.length)) wantFresh = true;
      messages = visibleHistory(msg.messages);
      if (msg.title) applyProjectChatTitle(msg.title);
      if (msg.running) messages.push({ role: 'assistant', content: '', streaming: true, dialogs: [], tools: [], taskEvents: [] });
      running = !!msg.running;
      renderTranscript();
      break;
    }

    // Last frame of every connect, fresh or reattached — the point where both are known.
    case 'config': {
      setConnected(true);
      applyProviders(
        Array.isArray(msg.objectiveProviders) ? msg.objectiveProviders : providers,
        sawReset ? resetSelection : '',
      );
      if (wantFresh && sawReset) {
        startFresh();
        break;
      }
      syncEmptyState();
      syncComposer();
      if (!sawReset) {
        // No session behind this socket: wait for the user's model choice and Start.
        wantFresh = false;
        clearTimeout(freshTimer);
        showStartGate();
      } else {
        focusComposer();
      }
      break;
    }

    case WS_RECV_TYPES.DATA: {
      const m = ensureStreaming();
      if (!running) setRunning(true);
      m.content += msg.data || '';
      setStatus('');
      schedulePaint();
      break;
    }

    case 'objective-progress': {
      if (msg.stage === 'tool') setStatus(t('taskChat.status.tool', { tool: shortToolName(msg.name) }));
      else if (PROGRESS_KEYS[msg.stage]) setStatus(t(PROGRESS_KEYS[msg.stage]));
      break;
    }

    case 'objective-thinking': {
      const m = streamingMessage();
      if (m && !m.content) setStatus(t('taskChat.status.thinking'));
      break;
    }

    case 'objective-retry':
      setStatus(t('taskChat.status.retrying'));
      break;

    case WS_RECV_TYPES.OBJECTIVE_RESULT: {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (!finishStreaming(content) && content) {
        // A turn that finished while no window was attached is flushed after the history,
        // which normally holds it already.
        const last = messages.findLast(m => m.role === 'assistant');
        if (!last || last.content !== content) pushMessage({ role: 'assistant', content });
      }
      setRunning(false);
      break;
    }

    case WS_RECV_TYPES.CHAT_READY:
    case WS_RECV_TYPES.EXIT:
      finishStreaming();
      setRunning(false);
      break;

    case WS_RECV_TYPES.GENERATION_ABORTED: {
      pendingAnswer = null;
      const partial = streamingMessage();
      if (partial) removeMessage(partial);
      // The server drops the user message that started the aborted turn; hand its text back.
      const last = lastTurnMessage(messages);
      if (last && last.role === 'user') {
        removeMessage(last);
        if (last.dialogAnswer) {
          // It was a dialog answer: nothing to retype — the dialog itself opens again.
          const asked = lastTurnMessage(messages);
          const dialog = asked && (asked.dialogs || []).find(d => d.id === last.dialogAnswer.dialogId);
          if (dialog) delete dialog.answer;
        } else {
          const input = root.querySelector('.task-chat-input');
          if (!input.value.trim()) { input.value = last.content; rememberDraft(); growInput(); }
        }
      }
      setRunning(false);
      break;
    }

    case WS_RECV_TYPES.RESTARTED:
      messages = [];
      renderTranscript();
      pushMessage({ role: 'assistant', content: '', streaming: true });
      setRunning(true);
      break;

    case WS_RECV_TYPES.TASK_CHAT_DIALOG: {
      const m = widgetTarget();
      if (m && msg.dialog) {
        upsertById(m.dialogs, msg.dialog);
        paintAssistant(m);
        paintWidgets(m);
        scrollToBottom(false);
      }
      break;
    }

    case WS_RECV_TYPES.TASK_CHAT_TOOL: {
      const m = widgetTarget();
      if (!m || !msg.tool) break;
      upsertById(m.tools, msg.tool);
      paintWidgets(m);
      if (msg.tool.status === 'running') {
        setStatus(t('taskChat.status.tool', { tool: shortToolName(msg.tool.tool || msg.tool.name) }));
      } else {
        scrollToBottom(false);
      }
      break;
    }

    case WS_RECV_TYPES.TASK_CHAT_TASK: {
      const m = widgetTarget();
      if (m && msg.task) {
        upsertById(m.taskEvents, { id: msg.toolId, action: msg.action, task: msg.task });
        paintWidgets(m);
        scrollToBottom(false);
      }
      break;
    }

    case WS_RECV_TYPES.TASK_CHAT_TASK_EDITED: {
      if (!msg.task || !msg.task.id) break;
      applyEditedTask(msg.task);
      // `changed` is empty when the save touched nothing the agent reasons about.
      if (Array.isArray(msg.changed) && msg.changed.length) {
        const text = t('taskChat.edit.queued', { key: msg.task.id });
        const last = messages[messages.length - 1];
        if (!last || last.role !== 'system' || last.content !== text) pushNotice(text);
      }
      break;
    }

    case 'objective-error': {
      const reason = msg.reason || 'error';
      let text;
      if (reason === 'session-gone') text = t('taskChat.error.sessionGone');
      else if (reason === 'provider-unavailable' || reason === 'turn-in-progress') text = msg.detail || t('taskChat.error.selection');
      else text = t('taskChat.error.turn', { reason }) + (msg.detail ? ` ${msg.detail}` : '');
      if (reason === 'session-gone') {
        pendingAnswer = null;
        finishStreaming();
        setRunning(false);
        pushNotice(text, { error: true, retry: startFresh });
      } else if ((reason === 'provider-unavailable' || reason === 'turn-in-progress') && revertPendingAnswer()) {
        // Refused before the answer was stored: the dialog is open again for another model.
        setRunning(false);
        pushNotice(text, { error: true });
      } else {
        pendingAnswer = null;
        turnFailed(text);
      }
      break;
    }

    case WS_RECV_TYPES.ERROR:
      if (revertPendingAnswer()) {
        setRunning(false);
        pushNotice(msg.message || t('taskChat.error.turn', { reason: 'error' }), { error: true });
        break;
      }
      turnFailed(msg.message || t('taskChat.error.turn', { reason: 'error' }));
      break;

    case WS_RECV_TYPES.PROJECT_CHAT_TITLED:
      applyProjectChatTitle(msg.title);
      break;

    case WS_RECV_TYPES.CHAT_ENDED:
      clearTimeout(freshTimer);
      if (isProjectChat()) refreshSessionsNav(true);
      if (wantFresh) { connect(); break; }
      ended = true;
      setConnected(false);
      finishStreaming();
      setRunning(false);
      pushNotice(t('taskChat.ended'), { retry: startFresh });
      break;

    case WS_RECV_TYPES.DETACHED: {
      showToast(t('taskChat.detached'));
      const onClosed = embedded && embedded.onClosed;
      close();
      if (onClosed) onClosed();
      break;
    }

    default:
      break;
  }
}
