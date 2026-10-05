import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildObjectivePrompt, escapeAttr, BLANK_SUBTASK_BRIEF } from './utils.js';

const source = readFileSync(new URL('./chat-ui.js', import.meta.url), 'utf8');
const read = name => readFileSync(new URL('./' + name, import.meta.url), 'utf8');
function loadFunction(env, name, text = source) {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  const end = text.indexOf('\n}', start) + 2;
  const asyncPrefix = text.slice(start - 6, start) === 'async ' ? 'async ' : '';
  vm.runInContext(asyncPrefix + text.slice(start, end), env);
}
function chat() {
  let now = 1700000000000;
  const drafts = new Map();
  const storage = new Map();
  const sockets = [];
  const tab = { tabId: 'obj-new-1', chatState: null, viewState: { composer: { value: 'stale draft' } } };
  const state = { tabsState: [tab], activeTabId: tab.tabId, chatState: null, subtaskStack: [], chatPersistEpoch: 0 };
  const env = {
    // Separate UI actions must not share a millisecond-derived tab/session id.
    Date: class extends Date { static now() { return now++; } },
    state, MAX_TABS: 5, DRAFT_KEY_OBJECTIVE: 'draft', ACTIVE_NEW_TAB_KEY: 'active', CHAT_STATE_KEY: 'chat',
    _pendingComposerSeed: null, _saveChatTimer: null, discussTaskCache: new Map(),
    _pendingComposerRestore: null, captureFocusedComposerForRerender: () => null,
    getObjectiveDraftKey: () => 'draft-' + state.activeTabId,
    loadDraft: key => drafts.get(key), saveDraft: (key, value) => drafts.set(key, value), clearDraft: key => drafts.delete(key),
    isPristineObjectiveTab: t => !t.chatState,
    getActiveTab: () => state.tabsState.find(t => t.tabId === state.activeTabId),
    syncActiveChatState() {}, dismissObjectiveNotification() {}, reload() {}, saveChatDraft() {},
    syncChatHistoryMeta() {}, syncObjectiveChatLayout() {}, clearObjectiveReadyMemory() {}, syncDiscussLocks() {},
    deriveTabTitle: () => 'Split the task', tabSubtaskContext: t => t?.subtaskCtx || null,
    captureSubtaskCtx: () => null, subtaskCtxFromChatState: cs => cs.parentTaskKey ? { taskKey: cs.parentTaskKey } : null,
    computeTabStatus: () => 'idle', normalizeChatMessages: m => m,
    buildWsUrl: id => 'ws://test/' + id,
    WebSocket: class {
      static OPEN = 1;
      readyState = 1;
      sent = [];
      constructor() { sockets.push(this); }
      send(data) { this.sent.push(JSON.parse(data)); }
    },
    effectiveObjectiveModel: () => null,
    OBJECTIVE_HISTORY_PAGE_MESSAGES: 20, escapeAttr, t: key => key,
    objectiveIsStreaming: () => false,
    renderComposerHeader: () => '', _buildTabBarInnerHtml: () => '',
    buildModelSelectorHtml: () => '', buildEmbedMenuHtml: () => '', DROPDOWN_CARET_SVG: '',
    rememberActiveTabView() {}, renderActiveTab() {},
    ensureDiscussTask() { assert.fail('plain New Objective must not fetch a task preview'); },
    renderDiscussPreviewHtml() { assert.fail('plain New Objective must not render a task preview'); },
    sessionStorage: { setItem: (k, v) => storage.set(k, v), getItem: k => storage.get(k), removeItem: k => storage.delete(k) },
    setTimeout: () => 1, clearTimeout() {}, projectHeader: () => ({}), fetchWithRetry: async () => ({}),
  };
  vm.createContext(env);
  for (const name of ['rehashPayload', 'spawnObjectiveTab', 'openNewTab', 'tabSubtaskCtx', 'tabOriginTaskKey',
    'tabDiscussKey', 'renderObjectiveContent',
    'startChat', 'connectObjectiveWS', 'sendChatMessage', 'clearActiveTab',
    'saveChatState', 'restoreChatState', '_wrapChatStateInTab']) loadFunction(env, name);
  return { env, state, tab, drafts, storage, sockets };
}
const split = { rehashIntent: 'split', taskKey: 'TPT210', title: 'TPT210', subtaskCtx: { taskKey: 'TPT210', title: 'Attachments' } };

