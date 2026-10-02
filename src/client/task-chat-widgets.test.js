import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { Window } from 'happy-dom';

// The task chat window's widgets, driven for real: task-chat.js runs in a vm against a
// happy-dom document with its collaborators stubbed (same approach as task-merge.test.js), the
// pure model and the WS type tables are the real ones. Frames go in through the fake socket's
// onmessage, clicks through the DOM, and what the window sends is read off the wsSend spy.
const source = readFileSync(new URL('./task-chat.js', import.meta.url), 'utf8');
const model = await import('./task-chat-model.js');
const { WS_SEND_TYPES, WS_RECV_TYPES } = await import('./ws-client.js');

const DIALOG = {
  id: 'dlg-1',
  question: 'Where should it go?',
  options: [{ label: 'Current sprint', description: 'Same priority' }, { label: 'Backlog', description: '' }],
  multi: false,
};
const TASK = { id: 'TPT9', title: 'New task', description: 'Body', status: 'pending', tags: ['feature'], dependencies: [] };

function harness(t, { topLayer = () => true } = {}) {
  const window = new Window();
  t.after(() => window.happyDOM.close());
  const sent = [];
  const opened = [];
  const sockets = [];
  let locale = 'en';
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
    close() { this.readyState = 3; }
  }
  FakeSocket.OPEN = 1;
  const env = {
    window, document: window.document, WebSocket: FakeSocket, console,
    localStorage: { getItem: () => null, setItem: () => {} },
    requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame: () => {},
    setTimeout: () => 1, clearTimeout: () => {},
    fetch: async () => ({ ok: false }),
    Promise, JSON, Map, Set, WeakMap, Array, String, Number, Math,
    buildWsUrl: id => `ws://test/?taskId=${id}`,
    wsSend: (_ws, type, payload) => sent.push({ type, ...payload }),
    WS_SEND_TYPES, WS_RECV_TYPES,
    renderMarkdown: text => `<p>${text}</p>`,
    escapeAttr: value => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    autoGrowTextarea: () => {}, projectHeader: () => ({}), showToast: () => {},
    modelLabel: (_id, value) => value,
    state: { objectiveProviders: [], objectiveModel: '' },
    showActionConfirm: async () => true,
    activateDialogFocus: () => ({ close() {}, focusFirst() {}, isTop: topLayer }),
    // English reads as the bare key; any other locale is prefixed, so a relabel is visible.
    t: (key, params) => (locale === 'en' ? '' : `${locale}:`) + (params ? `${key}:${Object.values(params).join(',')}` : key),
    getLocale: () => locale,
    renderCard: (task, opts) => `<div class="card card--preview" data-preview-task="${task.id}" data-opts="${opts.preview}">${task.title}</div>`,
    openTaskEditModal: async (key, callbacks) => { opened.push({ key, callbacks }); },
    ...model,
  };
  vm.createContext(env);
  vm.runInContext(source.replace(/^import [\s\S]*?;\n/gm, '').replace(/^export /gm, ''), env);
  const doc = window.document;
  const feed = frame => sockets.at(-1).onmessage({ data: JSON.stringify(frame) });
  // A fresh chat, started from its gate, whose first turn (the agent's introduction) has finished.
  const start = () => {
    env.open('TPT1');
    feed({ type: 'config', objectiveProviders: [] });
    click(doc.querySelector('.task-chat-start-go'));
    feed({ type: 'data', data: 'Hello.' });
    feed({ type: 'chat-ready' });
    sent.length = 0;
  };
  const turn = (text = 'Go on') => {
    doc.querySelector('.task-chat-input').value = text;
    env.sendMessage();
    sent.length = 0;
  };
  const setLocale = (lang) => { locale = lang; };
  return { env, doc, sent, opened, sockets, feed, start, turn, setLocale, $: sel => doc.querySelector(sel), $$: sel => [...doc.querySelectorAll(sel)] };
}

function click(el) { el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true })); }
function change(el) { el.dispatchEvent(new el.ownerDocument.defaultView.Event('change', { bubbles: true })); }

