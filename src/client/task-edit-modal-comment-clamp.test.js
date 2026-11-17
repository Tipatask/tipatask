// (TPT9340) Task Edit modal: on the Comments and Notifications sub-tabs the description collapses
// to a three-line clamp with a Show description / Hide description toggle, and a long comment body
// is clamped with a Show more / Show less toggle whose state outlives the list's innerHTML
// rebuilds. Runs the real client modules (bundled with esbuild) against a happy-dom document, with
// the real `marked` the page loads globally. happy-dom has no layout, so element sizes are stubbed:
// an element inside a [hidden] ancestor has no width, like a hidden tab in the browser.
// Elements are compared as booleans (`x === null, true`): a failing assert.equal on a happy-dom
// node never finishes printing it, which hangs the whole file instead of failing one test.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { marked } from 'marked';

const window = new Window({ url: 'http://localhost:4455/' });
const savedGlobals = new Map();
function setGlobal(key, value) {
  if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node', 'DOMParser',
]) setGlobal(key, window[key]);
for (const key of ['window', 'self']) setGlobal(key, window);
setGlobal('navigator', window.navigator);
setGlobal('marked', marked);
setGlobal('requestAnimationFrame', callback => setTimeout(() => callback(Date.now()), 0));
setGlobal('cancelAnimationFrame', id => clearTimeout(id));
class NoopIntersectionObserver { observe() {} unobserve() {} disconnect() {} }
setGlobal('IntersectionObserver', NoopIntersectionObserver);
window.IntersectionObserver = NoopIntersectionObserver;
setGlobal('fetch', async url => ({
  ok: true,
  json: async () => url === '/api/config'
    ? { AVAILABLE_AGENTS: ['claude', 'codex'] }
    : url === '/api/sessions' ? { sessions: [] } : {},
}));

// Layout stubs. A comment body is "tall" when its text runs past 600 characters; the description
// when it runs past 300. A collapsed description shows 83px (its three-line clamp).
const LONG_BODY_PX = 1200;
const SHORT_BODY_PX = 60;
const proto = window.HTMLElement.prototype;
const savedLayout = ['clientWidth', 'clientHeight', 'scrollHeight'].map(key => [key, Object.getOwnPropertyDescriptor(proto, key)]);
const laidOut = el => !el.closest('[hidden]') && el.style?.display !== 'none';
const is = (el, cls) => !!el.classList?.contains(cls);
const contentPx = (el) => {
  if (is(el, 'comment-body')) return el.textContent.trim().length > 600 ? LONG_BODY_PX : SHORT_BODY_PX;
  if (is(el, 'modal-desc-display')) return el.textContent.trim().length > 300 ? 900 : 40;
  return 0;
};
Object.defineProperty(proto, 'clientWidth', { configurable: true, get() {
  return (is(this, 'comments-list') || is(this, 'modal-desc-display')) && laidOut(this) ? 640 : 0;
} });
Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return laidOut(this) ? contentPx(this) : 0; } });
Object.defineProperty(proto, 'clientHeight', { configurable: true, get() {
  if (!laidOut(this)) return 0;
  if (is(this, 'modal-desc-display--collapsed')) return Math.min(83, contentPx(this));
  if (is(this, 'comment-body--clamped')) return 245;
  return contentPx(this);
} });

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9340-comment-clamp-'));
let board, state, api, setLocale;

const ALICE = { id: 1, name: 'Alice Smith', email: 'alice@example.com' };
const BOB = { id: 2, name: 'Bob Stone', email: 'bob@example.com' };
const MEMBERS = [
  { user_id: 1, name: 'Alice Smith', email: 'alice@example.com', role: 'owner' },
  { user_id: 2, name: 'Bob Stone', email: 'bob@example.com', role: 'editor' },
];
const AUDIT_TABLE = [
  '| Task | Status | Notes |',
  '|---|---|---|',
  ...Array.from({ length: 14 }, (_, i) => `| DMR${20 + i} | blocked | Live blog/directory GETs work; query and cache profiling were not repeated on production. |`),
].join('\n');
const LONG_TEXT = 'Checked every journey on the live site and wrote down what changed. '.repeat(14);
// The API answers oldest first; the modal lists newest first, resolutions pinned on top.
const COMMENTS = [
  { id: 41, content: `Audit results:\n\n${AUDIT_TABLE}`, comment_type: 'resolution', created_at: '2026-11-17T09:00:00.000Z', updated_at: null, user: ALICE },
  { id: 42, content: 'Looks good to me.', comment_type: 'comment', created_at: '2026-11-17T09:05:00.000Z', updated_at: null, user: BOB },
  { id: 43, content: LONG_TEXT, comment_type: 'comment', created_at: '2026-11-17T09:10:00.000Z', updated_at: null, user: BOB },
];
const LONG_DESCRIPTION = 'Verify all recent changes and establish whether the live site works across its journeys. '.repeat(8);

