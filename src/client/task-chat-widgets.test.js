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
const { createLiveInserter } = await import('./utils.js');
const voiceHelpers = {
  ...await import('./voice-errors.js'),
  ...await import('./voice-model-state.js'),
  ...await import('./voice-report.js'),
  ...await import('./voice-devices.js'),
  ...await import('./voice-silence.js'),
  ...await import('./voice-shortcut.js'),
};
const recorderSource = readFileSync(new URL('./audio-recorder.js', import.meta.url), 'utf8');

const DIALOG = {
  id: 'dlg-1',
  question: 'Where should it go?',
  options: [{ label: 'Current sprint', description: 'Same priority' }, { label: 'Backlog', description: '' }],
  multi: false,
};
const TASK = { id: 'TPT9', title: 'New task', description: 'Body', status: 'pending', tags: ['feature'], dependencies: [] };

function harness(t, { topLayer = () => true, draftStorage = new Map(), projectPath = '/projects/alpha', voice = false } = {}) {
  const window = new Window();
  t.after(() => window.happyDOM.close());
  const sent = [];
  const opened = [];
  const sockets = [];
  const uploads = { menus: [], drops: [], pastes: [] };
  const recordings = [];
  const toasts = [];
  let locale = 'en';
  let currentProjectPath = projectPath;
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
    close() { this.readyState = 3; }
  }
  FakeSocket.OPEN = 1;
  const env = {
    window, document: window.document, WebSocket: FakeSocket, console,
    localStorage: {
      getItem: key => draftStorage.get(key) ?? null,
      setItem: (key, value) => draftStorage.set(key, String(value)),
      removeItem: key => draftStorage.delete(key),
    },
    requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame: () => {},
    setTimeout: () => 1, clearTimeout: () => {},
    fetch: async () => ({ ok: false }),
    Promise, JSON, Map, Set, WeakMap, Array, String, Number, Math,
    buildWsUrl: id => `ws://test/?taskId=${id}`,
    wsSend: (_ws, type, payload) => sent.push({ type, ...payload }),
    WS_SEND_TYPES, WS_RECV_TYPES,
    renderMarkdown: text => `<p>${text}</p>`,
    escapeAttr: value => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    autoGrowTextarea: () => {},
    projectHeader: () => ({ 'x-tipatask-project': currentProjectPath }), showToast: () => {},
    modelLabel: (_id, value) => value,
    CHAT_BUBBLE_SVG: '<svg class="chat-bubble"></svg>',
    state: { objectiveProviders: [], objectiveModel: '' },
    showActionConfirm: async () => true,
    activateDialogFocus: () => ({ close() {}, focusFirst() {}, isTop: topLayer }),
    // English reads as the bare key; any other locale is prefixed, so a relabel is visible.
    t: (key, params) => (locale === 'en' ? '' : `${locale}:`) + (params ? `${key}:${Object.values(params).join(',')}` : key),
    getLocale: () => locale,
    renderCard: (task, opts) => `<div class="card card--preview" data-preview-task="${task.id}" data-opts="${opts.preview}">${task.title}</div>`,
    openTaskEditModal: async (key, callbacks) => { opened.push({ key, callbacks }); },
    // (TPT473) The shared Embed control and uploads: markup only, and the options each wiring
    // call received, so a test can play an upload's callbacks.
    embedMenuHtml: () => '<div class="embed-menu-wrap"><button type="button" class="embed-menu-trigger"><span class="embed-menu-label"></span></button></div>',
    attachEmbedMenu: (wrap, textarea, opts) => uploads.menus.push({ wrap, textarea, opts }),
    attachFileDrop: (target, textarea, opts) => uploads.drops.push({ target, textarea, opts }),
    attachImagePaste: (textarea, _ws, opts) => uploads.pastes.push({ textarea, opts }),
    closeOpenEmbedMenu: () => {},
    attachAudioRecorder: () => null,
    ...model,
  };
  if (voice) {
    const track = { stopped: false, stop() { this.stopped = true; } };
    class Recorder extends window.EventTarget {
      state = 'inactive';
      mimeType = 'audio/webm';
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.dispatchEvent(new window.Event('stop')); }
    }
    Object.assign(env, voiceHelpers, {
      createLiveInserter,
      pureMatchesVoiceShortcut: voiceHelpers.matchesVoiceShortcut,
      pureVoiceShortcutLabel: voiceHelpers.voiceShortcutLabel,
      navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } },
      MediaRecorder: Recorder, Blob, CustomEvent: window.CustomEvent, Event: window.Event,
      showToast: message => toasts.push(message),
      api: { transcribeAudio: async () => ({ transcript: 'Fallback speech.' }) },
      createVoiceStream: callbacks => {
        const stream = { ...callbacks, start() {}, stop: async () => ({ micPeak: 1 }) };
        recordings.push(stream);
        return stream;
      },
      track,
    });
  }
  vm.createContext(env);
  if (voice) {
    // Run the real inserter in this DOM's realm so its input events use the matching Event.
    env.createLiveInserter = vm.runInContext(`(${createLiveInserter.toString()})`, env);
    vm.runInContext(recorderSource.replace(/^import [\s\S]*?;\n/gm, '').replace(/^export /gm, ''), env);
  }
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
  const setProjectPath = (path) => { currentProjectPath = path; };
  return { env, doc, sent, opened, sockets, uploads, recordings, toasts, feed, start, turn, setLocale, setProjectPath,
    $: sel => doc.querySelector(sel), $$: sel => [...doc.querySelectorAll(sel)] };
}

