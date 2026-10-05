'use strict';

// Task chat widgets — turns what a provider streams during a task-chat turn into typed frames a
// client can draw: `task-chat-dialog` (the agent asks the user to choose), `task-chat-tool` (a
// tool call and how it ended) and, through the session's onTaskChatMutation hook,
// `task-chat-task` (a task the agent created or updated). Shared by the Claude, Codex and Pi
// turn loops, which only translate their own stream events into the calls below. No I/O.

const crypto = require('node:crypto');

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;
const MAX_QUESTION_CHARS = 500;
const MAX_LABEL_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_OTHER_CHARS = 2000;
const MAX_INPUT_STRING_CHARS = 500;
const MAX_INPUT_ITEMS = 20;
const MAX_INPUT_DEPTH = 3;
const MAX_ERROR_CHARS = 300;

const REMOTE_MCP = 'tipatask';
const LOCAL_MCP = 'tipatask-local';
// Pi's MCP bridge names a tool `<server>__<tool>` with no `mcp__` prefix. Only the two Tipatask
// servers are recognized, so an unrelated tool name containing `__` keeps its bare identity.
const PI_BRIDGED_RE = new RegExp(`^(${LOCAL_MCP}|${REMOTE_MCP})__(.+)$`);
const PI_TASK_API_TOOL = 'tipatask_api';

// The dialog block is tagged `ask_user`, never `json`: a ```json fence in a chat reply is the
// objective planner's proposal format.
const ASK_USER_CONTRACT = [
  'Asking the user to choose:',
  '- You have no interactive question tool. When the user has to pick between concrete options before you can go on, end your reply with exactly one fenced block tagged `ask_user`, then stop and wait — the choice arrives as the user\'s next message.',
  '- The block holds one JSON object: "question" (one sentence), "options" (2 to 8 entries, each {"label": "...", "description": "..."}; the description is optional) and "multi" (true when several options may be picked together, otherwise false).',
  '- Do not add an "Other" option; the user can always type a free answer instead. Ask an open question in plain prose, without a block.',
  '',
  '```ask_user',
  '{"question": "Where should the new task go?", "options": [{"label": "Current sprint", "description": "Same priority as this task"}, {"label": "Backlog"}], "multi": false}',
  '```',
].join('\n');

// Codex and Pi read the system prompt only on a fresh or handoff turn, so resumed turns carry
// this one line instead (providers/transcript.js).
const ASK_USER_REMINDER =
  '(Reminder: when I have to choose between concrete options, end your reply with one fenced ```ask_user block holding {"question", "options": [{"label", "description"}], "multi"} and wait for my answer.)';

const ASK_USER_RE = /```ask_user[^\n]*\n([\s\S]*?)```/gi;

