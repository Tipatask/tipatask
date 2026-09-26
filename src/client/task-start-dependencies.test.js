import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { hasUnmetDeps, unmetDependencyKeys } from './dependency-status.js';
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
  assert.match(source, /export \{ hasUnmetDeps, unmetDependencyKeys \};/);
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
