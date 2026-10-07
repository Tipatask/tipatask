// (C1388) Pure decision logic for the unified "Open / Create Project" flow — no DOM, no
// IPC, so it's unit-testable in isolation (see project-open-flow.test.js). template.html's
// openOrCreateProject() does the actual IPC calls and feeds their results in here.
//
//   pick        — result of pickAndOpenProject(): null | { path, needsSetup: true } | { path, config }
//   alreadyOpen — true when a live window already owns pick.path (from focusProjectWindow())
//
// Returns one of:
//   { action: 'none' }               — user cancelled the picker
//   { action: 'focused' }            — an existing window was focused; caller does nothing else
//   { action: 'open-new' }           — configured project, no existing window: open it
//   { action: 'open-wizard' }         — unconfigured folder: open the project wizard directly
//                                      (TPT557 — its Create Project step covers both create-new
//                                      and link-existing, so there is no separate chooser)
export function decideOpenAction({ pick, alreadyOpen }) {
  if (!pick) return { action: 'none' };
  if (alreadyOpen) return { action: 'focused' };
  if (pick.needsSetup) return { action: 'open-wizard', path: pick.path };
  return { action: 'open-new', path: pick.path };
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
