import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Window } from 'happy-dom';

// Pure-model coverage for the task chat window. task-chat-model.js has no DOM and no imports,
// so everything the window decides about providers, selection and transcript text — and the
// markup and answer rules of its dialog / tool / task widgets — is unit-tested here under plain
// node (widget markup is parsed with happy-dom).
const m = await import('./task-chat-model.js');
const { LOCALES } = await import('./i18n.js');
// The server builds the `task_edits` block the window strips: test against the real builder.
const { buildTaskEditNote, TASK_EDITS_RE } = createRequire(import.meta.url)('../server/task-chat-widgets.js');

const providers = [
  { id: 'claude', label: 'Claude', available: true, defaultModel: 'sonnet', models: [{ value: 'opus' }, { value: 'sonnet' }] },
  { id: 'gemini', label: 'Gemini', available: true, defaultModel: 'pro', models: [{ value: 'pro' }] },
  { id: 'codex', label: 'Codex', available: false, reason: 'CLI not installed', models: [{ value: 'gpt-5' }] },
  { id: 'pi', label: 'Pi', available: true, models: [{ value: 'pi-large' }] },
];

test('taskChatProviders: keeps claude/codex/pi and drops gemini', () => {
  assert.deepEqual(m.taskChatProviders(providers).map(p => p.id), ['claude', 'codex', 'pi']);
  assert.deepEqual(m.taskChatProviders(null), []);
});

test('isSelectable: needs an available task-chat provider and one of its models', () => {
  assert.equal(m.isSelectable(providers, 'claude:opus'), true);
  assert.equal(m.isSelectable(providers, 'claude:haiku'), false);
  assert.equal(m.isSelectable(providers, 'gemini:pro'), false);
  assert.equal(m.isSelectable(providers, 'codex:gpt-5'), false);
  assert.equal(m.isSelectable(providers, 'claude'), false);
  assert.equal(m.isSelectable(providers, null), false);
});

test('pickSelection: server selection, then stored, then fallback', () => {
  const base = { providers, serverSelection: 'pi:pi-large', stored: 'claude:opus', fallback: 'claude:sonnet' };
  assert.equal(m.pickSelection(base), 'pi:pi-large');
  assert.equal(m.pickSelection({ ...base, serverSelection: '' }), 'claude:opus');
  assert.equal(m.pickSelection({ ...base, serverSelection: '', stored: '' }), 'claude:sonnet');
});

test('pickSelection: skips candidates task chat cannot run and falls back to the first available default', () => {
  assert.equal(
    m.pickSelection({ providers, serverSelection: 'gemini:pro', stored: 'codex:gpt-5', fallback: 'claude:gone' }),
    'claude:sonnet',
  );
  const noDefault = [{ id: 'pi', available: true, models: [{ value: 'a' }, { value: 'b' }] }];
  assert.equal(m.pickSelection({ providers: noDefault }), 'pi:a');
  assert.equal(m.pickSelection({ providers: [providers[1], providers[2]] }), '');
  assert.equal(m.pickSelection(), '');
});

test('buildModelOptionsHtml: one optgroup per task-chat provider, current selected, unavailable disabled', () => {
  const html = m.buildModelOptionsHtml(providers, 'claude:opus', (id, value) => `${id}/${value}`);
  assert.match(html, /<optgroup label="Claude">/);
  assert.match(html, /<option value="claude:opus" selected>claude\/opus<\/option>/);
  assert.match(html, /<option value="claude:sonnet">claude\/sonnet<\/option>/);
  assert.match(html, /<optgroup label="Codex" disabled title="CLI not installed">/);
  assert.match(html, /<option value="codex:gpt-5" disabled title="CLI not installed">/);
  assert.doesNotMatch(html, /gemini/i);
  assert.equal(m.buildModelOptionsHtml([], ''), '');
});

test('buildModelOptionsHtml: escapes provider-supplied text', () => {
  const html = m.buildModelOptionsHtml([{ id: 'pi', label: 'P<i>"', available: true, models: [{ value: 'a"b' }] }], '');
  assert.match(html, /label="P&lt;i&gt;&quot;"/);
  assert.match(html, /value="pi:a&quot;b"/);
});

