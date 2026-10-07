import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { hasUnmetDeps, unmetDependencyKeys, hasTaskSession, startBlockedByDeps } from './dependency-status.js';
import state from './state.js';
import { resetStatuses } from './status-registry.js';

const readSource = name => readFileSync(new URL(name, import.meta.url), 'utf8');

test('dependency gate blocks every loaded non-closed dependency', () => {
  resetStatuses();
  const task = { dependencies: ['TPT1', 'TPT2', 'TPT3', 'TPT4', 'TPT5'] };
  const statuses = new Map([
    ['TPT1', 'pending'],
    ['TPT2', 'in_progress'],
    ['TPT3', 'on_fire'],
    ['TPT4', 'completed'],
    ['TPT5', 'canceled'],
  ]);

  assert.deepEqual(unmetDependencyKeys(task, statuses), ['TPT1', 'TPT2', 'TPT3']);
  assert.equal(hasUnmetDeps(task, statuses), true);
});

test('dependency gate accepts full task records and fails open for unknown keys', () => {
  resetStatuses();
  const task = { dependencies: ['TPT1', 'TPT2', 'TPT404'] };
  const taskList = [
    { id: 'TPT1', status: 'completed' },
    { id: 'TPT2', status: 'canceled' },
  ];

  assert.deepEqual(unmetDependencyKeys(task, taskList), []);
  assert.equal(hasUnmetDeps(task, taskList), false);
  assert.equal(hasUnmetDeps({ dependencies: [] }, taskList), false);
  assert.equal(hasUnmetDeps({}, taskList), false);
});

test('task-card exports shared dependency helpers and keeps legacy board guard routed through them', () => {
  const source = readSource('task-card.js');
  assert.match(source, /export \{ hasUnmetDeps, unmetDependencyKeys, hasTaskSession, startBlockedByDeps \};/);
  assert.match(source, /export function isDepsBlocked\(t\) \{ return hasUnmetDeps\(t\); \}/);
  assert.match(source, /const blocking = unmetDependencyKeys\(t\);/);
});

