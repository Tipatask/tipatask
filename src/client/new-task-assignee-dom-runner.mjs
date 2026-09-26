// Renders the real New Task form in a DOM process isolated from node:test globals and asserts
// the Member Assignee defaulting rules: a fresh form preselects the current user, a draft's
// explicit "(none)" survives, and a pristine preselected form is never saved as a draft.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:4455/' });
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });

class TestIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.IntersectionObserver = TestIntersectionObserver;
window.IntersectionObserver = TestIntersectionObserver;
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt350-dom-'));
const bundlePath = join(temporary, 'client.mjs');
const DRAFT_KEY = 'todo-draft-task';
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: `export * as board from './src/client/task-board.js';
        export { default as state } from './src/client/state.js';
        export { api } from './src/client/api-client.js';`,
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { board, state, api } = await import(pathToFileURL(bundlePath).href);

  // A ReferenceError inside a fire-and-forget `.then()` of the form's handlers would otherwise
  // surface only as an unhandled rejection, so collect them and assert none at the end.
  const unhandled = [];
  process.on('unhandledRejection', (err) => unhandled.push(err));
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  state.projectMembers = [
    { id: 1, user_id: 7, name: 'Ada' },
    { id: 2, user_id: 9, name: 'Grace' },
  ];
  api.members.list = async () => state.projectMembers;
  const reset = (currentUserId) => {
    state.currentUserId = currentUserId;
    state.manualTaskState = null;
    sessionStorage.removeItem(DRAFT_KEY);
  };
  const renderCombo = () => {
    document.body.innerHTML = board.renderNewTaskForm([], []);
    return {
      value: document.querySelector('#new-task-form .member-combo-value').value,
      label: document.querySelector('#new-task-form .member-combo-input').value,
    };
  };

  // A fresh form preselects the current user (id in the hidden value, name in the field).
  reset(7);
  assert.deepEqual(renderCombo(), { value: '7', label: 'Ada' });

  // Current user not resolved yet: no crash, no bogus preselect.
  reset(null);
  assert.deepEqual(renderCombo(), { value: '', label: '' });

  // A saved draft that deliberately picked "(none)" keeps it — the key is present with null.
  reset(7);
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ title: 'Draft', assignee: null }));
  assert.deepEqual(renderCombo(), { value: '', label: '' });

  // A saved draft that picked someone else keeps that pick over the current-user default.
  reset(7);
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ title: 'Draft', assignee: 9 }));
  assert.deepEqual(renderCombo(), { value: '9', label: 'Grace' });

  // An old draft with no assignee key at all gets the current-user default.
  reset(7);
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ title: 'Old draft' }));
  assert.deepEqual(renderCombo(), { value: '7', label: 'Ada' });

  // Draft persistence: a pristine preselected form is not a draft; any real change is.
  reset(7);
  const fresh = board.ensureManualTaskState();
  assert.equal(fresh.assignee, 7);
  board.saveNewTaskDraft();
  assert.equal(sessionStorage.getItem(DRAFT_KEY), null, 'pristine preselected form must not persist a draft');

  fresh.assignee = null; // user explicitly clears the assignee
  board.saveNewTaskDraft();
  assert.equal(JSON.parse(sessionStorage.getItem(DRAFT_KEY)).assignee, null);
  assert.ok(Object.hasOwn(JSON.parse(sessionStorage.getItem(DRAFT_KEY)), 'assignee'),
    'explicit "(none)" must be stored as a key so a rehydrate does not re-default it');

  fresh.assignee = 9;
  board.saveNewTaskDraft();
  assert.equal(JSON.parse(sessionStorage.getItem(DRAFT_KEY)).assignee, 9);

  // Interaction: wire the real handlers, then pick a different member through the combo.
  // attachNewTaskFormHandlers() also kicks off the async config/agent-model repaint that goes
  // through _applyModalAgentModelVisibility, so this doubles as a wiring check for the
  // helpers task-board.js imports from task-edit-modal.js.
  reset(7);
  document.body.innerHTML = board.renderNewTaskForm([], []);
  const form = document.querySelector('#new-task-form');
  board.attachNewTaskFormHandlers(form, {});
  await tick();
  await tick();
  const comboInput = form.querySelector('.member-combo-input');
  comboInput.dispatchEvent(new window.Event('focus'));
  const options = [...document.querySelectorAll('.member-typeahead-option')];
  assert.equal(options.length, 3, 'a (none) row plus the two members');
  assert.ok(options[1].textContent.includes('Ada') && options[2].textContent.includes('Grace'));
  options[2].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(state.manualTaskState.assignee, 9);
  assert.equal(form.querySelector('.member-combo-value').value, '9');
  assert.equal(JSON.parse(sessionStorage.getItem(DRAFT_KEY)).assignee, 9);

  await tick();
  assert.deepEqual(unhandled, [], 'New Task form handlers must not leave an unhandled rejection');

  console.log('TPT350_DOM_PASS');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
