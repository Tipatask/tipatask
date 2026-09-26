import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let mockPermission = 'granted';
let lastNotification = null;
let hasFocus = true;
let visibilityState = 'visible';
let activeElement = null;
let appNode = null;
let modalNode = null;

class MockDocument extends EventTarget {
  get visibilityState() { return visibilityState; }
  get activeElement() { return activeElement; }
  hasFocus() { return hasFocus; }
  getElementById(id) {
    if (id === 'app') return appNode;
    if (id === 'task-edit-modal') return modalNode;
    return null;
  }
}

globalThis.Notification = class MockNotification {
  constructor(title, options) { lastNotification = { title, options }; }
  // Stash the assigned handler onto the same object the test reads back via `lastNotification`
  // (a plain closure captured by notify()'s web-transport branch — not something else exposed
  // any other way) so C1137's "click still opens the raw title" test can trigger it.
  set onclick(handler) { this._onclick = handler; lastNotification.onclick = handler; }
  static get permission() { return mockPermission; }
  static requestPermission() { return Promise.resolve('granted'); }
};

globalThis.CSS = { escape: (value) => String(value) };
globalThis.document = new MockDocument();
globalThis.window = {
  focus() {},
  electronAPI: { focusSelf() {} },
  TipTask: { openTerminal() {} },
};

const stateModule = await import('./state.js');
const state = stateModule.default;
const { clearDebounce } = await import('./notifications.js');
const {
  isTaskInUserFocus,
  notifyTaskNeedsAttention,
  buildAttentionBody,
  buildNotificationTitle,
  forgetTaskAttention,
} = await import('./attention-notifications.js');
const { getNotificationEntries, clearAllNotifications } = await import('./notification-center.js');
const { raiseAttention, clearAttention, _resetAttentionState } = await import('./attention-state.js');

function makeCard({ title = 'Task Title', status = 'in_progress', containsActive = false, hover = false } = {}) {
  return {
    dataset: { status },
    querySelector(selector) {
      if (selector === '.card-title-inner') return { textContent: title };
      return null;
    },
    contains(node) { return containsActive && node === activeElement; },
    matches(selector) { return selector === ':hover' && hover; },
  };
}

beforeEach(() => {
  mockPermission = 'granted';
  lastNotification = null;
  hasFocus = true;
  visibilityState = 'visible';
  activeElement = null;
  state.activeTerminal = null;
  state.selectedCardId = null;
  state.attentionSessions = new Set();
  state.attentionDetails = new Map();
  _resetAttentionState();
  state.taskTitleById = new Map();
  state.projectName = ''; // (C1137) default: no project-name prefix
  appNode = { querySelector: () => makeCard() };
  modalNode = { hidden: true, dataset: {} };
  clearAllNotifications();
  // notifications.js's 30s per-tag debounce is module-singleton state, shared across every
  // test in this file — every test below notifies tag 'C1', so without this a later test's
  // notify() silently no-ops against an earlier test's still-armed debounce. Same story for
  // attention-notifications.js's own "already told the user" ledger (C1058).
  clearDebounce('C1');
  forgetTaskAttention('C1');
});

test('isTaskInUserFocus is true for focused active terminal task', () => {
  state.activeTerminal = { taskId: 'C1' };
  assert.equal(isTaskInUserFocus('C1'), true);
});

test('isTaskInUserFocus is false when window is hidden', () => {
  state.activeTerminal = { taskId: 'C1' };
  visibilityState = 'hidden';
  assert.equal(isTaskInUserFocus('C1'), false);
});

test('notifyTaskNeedsAttention sends notification when task is outside focus', () => {
  hasFocus = false;
  const sent = notifyTaskNeedsAttention('C1');
  assert.equal(sent, true);
  // (C1137) Title is now "taskId: title" (no project configured), not the bare task title —
  // see the buildNotificationTitle tests below for the full format matrix. `onclick` (added to
  // `lastNotification` by the MockNotification setter) is excluded here — checked separately in
  // the RAW-title click test below.
  assert.equal(lastNotification.title, 'C1: Task Title');
  // (C1138) tag is suffixed to a per-call-unique value on the Web Notification path so a later
  // banner for the same task doesn't silently replace this one on screen — see notifications.js.
  assert.equal(lastNotification.options.body, 'Needs your attention');
  assert.match(lastNotification.options.tag, /^C1-\d+$/);
  assert.equal(lastNotification.options.requireInteraction, true);
});