test('split opens empty, clears stale view, and sends only user text plus separate task context', () => {
  const { env, state, tab, drafts, sockets } = chat();
  env.spawnObjectiveTab('', split);
  assert.equal(drafts.size, 0);
  assert.equal(tab.viewState, null);
  assert.equal(env._pendingComposerSeed, null);
  env.startChat('Split the task', 'Split the task', 'planner rules');
  sockets[0].onopen();
  const start = sockets[0].sent[0];
  assert.equal(start.prompt, 'Split the task');
  assert.equal(start.userText, 'Split the task');
  assert.equal(start.rehashIntent, 'split');
  assert.equal(start.taskKey, 'TPT210');
  assert.equal(state.chatState.parentTaskKey, 'TPT210');
  assert.equal(state.chatState.messages[0].content, 'Split the task');
});

test('deferred start uses owning tab after user switches to another chat', () => {
  const { env, state, sockets } = chat();
  env.spawnObjectiveTab('', split);
  env.startChat(null, 'Split the task', 'planner rules');
  const owner = state.chatState;
  state.tabsState.push({ tabId: 'other', chatState: { originalUserText: 'unrelated' } });
  state.activeTabId = 'other';
  state.chatState = state.tabsState[1].chatState;
  owner._sendStart({ prompt: 'Split the task' });
  sockets[0].onopen();
  assert.equal(sockets[0].sent[0].taskKey, 'TPT210');
  assert.equal(sockets[0].sent[0].userText, 'Split the task');
});

test('follow-up and closed-socket retry retain split context without adding hidden user messages', async () => {
  const { env, state, sockets } = chat();
  env.spawnObjectiveTab('', split);
  env.startChat('Split the task', 'Split the task', 'planner rules');
  sockets[0].onopen();
  await env.sendChatMessage('Use three tasks');
  assert.equal(sockets[0].sent[1].rehashIntent, 'split');
  assert.equal(sockets[0].sent[1].taskKey, 'TPT210');
  assert.equal(state.chatState.messages[2].content, 'Use three tasks');
  sockets[0].readyState = 3;
  env.buildObjectivePrompt = () => ({ systemPrompt: 'planner rules', userPrompt: 'retry' });
  env.getObjectiveGroupingEnabled = () => true;
  await env.sendChatMessage('Try again');
  sockets[1].onopen();
  assert.equal(sockets[1].sent[0].rehashIntent, 'split');
  assert.equal(sockets[1].sent[0].taskKey, 'TPT210');
});

test('saved proposals restore split intent and parent link; ordinary opens clear them', () => {
  const { env, state, tab, sockets } = chat();
  env.spawnObjectiveTab('', split);
  env.startChat('Split the task', 'Split the task', 'planner rules');
  state.chatState.messages[1].cards = [{ type: 'new', task: { title: 'Validate uploads' } }];
  state.chatState.messages[1].acceptedMask = [true];
  env.saveChatState();
  state.chatState = null;
  state.tabsState = [];
  assert.equal(env.restoreChatState(), true);
  assert.equal(state.chatState.rehashIntent, 'split');
  assert.equal(state.chatState.parentTaskKey, 'TPT210');
  assert.equal(state.tabsState[0].taskKey, 'TPT210');
  env.clearActiveTab();
  env.spawnObjectiveTab('Build a calendar');
  assert.equal(state.tabsState[0].rehashIntent, null);
  assert.equal(state.tabsState[0].taskKey, null);
  env.startChat('Build a calendar', 'Build a calendar', 'planner rules');
  sockets.at(-1).onopen();
  assert.equal(sockets.at(-1).sent[0].rehashIntent, null);
  assert.equal(state.chatState.parentTaskKey, null);
});

