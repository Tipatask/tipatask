// ── New Objective guidance: the stage line and the empty-state guide (TPT9391) ──
// Two pieces of the Create modal's Objective view that tell the user where a run stands and what
// to do next. chat-ui.js's renderObjectiveContent() renders both; this module owns their markup
// and the rule that picks the stage, and imports neither chat-ui.js nor chat-task-preview.js.
//
// Stage line (`#objective-stage`): one borderless row — a dot, the current stage's name, its place
// among the four stages in their fixed order (planning, proposals ready, saving, saved) as a "2/4"
// counter, and one short sentence on what is happening. It is absent while a chat has nothing to
// report (no turn running, no proposals).
//
// Empty-state guide (`#objective-guide`): only for a plain new objective that has no turn yet —
// what happens after Send, in three steps, and example objectives that fill the composer. (TPT9405)
// It is a popover behind the (?) button in the Create modal's heading row (composer-header.js), and
// it is closed until that button opens it, so the empty view is the heading and the composer.
import { t, tc } from './i18n.js';
import { escapeAttr } from './utils.js';

export const OBJECTIVE_GUIDE_ID = 'objective-guide';
export const OBJECTIVE_HELP_BUTTON_ID = 'objective-help-btn';

export const OBJECTIVE_STAGES = Object.freeze(['planning', 'ready', 'saving', 'saved']);

// The number of example objectives the guide offers (chat.guide.example1 … exampleN).
export const OBJECTIVE_EXAMPLE_COUNT = 3;

// A bulk save closes its chat, so the next paint is the empty composer. The "saved" stage is
// carried across that close here and shown over the empty composer until a chat is on screen
// again or the note is this old.
export const SAVED_NOTE_MS = 2 * 60 * 1000;
let savedNote = null;

export function noteObjectiveSaved(count, now = Date.now()) {
  savedNote = { count: Math.max(0, Number(count) || 0), at: now };
}

export function clearObjectiveSaved() {
  savedNote = null;
}

/**
 * Which stage the Objective view is in, or null when there is none to show.
 *   chatState    — the chat on screen (state.chatState), or null for the empty composer
 *   streaming    — a turn is running
 *   pendingCount — proposals that Save Tasks would write now (accepted, unsaved, not locked)
 * Returns { stage, count }: `count` is the proposals waiting (ready, saving) or written (saved).
 */
export function objectiveStageInfo({ chatState = null, streaming = false, pendingCount = 0, now = Date.now() } = {}) {
  if (!chatState) {
    if (savedNote && now - savedNote.at <= SAVED_NOTE_MS) return { stage: 'saved', count: savedNote.count };
    savedNote = null;
    return null;
  }
  savedNote = null;
  if (streaming) return { stage: 'planning', count: 0 };

  let anyCards = false;
  let saving = false;
  let confirmedCount = 0;
  for (const msg of chatState.messages || []) {
    if (!msg.cards || msg.cards.length === 0) continue;
    anyCards = true;
    if (msg._inFlight) saving = true;
    confirmedCount += (msg.confirmedMask || []).filter(Boolean).length;
  }
  if (!anyCards) return null;
  if (saving) return { stage: 'saving', count: pendingCount };
  if (pendingCount > 0) return { stage: 'ready', count: pendingCount };
  if (confirmedCount > 0) return { stage: 'saved', count: confirmedCount };
  return { stage: 'ready', count: 0 };
}

/** The sentence under the steps. */
export function objectiveStageDetail(info) {
  if (!info) return '';
  if (info.stage === 'planning') return t('chat.stage.planningDetail');
  if (info.stage === 'saving') return t('chat.stage.savingDetail');
  if (info.stage === 'saved') {
    return info.count > 0 ? tc('chat.stage.savedDetail', info.count) : t('chat.stage.savedDetailPlain');
  }
  return info.count > 0 ? tc('chat.stage.readyDetail', info.count) : t('chat.stage.noneDetail');
}

/** The stage's place in OBJECTIVE_STAGES, counted from 1 (the "2" of "2/4"); 0 for no stage. */
function stageNumber(info) {
  return info ? OBJECTIVE_STAGES.indexOf(info.stage) + 1 : 0;
}

// The counter's digits are for the eye only: a screen reader would read "2/4" as a fraction, so
// it gets "Step 2 of 4" from a visually hidden label instead.
function stageCountHtml(n) {
  const total = OBJECTIVE_STAGES.length;
  return `<span aria-hidden="true">${n}/${total}</span>`
    + `<span class="objective-stage-count-label">${escapeAttr(t('chat.stage.step', { n, total }))}</span>`;
}

