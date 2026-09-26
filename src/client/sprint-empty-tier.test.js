import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// (C1578) Regression guards for the empty-sprint-tier hide wiring — the parts that can't be
// unit-tested directly because they live in module-private functions (task-board.js,
// task-card.js) or inline <script> code (template.html), and there's no jsdom in this repo.
// Source-scan style, same house pattern as objective-grouping-wiring.test.js/dialogs.test.js.
// The reveal-pool math itself is pure and directly unit-tested in
// sprint-tier-visibility.test.js — this file only guards that the render/DOM call sites keep
// composing it correctly.

function readSource(file) {
  return fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8');
}

// Same extractor as objective-grouping-wiring.test.js — top-level function-declaration style,
// no nested same-named declarations.
function extractFunctionBody(source, name) {
  const startRe = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm');
  const startMatch = startRe.exec(source);
  assert.ok(startMatch, `function ${name}() not found in source`);
  const startIdx = startMatch.index;
  const nextDeclRe = /^(?:export )?(?:async )?function \w+\(/gm;
  nextDeclRe.lastIndex = startIdx + startMatch[0].length;
  const nextMatch = nextDeclRe.exec(source);
  const endIdx = nextMatch ? nextMatch.index : source.length;
  return source.slice(startIdx, endIdx);
}

test('applySearchFilter() calls syncEmptyTierVisibility() at least twice, once before the no-needle branch returns', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'applySearchFilter');
  const calls = [...body.matchAll(/syncEmptyTierVisibility\(/g)];
  assert.ok(calls.length >= 2, 'expected at least 2 calls (no-needle branch + needle branch)');
  // The no-needle branch is the WS task:updated resync tail — its early `return;` must come
  // AFTER the first syncEmptyTierVisibility() call, or an emptied-by-move tier never hides.
  const firstCallIdx = calls[0].index;
  const noNeedleReturnIdx = body.indexOf('return;');
  assert.ok(noNeedleReturnIdx !== -1, 'no-needle branch must have an early return');
  assert.ok(firstCallIdx < noNeedleReturnIdx,
    'syncEmptyTierVisibility() must run before the no-needle branch\'s early return — this is ' +
    'the exact tail a WS task:updated patch reaches (regroupCardToSprint()\'s \'moved\' path ' +
    'never reloads on its own)');
});

test('applyTagFilter() no longer toggles tier-level visibility itself (de-duplicated into syncEmptyTierVisibility)', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'applyTagFilter');
  assert.doesNotMatch(body, /tier\[data-priority\]/,
    'applyTagFilter() should no longer query .tier[data-priority] directly — that logic now ' +
    'lives solely in syncEmptyTierVisibility() (task-board.js), called by applySearchFilter()');
});

test('syncEmptyTierVisibility() is the sole writer of HIDE_CLASS on a .tier element in task-board.js', () => {
  const src = readSource('task-board.js');
  const syncBody = extractFunctionBody(src, 'syncEmptyTierVisibility');
  assert.match(syncBody, /classList\.add\(HIDE_CLASS\)/);
  // No OTHER function in the file should hand-roll the same add/remove pair.
  const otherAdds = [...src.matchAll(/classList\.add\(HIDE_CLASS\)/g)];
  assert.equal(otherAdds.length, 1, 'HIDE_CLASS should be added in exactly one place in task-board.js');
});

test('renderBoardContent() skips a card-less tier unconditionally, not gated on a narrowing filter', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'renderBoardContent');
  assert.match(body, /const isEmpty = sorted\.length === 0;/,
    'renderBoardContent() must compute emptiness unconditionally (C1578) — a card-less tier ' +
    'renders hidden rather than being skipped, so it stays a drop target during a drag');
  assert.doesNotMatch(body, /humanFilterActive[^\n]*&&[^\n]*sorted\.length === 0\) return/,
    'the old filter-gated early return must be gone');
  assert.match(body, /HIDE_CLASS/, 'renderBoardContent() must apply HIDE_CLASS to a card-less tier');
});

