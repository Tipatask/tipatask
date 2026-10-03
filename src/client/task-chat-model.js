// Pure, DOM-free helpers behind task-chat.js — the per-task chat window. Same split as
// merge-branches-model.js: everything that can be unit-tested under plain node lives here
// (provider filtering, selection choice, transcript shaping, ask_user fence handling, and the
// markup + answer rules of the dialog / tool / task widgets, attachment thumbnails and chips),
// the window only renders and wires. No imports on purpose — the test imports this module directly.

// Providers that can enforce the task-chat tool fence. Mirrors the server's profile list
// (providers/tool-profiles.js); gemini is refused there, so it is never offered here even
// though the `config` frame's objectiveProviders list still carries it.
export const TASK_CHAT_PROVIDER_IDS = Object.freeze(['claude', 'codex', 'pi']);

export function taskChatProviders(providers) {
  return (Array.isArray(providers) ? providers : [])
    .filter(p => p && TASK_CHAT_PROVIDER_IDS.includes(p.id));
}

function splitSelection(raw) {
  const s = typeof raw === 'string' ? raw : '';
  const i = s.indexOf(':');
  if (i <= 0) return null;
  return { providerId: s.slice(0, i), model: s.slice(i + 1) };
}

// True when `raw` ("provider:model") names an available task-chat provider and one of its models.
export function isSelectable(providers, raw) {
  const sel = splitSelection(raw);
  if (!sel) return false;
  const p = taskChatProviders(providers).find(pr => pr.id === sel.providerId);
  return !!(p && p.available && Array.isArray(p.models) && p.models.some(m => m.value === sel.model));
}

// The "provider:model" the selector should show. Candidates in priority order: the server's
// own selection for an existing session, this window's sticky choice, the objective chat's
// choice. The first selectable one wins; otherwise the first available model; otherwise ''.
export function pickSelection({ providers, serverSelection, stored, fallback } = {}) {
  for (const candidate of [serverSelection, stored, fallback]) {
    if (isSelectable(providers, candidate)) return candidate;
  }
  for (const p of taskChatProviders(providers)) {
    if (!p.available || !Array.isArray(p.models) || !p.models.length) continue;
    const preferred = p.models.find(m => m.value === p.defaultModel) || p.models[0];
    return `${p.id}:${preferred.value}`;
  }
  return '';
}

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// <optgroup>/<option> markup for the `.chat-model-selector` select — same shape the objective
// composer renders. `labelFn(providerId, modelValue)` supplies the display label.
export function buildModelOptionsHtml(providers, current, labelFn) {
  const label = typeof labelFn === 'function' ? labelFn : (_id, value) => value;
  return taskChatProviders(providers).map((p) => {
    const dis = p.available ? '' : ' disabled';
    const title = !p.available && p.reason ? ` title="${esc(p.reason)}"` : '';
    const options = (p.models || []).map((m) => {
      const val = `${p.id}:${m.value}`;
      const selected = val === current ? ' selected' : '';
      return `<option value="${esc(val)}"${selected}${dis}${title}>${esc(label(p.id, m.value))}</option>`;
    }).join('');
    return options ? `<optgroup label="${esc(p.label || p.id)}"${dis}${title}>${options}</optgroup>` : '';
  }).join('');
}

// The agent asks for a choice with a fenced block tagged `ask_user`; the server keeps that
// fence in the text and sends the parsed dialog as its own frame. Remove every complete block,
// and a trailing unterminated one (the block is still streaming).
const ASK_USER_BLOCK_RE = /```ask_user[^\n]*\n[\s\S]*?```/gi;
const ASK_USER_OPEN_RE = /```ask_user[\s\S]*$/i;

export function stripAskUserFence(text) {
  if (typeof text !== 'string' || !text) return '';
  if (!/```ask_user/i.test(text)) return text;
  return text.replace(ASK_USER_BLOCK_RE, '').replace(ASK_USER_OPEN_RE, '').replace(/\s+$/, '');
}

// ── Dialog widget ──

function optionLabel(opt) {
  return typeof opt === 'string' ? opt : (opt && typeof opt.label === 'string' ? opt.label : '');
}

