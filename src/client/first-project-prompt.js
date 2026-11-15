// (TPT9319) First-open prompt of a new project. project:create-from-wizard (main.js) marks a
// NEW project's .tipatask/project.json with `firstOpenPrompt: true` (main/first-open-prompt.js).
// Once this window's board has rendered, maybeShowFirstProjectPrompt() reads that marker over
// IPC, waits FIRST_PROMPT_DELAY_MS, clears it and shows a modal with three choices:
//   - New Objective      → the Create section's New Objective form (`openObjective`)
//   - Project Discussion → a new project chat, task-chat.js openProjectChat() (`openProjectChat`)
//   - Dismiss            → closes the modal (also Escape and a backdrop click)
// The modal opens only when the clear reports it removed the marker, so it appears on the
// project's first opening only — never after a reload, never in a second window. A window
// that is busy when the delay ends (it left the board, a terminal or another dialog is open,
// or a text field has the focus) still consumes the marker but shows nothing: the user has
// already moved on. Browser mode and linked existing projects have no marker: a no-op there.

import state from './state.js';
import { t } from './i18n.js';
import { activateDialogFocus, hasOpenDialog } from './dialog-focus.js';

export const FIRST_PROMPT_DELAY_MS = 2000;
export const FIRST_PROMPT_CHOICES = Object.freeze(['objective', 'discuss', 'dismiss']);

