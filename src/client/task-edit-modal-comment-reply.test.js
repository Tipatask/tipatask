// (TPT9336) Task Edit modal comments: the Reply button fills the composer with a TPT9334 reply
// citation, and a reply renders its citation as a one-line quote with a Show/Hide toggle whose
// state outlives the list's innerHTML rebuilds. (TPT9337) A comment body never shows the agent
// exit comment's end marker. Runs the real client modules (bundled with esbuild) against a
// happy-dom document, with the real `marked` the page loads globally.
// Elements are compared as booleans (`x === null, true`): a failing assert.equal on a happy-dom
// node never finishes printing it, which hangs the whole file instead of failing one test.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9336-comment-reply-'));
let board, state, api, setLocale;

const ALICE = { id: 1, name: 'Alice Smith', email: 'alice@example.com' };
const BOB = { id: 2, name: 'Bob Stone', email: 'bob@example.com' };
const CAROL = { id: 3, name: null, email: 'carol.k@example.com' }; // no display name
const MEMBERS = [
  { user_id: 1, name: 'Alice Smith', email: 'alice@example.com', role: 'owner' },
  { user_id: 2, name: 'Bob Stone', email: 'bob@example.com', role: 'editor' },
  { user_id: 3, name: null, email: 'carol.k@example.com', role: 'editor' },
];
const CITATION_11 = [
  '<!-- tipatask:reply:11 -->',
  '> **Alice Smith:** Deploy is blocked on @Bob Stone.',
  '> Second line of the original.',
  '',
  '@Alice Smith ',
].join('\n');
// The API answers oldest first; the modal lists newest first.
const COMMENTS = [
  { id: 11, content: 'Deploy is blocked on @Bob Stone.\nSecond line of the original.', comment_type: 'comment', created_at: '2026-11-16T09:00:00.000Z', updated_at: null, user: ALICE },
  { id: 12, content: `${CITATION_11}on it today, cc @Bob Stone.`, comment_type: 'comment', created_at: '2026-11-16T09:05:00.000Z', updated_at: null, user: BOB },
  { id: 13, content: 'Words of a deleted user', comment_type: 'comment', created_at: '2026-11-16T09:10:00.000Z', updated_at: null, user: null },
  { id: 14, content: 'Checked the logs.\n\n<!-- tipatask:agent-exit -->', comment_type: 'resolution', created_at: '2026-11-16T09:15:00.000Z', updated_at: null, user: CAROL },
];

let posted = [];
let membersImpl = null;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const modal = () => document.getElementById('task-edit-modal');
const item = id => modal().querySelector(`.comment-item[data-comment-id="${id}"]`);
const composer = () => modal().querySelector('.comment-input');
const citationOf = id => item(id)?.querySelector('.comment-citation');
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

async function openWithComments() {
  await board.openTaskEditModal('TPT1');
  for (let i = 0; i < 5; i++) await tick();
  click(modal().querySelector('.modal-tab-btn[data-tab="comments"]'));
  assert.equal(modal().querySelectorAll('.comment-item').length, COMMENTS.length, 'comments loaded');
}

function replyTo(id) {
  click(item(id).querySelector('.comment-meta .comment-reply-btn'));
  return composer();
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
  const task = { id: 'TPT1', title: 'Title', description: 'Description', status: 'pending', category: 'CODING', priority: 1, tags: [], dependencies: [], assignee: 1, agentAssignee: null };
  api.tasks.get = async () => structuredClone(task);
  api.tasks.listAll = async () => [structuredClone(task)];
  api.tasks.update = async () => ({});
  api.members.list = async () => (membersImpl ? membersImpl() : structuredClone(MEMBERS));
  api.tasks.comments.list = async () => structuredClone(COMMENTS);
  api.tasks.comments.create = async (taskId, content) => {
    posted.push({ taskId, content });
    return { id: 99, content, comment_type: 'comment', created_at: '2026-11-16T10:00:00.000Z', updated_at: null, user: ALICE };
  };
  api.tasks.events.list = async () => ({ events: [], subscribed: true });
});

beforeEach(() => {
  board.closeTaskEditModal(true);
  setLocale('en');
  state.currentUserId = 1;
  posted = [];
  membersImpl = null;
});

after(() => {
  board?.closeTaskEditModal(true);
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  window.happyDOM?.abort?.();
  rmSync(temporary, { recursive: true, force: true });
});

