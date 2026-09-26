// vcs-form.js — pure PATCH-body builder for the Task App Settings modal's Version
// Control tab (TPT62). Hand-mirrored twin of api/web/src/lib/vcs-form.js (C1214/C1344,
// see that file for the web app's copy of the same rule) — the Task App client bundle
// is a separate package and can't import across that boundary, same reason
// ws-handlers.js keeps its own TASK_GROUP_LABELS/COLOR_SCHEMES copies instead of
// importing the web app's. Field names/order must stay in lockstep with that module's
// VCS_GIT_FLAGS and with api/src/lib/vcs-settings.js's server-side VCS_GIT_FLAGS.
//
// vcs_type is NULL by default (VCS integration off). The four suboption flags are
// git-only (svn has none) and are dormant, not force-reset, when vcs_type moves away
// from 'git' — the API accepts a `false` flag unconditionally but rejects a `true` flag
// when the effective vcs_type isn't 'git'. Sending explicit `false` on a Disabled/SVN
// save would zero out stored choices the user may switch back to, so buildVcsPatchBody()
// omits the four fields entirely unless vcsType === 'git'.
//
// Unlike the web twin, labels/hints here are i18n keys (t() looks them up), not literal
// English strings — the Task App localizes this modal, the web app does not.

// value: '' | 'git' | 'svn' (radio value, '' -> Disabled/off, matches the DB's NULL state).
export const VCS_TYPES = [
  { value: '', labelKey: 'settings.vcs.typeDisabled' },
  { value: 'git', labelKey: 'settings.vcs.typeGit' },
  { value: 'svn', labelKey: 'settings.vcs.typeSvn' },
];

// `field` matches the DB column / PATCH body key 1:1 (see tt-api-projects.md § Version
// Control Settings, C1213). Adding a suboption is a one-line change here plus a
// matching migration/API change.
export const VCS_GIT_FLAGS = [
  { field: 'vcs_worktree_enabled', labelKey: 'settings.vcs.worktreeLabel', hintKey: 'settings.vcs.worktreeHint' },
  { field: 'vcs_commit_enabled', labelKey: 'settings.vcs.commitLabel', hintKey: 'settings.vcs.commitHint' },
  { field: 'vcs_pr_enabled', labelKey: 'settings.vcs.prLabel', hintKey: 'settings.vcs.prHint' },
  { field: 'vcs_merge_enabled', labelKey: 'settings.vcs.mergeLabel', hintKey: 'settings.vcs.mergeHint' },
];

// vcsType: '' | 'git' | 'svn'. flags: { [field]: boolean } keyed by VCS_GIT_FLAGS' field
// names — a missing key coerces to false, an unknown key is ignored (only VCS_GIT_FLAGS'
// own fields are ever read).
export function buildVcsPatchBody(vcsType, flags) {
  const body = { vcs_type: vcsType || null };
  if (vcsType === 'git') {
    VCS_GIT_FLAGS.forEach((f) => {
      body[f.field] = !!(flags && flags[f.field]);
    });
  }
  return body;
}
