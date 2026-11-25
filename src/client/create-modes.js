// ── Create modes (TPT9390) ──
// The two things the left menu's Create item makes, named and drawn in one place. The Create
// flyout's entries (create-flyout.js), the Create modal's heading (composer-header.js) and the
// modal's accessible name (objective-modal.js) all read this list, so a mode is called the same
// wherever it shows. `mode` is the state.activeTab value the Create modal renders for; the rest
// are i18n keys and inline SVG. Nothing here touches the DOM.
const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

export const CREATE_MODES = Object.freeze([
  Object.freeze({
    mode: 'objective',
    labelKey: 'nav.newObjective',
    hintKey: 'nav.objectiveSub',
    icon: `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
  }),
  Object.freeze({
    mode: 'new_task',
    labelKey: 'nav.newTask',
    hintKey: 'nav.taskSub',
    icon: `<svg ${ICON_ATTRS}><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  }),
]);

/** The descriptor for a Create tab id. Anything that is not 'new_task' is the Objective mode. */
export function createMode(mode) {
  return CREATE_MODES.find(entry => entry.mode === mode) || CREATE_MODES[0];
}