const discuss = { rehashIntent: 'discuss', taskKey: 'TPT179', title: 'TPT179' };

// Run the actual renderer and prompt builder: an empty seed alone cannot prove
// that the textarea, preview slot, or first WebSocket payload stays clean.
for (const previous of [null, split, discuss]) {
  for (const opening of ['new tab', 'reused tab']) {
    test(`plain New Objective ${opening} after ${previous?.rehashIntent || 'fresh start'} keeps the default UI and prompt`, () => {
      const { env, state, sockets } = chat();
      const defaultPrompt = buildObjectivePrompt('Build a calendar').systemPrompt;
      assert.doesNotMatch(defaultPrompt, /<\/?rehash-(?:split|discuss)>/);
      if (previous) {
        env.spawnObjectiveTab('', previous);
        env.startChat('Refine this task', 'Refine this task', defaultPrompt);
      }
      if (opening === 'new tab') env.openNewTab();
      else {
        env.clearActiveTab();
        env.spawnObjectiveTab('');
      }

      const html = env.renderObjectiveContent();
      const textarea = html.match(/<textarea\b[^>]*id="chat-input"[^>]*>([\s\S]*?)<\/textarea>/);
      assert.ok(textarea, 'composer textarea exists');
      assert.equal(textarea[1], '', 'fresh composer is empty');
      assert.doesNotMatch(html, /chat-discuss-preview|chat-discuss-card|data-preview-task|<\/?rehash-(?:split|discuss)>/);
      assert.match(html, /What do you want to build or fix\?/);
      assert.equal(env._pendingComposerSeed, null);
      assert.equal(state.chatState, null);

      const { userPrompt, systemPrompt } = buildObjectivePrompt('Build a calendar', null, null, {
        groupingEnabled: true, originTaskKey: env.tabOriginTaskKey(),
      });
      env.startChat(userPrompt, 'Build a calendar', systemPrompt);
      sockets.at(-1).onopen();
      const start = sockets.at(-1).sent[0];
      assert.equal(start.systemPrompt, defaultPrompt, 'default system prompt is byte-for-byte unchanged');
      assert.equal(state.chatState.systemPrompt, defaultPrompt);
      assert.equal(start.prompt, 'Objective from the user:\n\nBuild a calendar');
      assert.equal(start.userText, 'Build a calendar');
      assert.equal(start.rehashIntent, null);
      assert.equal(start.taskKey, null);
      assert.equal(state.chatState.parentTaskKey, null);
      assert.equal(state.chatState.originTaskKey, null);
      assert.doesNotMatch(JSON.stringify(state.chatState.messages), /<\/?rehash-(?:split|discuss)>/);
    });
  }
}

test('discuss opens with an empty composer and sends only user text plus separate task context', () => {
  const { env, state, tab, drafts, sockets } = chat();
  env.spawnObjectiveTab('', discuss);
  assert.equal(drafts.size, 0);
  assert.equal(tab.viewState, null);
  assert.equal(env._pendingComposerSeed, null);
  assert.equal(tab.rehashIntent, 'discuss');
  assert.equal(tab.taskKey, 'TPT179');
  // Discuss is neither subtask mode nor web-origin planning — both would change save semantics.
  assert.equal(tab.subtaskCtx, null);
  assert.equal(tab.originTaskKey, null);
  env.startChat('improve this', 'improve this', 'planner rules');
  sockets[0].onopen();
  const start = sockets[0].sent[0];
  assert.equal(start.prompt, 'improve this');
  assert.equal(start.userText, 'improve this');
  assert.equal(start.rehashIntent, 'discuss');
  assert.equal(start.taskKey, 'TPT179');
  assert.equal(state.chatState.parentTaskKey, null);
  assert.equal(state.chatState.originTaskKey, null);
  assert.equal(state.chatState.messages[0].content, 'improve this');
  // The instruction is server-side only: nothing the user could see or edit carries it.
  assert.doesNotMatch(JSON.stringify(state.chatState.messages), /research and improve|modified|rehash-discuss/i);
});

