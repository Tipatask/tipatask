import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let updateClaudeButtonsCount = 0;
let constructorCount = 0;
let lastNotification = null;

globalThis.window = {
  TipTask: {
    fetchActiveSessions: async () => {},
    taskBoard: { updateClaudeButtons: () => { updateClaudeButtonsCount++; } },
  },
};

// notify()'s debounce is real internal module state in notifications.js — using it directly
// (rather than trying to spy on the named `clearDebounce` import, which ESM namespace objects
// don't allow reassigning) is what lets these tests prove the re-arm behavior for real: a
// distinct promptText must let a fresh Notification through, an unchanged one must not.
//
// No document/window.electronAPI mock is set up in this file — attention-notifications.js's
// isTaskInUserFocus()/_taskCard() treat `typeof document === 'undefined'` as "not focused, no
// card rendered" (C1058), which is exactly the scenario these tests exercise (app backgrounded).
globalThis.Notification = class MockNotification {
  constructor(title, options) { constructorCount++; lastNotification = { title, options }; }
  set onclick(_h) {}
  static get permission() { return 'granted'; }
  static requestPermission() { return Promise.resolve('granted'); }
};

const stateModule = await import('./state.js');
const state = stateModule.default;
const { notify, clearDebounce } = await import('./notifications.js');
const { handleAttentionMessage, forwardTaskStateMessage, handleTaskActivityMessage } = await import('./attention-ws.js');
const { forgetTaskAttention } = await import('./attention-notifications.js');
const { _resetTaskActivity } = await import('./task-activity.js');
const { _resetActivityNotifications } = await import('./activity-notifications.js');

beforeEach(() => {
  updateClaudeButtonsCount = 0;
  constructorCount = 0;
  lastNotification = null;
  state.attentionSessions = new Set();
  state.attentionDetails = new Map();
  state.activeTerminal = null; // (C1387) attention-cleared only clears when this task's terminal is open
  // notifications.js's 30s per-tag debounce and attention-notifications.js's "already told the
  // user" ledger (C1058) are both module-singleton state, shared across every test in this
  // file — every test below notifies tag 'C1', so without this a later test's notify() silently
  // no-ops against an earlier test's still-armed debounce/ledger entry.
  clearDebounce('C1');
  forgetTaskAttention('C1');
  clearDebounce('activity-TPT1');
  _resetTaskActivity();
  _resetActivityNotifications();
  state.taskStatusById = new Map();
  state.taskTitleById = new Map();
});

test('attention-needed adds the task and stores its detail', () => {
  handleAttentionMessage({ type: 'attention-needed', taskId: 'C1', kind: 'toolApproval', promptText: 'Allow ls?', agent: 'codex' });
  assert.equal(state.attentionSessions.has('C1'), true);
  assert.deepEqual(state.attentionDetails.get('C1'), { kind: 'toolApproval', promptText: 'Allow ls?', agent: 'codex' });
  assert.equal(updateClaudeButtonsCount, 1);
});

test('attention-needed with an unchanged promptText does not re-arm the debounce', () => {
  notify('title', 'body', 'C1'); // arm
  assert.equal(constructorCount, 1);
  handleAttentionMessage({ type: 'attention-needed', taskId: 'C1', kind: 'attention', promptText: 'Same question?', agent: 'claude' });
  handleAttentionMessage({ type: 'attention-needed', taskId: 'C1', kind: 'attention', promptText: 'Same question?', agent: 'claude' });
  notify('title', 'body', 'C1'); // still debounced
  assert.equal(constructorCount, 1);
});

test('attention-needed with a changed promptText re-arms the debounce for that task', () => {
  notify('title', 'body', 'C1'); // arm
  assert.equal(constructorCount, 1);
  handleAttentionMessage({ type: 'attention-needed', taskId: 'C1', kind: 'attention', promptText: 'First question?', agent: 'claude' });
  handleAttentionMessage({ type: 'attention-needed', taskId: 'C1', kind: 'attention', promptText: 'Second question?', agent: 'claude' });
  notify('title', 'body', 'C1'); // re-armed by the promptText change -> lets a fresh notification through
  assert.equal(constructorCount, 2);
  assert.equal(state.attentionDetails.get('C1').promptText, 'Second question?');
});