function clip(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeOption(raw) {
  if (typeof raw === 'string') {
    const label = clip(raw, MAX_LABEL_CHARS);
    return label ? { label, description: '' } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const label = clip(raw.label ?? raw.title ?? raw.value, MAX_LABEL_CHARS);
  if (!label) return null;
  return { label, description: clip(raw.description, MAX_DESCRIPTION_CHARS) };
}

// One parsed `ask_user` object -> { id, question, options, multi }, or null when it is not a
// usable dialog. The id is a content hash, so re-scanning the same text yields the same dialog.
function normalizeDialog(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const question = clip(raw.question, MAX_QUESTION_CHARS);
  if (!question || !Array.isArray(raw.options)) return null;
  const options = [];
  for (const entry of raw.options) {
    const option = normalizeOption(entry);
    if (!option || options.some(o => o.label === option.label)) continue;
    options.push(option);
    if (options.length === MAX_OPTIONS) break;
  }
  if (options.length < MIN_OPTIONS) return null;
  const multi = raw.multi === true || raw.multiSelect === true || raw.multiple === true;
  const id = `dlg-${crypto.createHash('sha1').update(JSON.stringify({ question, options, multi })).digest('hex').slice(0, 12)}`;
  return { id, question, options, multi };
}

// Every complete, valid `ask_user` block in the text, in order. A block still streaming (no
// closing fence, or JSON that does not parse yet) is skipped and picked up on a later scan.
function parseAskUserBlocks(text) {
  const dialogs = [];
  if (typeof text !== 'string' || !/```ask_user/i.test(text)) return dialogs;
  for (const match of text.matchAll(ASK_USER_RE)) {
    let parsed;
    try { parsed = JSON.parse(match[1]); } catch { continue; }
    const dialog = normalizeDialog(parsed);
    if (dialog && !dialogs.some(d => d.id === dialog.id)) dialogs.push(dialog);
  }
  return dialogs;
}

// ── Per-turn state ────────────────────────────────────────────────────────────

function turnState(session) {
  if (!session._taskChatTurn) {
    session._taskChatTurn = { dialogs: [], tools: [], taskEvents: [], sent: new Map(), inputs: new Map() };
  }
  return session._taskChatTurn;
}

function resetTaskChatTurn(session) {
  session._taskChatTurn = null;
}

// Default transport: the session's own socket. Codex and Pi pass their `emit` instead.
function sessionSender(session) {
  return (frame) => {
    if (session.ws && session.ws.readyState === session.ws.OPEN) {
      session.ws.send(JSON.stringify({ ...frame, tabId: session.tabId }));
    }
  };
}

function dialogFrame(session, dialog) {
  return { type: 'task-chat-dialog', taskKey: session.taskKey, dialog };
}

function toolFrame(session, tool) {
  return { type: 'task-chat-tool', taskKey: session.taskKey, tool: { ...tool } };
}

function taskFrame(session, event) {
  return { type: 'task-chat-task', taskKey: session.taskKey, action: event.action, toolId: event.toolId, task: event.task };
}

// Scan the turn's text and send a frame for each dialog not sent yet this turn.
function emitDialogs(session, send = sessionSender(session)) {
  const found = parseAskUserBlocks(session.turnBuffer);
  if (found.length === 0) return [];
  const turn = turnState(session);
  const fresh = found.filter(dialog => !turn.dialogs.some(d => d.id === dialog.id));
  for (const dialog of fresh) {
    turn.dialogs.push(dialog);
    send(dialogFrame(session, dialog));
  }
  return fresh;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

// `mcp__<server>__<tool>` (Claude), an explicit server + tool (Codex) or Pi's bridged
// `<server>__<tool>` -> one naming scheme.
function toolIdentity({ name, server, tool }) {
  if (server && tool) return { name: `mcp__${server}__${tool}`, server, tool };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name || '');
  if (mcp) return { name, server: mcp[1], tool: mcp[2] };
  const bridged = PI_BRIDGED_RE.exec(name || '');
  if (bridged) return { name: `mcp__${bridged[1]}__${bridged[2]}`, server: bridged[1], tool: bridged[2] };
  return { name: name || tool || 'tool', server: '', tool: name || tool || 'tool' };
}

function capValue(value, depth) {
  if (typeof value === 'string') {
    return value.length > MAX_INPUT_STRING_CHARS ? `${value.slice(0, MAX_INPUT_STRING_CHARS)}…` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_INPUT_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) return value.slice(0, MAX_INPUT_ITEMS).map(v => capValue(v, depth + 1));
  const out = {};
  for (const key of Object.keys(value).slice(0, MAX_INPUT_ITEMS)) out[key] = capValue(value[key], depth + 1);
  return out;
}

// What a tool frame shows of the call's arguments. An empty object means "not known yet" —
// Claude announces a tool before its input has streamed.
function previewInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length === 0) return undefined;
  return capValue(input, 0);
}

function sendTool(session, send, turn, tool) {
  const json = JSON.stringify(tool);
  if (turn.sent.get(tool.id) === json) return false;
  turn.sent.set(tool.id, json);
  send(toolFrame(session, tool));
  return true;
}

function setInput(turn, record, input) {
  const preview = previewInput(input);
  if (!preview) return;
  turn.inputs.set(record.id, input);
  record.input = preview;
}

// A tool call began, or (same id again) its arguments are now known. One frame per change.
function toolStarted(session, send, { id, name, server, tool, input } = {}) {
  const turn = turnState(session);
  const identity = toolIdentity({ name, server, tool });
  const toolId = id || `${identity.name}#${turn.tools.length + 1}`;
  let record = turn.tools.find(t => t.id === toolId);
  if (!record) {
    record = { id: toolId, ...identity, status: 'running' };
    turn.tools.push(record);
  }
  if (record.input === undefined) setInput(turn, record, input);
  sendTool(session, send || sessionSender(session), turn, record);
  return record;
}

// A tool result as text, whatever shape the provider hands over: a string, an array of content
// blocks, or an object wrapping one.
function resultText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(block => (block && typeof block.text === 'string' ? block.text : resultText(block && block.content))).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.content != null) return resultText(value.content);
    if (typeof value.message === 'string') return value.message;
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return String(value);
}

// Pi's REST tool reports a failed request as ordinary text, not as a tool error.
function restFailure(record, text) {
  if (record.tool !== PI_TASK_API_TOOL) return '';
  return /^HTTP 2\d\d\b/.test(text) ? '' : (text.split('\n')[0] || 'request failed');
}

const TASK_KEY_RE = /^[A-Za-z]+\d+$/;

function keyOf(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const candidate of [obj.task_key, obj.id, obj.key]) {
    if (typeof candidate === 'string' && TASK_KEY_RE.test(candidate)) return candidate;
  }
  return '';
}

