// Drives the real task-start pickers in a DOM process isolated from node:test globals, with a Pi
// provider entry (the server's providers/registry.js listObjectiveProviders() shape) whose PI_MODELS
// rows include one that sets `tools: false`: the launch modal (openAgentSelectorModal), the agent
// picker the New Task form shares with the Task Edit modal, the card's agent-assign modal and the
// bulk start modal. A tool-less row can never run a task, so none of them may offer it.
// The launch modal's title and Remember label are also checked in English and Ukrainian.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

// The launch modal fetches the provider list itself when it opens before one arrived.
const providerFetches = [];
let providersPayload = { objectiveProviders: [] };
globalThis.fetch = async (url) => {
  const isProviders = String(url).includes('/api/objective/providers');
  if (isProviders) providerFetches.push(String(url));
  return { ok: true, status: 200, json: async () => (isProviders ? providersPayload : {}) };
};

const TOOLLESS = 'recraft-v3';
const CAPABLE = 'openrouter/a/b';
const claude = {
  id: 'claude', label: 'Claude Code', available: true, enabled: true, selectable: true,
  defaultModel: 'opus', models: [{ value: 'opus' }], configuredModels: [], toolLessModels: [],
};
const pi = (configuredModels, toolLessModels) => ({
  id: 'pi', label: 'Other Model', available: true, enabled: true, selectable: configuredModels.length > 0,
  defaultModel: configuredModels[0] || '', models: configuredModels.map((value) => ({ value })),
  configuredModels, toolLessModels,
});
// Row 0 sets tools:false (it stays the objective-chat default), row 1 is tool-capable.
const ROW0_TOOLLESS = [claude, pi([TOOLLESS, CAPABLE], [TOOLLESS])];
const ALL_TOOLLESS = [claude, pi([TOOLLESS], [TOOLLESS])];

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'pi-task-pickers-dom-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: `export * as board from './src/client/task-board.js';
        export * as card from './src/client/task-card.js';
        export * as modal from './src/client/console-modal.js';
        export { setLocale, t } from './src/client/i18n.js';
        export { shortModelName } from './src/client/utils.js';
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
  const { board, card, modal, state, api, setLocale, t, shortModelName } = await import(pathToFileURL(bundlePath).href);

  // A ReferenceError inside a fire-and-forget `.then()` would otherwise surface only as an
  // unhandled rejection, so collect them and assert none at the end.
  const unhandled = [];
  process.on('unhandledRejection', (err) => unhandled.push(err));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const escape = () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  state.availableAgents = ['claude', 'pi'];
  state.taskAgent = 'pi';
  state.currentUserId = 7;
  state.projectMembers = [];
  api.members.list = async () => [];

  // ── Launch modal ──
  const launchButtons = () => [...document.querySelectorAll('.agent-selector-overlay .agent-selector-btn')]
    .map((b) => ({ agent: b.dataset.agent, model: b.dataset.model || null, current: b.classList.contains('agent-selector-btn--current') }));
  const launchCopy = () => {
    const overlay = document.querySelector('.agent-selector-overlay');
    return [overlay.querySelector('.agent-selector-title').textContent, overlay.querySelector('.agent-selector-remember label').textContent.trim()];
  };

  state.objectiveProviders = ROW0_TOOLLESS;
  modal.openAgentSelectorModal('TPT1', 'Title', 'Desc', 'pending');
  assert.deepEqual(launchButtons(), [
    { agent: 'pi', model: CAPABLE, current: true },
    { agent: 'claude', model: null, current: false },
  ], 'row 0 is tool-less: only the tool-capable row is offered, first and marked current');
  assert.deepEqual(launchCopy(), ['Choose agent for this task', 'Remember for this session']);
  escape();
  assert.equal(document.querySelector('.agent-selector-overlay'), null);

  // The title and Remember label follow the project language.
  setLocale('uk');
  modal.openAgentSelectorModal('TPT1', 'Title', 'Desc', 'pending');
  assert.deepEqual(launchCopy(), ['Виберіть агента для цієї задачі', 'Запам’ятати для цієї сесії']);
  escape();
  setLocale('en');

  state.objectiveProviders = ALL_TOOLLESS;
  modal.openAgentSelectorModal('TPT1', 'Title', 'Desc', 'pending');
  assert.deepEqual(launchButtons(), [{ agent: 'claude', model: null, current: false }], 'no Pi row can run a task: Pi is not offered');
  escape();
  assert.equal(providerFetches.length, 0, 'a loaded provider list is not fetched again');

  // Opened before any provider list arrived: the modal's own fetch re-renders by the same rule.
  state.objectiveProviders = [];
  providersPayload = { objectiveProviders: ROW0_TOOLLESS };
  modal.openAgentSelectorModal('TPT1', 'Title', 'Desc', 'pending');
  assert.deepEqual(launchButtons(), [{ agent: 'claude', model: null, current: false }], 'Pi stays hidden until providers load');
  for (let i = 0; i < 50 && !launchButtons().some((b) => b.agent === 'pi'); i++) await tick();
  assert.equal(providerFetches.length, 1);
  assert.deepEqual(launchButtons().filter((b) => b.agent === 'pi').map((b) => b.model), [CAPABLE]);
  escape();

  // ── Agent picker: New Task form (the Task Edit modal renders the same option builder) ──
  const pickerOptions = () => [...document.querySelectorAll('#new-task-form .agent-picker[data-name="agentAssignee"] .agent-picker-option')]
    .map((o) => ({ value: o.dataset.value, piModel: o.dataset.piModel || null }));
  const renderForm = (draft) => {
    state.manualTaskState = null;
    sessionStorage.clear();
    if (draft) Object.assign(board.ensureManualTaskState(), draft);
    document.body.innerHTML = board.renderNewTaskForm([], []);
  };

  state.objectiveProviders = ROW0_TOOLLESS;
  renderForm();
  assert.deepEqual(pickerOptions(), [
    { value: '', piModel: null },
    { value: 'human', piModel: null },
    { value: 'claude', piModel: null },
    { value: 'codex', piModel: null },
    { value: 'pi', piModel: CAPABLE },
  ]);

  state.objectiveProviders = ALL_TOOLLESS;
  renderForm();
  assert.deepEqual(pickerOptions().filter((o) => o.value === 'pi'), [], 'no Pi row can run a task: no Pi option at all');

  state.objectiveProviders = [claude];
  renderForm();
  assert.deepEqual(pickerOptions().filter((o) => o.value === 'pi'), [{ value: 'pi', piModel: null }], 'rows not known yet: the generic Pi option stays');

  // Saved pins stay visible, but their titles explain the model a task will actually run.
  // Drive the real shared picker, card renderer, and independent To-Do badge renderer.
  const assertPinDisplays = (providers, pin, hint) => {
    state.objectiveProviders = providers;
    renderForm({ agentAssignee: 'pi', piModel: pin });
    const picker = document.querySelector('#new-task-form .agent-picker[data-name="agentAssignee"]');
    assert.equal(picker.querySelector('.agent-picker-trigger').title, hint);
    assert.equal(picker.querySelector('.agent-picker-label').textContent, pin ? shortModelName(pin) : 'Pi');
    assert.equal(picker.querySelector('input').dataset.piModel, pin || '', 'rendering never changes the saved pin');
    const task = { id: 'TPT1', title: 'Task', status: 'pending', priority: 1, agentAssignee: 'pi', piModel: pin };
    const title = `${pin ? shortModelName(pin) : 'Pi'}${hint ? ` — ${hint}` : ''}`;
    const host = document.createElement('div');
    host.innerHTML = card.renderAgentBadge(task);
    assert.equal(host.querySelector('.agent-badge').title, title, 'card badge');
    host.innerHTML = board.renderTodoContent([task], [1]);
    assert.equal(host.querySelector('.agent-badge').title, title, 'To-Do badge');
    return picker;
  };

  const fallbackHint = `Can’t run tasks — starts on ${CAPABLE}`;
  assertPinDisplays(ROW0_TOOLLESS, TOOLLESS, fallbackHint);
  assertPinDisplays([claude, pi([CAPABLE], [])], 'removed/model', fallbackHint);
  assertPinDisplays([pi(['provider/first', CAPABLE], [])], TOOLLESS, 'Can’t run tasks — starts on provider/first');
  assertPinDisplays(ALL_TOOLLESS, TOOLLESS, 'Can’t run tasks — choose a model with tool support');
  assertPinDisplays(ROW0_TOOLLESS, CAPABLE, '');
  assertPinDisplays(ROW0_TOOLLESS, ` ${CAPABLE.toUpperCase()} `, '');
  assertPinDisplays(ROW0_TOOLLESS, null, '');
  for (const providers of [[], [claude], [{ id: 'pi' }], [pi([], [])]]) {
    assertPinDisplays(providers, TOOLLESS, '');
  }
  // Both the saved id and fallback id are endpoint-defined text, never HTML attributes.
  assertPinDisplays([pi(['provider/"<&model'], [])], 'removed/"<&pin', 'Can’t run tasks — starts on provider/"<&model');
  assert.equal(document.querySelector('.agent-picker-trigger').attributes.length, 3);

  state.objectiveProviders = ROW0_TOOLLESS;
  renderForm({ agentAssignee: 'claude', piModel: TOOLLESS });
  assert.equal(document.querySelector('.agent-picker-trigger').title, '', 'an old Pi pin on another agent is irrelevant');
  const otherBadge = document.createElement('div');
  otherBadge.innerHTML = card.renderAgentBadge({ id: 'TPT1', agentAssignee: 'claude', piModel: TOOLLESS });
  assert.equal(otherBadge.querySelector('.agent-badge').title, 'Claude Code');

  // Locked pickers retain their explanation as well as the fallback hint.
  document.body.innerHTML = board.renderAgentPicker('agentAssignee', 'pi', true, ['pi'], TOOLLESS);
  const lockedPicker = document.querySelector('.agent-picker');
  assert.equal(lockedPicker.title, `${t('tooltip.cannotReassign')}\n${fallbackHint}`);
  assert.equal(lockedPicker.querySelector('.agent-picker-trigger').title, lockedPicker.title);

  // Changing the choice updates the existing trigger, so it must also retire the old warning.
  for (const choice of ['pi', 'claude']) {
    const picker = assertPinDisplays(ROW0_TOOLLESS, TOOLLESS, fallbackHint);
    const changes = [];
    board.initAgentPicker(picker, { onChange: (...args) => changes.push(args) });
    picker.querySelector('.agent-picker-trigger').click();
    document.querySelector(`.agent-picker-dropdown[data-portaled] .agent-picker-option[data-value="${choice}"]`).click();
    assert.equal(picker.querySelector('.agent-picker-trigger').hasAttribute('title'), false);
    assert.equal(picker.hasAttribute('title'), false);
    assert.deepEqual(changes, [[choice, { piModel: choice === 'pi' ? CAPABLE : null }]]);
  }

  setLocale('uk');
  assertPinDisplays(ROW0_TOOLLESS, TOOLLESS, `Не може виконувати задачі — запуск на ${CAPABLE}`);
  assertPinDisplays(ALL_TOOLLESS, TOOLLESS, 'Не може виконувати задачі — виберіть модель із підтримкою інструментів');
  setLocale('en');
  document.body.innerHTML = '';

  // ── Card agent-assign modal ──
  const assignOptions = () => [...document.querySelectorAll('.agent-assign-overlay .agent-assign-option')]
    .map((b) => ({ value: b.dataset.value, piModel: b.dataset.piModel || null }));

  state.objectiveProviders = ROW0_TOOLLESS;
  board.openAgentAssignModal('TPT1', '', 'pending', null);
  assert.deepEqual(assignOptions().filter((o) => o.value === 'pi'), [{ value: 'pi', piModel: CAPABLE }]);
  escape();

  state.objectiveProviders = ALL_TOOLLESS;
  board.openAgentAssignModal('TPT1', '', 'pending', null);
  assert.deepEqual(assignOptions().map((o) => o.value), ['human', 'claude', 'codex']);
  escape();
  assert.equal(document.querySelector('.agent-assign-overlay'), null);

  // ── Bulk start modal: a plain Pi start runs the first tool-capable row ──
  const bulkOptions = () => [...document.querySelectorAll('.bulk-agent-start-overlay .agent-picker-option')].map((o) => o.dataset.value);

  state.objectiveProviders = ROW0_TOOLLESS;
  board.showBulkAgentStartModal([{ id: 'TPT1' }], () => {});
  assert.deepEqual(bulkOptions(), ['', 'human', 'claude', 'pi']);
  escape();

  state.objectiveProviders = ALL_TOOLLESS;
  board.showBulkAgentStartModal([{ id: 'TPT1' }], () => {});
  assert.deepEqual(bulkOptions(), ['', 'human', 'claude'], 'no Pi row can run a task: Pi is not offered');
  escape();
  assert.equal(document.querySelector('.bulk-agent-start-overlay'), null);

  await tick();
  assert.deepEqual(unhandled, []);
  console.log('PI_TASK_PICKERS_DOM_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
process.exit(exitCode);
