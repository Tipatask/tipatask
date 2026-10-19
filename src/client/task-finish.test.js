import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';

// (TPT614) Finish card action — task-finish.js under the same vm + happy-dom harness as
// task-merge.test.js, plus source scans of the wiring that cannot run under node: the `relaunch`
// launch option through task-card.js / console-modal.js / task-edit-modal.js, the board repaint
// sweep, the CSS ring exception and the api-client route.
const read = name => readFileSync(new URL('./' + name, import.meta.url), 'utf8');
const source = read('task-finish.js');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function harness(t, overrides = {}) {
  const window = new Window();
  t.after(() => window.happyDOM.close());
  window.document.body.innerHTML = '<div id="app"><div class="card" data-id="TPT1" data-status="on_fire"><span class="card-title-inner">Feature one</span><div class="card-btn-group"><button class="btn-select-card"><span class="select-dot"></span></button><div class="card-action-menu"><button class="btn-merge-task"></button></div></div></div></div>';
  const calls = { finishPrompt: [], startTaskById: [], openTerminal: [], toasts: [], clipboard: [] };
  window.TipTask = {
    taskCard: { startTaskById: async (key, opts) => { calls.startTaskById.push([key, opts]); } },
    openTerminal: (...args) => { calls.openTerminal.push(args); },
  };
  const env = {
    window, document: window.document, CSS: { escape: v => v }, setTimeout,
    navigator: { clipboard: { writeText: async text => { calls.clipboard.push(text); } } },
    state: {
      leftUncommitted: new Map([['TPT1', { exitId: 'TPT1@1', blockers: ['TASK_COMMIT_MISSING'], status: 'on_fire', at: 1 }]]),
      activeSessions: new Set(), exitedSessions: new Set(['TPT1']), taskTitleById: new Map(), taskStatusById: new Map(),
    },
    api: { tasks: { finishPrompt: async key => { calls.finishPrompt.push(key); return { prompt: 'You are finishing task TPT1.', status: 'on_fire' }; } } },
    t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    escapeAttr: v => String(v).replaceAll('"', '&quot;'),
    showToast: (msg, kind) => { calls.toasts.push([msg, kind || 'info']); },
    isClosedName: s => s === 'completed' || s === 'canceled',
    MAX_DESC_LEN: 6000,
    truncatePrompt: (text, max) => (text.length > max ? text.slice(0, max) + '... (truncated)' : text),
    ...overrides,
  };
  vm.createContext(env);
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), env);
  return { env, calls, card: window.document.querySelector('.card'), app: window.document.getElementById('app') };
}

test('only a flagged, open board card shows the Finish item (after Merge), both dots and the class; the flag or a closed status removes them in place', t => {
  const { env, card } = harness(t);
  env.syncTaskFinishCard(card);
  const menu = card.querySelector('.card-action-menu');
  assert.ok(menu.lastElementChild.classList.contains('btn-finish-task'), 'Finish is the last menu item');
  assert.ok(menu.firstElementChild.classList.contains('btn-merge-task'), 'Merge stays ahead of it');
  assert.equal(card.querySelectorAll('.finish-attention-dot').length, 2);
  assert.ok(card.classList.contains('has-left-uncommitted'));
  assert.match(card.querySelector('.btn-select-card').getAttribute('aria-label'), /tooltip\.selectCard — card\.leftUncommitted/);
  env.syncTaskFinishCard(card); // idempotent: still one button, two dots
  assert.equal(card.querySelectorAll('.btn-finish-task').length, 1);
  assert.equal(card.querySelectorAll('.finish-attention-dot').length, 2);

  card.dataset.status = 'completed';
  env.syncTaskFinishCard(card);
  assert.equal(card.querySelectorAll('.btn-finish-task, .finish-attention-dot').length, 0, 'a closed status hides it before the render-time prune');
  assert.equal(card.classList.contains('has-left-uncommitted'), false);
  assert.equal(card.querySelector('.btn-select-card').getAttribute('aria-label'), 'tooltip.selectCard');

  card.dataset.status = 'on_fire';
  env.state.leftUncommitted.clear();
  env.syncTaskFinishCard(card);
  assert.equal(card.querySelectorAll('.btn-finish-task, .finish-attention-dot').length, 0, 'no flag, no button');

  env.state.leftUncommitted.set('TPT1', { exitId: 'TPT1@2' });
  card.classList.add('card--preview');
  env.syncTaskFinishCard(card);
  assert.equal(card.querySelectorAll('.btn-finish-task').length, 0, 'preview cards never');
});