// The task key a create/update call answered with. Handles the MCP tools' JSON, Pi's
// `HTTP 201\n{...}` and, for a body cut short, a plain text search.
function taskKeyFromResult(text) {
  const body = String(text || '').replace(/^HTTP \d+[^\n]*\n/, '').trim();
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const key = keyOf(parsed && parsed.task) || keyOf(parsed);
    if (key) return key;
  } catch { /* truncated or not JSON — fall through */ }
  const match = /"task_key"\s*:\s*"([A-Za-z]+\d+)"/.exec(body) || /"id"\s*:\s*"([A-Za-z]+\d+)"/.exec(body);
  return match ? match[1] : '';
}

// Is this call one that creates or updates a task? -> { action, taskKey } | null. `taskKey` is
// empty for a create: the key only exists in the result.
function classifyTaskMutation({ name, server, tool, input } = {}) {
  const identity = toolIdentity({ name, server, tool });
  const args = input && typeof input === 'object' ? input : {};
  if (identity.server === REMOTE_MCP) {
    if (identity.tool === 'create_task') return { action: 'created', taskKey: '' };
    if (identity.tool === 'update_task') return { action: 'updated', taskKey: typeof args.task_key === 'string' ? args.task_key : '' };
    return null;
  }
  if (identity.tool === PI_TASK_API_TOOL) {
    const method = String(args.method || 'GET').toUpperCase();
    const path = String(args.path || '').split('?')[0].replace(/\/+$/, '');
    if (method === 'POST' && /^\/?tasks$/.test(path)) return { action: 'created', taskKey: '' };
    const patch = method === 'PATCH' && /^\/?tasks\/([^/]+)$/.exec(path);
    if (patch) return { action: 'updated', taskKey: patch[1] };
  }
  return null;
}

// A tool call ended. Sends its closing frame once; a successful create/update also reaches the
// session's onTaskChatMutation hook, whose (possibly async) return value is kept as a task event.
function toolFinished(session, send, { id, name, server, tool, input, isError, result } = {}) {
  const turn = turnState(session);
  let record = id ? turn.tools.find(t => t.id === id) : null;
  if (!record && !id) {
    const identity = toolIdentity({ name, server, tool });
    record = [...turn.tools].reverse().find(t => t.status === 'running' && t.name === identity.name) || null;
  }
  if (!record) record = toolStarted(session, send, { id, name, server, tool, input });
  if (record.status !== 'running') return record;
  if (record.input === undefined) setInput(turn, record, input);

  const text = resultText(result);
  const failure = isError ? (text || 'tool error') : restFailure(record, text);
  record.status = failure ? 'error' : 'done';
  if (failure) record.error = clip(failure, MAX_ERROR_CHARS);
  sendTool(session, send || sessionSender(session), turn, record);

  if (!failure && typeof session.onTaskChatMutation === 'function') {
    const mutation = classifyTaskMutation({ ...record, input: turn.inputs.get(record.id) });
    const taskKey = mutation && (mutation.taskKey || taskKeyFromResult(text));
    if (taskKey) {
      Promise.resolve()
        .then(() => session.onTaskChatMutation({ action: mutation.action, taskKey, toolId: record.id }))
        .then((event) => { if (event && event.task) turn.taskEvents.push(event); })
        .catch(() => { /* the hook reports its own failures */ });
    }
  }
  return record;
}

// ── History and reconnect ─────────────────────────────────────────────────────

// Hang the turn's widgets on its assistant message so `chat-history-reset` carries them. The
// arrays are shared, not copied: a task event that resolves after the turn closed still lands.
function attachTaskChatWidgets(session, assistantMsg) {
  const turn = session._taskChatTurn;
  if (!turn || !assistantMsg) return;
  assistantMsg.dialogs = turn.dialogs;
  assistantMsg.tools = turn.tools;
  assistantMsg.taskEvents = turn.taskEvents;
}

// Re-send the running turn's widgets to a client that attached mid-turn.
function replayTaskChatTurn(session, send = sessionSender(session)) {
  const turn = session._taskChatTurn;
  if (!turn) return;
  for (const tool of turn.tools) send(toolFrame(session, tool));
  for (const event of turn.taskEvents) send(taskFrame(session, event));
  for (const dialog of turn.dialogs) send(dialogFrame(session, dialog));
}

// ── Answers ───────────────────────────────────────────────────────────────────

