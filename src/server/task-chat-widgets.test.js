'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ASK_USER_CONTRACT,
  ASK_USER_REMINDER,
  parseAskUserBlocks,
  resetTaskChatTurn,
  emitDialogs,
  toolStarted,
  toolFinished,
  classifyTaskMutation,
  taskKeyFromResult,
  resultText,
  attachTaskChatWidgets,
  replayTaskChatTurn,
  findOpenDialog,
  resolveDialogAnswer,
  TASK_EDITS_RE,
  changedTaskFields,
  buildTaskEditNote,
} = require('./task-chat-widgets');

const BLOCK = '```ask_user\n{"question": "Which sprint?", "options": [{"label": "Current", "description": "Same as this task"}, "Backlog"], "multi": false}\n```';

function chat(extra = {}) {
  const frames = [];
  const session = { type: 'taskChat', taskKey: 'TPT1', tabId: 'tab-1', turnBuffer: '', messages: [], ...extra };
  return { session, frames, send: frame => frames.push(frame), ofType: type => frames.filter(f => f.type === type) };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('an ask_user block becomes a dialog with normalized options and a stable id', () => {
  const [dialog] = parseAskUserBlocks(`Pick one.\n\n${BLOCK}`);
  assert.equal(dialog.question, 'Which sprint?');
  assert.deepEqual(dialog.options, [
    { label: 'Current', description: 'Same as this task' },
    { label: 'Backlog', description: '' },
  ]);
  assert.equal(dialog.multi, false);
  assert.match(dialog.id, /^dlg-[0-9a-f]{12}$/);
  assert.equal(parseAskUserBlocks(BLOCK)[0].id, dialog.id, 'same content, same id');
});

test('half-streamed, malformed and unusable blocks are not dialogs', () => {
  assert.deepEqual(parseAskUserBlocks(BLOCK.slice(0, -3)), [], 'no closing fence yet');
  assert.deepEqual(parseAskUserBlocks('```ask_user\n{"question": "Q", "options": [\n```'), []);
  assert.deepEqual(parseAskUserBlocks('```ask_user\n{"question": "Q", "options": ["only one"]}\n```'), []);
  assert.deepEqual(parseAskUserBlocks('```ask_user\n{"options": ["a", "b"]}\n```'), []);
  assert.deepEqual(parseAskUserBlocks('```json\n{"question": "Q", "options": ["a", "b"]}\n```'), [], 'only the ask_user tag counts');
  assert.deepEqual(parseAskUserBlocks(null), []);
});

test('options are deduplicated and capped, multi is read from the block', () => {
  const many = Array.from({ length: 12 }, (_, i) => `opt ${i}`);
  const [dialog] = parseAskUserBlocks('```ask_user\n' + JSON.stringify({ question: 'Q', options: ['a', 'a', ...many], multi: true }) + '\n```');
  assert.equal(dialog.options.length, 8);
  assert.equal(dialog.options.filter(o => o.label === 'a').length, 1);
  assert.equal(dialog.multi, true);
});

test('a dialog is sent once per turn however often the text is scanned', () => {
  const { session, send, ofType } = chat();
  session.turnBuffer = 'Thinking';
  assert.deepEqual(emitDialogs(session, send), []);
  session.turnBuffer = `Pick.\n\n${BLOCK}`;
  emitDialogs(session, send);
  session.turnBuffer += '\n';
  emitDialogs(session, send);
  const frames = ofType('task-chat-dialog');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].taskKey, 'TPT1');
  assert.equal(frames[0].dialog.question, 'Which sprint?');

  resetTaskChatTurn(session);
  emitDialogs(session, send);
  assert.equal(ofType('task-chat-dialog').length, 2, 'a new turn asks again');
});

test('with no send function the frame goes to the session socket, with its tab id', () => {
  const sent = [];
  const { session } = chat({ ws: { OPEN: 1, readyState: 1, send: raw => sent.push(JSON.parse(raw)) } });
  session.turnBuffer = BLOCK;
  emitDialogs(session);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tabId, 'tab-1');
  session.ws.readyState = 3;
  resetTaskChatTurn(session);
  assert.doesNotThrow(() => emitDialogs(session));
  assert.equal(sent.length, 1);
});

