import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { api } from './api-client.js';
import { t, setLocale } from './i18n.js';
import { loadGroupLabel, projectPermissionMode, setProjectPermissionMode, resetGroupLabel } from './group-label.js';
import { AGENT_PERMISSION_MODES, buildProjectModeOptions, effectivePermissionMode, permissionModeIcon, permissionModeTip, isAgentPermissionMode } from './permission-mode.js';
import { renderPermissionModeSelect, bindPermissionModeSelect } from './permission-mode-select.js';

const source = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
function productionFunction(name) {
  const match = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'));
  assert.ok(match, `${name} exists`);
  return match[0].replace(/^export /, '');
}
function harness(tc, initial = null) {
  const window = new Window();
  const document = window.document;
  const start = template.lastIndexOf('<div', template.indexOf('id="settings-modal"'));
  document.body.innerHTML = template.slice(start, template.indexOf('<script', start));
  // The settings modal is static markup; the session rail belongs to the rendered board.
  document.body.insertAdjacentHTML('beforeend', '<div id="active-sessions-list"></div><div id="active-sessions-divider"></div>');
  assert.ok(document.getElementById('settings-permission-mode-row'));
  const original = { settings: api.project.settings, update: api.project.update };
  let saved = initial;
  const calls = { settings: 0, writes: [], toasts: [] };
  api.project.settings = async () => { calls.settings++; return { agentPermissionMode: saved }; };
  api.project.update = async body => { calls.writes.push(body); saved = body.agent_permission_mode; };
  resetGroupLabel(); setLocale('en');
  const state = {
    activeSessions: new Set(['TPT9072']), lostSessions: new Map(), sessionMeta: new Map(),
    attentionSessions: new Set(), taskTitleById: new Map([['TPT9072', 'Task title']]),
    taskStatusById: new Map(), taskPermissionModeById: new Map(), taskAgent: 'codex',
  };
  const context = vm.createContext({
    window, document, state, api: { project: api.project, statuses: { list: async () => [] } },
    t, loadGroupLabel, projectPermissionMode, setProjectPermissionMode,
    buildProjectModeOptions, effectivePermissionMode, permissionModeIcon, permissionModeTip, isAgentPermissionMode,
    renderPermissionModeSelect, bindPermissionModeSelect,
    escapeAttr: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    showToast: (...args) => calls.toasts.push(args),
    syncAllPermissionButtons() {}, syncAttentionClasses() {}, syncActivityChips() {},
    getOpenWorkspaceTaskId: () => null, taskChatRows: () => [], projectChatRows: () => [],
    _sessionAgentIcon: () => '<svg class="agent-icon"></svg>', isCompleteName: () => false,
    ensureSessionTooltips() {}, resyncSessionTip() {},
    _populateSettingsWorkflowAddForm() {}, _populateSettingsGroupLabelRow() {},
    _populateSettingsSprintsRow() {}, _populateSettingsObjectiveGroupingRow() {},
    seedStatuses() {}, _renderWorkflowRows() {},
  });
  vm.runInContext('let _settingsPermissionControl = null; let _workflowStatuses = [];\n' + [
    '_populateSettingsPermissionModeRow', '_populateSettingsWorkflowTab', 'renderActiveSessionsList', 'syncActiveSessionsNav',
  ].map(productionFunction).join('\n'), context);
  tc.after(async () => {
    vm.runInContext('_settingsPermissionControl?.destroy()', context);
    Object.assign(api.project, original);
    resetGroupLabel(); setLocale('en');
    await window.happyDOM.abort();
  });
  const row = () => document.getElementById('settings-permission-mode-row');
  const choose = mode => {
    row().querySelector('button').click();
    // (TPT9084) The open listbox is portaled to <body>, outside the Settings row.
    document.querySelector(`.permission-mode-select-menu[data-portaled="1"] [role="option"][data-value="${mode}"]`).click();
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const shield = () => document.querySelector('.active-session-permission svg');
  return { context, state, calls, document, row, choose, settle, shield };
}

test('Workflow saves only project mode, refreshes hints/nav, survives reopen and cache reload', async tc => {
  const h = harness(tc);
  await h.context._populateSettingsWorkflowTab();
  assert.equal(h.calls.settings, 1);
  assert.equal(h.row().querySelectorAll('[role="option"]').length, AGENT_PERMISSION_MODES.length + 1);
  assert.match(h.row().textContent, /Agent permissions/);
  assert.match(h.row().querySelector('.settings-row-hint').textContent, /Until a mode is chosen/);
  assert.ok(h.shield().classList.contains('permission-mode-icon--inherited'));
  h.choose('plan');
  await h.settle();
  assert.equal(JSON.stringify(h.calls.writes), '[{"agent_permission_mode":"plan"}]');
  assert.equal(projectPermissionMode(), 'plan');
  assert.equal(h.row().querySelector('input').value, 'plan');
  assert.equal(h.document.activeElement, h.row().querySelector('button'), 'autosave preserves keyboard focus');
  assert.equal(h.row().querySelector('[data-value=""]'), null);
  assert.equal(h.row().querySelector('.settings-row-hint').textContent, t('permissionMode.hint.plan'));
  assert.ok(h.shield().classList.contains('permission-mode-icon--plan'));
  await h.context._populateSettingsWorkflowTab();
  assert.equal(h.row().querySelector('input').value, 'plan');
  resetGroupLabel(); // Equivalent to a new renderer's empty project cache.
  await loadGroupLabel();
  const count = h.calls.settings;
  h.context.syncActiveSessionsNav(); h.context.syncActiveSessionsNav();
  assert.equal(h.calls.settings, count, 'nav reads cached default synchronously');
  assert.ok(h.shield().classList.contains('permission-mode-icon--plan'));
  setLocale('uk'); await h.context._populateSettingsWorkflowTab();
  assert.equal(h.row().querySelector('label').textContent, 'Дозволи агента');
});

test('nav shields follow task overrides and project defaults, including collapsed rail and unset', async tc => {
  const h = harness(tc, 'auto');
  await h.context._populateSettingsWorkflowTab();
  for (const mode of AGENT_PERMISSION_MODES) {
    h.state.taskPermissionModeById.set('TPT9072', mode);
    h.context.syncActiveSessionsNav();
    assert.ok(h.shield().classList.contains(`permission-mode-icon--${mode}`));
    assert.equal(h.shield().parentElement.title, permissionModeTip({ agentPermissionMode: mode }, 'auto', t));
    assert.match(h.document.querySelector('.active-session-item').getAttribute('aria-label'), /Permission mode:/);
    assert.ok(h.document.querySelector('.agent-icon'), 'keep running agent identity');
  }
  h.state.taskPermissionModeById.set('TPT9072', null);
  setProjectPermissionMode('plan'); h.document.body.classList.add('left-nav-collapsed');
  h.context.syncActiveSessionsNav();
  assert.ok(h.shield().classList.contains('permission-mode-icon--plan'));
  assert.ok(h.document.querySelector('.active-session-item.collapsed'));
  setProjectPermissionMode(null); h.context.syncActiveSessionsNav();
  assert.ok(h.shield().classList.contains('permission-mode-icon--inherited'));
  assert.equal(h.calls.settings, 1, 'no settings fetch for any nav paint');
});

test('failed project save restores previous value and hint, keeps nav/cache unchanged', async tc => {
  const h = harness(tc, 'auto');
  await h.context._populateSettingsWorkflowTab();
  api.project.update = async () => { throw new Error('Permission denied'); };
  h.choose('bypass');
  assert.equal(h.row().querySelector('button').disabled, true);
  await h.settle();
  assert.equal(h.row().querySelector('button').disabled, false);
  assert.equal(h.row().querySelector('input').value, 'auto');
  assert.equal(h.row().querySelector('.settings-row-hint').textContent, t('permissionMode.hint.auto'));
  assert.equal(projectPermissionMode(), 'auto');
  assert.ok(h.shield().classList.contains('permission-mode-icon--auto'));
  assert.match(h.calls.toasts.at(-1)[0], /Permission denied/);
});
