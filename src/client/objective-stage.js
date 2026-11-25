// ── New Objective guidance: the stage line and the empty-state guide (TPT9391) ──
// Two pieces of the Create modal's Objective view that tell the user where a run stands and what
// to do next. chat-ui.js's renderObjectiveContent() renders both; this module owns their markup
// and the rule that picks the stage, and imports neither chat-ui.js nor chat-task-preview.js.
//
// Stage line (`#objective-stage`): four steps in a fixed order — planning, proposals ready,
// saving, saved — with the current one marked and one sentence under them saying what is
// happening. It is absent while a chat has nothing to report (no turn running, no proposals).
//
// Empty-state guide (`#objective-guide`): shown only for a plain new objective that has no turn
// yet — what happens after Send, in three steps, and example objectives that fill the composer.
import { t, tc } from './i18n.js';
import { escapeAttr } from './utils.js';

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

function stepState(step, stage) {
  const at = OBJECTIVE_STAGES.indexOf(stage);
  const idx = OBJECTIVE_STAGES.indexOf(step);
  if (idx < at) return 'done';
  // "Saved" is the end of the run, so its own step reads as finished rather than in progress.
  if (idx === at) return stage === 'saved' ? 'done' : 'current';
  return 'todo';
}

const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><polyline points="3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function stepInnerHtml(step, state, number) {
  const mark = state === 'done' ? CHECK_SVG : String(number);
  return `<span class="objective-stage-dot" aria-hidden="true">${mark}</span><span class="objective-stage-name">${escapeAttr(t(`chat.stage.${step}`))}</span>`;
}

/** The stage line's markup, or '' when there is no stage. */
export function renderObjectiveStageHtml(info) {
  if (!info) return '';
  const steps = OBJECTIVE_STAGES.map((step, i) => {
    const state = stepState(step, info.stage);
    return `<li class="objective-stage-step is-${state}" data-step="${step}" data-state="${state}"${step === info.stage ? ' aria-current="step"' : ''}>${stepInnerHtml(step, state, i + 1)}</li>`;
  }).join('');
  return `<div class="objective-stage" id="objective-stage" data-stage="${info.stage}">`
    + `<ol class="objective-stage-steps" aria-label="${escapeAttr(t('chat.stage.label'))}">${steps}</ol>`
    + `<p class="objective-stage-detail" role="status">${escapeAttr(objectiveStageDetail(info))}</p>`
    + '</div>';
}

/**
 * Bring a mounted stage line up to date without a repaint: the save paths change the stage
 * between renders. `slot` is `#objective-stage-slot`. A line that is already mounted is patched
 * in place, so its status sentence stays the same live region and the change is announced.
 */
export function syncObjectiveStageSlot(slot, info) {
  if (!slot) return false;
  const line = slot.querySelector('.objective-stage');
  if (!info) {
    if (line) slot.innerHTML = '';
    return true;
  }
  if (!line) {
    slot.innerHTML = renderObjectiveStageHtml(info);
    return true;
  }
  line.dataset.stage = info.stage;
  OBJECTIVE_STAGES.forEach((step, i) => {
    const el = line.querySelector(`[data-step="${step}"]`);
    if (!el) return;
    const state = stepState(step, info.stage);
    if (el.dataset.state !== state) {
      el.classList.remove('is-done', 'is-current', 'is-todo');
      el.classList.add(`is-${state}`);
      el.dataset.state = state;
      el.innerHTML = stepInnerHtml(step, state, i + 1);
    }
    if (step === info.stage) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
  });
  const detail = line.querySelector('.objective-stage-detail');
  const text = objectiveStageDetail(info);
  if (detail && detail.textContent !== text) detail.textContent = text;
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

/** The empty-state guide's markup. */
export function renderObjectiveGuideHtml() {
  const steps = [1, 2, 3].map(n =>
    `<li class="objective-guide-step"><span class="objective-guide-num" aria-hidden="true">${n}</span>`
    + `<span class="objective-guide-step-text"><strong>${escapeAttr(t(`chat.guide.step${n}Title`))}</strong>`
    + `<span>${escapeAttr(t(`chat.guide.step${n}`))}</span></span></li>`).join('');
  const examples = Array.from({ length: OBJECTIVE_EXAMPLE_COUNT }, (_, i) =>
    `<button type="button" class="objective-example" data-example="${i}" title="${escapeAttr(t('chat.guide.useExample'))}">`
    + `<span class="objective-example-text">${escapeAttr(objectiveExampleText(i))}</span></button>`).join('');
  return '<section class="objective-guide" id="objective-guide">'
    + `<h3 class="objective-guide-heading" id="objective-guide-next">${escapeAttr(t('chat.guide.nextTitle'))}</h3>`
    + `<ol class="objective-guide-steps" aria-labelledby="objective-guide-next">${steps}</ol>`
    + `<h3 class="objective-guide-heading" id="objective-guide-examples">${escapeAttr(t('chat.guide.examplesTitle'))}</h3>`
    + `<div class="objective-guide-examples" role="group" aria-labelledby="objective-guide-examples">${examples}</div>`
    + '</section>';
}
