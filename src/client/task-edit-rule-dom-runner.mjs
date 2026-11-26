// (TPT9417) Drives the real board card, bulk action bar and Task Edit modal under happy-dom in a
// process isolated from node:test globals, against the API's task edit rule (can_edit, TPT9415,
// mapped to canEdit): the card's status select of a task this user may not change is disabled
// with the localized reason as its tooltip, the bulk bar names how many selected tasks it skips
// and writes only the others, and the Task Edit modal locks exactly the tasks can_edit locks.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:4455/' });
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent', 'MouseEvent',
  'KeyboardEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const key of ['requestAnimationFrame', 'cancelAnimationFrame']) globalThis[key] = window[key].bind(window);
class TestIntersectionObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.IntersectionObserver = TestIntersectionObserver;
window.IntersectionObserver = TestIntersectionObserver;
globalThis.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
globalThis.fetch = async url => ({
  ok: true,
  status: 200,
  json: async () => (url === '/api/config' ? { AVAILABLE_AGENTS: ['claude', 'codex', 'pi'] }
    : url === '/api/sessions' ? { sessions: [] } : {}),
});

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9417-dom-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: `export * as board from './src/client/task-board.js';
        export * as cards from './src/client/task-card.js';
        export { default as state } from './src/client/state.js';
        export { api } from './src/client/api-client.js';
        export { setProjectPermissionMode } from './src/client/group-label.js';
        export { setLocale, t, tc, LOCALES } from './src/client/i18n.js';`,
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { board, cards, state, api, setProjectPermissionMode, setLocale, t, tc, LOCALES } = await import(pathToFileURL(bundlePath).href);
  setProjectPermissionMode('auto');
  async function until(predicate, label) {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  // The signed-in user is Alice (1). The API's answer per task, as fromApi() maps it:
  //   OWN    Alice's own task                                  can_edit true
  //   PEER   assigned to Dana, same role, created by Dana      can_edit false
  //   BOSS   assigned to the owner Owen, created by Owen       can_edit false
  //   MADE   assigned to Dana, created by Alice (creator)      can_edit true
  //   OWNED  assigned to Dana, Alice is the project owner      can_edit true
  //   RANKED assigned to Dana, Alice's role ranks above hers   can_edit true
  //   VIEW   unassigned, Alice's role cannot write tasks       can_edit false
  //   LEG    assigned to Dana, from an API without can_edit    no flag
  const task = (id, overrides = {}) => ({
    id, title: `Title ${id}`, description: '', status: 'pending', category: 'CODING', priority: 3, order: 0,
    tags: [], dependencies: [], assignee: 7, createdBy: 7, agentAssignee: 'codex', claudeDesignMode: false, ...overrides,
  });
  const tasks = new Map([
    ['OWN', task('OWN', { assignee: 1, createdBy: 1, canEdit: true })],
    ['PEER', task('PEER', { canEdit: false })],
    ['BOSS', task('BOSS', { assignee: 8, createdBy: 8, canEdit: false })],
    ['MADE', task('MADE', { createdBy: 1, canEdit: true })],
    ['OWNED', task('OWNED', { canEdit: true })],
    ['RANKED', task('RANKED', { canEdit: true })],
    ['VIEW', task('VIEW', { assignee: null, createdBy: 8, canEdit: false })],
    ['LEG', task('LEG')],
  ]);
  const refusal = () => Object.assign(new Error('API 403: {"error":"forbidden","reason":"task_role_rank"}'), { statusCode: 403, code: 'task_role_rank' });
  const refuse = new Set();
  const writes = [];
  const deletes = [];
  let nextUpdate = null; // fields the next PATCH answer adds (a can_edit change)
  api.tasks.update = async (id, patch) => {
    if (refuse.has(id)) throw refusal();
    writes.push({ id, patch: structuredClone(patch) });
    const row = tasks.get(id);
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.dependencies !== undefined) row.dependencies = patch.dependencies;
    if (nextUpdate) { Object.assign(row, nextUpdate); nextUpdate = null; }
    return structuredClone(row);
  };
  api.tasks.delete = async (id) => {
    if (refuse.has(id)) throw refusal();
    deletes.push(id);
    return { ok: true };
  };
  api.tasks.get = async id => structuredClone(tasks.get(id));
  api.tasks.listAll = async () => [...tasks.values()].map(row => structuredClone(row));
  api.members.list = async () => state.projectMembers;
  api.tasks.comments.list = async () => [];
  api.tasks.events.list = async () => ({ events: [], subscribed: true });

  state.activeTab = 'board';
  state.currentUserId = 1;
  state.availableAgents = ['claude', 'codex', 'pi'];
  state.projectMembers = [{ user_id: 1, name: 'Alice' }, { user_id: 7, name: 'Dana' }, { user_id: 8, name: 'Owen' }];
  document.body.innerHTML = '<div id="task-edit-modal" hidden></div><div id="app"></div>';
  const app = document.getElementById('app');
  const reloads = [];
  cards.registerCardCallbacks({
    onShowConfirmModal: (id, prev, next) => board.showConfirmModal(id, prev, next, async () => { reloads.push(id); }),
  });
  const paint = () => {
    const rows = [...tasks.values()];
    app.innerHTML = '<div class="tier" data-priority="3"><div class="tier-cards">'
      + rows.map(row => cards.renderCard(row)).join('') + '</div></div>';
    state.tiers = { 3: rows };
    state.tierKeys = [3];
    cards.setupCardInteractions(app);
  };
  const card = id => app.querySelector(`.card[data-id="${id}"]`);
  const statusSelect = id => card(id).querySelector('.card-status-select');
  const errorToasts = () => [...document.querySelectorAll('.tt-toast--error .tt-saving-label')].map(el => el.textContent);
  const infoToasts = () => [...document.querySelectorAll('.tt-toast--info .tt-saving-label')].map(el => el.textContent);
  const clearToasts = () => document.querySelectorAll('.tt-saving-indicator--toast').forEach(el => el.remove());
  paint();

  // ── The card's status select ──
  const locked = ['PEER', 'BOSS', 'VIEW'];
  const editable = ['OWN', 'MADE', 'OWNED', 'RANKED', 'LEG'];
  for (const id of locked) {
    assert.equal(statusSelect(id).disabled, true, `${id}: status select disabled`);
    assert.equal(card(id).dataset.editLocked, '1', `${id}: card marked view only`);
  }
  for (const id of editable) {
    assert.equal(statusSelect(id).disabled, false, `${id}: status select enabled — creator, owner, higher role, own, no flag`);
    assert.equal(statusSelect(id).hasAttribute('data-tip'), false, `${id}: no lock tooltip`);
    assert.equal(card(id).dataset.editLocked, undefined, `${id}: not marked`);
  }
  // Another member's task names the rule; an unassigned one can only be locked by the role.
  assert.equal(statusSelect('PEER').dataset.tip, t('task.editLocked'));
  assert.equal(statusSelect('PEER').getAttribute('aria-description'), t('task.editLocked'));
  assert.equal(statusSelect('BOSS').dataset.tip, t('task.editLocked'));
  assert.equal(statusSelect('VIEW').dataset.tip, t('task.editLockedRole'));
  // Hovering the locked select shows the reason in the card tooltip.
  statusSelect('PEER').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await until(() => document.querySelector('.card-btn-tooltip'), 'the lock tooltip');
  assert.equal(document.querySelector('.card-btn-tooltip').textContent, t('task.editLocked'));
  statusSelect('PEER').dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  assert.equal(document.querySelector('.card-btn-tooltip'), null);

  // A same-role member cannot change the status of another member's card: no confirm, no write.
  statusSelect('PEER').value = 'completed';
  statusSelect('PEER').dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(statusSelect('PEER').value, 'pending', 'the pick is put back');
  assert.equal(document.querySelector('.modal-overlay'), null, 'no status confirm');
  assert.deepEqual(writes, []);

  // The creator (and the owner, a higher role) can: the confirm writes the status.
  statusSelect('MADE').value = 'on_fire';
  statusSelect('MADE').dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => document.querySelector('.modal-overlay .btn-confirm'), 'the status confirm');
  document.querySelector('.modal-overlay .btn-confirm').click();
  await until(() => writes.length === 1, 'the status write');
  assert.deepEqual(writes, [{ id: 'MADE', patch: { status: 'on_fire' } }]);

  // A refusal at write time (the card's can_edit was stale) names the rule, not a raw 403.
  refuse.add('OWNED');
  statusSelect('OWNED').value = 'completed';
  statusSelect('OWNED').dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => document.querySelector('.modal-overlay .btn-confirm'), 'the second status confirm');
  document.querySelector('.modal-overlay .btn-confirm').click();
  await until(() => errorToasts().length, 'the refusal toast');
  assert.deepEqual(errorToasts(), [t('task.editLocked')]);
  assert.deepEqual(reloads, ['OWNED'], 'the board reloads to pick up the fresh can_edit');
  refuse.delete('OWNED');
  clearToasts();

  // refreshCard() follows the flag a patch carries, and leaves the card alone without one.
  cards.refreshCard({ ...tasks.get('OWN'), canEdit: false });
  assert.equal(statusSelect('OWN').disabled, true);
  assert.equal(card('OWN').dataset.editLocked, '1');
  assert.equal(statusSelect('OWN').dataset.tip, t('task.editLockedRole'), 'own task: the role reason');
  const { canEdit: _dropped, ...withoutFlag } = tasks.get('OWN');
  cards.refreshCard(withoutFlag);
  assert.equal(statusSelect('OWN').disabled, true, 'a patch without the flag keeps the lock');
  cards.refreshCard({ ...tasks.get('OWN'), canEdit: true });
  assert.equal(statusSelect('OWN').disabled, false);
  assert.equal(card('OWN').dataset.editLocked, undefined);
  assert.equal(statusSelect('OWN').hasAttribute('data-tip'), false);
  assert.equal(statusSelect('OWN').hasAttribute('aria-description'), false);

  // The To-Do tab's done box follows the same rule, with the same reason.
  state.todoSprintPriority = 3;
  const todo = document.createElement('div');
  todo.innerHTML = board.renderTodoContent([...tasks.values()].map(row => ({ ...row, agentAssignee: 'human' })), [3]);
  const check = id => todo.querySelector(`.todo-check[data-task-id="${id}"]`);
  for (const id of locked) assert.equal(check(id).disabled, true, `${id}: To-Do box locked`);
  assert.equal(check('PEER').title, t('task.editLocked'));
  assert.equal(check('VIEW').title, t('task.editLockedRole'));
  for (const id of editable) {
    assert.equal(check(id).disabled, false, `${id}: To-Do box usable`);
    assert.equal(check(id).hasAttribute('title'), false);
  }
  console.log('TPT9417_CARD_STATUS_LOCK_PASS');

  // ── The bulk action bar ──
  paint();
  writes.length = 0;
  const renders = [];
  board.initBulkActionBar(async (opts) => { renders.push(opts); paint(); }, {
    onStartTaskSession: async () => ({ ok: true }),
    onFetchActiveSessions: async () => {},
  });
  const bar = document.getElementById('bulk-action-bar');
  const $ = selector => bar.querySelector(selector);
  const select = (...ids) => {
    state.selectedCardIds.clear();
    for (const id of ids) state.selectedCardIds.add(id);
    board.updateBulkActionBar();
  };
  const pickStatus = (status) => {
    $('.bulk-status-select').value = status;
    $('.bulk-status-select').dispatchEvent(new Event('change', { bubbles: true }));
  };
  const chip = () => $('.bulk-view-only');

  const cluster = () => $('.bulk-group--selection');
  select('OWN', 'MADE');
  assert.equal(chip().hidden, true, 'no view-only task selected: no chip');
  assert.equal(cluster().classList.contains('has-view-only'), false);
  select('OWN', 'PEER', 'LEG', 'BOSS');
  assert.equal(chip().hidden, false);
  assert.equal(cluster().classList.contains('has-view-only'), true, 'the selection cluster lays the chip out on its own line');
  assert.equal(chip().textContent, t('bulk.viewOnly', { n: 2 }));
  assert.equal(chip().textContent, '2 view only');
  assert.equal(chip().title, tc('bulk.viewOnlyHint', 2));
  pickStatus('on_fire');
  assert.equal($('.btn-bulk-apply').disabled, false);
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'the bar to close');
  // The other tasks save; the view-only ones get no PATCH and are named as skipped.
  assert.deepEqual(writes, [{ id: 'OWN', patch: { status: 'on_fire' } }, { id: 'LEG', patch: { status: 'on_fire' } }]);
  assert.deepEqual(infoToasts(), [tc('bulk.skippedViewOnly', 2, { ids: 'PEER, BOSS' })]);
  assert.deepEqual(infoToasts(), ['Skipped 2 view-only tasks: PEER, BOSS']);
  assert.deepEqual(errorToasts(), [], 'skipping is no failure');
  clearToasts();

  // Every selected task view only: Apply has nothing to save and says why.
  writes.length = 0;
  select('PEER', 'VIEW');
  assert.equal(chip().textContent, t('bulk.viewOnly', { n: 2 }));
  pickStatus('completed');
  assert.equal($('.btn-bulk-apply').disabled, true);
  assert.equal($('.btn-bulk-apply').title, t('bulk.allViewOnly'));
  $('.btn-bulk-reset').click();
  board.clearBulkSelection();

  // A refusal at write time (stale can_edit) is reported with the skipped tasks, not as a failure,
  // and the board is fetched again.
  refuse.add('RANKED');
  renders.length = 0;
  select('OWN', 'RANKED', 'PEER');
  assert.equal(chip().textContent, t('bulk.viewOnly', { n: 1 }));
  assert.equal(chip().title, tc('bulk.viewOnlyHint', 1));
  pickStatus('pending');
  $('.btn-bulk-apply').click();
  await until(() => bar.hidden, 'the bar to close after a partial refusal');
  assert.deepEqual(writes, [{ id: 'OWN', patch: { status: 'pending' } }]);
  assert.deepEqual(infoToasts(), [tc('bulk.skippedViewOnly', 2, { ids: 'PEER, RANKED' })]);
  assert.deepEqual(errorToasts(), []);
  assert.deepEqual(renders, [{ forceFresh: true }]);
  clearToasts();

  // Only refusals: the bar and its staged edit stay for another try, the board refreshes.
  writes.length = 0;
  renders.length = 0;
  select('RANKED');
  pickStatus('completed');
  $('.btn-bulk-apply').click();
  await until(() => infoToasts().length, 'the refusal report');
  assert.deepEqual(writes, []);
  assert.equal(bar.hidden, false);
  assert.deepEqual(infoToasts(), [tc('bulk.skippedViewOnly', 1, { ids: 'RANKED' })]);
  assert.deepEqual(infoToasts(), ['Skipped 1 view-only task: RANKED']);
  assert.deepEqual(renders, [{ forceFresh: true }]);
  refuse.delete('RANKED');
  $('.btn-bulk-reset').click();
  board.clearBulkSelection();
  clearToasts();

  // Dependencies: only the tasks this user may change get them.
  writes.length = 0;
  select('OWN', 'PEER');
  $('.btn-bulk-deps').click();
  await until(() => document.querySelector('.bulk-deps-overlay'), 'the dependencies dialog');
  assert.equal(document.querySelector('.bulk-deps-overlay h3').textContent, tc('bulk.depsTitle', 1));
  document.querySelector('.bulk-deps-confirm').click();
  await until(() => document.querySelector('.modal-overlay--over-board .btn-confirm'), 'the replace confirm');
  document.querySelector('.modal-overlay--over-board .btn-confirm').click();
  await until(() => writes.length === 1 && infoToasts().length, 'the dependency write');
  assert.deepEqual(writes, [{ id: 'OWN', patch: { dependencies: [] } }]);
  assert.deepEqual(infoToasts(), [tc('bulk.skippedViewOnly', 1, { ids: 'PEER' })]);
  clearToasts();

  // Delete: the view-only task stays; the confirm counts only what it deletes.
  select('OWN', 'BOSS');
  $('.bulk-delete').click();
  await until(() => document.querySelector('.modal-overlay--over-board .btn-confirm'), 'the delete confirm');
  assert.equal(document.querySelector('.modal-overlay--over-board #action-confirm-message').textContent, tc('bulk.confirmDelete', 1));
  document.querySelector('.modal-overlay--over-board .btn-confirm').click();
  await until(() => infoToasts().length, 'the delete report');
  assert.deepEqual(deletes, ['OWN']);
  assert.deepEqual(infoToasts(), [tc('bulk.skippedViewOnly', 1, { ids: 'BOSS' })]);
  clearToasts();

  // Dependencies or Delete with nothing this user may change: refused at once, nothing written.
  writes.length = 0;
  deletes.length = 0;
  select('PEER', 'BOSS');
  $('.btn-bulk-deps').click();
  assert.equal(document.querySelector('.bulk-deps-overlay'), null);
  assert.deepEqual(errorToasts(), [t('bulk.allViewOnly')]);
  clearToasts();
  $('.bulk-delete').click();
  assert.equal(document.querySelector('.modal-overlay'), null);
  assert.deepEqual(errorToasts(), [t('bulk.allViewOnly')]);
  assert.deepEqual(writes, []);
  assert.deepEqual(deletes, []);
  board.clearBulkSelection();
  clearToasts();
  console.log('TPT9417_BULK_VIEW_ONLY_PASS');

  // ── The Task Edit modal ──
  paint();
  writes.length = 0;
  const modal = () => document.getElementById('task-edit-modal');
  const banner = () => modal().querySelector('.modal-readonly-banner');
  const assertEditable = (id) => {
    assert.equal(banner(), null, `${id}: no read-only banner`);
    assert.equal(modal().querySelector('.modal-status-select').disabled, false, `${id}: status select enabled`);
    assert.equal(modal().querySelector('.modal-title-input').readOnly, false, `${id}: title editable`);
  };
  // The creator, the owner and a higher role can edit another member's task; so can anyone on a
  // row from an API without the flag (the assignee comparison is gone).
  for (const id of ['MADE', 'OWNED', 'RANKED', 'LEG', 'OWN']) {
    await board.openTaskEditModal(id);
    assertEditable(id);
    board.closeTaskEditModal(true);
  }
  // A same-role member's task: read-only, the banner names the assignee and the rule.
  await board.openTaskEditModal('PEER');
  assert.equal(banner().textContent, t('modal.readOnlyAssignee', { name: 'Dana' }));
  assert.equal(modal().querySelector('.modal-status-select').disabled, true);
  assert.equal(modal().querySelector('.modal-title-input').readOnly, true);
  assert.equal(modal().querySelector('.btn-modal-save').disabled, true);
  board.closeTaskEditModal(true);
  await board.openTaskEditModal('BOSS');
  assert.equal(banner().textContent, t('modal.readOnlyAssignee', { name: 'Owen' }));
  board.closeTaskEditModal(true);
  // Locked without another assignee: only the role can do that.
  await board.openTaskEditModal('VIEW');
  assert.equal(banner().textContent, t('modal.readOnlyRole'));
  board.closeTaskEditModal(true);

  // A save the API refuses (the task changed hands since it opened) names the rule.
  await board.openTaskEditModal('OWNED');
  refuse.add('OWNED');
  const title = modal().querySelector('.modal-title-input');
  title.value = 'Renamed';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  modal().querySelector('.btn-modal-save').click();
  await until(() => errorToasts().length, 'the save refusal');
  assert.deepEqual(errorToasts(), [t('task.editLocked')]);
  refuse.delete('OWNED');
  board.closeTaskEditModal(true);
  clearToasts();

  // A save that gives the task away (the fresh can_edit is false) locks its card at once.
  writes.length = 0;
  await board.openTaskEditModal('OWN');
  nextUpdate = { canEdit: false };
  const ownTitle = modal().querySelector('.modal-title-input');
  ownTitle.value = 'Handed over';
  ownTitle.dispatchEvent(new Event('input', { bubbles: true }));
  modal().querySelector('.btn-modal-save').click();
  await until(() => writes.length === 1, 'the save');
  await until(() => statusSelect('OWN').disabled, 'the card lock');
  assert.equal(card('OWN').dataset.editLocked, '1');
  board.closeTaskEditModal(true);
  tasks.get('OWN').canEdit = true;
  tasks.get('OWN').title = 'Title OWN';
  console.log('TPT9417_MODAL_CAN_EDIT_PASS');

  // ── Every locale: the reasons and the bar texts are translated, no raw key shows ──
  const rawKey = /\b(?:task|bulk|modal)\.[a-zA-Z]+(?:\.[a-zA-Z]+)?\b/;
  for (const lang of ['en', 'uk', 'zh', 'es']) {
    setLocale(lang);
    paint();
    assert.equal(statusSelect('PEER').dataset.tip, LOCALES[lang]['task.editLocked'], `${lang}: rule reason`);
    assert.equal(statusSelect('VIEW').dataset.tip, LOCALES[lang]['task.editLockedRole'], `${lang}: role reason`);
    assert.doesNotMatch(statusSelect('PEER').outerHTML, rawKey, `${lang}: no raw key on the card`);
    select('OWN', 'PEER', 'BOSS');
    assert.equal(chip().textContent, t('bulk.viewOnly', { n: 2 }));
    assert.ok(chip().textContent.includes('2'), `${lang}: the chip names the count`);
    assert.equal(chip().title, tc('bulk.viewOnlyHint', 2));
    assert.doesNotMatch(chip().outerHTML, rawKey, `${lang}: no raw key on the chip`);
    if (lang !== 'en') {
      assert.notEqual(chip().textContent, LOCALES.en['bulk.viewOnly'].replace('{n}', '2'), `${lang}: chip is translated`);
      assert.notEqual(statusSelect('PEER').dataset.tip, LOCALES.en['task.editLocked'], `${lang}: reason is translated`);
    }
    board.clearBulkSelection();
    await board.openTaskEditModal('PEER');
    assert.equal(banner().textContent, t('modal.readOnlyAssignee', { name: 'Dana' }));
    assert.doesNotMatch(banner().textContent, rawKey, `${lang}: no raw key in the banner`);
    board.closeTaskEditModal(true);
  }
  setLocale('en');
  console.log('TPT9417_LOCALES_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await window.happyDOM.abort();
  rmSync(temporary, { recursive: true, force: true });
  process.exit(exitCode);
}
