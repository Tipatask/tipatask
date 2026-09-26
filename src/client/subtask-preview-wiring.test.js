import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const read = file => fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8');

// (TPT257) Source-scan guards for the subtask preview stack — same house pattern as
// objective-origin-wiring.test.js: the card renderer, the single-card save path and the
// objective composer all live in DOM-importing modules that node can't load, so the
// wiring is asserted textually. The count math itself is unit-tested in subtask-preview.test.js.

function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found`);
  const next = src.indexOf('\nexport ', start + signature.length);
  return src.slice(start, next === -1 ? src.length : next);
}

test('saveTaskChange(): stamps parentId from cs.parentTaskKey on a new card, before the C1339 objective-parent block', () => {
  const body = fnBody(read('chat-task-preview.js'), 'export async function saveTaskChange(');
  const stampIdx = body.indexOf("if (!change._manual && cs && cs.parentTaskKey) change.task.parentId = cs.parentTaskKey;");
  const parentBlockIdx = body.indexOf('if (!change._manual && cs && !cs.parentTaskKey) {');
  assert.notEqual(stampIdx, -1, 'Phase 2.7 parentId stamp missing from saveTaskChange()');
  assert.notEqual(parentBlockIdx, -1, 'C1339 objective-parent block missing from saveTaskChange()');
  assert.ok(stampIdx < parentBlockIdx, 'parentId stamp must precede the objective-parent block');
});

test('bulk .chat-save-btn handler still carries its own Phase 2.7 stamp (mutual exclusivity pair intact)', () => {
  const src = read('chat-task-preview.js');
  assert.match(src, /card\.task\.parentId = cs\.parentTaskKey;/);
  assert.match(src, /if \(!cs\.parentTaskKey && newCardTasks\.length > 0\) \{/);
});

test('renderCardHtml(): reads chatState.parentTaskKey once and emits the subtask badge, class and intro', () => {
  const body = fnBody(read('chat-task-preview.js'), 'export function renderCardHtml(');
  assert.match(body, /const subtaskParentKey = \(state\.chatState && state\.chatState\.parentTaskKey\) \|\| null;/);
  assert.match(body, /class="change-target change-target--subtask"/);
  assert.match(body, /preview-card--subtask/);
  assert.match(body, /translate\('chat\.subtaskCardsIntro', \{ key: subtaskParentKey \}\)/);
  assert.match(body, /translate\('chat\.subtaskOf', \{ key: subtaskParentKey \}\)/);
});

test('updateSaveBar() refreshes the summary line in place (Reject never reloads)', () => {
  const src = read('chat-task-preview.js');
  assert.match(src, /export function refreshSubtaskSummary\(\)/);
  const body = fnBody(src, 'export function updateSaveBar(');
  assert.match(body, /refreshSubtaskSummary\(\);/);
  assert.match(src, /import \{ countPendingSubtaskCards \} from '\.\/subtask-preview\.js';/);
});

test('renderObjectiveContent(): renders #subtask-preview-summary directly under the subtask banner', () => {
  const src = read('chat-ui.js');
  assert.match(src, /import \{ countPendingSubtaskCards, hasProposalCards \} from '\.\/subtask-preview\.js';/);
  const body = fnBody(src, 'export function renderObjectiveContent(');
  assert.match(body, /id="subtask-preview-summary"/);
  assert.match(body, /tc\('chat\.subtaskSummary', n, \{ key: subtaskParentKey \}\)/);
  assert.match(body, /\$\{subtaskBannerHtml\}\s*\$\{subtaskSummaryHtml\}/);
});

test('i18n: the subtask preview keys exist in en with the placeholders the call sites pass', () => {
  const src = read('i18n.js');
  for (const key of ['chat.subtaskCardsIntro', 'chat.subtaskOf', 'chat.subtaskSummary.one', 'chat.subtaskSummary.many']) {
    assert.ok(src.includes(`'${key}':`), `${key} missing from i18n.js`);
  }
  assert.match(src, /'chat\.subtaskSummary\.many': '\{n\} subtasks will be created under \{key\}'/);
});

test('styles.css: badge, card rule and summary line are styled', () => {
  const css = read('styles.css');
  assert.match(css, /\.preview-card \.change-target--subtask \{/);
  assert.match(css, /\.preview-card\.preview-card--subtask \{/);
  assert.match(css, /\.subtask-preview-summary \{/);
});
