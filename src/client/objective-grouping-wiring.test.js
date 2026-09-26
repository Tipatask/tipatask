import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// (C1460) Regression guards for the objective-grouping board filter's wiring — the parts
// that can't be unit-tested directly because they live in module-private functions
// (task-board.js) or inline `<script>` code (template.html) with no jsdom in this repo.
// Source-scan style, same house pattern as settings-group-label.test.js/dialogs.test.js.
// The filter's actual predicate logic (taskHiddenByGrouping/tasksVisibleUnderGrouping) is
// pure and directly unit-tested in board-count-domain.test.js — this file only guards that
// the two render call sites keep composing it correctly.

function readSource(file) {
  return fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8');
}

// Extracts a top-level function body by name — handles a leading `export `/`async `
// combination in either order — from the declaration line up to (not including) the next
// top-level function declaration. Good enough for this repo's flat top-level
// function-declaration style (no nested same-named declarations).
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

test('writeProjectObjectiveGrouping() dispatches tiptask:reload on success, so the toggle repaints the open board', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'writeProjectObjectiveGrouping');
  const tryIdx = body.indexOf('try');
  const catchIdx = body.indexOf('catch');
  assert.ok(tryIdx !== -1 && catchIdx !== -1, 'writeProjectObjectiveGrouping() must have a try/catch');
  const tryBody = body.slice(tryIdx, catchIdx);
  assert.match(
    tryBody,
    /tiptask:reload/,
    'writeProjectObjectiveGrouping()\'s success path must dispatch tiptask:reload (C1460) — ' +
      'without it, flipping the toggle saves the flag but leaves the already-open board showing ' +
      'the old grouping mode until some unrelated render happens to fire'
  );
});

test('refreshFilterBarChrome() narrows by objective grouping before narrowing by tab domain', () => {
  const src = readSource('task-board.js');
  const body = extractFunctionBody(src, 'refreshFilterBarChrome');
  const groupingIdx = body.indexOf('tasksVisibleUnderGrouping');
  const tabDomainIdx = body.indexOf('tasksForActiveTab');
  assert.ok(groupingIdx !== -1, 'refreshFilterBarChrome() must call tasksVisibleUnderGrouping() (C1460) — ' +
    'without it, a DOM-only filter toggle (search/tag) re-inflates facet counts back to every ' +
    'fetched row, including subtasks/parents the board itself is not drawing');
  assert.ok(tabDomainIdx !== -1, 'refreshFilterBarChrome() must still call tasksForActiveTab() (C1442)');
  assert.ok(
    groupingIdx < tabDomainIdx,
    'tasksVisibleUnderGrouping() must run BEFORE tasksForActiveTab() — grouping narrows first, ' +
      'tab domain narrows what is left; the reverse order would let backlog-tab counting see ' +
      'grouping-hidden rows tasksForActiveTab never meant to include'
  );
});

test('template.html: renderTodoContent()/renderBacklogHintHtml() in the root-board render are fed groupedTasks, never bare visibleTasks', () => {
  const html = readSource('template.html');
  assert.doesNotMatch(
    html,
    /renderTodoContent\(visibleTasks,/,
    'renderTodoContent() must be called with groupedTasks (C1460), not raw visibleTasks — ' +
      'otherwise the To-Do tab shows subtasks/parents the rest of the board is hiding'
  );
  assert.doesNotMatch(
    html,
    /renderBacklogHintHtml\(visibleTasks\)/,
    'renderBacklogHintHtml() must be called with groupedTasks (C1460), not raw visibleTasks — ' +
      'renderBacklogContent() is grouping-filtered too, so a hint counted over the ungrouped ' +
      'set can promise a Backlog match that is actually grouping-hidden'
  );
  assert.match(html, /renderTodoContent\(groupedTasks, tierKeys\)/, 'renderTodoContent(groupedTasks, tierKeys) call not found');
  assert.match(html, /renderBacklogHintHtml\(groupedTasks\)/, 'renderBacklogHintHtml(groupedTasks) call not found');
});