/** The stage line's markup, or '' when there is no stage. */
export function renderObjectiveStageHtml(info) {
  const n = stageNumber(info);
  if (!n) return '';
  return `<div class="objective-stage" id="objective-stage" data-stage="${info.stage}">`
    + '<span class="objective-stage-dot" aria-hidden="true"></span>'
    + `<span class="objective-stage-name">${escapeAttr(t(`chat.stage.${info.stage}`))}</span>`
    + `<span class="objective-stage-count">${stageCountHtml(n)}</span>`
    + `<p class="objective-stage-detail" role="status">${escapeAttr(objectiveStageDetail(info))}</p>`
    + '</div>';
}

/**
 * Bring a mounted stage line up to date without a repaint: the save paths change the stage
 * between renders. `slot` is `#objective-stage-slot`. A line that is already mounted is patched
 * in place — its stage, name, counter and sentence — so the status sentence stays the same live
 * region and the change is announced.
 */
export function syncObjectiveStageSlot(slot, info) {
  if (!slot) return false;
  const line = slot.querySelector('.objective-stage');
  const n = stageNumber(info);
  if (!n) {
    if (line) slot.innerHTML = '';
    return true;
  }
  const name = line && line.querySelector('.objective-stage-name');
  const count = line && line.querySelector('.objective-stage-count');
  const detail = line && line.querySelector('.objective-stage-detail');
  if (!name || !count || !detail) {
    slot.innerHTML = renderObjectiveStageHtml(info);
    return true;
  }
  line.dataset.stage = info.stage;
  const nameText = t(`chat.stage.${info.stage}`);
  if (name.textContent !== nameText) name.textContent = nameText;
  if (count.firstElementChild?.textContent !== `${n}/${OBJECTIVE_STAGES.length}`) count.innerHTML = stageCountHtml(n);
  const text = objectiveStageDetail(info);
  if (detail.textContent !== text) detail.textContent = text;
  return true;
}

/** The example objective at `index` (0-based) in the project language, or ''. */
export function objectiveExampleText(index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n >= OBJECTIVE_EXAMPLE_COUNT) return '';
  return t(`chat.guide.example${n + 1}`);
}

/**
 * What a picked example does to the composer's text: it fills an empty composer and replaces
 * another example, and is appended under anything the user wrote themselves.
 */
export function applyObjectiveExample(current, index) {
  const example = objectiveExampleText(index);
  if (!example) return String(current ?? '');
  const text = String(current ?? '');
  const trimmed = text.trim();
  if (!trimmed) return example;
  for (let i = 0; i < OBJECTIVE_EXAMPLE_COUNT; i++) {
    if (trimmed === objectiveExampleText(i)) return example;
  }
  if (trimmed.includes(example)) return text;
  return `${text.replace(/\s+$/, '')}\n\n${example}`;
}

/**
 * The guide popover's markup, closed (`hidden`). The heading's (?) button (`aria-controls`) opens
 * it; it is named by that button's label. Each step is one line of text — its title, then what
 * happens — after its number.
 */
export function renderObjectiveGuideHtml() {
  const steps = [1, 2, 3].map(n =>
    `<li class="objective-guide-step"><span class="objective-guide-num" aria-hidden="true">${n}</span>`
    + `<span class="objective-guide-step-text"><strong>${escapeAttr(t(`chat.guide.step${n}Title`))}</strong> `
    + `<span>${escapeAttr(t(`chat.guide.step${n}`))}</span></span></li>`).join('');
  const examples = Array.from({ length: OBJECTIVE_EXAMPLE_COUNT }, (_, i) =>
    `<button type="button" class="objective-example" data-example="${i}" title="${escapeAttr(t('chat.guide.useExample'))}">`
    + `<span class="objective-example-text">${escapeAttr(objectiveExampleText(i))}</span></button>`).join('');
  return `<section class="objective-guide" id="${OBJECTIVE_GUIDE_ID}" aria-label="${escapeAttr(t('chat.guide.help'))}" hidden>`
    + `<h3 class="objective-guide-heading" id="objective-guide-next">${escapeAttr(t('chat.guide.nextTitle'))}</h3>`
    + `<ol class="objective-guide-steps" aria-labelledby="objective-guide-next">${steps}</ol>`
    + `<h3 class="objective-guide-heading" id="objective-guide-examples">${escapeAttr(t('chat.guide.examplesTitle'))}</h3>`
    + `<div class="objective-guide-examples" role="group" aria-labelledby="objective-guide-examples">${examples}</div>`
    + '</section>';
}

