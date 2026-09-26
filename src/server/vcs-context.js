'use strict';

const { VCS_OFF, normalizeVcsSettings, buildVcsDirective } = require('./vcs-settings');
const { vcsRuntime } = require('./vcs-runtime');

async function readVcsContext(backend) {
  const runtime = vcsRuntime();
  const checkedAt = new Date().toISOString();
  try {
    const row = await backend.getProjectSettings({ refresh: true, strict: true });
    if (!row || ![null, 'git', 'svn'].includes(row.vcs_type)) throw new Error('Missing settings');
    for (const field of ['worktree', 'commit', 'pr', 'merge']) {
      if (![true, false, 0, 1].includes(row[`vcs_${field}_enabled`])) throw new Error('Missing VCS flags');
    }
    // Do not expose the rest of the project row or credentials in agent diagnostics.
    const projectId = row.id ?? backend.getCredentials?.().projectId ?? null;
    const expectedProjectId = backend.getCredentials?.().projectId;
    if (expectedProjectId != null && String(projectId) !== String(expectedProjectId)) throw new Error('Project mismatch');
    if (runtime.packaged && runtime.stale) throw new Error('Runtime replaced');
    return { verified: true, projectId, checkedAt, vcs: normalizeVcsSettings(row), runtime };
  } catch {
    return { verified: false, projectId: null, checkedAt, vcs: VCS_OFF, runtime,
      reason: runtime.stale && runtime.packaged ? 'runtime_replaced_restart_required' : 'settings_unavailable' };
  }
}

function buildVcsContextDirective(context) {
  return [
    `Effective VCS context: ${JSON.stringify(context)}`,
    context.verified ? buildVcsDirective(context.vcs)
      : 'VCS settings could not be verified. No VCS writes are authorized. Retry the live read; do not mark completed until verification succeeds.',
    'Before VCS writes, after resuming, and immediately before completion, call tipatask-local git_worktree_status with task_key. Require verified:true; current settings supersede the kickoff snapshot. A failed read is not merge disabled.',
    'Finish with tipatask-local complete_task(task_key, resolution): it verifies current settings and local merges before posting your plain-English resolution and completed status. Do not substitute remote update_task or PR creation for this check. Run relevant checks on the merged checkouts first and include their results in resolution.',
    'If these local tools are unavailable or runtime_replaced_restart_required is reported, restart using the updated Task App. For a settings-only read, GET /api/projects/{API_PROJECT_ID} using current .tipatask/config.json credentials without printing them; this does not replace the local completion check.',
  ].join('\n');
}

async function refreshSessionVcs(session, backend = session.backend) {
  const context = await readVcsContext(backend);
  session.vcsContext = context;
  return context;
}

module.exports = { readVcsContext, buildVcsContextDirective, refreshSessionVcs };