// An assistant turn that ends with the dialog above.
function askDialog(h) {
  h.turn();
  h.feed({ type: 'data', data: 'Pick one.\n\n```ask_user\n{"question":"Where should it go?"}\n```' });
  h.feed({ type: 'task-chat-dialog', taskKey: 'TPT1', dialog: DIALOG });
}

test('a dialog frame draws a locked form mid-turn that opens when the turn ends', (t) => {
  const h = harness(t);
  h.start();
  askDialog(h);
  const dialog = h.$('.task-chat-widget--dialog');
  assert.ok(dialog, 'the dialog is drawn in the widgets slot');
  assert.ok(dialog.closest('.task-chat-widgets'));
  assert.equal(dialog.dataset.state, 'waiting');
  assert.equal(dialog.disabled, true);
  assert.doesNotMatch(h.$('.task-chat-msg--assistant:last-of-type .task-chat-body').innerHTML, /ask_user/, 'the fence is not shown as text');

  h.feed({ type: 'chat-ready' });
  assert.equal(dialog.dataset.state, 'open');
  assert.equal(dialog.disabled, false);
  assert.equal(h.$('.task-chat-dialog-submit').disabled, true, 'nothing picked yet');
  assert.equal(h.$('.task-chat-widget--dialog'), dialog, 'the same element — picks made so far survive');
});

test('picking an option and submitting sends task-chat-answer, locks the dialog and becomes the next user turn', (t) => {
  const h = harness(t);
  h.start();
  askDialog(h);
  h.feed({ type: 'chat-ready' });
  const dialog = h.$('.task-chat-widget--dialog');
  const radios = h.$$('.task-chat-dialog-options input[type="radio"]');
  radios[1].checked = true;
  change(radios[1]);
  const submit = h.$('.task-chat-dialog-submit');
  assert.equal(submit.disabled, false);
  click(submit);

  assert.deepEqual(h.sent, [{ type: 'task-chat-answer', dialogId: 'dlg-1', selected: [1], model: undefined }]);
  assert.equal(dialog.dataset.state, 'answered');
  assert.equal(dialog.disabled, true);
  assert.equal(submit.hidden, true);
  assert.equal(h.$('.task-chat-dialog-state').textContent, 'taskChat.dialog.answered');
  const bubbles = h.$$('.task-chat-msg--user .task-chat-body').map(el => el.textContent);
  assert.equal(bubbles.at(-1), 'Backlog', 'the pick is the next user turn');
  assert.ok(h.$('.task-chat-msg--streaming'), 'and the reply to it is on its way');
  assert.equal(h.$('.task-chat-send').hidden, true);

  click(submit);
  assert.equal(h.sent.length, 1, 'a locked dialog sends nothing more');
});

test('the free-text Other answers a single-choice dialog on its own; a multi-choice dialog combines picks', (t) => {
  const h = harness(t);
  h.start();
  askDialog(h);
  h.feed({ type: 'chat-ready' });
  const other = h.$('.task-chat-dialog-other');
  other.value = 'The sprint after next';
  other.dispatchEvent(new h.doc.defaultView.Event('input', { bubbles: true }));
  assert.equal(h.$('.task-chat-dialog-options input[value="other"]').checked, true, 'typing selects Other');
  click(h.$('.task-chat-dialog-submit'));
  assert.deepEqual(h.sent, [{ type: 'task-chat-answer', dialogId: 'dlg-1', selected: [], other: 'The sprint after next', model: undefined }]);
  assert.equal(h.$$('.task-chat-msg--user .task-chat-body').at(-1).textContent, 'The sprint after next');

  h.feed({ type: 'data', data: 'And which?' });
  h.feed({ type: 'task-chat-dialog', taskKey: 'TPT1', dialog: { ...DIALOG, id: 'dlg-2', multi: true } });
  h.feed({ type: 'chat-ready' });
  h.sent.length = 0;
  const second = h.$$('.task-chat-widget--dialog').at(-1);
  const boxes = [...second.querySelectorAll('input[type="checkbox"]')];
  assert.equal(boxes.length, 3);
  assert.notEqual(boxes[0].name, h.$$('.task-chat-widget--dialog')[0].querySelector('input').name, 'each dialog is its own input group');
  for (const box of boxes.slice(0, 2)) { box.checked = true; change(box); }
  click(second.querySelector('.task-chat-dialog-submit'));
  assert.deepEqual(h.sent, [{ type: 'task-chat-answer', dialogId: 'dlg-2', selected: [0, 1], model: undefined }]);
  assert.equal(h.$$('.task-chat-msg--user .task-chat-body').at(-1).textContent, 'Current sprint; Backlog');
});

