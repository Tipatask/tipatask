'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isTaskChatId, taskKeyFromChatId, isProjectChatId, projectIdFromChatId,
  buildTaskChatSeed, buildTaskChatSystemPrompt, MAX_SEED_COMMENTS, MAX_SEED_COMMENT_CHARS,
  MAX_SEED_TASKS, DEFAULT_OPENING_MESSAGE, DEFAULT_PROJECT_OPENING_MESSAGE, CODEX_TASK_CHAT_FENCE,
} = require('./task-chat');

const TASK = { id: 'TPT420', title: 'Task chat: server session', description: 'Add a taskChat session.', status: 'in_progress', tags: ['tt-task-chat'], priority: 367 };
const comment = (id, content, extra = {}) => ({ id, content, created_at: new Date(1790000000000 + id * 1000).toISOString(), user: { name: 'Anton' }, ...extra });

test('session ids map to the bare task key', () => {
  assert.equal(isTaskChatId('taskChat:TPT420'), true);
  assert.equal(taskKeyFromChatId('taskChat:TPT420'), 'TPT420');
  for (const id of ['TPT420', 'specChat:TPT420', 'obj-1', '', null]) {
    assert.equal(isTaskChatId(id), false);
    assert.equal(taskKeyFromChatId(id), '');
  }
});

test('project chat ids contain a positive project id and no task key', () => {
  assert.equal(isProjectChatId('projectChat:2'), true);
  assert.equal(projectIdFromChatId('projectChat:2'), '2');
  for (const id of ['projectChat:', 'projectChat:0', 'projectChat:abc', 'taskChat:TPT1', null]) {
    assert.equal(isProjectChatId(id), false);
    assert.equal(projectIdFromChatId(id), '');
  }
});

test('project seed carries bounded project-wide task context without a selected task', () => {
  const project = { id: '2', name: 'Tipatask', description: 'Project work' };
  const tasks = Array.from({ length: MAX_SEED_TASKS + 2 }, (_, i) => ({ id: `TPT${i + 1}`, title: `Task ${i + 1}`, status: 'pending', priority: 3, description: 'private long body' }));
  const seed = buildTaskChatSeed({ project, tasks });
  assert.match(seed, /This chat is about project Tipatask/);
  assert.match(seed, /TPT1/);
  assert.doesNotMatch(seed, /TPT52|private long body|Task Comments/);
  assert.match(seed, /Showing first 50 tasks/);
  assert.ok(seed.endsWith(DEFAULT_PROJECT_OPENING_MESSAGE));
});

