// (TPT9403) Renders real New Objective proposal cards (chat-task-preview.js renderCardHtml()) in a
// DOM process isolated from node:test globals, wires them as a render does (attachCardHandlers(),
// then task-card.js setupCardInteractions()) and drives the pointer the way a browser reports it:
// mouseover on the element under the pointer, then mouseenter on the card. It checks that the
// card foot (Accept, Reject and the state chip they set) never opens the hover overlay, that the
// title, description and tags still do, and that Accept and Reject work from a collapsed card and
// from an expanded one. happy-dom has no layout, so each foot's top edge is stubbed (FOOT_TOP); the
// pinned foot itself was checked in Chrome. The hover delays run on node:test mock timers, so no
// step races the wall clock. No live API calls: the save transport is a fake.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { marked } from 'marked';

const window = new Window({ url: 'http://localhost:4455/' });
for (const key of [
  'document', 'location', 'HTMLElement', 'HTMLImageElement', 'Event', 'CustomEvent', 'MouseEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'CSS', 'Node',
  'requestAnimationFrame', 'cancelAnimationFrame',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
class TestIntersectionObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.IntersectionObserver = TestIntersectionObserver;
window.IntersectionObserver = TestIntersectionObserver;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
// renderMarkdown() reads the page's global `marked` (a <script> in the app).
globalThis.marked = marked;
window.marked = marked;

// The save transport saveTaskChange() uses for one Accept: read TODO.md, resolve sprints, PUT.
const writes = [];
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, options = {}) => {
  const path = String(url);
  if (path.startsWith('./TODO.md')) return new Response('```json\n' + JSON.stringify({ tasks: [] }) + '\n```');
  if (path === '/api/resolve-sprints') return json(JSON.parse(options.body));
  if (path === '/api/todo') {
    const payload = JSON.parse(options.body.match(/```json\s*([\s\S]*?)```/)[1]);
    writes.push(payload.tasks);
    const remap = {};
    payload.tasks.forEach((t, i) => { remap[t.id] = `TST${100 + writes.length * 10 + i}`; });
    return json({ idRemap: remap });
  }
  return json({});
};

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'tpt9403-dom-'));
const bundlePath = join(temporary, 'client.mjs');
let exitCode = 0;
try {
  const bundled = await build({
    stdin: {
      contents: `export { renderCardHtml, attachCardHandlers } from './src/client/chat-task-preview.js';
        export { setupCardInteractions } from './src/client/task-card.js';
        export { setLocale } from './src/client/i18n.js';
        export { default as state } from './src/client/state.js';`,
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'empty' },
  });
  writeFileSync(bundlePath, bundled.outputFiles[0].contents);
  const { renderCardHtml, attachCardHandlers, setupCardInteractions, setLocale, state }
    = await import(pathToFileURL(bundlePath).href);

  const unhandled = [];
  process.on('unhandledRejection', (err) => unhandled.push(err));
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => {
    const line = args.map(String).join(' ');
    if (!/ExperimentalWarning: The MockTimers API/.test(line)) errors.push(line); // mock.timers' own notice
  };
  // The 250ms hover-expand and 200ms hover-collapse delays advance only on tick(). setImmediate
  // stays real, so flush() lets the fake save transport's promises settle.
  mock.timers.enable({ apis: ['setTimeout'] });
  const tick = ms => mock.timers.tick(ms);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const HOVER_MS = 250;
  const COLLAPSE_MS = 200;

  setLocale('en');
  state.currentUser = { id: 7 };
  const description = [
    'Follow-up for content/core, a separate repository shared with other sites.',
    '',
    '1. List each modified file with a verdict per hunk.',
    '2. Keep the production values and check the upgrade scripts.',
    '3. Re-apply only the confirmed local hunks.',
    '4. Update the domain model document.',
  ].join('\n');
  const proposal = n => ({
    type: 'new',
    task: {
      id: `new-${n}`, title: `Proposal ${n + 1}`, description, priority: 1, category: 'CODING',
      tags: ['bugfix', 'audit'], dependencies: [], status: 'pending',
    },
  });
  const msg = {
    role: 'assistant', content: 'Here is the plan.',
    cards: [0, 1, 2, 3, 4].map(proposal),
    acceptedMask: [true, true, true, true, true],
    confirmedMask: [false, false, false, false, false],
  };
  state.chatState = { messages: [msg] };
  state.activeTab = 'objective';
  document.body.innerHTML = `<div class="objective-modal"><div class="chat-container">
    <div id="chat-messages" class="chat-messages"><div class="chat-bubble chat-bubble--assistant">${renderCardHtml(msg, 0)}</div></div>
  </div></div>`;
  attachCardHandlers();
  setupCardInteractions(document.querySelector('.chat-container'));

  const cards = [...document.querySelectorAll('.preview-card')];
  assert.equal(cards.length, 5);
  // Layout stand-in: every card's foot starts 300px down; the description sits above it.
  const FOOT_TOP = 300;
  const ABOVE_FOOT = 120;
  const ON_FOOT = 320;
  for (const card of cards) {
    const foot = card.querySelector(':scope > .preview-card-actions');
    assert.ok(foot, 'the foot is the card\'s own child');
    foot.getBoundingClientRect = () => ({ top: FOOT_TOP, bottom: FOOT_TOP + 60, left: 0, right: 270, width: 270, height: 60, x: 0, y: FOOT_TOP });
  }
  const parts = card => ({
    title: card.querySelector('.preview-title'),
    desc: card.querySelector('.preview-desc'),
    tag: card.querySelector('.card-tags .tag-badge') || card.querySelector('.card-tags'),
    accept: card.querySelector('.btn-accept-card'),
    reject: card.querySelector('.btn-reject-card'),
    select: card.querySelector('.step-selector'),
  });
  // (TPT9406) The state chip exists only for a state other than the default (Rejected, Saving).
  const chipState = card => card.querySelector('.preview-card-state')?.dataset.state ?? null;
  for (const card of cards) {
    const p = parts(card);
    for (const [name, el] of Object.entries(p)) assert.ok(el, `${name} rendered`);
    assert.equal(chipState(card), null, 'a fresh card has no state chip');
  }

  const fire = (el, type, clientY, bubbles = true) =>
    el.dispatchEvent(new window.MouseEvent(type, { bubbles, cancelable: true, clientX: 40, clientY }));
  // The pointer arrives from outside the card onto `el`: mouseover, then mouseenter (UI Events order).
  const enter = (card, el, y) => { fire(el, 'mouseover', y); fire(card, 'mouseenter', y, false); };
  // The pointer moves to another element inside the same card.
  const moveTo = (el, y) => fire(el, 'mouseover', y);
  const leave = (card, y = 900) => fire(card, 'mouseleave', y, false);
  const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  // Card indexes, never nodes: a failing assert on happy-dom nodes hangs in util.inspect.
  const expanded = () => [...document.querySelectorAll('.preview-card.card-expanded')].map(card => Number(card.dataset.cardIdx));
  const count = () => document.querySelector('.save-bar-count')?.textContent;
  const settle = async (card) => {
    for (let i = 0; i < 200 && !card.classList.contains('confirmed'); i++) await flush();
  };

  assert.equal(count(), '5 tasks ready to save');

  // ── 1. Straight onto Reject of a collapsed card: it stays collapsed and the click rejects it ──
  const [c0, c1, c2, c3, c4] = cards;
  let p = parts(c0);
  enter(c0, p.reject.querySelector('.preview-card-action-label'), ON_FOOT);
  tick(HOVER_MS * 2);
  assert.deepEqual(expanded(), [], 'the pointer on Reject must not open the overlay');
  assert.equal(state.expandedCardMode, null);
  click(p.reject);
  assert.equal(c0.classList.contains('card-expanded'), false);
  assert.equal(c0.classList.contains('rejected'), true);
  assert.equal(chipState(c0), 'rejected');
  assert.equal(c0.querySelector('.preview-card-state').textContent, 'Rejected');
  assert.equal(p.reject.getAttribute('aria-pressed'), 'true');
  assert.equal(msg.acceptedMask[0], false);
  assert.equal(count(), '4 tasks ready to save');
  leave(c0);

  // ── 2. Straight onto Accept of a collapsed card: it stays collapsed and the click saves it ──
  p = parts(c1);
  enter(c1, p.accept, ON_FOOT);
  tick(HOVER_MS * 2);
  assert.deepEqual(expanded(), [], 'the pointer on Accept must not open the overlay');
  click(p.accept);
  assert.equal(chipState(c1), 'saving');
  await settle(c1);
  assert.equal(c1.classList.contains('confirmed'), true, `Accept saved the card (${errors.join(' | ')})`);
  assert.equal(c1.classList.contains('card-expanded'), false);
  assert.equal(msg.confirmedMask[1], true);
  assert.ok(writes.at(-1).some(t => t.title === 'Proposal 2'), 'the one task was written');
  assert.equal(count(), '3 tasks ready to save');
  leave(c1);

  // ── 3. The description arms the hover, the foot cancels it before it fires ──
  p = parts(c2);
  enter(c2, p.desc, ABOVE_FOOT);
  tick(HOVER_MS - 1);
  assert.deepEqual(expanded(), [], 'not before the delay');
  moveTo(p.accept, ON_FOOT);
  tick(HOVER_MS * 2);
  assert.deepEqual(expanded(), [], 'reaching the foot within the delay cancels the expansion');

  // ── 4. From the foot back up onto the description, title or tags: the overlay still opens ──
  moveTo(p.desc, ABOVE_FOOT);
  tick(HOVER_MS - 1);
  assert.deepEqual(expanded(), [], 'the delay restarts when the pointer moves up');
  tick(1);
  assert.deepEqual(expanded(), [2], 'the description opens the overlay');
  assert.equal(state.expandedCardMode, 'hover');

  // ── 5. Its own open overlay stays open on the pinned foot; Reject there collapses it ──
  moveTo(p.reject, ON_FOOT);
  tick(COLLAPSE_MS * 2);
  assert.deepEqual(expanded(), [2], 'the open overlay stays open on its own foot');
  click(p.reject);
  assert.deepEqual(expanded(), [], 'Reject inside the overlay collapses it (collapseCard())');
  assert.equal(state.expandedCardMode, null);
  assert.equal(c2.classList.contains('rejected'), true);
  assert.equal(chipState(c2), 'rejected');
  assert.equal(count(), '2 tasks ready to save');
  leave(c2);

  // ── 6. The card's own box: level with the foot is the foot, above it is the card ──
  enter(c3, c3, ON_FOOT);
  tick(HOVER_MS * 2);
  assert.deepEqual(expanded(), [], 'the padding band under and beside the buttons is part of the foot');
  leave(c3);
  for (const target of ['title', 'tag']) {
    enter(c3, parts(c3)[target], ABOVE_FOOT);
    tick(HOVER_MS);
    assert.deepEqual(expanded(), [3], `the ${target} opens the overlay`);
    leave(c3);
    tick(COLLAPSE_MS);
    assert.deepEqual(expanded(), [], 'leaving a hover overlay closes it');
  }
  enter(c3, c3, ABOVE_FOOT);
  tick(HOVER_MS);
  assert.deepEqual(expanded(), [3], 'the side padding above the foot is the card');

  // ── 7. An overlay another card left open still closes when the pointer settles on a foot ──
  leave(c3);
  enter(c4, parts(c4).desc, ABOVE_FOOT); // arms card 5 and holds card 4's collapse
  tick(COLLAPSE_MS);
  assert.deepEqual(expanded(), [3], 'card 5 is armed, so card 4 waits for it');
  moveTo(parts(c4).accept, ON_FOOT); // cancels card 5; card 4 must still close
  tick(COLLAPSE_MS - 1);
  assert.deepEqual(expanded(), [3], 'closing takes the usual delay');
  tick(1);
  assert.deepEqual(expanded(), [], 'the other overlay closed, the hovered foot opened nothing');
  assert.equal(state.expandedCardMode, null);
  leave(c4);

  // ── 8. A pinned (clicked) overlay: Accept inside it saves and collapses it ──
  p = parts(c3);
  click(p.desc);
  assert.deepEqual(expanded(), [3]);
  assert.equal(state.expandedCardMode, 'pinned');
  assert.ok(document.querySelector('.card-overlay-backdrop'), 'a pinned overlay has its backdrop');
  click(p.accept);
  await settle(c3);
  assert.equal(c3.classList.contains('confirmed'), true, `Accept saved the pinned card (${errors.join(' | ')})`);
  assert.deepEqual(expanded(), [], 'Accept inside the pinned overlay collapses it');
  assert.equal(document.querySelector('.card-overlay-backdrop') === null, true, 'the backdrop is gone');
  assert.equal(count(), '1 task ready to save');

  // ── 9. Focus left on a foot button does not hold off the hover; a focused sprint select does ──
  p = parts(c4);
  p.reject.focus();
  assert.equal(document.activeElement === p.reject, true);
  enter(c4, p.desc, ABOVE_FOOT);
  tick(HOVER_MS);
  assert.deepEqual(expanded(), [4], 'a clicked foot button keeps no hold on the card');
  leave(c4);
  tick(COLLAPSE_MS);
  assert.deepEqual(expanded(), []);
  p.select.focus();
  assert.equal(document.activeElement === p.select, true);
  enter(c4, p.desc, ABOVE_FOOT);
  tick(HOVER_MS * 2);
  assert.deepEqual(expanded(), [], 'a focused sprint select still holds the card collapsed');
  leave(c4);
  p.select.blur();

  // ── 10. (TPT9406) Reject is a toggle: pressed again, the card is back in the save, chip gone ──
  p = parts(c0);
  enter(c0, p.reject, ON_FOOT);
  tick(HOVER_MS * 2);
  assert.deepEqual(expanded(), [], 'the pointer on a pressed Reject opens nothing either');
  click(p.reject);
  assert.equal(c0.classList.contains('rejected'), false);
  assert.equal(chipState(c0), null, 'the default state has no chip');
  assert.equal(p.reject.getAttribute('aria-pressed'), 'false');
  assert.equal(msg.acceptedMask[0], true);
  assert.equal(count(), '2 tasks ready to save');
  leave(c0);

  assert.equal(msg.acceptedMask[4], true, 'the last card is still included');
  assert.deepEqual(errors, []);
  await flush();
  assert.deepEqual(unhandled, []);
  console.error = consoleError;
  console.log('TPT9403_PROPOSAL_FOOT_DOM_PASS');
} catch (err) {
  console.log(err?.stack || String(err));
  exitCode = 1;
} finally {
  mock.timers.reset();
  rmSync(temporary, { recursive: true, force: true });
  await window.happyDOM.abort();
  process.exit(exitCode);
}
