// Renders the real New Task form in a DOM process isolated from node:test globals and asserts
// Member Assignee defaults/drafts and the real Preview/Confirm save path for every agent
// choice, including unassigned and Pi image rows. No live API or paid model calls.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:4455/' });
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });

class TestIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.IntersectionObserver = TestIntersectionObserver;
window.IntersectionObserver = TestIntersectionObserver;
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt350-dom-'));
const bundlePath = join(temporary, 'client.mjs');
const DRAFT_KEY = 'todo-draft-task';
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: `export * as board from './src/client/task-board.js';
        export * as sprint from './src/client/new-task-sprint.js';
        export * as group from './src/client/group-label.js';
        export { normalizeAgentAssignee } from './src/agent-assignee.mjs';
        export { saveTaskChange } from './src/client/chat-task-preview.js';
        export { renderCard } from './src/client/task-card.js';
        export { default as state } from './src/client/state.js';
        export { api } from './src/client/api-client.js';`,
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { board, state, api, sprint, group, normalizeAgentAssignee, saveTaskChange, renderCard } = await import(pathToFileURL(bundlePath).href);

  // A ReferenceError inside a fire-and-forget `.then()` of the form's handlers would otherwise
  // surface only as an unhandled rejection, so collect them and assert none at the end.
  const unhandled = [];
  process.on('unhandledRejection', (err) => unhandled.push(err));
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  state.projectMembers = [
    { id: 1, user_id: 7, name: 'Ada' },
    { id: 2, user_id: 9, name: 'Grace' },
  ];
  api.members.list = async () => state.projectMembers;
  const reset = (currentUserId) => {
    state.currentUserId = currentUserId;
    state.manualTaskState = null;
    sessionStorage.removeItem(DRAFT_KEY);
  };
  const renderCombo = () => {
    document.body.innerHTML = board.renderNewTaskForm([], []);
    return {
      value: document.querySelector('#new-task-form .member-combo-value').value,
      label: document.querySelector('#new-task-form .member-combo-input').value,
    };
  };

  // A fresh form preselects the current user (id in the hidden value, name in the field).
  reset(7);
  assert.deepEqual(renderCombo(), { value: '7', label: 'Ada' });

  // Current user not resolved yet: no crash, no bogus preselect.
  reset(null);
  assert.deepEqual(renderCombo(), { value: '', label: '' });

  // A saved draft that deliberately picked "(none)" keeps it — the key is present with null.
  reset(7);
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ title: 'Draft', assignee: null }));
  assert.deepEqual(renderCombo(), { value: '', label: '' });

  // A saved draft that picked someone else keeps that pick over the current-user default.
  reset(7);
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ title: 'Draft', assignee: 9 }));
  assert.deepEqual(renderCombo(), { value: '9', label: 'Grace' });

  // An old draft with no assignee key at all gets the current-user default.
  reset(7);
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ title: 'Old draft' }));
  assert.deepEqual(renderCombo(), { value: '7', label: 'Ada' });

  // Draft persistence: a pristine preselected form is not a draft; any real change is.
  reset(7);
  const fresh = board.ensureManualTaskState();
  assert.equal(fresh.assignee, 7);
  board.saveNewTaskDraft();
  assert.equal(sessionStorage.getItem(DRAFT_KEY), null, 'pristine preselected form must not persist a draft');

  fresh.assignee = null; // user explicitly clears the assignee
  board.saveNewTaskDraft();
  assert.equal(JSON.parse(sessionStorage.getItem(DRAFT_KEY)).assignee, null);
  assert.ok(Object.hasOwn(JSON.parse(sessionStorage.getItem(DRAFT_KEY)), 'assignee'),
    'explicit "(none)" must be stored as a key so a rehydrate does not re-default it');

  fresh.assignee = 9;
  board.saveNewTaskDraft();
  assert.equal(JSON.parse(sessionStorage.getItem(DRAFT_KEY)).assignee, 9);

  // Interaction: wire the real handlers, then pick a different member through the combo.
  // attachNewTaskFormHandlers() also kicks off the async config/agent-model repaint that goes
  // through _applyModalAgentModelVisibility, so this doubles as a wiring check for the
  // helpers task-board.js imports from task-edit-modal.js.
  reset(7);
  document.body.innerHTML = board.renderNewTaskForm([], []);
  const form = document.querySelector('#new-task-form');
  board.attachNewTaskFormHandlers(form, {});
  await tick();
  await tick();
  const comboInput = form.querySelector('.member-combo-input');
  comboInput.dispatchEvent(new window.Event('focus'));
  const options = [...document.querySelectorAll('.member-typeahead-option')];
  assert.equal(options.length, 3, 'a (none) row plus the two members');
  assert.ok(options[1].textContent.includes('Ada') && options[2].textContent.includes('Grace'));
  options[2].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(state.manualTaskState.assignee, 9);
  assert.equal(form.querySelector('.member-combo-value').value, '9');
  assert.equal(JSON.parse(sessionStorage.getItem(DRAFT_KEY)).assignee, 9);

  await tick();
  assert.deepEqual(unhandled, [], 'New Task form handlers must not leave an unhandled rejection');

  // (TPT624) The sprint combo re-shows the user's raw pick after a draft restore or Back
  // from Preview — including Backlog (0 / 'null') and "+ New", never an empty "-- Select --".
  const renderSprint = () => {
    document.body.innerHTML = board.renderNewTaskForm([], [1, 2, 3]);
    const combo = document.querySelector('#new-task-form .sprint-combo[data-id="new-task-priority"]');
    return { current: combo.dataset.current, label: combo.querySelector('.sprint-combo-input').value };
  };
  for (const [stored, current] of [[0, 'null'], ['null', 'null'], ['__new__', '__new__'], ['1', '1'], [2, '2']]) {
    reset(7);
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ title: 'Draft', priority: stored }));
    const restored = renderSprint();
    assert.equal(restored.current, current, `draft priority ${JSON.stringify(stored)}`);
    assert.notEqual(restored.label, '', `draft priority ${JSON.stringify(stored)} must show a label`);
  }
  reset(7);
  state.manualTaskState = { ...board.ensureManualTaskState(), title: 'Back', priority: 'null', phase: 'form' };
  assert.deepEqual(renderSprint(), { current: 'null', label: 'Backlog' }, 'Back from Preview keeps Backlog');
  reset(7);

  // Exercise the actual inline Preview/Confirm listeners and saveTaskChange(), not a copy of
  // their mapping. The fake transport records the outgoing write; backend transport coverage
  // separately verifies the same payload against the API's strict agent enum.
  const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  const start = template.indexOf('  const newTaskForm =', template.indexOf('// ── Manual task creation handlers'));
  const handlers = template.slice(start, template.indexOf('  const newTaskBackBtn =', start));
  assert.ok(start > 0 && handlers.includes('newTaskConfirmBtn.addEventListener'));
  group.setSprintsEnabled(false);
  state.objectiveProviders = [{ id: 'pi', configuredModels: ['openrouter/text-row', 'openrouter/image-row'],
    toolLessModels: ['openrouter/image-row'], imageModels: ['openrouter/image-row'] }];
  state.debugPerfLog = true;
  state.chatState = null;
  let savedRows = [];
  let writes = 0;
  const errors = [];
  const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith('./TODO.md')) return new Response('```json\n' + JSON.stringify({ tasks: savedRows }) + '\n```');
    if (url === '/api/resolve-sprints') return response(JSON.parse(options.body));
    if (url === '/api/todo') {
      const payload = JSON.parse(options.body.match(/```json\s*([\s\S]*?)```/)[1]);
      const task = payload.tasks.at(-1);
      assert.ok(task.agentAssignee === null || ['human', 'claude', 'codex', 'pi'].includes(task.agentAssignee));
      savedRows = [{ ...task, id: 'TST1' }];
      writes++;
      return response({ idRemap: { [task.id]: 'TST1' } });
    }
    return response({});
  };
  function renderManual() {
    document.body.innerHTML = state.activeTab === 'board'
      ? savedRows.map(row => renderCard(row)).join('') : board.renderNewTaskForm([], []);
    if (state.activeTab === 'board') return;
    const scope = {
      app: document.body, state, tasks: [], tierKeys: [], _parentTaskKey: null,
      ...sprint, normalizeAgentAssignee, getSprintsEnabled: group.getSprintsEnabled,
      currentActiveSprintPriority: () => 1, sprintRecordMax: () => 0, startName: () => 'pending',
      nextTaskKeyGuess: () => 'TST999', fetchNextTaskKey: async () => null,
      loadAndRender: renderManual, saveTaskChange, _currentUser: { id: 7 },
      unregisteredProjectTags: async () => [], invalidateProjectTags() {},
      clearDraft() {}, DRAFT_KEY_TASK: DRAFT_KEY, ACTIVE_NEW_TAB_KEY: 'new-tab',
      invalidateBoardTaskCache() {}, showToast: message => errors.push(message),
      t: (key, params) => `${key} ${params?.msg || ''}`, tc: key => key,
    };
    new Function(...Object.keys(scope), handlers)(...Object.values(scope));
    board.attachNewTaskFormHandlers(document.querySelector('#new-task-form'));
  }
  const cases = [
    { name: 'untouched', expected: null },
    { name: 'unassigned', value: '', expected: null },
    { name: 'human', value: 'human', expected: 'human' },
    { name: 'claude', value: 'claude', expected: 'claude', claudeModel: 'claude-sonnet-5' },
    { name: 'codex', value: 'codex', expected: 'codex', codexModel: 'gpt-5.6-sol' },
    { name: 'pi-text', value: 'pi', expected: 'pi', piModel: 'openrouter/text-row' },
    { name: 'pi-image', value: 'pi', expected: 'pi', piModel: 'openrouter/image-row' },
    { name: 'human-category', category: 'HUMAN', expected: 'human' },
    { name: 'stale-preview', expected: null, stalePreview: true },
  ];
  for (const choice of cases) {
    reset(7);
    state.activeTab = 'new_task';
    if (choice.category) board.ensureManualTaskState().category = choice.category;
    savedRows = [];
    renderManual();
    await tick();
    if (choice.value !== undefined) {
      const option = [...document.querySelectorAll('.agent-picker-option')].find(el =>
        el.dataset.value === choice.value && (!choice.piModel || el.dataset.piModel === choice.piModel));
      assert.ok(option, `${choice.name} picker option exists`);
      option.click();
      assert.equal(state.manualTaskState.agentAssignee, choice.value);
    }
    for (const key of ['claudeModel', 'codexModel']) {
      if (choice[key]) board.ensureManualTaskState()[key] = choice[key];
    }
    document.querySelector('#new-task-title').value = `Save ${choice.name}`;
    document.querySelector('#new-task-preview').click();
    await tick();
    assert.deepEqual(unhandled, [], choice.name);
    assert.equal(state.manualTaskState.previewTask.agentAssignee, choice.expected, choice.name);
    if (choice.stalePreview) state.manualTaskState.previewTask.agentAssignee = 'pi:stale-row';
    document.querySelector('#new-task-confirm').click();
    for (let attempt = 0; state.activeTab !== 'board' && !errors.length && attempt < 50; attempt++) await tick();
    assert.deepEqual(errors, [], choice.name);
    assert.equal(state.activeTab, 'board', choice.name);
    assert.equal(savedRows[0].agentAssignee, choice.expected, choice.name);
    for (const key of ['claudeModel', 'codexModel', 'piModel']) {
      assert.equal(savedRows[0][key], choice[key] || null, `${choice.name} keeps ${key}`);
    }
    assert.ok(document.querySelector('.card[data-id="TST1"]'), `${choice.name} saved card renders on board`);
  }
  assert.equal(writes, cases.length, 'one write per Confirm');
  await tick();
  assert.deepEqual(unhandled, []);

  console.log('TPT350_DOM_PASS');
  console.log('TPT9146_AGENT_SAVE_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