test('every discuss open drops that task\'s cached preview so it refetches fresh data', () => {
  const { env } = chat();
  env.discussTaskCache.set('TPT179', { task: { title: 'stale' } });
  env.discussTaskCache.set('TPT200', { task: { title: 'unrelated' } });
  env.spawnObjectiveTab('', discuss);
  assert.equal(env.discussTaskCache.has('TPT179'), false);
  assert.equal(env.discussTaskCache.has('TPT200'), true);
});

test('discuss follow-ups and restored chats keep the intent without inventing a parent link', async () => {
  const { env, state, sockets } = chat();
  env.spawnObjectiveTab('', discuss);
  env.startChat('improve this', 'improve this', 'planner rules');
  sockets[0].onopen();
  await env.sendChatMessage('Tighten the scope');
  assert.equal(sockets[0].sent[1].rehashIntent, 'discuss');
  assert.equal(sockets[0].sent[1].taskKey, 'TPT179');
  assert.equal(state.chatState.messages[2].content, 'Tighten the scope');
  // saveChatState() only persists a chat that holds an unsaved proposal.
  state.chatState.messages[1].cards = [{ type: 'modified', task: { id: 'TPT179', title: 'Rehash discuss' } }];
  state.chatState.messages[1].acceptedMask = [true];
  env.saveChatState();
  state.chatState = null;
  state.tabsState = [];
  assert.equal(env.restoreChatState(), true);
  assert.equal(state.chatState.rehashIntent, 'discuss');
  assert.equal(state.chatState.taskKey, 'TPT179');
  assert.equal(state.chatState.parentTaskKey, null);
  assert.equal(state.tabsState[0].rehashIntent, 'discuss');
  assert.equal(state.tabsState[0].taskKey, 'TPT179');
});

test('a plain New Objective after discuss carries no intent, and unknown modes are dropped', () => {
  const { env, state, sockets } = chat();
  env.spawnObjectiveTab('', discuss);
  env.startChat('improve this', 'improve this', 'planner rules');
  env.clearActiveTab();
  env.spawnObjectiveTab('Build a calendar');
  assert.equal(state.tabsState[0].rehashIntent, null);
  assert.equal(state.tabsState[0].taskKey, null);
  env.startChat('Build a calendar', 'Build a calendar', 'planner rules');
  sockets.at(-1).onopen();
  assert.equal(sockets.at(-1).sent[0].rehashIntent, null);
  assert.equal(sockets.at(-1).sent[0].taskKey, null);
  env.spawnObjectiveTab('', { rehashIntent: 'execute', taskKey: 'TPT179' });
  assert.equal(state.tabsState.at(-1).rehashIntent, null);
});

// (TPT254) A blank subtask kickoff dispatches once, carries the split parent, and never
// invents a default brief in anything the user or a restore could see.
test('a blank subtask kickoff dispatches one start that still carries the split parent', () => {
  const { env, state, sockets } = chat();
  env.spawnObjectiveTab('', split);
  const { userPrompt, systemPrompt } = buildObjectivePrompt(BLANK_SUBTASK_BRIEF, null, null, { groupingEnabled: true, originTaskKey: null });
  // startChat's userText argument stays '' — only the prompt payload substitutes the nudge.
  env.startChat(userPrompt, '', systemPrompt);
  sockets[0].onopen();
  assert.equal(sockets.length, 1, 'one socket');
  assert.equal(sockets[0].sent.length, 1, 'dispatched once');
  const start = sockets[0].sent[0];
  assert.equal(start.userText, '', 'no default brief is synthesised into userText');
  assert.equal(start.prompt, 'Objective from the user:\n\nSplit this task into subtasks.');
  assert.equal(start.rehashIntent, 'split');
  assert.equal(start.taskKey, 'TPT210');
  assert.equal(state.chatState.parentTaskKey, 'TPT210');
  assert.equal(state.chatState.originalUserText, '');
  assert.equal(state.chatState.messages[0].content, '');
});

