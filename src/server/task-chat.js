'use strict';

// Task chat — a multi-turn agent chat scoped to one task or project.
// The agent reads the KB and source and changes tasks, never code; the fence itself lives in
// providers/tool-profiles.js. This module builds what the agent is told: the system prompt
// (per provider, because the tool names differ) and the first-turn seed. Pure — no I/O.

const BaseTaskAgent = require('./task-agent/base-agent');
const { TASK_CHAT, PI_TASK_API_TOOL } = require('./providers/tool-profiles');
const { ASK_USER_CONTRACT } = require('./task-chat-widgets');

const TASK_CHAT_ID_PREFIX = 'taskChat:';
const PROJECT_CHAT_ID_PREFIX = 'projectChat:';
const DEFAULT_OPENING_MESSAGE = 'Read the task above, then tell me in two or three sentences what it is about and ask what I want to discuss.';
const DEFAULT_PROJECT_OPENING_MESSAGE = 'Read the project context above, then briefly introduce what you can help with and ask what I want to discuss.';
const MAX_SEED_TASKS = 50;

// Seed budget: the newest comments matter most, and one pasted log must not crowd out the rest.
const MAX_SEED_COMMENTS = 30;
const MAX_SEED_COMMENT_CHARS = 4000;

function isTaskChatId(id) {
  return typeof id === 'string' && id.startsWith(TASK_CHAT_ID_PREFIX);
}

function taskKeyFromChatId(id) {
  return isTaskChatId(id) ? id.slice(TASK_CHAT_ID_PREFIX.length) : '';
}

function isProjectChatId(id) {
  return typeof id === 'string' && /^projectChat:[1-9]\d*$/.test(id);
}

function projectIdFromChatId(id) {
  return isProjectChatId(id) ? id.slice(PROJECT_CHAT_ID_PREFIX.length) : '';
}

function commentTime(comment) {
  const t = Date.parse(comment && (comment.created_at || comment.createdAt));
  return Number.isFinite(t) ? t : 0;
}

function seedComments(comments) {
  if (!Array.isArray(comments)) return [];
  return comments
    .filter(c => c && typeof c.content === 'string' && c.content.trim())
    .sort((a, b) => commentTime(a) - commentTime(b))
    .slice(-MAX_SEED_COMMENTS)
    .map(c => (c.content.length > MAX_SEED_COMMENT_CHARS
      ? { ...c, content: `${c.content.slice(0, MAX_SEED_COMMENT_CHARS)}\n… (comment truncated)` }
      : c));
}

// First user message of a task chat: the task as the backend returned it, its comment history,
// then the opening ask. Clients hide this message (it carries `seed: true` in session.messages).
function buildTaskChatSeed({ task, comments, project, tasks, openingMessage } = {}) {
  if (project) {
    const summary = Array.isArray(tasks) ? tasks
      .filter(row => row && row.id && !row.isReservation)
      .slice(0, MAX_SEED_TASKS)
      .map(row => ({ id: row.id, title: row.title, status: row.status, priority: row.priority })) : [];
    return [
      `This chat is about project ${project.name || project.id}:\n\n\`\`\`json\n${JSON.stringify(project, null, 2)}\n\`\`\``,
      `## Existing Tasks\n${summary.length ? JSON.stringify(summary, null, 2) : '(none)'}`,
      Array.isArray(tasks) && tasks.length > MAX_SEED_TASKS ? `Showing first ${MAX_SEED_TASKS} tasks. Use task tools for the full current list.` : '',
      String(openingMessage || '').trim() || DEFAULT_PROJECT_OPENING_MESSAGE,
    ].filter(Boolean).join('\n\n');
  }
  const parts = [`This chat is about task ${task && task.id}:\n\n\`\`\`json\n${JSON.stringify(task, null, 2)}\n\`\`\``];
  const commentsBlock = BaseTaskAgent.formatTaskCommentsBlock(seedComments(comments));
  parts.push(commentsBlock || '## Task Comments\n(none)');
  parts.push(String(openingMessage || '').trim() || DEFAULT_OPENING_MESSAGE);
  return parts.join('\n\n');
}

function mcpToolsSection(provider) {
  const read = provider === 'codex'
    ? '- Source and KB files: read them with your shell. The sandbox is read-only — any write fails.'
    : '- Source and KB files: the `Read` tool.';
  return [
    'Tools you have:',
    read,
    '- Code search across architecture tags: `batch_grep_tags` on the `tipatask-local` MCP server (pass `symbols` for extra patterns).',
    '- Knowledge base: `list_system_tags`, `get_tag_architecture`, `get_tag_architectures`, `get_project_tags`, `list_task_resolutions` on the `tipatask` MCP server.',
    '- Tasks: `list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task`, `create_task_comment` on the `tipatask` MCP server.',
    '- Tags: `ensure_project_tag` (plain tags) and `create_system_tag` (`tt-*` tags) — register a tag with a real description before putting it on a task.',
  ].join('\n');
}