test('notifyTaskNeedsAttention skips focused selected card', () => {
  state.selectedCardId = 'C1';
  const sent = notifyTaskNeedsAttention('C1');
  assert.equal(sent, false);
  assert.equal(lastNotification, null);
});

test('notifyTaskNeedsAttention skips open task edit modal for same task', () => {
  modalNode = { hidden: false, dataset: { taskId: 'C1' } };
  const sent = notifyTaskNeedsAttention('C1');
  assert.equal(sent, false);
  assert.equal(lastNotification, null);
});

// ── buildAttentionBody / detail plumbing (C1057) ──

test('buildAttentionBody prefers promptText when present, regardless of kind', () => {
  assert.equal(buildAttentionBody({ kind: 'toolApproval', promptText: 'Allow `ls` to run?' }), 'Allow `ls` to run?');
});

test('buildAttentionBody falls back to a per-kind message when promptText is absent', () => {
  assert.equal(buildAttentionBody({ kind: 'toolApproval' }), 'Waiting for tool approval');
  assert.equal(buildAttentionBody({ kind: 'mcpTrust' }), 'Waiting for MCP server approval');
  assert.equal(buildAttentionBody({ kind: 'planReady' }), 'Plan is ready for review');
  assert.equal(buildAttentionBody({ kind: 'idle' }), 'Quiet for a while — may need input');
});

test('buildAttentionBody maps a runaway detail to the killed message only when killed is set (TPT357)', () => {
  assert.equal(buildAttentionBody({ kind: 'runaway' }), 'Possible runaway process — review the terminal');
  assert.equal(buildAttentionBody({ kind: 'runaway', killed: true }), 'Runaway process tree was killed — review the terminal');
  assert.equal(buildAttentionBody({ kind: 'runaway', killed: true, promptText: 'server text' }), 'server text');
});

test('buildAttentionBody defaults to the generic message for an unknown/missing kind', () => {
  assert.equal(buildAttentionBody(undefined), 'Needs your attention');
  assert.equal(buildAttentionBody(null), 'Needs your attention');
  assert.equal(buildAttentionBody({}), 'Needs your attention');
});

test('notifyTaskNeedsAttention reads its detail from state.attentionDetails by default', () => {
  hasFocus = false;
  state.attentionDetails.set('C1', { kind: 'toolApproval', promptText: 'Allow `npm test` to run?' });
  const sent = notifyTaskNeedsAttention('C1');
  assert.equal(sent, true);
  assert.equal(lastNotification.options.body, 'Allow `npm test` to run?');
});

test('notifyTaskNeedsAttention still uses the plain default body when no detail exists (pre-C1057 behavior preserved)', () => {
  hasFocus = false;
  const sent = notifyTaskNeedsAttention('C1');
  assert.equal(sent, true);
  assert.equal(lastNotification.options.body, 'Needs your attention');
});

// ── Title fallback when no card is rendered (C1058) ──

test('notifyTaskNeedsAttention falls back to state.taskTitleById when no card is rendered for the task', () => {
  hasFocus = false;
  appNode = { querySelector: () => null };
  state.taskTitleById.set('C1', 'Fallback Title');
  const sent = notifyTaskNeedsAttention('C1');
  assert.equal(sent, true);
  assert.equal(lastNotification.title, 'C1: Fallback Title');
});

test('notifyTaskNeedsAttention falls back to the raw taskId (as both key and title) when neither a card nor a title map entry exists', () => {
  hasFocus = false;
  appNode = { querySelector: () => null };
  const sent = notifyTaskNeedsAttention('C1');
  assert.equal(sent, true);
  assert.equal(lastNotification.title, 'C1: C1');
});

// ── Notification title format (C1137) ──