// The dialog a `task-chat-answer` may answer: one on the chat's latest message, not yet answered.
function findOpenDialog(messages, dialogId) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  if (!last || last.role !== 'assistant' || !Array.isArray(last.dialogs)) return { error: 'There is no open dialog to answer.' };
  const dialog = last.dialogs.find(d => d.id === dialogId);
  if (!dialog) return { error: `Unknown dialog: ${String(dialogId)}` };
  if (dialog.answer) return { error: 'That dialog is already answered.' };
  return { dialog };
}

// Validate a client's pick -> { answer, content } | { error }. `content` is the user turn the
// agent reads; `answer` is what the dialog and that user message keep for the client.
function resolveDialogAnswer(dialog, { selected, other } = {}) {
  const picks = selected === undefined ? [] : selected;
  if (!Array.isArray(picks) || picks.some(i => !Number.isInteger(i) || i < 0 || i >= dialog.options.length)) {
    return { error: '`selected` must be an array of option indexes.' };
  }
  const indexes = [...new Set(picks)].sort((a, b) => a - b);
  const free = typeof other === 'string' ? clip(other, MAX_OTHER_CHARS) : '';
  const total = indexes.length + (free ? 1 : 0);
  if (total === 0) return { error: 'Pick at least one option.' };
  if (!dialog.multi && total !== 1) return { error: 'This dialog takes exactly one answer.' };
  const labels = indexes.map(i => dialog.options[i].label);
  const parts = [...labels];
  if (free) parts.push(labels.length ? `Other: ${free}` : free);
  return {
    answer: { selected: labels, indexes, other: free },
    content: `Answer to "${dialog.question}": ${parts.join('; ')}`,
  };
}

// ── User edits ────────────────────────────────────────────────────────────────

// The agent never sees a task the user edits by hand (the edit goes to the API from the task
// editor), so the next user turn opens with one fenced `task_edits` block holding the tasks as
// they are now. The JSON is a single line: the closing fence is then the only line that starts
// with three backticks, whatever a description contains. A client hides the block.
const TASK_EDITS_RE = /^```task_edits[^\n]*\n[^\n]*\n```[ \t]*\n*/;
const TASK_EDITS_NOTE = 'The user edited these tasks by hand since your last turn. This is their current state.';
const TASK_EDIT_FIELDS = ['title', 'description', 'status', 'priority', 'tags', 'dependencies', 'category', 'assignee', 'agentAssignee', 'due_date'];
const UNORDERED_EDIT_FIELDS = new Set(['tags', 'dependencies']);
const MAX_EDIT_DESCRIPTION_CHARS = 4000;

function comparableField(task, field) {
  const value = task ? task[field] : undefined;
  if (UNORDERED_EDIT_FIELDS.has(field)) return JSON.stringify(Array.isArray(value) ? [...value].map(String).sort() : []);
  return value == null ? '' : String(value);
}

// Which of the fields an agent reasons about differ between two copies of a task. An unknown
// earlier copy yields every field the task has: nothing can be ruled out.
function changedTaskFields(prev, next) {
  if (!next || typeof next !== 'object') return [];
  if (!prev || typeof prev !== 'object') return TASK_EDIT_FIELDS.filter(field => next[field] != null);
  return TASK_EDIT_FIELDS.filter(field => comparableField(prev, field) !== comparableField(next, field));
}

function editedTaskView(task) {
  const view = { id: task.id };
  for (const field of TASK_EDIT_FIELDS) {
    if (task[field] === undefined) continue;
    view[field] = field === 'description' ? clip(task[field], MAX_EDIT_DESCRIPTION_CHARS) : task[field];
  }
  return view;
}

// `edits`: [{ task, changed }] -> the block that opens the next user turn, or '' for none.
function buildTaskEditNote(edits) {
  const tasks = (Array.isArray(edits) ? edits : [])
    .filter(edit => edit && edit.task && edit.task.id)
    .map(edit => ({ task: editedTaskView(edit.task), changed: Array.isArray(edit.changed) ? edit.changed : [] }));
  if (tasks.length === 0) return '';
  return `\`\`\`task_edits\n${JSON.stringify({ note: TASK_EDITS_NOTE, tasks })}\n\`\`\``;
}

module.exports = {
  ASK_USER_CONTRACT,
  ASK_USER_REMINDER,
  TASK_EDITS_RE,
  changedTaskFields,
  buildTaskEditNote,
  parseAskUserBlocks,
  resetTaskChatTurn,
  sessionSender,
  emitDialogs,
  toolStarted,
  toolFinished,
  classifyTaskMutation,
  taskKeyFromResult,
  resultText,
  taskFrame,
  attachTaskChatWidgets,
  replayTaskChatTurn,
  findOpenDialog,
  resolveDialogAnswer,
};