// (C1060) attention-cleared no longer clears the notify() debounce (forgetTaskAttention() only
// clears the "already told" ledger now) — belt-and-braces flap damping so a raise/clear cycle
// can never produce more than one OS notification per 30s per task. See attention-notifications
// .test.js's "forgetTaskAttention clears the ledger but leaves the notify() debounce floor in
// place" for the unit-level version of this contract.
//
// (C1387) attention-cleared is now STICKY by design — the reported bug was the board/nav
// highlight silently going out on its own. A server clear alone must never do that; only the
// user opening the task's terminal (or the session ending) may. The one exception is proven by
// the next test: the user IS currently looking at this task's terminal, so the server clear is
// trustworthy (they just answered it).
test('attention-cleared with no terminal open leaves the flag lit, but still forgets the notify ledger and repaints', () => {
  state.attentionSessions.add('C1');
  state.attentionDetails.set('C1', { kind: 'attention', promptText: 'x', agent: 'claude' });
  notify('title', 'body', 'C1'); // arm
  assert.equal(constructorCount, 1);
  handleAttentionMessage({ type: 'attention-cleared', taskId: 'C1' });
  assert.equal(state.attentionSessions.has('C1'), true); // sticky — not cleared
  assert.equal(state.attentionDetails.has('C1'), true);
  assert.equal(updateClaudeButtonsCount, 1); // still repaints (e.g. debounce-driven changes)
  notify('title', 'body', 'C1'); // debounce untouched by the clear -> still suppressed
  assert.equal(constructorCount, 1);
});

test('attention-cleared DOES clear when the user has that task\'s terminal open', () => {
  state.attentionSessions.add('C1');
  state.attentionDetails.set('C1', { kind: 'attention', promptText: 'x', agent: 'claude' });
  state.activeTerminal = { taskId: 'C1' };
  handleAttentionMessage({ type: 'attention-cleared', taskId: 'C1' });
  assert.equal(state.attentionSessions.has('C1'), false);
  assert.equal(state.attentionDetails.has('C1'), false);
});

// (TPT357) Warn-then-kill: the warn and kill session-runaway frames arrive one 30s sweep apart —
// exactly notify()'s own 30s per-task debounce — so the kill frame must clear it or its OS banner
// can be dropped as a repeat of the warn's.
test('session-runaway stores its detail with killed=false for a warn frame and does not touch the debounce', () => {
  notify('title', 'body', 'C1'); // arm
  assert.equal(constructorCount, 1);
  handleAttentionMessage({ type: 'session-runaway', taskId: 'C1', count: 60, threshold: 50, promptText: 'warn text' });
  assert.equal(state.attentionSessions.has('C1'), true);
  assert.equal(state.attentionDetails.get('C1').killed, false);
  assert.equal(constructorCount, 1); // still inside the debounce window -> warn banner suppressed
});

test('session-runaway with killed=true stores killed in the detail and re-arms the debounce so the kill notifies', () => {
  notify('title', 'body', 'C1'); // the warn banner already went out and armed the debounce
  assert.equal(constructorCount, 1);
  handleAttentionMessage({ type: 'session-runaway', taskId: 'C1', count: 69, threshold: 50, promptText: 'kill text', killed: true });
  assert.equal(state.attentionDetails.get('C1').killed, true);
  assert.equal(state.attentionDetails.get('C1').promptText, 'kill text');
  assert.equal(constructorCount, 2); // the kill's OS banner went through despite the armed debounce
  assert.equal(lastNotification.options.body, 'kill text');
});

test('session-ended removes attention state for that task', () => {
  state.attentionSessions.add('C1');
  state.attentionDetails.set('C1', { kind: 'attention', promptText: 'x', agent: 'claude' });
  handleAttentionMessage({ type: 'session-ended', taskId: 'C1' });
  assert.equal(state.attentionSessions.has('C1'), false);
  assert.equal(state.attentionDetails.has('C1'), false);
});

test('an unrelated message type is ignored and returns false', () => {
  const result = handleAttentionMessage({ type: 'tasks-updated' });
  assert.equal(result, false);
  assert.equal(updateClaudeButtonsCount, 0);
});