test('every comment row has a Reply button in its meta row', async () => {
  await openWithComments();
  for (const row of modal().querySelectorAll('.comment-item')) {
    const reply = row.querySelector('.comment-meta .comment-reply-btn');
    assert.ok(reply, `comment ${row.dataset.commentId} has Reply`);
    assert.equal(reply.textContent.trim(), 'Reply');
    assert.equal(reply.getAttribute('type'), 'button');
  }
  // Edit stays on the reader's own comment, beside Reply, which comes last.
  const ownActions = item(11).querySelector('.comment-meta .comment-actions');
  assert.deepEqual([...ownActions.children].map(el => el.className), ['comment-edit-btn', 'comment-reply-btn']);
});

test('Reply fills the composer with the citation and @author, focuses it at the end, and Submit posts exactly that', async () => {
  await openWithComments();
  const input = replyTo(11);
  assert.equal(input.value, CITATION_11);
  assert.equal(document.activeElement === input, true, 'composer is focused');
  assert.equal(input.selectionStart, CITATION_11.length);
  assert.equal(input.selectionEnd, CITATION_11.length);

  input.value += 'I will take it.';
  click(modal().querySelector('.comment-submit'));
  for (let i = 0; i < 3; i++) await tick();
  assert.deepEqual(posted, [{ taskId: 'TPT1', content: `${CITATION_11}I will take it.` }]);
  assert.equal(input.value, '');
  // The posted reply heads the regular comments (resolutions stay pinned above them) with its
  // own collapsed citation.
  const regular = [...modal().querySelectorAll('.comment-item[data-comment-type="comment"]')].map(el => el.dataset.commentId);
  assert.deepEqual(regular, ['99', '13', '12', '11']);
  assert.equal(item(99).querySelector('.comment-citation:not(.is-expanded)')?.dataset.citedCommentId, '11');
  assert.equal(item(99).querySelector('.comment-body').textContent.includes('tipatask:reply'), false);
});

test('a comment with no author is quoted without a label or a mention', async () => {
  await openWithComments();
  assert.equal(replyTo(13).value, '<!-- tipatask:reply:13 -->\n> Words of a deleted user\n\n');
});

test('an author with no display name is cited by email local-part; the agent exit marker stays out of the quote', async () => {
  await openWithComments();
  assert.equal(replyTo(14).value, '<!-- tipatask:reply:14 -->\n> **carol.k:** Checked the logs.\n\n@carol.k ');
});

test('an agent exit comment renders without its end marker', async () => {
  await openWithComments();
  const body = item(14).querySelector('.comment-body');
  assert.match(body.textContent, /Checked the logs\./);
  assert.equal(body.textContent.includes('tipatask:agent-exit'), false, 'the marker is not shown');
});

test('only the end marker is hidden: a quote ending in it loses it, code showing it keeps it', async () => {
  const listBefore = api.tasks.comments.list;
  api.tasks.comments.list = async () => [
    // The web's Reply keeps the marker as the last line of an exit comment's quote.
    { id: 31, content: '<!-- tipatask:reply:14 -->\n> **carol.k:** Checked the logs.\n>\n> <!-- tipatask:agent-exit -->\n\n@carol.k Thanks', comment_type: 'comment', created_at: '2026-11-16T09:20:00.000Z', updated_at: null, user: BOB },
    // A comment about the marker: inline code and a code block show it as written.
    { id: 32, content: 'Exit comments end with `<!-- tipatask:agent-exit -->`:\n\n```\nAgent completed the task\n\n<!-- tipatask:agent-exit -->\n```', comment_type: 'comment', created_at: '2026-11-16T09:25:00.000Z', updated_at: null, user: ALICE },
  ];
  try {
    await board.openTaskEditModal('TPT1');
    for (let i = 0; i < 5; i++) await tick();
    click(modal().querySelector('.modal-tab-btn[data-tab="comments"]'));
    assert.match(citationOf(31).querySelector('.comment-citation-text').textContent, /Checked the logs\./);
    assert.equal(item(31).querySelector('.comment-body').textContent.includes('tipatask:agent-exit'), false, 'not in the quote');
    const shown = item(32).querySelector('.comment-body').textContent.split('<!-- tipatask:agent-exit -->').length - 1;
    assert.equal(shown, 2, 'both code samples keep the marker');
  } finally {
    api.tasks.comments.list = listBefore;
  }
});

