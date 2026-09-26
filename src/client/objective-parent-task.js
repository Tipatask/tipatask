// ── Objective-chat save payload: auto-created objective parent task (C1339) ──
// Pure, DOM-free — importable under `node --test` (mirrors objective-spec-payload.js's
// extraction reason: chat-task-preview.js transitively pulls in browser-only modules via
// console-modal.js's raw .css import, which fails under plain Node).
//
// Every New Objective chat save (bulk "Save Tasks" or single-card Accept), when NOT in
// subtask mode (cs.parentTaskKey unset), auto-creates one `is_objective` parent task and
// stamps it as `parentId` on every newly-saved card. There is no client-reachable
// `POST /api/tasks` route (api.tasks only has get/update/delete/listAll), so the parent
// rides along as one extra entry in the same `data.tasks` / `newTaskIds` PUT payload the
// cards already use — the server's overwriteRawWithRemap() reserves it a real key,
// rewrites the children's parentId refs to it, resolves the parent_id FK, and finalizes
// it, all inside one atomic PUT /api/todo. See ai/architecture/tt-objective-chat.md
// "Objective Parent Task (C1339)" for the full mechanism writeup.

import { upsertTaskEntry } from './utils.js';

export const OBJECTIVE_PROMPT_SEPARATOR = '\n\n<hr>\n\n';
export const OBJECTIVE_TITLE_MAX = 60; // matches the planner's own "Titles ≤60 chars" rule

let _newParentClientIdSeq = 0;

// ── Collect the chat's user prompts, chronological, deduped, always starting with the
// very first prompt ──
// Returns [{ content, timestamp: number|null }].
// - Only role:'user' messages with non-blank content.
// - Collapses consecutive duplicate contents — chat-ui.js's auto-retry paths (auth
//   refresh restart, ws reconnect, etc.) re-push the identical prompt text verbatim, and
//   without this the description would repeat the first prompt up to 4x.
// - Prepends cs.originalUserText (timestamp: null) when it's non-blank and differs from
//   the first collected entry — covers history windowing (historyWindowStart > 1 /
//   hasOlderHistory) or a chat-history-reset wholesale replacement, where messages[0] is
//   no longer the true first prompt. This is what guarantees "starting with the very
//   first prompt" even when cs.messages itself has been trimmed.
export function collectObjectivePrompts(cs) {
  if (!cs || !Array.isArray(cs.messages)) return [];
  const entries = [];
  let lastContent = null;
  for (const m of cs.messages) {
    if (!m || m.role !== 'user') continue;
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!content) continue;
    if (content === lastContent) continue; // consecutive-duplicate collapse
    entries.push({ content, timestamp: typeof m.timestamp === 'number' ? m.timestamp : null });
    lastContent = content;
  }
  const original = typeof cs.originalUserText === 'string' ? cs.originalUserText.trim() : '';
  if (original && entries[0]?.content !== original) {
    entries.unshift({ content: original, timestamp: null });
  }
  return entries;
}

