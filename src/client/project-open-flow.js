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
//   { action: 'choose-setup-kind' }  — unconfigured folder: ask Connect-existing vs Create-new
export function decideOpenAction({ pick, alreadyOpen }) {
  if (!pick) return { action: 'none' };
  if (alreadyOpen) return { action: 'focused' };
  if (pick.needsSetup) return { action: 'choose-setup-kind', path: pick.path };
  return { action: 'open-new', path: pick.path };
}