test('an answer the server refuses is taken back and the dialog opens again', (t) => {
  const h = harness(t);
  h.start();
  askDialog(h);
  h.feed({ type: 'chat-ready' });
  const radios = h.$$('.task-chat-dialog-options input[type="radio"]');
  radios[0].checked = true;
  change(radios[0]);
  const users = () => h.$$('.task-chat-msg--user').length;
  const before = users();
  click(h.$('.task-chat-dialog-submit'));
  assert.equal(users(), before + 1);

  h.feed({ type: 'error', message: 'That dialog is already answered.' });
  assert.equal(users(), before, 'the optimistic user turn is gone');
  assert.equal(h.$('.task-chat-msg--streaming'), null);
  const dialog = h.$('.task-chat-widget--dialog');
  assert.equal(dialog.dataset.state, 'open');
  assert.equal(h.$('.task-chat-dialog-submit').disabled, false, 'the pick is still there to resend');
  assert.match(h.$('.task-chat-msg--error').textContent, /already answered/);
  assert.equal(h.$('.task-chat-send').hidden, false);
});

test('stopping the answer turn re-opens the dialog and does not put the answer into the input', (t) => {
  const h = harness(t);
  h.start();
  askDialog(h);
  h.feed({ type: 'chat-ready' });
  const radios = h.$$('.task-chat-dialog-options input[type="radio"]');
  radios[0].checked = true;
  change(radios[0]);
  click(h.$('.task-chat-dialog-submit'));
  h.feed({ type: 'objective-progress', stage: 'spawned' });
  h.feed({ type: 'generation-aborted' });
  assert.equal(h.$('.task-chat-widget--dialog').dataset.state, 'open');
  assert.equal(h.$('.task-chat-input').value, '');
  assert.equal(h.$$('.task-chat-msg--user .task-chat-body').some(el => el.textContent === 'Current sprint'), false);
});

test('typing a message instead leaves the dialog behind as not answered', (t) => {
  const h = harness(t);
  h.start();
  askDialog(h);
  h.feed({ type: 'chat-ready' });
  h.turn('Never mind, do something else');
  const dialog = h.$('.task-chat-widget--dialog');
  assert.equal(dialog.dataset.state, 'skipped');
  assert.equal(dialog.disabled, true);
  assert.equal(h.$('.task-chat-dialog-state').textContent, 'taskChat.dialog.skipped');
  assert.equal(h.$('.task-chat-dialog-submit').hidden, true);
});

test('restored history shows an answered dialog locked with its pick, and the answer as a user turn', (t) => {
  const h = harness(t);
  h.env.open('TPT1');
  h.feed({
    type: 'chat-history-reset',
    running: false,
    messages: [
      { role: 'user', content: 'seed', seed: true },
      { role: 'assistant', content: 'Pick.', dialogs: [{ ...DIALOG, answer: { selected: ['Backlog'], indexes: [1], other: '' } }], tools: [], taskEvents: [] },
      { role: 'user', content: 'Answer to "Where should it go?": Backlog', dialogAnswer: { dialogId: 'dlg-1', selected: ['Backlog'], indexes: [1], other: '' } },
      { role: 'assistant', content: 'Done.' },
    ],
  });
  h.feed({ type: 'config', objectiveProviders: [] });
  assert.equal(h.sent.some(f => f.type === 'start-task-chat'), false);
  const dialog = h.$('.task-chat-widget--dialog');
  assert.equal(dialog.dataset.state, 'answered');
  assert.deepEqual(h.$$('.task-chat-dialog-options input').filter(i => i.checked).map(i => i.value), ['1']);
  assert.equal(h.$('.task-chat-msg--user .task-chat-body').textContent, 'Backlog');
});