// epoch ms -> 'YYYY-MM-DD HH:mm' local time. Deterministic (no toLocaleString, whose
// output depends on the runtime's locale/ICU data).
export function formatObjectiveTimestamp(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// prompts: [{ content, timestamp }] -> markdown string, entries joined by
// OBJECTIVE_PROMPT_SEPARATOR (verbatim <hr>, per spec). Each entry renders as a bold
// local-time heading above its prompt text; the heading line is omitted when
// timestamp is null (the prepended cs.originalUserText case above).
export function formatObjectivePromptHistory(prompts, { formatTimestamp = formatObjectiveTimestamp } = {}) {
  if (!Array.isArray(prompts) || prompts.length === 0) return '';
  return prompts
    .map(p => (p.timestamp != null ? `**${formatTimestamp(p.timestamp)}**\n\n${p.content}` : p.content))
    .join(OBJECTIVE_PROMPT_SEPARATOR);
}

function truncateTitle(text, max) {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trim() + '…';
}

// Strip markdown link/image syntax down to its label text, e.g. "[label](url)" -> "label",
// "![alt](url)" -> "alt" — a raw prompt sometimes pastes a markdown link as its first line.
function stripMarkdownLinks(text) {
  return String(text || '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
}

// summary (planner's objective_summary, LLM-written scope summary) wins when present —
// same quality bar as any other generated task's title. Falls back to the first
// collected prompt, then cs.originalUserText, then a static default.
export function deriveObjectiveTitle(cs, { summary = null, max = OBJECTIVE_TITLE_MAX } = {}) {
  const fromSummary = truncateTitle(stripMarkdownLinks(summary), max);
  if (fromSummary) return fromSummary;
  const prompts = collectObjectivePrompts(cs);
  const fromPrompt = truncateTitle(stripMarkdownLinks(prompts[0]?.content), max);
  if (fromPrompt) return fromPrompt;
  const fromOriginal = truncateTitle(stripMarkdownLinks(cs?.originalUserText), max);
  if (fromOriginal) return fromOriginal;
  return 'New objective';
}

// `new-obj-<base36 ts>-<base36 seq>` — deliberately unlike a live key (never a live
// reservation placeholder), same convention chat-task-preview.js's
// ensureNewTaskClientId() uses for card ids. assignIncomingNewTaskIds() (api-backend.js)
// then reserves it a real C### key server-side.
export function newObjectiveParentClientId(now = Date.now(), usedIds = new Set()) {
  let next;
  do {
    _newParentClientIdSeq += 1;
    next = `new-obj-${now.toString(36)}-${_newParentClientIdSeq.toString(36)}`;
  } while (usedIds.has(next));
  return next;
}

// Skip conditions: grouping disabled project-wide (projects.use_objective_grouping = 0,
// C1558 — opts.groupingEnabled defaults true so every pre-C1558 caller/test keeps today's
// behavior), subtask mode (cs.parentTaskKey already targets an existing parent), this chat
// already created/reused a parent (cs.objectiveParentKey set), or fewer than two new tasks —
// a lone task needs no container (C1415).
export function shouldCreateObjectiveParent(cs, newTaskCount, { groupingEnabled = true } = {}) {
  if (!cs) return false;
  if (!groupingEnabled) return false;
  if (cs.parentTaskKey) return false;
  if (cs.objectiveParentKey) return false;
  return Number(newTaskCount) > 1;
}

// -> parent task object, or null when there is no prompt text at all (nothing to
// summarize/describe — should not happen in practice since a save always follows at
// least one sent prompt, but never fabricate a parent from nothing).
export function buildObjectiveParentTask(cs, { id, status, assignee = null, summary = null } = {}) {
  const prompts = collectObjectivePrompts(cs);
  if (prompts.length === 0) return null;
  return {
    id,
    title: deriveObjectiveTitle(cs, { summary }),
    description: formatObjectivePromptHistory(prompts),
    category: 'CODING', // never HUMAN — assignIncomingNewTaskIds reserves H### only for category==='HUMAN'
    status,
    priority: 0, // caller (insertObjectiveParent) overwrites once children's priorities are final
    order: 0,
    dependencies: [], // a container, never part of the dep graph
    tags: [], // MUST stay empty — overwriteRaw() hard-throws the whole save on any unregistered tag
    assignee,
    isObjective: true,
  };
}

// Mutates data.tasks (via upsertTaskEntry, never a bare push — same C1378 invariant
// every other save-path insertion follows) and stamps parentId on every entry in
// childTasks. priority = max(children priorities) so the parent shows up at its LAST
// child's sprint (C1425 — highest priority = current/first-shown sprint per `ORDER BY
// priority DESC`); order = max(existing same-priority order) + 1 so it renders ABOVE its
// children (order sorts descending everywhere — task-board.js's sortTier() and the API's
// `ORDER BY priority DESC, display_order DESC`). Returns the parent.
export function insertObjectiveParent(data, parent, childTasks) {
  const children = Array.isArray(childTasks) ? childTasks : [];
  const priorities = children.map(t => Number(t?.priority ?? 0));
  parent.priority = priorities.length ? Math.max(...priorities) : 0;
  const tasks = (data && Array.isArray(data.tasks)) ? data.tasks : [];
  const samePriority = tasks.filter(t => Number(t?.priority ?? 0) === parent.priority);
  const maxOrder = samePriority.length ? Math.max(...samePriority.map(t => Number(t?.order ?? 0))) : 0;
  parent.order = maxOrder + 1;
  upsertTaskEntry(tasks, parent);
  for (const t of children) t.parentId = parent.id;
  return parent;
}
