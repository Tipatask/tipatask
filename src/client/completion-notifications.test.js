import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// (C1355) Same hand-mocked harness as attention-notifications.test.js — no jsdom, globals
// stubbed before the dynamic import()s below.

let mockPermission = 'granted';
let lastNotification = null;
let sentNotifications = [];
let hasFocus = true;
let visibilityState = 'visible';
let activeElement = null;
let appNode = null;
let modalNode = null;
let projectPath = '/project/A';
let focusSelfCount = 0;
let openedTasks = [];
let terminalStarts = 0;
let terminalOpens = [];

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
  constructor(title, options) {
    this.record = lastNotification = { title, options };
    sentNotifications.push(lastNotification);
  }
  set onclick(handler) { this._onclick = handler; this.record.onclick = handler; }
  close() { this.record.closed = true; }
  static get permission() { return mockPermission; }
  static requestPermission() { return Promise.resolve('granted'); }
};

globalThis.CSS = { escape: (value) => String(value) };
globalThis.document = new MockDocument();
globalThis.window = {
  focus() {},
  electronAPI: { focusSelf() { focusSelfCount++; }, getProjectPath: () => projectPath },
  TipTask: {
    openTaskEditModal(id) { openedTasks.push(id); },
    openTerminal() { terminalStarts++; },
  },
};

const stateModule = await import('./state.js');
const state = stateModule.default;
const { clearDebounce } = await import('./notifications.js');
const { seedStatuses, resetStatuses } = await import('./status-registry.js');
const {
  notifyTaskCompleted,
  forgetTaskCompletion,
  maybeNotifyCompletion,
  observeTaskStatusForCompletion,
} = await import('./completion-notifications.js');
const { getNotificationEntries, clearAllNotifications } = await import('./notification-center.js');

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
  sentNotifications = [];
  hasFocus = true;
  visibilityState = 'visible';
  activeElement = null;
  state.activeTerminal = null;
  state.selectedCardId = null;
  state.taskTitleById = new Map();
  state.activeSessions = new Set();
  state.exitedSessions = new Set();
  state.taskStatusById = new Map();
  state.projectName = '';
  appNode = { querySelector: () => makeCard() };
  modalNode = { hidden: true, dataset: {} };
  projectPath = '/project/A';
  focusSelfCount = 0;
  openedTasks = [];
  terminalStarts = 0;
  window.electronAPI = { focusSelf() { focusSelfCount++; }, getProjectPath: () => projectPath };
  window.TipTask = {
    openTaskEditModal(id) { openedTasks.push(id); },
    openTerminal(...args) { terminalStarts++; terminalOpens.push(args); },
  };
  terminalOpens = [];
  clearAllNotifications();
  resetStatuses();
  // notifications.js's 30s per-tag debounce is module-singleton state, shared across every test
  // in this file — every test below completes tag 'completed-C1', so without this a later
  // test's notify() silently no-ops against an earlier test's still-armed debounce.
  clearDebounce('completed-C1');
  forgetTaskCompletion('C1');
});

test('notifyTaskCompleted sends a notification when the task is outside focus', () => {
  hasFocus = false;
  const sent = notifyTaskCompleted('C1', { title: 'Ship the thing' });
  assert.equal(sent, true);
  assert.equal(lastNotification.title, 'C1: Ship the thing');
  assert.equal(lastNotification.options.body, 'Task completed');
  // (C1355) tag is `completed-<taskId>`, distinct from the attention path's bare taskId tag —
  // the Web transport further suffixes it per-call (C1138), hence the trailing -\d+.
  assert.match(lastNotification.options.tag, /^completed-C1-\d+$/);
});

test('notifyTaskCompleted is suppressed while the task is in user focus, and the ledger still records it', () => {
  state.selectedCardId = 'C1';
  const sent = notifyTaskCompleted('C1', { title: 'Ship the thing' });
  assert.equal(sent, false);
  assert.equal(lastNotification, null);
  // Recorded as "told" even though suppressed by focus — a later replay while unfocused stays
  // silent, same rule as attention-notifications.js.
  state.selectedCardId = null;
  hasFocus = false;
  assert.equal(notifyTaskCompleted('C1', { title: 'Ship the thing' }), false);
  assert.equal(lastNotification, null);
});