test('a tool call sends running, input and done frames — never the same one twice', () => {
  const { session, send, ofType } = chat();
  toolStarted(session, send, { id: 't1', name: 'mcp__tipatask__get_task', input: {} });
  toolStarted(session, send, { id: 't1', name: 'mcp__tipatask__get_task', input: {} });
  toolStarted(session, send, { id: 't1', name: 'mcp__tipatask__get_task', input: { task_key: 'TPT1' } });
  toolStarted(session, send, { id: 't1', name: 'mcp__tipatask__get_task', input: { task_key: 'TPT1' } });
  toolFinished(session, send, { id: 't1', result: [{ type: 'text', text: '{"task":{"id":"TPT1"}}' }] });
  toolFinished(session, send, { id: 't1', result: 'again' });
  const tools = ofType('task-chat-tool').map(f => f.tool);
  assert.deepEqual(tools.map(t => [t.status, t.input ? t.input.task_key : null]), [['running', null], ['running', 'TPT1'], ['done', 'TPT1']]);
  assert.deepEqual([tools[0].name, tools[0].server, tools[0].tool], ['mcp__tipatask__get_task', 'tipatask', 'get_task']);
  assert.equal(tools[2].error, undefined);
});

test('a failed tool call reports a clipped error and long inputs are capped', () => {
  const { session, send, ofType } = chat();
  toolStarted(session, send, { id: 't1', name: 'Read', input: { file_path: 'x'.repeat(2000) } });
  toolFinished(session, send, { id: 't1', isError: true, result: 'E'.repeat(1000) });
  const last = ofType('task-chat-tool').at(-1).tool;
  assert.equal(last.status, 'error');
  assert.ok(last.error.length <= 300);
  assert.ok(last.input.file_path.length <= 501);
  assert.deepEqual([last.server, last.tool], ['', 'Read']);
});

test('create and update calls are recognised per provider; everything else is not', () => {
  assert.deepEqual(classifyTaskMutation({ name: 'mcp__tipatask__update_task', input: { task_key: 'TPT9' } }), { action: 'updated', taskKey: 'TPT9' });
  assert.deepEqual(classifyTaskMutation({ name: 'mcp__tipatask__create_task', input: { title: 'x' } }), { action: 'created', taskKey: '' });
  assert.deepEqual(classifyTaskMutation({ server: 'tipatask', tool: 'update_task', input: { task_key: 'TPT9' } }), { action: 'updated', taskKey: 'TPT9' });
  assert.deepEqual(classifyTaskMutation({ name: 'tipatask_api', input: { method: 'patch', path: '/tasks/TPT9?x=1' } }), { action: 'updated', taskKey: 'TPT9' });
  assert.deepEqual(classifyTaskMutation({ name: 'tipatask_api', input: { method: 'POST', path: '/tasks/' } }), { action: 'created', taskKey: '' });
  assert.equal(classifyTaskMutation({ name: 'tipatask_api', input: { path: '/tasks/TPT9' } }), null, 'a GET changes nothing');
  assert.equal(classifyTaskMutation({ name: 'tipatask_api', input: { method: 'POST', path: '/tasks/TPT9/comments' } }), null);
  assert.equal(classifyTaskMutation({ name: 'mcp__tipatask__get_task', input: { task_key: 'TPT9' } }), null);
  assert.equal(classifyTaskMutation({ name: 'mcp__tipatask-local__batch_grep_tags' }), null);
  assert.equal(classifyTaskMutation({ name: 'mcp__other__update_task', input: { task_key: 'TPT9' } }), null);
});

