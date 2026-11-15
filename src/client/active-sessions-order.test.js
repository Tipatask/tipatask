import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9324) Left-nav terminal rows run from the earliest-started session to the latest, ordered
// by sessionMeta.startedAt (the server's run stamp, from GET /api/sessions and the run's own
// frames), or by a fresh start's localStartedAt until that stamp lands. The real client bundle
// paints the rail markup template.html ships; the terminal renderer, socket and fetch are doubles.
const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');

function railMarkup() {
  const start = template.indexOf('<div class="sidebar-divider" id="active-sessions-divider"');
  const end = template.indexOf('<section id="agent-quota-sidebar"');
  assert.ok(start > 0 && end > start, 'rail markup found');
  return `<div id="left-nav-panel">${template.slice(start, end).replace(/\$\{[^}]*\}/g, 'My Active Tasks')}`;
}

async function withClient(run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-rail-order-'));
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  install('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  install('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  const sockets = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    frame(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  install('WebSocket', Socket);
  // What the next GET /api/sessions answers; every other request gets an empty body.
  let snapshot = { sessions: [] };
  const sessionFetches = [];
  install('fetch', async (url) => {
    if (String(url) === '/api/sessions') sessionFetches.push(snapshot);
    const body = String(url) === '/api/sessions' ? snapshot : {};
    return { ok: true, json: async () => body };
  });
  let state;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export { default as state } from './src/client/state.js';
        export * as modal from './src/client/console-modal.js';
        export * as board from './src/client/task-board.js';
        export * as attention from './src/client/attention-state.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(b) {
        b.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        b.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
          export class FitAddon { fit() {} }
          export class Terminal {
            cols = 80; rows = 24; buffer = { active: { viewportY: 0, baseY: 0 } };
            loadAddon() {} onData() {} attachCustomKeyEventHandler() {} refresh() {} focus() {}
            clear() {} scrollToBottom() {} dispose() {} write(data, done) { done?.(); }
            open(parent) { this.element = document.createElement('div'); parent.appendChild(this.element); }
          }` }));
      } }],
    });
    const bundle = join(scratch, 'client.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const api = await import(pathToFileURL(bundle).href);
    ({ state } = api);
    state.taskAgent = 'claude'; state.taskAgentLabel = 'Claude Code';
    document.body.innerHTML = railMarkup();
    window.TipTask = { taskBoard: api.board, openTerminal: api.modal.openTerminal };
    const task = (id, title, status = 'in_progress') => {
      state.taskTitleById.set(id, title);
      state.taskStatusById.set(id, status);
    };
    const rail = () => [...document.querySelectorAll('#active-sessions-list > .active-session-item')]
      .map(row => row.dataset.taskId || row.dataset.chatId);
    const row = id => document.querySelector(`#active-sessions-list > .active-session-item[data-task-id="${id}"]`);
    const until = async predicate => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('DOM transition timed out');
    };
    await run({ ...api, window, sockets, sessionFetches, task, rail, row, until, serve: next => { snapshot = next; } });
  } finally {
    state?.activeTerminal?.detach({ refreshBoard: false, persistCodex: false });
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A GET /api/sessions terminal row; `startedAt` null leaves it off, as for a loss record without one.
const terminal = (startedAt, extra = {}) => ({ type: 'terminal', agent: 'claude', label: 'Claude Code', alive: true,
  paused: null, ...(startedAt ? { startedAt } : {}), ...extra });
const inventory = (sessionMeta, sessions = Object.keys(sessionMeta)) => ({ sessions, exited: [], attention: [], sessionMeta });

test('terminal rows run from the earliest-started session to the latest, whatever order a snapshot lists them in', async () => {
  await withClient(async ({ state, board, attention, task, rail, row }) => {
    const t0 = Date.now() - 60000;
    task('TPT30', 'Started third');
    task('TPT9', 'Started first');
    task('TPT20', 'Started second, same moment as TPT10');
    task('TPT10', 'Started second');
    task('TPT2', 'No start stamp');
    state.currentUserId = 7;
    state.taskCategoryById.set('TPT77', 'HUMAN');
    task('TPT77', 'Human work');
    const sessionMeta = {
      TPT30: terminal(t0 + 3000), TPT9: terminal(t0 + 1000), TPT20: terminal(t0 + 2000),
      TPT10: terminal(t0 + 2000), TPT2: terminal(null),
      // Chats keep their own places after the terminal rows, even when they started first.
      'taskChat:TPT9': { type: 'taskChat', taskKey: 'TPT9', title: 'Ask about TPT9', startedAt: t0 },
      'projectChat:2:a1': { type: 'taskChat', chatProjectId: 2, title: 'Release plan', startedAt: t0 - 1000 },
    };
    const listed = ['TPT30', 'TPT9', 'TPT20', 'TPT10', 'TPT2', 'taskChat:TPT9', 'projectChat:2:a1'];
    const expected = ['TPT9', 'TPT10', 'TPT20', 'TPT30', 'TPT2', 'taskChat:TPT9', 'projectChat:2:a1'];
    attention.mergeSessionsSnapshot(inventory(sessionMeta, listed));
    board.syncActiveSessionsNav();
    assert.deepEqual(rail(), expected, 'start order, a tie by task id, the unstamped row last, then the chats');

    // The same sessions listed in another order: mergeSessionsSnapshot() replaces the whole set,
    // and the rail stays as it was.
    attention.mergeSessionsSnapshot(inventory(sessionMeta, [...listed].reverse()));
    board.syncActiveSessionsNav();
    assert.deepEqual(rail(), expected);

    // A session gone from the next snapshot keeps its place as a lost row.
    const { TPT9: _gone, ...rest } = sessionMeta;
    attention.mergeSessionsSnapshot(inventory(rest, listed.filter(id => id !== 'TPT9')));
    board.syncActiveSessionsNav();
    assert.deepEqual(rail(), expected);
    assert.ok(row('TPT9').classList.contains('session-lost'));

    // The human section is its own list, after the session list.
    const humanRows = [...document.querySelectorAll('#active-human-tasks-list > .active-session-item')].map(r => r.dataset.taskId);
    assert.deepEqual(humanRows, ['TPT77']);
    const sessionsList = document.getElementById('active-sessions-list');
    const humanList = document.getElementById('active-human-tasks-list');
    assert.ok(sessionsList.compareDocumentPosition(humanList) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

test('a fresh start goes last at once and keeps its place through its server stamp, a refetch, minimize, reopen and completion', async () => {
  await withClient(async ({ state, modal, board, attention, sockets, sessionFetches, task, rail, row, serve, until }) => {
    const t0 = Date.now() - 60000;
    task('TPT50', 'Running since a minute ago');
    task('TPT60', 'Running since a little later');
    // TPT1 sorts first by key, so only its start time can put it last.
    task('TPT1', 'Started now');
    const running = { TPT60: terminal(t0 + 2000), TPT50: terminal(t0 + 1000) };
    attention.mergeSessionsSnapshot(inventory(running));
    board.syncActiveSessionsNav();
    assert.deepEqual(rail(), ['TPT50', 'TPT60']);

    modal.openTerminal('TPT1', 'Started now', 'desc', 'in_progress');
    await until(() => sockets.length === 1);
    assert.ok(new URL(sockets[0].url).searchParams.get('prompt'), 'a fresh start');
    sockets[0].open();
    assert.deepEqual(rail(), ['TPT50', 'TPT60', 'TPT1'], 'the new row is last before any server frame');
    const local = state.sessionMeta.get('TPT1').localStartedAt;
    assert.ok(Number.isFinite(local) && local > t0 + 2000);
    assert.equal(state.sessionMeta.get('TPT1').startedAt, undefined, 'the local stamp is not the run\'s startedAt');

    // The server stamped the run a few ms before this window's onopen: its value takes over.
    const startedAt = local - 5;
    sockets[0].frame({ type: 'config', taskAgent: 'claude', taskAgentLabel: 'Claude Code' });
    sockets[0].frame({ type: 'session:permission-mode-changed', taskId: 'TPT1', tabId: 'TPT1', startedAt,
      requested: null, confirmed: 'auto', pending: false, error: null, supported: false });
    assert.equal(state.sessionMeta.get('TPT1').startedAt, startedAt);
    board.syncActiveSessionsNav();
    assert.deepEqual(rail(), ['TPT50', 'TPT60', 'TPT1']);

    // Minimize: the refetch lists the new run first, and the server's stamp keeps it last.
    serve(inventory({ TPT1: terminal(startedAt), ...running }, ['TPT1', 'TPT60', 'TPT50']));
    state.activeTerminal.detach();
    await until(() => sessionFetches.length === 1 && rail().length === 3 && !row('TPT1').classList.contains('active'));
    assert.deepEqual(rail(), ['TPT50', 'TPT60', 'TPT1']);
    assert.equal(state.sessionMeta.get('TPT1').startedAt, startedAt, 'the snapshot keeps the server value');
    assert.equal(state.sessionMeta.get('TPT1').localStartedAt, undefined);

    // Reopen from the rail: a reattach, identified by the server's stamp; the order holds.
    row('TPT1').click();
    await until(() => sockets.length === 2);
    const reattach = new URL(sockets[1].url).searchParams;
    assert.equal(reattach.get('prompt'), null);
    assert.equal(reattach.get('startedAt'), String(startedAt));
    sockets[1].open();
    assert.deepEqual(rail(), ['TPT50', 'TPT60', 'TPT1']);
    assert.ok(row('TPT1').classList.contains('active'));

    // Completing the task restyles its row in place.
    state.taskStatusById.set('TPT1', 'completed');
    board.syncActiveSessionsNav();
    assert.deepEqual(rail(), ['TPT50', 'TPT60', 'TPT1']);
    assert.ok(row('TPT1').classList.contains('session-completed'));
  });
});

test('a fresh start orders by its local stand-in until the server stamp lands, so that stamp moves nothing', async () => {
  await withClient(async ({ modal, attention, board, sockets, task, rail, until }) => {
    task('TPT0', 'Lost by a build that recorded no start');
    task('TPT50', 'Running');
    task('TPT1', 'Started now');
    attention.mergeSessionsSnapshot({
      ...inventory({ TPT50: terminal(Date.now() - 60000), TPT0: terminal(null, { alive: false }) }, ['TPT50']),
      lost: ['TPT0'], lostDetails: { TPT0: { reason: 'signal:SIGTERM', at: new Date().toISOString() } },
    });
    board.syncActiveSessionsNav();
    assert.deepEqual(rail(), ['TPT50', 'TPT0'], 'a row with no start stamp goes last');
    modal.openTerminal('TPT1', 'Started now', 'desc', 'in_progress');
    await until(() => sockets.length === 1);
    sockets[0].open();
    const expected = ['TPT50', 'TPT1', 'TPT0'];
    assert.deepEqual(rail(), expected, 'before any server frame');
    sockets[0].frame({ type: 'session:permission-mode-changed', taskId: 'TPT1', tabId: 'TPT1', startedAt: Date.now(),
      requested: null, confirmed: 'auto', pending: false, error: null, supported: false });
    board.syncActiveSessionsNav();
    assert.deepEqual(rail(), expected, 'after the server stamp');
  });
});

test('the local stand-in is never sent as the run identity on a reattach', async () => {
  await withClient(async ({ state, modal, attention, board, sockets, task, rail, row, until }) => {
    task('TPT50', 'Running');
    task('TPT1', 'Started now');
    attention.mergeSessionsSnapshot(inventory({ TPT50: terminal(Date.now() - 60000) }));
    board.syncActiveSessionsNav();
    modal.openTerminal('TPT1', 'Started now', 'desc', 'in_progress');
    await until(() => sockets.length === 1);
    sockets[0].open();
    assert.deepEqual(rail(), ['TPT50', 'TPT1']);
    // Minimize and reopen before any frame carried the server's stamp.
    state.activeTerminal.detach({ refreshBoard: false });
    row('TPT1').click();
    await until(() => sockets.length === 2);
    const reattach = new URL(sockets[1].url).searchParams;
    assert.equal(reattach.get('prompt'), null, 'a reattach');
    assert.equal(reattach.get('startedAt'), null, 'only a server stamp identifies the run');
    sockets[1].open();
    assert.deepEqual(rail(), ['TPT50', 'TPT1']);
  });
});