test('tool frames draw chips that update in place and keep their expanded state', (t) => {
  const h = harness(t);
  h.start();
  h.turn();
  const tool = { id: 'toolu_1', name: 'mcp__tipatask__get_tag_architecture', server: 'tipatask', tool: 'get_tag_architecture', status: 'running' };
  h.feed({ type: 'task-chat-tool', taskKey: 'TPT1', tool });
  let chip = h.$('.task-chat-widget--tool');
  assert.equal(chip.dataset.status, 'running');
  assert.equal(chip.querySelector('button'), null, 'nothing to expand before the arguments are known');
  assert.match(h.$$('.task-chat-status').at(-1).textContent, /taskChat\.status\.tool/);

  h.feed({ type: 'task-chat-tool', taskKey: 'TPT1', tool: { ...tool, input: { tag_name: 'tt-task-chat' } } });
  chip = h.$('.task-chat-widget--tool');
  const button = chip.querySelector('button.task-chat-tool-chip');
  assert.equal(chip.querySelector('.task-chat-tool-target').textContent, 'tt-task-chat');
  click(button);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(chip.querySelector('.task-chat-tool-detail').hidden, false);

  h.feed({ type: 'task-chat-tool', taskKey: 'TPT1', tool: { ...tool, input: { tag_name: 'tt-task-chat' }, status: 'done' } });
  h.feed({ type: 'task-chat-tool', taskKey: 'TPT1', tool: { id: 'toolu_2', name: 'Read', status: 'running', input: { file_path: '/p/src/client/task-card.js' } } });
  const chips = h.$$('.task-chat-widget--tool');
  assert.equal(chips.length, 2, 'one chip per call, however many frames it sent');
  assert.equal(chips[0].dataset.status, 'done');
  assert.ok(chips[0].classList.contains('task-chat-widget--open'), 'still expanded after its closing frame');
  assert.equal(chips[0].querySelector('.task-chat-tool-detail').hidden, false);
  assert.equal(chips[1].dataset.kind, 'file');
  click(chips[0].querySelector('button'));
  assert.equal(chips[0].querySelector('.task-chat-tool-detail').hidden, true);
});

test('a task frame draws the board card with its badge; a click opens the edit modal without footer actions', async (t) => {
  const h = harness(t);
  h.start();
  h.turn();
  h.feed({ type: 'task-chat-tool', taskKey: 'TPT1', tool: { id: 'toolu_1', name: 'mcp__tipatask__create_task', server: 'tipatask', tool: 'create_task', status: 'done' } });
  h.feed({ type: 'task-chat-task', taskKey: 'TPT1', action: 'created', toolId: 'toolu_1', task: TASK });
  h.feed({ type: 'task-chat-task', taskKey: 'TPT1', action: 'updated', toolId: 'toolu_2', task: { ...TASK, title: 'New task, renamed' } });
  h.feed({ type: 'chat-ready' });

  const cards = h.$$('.task-chat-widget--task');
  assert.equal(cards.length, 1, 'one card per task');
  const card = cards[0];
  assert.equal(card.dataset.action, 'created');
  assert.equal(card.querySelector('.task-chat-task-badge').textContent, 'taskChat.task.created');
  const preview = card.querySelector('.card--preview');
  assert.equal(preview.dataset.opts, 'true', "rendered through the board's renderCard(…, { preview: true })");
  assert.equal(preview.textContent, 'New task, renamed');
  assert.equal(card.getAttribute('role'), 'button');
  assert.equal(card.tabIndex, 0);
  const groups = [...h.$$('.task-chat-widgets').at(-1).children].map(el => el.className);
  assert.deepEqual(groups, ['task-chat-tools', 'task-chat-tasks'], 'chips first, then cards');

  click(card);
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].key, 'TPT9');
  assert.equal(h.opened[0].callbacks.hideActions, true);
  assert.equal(h.opened[0].callbacks.readOnly, undefined, 'editable');
  assert.equal(h.opened[0].callbacks.trigger, card);

  h.opened[0].callbacks.onSaved('TPT9');
  assert.deepEqual(h.sent, [{ type: 'task-chat-task-edited', taskKey: 'TPT9' }]);

  h.feed({ type: 'task-chat-task-edited', taskKey: 'TPT1', task: { ...TASK, title: 'Edited by hand' }, changed: ['title'] });
  assert.equal(h.$('.task-chat-widget--task .card--preview').textContent, 'Edited by hand', 'the card shows the saved task');
  assert.match(h.$$('.task-chat-msg--system').at(-1).textContent, /taskChat\.edit\.queued:TPT9/);
  h.feed({ type: 'task-chat-task-edited', taskKey: 'TPT1', task: { ...TASK, title: 'Edited by hand' }, changed: [] });
  assert.equal(h.$$('.task-chat-msg--system').length, 1, 'a save that changed nothing the agent reads adds no notice');
});

