import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// (TPT9010) A task started without a visible terminal — the sprint Play All button
// (task-card.js) and the bulk bar's Start (task-board.js, wired to console-modal.js's
// startTaskSession() exactly as template.html does) — shows the server's refusal of that start
// in one error toast naming the refused tasks, with the text the terminal's own red line uses.
// Real client bundle under happy-dom; only xterm, the socket and fetch are replaced. The page's
// timers are installed as the globals so happyDOM.abort() also clears the intervals
// setupCardInteractions() starts (task-merge.js, task-finish.js).
async function withClient(lang, run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-headless-start-'));
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of ['document', 'location', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
    'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) install(key, window[key]);
  install('window', window); install('self', window);
  for (const key of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, window[key].bind(window));
  }
  const expirations = [];
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (delay === 24 * 60 * 60 * 1000) expirations.push(fn);
    return window.setTimeout(fn, delay, ...args);
  };
  const sockets = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
    frame(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    get taskId() { return new URL(this.url).searchParams.get('taskId'); }
  }
  install('WebSocket', Socket);
  // (TPT9013) Every task PATCH, in order — both the Play All fetch and the bulk bar's
  // api.tasks.update() land here — so a test can read what each task's status ended as.
  const patches = [];
  const liveTasks = new Map();
  const reads = [];
  install('fetch', async (url, opts = {}) => {
    const path = new URL(String(url), 'http://localhost:4455/').pathname;
    const match = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (match && opts.method === 'PATCH') {
      const id = decodeURIComponent(match[1]);
      const body = JSON.parse(opts.body);
      patches.push({ id, body });
      const row = liveTasks.get(id) || task(id);
      liveTasks.set(id, { ...row, ...body, agentAssignee: Object.hasOwn(body, 'agent_assignee') ? body.agent_assignee : row.agentAssignee });
    } else if (match && (!opts.method || opts.method === 'GET')) {
      const id = decodeURIComponent(match[1]);
      reads.push(id);
      return { ok: true, status: 200, json: async () => liveTasks.get(id) || null };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export { default as state } from './src/client/state.js';
        export * as cards from './src/client/task-card.js';
        export * as board from './src/client/task-board.js';
        export * as modal from './src/client/console-modal.js';
        export * as attention from './src/client/attention-ws.js';
        export * as attentionState from './src/client/attention-state.js';
        export * as wsClient from './src/client/ws-client.js';
        export { setLocale } from './src/client/i18n.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(b) {
        b.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        b.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: `
          export class FitAddon { fit() {} }
          export class Terminal { loadAddon() {} onData() {} open() {} write() {} dispose() {} }` }));
      } }],
    });
    const bundle = join(scratch, 'client.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const api = await import(pathToFileURL(bundle).href);
    api.setLocale(lang);
    // The board cannot tell who the user is, so it fails open and lets the server's
    // start-time assignee gate (EASSIGNEE) decide — the case these starts must report.
    api.state.currentUserId = null;
    const until = async predicate => {
      for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('DOM transition timed out');
    };
    const secondWindow = () => import(`${pathToFileURL(bundle).href}?second-window`);
    await run({ ...api, sockets, patches, liveTasks, reads, until, secondWindow, expirations });
  } finally {
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('queued batch starts restore only their own unchanged task fields', async (t) => {
  await withClient('en', async ({ state, cards, board, modal, attention, attentionState, wsClient,
    sockets, patches, liveTasks, reads, until, secondWindow, expirations }) => {
    state.availableAgents = ['claude'];
    board.initBulkActionBar(() => {}, {
      onStartTaskSession: (row, agent) => modal.startTaskSession(row.id, row.title, row.description, row.status, { agent }),
      onFetchActiveSessions: async () => {},
    });
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const patchesFor = id => patches.filter(p => p.id === id).map(p => p.body);
    const failed = id => ({ type: 'session-ended', taskId: id, reason: 'start-failed', error: EASSIGNEE });
    let number = 100;
    async function queue(source = 'bulk', chooseAgent = false, earlyFailure = false) {
      const row = task(`TPT${number++}`, { agentAssignee: chooseAgent ? null : 'claude' });
      liveTasks.set(row.id, { ...row });
      state.tiers = { 3: [row] };
      let appEl;
      if (source === 'sprint') {
        appEl = sprintTier(3);
        cards.setupCardInteractions(appEl);
        appEl.querySelector('.btn-sprint-play').click();
      } else {
        state.selectedCardIds.add(row.id);
        document.querySelector('.btn-bulk-start').click();
      }
      if (chooseAgent) await pickAgentInModal('claude', until);
      await until(() => sockets.some(s => s.taskId === row.id));
      const socket = sockets.find(s => s.taskId === row.id);
      socket.frame({ type: 'session-queued', taskId: row.id, position: 1 });
      if (earlyFailure) attention.handleAttentionMessage(failed(row.id));
      await tick();
      if (source === 'bulk') await until(() => state.selectedCardIds.size === 0);
      appEl?.remove();
      return row;
    }

    for (const source of ['sprint', 'bulk']) {
      for (const chooseAgent of [false, true]) {
        await t.test(`${source}, ${chooseAgent ? 'modal' : 'assigned'}: queued EASSIGNEE restores snapshot once`, async () => {
          const row = await queue(source, chooseAgent);
          // Board cache objects can change independently of the saved values.
          row.status = 'in_progress';
          row.agentAssignee = 'claude';
          attention.handleAttentionMessage(failed(row.id));
          // Browser and Electron channels can deliver the same frame to one renderer.
          attention.reportStartFailure(failed(row.id));
          await until(() => patchesFor(row.id).length === 2);
          assert.deepEqual(patchesFor(row.id), chooseAgent
            ? [STARTED_WITH_AGENT, RESTORED_WITH_AGENT] : [STARTED, RESTORED]);
        });
      }
    }
    await t.test('a fast drain before the batch promise settles still restores', async () => {
      const row = await queue('bulk', false, true);
      await until(() => patchesFor(row.id).length === 2);
      assert.deepEqual(patchesFor(row.id), [STARTED, RESTORED]);
    });
    await t.test('a second window cannot roll back the originating window’s batch', async () => {
      const row = await queue();
      const other = await secondWindow();
      const readCount = reads.length;
      other.attention.reportStartFailure(failed(row.id));
      await tick();
      assert.equal(reads.length, readCount);
      assert.deepEqual(patchesFor(row.id), [STARTED]);
      attention.reportStartFailure(failed(row.id));
      await until(() => patchesFor(row.id).length === 2);
    });
    await t.test('a changed status is preserved', async () => {
      const row = await queue();
      liveTasks.get(row.id).status = 'completed';
      attention.reportStartFailure(failed(row.id));
      await tick();
      assert.deepEqual(patchesFor(row.id), [STARTED]);
    });
    await t.test('a changed agent is preserved while status is restored', async () => {
      const row = await queue('bulk', true);
      liveTasks.get(row.id).agentAssignee = 'codex';
      attention.reportStartFailure(failed(row.id));
      await until(() => patchesFor(row.id).length === 2);
      assert.deepEqual(patchesFor(row.id), [STARTED_WITH_AGENT, RESTORED]);
    });
    await t.test('launching inventory is not proof of success; alive inventory is', async () => {
      const row = await queue();
      attentionState.mergeSessionsSnapshot({ sessions: [row.id], sessionMeta: { [row.id]: { alive: false } } });
      attention.reportStartFailure(failed(row.id));
      await until(() => patchesFor(row.id).length === 2);
      const running = await queue();
      attentionState.mergeSessionsSnapshot({ sessions: [running.id], sessionMeta: { [running.id]: { alive: true } } });
      attention.reportStartFailure(failed(running.id));
      await tick();
      assert.deepEqual(patchesFor(running.id), [STARTED]);
    });
    await t.test('successful terminal attach retires rollback and keeps in_progress', async () => {
      const row = await queue();
      const attaching = wsClient.startTerminalSession(row.id);
      const socket = sockets.at(-1);
      socket.frame({ type: 'config' });
      socket.frame({ type: 'terminal-state' });
      assert.equal((await attaching).ok, true);
      attention.reportStartFailure(failed(row.id));
      await tick();
      assert.deepEqual(patchesFor(row.id), [STARTED]);
    });
    for (const cleanup of ['terminated', 'missing-error', 'timeout', 'project-change']) {
      await t.test(`${cleanup} retires rollback`, async () => {
        const row = await queue();
        if (cleanup === 'timeout') expirations.at(-1)();
        else if (cleanup === 'project-change') {
          attentionState.mergeSessionsSnapshot({ sessions: [] }, '/other-project');
        } else attention.reportStartFailure({ type: 'session-ended', taskId: row.id,
          reason: cleanup === 'terminated' ? 'user-terminated' : 'start-failed' });
        const readCount = reads.length;
        attention.reportStartFailure(failed(row.id));
        await tick();
        assert.equal(reads.length, readCount);
        assert.deepEqual(patchesFor(row.id), [STARTED]);
      });
    }
  });
});

const EASSIGNEE = { type: 'error', code: 'EASSIGNEE', message: 'Cannot start a task assigned to another member.' };
const ECLAIM = { type: 'error', code: 'ECLAIM', message: 'Could not assign this task to you. Task start canceled.' };
const ESTART = { type: 'error', code: 'ESTART', params: { label: 'Claude Code', message: 'spawn claude ENOENT' }, message: 'Failed to start Claude Code: spawn claude ENOENT' };
// Literal expected copy: the terminal.error.* text the terminal's own red line shows.
const COPY = {
  en: {
    EASSIGNEE: 'Cannot start a task assigned to another member.',
    ECLAIM: 'Could not assign this task to you. Task start canceled.',
    ESTART: 'Failed to start Claude Code: spawn claude ENOENT',
  },
  uk: {
    EASSIGNEE: 'Не можна запустити задачу, призначену іншому учаснику.',
    ECLAIM: 'Не вдалося призначити цю задачу вам. Запуск задачі скасовано.',
    ESTART: 'Не вдалося запустити Claude Code: spawn claude ENOENT',
  },
};

function task(id, overrides = {}) {
  return { id, title: `Task ${id}`, description: '', status: 'pending', category: 'CODING', agentAssignee: 'claude', assignee: 2, dependencies: [], ...overrides };
}

function errorToasts() {
  return [...document.querySelectorAll('.tt-toast--error .tt-saving-label')].map(label => label.textContent);
}

function resetPage(sockets, patches) {
  for (const toast of document.querySelectorAll('.tt-toast--error')) toast.remove();
  sockets.length = 0;
  patches.length = 0;
}

const STARTED = { status: 'in_progress' };
const RESTORED = { status: 'pending' };
const STARTED_WITH_AGENT = { agent_assignee: 'claude', status: 'in_progress' };
const RESTORED_WITH_AGENT = { status: 'pending', agent_assignee: null };

function sprintTier(priority) {
  const appEl = document.createElement('div');
  appEl.innerHTML = `<div class="tier" data-priority="${priority}"><div class="tier-label" data-priority="${priority}">`
    + `<button type="button" class="btn-sprint-play" data-priority="${priority}"></button></div></div>`;
  document.body.appendChild(appEl);
  return appEl;
}

// The agent-choice modal a batch with unassigned tasks opens (showBulkAgentStartModal()).
async function pickAgentInModal(agent, until) {
  await until(() => document.querySelector('.bulk-agent-start-overlay'));
  const overlay = document.querySelector('.bulk-agent-start-overlay');
  overlay.querySelector(`.agent-picker-option[data-value="${agent}"]`).click();
  overlay.querySelector('.bulk-agent-start-confirm').click();
}

for (const lang of ['en', 'uk']) {
  test(`headless task starts toast the server's refusal (${lang})`, async (t) => {
    await withClient(lang, async ({ state, cards, board, modal, sockets, patches, until }) => {
      const copy = COPY[lang];
      const socketFor = id => sockets.find(socket => socket.taskId === id);
      const patchesFor = id => patches.filter(p => p.id === id).map(p => p.body);
      state.availableAgents = ['claude'];
      // template.html's wiring of the bulk bar.
      board.initBulkActionBar(() => {}, {
        onStartTaskSession: (bulkTask, agent) => modal.startTaskSession(bulkTask.id, bulkTask.title, bulkTask.description || '', bulkTask.status, { agent }),
        onFetchActiveSessions: async () => {},
      });

      await t.test('sprint Play All, agent already assigned', async () => {
        resetPage(sockets, patches);
        state.tiers = { 3: [task('TPT1')] };
        const appEl = sprintTier(3);
        cards.setupCardInteractions(appEl);
        appEl.querySelector('.btn-sprint-play').click();
        await until(() => sockets.length === 1);
        assert.equal(sockets[0].taskId, 'TPT1');
        sockets[0].frame(EASSIGNEE);
        await until(() => errorToasts().length > 0);
        assert.deepEqual(errorToasts(), [`TPT1: ${copy.EASSIGNEE}`]);
        // (TPT9013) The refused task goes back to the status it had before Play All.
        await until(() => patchesFor('TPT1').length === 2);
        assert.deepEqual(patchesFor('TPT1'), [STARTED, RESTORED]);
        appEl.remove();
      });

      await t.test('sprint Play All, agent picked in the modal', async () => {
        resetPage(sockets, patches);
        state.tiers = { 4: [task('TPT5', { agentAssignee: null, assignee: null })] };
        const appEl = sprintTier(4);
        cards.setupCardInteractions(appEl);
        appEl.querySelector('.btn-sprint-play').click();
        await pickAgentInModal('claude', until);
        await until(() => sockets.length === 1);
        sockets[0].frame(ECLAIM);
        await until(() => errorToasts().length > 0);
        assert.deepEqual(errorToasts(), [`TPT5: ${copy.ECLAIM}`]);
        // The agent the modal wrote is taken back too: the task was unassigned.
        await until(() => patchesFor('TPT5').length === 2);
        assert.deepEqual(patchesFor('TPT5'), [STARTED_WITH_AGENT, RESTORED_WITH_AGENT]);
        appEl.remove();
      });

      await t.test('bulk Start: one summary toast, accepted starts left out', async () => {
        resetPage(sockets, patches);
        state.tiers = { 3: [task('TPT2'), task('TPT3'), task('TPT4')] };
        for (const id of ['TPT2', 'TPT3', 'TPT4']) state.selectedCardIds.add(id);
        document.querySelector('.btn-bulk-start').click();
        await until(() => sockets.length === 3);
        socketFor('TPT4').frame({ type: 'config', taskAgent: 'claude' });
        socketFor('TPT4').frame({ type: 'terminal-state', phase: 'executing', taskAgent: 'claude' });
        socketFor('TPT3').frame(EASSIGNEE);
        socketFor('TPT2').frame(EASSIGNEE);
        await until(() => errorToasts().length > 0);
        assert.deepEqual(errorToasts(), [`TPT2, TPT3: ${copy.EASSIGNEE}`]);
        assert.ok(state.activeSessions.has('TPT4'), 'the accepted start is still recorded as running');
        assert.ok(!state.activeSessions.has('TPT2') && !state.activeSessions.has('TPT3'));
        await until(() => state.selectedCardIds.size === 0);
        assert.deepEqual(patchesFor('TPT2'), [STARTED, RESTORED]);
        assert.deepEqual(patchesFor('TPT3'), [STARTED, RESTORED]);
        assert.deepEqual(patchesFor('TPT4'), [STARTED], 'the accepted start keeps in_progress');
      });

      await t.test('bulk Start, agent picked in the modal: one line per reason', async () => {
        resetPage(sockets, patches);
        state.tiers = { 5: [task('TPT6', { agentAssignee: null }), task('TPT7', { agentAssignee: null })] };
        for (const id of ['TPT6', 'TPT7']) state.selectedCardIds.add(id);
        document.querySelector('.btn-bulk-start').click();
        await pickAgentInModal('claude', until);
        await until(() => sockets.length === 2);
        socketFor('TPT7').frame(ECLAIM);
        socketFor('TPT6').frame(ESTART);
        await until(() => errorToasts().length > 0);
        assert.deepEqual(errorToasts(), [`TPT6: ${copy.ESTART}\nTPT7: ${copy.ECLAIM}`]);
        await until(() => state.selectedCardIds.size === 0);
        assert.deepEqual(patchesFor('TPT6'), [STARTED_WITH_AGENT, RESTORED_WITH_AGENT]);
        assert.deepEqual(patchesFor('TPT7'), [STARTED_WITH_AGENT, RESTORED_WITH_AGENT]);
      });

      await t.test('bulk Start: a socket dropped without a frame is left in progress', async () => {
        resetPage(sockets, patches);
        state.tiers = { 6: [task('TPT8')] };
        state.selectedCardIds.add('TPT8');
        document.querySelector('.btn-bulk-start').click();
        await until(() => sockets.length === 1);
        sockets[0].close();
        await until(() => state.selectedCardIds.size === 0);
        assert.deepEqual(errorToasts(), []);
        assert.deepEqual(patchesFor('TPT8'), [STARTED], 'the server may still be starting it');
      });
    });
  });
}