test('stripAskUserFence: removes a complete block and keeps the prose', () => {
  const text = 'Where should it go?\n\n```ask_user\n{"question":"Where?","options":["A","B"]}\n```';
  assert.equal(m.stripAskUserFence(text), 'Where should it go?');
});

test('stripAskUserFence: removes a block that is still streaming', () => {
  assert.equal(m.stripAskUserFence('Pick one.\n\n```ask_user\n{"question":"Wh'), 'Pick one.');
  assert.equal(m.stripAskUserFence('Pick one.\n\n```ask_user'), 'Pick one.');
});

test('stripAskUserFence: leaves other fences and plain text alone', () => {
  const code = 'Example:\n\n```json\n{"a":1}\n```\n\nDone.';
  assert.equal(m.stripAskUserFence(code), code);
  assert.equal(m.stripAskUserFence('plain'), 'plain');
  assert.equal(m.stripAskUserFence(''), '');
  assert.equal(m.stripAskUserFence(undefined), '');
});

test('stripAskUserFence: keeps text that follows a complete block', () => {
  const text = 'Before.\n\n```ask_user\n{"question":"Q","options":["A","B"]}\n```\n\nAfter.';
  assert.equal(m.stripAskUserFence(text), 'Before.\n\n\n\nAfter.');
});

const SINGLE = {
  id: 'dlg-1',
  question: 'Where should the new task go?',
  options: [{ label: 'Current sprint', description: 'Same priority as this task' }, { label: 'Backlog', description: '' }, 'Later'],
  multi: false,
};
const MULTI = { ...SINGLE, id: 'dlg-2', multi: true };

test('dialogSubmission: a single-choice dialog takes exactly one option or the free text', () => {
  assert.deepEqual(m.dialogSubmission(SINGLE, { picked: [1] }), { dialogId: 'dlg-1', selected: [1] });
  assert.deepEqual(m.dialogSubmission(SINGLE, { picked: [], other: '  Next month ' }), { dialogId: 'dlg-1', selected: [], other: 'Next month' });
  assert.equal(m.dialogSubmission(SINGLE, { picked: [] }), null);
  assert.equal(m.dialogSubmission(SINGLE, { picked: [0, 1] }), null);
  assert.equal(m.dialogSubmission(SINGLE, { picked: [0], other: 'and this' }), null);
  assert.equal(m.dialogSubmission(SINGLE, { picked: [], other: '   ' }), null);
  assert.equal(m.dialogSubmission(SINGLE, { picked: [9] }), null, 'an out-of-range index is not a pick');
  assert.equal(m.dialogSubmission(null, { picked: [0] }), null);
});

test('dialogSubmission: a multi-choice dialog takes one or more, deduplicated and sorted', () => {
  assert.deepEqual(m.dialogSubmission(MULTI, { picked: [2, 0, 2] }), { dialogId: 'dlg-2', selected: [0, 2] });
  assert.deepEqual(m.dialogSubmission(MULTI, { picked: [1], other: 'plus a note' }), { dialogId: 'dlg-2', selected: [1], other: 'plus a note' });
  assert.equal(m.dialogSubmission(MULTI, { picked: [], other: '' }), null);
});

test('dialogSubmission: the single-choice Other row alone is a valid answer once it has text', () => {
  // The window sends `other` only while the Other radio is checked; no option index goes with it.
  assert.deepEqual(m.dialogSubmission(SINGLE, { picked: [], other: 'Start in batch 20' }), { dialogId: 'dlg-1', selected: [], other: 'Start in batch 20' });
  assert.deepEqual(m.dialogSubmission(SINGLE, { picked: [2], other: '' }), { dialogId: 'dlg-1', selected: [2] });
});

