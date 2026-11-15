// (C1388) Pure decision logic for the Open Project / Create Project flow — no DOM, no IPC,
// so it's unit-testable in isolation (see project-open-flow.test.js). template.html's
// openOrCreateProject(entry) does the actual IPC calls and feeds their results in here.
//
// (TPT9318) The flow has two entries — Project ▸ Open Project… and Project ▸ Create
// Project… (and Get Started's two matching buttons). Both pick a folder and treat a
// configured one the same way (focus its window, or open it); they differ only for an
// unconfigured folder, where the entry rides along with 'open-wizard': Open runs the
// project wizard with its Preset step locked to compose-as-you-go, Create offers A/B/C.
//
//   pick        — result of pickAndOpenProject(): null | { path, needsSetup: true } | { path, config }
//   alreadyOpen — true when a live window already owns pick.path (from focusProjectWindow())
//   entry       — OPEN_ENTRY | CREATE_ENTRY; anything else counts as CREATE_ENTRY (the
//                 wizard with the Preset step — the behavior from before the split)
//
// Returns one of:
//   { action: 'none' }                  — user cancelled the picker
//   { action: 'focused' }               — an existing window was focused; caller does nothing else
//   { action: 'open-new', path }        — configured project, no existing window: open it
//   { action: 'open-wizard', path, entry } — unconfigured folder: open the project wizard directly
//                                        (TPT557 — its Create Project step covers both create-new
//                                        and link-existing, so there is no separate chooser)
export const OPEN_ENTRY = 'open';
export const CREATE_ENTRY = 'create';

export function normalizeEntry(entry) {
  return entry === OPEN_ENTRY ? OPEN_ENTRY : CREATE_ENTRY;
}

export function decideOpenAction({ pick, alreadyOpen, entry }) {
  if (!pick) return { action: 'none' };
  if (alreadyOpen) return { action: 'focused' };
  if (pick.needsSetup) return { action: 'open-wizard', path: pick.path, entry: normalizeEntry(entry) };
  return { action: 'open-new', path: pick.path };
}

// (TPT9318) Whether the project wizard for this entry locks its Preset step to
// compose-as-you-go. Shared by index.js's create-project listener.
export function wizardPresetLocked(entry) {
  return normalizeEntry(entry) === OPEN_ENTRY;
}

// (TPT556) Unbound-window invariant — true when the window has no folder, or its config
// carries no API_PROJECT_ID (a folder whose config is unreadable/incomplete counts as unbound
// for re-auth and Get Started purposes). Shared by setup-modal.js openReauth() (forces the
// account-only mode) and template.html's _openAccountReauth() (reopens Get Started on close).
// Pure — no DOM, no IPC; the caller passes what api:project.config() / getProjectPath() gave it.
export function isUnboundWindow({ projectPath, config } = {}) {
  if (!projectPath) return true;
  const id = config && config.API_PROJECT_ID;
  return id == null || String(id).trim() === '';
}