// What the widget's current picks would send as `task-chat-answer`, or null while they are not
// a valid answer. Same rules as the server's resolveDialogAnswer(): a single-choice dialog takes
// exactly one answer (one option or the free text), a multi-choice dialog one or more.
export function dialogSubmission(dialog, { picked, other } = {}) {
  if (!dialog || !Array.isArray(dialog.options)) return null;
  const selected = [...new Set((Array.isArray(picked) ? picked : [])
    .filter(i => Number.isInteger(i) && i >= 0 && i < dialog.options.length))].sort((a, b) => a - b);
  const free = typeof other === 'string' ? other.trim() : '';
  const total = selected.length + (free ? 1 : 0);
  if (total === 0 || (!dialog.multi && total !== 1)) return null;
  const submission = { dialogId: dialog.id, selected };
  if (free) submission.other = free;
  return submission;
}

// The chat's latest turn: the last message that is not a window notice (`system`).
export function lastTurnMessage(messages) {
  return (Array.isArray(messages) ? messages : []).findLast(m => m && m.role !== 'system') || null;
}

// A dialog widget's state. The server takes an answer only for an unanswered dialog on the
// chat's latest turn, with no turn running — the widget is `open` under exactly those
// conditions and the socket up; `waiting` while that turn runs or the socket is down (a
// reattach restores history before its `config` frame says it is connected); `skipped` once
// the conversation moved on; `answered` once `dialog.answer` is set.
export function dialogState({ messages, message, dialog, connected, running } = {}) {
  if (dialog && dialog.answer) return 'answered';
  if (!message || message !== lastTurnMessage(messages)) return 'skipped';
  return connected && !running && !message.streaming ? 'open' : 'waiting';
}

// The `dialog.answer` shape the server will store for a submission, so the widget can lock
// with the right picks before the server's copy arrives.
export function localAnswer(dialog, submission) {
  const indexes = submission && Array.isArray(submission.selected) ? submission.selected : [];
  return {
    selected: indexes.map(i => optionLabel(dialog.options[i])),
    indexes,
    other: (submission && submission.other) || '',
  };
}

// An answer as the user's own line in the transcript: the picked labels, then the free text.
export function answerSummary(answer) {
  if (!answer) return '';
  const labels = (Array.isArray(answer.selected) ? answer.selected : []).filter(Boolean).map(String);
  const parts = [...labels];
  const free = typeof answer.other === 'string' ? answer.other.trim() : '';
  if (free) parts.push(labels.length ? `Other: ${free}` : free);
  return parts.join('; ');
}

// Markup of one dialog: the question, an option per row (radio for single choice, checkbox for
// multi), a free-text "Other" row and the submit button. `name` must be unique per rendered
// widget — dialog ids are content hashes, so the same question asked twice shares an id.
// An answered dialog renders locked with its picks; the window toggles the open/closed state.
export function dialogWidgetHtml(dialog, { t, name } = {}) {
  if (!dialog || !Array.isArray(dialog.options)) return '';
  const tr = typeof t === 'function' ? t : key => key;
  const answer = dialog.answer || null;
  const type = dialog.multi ? 'checkbox' : 'radio';
  const group = esc(name || dialog.id);
  const picked = new Set(answer && Array.isArray(answer.indexes) ? answer.indexes : []);
  const freeText = answer && typeof answer.other === 'string' ? answer.other : '';
  const questionId = `${group}-q`;
  const options = dialog.options.map((opt, i) => {
    const description = opt && typeof opt.description === 'string' ? opt.description.trim() : '';
    return `<label class="task-chat-dialog-option">`
      + `<input type="${type}" name="${group}" value="${i}"${picked.has(i) ? ' checked' : ''}>`
      + `<span class="task-chat-dialog-text"><span class="task-chat-dialog-label">${esc(optionLabel(opt))}</span>`
      + (description ? `<span class="task-chat-dialog-desc">${esc(description)}</span>` : '')
      + '</span></label>';
  }).join('');
  const otherLabel = esc(tr('taskChat.dialog.other'));
  return `<fieldset class="task-chat-widget task-chat-widget--dialog" data-state="${answer ? 'answered' : 'open'}" aria-labelledby="${questionId}"${answer ? ' disabled' : ''}>`
    + `<div class="task-chat-dialog-question" id="${questionId}">${esc(dialog.question)}</div>`
    + `<div class="task-chat-dialog-hint">${esc(tr(dialog.multi ? 'taskChat.dialog.hintMulti' : 'taskChat.dialog.hintSingle'))}</div>`
    + `<div class="task-chat-dialog-options">${options}`
    + '<label class="task-chat-dialog-option task-chat-dialog-option--other">'
    + `<input type="${type}" name="${group}" value="other" aria-label="${otherLabel}"${freeText ? ' checked' : ''}>`
    + `<span class="task-chat-dialog-text"><span class="task-chat-dialog-label">${otherLabel}</span>`
    + `<input type="text" class="task-chat-dialog-other" maxlength="2000" autocomplete="off" placeholder="${esc(tr('taskChat.dialog.otherPlaceholder'))}" aria-label="${esc(tr('taskChat.dialog.otherPlaceholder'))}" value="${esc(freeText)}">`
    + '</span></label></div>'
    + '<div class="task-chat-dialog-actions">'
    + `<span class="task-chat-dialog-state">${answer ? esc(tr('taskChat.dialog.answered')) : ''}</span>`
    + `<button type="button" class="task-chat-dialog-submit" disabled${answer ? ' hidden' : ''}>${esc(tr('taskChat.dialog.submit'))}</button>`
    + '</div></fieldset>';
}