test('a reply that is only widgets is kept when the turn ends', (t) => {
  const h = harness(t);
  h.start();
  h.turn();
  h.feed({ type: 'task-chat-task', taskKey: 'TPT1', action: 'updated', toolId: 'toolu_1', task: TASK });
  h.feed({ type: 'objective-result', content: '' });
  assert.equal(h.$$('.task-chat-widget--task').length, 1);
  assert.equal(h.$$('.task-chat-msg--assistant').at(-1).querySelector('.task-chat-body').hidden, true);
});

test('Escape closes the chat only while it is the top dialog layer', (t) => {
  let top = false;
  const h = harness(t, { topLayer: () => top });
  h.start();
  const escape = () => h.doc.dispatchEvent(new h.doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(h.doc.body.classList.contains('task-chat-open'));
  escape();
  assert.ok(h.$('.task-chat-modal'), 'the edit modal or a confirm is above it: Escape is theirs');
  top = true;
  escape();
  assert.equal(h.$('.task-chat-modal'), null);
  assert.equal(h.doc.body.classList.contains('task-chat-open'), false);
});

// The card button and the Task Edit Modal header both call open(<task key>): whichever is used
// second finds the session the first one started.
test('opening the same task again attaches to its one session and restores the transcript', (t) => {
  const h = harness(t);
  h.env.open('TPT1');
  h.feed({ type: 'config', objectiveProviders: [] });
  click(h.$('.task-chat-start-go'));
  assert.deepEqual(h.sent.map(f => f.type), ['start-task-chat']);
  h.feed({ type: 'data', data: 'Hello.' });
  h.feed({ type: 'chat-ready' });
  h.env.close();
  assert.equal(h.sent.some(f => f.type === 'kill'), false, 'closing only detaches');
  h.sent.length = 0;

  h.env.open('TPT1');
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[0].url, 'ws://test/?taskId=taskChat:TPT1');
  assert.equal(h.sockets[1].url, h.sockets[0].url, 'same session id');
  h.feed({
    type: 'chat-history-reset',
    running: false,
    messages: [{ role: 'user', content: 'seed', seed: true }, { role: 'assistant', content: 'Hello.' }],
  });
  h.feed({ type: 'config', objectiveProviders: [] });
  assert.deepEqual(h.sent, [], 'no second start-task-chat');
  assert.equal(h.$$('.task-chat-msg--assistant').length, 1);
  assert.match(h.$('.task-chat-msg--assistant .task-chat-body').textContent, /Hello\./);
  assert.equal(h.$$('.task-chat-modal').length, 1);
  assert.equal(h.$('.task-chat-start').hidden, true, 'a restored chat shows no start gate');
  assert.equal(h.$('.task-chat-panel').classList.contains('task-chat-panel--gated'), false);
});

// ── Start gate (C1292) ──

const PROVIDERS = [
  { id: 'claude', label: 'Claude', available: true, defaultModel: 'opus', models: [{ value: 'opus' }, { value: 'sonnet' }] },
  { id: 'codex', label: 'Codex', available: true, defaultModel: 'gpt', models: [{ value: 'gpt' }] },
];