test('buildNotificationTitle omits the project prefix when state.projectName is empty', () => {
  state.projectName = '';
  assert.equal(buildNotificationTitle('C42', 'Fix the thing'), 'C42: Fix the thing');
});

test('buildNotificationTitle prepends the project name when set', () => {
  state.projectName = 'Tipatask';
  assert.equal(buildNotificationTitle('C42', 'Fix the thing'), 'Tipatask · C42: Fix the thing');
});

test('notifyTaskNeedsAttention prefixes the OS banner title with the project name when configured', () => {
  hasFocus = false;
  state.projectName = 'Tipatask';
  const sent = notifyTaskNeedsAttention('C1');
  assert.equal(sent, true);
  assert.equal(lastNotification.title, 'Tipatask · C1: Task Title');
});

test('a click still opens the terminal with the RAW task title, not the project/taskId-prefixed banner title', () => {
  hasFocus = false;
  state.projectName = 'Tipatask';
  let openedWith = null;
  const originalTipTask = window.TipTask;
  window.TipTask = { openTerminal: (...args) => { openedWith = args; } };
  try {
    notifyTaskNeedsAttention('C1');
    lastNotification.onclick(); // the Web Notification path's n.onclick, which invokes options.onClick
    assert.deepEqual(openedWith, ['C1', 'Task Title', '', 'in_progress']);
  } finally {
    window.TipTask = originalTipTask;
  }
});

test('the in-app notification-center card carries the same prefixed title as the OS banner', () => {
  hasFocus = false;
  state.projectName = 'Tipatask';
  notifyTaskNeedsAttention('C1');
  const entries = getNotificationEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tag, 'C1');
  assert.equal(entries[0].title, 'Tipatask · C1: Task Title');
});

// ── "Already told the user" ledger — replay/duplicate suppression (C1058) ──

test('notifyTaskNeedsAttention suppresses a repeat call carrying the identical prompt signature', () => {
  hasFocus = false;
  const detail = { kind: 'toolApproval', promptText: 'Allow `ls`?' };
  assert.equal(notifyTaskNeedsAttention('C1', detail), true);
  lastNotification = null;
  assert.equal(notifyTaskNeedsAttention('C1', detail), false);
  assert.equal(lastNotification, null);
});

// (C1060) forgetTaskAttention() no longer calls clearDebounce() — belt-and-braces flap
// damping. Clearing the "already told" ledger alone is not enough to re-arm a notification;
// notify()'s own 30s per-tag debounce (notifications.js, module-singleton) stays in place
// across a forgetTaskAttention() call, so a raise/clear flap (attention-cleared firing
// forgetTaskAttention on every cycle) can never produce more than one OS notification per 30s
// per task, no matter how many times the ledger gets cleared in between.
test('forgetTaskAttention clears the ledger but leaves the notify() debounce floor in place', () => {
  hasFocus = false;
  const detail = { kind: 'toolApproval', promptText: 'Allow `ls`?' };
  assert.equal(notifyTaskNeedsAttention('C1', detail), true);
  assert.equal(notifyTaskNeedsAttention('C1', detail), false); // still suppressed by the ledger
  forgetTaskAttention('C1');
  // Ledger is cleared, but the 30s debounce (armed by the first send above) is not — still
  // suppressed, this time by notify() itself rather than the ledger.
  assert.equal(notifyTaskNeedsAttention('C1', detail), false);
});

test('an identical prompt notifies again once the notify() debounce window itself elapses, after forgetTaskAttention', (t) => {
  // `now` pinned well past epoch 0 — notifications.js's debounce falls back to a "last sent" of
  // 0 for a never-notified tag, so a mocked clock starting at 0 would make that fallback look
  // like "just sent" and spuriously debounce the very first send below.
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  try {
    hasFocus = false;
    const detail = { kind: 'toolApproval', promptText: 'Allow `ls`?' };
    assert.equal(notifyTaskNeedsAttention('C1', detail), true);
    forgetTaskAttention('C1');
    t.mock.timers.tick(30001); // past notifications.js's DEBOUNCE_MS
    assert.equal(notifyTaskNeedsAttention('C1', detail), true); // re-armed once the debounce itself has elapsed
  } finally {
    t.mock.timers.reset();
  }
});