function click(el) { el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true })); }
function change(el) { el.dispatchEvent(new el.ownerDocument.defaultView.Event('change', { bubbles: true })); }

// An assistant turn that ends with the dialog above.
function askDialog(h) {
  h.turn();
  h.feed({ type: 'data', data: 'Pick one.\n\n```ask_user\n{"question":"Where should it go?"}\n```' });
  h.feed({ type: 'task-chat-dialog', taskKey: 'TPT1', dialog: DIALOG });
}

function typeDraft(h, text) {
  const input = h.$('.task-chat-input');
  input.value = text;
  input.dispatchEvent(new h.doc.defaultView.Event('input', { bubbles: true }));
}

const drainVoice = () => new Promise(resolve => setImmediate(resolve));

for (const kind of ['task', 'project']) {
  test(`${kind} chat voice preserves typing through streaming and fallback without sending`, async t => {
    const h = harness(t, { voice: true });
    if (kind === 'task') h.start();
    else {
      h.env.fetch = async () => ({ ok: true, json: async () => ({ config: { API_PROJECT_ID: '2' } }) });
      await h.env.openProjectChat();
      h.feed({ type: 'config', objectiveProviders: [] });
      click(h.$('.task-chat-start-go'));
      h.feed({ type: 'chat-ready' });
      h.sent.length = 0;
    }
    const input = h.$('.task-chat-input');
    const recorder = input.__voiceRecorder;
    const mic = h.$('.audio-rec-btn');
    assert.ok(recorder);
    assert.equal(mic.disabled, false);
    assert.equal(mic.title, mic.getAttribute('aria-label'));
    typeDraft(h, 'Typed: ');
    input.setSelectionRange(input.value.length, input.value.length);
    await recorder.start();
    const stream = h.recordings.at(-1);
    stream.onPartial('Hello');
    assert.equal(input.value, 'Typed: Hello');
    stream.onPartial('Hello world');
    assert.equal(input.value, 'Typed: Hello world');
    stream.onFinal('Hello world.');
    recorder.stop();
    await drainVoice();
    assert.equal(input.value, 'Typed: Hello world. ');
    await recorder.start();
    h.recordings.at(-1).onPartial('Fallback');
    recorder.stop();
    await drainVoice();
    assert.equal(input.value, 'Typed: Hello world. Fallback speech. ');
    assert.deepEqual(h.sent, [], 'transcripts never submit a chat message');
    h.env.close();
    if (kind === 'task') h.env.open('TPT1');
    else await h.env.openProjectChat();
    assert.equal(h.$('.task-chat-input').value, 'Typed: Hello world. Fallback speech. ', 'voice uses normal draft persistence');
  });
}

