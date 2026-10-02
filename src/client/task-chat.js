// Task chat window — a conversation with an agent (Claude / Codex / Pi) about one task, or about
// the selected project (no task). Server side: ws-handlers.js `taskChat:<taskKey>` /
// `projectChat:<API_PROJECT_ID>` session (see tt-task-chat.md). The chat lives on the server
// until it is killed, so closing this window only detaches: reopening restores the transcript
// from `chat-history-reset` and picks a running turn back up. A chat with no session yet waits
// behind the start gate: nothing is sent to the server until the user picks a model and Starts.
import { buildWsUrl, wsSend, WS_SEND_TYPES, WS_RECV_TYPES } from './ws-client.js';
import { renderMarkdown, escapeAttr, autoGrowTextarea, projectHeader, showToast } from './utils.js';
import { modelLabel } from './constants.js';
import state from './state.js';
import { showActionConfirm } from './action-confirm.js';
import { activateDialogFocus } from './dialog-focus.js';
import { t, getLocale } from './i18n.js';
import { renderCard } from './task-card.js';
import { openTaskEditModal } from './task-edit-modal.js';
import {
  taskChatProviders, pickSelection, buildModelOptionsHtml, stripAskUserFence,
  visibleHistory, upsertById, shortToolName, hasWidgets, collapseTaskEvents,
  dialogSubmission, localAnswer, answerSummary, dialogWidgetHtml, toolChipHtml,
} from './task-chat-model.js';

const SESSION_PREFIX = 'taskChat:';
const PROJECT_SESSION_PREFIX = 'projectChat:';
// Sticky model choice for this window. Deliberately not the objective chat's key: the two
// chats offer different provider sets and a pick here must not move the planner's default.
const MODEL_STORAGE_KEY = 'tipatask-task-chat-model';
const STICK_THRESHOLD_PX = 64;
const FRESH_START_TIMEOUT_MS = 3000;

const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg>';
const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/><path d="M13 9v6M10 12h6"/></svg>';

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

export async function open(taskId) {
  const key = String(taskId || '').trim();
  if (!key) return;
  openSeq++;
  openChat({ kind: 'task', key, sessionId: SESSION_PREFIX + key, title: '' });
}

// The chat about the project selected in this window, with no task. The id is read from this
// window's own project config (header-scoped) — the one the server checks the session id against.
export async function openProjectChat() {
  const seq = ++openSeq;
  let cfg = {};
  try {
    const res = await fetch('/api/project-config', { headers: projectHeader(), cache: 'no-store' });
    if (res.ok) cfg = ((await res.json()) || {}).config || {};
  } catch { /* no id: reported below */ }
  if (seq !== openSeq) return; // a later open (double click, task chat) superseded this one
  const id = String(cfg.API_PROJECT_ID || '').trim();
  if (!/^[1-9]\d*$/.test(id)) { showToast(t('taskChat.error.noProject'), 'error'); return; }
  openChat({ kind: 'project', key: id, sessionId: PROJECT_SESSION_PREFIX + id, title: String(cfg.projectName || '') });
}

function openChat(target) {
  if (chat) close();
  chat = target;
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
  if (chat.kind === 'task') loadTaskTitle(chat.key);
}

function isProjectChat() {
  return !!chat && chat.kind === 'project';
}

export function close() {
  detachSocket();
  clearTimeout(freshTimer);
  freshTimer = null;
  if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0; }
  if (keyHandler) { document.removeEventListener('keydown', keyHandler, true); keyHandler = null; }
  if (providersHandler) { document.removeEventListener('tiptask:providers-changed', providersHandler); providersHandler = null; }
  if (reloadHandler) { document.removeEventListener('tiptask:reload', reloadHandler); reloadHandler = null; }
  if (root) { root.remove(); root = null; }
  if (focusHandle) { focusHandle.close(); focusHandle = null; }
  document.documentElement.style.overflowY = '';
  document.body.style.paddingRight = '';
  document.body.classList.remove('task-chat-open');
  chat = null;
  messages = [];
  running = false;
  connected = false;
  wantFresh = false;
  awaitingStart = false;
  starting = false;
  pendingAnswer = null;
}

// ── Window ──

