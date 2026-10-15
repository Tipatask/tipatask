import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  resolveManualSprintSelection, manualDependencyFloor, applyManualDependencyFloor, formSprintValue,
  missingDependencyIds, dependencyFloorRows,
} from './new-task-sprint.js';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');

test('an older sprint picked while a newer one exists stays pinned to that sprint', () => {
  assert.deepEqual(resolveManualSprintSelection('1', { tierKeys: [1, 2, 3], sprintMax: 3 }), { priority: 1, pinned: true });
});

test('explicit Backlog and "+ New sprint" are pinned choices', () => {
  assert.deepEqual(resolveManualSprintSelection('null', { tierKeys: [1, 2, 3] }), { priority: 0, pinned: true });
  assert.deepEqual(resolveManualSprintSelection('__new__', { tierKeys: [1, 2], sprintMax: 3 }), { priority: 4, pinned: true });
  assert.deepEqual(resolveManualSprintSelection('__new__', { tierKeys: [5], sprintMax: 3 }), { priority: 6, pinned: true });
});

test('nothing selected blocks Preview; sprints off keeps default unpinned assignment', () => {
  assert.equal(resolveManualSprintSelection('', { tierKeys: [1] }), null);
  assert.equal(resolveManualSprintSelection(undefined, {}), null);
  assert.deepEqual(resolveManualSprintSelection('', { sprintsEnabled: false, activePriority: 7 }), { priority: 7, pinned: false });
});

test('a dependency in a later sprint moves the pick and names the reason', () => {
  const tasks = [{ id: 'C1', priority: 3 }, { id: 'C2', priority: 0 }];
  const floor = manualDependencyFloor(['C1', 'C2', 'C404'], tasks);
  assert.deepEqual(floor, { floor: 4, depId: 'C1', depPriority: 3 });
  assert.deepEqual(applyManualDependencyFloor(2, floor), {
    priority: 4, moved: { from: 2, to: 4, depId: 'C1', depPriority: 3 },
  });
  assert.deepEqual(applyManualDependencyFloor(5, floor), { priority: 5, moved: null });
  assert.deepEqual(applyManualDependencyFloor(0, floor), { priority: 0, moved: null }, 'Backlog is exempt');
  assert.deepEqual(manualDependencyFloor([], tasks), { floor: 1, depId: null, depPriority: null });
});

test('form re-render keeps the raw pick, including Backlog', () => {
  assert.equal(formSprintValue(0), 'null');
  assert.equal(formSprintValue('null'), 'null');
  assert.equal(formSprintValue('__new__'), '__new__');
  assert.equal(formSprintValue(2), '2');
  assert.equal(formSprintValue(''), '');
  assert.equal(formSprintValue(undefined), '');
});

test('wiring: Preview pins the pick, Confirm saves a copy, manual 422 is not swallowed', () => {
  const template = read('./template.html');
  assert.match(template, /resolveManualSprintSelection\(rawSprint/);
  assert.match(template, /_stepPinned: selection\.pinned/);
  assert.match(template, /priority: getSprintsEnabled\(\) \? rawSprint : priority/);
  assert.match(template, /const \{ _sprintMove, [^}]*\.\.\.previewTask \} = state\.manualTaskState\.previewTask;/);
  const preview = read('./chat-task-preview.js');
  assert.match(preview, /pinned: isStepPinned \? \[change\.task\.id\] : \[\]/);
  assert.match(preview, /change\._manual && resolveRes\.status === 422/);
  assert.match(preview, /if \(manualConflict\) throw new Error\(manualConflict\);/);
});

test('TPT642: dependencies missing from the board list are found by key', () => {
  const tasks = [{ id: 'TPT1', priority: 2 }, { id: 7, priority: 1 }];
  assert.deepEqual(missingDependencyIds(['TPT1', '7', 'TPT9'], tasks), ['TPT9']);
  assert.deepEqual(missingDependencyIds([], tasks), []);
  assert.deepEqual(missingDependencyIds(undefined, undefined), []);
});

test('TPT642: floor rows add live rows for missing deps only, loaded rows stay authoritative', () => {
  const tasks = [{ id: 'TPT1', priority: 2 }];
  const live = [{ id: 'TPT1', priority: 9 }, { id: 'TPT9', priority: 5 }, { id: 'TPT10', priority: 7 }];
  assert.equal(dependencyFloorRows(['TPT1'], tasks, live), tasks, 'every dep loaded: same list, no change');
  assert.equal(dependencyFloorRows(['TPT9'], tasks, null), tasks, 'no live rows (cold/failed fetch): today\'s behaviour');
  assert.equal(dependencyFloorRows(['TPT9'], tasks, []), tasks);
  assert.deepEqual(dependencyFloorRows(['TPT1', 'TPT9'], tasks, live), [{ id: 'TPT1', priority: 2 }, { id: 'TPT9', priority: 5 }]);
  assert.deepEqual(manualDependencyFloor(['TPT1'], dependencyFloorRows(['TPT1'], tasks, live)), { floor: 3, depId: 'TPT1', depPriority: 2 });
});

test('TPT642: a dependency outside the board window moves the pick in Preview', () => {
  const board = [{ id: 'TPT1', priority: 3 }];
  const live = [{ id: 'TPT1', priority: 3 }, { id: 'TPT50', priority: 5 }];
  const deps = ['TPT50'];
  assert.deepEqual(applyManualDependencyFloor(3, manualDependencyFloor(deps, board)), { priority: 3, moved: null }, 'board-only floor misses it');
  assert.deepEqual(applyManualDependencyFloor(3, manualDependencyFloor(deps, dependencyFloorRows(deps, board, live))), {
    priority: 6, moved: { from: 3, to: 6, depId: 'TPT50', depPriority: 5 },
  });
  // A live row with no priority (older server projection) imposes nothing.
  assert.deepEqual(manualDependencyFloor(deps, dependencyFloorRows(deps, board, [{ id: 'TPT50' }])), { floor: 1, depId: null, depPriority: null });
});

test('TPT642 wiring: Preview floor reads live dependency rows; the key guess does not', () => {
  const template = read('./template.html');
  assert.match(template, /manualDependencyFloor\(dependencies, dependencyFloorRows\(dependencies, tasks, getProjectTaskList\(\)\)\)/);
  assert.match(template, /missingDependencyIds\(pendingDeps, tasks\)\.length && !Array\.isArray\(getProjectTaskList\(\)\)\) \{\s*previewPending = true;\s*try \{ await ensureProjectTaskList\(\); \}/);
  assert.match(template, /const nextId = nextTaskKeyGuess\(tasks, category\);/);
  assert.match(template, /getProjectTaskList, ensureProjectTaskList,\n\} = taskBoard;/);
  const board = read('./task-board.js');
  assert.match(board, /export function getProjectTaskList\(\)/);
  assert.match(board, /export function ensureProjectTaskList\(\)/);
  // Both transports of the unfiltered project task list carry priority.
  const priorityRow = /\.\.\.\(t\.priority != null \? \{ priority: t\.priority \} : \{\}\)/;
  const ws = read('../server/ws-handlers.js');
  const wsRoute = ws.slice(ws.indexOf("urlPath === '/api/project/tasks'"));
  assert.match(wsRoute.slice(0, 1200), priorityRow);
  const ipc = read('../../main/ipc/api-router.js');
  const ipcRoute = ipc.slice(ipc.indexOf("'api:tasks.listAll'"));
  assert.match(ipcRoute.slice(0, 900), priorityRow);
});
