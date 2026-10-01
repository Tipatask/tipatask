import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// (TPT345) Source-scan guards for how the Merge task branches panel is reached and how its
// server frames are dispatched. No jsdom in this repo, and most of these seams live in the
// inline template.html script / main.js, so scanning the source is the only mechanical guard.
const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(CLIENT_DIR, '../..');
const read = (rel) => fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');

test('index.js exposes the modal as window.TipTask.mergeBranchesModal', () => {
  const src = read('src/client/index.js');
  assert.match(src, /import \* as mergeBranchesModal from '\.\/merge-branches-modal\.js'/);
  assert.match(src, /window\.TipTask = \{[^}]*\bmergeBranchesModal\b[^}]*\}/);
});

test('template.html routes the Project menu action and dispatches merge frames on the board socket', () => {
  const html = read('src/client/template.html');
  assert.match(html, /const \{ openMergeBranchesModal, handleMergeWsMessage \} = window\.TipTask\.mergeBranchesModal/);
  assert.match(html, /if \(action === 'merge-branches'\) \{ openMergeBranchesModal\(\); return; \}/);
  const kbIdx = html.indexOf('if (TipTask.taskBoard.handleKbWsMessage(msg)) return;');
  const mergeIdx = html.indexOf('if (handleMergeWsMessage(msg)) return;');
  assert.ok(kbIdx > 0 && mergeIdx > kbIdx && mergeIdx - kbIdx < 600, 'merge dispatch sits right after the KB dispatch in connectBoardWs()');
});

test('attention-ws.js dispatches merge frames only under Electron (browser mode uses __board__)', () => {
  const src = read('src/client/attention-ws.js');
  assert.match(src, /window\.electronAPI\?\.api && typeof msg\.type === 'string' && \(msg\.type\.startsWith\('merge:'\) \|\| msg\.type === 'worktree-dirty-on-complete'\)/);
  assert.match(src, /window\.TipTask\?\.mergeBranchesModal\?\.handleMergeWsMessage\?\.\(msg\)/);
});

test('task-board.js never dispatches merge frames from the image-paste board socket (double dispatch under Electron)', () => {
  const src = read('src/client/task-board.js');
  const start = src.indexOf('function _handleImagePasteWsMessage(');
  assert.ok(start > 0);
  const end = src.indexOf('\nfunction ', start + 10);
  const body = src.slice(start, end === -1 ? src.length : end);
  assert.doesNotMatch(body, /handleMergeWsMessage/);
});

test('task-board.js keeps type-to-filter off while the merge panel is open', () => {
  const src = read('src/client/task-board.js');
  const start = src.indexOf('const _TYPE_TO_FILTER_OVERLAY_SELECTOR = [');
  const block = src.slice(start, src.indexOf('].join', start));
  assert.match(block, /'\.merge-modal'/);
});

test('main.js Project menu carries the Merge task branches item with the merge-branches action', () => {
  const src = read('main.js');
  assert.match(src, /label: mt\('menu\.mergeTaskBranches'\)/);
  assert.match(src, /webContents\.send\('project:menu', 'merge-branches'\)/);
  const settingsIdx = src.indexOf("mt('menu.settings')");
  const mergeIdx = src.indexOf("mt('menu.mergeTaskBranches')");
  assert.ok(settingsIdx > 0 && mergeIdx > settingsIdx, 'sits after Settings…');
});

test('api-client.js merge namespace is HTTP-only and covers every route', () => {
  const src = read('src/client/api-client.js');
  const start = src.indexOf('  merge: {');
  assert.ok(start > 0);
  const block = src.slice(start, src.indexOf('  async transcribeAudio(', start));
  assert.doesNotMatch(block, /\bipc\b/, 'no IPC branch — Electron main stamps the project header on plain fetches');
  for (const route of ['/api/project/merge/status', '/api/project/merge/dry-run', '/api/project/merge/commit-worktree', '/api/project/merge/run', '/api/project/merge/job', '/api/project/merge/resume', '/api/project/merge/abort', '/api/project/merge/publish', '/api/project/merge/cleanup']) {
    assert.ok(block.includes(route), `route ${route}`);
  }
});

test('console-modal.js honours opts.prompt as a verbatim kickoff override, only when not resuming', () => {
  const src = read('src/client/console-modal.js');
  const start = src.indexOf('function buildTaskSessionPrompt(');
  const body = src.slice(start, src.indexOf('function buildTaskSessionWsExtra('));
  assert.match(body, /if \(typeof opts\.prompt === 'string' && opts\.prompt\.trim\(\)\) return opts\.prompt;/);
  const extra = src.slice(src.indexOf('function buildTaskSessionWsExtra('), src.indexOf('export function startTaskSession('));
  assert.match(extra, /isResume \? \{\} : \{ prompt: buildTaskSessionPrompt\(/);
});