test('Select keeps the merge marker in its label when both apply', t => {
  const { env, card } = harness(t);
  card.classList.add('has-unmerged-worktree');
  env.syncTaskFinishCard(card);
  assert.equal(card.querySelector('.btn-select-card').getAttribute('aria-label'), 'tooltip.selectCard — card.unmergedWorktree — card.leftUncommitted');
});

test('click fetches the prompt once and relaunches through the Start ladder with { prompt, relaunch: true }', async t => {
  let release;
  const { env, calls, card } = harness(t, {
    api: { tasks: { finishPrompt: key => { calls.finishPrompt.push(key); return new Promise(resolve => { release = resolve; }); } } },
  });
  env.syncTaskFinishCard(card);
  const run = env.finishTaskFromCard('TPT1');
  await env.finishTaskFromCard('TPT1'); // single-flight: the second call is a no-op
  assert.equal(calls.finishPrompt.length, 1);
  assert.equal(card.querySelector('.btn-finish-task').disabled, true, 'disabled while the fetch is in flight');
  release({ prompt: '  You are finishing task TPT1.\n', status: 'on_fire' });
  await run;
  // JSON compare: the opts object is created inside the vm realm (its own Object.prototype).
  assert.equal(JSON.stringify(calls.startTaskById), JSON.stringify([['TPT1', { prompt: 'You are finishing task TPT1.', relaunch: true }]]));
  assert.equal(calls.openTerminal.length, 0);
  assert.equal(calls.toasts.length, 0);
  assert.equal(card.querySelector('.btn-finish-task').disabled, false);
  assert.ok(env.state.leftUncommitted.has('TPT1'), 'the flag is cleared by the fresh launch itself, not by the click');
});

test('a live session never takes a prompt: the text goes to the clipboard and the terminal reattaches', async t => {
  const { env, calls } = harness(t);
  env.state.activeSessions.add('TPT1');
  await env.finishTaskFromCard('TPT1');
  assert.deepEqual(calls.clipboard, ['You are finishing task TPT1.']);
  assert.deepEqual(calls.toasts, [['card.finishPromptCopied', 'info']]);
  assert.deepEqual(calls.openTerminal, [['TPT1', 'Feature one', '', 'on_fire']]);
  assert.equal(calls.startTaskById.length, 0);
});

test('a stale-flag 409 (TASK_COMMITTED / TASK_CLOSED / COMMITS_OFF) drops the flag and the button; other failures keep both', async t => {
  for (const code of ['TASK_COMMITTED', 'TASK_CLOSED', 'COMMITS_OFF']) {
    const { env, calls, card } = harness(t, {
      api: { tasks: { finishPrompt: async () => { throw Object.assign(new Error('nothing to finish'), { statusCode: 409, code }); } } },
    });
    env.syncTaskFinishCard(card);
    await env.finishTaskFromCard('TPT1');
    assert.equal(env.state.leftUncommitted.has('TPT1'), false, code);
    assert.equal(card.querySelectorAll('.btn-finish-task, .finish-attention-dot').length, 0, code);
    assert.deepEqual(calls.toasts, [['card.finishNothingToDo:{"key":"TPT1"}', 'info']], code);
    assert.equal(calls.startTaskById.length, 0, code);
  }
  for (const err of [Object.assign(new Error('Git state unknown'), { statusCode: 409, code: 'GIT_STATE_UNKNOWN' }), Object.assign(new Error('boom'), { statusCode: 500 })]) {
    const { env, calls, card } = harness(t, { api: { tasks: { finishPrompt: async () => { throw err; } } } });
    env.syncTaskFinishCard(card);
    await env.finishTaskFromCard('TPT1');
    assert.equal(env.state.leftUncommitted.has('TPT1'), true, err.message);
    assert.equal(card.querySelectorAll('.btn-finish-task').length, 1, err.message);
    assert.equal(card.querySelector('.btn-finish-task').disabled, false);
    assert.deepEqual(calls.toasts, [[`card.finishFailed:{"msg":"${err.message}"}`, 'error']]);
  }
});

test('initializeTaskFinish binds one delegated click listener and syncs every card', async t => {
  const { env, calls, card, app } = harness(t);
  env.initializeTaskFinish(app);
  env.initializeTaskFinish(app);
  assert.equal(card.querySelectorAll('.btn-finish-task').length, 1, 'initialize paints the flagged card');
  const click = () => card.querySelector('.btn-finish-task').dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
  click();
  await tick(); await tick();
  assert.equal(calls.finishPrompt.length, 1);
  click();
  await tick(); await tick();
  assert.equal(calls.finishPrompt.length, 2, 'one listener, not one per initialize');
  card.classList.add('card--discussing');
  click();
  await tick(); await tick();
  assert.equal(calls.finishPrompt.length, 2, 'a discussing card is inert');
});