test('renderBoardContent() falls back to a notice instead of a bare empty timeline when every tier is card-less', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'renderBoardContent');
  assert.match(body, /visibleKeys\.length === 0/,
    'must guard the case where computeVisibleTiers() has nothing WITH content to draw (e.g. ' +
    'a backlog-only project) — isEmptyBoard upstream does not catch this case');
  assert.match(body, /board\.noSprintTasks/);
  // The guard must still render emptyKeys (hidden) rather than skipping the timeline
  // entirely — otherwise drag-drop into an empty sprint stops working on a blank board.
  assert.match(body, /timelineHtml/);
});

test('renderBoardContent() merges visibleKeys with emptyKeys — a card-less tier stays a DOM drop target, not just a filter skip', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'renderBoardContent');
  assert.match(body, /emptyKeys/,
    'renderBoardContent() must destructure emptyKeys from computeVisibleTiers() and render ' +
    'those tiers too (hidden) — computeVisibleTiers()/computeTierWindow() excludes card-less ' +
    'tiers from visibleKeys entirely, so without this they would never reach the DOM at all ' +
    'and the isEmpty/HIDE_CLASS branch below would be dead code');
});

test('renderListContent() skips a card-less group unconditionally too', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'renderListContent');
  assert.match(body, /if \(sorted\.length === 0\) return '';/,
    'renderListContent() has no drag/drop and no DOM filter pass of its own — a card-less ' +
    'group is skipped outright, not rendered-then-hidden like the board tier');
  assert.doesNotMatch(body, /humanFilterActive[^\n]*&&[^\n]*sorted\.length === 0\) return/);
});

test('renderFlatBoardContent() carries no card-less skip — the flat board is a single always-shown container', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'renderFlatBoardContent');
  assert.doesNotMatch(body, /sorted\.length === 0/,
    'the flat board (Sprints toggle off) has exactly one .tier--flat container with no ' +
    'data-priority — it is the drop target and the empty state; C1578 must not touch it');
});

test('regroupCardToSprint() captures the source tier before mutating the DOM', () => {
  const src = readSource('task-card.js');
  const body = extractFunctionBody(src, 'regroupCardToSprint');
  const captureIdx = body.indexOf("closest('.tier-cards')");
  const removeIdx = body.indexOf('card.remove()');
  const insertBeforeIdx = body.indexOf('insertBefore');
  assert.ok(captureIdx !== -1, 'must capture the source .tier-cards before any mutation');
  assert.ok(captureIdx < removeIdx, 'capture must precede the backlog card.remove()');
  assert.ok(captureIdx < insertBeforeIdx, 'capture must precede the move insertBefore');
});

test('regroupCardToSprint() un-hides the destination tier before inserting the card into it', () => {
  const src = readSource('task-card.js');
  const body = extractFunctionBody(src, 'regroupCardToSprint');
  const unhideIdx = body.indexOf('tierEl.classList.remove(HIDE_CLASS)');
  const insertBeforeIdx = body.indexOf('targetTier.insertBefore');
  const appendIdx = body.indexOf('targetTier.appendChild');
  assert.ok(unhideIdx !== -1,
    'destination lookup (.tier[data-priority] .tier-cards) matches a hidden tier just as well ' +
    'as a visible one — without un-hiding it first, a card moved into an empty sprint would ' +
    'be inserted into a display:none container and silently vanish');
  assert.ok(unhideIdx < insertBeforeIdx && unhideIdx < appendIdx);
});

test('regroupCardToSprint() alphabet includes emptied, and both predicates cover it correctly', () => {
  const src = readSource('task-card.js');
  assert.match(src, /return _hideIfEmptied\(sourceTierCards, targetTier\) \? 'emptied' : 'moved';/);
  const movedPred = extractFunctionBody(src, 'regroupMovedCard');
  assert.match(movedPred, /result === 'moved' \|\| result === 'emptied'/);
  const reloadPred = extractFunctionBody(src, 'regroupNeedsReload');
  assert.match(reloadPred, /result === 'reload' \|\| result === 'removed' \|\| result === 'emptied'/);
});

