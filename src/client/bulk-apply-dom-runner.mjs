// (TPT9159) Drives the real bulk action bar in a DOM process isolated from node:test globals:
// fields stage edits, Apply writes them in one pass, Reset/Clear drop them, Design mode shows
// only beside a staged Claude, and the Task Edit modal reads the applied Design mode back.
// (TPT9212) The Model select beside the agent picker offers each agent's available models,
// resets on an agent change, and Apply saves the shown model with the agent.
// (TPT9322) Permission mode is offered for any selection; Cowboy-Coding mode shows only while
// Bypass is staged, and Apply saves the scope with that Bypass.
// (TPT9323) The agent picker is a 2-in-1 Agent + Effort menu: Claude Code and Codex rows open an
// Effort flyout to the right, by pointer or keyboard, one pick stages both, and Apply saves both.
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
    if (patch.effort !== undefined) row.effort = patch.effort;
    if (patch.claude_design_mode !== undefined) row.claudeDesignMode = patch.claude_design_mode;
    if (patch.agent_permission_mode !== undefined) row.agentPermissionMode = patch.agent_permission_mode;
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
  let repaintOnApply = false;
  board.initBulkActionBar(async (opts) => { renders.push(opts); if (repaintOnApply) paint(); }, {
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
  const pickPermissionMode = (mode) => {
    $('.bulk-permission-mode-select').value = mode === null ? '__project_default__' : mode;
    $('.bulk-permission-mode-select').dispatchEvent(new Event('change', { bubbles: true }));
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
  const permissionField = () => $('.bulk-permission-mode-select').closest('[data-bulk-field]');
  const cowboyField = () => $('.bulk-cowboy-select').closest('[data-bulk-field]');
  const disabledCowboyOptions = () => [...$('.bulk-cowboy-select').options].filter(option => option.disabled).map(option => option.value);

  // At rest: nothing staged, Apply off, Reset and Design mode hidden, Start/Deps usable, and
  // Cowboy waiting for a staged Bypass.
  select('A', 'B', 'C', 'D');
  assert.equal(bar.hidden, false);
  assert.equal($('.btn-bulk-apply').disabled, true);
  assert.equal($('.btn-bulk-reset').hidden, true);
  assert.equal(designMode().hidden, true);
  assert.equal($('.btn-bulk-start').getAttribute('aria-disabled'), null);
  assert.equal($('.agent-picker-label').textContent, 'Change agent…');
  assert.equal($('.bulk-cowboy-select').value, '');
  assert.equal(permissionField().hidden, false);
  assert.equal(cowboyField().hidden, true);

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
  pickPermissionMode('bypass');
  assert.equal(cowboyField().hidden, false, 'a staged Bypass brings up Cowboy');
  pickCowboy('related');
  assert.equal(writes.length, 0, 'staging writes nothing');
  assert.equal(renders.length, 0);
  assert.deepEqual(staged(), ['priority', 'status', 'agent', 'assignee', 'permissionMode', 'cowboyScope']);
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
  assert.equal($('.bulk-permission-mode-select').value, 'bypass');
  assert.equal($('.bulk-cowboy-select').value, 'related');
  assert.equal(cowboyField().hidden, false);

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
  const full = { priority: 4, status: 'on_fire', assignee: 7, agent_assignee: 'claude', claude_model: 'opusplan', claude_design_mode: true, agent_permission_mode: 'bypass', cowboy_mode: 'related' };
  assert.deepEqual(writes, [
    { id: 'A', patch: full },
    { id: 'B', patch: full },
    { id: 'C', patch: { priority: 4, status: 'on_fire', assignee: 7, agent_permission_mode: 'bypass', cowboy_mode: 'related' } },
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
  pickPermissionMode('bypass');
  pickCowboy('project');
  $('.btn-bulk-apply').click();
  await until(() => document.querySelector('.tt-toast--error'), 'the failure toast');
  assert.match(document.querySelector('.tt-toast--error').textContent, /Failed to save changes for: A, B/);
  assert.equal(bar.hidden, false);
  assert.equal($('.bulk-status-select').value, 'completed');
  assert.equal($('.bulk-permission-mode-select').value, 'bypass');
  assert.equal($('.bulk-cowboy-select').value, 'project');
  assert.equal($('.btn-bulk-apply').disabled, false);
  for (const toast of document.querySelectorAll('.tt-toast--error')) toast.remove();
  api.tasks.update = async (id, patch) => {
    if (id === 'B') throw new Error('rejected');
    return recordingUpdate(id, patch);
  };
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'the bar to close');
  assert.deepEqual(writes, [{ id: 'A', patch: { status: 'completed', agent_permission_mode: 'bypass', cowboy_mode: 'project' } }]);
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
  pickPermissionMode('bypass');
  pickCowboy('project');
  $('.btn-bulk-reset').click();
  assert.equal(bar.hidden, false);
  assert.equal(state.selectedCardIds.size, 2);
  assert.deepEqual(staged(), []);
  assert.equal($('.bulk-status-select').value, '');
  assert.equal($('.bulk-permission-mode-select').value, '');
  assert.equal($('.bulk-cowboy-select').value, '');
  assert.equal(cowboyField().hidden, true, 'Reset drops the Bypass that showed Cowboy');
  assert.equal($('.agent-picker-label').textContent, 'Change agent…');
  assert.equal(designMode().hidden, true);
  assert.equal($('.btn-bulk-apply').disabled, true);
  assert.equal($('.btn-bulk-start').getAttribute('aria-disabled'), null);

  // Closing the bar (Clear) discards: nothing written, nothing staged on reopen.
  pickStatus('completed');
  pickMember('Dana');
  pickPermissionMode('bypass');
  pickCowboy('related');
  $('.bulk-clear').click();
  assert.equal(bar.hidden, true);
  select('A');
  assert.equal($('.bulk-status-select').value, '');
  assert.equal($('.bulk-assignee-input').value, '');
  assert.equal($('.bulk-permission-mode-select').value, '');
  assert.equal($('.bulk-cowboy-select').value, '');
  assert.equal(cowboyField().hidden, true);
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

  // (TPT9322) Permission mode stays shown and enabled for any selection: agent-locked (in
  // progress, canceled), Human, or mixed. Cowboy waits for a staged Bypass.
  tasks.get('F').agentAssignee = 'human';
  paint();
  for (const ids of [['C'], ['G'], ['F'], ['A', 'C', 'F', 'G']]) {
    select(...ids);
    assert.equal(permissionField().hidden, false, `${ids}: Permission mode shown`);
    assert.equal($('.bulk-permission-mode-select').disabled, false, `${ids}: Permission mode enabled`);
    assert.equal(cowboyField().hidden, true, `${ids}: no Cowboy before Bypass`);
  }
  tasks.get('F').agentAssignee = 'codex';
  paint();

  // Locked tasks take Bypass and the scope like any other: no agent change, so no confirm.
  writes.length = 0;
  select('C', 'G');
  pickPermissionMode('bypass');
  pickCowboy('project');
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'locked tasks to take Bypass and Cowboy');
  assert.deepEqual(writes, ['C', 'G'].map(id => ({ id, patch: { agent_permission_mode: 'bypass', cowboy_mode: 'project' } })));

  // Whatever the project default or the saved overrides, only a staged Bypass brings up Cowboy,
  // and beside it every scope is offered.
  tasks.get('A').agentPermissionMode = 'plan';
  tasks.get('B').agentPermissionMode = null;
  for (const projectDefault of ['bypass', 'auto', 'plan']) {
    setProjectPermissionMode(projectDefault);
    paint();
    select('A', 'B');
    assert.equal(cowboyField().hidden, true, `${projectDefault} default: Cowboy waits for a staged Bypass`);
    pickPermissionMode(null);
    assert.equal(cowboyField().hidden, true, `${projectDefault} default: Project Default is no staged Bypass`);
    pickPermissionMode('bypass');
    assert.equal(cowboyField().hidden, false, `${projectDefault} default: a staged Bypass brings up Cowboy`);
    assert.deepEqual(disabledCowboyOptions(), [], `${projectDefault} default: every scope is offered`);
    $('.btn-bulk-reset').click();
    assert.equal(cowboyField().hidden, true);
  }
  setProjectPermissionMode('bypass');

  // Plan, Auto, Project Default or the no-change placeholder drop a staged scope and hide
  // Cowboy; picking Bypass again starts it on its placeholder.
  for (const mode of ['plan', 'auto', null, '']) {
    const label = mode === null ? 'Project Default' : (mode || 'the placeholder');
    select('A', 'B');
    pickPermissionMode('bypass');
    pickCowboy('project');
    assert.deepEqual(staged(), ['permissionMode', 'cowboyScope']);
    pickPermissionMode(mode);
    assert.equal(cowboyField().hidden, true, `${label} hides Cowboy`);
    assert.equal($('.bulk-cowboy-select').value, '', `${label} drops the scope`);
    assert.deepEqual(staged(), mode === '' ? [] : ['permissionMode']);
    pickPermissionMode('bypass');
    assert.equal(cowboyField().hidden, false);
    assert.equal($('.bulk-cowboy-select').value, '', `${label}: Bypass again starts on the placeholder`);
    assert.deepEqual(staged(), ['permissionMode']);
    $('.btn-bulk-reset').click();
  }

  // A change event on the hidden select stages nothing without a staged Bypass.
  select('A');
  pickCowboy('related');
  assert.deepEqual(staged(), []);
  assert.equal($('.bulk-cowboy-select').value, '');
  assert.equal($('.btn-bulk-apply').disabled, true);

  // One .bulk-field-pair holds both, Cowboy right after Permission mode, so they wrap together;
  // the Permission mode hint names Bypass as the way to Cowboy.
  const pair = permissionField().parentElement;
  assert.equal(pair.classList.contains('bulk-field-pair'), true);
  assert.equal(cowboyField().parentElement === pair, true);
  assert.equal(permissionField().nextElementSibling === cowboyField(), true);
  assert.equal($('.bulk-permission-mode-select').getAttribute('aria-describedby'), 'bulk-permission-mode-hint');
  assert.equal($('#bulk-permission-mode-hint').textContent, $('.bulk-permission-mode-select').title);
  assert.match($('.bulk-permission-mode-select').title, /Bypass.*Cowboy/);
  board.clearBulkSelection();
  tasks.get('A').agentPermissionMode = 'bypass';
  paint();
  console.log('TPT9322_BULK_COWBOY_ON_BYPASS_PASS');

  // Bypass staged over mixed saved modes writes Bypass and the scope to every selected task
  // with the other staged fields; nothing is refused.
  paint();
  writes.length = 0;
  for (const toast of document.querySelectorAll('.tt-toast--error')) toast.remove();
  tasks.get('A').agentPermissionMode = 'bypass';
  tasks.get('B').agentPermissionMode = 'auto';
  select('A', 'B');
  pickStatus('on_fire');
  pickPermissionMode('bypass');
  pickCowboy('project');
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'Cowboy with a staged Bypass to save');
  assert.deepEqual(writes, ['A', 'B'].map(id => ({ id, patch: { status: 'on_fire', agent_permission_mode: 'bypass', cowboy_mode: 'project' } })));
  assert.equal(document.querySelector('.tt-toast--error') === null, true, 'nothing refused');
  assert.equal(tasks.get('B').agentPermissionMode, 'bypass');

  // Disabled is an explicit write too, saved with the Bypass that shows it. The placeholder
  // removes only the scope.
  writes.length = 0;
  select('B');
  pickPermissionMode('bypass');
  pickCowboy('disabled');
  assert.equal($('.btn-bulk-apply').disabled, false);
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'Cowboy disabling to save');
  assert.deepEqual(writes, [{ id: 'B', patch: { agent_permission_mode: 'bypass', cowboy_mode: 'disabled' } }]);
  select('A');
  pickStatus('completed');
  pickPermissionMode('bypass');
  pickCowboy('related');
  pickCowboy('');
  assert.deepEqual(staged(), ['status', 'permissionMode']);
  $('.btn-bulk-reset').click();

  // A newer server snapshot may refuse Cowboy after a permission change: report it and
  // retain the selection for retry, even when PATCH itself resolves successfully.
  for (const toast of document.querySelectorAll('.tt-toast--error')) toast.remove();
  api.tasks.update = async (id, patch) => ({ ...await recordingUpdate(id, patch), cowboyMode: 'disabled' });
  pickPermissionMode('bypass');
  pickCowboy('related');
  $('.btn-bulk-apply').click();
  await until(() => document.querySelector('.tt-toast--error'), 'normalized-scope refusal');
  assert.match(document.querySelector('.tt-toast--error').textContent, /Failed to save changes for: A/);
  assert.equal(bar.hidden, false);
  assert.equal($('.bulk-permission-mode-select').value, 'bypass');
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

  // (TPT9323) The 2-in-1 Agent + Effort picker. The list stays vertical; Claude Code and Codex
  // rows open their Effort flyout to the right with the Task Edit modal's levels.
  stub.config = { CLAUDE_MODEL: 'claude-opus-5-5', CODEX_MODEL: '', TASK_AGENT: 'claude' };
  paint();
  writes.length = 0;
  for (const toast of document.querySelectorAll('.tt-toast--error')) toast.remove();
  const menu = () => document.querySelector('.agent-picker-dropdown[data-portaled]');
  const rowOf = (agent) => menu().querySelector(`.agent-picker-option[data-value="${agent}"]`);
  const flyoutOf = (agent) => rowOf(agent).querySelector('.agent-picker-submenu');
  const levelOf = (agent, effort) => flyoutOf(agent).querySelector(`.agent-picker-effort[data-effort="${effort}"]`);
  const hover = (el) => el.dispatchEvent(new MouseEvent('mouseenter'));
  const press = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const trigger = () => $('.agent-picker-trigger');
  const effortTag = () => $('.agent-picker-effort-tag');
  const openMenu = () => { if (!menu()) trigger().click(); };
  const closeMenu = () => { if (menu()) trigger().click(); };
  const pickEffort = (agent, effort) => {
    openMenu();
    hover(rowOf(agent));
    levelOf(agent, effort).click();
  };
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const levelValues = ['', 'low', 'medium', 'high', 'max'];

  select('A', 'B', 'C', 'D');
  assert.equal(trigger().getAttribute('aria-haspopup'), 'menu');
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  assert.equal(trigger().getAttribute('aria-labelledby'), 'bulk-agent-label bulk-agent-trigger', 'named Agent plus what it shows');
  assert.equal(trigger().id, 'bulk-agent-trigger');
  assert.equal(trigger().getAttribute('aria-describedby'), 'bulk-agent-hint');
  assert.match($('#bulk-agent-hint').textContent, /Claude Code and Codex.*effort/);
  assert.match(trigger().title, /effort levels to the right/);
  assert.equal(effortTag() === null, true, 'nothing staged, no effort in the trigger');
  openMenu();
  assert.equal(trigger().getAttribute('aria-expanded'), 'true');
  assert.equal(menu().getAttribute('role'), 'menu');
  const rows = [...menu().children].filter(el => el.classList.contains('agent-picker-option'));
  assert.deepEqual(rows.map(el => el.dataset.value), ['', 'human', 'claude', 'codex', 'pi'], 'one vertical agent list, as before');
  for (const el of rows) {
    const hasFlyout = el.dataset.value === 'claude' || el.dataset.value === 'codex';
    assert.equal(el.getAttribute('role'), 'menuitem');
    assert.equal(el.getAttribute('tabindex'), '-1');
    assert.equal(!!el.querySelector('.agent-picker-submenu'), hasFlyout, `${el.dataset.value || 'placeholder'}: flyout only beside Claude and Codex`);
    assert.equal(el.getAttribute('aria-haspopup'), hasFlyout ? 'menu' : null);
    assert.equal(!!el.querySelector('.agent-picker-flyout-caret'), hasFlyout, 'a chevron marks the flyout');
  }
  for (const agent of ['claude', 'codex']) {
    assert.equal(flyoutOf(agent).hidden, true, `${agent}: closed until reached`);
    assert.equal(flyoutOf(agent).getAttribute('role'), 'menu');
    assert.equal(flyoutOf(agent).getAttribute('aria-label'), 'Effort');
    assert.equal(flyoutOf(agent).querySelector('.agent-picker-submenu-heading').textContent, 'Effort');
    const items = [...flyoutOf(agent).querySelectorAll('.agent-picker-effort')];
    assert.deepEqual(items.map(el => el.dataset.effort), levelValues, 'Agent default plus the Task Edit modal levels');
    assert.deepEqual(items.map(el => el.textContent), ['Agent default', 'Low', 'Medium', 'High', 'Max']);
    assert.deepEqual(items.map(el => [el.getAttribute('role'), el.getAttribute('aria-checked')]), levelValues.map(() => ['menuitemradio', 'false']));
  }

  // Pointer: hovering a row opens its flyout at once; another row switches only after a pause,
  // and reaching the open flyout first keeps it.
  hover(rowOf('claude'));
  assert.equal(flyoutOf('claude').hidden, false);
  assert.equal(rowOf('claude').getAttribute('aria-expanded'), 'true');
  assert.equal(rowOf('claude').classList.contains('is-open'), true);
  hover(rowOf('codex'));
  await wait(60);
  assert.equal(flyoutOf('claude').hidden, false, 'a diagonal path over Codex keeps the Claude flyout');
  assert.equal(flyoutOf('codex').hidden, true);
  hover(flyoutOf('claude'));
  await wait(220);
  assert.equal(flyoutOf('claude').hidden, false, 'reaching the open flyout cancels the switch');
  assert.equal(flyoutOf('codex').hidden, true);
  hover(rowOf('codex'));
  await wait(220);
  assert.equal(flyoutOf('codex').hidden, false, 'resting on Codex switches');
  assert.equal(flyoutOf('claude').hidden, true);
  assert.equal(rowOf('claude').getAttribute('aria-expanded'), 'false');
  hover(rowOf('pi'));
  await wait(220);
  assert.equal(flyoutOf('codex').hidden, true, 'a row without one closes the flyout');
  // A click on the caption picks nothing; a click on a chevron opens that flyout without
  // picking the agent (the way in without hovering).
  hover(rowOf('claude'));
  flyoutOf('claude').querySelector('.agent-picker-submenu-heading').click();
  assert.ok(menu(), 'the caption leaves the menu open');
  assert.deepEqual(staged(), []);
  rowOf('codex').querySelector('.agent-picker-flyout-caret').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.ok(menu(), 'the chevron leaves the menu open');
  assert.equal(flyoutOf('codex').hidden, false, 'and opens its flyout at once');
  assert.equal(flyoutOf('claude').hidden, true);
  assert.deepEqual(staged(), []);
  hover(rowOf('claude'));
  await wait(220);

  // One pick stages agent and effort; the trigger shows both and nothing is written yet.
  levelOf('claude', 'high').click();
  assert.equal(menu() === null, true, 'the pick closes the menu');
  assert.deepEqual(staged(), ['agent']);
  assert.equal($('.agent-picker-label').textContent, 'Claude Code');
  assert.equal(effortTag().textContent, 'High');
  assert.equal(effortTag().title, 'Effort: High');
  assert.ok(effortTag().classList.contains('agent-picker-effort-tag--high'));
  assert.equal(designMode().hidden, false, 'Design mode still follows a staged Claude');
  await settle();
  assert.equal(modelSelect().value, 'claude-opus-5-5', 'the Model select still follows the agent');
  assert.equal(writes.length, 0);
  openMenu();
  assert.equal(rowOf('claude').getAttribute('aria-current'), 'true');
  assert.equal(levelOf('claude', 'high').getAttribute('aria-checked'), 'true');
  assert.ok(levelOf('claude', 'high').querySelector('.agent-picker-effort-check'), 'the staged level is checked');
  assert.equal(flyoutOf('codex').querySelectorAll('[aria-checked="true"]').length, 0, 'nothing checked beside another agent');
  closeMenu();
  board.updateBulkActionBar();
  assert.equal($('.agent-picker-label').textContent, 'Claude Code', 'both survive a board refresh');
  assert.equal(effortTag().textContent, 'High');

  // The bare row keeps the same agent's level; another agent or Human drops it.
  pickAgent('claude');
  assert.equal(effortTag()?.textContent, 'High', 'picking the Claude row again keeps the effort');
  pickEffort('claude', 'max');
  assert.equal(effortTag().textContent, 'Max', 'a new level replaces the old one');
  pickAgent('codex');
  assert.equal(effortTag() === null, true, 'Codex drops the Claude effort');
  pickEffort('claude', 'low');
  pickAgent('human');
  assert.equal(effortTag() === null, true);
  assert.equal(modelWrap().hidden, true);
  pickAgent('pi');
  assert.equal(effortTag() === null, true, 'Pi has no effort');

  // Keyboard: ArrowDown on the trigger opens on the staged row, ArrowRight opens a flyout on its
  // checked level (else the first), Enter picks both, focus comes back to the trigger, and no key
  // reaches the board's own document listeners.
  let leaked = 0;
  const countLeak = () => { leaked += 1; };
  document.addEventListener('keydown', countLeak);
  pickAgent('codex');
  trigger().focus();
  press(trigger(), 'ArrowDown');
  assert.ok(menu(), 'ArrowDown opens the menu');
  assert.equal(document.activeElement === rowOf('codex'), true, 'focus starts on the staged agent');
  press(document.activeElement, 'ArrowUp');
  assert.equal(document.activeElement === rowOf('claude'), true);
  press(document.activeElement, 'ArrowRight');
  assert.equal(flyoutOf('claude').hidden, false);
  assert.equal(document.activeElement === levelOf('claude', ''), true, 'nothing checked: the first level');
  press(document.activeElement, 'End');
  assert.equal(document.activeElement === levelOf('claude', 'max'), true);
  press(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement === levelOf('claude', ''), true, 'the levels wrap');
  press(document.activeElement, 'ArrowLeft');
  assert.equal(flyoutOf('claude').hidden, true, 'ArrowLeft goes back to the row');
  assert.equal(document.activeElement === rowOf('claude'), true);
  press(document.activeElement, 'ArrowRight');
  press(document.activeElement, 'ArrowDown');
  press(document.activeElement, 'ArrowDown');
  press(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement === levelOf('claude', 'high'), true);
  press(document.activeElement, 'Enter');
  assert.equal(menu() === null, true);
  assert.equal(document.activeElement === trigger(), true, 'focus is back on the (re-rendered) trigger');
  assert.equal($('.agent-picker-label').textContent, 'Claude Code');
  assert.equal(effortTag().textContent, 'High');
  // Reopened, ArrowRight lands on the checked level; Escape steps back out one level at a time.
  press(trigger(), 'ArrowDown');
  assert.equal(document.activeElement === rowOf('claude'), true);
  press(document.activeElement, 'ArrowRight');
  assert.equal(document.activeElement === levelOf('claude', 'high'), true, 'the checked level');
  press(document.activeElement, 'Escape');
  assert.ok(menu(), 'the first Escape closes the flyout only');
  assert.equal(flyoutOf('claude').hidden, true);
  assert.equal(document.activeElement === rowOf('claude'), true);
  press(document.activeElement, 'Home');
  assert.equal(document.activeElement === rowOf(''), true);
  press(document.activeElement, 'End');
  assert.equal(document.activeElement === rowOf('pi'), true);
  press(document.activeElement, 'ArrowRight');
  assert.equal(document.activeElement === rowOf('pi'), true, 'no flyout beside Pi');
  press(document.activeElement, 'Escape');
  assert.equal(menu() === null, true, 'the second Escape closes the menu');
  assert.equal(document.activeElement === trigger(), true);
  assert.equal(effortTag().textContent, 'High', 'Escape picks nothing');
  // Enter on a bare row picks its agent alone; a Codex level picked by keyboard replaces both.
  press(trigger(), 'ArrowDown');
  press(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement === rowOf('codex'), true);
  press(document.activeElement, 'ArrowRight');
  press(document.activeElement, 'ArrowUp');
  assert.equal(document.activeElement === levelOf('codex', 'max'), true, 'ArrowUp from the first level wraps to Max');
  press(document.activeElement, ' ');
  assert.equal($('.agent-picker-label').textContent, 'Codex');
  assert.equal(effortTag().textContent, 'Max', 'Space picks like Enter');
  // A board refresh (every loadAndRender()) leaves the open menu and its keyboard focus alone.
  press(trigger(), 'ArrowDown');
  press(document.activeElement, 'ArrowRight');
  assert.equal(document.activeElement === levelOf('codex', 'max'), true);
  const openPicker = $('.agent-picker');
  board.updateBulkActionBar();
  assert.equal($('.agent-picker') === openPicker, true, 'the open picker is not re-rendered');
  assert.equal(document.activeElement === levelOf('codex', 'max'), true, 'focus stays on the level');
  press(document.activeElement, 'ArrowUp');
  press(document.activeElement, 'Enter');
  assert.equal(document.activeElement === trigger(), true);
  assert.equal(effortTag().textContent, 'High');
  board.updateBulkActionBar();
  assert.equal($('.agent-picker') === openPicker, false, 'a closed picker refreshes again');
  assert.equal(effortTag().textContent, 'High');
  press(trigger(), 'ArrowUp');
  assert.equal(document.activeElement === rowOf('pi'), true, 'ArrowUp opens on the last row');
  press(document.activeElement, 'Tab');
  assert.equal(menu() === null, true, 'Tab closes the menu');
  assert.equal(document.activeElement === trigger(), true, 'and leaves from the trigger');
  assert.equal(leaked, 1, 'only Tab travels on past the menu');
  document.removeEventListener('keydown', countLeak);
  assert.deepEqual(staged(), ['agent']);
  assert.equal(writes.length, 0);

  // Apply saves agent, model and effort on every selected task that takes the agent; the locked
  // task keeps all three.
  pickEffort('codex', 'high');
  await settle();
  assert.equal(modelSelect().value, 'gpt-6.1-sol');
  $('.btn-bulk-apply').click();
  await until(() => document.querySelector('.modal-overlay--over-board .btn-confirm'), 'the locked-task confirm');
  document.querySelector('.modal-overlay--over-board .btn-confirm').click();
  await until(() => bar.hidden, 'the bar to close');
  assert.deepEqual(writes, ['A', 'B', 'D'].map(id => ({ id, patch: { agent_assignee: 'codex', codex_model: 'gpt-6.1-sol', effort: 'high' } })));
  assert.equal(tasks.get('C').effort, undefined, 'the locked task keeps its effort');
  await board.openTaskEditModal('A');
  assert.equal(modal().querySelector('.modal-effort-row').hidden, false);
  assert.equal(modal().querySelector('.modal-effort-select option[selected]')?.value, 'high', 'the Task Edit modal reads the effort back');
  board.closeTaskEditModal(true);

  // Agent default is an explicit write: it clears every task's saved level.
  paint();
  writes.length = 0;
  select('A', 'D');
  pickEffort('claude', '');
  assert.equal(effortTag().textContent, 'Agent default');
  assert.ok(effortTag().classList.contains('agent-picker-effort-tag--default'));
  await settle();
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'the bar to close');
  assert.deepEqual(writes, ['A', 'D'].map(id => ({ id, patch: { agent_assignee: 'claude', claude_model: 'claude-opus-5-5', claude_design_mode: false, effort: null } })));
  assert.equal(tasks.get('A').effort, null);

  // A bare agent pick writes no effort; Reset drops a staged one.
  paint();
  writes.length = 0;
  select('B');
  pickAgent('codex');
  await settle();
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'the bar to close');
  assert.deepEqual(writes, [{ id: 'B', patch: { agent_assignee: 'codex', codex_model: 'gpt-6.1-sol' } }], 'no effort: the task keeps its own');
  assert.equal(tasks.get('B').effort, 'high');
  select('A');
  pickEffort('codex', 'max');
  $('.btn-bulk-reset').click();
  assert.equal(effortTag() === null, true);
  assert.equal($('.agent-picker-label').textContent, 'Change agent…');
  assert.deepEqual(staged(), []);
  pickAgent('codex');
  assert.equal(effortTag() === null, true, 'Reset dropped the effort with the agent');
  $('.btn-bulk-reset').click();
  board.clearBulkSelection();
  console.log('TPT9323_BULK_AGENT_EFFORT_PASS');

  // The flyout caption, levels, trigger tag and hint follow the project language.
  const effortLabels = {
    en: ['Effort', ['Agent default', 'Low', 'Medium', 'High', 'Max']],
    uk: ['Рівень міркування', ['Типове для агента', 'Низький', 'Середній', 'Високий', 'Максимальний']],
    zh: ['推理强度', ['智能体默认值', '低', '中', '高', '最高']],
    es: ['Nivel de razonamiento', ['Predeterminado del agente', 'Bajo', 'Medio', 'Alto', 'Máximo']],
  };
  const agentHints = new Set();
  for (const [lang, [heading, labels]] of Object.entries(effortLabels)) {
    setLocale(lang);
    select('A');
    openMenu();
    for (const agent of ['claude', 'codex']) {
      assert.equal(flyoutOf(agent).querySelector('.agent-picker-submenu-heading').textContent, heading, `${lang}: caption`);
      assert.equal(flyoutOf(agent).getAttribute('aria-label'), heading);
      assert.deepEqual([...flyoutOf(agent).querySelectorAll('.agent-picker-effort')].map(el => el.textContent), labels, `${lang}: levels`);
    }
    assert.doesNotMatch(menu().outerHTML, /\b(?:bulk|effort|field|badge)\.[a-zA-Z]/, `${lang}: no raw keys in the menu`);
    hover(rowOf('claude'));
    levelOf('claude', 'high').click();
    assert.equal(effortTag().textContent, labels[3], `${lang}: the trigger names the level`);
    assert.ok(effortTag().title.includes(labels[3]));
    const hint = $('#bulk-agent-hint').textContent;
    assert.ok(trigger().title.includes(hint), `${lang}: the hint is the trigger's title`);
    agentHints.add(hint);
    assert.doesNotMatch(bar.outerHTML, /\b(?:bulk|effort|field|badge)\.[a-zA-Z]/, `${lang}: no raw keys in the bar`);
    $('.btn-bulk-reset').click();
    board.clearBulkSelection();
  }
  assert.equal(agentHints.size, 4, 'each locale has its own agent hint');
  setLocale('en');
  console.log('TPT9323_BULK_AGENT_EFFORT_LOCALES_PASS');

  // Permission mode and Cowboy can be applied together; the repaint must use fresh data so
  // every shield changes without a page reload, including an agent-locked task's shield.
  repaintOnApply = true;
  setProjectPermissionMode('auto');
  tasks.get('A').agentPermissionMode = 'plan';
  tasks.get('B').agentPermissionMode = 'auto';
  tasks.get('C').agentPermissionMode = 'bypass';
  paint();
  writes.length = 0;
  select('A', 'B', 'C');
  assert.equal($('.bulk-permission-mode-select').value, '', 'untouched means no change');
  assert.equal($('.bulk-permission-mode-text').getAttribute('for'), 'bulk-permission-mode-select');
  assert.equal(cowboyField().hidden, true, 'a saved Bypass (C) is not a staged one');
  pickPermissionMode('bypass');
  assert.equal(cowboyField().hidden, false, 'staged Bypass brings up Cowboy');
  assert.deepEqual(disabledCowboyOptions(), [], 'with every scope offered');
  pickCowboy('related');
  board.updateBulkActionBar();
  assert.equal($('.bulk-permission-mode-select').value, 'bypass', 'staged mode survives bar refresh');
  assert.equal($('.bulk-cowboy-select').value, 'related', 'so does the scope beside it');
  assert.equal(cowboyField().hidden, false);
  assert.deepEqual(staged(), ['permissionMode', 'cowboyScope']);
  assert.equal(writes.length, 0);
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'permission mode plus Cowboy to save');
  assert.deepEqual(writes, ['A', 'B', 'C'].map(id => ({ id, patch: { agent_permission_mode: 'bypass', cowboy_mode: 'related' } })));
  assert.deepEqual(renders.at(-1), { forceFresh: true });
  const shield = id => document.querySelector(`.card[data-id="${id}"] .card-permission-btn`);
  for (const id of ['A', 'B', 'C']) {
    assert.equal(shield(id).dataset.permissionMode, 'bypass');
    assert.ok(shield(id).querySelector('.permission-mode-icon--bypass'));
  }

  // Project Default is a distinct staged clear, not the no-change placeholder. Its effective
  // mode drives the resulting inherited shield; even a Bypass default brings up no Cowboy.
  setProjectPermissionMode('bypass');
  tasks.get('A').agentPermissionMode = 'plan';
  paint();
  writes.length = 0;
  select('A', 'B');
  pickPermissionMode(null);
  assert.equal(cowboyField().hidden, true);
  board.updateBulkActionBar();
  assert.equal($('.bulk-permission-mode-select').value, '__project_default__');
  assert.deepEqual(staged(), ['permissionMode']);
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'Project Default to clear the overrides');
  assert.deepEqual(writes, ['A', 'B'].map(id => ({ id, patch: { agent_permission_mode: null } })));
  for (const id of ['A', 'B']) {
    assert.equal(tasks.get(id).agentPermissionMode, null);
    assert.equal(shield(id).dataset.permissionMode, '');
    assert.equal(shield(id).classList.contains('card-permission-btn--override'), false);
    assert.match(shield(id).getAttribute('aria-label'), /Project Default.*Bypass/);
  }

  // (TPT9322) Moving off Bypass drops the staged scope with the field, so a Plan or Auto batch
  // saves the permission override alone: nothing to refuse, no cowboy_mode in the PATCH.
  for (const mode of ['plan', 'auto']) {
    writes.length = 0;
    for (const toast of document.querySelectorAll('.tt-toast--error')) toast.remove();
    select('A', 'B');
    pickPermissionMode('bypass');
    pickCowboy('project');
    pickPermissionMode(mode);
    assert.equal(cowboyField().hidden, true, `${mode} hides Cowboy`);
    assert.equal($('.bulk-cowboy-select').value, '');
    assert.deepEqual(staged(), ['permissionMode'], `${mode} drops the staged scope`);
    $('.btn-bulk-apply').click();
    await until(() => bar.hidden, `${mode} permissions to save`);
    assert.deepEqual(writes, ['A', 'B'].map(id => ({ id, patch: { agent_permission_mode: mode } })));
    assert.equal(document.querySelector('.tt-toast--error') === null, true, `${mode}: nothing refused`);
    assert.ok(shield('A').querySelector(`.permission-mode-icon--${mode}`));
  }
  select('A');
  pickPermissionMode(null);
  pickPermissionMode('');
  assert.deepEqual(staged(), []);
  assert.equal($('.btn-bulk-apply').disabled, true);
  pickPermissionMode('bypass');
  pickCowboy('related');
  $('.btn-bulk-reset').click();
  assert.equal($('.bulk-permission-mode-select').value, '');
  assert.equal(cowboyField().hidden, true);
  pickPermissionMode(null);
  $('.bulk-clear').click();
  select('A');
  assert.equal($('.bulk-permission-mode-select').value, '');
  assert.equal($('.btn-bulk-apply').disabled, true);
  board.clearBulkSelection();
  repaintOnApply = false;
  tasks.get('A').agentPermissionMode = 'bypass';
  paint();
  console.log('TPT9308_BULK_PERMISSION_MODE_PASS');

  const permissionLabels = {
    en: ['Permission mode', 'Change permission mode…', 'Project Default (Auto mode)', 'Plan mode', 'Auto mode', 'Bypass'],
    uk: ['Режим дозволів', 'Змінити режим дозволів…', 'Типовий для проєкту (Автоматичний режим)', 'Режим планування', 'Автоматичний режим', 'Без підтверджень'],
    zh: ['权限模式', '更改权限模式…', '项目默认值（自动模式）', '计划模式', '自动模式', '免确认模式'],
    es: ['Modo de permisos', 'Cambiar modo de permisos…', 'Predeterminado del proyecto (Modo automático)', 'Modo de planificación', 'Modo automático', 'Sin confirmación'],
  };
  const permissionHints = new Set();
  setProjectPermissionMode('auto');
  for (const [lang, [label, ...options]] of Object.entries(permissionLabels)) {
    setLocale(lang);
    select('A');
    assert.equal($('.bulk-permission-mode-text').textContent, label);
    assert.deepEqual([...$('.bulk-permission-mode-select').options].map(option => option.textContent), options);
    assert.deepEqual([...$('.bulk-permission-mode-select').options].map(option => option.value), ['', '__project_default__', 'plan', 'auto', 'bypass']);
    // (TPT9322) The hint is the select's title and its accessible description.
    const hint = $('.bulk-permission-mode-select').title;
    assert.ok(hint.includes(options.at(-1)), `${lang}: the hint names Bypass`);
    assert.equal($('#bulk-permission-mode-hint').textContent, hint);
    permissionHints.add(hint);
    pickPermissionMode('bypass');
    assert.equal(cowboyField().hidden, false, `${lang}: Bypass brings up Cowboy`);
    assert.doesNotMatch(bar.outerHTML, /(?:bulk|permissionMode|field)\.[a-zA-Z]/, `${lang}: no raw keys`);
    board.clearBulkSelection();
  }
  assert.equal(permissionHints.size, 4, 'each locale has its own Permission mode hint');
  setProjectPermissionMode('bypass');
  setLocale('en');
  console.log('TPT9308_BULK_PERMISSION_MODE_LOCALES_PASS');

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
    pickPermissionMode('bypass');
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