const OVERLAY_ID = 'first-project-prompt';
// The Project Board's view tabs (template.html isTasksSectionTab()).
const BOARD_TABS = new Set(['board', 'list', 'todo', 'backlog']);
// Surfaces that cover the board without a dialog-focus layer of their own.
const UNLAYERED_OVERLAYS = ['#project-choose-modal', '#project-rename-modal', '.spec-chat-modal'];

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const MARK_SVG = `<svg ${SVG_ATTRS}><path d="M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8L12 16.9l-1.8-4.9-4.9-1.8 4.9-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></svg>`;
const OBJECTIVE_SVG = `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>`;
// The left menu's Start Chat glyph (constants.js CHAT_BUBBLE_SVG), so the two read as one action.
const DISCUSS_SVG = `<svg ${SVG_ATTRS}><path d="M21 15a2 2 0 0 1-2 2H7.5L3 20.5V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
const ARROW_SVG = `<svg ${SVG_ATTRS}><polyline points="9 6 15 12 9 18"/></svg>`;

// Static structure only: every text node is set through textContent below.
const MARKUP = `
  <div class="first-prompt" role="dialog" aria-modal="true" aria-labelledby="first-prompt-title" aria-describedby="first-prompt-question">
    <div class="first-prompt-mark">${MARK_SVG}</div>
    <h2 class="first-prompt-title" id="first-prompt-title"></h2>
    <p class="first-prompt-question" id="first-prompt-question"></p>
    <div class="first-prompt-choices">
      <button type="button" class="first-prompt-choice first-prompt-choice--primary" data-choice="objective"
        aria-labelledby="first-prompt-objective-label" aria-describedby="first-prompt-objective-hint">
        <span class="first-prompt-choice-icon">${OBJECTIVE_SVG}</span>
        <span class="first-prompt-choice-text">
          <span class="first-prompt-choice-label" id="first-prompt-objective-label"></span>
          <span class="first-prompt-choice-hint" id="first-prompt-objective-hint"></span>
        </span>
        <span class="first-prompt-choice-arrow">${ARROW_SVG}</span>
      </button>
      <button type="button" class="first-prompt-choice" data-choice="discuss"
        aria-labelledby="first-prompt-discuss-label" aria-describedby="first-prompt-discuss-hint">
        <span class="first-prompt-choice-icon">${DISCUSS_SVG}</span>
        <span class="first-prompt-choice-text">
          <span class="first-prompt-choice-label" id="first-prompt-discuss-label"></span>
          <span class="first-prompt-choice-hint" id="first-prompt-discuss-hint"></span>
        </span>
        <span class="first-prompt-choice-arrow">${ARROW_SVG}</span>
      </button>
    </div>
    <div class="first-prompt-footer">
      <p class="first-prompt-note"></p>
      <button type="button" class="first-prompt-dismiss" data-choice="dismiss"></button>
    </div>
  </div>`;

let inFlight = null;  // the running check of this window, so overlapping renders share it
let checkedPath = ''; // the project whose marker this window already read

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isShown(el) {
  if (!el || el.hidden || el.style?.display === 'none') return false;
  try { return getComputedStyle(el).display !== 'none'; } catch { return true; }
}

// A text field has the keyboard focus (e.g. the board search, which typing on the board fills):
// a modal opening now would take the user's keystrokes.
function typingInField() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(el.type);
}

// Whether the window is doing something else: the prompt would interrupt it, so it is skipped.
export function firstPromptWindowBusy() {
  if (!BOARD_TABS.has(state.activeTab)) return true;
  if (state.activeTerminal) return true;
  if (hasOpenDialog()) return true;
  if (typingInField()) return true;
  return UNLAYERED_OVERLAYS.some((selector) => isShown(document.querySelector(selector)));
}

/**
 * Shows the modal and resolves with the choice: 'objective', 'discuss' or 'dismiss' (the
 * Dismiss button, Escape while it is the top dialog, or a click on the backdrop). It owns a
 * dialog-focus layer, so the board behind it is inert while it is open.
 */
export function showFirstProjectPrompt() {
  document.getElementById(OVERLAY_ID)?.remove();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'first-prompt-overlay';
    overlay.innerHTML = MARKUP;
    const text = (selector, value) => { overlay.querySelector(selector).textContent = value; };
    text('.first-prompt-title', t('firstPrompt.title'));
    text('.first-prompt-question', t('firstPrompt.question'));
    text('#first-prompt-objective-label', t('firstPrompt.objective'));
    text('#first-prompt-objective-hint', t('firstPrompt.objectiveHint'));
    text('#first-prompt-discuss-label', t('firstPrompt.discuss'));
    text('#first-prompt-discuss-hint', t('firstPrompt.discussHint'));
    text('.first-prompt-note', t('firstPrompt.note', { create: t('nav.create'), chat: t('nav.startChat') }));
    text('.first-prompt-dismiss', t('firstPrompt.dismiss'));
    document.body.appendChild(overlay);
    const focusHandle = activateDialogFocus({ root: overlay, initialFocus: '[data-choice="objective"]' });

    let done = false;
    const finish = (choice) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      focusHandle.close();
      resolve(choice);
    };
    function onKey(e) {
      if (e.key !== 'Escape' || !focusHandle.isTop()) return;
      e.preventDefault();
      e.stopPropagation();
      finish('dismiss');
    }
    overlay.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('[data-choice]');
      if (btn && overlay.contains(btn) && FIRST_PROMPT_CHOICES.includes(btn.dataset.choice)) {
        finish(btn.dataset.choice);
      } else if (e.target === overlay) {
        finish('dismiss');
      }
    });
    document.addEventListener('keydown', onKey, true);
  });
}

/**
 * Call after every board render; only the first one per project and window does any work.
 * Resolves with the choice made, or null when nothing was shown.
 *
 * opts.openObjective()   — opens the New Objective form (template.html openNewObjectiveForm())
 * opts.openProjectChat() — opens a new project chat (task-chat.js openProjectChat())
 * opts.api               — defaults to window.electronAPI (getProjectPath, getFirstOpenPrompt,
 *                          clearFirstOpenPrompt); opts.delayMs, opts.wait, opts.isBusy and
 *                          opts.show exist for the tests.
 */
export function maybeShowFirstProjectPrompt(opts = {}) {
  const api = opts.api ?? globalThis.window?.electronAPI;
  if (typeof api?.getFirstOpenPrompt !== 'function' || typeof api?.clearFirstOpenPrompt !== 'function') {
    return Promise.resolve(null);
  }
  const projectPath = api.getProjectPath?.() || '';
  if (!projectPath) return Promise.resolve(null);
  if (inFlight) return inFlight;
  if (checkedPath === projectPath) return Promise.resolve(null);
  inFlight = runFirstProjectPrompt(api, projectPath, opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function runFirstProjectPrompt(api, projectPath, {
  openObjective, openProjectChat, delayMs = FIRST_PROMPT_DELAY_MS, wait = sleep,
  isBusy = firstPromptWindowBusy, show = showFirstProjectPrompt,
}) {
  checkedPath = projectPath;
  let due = false;
  try { due = (await api.getFirstOpenPrompt()) === true; } catch { due = false; }
  if (!due) return null;
  await wait(delayMs);
  // The window switched to another project meanwhile: leave this marker for its own window,
  // and let the next render check the project now shown here.
  if ((api.getProjectPath?.() || '') !== projectPath) {
    checkedPath = '';
    return null;
  }
  let cleared = false;
  try { cleared = (await api.clearFirstOpenPrompt()) === true; } catch { cleared = false; }
  if (!cleared || isBusy()) return null;
  const choice = await show();
  try {
    if (choice === 'objective') await openObjective?.();
    else if (choice === 'discuss') await openProjectChat?.();
  } catch (err) {
    console.warn('[first-prompt] could not open the choice:', choice, err);
  }
  return choice;
}

// Test-only: forget what this window already checked.
export function _resetFirstProjectPromptForTests() {
  inFlight = null;
  checkedPath = '';
  document.getElementById(OVERLAY_ID)?.remove();
}