test('typed text survives Reply, and a second Reply replaces the citation instead of stacking one', async () => {
  await openWithComments();
  composer().value = 'My draft';
  assert.equal(replyTo(11).value, `${CITATION_11}My draft`);
  // Moving the reply to Bob's comment, itself a reply: only its own text is quoted, and the
  // earlier "@Alice Smith " goes with the earlier citation.
  const moved = replyTo(12).value;
  assert.equal(moved, '<!-- tipatask:reply:12 -->\n> **Bob Stone:** @Alice Smith on it today, cc @Bob Stone.\n\n@Bob Stone My draft');
  assert.equal(moved.match(/tipatask:reply:/g).length, 1);
});

test('a row being edited hides its Reply button like its Edit button', async () => {
  await openWithComments();
  click(item(11).querySelector('.comment-edit-btn'));
  assert.ok(item(11).querySelector('.comment-edit-input'), 'row 11 is in edit mode');
  assert.equal(item(11).querySelector('.comment-reply-btn') === null, true, 'no Reply on the row being edited');
  assert.ok(item(12).querySelector('.comment-reply-btn'), 'other rows keep Reply');
  click(item(11).querySelector('.comment-edit-cancel'));
  assert.ok(item(11).querySelector('.comment-reply-btn'));
});

test('a reply renders its citation as a collapsed one-line quote with a toggle; quoted names are not highlighted', async () => {
  await openWithComments();
  const citation = citationOf(12);
  assert.ok(citation, 'reply 12 has a citation');
  assert.equal(citation.classList.contains('is-expanded'), false);
  assert.equal(citation.dataset.citedCommentId, '11');
  assert.equal(citation.querySelector('.comment-citation-author').textContent, 'Alice Smith');
  const quote = citation.querySelector('.comment-citation-text');
  assert.equal(quote.tagName, 'BLOCKQUOTE');
  assert.match(quote.textContent, /Deploy is blocked on @Bob Stone\.\s*Second line of the original\./);
  const toggle = citation.querySelector('.comment-citation-toggle');
  assert.equal(toggle.getAttribute('type'), 'button');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), quote.id);
  assert.equal(toggle.textContent.trim(), 'Show quote');

  const body = item(12).querySelector('.comment-body');
  assert.equal(body.textContent.includes('tipatask:reply'), false, 'the marker is not shown');
  // @Bob Stone is in both the quote and the reply's own text: highlighted only in the latter,
  // since the API notifies nobody for a quoted name. (happy-dom's DOMPurify drops the markup of
  // the leading element, so the reply's opening @Alice Smith mark is not checked here.)
  assert.equal(quote.querySelector('mark.mention') === null, true, 'a quoted name is not highlighted');
  const ownMarks = [...body.querySelectorAll('mark.mention')].filter(m => !m.closest('.comment-citation'));
  assert.deepEqual(ownMarks.map(m => m.textContent), ['@Bob Stone']);
  assert.match(body.textContent, /on it today, cc @Bob Stone\./);
  // Plain comments have no citation.
  for (const id of [11, 13, 14]) assert.equal(citationOf(id) === null, true, `comment ${id}`);
});