test('chat voice locks through connection, gate, reply and model availability; labels relocalize', async t => {
  const h = harness(t, { voice: true });
  h.env.open('TPT1');
  const mic = h.$('.audio-rec-btn');
  const recorder = h.$('.task-chat-input').__voiceRecorder;
  assert.equal(mic.disabled, true);
  h.feed({ type: 'config', objectiveProviders: [] });
  await recorder.start();
  assert.equal(h.recordings.length, 0);
  click(h.$('.task-chat-start-go'));
  assert.equal(mic.disabled, true);
  h.feed({ type: 'chat-ready' });
  assert.equal(mic.disabled, false);
  h.env.setVoiceInputAvailability('local', [], 'missing');
  assert.equal(mic.disabled, true);
  await recorder.start();
  assert.equal(h.recordings.length, 0);
  assert.match(h.toasts.at(-1), /voice.errEngineUnavailable/);
  h.env.setVoiceInputAvailability('cloud', [], '');
  assert.equal(mic.disabled, false);
  h.turn();
  h.env.setVoiceInputAvailability('cloud', [], '');
  assert.equal(mic.disabled, true, 'availability updates preserve reply lock');
  h.feed({ type: 'chat-ready' });
  assert.equal(mic.disabled, false);
  h.setLocale('uk');
  h.doc.dispatchEvent(new h.env.window.Event('tiptask:reload'));
  assert.match(mic.title, /^uk:voice.record/);
  assert.equal(mic.title, mic.getAttribute('aria-label'));
  h.sockets.at(-1).onclose();
  assert.equal(mic.disabled, true);
});

test('voice shortcut targets chat controls, excludes hidden panes and stops active capture first', async t => {
  const h = harness(t, { voice: true });
  h.start();
  const input = h.$('.task-chat-input');
  const recorder = input.__voiceRecorder;
  const other = h.doc.createElement('textarea');
  other.id = 'chat-input';
  other.__voiceRecorder = { toggle() {} };
  h.doc.body.append(other);
  typeDraft(h, 'Draft');
  h.$('.task-chat-send').focus();
  assert.equal(h.env.resolveVoiceTarget(), recorder);
  input.focus();
  assert.equal(h.env.resolveVoiceTarget(), recorder);
  h.$('.audio-rec-btn').focus();
  assert.equal(h.env.resolveVoiceTarget(), recorder);
  await recorder.start();
  other.focus();
  assert.equal(h.env.resolveVoiceTarget(), recorder, 'active mic outranks another focused field');
  recorder.stop();
  await drainVoice();
  h.$('.task-chat-modal').hidden = true;
  other.blur();
  assert.equal(h.env.resolveVoiceTarget(), other.__voiceRecorder);
});

test('permission denial and close during permission prompt leave no capture or crossed draft', async t => {
  const h = harness(t, { voice: true });
  h.start();
  const recorder = h.$('.task-chat-input').__voiceRecorder;
  h.env.navigator.mediaDevices.getUserMedia = async () => { throw new Error('denied'); };
  await recorder.start();
  assert.equal(h.recordings.length, 0);
  assert.equal(h.toasts.at(-1), 'voice.micDenied');
  let grant;
  h.env.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const start = recorder.start();
  await drainVoice();
  h.$('.task-chat-close').focus();
  assert.equal(h.env.resolveVoiceTarget(), recorder, 'permission-pending capture keeps shortcut priority');
  h.env.close();
  h.env.open('TPT2');
  grant({ getTracks: () => [h.env.track] });
  await start;
  assert.equal(h.env.track.stopped, true);
  assert.equal(h.recordings.length, 0);
  assert.equal(h.$('.task-chat-input').value, '');
});