test('project prompt keeps task tools and code-write fence without task inheritance', () => {
  for (const provider of ['claude', 'codex', 'pi']) {
    const prompt = buildTaskChatSystemPrompt({ provider, project: { id: '2', name: 'Tipatask' } });
    assert.match(prompt, /PROJECT CHAT/);
    assert.match(prompt, /No task is selected/);
    assert.match(prompt, /cannot change code or any file/);
    assert.match(prompt, /There is no task whose priority you can inherit/);
    assert.doesNotMatch(prompt, /update this task's description|same as this task unless told otherwise/);
    assert.doesNotMatch(prompt, /READ-ONLY PLANNER/);
    assert.doesNotMatch(prompt, /```json/);
  }
});

test('the seed carries the task JSON, its comments and the opening ask', () => {
  const seed = buildTaskChatSeed({
    task: TASK,
    comments: [comment(2, 'Second note'), comment(1, 'First note')],
    openingMessage: 'Why is this blocked?',
  });
  assert.match(seed, /This chat is about task TPT420/);
  assert.deepEqual(JSON.parse(seed.match(/```json\n([\s\S]*?)\n```/)[1]), TASK);
  assert.match(seed, /## Task Comments/);
  assert.ok(seed.indexOf('First note') < seed.indexOf('Second note'), 'comments read oldest first');
  assert.match(seed, /\*\*Anton \(/);
  assert.ok(seed.trimEnd().endsWith('Why is this blocked?'));
});

test('a task with no comments, or an unreadable comment list, still seeds', () => {
  for (const comments of [[], null, undefined, 'nope']) {
    const seed = buildTaskChatSeed({ task: TASK, comments });
    assert.match(seed, /## Task Comments\n\(none\)/);
    assert.ok(seed.endsWith(DEFAULT_OPENING_MESSAGE));
  }
});

test('the seed keeps the newest comments and truncates an oversized one', () => {
  const many = Array.from({ length: MAX_SEED_COMMENTS + 5 }, (_, i) => comment(i + 1, `note-${i + 1}-end`));
  many.push(comment(999, `${'x'.repeat(MAX_SEED_COMMENT_CHARS + 500)}TAIL_MARKER`));
  const seed = buildTaskChatSeed({ task: TASK, comments: many });
  assert.ok(!seed.includes('note-1-end'), 'the oldest comments drop out');
  assert.ok(seed.includes(`note-${MAX_SEED_COMMENTS + 5}-end`));
  assert.ok(!seed.includes('TAIL_MARKER'));
  assert.match(seed, /… \(comment truncated\)/);
});

for (const provider of ['claude', 'codex', 'pi']) {
  test(`${provider}: the system prompt states the task-only rule and never asks for planner JSON`, () => {
    const prompt = buildTaskChatSystemPrompt({ provider, task: TASK });
    assert.match(prompt, /TASK CHAT/);
    assert.match(prompt, /TPT420/);
    assert.match(prompt, /cannot change code or any file/);
    assert.match(prompt, /task chat cannot edit code/);
    assert.match(prompt, /Delete a task only on an explicit request/);
    // CLAUDE.md gates planner-only behaviour on this exact substring.
    assert.doesNotMatch(prompt, /READ-ONLY PLANNER/);
    assert.doesNotMatch(prompt, /```json/);
  });

  test(`${provider}: the system prompt carries the ask_user dialog contract`, () => {
    const prompt = buildTaskChatSystemPrompt({ provider, task: TASK });
    assert.match(prompt, /```ask_user\n/);
    assert.match(prompt, /"question"/);
    assert.match(prompt, /"options"/);
    assert.match(prompt, /"multi"/);
    assert.match(prompt, /no interactive question tool/);
  });
}

test('each provider is told about the tools it actually has', () => {
  const claude = buildTaskChatSystemPrompt({ provider: 'claude', task: TASK });
  assert.match(claude, /`update_task`/);
  assert.match(claude, /`batch_grep_tags`/);
  assert.match(claude, /the `Read` tool/);
  assert.doesNotMatch(claude, /tipatask_api/);

  const codex = buildTaskChatSystemPrompt({ provider: 'codex', task: TASK });
  assert.match(codex, /`update_task`/);
  assert.match(codex, /sandbox is read-only/);

  const pi = buildTaskChatSystemPrompt({ provider: 'pi', task: TASK });
  assert.match(pi, /`tipatask_api`/);
  assert.match(pi, /PATCH \/tasks\/<KEY>/);
  assert.match(pi, /no shell and no curl/);
  assert.doesNotMatch(pi, /MCP/);
  assert.doesNotMatch(pi, /\$API_TOKEN|Bearer/, 'credentials never appear in the prompt');
});

test('a project language directive leads the prompt; none leaves it untouched', () => {
  const plain = buildTaskChatSystemPrompt({ provider: 'claude', task: TASK });
  assert.ok(plain.startsWith('TASK CHAT'));
  const uk = buildTaskChatSystemPrompt({ provider: 'claude', task: TASK, langDirective: 'Communicate with the user in Ukrainian.' });
  assert.ok(uk.startsWith('Communicate with the user in Ukrainian.\n\nTASK CHAT'));
});

test('the codex fence permits task tools and forbids file writes', () => {
  assert.match(CODEX_TASK_CHAT_FENCE, /may call the tipatask MCP task/);
  assert.match(CODEX_TASK_CHAT_FENCE, /never modify, create or delete any file/);
});