test('notifyTaskCompleted suppresses a repeat call for the same task (already-notified ledger)', () => {
  hasFocus = false;
  assert.equal(notifyTaskCompleted('C1', { title: 'Ship the thing' }), true);
  lastNotification = null;
  assert.equal(notifyTaskCompleted('C1', { title: 'Ship the thing' }), false);
  assert.equal(lastNotification, null);
});

test('forgetTaskCompletion clears the ledger so a later completion notifies again', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  try {
    hasFocus = false;
    assert.equal(notifyTaskCompleted('C1', { title: 'Ship the thing' }), true);
    forgetTaskCompletion('C1');
    t.mock.timers.tick(30001); // past notifications.js's DEBOUNCE_MS, same tag would otherwise still be armed
    assert.equal(notifyTaskCompleted('C1', { title: 'Ship the thing' }), true);
  } finally {
    t.mock.timers.reset();
  }
});

test('the in-app notification-center card is pushed under the "completed" category', () => {
  hasFocus = false;
  notifyTaskCompleted('C1', { title: 'Ship the thing' });
  const entries = getNotificationEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tag, 'completed-C1');
  assert.equal(entries[0].category, 'completed');
});

test('in-app completion click recovers an off-screen exited session and opens its terminal once', async () => {
  hasFocus = false;
  appNode = { querySelector: () => null }; // task is filtered out of the board window
  window.TipTask.fetchActiveSessions = async () => {
    state.exitedSessions.add('C1');
    state.sessionMeta.set('C1', { startedAt: 1234 });
  };
  notifyTaskCompleted('C1', { title: 'Off-screen task' });
  const [entry] = getNotificationEntries();
  assert.equal(typeof entry.onClick, 'function');
  entry.onClick();
  entry.onClick(); // same click reaching two surfaces while navigation is in flight
  await new Promise(setImmediate);
  assert.deepEqual(openedTasks, []);
  assert.equal(terminalStarts, 1);
  assert.deepEqual(terminalOpens[0][4], { reconnectOnly: true, sessionStartedAt: 1234 });
  assert.equal(getNotificationEntries().length, 0);
});

test('completion click with no retained session never opens Edit or starts an agent', async () => {
  hasFocus = false;
  notifyTaskCompleted('C1', { title: 'Done task' });
  getNotificationEntries()[0].onClick();
  await new Promise(setImmediate);
  assert.deepEqual(openedTasks, []);
  assert.equal(terminalStarts, 0);
});

test('completion click refuses a newer run for the same task', async () => {
  hasFocus = false;
  state.sessionMeta.set('C1', { startedAt: 1234 });
  notifyTaskCompleted('C1', { title: 'Old run' });
  window.TipTask.fetchActiveSessions = async () => {
    state.activeSessions.add('C1');
    state.sessionMeta.set('C1', { startedAt: 5678 });
  };
  getNotificationEntries()[0].onClick();
  await new Promise(setImmediate);
  assert.deepEqual(openedTasks, []);
  assert.equal(terminalStarts, 0);
});

test('in-app completion click with a finished session opens the console, not the edit modal', async () => {
  hasFocus = false;
  state.exitedSessions.add('C1');
  state.taskStatusById.set('C1', 'completed');
  notifyTaskCompleted('C1', { title: 'Done task' });
  getNotificationEntries()[0].onClick();
  await new Promise(setImmediate);
  assert.deepEqual(openedTasks, []);
  assert.equal(terminalStarts, 1);
  assert.deepEqual(terminalOpens[0].slice(0, 4), ['C1', 'Task Title', '', 'in_progress']);
  assert.equal(getNotificationEntries().length, 0);
});

