import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Close warning counts live sessions, not tasks whose status says in_progress.
// Both title-bar and menu close routes use the same native confirmation dialog.

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(CLIENT_DIR, '..', '..');
const TASK_BOARD_PATH = path.join(CLIENT_DIR, 'task-board.js');
const TEMPLATE_HTML_PATH = path.join(CLIENT_DIR, 'template.html');
const MAIN_JS_PATH = path.join(SERVER_ROOT, 'main.js');

const taskBoardSrc = fs.readFileSync(TASK_BOARD_PATH, 'utf8');
const templateSrc = fs.readFileSync(TEMPLATE_HTML_PATH, 'utf8');
const mainSrc = fs.readFileSync(MAIN_JS_PATH, 'utf8');

function stripLineComments(text) {
  return text.split('\n').map((line) => {
    const idx = line.indexOf('//');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

function sliceFunctionBody(src, needle) {
  const start = src.indexOf(needle);
  assert.notEqual(start, -1, `expected to find "${needle}"`);
  const end = src.indexOf('\nfunction ', start + 1);
  const end2 = src.indexOf('\nexport function ', start + 1);
  const stop = [end, end2].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  return stop === undefined ? src.slice(start) : src.slice(start, stop);
}

test('task-board.js closeGuardState() counts live sessions only, never board-task status', () => {
  const body = sliceFunctionBody(taskBoardSrc, 'export function closeGuardState(');
  assert.match(body, /activeSessions/, 'expected the sessions-only count source');
  assert.doesNotMatch(body, /activeTasks/, 'must not reintroduce an activeTasks field');
  assert.doesNotMatch(body, /countActiveTasks/, 'must not reintroduce the status-based counter');
  assert.doesNotMatch(body, /_lastVisibleTasks/, 'must not read board-render state for the close guard');
});

test('countActiveTasks/hasActiveTasks are not exported from task-board.js', () => {
  assert.doesNotMatch(taskBoardSrc, /export function countActiveTasks/, 'countActiveTasks must stay removed');
  assert.doesNotMatch(taskBoardSrc, /export function hasActiveTasks/, 'hasActiveTasks must stay removed');
});

test('main.js confirmWindowClose() gates on sessions only, never activeTasks', () => {
  const body = sliceFunctionBody(mainSrc, 'async function confirmWindowClose(');
  assert.match(body, /info\.sessions/, 'expected the guard to read info.sessions');
  assert.doesNotMatch(body, /\.activeTasks\b/, 'must not reintroduce an activeTasks read');
  assert.doesNotMatch(body, /closeProjectDetailTasks/, 'must not reintroduce the removed task-count i18n string');
});

test("main.js's Close Project menu item calls window.close(), not project:menu 'close'", () => {
  const start = mainSrc.indexOf("mt('menu.closeProject')");
  assert.notEqual(start, -1, 'expected the Close Project menu item');
  const nextLabelIdx = mainSrc.indexOf('label:', start + 1);
  const body = stripLineComments(mainSrc.slice(start, nextLabelIdx === -1 ? start + 500 : nextLabelIdx));
  assert.match(body, /window\.close\(\)/, 'expected the accelerator/menu click to close the window directly');
  assert.doesNotMatch(body, /project:menu/, "must not reintroduce the project:menu 'close' round trip");
});

test("template.html's onProjectMenu handler has no 'close' branch (unified on window.close())", () => {
  const handlerIdx = templateSrc.indexOf('window.electronAPI.onProjectMenu(');
  assert.notEqual(handlerIdx, -1, 'expected the onProjectMenu handler');
  const nextActionIdx = templateSrc.indexOf("if (action === 'rename')", handlerIdx);
  assert.notEqual(nextActionIdx, -1, "expected the 'rename' branch to follow");
  const body = stripLineComments(templateSrc.slice(handlerIdx, nextActionIdx));
  assert.doesNotMatch(body, /action === 'close'/, "must not reintroduce a project:menu 'close' branch");
  assert.doesNotMatch(body, /closeCurrentProject\(\)/, 'must not reintroduce a closeCurrentProject() call from this handler');
});