test('dialogState: open on the latest finished turn once connected, waiting before and while a turn runs', () => {
  const dialog = { ...SINGLE };
  const reply = { role: 'assistant', content: 'Pick one', dialogs: [dialog] };
  const messages = [{ role: 'user', content: 'Plan it' }, reply];
  const state = (over = {}) => m.dialogState({ messages, message: reply, dialog, connected: true, running: false, ...over });
  // A reattach restores the history before its `config` frame: built `waiting`, `open` once connected.
  assert.equal(state({ connected: false }), 'waiting');
  assert.equal(state(), 'open');
  assert.equal(state({ running: true }), 'waiting');
  assert.equal(m.dialogState({ messages, message: { ...reply, streaming: true }, dialog, connected: true, running: false }), 'skipped',
    'a message that is not in the transcript is not the latest turn');
  reply.streaming = true;
  assert.equal(state(), 'waiting', 'the reply is still streaming');
  delete reply.streaming;
});

test('dialogState: a window notice after the reply keeps it open; a later turn skips it; an answer locks it', () => {
  const dialog = { ...SINGLE };
  const reply = { role: 'assistant', content: '', dialogs: [dialog] };
  const messages = [{ role: 'user', content: 'Plan it' }, reply, { role: 'system', content: 'TPT1 edited' }];
  const args = { messages, message: reply, dialog, connected: true, running: false };
  assert.equal(m.lastTurnMessage(messages), reply);
  assert.equal(m.dialogState(args), 'open');
  messages.push({ role: 'user', content: 'Never mind' });
  assert.equal(m.dialogState(args), 'skipped');
  assert.equal(m.dialogState({ ...args, dialog: { ...dialog, answer: { selected: ['Backlog'], indexes: [1], other: '' } } }), 'answered');
  assert.equal(m.lastTurnMessage([]), null);
  assert.equal(m.dialogState({ messages: [], message: null, dialog }), 'skipped');
});

test('localAnswer + answerSummary: the picks as the server stores them and as the user reads them', () => {
  const answer = m.localAnswer(MULTI, { dialogId: 'dlg-2', selected: [0, 2], other: 'plus a note' });
  assert.deepEqual(answer, { selected: ['Current sprint', 'Later'], indexes: [0, 2], other: 'plus a note' });
  assert.equal(m.answerSummary(answer), 'Current sprint; Later; Other: plus a note');
  assert.equal(m.answerSummary(m.localAnswer(SINGLE, { selected: [1] })), 'Backlog');
  assert.equal(m.answerSummary({ selected: [], other: 'Next month' }), 'Next month');
  assert.equal(m.answerSummary(null), '');
});

const tr = key => `[${key}]`;

function parse(t, html) {
  const window = new Window();
  t.after(() => window.happyDOM.close());
  window.document.body.innerHTML = html;
  return window.document.body.firstElementChild;
}

test('dialogWidgetHtml: radios for single choice, a free-text Other row and a disabled submit', (t) => {
  const el = parse(t, m.dialogWidgetHtml(SINGLE, { t: tr, name: 'grp-1' }));
  assert.equal(el.tagName, 'FIELDSET');
  assert.ok(el.classList.contains('task-chat-widget--dialog'));
  assert.equal(el.dataset.state, 'open');
  assert.equal(el.hasAttribute('disabled'), false);
  assert.equal(el.querySelector('.task-chat-dialog-question').textContent, SINGLE.question);
  assert.equal(el.getAttribute('aria-labelledby'), el.querySelector('.task-chat-dialog-question').id);
  const toggles = [...el.querySelectorAll('.task-chat-dialog-options input[name="grp-1"]')];
  assert.deepEqual(toggles.map(i => [i.type, i.value]), [['radio', '0'], ['radio', '1'], ['radio', '2'], ['radio', 'other']]);
  assert.equal(toggles.some(i => i.hasAttribute('checked')), false);
  assert.deepEqual([...el.querySelectorAll('.task-chat-dialog-label')].map(n => n.textContent),
    ['Current sprint', 'Backlog', 'Later', '[taskChat.dialog.other]']);
  assert.equal(el.querySelectorAll('.task-chat-dialog-desc').length, 1, 'only an option with a description gets a description row');
  assert.equal(el.querySelector('.task-chat-dialog-other').type, 'text');
  assert.equal(el.querySelector('.task-chat-dialog-hint').textContent, '[taskChat.dialog.hintSingle]');
  const submit = el.querySelector('.task-chat-dialog-submit');
  assert.ok(submit.hasAttribute('disabled'));
  assert.equal(submit.hasAttribute('hidden'), false);
});