let description = LONG_DESCRIPTION;
let membersImpl = null;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const modal = () => document.getElementById('task-edit-modal');
const item = id => modal().querySelector(`.comment-item[data-comment-id="${id}"]`);
const bodyOf = id => item(id)?.querySelector('.comment-body');
const toggleOf = id => item(id)?.querySelector('.comment-clamp-toggle');
const descDisplay = () => modal().querySelector('.modal-desc-display');
const descToggle = () => modal().querySelector('.modal-desc-toggle');
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const showTab = tab => click(modal().querySelector(`.modal-tab-btn[data-tab="${tab}"]`));
const clamped = id => bodyOf(id).classList.contains('comment-body--clamped');
const collapsed = () => descDisplay().classList.contains('modal-desc-display--collapsed');

async function open() {
  await board.openTaskEditModal('TPT1');
  for (let i = 0; i < 5; i++) await tick();
}

async function openWithComments() {
  await open();
  showTab('comments');
  assert.equal(modal().querySelectorAll('.comment-item').length, COMMENTS.length, 'comments loaded');
}

before(async () => {
  document.body.innerHTML = '<div id="task-edit-modal" hidden></div>';
  const bundled = await build({
    stdin: {
      contents: `export * as board from './src/client/task-board.js';
        export { default as state } from './src/client/state.js';
        export { api } from './src/client/api-client.js';
        export { setLocale } from './src/client/i18n.js';`,
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  const bundlePath = join(temporary, 'client.mjs');
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  ({ board, state, api, setLocale } = await import(pathToFileURL(bundlePath).href));
  const task = () => ({ id: 'TPT1', title: 'Title', description, status: 'pending', category: 'CODING', priority: 1, tags: [], dependencies: [], assignee: 1, agentAssignee: null });
  api.tasks.get = async () => task();
  api.tasks.listAll = async () => [task()];
  api.tasks.update = async () => ({});
  api.members.list = async () => (membersImpl ? membersImpl() : structuredClone(MEMBERS));
  api.tasks.comments.list = async () => structuredClone(COMMENTS);
  api.tasks.comments.create = async (taskId, content) => (
    { id: 99, content, comment_type: 'comment', created_at: '2026-11-17T10:00:00.000Z', updated_at: null, user: ALICE });
  api.tasks.events.list = async () => ({ events: [], subscribed: true });
});

beforeEach(() => {
  board.closeTaskEditModal(true);
  setLocale('en');
  state.currentUserId = 1;
  description = LONG_DESCRIPTION;
  membersImpl = null;
});

after(() => {
  board?.closeTaskEditModal(true);
  for (const [key, descriptor] of savedLayout) {
    if (descriptor) Object.defineProperty(proto, key, descriptor);
    else delete proto[key];
  }
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  window.happyDOM?.abort?.();
  rmSync(temporary, { recursive: true, force: true });
});

test('long comment bodies are clamped with Show more; a short one shows whole with no toggle', async () => {
  await openWithComments();
  for (const id of [41, 43]) {
    assert.equal(clamped(id), true, `comment ${id} is clamped`);
    const toggle = toggleOf(id);
    assert.equal(toggle.hidden, false, `comment ${id} shows its toggle`);
    assert.equal(toggle.textContent.trim(), 'Show more');
    assert.equal(toggle.getAttribute('type'), 'button');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.getAttribute('aria-controls'), bodyOf(id).id);
    assert.equal(toggle.parentElement === bodyOf(id).parentElement, true, 'the toggle sits under the body, outside it');
  }
  assert.equal(clamped(42), false, 'a short comment is not clamped');
  assert.equal(toggleOf(42).hidden, true, 'a short comment has no visible toggle');
});

test('nothing is clamped while the Comments tab is hidden; showing it measures', async () => {
  await open();
  assert.equal(modal().querySelectorAll('.comment-body--clamped').length, 0, 'unmeasured on General');
  assert.equal([...modal().querySelectorAll('.comment-clamp-toggle')].every(t => t.hidden), true);
  showTab('comments');
  assert.equal(clamped(41) && clamped(43), true);
});

test('Show more expands one comment in place and leaves the others clamped', async () => {
  await openWithComments();
  const toggle = toggleOf(43);
  const body = bodyOf(43);
  toggle.focus();
  click(toggle);
  assert.equal(bodyOf(43) === body, true, 'toggled in place, no rebuild');
  assert.equal(document.activeElement === toggle, true, 'focus stays on the toggle');
  assert.equal(clamped(43), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.textContent.trim(), 'Show less');
  assert.equal(clamped(41), true, 'the other long comment stays clamped');
  assert.equal(toggleOf(41).textContent.trim(), 'Show more');

  click(toggle);
  assert.equal(clamped(43), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.textContent.trim(), 'Show more');
});

test('the expanded state survives list rebuilds: a member refresh and a posted comment', async () => {
  let resolveMembers;
  membersImpl = () => new Promise(resolve => { resolveMembers = resolve; });
  await openWithComments();
  click(toggleOf(41));
  assert.equal(clamped(41), false);

  // A changed member list repaints the comments through a full innerHTML rebuild.
  const before = bodyOf(41);
  resolveMembers([...structuredClone(MEMBERS), { user_id: 3, name: 'Dana Lee', email: 'dana@example.com', role: 'viewer' }]);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(bodyOf(41) === before, false, 'the list was rebuilt');
  assert.equal(clamped(41), false, 'still expanded');
  assert.equal(toggleOf(41).textContent.trim(), 'Show less');
  assert.equal(toggleOf(41).getAttribute('aria-expanded'), 'true');
  assert.equal(clamped(43), true, 'the other one is still clamped');

  modal().querySelector('.comment-input').value = 'Follow-up';
  click(modal().querySelector('.comment-submit'));
  for (let i = 0; i < 3; i++) await tick();
  assert.ok(item(99), 'the list was rebuilt with the posted comment');
  assert.equal(clamped(41), false);
  assert.equal(clamped(43), true);
  assert.equal(toggleOf(99).hidden, true, 'the short new comment has no toggle');
});

test('expansion is per open: reopening the task clamps the comment again', async () => {
  await openWithComments();
  click(toggleOf(43));
  assert.equal(clamped(43), false);
  await openWithComments();
  assert.equal(clamped(43), true);
});

test('a comment table keeps its cells intact and its toggle sits outside the table', async () => {
  await openWithComments();
  const table = bodyOf(41).querySelector('table');
  assert.ok(table, 'the audit comment renders a table');
  assert.equal(table.querySelectorAll('tbody tr').length, 14);
  assert.equal(table.querySelector('tbody td').textContent, 'DMR20');
  assert.equal(toggleOf(41).closest('table') === null, true);
});

test('Comments and Notifications collapse a long description behind Show description; General shows it whole', async () => {
  await open();
  assert.equal(collapsed(), false, 'whole on General');
  assert.equal(descToggle().hidden, true);

  showTab('comments');
  assert.equal(collapsed(), true);
  assert.equal(descDisplay().classList.contains('is-clipped'), true, 'the cut text is marked for the fade');
  const toggle = descToggle();
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.textContent.trim(), 'Show description');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), descDisplay().id);

  click(toggle);
  assert.equal(collapsed(), false, 'Show description opens it');
  assert.equal(descDisplay().classList.contains('is-clipped'), false);
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.textContent.trim(), 'Hide description');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');

  showTab('notifications');
  assert.equal(collapsed(), false, 'the choice holds between Comments and Notifications');

  showTab('general');
  assert.equal(collapsed(), false);
  assert.equal(toggle.hidden, true, 'no toggle on General');

  showTab('notifications');
  assert.equal(collapsed(), true, 'back from General, it starts compact again');
  assert.equal(toggle.textContent.trim(), 'Show description');

  click(toggle);
  click(toggle);
  assert.equal(collapsed(), true, 'Hide description collapses it again');
  assert.equal(toggle.textContent.trim(), 'Show description');
});