test('the created task key is read out of each result shape', () => {
  assert.equal(taskKeyFromResult('{"project_id":2,"task":{"id":"TPT50","dbId":9}}'), 'TPT50');
  assert.equal(taskKeyFromResult('HTTP 201\n{"task":{"id":812,"task_key":"TPT51"}}'), 'TPT51');
  assert.equal(taskKeyFromResult('{"id":"C12","title":"x"}'), 'C12');
  assert.equal(taskKeyFromResult('HTTP 201\n{"task":{"id":812,"task_key":"TPT52","description":"cut of'), 'TPT52', 'truncated body');
  assert.equal(taskKeyFromResult('{"task":{"id":812}}'), '', 'a numeric row id is not a key');
  assert.equal(taskKeyFromResult(''), '');
  assert.equal(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(resultText({ message: 'boom' }), 'boom');
});

test('a successful create/update reaches the mutation hook once and is kept as a task event', async () => {
  const calls = [];
  const { session, send } = chat({
    onTaskChatMutation: async (info) => { calls.push(info); return { action: info.action, toolId: info.toolId, task: { id: info.taskKey } }; },
  });
  toolStarted(session, send, { id: 'u1', name: 'mcp__tipatask__update_task', input: { task_key: 'TPT1', title: 'New' } });
  toolFinished(session, send, { id: 'u1', result: '{"task":{"id":"TPT1"}}' });
  toolFinished(session, send, { id: 'u1', result: '{"task":{"id":"TPT1"}}' });
  toolStarted(session, send, { id: 'c1', server: 'tipatask', tool: 'create_task', input: { title: 'Another' } });
  toolFinished(session, send, { id: 'c1', result: { content: [{ type: 'text', text: '{"task":{"id":"TPT77"}}' }] } });
  toolStarted(session, send, { id: 'g1', name: 'mcp__tipatask__get_task', input: { task_key: 'TPT1' } });
  toolFinished(session, send, { id: 'g1', result: '{"task":{"id":"TPT1"}}' });
  await flush();
  assert.deepEqual(calls, [
    { action: 'updated', taskKey: 'TPT1', toolId: 'u1' },
    { action: 'created', taskKey: 'TPT77', toolId: 'c1' },
  ]);
  assert.deepEqual(session._taskChatTurn.taskEvents.map(e => e.task.id), ['TPT1', 'TPT77']);
});

test('a failed write never reaches the hook — tool error, or a non-2xx reply from the Pi REST tool', async () => {
  const calls = [];
  const { session, send, ofType } = chat({ onTaskChatMutation: info => { calls.push(info); } });
  toolStarted(session, send, { id: 'u1', name: 'mcp__tipatask__update_task', input: { task_key: 'TPT1' } });
  toolFinished(session, send, { id: 'u1', isError: true, result: 'Invalid status' });
  toolStarted(session, send, { id: 'p1', name: 'tipatask_api', input: { method: 'PATCH', path: '/tasks/TPT1', body: { status: 'nope' } } });
  toolFinished(session, send, { id: 'p1', isError: false, result: { content: [{ type: 'text', text: 'HTTP 400\n{"error":"Invalid status"}' }] } });
  toolStarted(session, send, { id: 'p2', name: 'tipatask_api', input: { method: 'PATCH', path: '/tasks/TPT1', body: { title: 'ok' } } });
  toolFinished(session, send, { id: 'p2', isError: false, result: { content: [{ type: 'text', text: 'HTTP 200\n{"task":{"task_key":"TPT1"}}' }] } });
  await flush();
  assert.deepEqual(ofType('task-chat-tool').filter(f => f.tool.status !== 'running').map(f => [f.tool.id, f.tool.status]), [['u1', 'error'], ['p1', 'error'], ['p2', 'done']]);
  assert.equal(ofType('task-chat-tool').find(f => f.tool.id === 'p1' && f.tool.status === 'error').tool.error, 'HTTP 400');
  assert.deepEqual(calls.map(c => c.toolId), ['p2']);
});

test('a throwing hook cannot break the turn', async () => {
  const { session, send } = chat({ onTaskChatMutation: () => { throw new Error('backend down'); } });
  toolStarted(session, send, { id: 'u1', name: 'mcp__tipatask__update_task', input: { task_key: 'TPT1' } });
  assert.doesNotThrow(() => toolFinished(session, send, { id: 'u1', result: '{}' }));
  await flush();
  assert.deepEqual(session._taskChatTurn.taskEvents, []);
});

test('widgets ride on the assistant message and replay to a client that attaches mid-turn', async () => {
  const { session, send } = chat({ onTaskChatMutation: info => ({ action: info.action, toolId: info.toolId, task: { id: info.taskKey } }) });
  session.turnBuffer = BLOCK;
  emitDialogs(session, send);
  toolStarted(session, send, { id: 'u1', name: 'mcp__tipatask__update_task', input: { task_key: 'TPT1' } });
  toolFinished(session, send, { id: 'u1', result: '{}' });
  const msg = { role: 'assistant', content: session.turnBuffer };
  attachTaskChatWidgets(session, msg);
  await flush();
  assert.equal(msg.dialogs.length, 1);
  assert.equal(msg.tools[0].status, 'done');
  assert.equal(msg.taskEvents[0].task.id, 'TPT1', 'an event that resolved after the attach still lands');
  assert.doesNotThrow(() => JSON.stringify(msg));

  const replayed = [];
  replayTaskChatTurn(session, frame => replayed.push(frame));
  assert.deepEqual(replayed.map(f => f.type), ['task-chat-tool', 'task-chat-task', 'task-chat-dialog']);
  assert.equal(replayed[1].action, 'updated');

  const plain = { role: 'assistant', content: 'no widgets' };
  attachTaskChatWidgets(chat().session, plain);
  assert.equal(plain.dialogs, undefined);
});

test('only an unanswered dialog on the latest assistant message can be answered', () => {
  const [dialog] = parseAskUserBlocks(BLOCK);
  const asked = { role: 'assistant', content: BLOCK, dialogs: [dialog] };
  assert.equal(findOpenDialog([asked], dialog.id).dialog, dialog);
  assert.match(findOpenDialog([asked], 'dlg-nope').error, /Unknown dialog/);
  assert.match(findOpenDialog([asked, { role: 'user', content: 'never mind' }], dialog.id).error, /no open dialog/);
  assert.match(findOpenDialog([], dialog.id).error, /no open dialog/);
  dialog.answer = { selected: ['Current'] };
  assert.match(findOpenDialog([asked], dialog.id).error, /already answered/);
});

test('an answer is validated against the dialog and rendered as the next user turn', () => {
  const [single] = parseAskUserBlocks(BLOCK);
  const one = resolveDialogAnswer(single, { selected: [1] });
  assert.equal(one.content, 'Answer to "Which sprint?": Backlog');
  assert.deepEqual(one.answer, { selected: ['Backlog'], indexes: [1], other: '' });
  assert.equal(resolveDialogAnswer(single, { other: ' Next sprint ' }).content, 'Answer to "Which sprint?": Next sprint');
  assert.match(resolveDialogAnswer(single, { selected: [0, 1] }).error, /exactly one/);
  assert.match(resolveDialogAnswer(single, { selected: [0], other: 'and this' }).error, /exactly one/);
  assert.match(resolveDialogAnswer(single, {}).error, /at least one/);
  assert.match(resolveDialogAnswer(single, { selected: [5] }).error, /option indexes/);
  assert.match(resolveDialogAnswer(single, { selected: 'Backlog' }).error, /option indexes/);

  const multi = { ...single, multi: true };
  const many = resolveDialogAnswer(multi, { selected: [1, 0, 1], other: 'plus a note' });
  assert.equal(many.content, 'Answer to "Which sprint?": Current; Backlog; Other: plus a note');
  assert.deepEqual(many.answer.indexes, [0, 1]);
});

test('the prompt contract names the ask_user block and never a json fence', () => {
  assert.match(ASK_USER_CONTRACT, /```ask_user\n/);
  assert.doesNotMatch(ASK_USER_CONTRACT, /```json/);
  assert.doesNotMatch(ASK_USER_REMINDER, /\n/);
  assert.equal(parseAskUserBlocks(ASK_USER_CONTRACT).length, 1, 'the example in the contract is itself a valid block');
});

test('changedTaskFields names the fields an agent reasons about, ignoring list order and bookkeeping', () => {
  const prev = { id: 'TPT5', title: 'Old', description: 'D', status: 'pending', priority: 3, tags: ['a', 'b'], dependencies: [], order: 1, piModel: null };
  assert.deepEqual(changedTaskFields(prev, { ...prev, tags: ['b', 'a'], order: 9, piModel: 'x' }), []);
  assert.deepEqual(changedTaskFields(prev, { ...prev, title: 'New', status: 'completed', tags: ['a'] }), ['title', 'status', 'tags']);
  assert.deepEqual(changedTaskFields(prev, { ...prev, due_date: '2026-11-01', assignee: 2 }), ['assignee', 'due_date']);
  assert.deepEqual(changedTaskFields({ ...prev, assignee: null }, { ...prev, assignee: undefined }), [], 'null and missing are the same');
  assert.deepEqual(changedTaskFields(null, { id: 'TPT5', title: 'T', status: 'pending', tags: [] }), ['title', 'status', 'tags'],
    'with no earlier copy nothing can be ruled out');
  assert.deepEqual(changedTaskFields(prev, null), []);
});

test('buildTaskEditNote is one task_edits fence holding single-line JSON', () => {
  const task = { id: 'TPT5', title: 'T', description: `line one\n\`\`\`js\ncode\n\`\`\`\n${'x'.repeat(5000)}`, status: 'pending', tags: ['a'], dbId: 7, totalCostUsd: 1 };
  const note = buildTaskEditNote([{ task, changed: ['description'] }, { task: null }, { task: { id: 'TPT6', title: 'Other' } }]);
  const lines = note.split('\n');
  assert.equal(lines.length, 3, 'fence, one JSON line, fence');
  assert.equal(lines[0], '```task_edits');
  assert.equal(lines[2], '```');
  const body = JSON.parse(lines[1]);
  assert.match(body.note, /edited these tasks by hand/);
  assert.deepEqual(body.tasks.map(t => t.task.id), ['TPT5', 'TPT6']);
  assert.deepEqual(body.tasks[0].changed, ['description']);
  assert.deepEqual(body.tasks[1].changed, []);
  assert.ok(body.tasks[0].task.description.length <= 4000, 'a long description is capped');
  assert.equal('dbId' in body.tasks[0].task, false, 'bookkeeping fields stay out');
  assert.equal('totalCostUsd' in body.tasks[0].task, false);
  assert.doesNotMatch(note, /```json/);
  assert.match(`${note}\n\nNext message`, TASK_EDITS_RE);
  assert.equal(`${note}\n\nNext message`.replace(TASK_EDITS_RE, ''), 'Next message');
  assert.equal(buildTaskEditNote([]), '');
  assert.equal(buildTaskEditNote(undefined), '');
});
