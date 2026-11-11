import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// Exercise the board modal's actual save path, without a task:updated echo or board reload.
const window = new Window({ url: 'http://localhost:4455/' });
const scratch = mkdtempSync(join(tmpdir(), 'tt-dependency-save-'));
const globals = new Map();
let client, updateImpl, reloads;
const tasks = new Map();
const launches = [], confirmations = [];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const card = id => document.querySelector(`.card[data-id="${id}"]`);
const start = id => card(id)?.querySelector('.btn-claude');
const modal = () => document.getElementById('task-edit-modal');
const task = (id, overrides = {}) => ({
  id, title: `Task ${id}`, description: 'Dependency save regression', status: 'Ready',
  category: 'CODING', agentAssignee: 'codex', assignee: 1, dependencies: [], tags: [],
  priority: 1, order: 0, ...overrides,
});

function install(key, value) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

before(async () => {
  for (const key of ['document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event',
    'CustomEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'navigator']) {
    install(key, window[key]);
  }
  install('window', window); install('self', window);
  for (const key of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, window[key].bind(window));
  }
  const Observer = class { observe() {} unobserve() {} disconnect() {} };
  install('IntersectionObserver', Observer);
  window.IntersectionObserver = Observer;
  install('fetch', async url => ({ ok: true, json: async () => url === '/api/sessions' ? {
    sessions: [...client.state.activeSessions],
    exited: [...client.state.exitedSessions],
    queued: [...client.state.queuedSessions].map(([taskId, position]) => ({ taskId, position })),
  } : {} }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    stdin: { contents: `export { default as state } from './src/client/state.js';
      export * as cards from './src/client/task-card.js';
      export * as board from './src/client/task-board.js';
      export * as registry from './src/client/status-registry.js';
      export { api } from './src/client/api-client.js';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  });
  const bundle = join(scratch, 'client.mjs');
  writeFileSync(bundle, result.outputFiles[0].contents);
  client = await import(pathToFileURL(bundle).href);
  client.registry.seedStatuses([
    { name: 'Ready', is_workflow_start: true },
    { name: 'Doing', is_in_progress: true },
    { name: 'completed' }, // Merely a name: still blocks dependencies.
    { name: 'Shipped', is_workflow_complete: true },
    { name: 'Dropped', is_workflow_canceled: true },
  ]);
  client.api.tasks.get = async id => structuredClone(tasks.get(id));
  client.api.tasks.listAll = async () => [...tasks.values()].map(t => structuredClone(t));
  client.api.tasks.update = async (id, patch) => {
    if (updateImpl) await updateImpl(id, patch);
    Object.assign(tasks.get(id), patch);
    for (const [wire, field] of Object.entries({ agent_assignee: 'agentAssignee',
      claude_model: 'claudeModel', codex_model: 'codexModel', pi_model: 'piModel' })) {
      if (wire in patch) tasks.get(id)[field] = patch[wire];
    }
    return structuredClone(tasks.get(id));
  };
  client.api.members.list = async () => [{ id: 1, user_id: 1, name: 'Alice' }];
  client.api.tasks.comments.list = async () => [];
  client.api.tasks.events.list = async () => ({ events: [], subscribed: true });
});

beforeEach(() => {
  client.board.closeTaskEditModal(true);
  tasks.clear();
  updateImpl = null;
  reloads = 0;
  launches.length = confirmations.length = 0;
  for (const key of ['taskStatusById', 'activeSessions', 'exitedSessions', 'queuedSessions',
    'discussingTaskKeys', 'discussLockIntents', 'collapsedTiers', 'expandedTiers', 'statusFilter']) client.state[key].clear();
  client.state.currentUserId = 1;
  client.state.sessionAgent = 'codex';
  client.state.objectiveProviders = [{ id: 'pi', configuredModels: ['test/pi-model', 'test/second-model'] }];
  client.cards.registerCardCallbacks({ onOpenTerminal: (...args) => launches.push(args),
    onShowClaudeConfirmModal: (...args) => confirmations.push(args) });
  client.board.resetProjectTaskList();
  document.body.innerHTML = '<div id="app"></div><div id="task-edit-modal" hidden></div>';
});

after(async () => {
  client?.board.closeTaskEditModal(true);
  client?.registry.resetStatuses();
  await window.happyDOM.abort();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  rmSync(scratch, { recursive: true, force: true });
});

function mount(rows) {
  for (const row of rows) {
    tasks.set(row.id, row);
    client.state.taskStatusById.set(row.id, row.status);
  }
  document.getElementById('app').innerHTML = client.board.renderBoardContent(
    [1], { 1: rows }, client.board.sortTier, client.cards.renderCard);
}

async function editStatus(id, status) {
  await client.board.openTaskEditModal(id, { onLoadAndRender: () => { reloads++; } });
  const select = modal().querySelector('.modal-status-select');
  select.value = status;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

async function save() {
  modal().querySelector('.btn-modal-save').click();
  await tick();
  await tick();
}

const modalStart = () => modal().querySelector('.modal-actions-run [data-action="start"]');
function pickAgent(agent, model) {
  modal().querySelector(`.agent-picker-option[data-value="${agent}"]${model ? `[data-pi-model="${model}"]` : ''}`).click();
}

test('modal agent saves add and remove working Start controls in place for both task categories', async () => {
  for (const category of ['CODING', 'HUMAN']) {
    mount([task('TPT1', { category, agentAssignee: 'human' })]);
    const node = card('TPT1');
    await client.board.openTaskEditModal('TPT1', { onLoadAndRender: () => { reloads++; } });
    assert.equal(start('TPT1'), null);
    assert.equal(node.querySelector('.btn-start-discussion'), null);
    assert.equal(modalStart(), null);
    let release;
    updateImpl = () => new Promise(resolve => { release = resolve; });
    pickAgent('pi', 'test/pi-model');
    await save();
    assert.equal(start('TPT1'), null, 'pending save keeps prior controls');
    assert.equal(modalStart(), null);
    release();
    await tick(); await tick();
    updateImpl = null;
    assert.ok(start('TPT1'));
    assert.ok(modalStart(), 'HUMAN category also gets modal Start after saving an agent');
    assert.equal(start('TPT1').disabled, false);
    assert.equal(card('TPT1'), node, 'card identity and expansion state survive');
    assert.equal(node.dataset.agentAssignee, 'pi');
    assert.equal(node.dataset.piModel, 'test/pi-model');
    start('TPT1').click();
    assert.deepEqual(launches.at(-1).slice(0, 4), ['TPT1', 'Task TPT1', 'Dependency save regression', 'Ready']);
    assert.deepEqual(launches.at(-1)[4], { agent: 'pi', model: 'test/pi-model' });
    assert.equal(launches.length, 1, 'newly inserted Start is bound exactly once');

    const button = start('TPT1');
    pickAgent('pi', 'test/second-model');
    await save();
    assert.equal(start('TPT1'), button, 'model-only save keeps existing listener');
    start('TPT1').click();
    assert.deepEqual(launches.at(-1)[4], { agent: 'pi', model: 'test/second-model' });
    assert.equal(launches.length, 2);

    pickAgent('claude');
    await save();
    start('TPT1').click();
    assert.deepEqual(launches.at(-1)[4], { agent: 'claude' }, 'reassignment ignores remembered Codex and stale Pi model');
    assert.equal(launches.length, 3);
    pickAgent('human');
    assert.ok(start('TPT1'), 'unsaved reassignment retains Start');
    await save();
    assert.equal(start('TPT1'), null);
    assert.equal(node.querySelector('.btn-start-discussion'), null);
    assert.equal(modalStart(), null);
    assert.equal(reloads, 0);
    client.board.closeTaskEditModal(true);
    launches.length = 0;
  }
});

test('rejected assignment saves retain previous controls and launch selection', async () => {
  mount([task('TPT1', { category: 'HUMAN', agentAssignee: 'human' })]);
  await client.board.openTaskEditModal('TPT1');
  updateImpl = async () => { throw new Error('Assignment rejected'); };
  pickAgent('pi', 'test/pi-model');
  const before = card('TPT1').outerHTML;
  await save();
  assert.equal(card('TPT1').outerHTML, before);
  assert.equal(modalStart(), null);
  updateImpl = null;
  await save();
  const button = start('TPT1');
  updateImpl = async () => { throw new Error('Reassignment rejected'); };
  pickAgent('human');
  await save();
  assert.equal(start('TPT1'), button);
  assert.ok(modalStart());
  assert.equal(card('TPT1').dataset.agentAssignee, 'pi');
  start('TPT1').click();
  assert.deepEqual(launches.at(-1)[4], { agent: 'pi', model: 'test/pi-model' });
  assert.equal(modal().querySelector('.btn-modal-save').disabled, false);
});

test('saved assignment refresh retains dependency, member, discussion and session restrictions', () => {
  client.state.discussingTaskKeys.add('LOCKED');
  client.state.activeSessions.add('LIVE');
  client.state.exitedSessions.add('EXITED');
  client.state.queuedSessions.set('QUEUED', 1);
  const rows = ['BLOCKED', 'OTHER', 'LOCKED', 'LIVE', 'EXITED', 'QUEUED', 'CLOSED', 'CANCELED'].map(id => task(id, {
    category: 'HUMAN', agentAssignee: 'human', dependencies: ['DEP'],
    ...(id === 'OTHER' ? { assignee: 2 } : {}),
    ...(id === 'CLOSED' ? { status: 'Shipped' } : {}),
    ...(id === 'CANCELED' ? { status: 'Dropped' } : {}),
    ...(id === 'LIVE' ? { status: 'Doing' } : {}),
  }));
  mount([task('DEP'), ...rows, task('CODING', { status: 'Shipped', agentAssignee: 'human' })]);
  for (const row of rows) client.cards.refreshCard({ ...row, agentAssignee: 'pi', piModel: 'test/pi-model' });
  assert.equal(start('BLOCKED').disabled, true);
  start('BLOCKED').click();
  assert.equal(launches.length, 0);
  for (const id of ['OTHER', 'LOCKED', 'CLOSED', 'CANCELED']) assert.equal(start(id), null, id);
  assert.ok(start('LIVE').querySelector('.session-spinner'));
  for (const id of ['LIVE', 'EXITED', 'QUEUED']) assert.equal(start(id).disabled, false, `${id} stays resumable`);
  start('EXITED').click();
  assert.deepEqual(launches.at(-1)[4], {}, 'existing session retains its own agent');
  client.cards.refreshCard(task('CODING', { status: 'Shipped', agentAssignee: 'pi', piModel: 'test/pi-model' }));
  start('CODING').click();
  assert.deepEqual(confirmations.at(-1)[4], { agent: 'pi', model: 'test/pi-model' }, 'closed CODING still confirms');
});

test('unassigned HUMAN discussion switches to execution only after saving an agent', async () => {
  mount([task('TPT1', { category: 'HUMAN', agentAssignee: null })]);
  client.cards.setupCardInteractions(document.getElementById('app'));
  card('TPT1').querySelector('.btn-start-discussion').click();
  assert.equal(launches.at(-1)[4].discussionMode, true);
  await client.board.openTaskEditModal('TPT1');
  pickAgent('pi', 'test/pi-model');
  await save();
  assert.equal(card('TPT1').querySelector('.btn-start-discussion'), null);
  start('TPT1').click();
  assert.deepEqual(launches.at(-1)[4], { agent: 'pi', model: 'test/pi-model' });
});

test('modal completion unlocks dependent Start in place only after the save succeeds', async () => {
  mount([task('TPT1'), task('TPT2', { dependencies: ['TPT1'] })]);
  const dependent = card('TPT2');
  const button = start('TPT2');
  assert.equal(button.disabled, true);
  let release;
  updateImpl = () => new Promise(resolve => { release = resolve; });
  await editStatus('TPT1', 'Shipped');
  await save();
  assert.equal(button.disabled, true, 'an unsaved or pending draft does not unlock Start');
  assert.equal(client.state.taskStatusById.get('TPT1'), 'Ready');
  release();
  await tick();
  await tick();
  assert.equal(client.state.taskStatusById.get('TPT1'), 'Shipped');
  assert.equal(button.disabled, false);
  assert.equal(button.classList.contains('deps-blocked'), false);
  assert.equal(dependent.hasAttribute('data-deps-blocked'), false);
  assert.doesNotMatch(button.title, /Waiting for/);
  assert.equal(card('TPT2'), dependent);
  assert.equal(start('TPT2'), button, 'existing Start click listener is preserved');
  assert.equal(reloads, 0);
  assert.equal(client.cards.isDepsBlocked(tasks.get('TPT2')), false);
  const rendered = document.createElement('div');
  rendered.innerHTML = client.cards.renderCard(tasks.get('TPT2'));
  assert.equal(rendered.querySelector('.btn-claude').disabled, false, 'renderCard reads the saved status too');
});

test('another open prerequisite keeps Start blocked; canceled and completion roles release it', async () => {
  mount([task('TPT1'), task('TPT2', { status: 'completed' }), task('TPT3', { dependencies: ['TPT1', 'TPT2'] })]);
  await editStatus('TPT1', 'Shipped');
  await save();
  assert.equal(start('TPT3').disabled, true);
  assert.equal(card('TPT3').dataset.depsBlocked, '1');
  assert.equal(start('TPT3').title, 'Waiting for: TPT2');
  client.board.closeTaskEditModal(true);
  await editStatus('TPT2', 'Dropped');
  await save();
  assert.equal(start('TPT3').disabled, false);
  client.board.closeTaskEditModal(true);
  await editStatus('TPT1', 'Ready');
  await save();
  assert.equal(start('TPT3').disabled, true, 'reopening a prerequisite restores the gate');
  assert.equal(start('TPT3').title, 'Waiting for: TPT1');
  assert.equal(reloads, 0);
});

test('a rejected modal save leaves saved dependency status and Start unchanged', async () => {
  mount([task('TPT1'), task('TPT2', { dependencies: ['TPT1'] })]);
  const before = card('TPT2').outerHTML;
  updateImpl = async () => { throw new Error('Save rejected'); };
  await editStatus('TPT1', 'Shipped');
  await save();
  assert.equal(client.state.taskStatusById.get('TPT1'), 'Ready');
  assert.equal(tasks.get('TPT1').status, 'Ready');
  assert.equal(card('TPT2').outerHTML, before);
  assert.equal(modal().querySelector('.btn-modal-save').disabled, false);
  assert.equal(reloads, 0);
});

test('completion by a prerequisite with no Start preserves other card restrictions and Resume', async () => {
  client.state.discussingTaskKeys.add('LOCKED');
  client.state.activeSessions.add('LIVE');
  client.state.exitedSessions.add('EXITED');
  client.state.queuedSessions.set('QUEUED', 1);
  mount([
    task('TPT1', { agentAssignee: 'human' }), task('TPT2'),
    ...['NORMAL', 'HUMAN', 'OTHER', 'LOCKED', 'LIVE', 'EXITED', 'QUEUED'].map(id => task(id, {
      dependencies: ['TPT1', 'TPT2'],
      ...(id === 'HUMAN' ? { agentAssignee: 'human' } : {}),
      ...(id === 'OTHER' ? { assignee: 2 } : {}),
    })),
  ]);
  assert.equal(start('TPT1'), null);
  client.board.updateClaudeButtons();
  await editStatus('TPT1', 'Shipped');
  await save();
  assert.equal(start('NORMAL').disabled, true);
  for (const id of ['LIVE', 'EXITED', 'QUEUED']) assert.equal(start(id).disabled, false, `${id} remains resumable`);
  client.board.closeTaskEditModal(true);
  await editStatus('TPT2', 'Shipped');
  await save();
  assert.equal(start('NORMAL').disabled, false);
  for (const id of ['HUMAN', 'OTHER', 'LOCKED']) assert.equal(start(id), null, `${id} still has no Start`);
  assert.equal(reloads, 0);
});

test('saved dependency edits and a detached prerequisite refresh mounted dependency gates', () => {
  mount([task('TPT1'), task('TPT2', { dependencies: ['TPT1'] })]);
  const dependent = card('TPT2');
  client.cards.refreshCard(task('TPT2'));
  assert.equal(start('TPT2').disabled, false, 'removing the last dependency releases Start');
  client.cards.refreshCard(task('TPT2', { dependencies: ['TPT1'] }));
  assert.equal(start('TPT2').disabled, true);
  card('TPT1').remove();
  client.cards.refreshCard(task('TPT1', { status: 'Shipped' }));
  assert.equal(start('TPT2').disabled, false, 'the saved prerequisite need not have a mounted card');
  assert.equal(card('TPT2'), dependent);
});

test('a modal status save repaints the running console control in place', async () => {
  client.state.activeSessions.add('TPT1');
  mount([task('TPT1')]);
  client.board.updateClaudeButtons();
  const button = start('TPT1');
  assert.equal(button.classList.contains('session-running'), false);
  await editStatus('TPT1', 'Doing');
  await save();
  assert.equal(start('TPT1'), button);
  assert.equal(button.classList.contains('session-running'), true);
  assert.ok(button.querySelector('.session-spinner'));
  assert.equal(reloads, 0);
});