// (C1387) Explicit guard for task C1387 item 1: task-change-poll.js's bare `{type:'tasks-updated'}`
// (and any other frame type) must never touch attention bookkeeping — only attention-needed,
// attention-cleared, and session-ended may (see the module-doc comment on handleAttentionMessage
// in attention-ws.js).
test('a tasks-updated frame leaves a raised attention flag and its detail untouched', () => {
  state.attentionSessions.add('C1');
  state.attentionDetails.set('C1', { kind: 'toolApproval', promptText: 'Allow ls?', agent: 'codex' });
  handleAttentionMessage({ type: 'tasks-updated' });
  handleAttentionMessage({ type: 'task:updated', task: { id: 'C1', status: 'in_progress' } });
  assert.equal(state.attentionSessions.has('C1'), true);
  assert.deepEqual(state.attentionDetails.get('C1'), { kind: 'toolApproval', promptText: 'Allow ls?', agent: 'codex' });
});

test('forwardTaskStateMessage dispatches task-state events for board and Objective consumers', () => {
  const events = [];
  const savedDocument = globalThis.document;
  const savedCustomEvent = globalThis.CustomEvent;
  globalThis.document = { dispatchEvent: event => events.push(event) };
  globalThis.CustomEvent = class MockCustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init.detail;
    }
  };
  try {
    assert.equal(forwardTaskStateMessage({ type: 'tasks-updated' }), true);
    assert.equal(forwardTaskStateMessage({ type: 'task:updated', task: { id: 'C2', status: 'completed' } }), true);
    assert.equal(forwardTaskStateMessage({ type: 'attention-needed' }), false);
    assert.deepEqual(events.map(event => [event.type, event.detail.type]), [
      ['tiptask:task-state-update', 'tasks-updated'],
      ['tiptask:task-state-update', 'task:updated'],
    ]);
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    if (savedCustomEvent === undefined) delete globalThis.CustomEvent;
    else globalThis.CustomEvent = savedCustomEvent;
  }
});

// ── Single notification trigger (C1058) — handleAttentionMessage is now the only place an
// attention-needed WS event turns into an OS notification for either transport. ──

test('attention-needed fires exactly one notification while the app is backgrounded, with body = promptText', () => {
  handleAttentionMessage({ type: 'attention-needed', taskId: 'C1', kind: 'toolApproval', promptText: 'Allow ls?', agent: 'codex' });
  assert.equal(constructorCount, 1);
  assert.equal(lastNotification.options.body, 'Allow ls?');
  // (C1138) Web Notification tag is now suffixed per-call so a later banner for the same task
  // doesn't replace this one on screen — see notifications.js.
  assert.match(lastNotification.options.tag, /^C1-\d+$/);
});

test('an immediately repeated identical message (simulated WS-reconnect replay) does not double-notify', () => {
  const msg = { type: 'attention-needed', taskId: 'C1', kind: 'toolApproval', promptText: 'Allow ls?', agent: 'codex' };
  handleAttentionMessage(msg);
  handleAttentionMessage({ ...msg });
  assert.equal(constructorCount, 1);
});

test('a changed promptText re-notifies (regression test for the old class-transition-only gate)', () => {
  handleAttentionMessage({ type: 'attention-needed', taskId: 'C1', kind: 'attention', promptText: 'First question?', agent: 'claude' });
  handleAttentionMessage({ type: 'attention-needed', taskId: 'C1', kind: 'attention', promptText: 'Second question?', agent: 'claude' });
  assert.equal(constructorCount, 2);
  assert.equal(lastNotification.options.body, 'Second question?');
});

// (C1060) Rewritten from the pre-C1060 "notifies a second time" expectation — this is now
// exactly the reported bug's regression test: a raise/clear/raise flap on an IDENTICAL prompt
// (the false-positive OSC/BEL-driven flicker terminal-session.js's stripOscChunk() fixes) must
// not be able to storm the user with a fresh notification on every cycle. A genuinely different
// question still re-notifies immediately regardless — see the "changed promptText" tests above.
test('attention-cleared then the identical prompt again does not double-notify inside the debounce window', () => {
  handleAttentionMessage({ type: 'attention-needed', taskId: 'C1', kind: 'attention', promptText: 'x', agent: 'claude' });
  assert.equal(constructorCount, 1);
  handleAttentionMessage({ type: 'attention-cleared', taskId: 'C1' });
  handleAttentionMessage({ type: 'attention-needed', taskId: 'C1', kind: 'attention', promptText: 'x', agent: 'claude' });
  assert.equal(constructorCount, 1);
});