test('the toggle expands in place, and the expansion survives a member-list refresh', async () => {
  let resolveMembers;
  membersImpl = () => new Promise(resolve => { resolveMembers = resolve; });
  await openWithComments();
  assert.equal(typeof resolveMembers, 'function', 'the open revalidates members in the background');

  const before = citationOf(12);
  const toggle = before.querySelector('.comment-citation-toggle');
  toggle.focus();
  click(toggle);
  assert.equal(citationOf(12) === before, true, 'toggled in place, no rebuild');
  assert.equal(document.activeElement === toggle, true, 'focus stays on the toggle');
  assert.equal(before.classList.contains('is-expanded'), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.textContent.trim(), 'Hide quote');

  // A changed member list repaints the comments through a full innerHTML rebuild.
  resolveMembers([...structuredClone(MEMBERS), { user_id: 4, name: 'Dana Lee', email: 'dana@example.com', role: 'viewer' }]);
  for (let i = 0; i < 5; i++) await tick();
  const after = citationOf(12);
  assert.equal(after === before, false, 'the list was rebuilt');
  assert.equal(after.classList.contains('is-expanded'), true);
  const afterToggle = after.querySelector('.comment-citation-toggle');
  assert.equal(afterToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(afterToggle.textContent.trim(), 'Hide quote');

  click(afterToggle);
  assert.equal(after.classList.contains('is-expanded'), false);
  assert.equal(afterToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(afterToggle.textContent.trim(), 'Show quote');
});

test('expansion is per open: reopening the task shows the citation collapsed again', async () => {
  await openWithComments();
  click(citationOf(12).querySelector('.comment-citation-toggle'));
  assert.equal(citationOf(12).classList.contains('is-expanded'), true);
  await openWithComments();
  assert.equal(citationOf(12).classList.contains('is-expanded'), false);
});

test("double-clicking the toggle of the reader's own reply does not open edit mode", async () => {
  state.currentUserId = 2; // Bob wrote reply 12
  await openWithComments();
  const toggle = citationOf(12).querySelector('.comment-citation-toggle');
  assert.equal(item(12).querySelector('.comment-body').dataset.act, 'edit', 'the body itself is an edit trigger');
  toggle.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  assert.equal(item(12).querySelector('.comment-edit-input') === null, true, 'no edit mode');
});

test('Reply, Show quote and Hide quote follow the project language', async () => {
  const labels = {
    uk: ['Відповісти', 'Показати цитату', 'Сховати цитату'],
    zh: ['回复', '显示引用', '隐藏引用'],
    es: ['Responder', 'Mostrar cita', 'Ocultar cita'],
    en: ['Reply', 'Show quote', 'Hide quote'],
  };
  for (const [locale, [reply, show, hide]] of Object.entries(labels)) {
    setLocale(locale);
    await openWithComments();
    assert.equal(item(11).querySelector('.comment-reply-btn').textContent.trim(), reply, locale);
    const toggle = citationOf(12).querySelector('.comment-citation-toggle');
    assert.equal(toggle.textContent.trim(), show, locale);
    click(toggle);
    assert.equal(toggle.textContent.trim(), hide, locale);
  }
});

test('a collapsed quote that already fits its one line hides its toggle; a cut one, or one with an image, keeps it', async () => {
  // happy-dom has no layout: give quotes a 19px line and a scroll height from their text length.
  const proto = window.HTMLElement.prototype;
  const saved = ['clientHeight', 'scrollHeight'].map(key => [key, Object.getOwnPropertyDescriptor(proto, key)]);
  const isQuote = el => el.classList?.contains('comment-citation-text');
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return isQuote(this) ? 19 : 0; } });
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return isQuote(this) ? (this.textContent.trim().length > 40 ? 57 : 19) : 0; } });
  const listBefore = api.tasks.comments.list;
  api.tasks.comments.list = async () => [
    { id: 21, content: '<!-- tipatask:reply:11 -->\n> **Alice Smith:** LGTM\n\nThanks', comment_type: 'comment', created_at: '2026-11-16T09:00:00.000Z', user: BOB },
    { id: 22, content: `<!-- tipatask:reply:11 -->\n> **Alice Smith:** ${'A long quoted sentence that cannot fit. '.repeat(3)}\n\nOk`, comment_type: 'comment', created_at: '2026-11-16T09:01:00.000Z', user: BOB },
    { id: 23, content: '<!-- tipatask:reply:11 -->\n> **Alice Smith:** see ![shot](https://example.com/shot.png)\n\nOk', comment_type: 'comment', created_at: '2026-11-16T09:02:00.000Z', user: BOB },
  ];
  try {
    await board.openTaskEditModal('TPT1');
    for (let i = 0; i < 5; i++) await tick();
    click(modal().querySelector('.modal-tab-btn[data-tab="comments"]'));
    assert.equal(citationOf(21).classList.contains('is-whole'), true, 'a quote that fits hides Show quote');
    assert.equal(citationOf(22).classList.contains('is-whole'), false, 'a cut quote keeps Show quote');
    assert.ok(citationOf(23).querySelector('.comment-citation-text img'), 'the quote holds an image');
    assert.equal(citationOf(23).classList.contains('is-whole'), false, 'a collapsed quote hides its image, so it keeps Show quote');
    // An expanded citation is never marked: its Hide quote must stay reachable, including after a
    // rebuild of the list (posting a comment re-renders it).
    click(citationOf(21).querySelector('.comment-citation-toggle'));
    composer().value = 'Plain follow-up';
    click(modal().querySelector('.comment-submit'));
    for (let i = 0; i < 3; i++) await tick();
    assert.ok(item(99), 'the list was rebuilt with the posted comment');
    assert.equal(citationOf(21).classList.contains('is-expanded'), true);
    assert.equal(citationOf(21).classList.contains('is-whole'), false);
    assert.equal(citationOf(22).classList.contains('is-whole'), false);
  } finally {
    api.tasks.comments.list = listBefore;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete proto[key];
    }
  }
});
