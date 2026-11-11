import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { LOCALES } from './i18n.js';

// (TPT9201) The left nav's human section, painted by the real client bundle into the panel markup
// syncLeftNavPanel() ships. CSS and the panel builder are not executable here: they are scanned.
const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function railMarkup() {
  const start = template.indexOf('<div class="sidebar-divider" id="active-sessions-divider"');
  const end = template.indexOf('<section id="agent-quota-sidebar"');
  assert.ok(start > 0 && end > start, 'rail markup found');
  return `<div id="left-nav-panel">${template.slice(start, end).replace(/\$\{[^}]*\}/g, 'My Active Tasks')}`;
}

async function withRail(run) {
  const window = new Window({ url: 'http://localhost:4455/' });
  const scratch = mkdtempSync(join(tmpdir(), 'tt-human-rail-'));
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
  install('fetch', async () => ({ ok: true, json: async () => ({}) }));
  const ipcWrites = [];
  window.electronAPI = { api: { tasks: {
    update: async (id, patch) => { ipcWrites.push({ id, patch }); return { id, ...patch }; },
    delete: async () => ({ ok: true }),
  } } };
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      stdin: { contents: `export { default as state } from './src/client/state.js';
        export * as board from './src/client/task-board.js';
        export * as modal from './src/client/task-edit-modal.js';
        export { api } from './src/client/api-client.js';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
      plugins: [{ name: 'terminal-double', setup(b) {
        b.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'terminal-double' }));
        b.onLoad({ filter: /.*/, namespace: 'terminal-double' }, () => ({ contents: 'export class FitAddon {} export class Terminal {}' }));
      } }],
    });
    const bundle = join(scratch, 'client.mjs');
    writeFileSync(bundle, result.outputFiles[0].contents);
    const client = await import(pathToFileURL(bundle).href);
    document.body.innerHTML = railMarkup();
    const { state } = client;
    state.currentUserId = 7;
    const addHuman = (id, title, status = 'in_progress') => {
      state.taskCategoryById.set(id, 'HUMAN');
      state.taskStatusById.set(id, status);
      state.taskTitleById.set(id, title);
    };
    const el = id => document.getElementById(id);
    const rows = () => [...el('active-human-tasks-list').querySelectorAll('.active-session-item')];
    await run({ ...client, window, addHuman, el, rows, ipcWrites });
  } finally {
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

const hover = (window, row) => row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
const tip = () => document.querySelector('.active-session-tooltip');
const tipDelay = () => new Promise(resolve => setTimeout(resolve, 200));

test('an empty section stays hidden, heading and divider included', () => withRail(async ({ board, el }) => {
  board.syncActiveSessionsNav();
  assert.equal(el('active-human-tasks-list').hidden, true);
  assert.equal(el('active-human-tasks-heading').hidden, true);
  assert.equal(el('active-sessions-divider').hidden, true);
  assert.equal(el('active-human-tasks-list').children.length, 0);
}));

test('a row shows the person icon, key and title, with no close control', () => withRail(async ({ board, addHuman, el, rows }) => {
  addHuman('TPT7', 'Call the <bank>');
  board.syncActiveSessionsNav();
  assert.equal(el('active-human-tasks-list').hidden, false);
  assert.equal(el('active-human-tasks-heading').hidden, false);
  assert.equal(el('active-sessions-divider').hidden, false, 'the section needs the divider with no agent rows');
  assert.equal(el('active-sessions-list').hidden, true, 'the agent list stays hidden');
  const [row] = rows();
  assert.equal(rows().length, 1);
  assert.ok(row.querySelector('.active-session-icon svg circle'), 'person glyph');
  assert.equal(row.querySelector('.active-session-key').textContent, 'TPT7');
  assert.equal(row.querySelector('.active-session-title').textContent, 'Call the <bank>');
  assert.equal(row.dataset.tooltip, 'TPT7 — Call the <bank>');
  assert.equal(row.getAttribute('aria-label'), 'TPT7 — Call the <bank>');
  assert.equal(row.querySelector('.active-session-close'), null);
  assert.equal(row.querySelector('[data-close-task-id]'), null);
  assert.equal(row.hasAttribute('title'), false, 'a native title would fight the rail tooltip');
}));

test('agent and human rows paint side by side, and a session takes the task out of the human list', () => withRail(async ({ board, state, addHuman, el, rows }) => {
  addHuman('TPT7', 'Mine');
  addHuman('TPT8', 'Picked up by an agent');
  state.activeSessions.add('TPT8');
  state.sessionMeta.set('TPT8', { type: 'terminal', agent: 'claude' });
  board.syncActiveSessionsNav();
  assert.deepEqual(rows().map(row => row.dataset.taskId), ['TPT7']);
  assert.deepEqual([...el('active-sessions-list').querySelectorAll('.active-session-item')].map(row => row.dataset.taskId), ['TPT8']);
  state.activeSessions.delete('TPT8');
  board.syncActiveSessionsNav();
  assert.deepEqual(rows().map(row => row.dataset.taskId), ['TPT7', 'TPT8']);
  assert.equal(el('active-sessions-list').hidden, true);
  assert.equal(el('active-sessions-divider').hidden, false);
}));

test('the agent list hides and shows the divider exactly as before when there are no human rows', () => withRail(async ({ board, state, el }) => {
  state.activeSessions.add('TPT8');
  state.sessionMeta.set('TPT8', { type: 'terminal', agent: 'claude' });
  board.syncActiveSessionsNav();
  assert.equal(el('active-sessions-divider').hidden, false);
  assert.equal(el('active-human-tasks-heading').hidden, true);
  state.activeSessions.delete('TPT8');
  board.syncActiveSessionsNav();
  assert.equal(el('active-sessions-divider').hidden, true);
}));

test('a status change leaves the section and hides it again without a stray heading', () => withRail(async ({ board, state, addHuman, el, rows }) => {
  addHuman('TPT7', 'Mine');
  board.syncActiveSessionsNav();
  assert.equal(rows().length, 1);
  state.taskStatusById.set('TPT7', 'completed');
  board.syncActiveSessionsNav();
  assert.equal(rows().length, 0);
  assert.equal(el('active-human-tasks-list').hidden, true);
  assert.equal(el('active-human-tasks-heading').hidden, true);
  assert.equal(el('active-sessions-divider').hidden, true);
}));

test('unchanged rows keep their nodes across repaints', () => withRail(async ({ board, addHuman, rows }) => {
  addHuman('TPT7', 'Mine');
  board.syncActiveSessionsNav();
  const before = rows()[0];
  board.syncActiveSessionsNav();
  assert.equal(rows()[0], before, 'a repaint between mousedown and click must not lose the click');
  addHuman('TPT7', 'Renamed');
  board.syncActiveSessionsNav();
  assert.notEqual(rows()[0], before);
  assert.equal(rows()[0].querySelector('.active-session-title').textContent, 'Renamed');
}));

test('a click opens the edit workspace and never a terminal', () => withRail(async ({ board, window, addHuman, rows }) => {
  const opened = [];
  const terminals = [];
  window.TipTask = { openTerminal: (...args) => terminals.push(args) };
  board.registerTaskWorkspaceOpener((id, opts) => opened.push({ id, pane: opts.initialPane, terminal: opts.terminalLaunch }));
  addHuman('TPT7', 'Mine');
  board.syncActiveSessionsNav();
  rows()[0].click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(opened, [{ id: 'TPT7', pane: 'edit', terminal: null }]);
  assert.deepEqual(terminals, []);
}));

test('tooltips work on both lists, from one shared tip', () => withRail(async ({ board, state, window, addHuman, el, rows }) => {
  addHuman('TPT7', 'Mine');
  state.activeSessions.add('TPT8');
  state.sessionMeta.set('TPT8', { type: 'terminal', agent: 'claude' });
  state.taskTitleById.set('TPT8', 'Agent work');
  board.syncActiveSessionsNav();
  const agentRow = el('active-sessions-list').querySelector('.active-session-item');
  hover(window, rows()[0]);
  await tipDelay();
  assert.equal(tip()?.textContent, 'TPT7 — Mine');
  hover(window, agentRow);
  await tipDelay();
  assert.equal(document.querySelectorAll('.active-session-tooltip').length, 1);
  assert.match(tip()?.textContent, /^TPT8 — Agent work/);
}));

test('rows stay identifiable by tooltip in the collapsed rail', () => withRail(async ({ board, window, addHuman, rows }) => {
  document.body.classList.add('left-nav-collapsed');
  addHuman('TPT7', 'Mine');
  board.syncActiveSessionsNav();
  assert.ok(rows()[0].classList.contains('collapsed'));
  hover(window, rows()[0]);
  await tipDelay();
  assert.equal(tip()?.textContent, 'TPT7 — Mine');
}));

test('a repaint of the agent list cannot take the tooltip off a human row', () => withRail(async ({ board, state, window, addHuman, rows }) => {
  addHuman('TPT7', 'Mine');
  board.syncActiveSessionsNav();
  hover(window, rows()[0]);
  await tipDelay();
  assert.ok(tip());
  state.activeSessions.add('TPT8');
  state.sessionMeta.set('TPT8', { type: 'terminal', agent: 'claude' });
  board.syncActiveSessionsNav();
  assert.ok(tip(), 'the human row was not repainted');
}));

test('a new tooltip host binds on its own, so a remounted rail keeps working', () => withRail(async ({ board, window, addHuman, rows }) => {
  addHuman('TPT7', 'Mine');
  board.syncActiveSessionsNav();
  document.body.innerHTML = railMarkup();
  board.syncActiveSessionsNav();
  hover(window, rows()[0]);
  await tipDelay();
  assert.equal(tip()?.textContent, 'TPT7 — Mine');
}));

test('IPC task writes announce themselves, since main sends this window no echo', () => withRail(async ({ api, ipcWrites }) => {
  const saved = [];
  const removed = [];
  document.addEventListener('tiptask:task-saved', e => saved.push(e.detail.task));
  document.addEventListener('tiptask:task-removed', e => removed.push(e.detail.id));
  const task = await api.tasks.update('TPT7', { status: 'in_progress' });
  assert.deepEqual(task, { id: 'TPT7', status: 'in_progress' });
  assert.deepEqual(saved, [task]);
  assert.deepEqual(ipcWrites, [{ id: 'TPT7', patch: { status: 'in_progress' } }]);
  await api.tasks.delete('TPT7');
  assert.deepEqual(removed, ['TPT7']);
}));

test('the panel ships both elements under the agent list, labelled for assistive tech', () => {
  const agent = template.indexOf('id="active-sessions-list"');
  const heading = template.indexOf('id="active-human-tasks-heading"');
  const list = template.indexOf('id="active-human-tasks-list"');
  assert.ok(agent < heading && heading < list);
  assert.ok(list < template.indexOf('<section id="agent-quota-sidebar"'), 'inside .left-nav-main');
  assert.match(template, /id="active-human-tasks-list"[^>]*aria-labelledby="active-human-tasks-heading"[^>]*hidden/);
  assert.match(template, /id="active-human-tasks-heading"[^>]*hidden/);
});

test('the heading follows a live locale switch', () => {
  assert.match(template, /humanHeading\.textContent = t\('nav\.humanTasks'\)/);
  assert.ok(LOCALES.en['nav.humanTasks']);
  assert.ok(LOCALES.uk['nav.humanTasks']);
  assert.notEqual(LOCALES.uk['nav.humanTasks'], LOCALES.en['nav.humanTasks']);
});

test('an empty list takes no room and neither list grows into a gap', () => {
  assert.match(css, /\.active-sessions-list\[hidden\]\s*\{\s*display:\s*none/);
  const list = css.match(/\n\s*\.active-sessions-list\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(list, /flex:\s*0 1 auto/);
});

test('a crowded rail cannot squash the collapse toggle', () => {
  const toggle = css.match(/\n\s*\.sidebar-toggle\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(toggle, /flex-shrink:\s*0/);
});

test('the heading has no place in the icon-only rail', () => {
  assert.match(css, /body\.left-nav-collapsed \.active-human-tasks-heading\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(max-width: 768px\)\s*\{\s*\.active-human-tasks-heading\s*\{\s*display:\s*none/);
});