test('closing chat stops capture and rejects delayed streaming and batch results after reopening', async t => {
  const h = harness(t, { voice: true });
  h.start();
  typeDraft(h, 'Original draft');
  const input = h.$('.task-chat-input');
  await input.__voiceRecorder.start();
  const stream = h.recordings.at(-1);
  let finishDrain;
  stream.stop = () => new Promise(resolve => { finishDrain = resolve; });
  input.__voiceRecorder.stop();
  await input.__voiceRecorder.start();
  assert.equal(h.recordings.length, 1, 'shortcut cannot start another capture while draining');
  h.env.close();
  assert.equal(h.env.track.stopped, true);
  h.env.open('TPT2');
  typeDraft(h, 'Other draft');
  stream.onPartial('Late partial');
  stream.onFinal('Late final');
  finishDrain({ micPeak: 1 });
  await drainVoice();
  assert.equal(input.value, 'Original draft');
  assert.equal(h.$('.task-chat-input').value, 'Other draft');
  h.env.close();
  h.start();
  let finishBatch;
  h.env.api.transcribeAudio = () => new Promise(resolve => { finishBatch = resolve; });
  const sameChatInput = h.$('.task-chat-input');
  await sameChatInput.__voiceRecorder.start();
  sameChatInput.__voiceRecorder.stop();
  await drainVoice();
  h.env.close();
  h.env.open('TPT1');
  finishBatch({ transcript: 'Late batch' });
  await drainVoice();
  assert.equal(h.$('.task-chat-input').value, 'Original draft', 'even reopening the same chat rejects stale results');
});

test('hiding embedded Chat pane stops capture and preserves its draft', async t => {
  const h = harness(t, { voice: true });
  const host = h.doc.createElement('div');
  h.doc.body.append(host);
  const pane = h.env.mount(host, 'TPT1');
  h.feed({ type: 'config', objectiveProviders: [] });
  click(h.$('.task-chat-start-go'));
  h.feed({ type: 'chat-ready' });
  const input = h.$('.task-chat-input');
  typeDraft(h, 'Keep ');
  input.setSelectionRange(input.value.length, input.value.length);
  await input.__voiceRecorder.start();
  pane.hide();
  await drainVoice();
  assert.equal(h.env.track.stopped, true);
  assert.equal(input.value, 'Keep Fallback speech. ');
  pane.show();
  assert.equal(h.$('.task-chat-input'), input);
  pane.dispose();
});

test('task and project drafts survive reopening and reload without crossing projects', async (t) => {
  const storage = new Map();
  const h = harness(t, { draftStorage: storage });
  h.env.open('TPT1');
  typeDraft(h, 'Task draft');
  h.env.close();

  h.env.fetch = async () => ({ ok: true, json: async () => ({ config: { API_PROJECT_ID: '2' } }) });
  await h.env.openProjectChat();
  assert.equal(h.$('.task-chat-input').value, '', 'project chat has its own draft');
  typeDraft(h, 'Project draft');
  h.env.close();

  h.env.open('TPT1');
  assert.equal(h.$('.task-chat-input').value, 'Task draft', 'same task restores after closing');
  h.env.close();
  h.env.open('TPT2');
  assert.equal(h.$('.task-chat-input').value, '', 'another task in the same project stays empty');
  h.env.close();
  h.setProjectPath('/projects/beta');
  h.env.open('TPT1');
  assert.equal(h.$('.task-chat-input').value, '', 'same task key in another project stays empty');
  h.env.close();
  h.env.fetch = async () => ({ ok: true, json: async () => ({ config: { API_PROJECT_ID: '3' } }) });
  await h.env.openProjectChat();
  assert.equal(h.$('.task-chat-input').value, '', 'another project chat stays empty');
  h.env.close();

  const reloaded = harness(t, { draftStorage: storage });
  reloaded.env.open('TPT1');
  assert.equal(reloaded.$('.task-chat-input').value, 'Task draft', 'task draft survives renderer reload');
  reloaded.env.close();
  reloaded.env.fetch = async () => ({ ok: true, json: async () => ({ config: { API_PROJECT_ID: '2' } }) });
  await reloaded.env.openProjectChat();
  assert.equal(reloaded.$('.task-chat-input').value, 'Project draft', 'project draft survives renderer reload');
});