test('a short description goes compact on Comments without a toggle or a fade', async () => {
  description = 'One short line.';
  await open();
  showTab('comments');
  assert.equal(collapsed(), true, 'compact: it does not grow into the list');
  assert.equal(descDisplay().classList.contains('is-clipped'), false);
  assert.equal(descToggle().hidden, true);
});

test('editing the collapsed description hides the toggle; leaving the editor collapses it again', async () => {
  await open();
  showTab('comments');
  assert.equal(descToggle().hidden, false);
  click(descDisplay());
  const textarea = modal().querySelector('#modal-desc-textarea');
  assert.ok(textarea, 'the description editor is open');
  assert.equal(descToggle().hidden, true, 'no toggle while editing');
  textarea.dispatchEvent(new window.Event('blur'));
  assert.equal(modal().querySelector('#modal-desc-textarea') === null, true, 'the editor closed');
  assert.equal(collapsed(), true);
  assert.equal(descToggle().hidden, false);
});

test('both toggle pairs follow the project language', async () => {
  const labels = {
    uk: ['Показати опис', 'Сховати опис', 'Показати більше', 'Показати менше'],
    zh: ['显示描述', '隐藏描述', '显示更多', '收起'],
    es: ['Mostrar descripción', 'Ocultar descripción', 'Mostrar más', 'Mostrar menos'],
    en: ['Show description', 'Hide description', 'Show more', 'Show less'],
  };
  for (const [locale, [showDesc, hideDesc, more, less]] of Object.entries(labels)) {
    setLocale(locale);
    await openWithComments();
    assert.equal(descToggle().textContent.trim(), showDesc, locale);
    click(descToggle());
    assert.equal(descToggle().textContent.trim(), hideDesc, locale);
    assert.equal(toggleOf(43).textContent.trim(), more, locale);
    click(toggleOf(43));
    assert.equal(toggleOf(43).textContent.trim(), less, locale);
  }
});