test('a fresh task chat waits at the start gate: nothing is sent until Start', (t) => {
  const h = harness(t);
  h.env.open('TPT1');
  assert.equal(h.$('.task-chat-start').hidden, true, 'no gate before the server said there is no session');
  assert.ok(h.$('.task-chat-panel').classList.contains('task-chat-panel--connecting'), 'no composer while connecting');
  h.feed({ type: 'config', objectiveProviders: PROVIDERS });
  assert.deepEqual(h.sent, [], 'connecting started nothing');
  assert.equal(h.$('.task-chat-start').hidden, false);
  assert.ok(h.$('.task-chat-panel').classList.contains('task-chat-panel--gated'));
  assert.equal(h.$('.task-chat-start-lead').textContent, 'taskChat.start.taskLead:TPT1');
  assert.equal(h.$('#task-chat-start-model-select').value, 'claude:opus');
  assert.equal(h.$('.task-chat-start-go').disabled, false);
  assert.equal(h.$('.task-chat-empty'), null, 'the gate stands in for the empty state');
  h.$('.task-chat-input').value = 'sneaky';
  h.env.sendMessage();
  assert.deepEqual(h.sent, [], 'the hidden composer cannot send either');
});

test('the model picked at the gate rides on the start frame, and a second Start sends nothing', (t) => {
  const h = harness(t);
  h.env.open('TPT1');
  h.feed({ type: 'config', objectiveProviders: PROVIDERS });
  const select = h.$('#task-chat-start-model-select');
  select.value = 'codex:gpt';
  change(select);
  assert.equal(h.$('#task-chat-model-select').value, 'codex:gpt', 'the composer select follows');
  const go = h.$('.task-chat-start-go');
  click(go);
  click(go);
  h.env.beginChat();
  assert.deepEqual(h.sent, [{ type: 'start-task-chat', model: 'codex:gpt' }]);
  assert.equal(h.$('.task-chat-start').hidden, true);
  assert.equal(h.$('.task-chat-panel').classList.contains('task-chat-panel--gated'), false);
  assert.ok(h.$('.task-chat-msg--streaming'), 'the first reply is on its way');
});

test('Cancel at the gate closes the window without killing or starting anything', (t) => {
  const h = harness(t);
  h.env.open('TPT1');
  h.feed({ type: 'config', objectiveProviders: PROVIDERS });
  click(h.$('.task-chat-start-cancel'));
  assert.equal(h.$('.task-chat-modal'), null);
  assert.deepEqual(h.sent, []);
  assert.equal(h.sockets[0].readyState, 3, 'the socket of the pending session is closed');
});

test('a gate whose providers are all unavailable cannot start', (t) => {
  const h = harness(t);
  h.env.open('TPT1');
  h.feed({ type: 'config', objectiveProviders: PROVIDERS.map(p => ({ ...p, available: false })) });
  assert.equal(h.$('.task-chat-start-go').disabled, true);
  assert.equal(h.$('.task-chat-start-note').hidden, false);
  assert.equal(h.$('.task-chat-start-note').textContent, 'taskChat.start.noModels');
  click(h.$('.task-chat-start-go'));
  h.env.beginChat();
  assert.deepEqual(h.sent, []);
});

test('a failed start offers Retry, which reconnects to a fresh gate', (t) => {
  const h = harness(t);
  h.env.open('TPT1');
  h.feed({ type: 'config', objectiveProviders: PROVIDERS });
  click(h.$('.task-chat-start-go'));
  h.feed({ type: 'error', message: 'Task not found: TPT1' });
  click(h.$('.task-chat-retry'));
  assert.equal(h.sockets.length, 2, 'a new socket');
  h.sent.length = 0;
  h.feed({ type: 'config', objectiveProviders: PROVIDERS });
  assert.equal(h.$('.task-chat-start').hidden, false, 'the gate again — a model can be changed');
  assert.deepEqual(h.sent, []);
});

test('openProjectChat() connects to this window\'s project and starts it with start-project-chat', async (t) => {
  const h = harness(t);
  h.env.fetch = async (url) => ({
    ok: url === '/api/project-config',
    json: async () => ({ config: { API_PROJECT_ID: '2', projectName: 'Tipatask' } }),
  });
  await h.env.openProjectChat();
  assert.equal(h.sockets[0].url, 'ws://test/?taskId=projectChat:2');
  assert.equal(h.$('.task-chat-key'), null, 'no task key in the header');
  assert.equal(h.$('.task-chat-title-text').textContent, 'Tipatask');
  assert.equal(h.$('.task-chat-eyebrow-text').textContent, 'taskChat.projectEyebrow');
  h.feed({ type: 'config', objectiveProviders: PROVIDERS });
  assert.deepEqual(h.sent, [], 'opening is not an agent turn');
  assert.equal(h.$('.task-chat-start-lead').textContent, 'taskChat.start.projectLead:Tipatask');
  click(h.$('.task-chat-start-go'));
  assert.deepEqual(h.sent, [{ type: 'start-project-chat', model: 'claude:opus' }]);
  assert.equal(h.$('.task-chat-input').placeholder, 'taskChat.project.placeholder');
});