function renderWindow() {
  root = document.createElement('div');
  root.className = 'task-chat-modal';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'task-chat-title');
  root.innerHTML = `
    <div class="task-chat-backdrop"></div>
    <div class="task-chat-panel task-chat-panel--connecting">
      <header class="task-chat-header">
        <div class="task-chat-heading">
          <span class="task-chat-eyebrow"><span class="task-chat-dot" aria-hidden="true"></span><span class="task-chat-eyebrow-text"></span></span>
          <div class="task-chat-title" id="task-chat-title">
            ${chat.kind === 'task' ? `<span class="task-chat-key">${escapeAttr(chat.key)}</span>` : ''}
            <span class="task-chat-title-text"></span>
          </div>
        </div>
        <div class="task-chat-header-actions">
          <button type="button" class="task-chat-icon-btn task-chat-new">${ICON_NEW}</button>
          <button type="button" class="task-chat-icon-btn task-chat-close">${ICON_CLOSE}</button>
        </div>
      </header>
      <div class="task-chat-scroll">
        <section class="task-chat-start" aria-labelledby="task-chat-start-title" hidden>
          <span class="task-chat-start-mark">${ICON_CHAT}</span>
          <h2 class="task-chat-start-title" id="task-chat-start-title"></h2>
          <p class="task-chat-start-lead"></p>
          <div class="task-chat-start-model"></div>
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
            <div class="task-chat-selector-slot"></div>
            <span class="task-chat-hint"></span>
            <button type="button" class="btn-chat-send task-chat-send">${ICON_SEND}<span></span></button>
            <button type="button" class="btn-chat-stop task-chat-stop" hidden>${ICON_STOP}<span></span></button>
          </div>
        </div>
      </footer>
    </div>`;
  document.body.appendChild(root);

  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.paddingRight = scrollbarWidth + 'px';
  document.documentElement.style.overflowY = 'hidden';
  // Lifts the Task Edit Modal (opened from a task widget) above this window — see styles.css.
  document.body.classList.add('task-chat-open');

  const input = root.querySelector('.task-chat-input');
  root.querySelector('.task-chat-backdrop').addEventListener('click', close);
  root.querySelector('.task-chat-close').addEventListener('click', close);
  root.querySelector('.task-chat-new').addEventListener('click', startNewChat);
  root.querySelector('.task-chat-send').addEventListener('click', sendMessage);
  root.querySelector('.task-chat-stop').addEventListener('click', stopTurn);
  root.querySelector('.task-chat-jump').addEventListener('click', () => scrollToBottom(true));
  // Cancel at the gate is a plain close: the socket only ever held a pending session, which the
  // server drops on close — no start frame went out, so nothing was spawned.
  root.querySelector('.task-chat-start-cancel').addEventListener('click', close);
  root.querySelector('.task-chat-start-go').addEventListener('click', beginChat);

  input.addEventListener('input', () => { growInput(); syncComposer(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  });

  const scroller = root.querySelector('.task-chat-scroll');
  scroller.addEventListener('scroll', () => {
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_THRESHOLD_PX;
    if (stickToBottom) root.querySelector('.task-chat-jump').hidden = true;
  });

  // Capture phase, and only while this window is the top dialog layer: with the Task Edit Modal
  // or a confirm open above it, Escape belongs to that layer and must not also close the chat.
  keyHandler = (e) => { if (e.key === 'Escape' && focusHandle && focusHandle.isTop()) close(); };
  document.addEventListener('keydown', keyHandler, true);
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
  focusHandle = activateDialogFocus({ root, initialFocus: () => input });
  applyChromeLabels();
  renderSelector();
  renderTranscript();
  syncComposer();
}

// The window's fixed labels, written when it is built and again when the language changes.
function applyChromeLabels() {
  if (!root) return;
  const q = sel => root.querySelector(sel);
  const name = (el, text) => { el.title = text; el.setAttribute('aria-label', text); };
  const project = isProjectChat();
  q('.task-chat-eyebrow-text').textContent = t(project ? 'taskChat.projectEyebrow' : 'taskChat.eyebrow');
  if (project) {
    const title = q('.task-chat-title-text');
    title.textContent = chatTitle();
    title.title = chatTitle();
  }
  name(q('.task-chat-new'), t('taskChat.newChat'));
  name(q('.task-chat-close'), t('btn.close'));
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
    ? t('taskChat.start.projectLead', { project: chatTitle() })
    : t('taskChat.start.taskLead', { key: chat.key });
  q('.task-chat-start-cancel').textContent = t('btn.cancel');
  syncStartGate();
  renderedLocale = getLocale();
}