test('dialogWidgetHtml: checkboxes for multi choice; an answered dialog is locked with its picks', (t) => {
  const answered = { ...MULTI, answer: { selected: ['Backlog'], indexes: [1], other: 'plus "this"' } };
  const el = parse(t, m.dialogWidgetHtml(answered, { t: tr, name: 'grp-2' }));
  assert.ok(el.hasAttribute('disabled'));
  assert.equal(el.dataset.state, 'answered');
  const toggles = [...el.querySelectorAll('.task-chat-dialog-options input[name="grp-2"]')];
  assert.ok(toggles.every(i => i.type === 'checkbox'));
  assert.deepEqual(toggles.filter(i => i.hasAttribute('checked')).map(i => i.value), ['1', 'other']);
  assert.equal(el.querySelector('.task-chat-dialog-other').getAttribute('value'), 'plus "this"');
  assert.equal(el.querySelector('.task-chat-dialog-state').textContent, '[taskChat.dialog.answered]');
  assert.ok(el.querySelector('.task-chat-dialog-submit').hasAttribute('hidden'));
  assert.equal(el.querySelector('.task-chat-dialog-hint').textContent, '[taskChat.dialog.hintMulti]');
});

test('dialogWidgetHtml: escapes agent-supplied text', () => {
  const html = m.dialogWidgetHtml({ id: 'd', question: '<img src=x onerror=1>', options: [{ label: '<b>A</b>', description: '"q"' }, 'B'], multi: false }, { t: tr });
  assert.doesNotMatch(html, /<img|<b>/);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
  assert.match(html, /&lt;b&gt;A&lt;\/b&gt;/);
  assert.equal(m.dialogWidgetHtml(null), '');
});

test('toolChipModel: KB docs, files, searches and task calls across the three providers', () => {
  const kb = m.toolChipModel({ id: '1', name: 'mcp__tipatask__get_tag_architectures', server: 'tipatask', tool: 'get_tag_architectures', status: 'done', input: { tag_names: ['tt-task-chat', 'tt-task-cards', 'tt-websocket'] } });
  assert.deepEqual([kb.kind, kb.target, kb.status, kb.expandable], ['kb', 'tt-task-chat +2', 'done', true]);
  assert.deepEqual(kb.rows, [['tag_names', 'tt-task-chat, tt-task-cards, tt-websocket']]);
  assert.equal(m.toolChipModel({ name: 'mcp__tipatask__get_tag_architecture', input: { tag_name: 'tt-api' } }).target, 'tt-api');

  const file = m.toolChipModel({ id: '2', name: 'Read', status: 'running', input: { file_path: '/Users/x/proj/src/client/task-card.js', offset: 10, limit: 40 } });
  assert.deepEqual([file.kind, file.target, file.status], ['file', '…/client/task-card.js', 'running']);
  assert.deepEqual(file.rows, [['file_path', '/Users/x/proj/src/client/task-card.js'], ['offset', '10'], ['limit', '40']]);

  const doc = m.toolChipModel({ name: 'read', input: { path: 'ai/architecture/tt-task-chat.md' } });
  assert.deepEqual([doc.kind, doc.target], ['kb', 'tt-task-chat'], 'a KB doc read as a file (Codex, Pi) is still a KB doc');

  const grep = m.toolChipModel({ name: 'mcp__tipatask-local__batch_grep_tags', server: 'tipatask-local', tool: 'batch_grep_tags', input: { tag_names: ['tt-task-chat'], symbols: ['renderCard'] } });
  assert.deepEqual([grep.kind, grep.target], ['search', 'renderCard']);
  assert.deepEqual([m.toolChipModel({ name: 'grep', input: { pattern: 'paintWidgets', path: 'src' } }).target], ['paintWidgets']);

  const update = m.toolChipModel({ name: 'mcp__tipatask__update_task', server: 'tipatask', tool: 'update_task', status: 'error', error: 'HTTP 400', input: { task_key: 'TPT5', tags: ['a'] } });
  assert.deepEqual([update.kind, update.name, update.target, update.error], ['task', 'update_task', 'TPT5', 'HTTP 400']);
  const rest = m.toolChipModel({ name: 'tipatask_api', status: 'done', input: { method: 'patch', path: '/tasks/TPT5', body: { status: 'completed' } } });
  assert.deepEqual([rest.kind, rest.target], ['task', 'PATCH /tasks/TPT5']);
  assert.deepEqual(rest.rows.at(-1), ['body', '{"status":"completed"}']);

  const bare = m.toolChipModel({ id: '9', name: 'ToolSearch', status: 'running' });
  assert.deepEqual([bare.kind, bare.name, bare.target, bare.expandable], ['other', 'ToolSearch', '', false]);
  assert.equal(m.toolChipModel(undefined).expandable, false);
});