// (C1125) notify() hands off to the Electron IPC transport and returns `true` optimistically,
// before the send has actually resolved — notifyTaskNeedsAttention() records the ledger entry
// on that optimistic `true`. If the OS then silently drops the banner (e.g. main.js's
// notify:show reporting {ok:false,reason:'unsigned'} for an unsigned bundle), the ledger must
// not keep believing the user was told, or this task goes permanently silent.
test('a failed Electron send does not leave the ledger thinking the user was told', async () => {
  hasFocus = false;
  let resolveSend;
  const originalElectronAPI = globalThis.window.electronAPI;
  globalThis.window.electronAPI = {
    ...originalElectronAPI,
    notify: () => new Promise((resolve) => { resolveSend = resolve; }),
    onNotificationClick: () => {},
  };
  try {
    const detail = { kind: 'toolApproval', promptText: 'Allow `ls`?' };
    assert.equal(notifyTaskNeedsAttention('C1', detail), true); // optimistic: handed to the transport
    assert.equal(notifyTaskNeedsAttention('C1', detail), false); // ledger suppresses before the IPC resolves
    resolveSend({ ok: false, reason: 'unsigned' });
    await new Promise((r) => setTimeout(r, 0)); // let notify()'s .then() chain settle
    // The failed send un-recorded the ledger entry (and re-armed the debounce) — the identical
    // prompt notifies again instead of staying silenced.
    assert.equal(notifyTaskNeedsAttention('C1', detail), true);
  } finally {
    globalThis.window.electronAPI = originalElectronAPI;
  }
});

test('being in focus also records the ledger, so a later replay of the same prompt stays silent after the user looks away', () => {
  state.selectedCardId = 'C1'; // the specific signal isTaskInUserFocus checks — not just window focus
  const detail = { kind: 'toolApproval', promptText: 'Allow `ls`?' };
  assert.equal(notifyTaskNeedsAttention('C1', detail), false); // suppressed: in focus
  assert.equal(lastNotification, null);
  state.selectedCardId = null;
  hasFocus = false; // now unfocused, but it's a replay of the same already-seen prompt
  assert.equal(notifyTaskNeedsAttention('C1', detail), false);
  assert.equal(lastNotification, null);
});

// (C1387 task item 3) The left-nav active-tasks indicator (task-board.js#syncActiveSessionsNav)
// reads state.attentionSessions directly (`needsAttention: state.attentionSessions.has(id)`) —
// there is no separately-computed value here that could desync from the board card's ring. This
// file's isTaskInUserFocus()/buildNotificationTitle() feed only the OS/in-app notification
// surfaces, never the nav row; pin that they neither read nor mutate the attention Set/Map.
test('isTaskInUserFocus does not read or mutate state.attentionSessions/attentionDetails', () => {
  raiseAttention('C1', { kind: 'attention', promptText: 'x' });
  const before = { sessions: new Set(state.attentionSessions), details: new Map(state.attentionDetails) };

  state.activeTerminal = { taskId: 'C1' };
  isTaskInUserFocus('C1');
  state.activeTerminal = null;

  state.selectedCardId = 'C1';
  isTaskInUserFocus('C1');
  state.selectedCardId = null;

  activeElement = {};
  appNode = { querySelector: () => makeCard({ containsActive: true }) };
  isTaskInUserFocus('C1');
  activeElement = null;

  modalNode = { hidden: false, dataset: { taskId: 'C1' } };
  isTaskInUserFocus('C1');

  assert.deepEqual(state.attentionSessions, before.sessions);
  assert.deepEqual(state.attentionDetails, before.details);
});

test('buildNotificationTitle is independent of attention state', () => {
  raiseAttention('C1', { kind: 'attention', promptText: 'x' });
  raiseAttention('C2', { kind: 'toolApproval', promptText: 'y' });
  assert.equal(buildNotificationTitle('C1', 'Task Title'), 'C1: Task Title');
  clearAttention('C1', 'opened');
  assert.equal(buildNotificationTitle('C1', 'Task Title'), 'C1: Task Title');
});