// A project chat's heading: the project's name, else its id.
function chatTitle() {
  if (!chat) return '';
  return chat.title || `#${chat.key}`;
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
  const el = root.querySelector('.task-chat-title-text');
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
    el.querySelector('.task-chat-body').textContent = m.content;
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

function lastTurnMessage() {
  return messages.findLast(m => m.role !== 'system') || null;
}

// The server takes an answer only for an unanswered dialog on the chat's latest message, with
// no turn running — the widget is interactive under exactly those conditions.
function dialogState(m, dialog) {
  if (dialog.answer) return 'answered';
  if (m !== lastTurnMessage()) return 'skipped';
  return connected && !running && !m.streaming ? 'open' : 'waiting';
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
  const state = dialogState(m, dialog);
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
  const other = el.querySelector('.task-chat-dialog-other');
  const otherToggle = el.querySelector('.task-chat-dialog-options input[value="other"]');
  const submit = el.querySelector('.task-chat-dialog-submit');
  const sync = () => { submit.disabled = el.disabled || !readDialog(el, dialog); };
  el.addEventListener('change', (e) => {
    if (e.target === otherToggle && otherToggle.checked) other.focus();
    sync();
  });
  other.addEventListener('input', () => {
    if (other.value.trim()) otherToggle.checked = true;
    sync();
  });
  other.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitDialog(el, m, dialog); }
  });
  submit.addEventListener('click', () => submitDialog(el, m, dialog));
  applyDialogState(el, m, dialog);
  return el;
}

function submitDialog(el, m, dialog) {
  if (!ws || dialogState(m, dialog) !== 'open') return;
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

function growInput() {
  const input = root && root.querySelector('.task-chat-input');
  if (input) autoGrowTextarea(input, Math.round(window.innerHeight * 0.3));
}

function setRunning(value) {
  running = !!value;
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
  send.disabled = !connected || running || awaitingStart || !input.value.trim();
  if (select) select.disabled = running;
  root.querySelector('.task-chat-new').disabled = running || !connected || awaitingStart;
  // No composer until there is a chat to type into: while the first connect is still deciding
  // between restore and the start gate, and while the gate is up.
  root.querySelector('.task-chat-panel').classList.toggle('task-chat-panel--connecting', !connected && !messages.length);
  // Keep assistive tech from announcing every streamed re-render; the finished reply is read once.
  root.querySelector('.task-chat-messages').setAttribute('aria-busy', running ? 'true' : 'false');
  root.querySelector('.task-chat-panel').classList.toggle('task-chat-panel--running', running);
}

function sendMessage() {
  if (!root || !connected || running || awaitingStart) return;
  const input = root.querySelector('.task-chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  growInput();
  pushMessage({ role: 'user', content: text });
  pushMessage({ role: 'assistant', content: '', streaming: true });
  setRunning(true);
  wsSend(ws, WS_SEND_TYPES.TASK_CHAT_MESSAGE, { content: text, model: selection || undefined });
}

function stopTurn() {
  if (!running) return;
  root.querySelector('.task-chat-stop').disabled = true;
  wsSend(ws, WS_SEND_TYPES.ABORT, {});
}

async function startNewChat() {
  if (running || !connected || awaitingStart) return;
  if (messages.some(m => m.role !== 'system')) {
    const ok = await showActionConfirm({
      message: escapeAttr(t(isProjectChat() ? 'taskChat.project.confirmNewChat' : 'taskChat.confirmNewChat')),
      confirmLabel: t('taskChat.newChat'),
      danger: true,
      overlayClass: 'modal-overlay--over-chat',
    });
    if (!ok || !root) return;
  }
  wsSend(ws, WS_SEND_TYPES.RESTART, { model: selection || undefined });
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
  connected = false;
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
    connected = false;
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
      if (msg.running) messages.push({ role: 'assistant', content: '', streaming: true, dialogs: [], tools: [], taskEvents: [] });
      running = !!msg.running;
      renderTranscript();
      break;
    }

    // Last frame of every connect, fresh or reattached — the point where both are known.
    case 'config': {
      connected = true;
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
      const last = lastTurnMessage();
      if (last && last.role === 'user') {
        removeMessage(last);
        if (last.dialogAnswer) {
          // It was a dialog answer: nothing to retype — the dialog itself opens again.
          const asked = lastTurnMessage();
          const dialog = asked && (asked.dialogs || []).find(d => d.id === last.dialogAnswer.dialogId);
          if (dialog) delete dialog.answer;
        } else {
          const input = root.querySelector('.task-chat-input');
          if (!input.value.trim()) { input.value = last.content; growInput(); }
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

    case 'chat-ended':
      clearTimeout(freshTimer);
      if (wantFresh) { connect(); break; }
      ended = true;
      connected = false;
      finishStreaming();
      setRunning(false);
      pushNotice(t('taskChat.ended'), { retry: startFresh });
      break;

    case WS_RECV_TYPES.DETACHED:
      showToast(t('taskChat.detached'));
      close();
      break;

    default:
      break;
  }
}