test('toolChipHtml: an expandable chip is a button with a hidden detail block; a bare one is a label', (t) => {
  const tool = { id: 't1', name: 'mcp__tipatask__get_tag_architecture', server: 'tipatask', tool: 'get_tag_architecture', status: 'done', input: { tag_name: 'tt-<x>' } };
  const el = parse(t, m.toolChipHtml(tool, { t: tr }));
  assert.ok(el.classList.contains('task-chat-widget--tool'));
  assert.deepEqual([el.dataset.status, el.dataset.kind], ['done', 'kb']);
  const button = el.querySelector('button.task-chat-tool-chip');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(button.querySelector('.task-chat-tool-label').textContent, '[taskChat.tool.kind.kb]');
  assert.equal(button.querySelector('.task-chat-tool-target').textContent, 'tt-<x>');
  const detail = el.querySelector('.task-chat-tool-detail');
  assert.ok(detail.hasAttribute('hidden'));
  assert.equal(detail.querySelector('.task-chat-tool-name').textContent, 'mcp__tipatask__get_tag_architecture');
  assert.equal(detail.querySelector('dt').textContent, 'tag_name');

  const open = parse(t, m.toolChipHtml({ ...tool, status: 'error', error: 'boom' }, { t: tr, open: true }));
  assert.ok(open.classList.contains('task-chat-widget--open'));
  assert.equal(open.querySelector('button').getAttribute('aria-expanded'), 'true');
  assert.equal(open.querySelector('.task-chat-tool-detail').hasAttribute('hidden'), false);
  assert.equal(open.querySelector('.task-chat-tool-error').textContent, 'boom');
  assert.equal(open.querySelector('.task-chat-tool-status').textContent, '[taskChat.tool.status.error]');

  const bare = parse(t, m.toolChipHtml({ id: 't2', name: 'ToolSearch', status: 'running' }, { t: tr, open: true }));
  assert.equal(bare.querySelector('button'), null);
  assert.equal(bare.querySelector('.task-chat-tool-detail'), null);
  assert.equal(bare.querySelector('span.task-chat-tool-chip .task-chat-tool-label').textContent, 'ToolSearch');
});

test('collapseTaskEvents: one card per task, latest copy, created wins over updated', () => {
  const cards = m.collapseTaskEvents([
    { id: 'a', action: 'created', task: { id: 'TPT9', title: 'v1' } },
    { id: 'b', action: 'updated', task: { id: 'TPT5', title: 'other' } },
    { id: 'c', action: 'updated', task: { id: 'TPT9', title: 'v2' } },
    { id: 'd', action: 'updated' },
  ]);
  assert.deepEqual(cards.map(c => [c.id, c.action, c.task.title]), [['TPT9', 'created', 'v2'], ['TPT5', 'updated', 'other']]);
  assert.deepEqual(m.collapseTaskEvents(null), []);
});