test('edit modal renders and rechecks dependency blocking before save or launch', () => {
  const source = readSource('task-edit-modal.js');
  const renderStart = source.indexOf('function _renderTaskEditModal()');
  const renderEnd = source.indexOf('\n// ═', renderStart);
  const renderBody = source.slice(renderStart, renderEnd);
  assert.match(renderBody, /startBlocked = showStart && commands\.hasUnmetDeps\(draft, projectTaskIndex\)/);
  assert.match(renderBody, /data-action="start"[\s\S]*startBlocked \? ' disabled' : ''/);
  assert.match(renderBody, /tooltip\.waitingForDependencies[\s\S]*unmetDeps\.join\(', '\)/);

  const handlerStart = source.indexOf("if (action === 'start') {");
  const handlerEnd = source.indexOf("} else if (action === 'stop')", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  const guardAt = handler.indexOf('hasUnmetDeps(');
  const saveAt = handler.indexOf('_isModalDirty()');
  const launchAt = handler.indexOf('callbacks.onStart');
  assert.ok(guardAt !== -1 && guardAt < saveAt, 'dependency guard must run before dirty-draft persistence');
  assert.ok(saveAt < launchAt, 'dependency guard and persistence must run before agent launch');
  assert.match(handler, /_syncModalStartDependencyState\(modal, draft\);\s*return;/);
});

test('edit modal Stop persists a dirty draft before terminating the session', () => {
  const source = readSource('task-edit-modal.js');
  const handlerStart = source.indexOf("} else if (action === 'stop') {");
  const handlerEnd = source.indexOf("} else if (action === 'reiterate')", handlerStart);
  assert.ok(handlerStart !== -1 && handlerEnd > handlerStart, 'stop handler must be found');
  const handler = source.slice(handlerStart, handlerEnd);
  const dirtyAt = handler.indexOf('_isModalDirty()');
  const saveAt = handler.indexOf('await persistDraft()');
  const abortAt = handler.indexOf('if (!saved) return;');
  const stopAt = handler.indexOf('terminateSessionFromCard');
  assert.ok(dirtyAt !== -1 && dirtyAt < saveAt, 'dirty check must precede the save');
  assert.ok(saveAt !== -1 && saveAt < abortAt, 'save failure must abort the stop');
  assert.ok(abortAt < stopAt, 'save and abort guard must run before the stop call');
});

test('edit modal preloads full project tasks and provides localized disabled styling', () => {
  const board = readSource('task-board.js');
  const editor = readSource('task-edit-modal.js');
  const styles = readSource('styles.css');
  const i18n = readSource('i18n.js');
  // (TPT111) Open path no longer gates first paint on the project task list — it still
  // fires _ensureProjectTaskList() concurrently with the task fetch, but only awaits the
  // task before painting; the list resolves via a deferred .then() afterwards.
  const openStart = editor.indexOf('async function _openTaskEditModalImpl');
  const openEnd = editor.indexOf('function _clearTaskActivityOnOpen', openStart);
  const open = editor.slice(openStart, openEnd);
  assert.match(open, /listP = commands\._ensureProjectTaskList\(\)/);
  assert.match(open, /task = await api\.tasks\.get\(taskId\)/);
  assert.doesNotMatch(open, /await Promise\.all\(/);
  // Dependency index falls back to the board's own state.taskStatusById (not an empty
  // array) while the list is still in flight, so Start renders correctly blocked from
  // first paint instead of briefly showing enabled.
  assert.match(board, /function _projectTaskIndex\(\)[\s\S]{0,200}state\.taskStatusById/);
  assert.match(styles, /\.modal-context-btns button:disabled/);
  assert.equal((i18n.match(/'tooltip\.waitingForDependencies'/g) || []).length, 2);
});

// (TPT552) A task's agent sets it on_fire, follow-up tasks are then created/started in the
// same live terminal and added as the original task's dependencies. The original task's
// resume controls must stay enabled: the dependency gate blocks a fresh launch only.
test('resume controls stay enabled after on_fire + follow-up tasks start in the same session', () => {
  resetStatuses();
  const original = { id: 'TPT900', status: 'on_fire', dependencies: ['TPT901', 'TPT902'] };
  const statuses = new Map([['TPT900', 'on_fire'], ['TPT901', 'in_progress'], ['TPT902', 'pending']]);
  try {
    assert.equal(hasUnmetDeps(original, statuses), true, 'follow-ups are unmet dependencies');
    assert.equal(startBlockedByDeps(original, statuses), true, 'no session: fresh launch stays gated');

    state.activeSessions.add('TPT900');
    assert.equal(hasTaskSession('TPT900'), true);
    assert.equal(startBlockedByDeps(original, statuses), false, 'live session: on_fire task resumable');
    // User flips the original back to in progress — RUNNING (spinner) mode must still be clickable.
    assert.equal(startBlockedByDeps({ ...original, status: 'in_progress' }, statuses), false);
    state.activeSessions.delete('TPT900');

    state.exitedSessions.add('TPT900');
    assert.equal(startBlockedByDeps(original, statuses), false, 'exited session keeps its scrollback reachable');
    state.exitedSessions.delete('TPT900');

    state.queuedSessions.set('TPT900', 1);
    assert.equal(startBlockedByDeps(original, statuses), false, 'queued start re-attaches to the wait');
  } finally {
    state.activeSessions.delete('TPT900');
    state.exitedSessions.delete('TPT900');
    state.queuedSessions.delete('TPT900');
  }
  assert.equal(hasTaskSession(undefined), false);
});

test('card, board repaint and edit modal all exempt an existing session from the dependency gate', () => {
  const card = readSource('task-card.js');
  assert.match(card, /const startGated = depsBlocked && !hasTaskSession\(t\.id\);/);
  assert.match(card, /card-start-btn btn-claude card-ctl\$\{startGated \? ' deps-blocked'/);
  assert.match(card, /\$\{startGated \? ` disabled title="Waiting for:/);
  assert.match(card, /dataset\.depsBlocked === '1' && !hasTaskSession\(taskId\)\) return;/);

  const board = readSource('task-board.js');
  const update = board.slice(board.indexOf('export function updateClaudeButtons('), board.indexOf('function _sessionAgentIcon('));
  assert.match(update, /const depsGated = card\?\.dataset\.depsBlocked === '1' && !hasTaskSession\(taskId\);/);
  assert.match(update, /btn\.disabled = depsGated;/);
  assert.match(update, /btn\.classList\.toggle\('deps-blocked', depsGated\);/);

  const editor = readSource('task-edit-modal.js');
  const sync = editor.slice(editor.indexOf('function _syncModalStartDependencyState('), editor.indexOf('function _modalSessionButton('));
  assert.match(sync, /hasUnmetDeps\(task, taskIndex\) && !hasTaskSession\(task\.id\)/);
  assert.match(editor, /startBlocked = showStart && commands\.hasUnmetDeps\(draft, projectTaskIndex\) && !hasTaskSession\(draft\.id\)/);
  const handlerStart = editor.indexOf("if (action === 'start') {");
  const handler = editor.slice(handlerStart, editor.indexOf("} else if (action === 'stop')", handlerStart));
  assert.match(handler, /!hasTaskSession\(taskId\) && commands\.hasUnmetDeps\(draft/);
});
