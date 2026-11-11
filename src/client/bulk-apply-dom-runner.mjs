// (TPT9159) Drives the real bulk action bar in a DOM process isolated from node:test globals:
// fields stage edits, Apply writes them in one pass, Reset/Clear drop them, Design mode shows
// only beside a staged Claude, and the Task Edit modal reads the applied Design mode back.
// (TPT9212) The Model select beside the agent picker offers each agent's available models,
// resets on an agent change, and Apply saves the shown model with the agent.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:4455/' });
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent', 'MouseEvent',
  'KeyboardEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
// showSavingIndicator() paints on the next frame.
for (const key of ['requestAnimationFrame', 'cancelAnimationFrame']) globalThis[key] = window[key].bind(window);
class TestIntersectionObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.IntersectionObserver = TestIntersectionObserver;
window.IntersectionObserver = TestIntersectionObserver;
// (TPT9212) The project config and model registry the bulk Model select reads; the TPT9212 cases
// swap in a live registry and project defaults.
const stub = { config: { AVAILABLE_AGENTS: ['claude', 'codex', 'pi'] }, agentModels: {} };
globalThis.fetch = async url => ({
  ok: true,
  json: async () => url === '/api/config'
    ? structuredClone(stub.config)
    : String(url).startsWith('/api/agent-models') ? structuredClone(stub.agentModels)
      : url === '/api/sessions' ? { sessions: [] } : {},
});

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9159-dom-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: `export * as board from './src/client/task-board.js';
        export * as cards from './src/client/task-card.js';
        export { default as state } from './src/client/state.js';
        export { api } from './src/client/api-client.js';
        export { setProjectPermissionMode } from './src/client/group-label.js';
        export { setLocale } from './src/client/i18n.js';`,
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { board, cards, state, api, setLocale, setProjectPermissionMode } = await import(pathToFileURL(bundlePath).href);
  setProjectPermissionMode('bypass');
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  async function until(predicate, label) {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  const task = (id, overrides = {}) => ({
    id, title: `Title ${id}`, description: '', status: 'pending', category: 'CODING', priority: 3,
    tags: [], dependencies: [], assignee: 1, agentAssignee: 'codex', claudeDesignMode: false, ...overrides,
  });
  const tasks = new Map([
    ['A', task('A')],
    ['B', task('B', { agentAssignee: 'pi' })],
    ['C', task('C', { status: 'in_progress' })], // agent locked: keeps codex
    ['D', task('D', { agentAssignee: 'claude', claudeDesignMode: true })],
    ['F', task('F', { priority: 4 })], // keeps Sprint 4 in the Move to list
    ['G', task('G', { status: 'canceled', priority: 4 })],
  ]);
  const writes = [];
  api.tasks.update = async (id, patch) => {
    writes.push({ id, patch: structuredClone(patch) });
    const row = tasks.get(id);
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.sprint_id === null) row.priority = 0;
    if (patch.assignee !== undefined) row.assignee = patch.assignee;
    if (patch.agent_assignee !== undefined) row.agentAssignee = patch.agent_assignee;
    if (patch.claude_model !== undefined) row.claudeModel = patch.claude_model;
    if (patch.codex_model !== undefined) row.codexModel = patch.codex_model;
    if (patch.pi_model !== undefined) row.piModel = patch.pi_model;
    if (patch.claude_design_mode !== undefined) row.claudeDesignMode = patch.claude_design_mode;
    if (patch.cowboy_mode !== undefined) row.cowboyMode = patch.cowboy_mode;
    return { ...row };
  };
  api.tasks.get = async id => structuredClone(tasks.get(id));
  api.tasks.listAll = async () => [...tasks.values()];
  api.members.list = async () => state.projectMembers;
  api.tasks.comments.list = async () => [];
  api.tasks.events.list = async () => ({ events: [], subscribed: true });

  state.activeTab = 'board';
  state.currentUserId = 1;
  state.availableAgents = ['claude', 'codex', 'pi'];
  state.projectMembers = [{ id: 1, name: 'Alice' }, { id: 7, name: 'Dana' }];
  document.body.innerHTML = '<div id="task-edit-modal" hidden></div><div id="app"></div>';
  const paint = () => {
    const tier = (p) => `<div class="tier" data-priority="${p}"><div class="tier-cards">`
      + [...tasks.values()].filter(row => row.priority === p).map(row => cards.renderCard(row)).join('')
      + '</div></div>';
    document.getElementById('app').innerHTML = tier(3) + tier(4);
    state.tiers = { 3: [...tasks.values()].filter(row => row.priority === 3), 4: [...tasks.values()].filter(row => row.priority === 4) };
    state.tierKeys = [3, 4];
  };
  paint();
  const renders = [];
  const starts = [];
  board.initBulkActionBar(async (opts) => { renders.push(opts); }, {
    onStartTaskSession: async (row) => { starts.push(row.id); return { ok: true }; },
    onFetchActiveSessions: async () => {},
  });
  const bar = document.getElementById('bulk-action-bar');
  const $ = (selector) => bar.querySelector(selector);
  const select = (...ids) => {
    state.selectedCardIds.clear();
    for (const id of ids) state.selectedCardIds.add(id);
    board.updateBulkActionBar();
  };
  const pickAgent = (agent) => {
    $('.agent-picker-trigger').click();
    document.querySelector(`.agent-picker-dropdown[data-portaled] .agent-picker-option[data-value="${agent}"]`).click();
  };
  const pickStatus = (status) => {
    $('.bulk-status-select').value = status;
    $('.bulk-status-select').dispatchEvent(new Event('change', { bubbles: true }));
  };
  const pickCowboy = (scope) => {
    $('.bulk-cowboy-select').value = scope;
    $('.bulk-cowboy-select').dispatchEvent(new Event('change', { bubbles: true }));
  };
  const pickSprint = (value) => {
    $('.bulk-priority-combo .sprint-combo-input').click();
    const item = document.querySelector(`.sprint-combo-dropdown[data-portaled] .sprint-combo-item[data-value="${value}"]`);
    const label = item.textContent;
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return label;
  };
  const pickMember = (name) => {
    $('.bulk-assignee-input').dispatchEvent(new Event('focus'));
    [...bar.querySelectorAll('.bulk-assignee-option')].find(el => el.dataset.name === name)
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  };
  const designMode = () => $('.bulk-design-mode');
  const designCheckbox = () => $('.bulk-design-mode-input');
  const staged = () => [...bar.querySelectorAll('[data-bulk-field].is-staged')].map(el => el.dataset.bulkField);

  // At rest: nothing staged, Apply off, Reset and Design mode hidden, Start/Deps usable.
  select('A', 'B', 'C', 'D');
  assert.equal(bar.hidden, false);
  assert.equal($('.btn-bulk-apply').disabled, true);
  assert.equal($('.btn-bulk-reset').hidden, true);
  assert.equal(designMode().hidden, true);
  assert.equal($('.btn-bulk-start').getAttribute('aria-disabled'), null);
  assert.equal($('.agent-picker-label').textContent, 'Change agent…');
  assert.equal($('.bulk-cowboy-select').value, '');

  // Every field only stages — no write, no confirm dialog, no re-render.
  pickStatus('on_fire');
  assert.equal($('.bulk-status-select').value, 'on_fire');
  assert.equal(document.querySelector('.modal-overlay'), null, 'a status pick no longer asks to confirm');
  const sprintLabel = pickSprint('4');
  assert.ok(sprintLabel);
  assert.equal($('.bulk-priority-combo .sprint-combo-input').value, sprintLabel);
  pickMember('Dana');
  assert.equal($('.bulk-assignee-input').value, 'Dana');
  pickAgent('claude');
  pickCowboy('related');
  assert.equal(writes.length, 0, 'staging writes nothing');
  assert.equal(renders.length, 0);
  assert.deepEqual(staged(), ['priority', 'status', 'agent', 'assignee', 'cowboyScope']);
  assert.equal($('.btn-bulk-apply').disabled, false);
  assert.equal($('.btn-bulk-reset').hidden, false);
  assert.equal($('.btn-bulk-start').getAttribute('aria-disabled'), 'true');
  assert.equal($('.btn-bulk-deps').getAttribute('aria-disabled'), 'true');

  // Design mode: shown only beside a staged Claude; another agent hides it and clears it.
  assert.equal(designMode().hidden, false);
  assert.equal(designCheckbox().checked, false);
  designCheckbox().click();
  assert.equal(designCheckbox().checked, true);
  assert.equal(designMode().classList.contains('is-checked'), true);
  pickAgent('codex');
  assert.equal(designMode().hidden, true);
  assert.equal(designCheckbox().checked, false);
  pickAgent('pi');
  assert.equal(designMode().hidden, true);
  pickAgent('claude');
  assert.equal(designMode().hidden, false);
  assert.equal(designCheckbox().checked, false, 'a value cleared by another agent stays cleared');
  designCheckbox().click();

  // Staged values survive the re-render every loadAndRender() triggers.
  board.updateBulkActionBar();
  assert.equal($('.bulk-status-select').value, 'on_fire');
  assert.equal($('.bulk-priority-combo .sprint-combo-input').value, sprintLabel);
  assert.equal($('.agent-picker-label').textContent, 'Claude Code');
  assert.equal(designCheckbox().checked, true);
  assert.equal($('.bulk-assignee-input').value, 'Dana');
  assert.equal($('.bulk-cowboy-select').value, 'related');

  // Start and Deps wait while edits are staged.
  $('.btn-bulk-start').click();
  $('.btn-bulk-deps').click();
  await tick();
  assert.deepEqual(starts, []);
  assert.equal(document.querySelector('.bulk-deps-overlay'), null);
  assert.equal(writes.length, 0);

  // Apply: C is in progress, so it keeps its agent (one confirm), every other staged field
  // lands on every selected task in one PATCH each, then the bar closes.
  $('.btn-bulk-apply').click();
  await until(() => document.querySelector('.modal-overlay--over-board .btn-confirm'), 'the locked-task confirm');
  assert.match(document.querySelector('.modal-overlay--over-board').textContent, /1 locked task\(s\) will be skipped/);
  document.querySelector('.modal-overlay--over-board .btn-confirm').click();
  await until(() => bar.hidden, 'the bar to close');
  // (TPT9212) The agent carries its model: no project CLAUDE_MODEL and no live registry here, so
  // Claude's default 'opusplan' from the static list.
  const full = { priority: 4, status: 'on_fire', assignee: 7, agent_assignee: 'claude', claude_model: 'opusplan', claude_design_mode: true, cowboy_mode: 'related' };
  assert.deepEqual(writes, [
    { id: 'A', patch: full },
    { id: 'B', patch: full },
    { id: 'C', patch: { priority: 4, status: 'on_fire', assignee: 7, cowboy_mode: 'related' } },
    { id: 'D', patch: full },
  ]);
  assert.equal(state.selectedCardIds.size, 0);
  assert.equal(renders.length, 1);

  // The Task Edit modal reads the applied Design mode back.
  const modal = () => document.getElementById('task-edit-modal');
  await board.openTaskEditModal('A');
  assert.equal(modal().querySelector('.modal-claude-design-row').hidden, false);
  assert.equal(modal().querySelector('.modal-claude-design-mode').checked, true);
  board.closeTaskEditModal(true);
  await board.openTaskEditModal('C');
  assert.equal(modal().querySelector('.modal-claude-design-row').hidden, true, 'the locked task kept Codex');
  board.closeTaskEditModal(true);

  // Applying Claude with Design mode left unchecked writes false.
  paint();
  writes.length = 0;
  select('A', 'D');
  assert.equal($('.bulk-status-select').value, '', 'the applied record was dropped');
  assert.equal($('.btn-bulk-apply').disabled, true);
  pickAgent('claude');
  assert.equal(designCheckbox().checked, false);
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'the bar to close');
  assert.deepEqual(writes, [
    { id: 'A', patch: { agent_assignee: 'claude', claude_model: 'opusplan', claude_design_mode: false } },
    { id: 'D', patch: { agent_assignee: 'claude', claude_model: 'opusplan', claude_design_mode: false } },
  ]);
  await board.openTaskEditModal('D');
  assert.equal(modal().querySelector('.modal-claude-design-mode').checked, false);
  board.closeTaskEditModal(true);

  // A backlog move rides sprint_id:null, the backlog signal both update routes accept.
  paint();
  writes.length = 0;
  select('F');
  pickSprint('null');
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'the bar to close');
  assert.deepEqual(writes, [{ id: 'F', patch: { sprint_id: null } }]);

  // Every write failing keeps the bar and its staged edits for a retry; a partial failure
  // closes it and names the tasks that missed the change.
  paint();
  writes.length = 0;
  const recordingUpdate = api.tasks.update;
  api.tasks.update = async () => { throw new Error('offline'); };
  select('A', 'B');
  pickStatus('completed');
  pickCowboy('project');
  $('.btn-bulk-apply').click();
  await until(() => document.querySelector('.tt-toast--error'), 'the failure toast');
  assert.match(document.querySelector('.tt-toast--error').textContent, /Failed to save changes for: A, B/);
  assert.equal(bar.hidden, false);
  assert.equal($('.bulk-status-select').value, 'completed');
  assert.equal($('.bulk-cowboy-select').value, 'project');
  assert.equal($('.btn-bulk-apply').disabled, false);
  for (const toast of document.querySelectorAll('.tt-toast--error')) toast.remove();
  api.tasks.update = async (id, patch) => {
    if (id === 'B') throw new Error('rejected');
    return recordingUpdate(id, patch);
  };
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'the bar to close');
  assert.deepEqual(writes, [{ id: 'A', patch: { status: 'completed', cowboy_mode: 'project' } }]);
  assert.match(document.querySelector('.tt-toast--error')?.textContent || '', /Failed to save changes for: B/);
  for (const toast of document.querySelectorAll('.tt-toast--error')) toast.remove();
  api.tasks.update = recordingUpdate;

  // Reset drops the staged edits and keeps the selection.
  paint();
  writes.length = 0;
  select('A', 'B');
  pickStatus('completed');
  pickAgent('claude');
  designCheckbox().click();
  pickCowboy('project');
  $('.btn-bulk-reset').click();
  assert.equal(bar.hidden, false);
  assert.equal(state.selectedCardIds.size, 2);
  assert.deepEqual(staged(), []);
  assert.equal($('.bulk-status-select').value, '');
  assert.equal($('.bulk-cowboy-select').value, '');
  assert.equal($('.agent-picker-label').textContent, 'Change agent…');
  assert.equal(designMode().hidden, true);
  assert.equal($('.btn-bulk-apply').disabled, true);
  assert.equal($('.btn-bulk-start').getAttribute('aria-disabled'), null);

  // Closing the bar (Clear) discards: nothing written, nothing staged on reopen.
  pickStatus('completed');
  pickMember('Dana');
  pickCowboy('related');
  $('.bulk-clear').click();
  assert.equal(bar.hidden, true);
  select('A');
  assert.equal($('.bulk-status-select').value, '');
  assert.equal($('.bulk-assignee-input').value, '');
  assert.equal($('.bulk-cowboy-select').value, '');
  assert.equal($('.btn-bulk-apply').disabled, true);

  // Emptying the assignee field and leaving it unstages the assignee.
  pickMember('Dana');
  assert.deepEqual(staged(), ['assignee']);
  $('.bulk-assignee-input').value = '';
  document.body.click();
  assert.deepEqual(staged(), []);
  assert.equal(writes.length, 0);

  // Picking an agent when every selected task is locked is refused at once, as before.
  select('G');
  pickAgent('claude');
  assert.deepEqual(staged(), []);
  assert.equal(designMode().hidden, true);
  assert.match(document.querySelector('.tt-toast--error')?.textContent || '', /All selected tasks are locked/);
  board.clearBulkSelection();
  console.log('TPT9159_BULK_APPLY_PASS');

  // A mixed-permission batch is refused before any writes, without losing staged fields
  // or raising a task's permissions. Fixing permissions separately lets the same Apply run.
  paint();
  writes.length = 0;
  for (const toast of document.querySelectorAll('.tt-toast--error')) toast.remove();
  tasks.get('A').agentPermissionMode = 'bypass';
  tasks.get('B').agentPermissionMode = 'auto';
  select('A', 'B');
  pickStatus('on_fire');
  pickCowboy('project');
  $('.btn-bulk-apply').click();
  await tick();
  assert.deepEqual(writes, []);
  assert.match(document.querySelector('.tt-toast--error')?.textContent || '', /Nothing saved.*Bypass.*B/);
  assert.equal(tasks.get('B').agentPermissionMode, 'auto');
  assert.equal($('.bulk-status-select').value, 'on_fire');
  assert.equal($('.bulk-cowboy-select').value, 'project');
  assert.equal(state.selectedCardIds.size, 2);
  tasks.get('B').agentPermissionMode = null;
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'Cowboy with inherited Bypass to save');
  assert.deepEqual(writes, ['A', 'B'].map(id => ({ id, patch: { status: 'on_fire', cowboy_mode: 'project' } })));
  assert.equal(tasks.get('B').agentPermissionMode, null);
  assert.equal(tasks.get('A').agentPermissionMode, 'bypass');

  // Disabled is an explicit write even without Bypass. The placeholder removes only scope.
  writes.length = 0;
  tasks.get('B').agentPermissionMode = 'auto';
  select('B');
  pickCowboy('disabled');
  assert.equal($('.btn-bulk-apply').disabled, false);
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'Cowboy disabling to save');
  assert.deepEqual(writes, [{ id: 'B', patch: { cowboy_mode: 'disabled' } }]);
  assert.equal(tasks.get('B').agentPermissionMode, 'auto');
  select('A');
  pickStatus('completed');
  pickCowboy('related');
  pickCowboy('');
  assert.deepEqual(staged(), ['status']);
  $('.btn-bulk-reset').click();

  // A newer server snapshot may refuse Cowboy after a permission change: report it and
  // retain the selection for retry, even when PATCH itself resolves successfully.
  for (const toast of document.querySelectorAll('.tt-toast--error')) toast.remove();
  api.tasks.update = async (id, patch) => ({ ...await recordingUpdate(id, patch), cowboyMode: 'disabled' });
  pickCowboy('related');
  $('.btn-bulk-apply').click();
  await until(() => document.querySelector('.tt-toast--error'), 'normalized-scope refusal');
  assert.match(document.querySelector('.tt-toast--error').textContent, /Failed to save changes for: A/);
  assert.equal(bar.hidden, false);
  assert.equal($('.bulk-cowboy-select').value, 'related');
  assert.equal($('.btn-bulk-apply').disabled, false);
  api.tasks.update = recordingUpdate;
  board.clearBulkSelection();
  console.log('TPT9209_BULK_COWBOY_PASS');

  // (TPT9212) The Model select beside the agent picker, against a live registry that no longer
  // lists gpt-5.5 and a brand-new project: no CODEX_MODEL, a valid CLAUDE_MODEL, and three Pi
  // rows, one of them tool-less.
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const liveIds = { codex: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-sol'], claude: ['opusplan', 'claude-opus-5-5', 'claude-sonnet-5-5'] };
  stub.agentModels = { agents: Object.fromEntries(['codex', 'claude'].map(agent => [agent, {
    agent, source: 'probe', models: liveIds[agent].map((id, i) => ({ id, label: id.toUpperCase(), isLatest: i === 0 })),
  }])) };
  stub.config = { CLAUDE_MODEL: 'claude-opus-5-5', CODEX_MODEL: '', TASK_AGENT: 'claude' };
  const piRows = ['openrouter/qwen/qwen3-coder', 'openrouter/deepseek/deepseek-r1', 'openrouter/acme/chat-only'];
  state.objectiveProviders = [{ id: 'pi', configuredModels: piRows, toolLessModels: [piRows[2]], imageModels: [] }];
  tasks.get('C').status = 'in_progress'; // agent locked again
  paint();
  writes.length = 0;
  for (const toast of document.querySelectorAll('.tt-toast--error')) toast.remove();
  const modelWrap = () => $('.bulk-model');
  const modelSelect = () => $('.bulk-model-select');
  const modelOptions = () => [...modelSelect().options].map(option => option.value);
  const pickModel = (value) => {
    modelSelect().value = value;
    modelSelect().dispatchEvent(new Event('change', { bubbles: true }));
  };
  const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

  select('A', 'B', 'C', 'D');
  assert.equal(modelWrap().hidden, true, 'no Model select without a staged agent');
  pickAgent('codex');
  await until(() => sameList(modelOptions(), liveIds.codex), 'the live Codex models');
  assert.equal(modelWrap().hidden, false);
  assert.equal(modelSelect().value, 'gpt-6.1-sol', 'a fresh project starts Codex on the recommended live model');
  assert.ok(!modelOptions().includes('gpt-5.5'));
  assert.equal($('.bulk-model-text').textContent, 'Model');
  assert.equal($('.bulk-model-text').getAttribute('for'), 'bulk-model-select');
  assert.equal(modelSelect().closest('[data-bulk-field]').dataset.bulkField, 'agent', 'the model is part of the agent change');
  assert.deepEqual(staged(), ['agent']);
  pickModel('gpt-6-luna');
  board.updateBulkActionBar();
  assert.equal(modelSelect().value, 'gpt-6-luna', 'a pick survives the re-render');
  assert.equal(writes.length, 0, 'picking a model writes nothing');

  // Another agent resets the pick to that agent's own default; Human has none.
  pickAgent('claude');
  await until(() => sameList(modelOptions(), liveIds.claude), 'the live Claude models');
  assert.equal(modelSelect().value, 'claude-opus-5-5', 'Claude starts on the available project default');
  assert.equal(designMode().hidden, false);
  pickAgent('codex');
  assert.deepEqual(modelOptions(), liveIds.codex);
  assert.equal(modelSelect().value, 'gpt-6.1-sol', 'the earlier Codex pick went with the agent change');
  pickAgent('pi');
  assert.deepEqual(modelOptions(), piRows.slice(0, 2), 'Pi offers the rows a task can start on');
  assert.deepEqual([...modelSelect().options].map(option => [option.textContent, option.title]),
    [['qwen3-coder', piRows[0]], ['deepseek-r1', piRows[1]]]);
  assert.equal(modelSelect().value, piRows[0], 'Pi starts on the row a start without a model runs');
  pickAgent('human');
  assert.equal(modelWrap().hidden, true);
  pickAgent('');
  assert.equal(modelWrap().hidden, true);
  assert.deepEqual(staged(), []);

  // Apply saves the picked model with the agent on every task that takes the agent; the locked
  // task keeps both.
  pickAgent('codex');
  pickModel('gpt-6-luna');
  $('.btn-bulk-apply').click();
  await until(() => document.querySelector('.modal-overlay--over-board .btn-confirm'), 'the locked-task confirm');
  document.querySelector('.modal-overlay--over-board .btn-confirm').click();
  await until(() => bar.hidden, 'the bar to close');
  assert.deepEqual(writes, ['A', 'B', 'D'].map(id => ({ id, patch: { agent_assignee: 'codex', codex_model: 'gpt-6-luna' } })));
  assert.equal(tasks.get('C').codexModel, undefined);
  await board.openTaskEditModal('A');
  // happy-dom ignores a nested `selected` attribute when it computes .value, so read the markup.
  assert.equal(modal().querySelector('.modal-agent-model-select option[selected]')?.value, 'gpt-6-luna', 'the Task Edit modal reads the model back');
  board.closeTaskEditModal(true);

  // The Codex default: never gpt-5.5, which the registry no longer lists, even when a stale
  // CODEX_MODEL names it; a CODEX_MODEL the registry lists is the default.
  for (const [codexDefault, expected] of [['', 'gpt-6.1-sol'], ['gpt-5.5', 'gpt-6.1-sol'], ['gpt-6-luna', 'gpt-6-luna']]) {
    stub.config = { ...stub.config, CODEX_MODEL: codexDefault };
    paint();
    writes.length = 0;
    select('A');
    pickAgent('codex');
    await settle();
    assert.equal(modelSelect().value, expected, `Codex default with CODEX_MODEL=${codexDefault || '(unset)'}`);
    $('.btn-bulk-apply').click();
    await until(() => bar.hidden, 'the bar to close');
    assert.deepEqual(writes, [{ id: 'A', patch: { agent_assignee: 'codex', codex_model: expected } }]);
  }

  // Pi saves its row; Claude its model beside Design mode.
  paint();
  writes.length = 0;
  select('B');
  pickAgent('pi');
  pickModel(piRows[1]);
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'the bar to close');
  assert.deepEqual(writes, [{ id: 'B', patch: { agent_assignee: 'pi', pi_model: piRows[1] } }]);
  paint();
  writes.length = 0;
  select('D');
  pickAgent('claude');
  await settle();
  assert.equal(modelSelect().value, 'claude-opus-5-5');
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'the bar to close');
  assert.deepEqual(writes, [{ id: 'D', patch: { agent_assignee: 'claude', claude_model: 'claude-opus-5-5', claude_design_mode: false } }]);

  // Reset drops the agent and its model pick.
  select('A');
  pickAgent('codex');
  pickModel('gpt-5.6-sol');
  $('.btn-bulk-reset').click();
  assert.equal(modelWrap().hidden, true);
  pickAgent('codex');
  assert.equal(modelSelect().value, 'gpt-6-luna', 'the pick was dropped; the project default is back');
  $('.btn-bulk-reset').click();
  board.clearBulkSelection();
  console.log('TPT9212_BULK_MODEL_PASS');

  // Both locales render every bar string from its own table — no raw keys, no English
  // fallback in Ukrainian.
  const expected = {
    en: { apply: 'Apply', reset: 'Reset', design: 'Design mode', agent: 'Change agent…' },
    uk: { apply: 'Застосувати', reset: 'Скинути', design: 'Режим дизайну', agent: 'Змінити агента…' },
  };
  const titles = {};
  for (const lang of ['en', 'uk']) {
    setLocale(lang);
    select('A');
    assert.equal($('.agent-picker-label').textContent, expected[lang].agent);
    pickAgent('claude');
    assert.equal($('.btn-bulk-apply').textContent, expected[lang].apply);
    assert.equal($('.btn-bulk-reset').textContent, expected[lang].reset);
    assert.equal($('.bulk-design-mode-text').textContent, expected[lang].design);
    titles[lang] = [$('.btn-bulk-apply'), $('.btn-bulk-reset'), designMode(), $('.btn-bulk-start')].map(el => el.title);
    for (const title of titles[lang]) assert.ok(title, `${lang}: every bar control has a title`);
    assert.doesNotMatch(bar.outerHTML, /\bbulk\.[a-zA-Z]/, `${lang}: no untranslated bulk.* key`);
    if (lang === 'uk') {
      for (const [key, en] of Object.entries(expected.en)) assert.notEqual(expected.uk[key], en, `uk ${key} is translated`);
      titles.uk.forEach((title, i) => assert.notEqual(title, titles.en[i], `uk title ${i} is not the English fallback`));
    }
    $('.btn-bulk-reset').click();
    board.clearBulkSelection();
  }
  setLocale('en');
  console.log('TPT9159_BULK_LOCALES_PASS');

  const cowboyLabels = {
    en: ['Change Cowboy mode…', 'Disabled', 'Related Tasks Only', 'Whole Project'],
    uk: ['Змінити ковбойський режим…', 'Вимкнено', 'Лише пов’язані завдання', 'Увесь проєкт'],
    zh: ['更改牛仔模式…', '已禁用', '仅关联任务', '整个项目'],
    es: ['Cambiar modo vaquero…', 'Desactivado', 'Solo tareas relacionadas', 'Todo el proyecto'],
  };
  const hints = new Set();
  for (const [lang, labels] of Object.entries(cowboyLabels)) {
    setLocale(lang);
    select('A');
    assert.deepEqual([...$('.bulk-cowboy-select').options].map(option => option.textContent), labels);
    assert.deepEqual([...$('.bulk-cowboy-select').options].map(option => option.value), ['', 'disabled', 'related', 'project']);
    hints.add($('.bulk-cowboy-select').title);
    assert.equal($('#bulk-cowboy-hint').textContent, $('.bulk-cowboy-select').title);
    pickCowboy('related');
    board.updateBulkActionBar();
    assert.equal($('.bulk-cowboy-select').value, 'related');
    assert.doesNotMatch(bar.outerHTML, /(?:bulk|cowboyMode|field)\.[a-zA-Z]/);
    board.clearBulkSelection();
  }
  assert.equal(hints.size, 4, 'each locale has its own hint');
  setLocale('en');
  console.log('TPT9209_BULK_COWBOY_LOCALES_PASS');

  // (TPT9212) The Model label and hint follow the project language.
  const modelLabels = { en: 'Model', uk: 'Модель', zh: '模型', es: 'Modelo' };
  const modelHints = new Set();
  for (const [lang, label] of Object.entries(modelLabels)) {
    setLocale(lang);
    select('A');
    pickAgent('codex');
    assert.equal($('.bulk-model-text').textContent, label, `${lang}: Model label`);
    const hint = $('.bulk-model-select').title;
    assert.ok(hint, `${lang}: the Model select has a hint`);
    assert.equal($('#bulk-model-hint').textContent, hint, `${lang}: the hint is also its accessible description`);
    modelHints.add(hint);
    assert.doesNotMatch(bar.outerHTML, /\bbulk\.[a-zA-Z]/, `${lang}: no untranslated bulk.* key`);
    $('.btn-bulk-reset').click();
    board.clearBulkSelection();
  }
  assert.equal(modelHints.size, 4, 'each locale has its own Model hint');
  setLocale('en');
  console.log('TPT9212_BULK_MODEL_LOCALES_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await window.happyDOM.abort();
  rmSync(temporary, { recursive: true, force: true });
  process.exit(exitCode);
}