test('sending clears persisted draft; an aborted turn stores returned text again', (t) => {
  const storage = new Map();
  const h = harness(t, { draftStorage: storage });
  h.start();
  typeDraft(h, 'Please check this');
  assert.equal([...storage.keys()].filter(key => key.startsWith('tipatask-task-chat-draft:')).length, 1);
  h.env.sendMessage();
  assert.equal([...storage.keys()].filter(key => key.startsWith('tipatask-task-chat-draft:')).length, 0);
  h.feed({ type: 'generation-aborted' });
  assert.equal(h.$('.task-chat-input').value, 'Please check this');
  assert.equal([...storage.values()].includes('Please check this'), true, 'abort restores persistent draft');
  h.env.close();

  const reloaded = harness(t, { draftStorage: storage });
  reloaded.env.open('TPT1');
  assert.equal(reloaded.$('.task-chat-input').value, 'Please check this');
  reloaded.feed({ type: 'chat-history-reset', running: false,
    messages: [{ role: 'user', content: 'seed', seed: true }, { role: 'assistant', content: 'Hello.' }] });
  reloaded.feed({ type: 'config', objectiveProviders: [] });
  reloaded.env.sendMessage();
  assert.equal(reloaded.sent.at(-1).type, 'task-chat-message');
  assert.equal([...storage.keys()].filter(key => key.startsWith('tipatask-task-chat-draft:')).length, 0);
});

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

test('(TPT475) a reattached project chat opens its pending dialog once config arrives after the history', async (t) => {
  const h = harness(t);
  h.env.fetch = async () => ({ ok: true, json: async () => ({ config: { API_PROJECT_ID: '2' } }) });
  await h.env.openProjectChat();
  // ws-handlers.js order: chat-history-reset, chat-ready, then config from wireClient().
  h.feed({
    type: 'chat-history-reset', running: false, projectId: '2',
    messages: [{ role: 'user', content: 'seed', seed: true }, { role: 'assistant', content: 'Pick.', dialogs: [{ ...DIALOG }] }],
  });
  h.feed({ type: 'chat-ready' });
  const dialog = h.$('.task-chat-widget--dialog');
  assert.equal(dialog.dataset.state, 'waiting', 'built before the socket counts as connected');
  h.feed({ type: 'config', objectiveProviders: [] });
  assert.equal(dialog.dataset.state, 'open');
  assert.equal(dialog.disabled, false);

  const submit = h.$('.task-chat-dialog-submit');
  assert.equal(submit.disabled, true, 'nothing picked yet');
  const radios = h.$$('.task-chat-dialog-options input[type="radio"]');
  radios[0].checked = true;
  change(radios[0]);
  assert.equal(submit.disabled, false);
  click(submit);
  assert.deepEqual(h.sent, [{ type: 'task-chat-answer', dialogId: 'dlg-1', selected: [0], model: undefined }]);
  assert.equal(dialog.dataset.state, 'answered');
  assert.ok(h.$('.task-chat-msg--assistant.task-chat-msg--streaming'), 'the answer starts the next turn');
});

test('(TPT475) a dialog re-sent mid-turn is answered on the record the window repaints from', (t) => {
  const h = harness(t);
  h.start();
  askDialog(h);
  // A reattach mid-turn replays the frame: the record is replaced, the element is kept.
  h.feed({ type: 'task-chat-dialog', taskKey: 'TPT1', dialog: { ...DIALOG } });
  h.feed({ type: 'chat-ready' });
  const dialog = h.$('.task-chat-widget--dialog');
  assert.equal(dialog.dataset.state, 'open');
  const radios = h.$$('.task-chat-dialog-options input[type="radio"]');
  radios[1].checked = true;
  change(radios[1]);
  click(h.$('.task-chat-dialog-submit'));
  assert.equal(h.sent.at(-1).type, 'task-chat-answer');
  assert.equal(dialog.dataset.state, 'answered', 'not "skipped": the answer is on the current record');
});