// ── Wiring that cannot run under node ──
const cardJs = read('task-card.js');
const modal = read('console-modal.js');
const workspace = read('task-edit-modal.js');
const board = read('task-board.js');
const css = read('styles.css');
const apiClient = read('api-client.js');
const slice = (text, from, to) => { const a = text.indexOf(from); assert.notEqual(a, -1, from); const b = text.indexOf(to, a); assert.notEqual(b, -1, to); return text.slice(a, b); };

test('renderCard / refreshCard / setup wire the Finish item next to Merge and follow the flag', () => {
  assert.match(cardJs, /\$\{deleteBtn\}\$\{mergeBtn\}\$\{finishBtn\}<\/div>/);
  assert.match(cardJs, /const leftUncommitted = !preview && !!state\.leftUncommitted\?\.has\?\.\(t\.id\) && !isCompleteName\(t\.status\) && !isCanceledName\(t\.status\);/);
  assert.match(cardJs, /\$\{manualMerge \? MERGE_DOT : ''\}\$\{leftUncommitted \? FINISH_DOT : ''\}<\/button>`/);
  assert.match(slice(cardJs, 'export function refreshCard(t)', '\n}'), /syncTaskFinishCard\(card\)/);
  assert.match(cardJs, /initializeTaskMerge\(appEl\);\n\s*initializeTaskFinish\(appEl\);/);
  // (TPT9025) updateClaudeButtons() ends in _syncSessionSurfaces(), which also runs while a card
  // drag holds the board half back.
  assert.match(slice(board, 'export function updateClaudeButtons()', '\n}\n'), /_syncSessionSurfaces\(\);$/);
  assert.match(slice(board, 'function _syncSessionSurfaces()', '\n}\n'), /syncAllFinishCards\(\);/);
});

test('relaunch: the Start ladder skips the reattach branch, console-modal sends the prompt past an exited session, the workspace replaces the mounted pane', () => {
  assert.match(slice(cardJs, 'function _startTaskSessionCore(', '\n}'), /const relaunch = !!\(extraOpts && extraOpts\.relaunch\) && !state\.activeSessions\.has\(taskId\);\n\s*const hasSession = !relaunch && \(state\.activeSessions\.has\(taskId\) \|\| state\.exitedSessions\.has\(taskId\)\);/);
  assert.match(slice(modal, 'function wantsRelaunch(', '\n}'), /return !!\(opts\.relaunch \|\| opts\.restartLost\) && !opts\.reconnectOnly && !state\.activeSessions\.has\(taskId\);/);
  assert.match(slice(modal, 'function buildTaskSessionWsExtra(', '\n}'), /const isResume = opts\.reconnectOnly \|\| \(!wantsRelaunch\(taskId, opts\) && \(/);
  const open = slice(modal, 'export function openTerminal(', 'export function openAgentSelectorModal(');
  assert.match(open, /let isResume = opts\.reconnectOnly \|\| \(!wantsRelaunch\(taskId, opts\) && \(/);
  assert.match(open, /state\.activeTerminal\.taskId === taskId && !\(opts\.restartLost \|\| opts\.relaunch\)/);
  assert.match(workspace, /if \(launch\?\.opts\?\.restartLost \|\| launch\?\.opts\?\.relaunch\) _disposePane\('terminal'\);/);
});

test('styles: the flagged card keeps its action menu under the ring, reveals Select at rest, and the finish dot mirrors the merge dot', () => {
  assert.match(css, /\.card\.needs-attention \.card-btn-group \{ display: none !important; \}/);
  assert.match(css, /\.card\.needs-attention\.has-left-uncommitted \.card-btn-group \{ display: flex !important; \}/);
  assert.match(css, /\.card\.needs-attention\.has-left-uncommitted::before \{ display: none; \}/);
  assert.match(css, /\.card\.has-unmerged-worktree \.card-btn-group,\n\s*\.card\.has-left-uncommitted \.card-btn-group,/);
  assert.match(css, /\.merge-attention-dot,\n\s*\.finish-attention-dot \{/);
  assert.match(css, /\.card-btn-group:focus-within > \.btn-select-card \.finish-attention-dot \{ visibility: hidden; \}/);
  assert.match(css, /\.btn-merge-task,\n\s*\.btn-finish-task \{ position: relative; \}/);
});

test('api.tasks.finishPrompt is a direct GET /api/tasks/:id/finish-prompt (no IPC twin)', () => {
  assert.match(slice(apiClient, 'async finishPrompt(id)', '\n    },'), /return _http\('GET', `\/api\/tasks\/\$\{encodeURIComponent\(id\)\}\/finish-prompt`\);/);
  assert.doesNotMatch(slice(apiClient, 'async finishPrompt(id)', '\n    },'), /ipc\./);
});