// ── Tool chip ──

const KB_DOC_TOOLS = new Set(['get_tag_architecture', 'get_tag_architectures']);
const FILE_TOOLS = new Set(['read']);
const SEARCH_TOOLS = new Set(['batch_grep_tags', 'grep', 'find', 'ls', 'glob']);
const KB_PATH_RE = /(?:^|\/)ai\/architecture\/([^/]+)\.md$/;
const MAX_TOOL_ROWS = 20;

function inputText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(v => v === null || typeof v !== 'object')) return value.join(', ');
  if (typeof value === 'object') { try { return JSON.stringify(value); } catch { return ''; } }
  return String(value);
}

function firstOf(list) {
  const items = (Array.isArray(list) ? list : []).filter(v => typeof v === 'string' && v);
  if (!items.length) return '';
  return items.length > 1 ? `${items[0]} +${items.length - 1}` : items[0];
}

function tailPath(path) {
  const parts = String(path).split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : String(path);
}

// What a tool call is, in the terms a chip shows: its kind (`kb` doc, `file`, `search`, `task`
// or `other`), the short tool name, the thing it acted on, and the argument rows behind the
// chip. Covers the naming of all three providers (MCP tools, Claude's `Read`, Pi's `read` /
// `grep` / `tipatask_api`). Results are never part of a tool frame, so there is none to show.
export function toolChipModel(tool) {
  const record = tool && typeof tool === 'object' ? tool : {};
  const name = shortToolName(record.tool || record.name) || 'tool';
  const key = name.toLowerCase();
  const input = record.input && typeof record.input === 'object' && !Array.isArray(record.input) ? record.input : {};
  let kind = 'other';
  let target = '';
  if (KB_DOC_TOOLS.has(key)) {
    kind = 'kb';
    target = typeof input.tag_name === 'string' ? input.tag_name : firstOf(input.tag_names);
  } else if (FILE_TOOLS.has(key)) {
    const path = typeof input.file_path === 'string' ? input.file_path : (typeof input.path === 'string' ? input.path : '');
    const doc = KB_PATH_RE.exec(path);
    kind = doc ? 'kb' : 'file';
    target = doc ? doc[1] : tailPath(path);
  } else if (SEARCH_TOOLS.has(key)) {
    kind = 'search';
    target = firstOf(input.symbols) || firstOf(input.tag_names)
      || (typeof input.pattern === 'string' && input.pattern) || (typeof input.path === 'string' && tailPath(input.path)) || '';
  } else if (key === 'tipatask_api') {
    kind = 'task';
    target = `${String(input.method || 'GET').toUpperCase()} ${typeof input.path === 'string' ? input.path : ''}`.trim();
  } else if (record.server === 'tipatask' || /task/.test(key)) {
    kind = 'task';
    target = (typeof input.task_key === 'string' && input.task_key) || (typeof input.title === 'string' && input.title) || '';
  }
  const rows = Object.keys(input).slice(0, MAX_TOOL_ROWS)
    .map(k => [k, inputText(input[k])])
    .filter(([, value]) => value !== '');
  const error = record.status === 'error' ? (typeof record.error === 'string' && record.error ? record.error : 'error') : '';
  const status = ['running', 'done', 'error'].includes(record.status) ? record.status : 'running';
  return { kind, name, fullName: typeof record.name === 'string' ? record.name : name, target, rows, error, status, expandable: rows.length > 0 || !!error };
}

const TOOL_KIND_KEYS = { kb: 'taskChat.tool.kind.kb', file: 'taskChat.tool.kind.file', search: 'taskChat.tool.kind.search' };