test('updateClaudeButtons (the repaint) runs before the notification is sent', () => {
  const order = [];
  const savedUpdate = globalThis.window.TipTask.taskBoard.updateClaudeButtons;
  const savedNotification = globalThis.Notification;
  globalThis.window.TipTask.taskBoard.updateClaudeButtons = () => order.push('paint');
  globalThis.Notification = class {
    constructor() { order.push('notify'); }
    set onclick(_h) {}
    static get permission() { return 'granted'; }
    static requestPermission() { return Promise.resolve('granted'); }
  };
  try {
    handleAttentionMessage({ type: 'attention-needed', taskId: 'C1', kind: 'attention', promptText: 'x', agent: 'claude' });
    assert.deepEqual(order, ['paint', 'notify']);
  } finally {
    globalThis.window.TipTask.taskBoard.updateClaudeButtons = savedUpdate;
    globalThis.Notification = savedNotification;
  }
});

test('handleAttentionMessage does not throw when window.TipTask.taskBoard is missing', () => {
  const saved = globalThis.window.TipTask.taskBoard;
  delete globalThis.window.TipTask.taskBoard;
  try {
    assert.doesNotThrow(() => {
      handleAttentionMessage({ type: 'attention-needed', taskId: 'C1', kind: 'attention', promptText: 'x', agent: 'claude' });
    });
  } finally {
    globalThis.window.TipTask.taskBoard = saved;
  }
});

// ── handleTaskActivityMessage (TPT12) — a sibling frame handler, not folded into handleAttentionMessage ──

function activityMsg(entries) {
  const activity = {};
  for (const [taskId, ids] of Object.entries(entries)) {
    activity[taskId] = { count: ids.length, ids, latest: { id: ids[ids.length - 1], title: 't', body: 'someone changed it', event_type: 'comment', actor: { id: 2 }, created_at: 'x' } };
  }
  return { type: 'task-activity', activity };
}

test('handleTaskActivityMessage is not claimed by handleAttentionMessage, and is handled by its own function', () => {
  assert.equal(handleAttentionMessage(activityMsg({ TPT1: [1] })), false);
  assert.equal(handleTaskActivityMessage(activityMsg({ TPT1: [1] })), true);
});

test('handleTaskActivityMessage never touches attentionSessions/attentionDetails', () => {
  handleTaskActivityMessage(activityMsg({ TPT1: [1] }));
  assert.equal(state.attentionSessions.size, 0);
  assert.equal(state.attentionDetails.size, 0);
});

test('handleTaskActivityMessage fires a push for a genuinely new rise, silent on the first-ever application', () => {
  assert.equal(handleTaskActivityMessage(activityMsg({ TPT1: [1] })), true);
  assert.equal(lastNotification, null, 'first application is a baseline, never a push');

  const sentSecond = handleTaskActivityMessage(activityMsg({ TPT1: [1, 2] }));
  assert.equal(sentSecond, true);
  assert.ok(lastNotification, 'a genuinely new id after the baseline pushes');
});

test('handleTaskActivityMessage: identical frame dispatched twice (browser mode\'s two simultaneous WS ladders) pushes once', () => {
  handleTaskActivityMessage(activityMsg({ TPT1: [1] })); // baseline
  const msg = activityMsg({ TPT1: [1, 2] });
  handleTaskActivityMessage(msg);
  lastNotification = null;
  handleTaskActivityMessage(msg); // identical frame, dispatched again
  assert.equal(lastNotification, null, 'idempotent — second dispatch of the same frame must not re-push');
});

test('handleTaskActivityMessage returns false for an unrelated frame type', () => {
  assert.equal(handleTaskActivityMessage({ type: 'tasks-updated' }), false);
  assert.equal(handleTaskActivityMessage(null), false);
});