test('styles.css: the clamps, the toggles and comment tables', () => {
  const styles = readFileSync(join(root, 'src/client/styles.css'), 'utf8');
  const rule = selector => {
    const start = styles.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `${selector} rule exists`);
    return styles.slice(start, styles.indexOf('}', start));
  };
  // The description stops growing and stops at three lines (border-box: plus padding and border).
  const desc = rule('.modal-scroll-body > .modal-desc-display.modal-desc-display--collapsed');
  assert.match(desc, /flex: 0 0 auto;/);
  assert.match(desc, /max-height: calc\(3lh \+ 22px\);/);
  assert.match(desc, /overflow: hidden;/);
  assert.match(rule('.modal-desc-display--collapsed.is-clipped::after'), /linear-gradient\(to bottom, transparent, var\(--c-bg-card\)\)/);
  // A clamped comment shows _COMMENT_CLAMP_LINES lines, faded at the bottom.
  const clampRule = rule('.comment-body--clamped');
  const cssLines = Number(clampRule.match(/max-height: calc\((\d+) \* 1lh\)/)?.[1]);
  const editModal = readFileSync(join(root, 'src/client/task-edit-modal.js'), 'utf8');
  const jsLines = Number(editModal.match(/const _COMMENT_CLAMP_LINES = (\d+);/)?.[1]);
  assert.equal(cssLines, 12);
  assert.equal(jsLines, cssLines, 'task-edit-modal.js measures against the same line count');
  assert.match(clampRule, /overflow: hidden;/);
  assert.match(clampRule, /\bmask-image: linear-gradient\(/);
  // One scroll region: a body no longer scrolls inside the Comments panel, which still does.
  assert.doesNotMatch(rule('.comment-body'), /max-height|overflow-y/);
  assert.match(styles, /\.modal-scroll-body > \.modal-tab-panel\[data-tab="comments"\],\s*\.modal-scroll-body > \.modal-tab-panel\[data-tab="notifications"\] \{\s*flex: 1 1 auto; min-height: 8rem; overflow-y: auto;/);
  // A wide table scrolls sideways inside the comment instead of squeezing its columns.
  const table = rule('.comment-body table');
  assert.match(table, /display: block; width: max-content; max-width: 100%; overflow-x: auto;/);
  assert.match(table, /overflow-wrap: normal; word-break: normal;/);
  assert.match(rule('.comment-body th,\n.comment-body td'), /min-width: 6em;/);
  // A hidden toggle stays hidden although the class sets a display.
  assert.match(styles, /\.modal-desc-toggle\[hidden\],\s*\.comment-clamp-toggle\[hidden\] \{ display: none; \}/);
});