test('completion action rejects a stale project card with the same-looking task key', async () => {
  hasFocus = false;
  notifyTaskCompleted('C1', { title: 'Project A task' });
  const actionA = getNotificationEntries()[0].onClick;
  projectPath = '/project/B';
  actionA();
  await new Promise(setImmediate);
  assert.deepEqual(openedTasks, []);
  assert.equal(getNotificationEntries().length, 0);

  forgetTaskCompletion('C1');
  clearDebounce('completed-C1');
  notifyTaskCompleted('C1', { title: 'Project B task' });
  getNotificationEntries()[0].onClick();
  await new Promise(setImmediate);
  assert.deepEqual(openedTasks, []);
  assert.equal(terminalStarts, 0);
});

test('native completion click (finished session) uses the existing project-scoped bridge and shared action', async () => {
  hasFocus = false;
  let nativeClick;
  const nativeSends = [];
  window.electronAPI = {
    focusSelf() { focusSelfCount++; },
    getProjectPath: () => projectPath,
    notify(payload) { nativeSends.push(payload); return Promise.resolve({ ok: true }); },
    onNotificationClick(cb) { nativeClick = cb; },
  };
  state.exitedSessions.add('C1');
  notifyTaskCompleted('C1', { title: 'Finished task' });
  assert.equal(nativeSends.length, 1);
  assert.equal(nativeSends[0].tag, 'completed-C1');
  assert.equal(typeof nativeClick, 'function');
  nativeClick({ tag: 'completed-C1', projectPath: '/project/B' });
  await new Promise(setImmediate);
  assert.equal(terminalStarts, 0);
  nativeClick({ tag: 'completed-C1', projectPath: '/project/A' });
  await new Promise(setImmediate);
  assert.deepEqual(openedTasks, []);
  assert.equal(terminalStarts, 1);
  assert.equal(terminalOpens[0][0], 'C1');
  assert.equal(getNotificationEntries().length, 0);
});

test('web notification fallback click opens the console and keeps browser focus behavior', async () => {
  hasFocus = false;
  let browserFocusCount = 0;
  window.focus = () => { browserFocusCount++; };
  window.electronAPI = undefined;
  state.activeSessions.add('C1');
  notifyTaskCompleted('C1', { title: 'Browser task' });
  assert.equal(typeof lastNotification.onclick, 'function');
  lastNotification.onclick();
  await new Promise(setImmediate);
  assert.equal(browserFocusCount, 1);
  assert.deepEqual(openedTasks, []);
  assert.equal(terminalStarts, 1);
  assert.equal(terminalOpens[0][0], 'C1');
});

// ── maybeNotifyCompletion — the transition helper the WS wiring points actually call ──

test('maybeNotifyCompletion fires only on a genuine transition into the complete role', () => {
  hasFocus = false;
  assert.equal(maybeNotifyCompletion('C1', 'in_progress', 'completed', 'Ship the thing'), true);
  assert.equal(lastNotification.title, 'C1: Ship the thing');
});

test('maybeNotifyCompletion does not fire when the task was already complete (no transition)', () => {
  hasFocus = false;
  assert.equal(maybeNotifyCompletion('C1', 'completed', 'completed', 'Ship the thing'), false);
  assert.equal(lastNotification, null);
});

test('first observation of an already-complete task never reaches either notification transport', () => {
  hasFocus = false;
  for (const previous of [undefined, null, '']) {
    assert.equal(maybeNotifyCompletion('C1', previous, 'completed', 'Ship the thing'), false);
  }
  assert.equal(sentNotifications.length, 0);
  assert.equal(getNotificationEntries().length, 0);
});

