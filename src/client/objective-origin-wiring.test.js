import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(CLIENT_DIR, '..', 'server');
const APP_ROOT = path.join(CLIENT_DIR, '..', '..'); // ai/todo/server/ — main.js, preload.js

// (C1559) Regression guards for the web-origin planning wiring — the parts that can't be
// unit-tested directly because they live in an inline event-handler closure
// (chat-task-preview.js's `.chat-save-btn` handler, not a top-level named function) or in
// template.html's inline `<script>`. Source-scan style, same house pattern as
// objective-grouping-wiring.test.js. The pure resolution logic itself
// (resolveOriginPlan/adoptOriginKey/etc.) is directly unit-tested in
// objective-origin-task.test.js — this file only guards that the call sites keep wiring it
// together correctly.

function readSource(file) {
  return fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8');
}

function readServerSource(file) {
  return fs.readFileSync(path.join(SERVER_DIR, file), 'utf8');
}

function readAppSource(file) {
  return fs.readFileSync(path.join(APP_ROOT, file), 'utf8');
}

test('chat-task-preview.js: proposedNewCount is computed BEFORE the first adoptOriginKey reference', () => {
  const src = readSource('chat-task-preview.js');
  const countIdx = src.indexOf('const proposedNewCount = (msg.cards || []).filter(c => c.type === \'new\').length;');
  const adoptIdx = src.indexOf('adoptOriginKey(');
  assert.ok(countIdx !== -1, 'proposedNewCount computation not found in chat-task-preview.js');
  assert.ok(adoptIdx !== -1, 'adoptOriginKey( call not found in chat-task-preview.js');
  assert.ok(
    countIdx < adoptIdx,
    'proposedNewCount MUST be computed before adoptOriginKey can run — adoptOriginKey flips a ' +
      "'new' card to 'modified', which is exactly what proposedNewCount filters on. Computing " +
      'it after a single-mode adoption silently undercounts and desyncs every later gate ' +
      '(shouldCreateObjectiveParent, the parent memo widening) that reads it.'
  );
});

test('chat-task-preview.js: bulk-save Phase 3.5 memo widens to cs.objectiveParentKey || originParentKey', () => {
  const src = readSource('chat-task-preview.js');
  assert.match(
    src,
    /const memoKey = cs\.objectiveParentKey \|\| originParentKey;/,
    'the Phase 3.5 memo branch must widen to originParentKey (C1559) — without it, an ' +
      "origin-linked chat proposing >=2 tasks falls through to shouldCreateObjectiveParent() " +
      'and mints a brand-new parent instead of reusing the already-is_objective origin task'
  );
});

test('chat-task-preview.js: single-card saveTaskChange() also widens the parent memo', () => {
  const src = readSource('chat-task-preview.js');
  const occurrences = [...src.matchAll(/const memoKey = cs\.objectiveParentKey \|\| originParentKey;/g)];
  assert.equal(
    occurrences.length, 2,
    'expected the memoKey widening in BOTH the bulk handler and saveTaskChange() (2 total) — ' +
      'found ' + occurrences.length + '. The two save paths must agree or a per-card Accept ' +
      'on an origin-linked chat would behave differently from the bulk Save Tasks button.'
  );
});

test('split save paths stamp the origin as parent and send split metadata without a synthetic parent', () => {
  const src = readSource('chat-task-preview.js');
  assert.match(src, /card\.task\.parentId = cs\.parentTaskKey;/);
  assert.match(src, /change\.task\.parentId = cs\.parentTaskKey;/);
  assert.match(src, /if \(!cs\.parentTaskKey && newCardTasks\.length > 0\)/);
  assert.match(src, /if \(!change\._manual && cs && !cs\.parentTaskKey\)/);
  assert.match(src, /attachSplitOriginPayload\(data, resolveOriginPlan\(cs, proposedNewCount, newCardTasks\.map\(t => t\.id\)\)\)/);
  assert.match(src, /attachSplitOriginPayload\(data, resolveOriginPlan\(cs, proposedNewCount, \[change\.task\.id\]\)\)/);
});