test('every regroupCardToSprint() call site routes through the shared predicates, not a bare literal', () => {
  // task-board.js (a pure call site, never the predicates' home) must have zero bare
  // comparisons — regroupNeedsReload()/regroupMovedCard() only.
  const boardSrc = readSource('task-board.js');
  assert.doesNotMatch(boardSrc, /===\s*'moved'/, "task-board.js must use regroupMovedCard(), not a bare 'moved' comparison");
  assert.doesNotMatch(boardSrc, /===\s*'removed'/, "task-board.js must use regroupNeedsReload(), not a bare 'removed' comparison");

  // task-card.js legitimately contains the literals ONCE each — inside the predicate
  // definitions themselves. Any occurrence outside those two function bodies means a call
  // site (e.g. applyTaskPatch()) drifted back to a bare comparison.
  const cardSrc = readSource('task-card.js');
  const movedPredBody = extractFunctionBody(cardSrc, 'regroupMovedCard');
  const reloadPredBody = extractFunctionBody(cardSrc, 'regroupNeedsReload');
  const outsidePredicates = cardSrc.replace(movedPredBody, '').replace(reloadPredBody, '');
  assert.doesNotMatch(outsidePredicates, /===\s*'moved'/, "task-card.js call sites must use regroupMovedCard(), not a bare 'moved' comparison");
  assert.doesNotMatch(outsidePredicates, /===\s*'removed'/, "task-card.js call sites must use regroupNeedsReload(), not a bare 'removed' comparison");
});

test('_cleanupDrag solely owns board-dragging teardown, including the drop path (C1578)', () => {
  const src = readSource('task-card.js');
  const startBody = extractFunctionBody(src, '_startDrag');
  assert.match(startBody, /body\.classList\.add\('board-dragging'\)/);
  const cleanupBody = extractFunctionBody(src, '_cleanupDrag');
  assert.match(cleanupBody, /body\.classList\.remove\('board-dragging'\)/);
  const dragEndBody = extractFunctionBody(src, '_onDragEnd');
  assert.match(dragEndBody, /finally\s*\{\s*_cleanupDrag\(\);\s*\}/,
    '<body> sits outside #app and survives the forceFresh re-render on drop — the drop-commit ' +
    'path must reach the same idempotent teardown even when insert/reorder/render throws');
  assert.doesNotMatch(dragEndBody, /body\.classList\.remove\('board-dragging'\)/,
    '_onDragEnd must not grow a second, divergent board-dragging teardown');
});

test('template.html still synthesizes an empty tier entry per un-fetched sprint record (state.tierKeys must stay untouched by C1578)', () => {
  const src = readSource('template.html');
  assert.match(src, /tiers\[num\] = \[\];/,
    'removing this would drop empty sprints from state.tierKeys — and therefore from the ' +
    'new-task combo, edit-modal combo, To-Do sprint nav, and the new-sprint number formula. ' +
    'C1578 only changes what RENDERS, never what state.tierKeys contains');
});

test('styles.css has the .tier--empty hide rule and its body.board-dragging reveal override', () => {
  const src = readSource('styles.css');
  assert.match(src, /\.tier\.tier--empty\s*\{\s*display:\s*none;\s*\}/);
  assert.match(src, /body\.board-dragging \.tier\.tier--empty\s*\{\s*display:\s*flex;\s*\}/);
});

test('i18n.js defines board.noSprintTasks exactly twice (en + uk)', () => {
  const src = readSource('i18n.js');
  const matches = [...src.matchAll(/'board\.noSprintTasks':/g)];
  assert.equal(matches.length, 2, 'expected exactly one en entry and one uk entry');
});