test('all three status observers share the transition guard and retain a silent baseline', () => {
  hasFocus = false;
  const statusById = new Map([['C1', 'completed']]); // initial snapshot, no notification
  const observe = (taskId, status) =>
    observeTaskStatusForCompletion(statusById, taskId, status, 'Ship the thing');

  // Pagination discovers a complete task; reconnect and a second newly discovered task are
  // also observations, not transitions. The browser, Electron, and poll paths each use this
  // same observer (wiring asserted below).
  assert.equal(observe('C1', 'completed'), 'completed');
  assert.equal(observe('C2', 'completed'), undefined);
  assert.equal(observe('C2', 'completed'), 'completed');
  assert.equal(observe('C3', 'completed'), undefined);
  assert.equal(sentNotifications.length, 0);
  assert.equal(getNotificationEntries().length, 0);

  assert.equal(observe('C4', 'pending'), undefined);
  assert.equal(observe('C4', 'completed'), 'pending');
  assert.equal(sentNotifications.length, 1);
  assert.equal(getNotificationEntries().length, 1);
  assert.equal(getNotificationEntries()[0].tag, 'completed-C4');

  // Duplicate events from the other paths do not raise a second OS banner or in-app card.
  assert.equal(observe('C4', 'completed'), 'completed');
  assert.equal(observe('C4', 'completed'), 'completed');
  assert.equal(sentNotifications.length, 1);
  assert.equal(getNotificationEntries().length, 1);

  assert.equal(observe('C4', 'in_progress'), 'completed');
  clearAllNotifications();
  clearDebounce('completed-C4');
  assert.equal(observe('C4', 'completed'), 'in_progress');
  assert.equal(sentNotifications.length, 2);
  assert.equal(getNotificationEntries().length, 1);
  assert.equal(getNotificationEntries()[0].tag, 'completed-C4');
  forgetTaskCompletion('C4');
  clearDebounce('completed-C4');
});

test('browser WS, Electron event, and status poll all call the shared observer', () => {
  const source = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  const call = 'completionNotifications.observeTaskStatusForCompletion(';
  assert.equal(source.split(call).length - 1, 3);
  assert.match(source, /function syncNavStatusesFromServer[\s\S]*?observeTaskStatusForCompletion\(state\.taskStatusById, id, t\.status, t\.title\)/);
  assert.match(source, /function handleObjectiveTaskStateEvent[\s\S]*?observeTaskStatusForCompletion\(\s*state\.taskStatusById, taskId, msg\.task\.status, msg\.task\.title\)/);
  assert.match(source, /function connectBoardWs[\s\S]*?observeTaskStatusForCompletion\(\s*state\.taskStatusById, t\.id, t\.status, t\.title\)/);
});

test('maybeNotifyCompletion does not fire for a non-complete status, and clears the ledger on the way out', () => {
  hasFocus = false;
  assert.equal(maybeNotifyCompletion('C1', 'pending', 'in_progress', 'Ship the thing'), false);
  assert.equal(lastNotification, null);
});

test('a task that leaves the complete role and completes again notifies a second time', () => {
  hasFocus = false;
  assert.equal(maybeNotifyCompletion('C1', 'in_progress', 'completed', 'Ship the thing'), true);
  lastNotification = null;
  // Reopened — leaves the complete role, clearing the ledger.
  assert.equal(maybeNotifyCompletion('C1', 'completed', 'in_progress', 'Ship the thing'), false);
  clearDebounce('completed-C1'); // re-arm notify()'s own debounce too, same as the forgetTaskAttention test pattern
  assert.equal(maybeNotifyCompletion('C1', 'in_progress', 'completed', 'Ship the thing'), true);
  assert.equal(lastNotification.title, 'C1: Ship the thing');
});

// ── Custom per-project status roles (C1184/C1187) — never a hardcoded 'completed' string ──

test('resolves the complete role through the project\'s own status registry, not a hardcoded name', () => {
  hasFocus = false;
  seedStatuses([
    { name: 'todo', color: 'overlay1', display_order: 0, is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'doing', color: 'blue', display_order: 1, is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'done', color: 'green', display_order: 2, is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false },
  ]);
  try {
    // First sight of a task already in this project's renamed complete role is silent.
    assert.equal(maybeNotifyCompletion('C1', undefined, 'done', 'Ship the thing'), false);
    assert.equal(sentNotifications.length, 0);
    assert.equal(getNotificationEntries().length, 0);
    // The legacy name 'completed' is no longer this project's complete role — must NOT fire.
    assert.equal(maybeNotifyCompletion('C1', 'doing', 'completed', 'Ship the thing'), false);
    assert.equal(lastNotification, null);
    // The project's real complete role, 'done', must fire.
    assert.equal(maybeNotifyCompletion('C1', 'doing', 'done', 'Ship the thing'), true);
    assert.equal(lastNotification.title, 'C1: Ship the thing');
  } finally {
    resetStatuses();
  }
});