test('hasWidgets: true when a message carries any dialog, tool or task event', () => {
  assert.equal(m.hasWidgets({ dialogs: [], tools: [], taskEvents: [] }), false);
  assert.equal(m.hasWidgets({ dialogs: [{ id: 'd' }] }), true);
  assert.equal(m.hasWidgets({ taskEvents: [{ id: 'e' }] }), true);
  assert.equal(m.hasWidgets(null), false);
});

test('stripTaskEditNote: removes exactly the block the server puts in front of a user turn', () => {
  const tricky = { id: 'TPT5', title: 'T', description: 'has ```ts\ncode\n``` and a\n```task_edits fence of its own' };
  const note = buildTaskEditNote([{ task: tricky, changed: ['description'] }]);
  assert.match(`${note}\n\nNow split it.`, TASK_EDITS_RE);
  assert.equal(m.stripTaskEditNote(`${note}\n\nNow split it.`), 'Now split it.');
  assert.equal(m.stripTaskEditNote(`${note}\n\nAnswer to "Q": A`), 'Answer to "Q": A');
  assert.equal(m.stripTaskEditNote('No note here.'), 'No note here.');
  assert.equal(m.stripTaskEditNote('Mentions ```task_edits later.'), 'Mentions ```task_edits later.');
  assert.equal(m.stripTaskEditNote(undefined), '');
});

test('visibleHistory: a dialog answer shows its picks and a user turn loses its task_edits block', () => {
  const note = buildTaskEditNote([{ task: { id: 'TPT5', title: 'T' }, changed: ['title'] }]);
  const history = m.visibleHistory([
    { role: 'user', content: 'seed', seed: true },
    { role: 'assistant', content: 'Which?', dialogs: [{ id: 'dlg-1' }] },
    { role: 'user', content: `${note}\n\nAnswer to "Which?": Backlog; Other: soon`, dialogAnswer: { dialogId: 'dlg-1', selected: ['Backlog'], indexes: [1], other: 'soon' }, taskEdits: [{ taskKey: 'TPT5', changed: ['title'] }] },
    { role: 'assistant', content: 'Ok.' },
    { role: 'user', content: `${note}\n\nAnd rename it.` },
  ]);
  assert.equal(history[1].content, 'Backlog; Other: soon');
  assert.deepEqual(history[1].dialogAnswer, { dialogId: 'dlg-1' });
  assert.equal(history[3].content, 'And rename it.');
  assert.equal('dialogAnswer' in history[3], false);
});

test('every taskChat.* string the widget markup uses exists in both locales', () => {
  const source = readFileSync(new URL('./task-chat-model.js', import.meta.url), 'utf8');
  const keys = new Set([...source.matchAll(/'(taskChat\.[A-Za-z.]+)'/g)].map(match => match[1]));
  for (const status of ['running', 'done', 'error']) keys.add(`taskChat.tool.status.${status}`);
  assert.ok(keys.size >= 10, 'found the widget strings');
  for (const key of keys) {
    assert.ok(key in LOCALES.en, `en has ${key}`);
    assert.ok(key in LOCALES.uk, `uk has ${key}`);
  }
});

test('visibleHistory: hides the generated seed and carries the widget arrays', () => {
  const history = m.visibleHistory([
    { role: 'user', content: '{"id":"TPT1"}\n\nRead the task above…', seed: true },
    { role: 'assistant', content: 'This task is about X.', dialogs: [{ id: 'dlg-1' }], tools: [{ id: 't1' }], taskEvents: [] },
    { role: 'user', content: 'Split it.' },
    { role: 'assistant', content: 'Done.' },
  ]);
  assert.deepEqual(history.map(h => [h.role, h.content]), [
    ['assistant', 'This task is about X.'],
    ['user', 'Split it.'],
    ['assistant', 'Done.'],
  ]);
  assert.deepEqual(history[0].dialogs, [{ id: 'dlg-1' }]);
  assert.deepEqual(history[0].tools, [{ id: 't1' }]);
  assert.deepEqual(history[2].dialogs, []);
  assert.deepEqual(m.visibleHistory(undefined), []);
});