test('openProjectChat() with no selected project shows a toast and opens nothing', async (t) => {
  const h = harness(t);
  const toasts = [];
  h.env.showToast = (msg) => toasts.push(msg);
  h.env.fetch = async () => ({ ok: true, json: async () => ({ config: {} }) });
  await h.env.openProjectChat();
  assert.deepEqual(toasts, ['taskChat.error.noProject']);
  assert.equal(h.$('.task-chat-modal'), null);
  assert.equal(h.sockets.length, 0);
});

test('a project chat with history restores it and shows no gate', async (t) => {
  const h = harness(t);
  h.env.fetch = async () => ({ ok: true, json: async () => ({ config: { API_PROJECT_ID: '2' } }) });
  await h.env.openProjectChat();
  h.feed({
    type: 'chat-history-reset', running: false, projectId: '2',
    messages: [{ role: 'user', content: 'seed', seed: true }, { role: 'assistant', content: 'Project overview.' }],
  });
  h.feed({ type: 'config', objectiveProviders: PROVIDERS });
  assert.deepEqual(h.sent, []);
  assert.equal(h.$('.task-chat-start').hidden, true);
  assert.equal(h.$('.task-chat-title-text').textContent, '#2', 'no project name: the id');
});

test('a language switch relabels the open window; any other reload leaves it alone', (t) => {
  const h = harness(t);
  h.start();
  const reload = () => h.doc.dispatchEvent(new h.doc.defaultView.Event('tiptask:reload'));
  const labels = () => ({
    eyebrow: h.$('.task-chat-eyebrow-text').textContent,
    newChat: h.$('.task-chat-new').getAttribute('aria-label'),
    newChatTip: h.$('.task-chat-new').title,
    close: h.$('.task-chat-close').getAttribute('aria-label'),
    jump: h.$('.task-chat-jump span').textContent,
    placeholder: h.$('.task-chat-input').placeholder,
    inputName: h.$('.task-chat-input').getAttribute('aria-label'),
    hint: h.$('.task-chat-hint').textContent,
    send: h.$('.task-chat-send span').textContent,
    stop: h.$('.task-chat-stop span').textContent,
    stopTip: h.$('.task-chat-stop').title,
    author: h.$('.task-chat-author').textContent,
  });
  const english = {
    eyebrow: 'taskChat.eyebrow', newChat: 'taskChat.newChat', newChatTip: 'taskChat.newChat', close: 'btn.close',
    jump: 'taskChat.jumpToLatest', placeholder: 'taskChat.placeholder', inputName: 'taskChat.placeholder',
    hint: 'taskChat.hint', send: 'taskChat.send', stop: 'btn.stop', stopTip: 'tooltip.stop', author: 'taskChat.assistant',
  };
  assert.deepEqual(labels(), english);

  const message = h.$('.task-chat-msg--assistant');
  reload();
  assert.equal(h.$('.task-chat-msg--assistant'), message, 'same language: the transcript is not rebuilt');
  assert.deepEqual(labels(), english);

  h.$('.task-chat-input').value = 'half-typed';
  h.setLocale('uk');
  reload();
  assert.deepEqual(labels(), Object.fromEntries(Object.entries(english).map(([name, key]) => [name, `uk:${key}`])));
  assert.match(h.$('.task-chat-msg--assistant .task-chat-body').textContent, /Hello\./, 'the conversation is kept');
  assert.equal(h.$('.task-chat-input').value, 'half-typed', 'and so is the draft');
  assert.equal(h.sockets.length, 1, 'no reconnect');

  h.env.close();
  h.setLocale('en');
  reload(); // listener is gone with the window: must not throw
  assert.equal(h.$('.task-chat-modal'), null);
});