// Markup of one tool chip. A chip with something behind it (arguments, an error) is a button
// that expands its detail block; otherwise it is a plain label.
export function toolChipHtml(tool, { t, open = false } = {}) {
  const tr = typeof t === 'function' ? t : key => key;
  const chip = toolChipModel(tool);
  const label = TOOL_KIND_KEYS[chip.kind] ? tr(TOOL_KIND_KEYS[chip.kind]) : chip.name;
  const status = tr(`taskChat.tool.status.${chip.status}`);
  const inner = '<span class="task-chat-tool-dot" aria-hidden="true"></span>'
    + `<span class="task-chat-tool-label">${esc(label)}</span>`
    + (chip.target ? `<span class="task-chat-tool-target">${esc(chip.target)}</span>` : '')
    + (chip.status === 'error' ? `<span class="task-chat-tool-status">${esc(status)}</span>` : '');
  const expanded = open && chip.expandable;
  const head = chip.expandable
    ? `<button type="button" class="task-chat-tool-chip" aria-expanded="${expanded ? 'true' : 'false'}" title="${esc(status)}">${inner}</button>`
    : `<span class="task-chat-tool-chip" title="${esc(status)}">${inner}</span>`;
  const rows = chip.rows.map(([k, v]) => `<div class="task-chat-tool-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const detail = chip.expandable
    ? `<div class="task-chat-tool-detail"${expanded ? '' : ' hidden'}>`
      + `<div class="task-chat-tool-name">${esc(chip.fullName)}</div>`
      + (rows ? `<dl class="task-chat-tool-rows">${rows}</dl>` : '')
      + (chip.error ? `<div class="task-chat-tool-error">${esc(chip.error)}</div>` : '')
      + '</div>'
    : '';
  return `<div class="task-chat-widget task-chat-widget--tool${expanded ? ' task-chat-widget--open' : ''}" data-status="${chip.status}" data-kind="${chip.kind}">${head}${detail}</div>`;
}

// ── Task widget ──

// A turn can touch one task several times (create, then update). One card per task: its
// latest copy, shown as created when the turn created it.
export function collapseTaskEvents(events) {
  const byKey = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const task = event && event.task;
    if (!task || task.id == null) continue;
    const key = String(task.id);
    const seen = byKey.get(key);
    byKey.set(key, { id: key, action: (seen && seen.action === 'created') || event.action === 'created' ? 'created' : 'updated', task });
  }
  return [...byKey.values()];
}

export function hasWidgets(m) {
  return !!m && ['dialogs', 'tools', 'taskEvents'].some(k => Array.isArray(m[k]) && m[k].length > 0);
}

// A user turn sent after the user edited tasks by hand opens with a fenced `task_edits` block
// for the agent (server: buildTaskEditNote()). It is context, not something the user typed.
const TASK_EDITS_RE = /^```task_edits[^\n]*\n[^\n]*\n```[ \t]*\n*/;

export function stripTaskEditNote(text) {
  if (typeof text !== 'string' || !text.startsWith('```task_edits')) return typeof text === 'string' ? text : '';
  return text.replace(TASK_EDITS_RE, '');
}

// Server history -> transcript entries. The generated first message (`seed: true`: task JSON,
// comments, opening ask) is context for the agent, not part of the conversation; so is the
// `task_edits` block a user turn may open with.
export function visibleHistory(serverMessages) {
  return (Array.isArray(serverMessages) ? serverMessages : [])
    .filter(m => m && !m.seed && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({
      role: m.role,
      // A dialog answer shows as the picks themselves, not the server's `Answer to "…": …` line.
      content: m.role === 'user' && m.dialogAnswer
        ? (answerSummary(m.dialogAnswer) || stripTaskEditNote(m.content))
        : stripTaskEditNote(m.content),
      ...(m.role === 'user' && m.dialogAnswer ? { dialogAnswer: { dialogId: m.dialogAnswer.dialogId } } : {}),
      dialogs: Array.isArray(m.dialogs) ? m.dialogs.slice() : [],
      tools: Array.isArray(m.tools) ? m.tools.slice() : [],
      taskEvents: Array.isArray(m.taskEvents) ? m.taskEvents.slice() : [],
    }));
}

// Tool and dialog frames are re-sent with the same id whenever the record changes: replace in
// place, append when new. Returns the same array.
export function upsertById(list, item) {
  if (!Array.isArray(list) || !item || item.id == null) return list;
  const i = list.findIndex(x => x && x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
  return list;
}

// Short tool name for the status line: `mcp__tipatask__update_task` -> `update_task`.
export function shortToolName(name) {
  const s = typeof name === 'string' ? name : '';
  const parts = s.split('__');
  return parts[parts.length - 1] || s;
}

// ── Attachments in user messages ──
// The composer's Embed / paste / drop insert the objective chat's references: `![img](<base>/api/
// projects/<p>/images/<i>)` for an image, `[name](<base>/api/projects/<p>/files/<i>)` for a file.
// In the transcript they show as thumbnails and chips below the message text. The URLs are
// rewritten to the same-origin proxies, as renderMarkdown() (utils.js) does for rendered markdown.
const ATTACHMENT_REF_RE = /(!?)\[([^\]\n]*)\]\(\s*<?([^()\s<>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;
const IMAGE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/\s]+)?\/api\/projects\/(\d+)\/images\/(\d+)(?:[?#]\S*)?$/i;
const FILE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/\s]+)?\/api\/projects\/(\d+)\/files\/(\d+)(?:[?#]\S*)?$/i;

// `{ text, attachments }`: the message text with every attachment reference taken out, and the
// references in order — `{ kind: 'image', name, src, href }` / `{ kind: 'file', name, href }`.
// Other links, and an image still uploading (`blob:` URL), stay in the text.
export function splitAttachmentRefs(text) {
  const source = typeof text === 'string' ? text : '';
  const attachments = [];
  if (!source.includes('/api/projects/')) return { text: source, attachments };
  const rest = source.replace(ATTACHMENT_REF_RE, (whole, bang, name, url) => {
    const image = IMAGE_URL_RE.exec(url);
    if (image) {
      const proxy = `/api/images/${image[1]}/${image[2]}`;
      attachments.push({ kind: 'image', name: name.trim(), src: proxy, href: proxy });
      return '';
    }
    const file = FILE_URL_RE.exec(url);
    if (file) {
      attachments.push({ kind: 'file', name: name.trim(), href: `/api/files/${file[1]}/${file[2]}` });
      return '';
    }
    return whole;
  });
  if (!attachments.length) return { text: source, attachments };
  const cleaned = rest
    .split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, attachments };
}

// The thumbnails and chips of `attachments` (splitAttachmentRefs()). Each is a
// `.file-attachment-link`, so file-attach.js's delegated handler opens it outside the app.
export function attachmentsHtml(attachments, { t } = {}) {
  const tr = typeof t === 'function' ? t : key => key;
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return '';
  const items = list.map((a) => {
    if (a && a.kind === 'image') {
      // A pasted image carries the alt text `img`; name it plainly instead.
      const name = a.name && a.name !== 'img' ? a.name : tr('taskChat.embed.image');
      return `<a class="file-attachment-link task-chat-attach task-chat-attach--image" href="${esc(a.href)}" title="${esc(name)}">`
        + `<img src="${esc(a.src)}" alt="${esc(name)}" loading="lazy"></a>`;
    }
    if (a && a.kind === 'file') {
      const name = a.name || tr('taskChat.embed.file');
      return `<a class="file-attachment-link task-chat-attach task-chat-attach--file" href="${esc(a.href)}" title="${esc(name)}">`
        + '<span class="task-chat-attach-icon" aria-hidden="true"></span>'
        + `<span class="task-chat-attach-name">${esc(name)}</span></a>`;
    }
    return '';
  }).join('');
  return `<div class="task-chat-attachments">${items}</div>`;
}

// A user message's body: its text (escaped, newlines kept by CSS), then its attachments.
export function userMessageHtml(text, { t } = {}) {
  const { text: rest, attachments } = splitAttachmentRefs(text);
  return (rest ? `<div class="task-chat-user-text">${esc(rest)}</div>` : '') + attachmentsHtml(attachments, { t });
}

// An image whose upload failed leaves its `![…](blob:…)` placeholder behind: drop every one once
// no upload is pending any more.
const PENDING_IMAGE_REF_RE = /!\[[^\]\n]*\]\(blob:[^)\s]*\)/g;

export function stripPendingImageRefs(text) {
  if (typeof text !== 'string' || !text.includes('](blob:')) return typeof text === 'string' ? text : '';
  return text.replace(PENDING_IMAGE_REF_RE, '');
}