test('upsertById: replaces a re-sent record in place and appends a new one', () => {
  const list = [{ id: 'a', status: 'running' }];
  m.upsertById(list, { id: 'a', status: 'done' });
  m.upsertById(list, { id: 'b', status: 'running' });
  m.upsertById(list, { status: 'no id' });
  assert.deepEqual(list, [{ id: 'a', status: 'done' }, { id: 'b', status: 'running' }]);
});

test('shortToolName: strips the mcp server prefix', () => {
  assert.equal(m.shortToolName('mcp__tipatask__update_task'), 'update_task');
  assert.equal(m.shortToolName('tipatask_api'), 'tipatask_api');
  assert.equal(m.shortToolName(undefined), '');
});

// ── Attachments (TPT473) ──

const IMG = 'http://127.0.0.1:4454/api/projects/2/images/41';
const PDF = 'https://web.tipatask.com/api/projects/2/files/7';

test('splitAttachmentRefs: pulls image and file refs out of the text, rewritten to the proxies', () => {
  const { text, attachments } = m.splitAttachmentRefs(`Look at this![img](${IMG})\n\nand the spec [spec.pdf](${PDF})`);
  assert.equal(text, 'Look at this\n\nand the spec');
  assert.deepEqual(attachments, [
    { kind: 'image', name: 'img', src: '/api/images/2/41', href: '/api/images/2/41' },
    { kind: 'file', name: 'spec.pdf', href: '/api/files/2/7' },
  ]);
});

test('splitAttachmentRefs: a relative URL counts, other links and an uploading blob stay in the text', () => {
  const r = m.splitAttachmentRefs('![shot](/api/projects/3/images/9)');
  assert.equal(r.text, '');
  assert.deepEqual(r.attachments.map(a => a.src), ['/api/images/3/9']);
  const plain = 'see [docs](https://example.com/api/projects/x) and ![img](blob:http://x/1)';
  assert.deepEqual(m.splitAttachmentRefs(plain), { text: plain, attachments: [] });
  assert.deepEqual(m.splitAttachmentRefs(null), { text: '', attachments: [] });
});

test('splitAttachmentRefs: removing a ref collapses the blank lines it leaves', () => {
  const { text } = m.splitAttachmentRefs(`one\n\n![img](${IMG})\n\n\ntwo   \n[a.txt](${PDF})`);
  assert.equal(text, 'one\n\ntwo');
});

test('userMessageHtml: escaped text, an image thumbnail and a file chip', () => {
  const tr = key => LOCALES.en[key] || key;
  const html = m.userMessageHtml(`<b>hi</b>\n![img](${IMG}) [r&d.pdf](${PDF})`, { t: tr });
  const doc = new Window().document;
  doc.body.innerHTML = html;
  assert.equal(doc.querySelector('.task-chat-user-text').textContent, '<b>hi</b>');
  assert.equal(doc.querySelector('b'), null);
  const thumb = doc.querySelector('a.task-chat-attach--image');
  assert.ok(thumb.classList.contains('file-attachment-link'));
  assert.equal(thumb.getAttribute('href'), '/api/images/2/41');
  assert.equal(thumb.querySelector('img').getAttribute('src'), '/api/images/2/41');
  assert.equal(thumb.querySelector('img').getAttribute('alt'), LOCALES.en['taskChat.embed.image']);
  const chip = doc.querySelector('a.task-chat-attach--file');
  assert.equal(chip.getAttribute('href'), '/api/files/2/7');
  assert.equal(chip.textContent, 'r&d.pdf');
});

test('userMessageHtml: text without attachments is the text alone; attachments alone have no text row', () => {
  assert.equal(m.userMessageHtml('a < b'), '<div class="task-chat-user-text">a &lt; b</div>');
  assert.doesNotMatch(m.userMessageHtml(`![img](${IMG})`), /task-chat-user-text/);
  assert.equal(m.attachmentsHtml([]), '');
});

test('stripPendingImageRefs: drops blob placeholders and keeps uploaded refs', () => {
  assert.equal(m.stripPendingImageRefs(`a![img](blob:http://x/1)b![img](${IMG})`), `ab![img](${IMG})`);
  assert.equal(m.stripPendingImageRefs('plain'), 'plain');
  assert.equal(m.stripPendingImageRefs(undefined), '');
});

