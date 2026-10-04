import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Client half of the task chat WS contract. task-chat.js pulls in DOM modules, so these are
// source-scan guards on its wiring; the pure decisions are covered in task-chat-model.test.js
// and the server half in src/server/task-chat-wiring.test.js.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const taskChat = read('./task-chat.js');
const styles = read('./styles.css');
const index = read('./index.js');
const wsHandlers = read('../server/ws-handlers.js');
const editModal = read('./task-edit-modal.js');
const taskCard = read('./task-card.js');
const dialogFocus = read('./dialog-focus.js');
const widgets = read('../server/task-chat-widgets.js');
const { WS_SEND_TYPES, WS_RECV_TYPES } = await import('./ws-client.js');
const { LOCALES } = await import('./i18n.js');

test('ws-client: task chat message types match the strings the server handles', () => {
  assert.equal(WS_SEND_TYPES.START_TASK_CHAT, 'start-task-chat');
  assert.equal(WS_SEND_TYPES.TASK_CHAT_MESSAGE, 'task-chat-message');
  assert.equal(WS_SEND_TYPES.TASK_CHAT_ANSWER, 'task-chat-answer');
  for (const type of [WS_SEND_TYPES.START_TASK_CHAT, WS_SEND_TYPES.TASK_CHAT_MESSAGE, WS_SEND_TYPES.TASK_CHAT_ANSWER]) {
    assert.ok(wsHandlers.includes(`msg.type === '${type}'`), `ws-handlers.js handles ${type}`);
  }
  assert.equal(WS_RECV_TYPES.TASK_CHAT_DIALOG, 'task-chat-dialog');
  assert.equal(WS_RECV_TYPES.TASK_CHAT_TOOL, 'task-chat-tool');
  assert.equal(WS_RECV_TYPES.TASK_CHAT_TASK, 'task-chat-task');
  for (const type of [WS_RECV_TYPES.TASK_CHAT_DIALOG, WS_RECV_TYPES.TASK_CHAT_TOOL, WS_RECV_TYPES.TASK_CHAT_TASK]) {
    assert.ok(widgets.includes(`type: '${type}'`), `task-chat-widgets.js emits ${type}`);
  }
});

test('ws-client: the hand-edit message is one string in both directions and the server handles it', () => {
  assert.equal(WS_SEND_TYPES.TASK_CHAT_TASK_EDITED, 'task-chat-task-edited');
  assert.equal(WS_RECV_TYPES.TASK_CHAT_TASK_EDITED, 'task-chat-task-edited');
  assert.ok(wsHandlers.includes("msg.type === 'task-chat-task-edited' && session.type === 'taskChat'"));
  assert.ok(wsHandlers.includes("type: 'task-chat-task-edited'"), 'and answers with the task it read back');
});

test('task-chat.js: the three widget renderers exist and every widget frame repaints the slot', () => {
  for (const fn of ['renderDialogWidget', 'renderTaskWidget', 'renderToolChip', 'paintWidgets']) {
    assert.match(taskChat, new RegExp(`function ${fn}\\(`), `${fn}() is defined`);
  }
  for (const type of ['TASK_CHAT_DIALOG', 'TASK_CHAT_TOOL', 'TASK_CHAT_TASK']) {
    const start = taskChat.indexOf(`case WS_RECV_TYPES.${type}: {`);
    assert.notEqual(start, -1, `${type} is handled`);
    assert.match(taskChat.slice(start, taskChat.indexOf('\n    case ', start + 1)), /paintWidgets\(m\)/, `${type} repaints the widgets`);
  }
});

test('task-chat.js: a dialog answer goes out as task-chat-answer with the model selection', () => {
  assert.match(taskChat, /wsSend\(ws, WS_SEND_TYPES\.TASK_CHAT_ANSWER, \{ \.\.\.submission, model: selection \|\| undefined \}\)/);
  assert.equal(taskChat.split('WS_SEND_TYPES.TASK_CHAT_ANSWER').length - 1, 1, 'sent from one place');
});