test('(TPT475) chat-ended takes an open dialog back to waiting', (t) => {
  const h = harness(t);
  h.start();
  askDialog(h);
  h.feed({ type: 'chat-ready' });
  const dialog = h.$('.task-chat-widget--dialog');
  assert.equal(dialog.dataset.state, 'open');
  h.feed({ type: 'chat-ended' });
  assert.equal(dialog.dataset.state, 'waiting');
  assert.equal(dialog.disabled, true);
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
  assert.match(h.sockets[0].url, /^ws:\/\/test\/\?taskId=projectChat:2:[a-z0-9]{6,32}$/);
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
  // (TPT466) No new-chat (pen) button: a new chat starts from the left menu.
  assert.equal(h.$('.task-chat-new'), null);
  const reload = () => h.doc.dispatchEvent(new h.doc.defaultView.Event('tiptask:reload'));
  const labels = () => ({
    eyebrow: h.$('.task-chat-eyebrow-text').textContent,
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
    eyebrow: 'taskChat.eyebrow', close: 'btn.close',
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

test('mounted in a workspace pane: no window chrome, and the transcript and typed text survive hide/show (TPT466)', async (t) => {
  const h = harness(t);
  const win = h.env.window;
  const host = h.doc.createElement('div');
  h.doc.body.appendChild(host);
  const openedTasks = [];
  const handle = h.env.mount(host, 'TPT1', { onOpenTask: key => openedTasks.push(key) });
  assert.ok(handle, 'a pane handle');
  assert.ok(host.querySelector('.task-chat-embed .task-chat-panel--embedded'));
  assert.equal(h.$('.task-chat-modal'), null, 'no window of its own');
  assert.equal(h.$('.task-chat-backdrop'), null);
  assert.equal(h.$('.task-chat-header'), null, 'the workspace top bar carries key and title');
  assert.equal(h.$('.task-chat-new'), null, 'no new-chat button');
  assert.equal(h.doc.body.classList.contains('task-chat-open'), false);
  assert.equal(h.sockets[0].url, 'ws://test/?taskId=taskChat:TPT1');

  h.feed({ type: 'config', objectiveProviders: [] });
  click(h.$('.task-chat-start-go'));
  h.feed({ type: 'data', data: 'Hello.' });
  h.feed({ type: 'chat-ready' });
  const input = h.$('.task-chat-input');
  input.value = 'half-typed';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));

  // Switching panes away and back: same DOM, same socket, same draft.
  const message = h.$('.task-chat-msg--assistant');
  handle.hide();
  host.hidden = true;
  host.hidden = false;
  handle.show({ focus: false });
  assert.equal(h.$('.task-chat-msg--assistant'), message);
  assert.equal(h.$('.task-chat-input').value, 'half-typed');
  assert.equal(h.sockets.length, 1);

  // A task card goes to the workspace, not to a stacked edit modal.
  h.feed({ type: 'task-chat-task', toolId: 'tool-1', action: 'updated', task: { id: 'TPT9', title: 'Other task' } });
  click(h.$('.task-chat-widget--task'));
  assert.deepEqual(openedTasks, ['TPT9']);
  assert.equal(h.opened.length, 0);

  // A save in the Edit pane is reported to the agent.
  h.sent.length = 0;
  handle.taskEdited('TPT1');
  assert.deepEqual(h.sent, [{ type: WS_SEND_TYPES.TASK_CHAT_TASK_EDITED, taskKey: 'TPT1' }]);

  // Disposed and mounted again (workspace closed and reopened): the unsent text comes back.
  handle.dispose();
  assert.equal(host.querySelector('.task-chat-embed'), null);
  const again = h.env.mount(host, 'TPT1', {});
  assert.equal(h.$('.task-chat-input').value, 'half-typed');
  again.dispose();
  handle.dispose(); // a stale handle never closes a newer chat
  assert.equal(host.querySelector('.task-chat-embed'), null);

  // With the workspace bridge loaded, open() routes a task chat to its Chat pane.
  const routed = [];
  win.TipTask = { openTaskWorkspace: (key, opts) => { routed.push({ key, opts }); } };
  await h.env.open('TPT2');
  assert.equal(JSON.stringify(routed), JSON.stringify([{ key: 'TPT2', opts: { pane: 'chat' } }])); // vm realm objects
  assert.equal(h.$('.task-chat-modal'), null);
});

test('(TPT469) Start Chat reuses the untouched draft; a named chat sends the next click to a new one', async (t) => {
  const h = harness(t);
  h.env.fetch = async () => ({ ok: true, json: async () => ({ config: { API_PROJECT_ID: '2', projectName: 'Tipatask' } }) });
  await h.env.openProjectChat();
  const first = h.sockets[0].url;
  const firstId = first.split('taskId=')[1];
  assert.equal(h.env.currentChatId(), firstId);
  await h.env.openProjectChat();
  assert.equal(h.sockets.length, 1, 'the draft is already in front: nothing reconnects');
  h.env.close();
  await h.env.openProjectChat();
  assert.equal(h.sockets[1].url, first, 'a closed, untouched draft opens again');
  h.feed({ type: 'config', objectiveProviders: PROVIDERS });
  click(h.$('.task-chat-start-go'));
  h.feed({ type: 'data', data: 'Hi, what shall we look at?' });
  h.feed({ type: 'chat-ready' });
  h.env.close();
  await h.env.openProjectChat();
  assert.equal(h.sockets[2].url, first, 'the agent greeting alone does not name the chat');
  h.feed({ type: 'chat-history-reset', messages: [{ role: 'assistant', content: 'Hi' }], running: false });
  h.feed({ type: 'config', objectiveProviders: PROVIDERS });
  h.turn('Which tasks block the release?');
  h.feed({ type: 'project-chat-titled', title: 'Which tasks block the release?' });
  assert.equal(h.$('.task-chat-title-text').textContent, 'Which tasks block the release?');
  h.env.close();
  await h.env.openProjectChat();
  assert.notEqual(h.sockets[3].url, first, 'Start Chat now opens a new draft');
  assert.match(h.sockets[3].url, /taskId=projectChat:2:[a-z0-9]{6,32}$/);
  h.env.close();
  await h.env.openProjectChat({ chatId: firstId });
  assert.equal(h.sockets[4].url, first, 'the left-menu row reopens the named chat');
  h.feed({ type: 'chat-history-reset', title: 'Which tasks block the release?', messages: [{ role: 'assistant', content: 'Hi' }], running: false });
  assert.equal(h.$('.task-chat-title-text').textContent, 'Which tasks block the release?');
});

test('(TPT469) Start Chat picks up an untitled chat the server holds; a row of another project opens nothing', async (t) => {
  const h = harness(t);
  h.env.state.sessionMeta = new Map([
    ['projectChat:2:old0001', { type: 'taskChat', title: '', startedAt: 1 }],
    ['projectChat:2:new0002', { type: 'taskChat', title: '', startedAt: 2 }],
    ['projectChat:2:named03', { type: 'taskChat', title: 'Named', startedAt: 3 }],
    ['projectChat:3:other04', { type: 'taskChat', title: '', startedAt: 4 }],
  ]);
  const toasts = [];
  h.env.showToast = msg => toasts.push(msg);
  h.env.fetch = async () => ({ ok: true, json: async () => ({ config: { API_PROJECT_ID: '2' } }) });
  await h.env.openProjectChat();
  assert.equal(h.sockets[0].url, 'ws://test/?taskId=projectChat:2:new0002');
  h.env.close();
  await h.env.openProjectChat({ chatId: 'projectChat:3:other04' });
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(toasts, ['taskChat.error.noProject']);
});


// ── Attachments (TPT473) ──

test('the composer gets the shared Embed control, paste and panel drop, all into the composer textarea', (t) => {
  const h = harness(t);
  h.env.open('TPT1');
  const input = h.$('.task-chat-input');
  assert.equal(h.uploads.pastes.length, 1);
  assert.equal(h.uploads.pastes[0].textarea, input);
  assert.equal(h.uploads.pastes[0].opts.taskKey, 'TPT1');
  assert.deepEqual(h.uploads.menus.map(x => x.wrap.parentElement.className), ['task-chat-embed-slot']);
  assert.ok(h.uploads.menus.every(x => x.textarea === input));
  assert.equal(h.uploads.drops[0].target, h.$('.task-chat-panel'));
  assert.equal(h.uploads.drops[0].textarea, input);
});

test('Send waits for an upload; the sent turn carries the reference and shows it as a thumbnail', (t) => {
  const h = harness(t);
  h.start();
  const { opts } = h.uploads.pastes[0];
  const input = h.$('.task-chat-input');
  opts.onFileDetected({ name: 'shot.png' });
  input.value = 'See ![img](blob:x/1)';
  input.dispatchEvent(new h.doc.defaultView.Event('input', { bubbles: true }));
  assert.equal(h.$('.task-chat-send').disabled, true);
  assert.equal(h.$('.task-chat-upload-status').hidden, false);
  input.value = 'See ![img](http://h/api/projects/2/images/5)';
  opts.onUploaded({ name: 'shot.png' }, 'http://h/api/projects/2/images/5');
  assert.equal(h.$('.task-chat-send').disabled, false);
  assert.equal(h.$('.task-chat-upload-status').hidden, true);
  h.env.sendMessage();
  assert.equal(h.sent.at(-1).type, WS_SEND_TYPES.TASK_CHAT_MESSAGE);
  assert.equal(h.sent.at(-1).content, 'See ![img](http://h/api/projects/2/images/5)');
  const bubble = h.$$('.task-chat-msg--user').at(-1);
  assert.equal(bubble.querySelector('.task-chat-user-text').textContent, 'See');
  assert.equal(bubble.querySelector('.task-chat-attach--image img').getAttribute('src'), '/api/images/2/5');
});

test('a failed image upload drops its placeholder; a file upload holds Send until it settles', async (t) => {
  const h = harness(t);
  h.start();
  const input = h.$('.task-chat-input');
  const image = h.uploads.pastes[0].opts;
  image.onFileDetected({ name: 'a.png' });
  input.value = 'x![img](blob:x/2)';
  image.onUploadError({ name: 'a.png' }, new Error('boom'));
  assert.equal(input.value, 'x');
  let finish;
  h.uploads.menus[0].opts.onFileUpload(new Promise((resolve) => { finish = resolve; }), { name: 'spec.pdf' });
  assert.equal(h.$('.task-chat-send').disabled, true);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.$('.task-chat-send').disabled, false);
});

test('restored history shows attachments of a user turn; a notice stays plain text', (t) => {
  const h = harness(t);
  h.env.open('TPT1');
  h.feed({ type: 'chat-history-reset', messages: [
    { role: 'user', content: 'seed', seed: true },
    { role: 'assistant', content: 'Hi' },
    { role: 'user', content: '[spec.pdf](https://h/api/projects/2/files/7)' },
  ] });
  h.feed({ type: 'config', objectiveProviders: [] });
  const chip = h.$('.task-chat-msg--user .task-chat-attach--file');
  assert.equal(chip.getAttribute('href'), '/api/files/2/7');
  assert.equal(h.$('.task-chat-msg--user .task-chat-user-text'), null);
});

test('the start gate holds only the model select and Cancel / Start; Embed waits in the composer', (t) => {
  const h = harness(t);
  h.env.open('TPT1');
  h.feed({ type: 'config', objectiveProviders: [] });
  const gate = h.$('.task-chat-start');
  assert.equal(gate.hidden, false);
  assert.equal(gate.querySelector('.embed-menu-wrap'), null);
  assert.equal(gate.querySelector('.task-chat-attachments'), null);
  assert.ok(gate.querySelector('.task-chat-start-model'));
  assert.ok(gate.querySelector('.task-chat-start-cancel'));
  assert.ok(gate.querySelector('.task-chat-start-go'));
  typeDraft(h, '![img](http://h/api/projects/2/images/9)');
  click(h.$('.task-chat-start-go'));
  assert.equal(gate.hidden, true);
  assert.equal(h.$('.task-chat-input').value, '![img](http://h/api/projects/2/images/9)');
  assert.equal(h.uploads.menus[0].textarea, h.$('.task-chat-input'));
  assert.ok(h.$('.task-chat-embed-slot .embed-menu-wrap'));
});