test('chat-task-preview.js: originConflictCardIndexes guard runs before card adoption in both save paths', () => {
  const src = readSource('chat-task-preview.js');
  const conflictOccurrences = [...src.matchAll(/originConflictCardIndexes\(/g)];
  assert.ok(
    conflictOccurrences.length >= 1,
    'originConflictCardIndexes( not called anywhere — a stray planner-proposed `modified` ' +
      'card targeting the origin key would race the adopted card for the same row'
  );
});

test('chat-ui.js: originTaskKey is present at all 4 chat-state persistence sites, mirroring objectiveParentKey', () => {
  const src = readSource('chat-ui.js');
  const objParentSites = (src.match(/objectiveParentKey/g) || []).length;
  const originSites = (src.match(/originTaskKey/g) || []).length;
  assert.ok(
    originSites >= objParentSites - 4,
    `originTaskKey appears ${originSites} times vs objectiveParentKey's ${objParentSites} — ` +
      'C1559 must mirror every persistence site C1339 established (saveChatState, ' +
      'restoreChatState, chat-draft restore, chat-state fallback restore) or a page reload ' +
      'silently drops the origin link mid-chat'
  );
});

test('chat-ui.js: spawnObjectiveTab() sets tab.originTaskKey with the explicit !== undefined ? : null form', () => {
  const src = readSource('chat-ui.js');
  assert.match(
    src,
    /tab\.originTaskKey = opts\.originTaskKey !== undefined \? opts\.originTaskKey : null;/,
    'spawnObjectiveTab() must assign tab.originTaskKey unconditionally with this exact form ' +
      '(C1410 discipline, same as tab.subtaskCtx above it) — spawnObjectiveTab() reuses a ' +
      'pristine active tab, so a bare `if (opts.originTaskKey) tab.originTaskKey = ...` would ' +
      "leak a PRIOR handoff's origin into an unrelated Trello/Gmail/Reiterate spawn on that " +
      'same reused tab'
  );
});

test('chat-ui.js: every buildObjectivePrompt() call site reads its owning tab, never live state.chatState.originTaskKey', () => {
  const src = readSource('chat-ui.js');
  const callLines = src.split('\n').filter(l => l.includes('buildObjectivePrompt('));
  // The one multi-line call site passes its opts object on the next lines — pull those in too.
  const idx = src.indexOf('buildObjectivePrompt(\n');
  let multiLineOpts = '';
  if (idx !== -1) multiLineOpts = src.slice(idx, src.indexOf(');', idx) + 2);

  assert.ok(callLines.length >= 4, `expected >=4 buildObjectivePrompt( call sites, found ${callLines.length}`);
  for (const line of callLines) {
    if (line.includes('buildObjectivePrompt(') && !line.trim().endsWith('buildObjectivePrompt(')) {
      // Deferred first send captures its chat before awaiting recipe persistence.
      // Other callers resolve the active tab synchronously.
      assert.match(
        line, /tabOriginTaskKey\(\)|sendingChat\?\.originTaskKey/,
        `buildObjectivePrompt call site must use its owning tab or captured sendingChat — got: ${line.trim()}`
      );
      assert.doesNotMatch(
        line, /state\.chatState\?\.originTaskKey|state\.chatState\.originTaskKey/,
        // eslint-disable-next-line max-len
        `buildObjectivePrompt call site must not read state.chatState.originTaskKey directly — ` +
          'clearActiveTab() (run by 2 of these call sites just before) nulls tab.chatState but ' +
          'keeps the tab object, so tabOriginTaskKey() still resolves while state.chatState would ' +
          `silently be null and drop origin mode on every WS restart. Line: ${line.trim()}`
      );
    }
  }
  if (multiLineOpts) {
    assert.match(multiLineOpts, /tabOriginTaskKey\(\)/, 'the multi-line buildObjectivePrompt() call site (feedback fallback) must also pass tabOriginTaskKey()');
  }
});

test('modified-task-merge.js: buildModifiedTaskPatch passes isObjective through as is_objective', () => {
  const src = readSource('modified-task-merge.js');
  assert.match(
    src,
    /if \(task\.isObjective !== undefined\) patch\.is_objective = task\.isObjective;/,
    'buildModifiedTaskPatch must forward isObjective (C1559) — without it, the absent-origin ' +
      'single-task fallback (api.tasks.update via saveTaskChange) never clears the C1341 ' +
      'is_objective stamp when refining a web-origin task in place'
  );
});

// ── /start-task route dispatch (route rename + 3-way branch + IPC chain) ──

test('ws-handlers.js: the route matches both /start-task and the /open-objective alias', () => {
  const src = readServerSource('ws-handlers.js');
  assert.match(
    src,
    /urlPath === '\/start-task' \|\| urlPath === '\/open-objective'/,
    "the route guard must accept BOTH paths — /open-objective is kept as an alias so " +
      "existing bookmarks/links and the no-Electron 302 fallback keep working after the C1559 rename"
  );
});

test('ws-handlers.js: the multi-candidate picker page and the no-Electron 302 fallback both target /start-task', () => {
  const src = readServerSource('ws-handlers.js');
  assert.match(
    src, /`\/start-task\?projectId=/,
    'the picker page href must rebuild as /start-task — a leftover /open-objective href ' +
      'here would lose the route on the second hop (easy to miss, called out explicitly in the plan)'
  );
  assert.match(
    src, /Location: `\/todo\.html\?objectiveTask=\$\{encodeURIComponent\(taskKey\)\}&objectivePlan=1`/,
    'the no-Electron 302 fallback must append &objectivePlan=1 — it cannot tell whether the ' +
      'clicked task has children, so it always degrades to the planning branch'
  );
});

test('ws-handlers.js: the dispatch checks is_objective+no-children BEFORE falling through to sendStartTask', () => {
  const src = readServerSource('ws-handlers.js');
  const objIdx = src.indexOf('if (task.isObjective && children.length === 0)');
  const startIdx = src.indexOf('registryOps.sendStartTask(projectPath, taskKey');
  assert.ok(objIdx !== -1, 'the childless-objective planning branch condition not found');
  assert.ok(startIdx !== -1, 'sendStartTask( call not found');
  assert.ok(
    objIdx < startIdx,
    'the planning-branch check must run BEFORE the sendStartTask fallback, or a childless ' +
      'objective would be routed into the wrong branch'
  );
  assert.match(
    src, /getChildren\(taskKey, \{ unscoped: true \}\)/,
    'the route must fetch children with unscoped:true — this is a cross-account handoff, ' +
      "not a board render, so a teammate-owned child must still count toward the dispatch decision"
  );
});

test('index.js: sendOpenObjective and sendStartTask are both threaded into _registryOps', () => {
  const src = readServerSource('index.js');
  assert.match(src, /sendOpenObjective, sendStartTask, confirmHandoffViaMain,?\s*\n?\s*\};/, '_registryOps must export both dispatchers and native handoff confirmation');
  assert.match(
    src,
    /process\.send\(\{ type: 'open-objective', projectPath, taskKey, warning: !!warning, originTaskKey: originTaskKey \|\| null, title: title \|\| null, description: description \|\| null \}\);/,
    'sendOpenObjective must forward originTaskKey, title, and description in its IPC payload (C1559/TPT16)'
  );
  assert.match(
    src,
    /process\.send\(\{ type: 'start-task', projectPath, taskKey, children:/,
    'sendStartTask must send a start-task IPC message carrying the children list'
  );
});

test('main.js: the serverChild message switch handles start-task alongside open-objective, and forwards originTaskKey', () => {
  const src = readAppSource('main.js');
  assert.match(
    src,
    /focusAndSeedObjective\(msg\.projectPath, msg\.taskKey, \{ warning: !!msg\.warning, originTaskKey: msg\.originTaskKey \|\| null, title: msg\.title \|\| null, description: msg\.description \|\| null \}\)/,
    'the open-objective IPC handler must forward originTaskKey, title, and description into focusAndSeedObjective (TPT16)'
  );
  assert.match(
    src,
    /msg\.type === 'start-task' && msg\.projectPath && msg\.taskKey/,
    'the serverChild message switch must handle the new start-task IPC message type'
  );
  assert.match(
    src,
    /focusAndStartTask\(msg\.projectPath, msg\.taskKey, \{ children:/,
    'the start-task IPC handler must call focusAndStartTask with the children list'
  );
});

test('preload.js: onStartTask is exposed alongside onOpenObjective', () => {
  const src = readAppSource('preload.js');
  assert.match(src, /onOpenObjective: \(cb\) => ipcRenderer\.on\('open-objective'/);
  assert.match(
    src, /onStartTask: \(cb\) => ipcRenderer\.on\('start-task'/,
    'preload.js must expose onStartTask — without it the renderer has no way to receive the start-task IPC push'
  );
});

test('template.html: objectivePlan is deleted before history.replaceState, same discipline as objectiveTask', () => {
  const html = readSource('template.html');
  const deleteIdx = html.indexOf(`params.delete('objectivePlan')`);
  const replaceIdx = html.indexOf('history.replaceState(null,', deleteIdx);
  assert.ok(deleteIdx !== -1, "params.delete('objectivePlan') not found");
  assert.ok(replaceIdx !== -1 && replaceIdx > deleteIdx, 'history.replaceState must run AFTER objectivePlan is deleted, or a reload would re-seed with a stale plan flag');
});

test('template.html: the start-task IPC listener picks the child client-side before calling startTaskById', () => {
  const html = readSource('template.html');
  assert.match(
    html,
    /window\.TipTask\.taskCard\.pickFirstStartableChild\(list\)/,
    'the child must be picked in the renderer (which holds the live board status map), not server-side'
  );
  assert.match(html, /window\.TipTask\.taskCard\.startTaskById\(/, 'startTaskById must be called for both the picked-child and regular-task cases');
});

test('task-card.js: startTaskById and pickFirstStartableChild are exported (reachable via window.TipTask.taskCard)', () => {
  const src = readSource('task-card.js');
  assert.match(src, /export async function startTaskById\(/);
  assert.match(src, /export function pickFirstStartableChild\(/);
});

test('task-card.js: pickFirstStartableChild uses the exact sprint Play-All predicate (never a forked copy)', () => {
  const src = readSource('task-card.js');
  const body = src.slice(src.indexOf('export function pickFirstStartableChild('), src.indexOf('export function pickFirstStartableChild(') + 800);
  assert.match(
    body,
    /isActiveName\(t\.status\) && !isInProgressName\(t\.status\) && t\.category === 'CODING'\s*\n\s*&& !isDepsBlocked\(t\) && canStartTaskCard\(t\)/,
    'pickFirstStartableChild must reuse the identical Play-All eligibility predicate — a ' +
      'divergent copy would let the web-button dispatch and the sprint Play-All button disagree on what counts as startable'
  );
});

test('task-card.js: _startTaskSession (card path) and startTaskById (card-independent) share one ladder via _startTaskSessionCore', () => {
  const src = readSource('task-card.js');
  assert.match(src, /^function _startTaskSessionCore\(/m, 'exactly one _startTaskSessionCore definition expected');
  const callSites = (src.match(/^\s*_startTaskSessionCore\(taskId/gm) || []).length;
  assert.equal(
    callSites, 2,
    `expected _startTaskSessionCore called (as a statement) exactly twice — once from the ` +
      `card-driven _startTaskSession() wrapper, once from startTaskById() — found ${callSites}. ` +
      'The two entry points must not duplicate the agent-resolution ladder.'
  );
});

// ── Board Create Subtasks button -> shared split spawn (TPT255) ──
// A childless is_objective board card now mirrors Rehash -> Split -> AI instead of the old
// TPT15 origin-linked planning branch: a single-task result must always become a CHILD of
// this objective, never silently adopt/replace the objective's own key.

test('template.html: .btn-create-subtasks routes through the shared spawnSplitObjectiveTab() helper, not seedObjectiveFromTask/origin mode', () => {
  const html = readSource('template.html');
  const idx = html.indexOf(`.btn-create-subtasks`);
  assert.ok(idx !== -1, '.btn-create-subtasks not found');
  const handlerSlice = html.slice(idx, idx + 500);
  assert.match(
    handlerSlice,
    /spawnSplitObjectiveTab\(btn\.dataset\.taskKey, btn\.dataset\.taskTitle\)/,
    'the Create Subtasks click handler must route through the same spawnSplitObjectiveTab() ' +
      'helper (task-board.js) that Rehash -> Split -> AI uses, keyed off the clicked button\'s ' +
      'own dataset — a single shared spawn path, not a second forked implementation'
  );
  assert.doesNotMatch(
    handlerSlice, /seedObjectiveFromTask|originTaskKey/,
    'the Create Subtasks handler must NOT use origin mode any more (TPT15) — a single-task ' +
      'planner result must create a child of this objective, not adopt/replace its own key'
  );
});

test('template.html: seedObjectiveFromTask returns the tabId (or null) on every path, not undefined', () => {
  const html = readSource('template.html');
  const start = html.indexOf('async function seedObjectiveFromTask(');
  assert.ok(start !== -1, 'seedObjectiveFromTask definition not found');
  const body = html.slice(start, html.indexOf('\n}\n', start));
  const returns = [...body.matchAll(/return[^;]*;/g)].map(m => m[0]);
  assert.ok(returns.length >= 3, `expected >=3 return statements, found ${returns.length}`);
  for (const r of returns) {
    assert.ok(
      /return null;|return tabId;/.test(r),
      `every early-bail return must be explicit (return null) so a caller can branch on the ` +
        `result — found a bare 'return;': ${r}`
    );
  }
});

test('chat-ui.js: every fresh acceptedMask assignment goes through buildInitialAcceptedMask, not a bare all-true map', () => {
  const src = readSource('chat-ui.js');
  assert.match(
    src,
    /import \{ buildInitialAcceptedMask \} from '\.\/objective-origin-task\.js';/,
    'chat-ui.js must import buildInitialAcceptedMask'
  );
  const staleSites = (src.match(/acceptedMask = filtered\.map\(\(\) => true\)/g) || []).length;
  assert.equal(
    staleSites, 0,
    `found ${staleSites} remaining bare 'acceptedMask = filtered.map(() => true)' assignment(s) — ` +
      'each fresh-cards mask must be seeded via buildInitialAcceptedMask(cs, filtered) so an ' +
      'origin-linked chat starts an out-of-subtree modified card unchecked (TPT15)'
  );
  const wiredSites = (src.match(/acceptedMask = buildInitialAcceptedMask\(cs, /g) || []).length;
  assert.equal(wiredSites, 3, `expected exactly 3 buildInitialAcceptedMask( call sites, found ${wiredSites}`);
});

test('chat-task-preview.js: preview cards flag an out-of-subtree modified card with a visible hint', () => {
  const src = readSource('chat-task-preview.js');
  assert.match(
    src,
    /import \{ resolveOriginPlan, attachSplitOriginPayload, adoptOriginKey, previewOriginSingleTarget, originConflictCardIndexes, outOfSubtreeModifiedIndexes \} from '\.\/objective-origin-task\.js';/,
    'chat-task-preview.js must import outOfSubtreeModifiedIndexes'
  );
  assert.match(
    src, /preview-card--outside/,
    'renderCard() must add a preview-card--outside class (or equivalent visible marker) for a ' +
      'flagged out-of-subtree modified card — an unchecked card with no visible reason looks ' +
      "like a bug, not a deliberate guard"
  );
});

// (TPT16) A seeded planning-branch tab used to populate #chat-input directly inside
// seedObjectiveFromTask() (template.html) — dead code, since spawnObjectiveTab() ends in
// an async reload() and the DOM node at that point is stale or doesn't exist yet for a
// board-originated tab. The fix moves population into chat-ui.js's attachChatHandlers(),
// which runs against the LIVE composer on every objective render, gated by a one-shot
// queue set inside spawnObjectiveTab() itself.
test('chat-ui.js: spawnObjectiveTab queues a pending composer seed for attachChatHandlers to apply', () => {
  const src = readSource('chat-ui.js');
  assert.match(
    src, /_pendingComposerSeed = text \? \{ tabId, text \} : null;/,
    'spawnObjectiveTab must queue { tabId, text } (or null) for attachChatHandlers to consume — ' +
      'without this, a board/IPC-seeded tab never focuses or fires the input event that drives ' +
      'word count, draft-height persistence, and the objective prewarm'
  );
});

test('chat-ui.js: attachChatHandlers applies a pending composer seed by dispatching input and focusing', () => {
  const src = readSource('chat-ui.js');
  const idx = src.indexOf('_pendingComposerSeed && _pendingComposerSeed.tabId === state.activeTabId');
  assert.ok(idx !== -1, 'attachChatHandlers must check for a pending seed matching the active tab');
  const slice = src.slice(idx, idx + 700);
  assert.match(
    slice, /_pendingComposerSeed = null;/,
    'the pending seed must be cleared on consume (one-shot) — otherwise a later render of the ' +
      'same tab would re-steal focus and re-fire the prewarm'
  );
  assert.match(
    slice, /chatInput\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/,
    'applying a pending seed must dispatch a real input event — the rendered `value` alone never ' +
      'runs the word-count/draft-save/prewarm listeners bound above it'
  );
  assert.match(
    slice, /chatInput\.focus\(/,
    'applying a pending seed must focus the composer so Start is immediately usable'
  );
});

test('template.html: seedObjectiveFromTask skips its own task fetch when the caller already supplied title', () => {
  const html = readSource('template.html');
  const start = html.indexOf('async function seedObjectiveFromTask(');
  assert.ok(start !== -1, 'seedObjectiveFromTask definition not found');
  const body = html.slice(start, html.indexOf('\n}\n', start));
  assert.match(
    body, /title !== undefined \? \{ title, description \} : null/,
    'a caller-supplied title (the open-objective IPC push, forwarded from /start-task\'s own ' +
      'validation fetch, ws-handlers.js) must let seedObjectiveFromTask skip _fetchTaskForHandoff() ' +
      '— otherwise every board/IPC handoff still pays a redundant GET /api/tasks/:id (TPT16)'
  );
  assert.match(
    body, /buildObjectiveSeed\(task, taskKey\)/,
    'seedObjectiveFromTask must build its seed via the shared buildObjectiveSeed() ' +
      '(objective-origin-task.js, re-exported through chatUI) instead of a locally duplicated template string'
  );
});

test('ws-handlers.js: /start-task forwards the already-fetched task\'s title/description into sendOpenObjective', () => {
  const src = readServerSource('ws-handlers.js');
  assert.match(
    src,
    /sendOpenObjective\(projectPath, taskKey, \{ warning, originTaskKey: taskKey, title: task\.title, description: task\.description \}\)/,
    'the childless-objective branch must forward title/description from its own getTask() fetch, ' +
      'not leave the renderer to re-fetch the same task (TPT16)'
  );
});