test('task-chat.js: a task card reuses the board card and opens the edit modal editable, without footer actions', () => {
  assert.match(taskChat, /import \{ renderCard \} from '\.\/task-card\.js'/);
  assert.match(taskChat, /renderCard\(task, \{ preview: true \}\)/);
  const opener = taskChat.slice(taskChat.indexOf('function openTaskFromChat('), taskChat.indexOf('function lastTurnMessage('));
  assert.match(opener, /openTaskEditModal\(key, \{/);
  assert.match(opener, /hideActions: true/);
  assert.doesNotMatch(opener, /readOnly/);
  assert.match(opener, /wsSend\(ws, WS_SEND_TYPES\.TASK_CHAT_TASK_EDITED, \{ taskKey: key \}\)/);
});

test('task-edit-modal.js: hideActions drops Start and the manage actions, onSaved fires after the write', () => {
  assert.match(editModal, /const hideActions = !!_modalState\.callbacks\.hideActions;/);
  assert.match(editModal, /const showStart = !isPreviewTask && !readOnly && !hideActions && /);
  assert.match(editModal, /\$\{readOnly \|\| hideActions \? '' : `<div class="modal-actions-manage">/);
  const update = editModal.indexOf('updateResult = await api.tasks.update(taskId, patch);');
  const saved = editModal.indexOf('callbacks.onSaved?.(taskId)');
  const stale = editModal.indexOf('if (!_modalState || _modalState.taskId !== taskId) return true;');
  assert.ok(update !== -1 && saved > update && saved < stale, 'between the write and the stale-modal early return');
});

test('stacking: the chat marks the body, lifts the edit modal above itself and yields Escape to the top layer', () => {
  assert.match(taskChat, /document\.body\.classList\.add\('task-chat-open'\)/);
  assert.match(taskChat, /document\.body\.classList\.remove\('task-chat-open'\)/);
  assert.match(taskChat, /e\.key === 'Escape' && focusHandle && focusHandle\.isTop\(\)/);
  assert.match(taskChat, /document\.addEventListener\('keydown', keyHandler, true\)/);
  assert.match(taskChat, /document\.removeEventListener\('keydown', keyHandler, true\)/);
  assert.match(dialogFocus, /isTop: \(\) => top\(\) === layer/);
  const chatZ = Number(/\.task-chat-modal \{[^}]*?z-index: (\d+)/.exec(styles)[1]);
  const lifted = Number(/body\.task-chat-open \.task-edit-overlay \{ z-index: (\d+); \}/.exec(styles)[1]);
  assert.ok(lifted > chatZ, 'above the chat window');
  assert.ok(lifted < 3200, 'below the edit modal\'s portaled dropdowns');
});

test('styles.css: every widget variant is styled and cannot widen the transcript', () => {
  const start = styles.indexOf('/* ── Task Chat window ──');
  const block = styles.slice(start, styles.indexOf('/* ── end Task Chat window ── */'));
  for (const selector of ['.task-chat-widget {', '.task-chat-widget--tool {', '.task-chat-widget--task {', '.task-chat-widget--dialog {']) {
    assert.ok(block.includes(selector), `${selector} is in the Task Chat block`);
  }
  assert.match(block, /\.task-chat-widget \{\s*min-width: 0;\s*max-width: 100%;/);
  assert.match(block, /\.task-chat-widget--dialog \{[^}]*min-width: 0;/, 'a fieldset defaults to min-content');
  assert.match(block, /\.task-chat-tool-target \{[^}]*text-overflow: ellipsis;/);
  assert.match(block, /\.task-chat-widget--tool\.task-chat-widget--open \{ flex-basis: 100%; \}/);
});

test('task-chat.js: connects on the taskChat: / projectChat: session id and exports open/openProjectChat/close', () => {
  assert.match(taskChat, /const SESSION_PREFIX = 'taskChat:'/);
  assert.match(taskChat, /const PROJECT_SESSION_PREFIX = 'projectChat:'/);
  assert.match(taskChat, /sessionId: SESSION_PREFIX \+ key/);
  // (TPT469) One project holds several chats: projectChat:<projectId>:<chatId>.
  assert.match(taskChat, /return `\$\{PROJECT_SESSION_PREFIX\}\$\{projectId\}:\$\{Date\.now\(\)\.toString\(36\)\}\$\{rand\}`;/);
  assert.match(taskChat, /buildWsUrl\(chat\.sessionId\)/);
  assert.match(taskChat, /export async function open\(taskId\)/);
  assert.match(taskChat, /export async function openProjectChat\(\{ chatId = '' \} = \{\}\)/);
  assert.match(taskChat, /export function close\(\)/);
});

test('task-chat.js: openProjectChat() reads this window\'s project id, never a task', () => {
  const fn = taskChat.slice(taskChat.indexOf('export async function openProjectChat('), taskChat.indexOf('function openChat('));
  // Header-scoped config: the id the server checks the session id against in multi-window Electron.
  assert.match(fn, /fetch\('\/api\/project-config', \{ headers: projectHeader\(\)/);
  assert.match(fn, /cfg\.API_PROJECT_ID/);
  assert.match(fn, /if \(seq !== openSeq\) return;/, 'a superseded open does nothing');
  assert.match(fn, /showToast\(t\('taskChat\.error\.noProject'\)/);
  assert.match(fn, /kind: 'project'/);
  assert.doesNotMatch(fn, /wsSend|START_/, 'opening sends nothing');
});

test('task-chat.js: a follow-up turn carries `content` and the model selection', () => {
  assert.match(taskChat, /wsSend\(ws, WS_SEND_TYPES\.TASK_CHAT_MESSAGE, \{ content: text, model: selection \|\| undefined \}\)/);
  assert.doesNotMatch(taskChat, /TASK_CHAT_MESSAGE, \{ text\b/);
});

test('task-chat.js: a socket with no history reset shows the start gate instead of starting', () => {
  const configCase = taskChat.slice(taskChat.indexOf("case 'config':"), taskChat.indexOf('case WS_RECV_TYPES.DATA:'));
  assert.match(configCase, /if \(!sawReset\) \{[\s\S]*showStartGate\(\);[\s\S]*\} else \{\s*focusComposer\(\);/);
  assert.doesNotMatch(configCase, /beginChat|sendStartFrame|START_/, 'no start frame from the config frame');
  // Only the gate's Start button begins a chat.
  assert.match(taskChat, /querySelector\('\.task-chat-start-go'\)\.addEventListener\('click', beginChat\)/);
  assert.equal(taskChat.split('beginChat(').length - 1, 1, 'beginChat() is only defined, never called directly');
});

test('task-chat.js: dialogs repaint on every socket state change, including the config frame of a reattach', () => {
  // chat-history-reset (and a finished turn's flush) arrive before `config`, so restored dialogs
  // are built `waiting`; `config` must flip them to `open`.
  const setConnected = taskChat.slice(taskChat.indexOf('function setConnected('), taskChat.indexOf('function syncComposer('));
  assert.match(setConnected, /connected = !!value;[\s\S]*syncDialogWidgets\(\);/);
  const configCase = taskChat.slice(taskChat.indexOf("case 'config':"), taskChat.indexOf('case WS_RECV_TYPES.DATA:'));
  assert.match(configCase, /setConnected\(true\)/);
  assert.equal((taskChat.match(/^\s+connected = (true|false);/gm) || []).length, 2,
    'only openChat() and close() (no root to repaint) set the flag directly');
  // The open-state rule is the tested model helper, not a copy in the window.
  assert.match(taskChat, /dialogState\(\{ messages, message: m, dialog, connected, running \}\)/);
});

test('task-chat.js: Start sends one start frame per socket, carrying the chosen model', () => {
  const begin = taskChat.slice(taskChat.indexOf('function beginChat()'), taskChat.indexOf('function focusComposer()'));
  assert.match(begin, /if \(!awaitingStart \|\| starting \|\| !connected \|\| !ws \|\| noUsableModel\(\)\) return;\s*starting = true;\s*awaitingStart = false;/);
  assert.match(begin, /sendStartFrame\(\);/);
  assert.match(taskChat, /const type = isProjectChat\(\) \? WS_SEND_TYPES\.START_PROJECT_CHAT : WS_SEND_TYPES\.START_TASK_CHAT;\s*wsSend\(ws, type, \{ model: selection \|\| undefined \}\);/);
  assert.equal(taskChat.split('WS_SEND_TYPES.START_TASK_CHAT').length - 1, 1, 'start-task-chat is sent from one place');
  assert.equal(taskChat.split('WS_SEND_TYPES.START_PROJECT_CHAT').length - 1, 1, 'start-project-chat is sent from one place');
  // Every new socket re-arms the gate; a reused one cannot start twice.
  assert.match(taskChat.slice(taskChat.indexOf('function connect()')), /awaitingStart = false;\s*starting = false;/);
});

test('task-chat.js: Cancel at the gate only closes — it never kills or starts', () => {
  // Standalone it closes the window; in a workspace pane it hands back to the Edit pane.
  const cancel = taskChat.slice(taskChat.indexOf("querySelector('.task-chat-start-cancel').addEventListener('click'"), taskChat.indexOf("querySelector('.task-chat-start-go').addEventListener('click', beginChat)"));
  assert.match(cancel, /if \(embedded && embedded\.onOpenTask && chat\) embedded\.onOpenTask\(chat\.key\);\s*else close\(\);/);
  assert.doesNotMatch(cancel, /wsSend|KILL|START_/);
  // The server drops a still-pending session when its socket closes, so nothing was spawned.
  assert.match(wsHandlers, /if \(session\.pending\) \{\s*sessions\.delete\(sessionKey\);/);
});

test('ws-client: start-project-chat matches the string the server handles', () => {
  assert.equal(WS_SEND_TYPES.START_PROJECT_CHAT, 'start-project-chat');
  assert.ok(wsHandlers.includes("msg.type === 'start-project-chat'"));
});

test('template.html: left-menu Start Chat opens the project chat and is not a navigation section', () => {
  const template = read('./template.html');
  assert.match(template, /<button class="left-nav-btn left-nav-btn--chat" data-action="start-chat"/);
  assert.match(template, /querySelector\('\[data-action="start-chat"\]'\)\.addEventListener\('click', \(\) => \{\s*window\.TipTask\?\.taskChat\?\.openProjectChat\?\.\(\);/);
  assert.match(template, /panel\.querySelectorAll\('\.left-nav-btn\[data-section\]'\)\.forEach/);
  assert.match(template, /applyNavLabel\(panel\.querySelector\('\[data-action="start-chat"\]'\), 'nav\.startChat'\)/);
  // Sits right under Create.
  assert.ok(template.indexOf('data-action="start-chat"') > template.indexOf('data-section="new"'));
  assert.ok(LOCALES.en['nav.startChat'] && LOCALES.uk['nav.startChat']);
  assert.notEqual(LOCALES.uk['nav.startChat'], LOCALES.en['nav.startChat']);
});

test('styles.css: the gate hides transcript and composer, and the composer waits for the first connect', () => {
  assert.match(styles, /\.task-chat-panel--gated \.task-chat-messages,\s*\.task-chat-panel--gated \.task-chat-footer,\s*\.task-chat-panel--connecting \.task-chat-footer \{ display: none; \}/);
  assert.match(styles, /\.task-chat-start\[hidden\] \{ display: none; \}/);
});

test('task-chat.js: Stop aborts the turn and closing the window does not kill the chat', () => {
  assert.match(taskChat, /function stopTurn\(\) \{[\s\S]*?wsSend\(ws, WS_SEND_TYPES\.ABORT, \{\}\)/);
  const closeFn = taskChat.slice(taskChat.indexOf('export function close()'), taskChat.indexOf('// ── Window ──'));
  assert.doesNotMatch(closeFn, /WS_SEND_TYPES\.KILL/);
});

test('task-chat.js: every taskChat.* string it uses exists in both locales', () => {
  const keys = new Set([...taskChat.matchAll(/'(taskChat\.[A-Za-z.]+)'/g)].map(m => m[1]));
  assert.ok(keys.size > 10, 'found the window strings');
  for (const key of keys) {
    assert.ok(key in LOCALES.en, `en has ${key}`);
    assert.ok(key in LOCALES.uk, `uk has ${key}`);
  }
});

test('styles.css: the Task Chat block is built from theme tokens', () => {
  const start = styles.indexOf('/* ── Task Chat window ──');
  const end = styles.indexOf('/* ── end Task Chat window ── */');
  assert.ok(start !== -1 && end > start, 'block markers present');
  const block = styles.slice(start, end);
  assert.match(block, /\.task-chat-panel \{/);
  assert.match(block, /\.task-chat-composer \{/);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'no hex colours');
  // The only literal colours are the black scrim and the panel drop shadow.
  const literals = block.match(/rgba?\([^)]*\)/g) || [];
  assert.ok(literals.every(c => /^rgba\(0, 0, 0, /.test(c)), `unexpected colour literal in ${literals.join(' ')}`);
});

test('index.js: the window is bundled and reachable as TipTask.taskChat', () => {
  assert.match(index, /import \* as taskChat from '\.\/task-chat\.js'/);
  assert.match(index, /window\.TipTask = \{[^}]*\btaskChat\b/);
});

// ── Entry points ──
// The window is opened from the board card and from the Task Edit Modal header. Both hand the
// bare task key to the same open(), so both land on the one `taskChat:<key>` server session.

test('task-card.js: .btn-task-chat opens the chat for its task, behind the discuss lock and pending-sync guards', () => {
  const start = taskCard.indexOf("appEl.querySelectorAll('.btn-task-chat')");
  assert.notEqual(start, -1, 'handler is attached');
  const handler = taskCard.slice(start, taskCard.indexOf("appEl.querySelectorAll('.card[data-id]')", start));
  assert.match(handler, /e\.stopPropagation\(\);/);
  assert.match(handler, /const taskId = btn\.dataset\.taskId;/);
  const lock = handler.indexOf('if (isTaskDiscussing(state, taskId)) {');
  const pending = handler.indexOf("classList.contains('pending-sync')) return;");
  const open = handler.indexOf('window.TipTask?.taskChat?.open(taskId);');
  assert.ok(lock !== -1 && pending > lock && open > pending, 'lock, then pending-sync, then open');
  assert.match(handler.slice(lock, pending), /showToast\(translate\(lockMessageKey\(lockIntentOf\(state, taskId\)\)\)\);\s*return;/);
  // An import would be a cycle: task-chat.js imports renderCard from task-card.js.
  assert.doesNotMatch(taskCard, /from '\.\/task-chat\.js'/);
});

test('task-edit-modal.js: the workspace tabs (Edit / Agent Terminal / Chat) are shown for a live task only', () => {
  const enabled = editModal.slice(editModal.indexOf('function _paneTabsEnabled(callbacks)'), editModal.indexOf('const _PANE_ICONS'));
  assert.match(enabled, /return !callbacks\.preloadedTask && !callbacks\.compareTask && !callbacks\.compareTaskId\s*&& !callbacks\.hideActions && !callbacks\.readOnly;/);
  assert.match(editModal, /const _PANES = \['edit', 'terminal', 'chat'\];/);
  // In the header, between the key/status group and Cancel/Reset/Save — where the chat button was.
  const bar = editModal.slice(editModal.indexOf('<div class="modal-top-bar">'), editModal.indexOf('<div class="modal-scroll-body">'));
  const meta = bar.indexOf('<div class="modal-head-meta">');
  const tabs = bar.indexOf('${tabsHtml}');
  const primary = bar.indexOf('<div class="modal-primary-actions">');
  assert.ok(meta !== -1 && tabs > meta && primary > tabs, 'meta, tabs, primary actions');
  assert.doesNotMatch(editModal, /btn-modal-chat/, 'the separate chat button is gone');
});

test('task-edit-modal.js: the chat pane mounts the task chat through the bridge, and a save tells it', () => {
  const show = editModal.slice(editModal.indexOf('function _showChatPane('), editModal.indexOf('function _disposePane('));
  assert.match(show, /const mount = window\.TipTask\?\.taskChat\?\.mount;/);
  assert.match(show, /handle = mount\(pane, taskId, \{/);
  assert.match(show, /handle\.show\(\{ focus \}\);/);
  assert.match(editModal, /_modalState\.panes\?\.chat\?\.taskEdited\?\.\(taskId\)/);
  // The module boundary (task-edit-modal.behavior.test.js) forbids pulling task-card.js in here.
  assert.doesNotMatch(editModal, /from '\.\/task-chat\.js'/);
  assert.doesNotMatch(editModal, /from '\.\/console-modal\.js'/);
});

test('task-chat.js: open() routes a task chat to its workspace; the project chat stays a window', () => {
  const open = taskChat.slice(taskChat.indexOf('export async function open(taskId)'), taskChat.indexOf('export function mount('));
  assert.match(open, /const openWorkspace = window\.TipTask\?\.openTaskWorkspace;\s*if \(typeof openWorkspace === 'function'\) return openWorkspace\(key, \{ pane: 'chat' \}\);/);
  const project = taskChat.slice(taskChat.indexOf('export async function openProjectChat('), taskChat.indexOf('function openChat('));
  assert.doesNotMatch(project, /openTaskWorkspace/);
  assert.match(project, /openChat\(\{ kind: 'project'/);
});

test('styles.css: workspace tabs share one panel frame on every pane, and drop captions on a phone', () => {
  // (TPT479) One box for Edit / Agent Terminal / Chat — a pane switch never moves the panel.
  assert.match(styles, /\.task-edit-panel--tabs \{\s*max-width: min\(1400px, 100%\); height: min\(900px, calc\(100vh - 40px\)\); max-height: none;/);
  assert.doesNotMatch(styles, /\.task-edit-panel--tabs\[data-pane="(?:chat|terminal|edit)"\] \{[^}]*(?:max-width|height)/);
  assert.match(styles, /\.task-edit-overlay--rail \{\s*left: 200px;/);
  const phone = styles.slice(styles.indexOf('.modal-top-bar button { padding: 0 10px; }'));
  assert.match(phone.slice(0, 400), /\.modal-top-bar \.task-modal-tab-label \{ display: none; \}/);
});

test('i18n: the entry-point labels exist and are translated in both locales', () => {
  for (const key of ['btn.taskChat', 'tooltip.taskChat']) {
    assert.ok(LOCALES.en[key], `en has ${key}`);
    assert.ok(LOCALES.uk[key], `uk has ${key}`);
    assert.notEqual(LOCALES.uk[key], LOCALES.en[key], `${key} is translated`);
  }
});

test('task-chat.js: every label is looked up when it is drawn, and a language switch redraws them', () => {
  // A t() result captured at module level would freeze in the locale of the first import.
  const moduleLevel = taskChat.split('\n').filter(line => /^(const|let|var) /.test(line) && /\bt\(/.test(line));
  assert.deepEqual(moduleLevel, []);
  // The window's own markup carries no label text; applyChromeLabels() writes all of it.
  const template = taskChat.slice(taskChat.indexOf('root.innerHTML = `'), taskChat.indexOf('(host || document.body).appendChild(root);'));
  assert.ok(template.length > 0, 'window template found');
  assert.doesNotMatch(template, /\bt\(/);
  assert.match(taskChat, /function relabel\(\) \{\s*if \(!root \|\| getLocale\(\) === renderedLocale\) return;\s*applyChromeLabels\(\);\s*renderSelector\(\);\s*renderTranscript\(\);/);
  assert.match(taskChat, /document\.addEventListener\('tiptask:reload', reloadHandler\)/);
  assert.match(taskChat, /document\.removeEventListener\('tiptask:reload', reloadHandler\)/);
});

// ── Attachments (TPT473) ──
// The composer reuses the objective chat's Embed control and upload helpers; nothing is copied.

test('task-chat.js: Embed, paste and drop come from the shared helpers, with no upload code of its own', () => {
  assert.match(taskChat, /import \{ attachImagePaste \} from '\.\/task-board\.js'/);
  assert.match(taskChat, /import \{[^}]*\battachEmbedMenu\b[^}]*\battachFileDrop\b[^}]*\} from '\.\/embed-menu\.js'/);
  for (const own of ['FileReader', 'api.files.upload', "'upload-image'", 'createObjectURL']) {
    assert.ok(!taskChat.includes(own), `task-chat.js does not implement uploads itself (${own})`);
  }
  // Composer and start gate each carry the control; the drop target is the whole panel.
  assert.match(taskChat, /task-chat-embed-slot">\$\{embedMenuHtml\(\{ label: '' \}\)/);
  assert.match(taskChat, /task-chat-start-embed">\$\{embedMenuHtml\(/);
  assert.match(taskChat, /attachFileDrop\(root\.querySelector\('\.task-chat-panel'\)/);
  // Send waits for uploads; user turns render their attachments.
  assert.match(taskChat, /send\.disabled = [^;]*uploadsPending > 0/);
  assert.match(taskChat, /userMessageHtml\(m\.content/);
});

test('chat-ui.js: the objective chat uses the same shared Embed control', () => {
  const chatUi = read('./chat-ui.js');
  const embed = read('./embed-menu.js');
  assert.match(chatUi, /from '\.\/embed-menu\.js'/);
  assert.match(chatUi, /attachEmbedMenu\(embedWrap, chatInput/);
  assert.ok(!chatUi.includes('_embedMenuCleanup'), 'the menu teardown lives in embed-menu.js');
  assert.ok(!chatUi.includes('import-submenu--up'), 'the menu is built in embed-menu.js');
  assert.match(embed, /uploadImageFile\(file, textarea, null, imageOpts\)/);
  assert.match(embed, /uploadAttachmentFile\(file, textarea\)/);
});

test('styles.css: attachments and the drop state are styled inside the Task Chat block', () => {
  const block = styles.slice(styles.indexOf('/* ── Task Chat window ──'), styles.indexOf('/* ── end Task Chat window ── */'));
  for (const sel of ['.task-chat-attachments', '.task-chat-attach--image img', '.task-chat-attach--file', '.task-chat-panel--drop::after', '.task-chat-upload-status', '.task-chat-start-attachments']) {
    assert.ok(block.includes(sel), `styled: ${sel}`);
  }
});