// ── The guide popover (TPT9405) ──
// Its state is the DOM: the popover's `hidden` and the (?) button's aria-expanded. A render draws
// it closed; refreshObjectiveContent() (chat-ui.js) carries an open one across a repaint through
// its view state (captureObjectiveGuide() / restoreObjectiveGuide()), so a task update or the
// provider list arriving does not close it under the user.
const GUIDE_SELECTOR = `#${OBJECTIVE_GUIDE_ID}`;
const HELP_SELECTOR = `#${OBJECTIVE_HELP_BUTTON_ID}`;

/** Whether the guide popover is open in `root` (the document, or a fragment holding a render). */
export function objectiveGuideOpen(root) {
  const guide = root?.querySelector?.(GUIDE_SELECTOR);
  return !!guide && !guide.hidden;
}

/**
 * Opens or closes the guide popover and keeps its button's aria-expanded in step. False when the
 * view has no guide: a chat with a turn, a split, a Discuss or a web-origin tab, New Task.
 */
export function setObjectiveGuideOpen(root, open) {
  const guide = root?.querySelector?.(GUIDE_SELECTOR);
  if (!guide) return false;
  guide.hidden = !open;
  root.querySelector(HELP_SELECTOR)?.setAttribute('aria-expanded', open ? 'true' : 'false');
  return true;
}

/**
 * An open popover, as a repaint should bring it back: which of its controls had keyboard focus —
 * `'button'` for the (?) button, an example's index, or null. Null while it is closed.
 */
export function captureObjectiveGuide(doc) {
  if (!objectiveGuideOpen(doc)) return null;
  const active = doc.activeElement;
  if (active?.id === OBJECTIVE_HELP_BUTTON_ID) return { focus: 'button' };
  const example = active?.closest?.(`${GUIDE_SELECTOR} .objective-example`);
  return { focus: example ? Number(example.dataset.example) : null };
}

/** Opens the repainted popover again and puts keyboard focus back where it was. */
export function restoreObjectiveGuide(doc, saved) {
  if (!saved || !setObjectiveGuideOpen(doc, true)) return false;
  const target = saved.focus === 'button'
    ? doc.querySelector(HELP_SELECTOR)
    : Number.isInteger(saved.focus)
      ? doc.querySelector(`${GUIDE_SELECTOR} .objective-example[data-example="${saved.focus}"]`)
      : null;
  target?.focus({ preventScroll: true });
  return true;
}

const dismissBound = new WeakSet();

/**
 * The popover's light dismiss, bound once per document: Escape closes it, and so do a press
 * anywhere but the popover and its button, and keyboard focus moving on past both. Each listener
 * looks the popover up when it fires, so one that a repaint replaced or the Create modal removed
 * leaves nothing behind. Returns whether this call bound them.
 */
export function bindObjectiveGuideDismiss(doc = typeof document === 'undefined' ? null : document) {
  const win = doc?.defaultView;
  if (!win || dismissBound.has(doc)) return false;
  dismissBound.add(doc);
  const inHelp = node => !!node?.closest?.(`${GUIDE_SELECTOR}, ${HELP_SELECTOR}`);
  // Window capture runs ahead of the Create modal's own Escape (objective-modal.js), which closes
  // the whole dialog: while the popover is open, Escape closes only the popover. Focus that was in
  // it, or nowhere, goes back to the (?) button.
  win.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !objectiveGuideOpen(doc)) return;
    event.preventDefault();
    event.stopPropagation();
    const active = doc.activeElement;
    const refocus = !active || active === doc.body || inHelp(active);
    setObjectiveGuideOpen(doc, false);
    if (refocus) doc.querySelector(HELP_SELECTOR)?.focus({ preventScroll: true });
  }, true);
  doc.addEventListener('pointerdown', (event) => {
    if (objectiveGuideOpen(doc) && !inHelp(event.target)) setObjectiveGuideOpen(doc, false);
  }, true);
  doc.addEventListener('focusout', (event) => {
    if (!objectiveGuideOpen(doc) || !inHelp(event.target)) return;
    if (event.relatedTarget && !inHelp(event.relatedTarget)) setObjectiveGuideOpen(doc, false);
  });
  return true;
}