// ── (TPT539) history picker ──
test('(TPT539) visibleHistory shows restored turns and turns the resume marker into the indicator', async () => {
  const { visibleHistory } = await import('./task-chat-model.js');
  const shown = visibleHistory([
    { role: 'assistant', content: 'Earlier reply', restored: true },
    { role: 'user', content: '', seed: true, resumed: true, historyId: 'h', provider: 'codex', transcriptUnavailable: false },
    { role: 'user', content: 'New question' },
  ]);
  assert.equal(shown.length, 3);
  assert.equal(shown[0].restored, true);
  assert.equal(shown[0].content, 'Earlier reply');
  assert.deepEqual(shown[1], { role: 'system', kind: 'resumed', content: '', provider: 'codex', transcriptUnavailable: false });
  assert.equal(shown[2].restored, undefined);
  assert.equal(visibleHistory([{ role: 'user', content: 'SEED', seed: true }]).length, 0, 'a plain seed stays hidden');
});

test('(TPT539) historyQuery scopes a task chat to its task and a project chat to project chats', async () => {
  const { historyQuery } = await import('./task-chat-model.js');
  assert.equal(historyQuery({ kind: 'task', key: 'TPT1' }), '/api/project/chat-history?taskKey=TPT1&limit=50');
  assert.equal(historyQuery({ kind: 'project', key: '2', q: '  flamingo plan ' }), '/api/project/chat-history?kind=project&q=flamingo+plan&limit=50');
});

test('(TPT539) historyRowHtml shows title, provider/model, time and first excerpt, escaped; unavailable rows give the reason', async () => {
  const { historyRowHtml, relativeTime } = await import('./task-chat-model.js');
  const t = (key) => `«${key}»`;
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  const row = {
    historyId: 'h1', title: 'Fix <login>', provider: 'claude', model: 'opus', lastActivityAt: now - 3 * 60 * 1000,
    available: true, excerpts: { first: 'Why does <b>it</b> fail?', latest: 'x' },
  };
  const html = historyRowHtml(row, { t, label: (p, m) => `${m.toUpperCase()}`, now, locale: 'en' });
  assert.match(html, /Fix &lt;login&gt;/);
  assert.match(html, /Claude · OPUS/);
  assert.match(html, /3 minutes ago/);
  assert.match(html, /Why does &lt;b&gt;it&lt;\/b&gt; fail\?/);
  assert.doesNotMatch(html, /reason/);
  const gone = historyRowHtml({ ...row, title: '', taskKey: 'TPT9', available: false, unavailableReason: 'checkout', excerpts: {} }, { t, now });
  assert.match(gone, /TPT9/);
  assert.match(gone, /«taskChat\.history\.reason\.checkout»/);
  assert.doesNotMatch(gone, /excerpt/);
  assert.match(historyRowHtml({ ...row, title: '' }, { t, now }), /«taskChat\.history\.untitled»/);
  assert.equal(relativeTime(now - 2 * 86400 * 1000, { now, locale: 'uk' }), 'позавчора');
  assert.match(relativeTime(now - 90 * 86400 * 1000, { now, locale: 'en' }), /2026/);
  assert.equal(relativeTime(0, { now }), '');
});

test('(TPT539) historyFocusIndex moves through rows and hands ArrowUp at the top back to the search box', async () => {
  const { historyFocusIndex } = await import('./task-chat-model.js');
  assert.equal(historyFocusIndex(-1, 'ArrowDown', 3), 0);
  assert.equal(historyFocusIndex(2, 'ArrowDown', 3), 2);
  assert.equal(historyFocusIndex(0, 'ArrowUp', 3), -1);
  assert.equal(historyFocusIndex(1, 'End', 3), 2);
  assert.equal(historyFocusIndex(2, 'Home', 3), 0);
  assert.equal(historyFocusIndex(0, 'ArrowDown', 0), -1);
});
