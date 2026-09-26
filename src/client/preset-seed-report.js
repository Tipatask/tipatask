// ── Preset starter-task seed report (TPT203) ──
//
// The project-creation wizard's IPC handler (`project:create-from-wizard`) returns
// `{ ok: true, projectPath, presetSeed }` where `presetSeed` is the outcome of seeding the
// preset's starter tasks: `{ seeded, failed }` from seedPresetTasks(), or
// `{ seeded: 0, failed: null, error }` when the seed call itself threw. The project is usable
// either way — only its starter tasks are not — so a partial seed must be reported, not treated
// as failure of the whole creation.
//
// Pure (no DOM, no i18n import — `t` is injected) so it is unit-testable under `node --test`.

// Returns `{ title, body }` to show the user, or null when every starter task seeded cleanly
// (or there was no seed outcome to report, e.g. an older main process).
export function buildPresetSeedReport(presetSeed, t) {
  if (!presetSeed || typeof presetSeed !== 'object') return null;
  const title = t('project.presetSeedFailedTitle');
  if (presetSeed.error) {
    return { title, body: t('project.presetSeedErrorBody', { msg: presetSeed.error }) };
  }
  const failed = Number(presetSeed.failed) || 0;
  if (failed <= 0) return null;
  const total = failed + (Number(presetSeed.seeded) || 0);
  return { title, body: t('project.presetSeedFailedBody', { failed, total }) };
}