function piToolsSection(projectChat = false) {
  return [
    'Tools you have:',
    '- Source and KB files: `read`, `grep`, `find`, `ls`. Architecture docs live in `ai/architecture/` (`GENERAL.md`, `tt-*.md`, index in `_index.json`).',
    `- Tasks, comments and tags: the \`${PI_TASK_API_TOOL}\` tool. It takes \`method\`, a project-relative \`path\` and, for POST/PATCH, a JSON \`body\`. There is no shell and no curl; this tool is the only way to reach the API. Recipe:`,
    '  - read a task: GET /tasks/<KEY> — its comments: GET /tasks/<KEY>/comments',
    '  - list tasks: GET /tasks?status=<status>&fields=summary&limit=20',
    '  - update a task: PATCH /tasks/<KEY> with any of {"title","description","status","priority","tags","assignee","due_date","dependencies","parent_id","story_points"}',
    projectChat
      ? '  - create a task: POST /tasks with {"title","description","category":"CODING","priority":<chosen sprint or backlog>,"tags":[...]}'
      : '  - create a task: POST /tasks with {"title","description","category":"CODING","priority":<same as this task unless told otherwise>,"tags":[...]}',
    '  - comment on a task: POST /tasks/<KEY>/comments with {"content":"...","type":"comment"}',
    '  - delete a task: DELETE /tasks/<KEY>',
    '  - tag table: GET /tags — register tags before using them: POST /tags with {"tags":[{"name":"...","description":"..."}]}',
    '  - statuses, members, sprints: GET /statuses, GET /members, GET /sprints',
    '  - shared KB files: GET /knowledge (list), GET /knowledge/<file_key>',
    '  Never invent an endpoint that is not listed here; the tool rejects everything else.',
  ].join('\n');
}

// System prompt for one task-chat turn. `provider` picks the tool vocabulary; rebuild it
// whenever the session's provider changes. Plain prose on purpose — this is a conversation,
// not the objective planner. The one structured thing it asks for is the `ask_user` block
// (task-chat-widgets.js), which the server turns into a dialog frame.
function buildTaskChatSystemPrompt({ provider, task, project, langDirective } = {}) {
  const projectChat = !!project && !task;
  const key = (task && task.id) || 'this task';
  const title = task && task.title ? ` ("${task.title}")` : '';
  const lines = [
    projectChat
      ? `PROJECT CHAT. You are talking with the user about project ${project.name || project.id} inside Tipatask. No task is selected.`
      : `TASK CHAT. You are talking with the user about task ${key}${title} inside Tipatask.`,
    'This is a conversation, not a task-execution session: the "Working on a task" workflow in CLAUDE.md / AGENTS.md does not apply here. Do not set the task in progress or completed, post a resolution comment, or commit anything unless the user asks for that specific change.',
    '',
    'What you do:',
    projectChat
      ? '- Answer questions about this project and its tasks. Ground answers in the knowledge base and the source — read before you assert.'
      : '- Answer questions about this task, its history, related tasks and the project. Ground answers in the knowledge base and the source — read before you assert.',
    '- Create, update, comment on, tag and delete tasks when the user asks for it or agrees to it. Afterwards say exactly what you changed, with task keys.',
    '',
    'Hard limits:',
    projectChat
      ? '- You cannot change code or any file in the repository, and you must not try. File-editing and shell-write tools are switched off for this chat. When the user wants a code change, say that this chat cannot edit code and offer to create or update a task instead.'
      : '- You cannot change code or any file in the repository, and you must not try. File-editing and shell-write tools are switched off for this chat. When the user wants a code change, say that task chat cannot edit code and offer to record it instead: update this task\'s description, or create a new task.',
    '- Delete a task only on an explicit request that names it.',
    '- Never set the status of an objective (parent) task yourself; it closes when its subtasks close.',
    projectChat
      ? '- There is no task whose priority you can inherit. Check project sprints and existing tasks before choosing a new task\'s priority; ask the user when placement is unclear.'
      : `- A task you create inherits the priority of task ${key} unless the user says otherwise.`,
    '- In task descriptions, escape `~` as `\\~`.',
    '',
    provider === 'pi' ? piToolsSection(projectChat) : mcpToolsSection(provider),
    '',
    ASK_USER_CONTRACT,
    '',
    'Apart from that block, reply in plain conversational prose; markdown is fine. Keep answers short unless the user asks for depth.',
  ];
  const prompt = lines.join('\n');
  return langDirective ? `${langDirective}\n\n${prompt}` : prompt;
}

// Codex takes no tool flags for MCP, so the fence is also stated at the top of every fresh
// prompt (the config-level filters in tool-profiles.js are the enforcement).
const CODEX_TASK_CHAT_FENCE =
  'You are in a task chat. You may call the tipatask MCP task, comment, tag and knowledge-base tools. ' +
  'You must never modify, create or delete any file, and never run a command that writes to disk or changes git state — ' +
  'the sandbox is read-only and will reject it.';

module.exports = {
  TASK_CHAT,
  TASK_CHAT_ID_PREFIX,
  PROJECT_CHAT_ID_PREFIX,
  DEFAULT_OPENING_MESSAGE,
  DEFAULT_PROJECT_OPENING_MESSAGE,
  MAX_SEED_TASKS,
  MAX_SEED_COMMENTS,
  MAX_SEED_COMMENT_CHARS,
  CODEX_TASK_CHAT_FENCE,
  isTaskChatId,
  taskKeyFromChatId,
  isProjectChatId,
  projectIdFromChatId,
  buildTaskChatSeed,
  buildTaskChatSystemPrompt,
};