// Wiring guards: doSend is a `const` arrow inside attachChatHandlers() and cannot be pulled
// out with loadFunction, so assert on source text directly — same house pattern used
// elsewhere for handlers wired only at render time.
test('(TPT254) doSend gates the composer through canSubmitObjective with the live subtask context and busy term', () => {
  assert.match(source, /const blankSplitStart = !state\.chatState && !!tabSubtaskCtx\(\);/,
    'blank sends are eligible only on a tab\'s first turn, never a follow-up');
  assert.match(source, /if \(!canSubmitObjective\(text, \{ allowBlank: blankSplitStart, busy: objectiveIsStreaming\(\) \}\)\) return;/,
    'the composer guard must pass both the subtask-eligibility flag and the busy predicate — a bare `if (!text) return` blocks split mode, and dropping objectiveIsStreaming() reopens the double-dispatch window a cleared composer used to close');
  assert.doesNotMatch(source, /const text = chatInput\.value\.trim\(\);\s*\n\s*if \(!text\) return;/,
    'the unconditional empty-input bail is gone');
  assert.match(source, /if \(text\) await saveRecipe\(text\);/,
    'a blank kickoff must not POST \/api\/recipes — both writers reject empty content with 400');
  assert.match(source, /buildObjectivePrompt\(text \|\| BLANK_SUBTASK_BRIEF, null, null,/,
    'the nudge is substituted into the prompt payload only, never into text/userText/originalUserText');
  // One doSend serves both controls: the keydown handler must still delegate, not re-validate.
  assert.match(source, /if \(!isSubmitShortcut\(e\)\) return;\s*\n\s*e\.preventDefault\(\);\s*\n\s*doSend\(\);/);
});

// (TPT255) Rehash -> Split -> AI and the board's own Create Subtasks button must be the SAME
// spawn: a seeded, editable brief plus subtaskCtx/rehashIntent, not an empty composer.
test('(TPT255) showSplitModal()\'s .btn-split-auto and template.html\'s .btn-create-subtasks both call spawnSplitObjectiveTab(), not a bare empty-seed spawnObjectiveTab', () => {
  const taskBoardSrc = read('task-board.js');
  const helperStart = taskBoardSrc.indexOf('export function spawnSplitObjectiveTab(');
  assert.notEqual(helperStart, -1, 'spawnSplitObjectiveTab() not found in task-board.js');
  const helperBody = taskBoardSrc.slice(helperStart, taskBoardSrc.indexOf('\n}', helperStart));
  assert.match(helperBody, /spawnObjectiveTab\?\.\(t\('chat\.splitSeed', \{ key: taskKey \}\)/,
    'the shared helper must seed a non-empty, key-bearing brief via i18n, not \'\'');
  assert.match(helperBody, /subtaskCtx: \{ taskKey, title \}, taskKey, rehashIntent: 'split'/,
    'the shared helper must still set subtaskCtx + rehashIntent:\'split\' — the server-side directive depends on it');

  const autoIdx = taskBoardSrc.indexOf(".btn-split-auto').addEventListener");
  assert.notEqual(autoIdx, -1, '.btn-split-auto handler not found');
  const autoSlice = taskBoardSrc.slice(autoIdx, autoIdx + 250);
  assert.match(autoSlice, /spawnSplitObjectiveTab\(taskKey, taskTitle\)/,
    '.btn-split-auto must route through the shared helper');
  assert.doesNotMatch(autoSlice, /spawnObjectiveTab\?\.\(\s*''/,
    '.btn-split-auto must no longer spawn with an empty seed');

  const templateSrc = read('template.html');
  const createIdx = templateSrc.indexOf(".querySelectorAll('.btn-create-subtasks')");
  assert.notEqual(createIdx, -1, '.btn-create-subtasks handler not found');
  const createSlice = templateSrc.slice(createIdx, createIdx + 400);
  assert.match(createSlice, /spawnSplitObjectiveTab\(btn\.dataset\.taskKey, btn\.dataset\.taskTitle\)/,
    '.btn-create-subtasks must route through the same shared helper as Rehash -> Split -> AI');
});
